//! spec: world/packs/process-plant/reference-designs/ld-01/safety/source-and-primary-protection.md#at-power-flow-and-temperature-challenges
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! S3 IC-PROT C3-like joined-spine probe (NOT-EVIDENCE; C3 is not run as a
//! case and no line is judged): from KERN's S3 settled state, the supply of
//! one RCP (`LD01.P.A1`, the S1 gates' supply-loss rotor) is lost at a
//! declared non-frame time (C3's 10.37 s, 0.07 s off the frame), with the
//! whole S3 protection slice acquired: PZR pressure, SG A/B low level on the
//! collapsed-level proxy, loop A/B low flow on the cold-return FTs armed by
//! the P1–P3 current proxy (S3-D7), the unavailable causes and the
//! turbine-state report. Does the loss produce the acquired reactor trip,
//! when, and by which cause?
//!
//! The composition is `started_s3_composition()` (S2-D24r/S3-D16 classes)
//! with the S3 state's operator `y, y'`; KERN's ELEC slice, L1/phase modes
//! and the PZR AUTO control client are not composed (the network's own
//! `SupplyLoss` sets the rotor unsupported, shaft free). S2's trip
//! configuration (order 2, 0.33, dcj 0.1, 1e-4 s first step, 20 ms cap from
//! the start).
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water)
//! plus `LD01_S3_STATE`, `LD01_IC_SECTION`, `LD01_S3_LOSS_AFTER_S`,
//! `LD01_S3_SPAN_S` (after the loss) and `LD01_S3_IC_RECEIPT` (new path).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;
use leitbild_operating_water::unit::{
    clock::process_cpu_s,
    profile::{DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT},
    spine::{Started, started_s3_composition},
};

use leitbild_operating_plant::{
    ic::{acquisition::Quality, packet::Section},
    joined::block::Command,
};
use leitbild_operating_water::{
    frame::{COUNTER_NAMES, Change, Class, Client, Dense, Diagnostic, Driver, Frame, Setup},
    ic::{HOLDING_LOSS, ProtectionClient},
    ida::{Ida, Initial, KluOrdering, System},
    joined::{Integrated, JoinedSystem, Restart},
};
use serde_json::{Value, json};

const MAX_ORDER: usize = 2;
const WINDOW_MAX_STEP_S: f64 = 0.02;

fn env_f64(key: &str) -> f64 {
    std::env::var(key)
        .unwrap_or_else(|_| panic!("{key}"))
        .parse()
        .unwrap_or_else(|_| panic!("{key} is a number"))
}
fn sha256(path: &str) -> String {
    let out = std::process::Command::new("shasum")
        .args(["-a", "256", path])
        .output()
        .expect("shasum");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}
fn quality(q: Option<(u64, Quality)>) -> Value {
    match q {
        None => Value::Null,
        Some((k, Quality::Value(v))) => json!({"acquired_frame": k, "value": v}),
        Some((k, q)) => json!({"acquired_frame": k, "bound": format!("{q:?}")}),
    }
}

/// The protection with a per-frame record: every channel's delivered
/// evidence and the plant quantities at the frame's left limit.
struct Recording {
    inner: ProtectionClient,
    scratch: Vec<f64>,
    rows: Vec<Value>,
}
impl<S: JoinedSystem> Client<S> for Recording {
    fn name(&self) -> &str {
        "acquired protection (recorded)"
    }
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String> {
        <ProtectionClient as Client<S>>::advance(&mut self.inner, dense, from, to)
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        let changes = <ProtectionClient as Client<S>>::frame(&mut self.inner, k, t, dense)?;
        dense.derivative(t, 0, &mut self.scratch)?;
        let delivered: serde_json::Map<String, Value> = self
            .inner
            .protection
            .delivered()
            .into_iter()
            .filter(|(id, _)| {
                id.ends_with(".FT")
                    || id.ends_with("P1")
                    || id.ends_with("NR1")
                    || id.ends_with("PT1")
            })
            .map(|(id, q)| (id, quality(q)))
            .collect();
        self.rows.push(json!({"t_s": t, "plant": self.inner.values(&self.scratch)?,
            "delivered": delivered, "holding_loss_decided": changes.iter().map(|c| c.due_s).collect::<Vec<_>>()}));
        Ok(changes)
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Vec<Change<S>>, String> {
        <ProtectionClient as Client<S>>::command(&mut self.inner, t, command)
    }
    fn restarted(&mut self, t: f64, system: &S) -> Result<(), String> {
        <ProtectionClient as Client<S>>::restarted(&mut self.inner, t, system)
    }
}

#[test]
#[ignore = "NOT-EVIDENCE S3 IC-PROT C3-like probe: requires the joined packet, the S3 state, the ic section, the wiki, IF97 and stock IDA/KLU"]
fn s3_ic_prot_c3_rcp_supply_loss_through_acquired_protection() {
    let started = process_cpu_s();
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let section_path = std::env::var("LD01_IC_SECTION").expect("LD01_IC_SECTION");
    let receipt_path = std::env::var("LD01_S3_IC_RECEIPT").expect("LD01_S3_IC_RECEIPT");
    assert!(
        !std::path::Path::new(&receipt_path).exists(),
        "receipts are never overwritten"
    );
    let loss_after = env_f64("LD01_S3_LOSS_AFTER_S");
    let span = env_f64("LD01_S3_SPAN_S");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let section: Section = serde_json::from_slice(&std::fs::read(&section_path).expect("section"))
        .expect("ic section");
    let (packet_path, _) = common::packet_bytes();
    assert_eq!(
        state["packet"].as_str(),
        Some(packet_path.as_str()),
        "state of another packet"
    );
    let (
        Started {
            joined,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            y: reference,
            ..
        },
        derived,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    let preparation_cpu_s = process_cpu_s() - started;
    let vector = |k: &str| -> Vec<f64> {
        state[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let (mut y, mut yp) = (vector("y"), vector("yp"));
    let t0 = state["t_s"].as_f64().unwrap();
    assert_eq!(y.len(), joined.dimension());
    let lost = common::s1_gates()["supplyLoss"]["rotor"].as_u64().unwrap() as usize;
    let inner = ProtectionClient::new(&section, &joined, &y, &reference).expect("protection");
    let observed = inner.observed();
    let at_start = inner.values(&y).expect("values at the start");
    let mut protection = Recording {
        inner,
        scratch: vec![0.; y.len()],
        rows: Vec::new(),
    };
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let nonnegative = joined.network.nonnegative_stocks();
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).expect("integrable"),
        Initial {
            time: t0,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    assert_eq!(ida.system().klu_ordering(), KluOrdering::Amd);
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    ida.set_max_step(WINDOW_MAX_STEP_S).unwrap();
    let frame = Frame::new(section.frame_s).unwrap();
    let mut driver = Driver::new(frame, Diagnostic::Jump, process_cpu_s, t0).unwrap();
    let t_loss = t0 + loss_after;
    driver
        .command(t_loss, Command::SupplyLoss { rotor: lost })
        .unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let run_started = process_cpu_s();
    let until = t_loss + span;
    let outcome = {
        let mut clients: Vec<&mut dyn Client<Integrated<leitbild_operating_water::If97>>> =
            vec![&mut protection];
        driver
            .start(&mut clients, t0, &y, &yp)
            .and_then(|()| driver.run(&mut ida, t0, until, &mut y, &mut yp, &mut clients, &setup))
    };
    let run_cpu_s = process_cpu_s() - run_started;
    driver.close_segment(&ida, until).unwrap();
    let failure = outcome.as_ref().err().cloned();
    let p = &protection.inner.protection;
    let holding = driver
        .log
        .iter()
        .find(|e| {
            e["kinds"]
                .as_array()
                .is_some_and(|k| k.iter().any(|k| k == HOLDING_LOSS))
        })
        .cloned();
    let seat = driver
        .log
        .iter()
        .find(|e| {
            e["restart"]["transactions"]
                .to_string()
                .contains("\"seat\"")
        })
        .map(|e| e["t_s"].clone());
    let first = p
        .divisions
        .iter()
        .flat_map(|d| d.causes.iter())
        .min_by(|a, b| a.at_s.total_cmp(&b.at_s))
        .map(|c| json!({"function": c.function, "t_s": c.at_s, "after_loss_s": c.at_s - t_loss}));
    let divisions: Vec<Value> = p
        .divisions
        .iter()
        .map(|d| json!({"supply": d.supply, "powered": d.powered,
            "causes": d.causes.iter().map(|c| json!({"function": c.function, "t_s": c.at_s, "after_loss_s": c.at_s - t_loss})).collect::<Vec<_>>(),
            "trip": d.trip.as_ref().map(|c| json!({"function": c.function, "t_s": c.at_s})),
            "requests": d.requests}))
        .collect();
    let totals: serde_json::Map<String, Value> = COUNTER_NAMES
        .iter()
        .zip(driver.totals)
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let c = &ida.system().joined.counters;
    let receipt = json!({
        "kind": "S3 IC-PROT C3-like probe: one RCP supply loss through the whole acquired protection slice",
        "status": "NOT-EVIDENCE probe; C3 is not run as a case and no line is judged",
        "failure": failure,
        "provenance": common::spine_provenance(),
        "packet": {"path": packet_path, "sha256": sha256(&packet_path)},
        "start_state": {"path": state_path, "sha256": sha256(&state_path), "t_s": t0,
            "composition_here": "started_s3_composition (S2-D24r/S3-D16 classes) with the state's operator y, y'; ELEC slice, L1/phase modes and the PZR AUTO client not composed"},
        "ic_section": {"path": section_path, "sha256": sha256(&section_path)},
        "configuration": {"rotor_lost": lost, "consumer": "LD01.P.A1", "t_loss_s": t_loss, "loss_after_start_s": loss_after,
            "span_after_loss_s": span, "frame_s": frame.period_s(), "max_order": MAX_ORDER, "max_step_s": WINDOW_MAX_STEP_S,
            "newton_coefficient": NEWTON_COEFFICIENT, "delta_cj_lsetup": DELTA_CJ_LSETUP, "first_step_s": FIRST_STEP_S,
            "relative_tolerance": rtol},
        "observed": observed,
        "quantities_at_start": at_start,
        "answer": {
            "acquired_reactor_trip": holding.is_some(),
            "first_cause": first,
            "holding_loss_s": holding.as_ref().map(|h| h["t_s"].clone()),
            "holding_loss_after_loss_s": holding.as_ref().and_then(|h| h["t_s"].as_f64()).map(|t| t - t_loss),
            "rod_seat_group_s": seat,
            "rod_seat_group_after_loss_s": seat.as_ref().and_then(|t| t.as_f64()).map(|t| t - t_loss),
        },
        "protection_log": p.log,
        "divisions": divisions,
        "holding": {"lost_at_s": p.holding.lost_at, "closed_contacts": p.holding.closed_contacts()},
        "counts_by_class": driver.counts.json(),
        "instants": driver.log,
        "stock_totals": totals,
        "segments": driver.segments,
        "cpu": {"preparation_s": preparation_cpu_s, "run_s": run_cpu_s, "solver_s": driver.cpu.solver_s,
            "observation_s": driver.cpu.observation_s, "restart_s": driver.cpu.restart_s,
            "run_per_simulated_s": run_cpu_s / (until - t0),
            "joined_counters": {"residuals": c.residuals, "jacobians": c.jacobians,
                "jacobian_wall_s_per_call": c.jacobian_wall_s / c.jacobians.max(1) as f64,
                "residual_wall_s_per_call": c.residual_wall_s / c.residuals.max(1) as f64},
            "load_average_end": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n", "vm.loadavg"]).output().unwrap().stdout).trim().to_string()},
        "frames": protection.rows,
    });
    std::fs::write(
        &receipt_path,
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();
    eprintln!(
        "loss {t_loss} s; answer {}; R {}; run CPU {run_cpu_s:.2} s; failure {failure:?}",
        receipt["answer"],
        driver.counts.total(Class::R)
    );
    assert!(failure.is_none(), "{failure:?}");
}

/// The PZR LT pair's tap pressures from the coordinates alone
/// (`stratified::Cell::level_tap_pressures`) equal the evaluated column's
/// (`Network::pzr_taps`) bit for bit at the composition's start, and the
/// acquired LT quantity is that difference through the calibration, with the
/// compiled section's LT family (`ld01-pzr-level-channels`).
#[test]
#[ignore = "requires the joined packet, the ic section, the wiki, IF97 and stock IDA/KLU"]
fn the_lt_tap_pressures_from_coordinates_equal_the_evaluated_column() {
    use leitbild_operating_plant::network::stratified;
    let section_path = std::env::var("LD01_IC_SECTION").expect("LD01_IC_SECTION");
    let section: Section =
        serde_json::from_slice(&std::fs::read(&section_path).expect("section")).expect("section");
    assert!(
        section.families.iter().any(|f| f.id == "LD01.PZR.LT"),
        "the compiled section carries the LT family"
    );
    let (
        Started {
            mut joined, y, yp, ..
        },
        _,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    joined
        .evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation at the start");
    let taps = joined.network.pzr_taps().expect("taps");
    let evaluated = taps.level.expect("LT pair").difference_pa.value;
    let scales = joined.scales();
    let base = joined.network.pzr.base;
    let x: Vec<leitbild_operating_plant::thermal::Scalar> = (0..stratified::COORDINATES)
        .map(|i| {
            leitbild_operating_plant::thermal::Scalar::constant(y[base + i] * scales[base + i])
        })
        .collect();
    let (low, high) = joined
        .network
        .stratified()
        .level_tap_pressures(&stratified::Coordinates::from_slice(&x).unwrap())
        .unwrap()
        .expect("LT pair");
    assert_eq!(
        (low.value - high.value).to_bits(),
        evaluated.to_bits(),
        "{} vs {evaluated}",
        low.value - high.value
    );
    let client = ProtectionClient::new(&section, &joined, &y, &y).expect("protection with LT");
    let values = client.values(&y).unwrap();
    let observed = client.observed();
    let level = values
        .as_object()
        .unwrap()
        .iter()
        .find(|(k, _)| k.starts_with("PzrLevel"))
        .map(|(_, v)| v.as_f64().unwrap())
        .unwrap();
    let r = &observed["references"]["LD01.PZR.LT"];
    let (rl, rg, h) = (
        r["liquid_density_kg_m3"].as_f64().unwrap(),
        r["vapor_density_kg_m3"].as_f64().unwrap(),
        r["tap_span_m"].as_f64().unwrap(),
    );
    let g = leitbild_operating_plant::network::ports::G;
    let expected = (evaluated - rg * g * h) / ((rl - rg) * g);
    assert!(
        (level - expected).abs() <= 1e-12 * expected.abs(),
        "{level} vs {expected}"
    );
    println!(
        "{}",
        json!({"dp_pa": evaluated, "lt_indicated_m": level, "collapsed_level_m": taps.collapsed_level_m.value,
            "mixture_level_m": taps.mixture_level_m.value, "calibration": r})
    );
}

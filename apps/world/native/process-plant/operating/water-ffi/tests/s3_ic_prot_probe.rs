//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! S3 IC-PROT joined-spine probe (NOT-EVIDENCE; S3 is not declared and no
//! gate is judged): from a settled joined state, a declared operator turbine
//! trip T1 (`LD01.TG` TRIP, decision S3-D1.19) at a non-frame time, with the
//! reactor trip acquired instead of S2's declared 0.2 s boundary: the
//! turbine controls' retained trip is reported on the 0.1 s frame, each
//! powered division accepts the named cause from the delivered report, the
//! two-of-three permissive contacts open and `LD01.TRIP.HOLD` loses its
//! voltage at that frame instant, a class-R restart that releases the grips.
//! The PZR pressure functions run on PT1/2/3 acquired from the roof
//! pressure's dense output. The run uses the frame driver (stock
//! IDA_ONE_STEP, dense output, restarts by `discrete_restart`) under S2's
//! trip configuration (order 2, 0.33, dcj 0.1, 1e-4 s first step, the 20 ms
//! window cap from the start) and counts every discrete change by class.
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water)
//! plus `LD01_S3_STATE` (a settled state `{t_s, y, yp, packet}` of the
//! packet), `LD01_IC_SECTION` (the compiled `ic` section),
//! `LD01_S3_T1_AFTER_S` (T1's delay after the settled time),
//! `LD01_S3_SPAN_S` (the span after T1) and `LD01_S3_IC_RECEIPT` (a new
//! receipt path).
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{ic::packet::Section, joined::block::Command};
use leitbild_operating_water::{
    frame::{COUNTER_NAMES, Class, Client, Dense, Diagnostic, Driver, Frame, Setup},
    ic::{HOLDING_LOSS, ProtectionClient},
    ida::{Ida, Initial, KluOrdering, System},
    joined::{Integrated, Restart},
};
use serde_json::{Value, json};
use spine::{
    DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_s3_composition, z1,
};

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

/// Plant quantities at each frame's left limit, from the same dense output
/// (observation only): PZR roof pressure, SG pressures, rod travel range.
struct Recorder {
    roof: (usize, f64),
    sg: Vec<(String, usize, f64)>,
    rods: Vec<(usize, f64)>,
    scratch: Vec<f64>,
    every: u64,
    rows: Vec<Value>,
}
impl<S> Client<S> for Recorder {
    fn name(&self) -> &str {
        "recorder"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn frame(
        &mut self,
        k: u64,
        t: f64,
        dense: &dyn Dense,
    ) -> Result<Vec<leitbild_operating_water::frame::Change<S>>, String> {
        if k.is_multiple_of(self.every) {
            dense.derivative(t, 0, &mut self.scratch)?;
            let y = &self.scratch;
            let travel: Vec<f64> = self.rods.iter().map(|(i, s)| y[*i] * s).collect();
            self.rows.push(json!({"t_s": t, "pzr_roof_pa": y[self.roof.0] * self.roof.1,
                "sg_pressure_pa": self.sg.iter().map(|(l, i, s)| json!([l, y[*i] * s])).collect::<Vec<_>>(),
                "rod_travel_m": [travel.iter().cloned().fold(f64::INFINITY, f64::min),
                    travel.iter().cloned().fold(f64::NEG_INFINITY, f64::max)]}));
        }
        Ok(Vec::new())
    }
}

#[test]
#[ignore = "NOT-EVIDENCE S3 IC-PROT probe: requires the joined packet, a settled state, the ic section, the wiki, IF97 and stock IDA/KLU"]
fn s3_ic_prot_t1_turbine_trip_through_acquired_protection() {
    let started = z1::cpu_s();
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let section_path = std::env::var("LD01_IC_SECTION").expect("LD01_IC_SECTION");
    let receipt_path = std::env::var("LD01_S3_IC_RECEIPT").expect("LD01_S3_IC_RECEIPT");
    assert!(
        !std::path::Path::new(&receipt_path).exists(),
        "receipts are never overwritten"
    );
    let t1_after = env_f64("LD01_S3_T1_AFTER_S");
    let span = env_f64("LD01_S3_SPAN_S");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let section: Section = serde_json::from_slice(&std::fs::read(&section_path).expect("section"))
        .expect("ic section");
    let (packet_path, _) = spine::packet_bytes();
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
    ) = started_s3_composition();
    let preparation_cpu_s = z1::cpu_s() - started;
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
    // The protection, balanced at the settled state, and the recorder.
    let mut protection =
        ProtectionClient::new(&section, &joined, &y, &reference).expect("protection");
    let scales = joined.scales();
    let labels: Vec<String> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.labels)
        .collect();
    let o = joined.offsets();
    let clusters = joined.rods().expect("rod owner").clusters();
    let roof = joined.network.pzr.base + leitbild_operating_plant::network::PZR_PRESSURE;
    let mut recorder = Recorder {
        roof: (roof, scales[roof]),
        sg: labels
            .iter()
            .enumerate()
            .filter(|(_, l)| l.ends_with(".p_s"))
            .map(|(i, l)| (l.clone(), i, scales[i]))
            .collect(),
        rods: (0..clusters)
            .map(|c| {
                let b = o.rods + joined.rods().expect("rod owner").cluster_coordinate(c);
                (b, scales[b])
            })
            .collect(),
        scratch: vec![0.; y.len()],
        every: 1,
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
    let mut driver = Driver::new(frame, Diagnostic::Jump, z1::cpu_s, t0).unwrap();
    let t1 = t0 + t1_after;
    driver.command(t1, Command::TurbineTripAcquired).unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let run_started = z1::cpu_s();
    let until = t1 + span;
    let outcome = {
        let mut clients: Vec<&mut dyn Client<Integrated<leitbild_operating_water::If97>>> =
            vec![&mut protection, &mut recorder];
        driver
            .start(&mut clients, t0, &y, &yp)
            .and_then(|()| driver.run(&mut ida, t0, until, &mut y, &mut yp, &mut clients, &setup))
    };
    let run_cpu_s = z1::cpu_s() - run_started;
    driver.close_segment(&ida, until).unwrap();
    let failure = outcome.as_ref().err().cloned();
    // Timing: T1, the divisions' acceptance, the holding loss restart and
    // the grips released in it, the seat group.
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
    let p = &protection.protection;
    let divisions: Vec<Value> = p
        .divisions
        .iter()
        .map(|d| json!({"supply": d.supply, "powered": d.powered,
            "causes": d.causes.iter().map(|c| json!({"function": c.function, "t_s": c.at_s, "after_t1_s": c.at_s - t1})).collect::<Vec<_>>(),
            "trip": d.trip.as_ref().map(|c| json!({"function": c.function, "t_s": c.at_s})),
            "requests": d.requests}))
        .collect();
    let totals: serde_json::Map<String, Value> = COUNTER_NAMES
        .iter()
        .zip(driver.totals)
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let restarts_r = driver.counts.total(Class::R);
    let c = &ida.system().joined.counters;
    let digest = |v: &[f64]| {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for x in v {
            for b in x.to_bits().to_le_bytes() {
                h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
            }
        }
        format!("{h:016x}")
    };
    let receipt = json!({
        "kind": "S3 IC-PROT T1 probe: operator turbine trip through acquired protection",
        "status": "NOT-EVIDENCE probe; S3 is not declared and no gate is judged",
        "failure": failure,
        "provenance": spine::provenance(),
        "packet": {"path": packet_path, "sha256": sha256(&packet_path)},
        "settled_state": {"path": state_path, "sha256": sha256(&state_path), "t_s": t0},
        "ic_section": {"path": section_path, "sha256": sha256(&section_path)},
        "configuration": {"t1_s": t1, "t1_after_settled_s": t1_after, "span_after_t1_s": span,
            "frame_s": frame.period_s(), "max_order": MAX_ORDER, "max_step_s": WINDOW_MAX_STEP_S,
            "max_step_note": "S2's 20 ms window cap, set from the settled time (options are refused mid-segment)",
            "newton_coefficient": NEWTON_COEFFICIENT, "delta_cj_lsetup": DELTA_CJ_LSETUP, "first_step_s": FIRST_STEP_S,
            "start_passes": 2, "transaction_passes": 12, "relative_tolerance": rtol,
            "tolerance_class": "the composition's with the derived classes (S2-D24) applied at the composed state",
            "derived_tolerances": derived,
            "integration": "frame driver: stock IDA_ONE_STEP, observation from IDAGetDky, restarts by discrete_restart",
            "classifier": "S3-D4 rule (frame.rs storage_rate_only); the jump is a reported diagnostic"},
        "observed": protection.observed(),
        "timing": {
            "t1_s": t1,
            "holding_loss_s": holding.as_ref().map(|h| h["t_s"].clone()),
            "holding_loss_after_t1_s": holding.as_ref().and_then(|h| h["t_s"].as_f64()).map(|t| t - t1),
            "s2_declared_opening_after_trip_s": 0.2,
            "rod_seat_group_s": seat,
            "rod_seat_group_after_t1_s": seat.as_ref().and_then(|t| t.as_f64()).map(|t| t - t1),
        },
        "protection_log": p.log,
        "divisions": divisions,
        "holding": {"lost_at_s": p.holding.lost_at, "closed_contacts": p.holding.closed_contacts(),
            "rearmed": p.holding.rearmed},
        "counts_by_class": driver.counts.json(),
        "restart_instants": restarts_r,
        "instants": driver.log,
        "stock_totals": totals,
        "segments": driver.segments,
        "cpu": {"preparation_s": preparation_cpu_s, "run_s": run_cpu_s, "solver_s": driver.cpu.solver_s,
            "observation_s": driver.cpu.observation_s, "restart_s": driver.cpu.restart_s,
            "held_s": driver.cpu.held_s,
            "attributed_fraction": (driver.cpu.solver_s + driver.cpu.observation_s + driver.cpu.restart_s + driver.cpu.held_s) / run_cpu_s,
            "run_per_simulated_s": run_cpu_s / (until - t0),
            "joined_counters": {"residuals": c.residuals, "residual_wall_s": c.residual_wall_s,
                "coupled_wall_s": c.coupled_wall_s, "jacobians": c.jacobians, "jacobian_wall_s": c.jacobian_wall_s,
                "jacobian_wall_s_per_call": c.jacobian_wall_s / c.jacobians.max(1) as f64,
                "residual_wall_s_per_call": c.residual_wall_s / c.residuals.max(1) as f64,
                "roots": c.roots, "root_wall_s": c.root_wall_s},
            "load_average_end": String::from_utf8_lossy(&std::process::Command::new("sysctl").args(["-n", "vm.loadavg"]).output().unwrap().stdout).trim().to_string()},
        "final_state": {"t_s": until, "y_digest": digest(&y), "yp_digest": digest(&yp),
            "digest_of": "FNV-1a over the bits of every coordinate, in order"},
        "frames": recorder.rows,
    });
    std::fs::write(
        &receipt_path,
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();
    eprintln!(
        "T1 {t1} s; holding loss {:?}; seat {:?}; R {restarts_r}; counts {}; run CPU {run_cpu_s:.2} s; failure {failure:?}",
        receipt["timing"]["holding_loss_s"],
        receipt["timing"]["rod_seat_group_s"],
        driver.counts.json()
    );
    assert!(failure.is_none(), "{failure:?}");
}

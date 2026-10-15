//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-a3-pilot
//! The S3 case harness for C1–C3 (GATE lane): the pinned
//! `ld01-s3-cases-c1c3` block read as data, each case driven on IC-PROT's
//! frame driver (0.1 s frame, stock IDA_ONE_STEP, dense-output
//! observation, classes R/S/O/C counted by kind) with the acquired
//! protection, from a settled joined state, and every declared sequence
//! line judged on the run's own event logs.
//!
//! - Unit tests: the block's pin and TBD state, the case refusals, the
//!   timeline and every line judge on synthetic logs.
//! - `s3_case_run` (ignored): one case (`LD01_S3_CASE` = C1 | C2 | C3). It
//!   refuses as evidence while the block is not pinned, a value of the case
//!   is open, or the model lacks a prerequisite the case needs; with
//!   `LD01_S3_PREVIEW=1` it runs anyway as a NOT-EVIDENCE preview with each
//!   refusal recorded as a deviation (`LD01_S3_PREVIEW_SPAN_S` may shorten
//!   it). C3 never runs: its prerequisites are not in the model.
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water),
//! `LD01_S3_DECLARATION` / `LD01_S3_DECISION_LOG` (the page holding the
//! block and its decision log), `LD01_S3_STATE` (a settled state of the
//! packet), `LD01_IC_SECTION` (the compiled `ic` section) and
//! `LD01_S3_CASE_RECEIPT` (a new receipt path).
#![cfg(all(feature = "ida", target_os = "macos"))]
#[allow(dead_code)] // The S2 harness's declaration readers; S3 uses a subset.
#[path = "s2_harness/gates.rs"]
mod gates;
#[allow(dead_code)] // The S2 harness's declaration readers; S3 uses a subset.
#[path = "s2_harness/guards.rs"]
mod guards;
#[path = "common/provenance.rs"]
mod provenance;
mod s3_harness;
#[path = "joined_spine.rs"]
mod spine;

use gates::Block;
use s3_harness::{
    declaration::{self, Case},
    lines,
    timeline::{Timeline, relief_sg},
};
use serde_json::{Value, json};

const C1C3_R3_2: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c1c3-r3.2.json");

fn block() -> Block {
    Block::from_json(declaration::FENCE, C1C3_R3_2).unwrap()
}

#[test]
fn the_published_block_pins_and_its_open_values_refuse_their_cases() {
    let b = block();
    // RP1-pin-s3-c1c3-r3.2's declared sha256.
    assert_eq!(
        guards::declared_sha256(&b).unwrap(),
        "8b1f795e9bfefc5d344ab8b3dd95b169d3459c78ad0132197950fcd741af093e"
    );
    let log = "| RP1-pin-s3-c1c3-r3.2 | 15 Oct | `ld01-s3-cases-c1c3` frozen; sha256 8b1f795e9bfefc5d344ab8b3dd95b169d3459c78ad0132197950fcd741af093e |\n";
    let pin = guards::pin_of(&b, Some(log), "log").unwrap();
    assert_eq!(pin["pinned"], json!(true), "{pin}");
    // The S2 gates' pin never reads the S3 row, nor the reverse.
    assert_eq!(guards::frozen_sha256(log).unwrap(), None);
    let tbd = guards::tbd_state(&b, Some(log)).unwrap();
    // C1 has no open value: only its model prerequisites refuse it.
    let c1 = declaration::case_refusals(Case::C1, &pin, &tbd);
    assert!(
        c1.iter()
            .all(|r| r.starts_with("not executable as declared")),
        "{c1:?}"
    );
    // C2's three probe values (P-2b, P-2c, P-5b) are open.
    let c2 = declaration::case_refusals(Case::C2, &pin, &tbd);
    assert_eq!(
        c2.iter().filter(|r| r.starts_with("TBD(")).count(),
        3,
        "{c2:?}"
    );
    // C3's four.
    let c3 = declaration::case_refusals(Case::C3, &pin, &tbd);
    assert_eq!(
        c3.iter().filter(|r| r.starts_with("TBD(")).count(),
        4,
        "{c3:?}"
    );
    // Unpinned: every case refuses on the pin.
    let unpinned = guards::pin_of(&b, Some(""), "log").unwrap();
    assert!(declaration::case_refusals(Case::C1, &unpinned, &tbd)[0].contains("not pinned"));
}

/// A synthetic C2 run in the shape of IC-PROT's T1 probe and S2-15 run 3:
/// the trip at t0 = 500 s, the cause accepted at +0.15 s in I1–I3 with the
/// holding loss there and a PRHR request, the STOP ramp end at +0.30 s,
/// every seat by +2.38 s, both SGs' reliefs cracking at +1.66 s.
fn c2_logs(clusters: usize) -> (Vec<Value>, Vec<Value>) {
    let t0 = 500.;
    let mut log = vec![
        json!({"t_s": t0, "class": "R", "kinds": ["command TurbineTripAcquired"], "restart": {"transactions": []}}),
        json!({"t_s": t0 + 0.15, "class": "R", "kinds": ["LD01.TRIP.HOLD loss"], "restart": {"transactions": []}}),
        json!({"t_s": t0 + 0.3, "class": "R", "kinds": ["owner time event"],
            "restart": {"transactions": [{"owner": "secondary", "t_s": t0 + 0.3, "event": "STOP ramp end"}]}}),
        json!({"t_s": t0 + 1.66, "class": "R", "kinds": ["located roots"],
            "restart": {"transactions": [{"owner": "secondary", "t_s": t0 + 1.66, "relief": [
                {"valve": "SG.A.RELIEF.1", "threshold": "Crack", "direction": 1},
                {"valve": "SG.B.RELIEF.1", "threshold": "Crack", "direction": 1}]}]}}),
    ];
    let seats: Vec<Value> = (0..clusters)
        .map(|c| json!({"cluster": format!("LD01.CR.{c:03}"), "event": "seat", "t_s": t0 + 2.38}))
        .collect();
    log.push(
        json!({"t_s": t0 + 2.38, "class": "R", "kinds": ["located roots"],
        "restart": {"transactions": [{"rods": seats}]}}),
    );
    let division = json!({"powered": true,
        "causes": [{"function": "LD01.PROT.TG.TRIP", "t_s": t0 + 0.15}],
        "trip": {"function": "LD01.PROT.TG.TRIP", "t_s": t0 + 0.15},
        "requests": [{"by": "LD01.PROT.TG.TRIP", "request": "PRHR", "t_s": t0 + 0.15}]});
    (log, vec![division.clone(), division.clone(), division])
}

fn implemented() -> Vec<String> {
    [
        "LD01.PROT.TG.TRIP",
        "LD01.PROT.PZR.HIGH_PRESSURE",
        "LD01.PROT.PZR.LOW_PRESSURE",
        "LD01.PROT.PZR.PRESSURE.UNAVAILABLE",
        "LD01.PROT.SG.A.LOW",
        "LD01.PROT.SG.B.LOW",
        "LD01.PROT.SG.A.UNAVAILABLE",
        "LD01.PROT.SG.B.UNAVAILABLE",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn c2s_lines_are_judged_on_the_runs_own_events_with_windows_from_the_block() {
    let (log, divisions) = c2_logs(52);
    let tl = Timeline::from_logs(&log, &divisions, Some(500.15), 500., 560.).unwrap();
    assert_eq!(tl.seats.len(), 52);
    assert_eq!(relief_sg("SG.B.RELIEF.2"), Some("B"));
    let b = block();
    let judged = lines::judge(
        Case::C2,
        &b.whole("/cases/C2/lines"),
        &tl,
        &implemented(),
        52,
    );
    let v = |id: &str| {
        judged
            .iter()
            .find(|l| l["id"] == id)
            .map(|l| l["verdict"].as_str().unwrap().to_string())
            .unwrap()
    };
    assert_eq!(v("C2.O1"), "pass");
    assert_eq!(v("C2.O4"), "pass");
    assert_eq!(v("C2.O5"), "pass");
    assert_eq!(v("C2.N1"), "pass");
    assert_eq!(v("C2.N2"), "pass");
    assert_eq!(v("C2.M1"), "recorded");
    // What the model does not offer can never pass.
    assert_eq!(v("C2.O2"), "not executable", "the generator breaker");
    assert_eq!(v("C2.O3"), "not executable");
    assert_eq!(v("C2.N3"), "not executable");
    assert_eq!(v("C2.N4"), "not executable", "low flow is not acquired");
    assert_eq!(v("C2.N5"), "not executable");
    assert!(!lines::all_pass(&judged));
    // Every declared line has a verdict, none "not implemented".
    assert_eq!(judged.len(), 11);
    assert!(
        judged.iter().all(|l| l["verdict"] != "not implemented"),
        "{judged:?}"
    );
    // The cause outside its window fails O1; a missing seat fails O4; one
    // SG's relief missing fails O5; a low-pressure cause fails N2.
    let (mut log2, mut div2) = c2_logs(51);
    div2[1]["causes"][0]["t_s"] = json!(500.35);
    log2.retain(|e| e["t_s"] != json!(501.66));
    div2[2]["causes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"function": "LD01.PROT.PZR.LOW_PRESSURE", "t_s": 520.}));
    let tl2 = Timeline::from_logs(&log2, &div2, Some(500.15), 500., 560.).unwrap();
    let judged2 = lines::judge(
        Case::C2,
        &b.whole("/cases/C2/lines"),
        &tl2,
        &implemented(),
        52,
    );
    let v2 = |id: &str| {
        judged2
            .iter()
            .find(|l| l["id"] == id)
            .map(|l| l["verdict"].as_str().unwrap().to_string())
            .unwrap()
    };
    for id in ["C2.O1", "C2.O4", "C2.O5", "C2.N2"] {
        assert_eq!(v2(id), "fail", "{id}");
    }
}

#[test]
fn c1s_must_not_lines_fail_on_any_listed_cause_and_never_pass_unacquired_ones() {
    let b = block();
    let quiet = Timeline::from_logs(&[], &[json!({"powered": true})], None, 0., 600.).unwrap();
    let judged = lines::judge(
        Case::C1,
        &b.whole("/cases/C1/lines"),
        &quiet,
        &implemented(),
        52,
    );
    let v = |j: &[Value], id: &str| {
        j.iter()
            .find(|l| l["id"] == id)
            .map(|l| l["verdict"].as_str().unwrap().to_string())
            .unwrap()
    };
    for id in ["C1.N1", "C1.N2", "C1.N3", "C1.N4"] {
        assert_eq!(v(&judged, id), "pass", "{id}");
    }
    // N5 lists low-flow causes the protection does not acquire, and one
    // entry without a cause ID: not executable on a quiet run.
    assert_eq!(v(&judged, "C1.N5"), "not executable");
    // A PZR relief opening fails N3; a SG low cause fails N5.
    let opening = json!({"t_s": 100., "class": "R", "kinds": ["located roots"],
        "restart": {"transactions": [{"owner": "pzr", "t_s": 100.,
            "before": {"demand_open": false}, "after": {"demand_open": true}}]}});
    let low = json!({"powered": true, "causes": [{"function": "LD01.PROT.SG.A.LOW", "t_s": 200.}]});
    let noisy = Timeline::from_logs(&[opening], &[low], None, 0., 600.).unwrap();
    let judged = lines::judge(
        Case::C1,
        &b.whole("/cases/C1/lines"),
        &noisy,
        &implemented(),
        52,
    );
    assert_eq!(v(&judged, "C1.N3"), "fail");
    assert_eq!(v(&judged, "C1.N5"), "fail");
}

#[test]
fn c3_is_wired_but_gated_on_its_missing_prerequisites() {
    let b = block();
    let tl = Timeline::default();
    let judged = lines::judge(
        Case::C3,
        &b.whole("/cases/C3/lines"),
        &tl,
        &implemented(),
        52,
    );
    assert_eq!(judged.len(), 5);
    assert!(
        judged
            .iter()
            .filter(|l| l["kind"] != "may")
            .all(|l| l["verdict"] == "not executable"),
        "{judged:?}"
    );
    assert!(
        Case::C3
            .missing_prerequisites()
            .iter()
            .any(|m| m.contains("R3"))
    );
}

// ------------------------------------------------------------ the case run

/// The PZR roof pressure, SG pressures and rod travel range at each frame's
/// left limit, from the dense output (observation only).
struct Recorder {
    roof: (usize, f64),
    sg: Vec<(String, usize, f64)>,
    rods: Vec<(usize, f64)>,
    scratch: Vec<f64>,
    rows: Vec<Value>,
}
impl<S> leitbild_operating_water::frame::Client<S> for Recorder {
    fn name(&self) -> &str {
        "recorder"
    }
    fn advance(
        &mut self,
        _: &dyn leitbild_operating_water::frame::Dense,
        _: f64,
        _: f64,
    ) -> Result<(), String> {
        Ok(())
    }
    fn frame(
        &mut self,
        _: u64,
        t: f64,
        dense: &dyn leitbild_operating_water::frame::Dense,
    ) -> Result<Vec<leitbild_operating_water::frame::Change<S>>, String> {
        dense.derivative(t, 0, &mut self.scratch)?;
        let y = &self.scratch;
        let travel: Vec<f64> = self.rods.iter().map(|(i, s)| y[*i] * s).collect();
        self.rows.push(json!({"t_s": t, "pzr_roof_pa": y[self.roof.0] * self.roof.1,
            "sg_pressure_pa": self.sg.iter().map(|(l, i, s)| json!([l, y[*i] * s])).collect::<Vec<_>>(),
            "rod_travel_m": [travel.iter().copied().fold(f64::INFINITY, f64::min),
                travel.iter().copied().fold(f64::NEG_INFINITY, f64::max)]}));
        Ok(Vec::new())
    }
}

#[test]
#[ignore = "S3 case run: requires the joined packet, a settled state, the ic section, the S3 declaration, the wiki, IF97 and stock IDA/KLU"]
#[allow(clippy::too_many_lines)] // One case: refusals, composition, run, judgement, receipt.
fn s3_case_run() {
    use leitbild_operating_plant::{ic::packet::Section, joined::block::Command};
    use leitbild_operating_water::{
        If97,
        frame::{COUNTER_NAMES, Class, Client, Diagnostic, Driver, Frame, Setup},
        ic::ProtectionClient,
        ida::{Ida, Initial},
        joined::{Integrated, Restart},
    };
    use spine::{
        DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_s3_composition, z1,
    };
    let started = z1::cpu_s();
    let case = Case::parse(&std::env::var("LD01_S3_CASE").expect("LD01_S3_CASE")).unwrap();
    let preview = std::env::var("LD01_S3_PREVIEW").as_deref() == Ok("1");
    let receipt_path = std::env::var("LD01_S3_CASE_RECEIPT").expect("LD01_S3_CASE_RECEIPT");
    assert!(
        !std::path::Path::new(&receipt_path).exists(),
        "receipts are never overwritten"
    );
    let d = declaration::Declaration::load().unwrap_or_else(|e| panic!("{e}"));
    // A log the pin rule cannot read (e.g. an RP1 row naming two SHA-256
    // values) leaves the block unpinned: a refusal, recorded with its reason.
    let pin = d
        .pin()
        .unwrap_or_else(|e| json!({"pinned": false, "error": e, "declared_sha256": guards::declared_sha256(&d.block).ok()}));
    let tbd = d.tbd().unwrap();
    let mut refusals = declaration::case_refusals(case, &pin, &tbd);
    assert!(
        case != Case::C3,
        "C3 is gated on its prerequisites: {:?}",
        case.missing_prerequisites()
    );
    let section_path = std::env::var("LD01_IC_SECTION").expect("LD01_IC_SECTION");
    let section: Section = serde_json::from_slice(&std::fs::read(&section_path).expect("section"))
        .expect("ic section");
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let (packet_path, _) = spine::packet_bytes();
    assert_eq!(
        state["packet"].as_str(),
        Some(packet_path.as_str()),
        "state of another packet"
    );
    let spec = d.case(case);
    // C2's trip is declared at t = 0, not on a frame instant: the start
    // state's time must not be one (the acquisition then takes 0.20 s, not
    // the non-frame 0.15 s the line's probe set).
    let frame_s = section.frame_s;
    let t_start = state["t_s"].as_f64().expect("t_s");
    if case == Case::C2 && (t_start / frame_s - (t_start / frame_s).round()).abs() < 1e-9 {
        refusals.push(format!(
            "C2's trip at t = 0 is declared non-frame, but the start state's time {t_start} s is a frame instant"
        ));
    }
    assert!(
        preview || refusals.is_empty(),
        "the S3 case run refuses (LD01_S3_PREVIEW=1 runs a NOT-EVIDENCE preview): {refusals:#?}"
    );
    let declared_s = spec["duration_s"].as_f64().expect("duration_s");
    let span = match std::env::var("LD01_S3_PREVIEW_SPAN_S") {
        Ok(v) => {
            assert!(preview, "a shortened span is a preview");
            v.parse::<f64>().expect("LD01_S3_PREVIEW_SPAN_S")
        }
        Err(_) => declared_s,
    };
    let (
        Started {
            joined,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        },
        derived,
    ) = started_s3_composition();
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
    let mut protection = ProtectionClient::new(&section, &joined, &y).expect("protection");
    let implemented: Vec<String> = section.functions.iter().map(|f| f.id.clone()).collect();
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
            .map(|c| (o.rods + 3 * c, scales[o.rods + 3 * c]))
            .collect(),
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
    // S2's configuration: BDF order 2; the 20 ms window cap from the start
    // for a trip case (options are refused mid-segment).
    const MAX_ORDER: usize = 2;
    const WINDOW_MAX_STEP_S: f64 = 0.02;
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    let frame = Frame::new(section.frame_s).unwrap();
    let mut driver = Driver::new(frame, Diagnostic::Jump, z1::cpu_s, t0).unwrap();
    if case == Case::C2 {
        ida.set_max_step(WINDOW_MAX_STEP_S).unwrap();
        // C2: `LD01.TG` TRIP at the case's t = 0 (the settled time, not a
        // frame instant), the reactor trip acquired.
        driver.command(t0, Command::TurbineTripAcquired).unwrap();
    }
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let preparation_cpu_s = z1::cpu_s() - started;
    let run_started = z1::cpu_s();
    let until = t0 + span;
    let outcome = {
        let mut clients: Vec<&mut dyn Client<Integrated<If97>>> =
            vec![&mut protection, &mut recorder];
        driver
            .start(&mut clients, t0, &y, &yp)
            .and_then(|()| driver.run(&mut ida, t0, until, &mut y, &mut yp, &mut clients, &setup))
    };
    let run_cpu_s = z1::cpu_s() - run_started;
    driver.close_segment(&ida, until).unwrap();
    let failure = outcome.as_ref().err().cloned();
    let p = &protection.protection;
    let divisions: Vec<Value> = p
        .divisions
        .iter()
        .map(|dv| json!({"supply": dv.supply, "powered": dv.powered,
            "causes": dv.causes.iter().map(|c| json!({"function": c.function, "t_s": c.at_s})).collect::<Vec<_>>(),
            "trip": dv.trip.as_ref().map(|c| json!({"function": c.function, "t_s": c.at_s})),
            "requests": dv.requests}))
        .collect();
    // A failed run ends at its last recorded instant (the driver's log).
    let end = if failure.is_some() {
        driver
            .log
            .last()
            .and_then(|e| e["t_s"].as_f64())
            .unwrap_or(t0)
    } else {
        until
    };
    let tl = Timeline::from_logs(&driver.log, &divisions, p.holding.lost_at, t0, end).unwrap();
    let judged = lines::judge(case, &spec["lines"], &tl, &implemented, clusters);
    let totals: serde_json::Map<String, Value> = COUNTER_NAMES
        .iter()
        .zip(driver.totals)
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let evidence = refusals.is_empty() && !preview && failure.is_none();
    let status = if evidence {
        format!("{} run", case.key())
    } else {
        format!(
            "NOT EVIDENCE: {} preview ({} deviations recorded)",
            case.key(),
            refusals.len()
        )
    };
    let verdict = if failure.is_some() {
        "FAIL: the run failed".to_string()
    } else if lines::all_pass(&judged) {
        "lines PASS (other gates not yet implemented)".to_string()
    } else {
        "lines not all passing".to_string()
    };
    let receipt = json!({
        "kind": if evidence { "s3-case-run" } else { "s3-case-preview" },
        "case": case.key(), "status": status, "verdict": verdict, "failure": failure,
        "refusals_or_deviations": refusals,
        "declaration": {"block": d.block.receipt(), "pin": pin, "tbd": tbd},
        "provenance": spine::provenance(),
        "packet": {"path": packet_path, "sha256": provenance::sha256_file(&packet_path).ok()},
        "start_state": {"path": state_path, "sha256": provenance::sha256_file(&state_path).ok(), "t_s": t0},
        "ic_section": {"path": section_path, "sha256": provenance::sha256_file(&section_path).ok(),
            "implemented_causes": implemented},
        "configuration": {"declared_duration_s": declared_s, "span_s": span, "frame_s": frame.period_s(),
            "max_order": MAX_ORDER, "max_step_s": if case == Case::C2 { json!(WINDOW_MAX_STEP_S) } else { Value::Null },
            "derived_tolerances": derived, "relative_tolerance": rtol,
            "integration": "frame driver: stock IDA_ONE_STEP, observation from IDAGetDky, restarts by discrete_restart"},
        "lines": judged,
        "timeline": {"end_s": tl.end, "holding_lost_s": tl.holding_lost, "stop_ramp_end_s": tl.stop_ramp_end,
            "seats": tl.seats.len(), "last_seat_s": tl.seats.iter().map(|(_, t)| *t).fold(f64::NEG_INFINITY, f64::max),
            "sg_relief": tl.sg_relief.iter().map(|(v, th, d, t)| json!([v, th, d, t])).collect::<Vec<_>>(),
            "pzr_relief_openings": tl.pzr_relief_openings,
            "causes": tl.causes.iter().map(|c| json!([c.division, c.function, c.t])).collect::<Vec<_>>()},
        "gates_not_yet_implemented": ["D conservation (S2 identities and ledgers plus heater, spray, relief, turbine, generator and Grid receipts)",
            "E refinement (2.5 ms-capped reference and BDF2 at rtol/100 over the window; rtol/10 for the hold)",
            "F smoothness (derivative-jump detector)", "H repeatability", "K post-event spectra",
            "C1 drift, SS-1 and SS-2", "C2 directions (B)", "cost against the S3 and S2 budgets (counts and CPU are recorded)"],
        "protection_log": p.log, "divisions": divisions,
        "counts_by_class": driver.counts.json(), "stock_totals": totals, "segments": driver.segments,
        "instants": driver.log,
        "cpu": {"preparation_s": preparation_cpu_s, "run_s": run_cpu_s, "solver_s": driver.cpu.solver_s,
            "observation_s": driver.cpu.observation_s, "restart_s": driver.cpu.restart_s, "held_s": driver.cpu.held_s,
            "run_per_simulated_s": run_cpu_s / (end - t0).max(1e-9),
            "restarts_r": driver.counts.total(Class::R)},
        "frames": recorder.rows,
    });
    std::fs::write(
        &receipt_path,
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();
    eprintln!(
        "{}: {status}; {verdict}; R {}; run CPU {run_cpu_s:.2} s over {:.2} s; failure {failure:?}",
        case.key(),
        driver.counts.total(Class::R),
        end - t0
    );
    for l in &judged {
        eprintln!("  {} {}: {}", l["id"], l["kind"], l["verdict"]);
    }
}

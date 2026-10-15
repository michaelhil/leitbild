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
#[path = "common/pzr_control.rs"]
mod pzr_control;
mod s3_harness;
#[path = "common/s3_unit.rs"]
mod s3_unit;
#[path = "joined_spine.rs"]
mod spine;

use gates::Block;
use leitbild_operating_plant::joined::block::Command;
use s3_harness::{
    declaration::{self, Case},
    lines,
    timeline::{Timeline, relief_sg},
};
use serde_json::{Value, json};

/// The published block (wiki 272d83f), pinned by RP1-pin-s3-c1c3-r3.4.
const C1C3_R3_4: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c1c3-r3.4.json");

fn block() -> Block {
    Block::from_json(declaration::FENCE, C1C3_R3_4).unwrap()
}

#[test]
fn the_published_block_pins_and_its_open_values_refuse_their_cases() {
    let b = block();
    // RP1-pin-s3-c1c3-r3.4's declared sha256.
    assert_eq!(
        guards::declared_sha256(&b).unwrap(),
        "c1f629b00411a6e288e8d041c29c84d7c315f2274a392ed7fab57c2278815729"
    );
    let log = "| RP1-pin-s3-c1c3-r3.4 | 15 Oct | `ld01-s3-cases-c1c3` frozen; sha256 c1f629b00411a6e288e8d041c29c84d7c315f2274a392ed7fab57c2278815729 |\n";
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
            .any(|m| m.contains("loop-flow acquisition"))
    );
}

#[test]
fn c2s_electrical_lines_are_judged_on_the_slices_log() {
    let (log, divisions) = c2_logs(52);
    let b = block();
    let judge = |elog: &[(f64, String)]| {
        let tl = Timeline::from_logs(&log, &divisions, Some(500.15), 500., 560.)
            .unwrap()
            .with_electrical(elog, 500.);
        lines::judge(
            Case::C2,
            &b.whole("/cases/C2/lines"),
            &tl,
            &implemented(),
            52,
        )
        .into_iter()
        .map(|l| {
            (
                l["id"].as_str().unwrap().to_string(),
                l["verdict"].as_str().unwrap().to_string(),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>()
    };
    let good = vec![
        (500.3, "GCB Open".to_string()),
        (500.8, "AC.A transfer to Reserve complete".to_string()),
        (500.8, "AC.B transfer to Reserve complete".to_string()),
    ];
    let v = judge(&good);
    for id in ["C2.O2", "C2.O3", "C2.N5"] {
        assert_eq!(v[id], "pass", "{id}");
    }
    // A late transfer fails O3; a contactor dropout fails N5; a breaker
    // opening off its instant fails O2.
    let mut bad = good.clone();
    bad[1].0 = 501.;
    bad.push((
        501.2,
        "LD01.P.A1 contactor undervoltage dropout".to_string(),
    ));
    bad[0].0 = 500.35;
    let v = judge(&bad);
    for id in ["C2.O2", "C2.O3", "C2.N5"] {
        assert_eq!(v[id], "fail", "{id}");
    }
}

#[test]
fn each_case_takes_its_clock_and_command_from_the_block() {
    let b = block();
    let clock = |c: Case| {
        let (z, cmd) = case_clock(c, &b.whole(&format!("/cases/{}", c.key())), 0.1).unwrap();
        (z, cmd.map(|x| format!("{x:?}")))
    };
    assert_eq!(clock(Case::C1), (0., None));
    // C2's trip 0.05 s after the frame-aligned start: mid-frame.
    assert_eq!(clock(Case::C2), (0.05, Some("TurbineTripAcquired".into())));
    // C3: LD01.P.A1, the slice's first RCP, at 10.37 s (0.07 s off).
    assert_eq!(
        clock(Case::C3),
        (10.37, Some("SupplyLoss { rotor: 0 }".into()))
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

/// A case's t = 0 after its start (s) and the command there, from the
/// block's frame alignment (r3.4: every case starts on a frame instant;
/// event times relative to the start with their offset from the grid). C1:
/// the start, no command. C2: `LD01.TG` TRIP `tripOffsetFromFrame_s` after
/// the start. C3: the RCP the block names loses its supply at
/// `malfunctionTime_s`, which must lie `malfunctionOffsetFromFrame_s` off
/// the grid.
fn case_clock(case: Case, spec: &Value, frame_s: f64) -> Result<(f64, Option<Command>), String> {
    use s3_unit::ROTOR_CONSUMERS;
    let number = |k: &str| spec[k].as_f64().ok_or(format!("{} has no {k}", case.key()));
    match case {
        Case::C1 => {
            if spec["startOnFrame"] != json!(true) {
                return Err("C1 does not declare startOnFrame".into());
            }
            Ok((0., None))
        }
        Case::C2 => {
            if spec["lineTimesFrom"] != json!("the trip") {
                return Err(format!(
                    "C2's line times are from {}, not the trip",
                    spec["lineTimesFrom"]
                ));
            }
            let at = number("tripOffsetFromFrame_s")?;
            if !(at > 0. && at < frame_s) {
                return Err(format!("C2's trip offset {at} s is not inside a frame"));
            }
            Ok((at, Some(Command::TurbineTripAcquired)))
        }
        Case::C3 => {
            let at = number("malfunctionTime_s")?;
            let off = number("malfunctionOffsetFromFrame_s")?;
            if ((at / frame_s - (at / frame_s).floor()) * frame_s - off).abs() > 1e-9 {
                return Err(format!(
                    "C3's malfunction at {at} s is not {off} s off the {frame_s} s grid"
                ));
            }
            let text = spec["malfunction"]
                .as_str()
                .ok_or("C3 has no malfunction")?;
            let named: Vec<usize> = (0..ROTOR_CONSUMERS.len())
                .filter(|r| text.contains(ROTOR_CONSUMERS[*r]))
                .collect();
            match named.as_slice() {
                [rotor] if text.starts_with("supply loss") => {
                    Ok((at, Some(Command::SupplyLoss { rotor: *rotor })))
                }
                _ => Err(format!(
                    "C3's malfunction {text:?} names no single RCP supply loss"
                )),
            }
        }
    }
}

#[test]
#[ignore = "S3 case run: requires the S3 packets, KERN's settled S3 state, the sections, the S3 declaration, the wiki, IF97 and stock IDA/KLU"]
#[allow(clippy::too_many_lines)] // One case: refusals, composition, run, judgement, receipt.
fn s3_case_run() {
    use leitbild_operating_water::{
        frame::{COUNTER_NAMES, Class, Client, Diagnostic, Driver, Setup},
        ic::ProtectionClient,
        joined::JoinedSystem,
    };
    use s3_unit::Unit;
    let started = spine::z1::cpu_s();
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
    let pin = d.pin().unwrap_or_else(
        |e| json!({"pinned": false, "error": e, "declared_sha256": guards::declared_sha256(&d.block).ok()}),
    );
    let tbd = d.tbd().unwrap();
    let refusals = declaration::case_refusals(case, &pin, &tbd);
    assert!(
        preview || refusals.is_empty(),
        "the S3 case run refuses (LD01_S3_PREVIEW=1 runs a NOT-EVIDENCE preview): {refusals:#?}"
    );
    let spec = d.case(case);
    let declared_s = spec["duration_s"].as_f64().expect("duration_s");
    let span = match std::env::var("LD01_S3_PREVIEW_SPAN_S") {
        Ok(v) => {
            assert!(preview, "a shortened span is a preview");
            v.parse::<f64>().expect("LD01_S3_PREVIEW_SPAN_S")
        }
        Err(_) => declared_s,
    };
    // The full S3 composition (S3-D28) at KERN's settled S3 state.
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let inputs = s3_unit::Inputs::from_env();
    let section = inputs.ic.clone();
    let s3_unit::S3Unit {
        mut ida,
        t0,
        mut y,
        mut yp,
        n,
        network_ids,
        atol,
        rtol,
        derived,
        restart,
        mut control,
        frame,
        receipt: composition,
    } = s3_unit::compose(&inputs, &state).unwrap_or_else(|e| panic!("{e}"));
    let declared_frame_s = d.block.number("/frameAlignment/frame_s");
    d.block.text("/frameAlignment/rule");
    assert_eq!(
        declared_frame_s,
        frame.period_s(),
        "the block's frame is the I&C frame"
    );
    let (zero_after, command) = case_clock(case, &spec, declared_frame_s).unwrap();
    let zero = t0 + zero_after;
    let joined = &ida.system().integrated().joined;
    let mut protection = ProtectionClient::new(&section, joined, &y[..n]).expect("protection");
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
    // S2's 20 ms event-window cap for an event case, from the start
    // (options are refused mid-segment).
    const WINDOW_MAX_STEP_S: f64 = 0.02;
    let max_step = command.is_some().then_some(WINDOW_MAX_STEP_S);
    if let Some(h) = max_step {
        ida.set_max_step(h).unwrap();
    }
    let mut driver = Driver::new(frame, Diagnostic::Jump, spine::z1::cpu_s, t0).unwrap();
    if let Some(c) = command {
        driver.command(zero, c).unwrap();
    }
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let preparation_cpu_s = spine::z1::cpu_s() - started;
    let run_started = spine::z1::cpu_s();
    let until = zero + span;
    let outcome = {
        let mut clients: Vec<&mut dyn Client<Unit>> =
            vec![&mut protection, &mut recorder, &mut control];
        driver
            .start(&mut clients, t0, &y, &yp)
            .and_then(|()| driver.run(&mut ida, t0, until, &mut y, &mut yp, &mut clients, &setup))
    };
    let run_cpu_s = spine::z1::cpu_s() - run_started;
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
    let electrical_log = ida.system().log.clone();
    let tl = Timeline::from_logs(&driver.log, &divisions, p.holding.lost_at, zero, end)
        .unwrap()
        .with_electrical(&electrical_log, zero);
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
    let simulated = end - t0;
    let receipt = json!({
        "kind": if evidence { "s3-case-run" } else { "s3-case-preview" },
        "case": case.key(), "status": status, "verdict": verdict, "failure": failure,
        "refusals_or_deviations": refusals,
        "declaration": {"block": d.block.receipt(), "pin": pin, "tbd": tbd},
        "provenance": spine::provenance(),
        "packet": state["packet"], "packet_sha256": state["packet_sha256"],
        "start_state": {"path": state_path, "sha256": provenance::sha256_file(&state_path).ok(), "t_s": t0},
        "composition": composition,
        "ic_section": {"path": inputs.ic_path, "implemented_causes": implemented},
        "configuration": {"declared_duration_s": declared_s, "span_after_zero_s": span, "zero_after_start_s": zero_after,
            "command": command.map(|c| format!("{c:?}")), "frame_s": frame.period_s(),
            "max_order": s3_unit::MAX_ORDER, "max_step_s": max_step,
            "derived_tolerances": derived, "relative_tolerance": rtol,
            "integration": "frame driver: stock IDA_ONE_STEP, observation from IDAGetDky, restarts by discrete_restart"},
        "lines": judged,
        "timeline": {"zero_s": zero, "end_s": tl.end, "holding_lost_s": tl.holding_lost, "stop_ramp_end_s": tl.stop_ramp_end,
            "seats": tl.seats.len(), "last_seat_s": tl.seats.iter().map(|(_, t)| *t).fold(f64::NEG_INFINITY, f64::max),
            "sg_relief": tl.sg_relief.iter().map(|(v, th, d, t)| json!([v, th, d, t])).collect::<Vec<_>>(),
            "pzr_relief_openings": tl.pzr_relief_openings,
            "causes": tl.causes.iter().map(|c| json!([c.division, c.function, c.t])).collect::<Vec<_>>(),
            "electrical": tl.electrical.as_ref().map(|l| l.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>())},
        "pzr_control": {"changes": control.schedule.len().saturating_sub(1), "final_request_w": control.in_force_w},
        "gates_not_yet_implemented": ["D conservation (S2 identities and ledgers plus heater, spray, relief, turbine, generator and Grid receipts)",
            "E refinement (2.5 ms-capped reference and BDF2 at rtol/100 over the window; rtol/10 for the hold)",
            "F smoothness (derivative-jump detector)", "H repeatability", "K post-event spectra",
            "I kinetics domain: D3 (a) admission at every accepted state and rule I's end (the frame driver does not check it; a preview past the S2 trip's 24.3 s exit is outside the admitted domain)",
            "C1 drift, SS-1 and SS-2", "C2/C3 directions (B)", "cost against the S3 and S2 budgets (counts and CPU are recorded)"],
        "protection_log": p.log, "divisions": divisions,
        "counts_by_class": driver.counts.json(), "stock_totals": totals, "segments": driver.segments,
        "instants": driver.log,
        "cpu": {"preparation_s": preparation_cpu_s, "run_s": run_cpu_s, "solver_s": driver.cpu.solver_s,
            "observation_s": driver.cpu.observation_s, "restart_s": driver.cpu.restart_s, "held_s": driver.cpu.held_s,
            "run_per_simulated_s": if simulated > 0. { json!(run_cpu_s / simulated) } else { Value::Null },
            "restarts_r": driver.counts.total(Class::R), "s_instants": driver.counts.total(Class::S)},
        "frames": recorder.rows,
    });
    std::fs::write(
        &receipt_path,
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();
    eprintln!(
        "{}: {status}; {verdict}; R {} S {}; run CPU {run_cpu_s:.2} s over {simulated:.2} s; failure {failure:?}",
        case.key(),
        driver.counts.total(Class::R),
        driver.counts.total(Class::S)
    );
    for l in &judged {
        eprintln!("  {} {}: {}", l["id"], l["kind"], l["verdict"]);
    }
}

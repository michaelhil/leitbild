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
//!   it, `LD01_S3_PREVIEW_JUDGED_FROM_S` move C1's judged span).
//! - Rule I (A4 with B1, r3.7) is judged at every accepted stock step.
//! - `LD01_S3_GATES=1` (stock IDAS, feature `quadratures`) adds the gate
//!   families beside the lines, each with its receipt section, verdict and
//!   threshold source: D conservation, E refinement (with E′), F smoothness,
//!   G cost, H repeatability (a repeat run; `LD01_S3_GATES_REPEAT=0` skips
//!   it), K spectra (external Z6 receipts, `LD01_S3_Z6_RECEIPTS`), B
//!   directions, and C1's drift, SS-1 and SS-2. The references are run in
//!   the same invocation (`LD01_S3_GATES_REFERENCES` = a comma list of their
//!   names limits them). A family a run cannot exercise is listed in
//!   `gates_not_yet_implemented` with its reason.
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water),
//! `LD01_S3_DECLARATION` / `LD01_S3_DECISION_LOG` (the page holding the
//! block and its decision log), `LD01_S3_STATE` (a settled state of the
//! packet), `LD01_IC_SECTION` (the compiled `ic` section),
//! `LD01_S3_CASE_RECEIPT` (a new receipt path) and, for a gate run,
//! `LD01_S2_DECLARATION` (the page holding the S2 blocks the families read:
//! identity and ledger bounds, the observation and output grids, the
//! accuracy extension, the reference factors; else the wiki's page).
#![cfg(all(feature = "ida", target_os = "macos"))]
#![recursion_limit = "256"]
#[allow(dead_code)] // The S2 harness's comparisons; S3 uses E0 and the drift.
#[path = "s2_harness/compare.rs"]
mod compare;
#[allow(dead_code)] // The S2 harness's conservation record.
#[path = "s2_harness/conservation.rs"]
mod conservation;
#[path = "common/filter.rs"]
mod filter;
#[allow(dead_code)] // The S2 harness's declaration readers; S3 uses a subset.
#[path = "s2_harness/gates.rs"]
mod gates;
#[allow(dead_code)] // The S2 harness's declaration readers; S3 uses a subset.
#[path = "s2_harness/guards.rs"]
mod guards;
#[allow(dead_code)] // The S2 harness's credited outputs; S3 uses the reader.
#[path = "s2_harness/outputs.rs"]
mod outputs;
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
    lines, observe,
    timeline::{Timeline, relief_sg},
};
use serde_json::{Value, json};

/// The published block (wiki 0ccf579), pinned by RP1-pin-s3-c1c3-r3.7.
const C1C3_R3_7: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c1c3-r3.7.json");

fn block() -> Block {
    Block::from_json(declaration::FENCE, C1C3_R3_7).unwrap()
}

#[test]
fn the_published_block_pins_and_its_open_values_refuse_their_cases() {
    let b = block();
    // RP1-pin-s3-c1c3-r3.7's declared sha256.
    assert_eq!(
        guards::declared_sha256(&b).unwrap(),
        "083df1253745f4c895a69b13e5579b2099e3e2271f06acef1ac309e0eb431d2d"
    );
    let log = "| RP1-pin-s3-c1c3-r3.7 | 15 Oct | `ld01-s3-cases-c1c3` frozen; sha256 083df1253745f4c895a69b13e5579b2099e3e2271f06acef1ac309e0eb431d2d |\n";
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

/// C5's own block (wiki claude/ld01-s3-c5-wiki 341ab8c), pinned by
/// RP1-pin-s3-c5-r2 before any C5 run (C5L).
const C5_R2: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c5-r2.json");

#[test]
fn the_c5_block_pins_before_any_run_and_reads_its_common_rules_under_common_rules() {
    let b = Block::from_json(s3_harness::c5::FENCE, C5_R2).unwrap();
    assert_eq!(
        guards::declared_sha256(&b).unwrap(),
        "433ffb67951273888399fc9a83e6cad7a84202341e1981d98be68beea7db1665"
    );
    let log = "| RP1-pin-s3-c5 | 15 Oct | `ld01-s3-cases-c5` r1; sha256 786b04d78faea017221f30054ec796211fed69eba78be6391351aa7f8c80a094 |\n| RP1-pin-s3-c5-r2 | 15 Oct | `ld01-s3-cases-c5` r2; sha256 433ffb67951273888399fc9a83e6cad7a84202341e1981d98be68beea7db1665 |\n";
    let pin = guards::pin_of(&b, Some(log), "log").unwrap();
    assert_eq!(pin["pinned"], json!(true), "{pin}");
    assert_eq!(pin["frozen_row"], json!("RP1-pin-s3-c5-r2"));
    let tbd = guards::tbd_state(&b, Some(log)).unwrap();
    assert!(declaration::case_refusals(Case::C5, &pin, &tbd).is_empty());
    // The C1–C3 pin rows do not pin it.
    let other = guards::pin_of(&b, Some("| RP1-pin-s3-c1c3-r3.7 | `ld01-s3-cases-c1c3` 083df1253745f4c895a69b13e5579b2099e3e2271f06acef1ac309e0eb431d2d |\n"), "log").unwrap();
    assert_eq!(other["pinned"], json!(false));
    assert_eq!(kinetics_rule_at(&b, "/commonRules").unwrap()["floor"], "B1");
    let spec = b.whole("/cases/C5");
    let (at, command) = case_clock(
        Case::C5,
        &spec,
        b.number("/commonRules/frameAlignment/frame_s"),
    )
    .unwrap();
    assert_eq!((at, command.is_none()), (10.37, true));
    assert_eq!(case_window(Case::C5, &spec), Some(30.));
    assert!(window_cap(Case::C5, &spec, None).is_none());
    assert_eq!(spec["lines"]["O3"]["window_s"], json!([0, 0.3]));
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
fn c3s_lines_follow_the_acquired_low_flow_cause() {
    let b = block();
    let v = |judged: &[Value], id: &str| {
        judged
            .iter()
            .find(|l| l["id"] == id)
            .map(|l| l["verdict"].as_str().unwrap().to_string())
            .unwrap()
    };
    // Without loop-flow acquisition every C3 line but M1 is not executable.
    let quiet = Timeline::default();
    let judged = lines::judge(
        Case::C3,
        &b.whole("/cases/C3/lines"),
        &quiet,
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
    // With it: loop A's low flow at +12.4 s in I1-I3, the release there,
    // every seat by +15 s and the PRHR request.
    let mut with_flow = implemented();
    with_flow.extend([
        "LD01.PROT.RCS.A.LOW_FLOW".to_string(),
        "LD01.PROT.RCS.B.LOW_FLOW".to_string(),
    ]);
    let division = json!({"powered": true,
        "causes": [{"function": "LD01.PROT.RCS.A.LOW_FLOW", "t_s": 12.4}],
        "trip": {"function": "LD01.PROT.RCS.A.LOW_FLOW", "t_s": 12.4},
        "requests": [{"by": "LD01.PROT.RCS.A.LOW_FLOW", "request": "PRHR", "t_s": 12.4}]});
    let seats: Vec<Value> = (0..52)
        .map(|c| json!({"cluster": format!("LD01.CR.{c:03}"), "event": "seat", "t_s": 15.}))
        .collect();
    let log = vec![json!({"t_s": 15., "class": "R", "kinds": ["located roots"],
        "restart": {"transactions": [{"rods": seats}]}})];
    let divisions = vec![division.clone(), division.clone(), division];
    let tl = Timeline::from_logs(&log, &divisions, Some(12.4), 0., 60.).unwrap();
    let judged = lines::judge(Case::C3, &b.whole("/cases/C3/lines"), &tl, &with_flow, 52);
    assert_eq!(v(&judged, "C3.O1"), "recorded");
    assert_eq!(v(&judged, "C3.O2"), "pass");
    assert_eq!(v(&judged, "C3.N1"), "pass");
    assert_eq!(v(&judged, "C3.N2"), "pass");
    // A cause before the low flow fails N2; no low flow leaves O2 not
    // applicable.
    let mut early = divisions.clone();
    early[0]["causes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"function": "LD01.PROT.PZR.HIGH_PRESSURE", "t_s": 11.}));
    let tl = Timeline::from_logs(&log, &early, Some(12.4), 0., 60.).unwrap();
    let judged = lines::judge(Case::C3, &b.whole("/cases/C3/lines"), &tl, &with_flow, 52);
    assert_eq!(v(&judged, "C3.N2"), "fail");
    let none = Timeline::default();
    let judged = lines::judge(Case::C3, &b.whole("/cases/C3/lines"), &none, &with_flow, 52);
    assert_eq!(v(&judged, "C3.O2"), "not applicable");
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

#[test]
fn the_s3_settle_reads_its_maximum_step_from_the_block() {
    // S3-D35: settling.maxStep_s, 2 s since r3.5; absent refuses.
    let mut v: Value = serde_json::from_str(C1C3_R3_7).unwrap();
    assert_eq!(s3_unit::settle_max_step(&v), Ok(2.));
    v.as_object_mut().unwrap().remove("settling");
    assert!(s3_unit::settle_max_step(&v).is_err());
    v["settling"] = json!({"maxStep_s": 2.0});
    assert_eq!(s3_unit::settle_max_step(&v), Ok(2.));
    v["settling"]["maxStep_s"] = json!(0.);
    assert!(s3_unit::settle_max_step(&v).is_err());
    // The block is found once in a page.
    let page = format!("text\n```ld01-s3-cases-c1c3\n{C1C3_R3_7}\n```\nmore");
    assert_eq!(s3_unit::cases_block(&page).unwrap()["revision"], "3.7");
    let twice = format!("{page}\n```ld01-s3-cases-c1c3\n{{}}\n```");
    assert!(s3_unit::cases_block(&twice).is_err());
}

#[test]
fn c3s_operator_turbine_trip_and_labelled_end_are_read_from_the_block() {
    // S3-D39: 10 s after the acquired reactor trip; C3 only.
    let b = block();
    assert_eq!(
        operator_trip_delay(Case::C3, &b.whole("/cases/C3")),
        Ok(Some(10.))
    );
    assert_eq!(
        operator_trip_delay(Case::C2, &b.whole("/cases/C2")),
        Ok(None)
    );
    let mut c3 = b.whole("/cases/C3");
    c3.as_object_mut().unwrap().remove("labelledEnd");
    assert!(operator_trip_delay(Case::C3, &c3).is_err());
    // Zone R exhausts within the next step only when draining that far.
    assert!(zone_r_exhausts_within(0.4, -1., 0.5));
    assert!(!zone_r_exhausts_within(0.4, -1., 0.3));
    assert!(!zone_r_exhausts_within(0.4, 1., 10.));
    assert!(zone_r_exhausts_within(0., -1e-9, 1e-6));
}

#[test]
fn c2s_level_line_is_judged_on_the_sections_recorded_vote() {
    let b = block();
    let (log, mut divisions) = c2_logs(52);
    let verdict = |tl: &Timeline| {
        lines::judge(
            Case::C2,
            &b.whole("/cases/C2/lines"),
            tl,
            &implemented(),
            52,
        )
        .into_iter()
        .find(|l| l["id"] == "C2.N3")
        .map(|l| l["verdict"].as_str().unwrap().to_string())
        .unwrap()
    };
    let mut tl = Timeline::from_logs(&log, &divisions, Some(500.15), 500., 560.).unwrap();
    assert_eq!(verdict(&tl), "not executable", "no monitor in the section");
    tl.monitors_declared = vec!["C2.N3 PZR LT vote".into()];
    assert_eq!(verdict(&tl), "pass", "declared, never qualified");
    divisions[1]["monitors"] = json!({"C2.N3 PZR LT vote": 530.});
    let mut tl = Timeline::from_logs(&log, &divisions, Some(500.15), 500., 560.).unwrap();
    tl.monitors_declared = vec!["C2.N3 PZR LT vote".into()];
    assert_eq!(tl.monitors, vec![("C2.N3 PZR LT vote".to_string(), 1, 30.)]);
    assert_eq!(verdict(&tl), "fail", "a division qualified the vote");
}

// ------------------------------------------------------------ the case run

/// PERF E-PROF: one frame of the cost profile: `t`, the counter reads so
/// far and per path `[closed calls, exclusive instructions]` so far.
type ProfileFrame = (f64, u64, Vec<(u64, u64)>);

/// The PZR roof pressure, SG pressures and rod travel range at each frame's
/// left limit, from the dense output (observation only).
struct Recorder {
    roof: (usize, f64),
    sg: Vec<(String, usize, f64)>,
    rods: Vec<(usize, f64)>,
    scratch: Vec<f64>,
    rows: Vec<Value>,
    /// HOOK (OU-A U5 lag projection): the process's instructions retired
    /// at each frame, when LD01_OU_FRAME_COST=1 (never in `frames`, whose
    /// digest the tiers pin).
    cost: Option<Vec<(f64, u64)>>,
    /// HOOK (PERF E-PROF): the cost profile's totals at each frame, when
    /// LD01_PERF_PROFILE=1 (with LD01_OU_FRAME_COST=1).
    profile: Option<Vec<ProfileFrame>>,
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
        if let Some(c) = self.cost.as_mut() {
            c.push((t, s3_harness::counters::instructions()?));
        }
        if let Some(p) = self.profile.as_mut() {
            let (totals, reads) = leitbild_operating_plant::cost::totals()
                .ok_or("LD01_PERF_PROFILE=1 without an installed cost profile")?;
            p.push((t, reads, totals));
        }
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

/// The gate-run wiki's blocks (claude/ld01-r8-wiki 27128d1): C1–C3 at
/// revision 3.8 (RP1-pin-s3-c1c3-r3.8) and C4 at revision 3
/// (RP1-pin-s3-c4-r3), every probe value filled.
const C1C3_R3_8: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c1c3-r3.8.json");
const C1C3_R3_8_SHA256: &str = "7291821074f5f28193491ecef597deb6ff42cdb2118db4a74649ea584951f3e7";
const C4_R3: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c4-r3.json");
const C4_R3_SHA256: &str = "6b4958c8aff62554f88ee90e4143df86336a36df049d873335673e5874bdc261";
/// The revisions the r8 wiki supersedes, refused by name.
const SUPERSEDED: [(&str, &str, &str); 2] = [
    (
        "ld01-s3-cases-c1c3",
        "083df1253745f4c895a69b13e5579b2099e3e2271f06acef1ac309e0eb431d2d",
        "RP1-pin-s3-c1c3-r3.7",
    ),
    (
        "ld01-s3-cases-c4",
        "2fe73e08f2414d84a843c5c5bd48464c3f3a6f23345f33773d2b34dac18abd5d",
        "RP1-pin-s3-c4-r2",
    ),
];
/// The pin a block must carry for a gate run on the r8 wiki, by fence.
const REQUIRED: [(&str, &str, &str); 2] = [
    (
        "ld01-s3-cases-c1c3",
        C1C3_R3_8_SHA256,
        "RP1-pin-s3-c1c3-r3.8",
    ),
    ("ld01-s3-cases-c4", C4_R3_SHA256, "RP1-pin-s3-c4-r3"),
];

/// Refuses a superseded block revision by name, and any C1–C3 or C4 block
/// other than the r8 wiki's.
fn refuse_superseded(block: &Block) -> Result<(), String> {
    let sha = guards::declared_sha256(block)?;
    if let Some((_, _, row)) = SUPERSEDED
        .iter()
        .find(|(f, s, _)| *f == block.fence && *s == sha)
    {
        return Err(format!(
            "{} is {row}, superseded on the r8 wiki (claude/ld01-r8-wiki 27128d1)",
            block.fence
        ));
    }
    match REQUIRED.iter().find(|(f, _, _)| *f == block.fence) {
        Some((_, want, row)) if *want != sha => Err(format!(
            "{} declares sha256 {sha}, not {row} ({want})",
            block.fence
        )),
        _ => Ok(()),
    }
}

/// N4′'s rule and terms as the owner (R7-Q, CH-1; R8-E4) and the lead
/// (S3-D58, S3-D61, S3-D67) state them in C4 revision 3: the texts the
/// harness implements, compared verbatim.
const N4_RULE: &str = "No numerical chattering: every vapour-path re-closing must follow a located exhaustion or a located flow reversal \u{2014} a consistent state before it, for a reversal a drive toward the emptying end beyond its tolerance, its cause recorded; such closings are counted and reported.";
const N4_CONSISTENT: &str = "the stock solver's own measure: the weighted RMS norm of the restart's correction, in integrator tolerance units (rtol\u{b7}|y| + atol, IDA's own error weights; S3-D61, S3-D67), at most 1, with the largest single row's correction in those units reported beside it (owner R8-E4, 17 October 2026, re-declared after result (RP1); it replaces S3-D58's every-row reading, whose verdicts stay on record)";
const N4_DRIVE: &str = "|drive| above the drive's first-order propagated tolerance, rule F's construction of a_x (S3-D58)";

/// C3's chattering rule read from the pinned C4 block (its N4 `judgesAlso`
/// names C3, S3-D45): the block must be RP1-pin-s3-c4-r3 and N4's rule and
/// terms the texts the harness implements; the rule's parameters are the
/// harness's reading of those texts (the kernel's L1 causes for a located
/// exhaustion and a located flow reversal; one tolerance unit).
fn n4_rule(c4: &Block, pin: &Value) -> Result<Value, String> {
    refuse_superseded(c4)?;
    if pin["pinned"] != json!(true) || guards::declared_sha256(c4)? != C4_R3_SHA256 {
        return Err(format!("the C4 block is not RP1-pin-s3-c4-r3: {pin}"));
    }
    let n4 = c4.whole("/cases/C4/lines/N4");
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    if text(&n4["rule"]) != N4_RULE {
        return Err(format!(
            "C4.N4's rule is not the one implemented: {}",
            n4["rule"]
        ));
    }
    if text(&n4["terms"]["consistentState"]) != N4_CONSISTENT
        || text(&n4["terms"]["driveBeyondTolerance"]) != N4_DRIVE
    {
        return Err(format!(
            "C4.N4's terms are not the ones implemented: {}",
            n4["terms"]
        ));
    }
    if !text(&n4["judgesAlso"]).contains("C3") {
        return Err("C4.N4 does not name C3's chattering check".into());
    }
    let mut rule: Value = serde_json::from_str(s3_harness::families::N4_PRIME_READING).unwrap();
    rule["declared"] = json!({"block": "ld01-s3-cases-c4 r3", "pin": C4_R3_SHA256, "rule": n4["rule"], "terms": n4["terms"], "judgesAlso": n4["judgesAlso"]});
    Ok(rule)
}

/// [`n4_rule`] on the S3 declaration's page and decision log (the pages
/// the cases' own block is read from).
fn n4_rule_of_the_wiki() -> Result<Value, String> {
    let page = std::env::var("LD01_S3_DECLARATION")
        .unwrap_or_else(|_| format!("{}/build-readiness.md", gates::wiki_model()));
    let log = std::env::var("LD01_S3_DECISION_LOG")
        .unwrap_or_else(|_| format!("{}/decision-log.md", gates::wiki_model()));
    let c4 = Block::from_page(&page, "ld01-s3-cases-c4")?;
    let pin = guards::pin_of(&c4, std::fs::read_to_string(&log).ok().as_deref(), &log)?;
    n4_rule(&c4, &pin)
}

#[test]
#[ignore = "requires the S3 declaration page and decision log (LD01_S3_DECLARATION, LD01_S3_DECISION_LOG)"]
fn the_wikis_c4_block_gives_c3s_chattering_rule() {
    let rule = n4_rule_of_the_wiki().unwrap();
    assert_eq!(rule["criterion"], "n4prime");
    println!("{rule}");
}

#[test]
fn c3s_chattering_rule_is_read_from_the_pinned_c4_block() {
    let c4 = Block::from_json("ld01-s3-cases-c4", C4_R3).unwrap();
    assert_eq!(guards::declared_sha256(&c4).unwrap(), C4_R3_SHA256);
    let log = format!(
        "| RP1-pin-s3-c4-r3 | 17 Oct | `ld01-s3-cases-c4` frozen; sha256 {C4_R3_SHA256} |\n"
    );
    let pin = guards::pin_of(&c4, Some(&log), "log").unwrap();
    let rule = n4_rule(&c4, &pin).unwrap();
    assert_eq!(rule["criterion"], "n4prime");
    assert_eq!(rule["consistency_measure"], "wrms_all");
    // Unpinned, or another rule text, refuses.
    assert!(n4_rule(&c4, &guards::pin_of(&c4, Some(""), "log").unwrap()).is_err());
    let mut v: Value = serde_json::from_str(C4_R3).unwrap();
    v["cases"]["C4"]["lines"]["N4"]["rule"] = json!("no chattering");
    let changed = Block::from_json("ld01-s3-cases-c4", &v.to_string()).unwrap();
    let pin = guards::pin_of(&changed, Some(&log), "log").unwrap();
    assert!(n4_rule(&changed, &pin).is_err());
    // Revision 2 is refused by name, pinned or not.
    let r2 = Block::from_json(
        "ld01-s3-cases-c4",
        include_str!("s3_harness/fixtures/ld01-s3-cases-c4-r2.json"),
    )
    .unwrap();
    let log2 = "| RP1-pin-s3-c4-r2 | 17 Oct | `ld01-s3-cases-c4` frozen; sha256 2fe73e08f2414d84a843c5c5bd48464c3f3a6f23345f33773d2b34dac18abd5d |\n";
    let e = n4_rule(&r2, &guards::pin_of(&r2, Some(log2), "log").unwrap()).unwrap_err();
    assert!(e.contains("RP1-pin-s3-c4-r2"), "{e}");
}

#[test]
fn the_r8_wikis_c1c3_block_is_r3_8_with_every_probe_filled_and_r3_7_is_refused_by_name() {
    let b = Block::from_json("ld01-s3-cases-c1c3", C1C3_R3_8).unwrap();
    assert_eq!(guards::declared_sha256(&b).unwrap(), C1C3_R3_8_SHA256);
    assert!(refuse_superseded(&b).is_ok());
    let tbd = guards::tbd_state(&b, None).unwrap();
    assert_eq!(tbd["open"], json!([]), "{tbd}");
    // Every probe the register names carries its fill.
    for key in b.value["tbd"].as_object().unwrap().keys() {
        let pointer = format!("/{}", key.replace('.', "/"));
        assert!(!b.value.pointer(&pointer).unwrap().is_null(), "{key}");
    }
    let r37 = Block::from_json("ld01-s3-cases-c1c3", C1C3_R3_7).unwrap();
    let e = refuse_superseded(&r37).unwrap_err();
    assert!(e.contains("RP1-pin-s3-c1c3-r3.7"), "{e}");
    let c4 = Block::from_json("ld01-s3-cases-c4", C4_R3).unwrap();
    assert!(refuse_superseded(&c4).is_ok());
    assert_eq!(guards::tbd_state(&c4, None).unwrap()["open"], json!([]));
}

/// Rule I and the kinetics floor as r3.7 declares them (owner request 5):
/// A4 (R5-A) and B1 (R5-B), the only rules the harness implements. The
/// floor's 8 MPa and the D3 (a) extension are the packet's compiled
/// sections; B1's per-core-region phase-absence check is [`RuleI::judge`]'s
/// admission. Any other declared text refuses.
fn kinetics_rule(block: &Block) -> Result<Value, String> {
    kinetics_rule_at(block, "")
}

/// The case run's kinetics end rule, from one explicit source:
/// `LD01_OU_PREDICATES` names a wiki page holding the one
/// `ld01-ou-predicates` block, whose `/predicates/U3/kineticsDomain` the OU
/// cases (U3, plan r4's C2/C3/C5 floor runs) end under (OU-D r4+: P1);
/// unset, the case's own block (the S3 blocks: A4, pinned with S3's
/// results). The value records its source (page and its sha256).
fn case_kinetics(d: &declaration::Declaration) -> Result<Value, String> {
    match std::env::var("LD01_OU_PREDICATES") {
        Ok(page) => {
            let block = Block::from_page(&page, "ld01-ou-predicates")?;
            let mut k = kinetics_rule_at(&block, "/predicates/U3")?;
            k["source"] = json!({"fence": "ld01-ou-predicates", "pointer": "/predicates/U3/kineticsDomain",
                "page": block.page, "page_sha256": block.page_sha256});
            Ok(k)
        }
        Err(std::env::VarError::NotPresent) => {
            let mut k = kinetics_rule_at(&d.block, &d.common(""))?;
            k["source"] = json!({"fence": d.block.fence, "pointer": format!("{}/kineticsDomain", d.common("")),
                "page": d.block.page, "page_sha256": d.block.page_sha256});
            Ok(k)
        }
        Err(e) => Err(format!("LD01_OU_PREDICATES: {e}")),
    }
}

#[test]
fn the_ou_predicates_u3_kinetics_domain_is_p1_with_b1() {
    // ld01-ou-predicates r6 (wiki claude/ld01-ou-d-wiki 29fc745), U3's rule.
    let b = Block::from_json(
        "ld01-ou-predicates",
        r#"{"predicates":{"U3":{"kineticsDomain":{"ruleI":"P1 (owner R11, OU-P1): a U3 case runs to its declared end under the hot-standby admission","floor":"B1 (owner-approved, R5-B): HOT-SOURCE-1's pressure floor 8 MPa","marginFactors":[1,1.53,2.24]}}}}"#,
    )
    .unwrap();
    let k = kinetics_rule_at(&b, "/predicates/U3").unwrap();
    assert_eq!(
        (k["ruleI"].as_str(), k["floor"].as_str()),
        (Some("P1"), Some("B1"))
    );
}

/// [`kinetics_rule`] under `prefix` (C5's block: `/commonRules`).
fn kinetics_rule_at(block: &Block, prefix: &str) -> Result<Value, String> {
    let rule_i = block.whole(&format!("{prefix}/kineticsDomain/ruleI"));
    let floor = block.whole(&format!("{prefix}/kineticsDomain/floor"));
    let (Some(rule_i), Some(floor)) = (rule_i.as_str(), floor.as_str()) else {
        return Err("the block declares no kineticsDomain.ruleI and floor".into());
    };
    if !floor.starts_with("B1 (owner-approved, R5-B)") {
        return Err(format!(
            "kinetics floor {floor:?}: the harness implements the owner's B1 (R5-B)"
        ));
    }
    if rule_i.starts_with("P1 (owner R11") {
        return Ok(
            json!({"ruleI": "P1", "floor": "B1", "ruleI_text": rule_i, "floor_text": floor,
            "exits": ["P1 hot-standby domain exit", "B1 phase-absence exit"],
            "margin": "reported at the record's factors on every accepted state, never an end"}),
        );
    }
    if !rule_i.starts_with("A4 (owner-approved, R5-A)") {
        return Err(format!(
            "rule I {rule_i:?}: the harness implements the owner's A4 (R5-A) and P1 (R11)"
        ));
    }
    Ok(
        json!({"ruleI": "A4", "floor": "B1", "ruleI_text": rule_i, "floor_text": floor,
        "exits": ["D3 (a) margin exit", "D3 (a) source-domain exit", "B1 phase-absence exit"]}),
    )
}

#[test]
fn rule_i_is_read_as_the_owners_a4_and_b1() {
    let b = block();
    let k = kinetics_rule(&b).unwrap();
    assert_eq!(
        (k["ruleI"].as_str(), k["floor"].as_str()),
        (Some("A4"), Some("B1"))
    );
    // r3.6's pre-answer defaults are not read (no legacy text).
    let old = Block::from_json(
        declaration::FENCE,
        include_str!("s3_harness/fixtures/ld01-s3-cases-c1c3-r3.6.json"),
    )
    .unwrap();
    assert!(kinetics_rule(&old).is_err());
}

/// S3-D39: C3's operator turbine-trip delay after the acquired reactor trip
/// (`operatorTurbineTripDelay_s`, with its `operatorTurbineTripFrom` and
/// `operatorTurbineTripBasis`); `None` for the other cases.
fn operator_trip_delay(case: Case, spec: &Value) -> Result<Option<f64>, String> {
    // C4 (r1) declares the same operator trip; its labelled ends are `ends`.
    let end_key = match case {
        Case::C3 => "labelledEnd",
        Case::C4 => "ends",
        Case::C1 | Case::C2 | Case::C5 => return Ok(None),
    };
    let delay = spec["operatorTurbineTripDelay_s"]
        .as_f64()
        .filter(|d| d.is_finite() && *d > 0.)
        .ok_or(format!(
            "{} declares no positive operatorTurbineTripDelay_s (S3-D39)",
            case.key()
        ))?;
    for k in ["operatorTurbineTripFrom", "operatorTurbineTripBasis"] {
        spec[k]
            .as_str()
            .ok_or(format!("{} declares no {k} (S3-D39)", case.key()))?;
    }
    if spec[end_key].is_null() {
        return Err(format!("{} declares no {end_key}", case.key()));
    }
    Ok(Some(delay))
}

/// S3-D39's labelled end: zone R's mass `m` (kg), draining at `rate`
/// (kg/s), reaches exhaustion within the `step` (s) the solver attempts next.
fn zone_r_exhausts_within(m: f64, rate: f64, step: f64) -> bool {
    rate < 0. && step > 0. && m + rate * step <= 0.
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
        // C4 (r1): the relief fails open at `malfunctionTime_s` after the
        // frame-aligned start, `malfunctionOffsetFromFrame_s` off the grid.
        Case::C4 => {
            if spec["startOnFrame"] != json!(true) {
                return Err("C4 does not declare startOnFrame".into());
            }
            let at = number("malfunctionTime_s")?;
            let off = number("malfunctionOffsetFromFrame_s")?;
            if ((at / frame_s - (at / frame_s).floor()) * frame_s - off).abs() > 1e-9 {
                return Err(format!(
                    "C4's malfunction at {at} s is not {off} s off the {frame_s} s grid"
                ));
            }
            if spec["malfunctions"]["pzrRelief"].is_null() {
                return Err("C4 declares no pzrRelief malfunction".into());
            }
            Ok((at, Some(Command::ReliefStuckOpen)))
        }
        // C5: S3-D10's offsite loss at `malfunctionTime_s`, off the grid by
        // `malfunctionOffsetFromFrame_s`; the Grid stand-in declares it at
        // its exchange (no command: a held change through `Driver::decide`).
        Case::C5 => {
            let at = number("malfunctionTime_s")?;
            let off = number("malfunctionOffsetFromFrame_s")?;
            if ((at / frame_s - (at / frame_s).floor()) * frame_s - off).abs() > 1e-9 {
                return Err(format!(
                    "C5's offsite loss at {at} s is not {off} s off the {frame_s} s grid"
                ));
            }
            if spec["malfunction"]["decision"] != json!("S3-D10") {
                return Err("C5's malfunction is not S3-D10's offsite loss".into());
            }
            Ok((at, None))
        }
    }
}

/// A case's declared event window length (C4's and C5's blocks nest it in
/// `windows`; C4 declares one such window per event, this is its length).
fn case_window(case: Case, spec: &Value) -> Option<f64> {
    match case {
        Case::C4 | Case::C5 => spec["windows"]["window_s"].as_f64(),
        _ => spec["window_s"].as_f64(),
    }
}

/// A case's declared event window (r3 §1.1, decision 0015 E2): its cap,
/// its length and the restart receipt that starts it (the case's own
/// command: C2's turbine trip, C3's RCP supply loss; C3's later operator
/// trip does not start one). C1 has none: it runs uncapped.
struct WindowCap {
    max_step_s: f64,
    window_s: f64,
    starts: fn(&Value) -> bool,
    /// RC-1: a declared fast electrical ramp at the window's start, capped
    /// tighter until the record that ends it.
    ramp: Option<Ramp>,
}

/// A declared fast electrical ramp (owner R7-S, RC-1; decision 0015 E2
/// amended): from the window's start (the case's command) to the record
/// that ends it, the steps are capped at `max_step_s`; the window's own
/// cap holds after it.
struct Ramp {
    max_step_s: f64,
    /// The restart record that ends the ramp (a transaction receipt, or an
    /// appended owner's record as `{"appended": record}`).
    ends: fn(&Value) -> bool,
    declared: &'static str,
}

impl WindowCap {
    /// The cap the window's starting restart sets.
    fn start_cap(&self) -> f64 {
        self.ramp.as_ref().map_or(self.max_step_s, |r| r.max_step_s)
    }
}

/// The cap in force `after_zero` s after the window's start, with the ramp
/// ending at `ramp_end` (s after the start) once its record exists: the
/// ramp's cap inside the ramp, the window's after it, none outside.
fn cap_in_force(w: &WindowCap, after_zero: f64, ramp_end: Option<f64>) -> Option<f64> {
    if !(0. ..w.window_s).contains(&after_zero) {
        return None;
    }
    match (&w.ramp, ramp_end) {
        (Some(r), None) => Some(r.max_step_s),
        (Some(r), Some(end)) if after_zero < end => Some(r.max_step_s),
        _ => Some(w.max_step_s),
    }
}

/// S1's `eventWindow.maxStep_s` (the gate run checks it against the block).
const WINDOW_MAX_STEP_S: f64 = 0.02;

/// RC-1's strict block (owner R7-S, 17 Oct; decision 0015 E2 amended):
/// `ld01-event-window-ramp-cap` on decision 0015's page, its own block
/// because S1's harness reads `ld01-s1-gates` strictly.
const RAMP_CAP_FENCE: &str = "ld01-event-window-ramp-cap";
const DECISION_0015: &str = "world/packs/process-plant/reference-designs/engineering/development/decisions/0015-credited-band-and-event-windows.md";

/// The ramp-cap block of the wiki named by `LD01_WIKI_ROOT`: exactly one,
/// strict JSON; absent refuses (RC-1 applies from S3, no default).
fn ramp_cap_block() -> Result<Value, String> {
    let wiki = std::env::var("LD01_WIKI_ROOT").map_err(|_| "LD01_WIKI_ROOT".to_string())?;
    let page = format!("{wiki}/{DECISION_0015}");
    let text = std::fs::read_to_string(&page).map_err(|e| format!("{page}: {e}"))?;
    ramp_cap_from(&text)
}
fn ramp_cap_from(text: &str) -> Result<Value, String> {
    let open = format!("```{RAMP_CAP_FENCE}\n");
    let mut found = text.match_indices(&open).map(|(i, _)| i);
    let start = found.next().ok_or(format!("no {RAMP_CAP_FENCE} block"))? + open.len();
    if found.next().is_some() {
        return Err(format!("more than one {RAMP_CAP_FENCE} block"));
    }
    let end = start
        + text[start..]
            .find("\n```")
            .ok_or("unterminated ramp-cap block")?;
    let block: Value = serde_json::from_str(&text[start..end]).map_err(|e| e.to_string())?;
    let keys = [
        "amends",
        "appliesFrom",
        "rampMaxStep_s",
        "elsewhereInWindow",
        "ramps",
        "rule",
    ];
    match block.as_object() {
        Some(o) if o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)) => Ok(block),
        _ => Err(format!("{RAMP_CAP_FENCE}: exactly the keys {keys:?}")),
    }
}

/// The block's ramp for `case`, bound to the harness's records: C2's ramp
/// starts at the case command LD01.TG TRIP (the window's start) and ends at
/// the generator breaker's opening, the slice's "GCB Open" record. A listed
/// ramp the harness cannot bind refuses.
fn declared_ramp(case: Case, block: &Value) -> Result<Option<Ramp>, String> {
    let h = block["rampMaxStep_s"]
        .as_f64()
        .filter(|h| h.is_finite() && *h > 0.)
        .ok_or(format!("{RAMP_CAP_FENCE}.rampMaxStep_s"))?;
    let listed: Vec<&Value> = block["ramps"]
        .as_array()
        .ok_or(format!("{RAMP_CAP_FENCE}.ramps"))?
        .iter()
        .filter(|r| r["case"] == case.key())
        .collect();
    match (case, listed.as_slice()) {
        (_, []) => Ok(None),
        (Case::C2, [r])
            if r["from"]
                .as_str()
                .is_some_and(|f| f.contains("LD01.TG TRIP"))
                && r["to"]
                    .as_str()
                    .is_some_and(|t| t.contains("generator breaker opening")) =>
        {
            Ok(Some(Ramp {
                max_step_s: h,
                ends: |r| r["appended"] == "GCB Open",
                declared: "ld01-event-window-ramp-cap (RC-1, owner R7-S): C2's turbine stop-valve ramp, from the trip command to the generator breaker's opening record",
            }))
        }
        _ => Err(format!(
            "{RAMP_CAP_FENCE}: {} lists a ramp the harness cannot bind",
            case.key()
        )),
    }
}

fn window_cap(case: Case, spec: &Value, ramp: Option<Ramp>) -> Option<WindowCap> {
    let (window_s, starts): (Option<f64>, fn(&Value) -> bool) = match case {
        // C5's cap is set by the case after the offsite loss's restart.
        Case::C1 | Case::C5 => return None,
        Case::C2 => (spec["window_s"].as_f64(), |r| {
            r["command"] == "TurbineTripAcquired"
        }),
        Case::C3 => (spec["window_s"].as_f64(), |r| r["command"] == "SupplyLoss"),
        // C4 (r1 `windows`): one window from each of the relief malfunction,
        // the reactor trip and every birth, each started by its restart.
        Case::C4 => (
            spec["windows"]["window_s"].as_f64(),
            s3_harness::c4::starts_window,
        ),
    };
    Some(WindowCap {
        max_step_s: WINDOW_MAX_STEP_S,
        window_s: window_s?,
        starts,
        ramp,
    })
}

/// C1 and C5: the Grid stand-in's energized boundary for `[t0, t1)`
/// decided at `t0` (the driver's time), as the C5 host's `boundary()`: the
/// stand-in's stiff bus at the packet's nominal voltage and frequency with
/// no phase error and no frequency rate, so the carrier rate held over the
/// interval is `2*pi*f` with a zero slope (D2, SW-1, `slice::carrier_rate`).
/// Agreeing bitwise with the held inputs (and a zero held slope) is no
/// event; anything else is a held input, class S by S3-D4's rule, checked
/// by the driver.
fn energized_boundary(
    driver: &mut leitbild_operating_water::frame::Driver<CaseUnit>,
    unit: &CaseUnit,
    t0: f64,
    t1: f64,
    v_line: f64,
    f_hz: f64,
) -> Result<&'static str, String> {
    use leitbild_operating_water::frame::{Action, Change, Class};
    if !(v_line.is_finite() && v_line > 0.) {
        return Err(format!("the stand-in's boundary voltage {v_line} V"));
    }
    let carrier = leitbild_operating_plant::electrical::slice::carrier_rate(f_hz, 0., t1 - t0)?;
    let i = unit.slice.inputs;
    if i.v_line.to_bits() == v_line.to_bits()
        && i.f_grid_hz.to_bits() == f_hz.to_bits()
        && i.carrier_rad_s.to_bits() == carrier.to_bits()
        && i.carrier_accel_rad_s2 == 0.
    {
        return Ok("none (agrees with the held prediction)");
    }
    driver.decide(vec![Change {
        due_s: t0,
        class: Class::S,
        kind: "Grid boundary (held voltage/carrier and slope, D2 + SW-1)".into(),
        action: Action::Held(Box::new(move |u: &mut CaseUnit| {
            u.slice.inputs.v_line = v_line;
            u.slice.inputs.f_grid_hz = f_hz;
            u.slice.inputs.carrier_rad_s = carrier;
            u.slice.inputs.carrier_accel_rad_s2 = 0.;
            u.slice.inputs.carrier_from_s = t0;
            Ok(())
        })),
    }])?;
    Ok("S: held boundary")
}

/// S3-D39's operator turbine trip: once any division's acquired reactor
/// trip exists, its earliest time and the declared delay to the operator's
/// turbine trip (None before that, or for a case without one).
fn operator_trip_at(
    protection: &leitbild_operating_water::ic::ProtectionClient,
    delay: Option<f64>,
) -> Option<(f64, f64)> {
    let delay = delay?;
    let trip = protection
        .protection
        .divisions
        .iter()
        .filter_map(|d| d.trip.as_ref().map(|c| c.at_s))
        .reduce(f64::min)?;
    Some((trip, delay))
}

/// D1's quiet exchange interval, from the `ld01-electrical-exchange` block
/// on the handoff page (`LD01_WIKI_ROOT`).
fn exchange_quiet_s() -> f64 {
    let page = format!("{}/operating-scale-realization.md", gates::wiki_model());
    Block::from_page(&page, "ld01-electrical-exchange")
        .unwrap_or_else(|e| panic!("the D1 exchange block: {e}"))
        .number("/quietInterval_s")
}

/// Whether the cap comes off at the chunk bound `b`: the first bound at
/// or after the window's end.
fn cap_removed_at(b: f64, zero: f64, window_s: f64) -> bool {
    b >= zero + window_s - 1e-9
}

/// The published block (wiki claude/ld01-r7-wiki e2e26fd, decision 0015's page).
const RAMP_CAP_E2E26FD: &str = "```ld01-event-window-ramp-cap\n{\"amends\":\"decision 0015 E2 (owner request 7 S, RC-1, 17 October 2026)\",\"appliesFrom\":\"S3\",\"rampMaxStep_s\":0.005,\"elsewhereInWindow\":\"ld01-s1-gates eventWindow.maxStep_s\",\"ramps\":[{\"case\":\"C2\",\"ramp\":\"the turbine stop-valve (STOP) ramp with the generator connected\",\"from\":\"the case command LD01.TG TRIP, which starts C2's event window\",\"to\":\"the generator breaker opening at the STOP ramp's end (C2.O2, 0.30 s after the trip)\"}],\"rule\":\"the 5 ms cap holds only over a ramp listed here; a ramp is listed before the first gated run of its case (RP1)\"}\n```\n";
fn ramp_fixture() -> Value {
    ramp_cap_from(RAMP_CAP_E2E26FD).unwrap()
}

#[test]
fn the_ramp_cap_block_is_read_strictly_and_binds_only_c2s_ramp() {
    let b = ramp_fixture();
    assert_eq!(
        b["rampMaxStep_s"].as_f64().unwrap().to_bits(),
        0.005f64.to_bits()
    );
    assert!(declared_ramp(Case::C2, &b).unwrap().is_some());
    assert!(declared_ramp(Case::C3, &b).unwrap().is_none());
    assert!(declared_ramp(Case::C1, &b).unwrap().is_none());
    // Two blocks, an extra key, or a ramp the harness cannot bind refuse.
    assert!(ramp_cap_from(&format!("{RAMP_CAP_E2E26FD}{RAMP_CAP_E2E26FD}")).is_err());
    assert!(ramp_cap_from(&RAMP_CAP_E2E26FD.replace("\"rule\"", "\"extra\":1,\"rule\"")).is_err());
    assert!(ramp_cap_from("no block").is_err());
    let mut unbound = b.clone();
    unbound["ramps"][0]["to"] = "the reactor trip".into();
    assert!(declared_ramp(Case::C2, &unbound).is_err());
    let mut c3 = b.clone();
    c3["ramps"][0]["case"] = "C3".into();
    assert!(declared_ramp(Case::C3, &c3).is_err());
}

#[test]
fn the_ramp_cap_holds_only_inside_the_ramp() {
    let b = block();
    let c2 = window_cap(
        Case::C2,
        &b.whole("/cases/C2"),
        declared_ramp(Case::C2, &ramp_fixture()).unwrap(),
    )
    .unwrap();
    // Before the trip, at and after the window's end: no cap.
    assert_eq!(cap_in_force(&c2, -0.01, None), None);
    assert_eq!(cap_in_force(&c2, 20., Some(0.3)), None);
    // Inside the ramp (the GCB-open record not yet, or later than t): 5 ms.
    assert_eq!(cap_in_force(&c2, 0., None), Some(0.005));
    assert_eq!(cap_in_force(&c2, 0.15, None), Some(0.005));
    assert_eq!(cap_in_force(&c2, 0.299, Some(0.3)), Some(0.005));
    // From the record to the window's end: the window's 20 ms.
    assert_eq!(cap_in_force(&c2, 0.3, Some(0.3)), Some(0.02));
    assert_eq!(cap_in_force(&c2, 19.99, Some(0.3)), Some(0.02));
    // C3 declares no ramp: 20 ms over its whole window.
    let c3 = window_cap(
        Case::C3,
        &b.whole("/cases/C3"),
        declared_ramp(Case::C3, &ramp_fixture()).unwrap(),
    )
    .unwrap();
    assert_eq!(cap_in_force(&c3, 0., None), Some(0.02));
    assert_eq!(cap_in_force(&c3, 29.99, None), Some(0.02));
}

#[test]
fn the_window_cap_holds_only_inside_the_declared_window() {
    let b = block();
    // C1 declares no window: never capped.
    assert!(window_cap(Case::C1, &b.whole("/cases/C1"), None).is_none());
    // C2: 20 s from the trip, started by the trip's receipt only.
    let c2 = window_cap(
        Case::C2,
        &b.whole("/cases/C2"),
        declared_ramp(Case::C2, &ramp_fixture()).unwrap(),
    )
    .unwrap();
    assert_eq!((c2.max_step_s, c2.window_s), (0.02, 20.));
    assert!((c2.starts)(
        &json!({"command": "TurbineTripAcquired", "owner": "secondary"})
    ));
    assert!(!(c2.starts)(
        &json!({"command": "HoldingLoss", "owner": "secondary"})
    ));
    assert!(!(c2.starts)(
        &json!({"event": "STOP ramp end", "owner": "secondary"})
    ));
    // C3: 30 s from the supply loss; the operator's later trip starts none.
    let c3 = window_cap(
        Case::C3,
        &b.whole("/cases/C3"),
        declared_ramp(Case::C3, &ramp_fixture()).unwrap(),
    )
    .unwrap();
    assert_eq!(c3.window_s, 30.);
    assert!((c3.starts)(
        &json!({"command": "SupplyLoss", "owner": "network", "rotor": 0})
    ));
    assert!(!(c3.starts)(
        &json!({"command": "TurbineTripAcquired", "owner": "secondary"})
    ));
    // RC-1: C2's ramp, 5 ms from the trip to the GCB-open record; C3 none.
    let ramp = c2.ramp.as_ref().unwrap();
    assert_eq!((c2.start_cap(), ramp.max_step_s), (0.005, 0.005));
    assert!((ramp.ends)(&json!({"appended": "GCB Open"})));
    assert!(!(ramp.ends)(&json!({"appended": "GCB Closed"})));
    assert!(!(ramp.ends)(
        &json!({"event": "STOP ramp end", "owner": "secondary"})
    ));
    assert!(!(ramp.ends)(
        &json!({"command": "TurbineTripAcquired", "owner": "secondary"})
    ));
    assert!(c3.ramp.is_none() && c3.start_cap() == 0.02);
    // Off at the first bound at or after the window's end, not before.
    let zero = 548.05;
    assert!(!cap_removed_at(zero + 19.95, zero, 20.));
    assert!(cap_removed_at(zero + 20., zero, 20.));
    assert!(cap_removed_at(548.1 + 20., zero, 20.));
}

#[test]
fn c4s_clock_windows_and_operator_trip_are_read_from_its_block() {
    // C4's revision 2 (superseded by r3 for a run, refused there by name):
    // its clock, windows and register mechanics, which r3 keeps.
    let b = Block::from_json(
        s3_harness::c4::FENCE,
        include_str!("s3_harness/fixtures/ld01-s3-cases-c4-r2.json"),
    )
    .unwrap();
    let spec = b.whole("/cases/C4");
    // The relief fails open at the frame-aligned start.
    let (zero, command) = case_clock(Case::C4, &spec, 0.1).unwrap();
    assert_eq!((zero, command), (0., Some(Command::ReliefStuckOpen)));
    // 20 s windows from the malfunction, the reactor trip and each birth.
    let w = window_cap(Case::C4, &spec, None).unwrap();
    assert_eq!((w.max_step_s, w.window_s), (0.02, 20.));
    assert!((w.starts)(
        &json!({"owner": "pzr", "command": "ReliefStuckOpen", "stuck_open": true})
    ));
    assert!((w.starts)(
        &json!({"owner": "secondary", "command": "HoldingLoss"})
    ));
    assert!((w.starts)(
        &json!({"owner": "phase modes", "events": [{"birth": 26}]})
    ));
    assert!(!(w.starts)(
        &json!({"owner": "phase modes", "events": [{"exhaustion": 26}]})
    ));
    assert!(!(w.starts)(
        &json!({"owner": "secondary", "command": "TurbineTripAcquired"})
    ));
    // The operator trips the turbine 10 s after the reactor trip.
    assert_eq!(operator_trip_delay(Case::C4, &spec), Ok(Some(10.)));
    let mut no_ends = spec.clone();
    no_ends.as_object_mut().unwrap().remove("ends");
    assert!(operator_trip_delay(Case::C4, &no_ends).is_err());
    // C4's pin and register are its own block's.
    let sha = guards::declared_sha256(&b).unwrap();
    assert_eq!(
        sha,
        "2fe73e08f2414d84a843c5c5bd48464c3f3a6f23345f33773d2b34dac18abd5d"
    );
    let log = format!("| RP1-pin-s3-c4-r2 | 17 Oct | `ld01-s3-cases-c4`; sha256 {sha} |\n");
    let pin = guards::pin_of(&b, Some(&log), "log").unwrap();
    let tbd = guards::tbd_state(&b, Some(&log)).unwrap();
    let refusals = declaration::case_refusals(Case::C4, &pin, &tbd);
    assert_eq!(
        refusals.iter().filter(|r| r.starts_with("TBD(")).count(),
        9,
        "{refusals:?}"
    );
    assert!(refusals.iter().all(|r| !r.contains("not pinned")));
}

/// The joined system the case run integrates: with stock IDAS, the S2
/// ledgers ride on it as quadratures (rule D); without, the plain one.
#[cfg(feature = "quadratures")]
type Inner = leitbild_operating_water::joined_ledger::Ledgered<leitbild_operating_water::If97>;
#[cfg(not(feature = "quadratures"))]
type Inner = leitbild_operating_water::joined::Integrated<leitbild_operating_water::If97>;
type CaseUnit = leitbild_operating_water::electrical::Electrified<Inner>;

#[cfg(feature = "quadratures")]
fn wrap(
    i: leitbild_operating_water::joined::Integrated<leitbild_operating_water::If97>,
) -> Result<Inner, String> {
    leitbild_operating_water::joined_ledger::Ledgered::new(i, spine::z1::cpu_s)
}
#[cfg(not(feature = "quadratures"))]
fn wrap(
    i: leitbild_operating_water::joined::Integrated<leitbild_operating_water::If97>,
) -> Result<Inner, String> {
    Ok(i)
}

/// The gate observation's declared settings (a gate run).
struct GateSetup {
    s2: gates::Declaration,
    budgets: compare::Budgets,
    network_packet: leitbild_operating_plant::network::packet::Packet,
    reference_travel_m: f64,
    /// Rule F's law corners (owner R8-E1-a, S3-D68) from the packet.
    corner_law: Result<s3_harness::families::CornerLaw, String>,
    /// The packet's SG relief law (Pa): crack, full lift, reseat (R8-E2-a).
    sg_relief_law: Option<[f64; 3]>,
}

/// A frame stop's state for rule K (S3-D52): time, `y`, `y'`, the system's
/// discrete state and the PZR heater demand in force.
type FrameState = (f64, Vec<f64>, Vec<f64>, Value, f64);

/// One driven run of a case: its record, observation and CPU marks.
struct Driven {
    record: Value,
    observer: observe::CaseObserver,
    zero: f64,
    exit_after_zero: Option<f64>,
    failure: Option<String>,
    /// Rule G's marks ([`s3_harness::families::Mark`]).
    marks: Vec<s3_harness::families::Mark>,
    /// `(t − zero, cumulative stock convergence failures)` (H1a).
    convergence: Vec<(f64, f64)>,
    /// Located seat time per rod cluster index (S2's timing comparison).
    seats: std::collections::BTreeMap<usize, f64>,
    /// The acquired reactor trip after zero (the first division's trip).
    reactor_trip_after_zero: Option<f64>,
    /// Rule F's absolute classes and their record (S3-D49).
    f_tolerances: Option<(std::collections::BTreeMap<String, Vec<f64>>, Value)>,
    /// The run's relative tolerance.
    rtol: f64,
    /// Each restart's pre-transaction consistency (N4′).
    entries: Vec<Value>,
    /// Every logged instant (R, S) and donor flip, absolute (rule F).
    instants: Vec<f64>,
    donor_flips: usize,
    /// After zero: the generator breaker's opening and each SG relief
    /// opening (+1) and closing (-1) (rule B).
    gcb_open_after_zero: Option<f64>,
    sg_relief: Vec<(String, String, i64, f64)>,
    repeat_record: Value,
    /// Rule K's post-event state (S3-D52): the declared part's end, the
    /// window's end or rule I's end, whichever first: `(path, sha256,
    /// which)`.
    declared_end_state: Option<(String, String, &'static str)>,
    end_after_zero: f64,
    /// C4: rule K's states (1 s after each phase change, the declared end)
    /// and the first birth after zero.
    c4_states: Vec<Value>,
    first_birth_after_zero: Option<f64>,
}

/// What one run is asked: the run itself, its repeat or a reference.
struct Ask<'a> {
    label: &'a str,
    scaling: s3_unit::Scaling,
    /// A reference's own maximum step (S1's `eventReference.maxStep_s`).
    max_step: Option<f64>,
    /// Credited outputs from this time after zero (C1: `judgedFrom_s`).
    credited_from: f64,
    /// The path prefix of rule K's post-event state (C2/C3), if written:
    /// `<prefix>-window-end-state.json` or `<prefix>-rule-i-end-state.json`.
    window_state: Option<String>,
    /// Whether the case's declared event window applies (decision 0015
    /// E2's cap and E4/H1's window-end restart): the run, its repeat and
    /// the cost drive; never a reference (R1 has its own cap, R2 none).
    event_window: bool,
    /// The gate observation grid when not S1's comparison grid (SS-1: the
    /// 0.1 s output grid, S3-D51).
    observation_s: Option<f64>,
    /// Whether rule F's absolute classes are propagated at the start
    /// (S3-D49; the run only).
    f_tolerances: bool,
}

/// HOOK (PERF E-PROF): the profile's counter, the process's instructions
/// retired; an unreadable counter stops the run (a cost is never zero).
fn perf_counter() -> u64 {
    s3_harness::counters::instructions().expect("instructions retired")
}
/// HOOK (PERF E-PROF): instructions one counter read costs (the median
/// of 15 batches of 1,000 back-to-back reads), so a judge can state the
/// profile's own overhead.
fn perf_read_instructions() -> u64 {
    let mut batches: Vec<u64> = (0..15)
        .map(|_| {
            let a = perf_counter();
            for _ in 0..1_000 {
                std::hint::black_box(perf_counter());
            }
            (perf_counter() - a) / 1_001
        })
        .collect();
    batches.sort_unstable();
    batches[7]
}
/// HOOK (PERF E-PROF): LD01_PERF_PROFILE=1 installs the cost profile on
/// this thread, `pieces` with the block Jacobian's pieces (with
/// LD01_OU_FRAME_COST=1 only); unset: nothing.
fn perf_install() {
    match std::env::var("LD01_PERF_PROFILE").ok().as_deref() {
        None => {}
        Some(v @ ("1" | "pieces")) => {
            assert_eq!(
                std::env::var("LD01_OU_FRAME_COST").as_deref(),
                Ok("1"),
                "LD01_PERF_PROFILE=1 needs LD01_OU_FRAME_COST=1"
            );
            leitbild_operating_plant::cost::install(perf_counter, v == "pieces")
                .unwrap_or_else(|e| panic!("{e}"));
        }
        Some(v) => panic!("LD01_PERF_PROFILE={v}: only 1 or pieces (or unset)"),
    }
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)] // One case: composition, run, judgement.
fn drive(
    case: Case,
    d: &declaration::Declaration,
    spec: &Value,
    inputs: &s3_unit::Inputs,
    state: &Value,
    state_path: &str,
    span: f64,
    gate: Option<&GateSetup>,
    ask: &Ask<'_>,
) -> Driven {
    use leitbild_operating_water::{
        electrical::FieldClient,
        frame::{
            Action, COUNTER_NAMES, Change, Class, Client, Diagnostic, Driver, Observer, Setup,
            Side, same_instant,
        },
        ic::ProtectionClient,
        ida::System,
        joined::JoinedSystem,
    };
    let c5 = case == Case::C5;
    // C1 and C5 exchange with the test-only Grid stand-in (owner D1 + D2,
    // R5-F4): C1 as a connected unit on a steady bus, every interval quiet
    // (S3-D42: no grid event, no grid window).
    let exchanging = c5 || case == Case::C1;
    let started = spine::z1::cpu_s();
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
        reference,
    } = s3_unit::compose_with(inputs, state, ask.scaling, wrap).unwrap_or_else(|e| panic!("{e}"));
    let declared_frame_s = d.block.number(&d.common("/frameAlignment/frame_s"));
    d.block.text(&d.common("/frameAlignment/rule"));
    assert_eq!(
        declared_frame_s,
        frame.period_s(),
        "the block's frame is the I&C frame"
    );
    let (zero_after, command) = case_clock(case, spec, declared_frame_s).unwrap();
    let packet_json: Value = serde_json::from_slice(&spine::packet_bytes().1).expect("packet json");
    // The case's kinetics end rule (P1, owner R11): A4's D3 (a) for the S3
    // blocks, the hot-standby admission under P1 (`case_kinetics`).
    let extension = match case_kinetics(d).unwrap_or_else(|e| panic!("{e}"))["ruleI"].as_str() {
        Some("P1") => observe::KineticsRule::HotStandby(
            serde_json::from_value(packet_json["hot_standby_kinetics"].clone())
                .expect("the packet's hot_standby_kinetics section (P1)"),
        ),
        Some("A4") => observe::KineticsRule::D3a(
            serde_json::from_value(packet_json["post_trip_domain"].clone())
                .expect("the packet's post_trip_domain section (D3 (a))"),
        ),
        other => panic!("kinetics rule {other:?}: A4 or P1"),
    };
    let zero = t0 + zero_after;
    let joined = &ida.system().integrated().joined;
    let mut protection = ProtectionClient::new(&section, joined, &y[..n], &reference)
        .and_then(|p| p.with_system_dimension(y.len()))
        .expect("protection");
    let implemented: Vec<String> = section.functions.iter().map(|f| f.id.clone()).collect();
    // C5 (ICFIELD): the generator page's ACT.B field controller, a client,
    // with its timing from the ELEC packet's `fieldProtection`
    // (ld01-generator-field-protection, S3-D44); the stand-in's boundary
    // for the electrical packet's nominal line voltage and frequency.
    let elec_packet: Value =
        serde_json::from_slice(&std::fs::read(&inputs.elec_path).expect("the electrical packet"))
            .expect("the electrical packet json");
    let mut field = c5.then(|| {
        let parameters: leitbild_operating_plant::electrical::field::Parameters =
            serde_json::from_value(elec_packet["fieldProtection"].clone()).expect(
                "C5: the electrical packet carries no field controller timing (ld01-generator-field-protection)",
            );
        FieldClient::new(&parameters, frame, ida.system()).expect("the field controller")
    });
    let v_nominal = elec_packet["boundary"]["lineVoltage_V"]
        .as_f64()
        .unwrap_or(f64::NAN);
    let f_nominal = elec_packet["boundary"]["frequency_Hz"]
        .as_f64()
        .unwrap_or(f64::NAN);
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
        // HOOK (OU-C P2): each cluster's travel coordinate is the rod
        // owner's travel output.
        rods: joined.rods().expect("rod owner").structure().outputs[..clusters]
            .iter()
            .map(|t| (o.rods + t[0], scales[o.rods + t[0]]))
            .collect(),
        scratch: vec![0.; y.len()],
        rows: Vec::new(),
        cost: (std::env::var("LD01_OU_FRAME_COST").as_deref() == Ok("1")).then(Vec::new),
        profile: leitbild_operating_plant::cost::active().then(Vec::new),
    };
    // The gate observation: the ledgers count in the run's own (unscaled)
    // tolerance units for a reference too (DR-P3-GATE-2).
    let ledger_atol: Vec<f64> = atol.iter().map(|a| a / ask.scaling.absolute).collect();
    let ledger_rtol = rtol / ask.scaling.relative;
    let gates_part = gate.map(|g| {
        let joined = &ida.system().integrated().joined;
        let plan = leitbild_operating_plant::joined::account::Plan::new(joined)
            .unwrap_or_else(|e| panic!("the account's plan: {e:?}"));
        let held0 = observe::held_at(&plan, joined, &y[..n], &ledger_atol[..n], ledger_rtol)
            .unwrap_or_else(|e| panic!("{e}"));
        let ledgers = plan.ledger_names().len();
        let conservation = cfg!(feature = "quadratures").then(|| {
            conservation::Conservation::new(&g.s2.gates, plan.clone(), held0, vec![0.; ledgers])
        });
        let unit = ida.system();
        let names = |v: Vec<String>| v;
        let regions = names(
            g.network_packet
                .mechanics
                .regions
                .iter()
                .map(|r| r.id.clone())
                .collect(),
        );
        let faces = names(
            g.network_packet
                .mechanics
                .faces
                .iter()
                .map(|f| f.id.clone())
                .collect(),
        );
        // C3's idle branch: the supply-lost pump's discharge face (S3-D50).
        let idle_face = match command {
            Some(Command::SupplyLoss { rotor }) => s3_unit::ROTOR_CONSUMERS[rotor]
                .strip_prefix("LD01.P.")
                .map(|p| format!("PUMP.{p}->COLD.{}", &p[..1])),
            _ => None,
        };
        let extra = observe::Extra::of(
            &regions,
            &faces,
            &plan.ledger_names(),
            plan.generators(),
            idle_face.as_deref(),
        )
        .unwrap_or_else(|e| panic!("the extra signals: {e}"));
        observe::Gates {
            origin: zero,
            dt: ask.observation_s.unwrap_or(g.budgets.observation_s),
            output_s: g.budgets.output_s,
            credited_from: zero + ask.credited_from,
            reader: outputs::Reader::new(joined, &g.network_packet, g.reference_travel_m)
                .expect("credited output reader"),
            // Event cases record the rods' travel for S2's timing check.
            rods: case != Case::C1,
            credited: compare::Credited::default(),
            credited_error: None,
            plan,
            ledger_atol: ledger_atol.clone(),
            ledger_rtol,
            conservation,
            conservation_error: None,
            slice: observe::SliceLedger {
                e0: unit.slice.stored_energy(&y[n..]),
                deposits0: unit.mechanism_j,
                atol: ledger_atol[n..].to_vec(),
                rtol: ledger_rtol,
                worst: None,
                worst_units: -1.,
                closures: 0,
            },
            pending: Vec::new(),
            fingerprint: observe::Fingerprint::default(),
            samples: 0,
            rotors: Vec::new(),
            last_receipts: None,
            extra: Some(extra),
        }
    });
    let mut observer = observe::CaseObserver {
        n,
        extension,
        rule_i: observe::RuleI::default(),
        gates: gates_part,
        instructions: 0,
        instructions_error: None,
        residuals: observe::AlgebraicResiduals::of(
            &ida.system().integrated().joined,
            network_ids.clone(),
        ),
        // N4′'s restart entries on the gated run only (judge-time work).
        n4_rtol: ask.f_tolerances.then_some(rtol),
        entries: Vec::new(),
        units: None,
    };
    // A reference's own cap (R1: S1's eventReference.maxStep_s) holds over
    // its whole run, as S2's R1.
    if let Some(h) = ask.max_step {
        ida.set_max_step(h).unwrap();
    }
    let mut driver = Driver::new(frame, Diagnostic::Jump, spine::z1::cpu_s, t0).unwrap();
    // Explicit matrix management (plan r4 baseline, lead 31 Oct: MR-1 retired
    // under R11-2a's N2 terms; it fails C2 at the last seat and costs more):
    // LD01_S3_MATRIX_REBUILD=stock runs stock IDAS matrix management,
    // =packet the packet's MR-1 section; unset is stock (the r4 baseline,
    // $SP/lanes/BASELINE-r4.md). The receipt's configuration records it.
    driver.matrix_rebuild = match std::env::var("LD01_S3_MATRIX_REBUILD").ok().as_deref() {
        None | Some("stock") => leitbild_operating_water::frame::MatrixRebuild::Stock,
        Some("packet") => leitbild_operating_water::frame::MatrixRebuild::Packet,
        Some(v) => panic!("LD01_S3_MATRIX_REBUILD={v}: stock or packet"),
    };
    // Decision 0015 E2: the 20 ms cap only inside the case's declared event
    // window, set by the driver at the restart that starts it (C4's hook)
    // and removed at the first chunk bound at or after its end.
    // RC-1: the case's declared fast electrical ramp, from the wiki's block.
    let ramp_block = ramp_cap_block().unwrap_or_else(|e| panic!("RC-1: {e}"));
    let ramp = declared_ramp(case, &ramp_block).unwrap_or_else(|e| panic!("RC-1: {e}"));
    let window_cap = window_cap(case, spec, ramp).filter(|_| ask.event_window);
    if let Some(w) = &window_cap {
        driver.restart_max_step = Some((w.start_cap(), w.starts));
    }
    let mut cap_intervals: Vec<Value> = Vec::new();
    // RC-1: the ramp's end hook is armed after the window's start, and its
    // end (the record's time, s after zero) once the hook has fired.
    let mut ramp_armed = false;
    let mut ramp_end: Option<f64> = None;
    // The cap observed: each chunk's last step against the cap in force at
    // its middle (RC-1's check that the cap holds only where declared).
    let mut cap_checks = (0u64, 0f64, 0f64);
    let max_step = ask.max_step;
    // C4 (C4 lane, r1): its own observation on the run (relief, PZR column,
    // the cells' departures, the acquired PT for rule A′), its ends, and
    // rule K's states 1 s after each phase change and at the declared end.
    if case == Case::C4 {
        assert_eq!(
            spec["windows"]["maxStep_s"].as_f64(),
            Some(WINDOW_MAX_STEP_S),
            "C4's window cap is S1's eventWindow.maxStep_s"
        );
    }
    let c4_observe = case == Case::C4 && ask.label == "run";
    let c4_classes = (case == Case::C4).then(|| {
        s3_harness::c4::Classes::from_block(&spec["volumeClasses"], &packet_json)
            .unwrap_or_else(|e| panic!("C4's volume classes: {e}"))
    });
    let c4_after_birth_s = spec["ends"]["firstBirthPlus_s"].as_f64();
    let c4_pt_setup = (case == Case::C4).then(|| c4_pt_setup(&inputs.ic_path, frame.period_s()));
    let c4_lift = o.pzr;
    if case == Case::C4 {
        assert!(
            labels[c4_lift].contains("relief"),
            "the PZR block's first coordinate is the relief lift: {}",
            labels[c4_lift]
        );
    }
    let mut c4 = C4Run::default();
    if cfg!(feature = "quadratures") && observer.gates.is_some() {
        let count = ida.system().quadrature_count();
        driver
            .start_quadratures(&mut ida, vec![0.; count])
            .unwrap_or_else(|e| panic!("the ledgers' quadratures: {e}"));
    }
    if let Some(c) = command {
        driver.command(zero, c).unwrap();
    }
    // E4/H1: the window ends with a restart from the accepted state (the
    // exact consistent start), then the cap is lifted (M1).
    if let Some(w) = &window_cap {
        driver
            .decide(vec![Change {
                due_s: zero + w.window_s,
                class: Class::R,
                kind: "H1 window-end restart (E4)".into(),
                action: Action::Held(Box::new(|_| Ok(()))),
            }])
            .unwrap();
    }
    // C5 (C5L): the same E4/H1 window-end restart at zero + window, its cap
    // set by the case at the offsite loss's restart (below).
    if c5
        && ask.event_window
        && let Some(w) = case_window(case, spec)
    {
        driver
            .decide(vec![Change {
                due_s: zero + w,
                class: Class::R,
                kind: "H1 window-end restart (E4)".into(),
                action: Action::Held(Box::new(|_| Ok(()))),
            }])
            .unwrap();
    }
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    // S3-D49: rule F's absolute classes at the start state (the run only).
    let f_tolerances = match (&observer.gates, ask.f_tolerances) {
        (Some(g), true) => Some(
            observe::signal_tolerances(g, ida.system_mut(), t0, &y, &yp, n, &atol)
                .unwrap_or_else(|e| panic!("rule F's classes: {e}")),
        ),
        _ => None,
    };
    observe::start_sample(&mut observer, ida.system_mut(), t0, &y, &yp);
    let preparation_cpu_s = spine::z1::cpu_s() - started;
    let run_started = spine::z1::cpu_s();
    let instructions0 = s3_harness::counters::instructions();
    let until = zero + span;
    // The run in chunks at every frame instant (the control client, class
    // S, stops there anyway, so the chunks add no stop): C3's operator
    // trip is scheduled at the first chunk after the reactor trip, and the
    // CPU is marked at every chunk for the cost spans.
    let window_s = case_window(case, spec).filter(|_| command.is_some() || c5);
    let mut bounds: Vec<f64> = vec![zero, until];
    if let Some(w) = window_s {
        bounds.push(zero + w);
    }
    // C1, C5: the stand-in's exchange intervals (D1, S3-D42) are chunk
    // bounds, as the C5 host stops at each exchange's t1. C5's block copies
    // the quiet interval; C1 reads it from the D1 block itself.
    let quiet_s = if c5 {
        spec["exchange"]["quietInterval_s"]
            .as_f64()
            .unwrap_or(f64::NAN)
    } else {
        exchange_quiet_s()
    };
    let exchanges: Vec<(f64, bool)> = if c5 {
        s3_harness::c5::exchange_bounds(t0, zero, window_s.unwrap_or(f64::NAN), until, quiet_s)
    } else if exchanging {
        // A connected unit, no grid event: quiet intervals to the end.
        s3_harness::c5::exchange_bounds(t0, until, 0., until, quiet_s)
    } else {
        Vec::new()
    };
    bounds.extend(exchanges.iter().map(|(b, _)| *b));
    let period = frame.period_s();
    let first = (t0 / period).floor() as i64 + 1;
    let last = (until / period).ceil() as i64;
    bounds.extend((first..=last).map(|k| k as f64 * period));
    bounds.retain(|b| *b > t0 && *b <= until);
    bounds.sort_by(f64::total_cmp);
    bounds.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let mut marks: Vec<s3_harness::families::Mark> = vec![(t0 - zero, 0., 0., 0., 0.)];
    let mut convergence: Vec<(f64, f64)> = vec![(t0 - zero, 0.)];
    let operator_trip = operator_trip_delay(case, spec).unwrap();
    let mut operator_trip_record = Value::Null;
    let mut declared_end_state: Option<(String, String, &'static str)> = None;
    // S3-D52: the last frame stop that rule I admits, kept while the window
    // runs, for a rule-I end before the window's end (A4 admits no state
    // after rule I's exit).
    let mut last_admitted: Option<FrameState> = None;
    // C5's exchange record: the decisions, the interval receipts, the feed
    // pumps' supply at each chunk bound and the supports after the loss.
    let carried = cfg!(feature = "quadratures") && observer.gates.is_some();
    let mut exchange_log: Vec<Value> = Vec::new();
    let mut receipts: Vec<s3_harness::c5::Receipt> = Vec::new();
    let mut q_prev: Option<Vec<f64>> = None;
    let mut last_exchange = t0;
    let mut feed_record: Vec<(f64, bool)> = Vec::new();
    let mut rcp_after: Option<usize> = None;
    let mut feed_after: Option<bool> = None;
    let outcome = {
        let mut r = {
            let mut clients: Vec<&mut dyn Client<CaseUnit>> =
                vec![&mut protection, &mut recorder, &mut control];
            if let Some(f) = field.as_mut() {
                clients.push(f);
            }
            driver.start(&mut clients, t0, &y, &yp)
        };
        let mut t = t0;
        // C5: the stand-in's boundary for the first interval, decided at
        // the unit's start (an energized bus agreeing with the held
        // prediction is no event).
        if exchanging && r.is_ok() {
            let t1 = exchanges.first().map_or(until, |e| e.0);
            r = energized_boundary(&mut driver, ida.system(), t0, t1, v_nominal, f_nominal)
                .map(|k| exchange_log.push(json!({"t_s": t0, "decided": k})));
        }
        for b in &bounds {
            if r.is_err() {
                break;
            }
            let operator_trip_now = if operator_trip_record.is_null() {
                operator_trip_at(&protection, operator_trip)
            } else {
                None
            };
            if let Some((trip, delay)) = operator_trip_now {
                let at = trip + delay;
                operator_trip_record = json!({"reactor_trip_cause_s": trip, "reactor_trip_after_zero_s": trip - zero,
                    "turbine_trip_s": at, "turbine_trip_after_zero_s": at - zero, "delay_s": delay,
                    "command": "TurbineTripAcquired (LD01.TG TRIP, as C2)"});
                r = driver.command(at, Command::TurbineTripAcquired);
            }
            if r.is_err() {
                break;
            }
            r = {
                let mut clients: Vec<&mut dyn Client<CaseUnit>> =
                    vec![&mut protection, &mut recorder, &mut control];
                if let Some(f) = field.as_mut() {
                    clients.push(f);
                }
                driver
                    .run_observed(
                        &mut ida,
                        t,
                        *b,
                        &mut y,
                        &mut yp,
                        &mut clients,
                        &setup,
                        Some(&mut observer),
                    )
                    .map(|_| ())
            };
            t = *b;
            let reached = if r.is_err() {
                driver.solver_reached_s
            } else {
                *b
            };
            // C4: every declared window (relief, reactor trip, each birth)
            // caps from its restart; each later window also ends with E4's
            // restart; the cap comes off at the first bound at or after the
            // last open window's end, and the hook stays armed.
            if case == Case::C4
                && let Some(w) = &window_cap
                && r.is_ok()
            {
                for start in s3_harness::c4::window_starts(&driver.log[c4.seen_windows..], zero) {
                    let until_w = start + w.window_s;
                    if c4.cap_until.is_none() {
                        cap_intervals.push(json!({"from_after_zero_s": start, "set_by": "the driver at the restart that starts the window (restart_max_step)"}));
                    }
                    if start > 1e-9 {
                        let decided = driver.decide(vec![Change {
                            due_s: zero + until_w,
                            class: Class::R,
                            kind: "H1 window-end restart (E4)".into(),
                            action: Action::Held(Box::new(|_| Ok(()))),
                        }]);
                        if let Err(e) = decided {
                            r = Err(e);
                        }
                    }
                    c4.cap_until = Some(c4.cap_until.map_or(until_w, |u| u.max(until_w)));
                }
                c4.seen_windows = driver.log.len();
                if let Some(u) = c4.cap_until
                    && *b - zero >= u - 1e-9
                {
                    if let Err(e) = ida.remove_max_step() {
                        r = Err(format!("removing the window's cap at {b} s: {e}"));
                    }
                    if let Some(last) = cap_intervals.last_mut() {
                        last["window_end_after_zero_s"] = json!(u);
                        last["removed_after_zero_s"] = json!(*b - zero);
                    }
                    c4.cap_until = None;
                }
            } else if let Some(w) = &window_cap
                && r.is_ok()
            {
                // The window's start disarms the hook (nothing later re-caps);
                // its end removes the cap.
                if driver.restart_max_step.is_some() && *b >= zero - 1e-9 && !ramp_armed {
                    driver.restart_max_step = None;
                    cap_intervals.push(json!({"from_s": zero, "from_after_zero_s": 0., "max_step_s": w.start_cap(),
                        "set_by": "the driver at the restart that starts the window (C4 hook 75dd4632c)"}));
                    if let Some(ramp) = &w.ramp {
                        // The ramp's end record sets the window's cap at its
                        // restart (the hook sees appended records, C5X RC-1).
                        driver.restart_max_step = Some((w.max_step_s, ramp.ends));
                        ramp_armed = true;
                    }
                }
                if ramp_armed && ramp_end.is_none() {
                    let opened = ida
                        .system()
                        .log
                        .iter()
                        .find(|(at, what)| *at >= zero - 1e-9 && what == "GCB Open")
                        .map(|(at, _)| *at);
                    if let Some(at) = opened {
                        driver.restart_max_step = None;
                        ramp_end = Some(at - zero);
                        if let Some(last) = cap_intervals.last_mut() {
                            last["ramp_end_s"] = json!(at);
                            last["ramp_end_after_zero_s"] = json!(at - zero);
                        }
                        cap_intervals.push(json!({"from_s": at, "from_after_zero_s": at - zero, "max_step_s": w.max_step_s,
                            "set_by": "the driver at the ramp's end record's restart (GCB Open; C5X RC-1 hook)"}));
                    }
                }
                if let Ok(st) = ida.stats()
                    && st.last_step > 0.
                    && let Some(cap) = cap_in_force(w, *b - zero - st.last_step / 2., ramp_end)
                {
                    cap_checks.0 += 1;
                    cap_checks.1 = cap_checks.1.max(st.last_step / cap);
                    if ramp_end.is_none_or(|e| *b - zero <= e + 1e-9) && w.ramp.is_some() {
                        cap_checks.2 = cap_checks.2.max(st.last_step);
                    }
                }
                if let Some(last) = cap_intervals.last_mut()
                    && last.get("removed_at_s").is_none()
                    && cap_removed_at(*b, zero, w.window_s)
                {
                    if let Err(e) = ida.remove_max_step() {
                        r = Err(format!("removing the window's cap at {b} s: {e}"));
                    }
                    last["removed_at_s"] = json!(*b);
                    last["removed_after_zero_s"] = json!(*b - zero);
                }
            }
            // Rule G: CPU and instructions with rule I counted (S3-D46;
            // in an ungated drive the observer is rule I alone) and without.
            let cpu_with = spine::z1::cpu_s() - run_started - ledger_quadrature_cpu_s(ida.system());
            let ins_with = match (&instructions0, s3_harness::counters::instructions()) {
                (Ok(a), Ok(b)) if observer.instructions_error.is_none() => {
                    b.saturating_sub(*a) as f64
                }
                _ => f64::NAN,
            };
            marks.push((
                reached - zero,
                cpu_with,
                ins_with,
                cpu_with - driver.cpu.gate_s,
                ins_with - observer.instructions as f64,
            ));
            let open_failures = ida
                .stats()
                .map_or(f64::NAN, |st| st.convergence_failures as f64);
            convergence.push((reached - zero, driver.totals[5] as f64 + open_failures));
            // C4: its observation, phase changes, rule K states and ends.
            if case == Case::C4 && r.is_ok() {
                let s0 = spine::z1::cpu_s();
                let classes = c4_classes.as_ref().unwrap();
                if c4_observe {
                    match c4_frame(
                        &mut ida,
                        n,
                        classes,
                        zero,
                        roof,
                        &scales,
                        &recorder.sg,
                        c4_lift,
                        *b,
                        &y,
                        &yp,
                    ) {
                        Ok((f, row)) => {
                            c4.frames.push(f);
                            c4.rows.push(row);
                        }
                        Err(e) => r = Err(e),
                    }
                    if let Some(setup) = &c4_pt_setup {
                        c4.pt
                            .push(c4_acquired(&protection, setup, frame.period_s(), *b, zero));
                    }
                }
                for e in &driver.log[c4.seen_changes..] {
                    let t = e["t_s"].as_f64().unwrap_or(f64::NAN);
                    for x in e["restart"]["transactions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        if x["owner"] != "phase modes" {
                            continue;
                        }
                        for ev in x["events"].as_array().into_iter().flatten() {
                            if let Some(cell) = ev["birth"].as_u64() {
                                c4.changes
                                    .push((t, format!("birth {}", classes.name(cell as usize))));
                                c4.first_birth.get_or_insert(t);
                            }
                            if let Some(cell) = ev["exhaustion"].as_u64() {
                                c4.changes.push((
                                    t,
                                    format!("exhaustion {}", classes.name(cell as usize)),
                                ));
                            }
                        }
                    }
                }
                c4.seen_changes = driver.log.len();
                // Rule K (S3-D52): the state 1 s after each phase change, at
                // the first frame bound at or after it (the run only).
                if let Some(path) = ask.window_state.as_ref() {
                    let due: Vec<(f64, String)> = c4.changes[c4.written..]
                        .iter()
                        .take_while(|(t, _)| *b >= t + 1. - 1e-9)
                        .cloned()
                        .collect();
                    if !due.is_empty() {
                        c4.written += due.len();
                        let file = format!("{path}.c4-phase-{}.json", c4.states.len() + 1);
                        let changes: Vec<Value> = due
                            .iter()
                            .map(|(t, what)| json!({"change": what, "at_after_zero_s": t - zero, "written_after_change_s": *b - t}))
                            .collect();
                        let from = format!(
                            "C4: 1 s after {} phase change(s), at the first frame bound at or after",
                            due.len()
                        );
                        let sha = c4_state(
                            &ida,
                            state,
                            &composition,
                            control.in_force_w,
                            *b,
                            &y,
                            &yp,
                            n,
                            &from,
                            &file,
                        );
                        c4.states.push(json!({"label": format!("1 s after {}", due.iter().map(|d| d.1.clone()).collect::<Vec<_>>().join(", ")),
                            "t_s": *b, "after_zero_s": *b - zero, "changes": changes, "path": file, "sha256": sha}));
                    }
                }
                c4.obs_s += spine::z1::cpu_s() - s0;
                // r1 `ends`: rule I's exit and the first birth + 120 s stop
                // the run there (labelled); the named refusals end it below.
                let rule_i_end = observer.rule_i.exit.as_ref().map(|x| {
                    json!({"end": "ruleI", "label": x["label"], "t_s": x["t_s"].as_f64().map(|t| t - zero), "stopped_after_zero_s": *b - zero})
                });
                if rule_i_end.is_some() {
                    c4.end = rule_i_end;
                    c4.stopped_at = Some(*b);
                    break;
                }
                let birth_stop = c4
                    .first_birth
                    .zip(c4_after_birth_s)
                    .map(|(fb, after)| fb + after);
                if birth_stop.is_some_and(|stop| c4_reached(*b, stop)) {
                    c4.end = Some(
                        json!({"end": "firstBirthPlus_s", "t_s": *b - zero, "first_birth_after_zero_s": c4.first_birth.map(|fb| fb - zero)}),
                    );
                    c4.stopped_at = Some(*b);
                    break;
                }
            }
            // C5's exchange after the mark: the offsite loss's restart
            // counts in the event window's span.
            if exchanging && r.is_ok() {
                let b = *b;
                let rel = b - zero;
                if let Some(s) = ida
                    .system()
                    .routing
                    .support("LD01.FW.P1")
                    .zip(ida.system().routing.support("LD01.FW.P2"))
                {
                    feed_record.push((rel, s.0.energized || s.1.energized));
                }
                // The exchange's receipt for the interval ending here (the
                // slice's quadratures, when the driver carries them).
                if let Some(k) = exchanges.iter().position(|(e, _)| same_instant(*e, b)) {
                    if carried {
                        match driver.quadratures_at(&ida, b) {
                            Ok(q1) => {
                                let off = q1.len()
                                    - leitbild_operating_plant::electrical::slice::QUADRATURES
                                        .len();
                                let q0 = q_prev.take().unwrap_or_else(|| vec![0.; q1.len()]);
                                receipts.push(s3_harness::c5::Receipt {
                                    from: last_exchange - zero,
                                    to: rel,
                                    export_j: q1[off] - q0[off],
                                    unit_draw_j: q1[off + 8] - q0[off + 8],
                                    reserve_draw_j: q1[off + 9] - q0[off + 9],
                                });
                                q_prev = Some(q1);
                            }
                            Err(e) => r = Err(format!("the exchange receipt at {b} s: {e}")),
                        }
                    }
                    last_exchange = b;
                    let next = exchanges.get(k + 1).map(|e| e.0);
                    if c5 && same_instant(b, zero) {
                        // The stand-in's dead bus (S3-D10), class R, applied
                        // now with the gate observation on both sides, then
                        // the plant's own event-window cap on the segment the
                        // restart opened (0015 E2, EW-1), as the C5 host does.
                        let loss = Change {
                            due_s: b,
                            class: Class::R,
                            kind: "Grid: bus dead (S3-D10 offsite loss)".into(),
                            action: Action::Held(Box::new(move |u: &mut CaseUnit| {
                                u.offsite_loss_s = Some(b);
                                Ok(())
                            })),
                        };
                        let q = if carried {
                            driver.quadratures_at(&ida, b).unwrap_or_default()
                        } else {
                            Vec::new()
                        };
                        let gate0 = spine::z1::cpu_s();
                        let mut step = driver.decide(vec![loss]).and_then(|()| {
                            observer.sample(ida.system_mut(), b, &y, &yp, &q, Side::BeforeRestart)
                        });
                        driver.cpu.gate_s += spine::z1::cpu_s() - gate0;
                        if step.is_ok() {
                            let mut clients: Vec<&mut dyn Client<CaseUnit>> =
                                vec![&mut protection, &mut recorder, &mut control];
                            if let Some(f) = field.as_mut() {
                                clients.push(f);
                            }
                            step =
                                driver.apply_due(&mut ida, &mut y, &mut yp, &mut clients, &setup);
                        }
                        if step.is_ok() {
                            let gate1 = spine::z1::cpu_s();
                            let q = if carried {
                                driver.quadratures_at(&ida, b).unwrap_or_default()
                            } else {
                                Vec::new()
                            };
                            step = observer.sample(
                                ida.system_mut(),
                                b,
                                &y,
                                &yp,
                                &q,
                                Side::AfterRestart,
                            );
                            driver.cpu.gate_s += spine::z1::cpu_s() - gate1;
                        }
                        if step.is_ok() && ask.event_window {
                            step = ida.set_max_step(WINDOW_MAX_STEP_S);
                            cap_intervals.push(json!({"from_s": b, "from_after_zero_s": 0., "max_step_s": WINDOW_MAX_STEP_S,
                                "set_by": "the case after the offsite loss's restart (Driver::apply_due, C5X hook 77d63b010), as the C5 host"}));
                        }
                        let net = &ida.system().integrated().joined.network;
                        rcp_after = Some(
                            (0..net.rotor_count())
                                .filter(|i| {
                                    matches!(
                                        net.rotor_state(*i).map(|s| s.support),
                                        Some(leitbild_operating_plant::rotor::Support::Supported(
                                            _
                                        ))
                                    )
                                })
                                .count(),
                        );
                        feed_after = ida
                            .system()
                            .routing
                            .support("LD01.FW.P1")
                            .zip(ida.system().routing.support("LD01.FW.P2"))
                            .map(|s| s.0.energized || s.1.energized);
                        exchange_log.push(json!({"t_s": b, "decided": "R: offsite loss (dead bus); event window cap in force"}));
                        if let Err(e) = step {
                            r = Err(e);
                        }
                    } else if (!c5 || b < zero)
                        && let Some(t1) = next
                    {
                        match energized_boundary(
                            &mut driver,
                            ida.system(),
                            b,
                            t1,
                            v_nominal,
                            f_nominal,
                        ) {
                            Ok(k) => exchange_log.push(json!({"t_s": b, "decided": k})),
                            Err(e) => r = Err(e),
                        }
                    }
                }
                // The plant window's end lifts the cap on the same history.
                if let Some(w) = window_s
                    && let Some(last) = cap_intervals.last_mut()
                    && last.get("removed_at_s").is_none()
                    && cap_removed_at(b, zero, w)
                {
                    if let Err(e) = ida.remove_max_step() {
                        r = Err(format!("removing the window's cap at {b} s: {e}"));
                    }
                    last["removed_at_s"] = json!(b);
                    last["removed_after_zero_s"] = json!(b - zero);
                }
            }
            // Rule K's post-event state (S3-D52): the declared part's end,
            // the window's end or rule I's end, whichever first, the
            // solver's own state at a frame stop, for SPECTRUM. A rule-I
            // exit inside the window takes the last frame stop rule I
            // admitted (A4 admits no state after its exit). C4's states are
            // its own: 1 s after each phase change and its declared end.
            if r.is_ok()
                && case != Case::C4
                && declared_end_state.is_none()
                && let (Some(w), Some(prefix)) = (window_s, ask.window_state.as_ref())
            {
                let write = |path: String,
                             (t_s, ys, yps, discrete, in_force_w): (
                    f64,
                    &[f64],
                    &[f64],
                    &Value,
                    f64,
                ),
                             from: String|
                 -> (String, String) {
                    let s = json!({"t_s": t_s, "packet": state["packet"], "packet_sha256": state["packet_sha256"],
                        "y": &ys[..n], "yp": &yps[..n],
                        "appended": {"owner": "electrical slice (ELEC)", "y": &ys[n..], "yp": &yps[n..]},
                        "discrete_state": discrete, "pzr_control": {"in_force_w": in_force_w},
                        "composition": composition["composition"], "from": from});
                    let bytes = serde_json::to_vec(&s).unwrap();
                    assert!(
                        !std::path::Path::new(&path).exists(),
                        "states are never overwritten"
                    );
                    std::fs::write(&path, &bytes).unwrap();
                    let sha = spine::sha256(&bytes);
                    (path, sha)
                };
                let exit_s = observer
                    .rule_i
                    .exit
                    .as_ref()
                    .and_then(|x| x["t_s"].as_f64());
                if let Some(x) = exit_s.filter(|x| *x <= zero + w + 1e-9) {
                    if let Some((ta, ya, ypa, da, wa)) = last_admitted.take() {
                        let (path, sha) = write(
                            format!("{prefix}-rule-i-end-state.json"),
                            (ta, ya.as_slice(), ypa.as_slice(), &da, wa),
                            format!(
                                "{} rule I end: the last frame stop rule I admits ({} s after zero), before its exit at {} s after zero (inside the {} s window)",
                                case.key(),
                                ta - zero,
                                x - zero,
                                w
                            ),
                        );
                        declared_end_state = Some((path, sha, "rule I end"));
                    }
                } else if (*b - (zero + w)).abs() < 1e-9 {
                    let snapshot = ida.system().system_discrete_state();
                    let (path, sha) = write(
                        format!("{prefix}-window-end-state.json"),
                        (
                            *b,
                            y.as_slice(),
                            yp.as_slice(),
                            &snapshot,
                            control.in_force_w,
                        ),
                        format!("{} window end ({} s after zero)", case.key(), w),
                    );
                    declared_end_state = Some((path, sha, "window end"));
                } else if *b < zero + w {
                    last_admitted = Some((
                        *b,
                        y.clone(),
                        yp.clone(),
                        ida.system().system_discrete_state(),
                        control.in_force_w,
                    ));
                }
            }
        }
        r
    };
    let run_cpu_s = spine::z1::cpu_s() - run_started;
    // The ledgers' quadrature integrands (the account at each converged
    // step) are rule D's instrument, not plant work.
    let ledger_cpu_s = ledger_quadrature_cpu_s(ida.system());
    driver.close_segment(&ida, until).unwrap();
    let mut failure = outcome.as_ref().err().cloned();
    // S3-D39's labelled end (C3): a run that stops while the PZR's resident
    // zone R drains to exhaustion within the step the solver attempts next
    // ends there, labelled, at its last accepted step (as S3-D17 for C4);
    // any other stop stays a failure.
    let mut labelled_end = Value::Null;
    if failure.is_some() && spec.get("labelledEnd").is_some() {
        let mut ys = vec![0.; y.len()];
        let mut yps = vec![0.; y.len()];
        let ended = ida.current_state(&mut ys, &mut yps);
        let stats = ida.stats();
        if let (Ok(t_last), Ok(s)) = (ended, stats) {
            let joined = &ida.system().integrated().joined;
            let i = joined.network.pzr.base
                + leitbild_operating_plant::network::stratified::RESIDENT_MASS;
            let scale = joined.scales()[i];
            let (m, rate) = (ys[i] * scale, yps[i] * scale);
            let exhausting = zone_r_exhausts_within(m, rate, s.current_step);
            labelled_end = json!({"declared": spec["labelledEnd"], "zone_r_mass_kg": m, "zone_r_rate_kg_s": rate,
                "next_step_s": s.current_step, "last_accepted_s": t_last, "last_accepted_after_zero_s": t_last - zero,
                "applies": exhausting, "refusal": failure});
            if exhausting {
                failure = None;
            }
        }
    }
    // C4 (r1 `ends`): the kernel's named refusals end the run, labelled, at
    // the last accepted step; rule K's state at the declared part's end.
    if case == Case::C4 {
        let mut ys = vec![0.; y.len()];
        let mut yps = vec![0.; y.len()];
        if let Some(fail) = failure.clone()
            && let Some(label) = s3_harness::c4::labelled_end(&fail)
        {
            let t_last = ida.current_state(&mut ys, &mut yps).ok();
            labelled_end = json!({"declared": spec["ends"][label], "end": label, "applies": true,
                "last_accepted_s": t_last, "last_accepted_after_zero_s": t_last.map(|t| t - zero), "refusal": fail});
            c4.end = Some(json!({"end": label, "t_s": t_last.map(|t| t - zero), "refusal": fail}));
            failure = None;
            if let (Some(path), Some(t)) = (ask.window_state.as_ref(), t_last) {
                let file = format!("{path}.c4-end.json");
                let sha = c4_state(
                    &ida,
                    state,
                    &composition,
                    control.in_force_w,
                    t,
                    &ys,
                    &yps,
                    n,
                    &format!("C4: the declared part's end ({label}), the last accepted step"),
                    &file,
                );
                c4.states.push(json!({"label": format!("declared end ({label})"), "t_s": t, "after_zero_s": t - zero, "path": file, "sha256": sha}));
            }
        } else if failure.is_none() {
            if c4.end.is_none() {
                c4.end = Some(json!({"end": "cap_s", "t_s": span}));
            }
            if let Some(path) = ask.window_state.as_ref() {
                let t = c4.stopped_at.unwrap_or(until);
                let file = format!("{path}.c4-end.json");
                let sha = c4_state(
                    &ida,
                    state,
                    &composition,
                    control.in_force_w,
                    t,
                    &y,
                    &yp,
                    n,
                    &format!(
                        "C4: the declared part's end ({})",
                        c4.end.as_ref().unwrap()["end"]
                    ),
                    &file,
                );
                c4.states.push(json!({"label": "declared end", "t_s": t, "after_zero_s": t - zero, "path": file, "sha256": sha}));
            }
        }
    }
    let p = &protection.protection;
    let divisions: Vec<Value> = p
        .divisions
        .iter()
        .map(|dv| json!({"supply": dv.supply, "powered": dv.powered,
            "causes": dv.causes.iter().map(|c| json!({"function": c.function, "t_s": c.at_s})).collect::<Vec<_>>(),
            "trip": dv.trip.as_ref().map(|c| json!({"function": c.function, "t_s": c.at_s})),
            "requests": dv.requests, "monitors": dv.monitors}))
        .collect();
    let end = if outcome.is_err() {
        driver.solver_reached_s
    } else {
        c4.stopped_at.unwrap_or(until)
    };
    let electrical_log = ida.system().log.clone();
    let mut tl = Timeline::from_logs(&driver.log, &divisions, p.holding.lost_at, zero, end)
        .unwrap()
        .with_electrical(&electrical_log, zero);
    tl.monitors_declared = section.monitors.iter().map(|m| m.id.clone()).collect();
    // Rule I, A4 (owner-approved, R5-A): the lines are judged on the
    // declared part, up to the D3 (a) or B1 phase-absence exit; the whole
    // run is judged again for information only.
    let domain = &observer.rule_i;
    let exit_after_zero = domain
        .exit
        .as_ref()
        .and_then(|x| x["t_s"].as_f64())
        .map(|x| x - zero);
    let declared_tl = exit_after_zero.map_or_else(|| tl.clone(), |x| tl.truncated(x));
    // C5's lines read the routing's own times, the interval receipts, the
    // supports after the loss, the field controller and the credited level
    // and PT1 (a gated run).
    let routing: Vec<(f64, String)> = ida
        .system()
        .routing
        .records
        .iter()
        .map(|x| (x.time - zero, x.what.clone()))
        .collect();
    let series_of = |key: &str| -> Vec<(f64, f64)> {
        observer.gates.as_ref().map_or_else(Vec::new, |g| {
            g.credited
                .output(key)
                .ok()
                .and_then(|o| o.first())
                .map_or_else(Vec::new, |x| {
                    g.credited
                        .t
                        .iter()
                        .map(|t| t - zero)
                        .zip(x.iter().copied())
                        .collect()
                })
        })
    };
    let (level, pt1) = (
        series_of(compare::key::PZR_LEVEL_M),
        series_of(compare::key::PZR_ROOF_PA),
    );
    let at_zero = |s: &[(f64, f64)]| {
        s.iter()
            .filter(|(t, _)| *t <= 1e-9)
            .map(|(_, v)| *v)
            .next_back()
    };
    let extreme = |s: &[(f64, f64)], max: bool| {
        s.iter()
            .filter(|(t, _)| *t > 1e-9)
            .copied()
            .reduce(|a, b| if (b.1 > a.1) == max { b } else { a })
    };
    let field_initiated = field.as_ref().and_then(|f| {
        f.protection
            .initiated
            .as_ref()
            .map(|i| (i.cause.to_string(), i.at_s))
    });
    let c5_judge = |timeline: &Timeline| {
        s3_harness::c5::judge(
            &spec["lines"],
            &s3_harness::c5::Record {
                tl: timeline,
                routing: &routing,
                receipts: &receipts,
                rcp_supported_after: rcp_after,
                feed_after,
                field_initiated: field_initiated.clone(),
                implemented: &implemented,
                clusters,
                level_at_zero: at_zero(&level),
                level_min_after: extreme(&level, false),
                pt1_at_zero: at_zero(&pt1),
                pt1_max_after: extreme(&pt1, true),
            },
            zero,
        )
    };
    let (judged, information) = if case == Case::C4 {
        // C4's own judges (s3_harness::c4) on its events and observation.
        let events = s3_harness::c4::Events::from_log(&driver.log, zero).unwrap();
        let joined = &ida.system().integrated().joined;
        let setup = c4_pt_setup.as_ref().unwrap();
        let classes = c4_classes.as_ref().unwrap();
        let l1_active = joined.network.unilateral().is_some();
        // O4′ (r2, S3-D57): the families' judge with the presence cache's
        // read set (`presence::pattern_cells`).
        let sides: Vec<&str> = (0..classes.names.len())
            .map(|c| classes.of(c).name())
            .collect();
        let read_set = leitbild_operating_plant::joined::presence::pattern_cells(joined);
        let o4 = s3_harness::families::first_classified_birth(
            &driver.log,
            zero,
            &sides,
            &classes.names,
            &read_set,
            l1_active,
        );
        // N4′ (r2, owner R7-Q, S3-D58, S3-D61): the pinned rule on the
        // restarts' entries (consistency in the integrator's own units, each
        // locking restart's drive tolerances at its own state).
        let n4 = d
            .pin()
            .and_then(|pin| n4_rule(&d.block, &pin))
            .map(|rule| s3_harness::families::chattering(&driver.log, &rule, &observer.entries))
            .ok();
        let run_c4 = s3_harness::c4::Run {
            end: end - zero,
            events: &events,
            classes,
            divisions: &divisions,
            holding_lost: p.holding.lost_at.map(|t| t - zero),
            operator_trip: operator_trip_record["turbine_trip_after_zero_s"].as_f64(),
            frames: &c4.frames,
            clusters,
            low_pa: setup.low_pa,
            high_pa: setup.high_pa,
            sg_crack_pa: packet_json["secondary"]["relief"]["crackPressure_Pa"]
                .as_f64()
                .expect("SG crack"),
            full_travel_s: spec["malfunctions"]["pzrRelief"]["fullTravel_s"]
                .as_f64()
                .expect("fullTravel_s"),
            birth_threshold_k: {
                use leitbild_operating_plant::network::Properties;
                joined
                    .network
                    .properties()
                    .metastable_band()
                    .expect("band")
                    .credited_max_k
            },
            l1_active,
            pt: &c4.pt,
            low_frames: setup.low_frames,
            high_frames: setup.high_frames,
            o4: Some(&o4),
            n4: n4.as_ref(),
        };
        let judged = if c4_observe {
            s3_harness::c4::judge(&spec["lines"], &run_c4, zero)
        } else {
            vec![
                json!({"id": "C4", "verdict": "not judged", "reason": "C4's lines are judged on the run only"}),
            ]
        };
        let per_cell: serde_json::Map<String, Value> = {
            let mut cells: std::collections::BTreeMap<String, Vec<Value>> =
                std::collections::BTreeMap::new();
            for (tb, c, _, _) in &events.births {
                let next = events
                    .exhaustions
                    .iter()
                    .find(|(te, x)| x == c && *te >= *tb)
                    .map(|e| e.0);
                cells.entry(run_c4.classes.name(*c)).or_default().push(
                    json!({"birth_s": tb, "exhaustion_s": next, "lifetime_s": next.map(|e| e - tb)}),
                );
            }
            cells.into_iter().map(|(k, v)| (k, json!(v))).collect()
        };
        c4.summary = json!({"end": c4.end, "events": {
                "births": events.births.iter().map(|(t, c, k, r)| json!({"t_s": t, "cell": run_c4.classes.name(*c),
                    "side": run_c4.classes.of(*c).name(), "class": k, "presence_changed": r["presence_changed"],
                    "modes_changed": r["modes_changed"]})).collect::<Vec<_>>(),
                "exhaustions": events.exhaustions.iter().map(|(t, c)| json!([t, run_c4.classes.name(*c)])).collect::<Vec<_>>(),
                "per_cell": per_cell, "l1_changes": events.l1.len(), "chattering": events.chattering(),
                "sg_relief": events.sg_relief.iter().map(|(t, v, th, d)| json!([t, v, th, d])).collect::<Vec<_>>(),
                "relief": events.relief.iter().map(|(t, x)| json!([t, x])).collect::<Vec<_>>()},
            "rule_k_states": c4.states, "observation_cpu_s": c4.obs_s,
            "pt_setup": {"channels": setup.ids, "max_age_frames": setup.max_age_frames, "low_frames": setup.low_frames, "high_frames": setup.high_frames},
            "frames": c4.rows});
        (judged, None)
    } else {
        let judged = if c5 {
            c5_judge(&declared_tl)
        } else {
            lines::judge(case, &spec["lines"], &declared_tl, &implemented, clusters)
        };
        let information = exit_after_zero.map(|_| {
            if c5 {
                c5_judge(&tl)
            } else {
                lines::judge(case, &spec["lines"], &tl, &implemented, clusters)
            }
        });
        (judged, information)
    };
    let totals: serde_json::Map<String, Value> = COUNTER_NAMES
        .iter()
        .zip(driver.totals)
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let simulated = end - t0;
    let mut end_fp = observe::Fingerprint::default();
    end_fp.fold(&[end]);
    end_fp.fold(&y);
    end_fp.fold(&yp);
    let instants_bytes = serde_json::to_vec(&driver.log).unwrap();
    let repeat_record = json!({"fingerprint": observer.gates.as_ref().map(|g| g.fingerprint.hex()),
        "samples": observer.gates.as_ref().map(|g| g.samples), "end_state_fingerprint": end_fp.hex(),
        "instants": {"count": driver.log.len(), "sha256": spine::sha256(&instants_bytes)},
        "counts_by_class": driver.counts.json()});
    // MR-1 (R7-P): the handle's counts and the packet's section, for the receipt.
    let rebuild_counts = ida.rebuild();
    let rebuild_section = ida.system().integrated().joined.matrix_rebuild().map(|m| json!({"rebuildEverySteps": m.rebuild_every_steps, "appliesFrom": m.applies_from, "decision": m.decision}));
    let record = json!({
        "label": ask.label,
        "failure": failure,
        "failure_at": failure.as_ref().map(|_| json!({
            "refusal_s": driver.attempt_s, "refusal_after_zero_s": driver.attempt_s.map(|a| a - zero),
            "solver_reached_s": driver.solver_reached_s, "solver_reached_after_zero_s": driver.solver_reached_s - zero,
            "last_logged_s": driver.log.last().and_then(|e| e["t_s"].as_f64()),
            "note": "refusal_s is the driver's last attempted discrete instant; a failure inside a step is at or after solver_reached_s"})),
        "start_state": {"path": state_path, "sha256": provenance::sha256_file(state_path).ok(), "t_s": t0},
        "composition": composition,
        "ic_section": {"path": inputs.ic_path, "implemented_causes": implemented},
        "configuration": {"span_after_zero_s": span, "zero_after_start_s": zero_after,
            "weights": ida.weight_rule_kind(),
            "command": command.map(|c| format!("{c:?}")), "frame_s": frame.period_s(),
            "max_order": s3_unit::MAX_ORDER, "max_step_s": max_step,
            "matrix_rebuild": {"rule": "MR-1 (owner, request 7 R7-P): stock IDAS check points every `steps` steps force an iteration-matrix setup; freed at restarts and above `held`",
                "source": format!("{:?}", driver.matrix_rebuild),
                "packet_section": rebuild_section,
                "held_max": leitbild_operating_water::frame::MATRIX_REBUILD_HELD,
                "counts": {"steps": rebuild_counts.steps, "held": rebuild_counts.held, "most_held": rebuild_counts.most_held, "drops": rebuild_counts.drops}},
            "window_cap": window_cap.as_ref().map(|w| json!({"max_step_s": w.max_step_s, "window_s": w.window_s,
                "ramp": w.ramp.as_ref().map(|r| json!({"max_step_s": r.max_step_s, "declared": r.declared,
                    "value": format!("{RAMP_CAP_FENCE}.rampMaxStep_s ({DECISION_0015})"),
                    "block_sha256": spine::sha256(ramp_block.to_string().as_bytes()), "end_after_zero_s": ramp_end})),
                "observed": {"chunk_steps_checked": cap_checks.0, "max_last_step_over_cap": cap_checks.1, "max_last_step_in_ramp_s": cap_checks.2},
                "rule": "0015 E2: the cap only inside the declared window, set at the restart that starts it, removed at the first chunk bound at or after its end",
                "intervals": cap_intervals})),
            "c5_window_cap": if c5 { json!({"max_step_s": WINDOW_MAX_STEP_S, "window_s": window_s,
                "rule": "0015 E2 (EW-1): the cap from the offsite loss's restart, removed at the first chunk bound at or after its window's end",
                "intervals": cap_intervals}) } else { Value::Null },
            "tolerance_scaling": {"relative": ask.scaling.relative, "absolute": ask.scaling.absolute},
            "derived_tolerances": derived, "relative_tolerance": rtol,
            "integration": if cfg!(feature = "quadratures") { "frame driver: stock IDAS IDA_ONE_STEP (ledgers as quadratures, IDASetQuadErrCon false), observation from IDAGetDky, restarts by discrete_restart" } else { "frame driver: stock IDA_ONE_STEP, observation from IDAGetDky, restarts by discrete_restart" }},
        "lines": judged,
        "rule_i": {"evaluated_at": "every accepted stock step (B1: on accepted states), at the solver's state there",
            "samples": domain.samples, "stock_steps": driver.totals[0],
            "note": "samples = stock steps less located-root returns and steps a late change rolled back", "first_extended_s": domain.first_extended, "margin_failures": domain.margin_failures,
            "exit": domain.exit, "exit_after_zero_s": exit_after_zero, "information_from_s": exit_after_zero,
            "verdict_fingerprint": domain.verdicts.hex(), "reuse": {"reused": domain.reused, "crosscheck": domain.crosscheck, "crosschecked": domain.crosschecked,
                "mismatches": domain.mismatches, "first_mismatch": domain.first_mismatch},
            "hot_standby_margins": domain.hot_standby},
        "algebraic_residuals": observer.residuals.json(),
        "restart_entries": {"rule": "N4′ (S3-D58, S3-D61): each restart's pre-transaction projection correction of the algebraic rows in the integrator's own units (rtol |y| + atol, atol as stock IDA uses it, from its error weights); with a free vapour path, each free vapour path's drive tolerance by rule F's a_x construction at that state (judge-time cost, not plant work)",
            "judge_cpu_s": observer.entries.iter().filter_map(|e| e["drives"]["judge_cpu_s"].as_f64()).sum::<f64>(),
            "entries": observer.entries},
        "operator_turbine_trip": operator_trip_record,
        "exchange": if exchanging { json!({"stand_in": if c5 { "the test-only Grid stand-in's C5 plan (C5X ld01-grid-standin.ts boundaries() under D1 with S3-D42's connected-only window; no frequency event), reproduced in-process: the same interval ends and the same boundary decisions as the C5 host (Driver::decide at each exchange), not over the child-process pipe (R5-F4: no live Grid)" } else { "C1 (C5L): the test-only Grid stand-in's plan for a connected unit on its steady 50 Hz bus (D1 quiet intervals from the ld01-electrical-exchange block, no grid event, S3-D42), in-process as C5's: Driver::decide at each exchange, receipts from the slice's quadratures (R5-F4: no live Grid)" },
            "quiet_interval_s": quiet_s,
            "intervals": exchanges.len(), "decisions": exchange_log,
            "receipts": receipts.iter().map(|q| json!([q.from, q.to, q.export_j, q.unit_draw_j, q.reserve_draw_j])).collect::<Vec<_>>(),
            "receipt_columns": ["from_after_zero_s", "to_after_zero_s", "export_J", "unit_draw_J", "reserve_draw_J"],
            "receipts_sum_export_J": receipts.iter().map(|q| q.export_j).sum::<f64>(),
            "cumulative_export_J": q_prev.as_ref().map(|q| q[q.len() - leitbild_operating_plant::electrical::slice::QUADRATURES.len()]),
            "rcp_supported_after_loss": rcp_after, "feed_supplied_after_loss": feed_after,
            "feed_supplied": feed_record.iter().map(|(t, f)| json!([t, f])).collect::<Vec<_>>(),
            "routing_records": routing.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>(),
            "field_controller": field.as_ref().map(|f| json!({"initiated": f.protection.initiated.as_ref().map(|i| json!({"cause": i.cause, "frame": i.frame, "t_s": i.at_s, "t_after_zero_s": i.at_s - zero})), "log": f.protection.log}))}) } else { Value::Null },
        "labelled_end": labelled_end,
        "c4": if case == Case::C4 { c4.summary.clone() } else { Value::Null },
        "information": information.map(|l| json!({"note": "INFORMATION ONLY (past the rule-I exit): every line over the whole run", "lines": l})),
        "timeline": {"zero_s": zero, "end_s": tl.end, "holding_lost_s": tl.holding_lost, "stop_ramp_end_s": tl.stop_ramp_end,
            "seats": tl.seats.len(), "last_seat_s": tl.seats.iter().map(|(_, t)| *t).fold(f64::NEG_INFINITY, f64::max),
            "sg_relief": tl.sg_relief.iter().map(|(v, th, d, t)| json!([v, th, d, t])).collect::<Vec<_>>(),
            "pzr_relief_openings": tl.pzr_relief_openings,
            "causes": tl.causes.iter().map(|c| json!([c.division, c.function, c.t])).collect::<Vec<_>>(),
            "electrical": tl.electrical.as_ref().map(|l| l.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>())},
        "pzr_control": {"changes": control.schedule.len().saturating_sub(1), "final_request_w": control.in_force_w},
        "protection_log": p.log, "divisions": divisions,
        "counts_by_class": driver.counts.json(), "stock_totals": totals, "segments": driver.segments,
        "instants": driver.log,
        "observation_class_o": driver.observation_json(),
        "cpu": {"preparation_s": preparation_cpu_s, "run_s": run_cpu_s, "solver_s": driver.cpu.solver_s,
            "observation_s": driver.cpu.observation_s, "restart_s": driver.cpu.restart_s, "held_s": driver.cpu.held_s,
            "gate_observation_s": driver.cpu.gate_s, "ledger_quadrature_s": ledger_cpu_s,
            "instructions": {"run_with_observer": marks.last().map(|m| m.2), "observer": observer.instructions, "error": observer.instructions_error,
                "note": "the process's instructions retired over the run; the observer's own calls (rule I alone in an ungated drive) reported apart; the cost family reads an ungated drive"},
            "recurring_s": run_cpu_s - driver.cpu.gate_s - ledger_cpu_s,
            "worst_step": {"cpu_s": driver.cpu.worst_step.0, "reached_s": driver.cpu.worst_step.1},
            "run_per_simulated_s": if simulated > 0. { json!(run_cpu_s / simulated) } else { Value::Null },
            "recurring_per_simulated_s": if simulated > 0. { json!((run_cpu_s - driver.cpu.gate_s - ledger_cpu_s) / simulated) } else { Value::Null },
            "restarts_r": driver.counts.total(Class::R), "s_instants": driver.counts.total(Class::S),
            "label": s3_harness::families::PROVISIONAL},
        "frames": recorder.rows,
        "ou_frame_instructions": recorder.cost.as_ref().map(|c| c.iter().map(|(t, i)| json!([t, i])).collect::<Vec<_>>()),
        "perf_profile": recorder.profile.as_ref().map(|p| json!({
            "rule": "HOOK (PERF E-PROF): per frame [t, counter reads so far, per path [closed calls, exclusive instructions] so far]; paths in key order, pieces>* inclusive outside the tree",
            "paths": leitbild_operating_plant::cost::snapshot().map(|s| s.paths),
            "read_instructions": perf_read_instructions(),
            "frames": p.iter().map(|(t, r, v)| json!([t, r, v])).collect::<Vec<_>>()})),
        "repeat_record": repeat_record,
    });
    eprintln!(
        "{} [{}]: R {} S {}; run CPU {run_cpu_s:.2} s (gate obs {:.2}) over {simulated:.2} s; failure {failure:?}; rule I exit {exit_after_zero:?}",
        case.key(),
        ask.label,
        driver.counts.total(Class::R),
        driver.counts.total(Class::S),
        driver.cpu.gate_s,
    );
    // Seats by cluster index (the rods' layout labels), as S2's runner.
    let cluster_index: std::collections::BTreeMap<String, usize> = ida
        .system()
        .integrated()
        .joined
        .layouts()
        .iter()
        .find(|(o, _)| *o == "rods")
        .map(|(_, l)| {
            l.labels
                .iter()
                .filter_map(|x| {
                    x.strip_prefix("y[")
                        .map(|v| v.trim_end_matches(']').to_string())
                })
                .enumerate()
                .map(|(i, id)| (id, i))
                .collect()
        })
        .unwrap_or_default();
    let seats = first_seats(&tl.seats, &cluster_index, zero);
    let reactor_trip_after_zero = protection
        .protection
        .divisions
        .iter()
        .filter_map(|d| d.trip.as_ref().map(|c| c.at_s - zero))
        .reduce(f64::min);
    let entries = observer.entries.clone();
    Driven {
        record,
        observer,
        zero,
        exit_after_zero,
        failure,
        marks,
        convergence,
        seats,
        reactor_trip_after_zero,
        f_tolerances,
        rtol,
        entries,
        instants: driver
            .log
            .iter()
            .filter_map(|e| e["t_s"].as_f64())
            .chain(driver.donor_flips.events.iter().map(|(t, _)| *t))
            .collect(),
        donor_flips: driver.donor_flips.total(),
        gcb_open_after_zero: tl
            .electrical
            .as_ref()
            .and_then(|l| l.iter().find(|(_, w)| w == "GCB Open").map(|(t, _)| *t)),
        sg_relief: tl
            .sg_relief
            .iter()
            .filter_map(|(v, th, d, t)| {
                s3_harness::timeline::relief_sg(v).map(|sg| (sg.to_string(), th.clone(), *d, *t))
            })
            .collect(),
        repeat_record,
        declared_end_state,
        end_after_zero: end - zero,
        c4_states: c4.states,
        first_birth_after_zero: c4.first_birth.map(|t| t - zero),
    }
}

/// Each cluster's first seat by cluster index, absolute (S2's G9 and rule
/// E's rod timing): a body that lifts off and seats again (C4, after the
/// hot births) keeps its first seat time. `seats` is the timeline's, in log
/// order, on the case clock.
fn first_seats(
    seats: &[(String, f64)],
    cluster_index: &std::collections::BTreeMap<String, usize>,
    zero: f64,
) -> std::collections::BTreeMap<usize, f64> {
    let mut out = std::collections::BTreeMap::new();
    for (c, t) in seats {
        if let Some(i) = cluster_index.get(c) {
            out.entry(*i).or_insert(zero + *t);
        }
    }
    out
}

#[test]
fn a_reseated_body_keeps_its_first_seat_time() {
    let index: std::collections::BTreeMap<String, usize> = [
        ("LD01.CR.001".to_string(), 0),
        ("LD01.CR.002".to_string(), 1),
    ]
    .into();
    let seats = vec![
        ("LD01.CR.001".to_string(), 22.1),
        ("LD01.CR.002".to_string(), 22.2),
        ("LD01.CR.001".to_string(), 40.03),
        ("LD01.CR.999".to_string(), 1.),
    ];
    let first = first_seats(&seats, &index, 548.);
    assert_eq!(first.len(), 2);
    assert!((first[&0] - 570.1).abs() < 1e-9 && (first[&1] - 570.2).abs() < 1e-9);
}

/// A frame bound `b` at or after the instant `t` (absolute s), at the
/// case clock's resolution: C4's labelled end "first birth + 120 s" stops
/// the drive at the first such bound (r1 `ends`).
fn c4_reached(b: f64, t: f64) -> bool {
    b >= t - 1e-9
}

/// C4's run state in a drive (C4 lane).
#[derive(Default)]
struct C4Run {
    frames: Vec<s3_harness::c4::Frame>,
    rows: Vec<Value>,
    pt: Vec<s3_harness::c4::Acquired>,
    obs_s: f64,
    first_birth: Option<f64>,
    end: Option<Value>,
    stopped_at: Option<f64>,
    seen_windows: usize,
    seen_changes: usize,
    cap_until: Option<f64>,
    changes: Vec<(f64, String)>,
    written: usize,
    states: Vec<Value>,
    summary: Value,
}

/// The acquired PZR PT family and the voted pressure functions, from the
/// compiled `ic` section (rule A′ and C4's margins).
struct C4PtSetup {
    ids: Vec<String>,
    max_age_frames: u64,
    low_pa: f64,
    high_pa: f64,
    low_frames: usize,
    high_frames: usize,
}

fn c4_pt_setup(ic_path: &str, frame_s: f64) -> C4PtSetup {
    let section: Value =
        serde_json::from_slice(&std::fs::read(ic_path).expect("ic section")).expect("ic json");
    let family = section["families"]
        .as_array()
        .and_then(|f| f.iter().find(|x| x["id"] == "LD01.PZR.PT"))
        .expect("the ic section's LD01.PZR.PT family");
    let frames_of = |s: f64| (s / frame_s).round() as u64;
    let voted = |function: &str| -> (f64, usize) {
        let rule = section["functions"]
            .as_array()
            .and_then(|f| f.iter().find(|x| x["id"] == function))
            .map(|x| x["rule"]["voted"].clone())
            .unwrap_or_else(|| panic!("the ic section declares no {function}"));
        let setpoint = rule["side"]["at_or_below"]
            .as_f64()
            .or(rule["side"]["at_or_above"].as_f64())
            .unwrap_or_else(|| panic!("{function} declares no setpoint"));
        let q = rule["qualification_s"]
            .as_f64()
            .unwrap_or_else(|| panic!("{function} declares no qualification"));
        (setpoint, frames_of(q) as usize)
    };
    let (low_pa, low_frames) = voted("LD01.PROT.PZR.LOW_PRESSURE");
    let (high_pa, high_frames) = voted("LD01.PROT.PZR.HIGH_PRESSURE");
    C4PtSetup {
        ids: family["channels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_string())
            .collect(),
        max_age_frames: frames_of(family["maximum_age_s"].as_f64().expect("maximum_age_s")),
        low_pa,
        high_pa,
        low_frames,
        high_frames,
    }
}

/// The delivered PT samples the divisions' decision at frame `k + 1` votes
/// on, after frame `k` (the bound `b`) was processed.
fn c4_acquired(
    protection: &leitbild_operating_water::ic::ProtectionClient,
    setup: &C4PtSetup,
    frame_s: f64,
    b: f64,
    zero: f64,
) -> s3_harness::c4::Acquired {
    use leitbild_operating_plant::ic::acquisition::Quality;
    let k = (b / frame_s).round() as u64;
    let delivered = protection.protection.delivered();
    s3_harness::c4::Acquired {
        t: (k + 1) as f64 * frame_s - zero,
        channels: setup
            .ids
            .iter()
            .map(|id| {
                delivered
                    .iter()
                    .find(|(c, _)| c == id)
                    .and_then(|(_, s)| *s)
                    .and_then(|(at, q)| match q {
                        Quality::Value(v) if k + 1 - at <= setup.max_age_frames => Some(v),
                        _ => None,
                    })
            })
            .collect(),
    }
}

/// C4's frame record at the bound `t`: the roof and SG pressures, the
/// relief's lift and flow, the PZR column, each core region's departure and
/// vapour (B1's reading) and the hot-side or two-phase cells.
#[allow(clippy::too_many_arguments)] // One observation: handle, layout, state.
fn c4_frame(
    ida: &mut leitbild_operating_water::ida::Ida<CaseUnit>,
    n: usize,
    classes: &s3_harness::c4::Classes,
    zero: f64,
    roof: usize,
    scales: &[f64],
    sg: &[(String, usize, f64)],
    lift: usize,
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Result<(s3_harness::c4::Frame, Value), String> {
    use leitbild_operating_plant::network::CellMode;
    use leitbild_operating_water::joined::JoinedSystem;
    let joined = &mut ida.system_mut().integrated_mut().joined;
    joined
        .evaluate(t, &y[..n], &yp[..n], None, 0., None)
        .map_err(|e| format!("C4 frame at {t} s: {e:?}"))?;
    let phase = joined
        .region_phases()
        .map_err(|e| format!("C4 region phases at {t} s: {e:?}"))?;
    let nuclear = joined.offsets().nuclear;
    let net = &joined.network;
    let ev = net.pzr_evaluation().ok_or("no PZR evaluation")?;
    let relief = ev
        .flows
        .relief
        .as_ref()
        .map_or(0., |r| r.vapor_kg_s.value + r.drop_kg_s.value);
    let mut cells = Vec::new();
    for (c, m) in net.cell_modes().iter().enumerate() {
        if *m == CellMode::Equilibrium {
            let (mg, ml) = net
                .equilibrium_masses(c, &y[..nuclear])
                .map_err(|e| format!("{e:?}"))?;
            cells.push(json!([classes.name(c), "E", mg, ml]));
        } else if classes.of(c) == s3_harness::c4::Side::Hot {
            let d = net
                .liquid_departure(c, &y[..nuclear])
                .map_err(|e| format!("{e:?}"))?;
            cells.push(json!([classes.name(c), "L", d]));
        }
    }
    let f = s3_harness::c4::Frame {
        t: t - zero,
        roof_pa: y[roof] * scales[roof],
        sg_pa: sg.iter().map(|(_, i, s)| y[*i] * s).collect(),
        lift: y[lift] * scales[lift],
        relief_kg_s: relief,
        core_departure_k: phase.iter().map(|r| r.saturation_departure_k).collect(),
        core_vapor_kg: phase.iter().map(|r| r.vapor_kg).collect(),
    };
    let col = &ev.column;
    let row = json!({"t_s": f.t, "pzr_roof_pa": f.roof_pa, "sg_pressure_pa": f.sg_pa, "relief_lift": f.lift,
        "relief_kg_s": relief, "pzr_collapsed_m": col.collapsed_elevation.value, "pzr_mixture_m": col.mixture_elevation.value,
        "pzr_vapor_zone_kg": col.vapor.mass.value,
        "core_departure_k_max": f.core_departure_k.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        "core_vapor_kg": f.core_vapor_kg.iter().sum::<f64>(), "cells": cells});
    Ok((f, row))
}

/// A C4 state for rule K (SPECTRUM's Z6), in the window-end state's form;
/// returns its sha256. States are never overwritten.
#[allow(clippy::too_many_arguments)] // One state: handle, provenance, coordinates.
fn c4_state(
    ida: &leitbild_operating_water::ida::Ida<CaseUnit>,
    state: &Value,
    composition: &Value,
    in_force_w: f64,
    t: f64,
    y: &[f64],
    yp: &[f64],
    n: usize,
    from: &str,
    path: &str,
) -> String {
    use leitbild_operating_water::joined::JoinedSystem;
    let snapshot = ida.system().system_discrete_state();
    let s = json!({"t_s": t, "packet": state["packet"], "packet_sha256": state["packet_sha256"],
        "y": &y[..n], "yp": &yp[..n],
        "appended": {"owner": "electrical slice (ELEC)", "y": &y[n..], "yp": &yp[n..]},
        "discrete_state": snapshot, "pzr_control": {"in_force_w": in_force_w},
        "composition": composition["composition"], "from": from});
    let bytes = serde_json::to_vec(&s).unwrap();
    assert!(
        !std::path::Path::new(path).exists(),
        "states are never overwritten"
    );
    std::fs::write(path, &bytes).unwrap();
    spine::sha256(&bytes)
}

/// The CPU the IDAS ledgers' integrands took (zero without them).
#[cfg(feature = "quadratures")]
fn ledger_quadrature_cpu_s(unit: &CaseUnit) -> f64 {
    unit.inner.counters.cpu_s
}
#[cfg(not(feature = "quadratures"))]
fn ledger_quadrature_cpu_s(_: &CaseUnit) -> f64 {
    0.
}

/// C5's rule B: the block's directions on the gated run's samples (the
/// credited outputs at the 2 ms observation, rotors at the 0.1 s output
/// grid), with the feed pumps' supply and the interval receipts the run
/// recorded. T_hot is the block's declared core-outlet signal: the mean of
/// the upper core cells (`CORE.*.2`) among the credited core cells.
fn c5_directions(
    spec: &Value,
    og: &observe::Gates,
    network: &leitbild_operating_plant::network::packet::Packet,
    run: &Driven,
) -> Value {
    use s3_harness::c5::{Receipt, Series};
    let zero = run.zero;
    let t: Vec<f64> = og.credited.t.iter().map(|x| x - zero).collect();
    let instances = |key: &str| -> Vec<Series> {
        og.credited.output(key).map_or_else(
            |_| Vec::new(),
            |o| {
                o.iter()
                    .map(|x| t.iter().copied().zip(x.iter().copied()).collect())
                    .collect()
            },
        )
    };
    let core_ids: Vec<&str> = network
        .mechanics
        .regions
        .iter()
        .map(|r| r.id.as_str())
        .filter(|id| id.starts_with("CORE."))
        .collect();
    let core = instances(compare::key::CORE_CELL_K);
    let upper: Vec<usize> = core_ids
        .iter()
        .take(core.len())
        .enumerate()
        .filter(|(_, id)| id.ends_with(".2"))
        .map(|(k, _)| k)
        .collect();
    let t_hot: Series = if upper.is_empty() {
        Vec::new()
    } else {
        (0..t.len())
            .map(|j| {
                (
                    t[j],
                    upper.iter().map(|k| core[*k][j].1).sum::<f64>() / upper.len() as f64,
                )
            })
            .collect()
    };
    let rotors: Vec<Series> = {
        let n = og.rotors.first().map_or(0, |(_, m)| m.len());
        (0..n)
            .map(|r| og.rotors.iter().map(|(tt, m)| (tt - zero, m[r])).collect())
            .collect()
    };
    let signals: Vec<(&str, Vec<Series>)> = vec![
        ("RCP speeds", rotors),
        ("loop flows", instances(compare::key::LOOP_FLOW_KG_S)),
        ("core power", instances(compare::key::CORE_POWER_W)),
        ("T_hot", vec![t_hot]),
        ("T_avg", instances(compare::key::AVERAGE_COOLANT_K)),
        ("PZR pressure", instances(compare::key::PZR_ROOF_PA)),
        ("PZR level", instances(compare::key::PZR_LEVEL_M)),
        ("SG pressure", instances(compare::key::SG_PRESSURE_PA)),
    ];
    let x = &run.record["exchange"];
    let feed: Vec<(f64, bool)> = x["feed_supplied"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| Some((e[0].as_f64()?, e[1].as_bool()?)))
        .collect();
    let receipts: Vec<Receipt> = x["receipts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            Some(Receipt {
                from: e[0].as_f64()?,
                to: e[1].as_f64()?,
                export_j: e[2].as_f64()?,
                unit_draw_j: e[3].as_f64()?,
                reserve_draw_j: e[4].as_f64()?,
            })
        })
        .collect();
    let mut b = s3_harness::c5::directions(
        spec,
        &signals,
        run.record["timeline"]["holding_lost_s"].as_f64(),
        case_window(Case::C5, spec).unwrap_or(f64::NAN),
        &feed,
        &receipts,
    );
    b["t_hot_cells"] = json!(upper.iter().map(|k| core_ids[*k]).collect::<Vec<_>>());
    b
}

/// Rule D on a run's observation: S2's identities and IDAS ledgers (heater,
/// PZR relief and exterior loss, SG feed/steam/relief, motor work, event
/// energy among them) and the ELEC slice's energy ledger (turbine and shaft
/// work, generator terminal energy, field and copper losses, the Grid's
/// signed export) in the S2 bound's local tolerance units.
fn conservation_family(g: &observe::Gates, units_bound: f64) -> Value {
    let Some(c) = g.conservation.as_ref() else {
        return json!({"family": "D conservation", "verdict": "not executable",
            "reason": "stock IDA without quadratures: the ledgers need the IDAS build (feature quadratures)"});
    };
    let identities = c.identities_json();
    let mut ledger = c.ledger_json();
    // The over-time rows are the receipt's bulk; the worst closures stay.
    if let Some(o) = ledger.as_object_mut() {
        o.remove("over_time");
    }
    let slice_pass = g.slice.worst_units >= 0. && g.slice.worst_units <= units_bound;
    // Every named receipt at the last closure: heater Joule, PZR relief and
    // exterior loss, SG feed/steam/relief, motor work, event energy, and the
    // slice's aero work, export (the Grid's signed receipt), losses and the
    // auxiliary draws.
    let names: Vec<String> = g
        .plan
        .ledger_names()
        .into_iter()
        .chain(
            leitbild_operating_plant::electrical::slice::QUADRATURES
                .iter()
                .map(|k| format!("slice.{k}_integral_J")),
        )
        .collect();
    let receipts = g.last_receipts.as_ref().map(|(t, q)| {
        let named: serde_json::Map<String, Value> = names
            .iter()
            .zip(q)
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        json!({"t_s": t, "values": named})
    });
    let pass =
        c.identities_pass() && c.ledger_pass() && slice_pass && g.conservation_error.is_none();
    json!({"family": "D conservation", "verdict": if g.conservation_error.is_some() { "fail" } else if pass { "pass" } else { "fail" },
        "threshold_source": "ld01-s2-gates identityRelative, ledger.boundLocalToleranceUnits",
        "identities": identities, "ledger": ledger, "error": g.conservation_error,
        "slice": {"rule": "stored energy (rotor kinetic + magnetic + breaker body) change = aero work - oil heat - export + field input - stator and field copper - body to room + mechanism deposits, in first-order local tolerance units of the stored energy",
            "closures": g.slice.closures, "worst": g.slice.worst, "worst_units": g.slice.worst_units, "bound_units": units_bound, "pass": slice_pass},
        "pzr_spray": "internal to the primary: closed by the primary mass, boron and unit energy identities",
        "receipts_at_last_closure": receipts})
}

/// Critic item 2 (B1 on accepted states): rule I is judged at every
/// accepted stock step of a short C1 span, not only at the 0.1 s frames.
#[test]
#[ignore = "requires the S3 packets, KERN's settled S3 state, the sections, the S3 declaration, the wiki, IF97 and stock IDA/KLU"]
fn rule_i_is_judged_at_every_accepted_step() {
    let d = declaration::Declaration::load().unwrap_or_else(|e| panic!("{e}"));
    let spec = d.case(Case::C1);
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let inputs = s3_unit::Inputs::from_env();
    let run = drive(
        Case::C1,
        &d,
        &spec,
        &inputs,
        &state,
        &state_path,
        1.,
        None,
        &Ask {
            label: "rule I cadence",
            scaling: s3_unit::Scaling::NONE,
            max_step: None,
            credited_from: 0.,
            window_state: None,
            event_window: true,
            observation_s: None,
            f_tolerances: false,
        },
    );
    let steps = run.record["stock_totals"]["steps"].as_i64().unwrap();
    let frames = run.record["frames"].as_array().unwrap().len() as i64;
    let samples = run.record["rule_i"]["samples"].as_i64().unwrap();
    // C1 locates no root and rolls nothing back: every step is judged,
    // and there are more steps than frames.
    assert_eq!(run.record["counts_by_class"]["R"]["total"], 0);
    assert_eq!(samples, steps, "rule I samples against stock steps");
    assert!(steps > frames, "{steps} steps, {frames} frames");
}

#[test]
#[ignore = "S3 case run: requires the S3 packets, KERN's settled S3 state, the sections, the S3 declaration, the wiki, IF97 and stock IDA/KLU (IDAS for the gates)"]
#[allow(clippy::too_many_lines)] // One case: refusals, runs, families, receipt.
fn s3_case_run() {
    let case = Case::parse(&std::env::var("LD01_S3_CASE").expect("LD01_S3_CASE")).unwrap();
    let preview = std::env::var("LD01_S3_PREVIEW").as_deref() == Ok("1");
    let gates_on = std::env::var("LD01_S3_GATES").as_deref() == Ok("1");
    // N4′: C3's chattering rule is the pinned C4 block's; a rule in
    // LD01_S3_CHATTER_RULE is a diagnostic of an ungated preview only.
    assert!(
        std::env::var("LD01_S3_CHATTER_RULE").is_err() || (!gates_on && preview),
        "LD01_S3_CHATTER_RULE is a diagnostic: refused in a gated or evidence run"
    );
    let receipt_path = std::env::var("LD01_S3_CASE_RECEIPT").expect("LD01_S3_CASE_RECEIPT");
    assert!(
        !std::path::Path::new(&receipt_path).exists(),
        "receipts are never overwritten"
    );
    perf_install();
    let process0 = spine::z1::cpu_s();
    let d = declaration::Declaration::load_case(case).unwrap_or_else(|e| panic!("{e}"));
    // The r8 wiki: C1–C3 at r3.8; r3.7 (and C4 r2) refused by name.
    refuse_superseded(&d.block).unwrap_or_else(|e| panic!("{e}"));
    let pin = d.pin().unwrap_or_else(
        |e| json!({"pinned": false, "error": e, "declared_sha256": guards::declared_sha256(&d.block).ok()}),
    );
    let tbd = d.tbd().unwrap();
    // C4 runs on its pinned block r3 only (RP1-pin-s3-c4-r3, the r8 wiki).
    if case == Case::C4 {
        assert_eq!(
            guards::declared_sha256(&d.block).ok().as_deref(),
            Some(C4_R3_SHA256),
            "the C4 block is not RP1-pin-s3-c4-r3"
        );
    }
    let mut refusals = declaration::case_refusals(case, &pin, &tbd);
    let spec = d.case(case);
    // C4 (r1) declares no duration: its last end is `ends.cap_s`.
    let declared_s = spec["duration_s"]
        .as_f64()
        .or(spec["ends"]["cap_s"].as_f64())
        .expect("duration_s");
    let span = match std::env::var("LD01_S3_PREVIEW_SPAN_S") {
        Ok(v) => {
            assert!(preview, "a shortened span is a preview");
            v.parse::<f64>().expect("LD01_S3_PREVIEW_SPAN_S")
        }
        Err(_) => declared_s,
    };
    // Rule I: the owner's answers A4 and B1 (r3.7).
    let kinetics = case_kinetics(&d).unwrap_or_else(|e| panic!("{e}"));
    d.block.text(&d.common("/kineticsDomain/ruleI"));
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let inputs = s3_unit::Inputs::from_env();
    // The gate observation's declared settings: S2's blocks on the same page
    // (identity and ledger bounds, the observation and output grids, the
    // accuracy contract), read only for a gate run.
    let gate = gates_on.then(|| {
        let s2 = gates::Declaration::load().unwrap_or_else(|e| panic!("the S2 blocks: {e}"));
        let budgets = compare::Budgets::from(&s2).unwrap_or_else(|e| panic!("{e}"));
        let bytes = spine::packet_bytes().1;
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        GateSetup {
            s2,
            budgets,
            network_packet: serde_json::from_slice(&bytes).expect("network packet"),
            reference_travel_m: raw["rods"]["reference_travel_m"]
                .as_f64()
                .expect("reference travel"),
            corner_law: s3_harness::families::CornerLaw::from_packet(&raw),
            sg_relief_law: {
                let r = &raw["secondary"]["relief"];
                match (
                    r["crackPressure_Pa"].as_f64(),
                    r["fullLiftPressure_Pa"].as_f64(),
                    r["reseatPressure_Pa"].as_f64(),
                ) {
                    (Some(c), Some(f), Some(rs)) => Some([c, f, rs]),
                    _ => None,
                }
            },
        }
    });
    // A shortened preview may judge from an earlier time (NOT evidence).
    let judged_from = match std::env::var("LD01_S3_PREVIEW_JUDGED_FROM_S") {
        Ok(v) => {
            assert!(preview, "a moved judged span is a preview");
            v.parse::<f64>().expect("LD01_S3_PREVIEW_JUDGED_FROM_S")
        }
        Err(_) => spec["judgedFrom_s"].as_f64().unwrap_or(0.),
    };
    let window_state =
        |label: &str| (gates_on && case != Case::C1).then(|| format!("{receipt_path}.{label}"));
    let run = drive(
        case,
        &d,
        &spec,
        &inputs,
        &state,
        &state_path,
        span,
        gate.as_ref(),
        &Ask {
            label: "run",
            scaling: s3_unit::Scaling::NONE,
            max_step: None,
            // Rule F reads the whole declared part (S3-D49); E and the drift
            // take their own spans from it.
            credited_from: 0.,
            window_state: window_state("run"),
            event_window: true,
            observation_s: None,
            f_tolerances: gates_on,
        },
    );
    if run.record["composition"]["spray_path"] != json!(true) {
        refusals.push(
            "preview, no spray path (DR-P1-SPRAY-REST open): the packet composes no spray line"
                .into(),
        );
    }
    if run.record["composition"]["from_saved_s3_state"] != json!(true) {
        refusals.push(format!(
            "the start is not a settled S3 state: {state_path} is composed into S3 at its own time"
        ));
    }
    assert!(
        preview || refusals.is_empty(),
        "the S3 case run refuses (LD01_S3_PREVIEW=1 runs a NOT-EVIDENCE preview): {refusals:#?}"
    );
    // The declared part's end after zero: rule I's exit or the run's end.
    let end = run.exit_after_zero.unwrap_or(run.end_after_zero);
    let budgets_block = d.block.whole(&d.common("/budgets_cpu_s_per_s"));
    let recovery_s = gate
        .as_ref()
        .map_or(10., |g| g.s2.shared.number("/recovery/postWindow_s"));
    // The common cost rule's quiet ratio (instructions per quiet CPU-s,
    // COST2's measurement), named by the caller with its source.
    let quiet_ratio = std::env::var("LD01_S3_QUIET_RATIO").ok().map(|v| {
        let r = v
            .parse::<f64>()
            .expect("LD01_S3_QUIET_RATIO is instructions per quiet CPU-s");
        let src = std::env::var("LD01_S3_QUIET_RATIO_SOURCE")
            .expect("LD01_S3_QUIET_RATIO_SOURCE names the ratio's measurement");
        (r, src)
    });
    // Rule G on the plant's recurring work: in a gated run, a separate
    // ungated drive of the same trajectory (no 2 ms observation, no IDAS
    // ledgers), so only rule I's own calls are subtracted.
    let cost_drive = gate.as_ref().map(|_| {
        drive(
            case,
            &d,
            &spec,
            &inputs,
            &state,
            &state_path,
            span,
            None,
            &Ask {
                label: "cost",
                scaling: s3_unit::Scaling::NONE,
                max_step: None,
                credited_from: judged_from,
                window_state: None,
                event_window: true,
                observation_s: None,
                f_tolerances: false,
            },
        )
    });
    let cost_marks = cost_drive.as_ref().map_or(&run.marks, |c| &c.marks);
    let mut families = serde_json::Map::new();
    // The trip average: C2 from the trip (zero); C3 from the acquired
    // reactor trip; C5 from the acquired reactor trip (C4's reading, C5L).
    let trip_from = match case {
        Case::C1 => None,
        Case::C2 => Some(0.),
        Case::C3 | Case::C4 | Case::C5 => run.reactor_trip_after_zero,
    };
    // C4's first window (the relief malfunction's, from zero) is the
    // family's window; its later windows are judged the same way below.
    let first_window = case_window(case, &spec);
    let same_trajectory = cost_drive
        .as_ref()
        .map(|c| c.record["frames"] == run.record["frames"]);
    let mut g_cost = s3_harness::families::cost(
        case,
        &budgets_block,
        cost_marks,
        end,
        case_window(case, &spec),
        recovery_s,
        trip_from,
        quiet_ratio.clone(),
        same_trajectory,
    );
    // C4: each later window (the reactor trip, every birth) and its
    // recovery, on the same marks shifted to the window's start.
    if case == Case::C4
        && let Some(w) = first_window
    {
        let cost_events = cost_drive.as_ref().map_or(&run.record, |c| &c.record);
        let starts = s3_harness::c4::window_starts(
            cost_events["instants"]
                .as_array()
                .map_or(&[][..], |v| v.as_slice()),
            run.zero,
        );
        let mut later = Vec::new();
        for start in starts.into_iter().filter(|s| *s > 1e-9 && *s < end) {
            let shifted: Vec<s3_harness::families::Mark> = cost_marks
                .iter()
                .filter(|m| m.0 >= start - 1e-9)
                .map(|m| (m.0 - start, m.1, m.2, m.3, m.4))
                .collect();
            let base = shifted.first().copied().unwrap_or((0., 0., 0., 0., 0.));
            let shifted: Vec<s3_harness::families::Mark> = shifted
                .iter()
                .map(|m| (m.0, m.1 - base.1, m.2 - base.2, m.3 - base.3, m.4 - base.4))
                .collect();
            let mut v = s3_harness::families::cost(
                case,
                &budgets_block,
                &shifted,
                end - start,
                Some(w),
                recovery_s,
                None,
                quiet_ratio.clone(),
                None,
            );
            // Only the window entries: the run's own and trip average are above.
            let entries: Vec<Value> = v["gates"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|g| {
                    g["id"]
                        .as_str()
                        .is_some_and(|i| i.starts_with("cost.s2_window"))
                })
                .cloned()
                .collect();
            v = json!({"window_start_after_zero_s": start, "gates": entries});
            later.push(v);
        }
        let verdicts: Vec<String> = later
            .iter()
            .flat_map(|v| {
                v["gates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g["verdict"].as_str().unwrap_or("?").to_string())
            })
            .collect();
        let overall = s3_harness::families::overall_of(
            std::iter::once(g_cost["verdict"].as_str().unwrap_or("?"))
                .chain(verdicts.iter().map(String::as_str)),
        );
        g_cost["c4_later_windows"] = json!(later);
        g_cost["verdict"] = json!(overall);
    }
    g_cost["measured_on"] = json!(if cost_drive.is_some() {
        "the ungated cost drive (same trajectory; frames compared, in the verdict)"
    } else {
        "the run"
    });
    if let Some(c) = &cost_drive {
        g_cost["cost_drive_cpu"] = c.record["cpu"].clone();
    }
    families.insert("G_cost".into(), g_cost);
    let mut not_implemented: Vec<&str> = Vec::new();
    let mut repeat_driven = None;
    let mut references: Vec<(String, Driven)> = Vec::new();
    if let Some(g) = gate.as_ref() {
        let og = run.observer.gates.as_ref().unwrap();
        let units_bound = g.s2.gates.number("/ledger/boundLocalToleranceUnits");
        assert_eq!(
            g.s2.shared.number("/eventWindow/maxStep_s"),
            WINDOW_MAX_STEP_S,
            "the window cap is S1's eventWindow.maxStep_s"
        );
        families.insert(
            "D_conservation".into(),
            conservation_family(og, units_bound),
        );
        // Rule H: the same run again, bitwise.
        if std::env::var("LD01_S3_GATES_REPEAT").as_deref() != Ok("0") {
            let r = drive(
                case,
                &d,
                &spec,
                &inputs,
                &state,
                &state_path,
                span,
                Some(g),
                &Ask {
                    label: "repeat",
                    scaling: s3_unit::Scaling::NONE,
                    max_step: None,
                    credited_from: judged_from,
                    window_state: window_state("repeat"),
                    event_window: true,
                    observation_s: None,
                    f_tolerances: false,
                },
            );
            families.insert(
                "H_repeatability".into(),
                s3_harness::families::repeatability(&run.repeat_record, &r.repeat_record),
            );
            repeat_driven = Some(r);
        } else {
            families.insert("H_repeatability".into(), json!({"family": "H repeatability", "verdict": "not run", "reason": "LD01_S3_GATES_REPEAT=0"}));
        }
        // Rule E: the declared references (holds: rtol/10 with every atol
        // /10, S2's hold reference; event windows: R1 capped at S1's
        // eventReference.maxStep_s, R2 at rtol x secondRefinementToleranceFactor
        // with every atol x referenceToleranceFactor, S2's R2).
        let f = g.s2.gates.number("/referenceToleranceFactor");
        let asks: Vec<(String, s3_unit::Scaling, Option<f64>, f64, f64)> = match case {
            Case::C1 => vec![(
                "rtol/10".into(),
                s3_unit::Scaling {
                    relative: f,
                    absolute: f,
                },
                None,
                judged_from,
                end,
            )],
            // C4 (r1 gates.refinement): R1 around the first birth over its
            // window (from zero without one), R2 to the declared end.
            Case::C4 => {
                let w = first_window.unwrap();
                let second =
                    g.s2.shared
                        .number("/eventReference/secondRefinementToleranceFactor");
                // The comparison runs on the observation grid from zero: the
                // birth's window starts at the grid sample at or before it.
                let dt = g.budgets.observation_s;
                let (from, to) = run.first_birth_after_zero.map_or((0., w.min(end)), |b| {
                    let on_grid = (b / dt).floor() * dt;
                    (on_grid, (on_grid + w).min(end))
                });
                vec![
                    (
                        "R1".into(),
                        s3_unit::Scaling::NONE,
                        Some(g.s2.shared.number("/eventReference/maxStep_s")),
                        from,
                        to,
                    ),
                    (
                        "R2".into(),
                        s3_unit::Scaling {
                            relative: second,
                            absolute: f,
                        },
                        None,
                        0.,
                        end,
                    ),
                ]
            }
            Case::C2 | Case::C3 | Case::C5 => {
                let w = case_window(case, &spec).unwrap();
                let second =
                    g.s2.shared
                        .number("/eventReference/secondRefinementToleranceFactor");
                vec![
                    (
                        "R1".into(),
                        s3_unit::Scaling::NONE,
                        Some(g.s2.shared.number("/eventReference/maxStep_s")),
                        0.,
                        w.min(end),
                    ),
                    (
                        "R2".into(),
                        s3_unit::Scaling {
                            relative: second,
                            absolute: f,
                        },
                        None,
                        0.,
                        end,
                    ),
                ]
            }
        };
        let only = std::env::var("LD01_S3_GATES_REFERENCES").ok();
        let mut comparisons = Vec::new();
        for (name, scaling, max_step, from, to) in asks {
            if only
                .as_deref()
                .is_some_and(|o| !o.split(',').any(|x| x == name))
            {
                comparisons.push(json!({"reference": name, "verdict": "not run", "reason": "LD01_S3_GATES_REFERENCES"}));
                continue;
            }
            let r = drive(
                case,
                &d,
                &spec,
                &inputs,
                &state,
                &state_path,
                span.min(to + 1.),
                Some(g),
                &Ask {
                    label: &name,
                    scaling,
                    max_step,
                    // C4: R1's comparison starts at the first birth, but the
                    // reference records from zero, so the rods' insertion
                    // (rule E's rod timing) is in its record as in C2/C3.
                    credited_from: if case == Case::C4 { 0. } else { from },
                    window_state: None,
                    event_window: false,
                    observation_s: None,
                    f_tolerances: false,
                },
            );
            let rg = r.observer.gates.as_ref().unwrap();
            let e0 = match (&og.credited_error, &rg.credited_error) {
                (None, None) => {
                    compare::compare(&og.credited, &rg.credited, run.zero, from, to, &g.budgets)
                }
                (a, b) => json!({"evaluable": false, "run": a, "reference": b, "within": false}),
            };
            // E′ (S3-D23): the electrical outputs, for the cases it names.
            let electrical = s3_harness::families::electrical_e0(
                case,
                &og.credited,
                &rg.credited,
                run.zero,
                from,
                to,
                g.budgets.observation_s,
                g.budgets.cutoff_hz,
                // C4 (r1) declares no accuracy extension: E′ names C2 and C5.
                &if case == Case::C4 {
                    Value::Null
                } else {
                    d.block.whole(&d.common("/accuracyExtension"))
                },
            );
            let electrical_ok = matches!(
                electrical["verdict"].as_str(),
                Some("pass" | "not applicable")
            );
            let verdict =
                if e0["evaluable"] == json!(false) || electrical["verdict"] == "unevaluable" {
                    "unevaluable"
                } else if e0["within"] == json!(true) && electrical_ok {
                    "pass"
                } else {
                    "fail"
                };
            comparisons.push(
                json!({"reference": name, "span_after_zero_s": [from, to], "verdict": verdict,
                "reference_failure": r.failure, "reference_rule_i_exit": r.exit_after_zero,
                "reference_cpu": r.record["cpu"], "e0": e0, "electrical_e0": electrical}),
            );
            references.push((name, r));
        }
        // E3/H2: the cap cycle against R1 over the window; S2's rod timing
        // against R1 and R2; H1a: the continuation's convergence failures.
        let mut checks = serde_json::Map::new();
        if let Some(w) = first_window.filter(|_| case != Case::C1) {
            let w_end = w.min(end);
            let r1 = references.iter().find(|(n, _)| n == "R1");
            checks.insert(
                "cap_cycle".into(),
                match r1 {
                    Some((_, r)) => s3_harness::families::cap_cycle(
                        &og.credited,
                        &r.observer.gates.as_ref().unwrap().credited,
                        run.zero,
                        w_end,
                        &g.budgets,
                        g.s2.shared
                            .number("/eventReference/capCycleUncreditedRmsRatioMax"),
                        g.s2.shared
                            .number("/eventReference/capCycleFloorBudgetFraction"),
                    ),
                    None => json!({"verdict": "not run", "reason": "R1 was not run"}),
                },
            );
            let times = |c: &compare::Credited, seats: &std::collections::BTreeMap<usize, f64>| {
                compare::insertion_times(
                    c,
                    run.zero,
                    g.reference_travel_m,
                    &g.budgets.insertion_fractions,
                    seats,
                )
            };
            let mut timing = serde_json::Map::new();
            let mut timing_ok = true;
            let mut timing_ran = 0;
            for (name, r) in &references {
                let pair = (
                    times(&og.credited, &run.seats),
                    times(&r.observer.gates.as_ref().unwrap().credited, &r.seats),
                );
                let v = match pair {
                    (Ok(a), Ok(b)) if !run.seats.is_empty() => {
                        compare::compare_timing(&a, &b, &g.budgets)
                    }
                    (a, b) => {
                        json!({"within": false, "evaluable": false, "run": a.err(), "reference": b.err(), "seats": run.seats.len()})
                    }
                };
                timing_ok &= v["within"] == json!(true);
                timing_ran += 1;
                timing.insert(name.clone(), v);
            }
            checks.insert("rod_timing".into(), json!({"verdict": if timing_ran == 0 { "not run" } else if timing_ok { "pass" } else { "fail" },
                "threshold_source": "ld01-accuracy-contract thresholdTiming_s, ld01-s2-accuracy rodInsertionFractions", "references": timing}));
            let post = g.s2.shared.number("/recovery/postWindow_s");
            // A4: a run that ends inside its window has no continuation:
            // recorded as truncated, not failed (never a pass).
            let mut h1a = if end <= w {
                json!({"verdict": "truncated (rule I), not failed", "reason": "the declared part ends inside the window"})
            } else {
                s3_harness::families::convergence_failures(
                    &run.convergence,
                    w,
                    (w + post).min(end),
                    g.s2.shared.number("/recovery/maxConvergenceFailures"),
                )
            };
            if end < w + post {
                h1a["truncated_by_rule_i"] = json!(true);
            }
            checks.insert("h1a_convergence".into(), h1a);
        }
        let verdict = s3_harness::families::overall_of(
            comparisons
                .iter()
                .map(|c| c["verdict"].as_str().unwrap_or("?"))
                .chain(
                    checks
                        .values()
                        .map(|c| c["verdict"].as_str().unwrap_or("?")),
                ),
        );
        families.insert("E_refinement".into(), json!({"family": "E refinement", "verdict": verdict, "checks": checks,
            "electrical_band": "S3-D47 (interim, disclosed): E′ reports raw and 2 Hz-filtered differences; the verdict reads decision 0015 E1's 2 Hz band until the owner decides S4-6",
            "threshold_source": "ld01-accuracy-contract + ld01-s2-accuracy (E0), ld01-s2-gates referenceToleranceFactor, ld01-s1-gates eventReference",
            "electrical_extension": "E′ (S3-D23) per comparison (electrical_e0): Ieq = |i_dq|/sqrt(3) against 10 A and terminal power against 1 MW, for the cases accuracyExtension.appliesTo names",
            "comparisons": comparisons}));
        // Rule F (S3-D49) on the run's raw samples over its declared part.
        let f_family = match &run.f_tolerances {
            Some((a, record)) => {
                let (lo, hi) = (run.zero - 1e-9, run.zero + end + 1e-9);
                let keep: Vec<usize> = (0..og.credited.t.len())
                    .filter(|k| og.credited.t[*k] >= lo && og.credited.t[*k] <= hi)
                    .collect();
                let t: Vec<f64> = keep.iter().map(|k| og.credited.t[*k]).collect();
                let mut signals: Vec<(String, Vec<f64>, f64)> = Vec::new();
                for key in observe::F_SIGNALS {
                    let (Ok(series), Some(classes)) = (og.credited.output(key), a.get(key)) else {
                        continue;
                    };
                    for (j, (x, ax)) in series.iter().zip(classes).enumerate() {
                        signals.push((
                            format!("{key}[{j}]"),
                            keep.iter().map(|k| x[*k]).collect(),
                            *ax,
                        ));
                    }
                }
                // R8-E1-a (S3-D68): the law corners from the run's rod
                // travel samples, and R2's samples of the same signals.
                let (corners, corner_record) = match (
                    &g.corner_law,
                    og.credited.output(compare::key::ROD_TRAVEL_M),
                ) {
                    (Ok(law), Ok(travel)) => {
                        let tr: Vec<Vec<f64>> = travel
                            .iter()
                            .map(|x| keep.iter().map(|k| x[*k]).collect())
                            .collect();
                        let c = law.corners(&t, &tr);
                        let record = json!({"law": {"bottom_offset_m": law.bottom_offset_m, "length_m": law.length_m, "boundaries_m": law.boundaries_m}, "instants_after_zero": c.iter().map(|x| x - run.zero).collect::<Vec<_>>()});
                        (c, record)
                    }
                    (Ok(_), Err(_)) => (
                        Vec::new(),
                        json!({"instants_after_zero": [], "reason": "no rod travel output (no trip)"}),
                    ),
                    (Err(e), _) => (Vec::new(), json!({"error": e})),
                };
                let r2 = references
                    .iter()
                    .find(|(n, _)| n == "R2")
                    .and_then(|(_, r)| r.observer.gates.as_ref())
                    .filter(|rg| rg.credited_error.is_none())
                    .map(|rg| {
                        let mut m = std::collections::BTreeMap::new();
                        for key in observe::F_SIGNALS {
                            if let Ok(series) = rg.credited.output(key) {
                                for (j, x) in series.iter().enumerate() {
                                    m.insert(format!("{key}[{j}]"), x.clone());
                                }
                            }
                        }
                        (rg.credited.t.clone(), m)
                    });
                let mut f = s3_harness::families::smoothness_corners(
                    &t,
                    &signals,
                    run.rtol,
                    &run.instants,
                    &corners,
                    r2.as_ref().map(|(tr, m)| (tr.as_slice(), m)),
                );
                f["law_corners_record"] = corner_record;
                // S3-D49's verdict, kept beside (R8-E1-a).
                f["s3_d49"] =
                    s3_harness::families::smoothness_signed(&t, &signals, run.rtol, &run.instants);
                f["classes"] = record.clone();
                if og.credited_error.is_some() {
                    f["verdict"] = json!("unevaluable");
                    f["credited_error"] = json!(og.credited_error);
                }
                f
            }
            None => {
                json!({"family": "F smoothness", "verdict": "not executable", "reason": "no absolute classes (the run did not propagate them)"})
            }
        };
        families.insert("F_smoothness".into(), f_family);
        // Rule K at the declared states.
        let receipts: Value = std::env::var("LD01_S3_Z6_RECEIPTS")
            .ok()
            .map_or(json!({}), |m| {
                let names: serde_json::Map<String, Value> =
                    serde_json::from_str(&m).expect("LD01_S3_Z6_RECEIPTS is a JSON object");
                names
                    .into_iter()
                    .map(|(k, p)| {
                        let p = p.as_str().expect("a receipt path").to_string();
                        (
                            k,
                            serde_json::from_slice(&std::fs::read(&p).expect("Z6 receipt"))
                                .expect("Z6 receipt json"),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>()
                    .into()
            });
        let start_sha = provenance::sha256_file(&state_path).ok();
        let end_sha = run.declared_end_state.as_ref().map(|(_, s, _)| s.clone());
        let mut states: Vec<(&str, Option<String>)> = vec![("start (prerequisite 11)", start_sha)];
        if !matches!(case, Case::C1 | Case::C4) {
            states.push((
                run.declared_end_state
                    .as_ref()
                    .map_or("declared part end", |(_, _, which)| *which),
                end_sha,
            ));
        }
        // C4 (S3-D52): 1 s after each phase change and the declared end.
        let c4_labels: Vec<(String, Option<String>)> = run
            .c4_states
            .iter()
            .map(|x| {
                (
                    x["label"].as_str().unwrap_or("?").to_string(),
                    x["sha256"].as_str().map(str::to_string),
                )
            })
            .collect();
        for (label, sha) in &c4_labels {
            states.push((label.as_str(), sha.clone()));
        }
        let mut k = s3_harness::families::spectra(&states, &receipts);
        if k["verdict"] == "not executable" {
            k["reason"] = json!(
                "Z6 on the S3 composition is SPECTRUM's P-7 (prerequisite 11), owed: no receipt names these states (LD01_S3_Z6_RECEIPTS); the harness judges them by S2's GO rule once they exist and writes each post-event state for it"
            );
        }
        k["declared_end_state"] = json!(run.declared_end_state);
        k["post_event"] = json!(match case {
            Case::C1 => "not applicable: C1 has no event",
            Case::C2 | Case::C3 | Case::C5 =>
                "S3-D52: the declared part's end state, the window's end or rule I's end, whichever first (C2, C3, C5); A4 admits no state after rule I's exit",
            Case::C4 => "1 s after each phase change and at the declared part's end (C4, S3-D52)",
        });
        if case == Case::C4 {
            k["c4_states"] = json!(run.c4_states);
        }
        families.insert("K_spectra".into(), k);
        // Rule B (S3-D50), with the chattering criterion as data.
        // C3's chattering rule from the pinned C4 block (N4′); a rule given
        // in LD01_S3_CHATTER_RULE is a diagnostic only, refused in a gated
        // or evidence run.
        let chatter_rule: Value = match std::env::var("LD01_S3_CHATTER_RULE") {
            Ok(r) => {
                assert!(
                    !gates_on && preview,
                    "LD01_S3_CHATTER_RULE is a diagnostic: refused in a gated or evidence run"
                );
                serde_json::from_str(&r).expect("LD01_S3_CHATTER_RULE is a JSON rule")
            }
            Err(_) => n4_rule_of_the_wiki()
                .unwrap_or_else(|e| json!({"criterion": "unavailable", "reason": e})),
        };
        let chatter = s3_harness::families::chattering(
            run.record["instants"].as_array().unwrap(),
            &chatter_rule,
            &run.entries,
        );
        // C4's rule B (S3-D65): its frame record, the log's phase-mode
        // receipts, C4.O1's full lift, C4.O4′'s instant and rule D's record.
        let c4_names: Vec<String> = g
            .network_packet
            .mechanics
            .regions
            .iter()
            .map(|r| r.id.clone())
            .collect();
        let c4_conservation = families.get("D_conservation").cloned().unwrap_or_else(
            || json!({"verdict": "not executable", "reason": "rule D was not judged"}),
        );
        let c4_numbers = |id: &str| {
            run.record["lines"]
                .as_array()
                .and_then(|l| l.iter().find(|x| x["id"] == id))
                .map(|x| &x["numbers"])
        };
        let c4_record = match (case, run.record["c4"]["frames"].as_array()) {
            (Case::C4, Some(frames)) => Some(s3_harness::c4::DirectionRecord {
                frames,
                log: run.record["instants"].as_array().unwrap(),
                names: &c4_names,
                o4: c4_numbers("C4.O4"),
                full_lift_s: c4_numbers("C4.O1").and_then(|n| n["full_lift_s"].as_f64()),
                conservation: &c4_conservation,
                pt1_noise_pa: g.budgets.roof_noise_pa,
                cutoff_hz: g.budgets.cutoff_hz,
                observation_s: og.dt,
            }),
            _ => None,
        };
        let direction_inputs = s3_harness::families::DirectionInputs {
            credited: &og.credited,
            zero: run.zero,
            end,
            reactor_trip: run.reactor_trip_after_zero,
            gcb_open: run.gcb_open_after_zero,
            sg_relief: run.sg_relief.clone(),
            sg_relief_law: g.sg_relief_law,
            rotors: &og.rotors,
            chatter,
            donor_flips: run.donor_flips,
            c4: c4_record,
        };
        let b_family = if case == Case::C5 {
            c5_directions(&spec, og, &g.network_packet, &run)
        } else {
            s3_harness::families::directions(case, &spec, &direction_inputs)
        };
        families.insert("B_directions".into(), b_family);
        // C1's drift, SS-1 and SS-2.
        if case == Case::C1 {
            let gg = &g.s2.gates;
            let mut ceilings = vec![
                (
                    compare::key::CORE_POWER_W,
                    gg.number("/hold/driftCeiling/corePowerRelative"),
                    true,
                ),
                (
                    compare::key::AVERAGE_COOLANT_K,
                    gg.number("/hold/driftCeiling/averageCoolant_K"),
                    false,
                ),
                (
                    compare::key::PZR_ROOF_PA,
                    gg.number("/hold/driftCeiling/pzrRoofPressure_Pa"),
                    false,
                ),
                (
                    compare::key::SG_PRESSURE_PA,
                    gg.number("/hold/driftCeiling/sgPressure_Pa"),
                    false,
                ),
                (
                    compare::key::SG_LIQUID_M3,
                    gg.number("/hold/driftCeiling/sgLiquidVolume_m3"),
                    false,
                ),
            ];
            ceilings.push((
                "generator_power_w",
                spec["generatorPowerDriftRelative"]
                    .as_f64()
                    .expect("generatorPowerDriftRelative"),
                true,
            ));
            let mut drift = compare::drift(
                &og.credited,
                run.zero,
                judged_from,
                &ceilings,
                g.budgets.observation_s,
                g.budgets.cutoff_hz,
            );
            let level = compare::drift(
                &og.credited,
                run.zero,
                judged_from,
                &[(compare::key::PZR_LEVEL_M, f64::INFINITY, false)],
                g.budgets.observation_s,
                g.budgets.cutoff_hz,
            );
            drift["pzr_level_reported_only"] = json!({"rule": "S3-D2: no charging or letdown; reported only", "value": level["outputs"][compare::key::PZR_LEVEL_M]["value"]});
            let verdict = if og.credited_error.is_some() {
                "unevaluable"
            } else if drift["within"] == json!(true) {
                "pass"
            } else {
                "fail"
            };
            families.insert("C1_drift".into(), json!({"family": "C1 drift", "verdict": verdict, "credited_error": og.credited_error,
                "threshold_source": "ld01-s2-gates hold.driftCeiling (PZR level reported only, S3-D2); ld01-s3-cases-c1c3 cases.C1.generatorPowerDriftRelative",
                "judged_from_s": judged_from, "record": drift}));
            // SS-1 (S3-D51): its own drive over ss1Duration_s on the 0.1 s
            // output grid, provisional on this Mac (F1).
            let ss1 = if std::env::var("LD01_S3_SS1").as_deref() == Ok("0") {
                json!({"family": "C1 SS-1", "verdict": "not run", "reason": "LD01_S3_SS1=0"})
            } else {
                let declared = spec["ss1Duration_s"].as_f64().expect("ss1Duration_s");
                // A preview may shorten it (then not executable as declared).
                let duration = match std::env::var("LD01_S3_PREVIEW_SS1_S") {
                    Ok(v) => {
                        assert!(preview, "a shortened SS-1 is a preview");
                        v.parse::<f64>().expect("LD01_S3_PREVIEW_SS1_S")
                    }
                    Err(_) => declared,
                };
                let r = drive(
                    case,
                    &d,
                    &spec,
                    &inputs,
                    &state,
                    &state_path,
                    duration,
                    Some(g),
                    &Ask {
                        label: "SS-1",
                        scaling: s3_unit::Scaling::NONE,
                        max_step: None,
                        credited_from: 0.,
                        window_state: None,
                        event_window: true,
                        observation_s: Some(g.budgets.output_s),
                        f_tolerances: false,
                    },
                );
                let rg = r.observer.gates.as_ref().unwrap();
                let series: Vec<(String, bool, Vec<f64>)> = s3_harness::families::SS1_SIGNALS
                    .iter()
                    .flat_map(|(k, temperature)| {
                        rg.credited.output(k).map_or(Vec::new(), |inst| {
                            inst.iter()
                                .enumerate()
                                .map(|(j, x)| (format!("{k}[{j}]"), *temperature, x.clone()))
                                .collect()
                        })
                    })
                    .collect();
                let mut v = s3_harness::families::ss1(
                    &spec,
                    r.end_after_zero,
                    &series,
                    g.budgets.output_s,
                    g.budgets.cutoff_hz,
                );
                v["drive"] = json!({"failure": r.failure, "cpu": r.record["cpu"], "credited_error": rg.credited_error,
                    "rule_i_exit_after_zero_s": r.exit_after_zero, "counts_by_class": r.record["counts_by_class"]});
                if r.failure.is_some() || rg.credited_error.is_some() {
                    v["verdict"] = json!("unevaluable");
                }
                v
            };
            families.insert("C1_SS1".into(), ss1);
            let d_family = &families["D_conservation"];
            families.insert(
                "C1_SS2".into(),
                s3_harness::families::ss2(
                    &d_family["identities"],
                    &d_family["ledger"],
                    &d_family["slice"],
                    units_bound,
                ),
            );
        }
    } else {
        not_implemented.extend([
            "D conservation (a gate run: LD01_S3_GATES=1 on the IDAS build)",
            "E refinement (a gate run)",
            "F smoothness (a gate run)",
            "H repeatability (a gate run)",
            "K post-event spectra (a gate run)",
            "B directions (a gate run)",
            "C1 drift, SS-1 and SS-2 (a gate run)",
        ]);
    }
    let failure = run.failure.clone();
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
    let status = if case == Case::C4 {
        format!("{status}; C4 ended {}", run.record["c4"]["end"]["end"])
    } else if run.record["labelled_end"]["applies"] == json!(true) {
        format!("{status}; ended, labelled, at PZR zone-R exhaustion (S3-D39, a declared exit)")
    } else {
        status
    };
    let (verdict, not_judged) = s3_harness::families::overall(
        failure.is_some(),
        lines::all_pass(run.record["lines"].as_array().unwrap()),
        &families,
    );
    let mut gates_not_yet: Vec<Value> = not_implemented.iter().map(|s| json!(s)).collect();
    gates_not_yet.extend(not_judged);
    let mut receipt = json!({
        "kind": if evidence { "s3-case-run" } else { "s3-case-preview" },
        "case": case.key(), "status": status, "verdict": verdict, "failure": failure,
        "refusals_or_deviations": refusals,
        "declaration": {"block": d.block.receipt(), "pin": pin, "tbd": tbd, "kinetics": kinetics,
            "s2_blocks": gate.as_ref().map(|g| g.s2.receipt())},
        "provenance": spine::provenance(),
        "packet": state["packet"], "packet_sha256": state["packet_sha256"],
        "configuration": {"declared_duration_s": declared_s, "span_after_zero_s": span, "gates": gates_on},
        "families": families,
        "gates_not_yet_implemented": gates_not_yet,
        "run": run.record,
        "repeat": repeat_driven.as_ref().map(|r| json!({"failure": r.failure, "cpu": r.record["cpu"], "record": r.repeat_record})),
        "references": references.iter().map(|(n, r)| json!({"reference": n, "failure": r.failure, "rule_i_exit_after_zero_s": r.exit_after_zero,
            "configuration": r.record["configuration"], "cpu": r.record["cpu"], "counts_by_class": r.record["counts_by_class"]})).collect::<Vec<_>>(),
        "process_cpu_s": spine::z1::cpu_s() - process0,
    });
    // The case record's own fields at the top level, as before.
    for k in [
        "lines",
        "c4",
        "algebraic_residuals",
        "rule_i",
        "operator_turbine_trip",
        "labelled_end",
        "information",
        "timeline",
        "cpu",
        "counts_by_class",
    ] {
        receipt[k] = run.record[k].clone();
    }
    std::fs::write(
        &receipt_path,
        serde_json::to_string_pretty(&receipt).unwrap(),
    )
    .unwrap();
    eprintln!(
        "{}: {}; {}",
        case.key(),
        receipt["status"],
        receipt["verdict"]
    );
    for l in run.record["lines"].as_array().unwrap() {
        eprintln!("  {} {}: {}", l["id"], l["kind"], l["verdict"]);
    }
    for (k, v) in receipt["families"].as_object().unwrap() {
        eprintln!("  family {k}: {}", v["verdict"]);
    }
}

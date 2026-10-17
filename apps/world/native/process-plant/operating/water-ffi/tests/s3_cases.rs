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

/// The pinned C4 block revision 2 (wiki e2e26fd), RP1-pin-s3-c4-r2.
const C4_R2: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c4-r2.json");
/// RP1-pin-s3-c4-r2's declared sha256.
const C4_R2_SHA256: &str = "2fe73e08f2414d84a843c5c5bd48464c3f3a6f23345f33773d2b34dac18abd5d";
/// N4′'s rule and terms as the owner (R7-Q, CH-1) and the lead (S3-D58)
/// state them: the texts the harness implements, compared verbatim.
const N4_RULE: &str = "No numerical chattering: every vapour-path re-closing must follow a located exhaustion or a located flow reversal \u{2014} a consistent state before it, for a reversal a drive toward the emptying end beyond its tolerance, its cause recorded; such closings are counted and reported.";
const N4_CONSISTENT: &str = "every row's pre-transaction residual at most 1 integrator tolerance unit, rtol\u{b7}|y| + atol (JACAGE's units) (S3-D58)";
const N4_DRIVE: &str = "|drive| above the drive's first-order propagated tolerance, rule F's construction of a_x (S3-D58)";

/// C3's chattering rule read from the pinned C4 block (its N4 `judgesAlso`
/// names C3, S3-D45): the block must be RP1-pin-s3-c4-r2 and N4's rule and
/// terms the texts the harness implements; the rule's parameters are the
/// harness's reading of those texts (the kernel's L1 causes for a located
/// exhaustion and a located flow reversal; one tolerance unit).
fn n4_rule(c4: &Block, pin: &Value) -> Result<Value, String> {
    if pin["pinned"] != json!(true) || guards::declared_sha256(c4)? != C4_R2_SHA256 {
        return Err(format!("the C4 block is not RP1-pin-s3-c4-r2: {pin}"));
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
    rule["declared"] = json!({"block": "ld01-s3-cases-c4 r2", "pin": C4_R2_SHA256, "rule": n4["rule"], "terms": n4["terms"], "judgesAlso": n4["judgesAlso"]});
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
    let c4 = Block::from_json("ld01-s3-cases-c4", C4_R2).unwrap();
    assert_eq!(guards::declared_sha256(&c4).unwrap(), C4_R2_SHA256);
    let log = format!(
        "| RP1-pin-s3-c4-r2 | 17 Oct | `ld01-s3-cases-c4` frozen; sha256 {C4_R2_SHA256} |\n"
    );
    let pin = guards::pin_of(&c4, Some(&log), "log").unwrap();
    let rule = n4_rule(&c4, &pin).unwrap();
    assert_eq!(rule["criterion"], "n4prime");
    // Unpinned, or another rule text, refuses.
    assert!(n4_rule(&c4, &guards::pin_of(&c4, Some(""), "log").unwrap()).is_err());
    let mut v: Value = serde_json::from_str(C4_R2).unwrap();
    v["cases"]["C4"]["lines"]["N4"]["rule"] = json!("no chattering");
    let changed = Block::from_json("ld01-s3-cases-c4", &v.to_string()).unwrap();
    let pin = guards::pin_of(&changed, Some(&log), "log").unwrap();
    assert!(n4_rule(&changed, &pin).is_err());
}

/// Rule I and the kinetics floor as r3.7 declares them (owner request 5):
/// A4 (R5-A) and B1 (R5-B), the only rules the harness implements. The
/// floor's 8 MPa and the D3 (a) extension are the packet's compiled
/// sections; B1's per-core-region phase-absence check is [`RuleI::judge`]'s
/// admission. Any other declared text refuses.
fn kinetics_rule(block: &Block) -> Result<Value, String> {
    kinetics_rule_at(block, "")
}

/// [`kinetics_rule`] under `prefix` (C5's block: `/commonRules`).
fn kinetics_rule_at(block: &Block, prefix: &str) -> Result<Value, String> {
    let rule_i = block.whole(&format!("{prefix}/kineticsDomain/ruleI"));
    let floor = block.whole(&format!("{prefix}/kineticsDomain/floor"));
    let (Some(rule_i), Some(floor)) = (rule_i.as_str(), floor.as_str()) else {
        return Err("the block declares no kineticsDomain.ruleI and floor".into());
    };
    if !rule_i.starts_with("A4 (owner-approved, R5-A)") {
        return Err(format!(
            "rule I {rule_i:?}: the harness implements the owner's A4 (R5-A)"
        ));
    }
    if !floor.starts_with("B1 (owner-approved, R5-B)") {
        return Err(format!(
            "kinetics floor {floor:?}: the harness implements the owner's B1 (R5-B)"
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
    if case != Case::C3 {
        return Ok(None);
    }
    let delay = spec["operatorTurbineTripDelay_s"]
        .as_f64()
        .filter(|d| d.is_finite() && *d > 0.)
        .ok_or("C3 declares no positive operatorTurbineTripDelay_s (S3-D39)")?;
    for k in [
        "operatorTurbineTripFrom",
        "operatorTurbineTripBasis",
        "labelledEnd",
    ] {
        spec[k]
            .as_str()
            .ok_or(format!("C3 declares no {k} (S3-D39)"))?;
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

/// A case's declared event window length (C5's block nests it in `windows`).
fn case_window(case: Case, spec: &Value) -> Option<f64> {
    match case {
        Case::C5 => spec["windows"]["window_s"].as_f64(),
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
    let end = start + text[start..].find("\n```").ok_or("unterminated ramp-cap block")?;
    let block: Value = serde_json::from_str(&text[start..end]).map_err(|e| e.to_string())?;
    let keys = ["amends", "appliesFrom", "rampMaxStep_s", "elsewhereInWindow", "ramps", "rule"];
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
            if r["from"].as_str().is_some_and(|f| f.contains("LD01.TG TRIP"))
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
    let window_s = spec["window_s"].as_f64()?;
    let starts: fn(&Value) -> bool = match case {
        // C5's cap is set by the case after the offsite loss's restart.
        Case::C1 | Case::C5 => return None,
        Case::C2 => |r| r["command"] == "TurbineTripAcquired",
        Case::C3 => |r| r["command"] == "SupplyLoss",
    };
    Some(WindowCap {
        max_step_s: WINDOW_MAX_STEP_S,
        window_s,
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
    assert_eq!(b["rampMaxStep_s"].as_f64().unwrap().to_bits(), 0.005f64.to_bits());
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
    let c2 = window_cap(Case::C2, &b.whole("/cases/C2"), declared_ramp(Case::C2, &ramp_fixture()).unwrap()).unwrap();
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
    let c3 = window_cap(Case::C3, &b.whole("/cases/C3"), declared_ramp(Case::C3, &ramp_fixture()).unwrap()).unwrap();
    assert_eq!(cap_in_force(&c3, 0., None), Some(0.02));
    assert_eq!(cap_in_force(&c3, 29.99, None), Some(0.02));
}

#[test]
fn the_window_cap_holds_only_inside_the_declared_window() {
    let b = block();
    // C1 declares no window: never capped.
    assert!(window_cap(Case::C1, &b.whole("/cases/C1"), None).is_none());
    // C2: 20 s from the trip, started by the trip's receipt only.
    let c2 = window_cap(Case::C2, &b.whole("/cases/C2"), declared_ramp(Case::C2, &ramp_fixture()).unwrap()).unwrap();
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
    let c3 = window_cap(Case::C3, &b.whole("/cases/C3"), declared_ramp(Case::C3, &ramp_fixture()).unwrap()).unwrap();
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
    assert!(!(ramp.ends)(&json!({"event": "STOP ramp end", "owner": "secondary"})));
    assert!(!(ramp.ends)(&json!({"command": "TurbineTripAcquired", "owner": "secondary"})));
    assert!(c3.ramp.is_none() && c3.start_cap() == 0.02);
    // Off at the first bound at or after the window's end, not before.
    let zero = 548.05;
    assert!(!cap_removed_at(zero + 19.95, zero, 20.));
    assert!(cap_removed_at(zero + 20., zero, 20.));
    assert!(cap_removed_at(548.1 + 20., zero, 20.));
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
}

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
    sg_relief: Vec<(String, i64, f64)>,
    repeat_record: Value,
    window_end_state: Option<(String, String)>,
    end_after_zero: f64,
}

/// What one run is asked: the run itself, its repeat or a reference.
struct Ask<'a> {
    label: &'a str,
    scaling: s3_unit::Scaling,
    /// A reference's own maximum step (S1's `eventReference.maxStep_s`).
    max_step: Option<f64>,
    /// Credited outputs from this time after zero (C1: `judgedFrom_s`).
    credited_from: f64,
    /// Where the window-end state is written (C2/C3, rule K), if anywhere.
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
    let extension: leitbild_operating_plant::joined::post_trip_domain::Extension =
        serde_json::from_value(packet_json["post_trip_domain"].clone())
            .expect("the packet's post_trip_domain section (D3 (a))");
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
        rods: (0..clusters)
            .map(|c| (o.rods + 3 * c, scales[o.rods + 3 * c]))
            .collect(),
        scratch: vec![0.; y.len()],
        rows: Vec::new(),
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
    let mut window_end_state = None;
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
            // The window's start disarms the hook (nothing later re-caps);
            // its end removes the cap.
            if let Some(w) = &window_cap
                && r.is_ok()
            {
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
            // Rule K's post-event state: the window's end (C2, C3), the
            // solver's own state there (the frame stop), for SPECTRUM.
            if r.is_ok()
                && let (Some(w), Some(path)) = (window_s, ask.window_state.as_ref())
                && (*b - (zero + w)).abs() < 1e-9
            {
                let snapshot = ida.system().system_discrete_state();
                let s = json!({"t_s": *b, "packet": state["packet"], "packet_sha256": state["packet_sha256"],
                    "y": &y[..n], "yp": &yp[..n],
                    "appended": {"owner": "electrical slice (ELEC)", "y": &y[n..], "yp": &yp[n..]},
                    "discrete_state": snapshot, "pzr_control": {"in_force_w": control.in_force_w},
                    "composition": composition["composition"], "from": format!("{} window end ({} s after zero)", case.key(), w)});
                let bytes = serde_json::to_vec(&s).unwrap();
                assert!(
                    !std::path::Path::new(path).exists(),
                    "states are never overwritten"
                );
                std::fs::write(path, &bytes).unwrap();
                window_end_state = Some((path.clone(), spine::sha256(&bytes)));
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
        until
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
                "mismatches": domain.mismatches, "first_mismatch": domain.first_mismatch}},
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
    let seats: std::collections::BTreeMap<usize, f64> = tl
        .seats
        .iter()
        .filter_map(|(c, t)| cluster_index.get(c).map(|i| (*i, zero + *t)))
        .collect();
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
            .filter_map(|(v, _, d, t)| {
                s3_harness::timeline::relief_sg(v).map(|sg| (sg.to_string(), *d, *t))
            })
            .collect(),
        repeat_record,
        window_end_state,
        end_after_zero: end - zero,
    }
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
    let process0 = spine::z1::cpu_s();
    let d = declaration::Declaration::load_case(case).unwrap_or_else(|e| panic!("{e}"));
    let pin = d.pin().unwrap_or_else(
        |e| json!({"pinned": false, "error": e, "declared_sha256": guards::declared_sha256(&d.block).ok()}),
    );
    let tbd = d.tbd().unwrap();
    let mut refusals = declaration::case_refusals(case, &pin, &tbd);
    let spec = d.case(case);
    let declared_s = spec["duration_s"].as_f64().expect("duration_s");
    let span = match std::env::var("LD01_S3_PREVIEW_SPAN_S") {
        Ok(v) => {
            assert!(preview, "a shortened span is a preview");
            v.parse::<f64>().expect("LD01_S3_PREVIEW_SPAN_S")
        }
        Err(_) => declared_s,
    };
    // Rule I: the owner's answers A4 and B1 (r3.7).
    let kinetics = kinetics_rule_at(&d.block, &d.common("")).unwrap_or_else(|e| panic!("{e}"));
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
    let window_state = |label: &str| {
        (gates_on && case != Case::C1)
            .then(|| format!("{receipt_path}.{label}-window-end-state.json"))
    };
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
        Case::C3 | Case::C5 => run.reactor_trip_after_zero,
    };
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
        quiet_ratio,
        same_trajectory,
    );
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
                    credited_from: from,
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
                &d.block.whole(&d.common("/accuracyExtension")),
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
        if let Some(w) = spec["window_s"].as_f64().filter(|_| case != Case::C1) {
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
                let mut f =
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
        let window_sha = run.window_end_state.as_ref().map(|(_, s)| s.clone());
        let mut states: Vec<(&str, Option<String>)> = vec![("start (prerequisite 11)", start_sha)];
        if case != Case::C1 {
            states.push(("window end", window_sha));
        }
        let mut k = s3_harness::families::spectra(&states, &receipts);
        if k["verdict"] == "not executable" {
            k["reason"] = json!(
                "Z6 on the S3 composition is SPECTRUM's P-7 (prerequisite 11), owed: no receipt names these states (LD01_S3_Z6_RECEIPTS); the harness judges them by S2's GO rule once they exist and writes each post-event state for it"
            );
        }
        k["window_end_state"] = json!(run.window_end_state);
        k["post_event"] = json!(if case == Case::C1 {
            "not applicable: C1 has no event"
        } else {
            "the window's end state (C2, C3, C5)"
        });
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
        let direction_inputs = s3_harness::families::DirectionInputs {
            credited: &og.credited,
            zero: run.zero,
            end,
            reactor_trip: run.reactor_trip_after_zero,
            gcb_open: run.gcb_open_after_zero,
            sg_relief: run.sg_relief.clone(),
            rotors: &og.rotors,
            chatter,
            donor_flips: run.donor_flips,
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
    let status = if run.record["labelled_end"]["applies"] == json!(true) {
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

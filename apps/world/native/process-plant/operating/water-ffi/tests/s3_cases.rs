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

/// Rule I and the kinetics floor as r3.7 declares them (owner request 5):
/// A4 (R5-A) and B1 (R5-B), the only rules the harness implements. The
/// floor's 8 MPa and the D3 (a) extension are the packet's compiled
/// sections; B1's per-core-region phase-absence check is [`RuleI::judge`]'s
/// admission. Any other declared text refuses.
fn kinetics_rule(block: &Block) -> Result<Value, String> {
    let rule_i = block.whole("/kineticsDomain/ruleI");
    let floor = block.whole("/kineticsDomain/floor");
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
    }
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
    /// `(t − zero, the run thread's CPU less the gate observation)`.
    marks: Vec<(f64, f64)>,
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
        frame::{COUNTER_NAMES, Class, Client, Diagnostic, Driver, Setup},
        ic::ProtectionClient,
        ida::System,
        joined::JoinedSystem,
    };
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
    let declared_frame_s = d.block.number("/frameAlignment/frame_s");
    d.block.text("/frameAlignment/rule");
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
        observe::Gates {
            origin: zero,
            dt: g.budgets.observation_s,
            output_s: g.budgets.output_s,
            credited_from: zero + ask.credited_from,
            reader: outputs::Reader::new(joined, &g.network_packet, g.reference_travel_m)
                .expect("credited output reader"),
            rods: false,
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
        }
    });
    let mut observer = observe::CaseObserver {
        n,
        extension,
        rule_i: observe::RuleI::default(),
        gates: gates_part,
    };
    // S2's 20 ms event-window cap for an event case, from the start
    // (options are refused mid-segment); a reference's own cap instead.
    const WINDOW_MAX_STEP_S: f64 = 0.02;
    let max_step = ask
        .max_step
        .or_else(|| command.is_some().then_some(WINDOW_MAX_STEP_S));
    if let Some(h) = max_step {
        ida.set_max_step(h).unwrap();
    }
    let mut driver = Driver::new(frame, Diagnostic::Jump, spine::z1::cpu_s, t0).unwrap();
    if cfg!(feature = "quadratures") && observer.gates.is_some() {
        let count = ida.system().quadrature_count();
        driver
            .start_quadratures(&mut ida, vec![0.; count])
            .unwrap_or_else(|e| panic!("the ledgers' quadratures: {e}"));
    }
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
    observe::start_sample(&mut observer, ida.system_mut(), t0, &y, &yp);
    let preparation_cpu_s = spine::z1::cpu_s() - started;
    let run_started = spine::z1::cpu_s();
    let until = zero + span;
    // The run in chunks at every frame instant (the control client, class
    // S, stops there anyway, so the chunks add no stop): C3's operator
    // trip is scheduled at the first chunk after the reactor trip, and the
    // CPU is marked at every chunk for the cost spans.
    let window_s = spec["window_s"].as_f64().filter(|_| command.is_some());
    let mut bounds: Vec<f64> = vec![zero, until];
    if let Some(w) = window_s {
        bounds.push(zero + w);
    }
    let period = frame.period_s();
    let first = (t0 / period).floor() as i64 + 1;
    let last = (until / period).ceil() as i64;
    bounds.extend((first..=last).map(|k| k as f64 * period));
    bounds.retain(|b| *b > t0 && *b <= until);
    bounds.sort_by(f64::total_cmp);
    bounds.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let mut marks: Vec<(f64, f64)> = vec![(t0 - zero, 0.)];
    let operator_trip = operator_trip_delay(case, spec).unwrap();
    let mut operator_trip_record = Value::Null;
    let mut window_end_state = None;
    let outcome = {
        let mut r = {
            let mut clients: Vec<&mut dyn Client<CaseUnit>> =
                vec![&mut protection, &mut recorder, &mut control];
            driver.start(&mut clients, t0, &y, &yp)
        };
        let mut t = t0;
        for b in &bounds {
            if r.is_err() {
                break;
            }
            if let Some(delay) = operator_trip
                && operator_trip_record.is_null()
                && let Some(trip) = protection
                    .protection
                    .divisions
                    .iter()
                    .filter_map(|d| d.trip.as_ref().map(|c| c.at_s))
                    .reduce(f64::min)
            {
                let at = trip + delay;
                operator_trip_record = json!({"reactor_trip_cause_s": trip, "reactor_trip_after_zero_s": trip - zero,
                    "turbine_trip_s": at, "turbine_trip_after_zero_s": at - zero, "delay_s": delay,
                    "command": "TurbineTripAcquired (LD01.TG TRIP, as C2)"});
                if let Err(e) = driver.command(at, Command::TurbineTripAcquired) {
                    r = Err(e);
                    break;
                }
            }
            r = {
                let mut clients: Vec<&mut dyn Client<CaseUnit>> =
                    vec![&mut protection, &mut recorder, &mut control];
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
            marks.push((
                reached - zero,
                spine::z1::cpu_s()
                    - run_started
                    - driver.cpu.gate_s
                    - ledger_quadrature_cpu_s(ida.system()),
            ));
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
    let judged = lines::judge(case, &spec["lines"], &declared_tl, &implemented, clusters);
    let information =
        exit_after_zero.map(|_| lines::judge(case, &spec["lines"], &tl, &implemented, clusters));
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
            "tolerance_scaling": {"relative": ask.scaling.relative, "absolute": ask.scaling.absolute},
            "derived_tolerances": derived, "relative_tolerance": rtol,
            "integration": if cfg!(feature = "quadratures") { "frame driver: stock IDAS IDA_ONE_STEP (ledgers as quadratures, IDASetQuadErrCon false), observation from IDAGetDky, restarts by discrete_restart" } else { "frame driver: stock IDA_ONE_STEP, observation from IDAGetDky, restarts by discrete_restart" }},
        "lines": judged,
        "rule_i": {"evaluated_at": "every accepted stock step (B1: on accepted states), at the solver's state there",
            "samples": domain.samples, "stock_steps": driver.totals[0],
            "note": "samples = stock steps less located-root returns and steps a late change rolled back", "first_extended_s": domain.first_extended, "margin_failures": domain.margin_failures,
            "exit": domain.exit, "exit_after_zero_s": exit_after_zero, "information_from_s": exit_after_zero},
        "operator_turbine_trip": operator_trip_record,
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
    Driven {
        record,
        observer,
        zero,
        exit_after_zero,
        failure,
        marks,
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

/// The run's `(key, is temperature, series)` for SS-1 and the detector.
fn credited_series(c: &compare::Credited) -> Vec<(String, bool, Vec<f64>)> {
    let mut out = Vec::new();
    for (k, temperature) in [
        (compare::key::AVERAGE_COOLANT_K, true),
        (compare::key::CORE_POWER_W, false),
        (compare::key::PZR_ROOF_PA, false),
        (compare::key::SG_PRESSURE_PA, false),
        (compare::key::LOOP_FLOW_KG_S, false),
        ("generator_power_w", false),
    ] {
        if let Ok(series) = c.output(k) {
            for (i, x) in series.iter().enumerate() {
                out.push((format!("{k}[{i}]"), temperature, x.clone()));
            }
        }
    }
    out
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
    let pass =
        c.identities_pass() && c.ledger_pass() && slice_pass && g.conservation_error.is_none();
    json!({"family": "D conservation", "verdict": if g.conservation_error.is_some() { "fail" } else if pass { "pass" } else { "fail" },
        "threshold_source": "ld01-s2-gates identityRelative, ledger.boundLocalToleranceUnits",
        "identities": identities, "ledger": ledger, "error": g.conservation_error,
        "slice": {"rule": "stored energy (rotor kinetic + magnetic + breaker body) change = aero work - oil heat - export + field input - stator and field copper - body to room + mechanism deposits, in first-order local tolerance units of the stored energy",
            "closures": g.slice.closures, "worst": g.slice.worst, "worst_units": g.slice.worst_units, "bound_units": units_bound, "pass": slice_pass},
        "pzr_spray": "internal to the primary: closed by the primary mass, boron and unit energy identities"})
}

#[test]
#[ignore = "S3 case run: requires the S3 packets, KERN's settled S3 state, the sections, the S3 declaration, the wiki, IF97 and stock IDA/KLU (IDAS for the gates)"]
#[allow(clippy::too_many_lines)] // One case: refusals, runs, families, receipt.
fn s3_case_run() {
    let case = Case::parse(&std::env::var("LD01_S3_CASE").expect("LD01_S3_CASE")).unwrap();
    let preview = std::env::var("LD01_S3_PREVIEW").as_deref() == Ok("1");
    let gates_on = std::env::var("LD01_S3_GATES").as_deref() == Ok("1");
    let receipt_path = std::env::var("LD01_S3_CASE_RECEIPT").expect("LD01_S3_CASE_RECEIPT");
    assert!(
        !std::path::Path::new(&receipt_path).exists(),
        "receipts are never overwritten"
    );
    let process0 = spine::z1::cpu_s();
    let d = declaration::Declaration::load().unwrap_or_else(|e| panic!("{e}"));
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
    let kinetics = kinetics_rule(&d.block).unwrap_or_else(|e| panic!("{e}"));
    d.block.text("/kineticsDomain/ruleI");
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
            credited_from: judged_from,
            window_state: window_state("run"),
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
    let budgets_block = d.block.whole("/budgets_cpu_s_per_s");
    let recovery_s = gate
        .as_ref()
        .map_or(10., |g| g.s2.shared.number("/recovery/postWindow_s"));
    let mut families = serde_json::Map::new();
    families.insert(
        "G_cost".into(),
        s3_harness::families::cost(
            case,
            &budgets_block,
            &run.marks,
            end,
            spec["window_s"].as_f64(),
            recovery_s,
        ),
    );
    let mut not_implemented: Vec<&str> = Vec::new();
    let mut repeat_driven = None;
    let mut references: Vec<(String, Driven)> = Vec::new();
    if let Some(g) = gate.as_ref() {
        let og = run.observer.gates.as_ref().unwrap();
        let units_bound = g.s2.gates.number("/ledger/boundLocalToleranceUnits");
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
            Case::C2 | Case::C3 => {
                let w = spec["window_s"].as_f64().unwrap();
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
                },
            );
            let rg = r.observer.gates.as_ref().unwrap();
            let e0 = match (&og.credited_error, &rg.credited_error) {
                (None, None) => {
                    compare::compare(&og.credited, &rg.credited, run.zero, from, to, &g.budgets)
                }
                (a, b) => json!({"evaluable": false, "run": a, "reference": b, "within": false}),
            };
            let verdict = if e0["within"] == json!(true) {
                "pass"
            } else if e0["evaluable"] == json!(false) {
                "unevaluable"
            } else {
                "fail"
            };
            comparisons.push(
                json!({"reference": name, "span_after_zero_s": [from, to], "verdict": verdict,
                "reference_failure": r.failure, "reference_rule_i_exit": r.exit_after_zero,
                "reference_cpu": r.record["cpu"], "e0": e0}),
            );
            references.push((name, r));
        }
        let verdict = if comparisons.iter().all(|c| c["verdict"] == "pass") {
            "pass"
        } else if comparisons.iter().any(|c| c["verdict"] == "fail") {
            "fail"
        } else {
            "incomplete"
        };
        families.insert("E_refinement".into(), json!({"family": "E refinement", "verdict": verdict,
            "threshold_source": "ld01-accuracy-contract + ld01-s2-accuracy (E0), ld01-s2-gates referenceToleranceFactor, ld01-s1-gates eventReference",
            "electrical_extension": if matches!(case, Case::C2) { json!({"verdict": "not implemented", "reason": "S3-D23's Ieq (10 A) and terminal power (1 MW) comparisons: the generator power is recorded; Ieq is not observed by the harness yet"}) } else { json!("not applicable (C2, C5 only)") },
            "comparisons": comparisons}));
        // Rule F: the detector on every recorded credited signal.
        let series = credited_series(&og.credited);
        let signals: Vec<(String, Vec<f64>)> = series
            .iter()
            .map(|(k, _, x)| (k.clone(), x.clone()))
            .collect();
        let instants: Vec<f64> = run.record["instants"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["t_s"].as_f64())
            .collect();
        families.insert(
            "F_smoothness".into(),
            s3_harness::families::smoothness(
                &d.block.value,
                &spec,
                &signals,
                &og.credited.t,
                &instants,
            ),
        );
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
            "the window's end state (C2, C3)"
        });
        families.insert("K_spectra".into(), k);
        // Rule B.
        let rotor = match case {
            Case::C3 => case_clock(case, &spec, d.block.number("/frameAlignment/frame_s"))
                .ok()
                .and_then(|(_, c)| match c {
                    Some(Command::SupplyLoss { rotor }) => Some(rotor),
                    _ => None,
                }),
            _ => None,
        };
        families.insert(
            "B_directions".into(),
            s3_harness::families::directions(case, &spec, rotor, &og.rotors),
        );
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
            families.insert(
                "C1_SS1".into(),
                s3_harness::families::ss1(
                    &spec,
                    end,
                    &credited_series(&og.credited),
                    g.budgets.observation_s,
                    g.budgets.cutoff_hz,
                ),
            );
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
    // A family the run could not exercise stays listed, with its reason.
    let unexercised: Vec<Value> = families
        .iter()
        .filter(|(_, v)| {
            matches!(
                v["verdict"].as_str(),
                Some("not executable" | "not executable as declared" | "not run")
            )
        })
        .map(|(k, v)| json!({"family": k, "verdict": v["verdict"], "reason": v["reason"]}))
        .collect();
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
    let judged_families: Vec<(&String, &str)> = families
        .iter()
        .map(|(k, v)| (k, v["verdict"].as_str().unwrap_or("?")))
        .collect();
    let verdict = if failure.is_some() {
        "FAIL: the run failed".to_string()
    } else if !lines::all_pass(run.record["lines"].as_array().unwrap()) {
        "lines not all passing".to_string()
    } else if judged_families.iter().any(|(_, v)| *v == "fail") {
        format!(
            "lines PASS; families failing: {:?}",
            judged_families
                .iter()
                .filter(|(_, v)| *v == "fail")
                .map(|(k, _)| k)
                .collect::<Vec<_>>()
        )
    } else if !unexercised.is_empty() || !not_implemented.is_empty() {
        "lines PASS; families pass where executable (see gates_not_yet_implemented)".to_string()
    } else {
        "lines and every gate family PASS".to_string()
    };
    let mut gates_not_yet: Vec<Value> = not_implemented.iter().map(|s| json!(s)).collect();
    gates_not_yet.extend(unexercised);
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

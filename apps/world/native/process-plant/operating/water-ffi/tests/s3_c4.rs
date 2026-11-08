//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-draft-case-c4
//! S3 case C4's judges (C4 lane), unit tests only: the pinned
//! `ld01-s3-cases-c4` block's pin, its volume classes against a packet's
//! prepared enthalpies, every line judge on synthetic logs (pass and fail),
//! rule A′'s vote, the declared windows, the labelled ends and the
//! chattering rule. The case itself runs in `s3_cases.rs`
//! (`LD01_S3_CASE=C4`) through the gate families as C1–C3.
#![cfg(all(feature = "ida", target_os = "macos"))]
// C4's own readers (the case run in s3_cases.rs uses the rest) and the S2
// declaration readers, on the shared harness modules.
mod common;
mod s2_harness;
mod s3_harness;
use common::filter;
use s2_harness::{compare, conservation, gates, guards, outputs};
use s3_harness::c4;

use c4::{Classes, Events, Frame, Run, Side};
use gates::Block;
use serde_json::{Value, json};

/// The C4 block as committed on the wiki (revision 1).
/// The pinned C4 block revision 2 (wiki e2e26fd), RP1-pin-s3-c4-r2.
const C4_R2: &str = include_str!("s3_harness/fixtures/ld01-s3-cases-c4-r2.json");

fn block() -> Block {
    Block::from_json("ld01-s3-cases-c4", C4_R2).unwrap()
}

#[test]
fn the_c4_block_pins_and_its_probe_values_are_open() {
    let b = block();
    let sha = guards::declared_sha256(&b).unwrap();
    eprintln!("ld01-s3-cases-c4 r1 declared sha256 {sha}");
    assert_eq!(
        sha,
        "2fe73e08f2414d84a843c5c5bd48464c3f3a6f23345f33773d2b34dac18abd5d"
    );
    let log = format!("| RP1-pin-s3-c4-r2 | 17 Oct | `ld01-s3-cases-c4` frozen; sha256 {sha} |\n");
    let pin = guards::pin_of(&b, Some(&log), "log").unwrap();
    assert_eq!(pin["pinned"], json!(true), "{pin}");
    // The C1–C3 pin row never pins the C4 block.
    let other = "| RP1-pin-s3-c1c3-r3.7 | 15 Oct | `ld01-s3-cases-c1c3`; sha256 083df1253745f4c895a69b13e5579b2099e3e2271f06acef1ac309e0eb431d2d |\n";
    assert_eq!(
        guards::pin_of(&b, Some(other), "log").unwrap()["pinned"],
        json!(false)
    );
    let tbd = guards::tbd_state(&b, Some(&log)).unwrap();
    assert_eq!(tbd["open"].as_array().unwrap().len(), 9, "{tbd}");
    assert!(guards::undeclared_nulls(&b).unwrap().is_empty());
}

/// A packet with the S3 packets' cells and prepared enthalpies.
fn packet() -> Value {
    let hot = 1_453_456.;
    let cold = 1_284_337.;
    let mid = 1_365_558.;
    let ids = [
        ("CORE.NE.1", Some(mid)),
        ("CORE.NE.2", Some(hot)),
        ("CORE.NW.1", Some(mid)),
        ("CORE.NW.2", Some(hot)),
        ("CORE.SW.1", Some(mid)),
        ("CORE.SW.2", Some(hot)),
        ("CORE.SE.1", Some(mid)),
        ("CORE.SE.2", Some(hot)),
        ("DOWN", Some(cold)),
        ("LOWER", Some(cold)),
        ("UPPER", Some(hot)),
        ("HOT.A.UPSTREAM", Some(hot)),
        ("HOT.A.JUNCTION", Some(hot)),
        ("HOT.A.DOWNSTREAM", Some(hot)),
        ("SG.A.PRIMARY", Some(cold)),
        ("PUMP.A1", Some(cold)),
        ("PUMP.A2", Some(cold)),
        ("COLD.A", Some(cold)),
        ("RETURN.A", Some(cold)),
        ("HOT.B", Some(hot)),
        ("SG.B.PRIMARY", Some(cold)),
        ("PUMP.B1", Some(cold)),
        ("PUMP.B2", Some(cold)),
        ("COLD.B", Some(cold)),
        ("RETURN.B", Some(cold)),
        ("HOUSING.MAIN", Some(hot)),
        ("HOUSING.NECK", Some(hot)),
        ("SURGE", None),
        ("SPRAY", None),
        ("PZR", None),
    ];
    json!({"mechanics": {"regions": ids.iter().map(|(i, _)| json!({"id": i})).collect::<Vec<_>>()},
        "hot": {"fluid": {"regions": ids.iter().filter_map(|(i, h)| h.map(|h| json!({"id": i, "enthalpy_j_kg": h}))).collect::<Vec<_>>()}}})
}

#[test]
fn the_volume_classes_follow_the_packets_prepared_enthalpies() {
    let b = block();
    let spec = b.whole("/cases/C4/volumeClasses");
    let c = Classes::from_block(&spec, &packet()).unwrap();
    assert_eq!(c.of(26), Side::Hot, "HOUSING.NECK");
    assert_eq!(c.of(14), Side::Cold, "SG.A.PRIMARY");
    assert_eq!(c.of(0), Side::Neither, "CORE.NE.1");
    assert_eq!(c.of(28), Side::Neither, "SPRAY");
    assert_eq!(c.of(27), Side::Excluded, "SURGE");
    // A packet whose SG primary is prepared hot contradicts the lists.
    let mut p = packet();
    p["hot"]["fluid"]["regions"][14]["enthalpy_j_kg"] = json!(1_453_456.);
    assert!(Classes::from_block(&spec, &p).is_err());
}

/// A synthetic C4 run: the malfunction at t0 = 500 s, full lift 0.05 s
/// later, the low-pressure cause at +12.3 s in I1–I3 with its requests,
/// the holding loss there, 52 seats by +14.6 s, the operator turbine trip
/// at +22.3 s, an SG crack at +24 s, NECK's birth at +40 s (an R restart
/// that recompiled), MAIN's at +40.4 s, and one L1 release and contact.
fn c4_logs() -> (Vec<Value>, Vec<Value>) {
    let t0 = 500.;
    let seats: Vec<Value> = (0..52)
        .map(|c| json!({"cluster": format!("LD01.CR.{c:03}"), "event": "seat", "t_s": t0 + 14.6}))
        .collect();
    let restart_birth = |cell: usize, t: f64, release: bool| {
        let l1: Vec<Value> = if release {
            vec![
                json!({"path": 65, "face": 32, "phase": 1, "before": {"Locked": "To"}, "after": "Free", "cause": "Birth"}),
            ]
        } else {
            Vec::new()
        };
        json!({"t_s": t, "class": "R", "kinds": ["located roots"], "restart": {
            "presence_changed": true, "modes_changed": true,
            "transactions": [{"owner": "phase modes", "t_s": t, "events": [{"birth": cell}], "vaporPathContacts": null},
                {"owner": "network L1", "t_s": t, "changes": l1}]}})
    };
    let log = vec![
        json!({"t_s": t0, "class": "R", "kinds": ["command ReliefStuckOpen"], "restart": {"transactions": [
            {"owner": "pzr", "t_s": t0, "command": "ReliefStuckOpen", "stuck_open": true,
             "before": {"demand_open": false, "motion": "Closed"}, "after": {"demand_open": true, "motion": "Opening"}}]}}),
        json!({"t_s": t0 + 0.05, "class": "R", "kinds": ["located roots"], "restart": {"transactions": [
            {"owner": "pzr", "t_s": t0 + 0.05, "demand_root": 0, "travel_root": 1,
             "before": {"demand_open": true, "motion": "Opening"}, "after": {"demand_open": true, "motion": "Open"},
             "stop": {"motion_after": "Open"}}]}}),
        json!({"t_s": t0 + 12.3, "class": "R", "kinds": ["LD01.TRIP.HOLD loss"], "restart": {"transactions": [
            {"owner": "secondary", "command": "HoldingLoss", "t_s": t0 + 12.3}]}}),
        json!({"t_s": t0 + 14.6, "class": "R", "kinds": ["located roots"], "restart": {"transactions": [{"rods": seats}]}}),
        json!({"t_s": t0 + 22.3, "class": "R", "kinds": ["command TurbineTripAcquired"], "restart": {"transactions": []}}),
        json!({"t_s": t0 + 24., "class": "R", "kinds": ["located roots"], "restart": {"transactions": [
            {"owner": "secondary", "t_s": t0 + 24., "relief": [{"valve": "SG.A.RELIEF.1", "threshold": "Crack", "direction": 1}]}]}}),
        restart_birth(26, t0 + 40., true),
        restart_birth(25, t0 + 40.4, false),
        json!({"t_s": t0 + 41., "class": "R", "kinds": ["located roots"], "restart": {"transactions": [
            {"owner": "network L1", "t_s": t0 + 41., "changes": [{"path": 64, "face": 32, "phase": 0,
                "before": "Free", "after": {"Locked": "From"}, "cause": "ContactRoot"}]}]}}),
    ];
    let division = json!({"powered": true,
        "causes": [{"function": "LD01.PROT.PZR.LOW_PRESSURE", "t_s": t0 + 12.3}, {"function": "LD01.PROT.PZR.S_PRESSURE", "t_s": t0 + 12.3}, {"function": "LD01.PROT.TG.TRIP", "t_s": t0 + 22.5}],
        "trip": {"function": "LD01.PROT.PZR.LOW_PRESSURE", "t_s": t0 + 12.3},
        "requests": [{"request": "PRHR", "by": "LD01.PROT.PZR.S_PRESSURE", "t_s": t0 + 12.3},
            {"request": "CMT injection", "by": "LD01.PROT.PZR.S_PRESSURE", "t_s": t0 + 12.3}]});
    (log, vec![division.clone(), division.clone(), division])
}

fn frames() -> Vec<Frame> {
    (0..=600)
        .map(|k| {
            let t = f64::from(k) * 0.1;
            Frame {
                t,
                roof_pa: 14.86e6 - 0.1e6 * t,
                sg_pa: vec![6.336e6 - 1e3 * t.min(22.3), 6.336e6 - 1e3 * t.min(22.3)],
                lift: (t / 0.05).min(1.),
                relief_kg_s: if t > 0. { 100. - t } else { 0. },
                core_departure_k: vec![-30. + 0.5 * t; 2],
                core_vapor_kg: vec![0.; 2],
            }
        })
        .collect()
}

/// The acquired PT1-3 at every decision instant (0.1 s): the voted value
/// (the middle channel) reaches 13.00 MPa at +11.8 s, so the low-pressure
/// predicate qualifies (5 frames) at +12.3 s; PT1 at t = 0 is 14.18 MPa.
fn acquired_pt() -> Vec<c4::Acquired> {
    (0..=600)
        .map(|k: i32| {
            let p = 13e6 + f64::from(118 - k) * 1e4;
            c4::Acquired {
                t: f64::from(k) * 0.1,
                channels: vec![Some(p), Some(p + 1e3), Some(p - 1e3)],
            }
        })
        .collect()
}

fn judged(
    log: &[Value],
    divisions: &[Value],
    frames: &[Frame],
) -> std::collections::BTreeMap<String, Value> {
    // O4′ and N4′ are the gate families' judges (their own unit tests in
    // families.rs); the arms carry their verdicts.
    let o4 = json!({"verdict": "pass", "t_s": 40., "cell": "HOUSING.NECK", "side": "hot"});
    let n4 = json!({"verdict": "pass", "closings": 1, "reclosings": 0});
    judged_with(log, divisions, frames, &acquired_pt(), Some(&o4), Some(&n4))
}

fn judged_with(
    log: &[Value],
    divisions: &[Value],
    frames: &[Frame],
    pt: &[c4::Acquired],
    o4: Option<&Value>,
    n4: Option<&Value>,
) -> std::collections::BTreeMap<String, Value> {
    let b = block();
    let classes = Classes::from_block(&b.whole("/cases/C4/volumeClasses"), &packet()).unwrap();
    let events = Events::from_log(log, 500.).unwrap();
    let run = Run {
        end: 60.,
        events: &events,
        classes: &classes,
        divisions,
        holding_lost: Some(12.3),
        operator_trip: Some(22.3),
        frames,
        clusters: 52,
        low_pa: 13e6,
        high_pa: 15.5e6,
        sg_crack_pa: 6.8e6,
        full_travel_s: 0.05,
        birth_threshold_k: 0.5,
        l1_active: true,
        pt,
        low_frames: 5,
        high_frames: 2,
        o4,
        n4,
    };
    c4::judge(&b.whole("/cases/C4/lines"), &run, 500.)
        .into_iter()
        .map(|l| (l["id"].as_str().unwrap().to_string(), l))
        .collect()
}

#[test]
fn c4s_lines_are_judged_on_the_runs_own_events() {
    let (log, divisions) = c4_logs();
    let f = frames();
    let j = judged(&log, &divisions, &f);
    let v = |id: &str| j[id]["verdict"].as_str().unwrap().to_string();
    for id in [
        "C4.O1", "C4.O2", "C4.O3", "C4.O4", "C4.N1", "C4.N2", "C4.N3",
    ] {
        assert_eq!(v(id), "pass", "{id}: {}", j[id]);
    }
    // A seated body that lifts off and seats again is one body (S2's G9).
    let mut reseat = log.clone();
    reseat.push(reseat[3].clone());
    reseat.last_mut().unwrap()["t_s"] = json!(541.);
    for r in reseat.last_mut().unwrap()["restart"]["transactions"][0]["rods"]
        .as_array_mut()
        .unwrap()
    {
        r["t_s"] = json!(541.);
    }
    let jr = judged(&reseat, &divisions, &f);
    assert_eq!(jr["C4.O2"]["verdict"], "pass", "{}", jr["C4.O2"]);
    assert_eq!(jr["C4.O2"]["numbers"]["seats"], json!(52));
    assert_eq!(jr["C4.O2"]["numbers"]["reseat_records"], json!(52));
    assert!((jr["C4.O2"]["numbers"]["last_seat_s"].as_f64().unwrap() - 14.6).abs() < 1e-9);
    // A release of path 65 and a contact of path 64: no relock, no chattering.
    assert_eq!(v("C4.N4"), "pass", "{}", j["C4.N4"]);
    for id in ["C4.M1", "C4.M2", "C4.M3"] {
        assert_eq!(v(id), "recorded");
    }
    assert_eq!(j.len(), 11);
    assert!(c4::all_pass(&j.values().cloned().collect::<Vec<_>>()));
    // O2's margin: (13.00 - lowest roof PT) / (PT1(0) - 13.00).
    // O2's margin on the voted acquired PT: (13.00 - lowest voted) / (PT1(0) - 13.00).
    let m = j["C4.O2"]["numbers"]["marginFraction"].as_f64().unwrap();
    assert!((m - (13e6 - 8.18e6) / (14.18e6 - 13e6)).abs() < 1e-9, "{m}");
    assert_eq!(
        j["C4.O2"]["numbers"]["consistency_iff"]["holds"],
        json!(true)
    );
    // N2's: (15.50 - highest voted) / (15.50 - PT1(0)) = 1.
    let m = j["C4.N2"]["numbers"]["marginFraction"].as_f64().unwrap();
    assert!((m - 1.).abs() < 1e-12, "{m}");
    // O4's margin: NECK at +40 s, core departure -10 K against -30 K at zero.
    let m = j["C4.O4"]["numbers"]["marginFraction"].as_f64().unwrap();
    assert!((m - 10.5 / 30.5).abs() < 1e-9, "{m}");
}

#[test]
fn c4s_lines_fail_on_what_the_declaration_excludes() {
    let (mut log, mut divisions) = c4_logs();
    // A reseat (the relief closing), an SG crack before the operator trip,
    // a high-pressure cause, a cold-side first birth, a missing CMT
    // request, a relock of path 65 after its release.
    log[1]["restart"]["transactions"][0]["after"] =
        json!({"demand_open": false, "motion": "Closing"});
    log[5]["t_s"] = json!(510.);
    log[5]["restart"]["transactions"][0]["t_s"] = json!(510.);
    divisions[0]["causes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"function": "LD01.PROT.PZR.HIGH_PRESSURE", "t_s": 501.}));
    log[6]["restart"]["transactions"][0]["events"][0]["birth"] = json!(9);
    divisions[1]["requests"].as_array_mut().unwrap().pop();
    log.push(
        json!({"t_s": 542.5, "class": "R", "kinds": ["located roots"], "restart": {"transactions": [
        {"owner": "network L1", "t_s": 542.5, "changes": [{"path": 65, "face": 32, "phase": 1,
            "before": "Free", "after": {"Locked": "From"}, "cause": "ContactRoot"}]}]}}),
    );
    let f = frames();
    let fail = json!({"verdict": "fail", "t_s": 40., "cell": "LOWER", "side": "cold"});
    let j = judged_with(
        &log,
        &divisions,
        &f,
        &acquired_pt(),
        Some(&fail),
        Some(&json!({"verdict": "fail"})),
    );
    let v = |id: &str| j[id]["verdict"].as_str().unwrap().to_string();
    for id in [
        "C4.O1", "C4.O3", "C4.O4", "C4.N1", "C4.N2", "C4.N3", "C4.N4",
    ] {
        assert_eq!(v(id), "fail", "{id}: {}", j[id]);
    }
    // r1's kernel relock list stays reported beside N4′.
    assert_eq!(
        j["C4.N4"]["numbers"]["kernel_relocks_r1"][0]["relocks"],
        json!(1)
    );
    // Without the judges O4 and N4 are not executable; relief flow lost
    // after full lift fails O1.
    let (log, divisions) = c4_logs();
    let mut f = frames();
    f[300].relief_kg_s = 0.;
    let j = judged_with(&log, &divisions, &f, &acquired_pt(), None, None);
    assert_eq!(j["C4.O4"]["verdict"], "not executable");
    assert_eq!(j["C4.N4"]["verdict"], "not executable");
    assert_eq!(j["C4.O1"]["verdict"], "fail");
}

#[test]
fn the_kernels_named_refusals_are_c4s_labelled_ends() {
    assert_eq!(
        c4::labelled_end(
            "stratified PZR: mixture level reaches the relief port PZR.RELIEF: the solid-PZR structural limit"
        ),
        Some("solidPzr")
    );
    assert_eq!(
        c4::labelled_end("dryout of cell 26 at t = 1 s: mode G is S6 scope (C4's declared end)"),
        Some("dryout")
    );
    assert_eq!(
        c4::labelled_end("equilibrium cell 26 without liquid: dryout is mode G (S6)"),
        Some("dryout")
    );
    assert_eq!(
        c4::labelled_end("a vapor tracer receipt through the surge port: vapor carries no boron"),
        Some("subcooledVapour")
    );
    assert_eq!(c4::labelled_end("stock IDA status -3"), None);
}

#[test]
fn rule_a_prime_fails_a_cause_without_its_acquired_predicate_and_the_reverse() {
    let (log, divisions) = c4_logs();
    let f = frames();
    // Accepted 0.1 s before its predicate qualifies: O2 fails on A′.
    let mut early = divisions.clone();
    for d in &mut early {
        d["causes"][0]["t_s"] = json!(512.2);
        d["trip"]["t_s"] = json!(512.2);
        for r in d["requests"].as_array_mut().unwrap() {
            r["t_s"] = json!(512.2);
        }
    }
    let j = judged(&log, &early, &f);
    assert_eq!(j["C4.O2"]["verdict"], "fail", "{}", j["C4.O2"]);
    assert_eq!(
        j["C4.O2"]["numbers"]["consistency_iff"]["holds"],
        json!(false)
    );
    // The predicate qualifies but no division accepts: O2 fails.
    let mut none = divisions.clone();
    for d in &mut none {
        d["causes"] = json!([]);
    }
    assert_eq!(judged(&log, &none, &f)["C4.O2"]["verdict"], "fail");
    // A high-pressure predicate qualifying without its cause fails N2.
    let mut high = acquired_pt();
    for a in high.iter_mut().take(4) {
        a.channels = vec![Some(15.6e6), Some(15.6e6), Some(14e6)];
    }
    let j = judged_with(&log, &divisions, &f, &high, None, None);
    assert_eq!(j["C4.N2"]["verdict"], "fail", "{}", j["C4.N2"]);
    // One stale channel of three leaves two usable, which must both agree.
    assert!(c4::affirmative(
        &[Some(12e6), None, Some(12.5e6)],
        13e6,
        true
    ));
    assert!(!c4::affirmative(
        &[Some(12e6), None, Some(13.5e6)],
        13e6,
        true
    ));
    assert!(!c4::affirmative(&[Some(12e6), None, None], 13e6, true));
    assert!(c4::affirmative(
        &[Some(12e6), Some(14e6), Some(12.5e6)],
        13e6,
        true
    ));
    assert_eq!(
        c4::voted(&[Some(12e6), Some(14e6), Some(12.5e6)], true),
        Some(12.5e6)
    );
    assert_eq!(
        c4::voted(&[Some(12e6), Some(14e6), Some(12.5e6)], false),
        Some(12.5e6)
    );
    assert_eq!(
        c4::voted(&[Some(12e6), None, Some(12.5e6)], true),
        Some(12.5e6)
    );
    assert_eq!(c4::voted(&[Some(12e6), None, None], true), None);
}

#[test]
fn the_declared_windows_start_at_the_malfunction_the_trip_and_each_birth() {
    let (log, _) = c4_logs();
    let starts = c4::window_starts(&log, 500.);
    let want = [0., 12.3, 40., 40.4];
    assert_eq!(starts.len(), want.len(), "{starts:?}");
    for (a, b) in starts.iter().zip(want) {
        assert!((a - b).abs() < 1e-9, "{starts:?}");
    }
    // The seat, the SG crack and the L1 contact start none.
    assert!(!c4::starts_window(&log[3]["restart"]["transactions"][0]));
    assert!(!c4::starts_window(&log[5]["restart"]["transactions"][0]));
}

/// Rule I as the block declares it (the owner's A4 and B1, as `s3_cases`).
fn kinetics_rule(block: &Block) -> Result<Value, String> {
    let rule_i = block.whole("/commonRules/kineticsDomain/ruleI");
    let floor = block.whole("/commonRules/kineticsDomain/floor");
    let (Some(rule_i), Some(floor)) = (rule_i.as_str(), floor.as_str()) else {
        return Err("the block declares no kineticsDomain.ruleI and floor".into());
    };
    if !rule_i.starts_with("A4 (owner-approved, R5-A)")
        || !floor.starts_with("B1 (owner-approved, R5-B)")
    {
        return Err(format!(
            "rule I {rule_i:?} / floor {floor:?}: the harness implements A4 and B1"
        ));
    }
    Ok(
        json!({"ruleI": "A4", "floor": "B1", "ruleI_text": rule_i, "floor_text": floor,
        "endText": block.whole("/cases/C4/ends/ruleI")}),
    )
}

#[test]
fn rule_i_is_read_as_the_owners_a4_and_b1() {
    assert_eq!(kinetics_rule(&block()).unwrap()["floor"], "B1");
}

// Rule B (S3-D65): each signed C4 row passes and fails on synthetic
// records.

fn b_row(t: f64, relief: f64, roof: f64, cells: Value) -> Value {
    json!({"t_s": t, "relief_kg_s": relief, "pzr_roof_pa": roof, "cells": cells})
}

/// Frames every 0.1 s to 10 s: NECK liquid (departure rising to 0.4 K)
/// until its birth at 5.05 s, mode E (M_g growing) after it.
fn b_frames() -> Vec<Value> {
    (1..=100)
        .map(|k| {
            let t = f64::from(k) * 0.1;
            let neck = if t < 5.05 {
                json!(["NECK", "L", -20. + 4.08 * t])
            } else {
                json!(["NECK", "E", 0.5 * (t - 5.05), 900.])
            };
            b_row(t, 100. - 2. * t, 1.55e7 - 1e5 * t, json!([neck]))
        })
        .collect()
}

fn b_log(zero: f64, slots: Value, exhaustion: Option<f64>) -> Vec<Value> {
    let tx = |t: f64, ev: Value| json!({"t_s": zero + t, "restart": {"transactions": [{"owner": "phase modes", "events": [ev]}]}});
    let mut log = vec![tx(5.05, json!({"birth": 1, "vapor_slots": slots}))];
    if let Some(x) = exhaustion {
        log.push(tx(x, json!({"exhaustion": 1})));
    }
    log
}

fn b_conservation(change: f64, attribution: f64, max_units: f64) -> Value {
    json!({"family": "D conservation", "verdict": "pass", "error": null,
        "ledger": {"bound_local_tolerance_units": 1.0,
            "closures": {"primary_mass_kg": {"max_units": max_units, "at_t_s": 600.}},
            "final": {"t_s": 610., "closures": [{"name": "primary_mass_kg", "inventory_change": change, "ledger": change, "closure": 0., "tolerance": 2.0, "units": 0.}]}},
        "receipts_at_last_closure": {"t_s": 610., "values": {"primary_mass_kg": attribution, "pzr_relief_attribution_kg": attribution}}})
}

#[test]
fn rule_b_pt1_falls_within_the_noise_budget_and_fails_a_larger_rise() {
    // A 1e5 Pa/s fall with one sample bumped above the one before it.
    let bumped = |bump: f64| -> Vec<(f64, f64)> {
        (0..=100)
            .map(|k| {
                let t = f64::from(k) * 0.1;
                (t, 1.55e7 - 1e5 * t + if k == 50 { bump } else { 0. })
            })
            .collect()
    };
    // 150 Pa above the running minimum is within the 200 Pa budget.
    let (ok, d) = c4::pt1_monotone(&bumped(1e4 + 150.), 200.);
    assert_eq!(ok, Some(true), "{d}");
    let (ok, d) = c4::pt1_monotone(&bumped(1e4 + 500.), 200.);
    assert_eq!(ok, Some(false), "{d}");
    assert!((d["at_s"].as_f64().unwrap() - 5.0).abs() < 1e-9, "{d}");
    assert!((d["largest_rise_above_running_min_pa"].as_f64().unwrap() - 500.).abs() < 1e-6);
    assert_eq!(c4::pt1_monotone(&bumped(0.)[..1], 200.).0, None);
    assert_eq!(c4::pt1_monotone(&[(0., f64::NAN), (0.1, 1.)], 200.).0, None);
}

#[test]
fn rule_b_level_falls_after_the_trip_and_rises_after_saturation() {
    let level = |rise: bool| -> Vec<(f64, f64)> {
        (0..=100)
            .map(|k| {
                let t = f64::from(k) * 0.1;
                let x = if t < 1. {
                    5.
                } else if t < 5. {
                    5. - 0.1 * (t - 1.)
                } else if rise {
                    4.6 + 0.05 * (t - 5.)
                } else {
                    4.6 - 0.01 * (t - 5.)
                };
                (t, x)
            })
            .collect()
    };
    let (ok, d) = c4::level_direction(&level(true), Some(1.), Some(5.05), 10.);
    assert_eq!(ok, Some(true), "{d}");
    assert_eq!(
        c4::level_direction(&level(false), Some(1.), Some(5.05), 10.).0,
        Some(false)
    );
    assert_eq!(
        c4::level_direction(&level(true), Some(1.), None, 10.).0,
        None
    );
    assert_eq!(
        c4::level_direction(&level(true), None, Some(5.05), 10.).0,
        None
    );
    assert_eq!(
        c4::level_direction(&level(true), Some(6.), Some(5.05), 10.).0,
        None
    );
    // Core power, T_hot and T_avg: x(end) < x(t_rt).
    let up: Vec<(f64, f64)> = (0..=10).map(|k| (f64::from(k), f64::from(k))).collect();
    let down: Vec<(f64, f64)> = up.iter().map(|&(t, x)| (t, -x)).collect();
    assert_eq!(c4::falls_after(&down, Some(1.), 10.).0, Some(true));
    assert_eq!(c4::falls_after(&up, Some(1.), 10.).0, Some(false));
    assert_eq!(c4::falls_after(&up, None, 10.).0, None);
}

#[test]
fn rule_b_relief_falls_end_to_end_and_reports_the_framewise_rise() {
    let mut frames = b_frames();
    let (ok, d) = c4::relief_falls(&frames, Some(0.05), 10.);
    assert_eq!(ok, Some(true), "{d}");
    assert!((d["at_full_lift"]["frame_s"].as_f64().unwrap() - 0.1).abs() < 1e-9);
    assert_eq!(
        d["framewise_rise_while_pt1_falls (reported, S3-D65)"]["frames"],
        0
    );
    // A frame-wise rise while PT1 falls is reported, not judged.
    frames[40]["relief_kg_s"] = json!(95.);
    let (ok, d) = c4::relief_falls(&frames, Some(0.05), 10.);
    assert_eq!(ok, Some(true), "{d}");
    assert_eq!(
        d["framewise_rise_while_pt1_falls (reported, S3-D65)"]["frames"],
        1
    );
    // The flow at the end above the flow at full lift fails.
    frames[99]["relief_kg_s"] = json!(120.);
    assert_eq!(c4::relief_falls(&frames, Some(0.05), 10.).0, Some(false));
    assert_eq!(c4::relief_falls(&frames, None, 10.).0, None);
}

#[test]
fn rule_b_departure_rises_to_the_threshold_without_exceeding_it() {
    let mut frames = b_frames();
    let (ok, d) = c4::departure_rises(&frames, "NECK", 5.05, 0.5);
    assert_eq!(ok, Some(true), "{d}");
    assert!((d["last_frame_before_t_b"][1].as_f64().unwrap() - 0.4).abs() < 1e-9);
    // A frame above the credited band before the birth fails.
    frames[30]["cells"] = json!([["NECK", "L", 0.6]]);
    assert_eq!(
        c4::departure_rises(&frames, "NECK", 5.05, 0.5).0,
        Some(false)
    );
    // A departure that falls to the birth fails.
    let falling: Vec<Value> = b_frames()
        .into_iter()
        .map(|mut f| {
            if f["cells"][0][1] == "L" {
                let d = f["cells"][0][2].as_f64().unwrap();
                f["cells"][0][2] = json!(-d - 40.);
            }
            f
        })
        .collect();
    assert_eq!(
        c4::departure_rises(&falling, "NECK", 5.05, 0.5).0,
        Some(false)
    );
    assert_eq!(c4::departure_rises(&frames, "MAIN", 5.05, 0.5).0, None);
}

#[test]
fn rule_b_vapour_mass_starts_at_zero_and_stays_positive_per_interval() {
    let zero = 500.;
    let names = vec!["SURGE".to_string(), "NECK".to_string()];
    let frames = b_frames();
    let log = b_log(zero, json!([0.0, 0.0]), None);
    let (ok, d) = c4::vapour_mass(&frames, &log, zero, &names, "NECK", 10.);
    assert_eq!(ok, Some(true), "{d}");
    assert_eq!(d["intervals"][0]["frames"], 50);
    // A birth that carries vapour fails.
    let paid = b_log(zero, json!([1e-12, 0.0]), None);
    assert_eq!(
        c4::vapour_mass(&frames, &paid, zero, &names, "NECK", 10.).0,
        Some(false)
    );
    // Mode E past a logged exhaustion fails; a re-birth reopens it.
    let exhausted = b_log(zero, json!([0.0, 0.0]), Some(7.05));
    let (ok, d) = c4::vapour_mass(&frames, &exhausted, zero, &names, "NECK", 10.);
    assert_eq!(ok, Some(false), "{d}");
    let mut liquid_after: Vec<Value> = frames.clone();
    for f in liquid_after.iter_mut().skip(70) {
        f["cells"] = json!([["NECK", "L", -1.]]);
    }
    assert_eq!(
        c4::vapour_mass(&liquid_after, &exhausted, zero, &names, "NECK", 10.).0,
        Some(true)
    );
    // M_g not positive inside the interval fails.
    let mut empty = frames.clone();
    empty[60]["cells"] = json!([["NECK", "E", 0.0, 900.]]);
    assert_eq!(
        c4::vapour_mass(&empty, &log, zero, &names, "NECK", 10.).0,
        Some(false)
    );
    assert_eq!(
        c4::vapour_mass(&frames, &[], zero, &names, "NECK", 10.).0,
        None
    );
}

#[test]
fn rule_b_primary_mass_falls_by_the_integrated_relief_flow_within_d() {
    let (ok, d) = c4::primary_mass(&b_conservation(-3925.4, -3925.6, 0.3));
    assert_eq!(ok, Some(true), "{d}");
    // More than one tolerance unit (2 kg) from the integrated relief flow.
    assert_eq!(
        c4::primary_mass(&b_conservation(-3925.4, -3930., 0.3)).0,
        Some(false)
    );
    // D's own closure outside its bound.
    assert_eq!(
        c4::primary_mass(&b_conservation(-3925.4, -3925.6, 1.2)).0,
        Some(false)
    );
    // A primary mass that rises.
    assert_eq!(
        c4::primary_mass(&b_conservation(1., 1., 0.3)).0,
        Some(false)
    );
    assert_eq!(
        c4::primary_mass(&json!({"verdict": "not executable", "reason": "stock IDA"})).0,
        None
    );
}

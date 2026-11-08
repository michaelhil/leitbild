//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-case-c4-i
//! S3 case C4-I (owner-approved 7 November 2026): C4's drive, then the relief
//! isolation valve closed at a stated time, then a hold. The `ld01-s3-cases-c4i`
//! block's lines judged on the run's frames and logs; no line states a
//! pressure the hold must reach.
use serde_json::{Value, json};

pub const FENCE: &str = "ld01-s3-cases-c4i";

/// The cells C4I.N1 leaves out: the block's excluded cells and the head.
const NOT_CORE_OR_LOOP: [&str; 4] = ["SURGE", "PZR", "HOUSING.MAIN", "HOUSING.NECK"];

/// One run's record, on the case clock (s after zero).
pub struct Run<'a> {
    /// The commanded close.
    pub close_s: f64,
    /// The valve's stroke, from the packet.
    pub stroke_s: f64,
    /// The hold's end, the declared end of the run.
    pub hold_end_s: f64,
    /// The run's own end.
    pub end_s: f64,
    /// The named end, if the run stopped on one.
    pub end_label: &'a str,
    pub failed: bool,
    /// The operator's valve records, as the electrical log has them.
    pub operator: &'a [(f64, String)],
    /// The frame rows of the C4 record.
    pub frames: &'a [Value],
    /// Births: (t, cell name).
    pub births: &'a [(f64, String)],
    /// Lift-offs of seated rods: (t, cluster).
    pub lift_offs: &'a [(f64, String)],
    /// PZR relief receipts other than the malfunction's own and its full lift.
    pub relief_events: &'a [(f64, Value)],
    /// The vapor mass at each exhaustion's root, kg.
    pub root_vapor_kg: &'a [f64],
    /// The divisions' records (requests, monitors).
    pub divisions: &'a [Value],
}

fn number(row: &Value, key: &str) -> Option<f64> {
    row[key].as_f64()
}

/// The first frame at or after `t`.
fn frame_at(frames: &[Value], t: f64) -> Option<&Value> {
    frames
        .iter()
        .find(|r| number(r, "t_s").is_some_and(|u| u >= t - 1e-9))
}

/// A cell's entry on a frame row while it is in equilibrium: (vapor, liquid).
fn equilibrium(row: &Value, cell: &str) -> Option<(f64, f64)> {
    row["cells"].as_array()?.iter().find_map(|c| {
        (c[0] == cell && c[1] == "E").then(|| Some((c[2].as_f64()?, c[3].as_f64()?)))?
    })
}

/// Every declared C4-I line judged; `recorded` lines never decide.
#[allow(clippy::too_many_lines)] // One judge per declared line.
pub fn judge(lines: &Value, run: &Run<'_>) -> Vec<Value> {
    let Some(map) = lines.as_object() else {
        return vec![json!({"id": "C4I", "verdict": "not executable", "reason": "no lines"})];
    };
    let shut_s = run.close_s + run.stroke_s;
    let shut = frame_at(run.frames, shut_s);
    let last = run.frames.last();
    let accepted = run
        .operator
        .iter()
        .find(|(t, m)| (*t - run.close_s).abs() < 1e-9 && m.contains("close: accepted"));
    let after_shut: Vec<&Value> = run
        .frames
        .iter()
        .filter(|r| number(r, "t_s").is_some_and(|t| t >= shut_s - 1e-9))
        .collect();
    let mut out = Vec::new();
    for (id, spec) in map {
        let (verdict, numbers): (&str, Value) = match id.as_str() {
            "O1" => {
                let position = shut.and_then(|r| number(r, "relief_isolation_position"));
                let before = frame_at(run.frames, shut_s - 0.2)
                    .and_then(|r| number(r, "relief_isolation_position"));
                let pass =
                    accepted.is_some() && position == Some(0.) && before.is_some_and(|p| p > 0.);
                (
                    if pass { "pass" } else { "fail" },
                    json!({"close_s": run.close_s, "stroke_s": run.stroke_s, "shut_s": shut_s,
                        "accepted": accepted.map(|a| a.1.clone()), "position_at_shut": position,
                        "position_before_shut": before}),
                )
            }
            "O2" => {
                let most = after_shut
                    .iter()
                    .filter_map(|r| number(r, "relief_kg_s"))
                    .fold(0_f64, |m, v| m.max(v.abs()));
                (
                    if !after_shut.is_empty() && most == 0. {
                        "pass"
                    } else {
                        "fail"
                    },
                    json!({"frames": after_shut.len(), "largest_kg_s": most}),
                )
            }
            "O3" => {
                let (a, b) = (
                    shut.and_then(|r| number(r, "pzr_roof_pa")),
                    last.and_then(|r| number(r, "pzr_roof_pa")),
                );
                let lift_held = after_shut
                    .iter()
                    .all(|r| number(r, "relief_lift").is_some_and(|l| l == 1.));
                let pass = matches!((a, b), (Some(x), Some(y)) if y > x)
                    && lift_held
                    && run.relief_events.is_empty();
                (
                    if pass { "pass" } else { "fail" },
                    json!({"at_shut_pa": a, "at_end_pa": b, "lift_held": lift_held,
                        "relief_events": run.relief_events.len()}),
                )
            }
            "O4" => {
                let (a, b) = (
                    shut.and_then(|r| number(r, "pzr_vapor_zone_kg")),
                    last.and_then(|r| number(r, "pzr_vapor_zone_kg")),
                );
                (
                    if matches!((a, b), (Some(x), Some(y)) if y > x) {
                        "pass"
                    } else {
                        "fail"
                    },
                    json!({"at_shut_kg": a, "at_end_kg": b}),
                )
            }
            "N1" => {
                let found: Vec<&(f64, String)> = run
                    .births
                    .iter()
                    .filter(|(_, c)| !NOT_CORE_OR_LOOP.contains(&c.as_str()))
                    .collect();
                (
                    if found.is_empty() { "pass" } else { "fail" },
                    json!({"births_there": found, "cells_out_of_the_line": NOT_CORE_OR_LOOP}),
                )
            }
            "N2" => {
                let held =
                    !run.failed && run.end_label == "cap_s" && run.end_s >= run.hold_end_s - 1e-6;
                (
                    if held { "pass" } else { "fail" },
                    json!({"end": run.end_label, "end_s": run.end_s, "hold_end_s": run.hold_end_s}),
                )
            }
            "N3" => (
                if run.lift_offs.is_empty() {
                    "pass"
                } else {
                    "fail"
                },
                json!({"lift_offs": run.lift_offs}),
            ),
            "N4" => {
                let others: Vec<&(f64, String)> = run
                    .operator
                    .iter()
                    .filter(|(t, _)| (*t - run.close_s).abs() >= 1e-9)
                    .collect();
                let pass = others.is_empty() && run.relief_events.is_empty();
                (
                    if pass { "pass" } else { "fail" },
                    json!({"operator_records": run.operator, "uncommanded": others,
                        "relief_events": run.relief_events}),
                )
            }
            "M1" => {
                let rows: Vec<Value> = run
                    .frames
                    .iter()
                    .step_by(50)
                    .map(|r| {
                        json!({"t_s": r["t_s"], "roof_pa": r["pzr_roof_pa"],
                        "collapsed_m": r["pzr_collapsed_m"], "mixture_m": r["pzr_mixture_m"]})
                    })
                    .collect();
                let early = last
                    .and_then(|r| number(r, "t_s"))
                    .and_then(|t| frame_at(run.frames, t - 60.));
                let rate = early.zip(last).and_then(|(a, b)| {
                    let dt = number(b, "t_s")? - number(a, "t_s")?;
                    Some((number(b, "pzr_roof_pa")? - number(a, "pzr_roof_pa")?) / dt)
                });
                (
                    "recorded",
                    json!({"series": rows, "rate_at_end_pa_s": rate}),
                )
            }
            "M2" => (
                "recorded",
                json!({"divisions": run.divisions.iter().map(|d| json!({"requests": d["requests"],
                    "monitors": d["monitors"]})).collect::<Vec<_>>()}),
            ),
            "M3" => {
                let liquid = run
                    .frames
                    .iter()
                    .filter_map(|r| equilibrium(r, "HOUSING.NECK").map(|e| e.1))
                    .reduce(f64::min);
                let vapor = last
                    .and_then(|r| equilibrium(r, "HOUSING.NECK"))
                    .map(|e| e.0);
                (
                    "recorded",
                    json!({"neck_liquid_minimum_kg": liquid, "neck_vapor_at_end_kg": vapor}),
                )
            }
            "M4" => (
                "recorded",
                json!({"most_negative_kg": run.root_vapor_kg.iter().copied().reduce(f64::min),
                    "exhaustions": run.root_vapor_kg.len()}),
            ),
            _ => (
                "not executable",
                json!({"reason": "no judge for this line"}),
            ),
        };
        out.push(json!({"id": format!("C4I.{id}"), "kind": spec["kind"], "verdict": verdict, "numbers": numbers}));
    }
    out
}

#[test]
fn the_lines_read_the_frames_and_the_records() {
    let lines = json!({"O1": {"kind": "must"}, "O2": {"kind": "must"}, "O3": {"kind": "must"},
        "O4": {"kind": "must"}, "N1": {"kind": "mustNot"}, "N2": {"kind": "mustNot"},
        "N3": {"kind": "mustNot"}, "N4": {"kind": "mustNot"}, "M3": {"kind": "recorded"},
        "M4": {"kind": "recorded"}});
    let frame = |t: f64, position: f64, relief: f64, roof: f64, zone: f64| {
        json!({"t_s": t, "relief_isolation_position": position, "relief_kg_s": relief,
            "relief_lift": 1., "pzr_roof_pa": roof, "pzr_vapor_zone_kg": zone,
            "cells": [["HOUSING.NECK", "E", 16.4, 222.]]})
    };
    let frames = [
        frame(31.85, 7.5, 3., 12e6, 800.),
        frame(32., 0., 0., 11.6e6, 740.),
        frame(632., 0., 0., 13.9e6, 900.),
    ];
    let operator = [(
        30.,
        "operator LD01.PZR.RELIEF.ISO close: accepted".to_string(),
    )];
    let births = [
        (35., "SURGE".to_string()),
        (43.7, "HOUSING.NECK".to_string()),
    ];
    let run = Run {
        close_s: 30.,
        stroke_s: 2.,
        hold_end_s: 630.,
        end_s: 632.,
        end_label: "cap_s",
        failed: false,
        operator: &operator,
        frames: &frames,
        births: &births,
        lift_offs: &[],
        relief_events: &[],
        root_vapor_kg: &[-1e-7, 2e-9],
        divisions: &[],
    };
    let judged = judge(&lines, &run);
    let verdict = |id: &str| {
        judged.iter().find(|l| l["id"] == id).unwrap()["verdict"]
            .as_str()
            .unwrap()
            .to_string()
    };
    for id in ["O1", "O2", "O3", "O4", "N1", "N2", "N3", "N4"] {
        assert_eq!(verdict(&format!("C4I.{id}")), "pass", "{judged:?}");
    }
    assert_eq!(verdict("C4I.M4"), "recorded");
    // Vapor in a core cell, flow past the shut valve, an early end.
    let births = [(35., "CORE.NE.2".to_string())];
    let frames = [
        frame(32., 0., 1., 11.6e6, 740.),
        frame(632., 0., 1., 13.9e6, 900.),
    ];
    let run = Run {
        births: &births,
        frames: &frames,
        end_label: "solidPzr",
        end_s: 49.8,
        ..run
    };
    let judged = judge(&lines, &run);
    let verdict = |id: &str| judged.iter().find(|l| l["id"] == id).unwrap()["verdict"].clone();
    assert_eq!(verdict("C4I.N1"), "fail");
    assert_eq!(verdict("C4I.O2"), "fail");
    assert_eq!(verdict("C4I.N2"), "fail");
}

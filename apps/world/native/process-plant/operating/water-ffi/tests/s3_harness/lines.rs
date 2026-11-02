//! Every declared sequence line of a case, judged on its [`Timeline`].
//!
//! The block declares each line's kind (`must`, `mustNot`, `may`, `iff`),
//! its windows and its causes; the harness implements what each line
//! observes, reads its numbers from the block and checks that the block's
//! line names the cause it observes. Verdicts:
//! - `pass` / `fail` on the line's observable;
//! - `recorded` for a may-occur line;
//! - `not executable` where the model does not offer what the line needs
//!   (it can never pass);
//! - `not implemented` for a declared line the harness has no judge for
//!   (it can never pass either, so no declared line passes silently).
use super::declaration::Case;
use leitbild_operating_water::unit::timeline::{Timeline, relief_sg};
use serde_json::{Value, json};

/// The judged lines of `case` from its block section `lines` (an object of
/// line id → line), the run's timeline, the cause functions the composed
/// protection implements, and the number of rod clusters.
pub fn judge(
    case: Case,
    lines: &Value,
    tl: &Timeline,
    implemented: &[String],
    clusters: usize,
) -> Vec<Value> {
    let Some(map) = lines.as_object() else {
        return vec![
            json!({"id": format!("{}.lines", case.key()), "verdict": "not implemented",
            "reason": "the block's case has no lines object"}),
        ];
    };
    map.iter()
        .map(|(id, line)| {
            let (verdict, evidence) = match judge_one(case, id, line, tl, implemented, clusters) {
                Ok(x) => x,
                Err(e) => ("not implemented".to_string(), json!({"reason": e})),
            };
            // The block's filled probe values, read as data and reported
            // beside the verdict (r3.8: no TBD left).
            let declared: serde_json::Map<String, Value> =
                ["probe", "marginFraction", "jointSpineConfirmation"]
                    .iter()
                    .filter_map(|k| {
                        line.get(*k)
                            .filter(|v| !v.is_null())
                            .map(|v| ((*k).to_string(), v.clone()))
                    })
                    .collect();
            json!({"id": format!("{}.{id}", case.key()), "kind": line["kind"], "verdict": verdict,
                "evidence": evidence, "declared": declared})
        })
        .collect()
}

/// Whether every judged line passes (a may-occur line is recorded).
pub fn all_pass(judged: &[Value]) -> bool {
    judged
        .iter()
        .all(|l| matches!(l["verdict"].as_str(), Some("pass" | "recorded")))
}

fn kind(line: &Value, expected: &str) -> Result<(), String> {
    match line["kind"].as_str() {
        Some(k) if k == expected => Ok(()),
        other => Err(format!(
            "declared kind {other:?}; the harness judges it as {expected}"
        )),
    }
}
fn names(line: &Value, id: &str) -> Result<(), String> {
    let text = line.to_string();
    if text.contains(id) {
        Ok(())
    } else {
        Err(format!(
            "the line does not name {id}, the cause the harness observes"
        ))
    }
}
fn window(line: &Value, key: &str) -> Result<(f64, f64), String> {
    match line[key]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
    {
        Some(w) if w.len() == 2 && w[0] <= w[1] => Ok((w[0], w[1])),
        _ => Err(format!("no [from, to] window at {key}")),
    }
}
fn verdict(pass: bool) -> String {
    if pass { "pass" } else { "fail" }.to_string()
}

/// A must-not line on causes: `fail` if any accepted, `not executable` if
/// the protection does not implement one of them, else `pass`.
fn no_causes(tl: &Timeline, ids: &[&str], implemented: &[String]) -> (String, Value) {
    let seen: Vec<Value> = ids
        .iter()
        .flat_map(|id| {
            tl.accepted(id)
                .into_iter()
                .map(move |(d, t)| json!({"cause": id, "division": d, "t_s": t}))
        })
        .collect();
    let unacquired: Vec<&&str> = ids
        .iter()
        .filter(|id| !implemented.iter().any(|f| f == *id))
        .collect();
    let v = if !seen.is_empty() {
        "fail".to_string()
    } else if !unacquired.is_empty() {
        "not executable".to_string()
    } else {
        "pass".to_string()
    };
    (
        v,
        json!({"accepted": seen, "not_implemented_by_the_protection": unacquired}),
    )
}

fn crack_openings(tl: &Timeline) -> Vec<(String, f64)> {
    tl.sg_relief
        .iter()
        .filter(|(_, threshold, direction, _)| threshold == "Crack" && *direction > 0)
        .map(|(v, _, _, t)| (v.clone(), *t))
        .collect()
}

#[allow(clippy::too_many_lines)] // One arm per declared line.
fn judge_one(
    case: Case,
    id: &str,
    line: &Value,
    tl: &Timeline,
    implemented: &[String],
    clusters: usize,
) -> Result<(String, Value), String> {
    const HIGH: &str = "LD01.PROT.PZR.HIGH_PRESSURE";
    const LOW: &str = "LD01.PROT.PZR.LOW_PRESSURE";
    const TG: &str = "LD01.PROT.TG.TRIP";
    let elec = "ELEC's slice is not composed in the joined operator (prerequisite 8)";
    match (case, id) {
        (Case::C1, "N1") => {
            kind(line, "mustNot")?;
            names(line, HIGH)?;
            Ok(no_causes(tl, &[HIGH], implemented))
        }
        (Case::C1, "N2") => {
            kind(line, "mustNot")?;
            names(line, LOW)?;
            Ok(no_causes(tl, &[LOW], implemented))
        }
        (Case::C1, "N3") => {
            kind(line, "mustNot")?;
            let sg = crack_openings(tl);
            Ok((
                verdict(sg.is_empty() && tl.pzr_relief_openings.is_empty()),
                json!({"sg_relief_cracks": sg, "pzr_relief_openings": tl.pzr_relief_openings}),
            ))
        }
        (Case::C1, "N4") => {
            kind(line, "mustNot")?;
            let trips: Vec<Value> = tl
                .trips
                .iter()
                .map(|c| json!([c.division, c.function, c.t]))
                .collect();
            Ok((
                verdict(trips.is_empty() && tl.requests.is_empty() && tl.holding_lost.is_none()),
                json!({"trips": trips, "requests": tl.requests.iter().map(|(d, r)| json!([d, r])).collect::<Vec<_>>(),
                    "holding_lost_s": tl.holding_lost}),
            ))
        }
        (Case::C1, "N5") => {
            // "No cause from the S3-implemented protection set": no accepted
            // cause of any function the composed protection implements (the
            // ic section's own list, so the loop-flow-evidence-unavailable
            // causes the block names in prose are judged by their IDs); every
            // ID the block lists must be implemented to be judged.
            kind(line, "mustNot")?;
            names(line, "S3-implemented protection set")?;
            let listed: Vec<String> = line["mustNotCauses"]
                .as_array()
                .ok_or("no mustNotCauses list")?
                .iter()
                .filter_map(|c| c.as_str().map(str::to_string))
                .collect();
            let ids: Vec<&str> = implemented.iter().map(String::as_str).collect();
            let (v, mut evidence) = no_causes(tl, &ids, implemented);
            let unimplemented: Vec<&String> = listed
                .iter()
                .filter(|c| c.starts_with("LD01.") && !implemented.contains(c))
                .collect();
            evidence["listed_ids_not_implemented"] = json!(unimplemented);
            evidence["implemented_not_listed_by_id"] = json!(
                implemented
                    .iter()
                    .filter(|f| !listed.contains(f))
                    .collect::<Vec<_>>()
            );
            evidence["listed_without_a_cause_id"] = json!(
                listed
                    .iter()
                    .filter(|c| !c.starts_with("LD01."))
                    .collect::<Vec<_>>()
            );
            let v = if v == "pass" && !unimplemented.is_empty() {
                "not executable".to_string()
            } else {
                v
            };
            Ok((v, evidence))
        }
        (Case::C1, "M1") | (Case::C2, "M1") | (Case::C3, "M1") => {
            kind(line, "may")?;
            let s: Vec<Value> = tl
                .instants
                .iter()
                .filter(|(_, class, _)| class == "S")
                .map(|(t, _, k)| json!([t, k]))
                .collect();
            Ok((
                "recorded".into(),
                json!({"s_instants": s.len(),
                "causes": tl.causes.iter().map(|c| json!([c.division, c.function, c.t])).collect::<Vec<_>>()}),
            ))
        }
        (Case::C2, "O1") => {
            kind(line, "must")?;
            names(line, TG)?;
            let (from, to) = window(line, "window_s")?;
            let accepted = tl.accepted(TG);
            let powered: Vec<usize> = (0..tl.powered.len()).filter(|i| tl.powered[*i]).collect();
            let in_window = |t: f64| (from - 1e-9..=to + 1e-9).contains(&t);
            let every = !powered.is_empty()
                && powered
                    .iter()
                    .all(|d| accepted.iter().any(|(a, t)| a == d && in_window(*t)));
            let hold = tl.holding_lost.is_some_and(in_window);
            let prhr = tl.requests.iter().any(|(_, r)| r["request"] == "PRHR");
            Ok((
                verdict(every && hold && prhr),
                json!({"window_s": [from, to], "accepted": accepted, "powered": powered,
                    "holding_lost_s": tl.holding_lost, "prhr_requested": prhr}),
            ))
        }
        (Case::C2, "O2") => {
            kind(line, "must")?;
            let (from, to) = window(line, "window_s")?;
            let in_window = |t: f64| t >= from - 1e-9 && t <= to + 1e-9;
            let ramp = tl.stop_ramp_end;
            let Some(open) = tl.electrical_events("GCB Open") else {
                return Ok((
                    if ramp.is_some_and(in_window) {
                        "not executable"
                    } else {
                        "fail"
                    }
                    .into(),
                    json!({"stop_ramp_end_s": ramp, "window_s": [from, to], "generator_breaker": elec}),
                ));
            };
            let opened = open.first().map(|(t, _)| *t);
            Ok((
                verdict(ramp.is_some_and(in_window) && opened.is_some_and(in_window)),
                json!({"stop_ramp_end_s": ramp, "gcb_open_s": opened, "window_s": [from, to]}),
            ))
        }
        (Case::C2, "O3") => {
            kind(line, "must")?;
            let (from, to) = window(line, "window_s")?;
            let Some(done) = tl.electrical_events("transfer to Reserve complete") else {
                return Ok(("not executable".into(), json!({"reason": elec})));
            };
            let all = !done.is_empty()
                && done
                    .iter()
                    .all(|(t, _)| *t >= from - 1e-9 && *t <= to + 1e-9);
            Ok((
                verdict(all),
                json!({"transfers_complete": done.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>(),
                    "window_s": [from, to]}),
            ))
        }
        (Case::C2, "N5") => {
            kind(line, "mustNot")?;
            let Some(dropouts) = tl.electrical_events("contactor undervoltage dropout") else {
                return Ok(("not executable".into(), json!({"reason": elec})));
            };
            Ok((
                verdict(dropouts.is_empty()),
                json!({"dropouts": dropouts.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>()}),
            ))
        }
        (Case::C2, "O4") => {
            kind(line, "must")?;
            let (from, to) = window(line, "afterRelease_s")?;
            let Some(release) = tl.holding_lost else {
                return Ok((
                    "fail".into(),
                    json!({"reason": "no release (holding loss)"}),
                ));
            };
            let last = tl
                .seats
                .iter()
                .map(|(_, t)| *t)
                .fold(f64::NEG_INFINITY, f64::max);
            let mut seated: Vec<&String> = tl.seats.iter().map(|(c, _)| c).collect();
            seated.sort();
            seated.dedup();
            let after = last - release;
            Ok((
                verdict(seated.len() == clusters && after >= from && after <= to + 1e-9),
                json!({"seated": seated.len(), "clusters": clusters, "release_s": release,
                    "last_seat_after_release_s": after, "window_s": [from, to]}),
            ))
        }
        (Case::C2, "O5") => {
            kind(line, "must")?;
            let (from, to) = window(line, "window_s")?;
            let cracks = crack_openings(tl);
            let mut sgs: Vec<&str> = tl
                .sg_relief
                .iter()
                .filter_map(|(v, ..)| relief_sg(v))
                .collect();
            sgs.sort_unstable();
            sgs.dedup();
            let in_window = |sg: &str| {
                cracks
                    .iter()
                    .any(|(v, t)| relief_sg(v) == Some(sg) && *t >= from && *t <= to)
            };
            let first: Vec<Value> = sgs
                .iter()
                .map(|sg| {
                    json!([
                        sg,
                        cracks
                            .iter()
                            .filter(|(v, _)| relief_sg(v) == Some(sg))
                            .map(|(_, t)| *t)
                            .fold(f64::INFINITY, f64::min)
                    ])
                })
                .collect();
            Ok((
                verdict(sgs.len() >= 2 && sgs.iter().all(|s| in_window(s))),
                json!({"first_crack_by_sg_s": first, "window_s": [from, to]}),
            ))
        }
        (Case::C2, "N1") => {
            kind(line, "mustNot")?;
            names(line, HIGH)?;
            let (v, mut evidence) = no_causes(tl, &[HIGH], implemented);
            evidence["pzr_relief_openings"] = json!(tl.pzr_relief_openings);
            let v = if tl.pzr_relief_openings.is_empty() {
                v
            } else {
                "fail".into()
            };
            Ok((v, evidence))
        }
        (Case::C2, "N2") => {
            kind(line, "mustNot")?;
            names(line, LOW)?;
            Ok(no_causes(tl, &[LOW], implemented))
        }
        (Case::C2, "N3") => {
            kind(line, "mustNot")?;
            // S3-D38: the acquired PZR LT vote, recorded by the compiled
            // section's monitor for this line (id "C2.N3 …"), the trip
            // withheld; fail if any division qualified it.
            let Some(monitor) = tl
                .monitors_declared
                .iter()
                .find(|m| m.starts_with("C2.N3 "))
            else {
                return Ok((
                    "not executable".into(),
                    json!({"reason": "the compiled ic section carries no C2.N3 monitor (PZR LT vote)"}),
                ));
            };
            let qualified: Vec<Value> = tl
                .monitors
                .iter()
                .filter(|(m, _, _)| m == monitor)
                .map(|(_, d, t)| json!({"division": d, "t_s": t}))
                .collect();
            Ok((
                verdict(qualified.is_empty()),
                json!({"monitor": monitor, "qualified": qualified}),
            ))
        }
        (Case::C2, "N4") => {
            kind(line, "mustNot")?;
            let ids = ["LD01.PROT.RCS.A.LOW_FLOW", "LD01.PROT.RCS.B.LOW_FLOW"];
            Ok(no_causes(tl, &ids, implemented))
        }
        (Case::C3, "O1") => {
            kind(line, "iff")?;
            let low = "LD01.PROT.RCS.A.LOW_FLOW";
            names(line, low)?;
            if !implemented.iter().any(|f| f == low) {
                return Ok((
                    "not executable".into(),
                    json!({"reason": format!("{low} is not acquired by the composed protection (no loop-flow acquisition)")}),
                ));
            }
            // The cause as accepted, recorded; the iff is the protection
            // consistency gate (A'), not implemented here, and P-3b decides
            // whether the line is must or may.
            let accepted = tl.accepted(low);
            Ok((
                "recorded".into(),
                json!({"accepted": accepted, "first_s": accepted.iter().map(|(_, t)| *t).fold(f64::INFINITY, f64::min),
                    "note": "the iff (consistency gate A') is not implemented; P-3b decides must or may"}),
            ))
        }
        (Case::C3, "O2") => {
            kind(line, "must")?;
            let low = "LD01.PROT.RCS.A.LOW_FLOW";
            if !implemented.iter().any(|f| f == low) {
                return Ok((
                    "not executable".into(),
                    json!({"reason": format!("{low} is not acquired by the composed protection (no loop-flow acquisition)")}),
                ));
            }
            let first = tl
                .accepted(low)
                .iter()
                .map(|(_, t)| *t)
                .fold(f64::INFINITY, f64::min);
            if !first.is_finite() {
                return Ok((
                    "not applicable".into(),
                    json!({"reason": "C3.O1 did not occur, so its trip cannot follow"}),
                ));
            }
            let release = tl.holding_lost.filter(|t| *t >= first - 1e-9);
            let mut seated: Vec<&String> = tl.seats.iter().map(|(c, _)| c).collect();
            seated.sort();
            seated.dedup();
            let prhr = tl.requests.iter().any(|(_, r)| r["request"] == "PRHR");
            Ok((
                verdict(release.is_some() && seated.len() == clusters && prhr),
                json!({"low_flow_s": first, "release_s": release, "seated": seated.len(), "clusters": clusters,
                    "last_seat_s": tl.seats.iter().map(|(_, t)| *t).fold(f64::NEG_INFINITY, f64::max),
                    "prhr_requested": prhr}),
            ))
        }
        (Case::C3, "N1") => {
            kind(line, "mustNot")?;
            names(line, "LD01.PROT.RCS.B.LOW_FLOW")?;
            Ok(no_causes(tl, &["LD01.PROT.RCS.B.LOW_FLOW"], implemented))
        }
        (Case::C3, "N2") => {
            kind(line, "mustNot")?;
            let low = "LD01.PROT.RCS.A.LOW_FLOW";
            let cmt = tl.requests.iter().any(|(_, r)| r["request"] == "CMT");
            let relief = !tl.pzr_relief_openings.is_empty();
            let first = tl
                .accepted(low)
                .iter()
                .map(|(_, t)| *t)
                .fold(f64::INFINITY, f64::min);
            let before: Vec<Value> = tl
                .causes
                .iter()
                .filter(|c| c.function != low && c.t < first)
                .map(|c| json!([c.division, c.function, c.t]))
                .collect();
            let evidence = json!({"cmt_requested": cmt, "pzr_relief_openings": tl.pzr_relief_openings,
                "low_flow_s": if first.is_finite() { json!(first) } else { Value::Null },
                "causes_before_low_flow": before});
            if cmt || relief || !before.is_empty() {
                return Ok(("fail".into(), evidence));
            }
            if implemented.iter().any(|f| f == low) {
                Ok(("pass".into(), evidence))
            } else {
                Ok(("not executable".into(), evidence))
            }
        }
        _ => Err(format!("the harness has no judge for {}.{id}", case.key())),
    }
}

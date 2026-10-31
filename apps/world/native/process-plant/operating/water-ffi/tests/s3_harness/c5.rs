//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-draft-case-c5
//! Case C5 (loss of offsite power with the Grid handoff, C5L lane): the
//! pinned `ld01-s3-cases-c5` block's exchange plan, sequence lines and
//! directions, each a pure judge on a run's records.
//!
//! - [`exchange_bounds`]: the test-only Grid stand-in's C5 interval
//!   boundaries (C5X's `ld01-grid-standin.ts` `boundaries()` under owner D1
//!   with S3-D42's connected-only window), reproduced in-process so the
//!   gated harness drives the same exchanges the C5 host receives;
//! - [`judge`]: lines O1–O5, N1–N2, M1–M2, windows and rules read from the
//!   block; a part the run cannot show is reported, never passed;
//! - [`directions`]: rule B's signed checks on the frame-grid samples.
use leitbild_operating_water::unit::timeline::{Timeline, relief_sg};
use serde_json::{Value, json};

/// The block's fence.
pub const FENCE: &str = "ld01-s3-cases-c5";

/// `ld01-sg-relief crackPressure_Pa`, the "rises to relief" target the
/// block's SG direction names (6.8 MPa).
pub const SG_CRACK_PA: f64 = 6.8e6;

/// The six motor consumers of `ld01-ac-distribution` the O2 line names.
pub const MOTORS: [&str; 6] = [
    "LD01.P.A1",
    "LD01.P.A2",
    "LD01.P.B1",
    "LD01.P.B2",
    "LD01.FW.P1",
    "LD01.FW.P2",
];

/// The stand-in's interval ends `(t1, window)` from the unit's start `t0`
/// to `end` (absolute s): quiet intervals on the `quiet_s` grid from `t0`,
/// the last split exactly at the offsite loss `te`; from `te` a dead bus
/// keeps the quiet cadence (S3-D42: no grid-event window for a unit that
/// is not connected) up to the plant's window end `te + window_s`; then the
/// quiet grid from `t0` again.
pub fn exchange_bounds(
    t0: f64,
    te: f64,
    window_s: f64,
    end: f64,
    quiet_s: f64,
) -> Vec<(f64, bool)> {
    let we = te + window_s;
    // Each segment's next end follows from its previous end alone, until
    // the segment's end is reached (a time grid, not an iterate).
    let quiet: Vec<f64> = std::iter::successors(Some(t0), |&t| {
        (t < te - 1e-9).then(|| (t0 + ((t - t0) / quiet_s + 1.).round() * quiet_s).min(te))
    })
    .skip(1)
    .collect();
    let from = quiet.last().copied().unwrap_or(t0);
    let window: Vec<f64> = std::iter::successors(Some((from, 0.)), |&(t, k): &(f64, f64)| {
        (t < we.min(end) - 1e-9).then(|| ((te + (k + 1.) * quiet_s).min(we).min(end), k + 1.))
    })
    .skip(1)
    .map(|(t, _)| t)
    .collect();
    let from = window.last().copied().unwrap_or(from);
    let after: Vec<f64> = std::iter::successors(Some(from), |&t| {
        (t < end - 1e-9)
            .then(|| (t0 + ((t - t0) / quiet_s + 1e-9 + 1.).floor() * quiet_s).min(end))
    })
    .skip(1)
    .collect();
    quiet
        .into_iter()
        .map(|t| (t, false))
        .chain(window.into_iter().map(|t| (t, true)))
        .chain(after.into_iter().map(|t| (t, false)))
        .collect()
}

/// One exchange interval's receipt on the case clock (s after the loss):
/// the slice's export quadrature over `[from, to]` and the unit and
/// reserve auxiliary draws.
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub from: f64,
    pub to: f64,
    pub export_j: f64,
    pub unit_draw_j: f64,
    pub reserve_draw_j: f64,
}

/// What the C5 lines read beyond the timeline (all on the case clock).
pub struct Record<'a> {
    pub tl: &'a Timeline,
    /// The routing's own record times: `(t, what)`.
    pub routing: &'a [(f64, String)],
    /// Interval receipts (a gated run: the slice's quadratures), else empty.
    pub receipts: &'a [Receipt],
    /// RCPs supported, and whether a feed pump is supplied, right after the
    /// offsite loss's instant.
    pub rcp_supported_after: Option<usize>,
    pub feed_after: Option<bool>,
    /// The field controller's initiation (`{cause, frame, t_s}`), absolute.
    pub field_initiated: Option<(String, f64)>,
    pub implemented: &'a [String],
    pub clusters: usize,
    /// Collapsed PZR level: at t0 and the lowest after it `(t, m)`.
    pub level_at_zero: Option<f64>,
    pub level_min_after: Option<(f64, f64)>,
    /// PT1 at t0 and its highest sample after it.
    pub pt1_at_zero: Option<f64>,
    pub pt1_max_after: Option<(f64, f64)>,
}

/// Two instants are one at the frame driver's resolution (100 ulp of the
/// larger magnitude, `frame::same_instant`), case-clock times offset by an
/// absolute zero of O(1e3) s.
fn same(a: f64, b: f64, zero: f64) -> bool {
    (a - b).abs() <= 100. * f64::EPSILON * (a.abs() + b.abs() + 2. * zero.abs())
}
fn within(t: f64, from: f64, to: f64, zero: f64) -> bool {
    (t >= from || same(t, from, zero)) && (t <= to || same(t, to, zero))
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
fn kind(line: &Value, expected: &str) -> Result<(), String> {
    match line["kind"].as_str() {
        Some(k) if k == expected => Ok(()),
        other => Err(format!(
            "declared kind {other:?}; the harness judges it as {expected}"
        )),
    }
}
fn verdict(pass: bool) -> String {
    if pass { "pass" } else { "fail" }.to_string()
}

/// Every C5 line of the block's `lines`, judged on `r`; `zero` is the
/// absolute case zero (for the instant resolution only).
pub fn judge(lines: &Value, r: &Record<'_>, zero: f64) -> Vec<Value> {
    let Some(map) = lines.as_object() else {
        return vec![
            json!({"id": "C5.lines", "verdict": "not implemented", "reason": "no lines object"}),
        ];
    };
    map.iter()
        .map(|(id, line)| {
            let (v, evidence) = match judge_one(id, line, r, zero) {
                Ok(x) => x,
                Err(e) => ("not implemented".to_string(), json!({"reason": e})),
            };
            json!({"id": format!("C5.{id}"), "kind": line["kind"], "verdict": v, "evidence": evidence})
        })
        .collect()
}

#[allow(clippy::too_many_lines)] // One arm per declared line.
fn judge_one(id: &str, line: &Value, r: &Record<'_>, zero: f64) -> Result<(String, Value), String> {
    const TG: &str = "LD01.PROT.TG.TRIP";
    let tl = r.tl;
    let elec = |what: &str| tl.electrical_events(what).unwrap_or_default();
    // O3's decision instant: the field controller's GCB OPEN request.
    let request = elec("GCB OPEN requested by LD01.TG.GEN.FIELD.SUPPLY_LOSS")
        .first()
        .map(|(t, _)| *t);
    match id {
        "O1" => {
            kind(line, "must")?;
            let lost = elec("offsite connection lost").first().map(|(t, _)| *t);
            let at_zero = lost.is_some_and(|t| same(t, 0., zero));
            let before = r.receipts.iter().rfind(|q| q.to <= 1e-9);
            let after: Vec<&Receipt> = r.receipts.iter().filter(|q| q.from >= -1e-9).collect();
            let step = before.is_some_and(|q| q.export_j > 0.)
                && !after.is_empty()
                && after.iter().all(|q| q.export_j == 0.);
            let rcp = r.rcp_supported_after == Some(0);
            let feed = r.feed_after == Some(false);
            let evidence = json!({"offsite_lost_s": lost, "export_before_j": before.map(|q| q.export_j),
                "export_after_j_max_abs": after.iter().map(|q| q.export_j.abs()).fold(0., f64::max),
                "intervals_after": after.len(), "rcp_supported_after": r.rcp_supported_after, "feed_supplied_after": r.feed_after,
                "rcp_supply_lost": elec("supply lost").iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>()});
            if r.receipts.is_empty() {
                return Ok((
                    "not executable".into(),
                    json!({"reason": "no interval receipts (a gated run carries the slice's quadratures)", "partial": evidence}),
                ));
            }
            Ok((verdict(at_zero && step && rcp && feed), evidence))
        }
        "O2" => {
            kind(line, "must")?;
            let (from, to) = window(line, "window_s")?;
            let text = line["action"].as_str().unwrap_or_default();
            let mut per: Vec<Value> = Vec::new();
            let mut ok = true;
            for m in MOTORS {
                if !text.contains(m) {
                    return Err(format!("O2 does not name {m}"));
                }
                let t = r
                    .routing
                    .iter()
                    .find(|(_, w)| w.starts_with(m) && w.contains("contactor undervoltage dropout"))
                    .map(|(t, _)| *t);
                ok &= t.is_some_and(|t| within(t, from, to, zero));
                per.push(json!([m, t]));
            }
            let logged: Vec<Value> = elec("contactor undervoltage dropout")
                .iter()
                .map(|(t, w)| json!([t, w]))
                .collect();
            Ok((
                verdict(ok),
                json!({"window_s": [from, to], "routing_record_s": per,
                "slice_log_s": logged, "note": "judged on the routing's own record times (the slice log stamps them at its next restart, DR-C5X-LOG)"}),
            ))
        }
        "O3" => {
            kind(line, "must")?;
            let (from, to) = window(line, "window_s")?;
            let travel = line["breakerTravel_s"]
                .as_f64()
                .ok_or("O3 has no breakerTravel_s")?;
            let by_trip = elec("GCB OPEN requested by the turbine trip");
            let open = elec("GCB Open").first().map(|(t, _)| *t);
            let field = r
                .field_initiated
                .as_ref()
                .map(|(c, t)| json!({"cause": c, "t_after_zero_s": t - zero}));
            let Some(q) = request else {
                return Ok((
                    "fail".into(),
                    json!({"reason": "no GCB OPEN request by the field controller", "field_controller": field}),
                ));
            };
            let trip_same = by_trip.iter().any(|(t, _)| same(*t, q, zero));
            let in_window = q > from && within(q, from, to, zero);
            let opened = open.is_some_and(|t| same(t, q + travel, zero));
            let ramp = tl.stop_ramp_end.is_some_and(|t| same(t, q + travel, zero));
            Ok((
                verdict(in_window && trip_same && opened && ramp),
                json!({"request_s": q, "window_s": [from, to],
                "turbine_trip_same_instant": trip_same, "gcb_open_s": open, "stop_ramp_end_s": tl.stop_ramp_end,
                "breaker_travel_s": travel, "field_controller": field}),
            ))
        }
        "O4" => {
            kind(line, "must")?;
            if !line.to_string().contains(TG) {
                return Err(format!("O4 does not name {TG}"));
            }
            let (from, to) = window(line, "window_s")?;
            let (sf, st) = window(line, "seatsAfterRelease_s")?;
            let Some(q) = request else {
                return Ok((
                    "fail".into(),
                    json!({"reason": "no turbine trip from the field controller (O3)"}),
                ));
            };
            let accepted = tl.accepted(TG);
            let powered: Vec<usize> = (0..tl.powered.len()).filter(|i| tl.powered[*i]).collect();
            let every = !powered.is_empty()
                && powered.iter().all(|d| {
                    accepted
                        .iter()
                        .any(|(a, t)| a == d && within(*t - q, from, to, zero))
                });
            let first = tl.causes.iter().map(|c| c.t).fold(f64::INFINITY, f64::min);
            let hold = tl.holding_lost.is_some_and(|h| same(h, first, zero));
            let prhr = powered.iter().all(|d| {
                tl.requests
                    .iter()
                    .any(|(rd, rq)| rd == d && rq["request"] == "PRHR" && rq["by"] == TG)
            });
            let last = tl
                .seats
                .iter()
                .map(|(_, t)| *t)
                .fold(f64::NEG_INFINITY, f64::max);
            let mut seated: Vec<&String> = tl.seats.iter().map(|(c, _)| c).collect();
            seated.sort();
            seated.dedup();
            let after = tl.holding_lost.map(|h| last - h);
            let seats =
                seated.len() == r.clusters && after.is_some_and(|a| a >= sf && a <= st + 1e-9);
            Ok((
                verdict(every && hold && prhr && seats),
                json!({"turbine_trip_s": q,
                "accepted_after_trip_s": accepted.iter().map(|(d, t)| json!([d, t - q])).collect::<Vec<_>>(),
                "window_after_trip_s": [from, to], "powered": powered, "first_cause_s": first,
                "holding_lost_s": tl.holding_lost, "prhr_by_tg_trip": prhr, "seated": seated.len(), "clusters": r.clusters,
                "last_seat_after_release_s": after, "seats_window_s": [sf, st],
                "rule_a_prime": "not judged by this harness for LD01.PROT.TG.TRIP's turbine-state report (C4's A′ covers PZR pressure only): every accepted cause is listed in the timeline"}),
            ))
        }
        "O5" => {
            kind(line, "must")?;
            let (from, to) = window(line, "window_s")?;
            let cracks: Vec<(String, f64)> = tl
                .sg_relief
                .iter()
                .filter(|(_, th, d, t)| th == "Crack" && *d > 0 && *t >= -1e-9)
                .map(|(v, _, _, t)| (v.clone(), *t))
                .collect();
            let first = |sg: &str| {
                cracks
                    .iter()
                    .filter(|(v, _)| relief_sg(v) == Some(sg))
                    .map(|(_, t)| *t)
                    .fold(f64::INFINITY, f64::min)
            };
            let (a, b) = (first("A"), first("B"));
            let later = a.max(b);
            let pass = within(a, from, to, zero) && within(b, from, to, zero);
            Ok((
                verdict(pass),
                json!({"first_crack_s": {"A": if a.is_finite() { json!(a) } else { Value::Null },
                "B": if b.is_finite() { json!(b) } else { Value::Null }}, "window_s": [from, to],
                "margin": if later.is_finite() { json!((to - later) / (to - from)) } else { Value::Null },
                "declared_margin": line["marginFraction"]}),
            ))
        }
        "N1" => {
            kind(line, "mustNot")?;
            let cmt: Vec<Value> = tl
                .requests
                .iter()
                .filter(|(_, q)| q["request"].as_str().is_some_and(|s| s.contains("CMT")))
                .map(|(d, q)| json!([d, q]))
                .collect();
            Ok((verdict(cmt.is_empty()), json!({"cmt_requests": cmt})))
        }
        "N2" => {
            kind(line, "mustNot")?;
            let level = json!({"at_zero_m": r.level_at_zero, "lowest_after_m": r.level_min_after,
                "margin": match (r.level_at_zero, r.level_min_after) { (Some(l0), Some((_, m))) => json!((m - 3.) / (l0 - 3.)), _ => Value::Null },
                "declared_margin": line["marginFraction"], "setpoint_m": 3.0});
            // S3-D38: the section's recorded PZR LT vote monitor.
            let Some(monitor) = tl
                .monitors_declared
                .iter()
                .find(|m| m.contains("PZR LT vote"))
            else {
                return Ok((
                    "not executable".into(),
                    json!({"reason": "the compiled ic section carries no PZR LT vote monitor", "level": level}),
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
                json!({"monitor": monitor, "qualified": qualified, "level": level}),
            ))
        }
        "M1" => {
            kind(line, "may")?;
            let high: Vec<Value> = tl
                .causes
                .iter()
                .filter(|c| c.function == "LD01.PROT.PZR.HIGH_PRESSURE")
                .map(|c| json!([c.division, c.t]))
                .collect();
            Ok((
                "recorded".into(),
                json!({"high_pressure": high, "pzr_relief_openings": tl.pzr_relief_openings,
                "pt1_at_zero_pa": r.pt1_at_zero, "pt1_highest_after": r.pt1_max_after}),
            ))
        }
        "M2" => {
            kind(line, "may")?;
            let others: Vec<Value> = tl
                .causes
                .iter()
                .filter(|c| c.function != TG && c.function != "LD01.PROT.PZR.HIGH_PRESSURE")
                .map(|c| json!([c.division, c.function, c.t]))
                .collect();
            let low_flow = others
                .iter()
                .any(|c| c[1].as_str().is_some_and(|f| f.contains("LOW_FLOW")));
            Ok((
                "recorded".into(),
                json!({"causes": others, "low_flow_accepted": low_flow,
                "low_flow_a_prime": "iff its predicate: not judged by this harness (no low-flow A′ check); recorded",
                "requests": tl.requests.iter().map(|(d, q)| json!([d, q])).collect::<Vec<_>>(),
                "routing": r.routing.iter().filter(|(_, w)| w.contains("qualification") || w.contains("transfer")).map(|(t, w)| json!([t, w])).collect::<Vec<_>>(),
                "s_instants": tl.instants.iter().filter(|(_, c, _)| c == "S").count(),
                "sg_relief": tl.sg_relief.iter().map(|(v, th, d, t)| json!([v, th, d, t])).collect::<Vec<_>>()}),
            ))
        }
        _ => Err(format!("the harness has no judge for C5.{id}")),
    }
}

/// One signal's samples on the case clock: `(t, value)`.
pub type Series = Vec<(f64, f64)>;

fn at_or_before(s: &Series, t: f64) -> Option<f64> {
    s.iter()
        .filter(|(x, _)| *x <= t + 1e-9)
        .map(|(_, v)| *v)
        .next_back()
}
fn max_after(s: &Series, t: f64) -> Option<(f64, f64)> {
    s.iter()
        .filter(|(x, _)| *x > t + 1e-9)
        .copied()
        .reduce(|a, b| if b.1 > a.1 { b } else { a })
}

/// One shape check (the block's `shape`) on `s` from `from` (t0 or the
/// holding loss) to its last sample; `window_end` for "briefly".
pub fn shape(shape: &str, s: &Series, from: f64, window_end: f64) -> (String, Value) {
    let (Some(v0), Some(&(t_end, v_end))) = (at_or_before(s, from), s.last()) else {
        return ("not executable".into(), json!({"reason": "no samples"}));
    };
    let peak = max_after(s, from);
    let pass = match shape {
        "falls" | "falls after the trip" => v_end < v0 && peak.is_none_or(|(_, p)| p <= v0),
        "rises, then falls" => peak.is_some_and(|(_, p)| p > v0 && v_end < p),
        "rises briefly, then falls" => {
            peak.is_some_and(|(tp, p)| p > v0 && tp <= window_end + 1e-9) && v_end < v0
        }
        "rises to relief" => peak.is_some_and(|(_, p)| p >= SG_CRACK_PA),
        other => {
            return (
                "not implemented".into(),
                json!({"reason": format!("shape {other:?}")}),
            );
        }
    };
    (
        verdict(pass),
        json!({"from_s": from, "at_from": v0, "peak": peak.map(|(t, p)| json!([t, p])),
        "end": [t_end, v_end], "samples": s.len()}),
    )
}

/// Rule B for C5: each declared direction's signed check. `signals` maps a
/// parameter to its series (several for per-SG/per-rotor/per-loop ones);
/// `hold` is the holding loss (case clock); `window_s` the event window.
pub fn directions(
    spec: &Value,
    signals: &[(&str, Vec<Series>)],
    hold: Option<f64>,
    window_s: f64,
    feed_after_zero: &[(f64, bool)],
    receipts: &[Receipt],
) -> Value {
    let Some(list) = spec["directions"].as_array() else {
        return json!({"family": "B directions", "verdict": "not executable", "reason": "no directions"});
    };
    let mut lines = Vec::new();
    for d in list {
        let p = d["parameter"].as_str().unwrap_or_default();
        let s = d["shape"].as_str().unwrap_or_default();
        let entry = match p {
            "feed flow" => {
                let any = feed_after_zero
                    .iter()
                    .filter(|(t, _)| *t > 1e-9)
                    .any(|(_, f)| *f);
                let n = feed_after_zero.iter().filter(|(t, _)| *t > 1e-9).count();
                json!({"verdict": if n == 0 { "not executable" } else if any { "fail" } else { "pass" },
                    "frames_after_zero": n, "supplied_at_any": any})
            }
            "Grid export" => {
                let after: Vec<&Receipt> = receipts.iter().filter(|q| q.from >= -1e-9).collect();
                let worst = after.iter().map(|q| q.export_j.abs()).fold(0., f64::max);
                json!({"verdict": if after.is_empty() { "not executable" } else if worst == 0. { "pass" } else { "fail" },
                    "intervals_after_zero": after.len(), "largest_abs_export_j": worst})
            }
            "Grid frequency" => {
                json!({"verdict": "not executable", "reason": d["check"]})
            }
            _ => match signals.iter().find(|(k, _)| *k == p) {
                None => json!({"verdict": "not executable", "reason": "no signal recorded"}),
                Some((_, all)) => {
                    let from = if s == "falls after the trip" {
                        hold.unwrap_or(f64::NAN)
                    } else {
                        0.
                    };
                    if from.is_nan() {
                        json!({"verdict": "not executable", "reason": "no holding loss"})
                    } else {
                        let each: Vec<Value> = all
                            .iter()
                            .map(|x| {
                                let (v, e) = shape(s, x, from, window_s);
                                json!({"verdict": v, "values": e})
                            })
                            .collect();
                        let v = if each.iter().any(|e| e["verdict"] == "fail") {
                            "fail"
                        } else if each.iter().all(|e| e["verdict"] == "pass") && !each.is_empty() {
                            "pass"
                        } else {
                            "not executable"
                        };
                        json!({"verdict": v, "instances": each})
                    }
                }
            },
        };
        let mut e = entry;
        e["parameter"] = json!(p);
        e["shape"] = json!(s);
        e["signal"] = d["signal"].clone();
        lines.push(e);
    }
    let verdict = if lines.iter().any(|l| l["verdict"] == "fail") {
        "fail"
    } else if lines.iter().all(|l| l["verdict"] == "pass") {
        "pass"
    } else {
        "incomplete"
    };
    json!({"family": "B directions", "verdict": verdict,
        "basis": "signed checks on the 0.1 s output samples (the block's directions; magnitudes reported, rule C)",
        "lines": lines})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stand_ins_boundaries_split_at_the_loss_and_keep_the_quiet_cadence_on_a_dead_bus() {
        let b = exchange_bounds(548., 558.37, 30., 668., 1.);
        // 10 whole seconds, then the split at the loss.
        assert_eq!(b[9], (558., false));
        assert_eq!(b[10], (558.37, false));
        // Dead bus: 1 s from the loss to the window's end (S3-D42).
        assert_eq!(b[11], (559.37, true));
        assert_eq!(b[40], (588.37, true));
        // Then the whole-second grid again.
        assert_eq!(b[41], (589., false));
        assert_eq!(b.last(), Some(&(668., false)));
        assert_eq!(b.len(), 41 + 80);
    }

    #[test]
    fn shapes_are_signed_checks_with_no_threshold() {
        let rise_fall: Series = vec![(-1., 1.), (0., 1.), (1., 2.), (5., 0.5)];
        assert_eq!(shape("rises, then falls", &rise_fall, 0., 30.).0, "pass");
        assert_eq!(shape("falls", &rise_fall, 0., 30.).0, "fail");
        assert_eq!(
            shape("rises briefly, then falls", &rise_fall, 0., 30.).0,
            "pass"
        );
        assert_eq!(
            shape("rises briefly, then falls", &rise_fall, 0., 0.5).0,
            "fail"
        );
        let falls: Series = vec![(0., 3.), (1., 2.), (2., 1.)];
        assert_eq!(shape("falls", &falls, 0., 30.).0, "pass");
        let sg: Series = vec![(0., 6.3e6), (2., 6.82e6), (9., 6.81e6)];
        assert_eq!(shape("rises to relief", &sg, 0., 30.).0, "pass");
    }
}

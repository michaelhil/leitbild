//! The S3 gate families the case harness judges beside the sequence lines
//! (the r3 declaration's common rules, the r3.7 block's numbers), each as
//! a pure judge on a run's records, each with its own receipt section,
//! verdict and threshold source:
//!
//! - **G cost** ([`cost`]): the run's recurring CPU (the run's thread less
//!   the gate harness's own observation) per simulated second over the
//!   declared spans, against `budgets_cpu_s_per_s`: S3's unit budget over
//!   the run; S2's quiet budget (C1), trip average (C2), window and
//!   recovery (C2, C3). Every value is provisional (macOS, owner F1).
//! - **F smoothness** ([`jumps`], [`smoothness`]): a second-difference
//!   detector on each recorded signal, each flagged jump mapped to a
//!   logged instant. It is judged only with a declared threshold.
//! - **H repeatability** ([`repeatability`]): the sampled trajectory's
//!   fingerprint and the end state, bitwise, between two runs on one host.
//! - **K post-event spectra** ([`spectra`]): Z6's predicate as S2 judges it
//!   (an external SPECTRUM receipt whose verdict is GO), at the start state
//!   and at each declared post-event state.
//! - **B directions** ([`directions`]): the sign statements the block
//!   declares for a case.
//! - **C1 SS-1** ([`ss1`]): the filtered ranges over the declared duration.
//! - **C1 SS-2** ([`ss2`]): the conservation record's balances.
use crate::filter::{larger, zero_phase_lowpass};
use crate::s3_harness::declaration::Case;
use serde_json::{Value, json};

/// The provisional label every S3 CPU figure carries (owner answer F1).
pub const PROVISIONAL: &str = "provisional (macOS, owner F1: no 6-8-core Linux host)";

/// One gate entry.
pub fn gate(id: &str, value: Value, bound: Value, verdict: &str, source: &str) -> Value {
    json!({"id": id, "value": value, "bound": bound, "verdict": verdict, "threshold_source": source})
}

/// CPU over `[from, to]` (simulated s) from monotone `(t, cpu)` marks: the
/// marks at or nearest inside the span's ends.
pub fn span_cpu(marks: &[(f64, f64)], from: f64, to: f64) -> Option<(f64, f64, f64)> {
    let tol = 1e-9 * to.abs().max(1.);
    let a = marks.iter().find(|(t, _)| *t >= from - tol)?;
    let b = marks.iter().rev().find(|(t, _)| *t <= to + tol)?;
    (b.0 > a.0).then(|| (a.0, b.0, (b.1 - a.1) / (b.0 - a.0)))
}

/// One cost mark: `t − zero`, then CPU-s and instructions with rule I
/// counted as plant work (S3-D46), then both without rule I (reported).
/// An instruction count the counters could not read is NaN.
pub type Mark = (f64, f64, f64, f64, f64);

/// Rule G against the block's budgets on an ungated drive's marks. `end`
/// is the declared part's end after zero (rule I's exit or the run's end),
/// `window` the declared window, `recovery` S1's post-window span,
/// `trip_from` where the trip average starts (C2: the trip; C3: the
/// acquired reactor trip). Each span is reported as raw thread CPU and, with
/// `quiet_ratio` (instructions per quiet CPU-s, the common rule), as
/// quiet-equivalent CPU-s per simulated second; the verdict reads the
/// quiet-equivalent with rule I counted (S3-D46) when the ratio is given,
/// else the raw value. An unreadable instruction count is an error, never
/// zero; `same_trajectory` false (the cost drive left the run's
/// trajectory) fails the family.
#[allow(clippy::too_many_arguments)] // The case, its budgets, marks and spans.
pub fn cost(
    case: Case,
    budgets: &Value,
    marks: &[Mark],
    end: f64,
    window: Option<f64>,
    recovery: f64,
    trip_from: Option<f64>,
    quiet_ratio: Option<(f64, String)>,
    same_trajectory: Option<bool>,
) -> Value {
    let series = |f: &dyn Fn(&Mark) -> f64| -> Vec<(f64, f64)> {
        marks.iter().map(|m| (m.0, f(m))).collect()
    };
    let cpu = series(&|m| m.1);
    let ins = series(&|m| m.2);
    let cpu_without = series(&|m| m.3);
    let ins_without = series(&|m| m.4);
    let mut gates = Vec::new();
    let mut entry = |id: &str, key: &str, from: f64, to: f64, declared: f64| {
        let Some(bound) = budgets[key].as_f64() else {
            gates.push(gate(
                id,
                Value::Null,
                Value::Null,
                "not executable",
                &format!("budgets_cpu_s_per_s.{key} absent"),
            ));
            return;
        };
        let to_cut = to.min(end);
        let truncated = to_cut < declared - 1e-9;
        let source = format!("ld01-s3-cases-c1c3 budgets_cpu_s_per_s.{key}");
        let Some((a, b, raw)) = span_cpu(&cpu, from, to_cut) else {
            gates.push(json!({"id": id, "value": null, "bound": bound, "verdict": if truncated { "truncated (rule I), not failed" } else { "not executable" },
                "declared_span_s": [from, declared], "truncated_by_rule_i": truncated, "threshold_source": source, "label": PROVISIONAL}));
            return;
        };
        let per_s = |s: &[(f64, f64)]| span_cpu(s, from, to_cut).map(|x| x.2);
        let quiet = quiet_ratio
            .as_ref()
            .map(|(r, _)| per_s(&ins).map(|i| i / r));
        let quiet_without = quiet_ratio
            .as_ref()
            .map(|(r, _)| per_s(&ins_without).map(|i| i / r));
        let (value, verdict) = match quiet {
            Some(Some(q)) if q.is_finite() => (q, if q <= bound { "pass" } else { "fail" }),
            Some(_) => (f64::NAN, "error: the instruction counter could not be read"),
            None => (raw, if raw <= bound { "pass" } else { "fail" }),
        };
        gates.push(json!({"id": id, "value": if value.is_finite() { json!(value) } else { Value::Null },
            "basis": if quiet.is_some() { "quiet-equivalent (instructions retired / quiet ratio), rule I counted (S3-D46)" } else { "raw thread CPU, rule I counted (S3-D46)" },
            "raw_cpu_s_per_s": raw, "quiet_equivalent_cpu_s_per_s": quiet.flatten(),
            "without_rule_i": {"raw_cpu_s_per_s": per_s(&cpu_without), "quiet_equivalent_cpu_s_per_s": quiet_without.flatten()},
            "instructions_per_s": per_s(&ins),
            "bound": bound, "verdict": verdict,
            "span_s": [a, b], "declared_span_s": [from, declared], "truncated_by_rule_i": truncated,
            "threshold_source": source, "label": PROVISIONAL}));
    };
    let last = marks.last().map_or(0., |m| m.0);
    entry(
        "cost.s3_unit",
        "s3UnitRecurringIncludingEvents",
        0.,
        last,
        last,
    );
    match case {
        Case::C1 => entry("cost.s2_quiet", "s2Quiet", 0., last, last),
        Case::C2 | Case::C3 | Case::C5 => {
            if case == Case::C5 {
                // C5L: the run from its start (the 10.37 s before the
                // offsite loss included), beside S3GATES's span from zero.
                let first = marks.first().map_or(0., |m| m.0);
                entry(
                    "cost.s3_unit_from_start",
                    "s3UnitRecurringIncludingEvents",
                    first,
                    last,
                    last,
                );
            }
            if let Some(w) = window {
                entry("cost.s2_window", "s2WindowAndRecovery", 0., w, w);
                // S2's H1: each event window plus its recovery.
                entry(
                    "cost.s2_window_and_recovery",
                    "s2WindowAndRecovery",
                    0.,
                    w + recovery,
                    w + recovery,
                );
            }
            match trip_from {
                Some(from) => entry("cost.s2_trip_average", "s2TripAverage", from, last, last),
                None => gates.push(json!({"id": "cost.s2_trip_average", "verdict": "not applicable", "reason": "no trip in the run"})),
            }
        }
    }
    let mut verdict = overall_of(gates.iter().map(|g| g["verdict"].as_str().unwrap_or("?")));
    let trajectory = match same_trajectory {
        Some(false) => {
            verdict = "fail";
            json!({"verdict": "fail", "reason": "the cost drive's frames differ from the run's"})
        }
        Some(true) => {
            json!({"verdict": "pass", "rule": "the cost drive's frame records equal the run's"})
        }
        None => json!("measured on the run itself"),
    };
    json!({"family": "G cost", "verdict": verdict, "label": PROVISIONAL,
        "measure": "the run's thread CPU and the process's instructions retired per simulated second, rule I counted as plant work (S3-D46; also reported without it); a gated run is measured on an ungated drive of the same trajectory. Only quiet-window CPU counts as evidence at the gate run",
        "quiet_ratio": quiet_ratio.as_ref().map(|(r, src)| json!({"instructions_per_cpu_s": r, "source": src})),
        "same_trajectory": trajectory, "gates": gates})
}

/// The verdict of a set of entries: "fail" if any fails, "error" if any
/// errs, "pass" only if every entry passes (or is not applicable), else
/// "incomplete". Incomplete, unevaluable and not-executable entries never
/// pass.
pub fn overall_of<'a>(verdicts: impl Iterator<Item = &'a str>) -> &'static str {
    let v: Vec<&str> = verdicts.collect();
    if v.contains(&"fail") {
        "fail"
    } else if v.iter().any(|x| x.starts_with("error")) {
        "error"
    } else if !v.is_empty() && v.iter().all(|x| *x == "pass" || *x == "not applicable") {
        "pass"
    } else {
        "incomplete"
    }
}

/// The case's overall verdict over its lines and families: PASS only when
/// the run completed, every line passes and every family passes (or is not
/// applicable); any other family verdict is listed as not judged.
pub fn overall(
    failure: bool,
    lines_pass: bool,
    families: &serde_json::Map<String, Value>,
) -> (String, Vec<Value>) {
    let not_judged: Vec<Value> = families
        .iter()
        .filter(|(_, f)| {
            !matches!(
                f["verdict"].as_str(),
                Some("pass" | "fail" | "not applicable")
            )
        })
        .map(|(k, f)| json!({"family": k, "verdict": f["verdict"], "reason": f["reason"]}))
        .collect();
    let failing: Vec<&String> = families
        .iter()
        .filter(|(_, f)| f["verdict"] == "fail")
        .map(|(k, _)| k)
        .collect();
    let verdict = if failure {
        "FAIL: the run failed".to_string()
    } else if !lines_pass {
        "lines not all passing".to_string()
    } else if !failing.is_empty() {
        format!("lines PASS; families failing: {failing:?}")
    } else if !not_judged.is_empty() {
        format!(
            "lines PASS; no family fails, but {} are not judged (see gates_not_yet_implemented)",
            not_judged.len()
        )
    } else {
        "lines and every gate family PASS".to_string()
    };
    (verdict, not_judged)
}

/// E3's cap-cycle check as amended by H2 (S2's `cap_cycle`) on the run's
/// and R1's credited outputs over `[0, window]` s after `origin`: each
/// output's content above the credited band passes at or below its floor
/// (the declared fraction of its credited budget; the roof's sample-noise
/// budget) or at most `ratio_max` times R1's.
#[allow(clippy::too_many_arguments)] // Two runs, the window, the budgets and the two declared numbers.
pub fn cap_cycle(
    run: &crate::compare::Credited,
    r1: &crate::compare::Credited,
    origin: f64,
    window: f64,
    b: &crate::compare::Budgets,
    ratio_max: f64,
    fraction: f64,
) -> Value {
    use crate::compare::key;
    use crate::filter::{
        CAP_CYCLE_RULE, EXCESS_SPECTRUM_METHOD, cap_cycle_output, content_above_band,
    };
    let dt = b.observation_s;
    let floors: [(&str, f64, f64); 9] = [
        (key::PZR_ROOF_PA, 1., b.roof_noise_pa),
        (key::CORE_DP_PA, 1., b.core_dp_pa),
        (key::LOOP_FLOW_KG_S, 1., b.loop_flow_kg_s),
        (key::CORE_POWER_W, b.power_basis_w, b.core_power_relative),
        (key::CORE_CELL_K, 1., b.core_cell_k),
        (key::SG_PRESSURE_PA, 1., b.sg_pressure_pa),
        (key::SG_LIQUID_M3, 1., b.sg_liquid_m3),
        (key::REGIONAL_FRACTION, 1., b.regional_fraction),
        (key::FUEL_DOPPLER_K, 1., b.fuel_doppler_k),
    ];
    let (ra, rb) = match (
        run.grid(origin, 0., window, dt),
        r1.grid(origin, 0., window, dt),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        (a, b) => return json!({"verdict": "unevaluable", "run": a.err(), "r1": b.err()}),
    };
    let mut outputs = serde_json::Map::new();
    let mut pass = true;
    for (k, scale, budget) in floors {
        let (Ok(x), Ok(y)) = (run.output(k), r1.output(k)) else {
            return json!({"verdict": "unevaluable", "missing": k});
        };
        for (i, (p, q)) in x.iter().zip(y).enumerate() {
            let a: Vec<f64> = p[ra.clone()].iter().map(|v| v / scale).collect();
            let c: Vec<f64> = q[rb.clone()].iter().map(|v| v / scale).collect();
            let (entry, ok) = cap_cycle_output(
                &content_above_band(&a, b.cutoff_hz, dt),
                &content_above_band(&c, b.cutoff_hz, dt),
                fraction * budget,
                ratio_max,
                dt,
                b.cutoff_hz,
            );
            pass &= ok;
            outputs.insert(format!("{k}[{i}]"), entry);
        }
    }
    json!({"verdict": if pass { "pass" } else { "fail" }, "cutoff_hz": b.cutoff_hz, "window_s": window, "ratio_max": ratio_max,
        "floor_budget_fraction": fraction, "rule": CAP_CYCLE_RULE, "excess_spectrum": EXCESS_SPECTRUM_METHOD,
        "threshold_source": "ld01-s1-gates eventReference.capCycleUncreditedRmsRatioMax, capCycleFloorBudgetFraction; the contract's budgets",
        "outputs": outputs})
}

/// H1a: at most `max` stock convergence failures over `[from, to]` s after
/// zero, from `(t − zero, cumulative failures)` marks.
pub fn convergence_failures(marks: &[(f64, f64)], from: f64, to: f64, max: f64) -> Value {
    match span_cpu(marks, from, to) {
        Some((a, b, per_s)) => {
            let n = (per_s * (b - a)).round();
            json!({"verdict": if n <= max { "pass" } else { "fail" }, "failures": n, "max": max, "span_s": [a, b],
                "threshold_source": "ld01-s1-gates recovery.maxConvergenceFailures (S2's H1a)"})
        }
        None => {
            json!({"verdict": "not executable", "reason": "no marks over the span", "span_s": [from, to]})
        }
    }
}

/// Rule F's detector on one signal sampled at `t`: the second difference
/// `x[k+1] - 2 x[k] + x[k-1]` over the local step², flagged where its
/// magnitude exceeds `threshold` (the signal's units per s²).
pub fn jumps(t: &[f64], x: &[f64], threshold: f64) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for k in 1..x.len().saturating_sub(1) {
        let (h0, h1) = (t[k] - t[k - 1], t[k + 1] - t[k]);
        if h0 <= 0. || h1 <= 0. {
            continue;
        }
        let d2 = 2. * ((x[k + 1] - x[k]) / h1 - (x[k] - x[k - 1]) / h0) / (h0 + h1);
        if d2.abs() > threshold {
            out.push((t[k], d2));
        }
    }
    out
}

/// Each flagged jump mapped to a logged instant within `reach` s; the
/// unmapped ones.
pub fn unmapped(flagged: &[(f64, f64)], instants: &[f64], reach: f64) -> Vec<(f64, f64)> {
    flagged
        .iter()
        .filter(|(t, _)| !instants.iter().any(|i| (i - t).abs() <= reach))
        .copied()
        .collect()
}

/// Rule F as the block declares it: judged only with a declared detector
/// (`smoothness` in the case or the block: threshold per signal, reach).
pub fn smoothness(
    block: &Value,
    case: &Value,
    signals: &[(String, Vec<f64>)],
    t: &[f64],
    instants: &[f64],
) -> Value {
    let declared = case.get("smoothness").or_else(|| block.get("smoothness"));
    let Some(d) = declared else {
        return json!({"family": "F smoothness", "verdict": "not executable",
            "reason": "rule F (\"a derivative-jump detector on every recorded signal; each flagged jump maps to a declared event or transaction\") declares no detector: no threshold per signal, derivative order or mapping reach in the r3 draft or the r3.7 block; the harness's detector (second difference over the observation grid) waits for the declared values (SPEC/lead)",
            "signals_recorded": signals.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(), "logged_instants": instants.len()});
    };
    let reach = d["reach_s"].as_f64();
    let mut out = serde_json::Map::new();
    let mut verdict = "pass";
    for (k, x) in signals {
        let Some(threshold) = d["threshold"][k].as_f64() else {
            verdict = "incomplete";
            out.insert(
                k.clone(),
                json!({"verdict": "not executable", "reason": "no declared threshold"}),
            );
            continue;
        };
        let flagged = jumps(t, x, threshold);
        let left = reach.map(|r| unmapped(&flagged, instants, r));
        let v = match &left {
            Some(l) if l.is_empty() => "pass",
            Some(_) => "fail",
            None => "not executable",
        };
        if v == "fail" {
            verdict = "fail";
        } else if v != "pass" && verdict == "pass" {
            verdict = "incomplete";
        }
        out.insert(k.clone(), json!({"verdict": v, "threshold": threshold, "flagged": flagged.len(), "unmapped": left}));
    }
    json!({"family": "F smoothness", "verdict": verdict, "declared": d, "signals": out})
}

/// Rule H on one host: two runs' records bitwise equal.
pub fn repeatability(a: &Value, b: &Value) -> Value {
    let keys = [
        "fingerprint",
        "samples",
        "end_state_fingerprint",
        "instants",
        "counts_by_class",
    ];
    let differ: Vec<&str> = keys.iter().copied().filter(|k| a[*k] != b[*k]).collect();
    json!({"family": "H repeatability", "verdict": if differ.is_empty() { "pass" } else { "fail" },
        "one_host": {"rule": "bitwise on one host: the sampled trajectory's FNV-1a fingerprint (every observation sample's t, y, y'), the end state and the logged instants", "compared": keys, "differ": differ, "run": a, "repeat": b},
        "across_hosts": {"verdict": "not executable", "reason": "one host only (owner F1: no Linux host); across hosts within the refinement tolerance"}})
}

/// Rule K at the declared states: each an external Z6 receipt (SPECTRUM)
/// naming the state's sha256, passing when its verdict is GO (S2's rule).
pub fn spectra(states: &[(&str, Option<String>)], receipts: &Value) -> Value {
    let mut out = Vec::new();
    for (name, sha) in states {
        let Some(sha) = sha else {
            out.push(json!({"state": name, "verdict": "not applicable", "reason": "no such state in this run"}));
            continue;
        };
        let found = receipts
            .as_object()
            .and_then(|o| o.values().find(|r| r.to_string().contains(sha.as_str())));
        match found {
            Some(r) => {
                let go = r["verdict"].as_str().is_some_and(|v| v.starts_with("GO"));
                out.push(json!({"state": name, "state_sha256": sha, "verdict": if go { "pass" } else { "fail" }, "receipt_verdict": r["verdict"]}));
            }
            None => out.push(json!({"state": name, "state_sha256": sha, "verdict": "not executable",
                "reason": "no Z6 receipt names this state (SPECTRUM's P-7 on the S3 composition is owed; the harness wrote the state for it)"})),
        }
    }
    let judged = out
        .iter()
        .filter(|s| s["verdict"] == "pass" || s["verdict"] == "fail")
        .count();
    let applicable = out
        .iter()
        .filter(|s| s["verdict"] != "not applicable")
        .count();
    let verdict = if out.iter().any(|s| s["verdict"] == "fail") {
        "fail"
    } else if judged == applicable && judged > 0 {
        "pass"
    } else {
        "not executable"
    };
    json!({"family": "K spectra", "verdict": verdict, "predicate": "S2's Z6 (both named restrictions GO: infinite modes = algebraic, no resolved positive real part, marginal modes tied to null directions, no excited light fast mode)", "states": out})
}

/// Rule B for the case: the block's declared signs. C3's
/// `networkProbeDirections`: the idle pump slows and never reverses
/// (`reverseRotation: false`), judged on its angular momentum; the idle
/// branch's reversal names no face, so it is not executable; values are
/// magnitudes (rule C, reported).
pub fn directions(
    case: Case,
    spec: &Value,
    rotor: Option<usize>,
    momenta: &[(f64, Vec<f64>)],
) -> Value {
    match case {
        Case::C1 => {
            json!({"family": "B directions", "verdict": "not applicable", "reason": "C1 is a hold: the block declares no direction"})
        }
        Case::C5 => json!({"family": "B directions", "verdict": "not executable",
            "reason": "C5's directions are judged by s3_harness::c5::directions"}),
        Case::C2 => json!({"family": "B directions", "verdict": "not executable",
            "reason": "the r3.7 block declares no C2 direction: the table (core power down, T_cold up then down, PT1 up to 14.922 MPa then down, ...) is prose in the r3 draft, with no machine-readable signal or shape predicate (\"then\", \"briefly\", \"stabilizes\"); SPEC to put it into the block"}),
        Case::C3 => {
            let d = &spec["networkProbeDirections"];
            if d.is_null() {
                return json!({"family": "B directions", "verdict": "not executable", "reason": "no networkProbeDirections"});
            }
            let Some(r) = rotor else {
                return json!({"family": "B directions", "verdict": "not executable", "reason": "the malfunction names no rotor"});
            };
            let series: Vec<f64> = momenta
                .iter()
                .filter_map(|(_, m)| m.get(r).copied())
                .collect();
            if series.len() < 2 {
                return json!({"family": "B directions", "verdict": "not executable", "reason": "no rotor record"});
            }
            let slows = series.last().unwrap() < series.first().unwrap();
            let reverse = series.iter().any(|v| *v < 0.);
            let mut lines = vec![
                json!({"id": "idle pump slows", "declared": d["idlePumpSpeed_rad_s"], "first": series[0], "last": series.last(), "verdict": if slows { "pass" } else { "fail" }}),
            ];
            let declared_reverse = d["reverseRotation"].as_bool();
            lines.push(json!({"id": "no reverse rotation", "declared": d["reverseRotation"], "minimum": series.iter().copied().fold(f64::INFINITY, f64::min),
                "verdict": match declared_reverse { Some(false) => if reverse { "fail" } else { "pass" }, Some(true) => if reverse { "pass" } else { "fail" }, None => "not executable" }}));
            lines.push(json!({"id": "idle branch reverses", "declared_s": d["idleBranchReversal_s"], "verdict": "not executable", "reason": "the block names no idle-branch face"}));
            lines.push(json!({"id": "donor flips, chattering", "declared": [d["donorFlips"], d["chattering"]], "verdict": "reported", "reason": "magnitudes (rule C); chattering has no declared criterion"}));
            let verdict = if lines.iter().any(|l| l["verdict"] == "fail") {
                "fail"
            } else {
                "incomplete"
            };
            json!({"family": "B directions", "verdict": verdict, "basis": "angular momentum (sign and trend of the speed; inertia > 0)", "lines": lines})
        }
    }
}

/// C1's SS-1: over `ss1Duration_s`, each 2 Hz-filtered output's range
/// against its bound (temperatures in K, the rest relative to the mean).
/// Shorter runs are not executable as declared; their ranges are reported.
pub fn ss1(
    spec: &Value,
    run_s: f64,
    series: &[(String, bool, Vec<f64>)],
    dt: f64,
    cutoff_hz: f64,
) -> Value {
    let declared = spec["ss1Duration_s"].as_f64();
    let (Some(temperature), Some(other)) = (
        spec["ss1TemperatureRange_K"].as_f64(),
        spec["ss1OtherRangeFractionOfMean"].as_f64(),
    ) else {
        return json!({"family": "C1 SS-1", "verdict": "not executable", "reason": "the block declares no SS-1 bounds"});
    };
    let mut out = serde_json::Map::new();
    let mut within = true;
    for (k, is_temperature, x) in series {
        if x.len() < 3 {
            continue;
        }
        let f = zero_phase_lowpass(x, cutoff_hz, dt);
        let (lo, hi) = f
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| {
                (a.min(*v), b.max(*v))
            });
        let mean = f.iter().sum::<f64>() / f.len() as f64;
        let (value, bound) = if *is_temperature {
            (hi - lo, temperature)
        } else {
            ((hi - lo) / mean.abs(), other)
        };
        within &= value <= bound;
        out.insert(
            k.clone(),
            json!({"range": value, "bound": bound, "relative": !is_temperature}),
        );
    }
    let complete = declared.is_some_and(|d| run_s >= d - 1e-9);
    // The declared temperatures (core outlet, hot and cold legs) and the
    // steam flows have no declared signal: SS-1 is not executable until
    // they do, whatever the duration.
    let mapped = false;
    json!({"family": "C1 SS-1", "verdict": if !complete || !mapped { "not executable as declared" } else if within { "pass" } else { "fail" },
        "unmapped_declared_signals": ["core outlet temperature", "hot-leg temperature", "cold-leg temperature", "each steam flow"],
        "declared_duration_s": declared, "run_s": run_s, "within_over_the_run": within,
        "reason": if !complete { "SS-1 is declared over 3,600 s (on the Linux host, owner F1 open); the ranges over this run are reported" } else { "the declared core outlet, hot-leg and cold-leg temperatures and steam flows have no declared signal (no credited output); the mapped ranges are reported" },
        "unmapped": "core outlet, hot-leg and cold-leg temperatures and the steam flows are not credited outputs (no declared signal map); reported: average coolant, core power, PT1, SG pressures, loop flows, generator power",
        "threshold_source": "ld01-s3-cases-c1c3 cases.C1.ss1*", "outputs": out})
}

/// C1's SS-2 on the conservation record: the identities closing the heat
/// and mass balances (unit energy, SG energy, the metal-heat and nuclear
/// handovers, primary and SG mass) and every IDAS ledger, plus the ELEC
/// slice's energy ledger (terminal energy = shaft work − losses).
pub fn ss2(identities: &Value, ledger: &Value, slice: &Value, slice_bound_units: f64) -> Value {
    let id_pass = identities["pass"] == json!(true);
    let ledger_pass = ledger["pass"] == json!(true);
    let slice_units = slice["worst_units"].as_f64();
    let slice_pass = slice_units.is_some_and(|u| u <= slice_bound_units);
    let evaluable = !identities.is_null() && !ledger.is_null() && slice_units.is_some();
    json!({"family": "C1 SS-2", "verdict": if !evaluable { "not executable" } else if id_pass && ledger_pass && slice_pass { "pass" } else { "fail" },
        "rule": "core power - RCP heat - PZR exterior loss + heater power = SG duty = steam - feed enthalpy, within the ledger bound; generator terminal energy = shaft work - losses (the block's probe column reads it as the S2 identities)",
        "identities_pass": id_pass, "ledgers_pass": ledger_pass,
        "slice": {"worst_units": slice_units, "bound_units": slice_bound_units, "pass": slice_pass}})
}

/// Rule E′ (S3-D23): the electrical credited outputs against a reference
/// over `[from, to]` s after `origin`, each the largest |difference| low-passed
/// as E0 (the declared filter at the credited band), against the block's
/// `accuracyExtension` budgets: the generator protection current
/// (`generator_ieq_a`) and the terminal power (`generator_power_w`). Only
/// for the cases the extension names.
#[allow(clippy::too_many_arguments)] // Two runs, their span, the grid and the declared extension.
pub fn electrical_e0(
    case: Case,
    run: &crate::compare::Credited,
    reference: &crate::compare::Credited,
    origin: f64,
    from: f64,
    to: f64,
    dt: f64,
    cutoff_hz: f64,
    extension: &Value,
) -> Value {
    let applies = extension["appliesTo"]
        .as_array()
        .is_some_and(|a| a.iter().any(|c| c == case.key()));
    if !applies {
        return json!({"verdict": "not applicable", "reason": format!("accuracyExtension.appliesTo does not name {}", case.key())});
    }
    let (Some(ieq), Some(power)) = (
        extension["generatorProtectionCurrent_A"].as_f64(),
        extension["generatorTerminalPower_W"].as_f64(),
    ) else {
        return json!({"verdict": "not executable", "reason": "accuracyExtension declares no budgets"});
    };
    let (ra, rb) = match (
        run.grid(origin, from, to, dt),
        reference.grid(origin, from, to, dt),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        (ea, eb) => {
            return json!({"verdict": "unevaluable", "run": ea.err(), "reference": eb.err()});
        }
    };
    let mut metrics = serde_json::Map::new();
    let mut within = true;
    for (k, budget) in [("generator_ieq_a", ieq), ("generator_power_w", power)] {
        match (run.output(k), reference.output(k)) {
            (Ok(a), Ok(b)) => {
                let raw: Vec<f64> = a[0][ra.clone()]
                    .iter()
                    .zip(&b[0][rb.clone()])
                    .map(|(p, q)| p - q)
                    .collect();
                let filtered = zero_phase_lowpass(&raw, cutoff_hz, dt);
                let value = max_abs(&filtered);
                // Where the largest difference lies (s after `origin`).
                let argmax = |x: &[f64]| {
                    x.iter()
                        .enumerate()
                        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                        .map(|(j, v)| (from + j as f64 * dt, *v))
                };
                within &= value <= budget;
                // The difference's history every 10 ms: (t, filtered,
                // unfiltered, the run's own value), for its attribution.
                let every = ((0.01 / dt).round() as usize).max(1);
                let history: Vec<[f64; 4]> = (0..raw.len())
                    .step_by(every)
                    .map(|j| {
                        [
                            from + j as f64 * dt,
                            filtered[j],
                            raw[j],
                            a[0][ra.start + j],
                        ]
                    })
                    .collect();
                metrics.insert(
                    k.into(),
                    json!({"value": value, "budget": budget, "at_s": argmax(&filtered),
                    "unfiltered_max": argmax(&raw), "history_10ms": history}),
                );
            }
            (a, b) => {
                within = false;
                metrics.insert(
                    k.into(),
                    json!({"evaluable": false, "run": a.err(), "reference": b.err()}),
                );
            }
        }
    }
    json!({"verdict": if within { "pass" } else { "fail" }, "from_s": from, "to_s": to, "metrics": metrics,
        "threshold_source": "ld01-s3-cases-c1c3 accuracyExtension (S3-D23)"})
}

/// The largest |value| of a series (for receipts).
pub fn max_abs(x: &[f64]) -> f64 {
    x.iter().fold(0., |m, v| larger(m, v.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budgets() -> Value {
        json!({"s3UnitRecurringIncludingEvents": 0.5, "s2Quiet": 0.1, "s2TripAverage": 0.35, "s2WindowAndRecovery": 0.5})
    }

    #[test]
    fn cost_judges_each_declared_span_against_its_budget() {
        // Instructions at 1.4e10 per raw CPU-s; rule I adds 10 % (S3-D46).
        let marks = |rate: &dyn Fn(f64) -> f64, n: usize| -> Vec<Mark> {
            (0..=n)
                .map(|k| {
                    let t = k as f64 * 0.1;
                    let c = rate(t);
                    (t, 1.1 * c, 1.1 * c * 1.4e10, c, c * 1.4e10)
                })
                .collect()
        };
        let ratio = |r: f64| Some((r, "test".to_string()));
        let v = |c: &Value, id: &str| {
            c["gates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["id"] == id)
                .unwrap()
                .clone()
        };
        // C1: 0.05 (0.055 with rule I) passes both; 0.2 fails the quiet.
        let c = cost(
            Case::C1,
            &budgets(),
            &marks(&|t| 0.05 * t, 6000),
            600.,
            None,
            10.,
            None,
            ratio(1.4e10),
            Some(true),
        );
        assert_eq!(c["verdict"], "pass", "{c}");
        let slow = marks(&|t| 0.2 * t, 6000);
        let c = cost(
            Case::C1,
            &budgets(),
            &slow,
            600.,
            None,
            10.,
            None,
            ratio(1.4e10),
            None,
        );
        assert_eq!(c["verdict"], "fail");
        assert_eq!(v(&c, "cost.s2_quiet")["verdict"], "fail");
        assert_eq!(v(&c, "cost.s3_unit")["verdict"], "pass");
        // Rule I counts: 0.095 without it, 0.1045 with it fails 0.1.
        let edge = marks(&|t| 0.095 * t, 6000);
        let c = cost(
            Case::C1,
            &budgets(),
            &edge,
            600.,
            None,
            10.,
            None,
            ratio(1.4e10),
            None,
        );
        assert_eq!(v(&c, "cost.s2_quiet")["verdict"], "fail");
        assert!(
            (v(&c, "cost.s2_quiet")["without_rule_i"]["quiet_equivalent_cpu_s_per_s"]
                .as_f64()
                .unwrap()
                - 0.095)
                .abs()
                < 1e-9
        );
        // The verdict reads the quiet-equivalent: raw 0.22 at a loaded host,
        // 0.11 quiet-equivalent, passes the S3 unit budget; raw is reported.
        let c = cost(
            Case::C1,
            &budgets(),
            &slow,
            600.,
            None,
            10.,
            None,
            ratio(2.8e10),
            None,
        );
        assert_eq!(v(&c, "cost.s2_quiet")["verdict"], "fail", "0.11 > 0.1");
        assert!((v(&c, "cost.s2_quiet")["raw_cpu_s_per_s"].as_f64().unwrap() - 0.22).abs() < 1e-9);
        // Without a ratio the raw value decides.
        let c = cost(
            Case::C1,
            &budgets(),
            &slow,
            600.,
            None,
            10.,
            None,
            None,
            None,
        );
        assert_eq!(
            v(&c, "cost.s2_quiet")["basis"],
            "raw thread CPU, rule I counted (S3-D46)"
        );
        // An unreadable instruction counter is an error, never zero cost.
        let mut broken = marks(&|t| 0.05 * t, 6000);
        broken.last_mut().unwrap().2 = f64::NAN;
        let c = cost(
            Case::C1,
            &budgets(),
            &broken,
            600.,
            None,
            10.,
            None,
            ratio(1.4e10),
            None,
        );
        assert_eq!(c["verdict"], "error", "{c}");
        // A cost drive off the run's trajectory fails the family.
        let c = cost(
            Case::C1,
            &budgets(),
            &marks(&|t| 0.05 * t, 6000),
            600.,
            None,
            10.,
            None,
            ratio(1.4e10),
            Some(false),
        );
        assert_eq!(c["verdict"], "fail");
        // C2: 0.8 in the 20 s window fails it and the window + recovery.
        let c2 = marks(
            &|t| {
                if t <= 20. {
                    0.8 * t
                } else {
                    16. + 0.1 * (t - 20.)
                }
            },
            600,
        );
        let c = cost(
            Case::C2,
            &budgets(),
            &c2,
            60.,
            Some(20.),
            10.,
            Some(0.),
            ratio(1.4e10),
            Some(true),
        );
        assert_eq!(v(&c, "cost.s2_window")["verdict"], "fail");
        assert_eq!(
            v(&c, "cost.s2_window_and_recovery")["declared_span_s"],
            json!([0., 30.])
        );
        assert_eq!(
            v(&c, "cost.s2_window_and_recovery")["verdict"],
            "fail",
            "1.1 x (16 + 1) / 30 = 0.62"
        );
        assert_eq!(
            v(&c, "cost.s2_trip_average")["verdict"],
            "fail",
            "1.1 x 20 / 60 = 0.37"
        );
        assert_eq!(c["verdict"], "fail");
        // C3: the trip average from the acquired reactor trip, or none.
        let c = cost(
            Case::C3,
            &budgets(),
            &c2,
            60.,
            Some(30.),
            10.,
            Some(30.),
            ratio(1.4e10),
            Some(true),
        );
        assert_eq!(v(&c, "cost.s2_trip_average")["span_s"], json!([30., 60.]));
        let c = cost(
            Case::C3,
            &budgets(),
            &c2,
            60.,
            Some(30.),
            10.,
            None,
            ratio(1.4e10),
            Some(true),
        );
        assert_eq!(v(&c, "cost.s2_trip_average")["verdict"], "not applicable");
        // Rule I's exit inside the window: judged to it, flagged truncated.
        let c = cost(
            Case::C2,
            &budgets(),
            &c2[..=150],
            15.,
            Some(20.),
            10.,
            Some(0.),
            ratio(1.4e10),
            None,
        );
        let w = v(&c, "cost.s2_window");
        assert_eq!(w["truncated_by_rule_i"], true);
        assert_eq!(w["span_s"][1], 15.);
        // A budget the block does not declare is not executable: not a pass.
        let c = cost(
            Case::C1,
            &json!({"s3UnitRecurringIncludingEvents": 0.5}),
            &c2,
            60.,
            None,
            10.,
            None,
            None,
            None,
        );
        assert_eq!(c["verdict"], "incomplete");
    }

    #[test]
    fn the_overall_verdict_never_counts_an_unjudged_family_as_pass() {
        assert_eq!(overall_of(["pass", "not applicable"].into_iter()), "pass");
        assert_eq!(overall_of(["pass", "incomplete"].into_iter()), "incomplete");
        assert_eq!(
            overall_of(["pass", "unevaluable"].into_iter()),
            "incomplete"
        );
        assert_eq!(overall_of(["pass", "error: x"].into_iter()), "error");
        assert_eq!(overall_of(["incomplete", "fail"].into_iter()), "fail");
        assert_eq!(overall_of(std::iter::empty()), "incomplete");
        let mut f = serde_json::Map::new();
        f.insert("D".into(), json!({"verdict": "pass"}));
        f.insert("B".into(), json!({"verdict": "incomplete"}));
        let (v, not) = overall(false, true, &f);
        assert!(!v.contains("every gate family PASS"), "{v}");
        assert_eq!(not.len(), 1);
        f.insert("B".into(), json!({"verdict": "not applicable"}));
        assert_eq!(
            overall(false, true, &f).0,
            "lines and every gate family PASS"
        );
        f.insert("E".into(), json!({"verdict": "unevaluable"}));
        assert!(
            !overall(false, true, &f)
                .0
                .contains("every gate family PASS")
        );
        f.insert("G".into(), json!({"verdict": "fail"}));
        assert!(overall(false, true, &f).0.contains("families failing"));
        assert_eq!(overall(true, true, &f).0, "FAIL: the run failed");
    }

    #[test]
    fn the_cap_cycle_flags_above_band_content_beyond_r1s() {
        let b = crate::compare::Budgets {
            roof_bias_pa: 1000.,
            roof_noise_pa: 200.,
            level_m: 0.01,
            core_dp_pa: 50.,
            loop_flow_kg_s: 40.,
            core_power_relative: 1e-3,
            power_basis_w: 3e9,
            regional_fraction: 1e-3,
            fuel_doppler_k: 0.5,
            core_cell_k: 0.05,
            sg_pressure_pa: 2000.,
            sg_liquid_m3: 0.05,
            timing_s: 0.05,
            insertion_fractions: vec![0.1, 0.5, 0.9, 1.],
            rod_travel_reported_m: 1e-3,
            cutoff_hz: 2.,
            observation_s: 0.002,
            output_s: 0.1,
        };
        let series = |ripple: f64| {
            let mut c = crate::compare::Credited::default();
            for k in 0..=2500 {
                let t = k as f64 * 0.002;
                let r = ripple * (2. * std::f64::consts::PI * 25. * t).sin();
                c.push(
                    t,
                    &[
                        ("pzr_roof_pa", vec![15e6 + r]),
                        ("core_dp_pa", vec![4e4 + r]),
                        ("loop_flow_kg_s", vec![9000.]),
                        ("core_power_w", vec![3e9]),
                        ("core_cell_k", vec![580.]),
                        ("sg_pressure_pa", vec![6.3e6]),
                        ("sg_liquid_m3", vec![100.]),
                        ("regional_fraction", vec![0.04]),
                        ("fuel_doppler_k", vec![900.]),
                    ],
                )
                .unwrap();
            }
            c
        };
        let quiet = series(0.);
        // 25 Hz ripple of 100 Pa: above core DP's floor (0.1 x 50 Pa) with
        // none in R1 -> fail; within the floor -> pass.
        assert_eq!(
            cap_cycle(&series(100.), &quiet, 0., 5., &b, 2., 0.1)["verdict"],
            "fail"
        );
        assert_eq!(
            cap_cycle(&series(1.), &quiet, 0., 5., &b, 2., 0.1)["verdict"],
            "pass"
        );
        // The same ripple in R1: within ratio_max times R1's.
        assert_eq!(
            cap_cycle(&series(100.), &series(100.), 0., 5., &b, 2., 0.1)["verdict"],
            "pass"
        );
    }

    #[test]
    fn h1a_counts_the_continuations_convergence_failures() {
        let marks: Vec<(f64, f64)> = (0..=300)
            .map(|k| (k as f64 * 0.1, if k > 250 { 3. } else { 0. }))
            .collect();
        assert_eq!(
            convergence_failures(&marks, 20., 30., 2.)["verdict"],
            "fail"
        );
        assert_eq!(convergence_failures(&marks, 0., 20., 2.)["verdict"], "pass");
    }

    #[test]
    fn the_jump_detector_flags_kinks_and_maps_them_to_instants() {
        let t: Vec<f64> = (0..101).map(|k| k as f64 * 0.01).collect();
        // A ramp with a slope change at 0.5 s: one flagged sample there.
        let x: Vec<f64> = t
            .iter()
            .map(|s| if *s <= 0.5 { *s } else { 0.5 + 3. * (s - 0.5) })
            .collect();
        let f = jumps(&t, &x, 50.);
        assert_eq!(f.len(), 1);
        assert!((f[0].0 - 0.5).abs() < 1e-12, "{f:?}");
        // A smooth parabola is never flagged at a threshold above 2.
        let p: Vec<f64> = t.iter().map(|s| s * s).collect();
        assert!(jumps(&t, &p, 2.5).is_empty());
        assert!(unmapped(&f, &[0.505], 0.01).is_empty());
        assert_eq!(unmapped(&f, &[0.7], 0.01).len(), 1);
        // Without a declared detector, rule F is not executable; with one
        // and an unmapped jump it fails.
        let signals = vec![("x".to_string(), x.clone())];
        assert_eq!(
            smoothness(&json!({}), &json!({}), &signals, &t, &[])["verdict"],
            "not executable"
        );
        let declared = json!({"smoothness": {"threshold": {"x": 50.}, "reach_s": 0.01}});
        assert_eq!(
            smoothness(&declared, &json!({}), &signals, &t, &[0.7])["verdict"],
            "fail"
        );
        assert_eq!(
            smoothness(&declared, &json!({}), &signals, &t, &[0.5])["verdict"],
            "pass"
        );
    }

    #[test]
    fn repeatability_is_bitwise_on_one_host() {
        let a = json!({"fingerprint": "00ff", "samples": 3, "end_state_fingerprint": "aa", "instants": [1], "counts_by_class": {}});
        assert_eq!(repeatability(&a, &a)["verdict"], "pass");
        let mut b = a.clone();
        b["fingerprint"] = json!("00fe");
        let r = repeatability(&a, &b);
        assert_eq!(r["verdict"], "fail");
        assert_eq!(r["one_host"]["differ"], json!(["fingerprint"]));
        assert_eq!(r["across_hosts"]["verdict"], "not executable");
    }

    #[test]
    fn spectra_take_s2s_z6_verdict_for_the_named_state() {
        let receipts = json!({"start": {"verdict": "GO: both restrictions", "state": {"sha256": "abc123"}},
            "window": {"verdict": "NO-GO", "state": {"sha256": "def456"}}});
        let s = spectra(
            &[("start", Some("abc123".into())), ("window end", None)],
            &receipts,
        );
        assert_eq!(s["verdict"], "pass", "{s}");
        let s = spectra(
            &[
                ("start", Some("abc123".into())),
                ("window end", Some("def456".into())),
            ],
            &receipts,
        );
        assert_eq!(s["verdict"], "fail");
        let s = spectra(&[("start", Some("999".into()))], &receipts);
        assert_eq!(s["verdict"], "not executable");
    }

    #[test]
    fn c3_directions_judge_the_declared_signs_only() {
        let spec = json!({"networkProbeDirections": {"idlePumpSpeed_rad_s": [157, 29.3], "reverseRotation": false, "idleBranchReversal_s": 21.6, "donorFlips": 10, "chattering": false}});
        let slowing: Vec<(f64, Vec<f64>)> = (0..10)
            .map(|k| (k as f64, vec![100. - 9. * k as f64, 50.]))
            .collect();
        let d = directions(Case::C3, &spec, Some(0), &slowing);
        assert_eq!(d["lines"][0]["verdict"], "pass");
        assert_eq!(d["lines"][1]["verdict"], "pass");
        assert_eq!(
            d["verdict"], "incomplete",
            "the branch reversal is not executable"
        );
        let reversing: Vec<(f64, Vec<f64>)> = (0..10)
            .map(|k| (k as f64, vec![10. - 3. * k as f64]))
            .collect();
        assert_eq!(
            directions(Case::C3, &spec, Some(0), &reversing)["verdict"],
            "fail"
        );
        assert_eq!(
            directions(Case::C2, &spec, None, &[])["verdict"],
            "not executable"
        );
        assert_eq!(
            directions(Case::C1, &spec, None, &[])["verdict"],
            "not applicable"
        );
    }

    #[test]
    fn ss1_is_judged_only_over_its_declared_duration() {
        let spec = json!({"ss1Duration_s": 3600, "ss1TemperatureRange_K": 0.6, "ss1OtherRangeFractionOfMean": 0.02});
        let flat: Vec<f64> = vec![570.; 2000];
        let series = vec![
            ("average_coolant_k".to_string(), true, flat.clone()),
            ("core_power_w".to_string(), false, vec![3e9; 2000]),
        ];
        let s = ss1(&spec, 600., &series, 0.002, 2.);
        assert_eq!(s["verdict"], "not executable as declared");
        assert_eq!(s["within_over_the_run"], true);
        // Unmapped declared signals keep it not executable at 3,600 s too.
        assert_eq!(
            ss1(&spec, 3600., &series, 0.002, 2.)["verdict"],
            "not executable as declared"
        );
        let wide: Vec<f64> = (0..2000).map(|k| 570. + k as f64 * 1e-3).collect();
        let series = vec![("average_coolant_k".to_string(), true, wide)];
        assert_eq!(
            ss1(&spec, 3600., &series, 0.002, 2.)["within_over_the_run"],
            false
        );
    }

    #[test]
    fn the_electrical_extension_judges_ieq_and_terminal_power_for_its_cases() {
        let ext = json!({"generatorProtectionCurrent_A": 10, "generatorTerminalPower_W": 1e6, "appliesTo": ["C2", "C5"]});
        let series = |ieq: f64, p: f64| {
            let mut c = crate::compare::Credited::default();
            for k in 0..=500 {
                let t = 100. + k as f64 * 0.002;
                c.push(
                    t,
                    &[
                        ("generator_ieq_a", vec![ieq]),
                        ("generator_power_w", vec![p]),
                    ],
                )
                .unwrap();
            }
            c
        };
        let run = series(30_000., 1.0e9);
        let close = series(30_005., 1.0e9 + 5e5);
        let e = electrical_e0(Case::C2, &run, &close, 100., 0., 1., 0.002, 2., &ext);
        assert_eq!(e["verdict"], "pass", "{e}");
        let far = series(30_020., 1.0e9);
        assert_eq!(
            electrical_e0(Case::C2, &run, &far, 100., 0., 1., 0.002, 2., &ext)["verdict"],
            "fail"
        );
        assert_eq!(
            electrical_e0(Case::C1, &run, &far, 100., 0., 1., 0.002, 2., &ext)["verdict"],
            "not applicable"
        );
    }

    #[test]
    fn ss2_needs_every_balance_and_the_slice_ledger() {
        let ok = json!({"pass": true});
        let slice = json!({"worst_units": 0.4});
        assert_eq!(ss2(&ok, &ok, &slice, 1.)["verdict"], "pass");
        assert_eq!(
            ss2(&ok, &json!({"pass": false}), &slice, 1.)["verdict"],
            "fail"
        );
        assert_eq!(
            ss2(&ok, &ok, &json!({"worst_units": 3.}), 1.)["verdict"],
            "fail"
        );
        assert_eq!(ss2(&ok, &ok, &json!({}), 1.)["verdict"], "not executable");
    }
}

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
//! - **F smoothness** ([`smoothness_signed`], S3-D49): the raw second
//!   difference of each credited signal against 4 tau_x, each flag mapped
//!   to a logged instant within one sample.
//! - **H repeatability** ([`repeatability`]): the sampled trajectory's
//!   fingerprint and the end state, bitwise, between two runs on one host.
//! - **K post-event spectra** ([`spectra`]): Z6's predicate as S2 judges it
//!   (an external SPECTRUM receipt whose verdict is GO), at the start state
//!   and at each declared post-event state.
//! - **B directions** ([`directions`], S3-D50): C2's and C3's signed
//!   checks, chattering by a rule given as data ([`chattering`]).
//! - **C1 SS-1** ([`ss1`], S3-D51): the filtered ranges of the named
//!   signals on the 0.1 s output grid over the declared duration.
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

/// Rule F as signed (S3-D49): on each signal instance's raw samples x_k at
/// `t`, flag k where |x_{k+1} - 2 x_k + x_{k-1}| > 4 tau_x(k), tau_x(k) =
/// `rtol` |x_k| + a_x; a flag maps when a logged instant lies in
/// [t_{k-1}, t_{k+1}]; every unmapped flag fails F.
pub fn smoothness_signed(
    t: &[f64],
    signals: &[(String, Vec<f64>, f64)],
    rtol: f64,
    instants: &[f64],
) -> Value {
    let mut out = serde_json::Map::new();
    let mut unmapped_total = 0usize;
    let mut flagged_total = 0usize;
    for (name, x, a) in signals {
        let mut flagged = 0usize;
        let mut unmapped: Vec<Value> = Vec::new();
        let mut worst = 0_f64;
        for k in 1..x.len().saturating_sub(1) {
            let d2 = (x[k + 1] - 2. * x[k] + x[k - 1]).abs();
            let tau = rtol * x[k].abs() + a;
            let ratio = d2 / (4. * tau);
            worst = worst.max(ratio);
            if ratio > 1. {
                flagged += 1;
                let (lo, hi) = (t[k - 1], t[k + 1]);
                let fuzz = 1e-9 * hi.abs().max(1.);
                if !instants.iter().any(|i| *i >= lo - fuzz && *i <= hi + fuzz) {
                    if unmapped.len() < 20 {
                        unmapped.push(json!({"t_s": t[k], "second_difference": d2, "tau": tau}));
                    }
                    unmapped_total += 1;
                }
            }
        }
        flagged_total += flagged;
        out.insert(name.clone(), json!({"a_x": a, "flagged": flagged, "worst_ratio_to_4tau": worst, "unmapped_first": unmapped}));
    }
    json!({"family": "F smoothness", "verdict": if signals.is_empty() { "not executable" } else if unmapped_total == 0 { "pass" } else { "fail" },
        "rule": "S3-D49: raw samples on the 2 ms grid, flag |x[k+1] - 2 x[k] + x[k-1]| > 4 (rtol |x[k]| + a_x), a flag maps to a logged instant (R, S, donor flip) in [t[k-1], t[k+1]]",
        "rtol": rtol, "instants": instants.len(), "flagged": flagged_total, "unmapped": unmapped_total, "signals": out})
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

/// N4′ as decided (owner CH-1, R7-Q; terms S3-D58), the default chattering
/// rule: every vapour-path re-closing follows a located exhaustion or a
/// located flow reversal, from a consistent state (every row's
/// pre-transaction residual at most one integrator tolerance unit), a
/// reversal with a drive beyond its first-order propagated tolerance, its
/// cause recorded; closings counted and reported. As data, so a definition
/// can be swapped without code (`LD01_S3_CHATTER_RULE`); the pinned r1
/// criterion stays selectable (`relock_after_release`).
/// The harness's reading of C4.N4 r2 (N4′) as rule data: the kernel's L1
/// causes that are a located exhaustion and a located flow reversal, the
/// vapour phase, one tolerance unit. Used only once the pinned block's
/// texts are verified (`n4_rule` in `s3_cases.rs`); never a default.
pub const N4_PRIME_READING: &str = r#"{"criterion": "n4prime", "phase": 1, "consistency_units": 1.0, "exhaustion_causes": ["ContactRoot", "ContactAtTransaction", "Exhaustion"], "reversal_causes": ["AtRest"], "source": "N4' (owner CH-1, R7-Q; S3-D58): re-closings follow a located exhaustion or a located flow reversal; consistent pre-state <= 1 integrator tolerance unit (rtol|y| + atol, JACAGE's units); a reversal's |drive| above its first-order propagated tolerance (rule F's a_x)"}"#;

/// One logged L1 change.
struct Closing<'a> {
    t: f64,
    locked: bool,
    change: &'a Value,
    kinds: Vec<String>,
}

fn l1_changes(log: &[Value]) -> std::collections::BTreeMap<u64, Vec<Closing<'_>>> {
    let mut paths: std::collections::BTreeMap<u64, Vec<Closing<'_>>> =
        std::collections::BTreeMap::new();
    for e in log {
        let t = e["t_s"].as_f64().unwrap_or(f64::NAN);
        let kinds: Vec<String> = e["kinds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|k| k.as_str().map(String::from))
            .collect();
        for tr in e["restart"]["transactions"]
            .as_array()
            .into_iter()
            .flatten()
        {
            // L1's own changes and the phase-mode owner's exhaustion locks
            // (DR S3-EXHAUST: `vaporPathContacts`).
            for c in tr["changes"]
                .as_array()
                .into_iter()
                .chain(tr["vaporPathContacts"]["changes"].as_array())
                .flatten()
            {
                let Some(path) = c["path"].as_u64() else {
                    continue;
                };
                paths.entry(path).or_default().push(Closing {
                    t,
                    locked: c["after"].get("Locked").is_some(),
                    change: c,
                    kinds: kinds.clone(),
                });
            }
        }
    }
    paths
}

/// Chattering on a run's logged L1 changes under `rule` (N4′ from the pinned C4 block,
/// or r1's relock count), with each restart's pre-transaction consistency
/// (`entries`, [`super::observe::entry_consistency`]) and the drives'
/// propagated tolerances (`face * 2 + phase`).
pub fn chattering(
    log: &[Value],
    rule: &Value,
    entries: &[Value],
    drive_tolerance: Option<&[f64]>,
) -> Value {
    let paths = l1_changes(log);
    match rule["criterion"].as_str() {
        Some("relock_after_release") => {
            let Some(max) = rule["max_relocks"].as_u64() else {
                return json!({"verdict": "not executable", "reason": "the rule has no max_relocks", "rule": rule});
            };
            let within = rule["within_s"].as_f64();
            let mut relocks = 0u64;
            let mut listed = Vec::new();
            for (path, changes) in &paths {
                let n = changes
                    .windows(2)
                    .filter(|w| {
                        !w[0].locked && w[1].locked && within.is_none_or(|s| w[1].t - w[0].t <= s)
                    })
                    .count() as u64;
                if n > 0 {
                    listed.push(json!({"path": path, "relocks": n}));
                }
                relocks += n;
            }
            json!({"verdict": if relocks <= max { "pass" } else { "fail" }, "relocks": relocks, "paths_changed": paths.len(), "chattering_paths": listed, "rule": rule})
        }
        Some("n4prime") => {
            let phase = rule["phase"].as_u64();
            let units = rule["consistency_units"].as_f64().unwrap_or(1.);
            let names = |k: &str| -> Vec<String> {
                rule[k]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            };
            let (exhaustion, reversal) = (names("exhaustion_causes"), names("reversal_causes"));
            let entry_at = |t: f64| {
                entries.iter().find(|e| {
                    e["t_s"]
                        .as_f64()
                        .is_some_and(|x| (x - t).abs() <= 1e-9 * t.abs().max(1.))
                })
            };
            let (mut closings, mut reclosings, mut ok, mut unevaluable) =
                (0usize, 0usize, 0usize, 0usize);
            let mut failing = Vec::new();
            for (path, changes) in &paths {
                for (k, c) in changes.iter().enumerate() {
                    if !c.locked || phase.is_some_and(|p| c.change["phase"].as_u64() != Some(p)) {
                        continue;
                    }
                    closings += 1;
                    if !changes[..k].iter().any(|x| !x.locked) {
                        continue; // a first closing, not a re-closing
                    }
                    reclosings += 1;
                    let cause = c.change["cause"].as_str().unwrap_or("");
                    let located = c.kinds.iter().any(|k| k.contains("located roots"));
                    let kind = if exhaustion.iter().any(|x| x == cause) {
                        "exhaustion"
                    } else if reversal.iter().any(|x| x == cause) {
                        "reversal"
                    } else {
                        "other"
                    };
                    let entry = entry_at(c.t);
                    let consistency = entry.and_then(|e| e["max_units"].as_f64());
                    let drive = c.change["drive_pa"].as_f64();
                    let tol = c.change["face"]
                        .as_u64()
                        .zip(c.change["phase"].as_u64())
                        .and_then(|(f, p)| {
                            drive_tolerance
                                .and_then(|d| d.get((f * 2 + p) as usize))
                                .copied()
                        });
                    let mut reasons: Vec<String> = Vec::new();
                    let mut evaluable = true;
                    if cause.is_empty() {
                        reasons.push("no cause recorded".into());
                    }
                    if !located {
                        reasons.push("not at a located root".into());
                    }
                    if kind == "other" {
                        reasons.push(format!(
                            "cause {cause} is neither an exhaustion nor a flow reversal"
                        ));
                    }
                    match consistency {
                        Some(u) if u <= units => {}
                        Some(u) => {
                            reasons.push(format!("pre-state {u:.3e} tolerance units > {units}"))
                        }
                        None => evaluable = false,
                    }
                    if kind == "reversal" {
                        // Toward the emptying end: the drive draws from an
                        // end holding no phase (`orientation × F < 0` for a
                        // one-sided lock, any drive when neither end holds).
                        let holding = c.change["after"]["Locked"].as_str();
                        let toward_empty = match (holding, drive) {
                            (Some("From"), Some(d)) => Some(d < 0.),
                            (Some("To"), Some(d)) => Some(d > 0.),
                            (Some("Neither"), Some(d)) => Some(d != 0.),
                            (Some("Both"), Some(_)) => Some(false),
                            _ => None,
                        };
                        match toward_empty {
                            Some(true) => {}
                            Some(false) => reasons.push(format!(
                                "the drive {:.3e} Pa draws from the holding end ({})",
                                drive.unwrap_or(f64::NAN),
                                holding.unwrap_or("?")
                            )),
                            None => evaluable = false,
                        }
                        match (drive, tol) {
                            (Some(d), Some(tl)) if d.abs() > tl => {}
                            (Some(d), Some(tl)) => reasons.push(format!(
                                "|drive| {:.3e} Pa within its tolerance {tl:.3e} Pa",
                                d.abs()
                            )),
                            _ => evaluable = false,
                        }
                    }
                    if !reasons.is_empty() {
                        failing.push(json!({"t_s": c.t, "path": path, "face": c.change["face"], "cause": cause, "pre_state_units": consistency, "drive_pa": drive, "drive_tolerance_pa": tol, "reasons": reasons}));
                    } else if evaluable {
                        ok += 1;
                    } else {
                        unevaluable += 1;
                    }
                }
            }
            let verdict = if !failing.is_empty() {
                "fail"
            } else if unevaluable > 0 {
                "not executable"
            } else {
                "pass"
            };
            json!({"verdict": verdict, "closings": closings, "reclosings": reclosings, "reclosings_satisfied": ok, "reclosings_unevaluable": unevaluable,
                "failing": failing, "paths_changed": paths.len(), "rule": rule})
        }
        _ => {
            json!({"verdict": "not executable", "reason": format!("criterion {} is not implemented", rule["criterion"]), "rule": rule})
        }
    }
}

/// C4.O4′ (block r2, S3-D57): the first birth among the classified cells
/// (`sides[cell]` "hot" or "cold"; SURGE and PZR "excluded", every other
/// "neither", as C4's volume classes) is in a hot-side cell, as a located
/// birth root with the phase-mode owner's birth transaction and its counted
/// class-R restart, with L1 deciding every vapour path at that instant (L1
/// composed: its transaction runs at every located instant, on the declared
/// presence); the restart follows the new presence key exactly when a cell
/// the joined pattern reads (`read_set`, the presence cache's cell list,
/// `presence::pattern_cells`) changed its presence at that instant, and
/// otherwise reports `presence_changed` false. `log` is the frame driver's
/// log, `zero` the case's t = 0, `names` the cells' names.
pub fn first_classified_birth(
    log: &[Value],
    zero: f64,
    sides: &[&str],
    names: &[String],
    read_set: &[usize],
    l1_active: bool,
) -> Value {
    let name = |c: usize| names.get(c).cloned().unwrap_or_else(|| format!("cell {c}"));
    let side = |c: usize| sides.get(c).copied().unwrap_or("unknown");
    // Every birth and exhaustion by instant, in log order.
    let mut births: Vec<(f64, usize, &Value)> = Vec::new();
    for e in log {
        let t = e["t_s"].as_f64().unwrap_or(f64::NAN) - zero;
        for tr in e["restart"]["transactions"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if tr["owner"] != "phase modes" {
                continue;
            }
            for ev in tr["events"].as_array().into_iter().flatten() {
                if let Some(c) = ev["birth"].as_u64() {
                    births.push((t, c as usize, e));
                }
            }
        }
    }
    let listed: Vec<Value> = births
        .iter()
        .map(|(t, c, _)| json!([t, name(*c), side(*c)]))
        .collect();
    let Some(&(t, cell, instant)) = births
        .iter()
        .find(|(_, c, _)| matches!(side(*c), "hot" | "cold"))
    else {
        return json!({"verdict": "fail", "reason": "no birth among the classified cells", "births": listed});
    };
    let restart = &instant["restart"];
    // Every cell whose presence changed at that instant: its births and its
    // exhaustions in the phase-mode owner's transactions.
    let mut changed: Vec<usize> = Vec::new();
    let mut l1_changes = Vec::new();
    for tr in restart["transactions"].as_array().into_iter().flatten() {
        if tr["owner"] == "phase modes" {
            for ev in tr["events"].as_array().into_iter().flatten() {
                if let Some(c) = ev["birth"].as_u64().or_else(|| ev["exhaustion"].as_u64()) {
                    changed.push(c as usize);
                }
            }
        }
        if tr["owner"] == "network L1" {
            l1_changes.extend(
                tr["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| json!({"path": c["path"], "after": c["after"], "cause": c["cause"]})),
            );
        }
    }
    let reads: Vec<String> = changed
        .iter()
        .filter(|c| read_set.contains(c))
        .map(|c| name(*c))
        .collect();
    let presence_due = !reads.is_empty();
    let located = instant["kinds"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|k| k == "located roots");
    let mut reasons: Vec<String> = Vec::new();
    let mut evaluable = true;
    if side(cell) != "hot" {
        reasons.push(format!(
            "the first classified birth, {}, is {}-side",
            name(cell),
            side(cell)
        ));
    }
    if !located {
        reasons.push("the birth is not at a located root".into());
    }
    if instant["class"] != "R" {
        reasons.push(format!(
            "its instant is class {}, not a counted R restart",
            instant["class"]
        ));
    }
    if !l1_active {
        reasons.push("L1 is not composed and active: it decides no vapour path".into());
    }
    match restart["modes_changed"].as_bool() {
        Some(true) => {}
        Some(false) => reasons.push("the restart reports no phase-mode change".into()),
        None => evaluable = false,
    }
    match restart["presence_changed"].as_bool() {
        Some(p) if p == presence_due => {}
        Some(p) => reasons.push(format!(
            "presence_changed {p}, but a read cell changed presence: {presence_due} ({reads:?})"
        )),
        None => evaluable = false,
    }
    let verdict = if !reasons.is_empty() {
        "fail"
    } else if evaluable {
        "pass"
    } else {
        "not executable"
    };
    json!({"verdict": verdict, "reasons": reasons, "t_s": t, "cell": name(cell), "side": side(cell),
        "class": instant["class"], "located": located, "l1_active": l1_active, "l1_changes": l1_changes,
        "presence_changed": restart["presence_changed"], "modes_changed": restart["modes_changed"],
        "born_cell_read": read_set.contains(&cell), "presence_changes_in_read_set": reads,
        "read_set": read_set.iter().map(|c| name(*c)).collect::<Vec<_>>(),
        "births": listed,
        "unevaluable": (!evaluable).then_some("the restart reports no presence_changed or modes_changed")})
}

/// The signals and events rule B reads (S3-D50).
pub struct DirectionInputs<'a> {
    pub credited: &'a crate::compare::Credited,
    pub zero: f64,
    /// The declared part's end after zero (rule I).
    pub end: f64,
    pub reactor_trip: Option<f64>,
    pub gcb_open: Option<f64>,
    /// Each SG's relief openings and closings after zero: (SG, +1/-1, t).
    pub sg_relief: Vec<(String, i64, f64)>,
    /// Every rotor's angular momentum at each output (t absolute).
    pub rotors: &'a [(f64, Vec<f64>)],
    pub chatter: Value,
    pub donor_flips: usize,
}

/// One instance's (t after zero, x) over [from, to].
fn span_series(i: &DirectionInputs, key: &str, k: usize, from: f64, to: f64) -> Vec<(f64, f64)> {
    let Ok(series) = i.credited.output(key) else {
        return Vec::new();
    };
    let Some(x) = series.get(k) else {
        return Vec::new();
    };
    i.credited
        .t
        .iter()
        .zip(x)
        .map(|(t, v)| (t - i.zero, *v))
        .filter(|(t, _)| *t >= from - 1e-9 && *t <= to + 1e-9)
        .collect()
}
fn at(s: &[(f64, f64)], t: f64) -> Option<f64> {
    s.iter()
        .rev()
        .find(|(u, _)| *u <= t + 1e-9)
        .or(s.first())
        .map(|p| p.1)
}
fn line(id: &str, ok: Option<bool>, detail: Value) -> Value {
    json!({"id": id, "verdict": match ok { Some(true) => "pass", Some(false) => "fail", None => "not executable" }, "detail": detail})
}
fn falls(s: &[(f64, f64)]) -> Option<bool> {
    Some(s.last()?.1 < s.first()?.1)
}
fn rises_then_falls(s: &[(f64, f64)]) -> Option<bool> {
    if s.len() < 3 {
        return None;
    }
    let max = s[1..s.len() - 1]
        .iter()
        .map(|p| p.1)
        .fold(f64::NEG_INFINITY, f64::max);
    Some(max > s[0].1 && s[s.len() - 1].1 < max)
}
fn dips_then_recovers(s: &[(f64, f64)]) -> Option<bool> {
    if s.len() < 3 {
        return None;
    }
    let min = s[1..s.len() - 1]
        .iter()
        .map(|p| p.1)
        .fold(f64::INFINITY, f64::min);
    Some(min < s[0].1 && s[s.len() - 1].1 > min)
}
fn instances(i: &DirectionInputs, key: &str) -> usize {
    i.credited.output(key).map_or(0, Vec::len)
}

/// Rule B as signed (S3-D50): C2's r3 rows and C3's block statements as
/// signed checks over the declared part; magnitudes and the rows S3-D50
/// keeps reported (PZR level "stabilizes", loop flow "then ≈") are reported.
pub fn directions(case: Case, spec: &Value, i: &DirectionInputs) -> Value {
    let e = i.end;
    let mut lines: Vec<Value> = Vec::new();
    match case {
        Case::C5 => {
            return json!({"family": "B directions", "verdict": "not executable",
                "reason": "C5's directions are judged by s3_harness::c5::directions"});
        }
        Case::C1 => {
            return json!({"family": "B directions", "verdict": "not applicable", "reason": "C1 is a hold: no direction is declared"});
        }
        Case::C2 => {
            let s = |k: &str, j: usize| span_series(i, k, j, 0., e);
            lines.push(line(
                "core power falls",
                falls(&s("core_power_w", 0)),
                json!(null),
            ));
            for j in 0..instances(i, "hot_leg_k") {
                lines.push(line(
                    &format!("T_hot[{j}] falls"),
                    falls(&s("hot_leg_k", j)),
                    json!(null),
                ));
            }
            let fuel: Vec<Option<bool>> = (0..instances(i, "fuel_doppler_k"))
                .map(|j| falls(&s("fuel_doppler_k", j)))
                .collect();
            lines.push(line(
                "fuel temperature falls (every region)",
                if fuel.is_empty() {
                    None
                } else {
                    Some(fuel.iter().all(|f| *f == Some(true)))
                },
                json!({"regions": fuel.len()}),
            ));
            lines.push(line(
                "T_avg falls",
                falls(&s("average_coolant_k", 0)),
                json!(null),
            ));
            for j in 0..instances(i, "cold_leg_k") {
                lines.push(line(
                    &format!("T_cold[{j}] rises then falls"),
                    rises_then_falls(&s("cold_leg_k", j)),
                    json!(null),
                ));
            }
            let pt1 = s("pzr_roof_pa", 0);
            let peak =
                pt1.iter().copied().fold(
                    (0., f64::NEG_INFINITY),
                    |a, p| if p.1 > a.1 { p } else { a },
                );
            lines.push(line("PT1 rises then falls", rises_then_falls(&pt1), json!({"peak_pa": peak.1, "at_s": peak.0, "probe": "14.922 MPa at +1.45 s (reported)"})));
            let level = s("pzr_level_m", 0);
            let quarter = |q0: f64, q1: f64| {
                let w: Vec<&(f64, f64)> = level
                    .iter()
                    .filter(|(t, _)| *t >= q0 * e && *t <= q1 * e)
                    .collect();
                (w.len() > 1)
                    .then(|| (w[w.len() - 1].1 - w[0].1).abs() / (w[w.len() - 1].0 - w[0].0))
            };
            lines.push(line("PZR level falls", falls(&level), json!({"stabilizes (reported, S3-D50)": {"first_quarter_mean_abs_slope_m_s": quarter(0., 0.25), "last_quarter_mean_abs_slope_m_s": quarter(0.75, 1.)}})));
            for j in 0..instances(i, "sg_pressure_pa") {
                let sg = ["A", "B", "C", "D"][j.min(3)];
                let first_crack = i
                    .sg_relief
                    .iter()
                    .filter(|(g, d, _)| g == sg && *d > 0)
                    .map(|r| r.2)
                    .fold(f64::INFINITY, f64::min);
                let closes = i
                    .sg_relief
                    .iter()
                    .filter(|(g, d, _)| g == sg && *d < 0)
                    .count();
                let up = span_series(i, "sg_pressure_pa", j, 0., first_crack.min(e));
                let rose = up.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max)
                    > up.first().map_or(f64::INFINITY, |p| p.1);
                let ok = first_crack.is_finite().then_some(rose && closes > 0);
                lines.push(line(&format!("SG {sg} pressure rises to relief and cycles"), ok, json!({"first_crack_s": first_crack, "closings": closes, "range": "6.6-7.0 MPa reported"})));
            }
            for j in 0..instances(i, "sg_liquid_m3") {
                lines.push(line(
                    &format!("SG[{j}] collapsed volume falls, partial recovery"),
                    dips_then_recovers(&s("sg_liquid_m3", j)),
                    json!(null),
                ));
            }
            let o3 = spec["lines"]["O3"]["window_s"]
                .as_array()
                .and_then(|w| Some((w.first()?.as_f64()?, w.get(1)?.as_f64()?)));
            for j in 0..instances(i, "loop_flow_kg_s") {
                let ok = o3.map(|(a, b)| {
                    let w = span_series(i, "loop_flow_kg_s", j, a, b);
                    let start = at(&span_series(i, "loop_flow_kg_s", j, 0., e), a);
                    let min = w.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
                    start.is_some_and(|x0| min < x0)
                });
                lines.push(line(
                    &format!("loop flow[{j}] dips during the transfer"),
                    ok,
                    json!({"window_s": o3, "then ≈": "reported (S3-D50)"}),
                ));
            }
            let speed = s("turbine_speed_rad_s", 0);
            let t20 = e.min(20.);
            lines.push(line(
                "turbine speed falls",
                match (at(&speed, t20), speed.first()) {
                    (Some(x), Some(x0)) => Some(x < x0.1),
                    _ => None,
                },
                json!({"at_s": t20}),
            ));
            let power = s("generator_power_w", 0);
            let ok = i.gcb_open.map(|g| {
                power
                    .iter()
                    .filter(|(t, _)| *t < g - 1e-9)
                    .all(|(_, x)| *x > 0.)
                    && power
                        .iter()
                        .filter(|(t, _)| *t > g + 1e-9)
                        .all(|(_, x)| *x == 0.)
            });
            lines.push(line(
                "generator export -> 0 at the breaker",
                ok,
                json!({"gcb_open_s": i.gcb_open}),
            ));
        }
        Case::C3 => {
            let d = &spec["networkProbeDirections"];
            let trip = i.reactor_trip;
            let idle = span_series(i, "idle_branch_kg_s", 0, 0., e);
            let reversal = idle.iter().find(|(_, x)| *x < 0.).map(|p| p.0);
            lines.push(line("idle branch reverses", idle.first().map(|f| f.1 > 0. && reversal.is_some()), json!({"face": "PUMP.A1->COLD.A", "reversal_s": reversal, "probe_s": d["idleBranchReversal_s"]})));
            let rotor: Vec<(f64, f64)> = i
                .rotors
                .iter()
                .map(|(t, m)| (t - i.zero, m.first().copied().unwrap_or(f64::NAN)))
                .filter(|(t, _)| *t >= -1e-9 && *t <= e + 1e-9)
                .collect();
            lines.push(line(
                "idle pump slows",
                falls(&rotor),
                json!({"probe_rad_s": d["idlePumpSpeed_rad_s"]}),
            ));
            lines.push(line(
                "no reverse rotation",
                (!rotor.is_empty()).then(|| rotor.iter().all(|(_, x)| *x >= 0.)),
                json!(null),
            ));
            lines.push(json!({"id": "no chattering", "verdict": i.chatter["verdict"], "detail": i.chatter}));
            lines.push(json!({"id": "donor flips", "verdict": "reported", "detail": {"run": i.donor_flips, "probe": d["donorFlips"]}}));
            let t_end = trip.unwrap_or(e).min(e);
            let upto = |k: &str, j: usize| span_series(i, k, j, 0., t_end);
            lines.push(line(
                "loop A falls (to the trip)",
                falls(&upto("loop_flow_kg_s", 0)),
                json!(null),
            ));
            lines.push(line(
                "loop B rises (to the trip)",
                falls(&upto("loop_flow_kg_s", 1)).map(|f| !f),
                json!({"slightly": "reported"}),
            ));
            let core: Vec<(f64, f64)> = upto("loop_flow_kg_s", 0)
                .iter()
                .zip(upto("loop_flow_kg_s", 1))
                .map(|(a, b)| (a.0, a.1 + b.1))
                .collect();
            lines.push(line(
                "core flow falls (sum of the loop flows, S3-D50)",
                falls(&core),
                json!(null),
            ));
            for j in 0..instances(i, "hot_leg_k") {
                lines.push(line(
                    &format!("T_hot[{j}] rises before the trip"),
                    falls(&upto("hot_leg_k", j)).map(|f| !f),
                    json!(null),
                ));
            }
            let dt: Vec<(f64, f64)> = upto("core_outlet_k", 0)
                .iter()
                .zip(upto("core_inlet_k", 0))
                .map(|(a, b)| (a.0, a.1 - b.1))
                .collect();
            lines.push(line(
                "core dT rises before the trip",
                falls(&dt).map(|f| !f),
                json!(null),
            ));
            let duty: Vec<(f64, f64)> = upto("sg_metal_heat_w", 0)
                .iter()
                .zip(upto("sg_metal_heat_w", 1))
                .map(|(a, b)| (a.0, a.1 / b.1))
                .collect();
            lines.push(line(
                "SG-A duty falls against SG-B",
                falls(&duty),
                json!(null),
            ));
            for (k, name) in [("core_power_w", "power"), ("average_coolant_k", "T_avg")] {
                let after = trip.map(|t| span_series(i, k, 0, t, e));
                lines.push(match after {
                    Some(s) => line(&format!("{name} falls after the trip"), falls(&s), json!(null)),
                    None => json!({"id": format!("{name} falls after the trip"), "verdict": "not applicable", "detail": "no reactor trip"}),
                });
            }
        }
    }
    let verdict = overall_of(
        lines
            .iter()
            .map(|l| l["verdict"].as_str().unwrap_or("?"))
            .filter(|v| *v != "reported"),
    );
    json!({"family": "B directions", "verdict": verdict, "rule": "S3-D50: the signed draft (lanes/s3gates/b-directions-draft.md) over the declared part [0, rule I's end]; magnitudes reported", "lines": lines})
}

/// SS-1's signal set as S3-D51 names it: (credited key, is a temperature).
pub const SS1_SIGNALS: [(&str, bool); 11] = [
    ("hot_leg_k", true),
    ("cold_leg_k", true),
    ("average_coolant_k", true),
    ("core_power_w", false),
    ("pzr_roof_pa", false),
    ("sg_pressure_pa", false),
    ("loop_flow_kg_s", false),
    ("steam_flow_kg_s", false),
    ("generator_power_w", false),
    // Reported beside the judged set (r3 names it; S3-D51 does not).
    ("core_outlet_k", true),
    ("core_inlet_k", true),
];

/// C1's SS-1 (S3-D51): over `ss1Duration_s` on the 0.1 s output grid, the
/// range of each 2 Hz-filtered signal against its bound (temperatures:
/// `ss1TemperatureRange_K`; the rest: `ss1OtherRangeFractionOfMean` of the
/// mean). Judged on S3-D51's named signals (per-loop hot and cold legs,
/// average coolant, core power, PT1, each SG pressure, each loop flow, each
/// steam flow at the main-steam pickup, generator power); the core outlet
/// and inlet are reported. A missing signal or a shorter run is not
/// executable. Provisional (this Mac, F1).
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
    let judged: Vec<&str> = SS1_SIGNALS[..9].iter().map(|(k, _)| *k).collect();
    let mut out = serde_json::Map::new();
    let mut within = true;
    let mut missing: Vec<&str> = judged.clone();
    for (k, is_temperature, x) in series {
        let key = k.split('[').next().unwrap_or(k);
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
        let is_judged = judged.contains(&key);
        if is_judged {
            within &= value <= bound;
            missing.retain(|m| *m != key);
        }
        out.insert(k.clone(), json!({"range": value, "bound": bound, "relative": !is_temperature, "judged": is_judged, "samples": x.len()}));
    }
    let complete = declared.is_some_and(|d| run_s >= d - 1e-6);
    let verdict = if !complete || !missing.is_empty() {
        "not executable as declared"
    } else if within {
        "pass"
    } else {
        "fail"
    };
    json!({"family": "C1 SS-1", "verdict": verdict, "label": PROVISIONAL,
        "rule": "S3-D51: 2 Hz-filtered ranges on the 0.1 s output grid over ss1Duration_s; temperatures in K, the rest relative to the mean",
        "declared_duration_s": declared, "run_s": run_s, "grid_s": dt, "missing_signals": missing, "within": within,
        "threshold_source": "ld01-s3-cases-c1c3 cases.C1.ss1*; signals S3-D51", "outputs": out})
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

    type Signals = [(&'static str, Vec<Box<dyn Fn(f64) -> f64>>)];

    /// A synthetic credited record on a 0.1 s grid from `zero`.
    fn record(zero: f64, n: usize, signals: &Signals) -> crate::compare::Credited {
        let mut c = crate::compare::Credited::default();
        for k in 0..=n {
            let t = k as f64 * 0.1;
            let sample: Vec<(&str, Vec<f64>)> = signals
                .iter()
                .map(|(key, fs)| (*key, fs.iter().map(|f| f(t)).collect()))
                .collect();
            c.push(zero + t, &sample).unwrap();
        }
        c
    }
    fn f(g: impl Fn(f64) -> f64 + 'static) -> Box<dyn Fn(f64) -> f64> {
        Box::new(g)
    }

    #[test]
    fn rule_f_flags_a_kink_and_maps_it_to_a_logged_instant() {
        let t: Vec<f64> = (0..=1000).map(|k| k as f64 * 0.002).collect();
        // A pressure ramp whose slope steps by 10 kPa/s at 1.0 s: second
        // difference 10e3 * 0.002 = 20 Pa against 4 tau = 4 (1e-5 * 1.5e7 * 0 + 2) = 8 Pa.
        let x: Vec<f64> = t
            .iter()
            .map(|s| 1.5e7 + if *s > 1. { 1e4 * (s - 1.) } else { 0. })
            .collect();
        let sig = vec![("pzr_roof_pa".to_string(), x.clone(), 2.)];
        let r = smoothness_signed(&t, &sig, 0., &[1.0]);
        assert_eq!(r["verdict"], "pass", "{r}");
        assert_eq!(r["flagged"], 1);
        let r = smoothness_signed(&t, &sig, 0., &[1.5]);
        assert_eq!(r["verdict"], "fail");
        assert_eq!(r["unmapped"], 1);
        // Within 4 tau (the relative class at 1e-5 * 1.5e7 = 150 Pa) nothing flags.
        assert_eq!(smoothness_signed(&t, &sig, 1e-5, &[])["flagged"], 0);
        // A smooth parabola (second difference 2 h^2 = 8e-6) flags only
        // below its class: none at a_x = 1e-5, every sample at 1e-6.
        let p: Vec<f64> = t.iter().map(|s| s * s).collect();
        assert_eq!(
            smoothness_signed(&t, &[("q".into(), p.clone(), 1e-5)], 0., &[])["verdict"],
            "pass"
        );
        assert_eq!(
            smoothness_signed(&t, &[("q".into(), p, 1e-6)], 0., &[])["verdict"],
            "fail"
        );
        assert_eq!(
            smoothness_signed(&t, &[], 1e-5, &[])["verdict"],
            "not executable"
        );
    }

    #[test]
    fn o4_prime_judges_the_first_classified_birth() {
        let birth = |t: f64, cell: u64, class: &str, located: bool, presence: Option<bool>| {
            let mut r = json!({"transactions": [{"owner": "phase modes", "events": [{"birth": cell}]},
                {"owner": "network L1", "changes": [{"path": 2 * cell + 1, "after": "Free", "cause": "Birth"}]}],
                "modes_changed": true});
            if let Some(p) = presence {
                r["presence_changed"] = json!(p);
            }
            json!({"t_s": 100. + t, "class": class, "kinds": if located { json!(["located roots"]) } else { json!(["frame"]) }, "restart": r})
        };
        // Cells: 0 SURGE (excluded), 1 NECK (hot, outside the read set),
        // 2 MAIN (hot, read), 3 a cold leg (read).
        let sides = ["excluded", "hot", "hot", "cold"];
        let names: Vec<String> = ["SURGE", "HOUSING.NECK", "HOUSING.MAIN", "COLD.A1"]
            .map(String::from)
            .to_vec();
        let reads = [2, 3];
        let run = vec![
            birth(24.5, 0, "R", true, Some(false)),
            birth(39.17, 1, "R", true, Some(false)),
            birth(39.7, 2, "R", true, Some(true)),
        ];
        let o = first_classified_birth(&run, 100., &sides, &names, &reads, true);
        assert_eq!(o["verdict"], "pass", "{o}");
        assert_eq!(o["cell"], "HOUSING.NECK");
        assert_eq!(o["born_cell_read"], false);
        assert!((o["t_s"].as_f64().unwrap() - 39.17).abs() < 1e-9);
        // The read set is data: NECK read, its restart must recompile.
        assert_eq!(
            first_classified_birth(&run, 100., &sides, &names, &[1, 2], true)["verdict"],
            "fail"
        );
        // A recompile for a cell outside the read set fails.
        let mut v = run.clone();
        v[1] = birth(39.17, 1, "R", true, Some(true));
        assert_eq!(
            first_classified_birth(&v, 100., &sides, &names, &reads, true)["verdict"],
            "fail"
        );
        // A cold-side first classified birth, an unlocated birth, a class-S
        // instant, or L1 not deciding, each fails.
        let mut cold = run.clone();
        cold.insert(1, birth(30., 3, "R", true, Some(true)));
        let c = first_classified_birth(&cold, 100., &sides, &names, &reads, true);
        assert_eq!(
            (c["verdict"].as_str(), c["side"].as_str()),
            (Some("fail"), Some("cold"))
        );
        let mut v = run.clone();
        v[1] = birth(39.17, 1, "R", false, Some(false));
        assert_eq!(
            first_classified_birth(&v, 100., &sides, &names, &reads, true)["verdict"],
            "fail"
        );
        let mut v = run.clone();
        v[1] = birth(39.17, 1, "S", true, Some(false));
        assert_eq!(
            first_classified_birth(&v, 100., &sides, &names, &reads, true)["verdict"],
            "fail"
        );
        assert_eq!(
            first_classified_birth(&run, 100., &sides, &names, &reads, false)["verdict"],
            "fail"
        );
        // A restart that does not report its presence is not executable;
        // only excluded births fail.
        let mut v = run.clone();
        v[1] = birth(39.17, 1, "R", true, None);
        assert_eq!(
            first_classified_birth(&v, 100., &sides, &names, &reads, true)["verdict"],
            "not executable"
        );
        assert_eq!(
            first_classified_birth(&run[..1], 100., &sides, &names, &reads, true)["verdict"],
            "fail"
        );
    }

    #[test]
    fn chattering_follows_its_rule_as_data() {
        let change = |t: f64, path: u64, locked: bool, cause: &str, drive: f64| {
            json!({"t_s": t, "kinds": ["located roots"], "restart": {"transactions": [{"changes": [{"path": path, "face": 3, "phase": 1, "cause": cause, "drive_pa": drive,
                "after": if locked { json!({"Locked": "To"}) } else { json!("Free") }}]}]}})
        };
        let log = vec![
            change(1., 5, true, "ContactRoot", 0.),
            change(2., 5, false, "DriveRoot", 0.),
            change(4., 5, true, "ContactRoot", 0.),
            change(5., 5, false, "DriveRoot", 0.),
            change(6., 5, true, "AtRest", 50.),
        ];
        let entries = |u4: f64, u6: f64| {
            vec![
                json!({"t_s": 4., "max_units": u4}),
                json!({"t_s": 6., "max_units": u6}),
            ]
        };
        let tol = vec![0.; 6]
            .into_iter()
            .chain([0., 10.])
            .collect::<Vec<f64>>();
        let n4: Value = serde_json::from_str(N4_PRIME_READING).unwrap();
        // Both re-closings follow a located exhaustion / reversal from a
        // consistent state; the reversal's drive (50 Pa) beyond 10 Pa.
        let c = chattering(&log, &n4, &entries(0.5, 0.9), Some(&tol));
        assert_eq!(c["verdict"], "pass", "{c}");
        assert_eq!(
            (c["closings"].as_u64(), c["reclosings"].as_u64()),
            (Some(3), Some(2))
        );
        // An inconsistent pre-state fails.
        let c = chattering(&log, &n4, &entries(1.5, 0.9), Some(&tol));
        assert_eq!(c["verdict"], "fail");
        assert_eq!(c["failing"][0]["t_s"], 4.);
        // A reversal's drive within its tolerance fails.
        let tight = vec![0.; 6]
            .into_iter()
            .chain([0., 80.])
            .collect::<Vec<f64>>();
        assert_eq!(
            chattering(&log, &n4, &entries(0.5, 0.9), Some(&tight))["verdict"],
            "fail"
        );
        // A reversal whose drive draws from the holding end (To) fails.
        let mut away = log.clone();
        away[4] = change(6., 5, true, "AtRest", -50.);
        let c = chattering(&away, &n4, &entries(0.5, 0.9), Some(&tol));
        assert_eq!(c["verdict"], "fail", "{c}");
        assert_eq!(c["failing"][0]["t_s"], 6.);
        // A re-closing at an unlocated transaction, or with another cause,
        // fails.
        let mut unlocated = log.clone();
        unlocated[2]["kinds"] = json!(["frame"]);
        assert_eq!(
            chattering(&unlocated, &n4, &entries(0.5, 0.9), Some(&tol))["verdict"],
            "fail"
        );
        let mut other = log.clone();
        other[2] = change(4., 5, true, "DriveAtStart", 0.);
        assert_eq!(
            chattering(&other, &n4, &entries(0.5, 0.9), Some(&tol))["verdict"],
            "fail"
        );
        // The phase-mode owner's exhaustion locks (`vaporPathContacts`)
        // are re-closings too.
        let mut exhausted = log.clone();
        exhausted[2] = json!({"t_s": 4., "kinds": ["located roots"], "restart": {"transactions": [{"owner": "phase modes",
            "vaporPathContacts": {"changes": [{"path": 5, "face": 3, "phase": 1, "cause": "Exhaustion", "drive_pa": 0., "after": {"Locked": "To"}}]}}]}});
        let c = chattering(&exhausted, &n4, &entries(0.5, 0.9), Some(&tol));
        assert_eq!(
            (c["verdict"].as_str(), c["reclosings"].as_u64()),
            (Some("pass"), Some(2)),
            "{c}"
        );
        // Without the drive tolerances the reversal is not executable.
        assert_eq!(
            chattering(&log, &n4, &entries(0.5, 0.9), None)["verdict"],
            "not executable"
        );
        // The pinned r1 criterion, swapped in as data: two relocks fail.
        let r1 = json!({"criterion": "relock_after_release", "max_relocks": 0, "within_s": null});
        assert_eq!(chattering(&log, &r1, &[], None)["relocks"], 2);
        assert_eq!(chattering(&log, &r1, &[], None)["verdict"], "fail");
        let within =
            json!({"criterion": "relock_after_release", "max_relocks": 0, "within_s": 0.5});
        assert_eq!(chattering(&log, &within, &[], None)["verdict"], "pass");
        assert_eq!(
            chattering(&log, &json!({"criterion": "other"}), &[], None)["verdict"],
            "not executable"
        );
    }

    #[test]
    fn c2_directions_are_signed_checks_on_the_signals() {
        let zero = 500.;
        let good = record(
            zero,
            300,
            &[
                ("core_power_w", vec![f(|t| 3e9 * (-t).exp() + 1e8)]),
                ("hot_leg_k", vec![f(|t| 600. - t), f(|t| 600. - t)]),
                ("fuel_doppler_k", vec![f(|t| 900. - t)]),
                ("average_coolant_k", vec![f(|t| 575. - 0.5 * t)]),
                (
                    "cold_leg_k",
                    vec![f(|t| 560. + t * (5. - t)), f(|t| 560. + t * (5. - t))],
                ),
                ("pzr_roof_pa", vec![f(|t| 1.5e7 + 1e5 * t * (3. - t))]),
                ("pzr_level_m", vec![f(|t| 4. + 1. / (1. + t))]),
                (
                    "sg_pressure_pa",
                    vec![
                        f(|t| 6.3e6 + 1e5 * t.min(5.)),
                        f(|t| 6.3e6 + 1e5 * t.min(5.)),
                    ],
                ),
                (
                    "sg_liquid_m3",
                    vec![
                        f(|t| 100. - 10. * t * (-t / 3.).exp()),
                        f(|t| 100. - 10. * t * (-t / 3.).exp()),
                    ],
                ),
                (
                    "loop_flow_kg_s",
                    vec![f(|t| {
                        if (0.4..0.8).contains(&t) {
                            9000.
                        } else {
                            9300.
                        }
                    })],
                ),
                ("turbine_speed_rad_s", vec![f(|t| 157. - 0.1 * t)]),
                (
                    "generator_power_w",
                    vec![f(|t| if t <= 0.3 { 1e9 } else { 0. })],
                ),
            ],
        );
        let rotors: Vec<(f64, Vec<f64>)> = Vec::new();
        let inputs = DirectionInputs {
            credited: &good,
            zero,
            end: 30.,
            reactor_trip: Some(0.15),
            gcb_open: Some(0.3),
            sg_relief: vec![
                ("A".into(), 1, 1.6),
                ("A".into(), -1, 2.5),
                ("B".into(), 1, 1.6),
                ("B".into(), -1, 2.6),
            ],
            rotors: &rotors,
            chatter: json!({"verdict": "pass"}),
            donor_flips: 0,
        };
        let spec = json!({"lines": {"O3": {"window_s": [0.3, 0.85]}}});
        let d = directions(Case::C2, &spec, &inputs);
        let failing: Vec<&Value> = d["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["verdict"] != "pass")
            .collect();
        assert!(failing.is_empty(), "{failing:?}");
        assert_eq!(d["verdict"], "pass");
        // Core power that rises fails.
        let bad = record(zero, 300, &[("core_power_w", vec![f(|t| 3e9 + t)])]);
        let inputs = DirectionInputs {
            credited: &bad,
            ..inputs
        };
        let d = directions(Case::C2, &spec, &inputs);
        assert_eq!(d["verdict"], "fail");
        assert_eq!(
            directions(Case::C1, &spec, &inputs)["verdict"],
            "not applicable"
        );
    }

    #[test]
    fn c3_directions_include_the_idle_branch_and_the_chatter_rule() {
        let zero = 10.;
        let c = record(
            zero,
            300,
            &[
                ("idle_branch_kg_s", vec![f(|t| 4600. - 400. * t)]),
                (
                    "loop_flow_kg_s",
                    vec![f(|t| 9300. - 100. * t), f(|t| 9300. + 10. * t)],
                ),
                (
                    "hot_leg_k",
                    vec![f(|t| 593. + 0.1 * t), f(|t| 593. + 0.1 * t)],
                ),
                ("core_outlet_k", vec![f(|t| 595. + 0.2 * t)]),
                ("core_inlet_k", vec![f(|_| 563.)]),
                (
                    "sg_metal_heat_w",
                    vec![f(|t| 1.5e9 - 1e7 * t), f(|_| 1.5e9)],
                ),
                (
                    "core_power_w",
                    vec![f(|t| if t < 12. { 3e9 } else { 3e8 - t })],
                ),
                (
                    "average_coolant_k",
                    vec![f(|t| if t < 12. { 578. } else { 578. - t })],
                ),
            ],
        );
        let rotors: Vec<(f64, Vec<f64>)> = (0..=300)
            .map(|k| (zero + k as f64 * 0.1, vec![1000. - 3. * k as f64]))
            .collect();
        let spec = json!({"networkProbeDirections": {"idleBranchReversal_s": 21.6, "idlePumpSpeed_rad_s": [157, 29.3], "donorFlips": 10}});
        let inputs = DirectionInputs {
            credited: &c,
            zero,
            end: 30.,
            reactor_trip: Some(12.),
            gcb_open: None,
            sg_relief: Vec::new(),
            rotors: &rotors,
            chatter: json!({"verdict": "pass"}),
            donor_flips: 3,
        };
        let d = directions(Case::C3, &spec, &inputs);
        let failing: Vec<&Value> = d["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| !matches!(l["verdict"].as_str(), Some("pass" | "reported")))
            .collect();
        assert!(failing.is_empty(), "{failing:?}");
        assert_eq!(d["verdict"], "pass");
        // Chattering fails the case; a reversing rotor fails it too.
        let inputs2 = DirectionInputs {
            chatter: json!({"verdict": "fail"}),
            ..inputs
        };
        assert_eq!(directions(Case::C3, &spec, &inputs2)["verdict"], "fail");
        let spinning: Vec<(f64, Vec<f64>)> = (0..=300)
            .map(|k| (zero + k as f64 * 0.1, vec![100. - 3. * k as f64]))
            .collect();
        let inputs3 = DirectionInputs {
            rotors: &spinning,
            chatter: json!({"verdict": "pass"}),
            ..inputs2
        };
        assert_eq!(directions(Case::C3, &spec, &inputs3)["verdict"], "fail");
    }

    #[test]
    fn ss1_judges_the_named_signals_over_its_declared_duration() {
        let spec = json!({"ss1Duration_s": 3600, "ss1TemperatureRange_K": 0.6, "ss1OtherRangeFractionOfMean": 0.02});
        let flat = |v: f64| vec![v; 2000];
        let mut series: Vec<(String, bool, Vec<f64>)> = SS1_SIGNALS
            .iter()
            .map(|(k, temperature)| {
                (
                    format!("{k}[0]"),
                    *temperature,
                    flat(if *temperature { 570. } else { 1e6 }),
                )
            })
            .collect();
        assert_eq!(ss1(&spec, 3600., &series, 0.1, 2.)["verdict"], "pass");
        assert_eq!(
            ss1(&spec, 600., &series, 0.1, 2.)["verdict"],
            "not executable as declared"
        );
        // A cold leg wandering 1 K fails; a missing steam flow is not executable.
        series[1].2 = (0..2000).map(|k| 570. + k as f64 * 5e-4).collect();
        assert_eq!(ss1(&spec, 3600., &series, 0.1, 2.)["verdict"], "fail");
        series.retain(|(k, _, _)| !k.starts_with("steam_flow"));
        let r = ss1(&spec, 3600., &series, 0.1, 2.);
        assert_eq!(r["verdict"], "not executable as declared");
        assert_eq!(r["missing_signals"], json!(["steam_flow_kg_s"]));
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

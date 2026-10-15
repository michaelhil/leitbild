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

/// Rule G against the block's budgets. `marks` are `(t − zero, recurring
/// CPU-s, recurring instructions)`, `end` the declared part's end after zero
/// (rule I's exit or the run's end), `window` the declared window,
/// `recovery` S1's post-window span. Each span is reported both as raw
/// thread CPU per simulated second and, with `quiet_ratio` (instructions
/// per quiet CPU-s, the common rule), as quiet-equivalent CPU-s per
/// simulated second; the verdict reads the quiet-equivalent when the ratio
/// is given, else the raw value.
pub fn cost(
    case: Case,
    budgets: &Value,
    marks: &[(f64, f64, f64)],
    end: f64,
    window: Option<f64>,
    recovery: f64,
    quiet_ratio: Option<(f64, String)>,
) -> Value {
    let cpu: Vec<(f64, f64)> = marks.iter().map(|m| (m.0, m.1)).collect();
    let ins: Vec<(f64, f64)> = marks.iter().map(|m| (m.0, m.2)).collect();
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
        match span_cpu(&cpu, from, to_cut) {
            Some((a, b, raw)) => {
                let quiet = quiet_ratio.as_ref().and_then(|(r, _)| {
                    span_cpu(&ins, from, to_cut).map(|(_, _, per_s)| per_s / r)
                });
                let value = quiet.unwrap_or(raw);
                let verdict = if value <= bound { "pass" } else { "fail" };
                gates.push(json!({"id": id, "value": value, "basis": if quiet.is_some() { "quiet-equivalent (instructions retired / quiet ratio)" } else { "raw thread CPU" },
                    "raw_cpu_s_per_s": raw, "quiet_equivalent_cpu_s_per_s": quiet,
                    "instructions_per_s": span_cpu(&ins, from, to_cut).map(|x| x.2),
                    "bound": bound, "verdict": verdict,
                    "span_s": [a, b], "declared_span_s": [from, declared], "truncated_by_rule_i": truncated,
                    "threshold_source": source, "label": PROVISIONAL}));
            }
            None => gates.push(json!({"id": id, "value": null, "bound": bound, "verdict": if truncated { "truncated (rule I), not failed" } else { "not executable" },
                "declared_span_s": [from, declared], "truncated_by_rule_i": truncated,
                "threshold_source": source, "label": PROVISIONAL})),
        }
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
        Case::C2 | Case::C3 => {
            if let Some(w) = window {
                entry("cost.s2_window", "s2WindowAndRecovery", 0., w, w);
                entry(
                    "cost.s2_recovery",
                    "s2WindowAndRecovery",
                    w,
                    w + recovery,
                    w + recovery,
                );
            }
            if case == Case::C2 {
                entry("cost.s2_trip_average", "s2TripAverage", 0., last, last);
            }
        }
    }
    let judged: Vec<&Value> = gates
        .iter()
        .filter(|g| g["verdict"] == "pass" || g["verdict"] == "fail")
        .collect();
    let verdict = if judged.iter().any(|g| g["verdict"] == "fail") {
        "fail"
    } else if judged.len() == gates.len() {
        "pass"
    } else {
        "incomplete"
    };
    json!({"family": "G cost", "verdict": verdict, "label": PROVISIONAL,
        "measure": "the run's thread CPU and the process's instructions retired, each less the gate harness's own observer (rule I's admission; and in a gated run the identities, credited outputs and ledger closures), per simulated second; the I&C clients' frames are recurring work. Only quiet-window CPU counts as evidence at the gate run",
        "quiet_ratio": quiet_ratio.as_ref().map(|(r, src)| json!({"instructions_per_cpu_s": r, "source": src})),
        "gates": gates})
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
    json!({"family": "C1 SS-1", "verdict": if !complete { "not executable as declared" } else if within { "pass" } else { "fail" },
        "declared_duration_s": declared, "run_s": run_s, "within_over_the_run": within,
        "reason": (!complete).then_some("SS-1 is declared over 3,600 s on the Linux host (owner F1 open); the ranges over this run are reported"),
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
        // Instructions at 1.4e10 per raw CPU-s; the quiet ratio 1.4e10 makes
        // quiet-equivalent equal raw, 2.8e10 halves it.
        let marks = |rate: &dyn Fn(f64) -> f64, n: usize| -> Vec<(f64, f64, f64)> {
            (0..=n)
                .map(|k| {
                    let t = k as f64 * 0.1;
                    (t, rate(t), rate(t) * 1.4e10)
                })
                .collect()
        };
        let ratio = |r: f64| Some((r, "test".to_string()));
        // C1: 0.05 CPU-s/s over 600 s passes both; 0.2 fails the quiet.
        let c = cost(
            Case::C1,
            &budgets(),
            &marks(&|t| 0.05 * t, 6000),
            600.,
            None,
            10.,
            ratio(1.4e10),
        );
        assert_eq!(c["verdict"], "pass", "{c}");
        let slow = marks(&|t| 0.2 * t, 6000);
        let c = cost(Case::C1, &budgets(), &slow, 600., None, 10., ratio(1.4e10));
        assert_eq!(c["verdict"], "fail");
        assert_eq!(c["gates"][1]["id"], "cost.s2_quiet");
        assert_eq!(c["gates"][1]["verdict"], "fail");
        assert_eq!(c["gates"][0]["verdict"], "pass");
        // The verdict reads the quiet-equivalent: raw 0.2 at a loaded host,
        // 0.1 quiet-equivalent, passes the 0.1 quiet budget; raw is reported.
        let c = cost(Case::C1, &budgets(), &slow, 600., None, 10., ratio(2.8e10));
        assert_eq!(c["gates"][1]["verdict"], "pass", "{c}");
        assert!((c["gates"][1]["raw_cpu_s_per_s"].as_f64().unwrap() - 0.2).abs() < 1e-12);
        // Without a ratio the raw value decides.
        let c = cost(Case::C1, &budgets(), &slow, 600., None, 10., None);
        assert_eq!(c["gates"][1]["basis"], "raw thread CPU");
        assert_eq!(c["gates"][1]["verdict"], "fail");
        // C2: 0.8 in the 20 s window fails it; recovery and the rest pass.
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
            ratio(1.4e10),
        );
        let v = |c: &Value, id: &str| {
            c["gates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(v(&c, "cost.s2_window")["verdict"], "fail");
        assert_eq!(v(&c, "cost.s2_recovery")["verdict"], "pass");
        assert_eq!(
            v(&c, "cost.s2_trip_average")["verdict"],
            "pass",
            "(16 + 4) / 60 = 0.33"
        );
        assert_eq!(c["verdict"], "fail");
        // Rule I's exit inside the window: judged to it, flagged truncated.
        let c = cost(
            Case::C2,
            &budgets(),
            &c2[..=150],
            15.,
            Some(20.),
            10.,
            ratio(1.4e10),
        );
        let w = v(&c, "cost.s2_window");
        assert_eq!(w["truncated_by_rule_i"], true);
        assert_eq!(w["span_s"][1], 15.);
        assert_eq!(
            v(&c, "cost.s2_recovery")["verdict"],
            "truncated (rule I), not failed"
        );
        // A budget the block does not declare is not executable.
        let c = cost(
            Case::C1,
            &json!({"s3UnitRecurringIncludingEvents": 0.5}),
            &c2,
            60.,
            None,
            10.,
            None,
        );
        assert_eq!(c["verdict"], "incomplete");
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
        assert_eq!(ss1(&spec, 3600., &series, 0.002, 2.)["verdict"], "pass");
        let wide: Vec<f64> = (0..2000).map(|k| 570. + k as f64 * 1e-3).collect();
        let series = vec![("average_coolant_k".to_string(), true, wide)];
        assert_eq!(ss1(&spec, 3600., &series, 0.002, 2.)["verdict"], "fail");
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

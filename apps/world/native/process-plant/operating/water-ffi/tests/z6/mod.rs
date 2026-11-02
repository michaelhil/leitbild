//! The Z6 zero-time spectrum analysis shared by `s2_spectrum.rs` and
//! `s3_spectrum.rs` (`mod z6;`): the restricted pencils, the held linear
//! blocks, the gate and its judgement, moved unchanged from `s2_spectrum.rs`.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_plant::joined::{block::Class, operator::Joined};
use leitbild_operating_water::{
    If97,
    klu::SparseLu,
    spectrum::{self, Event, Kind},
    unit::clock::process_cpu_s,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

// ---------------------------------------------------------------------------
// Pencils.

/// `A = ∂F/∂y`, `B = ∂F/∂y'` on the joined structure pattern (colored, exact
/// directional derivatives): the `cj = 0` assembly and its `cj = 1` change.
pub fn pencil(joined: &mut Joined<If97>, t: f64, y: &[f64], yp: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let nnz = joined.structure().unwrap().0.nonzeros();
    let (mut a, mut ab) = (vec![0.; nnz], vec![0.; nnz]);
    joined.jacobian(t, 0., y, yp, &mut a).expect("A");
    joined.jacobian(t, 1., y, yp, &mut ab).expect("A + B");
    let b = ab.iter().zip(&a).map(|(x, y)| x - y).collect();
    (a, b)
}
pub fn residual(joined: &mut Joined<If97>, t: f64, y: &[f64], yp: &[f64]) -> Vec<f64> {
    joined.evaluate(t, y, yp, None, 0., None).expect("residual");
    joined.rows().iter().map(|r| r.value).collect()
}

/// One dense pencil (column-major) and its coordinates' names, algebraic
/// flags and tolerances.
pub struct Dense {
    pub(crate) n: usize,
    pub(crate) a: Vec<f64>,
    pub(crate) b: Vec<f64>,
    pub(crate) labels: Vec<String>,
    pub(crate) algebraic: usize,
    pub(crate) tolerance: Vec<f64>,
}

/// The restricted pencil on `keep`, the coordinates in `eliminate` kept on
/// their constraints by the exact Schur complement (KLU), and each forcing
/// vector reduced the same way.
pub struct Restriction<'a> {
    pub(crate) pointers: &'a [usize],
    pub(crate) indices: &'a [usize],
    pub(crate) keep: &'a [usize],
    pub(crate) eliminate: &'a [usize],
}
impl Restriction<'_> {
    pub fn apply(
        &self,
        a: &[f64],
        b: &[f64],
        forcings: &[Vec<f64>],
        labels: &[String],
        ids: &[f64],
        tolerance: &[f64],
    ) -> (Dense, Vec<Vec<f64>>, Value) {
        let n_all = ids.len();
        let n = self.keep.len();
        let mut at_keep = vec![None; n_all];
        for (k, &i) in self.keep.iter().enumerate() {
            at_keep[i] = Some(k);
        }
        let mut at_elim = vec![None; n_all];
        for (k, &i) in self.eliminate.iter().enumerate() {
            at_elim[i] = Some(k);
        }
        let (mut da, mut db) = (vec![0.; n * n], vec![0.; n * n]);
        let mut b_coupling = 0f64;
        for (kj, &j) in self.keep.iter().enumerate() {
            for p in self.pointers[j]..self.pointers[j + 1] {
                let i = self.indices[p];
                if let Some(r) = at_keep[i] {
                    da[kj * n + r] = a[p];
                    db[kj * n + r] = b[p];
                } else if at_elim[i].is_some() {
                    b_coupling = b_coupling.max(b[p].abs());
                }
            }
        }
        for &j in self.eliminate {
            let column = &b[self.pointers[j]..self.pointers[j + 1]];
            b_coupling = column.iter().fold(b_coupling, |m, v| m.max(v.abs()));
        }
        assert_eq!(
            b_coupling, 0.,
            "an eliminated algebraic coordinate has a B entry"
        );
        let mut forced: Vec<Vec<f64>> = forcings
            .iter()
            .map(|f| self.keep.iter().map(|&i| f[i]).collect())
            .collect();
        let mut schur = json!({"eliminated": self.eliminate.len()});
        if !self.eliminate.is_empty() {
            let m = self.eliminate.len();
            let (mut pointers, mut rows, mut values) = (vec![0i64], Vec::new(), Vec::new());
            for &j in self.eliminate {
                for p in self.pointers[j]..self.pointers[j + 1] {
                    if let Some(r) = at_elim[self.indices[p]] {
                        rows.push(r as i64);
                        values.push(a[p]);
                    }
                }
                pointers.push(rows.len() as i64);
            }
            let mut lu = SparseLu::analyze(m, &pointers, &rows).expect("surface pattern");
            lu.factor(&values).expect("surface block factor");
            let rcond = lu.rcond().expect("rcond");
            // x = A_ss^-1 rhs; then the kept rows lose A_Rs x.
            let mut correct = |rhs: &mut Vec<f64>, out: &mut dyn FnMut(usize, f64)| {
                lu.solve(rhs).expect("surface solve");
                for (k, &s) in self.eliminate.iter().enumerate() {
                    let x = rhs[k];
                    if x == 0. {
                        continue;
                    }
                    for p in self.pointers[s]..self.pointers[s + 1] {
                        if let Some(r) = at_keep[self.indices[p]] {
                            out(r, a[p] * x);
                        }
                    }
                }
            };
            let mut columns = 0;
            for (kj, &j) in self.keep.iter().enumerate() {
                let mut rhs = vec![0.; m];
                let mut any = false;
                for p in self.pointers[j]..self.pointers[j + 1] {
                    if let Some(r) = at_elim[self.indices[p]] {
                        rhs[r] = a[p];
                        any |= a[p] != 0.;
                    }
                }
                if !any {
                    continue;
                }
                columns += 1;
                correct(&mut rhs, &mut |r, v| da[kj * n + r] -= v);
            }
            for (f, out) in forcings.iter().zip(forced.iter_mut()) {
                let mut rhs: Vec<f64> = self.eliminate.iter().map(|&i| f[i]).collect();
                if rhs.iter().all(|v| *v == 0.) {
                    continue;
                }
                correct(&mut rhs, &mut |r, v| out[r] -= v);
            }
            schur = json!({"eliminated": m, "kept_columns_coupled": columns, "klu_rcond": rcond});
        }
        (
            Dense {
                n,
                a: da,
                b: db,
                labels: self.keep.iter().map(|&i| labels[i].clone()).collect(),
                algebraic: self.keep.iter().filter(|&&i| ids[i] == 0.).count(),
                tolerance: self.keep.iter().map(|&i| tolerance[i]).collect(),
            },
            forced,
            schur,
        )
    }
}

/// The held linear blocks' own spectra: within the precursor, inventory and
/// history rows held outside `keep`, `B` is the identity and the coupling
/// graph of `A` is acyclic (decay chains I -> Xe, Pm -> Sm and the fission
/// feed from the fissile inventory; checked by a topological order), so the
/// held block is triangular and its eigenvalues are its diagonal: `-A_ii`,
/// the decay (and depletion) constants.
#[allow(clippy::too_many_arguments)] // One pencil's CSC, its restriction and its names.
pub fn held_linear_blocks(
    pointers: &[usize],
    indices: &[usize],
    a: &[f64],
    b: &[f64],
    keep: &[usize],
    eliminate: &[usize],
    classes: &[Class],
    labels: &[String],
) -> Value {
    let linear = |c: Class| {
        matches!(
            c,
            Class::Precursor
                | Class::Fissile
                | Class::Fertile
                | Class::Iodine
                | Class::Xenon
                | Class::Promethium
                | Class::Samarium
                | Class::FissionHistory
                | Class::CaptureHistory
        )
    };
    let n = classes.len();
    let mut held: Vec<bool> = classes.iter().map(|c| linear(*c)).collect();
    for &i in keep.iter().chain(eliminate) {
        held[i] = false;
    }
    let mut by: BTreeMap<String, (usize, f64, f64)> = BTreeMap::new();
    let mut largest_off = (0f64, String::new());
    let mut b_departure = 0f64;
    let mut indegree = vec![0usize; n];
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); n];
    for j in 0..n {
        if !held[j] {
            continue;
        }
        for p in pointers[j]..pointers[j + 1] {
            let i = indices[p];
            if !held[i] {
                continue;
            }
            if i == j {
                let e = by.entry(format!("{:?}", classes[j])).or_insert((
                    0,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                ));
                // Row y' - (feed - lambda y): A_jj = lambda.
                e.0 += 1;
                e.1 = e.1.min(a[p]);
                e.2 = e.2.max(a[p]);
                b_departure = b_departure.max((b[p] - 1.).abs());
            } else {
                if b[p] != 0. {
                    b_departure = b_departure.max(b[p].abs());
                }
                if a[p] != 0. {
                    out[j].push(i);
                    indegree[i] += 1;
                    if a[p].abs() > largest_off.0 {
                        largest_off = (a[p].abs(), format!("{} <- {}", labels[i], labels[j]));
                    }
                }
            }
        }
    }
    // Kahn's order over the held coupling graph: every node ordered <=> acyclic.
    let mut ready: Vec<usize> = (0..n).filter(|&i| held[i] && indegree[i] == 0).collect();
    let mut ordered = 0;
    while let Some(j) = ready.pop() {
        ordered += 1;
        for &i in &out[j] {
            indegree[i] -= 1;
            if indegree[i] == 0 {
                ready.push(i);
            }
        }
    }
    let total = held.iter().filter(|h| **h).count();
    let blocks: serde_json::Map<String, Value> = by
        .into_iter()
        .map(|(k, (count, lo, hi))| {
            (
                k,
                json!({"coordinates": count, "diagonal_decay_constants_per_s": [lo, hi]}),
            )
        })
        .collect();
    json!({"held_coordinates": total, "blocks": blocks,
        "triangular": ordered == total, "own_eigenvalues": if ordered == total { "-A_ii: the decay and depletion constants" } else { "NOT triangular: eigenvalues not the diagonal" },
        "largest_off_diagonal_within_held": {"value": largest_off.0, "entry": largest_off.1},
        "largest_b_departure_from_identity": b_departure})
}

#[derive(Clone, Copy, Debug)]
pub struct Gate {
    pub(crate) fast_mode_hz: f64,
    pub(crate) light_damping: f64,
    pub(crate) max_excitation_ratio: f64,
}

/// Write one dense pencil for offline analysis into the directory named by
/// `LD01_S2_SPECTRUM_DUMP`, if set: `<name>.json` (labels, algebraic count)
/// and `<name>.a.f64`, `<name>.b.f64` (column-major, little-endian).
pub fn dump(name: &str, d: &Dense) {
    let Some(dir) = std::env::var_os("LD01_S2_SPECTRUM_DUMP") else {
        return;
    };
    let base = Path::new(&dir).join(name.replace('/', "-"));
    let bytes = |m: &[f64]| m.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>();
    for (ext, m) in [("a.f64", &d.a), ("b.f64", &d.b)] {
        let path = base.with_extension(ext);
        assert!(!path.exists(), "dumps are never overwritten");
        std::fs::write(path, bytes(m)).unwrap();
    }
    std::fs::write(
        base.with_extension("json"),
        serde_json::to_vec(&json!({"n": d.n, "labels": d.labels, "algebraic": d.algebraic, "tolerance": d.tolerance})).unwrap(),
    )
    .unwrap();
}

/// Decompose one pencil, excite its events and evaluate the predicates.
pub fn judge(name: &str, d: &Dense, events: &[(&str, Vec<f64>)], gate: Gate) -> (Value, bool) {
    dump(name, d);
    let started = process_cpu_s();
    let s = spectrum::decompose(d.n, &d.a, &d.b).unwrap_or_else(|e| panic!("{name}: {e}"));
    let evs: Vec<Event<'_>> = events
        .iter()
        .map(|(_, v)| Event {
            kind: Kind::Residual,
            vector: v,
        })
        .collect();
    let report = s.report(&evs, &d.tolerance).expect("excitation");
    let dominant = |m: usize, count: usize| -> Vec<Value> {
        let mut w: Vec<(f64, usize)> = s.shapes[m]
            .right
            .iter()
            .enumerate()
            .map(|(i, v)| (v.abs(), i))
            .collect();
        w.sort_by(|x, y| y.0.total_cmp(&x.0));
        w.iter()
            .take(count)
            .map(|(v, i)| json!({"coordinate": d.labels[*i], "weight": v}))
            .collect()
    };
    let norm_a = s.norm_a;
    let null_residual = |m: usize| -> f64 {
        // ||A v|| / (||A||_F ||v||) of the right vector.
        let v = &s.shapes[m].right;
        let mut out = vec![spectrum::Complex::default(); d.n];
        for (col, x) in d.a.chunks_exact(d.n).zip(v) {
            for (o, &aij) in out.iter_mut().zip(col) {
                *o = *o + *x * aij;
            }
        }
        let nv = v.iter().map(|z| z.abs().powi(2)).sum::<f64>().sqrt();
        out.iter().map(|z| z.abs().powi(2)).sum::<f64>().sqrt() / (norm_a * nv)
    };
    let resolved_growing: Vec<Value> = s
        .modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.unstable && !m.marginal)
        .map(|(i, m)| json!({"re": m.lambda.re, "im": m.lambda.im, "hz": m.frequency_hz, "error_bound": m.error_bound, "dominant": dominant(i, 6)}))
        .collect();
    let marginal: Vec<(bool, Value)> = s
        .modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.marginal)
        .map(|(i, m)| {
            let tied = m.lambda.abs() <= m.error_bound;
            (
                tied,
                json!({"re": m.lambda.re, "im": m.lambda.im, "abs": m.lambda.abs(), "error_bound": m.error_bound,
                    "positive": m.unstable, "tied_to_null_direction": tied, "a_v_relative": null_residual(i), "dominant": dominant(i, 6)}),
            )
        })
        .collect();
    let untied = marginal.iter().filter(|(t, _)| !t).count();
    let untied_positive = marginal
        .iter()
        .filter(|(t, v)| !t && v["positive"] == json!(true))
        .count();
    let mut excitations = Vec::new();
    let mut fast_excited_total = 0;
    for ((ename, _), ex) in events.iter().zip(&report.events) {
        let fast: Vec<Value> = ex
            .responses
            .iter()
            .zip(&report.modes)
            .enumerate()
            .filter(|(_, (r, m))| {
                m.frequency_hz > gate.fast_mode_hz
                    && m.damping_ratio.is_some_and(|z| z < gate.light_damping)
                    && r.ratio > gate.max_excitation_ratio
            })
            .map(|(i, (r, m))| json!({"hz": m.frequency_hz, "zeta": m.damping_ratio, "ratio": r.ratio, "coordinate": d.labels[r.coordinate], "dominant": dominant(i, 4)}))
            .collect();
        fast_excited_total += fast.len();
        // A mode with lambda = 0 within its bound turns a step forcing into a
        // drift, not a transient: its rate is reported apart (a degenerate
        // null space has no unique basis, so only the largest rate is kept).
        let null = |m: usize| report.modes[m].lambda.abs() <= report.modes[m].error_bound;
        let drift = (0..ex.responses.len())
            .filter(|&m| null(m))
            .map(|m| {
                let k = if report.modes[m].pair { 2. } else { 1. };
                let sensitivity = s.shapes[m]
                    .right
                    .iter()
                    .zip(&d.tolerance)
                    .map(|(v, t)| v.abs() / t)
                    .fold(0., f64::max);
                (k * ex.responses[m].projection.abs() * sensitivity, m)
            })
            .fold((0., None), |best: (f64, Option<usize>), (rate, m)| {
                if rate > best.0 { (rate, Some(m)) } else { best }
            });
        let max_resolved = (0..ex.responses.len())
            .filter(|&m| !null(m))
            .map(|m| ex.responses[m].ratio)
            .fold(0., f64::max);
        let top: Vec<Value> = {
            let mut idx: Vec<usize> = (0..ex.responses.len()).filter(|&m| !null(m)).collect();
            idx.sort_by(|&x, &y| ex.responses[y].ratio.total_cmp(&ex.responses[x].ratio));
            idx.iter()
                .take(5)
                .map(|&i| {
                    let (r, m) = (&ex.responses[i], &report.modes[i]);
                    json!({"ratio": r.ratio, "hz": m.frequency_hz, "zeta": m.damping_ratio, "re": m.lambda.re, "settle_s": r.settle_s,
                        "coordinate": d.labels[r.coordinate]})
                })
                .collect()
        };
        let fast_modes = (0..ex.responses.len())
            .filter(|&m| report.modes[m].frequency_hz > gate.fast_mode_hz)
            .map(|m| ex.responses[m].ratio)
            .fold(0., f64::max);
        excitations.push(json!({"event": ename, "max_ratio_nonnull_modes": max_resolved, "max_ratio_modes_above_fast_hz": fast_modes,
            "fast_lightly_damped_above_ratio": fast,
            "largest_ratios": top,
            "null_mode_drift": {"largest_rate_tolerances_per_s": drift.0, "dominant": drift.1.map(|m| dominant(m, 4))},
            "forcing_inf_norm_over_tolerance": events.iter().find(|e| e.0 == *ename).map(|e| e.1.iter().zip(&d.tolerance).map(|(f, t)| f.abs() / t).fold(0., f64::max))}));
    }
    let infinite_ok = report.infinite.count == d.algebraic;
    let go = infinite_ok && resolved_growing.is_empty() && untied == 0 && fast_excited_total == 0;
    let slowest: Vec<Value> = report
        .modes
        .iter()
        .take(12)
        .map(|m| json!({"re": m.lambda.re, "im": m.lambda.im, "hz": m.frequency_hz, "zeta": m.damping_ratio, "marginal": m.marginal}))
        .collect();
    let fastest_oscillatory: Vec<Value> = report
        .modes
        .iter()
        .rev()
        .filter(|m| m.frequency_hz > 0.)
        .take(8)
        .map(|m| json!({"hz": m.frequency_hz, "zeta": m.damping_ratio, "re": m.lambda.re}))
        .collect();
    let least_damped: Vec<Value> = {
        let mut osc: Vec<&spectrum::Mode> = report.modes.iter().filter(|m| m.pair).collect();
        osc.sort_by(|x, y| {
            x.damping_ratio
                .unwrap_or(0.)
                .total_cmp(&y.damping_ratio.unwrap_or(0.))
        });
        osc.iter()
            .take(8)
            .map(|m| json!({"hz": m.frequency_hz, "zeta": m.damping_ratio, "re": m.lambda.re}))
            .collect()
    };
    let largest_growth = report
        .modes
        .iter()
        .map(|m| m.lambda.re)
        .fold(f64::NEG_INFINITY, f64::max);
    (
        json!({
            "pencil": name, "dimension": d.n, "lapack_version": report.lapack_version, "dggev_s": report.dggev_seconds,
            "cpu_s": process_cpu_s() - started, "norm_a": report.norm_a, "norm_b": report.norm_b,
            "infinite": {"count": report.infinite.count, "algebraic_coordinates_expected": d.algebraic,
                "zero_columns_of_b": report.infinite.algebraic_coordinates, "threshold": report.infinite.threshold,
                "largest_relative_beta": report.infinite.largest_relative_beta, "smallest_finite_relative_beta": report.infinite.smallest_finite_relative_beta},
            "finite_eigenvalues": report.finite, "reported_modes": report.modes.len(),
            "unstable_flagged": report.unstable, "resolved_growing": resolved_growing, "largest_real_part": largest_growth,
            "marginal": marginal.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>(),
            "marginal_untied": untied, "marginal_untied_positive": untied_positive,
            "excitations": excitations,
            "slowest_modes": slowest, "fastest_oscillatory": fastest_oscillatory, "least_damped_pairs": least_damped,
            "modes_above_fast_hz": report.modes.iter().filter(|m| m.frequency_hz > gate.fast_mode_hz).count(),
            "predicates": {"infinite_equals_algebraic": infinite_ok, "no_resolved_positive_real_part": resolved_growing.is_empty(),
                "marginal_tied_to_null_directions": untied == 0, "no_fast_lightly_damped_mode_excited_above_ratio": fast_excited_total == 0},
            "go": go,
        }),
        go,
    )
}

//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! The joined residual's exact consistent start on direct KLU, and the
//! joined operator as one stock-IDA system.
//!
//! The start is decision 0013's exit, the network's `consistent_start`, on
//! the joined sparse pattern: the algebraic coordinates are projected onto
//! their constraints by Newton with `dg/dy_a` (every differential coordinate
//! held bitwise, the correction's WRMS with the integrator's weights at most
//! 1), then the rates solve one linear system whose differential rows are
//! `dF/dy'` and whose algebraic rows are `dg/dy`, exact in one pass. The
//! matrices come from JAC's block assembly at `cj = 0` and `cj = 1` on its
//! element-exact pattern (lead decision S2-D4); stock KLU's symbolic
//! analyses of that pattern and of the projection's algebraic submatrix are
//! made once and reused by later starts, and every start factors afresh.
//! The colored assemblies on the structural pattern remain the reference
//! the block start is checked against. No IDACalcIC, no iteration of the
//! rates, no tolerance is loosened: a missed bound refuses, naming the row.
//! No solver algorithm lives here.
use crate::klu::SparseLu;
use leitbild_operating_plant::{
    joined::{
        blocks::{Classes, JoinedJacobian, jacobian_blocks},
        operator::Joined,
    },
    network::{Failure, Properties},
    sparse::Pattern,
    thermal::WaterProperties,
};

use std::time::Instant;

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined consistent start: {}", reason.into()))
}

/// Largest magnitude of one class of rows and the first row carrying it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Largest {
    pub value: f64,
    pub row: usize,
}
fn largest(values: impl Iterator<Item = (usize, f64)>) -> Largest {
    values.fold(Largest::default(), |best, (row, v)| {
        let v = v.abs();
        if !best.value.is_nan() && (v.is_nan() || v > best.value) {
            Largest { value: v, row }
        } else {
            best
        }
    })
}

/// What the start did, with its timings.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub constraint_before: Largest,
    pub constraint_after: Largest,
    pub projection_passes: usize,
    /// Largest scaled change of an algebraic coordinate.
    pub correction: Largest,
    pub correction_wrms: f64,
    /// Every row of `F(t, y, y')` after the rate solve.
    pub residual: Largest,
    /// `dg/dy y'` over the algebraic rows.
    pub constraint_rate: Largest,
    /// Passes of the rate solve on the one factorization (the first exact,
    /// later ones removing round-off only).
    pub rate_passes: usize,
    /// The projection's correction of the coordinates exempt from the WRMS
    /// guard (lead decision S2-D21: a transacted owner's algebraic
    /// coordinates), reported, never bounded; `None` when none is exempt.
    pub exempt: Option<Exempt>,
    pub bound: f64,
    /// `"blocks"` or `"colored"`.
    pub assembly: &'static str,
    pub nonzeros: usize,
    /// Colors of the structural pattern (colored assembly only).
    pub colors: usize,
    /// Stock KLU symbolic analyses this start made: the rate system's and
    /// the projection's. A block start reusing its cached analyses makes
    /// none.
    pub analyses: [usize; 2],
    pub jacobian_s: Vec<f64>,
    pub analyze_s: Vec<f64>,
    pub factor_s: Vec<f64>,
    pub solve_s: Vec<f64>,
}

/// The correction of the coordinates a start exempts from its WRMS guard:
/// how many, their own WRMS with the integrator's weights, and the largest
/// weighted change.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Exempt {
    pub coordinates: usize,
    pub wrms: f64,
    pub max: Largest,
}

/// The projection's correction `y - start` over the integrator's weights:
/// the WRMS of every coordinate not `exempt` (the guard's), and the exempt
/// coordinates' own WRMS and largest weighted change (reported). With none
/// exempt the guard's WRMS is over all coordinates, summed in the same
/// order as ever.
fn correction_wrms(
    y: &[f64],
    start: &[f64],
    weights: &[f64],
    exempt: &[bool],
) -> (f64, Option<Exempt>) {
    let weighted: Vec<f64> = y
        .iter()
        .zip(start)
        .zip(weights)
        .map(|((a, b), w)| (a - b) * w)
        .collect();
    let is_exempt = |i: usize| exempt.get(i).copied().unwrap_or(false);
    let guarded = (0..weighted.len()).filter(|i| !is_exempt(*i)).count();
    let wrms = (weighted
        .iter()
        .enumerate()
        .filter(|(i, _)| !is_exempt(*i))
        .map(|(_, v)| v * v)
        .sum::<f64>()
        / guarded as f64)
        .sqrt();
    let count = weighted.len() - guarded;
    let exempted = (count > 0).then(|| {
        let sum: f64 = weighted
            .iter()
            .enumerate()
            .filter(|(i, _)| is_exempt(*i))
            .map(|(_, v)| v * v)
            .sum();
        Exempt {
            coordinates: count,
            wrms: (sum / count as f64).sqrt(),
            max: largest(
                weighted
                    .iter()
                    .copied()
                    .enumerate()
                    .filter(|(i, _)| is_exempt(*i)),
            ),
        }
    });
    (wrms, exempted)
}

fn csc_i64(pointers: &[usize], indices: &[usize]) -> (Vec<i64>, Vec<i64>) {
    (
        pointers.iter().map(|p| *p as i64).collect(),
        indices.iter().map(|r| *r as i64).collect(),
    )
}

/// Stock KLU's symbolic analyses for the block start on one compiled
/// structure, made once and reused: the rate system's (the whole
/// element-exact pattern) and the projection's (its algebraic submatrix,
/// with the submatrix's positions in the pattern's stored order, analyzed
/// again only when the algebraic set changes, as at a grip release). Only
/// KLU's ordering and symbolic structure are reused: every start factors
/// afresh with KLU's pivoting `factor`. A cache made on another pattern
/// refuses.
#[derive(Default)]
pub struct Analyses {
    rates: Option<Rates>,
    projection: Option<Projection>,
    /// Symbolic analyses made so far: rate system, projection.
    made: [usize; 2],
}
struct Rates {
    pointers: Vec<i64>,
    rows: Vec<i64>,
    lu: SparseLu,
}
struct Projection {
    algebraic: Vec<bool>,
    positions: Vec<usize>,
    lu: SparseLu,
}
impl Analyses {
    /// Symbolic analyses made so far: rate system, projection.
    pub fn made(&self) -> [usize; 2] {
        self.made
    }
}

/// The algebraic submatrix of `pattern` (algebraic rows, algebraic
/// columns): its local CSC pattern and each entry's position in the
/// pattern's stored order.
fn submatrix(pattern: &Pattern, algebraic: &[bool]) -> (usize, Vec<i64>, Vec<i64>, Vec<usize>) {
    let (pointers, indices) = (pattern.pointers(), pattern.indices());
    let mut k = 0;
    let local: Vec<Option<usize>> = algebraic
        .iter()
        .map(|a| {
            a.then(|| {
                k += 1;
                k - 1
            })
        })
        .collect();
    let mut sub_pointers = vec![0i64];
    let mut sub_rows = Vec::new();
    let mut positions = Vec::new();
    for (j, a) in algebraic.iter().enumerate() {
        if !a {
            continue;
        }
        for position in pointers[j]..pointers[j + 1] {
            if let Some(r) = local[indices[position]] {
                sub_rows.push(r as i64);
                positions.push(position);
            }
        }
        sub_pointers.push(sub_rows.len() as i64);
    }
    (k, sub_pointers, sub_rows, positions)
}

/// Where the start's matrices come from.
pub enum Matrices<'a> {
    /// JAC's block assembly on its element-exact pattern, with the cached
    /// symbolic analyses: the start's own matrices (lead decision S2-D4).
    Blocks {
        structure: &'a JoinedJacobian,
        analyses: &'a mut Analyses,
    },
    /// The colored assemblies on the operator's structural pattern,
    /// analyzed afresh: the reference the block start is checked against.
    Colored,
}

/// One assembly of `dF/dy + cj dF/dy'` at `(t, y, 0)` into `values`, in the
/// stored order of the matrices' pattern.
fn assemble<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    matrices: &Matrices<'_>,
    t: f64,
    cj: f64,
    y: &[f64],
    values: &mut [f64],
    report: &mut Report,
) -> Result<(), Failure> {
    let zero = vec![0.; y.len()];
    let started = Instant::now();
    match matrices {
        // The block assembly makes its own unseeded evaluation at (t, y, 0)
        // before the operator's local coupler reads it.
        Matrices::Blocks { structure, .. } => {
            jacobian_blocks(joined, structure, t, cj, y, &zero, values, Classes::ALL)?
        }
        Matrices::Colored => joined.jacobian(t, cj, y, &zero, values)?,
    }
    report.jacobian_s.push(started.elapsed().as_secs_f64());
    Ok(())
}

/// The exact consistent start of the joined residual at `t`: `y` holds the
/// projected state on success, and the consistent rates are returned.
#[allow(clippy::too_many_arguments)] // The state, its identity and weights, and the start's controls.
pub fn consistent_start<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    matrices: Matrices<'_>,
    t: f64,
    y: &mut [f64],
    differential: &[f64],
    weights: &[f64],
    bound: f64,
    passes: usize,
) -> Result<(Vec<f64>, Report), Failure> {
    consistent_start_exempting(
        joined,
        matrices,
        t,
        y,
        differential,
        weights,
        &[],
        bound,
        passes,
    )
}

/// [`consistent_start`] with the coordinates marked `exempt` left out of
/// the projection's WRMS guard and reported instead ([`Report::exempt`]):
/// lead decision S2-D21, for a transacted owner's algebraic coordinates
/// after its transaction. Everything else, the constraint and rate bounds
/// included, is unchanged. `exempt` is empty or one flag per coordinate.
#[allow(clippy::too_many_arguments)] // As consistent_start, with the exemption.
pub fn consistent_start_exempting<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    mut matrices: Matrices<'_>,
    t: f64,
    y: &mut [f64],
    differential: &[f64],
    weights: &[f64],
    exempt: &[bool],
    bound: f64,
    passes: usize,
) -> Result<(Vec<f64>, Report), Failure> {
    let n = joined.dimension();
    if y.len() != n
        || differential.len() != n
        || weights.len() != n
        || !(exempt.is_empty() || exempt.len() == n)
        || exempt.iter().zip(differential).any(|(e, d)| *e && *d != 0.)
        || !(bound.is_finite() && bound > 0.)
        || passes == 0
    {
        return Err(fatal(
            "layout, bound or passes, or an exempt differential coordinate",
        ));
    }
    let colored: Pattern;
    let (pattern, colors, assembly): (&Pattern, usize, &'static str) = match &matrices {
        Matrices::Blocks { structure, .. } => (&structure.pattern, 0, "blocks"),
        Matrices::Colored => {
            let (pattern, coloring) = joined
                .structure()
                .ok_or_else(|| fatal("the joined operator has no structure"))?;
            let count = coloring.count();
            colored = pattern.clone();
            (&colored, count, "colored")
        }
    };
    if pattern.rows() != n || pattern.columns() != n {
        return Err(fatal("the matrices' pattern is not the operator's"));
    }
    let (pointers, indices) = (pattern.pointers(), pattern.indices());
    let nnz = indices.len();
    let mut report = Report {
        bound,
        assembly,
        nonzeros: nnz,
        colors,
        ..Report::default()
    };
    // A colored start analyzes afresh into its own cache; a block start
    // uses the structure's.
    let mut fresh = Analyses::default();
    let algebraic: Vec<bool> = differential.iter().map(|d| *d == 0.).collect();
    let zero = vec![0.; n];
    let rows_at = |joined: &mut Joined<P>, y: &[f64], yp: &[f64]| -> Result<Vec<f64>, Failure> {
        joined.evaluate(t, y, yp, None, 0., None)?;
        Ok(joined.rows().iter().map(|r| r.value).collect())
    };
    let constraint = |rows: &[f64]| {
        largest(
            rows.iter()
                .enumerate()
                .filter(|(i, _)| algebraic[*i])
                .map(|(i, r)| (i, *r)),
        )
    };
    let start = y.to_vec();
    let mut rows = rows_at(joined, y, &zero)?;
    report.constraint_before = constraint(&rows);
    report.constraint_after = report.constraint_before;
    let mut values = vec![0.; nnz];
    // 1. Projection of the algebraic coordinates, differential ones held,
    // on the algebraic submatrix of this pattern.
    while (report.constraint_after.value.is_nan() || report.constraint_after.value > bound)
        && report.projection_passes < passes
    {
        report.projection_passes += 1;
        assemble(joined, &matrices, t, 0., y, &mut values, &mut report)?;
        let analyses = match &mut matrices {
            Matrices::Blocks { analyses, .. } => &mut **analyses,
            Matrices::Colored => &mut fresh,
        };
        if analyses
            .projection
            .as_ref()
            .is_some_and(|p| p.algebraic != algebraic)
        {
            analyses.projection = None;
        }
        let projection = match analyses.projection.as_mut() {
            Some(p) => p,
            None => {
                let (m, sub_pointers, sub_rows, positions) = submatrix(pattern, &algebraic);
                let started = Instant::now();
                let lu = SparseLu::analyze(m, &sub_pointers, &sub_rows)
                    .map_err(|e| fatal(format!("projection analysis: {e}")))?;
                report.analyze_s.push(started.elapsed().as_secs_f64());
                report.analyses[1] += 1;
                analyses.made[1] += 1;
                analyses.projection.insert(Projection {
                    algebraic: algebraic.clone(),
                    positions,
                    lu,
                })
            }
        };
        let sub: Vec<f64> = projection.positions.iter().map(|p| values[*p]).collect();
        let started = Instant::now();
        projection
            .lu
            .factor(&sub)
            .map_err(|e| fatal(format!("projection: {e}")))?;
        report.factor_s.push(started.elapsed().as_secs_f64());
        let mut rhs: Vec<f64> = (0..n).filter(|i| algebraic[*i]).map(|i| -rows[i]).collect();
        let started = Instant::now();
        projection
            .lu
            .solve(&mut rhs)
            .map_err(|e| fatal(format!("projection: {e}")))?;
        report.solve_s.push(started.elapsed().as_secs_f64());
        let mut k = 0;
        for (j, a) in algebraic.iter().enumerate() {
            if *a {
                y[j] += rhs[k];
                if rhs[k].abs() > report.correction.value {
                    report.correction = Largest {
                        value: rhs[k].abs(),
                        row: j,
                    };
                }
                k += 1;
            }
        }
        rows = rows_at(joined, y, &zero)?;
        report.constraint_after = constraint(&rows);
    }
    if report.constraint_after.value.is_nan() || report.constraint_after.value > bound {
        return Err(fatal(format!(
            "constraints miss their bound after projection: {:?}",
            report.constraint_after
        )));
    }
    (report.correction_wrms, report.exempt) = correction_wrms(y, &start, weights, exempt);
    if report.correction_wrms.is_nan() || report.correction_wrms > 1. {
        return Err(fatal(format!(
            "the projection exceeds the solver's error scale: WRMS {}",
            report.correction_wrms
        )));
    }
    // 2. The consistent rates: differential rows dF/dy', algebraic rows dg/dy.
    let mut a = vec![0.; nnz];
    assemble(joined, &matrices, t, 0., y, &mut a, &mut report)?;
    let mut ab = vec![0.; nnz];
    assemble(joined, &matrices, t, 1., y, &mut ab, &mut report)?;
    let matrix: Vec<f64> = (0..nnz)
        .map(|p| {
            if algebraic[indices[p]] {
                a[p]
            } else {
                ab[p] - a[p]
            }
        })
        .collect();
    let analyses = match &mut matrices {
        Matrices::Blocks { analyses, .. } => &mut **analyses,
        Matrices::Colored => &mut fresh,
    };
    let lu = match analyses.rates.as_mut() {
        Some(rates) => {
            let same = rates.pointers.len() == pointers.len()
                && rates.rows.len() == nnz
                && rates
                    .pointers
                    .iter()
                    .zip(pointers)
                    .all(|(a, b)| *a == *b as i64)
                && rates.rows.iter().zip(indices).all(|(a, b)| *a == *b as i64);
            if !same {
                return Err(fatal(
                    "the cached analyses belong to another pattern; compile a structure with its own",
                ));
            }
            &mut rates.lu
        }
        None => {
            let (p, r) = csc_i64(pointers, indices);
            let started = Instant::now();
            let lu =
                SparseLu::analyze(n, &p, &r).map_err(|e| fatal(format!("rate analysis: {e}")))?;
            report.analyze_s.push(started.elapsed().as_secs_f64());
            report.analyses[0] += 1;
            analyses.made[0] += 1;
            &mut analyses
                .rates
                .insert(Rates {
                    pointers: p,
                    rows: r,
                    lu,
                })
                .lu
        }
    };
    let started = Instant::now();
    lu.factor(&matrix)
        .map_err(|e| fatal(format!("rates: {e}")))?;
    report.factor_s.push(started.elapsed().as_secs_f64());
    // The rows are linear in y', so one pass is exact; further passes, at
    // most `passes`, only remove the first solve's round-off, as the
    // network's dense consistent_rates does.
    let mut yp = vec![0.; n];
    let mut residual = rows.clone();
    let constraint_rate = |yp: &[f64]| {
        let mut rate = vec![0.; n];
        for j in 0..n {
            for position in pointers[j]..pointers[j + 1] {
                rate[indices[position]] += a[position] * yp[j];
            }
        }
        rate
    };
    for pass in 1..=passes {
        let rate = constraint_rate(&yp);
        let mut step: Vec<f64> = (0..n)
            .map(|i| if algebraic[i] { -rate[i] } else { -residual[i] })
            .collect();
        let started = Instant::now();
        lu.solve(&mut step)
            .map_err(|e| fatal(format!("rates: {e}")))?;
        report.solve_s.push(started.elapsed().as_secs_f64());
        for (v, d) in yp.iter_mut().zip(&step) {
            *v += d;
        }
        residual = rows_at(joined, y, &yp)?;
        report.residual = largest(residual.iter().copied().enumerate());
        let rate = constraint_rate(&yp);
        report.constraint_rate = largest(
            rate.iter()
                .enumerate()
                .filter(|(i, _)| algebraic[*i])
                .map(|(i, v)| (i, *v)),
        );
        report.rate_passes = pass;
        if report.residual.value <= bound && report.constraint_rate.value <= bound {
            break;
        }
    }
    if report.residual.value.is_nan()
        || report.residual.value > bound
        || report.constraint_rate.value.is_nan()
        || report.constraint_rate.value > bound
    {
        return Err(fatal(format!(
            "the consistent-rate solve missed its bound: residual {:?}, constraint rate {:?}",
            report.residual, report.constraint_rate
        )));
    }
    Ok((yp, report))
}

/// The owners (name, coordinate range) whose transaction changed the value
/// of a coordinate that was differential before it (`identity_before`):
/// lead decision S2-D21's transacted owners, such as a seated rod (travel
/// and speed) or a seated relief disc (lift). A mode change alone, or a
/// change of an algebraic coordinate, does not make an owner transacted.
fn transacted_owners(
    owners: &[(&'static str, std::ops::Range<usize>)],
    before: &[f64],
    after: &[f64],
    identity_before: &[f64],
) -> Vec<&'static str> {
    owners
        .iter()
        .filter(|(_, range)| {
            range
                .clone()
                .any(|i| identity_before[i] != 0. && before[i].to_bits() != after[i].to_bits())
        })
        .map(|(name, _)| *name)
        .collect()
}

/// The derived absolute-tolerance classes (lead decision S2-D24, and the
/// lead's 15 Oct rule that they are the default in every S3 run path, never
/// an opt-in), as `owner/Class` of the joined layouts: an algebraic current
/// set by pressure differences takes its absolute tolerance from the
/// pressure class through its own sensitivity. S3-D3's mode-E `M_g`/`U_g`
/// and ELEC's stator class join this list when their owners land.
pub const DERIVED_CLASSES: &[&str] = &["rods/GuideCurrent"];
/// The pressure class whose columns set a derived current.
pub const DERIVED_PRESSURE_CLASS: &str = "network/CellPressure";

/// One coordinate's derived absolute tolerance.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DerivedRow {
    pub coordinate: usize,
    pub label: String,
    pub class: String,
    /// The class tolerance it replaces, and the applied one, solver scaling.
    pub replaced_scaled: f64,
    pub applied_scaled: f64,
    /// The applied tolerance in physical units.
    pub applied: f64,
    /// `|∂m/∂p|` at the governing pressure column, physical units.
    pub sensitivity: f64,
    pub pressure_column: String,
    /// `atol_p = rtol |p|` at that column, Pa.
    pub atol_p_pa: f64,
}

/// What [`derived_tolerances`] applied: the evidence an S3 run path carries
/// (the frame driver's setup requires it).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DerivedTolerances {
    pub rule: &'static str,
    pub classes: Vec<String>,
    pub t_s: f64,
    pub relative: f64,
    pub rows: Vec<DerivedRow>,
}

impl DerivedTolerances {
    /// The record of a reference run that scales every tolerance by
    /// `factor` (an R2-style reference checks the derived class scaled with
    /// the rest, PLAN §9).
    pub fn scaled(&self, factor: f64) -> Self {
        let mut out = self.clone();
        out.relative *= factor;
        for r in &mut out.rows {
            r.applied_scaled *= factor;
            r.applied *= factor;
            r.atol_p_pa *= factor;
        }
        out
    }
}

/// S2-D24 on `atol` (solver scaling) for every coordinate of
/// [`DERIVED_CLASSES`]: from the block Jacobian `∂F/∂y` at `(t, y, y')`, a
/// derived row `r`'s sensitivity to pressure column `j` is
/// `∂m/∂p_j = −J[r,j] / J[r,r]`, and its absolute tolerance is
/// `max_j (rtol |p_j|) |∂m/∂p_j|` over the pressure columns it reads, the
/// basis S2-D24 declares (PLAN §11: `atol_p = rtol |p|`, RODCOST's V1). The
/// rule HARNESS-B's S2 harness and RESTART's probe apply, evaluated at the
/// state the caller names (the composed state, as S2 records it). A
/// covered row without a finite nonzero diagonal or without a pressure
/// column refuses; a composition with no covered coordinate refuses.
#[allow(clippy::too_many_arguments)] // The operator, its structure, the state, the rule's rtol and atol.
pub fn derived_tolerances<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    structure: &JoinedJacobian,
    t: f64,
    y: &[f64],
    yp: &[f64],
    relative: f64,
    atol: &mut [f64],
) -> Result<DerivedTolerances, String> {
    let layouts = joined.layouts();
    let class_of: Vec<String> = layouts
        .iter()
        .flat_map(|(owner, l)| l.classes.iter().map(move |c| format!("{owner}/{c:?}")))
        .collect();
    let labels: Vec<String> = layouts
        .iter()
        .flat_map(|(owner, l)| l.labels.iter().map(move |x| format!("{owner}/{x}")))
        .collect();
    if class_of.len() != y.len() || atol.len() != y.len() {
        return Err("derived tolerances: the layouts do not cover the coordinates".into());
    }
    let pressure: Vec<bool> = class_of
        .iter()
        .map(|c| c == DERIVED_PRESSURE_CLASS)
        .collect();
    let covered: Vec<usize> = (0..y.len())
        .filter(|i| DERIVED_CLASSES.contains(&class_of[*i].as_str()))
        .collect();
    if covered.is_empty() {
        return Err(format!(
            "derived tolerances: no coordinate of {DERIVED_CLASSES:?}"
        ));
    }
    let mut values = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(joined, structure, t, 0., y, yp, &mut values, Classes::ALL)
        .map_err(|e| format!("derived tolerances: block Jacobian: {e:?}"))?;
    let (pointers, indices) = (structure.pattern.pointers(), structure.pattern.indices());
    let index: std::collections::BTreeMap<usize, usize> =
        covered.iter().enumerate().map(|(k, r)| (*r, k)).collect();
    let mut diagonal = vec![None; covered.len()];
    let mut entries: Vec<Vec<(usize, f64)>> = vec![Vec::new(); covered.len()];
    for j in 0..y.len() {
        for position in pointers[j]..pointers[j + 1] {
            if let Some(k) = index.get(&indices[position]) {
                if indices[position] == j {
                    diagonal[*k] = Some(values[position]);
                } else if pressure[j] {
                    entries[*k].push((j, values[position]));
                }
            }
        }
    }
    let scales = joined.scales();
    let mut rows = Vec::with_capacity(covered.len());
    for (k, r) in covered.iter().enumerate() {
        let d = diagonal[k]
            .filter(|d| *d != 0. && d.is_finite())
            .ok_or_else(|| {
                format!(
                    "derived tolerances: {} has no finite nonzero diagonal",
                    labels[*r]
                )
            })?;
        let (applied, sensitivity, j) = entries[k]
            .iter()
            .map(|(j, v)| (relative * y[*j].abs() * (v / d).abs(), (v / d).abs(), *j))
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .ok_or_else(|| {
                format!(
                    "derived tolerances: {} reads no pressure column",
                    labels[*r]
                )
            })?;
        rows.push(DerivedRow {
            coordinate: *r,
            label: labels[*r].clone(),
            class: class_of[*r].clone(),
            replaced_scaled: atol[*r],
            applied_scaled: applied,
            applied: applied * scales[*r],
            sensitivity: sensitivity * scales[*r] / scales[j],
            pressure_column: labels[j].clone(),
            atol_p_pa: relative * y[j].abs() * scales[j],
        });
        atol[*r] = applied;
    }
    Ok(DerivedTolerances {
        rule: "S2-D24: atol_m = max_j (rtol |p_j|) |dm/dp_j|, dm/dp_j = -J[r,j]/J[r,r] from the block Jacobian dF/dy",
        classes: DERIVED_CLASSES.iter().map(|c| c.to_string()).collect(),
        t_s: t,
        relative,
        rows,
    })
}

pub use integrated::{
    Assembly, Discrete, Integrated, JoinedSystem, Restart, Restarted, discrete_restart,
    root_directions,
};

mod integrated {
    use super::{Analyses, Matrices, Report, transacted_owners};
    use crate::ida::{Failure, Ida, KluOrdering, System};
    use leitbild_operating_plant::{
        joined::{
            block::{Command, Transaction},
            blocks::{Classes, JoinedJacobian, jacobian_blocks},
            operator::Joined,
            presence::{PatternCache, PresenceKey, VaporPresence, pattern_cells},
        },
        network::{self, Properties},
        thermal::WaterProperties,
    };

    fn failure(f: network::Failure) -> Failure {
        match f {
            network::Failure::Recoverable(reason) => Failure::Recoverable(reason),
            network::Failure::Fatal(reason) => Failure::Fatal(reason),
        }
    }

    /// S2's segment configuration, set explicitly at every start and
    /// restart because stock IDAReInit retains it: the Newton coefficient
    /// and the linear-setup cj bound (claude/ld01-wiki c968921: 0.33 and
    /// 0.1), G13's first step (1e-4 s), the exact consistent start's bound
    /// and passes, the passes of a start after an owner transaction (lead
    /// decision S2-D21: 12), and the largest roundoff violation of a
    /// nonnegative stock a restart places on its bound, in solver scaling
    /// (claude/ld01-wiki 014676f: 1e-12).
    #[derive(Clone, Copy, Debug)]
    pub struct Restart {
        pub newton_coefficient: f64,
        pub delta_cj_lsetup: f64,
        pub first_step_s: f64,
        pub start_bound: f64,
        pub start_passes: usize,
        /// The start's passes after an owner transaction changed a
        /// differential coordinate of its owner (S2-D21, P_tx).
        pub transaction_passes: usize,
        pub bound_placement: f64,
    }

    /// What one discrete restart did.
    #[derive(Debug)]
    pub struct Restarted {
        pub transactions: Vec<Transaction>,
        /// Nonnegative stocks placed on their bound, each reported.
        pub placements: Vec<network::Placement>,
        /// The owners whose transactions changed one of their differential
        /// coordinates (S2-D21); their algebraic coordinates were exempt
        /// from the start's WRMS guard ([`Report::exempt`]).
        pub transacted: Vec<&'static str>,
        /// The start's pass bound: `transaction_passes` after an owner
        /// transaction, `start_passes` otherwise.
        pub passes_allowed: usize,
        /// The declared vapor presence's key changed, so the restart
        /// switched the block structure (S3-D-P3; never without
        /// [`Integrated::following_presence`]).
        pub presence_changed: bool,
        /// The phase-mode owner's mode table changed (a birth or an
        /// exhaustion): the identity, the nonnegative stocks and the
        /// tolerances were set again.
        pub modes_changed: bool,
        /// S3-D3's derived class of every equilibrium cell at this start
        /// (empty with every cell liquid).
        pub equilibrium_classes: Vec<serde_json::Value>,
        pub yp: Vec<f64>,
        pub report: Report,
    }
    impl Restart {
        /// Configure a segment start (after construction or a restart).
        pub fn configure<S: System>(&self, ida: &mut Ida<S>) -> Result<(), String> {
            ida.set_nonlinear_convergence_coefficient(self.newton_coefficient)?;
            ida.set_delta_cj_lsetup(self.delta_cj_lsetup)?;
            ida.set_init_step(self.first_step_s)
        }
    }

    /// What stopped a segment at `t`.
    #[derive(Clone, Copy, Debug)]
    pub enum Discrete<'a> {
        /// Located roots, `directions` per root as IDAGetRootInfo.
        Roots(&'a [i32]),
        /// A stop at the owners' [`Joined::next_time_event`].
        TimeEvent,
        /// A declared command at `t`.
        Command(Command),
    }

    /// One discrete event and its restart at `t`, in order:
    /// 1. the owners' transactions write their changed coordinates into `y`
    ///    (roots: `transact`; a command: `command`), then every time event
    ///    due at `t` is transacted, so a root that is exactly zero at the
    ///    restart is never missed and root and time event never both fire;
    /// 2. a nonnegative network stock below zero by less than the declared
    ///    roundoff is placed on its bound and reported; a larger violation
    ///    refuses;
    ///    the vapor presence the stocks then declare is followed: a changed
    ///    key switches the block structure (S3-D-P3, presence-following
    ///    systems only);
    /// 3. the differential identity is recomputed from the owners' modes; an
    ///    owner whose transaction changed one of its differential
    ///    coordinates (a rod or relief seat) is transacted (S2-D21);
    /// 4. the exact consistent start at the transacted `y` (the projection
    ///    may change algebraic coordinates only), on the system's own
    ///    assembly: on blocks with the system's cached symbolic analyses,
    ///    on colored (the reference) afresh;
    ///    After an owner transaction the start takes up to the declared
    ///    `transaction_passes`, and its WRMS guard leaves out the transacted
    ///    owners' algebraic coordinates, whose correction it reports; the
    ///    constraint and rate bounds are unchanged (S2-D21);
    /// 5. IDAReInit with the consistent rates and the segment configuration.
    #[allow(clippy::too_many_arguments)] // One restart: event, state, identity and tolerances.
    pub fn discrete_restart<S: JoinedSystem>(
        ida: &mut Ida<S>,
        t: f64,
        discrete: Discrete<'_>,
        y: &mut [f64],
        network_ids: &[f64],
        absolute: &[f64],
        relative: f64,
        restart: &Restart,
    ) -> Result<Restarted, String> {
        let integrated = ida.system_mut().integrated_mut();
        if absolute.len() != y.len() {
            return Err("restart tolerances layout".into());
        }
        let message = |f: network::Failure| match f {
            network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
        };
        let joined = &mut integrated.joined;
        let before = y.to_vec();
        let identity_before = joined.differential(network_ids);
        let modes_before = joined.network.cell_modes().to_vec();
        let mut done = match discrete {
            Discrete::Roots(directions) => joined.transact(t, directions, y).map_err(message)?,
            Discrete::TimeEvent => Vec::new(),
            Discrete::Command(c) => joined.command(t, y, c).map_err(message)?,
        };
        done.extend(joined.time_events(t, y).map_err(message)?);
        // The vapor presence declared after the transactions (the stocks'
        // for liquid cells, both phases for an equilibrium cell): a changed
        // presence key switches the block structure (S3-D-P3).
        let declared = VaporPresence::of(&joined.network, &joined.network.declared_presence(y));
        let presence_changed = integrated.follow_presence(t, y, &declared)?;
        let Integrated {
            joined,
            assembly,
            analyses,
            ..
        } = integrated;
        let nonnegative = joined.network.nonnegative_stocks();
        let placements = network::place_on_bounds(t, y, &nonnegative, restart.bound_placement)
            .map_err(message)?;
        let ids = joined.differential(network_ids);
        // S3-D3 (the S2-D24 pattern, default on every path): an equilibrium
        // cell's algebraic vapor slots take their class from the pressure
        // class through their flash sensitivity at this segment's start
        // state; every other coordinate keeps the caller's class. With
        // every cell liquid this is the caller's vector unchanged.
        let modes_changed = joined.network.cell_modes() != modes_before.as_slice();
        let mut effective = absolute.to_vec();
        let equilibrium_classes = if joined.network.has_equilibrium_cells() {
            let n = joined.offsets().nuclear;
            joined
                .network
                .equilibrium_tolerances(&y[..n], relative, &mut effective[..n])
                .map_err(message)?
        } else {
            Vec::new()
        };
        let retune = modes_changed || !equilibrium_classes.is_empty();
        let weights: Vec<f64> = y
            .iter()
            .zip(&effective)
            .map(|(v, a)| 1. / (relative * v.abs() + a))
            .collect();
        let o = joined.offsets();
        let owners = [("secondary", o.secondary..o.rods), ("rods", o.rods..o.end)];
        let transacted = transacted_owners(&owners, &before, y, &identity_before);
        let exempt: Vec<bool> = if transacted.is_empty() {
            Vec::new()
        } else {
            (0..y.len())
                .map(|i| {
                    ids[i] == 0.
                        && owners
                            .iter()
                            .any(|(name, range)| transacted.contains(name) && range.contains(&i))
                })
                .collect()
        };
        let passes_allowed = if transacted.is_empty() {
            restart.start_passes
        } else {
            restart.transaction_passes
        };
        let matrices = match assembly {
            Assembly::Blocks(structure) => Matrices::Blocks {
                structure,
                analyses,
            },
            Assembly::Colored => Matrices::Colored,
        };
        let (yp, report) = super::consistent_start_exempting(
            joined,
            matrices,
            t,
            y,
            &ids,
            &weights,
            &exempt,
            restart.start_bound,
            passes_allowed,
        )
        .map_err(message)?;
        ida.reinitialize(t, y, &yp)?;
        ida.set_differential(&ids)?;
        restart.configure(ida)?;
        root_directions(ida)?;
        if retune {
            // A phase-mode change or an equilibrium cell: the segment's
            // derived tolerances and its nonnegative stocks (an equilibrium
            // cell's vapor mass is algebraic, its sign the exhaustion
            // root's).
            ida.set_tolerances(relative, &effective)?;
            ida.constrain_nonnegative(&nonnegative)?;
        }
        Ok(Restarted {
            transactions: done,
            placements,
            transacted,
            passes_allowed,
            presence_changed,
            modes_changed,
            equilibrium_classes,
            yp,
            report,
        })
    }

    /// Stock IDASetRootDirection from the owners' current state
    /// ([`Joined::root_directions`]): each armed relief threshold reports
    /// only the crossing its memory acts on, so a threshold just crossed is
    /// not crossed again by the restart's own consistent start. Roots a
    /// wrapper declares after the operator's (an observation root) report
    /// both directions. [`discrete_restart`] applies it at every restart; a
    /// segment start after construction may apply it too.
    pub fn root_directions<S: JoinedSystem>(ida: &mut Ida<S>) -> Result<(), String> {
        let mut directions =
            ida.system()
                .integrated()
                .joined
                .root_directions()
                .map_err(|f| match f {
                    network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
                })?;
        let declared = ida.system().root_count();
        if declared < directions.len() {
            return Err("the system declares fewer roots than its operator".into());
        }
        if declared == 0 {
            return Ok(());
        }
        directions.resize(declared, 0);
        ida.set_root_directions(&directions)
    }

    /// A stock-IDA system whose residual is one [`Integrated`] joined
    /// operator, possibly wrapped (the IDAS ledger, an observation root):
    /// [`discrete_restart`] reaches the operator, its assembly and its cached
    /// analyses through it.
    pub trait JoinedSystem: System {
        type Properties: Properties + WaterProperties;
        fn integrated(&self) -> &Integrated<Self::Properties>;
        fn integrated_mut(&mut self) -> &mut Integrated<Self::Properties>;
    }
    impl<P: Properties + WaterProperties> JoinedSystem for Integrated<P> {
        type Properties = P;
        fn integrated(&self) -> &Integrated<P> {
            self
        }
        fn integrated_mut(&mut self) -> &mut Integrated<P> {
            self
        }
    }

    /// How the stage Jacobian is assembled.
    pub enum Assembly {
        /// One exact seeded joined evaluation per color of the operator's
        /// structural pattern: the reference.
        Colored,
        /// JAC's block assembly on its element-exact pattern, checked
        /// against the colored matrix entry by entry.
        Blocks(Box<JoinedJacobian>),
    }

    /// The joined operator as one stock-IDA system, with its sparse
    /// Jacobian and the symbolic analyses its block restarts reuse. A
    /// partial composition (a prepared port) is refused.
    pub struct Integrated<P: Properties> {
        pub joined: Joined<P>,
        rows: Vec<i64>,
        pointers: Vec<i64>,
        assembly: Assembly,
        analyses: Analyses,
        /// The presence-keyed structures when the system follows a
        /// declared vapor presence (S3-D-P3), else `None` (S1, S2).
        presence: Option<Following>,
    }

    /// A presence-following block assembly (lead decision S3-D-P3): one
    /// structure and its symbolic analyses per presence key, the key in
    /// force, and the stock-IDA matrix capacity every key fits.
    struct Following {
        cache: PatternCache<(JoinedJacobian, Analyses)>,
        key: PresenceKey,
        capacity: usize,
    }
    impl<P: Properties + WaterProperties> Integrated<P> {
        /// On the colored assembly.
        pub fn new(joined: Joined<P>) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            let (pattern, _) = joined
                .structure()
                .ok_or("the joined operator has no structure")?;
            let (pointers, rows) = pattern.to_i64()?;
            Ok(Self {
                joined,
                rows,
                pointers,
                assembly: Assembly::Colored,
                analyses: Analyses::default(),
                presence: None,
            })
        }
        /// On the block assembly, compiled at the value state `(t, y, 0)`;
        /// its pattern holds for every state and mode.
        pub fn with_blocks(mut joined: Joined<P>, t: f64, y: &[f64]) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            let structure = JoinedJacobian::compile(&mut joined, t, y).map_err(|f| match f {
                network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
            })?;
            Self::from_blocks(joined, structure, Analyses::default())
        }
        /// On a block structure already compiled for this operator, with the
        /// symbolic analyses its consistent start made (a cache made on
        /// another pattern refuses at the first restart).
        pub fn from_blocks(
            joined: Joined<P>,
            structure: JoinedJacobian,
            analyses: Analyses,
        ) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            if structure.pattern.rows() != joined.dimension() {
                return Err("the block structure is not this operator's".into());
            }
            let (pointers, rows) = structure.pattern.to_i64()?;
            Ok(Self {
                joined,
                rows,
                pointers,
                assembly: Assembly::Blocks(Box::new(structure)),
                analyses,
                presence: None,
            })
        }
        /// On the block assembly that follows the vapor presence its
        /// owners declare (lead decision S3-D-P3): compiled at the value
        /// state `(t, y, 0)` for `presence`, keyed by the cells the joined
        /// pattern reads ([`pattern_cells`]), with the stock-IDA matrix
        /// sized for the key in which every read cell holds vapor (compiled
        /// once and kept), so a restart can switch keys on the same handle
        /// ([`Self::follow_presence`]). S1 and S2 compose with
        /// [`Self::with_blocks`] or [`Self::from_blocks`] (exact size).
        pub fn following_presence(
            mut joined: Joined<P>,
            t: f64,
            y: &[f64],
            presence: &VaporPresence,
        ) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            let message = |f: network::Failure| match f {
                network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
            };
            let cells = pattern_cells(&joined);
            let mut cache = PatternCache::new(cells.clone());
            let all = VaporPresence {
                cells: (0..joined.network.pzr.cell)
                    .map(|c| cells.contains(&c))
                    .collect(),
            };
            let widest = cache.key(&all);
            let (structure, analyses) = cache
                .check_out(&widest, || {
                    JoinedJacobian::compile_for(&mut joined, t, y, Some(&all))
                        .map(|s| (s, Analyses::default()))
                })
                .map_err(message)?;
            let capacity = structure.pattern.nonzeros();
            cache
                .check_in(&widest, (structure, analyses))
                .map_err(message)?;
            let key = cache.key(presence);
            let (structure, analyses) = cache
                .check_out(&key, || {
                    JoinedJacobian::compile_for(&mut joined, t, y, Some(presence))
                        .map(|s| (s, Analyses::default()))
                })
                .map_err(message)?;
            let (pointers, rows) = structure.pattern.to_i64()?;
            Ok(Self {
                joined,
                rows,
                pointers,
                assembly: Assembly::Blocks(Box::new(structure)),
                analyses,
                presence: Some(Following {
                    cache,
                    key,
                    capacity,
                }),
            })
        }
        /// Follow a declared vapor presence at a restart, before its
        /// consistent start: a changed key checks the structure in force and
        /// its symbolic analyses back in and takes the new key's (compiled
        /// at `(t, y, 0)` by `compile_for` on a miss), refusing a pattern
        /// above the handle's capacity. Stock IDAReInit makes KLU analyse
        /// the new pattern at its next setup. Returns whether the key
        /// changed; a system that does not follow presence returns false.
        pub fn follow_presence(
            &mut self,
            t: f64,
            y: &[f64],
            presence: &VaporPresence,
        ) -> Result<bool, String> {
            let Self {
                joined,
                rows,
                pointers,
                assembly,
                analyses,
                presence: following,
            } = self;
            let Some(f) = following else {
                return Ok(false);
            };
            let key = f.cache.key(presence);
            if key == f.key {
                return Ok(false);
            }
            let message = |e: network::Failure| match e {
                network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
            };
            let Assembly::Blocks(current) = std::mem::replace(assembly, Assembly::Colored) else {
                return Err("a presence-following system assembles by blocks".into());
            };
            f.cache
                .check_in(&f.key, (*current, std::mem::take(analyses)))
                .map_err(message)?;
            let (structure, cached) = f
                .cache
                .check_out(&key, || {
                    JoinedJacobian::compile_for(joined, t, y, Some(presence))
                        .map(|s| (s, Analyses::default()))
                })
                .map_err(message)?;
            if structure.pattern.nonzeros() > f.capacity {
                return Err(format!(
                    "presence key {key:?}: {} entries above the handle's capacity {}",
                    structure.pattern.nonzeros(),
                    f.capacity
                ));
            }
            let (p, r) = structure.pattern.to_i64()?;
            *pointers = p;
            *rows = r;
            *assembly = Assembly::Blocks(Box::new(structure));
            *analyses = cached;
            f.key = key;
            Ok(true)
        }
        /// The presence key in force and the cache's statistics, when the
        /// system follows presence.
        pub fn presence_key(&self) -> Option<(&PresenceKey, usize)> {
            self.presence.as_ref().map(|f| (&f.key, f.cache.keys()))
        }
        pub fn assembly(&self) -> &Assembly {
            &self.assembly
        }
        /// The symbolic analyses the restarts' block starts reuse.
        pub fn analyses(&self) -> &Analyses {
            &self.analyses
        }
    }
    impl<P: Properties + WaterProperties> System for Integrated<P> {
        fn dimension(&self) -> usize {
            self.joined.dimension()
        }
        /// AMD, approved for every joined solve (decision 0013). On the
        /// joined block pattern, stock KLU refactors in about half COLAMD's
        /// time, with fewer factor entries (JAC's Z5 cost receipt).
        fn klu_ordering(&self) -> KluOrdering {
            KluOrdering::Amd
        }
        /// The pattern's entries, or for a presence-following system the
        /// capacity every presence key fits.
        fn nonzeros(&self) -> usize {
            self.presence
                .as_ref()
                .map_or(self.rows.len(), |f| f.capacity)
        }
        /// The owners' root functions, read once at construction.
        fn root_count(&self) -> usize {
            self.joined.root_count()
        }
        fn roots(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.joined.roots(time, y, yp, out).map_err(failure)
        }
        fn residual(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.joined
                .evaluate(time, y, yp, None, 0., None)
                .map_err(failure)?;
            for (r, v) in out.iter_mut().zip(self.joined.rows()) {
                *r = v.value;
            }
            Ok(())
        }
        fn jacobian(
            &mut self,
            time: f64,
            cj: f64,
            y: &[f64],
            yp: &[f64],
            data: &mut [f64],
            rows: &mut [i64],
            pointers: &mut [i64],
        ) -> Result<(), Failure> {
            // The structure in force fills the first entries; a
            // presence-following handle's capacity may hold more, which the
            // column pointers leave unread.
            let n = self.rows.len();
            rows[..n].copy_from_slice(&self.rows);
            pointers.copy_from_slice(&self.pointers);
            let data = &mut data[..n];
            match &self.assembly {
                Assembly::Colored => self.joined.jacobian(time, cj, y, yp, data),
                Assembly::Blocks(structure) => {
                    // The operator counts its colored assemblies itself.
                    let started = std::time::Instant::now();
                    let result = jacobian_blocks(
                        &mut self.joined,
                        structure,
                        time,
                        cj,
                        y,
                        yp,
                        data,
                        Classes::ALL,
                    );
                    self.joined.counters.jacobians += 1;
                    self.joined.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
                    result
                }
            }
            .map_err(failure)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{correction_wrms, transacted_owners};

    #[test]
    fn the_guard_leaves_out_only_the_exempt_coordinates_and_reports_them() {
        let start = [1., 2., 3., 4.];
        let y = [1., 2.5, 3., 4. - 2e-3];
        let weights = [1., 2., 1., 1e3];
        // Weighted changes: 0, 1, 0, -2.
        let (all, none) = correction_wrms(&y, &start, &weights, &[]);
        assert!((all - (5f64 / 4.).sqrt()).abs() < 1e-12);
        assert_eq!(none, None);
        let (guard, exempt) = correction_wrms(&y, &start, &weights, &[false, false, false, true]);
        assert!((guard - (1f64 / 3.).sqrt()).abs() < 1e-12);
        let exempt = exempt.unwrap();
        assert_eq!(exempt.coordinates, 1);
        assert!((exempt.wrms - 2.).abs() < 1e-12);
        assert_eq!(exempt.max.row, 3);
        assert!((exempt.max.value - 2.).abs() < 1e-12);
        // An all-false mask is the unexempted guard, bit for bit.
        let (same, nothing) = correction_wrms(&y, &start, &weights, &[false; 4]);
        assert_eq!(same.to_bits(), all.to_bits());
        assert_eq!(nothing, None);
    }

    #[test]
    fn an_owner_is_transacted_only_by_a_changed_differential_coordinate() {
        let owners = [("secondary", 0..2), ("rods", 2..5)];
        let before = [1., 2., 3., 4., 5.];
        let identity = [1., 0., 1., 1., 0.];
        // Nothing changed: no owner.
        assert!(transacted_owners(&owners, &before, &before, &identity).is_empty());
        // An algebraic coordinate alone (rods' 5th) does not transact.
        let after = [1., 2., 3., 4., 6.];
        assert!(transacted_owners(&owners, &before, &after, &identity).is_empty());
        // A seat: travel and speed set to zero.
        let after = [1., 2., 0., 0., 5.];
        assert_eq!(
            transacted_owners(&owners, &before, &after, &identity),
            vec!["rods"]
        );
        // A relief disc seated (lift to zero) and a rod seat together.
        let after = [0., 2., 0., 4., 5.];
        assert_eq!(
            transacted_owners(&owners, &before, &after, &identity),
            vec!["secondary", "rods"]
        );
    }
}

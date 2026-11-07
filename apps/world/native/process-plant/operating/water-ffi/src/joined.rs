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
        blocks::{Classes, JoinedJacobian, jacobian_blocks, jacobian_blocks_start},
        operator::Joined,
    },
    network::{CreditedOutput, Failure, Properties},
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

/// The declared factor on the unit roundoff of the per-row bound
/// (lead, 17 October 2026, with DR13-ROD-A): a row is held to
/// `max(bound, ROUNDOFF_FACTOR * eps * sum |terms|)`, where `sum |terms|` is
/// the magnitude of the terms the row subtracts at the state, from the
/// row's own linearization: `sum_j |dF_r/dy_j y_j| + |dF_r/dy'_j y'_j|` for
/// a residual, `sum_j |dg_r/dy_j y'_j|` for a constraint rate. One rule for
/// every row; where the terms are small the declared bound holds unchanged.
pub const ROUNDOFF_FACTOR: f64 = 8.;
fn row_bound(bound: f64, magnitude: f64) -> f64 {
    bound.max(ROUNDOFF_FACTOR * f64::EPSILON * magnitude)
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
    /// Rows accepted above `bound` under their own roundoff bound
    /// ([`ROUNDOFF_FACTOR`]): the projection's constraints, the residual and
    /// the constraint rates, each the largest such row over its bound.
    pub roundoff_rows: [Largest; 3],
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
    /// R4-CLIMB: the matrices this start leaves for the climb after it.
    pub climb: Option<ClimbMatrices>,
}

/// R4-CLIMB: a start's `dF/dy` and `dF/dy'`, kept for the climb after a restart
/// while a regular cell is in equilibrium mode. No case without vapor outside
/// the PZR reads them.
#[derive(Clone, Debug)]
pub struct ClimbMatrices {
    a: Vec<f64>,
    b: Vec<f64>,
    last_cj: f64,
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
/// stored order of the matrices' pattern. R4-START-ASSEMBLY (lane RESTART):
/// `base_stands` says the start's own evaluation of this very `(t, y, 0)` is
/// the operator's last, so a block assembly with the relief shut stands on it
/// (R4-JAC-BASE's rule); `columns`, a projection's algebraic columns, limits a
/// block assembly to the columns its reader takes. Neither changes an entry
/// read.
#[allow(clippy::too_many_arguments)] // The stage, the report and the assembly's two limits.
fn assemble<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    matrices: &Matrices<'_>,
    t: f64,
    cj: f64,
    y: &[f64],
    values: &mut [f64],
    report: &mut Report,
    base_stands: bool,
    columns: Option<&[bool]>,
) -> Result<(), Failure> {
    let _cost = leitbild_operating_plant::cost::scope("start-jacobian");
    let zero = vec![0.; y.len()];
    let started = Instant::now();
    match matrices {
        // Without a standing base the block assembly makes its own unseeded
        // evaluation at (t, y, 0) before the operator's local coupler reads it.
        Matrices::Blocks { structure, .. } => {
            let shut = joined
                .network
                .pzr_boundary()
                .is_none_or(|(b, _)| b.relief.as_ref().is_none_or(|r| r.lift.value == 0.));
            let reuse = (base_stands && shut).then(|| joined.network.reuse());
            // R4-ENDPOINT-ASSEMBLY's hold, as in the integrator's assemblies.
            leitbild_operating_plant::network::heaters::hold_endpoints(true);
            let result =
                jacobian_blocks_start(joined, structure, t, cj, y, &zero, values, reuse, columns);
            leitbild_operating_plant::network::heaters::hold_endpoints(false);
            result?
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
        let _cost = leitbild_operating_plant::cost::scope("start-residual");
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
        assemble(
            joined,
            &matrices,
            t,
            0.,
            y,
            &mut values,
            &mut report,
            true,
            Some(&algebraic),
        )?;
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
    if report.constraint_after.value.is_nan() {
        return Err(fatal(format!(
            "constraints miss their bound after projection: {:?}",
            report.constraint_after
        )));
    }
    (report.correction_wrms, report.exempt) = correction_wrms(y, &start, weights, exempt);
    if report.correction_wrms.is_nan() || report.correction_wrms > 1. {
        return Err(fatal(format!(
            "the projection exceeds the solver's error scale: WRMS {} (largest scaled correction {:?})",
            report.correction_wrms, report.correction
        )));
    }
    // 2. The consistent rates: differential rows dF/dy', algebraic rows dg/dy.
    let mut a = vec![0.; nnz];
    assemble(joined, &matrices, t, 0., y, &mut a, &mut report, true, None)?;
    let mut ab = vec![0.; nnz];
    assemble(
        joined,
        &matrices,
        t,
        1.,
        y,
        &mut ab,
        &mut report,
        false,
        None,
    )?;
    let equilibrium = joined
        .network
        .cell_modes()
        .contains(&leitbild_operating_plant::network::CellMode::Equilibrium);
    if equilibrium && matches!(matrices, Matrices::Blocks { .. }) {
        report.climb = Some(ClimbMatrices {
            a: a.clone(),
            b: ab.iter().zip(&a).map(|(x, y)| x - y).collect(),
            last_cj: f64::INFINITY,
        });
    }
    // Each row's magnitude of terms from its linearization at the state:
    // `sum_j |dF/dy_ij y_j|`, and with rates `sum_j |dF/dy'_ij y'_j|`.
    let magnitude = |matrix: &dyn Fn(usize) -> f64, v: &[f64]| {
        let mut m = vec![0.; n];
        for j in 0..n {
            for position in pointers[j]..pointers[j + 1] {
                m[indices[position]] += (matrix(position) * v[j]).abs();
            }
        }
        m
    };
    let of_y = magnitude(&|p| a[p], y);
    // The projection's constraints, each under its own roundoff bound.
    let over = |values: &[f64], magnitudes: &[f64], only_algebraic: bool| {
        largest(
            values
                .iter()
                .enumerate()
                .filter(|(i, _)| !only_algebraic || algebraic[*i])
                .filter(|(i, v)| v.abs() > bound && v.abs() > row_bound(bound, magnitudes[*i]))
                .map(|(i, v)| (i, *v)),
        )
    };
    let accepted_above = |values: &[f64], only_algebraic: bool| {
        largest(
            values
                .iter()
                .enumerate()
                .filter(|(i, _)| !only_algebraic || algebraic[*i])
                .filter(|(_, v)| v.abs() > bound)
                .map(|(i, v)| (i, *v)),
        )
    };
    let missed = over(&rows, &of_y, true);
    if missed.value.is_nan() || missed.value > 0. {
        return Err(fatal(format!(
            "constraints miss their bound after projection: {:?} (row bound {})",
            report.constraint_after,
            row_bound(bound, of_y[missed.row])
        )));
    }
    report.roundoff_rows[0] = accepted_above(&rows, true);
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
    // The rows are linear in y' but for R4-VAPOR-IMPULSE's min(I', 0) Q, which
    // these matrices at y' = 0 do not hold. No row reads an impulse's rate, so
    // the first pass gives every rate I' reads and the second takes the term
    // into the impulse rows; further passes, at most `passes`, only remove
    // round-off.
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
    // Each row under its own roundoff bound: the residual's terms at
    // (y, y'), the constraint rate's at y'.
    let of_rates = magnitude(&|p| ab[p] - a[p], &yp);
    let of_residual: Vec<f64> = of_y.iter().zip(&of_rates).map(|(a, b)| a + b).collect();
    let of_constraint_rate = magnitude(&|p| a[p], &yp);
    let rate = constraint_rate(&yp);
    let (missed_residual, missed_rate) = (
        over(&residual, &of_residual, false),
        over(&rate, &of_constraint_rate, true),
    );
    if report.residual.value.is_nan()
        || report.constraint_rate.value.is_nan()
        || missed_residual.value > 0.
        || missed_rate.value > 0.
    {
        return Err(fatal(format!(
            "the consistent-rate solve missed its bound: residual {:?}, constraint rate {:?} (row bounds {} and {})",
            report.residual,
            report.constraint_rate,
            row_bound(bound, of_residual[missed_residual.row]),
            row_bound(bound, of_constraint_rate[missed_rate.row])
        )));
    }
    report.roundoff_rows[1] = accepted_above(&residual, false);
    report.roundoff_rows[2] = accepted_above(&rate, true);
    Ok((yp, report))
}

/// Each transacting owner's own coordinate range: the SG secondary, the rods,
/// the PZR block (G6), which follows the rods and is empty while its owner is
/// not composed, and the CVCS (plan r4 X4.2), empty unless composed.
fn owner_ranges(
    o: leitbild_operating_plant::joined::operator::Offsets,
) -> [(&'static str, std::ops::Range<usize>); 4] {
    [
        ("secondary", o.secondary..o.rods),
        ("rods", o.rods..o.pzr),
        ("pzr", o.pzr..o.cvcs),
        ("cvcs", o.cvcs..o.end),
    ]
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

/// R4-RESTART-EQUATION-CHANGE (lead 1 Nov 2026, on S3-D41's principle):
/// the owners whose reported row-equation mode changed between `before`
/// and `after` ([`leitbild_operating_plant::joined::operator::Joined::equation_modes`]).
/// The reporting owners are the composition's, so both lists name the same
/// owners in the same order; anything else refuses.
fn equation_changes(
    before: &[(&'static str, serde_json::Value)],
    after: &[(&'static str, serde_json::Value)],
) -> Result<Vec<&'static str>, String> {
    if before.len() != after.len() || before.iter().zip(after).any(|(b, a)| b.0 != a.0) {
        return Err(format!(
            "the equation-mode owners changed within a restart: {:?} against {:?}",
            before.iter().map(|b| b.0).collect::<Vec<_>>(),
            after.iter().map(|a| a.0).collect::<Vec<_>>()
        ));
    }
    Ok(before
        .iter()
        .zip(after)
        .filter(|(b, a)| b.1 != a.1)
        .map(|(b, _)| b.0)
        .collect())
}

/// The derived absolute-tolerance classes on the composition's own rows
/// (lead decisions S2-D24r and S3-D16, the default in every S3 run path,
/// never an opt-in), as `owner/Class` of the joined layouts: an algebraic
/// current set by pressure differences takes the tightest credited budget
/// among the credited outputs it determines through its own sensitivity.
/// The equilibrium cells' vapor class (S3-D16 on S3-D3) is derived at
/// every restart ([`discrete_restart`]); ELEC's stator class joins this
/// list when its owner is composed.
pub const DERIVED_CLASSES: &[&str] = &["rods/GuideCurrent"];

/// One credited output a derived coordinate determines.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Determined {
    pub output: String,
    /// The output's budget in its own unit (Pa for a pressure output).
    pub budget: f64,
    /// `|∂x/∂p_j|` in SI, the largest over the output's coordinates the row
    /// reads (for a difference output, `|∂x/∂Δp|`).
    pub sensitivity: f64,
    pub column: String,
    /// `budget × sensitivity`, SI.
    pub tolerance: f64,
}

/// One coordinate's derived absolute tolerance.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DerivedRow {
    pub coordinate: usize,
    pub label: String,
    pub class: String,
    /// The class tolerance it replaces, and the applied one, solver scaling.
    pub replaced_scaled: f64,
    pub applied_scaled: f64,
    /// The applied tolerance in SI: the tightest determined output's.
    pub applied: f64,
    /// Every credited output it determines, tightest first.
    pub determines: Vec<Determined>,
}

/// What [`derived_tolerances`] applied: the evidence an S3 run path carries
/// (the frame driver's setup requires it).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DerivedTolerances {
    pub rule: &'static str,
    pub classes: Vec<String>,
    pub credited: Vec<CreditedOutput>,
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
        }
        out
    }
}

/// S2-D24r / S3-D16 on `atol` (solver scaling) for every coordinate of
/// [`DERIVED_CLASSES`], from the block Jacobian `∂F/∂y` at `(t, y, y')`: a
/// derived row `r`'s sensitivity to a pressure column `j` is
/// `|∂x/∂p_j| = |J[r,j] / J[r,r]|`; the credited outputs it determines are
/// those whose coordinates its row reads, each giving `budget × |∂x/∂p_j|`
/// over its own coordinates; the tightest is applied, so every determined
/// output's budget holds (rods/GuideCurrent: core DP's 50 Pa × `|∂m/∂Δp|`).
/// The rule HARNESS-B's S2 gate harness applies (r7.1). `credited` comes
/// from the strict blocks and is also declared on the operator for the
/// restarts' classes. A covered row without a finite nonzero diagonal, or
/// that determines no credited output, refuses; so does a composition with
/// no covered coordinate.
#[allow(clippy::too_many_arguments)] // The operator, its structure, the state, the outputs, rtol and atol.
pub fn derived_tolerances<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    structure: &JoinedJacobian,
    t: f64,
    y: &[f64],
    yp: &[f64],
    relative: f64,
    credited: &[CreditedOutput],
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
    if credited.is_empty() {
        return Err("derived tolerances: no credited output declared".into());
    }
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
                } else if values[position] != 0. {
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
        let mut determines: Vec<Determined> = credited
            .iter()
            .filter_map(|o| {
                entries[k]
                    .iter()
                    .filter(|(j, _)| o.columns.contains(j))
                    .map(|(j, v)| ((v / d).abs() * scales[*r] / scales[*j], *j))
                    .max_by(|a, b| a.0.total_cmp(&b.0))
                    .map(|(sensitivity, j)| Determined {
                        output: o.name.clone(),
                        budget: o.budget,
                        sensitivity,
                        column: labels[j].clone(),
                        tolerance: o.budget * sensitivity,
                    })
            })
            .collect();
        determines.sort_by(|a, b| a.tolerance.total_cmp(&b.tolerance));
        let applied = determines.first().map(|o| o.tolerance).ok_or_else(|| {
            format!(
                "derived tolerances: {} determines no credited output",
                labels[*r]
            )
        })?;
        rows.push(DerivedRow {
            coordinate: *r,
            label: labels[*r].clone(),
            class: class_of[*r].clone(),
            replaced_scaled: atol[*r],
            applied_scaled: applied / scales[*r],
            applied,
            determines,
        });
        atol[*r] = applied / scales[*r];
    }
    Ok(DerivedTolerances {
        rule: "S2-D24r/S3-D16: the tightest credited budget among the credited outputs the coordinate determines x |dx/dp| = |J[r,j]/J[r,r]| from the block Jacobian dF/dy",
        classes: DERIVED_CLASSES.iter().map(|c| c.to_string()).collect(),
        credited: credited.to_vec(),
        t_s: t,
        relative,
        rows,
    })
}

/// N1 (lead, 17 Oct): the most coordinates in a weight group that holds a
/// credited row. Under group-normalised weights stock's WRMS^2 is
/// `sum_g RMS_g^2`, so WRMS <= 1 holds every row of a group of `n_g`
/// coordinates within `sqrt(n_g)` of its declared tolerance: 3 units here.
pub const CREDITED_GROUP_MAX: usize = 9;

/// N1: weight-group keys from census keys (one per coordinate, census
/// order). Every key that a `credited` coordinate carries is split, in
/// census order, into consecutive groups of at most `max` coordinates,
/// keyed `key#k`; every other key stays one group. No hand list: the
/// split follows from the census and the credited coordinates.
pub fn split_credited_groups(keys: &[String], credited: &[bool], max: usize) -> Vec<String> {
    let split: std::collections::HashSet<&str> = keys
        .iter()
        .zip(credited)
        .filter(|(_, c)| **c)
        .map(|(k, _)| k.as_str())
        .collect();
    let mut seen = std::collections::HashMap::<&str, usize>::new();
    keys.iter()
        .map(|k| {
            if split.contains(k.as_str()) {
                let n = seen.entry(k.as_str()).or_default();
                let key = format!("{k}#{}", *n / max.max(1));
                *n += 1;
                key
            } else {
                k.clone()
            }
        })
        .collect()
}

pub use integrated::{
    Assembly, Discrete, FirstStep, Integrated, JoinedSystem, Restart, Restarted, census_groups,
    credited_coordinates, discrete_restart, discrete_restart_unless_noop, root_directions,
    stock_initial_conditions,
};

mod integrated {
    use super::{Analyses, Matrices, Report, equation_changes, transacted_owners};
    use crate::ida::{Failure, Ida, KluOrdering, System, WeightGroups};
    use leitbild_operating_plant::{
        joined::{
            block::{Command, Transaction},
            blocks::{
                Classes, JoinedJacobian, Profile, jacobian_blocks, jacobian_blocks_on_base,
                jacobian_blocks_profiled, jacobian_blocks_start,
            },
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
        /// transaction, a birth (DR-C3-BIRTH05) or a reported row-equation
        /// change (R4-RESTART-EQUATION-CHANGE), `start_passes` otherwise.
        pub passes_allowed: usize,
        /// R4-RESTART-EQUATION-CHANGE: the owners whose reported
        /// row-equation mode changed at this restart (empty when none).
        pub equation_changes: Vec<&'static str>,
        /// The declared vapor presence's key changed, so the restart
        /// switched the block structure (S3-D-P3; never without
        /// [`Integrated::following_presence`]).
        pub presence_changed: bool,
        /// The phase-mode owner's mode table changed (a birth or an
        /// exhaustion): the identity, the nonnegative stocks and the
        /// tolerances were set again.
        pub modes_changed: bool,
        /// S3-D16's derived vapor class of every equilibrium cell at this start
        /// (empty with every cell liquid).
        pub equilibrium_classes: Vec<serde_json::Value>,
        /// The appended owners' changes at this restart (ELEC hook; empty
        /// without appended coordinates).
        pub appended: Vec<String>,
        /// N3: the first step this restart set, and the last step stock
        /// accepted before the event.
        pub first_step_s: f64,
        pub last_step_s: f64,
        /// The largest algebraic row of the state handed to the restart,
        /// before any transaction, under the identity before it
        /// (DR-C3-BIRTH05).
        pub constraint_at_entry: super::Largest,
        /// Every cell born at this restart: its pressure at entry and after
        /// the consistent start, the step, and its vapor (physical units,
        /// [`network::Network::birth_flash`]), with the correction of its
        /// `p, M_g, U_g` in the integrator's tolerance units (weighted, as
        /// the WRMS guard reads them; those coordinates are exempt from it,
        /// lead decision S3-D64).
        pub births: Vec<serde_json::Value>,
        pub yp: Vec<f64>,
        pub report: Report,
        /// E-EVT (plan r4): nothing the integrator reads changed (the state,
        /// the identity, every residual row and root function bitwise), so
        /// no consistent start and no IDAReInit were made: stock's history
        /// continues. `yp` is then empty.
        pub noop: bool,
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
    ///    constraint and rate bounds are unchanged (S2-D21). A birth's
    ///    flash at the born cell's unchanged totals is finite at G1's
    ///    credited superheat, so it also takes up to `transaction_passes`
    ///    (S3-D41), and the born cells' `p, M_g, U_g`, only at their birth
    ///    instant, are exempt and reported (S3-D64, DR-C3-BIRTH05);
    /// 5. IDAReInit with the consistent rates and the segment configuration.
    #[allow(clippy::too_many_arguments)] // One restart: event, state, identity and tolerances.
    pub fn discrete_restart<S: JoinedSystem>(
        ida: &mut Ida<S>,
        t: f64,
        discrete: Discrete<'_>,
        y_all: &mut [f64],
        network_ids: &[f64],
        absolute_all: &[f64],
        relative: f64,
        restart: &Restart,
    ) -> Result<Restarted, String> {
        restart_or_continue(
            ida,
            t,
            discrete,
            y_all,
            network_ids,
            absolute_all,
            relative,
            restart,
            false,
        )
    }

    /// E-EVT (plan r4): [`discrete_restart`], or, for a command or an owner
    /// time event whose owners' changes leave everything the integrator
    /// reads bitwise as it was
    /// ([`Restarted::noop`]), no consistent start and no IDAReInit. Only a
    /// driver whose instant carries no client change of its own (such as an
    /// H1 window-end restart, which must reconfigure the segment) calls it.
    #[allow(clippy::too_many_arguments)] // As discrete_restart.
    pub fn discrete_restart_unless_noop<S: JoinedSystem>(
        ida: &mut Ida<S>,
        t: f64,
        discrete: Discrete<'_>,
        y_all: &mut [f64],
        network_ids: &[f64],
        absolute_all: &[f64],
        relative: f64,
        restart: &Restart,
    ) -> Result<Restarted, String> {
        restart_or_continue(
            ida,
            t,
            discrete,
            y_all,
            network_ids,
            absolute_all,
            relative,
            restart,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)] // One restart: event, state, identity and tolerances.
    fn restart_or_continue<S: JoinedSystem>(
        ida: &mut Ida<S>,
        t: f64,
        discrete: Discrete<'_>,
        y_all: &mut [f64],
        network_ids: &[f64],
        absolute_all: &[f64],
        relative: f64,
        restart: &Restart,
        allow_noop: bool,
    ) -> Result<Restarted, String> {
        // E-EVT (plan r4, lead): only a command or an owner time event may be
        // a no-op; a located root (a kink root among them) keeps its restart.
        let allow_noop = allow_noop && !matches!(discrete, Discrete::Roots(_));
        if absolute_all.len() != y_all.len() {
            return Err("restart tolerances layout".into());
        }
        // ELEC hook: appended coordinates (none on S1/S2 paths) take their
        // owners' changes first, then the operator restarts on its own part.
        let appended = ida.system().appended();
        let rule = ida.weight_rule();
        // N3: the last step stock accepted before this event (0 before any).
        let last_step = ida.stats()?.last_step;
        let first_step_policy = match (ida.system().integrated().first_step, discrete) {
            (FirstStep::LastStepUnlessRoots { .. }, Discrete::Roots(_)) => FirstStep::Declared,
            (FirstStep::LastStepUnlessRoots { divisor }, _) => FirstStep::LastStep { divisor },
            (policy, _) => policy,
        };
        let m = y_all
            .len()
            .checked_sub(appended)
            .ok_or("restart: appended layout")?;
        let appended_done = if appended > 0 {
            let command = match discrete {
                Discrete::Command(c) => Some(c),
                _ => None,
            };
            ida.system_mut()
                .appended_events(t, command, &mut y_all[m..])?
        } else {
            Vec::new()
        };
        // E-EVT no-op (PERF tightening): stock's own rates at `t`, the
        // last accepted step's dense derivative; a no-op also needs every
        // row unchanged there, so a change in a term linear in y' restarts.
        // Without them (no accepted step yet) the instant restarts.
        let rates_hist: Option<Vec<f64>> = if allow_noop {
            let mut r = vec![0.; y_all.len()];
            ida.dense(t, 1, &mut r).ok().map(|()| r)
        } else {
            None
        };
        let allow_noop = allow_noop && rates_hist.is_some();
        let (y, y_tail) = y_all.split_at_mut(m);
        let absolute = &absolute_all[..m];
        let integrated = ida.system_mut().integrated_mut();
        let message = |f: network::Failure| match f {
            network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
        };
        let joined = &mut integrated.joined;
        let before = y.to_vec();
        let identity_before = joined.differential(network_ids);
        let modes_before = joined.network.cell_modes().to_vec();
        let equations_before = joined.equation_modes();
        // HOOK (BIRTH05, DR-C3-BIRTH05; KERN to reconcile): the constraint
        // of the state handed to the restart, before any transaction: the
        // largest algebraic row of one value evaluation at `(t, y, 0)` under
        // the identity before it. A root-located or dense-output state off
        // the algebraic manifold shows here, separately from what the
        // transactions change.
        let zero_rates = vec![0.; y.len()];
        let mut roots_entry = vec![0.; joined.root_count()];
        let mut directions_entry = Vec::new();
        if allow_noop {
            joined
                .roots(t, y, &zero_rates, &mut roots_entry)
                .map_err(message)?;
            directions_entry = joined.root_directions().map_err(message)?;
        }
        let mut entry_rows_hist: Vec<f64> = Vec::new();
        if let Some(r) = rates_hist.as_ref() {
            joined
                .evaluate(t, y, &r[..m], None, 0., None)
                .map_err(message)?;
            entry_rows_hist = joined.rows().iter().map(|r| r.value).collect();
        }
        let entry_rows: Vec<f64>;
        let entry = {
            let zero = vec![0.; y.len()];
            joined
                .evaluate(t, y, &zero, None, 0., None)
                .map_err(message)?;
            entry_rows = joined.rows().iter().map(|r| r.value).collect();
            super::largest(
                joined
                    .rows()
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| identity_before[*i] == 0.)
                    .map(|(i, r)| (i, r.value)),
            )
        };
        let mut done = match discrete {
            // E-EVT (plan r4): one event per bank seat. The located roots
            // are widened to the roots of the same event, judged in the
            // handle's own error weights at the state handed in.
            Discrete::Roots(directions) => {
                let mut event = directions.to_vec();
                let mut w = vec![0.; y.len()];
                rule.weights(y, relative, absolute, &mut w)?;
                joined.coincident(y, &w, &mut event).map_err(message)?;
                joined.transact(t, &event, y).map_err(message)?
            }
            Discrete::TimeEvent => Vec::new(),
            Discrete::Command(c) => joined.command(t, y, c).map_err(message)?,
        };
        done.extend(joined.time_events(t, y).map_err(message)?);
        // The vapor presence declared after the transactions (the stocks'
        // for liquid cells, both phases for an equilibrium cell): a changed
        // presence key switches the block structure (S3-D-P3).
        let declared = VaporPresence::of(&joined.network, &joined.network.declared_presence(y));
        let presence_changed = integrated.follow_presence(t, y, &declared)?;
        // E-EVT (plan r4): a no-op instant. Nothing the integrator reads
        // changed: the state and identity bitwise, no presence change, no
        // appended change, every residual row at (t, y, 0) and every root
        // function and direction bitwise as at entry. Stock's history then
        // continues; there is no consistent start and no IDAReInit.
        if allow_noop
            && !presence_changed
            && appended_done.is_empty()
            && y.iter()
                .zip(&before)
                .all(|(a, b)| a.to_bits() == b.to_bits())
            && integrated.joined.differential(network_ids) == identity_before
            && integrated.joined.network.cell_modes() == modes_before.as_slice()
        {
            let joined = &mut integrated.joined;
            joined
                .evaluate(t, y, &zero_rates, None, 0., None)
                .map_err(message)?;
            let mut rows_same = joined
                .rows()
                .iter()
                .zip(&entry_rows)
                .all(|(r, e)| r.value.to_bits() == e.to_bits());
            if let Some(r) = rates_hist.as_ref() {
                joined
                    .evaluate(t, y, &r[..m], None, 0., None)
                    .map_err(message)?;
                rows_same = rows_same
                    && joined
                        .rows()
                        .iter()
                        .zip(&entry_rows_hist)
                        .all(|(r, e)| r.value.to_bits() == e.to_bits());
            }
            let mut roots_now = vec![0.; roots_entry.len()];
            joined
                .roots(t, y, &zero_rates, &mut roots_now)
                .map_err(message)?;
            let roots_same = roots_now
                .iter()
                .zip(&roots_entry)
                .all(|(a, b)| a.to_bits() == b.to_bits())
                && joined.root_directions().map_err(message)? == directions_entry;
            if rows_same && roots_same {
                return Ok(Restarted {
                    transactions: done,
                    placements: Vec::new(),
                    transacted: Vec::new(),
                    passes_allowed: 0,
                    equation_changes: Vec::new(),
                    presence_changed,
                    modes_changed: false,
                    equilibrium_classes: Vec::new(),
                    appended: appended_done,
                    constraint_at_entry: entry,
                    first_step_s: 0.,
                    last_step_s: last_step,
                    births: Vec::new(),
                    yp: Vec::new(),
                    report: Report::default(),
                    noop: true,
                });
            }
        }
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
        // S3-D16 (default on every path): an equilibrium cell's algebraic
        // vapor slots take the tightest credited budget among the declared
        // credited outputs they determine through their flash sensitivity
        // at this segment's start state, or rtol·|p| when they determine
        // none (S3-D16b; HOOK by GATE, KERN to reconcile); every other
        // coordinate keeps the caller's class. With every cell liquid this is the caller's
        // vector unchanged.
        let modes_changed = joined.network.cell_modes() != modes_before.as_slice();
        let mut effective = absolute.to_vec();
        let equilibrium_classes = if joined.network.has_equilibrium_cells() {
            let n = joined.offsets().nuclear;
            let credited = joined.credited().to_vec();
            joined
                .network
                .equilibrium_credited_tolerances(&y[..n], &credited, relative, &mut effective[..n])
                .map_err(message)?
        } else {
            Vec::new()
        };
        let retune = modes_changed || !equilibrium_classes.is_empty();
        // The handle's own weight rule (stock's, or N1's groups) on this
        // segment's tolerances, so the guard measures in stock's norm.
        let mut weights = vec![0.; y.len()];
        rule.weights(y, relative, &effective, &mut weights)?;
        let o = joined.offsets();
        let owners = super::owner_ranges(o);
        let transacted = transacted_owners(&owners, &before, y, &identity_before);
        // HOOK (BIRTH05, DR-C3-BIRTH05; KERN to reconcile): a birth at the
        // band's credited superheat (owner decision G1) keeps the cell's
        // totals, but its algebraic rows become the flash at those totals,
        // which the metastable liquid misses by a finite step (about
        // +0.1 MPa): the start takes up to `transaction_passes` (lead
        // decision S2-D21's pass bound, S3-D41), and (lead decision S3-D64,
        // BIRTH05 r3) the born cells' p, M_g, U_g, and only theirs, leave
        // its WRMS guard at this instant, reported with their correction in
        // tolerance units (`Report::exempt`, `Restarted::births`). C3's R2
        // reference (rtol x 0.01, atol x 0.1) otherwise refuses the honest
        // +104 kPa flash at +18.93 s (WRMS 13.9). The bound is unchanged.
        let born = joined.network.born_cells(&modes_before).map_err(message)?;
        let flash: Vec<usize> = born
            .iter()
            .flat_map(|c| {
                let l = joined.network.cell_layout[*c];
                [l.base, l.mass[1], l.energy[1]]
            })
            .collect();
        let exempt: Vec<bool> = if transacted.is_empty() && flash.is_empty() {
            Vec::new()
        } else {
            (0..y.len())
                .map(|i| {
                    ids[i] == 0.
                        && (flash.contains(&i)
                            || owners.iter().any(|(name, range)| {
                                transacted.contains(name) && range.contains(&i)
                            }))
                })
                .collect()
        };
        // R4-RESTART-EQUATION-CHANGE (S3-D41's principle): a restart at
        // which an owner reports that an algebraic row changes equation
        // takes the transaction class's passes, as a birth does.
        let equation_changes = equation_changes(&equations_before, &joined.equation_modes())?;
        let passes_allowed =
            if transacted.is_empty() && born.is_empty() && equation_changes.is_empty() {
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
        let (yp, mut report) = super::consistent_start_exempting(
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
        let births = born
            .iter()
            .map(|c| {
                let mut record = joined.network.birth_flash(*c, &before, y)?;
                let l = joined.network.cell_layout[*c];
                let units = |i: usize| (y[i] - before[i]) * weights[i];
                record["correction_tolerance_units"] = serde_json::json!({
                    "p": units(l.base), "vapor_mass": units(l.mass[1]),
                    "vapor_energy": units(l.energy[1])});
                Ok(record)
            })
            .collect::<Result<Vec<_>, network::Failure>>()
            .map_err(message)?;
        // R4-EXHAUST-START: an exhaustion stock IDA can no longer report,
        // its root already past zero at this consistent state, is located
        // here: the same instant restarts on it.
        if let Some(event) = joined.exhaustion_at_start(y, &yp).map_err(message)? {
            let mut after = restart_or_continue(
                ida,
                t,
                Discrete::Roots(&event),
                y_all,
                network_ids,
                absolute_all,
                relative,
                restart,
                false,
            )?;
            done.append(&mut after.transactions);
            after.transactions = done;
            let mut all_births = births;
            all_births.append(&mut after.births);
            after.births = all_births;
            let mut all_appended = appended_done;
            all_appended.append(&mut after.appended);
            after.appended = all_appended;
            after.modes_changed = true;
            after.presence_changed |= presence_changed;
            after.constraint_at_entry = entry;
            return Ok(after);
        }
        // L1 at the segment start (DR S3-REBIRTH, decision 0014): a lock
        // whose drive draws from its holding end at t0+ (at the consistent
        // state, or from an exact zero by its rate) is released now; stock
        // IDA would never report its root. No coordinate moves; the
        // released impulse's rate and the id vector change.
        let mut yp = yp;
        let ids = match joined
            .unilateral_release_at_start(t, y, &mut yp)
            .map_err(message)?
        {
            Some(release) => {
                done.push(release);
                joined.differential(network_ids)
            }
            None => ids,
        };
        let (yp, ids) = if appended > 0 {
            let mut tail = vec![0.; appended];
            ida.system_mut().appended_operator_state(y);
            let tail_ids = ida.system_mut().appended_start(t, y_tail, &mut tail)?;
            if tail_ids.len() != appended {
                return Err("restart: appended identity layout".into());
            }
            effective.extend_from_slice(&absolute_all[m..]);
            ([yp, tail].concat(), [ids, tail_ids].concat())
        } else {
            (yp, ids)
        };
        ida.reinitialize(t, y_all, &yp)?;
        ida.set_differential(&ids)?;
        restart.configure(ida)?;
        ida.system_mut().integrated_mut().climb = report.climb.take();
        let first_step_s = match first_step_policy {
            FirstStep::LastStep { divisor } if last_step > 0. => {
                let h = last_step / divisor;
                ida.set_init_step(h)?;
                h
            }
            _ => restart.first_step_s,
        };
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
            equation_changes,
            presence_changed,
            modes_changed,
            equilibrium_classes,
            appended: appended_done,
            constraint_at_entry: entry,
            first_step_s,
            last_step_s: last_step,
            births,
            yp,
            report,
            noop: false,
        })
    }

    /// N1 (Operable Unit plan, R1 S1: groups = census classes): the weight
    /// groups of a joined system, each operator coordinate in its
    /// `owner/class` group of the operator's layouts (the census of
    /// `operating-hot-spine.md`), the coordinates a wrapper appends (ELEC's
    /// slice, whose stator rows are credited) in a group of their own. Every
    /// group holding a credited row (a coordinate a declared credited output
    /// reads, a coordinate of a derived class, an appended coordinate) is
    /// split in census order into groups of at most
    /// [`super::CREDITED_GROUP_MAX`] ([`super::split_credited_groups`]), so a
    /// stock WRMS of at most 1 holds every credited row within 3 of its
    /// declared tolerance units. For [`Ida::group_weights`].
    pub fn census_groups<S: JoinedSystem>(system: &S) -> Result<WeightGroups, String> {
        let layouts = system.integrated().joined.layouts();
        let mut keys: Vec<String> = layouts
            .iter()
            .flat_map(|(owner, l)| l.classes.iter().map(move |c| format!("{owner}/{c:?}")))
            .collect();
        let operator = system.integrated().joined.dimension();
        if keys.len() != operator {
            return Err(format!(
                "census groups: the layouts cover {} of {operator} coordinates",
                keys.len()
            ));
        }
        let mut credited = credited_coordinates(system)?;
        keys.extend((0..system.appended()).map(|_| "appended".to_string()));
        credited.resize(keys.len(), true);
        if keys.len() != system.dimension() {
            return Err(
                "census groups: the system's dimension is not the operator's and the appended"
                    .into(),
            );
        }
        let keys = super::split_credited_groups(&keys, &credited, super::CREDITED_GROUP_MAX);
        Ok(WeightGroups::from_keys(&keys))
    }

    /// N1: the operator's credited coordinates, census order: every
    /// coordinate of a derived class (S2-D24r/S3-D16, [`super::DERIVED_CLASSES`])
    /// and every coordinate a declared credited output reads. The appended
    /// coordinates are not included (the caller decides for them).
    pub fn credited_coordinates<S: JoinedSystem>(system: &S) -> Result<Vec<bool>, String> {
        let joined = &system.integrated().joined;
        let mut credited: Vec<bool> = joined
            .layouts()
            .iter()
            .flat_map(|(owner, l)| {
                l.classes.iter().map(move |c| {
                    super::DERIVED_CLASSES.contains(&format!("{owner}/{c:?}").as_str())
                })
            })
            .collect();
        if credited.len() != joined.dimension() {
            return Err("credited coordinates: the layouts do not cover the operator".into());
        }
        for o in joined.credited() {
            for j in &o.columns {
                *credited.get_mut(*j).ok_or(
                    "credited coordinates: a credited output reads outside the operator",
                )? = true;
            }
        }
        Ok(credited)
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
        // ELEC S3 hook (joined.rs, KERN-owned): coordinates a wrapper
        // appends after the operator's (the electrical slice). The defaults
        // append none, so every S1/S2 path is unchanged.
        /// Number of coordinates appended after the operator's.
        fn appended(&self) -> usize {
            0
        }
        /// The appended owners' changes due exactly at `t`, before the
        /// operator's transactions (they may set the operator's discrete
        /// inputs, e.g. an RCP's supply), with the restart's command if any:
        /// `y` is the appended part only.
        fn appended_events(
            &mut self,
            _t: f64,
            _command: Option<Command>,
            _y: &mut [f64],
        ) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        /// The appended part's exact consistent start at `t` (its rates into
        /// `yp`) and its differential identity.
        fn appended_start(
            &mut self,
            _t: f64,
            _y: &mut [f64],
            _yp: &mut [f64],
        ) -> Result<Vec<f64>, String> {
            Ok(Vec::new())
        }
        /// X4.3 hook (lane TURB): the operator's coordinates `y` at a
        /// restart, given to the appended owners before
        /// [`JoinedSystem::appended_start`] (the slice's admission reads the
        /// SG pressures). The default reads nothing.
        fn appended_operator_state(&mut self, _y: &[f64]) {}
        /// X4.3: the admitted turbine steam's measurand at `t`, when an
        /// appended owner sets it: the appended valve coordinate (global)
        /// and per SG the global pressure coordinate with its coefficient
        /// per solver unit, `m = y[valve] * sum c_k y[p_k]`. `None`: the
        /// SG owner's time-only admission.
        fn admission_probe(&self, _t: f64) -> Option<(usize, Vec<(usize, f64)>)> {
            None
        }
        /// PROC T1–T3 hook (lane PHYS2, for the IC client): the electrical
        /// routing, when an appended owner routes AC. The client advances its
        /// own copy to each frame instant, so a routing instant that is not a
        /// restart (a qualification timer, a contact end that leaves support
        /// unchanged) is reported at its frame. The default routes none.
        fn routing(&self) -> Option<&leitbild_operating_plant::electrical::bus::Distribution> {
            None
        }
        /// PROC T5 hook (lane PHYS2): the DC groups, when an appended owner
        /// composes them (report-only). The client keeps a copy taken at the
        /// start and after every restart; their reports are exact at any time.
        fn dc_groups(&self) -> Option<&leitbild_operating_plant::electrical::dc::Groups> {
            None
        }
        /// The appended owners' earliest due time strictly after `t`.
        fn appended_next_event(&self, _t: f64) -> Option<f64> {
            None
        }
        /// The operator's and the appended owners' earliest time event.
        fn next_time_event(&self, t: f64) -> Option<f64> {
            let own = self.integrated().joined.next_time_event(t);
            match (own, self.appended_next_event(t)) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            }
        }
        /// The whole differential identity: the operator's, then the
        /// appended part's in its current mode.
        fn differential_all(&self, network_ids: &[f64]) -> Vec<f64> {
            self.integrated().joined.differential(network_ids)
        }
        /// S3-D19: the appended owners' discrete state (null when none is
        /// appended), beside the operator's.
        fn appended_discrete_state(&self) -> serde_json::Value {
            serde_json::Value::Null
        }
        /// Restore [`JoinedSystem::appended_discrete_state`] exactly.
        fn restore_appended_discrete_state(
            &mut self,
            state: &serde_json::Value,
        ) -> Result<(), String> {
            if state.is_null() {
                Ok(())
            } else {
                Err("this system appends no owner: its appended snapshot is null".into())
            }
        }
        /// S3-D19 (S5's snapshot): every owner's discrete state, the
        /// operator's ([`Joined::discrete_state`]) and the appended owners'.
        fn system_discrete_state(&self) -> serde_json::Value {
            serde_json::json!({"operator": self.integrated().joined.discrete_state(),
                "appended": self.appended_discrete_state()})
        }
        /// Restore [`JoinedSystem::system_discrete_state`] exactly: the
        /// operator's owners, then the appended ones (no owner re-derives
        /// another's state here).
        fn restore_system_discrete_state(
            &mut self,
            state: &serde_json::Value,
        ) -> Result<(), String> {
            let o = state
                .as_object()
                .filter(|o| {
                    o.len() == 2 && o.contains_key("operator") && o.contains_key("appended")
                })
                .ok_or("system snapshot is not {operator, appended}")?;
            self.integrated_mut()
                .joined
                .restore_discrete_state(&o["operator"])
                .map_err(|f| format!("{f:?}"))?;
            self.restore_appended_discrete_state(&o["appended"])
        }
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
        /// R4-CLIMB: the last start's matrices, while its climb lasts.
        climb: Option<super::ClimbMatrices>,
        pub joined: Joined<P>,
        rows: Vec<i64>,
        pointers: Vec<i64>,
        assembly: Assembly,
        analyses: Analyses,
        /// The presence-keyed structures when the system follows a
        /// declared vapor presence (S3-D-P3), else `None` (S1, S2).
        presence: Option<Following>,
        /// N3: the first step a discrete restart sets ([`FirstStep`]).
        first_step: FirstStep,
        /// PERF2 (E-LIN, R4-JAC-BASE): the last residual's evaluation, which
        /// stock's next linear setup at the same state repeats.
        base: Base,
    }

    /// PERF2 (E-LIN, R4-JAC-BASE): the state of the last residual call.
    /// Stock IDA sets up its linear system
    /// right after a residual at the same `(t, y, y')` (SUNNonlinSol_Newton
    /// evaluates the residual, then calls lsetup on the same iterate), and
    /// the block assembly starts with exactly that evaluation. The base is
    /// taken only when the state is bitwise the residual's and the operator
    /// has evaluated nothing since (its residual counter); any other
    /// callback or mutable access releases it.
    struct Base {
        held: bool,
        t: f64,
        y: Vec<f64>,
        yp: Vec<f64>,
        evaluations: usize,
    }
    impl Base {
        fn new() -> Self {
            Self {
                held: false,
                t: 0.,
                y: Vec::new(),
                yp: Vec::new(),
                evaluations: 0,
            }
        }
        fn matches(&self, t: f64, y: &[f64], yp: &[f64], evaluations: usize) -> bool {
            let same = |a: &[f64], b: &[f64]| {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
            };
            self.held
                && self.evaluations == evaluations
                && self.t.to_bits() == t.to_bits()
                && same(&self.y, y)
                && same(&self.yp, yp)
        }
    }

    /// N3 (Operable Unit plan, R1 S4): the first step stock IDA takes after
    /// a discrete restart. `Declared` is the segment configuration's own
    /// (`Restart::first_step_s`, G13's 1e-4 s), the composition's default.
    /// `LastStep` is the last step stock accepted before the event divided
    /// by `divisor` (stock IDASetInitStep; it falls back to the declared
    /// step at a segment with no accepted step yet, the composed start).
    #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
    pub enum FirstStep {
        Declared,
        LastStep {
            divisor: f64,
        },
        /// `LastStep` after a declared command or an owner time event, the
        /// declared step after located roots (a located root is where the
        /// mode-changing events of the surge and phase owners sit).
        LastStepUnlessRoots {
            divisor: f64,
        },
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
                first_step: FirstStep::Declared,
                climb: None,
                base: Base::new(),
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
                first_step: FirstStep::Declared,
                climb: None,
                base: Base::new(),
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
                first_step: FirstStep::Declared,
                climb: None,
                base: Base::new(),
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
                base,
                ..
            } = self;
            let Some(f) = following else {
                return Ok(false);
            };
            base.held = false;
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
        /// N3: the first step later discrete restarts set.
        pub fn set_first_step(&mut self, first_step: FirstStep) -> Result<(), String> {
            if let FirstStep::LastStep { divisor } | FirstStep::LastStepUnlessRoots { divisor } =
                first_step
                && !(divisor.is_finite() && divisor >= 1.)
            {
                return Err(format!(
                    "N3 first step: divisor {divisor} must be finite and >= 1"
                ));
            }
            self.first_step = first_step;
            Ok(())
        }
        pub fn first_step(&self) -> FirstStep {
            self.first_step
        }
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
    impl<P: Properties + WaterProperties> Integrated<P> {
        /// R4-CLIMB: while `cj` falls after a restart, the iteration matrix is
        /// the start's `A + cj B`, with the equilibrium columns refreshed at
        /// the climb's first state. A request that does not lower `cj`, Newton's
        /// own retry after a failed solve among them, ends the climb and
        /// assembles in full. Returns whether `data` is filled.
        fn climb_matrix(
            &mut self,
            time: f64,
            cj: f64,
            y: &[f64],
            yp: &[f64],
            data: &mut [f64],
        ) -> Result<bool, Failure> {
            let Some(mut climb) = self.climb.take() else {
                return Ok(false);
            };
            let Assembly::Blocks(structure) = &self.assembly else {
                return Ok(false);
            };
            if cj >= climb.last_cj || climb.a.len() != data.len() {
                return Ok(false);
            }
            if climb.last_cj.is_finite() {
                for (d, (a, b)) in data.iter_mut().zip(climb.a.iter().zip(&climb.b)) {
                    *d = a + cj * b;
                }
            } else {
                let columns = self.joined.network.equilibrium_columns(y.len());
                crate::basis_assembly(true);
                leitbild_operating_plant::network::heaters::hold_endpoints(true);
                let result = jacobian_blocks_start(
                    &mut self.joined,
                    structure,
                    time,
                    cj,
                    y,
                    yp,
                    data,
                    None,
                    Some(&columns),
                );
                crate::basis_assembly(false);
                leitbild_operating_plant::network::heaters::hold_endpoints(false);
                result.map_err(failure)?;
                for (j, refreshed) in columns.iter().enumerate() {
                    for q in self.pointers[j] as usize..self.pointers[j + 1] as usize {
                        if *refreshed {
                            climb.a[q] = data[q] - cj * climb.b[q];
                        } else {
                            data[q] = climb.a[q] + cj * climb.b[q];
                        }
                    }
                }
            }
            climb.last_cj = cj;
            self.climb = Some(climb);
            self.base.held = false;
            Ok(true)
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
        /// E-NUC: each coordinate's multiplicity, from the owners' layouts.
        fn multiplicities(&self) -> Option<Vec<f64>> {
            Some(
                self.joined
                    .layouts()
                    .iter()
                    .flat_map(|(_, l)| l.multiplicity.iter().map(|m| *m as f64))
                    .collect(),
            )
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
            self.base.held = false;
            self.joined.roots(time, y, yp, out).map_err(failure)
        }
        fn residual(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.base.held = false;
            self.joined
                .evaluate(time, y, yp, None, 0., None)
                .map_err(failure)?;
            for (r, v) in out.iter_mut().zip(self.joined.rows()) {
                *r = v.value;
            }
            if matches!(self.assembly, Assembly::Blocks(_)) {
                let b = &mut self.base;
                b.t = time;
                b.y.clear();
                b.y.extend_from_slice(y);
                b.yp.clear();
                b.yp.extend_from_slice(yp);
                b.evaluations = self.joined.counters.residuals;
                b.held = true;
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
            if self.climb_matrix(time, cj, y, yp, data)? {
                return Ok(());
            }
            match &self.assembly {
                Assembly::Colored => self.joined.jacobian(time, cj, y, yp, data),
                Assembly::Blocks(structure) => {
                    // The operator counts its colored assemblies itself.
                    let started = std::time::Instant::now();
                    // R4-WATER-PARTIALS: the water basis store for this assembly.
                    crate::basis_assembly(true);
                    // R4-ENDPOINT-ASSEMBLY: the heater endpoints of this assembly.
                    leitbild_operating_plant::network::heaters::hold_endpoints(true);
                    // R4-JAC-BASE: the residual's evaluation at this very
                    // state stands; with the relief shut its rows are those
                    // of the assembly's reuse evaluation bit for bit (only a
                    // lifted relief's restriction is held with partials).
                    let on_base = self
                        .base
                        .matches(time, y, yp, self.joined.counters.residuals)
                        && self.joined.network.pzr_boundary().is_none_or(|(b, _)| {
                            b.relief.as_ref().is_none_or(|r| r.lift.value == 0.)
                        });
                    self.base.held = false;
                    let result = if on_base {
                        let reuse = self.joined.network.reuse();
                        let mut profile = leitbild_operating_plant::cost::pieces()
                            .then(|| Profile::new(leitbild_operating_plant::cost::now_f64));
                        let result = jacobian_blocks_on_base(
                            &mut self.joined,
                            structure,
                            time,
                            cj,
                            y,
                            yp,
                            data,
                            Classes::ALL,
                            reuse,
                            profile.as_mut(),
                        );
                        for (piece, (calls, spent)) in profile.into_iter().flat_map(|p| p.pieces) {
                            leitbild_operating_plant::cost::book(piece, calls, spent as u64);
                        }
                        result
                    } else if leitbild_operating_plant::cost::pieces() {
                        let mut profile = Profile::new(leitbild_operating_plant::cost::now_f64);
                        let result = jacobian_blocks_profiled(
                            &mut self.joined,
                            structure,
                            time,
                            cj,
                            y,
                            yp,
                            data,
                            Classes::ALL,
                            &mut profile,
                        );
                        for (piece, (calls, spent)) in profile.pieces {
                            leitbild_operating_plant::cost::book(piece, calls, spent as u64);
                        }
                        result
                    } else {
                        jacobian_blocks(
                            &mut self.joined,
                            structure,
                            time,
                            cj,
                            y,
                            yp,
                            data,
                            Classes::ALL,
                        )
                    };
                    crate::basis_assembly(false);
                    leitbild_operating_plant::network::heaters::hold_endpoints(false);
                    self.joined.counters.jacobians += 1;
                    self.joined.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
                    result
                }
            }
            .map_err(failure)
        }
    }
    /// One borrowed handle on an [`Integrated`] system, for a stock solve
    /// that must hand the composition back (DR13-ROD-A).
    struct Borrowed<'a, P: Properties>(&'a mut Integrated<P>);
    impl<P: Properties + WaterProperties> System for Borrowed<'_, P> {
        fn dimension(&self) -> usize {
            self.0.dimension()
        }
        fn nonzeros(&self) -> usize {
            self.0.nonzeros()
        }
        fn root_count(&self) -> usize {
            self.0.root_count()
        }
        fn klu_ordering(&self) -> KluOrdering {
            self.0.klu_ordering()
        }
        fn multiplicities(&self) -> Option<Vec<f64>> {
            self.0.multiplicities()
        }
        fn residual(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.0.residual(time, y, yp, out)
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
            self.0.jacobian(time, cj, y, yp, data, rows, pointers)
        }
        fn roots(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.0.roots(time, y, yp, out)
        }
    }

    /// Lead decision DR13-ROD-A (17 October 2026): at a zero-time
    /// composition, stock IDACalcIC (`IDA_YA_YDP_INIT`, through the pinned
    /// [`Ida::initialize`]) makes the algebraic coordinates consistent with
    /// the held differential ones (the rod owner's mouth currents start at
    /// zero) before the declared exact consistent start, which then only
    /// refines. Preparation only: `y` keeps every differential coordinate,
    /// the rates are not kept, and the composition is handed back.
    /// `horizon` is stock's first output time after `t`.
    pub fn stock_initial_conditions<P: Properties + WaterProperties>(
        joined: Joined<P>,
        t: f64,
        y: &mut [f64],
        differential: &[f64],
        absolute: &[f64],
        relative: f64,
        horizon: f64,
    ) -> Result<Joined<P>, String> {
        let mut integrated = Integrated::new(joined)?;
        let held: Vec<f64> = y.to_vec();
        let mut yp = vec![0.; y.len()];
        {
            let mut ida = Ida::new(
                Borrowed(&mut integrated),
                crate::ida::Initial {
                    time: t,
                    y,
                    yp: &yp,
                    differential,
                    absolute_tolerance: absolute,
                    relative_tolerance: relative,
                },
            )
            .map_err(|e| format!("stock IDA for the initial conditions: {e}"))?;
            ida.initialize(horizon, y, &mut yp)
                .map_err(|e| format!("stock IDACalcIC: {e}"))?;
        }
        if held
            .iter()
            .zip(y.iter())
            .zip(differential)
            .any(|((a, b), d)| *d != 0. && a.to_bits() != b.to_bits())
        {
            return Err("stock IDACalcIC moved a differential coordinate".into());
        }
        Ok(integrated.joined)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CREDITED_GROUP_MAX, ROUNDOFF_FACTOR, correction_wrms, equation_changes, owner_ranges,
        row_bound, split_credited_groups, transacted_owners,
    };
    use crate::ida::WeightGroups;

    #[test]
    fn a_row_is_held_to_the_declared_bound_or_its_own_roundoff() {
        // Small terms: the declared bound.
        assert_eq!(row_bound(1e-12, 1.), 1e-12);
        // A balance of ~3e4 in scaled units (two 15 MPa pressures over a
        // 34 kPa head scale, or the bores' pressure rate after a seat): its
        // last bit is 2^-37 = 7.3e-12, held to 8 eps x 3e4 = 5.3e-11.
        let b = row_bound(1e-12, 3e4);
        assert!((b - ROUNDOFF_FACTOR * f64::EPSILON * 3e4).abs() < 1e-24);
        assert!(b > 2f64.powi(-37));
    }

    /// N1's bound by construction: under group-normalised weights a vector
    /// at grouped WRMS 1 (in declared tolerance units u) has no credited row
    /// above sqrt(9) = 3, whatever its shape; the uncredited class keeps one
    /// group and may carry more.
    #[test]
    fn a_credited_row_stays_within_three_units_at_grouped_wrms_one() {
        let mut keys: Vec<String> = Vec::new();
        keys.extend((0..52).map(|_| "rods/GuideCurrent".to_string()));
        keys.extend((0..29).map(|_| "network/CellPressure".to_string()));
        keys.extend((0..2316).map(|_| "nuclear/Precursor".to_string()));
        let mut credited = vec![false; keys.len()];
        credited[..52].fill(true);
        credited[52 + 3] = true; // one pressure a credited output reads
        let split = split_credited_groups(&keys, &credited, CREDITED_GROUP_MAX);
        let groups = WeightGroups::from_keys(&split);
        assert!(
            groups.sizes().iter().take(6 + 4).all(|n| *n <= 9),
            "{:?}",
            groups.sizes()
        );
        assert_eq!(groups.sizes().len(), 6 + 4 + 1);
        assert_eq!(split[0], "rods/GuideCurrent#0");
        assert_eq!(split[51], "rods/GuideCurrent#5");
        assert_eq!(split[52 + 28], "network/CellPressure#3");
        assert_eq!(split[52 + 29], "nuclear/Precursor");
        let factor = groups.factors();
        let n = keys.len() as f64;
        let grouped = |u: &[f64]| {
            (u.iter()
                .zip(&factor)
                .map(|(u, f)| (u * f) * (u * f))
                .sum::<f64>()
                / n)
                .sqrt()
        };
        // The worst case: all error on one credited row.
        for i in [0, 47, 52 + 3, 52 + 28] {
            let mut u = vec![0.; keys.len()];
            u[i] = 1.;
            let at_one = u[i] / grouped(&u);
            assert!(at_one <= 3. + 1e-12, "row {i}: {at_one}");
        }
        // Deterministic pseudo-random shapes, scaled to grouped WRMS 1.
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..200 {
            let u: Vec<f64> = (0..keys.len())
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x >> 11) as f64 / (1u64 << 53) as f64 - 0.5
                })
                .collect();
            let s = grouped(&u);
            let worst = (0..keys.len())
                .filter(|i| credited[*i] || split[*i].starts_with("network/CellPressure"))
                .map(|i| (u[i] / s).abs())
                .fold(0f64, f64::max);
            assert!(worst <= 3. + 1e-12, "{worst}");
        }
        // The uncredited class (one group of 2,316) is not bounded by 3.
        let mut u = vec![0.; keys.len()];
        u[52 + 29] = 1.;
        assert!(u[52 + 29] / grouped(&u) > 40.);
    }
    use leitbild_operating_plant::joined::operator::Offsets;

    #[test]
    fn each_transacting_owner_owns_only_its_own_coordinates() {
        let composed = Offsets {
            nuclear: 2,
            solids: 4,
            secondary: 6,
            rods: 9,
            pzr: 12,
            cvcs: 15,
            end: 18,
        };
        let [secondary, rods, pzr, cvcs] = owner_ranges(composed);
        assert_eq!(secondary, ("secondary", 6..9));
        assert_eq!(
            rods,
            ("rods", 9..12),
            "the rods end where the PZR block starts"
        );
        assert_eq!(pzr, ("pzr", 12..15));
        assert_eq!(cvcs, ("cvcs", 15..18));
        let without = Offsets {
            pzr: 12,
            cvcs: 12,
            end: 12,
            ..composed
        };
        assert!(owner_ranges(without)[2].1.is_empty());
        assert!(owner_ranges(without)[3].1.is_empty());
    }

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
    fn a_reported_row_equation_change_names_its_owner() {
        use serde_json::json;
        let path = "network/spray path";
        let closed = [(path, json!({"closed": true, "check_closed": false}))];
        let open = [(path, json!({"closed": false, "check_closed": false}))];
        let check = [(path, json!({"closed": false, "check_closed": true}))];
        // No reporting owner, or nothing changed: none.
        assert!(equation_changes(&[], &[]).unwrap().is_empty());
        assert!(equation_changes(&closed, &closed).unwrap().is_empty());
        // The valve's release and the check's release each change the row's equation.
        assert_eq!(equation_changes(&closed, &open).unwrap(), vec![path]);
        assert_eq!(equation_changes(&check, &open).unwrap(), vec![path]);
        // A changed owner list within one restart refuses.
        assert!(equation_changes(&closed, &[]).is_err());
        assert!(equation_changes(&closed, &[("rods", json!(null))]).is_err());
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

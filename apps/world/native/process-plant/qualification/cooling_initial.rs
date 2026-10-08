//! Dependency-factored fixed-stock initialization. Attain the autonomous
//! thermodynamic charts once, then solve the coupled hydraulics and all chart
//! rates at that endpoint. No alternating integrator IC calls or flash.
use super::{OUTPUTS, cooling_accuracy, cooling_block::Sparse, cooling_convergence, recoverable};
use leitbild_plant_numerics::{
    operating_admission,
    operating_network::MotionGeometry,
    source_cooling::{CurrentGeometry, GeometryDirection, Model, Workspace},
};
use std::{collections::HashMap, time::Instant};

#[derive(Default)]
pub(super) struct Trace(pub Vec<String>);
impl Trace {
    pub fn json(&self) -> String {
        format!("[{}]", self.0.join(","))
    }
    fn failure(&self, reason: &str) -> String {
        format!(
            "{reason}; lastIteration={}",
            self.0.last().map_or("null", String::as_str)
        )
    }
}

pub(super) struct Report {
    pub iterations: usize,
    pub chart_iterations: usize,
    pub chart_correction_l2: f64,
    pub seconds: f64,
    pub correction_l2: f64,
    pub max_forward_rate_residual: f64,
}
impl Report {
    pub fn json(&self) -> String {
        format!(
            "{{\"scope\":\"dependency-factored-current-fluid-F-and-differentiated-forward-charts;fixed-differential-stocks;held-forcing-inexact-Newton\",\"correctionScales\":\"same-current-per-row-production-scales\",\"iterations\":{},\"chartIterations\":{},\"hydraulicRateIterations\":{},\"lastAppliedChartCorrectionL2\":{},\"chartEndpoint\":\"final-small-Newton-update-consumed;actual-forward-charts-reevaluated;original-defects-retained-and-final-physical-admission-required\",\"seconds\":{},\"lastWeightedCorrectionL2\":{},\"lastWeightedCorrectionScope\":\"remaining-hydraulic-state-and-all-rates\",\"maxForwardRateResidualMixedUnits\":{},\"rateCorrectionTimeScaleSeconds\":{},\"outerNonlinearCorrectionL2Budget\":{},\"innerLinearForcingBudgetDiagnostic\":{}}}",
            self.iterations,
            self.chart_iterations,
            self.iterations - self.chart_iterations,
            self.chart_correction_l2,
            self.seconds,
            self.correction_l2,
            self.max_forward_rate_residual,
            OUTPUTS[0],
            cooling_convergence::NONLINEAR_COEFFICIENT,
            cooling_convergence::LINEAR_L2_BUDGET
        )
    }
}

// The partition is a physical dependency contract, not an instruction to
// discard small residuals. A future chart coupled to a hydraulic state/rate
// must refuse this initializer rather than silently freeze that dependency.
fn check_chart_dependency(
    model: &Model,
    charts: &HashMap<usize, usize>,
    row: usize,
    col: usize,
    value: f64,
    rate: bool,
) -> Result<(), String> {
    if charts.contains_key(&row)
        && value != 0.
        && (rate || (!charts.contains_key(&col) && !model.is_differential(col)))
    {
        Err(format!(
            "Fixed-stock chart {row} depends on {} coordinate {col}",
            if rate {
                "rate"
            } else {
                "unpartitioned algebraic"
            }
        ))
    } else {
        Ok(())
    }
}

fn check_charts(model: &Model, y: &[f64], yp: &[f64], work: &Workspace) -> Result<(), String> {
    let l = model.layout;
    operating_admission::chart_corrections(
        &model.network,
        &work.network,
        &y[l.network_start..l.carrier_start],
    )?
    .check()?;
    let mut pool = model.pressure_connection().pressurizer.workspace();
    let mut line = model.pressure_connection().surge.workspace();
    let (p, s) = model.pressure_chart_corrections(&work.network, y, yp, &mut pool, &mut line)?;
    let head = cooling_accuracy::pressure_level_head_scale(model, y, &pool)?;
    cooling_accuracy::check_pressure_chart(model, &p, &s, head)?;
    if cooling_convergence::pressure_caloric_ratio(model, y, &pool, &line)? > 1. {
        return Err("Initial pressure metal caloric chart refused".into());
    }
    Ok(())
}

/// Same held-current-geometry initializer, with explicit physical geometry
/// time direction for the differentiated forward charts. This owns no pose,
/// water or integration clock. Callers supply the selected mechanical branch.
pub(super) struct Moving<'a> {
    pub value: CurrentGeometry<'a>,
    pub time: GeometryDirection<'a>,
}
fn evaluate(
    model: &Model,
    y: &[f64],
    yp: &[f64],
    cj: Option<f64>,
    work: &mut Workspace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
    moving: Option<&Moving<'_>>,
) -> Result<(), String> {
    if let Some(g) = moving {
        model.evaluate_with_current_geometry(
            y,
            yp,
            cj,
            work,
            prhr_input,
            CurrentGeometry {
                source: g.value.source,
                contacts: g.value.contacts,
                mobile: g.value.mobile,
                barrel_chords_m: g.value.barrel_chords_m,
                network: MotionGeometry {
                    water: g.value.network.water,
                    connections: g.value.network.connections,
                },
            },
        )
    } else {
        model.evaluate_with_prhr_input(y, yp, cj, work, prhr_input)
    }
}
fn prepare(
    model: &Model,
    y: &[f64],
    yp: &mut [f64],
    work: &mut Workspace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
    moving: Option<&Moving<'_>>,
    geometry_rate: &mut [f64],
) -> Result<(), String> {
    evaluate(model, y, yp, None, work, prhr_input, moving)?;
    let fluid = model.fluid_rows().collect::<std::collections::HashSet<_>>();
    // Other ODEs have identity Fyp. Their actual current receipts are inputs
    // to the fluid solve, not frozen powers from a different trial.
    for r in 0..model.dimension() {
        if model.is_differential(r) && !fluid.contains(&r) {
            yp[r] -= work.residual[r];
        }
    }
    let l = model.layout;
    for (i, &c) in work.thermal.capacities()?.iter().enumerate() {
        yp[l.temperatures_start + i] = yp[l.energies_start + i] / c;
    }
    yp[l.barrel_temperature] = yp[l.barrel_energy] / work.barrel.capacity()?;
    for (i, &capacity) in work.absorber_guide.capacity.iter().enumerate() {
        yp[l.absorber_guide_temperatures_start + i] =
            yp[l.absorber_guide_energies_start + i] / capacity;
    }
    evaluate(model, y, yp, Some(0.), work, prhr_input, moving)?;
    if let Some(g) = moving {
        // Only the primary network forward charts depend on this motion.
        // Reuse their exact existing chain, not a full SOURCE/photon JVP just
        // to read a few thermodynamic rows at every contact restart.
        geometry_rate.fill(0.);
        work.network.add_motion_jvp(
            &model.network,
            g.time.water,
            g.time.connections,
            geometry_rate,
        )?;
    }
    Ok(())
}
fn correction_norm(
    model: &Model,
    y: &[f64],
    absolute: &[f64],
    relative: f64,
    unknown: &[(usize, bool)],
    delta: &[f64],
) -> Result<(f64, usize), String> {
    let (mut squares, mut worst, mut maximum) = (0., 0, 0.);
    for (i, (&(r, rate), &d)) in unknown.iter().zip(delta).enumerate() {
        let scale = super::state_error_scale(model, r, y[r], absolute[r], relative);
        if !scale.is_finite() || scale <= 0. || !d.is_finite() {
            return Err("Invalid current joint initialization scale/correction".into());
        }
        let z = (d * if rate { OUTPUTS[0] } else { 1. } / scale).abs();
        squares += z * z;
        if z > maximum {
            worst = i;
            maximum = z;
        }
    }
    let norm = squares.sqrt();
    if !norm.is_finite() {
        return Err("Nonfinite joint initialization correction".into());
    }
    Ok((norm, worst))
}

#[allow(clippy::too_many_arguments)]
fn attain_charts(
    model: &Model,
    y: &mut [f64],
    yp: &mut [f64],
    absolute: &[f64],
    work: &mut Workspace,
    start: Instant,
    allowance: f64,
    relative: f64,
    trace: &mut Trace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
    moving: Option<&Moving<'_>>,
    geometry_rate: &mut [f64],
    forward: &[usize],
) -> Result<(usize, f64), String> {
    let charts = forward
        .iter()
        .enumerate()
        .map(|(i, &r)| (r, i))
        .collect::<HashMap<_, _>>();
    let unknown = forward.iter().map(|&r| (r, false)).collect::<Vec<_>>();
    let mut pattern = Vec::new();
    let mut error = None;
    model.visit_fluid_jacobian(work, |r, c, v| {
        if let Err(e) = check_chart_dependency(model, &charts, r, c, v, false) {
            error = Some(e);
        }
        if let (Some(&i), Some(&j)) = (charts.get(&r), charts.get(&c)) {
            pattern.push((i, j));
        }
    })?;
    model.visit_fluid_rate_matrix(work, |r, c, v| {
        if let Err(e) = check_chart_dependency(model, &charts, r, c, v, true) {
            error = Some(e);
        }
    })?;
    if let Some(e) = error {
        return Err(e);
    }
    let mut matrix = Sparse::new(
        "Factor autonomous fixed-stock charts KLU",
        forward.len(),
        pattern,
    )?;
    let mut rhs = vec![0.; forward.len()];
    let mut delta = rhs.clone();
    let mut trial = y.to_vec();
    // Reserve at least one of the unchanged total twelve Newton solves for
    // the hydraulic/rate block. EVERY chart correction is applied, including
    // the accepted final small one: its pressure defect can otherwise be
    // amplified by a low-resistance port despite small chart-scaled norm.
    for iteration in 1..12 {
        if start.elapsed().as_secs_f64() >= allowance {
            return Err("Chart initialization wall allowance exhausted".into());
        }
        prepare(model, y, yp, work, prhr_input, moving, geometry_rate)?;
        matrix.clear();
        for (i, &r) in forward.iter().enumerate() {
            rhs[i] = -work.residual[r];
        }
        error = None;
        model.visit_fluid_jacobian(work, |r, c, v| {
            if let Err(e) = check_chart_dependency(model, &charts, r, c, v, false) {
                error = Some(e);
            }
            if let (Some(&i), Some(&j)) = (charts.get(&r), charts.get(&c)) {
                if let Err(e) = matrix.add(i, j, v) {
                    error = Some(e);
                }
            }
        })?;
        model.visit_fluid_rate_matrix(work, |r, c, v| {
            if let Err(e) = check_chart_dependency(model, &charts, r, c, v, true) {
                error = Some(e);
            }
        })?;
        if let Some(e) = error {
            return Err(e);
        }
        matrix.factor()?;
        matrix.solve(&rhs, &mut delta)?;
        let (norm, worst) = correction_norm(model, y, absolute, relative, &unknown, &delta)?;
        let (linear_row, backward, backward_absolute, backward_scale) =
            matrix.backward_error(&rhs, &delta);
        trace.0.push(format!(
            "{{\"phase\":\"fixed-stock-charts\",\"iteration\":{iteration},\"weightedCorrectionL2\":{norm},\"worstCorrectionRow\":{},\"correction\":{},\"currentState\":{},\"currentProductionScale\":{},\"chartResidualMixedUnits\":{},\"maxLinearBackwardError\":{backward},\"linearBackwardErrorAbsolute\":{backward_absolute},\"linearBackwardErrorContributorSum\":{backward_scale},\"linearBackwardErrorEquationRow\":{}}}",
            forward[worst], delta[worst], y[forward[worst]], super::state_error_scale(model,forward[worst],y[forward[worst]],absolute[forward[worst]],relative), work.residual[forward[worst]],forward[linear_row]
        ));
        let mut accepted = false;
        for half in 0..8 {
            let scale = 2_f64.powi(-half);
            trial.copy_from_slice(y);
            for (&r, &d) in forward.iter().zip(&delta) {
                trial[r] += scale * d;
            }
            match evaluate(model, &trial, yp, None, work, prhr_input, moving) {
                Ok(()) => {
                    y.copy_from_slice(&trial);
                    accepted = true;
                    break;
                }
                Err(e) if recoverable(&e) => {}
                Err(e) => return Err(e),
            }
        }
        if !accepted {
            return Err("Chart initialization exhausted finite trial-domain steps".into());
        }
        if norm <= cooling_convergence::NONLINEAR_COEFFICIENT {
            // The domain-checked value evaluation above is at the UPDATED
            // endpoint, not at the seed where delta was computed. Keep its
            // actual chart defects inspectable. This intermediate endpoint
            // is not a complete admitted state: PRHR surface equations still
            // need the conditional flow/heat solve and all final guards.
            let worst = *forward
                .iter()
                .max_by(|&&a, &&b| work.residual[a].abs().total_cmp(&work.residual[b].abs()))
                .unwrap();
            trace.0.push(format!("{{\"phase\":\"attained-chart-endpoint\",\"iteration\":{iteration},\"lastAppliedChartCorrectionL2\":{norm},\"maxChartResidualRow\":{worst},\"maxChartResidualMixedUnits\":{},\"completeStateAdmitted\":false}}",work.residual[worst]));
            return Ok((iteration, norm));
        }
    }
    Err(trace.failure("Chart initialization exhausted the total 12-iteration budget"))
}
pub(super) fn initialize(
    model: &Model,
    y: &mut [f64],
    yp: &mut [f64],
    absolute: &[f64],
    work: &mut Workspace,
    start: Instant,
    allowance: f64,
    relative: f64,
    trace: &mut Trace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
) -> Result<Report, String> {
    initialize_current(
        model, y, yp, absolute, work, start, allowance, relative, trace, prhr_input, None,
    )
}
pub(super) fn initialize_with_geometry(
    model: &Model,
    y: &mut [f64],
    yp: &mut [f64],
    absolute: &[f64],
    work: &mut Workspace,
    start: Instant,
    allowance: f64,
    relative: f64,
    trace: &mut Trace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
    moving: &Moving<'_>,
) -> Result<Report, String> {
    initialize_current(
        model,
        y,
        yp,
        absolute,
        work,
        start,
        allowance,
        relative,
        trace,
        prhr_input,
        Some(moving),
    )
}
fn initialize_current(
    model: &Model,
    y: &mut [f64],
    yp: &mut [f64],
    absolute: &[f64],
    work: &mut Workspace,
    start: Instant,
    allowance: f64,
    relative: f64,
    trace: &mut Trace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
    moving: Option<&Moving<'_>>,
) -> Result<Report, String> {
    trace.0.clear();
    let began = Instant::now();
    let n = model.dimension();
    if y.len() != n
        || yp.len() != n
        || absolute.len() != n
        || absolute.iter().any(|a| !a.is_finite() || *a <= 0.)
        || !relative.is_finite()
        || relative < 0.
    {
        return Err("Invalid joint initialization inputs".into());
    }
    let initial = y.to_vec();
    let forward = model.forward_chart_rows();
    let all_rows = model.fluid_rows().collect::<Vec<_>>();
    if forward
        .iter()
        .any(|r| !all_rows.contains(r) || model.is_differential(*r))
    {
        return Err("Invalid forward initialization chart metadata".into());
    }
    let mut geometry_rate = if moving.is_some() {
        vec![0.; model.network.dimension()]
    } else {
        Vec::new()
    };
    prepare(model, y, yp, work, prhr_input, moving, &mut geometry_rate)?;
    let (chart_iterations, chart_correction_l2) = attain_charts(
        model,
        y,
        yp,
        absolute,
        work,
        start,
        allowance,
        relative,
        trace,
        prhr_input,
        moving,
        &mut geometry_rate,
        &forward,
    )?;
    let attained_charts = forward.iter().map(|&r| y[r].to_bits()).collect::<Vec<_>>();
    // These primitive equations were actually solved above. Their residuals
    // remain in Workspace and admission; they must not inject another rounded
    // EOS/chart correction into the conditional low-resistance flow solve.
    let rows = all_rows
        .into_iter()
        .filter(|r| !forward.contains(r))
        .collect::<Vec<_>>();
    let physical = rows
        .iter()
        .enumerate()
        .map(|(i, &r)| (r, i))
        .collect::<HashMap<_, _>>();
    let mut unknown = rows
        .iter()
        .map(|&r| (r, model.is_differential(r)))
        .collect::<Vec<_>>();
    unknown.extend(forward.iter().map(|&r| (r, true)));
    let states = unknown
        .iter()
        .enumerate()
        .filter(|(_, (_, rate))| !*rate)
        .map(|(i, &(r, _))| (r, i))
        .collect::<HashMap<_, _>>();
    let rates = unknown
        .iter()
        .enumerate()
        .filter(|(_, (_, rate))| *rate)
        .map(|(i, &(r, _))| (r, i))
        .collect::<HashMap<_, _>>();
    let forward_index = forward
        .iter()
        .enumerate()
        .map(|(i, &r)| (r, rows.len() + i))
        .collect::<HashMap<_, _>>();
    if physical.len() != rows.len()
        || rates.len() + states.len() != unknown.len()
        || forward_index.len() != forward.len()
    {
        return Err("Duplicate initialization coordinate".into());
    }
    prepare(model, y, yp, work, prhr_input, moving, &mut geometry_rate)?;
    let mut pattern = Vec::new();
    model.visit_fluid_jacobian(work, |r, c, _| {
        if let (Some(&i), Some(&j)) = (physical.get(&r), states.get(&c)) {
            pattern.push((i, j));
        }
        if let (Some(&i), Some(&j)) = (forward_index.get(&r), rates.get(&c)) {
            pattern.push((i, j));
        }
    })?;
    model.visit_fluid_rate_matrix(work, |r, c, _| {
        if let (Some(&i), Some(&j)) = (physical.get(&r), rates.get(&c)) {
            pattern.push((i, j));
        }
    })?;
    let mut matrix = Sparse::new("Factor consistent cold entry KLU", unknown.len(), pattern)?;
    let mut rhs = vec![0.; unknown.len()];
    let mut delta = rhs.clone();
    let mut trial_y = y.to_vec();
    let mut trial_yp = yp.to_vec();
    for hydraulic_iteration in 1..=12 - chart_iterations {
        let iteration = chart_iterations + hydraulic_iteration;
        if start.elapsed().as_secs_f64() >= allowance {
            return Err("Joint initialization wall allowance exhausted".into());
        }
        prepare(model, y, yp, work, prhr_input, moving, &mut geometry_rate)?;
        matrix.clear();
        rhs.fill(0.);
        for (i, &r) in rows.iter().enumerate() {
            rhs[i] = -work.residual[r];
        }
        if moving.is_some() {
            for (i, &r) in forward.iter().enumerate() {
                // F_y*y' + F_geometry*geometry' = 0. Geometry time motion
                // is not a cloned inventory or a reset of the retained chart.
                if (model.layout.network_start..model.layout.carrier_start).contains(&r) {
                    rhs[rows.len() + i] = -geometry_rate[r - model.layout.network_start];
                }
            }
        }
        let mut error = None;
        model.visit_fluid_jacobian(work, |r, c, v| {
            if let Err(e) = check_chart_dependency(model, &forward_index, r, c, v, false) {
                error = Some(e);
            }
            if let (Some(&i), Some(&j)) = (physical.get(&r), states.get(&c)) {
                if let Err(e) = matrix.add(i, j, v) {
                    error = Some(e);
                }
            }
            if let Some(&i) = forward_index.get(&r) {
                rhs[i] -= v * yp[c];
                if let Some(&j) = rates.get(&c) {
                    if let Err(e) = matrix.add(i, j, v) {
                        error = Some(e);
                    }
                }
            }
        })?;
        model.visit_fluid_rate_matrix(work, |r, c, v| {
            if let Err(e) = check_chart_dependency(model, &forward_index, r, c, v, true) {
                error = Some(e);
            }
            if let (Some(&i), Some(&j)) = (physical.get(&r), rates.get(&c)) {
                if let Err(e) = matrix.add(i, j, v) {
                    error = Some(e);
                }
            }
        })?;
        if let Some(e) = error {
            return Err(e);
        }
        let forward_residual = rhs[rows.len()..]
            .iter()
            .map(|v| v.abs())
            .fold(0_f64, f64::max);
        matrix.factor()?;
        matrix.solve(&rhs, &mut delta)?;
        let (linear_row, backward_error, backward_absolute, backward_scale) =
            matrix.backward_error(&rhs, &delta);
        // Same current per-row state scales as production. Rate corrections
        // represent an increment over OUTPUTS[0], not fractional rate accuracy.
        let (norm, worst) = correction_norm(model, y, absolute, relative, &unknown, &delta)?;
        let (absolute_norm, _) = correction_norm(model, y, absolute, 0., &unknown, &delta)?;
        let (row, rate) = unknown[worst];
        let physical_worst = rows
            .iter()
            .copied()
            .max_by(|&a, &b| work.residual[a].abs().total_cmp(&work.residual[b].abs()))
            .unwrap();
        let forward_worst = (0..forward.len())
            .max_by(|&a, &b| {
                rhs[rows.len() + a]
                    .abs()
                    .total_cmp(&rhs[rows.len() + b].abs())
            })
            .unwrap();
        let equation_row = if linear_row < rows.len() {
            rows[linear_row]
        } else {
            forward[linear_row - rows.len()]
        };
        trace.0.push(format!(
            "{{\"phase\":\"hydraulics-and-all-rates\",\"iteration\":{iteration},\"phaseIteration\":{hydraulic_iteration},\"weightedCorrectionL2\":{norm},\"absoluteOnlyCorrectionL2Diagnostic\":{absolute_norm},\"worstCorrectionRow\":{row},\"rateCorrection\":{rate},\"correction\":{},\"absoluteScale\":{},\"currentProductionScale\":{},\"currentState\":{},\"currentRate\":{},\"maxPhysicalResidualRow\":{physical_worst},\"maxPhysicalResidualMixedUnits\":{},\"maxForwardRateResidualRow\":{},\"maxForwardRateResidualMixedUnits\":{forward_residual},\"maxLinearBackwardError\":{backward_error},\"linearBackwardErrorAbsolute\":{backward_absolute},\"linearBackwardErrorContributorSum\":{backward_scale},\"linearBackwardErrorRHS\":{},\"linearBackwardErrorEquationRow\":{equation_row},\"linearBackwardErrorDifferentiatedChart\":{}}}",
            delta[worst], absolute[row], super::state_error_scale(model,row,y[row],absolute[row],relative), y[row], yp[row], work.residual[physical_worst], forward[forward_worst], rhs[linear_row], linear_row >= rows.len()
        ));
        // This is an OUTER Newton state correction from a direct KLU solve.
        // EPS_LIN times this coefficient is the separate inner iterative
        // linear forcing target, not an additional demand for EOS digits.
        // Retain strict L2 (no state-count dilution), all production row
        // scales, and the independent physical/chart gates below.
        if norm <= cooling_convergence::NONLINEAR_COEFFICIENT {
            check_charts(model, y, yp, work)?;
            let mut line = model.pressure_connection().surge.workspace();
            let mut pool = model.pressure_connection().pressurizer.workspace();
            model.pressure_chart_corrections(&work.network, y, yp, &mut pool, &mut line)?;
            if cooling_convergence::pressure_flow_ratio(model, &line)? > 1. {
                return Err("Initial pressure hydraulic closure refused".into());
            }
            model.validate_accepted(y, work)?;
            for (&r, &bits) in forward.iter().zip(&attained_charts) {
                if y[r].to_bits() != bits {
                    return Err(format!(
                        "Conditional initialization changed attained chart {r}"
                    ));
                }
            }
            for r in 0..n {
                if model.is_differential(r) && y[r].to_bits() != initial[r].to_bits() {
                    return Err(format!(
                        "Joint initialization changed differential stock {r}"
                    ));
                }
            }
            return Ok(Report {
                iterations: iteration,
                chart_iterations,
                chart_correction_l2,
                seconds: began.elapsed().as_secs_f64(),
                correction_l2: norm,
                max_forward_rate_residual: forward_residual,
            });
        }
        // Only known physical trial-domain refusals permit a smaller Newton
        // step. There is no alternate model, repaired stock or backend.
        let mut accepted = false;
        for half in 0..8 {
            let scale = 2_f64.powi(-half);
            trial_y.copy_from_slice(y);
            trial_yp.copy_from_slice(yp);
            for (&(r, rate), &d) in unknown.iter().zip(&delta) {
                if rate {
                    trial_yp[r] += scale * d;
                } else {
                    trial_y[r] += scale * d;
                }
            }
            match evaluate(model, &trial_y, &trial_yp, None, work, prhr_input, moving) {
                Ok(()) => {
                    y.copy_from_slice(&trial_y);
                    yp.copy_from_slice(&trial_yp);
                    accepted = true;
                    break;
                }
                Err(e) if recoverable(&e) => {}
                Err(e) => return Err(e),
            }
        }
        if !accepted {
            return Err("Joint initialization exhausted finite trial-domain steps".into());
        }
    }
    Err(trace.failure("Joint initialization failed its fixed 12-iteration limit"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chart_partition_refuses_hidden_hydraulic_and_rate_dependencies() {
        let m = super::super::cooling_fixture::fixture();
        let charts = m
            .forward_chart_rows()
            .into_iter()
            .enumerate()
            .map(|(i, r)| (r, i))
            .collect();
        let row = m.layout.network_start + m.network.pressure_row();
        let flow = m.layout.network_start + m.network.flow_row(0);
        let stock = m.layout.network_start + m.network.total_mass_row();
        assert!(check_chart_dependency(&m, &charts, row, stock, 1., false).is_ok());
        assert!(check_chart_dependency(&m, &charts, row, row, 1., false).is_ok());
        assert!(check_chart_dependency(&m, &charts, row, flow, 1., false).is_err());
        assert!(check_chart_dependency(&m, &charts, row, stock, 1., true).is_err());
    }
    #[test]
    fn chart_endpoint_is_attained_and_seed_independent_at_declared_accuracy() {
        let m = super::super::cooling_fixture::fixture_with_contrast();
        let accuracy =
            cooling_accuracy::Accuracy::new(&m, &vec![[0.; 2]; m.source.target_count()], None)
                .unwrap();
        let initial = m.initial_state().unwrap();
        let absolute = accuracy.absolute(10.).unwrap();
        let mut endpoints = Vec::new();
        for perturb in [false, true] {
            let mut y = initial.clone();
            if perturb {
                y[m.layout.network_start + m.network.pressure_row()] += 50.;
                y[m.layout.network_start + m.network.temperature_row(0)] += 0.01;
                y[m.layout.surge_start + leitbild_plant_numerics::finite_surge::PRESSURE] -= 50.;
                y[m.layout.surge_start + leitbild_plant_numerics::finite_surge::TEMPERATURE] -=
                    0.01;
            }
            let seed = y.clone();
            let mut yp = vec![0.; m.dimension()];
            let mut w = m.workspace();
            let mut trace = Trace::default();
            let report = initialize(
                &m,
                &mut y,
                &mut yp,
                &absolute,
                &mut w,
                Instant::now(),
                10.,
                1e-6,
                &mut trace,
                None,
            )
            .unwrap();
            assert!(report.chart_iterations >= 1 && report.iterations <= 12);
            assert!(report.chart_correction_l2 <= cooling_convergence::NONLINEAR_COEFFICIENT);
            if perturb {
                assert_ne!(
                    y[m.layout.network_start + m.network.pressure_row()].to_bits(),
                    seed[m.layout.network_start + m.network.pressure_row()].to_bits()
                );
            }
            for r in 0..m.dimension() {
                if m.is_differential(r) {
                    assert_eq!(y[r].to_bits(), initial[r].to_bits(), "stock {r}");
                }
            }
            endpoints.push((y, yp));
        }
        let mut worst = (0., 0, false);
        for (r, rate) in m
            .fluid_rows()
            .map(|r| (r, m.is_differential(r)))
            .chain(m.forward_chart_rows().into_iter().map(|r| (r, true)))
        {
            let scale =
                super::super::state_error_scale(&m, r, endpoints[0].0[r], absolute[r], 1e-6);
            let difference = if rate {
                (endpoints[0].1[r] - endpoints[1].1[r]).abs() * OUTPUTS[0]
            } else {
                (endpoints[0].0[r] - endpoints[1].0[r]).abs()
            };
            if difference / scale > worst.0 {
                worst = (difference / scale, r, rate);
            }
            assert!(
                difference <= scale,
                "seed-sensitive row {r} rate={rate}: {difference}/{scale}"
            );
        }
        println!(
            "maximum tighter seed-difference ratio={} row={} rate={}",
            worst.0, worst.1, worst.2
        );
        let mut wrong = initial;
        wrong[m.layout.network_start + m.network.temperature_row(0)] = f64::NAN;
        assert!(
            initialize(
                &m,
                &mut wrong,
                &mut vec![0.; m.dimension()],
                &absolute,
                &mut m.workspace(),
                Instant::now(),
                10.,
                1e-6,
                &mut Trace::default(),
                None
            )
            .is_err()
        );
    }

    /// Explicit opt-in, initialization-only replay of a retained real physical
    /// payload. No time integrator, checkpoint overwrite or altered history.
    #[test]
    #[ignore = "requires LEITBILD_IC_INPUT retained physical payload"]
    fn retained_physical_preparation_initializes_without_advancement() {
        let text = std::fs::read_to_string(std::env::var("LEITBILD_IC_INPUT").unwrap()).unwrap();
        let p = super::super::cooling_input::parse(&text).unwrap();
        let m = &p.model;
        let schedule =
            super::super::cooling_actuation::Schedule::new(m, p.prhr_action, p.actuation.as_ref())
                .unwrap();
        let first_input = schedule
            .as_ref()
            .map(|s| s.input(0., 0.))
            .transpose()
            .unwrap();
        let accuracy =
            cooling_accuracy::Accuracy::new(m, &p.target_emissions, first_input).unwrap();
        let mut y = m.initial_state_with_prhr_input(first_input).unwrap();
        let initial = y.clone();
        let input = schedule
            .as_ref()
            .map(|s| s.input(0., y[s.room_row]))
            .transpose()
            .unwrap();
        let mut yp = vec![0.; m.dimension()];
        let mut w = m.workspace();
        m.evaluate_with_prhr_input(&y, &yp, None, &mut w, input)
            .unwrap();
        for r in 0..m.dimension() {
            if m.is_differential(r) {
                yp[r] = -w.residual[r];
            }
        }
        let mut trace = Trace::default();
        let result = initialize(
            m,
            &mut y,
            &mut yp,
            &accuracy.absolute(10.).unwrap(),
            &mut w,
            Instant::now(),
            30.,
            1e-6,
            &mut trace,
            input,
        );
        println!(
            "{{\"kind\":\"retained-tighter-initialization-only\",\"trace\":{},\"report\":{}}}",
            trace.json(),
            result.as_ref().map(|r| r.json()).unwrap_or("null".into())
        );
        let report = result.unwrap();
        assert!(
            report.iterations <= 12
                && report.chart_correction_l2 <= cooling_convergence::NONLINEAR_COEFFICIENT
                && report.correction_l2 <= cooling_convergence::NONLINEAR_COEFFICIENT
        );
        for r in 0..m.dimension() {
            if m.is_differential(r) {
                assert_eq!(y[r].to_bits(), initial[r].to_bits(), "stock {r}");
            }
        }
    }
    #[test]
    fn outer_newton_correction_uses_nonlinear_not_inner_linear_budget() {
        let m = super::super::cooling_fixture::fixture();
        let y = m.initial_state().unwrap();
        let row = m.layout.network_start + m.network.flow_row(0);
        let absolute = vec![1e-5; m.dimension()];
        let unknown = [(row, false)];
        let below = [0.30 * absolute[row]];
        let above = [0.34 * absolute[row]];
        let normal = correction_norm(&m, &y, &absolute, 1e-5, &unknown, &below)
            .unwrap()
            .0;
        let refused = correction_norm(&m, &y, &absolute, 1e-5, &unknown, &above)
            .unwrap()
            .0;
        assert!(normal > cooling_convergence::LINEAR_L2_BUDGET);
        assert!(normal < cooling_convergence::NONLINEAR_COEFFICIENT);
        assert!(refused > cooling_convergence::NONLINEAR_COEFFICIENT);
        let tighter = absolute.iter().map(|v| v / 10.).collect::<Vec<_>>();
        assert!(
            correction_norm(&m, &y, &tighter, 1e-6, &unknown, &below)
                .unwrap()
                .0
                > cooling_convergence::NONLINEAR_COEFFICIENT
        );
    }
    #[test]
    fn moving_initialization_includes_geometry_time_in_forward_charts_without_resetting_stocks() {
        use leitbild_plant_numerics::{absorber_guide, operating_network::WaterShape};
        let m = super::super::cooling_fixture::fixture_with_contrast();
        let accuracy =
            cooling_accuracy::Accuracy::new(&m, &vec![[0.; 2]; m.source.target_count()], None)
                .unwrap();
        let mut y = m.initial_state().unwrap();
        let original = y.clone();
        let mut yp = vec![0.; m.dimension()];
        let mut w = m.workspace();
        let source = m.source.prepared_geometry().clone();
        let mut time_source = source.zero_direction();
        let contacts = m.absorber_guide.geometry();
        let zero_contacts = contacts
            .iter()
            .map(|_| absorber_guide::ContactGeometry {
                area_m2: 0.,
                solid_geometry_m_inv: 0.,
                liquid_chord_m: 0.,
            })
            .collect::<Vec<_>>();
        let mobile = m.mobile_capture.geometry();
        let zero_mobile = mobile.zero_direction();
        let water = m
            .network
            .config()
            .water
            .iter()
            .enumerate()
            .map(|(i, c)| WaterShape {
                volume_m3: c.geometry.volume,
                first_moment_m4: c.geometry.volume * c.geometry.elevation,
                volume_rate_m3_s: if i == 0 {
                    1e-5
                } else if i == 1 {
                    -1e-5
                } else {
                    0.
                },
                first_moment_rate_m4_s: 0.,
            })
            .collect::<Vec<_>>();
        let time_water = water
            .iter()
            .map(|c| WaterShape {
                volume_m3: c.volume_rate_m3_s,
                first_moment_m4: c.first_moment_rate_m4_s,
                ..Default::default()
            })
            .collect::<Vec<_>>();
        for (d, c) in time_source
            .external_water_volumes
            .iter_mut()
            .zip(&time_water)
        {
            *d = c.volume_m3;
        }
        let zero_barrel = vec![0.; m.barrel.chords().len()];
        let moving = Moving {
            value: CurrentGeometry {
                source: &source,
                contacts,
                mobile,
                barrel_chords_m: m.barrel.chords(),
                network: MotionGeometry {
                    water: &water,
                    connections: &[],
                },
            },
            time: GeometryDirection {
                source: &time_source,
                contacts: &zero_contacts,
                mobile: &zero_mobile,
                barrel_chords_m: &zero_barrel,
                water: &time_water,
                connections: &[],
            },
        };
        initialize_with_geometry(
            &m,
            &mut y,
            &mut yp,
            &accuracy.absolute(1.).unwrap(),
            &mut w,
            Instant::now(),
            10.,
            1e-5,
            &mut Trace::default(),
            None,
            &moving,
        )
        .unwrap();
        for r in 0..m.dimension() {
            if m.is_differential(r) {
                assert_eq!(y[r].to_bits(), original[r].to_bits(), "stock {r}");
            }
        }
        // Independently observe the full composed direction in the test.
        // The initializer itself intentionally only evaluates the network.
        m.jvp_with_current_geometry(
            &vec![0.; m.dimension()],
            0.,
            &mut w,
            GeometryDirection {
                source: moving.time.source,
                contacts: moving.time.contacts,
                mobile: moving.time.mobile,
                barrel_chords_m: moving.time.barrel_chords_m,
                water: moving.time.water,
                connections: moving.time.connections,
            },
        )
        .unwrap();
        let forward = m.forward_chart_rows();
        let mut equations = HashMap::<usize, (f64, f64)>::new();
        for &r in &forward {
            equations.insert(r, (w.jvp[r], w.jvp[r].abs()));
        }
        m.visit_fluid_jacobian(&w, |r, c, v| {
            if let Some((sum, scale)) = equations.get_mut(&r) {
                *sum += v * yp[c];
                *scale += (v * yp[c]).abs();
            }
        })
        .unwrap();
        assert!(
            forward.iter().any(|&r| w.jvp[r] != 0.),
            "A nonzero physical geometry-time term must be exercised"
        );
        for (r, (sum, scale)) in equations {
            assert!(
                sum.abs() <= 1e-7 * scale.max(1.),
                "moving forward chart {r}: {sum}/{scale}"
            );
        }
    }
    #[test]
    fn huge_carrier_inventory_uses_current_production_scale_and_true_refinement() {
        let m = super::super::cooling_fixture::fixture_with_contrast();
        let mut y = m.initial_state().unwrap();
        let l = m.layout;
        let rows = m
            .fluid_rows()
            .map(|r| (r, m.is_differential(r)))
            .collect::<Vec<_>>();
        let mut delta = vec![0.; rows.len()];
        let r = l.carrier_start + 1;
        let i = rows.iter().position(|&(row, _)| row == r).unwrap();
        y[r] = 9.455372243888917e26;
        delta[i] = 8_417_351.;
        let a = vec![0.001; m.dimension()];
        let (normal, _) = correction_norm(&m, &y, &a, 1e-5, &rows, &delta).unwrap();
        let (old, _) = correction_norm(&m, &y, &a, 0., &rows, &delta).unwrap();
        assert!(normal < cooling_convergence::LINEAR_L2_BUDGET && old > 1e6);
        let tight = a.iter().map(|v| v / 10.).collect::<Vec<_>>();
        let (reference, _) = correction_norm(&m, &y, &tight, 1e-6, &rows, &delta).unwrap();
        assert!((reference / normal - 10.).abs() < 1e-13);
        for r in [
            l.network_start + m.network.pressure_row(),
            l.network_start + m.network.temperature_row(0),
            l.network_start + m.network.energy_row(0),
            l.surge_start + leitbild_plant_numerics::finite_surge::PRESSURE,
        ] {
            assert_eq!(
                super::super::state_error_scale(&m, r, 1e27, a[r], 1e-5),
                a[r]
            );
        }
        y[r] = f64::INFINITY;
        assert!(correction_norm(&m, &y, &a, 1e-5, &rows, &delta).is_err());
    }
    #[test]
    fn joint_initialization_closes_both_refinements_without_changing_stocks() {
        let m = super::super::cooling_fixture::fixture_with_contrast();
        let accuracy =
            cooling_accuracy::Accuracy::new(&m, &vec![[0.; 2]; m.source.target_count()], None)
                .unwrap();
        let initial = m.initial_state().unwrap();
        for refinement in [1., 10.] {
            let mut y = initial.clone();
            let mut yp = vec![0.; m.dimension()];
            let mut w = m.workspace();
            let mut trace = Trace::default();
            let result = initialize(
                &m,
                &mut y,
                &mut yp,
                &accuracy.absolute(refinement).unwrap(),
                &mut w,
                Instant::now(),
                10.,
                1e-5 / refinement,
                &mut trace,
                None,
            )
            .unwrap();
            assert!(
                result.iterations <= 12
                    && result.correction_l2 <= cooling_convergence::NONLINEAR_COEFFICIENT
            );
            assert!(!trace.0.is_empty());
            for r in 0..m.dimension() {
                if m.is_differential(r) {
                    assert_eq!(y[r].to_bits(), initial[r].to_bits());
                }
            }
        }
    }
    #[test]
    fn joint_initial_rates_preserve_stocks_and_close_owned_forward_charts() {
        let m = super::super::cooling_fixture::fixture_with_contrast();
        let accuracy =
            cooling_accuracy::Accuracy::new(&m, &vec![[0.; 2]; m.source.target_count()], None)
                .unwrap();
        let mut y = m.initial_state().unwrap();
        let initial = y.clone();
        let mut yp = vec![0.; m.dimension()];
        let mut w = m.workspace();
        let report = initialize(
            &m,
            &mut y,
            &mut yp,
            &accuracy.absolute(1.).unwrap(),
            &mut w,
            Instant::now(),
            10.,
            1e-5,
            &mut Trace::default(),
            None,
        )
        .unwrap();
        assert!(
            report.iterations <= 12
                && report.correction_l2 <= cooling_convergence::NONLINEAR_COEFFICIENT
        );
        for r in 0..m.dimension() {
            if m.is_differential(r) {
                assert_eq!(y[r].to_bits(), initial[r].to_bits(), "stock {r}");
            }
        }
        let forward = m
            .forward_chart_rows()
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let mut values = HashMap::<usize, (f64, f64)>::new();
        m.visit_fluid_jacobian(&w, |r, c, v| {
            if forward.contains(&r) {
                let entry = values.entry(r).or_default();
                entry.0 += v * yp[c];
                entry.1 += (v * yp[c]).abs();
            }
        })
        .unwrap();
        for (r, (value, scale)) in values {
            assert!(
                value.abs() <= 1e-7 * scale.max(1.),
                "forward row{r}: {value:e}/{scale:e}"
            );
        }
        // A second completion is the same fixed-stock problem, not a
        // reseeded pressure/energy preparation.
        let again = initialize(
            &m,
            &mut y,
            &mut yp,
            &accuracy.absolute(1.).unwrap(),
            &mut w,
            Instant::now(),
            10.,
            1e-5,
            &mut Trace::default(),
            None,
        )
        .unwrap();
        assert_eq!(again.chart_iterations, 1);
        assert_eq!(again.iterations, 2);
    }
    #[test]
    fn malformed_inputs_and_expired_initial_budget_refuse() {
        let m = super::super::cooling_fixture::fixture();
        let mut y = m.initial_state().unwrap();
        let mut yp = vec![0.; m.dimension()];
        let mut w = m.workspace();
        assert!(
            initialize(
                &m,
                &mut y,
                &mut yp,
                &[],
                &mut w,
                Instant::now(),
                10.,
                1e-5,
                &mut Trace::default(),
                None
            )
            .is_err()
        );
        assert!(
            initialize(
                &m,
                &mut y,
                &mut yp,
                &vec![1.; m.dimension()],
                &mut w,
                Instant::now(),
                0.,
                1e-5,
                &mut Trace::default(),
                None
            )
            .is_err()
        );
    }
}

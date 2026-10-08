//! Joint fixed-stock initialization of the current fluid DAE and its forward
//! thermodynamic chart rates. No alternating integrator IC calls or flash.
use super::{cooling_accuracy, cooling_block::Sparse, cooling_convergence, recoverable, OUTPUTS};
use leitbild_plant_numerics::{
    operating_admission,
    source_cooling::{Model, Workspace},
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
    pub seconds: f64,
    pub correction_l2: f64,
    pub max_forward_rate_residual: f64,
}
impl Report {
    pub fn json(&self) -> String {
        format!(
            "{{\"scope\":\"joint-current-fluid-F-and-differentiated-forward-charts;fixed-differential-stocks;held-forcing-inexact-Newton\",\"correctionScales\":\"same-current-per-row-production-scales\",\"iterations\":{},\"seconds\":{},\"lastWeightedCorrectionL2\":{},\"maxForwardRateResidualMixedUnits\":{},\"rateCorrectionTimeScaleSeconds\":{}}}",
            self.iterations,
            self.seconds,
            self.correction_l2,
            self.max_forward_rate_residual,
            OUTPUTS[0]
        )
    }
}
fn prepare(
    model: &Model,
    y: &[f64],
    yp: &mut [f64],
    work: &mut Workspace,
    prhr_input: Option<leitbild_plant_numerics::prhr::Input>,
) -> Result<(), String> {
    model.evaluate_with_prhr_input(y, yp, None, work, prhr_input)?;
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
    model.evaluate_with_prhr_input(y, yp, Some(0.), work, prhr_input)
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
    let rows = model.fluid_rows().collect::<Vec<_>>();
    let forward = model.forward_chart_rows();
    let physical = rows
        .iter()
        .enumerate()
        .map(|(i, &r)| (r, i))
        .collect::<HashMap<_, _>>();
    let mut unknown = rows
        .iter()
        .map(|&r| (r, model.is_differential(r)))
        .collect::<Vec<_>>();
    if forward
        .iter()
        .any(|r| !physical.contains_key(r) || model.is_differential(*r))
    {
        return Err("Invalid forward initialization chart metadata".into());
    }
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
    prepare(model, y, yp, work, prhr_input)?;
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
    for iteration in 1..=12 {
        if start.elapsed().as_secs_f64() >= allowance {
            return Err("Joint initialization wall allowance exhausted".into());
        }
        prepare(model, y, yp, work, prhr_input)?;
        matrix.clear();
        rhs.fill(0.);
        for (i, &r) in rows.iter().enumerate() {
            rhs[i] = -work.residual[r];
        }
        let mut error = None;
        model.visit_fluid_jacobian(work, |r, c, v| {
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
            "{{\"iteration\":{iteration},\"weightedCorrectionL2\":{norm},\"absoluteOnlyCorrectionL2Diagnostic\":{absolute_norm},\"worstCorrectionRow\":{row},\"rateCorrection\":{rate},\"correction\":{},\"absoluteScale\":{},\"currentProductionScale\":{},\"currentState\":{},\"currentRate\":{},\"maxPhysicalResidualRow\":{physical_worst},\"maxPhysicalResidualMixedUnits\":{},\"maxForwardRateResidualRow\":{},\"maxForwardRateResidualMixedUnits\":{forward_residual},\"maxLinearBackwardError\":{backward_error},\"linearBackwardErrorAbsolute\":{backward_absolute},\"linearBackwardErrorContributorSum\":{backward_scale},\"linearBackwardErrorRHS\":{},\"linearBackwardErrorEquationRow\":{equation_row},\"linearBackwardErrorDifferentiatedChart\":{}}}",
            delta[worst], absolute[row], super::state_error_scale(model,row,y[row],absolute[row],relative), y[row], yp[row], work.residual[physical_worst], forward[forward_worst], rhs[linear_row], linear_row >= rows.len()
        ));
        if norm <= cooling_convergence::LINEAR_L2_BUDGET {
            let l = model.layout;
            operating_admission::chart_corrections(
                &model.network,
                &work.network,
                &y[l.network_start..l.carrier_start],
            )?
            .check()?;
            let mut pool = model.pressure_connection().pressurizer.workspace();
            let mut line = model.pressure_connection().surge.workspace();
            let (p, s) =
                model.pressure_chart_corrections(&work.network, y, yp, &mut pool, &mut line)?;
            let head = cooling_accuracy::pressure_level_head_scale(model, y, &pool)?;
            cooling_accuracy::check_pressure_chart(model, &p, &s, head)?;
            if cooling_convergence::pressure_caloric_ratio(model, y, &pool, &line)? > 1. {
                return Err("Initial pressure metal caloric chart refused".into());
            }
            if cooling_convergence::pressure_flow_ratio(model, &line)? > 1. {
                return Err("Initial pressure hydraulic closure refused".into());
            }
            model.validate_accepted(y, work)?;
            for r in 0..n {
                if model.is_differential(r) && y[r].to_bits() != initial[r].to_bits() {
                    return Err(format!(
                        "Joint initialization changed differential stock {r}"
                    ));
                }
            }
            return Ok(Report {
                iterations: iteration,
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
            match model.evaluate_with_prhr_input(&trial_y, &trial_yp, None, work, prhr_input) {
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
                    && result.correction_l2 <= cooling_convergence::LINEAR_L2_BUDGET
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
                && report.correction_l2 <= cooling_convergence::LINEAR_L2_BUDGET
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
        assert_eq!(again.iterations, 1);
    }
    #[test]
    fn malformed_inputs_and_expired_initial_budget_refuse() {
        let m = super::super::cooling_fixture::fixture();
        let mut y = m.initial_state().unwrap();
        let mut yp = vec![0.; m.dimension()];
        let mut w = m.workspace();
        assert!(initialize(
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
        .is_err());
        assert!(initialize(
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
        .is_err());
    }
}

//! Strict numeric fresh-original offline operating-network qualification.
//! No live plant, source/PZR/secondary/rotor/control/event implementation.
mod ida_support;
mod operating_network_audit;
mod operating_network_input;
use ida_support::*;
use leitbild_plant_numerics::operating_network::*;
use std::{
    ffi::c_int,
    io::{self, Read},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    time::Instant,
};
unsafe extern "C" {
    fn IDAGetLastStep(memory: Handle, value: *mut f64) -> c_int;
    fn IDAGetCurrentStep(memory: Handle, value: *mut f64) -> c_int;
    fn IDAGetActualInitStep(memory: Handle, value: *mut f64) -> c_int;
    fn IDAGetCurrentOrder(memory: Handle, value: *mut c_int) -> c_int;
    fn IDAGetCurrentCj(memory: Handle, value: *mut f64) -> c_int;
}

struct Work {
    network: Network,
    workspace: Workspace,
    started: Instant,
    budget: f64,
    residuals: u64,
    jacobians: u64,
    property_requests: u64,
    failures: u64,
    last_error: Option<String>,
    budget_exhausted: bool,
    admitted_time: f64,
    max_reynolds: f64,
    max_reynolds_edge: usize,
    audit_enabled: bool,
    last_jacobian_state: Option<(Vec<f64>, Vec<f64>, f64)>,
}
impl Work {
    fn evaluate(&mut self, y: &[f64], yp: &[f64], cj: Option<f64>) -> Result<(), String> {
        if self.started.elapsed().as_secs_f64() >= self.budget {
            self.budget_exhausted = true;
            return Err("Declared aggregate numerical allowance exhausted".into());
        }
        let result = self.workspace.evaluate(&self.network, y, yp, cj);
        self.property_requests += self.workspace.property_requests as u64;
        result
    }
}
fn vector<'a>(v: Handle, n: usize) -> Result<&'a [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Network callback vector shape".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null network callback vector".into());
    }
    Ok(unsafe { std::slice::from_raw_parts(p, n) })
}
fn callback(user: Handle, jac: bool, f: impl FnOnce(&mut Work) -> Result<(), String>) -> c_int {
    if user.is_null() {
        return -1;
    }
    let w = unsafe { &mut *user.cast::<Work>() };
    if jac {
        w.jacobians += 1;
    } else {
        w.residuals += 1;
    }
    match catch_unwind(AssertUnwindSafe(|| f(w))) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            w.failures += 1;
            w.last_error = Some(e);
            if w.budget_exhausted { -1 } else { 1 }
        }
        Err(_) => {
            w.failures += 1;
            w.last_error = Some("Panic contained at native solver boundary".into());
            -1
        }
    }
}
unsafe extern "C" fn residual(_t: f64, y: Handle, yp: Handle, out: Handle, user: Handle) -> c_int {
    callback(user, false, |w| {
        let n = w.network.dimension();
        w.evaluate(vector(y, n)?, vector(yp, n)?, None)?;
        if out.is_null() || unsafe { N_VGetLength_Serial(out) } != n as i64 {
            return Err("Residual output shape".into());
        }
        let p = unsafe { N_VGetArrayPointer_Serial(out) };
        if p.is_null() {
            return Err("Null residual output".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(w.workspace.residual.as_ptr(), p, n);
        }
        Ok(())
    })
}
unsafe extern "C" fn jacobian(
    _t: f64,
    cj: f64,
    y: Handle,
    yp: Handle,
    _rr: Handle,
    matrix: Handle,
    user: Handle,
    _a: Handle,
    _b: Handle,
    _c: Handle,
) -> c_int {
    callback(user, true, |w| {
        let n = w.network.dimension();
        let state = vector(y, n)?;
        let rates = vector(yp, n)?;
        w.evaluate(state, rates, Some(cj))?;
        if w.audit_enabled {
            w.last_jacobian_state = Some((state.to_vec(), rates.to_vec(), cj));
        }
        matrix_data(
            matrix,
            &w.network.column_pointers,
            &w.network.row_indices,
            &w.workspace.jacobian_values,
        )
    })
}
fn get(jac: &Workspace, n: &Network, row: usize, col: usize) -> f64 {
    let a = n.column_pointers[col] as usize;
    let b = n.column_pointers[col + 1] as usize;
    n.row_indices[a..b]
        .binary_search(&(row as i64))
        .map(|j| jac.jacobian_values[a + j])
        .unwrap_or(0.)
}
fn original_slopes(work: &mut Work, y: &[f64]) -> Result<Vec<f64>, String> {
    let mut yp = vec![0.; y.len()];
    work.evaluate(y, &yp, Some(0.))?;
    yp.copy_from_slice(&work.workspace.rates);
    for i in 0..work.network.config().water.len() {
        let mp = -get(&work.workspace, &work.network, 5 * i + 3, 5 * i + 3);
        let mt = -get(&work.workspace, &work.network, 5 * i + 3, 5 * i + 4);
        let ep = -get(&work.workspace, &work.network, 5 * i + 4, 5 * i + 3);
        let et = -get(&work.workspace, &work.network, 5 * i + 4, 5 * i + 4);
        let determinant = mp * et - mt * ep;
        if determinant <= 0. || !determinant.is_finite() {
            return Err(format!("Original chart rank at node {i}"));
        }
        yp[5 * i + 3] = (yp[5 * i] * et - mt * yp[5 * i + 1]) / determinant;
        yp[5 * i + 4] = (mp * yp[5 * i + 1] - yp[5 * i] * ep) / determinant;
    }
    // Passage qdot is now an actual differential rate from finite L/A inertia,
    // already copied from workspace.rates. Never differentiate an instantaneous
    // inverse loss law, or zero a physical momentum rate in the predictor.
    work.evaluate(y, &yp, None)?;
    if work
        .workspace
        .residual
        .iter()
        .any(|x| !x.is_finite() || x.abs() > 1e-5)
    {
        return Err("Original residual consistency refused".into());
    }
    Ok(yp)
}
// Algebraic derivatives are not arguments of this residual. Retain the exact
// differentiated physical tangent above, but do not extrapolate that tangent
// as if it were a finite stock in the first nonlinear predictor. IDA corrects
// all algebraic coordinates and continues to control their temporal errors.
fn predictor_slopes(physical: &[f64], id: &[f64]) -> Vec<f64> {
    physical
        .iter()
        .zip(id)
        .map(|(&rate, &kind)| if kind == 1. { rate } else { 0. })
        .collect()
}
fn weighted_rate_norm(rates: &[f64], atol: &[f64]) -> f64 {
    (rates
        .iter()
        .zip(atol)
        .map(|(rate, weight)| (rate / weight).powi(2))
        .sum::<f64>()
        / rates.len() as f64)
        .sqrt()
}
// A diagonal, fixed-head proxy is useful telemetry, not a bound on a
// correction in the coupled pressure/flow system. Never use its magnitude as
// an independent admission criterion or alter physical weights to satisfy it.
fn held_head_ratio(defect: f64, diagonal: f64, atol: f64) -> Result<f64, String> {
    let band = diagonal * atol;
    if !defect.is_finite() || !band.is_finite() || band <= 0. {
        return Err("Unresolvable hydraulic diagnostic band".into());
    }
    Ok(defect.abs() / band)
}
#[cfg(test)]
mod predictor_tests {
    use super::*;
    #[test]
    fn algebraic_seed_preserves_stock_and_flow_rates_without_mutating_physical_tangent() {
        let physical = vec![2., 3., 4., 1e12, -1e10, 5., 7.];
        let id = vec![1., 1., 1., 0., 0., 1., 1.];
        let seed = predictor_slopes(&physical, &id);
        assert_eq!(seed, vec![2., 3., 4., 0., 0., 5., 7.]);
        assert_eq!(physical[3], 1e12);
        assert_eq!(
            weighted_rate_norm(&seed, &vec![1.; 7]),
            (103_f64 / 7.).sqrt()
        );
    }
    #[test]
    fn held_head_proxy_is_not_a_coupled_correction_bound() {
        // J=[[1,100],[0,1]], actual correction=[.1,.01], unit weights.
        // J*correction=[1.1,.01]: holding the second coordinate fixed would
        // falsely reject the first, despite both coupled corrections < 1.
        let correction = [0.1, 0.01];
        let residual = correction[0] + 100. * correction[1];
        assert!(held_head_ratio(residual, 1., 1.).unwrap() > 1.);
        assert!(correction.into_iter().all(|v| v < 1.));
        assert!(held_head_ratio(f64::NAN, 1., 1.).is_err());
        assert!(held_head_ratio(1., 0., 1.).is_err());
    }
}
fn totals(n: &Network, y: &[f64]) -> [f64; 3] {
    let nw = n.config().water.len();
    [
        (0..nw).map(|i| y[5 * i]).sum(),
        (0..nw + n.config().solids.len())
            .map(|i| y[n.energy_row(i)])
            .sum(),
        (0..nw).map(|i| y[5 * i + 2]).sum(),
    ]
}
#[derive(Clone)]
struct Sample {
    time: f64,
    y: Vec<f64>,
    temperatures: Vec<f64>,
    flows: Vec<f64>,
    heat: Vec<f64>,
}
struct Receipt {
    samples: Vec<Sample>,
    elapsed: f64,
    steps: i64,
    residuals: u64,
    jacobians: u64,
    property_requests: u64,
    failures: u64,
    error_fails: i64,
    nonlinear_fails: i64,
    max_ledgers: [f64; 3],
    max_chart: [f64; 2],
    max_flow_law_residual: f64,
    max_held_head_ratio: f64,
    max_head_roundoff_to_flow_band: f64,
    flow_atol: Vec<f64>,
    flow_contrast: f64,
    initial_rate_norms: [f64; 2],
    max_speed: f64,
    max_kinetic_temperature: f64,
    max_dynamic_head: f64,
    max_omitted_kinetic_energy: f64,
    max_reynolds: f64,
    max_reynolds_edge: usize,
    solid_energy_change: f64,
    nnz: usize,
    n: usize,
}
fn screen(
    work: &mut Work,
    y: &[f64],
    yp: &[f64],
    cj: f64,
    initial: &[f64],
    max_ledgers: &mut [f64; 3],
    max_chart: &mut [f64; 2],
    flow_atol: &[f64],
    max_flow_law_residual: &mut f64,
    max_held_head_ratio: &mut f64,
    max_head_roundoff_to_flow_band: &mut f64,
    speed: &mut f64,
    kinetic_temperature: &mut f64,
    dynamic_head: &mut f64,
    omitted_kinetic_energy: &mut f64,
) -> Result<(), String> {
    // Admission needs the chart tangent, not a complete transport Jacobian.
    // Reuse its analytic thermodynamic primitive and avoid extra film/property
    // derivative probes at every accepted internal step.
    work.evaluate(y, yp, None)?;
    let total = totals(&work.network, y);
    let total0 = totals(&work.network, initial);
    for i in 0..3 {
        max_ledgers[i] = max_ledgers[i].max((total[i] - total0[i]).abs());
    }
    if max_ledgers[0] > 1e-6 || max_ledgers[1] > 1. || max_ledgers[2] > 1e-8 {
        return Err(format!("Closed stock ledger refused: {max_ledgers:?}"));
    }
    for i in 0..work.network.config().water.len() {
        let mut water = work.workspace.liquids[i];
        water.pressure = y[5 * i + 3];
        water.temperature = y[5 * i + 4];
        let chart = leitbild_plant_numerics::storage_jacobian(
            work.network.config().water[i].geometry,
            water,
            0.,
            0.,
        )?;
        let (mp, mt, ep, et) = (
            chart.mass_pressure,
            chart.mass_temperature,
            chart.energy_pressure,
            chart.energy_temperature,
        );
        let dm = work.workspace.residual[5 * i + 3];
        let de = work.workspace.residual[5 * i + 4];
        let det = mp * et - mt * ep;
        if !det.is_finite() || det <= 0. {
            return Err(format!("Returned state chart rank node {i}"));
        }
        let correction = [(dm * et - mt * de) / det, (mp * de - dm * ep) / det];
        for j in 0..2 {
            max_chart[j] = max_chart[j].max(correction[j].abs());
        }
        if correction[0].abs() > 5. || correction[1].abs() > 1e-4 {
            return Err(format!(
                "Returned state chart correction node {i}: {correction:?}"
            ));
        }
    }
    let mut kinetic_estimate = 0.;
    for (edge, (e, q)) in work
        .network
        .config()
        .hydraulic
        .iter()
        .zip(&work.workspace.mass_flows)
        .enumerate()
    {
        let rho =
            (work.workspace.liquids[e.from].density + work.workspace.liquids[e.to].density) * 0.5;
        let v = q.abs() / (rho * e.flow_area);
        let mu = (work.workspace.liquids[e.from].viscosity
            + work.workspace.liquids[e.to].viscosity)
            * 0.5;
        let re = q.abs() * e.diameter / (e.flow_area * mu);
        let head = rho
            * 9.80665
            * (work.network.config().water[e.to].geometry.elevation
                - work.network.config().water[e.from].geometry.elevation);
        let drive = y[5 * e.from + 3] - y[5 * e.to + 3] - head;
        // Explicit floating-point arithmetic allowance, NOT constitutive/model
        // error or a floor in Pa. The receipt exposes arithmetic-limited bands.
        let noise =
            8. * f64::EPSILON * (y[5 * e.from + 3].abs() + y[5 * e.to + 3].abs() + head.abs());
        let loss = e.pressure_loss(*q, rho, mu);
        let inertance = e.length / e.flow_area;
        let defect = inertance * yp[work.network.flow_row(edge)] - drive + loss[0];
        // Diagnostic local, held-endpoint-head Newton-equivalent q correction
        // at the accepted stage cj. NOT a coupled or temporal error bound.
        // The old static loss(q +/- atol) bracket is invalid during acceleration.
        let band = (inertance * cj + loss[1]) * flow_atol[edge];
        *max_held_head_ratio = max_held_head_ratio.max(held_head_ratio(
            defect,
            inertance * cj + loss[1],
            flow_atol[edge],
        )?);
        *max_head_roundoff_to_flow_band = max_head_roundoff_to_flow_band.max(noise / band);
        *max_flow_law_residual = max_flow_law_residual.max(defect.abs());
        if re > work.max_reynolds {
            work.max_reynolds = re;
            work.max_reynolds_edge = edge;
        }
        *speed = speed.max(v);
        let cp = work.workspace.liquids[e.from]
            .cp
            .min(work.workspace.liquids[e.to].cp);
        *kinetic_temperature = kinetic_temperature.max(v * v / (2. * cp));
        *dynamic_head = dynamic_head.max(rho * v * v / 2.);
        kinetic_estimate += inertance * q * q / (2. * rho);
    }
    *omitted_kinetic_energy = omitted_kinetic_energy.max(kinetic_estimate);
    // Prospective cold-reduction premises, using existing internal thermal
    // and pressure scales. These are not full-fluid mechanical fidelity claims.
    if *kinetic_temperature > 1e-3 || *dynamic_head > 100. {
        return Err(format!(
            "Cold momentum/energy approximation exceeded: K/cp={kinetic_temperature}, dynamic head={dynamic_head}"
        ));
    }
    Ok(())
}
fn run(
    config: Config,
    horizon: f64,
    began: Instant,
    budget: f64,
    factor: f64,
) -> Result<Receipt, String> {
    let run_started = Instant::now();
    let network = Network::new(config)?;
    let n = network.dimension();
    let initial = network.initial_state()?;
    let nw = network.config().water.len();
    let ns = network.config().solids.len();
    let mut work = Box::new(Work {
        workspace: Workspace::new(&network),
        network,
        started: began,
        budget,
        residuals: 0,
        jacobians: 0,
        property_requests: nw as u64,
        failures: 0,
        last_error: None,
        budget_exhausted: false,
        admitted_time: 0.,
        max_reynolds: 0.,
        max_reynolds_edge: 0,
        audit_enabled: std::env::args().any(|a| a == "--audit"),
        last_jacobian_state: None,
    });
    let slopes = original_slopes(&mut work, &initial)?;
    let id: Vec<f64> = (0..n)
        .map(|row| {
            if work.network.is_differential(row) {
                1.
            } else {
                0.
            }
        })
        .collect();
    let mut atol = vec![0.; n];
    for i in 0..nw {
        atol[5 * i] = 1e-5 * factor;
        atol[5 * i + 1] = initial[5 * i] * work.workspace.liquids[i].cp * 1e-3 * factor;
        atol[5 * i + 2] = 1e-8 * factor;
        atol[5 * i + 3] = 100. * factor;
        atol[5 * i + 4] = 1e-3 * factor;
    }
    for i in 0..ns {
        atol[5 * nw + i] = work.network.config().solids[i].heat_capacity * 1e-3 * factor;
    }
    // Fixed prospective q weights, allocated across actual incident edges from
    // the existing 1 mK internal thermal weight over the requested horizon.
    // Relative enthalpy/elevation and finite metal/fluid contrasts avoid a
    // dependence on the arbitrary energy datum. This is engineering weighting,
    // not a rigorous propagated-error bound; actual paired gates remain decisive.
    let temperatures: Vec<f64> = (0..nw + ns)
        .map(|i| work.network.temperature(i, &initial))
        .collect();
    let tmin = temperatures.iter().copied().fold(f64::INFINITY, f64::min);
    let tmax = temperatures
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let max_cp = work
        .workspace
        .liquids
        .iter()
        .map(|l| l.cp)
        .fold(0_f64, f64::max);
    let heads: Vec<f64> = (0..nw)
        .map(|i| {
            work.workspace.liquids[i].enthalpy
                + 9.80665 * work.network.config().water[i].geometry.elevation
        })
        .collect();
    let flow_contrast = max_cp * (tmax - tmin)
        + heads.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - heads.iter().copied().fold(f64::INFINITY, f64::min);
    if !flow_contrast.is_finite() || flow_contrast <= 0. {
        return Err("Flow weighting requires the declared finite thermal contrast".into());
    }
    let mut degrees = vec![0_usize; nw];
    for edge in &work.network.config().hydraulic {
        degrees[edge.from] += 1;
        degrees[edge.to] += 1;
    }
    let flow_atol: Vec<f64> = work
        .network
        .config()
        .hydraulic
        .iter()
        .map(|edge| {
            [edge.from, edge.to]
                .iter()
                .map(|&i| {
                    initial[5 * i] * work.workspace.liquids[i].cp * 1e-3 * factor
                        / (horizon * degrees[i] as f64 * flow_contrast)
                })
                .fold(f64::INFINITY, f64::min)
        })
        .collect();
    for (edge, &weight) in flow_atol.iter().enumerate() {
        if !weight.is_finite() || weight <= 0. {
            return Err("Invalid hydraulic error weight".into());
        }
        let row = work.network.flow_row(edge);
        atol[row] = weight;
    }
    let seed_slopes = predictor_slopes(&slopes, &id);
    let initial_rate_norms = [
        weighted_rate_norm(&slopes, &atol),
        weighted_rate_norm(&seed_slopes, &atol),
    ];
    // Prove the numerical seed has not changed any physical initial equation.
    let physical_residual = work.workspace.residual.clone();
    work.evaluate(&initial, &seed_slopes, None)?;
    if work.workspace.residual != physical_residual {
        return Err("Algebraic predictor seed changed the physical initial residual".into());
    }
    // Immutable runner receipts retain stderr on success and failure. The
    // first requested observation is one second; this reproduces pinned IDA's
    // automatic min(.001*tdist, .5/WRMS) estimate without setting a solver knob.
    eprintln!(
        "{{\"scope\":\"original-operating-network-initialization\",\"meaning\":\"physical tangent versus residual-consistent first predictor; no change to y0, equations or error weights\",\"physicalWRMSRate_per_s\":{},\"predictorWRMSRate_per_s\":{},\"physicalDefaultStepEstimate_s\":{},\"predictorDefaultStepEstimate_s\":{},\"physicalDerivative\":{slopes:?},\"predictorDerivative\":{seed_slopes:?}}}",
        initial_rate_norms[0],
        initial_rate_norms[1],
        (0.5 / initial_rate_norms[0]).min(0.001),
        (0.5 / initial_rate_norms[1]).min(0.001)
    );
    let mut resources = Resources::new()?;
    let y = resources.vector(&initial)?;
    let yp = resources.vector(&seed_slopes)?;
    let id_vector = resources.vector(&id)?;
    let tolerance = resources.vector(&atol)?;
    let matrix = resources.matrix(n as i64, work.network.row_indices.len() as i64)?;
    let linear = resources.solver(y)?;
    resources.ida = unsafe { IDACreate(resources.context) };
    if resources.ida.is_null() {
        return Err("Actual IDA constructor failed".into());
    }
    checked(
        unsafe { IDAInit(resources.ida, residual, 0., y, yp) },
        "Network IDA init",
    )?;
    checked(
        unsafe { IDASetUserData(resources.ida, (&mut *work as *mut Work).cast()) },
        "Network IDA data",
    )?;
    checked(
        unsafe { IDASetId(resources.ida, id_vector) },
        "Network IDA differential ids",
    )?;
    checked(
        unsafe { IDASVtolerances(resources.ida, 0., tolerance) },
        "Network physical weights",
    )?;
    checked(
        unsafe { IDASetLinearSolver(resources.ida, linear, matrix) },
        "Network sparse KLU",
    )?;
    checked(
        unsafe { IDASetJacFn(resources.ida, jacobian) },
        "Network local matrix",
    )?;
    let mut samples = vec![];
    let mut max_ledgers = [0.; 3];
    let mut max_chart = [0.; 2];
    let mut max_flow_law_residual = 0.;
    let mut max_held_head_ratio = 0.;
    let mut max_head_roundoff_to_flow_band = 0.;
    let mut max_speed = 0.;
    let mut max_kinetic_temperature = 0.;
    let mut max_dynamic_head = 0.;
    let mut max_omitted_kinetic_energy = 0.;
    let mut sample = |time: f64,
                      state: &[f64],
                      rates: &[f64],
                      cj: f64,
                      observation: bool,
                      work: &mut Work|
     -> Result<(), String> {
        screen(
            work,
            state,
            rates,
            cj,
            &initial,
            &mut max_ledgers,
            &mut max_chart,
            &flow_atol,
            &mut max_flow_law_residual,
            &mut max_held_head_ratio,
            &mut max_head_roundoff_to_flow_band,
            &mut max_speed,
            &mut max_kinetic_temperature,
            &mut max_dynamic_head,
            &mut max_omitted_kinetic_energy,
        )?;
        if observation {
            samples.push(Sample {
                time,
                temperatures: (0..nw + ns)
                    .map(|i| work.network.temperature(i, state))
                    .collect(),
                flows: work.workspace.mass_flows.clone(),
                heat: work.workspace.heat_flows.clone(),
                y: state.to_vec(),
            });
        }
        Ok(())
    };
    sample(0., &initial, &slopes, 0., true, &mut work)?;
    // Preserve IDA history and screen EACH accepted internal step, not just
    // one-second observations that could alias inertial peaks. The existing
    // default 500-step allowance per observation remains an explicit guard
    // because ONE_STEP calls otherwise bypass NORMAL's per-call limit.
    for second in 1..=horizon as usize {
        let target = second as f64;
        checked(
            unsafe { IDASetStopTime(resources.ida, target) },
            "Network diagnostic stop",
        )?;
        let mut observation_steps = 0;
        loop {
            if observation_steps >= 500 {
                return Err(format!(
                    "Existing 500-step observation allowance exhausted at last admitted {} s",
                    work.admitted_time
                ));
            }
            let mut returned = 0.;
            let status = unsafe { IDASolve(resources.ida, target, &mut returned, y, yp, 2) };
            if status < 0 {
                let mut steps = 0;
                let mut error_fails = 0;
                let mut nonlinear_fails = 0;
                let mut nonlinear_iterations = 0;
                let mut hlast = 0.;
                let mut hcurrent = 0.;
                let mut hinitial = 0.;
                let mut order = 0;
                let mut cj = 0.;
                checked(
                    unsafe { IDAGetNumSteps(resources.ida, &mut steps) },
                    "Failure steps",
                )?;
                checked(
                    unsafe { IDAGetNumErrTestFails(resources.ida, &mut error_fails) },
                    "Failure error tests",
                )?;
                checked(
                    unsafe { IDAGetNumNonlinSolvConvFails(resources.ida, &mut nonlinear_fails) },
                    "Failure nonlinear failures",
                )?;
                checked(
                    unsafe { IDAGetNumNonlinSolvIters(resources.ida, &mut nonlinear_iterations) },
                    "Failure nonlinear iterations",
                )?;
                checked(
                    unsafe { IDAGetLastStep(resources.ida, &mut hlast) },
                    "Failure last step",
                )?;
                checked(
                    unsafe { IDAGetCurrentStep(resources.ida, &mut hcurrent) },
                    "Failure current step",
                )?;
                checked(
                    unsafe { IDAGetActualInitStep(resources.ida, &mut hinitial) },
                    "Failure actual initial step",
                )?;
                checked(
                    unsafe { IDAGetCurrentOrder(resources.ida, &mut order) },
                    "Failure current order",
                )?;
                checked(
                    unsafe { IDAGetCurrentCj(resources.ida, &mut cj) },
                    "Failure current cj",
                )?;
                let state = vector(y, n)?.to_vec();
                let rates = vector(yp, n)?.to_vec();
                if work.audit_enabled {
                    operating_network_audit::audit(
                        &work.network,
                        &initial,
                        &slopes,
                        cj,
                        &atol,
                        "original",
                    )?;
                    operating_network_audit::audit(
                        &work.network,
                        &state,
                        &rates,
                        cj,
                        &atol,
                        "failure-returned",
                    )?;
                    if let Some((jy, jyp, jcj)) = &work.last_jacobian_state {
                        operating_network_audit::audit(
                            &work.network,
                            jy,
                            jyp,
                            *jcj,
                            &atol,
                            "last-jacobian-stage",
                        )?;
                    }
                }
                if state.iter().chain(&rates).all(|x| x.is_finite()) {
                    println!(
                        "{{\"scope\":\"failed-operating-network-advancement\",\"representation\":\"geometry-owned-inertial-contact-flows\",\"solverReturnedTime_s\":{returned},\"independentlyAdmittedTime_s\":{},\"status\":{status},\"steps\":{steps},\"errorTestsFailed\":{error_fails},\"nonlinearFailures\":{nonlinear_fails},\"nonlinearIterations\":{nonlinear_iterations},\"lastStep_s\":{hlast},\"currentStep_s\":{hcurrent},\"initialStep_s\":{hinitial},\"currentOrder\":{order},\"currentCj\":{cj},\"callbackResiduals\":{},\"callbackJacobians\":{},\"propertyTuples\":{},\"flowAtol_kg_s\":{:?},\"preparedRelativeEnthalpyContrast_J_kg\":{flow_contrast},\"maxMomentumResidual_Pa\":{max_flow_law_residual},\"maxArithmeticNoiseToFlowBand\":{max_head_roundoff_to_flow_band},\"returnedState\":{:?},\"returnedDerivative\":{:?}}}",
                        work.admitted_time,
                        work.residuals,
                        work.jacobians,
                        work.property_requests,
                        flow_atol,
                        state,
                        rates
                    );
                }
                return Err(format!(
                    "Network advancement refused at last admitted {} s, solver returned {} s, status {status}, residuals {}, Jacobians {}, property tuples {}, budget exhausted {}, error {:?}",
                    work.admitted_time,
                    returned,
                    work.residuals,
                    work.jacobians,
                    work.property_requests,
                    work.budget_exhausted,
                    work.last_error
                ));
            }
            if returned <= work.admitted_time || returned > target + 1e-10 {
                return Err(
                    "Network accepted-step time is nonprogressing or overshoots declared stop"
                        .into(),
                );
            }
            let observation = (returned - target).abs() <= 1e-10;
            let mut accepted_cj = 0.;
            checked(
                unsafe { IDAGetCurrentCj(resources.ida, &mut accepted_cj) },
                "Accepted stage cj",
            )?;
            if let Err(error) = sample(
                returned,
                vector(y, n)?,
                vector(yp, n)?,
                accepted_cj,
                observation,
                &mut work,
            ) {
                // Preserve the actual accepted endpoint, not an interpolated
                // sample, for the existing nonadvancing coupled matrix audit.
                let state = vector(y, n)?;
                let rates = vector(yp, n)?;
                if state.iter().chain(rates).all(|v| v.is_finite()) {
                    println!(
                        "{{\"scope\":\"independent-operating-admission-failure\",\"solverReturnedTime_s\":{returned},\"independentlyAdmittedTime_s\":{},\"currentCj\":{accepted_cj},\"absoluteWeights\":{atol:?},\"relativeTolerance\":0,\"returnedState\":{state:?},\"returnedDerivative\":{rates:?}}}",
                        work.admitted_time
                    );
                }
                return Err(format!(
                    "Independent returned-state admission refused: last admitted {} s, returned {returned} s, elapsed {} s, residuals {}, Jacobians {}, property tuples {}, cause {error}",
                    work.admitted_time,
                    run_started.elapsed().as_secs_f64(),
                    work.residuals,
                    work.jacobians,
                    work.property_requests
                ));
            }
            work.admitted_time = returned;
            observation_steps += 1;
            if observation {
                break;
            }
        }
    }
    let mut steps = 0;
    let mut error_fails = 0;
    let mut nonlinear_fails = 0;
    checked(
        unsafe { IDAGetNumSteps(resources.ida, &mut steps) },
        "Network step count",
    )?;
    checked(
        unsafe { IDAGetNumErrTestFails(resources.ida, &mut error_fails) },
        "Network error count",
    )?;
    checked(
        unsafe { IDAGetNumNonlinSolvConvFails(resources.ida, &mut nonlinear_fails) },
        "Network nonlinear count",
    )?;
    let final_y = &samples.last().unwrap().y;
    let solid_energy_change = (5 * nw..work.network.stock_dimension())
        .map(|i| final_y[i] - initial[i])
        .sum();
    Ok(Receipt {
        samples,
        elapsed: run_started.elapsed().as_secs_f64(),
        steps,
        residuals: work.residuals,
        jacobians: work.jacobians,
        property_requests: work.property_requests,
        failures: work.failures,
        error_fails,
        nonlinear_fails,
        max_ledgers,
        max_chart,
        max_flow_law_residual,
        max_held_head_ratio,
        max_head_roundoff_to_flow_band,
        flow_atol,
        flow_contrast,
        initial_rate_norms,
        max_speed,
        max_kinetic_temperature,
        max_dynamic_head,
        max_omitted_kinetic_energy,
        max_reynolds: work.max_reynolds,
        max_reynolds_edge: work.max_reynolds_edge,
        solid_energy_change,
        nnz: work.network.row_indices.len(),
        n,
    })
}

fn main() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if !arguments.is_empty() && arguments.as_slice() != ["--audit"] {
        return Err("Expected no CLI arguments or exactly --audit".into());
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let mut tokens = input.split_whitespace();
    let input = operating_network_input::parse(&mut tokens)?;
    if tokens.next().is_some() {
        return Err("Trailing operating network input".into());
    }
    let operating_network_input::Input {
        config,
        horizon,
        budget,
    } = input;
    let nw = config.water.len();
    let ns = config.solids.len();
    let ne = config.hydraulic.len();
    let nh = config.heat.len();
    let began = Instant::now();
    let normal = run(config.clone(), horizon, began, budget, 1.)?;
    let tighter = run(config, horizon, began, budget, 0.1)?;
    let mut delta_temperature = 0_f64;
    let mut delta_pressure = 0_f64;
    let mut delta_flow = vec![0_f64; ne];
    let mut signed_transfer_difference = vec![0_f64; ne];
    let mut gross_transfer_difference = vec![0_f64; ne];
    for (a, b) in normal.samples.iter().zip(&tighter.samples) {
        if a.time != b.time {
            return Err("Comparison times differ".into());
        }
        for (x, z) in a.temperatures.iter().zip(&b.temperatures) {
            delta_temperature = delta_temperature.max((x - z).abs());
        }
        for i in 0..nw {
            delta_pressure = delta_pressure.max((a.y[5 * i + 3] - b.y[5 * i + 3]).abs());
        }
        for edge in 0..ne {
            delta_flow[edge] = delta_flow[edge].max((a.flows[edge] - b.flows[edge]).abs());
        }
    }
    // Diagnostic samples, not solver-integrated fluxes: startup may be aliased.
    // Compare each edge independently so opposing circulation cannot cancel.
    for (a, b) in normal.samples.windows(2).zip(tighter.samples.windows(2)) {
        let dt = a[1].time - a[0].time;
        for edge in 0..ne {
            signed_transfer_difference[edge] += dt
                * 0.5
                * (a[0].flows[edge] + a[1].flows[edge] - b[0].flows[edge] - b[1].flows[edge]);
            gross_transfer_difference[edge] += dt
                * 0.5
                * (a[0].flows[edge].abs() + a[1].flows[edge].abs()
                    - b[0].flows[edge].abs()
                    - b[1].flows[edge].abs());
        }
    }
    let heat_difference = (normal.solid_energy_change - tighter.solid_energy_change).abs();
    let heat_relative = heat_difference / normal.solid_energy_change.abs().max(1.);
    if delta_temperature > 0.01
        || delta_pressure > 5000.
        || heat_relative > 0.005
        || normal.solid_energy_change.abs() <= 100. * heat_difference.max(1.)
    {
        return Err(format!(
            "Useful-duration paired comparison refused: dT={delta_temperature}, dp={delta_pressure}, dHeatRel={heat_relative}, actual finite heat={}",
            normal.solid_energy_change
        ));
    }
    let mut trace = vec![];
    for second in [0, 1, 5, 10, 30, 60, 120, 180, 240, 300] {
        if let Some(s) = normal.samples.get(second) {
            trace.push(format!("{{\"time_s\":{},\"waterSolidTemperatures_K\":{:?},\"waterPressure_Pa\":{:?},\"massFlows_kg_s\":{:?},\"heatFlows_W\":{:?}}}",s.time,s.temperatures,(0..nw).map(|i|s.y[5*i+3]).collect::<Vec<_>>(),s.flows,s.heat));
        }
    }
    let receipt = format!(
        "{{\"scope\":\"cold-finite-primary-and-SG-metal-pressure-thermal-network\",\"admittedDuration_s\":{horizon},\"normalWall_s\":{},\"tighterWall_s\":{},\"aggregateWall_s\":{},\"waterNodes\":{nw},\"solidNodes\":{ns},\"hydraulicContacts\":{ne},\"heatContacts\":{nh},\"unknowns\":{},\"jacobianNonzeros\":{},\"normalInternalSteps\":{},\"tighterInternalSteps\":{},\"diagnosticStopInterval_s\":1,\"normalResiduals\":{},\"normalJacobians\":{},\"normalPropertyTuples\":{},\"tighterResiduals\":{},\"tighterJacobians\":{},\"tighterPropertyTuples\":{},\"normalCallbackFailures\":{},\"tighterCallbackFailures\":{},\"normalErrorTestsFailed\":{},\"tighterErrorTestsFailed\":{},\"normalNonlinearFailures\":{},\"tighterNonlinearFailures\":{},\"normalMaxStockLedger_M_E_B\":{:?},\"tighterMaxStockLedger_M_E_B\":{:?},\"normalMaxChartCorrection_P_T\":{:?},\"tighterMaxChartCorrection_P_T\":{:?},\"normalMaxSpeed_m_s\":{},\"normalMaxNeglectedKEquivalent_K\":{},\"finiteSolidEnergyChange_J\":{},\"pairedMaxTemperature_K\":{delta_temperature},\"pairedMaxPressure_Pa\":{delta_pressure},\"pairedHeatRelative\":{heat_relative},\"sourceNeutronCoordinates\":0,\"nuclearHistoryCoordinates\":0,\"phaseCoordinates\":0,\"rotorCoordinates\":0,\"notImplemented\":[\"PZR-surge-compliance\",\"SG-secondary\",\"source-fuel-decay\",\"rotor-coastdown\",\"phase-and-boiling\",\"acquired-I&C\",\"grid-and-finite-ultimate-sink\"],\"trace\":[{}]}}",
        normal.elapsed,
        tighter.elapsed,
        began.elapsed().as_secs_f64(),
        normal.n,
        normal.nnz,
        normal.steps,
        tighter.steps,
        normal.residuals,
        normal.jacobians,
        normal.property_requests,
        tighter.residuals,
        tighter.jacobians,
        tighter.property_requests,
        normal.failures,
        tighter.failures,
        normal.error_fails,
        tighter.error_fails,
        normal.nonlinear_fails,
        tighter.nonlinear_fails,
        normal.max_ledgers,
        tighter.max_ledgers,
        normal.max_chart,
        tighter.max_chart,
        normal.max_speed,
        normal.max_kinetic_temperature,
        normal.solid_energy_change,
        trace.join(",")
    );
    let receipt = receipt
        .strip_suffix('}')
        .expect("Receipt closing delimiter");
    let receipt = format!(
        "{receipt},\"initialization\":\"fresh-rest; physical stock-and-flow-rates retained; only algebraic pT first predictor slopes zero\",\"normalInitialPhysicalAndPredictorWRMSRate_per_s\":{:?},\"tighterInitialPhysicalAndPredictorWRMSRate_per_s\":{:?},\"differentialCoordinates\":{},\"algebraicCoordinates\":{},\"normalMaxDynamicHead_Pa\":{},\"tighterMaxDynamicHead_Pa\":{},\"normalMaxOmittedKEstimate_J\":{},\"tighterMaxOmittedKEstimate_J\":{},\"admissionSampling\":\"initial and every accepted IDA internal step; paired observations one second apart\",\"momentumScreenMeaning\":\"local held-head Newton-equivalent q correction at actual endpoint cj; not a temporal or coupled error bound\",\"kineticEstimateMeaning\":\"sum L*q^2/(2*A*rhoBar); not a retained exact native kinetic-energy ledger\"",
        normal.initial_rate_norms,
        tighter.initial_rate_norms,
        3 * nw + ns + ne,
        2 * nw,
        normal.max_dynamic_head,
        tighter.max_dynamic_head,
        normal.max_omitted_kinetic_energy,
        tighter.max_omitted_kinetic_energy
    );
    let receipt = format!(
        "{receipt},\"normalMaxHeldHeadDiagnosticRatio\":{},\"tighterMaxHeldHeadDiagnosticRatio\":{},\"momentumDiagnosticIsAdmissionGate\":false",
        normal.max_held_head_ratio, tighter.max_held_head_ratio
    );
    let receipt = format!(
        "{receipt},\"pairedMaxFlowByEdge_kg_s\":{delta_flow:?},\"sampledSignedTransferDifferenceByEdge_kg\":{signed_transfer_difference:?},\"sampledGrossTransferDifferenceByEdge_kg\":{gross_transfer_difference:?},\"transferDiagnosticMeaning\":\"one-second trapezoidal samples; not solver-integrated; startup aliasing possible\""
    );
    println!(
        "{receipt},\"representation\":\"geometry-owned-inertial-contact-flows\",\"flowWeightMeaning\":\"fixed 1mK thermal consequence allocation over declared horizon and incident edges; heuristic, not propagated-error proof\",\"normalFlowAtol_kg_s\":{:?},\"tighterFlowAtol_kg_s\":{:?},\"preparedRelativeEnthalpyContrast_J_kg\":{},\"normalMaxMomentumResidual_Pa\":{},\"tighterMaxMomentumResidual_Pa\":{},\"normalMaxArithmeticNoiseToFlowBand\":{},\"tighterMaxArithmeticNoiseToFlowBand\":{},\"normalMaxReynolds\":{},\"normalMaxReynoldsEdge\":{},\"tighterMaxReynolds\":{},\"tighterMaxReynoldsEdge\":{}}}",
        normal.flow_atol,
        tighter.flow_atol,
        normal.flow_contrast,
        normal.max_flow_law_residual,
        tighter.max_flow_law_residual,
        normal.max_head_roundoff_to_flow_band,
        tighter.max_head_roundoff_to_flow_band,
        normal.max_reynolds,
        normal.max_reynolds_edge,
        tighter.max_reynolds,
        tighter.max_reynolds_edge
    );
    Ok(())
}

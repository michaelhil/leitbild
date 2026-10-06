//! Strict numeric fresh-original offline operating-network qualification.
//! No live plant, source/PZR/secondary/rotor/control/event implementation.
mod ida_support;
mod operating_network_audit;
use ida_support::*;
use leitbild_plant_numerics::operating_network::*;
use leitbild_plant_numerics::original_water::OriginalField;
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
    max_speed: f64,
    max_kinetic_temperature: f64,
    max_reynolds: f64,
    max_reynolds_edge: usize,
    solid_energy_change: f64,
    nnz: usize,
    n: usize,
}
fn screen(
    work: &mut Work,
    y: &[f64],
    initial: &[f64],
    max_ledgers: &mut [f64; 3],
    max_chart: &mut [f64; 2],
    speed: &mut f64,
    kinetic_temperature: &mut f64,
) -> Result<(), String> {
    work.evaluate(y, &vec![0.; y.len()], Some(0.))?;
    let total = totals(&work.network, y);
    let total0 = totals(&work.network, initial);
    for i in 0..3 {
        max_ledgers[i] = max_ledgers[i].max((total[i] - total0[i]).abs());
    }
    if max_ledgers[0] > 1e-6 || max_ledgers[1] > 1. || max_ledgers[2] > 1e-8 {
        return Err(format!("Closed stock ledger refused: {max_ledgers:?}"));
    }
    for i in 0..work.network.config().water.len() {
        let mp = -get(&work.workspace, &work.network, 5 * i + 3, 5 * i + 3);
        let mt = -get(&work.workspace, &work.network, 5 * i + 3, 5 * i + 4);
        let ep = -get(&work.workspace, &work.network, 5 * i + 4, 5 * i + 3);
        let et = -get(&work.workspace, &work.network, 5 * i + 4, 5 * i + 4);
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
        if re > work.max_reynolds {
            work.max_reynolds = re;
            work.max_reynolds_edge = edge;
        }
        *speed = speed.max(v);
        let cp = work.workspace.liquids[e.from]
            .cp
            .min(work.workspace.liquids[e.to].cp);
        *kinetic_temperature = kinetic_temperature.max(v * v / (2. * cp));
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
    let mut id = vec![1.; n];
    let mut atol = vec![0.; n];
    for i in 0..nw {
        id[5 * i + 3] = 0.;
        id[5 * i + 4] = 0.;
        atol[5 * i] = 1e-5 * factor;
        atol[5 * i + 1] = initial[5 * i] * work.workspace.liquids[i].cp * 1e-3 * factor;
        atol[5 * i + 2] = 1e-8 * factor;
        atol[5 * i + 3] = 100. * factor;
        atol[5 * i + 4] = 1e-3 * factor;
    }
    for i in 0..ns {
        atol[5 * nw + i] = work.network.config().solids[i].heat_capacity * 1e-3 * factor;
    }
    let mut resources = Resources::new()?;
    let y = resources.vector(&initial)?;
    let yp = resources.vector(&slopes)?;
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
    let mut max_speed = 0.;
    let mut max_kinetic_temperature = 0.;
    let mut sample = |time: f64, state: Vec<f64>, work: &mut Work| -> Result<(), String> {
        screen(
            work,
            &state,
            &initial,
            &mut max_ledgers,
            &mut max_chart,
            &mut max_speed,
            &mut max_kinetic_temperature,
        )?;
        samples.push(Sample {
            time,
            temperatures: (0..nw + ns)
                .map(|i| work.network.temperature(i, &state))
                .collect(),
            flows: work.workspace.mass_flows.clone(),
            heat: work.workspace.heat_flows.clone(),
            y: state,
        });
        Ok(())
    };
    sample(0., initial.clone(), &mut work)?;
    // Exact one-second diagnostic stops, preserving IDA history. No source,
    // controller or peer is polled here; returned states cannot overshoot stops.
    for second in 1..=horizon as usize {
        let target = second as f64;
        checked(
            unsafe { IDASetStopTime(resources.ida, target) },
            "Network diagnostic stop",
        )?;
        let mut returned = 0.;
        let status = unsafe { IDASolve(resources.ida, target, &mut returned, y, yp, 1) };
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
                    "{{\"scope\":\"failed-operating-network-advancement\",\"solverReturnedTime_s\":{returned},\"independentlyAdmittedTime_s\":{},\"status\":{status},\"steps\":{steps},\"errorTestsFailed\":{error_fails},\"nonlinearFailures\":{nonlinear_fails},\"nonlinearIterations\":{nonlinear_iterations},\"lastStep_s\":{hlast},\"currentStep_s\":{hcurrent},\"initialStep_s\":{hinitial},\"currentOrder\":{order},\"currentCj\":{cj},\"callbackResiduals\":{},\"callbackJacobians\":{},\"propertyTuples\":{},\"returnedState\":{:?},\"returnedDerivative\":{:?}}}",
                    work.admitted_time,
                    work.residuals,
                    work.jacobians,
                    work.property_requests,
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
        if (returned - target).abs() > 1e-10 {
            return Err("Network returned time differs from declared stop".into());
        }
        if let Err(error) = sample(returned, vector(y, n)?.to_vec(), &mut work) {
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
    let solid_energy_change = (5 * nw..n).map(|i| final_y[i] - initial[i]).sum();
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
        max_speed,
        max_kinetic_temperature,
        max_reynolds: work.max_reynolds,
        max_reynolds_edge: work.max_reynolds_edge,
        solid_energy_change,
        nnz: work.network.row_indices.len(),
        n,
    })
}

fn value<T: std::str::FromStr>(tokens: &mut std::str::SplitWhitespace<'_>) -> Result<T, String> {
    tokens
        .next()
        .ok_or("Missing operating network numeric input")?
        .parse()
        .map_err(|_| "Invalid operating network numeric input".into())
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
    let nw: usize = value(&mut tokens)?;
    let ns: usize = value(&mut tokens)?;
    let ne: usize = value(&mut tokens)?;
    let nh: usize = value(&mut tokens)?;
    let horizon: f64 = value(&mut tokens)?;
    let budget: f64 = value(&mut tokens)?;
    if !horizon.is_finite()
        || horizon < 60.
        || horizon > 300.
        || horizon.fract() != 0.
        || !budget.is_finite()
        || budget <= 0.
        || budget > 120.
    {
        return Err(
            "Expected useful integer horizon 60..300 s and aggregate allowance <=120 s".into(),
        );
    }
    let anchor_p: f64 = value(&mut tokens)?;
    let anchor_t: f64 = value(&mut tokens)?;
    let anchor_z: f64 = value(&mut tokens)?;
    let minimum_span: f64 = value(&mut tokens)?;
    let original_mass_screen: f64 = value(&mut tokens)?;
    let original = OriginalField::new(
        anchor_p,
        anchor_t,
        anchor_z,
        minimum_span,
        original_mass_screen,
    )?;
    let mut water = vec![];
    for _ in 0..nw {
        let volume = value(&mut tokens)?;
        let elevation = value(&mut tokens)?;
        let initial_tracer_fraction = value(&mut tokens)?;
        let liquid = original.at(elevation)?;
        water.push(Water {
            geometry: leitbild_plant_numerics::CellGeometry { volume, elevation },
            initial_pressure: liquid.pressure,
            initial_temperature: liquid.temperature,
            initial_tracer_fraction,
        });
    }
    let mut solids = vec![];
    for _ in 0..ns {
        solids.push(Solid {
            heat_capacity: value(&mut tokens)?,
            initial_temperature: value(&mut tokens)?,
        });
    }
    let mut hydraulic = vec![];
    for _ in 0..ne {
        let kind: u32 = value(&mut tokens)?;
        let from = value(&mut tokens)?;
        let to = value(&mut tokens)?;
        let length = value(&mut tokens)?;
        let flow_area = value(&mut tokens)?;
        let diameter = value(&mut tokens)?;
        let roughness = value(&mut tokens)?;
        let fixed_loss = value(&mut tokens)?;
        let grid_value: f64 = value(&mut tokens)?;
        let law = match kind {
            0 => LossLaw::EffectiveTotal,
            1 => LossLaw::ChurchillPipe,
            2 => LossLaw::ChurchillAnnulus,
            3 => LossLaw::CoreBundle,
            4 => LossLaw::GuideAnnulus {
                laminar_darcy: grid_value,
            },
            5 => LossLaw::SmoothColebrook,
            _ => return Err("Unknown explicitly supported hydraulic law".into()),
        };
        hydraulic.push(Hydraulic {
            from,
            to,
            law,
            length,
            flow_area,
            diameter,
            roughness,
            fixed_loss,
            grid_multiplier: if kind == 4 { 0. } else { grid_value },
        });
    }
    let mut heat = vec![];
    for _ in 0..nh {
        let kind: u32 = value(&mut tokens)?;
        let from = value(&mut tokens)?;
        let to = value(&mut tokens)?;
        let law = match kind {
            0 => HeatLaw::Conductance(value(&mut tokens)?),
            1 => HeatLaw::LiquidFilm {
                geometry: value(&mut tokens)?,
            },
            2 => HeatLaw::SgSensible {
                area: value(&mut tokens)?,
                diameter: value(&mut tokens)?,
                flow_area: value(&mut tokens)?,
                hydraulic_edge: value(&mut tokens)?,
            },
            _ => return Err("Unknown explicitly supported thermal law".into()),
        };
        heat.push(Heat { from, to, law });
    }
    if tokens.next().is_some() {
        return Err("Trailing operating network input".into());
    }
    let config = Config {
        water,
        solids,
        hydraulic,
        heat,
    };
    Network::new(config.clone())?;
    let began = Instant::now();
    let normal = run(config.clone(), horizon, began, budget, 1.)?;
    let tighter = run(config, horizon, began, budget, 0.1)?;
    let mut delta_temperature = 0_f64;
    let mut delta_pressure = 0_f64;
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
    println!(
        "{receipt},\"normalMaxReynolds\":{},\"normalMaxReynoldsEdge\":{},\"tighterMaxReynolds\":{},\"tighterMaxReynoldsEdge\":{}}}",
        normal.max_reynolds,
        normal.max_reynolds_edge,
        tighter.max_reynolds,
        tighter.max_reynolds_edge
    );
    Ok(())
}

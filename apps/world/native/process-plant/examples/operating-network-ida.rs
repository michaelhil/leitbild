//! Strict numeric fresh-original offline operating-network qualification.
//! No live plant, source/PZR/rotor/control/event implementation. Closed SG
//! secondaries are cold, fully wetted equilibrium steam/air inventories only.
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
    max_pressure_split: [f64; 3], // Pa, fractional density proxy, K work proxy
    max_secondary_chart: [f64; 2],
    max_secondary_material_volume: [f64; 2],
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
enum CallbackFailure {
    Trial(String),
    Boundary(String),
}
impl From<String> for CallbackFailure {
    fn from(message: String) -> Self {
        Self::Boundary(message)
    }
}
impl From<&str> for CallbackFailure {
    fn from(message: &str) -> Self {
        Self::Boundary(message.into())
    }
}
fn callback(
    user: Handle,
    jac: bool,
    f: impl FnOnce(&mut Work) -> Result<(), CallbackFailure>,
) -> c_int {
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
            let (message, status) = match e {
                CallbackFailure::Trial(message) => {
                    (message, if w.budget_exhausted { -1 } else { 1 })
                }
                CallbackFailure::Boundary(message) => (message, -1),
            };
            w.last_error = Some(message);
            status
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
        w.evaluate(vector(y, n)?, vector(yp, n)?, None)
            .map_err(CallbackFailure::Trial)?;
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
        w.evaluate(state, rates, Some(cj))
            .map_err(CallbackFailure::Trial)?;
        if w.audit_enabled {
            w.last_jacobian_state = Some((state.to_vec(), rates.to_vec(), cj));
        }
        matrix_data(
            matrix,
            &w.network.column_pointers,
            &w.network.row_indices,
            &w.workspace.jacobian_values,
        )?;
        Ok(())
    })
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
use leitbild_plant_numerics::operating_admission::held_head_ratio;
#[cfg(test)]
mod predictor_tests {
    use super::*;
    #[test]
    fn recipient_disagreement_cannot_cancel() {
        let (difference, delivered) = recipient_heat(&[10., -10.], &[9., -9.]);
        assert_eq!(difference, 2.);
        assert_eq!(delivered, 20.);
    }
    #[test]
    fn held_head_proxy_is_not_a_coupled_correction_bound() {
        // J=[[1,100],[0,1]], actual correction=[0.1,0.01], unit weights.
        // J*correction=[1.1,0.01]: holding the second coordinate fixed would
        // falsely reject the first, despite both coupled corrections < 1.
        let correction = [0.1, 0.01];
        let residual = correction[0] + 100. * correction[1];
        assert!(held_head_ratio(residual, 1., 1.).unwrap() > 1.);
        assert!(correction.into_iter().all(|v| v < 1.));
        assert!(held_head_ratio(f64::NAN, 1., 1.).is_err());
        assert!(held_head_ratio(1., 0., 1.).is_err());
    }
}
fn recipient_heat(normal: &[f64], tighter: &[f64]) -> (f64, f64) {
    assert_eq!(normal.len(), tighter.len());
    (
        normal.iter().zip(tighter).map(|(a, b)| (a - b).abs()).sum(),
        normal.iter().map(|a| a.abs()).sum(),
    )
}
use leitbild_plant_numerics::operating_admission::totals;
#[derive(Clone)]
struct Sample {
    time: f64,
    y: Vec<f64>,
    temperatures: Vec<f64>,
    flows: Vec<f64>,
    heat: Vec<f64>,
    pressures: Vec<f64>,
    secondary_phase: Vec<[f64; 3]>,
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
    solid_energy_change_by_recipient: Vec<f64>,
    max_pressure_split: [f64; 3],
    nnz: usize,
    n: usize,
    secondary_energy_change: Vec<f64>,
    secondary_inventories: Vec<[f64; 3]>,
    max_secondary_chart: [f64; 2],
    max_secondary_material_volume: [f64; 2],
}
fn screen(
    work: &mut Work, y: &[f64], yp: &[f64], _cj:f64, initial:&[f64],
    max_ledgers:&mut [f64;3], max_chart:&mut [f64;2], flow_atol:&[f64],
    max_flow_law_residual:&mut f64, max_held_head_ratio:&mut f64,
    max_head_roundoff_to_flow_band:&mut f64, speed:&mut f64,
    kinetic_temperature:&mut f64, dynamic_head:&mut f64, omitted_kinetic_energy:&mut f64,
)->Result<(),String> {
    work.evaluate(y,yp,None)?;
    let d=leitbild_plant_numerics::operating_admission::screen(
        &work.network,&work.workspace,y,totals(&work.network,initial),flow_atol)?;
    work.property_requests+=d.property_requests as u64;
    for i in 0..3 {
        max_ledgers[i]=max_ledgers[i].max(d.ledgers[i]);
        work.max_pressure_split[i]=work.max_pressure_split[i].max(d.pressure_split[i]);
    }
    for i in 0..2 {
        max_chart[i]=max_chart[i].max(d.chart[i]);
        work.max_secondary_chart[i]=work.max_secondary_chart[i].max(d.secondary_chart[i]);
        work.max_secondary_material_volume[i]=work.max_secondary_material_volume[i].max(d.secondary_material_volume[i]);
    }
    if d.reynolds>work.max_reynolds {work.max_reynolds=d.reynolds;work.max_reynolds_edge=d.reynolds_edge;}
    *max_flow_law_residual=max_flow_law_residual.max(d.flow_law_residual);
    *max_held_head_ratio=max_held_head_ratio.max(d.held_head_ratio);
    *max_head_roundoff_to_flow_band=max_head_roundoff_to_flow_band.max(d.head_roundoff_to_flow_band);
    *speed=speed.max(d.speed);*kinetic_temperature=kinetic_temperature.max(d.kinetic_temperature);
    *dynamic_head=dynamic_head.max(d.dynamic_head);*omitted_kinetic_energy=omitted_kinetic_energy.max(d.omitted_kinetic_energy);
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
    let mut initial = network.initial_state()?;
    let nw = network.config().water.len();
    let ns = network.config().solids.len();
    let nk = network.config().secondaries.len();
    let mut work = Box::new(Work {
        workspace: Workspace::new(&network),
        network,
        started: began,
        budget,
        residuals: 0,
        jacobians: 0,
        property_requests: (nw + 6 * nk) as u64,
        failures: 0,
        last_error: None,
        budget_exhausted: false,
        admitted_time: 0.,
        max_reynolds: 0.,
        max_reynolds_edge: 0,
        max_pressure_split: [0.; 3],
        max_secondary_chart: [0.; 2],
        max_secondary_material_volume: [0.; 2],
        audit_enabled: std::env::args().any(|a| a == "--audit"),
        last_jacobian_state: None,
    });
    // Original finite stocks are kept. Quasi-steady q and pressure multipliers
    // must be solved jointly with their physical thermal-expansion rates.
    work.evaluate(&initial, &vec![0.; n], None)?;
    let seed_slopes = work.workspace.rates.clone();
    let id: Vec<f64> = (0..n)
        .map(|row| {
            if work.network.is_differential(row) {
                1.
            } else {
                0.
            }
        })
        .collect();
    let weights=leitbild_plant_numerics::operating_admission::weights(
        &work.network,&work.workspace,&initial,horizon,factor)?;
    work.property_requests+=weights.property_requests as u64;
    let atol=weights.absolute;
    let flow_atol=weights.flow;
    let flow_contrast=weights.flow_contrast;
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
    // IDA_YA_YDP_INIT changes only algebraic values and differential rates;
    // this is a consistent initialization, not an advancing startup campaign.
    let ic_status = unsafe { IDACalcIC(resources.ida, 1, 0.001) };
    if ic_status != 0 {
        eprintln!("Initialization callback error: {:?}", work.last_error);
        println!(
            "{{\"scope\":\"operating-consistent-initialization-refusal\",\"admittedDuration_s\":0,\"status\":{ic_status},\"callbackResiduals\":{},\"callbackJacobians\":{},\"propertyTuples\":{},\"absoluteWeights\":{atol:?},\"originalState\":{initial:?},\"trialState\":{:?},\"trialDerivative\":{:?}}}",
            work.residuals,
            work.jacobians,
            work.property_requests,
            vector(y, n)?,
            vector(yp, n)?
        );
        return Err(format!(
            "Original network consistent initialization returned {ic_status}; no time advanced"
        ));
    }
    checked(
        unsafe { IDAGetConsistentIC(resources.ida, y, yp) },
        "Original consistent state",
    )?;
    let initialized = vector(y, n)?.to_vec();
    for row in 0..n {
        if work.network.is_differential(row) && initialized[row] != initial[row] {
            return Err("Initialization changed an original finite stock".into());
        }
    }
    initial = initialized;
    let slopes = vector(yp, n)?.to_vec();
    let initial_rate_norms = [
        weighted_rate_norm(&seed_slopes, &atol),
        weighted_rate_norm(&slopes, &atol),
    ];
    eprintln!(
        "{{\"scope\":\"original-operating-network-initialization\",\"representation\":\"finite-inventory-sound-filtered-cold-liquid\",\"finiteStocksUnchanged\":true,\"absoluteWeights\":{atol:?},\"relativeTolerance\":0,\"consistentState\":{initial:?},\"consistentDerivative\":{slopes:?}}}"
    );
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
                    .chain(
                        (0..work.network.config().secondaries.len())
                            .map(|k| state[work.network.secondary_temperature_row(k)]),
                    )
                    .collect(),
                flows: work.workspace.mass_flows.clone(),
                heat: work
                    .workspace
                    .heat_flows
                    .iter()
                    .chain(&work.workspace.secondary_heat_flows)
                    .copied()
                    .collect(),
                pressures: (0..nw)
                    .map(|i| work.network.mechanical_pressure(i, state))
                    .chain(
                        (0..work.network.config().secondaries.len())
                            .map(|k| state[work.network.secondary_pressure_row(k)]),
                    )
                    .collect(),
                secondary_phase: work
                    .workspace
                    .secondary_states
                    .iter()
                    .map(|s| [s.liquid_mass, s.vapor_mass, s.liquid_volume])
                    .collect(),
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
                let mut order = 0;
                let mut hlast = 0.;
                let mut hcurrent = 0.;
                let mut cj = 0.;
                let mut error_fails = 0;
                let mut nonlinear_fails = 0;
                checked(
                    unsafe { IDAGetCurrentOrder(resources.ida, &mut order) },
                    "Step-limit order",
                )?;
                checked(
                    unsafe { IDAGetLastStep(resources.ida, &mut hlast) },
                    "Step-limit last step",
                )?;
                checked(
                    unsafe { IDAGetCurrentStep(resources.ida, &mut hcurrent) },
                    "Step-limit current step",
                )?;
                checked(
                    unsafe { IDAGetCurrentCj(resources.ida, &mut cj) },
                    "Step-limit cj",
                )?;
                checked(
                    unsafe { IDAGetNumErrTestFails(resources.ida, &mut error_fails) },
                    "Step-limit error count",
                )?;
                checked(
                    unsafe { IDAGetNumNonlinSolvConvFails(resources.ida, &mut nonlinear_fails) },
                    "Step-limit nonlinear count",
                )?;
                println!(
                    "{{\"scope\":\"operating-step-limit-refusal\",\"admittedDuration_s\":{},\"observationSteps\":{observation_steps},\"currentOrder\":{order},\"lastStep_s\":{hlast},\"currentStep_s\":{hcurrent},\"currentCj\":{cj},\"errorTestsFailed\":{error_fails},\"nonlinearFailures\":{nonlinear_fails},\"absoluteWeights\":{atol:?},\"returnedState\":{:?},\"returnedDerivative\":{:?}}}",
                    work.admitted_time,
                    vector(y, n)?,
                    vector(yp, n)?
                );
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
                        "{{\"scope\":\"failed-operating-network-advancement\",\"representation\":\"finite-inventory-sound-filtered-cold-liquid\",\"solverReturnedTime_s\":{returned},\"independentlyAdmittedTime_s\":{},\"status\":{status},\"steps\":{steps},\"errorTestsFailed\":{error_fails},\"nonlinearFailures\":{nonlinear_fails},\"nonlinearIterations\":{nonlinear_iterations},\"lastStep_s\":{hlast},\"currentStep_s\":{hcurrent},\"initialStep_s\":{hinitial},\"currentOrder\":{order},\"currentCj\":{cj},\"callbackResiduals\":{},\"callbackJacobians\":{},\"propertyTuples\":{},\"flowAtol_kg_s\":{:?},\"preparedRelativeEnthalpyContrast_J_kg\":{flow_contrast},\"maxMomentumResidual_Pa\":{max_flow_law_residual},\"maxArithmeticNoiseToFlowBand\":{max_head_roundoff_to_flow_band},\"returnedState\":{:?},\"returnedDerivative\":{:?}}}",
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
    let solid_energy_change_by_recipient: Vec<f64> = (0..ns)
        .map(|i| {
            let row = work.network.energy_row(nw + i);
            final_y[row] - initial[row]
        })
        .collect();
    let solid_energy_change = solid_energy_change_by_recipient.iter().sum();
    let secondary_energy_change = (0..work.network.config().secondaries.len())
        .map(|k| {
            let r = work.network.secondary_energy_row(k);
            final_y[r] - initial[r]
        })
        .collect();
    let secondary_inventories = (0..work.network.config().secondaries.len())
        .map(|k| {
            let i = work.network.secondary_inventory(k);
            [i.water, i.air, i.nitrogen]
        })
        .collect();
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
        solid_energy_change_by_recipient,
        max_pressure_split: work.max_pressure_split,
        nnz: work.network.row_indices.len(),
        n,
        secondary_energy_change,
        secondary_inventories,
        max_secondary_chart: work.max_secondary_chart,
        max_secondary_material_volume: work.max_secondary_material_volume,
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
    let nk = config.secondaries.len();
    let nkh = config.secondary_heat.len();
    let phase_coordinates = 3 * nk;
    let began = Instant::now();
    let normal = run(config.clone(), horizon, began, budget, 1.)?;
    let tighter = run(config, horizon, began, budget, 0.1)?;
    let mut delta_temperature = 0_f64;
    let mut delta_pressure = 0_f64;
    let mut delta_phase_mass = 0_f64;
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
        for i in 0..nw + nk {
            delta_pressure = delta_pressure.max((a.pressures[i] - b.pressures[i]).abs());
        }
        for (x, z) in a.secondary_phase.iter().zip(&b.secondary_phase) {
            for i in 0..2 {
                delta_phase_mass = delta_phase_mass.max((x[i] - z[i]).abs());
            }
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
    let normal_all_recipients: Vec<_> = normal
        .solid_energy_change_by_recipient
        .iter()
        .chain(&normal.secondary_energy_change)
        .copied()
        .collect();
    let tighter_all_recipients: Vec<_> = tighter
        .solid_energy_change_by_recipient
        .iter()
        .chain(&tighter.secondary_energy_change)
        .copied()
        .collect();
    let (heat_difference, delivered_heat) =
        recipient_heat(&normal_all_recipients, &tighter_all_recipients);
    let heat_relative = heat_difference / delivered_heat.max(1.);
    let mut secondary_heat_difference = vec![];
    for (k, (x, z)) in normal
        .secondary_energy_change
        .iter()
        .zip(&tighter.secondary_energy_change)
        .enumerate()
    {
        let diff = (x - z).abs();
        secondary_heat_difference.push(diff);
        if x.abs() <= 1. || x.abs() <= 100. * diff {
            return Err(format!(
                "Finite secondary recipient {k} energy response not distinguished: response={x}, difference={diff}"
            ));
        }
    }
    if delta_temperature > 0.01
        || delta_pressure > 5000.
        || delta_phase_mass > 0.01
        || heat_relative > 0.005
        || delivered_heat <= 100. * heat_difference.max(1.)
    {
        return Err(format!(
            "Useful-duration paired comparison refused: dT={delta_temperature}, dp={delta_pressure}, dHeatRel={heat_relative}, actual finite heat={}",
            normal.solid_energy_change
        ));
    }
    let mut trace = vec![];
    for second in [0, 1, 5, 10, 30, 60, 120, 180, 240, 300] {
        if let Some(s) = normal.samples.get(second) {
            trace.push(format!("{{\"time_s\":{},\"primarySolidSecondaryTemperatures_K\":{:?},\"primarySecondaryPressure_Pa\":{:?},\"massFlows_kg_s\":{:?},\"heatFlows_W\":{:?},\"secondaryLiquidVaporMassAndLiquidVolume_kg_kg_m3\":{:?}}}",s.time,s.temperatures,s.pressures,s.flows,s.heat,s.secondary_phase));
        }
    }
    let receipt = format!(
        "{{\"scope\":\"cold-finite-primary-SG-metal-and-closed-wet-secondary-network\",\"admittedDuration_s\":{horizon},\"normalWall_s\":{},\"tighterWall_s\":{},\"aggregateWall_s\":{},\"waterNodes\":{nw},\"solidNodes\":{ns},\"hydraulicContacts\":{ne},\"heatContacts\":{nh},\"unknowns\":{},\"jacobianNonzeros\":{},\"normalInternalSteps\":{},\"tighterInternalSteps\":{},\"diagnosticStopInterval_s\":1,\"normalResiduals\":{},\"normalJacobians\":{},\"normalPropertyTuples\":{},\"tighterResiduals\":{},\"tighterJacobians\":{},\"tighterPropertyTuples\":{},\"normalCallbackFailures\":{},\"tighterCallbackFailures\":{},\"normalErrorTestsFailed\":{},\"tighterErrorTestsFailed\":{},\"normalNonlinearFailures\":{},\"tighterNonlinearFailures\":{},\"normalMaxStockLedger_M_E_B\":{:?},\"tighterMaxStockLedger_M_E_B\":{:?},\"normalMaxChartCorrection_P_T\":{:?},\"tighterMaxChartCorrection_P_T\":{:?},\"normalMaxSpeed_m_s\":{},\"normalMaxNeglectedKEquivalent_K\":{},\"finiteSolidEnergyChange_J\":{},\"pairedMaxTemperature_K\":{delta_temperature},\"pairedMaxPressure_Pa\":{delta_pressure},\"pairedHeatRelative\":{heat_relative},\"sourceNeutronCoordinates\":0,\"nuclearHistoryCoordinates\":0,\"phaseCoordinates\":{phase_coordinates},\"rotorCoordinates\":0,\"notImplemented\":[\"PZR-surge-compliance\",\"source-fuel-decay\",\"rotor-coastdown\",\"boiling-dryout-exhaustion-and-secondary-ports\",\"acquired-I&C\",\"grid-and-finite-ultimate-sink\"],\"trace\":[{}]}}",
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
        "{receipt},\"initialization\":\"original finite stocks; joint algebraic flow and differential-rate initialization; no advancing startup\",\"normalInitialSeedAndConsistentWRMSRate_per_s\":{:?},\"tighterInitialSeedAndConsistentWRMSRate_per_s\":{:?},\"differentialCoordinates\":{},\"algebraicCoordinates\":{},\"normalMaxDynamicHead_Pa\":{},\"tighterMaxDynamicHead_Pa\":{},\"normalMaxOmittedKEstimate_J\":{},\"tighterMaxOmittedKEstimate_J\":{},\"admissionSampling\":\"initial and every accepted IDA internal step; paired observations one second apart\",\"momentumScreenMeaning\":\"local held-head static q correction; diagnostic only, not a temporal or coupled error bound\",\"kineticEstimateMeaning\":\"sum L*q^2/(2*A*rhoBar); not a retained exact native kinetic-energy ledger\"",
        normal.initial_rate_norms,
        tighter.initial_rate_norms,
        2 * nw + 1 + ns + nk,
        2 * nw + ne + 2 * nk,
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
        "{receipt},\"secondaryNodes\":{nk},\"secondaryHeatContacts\":{nkh},\"normalMaxSecondaryChartCorrection_P_T\":{:?},\"tighterMaxSecondaryChartCorrection_P_T\":{:?},\"normalMaxSecondaryWaterVolumeDefect_kg_m3\":{:?},\"tighterMaxSecondaryWaterVolumeDefect_kg_m3\":{:?},\"closedSecondaryInventoriesWaterAirNitrogen_kg\":{:?},\"normalSecondaryEnergyChangeByRecipient_J\":{:?},\"tighterSecondaryEnergyChangeByRecipient_J\":{:?},\"pairedSecondaryEnergyDifferenceByRecipient_J\":{secondary_heat_difference:?},\"pairedMaxSecondaryPhaseMassDifference_kg\":{delta_phase_mass},\"propertyTupleCountScope\":\"run construction and original preparation plus callbacks and accepted-state probes; excludes strict-input validation preparation; aggregate wall includes preparation\",\"secondaryPropertyDomain\":\"273.15..623.15K, IF97Pmin..20MPa, positive-air wet subboiling branch\",\"secondaryScope\":\"closed cold fully-wetted equilibrium steam-air/nitrogen storage with subboiling external Churchill-Chu contacts; no ports or ultimate sink\"",
        normal.max_secondary_chart,
        tighter.max_secondary_chart,
        normal.max_secondary_material_volume,
        tighter.max_secondary_material_volume,
        normal.secondary_inventories,
        normal.secondary_energy_change,
        tighter.secondary_energy_change
    );
    let receipt = format!(
        "{receipt},\"pairedMaxFlowByEdge_kg_s\":{delta_flow:?},\"sampledSignedTransferDifferenceByEdge_kg\":{signed_transfer_difference:?},\"sampledGrossTransferDifferenceByEdge_kg\":{gross_transfer_difference:?},\"transferDiagnosticMeaning\":\"one-second trapezoidal samples; not solver-integrated; startup aliasing possible\""
    );
    let receipt = format!(
        "{receipt},\"pairedFiniteHeatDifferenceSumAbs_J\":{heat_difference},\"finiteHeatSumAbsByRecipient_J\":{delivered_heat},\"normalSolidEnergyChangeByRecipient_J\":{:?},\"tighterSolidEnergyChangeByRecipient_J\":{:?},\"normalMaxPressureSplit_Pa_Fraction_K\":{:?},\"tighterMaxPressureSplit_Pa_Fraction_K\":{:?},\"pressureSplitMeaning\":\"mechanical pressure included in shared donor energy, omitted from EOS under prospective cold bounds; not rigorous entropy or model-error qualification\"",
        normal.solid_energy_change_by_recipient,
        tighter.solid_energy_change_by_recipient,
        normal.max_pressure_split,
        tighter.max_pressure_split
    );
    println!(
        "{receipt},\"representation\":\"finite-inventory-sound-filtered-cold-liquid\",\"flowWeightMeaning\":\"fixed 1mK thermal consequence allocation over declared horizon and incident edges; heuristic, not propagated-error proof\",\"normalFlowAtol_kg_s\":{:?},\"tighterFlowAtol_kg_s\":{:?},\"preparedRelativeEnthalpyContrast_J_kg\":{},\"normalMaxMomentumResidual_Pa\":{},\"tighterMaxMomentumResidual_Pa\":{},\"normalMaxArithmeticNoiseToFlowBand\":{},\"tighterMaxArithmeticNoiseToFlowBand\":{},\"normalMaxReynolds\":{},\"normalMaxReynoldsEdge\":{},\"tighterMaxReynolds\":{},\"tighterMaxReynoldsEdge\":{}}}",
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

//! ONE offline normal/tighter source-history advancement. No thermal feedback,
//! fixed neutron normalization, retry policy, alternate solver or live plant.
#![allow(dead_code)]
#[path = "evolution_input/mod.rs"]
mod evolution_input;
#[path = "../examples/ida_support/mod.rs"]
mod ida_support;
#[path = "source_input/mod.rs"]
mod source_input;
use ida_support::*;
use leitbild_plant_numerics::{
    converter_heat, cylindrical_source, fuel_history, fuel_source, heat_history, moderator_source,
    optical_source, passive_source, source_evolution, transport_source,
};
use source_evolution::{Diagnostics, Evolution, Workspace};
use std::{
    ffi::{c_int, c_long},
    fs,
    io::{self, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
    ptr, slice,
    time::Instant,
};

const HORIZON: f64 = 300.;
const RTOL: [f64; 2] = [1e-5, 1e-6];
const COUNT_ATOL: f64 = 1e-3;
const ENERGY_ATOL: f64 = 1e-12;
const MAXL: c_int = 30;
const RESTARTS: c_int = 0;
const REPORT_RESERVE_SECONDS: f64 = 2.;
const OUTPUTS: [f64; 14] = [
    0.001, 0.01, 0.1, 1., 2., 5., 10., 20., 30., 60., 120., 180., 240., 300.,
];

fn quote(s: &str) -> String {
    let mut q = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => q.push_str("\\\""),
            '\\' => q.push_str("\\\\"),
            '\n' => q.push_str("\\n"),
            '\r' => q.push_str("\\r"),
            '\t' => q.push_str("\\t"),
            c if c < ' ' => q.push_str(&format!("\\u{:04x}", c as u32)),
            c => q.push(c),
        }
    }
    q.push('"');
    q
}
fn finite(x: f64) -> String {
    if x.is_finite() {
        format!("{x:e}")
    } else {
        "null".into()
    }
}
fn numbers(xs: &[f64]) -> String {
    format!(
        "[{}]",
        xs.iter().map(|&x| finite(x)).collect::<Vec<_>>().join(",")
    )
}
fn ratio(numerator: f64, denominator: f64) -> Result<f64, String> {
    if !numerator.is_finite() || !denominator.is_finite() || denominator <= 0. {
        return Err("Nonfinite/invalid independent comparison numerator or scale".into());
    }
    let r = numerator / denominator;
    if !r.is_finite() {
        return Err("Nonfinite independent comparison ratio".into());
    }
    Ok(r)
}
fn finite_diagnostics(d: Diagnostics) -> Result<(), String> {
    if [
        d.neutrons,
        d.precursors,
        d.retained_energy_j,
        d.fission_events_s,
        d.induced_fission_events_s,
        d.net_neutron_events_s,
        d.neutron_event_scale_s,
        d.escape_neutrons_s,
        d.collected_events_s,
        d.capture_events_s,
        d.cf_births_s,
        d.cf_release_w,
        d.cf_export_w,
        d.fuel_release_w,
        d.mn_electron_release_w,
        d.mn_photon_release_w,
    ]
    .iter()
    .any(|x| !x.is_finite())
    {
        return Err("Nonfinite independent source diagnostic".into());
    }
    Ok(())
}
fn checkpoint(
    relative: f64,
    time: f64,
    steps: u64,
    elapsed: f64,
    path: &Path,
    y: &[f64],
    yp: &[f64],
    callbacks: &Callbacks<'_>,
    memory: Handle,
) -> Result<(), String> {
    let pending = path.with_extension("checkpoint-pending");
    let mut file = io::BufWriter::new(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| format!("New checkpoint pending file: {e}"))?,
    );
    file.write_all(b"LDSOURCE1")
        .and_then(|_| file.write_all(&(y.len() as u64).to_le_bytes()))
        .and_then(|_| file.write_all(&time.to_le_bytes()))
        .and_then(|_| file.write_all(&relative.to_le_bytes()))
        .map_err(|e| format!("Checkpoint header: {e}"))?;
    for &v in y.iter().chain(yp) {
        file.write_all(&v.to_le_bytes())
            .map_err(|e| format!("Checkpoint state: {e}"))?;
    }
    file.flush().map_err(|e| format!("Checkpoint flush: {e}"))?;
    file.get_ref()
        .sync_all()
        .map_err(|e| format!("Checkpoint sync: {e}"))?;
    drop(file);
    fs::rename(&pending, path).map_err(|e| format!("Atomic checkpoint replace: {e}"))?;
    let (stats, stats_error) = telemetry_stats(memory);
    println!(
        "{{\"kind\":\"admitted-progress\",\"rtol\":{relative:e},\"lastAdmittedTime\":{time:e},\"lastRetainedStateTime\":{time:e},\"checkpointPath\":{},\"acceptedScreenedSteps\":{steps},\"aggregateElapsedSeconds\":{elapsed:e},\"solverStats\":{stats},\"telemetryStatsError\":{stats_error},\"measuredKernelCosts\":{}}}",
        quote(&path.display().to_string()),
        callbacks.metrics_json()
    );
    io::stdout()
        .flush()
        .map_err(|e| format!("Checkpoint flush: {e}"))
}
unsafe fn values<'a>(v: Handle, n: usize) -> Result<&'a [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong callback vector length".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null callback vector data".into());
    }
    Ok(unsafe { slice::from_raw_parts(p, n) })
}
unsafe fn output<'a>(v: Handle, n: usize) -> Result<&'a mut [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong callback output length".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null callback output data".into());
    }
    Ok(unsafe { slice::from_raw_parts_mut(p, n) })
}

/// The full matrix-free solver and the N/C-only KLU preconditioner have separate
/// Resources owners. KLU symbolic structure never changes; every pset refreshes
/// numeric values and all history diagonals for that current state and cj.
struct Preconditioner {
    owned: Resources,
    b: Handle,
    x: Handle,
    pointers: Vec<i64>,
    indices: Vec<i64>,
    slots: Vec<usize>,
    values: Vec<f64>,
    native_values: Vec<f64>,
    diagonal: Vec<f64>,
    rhs: Vec<f64>,
    setups: u64,
    solves: u64,
    setup_seconds: f64,
    solve_seconds: f64,
    assembly_seconds: f64,
    factor_seconds: f64,
}
impl Preconditioner {
    fn new(model: &Evolution) -> Result<Self, String> {
        let n = model.nc_dimension();
        let pattern = model.nc_pattern();
        let mut order = (0..pattern.len()).collect::<Vec<_>>();
        order.sort_unstable_by_key(|&i| (pattern[i].1, pattern[i].0));
        let mut pointers = vec![0i64; n + 1];
        let mut indices = Vec::with_capacity(order.len());
        for &slot in &order {
            let (r, c) = pattern[slot];
            if r >= n || c >= n {
                return Err("N/C pattern outside block".into());
            }
            pointers[c + 1] += 1;
            indices.push(r as i64);
        }
        for c in 0..n {
            pointers[c + 1] += pointers[c];
        }
        let mut owned = Resources::new()?;
        let b = owned.vector(&vec![0.; n])?;
        let x = owned.vector(&vec![0.; n])?;
        owned.matrix(n as i64, order.len() as i64)?;
        owned.solver(x)?;
        checked(
            unsafe { SUNLinSolInitialize(owned.solver) },
            "Initialize N/C KLU",
        )?;
        Ok(Self {
            owned,
            b,
            x,
            pointers,
            indices,
            slots: order,
            values: vec![0.; pattern.len()],
            native_values: vec![0.; pattern.len()],
            diagonal: vec![0.; model.state_count() - n],
            rhs: vec![0.; model.state_count()],
            setups: 0,
            solves: 0,
            setup_seconds: 0.,
            solve_seconds: 0.,
            assembly_seconds: 0.,
            factor_seconds: 0.,
        })
    }
    fn setup(
        &mut self,
        model: &Evolution,
        work: &Workspace,
        cj: f64,
        memory: Handle,
        started: Instant,
        last_admitted: f64,
    ) -> Result<(), String> {
        let start = Instant::now();
        self.setups += 1;
        self.phase("nc-setup-enter", cj, memory, started, last_admitted, None)?;
        model
            .nc_values(work, cj, &mut self.native_values)
            .map_err(str::to_owned)?;
        model
            .history_diagonal(work, cj, &mut self.diagonal)
            .map_err(str::to_owned)?;
        for (v, &slot) in self.values.iter_mut().zip(&self.slots) {
            *v = self.native_values[slot];
        }
        matrix_data(
            self.owned.matrix,
            &self.pointers,
            &self.indices,
            &self.values,
        )?;
        self.assembly_seconds += start.elapsed().as_secs_f64();
        self.phase("nc-factor-enter", cj, memory, started, last_admitted, None)?;
        let factor_start = Instant::now();
        let status = unsafe { SUNLinSolSetup(self.owned.solver, self.owned.matrix) };
        self.factor_seconds += factor_start.elapsed().as_secs_f64();
        self.setup_seconds += start.elapsed().as_secs_f64();
        self.phase(
            "nc-factor-exit",
            cj,
            memory,
            started,
            last_admitted,
            Some(status),
        )?;
        checked(status, "Numeric N/C KLU setup")?;
        self.phase(
            "nc-setup-exit",
            cj,
            memory,
            started,
            last_admitted,
            Some(status),
        )
    }
    fn phase(
        &self,
        phase: &str,
        cj: f64,
        memory: Handle,
        started: Instant,
        last_admitted: f64,
        status: Option<c_int>,
    ) -> Result<(), String> {
        let (stats, stats_error) = telemetry_stats(memory);
        println!(
            "{{\"kind\":\"solver-phase\",\"phase\":{},\"lastAdmittedTime\":{last_admitted:e},\"aggregateElapsedSeconds\":{},\"cj\":{cj:e},\"setupAttempts\":{},\"completedSetupSeconds\":{},\"completedAssemblySeconds\":{},\"completedFactorSeconds\":{},\"completedPreconditionerSolves\":{},\"completedPreconditionerSolveSeconds\":{},\"status\":{},\"solverStats\":{stats},\"telemetryStatsError\":{stats_error}}}",
            quote(phase),
            finite(started.elapsed().as_secs_f64()),
            self.setups,
            finite(self.setup_seconds),
            finite(self.assembly_seconds),
            finite(self.factor_seconds),
            self.solves,
            finite(self.solve_seconds),
            status.map_or("null".into(), |s| s.to_string())
        );
        io::stdout()
            .flush()
            .map_err(|e| format!("Solver phase flush: {e}"))
    }
    fn solve(&mut self, r: Handle, z: Handle, nc: usize) -> Result<(), String> {
        let start = Instant::now();
        let n = self.rhs.len();
        self.rhs.copy_from_slice(unsafe { values(r, n) }?);
        unsafe { output(self.b, nc) }?.copy_from_slice(&self.rhs[..nc]);
        let status =
            unsafe { SUNLinSolSolve(self.owned.solver, self.owned.matrix, self.x, self.b, 0.) };
        self.solves += 1;
        self.solve_seconds += start.elapsed().as_secs_f64();
        checked(status, "N/C KLU preconditioner solve")?;
        let result = unsafe { output(z, n) }?;
        result[..nc].copy_from_slice(unsafe { values(self.x, nc) }?);
        for i in nc..n {
            result[i] = self.rhs[i] / self.diagonal[i - nc];
        }
        if result.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite preconditioner result".into());
        }
        Ok(())
    }
}
struct Callbacks<'a> {
    model: &'a Evolution,
    work: Workspace,
    preconditioner: Preconditioner,
    started: Instant,
    allowance: f64,
    error: Option<String>,
    recoverable_errors: u64,
    last_recoverable: Option<String>,
    rhs_calls: u64,
    jvp_calls: u64,
    rhs_seconds: f64,
    jvp_seconds: f64,
    base_calls: u64,
    base_seconds: f64,
    memory: Handle,
    last_admitted: f64,
}
enum CallbackFailure {
    Domain(String),
    Fatal(String),
}
impl From<String> for CallbackFailure {
    fn from(value: String) -> Self {
        Self::Fatal(value)
    }
}
fn trial_failure(error: &'static str) -> CallbackFailure {
    // Initial construction and evaluation already validated the immutable
    // law, shape and workspace. Only these known remaining-stock refusals are
    // recoverable on a finite Newton trial. Unknown/numerical errors stay fatal.
    match error {
        "Invalid same-trial fuel instance inputs/workspace"
        | "Invalid native water/finite target/liquid B10 support"
        | "Invalid actual passive target stocks/workspace"
        | "Invalid actual cylinder target/workspace"
        | "Invalid advancing optical target amounts" => CallbackFailure::Domain(error.into()),
        _ => CallbackFailure::Fatal(error.into()),
    }
}
impl Callbacks<'_> {
    fn metrics_json(&self) -> String {
        format!(
            "{{\"RHSAttempts\":{},\"RHSSeconds\":{},\"linearBaseAttempts\":{},\"linearBaseSeconds\":{},\"JVPCalls\":{},\"JVPSeconds\":{},\"setupAttempts\":{},\"completedSetupSeconds\":{},\"completedAssemblySeconds\":{},\"completedFactorSeconds\":{},\"completedPreconditionerSolves\":{},\"completedPreconditionerSolveSeconds\":{},\"recoverableDomainErrors\":{}}}",
            self.rhs_calls,
            finite(self.rhs_seconds),
            self.base_calls,
            finite(self.base_seconds),
            self.jvp_calls,
            finite(self.jvp_seconds),
            self.preconditioner.setups,
            finite(self.preconditioner.setup_seconds),
            finite(self.preconditioner.assembly_seconds),
            finite(self.preconditioner.factor_seconds),
            self.preconditioner.solves,
            finite(self.preconditioner.solve_seconds),
            self.recoverable_errors
        )
    }
    fn budget(&self) -> Result<(), String> {
        if self.started.elapsed().as_secs_f64() > self.allowance {
            Err("Aggregate offline pair wall allowance exhausted".into())
        } else {
            Ok(())
        }
    }
    fn evaluate_trial(&mut self, y: Handle) -> Result<(), CallbackFailure> {
        let state = unsafe { values(y, self.model.state_count()) }?;
        if state.iter().any(|x| !x.is_finite()) {
            return Err(CallbackFailure::Fatal("Nonfinite Newton trial".into()));
        }
        self.model
            .evaluate_into(state, &mut self.work)
            .map_err(trial_failure)
    }
    fn base(&mut self, y: Handle) -> Result<(), CallbackFailure> {
        self.budget()?;
        let t = Instant::now();
        self.base_calls += 1;
        let evaluated = self.evaluate_trial(y);
        self.base_seconds += t.elapsed().as_secs_f64();
        evaluated?;
        self.budget().map_err(Into::into)
    }
}
fn callback(
    user: Handle,
    f: impl FnOnce(&mut Callbacks<'_>) -> Result<(), CallbackFailure>,
) -> c_int {
    let state = unsafe { &mut *(user as *mut Callbacks<'_>) };
    match catch_unwind(AssertUnwindSafe(|| f(state))) {
        Ok(Ok(())) => 0,
        Ok(Err(CallbackFailure::Fatal(e))) => {
            state.error = Some(e);
            -1
        }
        Ok(Err(CallbackFailure::Domain(e))) => {
            state.recoverable_errors += 1;
            state.last_recoverable = Some(e);
            1
        }
        Err(_) => {
            state.error = Some("Panic contained at offline callback boundary".into());
            -1
        }
    }
}
unsafe extern "C" fn residual(_: f64, y: Handle, yp: Handle, r: Handle, user: Handle) -> c_int {
    callback(user, |c| {
        c.budget()?;
        let start = Instant::now();
        let n = c.model.state_count();
        c.rhs_calls += 1;
        let evaluated = c.evaluate_trial(y);
        c.rhs_seconds += start.elapsed().as_secs_f64();
        evaluated?;
        let rates = c.work.rates().map_err(str::to_owned)?;
        let slopes = unsafe { values(yp, n) }?;
        for ((out, &s), &rate) in unsafe { output(r, n) }?.iter_mut().zip(slopes).zip(rates) {
            *out = s - rate;
        }
        c.budget().map_err(Into::into)
    })
}
unsafe extern "C" fn jtsetup(
    _: f64,
    y: Handle,
    _: Handle,
    _: Handle,
    _: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| c.base(y))
}
unsafe extern "C" fn jtimes(
    _: f64,
    _: Handle,
    _: Handle,
    _: Handle,
    v: Handle,
    jv: Handle,
    cj: f64,
    user: Handle,
    _: Handle,
    _: Handle,
) -> c_int {
    callback(user, |c| {
        c.budget()?;
        let start = Instant::now();
        let n = c.model.state_count();
        let direction = unsafe { values(v, n) }?;
        c.model
            .jvp_into(direction, &mut c.work)
            .map_err(str::to_owned)?;
        let tangent = c.work.rate_jvp().map_err(str::to_owned)?;
        for ((out, &d), &a) in unsafe { output(jv, n) }?
            .iter_mut()
            .zip(direction)
            .zip(tangent)
        {
            *out = cj * d - a;
        }
        c.jvp_calls += 1;
        c.jvp_seconds += start.elapsed().as_secs_f64();
        c.budget().map_err(Into::into)
    })
}
unsafe extern "C" fn psetup(
    _: f64,
    y: Handle,
    _: Handle,
    _: Handle,
    cj: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| {
        c.base(y)?;
        c.preconditioner
            .setup(c.model, &c.work, cj, c.memory, c.started, c.last_admitted)?;
        c.budget().map_err(Into::into)
    })
}
unsafe extern "C" fn psolve(
    _: f64,
    _: Handle,
    _: Handle,
    _: Handle,
    r: Handle,
    z: Handle,
    _: f64,
    _: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| {
        c.budget()?;
        c.preconditioner.solve(r, z, c.model.nc_dimension())?;
        c.budget().map_err(Into::into)
    })
}

#[derive(Default)]
struct Stats {
    steps: c_long,
    residuals: c_long,
    setups: c_long,
    error_fails: c_long,
    nonlinear_iterations: c_long,
    nonlinear_fails: c_long,
    linear_iterations: c_long,
    linear_fails: c_long,
    prec_evals: c_long,
    prec_solves: c_long,
    jtimes: c_long,
    initial_h: f64,
    last_h: f64,
    current_h: f64,
    cj: f64,
}
impl Stats {
    fn read(memory: Handle) -> Result<Self, String> {
        let mut s = Self::default();
        macro_rules! get {
            ($fn:ident,$field:ident) => {
                checked(unsafe { $fn(memory, &mut s.$field) }, stringify!($fn))?;
            };
        }
        get!(IDAGetNumSteps, steps);
        get!(IDAGetNumResEvals, residuals);
        get!(IDAGetNumLinSolvSetups, setups);
        get!(IDAGetNumErrTestFails, error_fails);
        get!(IDAGetNumNonlinSolvIters, nonlinear_iterations);
        get!(IDAGetNumNonlinSolvConvFails, nonlinear_fails);
        get!(IDAGetNumLinIters, linear_iterations);
        get!(IDAGetNumLinConvFails, linear_fails);
        get!(IDAGetNumPrecEvals, prec_evals);
        get!(IDAGetNumPrecSolves, prec_solves);
        get!(IDAGetNumJtimesEvals, jtimes);
        get!(IDAGetActualInitStep, initial_h);
        get!(IDAGetLastStep, last_h);
        get!(IDAGetCurrentStep, current_h);
        get!(IDAGetCurrentCj, cj);
        Ok(s)
    }
    fn json(&self) -> String {
        format!(
            "{{\"accepted_steps\":{},\"residuals\":{},\"linear_setups\":{},\"error_test_failures\":{},\"nonlinear_iterations\":{},\"nonlinear_failures\":{},\"linear_iterations\":{},\"linear_failures\":{},\"preconditioner_evals\":{},\"preconditioner_solves\":{},\"jtimes\":{},\"initial_h\":{},\"last_h\":{},\"current_h\":{},\"cj\":{}}}",
            self.steps,
            self.residuals,
            self.setups,
            self.error_fails,
            self.nonlinear_iterations,
            self.nonlinear_fails,
            self.linear_iterations,
            self.linear_fails,
            self.prec_evals,
            self.prec_solves,
            self.jtimes,
            finite(self.initial_h),
            finite(self.last_h),
            finite(self.current_h),
            finite(self.cj)
        )
    }
}
fn telemetry_stats(memory: Handle) -> (String, String) {
    match Stats::read(memory) {
        Ok(s) => (s.json(), "null".into()),
        Err(e) => ("null".into(), quote(&e)),
    }
}
struct Sample {
    time: f64,
    y: Vec<f64>,
    d: Diagnostics,
}
struct Run {
    passed: bool,
    reason: String,
    last_admitted: f64,
    returned: f64,
    wall: f64,
    samples: Vec<Sample>,
    stats: Stats,
    initial_wrms: f64,
    dominant_row: usize,
    dominant_weighted: f64,
    rhs_calls: u64,
    jvp_calls: u64,
    base_calls: u64,
    rhs_seconds: f64,
    jvp_seconds: f64,
    base_seconds: f64,
    prec_setup_seconds: f64,
    prec_solve_seconds: f64,
    workspace_bytes: usize,
    max_rhs_number_defect: f64,
    max_integrated_number_defect: f64,
    max_integrated_energy_defect: f64,
    max_cf_error: f64,
    failure_y: Vec<f64>,
    failure_yp: Vec<f64>,
    recoverable_errors: u64,
    last_recoverable: Option<String>,
    step_trace: Vec<(f64, f64)>,
    min_accepted_h: f64,
    max_accepted_h: f64,
    screen_output_calls: u64,
    screen_output_seconds: f64,
}
fn diagnostic_json(d: Diagnostics) -> String {
    format!(
        "{{\"N\":{},\"C\":{},\"retained_J\":{},\"fission_events_s\":{},\"induced_fission_events_s\":{},\"net_neutron_events_s\":{},\"escape_s\":{},\"collection_s\":{},\"captures_s\":{},\"Cf_births_s\":{},\"Cf_release_W\":{},\"fuel_release_W\":{},\"Mn_electron_W\":{},\"Mn_photon_W\":{}}}",
        finite(d.neutrons),
        finite(d.precursors),
        finite(d.retained_energy_j),
        finite(d.fission_events_s),
        finite(d.induced_fission_events_s),
        finite(d.net_neutron_events_s),
        finite(d.escape_neutrons_s),
        finite(d.collected_events_s),
        finite(d.capture_events_s),
        finite(d.cf_births_s),
        finite(d.cf_release_w),
        finite(d.fuel_release_w),
        finite(d.mn_electron_release_w),
        finite(d.mn_photon_release_w)
    )
}
impl Run {
    fn json(&self) -> String {
        let startup_steps = self
            .step_trace
            .iter()
            .map(|(t, h)| format!("[{t:e},{h:e}]"))
            .collect::<Vec<_>>()
            .join(",");
        let trace=self.samples.iter().map(|s|format!("{{\"time\":{},\"kind\":\"IDAGetDky-common-time-interpolation\",\"observables\":{}}}",s.time,diagnostic_json(s.d))).collect::<Vec<_>>().join(",");
        let failure = if self.passed {
            "null".into()
        } else {
            format!(
                "{{\"y\":{},\"yp\":{},\"cj\":{}}}",
                numbers(&self.failure_y),
                numbers(&self.failure_yp),
                finite(self.stats.cj)
            )
        };
        format!(
            "{{\"passed\":{},\"reason\":{},\"lastAdmittedTime\":{},\"returnedTime\":{},\"wallSeconds\":{},\"stats\":{},\"initialWeightedDerivativeWRMS\":{},\"initialDominantRow\":{},\"initialDominantWeightedDerivative\":{},\"RHSCalls\":{},\"JVPCalls\":{},\"linearBaseCalls\":{},\"RHSSeconds\":{},\"JVPSeconds\":{},\"linearBaseSeconds\":{},\"preconditionerSetupSeconds\":{},\"preconditionerSolveSeconds\":{},\"workspacePayloadBytes\":{},\"recoverableDomainErrors\":{},\"lastRecoverableDomainError\":{},\"startupAcceptedStepsTimeH\":[{}],\"minAcceptedH\":{},\"maxAcceptedH\":{},\"screenOutputCalls\":{},\"screenOutputSeconds\":{},\"maxRHSNumberDefect\":{},\"maxIntegratedNumberDefect\":{},\"maxIntegratedEnergyDefectJ\":{},\"maxCfProgressErrorJ\":{},\"trace\":[{}],\"failureSnapshot\":{}}}",
            self.passed,
            quote(&self.reason),
            finite(self.last_admitted),
            finite(self.returned),
            finite(self.wall),
            self.stats.json(),
            finite(self.initial_wrms),
            self.dominant_row,
            finite(self.dominant_weighted),
            self.rhs_calls,
            self.jvp_calls,
            self.base_calls,
            finite(self.rhs_seconds),
            finite(self.jvp_seconds),
            finite(self.base_seconds),
            finite(self.prec_setup_seconds),
            finite(self.prec_solve_seconds),
            self.workspace_bytes,
            self.recoverable_errors,
            self.last_recoverable
                .as_ref()
                .map_or("null".into(), |s| quote(s)),
            startup_steps,
            finite(self.min_accepted_h),
            finite(self.max_accepted_h),
            self.screen_output_calls,
            finite(self.screen_output_seconds),
            finite(self.max_rhs_number_defect),
            finite(self.max_integrated_number_defect),
            finite(self.max_integrated_energy_defect),
            finite(self.max_cf_error),
            trace,
            failure
        )
    }
}

fn run(
    model: &Evolution,
    relative: f64,
    started: Instant,
    allowance: f64,
    checkpoint_path: &Path,
) -> Result<Run, String> {
    let run_started = Instant::now();
    let n = model.state_count();
    let initial = model.initial_state();
    model.validate_accepted_state(&initial)?;
    let mut work = model.workspace();
    model
        .evaluate_into(&initial, &mut work)
        .map_err(str::to_owned)?;
    let slopes = work.rates().map_err(str::to_owned)?.to_vec();
    let mut absolute = vec![COUNT_ATOL; n];
    for r in model.energy_rows() {
        absolute[r] = ENERGY_ATOL;
    }
    let mut norm = 0.;
    let mut ranked_derivatives = Vec::with_capacity(n);
    let (mut dominant_row, mut dominant_weighted) = (0, 0.);
    for i in 0..n {
        let v = (slopes[i] / (absolute[i] + relative * initial[i].abs())).abs();
        ranked_derivatives.push((i, v));
        norm += v * v;
        if v > dominant_weighted {
            dominant_weighted = v;
            dominant_row = i;
        }
    }
    let initial_wrms = (norm / n as f64).sqrt();
    if !initial_wrms.is_finite() || !dominant_weighted.is_finite() {
        return Err("Nonfinite initial derivative weight norm".into());
    }
    ranked_derivatives.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
    let top=ranked_derivatives.iter().take(8).map(|&(row,weighted)|format!("{{\"row\":{row},\"weightedDerivative\":{weighted:e},\"derivative\":{},\"absoluteTolerance\":{}}}",finite(slopes[row]),finite(absolute[row]))).collect::<Vec<_>>().join(",");
    let estimated_h = (0.001 * HORIZON).min(0.5 / initial_wrms);
    println!(
        "{{\"kind\":\"initial-weights\",\"rtol\":{relative:e},\"coordinates\":{n},\"energyCoordinates\":{},\"countAtol\":{COUNT_ATOL:e},\"energyAtolJ\":{ENERGY_ATOL:e},\"initialWeightedDerivativeWRMS\":{initial_wrms:e},\"pinnedDefaultInitialStepEstimate\":{estimated_h:e},\"estimateIsNotAcceptedStep\":true,\"topWeightedDerivativeRows\":[{top}],\"aggregateElapsedSeconds\":{}}}",
        model.energy_rows().count(),
        finite(started.elapsed().as_secs_f64())
    );
    io::stdout()
        .flush()
        .map_err(|e| format!("Initial weight telemetry flush: {e}"))?;
    let workspace_bytes = work.buffer_bytes();
    let preconditioner = Preconditioner::new(model)?;
    let mut callbacks = Box::new(Callbacks {
        model,
        work,
        preconditioner,
        started,
        allowance,
        error: None,
        recoverable_errors: 0,
        last_recoverable: None,
        rhs_calls: 0,
        jvp_calls: 0,
        rhs_seconds: 0.,
        jvp_seconds: 0.,
        base_calls: 0,
        base_seconds: 0.,
        memory: ptr::null_mut(),
        last_admitted: 0.,
    });
    let mut owned = Resources::new()?;
    let y = owned.vector(&initial)?;
    let yp = owned.vector(&slopes)?;
    let atol = owned.vector(&absolute)?;
    let dense = owned.vector(&initial)?;
    let mut constraint = vec![1.; n];
    constraint[model.ledger_row()] = 0.;
    let constraint = owned.vector(&constraint)?;
    owned.spgmr(y, MAXL, RESTARTS)?;
    owned.ida = unsafe { IDACreate(owned.context) };
    callbacks.memory = owned.ida;
    if owned.ida.is_null() {
        return Err("IDACreate returned null".into());
    }
    checked(
        unsafe { IDAInit(owned.ida, residual, 0., y, yp) },
        "IDAInit",
    )?;
    checked(
        unsafe { IDASetUserData(owned.ida, (&mut *callbacks as *mut Callbacks<'_>).cast()) },
        "IDASetUserData",
    )?;
    checked(
        unsafe { IDASVtolerances(owned.ida, relative, atol) },
        "IDASVtolerances",
    )?;
    checked(
        unsafe { IDASetConstraints(owned.ida, constraint) },
        "IDASetConstraints",
    )?;
    checked(
        unsafe { IDASetLinearSolver(owned.ida, owned.solver, ptr::null_mut()) },
        "IDASetLinearSolver(SPGMR)",
    )?;
    checked(
        unsafe { IDASetJacTimes(owned.ida, Some(jtsetup), jtimes) },
        "IDASetJacTimes",
    )?;
    checked(
        unsafe { IDASetPreconditioner(owned.ida, psetup, psolve) },
        "IDASetPreconditioner",
    )?;
    checked(
        unsafe { IDASetStopTime(owned.ida, HORIZON) },
        "IDASetStopTime",
    )?;
    let mut out = Run {
        passed: false,
        reason: String::new(),
        last_admitted: 0.,
        returned: 0.,
        wall: 0.,
        samples: Vec::new(),
        stats: Stats::default(),
        initial_wrms,
        dominant_row,
        dominant_weighted,
        rhs_calls: 0,
        jvp_calls: 0,
        base_calls: 0,
        rhs_seconds: 0.,
        jvp_seconds: 0.,
        base_seconds: 0.,
        prec_setup_seconds: 0.,
        prec_solve_seconds: 0.,
        workspace_bytes,
        max_rhs_number_defect: 0.,
        max_integrated_number_defect: 0.,
        max_integrated_energy_defect: 0.,
        max_cf_error: 0.,
        failure_y: Vec::new(),
        failure_yp: Vec::new(),
        recoverable_errors: 0,
        last_recoverable: None,
        step_trace: Vec::new(),
        min_accepted_h: f64::INFINITY,
        max_accepted_h: 0.,
        screen_output_calls: 0,
        screen_output_seconds: 0.,
    };
    let mut sample = 0;
    let mut admitted_steps = 0u64;
    let mut checkpoint_time = Instant::now();
    if checkpoint_path.exists() {
        return Err("Refusing to replace an existing run checkpoint".into());
    }
    checkpoint(
        relative,
        0.,
        0,
        started.elapsed().as_secs_f64(),
        checkpoint_path,
        &initial,
        &slopes,
        &callbacks,
        owned.ida,
    )?;
    let advancement = (|| -> Result<(), String> {
        loop {
            if let Err(e) = callbacks.budget() {
                out.reason = e;
                break;
            }
            let status = unsafe { IDASolve(owned.ida, HORIZON, &mut out.returned, y, yp, 2) }; // IDA_ONE_STEP
            if status < 0 {
                out.reason = format!("IDASolve returned {status}; callback={:?}", callbacks.error);
                break;
            }
            let screen_start = Instant::now();
            let state = unsafe { values(y, n) }?;
            if let Err(e) = model.validate_accepted_state(state) {
                let negative = state
                    .iter()
                    .enumerate()
                    .filter(|(_, x)| **x < 0.)
                    .min_by(|a, b| a.1.total_cmp(b.1));
                out.reason = format!(
                    "Accepted physical boundary: {e}; most negative row/value={negative:?}"
                );
                break;
            }
            model
                .evaluate_into(state, &mut callbacks.work)
                .map_err(str::to_owned)?;
            let d = callbacks.work.diagnostics().map_err(str::to_owned)?;
            finite_diagnostics(d)?;
            let rates = callbacks.work.rates().map_err(str::to_owned)?;
            let rhs_defect =
                (rates[..model.nc_dimension()].iter().sum::<f64>() - d.net_neutron_events_s).abs();
            let rhs_scale = d.neutron_event_scale_s;
            let balances = model.conservation(state).map_err(str::to_owned)?;
            let integrated = balances.neutron_ledger_defect.abs();
            let integrated_scale = balances.neutron_ledger_scale;
            let energy_defect = balances.energy_ledger_defect_j.abs();
            let energy_scale = balances.energy_ledger_scale_j;
            if [
                rhs_defect,
                rhs_scale,
                integrated,
                integrated_scale,
                energy_defect,
                energy_scale,
            ]
            .iter()
            .any(|x| !x.is_finite() || *x < 0.)
            {
                return Err("Nonfinite/negative independent ledger scale or defect".into());
            }
            let expected_cf =
                -model.prepared_cf_energy() * (-model.cf_decay_rate() * out.returned).exp_m1();
            let cf_error = (state[model.cf_row()] - expected_cf).abs();
            if !expected_cf.is_finite() || !cf_error.is_finite() {
                return Err("Nonfinite exact Cf progress comparator".into());
            }
            out.max_rhs_number_defect = out.max_rhs_number_defect.max(rhs_defect);
            out.max_integrated_number_defect = out.max_integrated_number_defect.max(integrated);
            out.max_integrated_energy_defect = out.max_integrated_energy_defect.max(energy_defect);
            out.max_cf_error = out.max_cf_error.max(cf_error);
            if rhs_defect > 1e-10 * rhs_scale.max(1e-30)
                || integrated
                    > 1e-8 * integrated_scale + 10. * COUNT_ATOL * model.nc_dimension() as f64
                || energy_defect
                    > 1e-8 * energy_scale + 10. * ENERGY_ATOL * model.energy_rows().count() as f64
                || cf_error > 1e-3 * expected_cf.abs() + 20. * ENERGY_ATOL
            {
                out.reason = format!(
                    "Independent ledger/Cf boundary: RHS {rhs_defect:e}/{rhs_scale:e}, integrated {integrated:e}/{integrated_scale:e}, energy {energy_defect:e}/{energy_scale:e}, Cf {cf_error:e}/{expected_cf:e}"
                );
                break;
            }
            let h = out.returned - out.last_admitted;
            out.min_accepted_h = out.min_accepted_h.min(h);
            out.max_accepted_h = out.max_accepted_h.max(h);
            if out.step_trace.len() < 16 {
                out.step_trace.push((out.returned, h));
            }
            out.last_admitted = out.returned;
            callbacks.last_admitted = out.last_admitted;
            admitted_steps += 1;
            let mut crossed_output = false;
            while sample < OUTPUTS.len() && OUTPUTS[sample] <= out.returned {
                checked(
                    unsafe { IDAGetDky(owned.ida, OUTPUTS[sample], 0, dense) },
                    "IDAGetDky common output",
                )?;
                let common = unsafe { values(dense, n) }?.to_vec();
                model
                    .evaluate_into(&common, &mut callbacks.work)
                    .map_err(str::to_owned)?;
                let common_d = callbacks.work.diagnostics().map_err(str::to_owned)?;
                finite_diagnostics(common_d)?;
                out.samples.push(Sample {
                    time: OUTPUTS[sample],
                    y: common,
                    d: common_d,
                });
                sample += 1;
                crossed_output = true;
                out.screen_output_calls += 1;
            }
            out.screen_output_calls += 1;
            out.screen_output_seconds += screen_start.elapsed().as_secs_f64();
            if crossed_output || checkpoint_time.elapsed().as_secs_f64() >= 1. {
                checkpoint(
                    relative,
                    out.last_admitted,
                    admitted_steps,
                    started.elapsed().as_secs_f64(),
                    checkpoint_path,
                    unsafe { values(y, n) }?,
                    unsafe { values(yp, n) }?,
                    &callbacks,
                    owned.ida,
                )?;
                checkpoint_time = Instant::now();
            }
            if out.returned >= HORIZON {
                out.passed = true;
                out.reason = "300s reached with independent accepted-state screens".into();
                break;
            }
        }
        Ok(())
    })();
    if let Err(e) = advancement {
        out.reason = e;
    }
    match Stats::read(owned.ida) {
        Ok(stats) => out.stats = stats,
        Err(e) => {
            out.passed = false;
            out.reason = format!("{}; final statistics: {e}", out.reason);
        }
    }
    if !out.passed {
        out.failure_y = unsafe { values(y, n) }?.to_vec();
        out.failure_yp = unsafe { values(yp, n) }?.to_vec();
    }
    out.rhs_calls = callbacks.rhs_calls;
    out.recoverable_errors = callbacks.recoverable_errors;
    out.last_recoverable = callbacks.last_recoverable.clone();
    out.jvp_calls = callbacks.jvp_calls;
    out.base_calls = callbacks.base_calls;
    out.rhs_seconds = callbacks.rhs_seconds;
    out.jvp_seconds = callbacks.jvp_seconds;
    out.base_seconds = callbacks.base_seconds;
    out.prec_setup_seconds = callbacks.preconditioner.setup_seconds;
    out.prec_solve_seconds = callbacks.preconditioner.solve_seconds;
    out.wall = run_started.elapsed().as_secs_f64();
    Ok(out)
}

fn main() {
    let started = Instant::now();
    let result = catch_unwind(AssertUnwindSafe(|| main_result(started)))
        .unwrap_or_else(|_| Err("Panic during strict offline input construction/driver".into()));
    if let Err(e) = result {
        println!(
            "{{\"passed\":false,\"stage\":\"construction-or-driver\",\"reason\":{},\"lastAdmittedTime\":0,\"wallSeconds\":{}}}",
            quote(&e),
            finite(started.elapsed().as_secs_f64())
        );
        std::process::exit(1);
    }
}
fn main_result(started: Instant) -> Result<(), String> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 3 {
        return Err("Usage: source-evolution-ida FIXTURE_PATH AGGREGATE_ALLOWANCE_SECONDS".into());
    }
    let allowance: f64 = args[2].parse().map_err(|_| "Invalid allowance")?;
    if !allowance.is_finite() || allowance <= 0. {
        return Err("Invalid aggregate allowance".into());
    }
    let text = fs::read_to_string(&args[1]).map_err(|e| e.to_string())?;
    let prepared = evolution_input::parse(&text);
    let model = Evolution::new(prepared.input).map_err(str::to_owned)?;
    let construction = started.elapsed().as_secs_f64();
    let work_allowance = allowance - REPORT_RESERVE_SECONDS;
    if work_allowance <= 0. {
        return Err("Allowance does not include the fixed two-second report reserve".into());
    }
    let normal_path = format!("{}.normal.checkpoint", args[1]);
    let tighter_path = format!("{}.tighter.checkpoint", args[1]);
    let normal = run(
        &model,
        RTOL[0],
        started,
        work_allowance,
        Path::new(&normal_path),
    )?;
    let mut tighter_setup_error = None;
    let tighter = if normal.passed {
        match run(
            &model,
            RTOL[1],
            started,
            work_allowance,
            Path::new(&tighter_path),
        ) {
            Ok(r) => Some(r),
            Err(e) => {
                tighter_setup_error = Some(e);
                None
            }
        }
    } else {
        None
    };
    let mut passed = normal.passed && tighter.as_ref().is_some_and(|r| r.passed);
    let mut max_local_ratio: f64 = 0.;
    let mut max_family_ratio: f64 = 0.;
    let mut max_observable_ratio: f64 = 0.;
    let mut negligible_family_outputs = 0usize;
    let mut compared_family_outputs = 0usize;
    // Never SUMABS unlike units (counts and joules) into one error family.
    let mut families = vec![
        (0..prepared.neutron_coordinates).collect::<Vec<_>>(),
        (prepared.neutron_coordinates..model.nc_dimension()).collect(),
    ];
    for slot in 0..fuel_history::ENERGY {
        families.push(
            (0..prepared.segments)
                .map(|s| model.nc_dimension() + s * fuel_history::HISTORY + slot)
                .collect(),
        );
    }
    families.push(
        model
            .energy_rows()
            .filter(|&i| i < model.cf_row())
            .collect(),
    );
    families.push(vec![model.cf_row()]);
    families.push((model.history_dimension()..model.target_row(0)).collect());
    families.push((model.target_row(0)..model.mn_row(0)).collect());
    families.push((model.mn_row(0)..model.ledger_row()).collect());
    families.push(vec![model.escape_row(), model.collected_row()]);
    families.push(vec![model.fuel_release_row()]);
    let mut developed = true;
    if let Some(t) = &tighter {
        if passed {
            for (a, b) in normal.samples.iter().zip(&t.samples) {
                if a.time != b.time {
                    return Err("Common output times differ".into());
                }
                for i in 0..model.state_count() {
                    let atol = if model.is_energy_row(i) {
                        ENERGY_ATOL
                    } else {
                        COUNT_ATOL
                    };
                    let local = ratio((a.y[i] - b.y[i]).abs(), 1e-3 * b.y[i].abs() + 20. * atol)?;
                    max_local_ratio = max_local_ratio.max(local);
                }
                for rows in &families {
                    let error = rows.iter().map(|&i| (a.y[i] - b.y[i]).abs()).sum::<f64>();
                    let signal = rows.iter().map(|&i| b.y[i].abs()).sum::<f64>();
                    let resolution = rows
                        .iter()
                        .map(|&i| {
                            20. * if model.is_energy_row(i) {
                                ENERGY_ATOL
                            } else {
                                COUNT_ATOL
                            }
                        })
                        .sum::<f64>();
                    if !signal.is_finite() || !resolution.is_finite() || !error.is_finite() {
                        return Err("Nonfinite family comparison operand".into());
                    }
                    if signal > 100. * resolution {
                        compared_family_outputs += 1;
                        max_family_ratio =
                            max_family_ratio.max(ratio(error, 1e-3 * signal + resolution)?);
                    } else {
                        negligible_family_outputs += 1;
                    }
                }
                for (x, y, absolute_resolution) in [
                    (
                        a.d.induced_fission_events_s,
                        b.d.induced_fission_events_s,
                        COUNT_ATOL,
                    ),
                    (a.d.escape_neutrons_s, b.d.escape_neutrons_s, COUNT_ATOL),
                    (a.d.collected_events_s, b.d.collected_events_s, COUNT_ATOL),
                    (a.d.capture_events_s, b.d.capture_events_s, COUNT_ATOL),
                    (a.d.cf_release_w, b.d.cf_release_w, ENERGY_ATOL),
                    (a.d.fuel_release_w, b.d.fuel_release_w, ENERGY_ATOL),
                    (
                        a.d.mn_electron_release_w,
                        b.d.mn_electron_release_w,
                        ENERGY_ATOL,
                    ),
                    (
                        a.d.mn_photon_release_w,
                        b.d.mn_photon_release_w,
                        ENERGY_ATOL,
                    ),
                ] {
                    max_observable_ratio = max_observable_ratio.max(ratio(
                        (x - y).abs(),
                        1e-3 * y.abs() + 20. * absolute_resolution / b.time,
                    )?);
                }
            }
            if let (Some(a), Some(b)) = (normal.samples.last(), t.samples.last()) {
                for (x, y, resolution) in [
                    (
                        a.d.neutrons,
                        b.d.neutrons,
                        20. * COUNT_ATOL * prepared.neutron_coordinates as f64,
                    ),
                    (
                        a.d.precursors,
                        b.d.precursors,
                        20. * COUNT_ATOL
                            * (model.nc_dimension() - prepared.neutron_coordinates) as f64,
                    ),
                    (
                        a.d.retained_energy_j,
                        b.d.retained_energy_j,
                        20. * ENERGY_ATOL * (prepared.segments * 25) as f64,
                    ),
                    (
                        a.d.induced_fission_events_s,
                        b.d.induced_fission_events_s,
                        20. * COUNT_ATOL / b.time,
                    ),
                    (
                        a.d.collected_events_s,
                        b.d.collected_events_s,
                        20. * COUNT_ATOL / b.time,
                    ),
                    (
                        a.d.fuel_release_w,
                        b.d.fuel_release_w,
                        20. * ENERGY_ATOL / b.time,
                    ),
                ] {
                    if !x.is_finite() || !y.is_finite() || !resolution.is_finite() {
                        return Err("Nonfinite developed response operand".into());
                    }
                    developed &= y > resolution && y > 100. * (x - y).abs();
                }
            } else {
                developed = false;
            }
            passed &= max_local_ratio <= 1.
                && max_family_ratio <= 1.
                && max_observable_ratio <= 1.
                && developed;
        }
    }
    passed &= started.elapsed().as_secs_f64() <= allowance;
    let last = if let Some(t) = &tighter {
        normal.last_admitted.min(t.last_admitted)
    } else if normal.passed {
        0.
    } else {
        normal.last_admitted
    };
    println!(
        "{{\"passed\":{passed},\"scope\":\"Birth-driven represented ORIGINAL fixed-geometry/fixed-temperature source and finite target/history advancement; no thermal feedback, deposited heat, plant or live qualification\",\"coordinates\":{},\"physicalCoordinates\":{},\"auditIntegrals\":{},\"neutronCoordinates\":{},\"precursorCoordinates\":{},\"segments\":{},\"waterOwners\":{},\"targets\":{},\"MnTargets\":{},\"lastAdmittedTime\":{},\"constructionSeconds\":{},\"wallSeconds\":{},\"settings\":{{\"horizon\":300,\"rtol\":[1e-5,1e-6],\"countAtol\":1e-3,\"energyAtolJ\":1e-12,\"SPGMRmaxl\":30,\"SPGMRrestarts\":0,\"nonnegativeConstraints\":true,\"allowanceSeconds\":{},\"reportReserveSeconds\":2,\"rateResolution\":\"chosen20atol/time;notderivedstockerrorbound\",\"outputs\":{:?}}},\"gates\":{{\"localPairRatio\":{},\"SUMABSFamilyPairRatio\":{},\"observablePairRatio\":{},\"comparedFamilyOutputs\":{compared_family_outputs},\"negligibleFamilyOutputs\":{negligible_family_outputs},\"developedSignal\":{developed},\"strictAcceptedBoundary\":true}},\"normal\":{},\"tighter\":{},\"tighterSetupFailure\":{}}}",
        model.state_count(),
        model.ledger_row(),
        model.state_count() - model.ledger_row(),
        prepared.neutron_coordinates,
        model.nc_dimension() - prepared.neutron_coordinates,
        prepared.segments,
        prepared.water_owners,
        prepared.targets,
        prepared.mn_targets,
        finite(last),
        finite(construction),
        finite(started.elapsed().as_secs_f64()),
        finite(allowance),
        OUTPUTS,
        finite(max_local_ratio),
        finite(max_family_ratio),
        finite(max_observable_ratio),
        normal.json(),
        tighter.as_ref().map_or("null".into(), Run::json),
        tighter_setup_error
            .as_ref()
            .map_or("null".into(), |s| quote(s))
    );
    if !passed {
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_strings_and_nonfinite_snapshots_remain_json() {
        assert_eq!(quote("x\n\"\\\u{0001}"), "\"x\\n\\\"\\\\\\u0001\"");
        assert_eq!(numbers(&[1., f64::NAN, f64::INFINITY]), "[1e0,null,null]");
    }
    #[test]
    fn selected_spgmr_constructor_and_owned_cleanup() {
        let mut resources = Resources::new().unwrap();
        let vector = resources.vector(&[0., 0.]).unwrap();
        assert!(!resources.spgmr(vector, MAXL, RESTARTS).unwrap().is_null());
        assert!(resources.spgmr(vector, MAXL, RESTARTS).is_err());
    }
    #[test]
    fn nonfinite_independent_metrics_never_pass_by_max_or_comparison() {
        assert!(ratio(f64::NAN, 1.).is_err());
        assert!(ratio(1., f64::INFINITY).is_err());
        assert!(ratio(f64::MAX, f64::MIN_POSITIVE).is_err());
        let mut d = Diagnostics::default();
        d.neutron_event_scale_s = f64::NAN;
        assert!(finite_diagnostics(d).is_err());
        assert!(matches!(
            trial_failure("Invalid advancing optical target amounts"),
            CallbackFailure::Domain(_)
        ));
        assert!(matches!(
            trial_failure("Nonfinite full source JVP"),
            CallbackFailure::Fatal(_)
        ));
    }
}

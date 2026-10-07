//! ONE offline normal/tighter source-history advancement. No thermal feedback,
//! fixed neutron normalization, retry policy, alternate solver or live plant.
#![allow(dead_code)]
#[path = "evolution_input/mod.rs"]
mod evolution_input;
#[path = "../examples/ida_support/mod.rs"]
mod ida_support;
#[path = "source_accuracy.rs"]
mod source_accuracy;
#[path = "source_pair.rs"]
mod source_pair;
use source_pair::*;
#[path = "source_input/mod.rs"]
mod source_input;
use ida_support::*;
use leitbild_plant_numerics::{
    converter_heat, cylindrical_source, fuel_history, fuel_source, heat_history, moderator_source,
    optical_source, passive_source, source_evolution, transport_source,
};
use source_accuracy::Accuracy;
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
const REPORT_RESERVE_SECONDS: f64 = 2.;
const CHECKPOINT_MAGIC: &[u8; 9] = b"LDSRC-MNF";
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
fn compared(evaluated: bool, value: impl ToString) -> String {
    if evaluated {
        value.to_string()
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
    file.write_all(CHECKPOINT_MAGIC)
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
        "{{\"kind\":\"admitted-progress\",\"stateChart\":\"LDSRC-MNF\",\"rtol\":{relative:e},\"lastAdmittedTime\":{time:e},\"lastRetainedStateTime\":{time:e},\"checkpointPath\":{},\"acceptedScreenedSteps\":{steps},\"aggregateElapsedSeconds\":{elapsed:e},\"stateSource\":\"initial-or-IDAGetDky-retained-endpoint\",\"derivativeSource\":\"initial-RHS-or-IDAGetDky-endpoint-polynomial;not-Newton-stage-derivative\",\"solverStats\":{stats},\"telemetryStatsError\":{stats_error},\"measuredKernelCosts\":{}}}",
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

#[path = "source_coordinates/mod.rs"]
mod source_coordinates;
use source_coordinates::Coordinates;
#[path = "source_block/mod.rs"]
mod source_block;
#[path = "source_stage/mod.rs"]
mod source_stage;

struct Callbacks<'a> {
    model: &'a Evolution,
    work: Workspace,
    coordinates: Coordinates,
    physical_state: Vec<f64>,
    physical_direction: Vec<f64>,
    stage: Option<source_stage::Stage>,
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
}
#[derive(Debug)]
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
impl<'a> Callbacks<'a> {
    fn new(
        model: &'a Evolution,
        work: Workspace,
        started: Instant,
        allowance: f64,
    ) -> Result<Self, String> {
        let n = model.state_count();
        Ok(Self {
            model,
            work,
            coordinates: Coordinates {
                nc: model.nc_dimension(),
                ledger: model.ledger_row(),
            },
            physical_state: vec![0.; n],
            physical_direction: vec![0.; n],
            stage: None,
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
        })
    }
    fn metrics_json(&self) -> String {
        format!(
            "{{\"RHSAttempts\":{},\"RHSSeconds\":{},\"linearBaseAttempts\":{},\"linearBaseSeconds\":{},\"linearActionCalls\":{},\"linearActionSeconds\":{},\"linearStageAndPreconditioner\":{},\"recoverableDomainErrors\":{}}}",
            self.rhs_calls,
            finite(self.rhs_seconds),
            self.base_calls,
            finite(self.base_seconds),
            self.jvp_calls,
            finite(self.jvp_seconds),
            self.stage
                .as_ref()
                .map_or("null".into(), |d| d.metrics_json()),
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
        self.coordinates.physical(state, &mut self.physical_state);
        self.model
            .evaluate_into(&self.physical_state, &mut self.work)
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
    if user.is_null() {
        return -1;
    }
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
        fill_solver_residual(c.coordinates, rates, slopes, unsafe { output(r, n) }?)?;
        c.budget().map_err(Into::into)
    })
}
fn fill_solver_residual(
    c: Coordinates,
    physical_rates: &[f64],
    solver_slopes: &[f64],
    out: &mut [f64],
) -> Result<(), String> {
    if physical_rates.len() != solver_slopes.len()
        || out.len() != physical_rates.len()
        || c.ledger >= out.len()
        || c.nc > out.len()
    {
        return Err("Wrong solver residual dimension".into());
    }
    for ((out, &s), &r) in out.iter_mut().zip(solver_slopes).zip(physical_rates) {
        *out = s - r;
    }
    // Preserve this arithmetic order in the fixed-state actual -F audit.
    out[c.ledger] = solver_slopes[c.ledger]
        - (physical_rates[..c.nc].iter().sum::<f64>() - physical_rates[c.ledger]);
    if out.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite solver residual".into());
    }
    Ok(())
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
        c.coordinates.physical(direction, &mut c.physical_direction);
        c.model
            .jvp_into(&c.physical_direction, &mut c.work)
            .map_err(str::to_owned)?;
        let tangent = c.work.rate_jvp().map_err(str::to_owned)?;
        for ((out, &d), &a) in unsafe { output(jv, n) }?
            .iter_mut()
            .zip(direction)
            .zip(tangent)
        {
            *out = cj * d - a;
        }
        let ledger = c.coordinates.ledger;
        unsafe { output(jv, n) }?[ledger] = cj * direction[ledger]
            - (tangent[..c.coordinates.nc].iter().sum::<f64>() - tangent[ledger]);
        c.jvp_calls += 1;
        c.jvp_seconds += start.elapsed().as_secs_f64();
        c.budget().map_err(Into::into)
    })
}
// The complete chain-rule JVP uses the fresh JTsetup workspace and current
// cj. Psetup independently freezes its own full-CSC-derived snapshot.
unsafe extern "C" fn block_setup(
    _: f64,
    y: Handle,
    _: Handle,
    _: Handle,
    cj: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| {
        c.budget()?;
        let n = c.model.state_count();
        c.coordinates
            .physical(unsafe { values(y, n) }?, &mut c.physical_state);
        c.stage
            .as_mut()
            .ok_or("Missing compiled stage owner".to_owned())?
            .setup_preconditioner(c.model, &c.physical_state, cj)?;
        c.budget().map_err(Into::into)
    })
}
unsafe extern "C" fn block_solve(
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
        let n = c.model.state_count();
        c.stage
            .as_mut()
            .ok_or("Missing compiled stage owner".to_owned())?
            .solve_preconditioner(unsafe { values(r, n) }?, unsafe { output(z, n) }?)?;
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
    jtimes: c_long,
    preconditioner_setups: c_long,
    preconditioner_solves: c_long,
    linear_iterations: c_long,
    linear_fails: c_long,
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
        get!(IDAGetNumJtimesEvals, jtimes);
        get!(IDAGetNumPrecEvals, preconditioner_setups);
        get!(IDAGetNumPrecSolves, preconditioner_solves);
        get!(IDAGetNumLinIters, linear_iterations);
        get!(IDAGetNumLinConvFails, linear_fails);
        get!(IDAGetActualInitStep, initial_h);
        get!(IDAGetLastStep, last_h);
        get!(IDAGetCurrentStep, current_h);
        get!(IDAGetCurrentCj, cj);
        Ok(s)
    }
    fn json(&self) -> String {
        format!(
            "{{\"accepted_steps\":{},\"residuals\":{},\"linear_setups\":{},\"error_test_failures\":{},\"nonlinear_iterations\":{},\"nonlinear_failures\":{},\"complete_chain_rule_actions\":{},\"preconditioner_setups\":{},\"preconditioner_solves\":{},\"linear_iterations\":{},\"linear_failures\":{},\"initial_h\":{},\"last_h\":{},\"current_h\":{},\"cj\":{}}}",
            self.steps,
            self.residuals,
            self.setups,
            self.error_fails,
            self.nonlinear_iterations,
            self.nonlinear_fails,
            self.jtimes,
            self.preconditioner_setups,
            self.preconditioner_solves,
            self.linear_iterations,
            self.linear_fails,
            finite(self.initial_h),
            finite(self.last_h),
            finite(self.current_h),
            finite(self.cj)
        )
    }
}
fn telemetry_stats(memory: Handle) -> (String, String) {
    if memory.is_null() {
        return (
            "null".into(),
            quote("No IDA memory supplied to non-advancing block test"),
        );
    }
    match Stats::read(memory) {
        Ok(s) => (s.json(), "null".into()),
        Err(e) => ("null".into(), quote(&e)),
    }
}
struct Sample {
    time: f64,
    y: Vec<f64>,
    d: Diagnostics,
    captured_targets: Vec<f64>,
    nc_coefficients: Vec<f64>,
}
impl Sample {
    fn view(&self) -> SourceSample<'_> {
        SourceSample {
            time: self.time,
            y: &self.y,
            d: self.d,
            captured_targets: &self.captured_targets,
            nc_coefficients: &self.nc_coefficients,
        }
    }
}
fn captured_targets(model: &Evolution, y: &[f64]) -> Result<Vec<f64>, String> {
    (0..model.mn_product_row(0) - model.target_row(0))
        .map(|i| model.consumed_target(y, i).map_err(str::to_owned))
        .collect()
}
fn nc_coefficients(model: &Evolution, work: &Workspace) -> Result<Vec<f64>, String> {
    let mut values = vec![0.; model.nc_pattern().len()];
    model
        .nc_values(work, 0., &mut values)
        .map_err(str::to_owned)?;
    if values.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite common NC coefficients".into());
    }
    Ok(values)
}
// Retain dense common observations separately from accepted endpoint
// checkpoints. These y-only files are not restart or admission records.
fn retain_common(
    path: &Path,
    sample: usize,
    relative: f64,
    time: f64,
    y: &[f64],
) -> Result<(), String> {
    let name = format!("{}.common-{sample}.state", path.display());
    let mut file = io::BufWriter::new(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&name)
            .map_err(|e| format!("New common observation file: {e}"))?,
    );
    file.write_all(b"LDSRC-CMN")
        .and_then(|_| file.write_all(&(y.len() as u64).to_le_bytes()))
        .and_then(|_| file.write_all(&time.to_le_bytes()))
        .and_then(|_| file.write_all(&relative.to_le_bytes()))
        .map_err(|e| format!("Common observation header: {e}"))?;
    for value in y {
        file.write_all(&value.to_le_bytes())
            .map_err(|e| format!("Common observation state: {e}"))?;
    }
    file.flush()
        .map_err(|e| format!("Common observation flush: {e}"))?;
    println!(
        "{{\"kind\":\"common-state-retained\",\"stateChart\":\"LDSRC-MNF\",\"fileFormat\":\"LDSRC-CMN-y-only\",\"source\":\"IDAGetDky-common-time-interpolation;not-accepted-boundary-or-restart\",\"time\":{time:e},\"rtol\":{relative:e},\"path\":{}}}",
        quote(&name)
    );
    io::stdout()
        .flush()
        .map_err(|e| format!("Common observation metadata flush: {e}"))
}
fn check_schedule(samples: &[Sample]) -> Result<(), String> {
    if samples.len() != OUTPUTS.len()
        || samples
            .iter()
            .zip(OUTPUTS)
            .any(|(sample, time)| sample.time != time)
    {
        return Err("Missing, truncated or mismatched common output schedule".into());
    }
    Ok(())
}
fn common_output_due(sample: usize, returned: f64, diagnostic_end: Option<f64>) -> bool {
    sample < OUTPUTS.len()
        && OUTPUTS[sample] <= returned
        && diagnostic_end.is_none_or(|end| OUTPUTS[sample] <= end)
}
fn diagnostic_prefix_complete(samples: &[Sample], end: f64) -> bool {
    let expected = OUTPUTS
        .iter()
        .take_while(|&&time| time <= end)
        .copied()
        .collect::<Vec<_>>();
    samples.len() == expected.len()
        && samples
            .iter()
            .zip(expected)
            .all(|(sample, time)| sample.time == time)
}
struct Run {
    passed: bool,
    diagnostic_completed: bool,
    partial_pair: Option<PairComparison>,
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
    stage_metrics: String,
    workspace_bytes: usize,
    max_rhs_number_defect: f64,
    max_integrated_number_defect: f64,
    max_integrated_energy_defect: f64,
    max_cf_error: f64,
    failure_y: Vec<f64>,
    failure_yp: Vec<f64>,
    failure_snapshot_source: &'static str,
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
        let trace=self.samples.iter().map(|s|format!("{{\"time\":{},\"kind\":\"IDAGetDky-common-time-interpolation\",\"observables\":{},\"targetCaptureConsumption\":{}}}",s.time,diagnostic_json(s.d),finite(s.captured_targets.iter().sum()))).collect::<Vec<_>>().join(",");
        let failure = if self.passed || self.diagnostic_completed {
            "null".into()
        } else {
            format!(
                "{{\"y\":{},\"yp\":{},\"cj\":{},\"source\":{}}}",
                numbers(&self.failure_y),
                numbers(&self.failure_yp),
                finite(self.stats.cj),
                quote(self.failure_snapshot_source)
            )
        };
        let partial_pair = self
            .partial_pair
            .as_ref()
            .map_or("null".into(), PairComparison::json);
        format!(
            "{{\"passed\":{},\"partialPairComparison\":{partial_pair},\"reason\":{},\"lastAdmittedTime\":{},\"returnedTime\":{},\"wallSeconds\":{},\"stats\":{},\"initialWeightedDerivativeWRMS\":{},\"initialDominantRow\":{},\"initialDominantWeightedDerivative\":{},\"RHSCalls\":{},\"JVPCalls\":{},\"linearBaseCalls\":{},\"RHSSeconds\":{},\"JVPSeconds\":{},\"linearBaseSeconds\":{},\"linearStage\":{},\"workspacePayloadBytes\":{},\"recoverableDomainErrors\":{},\"lastRecoverableDomainError\":{},\"startupAcceptedStepsTimeH\":[{}],\"minAcceptedH\":{},\"maxAcceptedH\":{},\"screenOutputCalls\":{},\"screenOutputSeconds\":{},\"maxRHSNumberDefect\":{},\"maxIntegratedNumberDefect\":{},\"maxIntegratedEnergyDefectJ\":{},\"maxCfProgressErrorJ\":{},\"trace\":[{}],\"failureSnapshot\":{}}}",
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
            self.stage_metrics,
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
    accuracy: &Accuracy,
    relative: f64,
    absolute_refinement: f64,
    started: Instant,
    allowance: f64,
    checkpoint_path: &Path,
    diagnostic_end: Option<f64>,
    reference_samples: Option<&[Sample]>,
) -> Result<Run, String> {
    if let Some(reference) = reference_samples {
        check_schedule(reference)?;
    }
    let pair_comparator = reference_samples.map(|_| PairComparator::new(model, accuracy));
    let run_started = Instant::now();
    let n = model.state_count();
    let mut initial = model.initial_state();
    model.validate_accepted_state(&initial)?;
    let mut work = model.workspace();
    model
        .evaluate_into(&initial, &mut work)
        .map_err(str::to_owned)?;
    let mut slopes = work.rates().map_err(str::to_owned)?.to_vec();
    let coordinates = Coordinates {
        nc: model.nc_dimension(),
        ledger: model.ledger_row(),
    };
    coordinates.transform(&mut initial);
    coordinates.transform(&mut slopes);
    let absolute = accuracy.absolute(absolute_refinement)?;
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
        "{{\"kind\":\"initial-weights\",\"rtol\":{relative:e},\"accuracyPolicy\":\"source-consequences-1\",\"provisional\":true,\"absoluteToleranceDivisor\":{absolute_refinement:e},\"coordinates\":{n},\"energyCoordinates\":{},\"countAtol\":{COUNT_ATOL:e},\"energyAtolJ\":{ENERGY_ATOL:e},\"solverLedgerCoordinate\":\"D=sum(N,C)-independentEventLedger\",\"ledgerConstraint\":\"unconstrained\",\"ledgerErrorMetric\":\"same-count-atol;stricter-aggregate-WRMS\",\"retainedCoordinates\":\"physical-event-ledger-L\",\"initialWeightedDerivativeWRMS\":{initial_wrms:e},\"pinnedDefaultInitialStepEstimate\":{estimated_h:e},\"estimateIsNotAcceptedStep\":true,\"topWeightedDerivativeRows\":[{top}],\"aggregateElapsedSeconds\":{}}}",
        model.energy_rows().count(),
        finite(started.elapsed().as_secs_f64())
    );
    io::stdout()
        .flush()
        .map_err(|e| format!("Initial weight telemetry flush: {e}"))?;
    let workspace_bytes = work.buffer_bytes();
    let mut callbacks = Box::new(Callbacks::new(model, work, started, allowance)?);
    callbacks.stage = Some(source_stage::Stage::new(model)?);
    let mut owned = Resources::new()?;
    let y = owned.vector(&initial)?;
    let yp = owned.vector(&slopes)?;
    let endpoint_y = owned.vector(&initial)?;
    let endpoint_yp = owned.vector(&slopes)?;
    let atol = owned.vector(&absolute)?;
    let dense = owned.vector(&initial)?;
    let mut constraint = vec![1.; n];
    constraint[model.ledger_row()] = 0.;
    let constraint = owned.vector(&constraint)?;
    owned.spgmr(y, 30, 0)?;
    owned.ida = unsafe { IDACreate(owned.context) };
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
        "IDASetLinearSolver(SPGMR left maxl30 restart0)",
    )?;
    checked(
        unsafe { IDASetJacTimes(owned.ida, Some(jtsetup), jtimes) },
        "IDASetJacTimes(complete analytic chain-rule signed-D stage)",
    )?;
    checked(
        unsafe { IDASetPreconditioner(owned.ida, block_setup, block_solve) },
        "IDASetPreconditioner(fixed seven energy + complete precursor + complete slow blocks)",
    )?;
    checked(
        unsafe { IDASetStopTime(owned.ida, HORIZON) },
        "IDASetStopTime",
    )?;
    let mut out = Run {
        passed: false,
        diagnostic_completed: false,
        partial_pair: None,
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
        stage_metrics: String::from("null"),
        workspace_bytes,
        max_rhs_number_defect: 0.,
        max_integrated_number_defect: 0.,
        max_integrated_energy_defect: 0.,
        max_cf_error: 0.,
        failure_y: Vec::new(),
        failure_yp: Vec::new(),
        failure_snapshot_source: "unadmitted-raw-IDA-output;no-current-retained-endpoint-extracted",
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
    let mut physical_state = vec![0.; n];
    let mut physical_slopes = vec![0.; n];
    let mut retained_endpoint_valid = false;
    coordinates.physical(&initial, &mut physical_state);
    coordinates.physical(&slopes, &mut physical_slopes);
    if checkpoint_path.exists() {
        return Err("Refusing to replace an existing run checkpoint".into());
    }
    checkpoint(
        relative,
        0.,
        0,
        started.elapsed().as_secs_f64(),
        checkpoint_path,
        &physical_state,
        &physical_slopes,
        &callbacks,
        owned.ida,
    )?;
    let advancement = (|| -> Result<(), String> {
        loop {
            if let Err(e) = callbacks.budget() {
                out.reason = e;
                break;
            }
            retained_endpoint_valid = false;
            let status = unsafe { IDASolve(owned.ida, HORIZON, &mut out.returned, y, yp, 2) }; // IDA_ONE_STEP
            if let Err(error) = checked_ida_step(status, callbacks.error.as_deref()) {
                out.reason = error;
                break;
            }
            let screen_start = Instant::now();
            retained_endpoint(owned.ida, out.returned, y, yp, endpoint_y, endpoint_yp)?;
            coordinates.physical(unsafe { values(endpoint_y, n) }?, &mut physical_state);
            coordinates.physical(unsafe { values(endpoint_yp, n) }?, &mut physical_slopes);
            if physical_slopes.iter().any(|v| !v.is_finite()) {
                return Err("Nonfinite retained physical endpoint polynomial derivative".into());
            }
            retained_endpoint_valid = true;
            let state = &physical_state;
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
            admitted_steps += 1;
            let mut crossed_output = false;
            while common_output_due(sample, out.returned, diagnostic_end) {
                checked(
                    unsafe { IDAGetDky(owned.ida, OUTPUTS[sample], 0, dense) },
                    "IDAGetDky common output",
                )?;
                let mut common = unsafe { values(dense, n) }?.to_vec();
                coordinates.transform(&mut common);
                model
                    .evaluate_into(&common, &mut callbacks.work)
                    .map_err(str::to_owned)?;
                let common_d = callbacks.work.diagnostics().map_err(str::to_owned)?;
                finite_diagnostics(common_d)?;
                retain_common(checkpoint_path, sample, relative, OUTPUTS[sample], &common)?;
                out.samples.push(Sample {
                    time: OUTPUTS[sample],
                    captured_targets: captured_targets(model, &common)?,
                    y: common,
                    d: common_d,
                    nc_coefficients: nc_coefficients(model, &callbacks.work)?,
                });
                sample += 1;
                crossed_output = true;
                out.screen_output_calls += 1;
                if let Some(reference) = reference_samples {
                    let comparison = pair_comparator.as_ref().unwrap().compare(
                        model,
                        &reference[sample - 1].view(),
                        &out.samples.last().unwrap().view(),
                    )?;
                    println!(
                        "{{\"kind\":\"partial-pair-comparison\",\"stateChart\":\"LDSRC-MNF\",\"fullPairQualified\":false,\"comparison\":{}}}",
                        comparison.json()
                    );
                    io::stdout()
                        .flush()
                        .map_err(|e| format!("Partial comparison flush: {e}"))?;
                    if comparison.failed() {
                        out.reason = format!(
                            "Partial paired common-output hard failure at {:e}s; no full pair qualification",
                            comparison.local.time
                        );
                        out.partial_pair = Some(comparison);
                        break;
                    }
                }
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
                    &physical_state,
                    &physical_slopes,
                    &callbacks,
                    owned.ida,
                )?;
                checkpoint_time = Instant::now();
            }
            if out.partial_pair.is_some() {
                break;
            }
            if out.returned >= HORIZON {
                out.passed = true;
                out.reason = "300s reached with independent accepted-state screens".into();
                break;
            }
            if diagnostic_end.is_some_and(|end| out.samples.last().is_some_and(|s| s.time == end)) {
                out.diagnostic_completed = true;
                out.reason =
                    "Diagnostic common-output prefix collected; not a 300s qualification".into();
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
            out.diagnostic_completed = false;
            out.reason = format!("{}; final statistics: {e}", out.reason);
        }
    }
    if !out.passed && !out.diagnostic_completed {
        let (failure_y, failure_yp) = if retained_endpoint_valid {
            out.failure_snapshot_source =
                "IDAGetDky-retained-endpoint-y-and-polynomial-yp;not-Newton-stage-yp";
            (endpoint_y, endpoint_yp)
        } else {
            (y, yp)
        };
        out.failure_y = unsafe { values(failure_y, n) }?.to_vec();
        out.failure_yp = unsafe { values(failure_yp, n) }?.to_vec();
        coordinates.transform(&mut out.failure_y);
        coordinates.transform(&mut out.failure_yp);
    }
    out.rhs_calls = callbacks.rhs_calls;
    out.recoverable_errors = callbacks.recoverable_errors;
    out.last_recoverable = callbacks.last_recoverable.clone();
    out.jvp_calls = callbacks.jvp_calls;
    out.base_calls = callbacks.base_calls;
    out.rhs_seconds = callbacks.rhs_seconds;
    out.jvp_seconds = callbacks.jvp_seconds;
    out.base_seconds = callbacks.base_seconds;
    out.stage_metrics = callbacks.stage.as_ref().unwrap().metrics_json();
    out.wall = run_started.elapsed().as_secs_f64();
    Ok(out)
}

fn diagnose_local(path: &str, end: &str, allowance: &str, started: Instant) -> Result<(), String> {
    let end = diagnostic_end(end)?;
    let allowance: f64 = allowance
        .parse()
        .map_err(|_| "Invalid diagnostic allowance")?;
    if !allowance.is_finite() || allowance <= REPORT_RESERVE_SECONDS {
        return Err("Invalid diagnostic allowance/report reserve".into());
    }
    let input = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let prepared = evolution_input::parse(&input);
    let model = Evolution::new(prepared.input).map_err(str::to_owned)?;
    let accuracy = Accuracy::new(&model, &prepared.target_emissions)?;
    let normal = run(
        &model,
        &accuracy,
        RTOL[0],
        1.,
        started,
        allowance - REPORT_RESERVE_SECONDS,
        Path::new(&format!("{path}.diagnostic-normal.checkpoint")),
        Some(end),
        None,
    )?;
    let tighter = if normal.diagnostic_completed {
        Some(run(
            &model,
            &accuracy,
            RTOL[1],
            10.,
            started,
            allowance - REPORT_RESERVE_SECONDS,
            Path::new(&format!("{path}.diagnostic-tighter.checkpoint")),
            Some(end),
            None,
        )?)
    } else {
        None
    };
    let mut worst: Option<LocalDiscrepancy> = None;
    if let Some(tighter) = &tighter {
        for (a, b) in normal.samples.iter().zip(&tighter.samples) {
            let local = local_discrepancy(&model, &a.view(), &b.view())?;
            println!(
                "{{\"kind\":\"local-pair-discrepancy\",\"stateChart\":\"LDSRC-MNF\",\"diagnosticOnly\":true,\"worst\":{}}}",
                local.json()
            );
            if worst.as_ref().is_none_or(|w| local.ratio > w.ratio) {
                worst = Some(local);
            }
        }
    }
    let completed = normal.diagnostic_completed
        && diagnostic_prefix_complete(&normal.samples, end)
        && tighter.as_ref().is_some_and(|t| t.diagnostic_completed)
        && tighter
            .as_ref()
            .is_some_and(|t| diagnostic_prefix_complete(&t.samples, end))
        && started.elapsed().as_secs_f64() <= allowance;
    println!(
        "{{\"kind\":\"local-pair-diagnostic-final\",\"passed\":false,\"qualification\":false,\"diagnosticCompleted\":{completed},\"stateChart\":\"LDSRC-MNF\",\"requestedCommonEnd\":{end:e},\"IDAStopTime\":300,\"allowanceSeconds\":{allowance:e},\"elapsedSeconds\":{},\"worst\":{},\"normal\":{},\"tighter\":{}}}",
        finite(started.elapsed().as_secs_f64()),
        worst.as_ref().map_or("null".into(), LocalDiscrepancy::json),
        normal.json(),
        tighter.as_ref().map_or("null".into(), Run::json)
    );
    io::stdout()
        .flush()
        .map_err(|e| format!("Diagnostic final flush: {e}"))?;
    if !completed {
        std::process::exit(1);
    }
    Ok(())
}
fn diagnostic_end(value: &str) -> Result<f64, String> {
    let value: f64 = value.parse().map_err(|_| "Invalid diagnostic common end")?;
    if value >= HORIZON || !OUTPUTS.contains(&value) {
        return Err("Diagnostic end must be an existing common time below300s".into());
    }
    Ok(value)
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
    if args.len() == 5 && args[2] == "--diagnose-local" {
        return diagnose_local(&args[1], &args[3], &args[4], started);
    }
    if args.len() == 3 && args[2] == "--structure" {
        let text = fs::read_to_string(&args[1]).map_err(|e| e.to_string())?;
        let model = Evolution::new(evolution_input::parse(&text).input).map_err(str::to_owned)?;
        return source_stage::structure(&model, started);
    }
    if args.len() == 5 && args[2] == "--audit-block" {
        let text = fs::read_to_string(&args[1]).map_err(|e| e.to_string())?;
        let prepared = evolution_input::parse(&text);
        let model = Evolution::new(prepared.input).map_err(str::to_owned)?;
        let accuracy = Accuracy::new(&model, &prepared.target_emissions)?;
        return source_stage::audit(
            &model,
            &accuracy,
            &args[3],
            args[4].parse().map_err(|_| "Invalid block audit cj")?,
            started,
        );
    }
    if args.len() != 3 {
        return Err("Usage: source-evolution-ida FIXTURE_PATH AGGREGATE_ALLOWANCE_SECONDS | FIXTURE_PATH --structure | FIXTURE_PATH --audit-block STATEFILE CJ | FIXTURE_PATH --diagnose-local END ALLOWANCE_SECONDS".into());
    }
    let allowance: f64 = args[2].parse().map_err(|_| "Invalid allowance")?;
    if !allowance.is_finite() || allowance <= 0. {
        return Err("Invalid aggregate allowance".into());
    }
    let text = fs::read_to_string(&args[1]).map_err(|e| e.to_string())?;
    let prepared = evolution_input::parse(&text);
    let model = Evolution::new(prepared.input).map_err(str::to_owned)?;
    let accuracy = Accuracy::new(&model, &prepared.target_emissions)?;
    let construction = started.elapsed().as_secs_f64();
    let work_allowance = allowance - REPORT_RESERVE_SECONDS;
    if work_allowance <= 0. {
        return Err("Allowance does not include the fixed two-second report reserve".into());
    }
    let normal_path = format!("{}.normal.checkpoint", args[1]);
    let tighter_path = format!("{}.tighter.checkpoint", args[1]);
    let normal = run(
        &model,
        &accuracy,
        RTOL[0],
        1.,
        started,
        work_allowance,
        Path::new(&normal_path),
        None,
        None,
    )?;
    let mut tighter_setup_error = None;
    let tighter = if normal.passed {
        match run(
            &model,
            &accuracy,
            RTOL[1],
            10.,
            started,
            work_allowance,
            Path::new(&tighter_path),
            None,
            Some(&normal.samples),
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
    let mut worst_local: Option<LocalDiscrepancy> = None;
    let mut max_family_ratio: f64 = 0.;
    let mut max_observable_ratio: f64 = 0.;
    let mut max_nc_ratio: f64 = 0.;
    let mut max_raw_local: f64 = 0.;
    let mut max_raw_family: f64 = 0.;
    let mut worst_nc = None;
    let mut negligible_family_outputs = 0usize;
    let mut compared_family_outputs = 0usize;
    let comparator = PairComparator::new(&model, &accuracy);
    // Pair-dependent gates do not exist until both complete arms exist. A
    // failed/missing arm must never publish default zero ratios as evidence.
    let pair_evaluated = passed;
    let mut developed = true;
    if let Some(t) = &tighter {
        if passed {
            check_schedule(&normal.samples)?;
            check_schedule(&t.samples)?;
            for (a, b) in normal.samples.iter().zip(&t.samples) {
                let comparison = comparator.compare(&model, &a.view(), &b.view())?;
                max_local_ratio = max_local_ratio.max(comparison.local.ratio);
                max_family_ratio = max_family_ratio.max(comparison.family_ratio);
                max_observable_ratio = max_observable_ratio.max(comparison.observable_ratio);
                max_raw_local = max_raw_local.max(comparison.raw_local_ratio);
                max_raw_family = max_raw_family.max(comparison.raw_family_ratio);
                if worst_nc.is_none() || comparison.nc_ratio > max_nc_ratio {
                    worst_nc = comparison.nc_worst;
                }
                max_nc_ratio = max_nc_ratio.max(comparison.nc_ratio);
                compared_family_outputs += comparison.compared_families;
                negligible_family_outputs += comparison.negligible_families;
                if worst_local
                    .as_ref()
                    .is_none_or(|worst| comparison.local.ratio > worst.ratio)
                {
                    worst_local = Some(comparison.local);
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
                && max_nc_ratio <= 1.
                && developed;
        }
    }
    passed &= started.elapsed().as_secs_f64() <= allowance;
    let developed_report = compared(pair_evaluated, developed);
    let worst_local_json = worst_local
        .as_ref()
        .map_or("null".into(), LocalDiscrepancy::json);
    let nc_report = compared(pair_evaluated, finite(max_nc_ratio));
    let raw_local_report = compared(pair_evaluated, finite(max_raw_local));
    let raw_family_report = compared(pair_evaluated, finite(max_raw_family));
    let nc_worst_json = worst_nc.map_or("null".into(), |(row, column, normal, tighter, scale)| {
        format!(
            "{{\"row\":{row},\"column\":{column},\"normal\":{},\"tighter\":{},\"rowScale\":{}}}",
            finite(normal),
            finite(tighter),
            finite(scale)
        )
    });
    println!(
        "{{\"kind\":\"local-pair-worst\",\"stateChart\":\"LDSRC-MNF\",\"evaluated\":{pair_evaluated},\"worst\":{}}}",
        worst_local
            .as_ref()
            .map_or("null".into(), LocalDiscrepancy::json)
    );
    let last = if let Some(t) = &tighter {
        normal.last_admitted.min(t.last_admitted)
    } else if normal.passed {
        0.
    } else {
        normal.last_admitted
    };
    println!(
        "{{\"kind\":\"source-state-chart\",\"stateChart\":\"LDSRC-MNF\",\"reactionCoordinates\":\"Mn56-inventory-and-Fe56-product\",\"derivedCaptureConsumption\":\"Mn56+Fe56\",\"errorBasisChange\":\"direct-Mn56/Fe56;same-state-dimension;source-consequence-derived-atol\",\"pairedCaptureCriteria\":\"source-consequences-1;old-raw-count-ratios-diagnostic;Fe-count-strict\"}}"
    );
    println!(
        "{{\"passed\":{passed},\"stateChart\":\"LDSRC-MNF\",\"errorBasisChange\":\"direct-Mn56/Fe56;same-state-dimension;source-consequence-derived-atol\",\"scope\":\"Birth-driven represented ORIGINAL fixed-geometry/fixed-temperature source and finite target/history advancement; no thermal feedback, deposited heat, plant or live qualification\",\"coordinates\":{},\"physicalCoordinates\":{},\"auditIntegrals\":{},\"neutronCoordinates\":{},\"precursorCoordinates\":{},\"segments\":{},\"waterOwners\":{},\"targets\":{},\"MnTargets\":{},\"lastAdmittedTime\":{},\"constructionSeconds\":{},\"wallSeconds\":{},\"settings\":{{\"accuracyPolicy\":\"source-consequences-1\",\"provisional\":true,\"absoluteToleranceRefinement\":10,\"resolutionScope\":\"per-channel-source-consequences;not-aggregate-thermal-recipient-or-nearcritical-sensitivity-certificate\",\"horizon\":300,\"rtol\":[1e-5,1e-6],\"countAtol\":1e-3,\"energyAtolJ\":1e-12,\"linearSolver\":\"SPGMR-left-complete-chain-rule-JVP-signed-D-stage-seven-energy-ILU0-precursor-slow-KLU\",\"maxl\":30,\"restarts\":0,\"IDAlinearTolerance\":\"pinned-default-unchanged\",\"physicalNonnegativeConstraints\":true,\"solverLedgerCoordinate\":\"D=sum(N,C)-independentEventLedger\",\"ledgerConstraint\":\"unconstrained\",\"ledgerErrorMetric\":\"same-count-atol;stricter-aggregate-WRMS\",\"retainedCoordinates\":\"physical-event-ledger-L\",\"allowanceSeconds\":{},\"reportReserveSeconds\":2,\"rateResolution\":\"chosen20atol/time;notderivedstockerrorbound\",\"outputs\":{:?}}},\"gates\":{{\"fullPairComparisonEvaluated\":{pair_evaluated},\"localPairRatio\":{},\"worstLocalPair\":{worst_local_json},\"SUMABSFamilyPairRatio\":{},\"observablePairRatio\":{},\"NCOperatorPairRatio\":{nc_report},\"worstNCOperator\":{nc_worst_json},\"rawAtomCountDiagnostic\":{{\"localPairRatio\":{raw_local_report},\"SUMABSFamilyPairRatio\":{raw_family_report},\"admission\":false}},\"comparedFamilyOutputs\":{compared_family_outputs},\"negligibleFamilyOutputs\":{negligible_family_outputs},\"developedSignal\":{developed_report},\"strictAcceptedBoundary\":true}},\"normal\":{},\"tighter\":{},\"tighterSetupFailure\":{}}}",
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
        if pair_evaluated {
            finite(max_local_ratio)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_family_ratio)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_observable_ratio)
        } else {
            "null".into()
        },
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
    fn null_callback_userdata_refuses_without_running_action() {
        let mut called = false;
        assert_eq!(
            callback(ptr::null_mut(), |_| {
                called = true;
                Ok(())
            }),
            -1
        );
        assert!(!called);
    }
    #[test]
    fn diagnostic_end_never_redefines_the_mission_horizon() {
        assert_eq!(diagnostic_end("0.1").unwrap(), 0.1);
        for value in ["0", "0.2", "300", "NaN", "inf"] {
            assert!(diagnostic_end(value).is_err());
        }
        assert_eq!(HORIZON, 300.);
        assert!(common_output_due(2, 1.5, Some(0.1)));
        assert!(!common_output_due(3, 1.5, Some(0.1)));
        assert!(common_output_due(3, 1.5, None));
        assert!(!common_output_due(OUTPUTS.len(), 300., None));
        let mut samples = OUTPUTS[..3]
            .iter()
            .map(|&time| Sample {
                time,
                y: Vec::new(),
                captured_targets: Vec::new(),
                nc_coefficients: Vec::new(),
                d: Diagnostics::default(),
            })
            .collect::<Vec<_>>();
        assert!(diagnostic_prefix_complete(&samples, 0.1));
        samples.pop();
        assert!(!diagnostic_prefix_complete(&samples, 0.1));
        samples.push(Sample {
            time: 1.,
            y: Vec::new(),
            captured_targets: Vec::new(),
            nc_coefficients: Vec::new(),
            d: Diagnostics::default(),
        });
        assert!(!diagnostic_prefix_complete(&samples, 0.1));
    }
    #[test]
    fn local_locator_retains_existing_native_and_derived_capture_bounds() {
        let model = Evolution::new(source_stage::fixture::input()).unwrap();
        let mut a = Sample {
            time: 0.01,
            y: model.initial_state(),
            captured_targets: Vec::new(),
            nc_coefficients: Vec::new(),
            d: Diagnostics::default(),
        };
        let mut b = Sample {
            time: 0.01,
            y: model.initial_state(),
            captured_targets: Vec::new(),
            nc_coefficients: Vec::new(),
            d: Diagnostics::default(),
        };
        let target = model.mn_targets()[0].target;
        a.y[model.target_row(target)] = 0.1;
        a.y[model.mn_product_row(0)] = 0.1;
        a.captured_targets = captured_targets(&model, &a.y).unwrap();
        b.captured_targets = captured_targets(&model, &b.y).unwrap();
        let worst = local_discrepancy(&model, &a.view(), &b.view()).unwrap();
        assert_eq!(worst.source, "derived-capture-target");
        assert_eq!(worst.index, target);
        assert_eq!(worst.time, 0.01);
        assert_eq!(worst.bound, 20. * COUNT_ATOL);
        assert_eq!(worst.ratio, 10.);
        a.y[0] = 1.;
        let worst = local_discrepancy(&model, &a.view(), &b.view()).unwrap();
        assert_eq!(worst.source, "native-state-row");
        assert_eq!(worst.index, 0);
        assert_eq!(worst.family, "neutrons");
        assert_eq!(worst.ratio, 50.);
        a.y[0] = f64::NAN;
        assert!(local_discrepancy(&model, &a.view(), &b.view()).is_err());
        a.time = 1.;
        assert!(local_discrepancy(&model, &a.view(), &b.view()).is_err());
    }
    #[test]
    fn shared_pair_comparator_stops_each_hard_failure_without_prefix_qualification() {
        let model = Evolution::new(source_stage::fixture::input()).unwrap();
        let comparator = RawPairComparator::new(&model);
        let make = || Sample {
            time: 1.,
            y: model.initial_state(),
            captured_targets: captured_targets(&model, &model.initial_state()).unwrap(),
            nc_coefficients: Vec::new(),
            d: Diagnostics::default(),
        };
        let mut a = make();
        let mut b = make();
        assert!(
            !comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .failed()
        );
        a.y[0] = 20. * COUNT_ATOL;
        assert_eq!(
            comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .local
                .ratio,
            1.
        );
        assert!(
            !comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .failed()
        );
        a.y[0] *= 1.001;
        assert!(
            comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .failed()
        );
        // Aggregate and observable checks retain their independently chosen
        // thresholds. They do not establish any full-horizon completion.
        a = make();
        b = make();
        for (x, y) in a.y[..model.region_count() * fuel_source::GROUPS]
            .iter_mut()
            .zip(&mut b.y[..model.region_count() * fuel_source::GROUPS])
        {
            *x = 1002.;
            *y = 1000.;
        }
        let comparison = comparator.compare(&model, &a.view(), &b.view()).unwrap();
        assert!(comparison.family_ratio > 1.);
        assert!(comparison.failed());
        a = make();
        b = make();
        a.d.fuel_release_w = 20. * ENERGY_ATOL;
        let comparison = comparator.compare(&model, &a.view(), &b.view()).unwrap();
        assert_eq!(comparison.observable_ratio, 1.);
        assert!(!comparison.failed());
        a.d.fuel_release_w *= 1.001;
        let comparison = comparator.compare(&model, &a.view(), &b.view()).unwrap();
        assert_eq!(comparison.local.ratio, 0.);
        assert!(comparison.failed());
        assert!(comparison.json().contains("one-common-time;not-full-pair"));
        a.d.fuel_release_w = f64::NAN;
        assert!(comparator.compare(&model, &a.view(), &b.view()).is_err());
        a = make();
        b = make();
        b.time = 2.;
        assert!(comparator.compare(&model, &a.view(), &b.view()).is_err());
    }
    #[test]
    fn provisional_consequences_replace_only_selected_counts_and_tighten_all_atols() {
        let model = Evolution::new(source_stage::fixture::input()).unwrap();
        let accuracy = Accuracy::new(
            &model,
            &vec![[0., 1e-12]; model.target_reference_atoms().len()],
        )
        .unwrap();
        let normal = accuracy.absolute(1.).unwrap();
        let tighter = accuracy.absolute(10.).unwrap();
        for (&a, &b) in normal.iter().zip(&tighter) {
            assert_eq!(b, a / 10.);
        }
        assert_eq!(normal[0], COUNT_ATOL);
        assert_eq!(normal[model.ledger_row()], COUNT_ATOL);
        assert_eq!(normal[model.cf_row()], ENERGY_ATOL);
        for slot in 3..9 {
            assert!(!accuracy.affected(model.nc_dimension() + slot));
        }
        assert!(!accuracy.affected(model.mn_product_row(0)));
        let make = || {
            let y = model.initial_state();
            let mut work = model.workspace();
            model.evaluate_into(&y, &mut work).unwrap();
            Sample {
                time: 0.001,
                captured_targets: captured_targets(&model, &y).unwrap(),
                y,
                d: Diagnostics::default(),
                nc_coefficients: nc_coefficients(&model, &work).unwrap(),
            }
        };
        let mut a = make();
        let mut b = make();
        // Ordinary target 1 is not the Mn target 0. This fails the old raw
        // 0.02-atom floor but passes its declared energy/donor consequences.
        assert!(!model.mn_targets().iter().any(|m| m.target == 1));
        a.y[model.target_row(1)] = 0.03;
        a.captured_targets = captured_targets(&model, &a.y).unwrap();
        let comparator = PairComparator::new(&model, &accuracy);
        let result = comparator.compare(&model, &a.view(), &b.view()).unwrap();
        assert!(result.raw_local_ratio > 1.);
        assert!(!result.failed());
        assert!(result.json().contains("\"admission\":false"));
        // Unaffected neutron, Fe product, and observable checks still refuse.
        a.y[0] = 0.021;
        assert!(
            comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .failed()
        );
        a = make();
        a.y[model.mn_product_row(0)] = 0.021;
        a.captured_targets = captured_targets(&model, &a.y).unwrap();
        assert!(
            comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .failed()
        );
        // Coefficient row normalization is explicit; an all-zero tight row
        // has no artificial relative denominator.
        a = make();
        b = make();
        a.nc_coefficients[0] += 10. * b.nc_coefficients[0].abs() + 1.;
        assert!(
            comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .nc_ratio
                > 1.
        );
        a = make();
        b = make();
        b.nc_coefficients.fill(0.);
        assert!(
            (comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .nc_ratio
                - 1000.)
                .abs()
                < 1e-10
        );
        a.nc_coefficients.fill(0.);
        assert_eq!(
            comparator
                .compare(&model, &a.view(), &b.view())
                .unwrap()
                .nc_ratio,
            0.
        );
        a.nc_coefficients[0] = f64::NAN;
        assert!(comparator.compare(&model, &a.view(), &b.view()).is_err());
    }
    #[test]
    fn persisted_common_states_are_distinct_y_only_interpolants() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("leitbild-common-{}-{nonce}", std::process::id()));
        let path = format!("{}.common-0.state", base.display());
        retain_common(&base, 0, RTOL[0], 0.001, &[-0., 1e-300]).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..9], b"LDSRC-CMN");
        assert_eq!(bytes.len(), 33 + 2 * 8);
        assert_eq!(u64::from_le_bytes(bytes[9..17].try_into().unwrap()), 2);
        assert_eq!(f64::from_le_bytes(bytes[17..25].try_into().unwrap()), 0.001);
        assert_eq!(
            f64::from_le_bytes(bytes[25..33].try_into().unwrap()),
            RTOL[0]
        );
        assert_eq!(
            f64::from_le_bytes(bytes[33..41].try_into().unwrap()).to_bits(),
            (-0f64).to_bits()
        );
        assert_eq!(
            f64::from_le_bytes(bytes[41..49].try_into().unwrap()),
            1e-300
        );
        assert!(retain_common(&base, 0, RTOL[0], 0.001, &[0., 0.]).is_err());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn sample_capture_view_sums_direct_intermediate_and_product() {
        let model = Evolution::new(source_stage::fixture::input()).unwrap();
        let mut y = model.initial_state();
        let target = model.mn_targets()[0].target;
        y[model.target_row(target)] = 1e-100;
        y[model.mn_product_row(0)] = 10.;
        assert_eq!(captured_targets(&model, &y).unwrap()[target], 10.);
        // The view must never be used to reconstruct its tiny authoritative M.
        assert_eq!(y[model.target_row(target)], 1e-100);
    }
    #[test]
    fn diagnostic_strings_and_nonfinite_snapshots_remain_json() {
        assert_eq!(quote("x\n\"\\\u{0001}"), "\"x\\n\\\"\\\\\\u0001\"");
        assert_eq!(numbers(&[1., f64::NAN, f64::INFINITY]), "[1e0,null,null]");
        assert_eq!(compared(false, true), "null");
        assert_eq!(compared(false, 0.), "null");
        assert_eq!(compared(true, false), "false");
        assert_eq!(compared(true, finite(0.)), "0e0");
    }
    #[test]
    fn selected_iterative_constructor_and_owned_cleanup() {
        let mut resources = Resources::new().unwrap();
        let vector = resources.vector(&[0., 0.]).unwrap();
        assert!(!resources.spgmr(vector, 30, 0).unwrap().is_null());
        assert!(resources.spgmr(vector, 30, 0).is_err());
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
    #[test]
    fn paired_outputs_require_the_entire_exact_common_schedule() {
        let mut samples = OUTPUTS
            .iter()
            .map(|&time| Sample {
                time,
                y: Vec::new(),
                d: Diagnostics::default(),
                captured_targets: Vec::new(),
                nc_coefficients: Vec::new(),
            })
            .collect::<Vec<_>>();
        assert!(check_schedule(&samples).is_ok());
        samples.pop();
        assert!(check_schedule(&samples).is_err());
        samples.push(Sample {
            time: 300.001,
            y: Vec::new(),
            d: Diagnostics::default(),
            captured_targets: Vec::new(),
            nc_coefficients: Vec::new(),
        });
        assert!(check_schedule(&samples).is_err());
        samples.clear();
        assert!(check_schedule(&samples).is_err());
    }
}

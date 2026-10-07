//! One connected offline source/fuel/carrier/primary/finite-SG transaction.
//! No live runtime, alternate backend, maintained sink or imposed power.
#![allow(dead_code)]
#[path = "cooling_accuracy.rs"]
mod cooling_accuracy;
#[path = "cooling_block/mod.rs"]
mod cooling_block;
#[path = "cooling_coordinates.rs"]
mod cooling_coordinates;
#[cfg(test)]
#[path = "cooling_energy_diagnostic.rs"]
mod cooling_energy_diagnostic;
#[path = "cooling_energy_preconditioner.rs"]
mod cooling_energy_preconditioner;
#[cfg(test)]
#[path = "../tests/source_cooling.rs"]
mod cooling_fixture;
#[path = "cooling_input/mod.rs"]
mod cooling_input;
#[path = "cooling_power.rs"]
mod cooling_power;
#[path = "evolution_input/mod.rs"]
mod evolution_input;
#[path = "../examples/ida_support/mod.rs"]
mod ida_support;
#[path = "../examples/operating_network_input/mod.rs"]
mod operating_network_input;
#[path = "source_accuracy.rs"]
mod source_accuracy;
#[path = "source_block/mod.rs"]
mod source_block;
#[path = "source_coordinates/mod.rs"]
mod source_coordinates;
#[path = "source_input/mod.rs"]
mod source_input;
#[path = "source_pair.rs"]
mod source_pair;
use cooling_coordinates::EnergyCoordinates;
use ida_support::*;
use leitbild_plant_numerics::{
    converter_heat, cylindrical_source, fuel_history, fuel_source, fuel_thermal, heat_history,
    moderator_source, operating_admission, operating_network, optical_source, passive_source,
    source_cooling, source_evolution, transport_source, water_carrier,
};
use source_coordinates::Coordinates;
use source_evolution::Evolution;
use std::{
    ffi::{c_int, c_long},
    fs,
    io::{self, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    ptr, slice,
    time::Instant,
};
const COUNT_ATOL: f64 = 1e-3;
const ENERGY_ATOL: f64 = 1e-12;
const HORIZON: f64 = 300.;
use cooling_accuracy::OUTPUTS;
fn ratio(n: f64, d: f64) -> Result<f64, String> {
    if !n.is_finite() || !d.is_finite() || d <= 0. {
        return Err("Invalid comparison scale".into());
    }
    let r = n / d;
    if !r.is_finite() {
        return Err("Nonfinite comparison ratio".into());
    }
    Ok(r)
}
fn quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
fn finite(x: f64) -> String {
    if x.is_finite() {
        format!("{x:e}")
    } else {
        "null".into()
    }
}
fn numbers(x: &[f64]) -> String {
    format!(
        "[{}]",
        x.iter().map(|&v| finite(v)).collect::<Vec<_>>().join(",")
    )
}
unsafe fn values<'a>(v: Handle, n: usize) -> Result<&'a [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong coupled callback vector".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null coupled vector data".into());
    }
    Ok(unsafe { slice::from_raw_parts(p, n) })
}
unsafe fn output<'a>(v: Handle, n: usize) -> Result<&'a mut [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong coupled callback output".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null coupled output data".into());
    }
    Ok(unsafe { slice::from_raw_parts_mut(p, n) })
}
struct Callbacks<'a> {
    model: &'a source_cooling::Model,
    work: source_cooling::Workspace,
    p: cooling_block::Preconditioner,
    coordinates: Coordinates,
    energy: EnergyCoordinates,
    energy_p: cooling_energy_preconditioner::EnergyRow,
    energy_p_setup_seconds: f64,
    energy_p_solve_seconds: f64,
    state: Vec<f64>,
    slopes: Vec<f64>,
    direction: Vec<f64>,
    preconditioner_rhs: Vec<f64>,
    power_weights: cooling_power::PowerWeights,
    power_work: cooling_power::PowerWorkspace,
    power_resolution_w: f64,
    start: Instant,
    allowance: f64,
    fatal: Option<String>,
    recoverable: u64,
    residuals: u64,
    bases: u64,
    actions: u64,
    residual_seconds: f64,
    base_seconds: f64,
    action_seconds: f64,
    screen_seconds: f64,
    io_seconds: f64,
    error_telemetry_seconds: f64,
    weight_calls: u64,
    weight_seconds: f64,
    local_errors: LocalErrors,
    absolute: Vec<f64>,
    relative: f64,
}
#[link(name = "sundials_ida")]
unsafe extern "C" {
    fn IDAWFtolerances(
        memory: Handle,
        weights: unsafe extern "C" fn(Handle, Handle, Handle) -> c_int,
    ) -> c_int;
    fn IDAGetEstLocalErrors(memory: Handle, errors: Handle) -> c_int;
    fn IDAGetErrWeights(memory: Handle, weights: Handle) -> c_int;
    fn IDAGetLastOrder(memory: Handle, order: *mut c_int) -> c_int;
    fn IDAGetCurrentOrder(memory: Handle, order: *mut c_int) -> c_int;
}
fn progress_relative(model: &source_cooling::Model, row: usize) -> bool {
    row < model.layout.source_end
        || (model.layout.products_start..model.layout.energies_start).contains(&row)
}
const ERROR_FAMILIES: [&str; 7] = [
    "source-N",
    "source-C",
    "source-history-and-audits",
    "network",
    "carrier-products",
    "thermal-energy",
    "thermal-temperature",
];
#[derive(Clone, Copy, Default)]
struct ErrorFamily {
    rows: usize,
    last_wrms: f64,
    maximum: f64,
    row: usize,
    time: f64,
}
struct LocalErrors {
    families: [ErrorFamily; 7],
    labels: Vec<usize>,
    observations: u64,
    last_order: c_int,
    current_order: c_int,
    last_h: f64,
    last_wrms: f64,
}
impl LocalErrors {
    fn new(model: &source_cooling::Model) -> Self {
        let l = model.layout;
        let labels = (0..model.dimension())
            .map(|r| {
                if r < model.source.nc_dimension() {
                    usize::from(
                        r >= model.source.fuel_history().fuel().volumes().len()
                            * fuel_source::GROUPS,
                    )
                } else if r < l.source_end {
                    2
                } else if r < l.products_start {
                    3
                } else if r < l.energies_start {
                    4
                } else if r < l.temperatures_start {
                    5
                } else {
                    6
                }
            })
            .collect::<Vec<_>>();
        let mut families = [ErrorFamily::default(); 7];
        for &label in &labels {
            families[label].rows += 1;
        }
        Self {
            families,
            labels,
            observations: 0,
            last_order: 0,
            current_order: 0,
            last_h: 0.,
            last_wrms: 0.,
        }
    }
    fn observe(
        &mut self,
        errors: &[f64],
        weights: &[f64],
        time: f64,
        last_order: c_int,
        current_order: c_int,
        h: f64,
    ) -> Result<(), String> {
        if errors.len() != self.labels.len()
            || weights.len() != errors.len()
            || !time.is_finite()
            || !h.is_finite()
        {
            return Err("Invalid local-error telemetry shape/time".into());
        }
        let mut squares = [0.; 7];
        for (row, ((&error, &weight), &family)) in
            errors.iter().zip(weights).zip(&self.labels).enumerate()
        {
            let value = (error * weight).abs();
            if !error.is_finite() || !weight.is_finite() || weight <= 0. || !value.is_finite() {
                return Err("Nonfinite local-error telemetry".into());
            }
            squares[family] += value * value;
            if value > self.families[family].maximum {
                self.families[family].maximum = value;
                self.families[family].row = row;
                self.families[family].time = time;
            }
        }
        let sum = squares.iter().sum::<f64>();
        if !sum.is_finite() {
            return Err("Unrepresentable local-error telemetry norm".into());
        }
        for (f, &s) in self.families.iter_mut().zip(&squares) {
            f.last_wrms = if f.rows == 0 {
                0.
            } else {
                (s / f.rows as f64).sqrt()
            };
        }
        self.last_wrms = (sum / errors.len() as f64).sqrt();
        self.observations += 1;
        self.last_order = last_order;
        self.current_order = current_order;
        self.last_h = h;
        Ok(())
    }
    fn json(&self) -> String {
        let families=self.families.iter().zip(ERROR_FAMILIES).map(|(f,name)|format!(
            "{{\"family\":{},\"rows\":{},\"lastFamilyWRMS\":{},\"maximumWeightedCoordinateEstimate\":{},\"maximumRow\":{},\"maximumTime\":{}}}",
            quote(name),f.rows,finite(f.last_wrms),finite(f.maximum),f.row,finite(f.time))).collect::<Vec<_>>().join(",");
        format!(
            "{{\"scope\":\"solver-coordinate-IDAGetEstLocalErrors-times-current-IDAGetErrWeights;D-ledger-and-G-energy-transforms-included;accepted-steps-only;not-global-error-bound-or-rejected-step-attribution\",\"observations\":{},\"lastOrder\":{},\"currentOrder\":{},\"lastH\":{},\"lastGlobalWRMS\":{},\"families\":[{}]}}",
            self.observations,
            self.last_order,
            self.current_order,
            finite(self.last_h),
            finite(self.last_wrms),
            families
        )
    }
}
unsafe extern "C" fn error_weights(y: Handle, weights: Handle, user: Handle) -> c_int {
    callback(user, |c| {
        let began = Instant::now();
        c.weight_calls += 1;
        let result = (|| {
            let n = c.model.dimension();
            let y = unsafe { values(y, n) }?;
            let out = unsafe { output(weights, n) }?;
            for i in 0..n {
                let relative = if progress_relative(c.model, i) {
                    c.relative
                } else {
                    0.
                };
                let scale = c.absolute[i] + relative * y[i].abs();
                if !scale.is_finite() || scale <= 0. {
                    return Err("Invalid current per-row error scale".into());
                }
                out[i] = scale;
            }
            // The response consumes only Assembly history stocks. Construction
            // verifies this prefix ends before D; G is in the network suffix.
            // Thus these solver coordinates are already physical, with no copy
            // or full RHS/EOS preparation, and the current JVP base stays intact.
            c.power_weights.cap(
                &y[..c.model.source.history_dimension()],
                c.relative,
                c.power_resolution_w,
                out,
                &mut c.power_work,
            )?;
            for scale in out {
                if !scale.is_finite() || *scale <= 0. {
                    return Err("Invalid power-capped error scale".into());
                }
                *scale = 1. / *scale;
                if !scale.is_finite() {
                    return Err("Unrepresentable per-row error weight".into());
                }
            }
            Ok(())
        })();
        c.weight_seconds += began.elapsed().as_secs_f64();
        result
    })
}
impl Callbacks<'_> {
    fn budget(&self) -> Result<(), String> {
        if self.start.elapsed().as_secs_f64() > self.allowance {
            Err("Aggregate coupled pair wall allowance exhausted".into())
        } else {
            Ok(())
        }
    }
    fn evaluate(&mut self, y: Handle, yp: Handle, cj: Option<f64>) -> Result<(), String> {
        let n = self.model.dimension();
        self.coordinates
            .physical(unsafe { values(y, n) }?, &mut self.state);
        self.energy.state_to_physical(&mut self.state);
        self.coordinates
            .physical(unsafe { values(yp, n) }?, &mut self.slopes);
        self.energy.vector_to_physical(&mut self.slopes);
        self.model
            .evaluate(&self.state, &self.slopes, cj, &mut self.work)
    }
    fn metrics(&self) -> String {
        let completion = format!(
            "{{\"identity\":\"closed-energy-P-only-rank-one-row-completion\",\"prepared\":{},\"unitResponsePivot\":{},\"unitResponseExactNonzeros\":{},\"extraSetupSolveSeconds\":{},\"completionSolveSeconds\":{},\"scope\":\"one-owned-Pbar-unit-solve-per-setup;frozen-cj;exact-nonzero-axpy;actual-F-J-unchanged\"}}",
            self.energy_p.check().is_ok(),
            finite(self.energy_p.pivot()),
            self.energy_p.nonzeros(),
            finite(self.energy_p_setup_seconds),
            finite(self.energy_p_solve_seconds)
        );
        format!(
            "{{\"residuals\":{},\"linearBases\":{},\"JVPs\":{},\"residualSeconds\":{},\"linearBaseSeconds\":{},\"JVPSeconds\":{},\"errorWeightCalls\":{},\"errorWeightSeconds\":{},\"errorWeightScope\":\"ordinary-scales-plus-current-sparse-power-cap-and-reciprocal;no-full-RHS-or-EOS\",\"acceptedAndCommonPreparationScreenSeconds\":{},\"retentionIOSeconds\":{},\"retentionIOScope\":\"checkpoint-common-and-terminal-file-write-flush-sync-rename;terminal-progress-flush-included\",\"localErrorTelemetrySeconds\":{},\"acceptedLocalErrorEstimates\":{},\"recoverableTrials\":{},\"energyPCompletion\":{completion},\"P\":{}}}",
            self.residuals,
            self.bases,
            self.actions,
            self.residual_seconds,
            self.base_seconds,
            self.action_seconds,
            self.weight_calls,
            self.weight_seconds,
            self.screen_seconds,
            self.io_seconds,
            self.error_telemetry_seconds,
            self.local_errors.json(),
            self.recoverable,
            self.p.metrics_json()
        )
    }
}
fn recoverable(error: &str) -> bool {
    matches!(
        error,
        "Invalid same-trial fuel instance inputs/workspace"
            | "Invalid native water/finite target/liquid B10 support"
            | "Invalid actual passive target stocks/workspace"
            | "Invalid actual cylinder target/workspace"
            | "Invalid advancing optical target amounts"
            | "Water carrier trial exhausted a target"
            | "Clad wall outside selected preboiling liquid branch"
            | "Fuel/clad temperature outside selected material domain"
            | "Helium temperature outside selected cold package domain"
            | "Nonpositive finite solid temperature"
            | "Unsupported local pressure/energy chart"
    ) || error.starts_with("Invalid water trial ")
}
fn callback(user: Handle, f: impl FnOnce(&mut Callbacks<'_>) -> Result<(), String>) -> c_int {
    if user.is_null() {
        return -1;
    }
    let c = unsafe { &mut *(user as *mut Callbacks<'_>) };
    match catch_unwind(AssertUnwindSafe(|| {
        c.budget()?;
        f(c)?;
        c.budget()
    })) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) if recoverable(&e) => {
            c.recoverable += 1;
            1
        }
        Ok(Err(e)) => {
            c.fatal = Some(e);
            -1
        }
        Err(_) => {
            c.fatal = Some("Panic contained at coupled callback boundary".into());
            -1
        }
    }
}
unsafe extern "C" fn residual(_: f64, y: Handle, yp: Handle, r: Handle, user: Handle) -> c_int {
    callback(user, |c| {
        let t = Instant::now();
        c.residuals += 1;
        let evaluated = c.evaluate(y, yp, None);
        c.residual_seconds += t.elapsed().as_secs_f64();
        evaluated?;
        let out = unsafe { output(r, c.model.dimension()) }?;
        out.copy_from_slice(&c.work.residual);
        c.coordinates.transform(out);
        // Match the admitted source solver-basis arithmetic, without subtracting
        // two rounded sums of full physical residuals.
        let rates = c.work.source.rates()?;
        out[c.coordinates.ledger] = unsafe { values(yp, c.model.dimension()) }?
            [c.coordinates.ledger]
            - (rates[..c.coordinates.nc].iter().sum::<f64>() - rates[c.coordinates.ledger]);
        // Actual independently assembled rate balance, never an imposed zero.
        out[c.energy.row] = unsafe { values(yp, c.model.dimension()) }?[c.energy.row]
            - c.work.complete_energy_rate()?;
        Ok(())
    })
}
unsafe extern "C" fn jtsetup(
    _: f64,
    y: Handle,
    yp: Handle,
    _: Handle,
    cj: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| {
        let t = Instant::now();
        c.bases += 1;
        let r = c.evaluate(y, yp, Some(cj));
        c.base_seconds += t.elapsed().as_secs_f64();
        r
    })
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
        let t = Instant::now();
        c.actions += 1;
        let n = c.model.dimension();
        c.coordinates
            .physical(unsafe { values(v, n) }?, &mut c.direction);
        c.energy.vector_to_physical(&mut c.direction);
        c.model.jvp(&c.direction, cj, &mut c.work)?;
        let out = unsafe { output(jv, n) }?;
        out.copy_from_slice(&c.work.jvp);
        c.coordinates.transform(out);
        let tangent = c.work.source.rate_jvp()?;
        out[c.coordinates.ledger] = cj * unsafe { values(v, n) }?[c.coordinates.ledger]
            - (tangent[..c.coordinates.nc].iter().sum::<f64>() - tangent[c.coordinates.ledger]);
        // Unshifted physical rate partials avoid recovering a tiny derivative
        // by subtracting enormous cj*dE terms at startup.
        out[c.energy.row] =
            cj * unsafe { values(v, n) }?[c.energy.row] - c.work.complete_energy_rate_jvp()?;
        c.action_seconds += t.elapsed().as_secs_f64();
        Ok(())
    })
}
unsafe extern "C" fn psetup(
    _: f64,
    y: Handle,
    yp: Handle,
    _: Handle,
    cj: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| {
        c.energy_p.invalidate();
        let n = c.model.dimension();
        c.coordinates
            .physical(unsafe { values(y, n) }?, &mut c.state);
        c.energy.state_to_physical(&mut c.state);
        c.coordinates
            .physical(unsafe { values(yp, n) }?, &mut c.slopes);
        c.energy.vector_to_physical(&mut c.slopes);
        c.p.setup(c.model, &c.state, &c.slopes, cj)?;
        let began = Instant::now();
        let result = (|| {
            c.preconditioner_rhs.fill(0.);
            c.preconditioner_rhs[c.energy.row] = 1.;
            c.energy.vector_to_physical(&mut c.preconditioner_rhs);
            c.p.solve(c.model, &c.preconditioner_rhs, &mut c.direction)?;
            c.energy.vector_to_solver(&mut c.direction);
            c.energy_p.prepare(cj, &c.direction)
        })();
        c.energy_p_setup_seconds += began.elapsed().as_secs_f64();
        result
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
        let n = c.model.dimension();
        let result = (|| {
            c.energy_p.check()?;
            let rhs = unsafe { values(r, n) }?;
            let rhs_g = rhs[c.energy.row];
            c.preconditioner_rhs.copy_from_slice(rhs);
            c.energy.vector_to_physical(&mut c.preconditioner_rhs);
            let out = unsafe { output(z, n) }?;
            c.p.solve(c.model, &c.preconditioner_rhs, out)?;
            c.energy.vector_to_solver(out);
            let began = Instant::now();
            let completed = c.energy_p.apply(rhs_g, out);
            c.energy_p_solve_seconds += began.elapsed().as_secs_f64();
            completed
        })();
        if result.is_err() {
            c.energy_p.invalidate();
        }
        result
    })
}

use cooling_accuracy::Sample;
struct Run {
    passed: bool,
    reason: String,
    last: f64,
    returned: f64,
    wall: f64,
    steps: u64,
    samples: Vec<Sample>,
    metrics: String,
    initial: Vec<f64>,
    final_y: Vec<f64>,
    final_yp: Vec<f64>,
    max_number: f64,
    max_energy: f64,
    max_thermal_chart: f64,
    stats: String,
}
impl Run {
    fn json(&self) -> String {
        format!(
            "{{\"passed\":{},\"reason\":{},\"lastAdmittedTime\":{},\"returnedTime\":{},\"wallSeconds\":{},\"screenedStatesIncludingInitial\":{},\"commonSamples\":{},\"maxSourceNumberDefect\":{},\"maxSourceEnergyDefectJ\":{},\"maxThermalChartK\":{},\"stats\":{},\"costs\":{}}}",
            self.passed,
            quote(&self.reason),
            finite(self.last),
            finite(self.returned),
            finite(self.wall),
            self.steps,
            self.samples.len(),
            finite(self.max_number),
            finite(self.max_energy),
            finite(self.max_thermal_chart),
            self.stats,
            self.metrics
        )
    }
}
fn solver_stats(memory: Handle) -> Result<String, String> {
    let mut counts = [0 as c_long; 10];
    let getters: [unsafe extern "C" fn(Handle, *mut c_long) -> c_int; 10] = [
        IDAGetNumSteps,
        IDAGetNumResEvals,
        IDAGetNumErrTestFails,
        IDAGetNumNonlinSolvIters,
        IDAGetNumNonlinSolvConvFails,
        IDAGetNumLinIters,
        IDAGetNumLinConvFails,
        IDAGetNumPrecEvals,
        IDAGetNumPrecSolves,
        IDAGetNumJtimesEvals,
    ];
    for (get, x) in getters.iter().zip(&mut counts) {
        checked(unsafe { get(memory, x) }, "Coupled solver statistic")?;
    }
    let mut h = 0.;
    checked(unsafe { IDAGetLastStep(memory, &mut h) }, "Coupled last h")?;
    Ok(format!(
        "{{\"steps\":{},\"residuals\":{},\"LTERejections\":{},\"NewtonIterations\":{},\"NewtonFailures\":{},\"linearIterations\":{},\"linearFailures\":{},\"Psetups\":{},\"Psolves\":{},\"JVPs\":{},\"lastH\":{}}}",
        counts[0],
        counts[1],
        counts[2],
        counts[3],
        counts[4],
        counts[5],
        counts[6],
        counts[7],
        counts[8],
        counts[9],
        finite(h)
    ))
}
fn checkpoint(path: &Path, time: f64, y: &[f64], yp: &[f64]) -> Result<(), String> {
    let pending = path.with_extension("pending");
    let mut f = io::BufWriter::new(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?,
    );
    f.write_all(b"LDCOOL01")
        .and_then(|_| f.write_all(&(y.len() as u64).to_le_bytes()))
        .and_then(|_| f.write_all(&time.to_le_bytes()))
        .map_err(|e| e.to_string())?;
    for &v in y.iter().chain(yp) {
        f.write_all(&v.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    f.flush().map_err(|e| e.to_string())?;
    f.get_ref().sync_all().map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(pending, path).map_err(|e| e.to_string())
}
fn retain_common(path: &Path, time: f64, y: &[f64]) -> Result<(), String> {
    if path.exists() {
        return Err("Refusing existing common-state artifact".into());
    }
    let pending = path.with_extension("common-pending");
    let mut f = io::BufWriter::new(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?,
    );
    f.write_all(b"LDCCOM01")
        .and_then(|_| f.write_all(&(y.len() as u64).to_le_bytes()))
        .and_then(|_| f.write_all(&time.to_le_bytes()))
        .map_err(|e| e.to_string())?;
    for &v in y {
        f.write_all(&v.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    f.flush().map_err(|e| e.to_string())?;
    f.get_ref().sync_all().map_err(|e| e.to_string())?;
    drop(f);
    fs::hard_link(&pending, path).map_err(|e| e.to_string())?;
    fs::remove_file(pending).map_err(|e| e.to_string())
}
fn retain_final_admitted(path: &Path, run: &Run, elapsed: f64, costs: &str) -> Result<(), String> {
    if run.steps == 0 {
        return Ok(());
    }
    checkpoint(path, run.last, &run.final_y, &run.final_yp)?;
    println!(
        "{{\"kind\":\"admitted-progress\",\"lastAdmittedTime\":{},\"screenedSteps\":{},\"aggregateWallSeconds\":{},\"costs\":{}}}",
        finite(run.last),
        run.steps,
        finite(elapsed),
        costs
    );
    io::stdout().flush().map_err(|e| e.to_string())
}
fn run(
    model: &source_cooling::Model,
    accuracy: &cooling_accuracy::Accuracy,
    refinement: f64,
    start: Instant,
    allowance: f64,
    checkpoint_path: &Path,
    reference: Option<&[Sample]>,
) -> Result<Run, String> {
    if checkpoint_path.exists() {
        return Err("Refusing existing coupled checkpoint".into());
    }
    if let Some(samples) = reference {
        cooling_accuracy::check_schedule(samples)?;
    }
    let began = Instant::now();
    let n = model.dimension();
    let l = model.layout;
    let mut initial = model.initial_state()?;
    let mut slopes = vec![0.; n];
    let mut work = model.workspace();
    model.evaluate(&initial, &slopes, None, &mut work)?;
    for i in 0..n {
        if model.is_differential(i) {
            slopes[i] = -work.residual[i];
        }
    }
    let mut absolute = accuracy.absolute(refinement)?;
    let energy = EnergyCoordinates::new(model, &initial)?;
    absolute[energy.row] = EnergyCoordinates::absolute(n, refinement);
    let flow_absolute = accuracy.flow_absolute(refinement)?;
    let p = cooling_block::Preconditioner::new(model, &initial, &slopes)?;
    let coordinates = Coordinates {
        nc: model.source.nc_dimension(),
        ledger: model.source.ledger_row(),
    };
    coordinates.transform(&mut initial);
    energy.state_to_solver(&mut initial);
    coordinates.transform(&mut slopes);
    energy.vector_to_solver(&mut slopes);
    let power_weights = cooling_power::PowerWeights::new(&model.source)?;
    let power_work = power_weights.workspace();
    let mut callbacks = Box::new(Callbacks {
        model,
        work,
        p,
        coordinates,
        energy_p: cooling_energy_preconditioner::EnergyRow::new(n, energy.row)?,
        energy_p_setup_seconds: 0.,
        energy_p_solve_seconds: 0.,
        energy,
        state: vec![0.; n],
        slopes: vec![0.; n],
        direction: vec![0.; n],
        preconditioner_rhs: vec![0.; n],
        power_weights,
        power_work,
        power_resolution_w: cooling_accuracy::DEPOSIT_RESOLUTION_W / refinement,
        start,
        allowance,
        fatal: None,
        recoverable: 0,
        residuals: 0,
        bases: 0,
        actions: 0,
        residual_seconds: 0.,
        base_seconds: 0.,
        action_seconds: 0.,
        screen_seconds: 0.,
        io_seconds: 0.,
        error_telemetry_seconds: 0.,
        weight_calls: 0,
        weight_seconds: 0.,
        local_errors: LocalErrors::new(model),
        absolute,
        relative: 1e-5 / refinement,
    });
    let mut owned = Resources::new()?;
    let y = owned.vector(&initial)?;
    let yp = owned.vector(&slopes)?;
    let endpoint_y = owned.vector(&initial)?;
    let endpoint_yp = owned.vector(&slopes)?;
    let common = owned.vector(&initial)?;
    let local_error = owned.vector(&vec![0.; n])?;
    let error_weight = owned.vector(&vec![0.; n])?;
    let ids = owned.vector(
        &(0..n)
            .map(|i| f64::from(model.is_differential(i)))
            .collect::<Vec<_>>(),
    )?;
    let mut constraints = vec![0.; n];
    constraints[..l.source_end].fill(1.);
    constraints[model.source.ledger_row()] = 0.;
    constraints[callbacks.energy.row] = 0.; // Signed aggregate defect, not a physical E stock.
    constraints[l.products_start..l.energies_start].fill(1.);
    constraints[l.temperatures_start..].fill(2.);
    let constraints = owned.vector(&constraints)?;
    owned.spgmr(y, 30, 0)?;
    owned.ida = unsafe { IDACreate(owned.context) };
    if owned.ida.is_null() {
        return Err("Null coupled IDA".into());
    }
    checked(
        unsafe { IDAInit(owned.ida, residual, 0., y, yp) },
        "Coupled IDA init",
    )?;
    checked(
        unsafe { IDASetUserData(owned.ida, (&mut *callbacks as *mut Callbacks<'_>).cast()) },
        "Coupled callback owner",
    )?;
    checked(
        unsafe { IDASetId(owned.ida, ids) },
        "Coupled differential mask",
    )?;
    checked(
        unsafe { IDAWFtolerances(owned.ida, error_weights) },
        "Source/carrier progress relative / network-thermal absolute weights",
    )?;
    checked(
        unsafe { IDASetConstraints(owned.ida, constraints) },
        "Strict source/carrier constraints",
    )?;
    checked(
        unsafe { IDASetLinearSolver(owned.ida, owned.solver, ptr::null_mut()) },
        "Coupled SPGMR30 restart0",
    )?;
    checked(
        unsafe { IDASetJacTimes(owned.ida, Some(jtsetup), jtimes) },
        "Complete coupled analytic JVP",
    )?;
    checked(
        unsafe { IDASetPreconditioner(owned.ida, psetup, psolve) },
        "Fixed component P",
    )?;
    let ic_status = unsafe { IDACalcIC(owned.ida, 1, 0.001) };
    if ic_status != 0 || callbacks.fatal.is_some() {
        let mut failed_y = vec![0.; n];
        let mut failed_yp = vec![0.; n];
        coordinates.physical(unsafe { values(y, n) }?, &mut failed_y);
        callbacks.energy.state_to_physical(&mut failed_y);
        coordinates.physical(unsafe { values(yp, n) }?, &mut failed_yp);
        callbacks.energy.vector_to_physical(&mut failed_yp);
        let path = checkpoint_path.with_extension("initialization-refusal");
        checkpoint(&path, 0., &failed_y, &failed_yp)?;
        let reason = format!(
            "Held-stock consistent initialization status {ic_status}, fatal callback {:?}",
            callbacks.fatal
        );
        println!(
            "{{\"kind\":\"initialization-refusal\",\"passed\":false,\"lastAdmittedTime\":0,\"reason\":{},\"unadmittedRawStatePath\":{},\"costs\":{}}}",
            quote(&reason),
            quote(&path.display().to_string()),
            callbacks.metrics()
        );
        io::stdout().flush().map_err(|e| e.to_string())?;
        return Err(reason);
    }
    checked(
        unsafe { IDAGetConsistentIC(owned.ida, y, yp) },
        "Coupled consistent state",
    )?;
    let initialized = unsafe { values(y, n) }?;
    for i in 0..n {
        if model.is_differential(i) && initialized[i].to_bits() != initial[i].to_bits() {
            return Err(format!("Consistent preparation changed finite stock {i}"));
        }
    }
    initial.copy_from_slice(initialized);
    slopes.copy_from_slice(unsafe { values(yp, n) }?);
    checked(
        unsafe { IDASetStopTime(owned.ida, HORIZON) },
        "One persistent 300 s horizon",
    )?;
    let mut physical = vec![0.; n];
    let mut physical_yp = vec![0.; n];
    coordinates.physical(&initial, &mut physical);
    callbacks.energy.state_to_physical(&mut physical);
    coordinates.physical(&slopes, &mut physical_yp);
    callbacks.energy.vector_to_physical(&mut physical_yp);
    let initial = physical.clone();
    let mut out = Run {
        passed: false,
        reason: String::new(),
        last: 0.,
        returned: 0.,
        wall: 0.,
        steps: 0,
        samples: Vec::new(),
        metrics: String::new(),
        initial,
        final_y: physical.clone(),
        final_yp: physical_yp.clone(),
        max_number: 0.,
        max_energy: 0.,
        max_thermal_chart: 0.,
        stats: "null".into(),
    };
    let mut last_checkpoint = Instant::now();
    let advance = (|| -> Result<(), String> {
        loop {
            callbacks.budget()?;
            if out.steps > 0 {
                let status = unsafe { IDASolve(owned.ida, HORIZON, &mut out.returned, y, yp, 2) };
                checked_ida_step(status, callbacks.fatal.as_deref())?;
                retained_endpoint(owned.ida, out.returned, y, yp, endpoint_y, endpoint_yp)?;
                coordinates.physical(unsafe { values(endpoint_y, n) }?, &mut physical);
                callbacks.energy.state_to_physical(&mut physical);
                coordinates.physical(unsafe { values(endpoint_yp, n) }?, &mut physical_yp);
                callbacks.energy.vector_to_physical(&mut physical_yp);
            }
            // Admission needs current physical charts/receipts, not a new
            // full network Jacobian. JTsetup prepares its own next stage.
            let screen_started = Instant::now();
            let admitted = (|| -> Result<(), String> {
                model.evaluate(&physical, &physical_yp, None, &mut callbacks.work)?;
                model.validate_accepted(&physical, &callbacks.work)?;
                let admission = cooling_accuracy::admit_source(
                    model,
                    &physical,
                    &callbacks.work.source,
                    out.returned,
                )?;
                out.max_number = out.max_number.max(admission.number_defect);
                out.max_energy = out.max_energy.max(admission.energy_defect);
                let expected = accuracy.expected_network_totals(model, &physical)?;
                operating_admission::screen(
                    &model.network,
                    &callbacks.work.network,
                    &physical[l.network_start..l.products_start],
                    expected,
                    &flow_absolute,
                )?;
                for (i, &cp) in callbacks.work.thermal.capacities()?.iter().enumerate() {
                    let dt = callbacks.work.residual[l.temperatures_start + i].abs() / cp;
                    if !dt.is_finite() || dt > 1e-4 {
                        return Err(format!("Thermal caloric chart {i} correction {dt} K"));
                    }
                    out.max_thermal_chart = out.max_thermal_chart.max(dt);
                }
                Ok(())
            })();
            callbacks.screen_seconds += screen_started.elapsed().as_secs_f64();
            admitted?;
            out.last = out.returned;
            out.steps += 1;
            out.final_y.copy_from_slice(&physical);
            out.final_yp.copy_from_slice(&physical_yp);
            if out.returned > 0. {
                let observed = Instant::now();
                checked(
                    unsafe { IDAGetEstLocalErrors(owned.ida, local_error) },
                    "Accepted local error estimate",
                )?;
                checked(
                    unsafe { IDAGetErrWeights(owned.ida, error_weight) },
                    "Accepted current error weights",
                )?;
                let (mut last_order, mut current_order, mut h) = (0, 0, 0.);
                checked(
                    unsafe { IDAGetLastOrder(owned.ida, &mut last_order) },
                    "Accepted last order",
                )?;
                checked(
                    unsafe { IDAGetCurrentOrder(owned.ida, &mut current_order) },
                    "Accepted current order",
                )?;
                checked(
                    unsafe { IDAGetLastStep(owned.ida, &mut h) },
                    "Accepted last step",
                )?;
                callbacks.local_errors.observe(
                    unsafe { values(local_error, n) }?,
                    unsafe { values(error_weight, n) }?,
                    out.returned,
                    last_order,
                    current_order,
                    h,
                )?;
                callbacks.error_telemetry_seconds += observed.elapsed().as_secs_f64();
            }
            let mut crossed = false;
            while out.samples.len() < OUTPUTS.len() && OUTPUTS[out.samples.len()] <= out.returned {
                let time = OUTPUTS[out.samples.len()];
                checked(
                    unsafe { IDAGetDky(owned.ida, time, 0, common) },
                    "Common coupled polynomial",
                )?;
                coordinates.physical(unsafe { values(common, n) }?, &mut callbacks.state);
                callbacks.energy.state_to_physical(&mut callbacks.state);
                // Dense observations are explicitly not positivity-constrained endpoints.
                let common_started = Instant::now();
                model.evaluate(&callbacks.state, &vec![0.; n], None, &mut callbacks.work)?;
                let captures = cooling_accuracy::captured_targets(model, &callbacks.state)?;
                let nc = cooling_accuracy::nc_coefficients(model, &callbacks.work.source)?;
                let sample = Sample {
                    time,
                    y: callbacks.state.clone(),
                    source_d: callbacks.work.source.diagnostics()?,
                    source_captures: captures,
                    source_nc: nc,
                    deposition: callbacks.work.source.fuel_deposition()?.to_vec(),
                    water_mass: callbacks.work.network.chart_mass.clone(),
                };
                callbacks.screen_seconds += common_started.elapsed().as_secs_f64();
                let io_started = Instant::now();
                retain_common(
                    &checkpoint_path.with_extension(format!("common-{}.bin", out.samples.len())),
                    time,
                    &sample.y,
                )?;
                callbacks.io_seconds += io_started.elapsed().as_secs_f64();
                if let Some(reference) = reference {
                    let comparison =
                        accuracy.compare_one(model, &reference[out.samples.len()], &sample)?;
                    println!(
                        "{{\"kind\":\"paired-common-comparison\",\"time\":{time},\"comparison\":{}}}",
                        comparison.json()
                    );
                    io::stdout().flush().map_err(|e| e.to_string())?;
                    if comparison.failed() {
                        return Err(format!(
                            "Common paired admission failed at {time}: {}",
                            comparison.json()
                        ));
                    }
                }
                out.samples.push(sample);
                crossed = true;
            }
            if crossed || last_checkpoint.elapsed().as_secs_f64() >= 1. || out.steps == 1 {
                let io_started = Instant::now();
                checkpoint(checkpoint_path, out.last, &out.final_y, &out.final_yp)?;
                callbacks.io_seconds += io_started.elapsed().as_secs_f64();
                println!(
                    "{{\"kind\":\"admitted-progress\",\"lastAdmittedTime\":{},\"screenedSteps\":{},\"aggregateWallSeconds\":{},\"costs\":{}}}",
                    finite(out.last),
                    out.steps,
                    finite(start.elapsed().as_secs_f64()),
                    callbacks.metrics()
                );
                io::stdout().flush().map_err(|e| e.to_string())?;
                last_checkpoint = Instant::now();
            }
            if out.returned >= HORIZON {
                cooling_accuracy::check_schedule(&out.samples)?;
                out.passed = true;
                break;
            }
        }
        Ok(())
    })();
    if let Err(e) = advance {
        out.reason = e;
    } else {
        out.reason = "Complete 300 s accepted endpoints and common schedule".into();
    }
    // The periodic checkpoint may lag the most recent screened endpoint when
    // a later callback or output comparison refuses. Retain ONLY the admitted
    // in-memory owner here, before inspecting any unadmitted solver buffers.
    let io_started = Instant::now();
    retain_final_admitted(
        checkpoint_path,
        &out,
        start.elapsed().as_secs_f64(),
        &callbacks.metrics(),
    )?;
    callbacks.io_seconds += io_started.elapsed().as_secs_f64();
    if !out.passed {
        coordinates.physical(unsafe { values(y, n) }?, &mut physical);
        callbacks.energy.state_to_physical(&mut physical);
        coordinates.physical(unsafe { values(yp, n) }?, &mut physical_yp);
        callbacks.energy.vector_to_physical(&mut physical_yp);
        // Explicitly unadmitted raw solver buffers, never replace last accepted checkpoint.
        let io_started = Instant::now();
        checkpoint(
            &checkpoint_path.with_extension("unadmitted-raw"),
            out.returned,
            &physical,
            &physical_yp,
        )?;
        callbacks.io_seconds += io_started.elapsed().as_secs_f64();
    }
    out.wall = began.elapsed().as_secs_f64();
    out.metrics = callbacks.metrics();
    out.stats = solver_stats(owned.ida)?;
    Ok(out)
}
fn main() {
    if let Err(e) = execute() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn mean_fuel(model: &source_cooling::Model, y: &[f64]) -> Result<f64, String> {
    if y.len() != model.dimension() {
        return Err("Wrong mean-fuel state shape".into());
    }
    let mut mass = 0.;
    let mut temperature = 0.;
    for (&row, cohort) in model
        .fuel_rows()
        .iter()
        .zip(model.source.fuel_history().fuel().cohorts())
    {
        mass += cohort.mass;
        temperature += cohort.mass * y[model.layout.temperatures_start + row];
    }
    if !mass.is_finite() || mass <= 0. || !temperature.is_finite() {
        return Err("Invalid mass-weighted fuel temperature".into());
    }
    Ok(temperature / mass)
}
fn final_feedback(model: &source_cooling::Model, y: &[f64]) -> Result<String, String> {
    let mut actual = model.workspace();
    model.evaluate(y, &vec![0.; model.dimension()], None, &mut actual)?;
    let mut held = model.source.workspace();
    model.source.evaluate_coupled_into(
        &y[..model.layout.source_end],
        model.source.prepared_temperatures(),
        actual.external_stocks()?,
        &mut held,
    )?;
    let a = cooling_accuracy::nc_coefficients(model, &actual.source)?;
    let b = cooling_accuracy::nc_coefficients(model, &held)?;
    let mut scale = vec![0f64; model.source.nc_dimension()];
    for ((&(r, _), &x), &y) in model.source.nc_pattern().iter().zip(&a).zip(&b) {
        scale[r] = scale[r].max(x.abs()).max(y.abs());
    }
    let mut relative = 0f64;
    let mut absolute = 0f64;
    let mut worst = None;
    for ((&(r, c), &x), &y) in model.source.nc_pattern().iter().zip(&a).zip(&b) {
        let d = (x - y).abs();
        let fraction = if scale[r] == 0. {
            if d != 0. {
                return Err("Changed exact-zero feedback operator row".into());
            }
            0.
        } else {
            ratio(d, scale[r])?
        };
        absolute = absolute.max(d);
        if fraction > relative {
            relative = fraction;
            worst = Some((r, c, x, y, scale[r]));
        }
    }
    Ok(format!(
        "{{\"kind\":\"same-final-material-original-fuel-temperature-counterfactual\",\"admission\":false,\"currentTemperatureVsPreparedTemperatureOnly\":true,\"maxNCAbsoluteDifference_per_s\":{},\"maxNCRowRelativeDifference\":{},\"worst\":{}}}",
        finite(absolute),
        finite(relative),
        worst.map_or("null".into(), |(r, c, a, b, s)| format!(
            "{{\"row\":{r},\"column\":{c},\"actual\":{},\"heldPreparedFuelT\":{},\"rowScale\":{}}}",
            finite(a),
            finite(b),
            finite(s)
        ))
    ))
}
fn developed_source(model: &Evolution, a: &Sample, b: &Sample) -> Result<bool, String> {
    let mut developed = true;
    for (x, y, resolution) in [
        (
            a.source_d.neutrons,
            b.source_d.neutrons,
            20. * COUNT_ATOL * (model.region_count() * fuel_source::GROUPS) as f64,
        ),
        (
            a.source_d.precursors,
            b.source_d.precursors,
            20. * COUNT_ATOL
                * (model.nc_dimension() - model.region_count() * fuel_source::GROUPS) as f64,
        ),
        (
            a.source_d.retained_energy_j,
            b.source_d.retained_energy_j,
            20. * ENERGY_ATOL * (model.segment_count() * 25) as f64,
        ),
        (
            a.source_d.induced_fission_events_s,
            b.source_d.induced_fission_events_s,
            20. * COUNT_ATOL / b.time,
        ),
        (
            a.source_d.collected_events_s,
            b.source_d.collected_events_s,
            20. * COUNT_ATOL / b.time,
        ),
        (
            a.source_d.fuel_release_w,
            b.source_d.fuel_release_w,
            20. * ENERGY_ATOL / b.time,
        ),
    ] {
        if !x.is_finite() || !y.is_finite() || !resolution.is_finite() {
            return Err("Nonfinite developed source operands".into());
        }
        developed &= y > resolution && y > 100. * (x - y).abs();
    }
    Ok(developed)
}
fn execute() -> Result<(), String> {
    let started = Instant::now();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("Expected owner payload path and remaining aggregate allowance seconds".into());
    }
    let input = PathBuf::from(&args[0]);
    let budget = args[1]
        .parse::<f64>()
        .map_err(|_| "Invalid remaining allowance")?;
    if !budget.is_finite() || budget <= 2. || budget > 120. {
        return Err("Expected aggregate allowance (2,120] s".into());
    }
    let text = fs::read_to_string(&input).map_err(|e| e.to_string())?;
    let prepared = catch_unwind(AssertUnwindSafe(|| cooling_input::parse(&text)))
        .map_err(|_| "Malformed coupled numeric payload".to_string())??;
    let accuracy = cooling_accuracy::Accuracy::new(&prepared.model, &prepared.target_emissions)?;
    let allowance = budget.min(prepared.budget) - 2.;
    if allowance <= 0. {
        return Err("No numerical allowance after report reserve".into());
    }
    let normal = run(
        &prepared.model,
        &accuracy,
        1.,
        started,
        allowance,
        &input.with_extension("normal.checkpoint"),
        None,
    )?;
    let tight = if normal.passed {
        Some(run(
            &prepared.model,
            &accuracy,
            10.,
            started,
            allowance,
            &input.with_extension("tighter.checkpoint"),
            Some(&normal.samples),
        )?)
    } else {
        None
    };
    let pair_evaluated = normal.passed && tight.as_ref().is_some_and(|r| r.passed);
    let mut thermal_developed = None;
    let mut source_developed = None;
    let mut thermal_details = "null".to_string();
    let mut comparisons = Vec::new();
    let mut max_source_local = 0f64;
    let mut max_source_family = 0f64;
    let mut max_source_observable = 0f64;
    let mut max_source_nc = 0f64;
    let mut max_thermal = 0f64;
    let mut max_network = 0f64;
    let mut max_deposit = 0f64;
    let mut max_carrier = 0f64;
    let mut feedback = "null".to_string();
    if let Some(t) = tight.as_ref().filter(|t| normal.passed && t.passed) {
        cooling_accuracy::check_schedule(&normal.samples)?;
        cooling_accuracy::check_schedule(&t.samples)?;
        for (a, b) in normal.samples.iter().zip(&t.samples) {
            let c = accuracy.compare_one(&prepared.model, a, b)?;
            max_source_local = max_source_local.max(c.source.local.ratio);
            max_source_family = max_source_family.max(c.source.family_ratio);
            max_source_observable = max_source_observable.max(c.source.observable_ratio);
            max_source_nc = max_source_nc.max(c.source.nc_ratio);
            max_thermal = max_thermal
                .max(c.thermal_temperature_ratio)
                .max(c.thermal_energy_ratio)
                .max(c.thermal_family_ratio);
            max_network = max_network
                .max(c.network_temperature_ratio)
                .max(c.network_pressure_ratio)
                .max(c.secondary_mass_ratio)
                .max(c.sg_heat_ratio);
            max_deposit = max_deposit
                .max(c.deposit_local_ratio)
                .max(c.deposit_sumabs_ratio);
            max_carrier = max_carrier.max(c.carrier_ratio);
            comparisons.push(c.json());
        }
        let original_mean = mean_fuel(&prepared.model, &normal.initial)?;
        let normal_mean = mean_fuel(&prepared.model, &normal.final_y)?;
        let tighter_mean = mean_fuel(&prepared.model, &t.final_y)?;
        let change = (tighter_mean - original_mean).abs();
        let difference = (normal_mean - tighter_mean).abs();
        thermal_developed = Some(change >= 0.01 && change >= 20. * difference);
        thermal_details = format!(
            "{{\"massWeightedMeanFuelInitialK\":{},\"normalFinalK\":{},\"tighterFinalK\":{},\"absoluteChangeK\":{},\"pairedDifferenceK\":{},\"minimumChangeK\":0.01,\"minimumResponseToPairDifference\":20}}",
            finite(original_mean),
            finite(normal_mean),
            finite(tighter_mean),
            finite(change),
            finite(difference)
        );
        source_developed = Some(developed_source(
            &prepared.model.source,
            normal.samples.last().ok_or("Missing normal final sample")?,
            t.samples.last().ok_or("Missing tighter final sample")?,
        )?);
        feedback = final_feedback(&prepared.model, &t.final_y)?;
    }
    let passed =
        pair_evaluated && thermal_developed == Some(true) && source_developed == Some(true);
    let tighter = tight.as_ref().map_or("null".into(), Run::json);
    let fuel_power_resolution = finite(cooling_accuracy::DEPOSIT_RESOLUTION_W);
    println!(
        "{{\"kind\":\"source-cooling-pair\",\"passed\":{passed},\"lastAdmittedTime\":{},\"scope\":\"same-trial-source-finite-fuel-He-primary-finite-SG;cold-fixed-prepared-geometry;no-fullplant-credit\",\"dimension\":{},\"differential\":{},\"settings\":{{\"accuracyPolicy\":\"cold-source-cooling-4\",\"provisional\":true,\"fuelPowerErrorWeights\":\"sparse-current-response-proportional-budget-cap\",\"fuelPowerResolutionW\":{fuel_power_resolution},\"fuelPowerWeightScope\":\"first-order-local-box-budget;not-WRMS-or-paired-error-guarantee\",\"perRowErrorWeights\":\"source-carrier-relative-consequences;network-thermal-absolute-only;energy-defect-absolute\",\"solverEnergyCoordinate\":\"G=sum-installed-energy-change-independent-fuel-release\",\"energyDefectATOLJ\":{},\"referenceAllATOLandRTOLDivisor\":10,\"horizon\":300,\"costGuard\":\"aggregate-native-and-external-wall-deadlines;accepted-step-count-diagnostic\",\"maxl\":30,\"restarts\":0}},\"gates\":{{\"fullPairComparisonEvaluated\":{pair_evaluated},\"developedThermalResponse\":{},\"developedSourceResponse\":{},\"thermalResponse\":{thermal_details},\"sourceLocalRatio\":{},\"sourceFamilyRatio\":{},\"sourceObservableRatio\":{},\"sourceNCOperatorRatio\":{},\"thermalPairRatio\":{},\"networkPairRatio\":{},\"depositionPairRatio\":{},\"carrierPairRatio\":{}}},\"pairedComparisons\":[{}],\"fuelTemperatureFeedbackDiagnostic\":{feedback},\"normal\":{},\"tighter\":{tighter},\"aggregateWallSeconds\":{}}}",
        finite(
            tight
                .as_ref()
                .map_or(normal.last, |r| r.last.min(normal.last))
        ),
        prepared.model.dimension(),
        (0..prepared.model.dimension())
            .filter(|&i| prepared.model.is_differential(i))
            .count(),
        EnergyCoordinates::absolute(prepared.model.dimension(), 1.),
        thermal_developed.map_or("null".into(), |v| v.to_string()),
        source_developed.map_or("null".into(), |v| v.to_string()),
        if pair_evaluated {
            finite(max_source_local)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_source_family)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_source_observable)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_source_nc)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_thermal)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_network)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_deposit)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_carrier)
        } else {
            "null".into()
        },
        comparisons.join(","),
        normal.json(),
        finite(started.elapsed().as_secs_f64())
    );
    io::stdout().flush().map_err(|e| e.to_string())?;
    if passed {
        Ok(())
    } else {
        Err("Connected cold pair not qualified".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn callbacks(model: &source_cooling::Model) -> Callbacks<'_> {
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let power_weights = cooling_power::PowerWeights::new(&model.source).unwrap();
        let power_work = power_weights.workspace();
        Callbacks {
            model,
            work: model.workspace(),
            p: cooling_block::Preconditioner::new(model, &y, &yp).unwrap(),
            coordinates: Coordinates {
                nc: model.source.nc_dimension(),
                ledger: model.source.ledger_row(),
            },
            energy: EnergyCoordinates::new(model, &y).unwrap(),
            energy_p: cooling_energy_preconditioner::EnergyRow::new(
                model.dimension(),
                EnergyCoordinates::new(model, &y).unwrap().row,
            )
            .unwrap(),
            energy_p_setup_seconds: 0.,
            energy_p_solve_seconds: 0.,
            state: vec![0.; model.dimension()],
            slopes: vec![0.; model.dimension()],
            direction: vec![0.; model.dimension()],
            preconditioner_rhs: vec![0.; model.dimension()],
            power_weights,
            power_work,
            power_resolution_w: cooling_accuracy::DEPOSIT_RESOLUTION_W,
            start: Instant::now(),
            allowance: 120.,
            fatal: None,
            recoverable: 0,
            residuals: 0,
            bases: 0,
            actions: 0,
            residual_seconds: 0.,
            base_seconds: 0.,
            action_seconds: 0.,
            screen_seconds: 0.,
            io_seconds: 0.,
            error_telemetry_seconds: 0.,
            weight_calls: 0,
            weight_seconds: 0.,
            local_errors: LocalErrors::new(model),
            absolute: vec![0.01; model.dimension()],
            relative: 1e-5,
        }
    }
    #[test]
    fn actual_callbacks_use_same_trial_chain_and_independent_d_arithmetic() {
        let model = cooling_fixture::fixture();
        let n = model.dimension();
        let mut c = callbacks(&model);
        let physical = model.initial_state().unwrap();
        let mut solver = physical.clone();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&solver).unwrap();
        let yp = resources.vector(&vec![0.; n]).unwrap();
        let r = resources.vector(&vec![0.; n]).unwrap();
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { residual(0., y, yp, r, user) }, 0);
        let mut expected = c.work.residual.clone();
        c.coordinates.transform(&mut expected);
        let rates = c.work.source.rates().unwrap();
        expected[c.coordinates.ledger] =
            -(rates[..c.coordinates.nc].iter().sum::<f64>() - rates[c.coordinates.ledger]);
        let physical_energy_residual = c.energy.balance(&c.work.residual);
        expected[c.energy.row] = physical_energy_residual;
        // Residual G uses independently assembled actual rates, so its summing
        // association need not match the full physical-row sum bit-for-bit.
        for (i, (&a, &b)) in unsafe { values(r, n) }
            .unwrap()
            .iter()
            .zip(&expected)
            .enumerate()
        {
            if i == c.energy.row {
                assert!((a - b).abs() < 1e-8);
            } else {
                assert_eq!(a, b);
            }
        }
        for cj in [3., 1e12] {
            assert_eq!(unsafe { jtsetup(0., y, yp, r, cj, user) }, 0);
            let mut direction = (0..n).map(|i| 0.001 / (i + 1) as f64).collect::<Vec<_>>();
            direction[c.energy.row] = 0.125;
            direction[model.layout.energies_start] = 2e10;
            let v = resources.vector(&direction).unwrap();
            assert_eq!(
                unsafe {
                    jtimes(
                        0.,
                        y,
                        yp,
                        r,
                        v,
                        r,
                        cj,
                        user,
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                },
                0
            );
            let mut physical_direction = vec![0.; n];
            c.coordinates.physical(&direction, &mut physical_direction);
            c.energy.vector_to_physical(&mut physical_direction);
            let mut independent = model.workspace();
            model
                .evaluate(&physical, &vec![0.; n], Some(cj), &mut independent)
                .unwrap();
            model
                .jvp(&physical_direction, cj, &mut independent)
                .unwrap();
            let mut expected = independent.jvp.clone();
            c.coordinates.transform(&mut expected);
            let tangent = independent.source.rate_jvp().unwrap();
            expected[c.coordinates.ledger] = cj * direction[c.coordinates.ledger]
                - (tangent[..c.coordinates.nc].iter().sum::<f64>() - tangent[c.coordinates.ledger]);
            expected[c.energy.row] =
                cj * direction[c.energy.row] - independent.complete_energy_rate_jvp().unwrap();
            for (i, (&a, &b)) in unsafe { values(r, n) }
                .unwrap()
                .iter()
                .zip(&expected)
                .enumerate()
            {
                if i == c.energy.row {
                    assert!((a - b).abs() < 1e-8);
                } else {
                    assert_eq!(a, b);
                }
            }
            assert!(c.fatal.is_none());
        }
    }
    #[test]
    fn energy_chart_retains_injected_defect_release_and_distinct_affine_linear_maps() {
        let model = cooling_fixture::fixture();
        let initial = model.initial_state().unwrap();
        let g = EnergyCoordinates::new(&model, &initial).unwrap();
        assert!(g.row >= model.layout.network_start && g.row < model.layout.products_start);
        let d = Coordinates {
            nc: model.source.nc_dimension(),
            ledger: model.source.ledger_row(),
        };
        let mut physical = initial.clone();
        physical[g.row] += 2.;
        physical[model.source.fuel_release_row()] = 0.125;
        physical[d.ledger] = 0.25;
        let mut solver = physical.clone();
        d.transform(&mut solver);
        g.state_to_solver(&mut solver);
        assert_eq!(solver[g.row], 1.875);
        assert_eq!(solver[model.source.fuel_release_row()], 0.125);
        assert_eq!(solver[d.ledger], -0.25);
        let mut reverse_order = physical.clone();
        g.state_to_solver(&mut reverse_order);
        d.transform(&mut reverse_order);
        assert_eq!(solver, reverse_order);
        g.state_to_physical(&mut solver);
        d.transform(&mut solver);
        assert_eq!(solver, physical);
        let mut slope = vec![0.; initial.len()];
        slope[g.row] = 3.;
        slope[model.layout.energies_start] = 2.;
        slope[model.source.fuel_release_row()] = 0.5;
        let original = slope.clone();
        g.vector_to_solver(&mut slope);
        assert_eq!(slope[g.row], 4.5);
        g.vector_to_physical(&mut slope);
        assert_eq!(slope, original);
        assert_eq!(
            EnergyCoordinates::absolute(initial.len(), 1.)
                / EnergyCoordinates::absolute(initial.len(), 10.),
            10.
        );
    }
    #[test]
    fn energy_p_completion_keeps_non_g_rows_and_frozen_stage() {
        let model = cooling_fixture::fixture();
        let n = model.dimension();
        let mut c = callbacks(&model);
        let mut solver = model.initial_state().unwrap();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&solver).unwrap();
        let yp = resources.vector(&vec![0.; n]).unwrap();
        let r = resources.vector(&vec![0.; n]).unwrap();
        let z = resources.vector(&vec![0.; n]).unwrap();
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { psetup(0., y, yp, r, 3., user) }, 0);
        let rhs = (0..n)
            .map(|i| if i % 2 == 0 { 0.001 } else { -0.002 })
            .collect::<Vec<_>>();
        unsafe { output(r, n) }.unwrap().copy_from_slice(&rhs);
        let mut physical_rhs = rhs.clone();
        c.energy.vector_to_physical(&mut physical_rhs);
        let mut expected = vec![0.; n];
        c.p.solve(&model, &physical_rhs, &mut expected).unwrap();
        c.energy.vector_to_solver(&mut expected);
        assert_eq!(unsafe { psolve(0., y, yp, r, r, z, 3., 1., user) }, 0);
        let completed = unsafe { values(z, n) }.unwrap().to_vec();
        assert!((completed[c.energy.row] - rhs[c.energy.row] / 3.).abs() < 1e-12);
        assert!(c.energy_p.unit().iter().all(
            |&(row, _)| row >= model.layout.network_start && row < model.layout.products_start
        ));
        // Other components have zero unit response and are unchanged exactly.
        for row in 0..n {
            if row < model.layout.network_start || row >= model.layout.products_start {
                assert_eq!(completed[row], expected[row]);
            }
        }
        // Independently apply the native held-state network matrix, not the
        // completion formula, to verify EVERY retained non-G network equation.
        let physical = model.initial_state().unwrap();
        model
            .evaluate(&physical, &vec![0.; n], Some(3.), &mut c.work)
            .unwrap();
        let mut physical_solution = completed.clone();
        c.energy.vector_to_physical(&mut physical_solution);
        let network = &model.network;
        let mut action = vec![0.; network.dimension()];
        let mut gross = vec![0.; network.dimension()];
        for col in 0..network.dimension() {
            for k in
                network.column_pointers[col] as usize..network.column_pointers[col + 1] as usize
            {
                let row = network.row_indices[k] as usize;
                let value = c.work.network.jacobian_values[k]
                    * physical_solution[model.layout.network_start + col];
                action[row] += value;
                gross[row] += value.abs();
            }
        }
        for row in 0..network.dimension() {
            if row + model.layout.network_start != c.energy.row {
                assert!(
                    (action[row] - physical_rhs[model.layout.network_start + row]).abs()
                        <= 1e-10 * gross[row].max(1.)
                );
            }
        }
        let mut changed = solver.clone();
        changed[model.layout.temperatures_start] += 0.1;
        unsafe { output(y, n) }.unwrap().copy_from_slice(&changed);
        assert_eq!(unsafe { jtsetup(0., y, yp, r, 7., user) }, 0);
        assert_eq!(unsafe { psolve(0., y, yp, r, r, z, 7., 1., user) }, 0);
        assert_eq!(unsafe { values(z, n) }.unwrap(), completed);
        assert!(c.fatal.is_none());
        assert_eq!(unsafe { psetup(0., y, yp, r, 0., user) }, -1);
        assert!(c.energy_p.check().is_err());
        assert_eq!(unsafe { psolve(0., y, yp, r, r, z, 7., 1., user) }, -1);
    }
    #[test]
    fn energy_callback_does_not_suppress_off_invariant_state_or_slope() {
        let model = cooling_fixture::fixture();
        let n = model.dimension();
        let mut c = callbacks(&model);
        let mut solver = model.initial_state().unwrap();
        solver[c.energy.row] += 2.;
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        assert_eq!(solver[c.energy.row], 2.);
        let mut slope = vec![0.; n];
        slope[c.energy.row] = 0.25;
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&solver).unwrap();
        let yp = resources.vector(&slope).unwrap();
        let r = resources.vector(&vec![0.; n]).unwrap();
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { residual(0., y, yp, r, user) }, 0);
        assert_eq!(
            c.state[c.energy.row],
            model.initial_state().unwrap()[c.energy.row] + 2.
        );
        assert!((unsafe { values(r, n) }.unwrap()[c.energy.row] - 0.25).abs() < 1e-8);
        c.absolute[c.energy.row] = EnergyCoordinates::absolute(n, 1.);
        assert_eq!(unsafe { error_weights(y, r, user) }, 0);
        assert_eq!(
            unsafe { values(r, n) }.unwrap()[c.energy.row],
            1. / EnergyCoordinates::absolute(n, 1.)
        );
    }
    #[test]
    fn source_relative_weights_do_not_loosen_absolute_fluid_or_caloric_rows() {
        let model = cooling_fixture::fixture();
        let n = model.dimension();
        let mut c = callbacks(&model);
        let user = (&mut c as *mut Callbacks<'_>).cast();
        let mut resources = Resources::new().unwrap();
        let mut state = model.initial_state().unwrap();
        state[0] = 1e9;
        state[model.layout.products_start] = 1e9;
        c.coordinates.transform(&mut state);
        c.energy.state_to_solver(&mut state);
        let y = resources.vector(&state).unwrap();
        let w = resources.vector(&vec![0.; n]).unwrap();
        assert_eq!(unsafe { error_weights(y, w, user) }, 0);
        let weights = unsafe { values(w, n) }.unwrap();
        assert!(weights[0] >= 1. / (0.01 + 1e4));
        assert_eq!(weights[model.layout.network_start], 100.);
        assert_eq!(weights[model.layout.energies_start], 100.);
        assert!((weights[model.layout.products_start] - 1. / (0.01 + 1e4)).abs() < 1e-15);
        state[0] = f64::INFINITY;
        unsafe { output(y, n) }.unwrap().copy_from_slice(&state);
        assert_eq!(unsafe { error_weights(y, w, user) }, -1);
        assert!(c.fatal.is_some());
        assert_eq!(c.weight_calls, 2);
        assert!(c.weight_seconds.is_finite() && c.weight_seconds >= 0.);
    }
    #[test]
    fn carrier_progress_relative_weights_cover_only_owned_rows_and_refine_tenfold() {
        let model = cooling_fixture::fixture();
        let l = model.layout;
        let n = model.dimension();
        let mut c = callbacks(&model);
        let user = (&mut c as *mut Callbacks<'_>).cast();
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&vec![0.; n]).unwrap();
        let w = resources.vector(&vec![0.; n]).unwrap();
        let boundaries = [
            l.source_end - 1,
            l.network_start,
            l.products_start - 1,
            l.products_start,
            l.energies_start - 1,
            l.energies_start,
            l.temperatures_start,
            n - 1,
        ];
        for progress in [0., 1e-12, 1e12] {
            let mut state = model.initial_state().unwrap();
            for &r in &boundaries {
                state[r] = progress;
            }
            c.coordinates.transform(&mut state);
            c.energy.state_to_solver(&mut state);
            unsafe { output(y, n) }.unwrap().copy_from_slice(&state);
            c.absolute.fill(0.01);
            c.relative = 1e-5;
            c.power_resolution_w = cooling_accuracy::DEPOSIT_RESOLUTION_W;
            assert_eq!(unsafe { error_weights(y, w, user) }, 0);
            let normal = unsafe { values(w, n) }.unwrap().to_vec();
            for &r in &boundaries {
                let relative =
                    if r < l.source_end || (r >= l.products_start && r < l.energies_start) {
                        1e-5
                    } else {
                        0.
                    };
                assert_eq!(normal[r], 1. / (0.01 + relative * state[r].abs()));
            }
            c.absolute.fill(0.001);
            c.relative = 1e-6;
            c.power_resolution_w = cooling_accuracy::DEPOSIT_RESOLUTION_W / 10.;
            assert_eq!(unsafe { error_weights(y, w, user) }, 0);
            for (&a, &b) in unsafe { values(w, n) }.unwrap().iter().zip(&normal) {
                assert!((a / (10. * b) - 1.).abs() < 4e-16);
            }
        }
    }
    #[test]
    fn power_weight_callback_uses_physical_source_without_changing_trial_base() {
        let model = cooling_fixture::fixture();
        let n = model.dimension();
        let mut c = callbacks(&model);
        let mut physical = model.initial_state().unwrap();
        physical[0] = 2.;
        physical[model.source.ledger_row()] = 7.;
        let mut solver = physical.clone();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&solver).unwrap();
        let w = resources.vector(&vec![0.; n]).unwrap();
        let user = (&mut c as *mut Callbacks<'_>).cast();
        let before = c.state.clone();
        assert!(model.source.history_dimension() <= c.coordinates.ledger);
        assert_eq!(
            &solver[..model.source.history_dimension()],
            &physical[..model.source.history_dimension()]
        );
        let mut expected = (0..n)
            .map(|i| {
                c.absolute[i]
                    + if progress_relative(&model, i) {
                        c.relative * solver[i].abs()
                    } else {
                        0.
                    }
            })
            .collect::<Vec<_>>();
        let mut scratch = c.power_weights.workspace();
        c.power_weights
            .cap(
                &physical[..model.layout.source_end],
                c.relative,
                c.power_resolution_w,
                &mut expected,
                &mut scratch,
            )
            .unwrap();
        for _ in 0..2 {
            assert_eq!(unsafe { error_weights(y, w, user) }, 0);
            assert_eq!(c.state, before);
            for (&weight, &scale) in unsafe { values(w, n) }.unwrap().iter().zip(&expected) {
                assert_eq!(weight, 1. / scale);
            }
        }
        assert_eq!(c.weight_calls, 2);
        assert_eq!(c.residuals, 0);
        assert_eq!(c.bases, 0);
        assert!(c.metrics().contains("no-full-RHS-or-EOS"));
    }
    #[test]
    fn local_error_family_telemetry_is_a_coordinate_estimate_not_a_new_gate() {
        let model = cooling_fixture::fixture();
        let n = model.dimension();
        let mut t = LocalErrors::new(&model);
        let mut errors = vec![0.; n];
        let weights = vec![2.; n];
        for family in 0..7 {
            let row = t.labels.iter().position(|&x| x == family).unwrap();
            errors[row] = (family + 1) as f64;
        }
        t.observe(&errors, &weights, 3., 2, 3, 0.1).unwrap();
        assert_eq!(t.observations, 1);
        assert_eq!(t.last_order, 2);
        assert_eq!(t.current_order, 3);
        for (i, f) in t.families.iter().enumerate() {
            assert_eq!(f.maximum, 2. * (i + 1) as f64);
            assert_eq!(f.time, 3.);
            assert!((f.last_wrms / (f.maximum / (f.rows as f64).sqrt()) - 1.).abs() < 4e-16);
        }
        errors.fill(0.);
        t.observe(&errors, &weights, 4., 3, 3, 0.2).unwrap();
        assert_eq!(t.last_wrms, 0.);
        assert_eq!(t.families[4].maximum, 10.);
        assert!(
            t.json()
                .contains("not-global-error-bound-or-rejected-step-attribution")
        );
        errors[0] = f64::INFINITY;
        assert!(t.observe(&errors, &weights, 5., 3, 3, 0.2).is_err());
    }
    #[test]
    fn callback_nulls_and_nonfinite_ratio_fail_closed() {
        assert_eq!(
            unsafe {
                residual(
                    0.,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            -1
        );
        assert!(ratio(f64::MAX, f64::MIN_POSITIVE).is_err());
        assert!(ratio(0., 0.).is_err());
    }
    #[test]
    fn terminal_failure_retains_only_the_latest_admitted_owner() {
        let path = std::env::temp_dir().join(format!(
            "ld01-cooling-retention-{}-{}.checkpoint",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut run = Run {
            passed: false,
            reason: "callback refused".into(),
            last: 2.,
            returned: 3.,
            wall: 0.,
            steps: 0,
            samples: vec![],
            metrics: "{}".into(),
            initial: vec![],
            final_y: vec![4., -0.],
            final_yp: vec![5., 6.],
            max_number: 0.,
            max_energy: 0.,
            max_thermal_chart: 0.,
            stats: "null".into(),
        };
        retain_final_admitted(&path, &run, 0., "{}").unwrap();
        assert!(!path.exists());
        checkpoint(&path, 1., &[0., 0.], &[0., 0.]).unwrap();
        run.steps = 2;
        retain_final_admitted(&path, &run, 0., "{}").unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut expected = b"LDCOOL01".to_vec();
        expected.extend_from_slice(&2u64.to_le_bytes());
        expected.extend_from_slice(&run.last.to_le_bytes());
        for value in run.final_y.iter().chain(&run.final_yp) {
            expected.extend_from_slice(&value.to_le_bytes());
        }
        assert_eq!(bytes, expected);
        assert!(!path.with_extension("pending").exists());
        let pending = path.with_extension("pending");
        fs::write(&pending, b"occupied").unwrap();
        assert!(checkpoint(&path, 3., &[9., 9.], &[9., 9.]).is_err());
        assert_eq!(fs::read(&path).unwrap(), expected);
        fs::remove_file(pending).unwrap();
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn buffered_common_retains_exact_bits_atomically_and_refuses_overwrite() {
        let path = std::env::temp_dir().join(format!(
            "ld01-cooling-common-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let y = [-0., 1., f64::from_bits(0x7ff8_0000_0000_0001)];
        retain_common(&path, 2., &y).unwrap();
        let mut expected = b"LDCCOM01".to_vec();
        expected.extend_from_slice(&3u64.to_le_bytes());
        expected.extend_from_slice(&2f64.to_le_bytes());
        for x in y {
            expected.extend_from_slice(&x.to_le_bytes());
        }
        assert_eq!(fs::read(&path).unwrap(), expected);
        assert!(!path.with_extension("common-pending").exists());
        assert!(retain_common(&path, 3., &[9.]).is_err());
        assert_eq!(fs::read(&path).unwrap(), expected);
        fs::remove_file(&path).unwrap();
        #[cfg(unix)]
        {
            // exists() is false for a dangling destination: publication itself
            // must refuse replacement, not rely on the preflight check.
            std::os::unix::fs::symlink("absent-common-target", &path).unwrap();
            assert!(!path.exists());
            assert!(retain_common(&path, 3., &[9.]).is_err());
            assert!(
                fs::symlink_metadata(&path)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            fs::remove_file(path.with_extension("common-pending")).unwrap();
            fs::remove_file(path).unwrap();
        }
    }
}

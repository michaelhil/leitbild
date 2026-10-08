//! One connected offline source/fuel/carrier/primary/finite-SG transaction.
//! No live runtime, alternate backend, maintained sink or imposed power.
#![allow(dead_code)]
#[path = "cooling_accuracy.rs"]
mod cooling_accuracy;
#[path = "cooling_actuation.rs"]
mod cooling_actuation;
#[path = "cooling_block/mod.rs"]
mod cooling_block;
#[path = "cooling_bundle.rs"]
mod cooling_bundle;
#[path = "cooling_capture.rs"]
mod cooling_capture;
#[path = "cooling_convergence.rs"]
mod cooling_convergence;
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
#[path = "cooling_initial.rs"]
mod cooling_initial;
#[path = "cooling_input/mod.rs"]
mod cooling_input;
#[path = "cooling_mobile.rs"]
mod cooling_mobile;
#[path = "cooling_observation.rs"]
mod cooling_observation;
#[path = "cooling_power.rs"]
mod cooling_power;
#[path = "cooling_trial.rs"]
mod cooling_trial;
use cooling_trial::{progress_relative, recoverable, state_error_scale};
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
    barrel_thermal, cold_pressurizer, converter_heat, cylindrical_source, finite_surge,
    fuel_history, fuel_source, fuel_thermal, heat_history, moderator_source, operating_admission,
    operating_network, optical_source, passive_source, prhr, source_cooling, source_evolution,
    transport_source, water_carrier,
};
use source_coordinates::Coordinates;
use source_evolution::Evolution;
use std::{
    ffi::{c_int, c_long},
    fs,
    io::{self, Write},
    panic::{catch_unwind, AssertUnwindSafe},
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
use cooling_actuation::Schedule as PrhrSchedule;
fn prhr_input(
    schedule: Option<&PrhrSchedule>,
    time: f64,
    state: &[f64],
) -> Result<Option<prhr::Input>, String> {
    schedule
        .map(|s| s.input(time, state[s.room_row]))
        .transpose()
}
fn next_physical_event(schedule: Option<&PrhrSchedule>) -> Result<f64, String> {
    Ok(schedule
        .map(PrhrSchedule::next_event)
        .transpose()?
        .flatten()
        .unwrap_or(HORIZON)
        .min(HORIZON))
}
/// Continuous-position actuator events change owned forcing, not fluid IC.
/// Prove the exact residual support and identity-Fyp columns against the same
/// composed kernel before applying a sparse rate jump. No stock/algebraic
/// alignment or residual-zeroing projection is performed.
fn rate_only_prhr_event(
    model: &source_cooling::Model,
    y: &[f64],
    yp: &[f64],
    before: prhr::Input,
    after: prhr::Input,
    work: &mut source_cooling::Workspace,
) -> Result<(Vec<f64>, String), String> {
    let n = model.dimension();
    if y.len() != n || yp.len() != n || y.iter().chain(yp).any(|v| !v.is_finite()) {
        return Err("Invalid rate-only event state/rate shape".into());
    }
    let p = model
        .network
        .prhr()
        .ok_or("Rate-only event requires PRHR")?;
    let changes = p
        .rate_event_changes(before, after)?
        .map(|(r, d)| (model.layout.network_start + r, d));
    let mut delta = vec![0.; n];
    for &(r, d) in &changes {
        if !model.is_differential(r) {
            return Err("PRHR rate event owner is not differential".into());
        }
        delta[r] = d;
    }
    model.evaluate_with_prhr_input(y, yp, Some(0.), work, Some(before))?;
    let left = work.residual.clone();
    let mut diagonals = [0; 3];
    let mut invalid_rate_support = false;
    model.visit_fluid_rate_matrix(work, |r, c, v| {
        for (i, &(owner, _)) in changes.iter().enumerate() {
            if (r == owner || c == owner) && v != 0. {
                if r == owner && c == owner && v == 1. {
                    diagonals[i] += 1;
                } else {
                    invalid_rate_support = true;
                }
            }
        }
    })?;
    if invalid_rate_support || diagonals != [1; 3] {
        return Err("PRHR rate event lacks isolated identity-Fyp owners".into());
    }
    model.evaluate_with_prhr_input(y, yp, None, work, Some(after))?;
    let mut maximum_roundoff_ratio = 0_f64;
    let check = |right: &[f64], expected: &[f64], maximum: &mut f64| -> Result<(), String> {
        for r in 0..n {
            if !changes.iter().any(|&(owner, _)| owner == r) {
                if right[r].to_bits() != left[r].to_bits() {
                    return Err(format!("Rate-only event altered unrelated residual row{r}"));
                }
            } else {
                let error = (right[r] - left[r] - expected[r]).abs();
                let bound = 32.
                    * f64::EPSILON
                    * (right[r].abs() + left[r].abs() + yp[r].abs() + delta[r].abs());
                let ratio = if bound == 0. {
                    if error == 0. {
                        0.
                    } else {
                        f64::INFINITY
                    }
                } else {
                    error / bound
                };
                *maximum = maximum.max(ratio);
                if !ratio.is_finite() || ratio > 1. {
                    return Err(format!("Rate-only event residual proof row{r} error={error} arithmeticBound={bound}"));
                }
            }
        }
        Ok(())
    };
    let negative_delta = delta.iter().map(|v| -v).collect::<Vec<_>>();
    check(&work.residual, &negative_delta, &mut maximum_roundoff_ratio)?;
    let mut updated = yp.to_vec();
    for &(r, d) in &changes {
        if d != 0. {
            updated[r] += d;
        }
    }
    model.evaluate_with_prhr_input(y, &updated, None, work, Some(after))?;
    check(&work.residual, &vec![0.; n], &mut maximum_roundoff_ratio)?;
    let owners = changes
        .iter()
        .map(|&(r, d)| format!("{{\"row\":{r},\"rateDelta\":{}}}", finite(d)))
        .collect::<Vec<_>>()
        .join(",");
    Ok((delta, format!("{{\"scope\":\"continuous-position-and-ambient;owned-isolated-identity-Fyp-rate-jump;full-composed-residual-support-proof\",\"affectedOwners\":[{owners}],\"allStateBitsPreserved\":true,\"unrelatedRateBitsPreserved\":true,\"maximumArithmeticResidualProofRatio\":{},\"fluidICCalls\":0}}",finite(maximum_roundoff_ratio))))
}
fn solver_rate_jump(
    coordinates: &Coordinates,
    energy: &EnergyCoordinates,
    accepted: &[f64],
    physical_delta: &[f64],
) -> Result<(Vec<f64>, Vec<f64>), String> {
    if accepted.len() != physical_delta.len()
        || accepted.is_empty()
        || energy.row >= accepted.len()
        || coordinates.ledger >= accepted.len()
        || coordinates.nc > accepted.len()
        || accepted
            .iter()
            .chain(physical_delta)
            .any(|v| !v.is_finite())
    {
        return Err("Invalid sparse event rate shape/value".into());
    }
    let mut delta = physical_delta.to_vec();
    coordinates.transform(&mut delta);
    energy.vector_to_solver(&mut delta);
    let mut updated = accepted.to_vec();
    for (rate, &change) in updated.iter_mut().zip(&delta) {
        if change != 0. {
            *rate += change;
        }
    }
    if updated.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite event rate jump".into());
    }
    Ok((updated, delta))
}
struct Callbacks<'a> {
    model: &'a source_cooling::Model,
    convergence: cooling_convergence::Convergence<'a>,
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
    barrel_weights: cooling_power::BarrelWeights,
    capture_weights: cooling_power::CaptureWeights,
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
    prhr: Option<PrhrSchedule>,
}
impl<'a> Callbacks<'a> {
    /// One callback/preconditioner owner for normal advancement and bounded
    /// retained-state diagnostics. Inputs are physical; no initialization occurs.
    fn new(
        model: &'a source_cooling::Model,
        physical: &[f64],
        physical_slopes: &[f64],
        work: source_cooling::Workspace,
        energy: EnergyCoordinates,
        mut absolute: Vec<f64>,
        prhr: Option<PrhrSchedule>,
        time: f64,
        refinement: f64,
        start: Instant,
        allowance: f64,
    ) -> Result<Box<Self>, String> {
        let n = model.dimension();
        let input = prhr_input(prhr.as_ref(), time, physical)?;
        absolute[energy.row] = EnergyCoordinates::absolute(n, refinement);
        let power_weights = cooling_power::PowerWeights::new(&model.source)?;
        let power_work = power_weights.workspace();
        let mut convergence = cooling_convergence::Convergence::new(model, input)?;
        convergence.seat_flow_allocation(&absolute)?;
        Ok(Box::new(Self {
            model,
            convergence,
            work,
            p: cooling_block::Preconditioner::new(model, physical, physical_slopes, input)?,
            coordinates: Coordinates {
                nc: model.source.nc_dimension(),
                ledger: model.source.ledger_row(),
            },
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
            barrel_weights: cooling_power::BarrelWeights::new(
                &model.source,
                model.barrel.config().targets,
                model.barrel.config().capture_photon_j,
            )?,
            capture_weights: cooling_power::CaptureWeights::new(model)?,
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
            prhr,
        }))
    }
}

/// Shared production IDA policy. A retained restart changes only the initial
/// time/state, never solver tolerances, P, nonlinear tests or physical models.
fn install_solver(
    owned: &mut Resources,
    callbacks: &mut Callbacks<'_>,
    time: f64,
    y: Handle,
    yp: Handle,
) -> Result<(), String> {
    let model = callbacks.model;
    let n = model.dimension();
    let ids = owned.vector(
        &(0..n)
            .map(|i| f64::from(model.is_differential(i)))
            .collect::<Vec<_>>(),
    )?;
    let constraints = owned.vector(&physical_constraints(model, callbacks.energy.row))?;
    owned.spgmr(y, 30, 0)?;
    owned.ida = unsafe { IDACreate(owned.context) };
    if owned.ida.is_null() {
        return Err("Null coupled IDA".into());
    }
    checked(
        unsafe { IDAInit(owned.ida, residual, time, y, yp) },
        "Coupled IDA init",
    )?;
    checked(
        unsafe { IDASetUserData(owned.ida, (callbacks as *mut Callbacks<'_>).cast()) },
        "Coupled callback owner",
    )?;
    checked(
        unsafe { IDASetId(owned.ida, ids) },
        "Coupled differential mask",
    )?;
    // Only independent physical stocks control temporal truncation. Algebraic
    // outputs remain in Newton's norm and current physical-chart admission;
    // their accuracy is independently checked in the refined output pair.
    checked(
        unsafe { IDASetSuppressAlg(owned.ida, 1) },
        "Differential-stock temporal LTE control",
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
    checked(
        unsafe { IDASetEpsLin(owned.ida, cooling_convergence::EPS_LIN) },
        "Explicit linear convergence coefficient",
    )?;
    checked(
        unsafe { IDASetNonlinConvCoef(owned.ida, cooling_convergence::NONLINEAR_COEFFICIENT) },
        "Explicit stock nonlinear convergence coefficient",
    )?;
    checked(
        unsafe { IDASetLSNormFactor(owned.ida, 1.) },
        "Dimension-independent linear L2 norm factor",
    )?;
    let nonlinear = owned.newton(y)?;
    checked(
        unsafe { IDASetNonlinearSolver(owned.ida, nonlinear) },
        "Owned stock Newton",
    )?;
    callbacks
        .convergence
        .budget(callbacks.start, callbacks.allowance);
    callbacks.convergence.prhr_schedule = callbacks.prhr.clone();
    callbacks.convergence.install(owned.ida, nonlinear)?;
    checked(
        unsafe { IDASetStopTime(owned.ida, next_physical_event(callbacks.prhr.as_ref())?) },
        "Actual next mechanism contact or 300 s horizon",
    )?;
    Ok(())
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
    fn IDAReInit(memory: Handle, time: f64, y: Handle, yp: Handle) -> c_int;
    fn IDASetInitStep(memory: Handle, step: f64) -> c_int;
    fn IDASetSuppressAlg(memory: Handle, suppress: c_int) -> c_int;
}
fn developed_barrel(change: f64, difference: f64) -> bool {
    change.is_finite()
        && difference.is_finite()
        && change > (10. * difference).max(cooling_accuracy::TEMPERATURE_ATOL)
}
fn physical_constraints(model: &source_cooling::Model, energy_row: usize) -> Vec<f64> {
    let l = model.layout;
    let mut out = vec![0.; model.dimension()];
    out[..l.source_end].fill(1.);
    out[model.source.ledger_row()] = 0.;
    out[energy_row] = 0.;
    out[l.carrier_start..l.energies_start].fill(1.);
    out[l.temperatures_start..l.barrel_energy].fill(2.);
    out[l.barrel_temperature] = 2.;
    out[l.barrel_released] = 1.;
    out[l.barrel_exported] = 1.;
    out[l.fuel_capture_exported] = 1.;
    out[l.mobile_capture_exported] = 1.;
    out[l.mobile_capture_boundary_exported] = 1.;
    out[l.absorber_guide_temperatures_start..l.absorber_guide_exported].fill(2.);
    out[l.absorber_guide_exported] = 1.;
    for row in [
        cold_pressurizer::LIQUID_MASS,
        cold_pressurizer::VAPOR_MASS,
        cold_pressurizer::LIQUID_TEMPERATURE,
        cold_pressurizer::GAS_TEMPERATURE,
        cold_pressurizer::SURFACE_PRESSURE,
        cold_pressurizer::VAPOR_PRESSURE,
        cold_pressurizer::HEIGHT,
        cold_pressurizer::INTERFACE_TEMPERATURE,
        cold_pressurizer::LIQUID_PRESSURE,
    ] {
        out[l.pressurizer_start + row] = 2.;
    }
    out[l.pressurizer_start + cold_pressurizer::METAL_TEMPERATURE_START..l.surge_start].fill(2.);
    for row in [
        finite_surge::MASS,
        finite_surge::PRESSURE,
        finite_surge::TEMPERATURE,
        finite_surge::STEEL_TEMPERATURE,
    ] {
        out[l.surge_start + row] = 2.;
    }
    out[l.surge_carrier_start..=l.gas_hydrogen_product].fill(1.);
    // Ambient receipt and both signed endpoint flows remain unconstrained.
    out
}
const ERROR_FAMILIES: [&str; 18] = [
    "source-N",
    "source-C",
    "source-history-and-audits",
    "network",
    "carrier-target-and-products",
    "thermal-energy",
    "thermal-temperature",
    "barrel-energy-temperature-emission-export",
    "pressurizer-two-energy-phase-metals",
    "finite-surge-fluid-steel-flows",
    "line-pool-gas-carrier",
    "signed-ambient-export",
    "fuel-binding-photon-export",
    "mobile-binding-installed-wall-exit",
    "mobile-binding-unrepresented-wall-boundary",
    "absorber-guide-energy",
    "absorber-guide-temperature",
    "absorber-guide-photon-export",
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
    families: [ErrorFamily; ERROR_FAMILIES.len()],
    labels: Vec<usize>,
    differential: Vec<bool>,
    observations: u64,
    last_order: c_int,
    current_order: c_int,
    last_h: f64,
    last_wrms: f64,
    last_controller_wrms: f64,
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
                } else if r < l.carrier_start {
                    3
                } else if r < l.energies_start {
                    4
                } else if r < l.temperatures_start {
                    5
                } else if r < l.barrel_energy {
                    6
                } else if r < l.pressurizer_start {
                    7
                } else if r < l.surge_start {
                    8
                } else if r < l.surge_carrier_start {
                    9
                } else if r < l.ambient_exported {
                    10
                } else if r == l.ambient_exported {
                    11
                } else if r == l.fuel_capture_exported {
                    12
                } else if r == l.mobile_capture_exported {
                    13
                } else if r == l.mobile_capture_boundary_exported {
                    14
                } else if r < l.absorber_guide_temperatures_start {
                    15
                } else if r < l.absorber_guide_exported {
                    16
                } else {
                    17
                }
            })
            .collect::<Vec<_>>();
        let mut families = [ErrorFamily::default(); ERROR_FAMILIES.len()];
        for &label in &labels {
            families[label].rows += 1;
        }
        Self {
            families,
            labels,
            differential: (0..model.dimension())
                .map(|row| model.is_differential(row))
                .collect(),
            observations: 0,
            last_order: 0,
            current_order: 0,
            last_h: 0.,
            last_wrms: 0.,
            last_controller_wrms: 0.,
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
        let mut squares = [0.; ERROR_FAMILIES.len()];
        let mut controlled_sum = 0.;
        for (row, ((&error, &weight), &family)) in
            errors.iter().zip(weights).zip(&self.labels).enumerate()
        {
            let value = (error * weight).abs();
            if !error.is_finite() || !weight.is_finite() || weight <= 0. || !value.is_finite() {
                return Err("Nonfinite local-error telemetry".into());
            }
            squares[family] += value * value;
            if self.differential[row] {
                controlled_sum += value * value;
            }
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
        // N_VWrmsNormMask divides by the FULL vector length, not the number
        // of selected rows. Match the installed IDA policy exactly.
        self.last_controller_wrms = (controlled_sum / errors.len() as f64).sqrt();
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
            "{{\"scope\":\"solver-coordinate-IDAGetEstLocalErrors-times-current-IDAGetErrWeights;D-ledger-and-G-energy-transforms-included;accepted-steps-only;not-global-error-bound-or-rejected-step-attribution\",\"controllerNormScope\":\"differential-stock-mask;sum-selected-squares-divided-by-full-vector-length;matches-N_VWrmsNormMask\",\"familyNormScope\":\"all-coordinates-including-algebraic;diagnostic-not-controller\",\"observations\":{},\"lastOrder\":{},\"currentOrder\":{},\"lastH\":{},\"lastAllCoordinateWRMS\":{},\"lastControllerWRMS\":{},\"families\":[{}]}}",
            self.observations,
            self.last_order,
            self.current_order,
            finite(self.last_h),
            finite(self.last_wrms),
            finite(self.last_controller_wrms),
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
                let scale = state_error_scale(c.model, i, y[i], c.absolute[i], c.relative);
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
            c.barrel_weights.cap(
                &y[..c.model.layout.source_end],
                c.relative,
                c.power_resolution_w,
                out,
            )?;
            c.capture_weights
                .cap(y, c.relative, c.power_resolution_w, out)?;
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
    fn evaluate(
        &mut self,
        time: f64,
        y: Handle,
        yp: Handle,
        cj: Option<f64>,
    ) -> Result<(), String> {
        let n = self.model.dimension();
        self.coordinates
            .physical(unsafe { values(y, n) }?, &mut self.state);
        self.energy.state_to_physical(&mut self.state);
        self.coordinates
            .physical(unsafe { values(yp, n) }?, &mut self.slopes);
        self.energy.vector_to_physical(&mut self.slopes);
        let input = prhr_input(self.prhr.as_ref(), time, &self.state)?;
        self.model
            .evaluate_with_prhr_input(&self.state, &self.slopes, cj, &mut self.work, input)
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
            "{{\"residuals\":{},\"linearBases\":{},\"JVPs\":{},\"residualSeconds\":{},\"linearBaseSeconds\":{},\"JVPSeconds\":{},\"errorWeightCalls\":{},\"errorWeightSeconds\":{},\"errorWeightScope\":\"ordinary-scales-plus-current-sparse-power-cap-and-reciprocal;no-full-RHS-or-EOS\",\"acceptedAndCommonPreparationScreenSeconds\":{},\"retentionIOSeconds\":{},\"retentionIOScope\":\"checkpoint-common-and-terminal-file-write-flush-sync-rename;terminal-progress-flush-included\",\"localErrorTelemetrySeconds\":{},\"acceptedLocalErrorEstimates\":{},\"recoverableTrials\":{},\"nonlinearClosure\":{},\"energyPCompletion\":{completion},\"P\":{}}}",
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
            self.convergence.json(),
            self.p.metrics_json()
        )
    }
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
unsafe extern "C" fn residual(time: f64, y: Handle, yp: Handle, r: Handle, user: Handle) -> c_int {
    callback(user, |c| {
        let t = Instant::now();
        c.residuals += 1;
        let evaluated = c.evaluate(time, y, yp, None);
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
    time: f64,
    y: Handle,
    yp: Handle,
    _: Handle,
    cj: f64,
    user: Handle,
) -> c_int {
    callback(user, |c| {
        let t = Instant::now();
        c.bases += 1;
        let r = c.evaluate(time, y, yp, Some(cj));
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
    time: f64,
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
        let input = prhr_input(c.prhr.as_ref(), time, &c.state)?;
        c.p.setup(c.model, &c.state, &c.slopes, cj, input)
            .map_err(|e| format!("{e}; actual P setup time={time}"))?;
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
    final_prhr: Option<prhr::Input>,
    max_number: f64,
    max_energy: f64,
    max_thermal_chart: f64,
    max_pressure_chart: f64,
    max_pressure_flow: f64,
    surge_flow_extrema: [[f64; 2]; 2],
    initialization: String,
    stats: String,
    pressure_evidence: Option<cooling_observation::Trace>,
    actuation: cooling_actuation::Receipt,
}
impl Run {
    fn json(&self) -> String {
        format!(
            "{{\"passed\":{},\"reason\":{},\"lastAdmittedTime\":{},\"returnedTime\":{},\"wallSeconds\":{},\"screenedStatesIncludingInitial\":{},\"commonSamples\":{},\"maxSourceNumberDefect\":{},\"maxSourceEnergyDefectJ\":{},\"maxThermalChartK\":{},\"maxPressureChartRatio\":{},\"maxPressureFlowClosureRatio\":{},\"hydraulicResidualScope\":\"algebraic-current-state;independent-of-Dky1-polynomial-slopes\",\"actualSurgeFlowExtremaKgPerS\":{:?},\"initialization\":{},\"stats\":{},\"costs\":{}}}",
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
            finite(self.max_pressure_chart),
            finite(self.max_pressure_flow),
            self.surge_flow_extrema,
            self.initialization,
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
    f.write_all(b"LDPTST01")
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
    f.write_all(b"LDPTCM01")
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
    pressure_channel: leitbild_plant_numerics::pressure_channel::Config,
    pressure_protection: leitbild_plant_numerics::pressure_protection::Settings,
    prhr_action: Option<cooling_input::PrhrAction>,
    actuation: Option<&cooling_actuation::Plan>,
    refinement: f64,
    start: Instant,
    allowance: f64,
    checkpoint_path: &Path,
    reference: Option<&Run>,
) -> Result<Run, String> {
    if checkpoint_path.exists() {
        return Err("Refusing existing coupled checkpoint".into());
    }
    if let Some(r) = reference {
        cooling_accuracy::check_schedule(&r.samples)?;
    }
    let began = Instant::now();
    let n = model.dimension();
    let l = model.layout;
    let schedule = PrhrSchedule::new(model, prhr_action, actuation)?;
    let initial_input = schedule.as_ref().map(|s| s.input(0., 0.)).transpose()?;
    let mut initial = model.initial_state_with_prhr_input(initial_input)?;
    let mut slopes = vec![0.; n];
    let mut work = model.workspace();
    let initial_input = prhr_input(schedule.as_ref(), 0., &initial)?;
    model.evaluate_with_prhr_input(&initial, &slopes, None, &mut work, initial_input)?;
    for i in 0..n {
        if model.is_differential(i) {
            slopes[i] = -work.residual[i];
        }
    }
    let absolute = accuracy.absolute(refinement)?;
    let initialization = match cooling_initial::initialize(
        model,
        &mut initial,
        &mut slopes,
        &absolute,
        &mut work,
        start,
        allowance,
        1e-5 / refinement,
        &mut cooling_initial::Trace::default(),
        initial_input,
    ) {
        Ok(report) => report.json(),
        Err(reason) => {
            let path = checkpoint_path.with_extension("initialization-refusal");
            checkpoint(&path, 0., &initial, &slopes)?;
            println!(
                "{{\"kind\":\"initialization-refusal\",\"passed\":false,\"lastAdmittedTime\":0,\"reason\":{},\"unadmittedRawStatePath\":{}}}",
                quote(&reason),
                quote(&path.display().to_string())
            );
            io::stdout().flush().map_err(|e| e.to_string())?;
            return Err(reason);
        }
    };
    let energy = EnergyCoordinates::new(model, &initial)?;
    let flow_absolute = accuracy.flow_absolute(refinement)?;
    let coordinates = Coordinates {
        nc: model.source.nc_dimension(),
        ledger: model.source.ledger_row(),
    };
    let mut callbacks = Callbacks::new(
        model, &initial, &slopes, work, energy, absolute, schedule, 0., refinement, start,
        allowance,
    )?;
    coordinates.transform(&mut initial);
    callbacks.energy.state_to_solver(&mut initial);
    coordinates.transform(&mut slopes);
    callbacks.energy.vector_to_solver(&mut slopes);
    let mut owned = Resources::new()?;
    let y = owned.vector(&initial)?;
    let yp = owned.vector(&slopes)?;
    let endpoint_y = owned.vector(&initial)?;
    let endpoint_yp = owned.vector(&slopes)?;
    let common = owned.vector(&initial)?;
    let local_error = owned.vector(&vec![0.; n])?;
    let error_weight = owned.vector(&vec![0.; n])?;
    install_solver(&mut owned, &mut callbacks, 0., y, yp)?;
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
        final_prhr: initial_input,
        max_number: 0.,
        max_energy: 0.,
        max_thermal_chart: 0.,
        max_pressure_chart: 0.,
        max_pressure_flow: 0.,
        surge_flow_extrema: [[0.; 2]; 2],
        initialization,
        stats: "null".into(),
        pressure_evidence: None,
        actuation: cooling_actuation::Receipt::default(),
    };
    // These are actual native q coordinates, including the compiled seat's
    // achieved flow (not a conductance proxy). Reuse every existing Dky
    // vector below; no extra plant solve or per-tick full-state capture.
    let mut dense_flow_rows = vec![
        l.surge_start + finite_surge::LEFT_FLOW,
        l.surge_start + finite_surge::RIGHT_FLOW,
    ];
    let mut normal_dense_flow_absolute = vec![1e-5; 2];
    if let Some(seat) = model.network.config().seat {
        dense_flow_rows.push(l.network_start + model.network.flow_row(seat.edge));
        normal_dense_flow_absolute.push(accuracy.flow_absolute(1.)?[seat.edge]);
    }
    let dense_pressure_rows = [
        l.surge_start + finite_surge::PRESSURE,
        l.network_start + model.network.pressure_row(),
    ];
    let mut observation = cooling_observation::Trace::new(
        pressure_channel,
        pressure_protection,
        [model.pressure_connection().pressurizer.top_pressure(
            out.initial[l.pressurizer_start..l.surge_start]
                .try_into()
                .unwrap(),
        )?; 3],
        model.pressure_connection().pressurizer.top_pressure(
            out.initial[l.pressurizer_start..l.surge_start]
                .try_into()
                .unwrap(),
        )?,
        cooling_observation::DenseAudit {
            flows: dense_flow_rows.iter().map(|&r| out.initial[r]).collect(),
            pressure_changes: [0.; 2],
        },
        normal_dense_flow_absolute,
    )?;
    let mut last_checkpoint = Instant::now();
    let mut pressure_chart_work = model.pressure_connection().pressurizer.workspace();
    let mut surge_chart_work = model.pressure_connection().surge.workspace();
    let mut completed_segments = Vec::new();
    let advance = (|| -> Result<(), String> {
        loop {
            callbacks.budget()?;
            if out.steps > 0 {
                let status = unsafe { IDASolve(owned.ida, HORIZON, &mut out.returned, y, yp, 2) };
                checked_ida_step(
                    status,
                    callbacks
                        .fatal
                        .as_deref()
                        .or(callbacks.convergence.fatal.as_deref()),
                )?;
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
                let input = prhr_input(callbacks.prhr.as_ref(), out.returned, &physical)?;
                model.evaluate_with_prhr_input(
                    &physical,
                    &physical_yp,
                    None,
                    &mut callbacks.work,
                    input,
                )?;
                if let Some(s) = callbacks.prhr.as_ref() {
                    let (energy, thermal) = s.audit(out.returned, &physical)?;
                    out.actuation.maximum_energy = out.actuation.maximum_energy.max(energy);
                    out.actuation.maximum_thermal = out.actuation.maximum_thermal.max(thermal);
                }
                model.validate_accepted(&physical, &callbacks.work)?;
                accuracy.carrier_ledger(model, &physical)?;
                accuracy.prhr_ledgers(model, &physical)?;
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
                    &physical[l.network_start..l.carrier_start],
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
                let dt = callbacks.work.residual[l.barrel_temperature].abs()
                    / callbacks.work.barrel.capacity()?;
                if !dt.is_finite() || dt > 1e-4 {
                    return Err(format!("Barrel caloric chart correction {dt} K"));
                }
                out.max_thermal_chart = out.max_thermal_chart.max(dt);
                for (i, &cp) in callbacks.work.absorber_guide.capacity.iter().enumerate() {
                    let dt =
                        callbacks.work.residual[l.absorber_guide_temperatures_start + i].abs() / cp;
                    if !dt.is_finite() || dt > 1e-4 {
                        return Err(format!("BODY/guide caloric chart {i} correction {dt} K"));
                    }
                    out.max_thermal_chart = out.max_thermal_chart.max(dt);
                }
                let (pool, line) = model.pressure_chart_corrections(
                    &callbacks.work.network,
                    &physical,
                    &physical_yp,
                    &mut pressure_chart_work,
                    &mut surge_chart_work,
                )?;
                let head = cooling_accuracy::pressure_level_head_scale(
                    model,
                    &physical,
                    &pressure_chart_work,
                )?;
                let chart_ratio = cooling_accuracy::pressure_chart_ratio(&pool, &line, head)?;
                cooling_accuracy::check_pressure_chart(model, &pool, &line, head)?;
                let caloric_ratio = cooling_convergence::pressure_caloric_ratio(
                    model,
                    &physical,
                    &pressure_chart_work,
                    &surge_chart_work,
                )?;
                if caloric_ratio > 1. {
                    return Err(format!(
                        "Pressure metal caloric chart ratio {caloric_ratio}"
                    ));
                }
                out.max_pressure_chart = out.max_pressure_chart.max(chart_ratio.max(caloric_ratio));
                let flow_ratio =
                    cooling_convergence::pressure_flow_ratio(model, &surge_chart_work)?;
                // These two hydraulic equations are algebraic and consume no
                // yp. The same physical closure applies at every endpoint.
                if flow_ratio > 1. {
                    return Err(format!(
                        "Current surge hydraulic closure exceeds1Pa: ratio={flow_ratio}"
                    ));
                }
                out.max_pressure_flow = out.max_pressure_flow.max(flow_ratio);
                let q = callbacks.work.surge.receipts()?.mass;
                for (k, value) in [q[0], -q[1]].into_iter().enumerate() {
                    out.surge_flow_extrema[k][0] = out.surge_flow_extrema[k][0].min(value);
                    out.surge_flow_extrema[k][1] = out.surge_flow_extrema[k][1].max(value);
                }
                Ok(())
            })();
            callbacks.screen_seconds += screen_started.elapsed().as_secs_f64();
            admitted?;
            let segment_start = out.last;
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
            // The roof tap is a linear combination of native PZR coordinates.
            // Read the LAST used polynomial order (not next proposed order),
            // then exactly continue downstream electronic lag independently.
            // No instrument deadline changes the physical solver or its norms.
            if out.returned > 0. {
                let observed = Instant::now();
                let prior = observation.seconds;
                let order = callbacks.local_errors.last_order;
                if !(1..=5).contains(&order) {
                    return Err("Unsupported accepted pressure dense order".into());
                }
                let pzr = &model.pressure_connection().pressurizer;
                let state: &[f64; leitbild_plant_numerics::cold_pressurizer::STATES] = out.final_y
                    [l.pressurizer_start..l.surge_start]
                    .try_into()
                    .unwrap();
                let mut derivatives = vec![pzr.top_pressure(state)?];
                let mut dense = cooling_observation::DensePolynomial {
                    flows: dense_flow_rows
                        .iter()
                        .map(|&r| vec![out.final_y[r]])
                        .collect(),
                    pressure_changes: dense_pressure_rows
                        .map(|r| vec![out.final_y[r] - out.initial[r]]),
                };
                for k in 1..=order {
                    checked(
                        unsafe { IDAGetDky(owned.ida, out.returned, k, common) },
                        "Accepted roof-pressure polynomial derivative",
                    )?;
                    let v = unsafe { values(common, n) }?;
                    for (values, &row) in dense.flows.iter_mut().zip(&dense_flow_rows) {
                        values.push(v[row]);
                    }
                    for (values, row) in dense.pressure_changes.iter_mut().zip(dense_pressure_rows)
                    {
                        values.push(v[row]);
                    }
                    derivatives.push(pzr.top_pressure_direction(
                        state,
                        v[l.pressurizer_start..l.surge_start].try_into().unwrap(),
                    )?);
                }
                let reference = reference
                    .map(|r| {
                        r.pressure_evidence
                            .as_ref()
                            .ok_or("Missing normal pressure evidence")
                    })
                    .transpose()?;
                observation.continue_dense(
                    segment_start,
                    out.returned,
                    &derivatives,
                    &dense,
                    reference,
                )?;
                observation.seconds = prior + observed.elapsed().as_secs_f64();
            }
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
                let input = prhr_input(callbacks.prhr.as_ref(), time, &callbacks.state)?;
                model.evaluate_with_prhr_input(
                    &callbacks.state,
                    &vec![0.; n],
                    None,
                    &mut callbacks.work,
                    input,
                )?;
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
                    barrel_power: cooling_accuracy::barrel_powers(&callbacks.work)?,
                    capture_power: callbacks.work.capture.power_channels()?.to_vec(),
                    mobile_power: callbacks.work.mobile_capture.value()?.channels.clone(),
                    bundle_power: cooling_bundle::powers(&callbacks.work),
                    mobile_recipient_power: callbacks
                        .work
                        .mobile_capture
                        .value()?
                        .recipient_power()
                        .collect(),
                    surge_flow: {
                        let r = callbacks.work.surge.receipts()?;
                        [r.mass[0], -r.mass[1]]
                    },
                };
                callbacks.screen_seconds += common_started.elapsed().as_secs_f64();
                let io_started = Instant::now();
                let common_path =
                    checkpoint_path.with_extension(format!("common-{}.bin", out.samples.len()));
                retain_common(&common_path, time, &sample.y)?;
                if let Some(s) = &callbacks.prhr {
                    s.retain(&common_path, time)?;
                    out.actuation.record(s, time, &sample.y, false)?;
                }
                callbacks.io_seconds += io_started.elapsed().as_secs_f64();
                if let Some(reference) = reference {
                    let comparison = accuracy.compare_one(
                        model,
                        &reference.samples[out.samples.len()],
                        &sample,
                    )?;
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
                if let Some(s) = &callbacks.prhr {
                    s.retain(checkpoint_path, out.last)?;
                }
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
            if callbacks.prhr.is_some()
                && next_physical_event(callbacks.prhr.as_ref())? == out.returned
            {
                // All dense observations of the old smooth interval are complete.
                // Position and every stock/algebraic alignment are continuous.
                // Change only native actuator forcing rates, not fluid IC.
                let accepted_solver = unsafe { values(endpoint_y, n)? }.to_vec();
                let accepted_solver_yp = unsafe { values(endpoint_yp, n)? }.to_vec();
                if !model.is_differential(coordinates.ledger)
                    || (0..coordinates.nc).any(|row| !model.is_differential(row))
                {
                    return Err("Source D transform has non-differential event dependency".into());
                }
                let mut next_schedule = callbacks.prhr.clone();
                let before_input = prhr_input(callbacks.prhr.as_ref(), out.returned, &physical)?
                    .ok_or("Missing pre-event PRHR input")?;
                next_schedule.as_mut().unwrap().accept_event(out.returned)?;
                let input = prhr_input(next_schedule.as_ref(), out.returned, &physical)?
                    .ok_or("Missing post-event PRHR input")?;
                let (delta, event_proof) = rate_only_prhr_event(
                    model,
                    &physical,
                    &physical_yp,
                    before_input,
                    input,
                    &mut callbacks.work,
                )?;
                for (rate, &change) in physical_yp.iter_mut().zip(&delta) {
                    if change != 0. {
                        *rate += change;
                    }
                }
                let (syp, solver_delta) =
                    solver_rate_jump(&coordinates, &callbacks.energy, &accepted_solver_yp, &delta)?;
                let delta_g = solver_delta[callbacks.energy.row];
                let delta_d = solver_delta[coordinates.ledger];
                completed_segments.push(format!(
                    "{{\"endTime\":{},\"solverStats\":{}}}",
                    finite(out.returned),
                    solver_stats(owned.ida)?
                ));
                callbacks.prhr = next_schedule;
                callbacks.convergence.prhr_schedule = callbacks.prhr.clone();
                unsafe { output(y, n)? }.copy_from_slice(&accepted_solver);
                unsafe { output(yp, n)? }.copy_from_slice(&syp);
                checked(
                    unsafe { IDAReInit(owned.ida, out.returned, y, yp) },
                    "Actual PRHR contact reinitialization",
                )?;
                checked(
                    unsafe {
                        IDASetStopTime(owned.ida, next_physical_event(callbacks.prhr.as_ref())?)
                    },
                    "Next actual PRHR contact",
                )?;
                callbacks.energy_p.invalidate();
                out.final_y = physical.clone();
                out.final_yp = physical_yp.clone();
                if let Some(s) = &callbacks.prhr {
                    let io_started = Instant::now();
                    let path = checkpoint_path
                        .with_extension(format!("event-{}.bin", out.actuation.events.len()));
                    retain_common(&path, out.returned, &physical)?;
                    s.retain(&path, out.returned)?;
                    callbacks.io_seconds += io_started.elapsed().as_secs_f64();
                    out.actuation.record(s, out.returned, &physical, true)?;
                }
                let support = callbacks
                    .prhr
                    .as_ref()
                    .map(|s| s.point(out.returned).map(|p| p.json()))
                    .transpose()?
                    .unwrap_or("null".into());
                println!("{{\"kind\":\"physical-prhr-event\",\"time\":{},\"actuationSupport\":{support},\"rateOnlyTransaction\":{},\"allAcceptedSolverStateBitsPreserved\":true,\"encodedRateIncrement\":{{\"GJPerS\":{},\"DPerS\":{}}},\"rateScope\":\"owned-identity-Fyp-forcing-jump;all-unrelated-fluid-and-source-rates-retained;not-generalized-hydraulic-or-film-derivative-completion\"}}",finite(out.returned),event_proof,finite(delta_g),finite(delta_d));
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
    observation.retain(&checkpoint_path.with_extension("pressure-evidence.json"))?;
    out.pressure_evidence = Some(observation);
    retain_final_admitted(
        checkpoint_path,
        &out,
        start.elapsed().as_secs_f64(),
        &callbacks.metrics(),
    )?;
    if let Some(s) = &callbacks.prhr {
        s.retain(checkpoint_path, out.last)?;
        out.actuation.record(s, out.last, &out.final_y, false)?;
    }
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
    out.final_prhr = prhr_input(callbacks.prhr.as_ref(), out.last, &out.final_y)?;
    out.max_pressure_flow = out
        .max_pressure_flow
        .max(callbacks.convergence.max_converged_flow());
    out.metrics = callbacks.metrics();
    out.stats = format!(
        "{{\"completedPhysicalSegments\":[{}],\"lastPhysicalSegment\":{}}}",
        completed_segments.join(","),
        solver_stats(owned.ida)?
    );
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
fn final_feedback(
    model: &source_cooling::Model,
    y: &[f64],
    input: Option<prhr::Input>,
) -> Result<String, String> {
    let mut actual = model.workspace();
    model.evaluate_with_prhr_input(y, &vec![0.; model.dimension()], None, &mut actual, input)?;
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
fn numerical_allowance(remaining: f64) -> Result<f64, String> {
    if !remaining.is_finite() || remaining <= 2. || remaining > 180. {
        return Err("Expected aggregate allowance (2,180] s".into());
    }
    // The caller has already debited all earlier programme work. An embedded
    // standalone-network frame is physics input, not a second joined budget.
    Ok(remaining - 2.)
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
    let allowance = numerical_allowance(budget)?;
    let text = fs::read_to_string(&input).map_err(|e| e.to_string())?;
    let prepared = catch_unwind(AssertUnwindSafe(|| cooling_input::parse(&text)))
        .map_err(|_| "Malformed coupled numeric payload".to_string())??;
    let initial_schedule = PrhrSchedule::new(
        &prepared.model,
        prepared.prhr_action,
        prepared.actuation.as_ref(),
    )?;
    let initial_prhr = initial_schedule
        .as_ref()
        .map(|s| s.input(0., 0.))
        .transpose()?;
    let accuracy =
        cooling_accuracy::Accuracy::new(&prepared.model, &prepared.target_emissions, initial_prhr)?;
    let normal = run(
        &prepared.model,
        &accuracy,
        prepared.pressure_channel,
        prepared.pressure_protection,
        prepared.prhr_action,
        prepared.actuation.as_ref(),
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
            prepared.pressure_channel,
            prepared.pressure_protection,
            prepared.prhr_action,
            prepared.actuation.as_ref(),
            10.,
            started,
            allowance,
            &input.with_extension("tighter.checkpoint"),
            Some(&normal),
        )?)
    } else {
        None
    };
    let pair_evaluated = normal.passed && tight.as_ref().is_some_and(|r| r.passed);
    let mut thermal_developed = None;
    let mut source_developed = None;
    let mut barrel_developed = None;
    let mut pressure_developed = None;
    let mut mobile_developed = None;
    let mut bundle_qualified = false;
    let mut bundle_ratios = [0f64; 3];
    let mut mobile_receipts = "null".to_string();
    let mut pressure_details = "null".to_string();
    let mut barrel_details = "null".to_string();
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
    let mut max_barrel = 0f64;
    let mut max_barrel_power = 0f64;
    let mut max_capture_power_local = 0f64;
    let mut max_capture_power_sumabs = 0f64;
    let mut max_capture_paid_energy = 0f64;
    let mut max_mobile_power_local = 0f64;
    let mut max_mobile_power_sumabs = 0f64;
    let mut max_mobile_paid_energy = 0f64;
    let mut max_pressure = 0f64;
    let mut max_pressure_material = 0f64;
    let mut feedback = "null".to_string();
    if let Some(t) = tight.as_ref().filter(|t| normal.passed && t.passed) {
        cooling_accuracy::check_schedule(&normal.samples)?;
        cooling_accuracy::check_schedule(&t.samples)?;
        for (a, b) in normal.samples.iter().zip(&t.samples) {
            let (local, sumabs, paid) =
                cooling_bundle::compare(&prepared.model, a, b, &normal.initial, None)?;
            for (r, q) in bundle_ratios.iter_mut().zip([local, sumabs, paid]) {
                *r = r.max(q);
            }
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
            max_barrel = max_barrel.max(c.barrel_thermal_ratio);
            max_barrel_power = max_barrel_power.max(c.barrel_power_ratio);
            max_capture_power_local = max_capture_power_local.max(c.capture_power_local_ratio);
            max_capture_power_sumabs = max_capture_power_sumabs.max(c.capture_power_sumabs_ratio);
            max_capture_paid_energy = max_capture_paid_energy.max(c.capture_paid_energy_ratio);
            max_mobile_power_local = max_mobile_power_local.max(c.mobile_power_local_ratio);
            max_mobile_power_sumabs = max_mobile_power_sumabs.max(c.mobile_power_sumabs_ratio);
            max_mobile_paid_energy = max_mobile_paid_energy.max(c.mobile_paid_energy_ratio);
            mobile_receipts = c.mobile_receipts().to_string();
            max_pressure = max_pressure.max(c.pressure_pair_ratio);
            max_pressure_material = max_pressure_material.max(c.pressure_material_pair_ratio);
            comparisons.push(c.json());
        }
        let a = normal
            .samples
            .last()
            .ok_or("Missing normal BODY/guide sample")?;
        let b = t
            .samples
            .last()
            .ok_or("Missing tighter BODY/guide sample")?;
        bundle_qualified = bundle_ratios.iter().all(|q| *q <= 1.)
            && cooling_bundle::developed(&a.bundle_power, &b.bundle_power)
            && cooling_bundle::thermal_witness(&prepared.model, a, b, &normal.initial).3;
        println!(
            "{}",
            cooling_bundle::report(&prepared.model, a, b, &normal.initial, bundle_ratios)?
        );
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
        let a = normal
            .samples
            .last()
            .ok_or("Missing normal final mobile sample")?;
        let b = t
            .samples
            .last()
            .ok_or("Missing tighter final mobile sample")?;
        mobile_developed = Some(cooling_mobile::developed(
            cooling_mobile::paid_species(&prepared.model, &a.y, &normal.initial)?,
            cooling_mobile::paid_species(&prepared.model, &b.y, &normal.initial)?,
            a.mobile_recipient_power.iter().sum(),
            b.mobile_recipient_power.iter().sum(),
        )?);
        feedback = final_feedback(&prepared.model, &t.final_y, t.final_prhr)?;
        let row = prepared.model.layout.barrel_temperature;
        let original = normal.initial[row];
        let a = normal.final_y[row];
        let b = t.final_y[row];
        let change = (b - original).abs();
        let difference = (a - b).abs();
        barrel_developed = Some(developed_barrel(change, difference));
        barrel_details = format!(
            "{{\"initialK\":{},\"normalFinalK\":{},\"tighterFinalK\":{},\"absoluteChangeK\":{},\"pairedDifferenceK\":{},\"minimumChangeK\":{},\"minimumResponseToPairDifference\":10,\"scope\":\"resolved-finite-sensible-response;not-nuclear-heating-dominance\"}}",
            finite(original),
            finite(a),
            finite(b),
            finite(change),
            finite(difference),
            finite(cooling_accuracy::TEMPERATURE_ATOL)
        );
        let l = prepared.model.layout;
        let row = l.network_start + prepared.model.network.pressure_row();
        let initial = normal.initial[row];
        let normal_change = normal.final_y[row] - initial;
        let reference_change = t.final_y[row] - initial;
        let difference = (normal_change - reference_change).abs();
        pressure_developed = Some(
            reference_change.abs() >= cooling_accuracy::PRESSURE_RESOLUTION_PA
                && reference_change.abs() >= 20. * difference,
        );
        pressure_details = format!(
            "{{\"scope\":\"resolved-common-primary-pressure-change;cold-positive-pool-and-air;not-fast-flow-timing\",\"initialPa\":{},\"normalChangePa\":{},\"referenceChangePa\":{},\"pairedDifferencePa\":{},\"minimumChangePa\":1,\"minimumResponseToPairDifference\":20,\"normalFinalPressurizer\":{},\"referenceFinalPressurizer\":{},\"normalFinalSurge\":{},\"referenceFinalSurge\":{},\"normalAmbientExportJ\":{},\"referenceAmbientExportJ\":{}}}",
            finite(initial),
            finite(normal_change),
            finite(reference_change),
            finite(difference),
            numbers(&normal.final_y[l.pressurizer_start..l.surge_start]),
            numbers(&t.final_y[l.pressurizer_start..l.surge_start]),
            numbers(&normal.final_y[l.surge_start..l.surge_carrier_start]),
            numbers(&t.final_y[l.surge_start..l.surge_carrier_start]),
            finite(normal.final_y[l.ambient_exported]),
            finite(t.final_y[l.ambient_exported])
        );
    }
    let evidence = match (
        normal.pressure_evidence.as_ref(),
        tight.as_ref().and_then(|t| t.pressure_evidence.as_ref()),
    ) {
        (Some(a), Some(b)) if pair_evaluated => {
            cooling_observation::compare(a, b, prepared.pressure_channel.quantum_pa)
        }
        _ => Err("Pressure evidence pair incomplete".into()),
    };
    println!(
        "{{\"kind\":\"pressure-evidence-pair\",\"report\":{}}}",
        evidence.as_ref().map_or_else(
            |e| format!("{{\"passed\":false,\"reason\":{}}}", quote(e)),
            |r| r.clone()
        )
    );
    let prhr_qualified = if let Some(p) = prepared.model.network.prhr() {
        if let Some(t) = tight.as_ref().filter(|_| pair_evaluated) {
            let base = prepared.model.layout.network_start;
            let e = base + p.layout.wst_start + leitbild_plant_numerics::finite_wst::ENERGY;
            let gas = base + p.layout.gas_exported;
            let bank_heat =
                |r: &Run| (r.final_y[e] - r.initial[e]) + (r.final_y[gas] - r.initial[gas]);
            let normal_heat = bank_heat(&normal);
            let tighter_heat = bank_heat(t);
            let difference = (normal_heat - tighter_heat).abs();
            let receipt_resolution = accuracy.absolute(1.)?[gas];
            let bank_developed = tighter_heat > 10. * difference + 20. * receipt_resolution;
            let (_, normal_primary, primary_resolution, water_owners, steel_owners) =
                accuracy.prhr_heat_receipts(&prepared.model, &normal.final_y)?;
            let (_, tighter_primary, tighter_resolution, _, _) =
                accuracy.prhr_heat_receipts(&prepared.model, &t.final_y)?;
            let primary_resolution = primary_resolution.max(tighter_resolution);
            let primary_difference = (normal_primary - tighter_primary).abs();
            let developed =
                tighter_primary.min(normal_primary) > 10. * primary_difference + primary_resolution;
            let actual_open = normal
                .final_prhr
                .zip(t.final_prhr)
                .is_some_and(|(a, b)| a.opening == 1. && b.opening == 1.);
            println!("{{\"kind\":\"prhr-connected-receiver\",\"passed\":{},\"normalActualBankToPoolHeatJ\":{},\"tighterActualBankToPoolHeatJ\":{},\"pairedDifferenceJ\":{},\"receiptResolutionJ\":{},\"resolvedPositiveBankToPoolHeatReceipt\":{bank_developed},\"normalNetPrimaryToPrhrHeatJ\":{},\"tighterNetPrimaryToPrhrHeatJ\":{},\"primaryPairedDifferenceJ\":{},\"primaryOperandResolutionJ\":{},\"bankWaterOwners\":{water_owners},\"bankSteelOwners\":{steel_owners},\"resolvedPositivePrimaryHeatReceipt\":{developed},\"actualAchievedFullOpen\":{actual_open},\"scope\":\"disjoint-bank-water-steel-plus-finite-pool-first-laws;initial-bank-discharge-not-primary-credit;CNV-surface-and-connector-receipts-separated;no-decay-duty-or-endurance-credit\"}}",
                developed&&bank_developed&&actual_open,finite(normal_heat),finite(tighter_heat),finite(difference),finite(receipt_resolution),finite(normal_primary),finite(tighter_primary),finite(primary_difference),finite(primary_resolution));
            developed && bank_developed && actual_open
        } else {
            false
        }
    } else {
        true
    };
    let (actuation_qualified, actuation_receipts) = if prepared.actuation.is_some() {
        if let Some(t) = tight.as_ref().filter(|_| pair_evaluated) {
            cooling_actuation::pair(&normal.actuation, &t.actuation)?
        } else {
            (false, "null".into())
        }
    } else {
        (true, "null".into())
    };
    let passed = pair_evaluated
        && actuation_qualified
        && bundle_qualified
        && prhr_qualified
        && evidence.is_ok()
        && thermal_developed == Some(true)
        && source_developed == Some(true)
        && barrel_developed == Some(true)
        && mobile_developed == Some(true)
        && pressure_developed == Some(true);
    let tighter = tight.as_ref().map_or("null".into(), Run::json);
    let fuel_power_resolution = finite(cooling_accuracy::DEPOSIT_RESOLUTION_W);
    let linear_budget = cooling_convergence::LINEAR_L2_BUDGET;
    let barrel_gates = format!(
        "\"barrelPairRatio\":{},\"barrelPowerPairRatio\":{},\"developedBarrelResponse\":{},\"barrelResponse\":{barrel_details}",
        if pair_evaluated {
            finite(max_barrel)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_barrel_power)
        } else {
            "null".into()
        },
        barrel_developed.map_or("null".into(), |v| v.to_string())
    );
    let pressure_gates = format!(
        "\"pressurePairRatio\":{},\"pressureMaterialPairRatio\":{},\"pressureChartRatio\":{},\"pressureFlowClosureRatio\":{},\"developedPressureResponse\":{},\"pressureResponse\":{pressure_details}",
        if pair_evaluated {
            finite(max_pressure)
        } else {
            "null".into()
        },
        if pair_evaluated {
            finite(max_pressure_material)
        } else {
            "null".into()
        },
        finite(
            normal
                .max_pressure_chart
                .max(tight.as_ref().map_or(0., |r| r.max_pressure_chart))
        ),
        finite(
            normal
                .max_pressure_flow
                .max(tight.as_ref().map_or(0., |r| r.max_pressure_flow))
        ),
        pressure_developed.map_or("null".into(), |v| v.to_string())
    );
    let capture_gates = format!("\"capturePowerLocalRatio\":{},\"capturePowerSUMABSRatio\":{},\"capturePaidEnergyRatio\":{}",
        if pair_evaluated { finite(max_capture_power_local) } else { "null".into() },
        if pair_evaluated { finite(max_capture_power_sumabs) } else { "null".into() },
        if pair_evaluated { finite(max_capture_paid_energy) } else { "null".into() });
    let capture_settings = "\"capturePowerErrorWeights\":\"sparse-current-fuel-capture-and-temperature-proportional-budget-cap\",\"capturePowerResolutionW\":1e-12,\"capturePowerWeightScope\":\"emitted-per-intersection;held-route-fractions-at-most-one;all-five-recipient-channels-independently-paired\"";
    let mobile_policy = cooling_mobile::POLICY;
    let mobile_development_policy = cooling_mobile::DEVELOPMENT_POLICY;
    let capture_settings =
        format!("{capture_settings},\"mobileCapturePolicy\":\"{mobile_policy}\",\"mobileCaptureDevelopmentPolicy\":\"{mobile_development_policy}\"");
    let capture_settings = format!(
        "{capture_settings},\"actuationSupplyPolicy\":{}",
        if prepared.actuation.is_some() {
            quote(cooling_actuation::POLICY)
        } else {
            "null".into()
        }
    );
    let mobile_gates = format!("\"mobileCapturePowerLocalRatio\":{},\"mobileCapturePowerSUMABSRatio\":{},\"mobileCapturePaidEnergyRatio\":{}", if pair_evaluated {finite(max_mobile_power_local)} else {"null".into()}, if pair_evaluated {finite(max_mobile_power_sumabs)} else {"null".into()}, if pair_evaluated {finite(max_mobile_paid_energy)} else {"null".into()});
    let mobile_developed = mobile_developed.map_or("null".into(), |v| v.to_string());
    let capture_gates = format!(
        "{capture_gates},{mobile_gates},\"developedMobileCaptureResponse\":{mobile_developed}"
    );
    let capture_gates =
        format!("{capture_gates},\"actuationSupplyQualified\":{actuation_qualified}");
    let pressure_settings = "\"pressureCoordinates\":\"finite-pool-cushion-and-surge-forward-DAE;direct-liquid-B10-and-phase-H-products\",\"pressureResponseResolutionPa\":1,\"pressureChangeRelativeBudget\":0.005,\"surgeHydraulicModel\":\"finite-storage-two-algebraic-resistances\",\"surgeGravityModel\":\"owned-bulk-density-hydrostatic-face-heads\",\"surgeReductionScope\":\"sound-filtered-slow-support;no-inertial-waveform-credit\",\"surgeFlowResolutionKgS\":1e-5,\"pressureChartHeightScope\":\"hydrostatic-equivalent-1Pa;P-T-coupled-correction-and-metal-caloric-admitted\"";
    let scope = if prepared.model.network.prhr().is_some() {
        "same-trial-source-finite-fuel-He-primary-finite-SG-barrel-surge-cold-PZR-PRHR-finite-WST-ROOM;exact-retained-spring-motion-and-finite-ACT.A;signed-supplied-CNV-and-AC-source-receipts;remaining-consumer-work-boundary;cold-fixed-prepared-source-geometry;no-hot-phase-decay-duty-containment-endurance-or-fullplant-credit"
    } else {
        "same-trial-source-finite-fuel-He-primary-finite-SG-barrel-surge-cold-PZR;cold-fixed-prepared-geometry;no-fullplant-credit"
    };
    let carrier_policy = cooling_accuracy::CARRIER_POLICY;
    let energy_coordinate = if prepared.model.network.prhr().is_some() {
        "G=sum-installed-energy-change-including-finite-WST-and-ROOM-minus-fission-barrel-fuel-binding-mobile-binding-BODY-guide-release-minus-signed-spring-release-and-electrical-receipts-plus-barrel-fuel-binding-mobile-binding-BODY-guide-ambient-WST-surface-work-connector-and-ROOM-ambient-export"
    } else {
        "G=sum-installed-energy-change-minus-fission-barrel-fuel-binding-mobile-binding-BODY-guide-release-plus-barrel-fuel-binding-mobile-binding-BODY-guide-ambient-export"
    };
    println!(
        "{{\"kind\":\"source-cooling-pair\",\"passed\":{passed},\"lastAdmittedTime\":{},\"scope\":\"{scope}\",\"dimension\":{},\"differential\":{},\"settings\":{{\"accuracyPolicy\":\"cold-source-nuclear-heat\",\"carrierCoordinates\":\"hydrogen-product,direct-boron10,boron-product\",\"carrierComparisonPolicy\":\"{carrier_policy}\",\"provisional\":true,\"nonlinearClosure\":\"stock-Newton-and-current-physical-network-pressure-charts\",\"linearWeightedL2Budget\":{linear_budget},\"algebraicLTE\":\"excluded-from-temporal-control;retained-in-Newton-physical-closure-and-output-pair\",\"fuelPowerErrorWeights\":\"sparse-current-response-proportional-budget-cap\",\"fuelPowerResolutionW\":{fuel_power_resolution},\"barrelPowerErrorWeights\":\"sparse-current-bulk-capture-Mn-proportional-budget-cap\",\"barrelPowerResolutionW\":{fuel_power_resolution},\"barrelPowerWeightScope\":\"held-route-source-response-only;density-partition-independently-paired\",\"fuelPowerWeightScope\":\"first-order-local-box-budget;not-WRMS-or-paired-error-guarantee\",\"perRowErrorWeights\":\"source-carrier-barrel-binding-receipts-relative-consequences;network-thermal-absolute-only;energy-defect-absolute\",\"solverEnergyCoordinate\":\"{energy_coordinate}\",\"energyDefectATOLJ\":{},\"referenceAllATOLandRTOLDivisor\":10,\"horizon\":300,\"costGuard\":\"aggregate-native-and-external-wall-deadlines;accepted-step-count-diagnostic\",\"maxl\":30,\"restarts\":0,{capture_settings},{pressure_settings}}},\"gates\":{{\"fullPairComparisonEvaluated\":{pair_evaluated},\"developedThermalResponse\":{},\"developedSourceResponse\":{},\"thermalResponse\":{thermal_details},\"sourceLocalRatio\":{},\"sourceFamilyRatio\":{},\"sourceObservableRatio\":{},\"sourceNCOperatorRatio\":{},\"thermalPairRatio\":{},\"networkPairRatio\":{},\"depositionPairRatio\":{},\"carrierPairRatio\":{},{barrel_gates},{capture_gates},{pressure_gates}}},\"mobileCaptureReceipts\":{mobile_receipts},\"actuationSupplyReceipts\":{actuation_receipts},\"pairedComparisons\":[{}],\"fuelTemperatureFeedbackDiagnostic\":{feedback},\"normal\":{},\"tighter\":{tighter},\"aggregateWallSeconds\":{}}}",
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
    #[test]
    fn event_sparse_linear_rate_jump_preserves_small_encoded_history_and_unrelated_bits() {
        let m = cooling_fixture::fixture();
        let initial = m.initial_state().unwrap();
        let energy = EnergyCoordinates::new(&m, &initial).unwrap();
        let coordinates = Coordinates {
            nc: m.source.nc_dimension(),
            ledger: m.source.ledger_row(),
        };
        assert!(m.is_differential(energy.row) && m.is_differential(coordinates.ledger));
        let mut accepted = initial.clone();
        coordinates.transform(&mut accepted);
        energy.state_to_solver(&mut accepted);
        accepted[energy.row] = 0.000000123456789;
        accepted[coordinates.ledger] = -0.000000987654321;
        let mut delta = vec![0.; m.dimension()];
        delta[m.layout.barrel_energy] = 500.;
        delta[m.layout.barrel_exported] = -500.;
        let (updated, encoded_delta) =
            solver_rate_jump(&coordinates, &energy, &accepted, &delta).unwrap();
        assert_eq!(encoded_delta[energy.row], 0.);
        assert_eq!(encoded_delta[coordinates.ledger], 0.);
        for row in 0..m.dimension() {
            assert_eq!(
                updated[row].to_bits(),
                if encoded_delta[row] == 0. {
                    accepted[row].to_bits()
                } else {
                    (accepted[row] + encoded_delta[row]).to_bits()
                }
            );
        }
        assert!(
            solver_rate_jump(&coordinates, &energy, &accepted, &delta[..delta.len() - 1]).is_err()
        );
    }
    #[test]
    fn joined_remaining_budget_has_one_cli_authority_and_report_reserve() {
        assert_eq!(numerical_allowance(140.93).unwrap(), 138.93);
        assert_eq!(numerical_allowance(180.).unwrap(), 178.);
        assert_eq!(numerical_allowance(120.).unwrap(), 118.);
        for invalid in [f64::NAN, f64::INFINITY, -1., 0., 2., 180.01] {
            assert!(numerical_allowance(invalid).is_err());
        }
    }
    #[test]
    fn direct_boron_ledger_checks_global_conservation_not_local_tracer_accuracy() {
        let model = cooling_fixture::fixture_with_contrast();
        let l = model.layout;
        let accuracy = cooling_accuracy::Accuracy::new(
            &model,
            &vec![[0.; 2]; model.source.target_count()],
            None,
        )
        .unwrap();
        let mut y = model.initial_state().unwrap();
        assert_eq!(accuracy.carrier_ledger(&model, &y).unwrap(), 0.);
        // Capture exchanges actual target/product; neither stock disappears.
        y[l.carrier_start + 1] -= 0.5;
        y[l.carrier_start + 2] += 0.5;
        assert!(accuracy.carrier_ledger(&model, &y).is_ok());
        y[l.carrier_start + 2] += 0.5;
        assert!(accuracy.carrier_ledger(&model, &y).is_err());
        let mut y = model.initial_state().unwrap();
        let conversion =
            model.carrier.initial()[0].boron10 / y[l.network_start + model.network.marker_row(0)];
        // This is a GLOBAL conservation check, not a local tracer-accuracy
        // theorem. Actual packet incidence is covered by the coupled RHS/JVP test.
        y[l.carrier_start + 1] -= conversion * 1e-5;
        y[l.carrier_start + water_carrier::WIDTH + 1] += conversion * 1e-5;
        assert!(accuracy.carrier_ledger(&model, &y).is_ok());
        y[l.carrier_start + 1] = f64::NAN;
        assert!(accuracy.carrier_ledger(&model, &y).is_err());
        y[l.carrier_start + 1] = f64::INFINITY;
        assert!(accuracy.carrier_ledger(&model, &y).is_err());
    }
    #[test]
    fn appended_barrel_rows_have_explicit_ids_constraints_and_resolved_development() {
        let model = cooling_fixture::fixture_with_contrast();
        let initial = model.initial_state().unwrap();
        let l = model.layout;
        let g = EnergyCoordinates::new(&model, &initial).unwrap();
        let constraints = physical_constraints(&model, g.row);
        assert_eq!(
            l.barrel_energy,
            l.temperatures_start + model.thermal.node_count()
        );
        assert_eq!(l.barrel_exported + 1, l.pressurizer_start);
        assert_eq!(l.ambient_exported + 1, l.fuel_capture_exported);
        assert_eq!(l.fuel_capture_exported + 1, l.mobile_capture_exported);
        assert_eq!(
            l.mobile_capture_exported + 1,
            l.mobile_capture_boundary_exported
        );
        assert_eq!(
            l.mobile_capture_boundary_exported + 1,
            l.absorber_guide_energies_start
        );
        assert_eq!(l.absorber_guide_exported + 1, model.dimension());
        assert!(model.is_differential(l.fuel_capture_exported));
        assert!(progress_relative(&model, l.fuel_capture_exported));
        assert_eq!(constraints[l.fuel_capture_exported], 1.);
        assert_eq!(constraints[l.ambient_exported], 0.);
        assert_eq!(constraints[l.surge_start + finite_surge::LEFT_FLOW], 0.);
        assert_eq!(constraints[l.surge_start + finite_surge::RIGHT_FLOW], 0.);
        let accuracy = cooling_accuracy::Accuracy::new(
            &model,
            &vec![[0.; 2]; model.source.target_count()],
            None,
        )
        .unwrap();
        let normal = accuracy.absolute(1.).unwrap();
        let tighter = accuracy.absolute(10.).unwrap();
        for row in [finite_surge::LEFT_FLOW, finite_surge::RIGHT_FLOW] {
            let row = l.surge_start + row;
            assert!(!model.is_differential(row));
            assert!(!progress_relative(&model, row));
            assert_eq!(normal[row], cooling_accuracy::SURGE_FLOW_RESOLUTION);
            assert_eq!(tighter[row], normal[row] / 10.);
        }
        assert!(model.is_differential(l.barrel_energy));
        assert!(!model.is_differential(l.barrel_temperature));
        assert!(model.is_differential(l.barrel_released));
        assert!(model.is_differential(l.barrel_exported));
        assert_eq!(
            [
                constraints[l.barrel_energy],
                constraints[l.barrel_temperature],
                constraints[l.barrel_released],
                constraints[l.barrel_exported]
            ],
            [0., 2., 1., 1.]
        );
        assert_eq!(constraints[g.row], 0.);
        assert!(!progress_relative(&model, l.barrel_energy));
        assert!(!progress_relative(&model, l.barrel_temperature));
        assert!(progress_relative(&model, l.barrel_released));
        assert!(progress_relative(&model, l.barrel_exported));
        let resolution = cooling_accuracy::TEMPERATURE_ATOL;
        assert!(!developed_barrel(resolution, 0.));
        assert!(developed_barrel(1.1 * resolution, 0.));
        assert!(!developed_barrel(1.1 * resolution, 0.2 * resolution));
        assert!(!developed_barrel(f64::NAN, 0.));
    }
    pub(super) fn callbacks(model: &source_cooling::Model) -> Callbacks<'_> {
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let power_weights = cooling_power::PowerWeights::new(&model.source).unwrap();
        let power_work = power_weights.workspace();
        Callbacks {
            model,
            convergence: cooling_convergence::Convergence::new(model, None).unwrap(),
            work: model.workspace(),
            p: cooling_block::Preconditioner::new(model, &y, &yp, None).unwrap(),
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
            barrel_weights: cooling_power::BarrelWeights::new(
                &model.source,
                model.barrel.config().targets,
                model.barrel.config().capture_photon_j,
            )
            .unwrap(),
            capture_weights: cooling_power::CaptureWeights::new(model).unwrap(),
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
            prhr: None,
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
        assert!(g.row >= model.layout.network_start && g.row < model.layout.carrier_start);
        let d = Coordinates {
            nc: model.source.nc_dimension(),
            ledger: model.source.ledger_row(),
        };
        let mut physical = initial.clone();
        physical[g.row] += 2.;
        physical[model.source.fuel_release_row()] = 0.125;
        physical[model.layout.barrel_energy] += 0.75;
        physical[model.layout.barrel_released] = 0.5;
        physical[model.layout.barrel_exported] = 0.125;
        physical[model.layout.pressurizer_start
            + leitbild_plant_numerics::cold_pressurizer::LIQUID_ENERGY] += 0.5;
        physical[model.layout.pressurizer_start
            + leitbild_plant_numerics::cold_pressurizer::GAS_ENERGY] += 0.25;
        physical[model.layout.surge_start + leitbild_plant_numerics::finite_surge::ENERGY] += 0.5;
        physical[model.layout.ambient_exported] = -0.25;
        physical[d.ledger] = 0.25;
        let mut solver = physical.clone();
        d.transform(&mut solver);
        g.state_to_solver(&mut solver);
        assert_eq!(solver[g.row], 3.25);
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
        slope[model.layout.barrel_energy] = 0.75;
        slope[model.layout.barrel_released] = 0.5;
        slope[model.layout.barrel_exported] = 0.125;
        slope[model.layout.pressurizer_start
            + leitbild_plant_numerics::cold_pressurizer::LIQUID_ENERGY] = 0.5;
        slope[model.layout.pressurizer_start
            + leitbild_plant_numerics::cold_pressurizer::GAS_ENERGY] = 0.25;
        slope[model.layout.surge_start + leitbild_plant_numerics::finite_surge::STEEL_ENERGY] = 0.5;
        slope[model.layout.ambient_exported] = -0.25;
        let original = slope.clone();
        g.vector_to_solver(&mut slope);
        assert_eq!(slope[g.row], 5.875);
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
        let fluid = model
            .fluid_rows()
            .collect::<std::collections::BTreeSet<_>>();
        assert!(c
            .energy_p
            .unit()
            .iter()
            .all(|&(row, _)| fluid.contains(&row)));
        // Other components have zero unit response and are unchanged exactly.
        for row in 0..n {
            if !fluid.contains(&row) {
                assert_eq!(completed[row], expected[row]);
            }
        }
        // Apply the native held-forcing coupled border, not the rank-one
        // formula, to verify EVERY retained non-G fluid/material equation.
        let physical = model.initial_state().unwrap();
        model
            .evaluate(&physical, &vec![0.; n], Some(3.), &mut c.work)
            .unwrap();
        let mut physical_solution = completed.clone();
        c.energy.vector_to_physical(&mut physical_solution);
        let mut action = vec![0.; n];
        let mut gross = vec![0.; n];
        model
            .visit_fluid_jacobian(&c.work, |row, col, v| {
                let value = v * physical_solution[col];
                action[row] += value;
                gross[row] += value.abs();
            })
            .unwrap();
        for row in fluid {
            if row != c.energy.row {
                assert!((action[row] - physical_rhs[row]).abs() <= 1e-10 * gross[row].max(1.));
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
        state[model.layout.carrier_start] = 1e9;
        c.coordinates.transform(&mut state);
        c.energy.state_to_solver(&mut state);
        let y = resources.vector(&state).unwrap();
        let w = resources.vector(&vec![0.; n]).unwrap();
        assert_eq!(unsafe { error_weights(y, w, user) }, 0);
        let weights = unsafe { values(w, n) }.unwrap();
        assert!(weights[0] >= 1. / (0.01 + 1e4));
        assert_eq!(weights[model.layout.network_start], 100.);
        assert_eq!(weights[model.layout.energies_start], 100.);
        assert!((weights[model.layout.carrier_start] - 1. / (0.01 + 1e4)).abs() < 1e-15);
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
            l.carrier_start - 1,
            l.carrier_start,
            l.energies_start - 1,
            l.energies_start,
            l.temperatures_start,
            n - 1,
        ];
        for progress in [0., 1e-12, 1e12] {
            let mut state = model.initial_state().unwrap();
            for &r in &boundaries {
                // The current capture response legitimately reads fuel T.
                // Exercise progress boundaries without inventing 0/1e12 K.
                if r != l.temperatures_start {
                    state[r] = progress;
                }
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
                let relative = if progress_relative(&model, r) {
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
        c.barrel_weights
            .cap(
                &physical[..model.layout.source_end],
                c.relative,
                c.power_resolution_w,
                &mut expected,
            )
            .unwrap();
        c.capture_weights
            .cap(&physical, c.relative, c.power_resolution_w, &mut expected)
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
        assert_eq!(t.families[14].rows, 1);
        assert_eq!(t.families[15].rows, model.absorber_guide.host_count());
        assert_eq!(t.families[16].rows, model.absorber_guide.host_count());
        assert_eq!(t.families[17].rows, 1);
        assert_eq!(t.families.iter().map(|f| f.rows).sum::<usize>(), n);
        let mut errors = vec![0.; n];
        let weights = vec![2.; n];
        for family in 0..ERROR_FAMILIES.len() {
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
        assert!(t
            .json()
            .contains("not-global-error-bound-or-rejected-step-attribution"));
        errors[0] = f64::INFINITY;
        assert!(t.observe(&errors, &weights, 5., 3, 3, 0.2).is_err());
    }
    #[test]
    fn temporal_controller_telemetry_masks_only_algebraic_rows_with_full_dimension_denominator() {
        let model = cooling_fixture::fixture();
        let mut t = LocalErrors::new(&model);
        let n = model.dimension();
        let differential = (0..n).find(|&r| model.is_differential(r)).unwrap();
        let algebraic = (0..n).find(|&r| !model.is_differential(r)).unwrap();
        let mut errors = vec![0.; n];
        let weights = vec![2.; n];
        errors[differential] = 3.;
        errors[algebraic] = 4.;
        t.observe(&errors, &weights, 1., 1, 1, 0.1).unwrap();
        assert_eq!(t.last_controller_wrms, (36. / n as f64).sqrt());
        assert_eq!(t.last_wrms, (100. / n as f64).sqrt());
        assert!(t.json().contains("lastAllCoordinateWRMS"));
        assert!(t.json().contains("lastControllerWRMS"));
        // A large algebraic estimate remains inspectable, but does not change
        // the selected stock-controller norm or any physical admission gate.
        errors[algebraic] = 4e6;
        t.observe(&errors, &weights, 2., 1, 1, 0.1).unwrap();
        assert_eq!(t.last_controller_wrms, (36. / n as f64).sqrt());
        assert_eq!(t.families[t.labels[algebraic]].maximum, 8e6);
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
            final_prhr: None,
            max_number: 0.,
            max_energy: 0.,
            max_thermal_chart: 0.,
            max_pressure_chart: 0.,
            max_pressure_flow: 0.,
            surge_flow_extrema: [[0.; 2]; 2],
            initialization: "null".into(),
            stats: "null".into(),
            pressure_evidence: None,
            actuation: cooling_actuation::Receipt::default(),
        };
        retain_final_admitted(&path, &run, 0., "{}").unwrap();
        assert!(!path.exists());
        checkpoint(&path, 1., &[0., 0.], &[0., 0.]).unwrap();
        run.steps = 2;
        retain_final_admitted(&path, &run, 0., "{}").unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut expected = b"LDPTST01".to_vec();
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
        let mut expected = b"LDPTCM01".to_vec();
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
            assert!(fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink());
            fs::remove_file(path.with_extension("common-pending")).unwrap();
            fs::remove_file(path).unwrap();
        }
    }
}

//! Offline reusable plant numerics. No Pack registration or simulation clock.
//! Equations: LD-01 operating-fluid-model, native single-liquid storage/chart.
use std::ffi::{CStr, c_char};

pub mod fixed_volume_liquid;
pub mod finite_header_return;
pub mod fuel_source;
pub mod horizontal_passage;
pub mod mixing;
pub mod moderator_source;
pub mod original_water;

pub const GRAVITY: f64 = 9.80665;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct LiquidQuery {
    pub temperature: f64,
    pub pressure: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Liquid {
    pub pressure: f64,
    pub temperature: f64,
    pub density: f64,
    pub internal_energy: f64,
    pub enthalpy: f64,
    pub entropy: f64,
    pub cp: f64,
    pub cv: f64,
    pub sound_speed: f64,
    pub expansion: f64,
    pub compressibility: f64,
    pub viscosity: f64,
    pub conductivity: f64,
}

#[derive(Debug)]
pub struct PropertyError {
    pub index: usize,
    pub message: String,
}

unsafe extern "C" {
    fn leitbild_liquid_batch(
        queries: *const LiquidQuery,
        output: *mut Liquid,
        count: usize,
        failed: *mut usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> i32;
}

/// One FFI crossing for a batch; caller owns/reuses both slices. On failure output
/// is a partial candidate only and MUST NOT be admitted as plant state.
pub fn liquid_batch(queries: &[LiquidQuery], output: &mut [Liquid]) -> Result<(), PropertyError> {
    if queries.len() != output.len() {
        return Err(PropertyError {
            index: 0,
            message: "Query/output lengths differ".into(),
        });
    }
    let mut failed = 0;
    let mut message = [0 as c_char; 256];
    // SAFETY: repr(C) POD, equal lengths, unique writable output; synchronous
    // bridge retains no pointers, catches exceptions, and terminates error text.
    let status = unsafe {
        leitbild_liquid_batch(
            queries.as_ptr(),
            output.as_mut_ptr(),
            queries.len(),
            &mut failed,
            message.as_mut_ptr(),
            message.len(),
        )
    };
    if status != 0 {
        // SAFETY: buffer initially all zero; bridge always writes a final NUL.
        return Err(PropertyError {
            index: failed,
            message: unsafe { CStr::from_ptr(message.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        });
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CellGeometry {
    pub volume: f64,
    pub elevation: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Storage {
    pub mass: f64,
    pub momentum: f64,
    pub energy: f64,
    pub mixing_energy: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct StorageJacobian {
    pub mass_pressure: f64,
    pub mass_temperature: f64,
    pub energy_pressure: f64,
    pub energy_temperature: f64,
    pub energy_momentum: f64,
}

fn valid(
    geometry: CellGeometry,
    water: Liquid,
    momentum: f64,
    mixing: f64,
    signed_trial: bool,
) -> Result<(), &'static str> {
    let values = [
        geometry.volume,
        geometry.elevation,
        water.pressure,
        water.temperature,
        water.density,
        water.internal_energy,
        water.enthalpy,
        water.entropy,
        water.cp,
        water.cv,
        water.sound_speed,
        water.expansion,
        water.compressibility,
        water.viscosity,
        water.conductivity,
        momentum,
        mixing,
    ];
    if !values.iter().all(|v| v.is_finite())
        || geometry.volume <= 0.
        || water.density <= 0.
        || water.pressure <= 0.
        || water.temperature <= 0.
        || water.cp <= 0.
        || water.compressibility <= 0.
        || water.cv <= 0.
        || water.sound_speed <= 0.
        || water.viscosity <= 0.
        || water.conductivity <= 0.
        || (!signed_trial && mixing < 0.)
    {
        return Err("Invalid conservative single-liquid storage input");
    }
    let ks = water.compressibility
        - water.temperature * water.expansion * water.expansion / (water.density * water.cp);
    if !ks.is_finite() || ks <= 0. {
        return Err("Nonpositive isentropic storage");
    }
    Ok(())
}

pub fn storage(
    geometry: CellGeometry,
    water: Liquid,
    momentum: f64,
    mixing_energy: f64,
) -> Result<Storage, &'static str> {
    native_storage(geometry, water, momentum, mixing_energy, false)
}

fn native_storage(
    geometry: CellGeometry,
    water: Liquid,
    momentum: f64,
    mixing_energy: f64,
    signed_trial: bool,
) -> Result<Storage, &'static str> {
    valid(geometry, water, momentum, mixing_energy, signed_trial)?;
    let mass = geometry.volume * water.density;
    let energy = mass * (water.internal_energy + GRAVITY * geometry.elevation)
        + momentum * momentum / (2. * mass)
        + mixing_energy;
    if !mass.is_finite() || !energy.is_finite() {
        return Err("Nonfinite conservative storage");
    }
    Ok(Storage {
        mass,
        momentum,
        energy,
        mixing_energy,
    })
}

/// Analytic local chart: differentiate at fixed actual momentum, mixing and geometry.
/// Momentum/mixing are not independent extra heat sources.
pub fn storage_jacobian(
    geometry: CellGeometry,
    water: Liquid,
    momentum: f64,
    mixing: f64,
) -> Result<StorageJacobian, &'static str> {
    native_storage_jacobian(geometry, water, momentum, mixing, false)
}

fn native_storage_jacobian(
    geometry: CellGeometry,
    water: Liquid,
    momentum: f64,
    mixing: f64,
    signed_trial: bool,
) -> Result<StorageJacobian, &'static str> {
    let s = native_storage(geometry, water, momentum, mixing, signed_trial)?;
    let velocity = momentum / s.mass;
    let mp = s.mass * water.compressibility;
    let mt = -s.mass * water.expansion;
    let up = (water.pressure * water.compressibility - water.temperature * water.expansion)
        / water.density;
    let ut = water.cp - water.pressure * water.expansion / water.density;
    let common = water.internal_energy + GRAVITY * geometry.elevation - velocity * velocity / 2.;
    let result = StorageJacobian {
        mass_pressure: mp,
        mass_temperature: mt,
        energy_pressure: common * mp + s.mass * up,
        energy_temperature: common * mt + s.mass * ut,
        energy_momentum: velocity,
    };
    if ![
        result.mass_pressure,
        result.mass_temperature,
        result.energy_pressure,
        result.energy_temperature,
        result.energy_momentum,
    ]
    .iter()
    .all(|v| v.is_finite())
    {
        return Err("Nonfinite storage derivative");
    }
    Ok(result)
}

impl StorageJacobian {
    /// Exact two-by-two solve for chart residuals or differentiated constraints.
    /// Caller subtracts actual momentum and mixing contributions from energy_rate.
    pub fn pressure_temperature_increment(
        self,
        mass_rate: f64,
        energy_rate: f64,
    ) -> Result<[f64; 2], &'static str> {
        let determinant = self.mass_pressure * self.energy_temperature
            - self.mass_temperature * self.energy_pressure;
        if !determinant.is_finite()
            || determinant <= 0.
            || !mass_rate.is_finite()
            || !energy_rate.is_finite()
        {
            return Err("Native storage chart is inadmissible or singular");
        }
        let result = [
            (mass_rate * self.energy_temperature - self.mass_temperature * energy_rate)
                / determinant,
            (self.mass_pressure * energy_rate - mass_rate * self.energy_pressure) / determinant,
        ];
        if !result.iter().all(|v| v.is_finite()) {
            return Err("Nonfinite native chart increment");
        }
        Ok(result)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RecoveryAccuracy {
    pub mass_kg: f64,
    pub energy_j: f64,
    pub iterations: usize,
}

/// Local known-liquid chart inversion from a caller-supplied nearby guess.
/// Not a global flash or phase selector. No alternate guess, clipping or reset.
pub fn recover_liquid(
    geometry: CellGeometry,
    target: Storage,
    guess: LiquidQuery,
    accuracy: RecoveryAccuracy,
) -> Result<Liquid, String> {
    if ![
        target.mass,
        target.momentum,
        target.energy,
        target.mixing_energy,
        accuracy.mass_kg,
        accuracy.energy_j,
    ]
    .iter()
    .all(|v| v.is_finite())
        || target.mass <= 0.
        || target.mixing_energy < 0.
        || accuracy.mass_kg <= 0.
        || accuracy.energy_j <= 0.
        || accuracy.iterations == 0
    {
        return Err("Invalid local recovery target or accuracy".into());
    }
    Ok(recover_local(
        geometry,
        target,
        guess,
        false,
        accuracy.iterations,
        |mass, energy, _| mass.abs() <= accuracy.mass_kg && energy.abs() <= accuracy.energy_j,
    )?
    .liquid)
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ChartRecoveryAccuracy {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub iterations: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RecoveredLiquid {
    pub liquid: Liquid,
    pub chart: StorageJacobian,
    pub pressure_defect_pa: f64,
    pub temperature_defect_k: f64,
    pub iterations: usize,
}

/// Same known-liquid EOS/native storage, with signed Q retained ONLY for a
/// numerical trial. This never admits an accepted negative mixing stock. The
/// caller supplies its one nearby same-branch guess; no phase or seed fallback.
/// Joint inverse-chart Newton corrections control the local stopping test,
/// not a global inverse-error guarantee. The caller independently checks the
/// returned chart, rather than inferring pressure accuracy from M/E boxes.
pub fn recover_trial_liquid(
    geometry: CellGeometry,
    target: Storage,
    guess: LiquidQuery,
    accuracy: ChartRecoveryAccuracy,
) -> Result<RecoveredLiquid, String> {
    if !accuracy.pressure_pa.is_finite()
        || accuracy.pressure_pa <= 0.
        || !accuracy.temperature_k.is_finite()
        || accuracy.temperature_k <= 0.
        || accuracy.iterations == 0
    {
        return Err("Invalid joint known-liquid recovery accuracy".into());
    }
    recover_local(
        geometry,
        target,
        guess,
        true,
        accuracy.iterations,
        |_, _, correction| {
            correction[0].abs() <= accuracy.pressure_pa
                && correction[1].abs() <= accuracy.temperature_k
        },
    )
}

fn recover_local(
    geometry: CellGeometry,
    target: Storage,
    guess: LiquidQuery,
    signed_trial: bool,
    iterations: usize,
    admitted: impl Fn(f64, f64, [f64; 2]) -> bool,
) -> Result<RecoveredLiquid, String> {
    if ![
        target.mass,
        target.momentum,
        target.energy,
        target.mixing_energy,
        guess.pressure,
        guess.temperature,
    ]
    .iter()
    .all(|value| value.is_finite())
        || target.mass <= 0.
        || (!signed_trial && target.mixing_energy < 0.)
    {
        return Err("Invalid local known-liquid recovery target/guess".into());
    }
    let mut query = [guess];
    let mut output = [Liquid::default()];
    for iteration in 0..iterations {
        liquid_batch(&query, &mut output).map_err(|e| e.message)?;
        let water = output[0];
        let actual = native_storage(
            geometry,
            water,
            target.momentum,
            target.mixing_energy,
            signed_trial,
        )?;
        let mass_residual = target.mass - actual.mass;
        let energy_residual = target.energy - actual.energy;
        let j = native_storage_jacobian(
            geometry,
            water,
            target.momentum,
            target.mixing_energy,
            signed_trial,
        )?;
        let [dp, dt] = j.pressure_temperature_increment(mass_residual, energy_residual)?;
        if admitted(mass_residual, energy_residual, [dp, dt]) {
            return Ok(RecoveredLiquid {
                liquid: water,
                chart: j,
                pressure_defect_pa: dp,
                temperature_defect_k: dt,
                iterations: iteration + 1,
            });
        }
        query[0].pressure += dp;
        query[0].temperature += dt;
    }
    Err("Local known-liquid recovery did not converge under the supplied accuracy".into())
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct TrialLiquidInput {
    pub geometry: CellGeometry,
    pub target: Storage,
    pub guess: LiquidQuery,
    pub accuracy: ChartRecoveryAccuracy,
}

/// Synchronous owned-buffer batch ABI used by the actual offline stock consumer.
/// Failed output is only a partial candidate and cannot be accepted plant state.
/// # Safety
/// Pointers must address count valid, nonoverlapping inputs/outputs; failed and
/// error must be valid writable buffers. No pointers are retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn leitbild_recover_trial_liquid_batch(
    inputs: *const TrialLiquidInput,
    outputs: *mut RecoveredLiquid,
    count: usize,
    failed: *mut usize,
    error: *mut c_char,
    error_capacity: usize,
) -> i32 {
    for index in 0..count {
        // SAFETY: synchronous caller-owned POD input/output contract above.
        let input = unsafe { *inputs.add(index) };
        match recover_trial_liquid(input.geometry, input.target, input.guess, input.accuracy) {
            Ok(output) => unsafe { outputs.add(index).write(output) },
            Err(message) => {
                unsafe { *failed = index };
                if error_capacity > 0 {
                    let length = message.len().min(error_capacity - 1);
                    unsafe {
                        std::ptr::copy_nonoverlapping(message.as_ptr(), error.cast::<u8>(), length);
                        *error.add(length) = 0;
                    }
                }
                return 1;
            }
        }
    }
    0
}

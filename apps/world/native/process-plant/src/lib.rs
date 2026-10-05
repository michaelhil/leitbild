//! Offline reusable plant numerics. No Pack registration or simulation clock.
//! Equations: LD-01 operating-fluid-model, native single-liquid storage/chart.
use std::ffi::{CStr, c_char};

pub mod fuel_source;

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

#[derive(Clone, Copy, Debug)]
pub struct CellGeometry {
    pub volume: f64,
    pub elevation: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Storage {
    pub mass: f64,
    pub momentum: f64,
    pub energy: f64,
    pub mixing_energy: f64,
}

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
        || mixing < 0.
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
    valid(geometry, water, momentum, mixing_energy)?;
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
    let s = storage(geometry, water, momentum, mixing)?;
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
    let mut query = [guess];
    let mut output = [Liquid::default()];
    for _ in 0..accuracy.iterations {
        liquid_batch(&query, &mut output).map_err(|e| e.message)?;
        let water = output[0];
        let actual = storage(geometry, water, target.momentum, target.mixing_energy)?;
        let mass_residual = target.mass - actual.mass;
        let energy_residual = target.energy - actual.energy;
        if mass_residual.abs() <= accuracy.mass_kg && energy_residual.abs() <= accuracy.energy_j {
            return Ok(water);
        }
        let j = storage_jacobian(geometry, water, target.momentum, target.mixing_energy)?;
        let [dp, dt] = j.pressure_temperature_increment(mass_residual, energy_residual)?;
        query[0].pressure += dp;
        query[0].temperature += dt;
    }
    Err("Local known-liquid recovery did not converge under the supplied accuracy".into())
}

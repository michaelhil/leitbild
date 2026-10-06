//! Fixed-volume stable-liquid storage, not a flow, momentum or phase model.
//!
//! Coordinates are [M, E, p, T]. M/E are differential stocks; p/T are algebraic
//! coordinates. The forward chart is Mhat=rho*V, Ehat=Mhat*(u+g*z).
//! No branch kinetic energy is represented or projected by this block. Joining
//! a momentum-owning graph requires its separately selected energy/work law.
use crate::{CellGeometry, Liquid, LiquidQuery, liquid_batch, storage, storage_jacobian};
use std::ffi::c_char;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Trial {
    pub mass: f64,
    pub energy: f64,
    pub pressure: f64,
    pub temperature: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Derivative {
    pub mass_rate: f64,
    pub energy_rate: f64,
    pub pressure_rate: f64,
    pub temperature_rate: f64,
}

/// An already-owned balance receipt, not a source, port or withdrawal law.
/// Held fixed in the LOCAL Jacobian. A graph must add derivatives of its actual
/// state-dependent balances; this matrix is not a complete coupled graph J.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct BalanceRate {
    pub mass_kg_per_second: f64,
    pub energy_watts: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub geometry: CellGeometry,
    pub trial: Trial,
    pub derivative: Derivative,
    pub balance: BalanceRate,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Evaluation {
    pub residual: [f64; 4],
    /// Row-major LOCAL F_y+cj*F_ydot, with the supplied balance held fixed.
    pub jacobian: [[f64; 4]; 4],
    pub chart_mass: f64,
    pub chart_energy: f64,
}

#[derive(Debug)]
pub struct BlockError {
    pub index: usize,
    pub message: String,
}

fn failure(index: usize, message: impl Into<String>) -> BlockError {
    BlockError {
        index,
        message: message.into(),
    }
}

fn validate(input: Input, index: usize) -> Result<(), BlockError> {
    let g = input.geometry;
    let y = input.trial;
    let d = input.derivative;
    let b = input.balance;
    if ![
        g.volume,
        g.elevation,
        y.mass,
        y.energy,
        y.pressure,
        y.temperature,
        d.mass_rate,
        d.energy_rate,
        d.pressure_rate,
        d.temperature_rate,
        b.mass_kg_per_second,
        b.energy_watts,
    ]
    .iter()
    .all(|x| x.is_finite())
        || g.volume <= 0.0
        || y.mass <= 0.0
        || y.pressure <= 0.0
        || y.temperature <= 0.0
    {
        return Err(failure(
            index,
            "Nonfinite or inadmissible fixed-volume liquid input",
        ));
    }
    Ok(())
}

/// Evaluate the actual current trial, with one batched forward IF97 call and no
/// stock inverse, guessed recovery state or tolerance/deadband. Failed output
/// is only a partial candidate and must never be accepted as a reached state.
/// F_ydot=diag(1,1,0,0); the p/T rate inputs are checked but do not enter F.
pub fn evaluate_batch(
    inputs: &[Input],
    cj: f64,
    outputs: &mut [Evaluation],
) -> Result<(), BlockError> {
    Workspace::new(inputs.len()).evaluate(inputs, cj, outputs)
}

/// Per-consumer property buffers. Successful evaluations reuse their allocation,
/// but evaluate every current trial; this is not a guessed-state/property cache.
pub struct Workspace {
    queries: Vec<LiquidQuery>,
    liquids: Vec<Liquid>,
}

impl Workspace {
    pub fn new(count: usize) -> Self {
        Self {
            queries: vec![
                LiquidQuery {
                    pressure: 0.0,
                    temperature: 0.0
                };
                count
            ],
            liquids: vec![Liquid::default(); count],
        }
    }

    pub fn evaluate(
        &mut self,
        inputs: &[Input],
        cj: f64,
        outputs: &mut [Evaluation],
    ) -> Result<(), BlockError> {
        if inputs.len() != outputs.len() || inputs.len() != self.queries.len() || !cj.is_finite() {
            return Err(failure(
                0,
                "Invalid fixed-volume batch length or nonfinite cj",
            ));
        }
        for (index, input) in inputs.iter().enumerate() {
            validate(*input, index)?;
        }
        for (query, input) in self.queries.iter_mut().zip(inputs) {
            *query = LiquidQuery {
                pressure: input.trial.pressure,
                temperature: input.trial.temperature,
            };
        }
        liquid_batch(&self.queries, &mut self.liquids)
            .map_err(|error| failure(error.index, error.message))?;
        for (index, ((input, liquid), output)) in
            inputs.iter().zip(&self.liquids).zip(outputs).enumerate()
        {
            let chart = storage(input.geometry, *liquid, 0.0, 0.0)
                .map_err(|error| failure(index, error))?;
            let tangent = storage_jacobian(input.geometry, *liquid, 0.0, 0.0)
                .map_err(|error| failure(index, error))?;
            let result = Evaluation {
                residual: [
                    input.derivative.mass_rate - input.balance.mass_kg_per_second,
                    input.derivative.energy_rate - input.balance.energy_watts,
                    input.trial.mass - chart.mass,
                    input.trial.energy - chart.energy,
                ],
                jacobian: [
                    [cj, 0.0, 0.0, 0.0],
                    [0.0, cj, 0.0, 0.0],
                    [1.0, 0.0, -tangent.mass_pressure, -tangent.mass_temperature],
                    [
                        0.0,
                        1.0,
                        -tangent.energy_pressure,
                        -tangent.energy_temperature,
                    ],
                ],
                chart_mass: chart.mass,
                chart_energy: chart.energy,
            };
            if !result
                .residual
                .iter()
                .chain(result.jacobian.iter().flatten())
                .chain([result.chart_mass, result.chart_energy].iter())
                .all(|x| x.is_finite())
            {
                return Err(failure(index, "Nonfinite fixed-volume residual or tangent"));
            }
            *output = result;
        }
        Ok(())
    }
}

/// Synchronous owned-buffer ABI. Errors are explicit; no Rust panic is used for
/// admissibility. Output on failure is an unaccepted partial candidate only.
///
/// # Safety
/// For nonzero count, input/output must be aligned, valid nonoverlapping arrays
/// of count entries. failed is a writable usize; error addresses error_capacity
/// writable bytes (unless capacity is zero). No pointers are retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn leitbild_fixed_volume_liquid_batch(
    inputs: *const Input,
    outputs: *mut Evaluation,
    count: usize,
    cj: f64,
    failed: *mut usize,
    error: *mut c_char,
    error_capacity: usize,
) -> i32 {
    if failed.is_null() || (error_capacity > 0 && error.is_null()) {
        return 2;
    }
    let result = if (count > 0 && (inputs.is_null() || outputs.is_null()))
        || count > (isize::MAX as usize) / std::mem::size_of::<Input>()
        || count > (isize::MAX as usize) / std::mem::size_of::<Evaluation>()
    {
        Err(failure(0, "Invalid fixed-volume ABI pointer or count"))
    } else if count == 0 {
        evaluate_batch(&[], cj, &mut [])
    } else {
        // SAFETY: caller-owned, aligned, nonoverlapping array contract above.
        unsafe {
            evaluate_batch(
                std::slice::from_raw_parts(inputs, count),
                cj,
                std::slice::from_raw_parts_mut(outputs, count),
            )
        }
    };
    match result {
        Ok(()) => {
            unsafe {
                *failed = 0;
                if error_capacity > 0 {
                    *error = 0;
                }
            }
            0
        }
        Err(problem) => {
            let length = problem.message.len().min(error_capacity.saturating_sub(1));
            unsafe {
                *failed = problem.index;
                if error_capacity > 0 {
                    std::ptr::copy_nonoverlapping(
                        problem.message.as_ptr(),
                        error.cast::<u8>(),
                        length,
                    );
                    *error.add(length) = 0;
                }
            }
            1
        }
    }
}

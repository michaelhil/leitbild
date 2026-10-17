//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The unit's solver profile: the stock IDA settings, the exact consistent
//! start's bounds and the preparations' controls the S1, S2 and S3 harnesses
//! declared, each in one place. S1's tolerance classes are read from
//! `ld01-s1-gates`, never written here.
use crate::joined::Restart;
use leitbild_operating_plant::{
    initialization::SurfacePolicy,
    network::{PzrPreparation, RotorState, ToleranceClasses, prepare::Settings},
    rotor::{Shaft, SpeedRequest, Support},
};
use serde_json::Value;

/// Stock IDA's nonlinear convergence coefficient.
pub const NEWTON_COEFFICIENT: f64 = 0.33;
/// Stock IDA's `dcj` for a linear-solver setup.
pub const DELTA_CJ_LSETUP: f64 = 0.1;
/// The first step after a restart.
pub const FIRST_STEP_S: f64 = 1e-4;
/// S2's configuration: BDF order at most 2.
pub const MAX_ORDER: usize = 2;
/// The exact consistent start's declared row bound (decision 0013's exit).
pub const START_BOUND: f64 = 1e-12;
/// The S1 harness's declared PZR preparation controls (s1_hydraulics.rs).
pub const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};
/// The S1 harness's hydrostatic preparation settings (s1_hydraulics.rs).
pub const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 8,
};
/// The startup surface initializer's policy (memo §3 (C)).
pub const SURFACES: SurfacePolicy = SurfacePolicy {
    maximum_residual_w: 1e-3,
    maximum_correction_k: 1e-6,
    maximum_iterations: 16,
    maximum_backtracks: 12,
};
/// The S3 restarts: stock settings, the start's bound and its passes.
pub const RESTART: Restart = Restart {
    newton_coefficient: NEWTON_COEFFICIENT,
    delta_cj_lsetup: DELTA_CJ_LSETUP,
    first_step_s: FIRST_STEP_S,
    start_bound: START_BOUND,
    start_passes: 2,
    transaction_passes: 12,
    bound_placement: 1e-12,
};

/// The four RCPs supported at nominal speed, shafts free.
pub fn rotors() -> Vec<RotorState> {
    vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ]
}

/// S1's tolerance classes from the `ld01-s1-gates` block.
pub fn classes(gates: &Value) -> Result<ToleranceClasses, String> {
    let f = |k: &str| {
        gates[k]
            .as_f64()
            .ok_or_else(|| format!("ld01-s1-gates declares no number {k}"))
    };
    Ok(ToleranceClasses {
        relative: f("relativeTolerance")?,
        stock_scaled: f("stockScaledAbsolute")?,
        tracer_scaled: f("tracerScaledAbsolute")?,
        rotor_scaled: f("rotorScaledAbsolute")?,
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s")?,
    })
}

/// The integrator's error weights at a state, `1 / (rtol |y| + atol)`.
pub fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

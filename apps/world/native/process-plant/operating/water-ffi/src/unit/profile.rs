//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The unit's solver profile: the stock IDA settings, the exact consistent
//! start's bounds and the preparations' controls the S1, S2 and S3 harnesses
//! declared, each in one place. S1's tolerance classes are read from
//! `ld01-s1-gates`, never written here.
use crate::{
    frame::Stepping,
    ida::{Ida, System},
    joined::{FirstStep, JoinedSystem, Restart, census_groups},
};
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
/// The derived rods/GuideCurrent class's core-DP basis under the
/// operator-grade budgets (lead decision R4-GUIDE-BASIS, plan r4), in
/// place of the accuracy contract's 50 Pa: no LD-01 instrument reads core
/// DP; at 5,000 Pa every instrumented output's E0 is unchanged.
pub const GUIDE_CURRENT_BASIS_PA: f64 = 5000.;
/// The PZR owner's PT1 channel lag (R4-PZR-CONTINUOUS, PERF3; lead ruling:
/// a system class like FeedControl/InventoryControl with an operator-grade
/// absolute tolerance): the lag is the PT1 channel's own reading, so its
/// absolute tolerance is that channel's budget under `ld01-operator-budgets`
/// r2 (RP-pin-ogb-r2, 9def9c2b…): `numerical.pzrPressure_Pa.budget_Pa`, a
/// quarter of the channel rule's 161,245 Pa uncertainty, as FEED's lags
/// take their channels' budgets (`ld01-feed-compact`).
pub const PZR_LAG_TOLERANCE_PA: f64 = 40_311.;
/// The S3 restarts: stock settings, the start's bound and its passes
/// (ordinary restarts 3, lead decision R4-START-PASSES).
pub const RESTART: Restart = Restart {
    newton_coefficient: NEWTON_COEFFICIENT,
    delta_cj_lsetup: DELTA_CJ_LSETUP,
    first_step_s: FIRST_STEP_S,
    start_bound: START_BOUND,
    start_passes: 3,
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

/// The error-weight rule of a unit's stock IDA handle (N1, owner R11-2), an
/// explicit configuration value every composition receipt records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Weights {
    /// Stock IDA's error weights `1 / (rtol |y| + atol)`.
    Stock,
    /// Group-normalised weights on the operator's census groups (credited
    /// groups split to at most 9) through stock IDAWFtolerances
    /// ([`census_groups`], [`Ida::group_weights`]).
    Grouped,
}
/// A unit's solver configuration beyond the fixed profile: the error-weight
/// rule (N1), the first step of every discrete restart (N3,
/// [`FirstStep`]) and how the frame driver bounds stock's steps
/// (R4-FREE-STEPS, [`Stepping`]), and the water method (IF97 reference or
/// SBTL tables, [`crate::WaterMethod`]; owner decision 1 Nov). An explicit
/// value of every composition; its receipt records all four.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Solver {
    pub weights: Weights,
    pub first_step: FirstStep,
    pub stepping: Stepping,
    pub water: crate::WaterMethod,
    /// R4-NUC-SOURCE-ATOL (lead 1 Nov): the populations' and precursors'
    /// absolute tolerances derived at the hot-standby basis
    /// ([`super::source_atol`]), or the stock scaled floor.
    pub source_atol: SourceAtol,
}
/// R4-NUC-SOURCE-ATOL: `derived` (the composition of record) or `stock`
/// (the stock scaled floor, the record before it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceAtol {
    Derived,
    Stock,
}
impl SourceAtol {
    /// `derived` or `stock`; anything else refuses.
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "derived" => Ok(Self::Derived),
            "stock" => Ok(Self::Stock),
            other => Err(format!("source_atol {other}: derived or stock")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Derived => "derived",
            Self::Stock => "stock",
        }
    }
}
impl Solver {
    /// Stock weights, the declared G13 first step, free stepping
    /// (R4-FREE-STEPS, lead 1 Nov) and the SBTL water (R4-SBTL; the default
    /// since the combined re-pin's gates of record passed, lead 1 Nov): the
    /// composition of record. IF97 stays the named reference.
    pub const STOCK: Self = Self {
        weights: Weights::Stock,
        first_step: FirstStep::Declared,
        stepping: Stepping::Free,
        water: crate::WaterMethod::Sbtl,
        source_atol: SourceAtol::Derived,
    };
}

/// A stepping by name: `free` or `frame-stops`; anything else refuses.
pub fn parse_stepping(name: &str) -> Result<Stepping, String> {
    match name {
        "free" => Ok(Stepping::Free),
        "frame-stops" => Ok(Stepping::FrameStops),
        other => Err(format!("stepping {other}: free or frame-stops")),
    }
}

/// A first-step policy by name: `declared`, `last/<divisor>` or
/// `last-unless-roots/<divisor>` (divisor finite and >= 1); anything else
/// refuses.
pub fn parse_first_step(name: &str) -> Result<FirstStep, String> {
    let divisor = |d: &str| -> Result<f64, String> {
        let v: f64 = d
            .parse()
            .map_err(|_| format!("first step {name}: divisor {d} is not a number"))?;
        if v.is_finite() && v >= 1. {
            Ok(v)
        } else {
            Err(format!(
                "first step {name}: divisor must be finite and >= 1"
            ))
        }
    };
    match name.split_once('/') {
        None if name == "declared" => Ok(FirstStep::Declared),
        Some(("last", d)) => Ok(FirstStep::LastStep {
            divisor: divisor(d)?,
        }),
        Some(("last-unless-roots", d)) => Ok(FirstStep::LastStepUnlessRoots {
            divisor: divisor(d)?,
        }),
        _ => Err(format!(
            "first step {name}: declared, last/<divisor> or last-unless-roots/<divisor>"
        )),
    }
}

impl Weights {
    /// `stock` or `grouped`; anything else refuses.
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "stock" => Ok(Self::Stock),
            "grouped" => Ok(Self::Grouped),
            other => Err(format!("weights {other}: stock or grouped")),
        }
    }
    /// The rule on a fresh handle, right after `Ida::new` and before its
    /// first consistent start or step, so the start's guard and every later
    /// step use it.
    pub fn apply<S: JoinedSystem + System>(self, ida: &mut Ida<S>) -> Result<(), String> {
        match self {
            Self::Stock => Ok(()),
            Self::Grouped => {
                let groups = census_groups(ida.system())?;
                ida.group_weights(groups)
            }
        }
    }
}

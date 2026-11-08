//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/turbine-and-regeneration-dynamics.md#turbine-valve-governor-and-dump-x43
//! X4.3 (plan r4, lane TURB): the governor, ADM and GEN.WT composition's
//! inputs, read from their strict wiki blocks — `ld01-governor`,
//! `ld01-governor-x43` (turbine page),
//! `ld01-steam-valve-travel` (admission page) —
//! and the Grid's power request decided at a Grid exchange.
use crate::{
    electrical::Electrified,
    frame::{Action, Change, Class, Driver},
    joined::JoinedSystem,
};
use leitbild_operating_plant::turbine::governor::{
    ContinuousBlock, GovernorBlock, Parameters, ValveMarginBlock,
};
use serde_json::{Value, json};

pub const TURBINE_PAGE: &str = "world/packs/process-plant/reference-designs/ld-01/systems/steam-power/turbine-and-regeneration-dynamics.md";
pub const ADMISSION_PAGE: &str = "world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md";

/// The composition's inputs.
#[derive(Clone, Debug)]
pub struct Turbine {
    pub governor: GovernorBlock,
    pub continuous: ContinuousBlock,
    pub admission_travel_s: f64,
    pub valve_margin: ValveMarginBlock,
}

fn block(wiki: &str, page: &str, fence: &str) -> Result<Value, String> {
    let path = format!("{wiki}/{page}");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    super::inputs::strict_block(&text, fence, &path)
}
fn number(v: &Value, key: &str, fence: &str) -> Result<f64, String> {
    v[key]
        .as_f64()
        .ok_or_else(|| format!("{fence} has no number {key}"))
}

impl Turbine {
    /// The blocks of the wiki at `wiki`.
    pub fn from_wiki(wiki: &str) -> Result<Self, String> {
        let governor = serde_json::from_value(block(wiki, TURBINE_PAGE, "ld01-governor")?)
            .map_err(|e| format!("ld01-governor: {e}"))?;
        let continuous = serde_json::from_value(block(wiki, TURBINE_PAGE, "ld01-governor-x43")?)
            .map_err(|e| format!("ld01-governor-x43: {e}"))?;
        let travel = block(wiki, ADMISSION_PAGE, "ld01-steam-valve-travel")?;
        let valve_margin: ValveMarginBlock =
            serde_json::from_value(block(wiki, TURBINE_PAGE, "ld01-turbine-valve-margin")?)
                .map_err(|e| format!("ld01-turbine-valve-margin: {e}"))?;
        valve_margin.margin()?;
        Ok(Self {
            governor,
            continuous,
            admission_travel_s: number(&travel, "admission_s", "ld01-steam-valve-travel")?,
            valve_margin,
        })
    }
    /// The governor's parameters at the rated mechanical speed `omega0`.
    pub fn parameters(&self, omega0_rad_s: f64) -> Parameters {
        Parameters {
            governor: self.governor,
            continuous: self.continuous,
            admission_travel_s: self.admission_travel_s,
            omega0_rad_s,
            full_open_margin: self.valve_margin.generator_rated_output_kw
                / self.valve_margin.turbine_nominal_output_kw,
        }
    }
    pub fn receipt(&self) -> Value {
        json!({"governor": self.governor, "continuous": self.continuous, "admission_travel_s": self.admission_travel_s, "valve_margin": self.valve_margin,
            "judgements": ["admission proportional to opening x SG dome pressure (the header/HP inlet stand-in until C10's header store joins; lead 1 Nov)",
                "no at-power dump: the Tavg-mode load-rejection dump is not in 1.0 (CRED I14; lead ruling x43-5)",
                "governor: 5 % speed droop about the load reference (request over the start's full-open export); GEN.WT only as the slow Ki trim (x43-5, the fast power loop destabilised the swing mode in x43-4)",
                "GEN.WT continuous: 0.1 s lag, rounding/sampling/transport omitted",
                "back-calculation anti-windup, tracking time proportional/integral",
                "ADM position loop lag = the 0.1 s governor sampling; 1 s full travel as a rate bound"]})
    }
}

/// The Grid's power request `request_w` decided at the exchange `t0`
/// through the driver: a held setpoint input entering only the governor's
/// integral and position rates (class S, S3-D4); none when it agrees with
/// the request in force.
pub fn grid_request<J: JoinedSystem>(
    driver: &mut Driver<Electrified<J>>,
    unit: &Electrified<J>,
    t0: f64,
    request_w: f64,
) -> Result<&'static str, String> {
    let g = unit.governor.as_ref().ok_or("no governor composed")?;
    if !request_w.is_finite() {
        return Err(format!("the Grid's power request {request_w} W"));
    }
    if g.held.to_w.to_bits() == request_w.to_bits() {
        return Ok("none (the request in force)");
    }
    driver.decide(vec![Change {
        due_s: t0,
        class: Class::S,
        kind: "Grid power request (governor setpoint ramp, X4.3)".into(),
        action: Action::Held(Box::new(move |u: &mut Electrified<J>| {
            u.request_power(t0, request_w).map(|_| ())
        })),
    }])?;
    Ok("S: power request")
}

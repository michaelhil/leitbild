//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! IC-CTRL's normal PZR pressure control in AUTO under R4-PZR-PI (lead
//! 1 Nov 2026; on PERF3's R4-PZR-CONTINUOUS): the pressure master runs
//! continuously inside the PZR owner on the PT1 channel's lag and its own
//! integral, owner coordinates (`joined::pzr::Pzr`), and with the network's
//! spray path it drives the controlled-spray stem, also an owner
//! coordinate, opening and closing at the owner's located roots (class R).
//! Nothing here decides or changes anything. Commissioning puts the master
//! in force at the start state, after checking that the packet's continuous
//! control is the compiled `pzrControl` law and the wiki's
//! `reference-pzr-pressure-channel` lag; a held demand in force is carried
//! exactly into the integral (`Pzr::integral_for_request`). The frame client
//! is a class-O record of the master's demand, heater request and spray
//! demand at each frame, for the case receipts and the unit's readings.
//!
//! Reduction (R4-PZR-PI): the sampled law's AUTO withdrawal on an unusable
//! PT1 sample is not modelled. The continuous master reads the channel's
//! lag; a lag outside the channel's span (`reference-pzr-pressure-channel`
//! min/max) ends the case loudly at that frame, never a silent continuation
//! (the coverage rule). Sensor faults (stuck, biased, unavailable PT1) are
//! not composed in the operating unit.
use crate::{
    If97,
    frame::{Action, Change, Class, Client, Dense},
    joined::JoinedSystem,
};
use leitbild_operating_plant::{
    control::pzr_pressure::Law,
    ic::acquisition as bits,
    joined::{
        operator::Joined,
        pzr::{Control, ContinuousControl, SprayMode},
    },
};
use serde_json::{Value, json};

/// `reference-pzr-pressure-channel` (operational-observations.md). Under
/// R4-PZR-PI the control path reads only its lag; sampling, quantum and
/// transport stay the acquired channels' (protection, alarms, displays).
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelBlock {
    pub lag_s: f64,
    pub min_pa: f64,
    pub max_pa: f64,
    pub quantum_pa: f64,
    pub sample_s: f64,
    pub transport_s: f64,
}

/// The class-O record of the continuous master: what it delivers at each
/// frame (the plant's own functions of the owner coordinates at the
/// frame's state).
pub struct PzrClient {
    pub control: ContinuousControl,
    /// The lag's and the integral's global indices and solver scales.
    pub lag: (usize, f64),
    pub integral: (usize, f64),
    /// The PT1 channel's span, Pa: the lag leaving it ends the case.
    pub span: [f64; 2],
    /// The master's demand (Pa), heater request (W) and spray demand at
    /// the last frame.
    pub demand_pa: f64,
    pub in_force_w: f64,
    pub spray_demand: f64,
    pub scratch: Vec<f64>,
    /// R4-RELIEF-ISO: this frame sampled a stroke with its supply gone.
    pub valve_unsupplied: bool,
}
impl PzrClient {
    /// The master's demand (Pa), heater request (W) and spray demand at
    /// state `y` (solver scaling); the spray demand is zero below the
    /// spray start.
    pub fn outputs(&self, y: &[f64]) -> [f64; 3] {
        use leitbild_operating_plant::thermal::Scalar;
        let m = &self.control;
        let d = m.demand(
            Scalar::constant(y[self.lag.0] * self.lag.1),
            Scalar::constant(y[self.integral.0] * self.integral.1),
        );
        let u = if d.value >= m.spray_start_pa {
            m.spray_demand(d).value
        } else {
            0.
        };
        [d.value, m.heater_request(d).value, u]
    }
    /// The reduction's loud end: the lag outside the channel's span.
    /// `t` is the frame instant, `None` at commissioning.
    pub fn within_span(&self, t: Option<f64>, y: &[f64]) -> Result<(), String> {
        let lag = y[self.lag.0] * self.lag.1;
        if !(lag.is_finite() && self.span[0] <= lag && lag <= self.span[1]) {
            let at = t.map_or("at commissioning".to_string(), |t| format!("at {t} s"));
            return Err(format!(
                "{at} the PT1 channel lag {lag} Pa left its span [{}, {}] Pa: the continuous master models no AUTO withdrawal (R4-PZR-PI reduction); the case ends",
                self.span[0], self.span[1]
            ));
        }
        Ok(())
    }
    /// HOOK (WORLD `ld01-unit`, S5 snapshot): the client holds no state of
    /// the controller (the lag, the integral and the stem are coordinates,
    /// the stem's mode the PZR block's discrete state); only the last
    /// frame's record, as bits, so a restored unit reads the same values
    /// before its next frame.
    pub fn snapshot(&self) -> Result<Value, String> {
        Ok(json!({"class": "continuous master (R4-PZR-PI)",
            "record": [bits::snapshot_real(self.demand_pa), bits::snapshot_real(self.in_force_w), bits::snapshot_real(self.spray_demand)]}))
    }
    /// Restore [`PzrClient::snapshot`] exactly; any other form refuses.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let o = bits::snapshot_fields(v, "PZR control", &["class", "record"])?;
        if o["class"] != json!("continuous master (R4-PZR-PI)") {
            return Err(format!("PZR control of class {} restored into the continuous master", o["class"]));
        }
        match o["record"].as_array().map(Vec::as_slice) {
            Some([d, w, u]) => {
                self.demand_pa = bits::restored_real(d, "PZR master demand")?;
                self.in_force_w = bits::restored_real(w, "PZR heater request")?;
                self.spray_demand = bits::restored_real(u, "PZR spray demand")?;
                Ok(())
            }
            _ => Err(format!("PZR control record {}", o["record"])),
        }
    }
}
// Generic over the joined system (KERN, S3-D28): the S3 settle composes
// the electrical slice around the operator.
impl<S: JoinedSystem> Client<S> for PzrClient {
    fn name(&self) -> &str {
        "LD01.PZR normal pressure control (continuous master, record)"
    }
    fn advance(&mut self, _dense: &dyn Dense, _from: f64, _to: f64) -> Result<(), String> {
        Ok(())
    }
    /// R4-RELIEF-ISO: a stroke in progress whose supply is gone.
    fn sample(&mut self, _k: u64, t: f64, system: &S) -> Result<(), String> {
        let pzr = system.integrated().joined.pzr();
        self.valve_unsupplied = match (pzr.isolation_block(), system.dc_groups()) {
            (Some(valve), Some(groups)) if pzr.isolation_moving() => groups
                .reports(t)?
                .iter()
                .any(|r| r.group == valve.supply_group && !r.output_available),
            _ => false,
        };
        Ok(())
    }
    fn frame(&mut self, _k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        dense.derivative(t, 0, &mut self.scratch)?;
        self.within_span(Some(t), &self.scratch)?;
        [self.demand_pa, self.in_force_w, self.spray_demand] = self.outputs(&self.scratch);
        if !std::mem::take(&mut self.valve_unsupplied) {
            return Ok(Vec::new());
        }
        // The position arrests where it is; intent does not replay.
        Ok(vec![Change {
            due_s: t,
            class: Class::R,
            kind: "relief isolation: supply lost in travel".into(),
            action: Action::Held(Box::new(move |system: &mut S| {
                system
                    .integrated_mut()
                    .joined
                    .pzr_mut()
                    .arrest_isolation(t)
                    .map_err(|e| format!("{e:?}"))
            })),
        }])
    }
}

/// The channel block from the wiki the control section was compiled from
/// (`operational-observations.md`).
pub fn channel_block(wiki: &str) -> Result<ChannelBlock, String> {
    let path = format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md"
    );
    let page = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let fence = "```reference-pzr-pressure-channel\n";
    let start = page
        .find(fence)
        .ok_or_else(|| format!("{path} has no reference-pzr-pressure-channel block"))?
        + fence.len();
    let end = start
        + page[start..]
            .find("\n```")
            .ok_or_else(|| format!("{path}: unterminated channel block"))?;
    serde_json::from_str(&page[start..end]).map_err(|e| format!("channel block: {e}"))
}

/// Commissioning at the start state, before the integrator is made: the
/// packet's continuous control must be the compiled law (setpoint,
/// capacity, band and spray offsets bitwise) and the channel block's lag.
/// A held demand in force (a state carried onto the master's packet) is
/// carried into the integral exactly, so the master's request at the
/// state's own lag is that demand (a demand outside the open heater range
/// refuses, never clamps), and the spray stem must rest locked with the
/// network's valve path closed; a restored continuous state keeps its own
/// coordinates and stem mode, which must agree with the valve path's lock.
/// The network then takes its stem from the owner. The caller
/// re-establishes consistency (a discrete restart at `t0`) before the
/// first step. Returns the client, the held demand it carried (none when
/// the state was already continuous) and the start request (W).
pub fn commission(
    joined: &mut Joined<If97>,
    law: &Law,
    channel: ChannelBlock,
    y: &mut [f64],
) -> Result<(PzrClient, Option<f64>, f64), String> {
    let pzr = joined.pzr();
    let control = *pzr.continuous_control().ok_or(
        "the S3 composition needs the PZR owner's continuous master (the packet's pzrMetal.continuousControl, R4-PZR-PI)",
    )?;
    let agrees = [
        (control.setpoint_pa, law.setpoint_pa()),
        (control.heater_capacity_w, law.capacity_w()),
        (control.heater_band_pa, law.band_pa()),
        (control.spray_start_pa, law.spray_start_pa()),
        (control.spray_full_pa, law.spray_full_pa()),
        (control.lag_s, channel.lag_s),
    ]
    .iter()
    .all(|(a, b)| a.to_bits() == b.to_bits());
    if !agrees {
        return Err(format!(
            "the packet's continuous control {control:?} is not the compiled law and the channel block's lag"
        ));
    }
    let offset = joined.offsets().pzr;
    let scales = pzr.layout().scales.clone();
    let x = |y: &[f64]| -> Vec<f64> {
        scales
            .iter()
            .enumerate()
            .map(|(k, sc)| y[offset + k] * sc)
            .collect()
    };
    let held = pzr.control() == Control::Held;
    let carried = held.then(|| pzr.request_w());
    if let Some(request_w) = carried {
        let k = pzr
            .integral_coordinate()
            .ok_or("continuous control without its integral")?;
        let integral = pzr
            .integral_for_request(&x(y), request_w)
            .map_err(|e| format!("carrying the held demand into the master: {e:?}"))?;
        y[offset + k] = integral / scales[k];
        if let Some(st) = pzr.stem_coordinate()
            && y[offset + st] != 0.
        {
            return Err(format!(
                "a held state's spray stem at {} (it rests locked at 0)",
                y[offset + st]
            ));
        }
    }
    let mode = pzr.spray_mode();
    let spray = joined.network.spray_discrete_state();
    match (mode, spray) {
        (None, _) => {}
        (Some(m), Some(sp)) => {
            if (m == SprayMode::Locked) != sp.closed {
                return Err(format!(
                    "the spray stem's mode {m:?} against the valve path closed={}",
                    sp.closed
                ));
            }
        }
        (Some(_), None) => return Err("a spray stem without the network's spray path".into()),
    }
    joined
        .pzr_mut()
        .commission_continuous()
        .map_err(|e| format!("commissioning: {e:?}"))?;
    if mode.is_some() {
        joined
            .network
            .set_spray_continuous()
            .map_err(|e| format!("commissioning the spray stem: {e:?}"))?;
    }
    let pzr = joined.pzr();
    let (kl, ki) = (
        pzr.lag_coordinate().ok_or("continuous control without its lag")?,
        pzr.integral_coordinate().ok_or("continuous control without its integral")?,
    );
    let mut client = PzrClient {
        control,
        lag: (offset + kl, scales[kl]),
        integral: (offset + ki, scales[ki]),
        span: [channel.min_pa, channel.max_pa],
        demand_pa: 0.,
        in_force_w: 0.,
        spray_demand: 0.,
        scratch: vec![0.; y.len()],
        valve_unsupplied: false,
    };
    client.within_span(None, y)?;
    [client.demand_pa, client.in_force_w, client.spray_demand] = client.outputs(y);
    let w = client.in_force_w;
    Ok((client, carried, w))
}

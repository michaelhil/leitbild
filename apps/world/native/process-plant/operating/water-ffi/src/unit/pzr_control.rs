//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! IC-CTRL's normal PZR pressure controller as a frame-driver client (S3-D5):
//! the reference PT1 channel (`reference-pzr-pressure-channel`: first-order
//! lag integrated exactly under each accepted step's polynomial, range
//! check, nearest-quantum rounding, one-frame transport), the controller's
//! frame decision, and the heater request applied as a held input at its
//! frame instant in the class the run declares (S3-D4: S).
use crate::{
    If97,
    frame::{Action, Change, Class, Client, Dense, Frame},
    joined::{Integrated, JoinedSystem},
};
use leitbild_operating_plant::{
    control::pzr_pressure::{Controller, Demand, Law, Quality, Sample},
    joined::operator::Joined,
    network::stratified::{self, Coordinates as PzrCoordinates},
    thermal::Scalar,
};

pub type System = Integrated<If97>;

/// The two main-loop return faces (RETURN.A/B -> DOWN), as the settle's
/// credited outputs read them.
pub const LOOP_FACES: [usize; 2] = [22, 30];

/// `reference-pzr-pressure-channel` (operational-observations.md).
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

/// Where the recorded outputs live in `y` (solver scaling) and their
/// physical factors.
#[derive(Clone)]
pub struct Probe {
    pub pzr: std::ops::Range<usize>,
    pub pzr_scales: Vec<f64>,
    pub cell: stratified::Cell,
    pub sg: [(usize, f64); 2],
    pub loops: [(usize, f64); 2],
}
impl Probe {
    pub fn new(joined: &mut Joined<If97>, t: f64, y: &[f64], yp: &[f64]) -> Result<Self, String> {
        joined
            .evaluate(t, y, yp, None, 0., None)
            .map_err(|e| format!("the PZR probe's evaluation at {t} s: {e:?}"))?;
        let net = &joined.network;
        let pzr = net.pzr.coordinates();
        let pzr_scales = pzr.clone().map(|i| net.scales()[i]).collect();
        let mut loops = [(0, 0.); 2];
        for (slot, f) in loops.iter_mut().zip(LOOP_FACES) {
            let l = net
                .face_layout
                .iter()
                .find(|l| l.face == f && l.phase == 0)
                .ok_or_else(|| format!("no liquid coordinate on loop face {f}"))?;
            let flow = net
                .chart(f, 0)
                .ok_or_else(|| format!("no chart on loop face {f}"))?
                .mass_flow_kg_s
                .value;
            *slot = (l.index, flow / y[l.index]);
        }
        let cell = net.stratified().clone();
        let mut sg = Vec::new();
        let mut k = 0;
        for (owner, layout) in joined.layouts() {
            for (i, label) in layout.labels.iter().enumerate() {
                if owner == "secondary" && label.ends_with(".p_s") {
                    sg.push((k, layout.scales[i]));
                }
                k += 1;
            }
        }
        if sg.len() != 2 {
            return Err(format!("{} SG pressures, not 2", sg.len()));
        }
        Ok(Self {
            pzr,
            pzr_scales,
            cell,
            sg: [sg[0], sg[1]],
            loops,
        })
    }
    pub fn roof_pa(&self, y: &[f64]) -> f64 {
        y[self.pzr.start + stratified::ROOF_PRESSURE] * self.pzr_scales[stratified::ROOF_PRESSURE]
    }
    pub fn outputs(&self, y: &[f64]) -> Result<[f64; 6], String> {
        let x: Vec<Scalar> = self
            .pzr
            .clone()
            .zip(&self.pzr_scales)
            .map(|(i, s)| Scalar::constant(y[i] * s))
            .collect();
        let x = PzrCoordinates::from_slice(&x).map_err(|e| format!("PZR coordinates: {e:?}"))?;
        let column = self
            .cell
            .column(&If97, &x, None)
            .map_err(|e| format!("PZR column: {e:?}"))?;
        let level = self
            .cell
            .taps(&If97, &column)
            .map_err(|e| format!("PZR taps: {e:?}"))?
            .collapsed_level_m
            .value;
        Ok([
            self.roof_pa(y),
            level,
            y[self.sg[0].0] * self.sg[0].1,
            y[self.sg[1].0] * self.sg[1].1,
            y[self.loops[0].0] * self.loops[0].1,
            y[self.loops[1].0] * self.loops[1].1,
        ])
    }
}

/// The normal PZR pressure controller as a frame-driver client, with the
/// test's PT1 channel.
pub struct PzrClient {
    pub class: Class,
    pub controller: Controller,
    pub replay: Option<Vec<(u64, f64)>>,
    pub channel: ChannelBlock,
    pub probe: Probe,
    pub lag: f64,
    pub lag_at: f64,
    pub in_flight: Sample,
    pub in_force_w: f64,
    pub scratch: Vec<f64>,
    /// Per frame: index, outputs and the request in force after it.
    pub series: Vec<(u64, [f64; 7])>,
    pub schedule: Vec<(u64, f64)>,
}
impl PzrClient {
    pub fn acquire(&self, t: f64) -> Sample {
        let quality = if self.lag < self.channel.min_pa {
            Quality::BelowRange
        } else if self.lag > self.channel.max_pa {
            Quality::AboveRange
        } else {
            Quality::Usable
        };
        Sample {
            value_pa: (self.lag / self.channel.quantum_pa + 0.5).floor() * self.channel.quantum_pa,
            acquired_s: t,
            quality,
        }
    }
    /// `Σ_k (−τ)^k p^(k)(t)` of the roof-pressure polynomial.
    fn particular(&mut self, dense: &dyn Dense, t: f64) -> Result<f64, String> {
        let (tau, mut sum, mut factor) = (self.channel.lag_s, 0., 1.);
        for k in 0..=dense.order() {
            dense.derivative(t, k, &mut self.scratch)?;
            sum += factor * self.probe.roof_pa(&self.scratch);
            factor *= -tau;
        }
        Ok(sum)
    }
}
// Generic over the joined system (KERN, S3-D28): the S3 settle composes
// the electrical slice around the operator.
impl<S: JoinedSystem> Client<S> for PzrClient {
    fn name(&self) -> &str {
        "LD01.PZR normal pressure control"
    }
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String> {
        if from != self.lag_at {
            return Err(format!("lag at {} s advanced from {from} s", self.lag_at));
        }
        let (a, b) = (self.particular(dense, from)?, self.particular(dense, to)?);
        self.lag = b + (self.lag - a) * (-(to - from) / self.channel.lag_s).exp();
        self.lag_at = to;
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        if t != self.lag_at {
            return Err(format!("frame at {t} s with the lag at {} s", self.lag_at));
        }
        dense.derivative(t, 0, &mut self.scratch)?;
        let o = self.probe.outputs(&self.scratch)?;
        // The sample acquired one transport earlier arrives now; the start's
        // commissioning sample is acquired and delivered at the start.
        let due = self.in_flight.acquired_s + self.channel.transport_s;
        if !((due - t).abs() <= 1e-9 * t.abs() || self.in_flight.acquired_s == t) {
            return Err(format!("the sample in flight is due at {due} s, not {t} s"));
        }
        let delivered = self.in_flight;
        self.in_flight = self.acquire(t);
        let decided = self.controller.frame(t, Some(&delivered)).demand;
        let target = match &self.replay {
            Some(s) => s.iter().find(|e| e.0 == k).map_or(self.in_force_w, |e| e.1),
            None => decided.heater_request_w,
        };
        let mut out = Vec::new();
        if target != self.in_force_w {
            let demand = Demand {
                heater_request_w: target,
                spray_target: 0.,
                withdrawn: None,
            };
            out.push(Change {
                due_s: t,
                class: self.class,
                kind: "PZR heater request".into(),
                action: Action::Held(Box::new(move |s: &mut S| {
                    s.integrated_mut()
                        .joined
                        .pzr_mut()
                        .apply_control(t, &demand)
                        .map(|_| ())
                        .map_err(|f| format!("{f:?}"))
                })),
            });
            self.in_force_w = target;
            self.schedule.push((k, target));
        }
        self.series
            .push((k, [o[0], o[1], o[2], o[3], o[4], o[5], self.in_force_w]));
        Ok(out)
    }
    fn stop_at_frame(&self, _k: u64) -> bool {
        // An S change can only be applied at an exact stop; with a 0.1 s
        // transport the decision at frame k+1 is known only after frame k.
        self.class == Class::S
    }
}

/// The channel block from the wiki the control section was compiled from
/// (`operational-observations.md`), refused unless its sampling and
/// transport are the control frame.
pub fn channel_block(wiki: &str, law: &Law) -> Result<ChannelBlock, String> {
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
    let channel: ChannelBlock =
        serde_json::from_str(&page[start..end]).map_err(|e| format!("channel block: {e}"))?;
    if channel.sample_s != law.frame_s() {
        return Err("the control frame is not the channel's sample".into());
    }
    if channel.transport_s != law.frame_s() {
        return Err("the channel does not deliver one frame later".into());
    }
    Ok(channel)
}

/// Commissioning at the start state, before the integrator is made: the
/// lag at the roof pressure, the first sample acquired now, its demand (or
/// a replayed schedule's first entry) put in force in the joined PZR block
/// and held by the controller, so the start frame reports no change. The
/// caller re-establishes consistency (a discrete restart at `t0`) before
/// the first step. Returns the client, the prepared and the start request
/// (W).
#[allow(clippy::too_many_arguments)] // The operator, the law and channel, the class, the replay and the state.
pub fn commission(
    joined: &mut Joined<If97>,
    law: &Law,
    channel: ChannelBlock,
    class: Class,
    replay: Option<&[(u64, f64)]>,
    t0: f64,
    y: &[f64],
    yp: &[f64],
) -> Result<(PzrClient, f64, f64), String> {
    let prepared_w = joined.pzr().request_w();
    let probe = Probe::new(joined, t0, y, yp)?;
    let lag = probe.roof_pa(y);
    // Commissioning: lag at the roof pressure, first sample acquired now.
    let mut client = PzrClient {
        class,
        controller: Controller::new(law.clone(), prepared_w, 0.).map_err(|e| format!("{e:?}"))?,
        replay: replay.map(<[_]>::to_vec),
        channel,
        probe,
        lag,
        lag_at: t0,
        in_flight: Sample {
            value_pa: 0.,
            acquired_s: t0,
            quality: Quality::Unavailable,
        },
        in_force_w: prepared_w,
        scratch: vec![0.; y.len()],
        series: Vec::new(),
        schedule: Vec::new(),
    };
    client.in_flight = client.acquire(t0);
    let first = client.controller.law().auto(Some(&client.in_flight), t0);
    let start_w = match replay {
        Some(s) => {
            if s.first().map(|e| e.1) != Some(first.heater_request_w) {
                return Err(
                    "the replayed schedule does not start on the commissioning demand".into(),
                );
            }
            s[0].1
        }
        None => first.heater_request_w,
    };
    let start = Demand {
        heater_request_w: start_w,
        spray_target: 0.,
        withdrawn: None,
    };
    joined
        .pzr_mut()
        .apply_control(t0, &start)
        .map_err(|e| format!("the commissioning demand: {e:?}"))?;
    // The controller and the client hold the start demand in force, so the
    // start frame reports no change.
    client.controller = Controller::new(law.clone(), start_w, 0.).map_err(|e| format!("{e:?}"))?;
    client.in_force_w = start_w;
    let k0 = Frame::new(law.frame_s())?.at_or_after(t0)?;
    client.schedule.push((k0, start_w));
    Ok((client, prepared_w, start_w))
}

//! The three-element SG level controllers (`control::feed`, plan r4 X4.1)
//! as one frame-driver client of the composition, the PZR controller's
//! pattern (`pzr_control.rs`): the channels' first-order lags, the
//! cascade's frame decision per SG and the FCV demand applied to the SG
//! owner's stem as a held input at its frame instant (class S: the stem
//! position is continuous there, only its slope changes).
//!
//! Channels (`ld01-sg-level-channels`, `ld01-feed-cascade`): NR1 reads the
//! C08 apparent level `(V_l + V_sub) / A` (0.5 s lag), `FT.STEAM` the pickup
//! steam by the owner's own withdrawal law (turbine admission plus bypass,
//! reliefs excluded; 0.25 s), `FW.FT` the branch flow (0.25 s). Each lag is
//! advanced exactly between frame instants for an input linear between
//! them (first-order hold on the frame samples). A channel outside its
//! span is unusable and the cascade withdraws AUTO to HOLD.
#![allow(dead_code)] // Each test crate uses its own subset.
use leitbild_operating_plant::{
    control::feed::{Cascade, Controller, Inputs, Mode},
    joined::{block::Command, operator::Joined},
    sg::{packet, secondary},
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    frame::{Action, Change, Class, Client, Dense},
    joined::JoinedSystem,
};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug)]
struct Sg {
    liquid: (usize, f64),
    submerged: (usize, f64),
    pressure: (usize, f64),
    branch: (usize, f64),
    demand_kg_s: f64,
}

/// The feed controllers of every SG as one client.
pub struct FeedClient {
    pub class: Class,
    pub law: Cascade,
    pub m0: f64,
    pub frame_s: f64,
    resolution: f64,
    area_m2: f64,
    travel_s: f64,
    bypass: packet::Bypass,
    trip_s: Option<f64>,
    sgs: Vec<Sg>,
    pub controllers: Vec<Controller>,
    /// Per SG: lagged level (m), steam and feed (kg/s), and their inputs at
    /// the last frame.
    lag: Vec<[f64; 3]>,
    input: Vec<[f64; 3]>,
    frame_at: f64,
    /// The commissioning instant: its frame is the tracking law's
    /// transfer point (the demand in force is the stems' position), so the
    /// first law evaluation is the next frame's.
    commissioned_at: f64,
    positions: Vec<f64>,
    in_force: Vec<f64>,
    scratch: Vec<f64>,
    /// Per frame: index, time and per SG `[apparent level, NR1, FT.STEAM,
    /// FW.FT, request, demand, position, mode (0 MANUAL, 1 AUTO, 2 HOLD)]`.
    pub series: Vec<(u64, f64, Vec<[f64; 8]>)>,
    pub withdrawals: Vec<Value>,
}

fn lagged(previous: f64, x0: f64, x1: f64, h: f64, tau: f64) -> f64 {
    if h == 0. {
        return previous;
    }
    let slope = (x1 - x0) / h;
    let e = (-h / tau).exp();
    x1 - slope * tau + (previous - x0 + slope * tau) * e
}

impl FeedClient {
    /// Commissioned at `t0` on the composed operator: every lag at its
    /// input, each controller in MANUAL at its stem's position, then, when
    /// `auto`, moved to AUTO by the page's tracking law. `None` without a
    /// feed train.
    pub fn commission(
        joined: &Joined<If97>,
        section: &packet::Section,
        frame_s: f64,
        auto: bool,
        t0: f64,
        y: &[f64],
    ) -> Result<Option<Self>, String> {
        let (Some(train), Some(level)) = (section.feed_train, section.apparent_level.as_ref())
        else {
            return Ok(None);
        };
        let law = train.cascade;
        if law.sample_s != frame_s {
            return Err("the feed cascade samples on the I&C frame".into());
        }
        let secondary = joined.secondary().ok_or("no SG owner")?;
        let positions = secondary
            .feed_valve_positions(t0)
            .ok_or("the SG owner composes no feed train")?;
        let at = |label: String| -> Result<(usize, f64), String> {
            let mut k = 0;
            for (owner, layout) in joined.layouts() {
                for (i, l) in layout.labels.iter().enumerate() {
                    if owner == "secondary" && *l == label {
                        return Ok((k, layout.scales[i]));
                    }
                    k += 1;
                }
            }
            Err(format!("no coordinate {label}"))
        };
        let mut sgs = Vec::new();
        for g in &section.steam_generators {
            sgs.push(Sg {
                liquid: at(format!("SG.{}.V_l", g.id))?,
                submerged: at(format!("SG.{}.V_sub", g.id))?,
                pressure: at(format!("SG.{}.p_s", g.id))?,
                branch: at(format!("FW.{}.m", g.id))?,
                demand_kg_s: g.steam_demand_kg_s,
            });
        }
        let mut client = Self {
            class: Class::S,
            law,
            m0: train.nominal_flow_kg_s,
            frame_s,
            resolution: train.demand_resolution,
            area_m2: level.indication.indicated_level_area_m2,
            travel_s: section.steam_admission.stop_travel_s,
            bypass: section.bypass.clone(),
            trip_s: secondary.turbine_trip_time(),
            controllers: positions
                .iter()
                .map(|u| Controller::manual(*u, &law))
                .collect::<Result<_, _>>()
                .map_err(|e| format!("{e:?}"))?,
            input: vec![[0.; 3]; sgs.len()],
            lag: vec![[0.; 3]; sgs.len()],
            sgs,
            frame_at: t0,
            commissioned_at: t0,
            in_force: positions.clone(),
            positions,
            scratch: vec![0.; y.len()],
            series: Vec::new(),
            withdrawals: Vec::new(),
        };
        for k in 0..client.sgs.len() {
            client.input[k] = client.inputs_at(k, t0, y);
            client.lag[k] = client.input[k];
        }
        if auto {
            for k in 0..client.sgs.len() {
                let i = client.acquired(k);
                client.controllers[k]
                    .transfer_to_auto(&client.law, client.m0, &i)
                    .map_err(|e| format!("SG {k} AUTO entry: {e:?}"))?;
            }
        }
        Ok(Some(client))
    }

    /// `[apparent level, pickup steam, branch flow]` of SG `k` at `t`.
    fn inputs_at(&self, k: usize, t: f64, y: &[f64]) -> [f64; 3] {
        let g = self.sgs[k];
        let v = |(i, s): (usize, f64)| y[i] * s;
        let level = (v(g.liquid) + v(g.submerged)) / self.area_m2;
        let (steam, _) = secondary::pickup_steam(
            g.demand_kg_s,
            self.travel_s,
            &self.bypass,
            self.trip_s,
            t,
            Scalar::constant(v(g.pressure)),
        );
        [level, steam.value, v(g.branch)]
    }

    fn acquired(&self, k: usize) -> Inputs {
        let [l, s, f] = self.lag[k];
        let within = |v: f64, r: [f64; 2]| (r[0]..=r[1]).contains(&v).then_some(v);
        Inputs {
            level_m: within(l, self.law.narrow_span_m),
            steam_kg_s: within(s / self.m0, self.law.steam_flow_span).map(|_| s),
            feed_kg_s: within(f / self.m0, self.law.feed_flow_span).map(|_| f),
            position: self.positions[k],
        }
    }

    /// The dense-output buffer for the composed state's dimension.
    pub fn resize(&mut self, n: usize) {
        self.scratch = vec![0.; n];
    }
    /// The receipt section: settings and the per-frame series.
    pub fn receipt(&self) -> Value {
        json!({"law": self.law, "m0_kg_s": self.m0, "class": format!("{:?}", self.class),
            "channels": "NR1 = apparent level (V_l + V_sub)/A, FT.STEAM = pickup steam (turbine + bypass), FW.FT = branch flow; first-order hold between frames",
            "columns": ["apparent_level_m", "nr1_m", "ft_steam_kg_s", "fw_ft_kg_s", "request", "demand", "position", "mode"],
            "withdrawals": self.withdrawals,
            "series": self.series.iter().map(|(k, t, v)| json!([k, t, v])).collect::<Vec<_>>()})
    }
}

impl<S: JoinedSystem> Client<S> for FeedClient {
    fn name(&self) -> &str {
        "LD01.FW three-element SG level control"
    }
    fn advance(&mut self, _dense: &dyn Dense, _from: f64, _to: f64) -> Result<(), String> {
        Ok(())
    }
    fn sample(&mut self, _k: u64, t: f64, system: &S) -> Result<(), String> {
        let secondary = system
            .integrated()
            .joined
            .secondary()
            .ok_or("no SG owner")?;
        self.positions = secondary
            .feed_valve_positions(t)
            .ok_or("the SG owner composes no feed train")?;
        self.trip_s = secondary.turbine_trip_time();
        Ok(())
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Vec<Change<S>>, String> {
        if matches!(command, Command::TurbineTrip | Command::TurbineTripAcquired)
            && self.trip_s.is_none()
        {
            self.trip_s = Some(t);
        }
        Ok(Vec::new())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        dense.derivative(t, 0, &mut self.scratch)?;
        let h = t - self.frame_at;
        if h < 0. {
            return Err(format!("feed frame at {t} s before {} s", self.frame_at));
        }
        if t == self.commissioned_at {
            return Ok(Vec::new());
        }
        let taus = [
            self.law.nr_lag_s,
            self.law.steam_flow_lag_s,
            self.law.feed_flow_lag_s,
        ];
        let mut record = Vec::new();
        let mut targets = Vec::new();
        for g in 0..self.sgs.len() {
            let x = self.inputs_at(g, t, &self.scratch);
            for c in 0..3 {
                self.lag[g][c] = lagged(self.lag[g][c], self.input[g][c], x[c], h, taus[c]);
            }
            self.input[g] = x;
            let i = self.acquired(g);
            let d = self.controllers[g].frame(&self.law, self.m0, &i);
            if d.withdrawn {
                self.withdrawals
                    .push(json!({"sg": g, "t_s": t, "frame": k, "inputs": format!("{i:?}")}));
            }
            let mode = match d.mode {
                Mode::Manual => 0.,
                Mode::Auto => 1.,
                Mode::Hold => 2.,
            };
            record.push([
                x[0],
                self.lag[g][0],
                self.lag[g][1],
                self.lag[g][2],
                d.request,
                d.demand,
                self.positions[g],
                mode,
            ]);
            // The positioner's resolution: a demand reaches the stem once it
            // moves by at least one resolution, or at a range bound.
            let bound = d.demand == self.law.valve_range[0] || d.demand == self.law.valve_range[1];
            if d.demand != self.in_force[g]
                && ((d.demand - self.in_force[g]).abs() >= self.resolution || bound)
            {
                targets.push((g, d.demand));
                self.in_force[g] = d.demand;
            }
        }
        self.frame_at = t;
        self.series.push((k, t, record));
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let ramp = self.frame_s;
        Ok(vec![Change {
            due_s: t,
            class: self.class,
            kind: "LD01.FW FCV demand".into(),
            action: Action::Held(Box::new(move |s: &mut S| {
                let owner = s
                    .integrated_mut()
                    .joined
                    .secondary_mut()
                    .ok_or("no SG owner")?;
                for (g, u) in &targets {
                    owner
                        .set_feed_valve_demand(t, *g, *u, ramp)
                        .map_err(|f| format!("{f:?}"))?;
                }
                Ok(())
            })),
        }])
    }
    fn stop_at_frame(&self, _k: u64) -> bool {
        self.class == Class::S
    }
}

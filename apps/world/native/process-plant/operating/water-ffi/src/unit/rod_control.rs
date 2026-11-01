//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-and-verification.md#automatic-rod-control-x44
//! Automatic rod control (plan r4 X4.4, lane ROD) as a frame-driver client:
//! its four channels, the AUTO law ([`Controller`]) and the requested rate
//! applied to the rods' rate drive as a held input at its frame instant
//! (S3-D4: class S, it enters only the travel rows).
//!
//! Channels (`ld01-rod-control`), each a first-order lag continued exactly
//! between frame samples for an input linear between them, delivered at the
//! frame it is acquired:
//! - **Tavg:** per loop the mean of the HOT and COLD bulk-liquid temperature
//!   (HOT.A.UPSTREAM / HOT.B and COLD.A / COLD.B, IF97 at each cell's
//!   pressure and specific internal energy), the loops' mean, lagged and
//!   rounded to its quantum;
//! - **turbine load:** the turbine's admitted steam (the SG owner's
//!   admission boundary, which excludes the bypass) over its prepared value,
//!   lagged: the main-steam-flow channel Tref reads (X4.4 (a); AP1000 reads
//!   turbine impulse pressure);
//! - **nuclear power:** the fission rate over the packet's prepared hot
//!   reference (the S3-D7 proxy's total-events form), unlagged;
//! - **bank position:** the driven class's travel (BANK.POS), lagged.
//!
//! The full-power Tavg of the program is the Tavg channel's measurand at the
//! packet's prepared hot reference. AUTO engages at commissioning (the drive
//! at rest, no row changes) and withdraws when the rods report the drive
//! disengaged (the holding circuit's opening released or held the bank).
use crate::{
    If97,
    frame::{Action, Change, Class, Client, Dense},
    joined::JoinedSystem,
};
use leitbild_operating_plant::{
    control::rods::{Controller, Decision, Evidence, Law, Section, lag},
    joined::operator::Joined,
    network::Properties,
};
use serde_json::{Value, json};

/// The rod-control page below a wiki root.
pub const PAGE: &str =
    "world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-and-verification.md";

/// The `ld01-rod-control` block of the wiki at `wiki`.
pub fn section(wiki: &str) -> Result<Section, String> {
    let path = format!("{wiki}/{PAGE}");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let block = super::inputs::strict_block(&text, "ld01-rod-control", &path)?;
    serde_json::from_value(block).map_err(|e| format!("ld01-rod-control: {e}"))
}

/// One regular cell's liquid coordinates `(p, M_l, U_l)` and scales.
#[derive(Clone, Copy, Debug)]
struct Cell([(usize, f64); 3]);

/// One region's population and its supports' material stocks with their
/// reference production per atom (ic.rs's proxy form, weight 1).
type Region = (usize, f64, Vec<(usize, f64, f64)>);

/// Where the channels' measurands live in `y` (solver scaling).
#[derive(Clone, Debug)]
pub struct Probe {
    hot: [Cell; 2],
    cold: [Cell; 2],
    regions: Vec<Region>,
    reference_events: f64,
    travel: (usize, f64),
}

/// The loops' HOT and COLD cells (network regions).
pub const HOT: [&str; 2] = ["HOT.A.UPSTREAM", "HOT.B"];
pub const COLD: [&str; 2] = ["COLD.A", "COLD.B"];

impl Probe {
    /// The probe on the composed operator, with the nuclear reference at
    /// the packet's prepared hot reference `reference` (operator `y`).
    pub fn new(joined: &Joined<If97>, ids: &[String], reference: &[f64]) -> Result<Self, String> {
        let net = &joined.network;
        let scales = joined.scales();
        let cell = |id: &str| -> Result<Cell, String> {
            let node = ids
                .iter()
                .position(|r| r == id)
                .ok_or_else(|| format!("no network region {id}"))?;
            let l = net
                .cell_layout
                .get(node)
                .ok_or_else(|| format!("{id} is not a regular cell"))?;
            let (m, e) = (l.mass[0], l.energy[0]);
            Ok(Cell([
                (l.base, scales[l.base]),
                (m, scales[m]),
                (e, scales[e]),
            ]))
        };
        let hot = [cell(HOT[0])?, cell(HOT[1])?];
        let cold = [cell(COLD[0])?, cell(COLD[1])?];
        let nuclear = joined.nuclear();
        let base = joined.offsets().nuclear;
        let model = nuclear.feedback();
        let mut regions: Vec<Region> = (0..nuclear.regions())
            .map(|r| (base + r, scales[base + r], Vec::new()))
            .collect();
        for s in model.supports() {
            let x = base + nuclear.material(s.material, 0);
            let atoms = model.materials()[s.material].reference_fissile_atoms;
            regions[s.region]
                .2
                .push((x, scales[x], s.production_reference_per_s / atoms));
        }
        let rods = joined.rods().ok_or("no rod owner")?;
        let t = joined.offsets().rods + rods.structure().outputs[0][0];
        let mut probe = Self {
            hot,
            cold,
            regions,
            reference_events: 1.,
            travel: (t, scales[t]),
        };
        let events = probe.events(reference);
        if !(events.is_finite() && events > 0.) {
            return Err(format!("the reference fission rate {events}"));
        }
        probe.reference_events = events;
        Ok(probe)
    }
    fn temperature(c: &Cell, y: &[f64]) -> Result<f64, String> {
        let v = |k: usize| y[c.0[k].0] * c.0[k].1;
        let (p, m, u) = (v(0), v(1), v(2));
        let point = If97.caloric(false, p, u / m, false)?;
        Ok(If97.values(&point).temperature_k)
    }
    /// The loops' mean Tavg, K.
    pub fn tavg_k(&self, y: &[f64]) -> Result<f64, String> {
        let mut sum = 0.;
        for k in 0..2 {
            sum +=
                0.5 * (Self::temperature(&self.hot[k], y)? + Self::temperature(&self.cold[k], y)?);
        }
        Ok(sum / 2.)
    }
    fn events(&self, y: &[f64]) -> f64 {
        self.regions
            .iter()
            .map(|(n, s, supports)| {
                y[*n]
                    * s
                    * supports
                        .iter()
                        .map(|(x, xs, p)| y[*x] * xs * p)
                        .sum::<f64>()
            })
            .sum()
    }
    /// The fission rate as a fraction of the hot reference's.
    pub fn nuclear(&self, y: &[f64]) -> f64 {
        self.events(y) / self.reference_events
    }
    /// The bank's travel, m.
    pub fn travel_m(&self, y: &[f64]) -> f64 {
        y[self.travel.0] * self.travel.1
    }
}

/// The measurands at one frame: Tavg (K), load, nuclear power, travel (m).
type Inputs = [f64; 4];

/// The AUTO rod controller as a frame-driver client.
pub struct RodClient {
    pub class: Class,
    pub controller: Controller,
    pub probe: Probe,
    /// The turbine's prepared admitted steam, kg/s.
    pub nominal_steam_kg_s: f64,
    /// The last frame's instant, measurands and lagged channels
    /// (Tavg, load, position; nuclear power is unlagged).
    pub at: f64,
    pub inputs: Inputs,
    pub lagged: [f64; 3],
    /// The admitted steam fraction the last `sample` read.
    pub load: f64,
    pub engaged: bool,
    pub in_force_m_s: f64,
    /// R4-ROD-DELAY (judgement, lead 1 Nov): the rate decided at the last
    /// frame, which acts one frame later (sample at k, act at k + 1).
    pub decided_m_s: Option<f64>,
    pub scratch: Vec<f64>,
    /// Per frame: the delivered evidence and the decision.
    pub series: Vec<Value>,
    /// The requested rate changes, `(t, m/s)`.
    pub schedule: Vec<(f64, f64)>,
}

impl RodClient {
    fn deliver(&self) -> Evidence {
        let q = self.controller.law().section().tavg_quantum_k;
        Evidence {
            tavg_k: (self.lagged[0] / q).round() * q,
            load: self.lagged[1],
            nuclear: self.inputs[2],
            position_m: self.lagged[2],
        }
    }
}

impl<S: JoinedSystem> Client<S> for RodClient {
    fn name(&self) -> &str {
        "LD01 automatic rod control (X4.4)"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn sample(&mut self, _k: u64, t: f64, system: &S) -> Result<(), String> {
        let joined = &system.integrated().joined;
        let steam = joined
            .secondary()
            .and_then(|s| s.admitted_steam_kg_s(t))
            .ok_or("rod control needs the SG owner's admitted steam")?;
        self.load = steam / self.nominal_steam_kg_s;
        self.engaged = joined
            .rods()
            .ok_or("rod control needs the rod owner")?
            .drive()
            .is_some();
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        dense.derivative(t, 0, &mut self.scratch)?;
        let y = &self.scratch;
        let now: Inputs = [
            self.probe.tavg_k(y)?,
            self.load,
            self.probe.nuclear(y),
            self.probe.travel_m(y),
        ];
        let h = t - self.at;
        if !(h.is_finite() && h >= 0.) {
            return Err(format!("rod control frame at {t} s after {} s", self.at));
        }
        let s = self.controller.law().section().clone();
        for (j, (k_in, tau)) in [(0, s.tavg_lag_s), (1, s.load_lag_s), (3, s.position_lag_s)]
            .into_iter()
            .enumerate()
        {
            self.lagged[j] = lag(self.lagged[j], self.inputs[k_in], now[k_in], h, tau);
        }
        self.inputs = now;
        self.at = t;
        let evidence = self.deliver();
        let mut out = Vec::new();
        let decision: Option<Decision> = if self.engaged {
            // R4-ROD-DELAY (judgement, lead 1 Nov: rod control's signal
            // processing lags far more than one 0.1 s frame): the rate
            // decided at frame k-1 acts now; this frame's decision acts at
            // k+1, so the integrator knows one frame ahead where it changes.
            let acting = self.decided_m_s;
            let d = self
                .controller
                .frame(h, &evidence)
                .map_err(|e| format!("{e:?}"))?;
            self.decided_m_s = Some(d.rate_m_s);
            if let Some(rate) = acting.filter(|r| *r != self.in_force_m_s) {
                out.push(Change {
                    due_s: t,
                    class: self.class,
                    kind: "rod drive rate (AUTO)".into(),
                    action: Action::Held(Box::new(move |s: &mut S| {
                        s.integrated_mut()
                            .joined
                            .rods_mut()
                            .ok_or("no rod owner")?
                            .set_drive(t, Some(rate))
                            .map(|_| ())
                            .map_err(|f| format!("{f:?}"))
                    })),
                });
                self.in_force_m_s = rate;
                self.schedule.push((t, rate));
            }
            Some(d)
        } else {
            self.in_force_m_s = 0.;
            self.decided_m_s = None;
            None
        };
        self.series.push(
            json!({"k": k, "t_s": t, "tavg_raw_k": now[0], "evidence": evidence,
            "decision": decision, "engaged": self.engaged, "rate_m_s": self.in_force_m_s}),
        );
        Ok(out)
    }
    fn stop_at_frame(&self, _k: u64) -> bool {
        // R4-ROD-DELAY: frame k's rate is the one decided at k-1.
        self.engaged
            && self.class == Class::S
            && self.decided_m_s.is_some_and(|r| r != self.in_force_m_s)
    }
    fn stop_by_next_frame(&self, _k: u64) -> bool {
        // The decision at frame k acts at k+1.
        self.engaged && self.class == Class::S
    }
}

/// Commissioning at the unit's start `t0` (before the driver starts): the
/// probe, the full-power Tavg at `reference`, the channels at the start
/// state, the controller on the first evidence, and the drive engaged at
/// rest in the rod owner (no row changes: a driven class at rate zero has a
/// held one's rows).
pub fn commission<S: JoinedSystem<Properties = If97>>(
    system: &mut S,
    section: &Section,
    ids: &[String],
    class: Class,
    t0: f64,
    y: &[f64],
    reference: &[f64],
) -> Result<(RodClient, Value), String> {
    let joined = &system.integrated().joined;
    let probe = Probe::new(joined, ids, reference)?;
    let full_power = probe.tavg_k(reference)?;
    let law = Law::new(section, full_power).map_err(|e| format!("{e:?}"))?;
    let steam = joined
        .secondary()
        .and_then(|s| s.admitted_steam_kg_s(t0))
        .ok_or("rod control needs the SG owner's admitted steam")?;
    if !(steam.is_finite() && steam > 0.) {
        return Err(format!("the prepared admitted steam {steam} kg/s"));
    }
    let inputs: Inputs = [probe.tavg_k(y)?, 1., probe.nuclear(y), probe.travel_m(y)];
    let mut client = RodClient {
        class,
        controller: Controller::new(
            law.clone(),
            &Evidence {
                tavg_k: inputs[0],
                load: 1.,
                nuclear: inputs[2],
                position_m: inputs[3],
            },
        )
        .map_err(|e| format!("{e:?}"))?,
        probe,
        nominal_steam_kg_s: steam,
        at: t0,
        inputs,
        lagged: [inputs[0], 1., inputs[3]],
        load: 1.,
        engaged: true,
        in_force_m_s: 0.,
        decided_m_s: None,
        scratch: vec![0.; y.len()],
        series: Vec::new(),
        schedule: Vec::new(),
    };
    let engaged = system
        .integrated_mut()
        .joined
        .rods_mut()
        .ok_or("no rod owner")?
        .set_drive(t0, Some(0.))
        .map_err(|e| format!("engage the rate drive: {e:?}"))?;
    client.engaged = true;
    let receipt = json!({"section": section, "full_power_tavg_k": full_power, "no_load_tavg_k": section.no_load_tavg_k,
        "start": {"tavg_k": inputs[0], "tref_k": law.tref_k(1.), "nuclear": inputs[2], "travel_m": inputs[3]},
        "nominal_admitted_steam_kg_s": steam, "class": class.name(), "engaged": engaged.receipt,
        "channels": {"tavg": {"hot": HOT, "cold": COLD, "rule": "IF97 at each cell's pressure and specific internal energy; loop mean of hot and cold, mean of loops"},
            "load": "the SG owner's admitted turbine steam over its prepared value (excludes the bypass)",
            "nuclear": "fission rate over the prepared hot reference's (S3-D7 total-events form)",
            "position": "the bank's travel (BANK.POS)"}});
    Ok((client, receipt))
}

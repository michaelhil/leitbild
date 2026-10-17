//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! The SG secondary owner of the joined spine ([`Secondary`]).
//!
//! Per SG, in this order: differential total water mass `M` and internal
//! energy `U`; algebraic pressure `p` and liquid volume `V_l` on the selected
//! bulk-equilibrium saturated chart; one differential lift per relief valve.
//! Rows sit at their coordinate, in physical units: `M' - (feed - steam -
//! relief)` (kg/s), `U' - (Q + feed h_feed - (steam + relief) h_g(p))` (W),
//! `M - chart_M(p, V_l)` (kg), `U - chart_U(p, V_l)` (J) and the lift lags
//! (1/s). Heat `Q` is the actual metal-to-secondary heat the joined solids
//! deliver from the same evaluation; this block adds no heat law.
//!
//! The steam leaves at the constant A/B demand through the pickup gas at
//! `h_g(p)`; after the manual turbine TRIP the demand ramps linearly to zero
//! over the stop valve's travel (G2). From the TRIP on, the bypass's no-load
//! pressure mode (owner R12-B1, the G1 stand-in) also passes
//! `fraction × demand × u(p)` per SG at `h_g(p)`, `u` linear from 0 at the
//! no-load pressure to 1 one band width above it; it is not turbine
//! admission, and the account counts it in the SG's steam port. The reliefs discharge the same gas
//! through the existing equilibrium-nozzle restriction, `lift x area x G`,
//! with the area derived once from the rating by that same law. The feed
//! equals steam plus relief outflow at the recorded state's IF97 enthalpy
//! (F3 (a)), so the mass row reads `M' = 0` exactly. No fixed heat removal,
//! imposed SG pressure or temperature, `Q/h_fg` mass source or clipped `V_l`.
//!
//! Roots: each valve's crack, full-lift, reseat and seat thresholds, armed
//! only by the valve state that owns them and otherwise a constant +1 (a
//! disarmed root never crosses), so the root count never changes. After the
//! guards, the bypass band's two kinks (no-load pressure and full opening),
//! armed from the TRIP on: a crossing changes no state. A closing
//! disc seats at its declared seat lift: the transaction sets the lift to
//! exactly zero and the seated valve has neither flow nor nozzle evaluation
//! until crack reopens it. Then the crown's first
//! uncovery and the pickup's first coverage. A guard crossing is an S2 domain
//! exit, refused fatally and never clipped. A Newton trial beyond the pickup
//! edge evaluates the gas-only pickup as a declared trial extension, so the
//! crossing step can be taken and located; it is never admitted.
use super::{
    packet,
    relief::{Branch, Characteristic, Threshold, Transition, Valve},
};
use crate::{
    joined::{
        block::{
            Class, Command, Coordinates, Crossing, Layout, OwnerAccount, Secondary, SecondaryView,
            Structure, Transaction, restored_time, snapshot_object, snapshot_time,
        },
        packet::SecondaryStock,
    },
    network::{self, Failure, stratified},
    thermal::{Saturation, Scalar, WaterProperties},
};
use serde::Serialize;
use serde_json::json;

/// The two property boundaries this owner reads: the thermal laws' current
/// value/direction boundary and the network's caloric inverse (the nozzle).
pub trait Properties: WaterProperties + network::Properties {}
impl<T: WaterProperties + network::Properties> Properties for T {}

/// Offsets within one SG's coordinates.
pub const MASS: usize = 0;
pub const ENERGY: usize = 1;
pub const PRESSURE: usize = 2;
pub const LIQUID_VOLUME: usize = 3;
pub const LIFTS: usize = 4;
/// Thresholds of every valve, in root order.
pub const THRESHOLDS: [Threshold; 4] = [
    Threshold::Crack,
    Threshold::FullLift,
    Threshold::Reseat,
    Threshold::Seat,
];
/// A prepared valve: seated on the ascending branch.
pub const SEATED: Valve = Valve::SEATED;
/// Value of a root its branch does not arm: it never crosses zero.
pub const DISARMED: f64 = 1.;
/// Per SG, after the guards: the bypass band's start and full opening.
pub const BYPASS_ROOTS: usize = 2;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(reason.into())
}
fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.
}

#[derive(Clone, Debug, Serialize)]
pub struct SteamGenerator {
    pub id: String,
    pub volume_m3: f64,
    pub steam_demand_kg_s: f64,
    pub crown_liquid_volume_m3: f64,
    pub pickup_liquid_volume_m3: f64,
    pub valves: Vec<String>,
    /// First own coordinate.
    pub base: usize,
}

/// Quantities derived once from a selection and the runtime law.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Derived {
    pub feed_enthalpy_j_kg: f64,
    pub relief_area_m2: f64,
    /// Rating-point nozzle flux per unit effective area, kg/(m² s).
    pub rating_flux_kg_m2_s: f64,
    pub rating_throat_pa: f64,
    pub rating_choked: bool,
    /// The runtime saturation temperature at the compiled no-load pressure
    /// (R12-B1), checked against the designed no-load temperature.
    pub no_load_saturation_k: f64,
}

/// One SG's boundary flows of the last `rows` evaluation, with directions.
#[derive(Clone, Debug)]
pub struct Boundary {
    /// All steam leaving through the pickup: turbine admission plus bypass.
    pub steam_kg_s: Scalar,
    /// The bypass stand-in's part of `steam_kg_s` (R12-B1).
    pub bypass_kg_s: Scalar,
    pub relief_kg_s: Vec<Scalar>,
    pub feed_kg_s: Scalar,
    pub steam_enthalpy_j_kg: Scalar,
    pub heat_w: Scalar,
    pub targets: Vec<Scalar>,
    /// Nozzle flux per unit effective area, when any lift is not exactly zero.
    pub relief_flux_kg_m2_s: Option<Scalar>,
    /// Net receipts entering `M` and `U`.
    pub mass_receipt_kg_s: Scalar,
    pub energy_receipt_w: Scalar,
}

/// One exact nozzle evaluation: the value at bitwise-identical inputs, and
/// its partials once a direction needs them. Reused only for identical bits.
#[derive(Clone, Copy, Debug)]
struct Nozzle {
    key: [u64; 3],
    value: f64,
    held: Option<stratified::HeldFlux>,
}

#[derive(Clone, Debug)]
pub struct Secondaries {
    sgs: Vec<SteamGenerator>,
    /// One characteristic per valve position (R12-B2: relief, safety).
    reliefs: Vec<Characteristic>,
    back_pressure_pa: f64,
    stop_travel_s: f64,
    /// The bypass no-load pressure mode (R12-B1).
    bypass: packet::Bypass,
    derived: Derived,
    layout: Layout,
    prepared: Vec<f64>,
    valves: Vec<Vec<Valve>>,
    trip_s: Option<f64>,
    /// S3-D12 (ELEC hook): the recorded feed flows only while the feed
    /// pumps are supplied; `true` in the prepared state (S1/S2 unchanged).
    feed_supported: bool,
    /// S3-D27: the feed gate is declared (the mass rows' structure covers
    /// the gate closed); set before the structure is compiled.
    feed_gate_declared: bool,
    /// Largest relative chart defect of the supplied preparation.
    preparation_defect: f64,
    saturation: Vec<Option<([u64; 2], Saturation)>>,
    nozzle: Vec<Option<Nozzle>>,
    boundary: Vec<Boundary>,
}

/// The selected saturated chart: `M = V_l rho_f + (V - V_l) rho_g` and
/// `U = V_l rho_f u_f + (V - V_l) rho_g u_g`, `u = h - p/rho` of the same
/// saturation call.
pub fn chart(v: f64, vl: Scalar, p: Scalar, sat: &Saturation) -> (Scalar, Scalar) {
    let (rf, rg) = (sat.liquid.density, sat.vapor.density);
    let uf = sat.liquid.enthalpy - p / rf;
    let ug = sat.vapor.enthalpy - p / rg;
    let vg = s(v) - vl;
    (vl * rf + vg * rg, vl * rf * uf + vg * rg * ug)
}

impl Secondaries {
    /// Compile the section once against the joined packet's prepared stocks
    /// (`thermal.secondaries`, same order and identities). Every valve starts
    /// closed on the ascending branch, which the prepared pressure must admit;
    /// no trip is latched.
    pub fn new<P: Properties>(
        section: &packet::Section,
        stocks: &[SecondaryStock],
        props: &P,
    ) -> Result<Self, Failure> {
        let (mut sgs, reliefs) = compile(section)?;
        let derived = derive(section, props)?;
        if stocks.len() != sgs.len() {
            return Err(fatal("one prepared stock per SG"));
        }
        let mut layout = Layout::default();
        let mut prepared = Vec::new();
        let mut defect: f64 = 0.;
        for (g, x) in sgs.iter_mut().zip(stocks) {
            if x.id != g.id || x.volume_m3 != g.volume_m3 {
                return Err(fatal(format!(
                    "prepared stock {} ({} m³) is not SG.{} ({} m³)",
                    x.id, x.volume_m3, g.id, g.volume_m3
                )));
            }
            if !(positive(x.mass_kg)
                && x.energy_j.is_finite()
                && x.energy_j != 0.
                && positive(x.pressure_pa)
                && x.liquid_volume_m3 > g.crown_liquid_volume_m3
                && x.liquid_volume_m3 < g.pickup_liquid_volume_m3
                && reliefs.iter().all(|r| r.admits(SEATED, x.pressure_pa, 0.)))
            {
                return Err(fatal(format!(
                    "SG.{} preparation is not a two-phase start inside the guards below full lift",
                    g.id
                )));
            }
            let sat = WaterProperties::saturation(props, s(x.pressure_pa))
                .map_err(|e| fatal(format!("SG.{} preparation saturation: {e}", g.id)))?;
            let (m, u) = chart(g.volume_m3, s(x.liquid_volume_m3), s(x.pressure_pa), &sat);
            defect = defect
                .max(((m.value - x.mass_kg) / x.mass_kg).abs())
                .max(((u.value - x.energy_j) / x.energy_j).abs());
            g.base = prepared.len();
            let id = &g.id;
            let (ms, us) = (x.mass_kg, x.energy_j.abs());
            layout.push(format!("SG.{id}.M_s"), Class::SecondaryStock, true, ms, ms);
            layout.push(format!("SG.{id}.U_s"), Class::SecondaryStock, true, us, us);
            layout.push(
                format!("SG.{id}.p_s"),
                Class::SecondaryChart,
                false,
                x.pressure_pa,
                ms,
            );
            layout.push(
                format!("SG.{id}.V_l"),
                Class::SecondaryChart,
                false,
                g.volume_m3,
                us,
            );
            prepared.extend([x.mass_kg, x.energy_j, x.pressure_pa, x.liquid_volume_m3]);
            for v in &g.valves {
                layout.push(format!("{v}.lift"), Class::ReliefLift, true, 1., 1.);
                prepared.push(0.);
            }
        }
        // The same formulation must have prepared these stocks: IF97 against
        // IAPWS-95 already differs by about 7e-6 in mass at 6 MPa.
        if defect.is_nan() || defect > 1e-9 {
            return Err(fatal(format!(
                "prepared SG stocks are off the runtime chart by {defect} (relative)"
            )));
        }
        layout.validate("secondary")?;
        let n = sgs.len();
        Ok(Self {
            valves: sgs.iter().map(|g| vec![SEATED; g.valves.len()]).collect(),
            boundary: sgs
                .iter()
                .map(|g| Boundary {
                    steam_kg_s: s(0.),
                    bypass_kg_s: s(0.),
                    relief_kg_s: vec![s(0.); g.valves.len()],
                    feed_kg_s: s(0.),
                    steam_enthalpy_j_kg: s(0.),
                    heat_w: s(0.),
                    targets: vec![s(0.); g.valves.len()],
                    relief_flux_kg_m2_s: None,
                    mass_receipt_kg_s: s(0.),
                    energy_receipt_w: s(0.),
                })
                .collect(),
            sgs,
            reliefs,
            back_pressure_pa: section.relief.back_pressure_pa,
            stop_travel_s: section.steam_admission.stop_travel_s,
            bypass: section.bypass.clone(),
            derived,
            layout,
            prepared,
            trip_s: None,
            feed_supported: true,
            feed_gate_declared: false,
            preparation_defect: defect,
            saturation: vec![None; n],
            nozzle: vec![None; n],
        })
    }

    /// Prepared stocks on the runtime chart at a pressure and liquid volume,
    /// in the section's order: the selected hot preparation for isolated
    /// probes. The joined operator takes its stocks from the thermal section.
    pub fn stocks_at<P: Properties>(
        section: &packet::Section,
        props: &P,
        pressure_pa: f64,
        liquid_volume_m3: f64,
    ) -> Result<Vec<SecondaryStock>, Failure> {
        let sat = WaterProperties::saturation(props, s(pressure_pa))
            .map_err(|e| fatal(format!("SG preparation saturation: {e}")))?;
        Ok(section
            .steam_generators
            .iter()
            .map(|g| {
                let (m, u) = chart(g.volume_m3, s(liquid_volume_m3), s(pressure_pa), &sat);
                SecondaryStock {
                    id: g.id.clone(),
                    pressure_pa,
                    temperature_k: sat.temperature.value,
                    liquid_volume_m3,
                    volume_m3: g.volume_m3,
                    mass_kg: m.value,
                    energy_j: u.value,
                }
            })
            .collect())
    }

    pub fn steam_generators(&self) -> &[SteamGenerator] {
        &self.sgs
    }
    pub fn derived(&self) -> Derived {
        self.derived
    }
    /// Valve position `valve`'s characteristic (R12-B2).
    pub fn relief(&self, valve: usize) -> Characteristic {
        self.reliefs[valve]
    }
    pub fn back_pressure_pa(&self) -> f64 {
        self.back_pressure_pa
    }
    pub fn preparation_defect(&self) -> f64 {
        self.preparation_defect
    }
    pub fn valve(&self, sg: usize, valve: usize) -> Valve {
        self.valves[sg][valve]
    }
    /// Declare one valve's state for a supplied start; it must agree with
    /// the rule at that pressure (Pa) and lift.
    pub fn set_valve(
        &mut self,
        sg: usize,
        valve: usize,
        state: Valve,
        p_pa: f64,
        lift: f64,
    ) -> Result<(), Failure> {
        if !self.reliefs[valve].admits(state, p_pa, lift) {
            return Err(fatal(format!(
                "SG.{} relief {valve}: {state:?} contradicts the rule at {p_pa} Pa, lift {lift}",
                self.sgs[sg].id
            )));
        }
        self.valves[sg][valve] = state;
        Ok(())
    }
    /// Valves whose disc is seated.
    pub fn seated(&self) -> usize {
        self.valves.iter().flatten().filter(|v| v.seated).count()
    }
    /// The latched manual turbine TRIP time, if any.
    pub fn trip_time(&self) -> Option<f64> {
        self.trip_s
    }
    /// End of the STOP ramp, the time event the harness stops at.
    pub fn ramp_end(&self) -> Option<f64> {
        self.trip_s.map(|t| t + self.stop_travel_s)
    }
    /// Steam admission fraction at `t`: 1 at power; after the TRIP the STOP's
    /// linear travel to zero.
    pub fn steam_fraction(&self, t: f64) -> f64 {
        match self.trip_s {
            None => 1.,
            Some(t0) if t <= t0 => 1.,
            Some(t0) => (1. - (t - t0) / self.stop_travel_s).max(0.),
        }
    }
    /// The bypass stand-in's opening at `t` and SG pressure `p` (R12-B1):
    /// zero before the TRIP, then linear from the no-load pressure over one
    /// band width, closed below and fully open above.
    pub fn bypass_opening(&self, t: f64, p: Scalar) -> Scalar {
        if !self.trip_s.is_some_and(|t0| t >= t0) {
            return s(0.);
        }
        let b = &self.bypass;
        let u = (p - s(b.no_load_pressure_pa)) / s(b.band_width_pa);
        if u.value <= 0. {
            s(0.)
        } else if u.value >= 1. {
            s(1.)
        } else {
            u
        }
    }
    /// The bypass parameters (R12-B1).
    pub fn bypass(&self) -> &packet::Bypass {
        &self.bypass
    }
    /// Boundary flows of the last `rows` evaluation, per SG.
    pub fn boundaries(&self) -> &[Boundary] {
        &self.boundary
    }

    /// Accepted-state admission, separate from trial evaluation (physical
    /// own coordinates): positive inventory, a liquid volume inside the S2
    /// guards, nonnegative lifts and memories the rule admits.
    pub fn validate_accepted(&self, y: &[f64]) -> Result<(), Failure> {
        if y.len() != self.layout.len() {
            return Err(fatal("secondary accepted-state layout"));
        }
        for (k, g) in self.sgs.iter().enumerate() {
            let b = g.base;
            let (m, p, vl) = (y[b + MASS], y[b + PRESSURE], y[b + LIQUID_VOLUME]);
            let lifts = &y[b + LIFTS..b + LIFTS + g.valves.len()];
            if !(positive(m) && vl > g.crown_liquid_volume_m3 && vl < g.pickup_liquid_volume_m3)
                || lifts.iter().any(|l| !(l.is_finite() && *l >= 0.))
                || (0..g.valves.len())
                    .any(|j| !self.reliefs[j].admits(self.valves[k][j], p, lifts[j]))
            {
                return Err(fatal(format!(
                    "SG.{} accepted state refused: M {m} kg, p {p} Pa, V_l {vl} m³, lifts {lifts:?}",
                    g.id
                )));
            }
        }
        Ok(())
    }

    fn saturation_at<P: Properties>(
        &mut self,
        props: &P,
        k: usize,
        p: Scalar,
    ) -> Result<Saturation, Failure> {
        let key = [p.value.to_bits(), p.direction.to_bits()];
        if let Some((held, sat)) = self.saturation[k]
            && held == key
        {
            return Ok(sat);
        }
        self.saturation[k] = None;
        let sat = WaterProperties::saturation(props, p)
            .map_err(|e| recoverable(format!("SG.{} saturation: {e}", self.sgs[k].id)))?;
        self.saturation[k] = Some((key, sat));
        Ok(sat)
    }

    /// The relief nozzle flux per unit effective area from the pickup gas at
    /// `(p, h_g(p))` to the receiver. Its partials are evaluated only when a
    /// lift with nonzero value carries a direction; a zero lift multiplies
    /// the flux direction by zero.
    fn relief_flux<P: Properties>(
        &mut self,
        props: &P,
        k: usize,
        p: Scalar,
        h: Scalar,
        partials: bool,
    ) -> Result<Scalar, Failure> {
        let back = s(self.back_pressure_pa);
        let key = [p.value.to_bits(), h.value.to_bits(), back.value.to_bits()];
        let slot = match self.nozzle[k] {
            Some(n) if n.key == key => n,
            _ => {
                self.nozzle[k] = None;
                let f = stratified::restriction_flux(props, true, s(p.value), s(h.value), back)?;
                Nozzle {
                    key,
                    value: f.mass_flux.value,
                    held: None,
                }
            }
        };
        let slot = match (partials, slot.held) {
            (true, None) => {
                let held =
                    stratified::restriction_partials(props, true, p.value, h.value, back.value)?;
                if held.mass_flux.to_bits() != slot.value.to_bits() {
                    return Err(fatal("relief nozzle value depends on its direction"));
                }
                Nozzle {
                    held: Some(held),
                    ..slot
                }
            }
            _ => slot,
        };
        self.nozzle[k] = Some(slot);
        Ok(match (partials, slot.held) {
            (true, Some(held)) => held.at(p, h, back).mass_flux,
            _ => s(slot.value),
        })
    }

    fn root_index(&self, sg: usize, valve: usize, threshold: usize) -> usize {
        let per = THRESHOLDS.len();
        let before: usize = self.sgs[..sg]
            .iter()
            .map(|g| per * g.valves.len() + 2 + BYPASS_ROOTS)
            .sum();
        before + per * valve + threshold
    }
}

impl<P: Properties> Secondary<P> for Secondaries {
    fn layout(&self) -> &Layout {
        &self.layout
    }
    // ELEC S3 hooks (SG owner): the turbine's admitted steam, the trip time
    // and the S3-D12 feed gate.
    fn admitted_steam_kg_s(&self, t: f64) -> Option<f64> {
        let fraction = self.steam_fraction(t);
        Some(
            self.sgs
                .iter()
                .map(|g| g.steam_demand_kg_s * fraction)
                .sum(),
        )
    }
    fn turbine_trip_time(&self) -> Option<f64> {
        self.trip_s
    }
    fn set_feed_supported(&mut self, supported: bool) -> Result<(), Failure> {
        if !supported && !self.feed_gate_declared {
            return Err(fatal(
                "S3-D27: the feed gate closes only when declared before the structure is compiled (Joined::declare_feed_gate)",
            ));
        }
        self.feed_supported = supported;
        Ok(())
    }
    fn declare_feed_gate(&mut self) -> Result<(), Failure> {
        self.feed_gate_declared = true;
        Ok(())
    }
    fn feed_gate_declared(&self) -> bool {
        self.feed_gate_declared
    }
    fn account(&self) -> OwnerAccount {
        let h_feed = self.derived.feed_enthalpy_j_kg;
        let mut crossings = Vec::new();
        for (k, (g, b)) in self.sgs.iter().zip(&self.boundary).enumerate() {
            let hg = b.steam_enthalpy_j_kg.value;
            let relief: f64 = b.relief_kg_s.iter().map(|m| m.value).sum();
            for (port, mass, enthalpy) in [
                ("feed", b.feed_kg_s.value, h_feed),
                ("steam", -b.steam_kg_s.value, hg),
                ("relief", -relief, hg),
            ] {
                crossings.push(Crossing {
                    port: format!("SG.{}.{port}", g.id),
                    volume: k,
                    mass_kg_s: mass,
                    energy_w: mass * enthalpy,
                    tracer_kg_s: 0.,
                });
            }
        }
        OwnerAccount {
            mechanical_j: 0.,
            mechanical_rate_w: 0.,
            crossings,
            received_heat_w: self.boundary.iter().map(|b| b.heat_w.value).collect(),
            power: None,
        }
    }
    fn prepared(&self) -> Vec<f64> {
        self.prepared.clone()
    }
    fn differential(&self) -> Vec<f64> {
        self.layout.ids()
    }
    // S5 snapshot hook (PLATFORM, claude/ld01-s5-host; KERN reconciles):
    // the latched TRIP time and every valve's branch, seat and closing state.
    fn discrete_state(&self) -> serde_json::Value {
        json!({
            "trip_s": snapshot_time(self.trip_s),
            "feed_supported": self.feed_supported,
            "valves": self.valves.iter().map(|sg| sg.iter().map(|v| json!({
                "branch": match v.branch { Branch::Ascending => "ascending", Branch::Descending => "descending" },
                "seated": v.seated, "closing": v.closing,
            })).collect::<Vec<_>>()).collect::<Vec<_>>(),
        })
    }
    fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure> {
        let o = snapshot_object(state, "secondary", &["trip_s", "feed_supported", "valves"])?;
        let trip_s = restored_time(&o["trip_s"])?;
        let feed_supported = o["feed_supported"]
            .as_bool()
            .ok_or_else(|| fatal("secondary snapshot: feed_supported"))?;
        if !feed_supported && !self.feed_gate_declared {
            return Err(fatal(
                "secondary snapshot: a closed feed gate into an owner that declares none (S3-D27)",
            ));
        }
        let sgs = o["valves"]
            .as_array()
            .filter(|a| a.len() == self.valves.len())
            .ok_or_else(|| fatal("secondary snapshot: valves per SG"))?;
        let mut valves = self.valves.clone();
        for (k, sg) in sgs.iter().enumerate() {
            let list = sg
                .as_array()
                .filter(|a| a.len() == valves[k].len())
                .ok_or_else(|| fatal(format!("secondary snapshot: SG {k} valve count")))?;
            for (j, v) in list.iter().enumerate() {
                let f = snapshot_object(v, "secondary valve", &["branch", "seated", "closing"])?;
                let flag = |key: &str| {
                    f[key]
                        .as_bool()
                        .ok_or_else(|| fatal(format!("secondary snapshot: valve {key}")))
                };
                valves[k][j] = Valve {
                    branch: match f["branch"].as_str() {
                        Some("ascending") => Branch::Ascending,
                        Some("descending") => Branch::Descending,
                        other => {
                            return Err(fatal(format!("secondary snapshot: branch {other:?}")));
                        }
                    },
                    seated: flag("seated")?,
                    closing: flag("closing")?,
                };
            }
        }
        self.trip_s = trip_s;
        self.feed_supported = feed_supported;
        self.valves = valves;
        Ok(())
    }
    fn next_time_event(&self, t: f64) -> Option<f64> {
        self.ramp_end().filter(|end| *end > t)
    }
    fn time_event(&mut self, _: &P, t: f64, _: &mut [f64]) -> Result<Option<Transaction>, Failure> {
        // The STOP ramp ends: the admission law's kink, no state change, so
        // a repeated call at the same instant changes nothing either.
        Ok((self.ramp_end() == Some(t)).then(|| Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"secondary","t_s":t,"event":"STOP ramp end",
                "steamAdmission":"zero from here (STOP closed)","stateChanged":false}),
        }))
    }
    fn generators(&self) -> usize {
        self.sgs.len()
    }

    fn views(
        &mut self,
        props: &P,
        x: Coordinates<'_>,
        out: &mut [SecondaryView],
    ) -> Result<(), Failure> {
        if x.len() != self.layout.len() || out.len() != self.sgs.len() {
            return Err(fatal("secondary view layout"));
        }
        for (k, view) in out.iter_mut().enumerate() {
            let (b, v) = (self.sgs[k].base, self.sgs[k].volume_m3);
            let p = x.value(b + PRESSURE);
            let vl = x.value(b + LIQUID_VOLUME);
            if !(p.value > 0. && p.value.is_finite()) {
                return Err(recoverable(format!(
                    "SG.{} pressure trial {}",
                    self.sgs[k].id, p.value
                )));
            }
            let sat = self.saturation_at(props, k, p)?;
            *view = SecondaryView {
                pressure: p,
                saturation_temperature: sat.temperature,
                liquid_volume: vl,
                steam_present: vl.value < v,
            };
        }
        Ok(())
    }

    fn rows(
        &mut self,
        props: &P,
        t: f64,
        x: Coordinates<'_>,
        heat_w: &[Scalar],
        rows: &mut [Scalar],
    ) -> Result<(), Failure> {
        if x.len() != self.layout.len()
            || rows.len() != self.layout.len()
            || heat_w.len() != self.sgs.len()
            || !t.is_finite()
        {
            return Err(fatal("secondary row layout"));
        }
        let fraction = self.steam_fraction(t);
        for (k, heat) in heat_w.iter().enumerate() {
            let g = self.sgs[k].clone();
            let b = g.base;
            let (mass, energy) = (x.value(b + MASS), x.value(b + ENERGY));
            let (p, vl) = (x.value(b + PRESSURE), x.value(b + LIQUID_VOLUME));
            if !(p.value > 0. && p.value.is_finite()) {
                return Err(recoverable(format!(
                    "SG.{} pressure trial {}",
                    g.id, p.value
                )));
            }
            if !(vl.value >= 0. && vl.value <= g.volume_m3) {
                return Err(recoverable(format!(
                    "SG.{} liquid volume trial {} leaves the saturated chart; a pure phase needs its exhaustion transaction",
                    g.id, vl.value
                )));
            }
            let sat = self.saturation_at(props, k, p)?;
            let (chart_mass, chart_energy) = chart(g.volume_m3, vl, p, &sat);
            let hg = sat.vapor.enthalpy;
            rows[b + PRESSURE] = mass - chart_mass;
            rows[b + LIQUID_VOLUME] = energy - chart_energy;
            // R12-B1: the bypass stand-in joins the turbine admission.
            let bypass = s(self.bypass.fraction_of_nominal_steam * g.steam_demand_kg_s)
                * self.bypass_opening(t, p);
            let steam = s(g.steam_demand_kg_s * fraction) + bypass;
            let lifts: Vec<Scalar> = (0..g.valves.len())
                .map(|j| x.value(b + LIFTS + j))
                .collect();
            // A seated disc has no flow: its lift enters nothing but its row.
            let lifted: Vec<bool> = self.valves[k].iter().map(|v| !v.seated).collect();
            let flux = if lifts
                .iter()
                .zip(&lifted)
                .any(|(l, on)| *on && (l.value != 0. || l.direction != 0.))
            {
                let partials = lifts
                    .iter()
                    .zip(&lifted)
                    .any(|(l, on)| *on && l.value != 0.)
                    && (p.direction != 0. || hg.direction != 0.);
                Some(self.relief_flux(props, k, p, hg, partials)?)
            } else {
                None
            };
            let mut relief = s(0.);
            let report = &mut self.boundary[k];
            for (j, lift) in lifts.iter().enumerate() {
                let valve = self.valves[k][j];
                let m = match flux {
                    Some(f) if !valve.seated => *lift * s(self.derived.relief_area_m2) * f,
                    _ => s(0.),
                };
                relief = relief + m;
                report.relief_kg_s[j] = m;
                report.targets[j] = self.reliefs[j].target(valve.branch, p);
                rows[b + LIFTS + j] =
                    x.rate(b + LIFTS + j) - self.reliefs[j].lift_rate(valve, p, *lift);
            }
            // F3 (a): the feed is exactly the withdrawn gas; x - x is exact.
            // S3-D12: gated to zero while the feed pumps are unsupplied.
            let withdrawn = steam + relief;
            let feed = if self.feed_supported {
                withdrawn
            } else {
                s(0.)
            };
            let mass_receipt = feed - withdrawn;
            let energy_receipt = *heat + feed * s(self.derived.feed_enthalpy_j_kg) - withdrawn * hg;
            rows[b + MASS] = x.rate(b + MASS) - mass_receipt;
            rows[b + ENERGY] = x.rate(b + ENERGY) - energy_receipt;
            report.steam_kg_s = steam;
            report.bypass_kg_s = bypass;
            report.feed_kg_s = feed;
            report.steam_enthalpy_j_kg = hg;
            report.heat_w = *heat;
            report.relief_flux_kg_m2_s = flux;
            report.mass_receipt_kg_s = mass_receipt;
            report.energy_receipt_w = energy_receipt;
        }
        if rows
            .iter()
            .any(|r| !(r.value.is_finite() && r.direction.is_finite()))
        {
            return Err(recoverable("nonfinite SG secondary row"));
        }
        Ok(())
    }

    fn structure(&self) -> Structure {
        let n = self.layout.len();
        let mut own = vec![Vec::new(); n];
        let mut heat = vec![Vec::new(); n];
        let mut outputs = Vec::new();
        for (k, g) in self.sgs.iter().enumerate() {
            let b = g.base;
            let lifts: Vec<usize> = (b + LIFTS..b + LIFTS + g.valves.len()).collect();
            // The inventory-holding feed cancels the withdrawal exactly; a
            // declared feed gate (S3-D27) may close, and the withdrawal then
            // reads the pressure and the relief lifts (structural zeros
            // while the gate is open).
            own[b + MASS] = if self.feed_gate_declared {
                let mut mass = vec![b + MASS, b + PRESSURE];
                mass.extend(&lifts);
                mass
            } else {
                vec![b + MASS]
            };
            let mut energy = vec![b + ENERGY, b + PRESSURE];
            energy.extend(&lifts);
            own[b + ENERGY] = energy;
            heat[b + ENERGY] = vec![k];
            own[b + PRESSURE] = vec![b + MASS, b + PRESSURE, b + LIQUID_VOLUME];
            own[b + LIQUID_VOLUME] = vec![b + ENERGY, b + PRESSURE, b + LIQUID_VOLUME];
            for i in lifts {
                own[i] = vec![b + PRESSURE, i];
            }
            outputs.push(vec![b + PRESSURE, b + LIQUID_VOLUME]);
        }
        for o in &mut own {
            o.sort_unstable();
        }
        Structure {
            own,
            cells: vec![Vec::new(); n],
            faces: vec![Vec::new(); n],
            heat,
            receipts: Vec::new(),
            volumes: Vec::new(),
            outputs,
        }
    }

    fn root_count(&self) -> usize {
        self.sgs
            .iter()
            .map(|g| THRESHOLDS.len() * g.valves.len() + 2 + BYPASS_ROOTS)
            .sum()
    }

    fn roots(
        &mut self,
        _props: &P,
        _t: f64,
        x: Coordinates<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure> {
        if x.len() != self.layout.len() || out.len() != Secondary::<P>::root_count(self) {
            return Err(fatal("secondary root layout"));
        }
        let mut i = 0;
        for (k, g) in self.sgs.iter().enumerate() {
            let p = x.value(g.base + PRESSURE).value;
            let vl = x.value(g.base + LIQUID_VOLUME).value;
            for j in 0..g.valves.len() {
                let armed = Characteristic::armed(self.valves[k][j]);
                let lift = x.value(g.base + LIFTS + j).value;
                for threshold in THRESHOLDS {
                    out[i] = if armed.contains(&threshold) {
                        self.reliefs[j].root(threshold, p, lift)
                    } else {
                        DISARMED
                    };
                    i += 1;
                }
            }
            out[i] = vl - g.crown_liquid_volume_m3;
            out[i + 1] = vl - g.pickup_liquid_volume_m3;
            i += 2;
            // R12-B1: the bypass band's kinks, armed from the TRIP on.
            let armed = self.trip_s.is_some();
            let (p0, w) = (self.bypass.no_load_pressure_pa, self.bypass.band_width_pa);
            out[i] = if armed { p - p0 } else { DISARMED };
            out[i + 1] = if armed { p - (p0 + w) } else { DISARMED };
            i += BYPASS_ROOTS;
        }
        if out.iter().any(|v| !v.is_finite()) {
            return Err(fatal("nonfinite SG root"));
        }
        Ok(())
    }

    /// Each armed relief threshold reports only the crossing its valve's
    /// memory acts on ([`Characteristic::direction`]); the crown and pickup
    /// guards report both (either crossing is a domain exit).
    fn root_directions(&self, out: &mut [i32]) -> Result<(), Failure> {
        if out.len() != Secondary::<P>::root_count(self) {
            return Err(fatal("secondary root direction layout"));
        }
        let mut i = 0;
        for (k, g) in self.sgs.iter().enumerate() {
            for j in 0..g.valves.len() {
                for threshold in THRESHOLDS {
                    out[i] = Characteristic::direction(self.valves[k][j], threshold);
                    i += 1;
                }
            }
            out[i] = 0;
            out[i + 1] = 0;
            out[i + 2] = 0;
            out[i + 3] = 0;
            i += 2 + BYPASS_ROOTS;
        }
        Ok(())
    }

    fn transact(
        &mut self,
        _props: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure> {
        if directions.len() != Secondary::<P>::root_count(self) || y.len() != self.layout.len() {
            return Err(fatal("secondary transaction layout"));
        }
        let mut events = Vec::new();
        let mut seats = 0;
        for k in 0..self.sgs.len() {
            let g = self.sgs[k].clone();
            let p = y[g.base + PRESSURE];
            for j in 0..g.valves.len() {
                let start = self.valves[k][j];
                for (m, threshold) in THRESHOLDS.into_iter().enumerate() {
                    let d = directions[self.root_index(k, j, m)];
                    if d == 0 {
                        continue;
                    }
                    let current = self.valves[k][j];
                    if !Characteristic::armed(current).contains(&threshold) {
                        // A simultaneous crossing an earlier transition of this
                        // transaction disarmed (a reseat that already seated).
                        if Characteristic::armed(start).contains(&threshold) {
                            events.push(
                                json!({"valve":g.valves[j],"threshold":threshold,"direction":d,
                                "superseded":true,"state":current}),
                            );
                            continue;
                        }
                        return Err(fatal(format!(
                            "{} {threshold:?} root crossed while disarmed",
                            g.valves[j]
                        )));
                    }
                    let lift = y[g.base + LIFTS + j];
                    let x: Transition = self.reliefs[j]
                        .transition(current, threshold, d, lift)
                        .map_err(fatal)?;
                    self.valves[k][j] = x.after;
                    if x.seated_from_lift.is_some() {
                        // The disc rests on its seat: exactly zero lift.
                        y[g.base + LIFTS + j] = 0.;
                        seats += 1;
                    }
                    events.push(
                        json!({"valve":g.valves[j],"threshold":threshold,"direction":d,
                        "before":x.before,"after":x.after,"pressure_Pa":p,"lift":lift,
                        "seatedFromLift":x.seated_from_lift}),
                    );
                }
            }
            let guard = self.root_index(k, g.valves.len(), 0);
            for (offset, name) in [(0, "crown first uncovery"), (1, "pickup first coverage")] {
                if directions[guard + offset] != 0 {
                    return Err(fatal(format!(
                        "S2 domain exit (unsupported): SG.{} {name} at t = {t} s, V_l = {} m³",
                        g.id,
                        y[g.base + LIQUID_VOLUME]
                    )));
                }
            }
            // R12-B1: a bypass kink is a located crossing with no state change.
            for (offset, name) in [(2, "bypass band start"), (3, "bypass full opening")] {
                let d = directions[guard + offset];
                if d != 0 {
                    events.push(json!({"bypass": format!("SG.{}", g.id), "threshold": name,
                        "direction": d, "pressure_Pa": p}));
                }
            }
        }
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"secondary","t_s":t,"relief":events,"seats":seats,
                "stateChanged":seats > 0}),
        })
    }

    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure> {
        match command {
            // G7's stuck cluster is the rod owner's malfunction; the steam
            // demand is untouched (the turbine TRIP that follows ramps it).
            Command::StuckCluster { .. } => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"secondary","command":"StuckCluster","t_s":t,
                    "steamDemand":"unchanged (a rod malfunction)"}),
            }),
            // C3's RCP supply loss is the network's; the steam demand is
            // untouched.
            Command::SupplyLoss { rotor } => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"secondary","command":"SupplyLoss","rotor":rotor,"t_s":t,
                    "steamDemand":"unchanged (an RCP supply loss)"}),
            }),
            // HOOK (C4 lane): C4's relief malfunction is the PZR owner's;
            // the steam demand is untouched.
            Command::ReliefStuckOpen => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"secondary","command":"ReliefStuckOpen","t_s":t,
                    "steamDemand":"unchanged (a PZR relief malfunction)"}),
            }),
            // G7: the steam demand stays at its constant A/B values.
            Command::ManualReactorTrip => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"secondary","command":"ManualReactorTrip","t_s":t,
                    "steamDemand":"held at the constant A/B values (G7, declared boundary)"}),
            }),
            // S3 (C16): the holding loss is not the
            // steam owner's; the steam demand is unchanged by it.
            Command::HoldingLoss => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"secondary","command":"HoldingLoss","t_s":t,
                    "steamDemand":"unchanged (the holding circuit is not the steam owner's)"}),
            }),
            Command::TurbineTrip | Command::TurbineTripAcquired => {
                if let Some(t0) = self.trip_s {
                    return Err(fatal(format!(
                        "the manual turbine TRIP is already latched since {t0} s"
                    )));
                }
                if !t.is_finite() {
                    return Err(fatal("turbine TRIP time"));
                }
                self.trip_s = Some(t);
                Ok(Transaction {
                    deposits: Vec::new(),
                    receipt: json!({"owner":"secondary","command":command,"t_s":t,
                        "stopTravel_s":self.stop_travel_s,"rampEnd_s":t + self.stop_travel_s,
                        "steamDemand_kg_s":self.sgs.iter().map(|g| g.steam_demand_kg_s).collect::<Vec<_>>()}),
                })
            }
        }
    }
}

/// Validate the section's shapes and selections.
fn compile(
    section: &packet::Section,
) -> Result<(Vec<SteamGenerator>, Vec<Characteristic>), Failure> {
    let r = &section.relief;
    if !(r.seat_lag_time_constants.is_finite() && r.seat_lag_time_constants > 0.) {
        return Err(fatal(
            "SG relief seat needs a positive number of lag time constants",
        ));
    }
    let reliefs = r
        .valves
        .iter()
        .map(|v| {
            Characteristic::new(
                v.crack_pressure_pa,
                v.full_lift_pressure_pa,
                v.reseat_pressure_pa,
                r.lift_lag_s,
                (-r.seat_lag_time_constants).exp(),
            )
            .map_err(fatal)
        })
        .collect::<Result<Vec<_>, _>>()?;
    // R12-B2: the relief below the safety valve (AP1000: between no-load
    // pressure and the lowest safety set, DCD 10.3.2.2.3), the safety
    // valve opening at or below the declared design pressure, and every full
    // lift inside 110 % of it (DCD 10.3.2.2.2).
    let roles: Vec<packet::ValveRole> = r.valves.iter().map(|v| v.role).collect();
    let (relief, safety) = match roles.as_slice() {
        [packet::ValveRole::Relief, packet::ValveRole::Safety] => (r.valves[0], r.valves[1]),
        _ => return Err(fatal("SG valves: one relief, then one safety valve")),
    };
    if !(positive(r.design_pressure_pa)
        && relief.crack_pressure_pa < safety.crack_pressure_pa
        && safety.crack_pressure_pa <= r.design_pressure_pa
        && r.valves
            .iter()
            .all(|v| v.full_lift_pressure_pa <= 1.1 * r.design_pressure_pa))
    {
        return Err(fatal(
            "SG valves: relief below the safety valve, safety at or below design, full lifts within 110 % of design",
        ));
    }
    // R12-B1 with R12-B2: the bypass opens fully below the relief.
    let b = &section.bypass;
    if !(b.no_load_pressure_pa + b.band_width_pa < relief.crack_pressure_pa) {
        return Err(fatal("SG bypass full opening must lie below the relief crack"));
    }
    if !(positive(r.back_pressure_pa)
        && r.valves.iter().all(|v| r.back_pressure_pa < v.reseat_pressure_pa))
        || r.descending_switch != packet::DescendingSwitch::InletAtFullLift
        || r.rating.fluid != packet::RatingFluid::SaturatedVapor
        || !(positive(r.rating.mass_flow_kg_s) && r.rating.inlet_pressure_pa > r.back_pressure_pa)
    {
        return Err(fatal("SG relief receiver, branch switch or rating"));
    }
    let f = &section.feed;
    if f.rule != packet::FeedRule::InventoryHolding
        || !(positive(f.pressure_pa) && positive(f.temperature_k))
        || !positive(section.steam_admission.stop_travel_s)
    {
        return Err(fatal("SG feed boundary or steam admission travel"));
    }
    let b = &section.bypass;
    if b.mode != packet::BypassMode::NoLoadPressureAfterTurbineTrip
        || ![b.no_load_average_temperature_k, b.no_load_pressure_pa, b.band_width_pa]
            .into_iter()
            .all(positive)
        || !(b.fraction_of_nominal_steam > 0. && b.fraction_of_nominal_steam <= 1.)
    {
        return Err(fatal("SG bypass no-load mode"));
    }
    let c = &section.contact;
    if ![
        c.exchange_area_m2,
        c.steel_conductivity_w_mk,
        c.steel_density_kg_m3,
        c.steel_cp_j_kgk,
    ]
    .into_iter()
    .all(positive)
        || !(c.emissivity > 0. && c.emissivity <= 1.)
    {
        return Err(fatal("SG contact exchange area or wall constants"));
    }
    if section.steam_generators.is_empty() {
        return Err(fatal("no steam generator"));
    }
    let mut sgs: Vec<SteamGenerator> = Vec::new();
    for g in &section.steam_generators {
        if sgs.iter().any(|h| h.id == g.id) {
            return Err(fatal(format!("duplicate SG {}", g.id)));
        }
        if !(positive(g.volume_m3)
            && g.steam_demand_kg_s.is_finite()
            && g.steam_demand_kg_s >= 0.
            && positive(g.crown_liquid_volume_m3)
            && g.crown_liquid_volume_m3 < g.pickup_liquid_volume_m3
            && g.pickup_liquid_volume_m3 < g.volume_m3)
        {
            return Err(fatal(format!("SG.{} volume, demand or guards", g.id)));
        }
        let mut valves: Vec<String> = Vec::new();
        for v in &g.reliefs {
            if valves.contains(&v.id) || sgs.iter().any(|h| h.valves.contains(&v.id)) {
                return Err(fatal(format!("duplicate relief {}", v.id)));
            }
            valves.push(v.id.clone());
        }
        if valves.len() != reliefs.len() {
            return Err(fatal(format!(
                "SG.{} has {} valves, the settings {}",
                g.id,
                valves.len(),
                reliefs.len()
            )));
        }
        sgs.push(SteamGenerator {
            id: g.id.clone(),
            volume_m3: g.volume_m3,
            steam_demand_kg_s: g.steam_demand_kg_s,
            crown_liquid_volume_m3: g.crown_liquid_volume_m3,
            pickup_liquid_volume_m3: g.pickup_liquid_volume_m3,
            valves,
            base: 0,
        });
    }
    Ok((sgs, reliefs))
}

/// The feed enthalpy at the recorded state and each valve's effective area
/// from its rating with the runtime nozzle law, once.
fn derive<P: Properties>(section: &packet::Section, props: &P) -> Result<Derived, Failure> {
    let f = &section.feed;
    let feed = network::Properties::forward(props, false, f.pressure_pa, f.temperature_k)
        .map_err(|e| fatal(format!("SG feed state: {e}")))?;
    let r = &section.relief;
    let inlet = s(r.rating.inlet_pressure_pa);
    let sat = WaterProperties::saturation(props, inlet)
        .map_err(|e| fatal(format!("SG relief rating saturation: {e}")))?;
    let flux = stratified::restriction_flux(
        props,
        true,
        inlet,
        s(sat.vapor.enthalpy.value),
        s(r.back_pressure_pa),
    )
    .map_err(|e| fatal(format!("SG relief rating flux: {e:?}")))?;
    if !positive(flux.mass_flux.value) || !feed.enthalpy_j_kg.is_finite() {
        return Err(fatal("SG derived feed enthalpy or relief flux"));
    }
    // R12-B1: the compiled no-load pressure is the saturation pressure at
    // the designed no-load temperature, by the runtime law (1 mK).
    let b = &section.bypass;
    let no_load = WaterProperties::saturation(props, s(b.no_load_pressure_pa))
        .map_err(|e| fatal(format!("SG bypass no-load saturation: {e}")))?
        .temperature
        .value;
    if !((no_load - b.no_load_average_temperature_k).abs() <= 1e-3) {
        return Err(fatal(format!(
            "SG bypass no-load pressure {} Pa saturates at {no_load} K, not the no-load {} K",
            b.no_load_pressure_pa, b.no_load_average_temperature_k
        )));
    }
    Ok(Derived {
        feed_enthalpy_j_kg: feed.enthalpy_j_kg,
        relief_area_m2: r.rating.mass_flow_kg_s / flux.mass_flux.value,
        rating_flux_kg_m2_s: flux.mass_flux.value,
        rating_throat_pa: flux.throat_pressure_pa.value,
        rating_choked: flux.choked,
        no_load_saturation_k: no_load,
    })
}

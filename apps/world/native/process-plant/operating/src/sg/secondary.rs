//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#compact-apparent-level-allocation-c08-15-october-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/equipment.md#pressure-and-nominal-flow-allocation
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#compact-feed-train-plan-r4-31-october-2026
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
//! over the stop valve's travel (G2). After the trip the bypass (the G1
//! stand-in) also passes `fraction × demand × u` per SG at `h_g(p)`; it is
//! not turbine admission, and the account counts it in the SG's steam port.
//! With forced circulation (R4-DUMP, owner 1 Nov) `u` is the Tavg mode's
//! demand, common to every SG: `u = clamp((T_lag - T_nl - b) / w, 0, 1)` on
//! the CVCS's loop-average lag `T_lag`, a trial input the joined operator
//! sets before every evaluation. It arms at the later of the reactor trip
//! and the turbine trip (lead's judgement, 7 Nov): armed at the reactor trip
//! alone, a rod trip's worst frame reached 1.27. With no RCP
//! supplied (a held input the routing sets at its restarts) `u` is R12-B1's
//! no-load pressure mode from the turbine trip on, linear from 0 at the
//! no-load pressure to 1 one band width above it. The reliefs discharge the same gas
//! through the existing equilibrium-nozzle restriction, `lift x area x G`,
//! with the area derived once from the rating by that same law. The feed
//! equals steam plus relief outflow at the recorded state's IF97 enthalpy
//! (F3 (a)), so the mass row reads `M' = 0` exactly. No fixed heat removal,
//! imposed SG pressure or temperature, `Q/h_fg` mass source or clipped `V_l`.
//!
//! **Apparent level (C08; packet `apparentLevel`, absent in S1-S3, whose
//! coordinates, rows and roots stay bitwise).** Each SG appends after its
//! lifts an algebraic vapor mass `M_v` with `M_v - rho_g(p) (V - V_l)` (kg),
//! a differential distribution `beta` with `beta' - (beta_eq - beta) /
//! tau_distribution` (1/s) and an algebraic submerged volume `V_sub` with
//! `V_sub - beta (V - V_l)` (m³); `beta_eq = min(V_g, V_sub,max,
//! tau_residence m_evap / rho_g) / V_g`, `m_evap = max(0, M_v' + steam +
//! relief)`, `tau_residence = V_sub,nom rho_g(p_nom) / F_nom` derived once.
//! They carry no mass or energy and no other row reads them; the apparent
//! level `(V_l + V_sub) / A` is what the NR channels acquire. The law's
//! `max` and `min` corners are continuous and **not located** (lead, plan
//! r4: no restart for an observed quantity's kink).
//!
//! **Compact feed train (packet `feedTrain`, only with the apparent
//! level).** It replaces F3 (a): the mass row is the real balance `M' =
//! feed - steam - relief` and the feed enters at the recorded feed
//! enthalpy. After every SG's coordinates: the algebraic header pressure
//! with `p_H - (p_suct + dp0 (r - (r - 1) q²) - k_e Q²)` (Pa), both pumps
//! at rated speed sharing `Q = Σ m`, `q = Q / (2 m0)`, `k_e` the entry loss
//! at `2 m0`; per SG the algebraic branch flow with `m - m0 u sqrt(dp /
//! (a_iso u² + a_fcv u_ref²))` (kg/s), `dp = p_H - p_SG`, the fixed/ISO
//! path's drop `a_iso` and the FCV's `a_fcv` at `m0` and `u_ref`. Then per
//! SG the continuous three-element control (`control::feed`, owner 31
//! October 2026): differential NR1, FT.STEAM and FW.FT lags, both
//! integrals and the FCV stem `u' = clamp((u_d - u) / tau_stem, ±stroke)`,
//! so no control change stops the integrator. In AUTO the NR1 lag's span
//! edges are roots: leaving the span withdraws AUTO to HOLD at the demand
//! in force (integrals frozen). The S3-D12 gate, when it closes, zeroes the
//! delivered feed only (pump coastdown not modelled).
//!
//! Roots: each valve's crack, full-lift, reseat and seat thresholds, armed
//! only by the valve state that owns them and otherwise a constant +1 (a
//! disarmed root never crosses), so the root count never changes. After the
//! guards, the pressure mode's two kinks (no-load pressure and full
//! opening), armed from the TRIP on without forced circulation: a crossing
//! changes no state. After the feed roots, the Tavg mode's two common kinks
//! (opening start and full opening), armed once both trips are received
//! with forced circulation, likewise. A closing
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
    control::feed::{Law as FeedLaw, Mode},
    joined::{
        block::{
            Class, Command, Coordinates, Crossing, Layout, OwnerAccount, Secondary, SecondaryView,
            Structure, Transaction, restored_time, snapshot_bits, snapshot_object, snapshot_time,
        },
        packet::SecondaryStock,
    },
    network::{self, Failure, stratified},
    thermal::{Number, Saturation, Scalar, WaterProperties},
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
/// Offsets of the C08 coordinates after one SG's lifts.
pub const VAPOR: usize = 0;
pub const DISTRIBUTION: usize = 1;
pub const SUBMERGED: usize = 2;
/// C08 coordinates per SG.
pub const APPARENT_COORDINATES: usize = 3;
/// Offset of the feed header after every SG's coordinates; branch `k`
/// follows at `HEADER + 1 + k`.
pub const HEADER: usize = 0;
/// Per SG after the branches: the continuous control's coordinates.
pub const CONTROL: usize = 8;
pub const NR_LAG: usize = 0;
pub const STEAM_LAG: usize = 1;
pub const FEED_LAG: usize = 2;
pub const OUTER: usize = 3;
pub const INNER: usize = 4;
pub const STEM: usize = 5;
/// The startup-feed stand-in's integral and valve.
pub const SF_INTEGRAL: usize = 6;
pub const SF_STEM: usize = 7;
/// Feed roots per SG: NR1 lag at the span's low and high edge (AUTO), the
/// startup stand-in's start (stopped) and isolation (running) levels.
pub const FEED_ROOTS: usize = 4;
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
/// R4-DUMP: after every other root, the Tavg mode's opening start and full
/// opening (common to every SG).
pub const TAVG_ROOTS: usize = 2;

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

/// The C08 distribution law's selections and its residence time, derived
/// once on the runtime law from the nominal reference.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Apparent {
    pub residence_s: f64,
    pub maximum_submerged_m3: f64,
    pub distribution_s: f64,
    pub prepared_distribution: f64,
    pub area_m2: f64,
}

/// The distribution law at one state, with directions.
#[derive(Clone, Copy, Debug)]
pub struct Law {
    /// `M_v' + steam + relief`: the net phase change before the clamp.
    pub raw: Scalar,
    pub evaporation: Scalar,
    /// `tau_residence m_evap / rho_g`.
    pub held_m3: Scalar,
    /// `min(V_g, V_sub,max)`.
    pub cap_m3: Scalar,
    pub beta_eq: Scalar,
}

impl Apparent {
    /// The law at the vapor mass rate, the withdrawn pickup gas, the vapor
    /// density and the gas volume (pure steam: `vbar_steam = 1/rho_g`).
    /// Each corner is continuous in value; none is located.
    pub fn law(&self, vapor_rate: Scalar, withdrawn: Scalar, rho_g: Scalar, gas_m3: Scalar) -> Law {
        let raw = vapor_rate + withdrawn;
        let evaporation = if raw.value > 0. { raw } else { s(0.) };
        let held_m3 = s(self.residence_s) * evaporation / rho_g;
        let cap_m3 = if gas_m3.value < self.maximum_submerged_m3 {
            gas_m3
        } else {
            s(self.maximum_submerged_m3)
        };
        let target = if held_m3.value < cap_m3.value {
            held_m3
        } else {
            cap_m3
        };
        Law {
            raw,
            evaporation,
            held_m3,
            cap_m3,
            beta_eq: target / gas_m3,
        }
    }
}

/// One SG's controller mode and the demand a HOLD keeps.
#[derive(Clone, Copy, Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FeedMode {
    pub mode: Mode,
    #[serde(with = "snapshot_bits")]
    pub held: f64,
    pub startup: Startup,
}

/// The startup-feed stand-in's state per SG.
#[derive(Clone, Copy, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum Startup {
    Stopped,
    Running,
    Isolated,
}

/// The compact feed train, compiled once (pressures in Pa, flows in kg/s).
#[derive(Clone, Debug)]
pub struct FeedOwner {
    pub train: packet::FeedTrain,
    /// First feed coordinate (the header), own index.
    pub base: usize,
    /// Nominal pump pressure rise `dp0` at `m0`.
    pub pump_rise_pa: f64,
    /// Header-entry loss coefficient `k_e` (Pa per (kg/s)²).
    pub entry_coefficient: f64,
    /// Fixed/ISO-path and FCV drops at `m0` (FCV at its reference opening).
    pub iso_drop_pa: f64,
    pub fcv_drop_pa: f64,
    /// The prepared MANUAL opening per SG: the opening that delivers its
    /// steam demand at its prepared pressure (the S4-D6 rule).
    pub prepared_opening: Vec<f64>,
    /// The startup stand-in's capacity per SG (kg/s) and the tank
    /// water's enthalpy (J/kg), derived once.
    pub startup_capacity_kg_s: f64,
    pub startup_enthalpy_j_kg: f64,
    pub modes: Vec<FeedMode>,
    /// The SG count (control coordinates follow the branches).
    pub sgs: usize,
}

impl FeedOwner {
    /// First control coordinate of SG `k`, own index.
    pub fn control(&self, k: usize) -> usize {
        self.base + HEADER + 1 + self.sgs + CONTROL * k
    }
    /// SG `k`'s law at its control coordinates (`c`: lags, integrals) in
    /// its current mode: AUTO's, or HOLD/MANUAL at the held demand.
    pub fn law(&self, k: usize, c: [Scalar; 5]) -> FeedLaw {
        match self.modes[k].mode {
            Mode::Auto => {
                self.train
                    .cascade
                    .auto(self.train.nominal_flow_kg_s, c[0], c[1], c[2], c[3], c[4])
            }
            Mode::Hold | Mode::Manual => FeedLaw {
                request: s(0.),
                demand: s(self.modes[k].held),
                outer_rate: s(0.),
                inner_rate: s(0.),
            },
        }
    }
    /// SG `k`'s startup stand-in: its valve demand and integral rate at the
    /// NR1 lag and its integral. Running: the outer loop's law on level
    /// alone (request `KpL eL + IS` in units of `m0`, the valve demand that
    /// request over the capacity, clamped), back-calculation over `KpL/KiL`;
    /// stopped or isolated: demand zero, integral held.
    pub fn startup_law(&self, k: usize, level: Scalar, integral: Scalar) -> (Scalar, Scalar) {
        if self.modes[k].startup != Startup::Running {
            return (s(0.), s(0.));
        }
        let c = &self.train.cascade;
        let [lo, hi] = c.narrow_span_m;
        let el = s(c.level_setpoint) - (level - s(lo)) / s(hi - lo);
        let scale = self.train.nominal_flow_kg_s / self.startup_capacity_kg_s;
        let unsat = (s(c.outer_proportional) * el + integral) * s(scale);
        let d = if unsat.value < 0. {
            s(0.)
        } else if unsat.value > 1. {
            s(1.)
        } else {
            unsat
        };
        let back = (d - unsat) / s(scale) * s(c.outer_integral_per_s / c.outer_proportional);
        (d, s(c.outer_integral_per_s) * el + back)
    }
    /// The channel lags' operator-grade absolute tolerances, as `(own
    /// index, physical tolerance)`: each a quarter of its channel's
    /// uncertainty (`ld01-feed-compact`, `ld01-operator-budgets` r2). The
    /// integrals and valves keep the stock floor (loosening them failed C2
    /// at the last rod seat, 1 November).
    pub fn operator_tolerances(&self) -> Vec<(usize, f64)> {
        let t = self.train.operator_tolerances;
        let mut out = Vec::new();
        for k in 0..self.sgs {
            let c = self.control(k);
            out.extend([
                (c + NR_LAG, t.nr_level_m),
                (c + STEAM_LAG, t.flow_kg_s),
                (c + FEED_LAG, t.flow_kg_s),
            ]);
        }
        out
    }
    /// The stem rate toward demand `d` at position `u`.
    pub fn stem_rate(&self, d: Scalar, u: Scalar) -> Scalar {
        let r = (d - u) / s(self.train.stem_time_constant_s);
        let v = self.train.fcv_stroke_per_second;
        if r.value > v {
            s(v)
        } else if r.value < -v {
            s(-v)
        } else {
            r
        }
    }
    /// Header pressure the pumps hold at total flow `q_total`.
    pub fn header_pa(&self, q_total: Scalar) -> Scalar {
        let m0 = self.train.nominal_flow_kg_s;
        let r = self.train.shutoff_head_ratio;
        let q = q_total / s(2. * m0);
        s(self.train.suction_pressure_pa) + s(self.pump_rise_pa) * (s(r) - s(r - 1.) * q * q)
            - s(self.entry_coefficient) * q_total * q_total
    }
    /// Branch flow at opening `u` and drop `dp` (Pa, positive).
    pub fn branch_kg_s(&self, u: Scalar, dp: Scalar) -> Scalar {
        let ur = self.train.fcv_reference_opening;
        let den = s(self.iso_drop_pa) * u * u + s(self.fcv_drop_pa * ur * ur);
        s(self.train.nominal_flow_kg_s) * u * (dp / den).pow(0.5)
    }
    /// The opening that passes `m` at drop `dp` (the inverse of
    /// [`FeedOwner::branch_kg_s`]).
    pub fn opening_for(&self, m: f64, dp: f64) -> Option<f64> {
        let (m0, ur) = (
            self.train.nominal_flow_kg_s,
            self.train.fcv_reference_opening,
        );
        let x = m / m0;
        let den = dp - x * x * self.iso_drop_pa;
        (den > 0.).then(|| x * (self.fcv_drop_pa * ur * ur / den).sqrt())
    }
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
    /// X4.4 preview (lane ROD): the turbine load demand, a fraction of the
    /// prepared steam demand (1 as prepared; the turbine valve is X4.3's).
    turbine_load: f64,
    /// X4.3 (lane TURB): the turbine admission valve's choked law and the
    /// at-power bypass band, when the electrical slice's governor is composed.
    valve: Option<ValveAdmission>,
    /// Per SG, the side of each bypass kink its last located crossing left
    /// (`true` above), unset from the TRIP until the first crossing. A set
    /// side arms only the reverse crossing, so a restart that puts the
    /// pressure back a hair across the kink does not fire it again.
    bypass_side: Vec<[Option<bool>; 2]>,
    /// R4-DUMP: the reactor trip (the holding circuit's opening), once
    /// received; with the TRIP it arms the Tavg mode.
    reactor_trip_s: Option<f64>,
    /// R4-DUMP: whether any RCP is supplied (the routing's held input;
    /// `true` as prepared). Without it the bypass is in R12-B1's pressure
    /// mode.
    forced_circulation: bool,
    /// R4-DUMP: the CVCS's loop-average channel is composed (the joined
    /// operator declares it); the Tavg mode refuses at the reactor trip
    /// without it.
    loop_average_declared: bool,
    /// R4-DUMP: the loop-average lag of the evaluation that follows (K) and
    /// its seed direction, set by the joined operator before every
    /// evaluation that reads it.
    loop_average: Option<(f64, f64)>,
    /// R4-DUMP: the side of each Tavg kink its last located crossing left
    /// (`true` above), unset from the arming until the first crossing.
    tavg_side: [Option<bool>; 2],
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
    /// C08: the apparent-level allocation, when the packet composes it.
    apparent: Option<Apparent>,
    /// The compact feed train, when the packet composes it.
    feed: Option<FeedOwner>,
}

/// X4.3 (lane TURB; spec admission-and-protection.md `ld01-bypass-control`,
/// turbine-and-regeneration-dynamics.md X4.3): the turbine admission valve's
/// choked law and the at-power bypass band, declared by the composition with
/// the electrical slice's governor.
/// - Admission per SG: `m_k = a * c_k(t) * p_k`, `c_k = D_k * f_STOP(t) /
///   p_ref,k`: proportional to the valve opening `a` (the slice's coordinate,
///   1 = full open, the prepared MANUAL position) and to the inlet pressure.
///   **Judgement (lead, 1 Nov):** the SG dome pressure stands in for the
///   header/HP inlet until C10's header store joins; the law is sized at the
///   prepared SG pressure `p_ref,k`, so the prepared opening passes the
///   prepared demand there.
/// - The opening is a trial input: the slice sets it from its coordinate
///   before every evaluation (`direction` 1 only for the admission column).
/// - At power the bypass stays closed (lead ruling, x43-5: a PWR's at-power
///   dump is the Tavg-mode load-rejection dump, armed only on a load
///   rejection beyond the rods, which 1.0 does not have, CRED I14); after
///   the trip the post-trip modes (R4-DUMP / R12-B1).
#[derive(Clone, Debug)]
pub struct ValveAdmission {
    reference_pa: Vec<f64>,
    opening: f64,
    direction: f64,
}

/// Steam admission fraction at `t` after a TRIP latched at `trip_s`: 1 at
/// power; after the TRIP the STOP's linear travel to zero over `travel_s`.
pub fn steam_fraction(trip_s: Option<f64>, travel_s: f64, t: f64) -> f64 {
    match trip_s {
        None => 1.,
        Some(t0) if t <= t0 => 1.,
        Some(t0) => (1. - (t - t0) / travel_s).max(0.),
    }
}
/// The pressure mode's opening (R12-B1, without forced circulation): zero
/// before the TRIP, then linear from the no-load pressure over one band
/// width.
pub fn pressure_opening(b: &packet::Bypass, trip_s: Option<f64>, t: f64, p: Scalar) -> Scalar {
    if !trip_s.is_some_and(|t0| t >= t0) {
        return s(0.);
    }
    let u = (p - s(b.no_load_pressure_pa)) / s(b.band_width_pa);
    if u.value <= 0. {
        s(0.)
    } else if u.value >= 1. {
        s(1.)
    } else {
        u
    }
}
/// R4-DUMP: the Tavg mode's opening at loop-average lag `tavg` (K),
/// `clamp((tavg - T_nl - b) / w, 0, 1)`; both corners are located kinks.
pub fn tavg_opening(b: &packet::Bypass, tavg: Scalar) -> Scalar {
    let u =
        (tavg - s(b.no_load_average_temperature_k + b.tavg_dead_band_k)) / s(b.tavg_band_width_k);
    if u.value <= 0. {
        s(0.)
    } else if u.value >= 1. {
        s(1.)
    } else {
        u
    }
}
/// One SG's pickup steam (turbine admission plus bypass) and the bypass's
/// part at bypass opening `opening`: the owner's withdrawal law, also the
/// source of `FT.STEAM`. `load` (X4.4 preview, the turbine load demand)
/// scales the turbine admission only; the bypass stays sized on the nominal
/// demand (R12-B1).
pub fn pickup_steam(
    demand_kg_s: f64,
    travel_s: f64,
    fraction_of_nominal_steam: f64,
    opening: Scalar,
    trip_s: Option<f64>,
    load: f64,
    t: f64,
) -> (Scalar, Scalar) {
    let by = s(fraction_of_nominal_steam * demand_kg_s) * opening;
    (
        s(demand_kg_s * steam_fraction(trip_s, travel_s, t) * load) + by,
        by,
    )
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
        let apparent = section
            .apparent_level
            .as_ref()
            .map(|a| apparent(a, props))
            .transpose()?;
        if section.feed_train.is_some() && apparent.is_none() {
            return Err(fatal(
                "the compact feed train needs the apparent level (its controller reads the NR channels)",
            ));
        }
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
            if let Some(a) = apparent {
                // Scales from the prepared gas: its vapor mass and volume.
                let gas = g.volume_m3 - x.liquid_volume_m3;
                let vapor = sat.vapor.density.value * gas;
                layout.push(
                    format!("SG.{id}.M_v"),
                    Class::SecondaryVapor,
                    false,
                    vapor,
                    vapor,
                );
                layout.push(
                    format!("SG.{id}.beta"),
                    Class::SecondaryDistribution,
                    true,
                    1.,
                    1.,
                );
                layout.push(
                    format!("SG.{id}.V_sub"),
                    Class::SecondarySubmerged,
                    false,
                    gas,
                    gas,
                );
                prepared.extend([
                    vapor,
                    a.prepared_distribution,
                    a.prepared_distribution * gas,
                ]);
            }
        }
        let feed = match section.feed_train {
            None => None,
            Some(train) => {
                let mut f = feed_owner(train, &sgs, stocks, prepared.len())?;
                // The startup stand-in's capacity: the decay heat shared by
                // the SGs over the rise from the tank water to saturated
                // vapour at the no-load pressure, on the runtime law.
                let sf = train.startup;
                let p0 = section.bypass.no_load_pressure_pa;
                let tank = network::Properties::forward(props, false, p0, sf.source_temperature_k)
                    .map_err(|e| fatal(format!("startup feed tank state: {e}")))?;
                let hg = WaterProperties::saturation(props, s(p0))
                    .map_err(|e| fatal(format!("startup feed no-load saturation: {e}")))?
                    .vapor
                    .enthalpy
                    .value;
                let rise = hg - tank.enthalpy_j_kg;
                if !(positive(sf.decay_heat_w)
                    && positive(rise)
                    && sf.start_level_fraction > 0.
                    && sf.start_level_fraction < train.cascade.level_setpoint
                    && sf.isolation_level_fraction > train.cascade.level_setpoint
                    && sf.isolation_level_fraction < 1.)
                {
                    return Err(fatal("startup feed stand-in values"));
                }
                f.startup_capacity_kg_s = sf.decay_heat_w / sgs.len() as f64 / rise;
                f.startup_enthalpy_j_kg = tank.enthalpy_j_kg;
                let m0 = train.nominal_flow_kg_s;
                layout.push(
                    "FW.HEADER.p".into(),
                    Class::FeedHeader,
                    false,
                    train.header_pressure_pa,
                    train.header_pressure_pa,
                );
                let total: f64 = sgs.iter().map(|g| g.steam_demand_kg_s).sum();
                prepared.push(f.header_pa(s(total)).value);
                for g in &sgs {
                    layout.push(format!("FW.{}.m", g.id), Class::FeedBranch, false, m0, m0);
                    prepared.push(g.steam_demand_kg_s);
                }
                // The control at the tracked AUTO point of the prepared
                // state: each lag at its input, the integrals by the
                // tracking law, the stem at the prepared opening.
                let a = apparent.ok_or_else(|| fatal("the feed train needs the apparent level"))?;
                for (k, (g, x)) in sgs.iter().zip(stocks).enumerate() {
                    let id = &g.id;
                    let level = (x.liquid_volume_m3
                        + a.prepared_distribution * (g.volume_m3 - x.liquid_volume_m3))
                        / a.area_m2;
                    let m = g.steam_demand_kg_s;
                    let u = f.prepared_opening[k];
                    let (il, i_f) = train.cascade.tracked(m0, level, m, m, u)?;
                    for (label, v, scale) in [
                        ("NR1.lag", level, 1.),
                        ("FT.STEAM.lag", m, m0),
                        ("FW.FT.lag", m, m0),
                        ("IL", il, 1.),
                        ("IF", i_f, 1.),
                        ("FCV.u", u, 1.),
                        ("SF.I", 0., 1.),
                        ("SF.u", 0., 1.),
                    ] {
                        layout.push(
                            format!("FW.{id}.{label}"),
                            Class::FeedControl,
                            true,
                            scale,
                            scale,
                        );
                        prepared.push(v);
                    }
                }
                Some(f)
            }
        };
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
            turbine_load: 1.,
            valve: None,
            bypass_side: vec![[None; 2]; n],
            reactor_trip_s: None,
            forced_circulation: true,
            loop_average_declared: false,
            loop_average: None,
            tavg_side: [None; 2],
            feed_supported: true,
            feed_gate_declared: false,
            preparation_defect: defect,
            saturation: vec![None; n],
            nozzle: vec![None; n],
            apparent,
            feed,
        })
    }

    /// C08's allocation, when composed.
    pub fn apparent(&self) -> Option<Apparent> {
        self.apparent
    }
    /// First C08 coordinate of SG `k` (own index), when composed.
    pub fn apparent_base(&self, k: usize) -> Option<usize> {
        self.apparent
            .map(|_| self.sgs[k].base + LIFTS + self.sgs[k].valves.len())
    }
    /// The compact feed train, when composed.
    pub fn feed(&self) -> Option<&FeedOwner> {
        self.feed.as_ref()
    }
    /// The pickup steam of SG `k` at `t` and pressure `p`: the STOP-ramped
    /// turbine admission plus the bypass stand-in (R4-DUMP / R12-B1).
    fn pickup_steam(&self, k: usize, t: f64, p: Scalar) -> Result<(Scalar, Scalar), Failure> {
        let opening = self.bypass_opening(t, p)?;
        if let Some(v) = &self.valve {
            let by =
                s(self.bypass.fraction_of_nominal_steam * self.sgs[k].steam_demand_kg_s) * opening;
            let turbine =
                Scalar::new(v.opening, v.direction) * s(self.admission_coefficient(k, t)) * p;
            return Ok((turbine + by, by));
        }
        Ok(pickup_steam(
            self.sgs[k].steam_demand_kg_s,
            self.stop_travel_s,
            self.bypass.fraction_of_nominal_steam,
            opening,
            self.trip_s,
            self.turbine_load,
            t,
        ))
    }
    /// R4-DUMP: the instant the Tavg mode arms, the later of the reactor
    /// trip and the turbine trip, once both are received (lead's judgement,
    /// 7 Nov). With one trip alone it does not arm.
    pub fn tavg_arming(&self) -> Option<f64> {
        Some(self.reactor_trip_s?.max(self.trip_s?))
    }
    /// R4-DUMP: whether the Tavg mode is armed at `t`, with forced
    /// circulation.
    fn tavg_armed(&self, t: f64) -> bool {
        self.forced_circulation && self.tavg_arming().is_some_and(|t0| t >= t0)
    }
    /// R4-DUMP: what a trip command leaves the bypass in, for its receipt.
    fn arming_note(&self) -> &'static str {
        match (self.forced_circulation, self.tavg_arming()) {
            (false, _) => "no RCP supplied: the no-load pressure mode (R12-B1)",
            (true, Some(_)) => "Tavg mode armed (R4-DUMP): both trips received",
            (true, None) => "closed: the Tavg mode arms when both trips are received (R4-DUMP)",
        }
    }
    /// R4-DUMP: the loop-average input of this evaluation.
    fn loop_average_input(&self) -> Result<Scalar, Failure> {
        let (v, d) = self.loop_average.ok_or_else(|| {
            fatal("R4-DUMP: the Tavg mode is armed but no loop-average input was set")
        })?;
        if !v.is_finite() {
            return Err(recoverable(format!("loop-average trial {v} K")));
        }
        Ok(Scalar::new(v, d))
    }

    /// X4.3: SG `k`'s admission coefficient `c_k(t) = D_k f_STOP(t) / p_ref,k`
    /// (kg/s per Pa at full opening); zero without the valve law.
    fn admission_coefficient(&self, k: usize, t: f64) -> f64 {
        self.valve.as_ref().map_or(0., |v| {
            self.sgs[k].steam_demand_kg_s * steam_fraction(self.trip_s, self.stop_travel_s, t)
                / v.reference_pa[k]
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
    /// X4.4 preview: times the turbine load demand.
    pub fn steam_fraction(&self, t: f64) -> f64 {
        self.turbine_load * steam_fraction(self.trip_s, self.stop_travel_s, t)
    }
    /// X4.4 preview: the turbine load demand in force.
    pub fn turbine_load(&self) -> f64 {
        self.turbine_load
    }
    /// The bypass stand-in's opening at `t` and SG pressure `p`: with forced
    /// circulation the Tavg mode from its arming on (R4-DUMP), zero before
    /// it; without, the pressure mode from the TRIP on (R12-B1).
    pub fn bypass_opening(&self, t: f64, p: Scalar) -> Result<Scalar, Failure> {
        if self.forced_circulation {
            if self.tavg_armed(t) {
                return Ok(tavg_opening(&self.bypass, self.loop_average_input()?));
            }
            return Ok(s(0.));
        }
        Ok(pressure_opening(&self.bypass, self.trip_s, t, p))
    }
    /// R4-DUMP: the reactor trip, if received.
    pub fn reactor_trip(&self) -> Option<f64> {
        self.reactor_trip_s
    }
    /// R4-DUMP: whether any RCP is supplied.
    pub fn forced_circulation(&self) -> bool {
        self.forced_circulation
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
        if let Some(f) = &self.feed {
            let header = y[f.base + HEADER];
            for (k, g) in self.sgs.iter().enumerate() {
                let m = y[f.base + HEADER + 1 + k];
                let u = y[f.control(k) + STEM];
                if !(header > y[g.base + PRESSURE]
                    && m.is_finite()
                    && m >= 0.
                    && (0. ..=1.).contains(&u))
                {
                    return Err(fatal(format!(
                        "FW.{} accepted state refused: header {header} Pa, SG {} Pa, flow {m} kg/s (a closing branch check is outside the compact train)",
                        g.id,
                        y[g.base + PRESSURE]
                    )));
                }
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
    fn declare_valve_admission(&mut self) -> Result<(), Failure> {
        if self.trip_s.is_some() || self.turbine_load != 1. || self.valve.is_some() {
            return Err(fatal(
                "X4.3: the valve law is declared once, at power, without the X4.4 load stand-in",
            ));
        }
        let reference_pa: Vec<f64> = self
            .sgs
            .iter()
            .map(|g| self.prepared[g.base + PRESSURE])
            .collect();
        if reference_pa.iter().any(|p| !(p.is_finite() && *p > 0.)) {
            return Err(fatal("X4.3: a prepared SG pressure"));
        }
        self.valve = Some(ValveAdmission {
            reference_pa,
            opening: 1.,
            direction: 0.,
        });
        Ok(())
    }
    fn set_admission_opening(&mut self, opening: f64, direction: f64) -> Result<(), Failure> {
        let v = self
            .valve
            .as_mut()
            .ok_or_else(|| fatal("X4.3: no valve law declared"))?;
        if !opening.is_finite() {
            return Err(recoverable(format!("admission opening trial {opening}")));
        }
        v.opening = opening;
        v.direction = direction;
        Ok(())
    }
    fn admission_terms(&self, t: f64) -> Option<Vec<(usize, f64)>> {
        self.valve.as_ref()?;
        Some(
            self.sgs
                .iter()
                .enumerate()
                .map(|(k, g)| (g.base + PRESSURE, self.admission_coefficient(k, t)))
                .collect(),
        )
    }
    fn admission_rows(&self) -> Vec<usize> {
        if self.valve.is_none() {
            return Vec::new();
        }
        let mut rows = Vec::new();
        for (k, g) in self.sgs.iter().enumerate() {
            rows.extend([g.base + MASS, g.base + ENERGY]);
            if self.apparent.is_some() {
                rows.push(g.base + LIFTS + g.valves.len() + DISTRIBUTION);
            }
            if let Some(f) = &self.feed {
                rows.push(f.control(k) + STEAM_LAG);
            }
        }
        rows.sort_unstable();
        rows
    }
    // R4-DUMP hooks: the Tavg mode's loop-average input and the routing's
    // RCP supply.
    fn loop_average_rows(&self) -> Vec<usize> {
        let mut rows = Vec::new();
        for (k, g) in self.sgs.iter().enumerate() {
            rows.extend([g.base + MASS, g.base + ENERGY]);
            if self.apparent.is_some() {
                rows.push(g.base + LIFTS + g.valves.len() + DISTRIBUTION);
            }
            if let Some(f) = &self.feed {
                rows.push(f.control(k) + STEAM_LAG);
            }
        }
        rows.sort_unstable();
        rows
    }
    fn declare_loop_average(&mut self) -> Result<(), Failure> {
        self.loop_average_declared = true;
        Ok(())
    }
    fn set_loop_average(&mut self, value_k: f64, direction: f64) -> Result<(), Failure> {
        if !self.loop_average_declared {
            return Err(fatal(
                "R4-DUMP: a loop-average input into an owner whose channel is not declared",
            ));
        }
        self.loop_average = Some((value_k, direction));
        Ok(())
    }
    fn set_forced_circulation(&mut self, forced: bool) -> Result<(), Failure> {
        self.forced_circulation = forced;
        Ok(())
    }
    fn reactor_trip_time(&self) -> Option<f64> {
        self.reactor_trip_s
    }
    fn set_turbine_load(&mut self, t: f64, load: f64) -> Result<Transaction, Failure> {
        if self.valve.is_some() {
            return Err(fatal(
                "X4.3: the turbine valve sets the admission; no load stand-in",
            ));
        }
        if !(load.is_finite() && load >= 0.) {
            return Err(fatal(format!("turbine load demand {load}")));
        }
        if self.trip_s.is_some() {
            return Err(fatal("the turbine is tripped: no load demand change"));
        }
        let before = self.turbine_load;
        self.turbine_load = load;
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner": "secondary", "turbine_load": {"t_s": t, "before": before, "after": load,
                "basis": "X4.4 preview stand-in: the turbine admission scaled at a frame instant (the turbine valve and governor are X4.3's); the bypass stays on the nominal demand"}}),
        })
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
    fn operator_tolerances(&self) -> Vec<(usize, f64)> {
        self.feed
            .as_ref()
            .map_or_else(Vec::new, FeedOwner::operator_tolerances)
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
        let mut state = json!({
            "trip_s": snapshot_time(self.trip_s),
            "feed_supported": self.feed_supported,
            "valves": self.valves.iter().map(|sg| sg.iter().map(|v| json!({
                "branch": match v.branch { Branch::Ascending => "ascending", Branch::Descending => "descending" },
                "seated": v.seated, "closing": v.closing,
            })).collect::<Vec<_>>()).collect::<Vec<_>>(),
        });
        // X4.4 preview: the turbine load, recorded exactly when it is not the
        // prepared 1.
        if self.turbine_load != 1. {
            state["turbine_load"] = json!(format!("{:016x}", self.turbine_load.to_bits()));
        }
        // The bypass kinks' sides, only once the TRIP has armed them.
        if self.trip_s.is_some() {
            state["bypass_side"] = json!(self.bypass_side);
        }
        // R4-DUMP: the reactor trip and the Tavg kinks' sides, once
        // received; the RCP supply only when none is supplied.
        if self.reactor_trip_s.is_some() {
            state["reactor_trip_s"] = json!(snapshot_time(self.reactor_trip_s));
            state["tavg_side"] = json!(self.tavg_side);
        }
        if !self.forced_circulation {
            state["forced_circulation"] = json!(false);
        }
        // The controllers' modes, only with the feed train.
        if let Some(f) = &self.feed {
            state["feed_modes"] = json!(f.modes);
        }
        state
    }
    fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure> {
        let tripped = !state["trip_s"].is_null();
        let loaded = state.get("turbine_load").is_some();
        let reactor_tripped = state.get("reactor_trip_s").is_some();
        let unforced = state.get("forced_circulation").is_some();
        let mut keys = vec!["trip_s", "feed_supported", "valves"];
        if loaded {
            keys.push("turbine_load");
        }
        if tripped {
            keys.push("bypass_side");
        }
        if reactor_tripped {
            keys.extend(["reactor_trip_s", "tavg_side"]);
        }
        if unforced {
            keys.push("forced_circulation");
        }
        if self.feed.is_some() {
            keys.push("feed_modes");
        }
        let o = snapshot_object(state, "secondary", &keys)?;
        let bypass_side: Vec<[Option<bool>; 2]> = if tripped {
            serde_json::from_value(o["bypass_side"].clone())
                .ok()
                .filter(|v: &Vec<[Option<bool>; 2]>| v.len() == self.sgs.len())
                .ok_or_else(|| fatal("secondary snapshot: bypass_side per SG"))?
        } else {
            vec![[None; 2]; self.sgs.len()]
        };
        let modes = match &self.feed {
            None => None,
            Some(f) => {
                let modes: Vec<FeedMode> = serde_json::from_value(o["feed_modes"].clone())
                    .map_err(|e| fatal(format!("secondary snapshot: feed_modes: {e}")))?;
                if modes.len() != f.modes.len()
                    || modes.iter().any(|m| !(0. ..=1.).contains(&m.held))
                {
                    return Err(fatal(
                        "secondary snapshot: a feed mode per SG, held demand in 0..1",
                    ));
                }
                Some(modes)
            }
        };
        let trip_s = restored_time(&o["trip_s"])?;
        let (reactor_trip_s, tavg_side) = if reactor_tripped {
            let at = restored_time(&o["reactor_trip_s"])?
                .ok_or_else(|| fatal("secondary snapshot: reactor_trip_s"))?;
            let side: [Option<bool>; 2] = serde_json::from_value(o["tavg_side"].clone())
                .map_err(|e| fatal(format!("secondary snapshot: tavg_side: {e}")))?;
            (Some(at), side)
        } else {
            (None, [None; 2])
        };
        if unforced && o["forced_circulation"] != json!(false) {
            return Err(fatal(
                "secondary snapshot: forced_circulation is recorded only when false",
            ));
        }
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
        let turbine_load = if loaded {
            o["turbine_load"]
                .as_str()
                .ok_or_else(|| "not a string".to_string())
                .and_then(crate::joined::block::snapshot_bits::parse)
                .ok()
                .filter(|l| l.is_finite() && *l >= 0. && *l != 1.)
                .ok_or_else(|| fatal("secondary snapshot: turbine_load"))?
        } else {
            1.
        };
        self.trip_s = trip_s;
        self.turbine_load = turbine_load;
        self.bypass_side = bypass_side;
        self.reactor_trip_s = reactor_trip_s;
        self.tavg_side = tavg_side;
        self.forced_circulation = !unforced;
        self.feed_supported = feed_supported;
        self.valves = valves;
        if let (Some(f), Some(modes)) = (self.feed.as_mut(), modes) {
            f.modes = modes;
        }
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
            // R4-DUMP / R12-B1: the bypass stand-in joins the turbine admission.
            let (steam, bypass) = self.pickup_steam(k, t, p)?;
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
            // With the compact train: the branch's delivered flow. S3-D12:
            // gated to zero while the feed pumps are unsupplied.
            let withdrawn = steam + relief;
            let feed = match (&self.feed, self.feed_supported) {
                (_, false) => s(0.),
                (None, true) => withdrawn,
                (Some(f), true) => x.value(f.base + HEADER + 1 + k),
            };
            // The startup stand-in (onsite power): capacity x valve at the
            // tank's enthalpy, whatever the main pumps' supply.
            let startup = match &self.feed {
                Some(f) => s(f.startup_capacity_kg_s) * x.value(f.control(k) + SF_STEM),
                None => s(0.),
            };
            let startup_energy = match &self.feed {
                Some(f) => startup * s(f.startup_enthalpy_j_kg),
                None => s(0.),
            };
            let mass_receipt = feed + startup - withdrawn;
            let energy_receipt =
                *heat + feed * s(self.derived.feed_enthalpy_j_kg) + startup_energy - withdrawn * hg;
            rows[b + MASS] = x.rate(b + MASS) - mass_receipt;
            rows[b + ENERGY] = x.rate(b + ENERGY) - energy_receipt;
            if let Some(a) = self.apparent {
                // C08: no mass or energy; the withdrawn gas is the pickup's.
                let d = b + LIFTS + g.valves.len();
                let gas = s(g.volume_m3) - vl;
                let rho_g = sat.vapor.density;
                let beta = x.value(d + DISTRIBUTION);
                let law = a.law(x.rate(d + VAPOR), withdrawn, rho_g, gas);
                rows[d + VAPOR] = x.value(d + VAPOR) - rho_g * gas;
                rows[d + DISTRIBUTION] =
                    x.rate(d + DISTRIBUTION) - (law.beta_eq - beta) / s(a.distribution_s);
                rows[d + SUBMERGED] = x.value(d + SUBMERGED) - beta * gas;
            }
            report.steam_kg_s = steam;
            report.bypass_kg_s = bypass;
            report.feed_kg_s = feed;
            report.steam_enthalpy_j_kg = hg;
            report.heat_w = *heat;
            report.relief_flux_kg_m2_s = flux;
            report.mass_receipt_kg_s = mass_receipt;
            report.energy_receipt_w = energy_receipt;
        }
        if let Some(f) = &self.feed {
            let fb = f.base;
            let flows: Vec<Scalar> = (0..self.sgs.len())
                .map(|k| x.value(fb + HEADER + 1 + k))
                .collect();
            let total = flows.iter().fold(s(0.), |a, m| a + *m);
            let header = x.value(fb + HEADER);
            rows[fb + HEADER] = header - f.header_pa(total);
            for (k, m) in flows.iter().enumerate() {
                let dp = header - x.value(self.sgs[k].base + PRESSURE);
                if dp.value.partial_cmp(&0.) != Some(std::cmp::Ordering::Greater) {
                    return Err(recoverable(format!(
                        "FW.{} branch trial: header {} Pa at or below the SG (the check would close)",
                        self.sgs[k].id, header.value
                    )));
                }
                let c = f.control(k);
                let u = x.value(c + STEM);
                rows[fb + HEADER + 1 + k] = *m - f.branch_kg_s(u, dp);
                // The continuous control: the channel lags, the integrals
                // and the stem toward the law's demand.
                let law = &f.train.cascade;
                let level = match self.apparent {
                    Some(a) => {
                        let d = self.sgs[k].base + LIFTS + self.sgs[k].valves.len();
                        (x.value(self.sgs[k].base + LIQUID_VOLUME) + x.value(d + SUBMERGED))
                            / s(a.area_m2)
                    }
                    None => return Err(fatal("the feed train needs the apparent level")),
                };
                let p_sg = x.value(self.sgs[k].base + PRESSURE);
                let (steam, _) = self.pickup_steam(k, t, p_sg)?;
                let lags: [Scalar; 5] =
                    [NR_LAG, STEAM_LAG, FEED_LAG, OUTER, INNER].map(|o| x.value(c + o));
                let l = f.law(k, lags);
                rows[c + NR_LAG] = x.rate(c + NR_LAG) - (level - lags[0]) / s(law.nr_lag_s);
                rows[c + STEAM_LAG] =
                    x.rate(c + STEAM_LAG) - (steam - lags[1]) / s(law.steam_flow_lag_s);
                // FW.FT reads the train's branch flow. The S3-D12 gate zeroes
                // only the delivered feed (the reduction without pump
                // coastdown), so the channel does not see a reserve
                // transfer's brief gate as a feed step (C2: reading the gated
                // flow drove the inner loop through the rod-seat window,
                // 113 against 74 Jacobians).
                rows[c + FEED_LAG] = x.rate(c + FEED_LAG) - (*m - lags[2]) / s(law.feed_flow_lag_s);
                rows[c + OUTER] = x.rate(c + OUTER) - l.outer_rate;
                rows[c + INNER] = x.rate(c + INNER) - l.inner_rate;
                rows[c + STEM] = x.rate(c + STEM) - f.stem_rate(l.demand, u);
                let (sd, srate) = f.startup_law(k, lags[0], x.value(c + SF_INTEGRAL));
                rows[c + SF_INTEGRAL] = x.rate(c + SF_INTEGRAL) - srate;
                rows[c + SF_STEM] = x.rate(c + SF_STEM) - f.stem_rate(sd, x.value(c + SF_STEM));
            }
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
            own[b + MASS] = if let Some(f) = &self.feed {
                // The real balance: the branch flow against the withdrawal.
                let mut mass = vec![
                    b + MASS,
                    b + PRESSURE,
                    f.base + HEADER + 1 + k,
                    f.control(k) + SF_STEM,
                ];
                mass.extend(&lifts);
                mass
            } else if self.feed_gate_declared {
                let mut mass = vec![b + MASS, b + PRESSURE];
                mass.extend(&lifts);
                mass
            } else {
                vec![b + MASS]
            };
            let mut energy = vec![b + ENERGY, b + PRESSURE];
            energy.extend(&lifts);
            if let Some(f) = &self.feed {
                energy.push(f.base + HEADER + 1 + k);
                energy.push(f.control(k) + SF_STEM);
            }
            own[b + ENERGY] = energy;
            heat[b + ENERGY] = vec![k];
            own[b + PRESSURE] = vec![b + MASS, b + PRESSURE, b + LIQUID_VOLUME];
            own[b + LIQUID_VOLUME] = vec![b + ENERGY, b + PRESSURE, b + LIQUID_VOLUME];
            for &i in &lifts {
                own[i] = vec![b + PRESSURE, i];
            }
            if self.apparent.is_some() {
                let d = b + LIFTS + g.valves.len();
                own[d + VAPOR] = vec![b + PRESSURE, b + LIQUID_VOLUME, d + VAPOR];
                // The law reads the withdrawn gas (steam by time and
                // pressure, relief by pressure and lifts), the vapor
                // density, the gas volume and the vapor mass rate.
                let mut law = vec![b + PRESSURE, b + LIQUID_VOLUME, d + VAPOR, d + DISTRIBUTION];
                law.extend(&lifts);
                own[d + DISTRIBUTION] = law;
                own[d + SUBMERGED] = vec![b + LIQUID_VOLUME, d + DISTRIBUTION, d + SUBMERGED];
            }
            outputs.push(vec![b + PRESSURE, b + LIQUID_VOLUME]);
        }
        if let Some(f) = &self.feed {
            let fb = f.base;
            let branches: Vec<usize> = (0..self.sgs.len()).map(|k| fb + HEADER + 1 + k).collect();
            let mut header = vec![fb + HEADER];
            header.extend(&branches);
            own[fb + HEADER] = header;
            for (k, g) in self.sgs.iter().enumerate() {
                let c = f.control(k);
                own[fb + HEADER + 1 + k] = vec![
                    fb + HEADER,
                    fb + HEADER + 1 + k,
                    g.base + PRESSURE,
                    c + STEM,
                ];
                let d = g.base + LIFTS + g.valves.len();
                own[c + NR_LAG] = vec![g.base + LIQUID_VOLUME, d + SUBMERGED, c + NR_LAG];
                own[c + STEAM_LAG] = vec![g.base + PRESSURE, c + STEAM_LAG];
                own[c + FEED_LAG] = vec![fb + HEADER + 1 + k, c + FEED_LAG];
                let law: Vec<usize> = (0..STEM).map(|o| c + o).collect();
                own[c + OUTER] = law.clone();
                own[c + INNER] = law.clone();
                let mut stem = law;
                stem.push(c + STEM);
                own[c + STEM] = stem;
                own[c + SF_INTEGRAL] = vec![c + NR_LAG, c + SF_INTEGRAL];
                own[c + SF_STEM] = vec![c + NR_LAG, c + SF_INTEGRAL, c + SF_STEM];
            }
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
            .sum::<usize>()
            + self
                .feed
                .as_ref()
                .map_or(0, |_| FEED_ROOTS * self.sgs.len())
            + TAVG_ROOTS
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
        // R4-DUMP: the pressure mode only without forced circulation.
        let pressure_armed = self.trip_s.is_some() && !self.forced_circulation;
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
            // R12-B1: the pressure mode's kinks, armed from the TRIP on
            // without forced circulation.
            let (p0, w) = (self.bypass.no_load_pressure_pa, self.bypass.band_width_pa);
            out[i] = if pressure_armed { p - p0 } else { DISARMED };
            out[i + 1] = if pressure_armed {
                p - (p0 + w)
            } else {
                DISARMED
            };
            i += BYPASS_ROOTS;
        }
        // The NR1 lag's span edges, armed in AUTO: leaving the span
        // withdraws AUTO to HOLD.
        if let Some(f) = &self.feed {
            let [lo, hi] = f.train.cascade.narrow_span_m;
            for k in 0..self.sgs.len() {
                let l = x.value(f.control(k) + NR_LAG).value;
                let auto = f.modes[k].mode == Mode::Auto;
                out[i] = if auto { l - lo } else { DISARMED };
                out[i + 1] = if auto { hi - l } else { DISARMED };
                // The startup stand-in: start below its level (stopped),
                // isolate above its level (running).
                let sf = f.train.startup;
                let at = |fraction: f64| lo + fraction * (hi - lo);
                out[i + 2] = match f.modes[k].startup {
                    Startup::Stopped => l - at(sf.start_level_fraction),
                    _ => DISARMED,
                };
                out[i + 3] = match f.modes[k].startup {
                    Startup::Running => at(sf.isolation_level_fraction) - l,
                    _ => DISARMED,
                };
                i += FEED_ROOTS;
            }
        }
        // R4-DUMP: the Tavg mode's kinks, armed once both trips are received
        // with forced circulation (the accepted state is after the arming).
        if self.forced_circulation && self.tavg_arming().is_some() {
            let tavg = self.loop_average_input()?.value;
            let b = &self.bypass;
            let start = b.no_load_average_temperature_k + b.tavg_dead_band_k;
            out[i] = tavg - start;
            out[i + 1] = tavg - (start + b.tavg_band_width_k);
        } else {
            out[i] = DISARMED;
            out[i + 1] = DISARMED;
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
            for (b, side) in self.bypass_side[k].iter().enumerate() {
                out[i + 2 + b] = match side {
                    None => 0,
                    Some(true) => -1,
                    Some(false) => 1,
                };
            }
            i += 2 + BYPASS_ROOTS;
        }
        // The NR1 span edges report only the leaving (falling) crossing.
        if self.feed.is_some() {
            for _ in 0..self.sgs.len() {
                out[i..i + FEED_ROOTS].fill(-1);
                i += FEED_ROOTS;
            }
        }
        // R4-DUMP: a set side arms only the reverse crossing.
        for (b, side) in self.tavg_side.iter().enumerate() {
            out[i + b] = match side {
                None => 0,
                Some(true) => -1,
                Some(false) => 1,
            };
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
                    self.bypass_side[k][offset - 2] = Some(d > 0);
                    events.push(json!({"bypass": format!("SG.{}", g.id), "threshold": name,
                        "direction": d, "pressure_Pa": p}));
                }
            }
        }
        // An NR1 span edge in AUTO: HOLD at the demand in force.
        let mut withdrawn = Vec::new();
        if let Some(f) = self.feed.as_mut() {
            let first: usize = self
                .sgs
                .iter()
                .map(|g| THRESHOLDS.len() * g.valves.len() + 2 + BYPASS_ROOTS)
                .sum();
            for k in 0..self.sgs.len() {
                let d = &directions[first + FEED_ROOTS * k..first + FEED_ROOTS * (k + 1)];
                let c = f.control(k);
                if d[2] != 0 {
                    f.modes[k].startup = Startup::Running;
                    withdrawn.push(json!({"sg": self.sgs[k].id, "startup": "started",
                        "nr1_lag_m": y[c + NR_LAG], "reason": "low SG level demand (judgement)"}));
                }
                if d[3] != 0 {
                    f.modes[k].startup = Startup::Isolated;
                    withdrawn.push(json!({"sg": self.sgs[k].id, "startup": "isolated",
                        "nr1_lag_m": y[c + NR_LAG], "reason": "high-2 level (AP1000 T15.0-4a)"}));
                }
                if d[0] == 0 && d[1] == 0 {
                    continue;
                }
                if f.modes[k].mode != Mode::Auto {
                    return Err(fatal(format!(
                        "FW.{} span root crossed outside AUTO",
                        self.sgs[k].id
                    )));
                }
                let lags = [NR_LAG, STEAM_LAG, FEED_LAG, OUTER, INNER].map(|o| s(y[c + o]));
                let held = f.law(k, lags).demand.value;
                f.modes[k] = FeedMode {
                    mode: Mode::Hold,
                    held,
                    startup: f.modes[k].startup,
                };
                withdrawn.push(json!({"sg": self.sgs[k].id, "to": "HOLD", "held_demand": held,
                    "nr1_lag_m": y[c + NR_LAG], "reason": "the selected NR1 channel left its span"}));
            }
        }
        // R4-DUMP: a Tavg kink is a located crossing with no state change.
        let last = directions.len() - TAVG_ROOTS;
        let mut dump = Vec::new();
        for (offset, name) in [(0, "Tavg opening start"), (1, "Tavg full opening")] {
            let d = directions[last + offset];
            if d != 0 {
                if !(self.forced_circulation && self.tavg_arming().is_some()) {
                    return Err(fatal(format!(
                        "R4-DUMP: the {name} root crossed while disarmed"
                    )));
                }
                self.tavg_side[offset] = Some(d > 0);
                dump.push(
                    json!({"bypass": "Tavg mode", "threshold": name, "direction": d,
                    "loopAverage_K": self.loop_average.map(|(v, _)| v)}),
                );
            }
        }
        let changed = seats > 0 || !withdrawn.is_empty();
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"secondary","t_s":t,"relief":events,"seats":seats,
                "feedWithdrawn":withdrawn,"tavgDump":dump,"stateChanged":changed}),
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
            // G7: the steam demand stays at its constant A/B values; the
            // holding circuit's opening it causes reaches this owner as the
            // holding loss (R4-DUMP).
            Command::ManualReactorTrip => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"secondary","command":"ManualReactorTrip","t_s":t,
                    "steamDemand":"held at the constant A/B values (G7, declared boundary)"}),
            }),
            // R4-DUMP: the reactor trip (the holding circuit's opening, one
            // event for every owner); with the TRIP it arms the Tavg mode.
            // The steam demand is unchanged by it. A second report is
            // acknowledged unchanged.
            Command::HoldingLoss => {
                if let Some(t0) = self.reactor_trip_s {
                    return Ok(Transaction {
                        deposits: Vec::new(),
                        receipt: json!({"owner":"secondary","command":"HoldingLoss","t_s":t,
                            "reactorTripSince_s":t0,"bypass":"unchanged (the reactor trip is already received)"}),
                    });
                }
                if !t.is_finite() {
                    return Err(fatal("reactor trip time"));
                }
                if !self.loop_average_declared {
                    return Err(fatal(
                        "R4-DUMP: the post-trip Tavg mode reads the CVCS's loop-average channel; this composition has no CVCS",
                    ));
                }
                self.reactor_trip_s = Some(t);
                self.tavg_side = [None; 2];
                Ok(Transaction {
                    deposits: Vec::new(),
                    receipt: json!({"owner":"secondary","command":"HoldingLoss","t_s":t,
                        "steamDemand":"unchanged (the holding circuit is not the steam owner's)",
                        "bypass": self.arming_note()}),
                })
            }
            Command::TurbineTrip | Command::TurbineTripAcquired => {
                // R12-A2: with the reactor-trip interlock a second trip
                // demand (an operator's, the field controller's) can reach a
                // latched turbine; the trip memory absorbs it unchanged.
                if let Some(t0) = self.trip_s {
                    return Ok(Transaction {
                        deposits: Vec::new(),
                        receipt: json!({"owner":"secondary","command":command,"t_s":t,
                            "latchedSince_s":t0,"steamDemand":"unchanged (the TRIP is already latched)"}),
                    });
                }
                if !t.is_finite() {
                    return Err(fatal("turbine TRIP time"));
                }
                self.trip_s = Some(t);
                self.bypass_side = vec![[None; 2]; self.sgs.len()];
                Ok(Transaction {
                    deposits: Vec::new(),
                    receipt: json!({"owner":"secondary","command":command,"t_s":t,
                        "stopTravel_s":self.stop_travel_s,"rampEnd_s":t + self.stop_travel_s,
                        "steamDemand_kg_s":self.sgs.iter().map(|g| g.steam_demand_kg_s).collect::<Vec<_>>(),
                        "bypass": self.arming_note()}),
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
    // (both finite: validated above and by the characteristic)
    if b.no_load_pressure_pa + b.band_width_pa >= relief.crack_pressure_pa {
        return Err(fatal(
            "SG bypass full opening must lie below the relief crack",
        ));
    }
    if !(positive(r.back_pressure_pa)
        && r.valves
            .iter()
            .all(|v| r.back_pressure_pa < v.reseat_pressure_pa))
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
    if b.mode != packet::BypassMode::NoLoadTavgAfterReactorAndTurbineTrip
        || b.tavg_input != packet::TavgInput::CvcsLoopAverageLag
        || b.without_forced_circulation != packet::PressureMode::NoLoadPressureAfterTurbineTrip
        || ![
            b.no_load_average_temperature_k,
            b.no_load_pressure_pa,
            b.band_width_pa,
            b.tavg_band_width_k,
        ]
        .into_iter()
        .all(positive)
        || !(b.tavg_dead_band_k.is_finite() && b.tavg_dead_band_k >= 0.)
        || !(b.fraction_of_nominal_steam > 0. && b.fraction_of_nominal_steam <= 1.)
    {
        return Err(fatal(
            "SG bypass post-trip modes (R4-DUMP Tavg, R12-B1 pressure)",
        ));
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
    if !no_load.is_finite() || (no_load - b.no_load_average_temperature_k).abs() > 1e-3 {
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

/// C08's derived law: `tau_residence = V_sub,nom rho_g(p_nom) / F_nom` on
/// the runtime law, once.
fn apparent<P: Properties>(a: &packet::ApparentLevel, props: &P) -> Result<Apparent, Failure> {
    let d = a.distribution;
    if ![
        d.nominal_submerged_volume_m3,
        d.nominal_pressure_pa,
        d.nominal_steam_flow_kg_s,
        d.maximum_submerged_volume_m3,
        d.distribution_time_s,
        a.indication.indicated_level_area_m2,
    ]
    .into_iter()
    .all(positive)
        || !(d.prepared_distribution > 0. && d.prepared_distribution < 1.)
    {
        return Err(fatal("SG apparent-level section values"));
    }
    let sat = WaterProperties::saturation(props, s(d.nominal_pressure_pa))
        .map_err(|e| fatal(format!("SG apparent-level nominal saturation: {e}")))?;
    let residence_s =
        d.nominal_submerged_volume_m3 * sat.vapor.density.value / d.nominal_steam_flow_kg_s;
    if !positive(residence_s) {
        return Err(fatal("SG apparent-level residence time"));
    }
    Ok(Apparent {
        residence_s,
        maximum_submerged_m3: d.maximum_submerged_volume_m3,
        distribution_s: d.distribution_time_s,
        prepared_distribution: d.prepared_distribution,
        area_m2: a.indication.indicated_level_area_m2,
    })
}

/// The compact feed train's derived coefficients and prepared openings:
/// the pump rise and entry loss from the discharge and header pressures at
/// `2 m0`, the ISO-path and FCV drops at `m0`, and per SG the MANUAL
/// opening that delivers its steam demand at its prepared pressure with
/// both pumps sharing the total demand (the S4-D6 rule on the compact law).
fn feed_owner(
    train: packet::FeedTrain,
    sgs: &[SteamGenerator],
    stocks: &[SecondaryStock],
    base: usize,
) -> Result<FeedOwner, Failure> {
    let t = train;
    if ![
        t.nominal_flow_kg_s,
        t.suction_pressure_pa,
        t.fcv_stroke_per_second,
        t.receiver_pressure_pa,
    ]
    .into_iter()
    .all(positive)
        || t.shutoff_head_ratio.partial_cmp(&1.) != Some(std::cmp::Ordering::Greater)
        || !(t.suction_pressure_pa < t.discharge_pressure_pa
            && t.header_pressure_pa < t.discharge_pressure_pa
            && t.iso_outlet_pressure_pa < t.header_pressure_pa
            && t.receiver_pressure_pa < t.iso_outlet_pressure_pa)
        || !(t.fcv_reference_opening > 0. && t.fcv_reference_opening < 1.)
        || !(t.stem_time_constant_s > 0. && t.stem_time_constant_s.is_finite())
    {
        return Err(fatal("compact feed train pressures, ratio or opening"));
    }
    t.cascade.validate()?;
    let m0 = t.nominal_flow_kg_s;
    let mut f = FeedOwner {
        train: t,
        base,
        pump_rise_pa: t.discharge_pressure_pa - t.suction_pressure_pa,
        entry_coefficient: (t.discharge_pressure_pa - t.header_pressure_pa) / (2. * m0).powi(2),
        iso_drop_pa: t.header_pressure_pa - t.iso_outlet_pressure_pa,
        fcv_drop_pa: t.iso_outlet_pressure_pa - t.receiver_pressure_pa,
        prepared_opening: Vec::new(),
        startup_capacity_kg_s: 0.,
        startup_enthalpy_j_kg: 0.,
        modes: Vec::new(),
        sgs: sgs.len(),
    };
    let total: f64 = sgs.iter().map(|g| g.steam_demand_kg_s).sum();
    let header = f.header_pa(s(total)).value;
    for (g, x) in sgs.iter().zip(stocks) {
        let u = f
            .opening_for(g.steam_demand_kg_s, header - x.pressure_pa)
            .filter(|u| *u > 0. && *u <= 1.)
            .ok_or_else(|| {
                fatal(format!(
                    "FW.{}: no FCV opening delivers {} kg/s at the prepared {} Pa",
                    g.id, g.steam_demand_kg_s, x.pressure_pa
                ))
            })?;
        f.prepared_opening.push(u);
        f.modes.push(FeedMode {
            mode: Mode::Auto,
            held: u,
            startup: Startup::Stopped,
        });
    }
    Ok(f)
}

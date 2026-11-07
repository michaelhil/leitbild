//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#pzr-shell-heads-heaters-and-relief-g6
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#shell-and-head-metal
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#independent-relief-candidate
//! The joined PZR block (G6): the stratified cell's heater rods, shell bands
//! and heads, and its relief lift, composed with the network through the
//! cell's boundary port (`network::Coupling::pzr_boundary`).
//!
//! Coordinates, in order: the relief lift in full strokes when the cell
//! declares a relief port, then one lumped 304 steel energy per heater rod
//! segment and per wall element (`Heaters::segments`, then
//! `Walls::elements`), exactly as the P2 verification cases compose them.
//! Every row is differential: the lift's `lift' = rate(motion)` and each
//! steel's `U' = Joule − fluid receipts − enclosure exchange − exterior
//! loss`, both evaluated by the walls' and heaters' own laws on the cell's
//! column of the same evaluation. The block hands the cell the heater and
//! wall receipts and the relief state (lift and the receiver's declared
//! backpressure); zone heat is zero, since every external heat into the
//! zones reaches them through the metal.
//!
//! G6 with P4 (S2 design choices, 11 October): the heater demand is the
//! metal's exterior loss (shell bands and both heads) at the composed cell's
//! `Tsat(p_s)`, computed once. Without a controller it is held constant
//! (S2). S3-D36 (G18's principle, S2-D2/D3): every steel store starts at the
//! steady state of its own laws at the prepared cell, the demand and the
//! exterior loss, from the stock-IDA steady solids settle
//! (`prepare_steady_solids`), carried by the packet's `pzrSteel` section
//! ([`Steel`]); `Tsat(p_s)` is only that settle's initial state
//! ([`SteelPreparation::Saturation`]).
//!
//! S3 (IC-CTRL): the normal pressure controller (`control::pzr_pressure`)
//! replaces the demand at frame instants through [`Pzr::apply_control`],
//! a held-input change between solver segments that the frame driver
//! classifies (S3-D1: class S under the smallness criterion, else R). The
//! banks take the request by the equipment's continuous split.
//!
//! R4-PZR-CONTINUOUS (PERF3, lead 1 Nov, Option A): with the section's
//! `continuousControl` the block owns the PT1 channel's first-order lag as
//! its last coordinate, `τ p_L' = p_roof − p_L` (class
//! [`Class::PzrControl`], differential in every mode). Once commissioned
//! ([`Pzr::commission_continuous`], the S3 composition's AUTO) the heater
//! request is the same law as a continuous function of that coordinate,
//! `C clamp[(p_set − p_L)/B, 0, 1]`
//! (`control::pzr_pressure::continuous_heater_request`), split over the
//! banks by the same continuous split with its direction
//! (`Heaters::bank_split`), inside every evaluation: no sample, no quantum,
//! no transport and no held-input change. Before commissioning (S2, the
//! steady solids) the held demand is in force and the lag only follows the
//! roof pressure.
//!
//! R4-PZR-PI (lead 1 Nov 2026): the continuous law is the pressure master
//! (`control::pzr_pressure::Master`): the block also owns the master
//! integral `I` (Pa, class [`Class::PzrControl`]), and, when the network
//! composes the controlled-spray path (S-b), the spray stem fraction `x`
//! (class [`Class::PzrControl`]). One demand `D = (p_L − p_set) + I` gives the
//! heater request and the spray demand; `I' = (sclamp(D) − I)/Ti`. The stem
//! has three modes ([`SprayMode`]): locked closed (`x' = 0`, the network's
//! valve path locked), tracking (`x' = clamp((u − x)/τ, ±r)`, `r` the
//! valve's stroke rate) and closing (`x' = −r`, the wiki's rate to 0). The
//! valve leaves its lock at the located root `D − s0` rising, starts
//! closing at that root falling, and locks at the located root `x` falling
//! (class R each; the operator puts the lock change in the network). The
//! banks take the request by the smooth split (`Heaters::smooth_bank_split`,
//! the lead's 30 kW corner). Before commissioning `I' = 0` and `x' = 0`.
//! The S2
//! network composes no controlled-spray material path (the spray port's
//! receipt is the network's zero), so a nonzero spray demand refuses here
//! instead of being dropped.
//!
//! The relief is the independent device unchanged from its owner: demand
//! by root on raw PT1 (at the roof, so the roof pressure), finite lift
//! travel, and the mechanical stop at the end of travel, a transaction that
//! sets the lift exactly to 1 (open) or exactly to 0 (on the seat). The
//! block always reports two roots, the demand threshold and the travel; a
//! lift at rest reports the travel root as the constant [`DISARMED`].
use super::block::{Class, Coordinates, Layout, Transaction, snapshot_object};
use crate::{
    control::pzr_pressure::Master,
    network::{
        Failure,
        heaters::{BanksBlock, Caloric304, ContactBlock, HeaterCase, Heaters},
        stratified::{
            self, Boundary, Cell, Column, Heat, PortKind, ReliefDevice, ReliefMotion, ReliefState,
        },
        walls::{ShellBlock, WallCase, Walls},
    },
    thermal::{Scalar, WaterProperties},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined PZR block: {}", reason.into()))
}

/// The travel root's value while the lift is at rest: constant, so it
/// never crosses zero.
pub const DISARMED: f64 = 1.;

/// `ld01-pzr-relief-isolation` (R4-RELIEF-ISO).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IsolationBlock {
    pub id: String,
    #[serde(rename = "strokeTime_s")]
    pub stroke_s: f64,
    /// The DC group whose delivered output the valve needs to move: a guard
    /// on the command and on travel, not a load on the group.
    #[serde(rename = "supplyGroup")]
    pub supply_group: String,
}

/// R4-RELIEF-ISO: the series isolation valve's achieved position, a known
/// function of time between commands. Not a coordinate and no root: the
/// stroke's start is a restart and its end an owner time event, so a run
/// that never moves it keeps its bits.
#[derive(Clone, Copy, Debug)]
pub struct Isolation {
    stroke_s: f64,
    /// The open fraction while still; where the stroke started while moving.
    position: f64,
    /// While moving: the stroke's start and its signed fraction per second.
    motion: Option<(f64, f64)>,
}

impl Isolation {
    fn open_fraction(&self, t: f64) -> f64 {
        match self.motion {
            None => self.position,
            Some((from, rate)) => self.position + rate * (t - from),
        }
    }
    fn target(&self) -> Option<f64> {
        self.motion.map(|(_, rate)| if rate < 0. { 0. } else { 1. })
    }
    fn arrival(&self) -> Option<f64> {
        let (from, rate) = self.motion?;
        Some(from + (self.target()? - self.position) / rate)
    }
    /// Start toward `target`; `false` when it stands there or moves there.
    fn drive(&mut self, t: f64, target: f64) -> bool {
        if self.target() == Some(target) || (self.motion.is_none() && self.position == target) {
            return false;
        }
        self.position = self.open_fraction(t);
        let rate = if target < self.position { -1. } else { 1. } / self.stroke_s;
        self.motion = Some((t, rate));
        true
    }
    /// Stop where it is (the supply lost in travel).
    fn arrest(&mut self, t: f64) {
        self.position = self.open_fraction(t);
        self.motion = None;
    }
}

/// The joined packet's `pzrMetal` section: the owners' strict blocks,
/// unchanged, and the relief receiver's backpressure.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    /// `ld01-pzr-heater-banks`.
    #[serde(rename = "heaterBanks")]
    pub heater_banks: BanksBlock,
    /// `ld01-pzr-heater-contact`.
    #[serde(rename = "heaterContact")]
    pub heater_contact: ContactBlock,
    /// `reference-304-caloric`.
    #[serde(rename = "caloric304")]
    pub caloric: Caloric304,
    /// `ld01-pzr-shell`.
    pub shell: ShellBlock,
    /// The relief receiver's backpressure, held constant: the containment
    /// at the relief device's calibration backpressure.
    #[serde(rename = "reliefBackPressure_Pa")]
    pub relief_back_pressure_pa: f64,
    /// R4-PZR-CONTINUOUS: the normal pressure control's continuous heater
    /// law and the PT1 channel's lag, when the packet composes them.
    #[serde(rename = "continuousControl")]
    pub continuous_control: Option<ContinuousControl>,
    /// R4-RELIEF-ISO: `ld01-pzr-relief-isolation`, when the packet composes
    /// the valve. Without it the relief has no isolation and the valve's
    /// commands refuse by name.
    #[serde(rename = "reliefIsolation")]
    pub relief_isolation: Option<IsolationBlock>,
    /// The compiler's consumed pages, for receipts only.
    pub provenance: serde_json::Value,
}

/// R4-PZR-PI: the packet's `continuousControl` is the pressure master's
/// values (`control::pzr_pressure::Master`).
pub type ContinuousControl = Master;

/// R4-PZR-PI (S-b): the controlled-spray stem's mode under the continuous
/// master.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SprayMode {
    /// Closed on its lock: `x = 0`, `x' = 0`, the valve path locked.
    Locked,
    /// Following the master's spray demand.
    Tracking,
    /// The demand returned below the spray start: closing at the stroke
    /// rate until the stem reaches 0.
    Closing,
}
impl SprayMode {
    fn name(self) -> &'static str {
        match self {
            SprayMode::Locked => "locked",
            SprayMode::Tracking => "tracking",
            SprayMode::Closing => "closing",
        }
    }
    fn parse(v: &serde_json::Value) -> Result<Self, Failure> {
        match v.as_str() {
            Some("locked") => Ok(SprayMode::Locked),
            Some("tracking") => Ok(SprayMode::Tracking),
            Some("closing") => Ok(SprayMode::Closing),
            _ => Err(fatal(format!("snapshot: spray stem mode {v}"))),
        }
    }
}

/// R4-PZR-PI: the composed continuous master: its values, the coordinates
/// it owns (the PT1 lag, the integral and, with the spray path, the stem)
/// and the stem's stroke rate and mode.
#[derive(Clone, Copy, Debug)]
struct Continuous {
    master: Master,
    lag: usize,
    integral: usize,
    stem: Option<Stem>,
}
#[derive(Clone, Copy, Debug)]
struct Stem {
    index: usize,
    strokes_per_s: f64,
    mode: SprayMode,
}

/// Which heater demand is in force.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    /// The held demand: P4's until a control frame replaces it
    /// ([`Pzr::apply_control`]).
    Held,
    /// R4-PZR-CONTINUOUS: the continuous law on the channel lag.
    Continuous,
}

/// The packet's `pzrSteel` section (S3-D36): each steel coordinate's
/// prepared energy at the steady state of its laws, in the block's layout
/// order and by its census label, from the stock-IDA steady solids settle.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Steel {
    pub stores: Vec<SteelStore>,
    /// The settle's provenance and receipt, for receipts only.
    pub provenance: serde_json::Value,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteelStore {
    pub id: String,
    #[serde(rename = "energy_J")]
    pub energy_j: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
}

/// Where the block's prepared steel energies come from.
#[derive(Clone, Copy, Debug)]
pub enum SteelPreparation<'a> {
    /// Every steel at the composed cell's `Tsat(p_s)`: only the steady
    /// solids settle's initial state.
    Saturation,
    /// The steady state of the steel's laws (S3-D36), the packet's
    /// `pzrSteel`.
    Steady(&'a Steel),
}

/// The relief device and its discrete state, retained by the block.
#[derive(Clone, Copy, Debug)]
pub struct Relief {
    /// The relief port's index in the cell's ports.
    pub port: usize,
    pub device: ReliefDevice,
    pub back_pressure_pa: f64,
    pub motion: ReliefMotion,
    /// The demand's state: open above the opening pressure until the roof
    /// pressure falls through the reseat pressure.
    pub demand_open: bool,
    /// HOOK (C4 lane, for KERN/G6): the declared fails-open malfunction
    /// ([`super::block::Command::ReliefStuckOpen`]): the demand is held open
    /// and its root disarmed; the travel root still stops the lift at 1.
    pub stuck_open: bool,
}

/// What one relief transaction did, for its receipt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReliefEvent {
    pub before: (bool, ReliefMotion),
    pub after: (bool, ReliefMotion),
    pub stop: Option<stratified::Stop>,
}

impl Relief {
    /// The two roots at the roof pressure and the lift: the demand
    /// threshold (`p_roof − reseat` with demand open, `p_roof − opening`
    /// with it closed) and the distance to the end of travel while moving,
    /// [`DISARMED`] at rest.
    pub fn roots(&self, roof_pressure_pa: f64, lift: f64) -> [f64; 2] {
        let r = self
            .device
            .roots(s(roof_pressure_pa), s(lift), self.demand_open, self.motion);
        // HOOK (C4 lane): a stuck-open demand never crosses.
        let demand = if self.stuck_open {
            DISARMED
        } else {
            r.demand.value
        };
        [demand, r.travel.map_or(DISARMED, |t| t.value)]
    }
    /// HOOK (C4 lane, for KERN/G6): the fails-open malfunction. The demand
    /// is held open from now on and its root disarmed; a closed or closing
    /// lift starts opening at the device's rate, and the mechanical stop at
    /// full lift keeps it there. Refused once stuck.
    pub fn stick_open(&mut self) -> Result<ReliefEvent, Failure> {
        if self.stuck_open {
            return Err(fatal("the relief is already stuck open"));
        }
        let before = (self.demand_open, self.motion);
        self.stuck_open = true;
        self.demand_open = true;
        self.motion = match self.motion {
            ReliefMotion::Closed | ReliefMotion::Closing => ReliefMotion::Opening,
            m => m,
        };
        Ok(ReliefEvent {
            before,
            after: (self.demand_open, self.motion),
            stop: None,
        })
    }
    /// The transaction at located roots, `[demand, travel]` directions as
    /// IDAGetRootInfo. The travel root first: the mechanical stop sets the
    /// lift exactly to 1 or 0 (`ReliefDevice::stop`, refused beyond
    /// `root_bound` full strokes from the stop). Then the demand: rising
    /// through the opening pressure with demand closed opens it, falling
    /// through the reseat pressure with demand open closes it; a crossing
    /// in the other direction refuses. Opening demand starts a closed or
    /// closing lift opening, closing demand starts an open or opening lift
    /// closing.
    pub fn transact(
        &mut self,
        directions: [i32; 2],
        lift: &mut f64,
        root_bound: f64,
    ) -> Result<ReliefEvent, Failure> {
        let before = (self.demand_open, self.motion);
        let mut stop = None;
        if directions[1] != 0 {
            let report = self.device.stop(self.motion, lift, root_bound)?;
            self.motion = report.motion_after;
            stop = Some(report);
        }
        if directions[0] != 0 && self.stuck_open {
            return Err(fatal("a stuck-open relief's disarmed demand root crossed"));
        }
        if directions[0] != 0 {
            let expected = if self.demand_open { -1 } else { 1 };
            if directions[0] != expected {
                return Err(fatal(format!(
                    "relief demand root crossed in direction {} with demand_open = {}",
                    directions[0], self.demand_open
                )));
            }
            self.demand_open = !self.demand_open;
            self.motion = match (self.demand_open, self.motion) {
                (true, ReliefMotion::Closed | ReliefMotion::Closing) => ReliefMotion::Opening,
                (false, ReliefMotion::Open | ReliefMotion::Opening) => ReliefMotion::Closing,
                (_, m) => m,
            };
        }
        Ok(ReliefEvent {
            before,
            after: (self.demand_open, self.motion),
            stop,
        })
    }
}

/// The PZR block's part of the unit's conservation account
/// (`joined::account`), from the last captured value evaluation: what
/// enters the unit through the metal (Joule power) and leaves it (the
/// exterior loss to the containment). The relief's outflow is the cell's
/// own (`network::stratified::Flows::relief`).
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Ledger {
    pub joule_w: f64,
    pub exterior_w: f64,
}

/// What one control frame put in force, for its receipt.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ControlApplied {
    pub t_s: f64,
    pub request_before_w: f64,
    pub request_after_w: f64,
    pub banks_before_w: Vec<f64>,
    pub banks_after_w: Vec<f64>,
}

/// The joined PZR block.
pub struct Pzr {
    heaters: Heaters,
    walls: Walls,
    relief: Option<Relief>,
    /// R4-RELIEF-ISO: the valve when composed, and the open fraction at the
    /// evaluation's time.
    isolation: Option<Isolation>,
    isolation_block: Option<IsolationBlock>,
    open_fraction: f64,
    /// The held heater demand (W; P4's until a control frame) and each
    /// bank's delivered power, in force under [`Control::Held`].
    request_w: f64,
    bank_power_w: Vec<f64>,
    /// R4-PZR-CONTINUOUS / R4-PZR-PI: the composed continuous master and
    /// its coordinates (the layout's last), and which demand is in force.
    continuous: Option<Continuous>,
    control: Control,
    /// R4-PZR-PI: the network's valve-path lock change a transaction
    /// decided (`Some(closed)`), for the operator to put in force.
    spray_lock_change: Option<bool>,
    /// `Tsat(p_s)` of the composed cell: P4's demand temperature.
    saturation_temperature_k: f64,
    /// A travel root's lift farther than this from its stop (full strokes)
    /// is not that root; declared by the harness before any transaction.
    lift_root_bound: Option<f64>,
    layout: Layout,
    prepared: Vec<f64>,
    /// Record the account's terms at value evaluations (only the account
    /// turns it on), and the last value evaluation's record.
    capture: bool,
    captured: Option<Ledger>,
    /// HOOK (COST2): the heaters' and walls' wet/film turnovers held across
    /// evaluations (exact: pure functions of their keys).
    turnovers: crate::thermal::TurnoverHeld,
}

impl Pzr {
    /// Compose the block on the cell from the packet's section, with P4's
    /// demand at `saturation_temperature_k`, the composed cell's
    /// `Tsat(p_s)`, and the steel as `steel` prepares it; a composed
    /// continuous control's channel lag is prepared at
    /// `prepared_roof_pressure_pa`, the cell's prepared roof pressure, its
    /// integral where the master's request at that lag is P4's demand (a
    /// demand outside the open heater range refuses), and with the network's
    /// spray path (`spray_strokes_per_s`, the valve's stroke rate) the stem
    /// locked at 0.
    /// Refuses a relief port whose demand would not read the roof pressure
    /// (PT1 below the roof), a nonpositive backpressure, a heater demand
    /// outside the banks' range, steady steel that is not one store per
    /// steel coordinate in layout order with its energy's own 304
    /// temperature, and a continuous control whose capacity is not the
    /// banks' or whose values are not positive.
    pub fn new(
        cell: &Cell,
        section: &Section,
        steel: SteelPreparation<'_>,
        saturation_temperature_k: f64,
        prepared_roof_pressure_pa: f64,
        spray_strokes_per_s: Option<f64>,
    ) -> Result<Self, Failure> {
        let contact = section.heater_contact;
        let heaters = Heaters::new(
            cell,
            &section.heater_banks,
            section.caloric,
            contact,
            HeaterCase::nominal(&contact),
        )?;
        let walls = Walls::new(
            cell,
            &heaters,
            section.shell.clone(),
            section.caloric,
            contact,
            WallCase::nominal(&contact, &section.shell),
        )?;
        let p = cell.parameters();
        let relief = match p
            .ports
            .iter()
            .enumerate()
            .find(|(_, port)| port.kind == PortKind::Relief)
        {
            None => None,
            Some((index, port)) => {
                let device = port
                    .relief
                    .ok_or_else(|| fatal(format!("relief port {} without its device", port.id)))?;
                if p.tap(stratified::PT1)? != p.top_m {
                    return Err(fatal(
                        "the relief demand reads raw PT1, which must be the roof tap",
                    ));
                }
                let back = section.relief_back_pressure_pa;
                if !(back.is_finite() && back > 0.) {
                    return Err(fatal(format!(
                        "relief backpressure {back} Pa must be positive"
                    )));
                }
                Some(Relief {
                    port: index,
                    device,
                    back_pressure_pa: back,
                    motion: ReliefMotion::Closed,
                    demand_open: false,
                    stuck_open: false,
                })
            }
        };
        if !(saturation_temperature_k.is_finite() && saturation_temperature_k > 0.) {
            return Err(fatal(format!(
                "steel preparation temperature {saturation_temperature_k} K"
            )));
        }
        let steel_t = s(saturation_temperature_k);
        let request_w = (0..walls.elements().len())
            .map(|i| walls.exterior(i, steel_t).value)
            .sum::<f64>();
        let bank_power_w = heaters.bank_powers(request_w)?;
        let labels: Vec<String> = heaters
            .census()
            .coordinates
            .into_iter()
            .chain(walls.census().coordinates)
            .collect();
        let energy = match steel {
            SteelPreparation::Saturation => {
                let mut energy = heaters.prepared_energy(saturation_temperature_k)?;
                energy.extend(walls.prepared_energy(saturation_temperature_k)?);
                energy
            }
            SteelPreparation::Steady(steel) => {
                let masses: Vec<f64> = heaters
                    .segments()
                    .iter()
                    .map(|g| g.steel_mass_kg)
                    .chain(walls.elements().iter().map(|e| e.steel_mass_kg))
                    .collect();
                if steel.stores.len() != labels.len() {
                    return Err(fatal(format!(
                        "pzrSteel lists {} stores for {} steel coordinates",
                        steel.stores.len(),
                        labels.len()
                    )));
                }
                let mut energy = Vec::with_capacity(labels.len());
                for ((store, label), mass) in steel.stores.iter().zip(&labels).zip(&masses) {
                    if &store.id != label {
                        return Err(fatal(format!(
                            "pzrSteel store {} where the layout has {label}",
                            store.id
                        )));
                    }
                    let own = section.caloric.temperature(s(store.energy_j / mass))?.value;
                    let gap = (own - store.temperature_k).abs();
                    if !gap.is_finite() || gap > 1e-9 * own {
                        return Err(fatal(format!(
                            "pzrSteel {label}: {} K is not its energy's {own} K",
                            store.temperature_k
                        )));
                    }
                    energy.push(store.energy_j);
                }
                energy
            }
        };
        let mut layout = Layout::default();
        let mut prepared = Vec::new();
        if relief.is_some() {
            layout.push(
                "PZR relief lift (full strokes)".into(),
                Class::PzrReliefLift,
                true,
                1.,
                1.,
            );
            prepared.push(0.);
        }
        for (label, e) in labels.into_iter().zip(&energy) {
            if !(e.is_finite() && *e > 0.) {
                return Err(fatal(format!("{label}: prepared steel energy {e} J")));
            }
            layout.push(label, Class::PzrMetal, true, *e, *e);
            prepared.push(*e);
        }
        let continuous = match section.continuous_control {
            None => None,
            Some(c) => {
                c.validate()?;
                if !(prepared_roof_pressure_pa.is_finite() && prepared_roof_pressure_pa > 0.) {
                    return Err(fatal(format!(
                        "continuousControl: the prepared roof pressure {prepared_roof_pressure_pa} Pa"
                    )));
                }
                let installed: f64 = heaters.banks().iter().map(|b| b.nominal_capacity_w).sum();
                if installed != c.heater_capacity_w {
                    return Err(fatal(format!(
                        "continuousControl: the law modulates {} W, the banks install {installed} W",
                        c.heater_capacity_w
                    )));
                }
                let lag = layout.len();
                // The channel's state in Pa, at the solver scale of the
                // commissioned setpoint.
                layout.push(
                    "PZR.PT1.lag (Pa)".into(),
                    Class::PzrControl,
                    true,
                    c.setpoint_pa,
                    c.setpoint_pa,
                );
                prepared.push(prepared_roof_pressure_pa);
                // R4-PZR-PI: the integral where the master's request at the
                // prepared lag is P4's demand.
                let integral = layout.len();
                layout.push(
                    "PZR pressure master integral I (Pa)".into(),
                    Class::PzrControl,
                    true,
                    c.heater_band_pa,
                    c.heater_band_pa,
                );
                let demand = c.demand_for_request(request_w)?;
                prepared.push(demand - (prepared_roof_pressure_pa - c.setpoint_pa));
                let stem = match spray_strokes_per_s {
                    None => None,
                    Some(r) => {
                        if !(r.is_finite() && r > 0.) {
                            return Err(fatal(format!("continuousControl: spray stroke rate {r}")));
                        }
                        let index = layout.len();
                        layout.push(
                            "PZR controlled-spray stem x (fraction)".into(),
                            Class::PzrControl,
                            true,
                            1.,
                            1.,
                        );
                        prepared.push(0.);
                        Some(Stem {
                            index,
                            strokes_per_s: r,
                            mode: SprayMode::Locked,
                        })
                    }
                };
                Some(Continuous {
                    master: c,
                    lag,
                    integral,
                    stem,
                })
            }
        };
        layout.validate("pzr")?;
        Ok(Self {
            heaters,
            walls,
            relief,
            isolation: section.relief_isolation.as_ref().map(|b| Isolation {
                stroke_s: b.stroke_s,
                position: 1.,
                motion: None,
            }),
            isolation_block: section.relief_isolation.clone(),
            open_fraction: 1.,
            request_w,
            bank_power_w,
            continuous,
            control: Control::Held,
            spray_lock_change: None,
            saturation_temperature_k,
            lift_root_bound: None,
            layout,
            prepared,
            capture: false,
            captured: None,
            turnovers: crate::thermal::TurnoverHeld::default(),
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    /// Prepared physical coordinates: the lift on its seat, every steel as
    /// its [`SteelPreparation`] prepared it.
    pub fn prepared(&self) -> &[f64] {
        &self.prepared
    }
    /// Every coordinate is differential in every mode.
    pub fn differential(&self) -> Vec<f64> {
        self.layout.ids()
    }
    pub fn heaters(&self) -> &Heaters {
        &self.heaters
    }
    pub fn walls(&self) -> &Walls {
        &self.walls
    }
    pub fn relief(&self) -> Option<Relief> {
        self.relief
    }
    /// R4-RELIEF-ISO: the valve's block, when composed.
    pub fn isolation_block(&self) -> Option<&IsolationBlock> {
        self.isolation_block.as_ref()
    }
    /// R4-RELIEF-ISO: the evaluation's time, for the valve's open fraction.
    pub fn at_time(&mut self, t: f64) {
        if let Some(valve) = &self.isolation {
            self.open_fraction = valve.open_fraction(t);
        }
    }
    /// R4-RELIEF-ISO: the achieved open fraction at `t`, 1 with no valve.
    pub fn isolation_position(&self, t: f64) -> f64 {
        self.isolation.map_or(1., |v| v.open_fraction(t))
    }
    /// R4-RELIEF-ISO: whether the valve is travelling.
    pub fn isolation_moving(&self) -> bool {
        self.isolation.is_some_and(|v| v.motion.is_some())
    }
    /// R4-RELIEF-ISO: start the valve toward shut or open at `t`; `false`
    /// when it stands at that target or already moves there.
    pub fn drive_isolation(&mut self, t: f64, close: bool) -> Result<bool, Failure> {
        let valve = self
            .isolation
            .as_mut()
            .ok_or_else(|| fatal("the block composes no relief isolation"))?;
        Ok(valve.drive(t, if close { 0. } else { 1. }))
    }
    /// R4-RELIEF-ISO: the supply lost in travel arrests the valve where it
    /// is; intent does not replay when the supply returns.
    pub fn arrest_isolation(&mut self, t: f64) -> Result<(), Failure> {
        self.isolation
            .as_mut()
            .ok_or_else(|| fatal("the block composes no relief isolation"))?
            .arrest(t);
        Ok(())
    }
    /// R4-RELIEF-ISO: the stroke's end strictly after `t`.
    pub fn next_isolation_event(&self, t: f64) -> Option<f64> {
        self.isolation?.arrival().filter(|a| *a > t)
    }
    /// R4-RELIEF-ISO: the stroke ending exactly at `t`, its receipt.
    pub fn isolation_event(&mut self, t: f64) -> Option<serde_json::Value> {
        let valve = self.isolation.as_mut()?;
        if valve.arrival() != Some(t) {
            return None;
        }
        let target = valve.target()?;
        valve.position = target;
        valve.motion = None;
        Some(
            json!({"owner":"pzr","t_s":t,"relief_isolation":{"position":target,"stateChanged":true}}),
        )
    }
    /// The held heater demand, W: P4's prepared demand until a controller
    /// frame replaces it. Under [`Control::Continuous`] it is not in force:
    /// the demand is the master's ([`Pzr::continuous_outputs`]).
    pub fn request_w(&self) -> f64 {
        self.request_w
    }
    /// R4-PZR-CONTINUOUS / R4-PZR-PI: the composed continuous master, if any.
    pub fn continuous_control(&self) -> Option<&ContinuousControl> {
        self.continuous.as_ref().map(|c| &c.master)
    }
    /// R4-PZR-CONTINUOUS: the channel lag's index in the block's layout.
    pub fn lag_coordinate(&self) -> Option<usize> {
        self.continuous.map(|c| c.lag)
    }
    /// R4-PZR-PI: the master integral's index in the block's layout.
    pub fn integral_coordinate(&self) -> Option<usize> {
        self.continuous.map(|c| c.integral)
    }
    /// R4-PZR-PI (S-b): the spray stem's index in the block's layout, when
    /// the network composes the spray path.
    pub fn stem_coordinate(&self) -> Option<usize> {
        self.continuous.and_then(|c| c.stem.map(|s| s.index))
    }
    /// R4-PZR-PI (S-b): the spray stem's mode.
    pub fn spray_mode(&self) -> Option<SprayMode> {
        self.continuous.and_then(|c| c.stem.map(|s| s.mode))
    }
    /// Which demand is in force.
    pub fn control(&self) -> Control {
        self.control
    }
    /// R4-PZR-PI: the master's demand, heater request (W) and spray demand
    /// at the block's physical coordinates `x` (layout order).
    pub fn continuous_outputs(&self, x: &[f64]) -> Result<[f64; 3], Failure> {
        let c = self
            .continuous
            .ok_or_else(|| fatal("no continuous control is composed"))?;
        if x.len() != self.layout.len() {
            return Err(fatal("block coordinate layout"));
        }
        let d = c.master.demand(s(x[c.lag]), s(x[c.integral]));
        let u = if d.value >= c.master.spray_start_pa {
            c.master.spray_demand(d).value
        } else {
            0.
        };
        Ok([d.value, c.master.heater_request(d).value, u])
    }
    /// R4-PZR-PI: set the integral in physical coordinates `x` so the
    /// master's request at `x`'s lag is `request_w` (the commissioning of a
    /// held demand); a request outside the open heater range refuses.
    pub fn integral_for_request(&self, x: &[f64], request_w: f64) -> Result<f64, Failure> {
        let c = self
            .continuous
            .ok_or_else(|| fatal("no continuous control is composed"))?;
        let d = c.master.demand_for_request(request_w)?;
        Ok(d - (x[c.lag] - c.master.setpoint_pa))
    }
    /// R4-PZR-PI: the valve-path lock change the last transaction decided
    /// (`Some(true)` lock, `Some(false)` release), taken once.
    pub fn take_spray_lock_change(&mut self) -> Option<bool> {
        self.spray_lock_change.take()
    }
    /// R4-PZR-CONTINUOUS: put the continuous law in force (the S3
    /// composition's AUTO, before its consistent start); the held demand
    /// stops acting. Refused without a composed continuous control.
    /// Commissioning a commissioned block changes nothing.
    pub fn commission_continuous(&mut self) -> Result<(), Failure> {
        if self.continuous.is_none() {
            return Err(fatal(
                "the continuous normal control needs the section's continuousControl (R4-PZR-CONTINUOUS)",
            ));
        }
        self.control = Control::Continuous;
        Ok(())
    }
    /// Put a normal-control frame's demands in force (S3, IC-CTRL): the
    /// heater request by the banks' continuous split
    /// (`Heaters::bank_powers`, which rejects a request outside its range).
    /// The spray demand must be zero: no controlled-spray path is composed.
    /// Changes no coordinate; the caller owns the solver consequence (stop
    /// and continue or restart).
    pub fn apply_control(
        &mut self,
        t: f64,
        demand: &crate::control::pzr_pressure::Demand,
    ) -> Result<ControlApplied, Failure> {
        if self.control == Control::Continuous {
            return Err(fatal(format!(
                "a held heater demand at {t} s, but the continuous law is in force (R4-PZR-CONTINUOUS)"
            )));
        }
        if demand.spray_target != 0. {
            return Err(fatal(format!(
                "controlled-spray demand {} at {t} s, but no controlled-spray material path is composed",
                demand.spray_target
            )));
        }
        let bank_power_w = self.heaters.bank_powers(demand.heater_request_w)?;
        let applied = ControlApplied {
            t_s: t,
            request_before_w: self.request_w,
            request_after_w: demand.heater_request_w,
            banks_before_w: self.bank_power_w.clone(),
            banks_after_w: bank_power_w.clone(),
        };
        self.request_w = demand.heater_request_w;
        self.bank_power_w = bank_power_w;
        Ok(applied)
    }
    pub fn bank_power_w(&self) -> &[f64] {
        &self.bank_power_w
    }
    pub fn saturation_temperature_k(&self) -> f64 {
        self.saturation_temperature_k
    }
    /// Record the account's terms at the following value evaluations
    /// (`true`) or stop (`false`). Every value evaluation replaces the
    /// record, so it is always the last value evaluation's or none; only the
    /// conservation account turns it on, around its own evaluation.
    pub fn capture_account(&mut self, on: bool) {
        self.capture = on;
    }
    /// The last captured value evaluation's account terms.
    pub fn captured(&self) -> Option<Ledger> {
        self.captured
    }
    /// First steel coordinate.
    pub fn metal_base(&self) -> usize {
        usize::from(self.relief.is_some())
    }
    /// Declare the lift's root bound (full strokes): the harness's absolute
    /// tolerance of the lift (G12: S1's scaled floor times its scale).
    pub fn declare_lift_root_bound(&mut self, bound: f64) -> Result<(), Failure> {
        if !(bound.is_finite() && bound >= 0.) {
            return Err(fatal(format!("lift root bound {bound}")));
        }
        self.lift_root_bound = Some(bound);
        Ok(())
    }

    /// The cell's boundary on `column` and every own row in physical units
    /// (`rows`, layout order), at the block's coordinates `x`; `record`
    /// marks a value evaluation, whose account terms replace the record
    /// while the account captures them.
    pub fn boundary<P: WaterProperties>(
        &mut self,
        properties: &P,
        cell: &Cell,
        column: &Column,
        x: Coordinates<'_>,
        rows: &mut [Scalar],
        record: bool,
    ) -> Result<Boundary, Failure> {
        let n = self.layout.len();
        if x.len() != n || rows.len() != n {
            return Err(fatal("block coordinate layout"));
        }
        let base = self.metal_base();
        let segments = self.heaters.segments().len();
        let metal_end = base + segments + self.walls.elements().len();
        let rod: Vec<Scalar> = (base..base + segments).map(|i| x.value(i)).collect();
        let wall: Vec<Scalar> = (base + segments..metal_end).map(|i| x.value(i)).collect();
        // R4-PZR-CONTINUOUS: the demand in force, each bank's power with
        // its direction (zero for a held demand), and the lag's row.
        let demand = self
            .continuous
            .map(|c| c.master.demand(x.value(c.lag), x.value(c.integral)));
        let banks: Vec<Scalar> = match (self.control, self.continuous, demand) {
            (Control::Continuous, Some(c), Some(d)) => self
                .heaters
                .smooth_bank_split(c.master.heater_request(d), c.master.split_width_w())?,
            (Control::Continuous, _, _) => {
                return Err(fatal("continuous control without its channel lag"));
            }
            (Control::Held, _, _) => self.bank_power_w.iter().map(|p| s(*p)).collect(),
        };
        let bank_power_w: Vec<f64> = banks.iter().map(|p| p.value).collect();
        // HOOK (COST2): one property boundary for the call, its turnovers
        // held across calls (every answer the one a fresh query returns).
        let shared = crate::thermal::Shared::with_held(properties, &self.turnovers);
        let rates = self.walls.rates(
            cell,
            column,
            &self.heaters,
            &rod,
            &bank_power_w,
            &wall,
            &shared,
        )?;
        let sources = rates
            .rod_metal_rates()
            .into_iter()
            .chain(rates.wall_metal_rates());
        for (j, source) in sources.enumerate() {
            rows[base + j] = x.rate(base + j) - source;
        }
        if let (Some(c), Some(d)) = (self.continuous, demand) {
            let lag = c.lag;
            // A rod segment's Joule power is its bank's times its share; the
            // walls' laws take the bank powers' values, so the direction of
            // the continuous request enters the steel rows here.
            if self.control == Control::Continuous {
                for (j, g) in self.heaters.segments().iter().enumerate() {
                    rows[base + j] =
                        rows[base + j] - Scalar::new(0., banks[g.bank].direction * g.power_share);
                }
            }
            rows[lag] = x.rate(lag) - (column.roof_pressure - x.value(lag)) / s(c.master.lag_s);
            // R4-PZR-PI: the integral and the stem; both held before
            // commissioning.
            let i = c.integral;
            rows[i] = match self.control {
                Control::Continuous => x.rate(i) - c.master.integral_rate(d, x.value(i)),
                Control::Held => x.rate(i),
            };
            if let Some(st) = c.stem {
                let k = st.index;
                rows[k] = match (self.control, st.mode) {
                    (Control::Held, _) | (_, SprayMode::Locked) => x.rate(k),
                    (Control::Continuous, SprayMode::Tracking) => {
                        let u = c.master.spray_demand(d);
                        let r = st.strokes_per_s;
                        x.rate(k)
                            - crate::control::cvcs::clamp(
                                (u - x.value(k)) / s(c.master.spray_stem_time_constant_s),
                                [-r, r],
                            )
                    }
                    (Control::Continuous, SprayMode::Closing) => x.rate(k) + s(st.strokes_per_s),
                };
            }
        }
        let relief = self.relief.map(|r| {
            rows[0] = x.rate(0) - s(r.device.lift_rate(r.motion));
            ReliefState {
                lift: x.value(0),
                isolation: s(self.open_fraction),
                back_pressure_pa: Some(s(r.back_pressure_pa)),
            }
        });
        let boundary = Boundary {
            heat: Heat::zero(),
            heaters: rates.heater_receipts(),
            walls: rates.wall_receipts(),
            relief,
        };
        if record {
            self.captured = self.capture.then(|| Ledger {
                joule_w: rates.rods.iter().map(|r| r.joule_w).sum::<f64>()
                    + rates.walls.iter().map(|w| w.joule_w.value).sum::<f64>(),
                exterior_w: rates.walls.iter().map(|w| w.exterior_w.value).sum(),
            });
        }
        Ok(boundary)
    }

    /// Root functions: the relief's demand and travel (with a relief),
    /// then with the continuous master's spray stem (R4-PZR-PI, S-b) the
    /// spray root `D − s0` and the closing stem's `x` (each the constant
    /// [`DISARMED`] when it cannot act).
    pub fn root_count(&self) -> usize {
        let relief = if self.relief.is_some() { 2 } else { 0 };
        relief
            + if self.stem_coordinate().is_some() {
                2
            } else {
                0
            }
    }
    /// The roots at the roof pressure and the block's physical coordinates.
    pub fn roots(&self, roof_pressure_pa: f64, x: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if x.len() != self.layout.len() || out.len() != self.root_count() {
            return Err(fatal("root layout"));
        }
        let mut k = 0;
        if let Some(r) = &self.relief {
            out[..2].copy_from_slice(&r.roots(roof_pressure_pa, x[0]));
            k = 2;
        }
        if let Some(c) = self.continuous
            && let Some(st) = c.stem
        {
            let armed = self.control == Control::Continuous;
            out[k] = if armed {
                c.master
                    .spray_root(c.master.demand(s(x[c.lag]), s(x[c.integral])).value)
            } else {
                DISARMED
            };
            out[k + 1] = if armed && st.mode == SprayMode::Closing {
                x[st.index]
            } else {
                DISARMED
            };
        }
        if out.iter().any(|v| !v.is_finite()) {
            return Err(fatal("nonfinite PZR root"));
        }
        Ok(())
    }
    /// The transactions at located roots on the block's physical
    /// coordinates `y`: the relief's (only the lift may change, by the
    /// mechanical stop), then the spray stem's (R4-PZR-PI): the spray root
    /// rising releases a locked valve or turns a closing stem back to
    /// tracking, falling starts closing; the closing stem reaching 0 sets it
    /// exactly to 0 and locks. A lock change is left for the operator
    /// ([`Pzr::take_spray_lock_change`]).
    pub fn transact(
        &mut self,
        t: f64,
        directions: &[i32],
        roof_pressure_pa: f64,
        y: &mut [f64],
    ) -> Result<Transaction, Failure> {
        if directions.len() != self.root_count() || y.len() != self.layout.len() {
            return Err(fatal("transaction layout"));
        }
        let nr = if self.relief.is_some() { 2 } else { 0 };
        let mut receipt = json!({"owner":"pzr","t_s":t,"relief":null});
        if let Some(relief) = self.relief.as_mut()
            && directions[..2].iter().any(|d| *d != 0)
        {
            let located = y[0];
            let bound = match (directions[1], self.lift_root_bound) {
                (0, _) => 0.,
                (_, Some(b)) => b,
                (_, None) => {
                    return Err(fatal(
                        "a relief travel stop needs the declared lift root bound",
                    ));
                }
            };
            let event = relief.transact([directions[0], directions[1]], &mut y[0], bound)?;
            receipt = json!({"owner":"pzr","t_s":t,"roof_pressure_pa":roof_pressure_pa,
                "demand_root":directions[0],"travel_root":directions[1],
                "before":{"demand_open":event.before.0,"motion":format!("{:?}",event.before.1)},
                "after":{"demand_open":event.after.0,"motion":format!("{:?}",event.after.1)},
                "lift_located":located,"lift_after":y[0],
                "stop":event.stop.map(|r| json!({"motion_before":format!("{:?}",r.motion_before),
                    "motion_after":format!("{:?}",r.motion_after),"lift_before":r.lift_before,
                    "lift_after":r.lift_after,"defect":r.defect})),
                "lift_rate_per_s":relief.device.lift_rate(relief.motion),
                "stateChanged":event.before != event.after});
        }
        if let Some(c) = self.continuous.as_mut()
            && let Some(st) = c.stem.as_mut()
            && directions[nr..nr + 2].iter().any(|d| *d != 0)
        {
            let (spray, arrival) = (directions[nr], directions[nr + 1]);
            let before = st.mode;
            let located = y[st.index];
            let d = c.master.demand(s(y[c.lag]), s(y[c.integral])).value;
            // The closing stem's arrival first, then the spray root.
            if arrival < 0 && st.mode == SprayMode::Closing {
                y[st.index] = 0.;
                st.mode = SprayMode::Locked;
                self.spray_lock_change = Some(true);
            }
            match (spray.signum(), st.mode) {
                (1, SprayMode::Locked) => {
                    if y[st.index] != 0. {
                        return Err(fatal(format!(
                            "the locked spray stem at {} on release",
                            y[st.index]
                        )));
                    }
                    st.mode = SprayMode::Tracking;
                    // A lock and a release at one instant cancel.
                    self.spray_lock_change = match self.spray_lock_change {
                        Some(true) => None,
                        _ => Some(false),
                    };
                }
                (1, SprayMode::Closing) => st.mode = SprayMode::Tracking,
                (-1, SprayMode::Tracking) => {
                    if y[st.index] > 0. {
                        st.mode = SprayMode::Closing;
                    } else {
                        y[st.index] = 0.;
                        st.mode = SprayMode::Locked;
                        self.spray_lock_change = Some(true);
                    }
                }
                _ => {}
            }
            receipt["spray"] = json!({"spray_root":spray,"arrival_root":arrival,
                "demand_pa":d,"spray_start_pa":c.master.spray_start_pa,
                "stem_located":located,"stem_after":y[st.index],
                "before":before.name(),"after":st.mode.name(),
                "lock_change":self.spray_lock_change,
                "stateChanged":before != st.mode});
        }
        Ok(Transaction {
            deposits: Vec::new(),
            receipt,
        })
    }
    /// The block's copyable discrete state (S5 snapshot, PLATFORM; S3-D19):
    /// the held heater demand and each bank's delivered power (a control
    /// frame changes them, [`Pzr::apply_control`]), as exact IEEE bits, or
    /// under the continuous law (R4-PZR-CONTINUOUS) only that it is in force
    /// (its demand is a function of the lag coordinate); and the relief's
    /// demand latch and motion (null without a relief) — never coordinates
    /// or caches.
    pub fn discrete_state(&self) -> serde_json::Value {
        let bits = |v: f64| format!("{:016x}", v.to_bits());
        let relief = self.relief.map_or(serde_json::Value::Null, |r| {
            let mut v = json!({"demand_open": r.demand_open, "motion": match r.motion {
                ReliefMotion::Closed => "closed", ReliefMotion::Opening => "opening",
                ReliefMotion::Open => "open", ReliefMotion::Closing => "closing",
            }});
            // HOOK (C4 lane): the declared malfunction, only once declared.
            if r.stuck_open {
                v["stuck_open"] = json!(true);
            }
            // R4-RELIEF-ISO: the valve, only once it has left full open.
            if let Some(valve) = self
                .isolation
                .filter(|v| v.motion.is_some() || v.position != 1.)
            {
                v["isolation"] = json!({"position": bits(valve.position),
                    "motion": valve.motion.map(|(from, rate)| [bits(from), bits(rate)])});
            }
            v
        });
        if self.control == Control::Continuous {
            let spray = self
                .spray_mode()
                .map_or(serde_json::Value::Null, |m| json!(m.name()));
            return json!({"heater_control": "continuous", "spray": spray, "relief": relief});
        }
        json!({
            "heater_request_w": bits(self.request_w),
            "bank_power_w": self.bank_power_w.iter().map(|v| bits(*v)).collect::<Vec<_>>(),
            "relief": relief,
        })
    }
    /// Restore [`Pzr::discrete_state`] exactly; any layout or key mismatch
    /// refuses, and so does the continuous form on a block without its
    /// continuous control.
    pub fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure> {
        let continuous = state.get("heater_control").is_some();
        let keys: &[&str] = if continuous {
            &["heater_control", "spray", "relief"]
        } else {
            &["heater_request_w", "bank_power_w", "relief"]
        };
        let o = snapshot_object(state, "pzr", keys)?;
        if continuous && (o["heater_control"] != json!("continuous") || self.continuous.is_none()) {
            return Err(fatal(format!(
                "snapshot: heater control {} on a block {} continuous control",
                o["heater_control"],
                if self.continuous.is_some() {
                    "with"
                } else {
                    "without"
                }
            )));
        }
        let bits = |v: &serde_json::Value| -> Result<f64, Failure> {
            v.as_str()
                .filter(|h| h.len() == 16)
                .and_then(|h| u64::from_str_radix(h, 16).ok())
                .map(f64::from_bits)
                .ok_or_else(|| fatal(format!("snapshot: PZR power {v}")))
        };
        let spray = if continuous {
            match (self.spray_mode(), &o["spray"]) {
                (None, serde_json::Value::Null) => None,
                (Some(_), v) if !v.is_null() => Some(SprayMode::parse(v)?),
                (_, v) => {
                    return Err(fatal(format!(
                        "snapshot: spray stem mode {v} against the block's spray stem"
                    )));
                }
            }
        } else {
            None
        };
        let held = if continuous {
            None
        } else {
            let request_w = bits(&o["heater_request_w"])?;
            let banks = o["bank_power_w"]
                .as_array()
                .filter(|a| a.len() == self.bank_power_w.len())
                .ok_or_else(|| fatal("snapshot: one power per heater bank"))?
                .iter()
                .map(bits)
                .collect::<Result<Vec<f64>, Failure>>()?;
            Some((request_w, banks))
        };
        match (self.relief.as_mut(), &o["relief"]) {
            (None, serde_json::Value::Null) => {}
            (Some(relief), v) if !v.is_null() => {
                // HOOK (C4 lane): a declared fails-open malfunction is the
                // third key, present only once declared and only as true.
                let stuck_open = v.get("stuck_open").is_some();
                // R4-RELIEF-ISO: the valve, present only once it has left
                // full open.
                let moved = v.get("isolation");
                let mut keys = vec!["demand_open", "motion"];
                if stuck_open {
                    keys.push("stuck_open");
                }
                if moved.is_some() {
                    keys.push("isolation");
                }
                let r = snapshot_object(v, "pzr relief", &keys)?;
                match (self.isolation.as_mut(), moved) {
                    (Some(valve), Some(m)) => {
                        let m =
                            snapshot_object(m, "pzr relief isolation", &["position", "motion"])?;
                        valve.position = bits(&m["position"])?;
                        valve.motion = match &m["motion"] {
                            serde_json::Value::Null => None,
                            pair => {
                                let pair = pair
                                    .as_array()
                                    .filter(|a| a.len() == 2)
                                    .ok_or_else(|| fatal("snapshot: relief isolation motion"))?;
                                Some((bits(&pair[0])?, bits(&pair[1])?))
                            }
                        };
                    }
                    (Some(valve), None) => {
                        valve.position = 1.;
                        valve.motion = None;
                    }
                    (None, None) => {}
                    (None, Some(_)) => {
                        return Err(fatal("snapshot: a relief isolation state with no valve"));
                    }
                }
                if stuck_open && r["stuck_open"] != json!(true) {
                    return Err(fatal(
                        "snapshot: relief stuck_open must be true when present",
                    ));
                }
                let demand_open = r["demand_open"]
                    .as_bool()
                    .ok_or_else(|| fatal("snapshot: relief demand latch"))?;
                let motion = match r["motion"].as_str() {
                    Some("closed") => ReliefMotion::Closed,
                    Some("opening") => ReliefMotion::Opening,
                    Some("open") => ReliefMotion::Open,
                    Some("closing") => ReliefMotion::Closing,
                    other => return Err(fatal(format!("snapshot: relief motion {other:?}"))),
                };
                relief.demand_open = demand_open;
                relief.motion = motion;
                relief.stuck_open = stuck_open;
            }
            (_, other) => {
                return Err(fatal(format!(
                    "snapshot: relief state {other} against the block's relief presence"
                )));
            }
        }
        match held {
            // The held demand of a continuous snapshot is not state: it is
            // the composition's until a held form is restored.
            None => self.control = Control::Continuous,
            Some((request_w, banks)) => {
                self.request_w = request_w;
                self.bank_power_w = banks;
                self.control = Control::Held;
            }
        }
        // A held snapshot's stem rests locked (the held form has no spray).
        if let Some(c) = self.continuous.as_mut()
            && let Some(st) = c.stem.as_mut()
        {
            st.mode = spray.unwrap_or(SprayMode::Locked);
        }
        self.spray_lock_change = None;
        Ok(())
    }
    /// The held heater demand changes only at control frames
    /// ([`Pzr::apply_control`]), the continuous one only with the lag, and
    /// the relief answers its own demand: a command changes nothing here.
    ///
    /// HOOK (C4 lane, for KERN/G6): [`super::block::Command::ReliefStuckOpen`]
    /// is the relief's own malfunction ([`Relief::stick_open`]); a block
    /// without a relief refuses it.
    pub fn command(
        &mut self,
        t: f64,
        command: super::block::Command,
    ) -> Result<Transaction, Failure> {
        if command == super::block::Command::ReliefStuckOpen {
            let relief = self
                .relief
                .as_mut()
                .ok_or_else(|| fatal("ReliefStuckOpen: the block composes no relief"))?;
            let event = relief.stick_open()?;
            return Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"pzr","t_s":t,"command":command,
                    "before":{"demand_open":event.before.0,"motion":format!("{:?}",event.before.1)},
                    "after":{"demand_open":event.after.0,"motion":format!("{:?}",event.after.1)},
                    "stuck_open":true,"lift_rate_per_s":relief.device.lift_rate(relief.motion),
                    "stateChanged":true}),
            });
        }
        let receipt = match self.control {
            Control::Held => json!({"owner":"pzr","t_s":t,"command":command,
                "heaterDemand_W":self.request_w,"note":"heater demand in force; it changes only at control frames"}),
            Control::Continuous => json!({"owner":"pzr","t_s":t,"command":command,
                "heaterDemand":"continuous","note":"the continuous pressure master on the PT1 channel lag and its integral (R4-PZR-PI)"}),
        };
        Ok(Transaction {
            deposits: Vec::new(),
            receipt,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_isolation_valve_moves_at_one_stroke_and_arrests_where_it_is() {
        let mut v = Isolation {
            stroke_s: 2.,
            position: 1.,
            motion: None,
        };
        assert_eq!(v.open_fraction(5.), 1.);
        assert!(!v.drive(5., 1.), "already open");
        assert!(v.drive(10., 0.));
        assert!(!v.drive(10.5, 0.), "already closing");
        assert_eq!(v.open_fraction(11.), 0.5);
        assert_eq!(v.arrival(), Some(12.));
        // Reversal starts from the achieved position.
        assert!(v.drive(11., 1.));
        assert_eq!(v.arrival(), Some(12.));
        v.arrest(11.5);
        assert_eq!((v.position, v.motion), (0.75, None));
        assert_eq!(v.arrival(), None);
        // An arrested valve keeps no intent: it stands, with no stroke end
        // to reach, until the next command.
        assert_eq!(v.open_fraction(60.), 0.75);
        assert_eq!(v.target(), None);
    }

    fn relief() -> Relief {
        Relief {
            port: 2,
            device: ReliefDevice {
                opening_pa: 15.8e6,
                reseat_pa: 15.6e6,
                full_strokes_per_s: 20.,
                effective_area_per_lift_m2: 0.004,
            },
            back_pressure_pa: 101_325.,
            motion: ReliefMotion::Closed,
            demand_open: false,
            stuck_open: false,
        }
    }

    #[test]
    fn a_stuck_open_relief_opens_at_its_rate_and_never_reseats() {
        // HOOK (C4 lane): the declared fails-open malfunction.
        let mut r = relief();
        let e = r.stick_open().unwrap();
        assert_eq!(e.before, (false, ReliefMotion::Closed));
        assert_eq!(e.after, (true, ReliefMotion::Opening));
        // Demand disarmed far below the reseat pressure; travel armed.
        let roots = r.roots(10e6, 0.5);
        assert_eq!(roots[0], DISARMED);
        assert!((roots[1] - 0.5).abs() < 1e-15);
        // The stop at full lift leaves it open with the demand held.
        let mut lift = 1.;
        let e = r.transact([0, 1], &mut lift, 1e-6).unwrap();
        assert_eq!(e.after, (true, ReliefMotion::Open));
        assert_eq!(r.roots(10e6, 1.), [DISARMED, DISARMED]);
        // A crossing of the disarmed demand refuses; a second stick refuses.
        assert!(r.transact([-1, 0], &mut lift, 1e-6).is_err());
        assert!(r.stick_open().is_err());
    }

    #[test]
    fn closed_relief_watches_the_opening_pressure_with_travel_disarmed() {
        let r = relief();
        assert_eq!(r.roots(15.0e6, 0.), [15.0e6 - 15.8e6, DISARMED]);
        assert_eq!(r.roots(15.9e6, 0.), [15.9e6 - 15.8e6, DISARMED]);
    }

    #[test]
    fn rising_demand_opens_and_the_full_lift_stop_sets_exactly_one() {
        let mut r = relief();
        let mut lift = 0.;
        let e = r.transact([1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (true, ReliefMotion::Opening));
        assert_eq!(lift, 0.);
        // While opening the demand watches the reseat and travel 1 − lift.
        assert_eq!(r.roots(15.9e6, 0.25), [15.9e6 - 15.6e6, 0.75]);
        let mut lift = 1. - 3e-9;
        let e = r.transact([0, -1], &mut lift, 1e-8).unwrap();
        assert_eq!(lift, 1.);
        assert_eq!(e.after, (true, ReliefMotion::Open));
        let stop = e.stop.unwrap();
        assert_eq!(stop.lift_after, 1.);
        assert_eq!(stop.defect, (1. - 3e-9) - 1.);
        assert_eq!(r.roots(15.7e6, 1.)[1], DISARMED);
    }

    #[test]
    fn falling_demand_closes_and_the_seat_transaction_sets_exactly_zero() {
        let mut r = Relief {
            motion: ReliefMotion::Open,
            demand_open: true,
            ..relief()
        };
        let mut lift = 1.;
        let e = r.transact([-1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (false, ReliefMotion::Closing));
        // Closing: demand watches the opening pressure again, travel = lift.
        assert_eq!(r.roots(15.5e6, 0.4), [15.5e6 - 15.8e6, 0.4]);
        let mut lift = 2e-9;
        let e = r.transact([0, -1], &mut lift, 1e-8).unwrap();
        assert_eq!(lift, 0.);
        assert_eq!(e.after, (false, ReliefMotion::Closed));
        assert_eq!(e.stop.unwrap().lift_after, 0.);
    }

    #[test]
    fn a_reversal_mid_travel_turns_the_lift_without_a_stop() {
        let mut r = Relief {
            motion: ReliefMotion::Opening,
            demand_open: true,
            ..relief()
        };
        let mut lift = 0.6;
        let e = r.transact([-1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (false, ReliefMotion::Closing));
        assert_eq!(lift, 0.6);
        assert!(e.stop.is_none());
        let e = r.transact([1, 0], &mut lift, 1e-8).unwrap();
        assert_eq!(e.after, (true, ReliefMotion::Opening));
    }

    #[test]
    fn a_stop_and_a_demand_at_the_same_instant_take_the_stop_first() {
        let mut r = Relief {
            motion: ReliefMotion::Opening,
            demand_open: true,
            ..relief()
        };
        let mut lift = 1.;
        let e = r.transact([-1, -1], &mut lift, 1e-8).unwrap();
        assert_eq!(lift, 1.);
        assert_eq!(e.stop.unwrap().motion_after, ReliefMotion::Open);
        assert_eq!(e.after, (false, ReliefMotion::Closing));
    }

    #[test]
    fn contradicting_crossings_and_far_stops_refuse() {
        let mut r = relief();
        let mut lift = 0.;
        assert!(matches!(
            r.transact([-1, 0], &mut lift, 1e-8),
            Err(Failure::Fatal(_))
        ));
        let mut r = Relief {
            motion: ReliefMotion::Closing,
            ..relief()
        };
        let mut lift = 1e-6;
        assert!(r.transact([0, -1], &mut lift, 1e-8).is_err());
        assert_eq!(lift, 1e-6);
        // A lift at rest has no travel to stop.
        let mut r = relief();
        let mut lift = 0.;
        assert!(r.transact([0, 1], &mut lift, 1e-8).is_err());
    }
}

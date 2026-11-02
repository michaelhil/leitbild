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
//! banks take the request by the equipment's continuous split. The S2
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
    /// The compiler's consumed pages, for receipts only.
    pub provenance: serde_json::Value,
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
    /// The heater demand in force (W; P4's until a control frame) and each
    /// bank's delivered power.
    request_w: f64,
    bank_power_w: Vec<f64>,
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
    /// `Tsat(p_s)`, and the steel as `steel` prepares it. Refuses a relief
    /// port whose demand would not read the roof pressure (PT1 below the
    /// roof), a nonpositive backpressure, a heater demand outside the banks'
    /// range, and steady steel that is not one store per steel coordinate in
    /// layout order with its energy's own 304 temperature.
    pub fn new(
        cell: &Cell,
        section: &Section,
        steel: SteelPreparation<'_>,
        saturation_temperature_k: f64,
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
        layout.validate("pzr")?;
        Ok(Self {
            heaters,
            walls,
            relief,
            request_w,
            bank_power_w,
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
    /// The heater demand in force, W: P4's prepared demand until a
    /// controller frame replaces it.
    pub fn request_w(&self) -> f64 {
        self.request_w
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
        let rod: Vec<Scalar> = (base..base + segments).map(|i| x.value(i)).collect();
        let wall: Vec<Scalar> = (base + segments..n).map(|i| x.value(i)).collect();
        // HOOK (COST2): one property boundary for the call, its turnovers
        // held across calls (every answer the one a fresh query returns).
        let shared = crate::thermal::Shared::with_held(properties, &self.turnovers);
        let rates = self.walls.rates(
            cell,
            column,
            &self.heaters,
            &rod,
            &self.bank_power_w,
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
        let relief = self.relief.map(|r| {
            rows[0] = x.rate(0) - s(r.device.lift_rate(r.motion));
            ReliefState {
                lift: x.value(0),
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

    /// Root functions: the relief's demand and travel, none without one.
    pub fn root_count(&self) -> usize {
        if self.relief.is_some() { 2 } else { 0 }
    }
    /// The roots at the roof pressure and the block's physical coordinates.
    pub fn roots(&self, roof_pressure_pa: f64, x: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if x.len() != self.layout.len() || out.len() != self.root_count() {
            return Err(fatal("root layout"));
        }
        if let Some(r) = &self.relief {
            out.copy_from_slice(&r.roots(roof_pressure_pa, x[0]));
        }
        if out.iter().any(|v| !v.is_finite()) {
            return Err(fatal("nonfinite relief root"));
        }
        Ok(())
    }
    /// The relief's transaction at located roots on the block's physical
    /// coordinates `y`; only the lift may change, by the mechanical stop.
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
        let Some(relief) = self.relief.as_mut() else {
            return Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"owner":"pzr","t_s":t,"relief":null}),
            });
        };
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
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"pzr","t_s":t,"roof_pressure_pa":roof_pressure_pa,
                "demand_root":directions[0],"travel_root":directions[1],
                "before":{"demand_open":event.before.0,"motion":format!("{:?}",event.before.1)},
                "after":{"demand_open":event.after.0,"motion":format!("{:?}",event.after.1)},
                "lift_located":located,"lift_after":y[0],
                "stop":event.stop.map(|r| json!({"motion_before":format!("{:?}",r.motion_before),
                    "motion_after":format!("{:?}",r.motion_after),"lift_before":r.lift_before,
                    "lift_after":r.lift_after,"defect":r.defect})),
                "lift_rate_per_s":relief.device.lift_rate(relief.motion),
                "stateChanged":event.before != event.after}),
        })
    }
    /// The block's copyable discrete state (S5 snapshot, PLATFORM; S3-D19):
    /// the heater demand in force and each bank's delivered power (a
    /// control frame changes them, [`Pzr::apply_control`]), as exact IEEE
    /// bits, and the relief's demand latch and motion (null without a
    /// relief) — never coordinates or caches.
    pub fn discrete_state(&self) -> serde_json::Value {
        let bits = |v: f64| format!("{:016x}", v.to_bits());
        json!({
            "heater_request_w": bits(self.request_w),
            "bank_power_w": self.bank_power_w.iter().map(|v| bits(*v)).collect::<Vec<_>>(),
            "relief": self.relief.map_or(serde_json::Value::Null, |r| {
                let mut v = json!({"demand_open": r.demand_open, "motion": match r.motion {
                    ReliefMotion::Closed => "closed", ReliefMotion::Opening => "opening",
                    ReliefMotion::Open => "open", ReliefMotion::Closing => "closing",
                }});
                // HOOK (C4 lane): the declared malfunction, only once declared.
                if r.stuck_open {
                    v["stuck_open"] = json!(true);
                }
                v
            }),
        })
    }
    /// Restore [`Pzr::discrete_state`] exactly; any layout or key mismatch
    /// refuses.
    pub fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure> {
        let o = snapshot_object(
            state,
            "pzr",
            &["heater_request_w", "bank_power_w", "relief"],
        )?;
        let bits = |v: &serde_json::Value| -> Result<f64, Failure> {
            v.as_str()
                .filter(|h| h.len() == 16)
                .and_then(|h| u64::from_str_radix(h, 16).ok())
                .map(f64::from_bits)
                .ok_or_else(|| fatal(format!("snapshot: PZR power {v}")))
        };
        let request_w = bits(&o["heater_request_w"])?;
        let banks = o["bank_power_w"]
            .as_array()
            .filter(|a| a.len() == self.bank_power_w.len())
            .ok_or_else(|| fatal("snapshot: one power per heater bank"))?
            .iter()
            .map(bits)
            .collect::<Result<Vec<f64>, Failure>>()?;
        match (self.relief.as_mut(), &o["relief"]) {
            (None, serde_json::Value::Null) => {}
            (Some(relief), v) if !v.is_null() => {
                // HOOK (C4 lane): a declared fails-open malfunction is the
                // third key, present only once declared and only as true.
                let stuck_open = v.get("stuck_open").is_some();
                let keys: &[&str] = if stuck_open {
                    &["demand_open", "motion", "stuck_open"]
                } else {
                    &["demand_open", "motion"]
                };
                let r = snapshot_object(v, "pzr relief", keys)?;
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
        self.request_w = request_w;
        self.bank_power_w = banks;
        Ok(())
    }
    /// The heater demand changes only at control frames
    /// ([`Pzr::apply_control`]) and the relief answers its own demand: a
    /// command changes nothing here.
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
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner":"pzr","t_s":t,"command":command,
                "heaterDemand_W":self.request_w,"note":"heater demand in force; it changes only at control frames"}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

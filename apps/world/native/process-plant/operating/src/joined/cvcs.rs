//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/inventory-and-chemistry.md#compact-normal-inventory-control-plan-r4-1-november-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/inventory-and-chemistry.md#equipment-and-material-routes
//! The CVCS owner (plan r4 X4.2, R4-CVCS): charging, letdown and the two
//! source transfers in the compact allocation `ld01-cvcs`, with the normal
//! inventory controller realized continuously ([`crate::control::cvcs`]).
//!
//! Fourteen single coordinates, all differential:
//! - six tank stocks: BLEND mass and absorber, WATER and CONCENTRATE mass
//!   (they only deliver, at their prepared concentrations), RECEIVER mass
//!   and absorber. The pools are isothermal at their 40 °C preparation, so
//!   no energy coordinate is needed;
//! - eight controller states: the PZR level and loop-average lags, and per
//!   branch the flow lag, the integral and the stem.
//!
//! Both branches meet the network at COLD.A as one liquid receipt: charging
//! enters with the pump-discharge enthalpy and BLEND's concentration,
//! letdown leaves with COLD.A's own liquid enthalpy and concentration. The
//! rows read the network's fluid state (COLD.A, the leg cells) and the PZR
//! cell's coordinates (the LT law) of the same evaluation.
use super::block::{
    Class, Coordinates, Crossing, Layout, OwnerAccount, Transaction, snapshot_object,
};
use crate::{
    control::cvcs::{Controller, Program, clamp},
    network::{Failure, Fluid, Properties, Receipts, ports::G, stratified},
    thermal::{Scalar, WaterProperties},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("CVCS: {}", reason.into()))
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("CVCS: {reason}"))
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
/// `sqrt(v)` with its direction; `v` must be positive.
fn sqrt(v: Scalar) -> Scalar {
    let r = v.value.sqrt();
    Scalar::new(r, v.direction / (2. * r))
}

/// The network port: COLD.A at +3 m.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Port {
    pub region: usize,
    pub id: String,
    pub elevation_m: f64,
}
/// One loop's leg cells (network regions), mass-weighted per leg.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Legs {
    #[serde(rename = "loop")]
    pub loop_id: String,
    pub hot: Vec<usize>,
    pub cold: Vec<usize>,
}
/// `ld01-pzr-level-channels`' indication law and lag.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Level {
    #[serde(rename = "calibrationPressure_Pa")]
    pub calibration_pressure_pa: f64,
    #[serde(rename = "interfaceSpan_Pa")]
    pub interface_span_pa: [f64; 2],
    #[serde(rename = "indicatedSpan_m")]
    pub indicated_span_m: [f64; 2],
    pub lag_s: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Charging {
    #[serde(rename = "nominalFlow_kg_s")]
    pub nominal_flow_kg_s: f64,
    #[serde(rename = "suctionPressure_Pa")]
    pub suction_pressure_pa: f64,
    #[serde(rename = "dischargePressure_Pa")]
    pub discharge_pressure_pa: f64,
    #[serde(rename = "shutoffPressure_Pa")]
    pub shutoff_pressure_pa: f64,
    #[serde(rename = "receiverPressure_Pa")]
    pub receiver_pressure_pa: f64,
    #[serde(rename = "hydraulicEfficiency")]
    pub hydraulic_efficiency: f64,
    #[serde(rename = "fixedLoss_Pa")]
    pub fixed_loss_pa: f64,
    #[serde(rename = "fcvLoss_Pa")]
    pub fcv_loss_pa: f64,
    #[serde(rename = "referenceOpening")]
    pub reference_opening: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Letdown {
    #[serde(rename = "nominalFlow_kg_s")]
    pub nominal_flow_kg_s: f64,
    #[serde(rename = "upstreamPressure_Pa")]
    pub upstream_pressure_pa: f64,
    #[serde(rename = "trimInletPressure_Pa")]
    pub trim_inlet_pressure_pa: f64,
    #[serde(rename = "receiverPressure_Pa")]
    pub receiver_pressure_pa: f64,
    #[serde(rename = "referenceOpening")]
    pub reference_opening: f64,
    #[serde(rename = "coolerOutletTemperature_K")]
    pub cooler_outlet_temperature_k: f64,
}
/// One vented pool of `reference-chemistry-lifecycle` (depths above its
/// floor).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Tank {
    pub area_m2: f64,
    #[serde(rename = "initialVolume_m3")]
    pub initial_volume_m3: f64,
    /// `None` for BLEND: its absorber follows the initial-condition rule
    /// [`BlendInitial`].
    pub initial_ppm: Option<f64>,
    #[serde(rename = "stopHeight_m")]
    pub stop_height_m: f64,
    #[serde(rename = "resetHeight_m")]
    pub reset_height_m: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Tanks {
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
    pub height_m: f64,
    pub blend: Tank,
    pub water: Tank,
    pub concentrate: Tank,
    pub receiver: Tank,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LowBlend {
    pub stop_m3: f64,
    pub restart_m3: f64,
}

/// The packet's `cvcs` section, compiled from the strict blocks by
/// `reference-design-operating-cvcs.ts`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub port: Port,
    pub legs: Vec<Legs>,
    #[serde(rename = "pzrLevel")]
    pub pzr_level: Level,
    pub program: Program,
    pub controller: Controller,
    pub charging: Charging,
    pub letdown: Letdown,
    pub tanks: Tanks,
    #[serde(rename = "transferFlow_kg_s")]
    pub transfer_flow_kg_s: f64,
    #[serde(rename = "lowBlend")]
    pub low_blend: LowBlend,
    #[serde(rename = "blendInitialConcentration")]
    pub blend_initial: BlendInitial,
}

/// BLEND's absorber at the initial state (lead, plan r4 X4.2): an
/// initial-condition rule, not a value.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum BlendInitial {
    /// The primary's concentration at the initial state (COLD.A's liquid,
    /// where the makeup enters): automatic makeup blends to the RCS
    /// concentration.
    #[serde(rename = "primaryAtInitialState")]
    PrimaryAtInitialState,
}

// Coordinate order.
const BLEND_M: usize = 0;
const BLEND_B: usize = 1;
const WATER_M: usize = 2;
const CONC_M: usize = 3;
const RECV_M: usize = 4;
const RECV_B: usize = 5;
const LEVEL: usize = 6;
/// The loop-average lag (`CVCS.TAVG.lag`), also the post-trip Tavg mode's
/// input (R4-DUMP).
pub const TAVG: usize = 7;
/// Per branch: flow lag, inner integral, stem and the outer level
/// integral (R4-CVCS-PI), from the branch's base.
const BRANCH: [usize; 2] = [8, 12];
const FT: usize = 0;
const INTEGRAL: usize = 1;
const STEM: usize = 2;
const LEVEL_INTEGRAL: usize = 3;
pub const COORDINATES: usize = 16;
/// The level lag's row (local index), the only row reading the PZR cell.
pub const LEVEL_ROW: usize = LEVEL;

/// The two branches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Branch {
    Charging,
    Letdown,
}
impl Branch {
    fn index(self) -> usize {
        match self {
            Branch::Charging => 0,
            Branch::Letdown => 1,
        }
    }
    const ALL: [Branch; 2] = [Branch::Charging, Branch::Letdown];
}
/// The two source transfers into BLEND.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Source {
    /// WATER → BLEND (dilution).
    Water,
    /// CONCENTRATE → BLEND (boration).
    Concentrate,
}
/// A branch's request source.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub enum Request {
    Auto,
    /// AUTO withdrawn (unusable level or flow input): request zero.
    Withdrawn,
    /// An explicit MANUAL request (kg/s).
    Manual(#[serde(with = "super::block::snapshot_bits")] f64),
}
/// A branch's located stops, each needing its reset and an explicit
/// restart.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Stops {
    pub low_blend: bool,
    pub receiver_high: bool,
    pub support_loss: bool,
}
impl Stops {
    fn any(&self) -> bool {
        self.low_blend || self.receiver_high || self.support_loss
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BranchState {
    pub request: Request,
    pub stops: Stops,
}
/// The owner's copyable discrete state.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Modes {
    pub charging: BranchState,
    pub letdown: BranchState,
    /// Requested transfer flows (kg/s), as held inputs.
    #[serde(with = "super::block::snapshot_bits")]
    pub water_kg_s: f64,
    #[serde(with = "super::block::snapshot_bits")]
    pub concentrate_kg_s: f64,
    /// AC.B supplies CHARGE.P1.
    pub charging_supported: bool,
}
impl Modes {
    fn branch(&self, b: Branch) -> &BranchState {
        match b {
            Branch::Charging => &self.charging,
            Branch::Letdown => &self.letdown,
        }
    }
    fn branch_mut(&mut self, b: Branch) -> &mut BranchState {
        match b {
            Branch::Charging => &mut self.charging,
            Branch::Letdown => &mut self.letdown,
        }
    }
}

/// A CVCS command (plan r4 X4.2): MANUAL/AUTO, a restart after a stop, and
/// the boration and dilution transfers into BLEND.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Command {
    /// Both branches to AUTO.
    Auto,
    Manual {
        branch: Branch,
        request_kg_s: f64,
    },
    Restart {
        branch: Branch,
    },
    Transfer {
        source: Source,
        request_kg_s: f64,
    },
}

/// The values the last evaluation crossed at COLD.A, for the account.
#[derive(Clone, Copy, Debug, Default)]
struct Boundary {
    charging_kg_s: f64,
    charging_w: f64,
    charging_boron_kg_eq_s: f64,
    letdown_kg_s: f64,
    letdown_w: f64,
    letdown_boron_kg_eq_s: f64,
    water_kg_s: f64,
    concentrate_kg_s: f64,
}

/// The CVCS owner.
#[derive(Clone, Debug)]
pub struct Cvcs {
    section: Section,
    layout: Layout,
    prepared: Vec<f64>,
    modes: Modes,
    /// Tank liquid density and enthalpy at the pools' state (IF97, once).
    tank_density_kg_m3: f64,
    tank_enthalpy_j_kg: f64,
    /// CONCENTRATE's (constant) absorber per kg.
    concentrate_fraction: f64,
    /// The pump's nominal rise `dp0` and shutoff ratio `r`.
    rise_pa: f64,
    shutoff_ratio: f64,
    /// The LT law: the stratified cell, its first network coordinate and
    /// scales, and the calibration `L = a (p_low - p_high) + b`.
    pzr: stratified::Cell,
    pzr_base: usize,
    pzr_scales: Vec<f64>,
    level_a: f64,
    level_b: f64,
    boundary: Boundary,
    /// When set, the next value evaluation records the tracked point.
    prepare: bool,
    /// The initial-state preparation has set BLEND's absorber.
    prepared_blend: bool,
}

/// The network cells every row reads: COLD.A and the leg cells.
pub fn read_cells(section: &Section) -> Vec<usize> {
    let mut cells: Vec<usize> = std::iter::once(section.port.region)
        .chain(
            section
                .legs
                .iter()
                .flat_map(|l| l.hot.iter().chain(&l.cold).copied()),
        )
        .collect();
    cells.sort_unstable();
    cells.dedup();
    cells
}

impl Cvcs {
    /// Compose from the packet's section on the network's PZR cell
    /// (`pzr_base` its first coordinate, `scales` the network's).
    pub fn new<P: Properties + WaterProperties>(
        section: &Section,
        pzr: &stratified::Cell,
        pzr_base: usize,
        network_scales: &[f64],
        regular_cells: usize,
        properties: &P,
    ) -> Result<Self, Failure> {
        section.controller.validate()?;
        let c = &section.charging;
        let l = &section.letdown;
        let t = &section.tanks;
        let pos = |v: f64| v.is_finite() && v > 0.;
        let tanks = [t.blend, t.water, t.concentrate, t.receiver];
        if !(tanks.iter().all(|k| {
            pos(k.area_m2)
                && pos(k.initial_volume_m3)
                && k.initial_volume_m3 / k.area_m2 < t.height_m
        }) && t.blend.initial_ppm.is_none()
            && [t.water, t.concentrate, t.receiver]
                .iter()
                .all(|k| k.initial_ppm.is_some_and(|v| v.is_finite() && v >= 0.))
            && pos(t.height_m)
            && [c.nominal_flow_kg_s, c.hydraulic_efficiency, c.fixed_loss_pa, c.fcv_loss_pa]
                .into_iter()
                .all(pos)
            && c.suction_pressure_pa < c.receiver_pressure_pa
            && c.receiver_pressure_pa < c.discharge_pressure_pa
            && c.discharge_pressure_pa < c.shutoff_pressure_pa
            && c.hydraulic_efficiency <= 1.
            && (c.fixed_loss_pa + c.fcv_loss_pa - (c.discharge_pressure_pa - c.receiver_pressure_pa))
                .abs()
                <= 1e-9 * c.discharge_pressure_pa
            && pos(l.nominal_flow_kg_s)
            && l.receiver_pressure_pa < l.trim_inlet_pressure_pa
            && l.trim_inlet_pressure_pa < l.upstream_pressure_pa
            && (0. ..1.).contains(&c.reference_opening)
            && (0. ..1.).contains(&l.reference_opening)
            && pos(section.transfer_flow_kg_s)
            && 0. < section.low_blend.stop_m3
            && section.low_blend.stop_m3 < section.low_blend.restart_m3
            && t.water.stop_height_m < t.water.reset_height_m
            && t.concentrate.stop_height_m < t.concentrate.reset_height_m
            && t.blend.reset_height_m < t.blend.stop_height_m
            && t.receiver.reset_height_m < t.receiver.stop_height_m
            && t.receiver.stop_height_m < t.height_m
            // The ideal cooler delivers at the pools' own temperature, so
            // the receiver stays isothermal.
            && l.cooler_outlet_temperature_k == t.temperature_k
            && pos(section.pzr_level.lag_s)
            && section.program.no_load.loop_average_k < section.program.full_power.loop_average_k)
        {
            return Err(fatal("section values"));
        }
        let cells = read_cells(section);
        if cells.iter().any(|c| *c >= regular_cells)
            || section
                .legs
                .iter()
                .any(|l| l.hot.is_empty() || l.cold.is_empty())
            || section.legs.is_empty()
        {
            return Err(fatal("the port and leg cells must be regular cells"));
        }
        let tank = properties
            .forward(false, t.pressure_pa, t.temperature_k)
            .map_err(|e| fatal(format!("tank liquid state: {e}")))?;
        let (low, high) = pzr
            .parameters()
            .level_taps()?
            .ok_or_else(|| fatal("the PZR declares no LT pair"))?;
        let saturation =
            WaterProperties::saturation(properties, s(section.pzr_level.calibration_pressure_pa))
                .map_err(|e| fatal(format!("LT calibration saturation: {e}")))?;
        let (rl, rg) = (
            saturation.liquid.density.value,
            saturation.vapor.density.value,
        );
        let level_a = 1. / ((rl - rg) * G);
        let level_b = -rg * G * (high - low) * level_a;
        let rise_pa = c.discharge_pressure_pa - c.suction_pressure_pa;
        let shutoff_ratio = (c.shutoff_pressure_pa - c.suction_pressure_pa) / rise_pa;
        let pzr_scales = network_scales
            .get(pzr_base..pzr_base + stratified::COORDINATES)
            .ok_or_else(|| fatal("the network's PZR coordinates"))?
            .to_vec();
        let rho = tank.density_kg_m3;
        let mass = |k: &Tank| k.initial_volume_m3 * rho;
        let mut layout = Layout::default();
        let mut prepared = Vec::with_capacity(COORDINATES);
        for (label, class, scale, value) in [
            ("CVCS.BLEND.M", Class::InventoryStock, 1e3, mass(&t.blend)),
            (
                "CVCS.BLEND.B",
                Class::InventoryStock,
                1.,
                // Set by the initial-state preparation (BlendInitial).
                0.,
            ),
            ("CVCS.WATER.M", Class::InventoryStock, 1e3, mass(&t.water)),
            (
                "CVCS.CONCENTRATE.M",
                Class::InventoryStock,
                1e3,
                mass(&t.concentrate),
            ),
            (
                "CVCS.RECEIVER.M",
                Class::InventoryStock,
                1e3,
                mass(&t.receiver),
            ),
            (
                "CVCS.RECEIVER.B",
                Class::InventoryStock,
                1.,
                mass(&t.receiver) * t.receiver.initial_ppm.unwrap_or(0.) * 1e-6,
            ),
            // The controller at the program's full-power point until the
            // composed state's own tracked point is prepared.
            (
                "CVCS.LT.lag",
                Class::InventoryControl,
                1.,
                section.program.full_power.level_m,
            ),
            (
                "CVCS.TAVG.lag",
                Class::InventoryControl,
                1.,
                section.program.full_power.loop_average_k,
            ),
        ] {
            layout.push(label.into(), class, true, scale, scale);
            prepared.push(value);
        }
        let flow = section.controller.flow_normalization_kg_s;
        for b in ["CHARGE", "LETDOWN"] {
            for (label, scale, value) in [
                ("FT.lag", flow, 0.),
                ("I", 1., -section.controller.valve_bias),
                ("FCV.s", 1., 0.),
                ("IL", flow, 0.),
            ] {
                layout.push(
                    format!("CVCS.{b}.{label}"),
                    Class::InventoryControl,
                    true,
                    scale,
                    scale,
                );
                prepared.push(value);
            }
        }
        layout.validate("cvcs")?;
        if layout.len() != COORDINATES {
            return Err(fatal("layout length"));
        }
        let supported = BranchState {
            request: Request::Auto,
            stops: Stops::default(),
        };
        Ok(Self {
            concentrate_fraction: t.concentrate.initial_ppm.unwrap_or(0.) * 1e-6,
            section: section.clone(),
            layout,
            prepared,
            modes: Modes {
                charging: supported,
                letdown: supported,
                water_kg_s: 0.,
                concentrate_kg_s: 0.,
                charging_supported: true,
            },
            tank_density_kg_m3: rho,
            tank_enthalpy_j_kg: tank.enthalpy_j_kg,
            rise_pa,
            shutoff_ratio,
            pzr: pzr.clone(),
            pzr_base,
            pzr_scales,
            level_a,
            level_b,
            boundary: Boundary::default(),
            prepare: false,
            prepared_blend: false,
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    pub fn prepared(&self) -> &[f64] {
        &self.prepared
    }
    pub fn differential(&self) -> Vec<f64> {
        self.layout.ids()
    }
    pub fn section(&self) -> &Section {
        &self.section
    }
    pub fn modes(&self) -> &Modes {
        &self.modes
    }
    /// The network cells the rows read (COLD.A and the leg cells).
    pub fn read_cells(&self) -> Vec<usize> {
        read_cells(&self.section)
    }
    /// The cell the receipts enter.
    pub fn port_cell(&self) -> usize {
        self.section.port.region
    }
    /// The PZR cell's network coordinates the level row reads.
    pub fn pzr_coordinates(&self) -> std::ops::Range<usize> {
        self.pzr_base..self.pzr_base + stratified::COORDINATES
    }
    /// The next value evaluation records the tracked point at its state
    /// ([`Self::prepared`] then holds it).
    pub fn request_preparation(&mut self) {
        self.prepare = true;
    }

    /// The PZR level indication from the network's solver-scaled `y` (and
    /// `seed`, its direction): the LT law of `ld01-pzr-level-channels`.
    pub fn level(&self, y: &[f64], seed: Option<&[f64]>) -> Result<Scalar, Failure> {
        let b = self.pzr_base;
        let x: Vec<Scalar> = self
            .pzr_scales
            .iter()
            .enumerate()
            .map(|(i, sc)| Scalar::new(y[b + i] * sc, seed.map_or(0., |d| d[b + i] * sc)))
            .collect();
        let x = stratified::Coordinates::from_slice(&x)?;
        let (low, high) = self
            .pzr
            .level_tap_pressures(&x)?
            .ok_or_else(|| fatal("the PZR declares no LT pair"))?;
        let span = self.section.pzr_level.interface_span_pa;
        Ok(s(self.level_a) * (clamp(low, span) - clamp(high, span)) + s(self.level_b))
    }
    /// The level indication's direction for a unit solver seed on PZR
    /// coordinate `j` (global network index).
    pub fn level_column(&self, y: &[f64], j: usize) -> Result<Scalar, Failure> {
        let mut seed = vec![0.; y.len()];
        seed[j] = 1.;
        self.level(y, Some(&seed))
    }

    /// The loop average of the leg cells' liquid temperatures (K), each leg
    /// mass-weighted, then `(Th + Tc)/2` per loop, averaged over the loops.
    fn loop_average(&self, fluid: &Fluid<'_>) -> Result<Scalar, Failure> {
        let leg = |cells: &[usize]| -> Result<Scalar, Failure> {
            let (mut mt, mut m) = (s(0.), s(0.));
            for &c in cells {
                let (v, d) = fluid.points[c][0]
                    .ok_or_else(|| trial(format!("leg cell {c} has no liquid")))?;
                let t = Scalar::new(v.temperature_k, d.temperature_k);
                let mass = fluid.liquid_mass[c];
                mt = mt + mass * t;
                m = m + mass;
            }
            Ok(mt / m)
        };
        let mut sum = s(0.);
        for l in &self.section.legs {
            sum = sum + (leg(&l.hot)? + leg(&l.cold)?) / s(2.);
        }
        Ok(sum / s(self.section.legs.len() as f64))
    }

    /// Charging flow at stem `x` against COLD.A pressure `p` (kg/s), the
    /// series liquid law with the pump's forward characteristic.
    fn charging_flow(&self, x: Scalar, p: Scalar) -> Result<Scalar, Failure> {
        let c = &self.section.charging;
        let r = self.shutoff_ratio;
        let available = s(c.suction_pressure_pa + r * self.rise_pa) - p;
        if available.value.is_nan() || available.value <= 0. {
            return Err(trial(format!(
                "COLD.A at {} Pa is at or above the charging pump's shutoff",
                p.value
            )));
        }
        let den = x * x * s(self.rise_pa * (r - 1.) + c.fixed_loss_pa)
            + s(c.fcv_loss_pa * c.reference_opening * c.reference_opening);
        Ok(s(c.nominal_flow_kg_s) * x * sqrt(available / den))
    }
    /// Letdown flow at stem `x` from COLD.A pressure `p` (kg/s).
    fn letdown_flow(&self, x: Scalar, p: Scalar) -> Result<Scalar, Failure> {
        let l = &self.section.letdown;
        let available = p - s(l.receiver_pressure_pa);
        if available.value.is_nan() || available.value <= 0. {
            return Err(trial(format!(
                "COLD.A at {} Pa below the receiver",
                p.value
            )));
        }
        let up = l.upstream_pressure_pa - l.trim_inlet_pressure_pa;
        let trim = l.trim_inlet_pressure_pa - l.receiver_pressure_pa;
        let den = x * x * s(up) + s(trim * l.reference_opening * l.reference_opening);
        Ok(s(l.nominal_flow_kg_s) * x * sqrt(available / den))
    }
    /// The stem position that passes `m` (kg/s) at COLD.A pressure `p`
    /// (Pa), inverting the branch's law; `None` beyond full opening.
    fn opening_for(&self, branch: Branch, m: f64, p: f64) -> Option<f64> {
        let (m0, a, b, available) = match branch {
            Branch::Charging => {
                let c = &self.section.charging;
                let r = self.shutoff_ratio;
                (
                    c.nominal_flow_kg_s,
                    self.rise_pa * (r - 1.) + c.fixed_loss_pa,
                    c.fcv_loss_pa * c.reference_opening * c.reference_opening,
                    c.suction_pressure_pa + r * self.rise_pa - p,
                )
            }
            Branch::Letdown => {
                let l = &self.section.letdown;
                (
                    l.nominal_flow_kg_s,
                    l.upstream_pressure_pa - l.trim_inlet_pressure_pa,
                    (l.trim_inlet_pressure_pa - l.receiver_pressure_pa)
                        * l.reference_opening
                        * l.reference_opening,
                    p - l.receiver_pressure_pa,
                )
            }
        };
        // m^2 (a x^2 + b) = m0^2 x^2 dp  =>  x = m sqrt(b / (m0^2 dp - m^2 a)).
        let d = m0 * m0 * available - m * m * a;
        let x = m * (b / d).sqrt();
        (available > 0. && d > 0. && x.is_finite() && x <= 1.).then_some(x)
    }
    /// A branch's delivered flow (kg/s) at its stem position `stem` and
    /// COLD.A pressure `pressure_pa`, as the rows deliver it in the owner's
    /// current modes (zero while the branch is stopped): the quantity its
    /// FT observes (`LD01.INV.CHARGE.FT`, `LD01.INV.LETDOWN.FT`).
    pub fn delivered_flow(
        &self,
        branch: Branch,
        stem: f64,
        pressure_pa: f64,
    ) -> Result<f64, Failure> {
        if self.modes.branch(branch).stops.any() {
            return Ok(0.);
        }
        let flow = match branch {
            Branch::Charging => self.charging_flow(s(stem), s(pressure_pa))?,
            Branch::Letdown => self.letdown_flow(s(stem), s(pressure_pa))?,
        };
        Ok(flow.value)
    }
    /// A branch's stem coordinate (local index).
    pub fn stem_coordinate(branch: Branch) -> usize {
        BRANCH[branch.index()] + STEM
    }
    fn depth(&self, tank: &Tank, mass: f64) -> f64 {
        mass / self.tank_density_kg_m3 / tank.area_m2
    }

    /// Every own row in physical units at own coordinates `x`, the
    /// network's `fluid` and the PZR level indication `level` of the same
    /// evaluation; the COLD.A receipt is added into `receipts`.
    pub fn rows(
        &mut self,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        level: Scalar,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure> {
        if x.len() != COORDINATES || rows.len() != COORDINATES {
            return Err(fatal("row layout"));
        }
        let ctl = self.section.controller;
        let cell = self.section.port.region;
        let p = fluid.pressure_at(cell, self.section.port.elevation_m);
        let (v, d) = fluid.points[cell][0].ok_or_else(|| {
            trial(format!(
                "{} has no liquid to let down",
                self.section.port.id
            ))
        })?;
        let donor_h = Scalar::new(v.enthalpy_j_kg, d.enthalpy_j_kg);
        let donor_x = fluid.tracer[cell] / fluid.liquid_mass[cell];
        let tavg = self.loop_average(fluid)?;
        let lag_l = x.value(LEVEL);
        let lag_t = x.value(TAVG);
        let setpoint = self.section.program.setpoint(lag_t);
        if !(self.prepared_blend || self.prepare) {
            return Err(fatal(
                "the CVCS needs its initial-state preparation (BLEND at the primary's concentration)",
            ));
        }
        let blend_m = x.value(BLEND_M);
        let blend_x = x.value(BLEND_B) / blend_m;
        let mut flows = [s(0.); 2];
        for b in Branch::ALL {
            let k = b.index();
            let base = BRANCH[k];
            let state = *self.modes.branch(b);
            let stopped = state.stops.any();
            let outer = ctl.outer(
                b == Branch::Charging,
                lag_l,
                setpoint,
                x.value(base + LEVEL_INTEGRAL),
            );
            let auto = state.request == Request::Auto && !stopped;
            let request = match state.request {
                Request::Auto => outer.request,
                Request::Withdrawn => s(0.),
                Request::Manual(r) => s(r),
            };
            // A stopped branch has no request in force: its level integral
            // tracks zero, so a permitted restart is bumpless.
            let applied = if stopped { s(0.) } else { request };
            rows[base + LEVEL_INTEGRAL] =
                x.rate(base + LEVEL_INTEGRAL) - ctl.outer_rate(&outer, applied, auto);
            let inner = ctl.inner(
                request,
                x.value(base + FT),
                x.value(base + INTEGRAL),
                stopped,
            );
            let stem = x.value(base + STEM);
            let m = if stopped {
                s(0.)
            } else {
                match b {
                    Branch::Charging => self.charging_flow(stem, p)?,
                    Branch::Letdown => self.letdown_flow(stem, p)?,
                }
            };
            flows[k] = m;
            rows[base + FT] = x.rate(base + FT) - (m - x.value(base + FT)) / s(ctl.flow_lag_s);
            rows[base + INTEGRAL] = x.rate(base + INTEGRAL) - inner.integral_rate;
            rows[base + STEM] = x.rate(base + STEM) - ctl.stem_rate(inner.demand, stem);
        }
        let [mc, ml] = flows;
        // The pump's rise at its flow heats the stream (efficiency).
        let c = &self.section.charging;
        let q = mc / s(c.nominal_flow_kg_s);
        let rise = s(self.rise_pa) * (s(self.shutoff_ratio) - s(self.shutoff_ratio - 1.) * q * q);
        let hc =
            s(self.tank_enthalpy_j_kg) + rise / s(self.tank_density_kg_m3 * c.hydraulic_efficiency);
        let (tw, tc) = (s(self.modes.water_kg_s), s(self.modes.concentrate_kg_s));
        rows[BLEND_M] = x.rate(BLEND_M) - (tw + tc - mc);
        rows[BLEND_B] = x.rate(BLEND_B) - (tc * s(self.concentrate_fraction) - mc * blend_x);
        rows[WATER_M] = x.rate(WATER_M) + tw;
        rows[CONC_M] = x.rate(CONC_M) + tc;
        rows[RECV_M] = x.rate(RECV_M) - ml;
        rows[RECV_B] = x.rate(RECV_B) - ml * donor_x;
        rows[LEVEL] = x.rate(LEVEL) - (level - lag_l) / s(self.section.pzr_level.lag_s);
        rows[TAVG] = x.rate(TAVG) - (tavg - lag_t) / s(ctl.loop_average_lag_s);
        receipts.add(
            cell,
            0,
            mc - ml,
            mc * hc - ml * donor_h,
            mc * blend_x - ml * donor_x,
        )?;
        if rows
            .iter()
            .any(|r| !(r.value.is_finite() && r.direction.is_finite()))
        {
            return Err(trial("nonfinite CVCS row"));
        }
        self.boundary = Boundary {
            charging_kg_s: mc.value,
            charging_w: (mc * hc).value,
            charging_boron_kg_eq_s: (mc * blend_x).value,
            letdown_kg_s: ml.value,
            letdown_w: (ml * donor_h).value,
            letdown_boron_kg_eq_s: (ml * donor_x).value,
            water_kg_s: tw.value,
            concentrate_kg_s: tc.value,
        };
        if self.prepare {
            self.prepare = false;
            self.track(level.value, tavg.value, p.value, donor_x.value)?;
        }
        Ok(())
    }

    /// The controller at its tracked AUTO point of a state: both lags at
    /// their inputs, each branch's level integral at zero (its request the
    /// wiki's proportional law's, bumpless), its flow at that request with
    /// the stem at the opening that passes it, the flow lag at the flow and
    /// the inner integral at zero error. BLEND's absorber follows the
    /// initial-condition rule: BLEND at `primary` (COLD.A's kg_eq per kg).
    /// The tank masses are not moved.
    fn track(&mut self, level: f64, tavg: f64, p: f64, primary: f64) -> Result<(), Failure> {
        let ctl = self.section.controller;
        let setpoint = self.section.program.setpoint(s(tavg));
        self.prepared[LEVEL] = level;
        self.prepared[TAVG] = tavg;
        match self.section.blend_initial {
            BlendInitial::PrimaryAtInitialState => {
                self.prepared[BLEND_B] = self.prepared[BLEND_M] * primary;
            }
        }
        self.prepared_blend = true;
        for b in Branch::ALL {
            let base = BRANCH[b.index()];
            let r = ctl
                .outer(b == Branch::Charging, s(level), setpoint, s(0.))
                .request
                .value;
            self.prepared[base + LEVEL_INTEGRAL] = 0.;
            let u = self
                .opening_for(b, r, p)
                .ok_or_else(|| fatal(format!("no {b:?} opening passes {r} kg/s at {p} Pa")))?;
            self.prepared[base + FT] = r;
            self.prepared[base + INTEGRAL] = ctl.tracked_integral(u);
            self.prepared[base + STEM] = u;
        }
        Ok(())
    }

    // Root slots, each a located event (class R).
    const ROOTS: usize = 13;
    pub fn root_count(&self) -> usize {
        Self::ROOTS
    }
    /// Root functions on own coordinates (physical `x`): the stops, AUTO's
    /// input spans and the two lips (domain exits).
    pub fn roots(&self, x: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        if x.len() != COORDINATES || out.len() != Self::ROOTS {
            return Err(fatal("root layout"));
        }
        const DISARMED: f64 = 1.;
        let t = &self.section.tanks;
        let m = &self.modes;
        let blend = self.depth(&t.blend, x[BLEND_M]);
        let receiver = self.depth(&t.receiver, x[RECV_M]);
        let transfer = m.water_kg_s > 0. || m.concentrate_kg_s > 0.;
        let auto = |b: &BranchState| b.request == Request::Auto;
        let [lo, hi] = self.section.pzr_level.indicated_span_m;
        let [flo, fhi] = self.section.controller.flow_span_kg_s;
        let blend_volume = x[BLEND_M] / self.tank_density_kg_m3;
        out[0] = if m.charging.stops.low_blend {
            DISARMED
        } else {
            blend_volume - self.section.low_blend.stop_m3
        };
        out[1] = if m.letdown.stops.receiver_high {
            DISARMED
        } else {
            t.receiver.stop_height_m - receiver
        };
        out[2] = if m.water_kg_s > 0. {
            self.depth(&t.water, x[WATER_M]) - t.water.stop_height_m
        } else {
            DISARMED
        };
        out[3] = if m.concentrate_kg_s > 0. {
            self.depth(&t.concentrate, x[CONC_M]) - t.concentrate.stop_height_m
        } else {
            DISARMED
        };
        out[4] = if transfer {
            t.blend.stop_height_m - blend
        } else {
            DISARMED
        };
        let any_auto = auto(&m.charging) || auto(&m.letdown);
        out[5] = if any_auto { x[LEVEL] - lo } else { DISARMED };
        out[6] = if any_auto { hi - x[LEVEL] } else { DISARMED };
        for (k, b) in [m.charging, m.letdown].iter().enumerate() {
            let f = x[BRANCH[k] + FT];
            out[7 + 2 * k] = if auto(b) { f - flo } else { DISARMED };
            out[8 + 2 * k] = if auto(b) { fhi - f } else { DISARMED };
        }
        out[11] = t.height_m - blend;
        out[12] = t.height_m - receiver;
        if out.iter().any(|v| !v.is_finite()) {
            return Err(fatal("nonfinite root"));
        }
        Ok(())
    }
    /// Every slot reports only its falling crossing (each is written so
    /// that leaving its admitted side falls).
    pub fn root_directions(&self, out: &mut [i32]) -> Result<(), Failure> {
        if out.len() != Self::ROOTS {
            return Err(fatal("root direction layout"));
        }
        out.fill(-1);
        Ok(())
    }
    /// The transaction at located roots (`directions` per slot). No
    /// coordinate moves.
    pub fn transact(
        &mut self,
        t: f64,
        directions: &[i32],
        x: &[f64],
    ) -> Result<Transaction, Failure> {
        if directions.len() != Self::ROOTS || x.len() != COORDINATES {
            return Err(fatal("transaction layout"));
        }
        let mut events = Vec::new();
        for (slot, name) in [(11, "BLEND"), (12, "RECEIVER")] {
            if directions[slot] != 0 {
                return Err(fatal(format!(
                    "domain exit (ld01-cvcs): {name} reached its 4 m overflow lip at t = {t} s"
                )));
            }
        }
        let m = &mut self.modes;
        if directions[0] != 0 {
            m.charging.stops.low_blend = true;
            events.push(json!({"stop": "low BLEND", "branch": "charging", "blend_m3": x[BLEND_M] / self.tank_density_kg_m3}));
        }
        if directions[1] != 0 {
            m.letdown.stops.receiver_high = true;
            events.push(
                json!({"stop": "RECEIVER high", "branch": "letdown", "receiver_kg": x[RECV_M]}),
            );
        }
        if directions[2] != 0 {
            m.water_kg_s = 0.;
            events.push(json!({"stop": "WATER low", "transfer": "water"}));
        }
        if directions[3] != 0 {
            m.concentrate_kg_s = 0.;
            events.push(json!({"stop": "CONCENTRATE low", "transfer": "concentrate"}));
        }
        if directions[4] != 0 {
            m.water_kg_s = 0.;
            m.concentrate_kg_s = 0.;
            events.push(json!({"stop": "BLEND high", "transfer": "both"}));
        }
        if directions[5] != 0 || directions[6] != 0 {
            for b in Branch::ALL {
                let s = m.branch_mut(b);
                if s.request == Request::Auto {
                    s.request = Request::Withdrawn;
                }
            }
            events.push(json!({"auto": "withdrawn", "reason": "the PZR level indication left its span", "level_m": x[LEVEL]}));
        }
        for (k, b) in Branch::ALL.into_iter().enumerate() {
            if directions[7 + 2 * k] != 0 || directions[8 + 2 * k] != 0 {
                let s = m.branch_mut(b);
                if s.request != Request::Auto {
                    return Err(fatal(format!("{b:?} flow span root crossed outside AUTO")));
                }
                s.request = Request::Withdrawn;
                events.push(json!({"auto": "withdrawn", "branch": format!("{b:?}"), "reason": "the branch FT left its span", "flow_kg_s": x[BRANCH[k] + FT]}));
            }
        }
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner": "cvcs", "t_s": t, "events": events, "stateChanged": !events.is_empty(), "modes": self.modes}),
        })
    }

    /// An operator command at `t` on own physical coordinates `x`. A
    /// refused command changes nothing.
    pub fn command(&mut self, t: f64, command: Command, x: &[f64]) -> Result<Transaction, Failure> {
        if x.len() != COORDINATES {
            return Err(fatal("command layout"));
        }
        let ctl = self.section.controller;
        let tanks = self.section.tanks;
        let in_range =
            |r: f64| (ctl.request_range_kg_s[0]..=ctl.request_range_kg_s[1]).contains(&r);
        let mut modes = self.modes;
        match command {
            Command::Auto => {
                let [lo, hi] = self.section.pzr_level.indicated_span_m;
                if !(lo..=hi).contains(&x[LEVEL]) {
                    return Err(fatal(format!(
                        "AUTO refused: the level indication {} m is outside its span",
                        x[LEVEL]
                    )));
                }
                for (k, b) in Branch::ALL.into_iter().enumerate() {
                    let f = x[BRANCH[k] + FT];
                    if !(ctl.flow_span_kg_s[0]..=ctl.flow_span_kg_s[1]).contains(&f) {
                        return Err(fatal(format!(
                            "AUTO refused: the {b:?} FT {f} kg/s is outside its span"
                        )));
                    }
                    modes.branch_mut(b).request = Request::Auto;
                }
            }
            Command::Manual {
                branch,
                request_kg_s,
            } => {
                if !in_range(request_kg_s) {
                    return Err(fatal(format!(
                        "MANUAL request {request_kg_s} kg/s outside the range"
                    )));
                }
                modes.branch_mut(branch).request = Request::Manual(request_kg_s);
            }
            Command::Restart { branch } => {
                let supported = modes.charging_supported;
                let stops = &mut modes.branch_mut(branch).stops;
                if stops.low_blend {
                    let v = x[BLEND_M] / self.tank_density_kg_m3;
                    if v < self.section.low_blend.restart_m3 {
                        return Err(fatal(format!(
                            "charging restart refused: BLEND {v} m³ below its restart volume"
                        )));
                    }
                    stops.low_blend = false;
                }
                if stops.receiver_high {
                    let d = self.depth(&tanks.receiver, x[RECV_M]);
                    if d >= tanks.receiver.reset_height_m {
                        return Err(fatal(format!("letdown restart refused: RECEIVER at {d} m")));
                    }
                    stops.receiver_high = false;
                }
                if stops.support_loss {
                    if !supported {
                        return Err(fatal(
                            "charging restart refused: AC.B does not supply CHARGE.P1",
                        ));
                    }
                    stops.support_loss = false;
                }
            }
            Command::Transfer {
                source,
                request_kg_s,
            } => {
                if !(0. ..=self.section.transfer_flow_kg_s).contains(&request_kg_s) {
                    return Err(fatal(format!(
                        "transfer request {request_kg_s} kg/s outside 0..{}",
                        self.section.transfer_flow_kg_s
                    )));
                }
                if request_kg_s > 0. {
                    let blend = self.depth(&tanks.blend, x[BLEND_M]);
                    let (tank, mass) = match source {
                        Source::Water => (tanks.water, x[WATER_M]),
                        Source::Concentrate => (tanks.concentrate, x[CONC_M]),
                    };
                    let depth = self.depth(&tank, mass);
                    if blend > tanks.blend.reset_height_m || depth < tank.reset_height_m {
                        return Err(fatal(format!(
                            "{source:?} transfer refused: BLEND at {blend} m, source at {depth} m"
                        )));
                    }
                }
                match source {
                    Source::Water => modes.water_kg_s = request_kg_s,
                    Source::Concentrate => modes.concentrate_kg_s = request_kg_s,
                }
            }
        }
        let before = self.modes;
        self.modes = modes;
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner": "cvcs", "t_s": t, "command": format!("{command:?}"), "before": before, "after": self.modes,
                "stateChanged": before != self.modes}),
        })
    }

    /// AC.B's supply of CHARGE.P1 (the S3-D12 gate's form): its loss stops
    /// charging (delivered flow zero, demand closed), and its return only
    /// permits an explicit restart.
    pub fn set_charging_supported(&mut self, supported: bool) -> Transaction {
        let before = self.modes;
        self.modes.charging_supported = supported;
        if !supported {
            self.modes.charging.stops.support_loss = true;
        }
        Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner": "cvcs", "charging_supported": supported, "stateChanged": before != self.modes}),
        }
    }

    /// What the last evaluation crossed at COLD.A, entering the primary
    /// positive (the unit's envelope); the tanks are outside it.
    pub fn account(&self) -> OwnerAccount {
        let b = self.boundary;
        let port = |name: &str, mass: f64, energy: f64, tracer: f64| Crossing {
            port: format!("CVCS.{name}"),
            volume: 0,
            mass_kg_s: mass,
            energy_w: energy,
            tracer_kg_s: tracer,
        };
        OwnerAccount {
            crossings: vec![
                port(
                    "charging",
                    b.charging_kg_s,
                    b.charging_w,
                    b.charging_boron_kg_eq_s,
                ),
                port(
                    "letdown",
                    -b.letdown_kg_s,
                    -b.letdown_w,
                    -b.letdown_boron_kg_eq_s,
                ),
            ],
            ..OwnerAccount::default()
        }
    }
    /// The tanks' own boundary: the transfer flows (kg/s) between them and
    /// CONCENTRATE's absorber fraction, for the tanks' identities.
    pub fn transfers(&self) -> (f64, f64, f64) {
        (
            self.boundary.water_kg_s,
            self.boundary.concentrate_kg_s,
            self.concentrate_fraction,
        )
    }
    /// The coordinates the initial-state preparation writes (local
    /// indices): every controller state and BLEND's absorber.
    pub fn tracked() -> Vec<usize> {
        std::iter::once(BLEND_B).chain(LEVEL..COORDINATES).collect()
    }
    /// The tank stocks' local indices: masses (BLEND, WATER, CONCENTRATE,
    /// RECEIVER) and absorbers (BLEND, RECEIVER).
    pub fn stocks() -> ([usize; 4], [usize; 2]) {
        ([BLEND_M, WATER_M, CONC_M, RECV_M], [BLEND_B, RECV_B])
    }

    /// S5 snapshot: the modes, stops, transfer requests and support.
    pub fn discrete_state(&self) -> Value {
        serde_json::to_value(self.modes).expect("CVCS modes serialize")
    }
    pub fn restore_discrete_state(&mut self, state: &Value) -> Result<(), Failure> {
        snapshot_object(
            state,
            "cvcs",
            &[
                "charging",
                "letdown",
                "water_kg_s",
                "concentrate_kg_s",
                "charging_supported",
            ],
        )?;
        self.modes =
            serde_json::from_value(state.clone()).map_err(|e| fatal(format!("snapshot: {e}")))?;
        Ok(())
    }
}

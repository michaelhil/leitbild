//! Cold PRHR contact assembly. Physical water and steel remain in the primary
//! network; this owner supplies finite pool/ROOM charts and real film surfaces.
//! No installed containment, boiling or early circulation-inertia credit.
pub use crate::prhr_mixing::Mixing;
use crate::{finite_wst, prhr_actuator};
#[derive(Clone, Copy, Debug)]
pub struct Axial {
    pub from: usize,
    pub to: usize,
    pub area: f64,
    pub separation: f64,
    pub seat: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum ContactWeight {
    Fixed,
    DiscSameSide,
    DiscOtherSide,
}
impl ContactWeight {
    pub fn fraction(self, opening: f64) -> f64 {
        let same = 0.5 * (1. + (std::f64::consts::FRAC_PI_2 * opening).cos());
        match self {
            Self::Fixed => 1.,
            Self::DiscSameSide => same,
            Self::DiscOtherSide => 1. - same,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LiquidContact {
    pub water: usize,
    pub solid: usize,
    pub area: f64,
    pub diameter: f64,
    pub flow_area: f64,
    pub flow_edge: usize,
    pub half_resistance: f64,
    pub weight: ContactWeight,
}
#[derive(Clone, Copy, Debug)]
pub struct PoolContact {
    pub solid: usize,
    pub area: f64,
    pub diameter: f64,
    pub elevation: f64,
    pub half_resistance: f64,
    pub bank_factor: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct GasContact {
    pub solid: usize,
    pub conductance: f64,
}
#[derive(Clone, Debug)]
pub struct Config {
    pub wst: finite_wst::Config,
    pub gas: finite_wst::GasBoundary,
    pub actuator: prhr_actuator::Config,
    pub liquid_contacts: Vec<LiquidContact>,
    pub pool_contacts: Vec<PoolContact>,
    pub gas_contacts: Vec<GasContact>,
    pub mixing: Vec<Mixing>,
    pub axial: Vec<Axial>,
}
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub wst_start: usize,
    pub room_energy: usize,
    pub surface_start: usize,
    pub spring_released: usize,
    pub gas_exported: usize,
    pub electrical_received: usize,
    pub room_ambient_exported: usize,
    pub connector_exported: usize,
    pub gas_mass_exported: usize,
    pub dimension: usize,
}
#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub opening: f64,
    pub opening_rate: f64,
    pub electrical_receipt_w: f64,
    pub room_heat_w: f64,
    pub ambient_temperature_k: f64,
}
#[derive(Clone, Debug)]
pub struct Model {
    pub config: Config,
    pub wst: finite_wst::Model,
    pub actuator: prhr_actuator::Model,
    pub layout: Layout,
}
#[derive(Clone, Debug, Default)]
pub struct Workspace {
    pub wst: finite_wst::Workspace,
    pub pool_heat_w: f64,
    pub connector_export_w: f64,
    pub room_temperature_k: f64,
    pub room_ambient_export_w: f64,
    pub spring_release_w: f64,
    pub electrical_receipt_w: f64,
    pub room_heat_w: f64,
    pub property_requests: usize,
    pub mixing: Vec<MixingState>,
    pub input: Option<Input>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct MixingState {
    pub coefficient: f64,
    /// Exact incidence columns [p,Tfrom,Tto,Tsg,qsg]. Local constitutive
    /// partials are prepared once and contracted by all scalar consumers.
    pub partials: [f64; 5],
}
impl Model {
    pub fn new(
        config: Config,
        start: usize,
        water_count: usize,
        solid_count: usize,
        edge_count: usize,
    ) -> Result<Self, String> {
        for c in &config.liquid_contacts {
            if c.water >= water_count
                || c.solid >= solid_count
                || c.flow_edge >= edge_count
                || ![c.area, c.diameter, c.flow_area, c.half_resistance]
                    .iter()
                    .all(|x| x.is_finite() && *x > 0.)
            {
                return Err("Invalid PRHR liquid contact".into());
            }
        }
        for c in &config.pool_contacts {
            if c.solid >= solid_count
                || !c.elevation.is_finite()
                || c.elevation < config.wst.floor_m
                || c.elevation > config.wst.minimum_fully_wet_height_m
                || ![c.area, c.diameter, c.half_resistance, c.bank_factor]
                    .iter()
                    .all(|x| x.is_finite() && *x > 0.)
            {
                return Err("Invalid PRHR pool contact".into());
            }
        }
        for c in &config.gas_contacts {
            if c.solid >= solid_count || !c.conductance.is_finite() || c.conductance <= 0. {
                return Err("Invalid exposed PRHR gas contact".into());
            }
        }
        for c in &config.mixing {
            c.validate()?;
            if c.from >= water_count
                || c.to >= water_count
                || c.sg_water >= water_count
                || c.sg_flow_edge >= edge_count
            {
                return Err("Invalid PRHR mixing incidence".into());
            }
        }
        for c in &config.axial {
            if c.from >= water_count
                || c.to >= water_count
                || c.from == c.to
                || ![c.area, c.separation]
                    .iter()
                    .all(|x| x.is_finite() && *x > 0.)
            {
                return Err("Invalid PRHR axial conduction incidence".into());
            }
        }
        if config.liquid_contacts.is_empty() || config.pool_contacts.is_empty() {
            return Err("PRHR requires actual liquid and pool contacts".into());
        }
        let surface_start = start
            .checked_add(finite_wst::STATES + 1)
            .ok_or("PRHR layout overflow")?;
        let spring_released = surface_start
            .checked_add(config.liquid_contacts.len())
            .and_then(|x| x.checked_add(config.pool_contacts.len()))
            .ok_or("PRHR layout overflow")?;
        let dimension = spring_released
            .checked_add(6)
            .ok_or("PRHR layout overflow")?;
        let wst = finite_wst::Model::new(config.wst)?;
        wst.prepare(config.gas)?;
        let actuator = prhr_actuator::Model::new(config.actuator)?;
        Ok(Self {
            config,
            wst,
            actuator,
            layout: Layout {
                wst_start: start,
                room_energy: start + 4,
                surface_start,
                spring_released,
                gas_exported: spring_released + 1,
                electrical_received: spring_released + 2,
                room_ambient_exported: spring_released + 3,
                connector_exported: spring_released + 4,
                gas_mass_exported: spring_released + 5,
                dimension,
            },
        })
    }
    pub fn validate_input(&self, input: Input) -> Result<(), String> {
        let c = self.config.actuator;
        if ![
            input.opening,
            input.opening_rate,
            input.electrical_receipt_w,
            input.room_heat_w,
            input.ambient_temperature_k,
        ]
        .iter()
        .all(|x| x.is_finite())
            || !(0.0..=1.0).contains(&input.opening)
            || input.ambient_temperature_k <= 0.
            || input.electrical_receipt_w < 0.
            || input.opening_rate.abs() > 1. / c.stroke_s
            || (input.room_heat_w
                - input.electrical_receipt_w
                - c.spring_energy_j * input.opening_rate)
                .abs()
                > 1e-10 * (1. + input.room_heat_w.abs())
        {
            return Err("Invalid achieved PRHR motion/energy input".into());
        }
        Ok(())
    }
    pub fn energy_rows(&self) -> [usize; 2] {
        [
            self.layout.wst_start + finite_wst::ENERGY,
            self.layout.room_energy,
        ]
    }
    /// A continuous-position mechanism event changes only these owned
    /// identity-Fyp forcing rows. No fluid chart or stock is reinitialized.
    /// A position or ambient-boundary jump is not this kind of event.
    pub fn rate_event_changes(
        &self,
        before: Input,
        after: Input,
    ) -> Result<[(usize, f64); 3], String> {
        self.validate_input(before)?;
        self.validate_input(after)?;
        if before.opening.to_bits() != after.opening.to_bits()
            || before.ambient_temperature_k.to_bits() != after.ambient_temperature_k.to_bits()
        {
            return Err("PRHR rate-only event changed position or ambient boundary".into());
        }
        Ok([
            (
                self.layout.room_energy,
                after.room_heat_w - before.room_heat_w,
            ),
            (
                self.layout.spring_released,
                self.config.actuator.spring_energy_j * (after.opening_rate - before.opening_rate),
            ),
            (
                self.layout.electrical_received,
                after.electrical_receipt_w - before.electrical_receipt_w,
            ),
        ])
    }
    /// Signed independent receipts for the existing affine whole-energy chart.
    pub fn receipt_rows(&self) -> [(usize, f64); 5] {
        let l = self.layout;
        [
            (l.spring_released, -1.),
            (l.gas_exported, 1.),
            (l.electrical_received, -1.),
            (l.room_ambient_exported, 1.),
            (l.connector_exported, 1.),
        ]
    }
}

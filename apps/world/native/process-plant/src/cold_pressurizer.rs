//! Prospectively reduced cold pool/cushion, NOT the ten-region PZR carrier.
//! Separate finite water/NC energies, finite-rate supersaturated dilute steam,
//! exact pool geometry and reciprocal interface work. No electrical heater,
//! gas port, dryout/flooding, slip, stratified withdrawal or stable-fog claim.
use crate::{GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::sync::Arc;

pub const METALS: usize = 9;
pub const STATES: usize = 29;
pub const LIQUID_MASS: usize = 0;
pub const VAPOR_MASS: usize = 1;
pub const LIQUID_ENERGY: usize = 2;
pub const GAS_ENERGY: usize = 3;
pub const LIQUID_TEMPERATURE: usize = 4;
pub const GAS_TEMPERATURE: usize = 5;
pub const SURFACE_PRESSURE: usize = 6;
pub const VAPOR_PRESSURE: usize = 7;
pub const HEIGHT: usize = 8;
pub const INTERFACE_TEMPERATURE: usize = 9;
pub const LIQUID_PRESSURE: usize = 10;
pub const METAL_ENERGY_START: usize = 11;
pub const METAL_TEMPERATURE_START: usize = 20;
/// Columns of the fixed prepared diagnostic derivative response.
pub const DIAGNOSTIC_EVAPORATION: usize = 6;
pub const DIAGNOSTIC_WALL_CONDENSATION: usize = 7;
pub const DIAGNOSTIC_AMBIENT_HEAT: usize = 11;
const LEVEL: usize = HEIGHT;
const METAL_ENERGIES: usize = METAL_ENERGY_START;
const METAL_TEMPERATURES: usize = METAL_TEMPERATURE_START;

#[derive(Clone, Copy, Debug)]
pub struct Rod {
    pub displacement_area: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum Contact {
    /// Always fully wet in this selected level envelope.
    Rod {
        height: f64,
        area: f64,
    },
    Shell {
        bottom: f64,
        top: f64,
        area: f64,
    },
    Bottom {
        area: f64,
    },
    Top {
        area: f64,
    },
}
#[derive(Clone, Copy, Debug)]
pub struct Metal {
    pub mass: f64,
    pub contact: Contact,
    pub ambient_conductance: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Radiation {
    pub from: usize,
    pub to: usize,
    pub effective_area: f64,
}
#[derive(Clone, Debug)]
pub struct Input {
    pub area: f64,
    pub height: f64,
    pub bottom_elevation: f64,
    pub rods: [Rod; 2],
    pub minimum_level: f64,
    pub maximum_level: f64,
    pub minimum_fluid_temperature: f64,
    pub maximum_fluid_temperature: f64,
    pub maximum_total_pressure: f64,
    pub maximum_vapor_pressure: f64,
    pub air_mass: f64,
    pub nitrogen_mass: f64,
    pub interface_length: f64,
    pub diffusivity_reference: f64,
    pub diffusivity_reference_temperature: f64,
    pub diffusivity_reference_pressure: f64,
    pub diffusivity_exponent: f64,
    pub gas_conductivity: f64,
    pub wet_coefficient: f64,
    pub gas_coefficient: f64,
    pub condensation_speed: f64,
    pub cp0: f64,
    pub cp1: f64,
    pub datum_temperature: f64,
    pub minimum_metal_temperature: f64,
    pub maximum_metal_temperature: f64,
    pub ambient_temperature: f64,
    pub metals: [Metal; METALS],
    pub radiation: Vec<Radiation>,
}
#[derive(Clone, Copy, Debug)]
pub struct Steam {
    pub gas_constant: f64,
    pub cv: f64,
    pub reference_temperature: f64,
    pub reference_internal_energy: f64,
    pub reference_entropy: f64,
    pub reference_saturation_pressure: f64,
}
impl Steam {
    pub fn native_anchor() -> Result<Self, String> {
        let (_, v, sat) = crate::sg_secondary::endpoints(300., 1e5)?;
        let (l, _, _) = crate::sg_secondary::endpoints(300., sat[0])?;
        let r = 461.526;
        let g0 = l.enthalpy - 300. * l.entropy;
        let result = Self {
            gas_constant: r,
            cv: v.cp - r,
            reference_temperature: 300.,
            reference_internal_energy: v.internal_energy,
            reference_entropy: (v.internal_energy + r * 300. - g0) / 300.,
            reference_saturation_pressure: sat[0],
        };
        if !finite(&[result.cv, result.reference_entropy]) || result.cv <= 0. {
            return Err("Invalid native-anchored ideal steam caloric law".into());
        }
        Ok(result)
    }
    pub fn internal_energy(self, t: f64) -> f64 {
        self.reference_internal_energy + self.cv * (t - self.reference_temperature)
    }
    pub fn enthalpy(self, t: f64) -> f64 {
        self.internal_energy(t) + self.gas_constant * t
    }
    pub fn entropy(self, t: f64, p: f64) -> f64 {
        self.reference_entropy
            + (self.cv + self.gas_constant) * (t / self.reference_temperature).ln()
            - self.gas_constant * (p / self.reference_saturation_pressure).ln()
    }
    pub fn equilibrium_vapor_pressure(self, p_liquid: f64, t: f64) -> Result<f64, String> {
        let l = water(p_liquid, t)?;
        let exponent = (l.enthalpy - t * l.entropy - self.enthalpy(t)
            + t * (self.reference_entropy
                + (self.cv + self.gas_constant) * (t / self.reference_temperature).ln()))
            / (self.gas_constant * t);
        let pv = self.reference_saturation_pressure * exponent.exp();
        if !pv.is_finite() || pv <= 0. || pv >= p_liquid {
            return Err("Cold PZR interface left dilute separated-water branch".into());
        }
        Ok(pv)
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Balance {
    pub mass: f64,
    pub energy: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct PortResponse {
    pub port: crate::finite_surge::Port,
    pub partials: [crate::finite_surge::PortDirection; STATES],
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Diagnostics {
    pub liquid_volume: f64,
    pub gas_volume: f64,
    pub liquid_centroid: f64,
    pub gas_centroid: f64,
    pub bottom_pressure: f64,
    pub bottom_total_enthalpy: f64,
    pub evaporation: f64,
    pub wall_condensation: f64,
    pub interface_liquid_energy: f64,
    pub interface_gas_energy: f64,
    pub liquid_volume_rate: f64,
    pub ambient_heat: f64,
    pub gas_mean_pressure: f64,
    pub supersaturation_ratio: f64,
    pub interface_native_gas_energy: f64,
    pub interface_balance: f64,
    pub liquid_energy_rate: f64,
    pub gas_energy_rate: f64,
    pub metal_heat: [f64; METALS],
}
pub struct Model {
    input: Input,
    steam: Steam,
    volume: f64,
    moment: f64,
    owner: Arc<()>,
}
pub struct Workspace {
    owner: Arc<()>,
    valid: bool,
    linearized: bool,
    cj: f64,
    residual: [f64; STATES],
    jacobian: [[f64; STATES]; STATES],
    rate_matrix: [[f64; STATES]; STATES],
    diagnostics: Diagnostics,
    diagnostic_jacobian: [[f64; STATES]; 16],
    energy_rate_jacobian: [[f64; STATES]; 11],
    state: [f64; STATES],
    derivative: [f64; STATES],
}
fn finite(xs: &[f64]) -> bool {
    xs.iter().all(|v| v.is_finite())
}
fn water(p: f64, t: f64) -> Result<Liquid, String> {
    let mut out = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            pressure: p,
            temperature: t,
        }],
        &mut out,
    )
    .map_err(|e| e.message)?;
    Ok(out[0])
}
fn diagnostic_vector(d: Diagnostics) -> [f64; 16] {
    [
        d.liquid_volume,
        d.gas_volume,
        d.liquid_centroid,
        d.gas_centroid,
        d.bottom_pressure,
        d.bottom_total_enthalpy,
        d.evaporation,
        d.wall_condensation,
        d.interface_liquid_energy,
        d.interface_gas_energy,
        d.liquid_volume_rate,
        d.ambient_heat,
        d.gas_mean_pressure,
        d.supersaturation_ratio,
        d.interface_native_gas_energy,
        d.interface_balance,
    ]
}
impl Model {
    pub fn is_differential(&self, row: usize) -> bool {
        row < 4 || (METAL_ENERGIES..METAL_TEMPERATURES).contains(&row)
    }
    pub fn energy_rows(&self) -> impl Iterator<Item = usize> {
        [LIQUID_ENERGY, GAS_ENERGY]
            .into_iter()
            .chain(METAL_ENERGIES..METAL_TEMPERATURES)
    }
    pub fn new(input: Input) -> Result<Self, String> {
        Self::with_steam(input, Steam::native_anchor()?)
    }
    fn with_steam(input: Input, steam: Steam) -> Result<Self, String> {
        let xs = [
            input.area,
            input.height,
            input.bottom_elevation,
            input.minimum_level,
            input.maximum_level,
            input.minimum_fluid_temperature,
            input.maximum_fluid_temperature,
            input.maximum_total_pressure,
            input.maximum_vapor_pressure,
            input.air_mass,
            input.nitrogen_mass,
            input.interface_length,
            input.diffusivity_reference,
            input.diffusivity_reference_temperature,
            input.diffusivity_reference_pressure,
            input.diffusivity_exponent,
            input.gas_conductivity,
            input.wet_coefficient,
            input.gas_coefficient,
            input.condensation_speed,
            input.cp0,
            input.cp1,
            input.datum_temperature,
            input.minimum_metal_temperature,
            input.maximum_metal_temperature,
            input.ambient_temperature,
        ];
        if !finite(&xs)
            || input.area <= 0.
            || input.height <= 0.
            || input.minimum_level <= 0.
            || input.maximum_level <= input.minimum_level
            || input.maximum_level >= input.height
            || input.minimum_fluid_temperature < 273.15
            || input.maximum_fluid_temperature > 350.
            || input.maximum_fluid_temperature <= input.minimum_fluid_temperature
            || input.maximum_total_pressure <= 0.
            || input.maximum_vapor_pressure <= 0.
            || input.air_mass <= 0.
            || input.nitrogen_mass < 0.
            || input.interface_length <= 0.
            || input.diffusivity_reference <= 0.
            || input.diffusivity_reference_temperature <= 0.
            || input.diffusivity_reference_pressure <= 0.
            || input.gas_conductivity <= 0.
            || input.wet_coefficient <= 0.
            || input.gas_coefficient <= 0.
            || input.condensation_speed < 0.
            || input.minimum_metal_temperature < 290.
            || input.maximum_metal_temperature > 350.
            || input.maximum_metal_temperature <= input.minimum_metal_temperature
            || input.cp0 + input.cp1 * input.minimum_metal_temperature <= 0.
            || input.cp0 + input.cp1 * input.maximum_metal_temperature <= 0.
            || input.ambient_temperature < input.minimum_metal_temperature
            || input.ambient_temperature > input.maximum_metal_temperature
        {
            return Err("Invalid selected cold pool/cushion definition".into());
        }
        if input.rods.iter().any(|r| {
            !finite(&[r.displacement_area, r.height])
                || r.displacement_area <= 0.
                || r.height <= 0.
                || r.height > input.minimum_level
        }) || input.rods.iter().map(|r| r.displacement_area).sum::<f64>() >= input.area
        {
            return Err("Cold pool envelope must keep actual rods covered".into());
        }
        for m in &input.metals {
            let (area, valid) = match m.contact {
                Contact::Rod { height, area } => (
                    area,
                    height > 0. && height <= input.minimum_level && height.is_finite(),
                ),
                Contact::Shell { bottom, top, area } => (
                    area,
                    finite(&[bottom, top]) && bottom >= 0. && top > bottom && top <= input.height,
                ),
                Contact::Bottom { area } | Contact::Top { area } => (area, true),
            };
            if !finite(&[m.mass, m.ambient_conductance, area])
                || m.mass <= 0.
                || m.ambient_conductance < 0.
                || area <= 0.
                || !valid
            {
                return Err("Invalid actual finite PZR metal/contact".into());
            }
        }
        if input.radiation.iter().any(|r| {
            r.from >= METALS
                || r.to >= METALS
                || r.from == r.to
                || !r.effective_area.is_finite()
                || r.effective_area <= 0.
        }) {
            return Err("Invalid finite PZR reciprocal radiation".into());
        }
        // Native saturated 300 K values are only the once-owned caloric anchor.
        // h=u+RT and entropy calibration retain ONE consistent ideal Gibbs law.
        let volume = input.area * input.height
            - input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height)
                .sum::<f64>();
        let moment = input.area * input.height.powi(2) / 2.
            - input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height.powi(2) / 2.)
                .sum::<f64>();
        Ok(Self {
            input,
            steam,
            volume,
            moment,
            owner: Arc::new(()),
        })
    }
    pub fn input(&self) -> &Input {
        &self.input
    }
    pub fn steam(&self) -> Steam {
        self.steam
    }
    pub fn volume(&self) -> f64 {
        self.volume
    }
    /// Original creation only: zero supplied air explicitly requests derivation
    /// from the named physical bottom pressure. No zero-air model is created.
    /// Positive supplied air is refused instead of overwritten/reprepared.
    pub fn prepare_at_bottom_pressure(
        mut input: Input,
        bottom_pressure: f64,
        tl: f64,
        tg: f64,
        h: f64,
        metal_t: [f64; METALS],
    ) -> Result<(Self, [f64; STATES]), String> {
        if input.air_mass != 0.
            || !finite(&[
                bottom_pressure,
                tl,
                tg,
                h,
                input.area,
                input.height,
                input.bottom_elevation,
                input.nitrogen_mass,
            ])
            || bottom_pressure <= 0.
            || tl <= 0.
            || tg <= 0.
            || input.area <= 0.
            || input.height <= 0.
            || input.nitrogen_mass < 0.
            || h <= input.minimum_level
            || h >= input.maximum_level
        {
            return Err("Fresh bottom-pressure preparation requires derived air, valid geometry and actual cold boundary".into());
        }
        let steam = Steam::native_anchor()?;
        let vl = input.area * h
            - input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height)
                .sum::<f64>();
        let jl = input.area * h * h / 2.
            - input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height * r.height / 2.)
                .sum::<f64>();
        let total = input.area * input.height
            - input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height)
                .sum::<f64>();
        let jt = input.area * input.height.powi(2) / 2.
            - input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height.powi(2) / 2.)
                .sum::<f64>();
        let vg = total - vl;
        let zl = jl / vl;
        let zg = (jt - jl) / vg;
        if !finite(&[vl, vg, zl, zg]) || vl <= 0. || vg <= 0. {
            return Err("Invalid fresh PZR occupied geometry".into());
        }
        let mut pl = bottom_pressure;
        let mut closed = false;
        for _ in 0..12 {
            let l = water(pl, tl)?;
            let f = pl - bottom_pressure + l.density * GRAVITY * zl;
            let correction = f / (1. + l.density * l.compressibility * GRAVITY * zl);
            if !correction.is_finite() {
                return Err("Fresh PZR bottom-pressure hydrostatic chart lost rank".into());
            }
            let next = pl - correction;
            if correction.abs() <= 1e-8 || next.to_bits() == pl.to_bits() {
                pl = next;
                closed = true;
                break;
            }
            pl = next;
        }
        if !closed {
            return Err("Fresh PZR bottom-pressure hydrostatic chart did not close".into());
        }
        let l = water(pl, tl)?;
        let ps = bottom_pressure - l.density * GRAVITY * h;
        let pv = steam.equilibrium_vapor_pressure(ps, tg)?;
        let mv = pv * vg / (steam.gas_constant * tg);
        let head = GRAVITY * (zg - h);
        input.air_mass = (vg * (ps - pv)
            - input.nitrogen_mass * (crate::sg_secondary::RN * tg + head)
            - mv * head)
            / (crate::sg_secondary::RA * tg + head);
        let model = Self::with_steam(input, steam)?;
        let y = model.prepare(tl, tg, pv, h, metal_t)?;
        let port = model.port(&y)?.port;
        if (port.pressure - bottom_pressure).abs() > 1e-7 {
            return Err("Fresh PZR did not retain the selected physical bottom pressure".into());
        }
        Ok((model, y))
    }
    pub fn metal_energy(&self, k: usize, t: f64) -> Result<f64, String> {
        let m = self.input.metals.get(k).ok_or("PZR metal index")?;
        if !t.is_finite()
            || t < self.input.minimum_metal_temperature
            || t > self.input.maximum_metal_temperature
        {
            return Err("PZR metal caloric domain".into());
        }
        Ok(m.mass
            * (t - self.input.datum_temperature)
            * (self.input.cp0 + self.input.cp1 * (t + self.input.datum_temperature) / 2.))
    }
    pub fn metal_capacity(&self, k: usize, t: f64) -> Result<f64, String> {
        self.metal_energy(k, t)?;
        Ok(self.input.metals[k].mass * (self.input.cp0 + self.input.cp1 * t))
    }
    /// Relative-z volume and first moments; all rods remain submerged.
    pub fn geometry(&self, h: f64) -> Result<[f64; 4], String> {
        if !h.is_finite() || h <= self.input.minimum_level || h >= self.input.maximum_level {
            return Err("PZR pool left selected covered cold envelope".into());
        }
        let vl = self.input.area * h
            - self
                .input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height)
                .sum::<f64>();
        let jl = self.input.area * h * h / 2.
            - self
                .input
                .rods
                .iter()
                .map(|r| r.displacement_area * r.height * r.height / 2.)
                .sum::<f64>();
        let vg = self.volume - vl;
        Ok([vl, vg, jl / vl, (self.moment - jl) / vg])
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            owner: self.owner.clone(),
            valid: false,
            linearized: false,
            cj: 0.,
            residual: [0.; STATES],
            jacobian: [[0.; STATES]; STATES],
            rate_matrix: [[0.; STATES]; STATES],
            diagnostics: Diagnostics::default(),
            diagnostic_jacobian: [[0.; STATES]; 16],
            energy_rate_jacobian: [[0.; STATES]; 11],
            state: [0.; STATES],
            derivative: [0.; STATES],
        }
    }
    /// Only consumed current port quantities are evaluated, once before the
    /// actual line transaction. No full PZR heat/phase calculation is repeated.
    pub fn port(&self, y: &[f64; STATES]) -> Result<PortResponse, String> {
        if !finite(y)
            || y[SURFACE_PRESSURE] <= 0.
            || y[LIQUID_PRESSURE] <= 0.
            || y[SURFACE_PRESSURE] > self.input.maximum_total_pressure
            || y[LIQUID_PRESSURE] > self.input.maximum_total_pressure
            || y[LIQUID_TEMPERATURE] < self.input.minimum_fluid_temperature
            || y[LIQUID_TEMPERATURE] > self.input.maximum_fluid_temperature
        {
            return Err("Invalid current cold PZR liquid port".into());
        }
        self.geometry(y[HEIGHT])?;
        let l = water(y[LIQUID_PRESSURE], y[LIQUID_TEMPERATURE])?;
        let h = y[HEIGHT];
        let ps = y[SURFACE_PRESSURE];
        let rp = l.density * l.compressibility;
        let rt = -l.density * l.expansion;
        let mut partials = [crate::finite_surge::PortDirection::default(); STATES];
        partials[SURFACE_PRESSURE] = crate::finite_surge::PortDirection {
            pressure: 1.,
            total_enthalpy: 1. / l.density,
        };
        partials[HEIGHT] = crate::finite_surge::PortDirection {
            pressure: l.density * GRAVITY,
            total_enthalpy: GRAVITY,
        };
        partials[LIQUID_PRESSURE] = crate::finite_surge::PortDirection {
            pressure: rp * GRAVITY * h,
            total_enthalpy: (l.pressure * l.compressibility - l.temperature * l.expansion)
                / l.density
                - ps * rp / l.density.powi(2),
        };
        partials[LIQUID_TEMPERATURE] = crate::finite_surge::PortDirection {
            pressure: rt * GRAVITY * h,
            total_enthalpy: l.cp
                - l.pressure * l.expansion / l.density
                - ps * rt / l.density.powi(2),
        };
        Ok(PortResponse {
            port: crate::finite_surge::Port {
                pressure: ps + l.density * GRAVITY * h,
                total_enthalpy: l.internal_energy
                    + ps / l.density
                    + GRAVITY * (self.input.bottom_elevation + h),
                elevation: self.input.bottom_elevation,
            },
            partials,
        })
    }
    /// Fresh preparation ONLY. Immutable NC amounts and the supplied gas/level
    /// determine pressure; they are not four independently imposed constraints.
    /// The small mean-liquid hydrostatic solve occurs here, never in residuals.
    pub fn prepare(
        &self,
        tl: f64,
        tg: f64,
        pv: f64,
        h: f64,
        metal_t: [f64; METALS],
    ) -> Result<[f64; STATES], String> {
        let [vl, vg, zl, zg] = self.geometry(h)?;
        let mv = pv * vg / (self.steam.gas_constant * tg);
        let mg = mv + self.input.air_mass + self.input.nitrogen_mass;
        let ps = pv
            + (self.input.air_mass * crate::sg_secondary::RA
                + self.input.nitrogen_mass * crate::sg_secondary::RN)
                * tg
                / vg
            + (mg / vg) * GRAVITY * (zg - h);
        let depth = h - zl;
        let mut pl = ps;
        let mut converged = false;
        for _ in 0..12 {
            let l = water(pl, tl)?;
            let f = pl - ps - l.density * GRAVITY * depth;
            let correction = f / (1. - l.density * l.compressibility * GRAVITY * depth);
            if !correction.is_finite() {
                return Err("Singular fresh PZR hydrostatic chart".into());
            }
            let next = pl - correction;
            if next.to_bits() == pl.to_bits() || correction.abs() <= 1e-8 {
                pl = next;
                converged = true;
                break;
            }
            pl = next;
        }
        if !converged {
            return Err("Fresh PZR hydrostatic chart did not close".into());
        }
        let l = water(pl, tl)?;
        let ml = l.density * vl;
        let mut y = [0.; STATES];
        y[LIQUID_MASS] = ml;
        y[VAPOR_MASS] = mv;
        y[LIQUID_ENERGY] = ml * (l.internal_energy + GRAVITY * (self.input.bottom_elevation + zl));
        y[GAS_ENERGY] = mv * self.steam.internal_energy(tg)
            + (self.input.air_mass * crate::sg_secondary::CVA
                + self.input.nitrogen_mass * crate::sg_secondary::CVN)
                * (tg - crate::sg_secondary::GAS_DATUM)
            + mg * GRAVITY * (self.input.bottom_elevation + zg);
        y[LIQUID_TEMPERATURE] = tl;
        y[GAS_TEMPERATURE] = tg;
        y[SURFACE_PRESSURE] = ps;
        y[VAPOR_PRESSURE] = pv;
        y[HEIGHT] = h;
        y[INTERFACE_TEMPERATURE] = (tl + tg) / 2.;
        y[LIQUID_PRESSURE] = pl;
        for k in 0..METALS {
            y[METAL_ENERGIES + k] = self.metal_energy(k, metal_t[k])?;
            y[METAL_TEMPERATURES + k] = metal_t[k];
        }
        self.values(&y, &[0.; STATES], Balance::default(), None)?;
        Ok(y)
    }
    /// Chemical-equilibrium pressure of the selected ideal steam against the
    /// native liquid Gibbs potential, NOT a copied saturation correlation.
    pub fn equilibrium_vapor_pressure(&self, p_liquid: f64, t: f64) -> Result<f64, String> {
        self.steam.equilibrium_vapor_pressure(p_liquid, t)
    }
    fn values(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        b: Balance,
        condensing: Option<[bool; METALS]>,
    ) -> Result<([f64; STATES], Diagnostics, [bool; METALS]), String> {
        let i = &self.input;
        if !finite(y)
            || !finite(yp)
            || !finite(&[b.mass, b.energy])
            || y[LIQUID_MASS] <= 0.
            || y[VAPOR_MASS] <= 0.
            || y[SURFACE_PRESSURE] <= 0.
            || y[SURFACE_PRESSURE] > i.maximum_total_pressure
            || y[LIQUID_PRESSURE] <= 0.
            || y[LIQUID_PRESSURE] > i.maximum_total_pressure
            || y[VAPOR_PRESSURE] <= 0.
            || y[VAPOR_PRESSURE] > i.maximum_vapor_pressure
            || [
                y[LIQUID_TEMPERATURE],
                y[GAS_TEMPERATURE],
                y[INTERFACE_TEMPERATURE],
            ]
            .iter()
            .any(|&t| t < i.minimum_fluid_temperature || t > i.maximum_fluid_temperature)
        {
            return Err("PZR left positive cold dilute pool/cushion domain".into());
        }
        let [vl, vg, zl, zg] = self.geometry(y[LEVEL])?;
        let tl = y[LIQUID_TEMPERATURE];
        let tg = y[GAS_TEMPERATURE];
        let ti = y[INTERFACE_TEMPERATURE];
        let ps = y[SURFACE_PRESSURE];
        let pv = y[VAPOR_PRESSURE];
        let pl = y[LIQUID_PRESSURE];
        let ml = y[LIQUID_MASS];
        let mv = y[VAPOR_MASS];
        let ma = i.air_mass;
        let mn = i.nitrogen_mass;
        let mg = mv + ma + mn;
        let liquid = water(pl, tl)?;
        let li = water(ps, ti)?;
        let pvi = self.equilibrium_vapor_pressure(ps, ti)?;
        let rnc = (ma * crate::sg_secondary::RA + mn * crate::sg_secondary::RN) / (ma + mn);
        let nc_i = (ps - pvi) / (rnc * ti);
        let steam_i = pvi / (self.steam.gas_constant * ti);
        let ync_i = nc_i / (nc_i + steam_i);
        let ync = (ma + mn) / mg;
        let film = (tg + ti) / 2.;
        let diffusivity = i.diffusivity_reference
            * (film / i.diffusivity_reference_temperature).powf(i.diffusivity_exponent)
            * i.diffusivity_reference_pressure
            / ps;
        let gamma =
            i.area * (mg / vg) * diffusivity / (i.interface_length / 2.) * (ync / ync_i).ln();
        let ql = i.area * (2. * liquid.conductivity / i.interface_length) * (tl - ti);
        let qg = i.area * (2. * i.gas_conductivity / i.interface_length) * (tg - ti);
        let hli = li.enthalpy;
        let hvi = self.steam.enthalpy(ti);
        let zi = i.bottom_elevation + y[LEVEL];
        let sl = -gamma * (hli + GRAVITY * zi) - ql;
        let sg_native = gamma * (hvi + GRAVITY * zi) - qg;
        let interface_balance = ql + qg - gamma * (hvi - hli);
        // Exact DAE row operation Fgas_new=Fgas_native−Finterface. The
        // independently retained interface row still enforces the original
        // two-sided thermal/latent law. No off-chart energy is fabricated.
        let sg = -sl;
        let vdot = i.area * yp[LEVEL];
        let mut rl = b.energy + sl - ps * vdot;
        let mut rg = sg + ps * vdot;
        let mut heat = [0.; METALS];
        let mut condensates = 0.;
        let mut ambient = 0.;
        let mut branch = [false; METALS];
        for k in 0..METALS {
            let metal = i.metals[k];
            let tw = y[METAL_TEMPERATURES + k];
            self.metal_energy(k, tw)?;
            let (wet, dry, zw) = match metal.contact {
                Contact::Rod { height, area } => (area, 0., height / 2.),
                Contact::Shell { bottom, top, area } => {
                    let wet_height = (y[LEVEL] - bottom).max(0.).min(top - bottom);
                    (
                        area * wet_height / (top - bottom),
                        area * (1. - wet_height / (top - bottom)),
                        (y[LEVEL].max(bottom) + top) / 2.,
                    )
                }
                Contact::Bottom { area } => (area, 0., 0.),
                Contact::Top { area } => (0., area, i.height),
            };
            let qw = i.wet_coefficient * wet * (tw - tl);
            let qdry = i.gas_coefficient * dry * (tw - tg);
            rl += qw;
            rg += qdry;
            heat[k] -= qw + qdry;
            if dry > 0. && i.condensation_speed > 0. {
                let eq = self.equilibrium_vapor_pressure(ps, tw)? / (self.steam.gas_constant * tw);
                branch[k] = condensing.map_or(mv / vg > eq, |c| c[k]);
                let c = if branch[k] {
                    i.condensation_speed * dry * (mv / vg - eq)
                } else {
                    0.
                };
                let wall_liquid = water(ps, tw)?;
                let hgv = self.steam.enthalpy(tg);
                let z = i.bottom_elevation + zw;
                condensates += c;
                rg -= c * (hgv + GRAVITY * z);
                rl += c * (wall_liquid.enthalpy + GRAVITY * z);
                heat[k] += c * (hgv - wall_liquid.enthalpy);
            }
            let qa = metal.ambient_conductance * (tw - i.ambient_temperature);
            ambient += qa;
            heat[k] -= qa;
        }
        for r in &i.radiation {
            let q = r.effective_area
                * 5.670374419e-8
                * (y[METAL_TEMPERATURES + r.from].powi(4) - y[METAL_TEMPERATURES + r.to].powi(4));
            heat[r.from] -= q;
            heat[r.to] += q;
        }
        let rgas = (ma * crate::sg_secondary::RA + mn * crate::sg_secondary::RN) * tg / vg;
        let gas_mean = pv + rgas;
        let mut f = [0.; STATES];
        f[LIQUID_MASS] = yp[LIQUID_MASS] - (b.mass - gamma + condensates);
        f[VAPOR_MASS] = yp[VAPOR_MASS] - (gamma - condensates);
        f[LIQUID_ENERGY] = yp[LIQUID_ENERGY] - rl;
        f[GAS_ENERGY] = yp[GAS_ENERGY] - rg;
        f[LIQUID_TEMPERATURE] = ml - liquid.density * vl;
        f[GAS_TEMPERATURE] = mv - pv * vg / (self.steam.gas_constant * tg);
        f[SURFACE_PRESSURE] = ps - gas_mean - (mg / vg) * GRAVITY * (zg - y[LEVEL]);
        f[VAPOR_PRESSURE] = y[LIQUID_ENERGY]
            - liquid.density * vl * (liquid.internal_energy + GRAVITY * (i.bottom_elevation + zl));
        f[LEVEL] = y[GAS_ENERGY]
            - (mv * self.steam.internal_energy(tg)
                + (ma * crate::sg_secondary::CVA + mn * crate::sg_secondary::CVN)
                    * (tg - crate::sg_secondary::GAS_DATUM)
                + mg * GRAVITY * (i.bottom_elevation + zg));
        f[INTERFACE_TEMPERATURE] = interface_balance;
        f[LIQUID_PRESSURE] = pl - ps - liquid.density * GRAVITY * (y[LEVEL] - zl);
        for k in 0..METALS {
            f[METAL_ENERGIES + k] = yp[METAL_ENERGIES + k] - heat[k];
            f[METAL_TEMPERATURES + k] =
                y[METAL_ENERGIES + k] - self.metal_energy(k, y[METAL_TEMPERATURES + k])?;
        }
        let bottom = ps + liquid.density * GRAVITY * y[LEVEL];
        let d = Diagnostics {
            liquid_volume: vl,
            gas_volume: vg,
            liquid_centroid: i.bottom_elevation + zl,
            gas_centroid: i.bottom_elevation + zg,
            bottom_pressure: bottom,
            bottom_total_enthalpy: liquid.internal_energy
                + bottom / liquid.density
                + GRAVITY * i.bottom_elevation,
            evaporation: gamma,
            wall_condensation: condensates,
            interface_liquid_energy: sl,
            interface_gas_energy: sg,
            liquid_volume_rate: vdot,
            ambient_heat: ambient,
            gas_mean_pressure: gas_mean,
            supersaturation_ratio: pv / self.equilibrium_vapor_pressure(ps, tg)?,
            interface_native_gas_energy: sg_native,
            interface_balance,
            metal_heat: heat,
            liquid_energy_rate: rl,
            gas_energy_rate: rg,
        };
        if !finite(&f) || !finite(&diagnostic_vector(d)) || !finite(&heat) {
            return Err("Nonfinite cold PZR source/chart".into());
        }
        Ok((f, d, branch))
    }
    /// Complete local F_y+cj F_yp from current FORWARD laws, prepared once.
    /// Small local central partials are explicit; no inverse/root/cache and no
    /// complete source/operator basis probing occur here.
    pub fn evaluate(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        balance: Balance,
        cj: Option<f64>,
        w: &mut Workspace,
    ) -> Result<(), String> {
        w.valid = false;
        w.linearized = false;
        if !Arc::ptr_eq(&self.owner, &w.owner) || cj.is_some_and(|c| !c.is_finite() || c < 0.) {
            return Err("Foreign/invalid PZR workspace".into());
        }
        let (f, d, branch) = self.values(y, yp, balance, None)?;
        w.residual = f;
        w.diagnostics = d;
        if let Some(c) = cj {
            w.jacobian = [[0.; STATES]; STATES];
            w.rate_matrix = [[0.; STATES]; STATES];
            w.diagnostic_jacobian = [[0.; STATES]; 16];
            w.energy_rate_jacobian = [[0.; STATES]; 11];
            for k in [LIQUID_MASS, VAPOR_MASS, LIQUID_ENERGY, GAS_ENERGY] {
                w.rate_matrix[k][k] = 1.;
            }
            for k in 0..METALS {
                w.rate_matrix[METAL_ENERGIES + k][METAL_ENERGIES + k] = 1.;
            }
            w.rate_matrix[LIQUID_ENERGY][LEVEL] = y[SURFACE_PRESSURE] * self.input.area;
            w.rate_matrix[GAS_ENERGY][LEVEL] = -y[SURFACE_PRESSURE] * self.input.area;
            for col in 0..STATES {
                // E histories enter only their exact linear chart/balance rows.
                if col == LIQUID_ENERGY
                    || col == GAS_ENERGY
                    || (METAL_ENERGIES..METAL_TEMPERATURES).contains(&col)
                {
                    let row = if col == LIQUID_ENERGY {
                        VAPOR_PRESSURE
                    } else if col == GAS_ENERGY {
                        LEVEL
                    } else {
                        METAL_TEMPERATURES + col - METAL_ENERGIES
                    };
                    w.jacobian[row][col] = 1.;
                } else {
                    let step = (y[col].abs() * 1e-6).max(
                        if matches!(col, SURFACE_PRESSURE | VAPOR_PRESSURE | LIQUID_PRESSURE) {
                            0.01
                        } else {
                            1e-7
                        },
                    );
                    let mut a = *y;
                    let mut b = *y;
                    a[col] -= step;
                    b[col] += step;
                    let a = self.values(&a, yp, balance, Some(branch))?;
                    let b = self.values(&b, yp, balance, Some(branch))?;
                    for row in 0..STATES {
                        w.jacobian[row][col] = (b.0[row] - a.0[row]) / (2. * step);
                    }
                    for row in 0..16 {
                        w.diagnostic_jacobian[row][col] = (diagnostic_vector(b.1)[row]
                            - diagnostic_vector(a.1)[row])
                            / (2. * step);
                    }
                    let ar = energy_rates(a.1);
                    let br = energy_rates(b.1);
                    for row in 0..11 {
                        w.energy_rate_jacobian[row][col] = (br[row] - ar[row]) / (2. * step);
                    }
                }
                for row in 0..STATES {
                    w.jacobian[row][col] += c * w.rate_matrix[row][col];
                }
            }
            if !w
                .jacobian
                .iter()
                .flatten()
                .chain(w.diagnostic_jacobian.iter().flatten())
                .chain(w.energy_rate_jacobian.iter().flatten())
                .all(|x| x.is_finite())
            {
                return Err("Nonfinite PZR local partial".into());
            }
            w.cj = c;
            w.linearized = true;
        }
        w.state = *y;
        w.derivative = *yp;
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        w: &Workspace,
        direction: &[f64; STATES],
        balance_direction: Balance,
        cj: f64,
    ) -> Result<[f64; STATES], String> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || !w.linearized
            || w.cj.to_bits() != cj.to_bits()
            || !finite(direction)
            || !finite(&[balance_direction.mass, balance_direction.energy])
        {
            return Err("Unprepared PZR linear stage/direction".into());
        }
        let mut a = std::array::from_fn(|r| {
            w.jacobian[r]
                .iter()
                .zip(direction)
                .map(|(x, v)| x * v)
                .sum::<f64>()
        });
        a[LIQUID_MASS] -= balance_direction.mass;
        a[LIQUID_ENERGY] -= balance_direction.energy;
        if !finite(&a) {
            return Err("Nonfinite PZR tangent".into());
        }
        Ok(a)
    }
    pub fn diagnostic_jvp(
        &self,
        w: &Workspace,
        direction: &[f64; STATES],
    ) -> Result<[f64; 16], String> {
        if !Arc::ptr_eq(&self.owner, &w.owner) || !w.valid || !w.linearized || !finite(direction) {
            return Err("Unprepared PZR diagnostic tangent".into());
        }
        let a = std::array::from_fn(|r| {
            w.diagnostic_jacobian[r]
                .iter()
                .zip(direction)
                .map(|(x, v)| x * v)
                .sum::<f64>()
        });
        if !finite(&a) {
            return Err("Nonfinite PZR diagnostic tangent".into());
        }
        Ok(a)
    }
    /// Actual independently assembled energy-rate partials BEFORE cj shifts.
    /// The phase-volume work also depends on Hdot: its direction is cj*dH.
    pub fn energy_rate_jvp(
        &self,
        w: &Workspace,
        d: &[f64; STATES],
        db: Balance,
        cj: f64,
    ) -> Result<[f64; 11], String> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || !w.linearized
            || w.cj.to_bits() != cj.to_bits()
            || !finite(d)
            || !finite(&[db.mass, db.energy])
        {
            return Err("Unprepared PZR energy-rate tangent".into());
        }
        let mut out = std::array::from_fn(|r| {
            w.energy_rate_jacobian[r]
                .iter()
                .zip(d)
                .map(|(a, b)| a * b)
                .sum::<f64>()
        });
        out[0] += db.energy - w.state[SURFACE_PRESSURE] * self.input.area * cj * d[HEIGHT];
        out[1] += w.state[SURFACE_PRESSURE] * self.input.area * cj * d[HEIGHT];
        if !finite(&out) {
            return Err("Nonfinite PZR energy-rate tangent".into());
        }
        Ok(out)
    }
    /// Sum actual prepared unshifted rate partials BEFORE introducing the equal
    /// and opposite cj*dH work terms. This avoids manufacturing cancellation
    /// noise from huge artificial stage directions; no rate row is zeroed.
    pub fn complete_energy_rate_jvp(
        &self,
        w: &Workspace,
        d: &[f64; STATES],
        db: Balance,
    ) -> Result<f64, String> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || !w.linearized
            || !finite(d)
            || !finite(&[db.mass, db.energy])
        {
            return Err("Unprepared PZR complete energy tangent".into());
        }
        let mut sum = db.energy;
        for (col, &v) in d.iter().enumerate() {
            sum += w
                .energy_rate_jacobian
                .iter()
                .map(|row| row[col])
                .sum::<f64>()
                * v;
        }
        if !sum.is_finite() {
            return Err("Nonfinite PZR complete energy tangent".into());
        }
        Ok(sum)
    }
    /// Small physical chart correction, not a state projection. This consumes
    /// the SAME current prepared chart and holds the independent stocks fixed.
    /// Result order is [Tl,Tg,ps,pv,H,Ti,pL]. Thresholds belong to admission.
    pub fn chart_corrections(&self, w: &Workspace, y: &[f64; STATES]) -> Result<[f64; 7], String> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || !w.linearized
            || y.iter()
                .zip(w.state)
                .any(|(a, b)| a.to_bits() != b.to_bits())
        {
            return Err("PZR chart correction requires its current owned linear stage".into());
        }
        let mut a = [[0.; 8]; 7];
        for row in 0..7 {
            for col in 0..7 {
                a[row][col] = w.jacobian[4 + row][4 + col];
            }
            a[row][7] = -w.residual[4 + row];
        }
        for k in 0..7 {
            let pivot = (k..7)
                .max_by(|&a0, &b0| a[a0][k].abs().total_cmp(&a[b0][k].abs()))
                .unwrap();
            a.swap(k, pivot);
            let d = a[k][k];
            if !d.is_finite() || d == 0. {
                return Err("Singular current PZR chart".into());
            }
            for j in k..8 {
                a[k][j] /= d;
            }
            for r in 0..7 {
                if r != k {
                    let f = a[r][k];
                    for j in k..8 {
                        a[r][j] -= f * a[k][j];
                    }
                }
            }
        }
        let d = std::array::from_fn(|k| a[k][7]);
        if !finite(&d) {
            return Err("Nonfinite PZR chart correction".into());
        }
        Ok(d)
    }
    /// Linear equations for ALL initial coordinate rates, including Hdot.
    /// Differential rows use the actual F_yp; algebraic rows differentiate the
    /// forward charts. A caller must solve this border jointly with its ports,
    /// not hold algebraic Hdot=0 during consistent initialization.
    pub fn consistent_rate_system(
        &self,
        w: &Workspace,
    ) -> Result<([[f64; STATES]; STATES], [f64; STATES]), String> {
        if !Arc::ptr_eq(&self.owner, &w.owner) || !w.valid || !w.linearized {
            return Err("Unprepared PZR initial-rate system".into());
        }
        let mut a = [[0.; STATES]; STATES];
        let mut b = [0.; STATES];
        for row in 0..STATES {
            if self.is_differential(row) {
                a[row] = w.rate_matrix[row];
                b[row] = a[row]
                    .iter()
                    .zip(w.derivative)
                    .map(|(x, y)| x * y)
                    .sum::<f64>()
                    - w.residual[row];
            } else {
                a[row] = w.jacobian[row];
            }
        }
        Ok((a, b))
    }
}
fn energy_rates(d: Diagnostics) -> [f64; 11] {
    let mut r = [0.; 11];
    r[0] = d.liquid_energy_rate;
    r[1] = d.gas_energy_rate;
    r[2..].copy_from_slice(&d.metal_heat);
    r
}
impl Workspace {
    pub fn residual(&self) -> Result<&[f64; STATES], String> {
        if self.valid {
            Ok(&self.residual)
        } else {
            Err("Unprepared PZR values".into())
        }
    }
    pub fn diagnostics(&self) -> Result<Diagnostics, String> {
        if self.valid {
            Ok(self.diagnostics)
        } else {
            Err("Unprepared PZR diagnostics".into())
        }
    }
    pub fn jacobian(&self) -> Result<&[[f64; STATES]; STATES], String> {
        if self.valid && self.linearized {
            Ok(&self.jacobian)
        } else {
            Err("Unprepared PZR Jacobian".into())
        }
    }
    pub fn rate_matrix(&self) -> Result<&[[f64; STATES]; STATES], String> {
        if self.valid && self.linearized {
            Ok(&self.rate_matrix)
        } else {
            Err("Unprepared PZR rate matrix".into())
        }
    }
    pub fn energy_rates(&self) -> Result<[f64; 11], String> {
        if self.valid {
            Ok(energy_rates(self.diagnostics))
        } else {
            Err("Unprepared PZR energy rates".into())
        }
    }
    pub fn energy_rate_jacobian(&self) -> Result<&[[f64; STATES]; 11], String> {
        if self.valid && self.linearized {
            Ok(&self.energy_rate_jacobian)
        } else {
            Err("Unprepared PZR energy-rate partials".into())
        }
    }
    pub fn diagnostic_jacobian(&self) -> Result<&[[f64; STATES]; 16], String> {
        if self.valid && self.linearized {
            Ok(&self.diagnostic_jacobian)
        } else {
            Err("Unprepared PZR diagnostic partials".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test-only apparatus uses the selected physical dimensions, not a hidden
    // runtime LD-01 factory. Production definitions come from the typed owner.
    pub(crate) fn definition() -> Input {
        let pi = std::f64::consts::PI;
        let radius = (5. / pi).sqrt();
        let steel = 7920.;
        let rods = [
            Rod {
                displacement_area: 32. * pi * 0.01_f64.powi(2),
                height: 1.,
            },
            Rod {
                displacement_area: 256. * pi * 0.01_f64.powi(2),
                height: 3.,
            },
        ];
        let boundaries = [0., 1., 3., 6., 9., 12.];
        let metals = std::array::from_fn(|k| {
            if k < 2 {
                Metal {
                    mass: rods[k].displacement_area * rods[k].height * steel,
                    contact: Contact::Rod {
                        height: rods[k].height,
                        area: [32., 256.][k] * pi * 0.02 * rods[k].height,
                    },
                    ambient_conductance: 0.,
                }
            } else if k < 7 {
                let b = k - 2;
                let dz = boundaries[b + 1] - boundaries[b];
                Metal {
                    mass: pi * ((radius + 0.15).powi(2) - radius * radius) * dz * steel,
                    contact: Contact::Shell {
                        bottom: boundaries[b],
                        top: boundaries[b + 1],
                        area: 2. * pi * radius * dz,
                    },
                    ambient_conductance: dz * 3.,
                }
            } else {
                Metal {
                    mass: 5940.,
                    contact: if k == 7 {
                        Contact::Bottom { area: 4.838836 }
                    } else {
                        Contact::Top { area: 4.950335 }
                    },
                    ambient_conductance: 3.,
                }
            }
        });
        Input {
            area: 5.,
            height: 12.,
            bottom_elevation: 6.5,
            rods,
            minimum_level: 3.,
            maximum_level: 6.,
            minimum_fluid_temperature: 273.15,
            maximum_fluid_temperature: 350.,
            maximum_total_pressure: 2e6,
            maximum_vapor_pressure: 1e5,
            air_mass: 0.,
            nitrogen_mass: 0.,
            interface_length: 0.003,
            diffusivity_reference: 2.5e-5,
            diffusivity_reference_temperature: 298.15,
            diffusivity_reference_pressure: 101325.,
            diffusivity_exponent: 1.75,
            gas_conductivity: 0.026,
            wet_coefficient: 1000.,
            gas_coefficient: 5.,
            condensation_speed: 0.01,
            cp0: 469.4448,
            cp1: 0.13480848,
            datum_temperature: 300.,
            minimum_metal_temperature: 290.,
            maximum_metal_temperature: 350.,
            ambient_temperature: 313.15,
            metals,
            radiation: vec![],
        }
    }
    fn prepared() -> (Model, [f64; STATES]) {
        Model::prepare_at_bottom_pressure(definition(), 0.3e6, 300., 300., 4., [300.; METALS])
            .unwrap()
    }
    #[test]
    fn fresh_native_anchored_chart_retains_bottom_pressure_and_actual_space() {
        let (m, y) = prepared();
        assert!((m.volume() - 59.74867258771282).abs() < 1e-10);
        assert!(m.input().air_mass > 0.);
        let p = m.port(&y).unwrap();
        assert!((p.port.pressure - 0.3e6).abs() < 1e-7);
        assert!(y[SURFACE_PRESSURE] < y[LIQUID_PRESSURE] && y[LIQUID_PRESSURE] < p.port.pressure);
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], Balance::default(), Some(1.), &mut w)
            .unwrap();
        let correction = m.chart_corrections(&w, &y).unwrap();
        // Fresh pressure/volume/caloric preparation does not solve the
        // independent interface heat/latent equation by a hidden inverse.
        // Consistent DAE initialization must solve Ti and all phase rates.
        assert!(
            correction
                .iter()
                .enumerate()
                .all(|(k, x)| k == 5 || x.abs() < 1e-8),
            "{correction:?}"
        );
        assert!(correction[5].abs() > 1e-5);
        assert!(w.residual().unwrap()[INTERFACE_TEMPERATURE].abs() > 0.1);
        assert!(m.input().air_mass > 1.);
        assert_eq!(m.is_differential(HEIGHT), false);
        assert_eq!(m.energy_rows().count(), 11);
        let s = m.steam();
        let (l, _, _) =
            crate::sg_secondary::endpoints(300., s.reference_saturation_pressure).unwrap();
        let mu = s.enthalpy(300.) - 300. * s.entropy(300., s.reference_saturation_pressure);
        assert!((mu - (l.enthalpy - 300. * l.entropy)).abs() < 1e-9);
        assert_eq!(
            s.enthalpy(310.),
            s.internal_energy(310.) + s.gas_constant * 310.
        );
        let mut bad = definition();
        bad.air_mass = 1.;
        assert!(
            Model::prepare_at_bottom_pressure(bad, 0.3e6, 300., 300., 4., [300.; METALS]).is_err()
        );
    }
    #[test]
    fn off_interface_conservation_and_volume_work_are_exact_row_equivalence() {
        let (m, mut y) = prepared();
        y[INTERFACE_TEMPERATURE] = 299.7;
        y[GAS_TEMPERATURE] = 301.;
        y[METAL_TEMPERATURES + 8] = 295.;
        let mut yp = [0.; STATES];
        yp[HEIGHT] = 0.002;
        let b = Balance {
            mass: 0.1,
            energy: 1234.,
        };
        let mut w = m.workspace();
        m.evaluate(&y, &yp, b, Some(1e12), &mut w).unwrap();
        let d = w.diagnostics().unwrap();
        assert!(d.interface_balance.abs() > 1.);
        assert!(
            (d.interface_gas_energy - d.interface_native_gas_energy - d.interface_balance).abs()
                < 1e-7
        );
        assert_eq!(d.interface_liquid_energy, -d.interface_gas_energy);
        let total = w.energy_rates().unwrap().iter().sum::<f64>();
        assert!((total - b.energy + d.ambient_heat).abs() < 1e-7);
        let r = w.rate_matrix().unwrap();
        assert_eq!(r[LIQUID_ENERGY][HEIGHT], -r[GAS_ENERGY][HEIGHT]);
        let mut v = [0.; STATES];
        v[HEIGHT] = 1.;
        let complete = m
            .complete_energy_rate_jvp(&w, &v, Balance::default())
            .unwrap();
        assert!(complete.abs() < 1e-5, "unshifted complete {complete}");
        let (initial, _) = m.consistent_rate_system(&w).unwrap();
        assert_eq!(
            initial[LIQUID_ENERGY][HEIGHT],
            y[SURFACE_PRESSURE] * m.input().area
        );
    }
    #[test]
    fn full_local_direction_and_analytic_port_match_independent_perturbation() {
        let (m, mut y) = prepared();
        y[INTERFACE_TEMPERATURE] = 299.9;
        y[GAS_TEMPERATURE] = 301.;
        // Stay away from the wall-condensation max() corner; its declared
        // generalized derivative is tested separately, not by central FD.
        for k in 0..METALS {
            y[METAL_TEMPERATURES + k] = 295.;
        }
        let b = Balance {
            mass: 0.1,
            energy: 1234.,
        };
        let db = Balance {
            mass: -0.02,
            energy: 17.,
        };
        let cj = 3.;
        let yp = [0.01; STATES];
        let d = std::array::from_fn(|k| {
            if m.is_differential(k) {
                if k < 2 { 0.001 } else { 13. }
            } else {
                match k {
                    SURFACE_PRESSURE | VAPOR_PRESSURE | LIQUID_PRESSURE => 7.,
                    HEIGHT => 0.0002,
                    _ => 0.01,
                }
            }
        });
        let mut w = m.workspace();
        m.evaluate(&y, &yp, b, Some(cj), &mut w).unwrap();
        let j = m.jvp(&w, &d, db, cj).unwrap();
        let port = m.port(&y).unwrap();
        let jp = port.partials.iter().zip(d).fold(
            crate::finite_surge::PortDirection::default(),
            |a, (p, v)| crate::finite_surge::PortDirection {
                pressure: a.pressure + p.pressure * v,
                total_enthalpy: a.total_enthalpy + p.total_enthalpy * v,
            },
        );
        for eps in [1e-3, 5e-4] {
            let mut arms = [[0.; STATES]; 2];
            let mut pp = [crate::finite_surge::Port::default(); 2];
            for (k, sign) in [-1., 1.].into_iter().enumerate() {
                let yy = std::array::from_fn(|i| y[i] + sign * eps * d[i]);
                let yd = std::array::from_fn(|i| yp[i] + sign * eps * cj * d[i]);
                m.evaluate(
                    &yy,
                    &yd,
                    Balance {
                        mass: b.mass + sign * eps * db.mass,
                        energy: b.energy + sign * eps * db.energy,
                    },
                    None,
                    &mut w,
                )
                .unwrap();
                arms[k] = *w.residual().unwrap();
                pp[k] = m.port(&yy).unwrap().port;
            }
            for k in 0..STATES {
                let fd = (arms[1][k] - arms[0][k]) / (2. * eps);
                assert!(
                    (fd - j[k]).abs() < 1e-3 * j[k].abs().max(1.),
                    "row{k}: {fd} vs {}",
                    j[k]
                );
            }
            assert!(((pp[1].pressure - pp[0].pressure) / (2. * eps) - jp.pressure).abs() < 1e-4);
            assert!(
                ((pp[1].total_enthalpy - pp[0].total_enthalpy) / (2. * eps) - jp.total_enthalpy)
                    .abs()
                    < 1e-4
            );
        }
    }
    #[test]
    fn stage_lifecycle_foreign_failure_and_supersaturation_scope() {
        let (m, mut y) = prepared();
        let mut w = m.workspace();
        let z = [0.; STATES];
        m.evaluate(&y, &z, Balance::default(), Some(1.), &mut w)
            .unwrap();
        let held = w.residual().unwrap().to_owned();
        m.evaluate(&y, &z, Balance::default(), None, &mut w)
            .unwrap();
        assert_eq!(w.residual().unwrap(), &held);
        assert!(m.jvp(&w, &z, Balance::default(), 1.).is_err());
        y[VAPOR_PRESSURE] *= 1.01;
        m.evaluate(&y, &z, Balance::default(), Some(1.), &mut w)
            .unwrap();
        assert!(w.diagnostics().unwrap().supersaturation_ratio > 1.);
        let (foreign, _) = prepared();
        assert!(
            foreign
                .evaluate(&y, &z, Balance::default(), None, &mut w)
                .is_err()
        );
        assert!(w.diagnostics().is_err());
        m.evaluate(&y, &z, Balance::default(), Some(1.), &mut w)
            .unwrap();
        let mut bad = y;
        bad[HEIGHT] = 3.;
        assert!(
            m.evaluate(&bad, &z, Balance::default(), None, &mut w)
                .is_err()
        );
        assert!(w.residual().is_err());
        bad = y;
        bad[LIQUID_TEMPERATURE] = f64::NAN;
        assert!(
            m.evaluate(&bad, &z, Balance::default(), Some(1.), &mut w)
                .is_err()
        );
    }
    #[test]
    fn local_probe_domain_is_explicit_not_a_hidden_one_sided_fallback() {
        let (m, mut y) = prepared();
        let mut w = m.workspace();
        let z = [0.; STATES];
        y[METAL_TEMPERATURES] = m.input().minimum_metal_temperature;
        m.evaluate(&y, &z, Balance::default(), None, &mut w)
            .unwrap();
        assert!(
            m.evaluate(&y, &z, Balance::default(), Some(1.), &mut w)
                .is_err()
        );
        assert!(w.residual().is_err());
        assert!(w.jacobian().is_err());
    }
    #[test]
    #[ignore = "bounded component-only timing; no advancing integration"]
    fn held_component_cost() {
        let (m, y) = prepared();
        let mut w = m.workspace();
        let z = [0.; STATES];
        let start = std::time::Instant::now();
        for _ in 0..100 {
            m.evaluate(&y, &z, Balance::default(), None, &mut w)
                .unwrap();
        }
        let value = start.elapsed().as_secs_f64();
        let start = std::time::Instant::now();
        for _ in 0..100 {
            m.evaluate(&y, &z, Balance::default(), Some(1.), &mut w)
                .unwrap();
        }
        let linear = start.elapsed().as_secs_f64();
        let start = std::time::Instant::now();
        for _ in 0..100 {
            std::hint::black_box(m.jvp(&w, &[0.01; STATES], Balance::default(), 1.).unwrap());
        }
        eprintln!(
            "PZR component only: 100 value={value:.9}s, linear={linear:.9}s, JVP={:.9}s",
            start.elapsed().as_secs_f64()
        );
    }
}

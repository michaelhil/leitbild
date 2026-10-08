//! Finite, fully submerged liquid WST with an explicitly supplied gas boundary.
//! This is not finite containment, boiling, spill or exchanger-exposure credit.
//! Native histories are water mass and E=U+PE. T/V are forward chart rows;
//! retaining V makes reciprocal p*dV work linear without second EOS derivatives.
use crate::{sg_secondary, Liquid, GRAVITY};

pub const STATES: usize = 4;
pub const MASS: usize = 0;
pub const ENERGY: usize = 1;
pub const TEMPERATURE: usize = 2;
pub const VOLUME: usize = 3;
const RV: f64 = 461.5;
const CPV: f64 = 1871.5;
const DATUM: f64 = 298.15;
const GAS_ORIGIN: f64 = 20.;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub area_m2: f64,
    pub floor_m: f64,
    pub hardware_volume_m3: f64,
    pub hardware_first_moment_m4: f64,
    pub minimum_fully_wet_height_m: f64,
    pub maximum_height_m: f64,
    pub surface_mass_transfer_m_s: f64,
    pub initial_water_volume_m3: f64,
    pub initial_temperature_k: f64,
}

/// External gas resource, not a simulated CNV inventory or pressure controller.
/// Its vapor caloric law and +20 m donor origin are the selected CNV reduction.
#[derive(Clone, Copy, Debug)]
pub struct GasBoundary {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub vapor_density_kg_m3: f64,
}
impl GasBoundary {
    /// Prepare a declared supplied atmosphere using this same native water
    /// formulation. Relative humidity is input, not an imported density datum.
    pub fn from_relative_humidity(
        pressure_pa: f64,
        temperature_k: f64,
        humidity: f64,
    ) -> Result<Self, String> {
        if !humidity.is_finite() || !(0.0..=1.0).contains(&humidity) {
            return Err("Invalid supplied WST relative humidity".into());
        }
        let (_, _, saturation) = sg_secondary::endpoints(temperature_k, pressure_pa)?;
        let value = Self {
            pressure_pa,
            temperature_k,
            vapor_density_kg_m3: humidity * saturation[0] / (RV * temperature_k),
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(self) -> Result<(), String> {
        if ![
            self.pressure_pa,
            self.temperature_k,
            self.vapor_density_kg_m3,
        ]
        .iter()
        .all(|x| x.is_finite())
            || self.pressure_pa <= 0.
            || self.temperature_k <= 0.
            || self.vapor_density_kg_m3 < 0.
            || self.vapor_density_kg_m3 * RV * self.temperature_k > self.pressure_pa
        {
            return Err("Invalid supplied WST gas boundary".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Model {
    pub config: Config,
    vapor_enthalpy_datum: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Workspace {
    pub liquid: Liquid,
    pub surface_height_m: f64,
    pub physical_energy_j: f64,
    pub surface_mass_rate_kg_s: f64,
    pub surface_total_enthalpy_j_kg: f64,
    /// Signed exports to the supplied gas resource, including reciprocal work.
    pub gas_export_rate_w: f64,
    pub pressure_work_export_w: f64,
    pub residual: [f64; STATES],
    state_jacobian: [[f64; STATES]; STATES],
    derivative_jacobian: [[f64; STATES]; STATES],
    export_state_jacobian: [f64; STATES],
    export_derivative_jacobian: [f64; STATES],
    boundary_pressure_pa: f64,
    floor_m: f64,
    valid: bool,
}
impl Workspace {
    /// Heat is a caller-owned same-trial port. Replacing that one linear input
    /// does not repeat the native caloric/saturation preparation.
    pub fn add_heat(&mut self, heat_w: f64) -> Result<(), String> {
        if !self.valid || !heat_w.is_finite() {
            return Err("Invalid current WST heat port".into());
        }
        self.residual[ENERGY] -= heat_w;
        Ok(())
    }
    pub fn jacobian(&self, cj: f64) -> Result<[[f64; STATES]; STATES], String> {
        if !self.valid || !cj.is_finite() || cj < 0. {
            return Err("Unavailable WST stage matrix".into());
        }
        Ok(std::array::from_fn(|i| {
            std::array::from_fn(|j| self.state_jacobian[i][j] + cj * self.derivative_jacobian[i][j])
        }))
    }
    pub fn gas_export_jvp(&self, direction: &[f64; STATES], cj: f64) -> Result<f64, String> {
        if !self.valid || !cj.is_finite() || cj < 0. || direction.iter().any(|x| !x.is_finite()) {
            return Err("Unavailable WST export tangent".into());
        }
        Ok((0..STATES)
            .map(|j| {
                (self.export_state_jacobian[j] + cj * self.export_derivative_jacobian[j])
                    * direction[j]
            })
            .sum())
    }
    pub fn local_pressure_pa(&self, elevation_m: f64) -> Result<f64, String> {
        if !self.valid
            || !elevation_m.is_finite()
            || elevation_m < self.floor_m
            || elevation_m > self.surface_height_m
        {
            return Err("Uncovered or invalid WST contact".into());
        }
        Ok(self.boundary_pressure_pa
            + self.liquid.density * GRAVITY * (self.surface_height_m - elevation_m))
    }
}

impl Model {
    pub fn new(config: Config) -> Result<Self, String> {
        let c = config;
        if ![
            c.area_m2,
            c.floor_m,
            c.hardware_volume_m3,
            c.hardware_first_moment_m4,
            c.minimum_fully_wet_height_m,
            c.maximum_height_m,
            c.surface_mass_transfer_m_s,
            c.initial_water_volume_m3,
            c.initial_temperature_k,
        ]
        .iter()
        .all(|x| x.is_finite())
            || c.area_m2 <= 0.
            || c.hardware_volume_m3 < 0.
            || c.hardware_first_moment_m4 < c.floor_m * c.hardware_volume_m3
            || c.hardware_first_moment_m4 > c.minimum_fully_wet_height_m * c.hardware_volume_m3
            || c.minimum_fully_wet_height_m <= c.floor_m
            || c.maximum_height_m <= c.minimum_fully_wet_height_m
            || c.surface_mass_transfer_m_s < 0.
            || c.initial_water_volume_m3 <= 0.
            || c.initial_temperature_k <= 0.
        {
            return Err("Invalid finite WST geometry/preparation".into());
        }
        // One native caloric anchor, not a copied HEOS/reference enthalpy.
        let (_, v, _) = sg_secondary::endpoints(DATUM, 101325.)?;
        Ok(Self {
            config,
            vapor_enthalpy_datum: v.enthalpy,
        })
    }
    pub fn prepare(&self, boundary: GasBoundary) -> Result<[f64; STATES], String> {
        boundary.validate()?;
        let (water, _, _) =
            sg_secondary::endpoints(self.config.initial_temperature_k, boundary.pressure_pa)?;
        let m = water.density * self.config.initial_water_volume_m3;
        let mut y = [
            m,
            0.,
            self.config.initial_temperature_k,
            self.config.initial_water_volume_m3,
        ];
        let mut w = Workspace::default();
        self.evaluate(&y, &[0.; STATES], 0., boundary, &mut w)?;
        y[ENERGY] = w.physical_energy_j;
        Ok(y)
    }
    /// Native forward chart and rates. No inverse or whole-model differencing.
    pub fn evaluate(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        heat_w: f64,
        boundary: GasBoundary,
        w: &mut Workspace,
    ) -> Result<(), String> {
        w.valid = false;
        boundary.validate()?;
        if y.iter().chain(yp).any(|x| !x.is_finite())
            || !heat_w.is_finite()
            || y[MASS] <= 0.
            || y[VOLUME] <= 0.
        {
            return Err("Invalid finite WST trial".into());
        }
        let c = self.config;
        let h = c.floor_m + (y[VOLUME] + c.hardware_volume_m3) / c.area_m2;
        if h < c.minimum_fully_wet_height_m || h > c.maximum_height_m {
            return Err("Finite WST exits fully-wet/nonspill geometry".into());
        }
        let (l, _, sat) = sg_secondary::endpoints(y[TEMPERATURE], boundary.pressure_pa)?;
        if y[TEMPERATURE] >= sat[1] {
            return Err("WST bulk boiling is outside cold receiver".into());
        }
        // Saturated endpoints supply Clapeyron's local forward slope.
        let (sl, sv, _) = sg_secondary::endpoints(y[TEMPERATURE], sat[0])?;
        let dps =
            (sv.enthalpy - sl.enthalpy) / (y[TEMPERATURE] * (1. / sv.density - 1. / sl.density));
        let rhov = sat[0] / (RV * y[TEMPERATURE]);
        let drhov = dps / (RV * y[TEMPERATURE]) - rhov / y[TEMPERATURE];
        let ms = c.surface_mass_transfer_m_s * c.area_m2 * (rhov - boundary.vapor_density_kg_m3);
        let dms = c.surface_mass_transfer_m_s * c.area_m2 * drhov;
        let rho_t = -l.density * l.expansion;
        let u_t = l.cp - boundary.pressure_pa * l.expansion / l.density;
        let first_moment =
            0.5 * c.area_m2 * (h * h - c.floor_m * c.floor_m) - c.hardware_first_moment_m4;
        if !first_moment.is_finite() {
            return Err("Invalid WST free-water first moment".into());
        }
        let e = y[MASS] * l.internal_energy + l.density * GRAVITY * first_moment;
        let evaporation = ms >= 0.;
        let ht = if evaporation {
            self.vapor_enthalpy_datum + CPV * (y[TEMPERATURE] - DATUM) + GRAVITY * h
        } else {
            self.vapor_enthalpy_datum
                + CPV * (boundary.temperature_k - DATUM)
                + GRAVITY * GAS_ORIGIN
        };
        let ht_t = if evaporation { CPV } else { 0. };
        let ht_v = if evaporation { GRAVITY / c.area_m2 } else { 0. };
        let pressure_work = boundary.pressure_pa * yp[VOLUME];
        let export = ms * ht + pressure_work;
        w.residual = [
            yp[MASS] + ms,
            yp[ENERGY] - heat_w + export,
            y[ENERGY] - e,
            y[VOLUME] - y[MASS] / l.density,
        ];
        w.state_jacobian = [[0.; STATES]; STATES];
        w.derivative_jacobian = [[0.; STATES]; STATES];
        w.state_jacobian[0][TEMPERATURE] = dms;
        w.state_jacobian[1][TEMPERATURE] = dms * ht + ms * ht_t;
        w.state_jacobian[1][VOLUME] = ms * ht_v;
        w.state_jacobian[2][MASS] = -l.internal_energy;
        w.state_jacobian[2][ENERGY] = 1.;
        w.state_jacobian[2][TEMPERATURE] = -(y[MASS] * u_t + rho_t * GRAVITY * first_moment);
        w.state_jacobian[2][VOLUME] = -l.density * GRAVITY * h;
        w.state_jacobian[3][MASS] = -1. / l.density;
        w.state_jacobian[3][TEMPERATURE] = y[MASS] * rho_t / (l.density * l.density);
        w.state_jacobian[3][VOLUME] = 1.;
        w.derivative_jacobian[0][MASS] = 1.;
        w.derivative_jacobian[1][ENERGY] = 1.;
        w.derivative_jacobian[1][VOLUME] = boundary.pressure_pa;
        w.export_state_jacobian = w.state_jacobian[1];
        w.export_derivative_jacobian = [0., 0., 0., boundary.pressure_pa];
        w.liquid = l;
        w.surface_height_m = h;
        w.physical_energy_j = e;
        w.surface_mass_rate_kg_s = ms;
        w.surface_total_enthalpy_j_kg = ht;
        w.gas_export_rate_w = export;
        w.pressure_work_export_w = pressure_work;
        w.boundary_pressure_pa = boundary.pressure_pa;
        w.floor_m = c.floor_m;
        if w.residual
            .iter()
            .chain(w.state_jacobian.iter().flatten())
            .any(|x| !x.is_finite())
        {
            return Err("Nonfinite finite WST chart".into());
        }
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        direction: &[f64; STATES],
        cj: f64,
        heat_direction_w: f64,
        w: &Workspace,
    ) -> Result<[f64; STATES], String> {
        if direction.iter().any(|x| !x.is_finite()) || !heat_direction_w.is_finite() {
            return Err("Invalid WST tangent".into());
        }
        let j = w.jacobian(cj)?;
        let mut out = std::array::from_fn(|i| (0..STATES).map(|k| j[i][k] * direction[k]).sum());
        out[1] -= heat_direction_w;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> Model {
        Model::new(Config {
            area_m2: 200.,
            floor_m: 8.,
            hardware_volume_m3: 29.654930,
            hardware_first_moment_m4: 29.654930 * 12.,
            minimum_fully_wet_height_m: 13.28,
            maximum_height_m: 15.5,
            surface_mass_transfer_m_s: 0.001,
            initial_water_volume_m3: 1200.,
            initial_temperature_k: 298.15,
        })
        .unwrap()
    }
    fn gas(t: f64) -> GasBoundary {
        let (_, _, s) = sg_secondary::endpoints(t, 101325.).unwrap();
        GasBoundary {
            pressure_pa: 101325.,
            temperature_k: t,
            vapor_density_kg_m3: s[0] / (RV * t),
        }
    }
    #[test]
    fn actual_displaced_volume_pe_and_native_preparation() {
        let m = model();
        let b = gas(298.15);
        let y = m.prepare(b).unwrap();
        let mut w = Workspace::default();
        m.evaluate(&y, &[0.; 4], 0., b, &mut w).unwrap();
        assert!((w.surface_height_m - 14.14827465).abs() < 1e-10);
        assert_eq!(w.surface_mass_rate_kg_s, 0.);
        assert!(w.residual.iter().all(|x| x.abs() < 1e-7));
        let expected_pe = w.liquid.density
            * GRAVITY
            * (100. * (w.surface_height_m.powi(2) - 64.) - 29.654930 * 12.);
        assert!((y[ENERGY] - y[MASS] * w.liquid.internal_energy - expected_pe).abs() < 0.001);
        assert!(w.local_pressure_pa(12.).unwrap() > b.pressure_pa);
        assert!(w.local_pressure_pa(15.).is_err());
        assert!(w.local_pressure_pa(7.).is_err());
    }
    #[test]
    fn actual_surface_donor_direction_and_work_have_opposite_boundary_receipt() {
        let m = model();
        let b = gas(298.15);
        let y = m.prepare(b).unwrap();
        let mut w = Workspace::default();
        let mut hotter = y;
        hotter[TEMPERATURE] = 303.15;
        let yp = [-0.1, 12., 0., 0.0003];
        m.evaluate(&hotter, &yp, 500., b, &mut w).unwrap();
        assert!(w.surface_mass_rate_kg_s > 0.);
        assert!(
            (w.surface_total_enthalpy_j_kg
                - (m.vapor_enthalpy_datum + CPV * 5. + GRAVITY * w.surface_height_m))
                .abs()
                < 1e-7
        );
        assert!((w.residual[1] - (12. - 500. + w.gas_export_rate_w)).abs() < 1e-8);
        assert_eq!(w.pressure_work_export_w, b.pressure_pa * yp[VOLUME]);
        let mut colder = y;
        colder[TEMPERATURE] = 293.15;
        m.evaluate(&colder, &[0.; 4], 0., b, &mut w).unwrap();
        assert!(w.surface_mass_rate_kg_s < 0.);
        assert!(
            (w.surface_total_enthalpy_j_kg - (m.vapor_enthalpy_datum + GRAVITY * 20.)).abs() < 1e-7
        );
        assert!(w.gas_export_rate_w < 0.);
    }
    #[test]
    fn native_chart_and_surface_tangents_match_local_forward_difference() {
        let m = model();
        let b = gas(298.15);
        let mut y = m.prepare(b).unwrap();
        // Each actual donor side has its own derivative. The zero-flux
        // upwind change is nonsmooth, not a globally differentiable blend.
        for temperature in [293.15, 303.15] {
            y[TEMPERATURE] = temperature;
            let yp = [0.2, 3., 0.04, 0.0001];
            let d = [0.3, 4., 0.2, 0.01];
            let cj = 1.7;
            let mut w = Workspace::default();
            m.evaluate(&y, &yp, 1000., b, &mut w).unwrap();
            let j = m.jvp(&d, cj, 2., &w).unwrap();
            let ej = w.gas_export_jvp(&d, cj).unwrap();
            let eps = 1e-3;
            let a = std::array::from_fn(|k| y[k] + eps * d[k]);
            let za = std::array::from_fn(|k| yp[k] + eps * cj * d[k]);
            let z = std::array::from_fn(|k| y[k] - eps * d[k]);
            let zz = std::array::from_fn(|k| yp[k] - eps * cj * d[k]);
            let mut wa = Workspace::default();
            let mut wz = Workspace::default();
            m.evaluate(&a, &za, 1000. + 2. * eps, b, &mut wa).unwrap();
            m.evaluate(&z, &zz, 1000. - 2. * eps, b, &mut wz).unwrap();
            for k in 0..4 {
                let fd = (wa.residual[k] - wz.residual[k]) / (2. * eps);
                assert!(
                    (j[k] - fd).abs() < 0.0001 * j[k].abs().max(1.),
                    "row{k}: {} vs {fd}",
                    j[k]
                );
            }
            let fd = (wa.gas_export_rate_w - wz.gas_export_rate_w) / (2. * eps);
            assert!((ej - fd).abs() < 0.0001 * ej.abs().max(1.));
        }
    }
    #[test]
    fn geometry_boiling_and_invalid_boundary_refuse_without_stale_stage() {
        let m = model();
        let b = gas(298.15);
        let mut y = m.prepare(b).unwrap();
        let mut w = Workspace::default();
        m.evaluate(&y, &[0.; 4], 0., b, &mut w).unwrap();
        y[VOLUME] = 1000.;
        assert!(m.evaluate(&y, &[0.; 4], 0., b, &mut w).is_err());
        assert!(w.jacobian(1.).is_err());
        y = m.prepare(b).unwrap();
        y[TEMPERATURE] = 380.;
        assert!(m.evaluate(&y, &[0.; 4], 0., b, &mut w).is_err());
        y = m.prepare(b).unwrap();
        let invalid = GasBoundary {
            vapor_density_kg_m3: 20.,
            ..b
        };
        assert!(m.evaluate(&y, &[0.; 4], 0., invalid, &mut w).is_err());
    }
}

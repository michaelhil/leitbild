//! Restricted cold surge: one finite liquid/steel store and TWO signed,
//! quasi-steady end flows. This is not a wave/front or inertial pipe model.
//! The caller must screen omitted half-route inertial heads separately.
use crate::operating_network::{Hydraulic, LossLaw};
use crate::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::sync::Arc;

pub const STATES: usize = 8;
pub const MASS: usize = 0;
pub const ENERGY: usize = 1;
pub const PRESSURE: usize = 2;
pub const TEMPERATURE: usize = 3;
pub const INFLOW: usize = 4;
pub const OUTFLOW: usize = 5;
pub const STEEL_ENERGY: usize = 6;
pub const STEEL_TEMPERATURE: usize = 7;

#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub geometry: CellGeometry,
    pub length: f64,
    pub diameter: f64,
    pub roughness: f64,
    pub entry_loss: f64,
    pub discharge_loss: f64,
    pub bend_loss_each: f64,
    pub steel_mass: f64,
    pub cp0: f64,
    pub cp1: f64,
    pub datum_temperature: f64,
    pub minimum_temperature: f64,
    pub maximum_temperature: f64,
    pub wet_conductance: f64,
    pub ambient_conductance: f64,
    pub ambient_temperature: f64,
}
/// Current physical port pressure and FULL donor h+g*z, not a held reservoir.
/// Its tangent is supplied by the actual neighboring owner.
#[derive(Clone, Copy, Debug, Default)]
pub struct Port {
    pub pressure: f64,
    pub total_enthalpy: f64,
    pub elevation: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct PortDirection {
    pub pressure: f64,
    pub total_enthalpy: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Receipts {
    /// Signed into the line; the neighboring owner receives its opposite.
    pub mass: [f64; 2],
    pub energy: [f64; 2],
    pub wall_heat: f64,
    /// Signed FROM the line steel TO the named external ambient.
    pub ambient_heat: f64,
}
pub struct Model {
    input: Input,
    halves: [Hydraulic; 2],
    owner: Arc<()>,
}
pub struct Workspace {
    owner: Arc<()>,
    valid: bool,
    linearized: bool,
    cj: f64,
    residual: [f64; STATES],
    jacobian: [[f64; STATES]; STATES],
    port_jacobian: [[f64; 4]; STATES],
    receipts: Receipts,
    receipt_jacobian: [[f64; STATES]; 6],
    receipt_ports: [[f64; 4]; 6],
}
fn finite(xs: &[f64]) -> bool {
    xs.iter().all(|x| x.is_finite())
}
fn liquid(p: f64, t: f64) -> Result<Liquid, String> {
    let mut result = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            pressure: p,
            temperature: t,
        }],
        &mut result,
    )
    .map_err(|e| e.message)?;
    Ok(result[0])
}
fn receipt_vector(r: Receipts) -> [f64; 6] {
    [
        r.mass[0],
        r.mass[1],
        r.energy[0],
        r.energy[1],
        r.wall_heat,
        r.ambient_heat,
    ]
}
fn vector_receipt(r: [f64; 6]) -> Receipts {
    Receipts {
        mass: [r[0], r[1]],
        energy: [r[2], r[3]],
        wall_heat: r[4],
        ambient_heat: r[5],
    }
}
impl Model {
    pub fn is_differential(&self, row: usize) -> bool {
        matches!(row, MASS | ENERGY | STEEL_ENERGY)
    }
    pub fn energy_rows(&self) -> impl Iterator<Item = usize> {
        [ENERGY, STEEL_ENERGY].into_iter()
    }
    pub fn new(input: Input) -> Result<Self, String> {
        let values = [
            input.geometry.volume,
            input.geometry.elevation,
            input.length,
            input.diameter,
            input.roughness,
            input.entry_loss,
            input.discharge_loss,
            input.bend_loss_each,
            input.steel_mass,
            input.cp0,
            input.cp1,
            input.datum_temperature,
            input.minimum_temperature,
            input.maximum_temperature,
            input.wet_conductance,
            input.ambient_conductance,
            input.ambient_temperature,
        ];
        if !finite(&values)
            || input.geometry.volume <= 0.
            || input.length <= 0.
            || input.diameter <= 0.
            || input.roughness < 0.
            || input.roughness / input.diameter > 0.1
            || input.entry_loss < 0.
            || input.discharge_loss < 0.
            || input.bend_loss_each < 0.
            || input.steel_mass <= 0.
            || input.minimum_temperature <= 0.
            || input.maximum_temperature <= input.minimum_temperature
            || input.cp0 + input.cp1 * input.minimum_temperature <= 0.
            || input.cp0 + input.cp1 * input.maximum_temperature <= 0.
            || input.wet_conductance <= 0.
            || input.ambient_conductance <= 0.
            || input.ambient_temperature < input.minimum_temperature
            || input.ambient_temperature > input.maximum_temperature
        {
            return Err("Invalid finite cold surge definition".into());
        }
        let area = std::f64::consts::PI * input.diameter.powi(2) / 4.;
        if (area * input.length - input.geometry.volume).abs() > 3e-11 * input.geometry.volume {
            return Err("Surge bore volume does not match its actual route".into());
        }
        let half = Hydraulic {
            from: 0,
            to: 1,
            law: LossLaw::ChurchillPipe,
            length: input.length / 2.,
            flow_area: area,
            diameter: input.diameter,
            roughness: input.roughness,
            fixed_loss: 0.,
            grid_multiplier: 0.,
        };
        Ok(Self {
            input,
            halves: [half; 2],
            owner: Arc::new(()),
        })
    }
    pub fn input(&self) -> Input {
        self.input
    }
    pub fn steel_energy(&self, t: f64) -> f64 {
        self.input.steel_mass
            * (t - self.input.datum_temperature)
            * (self.input.cp0 + self.input.cp1 * (t + self.input.datum_temperature) / 2.)
    }
    pub fn steel_capacity(&self, t: f64) -> f64 {
        self.input.steel_mass * (self.input.cp0 + self.input.cp1 * t)
    }
    pub fn inertial_heads(&self, flow_rates: [f64; 2]) -> Result<[f64; 2], String> {
        let out = std::array::from_fn(|i| self.halves[i].inertance() * flow_rates[i]);
        if !finite(&out) {
            return Err("Nonfinite omitted surge inertial head".into());
        }
        Ok(out)
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            owner: self.owner.clone(),
            valid: false,
            linearized: false,
            cj: 0.,
            residual: [0.; STATES],
            jacobian: [[0.; STATES]; STATES],
            port_jacobian: [[0.; 4]; STATES],
            receipts: Receipts::default(),
            receipt_jacobian: [[0.; STATES]; 6],
            receipt_ports: [[0.; 4]; 6],
        }
    }
    /// Fresh preparation only. Does not solve flow or reset a reached line.
    pub fn prepare(&self, p: f64, t: f64, steel_t: f64) -> Result<[f64; STATES], String> {
        let l = liquid(p, t)?;
        let m = l.density * self.input.geometry.volume;
        let y = [
            m,
            m * (l.internal_energy + GRAVITY * self.input.geometry.elevation),
            p,
            t,
            0.,
            0.,
            self.steel_energy(steel_t),
            steel_t,
        ];
        self.values(
            &y,
            &[0.; STATES],
            &[Port {
                pressure: p,
                total_enthalpy: l.enthalpy + GRAVITY * self.input.geometry.elevation,
                elevation: self.input.geometry.elevation,
            }; 2],
            [true, true],
        )?;
        Ok(y)
    }
    fn values(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        ports: &[Port; 2],
        branch: [bool; 2],
    ) -> Result<([f64; STATES], Receipts), String> {
        let i = self.input;
        if !finite(y)
            || !finite(yp)
            || y[MASS] <= 0.
            || y[PRESSURE] <= 0.
            || [y[TEMPERATURE], y[STEEL_TEMPERATURE]]
                .iter()
                .any(|&t| t < i.minimum_temperature || t > i.maximum_temperature)
            || ports
                .iter()
                .any(|p| !finite(&[p.pressure, p.total_enthalpy, p.elevation]) || p.pressure <= 0.)
        {
            return Err("Cold surge left its finite liquid/temperature domain".into());
        }
        let l = liquid(y[PRESSURE], y[TEMPERATURE])?;
        let hline = l.enthalpy + GRAVITY * i.geometry.elevation;
        let qi = y[INFLOW];
        let qo = y[OUTFLOW];
        let fin = qi
            * if branch[0] {
                ports[0].total_enthalpy
            } else {
                hline
            };
        let fout = qo
            * if branch[1] {
                hline
            } else {
                ports[1].total_enthalpy
            };
        let wall = i.wet_conductance * (y[STEEL_TEMPERATURE] - y[TEMPERATURE]);
        let ambient = i.ambient_conductance * (y[STEEL_TEMPERATURE] - i.ambient_temperature);
        let mut losses = [0.; 2];
        for k in 0..2 {
            let entering = if k == 0 { branch[k] } else { !branch[k] };
            let mut half = self.halves[k];
            half.fixed_loss = i.bend_loss_each
                + if entering {
                    i.entry_loss
                } else {
                    i.discharge_loss
                };
            losses[k] = half.pressure_loss([qi, qo][k], l.density, l.viscosity)[0];
        }
        let mhat = l.density * i.geometry.volume;
        let residual = [
            yp[MASS] - (qi - qo),
            yp[ENERGY] - (fin - fout + wall),
            y[MASS] - mhat,
            y[ENERGY] - mhat * (l.internal_energy + GRAVITY * i.geometry.elevation),
            ports[0].pressure
                - y[PRESSURE]
                - l.density * GRAVITY * (i.geometry.elevation - ports[0].elevation)
                - losses[0],
            y[PRESSURE]
                - ports[1].pressure
                - l.density * GRAVITY * (ports[1].elevation - i.geometry.elevation)
                - losses[1],
            yp[STEEL_ENERGY] + wall + ambient,
            y[STEEL_ENERGY] - self.steel_energy(y[STEEL_TEMPERATURE]),
        ];
        let r = Receipts {
            mass: [qi, -qo],
            energy: [fin, -fout],
            wall_heat: wall,
            ambient_heat: ambient,
        };
        if !finite(&residual) || !finite(&receipt_vector(r)) {
            return Err("Nonfinite finite surge evaluation".into());
        }
        Ok((residual, r))
    }
    /// Stage-owned local forward partials, prepared once. A fixed zero-flow
    /// upwind branch remains linear for every signed Krylov direction.
    pub fn evaluate(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        ports: &[Port; 2],
        cj: Option<f64>,
        w: &mut Workspace,
    ) -> Result<(), String> {
        w.valid = false;
        w.linearized = false;
        if !Arc::ptr_eq(&w.owner, &self.owner) || cj.is_some_and(|c| !c.is_finite() || c < 0.) {
            return Err("Foreign/invalid surge workspace".into());
        }
        let branch = [y[INFLOW] >= 0., y[OUTFLOW] >= 0.];
        let (r, receipts) = self.values(y, yp, ports, branch)?;
        w.residual = r;
        w.receipts = receipts;
        if let Some(c) = cj {
            w.jacobian = [[0.; STATES]; STATES];
            w.port_jacobian = [[0.; 4]; STATES];
            w.receipt_jacobian = [[0.; STATES]; 6];
            w.receipt_ports = [[0.; 4]; 6];
            let l = liquid(y[PRESSURE], y[TEMPERATURE])?;
            let rho = [l.density * l.compressibility, -l.density * l.expansion];
            let dh = [(1. - l.temperature * l.expansion) / l.density, l.cp];
            let du = [
                (l.pressure * l.compressibility - l.temperature * l.expansion) / l.density,
                l.cp - l.pressure * l.expansion / l.density,
            ];
            // Only viscosity lacks a retained forward property derivative.
            // Four bounded local probes prepare it ONCE, never per JVP.
            let dp = (y[PRESSURE] * 1e-5).max(0.1);
            let dt = 1e-3;
            let mu = [
                (liquid(y[PRESSURE] + dp, y[TEMPERATURE])?.viscosity
                    - liquid(y[PRESSURE] - dp, y[TEMPERATURE])?.viscosity)
                    / (2. * dp),
                (liquid(y[PRESSURE], y[TEMPERATURE] + dt)?.viscosity
                    - liquid(y[PRESSURE], y[TEMPERATURE] - dt)?.viscosity)
                    / (2. * dt),
            ];
            let hline = l.enthalpy + GRAVITY * self.input.geometry.elevation;
            let qs = [y[INFLOW], y[OUTFLOW]];
            w.jacobian[MASS][MASS] = c;
            w.jacobian[MASS][INFLOW] = -1.;
            w.jacobian[MASS][OUTFLOW] = 1.;
            w.jacobian[ENERGY][ENERGY] = c;
            w.jacobian[PRESSURE][MASS] = 1.;
            w.jacobian[TEMPERATURE][ENERGY] = 1.;
            w.jacobian[STEEL_ENERGY][STEEL_ENERGY] = c;
            w.jacobian[STEEL_TEMPERATURE][STEEL_ENERGY] = 1.;
            w.jacobian[STEEL_TEMPERATURE][STEEL_TEMPERATURE] =
                -self.steel_capacity(y[STEEL_TEMPERATURE]);
            for k in 0..2 {
                let flow_col = [INFLOW, OUTFLOW][k];
                let sign = if k == 0 { 1. } else { -1. };
                let line_donor = if k == 0 { !branch[k] } else { branch[k] };
                let donor = if line_donor {
                    hline
                } else {
                    ports[k].total_enthalpy
                };
                w.receipt_jacobian[k][flow_col] = sign;
                w.receipt_jacobian[k + 2][flow_col] = sign * donor;
                w.jacobian[ENERGY][flow_col] -= sign * donor;
                if line_donor {
                    for a in 0..2 {
                        w.receipt_jacobian[k + 2][PRESSURE + a] = sign * qs[k] * dh[a];
                        w.jacobian[ENERGY][PRESSURE + a] -= sign * qs[k] * dh[a];
                    }
                } else {
                    w.receipt_ports[k + 2][2 * k + 1] = sign * qs[k];
                    w.port_jacobian[ENERGY][2 * k + 1] = -sign * qs[k];
                }
                let entering = if k == 0 { branch[k] } else { !branch[k] };
                let mut half = self.halves[k];
                half.fixed_loss = self.input.bend_loss_each
                    + if entering {
                        self.input.entry_loss
                    } else {
                        self.input.discharge_loss
                    };
                let loss = half.pressure_loss(qs[k], l.density, l.viscosity);
                let dz = if k == 0 {
                    self.input.geometry.elevation - ports[k].elevation
                } else {
                    ports[k].elevation - self.input.geometry.elevation
                };
                let row = [INFLOW, OUTFLOW][k];
                w.jacobian[row][flow_col] = -loss[1];
                w.port_jacobian[row][2 * k] = sign;
                for a in 0..2 {
                    w.jacobian[row][PRESSURE + a] =
                        -GRAVITY * dz * rho[a] - loss[2] * mu[a] - loss[3] * rho[a];
                }
                w.jacobian[row][PRESSURE] -= sign;
            }
            let mhat = l.density * self.input.geometry.volume;
            for a in 0..2 {
                w.jacobian[PRESSURE][PRESSURE + a] = -self.input.geometry.volume * rho[a];
                w.jacobian[TEMPERATURE][PRESSURE + a] = -self.input.geometry.volume
                    * rho[a]
                    * (l.internal_energy + GRAVITY * self.input.geometry.elevation)
                    - mhat * du[a];
            }
            let gw = self.input.wet_conductance;
            let ga = self.input.ambient_conductance;
            w.jacobian[ENERGY][TEMPERATURE] += gw;
            w.jacobian[ENERGY][STEEL_TEMPERATURE] -= gw;
            w.jacobian[STEEL_ENERGY][TEMPERATURE] = -gw;
            w.jacobian[STEEL_ENERGY][STEEL_TEMPERATURE] = gw + ga;
            w.receipt_jacobian[4][TEMPERATURE] = -gw;
            w.receipt_jacobian[4][STEEL_TEMPERATURE] = gw;
            w.receipt_jacobian[5][STEEL_TEMPERATURE] = ga;
            if !w
                .jacobian
                .iter()
                .flatten()
                .chain(w.port_jacobian.iter().flatten())
                .chain(w.receipt_jacobian.iter().flatten())
                .chain(w.receipt_ports.iter().flatten())
                .all(|v| v.is_finite())
            {
                return Err("Nonfinite surge local partial".into());
            }
            w.cj = c;
            w.linearized = true;
        }
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        w: &Workspace,
        d: &[f64; STATES],
        dp: &[PortDirection; 2],
        cj: f64,
    ) -> Result<([f64; STATES], Receipts), String> {
        if !Arc::ptr_eq(&w.owner, &self.owner)
            || !w.valid
            || !w.linearized
            || w.cj.to_bits() != cj.to_bits()
            || !finite(d)
            || dp.iter().any(|p| !finite(&[p.pressure, p.total_enthalpy]))
        {
            return Err("Unprepared surge linear stage/direction".into());
        }
        let p = [
            dp[0].pressure,
            dp[0].total_enthalpy,
            dp[1].pressure,
            dp[1].total_enthalpy,
        ];
        let action = std::array::from_fn(|row| {
            w.jacobian[row]
                .iter()
                .zip(d)
                .map(|(a, b)| a * b)
                .sum::<f64>()
                + w.port_jacobian[row]
                    .iter()
                    .zip(p)
                    .map(|(a, b)| a * b)
                    .sum::<f64>()
        });
        let rates = std::array::from_fn(|row| {
            w.receipt_jacobian[row]
                .iter()
                .zip(d)
                .map(|(a, b)| a * b)
                .sum::<f64>()
                + w.receipt_ports[row]
                    .iter()
                    .zip(p)
                    .map(|(a, b)| a * b)
                    .sum::<f64>()
        });
        if !finite(&action) || !finite(&rates) {
            return Err("Nonfinite surge tangent".into());
        }
        Ok((action, vector_receipt(rates)))
    }
}
impl Workspace {
    pub fn residual(&self) -> Result<&[f64; STATES], String> {
        if self.valid {
            Ok(&self.residual)
        } else {
            Err("Unprepared surge values".into())
        }
    }
    pub fn receipts(&self) -> Result<Receipts, String> {
        if self.valid {
            Ok(self.receipts)
        } else {
            Err("Unprepared surge receipts".into())
        }
    }
    pub fn jacobian(&self) -> Result<&[[f64; STATES]; STATES], String> {
        if self.valid && self.linearized {
            Ok(&self.jacobian)
        } else {
            Err("Unprepared surge Jacobian".into())
        }
    }
    pub fn port_jacobian(&self) -> Result<&[[f64; 4]; STATES], String> {
        if self.valid && self.linearized {
            Ok(&self.port_jacobian)
        } else {
            Err("Unprepared surge port Jacobian".into())
        }
    }
    pub fn receipt_jacobian(&self) -> Result<&[[f64; STATES]; 6], String> {
        if self.valid && self.linearized {
            Ok(&self.receipt_jacobian)
        } else {
            Err("Unprepared surge receipt Jacobian".into())
        }
    }
    pub fn receipt_port_jacobian(&self) -> Result<&[[f64; 4]; 6], String> {
        if self.valid && self.linearized {
            Ok(&self.receipt_ports)
        } else {
            Err("Unprepared surge receipt port Jacobian".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> Model {
        let d = 0.3;
        let length = 16.;
        Model::new(Input {
            geometry: CellGeometry {
                volume: std::f64::consts::PI * d * d / 4. * length,
                elevation: 3.000896,
            },
            length,
            diameter: d,
            roughness: 1.5e-6,
            entry_loss: 0.5,
            discharge_loss: 1.,
            bend_loss_each: 0.2,
            steel_mass: 3234.584,
            cp0: 469.4448,
            cp1: 0.13480848,
            datum_temperature: 300.,
            minimum_temperature: 290.,
            maximum_temperature: 350.,
            wet_conductance: 15000.,
            ambient_conductance: 12.,
            ambient_temperature: 313.15,
        })
        .unwrap()
    }
    #[test]
    fn two_ports_storage_and_reciprocal_energy_are_not_a_bypass() {
        let m = model();
        let mut y = m.prepare(0.3e6, 300., 301.).unwrap();
        let mut w = m.workspace();
        let ports = [
            Port {
                pressure: 0.31e6,
                total_enthalpy: 120000.,
                elevation: 2.5,
            },
            Port {
                pressure: 0.29e6,
                total_enthalpy: 125000.,
                elevation: 6.5,
            },
        ];
        for q in [[0.2, 0.1], [-0.1, -0.2], [0., 0.]] {
            y[INFLOW] = q[0];
            y[OUTFLOW] = q[1];
            m.evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
                .unwrap();
            let r = w.receipts().unwrap();
            let f = w.residual().unwrap();
            assert_eq!(r.mass, [q[0], -q[1]]);
            assert!((f[MASS] + r.mass.iter().sum::<f64>()).abs() < 1e-14);
            assert!(
                (f[ENERGY] + f[STEEL_ENERGY] + r.energy.iter().sum::<f64>() - r.ambient_heat).abs()
                    < 1e-9
            );
        }
        let inertial = m.inertial_heads([1., -1.]).unwrap();
        assert!(
            (inertial[0] - m.input().length / (2. * m.input().geometry.volume / m.input().length))
                .abs()
                < 1e-12
        );
        assert_eq!(inertial[1], -inertial[0]);
    }
    #[test]
    fn complete_local_and_port_direction_matches_forward_difference() {
        let m = model();
        let mut y = m.prepare(0.3e6, 300., 301.).unwrap();
        y[INFLOW] = 0.2;
        y[OUTFLOW] = -0.1;
        let ports = [
            Port {
                pressure: 0.31e6,
                total_enthalpy: 120000.,
                elevation: 2.5,
            },
            Port {
                pressure: 0.29e6,
                total_enthalpy: 125000.,
                elevation: 6.5,
            },
        ];
        let dp = [
            PortDirection {
                pressure: 17.,
                total_enthalpy: 23.,
            },
            PortDirection {
                pressure: -11.,
                total_enthalpy: -19.,
            },
        ];
        let d = [0.02, 31., 19., 0.03, 0.04, -0.02, 27., -0.01];
        let cj = 3.;
        let yp = [0.02; STATES];
        let mut w = m.workspace();
        m.evaluate(&y, &yp, &ports, Some(cj), &mut w).unwrap();
        let action = m.jvp(&w, &d, &dp, cj).unwrap().0;
        for eps in [1e-3, 5e-4] {
            let mut arms = [[0.; STATES]; 2];
            for (k, sign) in [-1., 1.].into_iter().enumerate() {
                let yy = std::array::from_fn(|i| y[i] + sign * eps * d[i]);
                let yd = std::array::from_fn(|i| yp[i] + sign * eps * cj * d[i]);
                let pp = std::array::from_fn(|i| Port {
                    pressure: ports[i].pressure + sign * eps * dp[i].pressure,
                    total_enthalpy: ports[i].total_enthalpy + sign * eps * dp[i].total_enthalpy,
                    ..ports[i]
                });
                m.evaluate(&yy, &yd, &pp, None, &mut w).unwrap();
                arms[k] = *w.residual().unwrap();
            }
            for i in 0..STATES {
                let fd = (arms[1][i] - arms[0][i]) / (2. * eps);
                assert!(
                    (fd - action[i]).abs() < 2e-4 * action[i].abs().max(1.),
                    "row{i}: {fd} vs {}",
                    action[i]
                );
            }
        }
    }
    #[test]
    fn prepared_linear_lifecycle_and_zero_flow_branch_are_explicit() {
        let m = model();
        let y = m.prepare(0.3e6, 300., 300.).unwrap();
        let mut w = m.workspace();
        let ports = [
            Port {
                pressure: 0.3e6,
                total_enthalpy: 123000.,
                elevation: 2.5,
            },
            Port {
                pressure: 0.3e6,
                total_enthalpy: 124000.,
                elevation: 6.5,
            },
        ];
        m.evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
            .unwrap();
        let mut d = [0.; STATES];
        d[INFLOW] = 1.;
        let a = m.jvp(&w, &d, &[PortDirection::default(); 2], 1.).unwrap().0;
        let nd = d.map(|x| -x);
        let b = m
            .jvp(&w, &nd, &[PortDirection::default(); 2], 1.)
            .unwrap()
            .0;
        for i in 0..STATES {
            assert_eq!(a[i], -b[i]);
        }
        m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
        assert!(m.jvp(&w, &d, &[PortDirection::default(); 2], 1.).is_err());
        let foreign = model();
        assert!(
            foreign
                .evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
                .is_err()
        );
        assert!(w.receipts().is_err());
        m.evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
            .unwrap();
        let mut bad = y;
        bad[PRESSURE] = f64::NAN;
        assert!(
            m.evaluate(&bad, &[0.; STATES], &ports, None, &mut w)
                .is_err()
        );
        assert!(w.residual().is_err());
    }
    #[test]
    #[ignore = "bounded component-only timing; no advancing integration"]
    fn held_component_cost() {
        let m = model();
        let mut y = m.prepare(0.3e6, 300., 301.).unwrap();
        y[INFLOW] = 0.2;
        y[OUTFLOW] = 0.1;
        let ports = [
            Port {
                pressure: 0.31e6,
                total_enthalpy: 120000.,
                elevation: 2.5,
            },
            Port {
                pressure: 0.29e6,
                total_enthalpy: 125000.,
                elevation: 6.5,
            },
        ];
        let mut w = m.workspace();
        let z = [0.; STATES];
        let start = std::time::Instant::now();
        for _ in 0..100 {
            m.evaluate(&y, &z, &ports, None, &mut w).unwrap();
        }
        let value = start.elapsed().as_secs_f64();
        let start = std::time::Instant::now();
        for _ in 0..100 {
            m.evaluate(&y, &z, &ports, Some(1.), &mut w).unwrap();
        }
        let linear = start.elapsed().as_secs_f64();
        let start = std::time::Instant::now();
        for _ in 0..100 {
            std::hint::black_box(
                m.jvp(&w, &[0.01; STATES], &[PortDirection::default(); 2], 1.)
                    .unwrap(),
            );
        }
        eprintln!(
            "Surge component only: 100 value={value:.9}s, linear={linear:.9}s, JVP={:.9}s",
            start.elapsed().as_secs_f64()
        );
    }
}

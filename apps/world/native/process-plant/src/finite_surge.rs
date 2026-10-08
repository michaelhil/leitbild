//! Sound-filtered cold surge: finite liquid M/E and steel, with two algebraic
//! signed endpoint flows. E=M*(u+g*z_mean); no route momentum or kinetic store.
//! Half-route resistance uses owned bulk rho/mu and continuous hydrostatic head.
//! The terminal coefficient is a once-paid resistance-node allocation of the
//! authored entrance/discharge budget to the incoming half, not a transient
//! center-pressure reconstruction. Static donor enthalpy/PE receipts are shared
//! exactly with finite neighbors; no separate friction heater is added.
use crate::operating_network::{HydraulicSegment, LossLaw};
use crate::{liquid_batch, CellGeometry, Liquid, LiquidQuery, GRAVITY};
use std::sync::Arc;

pub const STATES: usize = 8;
pub const MASS: usize = 0;
pub const ENERGY: usize = 1;
pub const PRESSURE: usize = 2;
pub const TEMPERATURE: usize = 3;
pub const LEFT_FLOW: usize = 4;
pub const RIGHT_FLOW: usize = 5;
pub const STEEL_ENERGY: usize = 6;
pub const STEEL_TEMPERATURE: usize = 7;

#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub geometry: CellGeometry,
    pub length: f64,
    pub diameter: f64,
    pub roughness: f64,
    pub terminal_loss: f64,
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
    pub density: f64,
    pub temperature: f64,
    pub entropy: f64,
    /// Thermodynamic donor pressure, distinct from mechanical traction.
    pub eos_pressure: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct PortDirection {
    pub pressure: f64,
    pub total_enthalpy: f64,
    pub density: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Diagnostics {
    pub velocities: [f64; 2],
    pub hydraulic_residual_pa: [f64; 2],
    pub hydraulic_residual_scale_pa: [f64; 2],
    /// Sum q*loss/rho >=0. A hydraulic dissipation diagnostic, NOT an extra
    /// energy recipient or a proof of the coupled low-Mach entropy law.
    pub passive_dissipation_w: f64,
    /// Omitted v^2/(2*cp), using the same line-bulk velocity and cp as the
    /// hydraulic owner. Not a donor-jet or inertial waveform/error bound.
    pub kinetic_temperature_equivalent_k: [f64; 2],
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
    halves: [HydraulicSegment; 2],
    owner: Arc<()>,
}
pub struct Workspace {
    owner: Arc<()>,
    valid: bool,
    linearized: bool,
    cj: f64,
    residual: [f64; STATES],
    jacobian: [[f64; STATES]; STATES],
    port_jacobian: [[f64; 6]; STATES],
    receipts: Receipts,
    receipt_jacobian: [[f64; STATES]; 6],
    receipt_ports: [[f64; 6]; 6],
    diagnostics: Diagnostics,
    state: [f64; STATES],
    chart: [[f64; 2]; 2],
}
// Private scalar directional arithmetic: one constitutive formula prepares
// all fixed-small partials without EOS probes per column or per Krylov action.
#[derive(Clone, Copy, Default)]
struct D {
    v: f64,
    d: f64,
}
impl D {
    fn new(v: f64, d: f64) -> Self {
        Self { v, d }
    }
}
impl From<f64> for D {
    fn from(v: f64) -> Self {
        Self::new(v, 0.)
    }
}
impl std::ops::Add for D {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self::new(self.v + b.v, self.d + b.d)
    }
}
impl std::ops::Sub for D {
    type Output = Self;
    fn sub(self, b: Self) -> Self {
        Self::new(self.v - b.v, self.d - b.d)
    }
}
impl std::ops::Mul for D {
    type Output = Self;
    fn mul(self, b: Self) -> Self {
        Self::new(self.v * b.v, self.d * b.v + self.v * b.d)
    }
}
impl std::ops::Div for D {
    type Output = Self;
    fn div(self, b: Self) -> Self {
        Self::new(self.v / b.v, (self.d - (self.v / b.v) * b.d) / b.v)
    }
}
impl std::ops::Neg for D {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.v, -self.d)
    }
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
#[cfg(test)]
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
            input.terminal_loss,
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
            || input.terminal_loss < 0.
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
        let half = HydraulicSegment {
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
    pub fn workspace(&self) -> Workspace {
        Workspace {
            owner: self.owner.clone(),
            valid: false,
            linearized: false,
            cj: 0.,
            residual: [0.; STATES],
            jacobian: [[0.; STATES]; STATES],
            port_jacobian: [[0.; 6]; STATES],
            receipts: Receipts::default(),
            receipt_jacobian: [[0.; STATES]; 6],
            receipt_ports: [[0.; 6]; 6],
            diagnostics: Diagnostics::default(),
            state: [0.; STATES],
            chart: [[0.; 2]; 2],
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
        self.evaluate(
            &y,
            &[0.; STATES],
            &[Port {
                pressure: p,
                total_enthalpy: l.enthalpy + GRAVITY * self.input.geometry.elevation,
                elevation: self.input.geometry.elevation,
                density: l.density,
                temperature: t,
                entropy: l.entropy,
                eos_pressure: p,
            }; 2],
            None,
            &mut self.workspace(),
        )?;
        Ok(y)
    }
    fn kernel(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        ports: &[Port; 2],
        branch: [bool; 2],
        l: Liquid,
        mu: [f64; 2],
        d: &[f64; STATES],
        dp: &[PortDirection; 2],
        cj: f64,
    ) -> Result<([D; STATES], [D; 6], Diagnostics), String> {
        let i = self.input;
        let x: [D; STATES] = std::array::from_fn(|k| D::new(y[k], d[k]));
        let rho = D::new(
            l.density,
            l.density * (l.compressibility * d[PRESSURE] - l.expansion * d[TEMPERATURE]),
        );
        let u = D::new(
            l.internal_energy,
            (l.pressure * l.compressibility - l.temperature * l.expansion) / l.density
                * d[PRESSURE]
                + (l.cp - l.pressure * l.expansion / l.density) * d[TEMPERATURE],
        );
        let viscosity = D::new(l.viscosity, mu[0] * d[PRESSURE] + mu[1] * d[TEMPERATURE]);
        let area = i.geometry.volume / i.length;
        let q = [x[LEFT_FLOW], x[RIGHT_FLOW]];
        let outgoing_h = u + x[PRESSURE] / rho + D::from(GRAVITY * i.geometry.elevation);
        let mut h = [D::default(); 2];
        let mut hydraulic = [D::default(); 2];
        let mut hydraulic_scale = [0.; 2];
        let mut dissipation = 0.;
        for k in 0..2 {
            let inward = if k == 0 { branch[k] } else { !branch[k] };
            h[k] = if inward {
                D::new(ports[k].total_enthalpy, dp[k].total_enthalpy)
            } else {
                outgoing_h
            };
            let mut half = self.halves[k];
            half.fixed_loss = i.bend_loss_each + if inward { i.terminal_loss } else { 0. };
            // Wall/bend/terminal resistance belongs to the finite mixed line,
            // not the upwind material packet. Its zero-flow laminar slope is
            // positive and independent of the donor branch.
            let loss = half.pressure_loss(q[k].v, rho.v, viscosity.v);
            if !finite(&loss) || loss[1] <= 0. {
                return Err("Nonmonotone/nonfinite surge resistance".into());
            }
            let resistance = D::new(
                loss[0],
                loss[1] * q[k].d + loss[2] * viscosity.d + loss[3] * rho.d,
            );
            let face =
                x[PRESSURE] + rho * D::from(GRAVITY * (i.geometry.elevation - ports[k].elevation));
            let p = D::new(ports[k].pressure, dp[k].pressure);
            hydraulic[k] = if k == 0 {
                p - face - resistance
            } else {
                face - p - resistance
            };
            hydraulic_scale[k] = p.v.abs() + face.v.abs() + resistance.v.abs();
            dissipation += q[k].v * resistance.v / rho.v;
        }
        let mass = q[0] - q[1];
        let wall = D::from(i.wet_conductance) * (x[STEEL_TEMPERATURE] - x[TEMPERATURE]);
        let ambient = D::from(i.ambient_conductance)
            * (x[STEEL_TEMPERATURE] - D::from(i.ambient_temperature));
        let energy = q[0] * h[0] - q[1] * h[1] + wall;
        let mhat = D::from(i.geometry.volume) * rho;
        let steel = D::new(
            self.steel_energy(y[STEEL_TEMPERATURE]),
            self.steel_capacity(y[STEEL_TEMPERATURE]) * d[STEEL_TEMPERATURE],
        );
        let f = [
            D::new(yp[MASS], cj * d[MASS]) - mass,
            D::new(yp[ENERGY], cj * d[ENERGY]) - energy,
            x[MASS] - mhat,
            x[ENERGY] - mhat * (u + D::from(GRAVITY * i.geometry.elevation)),
            hydraulic[0],
            hydraulic[1],
            D::new(yp[STEEL_ENERGY], cj * d[STEEL_ENERGY]) + wall + ambient,
            x[STEEL_ENERGY] - steel,
        ];
        let receipts = [q[0], -q[1], q[0] * h[0], -q[1] * h[1], wall, ambient];
        let velocities = q.map(|a| a.v / (rho.v * area));
        let diagnostics = Diagnostics {
            velocities,
            hydraulic_residual_pa: hydraulic.map(|a| a.v),
            hydraulic_residual_scale_pa: hydraulic_scale,
            passive_dissipation_w: dissipation,
            kinetic_temperature_equivalent_k: velocities.map(|v| v * v / (2. * l.cp)),
        };
        if f.iter()
            .chain(&receipts)
            .any(|a| !a.v.is_finite() || !a.d.is_finite())
            || !finite(&velocities)
            || !finite(&hydraulic_scale)
            || !finite(&diagnostics.kinetic_temperature_equivalent_k)
            || !dissipation.is_finite()
            || dissipation < 0.
        {
            return Err("Nonfinite/nonpassive finite surge response".into());
        }
        Ok((f, receipts, diagnostics))
    }
    /// Current owned value/linearized stage. EOS and viscosity partials are
    /// prepared once; local fixed-small contractions never query properties.
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
        let i = self.input;
        if !Arc::ptr_eq(&w.owner, &self.owner) || cj.is_some_and(|c| !c.is_finite() || c < 0.) {
            return Err("Foreign/invalid surge workspace".into());
        }
        if !finite(y)
            || !finite(yp)
            || y[MASS] <= 0.
            || y[PRESSURE] <= 0.
            || [y[TEMPERATURE], y[STEEL_TEMPERATURE]]
                .iter()
                .any(|&t| t < i.minimum_temperature || t > i.maximum_temperature)
            || ports.iter().any(|p| {
                !finite(&[
                    p.pressure,
                    p.total_enthalpy,
                    p.elevation,
                    p.density,
                    p.temperature,
                    p.entropy,
                    p.eos_pressure,
                ]) || p.pressure <= 0.
                    || p.density <= 0.
                    || p.temperature <= 0.
                    || p.eos_pressure <= 0.
            })
        {
            return Err("Cold surge left its finite liquid/temperature domain".into());
        }
        let l = liquid(y[PRESSURE], y[TEMPERATURE])?;
        let cv = l.cp - l.temperature * l.expansion.powi(2) / (l.density * l.compressibility);
        if !finite(&[l.density, l.viscosity, l.cp, l.compressibility, cv])
            || l.density <= 0.
            || l.viscosity <= 0.
            || l.cp <= 0.
            || l.compressibility <= 0.
            || cv <= 0.
        {
            return Err("Nonpositive/singular cold surge storage or resistance".into());
        }
        let branch = [y[LEFT_FLOW] >= 0., y[RIGHT_FLOW] >= 0.];
        let (f, r, m) = self.kernel(
            y,
            yp,
            ports,
            branch,
            l,
            [0.; 2],
            &[0.; STATES],
            &[PortDirection::default(); 2],
            0.,
        )?;
        w.residual = f.map(|a| a.v);
        w.receipts = vector_receipt(r.map(|a| a.v));
        w.diagnostics = m;
        let mass = i.geometry.volume * l.density;
        let mass_p = mass * l.compressibility;
        let mass_t = -mass * l.expansion;
        let specific = l.internal_energy + GRAVITY * i.geometry.elevation;
        let u_p = (l.pressure * l.compressibility - l.temperature * l.expansion) / l.density;
        let u_t = l.cp - l.pressure * l.expansion / l.density;
        w.chart = [
            [-mass_p, -mass_t],
            [
                -mass_p * specific - mass * u_p,
                -mass_t * specific - mass * u_t,
            ],
        ];
        let det = w.chart[0][0] * w.chart[1][1] - w.chart[0][1] * w.chart[1][0];
        if w.chart.iter().flatten().any(|v| !v.is_finite()) || !det.is_finite() || det == 0. {
            return Err("Singular surge forward chart".into());
        }
        if let Some(c) = cj {
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
            for col in 0..STATES + 6 {
                let mut d = [0.; STATES];
                let mut pd = [PortDirection::default(); 2];
                if col < STATES {
                    d[col] = 1.;
                } else {
                    let k = (col - STATES) / 3;
                    match (col - STATES) % 3 {
                        0 => pd[k].pressure = 1.,
                        1 => pd[k].total_enthalpy = 1.,
                        _ => pd[k].density = 1.,
                    }
                }
                let (f, r, _) = self.kernel(y, yp, ports, branch, l, mu, &d, &pd, c)?;
                for row in 0..STATES {
                    if col < STATES {
                        w.jacobian[row][col] = f[row].d;
                    } else {
                        w.port_jacobian[row][col - STATES] = f[row].d;
                    }
                }
                for row in 0..6 {
                    if col < STATES {
                        w.receipt_jacobian[row][col] = r[row].d;
                    } else {
                        w.receipt_ports[row][col - STATES] = r[row].d;
                    }
                }
            }
            w.cj = c;
            w.linearized = true;
        }
        w.state = *y;
        w.valid = true;
        Ok(())
    }
    /// Current value-only physical correction; no viscosity probes or full
    /// response Jacobian are needed. Exact state/owner identity is required.
    pub fn chart_corrections(&self, w: &Workspace, y: &[f64; STATES]) -> Result<[f64; 2], String> {
        if !Arc::ptr_eq(&w.owner, &self.owner)
            || !w.valid
            || !y
                .iter()
                .zip(w.state)
                .all(|(a, b)| a.to_bits() == b.to_bits())
        {
            return Err("Unprepared/current-state surge chart".into());
        }
        let [[a, b], [c, d]] = w.chart;
        let det = a * d - b * c;
        let fm = w.residual[PRESSURE];
        let fe = w.residual[TEMPERATURE];
        let result = [(b * fe - d * fm) / det, (c * fm - a * fe) / det];
        if !finite(&result) {
            return Err("Nonfinite surge chart correction".into());
        }
        Ok(result)
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
            || dp
                .iter()
                .any(|p| !finite(&[p.pressure, p.total_enthalpy, p.density]))
        {
            return Err("Unprepared surge linear stage/direction".into());
        }
        let p = [
            dp[0].pressure,
            dp[0].total_enthalpy,
            dp[0].density,
            dp[1].pressure,
            dp[1].total_enthalpy,
            dp[1].density,
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
    pub fn diagnostics(&self) -> Result<Diagnostics, String> {
        if self.valid {
            Ok(self.diagnostics)
        } else {
            Err("Unprepared surge diagnostics".into())
        }
    }
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
    pub fn receipt_jacobian(&self) -> Result<&[[f64; STATES]; 6], String> {
        if self.valid && self.linearized {
            Ok(&self.receipt_jacobian)
        } else {
            Err("Unprepared surge receipt Jacobian".into())
        }
    }
    pub fn receipt_port_jacobian(&self) -> Result<&[[f64; 6]; 6], String> {
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
        let diameter: f64 = 0.3;
        Model::new(Input {
            geometry: CellGeometry {
                volume: std::f64::consts::PI * diameter.powi(2) / 4. * 16.,
                elevation: 3.000896,
            },
            length: 16.,
            diameter,
            roughness: 1.5e-6,
            terminal_loss: 1.5,
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
    fn port(p: f64, t: f64, z: f64) -> Port {
        let l = liquid(p, t).unwrap();
        Port {
            pressure: p,
            total_enthalpy: l.enthalpy + GRAVITY * z,
            elevation: z,
            density: l.density,
            temperature: t,
            entropy: l.entropy,
            eos_pressure: p,
        }
    }
    fn state(m: &Model, q: [f64; 2]) -> [f64; STATES] {
        let mut y = m.prepare(0.3e6, 300., 300.).unwrap();
        y[LEFT_FLOW] = q[0];
        y[RIGHT_FLOW] = q[1];
        y
    }
    fn close(a: f64, b: f64, scale: f64) {
        assert!((a - b).abs() <= scale, "{a:e} != {b:e}, delta={:e}", a - b);
    }
    #[test]
    fn finite_storage_reciprocal_heat_and_signed_packets_do_not_bypass_the_line() {
        let m = model();
        let ports = [port(0.31e6, 298., 2.5), port(0.29e6, 302., 6.5)];
        for q in [[1., 2.], [-2., -1.], [1., -1.], [-1., 1.], [0., 0.]] {
            let y = state(&m, q);
            let mut w = m.workspace();
            m.evaluate(&y, &[0.; STATES], &ports, Some(2.), &mut w)
                .unwrap();
            let r = w.receipts().unwrap();
            let f = w.residual().unwrap();
            assert_eq!(r.mass, [q[0], -q[1]]);
            close(f[MASS], -q[0] + q[1], 0.);
            close(
                f[ENERGY] + f[STEEL_ENERGY] + r.energy.iter().sum::<f64>() - r.ambient_heat,
                0.,
                1e-8,
            );
            assert!(w.diagnostics().unwrap().passive_dissipation_w >= 0.);
            assert!(!m.is_differential(LEFT_FLOW) && !m.is_differential(RIGHT_FLOW));
            assert_eq!(m.energy_rows().collect::<Vec<_>>(), [ENERGY, STEEL_ENERGY]);
            for k in 0..2 {
                let inward = if k == 0 { q[k] >= 0. } else { q[k] < 0. };
                let l = liquid(y[PRESSURE], y[TEMPERATURE]).unwrap();
                let h = if inward {
                    ports[k].total_enthalpy
                } else {
                    l.internal_energy
                        + y[PRESSURE] / l.density
                        + GRAVITY * m.input.geometry.elevation
                };
                assert_eq!(r.energy[k], r.mass[k] * h);
            }
        }
        let mut y = state(&m, [1., 0.25]);
        y[STEEL_TEMPERATURE] = 301.;
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
        let r = w.receipts().unwrap();
        assert_eq!(r.wall_heat, 15000.);
        assert!(r.ambient_heat < 0.);
        assert_eq!(w.residual().unwrap()[MASS], -0.75);
    }
    #[test]
    fn terminal_budget_is_paid_once_and_bulk_resistance_is_monotone_at_zero() {
        let m = model();
        let l = liquid(0.3e6, 300.).unwrap();
        let ports = [port(0.3e6, 290., 3.), port(0.3e6, 330., 3.)];
        let mut w = m.workspace();
        for sign in [-1., 1.] {
            let y = state(&m, [sign, sign]);
            m.evaluate(&y, &[0.; STATES], &ports, Some(0.), &mut w)
                .unwrap();
            let f = w.residual().unwrap();
            let base = m.halves[0].pressure_loss(sign, l.density, l.viscosity)[0];
            let dynamic = sign * sign.abs() / (2. * l.density * m.halves[0].flow_area.powi(2));
            close(
                -(f[LEFT_FLOW] + f[RIGHT_FLOW]),
                2. * base + (m.input.terminal_loss + 2. * m.input.bend_loss_each) * dynamic,
                1e-10,
            );
        }
        let y = state(&m, [0.; 2]);
        m.evaluate(&y, &[0.; STATES], &ports, Some(0.), &mut w)
            .unwrap();
        let j = *w.jacobian().unwrap();
        assert!(j[LEFT_FLOW][LEFT_FLOW] < 0. && j[RIGHT_FLOW][RIGHT_FLOW] < 0.);
        close(j[LEFT_FLOW][LEFT_FLOW], j[RIGHT_FLOW][RIGHT_FLOW], 0.);
        for q in [-20., -1., -1e-8, 0., 1e-8, 1., 20.] {
            m.evaluate(&state(&m, [q, q]), &[0.; STATES], &ports, Some(0.), &mut w)
                .unwrap();
            let j = w.jacobian().unwrap();
            assert!(j[LEFT_FLOW][LEFT_FLOW] < 0. && j[RIGHT_FLOW][RIGHT_FLOW] < 0.);
        }
    }
    #[test]
    fn unequal_density_hydrostatic_rest_is_unique_and_force_continuous() {
        let m = model();
        let l = liquid(0.3e6, 300.).unwrap();
        let mut ports = [port(0.3e6, 290., 2.5), port(0.3e6, 330., 6.5)];
        for p in &mut ports {
            p.pressure = 0.3e6 + l.density * GRAVITY * (m.input.geometry.elevation - p.elevation);
        }
        let mut w = m.workspace();
        m.evaluate(&state(&m, [0.; 2]), &[0.; STATES], &ports, Some(0.), &mut w)
            .unwrap();
        for row in [LEFT_FLOW, RIGHT_FLOW] {
            close(w.residual().unwrap()[row], 0., 1e-10);
        }
        let j = *w.jacobian().unwrap();
        for sign in [-1., 1.] {
            let q = sign * 1e-6;
            m.evaluate(&state(&m, [q, q]), &[0.; STATES], &ports, None, &mut w)
                .unwrap();
            for row in [LEFT_FLOW, RIGHT_FLOW] {
                let f = w.residual().unwrap()[row];
                assert!(f * q < 0.);
                close(f / q, j[row][row], 1e-5);
            }
        }
    }
    #[test]
    fn complete_local_and_port_partials_match_full_half_fd() {
        let m = model();
        let y = state(&m, [2., -1.]);
        let ports = [port(0.31e6, 300., 2.5), port(0.29e6, 301., 6.5)];
        let dp = [
            PortDirection {
                pressure: 17.,
                total_enthalpy: 23.,
                density: 0.02,
            },
            PortDirection {
                pressure: -11.,
                total_enthalpy: -19.,
                density: -0.01,
            },
        ];
        let d = [0.02, 31., 19., 0.03, 0.04, -0.02, 27., -0.01];
        let cj = 3.;
        let yp = [0.02; STATES];
        let mut w = m.workspace();
        m.evaluate(&y, &yp, &ports, Some(cj), &mut w).unwrap();
        let (action, receipt) = m.jvp(&w, &d, &dp, cj).unwrap();
        for eps in [1e-3, 5e-4] {
            let mut f = [[0.; STATES]; 2];
            let mut r = [[0.; 6]; 2];
            for (k, sign) in [-1., 1.].into_iter().enumerate() {
                let yy = std::array::from_fn(|j| y[j] + sign * eps * d[j]);
                let yd = std::array::from_fn(|j| yp[j] + sign * eps * cj * d[j]);
                let pp = std::array::from_fn(|j| Port {
                    pressure: ports[j].pressure + sign * eps * dp[j].pressure,
                    total_enthalpy: ports[j].total_enthalpy + sign * eps * dp[j].total_enthalpy,
                    density: ports[j].density + sign * eps * dp[j].density,
                    ..ports[j]
                });
                m.evaluate(&yy, &yd, &pp, None, &mut w).unwrap();
                f[k] = *w.residual().unwrap();
                r[k] = receipt_vector(w.receipts().unwrap());
            }
            for row in 0..STATES {
                let fd = (f[1][row] - f[0][row]) / (2. * eps);
                let roundoff =
                    16. * f64::EPSILON * (f[0][row].abs() + f[1][row].abs()) / (2. * eps);
                close(
                    fd,
                    action[row],
                    2e-5 * fd.abs().max(action[row].abs()) + roundoff + 1e-7,
                );
            }
            let a = receipt_vector(receipt);
            for row in 0..6 {
                let fd = (r[1][row] - r[0][row]) / (2. * eps);
                close(fd, a[row], 2e-5 * fd.abs().max(a[row].abs()) + 1e-6);
            }
        }
    }
    #[test]
    fn flow_rows_have_no_hidden_rate_mass_matrix_and_rc_mode_is_dissipative() {
        let m = model();
        let y = state(&m, [1., -2.]);
        let ports = [port(0.31e6, 300., 2.5), port(0.29e6, 301., 6.5)];
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], &ports, Some(0.), &mut w)
            .unwrap();
        let f = *w.residual().unwrap();
        let j0 = *w.jacobian().unwrap();
        m.evaluate(&y, &[1.; STATES], &ports, Some(7.), &mut w)
            .unwrap();
        let j = w.jacobian().unwrap();
        for r in 0..STATES {
            close(
                w.residual().unwrap()[r] - f[r],
                if m.is_differential(r) { 1. } else { 0. },
                0.,
            );
            for c in 0..STATES {
                close(
                    j[r][c] - j0[r][c],
                    if r == c && m.is_differential(r) {
                        7.
                    } else {
                        0.
                    },
                    1e-10,
                );
            }
        }
        // Fixed-temperature hydraulic subsystem: Cline*p'=qL-qR,
        // dqL/dp=-1/RL', dqR/dp=+1/RR'. Positive compliance and
        // resistance therefore give a strictly negative relaxation root,
        // not a pair of imaginary inertial roots.
        let compliance = -j0[PRESSURE][PRESSURE];
        let relaxation =
            (1. / j0[LEFT_FLOW][LEFT_FLOW] + 1. / j0[RIGHT_FLOW][RIGHT_FLOW]) / compliance;
        assert!(compliance > 0. && relaxation.is_finite() && relaxation < 0.);
    }
    #[test]
    fn vertical_datum_covariance_and_value_only_chart_rank() {
        let m = model();
        let mut y = state(&m, [1., -2.]);
        let mut yp = [0.; STATES];
        yp[MASS] = 0.03;
        let ports = [port(0.31e6, 300., 2.5), port(0.29e6, 300., 6.5)];
        let mut w = m.workspace();
        m.evaluate(&y, &yp, &ports, None, &mut w).unwrap();
        let f = *w.residual().unwrap();
        let correction = m.chart_corrections(&w, &y).unwrap();
        close(correction[0], 0., 1e-5);
        close(correction[1], 0., 1e-10);
        let mut input = m.input();
        input.geometry.elevation += 7.;
        let other = Model::new(input).unwrap();
        let mut wo = other.workspace();
        y[ENERGY] += y[MASS] * GRAVITY * 7.;
        yp[ENERGY] += yp[MASS] * GRAVITY * 7.;
        let pp = ports.map(|p| Port {
            elevation: p.elevation + 7.,
            total_enthalpy: p.total_enthalpy + GRAVITY * 7.,
            ..p
        });
        other.evaluate(&y, &yp, &pp, None, &mut wo).unwrap();
        for row in [LEFT_FLOW, RIGHT_FLOW] {
            close(wo.residual().unwrap()[row], f[row], 1e-10);
        }
        close(
            wo.residual().unwrap()[ENERGY],
            f[ENERGY] + GRAVITY * 7. * f[MASS],
            1e-8,
        );
        assert!(m.chart_corrections(&wo, &y).is_err());
    }
    #[test]
    fn current_value_chart_and_failed_foreign_refresh_refuse_stale_use() {
        let m = model();
        let y = state(&m, [0.; 2]);
        let ports = [port(0.3e6, 300., 3.); 2];
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
            .unwrap();
        let d = [0.1; STATES];
        assert!(m.jvp(&w, &d, &[PortDirection::default(); 2], 1.).is_ok());
        let mut changed = y;
        changed[ENERGY] += 100.;
        assert!(m.chart_corrections(&w, &changed).is_err());
        m.evaluate(&changed, &[0.; STATES], &ports, None, &mut w)
            .unwrap();
        let correction = m.chart_corrections(&w, &changed).unwrap();
        assert!(correction[0].abs() > 0. && correction[1] > 0.);
        assert!(m.jvp(&w, &d, &[PortDirection::default(); 2], 1.).is_err());
        assert!(model()
            .evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
            .is_err());
        assert!(w.diagnostics().is_err());
        let mut bad = y;
        bad[PRESSURE] = f64::NAN;
        assert!(m
            .evaluate(&bad, &[0.; STATES], &ports, Some(1.), &mut w)
            .is_err());
        assert!(w.receipts().is_err());
    }
    #[test]
    fn zero_flow_material_tangent_is_fixed_branch_not_central_frechet() {
        let m = model();
        let y = state(&m, [0.; 2]);
        let ports = [port(0.3e6, 298., 3.), port(0.3e6, 302., 3.)];
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], &ports, Some(0.), &mut w)
            .unwrap();
        let mut d = [0.; STATES];
        d[LEFT_FLOW] = 1.;
        let (a, r) = m.jvp(&w, &d, &[PortDirection::default(); 2], 0.).unwrap();
        assert_eq!(r.energy[0], ports[0].total_enthalpy);
        let (_, minus) = m
            .jvp(&w, &d.map(|v| -v), &[PortDirection::default(); 2], 0.)
            .unwrap();
        assert_eq!(r.energy[0], -minus.energy[0]);
        let mut plus = y;
        plus[LEFT_FLOW] = 1e-6;
        m.evaluate(&plus, &[0.; STATES], &ports, None, &mut w)
            .unwrap();
        close(w.residual().unwrap()[ENERGY] / 1e-6, a[ENERGY], 1e-8);
        let mut minus_y = y;
        minus_y[LEFT_FLOW] = -1e-6;
        m.evaluate(&minus_y, &[0.; STATES], &ports, None, &mut w)
            .unwrap();
        assert!((w.residual().unwrap()[ENERGY] / -1e-6 - a[ENERGY]).abs() > 1.);
    }
}

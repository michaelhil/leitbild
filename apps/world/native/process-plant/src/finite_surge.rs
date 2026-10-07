//! Restricted cold surge: one finite liquid/steel store and two conjugate
//! momenta of a linear end-velocity field. C=M/6[[2,1],[1,2]], w=Cv,
//! K=w.v/2. Total E includes K and the actual volume-mean potential energy.
//! Inward quiescent-owner traction subtracts rho*v^2/2 and transports the
//! owner's static H; outward transport delivers line K to the finite owner.
//! No extra exit-loss heater/drag is charged. This is not a resolved front.
use crate::operating_network::{Hydraulic, LossLaw};
use crate::{liquid_batch, CellGeometry, Liquid, LiquidQuery, GRAVITY};
use std::sync::Arc;

pub const STATES: usize = 8;
pub const MASS: usize = 0;
pub const ENERGY: usize = 1;
pub const PRESSURE: usize = 2;
pub const TEMPERATURE: usize = 3;
pub const LEFT_MOMENTUM: usize = 4;
pub const RIGHT_MOMENTUM: usize = 5;
pub const STEEL_ENERGY: usize = 6;
pub const STEEL_TEMPERATURE: usize = 7;

#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub geometry: CellGeometry,
    pub length: f64,
    pub diameter: f64,
    pub roughness: f64,
    pub entry_loss: f64,
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
pub struct Mechanics {
    pub velocities: [f64; 2],
    pub kinetic_energy: f64,
    pub kinetic_rate: f64,
    pub kinetic_advective_power: f64,
    pub kinetic_work_defect: f64,
    pub pressure_power: f64,
    pub gravity_power: f64,
    pub passive_dissipation: f64,
    /// Line entropy plus the two finite quiescent-owner entropy receipts,
    /// excluding wall heat/T_line. This is flow/mixing/drag scope, NOT total
    /// line/steel/ambient entropy. No negative result is reset to zero.
    pub coupled_entropy_rate: f64,
    /// Intrinsic flow/mixing/drag production using native EOS tangents. The
    /// signed low-Mach gravity and mechanical/EOS remainders are separate.
    pub entropy_production: f64,
    pub entropy_identity_defect: f64,
    pub entropy_identity_scale: f64,
    pub kinetic_work_scale: f64,
    /// Port PE minus stored mean PE transport minus Galerkin gravity work.
    pub gravity_mixing_power: f64,
    /// Outward availability mismatch (p_mechanical-p_EOS)*(nu_line-nu_owner)
    /// times mass flow. Real pressure work itself is NOT classified as error.
    pub mechanical_availability_power: f64,
    pub mechanical_availability_entropy_rate: f64,
    /// Sum of absolute unresolved gravity/traction-availability powers. It is
    /// not heat and is never paid into the energy balance.
    pub reduction_power_bound: f64,
    /// Local fixed-M/fixed-momentum caloric chart gains, not a trajectory bound.
    pub temperature_per_energy: f64,
    pub pressure_per_energy: f64,
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
    port_jacobian: [[f64; 6]; STATES],
    receipts: Receipts,
    receipt_jacobian: [[f64; STATES]; 6],
    receipt_ports: [[f64; 6]; 6],
    mechanics: Mechanics,
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
        matches!(
            row,
            MASS | ENERGY | LEFT_MOMENTUM | RIGHT_MOMENTUM | STEEL_ENERGY
        )
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
            mechanics: Mechanics::default(),
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
    ) -> Result<([D; STATES], [D; 6], Mechanics), String> {
        let i = self.input;
        let x: [D; STATES] = std::array::from_fn(|k| D::new(y[k], d[k]));
        let xd: [D; STATES] = std::array::from_fn(|k| D::new(yp[k], cj * d[k]));
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
        let v = [
            (D::from(4.) * x[LEFT_MOMENTUM] - D::from(2.) * x[RIGHT_MOMENTUM]) / x[MASS],
            (D::from(4.) * x[RIGHT_MOMENTUM] - D::from(2.) * x[LEFT_MOMENTUM]) / x[MASS],
        ];
        let kinetic = (x[LEFT_MOMENTUM] * v[0] + x[RIGHT_MOMENTUM] * v[1]) / D::from(2.);
        let mut q = [D::default(); 2];
        let mut h = [D::default(); 2];
        let mut traction = [D::default(); 2];
        let mut gravity = [D::default(); 2];
        let mut force = [D::default(); 2];
        for k in 0..2 {
            let inward = if k == 0 { branch[k] } else { !branch[k] };
            let rf = if inward {
                D::new(ports[k].density, dp[k].density)
            } else {
                rho
            };
            q[k] = D::from(area) * rf * v[k];
            let p = D::new(ports[k].pressure, dp[k].pressure);
            traction[k] = if inward {
                p - rf * v[k] * v[k] / D::from(2.)
            } else {
                p
            };
            if traction[k].v <= 0. {
                return Err("Nonpositive surge acceleration traction".into());
            }
            h[k] = if inward {
                D::new(ports[k].total_enthalpy, dp[k].total_enthalpy)
            } else {
                u + traction[k] / rho
                    + v[k] * v[k] / D::from(2.)
                    + D::from(GRAVITY * ports[k].elevation)
            };
            let dz = if k == 0 {
                i.geometry.elevation - ports[k].elevation
            } else {
                ports[k].elevation - i.geometry.elevation
            };
            // Owned continuous Galerkin gravity. A donor-density switch here
            // would make acceleration discontinuous at zero velocity.
            gravity[k] = -D::from(area * GRAVITY * dz / i.geometry.volume) * x[MASS];
            let mut half = self.halves[k];
            // Outward K is paid to the finite receiver, not dissipated twice.
            half.fixed_loss = i.bend_loss_each + if inward { i.entry_loss } else { 0. };
            let loss = half.pressure_loss(q[k].v, rf.v, viscosity.v);
            let drag = D::new(
                loss[0],
                loss[1] * q[k].d + loss[2] * viscosity.d + loss[3] * rf.d,
            );
            force[k] = -D::from(area) * drag;
        }
        let transport =
            (q[0] * (D::from(2.) * v[0] + v[1]) + q[1] * (v[0] + D::from(2.) * v[1])) / D::from(6.);
        let wm = [
            q[0] * v[0] - transport
                + D::from(area) * (traction[0] - x[PRESSURE])
                + gravity[0]
                + force[0],
            transport - q[1] * v[1]
                + D::from(area) * (x[PRESSURE] - traction[1])
                + gravity[1]
                + force[1],
        ];
        let mass = q[0] - q[1];
        let wall = D::from(i.wet_conductance) * (x[STEEL_TEMPERATURE] - x[TEMPERATURE]);
        let ambient = D::from(i.ambient_conductance)
            * (x[STEEL_TEMPERATURE] - D::from(i.ambient_temperature));
        let energy = q[0] * h[0] - q[1] * h[1] + wall;
        let mhat = D::from(i.geometry.volume) * rho;
        let se = D::new(
            self.steel_energy(y[STEEL_TEMPERATURE]),
            self.steel_capacity(y[STEEL_TEMPERATURE]) * d[STEEL_TEMPERATURE],
        );
        let f = [
            xd[MASS] - mass,
            xd[ENERGY] - energy,
            x[MASS] - mhat,
            x[ENERGY] - mhat * (u + D::from(GRAVITY * i.geometry.elevation)) - kinetic,
            xd[LEFT_MOMENTUM] - wm[0],
            xd[RIGHT_MOMENTUM] - wm[1],
            xd[STEEL_ENERGY] + wall + ambient,
            x[STEEL_ENERGY] - se,
        ];
        let receipts = [q[0], -q[1], q[0] * h[0], -q[1] * h[1], wall, ambient];
        let kr = v[0].v * wm[0].v + v[1].v * wm[1].v - kinetic.v / y[MASS] * mass.v;
        let chemical = l.internal_energy + y[PRESSURE] / l.density - l.temperature * l.entropy;
        let line_entropy =
            (energy.v - kr - GRAVITY * i.geometry.elevation * mass.v - chemical * mass.v)
                / l.temperature;
        let external_entropy = (0..2)
            .map(|k| {
                (-receipts[k + 2].v
                    + (ports[k].total_enthalpy - ports[k].temperature * ports[k].entropy)
                        * receipts[k].v)
                    / ports[k].temperature
            })
            .sum::<f64>();
        let kinetic_advective_power = (q[0].v * v[0].v * v[0].v - q[1].v * v[1].v * v[1].v) / 2.;
        let pressure_power = area
            * (traction[0].v * v[0].v - traction[1].v * v[1].v - y[PRESSURE] * (v[0].v - v[1].v));
        let gravity_power = v[0].v * gravity[0].v + v[1].v * gravity[1].v;
        let passive_dissipation = -(v[0].v * force[0].v + v[1].v * force[1].v);
        let gravity_terms = std::array::from_fn::<_, 2, _>(|k| {
            receipts[k].v * GRAVITY * (ports[k].elevation - i.geometry.elevation)
                - v[k].v * gravity[k].v
        });
        let gravity_mixing_power = gravity_terms.iter().sum::<f64>();
        let availability_terms = std::array::from_fn::<_, 2, _>(|k| {
            let inward = if k == 0 { branch[k] } else { !branch[k] };
            if inward {
                0.
            } else {
                q[k].v.abs()
                    * (ports[k].pressure - ports[k].eos_pressure)
                    * (1. / l.density - 1. / ports[k].density)
            }
        });
        let mechanical_availability_power = availability_terms.iter().sum::<f64>();
        let mechanical_availability_entropy_rate = (0..2)
            .map(|k| availability_terms[k] / ports[k].temperature)
            .sum::<f64>();
        let entropy_production = (0..2)
            .map(|k| {
                let inward = if k == 0 { branch[k] } else { !branch[k] };
                let pd = ports[k];
                let ud = pd.total_enthalpy - pd.pressure / pd.density - GRAVITY * pd.elevation;
                let availability = if inward {
                    (ud - l.internal_energy + y[PRESSURE] * (1. / pd.density - 1. / l.density))
                        / l.temperature
                        + l.entropy
                        - pd.entropy
                } else {
                    (l.internal_energy - ud
                        + pd.eos_pressure * (1. / l.density - 1. / pd.density)
                        + v[k].v.powi(2) / 2.)
                        / pd.temperature
                        + pd.entropy
                        - l.entropy
                };
                q[k].v.abs() * availability
            })
            .sum::<f64>()
            + passive_dissipation / l.temperature;
        let coupled_entropy_rate = line_entropy + external_entropy - wall.v / l.temperature;
        let entropy_identity_scale = (energy.v.abs()
            + kr.abs()
            + (GRAVITY * i.geometry.elevation * mass.v).abs()
            + (chemical * mass.v).abs()
            + wall.v.abs())
            / l.temperature
            + (0..2)
                .map(|k| {
                    (receipts[k + 2].v.abs()
                        + ((ports[k].total_enthalpy - ports[k].temperature * ports[k].entropy)
                            * receipts[k].v)
                            .abs())
                        / ports[k].temperature
                })
                .sum::<f64>()
            + entropy_production.abs()
            + gravity_mixing_power.abs() / l.temperature
            + mechanical_availability_entropy_rate.abs();
        let cv = l.cp - l.temperature * l.expansion.powi(2) / (l.density * l.compressibility);
        if !cv.is_finite() || cv <= 0. || !l.compressibility.is_finite() || l.compressibility <= 0.
        {
            return Err("Invalid surge fixed-mass caloric response".into());
        }
        let mechanics = Mechanics {
            velocities: v.map(|a| a.v),
            kinetic_energy: kinetic.v,
            kinetic_rate: kr,
            kinetic_advective_power,
            kinetic_work_defect: kr - kinetic_advective_power - pressure_power - gravity_power
                + passive_dissipation,
            pressure_power,
            gravity_power,
            passive_dissipation,
            coupled_entropy_rate,
            entropy_production,
            entropy_identity_defect: coupled_entropy_rate
                - entropy_production
                - gravity_mixing_power / l.temperature
                - mechanical_availability_entropy_rate,
            entropy_identity_scale,
            kinetic_work_scale: kr.abs()
                + kinetic_advective_power.abs()
                + pressure_power.abs()
                + gravity_power.abs()
                + passive_dissipation.abs(),
            gravity_mixing_power,
            mechanical_availability_power,
            mechanical_availability_entropy_rate,
            reduction_power_bound: gravity_terms
                .iter()
                .chain(&availability_terms)
                .map(|v| v.abs())
                .sum(),
            temperature_per_energy: 1. / (mhat.v * cv),
            pressure_per_energy: l.expansion / (l.compressibility * mhat.v * cv),
        };
        if f.iter()
            .chain(&receipts)
            .any(|a| !a.v.is_finite() || !a.d.is_finite())
            || !finite(&[
                mechanics.kinetic_energy,
                mechanics.kinetic_rate,
                mechanics.pressure_power,
                mechanics.gravity_power,
                mechanics.passive_dissipation,
                mechanics.coupled_entropy_rate,
                mechanics.entropy_production,
                mechanics.entropy_identity_defect,
                mechanics.entropy_identity_scale,
                mechanics.kinetic_work_scale,
                mechanics.gravity_mixing_power,
                mechanics.mechanical_availability_power,
                mechanics.mechanical_availability_entropy_rate,
                mechanics.reduction_power_bound,
                mechanics.temperature_per_energy,
                mechanics.pressure_per_energy,
            ])
            || mechanics.kinetic_energy < 0.
            || mechanics.passive_dissipation < 0.
        {
            return Err("Nonfinite/nonpassive finite surge response".into());
        }
        Ok((f, receipts, mechanics))
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
        let velocities = [
            (4. * y[LEFT_MOMENTUM] - 2. * y[RIGHT_MOMENTUM]) / y[MASS],
            (4. * y[RIGHT_MOMENTUM] - 2. * y[LEFT_MOMENTUM]) / y[MASS],
        ];
        let branch = velocities.map(|v| v >= 0.);
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
        w.mechanics = m;
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
    pub fn mechanics(&self) -> Result<Mechanics, String> {
        if self.valid {
            Ok(self.mechanics)
        } else {
            Err("Unprepared surge mechanics".into())
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
    pub fn port_jacobian(&self) -> Result<&[[f64; 6]; STATES], String> {
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
    fn momenta(m: f64, v: [f64; 2]) -> [f64; 2] {
        [m * (2. * v[0] + v[1]) / 6., m * (v[0] + 2. * v[1]) / 6.]
    }
    fn state(m: &Model, v: [f64; 2]) -> [f64; STATES] {
        let mut y = m.prepare(0.3e6, 300., 300.).unwrap();
        let w = momenta(y[MASS], v);
        y[LEFT_MOMENTUM] = w[0];
        y[RIGHT_MOMENTUM] = w[1];
        y[ENERGY] += (w[0] * v[0] + w[1] * v[1]) / 2.;
        y
    }
    fn close(a: f64, b: f64, scale: f64) {
        assert!((a - b).abs() <= scale, "{a:e} != {b:e}, delta={:e}", a - b);
    }
    #[test]
    fn finite_storage_inertia_and_independent_energy_work_are_not_a_bypass() {
        let m = model();
        let ports = [port(0.31e6, 300., 2.5), port(0.29e6, 301., 6.5)];
        for v in [[0.01, 0.02], [-0.02, -0.01], [0.01, -0.01], [0., 0.]] {
            let y = state(&m, v);
            let mut w = m.workspace();
            m.evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
                .unwrap();
            let r = w.receipts().unwrap();
            let f = w.residual().unwrap();
            let d = w.mechanics().unwrap();
            close(f[MASS] + r.mass.iter().sum::<f64>(), 0., 1e-13);
            close(
                f[ENERGY] + f[STEEL_ENERGY] + r.energy.iter().sum::<f64>() - r.ambient_heat,
                0.,
                1e-8,
            );
            close(d.kinetic_work_defect, 0., 1e-10);
            close(
                d.gravity_power + d.gravity_mixing_power,
                GRAVITY
                    * (r.mass[0] * (ports[0].elevation - m.input.geometry.elevation)
                        + r.mass[1] * (ports[1].elevation - m.input.geometry.elevation)),
                1e-11,
            );
            assert!(d.passive_dissipation >= 0.);
            assert!(m.is_differential(LEFT_MOMENTUM) && m.is_differential(RIGHT_MOMENTUM));
        }
    }
    #[test]
    fn inward_has_no_ghost_ke_and_outward_delivers_ke_once() {
        let m = model();
        let ports = [port(0.3e6, 300., 3.), port(0.3e6, 300., 3.)];
        let l = liquid(0.3e6, 300.).unwrap();
        for v in [[0.02, 0.01], [-0.01, -0.02]] {
            let y = state(&m, v);
            let mut w = m.workspace();
            m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
            let r = w.receipts().unwrap();
            let inward = if v[0] > 0. { 0 } else { 1 };
            let outward = 1 - inward;
            assert_eq!(
                r.energy[inward],
                r.mass[inward] * ports[inward].total_enthalpy
            );
            close(
                r.energy[outward] / r.mass[outward],
                l.internal_energy
                    + ports[outward].pressure / l.density
                    + v[outward].powi(2) / 2.
                    + GRAVITY * ports[outward].elevation,
                1e-10,
            );
        }
    }
    #[test]
    fn complete_local_and_density_port_partials_match_full_half_fd() {
        let m = model();
        let y = state(&m, [0.02, -0.01]);
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
    fn vertical_datum_change_preserves_momentum_and_total_energy_incidence() {
        let m = model();
        let mut y = state(&m, [0.01, -0.02]);
        let mut yp = [0.; STATES];
        yp[MASS] = 0.03;
        let ports = [port(0.31e6, 300., 2.5), port(0.29e6, 300., 6.5)];
        let mut w = m.workspace();
        m.evaluate(&y, &yp, &ports, None, &mut w).unwrap();
        let f = *w.residual().unwrap();
        let old = w.mechanics().unwrap();
        let dz = 7.;
        let mut input = m.input();
        input.geometry.elevation += dz;
        let other = Model::new(input).unwrap();
        y[ENERGY] += y[MASS] * GRAVITY * dz;
        yp[ENERGY] += yp[MASS] * GRAVITY * dz;
        let pp = ports.map(|p| Port {
            elevation: p.elevation + dz,
            total_enthalpy: p.total_enthalpy + GRAVITY * dz,
            ..p
        });
        let mut wo = other.workspace();
        other.evaluate(&y, &yp, &pp, None, &mut wo).unwrap();
        close(
            wo.residual().unwrap()[LEFT_MOMENTUM],
            f[LEFT_MOMENTUM],
            1e-10,
        );
        close(
            wo.residual().unwrap()[RIGHT_MOMENTUM],
            f[RIGHT_MOMENTUM],
            1e-10,
        );
        close(
            wo.residual().unwrap()[ENERGY],
            f[ENERGY] + GRAVITY * dz * f[MASS],
            1e-8,
        );
        close(
            wo.mechanics().unwrap().gravity_power,
            old.gravity_power,
            1e-10,
        );
    }
    #[test]
    fn quiescent_hydrostatic_and_bidirectional_cold_entropy_are_independent() {
        let mut input = model().input();
        input.geometry.elevation = 3.;
        let m = Model::new(input).unwrap();
        let l = liquid(0.3e6, 300.).unwrap();
        let mut hydro = [port(0.3e6, 300., 2.5), port(0.3e6, 300., 6.5)];
        for p in &mut hydro {
            p.pressure = 0.3e6 + l.density * GRAVITY * (3. - p.elevation);
            p.density = l.density;
            p.total_enthalpy = l.internal_energy + p.pressure / l.density + GRAVITY * p.elevation;
        }
        let y = state(&m, [0.; 2]);
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], &hydro, None, &mut w).unwrap();
        close(w.residual().unwrap()[LEFT_MOMENTUM], 0., 1e-11);
        close(w.residual().unwrap()[RIGHT_MOMENTUM], 0., 1e-11);
        for v in [[0.02, 0.02], [-0.02, -0.02], [0.01, -0.01], [-0.01, 0.01]] {
            let y = state(&m, v);
            let ports = [port(0.3e6, 300., 3.); 2];
            m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
            assert!(
                w.mechanics().unwrap().coupled_entropy_rate >= 0.,
                "{:?}",
                w.mechanics().unwrap()
            );
        }
        let ports = [port(0.31e6, 298., 2.5), port(0.29e6, 302., 6.5)];
        for v in [[0.02, 0.01], [-0.01, -0.02], [0.01, -0.01], [-0.01, 0.01]] {
            let y = state(&m, v);
            m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
            let d = w.mechanics().unwrap();
            assert!(d.entropy_production > 0., "{d:?}");
            close(
                d.entropy_identity_defect,
                0.,
                128. * f64::EPSILON * d.entropy_identity_scale,
            );
        }
    }
    #[test]
    fn failed_foreign_value_refresh_and_fixed_zero_branch_refuse_stale_actions() {
        let m = model();
        let y = state(&m, [0.; 2]);
        let ports = [port(0.3e6, 300., 3.); 2];
        let mut w = m.workspace();
        m.evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
            .unwrap();
        let mut d = [0.; STATES];
        d[LEFT_MOMENTUM] = 1.;
        let a = m.jvp(&w, &d, &[PortDirection::default(); 2], 1.).unwrap().0;
        let b = m
            .jvp(&w, &d.map(|v| -v), &[PortDirection::default(); 2], 1.)
            .unwrap()
            .0;
        for k in 0..STATES {
            assert_eq!(a[k], -b[k]);
        }
        m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
        assert!(m.jvp(&w, &d, &[PortDirection::default(); 2], 1.).is_err());
        assert!(model()
            .evaluate(&y, &[0.; STATES], &ports, Some(1.), &mut w)
            .is_err());
        assert!(w.mechanics().is_err());
        let mut bad = y;
        bad[PRESSURE] = f64::NAN;
        assert!(m
            .evaluate(&bad, &[0.; STATES], &ports, Some(1.), &mut w)
            .is_err());
        assert!(w.receipts().is_err());
    }
    #[test]
    fn unequal_density_rest_is_continuous_without_a_thermal_gibbs_drive() {
        let m = model();
        let l = liquid(0.3e6, 300.).unwrap();
        let mut ports = [port(0.3e6, 290., 2.5), port(0.3e6, 330., 6.5)];
        for p in &mut ports {
            // The same owned bulk-density hydrostatic mechanical head. The
            // neighboring EOS states deliberately differ; their thermal Gibbs
            // difference must not become an invented hydraulic force at rest.
            p.pressure = 0.3e6 + l.density * GRAVITY * (m.input.geometry.elevation - p.elevation);
            let donor = liquid(p.eos_pressure, p.temperature).unwrap();
            p.total_enthalpy =
                donor.internal_energy + p.pressure / p.density + GRAVITY * p.elevation;
        }
        assert!((ports[0].density - ports[1].density).abs() > 1.);
        let mut w = m.workspace();
        let y = state(&m, [0.; 2]);
        m.evaluate(&y, &[0.; STATES], &ports, None, &mut w).unwrap();
        let rest = *w.residual().unwrap();
        for row in [LEFT_MOMENTUM, RIGHT_MOMENTUM] {
            close(rest[row], 0., 1e-10);
        }
        for v in [
            [1e-10, 1e-10],
            [-1e-10, -1e-10],
            [1e-10, -1e-10],
            [-1e-10, 1e-10],
        ] {
            m.evaluate(&state(&m, v), &[0.; STATES], &ports, None, &mut w)
                .unwrap();
            for row in [LEFT_MOMENTUM, RIGHT_MOMENTUM] {
                close(w.residual().unwrap()[row], rest[row], 1e-6);
            }
        }
    }
    #[test]
    fn signed_reduction_is_separate_and_its_consumer_bound_can_refuse() {
        let m = model();
        let mut ports = [port(0.31e6, 290., 2.5), port(0.29e6, 330., 6.5)];
        // Mechanical and EOS pressures have distinct, deliberately nonzero
        // offsets. The remainder must involve delta-specific-volume, not the
        // whole real pressure-work term.
        for p in &mut ports {
            p.pressure += 1000.;
            p.total_enthalpy += 1000. / p.density;
        }
        let mut w = m.workspace();
        let mut ratios = Vec::new();
        for speed in [1e-8, 0.1] {
            m.evaluate(
                &state(&m, [speed, speed]),
                &[0.; STATES],
                &ports,
                None,
                &mut w,
            )
            .unwrap();
            let d = w.mechanics().unwrap();
            let r = w.receipts().unwrap();
            let l = liquid(0.3e6, 300.).unwrap();
            close(
                d.mechanical_availability_power,
                (-r.mass[1]) * 1000. * (1. / l.density - 1. / ports[1].density),
                1e-12,
            );
            assert!(d.reduction_power_bound >= d.gravity_mixing_power.abs());
            assert!(d.reduction_power_bound >= d.mechanical_availability_power.abs());
            close(
                d.entropy_identity_defect,
                0.,
                128. * f64::EPSILON * d.entropy_identity_scale,
            );
            let energy = 300. * d.reduction_power_bound;
            ratios.push(
                (energy * d.temperature_per_energy / 1e-4)
                    .max(energy * d.pressure_per_energy.abs()),
            );
        }
        assert!(ratios[0] < 1. && ratios[1] > 1., "{ratios:?}");
    }
    #[test]
    fn caloric_response_gains_match_current_chart_even_off_mass_manifold() {
        let m = model();
        let mut y = state(&m, [0.02, -0.01]);
        y[MASS] *= 1.01;
        let mut w = m.workspace();
        m.evaluate(
            &y,
            &[0.; STATES],
            &[port(0.3e6, 300., 3.); 2],
            Some(0.),
            &mut w,
        )
        .unwrap();
        let j = w.jacobian().unwrap();
        let a = j[PRESSURE][PRESSURE];
        let b = j[PRESSURE][TEMPERATURE];
        let c = j[TEMPERATURE][PRESSURE];
        let d = j[TEMPERATURE][TEMPERATURE];
        let det = a * d - b * c;
        let gains = w.mechanics().unwrap();
        close(
            gains.temperature_per_energy,
            -a / det,
            1e-14 * gains.temperature_per_energy,
        );
        close(
            gains.pressure_per_energy,
            b / det,
            1e-14 * gains.pressure_per_energy.abs(),
        );
    }
}

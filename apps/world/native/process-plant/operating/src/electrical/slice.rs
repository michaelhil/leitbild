//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/shaft-torque-and-rolling.md#rotor-and-loss-connection
//! The ELEC S3 slice as one composable block: turbine admission → net shaft
//! torque (the declared S3 reference-drop reduction), the finite shaft, the
//! selected generator, the generator breaker's separation transaction and the
//! breaker body store. Rows, the dense 9×9 Jacobian block and the energy
//! quadrature integrands are filled for any caller (the stock-IDAS test now,
//! the joined operator through a KERN hook later). Nothing here integrates.
//!
//! Coordinates: `[lambda_d, lambda_q, lambda_f, id, iq, if, omega, theta, T_body]`.
//! Held inputs (changed only at stops): the boundary (`v_line`, `f_grid`, and
//! whether the stiff boundary is joined), the admitted steam flow, the field
//! converter's delivered voltage fraction, room temperature and the auxiliary
//! source draws. `theta` is the rotor angle relative to the carrier; the
//! carrier's handling across exchange boundaries (per-boundary reference
//! conversion, or a continuous carrier input) is the owner's open item:
//! [`Slice::reference_conversion`] exists for the former and is not used here.
use super::generator::{self, Machine, Mode};
use crate::turbine::admission::ReferenceDropAdmission;
use std::f64::consts::PI;

pub const N: usize = 9;
pub const OMEGA: usize = 6;
pub const THETA: usize = 7;
pub const BODY: usize = 8;
/// Quadrature integrands, in order.
pub const QUADRATURES: [&str; 10] = [
    "export_W",
    "aero_work_W",
    "oil_heat_W",
    "stator_copper_W",
    "field_copper_W",
    "field_input_W",
    "field_converter_ac_W",
    "body_to_room_W",
    "unit_auxiliary_draw_W",
    "reserve_auxiliary_draw_W",
];

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Body {
    #[serde(rename = "capacity_J_K")]
    pub capacity_j_k: f64,
    #[serde(rename = "roomConductance_W_K")]
    pub room_conductance_w_k: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    pub generator: generator::Parameters,
    #[serde(rename = "shaftInertia_kg_m2")]
    pub inertia_kg_m2: f64,
    pub turbine: ReferenceDropAdmission,
    #[serde(rename = "breakerBody")]
    pub body: Body,
    #[serde(rename = "fieldConverterEfficiency")]
    pub converter_efficiency: f64,
}

/// Held inputs of one integration segment (S3-D19: copyable exactly, real
/// numbers as IEEE bits).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inputs {
    /// Breaker contact closed AND the stiff boundary joined.
    pub joined: bool,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub v_line: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub f_grid_hz: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub admitted_kg_s: f64,
    /// Field converter demand (V) times its delivered AC fraction; zero when
    /// the converter's motive supply is lost (field current is NOT zeroed).
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub field_v: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub room_k: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub unit_draw_w: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub reserve_draw_w: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Slice {
    pub parameters: Parameters,
    pub machine: Machine,
    pub inputs: Inputs,
}

impl Slice {
    pub fn new(parameters: Parameters, inputs: Inputs) -> Result<Self, String> {
        let machine = Machine::new(parameters.generator)?;
        parameters.turbine.validate()?;
        let b = parameters.body;
        if !(parameters.inertia_kg_m2 > 0. && b.capacity_j_k > 0. && b.room_conductance_w_k >= 0.)
            || !(parameters.converter_efficiency > 0. && parameters.converter_efficiency <= 1.)
        {
            return Err(
                "slice needs positive inertia, body capacity and 0 < converter efficiency <= 1"
                    .into(),
            );
        }
        Ok(Self {
            parameters,
            machine,
            inputs,
        })
    }
    pub fn mode(&self) -> Mode {
        if self.inputs.joined {
            Mode::Connected
        } else {
            Mode::Open
        }
    }
    pub fn differential(&self) -> [f64; N] {
        let s = if self.mode() == Mode::Connected {
            1.
        } else {
            0.
        };
        [s, s, 1., 0., 0., 0., 1., 1., 1.]
    }
    fn torque_parts(
        &self,
        y: &[f64],
    ) -> Result<(f64, f64, f64, crate::turbine::admission::TurbineTorque), String> {
        let t = self
            .parameters
            .turbine
            .torque(self.inputs.admitted_kg_s, y[OMEGA])?;
        let (em, d_iq, d_if) = self.machine.torque(y[4], y[5]);
        Ok((em, d_iq, d_if, t))
    }
    pub fn rows(&self, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), String> {
        let i = self.inputs;
        self.machine.rows(
            self.mode(),
            &y[..6],
            &yp[..6],
            y[OMEGA],
            y[THETA],
            i.v_line,
            i.field_v,
            &mut out[..6],
        );
        let (em, _, _, t) = self.torque_parts(y)?;
        out[OMEGA] = self.parameters.inertia_kg_m2 * yp[OMEGA] - (t.net_nm + em);
        out[THETA] =
            yp[THETA] - (self.parameters.generator.pole_pairs * y[OMEGA] - 2. * PI * i.f_grid_hz);
        let b = self.parameters.body;
        out[BODY] = b.capacity_j_k * yp[BODY] + b.room_conductance_w_k * (y[BODY] - i.room_k);
        Ok(())
    }
    /// Dense `dF/dy + cj*dF/dy'`, `g[row][col]`.
    pub fn block(&self, cj: f64, y: &[f64]) -> Result<[[f64; N]; N], String> {
        let i = self.inputs;
        let mut g = [[0.; N]; N];
        let m = self
            .machine
            .block(self.mode(), cj, &y[..6], y[OMEGA], y[THETA], i.v_line, 0.);
        for (row, machine_row) in g.iter_mut().zip(m.iter()) {
            row[..8].copy_from_slice(machine_row);
        }
        let (_, d_iq, d_if, t) = self.torque_parts(y)?;
        g[OMEGA][OMEGA] = self.parameters.inertia_kg_m2 * cj - t.d_omega;
        g[OMEGA][4] = -d_iq;
        g[OMEGA][5] = -d_if;
        g[THETA][THETA] = cj;
        g[THETA][OMEGA] = -self.parameters.generator.pole_pairs;
        let b = self.parameters.body;
        g[BODY][BODY] = b.capacity_j_k * cj + b.room_conductance_w_k;
        Ok(g)
    }
    /// Exact consistent `(y, y')` from the retained differential coordinates.
    pub fn consistent(&self, y: &mut [f64], yp: &mut [f64]) -> Result<(), String> {
        let i = self.inputs;
        let (omega, theta) = (y[OMEGA], y[THETA]);
        self.machine.consistent(
            self.mode(),
            &mut y[..6],
            &mut yp[..6],
            omega,
            theta,
            i.v_line,
            i.field_v,
        );
        let (em, _, _, t) = self.torque_parts(y)?;
        yp[OMEGA] = (t.net_nm + em) / self.parameters.inertia_kg_m2;
        yp[THETA] = self.parameters.generator.pole_pairs * y[OMEGA] - 2. * PI * i.f_grid_hz;
        let b = self.parameters.body;
        yp[BODY] = -b.room_conductance_w_k * (y[BODY] - i.room_k) / b.capacity_j_k;
        Ok(())
    }
    pub fn export_w(&self, y: &[f64]) -> f64 {
        self.machine
            .export_w(self.mode(), y[3], y[4], y[THETA], self.inputs.v_line)
    }
    /// The energy-receipt integrands (see [`QUADRATURES`]).
    pub fn quadratures(&self, y: &[f64]) -> Result<[f64; 10], String> {
        let i = self.inputs;
        let (_, _, _, t) = self.torque_parts(y)?;
        let (qs, qf) = self.machine.copper(&y[..6]);
        let pf = i.field_v * y[5];
        let e = self.parameters.converter_efficiency;
        let ac = if pf >= 0. { pf / e } else { e * pf };
        let b = self.parameters.body;
        Ok([
            self.export_w(y),
            t.aero_work_w,
            t.oil_heat_w,
            qs,
            qf,
            pf,
            ac,
            b.room_conductance_w_k * (y[BODY] - i.room_k),
            i.unit_draw_w,
            i.reserve_draw_w,
        ])
    }
    /// Stored energy: rotor kinetic + magnetic + breaker body (J, body from 0 K).
    pub fn stored_energy(&self, y: &[f64]) -> f64 {
        0.5 * self.parameters.inertia_kg_m2 * y[OMEGA] * y[OMEGA]
            + Machine::magnetic_energy(&y[..6])
            + self.parameters.body.capacity_j_k * y[BODY]
    }
    /// The ledger defect of stored-energy change against integrated flows:
    /// `dE = aero - oil - export + field_input - Qs - Qf - room + deposits`.
    pub fn ledger_defect(&self, e0: f64, y: &[f64], q: &[f64], deposits_j: f64) -> f64 {
        self.stored_energy(y) - e0 - (q[1] - q[2] - q[0] + q[5] - q[3] - q[4] - q[7] + deposits_j)
    }
    /// Achieved stator separation (breaker or the boundary's own opening):
    /// the passive arc limit; its heat enters the body (temperature jump).
    /// Returns the deposited heat. A class-R transaction.
    pub fn separate(&mut self, y: &mut [f64]) -> f64 {
        let heat = self.machine.arc_quench(&mut y[..6]);
        y[BODY] += heat / self.parameters.body.capacity_j_k;
        self.inputs.joined = false;
        heat
    }
    /// Mechanism heat (breaker spring release or closing drive remainder) into the body.
    pub fn deposit(&self, y: &mut [f64], heat_j: f64) {
        y[BODY] += heat_j / self.parameters.body.capacity_j_k;
    }
    /// The per-boundary relative-angle reference conversion
    /// `theta_new = theta_old + phi_predicted - phi_accepted` as a state write.
    /// Provided for the owner's option; a restart transaction when used.
    pub fn reference_conversion(y: &mut [f64], phi_predicted: f64, phi_accepted: f64) {
        y[THETA] += phi_predicted - phi_accepted;
    }
}

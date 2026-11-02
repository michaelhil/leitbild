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
//! Held inputs (changed only at stops): the boundary (`v_line`, the Grid
//! frequency, the carrier rate, and whether the stiff boundary is joined),
//! the admitted steam flow, the field converter's delivered voltage
//! fraction, room temperature and the auxiliary source draws.
//!
//! **Carrier (owner decisions D2 and R6-K SW-1, 15 Oct;
//! `ld01-generator-carrier`).** `theta` is the rotor angle relative to the
//! Grid-owned carrier, which enters as a continuous, smooth input: over each
//! exchange interval `[t0, t1)` the Grid holds its frequency `f` and its
//! frequency rate `fdot`, and the carrier phase follows
//! `phi(t) = phi(t0) + 2*pi*(f*(t - t0) + fdot*(t - t0)^2/2)`, plus the
//! Grid's accepted-minus-predicted phase of the previous interval spread
//! over this one as a rate ([`carrier_rate`]). The angle row reads the
//! carrier rate `carrier_rad_s + carrier_accel_rad_s2*(t - carrier_from_s)`.
//! Nothing writes `theta` at a boundary (the replaced per-boundary
//! reference conversion). A changed rate or rate slope enters only the
//! angle's rate row: a held input of class S under S3-D4.
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

/// Owner decision D2's selection as the electrical compiler emits it from
/// the generator page's `ld01-generator-carrier` block (packet `carrier`).
/// Each field accepts only the value this owner implements, so a packet
/// without the selection, or with another one, is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CarrierLaw {
    pub angle_reference: AngleReference,
    pub rate_input: RateInput,
    pub reconciliation: Reconciliation,
    pub boundary_conversion: BoundaryConversion,
    pub rate_change_class: RateChangeClass,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum AngleReference {
    #[serde(rename = "continuousCarrier")]
    ContinuousCarrier,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum RateInput {
    /// SW-1 (owner R6-K): frequency and frequency rate held per interval.
    #[serde(rename = "frequencyAndRatePerInterval")]
    FrequencyAndRatePerInterval,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum Reconciliation {
    #[serde(rename = "phaseErrorAsRateOverNextInterval")]
    PhaseErrorAsRateOverNextInterval,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum BoundaryConversion {
    #[serde(rename = "none")]
    None,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
pub enum RateChangeClass {
    #[serde(rename = "S3-D4")]
    S3D4,
}

/// D2: the carrier rate held over the exchange interval `[t0, t1)` of
/// length `interval_s`: `2*pi*f_grid(t0) + e(t0)/interval_s`, with `e(t0)`
/// the Grid's accepted carrier phase at `t0` less the phase the plant
/// followed over the previous interval (the integral of the Grid's
/// frequency deviation from its held value). The followed phase then meets
/// the Grid's held prediction at `t1`. `e = 0` returns exactly
/// `2*pi*f_grid`, so an exchange that agrees with the held prediction
/// leaves the input's bits, and the residual, unchanged: no event.
pub fn carrier_rate(f_grid_hz: f64, phase_error_rad: f64, interval_s: f64) -> Result<f64, String> {
    if !(f_grid_hz.is_finite() && f_grid_hz > 0.)
        || !phase_error_rad.is_finite()
        || !(interval_s.is_finite() && interval_s > 0.)
    {
        return Err(format!(
            "carrier: frequency {f_grid_hz} Hz, phase error {phase_error_rad} rad over {interval_s} s"
        ));
    }
    Ok(2. * PI * f_grid_hz + phase_error_rad / interval_s)
}

/// The carrier of a boundary that agrees with its held prediction (no
/// phase error): `2*pi*f_grid`, bit for bit [`carrier_rate`] with `e = 0`.
pub fn prepared_carrier(f_grid_hz: f64) -> f64 {
    2. * PI * f_grid_hz
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
    /// The Grid's frequency at the boundary (Hz): the auxiliary sources'
    /// state when the generator breaker closes onto the Grid.
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub f_grid_hz: f64,
    /// D2: the carrier rate the relative angle follows at `carrier_from_s`
    /// (rad/s), [`carrier_rate`] of the Grid's boundary.
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub carrier_rad_s: f64,
    /// SW-1: the carrier rate's slope over the interval, `2*pi*fdot`
    /// (rad/s²); zero on a boundary with a steady frequency.
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub carrier_accel_rad_s2: f64,
    /// SW-1: the interval start the slope is measured from (s).
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub carrier_from_s: f64,
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
    /// The carrier rate at `t` (rad/s): the held rate plus its held slope.
    pub fn carrier_at(&self, t: f64) -> f64 {
        let i = self.inputs;
        i.carrier_rad_s + i.carrier_accel_rad_s2 * (t - i.carrier_from_s)
    }
    pub fn rows(&self, time: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), String> {
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
            yp[THETA] - (self.parameters.generator.pole_pairs * y[OMEGA] - self.carrier_at(time));
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
    pub fn consistent(&self, time: f64, y: &mut [f64], yp: &mut [f64]) -> Result<(), String> {
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
        yp[THETA] = self.parameters.generator.pole_pairs * y[OMEGA] - self.carrier_at(time);
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
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_boundary_that_agrees_with_its_held_prediction_leaves_the_carrier_bits() {
        for f in [50., 49.999, 50.000_123_4] {
            for t in [1., 0.02, 0.01, 0.37] {
                let held = carrier_rate(f, 0., t).unwrap();
                assert_eq!(held.to_bits(), prepared_carrier(f).to_bits());
                assert_eq!(carrier_rate(f, -0., t).unwrap().to_bits(), held.to_bits());
            }
        }
        // a phase error is spread over the next interval as a rate
        let w = carrier_rate(50., 1e-3, 0.02).unwrap();
        assert!((w - prepared_carrier(50.) - 0.05).abs() < 1e-12);
        assert!(carrier_rate(50., 0., 0.).is_err());
        assert!(carrier_rate(0., 0., 1.).is_err());
        assert!(carrier_rate(50., f64::NAN, 1.).is_err());
    }
    #[test]
    fn only_the_owners_carrier_selection_is_accepted() {
        let d2 = serde_json::json!({"angleReference": "continuousCarrier", "rateInput": "frequencyAndRatePerInterval",
            "reconciliation": "phaseErrorAsRateOverNextInterval", "boundaryConversion": "none",
            "rateChangeClass": "S3-D4"});
        assert!(serde_json::from_value::<CarrierLaw>(d2.clone()).is_ok());
        let mut other = d2.clone();
        other["boundaryConversion"] = "thetaReferenceConversion".into();
        assert!(serde_json::from_value::<CarrierLaw>(other).is_err());
        // D2's held-frequency-only rate is superseded by SW-1 (owner R6-K).
        let mut held = d2.clone();
        held["rateInput"] = "heldPerInterval".into();
        assert!(serde_json::from_value::<CarrierLaw>(held).is_err());
        let mut extra = d2;
        extra["extra"] = 1.into();
        assert!(serde_json::from_value::<CarrierLaw>(extra).is_err());
    }
}

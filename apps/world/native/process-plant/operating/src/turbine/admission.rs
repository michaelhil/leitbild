//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/shaft-torque-and-rolling.md#selected-equivalent-impulse-reduction
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/shaft-torque-and-rolling.md#rotor-and-loss-connection
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/turbine-and-regeneration-dynamics.md#shaft-generator-and-governor
//! Turbine admission → shaft torque (ELEC S3 slice, C10 slice), equation
//! blocks only. Supplied here:
//! - the selected equivalent-impulse interval torque
//!   `tau = 2*eta*m*R*(v - R*omega)`, `v = sqrt(2*dh_s)`, with its partial
//!   derivatives (the speed derivative `-2*eta*m*R^2` is the turbine's swing
//!   damping, ELEC item (0));
//! - the shaft loss allocation `tau_loadloss = a*tau_aero` while producing
//!   work (zero during negative aerodynamic work) and viscous drag
//!   `c*omega`, with the oil heat they release;
//! - the declared S3 reduction [`ReferenceDropAdmission`]: interval flows are
//!   the immutable cycle mass fractions of the admitted steam and the
//!   reversible drops stay at their immutable cycle references. It replaces the
//!   finite turbine steam network (S5) for S3 only; the receiving enthalpy
//!   `h_in - W/m` leaves to the declared receiver, so no energy is created or
//!   lost (`W <= eta*m*dh_s` by the law's identity).
//!
//! The caller owns the rotor state, the admitted flow (the SG owner's
//! admission law in the joined spine) and the receivers. Nothing is clipped;
//! negative work and zero flow follow the law exactly.

/// One equivalent turbine interval. All fields are required.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Interval {
    /// Immutable aggregate torque arm `R = sqrt(2*dh_s,ref)/(2*omega_ref)`.
    #[serde(rename = "radius_m")]
    pub radius_m: f64,
    /// Energy-recovery factor used as the momentum coefficient (0.85 HP, 0.88 LP).
    pub efficiency: f64,
}

/// Torque of one interval at admitted flow `m` (kg/s, forward), reversible
/// drop `dh_s` (J/kg) and signed shaft speed `omega` (rad/s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntervalTorque {
    pub torque_nm: f64,
    pub d_omega: f64,
    pub d_flow: f64,
    /// Shaft work rate `tau*omega` (W), signed.
    pub work_w: f64,
}

impl Interval {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.radius_m.is_finite() && self.radius_m > 0.)
            || !(self.efficiency.is_finite() && self.efficiency > 0. && self.efficiency <= 1.)
        {
            return Err("turbine interval needs a positive arm and 0 < eta <= 1".into());
        }
        Ok(())
    }
    /// The selected law. Zero flow gives zero torque (no 0/0); a negative
    /// drop or reverse flow is not this forward law's domain and is refused.
    pub fn torque(
        &self,
        flow_kg_s: f64,
        drop_j_kg: f64,
        omega: f64,
    ) -> Result<IntervalTorque, String> {
        if !(flow_kg_s.is_finite() && drop_j_kg.is_finite() && omega.is_finite())
            || flow_kg_s < 0.
            || drop_j_kg < 0.
        {
            return Err(format!(
                "forward interval law needs flow >= 0 and drop >= 0 (m {flow_kg_s}, dh {drop_j_kg})"
            ));
        }
        let v = (2. * drop_j_kg).sqrt();
        let r = self.radius_m;
        let k = 2. * self.efficiency * r;
        let torque = k * flow_kg_s * (v - r * omega);
        Ok(IntervalTorque {
            torque_nm: torque,
            d_omega: -k * flow_kg_s * r,
            d_flow: k * (v - r * omega),
            work_w: torque * omega,
        })
    }
}

/// Shaft loss allocation of the torque owner.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShaftLosses {
    /// `a = (1 - shaftMechanicalEfficiency) - P_drag,ref/P_fluid,ref`.
    #[serde(rename = "loadLossFraction")]
    pub load_loss_fraction: f64,
    /// `c = P_drag,ref/omega_ref^2` (N m s/rad).
    #[serde(rename = "drag_Nm_per_rad_s")]
    pub drag_nm_per_rad_s: f64,
}

/// Net turbine torque on the shaft and its parts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TurbineTorque {
    /// `sum(tau_aero) - tau_loadloss - tau_drag` (N m).
    pub net_nm: f64,
    pub d_omega: f64,
    pub d_admitted_flow: f64,
    pub aero_nm: f64,
    /// `sum(tau_aero*omega)`: work withdrawn from the steam (W, signed).
    pub aero_work_w: f64,
    /// `Q_oil = tau_loadloss*omega + tau_drag*omega >= 0` (W).
    pub oil_heat_w: f64,
}

impl ShaftLosses {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.load_loss_fraction.is_finite()
            && (0. ..1.).contains(&self.load_loss_fraction)
            && self.drag_nm_per_rad_s.is_finite()
            && self.drag_nm_per_rad_s >= 0.)
        {
            return Err("shaft losses need 0 <= a < 1 and a nonnegative drag coefficient".into());
        }
        Ok(())
    }
}

/// Declared S3 reduction of the steam side (see the module comment).
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceDropAdmission {
    pub intervals: Vec<Interval>,
    /// Interval mass flow per kg/s of admitted SG steam (immutable cycle).
    #[serde(rename = "flowFractions")]
    pub flow_fractions: Vec<f64>,
    /// Immutable reference reversible drops (J/kg).
    #[serde(rename = "referenceDrops_J_kg")]
    pub reference_drops_j_kg: Vec<f64>,
    pub losses: ShaftLosses,
}

impl ReferenceDropAdmission {
    pub fn validate(&self) -> Result<(), String> {
        let n = self.intervals.len();
        if n == 0 || self.flow_fractions.len() != n || self.reference_drops_j_kg.len() != n {
            return Err("reference-drop admission needs one fraction and drop per interval".into());
        }
        for i in &self.intervals {
            i.validate()?;
        }
        if self
            .flow_fractions
            .iter()
            .chain(&self.reference_drops_j_kg)
            .any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("interval fractions and drops must be positive".into());
        }
        self.losses.validate()
    }
    /// Net shaft torque from `admitted_kg_s` of SG steam at signed `omega`.
    pub fn torque(&self, admitted_kg_s: f64, omega: f64) -> Result<TurbineTorque, String> {
        let (mut aero, mut d_omega, mut d_flow, mut work) = (0., 0., 0., 0.);
        for ((interval, fraction), drop) in self
            .intervals
            .iter()
            .zip(&self.flow_fractions)
            .zip(&self.reference_drops_j_kg)
        {
            let t = interval.torque(fraction * admitted_kg_s, *drop, omega)?;
            aero += t.torque_nm;
            d_omega += t.d_omega;
            d_flow += t.d_flow * fraction;
            work += t.work_w;
        }
        let a = self.losses.load_loss_fraction;
        // load loss only while producing work (tau_aero*omega >= 0); at standstill the
        // same finite transmitted-torque reduction with zero heat
        let producing = aero * omega >= 0.;
        let (loss, loss_d_omega, loss_d_flow) = if producing {
            (a * aero, a * d_omega, a * d_flow)
        } else {
            (0., 0., 0.)
        };
        let c = self.losses.drag_nm_per_rad_s;
        Ok(TurbineTorque {
            net_nm: aero - loss - c * omega,
            d_omega: d_omega - loss_d_omega - c,
            d_admitted_flow: d_flow - loss_d_flow,
            aero_nm: aero,
            aero_work_w: work,
            oil_heat_w: loss * omega + c * omega * omega,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const W0: f64 = 1500. * 2. * std::f64::consts::PI / 60.;
    fn slice() -> ReferenceDropAdmission {
        // The cycle's reference drops and fractions (compiled by the TS compiler in
        // production); here only to check the law's identities.
        let drops: [f64; 5] = [
            77708.013403,
            282528.111196,
            283833.481246,
            227964.923461,
            264792.308839,
        ];
        let eta = [0.85, 0.85, 0.88, 0.88, 0.88];
        ReferenceDropAdmission {
            intervals: drops
                .iter()
                .zip(eta)
                .map(|(d, e)| Interval {
                    radius_m: (2. * d).sqrt() / (2. * W0),
                    efficiency: e,
                })
                .collect(),
            flow_fractions: vec![0.922586, 0.752767, 0.596919, 0.560649, 0.537775],
            reference_drops_j_kg: drops.to_vec(),
            losses: ShaftLosses {
                load_loss_fraction: 0.005 - 0.5 / 1030.662217,
                drag_nm_per_rad_s: 500000. / (W0 * W0),
            },
        }
    }
    #[test]
    fn reference_work_bound_signs_and_derivatives() {
        let s = slice();
        s.validate().unwrap();
        let i = s.intervals[0];
        // at u = v/2 the specific work is eta*dh_s; zero flow gives zero torque
        let t = i.torque(1., s.reference_drops_j_kg[0], W0).unwrap();
        assert!((t.work_w - 0.85 * s.reference_drops_j_kg[0]).abs() < 1e-6);
        assert_eq!(i.torque(0., 1e5, W0).unwrap().torque_nm, 0.);
        // above u = v the work is negative (the rotor supplies the fluid)
        assert!(
            i.torque(1., s.reference_drops_j_kg[0], 2.5 * W0)
                .unwrap()
                .work_w
                < 0.
        );
        assert!(i.torque(-1., 1e5, W0).is_err());
        // central-difference derivatives of the net torque
        let (m, w) = (1600., 0.98 * W0);
        let t = s.torque(m, w).unwrap();
        let h = 1e-4;
        let dw =
            (s.torque(m, w + h).unwrap().net_nm - s.torque(m, w - h).unwrap().net_nm) / (2. * h);
        let dm =
            (s.torque(m + h, w).unwrap().net_nm - s.torque(m - h, w).unwrap().net_nm) / (2. * h);
        assert!((dw - t.d_omega).abs() < 1e-6 * t.d_omega.abs());
        assert!((dm - t.d_admitted_flow).abs() < 1e-6 * t.d_admitted_flow.abs());
        // oil ledger: aero work = net shaft work + oil heat
        assert!((t.aero_work_w - t.net_nm * w - t.oil_heat_w).abs() < 1e-6 * t.aero_work_w);
    }
}

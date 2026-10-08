//! Reduced axial drive/contact operator, not an integrator or source model.
//! The massless reference obeys a bounded ideal force–speed graph; finite
//! stem/body masses never inherit its velocity jumps. Explicit heat ports
//! remain unjoined until an actual receiving thermal owner is installed.

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub body_mass_kg: f64,
    pub stem_mass_kg: f64,
    pub force_limit_n: f64,
    /// This admitted regulator branch requires grip rating <= motor rating.
    pub grip_closed_force_n: f64,
    pub gap_stroke_m: f64,
    pub maximum_rate_m_s: f64,
    pub efficiency: f64,
    pub joint_capacity_n: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct State {
    /// Axial displacement from the ORIGINAL coincident bayonet faces in the
    /// seated-head frame, not the literal body-bottom elevation.
    pub body_y_m: f64,
    pub body_v_m_s: f64,
    /// Same retained face-displacement frame as body_y_m, not stem-foot z.
    /// The actual unilateral gap is body_y_m-stem_y_m.
    pub stem_y_m: f64,
    pub stem_v_m_s: f64,
    pub reference_y_m: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Input {
    /// Zero is delivered HOLD, not zero body/stem velocity.
    pub requested_rate_m_s: f64,
    pub motive_power_w: f64,
    pub holding_power_w: f64,
    pub gap_m: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Forces {
    /// Actual gravity, fluid and other supported external forces, upward positive.
    /// Joint and grip forces must NOT already be included.
    pub body_n: f64,
    pub stem_n: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GripMode {
    Stick,
    Slip,
    Open,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum JointMode {
    Contact,
    Separated,
}
/// An accepted one-sided force graph, retained during an implicit stage or
/// root search. A trial continuation is not an admissible physical state.
/// The caller stops at the first speed/contact boundary before changing it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RegulatorBranch {
    ApproachPositive,
    ApproachNegative,
    Track,
    HoldPositive,
    HoldNegative,
    HoldRest,
    Open,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrialBranch {
    pub regulator: RegulatorBranch,
    pub joint: JointMode,
}
#[derive(Clone, Copy, Debug)]
pub struct Response {
    pub reference_rate_m_s: f64,
    pub grip_force_n: f64,
    pub joint_force_n: f64,
    pub body_acceleration_m_s2: f64,
    pub stem_acceleration_m_s2: f64,
    pub grip_mode: GripMode,
    pub joint_mode: JointMode,
    pub motive_mechanical_w: f64,
    pub grip_to_stem_w: f64,
    pub joint_to_body_w: f64,
    pub slip_to_jack_w: f64,
    pub electrical_loss_to_jack_w: f64,
    pub holding_to_jack_w: f64,
}
/// Exact local action on the retained force/contact graph. Delivered input is
/// fixed during a Newton solve; an electrical or command jump is an event.
#[derive(Clone, Copy, Debug, Default)]
pub struct ResponseDirection {
    pub reference_rate_m_s: f64,
    pub grip_force_n: f64,
    pub joint_force_n: f64,
    pub body_acceleration_m_s2: f64,
    pub stem_acceleration_m_s2: f64,
    pub motive_mechanical_w: f64,
    pub grip_to_stem_w: f64,
    pub joint_to_body_w: f64,
    pub slip_to_jack_w: f64,
    pub electrical_loss_to_jack_w: f64,
}
impl Config {
    pub fn validate(self) -> Result<(), &'static str> {
        if [
            self.body_mass_kg,
            self.stem_mass_kg,
            self.force_limit_n,
            self.grip_closed_force_n,
            self.gap_stroke_m,
            self.maximum_rate_m_s,
            self.efficiency,
            self.joint_capacity_n,
        ]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.)
            || self.efficiency > 1.
            || self.grip_closed_force_n > self.force_limit_n
        {
            return Err("Invalid absorber drive/contact configuration");
        }
        Ok(())
    }
    fn accelerations(
        self,
        s: State,
        f: Forces,
        grip: f64,
        branch: Option<JointMode>,
    ) -> Result<(f64, f64, f64, JointMode), &'static str> {
        let gap = s.body_y_m - s.stem_y_m;
        if branch == Some(JointMode::Contact)
            || (branch.is_none() && gap == 0. && s.body_v_m_s == s.stem_v_m_s)
        {
            let acceleration =
                (f.body_n + f.stem_n + grip) / (self.body_mass_kg + self.stem_mass_kg);
            let joint = self.body_mass_kg * acceleration - f.body_n;
            if joint > self.joint_capacity_n {
                return Err("Absorber uplift joint strength exceeded");
            }
            if joint >= 0. || branch == Some(JointMode::Contact) {
                return Ok((acceleration, acceleration, joint, JointMode::Contact));
            }
        }
        Ok((
            f.body_n / self.body_mass_kg,
            (f.stem_n + grip) / self.stem_mass_kg,
            0.,
            JointMode::Separated,
        ))
    }
    /// Force needed to track a constant reference rate on the actual active
    /// unilateral branch. At zero contact load either branch has the same force.
    fn tracking_force(self, s: State, f: Forces) -> f64 {
        if s.body_y_m == s.stem_y_m && s.body_v_m_s == s.stem_v_m_s && f.body_n <= 0. {
            -(f.body_n + f.stem_n)
        } else {
            -f.stem_n
        }
    }
    pub fn evaluate(
        self,
        s: State,
        input: Input,
        forces: Forces,
    ) -> Result<Response, &'static str> {
        self.evaluate_inner(s, input, forces, None)
    }
    /// Extend ONLY the retained branch for same-stage Newton/root probes.
    /// In particular, a negative joint reaction or signed contact gap can
    /// locate the boundary; neither may be admitted by the physical caller.
    pub fn evaluate_trial(
        self,
        s: State,
        input: Input,
        forces: Forces,
        branch: TrialBranch,
    ) -> Result<Response, &'static str> {
        let hold = matches!(
            branch.regulator,
            RegulatorBranch::HoldPositive
                | RegulatorBranch::HoldNegative
                | RegulatorBranch::HoldRest
        );
        if (hold && input.requested_rate_m_s != 0.)
            || (matches!(
                branch.regulator,
                RegulatorBranch::ApproachPositive
                    | RegulatorBranch::ApproachNegative
                    | RegulatorBranch::Track
            ) && input.requested_rate_m_s == 0.)
            || (branch.regulator == RegulatorBranch::Open && input.gap_m != self.gap_stroke_m)
        {
            return Err("Retained absorber branch does not match delivered request");
        }
        self.evaluate_inner(s, input, forces, Some(branch))
    }
    pub fn branch(
        self,
        s: State,
        input: Input,
        forces: Forces,
    ) -> Result<TrialBranch, &'static str> {
        let r = self.evaluate(s, input, forces)?;
        let regulator = if r.grip_mode == GripMode::Open {
            RegulatorBranch::Open
        } else if input.requested_rate_m_s == 0. {
            if s.stem_v_m_s > 0. {
                RegulatorBranch::HoldPositive
            } else if s.stem_v_m_s < 0. {
                RegulatorBranch::HoldNegative
            } else {
                RegulatorBranch::HoldRest
            }
        } else if s.stem_v_m_s < input.requested_rate_m_s {
            RegulatorBranch::ApproachPositive
        } else if s.stem_v_m_s > input.requested_rate_m_s {
            RegulatorBranch::ApproachNegative
        } else {
            RegulatorBranch::Track
        };
        Ok(TrialBranch {
            regulator,
            joint: r.joint_mode,
        })
    }
    fn evaluate_inner(
        self,
        s: State,
        input: Input,
        forces: Forces,
        branch: Option<TrialBranch>,
    ) -> Result<Response, &'static str> {
        self.validate()?;
        if [
            s.body_y_m,
            s.body_v_m_s,
            s.stem_y_m,
            s.stem_v_m_s,
            s.reference_y_m,
            input.requested_rate_m_s,
            input.motive_power_w,
            input.holding_power_w,
            input.gap_m,
            forces.body_n,
            forces.stem_n,
        ]
        .iter()
        .any(|v| !v.is_finite())
            || (branch.is_none() && s.body_y_m < s.stem_y_m)
            || input.motive_power_w < 0.
            || input.holding_power_w < 0.
            || !(0. ..=self.gap_stroke_m).contains(&input.gap_m)
            || input.requested_rate_m_s.abs() > self.maximum_rate_m_s
        {
            return Err("Invalid absorber stage or penetrating uplift joint");
        }
        if branch.is_none() && s.body_y_m == s.stem_y_m && s.body_v_m_s < s.stem_v_m_s {
            return Err("Closing uplift joint requires an accepted contact impulse");
        }
        let cap = self.grip_closed_force_n * (1. - input.gap_m / self.gap_stroke_m);
        let request = input.requested_rate_m_s;
        if request == 0. && input.motive_power_w != 0. {
            return Err("Delivered HOLD must withdraw motive duty");
        }
        let v = s.stem_v_m_s;
        let power = self.efficiency * input.motive_power_w;
        let required = if branch.map(|b| b.joint) == Some(JointMode::Contact) {
            -(forces.body_n + forces.stem_n)
        } else if branch.map(|b| b.joint) == Some(JointMode::Separated) {
            -forces.stem_n
        } else {
            self.tracking_force(s, forces)
        };
        let (u, grip, mode) = if cap == 0. {
            if request != 0. {
                return Err("Ordinary motion requested through an open grip");
            }
            (0., 0., GripMode::Open)
        } else if request == 0. {
            // A retained HOLD anchors only the massless reference. Its finite
            // friction cannot pin a moving finite stem or supply an impulse.
            let regulator = branch.map(|b| b.regulator);
            if regulator == Some(RegulatorBranch::HoldRest) || (regulator.is_none() && v == 0.) {
                (0., required.clamp(-cap, cap), GripMode::Stick)
            } else {
                let sign = match regulator {
                    Some(RegulatorBranch::HoldPositive) => 1.,
                    Some(RegulatorBranch::HoldNegative) => -1.,
                    _ => v.signum(),
                };
                (0., -cap * sign, GripMode::Slip)
            }
        } else {
            if input.motive_power_w == 0. {
                return Err("Ordinary motion lacks delivered motive power");
            }
            let positive = if v > 0. {
                self.force_limit_n.min(power / v)
            } else {
                self.force_limit_n
            };
            let negative = if v < 0. {
                self.force_limit_n.min(power / (-v))
            } else {
                self.force_limit_n
            };
            let regulator = branch.map(|b| b.regulator);
            let effort = if regulator == Some(RegulatorBranch::ApproachPositive)
                || (regulator.is_none() && v < request)
            {
                positive
            } else if regulator == Some(RegulatorBranch::ApproachNegative)
                || (regulator.is_none() && v > request)
            {
                -negative
            } else {
                required.clamp(-negative, positive)
            };
            let slip_reference = if effort > 0. {
                request.min(power / cap)
            } else {
                request.max(-power / cap)
            };
            // At equality both sticking and a constant-effort slipping motor
            // may be feasible. Select the closest feasible reference rate,
            // not an arbitrary first branch encountered by the solver.
            let plateau_slip = effort.abs() == cap && (slip_reference - v) * effort > 0.;
            if effort.abs() < cap || (effort.abs() == cap && !plateau_slip) {
                (v, effort, GripMode::Stick)
            } else {
                let grip = cap * effort.signum();
                // Invert the motor force–speed graph at the friction limit.
                // Closest-feasible-rate resolves its constant-force plateau.
                let u = if grip > 0. {
                    request.min(power / grip)
                } else {
                    request.max(-power / (-grip))
                };
                if branch.is_none() && (u - v) * grip <= 0. {
                    return Err("Unresolved force-speed/friction branch");
                }
                (u, grip, GripMode::Slip)
            }
        };
        let (ab, as_, joint, joint_mode) =
            self.accelerations(s, forces, grip, branch.map(|b| b.joint))?;
        let motive = grip * u;
        let slip = grip * (u - v);
        let loss = input.motive_power_w - motive;
        let grip_work = grip * v;
        let joint_work = joint * s.body_v_m_s;
        if ![ab, as_, joint, motive, slip, loss, grip_work, joint_work]
            .iter()
            .all(|x| x.is_finite())
            || (branch.is_none() && slip < 0.)
            || loss < 0.
        {
            return Err("Unpaid or nonpassive absorber stage");
        }
        Ok(Response {
            reference_rate_m_s: u,
            grip_force_n: grip,
            joint_force_n: joint,
            body_acceleration_m_s2: ab,
            stem_acceleration_m_s2: as_,
            grip_mode: mode,
            joint_mode,
            motive_mechanical_w: motive,
            grip_to_stem_w: grip_work,
            joint_to_body_w: joint_work,
            slip_to_jack_w: slip,
            electrical_loss_to_jack_w: loss,
            holding_to_jack_w: input.holding_power_w,
        })
    }
    pub fn evaluate_trial_direction(
        self,
        s: State,
        input: Input,
        forces: Forces,
        branch: TrialBranch,
        ds: State,
        df: Forces,
    ) -> Result<ResponseDirection, &'static str> {
        let r = self.evaluate_trial(s, input, forces, branch)?;
        if [ds.body_y_m, ds.body_v_m_s, ds.stem_y_m, ds.stem_v_m_s,
            ds.reference_y_m, df.body_n, df.stem_n].iter().any(|v| !v.is_finite()) {
            return Err("Invalid absorber force/contact direction");
        }
        let cap = self.grip_closed_force_n * (1. - input.gap_m / self.gap_stroke_m);
        let required = if branch.joint == JointMode::Contact {
            -(forces.body_n + forces.stem_n)
        } else { -forces.stem_n };
        let drequired = if branch.joint == JointMode::Contact {
            -(df.body_n + df.stem_n)
        } else { -df.stem_n };
        let (du, dg) = if r.grip_mode == GripMode::Open {
            (0., 0.)
        } else if input.requested_rate_m_s == 0. {
            let dg = if branch.regulator == RegulatorBranch::HoldRest
                && required > -cap && required < cap { drequired } else { 0. };
            (0., dg)
        } else if r.grip_mode == GripMode::Slip {
            // Fixed gap and delivered motive budget fix the friction plateau
            // and its inverted reference speed on this selected branch.
            (0., 0.)
        } else {
            let v = s.stem_v_m_s;
            let dv = ds.stem_v_m_s;
            let power = self.efficiency * input.motive_power_w;
            let positive = if v > 0. { self.force_limit_n.min(power / v) }
                else { self.force_limit_n };
            let negative = if v < 0. { self.force_limit_n.min(-power / v) }
                else { self.force_limit_n };
            let dp = if v > 0. && power / v < self.force_limit_n {
                -power * dv / (v * v)
            } else { 0. };
            let dn = if v < 0. && -power / v < self.force_limit_n {
                power * dv / (v * v)
            } else { 0. };
            let dg = match branch.regulator {
                RegulatorBranch::ApproachPositive => dp,
                RegulatorBranch::ApproachNegative => -dn,
                _ if required <= -negative => -dn,
                _ if required >= positive => dp,
                _ => drequired,
            };
            (dv, dg)
        };
        let (dab, das, dj) = if branch.joint == JointMode::Contact {
            let a = (df.body_n + df.stem_n + dg)
                / (self.body_mass_kg + self.stem_mass_kg);
            (a, a, self.body_mass_kg * a - df.body_n)
        } else {
            (df.body_n / self.body_mass_kg,
                (df.stem_n + dg) / self.stem_mass_kg, 0.)
        };
        let motive = dg * r.reference_rate_m_s + r.grip_force_n * du;
        let grip = dg * s.stem_v_m_s + r.grip_force_n * ds.stem_v_m_s;
        let out = ResponseDirection {
            reference_rate_m_s: du,
            grip_force_n: dg,
            joint_force_n: dj,
            body_acceleration_m_s2: dab,
            stem_acceleration_m_s2: das,
            motive_mechanical_w: motive,
            grip_to_stem_w: grip,
            joint_to_body_w: dj * s.body_v_m_s + r.joint_force_n * ds.body_v_m_s,
            slip_to_jack_w: motive - grip,
            electrical_loss_to_jack_w: -motive,
        };
        if [out.reference_rate_m_s, out.grip_force_n, out.joint_force_n,
            out.body_acceleration_m_s2, out.stem_acceleration_m_s2,
            out.motive_mechanical_w, out.grip_to_stem_w, out.joint_to_body_w,
            out.slip_to_jack_w, out.electrical_loss_to_jack_w]
            .iter().any(|v| !v.is_finite()) {
            return Err("Unrepresentable absorber force/contact direction");
        }
        Ok(out)
    }
    pub fn mechanical_energy_j(self, s: State, gravity: f64) -> Result<f64, &'static str> {
        self.validate()?;
        if !gravity.is_finite()
            || gravity < 0.
            || [s.body_y_m, s.body_v_m_s, s.stem_y_m, s.stem_v_m_s]
                .iter()
                .any(|v| !v.is_finite())
        {
            return Err("Invalid absorber mechanical energy stage");
        }
        let energy = self.body_mass_kg * (0.5 * s.body_v_m_s * s.body_v_m_s + gravity * s.body_y_m)
            + self.stem_mass_kg * (0.5 * s.stem_v_m_s * s.stem_v_m_s + gravity * s.stem_y_m);
        if !energy.is_finite() {
            return Err("Unrepresentable absorber mechanical energy");
        }
        Ok(energy)
    }
    /// Perfectly inelastic finite-mass contact at the actual bayonet plane.
    /// No finite grip impulse acts during impact. Never snap a finite gap shut.
    pub fn recontact(self, s: State) -> Result<Impact, &'static str> {
        self.validate()?;
        if ![
            s.body_y_m,
            s.stem_y_m,
            s.body_v_m_s,
            s.stem_v_m_s,
            s.reference_y_m,
        ]
        .iter()
        .all(|v| v.is_finite())
            || s.body_y_m != s.stem_y_m
            || s.body_v_m_s >= s.stem_v_m_s
        {
            return Err("No closing absorber joint contact");
        }
        let mass = self.body_mass_kg + self.stem_mass_kg;
        let velocity = (self.body_mass_kg * s.body_v_m_s + self.stem_mass_kg * s.stem_v_m_s) / mass;
        let reduced = self.body_mass_kg * self.stem_mass_kg / mass;
        let relative = s.body_v_m_s - s.stem_v_m_s;
        let heat = 0.5 * reduced * relative * relative;
        let impulse = self.body_mass_kg * (velocity - s.body_v_m_s);
        if ![velocity, heat, impulse].iter().all(|v| v.is_finite()) {
            return Err("Unrepresentable absorber contact impulse/heat");
        }
        Ok(Impact {
            state: State {
                body_v_m_s: velocity,
                stem_v_m_s: velocity,
                ..s
            },
            impulse_to_body_n_s: impulse,
            stem_heat_j: 0.5 * heat,
            spider_heat_j: 0.5 * heat,
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Impact {
    pub state: State,
    pub impulse_to_body_n_s: f64,
    pub stem_heat_j: f64,
    pub spider_heat_j: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            body_mass_kg: 35.,
            stem_mass_kg: 5.5,
            force_limit_n: 2000.,
            grip_closed_force_n: 2000.,
            gap_stroke_m: 0.01,
            maximum_rate_m_s: 0.008,
            efficiency: 0.8,
            joint_capacity_n: 2000.,
        }
    }
    fn state(v: f64) -> State {
        State {
            body_y_m: 0.001,
            stem_y_m: 0.001,
            body_v_m_s: v,
            stem_v_m_s: v,
            reference_y_m: 0.,
        }
    }
    fn input(rate: f64) -> Input {
        Input {
            requested_rate_m_s: rate,
            motive_power_w: 1000. / 52.,
            holding_power_w: 20. / 52.,
            gap_m: 0.,
        }
    }
    fn forces() -> Forces {
        Forces {
            body_n: -350.,
            stem_n: -55.,
        }
    }
    fn near(a: f64, b: f64) {
        assert!(
            (a - b).abs() < 1e-11 * (1. + a.abs() + b.abs()),
            "{a} != {b}"
        );
    }
    #[test]
    fn finite_startup_power_catch_and_tracking() {
        let c = config();
        let r = c.evaluate(state(0.), input(0.008), forces()).unwrap();
        assert_eq!(r.grip_mode, GripMode::Slip);
        near(r.reference_rate_m_s, 0.8 * (1000. / 52.) / 2000.);
        assert!(r.body_acceleration_m_s2 > 0.);
        let catch = 0.8 * (1000. / 52.) / 2000.;
        let r = c.evaluate(state(catch), input(0.008), forces()).unwrap();
        near(r.grip_force_n, 2000.);
        assert!(r.body_acceleration_m_s2 > 0.);
        let r = c.evaluate(state(0.0079), input(0.008), forces()).unwrap();
        near(r.grip_force_n * 0.0079, 0.8 * 1000. / 52.);
        let r = c.evaluate(state(0.008), input(0.008), forces()).unwrap();
        near(r.body_acceleration_m_s2, 0.);
        near(r.joint_force_n, 350.);
        near(r.grip_force_n, 405.);
    }
    #[test]
    fn lower_grip_capacity_has_real_slip_and_reference_work() {
        let mut c = config();
        c.grip_closed_force_n = 1000.;
        let s = state(0.);
        let i = input(0.008);
        let r = c.evaluate(s, i, forces()).unwrap();
        assert_eq!(r.grip_mode, GripMode::Slip);
        near(r.reference_rate_m_s, 0.008);
        assert!(r.body_acceleration_m_s2 > 0.);
        near(r.slip_to_jack_w, 8.);
        near(
            i.motive_power_w,
            r.electrical_loss_to_jack_w + r.slip_to_jack_w + r.grip_to_stem_w,
        );
    }
    #[test]
    fn hold_does_not_pin_body_or_create_downward_joint_force() {
        let mut i = input(0.);
        i.motive_power_w = 0.;
        let r = config().evaluate(state(0.008), i, forces()).unwrap();
        near(r.reference_rate_m_s, 0.);
        assert_eq!(r.grip_mode, GripMode::Slip);
        assert_eq!(r.joint_mode, JointMode::Separated);
        near(r.joint_force_n, 0.);
        assert!(r.stem_acceleration_m_s2 < r.body_acceleration_m_s2);
        assert!(r.slip_to_jack_w > 0.);
        near(r.electrical_loss_to_jack_w, 0.);
    }
    #[test]
    fn signed_power_graph_backdrive_reversal_and_joint_strength() {
        let c = config();
        for (v, w) in [(0.004, -0.008), (-0.004, 0.008), (-0.008, -0.008)] {
            let r = c.evaluate(state(v), input(w), forces()).unwrap();
            assert!(r.slip_to_jack_w >= 0.);
            assert!(r.electrical_loss_to_jack_w >= 0.);
            assert!(r.motive_mechanical_w <= 0.8 * 1000. / 52. + 1e-12);
        }
        assert!(
            c.evaluate(
                state(0.),
                input(0.008),
                Forces {
                    body_n: -5000.,
                    stem_n: 0.
                }
            )
            .is_err()
        );
        let mut i = input(0.008);
        i.motive_power_w = 0.;
        assert!(c.evaluate(state(0.), i, forces()).is_err());
    }
    #[test]
    fn plastic_joint_preserves_momentum_and_sends_loss_to_real_ports() {
        let c = config();
        let mut s = state(0.);
        s.body_v_m_s = -0.004;
        let r = c.recontact(s).unwrap();
        assert!(r.state.stem_v_m_s < 0.); // grip supplied no pinning impulse.
        near(
            c.body_mass_kg * s.body_v_m_s + c.stem_mass_kg * s.stem_v_m_s,
            (c.body_mass_kg + c.stem_mass_kg) * r.state.body_v_m_s,
        );
        near(
            c.mechanical_energy_j(s, 9.80665).unwrap()
                - c.mechanical_energy_j(r.state, 9.80665).unwrap(),
            r.stem_heat_j + r.spider_heat_j,
        );
        assert_eq!(r.state.reference_y_m, s.reference_y_m);
        assert_eq!(r.state.body_y_m, s.body_y_m);
        let mut bad = s;
        bad.body_y_m += 1e-6;
        assert!(c.recontact(bad).is_err());
    }
    #[test]
    fn full_52_states_are_independent_and_copied_without_realignment() {
        let c = config();
        let mut states = [state(0.); 52];
        states[13].body_y_m += 0.0002;
        states[13].body_v_m_s = 0.0001;
        states[13].reference_y_m = 0.03;
        let copy = states;
        for (s, t) in states.into_iter().zip(copy) {
            assert_eq!(s, t);
        }
        let a = c.evaluate(states[0], input(0.008), forces()).unwrap();
        let b = c.evaluate(states[13], input(0.008), forces()).unwrap();
        assert_eq!(a.joint_mode, JointMode::Contact);
        assert_eq!(b.joint_mode, JointMode::Separated);
    }
    #[test]
    fn overspeed_braking_does_not_overshoot_reference_or_pin_finite_mass() {
        let c = config();
        for (v, w) in [
            (0.02, 0.008),
            (-0.02, -0.008),
            (0.02, -0.008),
            (-0.02, 0.008),
        ] {
            let r = c.evaluate(state(v), input(w), forces()).unwrap();
            assert_eq!(r.grip_mode, GripMode::Slip);
            assert!(r.reference_rate_m_s.abs() <= w.abs());
            assert!(r.reference_rate_m_s * w >= 0.);
            assert!((r.reference_rate_m_s - v) * r.grip_force_n > 0.);
            near(
                input(w).motive_power_w,
                r.electrical_loss_to_jack_w + r.slip_to_jack_w + r.grip_to_stem_w,
            );
        }
        let mut bad = c;
        bad.grip_closed_force_n = 2001.;
        assert!(bad.validate().is_err());
        assert!(c.evaluate(state(0.), input(0.), forces()).is_err());
    }
    #[test]
    fn nonrepresentable_energy_or_impact_refuses() {
        let c = config();
        let mut s = state(f64::MAX);
        assert!(c.mechanical_energy_j(s, 9.80665).is_err());
        let mut i = input(0.);
        i.motive_power_w = 0.;
        i.gap_m = c.gap_stroke_m;
        assert!(
            c.evaluate(
                s,
                i,
                Forces {
                    body_n: -700.,
                    stem_n: -5.
                }
            )
            .is_err()
        );
        s.body_v_m_s = -f64::MAX;
        assert!(c.recontact(s).is_err());
    }
    #[test]
    fn retained_force_graph_tangent_matches_shrinking_independent_trials_and_work() {
        let c=config();
        let cases=[
            (0.,0.008,JointMode::Contact,RegulatorBranch::ApproachPositive),
            (0.0079,0.008,JointMode::Contact,RegulatorBranch::ApproachPositive),
            (0.008,0.008,JointMode::Contact,RegulatorBranch::Track),
            (-0.0079,-0.008,JointMode::Separated,RegulatorBranch::ApproachNegative),
            (0.004,0.,JointMode::Separated,RegulatorBranch::HoldPositive),
            (-0.004,0.,JointMode::Separated,RegulatorBranch::HoldNegative),
            (0.,0.,JointMode::Contact,RegulatorBranch::HoldRest),
        ];
        for (v,request,joint,regulator) in cases {
            let mut s=state(v);if joint==JointMode::Separated {s.body_y_m+=0.01;}
            let mut i=input(request);if request==0. {i.motive_power_w=0.;}
            let f=forces();let b=TrialBranch{joint,regulator};
            let ds=State{body_y_m:0.02,body_v_m_s:0.0003,stem_y_m:-0.01,
                stem_v_m_s:-0.0002,reference_y_m:0.04};
            let df=Forces{body_n:0.7,stem_n:-0.4};
            let d=c.evaluate_trial_direction(s,i,f,b,ds,df).unwrap();
            for h in [1e-3,1e-4] {
                let a=[-1.,1.].map(|sign|c.evaluate_trial(State{
                    body_y_m:s.body_y_m+sign*h*ds.body_y_m,
                    body_v_m_s:s.body_v_m_s+sign*h*ds.body_v_m_s,
                    stem_y_m:s.stem_y_m+sign*h*ds.stem_y_m,
                    stem_v_m_s:s.stem_v_m_s+sign*h*ds.stem_v_m_s,
                    reference_y_m:s.reference_y_m+sign*h*ds.reference_y_m},i,
                    Forces{body_n:f.body_n+sign*h*df.body_n,stem_n:f.stem_n+sign*h*df.stem_n},b).unwrap());
                let fields=|r:Response|[r.reference_rate_m_s,r.grip_force_n,r.joint_force_n,
                    r.body_acceleration_m_s2,r.stem_acceleration_m_s2,r.motive_mechanical_w,
                    r.grip_to_stem_w,r.joint_to_body_w,r.slip_to_jack_w,r.electrical_loss_to_jack_w];
                let exact=[d.reference_rate_m_s,d.grip_force_n,d.joint_force_n,
                    d.body_acceleration_m_s2,d.stem_acceleration_m_s2,d.motive_mechanical_w,
                    d.grip_to_stem_w,d.joint_to_body_w,d.slip_to_jack_w,d.electrical_loss_to_jack_w];
                for ((lo,hi),direction) in fields(a[0]).into_iter().zip(fields(a[1])).zip(exact) {
                    let fd=(hi-lo)/(2.*h);
                    assert!((fd-direction).abs()<2e-7*(1.+direction.abs()),
                        "{b:?} h={h}: {fd} != {direction}");
                }
            }
            near(d.motive_mechanical_w,d.grip_to_stem_w+d.slip_to_jack_w);
            near(0.,d.motive_mechanical_w+d.electrical_loss_to_jack_w);
        }
    }
}

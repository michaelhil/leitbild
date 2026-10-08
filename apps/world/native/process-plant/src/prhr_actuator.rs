//! Selected quasistatic PRHR spring/hold actuator and finite ROOM.A recipient.
//! Support booleans mean externally supplied rated duty, not a battery model.
//! Opening is physical retained travel, not an OPEN indication or cooling credit.
pub const STATES: usize = 2;
pub const OPENING: usize = 0;
pub const ROOM_ENERGY: usize = 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub stroke_s: f64,
    pub spring_energy_j: f64,
    pub closing_power_w: f64,
    pub hold_power_w: f64,
    pub room_capacity_j_k: f64,
    pub room_wall_w_k: f64,
    pub room_reference_temperature_k: f64,
    pub initial_opening: f64,
    pub initial_room_temperature_k: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Command {
    Open,
    Close,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Support {
    pub hold_supported: bool,
    pub closing_supported: bool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Inputs {
    pub support: Support,
    pub blocked: bool,
    pub ambient_temperature_k: f64,
}
/// Accepted circuit intent, separate from achieved position and supply truth.
/// Process actual support changes before continuous advancement. Copies retain it.
#[derive(Clone, Debug)]
pub struct Control {
    holding: bool,
    closing: bool,
}
impl Control {
    pub fn new(initial_hold: bool) -> Self {
        Self {
            holding: initial_hold,
            closing: false,
        }
    }
    /// Returns whether a supplied command was accepted. None is a support update.
    /// Lost support invalidates old CLOSE; restoration never replays it.
    pub fn update(&mut self, command: Option<Command>, support: Support) -> bool {
        if !support.hold_supported {
            self.holding = false;
            self.closing = false;
        }
        if !support.closing_supported {
            self.closing = false;
        }
        match command {
            Some(Command::Open) if support.hold_supported => {
                self.holding = false;
                self.closing = false;
                true
            }
            Some(Command::Close) if support.hold_supported && support.closing_supported => {
                self.holding = true;
                self.closing = true;
                true
            }
            Some(_) => false,
            None => true,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Model {
    pub config: Config,
}
/// Exact continuation of the selected quasistatic mechanism between actual
/// command/support/obstruction events. Uses caller-supplied simulation time;
/// this is retained actuator history, not an independent simulation clock.
#[derive(Clone, Debug)]
pub struct Motion {
    model: Model,
    anchor_s: f64,
    anchor_opening: f64,
    initial_spring_energy_j: f64,
    control: Control,
    inputs: Inputs,
}
/// Complete mechanical history for durable run copies; config is supplied by
/// the same retained plant definition, never re-prepared from actual position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionSnapshot {
    pub config: Config,
    pub anchor_s: f64,
    pub anchor_opening: f64,
    pub initial_spring_energy_j: f64,
    pub holding: bool,
    pub closing: bool,
    pub inputs: Inputs,
}
impl Motion {
    pub fn snapshot(&self) -> MotionSnapshot {
        MotionSnapshot {
            config: self.model.config,
            anchor_s: self.anchor_s,
            anchor_opening: self.anchor_opening,
            initial_spring_energy_j: self.initial_spring_energy_j,
            holding: self.control.holding,
            closing: self.control.closing,
            inputs: self.inputs,
        }
    }
    pub fn restore(s: MotionSnapshot) -> Result<Self, String> {
        let model = Model::new(s.config)?;
        if !s.initial_spring_energy_j.is_finite()
            || s.initial_spring_energy_j < 0.
            || s.initial_spring_energy_j > s.config.spring_energy_j
            || (s.closing && !s.holding)
            || (!s.inputs.support.hold_supported && (s.holding || s.closing))
            || (!s.inputs.support.closing_supported && s.closing)
        {
            return Err("Invalid retained PRHR mechanical history".into());
        }
        let control = Control {
            holding: s.holding,
            closing: s.closing,
        };
        let mut out = Self::new(model, s.anchor_s, s.anchor_opening, control, s.inputs)?;
        out.initial_spring_energy_j = s.initial_spring_energy_j;
        Ok(out)
    }
    /// Connected requests before supply is decided. An obstructed energized
    /// CLOSE still draws its owned rated motive duty; a reached contact does not.
    pub fn requested_power_w(&self, time_s: f64) -> Result<f64, String> {
        let (opening, _) = self.at(time_s, 0.)?;
        Ok(if self.control.holding {
            self.model.config.hold_power_w
        } else {
            0.
        } + if self.control.closing && opening > 0. {
            self.model.config.closing_power_w
        } else {
            0.
        })
    }
    pub fn new(
        model: Model,
        epoch_s: f64,
        opening: f64,
        mut control: Control,
        inputs: Inputs,
    ) -> Result<Self, String> {
        if !epoch_s.is_finite() || epoch_s < 0. {
            return Err("Invalid PRHR motion epoch".into());
        }
        // Initial support is already actual truth. An unpowered hold must not
        // survive invisibly and replay when supply is restored later.
        control.update(None, inputs.support);
        model.evaluate(&[opening, 0.], &control, inputs)?;
        let initial_spring_energy_j = model.config.spring_energy_j * (1. - opening);
        Ok(Self {
            model,
            anchor_s: epoch_s,
            anchor_opening: opening,
            initial_spring_energy_j,
            control,
            inputs,
        })
    }
    pub fn next_contact_s(&self) -> Result<Option<f64>, String> {
        let dt =
            self.model
                .endpoint_after_s(&[self.anchor_opening, 0.], &self.control, self.inputs)?;
        match dt {
            Some(dt) => {
                let t = self.anchor_s + dt;
                if !t.is_finite() {
                    return Err("PRHR contact time overflow".into());
                }
                Ok(Some(t))
            }
            None => Ok(None),
        }
    }
    pub fn at(&self, time_s: f64, room_energy_j: f64) -> Result<(f64, Response), String> {
        if !time_s.is_finite() || time_s < self.anchor_s {
            return Err("PRHR motion before retained anchor".into());
        }
        let initial = self.model.evaluate(
            &[self.anchor_opening, room_energy_j],
            &self.control,
            self.inputs,
        )?;
        let target = if initial.opening_rate_s > 0. { 1. } else { 0. };
        let opening = if let Some(contact) = self.next_contact_s()? {
            if time_s >= contact || crate::dc_supply::coincident(time_s, contact) {
                target
            } else {
                self.anchor_opening + (time_s - self.anchor_s) * initial.opening_rate_s
            }
        } else {
            self.anchor_opening
        };
        Ok((
            opening,
            self.model
                .evaluate(&[opening, room_energy_j], &self.control, self.inputs)?,
        ))
    }
    /// Left-hand constitutive limit at a pending physical end-stop. The solver
    /// closes this smooth interval, then the driver accepts contact and starts
    /// a new interval with the right-hand zero travel/heat rate. No finite
    /// stock is projected, and no step straddles the mechanical discontinuity.
    pub fn at_left(&self, time_s: f64, room_energy_j: f64) -> Result<(f64, Response), String> {
        let (opening, mut response) = self.at(time_s, room_energy_j)?;
        if let Some(contact) = self.next_contact_s()? {
            if time_s > contact && !crate::dc_supply::coincident(time_s, contact) {
                return Err("PRHR pending contact was crossed".into());
            }
            if crate::dc_supply::coincident(time_s, contact) {
                let left = self.model.evaluate(
                    &[self.anchor_opening, room_energy_j],
                    &self.control,
                    self.inputs,
                )?;
                response.opening_rate_s = left.opening_rate_s;
                response.spring_energy_rate_w = left.spring_energy_rate_w;
                response.room_heat_w = left.room_heat_w;
                response.electrical_receipt_w = left.electrical_receipt_w;
                response.room_energy_rate_w = left.room_energy_rate_w;
            }
        }
        Ok((opening, response))
    }
    pub fn transition(
        &mut self,
        time_s: f64,
        command: Option<Command>,
        inputs: Inputs,
    ) -> Result<bool, String> {
        let (opening, _) = self.at(time_s, 0.)?;
        let mut control = self.control.clone();
        let accepted = control.update(command, inputs.support);
        // Reached closing contact ends motive intent; the separately retained
        // holding circuit remains energized. Restoration cannot replay motion.
        if opening == 0. {
            control.closing = false;
        }
        self.model.evaluate(&[opening, 0.], &control, inputs)?;
        self.anchor_s = time_s;
        self.anchor_opening = opening;
        self.control = control;
        self.inputs = inputs;
        Ok(accepted)
    }
    pub fn ambient_temperature_k(&self) -> f64 {
        self.inputs.ambient_temperature_k
    }
    pub fn initial_spring_energy_j(&self) -> f64 {
        self.initial_spring_energy_j
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Response {
    pub opening_rate_s: f64,
    pub spring_energy_j: f64,
    pub spring_energy_rate_w: f64,
    pub room_temperature_k: f64,
    pub room_heat_w: f64,
    pub electrical_receipt_w: f64,
    pub ambient_export_w: f64,
    pub room_energy_rate_w: f64,
}
impl Model {
    pub fn new(config: Config) -> Result<Self, String> {
        let c = config;
        if ![
            c.stroke_s,
            c.spring_energy_j,
            c.closing_power_w,
            c.hold_power_w,
            c.room_capacity_j_k,
            c.room_wall_w_k,
            c.room_reference_temperature_k,
            c.initial_opening,
            c.initial_room_temperature_k,
        ]
        .iter()
        .all(|x| x.is_finite())
            || c.stroke_s <= 0.
            || c.spring_energy_j <= 0.
            || c.closing_power_w <= 0.
            || c.hold_power_w < 0.
            || c.room_capacity_j_k <= 0.
            || c.room_wall_w_k < 0.
            || c.room_reference_temperature_k <= 0.
            || c.initial_room_temperature_k <= 0.
            || !(0.0..=1.0).contains(&c.initial_opening)
            || c.closing_power_w < c.spring_energy_j / c.stroke_s
        {
            return Err("Invalid PRHR actuator/room selection".into());
        }
        Ok(Self { config })
    }
    pub fn prepare(&self) -> [f64; STATES] {
        [
            self.config.initial_opening,
            self.config.room_capacity_j_k
                * (self.config.initial_room_temperature_k
                    - self.config.room_reference_temperature_k),
        ]
    }
    pub fn evaluate(
        &self,
        y: &[f64; STATES],
        control: &Control,
        input: Inputs,
    ) -> Result<Response, String> {
        let c = self.config;
        if y.iter().any(|x| !x.is_finite())
            || !(0.0..=1.0).contains(&y[OPENING])
            || !input.ambient_temperature_k.is_finite()
            || input.ambient_temperature_k <= 0.
        {
            return Err("Invalid PRHR actuator trial".into());
        }
        let room_t = c.room_reference_temperature_k + y[ROOM_ENERGY] / c.room_capacity_j_k;
        if !room_t.is_finite() || room_t <= 0. {
            return Err("Invalid finite ROOM.A state".into());
        }
        let holding = control.holding && input.support.hold_supported;
        let closing =
            holding && control.closing && input.support.closing_supported && y[OPENING] > 0.;
        let rate = if input.blocked {
            0.
        } else if closing {
            -1. / c.stroke_s
        } else if !holding && y[OPENING] < 1. {
            1. / c.stroke_s
        } else {
            0.
        };
        let spring_rate = -c.spring_energy_j * rate;
        // Closing duty persists if obstructed; endpoint removes motion duty.
        let electrical = if closing { c.closing_power_w } else { 0. }
            + if holding { c.hold_power_w } else { 0. };
        let room_heat = electrical - spring_rate;
        let ambient = c.room_wall_w_k * (room_t - input.ambient_temperature_k);
        let result = Response {
            opening_rate_s: rate,
            spring_energy_j: c.spring_energy_j * (1. - y[OPENING]),
            spring_energy_rate_w: spring_rate,
            room_temperature_k: room_t,
            room_heat_w: room_heat,
            electrical_receipt_w: electrical,
            ambient_export_w: ambient,
            room_energy_rate_w: room_heat - ambient,
        };
        if [
            rate,
            spring_rate,
            electrical,
            room_heat,
            ambient,
            result.room_energy_rate_w,
        ]
        .iter()
        .any(|x| !x.is_finite())
        {
            return Err("Nonfinite PRHR actuator energy".into());
        }
        Ok(result)
    }
    pub fn residual(
        &self,
        y: &[f64; STATES],
        yp: &[f64; STATES],
        control: &Control,
        input: Inputs,
    ) -> Result<([f64; STATES], Response), String> {
        if yp.iter().any(|x| !x.is_finite()) {
            return Err("Invalid PRHR actuator derivative".into());
        }
        let r = self.evaluate(y, control, input)?;
        Ok((
            [
                yp[OPENING] - r.opening_rate_s,
                yp[ROOM_ENERGY] - r.room_energy_rate_w,
            ],
            r,
        ))
    }
    /// Within one achieved motion/contact mode, rates are constant except room loss.
    /// Endpoint/obstruction/support changes are physical event boundaries, not smoothed.
    pub fn jacobian(&self, cj: f64) -> Result<[[f64; STATES]; STATES], String> {
        if !cj.is_finite() || cj < 0. {
            return Err("Invalid PRHR stage coefficient".into());
        }
        Ok([
            [cj, 0.],
            [
                0.,
                cj + self.config.room_wall_w_k / self.config.room_capacity_j_k,
            ],
        ])
    }
    pub fn endpoint_after_s(
        &self,
        y: &[f64; STATES],
        control: &Control,
        input: Inputs,
    ) -> Result<Option<f64>, String> {
        let r = self.evaluate(y, control, input)?;
        Ok(if r.opening_rate_s > 0. {
            Some((1. - y[OPENING]) / r.opening_rate_s)
        } else if r.opening_rate_s < 0. {
            Some(-y[OPENING] / r.opening_rate_s)
        } else {
            None
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> Model {
        Model::new(Config {
            stroke_s: 5.,
            spring_energy_j: 2500.,
            closing_power_w: 1000.,
            hold_power_w: 20.,
            room_capacity_j_k: 200e6,
            room_wall_w_k: 20000.,
            room_reference_temperature_k: 298.15,
            initial_opening: 0.,
            initial_room_temperature_k: 298.15,
        })
        .unwrap()
    }
    fn input() -> Inputs {
        Inputs {
            support: Support {
                hold_supported: true,
                closing_supported: true,
            },
            blocked: false,
            ambient_temperature_k: 298.15,
        }
    }
    #[test]
    fn actual_opening_debits_stored_spring_once_into_finite_room() {
        let m = model();
        let mut control = Control::new(true);
        let i = input();
        let mut y = m.prepare();
        assert!(control.update(Some(Command::Open), i.support));
        let r = m.evaluate(&y, &control, i).unwrap();
        assert_eq!(r.opening_rate_s, 0.2);
        assert_eq!(r.spring_energy_rate_w, -500.);
        assert_eq!(r.room_heat_w, 500.);
        assert_eq!(r.electrical_receipt_w, 0.);
        assert_eq!(m.endpoint_after_s(&y, &control, i).unwrap(), Some(5.));
        y[0] = 1.;
        y[1] = 2500.;
        let r = m.evaluate(&y, &control, i).unwrap();
        assert_eq!(r.opening_rate_s, 0.);
        assert_eq!(r.spring_energy_j, 0.);
        assert!((r.room_temperature_k - 298.1500125).abs() < 1e-12);
        assert_eq!(
            r.spring_energy_rate_w + r.room_energy_rate_w + r.ambient_export_w
                - r.electrical_receipt_w,
            0.
        );
    }
    #[test]
    fn rated_close_stores_half_work_and_obstruction_stores_nothing() {
        let m = model();
        let mut c = Control::new(false);
        let i = input();
        let y = [0.5, 0.];
        assert!(c.update(Some(Command::Close), i.support));
        let r = m.evaluate(&y, &c, i).unwrap();
        assert_eq!(r.opening_rate_s, -0.2);
        assert_eq!(r.spring_energy_rate_w, 500.);
        assert_eq!(r.electrical_receipt_w, 1020.);
        assert_eq!(r.room_heat_w, 520.);
        let r = m.evaluate(&y, &c, Inputs { blocked: true, ..i }).unwrap();
        assert_eq!(r.opening_rate_s, 0.);
        assert_eq!(r.room_heat_w, 1020.);
        assert_eq!(r.spring_energy_rate_w, 0.);
        let r = m.evaluate(&[0., 0.], &c, i).unwrap();
        assert_eq!(r.electrical_receipt_w, 20.);
    }
    #[test]
    fn support_restoration_never_replays_close_or_replenishes_spring() {
        let m = model();
        let mut c = Control::new(false);
        let i = input();
        let y = [0.6, 0.];
        c.update(Some(Command::Close), i.support);
        let lost = Support {
            hold_supported: false,
            closing_supported: false,
        };
        c.update(None, lost);
        let r = m.evaluate(&y, &c, Inputs { support: lost, ..i }).unwrap();
        assert_eq!(r.opening_rate_s, 0.2);
        c.update(None, i.support);
        let r = m.evaluate(&y, &c, i).unwrap();
        assert_eq!(r.opening_rate_s, 0.2);
        assert_eq!(r.spring_energy_j, 1000.);
        assert_eq!(r.electrical_receipt_w, 0.);
        assert!(!c.update(Some(Command::Close), lost));
        assert!(c.update(Some(Command::Close), i.support));
        assert_eq!(m.evaluate(&y, &c, i).unwrap().opening_rate_s, -0.2);
    }
    #[test]
    fn obstruction_retains_position_spring_and_copy_state() {
        let m = model();
        let mut c = Control::new(true);
        let i = input();
        c.update(Some(Command::Open), i.support);
        let y = [0.3, 10.];
        let copy = c.clone();
        let blocked = Inputs { blocked: true, ..i };
        let r = m.evaluate(&y, &copy, blocked).unwrap();
        assert_eq!(r.opening_rate_s, 0.);
        assert_eq!(r.spring_energy_j, 1750.);
        assert_eq!(r.room_heat_w, 0.);
        assert_eq!(
            m.endpoint_after_s(&y, &copy, i).unwrap(),
            Some(3.4999999999999996)
        );
        assert_eq!(m.evaluate(&y, &copy, i).unwrap().opening_rate_s, 0.2);
    }
    #[test]
    fn exact_five_second_room_balance_matches_physical_spring_work() {
        let m = model();
        let c = m.config;
        let rate = c.room_wall_w_k / c.room_capacity_j_k;
        let room_energy = 500. / rate * (-(-5. * rate).exp_m1());
        let ambient_export = 2500. - room_energy;
        assert!(room_energy > 2499. && room_energy < 2500.);
        assert!((room_energy + ambient_export - 2500.).abs() < 1e-10);
        let mut control = Control::new(true);
        control.update(Some(Command::Open), input().support);
        let r = m.evaluate(&[0.5, room_energy], &control, input()).unwrap();
        assert_eq!(
            r.spring_energy_rate_w + r.room_energy_rate_w + r.ambient_export_w,
            0.
        );
    }
    #[test]
    fn invalid_overtravel_and_support_bounds_are_not_clipped() {
        let m = model();
        let c = Control::new(true);
        assert!(m.evaluate(&[1.001, 0.], &c, input()).is_err());
        assert!(m.evaluate(&[-0.001, 0.], &c, input()).is_err());
        assert!(m.evaluate(&[0., f64::NAN], &c, input()).is_err());
        assert!(m.jacobian(f64::NAN).is_err());
    }
    #[test]
    fn exact_motion_stops_and_copied_midstroke_preserves_finite_stock() {
        let m = model();
        let i = input();
        let mut motion = Motion::new(m, 0., 0., Control::new(true), i).unwrap();
        assert!(motion.transition(0., Some(Command::Open), i).unwrap());
        assert_eq!(motion.next_contact_s().unwrap(), Some(5.));
        assert_eq!(motion.at(2., 0.).unwrap().0, 0.4);
        let mut copy = motion.clone();
        copy.transition(2., None, i).unwrap();
        for t in [2., 3.5, 5., 300.] {
            let a = motion.at(t, 0.).unwrap();
            let b = copy.at(t, 0.).unwrap();
            assert!((a.0 - b.0).abs() < 1e-14);
            assert!((a.1.spring_energy_j - b.1.spring_energy_j).abs() < 1e-10);
        }
        assert_eq!(motion.at(5., 0.).unwrap().1.opening_rate_s, 0.);
        assert_eq!(motion.at_left(5., 0.).unwrap().1.opening_rate_s, 0.2);
        assert!(motion.at_left(5.001, 0.).is_err());
        assert_eq!(motion.at(300., 0.).unwrap().0, 1.);
        let mut interrupted = motion.clone();
        interrupted
            .transition(2., None, Inputs { blocked: true, ..i })
            .unwrap();
        assert_eq!(interrupted.at(300., 0.).unwrap().0, 0.4);
        interrupted.transition(300., None, i).unwrap();
        assert_eq!(interrupted.next_contact_s().unwrap(), Some(303.));
    }
    #[test]
    fn initial_power_loss_cannot_replay_hold_on_restoration() {
        let i = input();
        let dead = Inputs {
            support: Support {
                hold_supported: false,
                closing_supported: false,
            },
            ..i
        };
        let mut motion = Motion::new(model(), 0., 0., Control::new(true), dead).unwrap();
        assert_eq!(motion.at(2., 0.).unwrap().0, 0.4);
        motion.transition(2., None, i).unwrap();
        assert!((motion.at(3., 0.).unwrap().0 - 0.6).abs() < 1e-14);
        assert_eq!(motion.at(3., 0.).unwrap().1.electrical_receipt_w, 0.);
        assert_eq!(motion.next_contact_s().unwrap(), Some(5.));
    }
}

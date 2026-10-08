//! Coupled offline axial fleet continuation. The caller supplies actual same-
//! stage water forces AND water-stock rates; they advance with the same
//! midpoint as mechanics and finite heat. No force-frozen motion split, pose
//! prescription, hidden heat sink, or live Pack registration.
use crate::{absorber_motion as motion, dc_supply};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Heat {
    pub jack_j: f64,
    pub stem_j: f64,
    pub spider_j: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub time_s: f64,
    pub motion: Vec<motion::State>,
    /// Finite adiabatic apparatus heat, relative to its original material E.
    pub heat: Vec<Heat>,
    /// Caller-owned water energies and carriers, never recreated at an event.
    pub external: Vec<f64>,
    /// Real other ACT loads outside this mechanical apparatus, not rod heat.
    pub other_load_export_j: [f64; 2],
}
pub struct PortRates {
    /// True only for a prospective accepted state or explicit command. The
    /// physical owner can run costly independent domain checks here without
    /// mistaking an off-branch Newton/root probe for an admitted state.
    pub admission: bool,
    /// Gravity plus actual fluid forces, with no grip or bayonet force added.
    pub forces: Vec<motion::Forces>,
    pub external: Vec<f64>,
}
impl PortRates {
    pub fn new(n: usize, external: usize) -> Self {
        Self {
            admission: false,
            forces: vec![
                motion::Forces {
                    body_n: 0.,
                    stem_n: 0.
                };
                n
            ],
            external: vec![0.; external],
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Duty {
    /// Existing complete ACT.A/B demand, including hold/controller portions.
    pub base_a_w: f64,
    pub base_b_w: f64,
    pub holding_w: f64,
    /// Additional total motive demand, NOT a per-cluster rating.
    pub motive_w: f64,
}
#[derive(Clone, Debug)]
pub struct Accuracy {
    pub position_m: f64,
    pub velocity_m_s: f64,
    pub heat_j: f64,
    pub external_absolute: Vec<f64>,
    pub relative: f64,
    pub maximum_step_s: f64,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Account {
    pub accepted_steps: usize,
    pub rejected_steps: usize,
    pub stage_calls: usize,
    pub root_steps: usize,
    pub minimum_accepted_step_s: f64,
    pub last_accepted_step_s: f64,
    pub velocity_events: usize,
    pub separation_events: usize,
    pub contact_events: usize,
    pub contact_heat_j: f64,
    pub maximum_event_position_adjustment_m: f64,
    pub maximum_event_velocity_adjustment_m_s: f64,
    /// Signed numerical root-coordinate KE/PE change; never hidden in heat.
    pub event_mechanical_adjustment_j: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Reached,
    /// The unsupported release path is NOT continued as a fake powered HOLD.
    SupportLost,
}
#[derive(Clone)]
pub struct Fleet {
    config: Vec<motion::Config>,
    act_a: dc_supply::Supply,
    act_b: dc_supply::Supply,
    duty: Duty,
    rate: f64,
    branches: Vec<motion::TrialBranch>,
    initialized: bool,
    pub account: Account,
}
#[derive(Clone, Copy, Debug)]
enum Event {
    Velocity(usize),
    Contact(usize),
    Separation(usize),
    Fitting(usize),
}
/// Trial iteration failure may ask for a smaller complete coupled step. It
/// does not waive an invalid physical port, configuration or accepted state.
enum MidpointError {
    Retry(&'static str),
    Fatal(String),
}
fn add_motion(s: motion::State, r: motion::State, h: f64) -> motion::State {
    motion::State {
        body_y_m: s.body_y_m + h * r.body_y_m,
        body_v_m_s: s.body_v_m_s + h * r.body_v_m_s,
        stem_y_m: s.stem_y_m + h * r.stem_y_m,
        stem_v_m_s: s.stem_v_m_s + h * r.stem_v_m_s,
        reference_y_m: s.reference_y_m + h * r.reference_y_m,
    }
}
fn midway(a: &State, b: &State) -> State {
    let mut out = a.clone();
    out.time_s = a.time_s + 0.5 * (b.time_s - a.time_s);
    for ((x, y), z) in a.motion.iter().zip(&b.motion).zip(&mut out.motion) {
        *z = motion::State {
            body_y_m: x.body_y_m + 0.5 * (y.body_y_m - x.body_y_m),
            body_v_m_s: x.body_v_m_s + 0.5 * (y.body_v_m_s - x.body_v_m_s),
            stem_y_m: x.stem_y_m + 0.5 * (y.stem_y_m - x.stem_y_m),
            stem_v_m_s: x.stem_v_m_s + 0.5 * (y.stem_v_m_s - x.stem_v_m_s),
            reference_y_m: x.reference_y_m + 0.5 * (y.reference_y_m - x.reference_y_m),
        };
    }
    for ((x, y), z) in a.external.iter().zip(&b.external).zip(&mut out.external) {
        *z = x + 0.5 * (y - x);
    }
    out
}
impl Fleet {
    pub fn new(
        config: Vec<motion::Config>,
        act_a: dc_supply::Supply,
        act_b: dc_supply::Supply,
        duty: Duty,
    ) -> Result<Self, String> {
        if config.is_empty()
            || [duty.base_a_w, duty.base_b_w, duty.holding_w, duty.motive_w]
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
            || duty.holding_w > duty.base_a_w
            || act_a.requested_w() != duty.base_a_w
            || act_b.requested_w() != duty.base_b_w
        {
            return Err("Invalid fleet duty or unmatched retained ACT loads".into());
        }
        for c in &config {
            c.validate()?;
        }
        let branches = vec![
            motion::TrialBranch {
                regulator: motion::RegulatorBranch::HoldRest,
                joint: motion::JointMode::Contact
            };
            config.len()
        ];
        Ok(Self {
            config,
            act_a,
            act_b,
            duty,
            rate: 0.,
            branches,
            initialized: false,
            account: Account::default(),
        })
    }
    pub fn supply_states(&self, time_s: f64) -> Result<[dc_supply::State; 2], String> {
        Ok([self.act_a.at(time_s)?, self.act_b.at(time_s)?])
    }
    pub fn requested_rate_m_s(&self) -> f64 {
        self.rate
    }
    pub fn retained_branches(&self) -> &[motion::TrialBranch] {
        &self.branches
    }
    fn record_step(&mut self, h: f64) {
        self.account.accepted_steps += 1;
        self.account.last_accepted_step_s = h;
        if self.account.minimum_accepted_step_s == 0. || h < self.account.minimum_accepted_step_s {
            self.account.minimum_accepted_step_s = h;
        }
    }
    fn input(&self) -> motion::Input {
        let n = self.config.len() as f64;
        motion::Input {
            requested_rate_m_s: self.rate,
            motive_power_w: if self.rate == 0. {
                0.
            } else {
                self.duty.motive_w / n
            },
            holding_power_w: self.duty.holding_w / n,
            gap_m: 0.,
        }
    }
    fn validate_physical_state(&self, s: &State) -> Result<(), String> {
        if !s.time_s.is_finite()
            || s.time_s < 0.
            || s.motion.len() != self.config.len()
            || s.heat.len() != self.config.len()
            || s.external
                .iter()
                .chain(&s.other_load_export_j)
                .any(|v| !v.is_finite())
        {
            return Err("Invalid fleet physical state or dimensions".into());
        }
        for (m, h) in s.motion.iter().zip(&s.heat) {
            if [
                m.body_y_m,
                m.body_v_m_s,
                m.stem_y_m,
                m.stem_v_m_s,
                m.reference_y_m,
                h.jack_j,
                h.stem_j,
                h.spider_j,
            ]
            .iter()
            .any(|v| !v.is_finite())
                || m.body_y_m < m.stem_y_m
                || m.body_y_m < 0.
                || h.jack_j < 0.
                || h.stem_j < 0.
                || h.spider_j < 0.
            {
                return Err("Invalid admitted fleet geometry, velocity or finite heat".into());
            }
        }
        Ok(())
    }
    fn validate_state(&self, s: &State, a: &Accuracy) -> Result<(), String> {
        self.validate_physical_state(s)?;
        if a.external_absolute.len() != s.external.len()
            || [
                a.position_m,
                a.velocity_m_s,
                a.heat_j,
                a.relative,
                a.maximum_step_s,
            ]
            .iter()
            .chain(&a.external_absolute)
            .any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("Invalid fleet physical accuracy scales".into());
        }
        Ok(())
    }
    fn supported(&self) -> bool {
        self.act_a.can_deliver(self.duty.base_a_w)
            && self.act_b.can_deliver(
                self.duty.base_b_w
                    + if self.rate == 0. {
                        0.
                    } else {
                        self.duty.motive_w
                    },
            )
    }
    fn invalidate_support(&mut self, time: f64) -> Result<Outcome, String> {
        self.rate = 0.;
        self.initialized = false;
        self.act_b
            .transition(time, self.act_b.paths(), self.duty.base_b_w, &[])?;
        Ok(Outcome::SupportLost)
    }
    /// A fresh explicit rate/HOLD boundary. Invalid or lost support never
    /// replays a previous command. Supply snapshots retain every joule.
    pub fn command<F>(&mut self, s: &State, rate: f64, port: &mut F) -> Result<Outcome, String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        self.validate_physical_state(s)?;
        let mut candidate = self.clone();
        let result = candidate.apply_command(s, rate, port)?;
        *self = candidate;
        Ok(result)
    }
    fn apply_command<F>(&mut self, s: &State, rate: f64, port: &mut F) -> Result<Outcome, String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        if !rate.is_finite() || self.config.iter().any(|c| rate.abs() > c.maximum_rate_m_s) {
            return Err("Fleet request exceeds selected ordinary speed".into());
        }
        self.act_a
            .transition(s.time_s, self.act_a.paths(), self.duty.base_a_w, &[])?;
        self.act_b.transition(
            s.time_s,
            self.act_b.paths(),
            self.duty.base_b_w + if rate == 0. { 0. } else { self.duty.motive_w },
            &[],
        )?;
        self.rate = rate;
        if !self.supported() {
            return self.invalidate_support(s.time_s);
        }
        let mut p = PortRates::new(self.config.len(), s.external.len());
        p.admission = true;
        port(s.time_s, &s.motion, &s.external, &mut p)?;
        self.check_port(&p, s.external.len())?;
        let input = self.input();
        for (i, (m, f)) in s.motion.iter().zip(&p.forces).enumerate() {
            let next = self.config[i].branch(*m, input, *f)?;
            if self.branches[i].joint == motion::JointMode::Contact
                && next.joint == motion::JointMode::Separated
            {
                self.account.separation_events += 1;
            }
            self.branches[i] = next;
        }
        self.initialized = true;
        Ok(Outcome::Reached)
    }
    fn check_port(&self, p: &PortRates, n: usize) -> Result<(), String> {
        if p.forces.len() != self.config.len()
            || p.external.len() != n
            || p.external.iter().any(|v| !v.is_finite())
            || p.forces
                .iter()
                .any(|f| !f.body_n.is_finite() || !f.stem_n.is_finite())
        {
            Err("Invalid same-stage fleet water port".into())
        } else {
            Ok(())
        }
    }
    fn admit<F>(&self, s: &State, port: &mut F) -> Result<(), String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        let mut p = PortRates::new(self.config.len(), s.external.len());
        p.admission = true;
        port(s.time_s, &s.motion, &s.external, &mut p)?;
        self.check_port(&p, s.external.len())?;
        let input = self.input();
        for ((c, m), f) in self.config.iter().zip(&s.motion).zip(&p.forces) {
            c.evaluate(*m, input, *f)?;
        }
        Ok(())
    }
    fn stage<F>(
        &mut self,
        s: &State,
        p: &mut PortRates,
        port: &mut F,
    ) -> Result<Vec<motion::Response>, String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        p.external.fill(f64::NAN);
        p.forces.fill(motion::Forces {
            body_n: f64::NAN,
            stem_n: f64::NAN,
        });
        self.account.stage_calls += 1;
        port(s.time_s, &s.motion, &s.external, p)?;
        self.check_port(p, s.external.len())?;
        let input = self.input();
        self.config
            .iter()
            .zip(&s.motion)
            .zip(&p.forces)
            .zip(&self.branches)
            .map(|(((c, m), f), b)| c.evaluate_trial(*m, input, *f, *b).map_err(str::to_string))
            .collect()
    }
    fn candidate(
        &self,
        start: &State,
        h: f64,
        mid: &State,
        r: &[motion::Response],
        p: &PortRates,
    ) -> State {
        let mut s = start.clone();
        s.time_s = start.time_s + h;
        for i in 0..s.motion.len() {
            let m = mid.motion[i];
            let q = r[i];
            s.motion[i] = add_motion(
                start.motion[i],
                motion::State {
                    body_y_m: m.body_v_m_s,
                    body_v_m_s: q.body_acceleration_m_s2,
                    stem_y_m: m.stem_v_m_s,
                    stem_v_m_s: q.stem_acceleration_m_s2,
                    reference_y_m: q.reference_rate_m_s,
                },
                h,
            );
            s.heat[i].jack_j +=
                h * (q.slip_to_jack_w + q.electrical_loss_to_jack_w + q.holding_to_jack_w);
        }
        for (x, r) in s.external.iter_mut().zip(&p.external) {
            *x += h * r;
        }
        s.other_load_export_j[0] += h * (self.duty.base_a_w - self.duty.holding_w);
        s.other_load_export_j[1] += h * self.duty.base_b_w;
        s
    }
    fn distance(a: &State, b: &State, scales: &Accuracy) -> f64 {
        let mut ratio: f64 = 0.;
        let mut check = |x: f64, y: f64, atol: f64| {
            ratio = ratio.max((x - y).abs() / (atol + scales.relative * x.abs().max(y.abs())));
        };
        for (x, y) in a.motion.iter().zip(&b.motion) {
            for (u, v) in [
                (x.body_y_m, y.body_y_m),
                (x.stem_y_m, y.stem_y_m),
                (x.reference_y_m, y.reference_y_m),
            ] {
                check(u, v, scales.position_m);
            }
            for (u, v) in [(x.body_v_m_s, y.body_v_m_s), (x.stem_v_m_s, y.stem_v_m_s)] {
                check(u, v, scales.velocity_m_s);
            }
        }
        for (x, y) in a.heat.iter().zip(&b.heat) {
            for (u, v) in [
                (x.jack_j, y.jack_j),
                (x.stem_j, y.stem_j),
                (x.spider_j, y.spider_j),
            ] {
                check(u, v, scales.heat_j);
            }
        }
        for ((x, y), t) in a
            .external
            .iter()
            .zip(&b.external)
            .zip(&scales.external_absolute)
        {
            check(*x, *y, *t);
        }
        ratio
    }
    fn midpoint<F>(
        &mut self,
        start: &State,
        h: f64,
        a: &Accuracy,
        port: &mut F,
    ) -> Result<State, MidpointError>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        let mut p = PortRates::new(self.config.len(), start.external.len());
        let r = self
            .stage(start, &mut p, port)
            .map_err(MidpointError::Fatal)?;
        let mut next = self.candidate(start, h, start, &r, &p);
        for _ in 0..32 {
            let mid = midway(start, &next);
            // A large explicit predictor can drive a later fixed-point
            // iterate behind the original fitting even though the true
            // implicit lift is positive. Reject this unadmitted iterate;
            // never clip a water geometry or turn it into an accepted pose.
            // No water-specific enclosure or stroke length belongs here.
            if mid
                .motion
                .iter()
                .any(|m| m.body_y_m < 0. || m.stem_y_m < 0.)
            {
                return Err(MidpointError::Retry(
                    "Midpoint trial crossed the original seated fitting",
                ));
            }
            let r = self
                .stage(&mid, &mut p, port)
                .map_err(MidpointError::Fatal)?;
            let changed = self.candidate(start, h, &mid, &r, &p);
            // Solve well inside the declared step-comparison scales. This is
            // a nonlinear iteration criterion, not a temporal error claim.
            if Self::distance(&changed, &next, a) < 0.01 {
                return Ok(changed);
            }
            next = changed;
        }
        Err(MidpointError::Retry("Midpoint iteration did not converge"))
    }
    fn crossings<F>(
        &mut self,
        start: &State,
        end: &State,
        port: &mut F,
    ) -> Result<Vec<Event>, String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        let mut p = PortRates::new(self.config.len(), start.external.len());
        let response = self.stage(end, &mut p, port)?;
        let mut events = Vec::new();
        for i in 0..end.motion.len() {
            let m = end.motion[i];
            let before = start.motion[i];
            let b = self.branches[i];
            let velocity = match b.regulator {
                motion::RegulatorBranch::ApproachPositive => m.stem_v_m_s >= self.rate,
                motion::RegulatorBranch::ApproachNegative => m.stem_v_m_s <= self.rate,
                motion::RegulatorBranch::HoldPositive => m.stem_v_m_s <= 0.,
                motion::RegulatorBranch::HoldNegative => m.stem_v_m_s >= 0.,
                _ => false,
            };
            if velocity {
                events.push(Event::Velocity(i));
            }
            if b.joint == motion::JointMode::Separated
                && m.body_y_m <= m.stem_y_m
                && (before.body_y_m > before.stem_y_m || before.body_v_m_s < before.stem_v_m_s)
            {
                events.push(Event::Contact(i));
            }
            if b.joint == motion::JointMode::Contact && response[i].joint_force_n < 0. {
                events.push(Event::Separation(i));
            }
            if m.body_y_m < 0. {
                events.push(Event::Fitting(i));
            }
        }
        Ok(events)
    }
    fn settle<F>(
        &mut self,
        s: &mut State,
        events: &[Event],
        a: &Accuracy,
        port: &mut F,
    ) -> Result<(), String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        for e in events {
            match *e {
                Event::Velocity(i) => {
                    let v = if self.rate == 0. { 0. } else { self.rate };
                    let c = self.config[i];
                    let before = c.mechanical_energy_j(s.motion[i], crate::GRAVITY)?;
                    let m = &mut s.motion[i];
                    let adjustment = (m.stem_v_m_s - v).abs();
                    if adjustment > 0.1 * a.velocity_m_s {
                        return Err("Unresolved fleet velocity root".into());
                    }
                    self.account.maximum_event_velocity_adjustment_m_s = self
                        .account
                        .maximum_event_velocity_adjustment_m_s
                        .max(adjustment);
                    m.stem_v_m_s = v;
                    if self.branches[i].joint == motion::JointMode::Contact {
                        m.body_v_m_s = v;
                    }
                    self.account.event_mechanical_adjustment_j +=
                        c.mechanical_energy_j(*m, crate::GRAVITY)? - before;
                    self.account.velocity_events += 1;
                }
                Event::Contact(i) => {
                    let c = self.config[i];
                    let m = &mut s.motion[i];
                    let adjustment = (m.body_y_m - m.stem_y_m).abs();
                    if adjustment > 0.1 * a.position_m {
                        return Err("Unresolved fleet bayonet root".into());
                    }
                    self.account.maximum_event_position_adjustment_m = self
                        .account
                        .maximum_event_position_adjustment_m
                        .max(adjustment);
                    // The located coincidence is represented at its finite-
                    // mass weighted plane, preserving gravitational energy.
                    let y = (c.body_mass_kg * m.body_y_m + c.stem_mass_kg * m.stem_y_m)
                        / (c.body_mass_kg + c.stem_mass_kg);
                    m.body_y_m = y;
                    m.stem_y_m = y;
                    if m.body_v_m_s < m.stem_v_m_s {
                        let impact = c.recontact(*m)?;
                        *m = impact.state;
                        s.heat[i].stem_j += impact.stem_heat_j;
                        s.heat[i].spider_j += impact.spider_heat_j;
                        self.account.contact_heat_j += impact.stem_heat_j + impact.spider_heat_j;
                    }
                    self.account.contact_events += 1;
                }
                Event::Separation(i) => {
                    self.branches[i].joint = motion::JointMode::Separated;
                    self.account.separation_events += 1;
                }
                Event::Fitting(i) => {
                    return Err(format!(
                        "Cluster {i} reaches unqualified incoming fitting contact"
                    ));
                }
            }
        }
        let mut p = PortRates::new(self.config.len(), s.external.len());
        port(s.time_s, &s.motion, &s.external, &mut p)?;
        self.check_port(&p, s.external.len())?;
        let input = self.input();
        for i in 0..self.config.len() {
            let mut b = self.config[i].branch(s.motion[i], input, p.forces[i])?;
            // A just located zero-load opening keeps its accepted side; an
            // equality cannot silently re-close it on the next root probe.
            if events
                .iter()
                .any(|e| matches!(e,Event::Separation(j) if *j==i))
            {
                b.joint = motion::JointMode::Separated;
            }
            self.branches[i] = b;
        }
        Ok(())
    }
    fn settle_storage(&mut self, time: f64) -> Result<bool, String> {
        let event_a = self
            .act_a
            .next_storage_event_s()?
            .is_some_and(|t| dc_supply::coincident(time, t));
        let event_b = self
            .act_b
            .next_storage_event_s()?
            .is_some_and(|t| dc_supply::coincident(time, t));
        if event_a {
            self.act_a
                .transition(time, self.act_a.paths(), self.duty.base_a_w, &[])?;
        }
        if event_b {
            self.act_b.transition(
                time,
                self.act_b.paths(),
                self.duty.base_b_w
                    + if self.rate == 0. {
                        0.
                    } else {
                        self.duty.motive_w
                    },
                &[],
            )?;
        }
        Ok(self.supported())
    }
    /// Advance all mechanics, heat and external water stocks together. Root
    /// equality adjustments are bounded and reported numerical coincidence,
    /// never a finite-position snap or commanded-velocity impulse.
    pub fn advance<F>(
        &mut self,
        s: &mut State,
        target: f64,
        a: &Accuracy,
        port: &mut F,
    ) -> Result<Outcome, String>
    where
        F: FnMut(f64, &[motion::State], &[f64], &mut PortRates) -> Result<(), String>,
    {
        self.validate_state(s, a)?;
        if !self.initialized {
            return Err("Fleet requires an explicit same-state command before advancement".into());
        }
        self.admit(s, port)?;
        if !target.is_finite() || target < s.time_s {
            return Err("Invalid fleet target time".into());
        }
        let mut h = a.maximum_step_s;
        let mut last_retry = "No trial retry";
        'advance: while s.time_s < target {
            if !self.supported() {
                return self.invalidate_support(s.time_s);
            }
            let storage = [
                self.act_a.next_storage_event_s()?,
                self.act_b.next_storage_event_s()?,
            ]
            .into_iter()
            .flatten()
            .fold(target, f64::min);
            let end = target.min(storage);
            h = h.min(end - s.time_s);
            let step_end = s.time_s + h;
            h = step_end - s.time_s;
            if h <= 0. {
                return Err(format!("Unresolvable fleet timestep: {last_retry}"));
            }
            let full = match self.midpoint(s, h, a, port) {
                Ok(v) => v,
                Err(MidpointError::Retry(reason)) => {
                    last_retry = reason;
                    h *= 0.5;
                    self.account.rejected_steps += 1;
                    continue;
                }
                Err(MidpointError::Fatal(e)) => return Err(e),
            };
            let half = match self.midpoint(s, 0.5 * h, a, port) {
                Ok(v) => v,
                Err(MidpointError::Retry(reason)) => {
                    last_retry = reason;
                    h *= 0.5;
                    self.account.rejected_steps += 1;
                    continue;
                }
                Err(MidpointError::Fatal(e)) => return Err(e),
            };
            let mut fine = match self.midpoint(&half, 0.5 * h, a, port) {
                Ok(v) => v,
                Err(MidpointError::Retry(reason)) => {
                    last_retry = reason;
                    h *= 0.5;
                    self.account.rejected_steps += 1;
                    continue;
                }
                Err(MidpointError::Fatal(e)) => return Err(e),
            };
            // One complete coupled step has ONE authoritative endpoint.
            // Near an output/storage clock, h can be one representable tick:
            // two separately rounded half-clock additions can both stay at
            // the original time even though start+h advances. The state was
            // integrated over two durations h/2, so retain the full endpoint,
            // not the independently rounded bookkeeping sum. No state,
            // duration, event boundary or physical tolerance is changed.
            fine.time_s = step_end;
            let error = Self::distance(&full, &fine, a) / 3.;
            if !error.is_finite() {
                return Err("Nonfinite coupled fleet step error".into());
            }
            if error > 1. {
                h *= 0.5;
                self.account.rejected_steps += 1;
                continue;
            }
            let events = self.crossings(s, &full, port)?;
            if !events.is_empty() {
                let mut lo = 0.;
                let mut hi = h;
                let mut found = full;
                let mut found_events = events;
                // One earliest-of-all root bracket, not 52 separate searches.
                for _ in 0..64 {
                    let mid = 0.5 * (lo + hi);
                    if mid == lo || mid == hi {
                        break;
                    }
                    let candidate = match self.midpoint(s, mid, a, port) {
                        Ok(v) => v,
                        Err(MidpointError::Retry(reason)) => {
                            last_retry = reason;
                            h *= 0.5;
                            self.account.rejected_steps += 1;
                            continue 'advance;
                        }
                        Err(MidpointError::Fatal(e)) => return Err(e),
                    };
                    let crossed = self.crossings(s, &candidate, port)?;
                    self.account.root_steps += 1;
                    if crossed.is_empty() {
                        lo = mid;
                    } else {
                        hi = mid;
                        found = candidate;
                        found_events = crossed;
                    }
                    if hi - lo <= 8. * f64::EPSILON * s.time_s.abs().max(1.) {
                        break;
                    }
                }
                // An event's impulse/branch/history and its physical state
                // commit together, only after final physical admission.
                // Failed trials retain the previous admitted Fleet+State.
                // This clone occurs once per located event, not per stage.
                let mut event_fleet = self.clone();
                event_fleet.settle(&mut found, &found_events, a, port)?;
                event_fleet.validate_state(&found, a)?;
                event_fleet.admit(&found, port)?;
                let accepted_h = found.time_s - s.time_s;
                if accepted_h <= 0. {
                    return Err(
                        "Located fleet event did not advance its authoritative clock".into(),
                    );
                }
                *self = event_fleet;
                *s = found;
                self.record_step(accepted_h);
                if !self.settle_storage(s.time_s)? {
                    return self.invalidate_support(s.time_s);
                }
                h = h.min(a.maximum_step_s);
                continue;
            }
            if !self.crossings(s, &half, port)?.is_empty() {
                h *= 0.5;
                self.account.rejected_steps += 1;
                continue;
            }
            if !self.crossings(&half, &fine, port)?.is_empty() {
                h *= 0.5;
                self.account.rejected_steps += 1;
                continue;
            }
            self.validate_state(&fine, a)?;
            self.admit(&fine, port)?;
            let accepted_h = fine.time_s - s.time_s;
            if accepted_h <= 0. {
                return Err("Complete fleet step did not advance its authoritative clock".into());
            }
            *s = fine;
            self.record_step(accepted_h);
            if dc_supply::coincident(s.time_s, storage) {
                if !self.settle_storage(s.time_s)? {
                    return self.invalidate_support(s.time_s);
                }
            }
            if error < 0.1 {
                h = (2. * h).min(a.maximum_step_s);
            }
        }
        Ok(Outcome::Reached)
    }
}
#[cfg(test)]
#[path = "absorber_fleet_tests.rs"]
mod tests;

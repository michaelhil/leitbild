//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/protection-and-command-precedence.md#time-copies-and-simultaneous-actions
//! The S3 frame driver: sampled I&C over stock IDA on the wiki's one
//! declared frame (lead decisions S3-D1.1–3, 6, 7, 11).
//!
//! **Frame.** Instants `k · period` on the simulation-time axis, integer
//! indexed (the wiki's 0.1 s acquisition instant). It is the only grid that
//! coalesces sampled outputs; physical roots keep their located times.
//!
//! **Classes.** Every discrete change is counted by class and kind:
//! - **R**: `discrete_restart` (transactions, time events, bound placement,
//!   identity, exact consistent start, IDAReInit). Every root-located event,
//!   every command, every protective or equipment output that writes state,
//!   changes an algebraic equation or arms a root, and every known-time
//!   change that fails the smallness criterion.
//! - **S**: stop exactly at a known time, apply a held-input change, continue
//!   the retained BDF history, admitted only if the residual jump passes
//!   [`Smallness`] (provisional, S3-D1.2; IC-CTRL's C1 S-vs-R pair
//!   qualifies it).
//! - **O**: observation only. Clients read each accepted step's
//!   interpolating polynomial through [`Dense`] (stock IDAGetDky) between
//!   steps; the integrator runs in stock IDA_ONE_STEP, so observation adds
//!   no IDASolve call and no root evaluation.
//! - **C**: continuous; no event (a DAE state or smooth input). Listed so a
//!   receipt can say none occurred.
//!
//! **Order at one instant.** Frames are observed in index order when the
//! integrator's returned time reaches them; a frame's acquisition reads the
//! plant's left limit at its instant (before any change applied there).
//! Changes due at one instant apply together: one stop or one restart per
//! instant, R if any is R. Commands first, then located roots, then the
//! owners' time events (`discrete_restart`).
//!
//! **Late discovery.** A client may decide a class-R change whose due time
//! the last step already passed (a long quiet step over several frames).
//! The driver then restarts at the due time from the dense-output state of
//! that same step: the discarded part of the step is never observed, and a
//! root located beyond the due time is dropped with it (the physics after
//! the restart decides it again). A class-S change cannot be applied late:
//! a client that may emit one at frame `k` asks for a stop there through
//! [`Client::stop_at_frame`].
//!
//! No solver algorithm, tolerance or step control lives here: the driver
//! only arms stock stop times, reads stock dense output and calls
//! `discrete_restart`.
use crate::{
    ida::{Advance, Ida, System},
    joined::{Discrete, JoinedSystem, Restart, Restarted, discrete_restart},
    klu::SparseLu,
};
use leitbild_operating_plant::joined::block::{Command, Transaction};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The event classes of S3-D1 §2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    R,
    S,
    O,
    C,
}
impl Class {
    pub fn name(self) -> &'static str {
        match self {
            Class::R => "R",
            Class::S => "S",
            Class::O => "O",
            Class::C => "C",
        }
    }
}

/// The declared I&C frame: instants `k · period_s`, integer indexed, on the
/// simulation-time axis (epoch 0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    period_s: f64,
}
impl Frame {
    pub fn new(period_s: f64) -> Result<Self, String> {
        if !(period_s.is_finite() && period_s > 0.) {
            return Err(format!("frame period {period_s} s"));
        }
        Ok(Self { period_s })
    }
    pub fn period_s(&self) -> f64 {
        self.period_s
    }
    /// Instant of frame `k`, always by the same product.
    pub fn instant(&self, k: u64) -> f64 {
        k as f64 * self.period_s
    }
    /// The smallest `k` with `instant(k) >= t` (exact comparison).
    pub fn at_or_after(&self, t: f64) -> Result<u64, String> {
        if !(t.is_finite() && t >= 0.) {
            return Err(format!("frame index of {t} s"));
        }
        let mut k = (t / self.period_s).ceil() as u64;
        if self.instant(k) < t {
            k += 1;
        }
        if k > 0 && self.instant(k - 1) >= t {
            k -= 1;
        }
        Ok(k)
    }
    /// Whole frames in a selected duration, refused unless the duration is
    /// a whole number of frames to within the decimal representation (a
    /// qualification of 0.5 s on the 0.1 s frame is 5 frames).
    pub fn frames_in(&self, duration_s: f64) -> Result<u64, String> {
        let n = duration_s / self.period_s;
        let whole = n.round();
        if !(duration_s.is_finite() && duration_s >= 0.) || (n - whole).abs() > 1e-9 * n.max(1.) {
            return Err(format!(
                "{duration_s} s is not a whole number of {} s frames",
                self.period_s
            ));
        }
        Ok(whole as u64)
    }
}

/// Dense output of the accepted trajectory: the interpolating polynomial of
/// the last accepted step, in solver scaling.
pub trait Dense {
    /// Degree of the polynomial (derivatives above it vanish).
    fn order(&self) -> usize;
    /// Interval on which the polynomial may be read.
    fn interval(&self) -> (f64, f64);
    /// `d^k y / dt^k` at `t` into `out`.
    fn derivative(&self, t: f64, k: usize, out: &mut [f64]) -> Result<(), String>;
}

/// One accepted stock step: IDAGetDky on `[from, to]`.
struct StepDense<'a, S: System> {
    ida: &'a Ida<S>,
    order: usize,
    from: f64,
    to: f64,
}
impl<S: System> Dense for StepDense<'_, S> {
    fn order(&self) -> usize {
        self.order
    }
    fn interval(&self) -> (f64, f64) {
        (self.from, self.to)
    }
    fn derivative(&self, t: f64, k: usize, out: &mut [f64]) -> Result<(), String> {
        if !(self.from..=self.to).contains(&t) {
            return Err(format!(
                "dense output at {t} s outside the observed step [{}, {}]",
                self.from, self.to
            ));
        }
        if k > self.order {
            out.fill(0.);
            return Ok(());
        }
        self.ida.dense(t, k, out)
    }
}

/// The consistent point at a segment start (no step taken yet): the state
/// and its rates, a first-degree view valid at `t` only.
pub struct PointDense<'a> {
    pub t: f64,
    pub y: &'a [f64],
    pub yp: &'a [f64],
}
impl Dense for PointDense<'_> {
    fn order(&self) -> usize {
        1
    }
    fn interval(&self) -> (f64, f64) {
        (self.t, self.t)
    }
    fn derivative(&self, t: f64, k: usize, out: &mut [f64]) -> Result<(), String> {
        if t != self.t {
            return Err(format!("point dense output read at {t} s, not {}", self.t));
        }
        match k {
            0 => out.copy_from_slice(self.y),
            1 => out.copy_from_slice(self.yp),
            _ => out.fill(0.),
        }
        Ok(())
    }
}

/// What a decided change does at its due instant.
pub enum Action<S> {
    /// An owner command applied through `discrete_restart` (class R).
    Command(Command),
    /// A held-input change the client applies to the system at an exact
    /// stop (class S if [`Smallness`] admits its residual jump, else R).
    Held(Box<dyn FnOnce(&mut S) -> Result<(), String>>),
}

/// A physical change a client decided, due at a known time.
pub struct Change<S> {
    pub due_s: f64,
    /// R or S (O and C never stop the integrator).
    pub class: Class,
    /// Counting key, e.g. `"LD01.TRIP.HOLD loss"`.
    pub kind: String,
    pub action: Action<S>,
}

/// A sampled I&C client (protection, a controller).
pub trait Client<S> {
    fn name(&self) -> &str;
    /// Continuous observation (class O) of the accepted trajectory over
    /// `[from, to]`, within one dense interval. The driver splits a step at
    /// every frame instant inside it; `from == to` never occurs.
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String>;
    /// Frame `k` at its instant `t`, after `advance` reached `t`: sample the
    /// plant's left limit, run the logic, return changes due at or after `t`.
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String>;
    /// Whether the integrator must stop exactly at frame `k` (a class-S
    /// output may change there). Protection, whose outputs are R, says no.
    fn stop_at_frame(&self, _k: u64) -> bool {
        false
    }
    /// A declared command applied by the plant's owners at `t` (after the
    /// frames up to `t`): the client's own retained part (for example the
    /// turbine controls' trip memory). It may decide changes.
    fn command(&mut self, _t: f64, _command: Command) -> Result<Vec<Change<S>>, String> {
        Ok(Vec::new())
    }
}

/// Provisional smallness criterion for class S (S3-D1.2): the Newton
/// correction the held-input change alone asks for, `J(cj)^-1 ΔF`, in IDA's
/// WRMS norm, at most `fraction` of the Newton convergence tolerance
/// (stock's coefficient, the segment's 0.33).
#[derive(Clone, Copy, Debug)]
pub struct Smallness {
    pub fraction: f64,
    pub newton_tolerance: f64,
}
impl Smallness {
    pub fn bound(&self) -> f64 {
        self.fraction * self.newton_tolerance
    }
    pub fn admits(&self, jump_wrms: f64) -> bool {
        jump_wrms.is_finite() && jump_wrms <= self.bound()
    }
}

/// The restart configuration the driver passes to `discrete_restart`.
pub struct Setup<'a> {
    pub network_ids: &'a [f64],
    pub absolute: &'a [f64],
    pub relative: f64,
    pub restart: Restart,
}

/// Counts by class and kind (S2 rev 7's counting rule, extended by class).
#[derive(Clone, Debug, Default)]
pub struct Counts {
    by: BTreeMap<(Class, String), u64>,
}
impl Counts {
    pub fn record(&mut self, class: Class, kind: &str) {
        *self.by.entry((class, kind.to_string())).or_default() += 1;
    }
    pub fn total(&self, class: Class) -> u64 {
        self.by
            .iter()
            .filter(|((c, _), _)| *c == class)
            .map(|(_, n)| n)
            .sum()
    }
    pub fn get(&self, class: Class, kind: &str) -> u64 {
        self.by
            .get(&(class, kind.to_string()))
            .copied()
            .unwrap_or(0)
    }
    pub fn json(&self) -> Value {
        let mut out = serde_json::Map::new();
        for class in [Class::R, Class::S, Class::O, Class::C] {
            let kinds: serde_json::Map<String, Value> = self
                .by
                .iter()
                .filter(|((c, _), _)| *c == class)
                .map(|((_, k), n)| (k.clone(), json!(n)))
                .collect();
            out.insert(
                class.name().into(),
                json!({"total": self.total(class), "kinds": kinds}),
            );
        }
        Value::Object(out)
    }
}

/// CPU attribution of a driven span (the caller's clock).
#[derive(Clone, Copy, Debug, Default)]
pub struct Cpu {
    pub solver_s: f64,
    pub observation_s: f64,
    pub restart_s: f64,
    pub smallness_s: f64,
}

/// The driver's state between calls of [`Driver::run`].
pub struct Driver<S> {
    frame: Frame,
    smallness: Smallness,
    clock: fn() -> f64,
    /// First frame index not yet observed.
    next_frame: u64,
    /// Clients' observation has reached this time.
    observed_to: f64,
    pending: Vec<Change<S>>,
    commands: Vec<(f64, Command)>,
    cached: Option<(Vec<i64>, Vec<i64>, SparseLu)>,
    pub counts: Counts,
    pub cpu: Cpu,
    /// One record per stop or restart instant.
    pub log: Vec<Value>,
}

/// Why `Driver::run` returned.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reached {
    Until(f64),
}

impl<S: JoinedSystem> Driver<S> {
    /// A driver whose first observed frame is the first at or after `t0`.
    pub fn new(
        frame: Frame,
        smallness: Smallness,
        clock: fn() -> f64,
        t0: f64,
    ) -> Result<Self, String> {
        if !(smallness.fraction > 0. && smallness.newton_tolerance > 0.) {
            return Err("smallness criterion".into());
        }
        Ok(Self {
            frame,
            smallness,
            clock,
            next_frame: frame.at_or_after(t0)?,
            observed_to: t0,
            pending: Vec::new(),
            commands: Vec::new(),
            cached: None,
            counts: Counts::default(),
            cpu: Cpu::default(),
            log: Vec::new(),
        })
    }
    pub fn frame(&self) -> Frame {
        self.frame
    }
    /// Declare a prospective command at `t` (class R at its exact time).
    pub fn command(&mut self, t: f64, command: Command) -> Result<(), String> {
        if !(t.is_finite() && t >= self.observed_to) {
            return Err(format!("command at {t} s is not prospective"));
        }
        self.commands.push((t, command));
        self.commands.sort_by(|a, b| a.0.total_cmp(&b.0));
        Ok(())
    }
    fn insert(&mut self, changes: Vec<Change<S>>, now: f64) -> Result<(), String> {
        for c in changes {
            if !(c.due_s.is_finite() && c.due_s >= now) {
                return Err(format!("{} due at {} s before {now} s", c.kind, c.due_s));
            }
            if matches!(c.class, Class::O | Class::C) {
                return Err(format!("{} is class {:?}: no stop", c.kind, c.class));
            }
            self.pending.push(c);
        }
        self.pending.sort_by(|a, b| a.due_s.total_cmp(&b.due_s));
        Ok(())
    }

    /// Observe frames and the continuous trajectory up to `to` (or the
    /// earliest due change inside the step, whichever comes first), from the
    /// step's dense output. Returns the time observation reached.
    fn observe(
        &mut self,
        clients: &mut [&mut dyn Client<S>],
        dense: &dyn Dense,
        to: f64,
    ) -> Result<f64, String> {
        let started = (self.clock)();
        let mut limit = self.earliest_due().map_or(to, |d| d.min(to));
        while self.frame.instant(self.next_frame) <= limit {
            let k = self.next_frame;
            let tk = self.frame.instant(k);
            if tk > self.observed_to {
                for c in clients.iter_mut() {
                    c.advance(dense, self.observed_to, tk)?;
                }
                self.observed_to = tk;
            }
            let mut decided = Vec::new();
            for c in clients.iter_mut() {
                decided.extend(c.frame(k, tk, dense)?);
            }
            self.counts.record(Class::O, "frame");
            self.insert(decided, tk)?;
            self.next_frame += 1;
            limit = self.earliest_due().map_or(to, |d| d.min(to));
        }
        if limit > self.observed_to {
            for c in clients.iter_mut() {
                c.advance(dense, self.observed_to, limit)?;
            }
            self.counts.record(Class::O, "dense segment");
            self.observed_to = limit;
        }
        self.cpu.observation_s += (self.clock)() - started;
        Ok(limit)
    }
    fn earliest_due(&self) -> Option<f64> {
        self.pending.first().map(|c| c.due_s)
    }

    /// Process the frame at the segment start `t` if it lies exactly there
    /// (the consistent start, before any step).
    pub fn start(
        &mut self,
        clients: &mut [&mut dyn Client<S>],
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(), String> {
        if self.frame.instant(self.next_frame) == t {
            let point = PointDense { t, y, yp };
            let mut decided = Vec::new();
            for c in clients.iter_mut() {
                decided.extend(c.frame(self.next_frame, t, &point)?);
            }
            self.counts.record(Class::O, "frame");
            self.insert(decided, t)?;
            self.next_frame += 1;
        }
        Ok(())
    }

    /// Advance from the integrator's current time `t` to `until` in stock
    /// one-step mode, observing every step, applying every due change and
    /// every declared command, and restarting at every located root and
    /// owner time event.
    #[allow(clippy::too_many_arguments)] // One driven span: handle, state, clients, setup.
    pub fn run(
        &mut self,
        ida: &mut Ida<S>,
        mut t: f64,
        until: f64,
        y: &mut Vec<f64>,
        yp: &mut Vec<f64>,
        clients: &mut [&mut dyn Client<S>],
        setup: &Setup<'_>,
    ) -> Result<Reached, String> {
        let n = y.len();
        let mut scratch = vec![0.; n];
        while t < until {
            // Anything due now (decided at a frame at this instant, or a
            // command declared here) applies before the next step.
            let due_now = self.earliest_due().is_some_and(|d| d <= t)
                || self.commands.first().is_some_and(|c| c.0 <= t);
            if due_now {
                self.apply(ida, t, None, y, yp, clients, setup, None)?;
                continue;
            }
            let mut stop = until;
            if let Some(d) = self.earliest_due() {
                stop = stop.min(d);
            }
            if let Some(c) = self.commands.first() {
                stop = stop.min(c.0);
            }
            if let Some(e) = ida.system().integrated().joined.next_time_event(t) {
                stop = stop.min(e);
            }
            let next = self.frame.instant(self.next_frame);
            if next > t && clients.iter().any(|c| c.stop_at_frame(self.next_frame)) {
                stop = stop.min(next);
            }
            ida.stop_at(stop)?;
            let started = (self.clock)();
            let outcome = ida.step(stop, y, yp);
            self.cpu.solver_s += (self.clock)() - started;
            let (reached, roots) = match outcome? {
                Advance::Reached(time) => (time, None),
                Advance::Root { time, directions } => (time, Some(directions)),
            };
            let stats = ida.stats()?;
            let order = usize::try_from(stats.last_order.max(0)).unwrap_or(0);
            let observed = {
                let dense = StepDense {
                    ida,
                    order,
                    from: self.observed_to,
                    to: reached,
                };
                self.observe(clients, &dense, reached)?
            };
            if observed < reached {
                // A change decided inside this step is due before its end:
                // restart there from the same step's dense output.
                ida.dense(observed, 0, &mut scratch)?;
                y.copy_from_slice(&scratch);
                ida.dense(observed, 1, &mut scratch)?;
                yp.copy_from_slice(&scratch);
                self.apply(ida, observed, None, y, yp, clients, setup, Some(reached))?;
                t = observed;
                continue;
            }
            t = reached;
            let event = due_owner_event(ida, t);
            let due = self.earliest_due().is_some_and(|d| d <= t)
                || self.commands.first().is_some_and(|c| c.0 <= t);
            if roots.is_some() || event || due {
                self.apply(ida, t, roots, y, yp, clients, setup, None)?;
            }
        }
        Ok(Reached::Until(t))
    }

    /// Everything due at `t`, as one instant: commands, the clients'
    /// changes, located roots and owner time events. One restart if any
    /// part is R; otherwise one stop with the held changes judged by
    /// [`Smallness`].
    #[allow(clippy::too_many_arguments)] // One instant: handle, state, clients, setup.
    fn apply(
        &mut self,
        ida: &mut Ida<S>,
        t: f64,
        roots: Option<Vec<i32>>,
        y: &mut [f64],
        yp: &mut [f64],
        clients: &mut [&mut dyn Client<S>],
        setup: &Setup<'_>,
        rolled_back_from: Option<f64>,
    ) -> Result<(), String> {
        let mut commands: Vec<Command> = Vec::new();
        while self.commands.first().is_some_and(|c| c.0 <= t) {
            commands.push(self.commands.remove(0).1);
        }
        // The clients' own part of each command (e.g. the turbine controls'
        // trip memory); it may decide further changes, due at or after t.
        for c in &commands {
            let mut decided = Vec::new();
            for client in clients.iter_mut() {
                decided.extend(client.command(t, *c)?);
            }
            self.insert(decided, t)?;
        }
        let mut changes: Vec<Change<S>> = Vec::new();
        while self.pending.first().is_some_and(|c| c.due_s <= t) {
            changes.push(self.pending.remove(0));
        }
        let mut kinds: Vec<String> = commands.iter().map(|c| format!("command {c:?}")).collect();
        kinds.extend(changes.iter().map(|c| c.kind.clone()));
        if roots.is_some() {
            kinds.push("located roots".into());
        }
        let owner_event = due_owner_event(ida, t);
        // A rolled-back instant has discarded the history: it restarts,
        // whatever its changes' class (a late S is counted as such).
        let restart_class = !commands.is_empty()
            || roots.is_some()
            || owner_event
            || rolled_back_from.is_some()
            || changes.iter().any(|c| c.class == Class::R)
            || changes.is_empty();
        if rolled_back_from.is_some() {
            for c in changes.iter().filter(|c| c.class == Class::S) {
                kinds.push(format!("{} (S decided late)", c.kind));
            }
        }
        let mut held: Vec<Box<dyn FnOnce(&mut S) -> Result<(), String>>> = Vec::new();
        for c in changes {
            match c.action {
                Action::Command(command) => commands.push(command),
                Action::Held(f) => held.push(f),
            }
        }
        if !restart_class {
            // Class S candidate: every change is a held input.
            let started = (self.clock)();
            let jump = self.held_jump(ida, t, y, yp, held, setup)?;
            self.cpu.smallness_s += (self.clock)() - started;
            if self.smallness.admits(jump) {
                self.counts.record(Class::S, &kinds.join(" + "));
                self.log.push(
                    json!({"t_s": t, "class": "S", "kinds": kinds, "jump_wrms": jump,
                    "bound": self.smallness.bound()}),
                );
                return Ok(());
            }
            // Fails the criterion: restart with the held inputs applied.
            let restarted = self.restart(ida, t, None, &[], y, yp, setup)?;
            self.counts
                .record(Class::R, &format!("{} (S refused)", kinds.join(" + ")));
            self.log.push(json!({"t_s": t, "class": "R", "kinds": kinds, "jump_wrms": jump,
                "bound": self.smallness.bound(), "s_refused": true, "restart": summary(&restarted)}));
            return Ok(());
        }
        for f in held {
            f(ida.system_mut())?;
        }
        let restarted = self.restart(ida, t, roots.as_deref(), &commands, y, yp, setup)?;
        let mut kinds_r = kinds.clone();
        if kinds_r.is_empty() {
            kinds_r.push("owner time event".into());
        }
        let instant_kind = kinds_r.join(" + ");
        self.counts.record(Class::R, &instant_kind);
        self.log
            .push(json!({"t_s": t, "class": "R", "kinds": kinds_r,
            "rolled_back_from_s": rolled_back_from, "restart": summary(&restarted)}));
        Ok(())
    }

    /// One `discrete_restart` at `t`: earlier commands through the joined
    /// operator, then the restart on the last command, the located roots or
    /// the owners' time events.
    #[allow(clippy::too_many_arguments)] // One restart: handle, instant, events, state, setup.
    fn restart(
        &mut self,
        ida: &mut Ida<S>,
        t: f64,
        roots: Option<&[i32]>,
        commands: &[Command],
        y: &mut [f64],
        yp: &mut [f64],
        setup: &Setup<'_>,
    ) -> Result<(Restarted, Vec<Transaction>), String> {
        let started = (self.clock)();
        let mut before: Vec<Transaction> = Vec::new();
        let (early, last) = match (roots, commands.split_last()) {
            (Some(_), _) => (commands, None),
            (None, Some((last, early))) => (early, Some(*last)),
            (None, None) => (commands, None),
        };
        for c in early {
            let done = ida
                .system_mut()
                .integrated_mut()
                .joined
                .command(t, y, *c)
                .map_err(|f| format!("{f:?}"))?;
            before.extend(done);
        }
        let discrete = match (roots, last) {
            (Some(directions), _) => Discrete::Roots(directions),
            (None, Some(c)) => Discrete::Command(c),
            (None, None) => Discrete::TimeEvent,
        };
        let restarted = discrete_restart(
            ida,
            t,
            discrete,
            y,
            setup.network_ids,
            setup.absolute,
            setup.relative,
            &setup.restart,
        )?;
        yp.copy_from_slice(&restarted.yp);
        self.cpu.restart_s += (self.clock)() - started;
        Ok((restarted, before))
    }

    /// The smallness metric of held changes at the exact stop `t`: the
    /// residual before and after them at `(t, y, y')`, and the Newton
    /// correction `J(cj)^-1 ΔF` in IDA's WRMS, with `cj` stock's leading
    /// coefficient for its next order and step (`Σ_{j≤q} 1/j / h`).
    fn held_jump(
        &mut self,
        ida: &mut Ida<S>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        held: Vec<Box<dyn FnOnce(&mut S) -> Result<(), String>>>,
        setup: &Setup<'_>,
    ) -> Result<f64, String> {
        let n = y.len();
        let stats = ida.stats()?;
        let q = stats.current_order.max(1) as usize;
        let h = stats.current_step;
        if !(h.is_finite() && h > 0.) {
            return Err(format!("no step to judge a held change against at {t} s"));
        }
        let cj = (1..=q).map(|j| 1. / j as f64).sum::<f64>() / h;
        let system = ida.system_mut();
        let mut before = vec![0.; n];
        system
            .residual(t, y, yp, &mut before)
            .map_err(|f| format!("{f:?}"))?;
        for f in held {
            f(system)?;
        }
        let mut delta = vec![0.; n];
        system
            .residual(t, y, yp, &mut delta)
            .map_err(|f| format!("{f:?}"))?;
        for (d, b) in delta.iter_mut().zip(&before) {
            *d -= b;
        }
        let nnz = system.nonzeros();
        let (mut data, mut rows, mut pointers) =
            (vec![0.; nnz], vec![0i64; nnz], vec![0i64; n + 1]);
        system
            .jacobian(t, cj, y, yp, &mut data, &mut rows, &mut pointers)
            .map_err(|f| format!("{f:?}"))?;
        let reuse = matches!(&self.cached, Some((p, r, _)) if *p == pointers && *r == rows);
        if !reuse {
            let lu = SparseLu::analyze(n, &pointers, &rows).map_err(|e| e.to_string())?;
            self.cached = Some((pointers, rows, lu));
        }
        let (_, _, lu) = self.cached.as_mut().expect("cached analysis");
        lu.factor(&data).map_err(|e| e.to_string())?;
        lu.solve(&mut delta).map_err(|e| e.to_string())?;
        let sum: f64 = delta
            .iter()
            .zip(y)
            .zip(setup.absolute)
            .map(|((d, v), a)| (d / (setup.relative * v.abs() + a)).powi(2))
            .sum();
        Ok((sum / n as f64).sqrt())
    }
}

/// Whether an owner time event is due exactly at `t` (the owners report
/// their next event strictly after a time).
fn due_owner_event<S: JoinedSystem>(ida: &Ida<S>, t: f64) -> bool {
    ida.system()
        .integrated()
        .joined
        .next_time_event(t - (t.abs() + 1.) * f64::EPSILON)
        .is_some_and(|e| e <= t)
}

fn summary((r, before): &(Restarted, Vec<Transaction>)) -> Value {
    let rep = &r.report;
    json!({"transactions": r.transactions.iter().chain(before).map(|t| t.receipt.clone()).collect::<Vec<_>>(),
        "transacted": r.transacted, "passes_allowed": r.passes_allowed, "placements": r.placements.len(),
        "projection_passes": rep.projection_passes, "rate_passes": rep.rate_passes,
        "correction_wrms": rep.correction_wrms, "residual": rep.residual.value,
        "analyses_made": rep.analyses, "assemblies": rep.jacobian_s.len()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_instants_are_integer_indexed_and_durations_whole() {
        let f = Frame::new(0.1).unwrap();
        assert_eq!(f.instant(5220), 522.0);
        assert_eq!(f.at_or_after(522.0).unwrap(), 5220);
        assert_eq!(f.at_or_after(522.05).unwrap(), 5221);
        assert_eq!(f.at_or_after(0.).unwrap(), 0);
        // Just above an instant: the next frame.
        assert_eq!(f.at_or_after(f.instant(7) + 1e-15).unwrap(), 8);
        assert_eq!(f.frames_in(0.5).unwrap(), 5);
        assert_eq!(f.frames_in(0.2).unwrap(), 2);
        assert_eq!(f.frames_in(1.).unwrap(), 10);
        assert_eq!(f.frames_in(5.).unwrap(), 50);
        assert_eq!(f.frames_in(0.).unwrap(), 0);
        assert!(f.frames_in(0.25).is_err());
        assert!(Frame::new(0.).is_err());
    }

    #[test]
    fn counts_are_by_class_and_kind() {
        let mut c = Counts::default();
        c.record(Class::R, "command");
        c.record(Class::R, "located roots");
        c.record(Class::R, "command");
        c.record(Class::O, "frame");
        assert_eq!(c.total(Class::R), 3);
        assert_eq!(c.get(Class::R, "command"), 2);
        assert_eq!(c.total(Class::S), 0);
        let j = c.json();
        assert_eq!(j["R"]["total"], 3);
        assert_eq!(j["O"]["kinds"]["frame"], 1);
        assert_eq!(j["C"]["total"], 0);
    }

    #[test]
    fn smallness_is_a_fraction_of_the_newton_tolerance() {
        let s = Smallness {
            fraction: 0.1,
            newton_tolerance: 0.33,
        };
        assert!((s.bound() - 0.033).abs() < 1e-15);
        assert!(s.admits(0.03));
        assert!(!s.admits(0.04));
        assert!(!s.admits(f64::NAN));
    }

    #[test]
    fn point_dense_serves_the_start_only() {
        let (y, yp) = ([1., 2.], [3., 4.]);
        let p = PointDense {
            t: 5.,
            y: &y,
            yp: &yp,
        };
        let mut out = [0.; 2];
        p.derivative(5., 1, &mut out).unwrap();
        assert_eq!(out, yp);
        p.derivative(5., 2, &mut out).unwrap();
        assert_eq!(out, [0., 0.]);
        assert!(p.derivative(5.1, 0, &mut out).is_err());
    }
}

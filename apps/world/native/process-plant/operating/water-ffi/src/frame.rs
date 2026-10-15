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
//!   every command, and every change that alters an algebraic constraint, a
//!   differential coordinate or the DAE structure, or arms or jumps a root.
//! - **S**: stop exactly at a known time, apply a held-input change, continue
//!   the retained BDF history. By rule (lead decision S3-D4, on IC-CTRL's C1
//!   pair; it replaces S3-D1.2's residual-jump fraction): a held input that
//!   enters the residual only through a storage element's rate, a source or
//!   sink term of a differential balance (heater power, a demand into a
//!   balance). The driver checks the rule at the stop and refuses a change
//!   declared S that breaks it: the residual moves on no algebraic row, the
//!   differential identity is unchanged and no root function moves. The
//!   residual jump `J(cj)^-1 ΔF` stays a reported diagnostic
//!   ([`Diagnostic::Jump`]), never a gate.
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
    joined::{DerivedTolerances, Discrete, JoinedSystem, Restart, Restarted, discrete_restart},
    klu::SparseLu,
};
use leitbild_operating_plant::joined::block::{Command, Transaction};
use leitbild_operating_plant::network::phase_events::DonorFlips;
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

/// The declared I&C frame (shared with the plant-side I&C).
pub use leitbild_operating_plant::ic::Frame;

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

/// Residual, differential identity and root values at one exact stop.
type HeldState = (Vec<f64>, Vec<f64>, Vec<f64>);

/// A held-input change applied to the system at an exact stop.
pub type HeldChange<S> = Box<dyn FnOnce(&mut S) -> Result<(), String>>;

/// What a decided change does at its due instant.
pub enum Action<S> {
    /// An owner command applied through `discrete_restart` (class R).
    Command(Command),
    /// A held-input change the client applies to the system at an exact
    /// stop: class S when it enters only a storage element's rate
    /// (S3-D4, checked by the driver), class R otherwise.
    Held(HeldChange<S>),
}

/// A physical change a client decided, due at a known time.
pub struct Change<S> {
    pub due_s: f64,
    /// R or S by S3-D4's rule (O and C never stop the integrator). A
    /// `Command` is always R.
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

/// The reported diagnostic of a class-S instant (S3-D4): the Newton
/// correction the held changes alone ask for, `J(cj)^-1 ΔF` in IDA's WRMS
/// (one Jacobian assembly and factorization per S instant), or none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Diagnostic {
    Jump,
    None,
}

/// S3-D4's rule at an exact stop, on the residual change `delta` of the
/// held inputs at `(t, y, y')`, the differential identity before and after
/// them, and the root functions before and after: a class-S change enters
/// only differential rows (a storage element's rate), leaves the identity
/// and every root value unchanged. Returns the rows it entered.
pub fn storage_rate_only(
    delta: &[f64],
    identity_before: &[f64],
    identity_after: &[f64],
    roots_before: &[f64],
    roots_after: &[f64],
) -> Result<usize, String> {
    if delta.len() != identity_before.len() || identity_before.len() != identity_after.len() {
        return Err("S3-D4 check: layout".into());
    }
    if let Some(i) = (0..identity_before.len())
        .find(|i| identity_before[*i].to_bits() != identity_after[*i].to_bits())
    {
        return Err(format!(
            "a change declared S changes the differential identity at coordinate {i}: class R (S3-D4)"
        ));
    }
    if let Some(i) = (0..delta.len()).find(|i| identity_before[*i] == 0. && delta[*i] != 0.) {
        return Err(format!(
            "a change declared S alters algebraic row {i} by {}: class R (S3-D4)",
            delta[i]
        ));
    }
    if roots_before.len() != roots_after.len() {
        return Err("S3-D4 check: root layout".into());
    }
    if let Some(i) =
        (0..roots_before.len()).find(|i| roots_before[*i].to_bits() != roots_after[*i].to_bits())
    {
        return Err(format!(
            "a change declared S moves root function {i} from {} to {}: class R (S3-D4)",
            roots_before[i], roots_after[i]
        ));
    }
    Ok(delta.iter().filter(|d| **d != 0.).count())
}

/// The restart configuration the driver passes to `discrete_restart`.
/// `derived` is what [`crate::joined::derived_tolerances`] applied to
/// `absolute`: every S3 run path carries the derived tolerance classes
/// (S2-D24 and its successors; lead, 15 Oct: the default, never an
/// opt-in), and [`Driver::run`] refuses an `absolute` that does not.
pub struct Setup<'a> {
    pub network_ids: &'a [f64],
    pub absolute: &'a [f64],
    pub relative: f64,
    pub restart: Restart,
    pub derived: &'a DerivedTolerances,
}
impl Setup<'_> {
    /// Refuse tolerances that do not carry the derived classes: every
    /// derived coordinate's absolute tolerance and the relative tolerance
    /// equal the derived record's to rounding (a reference run scales both
    /// by its factor, [`DerivedTolerances::scaled`]).
    pub fn check_derived(&self) -> Result<(), String> {
        let same = |a: f64, b: f64| (a - b).abs() <= 4. * f64::EPSILON * b.abs();
        if self.derived.rows.is_empty() {
            return Err("the run's tolerances carry no derived class (S2-D24)".into());
        }
        if !same(self.relative, self.derived.relative) {
            return Err(format!(
                "the derived classes were made at rtol {}, the run uses {}",
                self.derived.relative, self.relative
            ));
        }
        for r in &self.derived.rows {
            let a = *self
                .absolute
                .get(r.coordinate)
                .ok_or("a derived row lies outside the run's coordinates")?;
            if !same(a, r.applied_scaled) {
                return Err(format!(
                    "{}: the run's absolute tolerance {a} is not its derived class {} (S2-D24)",
                    r.label, r.applied_scaled
                ));
            }
        }
        Ok(())
    }
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
    /// S3-D4's rule check and the jump diagnostic at S instants.
    pub held_s: f64,
}

/// The driver's state between calls of [`Driver::run`].
pub struct Driver<S> {
    frame: Frame,
    diagnostic: Diagnostic,
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
    /// Stock counters summed over closed segments (IDAReInit restarts
    /// them): steps, residuals, Jacobians, nonlinear iterations, error and
    /// convergence failures, linear setups, root evaluations.
    pub totals: [i64; 8],
    /// The segments' counters in order, one per restart and the last.
    pub segments: Vec<Value>,
    /// Class O at every accepted step (C3's cost lines): the network's
    /// donor flips (exact donor by flow sign, decision E2b) ...
    pub donor_flips: DonorFlips,
    /// ... and the accepted states with any rod cluster's annulus volume
    /// current inside R3's blend band, of `observed_states`.
    pub r3_band_states: u64,
    pub observed_states: u64,
    /// HOOK (GATE, receipts; KERN to reconcile): the instant of the last
    /// discrete change attempted (on a refusal, the refusal's time) ...
    pub attempt_s: Option<f64>,
    /// ... and the time the stock solver last reached (an accepted step, a
    /// located root or a stop), so a failed run's receipt states both
    /// rather than only its last logged instant.
    pub solver_reached_s: f64,
}

/// Names of [`Driver::totals`].
pub const COUNTER_NAMES: [&str; 8] = [
    "steps",
    "residuals",
    "jacobians",
    "nonlinear_iterations",
    "error_failures",
    "convergence_failures",
    "linear_setups",
    "root_evaluations",
];

/// Why `Driver::run` returned.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reached {
    Until(f64),
}

impl<S> Driver<S> {
    /// C3's class-O cost lines: the donor flips (total, per path, events)
    /// and the accepted states inside R3's band.
    pub fn observation_json(&self) -> Value {
        json!({"donor_flips": {"total": self.donor_flips.total(),
                "by_path": self.donor_flips.flips.iter().enumerate().filter(|(_, n)| **n > 0).collect::<Vec<_>>(),
                "events": self.donor_flips.events},
            "r3_band_states": self.r3_band_states, "observed_states": self.observed_states})
    }
}

impl<S: JoinedSystem> Driver<S> {
    /// A driver whose first observed frame is the first at or after `t0`.
    pub fn new(
        frame: Frame,
        diagnostic: Diagnostic,
        clock: fn() -> f64,
        t0: f64,
    ) -> Result<Self, String> {
        Ok(Self {
            frame,
            diagnostic,
            clock,
            next_frame: frame.at_or_after(t0)?,
            observed_to: t0,
            pending: Vec::new(),
            commands: Vec::new(),
            cached: None,
            counts: Counts::default(),
            cpu: Cpu::default(),
            log: Vec::new(),
            totals: [0; 8],
            segments: Vec::new(),
            donor_flips: DonorFlips::default(),
            r3_band_states: 0,
            observed_states: 0,
            attempt_s: None,
            solver_reached_s: t0,
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

    /// Add the open segment's stock counters (ending at `t`) to the totals.
    /// Call once more after the last `run` to close the final segment.
    pub fn close_segment(&mut self, ida: &Ida<S>, t: f64) -> Result<(), String> {
        let s = ida.stats()?;
        let c = [
            s.steps,
            s.residuals,
            s.jacobians,
            s.nonlinear_iterations,
            s.error_failures,
            s.convergence_failures,
            s.linear_setups,
            s.root_evaluations,
        ];
        for (a, b) in self.totals.iter_mut().zip(c) {
            *a += b;
        }
        let named: serde_json::Map<String, Value> = COUNTER_NAMES
            .iter()
            .zip(c)
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect();
        self.segments
            .push(json!({"to_s": t, "counts": named, "last_step_s": s.last_step}));
        Ok(())
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
        y: &mut [f64],
        yp: &mut [f64],
        clients: &mut [&mut dyn Client<S>],
        setup: &Setup<'_>,
    ) -> Result<Reached, String> {
        setup.check_derived()?;
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
            // ELEC hook: the operator's and any appended owners' time events.
            if let Some(e) = ida.system().next_time_event(t) {
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
            self.solver_reached_s = reached;
            if roots.is_none() {
                // An accepted step's state: C3's donor flips and R3 band.
                let started = (self.clock)();
                let joined = &mut ida.system_mut().integrated_mut().joined;
                let flips = self.donor_flips.total();
                self.donor_flips.observe(&joined.network, reached, y);
                for _ in flips..self.donor_flips.total() {
                    self.counts.record(Class::O, "donor flip");
                }
                let in_band = joined
                    .r3_band_clusters(y, yp)
                    .map_err(|e| format!("R3 band at {reached} s: {e:?}"))?;
                if in_band > 0 {
                    self.r3_band_states += 1;
                    self.counts.record(Class::O, "R3 band state");
                }
                self.observed_states += 1;
                self.cpu.observation_s += (self.clock)() - started;
            }
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
    /// part is R; otherwise one stop with the held changes checked by
    /// S3-D4's rule ([`storage_rate_only`]).
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
        self.attempt_s = Some(t);
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
        let mut held: Vec<HeldChange<S>> = Vec::new();
        for c in changes {
            match c.action {
                Action::Command(command) => commands.push(command),
                Action::Held(f) => held.push(f),
            }
        }
        if !restart_class {
            // Class S: every change is a held input entering only a storage
            // element's rate (S3-D4, checked; a broken rule refuses).
            let started = (self.clock)();
            let (entered, jump) = self.held(ida, t, y, yp, held, setup)?;
            self.cpu.held_s += (self.clock)() - started;
            self.counts.record(Class::S, &kinds.join(" + "));
            self.log.push(
                json!({"t_s": t, "class": "S", "kinds": kinds, "rows_entered": entered, "jump_wrms": jump}),
            );
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
        self.close_segment(ida, t)?;
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

    /// Held changes at the exact stop `t`: the residual, the differential
    /// identity and the root functions before and after them at
    /// `(t, y, y')`, checked by S3-D4's rule ([`storage_rate_only`]); then,
    /// as the reported diagnostic, the Newton correction `J(cj)^-1 ΔF` in
    /// IDA's WRMS, with `cj` stock's leading coefficient for its next order
    /// and step (`Σ_{j≤q} 1/j / h`). Returns the rows entered and the jump.
    fn held(
        &mut self,
        ida: &mut Ida<S>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        held: Vec<HeldChange<S>>,
        setup: &Setup<'_>,
    ) -> Result<(usize, Option<f64>), String> {
        let n = y.len();
        let stats = ida.stats()?;
        let q = stats.current_order.max(1) as usize;
        let h = stats.current_step;
        let system = ida.system_mut();
        let state = |system: &mut S| -> Result<HeldState, String> {
            let mut residual = vec![0.; n];
            system
                .residual(t, y, yp, &mut residual)
                .map_err(|f| format!("{f:?}"))?;
            let mut roots = vec![0.; system.root_count()];
            system
                .roots(t, y, yp, &mut roots)
                .map_err(|f| format!("{f:?}"))?;
            // ELEC hook: the whole identity, appended coordinates included.
            let identity = system.differential_all(setup.network_ids);
            Ok((residual, identity, roots))
        };
        let (before, identity_before, roots_before) = state(system)?;
        for f in held {
            f(system)?;
        }
        let (mut delta, identity_after, roots_after) = state(system)?;
        for (d, b) in delta.iter_mut().zip(&before) {
            *d -= b;
        }
        let entered = storage_rate_only(
            &delta,
            &identity_before,
            &identity_after,
            &roots_before,
            &roots_after,
        )
        .map_err(|e| format!("at {t} s: {e}"))?;
        if self.diagnostic == Diagnostic::None {
            return Ok((entered, None));
        }
        if !(h.is_finite() && h > 0.) {
            return Err(format!(
                "no step to report a held change's jump against at {t} s"
            ));
        }
        let cj = (1..=q).map(|j| 1. / j as f64).sum::<f64>() / h;
        let nnz = system.nonzeros();
        let (mut data, mut rows, mut pointers) =
            (vec![0.; nnz], vec![0i64; nnz], vec![0i64; n + 1]);
        system
            .jacobian(t, cj, y, yp, &mut data, &mut rows, &mut pointers)
            .map_err(|f| format!("{f:?}"))?;
        // A presence-following handle's capacity may exceed the structure
        // in force; its column pointers end at the entries in use.
        in_use(&pointers, &mut rows, &mut data)?;
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
        Ok((entered, Some((sum / n as f64).sqrt())))
    }
}

/// Keep the entries the column pointers use (the structure in force), out
/// of a Jacobian buffer sized for the system's capacity.
fn in_use(pointers: &[i64], rows: &mut Vec<i64>, data: &mut Vec<f64>) -> Result<(), String> {
    let used = pointers
        .last()
        .and_then(|p| usize::try_from(*p).ok())
        .filter(|u| *u <= rows.len() && rows.len() == data.len())
        .ok_or("Jacobian column pointers beyond the buffer")?;
    rows.truncate(used);
    data.truncate(used);
    Ok(())
}

/// Whether an owner time event is due exactly at `t` (the owners report
/// their next event strictly after a time).
fn due_owner_event<S: JoinedSystem>(ida: &Ida<S>, t: f64) -> bool {
    // ELEC hook: the operator's and any appended owners' time events.
    ida.system()
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
    fn a_capacity_buffer_keeps_the_entries_in_use() {
        let (mut rows, mut data) = (vec![0, 1, 1, 0, 0], vec![1., 2., 3., 0., 0.]);
        in_use(&[0, 2, 3], &mut rows, &mut data).unwrap();
        assert_eq!((rows, data), (vec![0, 1, 1], vec![1., 2., 3.]));
        let (mut rows, mut data) = (vec![0], vec![1.]);
        assert!(in_use(&[0, 2], &mut rows, &mut data).is_err());
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
    fn a_held_change_is_s_only_through_a_storage_rate() {
        // Coordinates 0 and 2 differential, 1 algebraic.
        let ids = [1., 0., 1.];
        let roots = [0.5, -2.];
        // A heater-power step: only differential rows move.
        assert_eq!(
            storage_rate_only(&[3e-4, 0., 0.], &ids, &ids, &roots, &roots).unwrap(),
            1
        );
        // A no-op is S and enters nothing.
        assert_eq!(
            storage_rate_only(&[0.; 3], &ids, &ids, &roots, &roots).unwrap(),
            0
        );
        // An algebraic constraint moved: R.
        let e = storage_rate_only(&[3e-4, 1e-12, 0.], &ids, &ids, &roots, &roots).unwrap_err();
        assert!(e.contains("algebraic row 1"), "{e}");
        // The identity changed (a mode switch): R.
        assert!(storage_rate_only(&[0.; 3], &ids, &[1., 1., 1.], &roots, &roots).is_err());
        // A root armed or jumped: R.
        let e = storage_rate_only(&[1e-3, 0., 0.], &ids, &ids, &roots, &[0.5, 1.]).unwrap_err();
        assert!(e.contains("root function 1"), "{e}");
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

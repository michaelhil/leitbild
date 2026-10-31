//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/distribution-and-switching.md#break-before-make-automatic-transfer
//! The ELEC S3 slice appended to a joined system (S3-D9..D12): the 9
//! generator/shaft/turbine coordinates after the operator's, the generator
//! breaker, AC.A/AC.B routing and the slice's energy quadratures after the
//! joined ledger's.
//!
//! - **Coupling.** The turbine reads the SG owner's admitted steam (a
//!   time-only boundary in S3), so the Jacobian is block diagonal: the
//!   operator's pattern, then one dense 9×9 block. The routing sets each
//!   RCP's drive support and the S3-D12 feed gate on the operator's owners;
//!   the field converter follows its bus.
//! - **Events.** A turbine trip requests GCB OPEN at the trip time; a GCB
//!   travel end, a declared offsite loss (S3-D10) and every routing instant
//!   that changes delivered support are this owner's time events, each a
//!   class-R restart through `discrete_restart`'s appended hooks. Routing
//!   instants that change no supply (qualification timers, intermediate
//!   travel) are processed at their exact times without a stop: the
//!   routing is discrete and does not read the continuous state.
//! - **Absent.** Without this wrapper nothing changes: the hooks' defaults
//!   append no coordinate (S1/S2 paths are bitwise unchanged).
//!
//! - **Field controller** (ICFIELD, generator page § field-supply loss):
//!   [`FieldClient`] reads the converter's delivered supply, its demand and
//!   the breaker's contact/pending travel at each frame's left limit and
//!   runs `electrical::field`; an initiation requests GCB OPEN (CLOSE
//!   withdrawn) and an acquired turbine trip at its decision frame, both
//!   class R by S3-D4 (a command and a breaker request at one instant).
//!
//! No exchange law (the Grid side's): the boundary is the held stiff bus of
//! the slice's inputs, and the carrier a continuous, smooth input of its
//! angle row (owner decisions D2 and R6-K SW-1).
use crate::{
    frame::{Action, Change, Class, Client, Dense},
    ida::{Failure, KluOrdering, System},
    joined::{DerivedRow, Determined, Integrated, JoinedSystem},
};
use leitbild_operating_plant::{
    electrical::{
        breaker::{self, Breaker, Contact},
        bus::{self, Distribution, Source, SourceState},
        field::{self, ConnectionReport, FieldProtection, FieldReport},
        slice::{self, QUADRATURES, Slice},
    },
    ic::Frame,
    joined::block::{Command, snapshot_bits, snapshot_bits_option},
    network::RotorState,
    rotor::{SpeedRequest, Support},
};
use std::collections::BTreeMap;

/// The appended coordinates.
pub const N: usize = slice::N;

/// S3-D16 (proposal, **pending the lead's decision**): the credited
/// electrical outputs the stator coordinates drive, with their budgets.
/// Proposed: the acquired heating-current equivalent `LD01.TG.GEN.IEQ`
/// (generator protection, 1.2 rated for 0.10 s) at its selected 10 A
/// resolution, and the terminal power `LD01.TG.GEN.WT` / the Grid's signed
/// receipt at its selected 1 MW resolution (generator page).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CreditedBudget {
    pub ieq_a: f64,
    pub export_w: f64,
}
pub const PROPOSED_BUDGET: CreditedBudget = CreditedBudget {
    ieq_a: 10.,
    export_w: 1e6,
};

/// The wrapper's discrete configuration, compiled from the electrical packet.
pub struct Configuration {
    /// Routing consumer of each network rotor, rotor order (`LD01.P.A1`, ...).
    pub rotor_consumers: Vec<String>,
    /// The feed pumps whose supply gates the recorded feed (S3-D12): the
    /// feed flows while at least one of them is supplied.
    pub feed_pumps: Vec<String>,
    pub field_bus: String,
    /// Field converter demand at the prepared state (V).
    pub field_demand_v: f64,
    /// Consumer electrical demands for the source account only (FIXTURE:
    /// the pump owners' actual power replaces them later).
    pub fixture_demands_w: BTreeMap<String, f64>,
}

pub struct Electrified<S: JoinedSystem> {
    pub inner: S,
    pub slice: Slice,
    pub breaker: Breaker,
    pub routing: Distribution,
    pub configuration: Configuration,
    /// A declared loss of the offsite connection (S3-D10), at its time.
    pub offsite_loss_s: Option<f64>,
    offsite_lost: bool,
    trip_requested: bool,
    field_bus: usize,
    /// Arc heat and breaker mechanism heat deposited in the body (J).
    pub arc_heat_j: f64,
    pub mechanism_j: f64,
    pub log: Vec<(f64, String)>,
}

fn live(frequency_hz: f64) -> SourceState {
    SourceState {
        energized: true,
        voltage_pu: 1.,
        frequency_hz,
    }
}

/// S3-D19: the wrapper's discrete state, exact (real numbers as IEEE
/// bits): the breaker, the routing, the slice's held inputs, the declared
/// offsite loss and its latch, the trip request latch, and the deposited
/// arc and mechanism heats (the slice's accounts). The log is a receipt.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    breaker: breaker::State,
    routing: bus::State,
    inputs: slice::Inputs,
    #[serde(with = "snapshot_bits_option")]
    offsite_loss_s: Option<f64>,
    offsite_lost: bool,
    trip_requested: bool,
    #[serde(with = "snapshot_bits")]
    arc_heat_j: f64,
    #[serde(with = "snapshot_bits")]
    mechanism_j: f64,
}

impl<S: JoinedSystem> Electrified<S> {
    pub fn new(
        inner: S,
        slice: Slice,
        breaker: Breaker,
        routing: Distribution,
        configuration: Configuration,
    ) -> Result<Self, String> {
        if configuration.rotor_consumers.len() != inner.integrated().joined.network.rotor_count() {
            return Err("one routing consumer per network rotor".into());
        }
        // S3-D27: the routing may close the S3-D12 feed gate, so the SG
        // owner's structure must cover it (declared before compiling).
        if !inner
            .integrated()
            .joined
            .secondary()
            .is_some_and(|s| s.feed_gate_declared())
        {
            return Err(
                "S3-D27: declare the feed gate (Joined::declare_feed_gate) before compiling the structure the electrical slice integrates on"
                    .into(),
            );
        }
        let field_bus = routing
            .bus_index(&configuration.field_bus)
            .ok_or("unknown field converter bus")?;
        let mut inner = inner;
        // The routing owns the RCP drives' support (S3-D9..D12).
        inner.integrated_mut().joined.declare_supply_routing();
        let mut e = Self {
            inner,
            slice,
            breaker,
            routing,
            configuration,
            offsite_loss_s: None,
            offsite_lost: false,
            trip_requested: false,
            field_bus,
            arc_heat_j: 0.,
            mechanism_j: 0.,
            log: Vec::new(),
        };
        e.apply_supply()?;
        Ok(e)
    }
    fn n(&self) -> usize {
        self.inner.dimension()
    }
    fn admitted(&mut self, t: f64) -> Result<(), String> {
        let m = self
            .inner
            .integrated()
            .joined
            .secondary()
            .and_then(|s| s.admitted_steam_kg_s(t))
            .ok_or("the electrical slice needs the SG owner's admitted steam")?;
        self.slice.inputs.admitted_kg_s = m;
        Ok(())
    }
    /// The routing's delivered support onto the operator's owners (each RCP
    /// drive, the S3-D12 feed gate), the field converter and the draws.
    fn apply_supply(&mut self) -> Result<(), String> {
        let c = &self.configuration;
        let supplied = |r: &Distribution, id: &str| {
            r.support(id)
                .is_some_and(|s| s.energized && s.contactor_closed)
        };
        let network = &mut self.inner.integrated_mut().joined.network;
        for (r, id) in c.rotor_consumers.iter().enumerate() {
            let state = network
                .rotor_state(r)
                .ok_or("an RCP's rotor state is not declared")?;
            let support = if supplied(&self.routing, id) {
                Support::Supported(SpeedRequest::Nominal)
            } else {
                Support::Unsupported
            };
            if state.support != support {
                network.set_rotor_state(
                    r,
                    RotorState {
                        support,
                        shaft: state.shaft,
                    },
                );
            }
        }
        let feed = c.feed_pumps.iter().any(|p| supplied(&self.routing, p));
        self.inner
            .integrated_mut()
            .joined
            .secondary_mut()
            .ok_or("the feed gate needs the SG owner")?
            .set_feed_supported(feed)
            .map_err(|f| format!("{f:?}"))?;
        let field = self.routing.bus_energized(self.field_bus).is_some();
        self.slice.inputs.field_v = if field {
            self.configuration.field_demand_v
        } else {
            0.
        };
        let d = self
            .routing
            .source_draw(&self.configuration.fixture_demands_w);
        self.slice.inputs.unit_draw_w = d[0];
        self.slice.inputs.reserve_draw_w = d[1];
        Ok(())
    }
    /// What the consumers and the slice see from the routing, for change detection.
    fn supply_key(r: &Distribution, c: &Configuration, field_bus: usize) -> Vec<bool> {
        let mut k: Vec<bool> = c
            .rotor_consumers
            .iter()
            .chain(&c.feed_pumps)
            .map(|id| {
                r.support(id)
                    .is_some_and(|s| s.energized && s.contactor_closed)
            })
            .collect();
        k.push(r.bus_energized(field_bus).is_some());
        k.push(r.bus_energized(0).is_some());
        k.push(r.bus_energized(1).is_some());
        k
    }
    /// The routing's first pending instant at which delivered support
    /// changes (a due one may lie at or before `t`; the caller filters).
    fn next_supply_change(&self) -> Option<f64> {
        let mut probe = self.routing.clone();
        let key = Self::supply_key(&probe, &self.configuration, self.field_bus);
        for _ in 0..64 {
            let next = probe.next_event()?;
            probe.advance(next).ok()?;
            if Self::supply_key(&probe, &self.configuration, self.field_bus) != key {
                return Some(next);
            }
        }
        None
    }
    /// ICFIELD: the equipment state the field controller's reports acquire.
    /// The converter's delivered motive supply is its bus's (a supply
    /// change is a restart, so it is current at every frame); S3 has no
    /// field switch, so OFF/dump is an OFF (zero) demand. The breaker's
    /// contact and pending CLOSE travel are `LD01.TG.GEN.BREAKER`'s.
    pub fn field_reports(&self) -> (FieldReport, ConnectionReport) {
        (
            FieldReport {
                converter_supplied: self.routing.bus_energized(self.field_bus).is_some(),
                off_or_dump: self.configuration.field_demand_v == 0.,
            },
            ConnectionReport {
                closed: self.breaker.contact == Contact::Closed,
                pending_close: matches!(self.breaker.pending(), Some((Contact::Closed, _))),
            },
        )
    }
    /// ICFIELD: the field controller's generator request at `t`: OPEN, which
    /// withdraws a pending CLOSE (the breaker's own rule), recorded in the
    /// ELEC log with its cause.
    pub fn field_protection_open(&mut self, t: f64, cause: &str) {
        self.breaker.request(Contact::Open, t);
        self.log.push((
            t,
            format!("GCB OPEN requested by {cause} (field controller; CLOSE withdrawn)"),
        ));
    }
    /// The derived stator classes (S3-D16 rule; budget per [`CreditedBudget`],
    /// pending the lead): currents from the tightest of `IEQ` and the export,
    /// linkages through `L'd`. Coordinates are physical (scale 1).
    pub fn derived_rows(
        &self,
        n: usize,
        replaced: &[f64],
        budget: CreditedBudget,
    ) -> Vec<DerivedRow> {
        let p = self.slice.parameters.generator;
        let ldt = p.ls - p.m * p.m / p.lf;
        // S2-D24r/S3-D16's rule: each credited output a stator coordinate
        // determines, with |dx/d(output)|; the applied tolerance is the
        // tightest budget x sensitivity. Ieq = |i_dq|/sqrt(3), so
        // |di/dIeq| = sqrt(3); export P = -(v.i) with |v| = V_line, so
        // |di/dP| >= 1/V_line; the linkages follow through L'd.
        let outputs = [
            ("LD01.TG.GEN.IEQ", budget.ieq_a, 3f64.sqrt()),
            (
                "LD01.TG.GEN.WT",
                budget.export_w,
                1. / self.slice.inputs.v_line,
            ),
        ];
        let row = |k: usize, label: &str, class: &str, through: f64| {
            let mut determines: Vec<Determined> = outputs
                .iter()
                .map(|(output, b, di)| Determined {
                    output: format!("{output} (S3-D16 budget PROPOSED, pending the lead)"),
                    budget: *b,
                    sensitivity: di * through,
                    column: format!("electrical/{label}"),
                    tolerance: b * di * through,
                })
                .collect();
            determines.sort_by(|a, b| a.tolerance.total_cmp(&b.tolerance));
            let applied = determines[0].tolerance;
            DerivedRow {
                coordinate: n + k,
                label: format!("electrical/{label}"),
                class: format!("electrical/{class}"),
                replaced_scaled: replaced[k],
                applied_scaled: applied,
                applied,
                determines,
            }
        };
        vec![
            row(0, "lambda_d", "StatorFlux", ldt),
            row(1, "lambda_q", "StatorFlux", ldt),
            row(3, "id", "StatorCurrent", 1.),
            row(4, "iq", "StatorCurrent", 1.),
        ]
    }
}

/// ICFIELD: the ACT.B field controller (`electrical::field`) as a frame-driver
/// client of the electrified unit. It samples [`Electrified::field_reports`]
/// at each frame's left limit (the driver's equipment-report hook) and, at
/// its decision frame, emits the generator OPEN request and the acquired
/// turbine trip, which the plant's owners apply (STOP ramp, GCB OPEN by the
/// trip) and the clients' retained parts receive (IC-PROT's turbine
/// controls' trip memory, then `LD01.PROT.TG.TRIP` on its report).
pub struct FieldClient {
    pub protection: FieldProtection,
    reports: (FieldReport, ConnectionReport),
}
impl FieldClient {
    /// The controller on the I&C `frame`, reading `unit`'s state at its
    /// construction (the start frame's left limit, which the driver's
    /// start processes before any step).
    pub fn new<S: JoinedSystem>(
        parameters: &field::Parameters,
        frame: Frame,
        unit: &Electrified<S>,
    ) -> Result<Self, String> {
        Ok(Self {
            protection: FieldProtection::new(parameters, frame)?,
            reports: unit.field_reports(),
        })
    }
}
impl<S: JoinedSystem> Client<Electrified<S>> for FieldClient {
    fn name(&self) -> &str {
        "LD01.TG.GEN.FIELD controller (field-supply loss)"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn sample(&mut self, _: u64, _: f64, system: &Electrified<S>) -> Result<(), String> {
        self.reports = system.field_reports();
        Ok(())
    }
    fn frame(
        &mut self,
        k: u64,
        _: f64,
        _: &dyn Dense,
    ) -> Result<Vec<Change<Electrified<S>>>, String> {
        let (f, c) = self.reports;
        let Some(decided) = self.protection.frame(k, f, c)? else {
            return Ok(Vec::new());
        };
        let cause = self
            .protection
            .initiated
            .as_ref()
            .map(|i| i.cause)
            .ok_or("an initiation without its record")?;
        let due = self.protection.frame_of().instant(decided);
        Ok(vec![
            Change {
                due_s: due,
                class: Class::R,
                kind: format!("{cause}: GCB OPEN"),
                action: Action::Held(Box::new(move |u: &mut Electrified<S>| {
                    u.field_protection_open(due, cause);
                    Ok(())
                })),
            },
            Change {
                due_s: due,
                class: Class::R,
                kind: format!("{cause}: turbine trip"),
                action: Action::Command(Command::TurbineTripAcquired),
            },
        ])
    }
}

impl<S: JoinedSystem> System for Electrified<S> {
    fn dimension(&self) -> usize {
        self.inner.dimension() + N
    }
    fn nonzeros(&self) -> usize {
        self.inner.nonzeros() + N * N
    }
    fn klu_ordering(&self) -> KluOrdering {
        self.inner.klu_ordering()
    }
    /// E-NUC: the inner system's multiplicities; the slice is unreduced.
    fn multiplicities(&self) -> Option<Vec<f64>> {
        self.inner.multiplicities().map(|mut m| {
            m.resize(m.len() + N, 1.);
            m
        })
    }
    fn root_count(&self) -> usize {
        self.inner.root_count()
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let n = self.n();
        self.inner.roots(t, &y[..n], &yp[..n], out)
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let n = self.n();
        self.inner.residual(t, &y[..n], &yp[..n], &mut out[..n])?;
        self.admitted(t).map_err(Failure::Fatal)?;
        self.slice
            .rows(t, &y[n..], &yp[n..], &mut out[n..])
            .map_err(Failure::Fatal)
    }
    #[allow(clippy::too_many_arguments)]
    fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let n = self.n();
        let capacity = self.inner.nonzeros();
        self.inner.jacobian(
            t,
            cj,
            &y[..n],
            &yp[..n],
            &mut data[..capacity],
            &mut rows[..capacity],
            &mut pointers[..=n],
        )?;
        self.admitted(t).map_err(Failure::Fatal)?;
        let g = self.slice.block(cj, &y[n..]).map_err(Failure::Fatal)?;
        let base = usize::try_from(pointers[n]).map_err(|_| Failure::Fatal("pointer".into()))?;
        for c in 0..N {
            pointers[n + c] = (base + c * N) as i64;
            for (r, row) in g.iter().enumerate() {
                data[base + c * N + r] = row[c];
                rows[base + c * N + r] = (n + r) as i64;
            }
        }
        pointers[n + N] = (base + N * N) as i64;
        Ok(())
    }
    fn quadrature_count(&self) -> usize {
        self.inner.quadrature_count() + QUADRATURES.len()
    }
    fn quadrature(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        let (n, q) = (self.n(), self.inner.quadrature_count());
        if q > 0 {
            self.inner.quadrature(t, &y[..n], &yp[..n], &mut out[..q])?;
        }
        self.admitted(t).map_err(Failure::Fatal)?;
        out[q..].copy_from_slice(&self.slice.quadratures(&y[n..]).map_err(Failure::Fatal)?);
        Ok(())
    }
}

impl<S: JoinedSystem> JoinedSystem for Electrified<S> {
    type Properties = S::Properties;
    fn integrated(&self) -> &Integrated<S::Properties> {
        self.inner.integrated()
    }
    fn integrated_mut(&mut self) -> &mut Integrated<S::Properties> {
        self.inner.integrated_mut()
    }
    fn appended(&self) -> usize {
        N
    }
    fn appended_events(
        &mut self,
        t: f64,
        command: Option<Command>,
        y: &mut [f64],
    ) -> Result<Vec<String>, String> {
        let mut done = Vec::new();
        // C3's malfunction: the RCP's consumer loses its supply in the
        // routing; the drive support follows below (apply_supply), before
        // the operator's part of the command checks it.
        if let Some(Command::SupplyLoss { rotor }) = command {
            let consumer = self
                .configuration
                .rotor_consumers
                .get(rotor)
                .ok_or_else(|| format!("supply loss of rotor {rotor}: no routing consumer"))?
                .clone();
            self.routing.lose_consumer_supply(t, &consumer)?;
            done.push(format!("{consumer} supply lost (RCP {rotor})"));
        }
        let f0 = self.slice.inputs.f_grid_hz;
        // A turbine trip requests GCB OPEN at its own time (cold-casing page):
        // the command itself, or a trip the SG owner has latched.
        if matches!(
            command,
            Some(Command::TurbineTrip | Command::TurbineTripAcquired)
        ) && !self.trip_requested
        {
            self.breaker.request(Contact::Open, t);
            self.trip_requested = true;
            done.push("GCB OPEN requested by the turbine trip".into());
        }
        let trip = self
            .inner
            .integrated()
            .joined
            .secondary()
            .and_then(|s| s.turbine_trip_time());
        if let Some(tt) = trip
            && !self.trip_requested
            && tt <= t
        {
            self.breaker.request(Contact::Open, tt);
            self.trip_requested = true;
            done.push(format!("GCB OPEN requested by the turbine trip at {tt} s"));
        }
        // S3-D10: the offsite connection opens; no credited island.
        if let Some(tl) = self.offsite_loss_s
            && !self.offsite_lost
            && tl <= t
        {
            if self.slice.inputs.joined {
                self.arc_heat_j += self.slice.separate(y);
            }
            self.routing
                .set_source(t, Source::Unit, SourceState::DEAD)?;
            self.routing
                .set_source(t, Source::Reserve, SourceState::DEAD)?;
            self.offsite_lost = true;
            done.push("offsite connection lost: stator separated, both sources dead".into());
        }
        if let Some(c) = self.breaker.complete(t) {
            match c.contact {
                Contact::Open => {
                    if self.slice.inputs.joined {
                        self.arc_heat_j += self.slice.separate(y);
                    }
                    self.routing
                        .set_source(t, Source::Unit, SourceState::DEAD)?;
                }
                Contact::Closed if !self.offsite_lost => {
                    self.slice.inputs.joined = true;
                    self.routing.set_source(t, Source::Unit, live(f0))?;
                }
                Contact::Closed => {}
            }
            self.slice.deposit(y, c.body_heat_j);
            self.mechanism_j += c.body_heat_j;
            done.push(format!("GCB {:?}", c.contact));
        }
        let logged = self.routing.records.len();
        self.routing.advance(t)?;
        done.extend(
            self.routing.records[logged..]
                .iter()
                .filter(|r| r.support_changed)
                .map(|r| r.what.clone()),
        );
        self.apply_supply()?;
        for d in &done {
            self.log.push((t, d.clone()));
        }
        Ok(done)
    }
    fn appended_start(
        &mut self,
        t: f64,
        y: &mut [f64],
        yp: &mut [f64],
    ) -> Result<Vec<f64>, String> {
        self.admitted(t)?;
        self.slice.consistent(t, y, yp)?;
        Ok(self.slice.differential().to_vec())
    }
    fn appended_next_event(&self, t: f64) -> Option<f64> {
        let candidates = [
            self.breaker.next_event(),
            self.offsite_loss_s.filter(|_| !self.offsite_lost),
            self.next_supply_change(),
        ];
        candidates
            .into_iter()
            .flatten()
            .filter(|e| *e > t)
            .reduce(f64::min)
    }
    fn appended_discrete_state(&self) -> serde_json::Value {
        let state = State {
            breaker: self.breaker.discrete_state(),
            routing: self.routing.discrete_state(),
            inputs: self.slice.inputs,
            offsite_loss_s: self.offsite_loss_s,
            offsite_lost: self.offsite_lost,
            trip_requested: self.trip_requested,
            arc_heat_j: self.arc_heat_j,
            mechanism_j: self.mechanism_j,
        };
        serde_json::json!({ "electrical": state })
    }
    fn restore_appended_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), String> {
        let o = state
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.get("electrical"))
            .ok_or("appended snapshot is not {electrical}")?;
        let s: State =
            serde_json::from_value(o.clone()).map_err(|e| format!("electrical snapshot: {e}"))?;
        self.routing.restore_discrete_state(s.routing)?;
        self.breaker.restore_discrete_state(s.breaker);
        self.slice.inputs = s.inputs;
        self.offsite_loss_s = s.offsite_loss_s;
        self.offsite_lost = s.offsite_lost;
        self.trip_requested = s.trip_requested;
        self.arc_heat_j = s.arc_heat_j;
        self.mechanism_j = s.mechanism_j;
        Ok(())
    }
    fn differential_all(&self, network_ids: &[f64]) -> Vec<f64> {
        [
            self.inner.differential_all(network_ids),
            self.slice.differential().to_vec(),
        ]
        .concat()
    }
}

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
    turbine::governor::{self, Governor},
};
use std::collections::BTreeMap;

/// The slice's appended coordinates (the governor's follow when composed).
pub const N: usize = slice::N;
/// X4.3: the governor's coordinates after the slice's.
pub const G: usize = governor::N;

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
    /// X4.3 (lane TURB): the LOAD governor, ADM and GEN.WT after the
    /// slice's coordinates, when composed ([`Electrified::declare_governor`]).
    pub governor: Option<Governor>,
    /// X4.3: the operator's SG pressure coordinates (global) with their
    /// scales, and the SG rows reading the valve opening (global).
    pressure_coordinates: Vec<(usize, f64)>,
    admission_rows: Vec<usize>,
    /// X4.3: the SG pressures (Pa) of the operator state last seen.
    pressures_pa: Vec<f64>,
    column: Vec<(usize, f64)>,
}

fn plant_failure(f: leitbild_operating_plant::network::Failure) -> Failure {
    match f {
        leitbild_operating_plant::network::Failure::Recoverable(r) => Failure::Recoverable(r),
        leitbild_operating_plant::network::Failure::Fatal(r) => Failure::Fatal(r),
    }
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
    /// X4.3: the governor's held inputs, when composed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    governor: Option<governor::Held>,
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
            governor: None,
            pressure_coordinates: Vec::new(),
            admission_rows: Vec::new(),
            pressures_pa: Vec::new(),
            column: Vec::new(),
        };
        e.apply_supply()?;
        Ok(e)
    }
    fn n(&self) -> usize {
        self.inner.dimension()
    }
    /// The appended coordinates: the slice's, then the governor's.
    fn tail(&self) -> usize {
        N + if self.governor.is_some() { G } else { 0 }
    }
    /// X4.3 (lane TURB): compose the governor, ADM and GEN.WT in LOAD after
    /// the slice, with the SG owner's valve law. Before the integrator is
    /// built.
    pub fn declare_governor(&mut self, governor: Governor) -> Result<(), String> {
        if self.governor.is_some() {
            return Err("the governor is composed once".into());
        }
        let joined = &mut self.inner.integrated_mut().joined;
        let o = joined.offsets().secondary;
        let scales = joined.scales();
        let secondary = joined
            .secondary_mut()
            .ok_or("the governor needs the SG owner")?;
        secondary
            .declare_valve_admission()
            .map_err(|f| format!("{f:?}"))?;
        let terms = secondary
            .admission_terms(0.)
            .ok_or("the SG owner declared no valve law")?;
        self.pressure_coordinates = terms.iter().map(|(i, _)| (o + i, scales[o + i])).collect();
        self.admission_rows = secondary.admission_rows().iter().map(|r| o + r).collect();
        self.governor = Some(governor);
        Ok(())
    }
    /// X4.3: a Grid request at `t` (a Grid exchange): the setpoint ramps
    /// from its value in force. `false` when it changes nothing.
    pub fn request_power(&mut self, t: f64, request_w: f64) -> Result<bool, String> {
        let g = self.governor.as_mut().ok_or("no governor composed")?;
        let changed = g.request(t, request_w)?;
        if changed {
            self.log
                .push((t, format!("governor request {request_w} W")));
        }
        Ok(changed)
    }
    /// The operator's GCB OPEN command at `t` (a pending CLOSE withdrawn).
    pub fn operator_open_breaker(&mut self, t: f64) {
        self.breaker.request(Contact::Open, t);
        self.log
            .push((t, "GCB OPEN requested by the operator".into()));
    }
    /// PROC T4: the operator's OPEN or CLOSE of `bus`'s incoming device
    /// from `source` at `t` (the routing's guards; `false`: rejected and
    /// recorded). Apply it as a class-R change: the contact changes at the
    /// end of the travel, an owner time event of the routing.
    pub fn operator_incoming(
        &mut self,
        t: f64,
        bus: &str,
        source: Source,
        target: bus::Contact,
    ) -> Result<bool, String> {
        let done = self.routing.request_incoming(t, bus, source, target)?;
        self.log.push((
            t,
            format!(
                "operator {bus} {source:?} incoming {target:?}: {}",
                if done { "accepted" } else { "rejected" }
            ),
        ));
        self.apply_supply()?;
        Ok(done)
    }
    /// PROC T11: the operator's START of `consumer` after its contactor
    /// dropped out (`false`: rejected and recorded). A class-R change: the
    /// consumer's delivered support changes at once.
    pub fn operator_start_consumer(&mut self, t: f64, consumer: &str) -> Result<bool, String> {
        let done = self.routing.start_consumer(t, consumer)?;
        self.log.push((
            t,
            format!(
                "operator START {consumer}: {}",
                if done { "accepted" } else { "rejected" }
            ),
        ));
        self.apply_supply()?;
        Ok(done)
    }
    /// X4.3: the operator's ADM CLOSE at `t`: LOAD intent withdrawn, ADM to
    /// closed at its own travel.
    pub fn operator_close_admission(&mut self, t: f64) -> Result<(), String> {
        let g = self.governor.as_mut().ok_or("no governor composed")?;
        g.trip();
        self.log.push((
            t,
            "ADM CLOSE requested by the operator (governor CLOSED)".into(),
        ));
        Ok(())
    }
    /// X4.3: the valve opening the SG rows read, from `y` (the whole state).
    fn set_opening(&mut self, y: &[f64]) -> Result<(), Failure> {
        if self.governor.is_none() {
            return Ok(());
        }
        let a = y[self.n() + N + governor::A];
        self.inner
            .integrated_mut()
            .joined
            .secondary_mut()
            .ok_or_else(|| Failure::Fatal("no SG owner".into()))?
            .set_admission_opening(a, 0.)
            .map_err(plant_failure)
    }
    /// X4.3: the SG pressures (Pa) of the operator's `y`.
    fn read_pressures(&mut self, y: &[f64]) {
        self.pressures_pa = self
            .pressure_coordinates
            .iter()
            .map(|(i, scale)| y[*i] * scale)
            .collect();
    }
    /// X4.3: the per-SG admission coefficients at `t`.
    fn coefficients(&self, t: f64) -> Result<Vec<f64>, String> {
        let terms = self
            .inner
            .integrated()
            .joined
            .secondary()
            .and_then(|s| s.admission_terms(t))
            .ok_or("the SG owner declared no valve law")?;
        Ok(terms.into_iter().map(|(_, c)| c).collect())
    }
    /// The slice's admitted steam: the SG owner's time-only admission, or
    /// with the governor `a * sum c_k(t) p_k` at the last read pressures and
    /// the opening `a`.
    fn admitted_at(&mut self, t: f64, opening: Option<f64>) -> Result<(), String> {
        let Some(a) = opening else {
            return self.admitted(t);
        };
        let c = self.coefficients(t)?;
        let m: f64 = c
            .iter()
            .zip(&self.pressures_pa)
            .map(|(c, p)| a * c * p)
            .sum();
        self.slice.inputs.admitted_kg_s = m;
        Ok(())
    }
    fn opening(&self, tail: &[f64]) -> Option<f64> {
        self.governor.as_ref().map(|_| tail[N + governor::A])
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
    /// S5 snapshot hook (WORLD `ld01-unit`; ELEC reconciles): the
    /// controller's state ([`FieldProtection::snapshot`]). The equipment
    /// reports are not truth: every frame samples them before deciding.
    pub fn snapshot(&self) -> serde_json::Value {
        self.protection.snapshot()
    }
    /// Restore [`FieldClient::snapshot`] exactly.
    pub fn restore(&mut self, state: &serde_json::Value) -> Result<(), String> {
        self.protection.restore(state)
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
        self.inner.dimension() + self.tail()
    }
    fn nonzeros(&self) -> usize {
        let t = self.tail();
        let coupling = if self.governor.is_some() {
            self.pressure_coordinates.len() + self.admission_rows.len()
        } else {
            0
        };
        self.inner.nonzeros() + t * t + coupling
    }
    fn klu_ordering(&self) -> KluOrdering {
        self.inner.klu_ordering()
    }
    /// E-NUC: the inner system's multiplicities; the slice is unreduced.
    fn multiplicities(&self) -> Option<Vec<f64>> {
        let t = self.tail();
        self.inner.multiplicities().map(|mut m| {
            m.resize(m.len() + t, 1.);
            m
        })
    }
    fn root_count(&self) -> usize {
        self.inner.root_count()
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let n = self.n();
        self.set_opening(y)?;
        self.inner.roots(t, &y[..n], &yp[..n], out)
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let n = self.n();
        self.set_opening(y)?;
        self.inner.residual(t, &y[..n], &yp[..n], &mut out[..n])?;
        self.read_pressures(y);
        let opening = self.opening(&y[n..]);
        self.admitted_at(t, opening).map_err(Failure::Fatal)?;
        self.slice
            .rows(t, &y[n..n + N], &yp[n..n + N], &mut out[n..n + N])
            .map_err(Failure::Fatal)?;
        if let Some(g) = &self.governor {
            let export = self.slice.export_w(&y[n..n + N]);
            g.rows(
                t,
                &y[n + N..n + N + G],
                &yp[n + N..n + N + G],
                export,
                y[n + slice::OMEGA],
                &mut out[n + N..n + N + G],
            );
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
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
        let tn = self.tail();
        let capacity = self.inner.nonzeros();
        self.set_opening(y)?;
        self.inner.jacobian(
            t,
            cj,
            &y[..n],
            &yp[..n],
            &mut data[..capacity],
            &mut rows[..capacity],
            &mut pointers[..=n],
        )?;
        self.read_pressures(y);
        let opening = self.opening(&y[n..]);
        self.admitted_at(t, opening).map_err(Failure::Fatal)?;
        let g9 = self.slice.block(cj, &y[n..n + N]).map_err(Failure::Fatal)?;
        let idx = |v: i64| usize::try_from(v).map_err(|_| Failure::Fatal("pointer".into()));
        // The appended rows' dense block, `g[row][col]` over the tail.
        let mut g = vec![vec![0.; tn]; tn];
        for (r, row) in g9.iter().enumerate() {
            g[r][..N].copy_from_slice(row);
        }
        let mut pressure_entries: Vec<(usize, f64)> = Vec::new();
        if let (Some(gov), Some(a)) = (&self.governor, opening) {
            let ys = &y[n..n + N];
            let x = &y[n + N..n + N + G];
            let (own, d_export, d_omega) = gov.block(t, cj, x, ys[slice::OMEGA]);
            // d export / d(id, iq, theta) when connected: export = -(vd id + vq iq).
            let (de_id, de_iq, de_theta) = if self.slice.inputs.joined {
                let (th, v) = (ys[slice::THETA], self.slice.inputs.v_line);
                let (vd, vq) = (v * th.cos(), -v * th.sin());
                (-vd, -vq, v * (th.sin() * ys[3] + th.cos() * ys[4]))
            } else {
                (0., 0., 0.)
            };
            for k in 0..G {
                for c in 0..G {
                    g[N + k][N + c] = own[k][c];
                }
                g[N + k][3] += d_export[k] * de_id;
                g[N + k][4] += d_export[k] * de_iq;
                g[N + k][slice::THETA] += d_export[k] * de_theta;
                g[N + k][slice::OMEGA] += d_omega[k];
            }
            // The torque row on the admitted steam a * sum c_k p_k.
            let torque = self
                .slice
                .parameters
                .turbine
                .torque(self.slice.inputs.admitted_kg_s, ys[slice::OMEGA])
                .map_err(Failure::Fatal)?;
            let c = self.coefficients(t).map_err(Failure::Fatal)?;
            let sum: f64 = c.iter().zip(&self.pressures_pa).map(|(c, p)| c * p).sum();
            g[slice::OMEGA][N + governor::A] = -torque.d_admitted_flow * sum;
            pressure_entries = self
                .pressure_coordinates
                .iter()
                .zip(&c)
                .map(|((i, scale), c)| (*i, -torque.d_admitted_flow * a * c * scale))
                .collect();
            pressure_entries.sort_by_key(|e| e.0);
            // The SG rows' column of the opening.
            let mut column = std::mem::take(&mut self.column);
            self.inner
                .integrated_mut()
                .joined
                .secondary_admission_column(t, &y[..n], &yp[..n], cj, a, &mut column)
                .map_err(plant_failure)?;
            if column
                .iter()
                .map(|e| e.0)
                .ne(self.admission_rows.iter().copied())
            {
                return Err(Failure::Fatal("X4.3: the admission column's rows".into()));
            }
            self.column = column;
        }
        // Insert the torque row's pressure entries at the end of their
        // operator columns (from the back, so nothing is overwritten).
        let mut shift = pressure_entries.len();
        let mut next = pressure_entries.len();
        let old_end = idx(pointers[n])?;
        let mut end = old_end;
        for c in (0..n).rev() {
            if shift == 0 {
                break;
            }
            let begin = idx(pointers[c])?;
            let extra = next > 0 && pressure_entries[next - 1].0 == c;
            if extra {
                next -= 1;
            }
            let dst_end = end + shift;
            if extra {
                data[dst_end - 1] = pressure_entries[next].1;
                rows[dst_end - 1] = (n + slice::OMEGA) as i64;
                shift -= 1;
            }
            data.copy_within(begin..end, begin + shift);
            rows.copy_within(begin..end, begin + shift);
            pointers[c + 1] = (dst_end) as i64;
            end = begin;
        }
        if next != 0 {
            return Err(Failure::Fatal(
                "X4.3: a pressure column outside the operator".into(),
            ));
        }
        let mut at = old_end + pressure_entries.len();
        for c in 0..tn {
            pointers[n + c] = at as i64;
            if self.governor.is_some() && c == N + governor::A {
                for (r, v) in &self.column {
                    data[at] = *v;
                    rows[at] = *r as i64;
                    at += 1;
                }
            }
            for (r, row) in g.iter().enumerate() {
                data[at] = row[c];
                rows[at] = (n + r) as i64;
                at += 1;
            }
        }
        pointers[n + tn] = at as i64;
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
        self.set_opening(y)?;
        if q > 0 {
            self.inner.quadrature(t, &y[..n], &yp[..n], &mut out[..q])?;
        }
        self.read_pressures(y);
        let opening = self.opening(&y[n..]);
        self.admitted_at(t, opening).map_err(Failure::Fatal)?;
        out[q..].copy_from_slice(
            &self
                .slice
                .quadratures(&y[n..n + N])
                .map_err(Failure::Fatal)?,
        );
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
        self.tail()
    }
    fn appended_operator_state(&mut self, y: &[f64]) {
        self.read_pressures(y);
    }
    fn admission_probe(&self, t: f64) -> Option<(usize, Vec<(usize, f64)>)> {
        self.governor.as_ref()?;
        let c = self.coefficients(t).ok()?;
        Some((
            self.n() + N + governor::A,
            self.pressure_coordinates
                .iter()
                .zip(c)
                .map(|((i, scale), c)| (*i, c * scale))
                .collect(),
        ))
    }
    fn appended_events(
        &mut self,
        t: f64,
        command: Option<Command>,
        y: &mut [f64],
    ) -> Result<Vec<String>, String> {
        let mut done = Vec::new();
        // X4.3: the SG rows' opening at the restart's state.
        if self.governor.is_some() {
            let a = y[N + governor::A];
            self.inner
                .integrated_mut()
                .joined
                .secondary_mut()
                .ok_or("no SG owner")?
                .set_admission_opening(a, 0.)
                .map_err(|f| format!("{f:?}"))?;
        }
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
        // X4.3: a turbine trip invalidates LOAD; ADM closes at its travel.
        let tripped = matches!(
            command,
            Some(Command::TurbineTrip | Command::TurbineTripAcquired)
        ) || self
            .inner
            .integrated()
            .joined
            .secondary()
            .and_then(|s| s.turbine_trip_time())
            .is_some_and(|tt| tt <= t);
        if tripped
            && let Some(g) = self.governor.as_mut()
            && g.trip()
        {
            done.push("governor CLOSED by the turbine trip (ADM to closed)".into());
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
        let opening = self.opening(y);
        self.admitted_at(t, opening)?;
        self.slice.consistent(t, &mut y[..N], &mut yp[..N])?;
        let mut ids = self.slice.differential().to_vec();
        if let Some(g) = &self.governor {
            let export = self.slice.export_w(&y[..N]);
            let omega = y[slice::OMEGA];
            g.rates(t, &y[N..N + G], export, omega, &mut yp[N..N + G]);
            ids.extend([1.; G]);
        }
        Ok(ids)
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
            governor: self.governor.as_ref().map(|g| g.held),
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
        // X4.3: a governed unit restores its governor's held inputs; a
        // state saved without a governor leaves the composed LOAD start.
        match (self.governor.as_mut(), s.governor) {
            (Some(g), Some(h)) => g.held = h,
            (None, Some(_)) => return Err("the snapshot has a governor; this unit has none".into()),
            _ => {}
        }
        self.arc_heat_j = s.arc_heat_j;
        self.mechanism_j = s.mechanism_j;
        Ok(())
    }
    fn differential_all(&self, network_ids: &[f64]) -> Vec<f64> {
        [
            self.inner.differential_all(network_ids),
            self.slice.differential().to_vec(),
            if self.governor.is_some() {
                vec![1.; G]
            } else {
                Vec::new()
            },
        ]
        .concat()
    }
}

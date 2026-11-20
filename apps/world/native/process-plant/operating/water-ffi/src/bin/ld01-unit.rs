//! spec: world/packs/process-plant/reference-designs/ld-01/model/numerics-and-realization.md#what-must-survive-copy-pause-and-restore
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/protection-and-command-precedence.md#time-copies-and-simultaneous-actions
//! The LD-01 unit host: one child process per unit, a framed binary
//! protocol on stdin/stdout, stderr for logs only (lane WORLD, plan r4,
//! shell design §1). It is built on the unit library alone: the S3
//! composition (`unit::s3::compose`) on IC-PROT's frame driver with its
//! plant clients (`unit::plant::Plant`: the acquired protection, IC-CTRL's
//! PZR pressure control in class S, the generator page's ACT.B field
//! controller, and AUTO rod control when the section declares it), stock
//! IDAS in one-step mode with its quadratures carried.
//! It reads no environment: LOAD names every input path. It sets two for
//! SUNDIALS's logger, so that SUNDIALS's warnings and errors go to stderr.
//!
//! **Frames.** Request `u32 len | u8 op | u32 seq | payload`; reply
//! `u32 len | u8 status | u32 seq | f64 wall_s | f64 cpu_s | payload`, all
//! little-endian, `len` counting the bytes after itself. Status 0 is ok,
//! 1 an explicit refusal whose payload is the UTF-8 cause. A malformed
//! frame or a closed stdin without CLOSE exits non-zero. One request is in
//! flight at a time; nothing is retried.
//!
//! | op | request | reply |
//! |---|---|---|
//! | 1 LOAD | JSON `{inputs, state, solver}` | JSON identity, `t`, dimension, channels |
//! | 2 CHANNELS | — | JSON `[{id, unit, quantity, source}]` |
//! | 3 ADVANCE | `f64 t1` | `f64 t, f64 solver_t, u32 c, c × u64 counts, u32 v, v × f64 values, u32 m, m bytes JSON events` |
//! | 4 COMMAND | JSON `{kind, t_apply, …}` | JSON (the applied time and its bits; an operator command also `accepted`) |
//! | 5 SNAPSHOT | — | JSON snapshot |
//! | 6 RESTORE | JSON snapshot | as LOAD |
//! | 7 STATUS | — | JSON counts and cost |
//! | 8 CLOSE | — | empty; exit 0 |
//!
//! **Advance.** Under the LOAD solver's `stepping` (R4-FREE-STEPS): `free`
//! (the default of record) observes to `t1` from stock's dense output, the
//! integrator possibly inside its last step past `t1`, and stops exactly
//! only at scheduled changes, commands, roots and a client's changed frame;
//! `frame-stops` stops at every I&C frame instant and at `t1`, so every
//! ADVANCE ends at an accepted stop. The counts are the exchange's own: stock steps,
//! residuals, Jacobians, error-test and convergence failures, R and S
//! instants and frames. The events are the exchange's driver instants (with
//! the rod seats, SG relief crossings, PZR relief openings and the STOP ramp
//! end read from their transactions), the protection's and the field
//! controller's logs and the electrical slice's log, each with its exact
//! time.
//!
//! **Composition.** The IC section's own declarations choose it: a section
//! declaring the governor composes the X4.3 governor (`LD01.TG.ADM.POS`), one
//! declaring the DC groups composes them, report-only (their reports and the
//! labelled engineering values), and one declaring rod control composes the
//! AUTO rod client on the wiki's `ld01-rod-control`; the protection client
//! refuses a governor or DC mismatch. The pages they read join the identity.
//! With rod control the unit delivers `LD01.CORE.BANK.HOLD` and the values
//! the law compares at the last frame, `LD01.CORE.BANK.TAVG` (its lagged
//! Tavg) and `LD01.CORE.BANK.TREF` (its program at its lagged load), read
//! from the rod client's own state: observation only. Beside them
//! `LD01.CORE.BANK.ERROR` (soak amendment A7) is the law's own error at that
//! frame k, Tavg - Tref plus the power-mismatch term as `Controller::frame`
//! forms it, NaN where AUTO decides nothing at k (HOLD, or the drive not
//! engaged). The rate it decides is put in force at frame k + 1's instant
//! and holds until frame k + 2's (R4-ROD-DELAY: decided at k, acting at
//! k + 1), so the bank's travel from frame k + 1 to frame k + 2 is that
//! decision's. With the governor, `LD01.TG.ADM.OPENING` is its admission
//! opening at full precision (1 fully open), the value `LD01.TG.ADM.POS`'s
//! I&C channel lags, samples, transports and rounds to 1 % steps.
//!
//! **Operator commands** (PROC T4, T5, T11; lane ELEC): `IncomingDevice`
//! `{bus, source, target}`, `StartConsumer` `{consumer}`, `DcDistribution`
//! `{group, action}` and `DcChargerInput` `{group, bus}`, decided at the
//! unit's time and applied there, always class R (the protection client's
//! routing and DC copies refresh only at a restart; class S skips it). A name
//! the unit does not hold is refused and changes nothing. A request the
//! equipment's guards refuse is a result, not a refusal: the reply says
//! `accepted: false`, the electrical log records why, and the unit goes on.
//! `BankHold` and `BankAuto` set and release the operator's bank HOLD on the
//! AUTO rod client, at the unit's time and acting at the next frame; a unit
//! whose section declares no rod control refuses them by name.
//!
//! **Snapshot** (design §6.1, copy = restart boundary). At the unit's time,
//! with nothing due there and no held change pending: `t`, `y`, `y'` and
//! the integrator's absolute tolerances as IEEE bits, every owner's discrete
//! state, the three clients' states, the driver's state (next frame, the
//! declared and the decided commands, the carried quadratures) and the
//! identity; then the unit restarts in place at that time exactly as a
//! restore does, so source and copy share the future bitwise. **Restore**
//! (in a fresh process) recomposes from the snapshot's own LOAD request,
//! refuses any identity difference (input files, wiki pages, kernel sources,
//! water library, solver configuration, the composed tolerances), restores
//! every state and makes the same exact consistent restart.
//!
//! **Grid exchange** (R4-GRID, owner 8 Nov). LOAD's `solver.grid_exchange_s`
//! (seconds, or null for a unit no Grid connects) sets an absolute exchange
//! grid in unit time, whole multiples of that many I&C frames. While the
//! generator breaker is closed the next exchange is an exact stop, re-armed
//! at every request boundary from `t`, the LOAD and the breaker's state, so
//! a restored copy holds the stop its source holds. An ADVANCE may not cross
//! an armed exchange. `GridBoundary` and `LoadRequest` apply only at an
//! exchange instant: the boundary's frequency, its rate and the voltage, and
//! the governor's load request, are held inputs entering storage rates only,
//! class S at the stop, no restart. With the breaker open a changed boundary
//! is no event; the boundary's voltage and frequency also reach the auxiliary
//! sources, class R at the exchange only when the qualification band's
//! verdict changes (no stop armed with the breaker open: a restart from the
//! last step's dense output). A dead bus is class R there too, once. Energized after dead
//! is refused: 1.0 has no offsite restoration (S3-D10). A load request with
//! the governor out of LOAD is a result (`accepted: false`), not a refusal.
//!
//! **Kinetics domain** (R4-FLOOR-UNIT). The unit judges the domain of the
//! source feedback as the case observer judges the operable unit's cases:
//! P1 with B1 (OU-P1), the packet's `hot_standby_kinetics` record, through
//! `post_trip_domain::hot_standby_domain_exit` (`validate_accepted_within`,
//! the 8 MPa floor among its bounds, then B1's phase absence) at every
//! accepted step and every restart's consistent start inside an ADVANCE. The
//! first state outside it fail-stops the unit with the exit's label, time and
//! bound; it is not a named end.
//!
//! A refusal after the unit's state may have changed (ADVANCE, a restart, a
//! Grid boundary) fail-stops the unit: every later request but STATUS and
//! CLOSE is refused with that cause.
use leitbild_operating_plant::joined::domain_end::DomainEnd;
use leitbild_operating_plant::{
    digest::sha256,
    electrical::{breaker::Contact, bus, dc_supply, slice},
    ic::{
        acquisition::Quality,
        packet::{Quantity, SgFlow},
    },
    joined::{
        block::Command,
        operator::Joined,
        post_trip_domain::{self, HotStandby},
    },
    network::{CellMode, Network, Properties},
    source_feedback as sf,
    thermal::Scalar,
    turbine::governor::Mode,
};
use leitbild_operating_water::{
    If97,
    electrical::Electrified,
    frame::{
        Action, COUNTER_NAMES, Change, Class, Client, Diagnostic, DriverState, Frame,
        MatrixRebuild, Observer, Side, Stepping, same_instant,
    },
    joined::{Discrete, Integrated, JoinedSystem, discrete_restart},
    unit::{
        clock,
        dc::{self, Dc},
        inputs::{Inputs, MODEL, Spine},
        live,
        plant::{Boundary, Plant},
        profile::{Solver, Weights, parse_first_step, parse_stepping},
        rod_control, s3, timeline, turbine,
    },
};
use serde_json::{Map, Value, json};
use std::cell::Cell;
use std::io::{BufReader, BufWriter, Read, Write};
use std::rc::Rc;
use std::time::Instant;

const KERNEL_SOURCE_SHA256: &str = env!("LD01_KERNEL_SOURCE_SHA256");
const WATER_LIBRARY_SHA256: &str = env!("LD01_WATER_LIBRARY_SHA256");
/// The snapshot's format name.
const FORMAT: &str = "ld01-unit-snapshot";
/// The slice's export quadrature (`slice::QUADRATURES` order).
const EXPORT: usize = 0;

const LOAD: u8 = 1;
const CHANNELS: u8 = 2;
const ADVANCE: u8 = 3;
const COMMAND: u8 = 4;
const SNAPSHOT: u8 = 5;
const RESTORE: u8 = 6;
const STATUS: u8 = 7;
const CLOSE: u8 = 8;

/// The names of an ADVANCE reply's counts, in order.
const COUNTS: [&str; 8] = [
    "steps",
    "residuals",
    "jacobians",
    "error_failures",
    "convergence_failures",
    "r_instants",
    "s_instants",
    "frames",
];

fn bits(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}
fn real(v: &Value, what: &str) -> Result<f64, String> {
    let h = v
        .as_str()
        .filter(|h| h.len() == 16)
        .ok_or_else(|| format!("{what}: 16 hex digits, not {v}"))?;
    u64::from_str_radix(h, 16)
        .map(f64::from_bits)
        .map_err(|e| format!("{what}: {e}"))
}
fn vector_bits(v: &[f64]) -> String {
    v.iter().map(|x| bits(*x)).collect()
}
fn vector(v: &Value, n: usize, what: &str) -> Result<Vec<f64>, String> {
    let s = v.as_str().ok_or_else(|| format!("{what}: a hex string"))?;
    if s.len() != 16 * n || !s.is_ascii() {
        return Err(format!("{what}: {} hex digits for {n} numbers", s.len()));
    }
    (0..n)
        .map(|i| {
            u64::from_str_radix(&s[16 * i..16 * (i + 1)], 16)
                .map(f64::from_bits)
                .map_err(|e| format!("{what}[{i}]: {e}"))
        })
        .collect()
}
fn text<'a>(v: &'a Value, key: &str, what: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("{what} needs the string {key}"))
}
fn file_sha256(path: &str) -> Result<String, String> {
    Ok(sha256(
        &std::fs::read(path).map_err(|e| format!("{path}: {e}"))?,
    ))
}
fn read_json(path: &str) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?)
        .map_err(|e| format!("{path}: {e}"))
}
/// The keys of `v`, exactly `keys`, refused otherwise.
fn exactly<'a>(v: &'a Value, what: &str, keys: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let o = v
        .as_object()
        .ok_or_else(|| format!("{what} is not an object"))?;
    let mut have: Vec<&str> = o.keys().map(String::as_str).collect();
    let mut want = keys.to_vec();
    have.sort_unstable();
    want.sort_unstable();
    if have != want {
        return Err(format!("{what} has keys {have:?}, expected {want:?}"));
    }
    Ok(o)
}

// ------------------------------------------------------------------ commands

/// A kernel command by name (its `Command` variant), or a refusal by name.
fn command_of(v: &Value) -> Result<Command, String> {
    let kind = text(v, "kind", "a command")?;
    let index = |key: &str| -> Result<usize, String> {
        v[key]
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .ok_or_else(|| format!("{kind} needs the index {key}"))
    };
    match kind {
        "TurbineTrip" => Ok(Command::TurbineTrip),
        "ManualReactorTrip" => Ok(Command::ManualReactorTrip),
        "TurbineTripAcquired" => Ok(Command::TurbineTripAcquired),
        "HoldingLoss" => Ok(Command::HoldingLoss),
        "SupplyLoss" => Ok(Command::SupplyLoss {
            rotor: index("rotor")?,
        }),
        "ReliefStuckOpen" => Ok(Command::ReliefStuckOpen),
        "StuckCluster" => Err(
            "StuckCluster: this unit composes no cluster singly (P2), so the rod owner refuses a stuck grip; not offered by this host"
                .into(),
        ),
        "PzrControlMode" | "PzrSetpoint" => Err(format!(
            "{kind}: the PZR client runs the compiled section's AUTO law only and takes no mode or setpoint"
        )),
        other => Err(format!("unknown command kind {other}")),
    }
}
/// The inverse of [`command_of`] (the snapshot's encoding).
fn command_value(c: Command) -> Value {
    match c {
        Command::TurbineTrip => json!({"kind": "TurbineTrip"}),
        Command::ManualReactorTrip => json!({"kind": "ManualReactorTrip"}),
        Command::TurbineTripAcquired => json!({"kind": "TurbineTripAcquired"}),
        Command::HoldingLoss => json!({"kind": "HoldingLoss"}),
        Command::StuckCluster { cluster } => json!({"kind": "StuckCluster", "cluster": cluster}),
        Command::SupplyLoss { rotor } => json!({"kind": "SupplyLoss", "rotor": rotor}),
        Command::ReliefStuckOpen => json!({"kind": "ReliefStuckOpen"}),
    }
}

/// An operator's local electrical command (PROC T4, T5, T11; lane ELEC).
enum Operator {
    Incoming {
        bus: String,
        source: bus::Source,
        target: bus::Contact,
    },
    Start {
        consumer: String,
    },
    Dc {
        group: String,
        command: dc_supply::Command,
    },
    Charger {
        group: String,
        bus: String,
    },
    /// R4-RELIEF-ISO: close or open the relief isolation valve.
    ReliefIsolation {
        close: bool,
    },
}

/// An operator command by name, its keys exactly its own; `None` for a kind
/// that is not one.
fn operator_of(v: &Value, kind: &str) -> Option<Result<Operator, String>> {
    let parsed = |keys: &[&str]| -> Result<(), String> {
        exactly(v, kind, &[&["kind", "t_apply"], keys].concat()).map(|_| ())
    };
    let owned = |key: &str| text(v, key, kind).map(str::to_string);
    Some(match kind {
        "IncomingDevice" => parsed(&["bus", "source", "target"]).and_then(|()| {
            Ok(Operator::Incoming {
                bus: owned("bus")?,
                source: match text(v, "source", kind)? {
                    "unit" => bus::Source::Unit,
                    "reserve" => bus::Source::Reserve,
                    other => return Err(format!("{kind}: source {other}: unit or reserve")),
                },
                target: match text(v, "target", kind)? {
                    "Open" => bus::Contact::Open,
                    "Closed" => bus::Contact::Closed,
                    other => return Err(format!("{kind}: target {other}: Open or Closed")),
                },
            })
        }),
        "ReliefIsolationClose" => parsed(&[]).map(|()| Operator::ReliefIsolation { close: true }),
        "ReliefIsolationOpen" => parsed(&[]).map(|()| Operator::ReliefIsolation { close: false }),
        "StartConsumer" => parsed(&["consumer"]).and_then(|()| {
            Ok(Operator::Start {
                consumer: owned("consumer")?,
            })
        }),
        "DcDistribution" => parsed(&["group", "action"]).and_then(|()| {
            Ok(Operator::Dc {
                group: owned("group")?,
                command: match text(v, "action", kind)? {
                    "Open" => dc_supply::Command::Open,
                    "Reset" => dc_supply::Command::Reset,
                    "Close" => dc_supply::Command::Close,
                    other => return Err(format!("{kind}: action {other}: Open, Reset or Close")),
                },
            })
        }),
        "DcChargerInput" => parsed(&["group", "bus"]).and_then(|()| {
            Ok(Operator::Charger {
                group: owned("group")?,
                bus: owned("bus")?,
            })
        }),
        _ => return None,
    })
}

// ------------------------------------------------------------------ channels

/// How one observation-frame channel is read.
#[derive(Clone, Debug)]
enum Reading {
    Time,
    /// An IC instrument channel's delivered sample (position in
    /// `Protection::delivered`): its value, or its quality code.
    IcValue(usize),
    IcQuality(usize),
    /// An IC state report's delivered sample (position in
    /// `Protection::delivered_reports`): 1 reported, 0 not, NaN before the
    /// first delivery; or its quality code (0 none, 1 value).
    IcReport(usize),
    IcReportQuality(usize),
    /// PROC T5's labelled engineering value by id, at the frame; NaN where
    /// its owner gives none (the depletion estimate while not discharging).
    Engineering(String),
    /// Divisions with the function's cause latched.
    Latched(String),
    DivisionTrip(usize),
    DivisionPowered(usize),
    ContactClosed(usize),
    HoldingAvailable,
    /// Divisions that recorded the request.
    Request(&'static str),
    FieldInitiated,
    /// R4-RELIEF-ISO.
    ReliefIsolationPosition,
    ReliefLiftOpen,
    /// The operator's bank HOLD on the AUTO rod client.
    BankHold,
    /// The AUTO rod law's lagged Tavg (0) and its program reference (1) at
    /// the last frame (`RodClient::tavg_and_reference_k`).
    RodLaw(usize),
    /// A7: the AUTO rod law's error at the last frame k as
    /// `Controller::frame` forms it, Tavg - Tref + K_pm (x - z) on the
    /// client's state after that frame; NaN where AUTO decided nothing at k.
    /// Its rate is in force from frame k + 1's instant to frame k + 2's.
    RodError,
    ReleasedPower,
    PzrPressure,
    PzrCollapsedLevel,
    PzrMixtureLevel,
    /// The face's mass flow over its phase paths.
    FaceFlow(usize),
    /// A coordinate times a factor.
    Coordinate(usize, f64),
    /// A sum of coordinates, each times its factor (an SG's apparent level:
    /// liquid and submerged-vapor volume over the indicated-level area).
    Coordinates(Vec<(usize, f64)>),
    /// The mass-weighted temperature of regular network cells, each cell's
    /// temperature by its phase mode (liquid: caloric at its specific
    /// energy; equilibrium: saturation), as the case harness's leg recorder.
    CellTemperature(Vec<usize>),
    HeaterRequest,
    TerminalPower,
    ShaftSpeed,
    BreakerClosed,
    OffsiteLost,
    ExportEnergy,
    /// R4-GRID: the held boundary and the port's net power.
    GridFrequency,
    GridVoltage,
    NetExport,
    /// R4-GRID: the governor's load request in force and whether it takes one.
    LoadRequest,
    LoadActive,
}

/// R4-GRID: the exchange grid's first instant strictly after `t`.
fn exchange_after(frame: &Frame, every: u64, t: f64) -> f64 {
    let mut m = (t / (every as f64 * frame.period_s())).floor() as u64;
    loop {
        let instant = frame.instant(m * every);
        if instant > t && !same_instant(instant, t) {
            return instant;
        }
        m += 1;
    }
}

/// R4-GRID: whether `t` is an instant of the exchange grid.
fn on_exchange(frame: &Frame, every: u64, t: f64) -> bool {
    let m = (t / (every as f64 * frame.period_s())).round() as u64;
    same_instant(frame.instant(m * every), t)
}

struct Channel {
    id: String,
    unit: &'static str,
    quantity: String,
    source: String,
    read: Reading,
}

fn channel(
    id: impl Into<String>,
    unit: &'static str,
    quantity: &str,
    source: &str,
    read: Reading,
) -> Channel {
    Channel {
        id: id.into(),
        unit,
        quantity: quantity.into(),
        source: source.into(),
        read,
    }
}

/// A regular cell's temperature and water mass at `y` (solver scaling) by
/// the network's phase-mode table: liquid by its caloric state at its
/// specific energy, equilibrium at saturation at its pressure (as the case
/// harness's leg recorder reads it).
fn cell_temperature(net: &Network<If97>, y: &[f64], c: usize) -> Result<(f64, f64), String> {
    let scales = net.scales();
    let l = &net.cell_layout[c];
    let mode = *net
        .cell_modes()
        .get(c)
        .ok_or_else(|| format!("cell {c} has no phase mode"))?;
    let (p, m, u) = (
        y[l.base] * scales[l.base],
        y[l.mass[0]] * scales[l.mass[0]],
        y[l.energy[0]] * scales[l.energy[0]],
    );
    let properties = net.properties();
    match mode {
        CellMode::Liquid => {
            let q = properties
                .caloric(false, p, u / m, false)
                .map_err(|e| format!("cell {c}: liquid caloric: {e:?}"))?;
            Ok((properties.values(&q).temperature_k, m))
        }
        CellMode::Equilibrium => {
            let sat = properties
                .saturation_caloric(Scalar::constant(p))
                .map_err(|e| format!("cell {c}: saturation: {e:?}"))?;
            Ok((sat.temperature.value, m))
        }
    }
}

/// The observation frame's channels, fixed by the composed unit.
fn channels(plant: &Plant, inputs: &Inputs) -> Result<Vec<Channel>, String> {
    let mut out = vec![channel(
        "LD01.UNIT.TIME",
        "s",
        "simulation time",
        "the unit's time",
        Reading::Time,
    )];
    let section = &inputs.ic;
    let delivered = plant.protection.protection.delivered();
    let mut k = 0;
    for f in &section.families {
        let (unit, quantity) = match &f.quantity {
            Quantity::PzrRoofPressure => ("Pa", "PZR roof-tap static pressure"),
            Quantity::PzrLevel { .. } => ("m", "PZR indicated level (fixed saturated calibration)"),
            Quantity::SgCollapsedLevel { .. } => ("m", "SG collapsed level (narrow range)"),
            Quantity::SgApparentLevel { .. } => ("m", "SG apparent level (narrow range)"),
            Quantity::LoopFlow { .. } => ("1", "loop cold-return mass flow over its nominal"),
            Quantity::CurrentProxy { .. } => {
                ("1", "protective local-current proxy (S3-D7 ratio form)")
            }
            Quantity::PumpSpeed { .. } => ("1", "RCP shaft speed over the drive's reference speed"),
            Quantity::CvcsFlow { .. } => ("kg/s", "CVCS branch flow delivered at COLD.A (signed)"),
            Quantity::BankPosition { .. } => (
                "1",
                "mean rod stem travel over the normal stroke (0 seated)",
            ),
            Quantity::StopValvePosition { .. } => ("%", "turbine stop valve stroke (100 open)"),
            // PHYS2 (lead ruling 1 Nov): only in a section declaring the governor.
            Quantity::AdmissionPosition => ("%", "turbine admission valve stroke (100 open)"),
            // PHYS2's X4 channels (ld01-sg-normal-pressure-channel,
            // ld01-sg-flow-channels, ld01-vessel-dp-channels,
            // ld01-core-exit-channels), in the units the section compiles.
            Quantity::SgPressure { .. } => ("Pa", "SG total secondary pressure (absolute)"),
            Quantity::SgFlowLag {
                flow: SgFlow::Steam,
                ..
            } => (
                "1",
                "SG pickup steam flow over the one-SG nominal feed flow m0",
            ),
            Quantity::SgFlowLag {
                flow: SgFlow::Feed, ..
            } => (
                "1",
                "SG branch feed flow over the one-SG nominal feed flow m0",
            ),
            Quantity::VesselDp { .. } => (
                "Pa",
                "core differential pressure (lower minus upper interface)",
            ),
            Quantity::PlenumDp { .. } => ("Pa", "upper plenum mixture head"),
            Quantity::CoreExitTemperature { .. } => ("degC", "core-exit liquid temperature"),
        };
        for c in &f.channels {
            if delivered.get(k).map(|d| d.0.as_str()) != Some(c.id.as_str()) {
                return Err(format!("the protection's channel {k} is not {}", c.id));
            }
            let source = format!("{}: delivered sample (supply {})", f.id, c.supply);
            out.push(channel(&c.id, unit, quantity, &source, Reading::IcValue(k)));
            out.push(channel(
                format!("{}.QUALITY", c.id),
                "1",
                "delivered sample quality: 0 none, 1 value, 2 below range, 3 above range, 4 indeterminate (value = band)",
                &source,
                Reading::IcQuality(k),
            ));
            k += 1;
        }
    }
    if k != delivered.len() {
        return Err("the protection acquires channels the section does not list".into());
    }
    let reports = plant.protection.protection.delivered_reports();
    if reports.len() != section.reports.len()
        || reports
            .iter()
            .zip(&section.reports)
            .any(|(d, r)| d.0 != r.id)
    {
        return Err("the protection's reports are not the section's".into());
    }
    for (i, r) in section.reports.iter().enumerate() {
        let source = format!("{}: delivered state report (supply {})", r.id, r.supply);
        out.push(channel(
            &r.id,
            "1",
            "state report: 1 reported, 0 not",
            &source,
            Reading::IcReport(i),
        ));
        out.push(channel(
            format!("{}.QUALITY", r.id),
            "1",
            "delivered report quality: 0 none, 1 value",
            &source,
            Reading::IcReportQuality(i),
        ));
    }
    // PROC T5: the labelled engineering values, in a section declaring the
    // DC groups; for a person's judgement, no criterion reads them.
    for e in &section.engineering {
        let unit = match e.unit.as_str() {
            "W" => "W",
            "J" => "J",
            "s" => "s",
            other => return Err(format!("{}: unit {other}: W, J or s", e.id)),
        };
        let source = format!("DC group {} report field {}", e.group, e.field);
        out.push(channel(
            &e.id,
            unit,
            &e.label,
            &source,
            Reading::Engineering(e.id.clone()),
        ));
    }
    for f in &section.functions {
        out.push(channel(
            format!("{}.LATCHED", f.id),
            "1",
            "divisions with the cause latched (0-3)",
            "acquired protection divisions",
            Reading::Latched(f.id.clone()),
        ));
    }
    for (d, supply) in section.holding.divisions.iter().enumerate() {
        out.push(channel(
            format!("LD01.PROT.{supply}.TRIP"),
            "1",
            "division trip latch",
            "acquired protection division",
            Reading::DivisionTrip(d),
        ));
        out.push(channel(
            format!("LD01.PROT.{supply}.POWERED"),
            "1",
            "division processor supplied",
            "acquired protection division",
            Reading::DivisionPowered(d),
        ));
    }
    for (c, id) in section.holding.contacts.iter().enumerate() {
        out.push(channel(
            format!("{id}.CLOSED"),
            "1",
            "permissive contact closed",
            "holding chain",
            Reading::ContactClosed(c),
        ));
    }
    out.push(channel(
        format!("{}.AVAILABLE", section.holding.interface),
        "1",
        "holding voltage available",
        "holding chain",
        Reading::HoldingAvailable,
    ));
    for (id, request) in [
        ("LD01.PROT.PRHR.REQUEST", "PRHR"),
        ("LD01.PROT.CMT.REQUEST", "CMT injection"),
        ("LD01.PROT.HEATER_ISOLATION.REQUEST", "heater isolation"),
    ] {
        out.push(channel(
            id,
            "1",
            "divisions that recorded the request (0-3)",
            "acquired protection divisions",
            Reading::Request(request),
        ));
    }
    out.push(channel(
        "LD01.TG.GEN.FIELD.INITIATED",
        "1",
        "field-supply-loss protection initiated",
        "ACT.B field controller",
        Reading::FieldInitiated,
    ));
    out.push(channel(
        "LD01.CORE.RELEASED_POWER",
        "W",
        "reactor released power",
        "kinetics owner (evaluation at the frame time)",
        Reading::ReleasedPower,
    ));
    out.push(channel(
        "LD01.PZR.PRESSURE",
        "Pa",
        "PZR static pressure at the PT1 tap",
        "PZR column taps",
        Reading::PzrPressure,
    ));
    out.push(channel(
        "LD01.PZR.LEVEL.COLLAPSED",
        "m",
        "PZR collapsed level above the cell bottom",
        "PZR column taps",
        Reading::PzrCollapsedLevel,
    ));
    out.push(channel(
        "LD01.PZR.LEVEL.MIXTURE",
        "m",
        "PZR mixture level above the cell bottom",
        "PZR column taps",
        Reading::PzrMixtureLevel,
    ));
    out.push(channel(
        "LD01.PZR.HEATER.REQUEST",
        "W",
        "PZR heater request in force",
        "IC-CTRL PZR pressure control",
        Reading::HeaterRequest,
    ));
    if plant.rods.is_some() {
        out.push(channel(
            "LD01.CORE.BANK.HOLD",
            "1",
            "Bank HOLD in force (1 held, 0 AUTO)",
            "X4.4 AUTO rod control",
            Reading::BankHold,
        ));
        // The values the law compares at each frame (soak r2's rod line):
        // formed every frame, acted on only in AUTO.
        for (i, (id, quantity)) in [
            (
                "LD01.CORE.BANK.TAVG",
                "AUTO rod control's Tavg: the law's lagged loop-mean input",
            ),
            (
                "LD01.CORE.BANK.TREF",
                "AUTO rod control's Tref: the Tavg program at the law's lagged turbine load",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            out.push(channel(
                id,
                "K",
                quantity,
                "X4.4 AUTO rod control",
                Reading::RodLaw(i),
            ));
        }
        // A7: the law's own error, a temperature difference (degC = K).
        out.push(channel(
            "LD01.CORE.BANK.ERROR",
            "degC",
            "AUTO rod control's error at the exchange's last frame k, Tavg - Tref + K_pm (x - z) as the law forms it (NaN where AUTO decides nothing at k); its rate is in force from frame k+1 to frame k+2",
            "X4.4 AUTO rod control",
            Reading::RodError,
        ));
    }
    let joined = &plant.ida.system().integrated().joined;
    // R4-RELIEF-ISO: the valve's position and the relief's direct lift
    // indication, where the packet composes the valve. True flow stays in
    // the receipts.
    if let Some(valve) = joined.pzr().isolation_block() {
        out.push(channel(
            format!("{}.POSITION", valve.id),
            "%",
            "PZR relief isolation valve position (100 open)",
            "R4-RELIEF-ISO position indication",
            Reading::ReliefIsolationPosition,
        ));
        out.push(channel(
            "LD01.PZR.RELIEF.LIFT.OPEN",
            "1",
            "PZR relief lift indication (1 off its seat, 0 seated)",
            "R4-RELIEF-ISO direct lift indication",
            Reading::ReliefLiftOpen,
        ));
    }
    let scales = joined.scales();
    let labels: Vec<String> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.labels)
        .collect();
    let index = |label: &str| {
        labels
            .iter()
            .position(|l| l == label)
            .ok_or_else(|| format!("no coordinate {label}"))
    };
    for f in &section.families {
        if let Quantity::LoopFlow {
            loop_id,
            face,
            face_id,
            ..
        } = &f.quantity
        {
            out.push(channel(
                format!("LD01.RCS.{loop_id}.FLOW"),
                "kg/s",
                "loop mass flow at its cold-return face (phases summed)",
                &format!("network face {face_id}"),
                Reading::FaceFlow(*face),
            ));
        }
    }
    let net = &joined.network;
    for (r, i) in net.rotor_index.iter().enumerate() {
        let id = s3::ROTOR_CONSUMERS
            .get(r)
            .ok_or_else(|| format!("rotor {r} has no consumer name"))?;
        out.push(channel(
            format!("{id}.OMEGA"),
            "rad/s",
            "RCP shaft angular speed",
            &format!("network rotor {r}"),
            Reading::Coordinate(*i, scales[*i] / net.rotor_inertia()),
        ));
    }
    // The secondary owner's coordinate of a label, by owner (the feed
    // train's and the apparent level's live there).
    let secondary = |label: &str| -> Result<usize, String> {
        let mut k = 0;
        let mut found = None;
        for (owner, layout) in joined.layouts() {
            for l in &layout.labels {
                if owner == "secondary" && l == label {
                    if found.is_some() {
                        return Err(format!("the secondary owner names {label} twice"));
                    }
                    found = Some(k);
                }
                k += 1;
            }
        }
        found.ok_or_else(|| format!("no secondary coordinate {label}"))
    };
    for f in &section.families {
        let (sg, area_m2) = match &f.quantity {
            Quantity::SgCollapsedLevel { sg, area_m2 }
            | Quantity::SgApparentLevel { sg, area_m2 } => (sg, area_m2),
            _ => continue,
        };
        {
            let p = index(&format!("SG.{sg}.p_s"))?;
            let v = index(&format!("SG.{sg}.V_l"))?;
            out.push(channel(
                format!("LD01.SG.{sg}.PRESSURE"),
                "Pa",
                "SG secondary pressure",
                "SG secondary owner",
                Reading::Coordinate(p, scales[p]),
            ));
            out.push(channel(
                format!("LD01.SG.{sg}.LEVEL.COLLAPSED"),
                "m",
                "SG collapsed level (liquid volume over the narrow-range area)",
                "SG secondary owner",
                Reading::Coordinate(v, scales[v] / area_m2),
            ));
            if matches!(f.quantity, Quantity::SgApparentLevel { .. }) {
                let sub = secondary(&format!("SG.{sg}.V_sub"))?;
                out.push(channel(
                    format!("LD01.SG.{sg}.LEVEL.APPARENT"),
                    "m",
                    "SG apparent level ((liquid + submerged vapor volume) over the narrow-range area)",
                    "SG secondary owner (apparent level)",
                    Reading::Coordinates(vec![(v, scales[v] / area_m2), (sub, scales[sub] / area_m2)]),
                ));
            }
        }
    }
    // The feed train (plan r4 X4.1): each SG's branch flow, FCV stem and the
    // three-element control's NR1 and steam-flow lags, SG-owner coordinates
    // (as the feed-control recorder reads them). None without a feed train.
    let packet = inputs.spine.packet_json()?;
    if packet["secondary"]["feedTrain"].is_object() {
        let sgs = packet["secondary"]["steamGenerators"]
            .as_array()
            .ok_or("the packet's secondary.steamGenerators")?;
        for g in sgs {
            let id = g["id"].as_str().ok_or("an SG without an id")?;
            for (suffix, label, unit, quantity) in [
                ("FLOW", "m", "kg/s", "feed branch mass flow"),
                (
                    "FCV.POSITION",
                    "FCV.u",
                    "1",
                    "feed control valve stem position (0 shut, 1 open)",
                ),
                (
                    "NR1",
                    "NR1.lag",
                    "m",
                    "three-element control's NR1 apparent level (lagged)",
                ),
                (
                    "STEAM.FLOW",
                    "FT.STEAM.lag",
                    "kg/s",
                    "three-element control's steam flow (lagged)",
                ),
            ] {
                let i = secondary(&format!("FW.{id}.{label}"))?;
                out.push(channel(
                    format!("LD01.FW.{id}.{suffix}"),
                    unit,
                    quantity,
                    &format!("SG secondary owner coordinate FW.{id}.{label}"),
                    Reading::Coordinate(i, scales[i]),
                ));
            }
        }
    }
    // Mass-weighted leg and plenum temperatures over the packet's regions:
    // a loop's hot and cold leg cells by region name, the core's inlet the
    // lower plenum, its outlet the upper.
    let regions: Vec<&str> = packet["mechanics"]["regions"]
        .as_array()
        .ok_or("the packet's mechanics.regions")?
        .iter()
        .map(|r| r["id"].as_str().ok_or("a region without an id"))
        .collect::<Result<_, _>>()?;
    let cells = |test: &dyn Fn(&str) -> bool, what: &str| -> Result<Vec<usize>, String> {
        let c: Vec<usize> = (0..regions.len()).filter(|i| test(regions[*i])).collect();
        if c.is_empty() {
            return Err(format!("no {what} cell"));
        }
        Ok(c)
    };
    for f in &section.families {
        if let Quantity::LoopFlow { loop_id, .. } = &f.quantity {
            for (leg, prefix) in [("THOT", "HOT"), ("TCOLD", "COLD")] {
                let p = format!("{prefix}.{loop_id}");
                let c = cells(&|r| r == p || r.starts_with(&format!("{p}.")), &p)?;
                out.push(channel(
                    format!("LD01.RCS.{loop_id}.{leg}"),
                    "K",
                    "mass-weighted leg water temperature",
                    &format!(
                        "network cells {}",
                        c.iter().map(|i| regions[*i]).collect::<Vec<_>>().join(", ")
                    ),
                    Reading::CellTemperature(c),
                ));
            }
        }
    }
    for (id, region, quantity) in [
        (
            "LD01.CORE.INLET.T",
            "LOWER",
            "core inlet water temperature (lower plenum, mass-weighted)",
        ),
        (
            "LD01.CORE.OUTLET.T",
            "UPPER",
            "core outlet water temperature (upper plenum, mass-weighted)",
        ),
    ] {
        let c = cells(&|r| r == region, region)?;
        out.push(channel(
            id,
            "K",
            quantity,
            &format!("network cell {region}"),
            Reading::CellTemperature(c),
        ));
    }
    let rods = joined.rods().ok_or("the unit composes no rod owner")?;
    let base = joined.offsets().rods;
    // One channel per cluster, named by its packet id: under EVT-RODS-BANK a
    // cluster's travel is its motion class's coordinate, which every member
    // of a bank shares (the coordinate's label names the class, not the
    // cluster), so the cluster order of the packet's rods names them.
    let ids: Vec<&str> = packet["rods"]["clusters"]
        .as_array()
        .ok_or("the packet's rods.clusters")?
        .iter()
        .map(|c| c["id"].as_str().ok_or("a rod cluster without an id"))
        .collect::<Result<_, _>>()?;
    if ids.len() != rods.clusters() {
        return Err(format!(
            "the packet names {} rod clusters, the rod owner composes {}",
            ids.len(),
            rods.clusters()
        ));
    }
    for (id, travel) in ids.iter().zip(&rods.structure().outputs[..rods.clusters()]) {
        let i = base + travel[0];
        out.push(channel(
            format!("LD01.ROD.{id}.TRAVEL"),
            "m",
            "rod cluster travel (its motion class's coordinate)",
            &format!("rod owner coordinate {}", labels[i]),
            Reading::Coordinate(i, scales[i]),
        ));
    }
    let travels: Vec<usize> = rods.structure().outputs[..rods.clusters()]
        .iter()
        .map(|travel| base + travel[0])
        .collect();
    out.push(channel(
        "LD01.ROD.TRAVEL.MEAN",
        "m",
        "mean rod cluster travel over every cluster",
        "rod owner (cluster order)",
        Reading::Coordinates(
            travels
                .iter()
                .map(|i| (*i, scales[*i] / travels.len() as f64))
                .collect(),
        ),
    ));
    for (id, unit, quantity, read) in [
        (
            "LD01.TG.GEN.WT",
            "W",
            "generator terminal export power",
            Reading::TerminalPower,
        ),
        (
            "LD01.TG.SHAFT.OMEGA",
            "rad/s",
            "turbine-generator shaft angular speed",
            Reading::ShaftSpeed,
        ),
        (
            "LD01.TG.GEN.BREAKER.CLOSED",
            "1",
            "generator breaker contact closed",
            Reading::BreakerClosed,
        ),
        (
            "LD01.GRID.OFFSITE_LOST",
            "1",
            "offsite connection lost (S3-D10)",
            Reading::OffsiteLost,
        ),
        (
            "LD01.TG.GEN.EXPORT_ENERGY",
            "J",
            "generator export energy since LOAD (IDAS quadrature)",
            Reading::ExportEnergy,
        ),
        (
            "LD01.GRID.FREQUENCY",
            "Hz",
            "the Grid's frequency held at the boundary",
            Reading::GridFrequency,
        ),
        (
            "LD01.GRID.VOLTAGE",
            "1",
            "the Grid's voltage held at the boundary, per unit of the line voltage",
            Reading::GridVoltage,
        ),
        (
            "LD01.GRID.NET_EXPORT",
            "W",
            "net power to the Grid: terminal export less both auxiliary draws",
            Reading::NetExport,
        ),
    ] {
        out.push(channel(id, unit, quantity, "ELEC slice", read));
    }
    // R4-GRID: the load path, with a governor composed.
    if inputs.ic.governor.declared {
        out.push(channel(
            "LD01.TG.LOAD.REQUEST",
            "W",
            "the governor's load request in force",
            "X4.3 governor",
            Reading::LoadRequest,
        ));
        out.push(channel(
            "LD01.TG.LOAD.ACTIVE",
            "1",
            "the governor is in LOAD and takes a load request",
            "X4.3 governor",
            Reading::LoadActive,
        ));
        // A7: the opening LD01.TG.ADM.POS's I&C channel reads, unrounded.
        let (opening, _) = plant
            .ida
            .system()
            .admission_probe(plant.t0)
            .ok_or("the governor's admission opening")?;
        out.push(channel(
            "LD01.TG.ADM.OPENING",
            "1",
            "the governor's admission opening at the exchange's last frame, full precision (1 fully open); LD01.TG.ADM.POS is its I&C channel (0.1 s lag, 0.1 s sample and transport, 1 % steps)",
            "X4.3 governor",
            Reading::Coordinate(opening, 1.),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    if let Some(c) = out.iter().find(|c| !seen.insert(c.id.clone())) {
        return Err(format!("channel {} named twice", c.id));
    }
    Ok(out)
}

fn channels_json(channels: &[Channel]) -> Value {
    Value::Array(
        channels
            .iter()
            .map(
                |c| json!({"id": c.id, "unit": c.unit, "quantity": c.quantity, "source": c.source}),
            )
            .collect(),
    )
}

// ---------------------------------------------------------------------- unit

struct Unit {
    plant: Plant,
    inputs: Inputs,
    /// The unit's time: the driver stands exactly here between requests.
    t: f64,
    load: Value,
    identity: Value,
    channels: Vec<Channel>,
    v_nominal: f64,
    /// The composed DC groups (their names and charger buses), when the
    /// section declares them.
    dc: Option<Dc>,
    failed: Option<String>,
    /// R4-ENDED: the named domain end the unit stands at.
    ended: Option<Ended>,
    exchanges: u64,
    /// R4-GRID: the exchange grid in I&C frames (LOAD's `grid_exchange_s`).
    grid_exchange_frames: Option<u64>,
    /// R4-FLOOR-UNIT: the kinetics domain judged on accepted states.
    domain: KineticsDomain,
}

/// R4-ENDED: a named domain end, at the last accepted step's time.
struct Ended {
    end: DomainEnd,
    t: f64,
    cause: String,
}

/// R4-FLOOR-UNIT: the kinetics domain the case observer judges on the
/// operable unit's cases (P1 with B1, OU-P1), judged here at the same points
/// with the same functions: every accepted stock step, and every restart's
/// consistent start inside a driven span. Read from the packet at compose;
/// it holds no state and decides no change.
struct KineticsDomain {
    /// The packet's `hot_standby_kinetics` record (`ld01-hot-standby-kinetics`).
    record: HotStandby,
    /// The operator's dimension (the electrical slice's coordinates follow).
    n: usize,
}

impl KineticsDomain {
    fn of(packet: &Value, plant: &Plant) -> Result<Self, String> {
        let record: HotStandby = serde_json::from_value(packet["hot_standby_kinetics"].clone())
            .map_err(|e| format!("the packet's hot_standby_kinetics section (OU-P1): {e}"))?;
        let feedback = plant.ida.system().integrated().joined.nuclear().feedback();
        record
            .validate(&feedback.domains())
            .map_err(|e| e.to_string())?;
        Ok(Self { record, n: plant.n })
    }

    /// The case observer's P1 exit at the accepted state `(t, y, y')`: its
    /// evaluation held or made there, then
    /// [`post_trip_domain::hot_standby_domain_exit`]; at an exit, the
    /// admission names it, labelled as the case observer labels it. The check
    /// reads the nuclear block, the rods' travel and the region water only,
    /// so a release-root call's evaluation that stopped at the face drives
    /// serves as well as a whole one (R4-ROOT-DRIVES).
    fn judge(
        &self,
        joined: &mut Joined<If97>,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(), String> {
        if !joined.holds_nuclear_evaluation(t, y, yp) {
            joined
                .evaluate(t, y, yp, None, 0., None)
                .map_err(|e| format!("kinetics domain: the operator at {t} s: {e:?}"))?;
        }
        let phase = joined
            .region_phases()
            .map_err(|e| format!("kinetics domain: region phases at {t} s: {e:?}"))?;
        let exit = post_trip_domain::hot_standby_domain_exit(
            joined.nuclear(),
            &phase,
            &self.record,
            joined.travel(),
            t,
            0.,
        )
        .map_err(|e| format!("kinetics domain at {t} s: {e}"))?;
        if !exit {
            return Ok(());
        }
        match post_trip_domain::admit_hot_standby_accepted(
            joined.nuclear(),
            &phase,
            &self.record,
            joined.travel(),
            t,
            0.,
        ) {
            Ok(_) => Ok(()),
            Err(post_trip_domain::Error::Unsupported {
                margin_holds, exit, ..
            }) => {
                let label = if sf::phase_absence(&phase).err().as_ref() == Some(&exit) {
                    "B1 phase-absence exit"
                } else {
                    "P1 hot-standby domain exit"
                };
                Err(format!(
                    "{label} at {t} s: unsupported: nominal margin holds {margin_holds}, {exit:?}: the first accepted state outside the kinetics domain (R4-FLOOR-UNIT)"
                ))
            }
            Err(e) => Err(format!("kinetics domain at {t} s: {e}")),
        }
    }
}

impl<J: JoinedSystem<Properties = If97>> Observer<Electrified<J>> for KineticsDomain {
    fn next_after(&self, _t: f64) -> Option<f64> {
        None
    }
    fn sample(
        &mut self,
        system: &mut Electrified<J>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        _q: &[f64],
        side: Side,
    ) -> Result<(), String> {
        if side != Side::AfterRestart {
            return Ok(());
        }
        let n = self.n;
        self.judge(&mut system.integrated_mut().joined, t, &y[..n], &yp[..n])
    }
    fn accepted(
        &mut self,
        system: &mut Electrified<J>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        _q: &[f64],
    ) -> Result<(), String> {
        let n = self.n;
        self.judge(&mut system.integrated_mut().joined, t, &y[..n], &yp[..n])
    }
}

/// The cheap identity of a LOAD request: every input file and wiki page it
/// names, by SHA-256, the kernel and the water library, the solver.
fn file_identity(
    load: &Value,
    inputs: &Inputs,
    state: &str,
    solver: Solver,
) -> Result<Value, String> {
    let page = |p: &str| -> Result<Value, String> {
        let path = inputs.spine.model_page(p);
        Ok(json!({"page": format!("{MODEL}/{p}"), "sha256": file_sha256(&path)?}))
    };
    let channel_page = format!(
        "{}/world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md",
        inputs.control_wiki
    );
    let i = &load["inputs"];
    let mut pages = vec![page("build-readiness.md")?, page("operating-hot-spine.md")?];
    // The pages the section's declarations compose from.
    let declared = [
        (inputs.ic.governor.declared, turbine::TURBINE_PAGE),
        (inputs.ic.governor.declared, turbine::ADMISSION_PAGE),
        (inputs.ic.dc.declared, dc::DC_PAGE),
        (inputs.ic.rod_control.declared, rod_control::PAGE),
    ];
    for (_, p) in declared.iter().filter(|(on, _)| *on) {
        let path = format!("{}/{p}", inputs.spine.wiki_root);
        pages.push(json!({"page": p, "sha256": file_sha256(&path)?}));
    }
    Ok(json!({
        "packet": {"path": i["packet"], "sha256": file_sha256(&inputs.spine.packet_path)?},
        "ic": {"path": i["ic"], "sha256": file_sha256(&inputs.ic_path)?},
        "pzr_control": {"path": i["pzr_control"], "sha256": file_sha256(&inputs.control_path)?},
        "pzr_control_channel": {"page": "operational-observations.md", "sha256": file_sha256(&channel_page)?},
        "elec": {"path": i["elec"], "sha256": file_sha256(&inputs.elec_path)?},
        "state": {"path": state, "sha256": file_sha256(state)?},
        "wiki": {"commit": i["wiki_commit"], "repository": i["wiki_repository"], "pages": pages},
        "kernel_source_sha256": KERNEL_SOURCE_SHA256,
        "water_library_sha256": WATER_LIBRARY_SHA256,
        "solver": solver,
    }))
}

/// R4-GRID: LOAD's exchange interval in I&C frames: a whole number of them,
/// the grid's instants the frames' own product.
fn exchange_frames(seconds: f64, frame: &Frame) -> Result<u64, String> {
    let frames = (seconds / frame.period_s()).round();
    if !(seconds.is_finite() && seconds > 0. && frames >= 1.)
        || !same_instant(frames * frame.period_s(), seconds)
    {
        return Err(format!(
            "LOAD solver.grid_exchange_s {seconds} is not a whole number of {} s frames",
            frame.period_s()
        ));
    }
    Ok(frames as u64)
}

/// A LOAD request's parts: the inputs, the state's path, the solver, the
/// Grid exchange interval (s; null for a unit no Grid connects).
fn parse_load(load: &Value) -> Result<(Inputs, String, Solver, Option<f64>), String> {
    let o = exactly(load, "LOAD", &["inputs", "state", "solver"])?;
    let i = &o["inputs"];
    exactly(
        i,
        "LOAD inputs",
        &[
            "packet",
            "wiki_root",
            "wiki_commit",
            "wiki_repository",
            "ic",
            "pzr_control",
            "pzr_control_wiki",
            "elec",
        ],
    )?;
    let optional = |key: &str| match &i[key] {
        Value::Null => Ok(None),
        Value::String(c) => Ok(Some(c.clone())),
        other => Err(format!(
            "LOAD inputs.{key} is a string or null, not {other}"
        )),
    };
    // The wiki commit the root is verified to be, and the repository that
    // resolves it (the composition's provenance check).
    let (wiki_commit, wiki_repository) = (optional("wiki_commit")?, optional("wiki_repository")?);
    let spine = Spine::from_paths(
        text(i, "packet", "LOAD inputs")?,
        text(i, "wiki_root", "LOAD inputs")?,
        wiki_commit,
        wiki_repository,
    )?;
    let inputs = Inputs::from_paths(
        spine,
        text(i, "ic", "LOAD inputs")?,
        text(i, "pzr_control", "LOAD inputs")?,
        text(i, "pzr_control_wiki", "LOAD inputs")?,
        text(i, "elec", "LOAD inputs")?,
    )?;
    exactly(
        &o["solver"],
        "LOAD solver",
        &[
            "weights",
            "first_step",
            "stepping",
            "water",
            "source_atol",
            "grid_exchange_s",
        ],
    )?;
    // R4-GRID: a required LOAD key, null with no Grid connected.
    let grid_exchange_s =
        match &o["solver"]["grid_exchange_s"] {
            Value::Null => None,
            v => Some(v.as_f64().ok_or_else(|| {
                format!("LOAD solver.grid_exchange_s is a number or null, not {v}")
            })?),
        };
    let solver = Solver {
        weights: Weights::parse(text(&o["solver"], "weights", "LOAD solver")?)?,
        first_step: parse_first_step(text(&o["solver"], "first_step", "LOAD solver")?)?,
        stepping: parse_stepping(text(&o["solver"], "stepping", "LOAD solver")?)?,
        // The water method (owner decision 1 Nov): a required LOAD key, in
        // the identity a restore checks.
        water: leitbild_operating_water::WaterMethod::parse(text(
            &o["solver"],
            "water",
            "LOAD solver",
        )?)?,
        // R4-NUC-SOURCE-ATOL: a required LOAD key, in the identity.
        source_atol: leitbild_operating_water::unit::profile::SourceAtol::parse(text(
            &o["solver"],
            "source_atol",
            "LOAD solver",
        )?)?,
    };
    Ok((
        inputs,
        text(load, "state", "LOAD")?.to_string(),
        solver,
        grid_exchange_s,
    ))
}

impl Unit {
    /// The composed unit of a LOAD request, before its start frame (LOAD)
    /// or its restore (RESTORE).
    fn compose(load: &Value) -> Result<Self, String> {
        let (inputs, state_path, solver, grid_exchange_s) = parse_load(load)?;
        if !matches!(
            solver.first_step,
            leitbild_operating_water::joined::FirstStep::Declared
        ) {
            // A last-step first step reads the BDF history's last step at a
            // restart, which no snapshot holds (it is not rebuilt truth).
            return Err("first_step: only the declared first step has a bitwise copy (a last-step policy reads the discarded BDF history)".into());
        }
        let files = file_identity(load, &inputs, &state_path, solver)?;
        let state = read_json(&state_path)?;
        let elec = read_json(&inputs.elec_path)?;
        let v_nominal = elec["boundary"]["lineVoltage_V"]
            .as_f64()
            .ok_or("the electrical packet's boundary.lineVoltage_V")?;
        // The section's declarations choose the composition; the protection
        // client refuses a governor or DC mismatch either way.
        let live::Composed { unit: u, dc } =
            live::compose(&inputs, &state, s3::Scaling::NONE, solver, &[], Ok)?;
        if u.receipt["from_saved_s3_state"] != json!(true) || u.receipt["spray_path"] != json!(true)
        {
            return Err(format!(
                "the unit starts from a saved S3 state of a packet with the spray path: {}",
                u.receipt
            ));
        }
        // The r4 baseline: stock matrix management (MR-1 off). A host keeps
        // no per-frame record of the rods.
        let (plant, _) = live::plant(
            u,
            &inputs,
            live::Options {
                diagnostic: Diagnostic::None,
                matrix_rebuild: MatrixRebuild::Stock,
                clock: clock::thread_cpu_s,
                rod_records: false,
            },
        )?;
        // R4-FREE-STEPS: the LOAD request's stepping (its solver, part of the
        // identity a restore checks); the plant's driver took it.
        let stepping = solver.stepping;
        let composition = json!({
            "t0": bits(plant.t0), "dimension": plant.y.len(), "operator": plant.n,
            "rtol": bits(plant.rtol), "atol_sha256": sha256(vector_bits(&plant.atol).as_bytes()),
            "derived_rows": plant.derived.rows.len(), "frame_s": bits(plant.frame.period_s()),
            "matrix_rebuild": "stock (r4 baseline: MR-1 off)",
            "stepping": format!("{stepping:?}"),
            "water": solver.water.as_str(),
            "source_atol": solver.source_atol.as_str(),
        });
        let mut identity = files;
        identity["composition"] = composition;
        let channels = channels(&plant, &inputs)?;
        identity["channels_sha256"] = json!(sha256(
            serde_json::to_string(&channels_json(&channels))
                .map_err(|e| e.to_string())?
                .as_bytes()
        ));
        let t = plant.t0;
        let grid_exchange_frames = grid_exchange_s
            .map(|seconds| exchange_frames(seconds, &plant.frame))
            .transpose()?;
        let domain = KineticsDomain::of(&inputs.spine.packet_json()?, &plant)?;
        Ok(Self {
            plant,
            inputs,
            t,
            load: load.clone(),
            identity,
            channels,
            v_nominal,
            dc,
            failed: None,
            ended: None,
            exchanges: 0,
            grid_exchange_frames,
            domain,
        })
    }

    fn load(load: &Value) -> Result<Self, String> {
        let mut unit = Self::compose(load)?;
        let p = &mut unit.plant;
        let q0 = vec![0.; slice::QUADRATURES.len()];
        p.driver.start_quadratures(&mut p.ida, q0)?;
        p.start(&mut [])?;
        unit.arm_exchange()?;
        Ok(unit)
    }

    /// R4-GRID: the armed stop is the next exchange while the breaker is
    /// closed and none otherwise, from `t`, the LOAD and the breaker alone.
    /// Any request boundary may call it: a source and its restored copy hold
    /// the same stop, and how a Run slices its time changes nothing.
    fn arm_exchange(&mut self) -> Result<(), String> {
        let Some(every) = self.grid_exchange_frames else {
            return Ok(());
        };
        let p = &mut self.plant;
        p.driver.clear_declared_stops();
        if p.ida.system().breaker.contact == Contact::Closed {
            p.driver
                .declare_stop(exchange_after(&p.frame, every, self.t))?;
        }
        Ok(())
    }

    /// R4-GRID: the unit stands at an exchange instant, or a refusal by name.
    fn at_exchange(&self, kind: &str, t: f64) -> Result<(), String> {
        let every = self
            .grid_exchange_frames
            .ok_or_else(|| format!("{kind}: this unit was loaded with no Grid exchange"))?;
        if !same_instant(t, self.t) {
            return Err(format!(
                "{kind}: decided at the unit's time {} s, not {t} s",
                self.t
            ));
        }
        if !on_exchange(&self.plant.frame, every, self.t) {
            return Err(format!(
                "{kind}: {} s is not an instant of the exchange grid",
                self.t
            ));
        }
        Ok(())
    }

    fn reply(&self) -> Value {
        json!({"identity": self.identity, "t": self.t, "t_bits": bits(self.t),
            "dimension": self.plant.y.len(), "frame_s": self.plant.frame.period_s(),
            "composition": self.plant.composition, "channels": channels_json(&self.channels),
            "pid": std::process::id()})
    }

    fn usable(&self) -> Result<(), String> {
        match &self.failed {
            Some(cause) => Err(format!("the unit fail-stopped: {cause}")),
            None => Ok(()),
        }
    }

    /// R4-ENDED: ADVANCE and COMMAND past a named domain end, refused by
    /// name; SNAPSHOT, STATUS and CHANNELS keep working.
    fn running(&self) -> Result<(), String> {
        self.usable()?;
        match &self.ended {
            Some(end) => Err(format!(
                "the unit ended at {} s: {}, {}",
                end.t,
                end.end.label(),
                end.cause
            )),
            None => Ok(()),
        }
    }

    /// Stock counters so far (closed segments and the open one) and the
    /// driver's R/S instants and frames. An open segment that has taken no
    /// step yet counts nothing: stock IDALS restarts its Jacobian and setup
    /// counters only at the first solve after IDAReInit, so until then they
    /// still hold the closed segment's, which the driver's totals carry.
    fn counters(&self) -> Result<[u64; 8], String> {
        let s = self.plant.ida.stats()?;
        let open = |x: i64| if s.steps == 0 { 0 } else { x };
        let t = &self.plant.driver.totals;
        let c = &self.plant.driver.counts;
        let u = |x: i64| u64::try_from(x).map_err(|_| "a negative stock counter".to_string());
        Ok([
            u(t[0] + open(s.steps))?,
            u(t[1] + open(s.residuals))?,
            u(t[2] + open(s.jacobians))?,
            u(t[4] + open(s.error_failures))?,
            u(t[5] + open(s.convergence_failures))?,
            c.total(Class::R),
            c.total(Class::S),
            c.get(Class::O, "frame"),
        ])
    }

    fn values(&mut self) -> Result<Vec<f64>, String> {
        let t = self.t;
        let q = self.plant.driver.quadratures_at(&self.plant.ida, t)?;
        let Plant {
            ida,
            y,
            yp,
            n,
            protection,
            control,
            field,
            rods,
            ..
        } = &mut self.plant;
        let n = *n;
        let unit = ida.system_mut();
        let joined = &mut unit.integrated_mut().joined;
        joined
            .evaluate(t, &y[..n], &yp[..n], None, 0., None)
            .map_err(|e| format!("the observation's evaluation at {t} s: {e:?}"))?;
        let taps = joined
            .network
            .pzr_taps()
            .map_err(|e| format!("PZR taps: {e:?}"))?;
        let released = joined.heats().nuclear.released_w.value;
        let unit = ida.system();
        let net = &unit.integrated().joined.network;
        let p = &protection.protection;
        let delivered = p.delivered();
        let reports = p.delivered_reports();
        let divisions = &p.divisions;
        let flag = |b: bool| f64::from(u8::from(b));
        let engineering = protection.engineering_values(t)?;
        self.channels
            .iter()
            .map(|c| {
                Ok(match &c.read {
                    Reading::Time => t,
                    Reading::IcValue(k) => match delivered[*k].1 {
                        None => f64::NAN,
                        Some((_, Quality::Value(v)))
                        | Some((_, Quality::BelowRange(v)))
                        | Some((_, Quality::AboveRange(v)))
                        | Some((_, Quality::Indeterminate(v))) => v,
                    },
                    Reading::IcQuality(k) => match delivered[*k].1 {
                        None => 0.,
                        Some((_, Quality::Value(_))) => 1.,
                        Some((_, Quality::BelowRange(_))) => 2.,
                        Some((_, Quality::AboveRange(_))) => 3.,
                        Some((_, Quality::Indeterminate(_))) => 4.,
                    },
                    Reading::IcReport(i) => match reports[*i].1 {
                        None => f64::NAN,
                        Some((_, v)) => flag(v),
                    },
                    Reading::Engineering(id) => match engineering.get(id) {
                        Some(Value::Null) => f64::NAN,
                        Some(v) => v
                            .as_f64()
                            .ok_or_else(|| format!("{id}: {v} is not a number"))?,
                        None => return Err(format!("no engineering value {id}")),
                    },
                    Reading::IcReportQuality(i) => flag(reports[*i].1.is_some()),
                    Reading::ReliefIsolationPosition => {
                        100. * unit.integrated().joined.pzr().isolation_position(t)
                    }
                    Reading::ReliefLiftOpen => {
                        flag(y[unit.integrated().joined.offsets().pzr] != 0.)
                    }
                    Reading::BankHold => flag(rods.as_ref().is_some_and(|r| r.hold)),
                    Reading::RodLaw(i) => rods
                        .as_ref()
                        .ok_or("no AUTO rod control")?
                        .tavg_and_reference_k()[*i],
                    Reading::RodError => {
                        let r = rods.as_ref().ok_or("no AUTO rod control")?;
                        if r.decided_m_s.is_none() {
                            f64::NAN
                        } else {
                            // Controller::frame's own terms and order: the
                            // temperature part, then the mismatch on its
                            // rate-lag state after the frame.
                            let [tavg, tref] = r.tavg_and_reference_k();
                            let [lag, input, _] = r.controller.state();
                            let gain = r.controller.law().section().mismatch_gain_k;
                            (tavg - tref) + gain * (input - lag)
                        }
                    }
                    Reading::Latched(f) => divisions.iter().filter(|d| d.latched(f)).count() as f64,
                    Reading::DivisionTrip(d) => flag(divisions[*d].trip.is_some()),
                    Reading::DivisionPowered(d) => flag(divisions[*d].powered),
                    Reading::ContactClosed(c) => flag(p.holding.contacts[*c].closed()),
                    Reading::HoldingAvailable => flag(p.holding.voltage_available()),
                    Reading::Request(r) => divisions
                        .iter()
                        .filter(|d| d.requests.iter().any(|x| x["request"] == *r))
                        .count() as f64,
                    Reading::FieldInitiated => flag(
                        field
                            .as_ref()
                            .ok_or("no field controller")?
                            .protection
                            .initiated
                            .is_some(),
                    ),
                    Reading::ReleasedPower => released,
                    Reading::PzrPressure => taps.pt1_pa.value,
                    Reading::PzrCollapsedLevel => taps.collapsed_level_m.value,
                    Reading::PzrMixtureLevel => taps.mixture_level_m.value,
                    Reading::FaceFlow(face) => (0..2)
                        .filter_map(|phase| net.chart(*face, phase))
                        .map(|c| c.mass_flow_kg_s.value)
                        .sum(),
                    Reading::Coordinate(i, factor) => y[*i] * factor,
                    Reading::Coordinates(terms) => terms.iter().map(|(i, f)| y[*i] * f).sum(),
                    Reading::CellTemperature(cells) => {
                        let (mut weighted, mut mass) = (0., 0.);
                        for c in cells {
                            let (temperature, m) = cell_temperature(net, y, *c)?;
                            weighted += m * temperature;
                            mass += m;
                        }
                        weighted / mass
                    }
                    Reading::HeaterRequest => control.in_force_w,
                    Reading::TerminalPower => unit.slice.export_w(&y[n..]),
                    Reading::ShaftSpeed => y[n + slice::OMEGA],
                    Reading::BreakerClosed => flag(unit.breaker.contact == Contact::Closed),
                    Reading::OffsiteLost => flag(unit.offsite_loss_s.is_some_and(|l| l <= t)),
                    Reading::ExportEnergy => q[EXPORT],
                    Reading::GridFrequency => unit.slice.inputs.f_grid_hz,
                    Reading::GridVoltage => unit.slice.inputs.v_line / self.v_nominal,
                    Reading::NetExport => {
                        let i = unit.slice.inputs;
                        unit.slice.export_w(&y[n..]) - i.unit_draw_w - i.reserve_draw_w
                    }
                    Reading::LoadRequest => unit.governor.as_ref().ok_or("no governor")?.held.to_w,
                    Reading::LoadActive => {
                        let g = unit.governor.as_ref().ok_or("no governor")?;
                        flag(g.held.mode == Mode::Load)
                    }
                })
            })
            .collect()
    }

    /// Drop every log line so far (driver, protection, field controller and
    /// slice logs): the next frame reports only its own exchange (a copy
    /// point's and a restore's restart belong to no exchange, so a source and
    /// its copy report alike). R4-MEM: a reported line is read again by
    /// nothing, so the host keeps none (a live unit's logs grew without
    /// bound, one class-S line per Grid exchange). R4-MEM2: nor does it keep
    /// the harness-only records that grow per restart or event: the driver's
    /// closed segments (a no-op restart takes back only the one it closed in
    /// the same call) and donor flips (detection reads the last signs, the
    /// count the per-path tallies), the routing's and the DC groups' records.
    fn mark_seen(&mut self) -> Result<(), String> {
        let p = &mut self.plant;
        let field = p.field.as_mut().ok_or("no field controller")?;
        field.protection.log.clear();
        p.driver.log.clear();
        p.driver.segments.clear();
        p.driver.donor_flips.events.clear();
        p.protection.protection.log.clear();
        let unit = p.ida.system_mut();
        unit.log.clear();
        unit.routing.records.clear();
        if let Some(dc) = unit.dc.as_mut() {
            dc.records.clear();
        }
        Ok(())
    }

    /// The events since the last frame: the four logs whole, then dropped.
    fn events(&mut self) -> Result<Value, String> {
        let p = &self.plant;
        let log = &p.driver.log[..];
        let tl = timeline::Timeline::from_logs(log, &[], None, 0., self.t)?;
        let protection = &p.protection.protection.log[..];
        let field = &p
            .field
            .as_ref()
            .ok_or("no field controller")?
            .protection
            .log[..];
        let electrical = &p.ida.system().log[..];
        let empty =
            log.is_empty() && protection.is_empty() && field.is_empty() && electrical.is_empty();
        let events = if empty {
            Value::Null
        } else {
            json!({
                "instants": tl.instants.iter().map(|(t, c, k)| json!([t, c, k])).collect::<Vec<_>>(),
                "seats": tl.seats.iter().map(|(c, t)| json!([c, t])).collect::<Vec<_>>(),
                "sg_relief": tl.sg_relief.iter().map(|(v, th, d, t)| json!([v, th, d, t])).collect::<Vec<_>>(),
                "pzr_relief_openings": tl.pzr_relief_openings,
                "stop_ramp_end": tl.stop_ramp_end,
                "protection": protection,
                "field": field,
                "electrical": electrical.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>(),
            })
        };
        self.mark_seen()?;
        Ok(events)
    }

    fn advance(&mut self, t1: f64, out: &mut Vec<u8>) -> Result<(), String> {
        if !(t1.is_finite() && t1 > self.t && !same_instant(t1, self.t)) {
            return Err(format!(
                "ADVANCE to {t1} s is not after the unit's {} s",
                self.t
            ));
        }
        // R4-GRID: an armed exchange is the end of an ADVANCE, never inside one.
        if let Some(every) = self.grid_exchange_frames
            && self.plant.ida.system().breaker.contact == Contact::Closed
        {
            let exchange = exchange_after(&self.plant.frame, every, self.t);
            if t1 > exchange && !same_instant(t1, exchange) {
                return Err(format!(
                    "ADVANCE to {t1} s crosses the Grid exchange at {exchange} s"
                ));
            }
        }
        let before = self.counters()?;
        // R4-FLOOR-UNIT: the kinetics domain judged on the accepted states;
        // its exit is a driver error, so a failure below, never a named end.
        let reached = self.plant.run(self.t, t1, &mut [], Some(&mut self.domain));
        let reached = match reached {
            Ok(plant_reached) => plant_reached,
            Err(e) => match self.named_end(&e) {
                // R4-ENDED: the run holds its last accepted step; the
                // exchange reports it and names the end.
                Some(end) => {
                    let Plant { driver, y, yp, .. } = &mut self.plant;
                    let t = driver.stand_at_accepted(y, yp);
                    self.ended = Some(Ended { end, t, cause: e });
                    leitbild_operating_water::frame::Reached::Until(t)
                }
                None => {
                    let cause = format!(
                        "ADVANCE from {} s to {t1} s (a discrete change attempted at {:?} s, the solver at {} s): {e}",
                        self.t, self.plant.driver.attempt_s, self.plant.driver.solver_reached_s
                    );
                    self.failed = Some(cause.clone());
                    return Err(cause);
                }
            },
        };
        let leitbild_operating_water::frame::Reached::Until(t) = reached;
        self.t = t;
        self.exchanges += 1;
        if self.ended.is_none() {
            self.arm_exchange()?;
        }
        let after = self.counters()?;
        let values = self.values()?;
        let mut events = self.events()?;
        if let Some(end) = &self.ended {
            if events.is_null() {
                events = json!({});
            }
            events["ended"] = json!({"label": end.end.label(), "plain": end.end.plain(), "t": end.t, "cause": end.cause});
        }
        out.extend_from_slice(&t.to_le_bytes());
        out.extend_from_slice(&self.plant.driver.solver_reached_s.to_le_bytes());
        out.extend_from_slice(&(COUNTS.len() as u32).to_le_bytes());
        for ((a, b), name) in after.iter().zip(before).zip(COUNTS) {
            let delta = a
                .checked_sub(b)
                .ok_or_else(|| format!("the {name} count went back over the exchange"))?;
            out.extend_from_slice(&delta.to_le_bytes());
        }
        out.extend_from_slice(&(values.len() as u32).to_le_bytes());
        for v in values {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let events = if events.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(&events).map_err(|e| e.to_string())?
        };
        out.extend_from_slice(&(events.len() as u32).to_le_bytes());
        out.extend_from_slice(&events);
        Ok(())
    }

    /// R4-ENDED: the named end of a stop with this cause, from the last
    /// accepted state, or `None`: a failure.
    fn named_end(&self, cause: &str) -> Option<DomainEnd> {
        let p = &self.plant;
        let yp = p.driver.accepted_rates().unwrap_or(&p.yp);
        p.ida.system().integrated().joined.named_end(
            cause,
            p.driver.integrator_s(),
            p.driver.frame_period_s(),
            yp,
        )
    }

    fn command(&mut self, v: &Value) -> Result<Value, String> {
        let kind = text(v, "kind", "a command")?;
        let t = v["t_apply"]
            .as_f64()
            .ok_or_else(|| format!("{kind} needs t_apply (s)"))?;
        if !(t.is_finite() && (t >= self.t || same_instant(t, self.t))) {
            return Err(format!(
                "{kind} at {t} s is not prospective: the unit stands at {} s",
                self.t
            ));
        }
        if kind == "GridBoundary" {
            return self.grid_boundary(v, t);
        }
        if kind == "BankHold" || kind == "BankAuto" {
            return self.bank(v, kind, t);
        }
        if kind == "LoadRequest" {
            return self.load_request(v, t);
        }
        if let Some(operator) = operator_of(v, kind) {
            return self.operator(kind, operator?, t);
        }
        let command = command_of(v)?;
        let keys: &[&str] = match command {
            Command::SupplyLoss { rotor } => {
                let rotors = self
                    .plant
                    .ida
                    .system()
                    .integrated()
                    .joined
                    .network
                    .rotor_count();
                if rotor >= rotors {
                    return Err(format!("SupplyLoss: rotor {rotor} of {rotors}"));
                }
                &["kind", "t_apply", "rotor"]
            }
            _ => &["kind", "t_apply"],
        };
        exactly(v, kind, keys)?;
        let t = t.max(self.t);
        self.plant.driver.command(t, command)?;
        Ok(json!({"kind": kind, "t_apply": t, "t_apply_bits": bits(t)}))
    }

    /// PROC T4, T5, T11: an operator's local electrical command, decided and
    /// applied at the unit's time, class R. A name the unit does not hold is
    /// refused here, before anything changes.
    fn operator(&mut self, kind: &str, operator: Operator, t: f64) -> Result<Value, String> {
        if !same_instant(t, self.t) {
            return Err(format!(
                "{kind}: decided at the unit's time {} s, not {t} s",
                self.t
            ));
        }
        let routing = &self.plant.ida.system().routing;
        let group_of = |group: &str| -> Result<&_, String> {
            self.dc
                .as_ref()
                .ok_or_else(|| format!("{kind}: no DC groups composed"))?
                .groups
                .iter()
                .find(|g| g.id == group)
                .ok_or_else(|| format!("{kind}: no DC group {group}"))
        };
        match &operator {
            Operator::Incoming { bus, .. } => {
                routing
                    .bus_index(bus)
                    .ok_or_else(|| format!("{kind}: no bus {bus}"))?;
            }
            Operator::Start { consumer } => {
                routing
                    .support(consumer)
                    .ok_or_else(|| format!("{kind}: no consumer {consumer}"))?;
            }
            Operator::ReliefIsolation { .. } => {
                let joined = &self.plant.ida.system().integrated().joined;
                if joined.pzr().isolation_block().is_none() {
                    return Err(format!("{kind}: the packet composes no relief isolation"));
                }
                if self.dc.is_none() {
                    return Err(format!("{kind}: no DC groups composed"));
                }
            }
            Operator::Dc { group, .. } => {
                group_of(group)?;
            }
            Operator::Charger { group, bus } => {
                let g = group_of(group)?;
                let alternate = g
                    .alternate_bus
                    .as_ref()
                    .ok_or_else(|| format!("{kind}: {group} has no selectable charger input"))?;
                if *bus != g.normal_bus && bus != alternate {
                    return Err(format!("{kind}: {group} cannot charge from {bus}"));
                }
            }
        }
        let outcome = Rc::new(Cell::new(None));
        let result = Rc::clone(&outcome);
        let due_s = self.t;
        let change = Change {
            due_s,
            class: Class::R,
            kind: format!("operator: {kind}"),
            action: Action::Held(Box::new(move |u: &mut Electrified<Integrated<If97>>| {
                let done = match &operator {
                    Operator::Incoming {
                        bus,
                        source,
                        target,
                    } => u.operator_incoming(due_s, bus, *source, *target),
                    Operator::Start { consumer } => u.operator_start_consumer(due_s, consumer),
                    Operator::Dc { group, command } => u.operator_dc(due_s, group, *command),
                    Operator::Charger { group, bus } => {
                        u.operator_dc_charger_input(due_s, group, bus)
                    }
                    Operator::ReliefIsolation { close } => {
                        u.operator_relief_isolation(due_s, *close)
                    }
                }?;
                result.set(Some(done));
                Ok(())
            })),
        };
        let applied = self
            .plant
            .driver
            .decide(vec![change])
            .and_then(|()| self.plant.apply_due(&mut []));
        if let Err(e) = applied {
            let cause = format!("{kind} at {} s: {e}", self.t);
            self.failed = Some(cause.clone());
            return Err(cause);
        }
        let accepted = outcome
            .get()
            .ok_or_else(|| format!("{kind}: the held change did not run"))?;
        Ok(
            json!({"kind": kind, "t_apply": self.t, "t_apply_bits": bits(self.t), "accepted": accepted}),
        )
    }

    /// The operator's bank HOLD or its release to AUTO, at the unit's time,
    /// acting at the next frame (the client's own rule). With the drive
    /// disengaged or the request already in force it is a result, not a
    /// refusal; a unit composing no rod control refuses by name.
    fn bank(&mut self, v: &Value, kind: &str, t: f64) -> Result<Value, String> {
        exactly(v, kind, &["kind", "t_apply"])?;
        if !same_instant(t, self.t) {
            return Err(format!(
                "{kind}: decided at the unit's time {} s, not {t} s",
                self.t
            ));
        }
        let hold = kind == "BankHold";
        let rods = self
            .plant
            .rods
            .as_mut()
            .ok_or_else(|| format!("{kind}: the section declares no rod control"))?;
        let accepted = rods.engaged && rods.hold != hold;
        if accepted {
            rods.set_hold(hold);
        }
        let why = match (accepted, rods.engaged) {
            (true, _) => "accepted",
            (false, false) => "refused: the drive is not engaged",
            (false, true) => "refused: already in force",
        };
        self.plant
            .ida
            .system_mut()
            .log
            .push((self.t, format!("operator LD01.CORE.BANK {kind}: {why}")));
        Ok(
            json!({"kind": kind, "t_apply": self.t, "t_apply_bits": bits(self.t), "accepted": accepted}),
        )
    }

    /// R4-GRID: the plant-side load request, at an exchange instant, through
    /// the unit library (`turbine::grid_request`), class S. With the governor
    /// out of LOAD (after a turbine trip) it is a result, not a refusal: the
    /// reply says `accepted: false`, the electrical log records why, and the
    /// unit goes on, like an operator command its equipment's guards refuse.
    fn load_request(&mut self, v: &Value, t: f64) -> Result<Value, String> {
        exactly(v, "LoadRequest", &["kind", "t_apply", "request_w"])?;
        self.at_exchange("LoadRequest", t)?;
        let request_w = v["request_w"]
            .as_f64()
            .filter(|w| w.is_finite() && *w >= 0.)
            .ok_or_else(|| {
                format!(
                    "LoadRequest needs a finite request_w >= 0, not {}",
                    v["request_w"]
                )
            })?;
        let at = self.t;
        let p = &mut self.plant;
        let governor = p
            .ida
            .system()
            .governor
            .as_ref()
            .ok_or("LoadRequest: no governor composed")?;
        if governor.held.mode != Mode::Load {
            p.ida.system_mut().log.push((
                at,
                format!("load request {request_w} W refused: the governor is not in LOAD"),
            ));
            return Ok(
                json!({"kind": "LoadRequest", "t_apply": at, "t_apply_bits": bits(at), "accepted": false}),
            );
        }
        let decided = turbine::grid_request(&mut p.driver, p.ida.system(), at, request_w)?;
        if let Err(e) = self.plant.apply_due(&mut []) {
            let cause = format!("LoadRequest at {at} s: {e}");
            self.failed = Some(cause.clone());
            return Err(cause);
        }
        Ok(
            json!({"kind": "LoadRequest", "t_apply": at, "t_apply_bits": bits(at), "accepted": true, "decided": decided}),
        )
    }

    /// The Grid's boundary for `[t, until)` through the unit library
    /// (`plant::boundary`), decided at an exchange instant and applied now,
    /// `until` the next one. With the breaker open a changed boundary is no
    /// event: the relative angle alone still reads it, and an angle to a bus
    /// the machine has left means nothing. A dead bus goes through, once.
    fn grid_boundary(&mut self, v: &Value, t: f64) -> Result<Value, String> {
        exactly(
            v,
            "GridBoundary",
            &[
                "kind",
                "t_apply",
                "until",
                "energized",
                "voltage_pu",
                "frequency_hz",
                "phase_error_rad",
                "frequency_rate_hz_s",
            ],
        )?;
        self.at_exchange("GridBoundary", t)?;
        let number = |k: &str| {
            v[k].as_f64()
                .ok_or_else(|| format!("GridBoundary needs the number {k}"))
        };
        let until = number("until")?;
        let every = self
            .grid_exchange_frames
            .ok_or("GridBoundary: no exchange")?;
        let next = exchange_after(&self.plant.frame, every, self.t);
        if !same_instant(until, next) {
            return Err(format!(
                "GridBoundary: until {until} s is not the next exchange, {next} s"
            ));
        }
        let boundary = match v["energized"].as_bool() {
            Some(true) => Boundary::Energized {
                voltage_v: self.v_nominal * number("voltage_pu")?,
                voltage_pu: number("voltage_pu")?,
                frequency_hz: number("frequency_hz")?,
                phase_error_rad: number("phase_error_rad")?,
                frequency_rate_hz_s: number("frequency_rate_hz_s")?,
            },
            Some(false) => Boundary::Dead,
            None => return Err("GridBoundary needs the boolean energized".into()),
        };
        let decided = self.plant.boundary(self.t, until, boundary)?;
        if let Err(e) = self.plant.apply_due(&mut []) {
            let cause = format!("GridBoundary at {} s: {e}", self.t);
            self.failed = Some(cause.clone());
            return Err(cause);
        }
        Ok(
            json!({"kind": "GridBoundary", "t_apply": self.t, "t_apply_bits": bits(self.t), "decided": decided}),
        )
    }

    fn snapshot(&mut self) -> Result<Value, String> {
        let t = self.t;
        let p = &self.plant;
        // R4-FREE-STEPS: under free stepping the integrator may stand past
        // the unit's time within its last step; the snapshot is then that
        // step's dense output at t (the plant's y, y'), and the source's
        // restart in place below starts from exactly those bits.
        let integrator = p.driver.integrator_s();
        let behind_ok = p.driver.stepping == Stepping::Free && integrator > t;
        if integrator != t && !behind_ok {
            return Err(format!(
                "the integrator stands at {integrator} s, not at the unit's {t} s"
            ));
        }
        let driver = p.driver.state(&p.ida)?;
        if let Some(due) = driver
            .commands
            .iter()
            .map(|c| c.0)
            .chain(driver.pending.iter().map(|c| c.0))
            .find(|d| *d <= t || same_instant(*d, t))
        {
            return Err(format!(
                "a change is due at {due} s, the unit's time: ADVANCE applies it before a snapshot"
            ));
        }
        let snapshot = json!({
            "format": FORMAT,
            "identity": self.identity,
            "load": self.load,
            "t": bits(t),
            "y": vector_bits(&p.y),
            "yp": vector_bits(&p.yp),
            "integrator_atol": vector_bits(p.ida.absolute_tolerances()),
            "discrete_state": p.ida.system().system_discrete_state(),
            "clients": {
                "protection": p.protection.protection.snapshot()?,
                "pzr_control": p.control.snapshot()?,
                "field": p.field.as_ref().ok_or("no field controller")?.snapshot(),
                "rod_control": p.rods.as_ref().map(rod_control::RodClient::snapshot),
            },
            "driver": driver_json(&driver),
        });
        // R4-ENDED: an ended unit runs no further, so no restart in place.
        if self.ended.is_some() {
            self.mark_seen()?;
            return Ok(snapshot);
        }
        // Design §6.1: the copy point is a restart boundary for the source
        // too (the same exact consistent restart a restore makes), so it
        // starts on no kept matrix, as a restore does not.
        self.plant
            .ida
            .system_mut()
            .integrated_mut()
            .forget_kept_matrices();
        let restart = Change {
            due_s: t,
            class: Class::R,
            kind: "copy point: restart in place (design 6.1)".into(),
            action: Action::Held(Box::new(|_| Ok(()))),
        };
        let restarted = self
            .plant
            .driver
            .decide(vec![restart])
            .and_then(|()| self.plant.apply_due(&mut []));
        if let Err(e) = restarted {
            let cause = format!("the copy point's restart at {t} s: {e}");
            self.failed = Some(cause.clone());
            return Err(cause);
        }
        self.arm_exchange()?;
        self.mark_seen()?;
        Ok(snapshot)
    }

    fn restore(snapshot: &Value) -> Result<Self, String> {
        let o = exactly(
            snapshot,
            "snapshot",
            &[
                "format",
                "identity",
                "load",
                "t",
                "y",
                "yp",
                "integrator_atol",
                "discrete_state",
                "clients",
                "driver",
            ],
        )?;
        if o["format"] != FORMAT {
            return Err(format!("not an {FORMAT}: {}", o["format"]));
        }
        // The input files first (cheap), then the composition's identity.
        let (inputs, state, solver, _) = parse_load(&o["load"])?;
        let mut files = file_identity(&o["load"], &inputs, &state, solver)?;
        for (k, v) in o["identity"].as_object().ok_or("snapshot identity")? {
            if k != "composition" && k != "channels_sha256" && files.get(k) != Some(v) {
                return Err(format!(
                    "identity {k} differs: snapshot {v}, this unit {}",
                    files.get(k).unwrap_or(&Value::Null)
                ));
            }
        }
        let mut unit = Self::compose(&o["load"])?;
        files = unit.identity.clone();
        if files != o["identity"] {
            return Err(format!(
                "the composed identity differs: snapshot {}, this unit {files}",
                o["identity"]
            ));
        }
        let t = real(&o["t"], "snapshot t")?;
        let dimension = unit.plant.y.len();
        let y = vector(&o["y"], dimension, "snapshot y")?;
        let yp = vector(&o["yp"], dimension, "snapshot yp")?;
        let atol = vector(&o["integrator_atol"], dimension, "snapshot integrator atol")?;
        let clients = exactly(
            &o["clients"],
            "snapshot clients",
            &["protection", "pzr_control", "field", "rod_control"],
        )?;
        let driver = driver_state(&o["driver"])?;
        if driver.observed_to.to_bits() != t.to_bits() {
            return Err("the snapshot's driver stands at another time".into());
        }
        let p = &mut unit.plant;
        p.ida
            .system_mut()
            .restore_system_discrete_state(&o["discrete_state"])?;
        p.protection.protection.restore(&clients["protection"])?;
        // PHYS's frame hook (plan r4 X4.2): the restored owners' discrete
        // state (CVCS modes, the latched TRIP, the seated chain) into the
        // protection client's live readings, as the source's last restart
        // left them; without it the copy reads the composed modes until its
        // next restart and is not bitwise.
        Client::restarted(&mut p.protection, t, p.ida.system())?;
        p.control.restore(&clients["pzr_control"])?;
        p.field
            .as_mut()
            .ok_or("no field controller")?
            .restore(&clients["field"])?;
        match (p.rods.as_mut(), &clients["rod_control"]) {
            (Some(rods), v) if !v.is_null() => rods.restore(v)?,
            (None, Value::Null) => {}
            (rods, v) => {
                return Err(format!(
                    "the snapshot's rod control {v} against a unit composing {}",
                    if rods.is_some() { "it" } else { "none" }
                ));
            }
        }
        // The integrator's tolerances and nonnegative stocks as the source
        // holds them (a phase-mode restart retunes both), then the source's
        // exact consistent restart at t.
        p.ida.set_tolerances(p.rtol, &atol)?;
        let nonnegative = p
            .ida
            .system()
            .integrated()
            .joined
            .network
            .nonnegative_stocks();
        p.ida.constrain_nonnegative(&nonnegative)?;
        p.y = y;
        p.yp = yp;
        p.ida.system_mut().integrated_mut().forget_kept_matrices();
        let restarted = discrete_restart(
            &mut p.ida,
            t,
            Discrete::TimeEvent,
            &mut p.y,
            &p.network_ids,
            &p.atol,
            p.rtol,
            &p.restart,
        )?;
        p.yp.clone_from(&restarted.yp);
        p.driver.restore_state(&mut p.ida, driver)?;
        unit.t = t;
        unit.arm_exchange()?;
        unit.mark_seen()?;
        Ok(unit)
    }

    fn status(&self) -> Result<Value, String> {
        let counters = self.counters()?;
        let cpu = &self.plant.driver.cpu;
        Ok(
            json!({"t": self.t, "t_bits": bits(self.t), "integrator_t_bits": bits(self.plant.driver.integrator_s()), "failed": self.failed, "ended": self.ended.as_ref().map(|e| json!({"label": e.end.label(), "t": e.t, "cause": e.cause})), "exchanges": self.exchanges,
            "counts": COUNTS.iter().zip(counters).map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<_, _>>(),
            "stock_counter_names": COUNTER_NAMES,
            "counts_by_class": self.plant.driver.counts.json(),
            "cpu": {"solver_s": cpu.solver_s, "observation_s": cpu.observation_s, "restart_s": cpu.restart_s,
                "held_s": cpu.held_s, "worst_step": [cpu.worst_step.0, cpu.worst_step.1],
                "thread_s": clock::thread_cpu_s(), "process_s": clock::process_cpu_s()},
            "pid": std::process::id(), "ic_section": self.inputs.ic_path}),
        )
    }
}

fn driver_json(s: &DriverState) -> Value {
    json!({
        "next_frame": s.next_frame,
        "observed_to": bits(s.observed_to),
        "commands": s.commands.iter().map(|(t, c)| json!([bits(*t), command_value(*c)])).collect::<Vec<_>>(),
        "pending": s.pending.iter().map(|(t, class, kind, c)| json!([bits(*t), class.name(), kind, command_value(*c)])).collect::<Vec<_>>(),
        "quadratures": s.quadratures.as_ref().map(|q| vector_bits(q)),
    })
}

fn driver_state(v: &Value) -> Result<DriverState, String> {
    let o = exactly(
        v,
        "snapshot driver",
        &[
            "next_frame",
            "observed_to",
            "commands",
            "pending",
            "quadratures",
        ],
    )?;
    let array = |k: &str| {
        o[k].as_array()
            .ok_or_else(|| format!("snapshot driver {k} is not an array"))
    };
    let commands = array("commands")?
        .iter()
        .map(|c| match c.as_array().map(Vec::as_slice) {
            Some([t, command]) => Ok((real(t, "a command's time")?, command_of(command)?)),
            _ => Err(format!("a snapshot command is [time, command], not {c}")),
        })
        .collect::<Result<Vec<_>, String>>()?;
    let pending = array("pending")?
        .iter()
        .map(|c| match c.as_array().map(Vec::as_slice) {
            Some([t, Value::String(class), Value::String(kind), command]) => {
                let class = match class.as_str() {
                    "R" => Class::R,
                    "S" => Class::S,
                    other => return Err(format!("a pending change of class {other}")),
                };
                Ok((
                    real(t, "a pending change's time")?,
                    class,
                    kind.clone(),
                    command_of(command)?,
                ))
            }
            _ => Err(format!(
                "a pending change is [time, class, kind, command], not {c}"
            )),
        })
        .collect::<Result<Vec<_>, String>>()?;
    let quadratures = match &o["quadratures"] {
        Value::Null => None,
        q => Some(vector(
            q,
            q.as_str().map_or(0, |s| s.len() / 16),
            "snapshot quadratures",
        )?),
    };
    Ok(DriverState {
        next_frame: o["next_frame"]
            .as_u64()
            .ok_or("snapshot driver next_frame")?,
        observed_to: real(&o["observed_to"], "snapshot driver time")?,
        commands,
        pending,
        quadratures,
    })
}

// ------------------------------------------------------------------ protocol

fn json_reply(v: &Value, out: &mut Vec<u8>) -> Result<(), String> {
    out.extend_from_slice(&serde_json::to_vec(v).map_err(|e| e.to_string())?);
    Ok(())
}

/// One request; `Ok(true)` closes the host.
fn handle(
    unit: &mut Option<Unit>,
    op: u8,
    payload: &[u8],
    out: &mut Vec<u8>,
) -> Result<bool, String> {
    let parsed = |what: &str| -> Result<Value, String> {
        serde_json::from_slice(payload).map_err(|e| format!("{what} JSON: {e}"))
    };
    let loaded = |unit: &mut Option<Unit>| -> Result<(), String> {
        match unit {
            Some(_) => Err("a unit is loaded: one unit per process (LOAD or RESTORE once)".into()),
            None => Ok(()),
        }
    };
    match op {
        LOAD => {
            loaded(unit)?;
            let u = Unit::load(&parsed("LOAD")?)?;
            json_reply(&u.reply(), out)?;
            *unit = Some(u);
        }
        RESTORE => {
            loaded(unit)?;
            let u = Unit::restore(&parsed("RESTORE")?)?;
            json_reply(&u.reply(), out)?;
            *unit = Some(u);
        }
        CHANNELS => {
            let u = unit.as_ref().ok_or("no unit is loaded")?;
            json_reply(&channels_json(&u.channels), out)?;
        }
        ADVANCE => {
            let u = unit.as_mut().ok_or("no unit is loaded")?;
            u.running()?;
            let t1 = match payload {
                [a, b, c, d, e, f, g, h] => f64::from_le_bytes([*a, *b, *c, *d, *e, *f, *g, *h]),
                _ => {
                    return Err(format!(
                        "ADVANCE takes one f64, not {} bytes",
                        payload.len()
                    ));
                }
            };
            u.advance(t1, out)?;
        }
        COMMAND => {
            let u = unit.as_mut().ok_or("no unit is loaded")?;
            u.running()?;
            let reply = u.command(&parsed("COMMAND")?)?;
            json_reply(&reply, out)?;
        }
        SNAPSHOT => {
            let u = unit.as_mut().ok_or("no unit is loaded")?;
            u.usable()?;
            if !payload.is_empty() {
                return Err("SNAPSHOT takes no payload".into());
            }
            let s = u.snapshot()?;
            json_reply(&s, out)?;
        }
        STATUS => {
            let status = match unit {
                Some(u) => u.status()?,
                None => {
                    json!({"t": null, "pid": std::process::id(), "process_s": clock::process_cpu_s()})
                }
            };
            json_reply(&status, out)?;
        }
        CLOSE => return Ok(true),
        other => return Err(format!("unknown op {other}")),
    }
    Ok(false)
}

fn write_frame(
    w: &mut impl Write,
    status: u8,
    seq: u32,
    wall: f64,
    cpu: f64,
    payload: &[u8],
) -> std::io::Result<()> {
    let length = u32::try_from(21 + payload.len())
        .map_err(|_| std::io::Error::other("a reply above 4 GiB"))?;
    w.write_all(&length.to_le_bytes())?;
    w.write_all(&[status])?;
    w.write_all(&seq.to_le_bytes())?;
    w.write_all(&wall.to_le_bytes())?;
    w.write_all(&cpu.to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

fn fatal(message: &str) -> ! {
    eprintln!("ld01-unit: {message}");
    std::process::exit(2)
}

fn main() {
    // R4-UNIT-STDERR: stdout is the protocol channel. SUNDIALS 7.5.0 builds
    // every SUNContext's logger from the environment (`SUNLogger_CreateFromEnv`
    // in `SUNContext_Create`), with warnings to stdout and errors to stderr by
    // default; IDA's warnings go to that logger. Both name stderr here, before
    // any context exists, so every context of the process logs there. Nothing
    // is suppressed.
    // SAFETY: the first statement of `main`; no other thread exists yet.
    unsafe {
        std::env::set_var("SUNLOGGER_WARNING_FILENAME", "stderr");
        std::env::set_var("SUNLOGGER_ERROR_FILENAME", "stderr");
    }
    let mut unit: Option<Unit> = None;
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut output = BufWriter::new(std::io::stdout().lock());
    let mut header = [0u8; 4];
    loop {
        if let Err(e) = input.read_exact(&mut header) {
            fatal(&format!("stdin closed or unreadable without CLOSE: {e}"));
        }
        let length = u32::from_le_bytes(header) as usize;
        if length < 5 {
            fatal(&format!(
                "a request frame of {length} bytes holds no op and sequence"
            ));
        }
        let mut body = vec![0u8; length];
        if let Err(e) = input.read_exact(&mut body) {
            fatal(&format!("a truncated request frame: {e}"));
        }
        let op = body[0];
        let seq = u32::from_le_bytes([body[1], body[2], body[3], body[4]]);
        let (c0, w0) = (clock::thread_cpu_s(), Instant::now());
        let mut data = Vec::new();
        let outcome = handle(&mut unit, op, &body[5..], &mut data);
        let (wall, cpu) = (w0.elapsed().as_secs_f64(), clock::thread_cpu_s() - c0);
        let written = match &outcome {
            Ok(_) => write_frame(&mut output, 0, seq, wall, cpu, &data),
            Err(m) => {
                eprintln!("ld01-unit: refused op {op} seq {seq}: {m}");
                write_frame(&mut output, 1, seq, wall, cpu, m.as_bytes())
            }
        };
        if let Err(e) = written {
            fatal(&format!("stdout: {e}"));
        }
        if matches!(outcome, Ok(true)) {
            return;
        }
    }
}

/// RODOBS7: the rod law's channels are the law's own values. Ignored; run
/// with the tuple in the environment (unit_host.rs's LOAD),
/// `LD01_UNIT_ROD_FRAMES` (0.1 s exchanges after t0) and
/// `LD01_UNIT_ROD_TRIP` (`on`: TurbineTripAcquired at t0 + 1 s, as the
/// copy gate; `off`: a hold).
#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
    }

    /// An ADVANCE reply's observation frame.
    fn reply_values(out: &[u8]) -> Vec<f64> {
        let u32_at = |i: usize| u32::from_le_bytes(out[i..i + 4].try_into().unwrap()) as usize;
        let at = 20 + 8 * u32_at(16);
        (0..u32_at(at))
            .map(|j| f64::from_le_bytes(out[at + 4 + 8 * j..at + 12 + 8 * j].try_into().unwrap()))
            .collect()
    }

    #[test]
    #[ignore = "needs the unit's environment (LD01_UNIT_ROD_FRAMES, LD01_UNIT_ROD_TRIP)"]
    fn the_rod_law_channels_are_the_laws_own_values() {
        let water = std::env::var("LD01_UNIT_HOST_WATER").unwrap_or_else(|_| "sbtl".into());
        let load = json!({
            "inputs": {
                "packet": env("LD01_OPERATING_HOT_SPINE_PACKET"),
                "wiki_root": env("LD01_WIKI_ROOT"),
                "wiki_commit": env("LD01_WIKI_COMMIT"),
                "wiki_repository": env("LD01_WIKI_REPOSITORY"),
                "ic": env("LD01_IC_SECTION"),
                "pzr_control": env("LD01_PZR_CONTROL_SECTION"),
                "pzr_control_wiki": env("LD01_PZR_CONTROL_WIKI"),
                "elec": env("ELEC_PACKET"),
            },
            "state": env("LD01_S3_STATE"),
            "solver": {"weights": "stock", "first_step": "declared", "stepping": "free", "water": water,
                "source_atol": std::env::var("LD01_S3_SOURCE_ATOL").unwrap_or_else(|_| "derived".into()),
                "grid_exchange_s": null},
        });
        let mut unit = Unit::load(&load).expect("LOAD");
        let index = |id: &str| {
            unit.channels
                .iter()
                .position(|c| c.id == id)
                .unwrap_or_else(|| panic!("no channel {id}"))
        };
        let (tavg, tref) = (index("LD01.CORE.BANK.TAVG"), index("LD01.CORE.BANK.TREF"));
        // The per-frame record is observation: it decides nothing.
        unit.plant
            .rods
            .as_mut()
            .expect("AUTO rod control")
            .recording = true;
        let frames: u64 = env("LD01_UNIT_ROD_FRAMES").parse().expect("frames");
        let period = unit.plant.frame.period_s();
        let k0 = (unit.t / period).round() as u64;
        match env("LD01_UNIT_ROD_TRIP").as_str() {
            "on" => {
                let trip =
                    json!({"kind": "TurbineTripAcquired", "t_apply": (k0 + 10) as f64 * period});
                unit.command(&trip).expect("the trip");
            }
            "off" => {}
            other => panic!("LD01_UNIT_ROD_TRIP {other}: on or off"),
        }
        let (mut auto, mut not_auto, mut worst_t, mut worst_e) = (0, 0, 0f64, 0f64);
        for k in 1..=frames {
            let mut out = Vec::new();
            unit.advance((k0 + k) as f64 * period, &mut out)
                .expect("ADVANCE");
            let values = reply_values(&out);
            assert_eq!(values.len(), unit.channels.len());
            let rods = unit.plant.rods.as_ref().expect("AUTO rod control");
            let last = rods.series.last().expect("a frame record");
            let at = last["t_s"].as_f64().expect("the frame's instant");
            assert!(
                same_instant(at, unit.t),
                "the last frame at {at} s, the unit at {} s",
                unit.t
            );
            let evidence = &last["evidence"];
            let delivered = evidence["tavg_k"].as_f64().expect("the delivered Tavg");
            assert_eq!(
                values[tavg].to_bits(),
                delivered.to_bits(),
                "TAVG at {at} s"
            );
            match last["decision"]["tref_k"].as_f64() {
                Some(tref_k) => {
                    assert_eq!(values[tref].to_bits(), tref_k.to_bits(), "TREF at {at} s");
                    auto += 1;
                    worst_t = worst_t.max((values[tavg] - values[tref]).abs());
                    worst_e = worst_e.max(last["decision"]["error_k"].as_f64().expect("e").abs());
                }
                None => {
                    let load = evidence["load"].as_f64().expect("the delivered load");
                    let program = rods.controller.law().tref_k(load);
                    assert_eq!(values[tref].to_bits(), program.to_bits(), "TREF at {at} s");
                    not_auto += 1;
                }
            }
        }
        println!(
            "rod law channels: {frames} exchanges; {auto} in AUTO (TAVG = the evidence, TREF = the decision's, bitwise), \
             {not_auto} not deciding (TREF = the program at the delivered load); in AUTO max |TAVG - TREF| {worst_t} K, max |e| {worst_e} K"
        );
    }
}

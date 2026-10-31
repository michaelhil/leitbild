//! spec: world/packs/process-plant/reference-designs/ld-01/model/numerics-and-realization.md#what-must-survive-copy-pause-and-restore
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/protection-and-command-precedence.md#time-copies-and-simultaneous-actions
//! The LD-01 unit host: one child process per unit, a framed binary
//! protocol on stdin/stdout, stderr for logs only (lane WORLD, plan r4,
//! shell design §1). It is built on the unit library alone: the S3
//! composition (`unit::s3::compose`) on IC-PROT's frame driver with its
//! plant clients (`unit::plant::Plant`: the acquired protection, IC-CTRL's
//! PZR pressure control in class S, the generator page's ACT.B field
//! controller), stock IDAS in one-step mode with its quadratures carried.
//! It reads no environment: LOAD names every input path.
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
//! | 4 COMMAND | JSON `{kind, t_apply, …}` | JSON (the applied time and its bits) |
//! | 5 SNAPSHOT | — | JSON snapshot |
//! | 6 RESTORE | JSON snapshot | as LOAD |
//! | 7 STATUS | — | JSON counts and cost |
//! | 8 CLOSE | — | empty; exit 0 |
//!
//! **Advance.** The frame driver stops at every I&C frame instant (the PZR
//! control's held heater changes are class S) and at `t1`, so every ADVANCE
//! ends at an accepted stop. The counts are the exchange's own: stock steps,
//! residuals, Jacobians, error-test and convergence failures, R and S
//! instants and frames. The events are the exchange's driver instants (with
//! the rod seats, SG relief crossings, PZR relief openings and the STOP ramp
//! end read from their transactions), the protection's and the field
//! controller's logs and the electrical slice's log, each with its exact
//! time.
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
//! A refusal after the unit's state may have changed (ADVANCE, a restart, a
//! Grid boundary) fail-stops the unit: every later request but STATUS and
//! CLOSE is refused with that cause.
use leitbild_operating_plant::{
    digest::sha256,
    electrical::{breaker::Contact, field, slice},
    ic::{acquisition::Quality, packet::Quantity},
    joined::block::Command,
    network::{CellMode, Network, Properties},
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    frame::{
        Action, COUNTER_NAMES, Change, Class, Diagnostic, DriverState, MatrixRebuild, same_instant,
    },
    joined::{Discrete, JoinedSystem, discrete_restart},
    unit::{
        clock,
        inputs::{Inputs, MODEL, Spine},
        plant::{self, Boundary, Plant},
        profile::{Solver, Weights, parse_first_step},
        s3, timeline,
    },
};
use serde_json::{Map, Value, json};
use std::io::{BufReader, BufWriter, Read, Write};
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

// ------------------------------------------------------------------ channels

/// How one observation-frame channel is read.
#[derive(Clone, Debug)]
enum Reading {
    Time,
    /// An IC instrument channel's delivered sample (position in
    /// `Protection::delivered`): its value, or its quality code.
    IcValue(usize),
    IcQuality(usize),
    /// Divisions with the function's cause latched.
    Latched(String),
    DivisionTrip(usize),
    DivisionPowered(usize),
    ContactClosed(usize),
    HoldingAvailable,
    /// Divisions that recorded the request.
    Request(&'static str),
    FieldInitiated,
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
    let joined = &plant.ida.system().integrated().joined;
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
    ] {
        out.push(channel(id, unit, quantity, "ELEC slice", read));
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
    /// Receipt cursors: driver, protection, field controller and slice logs.
    seen: [usize; 4],
    failed: Option<String>,
    exchanges: u64,
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
    Ok(json!({
        "packet": {"path": i["packet"], "sha256": file_sha256(&inputs.spine.packet_path)?},
        "ic": {"path": i["ic"], "sha256": file_sha256(&inputs.ic_path)?},
        "pzr_control": {"path": i["pzr_control"], "sha256": file_sha256(&inputs.control_path)?},
        "pzr_control_channel": {"page": "operational-observations.md", "sha256": file_sha256(&channel_page)?},
        "elec": {"path": i["elec"], "sha256": file_sha256(&inputs.elec_path)?},
        "state": {"path": state, "sha256": file_sha256(state)?},
        "wiki": {"commit": i["wiki_commit"], "repository": i["wiki_repository"], "pages": [page("build-readiness.md")?, page("operating-hot-spine.md")?]},
        "kernel_source_sha256": KERNEL_SOURCE_SHA256,
        "water_library_sha256": WATER_LIBRARY_SHA256,
        "solver": solver,
    }))
}

/// A LOAD request's parts: the inputs, the state's path, the solver.
fn parse_load(load: &Value) -> Result<(Inputs, String, Solver), String> {
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
    exactly(&o["solver"], "LOAD solver", &["weights", "first_step"])?;
    let solver = Solver {
        weights: Weights::parse(text(&o["solver"], "weights", "LOAD solver")?)?,
        first_step: parse_first_step(text(&o["solver"], "first_step", "LOAD solver")?)?,
    };
    Ok((inputs, text(load, "state", "LOAD")?.to_string(), solver))
}

impl Unit {
    /// The composed unit of a LOAD request, before its start frame (LOAD)
    /// or its restore (RESTORE).
    fn compose(load: &Value) -> Result<Self, String> {
        let (inputs, state_path, solver) = parse_load(load)?;
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
        let field_parameters: field::Parameters =
            serde_json::from_value(elec["fieldProtection"].clone()).map_err(|e| {
                format!(
                    "the electrical packet's fieldProtection (ld01-generator-field-protection): {e}"
                )
            })?;
        let v_nominal = elec["boundary"]["lineVoltage_V"]
            .as_f64()
            .ok_or("the electrical packet's boundary.lineVoltage_V")?;
        let u = s3::compose(&inputs, &state, solver)?;
        if u.receipt["from_saved_s3_state"] != json!(true) || u.receipt["spray_path"] != json!(true)
        {
            return Err(format!(
                "the unit starts from a saved S3 state of a packet with the spray path: {}",
                u.receipt
            ));
        }
        let plant = Plant::new(
            u,
            &inputs.ic,
            plant::Config {
                field: Some(&field_parameters),
                diagnostic: Diagnostic::None,
                // The r4 baseline: stock matrix management (MR-1 off).
                matrix_rebuild: MatrixRebuild::Stock,
                clock: clock::thread_cpu_s,
            },
        )?;
        let composition = json!({
            "t0": bits(plant.t0), "dimension": plant.y.len(), "operator": plant.n,
            "rtol": bits(plant.rtol), "atol_sha256": sha256(vector_bits(&plant.atol).as_bytes()),
            "derived_rows": plant.derived.rows.len(), "frame_s": bits(plant.frame.period_s()),
            "matrix_rebuild": "stock (r4 baseline: MR-1 off)",
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
        Ok(Self {
            plant,
            inputs,
            t,
            load: load.clone(),
            identity,
            channels,
            v_nominal,
            seen: [0; 4],
            failed: None,
            exchanges: 0,
        })
    }

    fn load(load: &Value) -> Result<Self, String> {
        let mut unit = Self::compose(load)?;
        let p = &mut unit.plant;
        let q0 = vec![0.; slice::QUADRATURES.len()];
        p.driver.start_quadratures(&mut p.ida, q0)?;
        p.start(&mut [])?;
        Ok(unit)
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
        let divisions = &p.divisions;
        let flag = |b: bool| f64::from(u8::from(b));
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
                })
            })
            .collect()
    }

    /// Move the receipt cursors past every log line so far: the next frame
    /// reports only its own exchange (a copy point's and a restore's restart
    /// belong to no exchange, so a source and its copy report alike).
    fn mark_seen(&mut self) -> Result<(), String> {
        let p = &self.plant;
        self.seen = [
            p.driver.log.len(),
            p.protection.protection.log.len(),
            p.field
                .as_ref()
                .ok_or("no field controller")?
                .protection
                .log
                .len(),
            p.ida.system().log.len(),
        ];
        Ok(())
    }

    /// The events since the last frame (receipt cursors advance).
    fn events(&mut self) -> Result<Value, String> {
        let p = &self.plant;
        let log = &p.driver.log[self.seen[0]..];
        let tl = timeline::Timeline::from_logs(log, &[], None, 0., self.t)?;
        let protection = &p.protection.protection.log[self.seen[1]..];
        let field = &p
            .field
            .as_ref()
            .ok_or("no field controller")?
            .protection
            .log;
        let field = &field[self.seen[2]..];
        let electrical = &p.ida.system().log[self.seen[3]..];
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
        let before = self.counters()?;
        let reached = self.plant.run(self.t, t1, &mut [], None);
        let reached = match reached {
            Ok(plant_reached) => plant_reached,
            Err(e) => {
                let cause = format!(
                    "ADVANCE from {} s to {t1} s (a discrete change attempted at {:?} s, the solver at {} s): {e}",
                    self.t, self.plant.driver.attempt_s, self.plant.driver.solver_reached_s
                );
                self.failed = Some(cause.clone());
                return Err(cause);
            }
        };
        let leitbild_operating_water::frame::Reached::Until(t) = reached;
        self.t = t;
        self.exchanges += 1;
        // The PZR client's per-frame series and schedule are receipts that
        // grow with the run; the host reports frames instead.
        self.plant.control.series.clear();
        self.plant.control.schedule.clear();
        let after = self.counters()?;
        let values = self.values()?;
        let events = self.events()?;
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

    /// The Grid's boundary for `[t, until)` through the unit library
    /// (`plant::boundary`), decided at the unit's time and applied now.
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
        if !same_instant(t, self.t) {
            return Err(format!(
                "GridBoundary: decided at the unit's time {} s, not {t} s",
                self.t
            ));
        }
        let number = |k: &str| {
            v[k].as_f64()
                .ok_or_else(|| format!("GridBoundary needs the number {k}"))
        };
        let until = number("until")?;
        if !(until.is_finite() && until > self.t) {
            return Err(format!(
                "GridBoundary: until {until} s is not after {} s",
                self.t
            ));
        }
        let boundary = match v["energized"].as_bool() {
            Some(true) => Boundary::Energized {
                voltage_v: self.v_nominal * number("voltage_pu")?,
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
        if p.driver.solver_reached_s != t {
            return Err(format!(
                "the integrator stands at {} s, not at the unit's {t} s",
                p.driver.solver_reached_s
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
            },
            "driver": driver_json(&driver),
        });
        // Design §6.1: the copy point is a restart boundary for the source
        // too (the same exact consistent restart a restore makes).
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
        let (inputs, state, solver) = parse_load(&o["load"])?;
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
            &["protection", "pzr_control", "field"],
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
        p.control.restore(&clients["pzr_control"])?;
        p.field
            .as_mut()
            .ok_or("no field controller")?
            .restore(&clients["field"])?;
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
        unit.mark_seen()?;
        Ok(unit)
    }

    fn status(&self) -> Result<Value, String> {
        let counters = self.counters()?;
        let cpu = &self.plant.driver.cpu;
        Ok(
            json!({"t": self.t, "t_bits": bits(self.t), "failed": self.failed, "exchanges": self.exchanges,
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
            u.usable()?;
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
            u.usable()?;
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

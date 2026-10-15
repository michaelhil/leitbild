//! spec: world/packs/process-plant/reference-designs/ld-01/model/numerics-and-realization.md#what-must-survive-copy-pause-and-restore
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-declaration-joined-hot-spine-at-power
//! TEST-ONLY child-process host of one joined LD-01 unit (PLATFORM lane,
//! S5 host on the joined spine). It composes the unit exactly as the S2
//! gate harness does (the harness's own `compose` and `gates` modules are
//! included below, unchanged), starts it from a saved settled state by the
//! exact consistent start, and advances it in caller-driven time with the
//! S2 trip run's configuration: stock IDA one-step calls with forced stops
//! only at the owners' time events, commands and the event window's end;
//! every command, time event and located root restarts by
//! `discrete_restart`; a turbine or reactor trip opens the declared event
//! window (step cap), closed by H1's restart. Snapshots hold the accepted
//! boundary's y, y' and the operator's whole discrete state (owner hooks
//! `Joined::discrete_state`) with the run policy; a restore recomposes the
//! operator, restores the discrete state and restarts by the exact
//! consistent start. Never registered in a Pack, the Runtime Hub or the
//! deployer.
//!
//! Environment (as the S2 harness): `LD01_OPERATING_HOT_SPINE_PACKET`,
//! `LD01_WIKI_ROOT`, `LD01_S2_DECLARATION`.
//!
//! Frames as `ld01-host-spike`: request `u32 len | u8 op | u32 seq | payload`;
//! reply `u32 len | u8 status | u32 seq | payload`; status 0 payloads start
//! with `f64 handler_wall_s, f64 handler_cpu_s`; status 1 carries a message.
//!
//! | op | request | reply data |
//! |---|---|---|
//! | 1 LOAD | UTF-8 JSON `{settled}` (settled-state file) | JSON |
//! | 2 ADVANCE | `f64 target, u8 stop, u8 observe` | `f64 t, f64 internal_t, 7 x i64 counts, u32 n, n x f64` |
//! | 3 COMMAND | `f64 t, u8 kind (1 turbine trip, 2 reactor trip, 3 stuck cluster), u32 cluster` | — |
//! | 5 SNAPSHOT | — (the unit must stand at an accepted stop) | snapshot bytes |
//! | 6 RESTORE | snapshot bytes | JSON |
//! | 7 PING | bytes | the same bytes |
//! | 8 ABORT | — | none (process aborts) |
//! | 9 CLOSE | — | — |
//! | 10 STATUS | — | JSON (process CPU, peak RSS, time, counts) |
//! | 11 RESTART | — (at an accepted stop) | JSON (the exact consistent restart's cost) |
// The S2 gate harness's composition and declaration readers, included
// unchanged (their crate-root siblings `cpu` and `provenance` likewise).
#[allow(dead_code)]
#[path = "../../../water-ffi/tests/s2_harness/compose.rs"]
mod compose;
#[allow(dead_code, unsafe_code)]
#[path = "../../../water-ffi/tests/common/cpu.rs"]
mod cpu;
#[allow(dead_code)]
#[path = "../../../water-ffi/tests/s2_harness/gates.rs"]
mod gates;
#[allow(dead_code)]
#[path = "../../../water-ffi/tests/common/provenance.rs"]
mod provenance;

use compose::{Composed, START_BOUND, error_weights};
use gates::Declaration;
use leitbild_ld01_host_spike::{KERNEL_SOURCE_SHA256, cpu as clock, sha256};
use leitbild_operating_plant::joined::block::Command;
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial, Stats},
    joined::{Discrete, Integrated, Matrices, Restart, consistent_start, discrete_restart},
};
use serde_json::{Value, json};
use std::io::{BufReader, BufWriter, Read, Write};
use std::time::Instant;

const SNAPSHOT_MAGIC: &[u8; 8] = b"LD01JNT1";
const SIGNALS: [&str; 6] = [
    "released_w",
    "pzr_pt1_pa",
    "sg_a_p_s_pa",
    "sg_b_p_s_pa",
    "rods_seated",
    "rods_free",
];

fn bits(v: f64) -> String {
    format!("{:016x}", v.to_bits())
}
fn from_bits(v: &Value) -> Result<f64, String> {
    let h = v.as_str().ok_or("expected 16 hex digits")?;
    u64::from_str_radix(h, 16)
        .map(f64::from_bits)
        .map_err(|e| e.to_string())
}
fn message(f: leitbild_operating_plant::network::Failure) -> String {
    match f {
        leitbild_operating_plant::network::Failure::Recoverable(r)
        | leitbild_operating_plant::network::Failure::Fatal(r) => r,
    }
}

/// The trip run's declared configuration (`ld01-s2-gates`, `ld01-s1-gates`).
#[derive(Clone, Copy)]
struct Config {
    restart: Restart,
    max_order: usize,
    newton_coefficient: f64,
    delta_cj_lsetup: f64,
    first_step_s: f64,
    window_s: f64,
    window_max_step_s: f64,
}
impl Config {
    fn of(d: &Declaration) -> Self {
        let (g, s) = (&d.gates, &d.shared);
        Self {
            restart: Restart {
                newton_coefficient: g.number("/newtonCoefficient"),
                delta_cj_lsetup: g.number("/deltaCjLSetup"),
                first_step_s: g.number("/restartInitialStep_s"),
                start_bound: START_BOUND,
                start_passes: g.count("/restarts/ordinaryPasses") as usize,
                transaction_passes: g.count("/restarts/afterOwnerTransaction/maxPasses") as usize,
                bound_placement: START_BOUND,
            },
            max_order: g.count("/maxOrder") as usize,
            newton_coefficient: g.number("/newtonCoefficient"),
            delta_cj_lsetup: g.number("/deltaCjLSetup"),
            first_step_s: g.number("/restartInitialStep_s"),
            window_s: g.number("/trip/window_s"),
            window_max_step_s: s.number("/eventWindow/maxStep_s"),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Counts {
    steps: i64,
    residuals: i64,
    jacobians: i64,
    nonlinear_iterations: i64,
    error_failures: i64,
    convergence_failures: i64,
    restarts: i64,
}
impl Counts {
    fn plus(self, s: &Stats) -> Self {
        Self {
            steps: self.steps + s.steps,
            residuals: self.residuals + s.residuals,
            jacobians: self.jacobians + s.jacobians,
            nonlinear_iterations: self.nonlinear_iterations + s.nonlinear_iterations,
            error_failures: self.error_failures + s.error_failures,
            convergence_failures: self.convergence_failures + s.convergence_failures,
            restarts: self.restarts,
        }
    }
    fn json(self) -> Value {
        json!({"steps": self.steps, "residuals": self.residuals, "jacobians": self.jacobians,
            "nonlinear_iterations": self.nonlinear_iterations, "error_failures": self.error_failures,
            "convergence_failures": self.convergence_failures, "restarts": self.restarts})
    }
}

fn command_code(c: Command) -> Value {
    match c {
        Command::TurbineTrip => json!({"kind": "turbine-trip"}),
        Command::ManualReactorTrip => json!({"kind": "reactor-trip"}),
        Command::StuckCluster { cluster } => json!({"kind": "stuck-cluster", "cluster": cluster}),
    }
}
fn command_from(v: &Value) -> Result<Command, String> {
    match v["kind"].as_str() {
        Some("turbine-trip") => Ok(Command::TurbineTrip),
        Some("reactor-trip") => Ok(Command::ManualReactorTrip),
        Some("stuck-cluster") => Ok(Command::StuckCluster {
            cluster: v["cluster"].as_u64().ok_or("stuck-cluster index")? as usize,
        }),
        other => Err(format!("unknown command {other:?}")),
    }
}

struct Unit {
    config: Config,
    ida: Ida<Integrated<If97>>,
    /// The state at the integrator's internal time.
    y: Vec<f64>,
    yp: Vec<f64>,
    internal: f64,
    /// The unit's time (the last requested boundary).
    t: f64,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    pending: Vec<(f64, Command)>,
    window_end: Option<f64>,
    carried: Counts,
    identity: Value,
    pressures: Vec<usize>,
    /// The interpolated state at `t` when the integrator stands past it.
    view: Option<(f64, Vec<f64>, Vec<f64>)>,
}

/// The run's identity: packet, declaration and S1 blocks, water build and
/// kernel sources. A restore refuses any difference.
fn identity(packet: &compose::PacketFile) -> Result<Value, String> {
    let declaration = std::fs::read(gates::declaration_page()).map_err(|e| e.to_string())?;
    let water: Value = serde_json::from_str(provenance::WATER_BUILD).map_err(|e| e.to_string())?;
    Ok(json!({
        "packet_sha256": packet.sha256,
        "declaration_sha256": sha256::hex(&declaration),
        "wiki_s1_gates_sha256": sha256::hex(
            std::fs::read(format!("{}/build-readiness.md", gates::wiki_model())).map_err(|e| e.to_string())?.as_slice()),
        "water_library_sha256": water["librarySha256"],
        "kernel_source_sha256": KERNEL_SOURCE_SHA256,
    }))
}

impl Unit {
    /// Compose afresh and build stock IDA at (t, y, yp) with the run's
    /// configuration; the caller then starts it exactly.
    fn compose(d: &Declaration) -> Result<(Composed, Value), String> {
        let (c0, w0) = (clock::thread_s(), Instant::now());
        let c = compose::compose_from(&d.shared, Some(&d.gates), None);
        let s1 = c.receipt["s1_settling"]["cpu_s"].as_f64();
        Ok((
            c,
            json!({"compose_cpu_s": clock::thread_s() - c0, "compose_wall_s": w0.elapsed().as_secs_f64(),
                "of_which_s1_settle_export_cpu_s": s1}),
        ))
    }
    fn configure(&mut self) -> Result<(), String> {
        self.ida.set_max_order(self.config.max_order)?;
        self.ida
            .set_nonlinear_convergence_coefficient(self.config.newton_coefficient)?;
        self.ida.set_init_step(self.config.first_step_s)?;
        if self.window_end.is_some() {
            self.ida.set_max_step(self.config.window_max_step_s)?;
        }
        Ok(())
    }

    fn build(
        d: &Declaration,
        c: Composed,
        t: f64,
        y: Vec<f64>,
        yp: Vec<f64>,
        discrete: Option<&Value>,
    ) -> Result<Self, String> {
        let config = Config::of(d);
        let identity = identity(&c.packet)?;
        let Composed {
            mut joined,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        } = c;
        if let Some(state) = discrete {
            joined.restore_discrete_state(state).map_err(message)?;
        }
        let ids = joined.differential(&network_ids);
        let nonnegative = joined.network.nonnegative_stocks();
        let pressures: Vec<usize> = {
            let mut k = 0;
            let mut out = Vec::new();
            for (_, l) in joined.layouts() {
                for label in &l.labels {
                    if label.ends_with(".p_s") {
                        out.push(k);
                    }
                    k += 1;
                }
            }
            out
        };
        let integrated = Integrated::from_blocks(joined, structure, analyses)?;
        let mut ida = Ida::new(
            integrated,
            Initial {
                time: t,
                y: &y,
                yp: &yp,
                differential: &ids,
                absolute_tolerance: &atol,
                relative_tolerance: rtol,
            },
        )?;
        ida.constrain_nonnegative(&nonnegative)?;
        config.restart.configure(&mut ida)?;
        ida.set_delta_cj_lsetup(config.delta_cj_lsetup)?;
        let mut unit = Self {
            config,
            ida,
            y,
            yp,
            internal: t,
            t,
            network_ids,
            atol,
            rtol,
            pending: Vec::new(),
            window_end: None,
            carried: Counts::default(),
            identity,
            pressures,
            view: None,
        };
        unit.configure()?;
        Ok(unit)
    }

    /// LOAD: compose, take the settled state's exact bits, exact consistent
    /// start there (as the gate runner's start), stock IDA.
    fn load(d: &Declaration, settled: &str) -> Result<(Self, Value), String> {
        let (c0, w0) = (clock::thread_s(), Instant::now());
        let (mut c, compose_report) = Self::compose(d)?;
        let (t, y_saved, _) = compose::saved_state(settled, &c.packet, c.joined.dimension());
        let mut y = y_saved;
        let s0 = clock::thread_s();
        let weights = error_weights(&y, c.rtol, &c.atol);
        let (yp, report) = consistent_start(
            &mut c.joined,
            Matrices::Blocks {
                structure: &c.structure,
                analyses: &mut c.analyses,
            },
            t,
            &mut y,
            &c.ids,
            &weights,
            START_BOUND,
            Config::of(d).restart.start_passes,
        )
        .map_err(message)?;
        let start_cpu = clock::thread_s() - s0;
        let unit = Self::build(d, c, t, y, yp, None)?;
        let reply = json!({"t": t, "dimension": unit.y.len(), "identity": unit.identity,
            "signals": SIGNALS, "compose": compose_report,
            "start": {"cpu_s": start_cpu, "projection_passes": report.projection_passes,
                "residual": report.residual.value, "correction_wrms": report.correction_wrms},
            "cpu_s": clock::thread_s() - c0, "wall_s": w0.elapsed().as_secs_f64(),
            "pid": std::process::id()});
        Ok((unit, reply))
    }

    fn counts(&self) -> Counts {
        self.carried.plus(&self.ida.stats().expect("stats"))
    }

    /// One `discrete_restart` at the internal time, then the run's
    /// configuration (as the gate runner after each restart).
    fn restart_at(&mut self, discrete: Discrete<'_>) -> Result<Value, String> {
        let (c0, w0) = (clock::thread_s(), Instant::now());
        let carried = self.counts();
        let done = discrete_restart(
            &mut self.ida,
            self.internal,
            discrete,
            &mut self.y,
            &self.network_ids,
            &self.atol,
            self.rtol,
            &self.config.restart,
        )?;
        self.yp.copy_from_slice(&done.yp);
        self.carried = carried;
        self.carried.restarts += 1;
        self.configure()?;
        Ok(
            json!({"t": self.internal, "transactions": done.transactions.len(),
            "passes": done.report.projection_passes, "cpu_s": clock::thread_s() - c0,
            "wall_s": w0.elapsed().as_secs_f64()}),
        )
    }

    /// Commands due at the internal time, applied in order; a trip opens
    /// the event window.
    fn apply_due(&mut self) -> Result<(), String> {
        while let Some((at, command)) = self.pending.first().copied() {
            if at > self.internal {
                break;
            }
            self.pending.remove(0);
            if matches!(command, Command::TurbineTrip | Command::ManualReactorTrip) {
                self.window_end = Some(self.internal + self.config.window_s);
            }
            self.restart_at(Discrete::Command(command))?;
        }
        Ok(())
    }

    fn boundary(&self) -> Option<f64> {
        let joined = &self.ida.system().joined;
        [
            joined.next_time_event(self.internal),
            self.pending.first().map(|(at, _)| *at),
            self.window_end,
        ]
        .into_iter()
        .flatten()
        .filter(|b| *b > self.internal)
        .reduce(f64::min)
    }

    /// Advance to `target`: one stock step at a time, forced stops only at
    /// physics boundaries (and at `target` when `stop`). When a step passes
    /// `target`, the state there is read from that step's interpolant before
    /// any restart discards it.
    fn advance(&mut self, target: f64, stop: bool) -> Result<(), String> {
        if !(target.is_finite() && target > self.t) {
            return Err(format!("target {target} is not after {}", self.t));
        }
        self.view = None;
        loop {
            self.apply_due()?;
            if self.internal >= target {
                break;
            }
            let physics = self.boundary();
            let forced = match (physics, stop) {
                (Some(b), true) => Some(b.min(target)),
                (Some(b), false) => Some(b),
                (None, true) => Some(target),
                (None, false) => None,
            };
            let tout = forced.unwrap_or(self.internal + 3600.);
            if let Some(b) = forced {
                self.ida.stop_at(b)?;
            }
            let event = self.ida.system().joined.next_time_event(self.internal);
            let outcome = self.ida.advance_one_step(tout, &mut self.y, &mut self.yp)?;
            let time = match &outcome {
                Advance::Root { time, .. } | Advance::Reached(time) => *time,
            };
            self.internal = time;
            if time > target {
                let (mut y, mut yp) = (self.y.clone(), self.yp.clone());
                self.ida.dense(target, &mut y, &mut yp)?;
                self.view = Some((target, y, yp));
            }
            match outcome {
                Advance::Root { directions, .. } => {
                    self.restart_at(Discrete::Roots(&directions))?;
                }
                Advance::Reached(_) => {
                    if forced == Some(time) {
                        if event == Some(time) {
                            self.restart_at(Discrete::TimeEvent)?;
                        }
                        self.apply_due()?;
                        if self.window_end == Some(time) {
                            self.window_end = None;
                            self.ida.remove_max_step()?;
                            self.restart_at(Discrete::TimeEvent)?;
                        }
                    }
                }
            }
        }
        self.t = target;
        Ok(())
    }

    /// The unit's state at its time: the accepted state at a stop, else the
    /// interpolant read when the step passed it (no step changes).
    fn state_at_t(&self) -> Result<(Vec<f64>, Vec<f64>), String> {
        if self.internal == self.t {
            return Ok((self.y.clone(), self.yp.clone()));
        }
        match &self.view {
            Some((t, y, yp)) if *t == self.t => Ok((y.clone(), yp.clone())),
            _ => Err(format!("no state at {} s", self.t)),
        }
    }

    fn observe(&mut self) -> Result<Vec<f64>, String> {
        let (y, yp) = self.state_at_t()?;
        let t = self.t;
        let modes = self.ida.system().joined.discrete_state();
        let joined = &mut self.ida.system_mut().joined;
        joined
            .evaluate(t, &y, &yp, None, 0., None)
            .map_err(message)?;
        let released = joined.heats().nuclear.released_w.value;
        let pt1 = joined
            .network
            .pzr_taps()
            .map_or(f64::NAN, |t| t.pt1_pa.value);
        let scales = joined.scales();
        let p: Vec<f64> = self.pressures.iter().map(|i| y[*i] * scales[*i]).collect();
        let count = |m: &str| {
            modes["rods"]["modes"]
                .as_array()
                .map_or(0, |a| a.iter().filter(|x| x.as_str() == Some(m)).count())
                as f64
        };
        Ok(vec![
            released,
            pt1,
            p.first().copied().unwrap_or(f64::NAN),
            p.get(1).copied().unwrap_or(f64::NAN),
            count("seated"),
            count("free"),
        ])
    }

    fn snapshot(&self) -> Result<Vec<u8>, String> {
        if self.internal != self.t {
            return Err(format!(
                "a snapshot needs an accepted stop: the unit is at {} s, the integrator at {} s",
                self.t, self.internal
            ));
        }
        let header = serde_json::to_vec(&json!({
            "identity": self.identity,
            "t": bits(self.t),
            "n": self.y.len(),
            "discrete": self.ida.system().joined.discrete_state(),
            "policy": {
                "window_end": self.window_end.map(bits),
                "pending": self.pending.iter().map(|(at, c)| json!({"t": bits(*at), "command": command_code(*c)})).collect::<Vec<_>>(),
            },
            "atol_sha256": sha256::hex(&self.atol.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>()),
        }))
        .map_err(|e| e.to_string())?;
        let mut blob = Vec::with_capacity(12 + header.len() + 16 * self.y.len());
        blob.extend_from_slice(SNAPSHOT_MAGIC);
        blob.extend_from_slice(&(header.len() as u32).to_le_bytes());
        blob.extend_from_slice(&header);
        for v in self.y.iter().chain(&self.yp) {
            blob.extend_from_slice(&v.to_le_bytes());
        }
        Ok(blob)
    }

    /// RESTORE: recompose, restore the discrete state and run policy, build
    /// stock IDA at the saved pair and restart by `discrete_restart` (the
    /// same exact consistent restart a source performs in place).
    fn restore(d: &Declaration, blob: &[u8]) -> Result<(Self, Value), String> {
        let (c0, w0) = (clock::thread_s(), Instant::now());
        if blob.len() < 12 || &blob[..8] != SNAPSHOT_MAGIC {
            return Err("not an LD-01 joined snapshot".into());
        }
        let length = u32::from_le_bytes(blob[8..12].try_into().unwrap()) as usize;
        let header: Value =
            serde_json::from_slice(blob.get(12..12 + length).ok_or("truncated header")?)
                .map_err(|e| format!("snapshot header: {e}"))?;
        let (c, compose_report) = Self::compose(d)?;
        let mine = identity(&c.packet)?;
        if header["identity"] != mine {
            return Err(format!(
                "snapshot identity {} differs from this unit's {mine}",
                header["identity"]
            ));
        }
        let atol_sha = sha256::hex(
            &c.atol
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        if header["atol_sha256"].as_str() != Some(atol_sha.as_str()) {
            return Err("the recomposed absolute tolerances differ from the snapshot's".into());
        }
        let n = header["n"].as_u64().ok_or("snapshot n")? as usize;
        let body = &blob[12 + length..];
        if body.len() != 16 * n || n != c.joined.dimension() {
            return Err("snapshot body does not match the composed dimension".into());
        }
        let values: Vec<f64> = body
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let t = from_bits(&header["t"])?;
        let r0 = (clock::thread_s(), Instant::now());
        let mut unit = Self::build(
            d,
            c,
            t,
            values[..n].to_vec(),
            values[n..].to_vec(),
            Some(&header["discrete"]),
        )?;
        let policy = &header["policy"];
        unit.window_end = match &policy["window_end"] {
            Value::Null => None,
            v => Some(from_bits(v)?),
        };
        unit.pending = policy["pending"]
            .as_array()
            .ok_or("snapshot pending")?
            .iter()
            .map(|p| Ok((from_bits(&p["t"])?, command_from(&p["command"])?)))
            .collect::<Result<_, String>>()?;
        unit.configure()?;
        let restart = unit.restart_at(Discrete::TimeEvent)?;
        let reply = json!({"t": t, "identity": unit.identity, "compose": compose_report,
            "restart": restart, "build_and_restart_cpu_s": clock::thread_s() - r0.0,
            "build_and_restart_wall_s": r0.1.elapsed().as_secs_f64(),
            "cpu_s": clock::thread_s() - c0, "wall_s": w0.elapsed().as_secs_f64(),
            "max_rss_bytes": clock::max_rss_bytes(), "pid": std::process::id()});
        Ok((unit, reply))
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self
            .bytes
            .get(self.at..self.at + n)
            .ok_or("truncated request payload")?;
        self.at += n;
        Ok(s)
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
}

struct Host {
    d: Declaration,
    unit: Option<Unit>,
}
impl Host {
    fn unit(&mut self) -> Result<&mut Unit, String> {
        self.unit.as_mut().ok_or_else(|| "no unit is loaded".into())
    }
    fn handle(&mut self, op: u8, payload: &[u8], out: &mut Vec<u8>) -> Result<bool, String> {
        let mut r = Reader {
            bytes: payload,
            at: 0,
        };
        match op {
            1 => {
                let config: Value =
                    serde_json::from_slice(payload).map_err(|e| format!("LOAD JSON: {e}"))?;
                let settled = config["settled"].as_str().ok_or("LOAD needs {settled}")?;
                let (unit, reply) = Unit::load(&self.d, settled)?;
                out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
                self.unit = Some(unit);
            }
            2 => {
                let target = r.f64()?;
                let stop = r.u8()? != 0;
                let observe = r.u8()? != 0;
                let unit = self.unit()?;
                unit.advance(target, stop)?;
                out.extend_from_slice(&unit.t.to_le_bytes());
                out.extend_from_slice(&unit.internal.to_le_bytes());
                let c = unit.counts();
                for v in [
                    c.steps,
                    c.residuals,
                    c.jacobians,
                    c.nonlinear_iterations,
                    c.error_failures,
                    c.convergence_failures,
                    c.restarts,
                ] {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                let signals = if observe { unit.observe()? } else { Vec::new() };
                out.extend_from_slice(&(signals.len() as u32).to_le_bytes());
                for v in signals {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
            3 => {
                let t = r.f64()?;
                let kind = r.u8()?;
                let cluster = r.u32()? as usize;
                let command = match kind {
                    1 => Command::TurbineTrip,
                    2 => Command::ManualReactorTrip,
                    3 => Command::StuckCluster { cluster },
                    other => return Err(format!("unknown command kind {other}")),
                };
                let unit = self.unit()?;
                if !(t.is_finite() && (t > unit.internal || (t == unit.internal && t == unit.t))) {
                    return Err(format!(
                        "command at {t} s is behind the integrator ({} s): commands are prospective",
                        unit.internal
                    ));
                }
                unit.pending.push((t, command));
                unit.pending.sort_by(|a, b| a.0.total_cmp(&b.0));
            }
            5 => out.extend_from_slice(&self.unit()?.snapshot()?),
            6 => {
                let (unit, reply) = Unit::restore(&self.d, payload)?;
                out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
                self.unit = Some(unit);
            }
            7 => out.extend_from_slice(payload),
            8 => {
                eprintln!("ld01-joined-host: ABORT requested (simulated native fatal)");
                std::process::abort();
            }
            9 => return Ok(true),
            10 => {
                let unit = self.unit.as_ref();
                let reply = json!({"process_cpu_s": clock::process_s(), "max_rss_bytes": clock::max_rss_bytes(),
                    "t": unit.map(|u| u.t), "counts": unit.map(|u| u.counts().json())});
                out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
            }
            11 => {
                let unit = self.unit()?;
                if unit.internal != unit.t {
                    return Err("a restart needs an accepted stop".into());
                }
                let reply = unit.restart_at(Discrete::TimeEvent)?;
                out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
            }
            other => return Err(format!("unknown op {other}")),
        }
        Ok(false)
    }
}

fn write_frame(w: &mut impl Write, status: u8, seq: u32, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&((5 + payload.len()) as u32).to_le_bytes())?;
    w.write_all(&[status])?;
    w.write_all(&seq.to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

fn main() {
    let d = Declaration::load().unwrap_or_else(|e| panic!("S2 declaration: {e}"));
    let mut host = Host { d, unit: None };
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut output = BufWriter::new(std::io::stdout().lock());
    let mut header = [0u8; 4];
    loop {
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return,
            Err(e) => panic!("stdin: {e}"),
        }
        let length = u32::from_le_bytes(header) as usize;
        assert!(length >= 5, "frame shorter than its op and sequence");
        let mut body = vec![0u8; length];
        input.read_exact(&mut body).expect("truncated frame");
        let op = body[0];
        let seq = u32::from_le_bytes(body[1..5].try_into().unwrap());
        let (cpu0, wall0) = (clock::thread_s(), Instant::now());
        let mut data = Vec::new();
        let outcome = host.handle(op, &body[5..], &mut data);
        let (wall, cpu) = (wall0.elapsed().as_secs_f64(), clock::thread_s() - cpu0);
        let written = match &outcome {
            Ok(_) => {
                let mut payload = Vec::with_capacity(16 + data.len());
                payload.extend_from_slice(&wall.to_le_bytes());
                payload.extend_from_slice(&cpu.to_le_bytes());
                payload.extend_from_slice(&data);
                write_frame(&mut output, 0, seq, &payload)
            }
            Err(m) => write_frame(&mut output, 1, seq, m.as_bytes()),
        };
        written.expect("stdout");
        if matches!(outcome, Ok(true)) {
            return;
        }
    }
}

//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#selected-electrical-interval-handoff
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! TEST-ONLY child-process host of one S3 unit with ELEC's slice (PLATFORM
//! lane, C5 native preview), speaking the plant side of the plant <-> Grid
//! interval exchange on stdin/stdout. Never registered in a Pack, the
//! Runtime Hub or the deployer.
//!
//! **Composition.** The S3 composition exactly as KERN's settle and the S3
//! cases build it (`common/s3_unit.rs`, included unchanged): the joined
//! operator with the spray line closed, the SG two-zone map, the feed gate,
//! S2-D24r/S3-D16 derived classes, L1 and phase modes, ELEC's slice
//! connected; started from KERN's saved S3 state by the exact consistent
//! start. Not composed here: the frame driver's sampled clients (the PZR
//! pressure controller's demand stays the one in force; IC-PROT's acquired
//! protection is absent, so C5's turbine trip is a declared command, as
//! ELEC's LOOP probe declares it).
//!
//! **Exchange** (`[t0, t1)`, ordered-join phase 1). The request carries the
//! Grid's committed boundary for the interval: energized, voltage (pu),
//! frequency (Hz), held over it. A change is applied at `t0`, classed by
//! S3-D4's rule (`frame::storage_rate_only`): a held input entering only
//! storage rates is S (stop, continue the history), anything else is R
//! (`discrete_restart`). A de-energized bus is S3-D10's offsite loss (stator
//! separated, both sources dead; R). Restoration is refused (not in the S3
//! slice). The unit then advances to `t1` in stock one-step calls with
//! forced stops only at physics boundaries, scheduled stops and, when the
//! request asks for it, at `t1`. The reply is the interval receipt: the
//! slice's IDAS quadratures over `[t0, t1]` (generator export, unit and
//! reserve auxiliary draws; read at the stop, else from the step's
//! interpolant, IDAGetQuadDky), the terminal export at `t1`, the breaker,
//! the offsite latch, RCP supports, shaft speed, events with their exact
//! times, and counts by class. Quadratures are carried across every restart
//! (IDAQuadReInit with their values there).
//!
//! Frames as the other hosts; status 1 is an explicit refusal.
//! | op | request | reply data |
//! |---|---|---|
//! | 1 LOAD | JSON `{state}` (KERN's saved S3 state) | JSON |
//! | 3 COMMAND | `f64 t, u8 kind (0 stop, 1 turbine trip, 2 reactor trip, 6 supply loss), u32 index` | — |
//! | 12 EXCHANGE | `f64 t1, u8 stop, u8 observe, u8 energized, f64 voltage_pu, f64 frequency_hz` | `14 x f64, 8 x i64, u32 n, n x f64 signals, u32 m, m bytes JSON events` |
//! | 7 PING, 9 CLOSE, 10 STATUS | as the other hosts | |
#![allow(dead_code)]
#[allow(unsafe_code)]
#[path = "../../../water-ffi/tests/common/cpu.rs"]
mod clock;
#[path = "../../../water-ffi/tests/common/pzr_control.rs"]
mod pzr_control;
#[path = "../../../water-ffi/tests/common/s3_unit.rs"]
mod s3_unit;
#[allow(unsafe_code, unused_imports)]
#[path = "../../../water-ffi/tests/joined_spine.rs"]
mod spine;

use leitbild_ld01_host_spike::{KERNEL_SOURCE_SHA256, cpu as time};
use leitbild_operating_plant::{electrical::slice, joined::block::Command};
use leitbild_operating_water::{
    frame::storage_rate_only,
    ida::{Advance, Ida, System},
    joined::{Discrete, JoinedSystem, Restart, discrete_restart},
};
use s3_unit::Unit;
use serde_json::{Value, json};
use std::io::{BufReader, BufWriter, Read, Write};
use std::time::Instant;

/// Quadrature indices of the receipt (slice::QUADRATURES order).
const EXPORT: usize = 0;
const UNIT_DRAW: usize = 8;
const RESERVE_DRAW: usize = 9;

#[derive(Clone, Copy, Default)]
struct Counts {
    steps: i64,
    jacobians: i64,
    residuals: i64,
    error_failures: i64,
    convergence_failures: i64,
    restarts: i64,
    held_s: i64,
    forced_stops: i64,
}

/// `(t, y, y', quadratures)` read from a step's interpolant.
type View = (f64, Vec<f64>, Vec<f64>, Vec<f64>);

enum Deferred {
    Roots(Vec<i32>),
    Boundary { event: bool },
}

struct Host {
    ida: Ida<Unit>,
    y: Vec<f64>,
    yp: Vec<f64>,
    n: usize,
    internal: f64,
    t: f64,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    restart: Restart,
    v_nominal: f64,
    q: Vec<f64>,
    carried: Counts,
    deferred: Option<Deferred>,
    pending: Vec<(f64, Command)>,
    stops: Vec<f64>,
    /// The interpolated state and quadratures at `t` when the integrator
    /// stands past it.
    view: Option<View>,
    events: Vec<Value>,
    log_seen: usize,
}

fn read_json(path: &str) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?)
        .map_err(|e| format!("{path}: {e}"))
}

impl Host {
    fn load(state_path: &str) -> Result<(Self, Value), String> {
        let (c0, w0) = (time::thread_s(), Instant::now());
        let inputs = s3_unit::Inputs::from_env();
        let state = read_json(state_path)?;
        let u = s3_unit::compose(&inputs, &state)?;
        let mut ida = u.ida;
        let q0 = vec![0.; slice::QUADRATURES.len()];
        ida.initialize_quadratures(&q0)?;
        let e = read_json(&inputs.elec_path)?;
        let v_nominal = e["boundary"]["lineVoltage_V"]
            .as_f64()
            .ok_or("electrical packet: boundary.lineVoltage_V")?;
        let host = Self {
            ida,
            y: u.y,
            yp: u.yp,
            n: u.n,
            internal: u.t0,
            t: u.t0,
            network_ids: u.network_ids,
            atol: u.atol,
            rtol: u.rtol,
            restart: u.restart,
            v_nominal,
            q: q0,
            carried: Counts::default(),
            deferred: None,
            pending: Vec::new(),
            stops: Vec::new(),
            view: None,
            events: Vec::new(),
            log_seen: 0,
        };
        let s = &host.ida.system().slice;
        let reply = json!({"t": u.t0, "dimension": host.y.len(), "operator": u.n,
            "kernel_source_sha256": KERNEL_SOURCE_SHA256,
            "boundary": {"v_line_V": s.inputs.v_line, "frequency_hz": s.inputs.f_grid_hz, "joined": s.inputs.joined},
            "export_w": s.export_w(&host.y[u.n..]), "composition": u.receipt,
            "quadratures": slice::QUADRATURES,
            "cpu_s": time::thread_s() - c0, "wall_s": w0.elapsed().as_secs_f64(),
            "max_rss_bytes": time::max_rss_bytes(), "pid": std::process::id()});
        Ok((host, reply))
    }

    fn counts(&self) -> Counts {
        let s = self.ida.stats().expect("stats");
        let c = self.carried;
        Counts {
            steps: c.steps + s.steps,
            jacobians: c.jacobians + s.jacobians,
            residuals: c.residuals + s.residuals,
            error_failures: c.error_failures + s.error_failures,
            convergence_failures: c.convergence_failures + s.convergence_failures,
            ..c
        }
    }

    /// One `discrete_restart` at the internal time, the quadratures carried.
    fn restart_at(&mut self, discrete: Discrete<'_>, kind: &str) -> Result<(), String> {
        let mut q = vec![0.; self.q.len()];
        self.ida.quadratures(&mut q)?;
        self.restart_with(discrete, kind, q)
    }
    /// A restart whose quadratures at the restart time are given (a rewind
    /// reads them from the discarded step's interpolant).
    fn restart_with(
        &mut self,
        discrete: Discrete<'_>,
        kind: &str,
        q: Vec<f64>,
    ) -> Result<(), String> {
        let carried = self.counts();
        let done = discrete_restart(
            &mut self.ida,
            self.internal,
            discrete,
            &mut self.y,
            &self.network_ids,
            &self.atol,
            self.rtol,
            &self.restart,
        )?;
        self.yp.copy_from_slice(&done.yp);
        self.ida.reinitialize_quadratures(&q)?;
        self.carried = carried;
        self.carried.restarts += 1;
        self.events
            .push(json!({"t": self.internal, "class": "R", "kind": kind,
            "appended": done.appended, "transactions": done.transactions.len()}));
        Ok(())
    }

    /// Commands due at the internal time, in order.
    fn apply_due(&mut self) -> Result<(), String> {
        while let Some((at, command)) = self.pending.first().copied() {
            if at > self.internal {
                break;
            }
            self.pending.remove(0);
            self.restart_at(Discrete::Command(command), &format!("command {command:?}"))?;
        }
        Ok(())
    }

    fn settle(&mut self) -> Result<(), String> {
        match self.deferred.take() {
            Some(Deferred::Roots(d)) => self.restart_at(Discrete::Roots(&d), "located roots")?,
            Some(Deferred::Boundary { event }) => {
                if event {
                    self.restart_at(Discrete::TimeEvent, "owner time event")?;
                }
                self.apply_due()?;
            }
            None => self.apply_due()?,
        }
        self.stops.retain(|s| *s > self.internal);
        Ok(())
    }

    fn boundary(&self) -> Option<f64> {
        [
            self.ida.system().next_time_event(self.internal),
            self.pending.first().map(|(at, _)| *at),
            self.stops.first().copied(),
        ]
        .into_iter()
        .flatten()
        .filter(|b| *b > self.internal)
        .reduce(f64::min)
    }

    /// Bring the integrator to the unit's time `t` for a boundary change: at
    /// a stop it is there; past it (no stop was asked), the history beyond
    /// `t` is discarded and the unit restarts from the step's interpolant at
    /// `t` (class R only, as the frame driver's late discovery).
    fn rewind_to_t(&mut self) -> Result<Option<Vec<f64>>, String> {
        if self.internal == self.t {
            self.settle()?;
            return Ok(None);
        }
        let (_, y, yp, q) = self
            .view
            .take()
            .filter(|v| v.0 == self.t)
            .ok_or("no interpolant at the unit's time")?;
        self.y = y;
        self.yp = yp;
        self.deferred = None;
        self.internal = self.t;
        Ok(Some(q))
    }

    /// The Grid's boundary for `[t, t1)`, applied at `t` by S3-D4's rule.
    fn boundary_change(
        &mut self,
        energized: bool,
        voltage_pu: f64,
        frequency_hz: f64,
    ) -> Result<(), String> {
        let offsite_lost = self.ida.system().offsite_loss_s.is_some();
        if !energized && !offsite_lost {
            // S3-D10: the offsite connection is lost at t (class R).
            let rewound = self.rewind_to_t()?;
            self.ida.system_mut().offsite_loss_s = Some(self.t);
            let kind = "Grid: bus dead (S3-D10 offsite loss)";
            return match rewound {
                Some(q) => self.restart_with(
                    Discrete::TimeEvent,
                    &format!("{kind}, from the interpolant"),
                    q,
                ),
                None => self.restart_at(Discrete::TimeEvent, kind),
            };
        }
        if energized && offsite_lost {
            return Err(
                "restoration of a lost offsite connection is not in the S3 slice (S3-D10): refused"
                    .into(),
            );
        }
        if !energized {
            return Ok(()); // dead and already lost: nothing changes
        }
        let v_line = self.v_nominal * voltage_pu;
        let inputs = self.ida.system().slice.inputs;
        if inputs.v_line == v_line && inputs.f_grid_hz == frequency_hz {
            return Ok(());
        }
        if !(v_line.is_finite() && v_line > 0. && frequency_hz.is_finite() && frequency_hz > 0.) {
            return Err(format!(
                "boundary voltage {voltage_pu} pu / frequency {frequency_hz} Hz"
            ));
        }
        if self.internal != self.t {
            return Err(format!(
                "a held boundary change at {} s needs a stop there (exchange with stop): the integrator stands at {} s",
                self.t, self.internal
            ));
        }
        self.settle()?;
        // S3-D4's rule on the change at the stop.
        let n_all = self.y.len();
        let roots_n = self.ida.system().root_count();
        let (t, y, yp) = (self.t, self.y.clone(), self.yp.clone());
        let mut before = vec![0.; n_all];
        let mut after = vec![0.; n_all];
        let mut r_before = vec![0.; roots_n];
        let mut r_after = vec![0.; roots_n];
        let ids = self.ida.system().differential_all(&self.network_ids);
        {
            let u = self.ida.system_mut();
            u.residual(t, &y, &yp, &mut before)
                .map_err(|e| format!("{e:?}"))?;
            u.roots(t, &y, &yp, &mut r_before)
                .map_err(|e| format!("{e:?}"))?;
            u.slice.inputs.v_line = v_line;
            u.slice.inputs.f_grid_hz = frequency_hz;
            u.residual(t, &y, &yp, &mut after)
                .map_err(|e| format!("{e:?}"))?;
            u.roots(t, &y, &yp, &mut r_after)
                .map_err(|e| format!("{e:?}"))?;
        }
        let ids_after = self.ida.system().differential_all(&self.network_ids);
        let delta: Vec<f64> = after.iter().zip(&before).map(|(a, b)| a - b).collect();
        match storage_rate_only(&delta, &ids, &ids_after, &r_before, &r_after) {
            Ok(rows) => {
                self.carried.held_s += 1;
                self.events
                    .push(json!({"t": t, "class": "S", "kind": "Grid boundary (held)",
                    "v_line_V": v_line, "frequency_hz": frequency_hz, "rows_entered": rows}));
                Ok(())
            }
            Err(reason) => self.restart_at(
                Discrete::TimeEvent,
                &format!("Grid boundary (R by S3-D4: {reason})"),
            ),
        }
    }

    /// Advance to `t1` (stop there when asked); the receipt's quadratures
    /// at `t1`.
    fn advance(&mut self, t1: f64, stop: bool) -> Result<Vec<f64>, String> {
        if !(t1.is_finite() && t1 > self.t) {
            return Err(format!("t1 {t1} is not after {}", self.t));
        }
        if stop && self.internal > t1 {
            return Err(format!(
                "cannot stop at {t1} s: the integrator stands at {} s",
                self.internal
            ));
        }
        self.view = None;
        loop {
            if self.internal > t1 {
                let (mut y, mut yp, mut q) =
                    (self.y.clone(), self.yp.clone(), vec![0.; self.q.len()]);
                self.ida.dense_output(t1, &mut y, &mut yp)?;
                self.ida.quadratures_at(t1, &mut q)?;
                self.view = Some((t1, y, yp, q));
                break;
            }
            self.settle()?;
            if self.internal >= t1 {
                break;
            }
            let forced = match (self.boundary(), stop) {
                (Some(b), true) => Some(b.min(t1)),
                (Some(b), false) => Some(b),
                (None, true) => Some(t1),
                (None, false) => None,
            };
            let tout = forced.unwrap_or(self.internal + 3600.);
            if let Some(b) = forced {
                self.ida.stop_at(b)?;
            }
            let event = self
                .ida
                .system()
                .next_time_event(self.internal)
                .filter(|e| *e > self.internal);
            match self.ida.step(tout, &mut self.y, &mut self.yp)? {
                Advance::Root { time, directions } => {
                    self.internal = time;
                    self.deferred = Some(Deferred::Roots(directions));
                }
                Advance::Reached(time) => {
                    self.internal = time;
                    if forced == Some(time) {
                        self.carried.forced_stops += 1;
                        self.deferred = Some(Deferred::Boundary {
                            event: event == Some(time),
                        });
                    }
                }
            }
        }
        self.t = t1;
        let mut q = vec![0.; self.q.len()];
        if self.internal == t1 {
            self.ida.quadratures(&mut q)?;
        } else {
            q.clone_from(&self.view.as_ref().ok_or("no view at t1")?.3);
        }
        Ok(q)
    }

    fn state_at_t(&self) -> Result<(Vec<f64>, Vec<f64>), String> {
        if self.internal == self.t {
            return Ok((self.y.clone(), self.yp.clone()));
        }
        match &self.view {
            Some((t, y, yp, _)) if *t == self.t => Ok((y.clone(), yp.clone())),
            _ => Err(format!("no state at {} s", self.t)),
        }
    }

    fn observe(&mut self) -> Result<Vec<f64>, String> {
        let (y, yp) = self.state_at_t()?;
        let (t, n) = (self.t, self.n);
        let joined = &mut self.ida.system_mut().integrated_mut().joined;
        joined
            .evaluate(t, &y[..n], &yp[..n], None, 0., None)
            .map_err(|e| format!("{e:?}"))?;
        let released = joined.heats().nuclear.released_w.value;
        let pt1 = joined
            .network
            .pzr_taps()
            .map_or(f64::NAN, |x| x.pt1_pa.value);
        Ok(vec![released, pt1])
    }

    /// One exchange: the Grid's boundary at the unit's time, advance, receipt.
    #[allow(clippy::too_many_arguments)] // One exchange: interval, mode and the Grid's boundary.
    fn exchange(
        &mut self,
        t1: f64,
        stop: bool,
        observe: bool,
        energized: bool,
        voltage_pu: f64,
        frequency_hz: f64,
        out: &mut Vec<u8>,
    ) -> Result<(), String> {
        let t0 = self.t;
        self.events.clear();
        let rewound =
            !energized && self.internal > self.t && self.ida.system().offsite_loss_s.is_none();
        let mut q0 = vec![0.; self.q.len()];
        if self.internal == self.t {
            self.ida.quadratures(&mut q0)?;
        } else {
            q0.clone_from(&self.view.as_ref().ok_or("no view at t0")?.3);
        }
        self.boundary_change(energized, voltage_pu, frequency_hz)?;
        let q1 = self.advance(t1, stop)?;
        let (y, _) = self.state_at_t()?;
        let n = self.n;
        let u = self.ida.system();
        let export_w = u.slice.export_w(&y[n..]);
        let rcp = {
            let net = &u.integrated().joined.network;
            (0..net.rotor_count())
                .filter(|r| {
                    matches!(
                        net.rotor_state(*r).map(|s| s.support),
                        Some(leitbild_operating_plant::rotor::Support::Supported(_))
                    )
                })
                .count()
        };
        let log: Vec<Value> = u.log[self.log_seen..]
            .iter()
            .map(|(t, s)| json!({"t": t, "event": s}))
            .collect();
        self.log_seen = u.log.len();
        let joined = u.slice.inputs.joined;
        let lost = u.offsite_loss_s.is_some();
        let c = self.counts();
        for v in [
            t0,
            t1,
            self.internal,
            q1[EXPORT] - q0[EXPORT],
            q1[UNIT_DRAW] - q0[UNIT_DRAW],
            q1[RESERVE_DRAW] - q0[RESERVE_DRAW],
            q1[EXPORT],
            export_w,
            y[n + slice::OMEGA],
            f64::from(u8::from(joined)),
            f64::from(u8::from(lost)),
            rcp as f64,
            u.arc_heat_j,
            f64::from(u8::from(rewound)),
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in [
            c.steps,
            c.jacobians,
            c.residuals,
            c.error_failures,
            c.convergence_failures,
            c.restarts,
            c.held_s,
            c.forced_stops,
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let signals = if observe { self.observe()? } else { Vec::new() };
        out.extend_from_slice(&(signals.len() as u32).to_le_bytes());
        for v in signals {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let events = if self.events.is_empty() && log.is_empty() {
            Vec::new()
        } else {
            serde_json::to_vec(&json!({"restarts": self.events, "log": log})).unwrap()
        };
        out.extend_from_slice(&(events.len() as u32).to_le_bytes());
        out.extend_from_slice(&events);
        Ok(())
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

fn handle(
    host: &mut Option<Host>,
    op: u8,
    payload: &[u8],
    out: &mut Vec<u8>,
) -> Result<bool, String> {
    let mut r = Reader {
        bytes: payload,
        at: 0,
    };
    match op {
        1 => {
            let config: Value =
                serde_json::from_slice(payload).map_err(|e| format!("LOAD JSON: {e}"))?;
            let state = config["state"].as_str().ok_or("LOAD needs {state}")?;
            let (h, reply) = Host::load(state)?;
            out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
            *host = Some(h);
        }
        3 => {
            let t = r.f64()?;
            let kind = r.u8()?;
            let index = r.u32()? as usize;
            let h = host.as_mut().ok_or("no unit is loaded")?;
            if !(t.is_finite() && t > h.internal) {
                return Err(format!(
                    "{t} s is behind the integrator ({} s): commands and stops are prospective",
                    h.internal
                ));
            }
            let command = match kind {
                0 => {
                    if !h.stops.contains(&t) {
                        h.stops.push(t);
                        h.stops.sort_by(f64::total_cmp);
                    }
                    return Ok(false);
                }
                1 => Command::TurbineTrip,
                2 => Command::ManualReactorTrip,
                6 => Command::SupplyLoss { rotor: index },
                other => return Err(format!("unknown command kind {other}")),
            };
            h.pending.push((t, command));
            h.pending.sort_by(|a, b| a.0.total_cmp(&b.0));
        }
        12 => {
            let t1 = r.f64()?;
            let stop = r.u8()? != 0;
            let observe = r.u8()? != 0;
            let energized = r.u8()? != 0;
            let voltage_pu = r.f64()?;
            let frequency_hz = r.f64()?;
            let h = host.as_mut().ok_or("no unit is loaded")?;
            h.exchange(t1, stop, observe, energized, voltage_pu, frequency_hz, out)?;
        }
        7 => out.extend_from_slice(payload),
        9 => return Ok(true),
        10 => {
            let reply = json!({"process_cpu_s": time::process_s(), "max_rss_bytes": time::max_rss_bytes(),
                "t": host.as_ref().map(|h| h.t)});
            out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
        }
        other => return Err(format!("unknown op {other}")),
    }
    Ok(false)
}

fn write_frame(w: &mut impl Write, status: u8, seq: u32, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&((5 + payload.len()) as u32).to_le_bytes())?;
    w.write_all(&[status])?;
    w.write_all(&seq.to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

fn main() {
    let mut host: Option<Host> = None;
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
        let (op, seq) = (body[0], u32::from_le_bytes(body[1..5].try_into().unwrap()));
        let (c0, w0) = (time::thread_s(), Instant::now());
        let mut data = Vec::new();
        let outcome = handle(&mut host, op, &body[5..], &mut data);
        let (wall, cpu) = (w0.elapsed().as_secs_f64(), time::thread_s() - c0);
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

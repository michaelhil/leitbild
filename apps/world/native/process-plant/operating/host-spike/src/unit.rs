//! spec: world/packs/process-plant/reference-designs/ld-01/model/numerics-and-realization.md#what-must-survive-copy-pause-and-restore
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s1-declaration-hydraulics-admission
//! One S1 hydraulics unit advanced in caller-driven time: the S1 harness's
//! declared preparation, tolerances, order cap and exact consistent start,
//! behind a narrow load / advance / command / observe / snapshot / restore
//! surface. TEST-ONLY integration spike; it adds no physics, solver option
//! or fallback, and it is never registered as a live runtime.
use crate::cpu;
use leitbild_operating_plant::digest::sha256;
use leitbild_operating_plant::{
    network::{
        ConsistentPair, Network, PzrPreparation, RotorState, ToleranceClasses, consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    network::Integrated,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Instant};

/// The water build this binary links (compile-time receipt).
const WATER_BUILD: &str = include_str!(concat!(
    env!("LD01_OPERATING_WATER_LIB_DIR"),
    "/water-build.json"
));
/// The S1 harness's declared preparation controls and consistent-start bound.
const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};
const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 8,
};
const CONSISTENT_ROW_BOUND: f64 = 1e-12;
const STOCK_NEWTON_COEFFICIENT: f64 = 0.33;
const SNAPSHOT_MAGIC: &[u8; 8] = b"LD01SPK1";

/// The S1 gates block fields this unit uses (`ld01-s1-gates`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gates {
    pub relative_tolerance: f64,
    pub stock_scaled_absolute: f64,
    pub tracer_scaled_absolute: f64,
    pub rotor_scaled_absolute: f64,
    #[serde(rename = "volumeFlowAbsolute_m3_s")]
    pub volume_flow_absolute_m3_s: f64,
    pub max_order: usize,
}

/// What the caller names at load: the compiled packet and the wiki root the
/// gates are read from. `kernel` identifies the executable (binary hash).
#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    pub packet: PathBuf,
    pub wiki: PathBuf,
}

/// Everything a snapshot is bound to. A restore refuses any difference.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    pub packet_sha256: String,
    pub gates_sha256: String,
    pub water_library_sha256: String,
    pub kernel: String,
}

/// How one advance treats the requested boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Stock IDA_NORMAL: the integrator may step past the boundary and the
    /// boundary state is its interpolant. History is retained.
    Interpolate,
    /// A stop at the boundary (IDASetStopTime): the boundary is an accepted
    /// step end, history retained. What a held-input change needs.
    Stop,
    /// Stop, then the S1 harness's exact consistent restart (IDAReInit).
    Restart,
    /// Stop, then drop the solver and rebuild it from the boundary truth on a
    /// fresh network, exactly as a restore does.
    Rebuild,
}
impl Mode {
    pub fn from_code(code: u8) -> Result<Self, String> {
        match code {
            0 => Ok(Self::Interpolate),
            1 => Ok(Self::Stop),
            2 => Ok(Self::Restart),
            3 => Ok(Self::Rebuild),
            other => Err(format!("unknown advance mode {other}")),
        }
    }
}

/// A prospective discrete command: rotor `rotor`'s motive supply at `t`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub t: f64,
    pub rotor: usize,
    pub supported: bool,
}

#[derive(Clone, Copy, Debug)]
struct Taps {
    loop_faces: [usize; 2],
    lower: usize,
    upper: usize,
}
pub const SIGNALS: [&str; 10] = [
    "pzr_roof_pa",
    "pzr_collapsed_level_m",
    "core_dp_pa",
    "loop_a_kg_s",
    "loop_b_kg_s",
    "rcp0_omega_rad_s",
    "rcp1_omega_rad_s",
    "rcp2_omega_rad_s",
    "rcp3_omega_rad_s",
    "energy_identity_w",
];

/// Cumulative stock counters across restarts (IDAReInit restarts stock's).
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Counts {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    pub restarts: i64,
    pub rebuilds: i64,
}

/// One advance's outcome and cost.
#[derive(Clone, Debug, Serialize)]
pub struct AdvanceReport {
    pub t: f64,
    pub internal_t: f64,
    pub counts: Counts,
    pub commands_applied: usize,
    pub cpu_s: f64,
    pub wall_s: f64,
}

/// Timings of a load or restore, split by phase.
#[derive(Clone, Debug, Serialize)]
pub struct StartReport {
    pub dimension: usize,
    pub t: f64,
    pub compile_s: f64,
    pub prepare_s: f64,
    pub consistent_start_s: f64,
    pub solver_s: f64,
    pub cpu_s: f64,
    pub wall_s: f64,
    pub pair: Value,
}

pub struct Unit {
    identity: Identity,
    gates: Gates,
    packet: Packet,
    taps: Taps,
    ida: Ida<Integrated<If97>>,
    probe: Network<If97>,
    y: Vec<f64>,
    yp: Vec<f64>,
    t: f64,
    ids: Vec<f64>,
    atol: Vec<f64>,
    stocks: Vec<usize>,
    rotors: Vec<RotorState>,
    pending: Vec<Command>,
    carried: Counts,
}

fn strict_block(page: &std::path::Path, fence: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(page).map_err(|e| format!("{}: {e}", page.display()))?;
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .ok_or_else(|| format!("no {fence} block in {}", page.display()))?
        + open.len();
    let end = start
        + text[start..]
            .find("\n```")
            .ok_or_else(|| format!("unterminated {fence} block"))?;
    Ok(text[start..end].to_string())
}

fn water_library_sha256() -> Result<String, String> {
    let receipt: Value =
        serde_json::from_str(WATER_BUILD).map_err(|e| format!("water receipt: {e}"))?;
    receipt["librarySha256"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "water receipt has no librarySha256".into())
}

fn taps(packet: &Packet) -> Result<Taps, String> {
    let face = |id: &str| {
        packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .ok_or_else(|| format!("no face {id}"))
    };
    let region = |id: &str| {
        packet
            .mechanics
            .regions
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| format!("no region {id}"))
    };
    Ok(Taps {
        loop_faces: [face("RETURN.A->DOWN")?, face("RETURN.B->DOWN")?],
        lower: region("LOWER")?,
        upper: region("UPPER")?,
    })
}

fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

fn failure(e: impl std::fmt::Debug) -> String {
    format!("{e:?}")
}

fn rotor_code(state: RotorState) -> Result<u8, String> {
    match (state.support, state.shaft) {
        (Support::Supported(SpeedRequest::Nominal), Shaft::Free) => Ok(0),
        (Support::Unsupported, Shaft::Free) => Ok(1),
        other => Err(format!("rotor mode {other:?} is outside this spike")),
    }
}
fn rotor_state(code: u8) -> Result<RotorState, String> {
    let support = match code {
        0 => Support::Supported(SpeedRequest::Nominal),
        1 => Support::Unsupported,
        other => return Err(format!("unknown rotor mode code {other}")),
    };
    Ok(RotorState {
        support,
        shaft: Shaft::Free,
    })
}

/// The declared inputs of one unit: packet, gates and identity.
struct Declared {
    packet: Packet,
    gates: Gates,
    identity: Identity,
    taps: Taps,
}
fn declared(config: &Config, kernel: &str) -> Result<Declared, String> {
    let bytes = std::fs::read(&config.packet)
        .map_err(|e| format!("packet {}: {e}", config.packet.display()))?;
    let packet: Packet = serde_json::from_slice(&bytes).map_err(|e| format!("packet: {e}"))?;
    let gates_text = strict_block(
        &config
            .wiki
            .join("world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md"),
        "ld01-s1-gates",
    )?;
    let gates: Gates =
        serde_json::from_str(&gates_text).map_err(|e| format!("S1 gates block: {e}"))?;
    let identity = Identity {
        packet_sha256: sha256(&bytes),
        gates_sha256: sha256(gates_text.as_bytes()),
        water_library_sha256: water_library_sha256()?,
        kernel: kernel.to_string(),
    };
    let taps = taps(&packet)?;
    Ok(Declared {
        packet,
        gates,
        identity,
        taps,
    })
}

/// A fresh compiled network in the given rotor modes (the harness's `fresh`).
fn fresh(packet: &Packet, rotors: &[RotorState]) -> Result<(Network<If97>, Vec<f64>), String> {
    let (mut network, prepared) = Network::new(packet, If97, &PZR).map_err(failure)?;
    if rotors.len() != network.rotor_count() {
        return Err("rotor mode count".into());
    }
    for (r, state) in rotors.iter().enumerate() {
        network.set_rotor_state(r, *state);
    }
    Ok((network, prepared.differential))
}

/// Stock IDA on the colored assembly from a consistent pair, configured as
/// the S1 harness configures a segment (order cap, nonnegative stocks; the
/// stock Newton coefficient and no step cap are stock's defaults).
#[allow(clippy::too_many_arguments)] // One segment start: system, pair, identity, tolerances.
fn solver(
    network: Network<If97>,
    t: f64,
    y: &[f64],
    yp: &[f64],
    ids: &[f64],
    atol: &[f64],
    gates: &Gates,
    stocks: &[usize],
) -> Result<Ida<Integrated<If97>>, String> {
    let mut ida = Ida::new(
        Integrated::colored(network)?,
        Initial {
            time: t,
            y,
            yp,
            differential: ids,
            absolute_tolerance: atol,
            relative_tolerance: gates.relative_tolerance,
        },
    )?;
    ida.set_max_order(gates.max_order)?;
    ida.constrain_nonnegative(stocks)?;
    Ok(ida)
}

fn pair_json(pair: &ConsistentPair) -> Value {
    json!({
        "residual": pair.residual.value,
        "constraint_rate": pair.constraint_rate.value,
        "correction_wrms": pair.projection.as_ref().map(|p| p.correction_wrms),
        "placements": pair.placements.len(),
    })
}

impl Unit {
    /// The S1 harness's prepared state (RCPs at rest, nominal request), its
    /// tolerances, then the exact consistent start at t = 0.
    pub fn load(config: &Config, kernel: &str) -> Result<(Self, StartReport), String> {
        let (cpu0, wall0) = (cpu::thread_s(), Instant::now());
        let d = declared(config, kernel)?;
        let compile_s = wall0.elapsed().as_secs_f64();
        let rotors = vec![rotor_state(0)?; 4];
        let mark = Instant::now();
        let point = OperatingPoint::from(&d.packet.preparation.operating_point);
        let (mut network, prepared, _) =
            prepare::prepare(&d.packet, If97, &point, &rotors, &SETTINGS).map_err(failure)?;
        let mut y = prepared.y.clone();
        for index in &network.rotor_index {
            y[*index] = 0.;
        }
        let g = &d.gates;
        let atol = network
            .absolute_tolerances(
                &y,
                ToleranceClasses {
                    relative: g.relative_tolerance,
                    stock_scaled: g.stock_scaled_absolute,
                    tracer_scaled: g.tracer_scaled_absolute,
                    rotor_scaled: g.rotor_scaled_absolute,
                    volume_flow_m3_s: g.volume_flow_absolute_m3_s,
                },
            )
            .map_err(failure)?;
        let ids = prepared.differential.clone();
        let prepare_s = mark.elapsed().as_secs_f64();
        let mark = Instant::now();
        let weights = error_weights(&y, g.relative_tolerance, &atol);
        let (yp, pair) = consistent_start(
            &mut network,
            0.,
            &mut y,
            &ids,
            &weights,
            CONSISTENT_ROW_BOUND,
            2,
        )
        .map_err(|e| format!("consistent start at t=0: {e:?}"))?;
        let consistent_start_s = mark.elapsed().as_secs_f64();
        let mark = Instant::now();
        let stocks = network.nonnegative_stocks();
        let ida = solver(network, 0., &y, &yp, &ids, &atol, g, &stocks)?;
        let (probe, probe_ids) = fresh(&d.packet, &rotors)?;
        if probe_ids != ids {
            return Err(
                "a fresh network's differential identity differs from the prepared one".into(),
            );
        }
        let solver_s = mark.elapsed().as_secs_f64();
        let unit = Self {
            identity: d.identity,
            gates: d.gates,
            packet: d.packet,
            taps: d.taps,
            ida,
            probe,
            y,
            yp,
            t: 0.,
            ids,
            atol,
            stocks,
            rotors,
            pending: Vec::new(),
            carried: Counts::default(),
        };
        let report = StartReport {
            dimension: unit.y.len(),
            t: 0.,
            compile_s,
            prepare_s,
            consistent_start_s,
            solver_s,
            cpu_s: cpu::thread_s() - cpu0,
            wall_s: wall0.elapsed().as_secs_f64(),
            pair: pair_json(&pair),
        };
        Ok((unit, report))
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    pub fn time(&self) -> f64 {
        self.t
    }
    pub fn dimension(&self) -> usize {
        self.y.len()
    }
    /// The drive law's reference speed, rad/s (settling criterion).
    pub fn reference_omega(&self) -> f64 {
        self.probe.drive().reference_omega_rad_s
    }

    /// Queue a prospective command; it must lie strictly in the future.
    pub fn command(&mut self, command: Command) -> Result<(), String> {
        if !(command.t.is_finite() && command.t > self.t) {
            return Err(format!(
                "command at t={} is not after the unit's time {}",
                command.t, self.t
            ));
        }
        if command.rotor >= self.rotors.len() {
            return Err(format!("no rotor {}", command.rotor));
        }
        self.pending.push(command);
        self.pending.sort_by(|a, b| a.t.total_cmp(&b.t));
        Ok(())
    }

    fn counts(&self) -> Result<Counts, String> {
        let s = self.ida.stats()?;
        let c = self.carried;
        Ok(Counts {
            steps: c.steps + s.steps,
            residuals: c.residuals + s.residuals,
            jacobians: c.jacobians + s.jacobians,
            nonlinear_iterations: c.nonlinear_iterations + s.nonlinear_iterations,
            error_failures: c.error_failures + s.error_failures,
            convergence_failures: c.convergence_failures + s.convergence_failures,
            restarts: c.restarts,
            rebuilds: c.rebuilds,
        })
    }
    /// Fold the current stock counters into the carried totals before a
    /// restart or rebuild resets them.
    fn carry(&mut self) -> Result<(), String> {
        let restarts = self.carried.restarts;
        let rebuilds = self.carried.rebuilds;
        self.carried = self.counts()?;
        self.carried.restarts = restarts;
        self.carried.rebuilds = rebuilds;
        Ok(())
    }

    /// The S1 harness's restart at the unit's boundary state: exact
    /// consistent start, IDAReInit, stock coefficient, no step cap, order cap
    /// and nonnegative stocks.
    fn restart(&mut self) -> Result<(), String> {
        self.carry()?;
        let weights = error_weights(&self.y, self.gates.relative_tolerance, &self.atol);
        let mut projected = self.y.clone();
        let (rates, _) = consistent_start(
            &mut self.ida.system_mut().network,
            self.t,
            &mut projected,
            &self.ids,
            &weights,
            CONSISTENT_ROW_BOUND,
            2,
        )
        .map_err(|e| format!("exact consistent restart at t={}: {e:?}", self.t))?;
        self.ida.reinitialize(self.t, &projected, &rates)?;
        self.ida
            .set_nonlinear_convergence_coefficient(STOCK_NEWTON_COEFFICIENT)?;
        self.ida.set_max_step(f64::INFINITY)?;
        self.ida.set_max_order(self.gates.max_order)?;
        self.ida.constrain_nonnegative(&self.stocks)?;
        self.y = projected;
        self.yp = rates;
        self.carried.restarts += 1;
        Ok(())
    }

    /// Drop the solver and network and rebuild both from the boundary truth
    /// (y, discrete modes, tolerances), as a restore does.
    fn rebuild(&mut self) -> Result<(), String> {
        self.carry()?;
        let (mut network, ids) = fresh(&self.packet, &self.rotors)?;
        if ids != self.ids {
            return Err("rebuilt differential identity differs".into());
        }
        let weights = error_weights(&self.y, self.gates.relative_tolerance, &self.atol);
        let mut projected = self.y.clone();
        let (rates, _) = consistent_start(
            &mut network,
            self.t,
            &mut projected,
            &self.ids,
            &weights,
            CONSISTENT_ROW_BOUND,
            2,
        )
        .map_err(|e| format!("exact consistent start at t={}: {e:?}", self.t))?;
        self.ida = solver(
            network,
            self.t,
            &projected,
            &rates,
            &self.ids,
            &self.atol,
            &self.gates,
            &self.stocks,
        )?;
        self.y = projected;
        self.yp = rates;
        self.carried.rebuilds += 1;
        Ok(())
    }

    /// Advance to the boundary `end`, stopping exactly at `end` when `stop`.
    fn segment(&mut self, end: f64, stop: bool) -> Result<(), String> {
        let internal = self.ida.stats()?.internal_time;
        if stop && end > internal {
            self.ida.stop_at(end)?;
        }
        match self.ida.advance(end, &mut self.y, &mut self.yp)? {
            Advance::Reached(t) => {
                self.t = t;
                Ok(())
            }
            Advance::Root { time, .. } => Err(format!("unexpected root at {time} s")),
        }
    }

    /// Advance to `target`. Pending commands inside the interval split it at
    /// their exact times: the unit stops there (or, when stock has already
    /// stepped past, takes its interpolant), applies the command and
    /// restarts by the exact consistent start, then continues.
    pub fn advance(&mut self, target: f64, mode: Mode) -> Result<AdvanceReport, String> {
        if !(target.is_finite() && target > self.t) {
            return Err(format!("target {target} is not after {}", self.t));
        }
        let (cpu0, wall0) = (cpu::thread_s(), Instant::now());
        let mut applied = 0;
        while let Some(command) = self.pending.first().copied().filter(|c| c.t <= target) {
            self.segment(command.t, true)?;
            self.pending.remove(0);
            let state = rotor_state(if command.supported { 0 } else { 1 })?;
            self.rotors[command.rotor] = state;
            self.ida
                .system_mut()
                .network
                .set_rotor_state(command.rotor, state);
            self.probe.set_rotor_state(command.rotor, state);
            self.restart()?;
            applied += 1;
        }
        if target > self.t {
            self.segment(target, mode != Mode::Interpolate)?;
        }
        match mode {
            Mode::Restart => self.restart()?,
            Mode::Rebuild => self.rebuild()?,
            Mode::Interpolate | Mode::Stop => {}
        }
        let internal_t = self.ida.stats()?.internal_time;
        Ok(AdvanceReport {
            t: self.t,
            internal_t,
            counts: self.counts()?,
            commands_applied: applied,
            cpu_s: cpu::thread_s() - cpu0,
            wall_s: wall0.elapsed().as_secs_f64(),
        })
    }

    /// The observed signals at the boundary state, from a probe evaluation
    /// (the integrated network and solver history are untouched).
    pub fn observe(&mut self, out: &mut [f64]) -> Result<(), String> {
        if out.len() < SIGNALS.len() {
            return Err("signal buffer too small".into());
        }
        let p = &mut self.probe;
        p.evaluate(self.t, &self.y, &self.yp, None, 0., None)
            .map_err(|e| format!("observation at t={}: {e:?}", self.t))?;
        let pzr = p.pzr_taps().map_err(failure)?;
        out[0] = pzr.pt1_pa.value;
        out[1] = pzr.collapsed_level_m.value;
        out[2] = p.cell(self.taps.lower).pressure.value - p.cell(self.taps.upper).pressure.value;
        for (k, face) in self.taps.loop_faces.iter().enumerate() {
            out[3 + k] = p.chart(*face, 0).map_or(0., |c| c.mass_flow_kg_s.value);
        }
        let scale = p.scales().to_vec();
        let inertia = p.rotor_inertia();
        for (k, i) in p.rotor_index.clone().iter().enumerate().take(4) {
            out[5 + k] = self.y[*i] * scale[*i] / inertia;
        }
        let budget = p.current_budget(&self.y, &self.yp);
        out[9] = budget["fluid_plus_rotor_plus_bearing_minus_motor_w"]
            .as_f64()
            .unwrap_or(f64::NAN);
        Ok(())
    }

    /// The copyable truth at the boundary: identity, time, discrete modes,
    /// pending commands, y, y' and the preparation's absolute tolerances.
    /// Solver history and factorizations are caches and are not included.
    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        let rotors = self
            .rotors
            .iter()
            .map(|r| rotor_code(*r))
            .collect::<Result<Vec<_>, _>>()?;
        let header = serde_json::to_vec(&json!({
            "identity": self.identity,
            "t": self.t,
            "n": self.y.len(),
            "rotors": rotors,
            "pending": self.pending,
        }))
        .map_err(|e| e.to_string())?;
        let n = self.y.len();
        let mut blob = Vec::with_capacity(12 + header.len() + 24 * n);
        blob.extend_from_slice(SNAPSHOT_MAGIC);
        blob.extend_from_slice(&(header.len() as u32).to_le_bytes());
        blob.extend_from_slice(&header);
        for v in self.y.iter().chain(&self.yp).chain(&self.atol) {
            blob.extend_from_slice(&v.to_le_bytes());
        }
        Ok(blob)
    }

    /// Restore a unit from a snapshot of the same identity: fresh network in
    /// the snapshot's modes, exact consistent start at its (t, y), new stock
    /// solver. Any identity difference refuses; nothing is migrated.
    pub fn restore(
        config: &Config,
        kernel: &str,
        blob: &[u8],
    ) -> Result<(Self, StartReport), String> {
        let (cpu0, wall0) = (cpu::thread_s(), Instant::now());
        if blob.len() < 12 || &blob[..8] != SNAPSHOT_MAGIC {
            return Err("not an LD-01 spike snapshot".into());
        }
        let length = u32::from_le_bytes(blob[8..12].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(
            blob.get(12..12 + length)
                .ok_or("truncated snapshot header")?,
        )
        .map_err(|e| format!("snapshot header: {e}"))?;
        let d = declared(config, kernel)?;
        let identity: Identity = serde_json::from_value(header["identity"].clone())
            .map_err(|e| format!("snapshot identity: {e}"))?;
        if identity != d.identity {
            return Err(format!(
                "snapshot identity {identity:?} differs from this unit's {:?}",
                d.identity
            ));
        }
        let n = header["n"].as_u64().ok_or("snapshot n")? as usize;
        let t = header["t"].as_f64().ok_or("snapshot t")?;
        let body = &blob[12 + length..];
        if body.len() != 24 * n {
            return Err(format!(
                "snapshot body {} bytes, expected {}",
                body.len(),
                24 * n
            ));
        }
        let values: Vec<f64> = body
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let (mut y, _yp_saved, atol) = (
            values[..n].to_vec(),
            values[n..2 * n].to_vec(),
            values[2 * n..].to_vec(),
        );
        let rotors = header["rotors"]
            .as_array()
            .ok_or("snapshot rotors")?
            .iter()
            .map(|c| rotor_state(c.as_u64().unwrap_or(u64::MAX) as u8))
            .collect::<Result<Vec<_>, _>>()?;
        let pending: Vec<Command> = serde_json::from_value(header["pending"].clone())
            .map_err(|e| format!("snapshot pending: {e}"))?;
        let compile_s = wall0.elapsed().as_secs_f64();
        let mark = Instant::now();
        let (mut network, ids) = fresh(&d.packet, &rotors)?;
        if network.dimension() != n {
            return Err("snapshot dimension differs from the compiled network".into());
        }
        let prepare_s = mark.elapsed().as_secs_f64();
        let mark = Instant::now();
        let weights = error_weights(&y, d.gates.relative_tolerance, &atol);
        let (yp, pair) = consistent_start(
            &mut network,
            t,
            &mut y,
            &ids,
            &weights,
            CONSISTENT_ROW_BOUND,
            2,
        )
        .map_err(|e| format!("restore consistent start at t={t}: {e:?}"))?;
        let consistent_start_s = mark.elapsed().as_secs_f64();
        let mark = Instant::now();
        let stocks = network.nonnegative_stocks();
        let ida = solver(network, t, &y, &yp, &ids, &atol, &d.gates, &stocks)?;
        let (probe, _) = fresh(&d.packet, &rotors)?;
        let solver_s = mark.elapsed().as_secs_f64();
        let unit = Self {
            identity: d.identity,
            gates: d.gates,
            packet: d.packet,
            taps: d.taps,
            ida,
            probe,
            y,
            yp,
            t,
            ids,
            atol,
            stocks,
            rotors,
            pending,
            carried: Counts::default(),
        };
        let report = StartReport {
            dimension: n,
            t,
            compile_s,
            prepare_s,
            consistent_start_s,
            solver_s,
            cpu_s: cpu::thread_s() - cpu0,
            wall_s: wall0.elapsed().as_secs_f64(),
            pair: pair_json(&pair),
        };
        Ok((unit, report))
    }

    /// The boundary state's coordinates, for bitwise comparisons.
    pub fn state(&self) -> (&[f64], &[f64]) {
        (&self.y, &self.yp)
    }
}

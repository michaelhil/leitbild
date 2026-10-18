//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#selected-electrical-interval-handoff
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#external-carrier-and-operating-grid-join
//! TEST-ONLY child-process host of one S3 unit with ELEC's slice (C5X lane,
//! owner decisions D1 + D2), speaking the plant side of the plant <-> Grid
//! interval exchange on stdin/stdout. Never registered in a Pack, the
//! Runtime Hub or the deployer (owner F4: live registration not approved).
//!
//! **Composition.** The full S3 composition as KERN's settle and the S3
//! cases build it (`common/s3_unit.rs`, included unchanged): the joined
//! operator with the spray line closed, the SG two-zone map, the feed gate,
//! S2-D24r/S3-D16 derived classes, L1 and phase modes, IC-CTRL's PZR
//! pressure control in AUTO (class S), ELEC's slice connected; started from
//! KERN's saved S3 state by the exact consistent start. It advances on
//! IC-PROT's frame driver with the acquired protection and the PZR
//! controller as clients (0.1 s frame, stock IDA_ONE_STEP, classes R/S/O
//! counted by kind); the driver carries the slice's IDAS quadratures across
//! every restart (KERN 1e581c97). The generator page's ACT.B field
//! controller (ICFIELD, `electrical::field` from the packet's
//! `fieldProtection`) is a third client.
//!
//! **Exchange** (`[t0, t1)`, ordered-join phase 1). The request carries the
//! Grid's committed boundary for the interval and the interval itself; the
//! Grid side alone declares whether the interval lies in a grid-event
//! window (D1: 1 s quiet, 20 ms in windows; the plant never infers one).
//! The boundary is decided at `t0` through the driver (`Driver::decide`):
//! - **Energized**: voltage and the carrier (D2 + R6-K SW-1). The Grid holds
//!   its frequency `f` and frequency rate `fdot` over the interval; the
//!   carrier rate is `2*pi*f + e/(t1 - t0) + 2*pi*fdot*(t - t0)`, with `e`
//!   the Grid's accepted carrier phase at `t0` less the phase the plant
//!   followed (`slice::carrier_rate`). A boundary that agrees with the held
//!   prediction of a steady Grid (same voltage and frequency, `fdot = 0`,
//!   `e = 0`) changes no bit of the inputs and is **no event**. Any other
//!   boundary (a frequency or rate mismatch, a new slope) is a held input
//!   entering only the angle's rate row, class S by S3-D4's rule, checked by
//!   the driver at the exact stop (a refusal is an error, never a
//!   reclassification).
//! - **Dead** (first time): S3-D10's offsite loss, class R (stator
//!   separated through the passive arc limit, both sources dead). The
//!   field converter on AC.B is then unsupplied; the field controller
//!   acquires the loss at its next frame and requests GCB OPEN plus an
//!   acquired turbine trip at its decision (ICFIELD; no declared input:
//!   the reactor-trip request travels the acquired path).
//! - **Dead again**: no change. **Restoration** is refused (not in S3).
//!
//! The unit then advances to `t1` on the driver, frame by frame (rule I,
//! D3 (a), judged at each frame instant as the S3 cases do), and stops at
//! `t1`: the PZR controller stops the integrator at every frame anyway, so
//! a quiet 1 s boundary adds no stop, and a 20 ms window boundary bounds
//! the step as decision 0015 E2's window cap does. The reply is the
//! interval receipt: the slice's IDAS quadratures over `[t0, t1]`
//! (generator export, unit and reserve auxiliary draws; telescoping to the
//! cumulative quadrature), the terminal export at `t1`, the breaker, the
//! offsite latch, RCP supports, shaft speed, counts by class and CPU.
//!
//! Frames as the other hosts; status 1 is an explicit refusal.
//! | op | request | reply data |
//! |---|---|---|
//! | 1 LOAD | JSON `{state, tolerance_factor, max_step_s, event_window}` | JSON |
//! | 12 EXCHANGE | `f64 t1, u8 window, u8 observe, u8 energized, f64 voltage_pu, f64 frequency_hz, f64 phase_error_rad, f64 frequency_rate_hz_s` | `16 x f64, 15 x i64 (counts, BDF orders, instructions and cycles), u32 n, n x f64 signals, u32 m, m bytes JSON events` |
//! | 13 REPORT | `f64 zero` (the case's t = 0) | JSON (counts, instants, protection, timeline, rule I) |
//! | 7 PING, 9 CLOSE, 10 STATUS | as the other hosts | |
#![allow(dead_code)]

use leitbild_ld01_host_spike::{KERNEL_SOURCE_SHA256, cpu as time};
use leitbild_operating_plant::{
    electrical::{
        field,
        slice::{self, CarrierLaw},
    },
    joined::post_trip_domain::Extension,
    rotor::Support,
};
use leitbild_operating_water::{
    frame::{Action, COUNTER_NAMES, Change, Class, Diagnostic, MatrixRebuild},
    joined::JoinedSystem,
    unit::{
        inputs::Inputs,
        plant::{self, Boundary, Plant},
        profile::Weights,
        s3::{self, Unit},
        timeline,
    },
};
use serde_json::{Value, json};
use std::io::{BufReader, BufWriter, Read, Write};
use std::time::Instant;

/// Quadrature indices of the receipt (slice::QUADRATURES order).
const EXPORT: usize = 0;
const UNIT_DRAW: usize = 8;
const RESERVE_DRAW: usize = 9;

fn read_json(path: &str) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?)
        .map_err(|e| format!("{path}: {e}"))
}

/// Rule I (owner A4): D3 (a) judged at each frame instant on the solver's
/// state there, as the S3 cases judge it, with B1's per-core-region phase
/// absence (`Joined::region_phases`).
#[derive(Default)]
struct RuleI {
    samples: u64,
    first_extended: Option<f64>,
    margin_failures: u64,
    exit: Option<Value>,
    cpu_s: f64,
    instructions: u64,
}
impl RuleI {
    fn judge(
        &mut self,
        joined: &mut leitbild_operating_plant::joined::operator::Joined<
            leitbild_operating_water::If97,
        >,
        extension: &Extension,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(), String> {
        use leitbild_operating_plant::joined::post_trip_domain::{self, Domain, Error};
        let c0 = time::thread_s();
        let i0 = time::instructions_cycles().map_or(0, |x| x.0);
        joined
            .evaluate(t, y, yp, None, 0., None)
            .map_err(|e| format!("rule I: the operator at {t} s: {e:?}"))?;
        let phases = joined
            .region_phases()
            .map_err(|e| format!("rule I: region phases at {t} s: {e:?}"))?;
        self.samples += 1;
        let (label, verdict) = match post_trip_domain::admit_accepted(
            joined.nuclear(),
            &phases,
            extension,
            joined.travel(),
            t,
            0.,
        ) {
            Ok(a) => {
                self.margin_failures += u64::from(!a.margin.holds);
                if a.domain != Domain::Original && self.first_extended.is_none() {
                    self.first_extended = Some(t);
                }
                (None, format!("admitted {:?}, margin holds {}", a.domain, a.margin.holds))
            }
            Err(Error::Unsupported {
                margin_holds, exit, ..
            }) => (
                Some(if margin_holds {
                    "D3 (a) source-domain exit"
                } else {
                    "D3 (a) margin exit"
                }),
                format!("unsupported: margin holds {margin_holds}, {exit:?}"),
            ),
            Err(e) => return Err(format!("D3 (a) at {t} s: {e}")),
        };
        if self.exit.is_none()
            && let Some(label) = label
        {
            self.exit = Some(json!({"t_s": t, "label": label, "verdict": verdict}));
        }
        self.cpu_s += time::thread_s() - c0;
        self.instructions += time::instructions_cycles().map_or(0, |x| x.0) - i0;
        Ok(())
    }
}

struct Host {
    /// The frame-driven S3 unit (the unit library's): IC-PROT + PZR control
    /// + the ACT.B field controller (ICFIELD) on the frame driver.
    plant: Plant,
    /// The unit's time: the driver stands exactly here between exchanges.
    t: f64,
    v_nominal: f64,
    carrier_law: CarrierLaw,
    extension: Extension,
    rule_i: RuleI,
    log_seen: usize,
    elec_seen: usize,
    sg: Vec<(String, usize, f64)>,
    rotors: Vec<(usize, f64)>,
    observe_cpu_s: f64,
    observe_instructions: u64,
    offsite_lost_at: Option<f64>,
    exchanges: [u64; 2],
    /// The plant's own event window after the offsite loss (decision 0015
    /// E2's step cap over the case's declared window; C5 declaration), or
    /// none: `(cap_s, duration_s)`.
    event_window: Option<(f64, f64)>,
    /// The open event window's end, while its cap is in force.
    window_end: Option<f64>,
}

impl Host {
    fn load(config: &Value) -> Result<(Self, Value), String> {
        let (c0, w0) = (time::thread_s(), Instant::now());
        let state_path = config["state"].as_str().ok_or("LOAD needs {state}")?;
        // ICFIELD: the field-supply-loss trip is the field controller's, not
        // a declared case input.
        if config.get("field_supply_loss_trip_delay_s").is_some() {
            return Err("field_supply_loss_trip_delay_s: the field controller implements the trip (ICFIELD); no declared input".into());
        }
        // A refinement reference scales every tolerance, derived classes
        // included (S3 rule E: BDF2 at rtol/100); runs pass 1.
        let tolerance_factor = config["tolerance_factor"]
            .as_f64()
            .filter(|f| f.is_finite() && *f > 0. && *f <= 1.)
            .ok_or("LOAD needs tolerance_factor in (0, 1] (1 for a run)")?;
        // The refinement reference's step cap (rule E: 2.5 ms), or null.
        let max_step_s = match &config["max_step_s"] {
            Value::Null => None,
            v => Some(
                v.as_f64()
                    .filter(|h| h.is_finite() && *h > 0.)
                    .ok_or("LOAD's max_step_s is null or a positive step")?,
            ),
        };
        if config.get("max_step_s").is_none() {
            return Err("LOAD needs max_step_s (null for a run)".into());
        }
        let event_window = match config.get("event_window") {
            None => return Err("LOAD needs event_window ({cap_s, duration_s} or null)".into()),
            Some(Value::Null) => None,
            Some(w) => {
                let cap = w["cap_s"].as_f64().filter(|h| h.is_finite() && *h > 0.);
                let duration = w["duration_s"].as_f64().filter(|d| d.is_finite() && *d > 0.);
                match (cap, duration) {
                    (Some(c), Some(d)) => Some((c, d)),
                    _ => return Err("event_window needs positive cap_s and duration_s".into()),
                }
            }
        };
        if event_window.is_some() && max_step_s.is_some() {
            return Err("an event window's cap and a reference's max_step_s exclude each other".into());
        }
        let inputs = Inputs::from_env()?;
        let section = inputs.ic.clone();
        let e = read_json(&inputs.elec_path)?;
        // D2: the packet must carry the generator page's carrier selection.
        let carrier_law: CarrierLaw = serde_json::from_value(e["carrier"].clone()).map_err(|x| {
            format!("electrical packet: no owner-D2 carrier selection (ld01-generator-carrier): {x}")
        })?;
        let field_parameters: field::Parameters =
            serde_json::from_value(e["fieldProtection"].clone()).map_err(|x| {
                format!("electrical packet: no field controller timing (ld01-generator-field-protection): {x}")
            })?;
        let v_nominal = e["boundary"]["lineVoltage_V"]
            .as_f64()
            .ok_or("electrical packet: boundary.lineVoltage_V")?;
        let state = read_json(state_path)?;
        // N1's error-weight rule, explicit in LOAD (`weights`: stock |
        // grouped; absent: stock) and in the reply.
        let weights = match &config["weights"] {
            Value::Null => Weights::Stock,
            Value::String(w) => Weights::parse(w)?,
            other => return Err(format!("LOAD's weights is stock or grouped, not {other}")),
        };
        let u = s3::compose(&inputs, &state, weights)?;
        if u.receipt["from_saved_s3_state"] != json!(true) || u.receipt["spray_path"] != json!(true) {
            return Err(format!(
                "C5 starts from a saved S3 state with the spray path: {}",
                u.receipt
            ));
        }
        let packet_json: Value =
            serde_json::from_slice(&inputs.spine.packet).map_err(|x| x.to_string())?;
        let extension: Extension = serde_json::from_value(packet_json["post_trip_domain"].clone())
            .map_err(|x| format!("the packet's post_trip_domain section (D3 (a)): {x}"))?;
        let mut plant = Plant::new(
            u,
            &section,
            plant::Config {
                field: Some(&field_parameters),
                diagnostic: Diagnostic::None,
                matrix_rebuild: MatrixRebuild::Packet,
                clock: time::thread_s,
            },
        )?;
        let joined = &plant.ida.system().integrated().joined;
        let scales = joined.scales();
        let labels: Vec<String> = joined
            .layouts()
            .into_iter()
            .flat_map(|(_, l)| l.labels)
            .collect();
        let sg = labels
            .iter()
            .enumerate()
            .filter(|(_, l)| l.ends_with(".p_s"))
            .map(|(i, l)| (l.clone(), i, scales[i]))
            .collect();
        let rotors = joined
            .network
            .rotor_index
            .iter()
            .map(|i| (*i, scales[*i]))
            .collect();
        if let Some(h) = max_step_s {
            // Before the first step; stock keeps it across every IDAReInit.
            plant.ida.set_max_step(h)?;
        }
        let t0 = plant.t0;
        plant
            .driver
            .start_quadratures(&mut plant.ida, vec![0.; slice::QUADRATURES.len()])?;
        plant.start(&mut [])?;
        if tolerance_factor != 1. {
            for a in &mut plant.atol {
                *a *= tolerance_factor;
            }
            plant.rtol *= tolerance_factor;
            plant.derived = plant.derived.scaled(tolerance_factor);
            // The scaled tolerances take effect through one restart at t0.
            plant.driver.decide(vec![Change {
                due_s: t0,
                class: Class::R,
                kind: format!("reference tolerances x{tolerance_factor} (every absolute tolerance, derived classes included)"),
                action: Action::Held(Box::new(|_: &mut Unit| Ok(()))),
            }])?;
        }
        let (y, n, rtol, frame) = (&plant.y, plant.n, plant.rtol, plant.frame);
        let s = &plant.ida.system().slice;
        let reply = json!({"t": t0, "tolerance_factor": tolerance_factor, "rtol": rtol, "max_step_s": max_step_s, "dimension": y.len(), "operator": n,
            "weights": weights, "matrix_rebuild": "packet (MR-1)",
            "kernel_source_sha256": KERNEL_SOURCE_SHA256,
            "boundary": {"v_line_V": s.inputs.v_line, "frequency_hz": s.inputs.f_grid_hz,
                "carrier_rad_s": s.inputs.carrier_rad_s, "carrier_accel_rad_s2": s.inputs.carrier_accel_rad_s2, "joined": s.inputs.joined},
            "carrier_law": format!("{carrier_law:?}"),
            "field_supply_loss_trip": {"implemented": "the generator page's ACT.B field controller (ICFIELD): GCB OPEN + acquired turbine trip at its decision frame",
                "parameters": e["fieldProtection"]},
            "export_w": s.export_w(&y[n..]), "composition": plant.composition,
            "ic_section": inputs.ic_path, "implemented_causes": section.functions.iter().map(|f| f.id.clone()).collect::<Vec<_>>(),
            "quadratures": slice::QUADRATURES, "frame_s": frame.period_s(),
            "integration": "frame driver (IC-PROT): stock IDA_ONE_STEP, IC-PROT + PZR control (S) + field controller (ICFIELD) clients, Diagnostic::None, quadratures carried",
            "cpu_s": time::thread_s() - c0, "wall_s": w0.elapsed().as_secs_f64(),
            "max_rss_bytes": time::max_rss_bytes(), "pid": std::process::id()});
        let host = Self {
            plant,
            t: t0,
            v_nominal,
            carrier_law,
            extension,
            rule_i: RuleI::default(),
            log_seen: 0,
            elec_seen: 0,
            sg,
            rotors,
            observe_cpu_s: 0.,
            observe_instructions: 0,
            offsite_lost_at: None,
            exchanges: [0, 0],
            event_window,
            window_end: None,
        };
        Ok((host, reply))
    }

    /// The Grid's boundary for `[t0, t1)`, decided at `t0` (the driver's
    /// time) through the unit library (`plant::boundary`); after the first
    /// offsite loss, the restart now and the plant's event-window cap on the
    /// segment it opened (stock keeps it across later IDAReInit).
    fn boundary(
        &mut self,
        t1: f64,
        energized: bool,
        voltage_pu: f64,
        frequency_hz: f64,
        phase_error_rad: f64,
        frequency_rate_hz_s: f64,
    ) -> Result<&'static str, String> {
        let t0 = self.t;
        let lost = self.plant.ida.system().offsite_loss_s.is_some();
        let boundary = if energized {
            Boundary::Energized {
                voltage_v: self.v_nominal * voltage_pu,
                frequency_hz,
                phase_error_rad,
                frequency_rate_hz_s,
            }
        } else {
            Boundary::Dead
        };
        let decided = self.plant.boundary(t0, t1, boundary)?;
        if !energized && !lost {
            // The field converter on AC.B loses its supply with the
            // sources; the field controller acquires it (ICFIELD).
            self.offsite_lost_at = Some(t0);
            if let Some((cap, duration)) = self.event_window {
                self.apply_due()?;
                self.plant.ida.set_max_step(cap)?;
                self.window_end = Some(t0 + duration);
                return Ok("R: offsite loss; event window cap in force");
            }
        }
        Ok(decided)
    }

    /// Everything due at the unit's time, now (the offsite loss's restart).
    fn apply_due(&mut self) -> Result<(), String> {
        self.plant.apply_due(&mut [])
    }

    /// Advance the driver to `t1`, frame instant by frame instant, judging
    /// rule I at each (the S3 cases' rule).
    fn advance(&mut self, t1: f64) -> Result<(), String> {
        let period = self.plant.frame.period_s();
        let mut bounds: Vec<f64> = Vec::new();
        let first = (self.t / period).floor() as i64 + 1;
        let last = (t1 / period).ceil() as i64;
        for k in first..=last {
            let b = k as f64 * period;
            if b > self.t && b < t1 && !leitbild_operating_water::frame::same_instant(b, t1) {
                bounds.push(b);
            }
        }
        if let Some(w) = self.window_end.filter(|w| *w > self.t && *w < t1) {
            bounds.push(w);
            bounds.sort_by(f64::total_cmp);
        }
        bounds.push(t1);
        let window_end = self.window_end;
        let Self {
            plant,
            extension,
            rule_i,
            t,
            ..
        } = self;
        for b in bounds {
            plant.run(*t, b, &mut [], None)?;
            *t = b;
            let n = plant.n;
            let joined = &mut plant.ida.system_mut().integrated_mut().joined;
            rule_i.judge(joined, &*extension, b, &plant.y[..n], &plant.yp[..n])?;
            if window_end == Some(b) {
                // The window's end lifts the cap on the same history.
                plant.ida.remove_max_step()?;
            }
        }
        if self.window_end.is_some_and(|w| w <= self.t) {
            self.window_end = None;
        }
        Ok(())
    }

    fn observe(&mut self) -> Result<Vec<f64>, String> {
        let c0 = time::thread_s();
        let i0 = time::instructions_cycles().map_or(0, |x| x.0);
        let (t, n) = (self.t, self.plant.n);
        let (y, yp) = (&self.plant.y, &self.plant.yp);
        let joined = &mut self.plant.ida.system_mut().integrated_mut().joined;
        joined
            .evaluate(t, &y[..n], &yp[..n], None, 0., None)
            .map_err(|e| format!("{e:?}"))?;
        let released = joined.heats().nuclear.released_w.value;
        let taps = joined
            .network
            .pzr_taps()
            .map_err(|e| format!("PZR taps: {e:?}"))?;
        let mut v = vec![
            released,
            taps.pt1_pa.value,
            taps.collapsed_level_m.value,
            taps.mixture_level_m.value,
        ];
        v.extend(self.sg.iter().map(|(_, i, s)| y[*i] * s));
        v.extend(self.rotors.iter().map(|(i, s)| y[*i] * s));
        self.observe_cpu_s += time::thread_s() - c0;
        self.observe_instructions += time::instructions_cycles().map_or(0, |x| x.0) - i0;
        Ok(v)
    }

    /// One exchange: the Grid's boundary at the unit's time, advance, receipt.
    #[allow(clippy::too_many_arguments)] // One exchange: interval, window and the Grid's boundary.
    fn exchange(
        &mut self,
        t1: f64,
        window: bool,
        observe: bool,
        energized: bool,
        voltage_pu: f64,
        frequency_hz: f64,
        phase_error_rad: f64,
        frequency_rate_hz_s: f64,
        out: &mut Vec<u8>,
    ) -> Result<(), String> {
        let t0 = self.t;
        let ins0 = time::instructions_cycles();
        let (rule_ins0, obs_ins0) = (self.rule_i.instructions, self.observe_instructions);
        if !(t1.is_finite() && t1 > t0) {
            return Err(format!("t1 {t1} is not after {t0}"));
        }
        let rule_cpu0 = self.rule_i.cpu_s;
        let obs_cpu0 = self.observe_cpu_s;
        let q0 = self.plant.driver.quadratures_at(&self.plant.ida, t0)?;
        let (r0, s0) = (
            self.plant.driver.counts.total(Class::R),
            self.plant.driver.counts.total(Class::S),
        );
        let decided = self.boundary(
            t1,
            energized,
            voltage_pu,
            frequency_hz,
            phase_error_rad,
            frequency_rate_hz_s,
        )?;
        self.advance(t1)?;
        self.exchanges[usize::from(window)] += 1;
        let q1 = self.plant.driver.quadratures_at(&self.plant.ida, t1)?;
        let n = self.plant.n;
        let u = self.plant.ida.system();
        let export_w = u.slice.export_w(&self.plant.y[n..]);
        let rcp = {
            let net = &u.integrated().joined.network;
            (0..net.rotor_count())
                .filter(|r| {
                    matches!(
                        net.rotor_state(*r).map(|s| s.support),
                        Some(Support::Supported(_))
                    )
                })
                .count()
        };
        let elec: Vec<Value> = u.log[self.elec_seen..]
            .iter()
            .map(|(t, s)| json!({"t": t, "event": s}))
            .collect();
        self.elec_seen = u.log.len();
        let instants: Vec<Value> = self.plant.driver.log[self.log_seen..].to_vec();
        self.log_seen = self.plant.driver.log.len();
        let joined_flag = u.slice.inputs.joined;
        let lost = u.offsite_loss_s.is_some();
        let (id, iq) = (self.plant.y[n + 3], self.plant.y[n + 4]);
        let ieq = (id * id + iq * iq).sqrt() / 3f64.sqrt();
        let (r1, s1) = (
            self.plant.driver.counts.total(Class::R),
            self.plant.driver.counts.total(Class::S),
        );
        for v in [
            t0,
            t1,
            q1[EXPORT] - q0[EXPORT],
            q1[UNIT_DRAW] - q0[UNIT_DRAW],
            q1[RESERVE_DRAW] - q0[RESERVE_DRAW],
            q1[EXPORT],
            export_w,
            self.plant.y[n + slice::OMEGA],
            self.plant.y[n + slice::THETA],
            ieq,
            u.slice.inputs.carrier_rad_s,
            f64::from(u8::from(joined_flag)),
            f64::from(u8::from(lost)),
            rcp as f64,
            self.rule_i.cpu_s - rule_cpu0,
            u.arc_heat_j,
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let stats = self.plant.ida.stats()?;
        let totals = {
            let t = self.plant.driver.totals;
            [
                t[0] + stats.steps,
                t[2] + stats.jacobians,
                t[1] + stats.residuals,
            ]
        };
        for v in [
            totals[0],
            totals[1],
            totals[2],
            (r1 - r0) as i64,
            (s1 - s0) as i64,
            r1 as i64,
            s1 as i64,
            self.plant.driver.counts.total(Class::O) as i64,
            i64::from(self.rule_i.exit.is_some()),
            i64::from(stats.last_order),
            i64::from(stats.current_order),
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let signals = if observe { self.observe()? } else { Vec::new() };
        // Instructions retired over the exchange (whole process), and the
        // shares of rule I (harness) and host observation within it.
        let ins = match (ins0, time::instructions_cycles()) {
            (Some(a), Some(b)) => [(b.0 - a.0) as i64, (b.1 - a.1) as i64],
            _ => [-1, -1],
        };
        for v in [
            ins[0],
            ins[1],
            (self.rule_i.instructions - rule_ins0) as i64,
            (self.observe_instructions - obs_ins0) as i64,
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&(signals.len() as u32).to_le_bytes());
        for v in signals {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let restart_instants: Vec<&Value> =
            instants.iter().filter(|e| e["class"] == "R").collect();
        let events = if restart_instants.is_empty() && elec.is_empty() && decided.starts_with('n')
        {
            Vec::new()
        } else {
            serde_json::to_vec(&json!({"boundary": decided, "restarts": restart_instants,
                "s_instants": instants.iter().filter(|e| e["class"] == "S").count(),
                "electrical": elec, "observe_cpu_s": self.observe_cpu_s - obs_cpu0}))
            .unwrap()
        };
        out.extend_from_slice(&(events.len() as u32).to_le_bytes());
        out.extend_from_slice(&events);
        Ok(())
    }

    fn report(&mut self, zero: f64) -> Result<Value, String> {
        let p = &self.plant.protection.protection;
        let divisions: Vec<Value> = p
            .divisions
            .iter()
            .map(|dv| json!({"supply": dv.supply, "powered": dv.powered,
                "causes": dv.causes.iter().map(|c| json!({"function": c.function, "t_s": c.at_s})).collect::<Vec<_>>(),
                "trip": dv.trip.as_ref().map(|c| json!({"function": c.function, "t_s": c.at_s})),
                "requests": dv.requests, "monitors": dv.monitors}))
            .collect();
        let electrical = self.plant.ida.system().log.clone();
        let tl = timeline::Timeline::from_logs(
            &self.plant.driver.log,
            &divisions,
            p.holding.lost_at,
            zero,
            self.t,
        )?
        .with_electrical(&electrical, zero);
        let stats = self.plant.ida.stats()?;
        let mut totals = self.plant.driver.totals;
        for (a, b) in totals.iter_mut().zip([
            stats.steps,
            stats.residuals,
            stats.jacobians,
            stats.nonlinear_iterations,
            stats.error_failures,
            stats.convergence_failures,
            stats.linear_setups,
            stats.root_evaluations,
        ]) {
            *a += b;
        }
        let totals: serde_json::Map<String, Value> = COUNTER_NAMES
            .iter()
            .zip(totals)
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect();
        Ok(json!({
            "t_s": self.t, "t0_s": self.plant.t0, "zero_s": zero, "offsite_lost_s": self.offsite_lost_at,
            "event_window": self.event_window.map(|(c, d)| json!({"cap_s": c, "duration_s": d})),
            "routing_records": self.plant.ida.system().routing.records.iter().map(|r| json!([r.time, r.what])).collect::<Vec<_>>(),
            "exchanges": {"quiet": self.exchanges[0], "window": self.exchanges[1]},
            "counts_by_class": self.plant.driver.counts.json(), "stock_totals": totals,
            "cpu": {"solver_s": self.plant.driver.cpu.solver_s, "observation_s": self.plant.driver.cpu.observation_s,
                "restart_s": self.plant.driver.cpu.restart_s, "held_s": self.plant.driver.cpu.held_s,
                "rule_i_s": self.rule_i.cpu_s, "host_observe_s": self.observe_cpu_s, "thread_s": time::thread_s(),
                "instructions_cycles": time::instructions_cycles(), "rule_i_instructions": self.rule_i.instructions,
                "host_observe_instructions": self.observe_instructions},
            "rule_i": {"applied": "A4 (owner R5-A): a run ends, labelled, at the first frame state D3 (a) does not admit (B1's per-region phase absence included)",
                "samples": self.rule_i.samples, "first_extended_s": self.rule_i.first_extended,
                "margin_failures": self.rule_i.margin_failures, "exit": self.rule_i.exit},
            "timeline": {"end": tl.end, "holding_lost": tl.holding_lost, "stop_ramp_end": tl.stop_ramp_end,
                "seats": tl.seats.iter().map(|(c, t)| json!([c, t])).collect::<Vec<_>>(),
                "sg_relief": tl.sg_relief.iter().map(|(v, th, d, t)| json!([v, th, d, t])).collect::<Vec<_>>(),
                "pzr_relief_openings": tl.pzr_relief_openings,
                "causes": tl.causes.iter().map(|c| json!([c.division, c.function, c.t])).collect::<Vec<_>>(),
                "trips": tl.trips.iter().map(|c| json!([c.division, c.function, c.t])).collect::<Vec<_>>(),
                "requests": tl.requests.iter().map(|(d, r)| json!([d, r])).collect::<Vec<_>>(),
                "electrical": tl.electrical.as_ref().map(|l| l.iter().map(|(t, w)| json!([t, w])).collect::<Vec<_>>())},
            "divisions": divisions, "protection_log": p.log,
            "field_controller": {"initiated": self.plant.field.as_ref().ok_or("no field controller")?.protection.initiated.as_ref().map(|i| json!({"cause": i.cause, "frame": i.frame, "t_s": i.at_s})),
                "log": self.plant.field.as_ref().ok_or("no field controller")?.protection.log},
            "pzr_control": {"changes": self.plant.control.schedule.len().saturating_sub(1), "final_request_w": self.plant.control.in_force_w},
            "derived_tolerances": self.plant.derived,
            "segments": self.plant.driver.segments.len(),
            "instants": self.plant.driver.log,
        }))
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
            let (h, reply) = Host::load(&config)?;
            out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
            *host = Some(h);
        }
        12 => {
            let t1 = r.f64()?;
            let window = r.u8()? != 0;
            let observe = r.u8()? != 0;
            let energized = r.u8()? != 0;
            let voltage_pu = r.f64()?;
            let frequency_hz = r.f64()?;
            let phase_error_rad = r.f64()?;
            let frequency_rate_hz_s = r.f64()?;
            let h = host.as_mut().ok_or("no unit is loaded")?;
            h.exchange(
                t1,
                window,
                observe,
                energized,
                voltage_pu,
                frequency_hz,
                phase_error_rad,
                frequency_rate_hz_s,
                out,
            )?;
        }
        13 => {
            let zero = r.f64()?;
            let h = host.as_mut().ok_or("no unit is loaded")?;
            let report = h.report(zero)?;
            out.extend_from_slice(&serde_json::to_vec(&report).unwrap());
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

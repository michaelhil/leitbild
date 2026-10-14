//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation
//! S3-D1 §7: the C1 refinement pair (NOT-EVIDENCE measurement). The C1
//! hold with the normal PZR pressure controller in AUTO, from a settled
//! joined state, on IC-PROT's frame driver (`frame.rs`: 0.1 s frame, stock
//! IDA_ONE_STEP, dense-output observation, classes counted by kind). The
//! controller's heater-request changes are applied at their frame instants
//! by the policies S3-D1 allows:
//! - `R`: every change class R (`discrete_restart`; a change discovered
//!   after the step passed its frame restarts there from the step's dense
//!   output);
//! - `S`: every change class S, as lead decision S3-D4 classes a heater
//!   power step (it enters only the heater steel's energy balance); the
//!   driver checks that rule at each stop. The controller asks for a stop at
//!   every frame, since an S change cannot be applied late;
//!
//! against a tight reference `REF` (R at rtol/10). Both closed loops run,
//! and `R-replay`/`S-replay` apply the reference's own request schedule, so
//! the integration policy's error is measured apart from any divergence of
//! the quantized control decisions. The driver reports the jump of every S
//! instant, the Newton correction `J(cj)^-1 ΔF` in IDA's WRMS, as a
//! diagnostic. The first receipt (615e26f4e) also ran S3-D1.2's provisional
//! fraction (`CRIT`), which S3-D4 retired on its result.
//!
//! PT1 is the stratified cell's roof-pressure coordinate (the PT1 tap is the
//! roof), so the channel's first-order lag is integrated exactly under each
//! accepted step's polynomial: `ℓ = Σ_k (−τ)^k p^(k) + C e^(−t/τ)`. The
//! channel (`reference-pzr-pressure-channel`: range check, nearest-quantum
//! rounding with half bins upward, 0.1 s transport) is the test's own until
//! IC-PROT's acquisition lands. Commissioning: the lag starts at the roof
//! pressure and the first delivered sample is acquired at the start; its
//! demand is put in force before the first consistent start, so every
//! policy starts from the same exact state.
//!
//! Recorded per frame: PT1 (roof pressure), the collapsed level (the cell's
//! own column at the dense state), both SG pressures and both main-loop
//! flows (impulse coordinate times its flow ratio at the start).
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water)
//! plus `LD01_C1_STATE` (a settled state `{t_s, y, yp, packet_sha256}` of
//! this packet), `LD01_PZR_CONTROL_SECTION` (the compiled `pzrControl`
//! section), `LD01_PZR_CONTROL_WIKI` (the wiki root it was compiled from,
//! for the channel block), optionally `LD01_C1_SPAN_S` (default 300),
//! `LD01_C1_RUNS` (comma list of R, S, R-replay, S-replay; default
//! all; REF always runs) and `LD01_C1_RECEIPT` (a new receipt path; the
//! series go beside it).
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "common/filter.rs"]
mod filter;
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{
    control::pzr_pressure::{Controller, Demand, Law, Quality, Sample, Section},
    network::stratified::{self, Coordinates as PzrCoordinates},
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    frame::{Action, Change, Class, Client, Dense, Diagnostic, Driver, Frame, Setup},
    ida::{Ida, Initial},
    joined::{Discrete, Integrated, Restart, discrete_restart},
};
use serde_json::{Value, json};
use spine::{
    DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_full_composition, z1,
};

type System = Integrated<If97>;

/// S2's hold configuration (BDF order at most 2).
const MAX_ORDER: usize = 2;
/// S3-D1.2's retired provisional bound, kept to report how many jumps it
/// would have admitted: 0.1 of the Newton coefficient.
const RETIRED_FRACTION: f64 = 0.1;
/// The credited band (`ld01-accuracy-contract`, uncreditedAbove_Hz).
const CREDITED_HZ: f64 = 2.;
/// The two main-loop return faces (RETURN.A/B -> DOWN), as the settle's
/// credited outputs read them.
const LOOP_FACES: [usize; 2] = [22, 30];
const OUTPUTS: [&str; 7] = [
    "pt1_pa",
    "collapsed_level_m",
    "sg_a_p_pa",
    "sg_b_p_pa",
    "loop_a_kg_s",
    "loop_b_kg_s",
    "request_w",
];

/// `reference-pzr-pressure-channel` (operational-observations.md).
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelBlock {
    lag_s: f64,
    min_pa: f64,
    max_pa: f64,
    quantum_pa: f64,
    sample_s: f64,
    transport_s: f64,
}

/// Where the recorded outputs live in `y` (solver scaling) and their
/// physical factors.
#[derive(Clone)]
struct Probe {
    pzr: std::ops::Range<usize>,
    pzr_scales: Vec<f64>,
    cell: stratified::Cell,
    sg: [(usize, f64); 2],
    loops: [(usize, f64); 2],
}
impl Probe {
    fn new(
        joined: &mut leitbild_operating_plant::joined::operator::Joined<If97>,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Self {
        joined.evaluate(t, y, yp, None, 0., None).unwrap();
        let net = &joined.network;
        let pzr = net.pzr.coordinates();
        let pzr_scales = pzr.clone().map(|i| net.scales()[i]).collect();
        let loops = LOOP_FACES.map(|f| {
            let l = net
                .face_layout
                .iter()
                .find(|l| l.face == f && l.phase == 0)
                .expect("loop face coordinate");
            let flow = net.chart(f, 0).unwrap().mass_flow_kg_s.value;
            (l.index, flow / y[l.index])
        });
        let cell = net.stratified().clone();
        let mut sg = Vec::new();
        let mut k = 0;
        for (owner, layout) in joined.layouts() {
            for (i, label) in layout.labels.iter().enumerate() {
                if owner == "secondary" && label.ends_with(".p_s") {
                    sg.push((k, layout.scales[i]));
                }
                k += 1;
            }
        }
        Self {
            pzr,
            pzr_scales,
            cell,
            sg: [sg[0], sg[1]],
            loops,
        }
    }
    fn roof_pa(&self, y: &[f64]) -> f64 {
        y[self.pzr.start + stratified::ROOF_PRESSURE] * self.pzr_scales[stratified::ROOF_PRESSURE]
    }
    fn outputs(&self, y: &[f64]) -> [f64; 6] {
        let x: Vec<Scalar> = self
            .pzr
            .clone()
            .zip(&self.pzr_scales)
            .map(|(i, s)| Scalar::constant(y[i] * s))
            .collect();
        let x = PzrCoordinates::from_slice(&x).unwrap();
        let column = self.cell.column(&If97, &x, None).expect("PZR column");
        let level = self
            .cell
            .taps(&If97, &column)
            .expect("PZR taps")
            .collapsed_level_m
            .value;
        [
            self.roof_pa(y),
            level,
            y[self.sg[0].0] * self.sg[0].1,
            y[self.sg[1].0] * self.sg[1].1,
            y[self.loops[0].0] * self.loops[0].1,
            y[self.loops[1].0] * self.loops[1].1,
        ]
    }
}

/// The normal PZR pressure controller as a frame-driver client, with the
/// test's PT1 channel.
struct PzrClient {
    class: Class,
    controller: Controller,
    replay: Option<Vec<(u64, f64)>>,
    channel: ChannelBlock,
    probe: Probe,
    lag: f64,
    lag_at: f64,
    in_flight: Sample,
    in_force_w: f64,
    scratch: Vec<f64>,
    /// Per frame: index, outputs and the request in force after it.
    series: Vec<(u64, [f64; 7])>,
    schedule: Vec<(u64, f64)>,
}
impl PzrClient {
    fn acquire(&self, t: f64) -> Sample {
        let quality = if self.lag < self.channel.min_pa {
            Quality::BelowRange
        } else if self.lag > self.channel.max_pa {
            Quality::AboveRange
        } else {
            Quality::Usable
        };
        Sample {
            value_pa: (self.lag / self.channel.quantum_pa + 0.5).floor() * self.channel.quantum_pa,
            acquired_s: t,
            quality,
        }
    }
    /// `Σ_k (−τ)^k p^(k)(t)` of the roof-pressure polynomial.
    fn particular(&mut self, dense: &dyn Dense, t: f64) -> Result<f64, String> {
        let (tau, mut sum, mut factor) = (self.channel.lag_s, 0., 1.);
        for k in 0..=dense.order() {
            dense.derivative(t, k, &mut self.scratch)?;
            sum += factor * self.probe.roof_pa(&self.scratch);
            factor *= -tau;
        }
        Ok(sum)
    }
}
impl Client<System> for PzrClient {
    fn name(&self) -> &str {
        "LD01.PZR normal pressure control"
    }
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String> {
        if from != self.lag_at {
            return Err(format!("lag at {} s advanced from {from} s", self.lag_at));
        }
        let (a, b) = (self.particular(dense, from)?, self.particular(dense, to)?);
        self.lag = b + (self.lag - a) * (-(to - from) / self.channel.lag_s).exp();
        self.lag_at = to;
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<System>>, String> {
        if t != self.lag_at {
            return Err(format!("frame at {t} s with the lag at {} s", self.lag_at));
        }
        dense.derivative(t, 0, &mut self.scratch)?;
        let o = self.probe.outputs(&self.scratch);
        // The sample acquired one transport earlier arrives now; the start's
        // commissioning sample is acquired and delivered at the start.
        let due = self.in_flight.acquired_s + self.channel.transport_s;
        if !((due - t).abs() <= 1e-9 * t.abs() || self.in_flight.acquired_s == t) {
            return Err(format!("the sample in flight is due at {due} s, not {t} s"));
        }
        let delivered = self.in_flight;
        self.in_flight = self.acquire(t);
        let decided = self.controller.frame(t, Some(&delivered)).demand;
        let target = match &self.replay {
            Some(s) => s.iter().find(|e| e.0 == k).map_or(self.in_force_w, |e| e.1),
            None => decided.heater_request_w,
        };
        let mut out = Vec::new();
        if target != self.in_force_w {
            let demand = Demand {
                heater_request_w: target,
                spray_target: 0.,
                withdrawn: None,
            };
            out.push(Change {
                due_s: t,
                class: self.class,
                kind: "PZR heater request".into(),
                action: Action::Held(Box::new(move |s: &mut System| {
                    s.joined
                        .pzr_mut()
                        .ok_or("no PZR block")?
                        .apply_control(t, &demand)
                        .map(|_| ())
                        .map_err(|f| format!("{f:?}"))
                })),
            });
            self.in_force_w = target;
            self.schedule.push((k, target));
        }
        self.series
            .push((k, [o[0], o[1], o[2], o[3], o[4], o[5], self.in_force_w]));
        Ok(out)
    }
    fn stop_at_frame(&self, _k: u64) -> bool {
        // An S change can only be applied at an exact stop; with a 0.1 s
        // transport the decision at frame k+1 is known only after frame k.
        self.class == Class::S
    }
}

struct Run {
    name: String,
    divisor: f64,
    summary: Value,
    series: Vec<(u64, [f64; 7])>,
    schedule: Vec<(u64, f64)>,
    y_end: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
}

fn vector(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

#[allow(clippy::too_many_lines)] // One run: composition, start, driven span and its summary.
fn run(
    name: &str,
    divisor: f64,
    replay: Option<&[(u64, f64)]>,
    state: &Value,
    law: &Law,
    channel: ChannelBlock,
    span_s: f64,
) -> Run {
    let class = match name {
        "REF" | "R" | "R-replay" => Class::R,
        "S" | "S-replay" => Class::S,
        other => panic!("unknown run {other}"),
    };
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let composed_at = z1::cpu_s();
    let Started {
        mut joined,
        ids,
        network_ids,
        atol,
        rtol,
        structure,
        analyses,
        ..
    } = started_full_composition();
    let composition_cpu = z1::cpu_s() - composed_at;
    let (atol, rtol): (Vec<f64>, f64) =
        (atol.iter().map(|a| a / divisor).collect(), rtol / divisor);
    let t0 = state["t_s"].as_f64().unwrap();
    let (mut y, mut yp) = (vector(&state["y"]), vector(&state["yp"]));
    assert_eq!(
        y.len(),
        joined.dimension(),
        "settled state of another packet"
    );
    let prepared_w = joined
        .pzr()
        .expect("a G6 packet composes the PZR block")
        .request_w();
    let probe = Probe::new(&mut joined, t0, &y, &yp);
    let lag = probe.roof_pa(&y);
    // Commissioning: lag at the roof pressure, first sample acquired now.
    let mut client = PzrClient {
        class,
        controller: Controller::new(law.clone(), prepared_w, 0.).unwrap(),
        replay: replay.map(<[_]>::to_vec),
        channel,
        probe,
        lag,
        lag_at: t0,
        in_flight: Sample {
            value_pa: 0.,
            acquired_s: t0,
            quality: Quality::Unavailable,
        },
        in_force_w: prepared_w,
        scratch: vec![0.; y.len()],
        series: Vec::new(),
        schedule: Vec::new(),
    };
    client.in_flight = client.acquire(t0);
    let first = client.controller.law().auto(Some(&client.in_flight), t0);
    let start_w = match replay {
        Some(s) => {
            assert_eq!(
                s.first().map(|e| e.1),
                Some(first.heater_request_w),
                "the replayed schedule starts on the same commissioning demand"
            );
            s[0].1
        }
        None => first.heater_request_w,
    };
    let start = Demand {
        heater_request_w: start_w,
        spray_target: 0.,
        withdrawn: None,
    };
    joined.pzr_mut().unwrap().apply_control(t0, &start).unwrap();
    // The controller and the client hold the start demand in force, so the
    // start frame reports no change.
    client.controller = Controller::new(law.clone(), start_w, 0.).unwrap();
    client.in_force_w = start_w;
    let k0 = Frame::new(law.frame_s()).unwrap().at_or_after(t0).unwrap();
    client.schedule.push((k0, start_w));
    let nonnegative = joined.network.nonnegative_stocks();
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).unwrap(),
        Initial {
            time: t0,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    let started = z1::cpu_s();
    let initial = discrete_restart(
        &mut ida,
        t0,
        Discrete::TimeEvent,
        &mut y,
        &network_ids,
        &atol,
        rtol,
        &restart,
    )
    .unwrap();
    yp.clone_from(&initial.yp);
    let initial_cpu = z1::cpu_s() - started;
    let mut driver = Driver::<System>::new(
        Frame::new(law.frame_s()).unwrap(),
        Diagnostic::Jump,
        z1::cpu_s,
        t0,
    )
    .unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
    };
    let counters_before = ida.system().joined.counters;
    let loop_started = z1::cpu_s();
    driver
        .start(&mut [&mut client as &mut dyn Client<System>], t0, &y, &yp)
        .unwrap();
    driver
        .run(
            &mut ida,
            t0,
            t0 + span_s,
            &mut y,
            &mut yp,
            &mut [&mut client as &mut dyn Client<System>],
            &setup,
        )
        .unwrap();
    let loop_cpu = z1::cpu_s() - loop_started;
    let counters = ida.system().joined.counters;
    let jumps: Vec<f64> = driver
        .log
        .iter()
        .filter_map(|r| r["jump_wrms"].as_f64())
        .collect();
    let bound = RETIRED_FRACTION * NEWTON_COEFFICIENT;
    let mut sorted = jumps.clone();
    sorted.sort_by(f64::total_cmp);
    let summary = json!({"run": name, "class_of_changes": class.name(),
        "tolerance_divisor": divisor, "replay_of_reference_schedule": replay.is_some(),
        "t0_s": t0, "span_s": span_s, "prepared_request_w": prepared_w, "start_request_w": start_w,
        "composition_cpu_s": composition_cpu, "initial_start_cpu_s": initial_cpu,
        "cpu_s": loop_cpu, "cpu_s_per_simulated_s": loop_cpu / span_s,
        "driver_cpu": {"solver_s": driver.cpu.solver_s, "observation_s": driver.cpu.observation_s,
            "restart_s": driver.cpu.restart_s, "held_s": driver.cpu.held_s},
        "counts": driver.counts.json(),
        "operator": {"residuals": counters.residuals - counters_before.residuals,
            "jacobians": counters.jacobians - counters_before.jacobians, "roots": counters.roots - counters_before.roots},
        "changes": client.schedule.len() - 1,
        "s_jump_diagnostic": {"n": jumps.len(), "within_retired_s3_d1_2_bound": jumps.iter().filter(|j| **j <= bound).count(),
            "min": sorted.first(), "median": sorted.get(sorted.len() / 2), "max": sorted.last()},
        "log": driver.log});
    Run {
        name: name.into(),
        divisor,
        summary,
        series: client.series,
        schedule: client.schedule,
        y_end: y,
        atol,
        rtol,
    }
}

/// One run's outputs against the reference, after the declared zero-phase
/// low-pass at the credited band on the frame samples, and its end state in
/// its own error weights.
fn compare(run: &Run, reference: &Run, frame_s: f64) -> Value {
    assert_eq!(run.series.len(), reference.series.len(), "same frames");
    let mut out = serde_json::Map::new();
    for (j, name) in OUTPUTS.iter().enumerate().take(6) {
        let diff: Vec<f64> = run
            .series
            .iter()
            .zip(&reference.series)
            .map(|(a, b)| a.1[j] - b.1[j])
            .collect();
        let filtered = filter::zero_phase_lowpass(&diff, CREDITED_HZ, frame_s);
        let abs: Vec<f64> = filtered.iter().map(|d| d.abs()).collect();
        let steps: Vec<f64> = filtered.windows(2).map(|w| w[1] - w[0]).collect();
        out.insert(
            (*name).into(),
            json!({"mean_abs_filtered": filter::mean(&abs), "max_abs_filtered": filter::max_abs(&filtered),
                "sample_to_sample_deviation": filter::deviation(&steps), "max_abs_raw": filter::max_abs(&diff)}),
        );
    }
    let pairs = run.series.iter().zip(&reference.series);
    let differing = pairs.clone().filter(|(a, b)| a.1[6] != b.1[6]).count();
    let first = pairs
        .clone()
        .find(|(a, b)| a.1[6] != b.1[6])
        .map(|(a, _)| a.0);
    let (mut sum, mut max) = (0., 0_f64);
    for i in 0..run.y_end.len() {
        let w = 1. / (run.rtol * reference.y_end[i].abs() + run.atol[i]);
        let d = (run.y_end[i] - reference.y_end[i]) * w;
        sum += d * d;
        max = max.max(d.abs());
    }
    json!({"run": run.name, "outputs": out,
        "frames_with_a_different_request": differing, "first_differing_frame": first,
        "end_state_wrms_in_run_error_weights": (sum / run.y_end.len() as f64).sqrt(), "end_state_max": max})
}

#[test]
#[ignore = "NOT-EVIDENCE S3-D1 measurement: requires the joined packet, a settled state, the control section, the wiki, IF97 and stock IDA/KLU"]
fn s3_c1_controller_updates_as_stop_and_continue_against_restart() {
    let state_path = std::env::var("LD01_C1_STATE").expect("LD01_C1_STATE");
    let section_path = std::env::var("LD01_PZR_CONTROL_SECTION").expect("LD01_PZR_CONTROL_SECTION");
    let receipt_path = std::env::var_os("LD01_C1_RECEIPT");
    if let Some(p) = &receipt_path {
        assert!(
            !std::path::Path::new(p).exists(),
            "receipts are never overwritten"
        );
    }
    let span_s: f64 = std::env::var("LD01_C1_SPAN_S").map_or(300., |s| s.parse().unwrap());
    let wanted: Vec<String> = std::env::var("LD01_C1_RUNS")
        .unwrap_or_else(|_| "R,S,R-replay,S-replay".into())
        .split(',')
        .map(str::to_string)
        .collect();
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    let section: Section = serde_json::from_slice(&std::fs::read(&section_path).unwrap()).unwrap();
    let law = Law::new(&section).unwrap();
    let wiki = std::env::var("LD01_PZR_CONTROL_WIKI")
        .expect("LD01_PZR_CONTROL_WIKI: the wiki root the section was compiled from");
    let page = std::fs::read_to_string(format!(
        "{wiki}/world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md"
    ))
    .unwrap();
    let fence = "```reference-pzr-pressure-channel\n";
    let start = page.find(fence).expect("channel block") + fence.len();
    let end = start + page[start..].find("\n```").unwrap();
    let channel: ChannelBlock = serde_json::from_str(&page[start..end]).unwrap();
    assert_eq!(
        channel.sample_s,
        law.frame_s(),
        "the control frame is the channel's sample"
    );
    assert_eq!(
        channel.transport_s,
        law.frame_s(),
        "the test's channel delivers one frame later"
    );
    let reference = run("REF", 10., None, &state, &law, channel, span_s);
    eprintln!(
        "REF: {} changes, {} CPU-s",
        reference.schedule.len() - 1,
        reference.summary["cpu_s"]
    );
    let schedule = reference.schedule.clone();
    let mut runs: Vec<Run> = Vec::new();
    for p in &wanted {
        let r = match p.as_str() {
            "R" | "S" => run(p, 1., None, &state, &law, channel, span_s),
            "R-replay" | "S-replay" => run(p, 1., Some(&schedule), &state, &law, channel, span_s),
            other => panic!("unknown run {other}"),
        };
        eprintln!(
            "{p}: {} changes, {} CPU-s",
            r.schedule.len() - 1,
            r.summary["cpu_s"]
        );
        runs.push(r);
    }
    let frame_s = law.frame_s();
    let comparisons: Vec<Value> = runs
        .iter()
        .map(|r| compare(r, &reference, frame_s))
        .collect();
    let mut summaries = vec![reference.summary.clone()];
    summaries.extend(runs.iter().map(|r| r.summary.clone()));
    let receipt = json!({
        "kind": "s3-d1-c1-refinement-pair",
        "status": "NOT-EVIDENCE measurement: S against R for the C1 controller on IC-PROT's frame driver with S3-D4's rule classifier; the PT1 channel is the test's own until IC-PROT's acquisition lands",
        "provenance": spine::provenance(),
        "settled_state": state_path, "settled_state_t_s": state["t_s"], "packet_sha256": state["packet_sha256"],
        "control_section": section_path, "control_section_provenance": section.provenance, "control_wiki": wiki,
        "channel": {"lag_s": channel.lag_s, "quantum_pa": channel.quantum_pa, "sample_s": channel.sample_s,
            "transport_s": channel.transport_s, "span_pa": [channel.min_pa, channel.max_pa]},
        "classifier": "S3-D4 rule (frame.rs storage_rate_only): S iff the held change moves no algebraic row, leaves the identity and every root value unchanged",
        "jump_diagnostic": {"definition": "WRMS of J(cj)^-1 (F_new - F_old) at the exact stop, cj = sum_{j<=q} 1/j / h_next, weights 1/(rtol|y|+atol)",
            "retired_s3_d1_2_bound": RETIRED_FRACTION * NEWTON_COEFFICIENT},
        "observation": {"interval_s": frame_s, "filter": filter::DECLARED_FILTER, "cutoff_hz": CREDITED_HZ,
            "note": "frame samples from dense output (0.1 s), not the contract's 0.002 s; loop flows are the impulse coordinates times their flow ratio at the start"},
        "outputs": OUTPUTS,
        "runs": summaries,
        "against_reference": comparisons,
    });
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Some(p) = &receipt_path {
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        let mut series = serde_json::Map::new();
        for r in std::iter::once(&reference).chain(runs.iter()) {
            series.insert(
                format!("{}@{}", r.name, r.divisor),
                json!({"columns": OUTPUTS, "frames": r.series.iter().map(|s| s.0).collect::<Vec<_>>(),
                    "rows": r.series.iter().map(|s| s.1.to_vec()).collect::<Vec<_>>(), "schedule": r.schedule}),
            );
        }
        let mut sp = std::path::PathBuf::from(p);
        sp.set_extension("series.json");
        std::fs::write(sp, serde_json::to_vec(&Value::Object(series)).unwrap()).unwrap();
    }
}

//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#selected-electrical-interval-handoff
//! NOT-EVIDENCE measurement (PLATFORM lane, S2-D15) on the joined S2 spine:
//! (1) quiet cost of stopping at every exchange boundary (IDASetStopTime,
//! history retained) versus free stepping, from a settled state; (2) the cost
//! of a restore: fresh compilation of the joined operator from the packet and
//! the exact consistent start from saved y at the saved time; (3) the cost of
//! one discrete restart today; (4) copy equivalence at a restart boundary.
//! The construction reproduces `joined_spine.rs::started_full_composition`
//! and the settling probe's solver configuration exactly; nothing here is a
//! production path, and no tolerance or solver option is new.
//!
//! Usage: ld01-spike-joined <packet.json> <wiki-root> <settled-state.json> <receipt.json>
use leitbild_ld01_host_spike::cpu;
use leitbild_operating_plant::{
    initialization::SurfacePolicy,
    joined::{
        operator::{Joined, RodPort, SecondaryPort},
        packet,
    },
    network::{
        RotorState, ToleranceClasses, consistent_start,
        packet::Packet as NetworkPacket,
        prepare::{self, OperatingPoint, Settings},
    },
    rods::{RodBlock, Section as RodSection},
    rotor::{Shaft, SpeedRequest, Support},
    sg::{packet::Section as SecondarySection, secondary::Secondaries},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    joined::Integrated,
};
use serde_json::{Value, json};
use std::time::Instant;

const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 8,
};
/// The settling probe's configuration at every start and restart.
const NEWTON_COEFFICIENT: f64 = 0.33;
const DELTA_CJ_LSETUP: f64 = 0.1;
const FIRST_STEP_S: f64 = 1e-4;
const MAX_ORDER: usize = 2;
const START_BOUND: f64 = 1e-12;
const START_PASSES: usize = 3;

fn rotors() -> Vec<RotorState> {
    vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ]
}

fn classes(gates: &Value) -> ToleranceClasses {
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    ToleranceClasses {
        relative: f("relativeTolerance"),
        stock_scaled: f("stockScaledAbsolute"),
        tracer_scaled: f("tracerScaledAbsolute"),
        rotor_scaled: f("rotorScaledAbsolute"),
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
    }
}

/// `joined_spine.rs::z1::s1_settled_flows`: S1's declared settling from rest,
/// returning every face's liquid volume flow and the rotor momenta.
fn s1_settled_flows(packet: &NetworkPacket, gates: &Value) -> (Vec<f64>, Vec<f64>, Value) {
    use leitbild_operating_water::network::Integrated as NetworkIntegrated;
    let started = cpu::thread_s();
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let (network, prepared, _) =
        prepare::prepare(packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
    let mut y = prepared.y.clone();
    for i in &network.rotor_index {
        y[*i] = 0.;
    }
    let classes = classes(gates);
    let atol = network.absolute_tolerances(&y, classes).unwrap();
    let rtol = classes.relative;
    let ids = prepared.differential.clone();
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let mut probe = network;
    let (yp, _) = consistent_start(&mut probe, 0., &mut y, &ids, &weights, 1e-12, 2)
        .expect("S1 exact consistent start");
    let nonnegative = probe.nonnegative_stocks();
    let mut ida = Ida::new(
        NetworkIntegrated::colored(probe).unwrap(),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    ida.set_max_order(gates["maxOrder"].as_u64().unwrap() as usize)
        .unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    let settling = &gates["settling"];
    let cap = settling["maxSimulated_s"].as_f64().unwrap();
    let window = settling["window_s"].as_f64().unwrap();
    let rotor_rel = settling["rotorSpeedRelative"].as_f64().unwrap();
    let flow_rel = settling["loopFlowRelativeChange"].as_f64().unwrap();
    ida.stop_at(cap).unwrap();
    let face = |id: &str| {
        packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap()
    };
    let loops = [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")];
    let (mut yv, mut ypv) = (y.clone(), yp.clone());
    let mut history: Vec<(f64, [f64; 2])> = Vec::new();
    let mut t = 0.;
    let settled_at = loop {
        t += 1.;
        ida.advance(t, &mut yv, &mut ypv)
            .unwrap()
            .reached()
            .unwrap();
        let net = &mut ida.system_mut().network;
        net.evaluate(t, &yv, &ypv, None, 0., None).unwrap();
        let flows = loops.map(|f| net.chart(f, 0).unwrap().mass_flow_kg_s.value);
        let omega: Vec<f64> = net
            .rotor_index
            .iter()
            .map(|i| yv[*i] * net.scales()[*i] / net.rotor_inertia())
            .collect();
        let w0 = net.drive().reference_omega_rad_s;
        history.push((t, flows));
        let earlier = history.iter().rev().find(|h| h.0 <= t - window);
        let rested = earlier.is_some_and(|e| {
            omega.iter().all(|w| ((w - w0) / w0).abs() < rotor_rel)
                && (0..2).all(|k| ((flows[k] - e.1[k]) / flows[k]).abs() < flow_rel)
        });
        if rested {
            break Some(t);
        }
        if t >= cap {
            break None;
        }
    };
    let net = &mut ida.system_mut().network;
    net.evaluate(t, &yv, &ypv, None, 0., None).unwrap();
    let flows: Vec<f64> = (0..net.face_count())
        .map(|f| net.chart(f, 0).map_or(0., |c| c.volume_flow_m3_s.value))
        .collect();
    let momenta: Vec<f64> = net
        .rotor_index
        .iter()
        .map(|i| yv[*i] * net.scales()[*i])
        .collect();
    assert!(settled_at.is_some(), "S1 settling did not rest");
    (
        flows,
        momenta,
        json!({"settled_at_s": settled_at, "cpu_s": cpu::thread_s() - started}),
    )
}

struct Compiled {
    joined: Joined<If97>,
    y0: Vec<f64>,
    ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    timings: Value,
}

/// `joined_spine.rs::started_full_composition` up to (not including) the
/// consistent start: compile the joined operator from the packet at the hot
/// reference, with its preparation's tolerances and identity.
fn compile(bytes: &[u8], gates: &Value) -> Compiled {
    let (c0, w0) = (cpu::thread_s(), Instant::now());
    let network_packet: NetworkPacket = serde_json::from_slice(bytes).expect("network packet");
    let joined_packet: packet::Packet = serde_json::from_slice(bytes).expect("joined packet");
    let raw: Value = serde_json::from_slice(bytes).expect("packet json");
    let parse_cpu = cpu::thread_s() - c0;
    let (flows, momenta, s1) = s1_settled_flows(&network_packet, gates);
    let c1 = cpu::thread_s();
    let point = OperatingPoint::from(&network_packet.preparation.operating_point);
    let (mut network, mut prepared, hydrostatic) =
        prepare::prepare(&network_packet, If97, &point, &rotors(), &SETTINGS).expect("hydrostatic");
    prepare::compose_flows(
        &mut network,
        &network_packet,
        &mut prepared.y,
        hydrostatic.port_pressure_pa,
        &flows,
        &momenta,
        &SETTINGS,
    )
    .expect("flowing preparation");
    let network_ids = prepared.differential.clone();
    let section: SecondarySection =
        serde_json::from_value(raw["secondary"].clone()).expect("secondary section");
    let rods: RodSection = serde_json::from_value(raw["rods"].clone()).expect("rods section");
    let mut joined = Joined::new(
        network,
        &network_packet,
        &joined_packet,
        If97,
        SecondaryPort::Owner(Box::new(
            Secondaries::new(&section, &joined_packet.thermal.secondaries, &If97)
                .expect("SG secondary owner"),
        )),
        RodPort::Owner(Box::new(
            RodBlock::from_packet(&rods, &network_packet).expect("rod owner"),
        )),
    )
    .expect("joined operator");
    let mut y = joined.prepared(&prepared.y).unwrap();
    let ids = joined.differential(&network_ids);
    joined
        .prepare_owners(0., &mut y)
        .expect("owner preparation");
    joined
        .initialize_surfaces(
            0.,
            &mut y,
            SurfacePolicy {
                maximum_residual_w: 1e-3,
                maximum_correction_k: 1e-6,
                maximum_iterations: 16,
                maximum_backtracks: 12,
            },
        )
        .expect("surfaces");
    let classes = classes(gates);
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .unwrap();
    atol.resize(y.len(), classes.stock_scaled);
    let compose_cpu = cpu::thread_s() - c1;
    Compiled {
        joined,
        y0: y,
        ids,
        atol,
        rtol: classes.relative,
        timings: json!({"parse_cpu_s": parse_cpu, "s1_settle": s1, "compose_cpu_s": compose_cpu,
            "total_cpu_s": cpu::thread_s() - c0, "total_wall_s": w0.elapsed().as_secs_f64()}),
    }
}

fn weights(y: &[f64], atol: &[f64], rtol: f64) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

fn configure(ida: &mut Ida<Integrated<If97>>, nonnegative: &[usize]) {
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(nonnegative).unwrap();
    ida.set_max_step(f64::INFINITY).unwrap();
    ida.set_nonlinear_convergence_coefficient(NEWTON_COEFFICIENT)
        .unwrap();
    ida.set_delta_cj_lsetup(DELTA_CJ_LSETUP).unwrap();
    ida.set_init_step(FIRST_STEP_S).unwrap();
}

/// A restored unit: fresh compilation, exact consistent start at (t, y),
/// block-assembled stock IDA with the settling probe's configuration.
struct Unit {
    ida: Ida<Integrated<If97>>,
    y: Vec<f64>,
    yp: Vec<f64>,
    t: f64,
    ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    nonnegative: Vec<usize>,
}
fn restore(bytes: &[u8], gates: &Value, t: f64, saved: &[f64]) -> (Unit, Value) {
    let (c0, w0) = (cpu::thread_s(), Instant::now());
    let compiled = compile(bytes, gates);
    let Compiled {
        mut joined,
        y0,
        ids,
        atol,
        rtol,
        timings,
    } = compiled;
    assert_eq!(saved.len(), y0.len(), "saved state dimension");
    let c1 = (cpu::thread_s(), Instant::now());
    let mut y = saved.to_vec();
    let (yp, start) = leitbild_operating_water::joined::consistent_start(
        &mut joined,
        t,
        &mut y,
        &ids,
        &weights(saved, &atol, rtol),
        START_BOUND,
        START_PASSES,
    )
    .expect("exact consistent start at the saved state");
    let start_cpu = cpu::thread_s() - c1.0;
    let start_wall = c1.1.elapsed().as_secs_f64();
    let c2 = (cpu::thread_s(), Instant::now());
    let nonnegative = joined.network.nonnegative_stocks();
    let system = Integrated::with_blocks(joined, t, &y).expect("block assembly");
    let mut ida = Ida::new(
        system,
        Initial {
            time: t,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    configure(&mut ida, &nonnegative);
    let report = json!({
        "compile": timings,
        "consistent_start": {"cpu_s": start_cpu, "wall_s": start_wall,
            "jacobian_s": start.jacobian_s, "factor_s": start.factor_s, "solve_s": start.solve_s,
            "projection_passes": start.projection_passes, "rate_passes": start.rate_passes,
            "correction_wrms": start.correction_wrms, "residual": start.residual.value,
            "constraint_rate": start.constraint_rate.value, "colors": start.colors},
        "solver_cpu_s": cpu::thread_s() - c2.0,
        "total_cpu_s": cpu::thread_s() - c0,
        "total_wall_s": w0.elapsed().as_secs_f64(),
        "dimension": y.len(),
    });
    (
        Unit {
            ida,
            y,
            yp,
            t,
            ids,
            atol,
            rtol,
            nonnegative,
        },
        report,
    )
}

impl Unit {
    fn advance(&mut self, end: f64, stop: bool) -> Result<(), String> {
        if stop {
            self.ida.stop_at(end)?;
        }
        match self.ida.advance(end, &mut self.y, &mut self.yp)? {
            Advance::Reached(t) => {
                self.t = t;
                Ok(())
            }
            Advance::Root { time, directions } => Err(format!("root at {time} s: {directions:?}")),
        }
    }
    /// The exact consistent restart at the unit's boundary state (the
    /// discrete restart's steps 4-5 without a transaction).
    fn restart(&mut self) -> Value {
        let (c0, w0) = (cpu::thread_s(), Instant::now());
        let mut y = self.y.clone();
        let (yp, start) = leitbild_operating_water::joined::consistent_start(
            &mut self.ida.system_mut().joined,
            self.t,
            &mut y,
            &self.ids,
            &weights(&self.y, &self.atol, self.rtol),
            START_BOUND,
            START_PASSES,
        )
        .expect("exact consistent restart");
        let start_cpu = cpu::thread_s() - c0;
        self.ida.reinitialize(self.t, &y, &yp).unwrap();
        configure(&mut self.ida, &self.nonnegative);
        self.y = y;
        self.yp = yp;
        json!({"consistent_start_cpu_s": start_cpu, "cpu_s": cpu::thread_s() - c0,
            "wall_s": w0.elapsed().as_secs_f64(), "projection_passes": start.projection_passes,
            "jacobian_s": start.jacobian_s, "factor_s": start.factor_s})
    }
    fn counts(&self) -> [i64; 6] {
        let s = self.ida.stats().unwrap();
        [
            s.steps,
            s.residuals,
            s.jacobians,
            s.nonlinear_iterations,
            s.error_failures,
            s.convergence_failures,
        ]
    }
    fn signals(&mut self) -> Vec<f64> {
        let j = &mut self.ida.system_mut().joined;
        j.evaluate(self.t, &self.y, &self.yp, None, 0., None)
            .expect("observation");
        let released = j.heats().nuclear.released_w.value;
        let pt1 = j.network.pzr_taps().map_or(f64::NAN, |t| t.pt1_pa.value);
        vec![released, pt1]
    }
}

/// From the restored unit's start: `warm` s in the variant's own mode, then
/// `span` s measured with boundaries every `h` (None: one free advance).
fn variant(
    unit: &mut Unit,
    base: (f64, &[f64], &[f64]),
    h: Option<f64>,
    stop: bool,
    warm: f64,
    span: f64,
) -> Value {
    // Every variant starts from the same consistent pair by IDAReInit with
    // the probe's configuration, so it pays the same restart.
    unit.t = base.0;
    unit.y.copy_from_slice(base.1);
    unit.yp.copy_from_slice(base.2);
    unit.ida.reinitialize(base.0, base.1, base.2).unwrap();
    configure(&mut unit.ida, &unit.nonnegative.clone());
    let t0 = base.0;
    let run = |unit: &mut Unit, to: f64| -> Result<(f64, f64, usize), String> {
        let (c, w) = (cpu::thread_s(), Instant::now());
        let mut n = 0;
        match h {
            None => {
                // IDA_NORMAL output targets in 1 s chunks change no step.
                while unit.t < to {
                    unit.advance((unit.t + 1.).min(to), false)?;
                    n += 1;
                }
            }
            Some(h) => {
                let mut k = ((unit.t - t0) / h).round() as i64;
                while unit.t < to - 1e-12 {
                    k += 1;
                    unit.advance((t0 + k as f64 * h).min(to), stop)?;
                    n += 1;
                }
            }
        }
        Ok((cpu::thread_s() - c, w.elapsed().as_secs_f64(), n))
    };
    let r = run(unit, t0 + warm);
    if let Err(e) = r {
        return json!({"interval_s": h, "stop": stop, "failure": e, "phase": "warm"});
    }
    let c0 = unit.counts();
    let j0 = unit.ida.system().joined.counters;
    let measured = run(unit, t0 + warm + span);
    let c1 = unit.counts();
    let j1 = unit.ida.system().joined.counters;
    let st = unit.ida.stats().unwrap();
    match measured {
        Err(e) => json!({"interval_s": h, "stop": stop, "failure": e, "phase": "span"}),
        Ok((cpu_s, wall_s, n)) => {
            let d: Vec<i64> = c1.iter().zip(c0).map(|(a, b)| a - b).collect();
            json!({"interval_s": h, "stop": stop, "warm_s": warm, "span_s": span, "boundaries": n,
                "steps": d[0], "residuals": d[1], "jacobians": d[2], "nonlinear_iterations": d[3],
                "error_failures": d[4], "convergence_failures": d[5],
                "steps_per_s": d[0] as f64 / span, "jacobians_per_s": d[2] as f64 / span,
                "cpu_s_per_s": cpu_s / span, "wall_s_per_s": wall_s / span,
                "residual_wall_ms_per_call": 1e3 * (j1.residual_wall_s - j0.residual_wall_s) / ((j1.residuals - j0.residuals).max(1) as f64),
                "jacobian_wall_ms_per_call": 1e3 * (j1.jacobian_wall_s - j0.jacobian_wall_s) / ((j1.jacobians - j0.jacobians).max(1) as f64),
                "last_step_s": st.last_step, "last_order": st.last_order, "end_t": unit.t})
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(
        args.len() == 5,
        "usage: ld01-spike-joined <packet> <wiki> <settled> <receipt>"
    );
    let out = std::path::PathBuf::from(&args[4]);
    assert!(!out.exists(), "receipts are never overwritten");
    let started = (cpu::process_s(), Instant::now());
    let bytes = std::fs::read(&args[1]).expect("packet");
    let gates: Value = {
        let page = std::path::Path::new(&args[2])
            .join("world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md");
        let text = std::fs::read_to_string(page).unwrap();
        let open = "```ld01-s1-gates\n";
        let s = text.find(open).unwrap() + open.len();
        let e = s + text[s..].find("\n```").unwrap();
        serde_json::from_str(&text[s..e]).unwrap()
    };
    let settled: Value =
        serde_json::from_slice(&std::fs::read(&args[3]).expect("settled state")).unwrap();
    let t_s = settled["t_s"].as_f64().unwrap();
    let saved: Vec<f64> = settled["y"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let only: Option<String> = std::env::var("LD01_SPIKE_ONLY").ok();
    let mut receipt = json!({
        "kind": "ld01-platform-exchange-cost-joined-NOT-EVIDENCE",
        "packet": args[1], "packet_sha256": leitbild_ld01_host_spike::sha256::hex(&bytes),
        "wiki": args[2], "settled_state": args[3], "settled_t_s": t_s,
        "water_build": serde_json::from_str::<Value>(include_str!(concat!(env!("LD01_OPERATING_WATER_LIB_DIR"), "/water-build.json"))).unwrap(),
        "configuration": {"maxOrder": MAX_ORDER, "newtonCoefficient": NEWTON_COEFFICIENT, "deltaCjLSetup": DELTA_CJ_LSETUP,
            "firstStep_s": FIRST_STEP_S, "jacobian": "block assembly (Integrated::with_blocks)",
            "consistentStart": "water-ffi joined::consistent_start (colored assemblies, today's code; S2-D4 moves it to the block Jacobian)"},
    });
    // (2) Restore: compile + exact consistent start from the saved y.
    let (mut unit, restore_report) = restore(&bytes, &gates, t_s, &saved);
    eprintln!("restore {restore_report}");
    receipt["restore"] = restore_report;
    receipt["snapshot_bytes_y_yp_atol"] = json!(24 * unit.y.len());
    let base_y = unit.y.clone();
    let base_yp = unit.yp.clone();
    let base = (t_s, base_y.as_slice(), base_yp.as_slice());
    // Observation cost: one full joined evaluation at the boundary state.
    let c = cpu::thread_s();
    for _ in 0..10 {
        unit.signals();
    }
    receipt["observe_cpu_ms_per_call"] = json!(100. * (cpu::thread_s() - c));
    // One unit only (peak RSS of a single restored unit), then 10 s free.
    if only.as_deref() == Some("single") {
        unit.advance(t_s + 10., false).expect("single unit advance");
        receipt["single_unit_reached_s"] = json!(unit.t);
        std::fs::write(&out, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        eprintln!("wrote {}", out.display());
        return;
    }
    // (1) Quiet cost: free versus stop at every boundary.
    let mut variants = Vec::new();
    let plan: Vec<(Option<f64>, bool, f64, f64)> = vec![
        (None, false, 20., 40.),
        (Some(0.02), false, 5., 10.),
        (Some(1.0), true, 5., 10.),
        (Some(0.1), true, 5., 10.),
        (Some(0.05), true, 5., 10.),
        (Some(0.02), true, 5., 10.),
        (Some(0.01), true, 5., 5.),
    ];
    if only.as_deref() != Some("restore") {
        for (h, stop, warm, span) in plan {
            let v = variant(&mut unit, base, h, stop, warm, span);
            eprintln!("variant {v}");
            variants.push(v);
        }
    }
    receipt["variants"] = json!(variants);
    // (3) Discrete restarts: three exact consistent restarts 1 s apart.
    let mut restarts = Vec::new();
    unit.ida.reinitialize(t_s, &base_y, &base_yp).unwrap();
    configure(&mut unit.ida, &unit.nonnegative.clone());
    unit.t = t_s;
    unit.y.copy_from_slice(&base_y);
    unit.yp.copy_from_slice(&base_yp);
    for k in 1..=3 {
        let c = cpu::thread_s();
        let c0 = unit.counts();
        unit.advance(t_s + k as f64, true).expect("to restart");
        let advance_cpu = cpu::thread_s() - c;
        let c1 = unit.counts();
        let r = unit.restart();
        eprintln!("restart {r}");
        restarts.push(
            json!({"t_s": unit.t, "restart": r, "preceding_second": {"cpu_s": advance_cpu,
            "steps": c1[0] - c0[0], "jacobians": c1[2] - c0[2]}}),
        );
    }
    receipt["restarts"] = json!(restarts);
    // (4) Copy equivalence at a restart boundary: the source restarted in
    // place (IDAReInit) at t_c; the copy recompiled and restarted from the
    // source's y there. Both advance 5 s in 1 s outputs.
    let t_c = unit.t;
    let copy_y = unit.y.clone();
    let (mut copy, copy_report) = restore(&bytes, &gates, t_c, &copy_y);
    let projected_equal = copy
        .y
        .iter()
        .zip(&unit.y)
        .all(|(a, b)| a.to_bits() == b.to_bits())
        && copy
            .yp
            .iter()
            .zip(&unit.yp)
            .all(|(a, b)| a.to_bits() == b.to_bits());
    let mut t = t_c;
    let mut diverged = Value::Null;
    while t < t_c + 5. {
        t += 1.;
        unit.advance(t, false).expect("source");
        copy.advance(t, false).expect("copy");
        let same = copy
            .y
            .iter()
            .zip(&unit.y)
            .all(|(a, b)| a.to_bits() == b.to_bits());
        if !same && diverged.is_null() {
            let rel = copy
                .y
                .iter()
                .zip(&unit.y)
                .map(|(a, b)| (a - b).abs() / a.abs().max(b.abs()).max(1e-300))
                .fold(0., f64::max);
            diverged = json!({"t_s": t, "y_max_rel_diff": rel});
        }
    }
    let (ss, sc) = (unit.signals(), copy.signals());
    receipt["copy"] = json!({"t_copy_s": t_c, "horizon_s": 5., "restart_pair_bitwise_equal": projected_equal,
        "first_divergence": diverged, "y_bitwise_identical_at_end": diverged.is_null(),
        "signals_source": ss, "signals_copy": sc, "copy_restore": copy_report});
    receipt["process_cpu_s"] = json!(cpu::process_s() - started.0);
    receipt["wall_s"] = json!(started.1.elapsed().as_secs_f64());
    receipt["load_average"] = json!(
        String::from_utf8_lossy(
            &std::process::Command::new("sysctl")
                .args(["-n", "vm.loadavg"])
                .output()
                .map(|o| o.stdout)
                .unwrap_or_default()
        )
        .trim()
        .to_string()
    );
    std::fs::write(&out, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    eprintln!("wrote {}", out.display());
}

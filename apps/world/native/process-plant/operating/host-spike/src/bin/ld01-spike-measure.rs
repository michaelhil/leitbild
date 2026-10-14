//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#selected-electrical-interval-handoff
//! NOT-EVIDENCE measurement (PLATFORM lane, S2-D15) on the S1 network:
//! (1) quiet cost of a unit that must stop at every exchange boundary
//! (IDASetStopTime, history retained) versus free stepping and versus
//! interpolated boundaries; (2) the cost of a restore by the exact consistent
//! start from saved truth; (3) copy equivalence. In-process, no IPC.
//!
//! Usage: ld01-spike-measure <packet.json> <wiki-root> <receipt.json>
use leitbild_ld01_host_spike::{
    cpu,
    unit::{Config, Counts, Mode, SIGNALS, Unit},
};
use serde_json::{Value, json};
use std::time::Instant;

fn kernel() -> String {
    let exe = std::env::current_exe().expect("current exe");
    leitbild_ld01_host_spike::sha256::hex(&std::fs::read(exe).expect("read exe"))
}

fn signals(unit: &mut Unit) -> Vec<f64> {
    let mut out = vec![0.; SIGNALS.len()];
    unit.observe(&mut out).expect("observe");
    out
}

/// S1's settling criterion (ld01-s1-gates `settling`), advanced in 1 s
/// interpolated outputs: every rotor within `rotor_rel` of the reference
/// speed and both loop flows within `flow_rel` of their value `window` ago.
fn settle(unit: &mut Unit, gates: &Value) -> Value {
    let s = &gates["settling"];
    let cap = s["maxSimulated_s"].as_f64().unwrap();
    let window = s["window_s"].as_f64().unwrap();
    let rotor_rel = s["rotorSpeedRelative"].as_f64().unwrap();
    let flow_rel = s["loopFlowRelativeChange"].as_f64().unwrap();
    let w0 = unit.reference_omega();
    let (cpu0, wall0) = (cpu::thread_s(), Instant::now());
    let mut history: Vec<(f64, [f64; 2])> = Vec::new();
    let mut t = unit.time();
    let mut last;
    let settled = loop {
        t += 1.;
        last = Some(unit.advance(t, Mode::Interpolate).expect("settle advance"));
        let x = signals(unit);
        let flows = [x[3], x[4]];
        history.push((t, flows));
        let earlier = history.iter().rev().find(|h| h.0 <= t - window);
        let rested = earlier.is_some_and(|e| {
            x[5..9].iter().all(|w| ((w - w0) / w0).abs() < rotor_rel)
                && (0..2).all(|k| ((flows[k] - e.1[k]) / flows[k]).abs() < flow_rel)
        });
        if rested {
            break Some(t);
        }
        if t >= cap {
            break None;
        }
    };
    json!({"settled_at_s": settled, "reached_s": t, "cpu_s": cpu::thread_s() - cpu0,
        "wall_s": wall0.elapsed().as_secs_f64(), "last": last, "signals": signals(unit)})
}

fn minus(a: Counts, b: Counts) -> Value {
    json!({"steps": a.steps - b.steps, "residuals": a.residuals - b.residuals,
        "jacobians": a.jacobians - b.jacobians,
        "nonlinear_iterations": a.nonlinear_iterations - b.nonlinear_iterations,
        "error_failures": a.error_failures - b.error_failures,
        "convergence_failures": a.convergence_failures - b.convergence_failures,
        "restarts": a.restarts - b.restarts, "rebuilds": a.rebuilds - b.rebuilds})
}

/// One exchange variant from the same restored state: a common warm-up of
/// `warm` s in the variant's own mode, then `span` s measured.
#[allow(clippy::too_many_arguments)]
fn variant(
    config: &Config,
    kernel: &str,
    blob: &[u8],
    name: &str,
    interval: Option<f64>,
    mode: Mode,
    observe: bool,
    warm: f64,
    span: f64,
) -> Value {
    let (mut unit, _) = Unit::restore(config, kernel, blob).expect("restore");
    let t0 = unit.time();
    let run = |unit: &mut Unit, from: f64, to: f64| -> (Counts, f64, f64, f64, usize) {
        let (mut advance_cpu, mut observe_cpu, mut boundaries) = (0., 0., 0);
        let wall = Instant::now();
        let last;
        match interval {
            None => {
                let r = unit.advance(to, mode).expect("free advance");
                advance_cpu += r.cpu_s;
                last = Some(r.counts);
                boundaries += 1;
            }
            Some(h) => {
                let mut k = ((from - t0) / h).round() as i64;
                let mut reached;
                loop {
                    k += 1;
                    let t = (t0 + k as f64 * h).min(to);
                    let r = unit.advance(t, mode).expect("boundary advance");
                    advance_cpu += r.cpu_s;
                    reached = Some(r.counts);
                    boundaries += 1;
                    if observe {
                        let c = cpu::thread_s();
                        signals(unit);
                        observe_cpu += cpu::thread_s() - c;
                    }
                    if t >= to {
                        break;
                    }
                }
                last = reached;
            }
        }
        (
            last.unwrap(),
            advance_cpu,
            observe_cpu,
            wall.elapsed().as_secs_f64(),
            boundaries,
        )
    };
    let (c_warm, _, _, _, _) = run(&mut unit, t0, t0 + warm);
    let (c_end, advance_cpu, observe_cpu, wall, boundaries) =
        run(&mut unit, t0 + warm, t0 + warm + span);
    let d = minus(c_end, c_warm);
    let per = |k: &str| d[k].as_i64().unwrap() as f64 / span;
    json!({
        "variant": name, "interval_s": interval, "mode": format!("{mode:?}"), "observe": observe,
        "warm_s": warm, "span_s": span, "boundaries": boundaries, "counts": d,
        "steps_per_s": per("steps"), "residuals_per_s": per("residuals"),
        "jacobians_per_s": per("jacobians"),
        "advance_cpu_s_per_s": advance_cpu / span,
        "observe_cpu_s_per_s": observe_cpu / span,
        "observe_cpu_us_per_boundary": if observe { 1e6 * observe_cpu / boundaries as f64 } else { 0. },
        "wall_s_per_s": wall / span,
        "end_signals": signals(&mut unit),
    })
}

fn max_rel(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs() / x.abs().max(y.abs()).max(1e-300))
        .fold(0., f64::max)
}

/// Copy equivalence at `t_c`: the source continues (plain, or restarted or
/// rebuilt at t_c); the copy restores the snapshot taken at t_c. Both reach
/// t_c + horizon in 1 s interpolated outputs; y is compared bitwise.
fn copy_case(
    config: &Config,
    kernel: &str,
    blob: &[u8],
    at: f64,
    horizon: f64,
    mode: Mode,
) -> Value {
    let (mut source, _) = Unit::restore(config, kernel, blob).expect("restore source");
    let t_c = source.time() + at;
    source
        .advance(
            t_c,
            if mode == Mode::Interpolate {
                Mode::Stop
            } else {
                mode
            },
        )
        .expect("to copy point");
    let snap = source.snapshot().expect("snapshot");
    let (mut copy, report) = Unit::restore(config, kernel, &snap).expect("restore copy");
    let mut t = t_c;
    let end = t_c + horizon;
    while t < end {
        t = (t + 1.).min(end);
        source.advance(t, Mode::Interpolate).expect("source");
        copy.advance(t, Mode::Interpolate).expect("copy");
    }
    let ys = source.state().0.to_vec();
    let yc = copy.state().0.to_vec();
    let identical = ys.iter().zip(&yc).all(|(a, b)| a.to_bits() == b.to_bits());
    let (ss, sc) = (signals(&mut source), signals(&mut copy));
    json!({"source_at_copy_point": format!("{mode:?}"), "t_copy_s": t_c, "horizon_s": horizon,
        "y_bitwise_identical": identical, "y_max_rel_diff": max_rel(&ys, &yc),
        "signals_max_rel_diff": max_rel(&ss, &sc), "copy_restore": report})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(
        args.len() == 4,
        "usage: ld01-spike-measure <packet> <wiki> <receipt>"
    );
    let receipt_path = std::path::PathBuf::from(&args[3]);
    assert!(!receipt_path.exists(), "receipts are never overwritten");
    let config = Config {
        packet: args[1].clone().into(),
        wiki: args[2].clone().into(),
    };
    let kernel = kernel();
    let started = (cpu::process_s(), Instant::now());
    let gates: Value = {
        let page = config
            .wiki
            .join("world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md");
        let text = std::fs::read_to_string(page).unwrap();
        let open = "```ld01-s1-gates\n";
        let s = text.find(open).unwrap() + open.len();
        let e = s + text[s..].find("\n```").unwrap();
        serde_json::from_str(&text[s..e]).unwrap()
    };
    let (mut unit, load) = Unit::load(&config, &kernel).expect("load");
    eprintln!("loaded n={} in {:.3}s", unit.dimension(), load.wall_s);
    let settle = settle(&mut unit, &gates);
    eprintln!("settle {settle}");
    let mut snapshots = Vec::new();
    let mut blob = Vec::new();
    for _ in 0..5 {
        let (c, w) = (cpu::thread_s(), Instant::now());
        blob = unit.snapshot().expect("snapshot");
        snapshots.push(json!({"bytes": blob.len(), "cpu_s": cpu::thread_s() - c, "wall_s": w.elapsed().as_secs_f64()}));
    }
    let mut restores = Vec::new();
    for _ in 0..5 {
        let (_, r) = Unit::restore(&config, &kernel, &blob).expect("restore");
        restores.push(serde_json::to_value(r).unwrap());
    }
    eprintln!("restores {}", restores[0]);
    // The first second after a restore against the same second continued
    // without one (history loss cost).
    let first_second = {
        let (mut fresh, _) = Unit::restore(&config, &kernel, &blob).expect("restore");
        let t0 = fresh.time();
        let r = fresh
            .advance(t0 + 1., Mode::Interpolate)
            .expect("after restore");
        let mut base = unit.advance(t0 + 1., Mode::Interpolate).expect("continued");
        base.counts.restarts = 0;
        json!({"after_restore": r, "continued": base})
    };
    let (warm, span) = (2., 10.);
    let mut variants = vec![variant(
        &config,
        &kernel,
        &blob,
        "free",
        None,
        Mode::Interpolate,
        false,
        warm,
        span,
    )];
    for h in [0.1, 0.05, 0.02, 0.01] {
        variants.push(variant(
            &config,
            &kernel,
            &blob,
            "interpolate",
            Some(h),
            Mode::Interpolate,
            true,
            warm,
            span,
        ));
        variants.push(variant(
            &config,
            &kernel,
            &blob,
            "stop",
            Some(h),
            Mode::Stop,
            false,
            warm,
            span,
        ));
        eprintln!(
            "h={h}: {} | {}",
            variants[variants.len() - 2]["advance_cpu_s_per_s"],
            variants[variants.len() - 1]["advance_cpu_s_per_s"]
        );
    }
    for h in [1.0, 0.1] {
        variants.push(variant(
            &config,
            &kernel,
            &blob,
            "restart",
            Some(h),
            Mode::Restart,
            false,
            warm,
            span / 2.,
        ));
        variants.push(variant(
            &config,
            &kernel,
            &blob,
            "rebuild",
            Some(h),
            Mode::Rebuild,
            false,
            warm,
            span / 2.,
        ));
        eprintln!(
            "h={h}: restart {} rebuild {}",
            variants[variants.len() - 2]["advance_cpu_s_per_s"],
            variants[variants.len() - 1]["advance_cpu_s_per_s"]
        );
    }
    let copies = [Mode::Interpolate, Mode::Restart, Mode::Rebuild]
        .map(|m| copy_case(&config, &kernel, &blob, 1., 10., m));
    eprintln!("copies {}", json!(copies));
    let receipt = json!({
        "kind": "ld01-platform-exchange-cost-s1-NOT-EVIDENCE",
        "identity": unit.identity(),
        "packet": config.packet, "wiki": config.wiki,
        "dimension": unit.dimension(),
        "load": load, "settle": settle,
        "snapshot": snapshots, "restore": restores, "first_second": first_second,
        "variants": variants, "copies": copies,
        "process_cpu_s": cpu::process_s() - started.0,
        "wall_s": started.1.elapsed().as_secs_f64(),
        "signals": SIGNALS,
    });
    std::fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    eprintln!("wrote {}", receipt_path.display());
}

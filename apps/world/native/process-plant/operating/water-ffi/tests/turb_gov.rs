//! Plan r4 X4.3 (lane TURB): the frame-driven S3 unit with the LOAD
//! governor, ADM and GEN.WT after the slice, the SG owner's choked valve law
//! and at-power bypass band, and automatic rod control in AUTO, from the
//! saved S3 state on a steady bus: a hold, or a hold with Grid power-request
//! steps decided at Grid exchanges (1 s instants). Test-only; one run per
//! invocation, ignored by default.
//!
//! Environment: the S3 unit's (`LD01_OPERATING_HOT_SPINE_PACKET`,
//! `LD01_WIKI_ROOT`, `LD01_IC_SECTION`, `LD01_PZR_CONTROL_SECTION`,
//! `LD01_PZR_CONTROL_WIKI`, `ELEC_PACKET`, `LD01_S3_STATE`),
//! `LD01_ROD_CONTROL_WIKI` (`ld01-rod-control`), `LD01_TURB_WIKI` (the
//! turbine and admission pages' blocks), `LD01_TURB_SPAN_S`,
//! `LD01_TURB_STEPS` (optional: `<fraction of the start request>@<seconds
//! after the start>,...`, each on a whole second), `LD01_TURB_OUT`.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[allow(dead_code)]
#[path = "s3_harness/counters.rs"]
mod counters;

use leitbild_operating_plant::electrical::slice;
use leitbild_operating_water::{
    electrical::{self, Electrified},
    frame::{Change, Class, Client, Dense, Diagnostic, MatrixRebuild},
    joined::{Integrated, JoinedSystem},
    unit::{
        clock::process_cpu_s,
        inputs::Inputs,
        plant::{self, Plant},
        profile::Solver,
        rod_control, s3,
        turbine::{self, Turbine},
    },
};
use serde_json::{Value, json};

type Unit = Electrified<Integrated<leitbild_operating_water::If97>>;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

/// Per frame (observation only): instructions retired, the governor's
/// coordinates and setpoint, speed, the SG pressures and the band opening
/// the SG owner's at-power law gives them.
struct Recorder {
    n: usize,
    pressures: Vec<(usize, f64)>,
    band: [f64; 3],
    setpoint_w: f64,
    mode: String,
    scratch: Vec<f64>,
    cost: Vec<(f64, u64)>,
    series: Vec<Value>,
}
impl Client<Unit> for Recorder {
    fn name(&self) -> &str {
        "X4.3 recorder"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn sample(&mut self, _: u64, t: f64, u: &Unit) -> Result<(), String> {
        let g = u.governor.as_ref().ok_or("no governor")?;
        self.setpoint_w = g.setpoint_w(t);
        self.mode = g.held.mode.to_string();
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<Unit>>, String> {
        self.cost.push((t, counters::instructions()?));
        dense.derivative(t, 0, &mut self.scratch)?;
        let y = &self.scratch;
        let (n, e) = (self.n, electrical::N);
        let p: Vec<f64> = self.pressures.iter().map(|(i, s)| y[*i] * s).collect();
        let [lo, hi, loss] = self.band;
        let band: Vec<f64> = p
            .iter()
            .map(|p| ((p - loss - lo) / (hi - lo)).clamp(0., 1.))
            .collect();
        self.series.push(json!({"k": k, "t_s": t, "watt_W": y[n + e], "integral": y[n + e + 1], "opening": y[n + e + 2],
            "setpoint_W": self.setpoint_w, "mode": self.mode, "omega_rad_s": y[n + slice::OMEGA],
            "sg_pressure_Pa": p, "bypass_band_opening": band}));
        Ok(Vec::new())
    }
}

#[test]
#[ignore = "one X4.3 run per invocation (LD01_TURB_SPAN_S, LD01_TURB_STEPS, LD01_TURB_OUT)"]
fn turb_gov_run() {
    let started = process_cpu_s();
    let instructions0 = counters::instructions().unwrap();
    let inputs = Inputs::from_env().unwrap_or_else(|e| panic!("{e}"));
    let state_path = env("LD01_S3_STATE");
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    let span: f64 = env("LD01_TURB_SPAN_S").parse().unwrap();
    let steps: Vec<(f64, f64)> = std::env::var("LD01_TURB_STEPS").map_or(Vec::new(), |s| {
        s.split(',')
            .map(|e| {
                let (f, at) = e
                    .split_once('@')
                    .expect("LD01_TURB_STEPS=<fraction>@<s>,...");
                (f.parse().unwrap(), at.parse().unwrap())
            })
            .collect()
    });
    assert!(
        steps.windows(2).all(|w| w[0].1 < w[1].1)
            && steps
                .iter()
                .all(|s| s.1 > 0. && s.1 < span && s.1.fract() == 0.),
        "steps on whole seconds (Grid exchanges), in time order inside the span"
    );
    let turbine = Turbine::from_wiki(&env("LD01_TURB_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let section =
        rod_control::section(&env("LD01_ROD_CONTROL_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let packet = inputs.spine.packet_json().unwrap();
    let ids: Vec<String> = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let mut unit = s3::compose_governed(&inputs, &state, Solver::STOCK, &turbine)
        .unwrap_or_else(|e| panic!("{e}"));
    let (t0, y, reference, n) = (unit.t0, unit.y.clone(), unit.reference.clone(), unit.n);
    let request0 = unit.ida.system().governor.as_ref().unwrap().held.to_w;
    let pressures: Vec<(usize, f64)> = {
        let j = &unit.ida.system().integrated().joined;
        let o = j.offsets().secondary;
        let scales = j.scales();
        j.secondary()
            .unwrap()
            .admission_terms(t0)
            .unwrap()
            .iter()
            .map(|(i, _)| (o + i, scales[o + i]))
            .collect()
    };
    let (mut rods, rod_receipt) = rod_control::commission(
        unit.ida.system_mut(),
        &section,
        &ids,
        Class::S,
        t0,
        &y,
        &reference,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let mut plant = Plant::new(
        unit,
        &inputs.ic,
        plant::Config {
            field: None,
            diagnostic: Diagnostic::None,
            matrix_rebuild: MatrixRebuild::Stock,
            clock: process_cpu_s,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let mut rec = Recorder {
        n,
        pressures,
        band: [
            turbine.band_start_pa,
            turbine.band_full_pa,
            turbine.main_steam_loss_pa,
        ],
        setpoint_w: request0,
        // The start frame precedes any sample: the composed mode.
        mode: plant.ida.system().governor.as_ref().unwrap().held.mode.to_string(),
        scratch: vec![0.; y.len()],
        cost: Vec::new(),
        series: Vec::new(),
    };
    let composed_instructions = counters::instructions().unwrap();
    {
        let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut rec];
        plant.start(&mut extra).unwrap_or_else(|e| panic!("{e}"));
    }
    let end = t0 + span;
    let mut failure: Option<String> = None;
    let mut decisions = Vec::new();
    let mut t = t0;
    let mut legs: Vec<(f64, Option<f64>)> =
        steps.iter().map(|(f, at)| (t0 + at, Some(*f))).collect();
    legs.push((end, None));
    for (b, fraction) in &legs {
        let r = {
            let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut rec];
            plant.run(t, *b, &mut extra, None)
        };
        if let Err(e) = r {
            failure = Some(format!("at {} s: {e}", plant.driver.solver_reached_s));
            break;
        }
        t = *b;
        if let Some(f) = *fraction {
            let request = f * request0;
            let d = turbine::grid_request(&mut plant.driver, plant.ida.system(), t, request);
            let r = d.and_then(|what| {
                decisions.push(json!({"t_s": t, "request_W": request, "decision": what}));
                let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut rec];
                plant.apply_due(&mut extra)
            });
            if let Err(e) = r {
                failure = Some(format!("the Grid request at {t} s: {e}"));
                break;
            }
        }
    }
    let cpu = process_cpu_s() - started;
    let instructions = counters::instructions().unwrap();
    let reached = plant.driver.solver_reached_s;
    let receipt = json!({
        "case": if steps.is_empty() { "X4.3 LOAD hold" } else { "X4.3 Grid request steps" },
        "state": state_path, "t0_s": t0, "span_s": span, "request0_W": request0,
        "steps": steps.iter().map(|(f, a)| json!({"fraction": f, "at_s": a})).collect::<Vec<_>>(),
        "grid_decisions": decisions, "reached_s": reached, "failure": failure,
        "composition": plant.composition, "rod_control": rod_receipt,
        "timeline": {"zero_s": steps.first().map_or(t0, |(_, a)| t0 + a)},
        "run": {
            "ou_frame_instructions": rec.cost.iter().map(|(t, i)| json!([t, i])).collect::<Vec<_>>(),
            "instants": plant.driver.log, "counts": plant.driver.counts.json(),
            "counts_r": plant.driver.counts.total(Class::R), "counts_s": plant.driver.counts.total(Class::S),
            "cpu_s": cpu, "instructions": instructions - instructions0,
            "instructions_after_composition": instructions - composed_instructions,
        },
        "elec_log": plant.ida.system().log,
        "rod_schedule": rods.schedule, "rod_series": rods.series, "series": rec.series,
    });
    let out = env("LD01_TURB_OUT");
    std::fs::write(&out, serde_json::to_vec(&receipt).unwrap()).unwrap();
    eprintln!(
        "turb_gov: reached {reached} s of {end} s, {} R / {} S, {:.1} CPU-s, receipt {out}",
        plant.driver.counts.total(Class::R),
        plant.driver.counts.total(Class::S),
        cpu
    );
    if let Some(f) = receipt["failure"].as_str() {
        panic!("{f}");
    }
}

/// X4.3's new Jacobian entries against central differences of the
/// residual at the composed start: the valve column (SG rows, torque,
/// governor), the SG pressure columns (torque row) and the governor's and
/// stator columns (governor rows). Ignored by default (needs the S3 unit).
#[test]
#[ignore = "needs the S3 unit's environment and LD01_TURB_WIKI"]
fn turb_gov_jacobian_columns() {
    use leitbild_operating_water::ida::System;
    let inputs = Inputs::from_env().unwrap_or_else(|e| panic!("{e}"));
    let state: Value =
        serde_json::from_slice(&std::fs::read(env("LD01_S3_STATE")).unwrap()).unwrap();
    let turbine = Turbine::from_wiki(&env("LD01_TURB_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let mut unit = s3::compose_governed(&inputs, &state, Solver::STOCK, &turbine)
        .unwrap_or_else(|e| panic!("{e}"));
    let (t, n) = (unit.t0, unit.n);
    let (mut y, yp) = (unit.y.clone(), unit.yp.clone());
    // Off the start's full-open corner (u* = 1 there): the law's interior.
    y[n + electrical::N + 1] -= 0.05;
    y[n + electrical::N + 2] = 0.97;
    let sys = unit.ida.system_mut();
    let dim = sys.dimension();
    let nnz = sys.nonzeros();
    let cj = 50.;
    let (mut data, mut rows, mut ptr) = (vec![0.; nnz], vec![0i64; nnz], vec![0i64; dim + 1]);
    sys.jacobian(t, cj, &y, &yp, &mut data, &mut rows, &mut ptr)
        .unwrap();
    assert!(
        ptr[dim] as usize <= nnz,
        "the entries fit the declared capacity"
    );
    let entry = |r: usize, c: usize| -> Option<f64> {
        (ptr[c] as usize..ptr[c + 1] as usize)
            .find(|&k| rows[k] as usize == r)
            .map(|k| data[k])
    };
    let e = electrical::N;
    let a = n + e + 2;
    let pressures: Vec<usize> = {
        let j = &sys.integrated().joined;
        let o = j.offsets().secondary;
        j.secondary()
            .unwrap()
            .admission_terms(t)
            .unwrap()
            .iter()
            .map(|(i, _)| o + i)
            .collect()
    };
    let mut columns = vec![
        a,
        n + e,
        n + e + 1,
        n + 3,
        n + 4,
        n + slice::OMEGA,
        n + slice::THETA,
    ];
    columns.extend(&pressures);
    let mut worst: f64 = 0.;
    for &c in &columns {
        let h = 1e-6 * y[c].abs().max(1e-3);
        let (mut r1, mut r2) = (vec![0.; dim], vec![0.; dim]);
        let (mut y1, mut y2, mut p1, mut p2) = (y.clone(), y.clone(), yp.clone(), yp.clone());
        y1[c] += h;
        p1[c] += cj * h;
        y2[c] -= h;
        p2[c] -= cj * h;
        sys.residual(t, &y1, &p1, &mut r1).unwrap();
        sys.residual(t, &y2, &p2, &mut r2).unwrap();
        for r in 0..dim {
            let fd = (r1[r] - r2[r]) / (2. * h);
            let j = entry(r, c);
            // Only rows the X4.3 couplings touch: the SG rows on the valve,
            // the appended rows on every column checked.
            let checked = r >= n || c == a;
            if !checked {
                continue;
            }
            let scale = fd.abs().max(j.unwrap_or(0.).abs()).max(1e-12);
            match j {
                Some(v) => {
                    let rel = (v - fd).abs() / scale;
                    if rel > 1e-4 && (v - fd).abs() > 1e-9 {
                        panic!("row {r} column {c}: J {v} against FD {fd}");
                    }
                    worst = worst.max(if (v - fd).abs() > 1e-9 { rel } else { 0. });
                }
                None if fd.abs() > 1e-8 => {
                    panic!("row {r} column {c}: FD {fd} outside the pattern")
                }
                None => {}
            }
        }
    }
    eprintln!(
        "turb_gov_jacobian_columns: {} columns, worst relative difference {worst:e}",
        columns.len()
    );
}

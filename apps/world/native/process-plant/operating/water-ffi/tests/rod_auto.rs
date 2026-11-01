//! Plan r4 X4.4 (lane ROD): the frame-driven S3 unit with automatic rod
//! control in AUTO, from the saved S3 state, on a steady bus: a hold, or a
//! hold with turbine-load steps (the preview stand-in for X4.3's turbine
//! valve: the steam demand scaled at a frame instant). Test-only; one run
//! per invocation, ignored by default.
//!
//! Environment: the S3 unit's (`LD01_OPERATING_HOT_SPINE_PACKET`,
//! `LD01_WIKI_ROOT`, `LD01_IC_SECTION`, `LD01_PZR_CONTROL_SECTION`,
//! `LD01_PZR_CONTROL_WIKI`, `ELEC_PACKET`, `LD01_S3_STATE`), and
//! `LD01_ROD_CONTROL_WIKI` (the wiki root holding `ld01-rod-control`),
//! `LD01_ROD_SPAN_S` (seconds after the start), `LD01_ROD_STEPS` (optional:
//! `<load>@<seconds after the start>,...` in time order), `LD01_ROD_OUT`
//! (the receipt).
//! The process's instructions retired are recorded at every frame
//! (`run.ou_frame_instructions`, PERF's `ld01-cost` input).
#![cfg(all(feature = "ida", target_os = "macos"))]
#[allow(dead_code)]
#[path = "s3_harness/counters.rs"]
mod counters;

use leitbild_operating_water::{
    frame::{Action, Change, Class, Client, Dense, Diagnostic, MatrixRebuild},
    joined::JoinedSystem,
    unit::{
        clock::process_cpu_s,
        inputs::Inputs,
        plant::{self, Plant},
        profile::Solver,
        rod_control, s3,
    },
};
use serde_json::{Value, json};

type Unit = leitbild_operating_water::electrical::Electrified<
    leitbild_operating_water::joined::Integrated<leitbild_operating_water::If97>,
>;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

/// The process's instructions retired at each frame (observation only).
struct Cost(Vec<(f64, u64)>);
impl<S> Client<S> for Cost {
    fn name(&self) -> &str {
        "cost recorder"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn frame(&mut self, _: u64, t: f64, _: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        self.0.push((t, counters::instructions()?));
        Ok(Vec::new())
    }
}

#[test]
#[ignore = "one X4.4 run per invocation (LD01_ROD_SPAN_S, LD01_ROD_STEPS, LD01_ROD_OUT)"]
fn rod_auto_run() {
    let started = process_cpu_s();
    let instructions0 = counters::instructions().unwrap();
    let inputs = Inputs::from_env().unwrap_or_else(|e| panic!("{e}"));
    let state_path = env("LD01_S3_STATE");
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    let span: f64 = env("LD01_ROD_SPAN_S").parse().unwrap();
    let steps: Vec<(f64, f64)> = std::env::var("LD01_ROD_STEPS").map_or(Vec::new(), |s| {
        s.split(',')
            .map(|e| {
                let (load, at) = e.split_once('@').expect("LD01_ROD_STEPS=<load>@<s>,...");
                (load.parse().unwrap(), at.parse().unwrap())
            })
            .collect()
    });
    assert!(
        steps.windows(2).all(|w| w[0].1 < w[1].1) && steps.iter().all(|s| s.1 > 0. && s.1 < span),
        "steps in time order inside the span"
    );
    let section =
        rod_control::section(&env("LD01_ROD_CONTROL_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let packet = inputs.spine.packet_json().unwrap();
    let ids: Vec<String> = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let mut unit = s3::compose(&inputs, &state, Solver::STOCK).unwrap_or_else(|e| panic!("{e}"));
    let (t0, y, reference) = (unit.t0, unit.y.clone(), unit.reference.clone());
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
    let mut cost = Cost(Vec::new());
    let composed_instructions = counters::instructions().unwrap();
    {
        let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut cost];
        plant.start(&mut extra).unwrap_or_else(|e| panic!("{e}"));
    }
    let end = t0 + span;
    let mut failure: Option<String> = None;
    let mut t = t0;
    let mut legs: Vec<(f64, Option<f64>)> =
        steps.iter().map(|(l, at)| (t0 + at, Some(*l))).collect();
    legs.push((end, None));
    for (b, load) in &legs {
        let r = {
            let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut cost];
            plant.run(t, *b, &mut extra, None)
        };
        if let Err(e) = r {
            failure = Some(format!("at {} s: {e}", plant.driver.solver_reached_s));
            break;
        }
        t = *b;
        if let Some(load) = *load {
            let d = plant.driver.decide(vec![Change {
                due_s: t,
                class: Class::S,
                kind: "turbine load step (X4.4 preview stand-in)".into(),
                action: Action::Held(Box::new(move |s: &mut Unit| {
                    s.integrated_mut()
                        .joined
                        .secondary_mut()
                        .ok_or("no SG owner")?
                        .set_turbine_load(t, load)
                        .map(|_| ())
                        .map_err(|f| format!("{f:?}"))
                })),
            }]);
            let r = d.and_then(|()| {
                let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut cost];
                plant.apply_due(&mut extra)
            });
            if let Err(e) = r {
                failure = Some(format!("the load step at {t} s: {e}"));
                break;
            }
        }
    }
    let cpu = process_cpu_s() - started;
    let instructions = counters::instructions().unwrap();
    let reached = plant.driver.solver_reached_s;
    let receipt = json!({
        "case": if steps.is_empty() { "X4.4 AUTO hold" } else { "X4.4 load steps (preview)" },
        "state": state_path, "t0_s": t0, "span_s": span, "steps": steps.iter().map(|(l, a)| json!({"load": l, "at_s": a})).collect::<Vec<_>>(),
        "reached_s": reached, "failure": failure,
        "composition": plant.composition, "rod_control": rod_receipt,
        "timeline": {"zero_s": steps.first().map_or(t0, |(_, a)| t0 + a)},
        "run": {
            "ou_frame_instructions": cost.0.iter().map(|(t, i)| json!([t, i])).collect::<Vec<_>>(),
            "instants": plant.driver.log, "counts": plant.driver.counts.json(),
            "counts_r": plant.driver.counts.total(Class::R), "counts_s": plant.driver.counts.total(Class::S),
            "cpu_s": cpu, "instructions": instructions - instructions0,
            "instructions_after_composition": instructions - composed_instructions,
        },
        "rod_schedule": rods.schedule, "series": rods.series,
    });
    let out = env("LD01_ROD_OUT");
    std::fs::write(&out, serde_json::to_vec(&receipt).unwrap()).unwrap();
    eprintln!(
        "rod_auto: reached {reached} s of {end} s, {} R / {} S, {} rate changes, {:.1} CPU-s, receipt {out}",
        plant.driver.counts.total(Class::R),
        plant.driver.counts.total(Class::S),
        rods.schedule.len(),
        cpu
    );
    if let Some(f) = receipt["failure"].as_str() {
        panic!("{f}");
    }
}

/// WORLD2's E0 (lead, 1 Nov): the unit with acquired protection takes a
/// turbine trip (the holding circuit opens through the protection), then a
/// manual reactor trip with the circuit already open, then advances. The
/// second trip is acknowledged with no change; the unit must not fail-stop.
/// Ignored by default (needs the S3 unit's environment).
#[test]
#[ignore = "needs the S3 unit's environment"]
fn rod_trip_then_trip_again_then_advance() {
    use leitbild_operating_plant::joined::block::Command;
    let inputs = Inputs::from_env().unwrap_or_else(|e| panic!("{e}"));
    let state: Value =
        serde_json::from_slice(&std::fs::read(env("LD01_S3_STATE")).unwrap()).unwrap();
    let unit = s3::compose(&inputs, &state, Solver::STOCK).unwrap_or_else(|e| panic!("{e}"));
    let t0 = unit.t0;
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
    plant.start(&mut []).unwrap();
    plant.run(t0, t0 + 1., &mut [], None).unwrap();
    plant
        .driver
        .command(t0 + 1., Command::TurbineTripAcquired)
        .unwrap();
    plant.run(t0 + 1., t0 + 4., &mut [], None).unwrap();
    let rods = |p: &Plant<_>| {
        p.ida
            .system()
            .integrated()
            .joined
            .rods()
            .unwrap()
            .discrete_state()
    };
    let opened = rods(&plant);
    assert!(
        !opened["holding_open_at"].is_null(),
        "the turbine trip opened the holding circuit ({})",
        opened["holding_open_at"]
    );
    plant
        .driver
        .command(t0 + 4., Command::ManualReactorTrip)
        .unwrap();
    plant
        .run(t0 + 4., t0 + 6., &mut [], None)
        .unwrap_or_else(|e| panic!("the second trip fail-stopped the unit: {e}"));
    assert_eq!(
        rods(&plant)["holding_open_at"],
        opened["holding_open_at"],
        "the second trip changes nothing"
    );
    eprintln!(
        "rod_trip_then_trip_again_then_advance: holding opened at {}, reached {} s",
        opened["holding_open_at"], plant.driver.solver_reached_s
    );
}

//! Plan r4 X4.2: a saved S3 state of the packet without the CVCS, carried
//! onto the composed packet that adds it (`cvcs_state_onto_the_cvcs_packet`,
//! ignored; one run per tuple). Every existing coordinate keeps its exact
//! bits; the CVCS block follows the PZR block at the end of `y`, so the new
//! coordinates are appended:
//! - the tank stocks at their original preparation (`ld01-cvcs`);
//! - the controller at its tracked AUTO point of the saved state
//!   ([`Joined::prepare_cvcs`]): the level and loop-average lags at their
//!   inputs, each branch at its AUTO request with its stem at the opening
//!   that passes it, the flow lags at the flows and the integrals at zero
//!   error.
//!
//! The operator's discrete state gains the CVCS modes (AUTO, no stop, no
//! transfer, AC.B supplying CHARGE.P1). Rates of the new coordinates are
//! zero; the composition's exact consistent start then makes the start
//! consistent. The conversion claims nothing beyond these rules.
//!
//! Environment: `LD01_OPERATING_HOT_SPINE_PACKET` (the composed packet),
//! `LD01_CVCS_FROM_STATE` (the saved state), `LD01_CVCS_STATE_OUT`.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}
fn bits(v: &[f64]) -> Vec<String> {
    v.iter().map(|x| format!("{:016x}", x.to_bits())).collect()
}
fn from_bits(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("bits array")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect()
}

#[test]
#[ignore = "one conversion per tuple: LD01_CVCS_FROM_STATE onto the composed CVCS packet"]
fn cvcs_state_onto_the_cvcs_packet() {
    // The water method this harness composes on (lead, 1 Nov: a state is
    // prepared on the method it runs): LD01_S3_WATER, unset the IF97
    // reference; selected before any water call and recorded.
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "if97".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    let (packet_path, _) = common::packet_bytes();
    let sha256 = |path: &str| common::provenance::sha256_file(path).expect("sha256");
    let from_path = env("LD01_CVCS_FROM_STATE");
    let out = env("LD01_CVCS_STATE_OUT");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let from_bytes = std::fs::read(&from_path).expect("saved state");
    let from_sha256 = sha256(&from_path);
    let mut state: Value = serde_json::from_slice(&from_bytes).expect("state json");
    let mut s = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the composition");
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    let cvcs = joined.cvcs().expect("the packet composes the CVCS").clone();
    let o = joined.offsets();
    let (old_y, old_yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    assert_eq!(
        old_y.len(),
        o.cvcs,
        "the saved state is the composed packet's without the CVCS"
    );
    let scales: Vec<f64> = cvcs.layout().scales.clone();
    let mut y = old_y.clone();
    y.extend(cvcs.prepared().iter().zip(&scales).map(|(v, s)| v / s));
    let mut yp = old_yp.clone();
    yp.resize(y.len(), 0.);
    let operator = &mut state["discrete_state"]["operator"];
    assert!(operator.get("cvcs").is_none(), "a state without the CVCS");
    operator["cvcs"] = cvcs.discrete_state();
    joined
        .restore_discrete_state(&state["discrete_state"]["operator"])
        .expect("the discrete state with the CVCS modes");
    let t0 = state["t_s"].as_f64().expect("t_s");
    joined.prepare_cvcs(t0, &mut y).expect("the tracked point");
    assert!(
        y[..o.cvcs]
            .iter()
            .zip(&old_y)
            .all(|(a, b)| a.to_bits() == b.to_bits()),
        "every existing coordinate keeps its bits"
    );
    let layout = joined.cvcs().expect("CVCS").layout().clone();
    let report: Vec<Value> = layout
        .labels
        .iter()
        .zip(&layout.scales)
        .enumerate()
        .map(|(k, (l, sc))| json!([l, y[o.cvcs + k] * sc]))
        .collect();
    state["y"] = json!(y);
    state["yp"] = json!(yp);
    state["y_bits"] = json!(bits(&y));
    state["yp_bits"] = json!(bits(&yp));
    state["packet_sha256"] = json!(sha256(&packet_path));
    state["packet"] = json!(packet_path);
    state["converted_cvcs"] = json!({"from": from_path, "from_sha256": from_sha256,
        "rule": "plan r4 X4.2: existing coordinates bitwise; the CVCS block appended: tank stocks at their original preparation, the controller at its tracked AUTO point of the saved state (Joined::prepare_cvcs); CVCS modes AUTO, no stop, no transfer, AC.B supplying; rates of the new coordinates zero",
        "cvcs": report});
    state["water"] = json!(water);
    std::fs::write(&out, serde_json::to_vec(&state).expect("state json")).expect("write");
    println!(
        "{}",
        serde_json::to_string_pretty(&state["converted_cvcs"]).expect("json")
    );
}

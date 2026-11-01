//! R4-PZR-PI (lead 1 Nov; on PERF3's R4-PZR-CONTINUOUS carry): a saved S3
//! state of the packet without the PZR owner's continuous master, carried
//! onto the composed packet that adds it
//! (`pzr_state_onto_the_continuous_packet`, ignored; one run per tuple).
//! Every existing coordinate keeps its exact bits; the master's coordinates
//! are the PZR block's last (the PT1 channel lag, the integral and, with the
//! spray path, the stem), so they are inserted before the CVCS block:
//! - the lag at the state's roof pressure (the commissioned channel at a
//!   settled state), its rate zero;
//! - the integral at 0 and its rate zero: the S3 composition's
//!   commissioning carries the held demand into it exactly
//!   (`pzr_control::commission`), so the state stays in its held form;
//! - the stem at 0, locked (the S3 state's spray path is closed), rate zero.
//!
//! The composition's exact consistent start then makes the start
//! consistent. The conversion claims nothing beyond these rules.
//!
//! Environment: `LD01_OPERATING_HOT_SPINE_PACKET` (the composed packet),
//! `LD01_PZR_FROM_STATE` (the saved state), `LD01_PZR_STATE_OUT`, `LD01_S3_WATER`.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::network::stratified::ROOF_PRESSURE;
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
#[ignore = "one conversion per tuple: LD01_PZR_FROM_STATE onto the composed packet with continuousControl"]
fn pzr_state_onto_the_continuous_packet() {
    // The water method the state was prepared on (lead, 1 Nov): LD01_S3_WATER,
    // unset SBTL, selected before any water call, as the other harnesses.
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "sbtl".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    let (packet_path, _) = common::packet_bytes();
    let sha256 = |path: &str| common::provenance::sha256_file(path).expect("sha256");
    let from_path = env("LD01_PZR_FROM_STATE");
    let out = env("LD01_PZR_STATE_OUT");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let from_bytes = std::fs::read(&from_path).expect("saved state");
    let from_sha256 = sha256(&from_path);
    let mut state: Value = serde_json::from_slice(&from_bytes).expect("state json");
    let mut s = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the composition");
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    let o = joined.offsets();
    let pzr = joined.pzr();
    let k = pzr
        .lag_coordinate()
        .expect("the packet composes the continuous master");
    let added: Vec<usize> = [Some(k), pzr.integral_coordinate(), pzr.stem_coordinate()]
        .into_iter()
        .flatten()
        .collect();
    let first = o.pzr + k;
    assert_eq!(first + added.len(), o.cvcs, "the master's coordinates are the PZR block's last");
    let lag_scale = pzr.layout().scales[k];
    let labels: Vec<String> = added.iter().map(|i| pzr.layout().labels[*i].clone()).collect();
    // A state's bits are its exact coordinates (KERN's settled states
    // carry them); a state without them (turb_gov's end states) carries
    // `y`/`yp` only, which the composition reads (`unit::s3`).
    let floats = |v: &Value| -> Vec<f64> {
        v.as_array()
            .expect("a state vector")
            .iter()
            .map(|x| x.as_f64().expect("a real"))
            .collect()
    };
    let with_bits = state.get("y_bits").is_some();
    let (old_y, old_yp) = if with_bits {
        (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]))
    } else {
        (floats(&state["y"]), floats(&state["yp"]))
    };
    assert_eq!(
        old_y.len() + added.len(),
        joined.dimension(),
        "the saved state is the composed packet's without the master's coordinates"
    );
    let roof = joined.network.pzr.coordinates().start + ROOF_PRESSURE;
    let roof_pa = old_y[roof] * joined.scales()[roof];
    let n = added.len();
    let mut values = vec![0.; n];
    values[0] = roof_pa / lag_scale;
    let mut y = old_y[..first].to_vec();
    y.extend(&values);
    y.extend(&old_y[first..]);
    let mut yp = old_yp[..first].to_vec();
    yp.extend(vec![0.; n]);
    yp.extend(&old_yp[first..]);
    assert!(
        y[..first]
            .iter()
            .zip(&old_y[..first])
            .chain(y[first + n..].iter().zip(&old_y[first..]))
            .all(|(a, b)| a.to_bits() == b.to_bits()),
        "every existing coordinate keeps its bits"
    );
    let held = state["discrete_state"]["operator"]["pzr"].clone();
    assert!(held.get("heater_control").is_none(), "a held-form state");
    joined
        .restore_discrete_state(&state["discrete_state"]["operator"])
        .expect("the discrete state");
    assert!(
        joined.network.spray_discrete_state().is_none_or(|sp| sp.closed),
        "the saved state's spray path is closed"
    );
    state["y"] = json!(y);
    state["yp"] = json!(yp);
    if with_bits {
        state["y_bits"] = json!(bits(&y));
        state["yp_bits"] = json!(bits(&yp));
    }
    state["packet_sha256"] = json!(sha256(&packet_path));
    state["packet"] = json!(packet_path);
    state["converted_pzr"] = json!({"from": from_path, "from_sha256": from_sha256,
        "rule": "R4-PZR-PI: existing coordinates bitwise; the master's coordinates inserted as the PZR block's last (before the CVCS): the PT1 channel lag at the state's roof pressure, the integral 0 (commissioning carries the held demand into it exactly), the spray stem 0 locked; rates zero; the PZR owner's discrete state kept in its held form",
        "inserted": {"first_index": first, "labels": labels, "lag_pa": roof_pa},
        "held_form": held});
    std::fs::write(&out, serde_json::to_vec(&state).expect("state json")).expect("write");
    println!(
        "{}",
        serde_json::to_string_pretty(&state["converted_pzr"]).expect("json")
    );
}

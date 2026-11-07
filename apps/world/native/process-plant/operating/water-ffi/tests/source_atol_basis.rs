//! R4-NUC-SOURCE-ATOL (lead 1 Nov): the `ld01-source-atol` block's basis
//! values from the declared hot-standby basis state, once. Every coordinate
//! of the declared classes (RegionalPopulation, Precursor) by its layout
//! label, physical (`y × scale`), with the state's name, sha256, case and
//! time after zero; the block's `budgetFraction` and `rule` are written as
//! the decision fixes them. The composition reads the block, never the
//! state.
//!
//! Environment: the spine's (`LD01_OPERATING_HOT_SPINE_PACKET`, ...),
//! `LD01_SOURCE_ATOL_STATE` (the basis state), `LD01_SOURCE_ATOL_CASE`,
//! `LD01_SOURCE_ATOL_AFTER_ZERO_S`, `LD01_S3_SINGLE` (the state's singles,
//! empty for the bank layout), `LD01_SOURCE_ATOL_OUT` (never overwritten).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_water::unit::{source_atol, spine::started_full_composition_with_singles};
use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}

#[test]
#[ignore = "once per basis: LD01_SOURCE_ATOL_STATE to LD01_SOURCE_ATOL_OUT"]
fn write_the_source_atol_basis() {
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "sbtl".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    let (packet_path, packet_bytes) = common::packet_bytes();
    let packet: Value = serde_json::from_slice(&packet_bytes).expect("packet json");
    let state_path = env("LD01_SOURCE_ATOL_STATE");
    let out = env("LD01_SOURCE_ATOL_OUT");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).expect("state"))
        .expect("state json");
    assert_eq!(state["packet"].as_str(), Some(packet_path.as_str()), "the state is of the spine's packet");
    let ids: Vec<&str> = packet["rods"]["clusters"]
        .as_array()
        .expect("clusters")
        .iter()
        .map(|c| c["id"].as_str().expect("id"))
        .collect();
    let singles: Vec<usize> = std::env::var("LD01_S3_SINGLE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.split(',')
                .map(|id| ids.iter().position(|c| *c == id.trim()).unwrap_or_else(|| panic!("{id}")))
                .collect()
        })
        .unwrap_or_default();
    let started = started_full_composition_with_singles(&common::spine(), &singles)
        .expect("the composition of the state's layout");
    let y: Vec<f64> = state["y_bits"]
        .as_array()
        .expect("y_bits")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect();
    assert_eq!(y.len(), started.joined.dimension(), "the state is of the composition's layout");
    let classes = ["RegionalPopulation", "Precursor"];
    let values = source_atol::basis_values(&started.joined, &y, &classes);
    for (label, v) in values.as_object().expect("values") {
        let v = v.as_f64().expect("number");
        assert!(v.is_finite() && v > 0., "{label}: basis value {v} is not positive");
    }
    let block = json!({
        "rule": "R4-NUC-SOURCE-ATOL", "budgetFraction": 0.25, "classes": classes,
        "basis": {"state": state_path.rsplit('/').next().expect("name"),
            "sha256": common::provenance::sha256_file(&state_path).expect("sha256"),
            "case": env("LD01_SOURCE_ATOL_CASE"),
            "afterZero_s": env("LD01_SOURCE_ATOL_AFTER_ZERO_S").parse::<f64>().expect("after zero")},
        "values": values,
    });
    std::fs::write(&out, serde_json::to_vec(&block).unwrap()).unwrap();
    eprintln!("ld01-source-atol basis: {} values written to {out}", block["values"].as_object().unwrap().len());
}

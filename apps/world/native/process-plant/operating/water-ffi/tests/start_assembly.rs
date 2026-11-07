//! R4-START-ASSEMBLY (lane RESTART) zero-time check: at a saved state
//! (`LD01_S3_STATE`) the consistent start's limited assemblies give exactly
//! the full assembly's bits where the start reads them: a projection's
//! algebraic columns, and the whole matrix on the start's standing evaluation.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::joined::blocks::{
    Classes, JoinedJacobian, jacobian_blocks, jacobian_blocks_start,
};
use leitbild_operating_plant::network::heaters::hold_endpoints;
use serde_json::Value;

fn from_bits(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("bits array")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect()
}

#[test]
#[ignore = "R4-START-ASSEMBLY zero-time check: requires the joined CVCS packet, a saved state (LD01_S3_STATE), the wiki, the water tables and stock IDA/KLU"]
fn a_start_assembly_fills_what_the_full_assembly_fills() {
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "sbtl".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    let state: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE")).expect("state"),
    )
    .expect("state json");
    let mut s = leitbild_operating_water::unit::spine::started_full_composition_with_singles(
        &common::spine(),
        &[],
    )
    .expect("the S2 composition");
    let network_ids = s.network_ids.clone();
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    if !state["discrete_state"].is_null() {
        joined
            .restore_discrete_state(&state["discrete_state"]["operator"])
            .expect("discrete state");
    }
    let y = from_bits(&state["y_bits"]);
    let t0 = state["t_s"].as_f64().expect("t_s");
    let zero = vec![0.; y.len()];
    let algebraic: Vec<bool> = joined
        .differential(&network_ids)
        .iter()
        .map(|d| *d == 0.)
        .collect();
    let structure = JoinedJacobian::compile_for(joined, t0, &y, None).expect("structure");
    let nnz = structure.pattern.nonzeros();
    let (mut full, mut limited) = (vec![0.; nnz], vec![0.; nnz]);
    jacobian_blocks(
        joined,
        &structure,
        t0,
        0.,
        &y,
        &zero,
        &mut full,
        Classes::ALL,
    )
    .expect("full assembly");
    assert!(full.iter().any(|v| *v != 0.));
    for columns in [Some(algebraic.as_slice()), None] {
        joined
            .evaluate(t0, &y, &zero, None, 0., None)
            .expect("the start's evaluation");
        let reuse = joined.network.reuse();
        hold_endpoints(true);
        let result = jacobian_blocks_start(
            joined,
            &structure,
            t0,
            0.,
            &y,
            &zero,
            &mut limited,
            Some(reuse),
            columns,
        );
        hold_endpoints(false);
        result.expect("start assembly");
        let pointers = structure.pattern.pointers();
        for j in 0..y.len() {
            for p in pointers[j]..pointers[j + 1] {
                let want = if columns.is_none_or(|c| c[j]) {
                    full[p]
                } else {
                    0.
                };
                assert_eq!(limited[p].to_bits(), want.to_bits(), "column {j}, entry {p}");
            }
        }
    }
}

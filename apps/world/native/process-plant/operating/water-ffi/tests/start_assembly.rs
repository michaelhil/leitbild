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
    // R4-CLIMB-SEAT's limited assembly: the rods' columns.
    let o = joined.offsets();
    let rods: Vec<bool> = (0..y.len()).map(|j| (o.rods..o.pzr).contains(&j)).collect();
    for columns in [Some(algebraic.as_slice()), Some(rods.as_slice()), None] {
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
                assert_eq!(
                    limited[p].to_bits(),
                    want.to_bits(),
                    "column {j}, entry {p}"
                );
            }
        }
    }
}

/// R4-START-RATE-ONCE's premise: the operator's evaluation keeps no state
/// between calls. At a saved state the directional evaluation at `(t, y, 0)`
/// along the state's own `y'` gives the same bits (every row's value and
/// direction) after a value evaluation at `(y, y')`, after itself and after
/// an evaluation at another state; so does the value evaluation at `(y, y')`.
#[test]
#[ignore = "R4-START-RATE-ONCE zero-time check: requires the joined CVCS packet, a saved state (LD01_S3_STATE), the wiki, the water tables and stock IDA/KLU"]
fn an_evaluation_keeps_no_state_between_calls() {
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
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    if !state["discrete_state"].is_null() {
        joined
            .restore_discrete_state(&state["discrete_state"]["operator"])
            .expect("discrete state");
    }
    let y = from_bits(&state["y_bits"]);
    let yp = from_bits(&state["yp_bits"]);
    let t0 = state["t_s"].as_f64().expect("t_s");
    let zero = vec![0.; y.len()];
    assert!(yp.iter().any(|v| *v != 0.), "the state's own rates");
    let bits = |rows: &[leitbild_operating_plant::thermal::Scalar]| -> Vec<(u64, u64)> {
        rows.iter()
            .map(|r| (r.value.to_bits(), r.direction.to_bits()))
            .collect()
    };
    let value = joined
        .evaluate(t0, &y, &yp, None, 0., None)
        .map(|()| bits(joined.rows()))
        .expect("value evaluation");
    let directional = joined
        .evaluate(t0, &y, &zero, Some(&yp), 0., None)
        .map(|()| bits(joined.rows()))
        .expect("directional evaluation");
    let again = joined
        .evaluate(t0, &y, &zero, Some(&yp), 0., None)
        .map(|()| bits(joined.rows()))
        .expect("the same directional evaluation");
    assert_eq!(directional, again, "after itself");
    let other: Vec<f64> = y.iter().map(|v| v * (1. + 1e-9)).collect();
    joined
        .evaluate(t0, &other, &zero, None, 0., None)
        .expect("another state");
    let after_other = joined
        .evaluate(t0, &y, &zero, Some(&yp), 0., None)
        .map(|()| bits(joined.rows()))
        .expect("directional after another state");
    assert_eq!(directional, after_other, "after another state");
    let value_again = joined
        .evaluate(t0, &y, &yp, None, 0., None)
        .map(|()| bits(joined.rows()))
        .expect("value evaluation again");
    assert_eq!(value, value_again, "the value evaluation");
}

/// The block patterns (presence as prepared and every read cell with vapor)
/// and the colored pattern, hashed: a law that reads new coordinates only
/// where rows already read them leaves all three, and so KLU's ordering,
/// unchanged. Compared between two builds of the same tuple.
#[test]
#[ignore = "zero-time check: requires the joined CVCS packet, the wiki, the water tables and stock IDA/KLU; prints the pattern hashes"]
fn pattern_hash() {
    use leitbild_operating_plant::{
        digest::sha256, joined::presence::VaporPresence, sparse::Pattern,
    };
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "sbtl".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    let mut s = leitbild_operating_water::unit::spine::started_full_composition_with_singles(
        &common::spine(),
        &[],
    )
    .expect("the S2 composition");
    let joined = &mut s.joined;
    let hash = |p: &Pattern| {
        let bytes: Vec<u8> = p
            .pointers()
            .iter()
            .chain(p.indices())
            .flat_map(|v| (*v as u64).to_le_bytes())
            .collect();
        (p.nonzeros(), sha256(&bytes))
    };
    let (t, y) = (0., s.y.clone());
    let prepared = JoinedJacobian::compile_for(joined, t, &y, None).expect("structure");
    let all = VaporPresence {
        cells: vec![true; joined.network.pzr.cell],
    };
    let widest = JoinedJacobian::compile_for(joined, t, &y, Some(&all)).expect("structure");
    let (colored, _) = joined.structure().expect("colored structure");
    println!("PATTERN prepared {:?}", hash(&prepared.pattern));
    println!("PATTERN widest {:?}", hash(&widest.pattern));
    println!("PATTERN colored {:?}", hash(colored));
}

//! R4-DUMP (plan r4, lane DUMP) zero-time check of the post-trip Tavg mode's
//! exact partials: at a saved state (`LD01_S3_STATE`) the reactor trip arms
//! the mode (the dump then opens on the at-power Tavg), and
//! - the block Jacobian (the solver's assembly) equals the colored joined
//!   Jacobian (the seeded evaluation) entry by entry, and
//! - the CVCS loop-average column's secondary entries equal a central
//!   difference of the residual.
//!
//! NOT evidence by itself: a check, with its record written to a new path
//! (`LD01_DUMP_JAC_RECEIPT`).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::joined::{
    block::Command,
    blocks::{Classes, JoinedJacobian, jacobian_blocks},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn from_bits(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("bits array")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect()
}

fn entries(pointers: &[usize], indices: &[usize], values: &[f64]) -> BTreeMap<(usize, usize), f64> {
    let mut m = BTreeMap::new();
    for c in 0..pointers.len() - 1 {
        for k in pointers[c]..pointers[c + 1] {
            m.insert((indices[k], c), values[k]);
        }
    }
    m
}

#[test]
#[ignore = "R4-DUMP zero-time check: requires the joined CVCS packet, a saved state (LD01_S3_STATE), the wiki, IF97 and stock IDA/KLU; writes LD01_DUMP_JAC_RECEIPT"]
fn tavg_mode_partials_at_the_reactor_trip() {
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let out = std::env::var("LD01_DUMP_JAC_RECEIPT").expect("LD01_DUMP_JAC_RECEIPT");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let (packet_path, _) = common::packet_bytes();
    assert_eq!(state["packet"].as_str(), Some(packet_path.as_str()), "packet");
    let mut s =
        leitbild_operating_water::unit::spine::started_full_composition_with_singles(&common::spine(), &[])
            .expect("the S2 composition");
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    if !state["discrete_state"].is_null() {
        joined
            .restore_discrete_state(&state["discrete_state"]["operator"])
            .expect("discrete state");
    }
    let (mut y, yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    let t0 = state["t_s"].as_f64().expect("t_s");
    assert_eq!(y.len(), joined.dimension(), "state layout");
    // The reactor trip arms the Tavg mode at the state.
    let receipts = joined
        .command(t0, &mut y, Command::HoldingLoss)
        .expect("the reactor trip");
    let secondary = joined.secondary().expect("the SG owner");
    assert_eq!(secondary.reactor_trip_time(), Some(t0), "armed");
    let o = joined.offsets();
    let tavg = o.cvcs + leitbild_operating_plant::joined::cvcs::TAVG;
    let reads: Vec<usize> = secondary
        .loop_average_rows()
        .iter()
        .map(|r| o.secondary + r)
        .collect();
    assert!(!reads.is_empty(), "the Tavg mode's rows");
    // The block assembly against the colored Jacobian.
    let cj = 1e3;
    let structure = JoinedJacobian::compile_for(joined, t0, &y, None).expect("structure");
    let mut block = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(joined, &structure, t0, cj, &y, &yp, &mut block, Classes::ALL)
        .expect("block Jacobian");
    let block = entries(structure.pattern.pointers(), structure.pattern.indices(), &block);
    let (pointers, indices) = {
        let (p, _) = joined.structure().expect("colored structure");
        (p.pointers().to_vec(), p.indices().to_vec())
    };
    let mut colored = vec![0.; indices.len()];
    joined
        .jacobian(t0, cj, &y, &yp, &mut colored)
        .expect("colored Jacobian");
    let colored = entries(&pointers, &indices, &colored);
    let mut worst = (0_f64, None);
    let mut tavg_entries = Vec::new();
    for key in block.keys().chain(colored.keys()) {
        let (b, c) = (
            block.get(key).copied().unwrap_or(0.),
            colored.get(key).copied().unwrap_or(0.),
        );
        let scale = b.abs().max(c.abs());
        if scale == 0. {
            continue;
        }
        let rel = (b - c).abs() / scale;
        if rel > worst.0 {
            worst = (rel, Some(*key));
        }
        if key.1 == tavg && reads.contains(&key.0) {
            tavg_entries.push((key.0, b, c));
        }
    }
    tavg_entries.dedup_by_key(|e| e.0);
    // Central differences of the residual in the loop-average coordinate.
    let base = y[tavg];
    let h = 1e-6 * base.abs().max(1.);
    let mut rows_at = |v: f64| -> Vec<f64> {
        y[tavg] = v;
        joined.evaluate(t0, &y, &yp, None, 0., None).expect("evaluate");
        joined.rows().iter().map(|r| r.value).collect()
    };
    let (up, down) = (rows_at(base + h), rows_at(base - h));
    y[tavg] = base;
    let mut fd_worst = 0_f64;
    let mut fd = Vec::new();
    for (r, b, _) in &tavg_entries {
        let d = (up[*r] - down[*r]) / (2. * h);
        let rel = (b - d).abs() / b.abs().max(d.abs()).max(1e-300);
        fd_worst = fd_worst.max(rel);
        fd.push(json!({"row": r, "block": b, "central_difference": d, "relative": rel}));
    }
    let record = json!({
        "kind": "R4-DUMP zero-time Jacobian check",
        "status": "NOT-EVIDENCE check",
        "state": state_path,
        "packet": packet_path,
        "t_s": t0,
        "arming": receipts.iter().map(|r| r.receipt.clone()).collect::<Vec<_>>(),
        "loop_average_column": tavg,
        "block_vs_colored_worst_relative": worst.0,
        "block_vs_colored_worst_entry": worst.1,
        "tavg_column_secondary_entries": tavg_entries.len(),
        "fd_worst_relative": fd_worst,
        "fd": fd,
    });
    std::fs::write(&out, serde_json::to_vec_pretty(&record).unwrap()).expect("record");
    assert!(!tavg_entries.is_empty(), "the loop-average column reaches the secondary rows");
    assert!(tavg_entries.iter().any(|e| e.1 != 0.), "the open dump's partials");
    assert!(worst.0 < 1e-6, "block against colored: {worst:?}");
    assert!(fd_worst < 1e-5, "central differences: {fd_worst}");
}

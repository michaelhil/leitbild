//! R4-NUC-CRITICAL-BORON (plan r4, lead 1 Nov): the measurement of the
//! critical boron search. A settled full-power state of the joined packet,
//! its loop Tavg against Tref's full-power end, both by the X4.4 Tavg
//! channel's own measurand ([`rod_control::Probe::tavg_k`]: HOT.A.UPSTREAM /
//! HOT.B and COLD.A / COLD.B bulk liquid, the loop mean of hot and cold, the
//! mean of the two loops, no lag and no quantum):
//! - `tref_full_power_k`: at the packet's prepared hot reference, the value
//!   AUTO commissions as `T_fp`;
//! - `settled_tavg_k`: at the settled state (the S3 settle's
//!   `s3-settled-state.json`, C1's initial condition).
//!
//! The search step and its acceptance are the preparation's
//! (`apps/world/scripts/reference-design-critical-boron.ts`); this test only
//! measures. One measurement per settled state (ignored).
//!
//! Environment: the spine's (`LD01_OPERATING_HOT_SPINE_PACKET`, ...),
//! `LD01_BORON_STATE` (the settled state of that packet) and
//! `LD01_BORON_OUT` (never overwritten).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_water::unit::{rod_control::Probe, spine::started_full_composition};
use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}

#[test]
#[ignore = "one measurement per settled state: LD01_BORON_STATE to LD01_BORON_OUT"]
fn measure_the_settled_loop_tavg_against_tref() {
    let (packet_path, packet_bytes) = common::packet_bytes();
    let state_path = env("LD01_BORON_STATE");
    let out = env("LD01_BORON_OUT");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let packet: Value = serde_json::from_slice(&packet_bytes).expect("packet json");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("the settled state"))
            .expect("state json");
    assert_eq!(
        state["packet"].as_str(),
        Some(packet_path.as_str()),
        "the state is of the spine's packet"
    );
    let y: Vec<f64> = state["y_bits"]
        .as_array()
        .expect("y_bits")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect();
    let started = started_full_composition(&common::spine()).expect("the joined composition");
    assert_eq!(
        y.len(),
        started.joined.dimension(),
        "the state is of the joined layout"
    );
    let ids: Vec<String> = packet["mechanics"]["regions"]
        .as_array()
        .expect("the packet's regions")
        .iter()
        .map(|r| r["id"].as_str().expect("a region id").to_string())
        .collect();
    let probe = Probe::new(&started.joined, &ids, &started.y).unwrap_or_else(|e| panic!("{e}"));
    let tref = probe.tavg_k(&started.y).unwrap_or_else(|e| panic!("{e}"));
    let tavg = probe.tavg_k(&y).unwrap_or_else(|e| panic!("{e}"));
    let record = json!({
        "rule": "R4-NUC-CRITICAL-BORON measurement: the X4.4 Tavg channel's measurand (rod_control::Probe::tavg_k, no lag or quantum) at the packet's prepared hot reference (Tref's full-power end) and at the settled state",
        "packet": packet_path,
        "packet_sha256": common::provenance::sha256_file(&packet_path).expect("sha256"),
        "state": state_path,
        "state_sha256": common::provenance::sha256_file(&state_path).expect("sha256"),
        "state_t_s": state["t_s"],
        "feedback_reference_boron_ppm_eq": packet["feedback_metadata"]["regions"][0]["reference_boron_ppm_eq"],
        "tref_full_power_k": tref,
        "settled_tavg_k": tavg,
        "error_k": tavg - tref,
        "nuclear_fraction": probe.nuclear(&y),
        "travel_m": probe.travel_m(&y),
    });
    std::fs::write(&out, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    eprintln!(
        "critical boron measurement: Tavg {tavg} K, Tref {tref} K, error {} K",
        tavg - tref
    );
}

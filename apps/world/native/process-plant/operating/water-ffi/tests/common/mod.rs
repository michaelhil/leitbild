//! The test crates' shared support, declared once (`mod common;` in a test
//! crate): measurement clocks, stock counters, the declared filter, the
//! observation helpers and receipt provenance, and the environment's inputs
//! of the unit library (`leitbild_operating_water::unit`). The composition,
//! its solver profile and the frame-driven unit live in the library; nothing
//! here composes or integrates.
#![allow(dead_code)] // Each test crate uses its own subset.
#[cfg(feature = "ida")]
pub mod counts;
pub mod cpu;
#[cfg(feature = "ida")]
pub mod feed_control;
pub mod filter;
#[cfg(feature = "ida")]
pub mod observe;
pub mod provenance;

// The unit library's inputs from the environment (the joined spine's
// packet and wiki, the S3 sections), refused loudly when one is missing.
#[cfg(feature = "ida")]
use leitbild_operating_water::unit::inputs::{Inputs, Spine};
#[cfg(feature = "ida")]
use serde_json::Value;

/// `LD01_OPERATING_HOT_SPINE_PACKET` and `LD01_WIKI_ROOT` (with
/// `LD01_WIKI_COMMIT` and `LD01_WIKI_REPOSITORY` for provenance).
#[cfg(feature = "ida")]
pub fn spine() -> Spine {
    Spine::from_env().unwrap_or_else(|e| panic!("the joined spine's inputs: {e}"))
}
/// The S3 composition's inputs: the spine and `LD01_IC_SECTION`,
/// `LD01_PZR_CONTROL_SECTION`, `LD01_PZR_CONTROL_WIKI`, `ELEC_PACKET`.
#[cfg(feature = "ida")]
pub fn inputs() -> Inputs {
    Inputs::from_env().unwrap_or_else(|e| panic!("the S3 composition's inputs: {e}"))
}
/// The packet's path and bytes.
#[cfg(feature = "ida")]
pub fn packet_bytes() -> (String, Vec<u8>) {
    let s = spine();
    (s.packet_path, s.packet)
}
/// A receipt's app and wiki provenance.
#[cfg(feature = "ida")]
pub fn spine_provenance() -> Value {
    leitbild_operating_water::unit::provenance::receipt(&spine())
        .unwrap_or_else(|e| panic!("provenance: {e}"))
}
/// `ld01-s1-gates` of the spine's wiki.
#[cfg(feature = "ida")]
pub fn s1_gates() -> Value {
    spine()
        .s1_gates()
        .unwrap_or_else(|e| panic!("ld01-s1-gates: {e}"))
}

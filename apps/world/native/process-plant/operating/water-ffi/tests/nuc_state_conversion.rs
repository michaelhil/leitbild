//! E-NUC (plan r4): convert a saved state of the packet layout (the
//! nuclear block's 386 carriers x [6 precursors, 6 materials, 25 histories]
//! and the solids' every half, helium and passive store) to the replica
//! layout. Every other coordinate keeps its solver value; each replica
//! coordinate takes its members' common solver value (a nuclear group stock
//! is its members' sum on a scale its members' sum, a solid class's is one
//! member's, so the solver value is the members' either way). A state whose
//! members differ in any bit is refused by `Nuclear::reduce_carrier_state`
//! and `Solids::reduce_packet_state`: nothing is averaged.
//! A state's appended and discrete parts are kept unchanged; only `y`, `yp`
//! and their bits are replaced.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::joined::nuclear::HISTORIES;
use serde_json::{Value, json};

const CARRIER_WIDTH: usize = 6 + 6 + HISTORIES;

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
#[ignore = "state conversion: converts LD01_NUC_FROM_STATE to LD01_NUC_TO_STATE"]
fn convert_a_saved_state_to_the_replica_layout() {
    let from = std::env::var("LD01_NUC_FROM_STATE").expect("LD01_NUC_FROM_STATE");
    let to = std::env::var("LD01_NUC_TO_STATE").expect("LD01_NUC_TO_STATE");
    assert!(!std::path::Path::new(&to).exists(), "never overwritten");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&from).unwrap()).unwrap();
    let started = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the S2 composition");
    let joined = &started.joined;
    let o = joined.offsets();
    let nuclear = joined.nuclear();
    let solids = joined.solids();
    let full = nuclear.regions() + CARRIER_WIDTH * nuclear.carriers();
    let raw: Value = serde_json::from_slice(&common::packet_bytes().1).unwrap();
    let t = &raw["thermal"];
    let count = |k: &str| t[k].as_array().unwrap().len();
    let full_solids = 6 * count("fuel_bands")
        + count("helium")
        + count("passive_stores")
        + count("sg_segments");
    let reduced = (o.solids - o.nuclear) + (o.secondary - o.solids);
    let convert = |old: &[f64]| -> Vec<f64> {
        assert_eq!(
            old.len() + reduced,
            joined.dimension() + full + full_solids,
            "layouts"
        );
        let mut y = old[..o.nuclear].to_vec();
        y.extend(
            nuclear
                .reduce_carrier_state(&old[o.nuclear..o.nuclear + full])
                .unwrap_or_else(|e| panic!("{e}")),
        );
        let s0 = o.nuclear + full;
        y.extend(
            solids
                .reduce_packet_state(&old[s0..s0 + full_solids])
                .unwrap_or_else(|e| panic!("{e}")),
        );
        y.extend_from_slice(&old[s0 + full_solids..]);
        assert_eq!(y.len(), joined.dimension());
        y
    };
    let y = convert(&from_bits(&state["y_bits"]));
    let yp = convert(&from_bits(&state["yp_bits"]));
    state["y"] = json!(y);
    state["yp"] = json!(yp);
    state["y_bits"] = json!(bits(&y));
    state["yp_bits"] = json!(bits(&yp));
    state["converted"] = json!({
        "from": from,
        "rule": "E-NUC replica groups and classes: each coordinate takes its members' common solver value; members identical in every bit, else refused",
        "groups": nuclear.replica_groups(),
        "carriers": nuclear.carriers(),
        "solid_halves": solids.halves(),
        "coordinates": [full + full_solids + joined.dimension() - reduced, joined.dimension()],
    });
    std::fs::write(&to, serde_json::to_vec(&state).unwrap()).unwrap();
}

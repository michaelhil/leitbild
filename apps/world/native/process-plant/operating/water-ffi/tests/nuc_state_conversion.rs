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
#[path = "joined_spine.rs"]
mod spine;

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
    let started = spine::started_full_composition();
    let joined = &started.joined;
    let o = joined.offsets();
    let nuclear = joined.nuclear();
    let solids = joined.solids();
    let full = nuclear.regions() + CARRIER_WIDTH * nuclear.carriers();
    let raw: Value = serde_json::from_slice(&spine::packet_bytes().1).unwrap();
    let t = &raw["thermal"];
    let count = |k: &str| t[k].as_array().unwrap().len();
    let full_solids = 6 * count("fuel_bands")
        + count("helium")
        + count("passive_stores")
        + count("sg_segments");
    // The rods: 52 x [y, v, m_lo, m_up] then the bore groups' [M, U, B, p]
    // in the packet layout; one motion class per bore group here.
    let rods = joined.rods().expect("rod owner");
    let rods_len = o.pzr - o.rods;
    let full_rods = 4 * rods.clusters() + rods_len / 2;
    let reduced = (o.solids - o.nuclear) + (o.secondary - o.solids) + rods_len;
    let current_spread = std::cell::Cell::new(0f64);
    let convert = |old: &[f64]| -> Vec<f64> {
        assert_eq!(
            old.len() + reduced,
            joined.dimension() + full + full_solids + full_rods,
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
        let r0 = s0 + full_solids + (o.rods - o.secondary);
        y.extend_from_slice(&old[s0 + full_solids..r0]);
        let (r, spread) = rods
            .reduce_packet_state(&old[r0..r0 + full_rods])
            .unwrap_or_else(|e| panic!("{e}"));
        current_spread.set(current_spread.get().max(spread));
        y.extend(r);
        y.extend_from_slice(&old[r0 + full_rods..]);
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
        "rod_motion_classes": rods_len / 8,
        "mouth_current_spread_taken_from_first_member": current_spread.get(),
        "mouth_current_rule": "the mouth currents are algebraic: the composition's exact consistent start solves them from the travels and the bores' water; each class takes its first member's value and the largest relative member spread (y and y') is recorded",
        "coordinates": [full + full_solids + full_rods + joined.dimension() - reduced, joined.dimension()],
    });
    std::fs::write(&to, serde_json::to_vec(&state).unwrap()).unwrap();
}

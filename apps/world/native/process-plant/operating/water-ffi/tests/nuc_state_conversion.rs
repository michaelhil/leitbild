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
    let state_in = state.clone();
    // The same declared singles as the saved state's composition.
    let singles: Vec<usize> = std::env::var("LD01_NUC_SINGLES").map_or_else(
        |_| Vec::new(),
        |v| {
            v.split(',')
                .map(|c| c.trim().parse().expect("LD01_NUC_SINGLES: cluster indices"))
                .collect()
        },
    );
    let started = leitbild_operating_water::unit::spine::started_full_composition_with_singles(
        &common::spine(),
        &singles,
    )
    .expect("the S2 composition");
    let joined = &started.joined;
    let o = joined.offsets();
    let nuclear = joined.nuclear();
    let solids = joined.solids();
    let full = nuclear.regions() + CARRIER_WIDTH * nuclear.carriers();
    let raw: Value = serde_json::from_slice(&common::packet_bytes().1).unwrap();
    let t = &raw["thermal"];
    let count = |k: &str| t[k].as_array().unwrap().len();
    let full_solids =
        6 * count("fuel_bands") + count("helium") + count("passive_stores") + count("sg_segments");
    // The rods: 52 x [y, v, m_lo, m_up] then the bore groups' [M, U, B, p]
    // in the packet layout (EVT-RODS-BANK: one bank class here).
    let rods = joined.rods().expect("rod owner");
    let rods_len = o.pzr - o.rods;
    let full_rods = rods.packet_coordinates();
    // Each block's saved slice is either its packet layout or already this
    // layout (a state an earlier conversion reduced); the one combination
    // whose lengths add up to the saved state's is taken.
    let (red_n, red_s) = (o.solids - o.nuclear, o.secondary - o.solids);
    let sizes = |old: usize| -> (bool, bool, bool) {
        let mut found = Vec::new();
        for (fnuc, fsol, frod) in [
            (true, true, true),
            (false, false, true),
            (false, false, false),
            (true, true, false),
        ] {
            let n = joined.dimension() - red_n - red_s - rods_len
                + if fnuc { full } else { red_n }
                + if fsol { full_solids } else { red_s }
                + if frod { full_rods } else { rods_len };
            if n == old {
                found.push((fnuc, fsol, frod));
            }
        }
        assert_eq!(
            found.len(),
            1,
            "a saved state of {old} coordinates matches no single layout"
        );
        found[0]
    };
    // The rods' spreads of what a class took from its first member or
    // merged, [mouth currents, bores' water], for y and for y'.
    let spreads = std::cell::Cell::new([[0f64; 2]; 2]);
    let convert = |old: &[f64], rates: bool| -> Vec<f64> {
        let (fnuc, fsol, frod) = sizes(old.len());
        let mut y = old[..o.nuclear].to_vec();
        let mut at = o.nuclear;
        if fnuc {
            y.extend(
                nuclear
                    .reduce_carrier_state(&old[at..at + full])
                    .unwrap_or_else(|e| panic!("{e}")),
            );
            at += full;
        } else {
            y.extend_from_slice(&old[at..at + red_n]);
            at += red_n;
        }
        if fsol {
            y.extend(
                solids
                    .reduce_packet_state(&old[at..at + full_solids])
                    .unwrap_or_else(|e| panic!("{e}")),
            );
            at += full_solids;
        } else {
            y.extend_from_slice(&old[at..at + red_s]);
            at += red_s;
        }
        y.extend_from_slice(&old[at..at + (o.rods - o.secondary)]);
        at += o.rods - o.secondary;
        if frod {
            let slice = &old[at..at + full_rods];
            let (r, spread) = if rates {
                rods.reduce_packet_rates(slice)
            } else {
                rods.reduce_packet_state(slice)
            }
            .unwrap_or_else(|e| panic!("{e}"));
            let mut all = spreads.get();
            let slot = usize::from(rates);
            all[slot] = [all[slot][0].max(spread[0]), all[slot][1].max(spread[1])];
            spreads.set(all);
            y.extend(r);
            at += full_rods;
        } else {
            y.extend_from_slice(&old[at..at + rods_len]);
            at += rods_len;
        }
        y.extend_from_slice(&old[at..]);
        assert_eq!(y.len(), joined.dimension());
        y
    };
    let y = convert(&from_bits(&state["y_bits"]), false);
    let yp = convert(&from_bits(&state["yp_bits"]), true);
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
        "singles": singles,
        "rod_motion_classes": rods_len / 8,
        "rods_spreads": {
            "mouth_currents": {"y": spreads.get()[0][0], "yp": spreads.get()[1][0]},
            "bores_water": {"y": spreads.get()[0][1], "yp": spreads.get()[1][1]},
        },
        "rods_rule": "travel and velocity bitwise equal or refused; the mouth currents (algebraic, re-solved by the exact start) take the class's first member's value; the bores' water stocks merge member-weighted within 64 eps in y (else refused) and freely in y' (its pressure, algebraic, the first group's); each largest relative spread is recorded",
        "coordinates": [from_bits(&state_in["y_bits"]).len(), joined.dimension()],
    });
    std::fs::write(&to, serde_json::to_vec(&state).unwrap()).unwrap();
}

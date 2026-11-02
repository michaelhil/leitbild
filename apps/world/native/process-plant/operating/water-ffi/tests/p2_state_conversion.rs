//! P2 (OU-C): convert a saved state of the pre-P2 rod layout (52 x [y, v, m]) to the P2 layout (52 x [y, v, m_lo,
//! m_up] + 8 bore groups x [M, U, B, p]). Every other coordinate keeps its
//! solver value: the carved cells' stocks and scales scale together, so the
//! swept cells keep their state. Rods: travel and speed kept; both mouth
//! currents start at the old passage current (at rest the annulus carries
//! it); the bores hold LOWER's water at the pressure closing the lower mouth
//! (RodBlock::bore_stocks_at). The S3 composition's exact consistent start
//! at the state's time does the rest. A state with appended or discrete
//! parts keeps them unchanged; only `y`, `yp` and their bits are replaced.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::{
    network::{Properties, packet::Packet},
    rods::{
        BORE_BORON, BORE_ENERGY, BORE_MASS, BORE_PRESSURE, LowerField, RodBlock,
        Section as RodSection,
    },
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

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
#[ignore = "state conversion: converts LD01_P2_FROM_STATE to LD01_P2_TO_STATE"]
fn convert_a_saved_state_to_the_p2_layout() {
    let from = std::env::var("LD01_P2_FROM_STATE").expect("LD01_P2_FROM_STATE");
    let to = std::env::var("LD01_P2_TO_STATE").expect("LD01_P2_TO_STATE");
    assert!(!std::path::Path::new(&to).exists(), "never overwritten");
    let state: Value = serde_json::from_slice(&std::fs::read(&from).unwrap()).unwrap();
    let started = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the S2 composition");
    let joined = &started.joined;
    let o = joined.offsets();
    let n = joined.dimension();
    let scales = joined.scales().to_vec();
    let (old_y, old_yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    let clusters = 52;
    let (old_rods, new_rods) = (3 * clusters, o.pzr - o.rods);
    assert_eq!(old_y.len() + new_rods - old_rods, n, "layouts");
    // The rod block of the same carved packet, for its conversion helper.
    let (_, bytes) = common::packet_bytes();
    let mut packet: Packet = serde_json::from_slice(&bytes).unwrap();
    let raw: Value = serde_json::from_slice(&bytes).unwrap();
    let section: RodSection = serde_json::from_value(raw["rods"].clone()).unwrap();
    let carved = leitbild_operating_plant::rods::carve(&section, &mut packet).unwrap();
    let block = RodBlock::from_packet(&section, &packet, &carved, &If97, &[]).unwrap();
    let mut y = vec![0.; n];
    let mut yp = vec![0.; n];
    y[..o.rods].copy_from_slice(&old_y[..o.rods]);
    yp[..o.rods].copy_from_slice(&old_yp[..o.rods]);
    let shift = new_rods - old_rods;
    y[o.pzr..].copy_from_slice(&old_y[o.pzr - shift..]);
    yp[o.pzr..].copy_from_slice(&old_yp[o.pzr - shift..]);
    let mut travel = vec![0.; clusters];
    let mut velocity = vec![0.; clusters];
    let mut current = vec![0.; clusters];
    for c in 0..clusters {
        let (old, new) = (o.rods + 3 * c, o.rods + 4 * c);
        y[new] = old_y[old];
        y[new + 1] = old_y[old + 1];
        yp[new] = old_yp[old];
        yp[new + 1] = old_yp[old + 1];
        // Same current scale in both layouts (LOWER's packet density).
        y[new + 2] = old_y[old + 2];
        y[new + 3] = old_y[old + 2];
        travel[c] = y[new] * scales[new];
        velocity[c] = y[new + 1] * scales[new + 1];
        current[c] = y[new + 2] * scales[new + 2];
    }
    // LOWER's liquid of the saved state, on the carved scales.
    let lower = block.plena()[0];
    let l = &joined.network.cell_layout[lower];
    let phys = |i: usize| y[i] * scales[i];
    let (p, m, u, b) = (
        phys(l.base),
        phys(l.mass[0]),
        phys(l.energy[0]),
        phys(l.boron),
    );
    let w = If97.values(&If97.caloric(false, p, u / m, false).unwrap());
    let field = LowerField {
        pressure_pa: p,
        density_kg_m3: w.density_kg_m3,
        viscosity_pa_s: w.viscosity_pa_s,
        internal_energy_j_kg: u / m,
        boron_concentration: b / m,
    };
    let stocks = block
        .bore_stocks_at(&If97, &field, &travel, &velocity, &current)
        .unwrap();
    for (g, s) in stocks.iter().enumerate() {
        for (k, v) in [BORE_MASS, BORE_ENERGY, BORE_BORON, BORE_PRESSURE]
            .iter()
            .zip(s)
        {
            let i = o.rods + block.group_index(g, *k);
            y[i] = v / scales[i];
        }
    }
    let mut out = state.clone();
    out["y"] = json!(y);
    out["yp"] = json!(yp);
    out["y_bits"] = json!(bits(&y));
    out["yp_bits"] = json!(bits(&yp));
    out["converted"] = json!({"by": "water-ffi/tests/p2_state_conversion.rs (OU-C P2): every coordinate's solver value kept, rods [y, v, m] -> [y, v, m, m] + bore groups by RodBlock::bore_stocks_at", "from": from,
        "from_dimension": old_y.len(), "dimension": n, "lower": {"pressure_pa": p, "density_kg_m3": w.density_kg_m3,
        "viscosity_pa_s": w.viscosity_pa_s, "internal_energy_j_kg": u / m, "boron": b / m},
        "bore_groups": block.bore_groups(), "bore_stocks": stocks, "currents_kg_s": current, "travel_m": travel});
    std::fs::write(&to, serde_json::to_vec(&out).unwrap()).unwrap();
    println!("converted {from} -> {to}: {} -> {n}", old_y.len());
}

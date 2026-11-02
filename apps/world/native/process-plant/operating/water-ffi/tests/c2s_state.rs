//! Stuck-cluster C2 (lead ruling (a), plan r4): a settled S3 state of the
//! bank composition (EVT-RODS-BANK: one motion class and one bore water for
//! every cluster) converted to the singles composition, in which the
//! clusters `LD01_C2S_SINGLES` (packet ids, comma-separated) are each their
//! own motion class and bore water ([`started_full_composition_with_singles`]).
//! One conversion per tuple (`convert_a_bank_state_to_the_singles_layout`,
//! ignored).
//!
//! The rule, by layout labels, nothing by position:
//! - every owner but the rods has the same labels and the same scales in
//!   both compositions (checked bitwise): each coordinate keeps its bits;
//! - the rods: the bank's class coordinates (travel, velocity and the two
//!   mouth currents, each one member's value standing for its class) are
//!   copied bitwise to every class of the singles layout; its members are
//!   replica-identical by construction, so the single takes them exactly;
//! - the bores' water (mass, energy, boron, pressure): a group's stock
//!   scale is its members' count times one member's, so the solver value of
//!   the bank's stock is every member's share; it is copied bitwise to each
//!   group of the singles layout, which splits the physical stock by member
//!   share. The extensive scales are checked to add up (the singles'
//!   groups' to the bank's, within 64 eps, the split's rounding) and the
//!   pressure's to be equal; each largest relative scale difference is
//!   recorded. Anything else refuses.
//!
//! The network, the solids and the nuclear block do not depend on the
//! singles (the solids keep every rod seat's deposit store single either
//! way), and the rods' discrete state is per cluster: both are kept. Only
//! `y`, `yp` and their bits are replaced, and `converted_singles` records
//! the rule. The composition's exact consistent start makes the start
//! consistent; the 60 s hold shows the converted state holds.
//!
//! Environment: the spine's (`LD01_OPERATING_HOT_SPINE_PACKET`, ...),
//! `LD01_C2S_FROM_STATE`, `LD01_C2S_STATE_OUT` (never overwritten),
//! `LD01_C2S_SINGLES` (e.g. `LD01.CR.004`).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_water::unit::spine::{
    started_full_composition, started_full_composition_with_singles,
};
use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}
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

/// A rods label: a class coordinate `q[ID xM]` or a bore-water coordinate
/// `Q_boreK[ID]`, as (quantity, whether a class coordinate).
fn rods_quantity(label: &str) -> Result<(String, bool), String> {
    if let Some((q, rest)) = label.split_once('[') {
        if let Some(q) = q.strip_suffix("_bore0").or_else(|| {
            q.rfind("_bore")
                .filter(|i| q[i + 5..].chars().all(|c| c.is_ascii_digit()) && q.len() > i + 5)
                .map(|i| &q[..i])
        }) {
            return Ok((q.to_string(), false));
        }
        if rest.contains('x') && rest.ends_with(']') {
            return Ok((q.to_string(), true));
        }
    }
    Err(format!("rods label {label}: neither a class nor a bore-water coordinate"))
}

#[test]
#[ignore = "one conversion per tuple: LD01_C2S_FROM_STATE (bank) to LD01_C2S_STATE_OUT (singles LD01_C2S_SINGLES)"]
fn convert_a_bank_state_to_the_singles_layout() {
    // The water method the state was prepared on (lead, 1 Nov): LD01_S3_WATER,
    // unset SBTL (the default since the combined re-pin; if97 names the
    // reference), selected before any water call, as the other harnesses.
    let water = leitbild_operating_water::WaterMethod::parse(
        &std::env::var("LD01_S3_WATER").unwrap_or_else(|_| "sbtl".into()),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    leitbild_operating_water::select_water_method(water).unwrap_or_else(|e| panic!("{e}"));
    let (packet_path, packet_bytes) = common::packet_bytes();
    let from_path = env("LD01_C2S_FROM_STATE");
    let out = env("LD01_C2S_STATE_OUT");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let packet: Value = serde_json::from_slice(&packet_bytes).expect("packet json");
    let ids: Vec<&str> = packet["rods"]["clusters"]
        .as_array()
        .expect("the packet's rod clusters")
        .iter()
        .map(|c| c["id"].as_str().expect("a cluster id"))
        .collect();
    let single_ids: Vec<String> = env("LD01_C2S_SINGLES")
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();
    let singles: Vec<usize> = single_ids
        .iter()
        .map(|id| {
            ids.iter()
                .position(|c| c == id)
                .unwrap_or_else(|| panic!("{id} is not a rod cluster of the packet"))
        })
        .collect();
    let mut state: Value =
        serde_json::from_slice(&std::fs::read(&from_path).expect("the saved state"))
            .expect("state json");
    assert_eq!(state["packet"].as_str(), Some(packet_path.as_str()), "the state is of the spine's packet");
    let from_sha256 = common::provenance::sha256_file(&from_path).expect("sha256");
    let bank = started_full_composition(&common::spine()).expect("the bank composition");
    let split = started_full_composition_with_singles(&common::spine(), &singles)
        .expect("the singles composition");
    let (lb, ls) = (bank.joined.layouts(), split.joined.layouts());
    assert_eq!(
        lb.iter().map(|(o, _)| *o).collect::<Vec<_>>(),
        ls.iter().map(|(o, _)| *o).collect::<Vec<_>>(),
        "the same owners in the same order"
    );
    let (old_y, old_yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    assert_eq!(old_y.len(), bank.joined.dimension(), "the saved state is of the bank layout");
    assert_eq!(old_yp.len(), old_y.len());
    let (mut y, mut yp) = (Vec::new(), Vec::new());
    let (mut at, mut kept) = (0usize, 0usize);
    let mut rods_map: Vec<Value> = Vec::new();
    let mut spreads = json!({});
    for ((owner, b), (_, s)) in lb.iter().zip(&ls) {
        if *owner != "rods" {
            assert_eq!(b.labels, s.labels, "{owner}: the same labels");
            assert_eq!(
                b.scales.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                s.scales.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                "{owner}: the same scales"
            );
            y.extend_from_slice(&old_y[at..at + b.labels.len()]);
            yp.extend_from_slice(&old_yp[at..at + b.labels.len()]);
            kept += b.labels.len();
            at += b.labels.len();
            continue;
        }
        // The bank: exactly one class and one bore water.
        let source: Vec<(String, bool)> = b
            .labels
            .iter()
            .map(|l| rods_quantity(l).unwrap_or_else(|e| panic!("{e}")))
            .collect();
        assert_eq!(
            source.iter().filter(|(_, c)| *c).count(),
            leitbild_operating_plant::rods::CLUSTER_COORDINATES,
            "the source state is of the bank composition (one motion class)"
        );
        assert_eq!(
            source.iter().filter(|(_, c)| !*c).count(),
            leitbild_operating_plant::rods::GROUP_COORDINATES,
            "the source state is of the bank composition (one bore water)"
        );
        let find = |q: &str, class: bool| {
            source
                .iter()
                .position(|(sq, sc)| sq == q && *sc == class)
                .unwrap_or_else(|| panic!("no bank coordinate {q}"))
        };
        let mut sums: std::collections::BTreeMap<String, f64> = Default::default();
        let mut largest_equal = 0f64;
        for (k, label) in s.labels.iter().enumerate() {
            let (q, class) = rods_quantity(label).unwrap_or_else(|e| panic!("{e}"));
            let j = find(&q, class);
            let (scale_b, scale_s) = (b.scales[j], s.scales[k]);
            let extensive = !class && q != "p";
            if extensive {
                *sums.entry(q.clone()).or_default() += scale_s;
            } else {
                // A class coordinate is one member's; the pressure is intensive.
                largest_equal = largest_equal.max((scale_s - scale_b).abs() / scale_b);
                assert!(
                    (scale_s - scale_b).abs() <= 64. * f64::EPSILON * scale_b,
                    "{label}: scale {scale_s} against the bank's {scale_b}"
                );
            }
            y.push(old_y[at + j]);
            yp.push(old_yp[at + j]);
            rods_map.push(json!({"to": label, "from": b.labels[j], "rule": if extensive { "member share (solver value copied; the scale is the members')" } else { "copied (one member's value / intensive)" },
                "scale_from": scale_b, "scale_to": scale_s, "multiplicity_from": b.multiplicity[j], "multiplicity_to": s.multiplicity[k]}));
        }
        let mut stock_spread = json!({});
        for (q, sum) in &sums {
            let j = find(q, false);
            let rel = (sum - b.scales[j]).abs() / b.scales[j];
            assert!(rel <= 64. * f64::EPSILON, "{q}: the singles' scales add to {sum}, the bank's is {}", b.scales[j]);
            stock_spread[q] = json!(rel);
        }
        spreads = json!({"bore_water_scales_sum_relative": stock_spread, "class_and_pressure_scales_relative": largest_equal});
        at += b.labels.len();
    }
    assert_eq!(at, old_y.len());
    assert_eq!(y.len(), split.joined.dimension());
    state["y"] = json!(y);
    state["yp"] = json!(yp);
    state["y_bits"] = json!(bits(&y));
    state["yp_bits"] = json!(bits(&yp));
    state["composition"] = json!(format!(
        "{} + singles {} (stuck-cluster C2, lead ruling (a))",
        state["composition"].as_str().unwrap_or("?"),
        single_ids.join(",")
    ));
    state["converted_singles"] = json!({
        "from": from_path, "from_sha256": from_sha256,
        "singles": singles.iter().zip(&single_ids).map(|(i, id)| json!({"index": i, "id": id})).collect::<Vec<_>>(),
        "rule": "by layout labels: every owner but the rods identical in labels and scales (bitwise), each coordinate's bits kept; the rods' class coordinates (travel, velocity, mouth currents: one member's value) copied bitwise to each singles class; the bores' water solver values copied to each singles group, splitting the physical stocks by member share (a group's stock scale is its members' count times one member's); the rods' discrete state is per cluster and kept",
        "kept_coordinates": kept,
        "rods": rods_map,
        "spreads": spreads,
        "coordinates": [old_y.len(), y.len()],
    });
    std::fs::write(&out, serde_json::to_vec(&state).unwrap()).unwrap();
    eprintln!("c2s state: {} -> {} coordinates, written {out}", old_y.len(), y.len());
}

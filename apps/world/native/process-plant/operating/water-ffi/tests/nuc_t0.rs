//! E-NUC (plan r4) zero-time equivalence, T0: one dump of the joined
//! operator at a saved state, the same on the unreduced tree and on the
//! replica-grouped one, which `scripts/ld01-nuc-t0.ts` compares row by row,
//! heat by heat and Jacobian entry by entry (the reduced Jacobian against
//! the unreduced one with each replica group's columns summed).
//!
//! The dump holds, at `LD01_S3_STATE` (`{t_s, packet, y_bits, yp_bits,
//! discrete_state}`):
//! - every layout label, scale and row scale;
//! - the residual rows at `(y, y')` and at `(y, 0)` (the second makes every
//!   rate row its right-hand side, so the comparison is not of zeros);
//! - the nuclear heats per carrier and in total, the regional reactivities
//!   and the carriers' feedback temperatures;
//! - the block Jacobian `dF/dy + cj dF/dy'` at `(y, y')`, `cj = 1e3`, as
//!   CSC with its entries' bits.
//!
//! NOT evidence by itself: a dump. Written only to a new path.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::joined::blocks::{Classes, JoinedJacobian, jacobian_blocks};
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
#[ignore = "E-NUC T0 dump: requires the joined packet, a saved state (LD01_S3_STATE), the wiki, IF97 and stock IDA/KLU; writes LD01_NUC_T0_DUMP"]
fn nuc_t0_dump() {
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let out = std::env::var("LD01_NUC_T0_DUMP").expect("LD01_NUC_T0_DUMP");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let (packet_path, _) = spine::packet_bytes();
    assert_eq!(state["packet"].as_str(), Some(packet_path.as_str()), "packet");
    let mut s = spine::started_full_composition();
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    if !state["discrete_state"].is_null() {
        joined
            .restore_discrete_state(&state["discrete_state"]["operator"])
            .expect("discrete state");
    }
    let (y, yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    let t0 = state["t_s"].as_f64().expect("t_s");
    assert_eq!(y.len(), joined.dimension(), "state layout");
    let structure = JoinedJacobian::compile_for(joined, t0, &y, None).expect("structure");
    let layouts = joined.layouts();
    let labels: Vec<String> = layouts.iter().flat_map(|(_, l)| l.labels.clone()).collect();
    let row_scales: Vec<f64> = layouts
        .iter()
        .flat_map(|(_, l)| l.row_scales.clone())
        .collect();
    let mut point = |yp: &[f64]| -> Value {
        joined.evaluate(t0, &y, yp, None, 0., None).expect("evaluate");
        let rows: Vec<f64> = joined.rows().iter().map(|r| r.value).collect();
        let h = &joined.heats().nuclear;
        let v = |x: &[leitbild_operating_plant::thermal::Scalar]| -> Vec<f64> {
            x.iter().map(|s| s.value).collect()
        };
        let reactivity: Vec<f64> = joined
            .nuclear()
            .feedback_output()
            .expect("feedback output")
            .regions
            .iter()
            .map(|r| r.reactivity.value)
            .collect();
        json!({
            "rows": bits(&rows),
            "fuel_w": bits(&v(&h.fuel_w)),
            "coolant_w": bits(&v(&h.coolant_w)),
            "totals_w": bits(&[h.event_w.value, h.released_w.value, h.stored_rate_w.value]),
            "reactivity": bits(&reactivity),
            "fuel_feedback_k": bits(&v(joined.fuel_feedback_temperatures())),
        })
    };
    let at_state = point(&yp);
    let at_zero_rates = point(&vec![0.; y.len()]);
    let cj = 1e3;
    let mut values = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(joined, &structure, t0, cj, &y, &yp, &mut values, Classes::ALL)
        .expect("block Jacobian");
    let dump = json!({
        "kind": "E-NUC T0 dump",
        "status": "NOT-EVIDENCE dump; compared by scripts/ld01-nuc-t0.ts",
        "state": state_path,
        "packet": packet_path,
        "t_s": t0,
        "dimension": y.len(),
        "labels": labels,
        "scales": bits(&joined.scales()),
        "row_scales": bits(&row_scales),
        "at_state": at_state,
        "at_zero_rates": at_zero_rates,
        "jacobian": {
            "cj": cj,
            "pointers": structure.pattern.pointers(),
            "indices": structure.pattern.indices(),
            "values": bits(&values),
        },
    });
    std::fs::write(&out, serde_json::to_vec(&dump).unwrap()).expect("dump");
}

/// E-NUC: every grouped coordinate's packet members by label, for the T0
/// judge (`LD01_NUC_T0_MEMBERS`): the reduced label and the unreduced labels
/// of its members, representative first. The judge checks that the lists
/// partition the unreduced labels and that every member's rows equal its
/// representative's in the unreduced dump.
#[test]
#[ignore = "E-NUC T0 members: requires the joined packet, the wiki, IF97 and stock IDA/KLU; writes LD01_NUC_T0_MEMBERS"]
fn nuc_t0_members() {
    let out = std::env::var("LD01_NUC_T0_MEMBERS").expect("LD01_NUC_T0_MEMBERS");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let s = spine::started_full_composition();
    let joined = &s.joined;
    let raw: Value = serde_json::from_slice(&spine::packet_bytes().1).unwrap();
    let ids = |path: &[&str]| -> Vec<String> {
        let mut v = &raw;
        for k in path {
            v = &v[*k];
        }
        v.as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect()
    };
    let carriers = ids(&["hot", "energy", "carriers"]);
    let halves = ids(&["thermal", "fuel_bands"]);
    let helium = ids(&["thermal", "helium"]);
    let stores = ids(&["thermal", "passive_stores"]);
    let n = joined.nuclear();
    let sol = joined.solids();
    let mut map = serde_json::Map::new();
    let mut add = |labels: &[String], members: &[Vec<usize>], names: &[String]| {
        for l in labels {
            for m in members {
                let tag = format!("[{}x{}]", names[m[0]], m.len());
                if let Some(at) = l.find(&tag) {
                    let list: Vec<String> = m
                        .iter()
                        .map(|k| format!("{}[{}]{}", &l[..at], names[*k], &l[at + tag.len()..]))
                        .collect();
                    map.insert(l.clone(), json!(list));
                    break;
                }
            }
        }
    };
    add(&n.layout().labels, n.members(), &carriers);
    let sl = &sol.layout().labels;
    add(sl, sol.half_members(), &halves);
    add(sl, sol.helium_members(), &helium);
    add(sl, sol.store_members(), &stores);
    let clusters = ids(&["rods", "clusters"]);
    let rods = joined.rods().expect("rod owner");
    add(&rods.layout().labels, &rods.class_members(), &clusters);
    // EVT-RODS-BANK: a class's bores' water region holds the packet
    // layout's sector-share bore groups of its members (bitwise shares,
    // first appearance first): "M_bore{j}[first member]" etc. in the
    // unreduced labels, the region's own label naming its first group.
    let shares: Vec<String> = raw["rods"]["clusters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["sector_shares"].to_string())
        .collect();
    let mut first: Vec<usize> = Vec::new();
    let group: Vec<usize> = (0..shares.len())
        .map(|c| match first.iter().position(|f| shares[*f] == shares[c]) {
            Some(g) => g,
            None => {
                first.push(c);
                first.len() - 1
            }
        })
        .collect();
    for (k, members) in rods.class_members().iter().enumerate() {
        let mut groups: Vec<usize> = members.iter().map(|c| group[*c]).collect();
        groups.sort_unstable();
        groups.dedup();
        if groups.len() < 2 {
            continue;
        }
        for q in ["M", "U", "B", "p"] {
            let list: Vec<String> = groups
                .iter()
                .map(|g| format!("{q}_bore{g}[{}]", clusters[first[*g]]))
                .collect();
            map.insert(format!("{q}_bore{k}[{}]", clusters[members[0]]), json!(list));
        }
    }
    std::fs::write(&out, serde_json::to_vec(&Value::Object(map)).unwrap()).expect("members");
}

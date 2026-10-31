//! Plan r4 X4.2: the CVCS owner's zero-time check at a saved state of the
//! composed CVCS packet (`LD01_S3_STATE`, a `cvcs_state` conversion). One
//! dump, which `scripts/ld01-cvcs-t0.ts` judges by its pinned rule:
//! - the composition: the CVCS block's layout (14 singles, all differential);
//! - the tracked point: the CVCS coordinates' consistent rates
//!   (`y'_i = -F_i(y, y')` with the CVCS rates zero: every CVCS row is a
//!   rate row on its own scale), the branch flows and stems;
//! - the Jacobian: the block assembly against the colored one (every entry),
//!   and both against a difference directional derivative (the G10 rule:
//!   the one-sided Richardson `2 D(h/2) - D(h)`, on each side) on every CVCS
//!   column and every network coordinate the CVCS reads (COLD.A, the leg
//!   cells, the PZR cell), all rows. Both sides are recorded: a continuous
//!   clamp corner within one step of the state has a one-sided derivative
//!   only on its other side;
//! - the account at the consistent CVCS rates: every identity, the CVCS
//!   tanks' among them.
//!
//! NOT evidence by itself: a dump. Written only to a new path.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;

use leitbild_operating_plant::joined::{
    account::Plan,
    blocks::{Classes, JoinedJacobian, jacobian_blocks},
    operator::Joined,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

const STEP: f64 = 1e-5;
const CJ: f64 = 20.;

fn from_bits(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("bits array")
        .iter()
        .map(|x| f64::from_bits(u64::from_str_radix(x.as_str().expect("hex"), 16).expect("hex")))
        .collect()
}
fn rows(joined: &Joined<If97>) -> Vec<f64> {
    joined.rows().iter().map(|r| r.value).collect()
}

/// G10's difference rule along the unit direction `sign e_j`.
fn difference(
    joined: &mut Joined<If97>,
    y: &[f64],
    yp: &[f64],
    base: &[f64],
    j: usize,
    sign: f64,
) -> Result<Vec<f64>, String> {
    let h = STEP * y[j].abs().max(1.);
    let mut at = |step: f64| -> Result<Vec<f64>, String> {
        let (mut ys, mut yps) = (y.to_vec(), yp.to_vec());
        ys[j] += step * sign;
        yps[j] += CJ * step * sign;
        joined
            .evaluate(0., &ys, &yps, None, 0., None)
            .map_err(|e| format!("{e:?}"))?;
        Ok(rows(joined)
            .iter()
            .zip(base)
            .map(|(f, f0)| (f - f0) / step)
            .collect())
    };
    let whole = at(h)?;
    let half = at(0.5 * h)?;
    // Back to the directional derivative per unit +e_j.
    Ok(half
        .iter()
        .zip(&whole)
        .map(|(a, b)| (2. * a - b) * sign)
        .collect())
}

fn column(pattern: &leitbild_operating_plant::sparse::Pattern, values: &[f64], j: usize, n: usize) -> Vec<f64> {
    let mut out = vec![0.; n];
    let span = pattern.pointers()[j]..pattern.pointers()[j + 1];
    for (row, a) in pattern.indices()[span.clone()].iter().zip(&values[span]) {
        out[*row] = *a;
    }
    out
}

#[test]
#[ignore = "plan r4 X4.2 zero-time dump: requires the CVCS packet, its converted state (LD01_S3_STATE), the wiki, IF97 and stock IDA/KLU; writes LD01_CVCS_T0_DUMP"]
fn cvcs_t0_dump() {
    let state_path = std::env::var("LD01_S3_STATE").expect("LD01_S3_STATE");
    let out = std::env::var("LD01_CVCS_T0_DUMP").expect("LD01_CVCS_T0_DUMP");
    assert!(!std::path::Path::new(&out).exists(), "never overwritten");
    let state: Value =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state json");
    let (packet_path, _) = common::packet_bytes();
    assert_eq!(state["packet"].as_str(), Some(packet_path.as_str()), "packet");
    let mut s = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the composition");
    let joined = &mut s.joined;
    joined.declare_feed_gate().expect("feed gate");
    joined
        .restore_discrete_state(&state["discrete_state"]["operator"])
        .expect("discrete state");
    let (y, mut yp) = (from_bits(&state["y_bits"]), from_bits(&state["yp_bits"]));
    let t0 = state["t_s"].as_f64().expect("t_s");
    let n = joined.dimension();
    assert_eq!(y.len(), n, "state layout");
    let o = joined.offsets();
    let cvcs = joined.cvcs().expect("the CVCS owner").clone();
    let layout = cvcs.layout().clone();
    // The CVCS rates consistent at the state: every CVCS row is a rate row
    // on its own scale (`F_i = y'_i - rhs_i/scale_i`).
    for v in &mut yp[o.cvcs..] {
        *v = 0.;
    }
    joined.evaluate(t0, &y, &yp, None, 0., None).expect("evaluation");
    let at_zero = rows(joined);
    for i in o.cvcs..n {
        yp[i] = -at_zero[i];
    }
    joined.evaluate(t0, &y, &yp, None, 0., None).expect("evaluation");
    let base = rows(joined);
    let cvcs_rows: Vec<f64> = base[o.cvcs..].to_vec();
    let physical = |k: usize| y[o.cvcs + k] * layout.scales[k];
    let rates: Vec<Value> = (0..layout.len())
        .map(|k| json!([layout.labels[k], physical(k), yp[o.cvcs + k] * layout.scales[k], layout.multiplicity[k], layout.differential[k]]))
        .collect();
    let account = {
        let plan = Plan::new(joined).expect("account plan");
        let a = joined.account(&plan, t0, &y, &yp).expect("account");
        json!({"identities": a.json(), "worst": {"name": a.worst().name, "relative": a.worst().relative()}})
    };
    // The two assemblies at the same state.
    let structure = JoinedJacobian::compile_for(joined, t0, &y, None).expect("structure");
    let mut blocks = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(joined, &structure, t0, CJ, &y, &yp, &mut blocks, Classes::ALL)
        .expect("block assembly");
    let (cpattern, ccoloring) = joined.structure().expect("colored structure").clone();
    let _ = ccoloring;
    let mut colored = vec![0.; cpattern.nonzeros()];
    joined
        .jacobian(t0, CJ, &y, &yp, &mut colored)
        .expect("colored assembly");
    // Every entry of either assembly, by (row, column).
    let mut worst_assembly = (0_f64, 0, 0, 0., 0.);
    let mut cvcs_assembly = (0_f64, 0, 0, 0., 0.);
    for j in 0..n {
        let b = column(&structure.pattern, &blocks, j, n);
        let c = column(&cpattern, &colored, j, n);
        let scale = b.iter().chain(&c).fold(0_f64, |m, v| m.max(v.abs())).max(1e-300);
        for i in 0..n {
            let d = (b[i] - c[i]).abs() / scale;
            if d > worst_assembly.0 {
                worst_assembly = (d, i, j, b[i], c[i]);
            }
            if (i >= o.cvcs || j >= o.cvcs) && d > cvcs_assembly.0 {
                cvcs_assembly = (d, i, j, b[i], c[i]);
            }
        }
    }
    // Difference columns: every CVCS coordinate and every network
    // coordinate the CVCS reads.
    let network = &joined.network;
    let cell = |c: usize| -> std::ops::Range<usize> {
        let b = network.cell_layout[c].base;
        b..b + 6
    };
    let mut probe: Vec<(String, usize)> = (o.cvcs..n)
        .map(|j| (format!("cvcs {}", layout.labels[j - o.cvcs]), j))
        .collect();
    for c in cvcs.read_cells() {
        probe.extend(cell(c).map(|j| (format!("cell {c}"), j)));
    }
    probe.extend(cvcs.pzr_coordinates().map(|j| ("PZR cell".to_string(), j)));
    let port_rows: Vec<usize> = cell(cvcs.port_cell()).collect();
    // G10's exact-absence coordinates: a phase mass at exactly zero has no
    // difference derivative on either side (a phase born without energy or
    // a negative mass); its analytic column is the assemblies' comparison.
    let absent: Vec<usize> = network
        .cell_layout
        .iter()
        .flat_map(|l| l.mass)
        .filter(|i| y[*i] == 0.)
        .collect();
    let mut columns = Vec::new();
    for (label, j) in &probe {
        let b = column(&structure.pattern, &blocks, *j, n);
        let mut sides = serde_json::Map::new();
        for (side, sign) in [("plus", 1.), ("minus", -1.)] {
            let fd = match difference(joined, &y, &yp, &base, *j, sign) {
                Ok(v) => v,
                Err(e) => {
                    sides.insert(side.into(), json!({"refused": e}));
                    continue;
                }
            };
            let norm = fd.iter().map(|v| v.abs()).fold(0_f64, f64::max);
            let (mut all, mut at_all) = (0_f64, 0);
            let (mut judged, mut at_judged) = (0_f64, 0);
            for i in 0..n {
                let d = (b[i] - fd[i]).abs();
                if d > all {
                    (all, at_all) = (d, i);
                }
                if (i >= o.cvcs || port_rows.contains(&i)) && d > judged {
                    (judged, at_judged) = (d, i);
                }
            }
            sides.insert(side.into(), json!({"fd_norm": norm,
                "judged_rows": {"max_abs_diff": judged, "row": at_judged, "block": b[at_judged], "fd": fd[at_judged]},
                "all_rows": {"max_abs_diff": all, "row": at_all, "block": b[at_all], "fd": fd[at_all]}}));
        }
        columns.push(json!({"label": label, "column": j, "exact_absence": absent.contains(j), "sides": sides}));
    }
    let dump = json!({
        "kind": "plan r4 X4.2 CVCS zero-time dump", "state": state_path, "packet": packet_path, "t_s": t0,
        "provenance": common::spine_provenance(),
        "offsets": {"cvcs": o.cvcs, "end": o.end}, "cj": CJ, "step": STEP,
        "layout": {"labels": layout.labels, "scales": layout.scales, "row_scales": layout.row_scales,
            "multiplicity": layout.multiplicity, "differential": layout.differential},
        "modes": cvcs.discrete_state(),
        "cvcs_rows_at_consistent_rates": cvcs_rows,
        "coordinates_and_rates": rates,
        "port_rows": port_rows,
        "account": account,
        "assembly": {
            "all": {"max_rel": worst_assembly.0, "row": worst_assembly.1, "column": worst_assembly.2, "blocks": worst_assembly.3, "colored": worst_assembly.4},
            "cvcs": {"max_rel": cvcs_assembly.0, "row": cvcs_assembly.1, "column": cvcs_assembly.2, "blocks": cvcs_assembly.3, "colored": cvcs_assembly.4},
        },
        "difference_columns": columns,
    });
    std::fs::write(&out, serde_json::to_vec(&dump).expect("json")).expect("write");
    println!("{}", serde_json::to_string_pretty(&dump["assembly"]).unwrap());
}

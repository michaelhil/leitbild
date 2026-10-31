//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The presence-keyed joined pattern cache (S3-D-P3, `joined::presence`) on
//! the actual joined spine at the hot reference. A zero-time check and
//! measurement, NOT EVIDENCE:
//! - today's compile and a declared all-liquid presence give the same
//!   pattern (the hook changes no S2 structure);
//! - per read cell, and for all of them at once (S3-D-P3 (b)'s superset),
//!   the entries a declared vapor presence adds, with KLU's nnz(L+U) of the
//!   block matrix at this state on the base and the superset structure
//!   (AMD, as every joined solve);
//! - the cache: one compile per key, the kept structure handed out on a
//!   revisit, compile CPU per key.
//!
//! No state here holds vapor (the wall laws refuse a vapor-holding wall
//! cell until S3's contacts land): the vapor columns are structure only,
//! and their values are zero in the assembled matrices.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;
mod jacobian_harness;
use jacobian_harness::*;
use leitbild_operating_plant::joined::{
    blocks::{Classes, JoinedJacobian, jacobian_blocks},
    presence::{PatternCache, VaporPresence, joined_structure, pattern_cells},
};
use serde_json::{Value, json};

#[test]
#[ignore = "requires the S1 packet, the wiki gates, maintained IF97 and stock IDA/KLU; zero-time measurement"]
fn joined_presence_cache() {
    prefer_performance_core();
    let declared = Declared::load();
    let settled = settle(&declared, &[46.], Assembly::Blocks)
        .outputs
        .pop()
        .unwrap();
    let JoinedHot { mut joined, y, .. } = joined_hot(&declared, &settled, true);
    let n = joined.dimension();
    let zero = vec![0.; n];
    let cj = 20.;
    let cells = pattern_cells(&joined);
    let regions: Vec<String> = serde_json::from_slice::<Value>(
        &std::fs::read(&declared.packet_path).unwrap(),
    )
    .unwrap()["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    // Today's compile, and the declared all-liquid presence.
    let started = cpu();
    let base = JoinedJacobian::compile(&mut joined, 0., &y).expect("compile");
    let base_s = cpu() - started;
    let liquid = VaporPresence::liquid(&joined.network);
    assert_eq!(VaporPresence::evaluated(&joined.network), liquid);
    let declared_liquid =
        JoinedJacobian::compile_for(&mut joined, 0., &y, Some(&liquid)).expect("compile_for");
    assert_eq!(declared_liquid.pattern, base.pattern);
    let nnz = base.pattern.nonzeros();
    // Per read cell, the entries its vapor adds.
    let mut per_cell = Vec::new();
    for &c in &cells {
        let mut p = liquid.clone();
        p.cells[c] = true;
        let started = cpu();
        let s = JoinedJacobian::compile_for(&mut joined, 0., &y, Some(&p)).expect("per cell");
        per_cell.push(json!({"cell":c,"region":regions[c],"added_nnz":s.pattern.nonzeros() - nnz,"compile_cpu_s":cpu()-started}));
    }
    // The superset: every read cell with vapor.
    let mut all = liquid.clone();
    for &c in &cells {
        all.cells[c] = true;
    }
    let superset = JoinedJacobian::compile_for(&mut joined, 0., &y, Some(&all)).expect("superset");
    // Both structures' matrices at this state, and stock KLU on them (AMD).
    let mut a = vec![0.; base.pattern.nonzeros()];
    jacobian_blocks(&mut joined, &base, 0., cj, &y, &zero, &mut a, Classes::ALL)
        .expect("base block assembly");
    let mut s = vec![0.; superset.pattern.nonzeros()];
    jacobian_blocks(
        &mut joined,
        &superset,
        0.,
        cj,
        &y,
        &zero,
        &mut s,
        Classes::ALL,
    )
    .expect("superset block assembly");
    let csc = |structure: &JoinedJacobian| structure.pattern.to_i64().expect("csc");
    let (ap, ai) = csc(&base);
    let (sp, si) = csc(&superset);
    let klu_base = klu_profile_ordered(&ap, &ai, &[a.clone()], 3, 0);
    let klu_superset = klu_profile_ordered(&sp, &si, &[s.clone()], 3, 0);
    // The superset's extra entries are structure only here: same values.
    let mut same = true;
    for j in 0..n {
        for p in superset.pattern.pointers()[j]..superset.pattern.pointers()[j + 1] {
            let row = superset.pattern.indices()[p];
            let v = base.pattern.position(row, j).map_or(0., |q| a[q]);
            same &= v.to_bits() == s[p].to_bits();
        }
    }
    assert!(
        same,
        "the superset matrix differs from the base at this state"
    );
    // The cache: a miss compiles, a revisit is handed the kept structure.
    let mut cache = PatternCache::new(cells.clone());
    let (k0, s0) = joined_structure(&mut cache, &mut joined, 0., &y, &liquid).expect("miss");
    assert_eq!(s0.pattern, base.pattern);
    cache.check_in(&k0, s0).unwrap();
    let mut one = liquid.clone();
    one.cells[cells[0]] = true;
    let (k1, s1) = joined_structure(&mut cache, &mut joined, 0., &y, &one).expect("miss 2");
    cache.check_in(&k1, s1).unwrap();
    let started = cpu();
    let (k2, s2) = joined_structure(&mut cache, &mut joined, 0., &y, &liquid).expect("hit");
    let hit_s = cpu() - started;
    assert_eq!(k2, k0);
    assert_eq!(s2.pattern, base.pattern);
    cache.check_in(&k2, s2).unwrap();
    assert_eq!(
        (cache.stats.hits, cache.stats.misses, cache.keys()),
        (1, 2, 2)
    );
    let lu = |v: &Value| v["lnz_plus_unz"]["max"].as_f64().unwrap();
    let receipt = json!({
        "kind":"ld01-phase-l1-joined-presence-cache-NOT-EVIDENCE",
        "provenance":std::env::var("LD01_PHASE_PROVENANCE").ok().and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "packet":declared.packet_path,
        "dimension":n,
        "pattern_cells":cells.iter().map(|c|json!([c,regions[*c]])).collect::<Vec<_>>(),
        "base":{"nnz":nnz,"compile_cpu_s":base_s,"klu_amd":klu_base},
        "per_cell":per_cell,
        "superset":{"nnz":superset.pattern.nonzeros(),"added_nnz":superset.pattern.nonzeros()-nnz,"added_nnz_fraction":(superset.pattern.nonzeros()-nnz) as f64/nnz as f64,"klu_amd":klu_superset},
        "superset_lu_increase_fraction":lu(&klu_superset)/lu(&klu_base)-1.,
        "cache":{"stats":cache.stats,"hit_cpu_s":hit_s},
        "load_average":load_average(),
    });
    let text = serde_json::to_string_pretty(&receipt).unwrap();
    if let Ok(path) = std::env::var("LD01_PHASE_RECEIPT") {
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipts are never overwritten: {path}"
        );
        std::fs::write(&path, &text).expect("receipt");
    }
    println!(
        "{}",
        json!({"cells":cells.len(),"nnz":nnz,"superset_nnz":receipt["superset"]["nnz"],"lu_base":lu(&receipt["base"]["klu_amd"]),"lu_superset":lu(&receipt["superset"]["klu_amd"]),"lu_increase":receipt["superset_lu_increase_fraction"],"compile_cpu_s":base_s,"cache":receipt["cache"]})
    );
}

//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! The S3 kernel batch on the actual joined spine (KERN): L1 joined to the
//! stock-IDA wrapper, the presence-keyed structure followed by one handle,
//! and the derived tolerance classes every S3 run path applies. Checks on
//! the composed state of the S2 packet, NOT evidence.
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water).
//! The tests share one binary with `joined_spine.rs`'s ignored probes: run
//! them by name.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{
    joined::{
        blocks::{Classes, jacobian_blocks},
        presence::{VaporPresence, pattern_cells},
    },
    network::{phase_events::Root, unilateral::Lock},
};
use leitbild_operating_water::{
    ida::{Advance, Ida, Initial, System},
    joined::{
        DERIVED_CLASSES, Integrated, Matrices, consistent_start, derived_tolerances,
        root_directions,
    },
};
use spine::{DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_full_composition};

/// L1 on the joined spine: activation adds one root slot per phase path
/// after the S2 owners' roots (whose values and directions are unchanged),
/// a path's slot carries its lock's root in its declared direction, locked
/// impulses become algebraic with rows `Π/s`, every other row is bitwise
/// unchanged, and the composed state integrates with the slots armed and no
/// L1 event.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn l1_joins_the_spine_with_one_root_slot_per_phase_path() {
    let Started {
        mut joined,
        y,
        yp,
        network_ids,
        atol,
        rtol,
        structure,
        mut analyses,
        ..
    } = started_full_composition();
    let n = y.len();
    let s2_roots = joined.root_count();
    let s2_directions = joined.root_directions().unwrap();
    let mut s2_values = vec![0.; s2_roots];
    joined.roots(0., &y, &yp, &mut s2_values).unwrap();
    joined.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let s2_rows: Vec<f64> = joined.rows().iter().map(|r| r.value).collect();
    let s2_ids = joined.differential(&network_ids);
    let activation = joined.activate_unilateral(0., &y).expect("L1 activation");
    assert!(
        activation.changes.iter().all(|c| c.payment.is_none()),
        "no path pays at activation"
    );
    let locks = joined.network.unilateral().unwrap().clone();
    let paths = locks.paths.len();
    assert_eq!(joined.root_count(), s2_roots + paths);
    // The owners' roots and directions are S2's; the slots follow the locks.
    let directions = joined.root_directions().unwrap();
    assert_eq!(&directions[..s2_roots], &s2_directions[..]);
    let roots = joined.network.unilateral_roots();
    for (li, lock) in locks.paths.iter().enumerate() {
        let expected = match lock {
            Lock::Free => -1,
            Lock::Locked(h) if h.orientation().is_some() => 1,
            Lock::Locked(_) => 0,
        };
        assert_eq!(directions[s2_roots + li], expected, "path {li} {lock:?}");
    }
    let mut values = vec![0.; s2_roots + paths];
    joined.roots(0., &y, &yp, &mut values).unwrap();
    assert_eq!(
        values[..s2_roots]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        s2_values.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    for r in &roots {
        let v = values[s2_roots + r.path()];
        assert!(v.is_finite(), "{r:?}");
        if let Root::Contact(_) = r {
            assert!(v > 0., "a contact root reads its donor's mass: {r:?} {v}");
        }
    }
    // Locked impulses algebraic, every other identity S2's; rows bitwise
    // unchanged except the locked paths' `Π/s`.
    let ids = joined.differential(&network_ids);
    joined.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let rows: Vec<f64> = joined.rows().iter().map(|r| r.value).collect();
    let impulse: Vec<usize> = joined
        .layouts()
        .iter()
        .flat_map(|(owner, l)| l.classes.iter().map(move |c| format!("{owner}/{c:?}")))
        .enumerate()
        .filter(|(_, c)| c.contains("Impulse") || c.contains("Momentum"))
        .map(|(i, _)| i)
        .collect();
    let mut changed_ids = 0;
    let mut changed_rows = 0;
    for i in 0..n {
        if ids[i] != s2_ids[i] {
            changed_ids += 1;
            assert_eq!(ids[i], 0., "only locked impulses change identity");
        }
        if rows[i].to_bits() != s2_rows[i].to_bits() {
            changed_rows += 1;
            assert_eq!(ids[i], 0., "row {i} changed but is not a locked impulse");
        }
    }
    assert_eq!(changed_ids, locks.locked());
    println!(
        "{}",
        serde_json::json!({"paths": paths, "locked": locks.locked(), "roots": roots.len(),
            "changed_ids": changed_ids, "changed_rows": changed_rows, "impulse_coordinates": impulse.len(),
            "activation_changes": activation.changes.len()})
    );
    // Integrate the composed state with the slots armed: the exact start
    // under the new identity, the stock handle with the owners' directions.
    let mut y = y;
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let (yp, _) = consistent_start(
        &mut joined,
        Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        2,
    )
    .expect("exact start with L1");
    let mut yp = yp;
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).unwrap(),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .unwrap();
    assert_eq!(ida.system().root_count(), s2_roots + paths);
    ida.set_max_order(2).unwrap();
    ida.set_nonlinear_convergence_coefficient(NEWTON_COEFFICIENT)
        .unwrap();
    ida.set_delta_cj_lsetup(DELTA_CJ_LSETUP).unwrap();
    ida.set_init_step(FIRST_STEP_S).unwrap();
    root_directions(&mut ida).unwrap();
    match ida.advance(0.2, &mut y, &mut yp).unwrap() {
        Advance::Reached(t) => assert_eq!(t, 0.2),
        Advance::Root { time, directions } => panic!(
            "no event expected at the composed state: {time} {:?}",
            directions
                .iter()
                .enumerate()
                .filter(|(_, d)| **d != 0)
                .collect::<Vec<_>>()
        ),
    }
}

/// The presence-keyed structure on one stock handle: sized for the widest
/// key, the liquid key's Jacobian is the S2 block Jacobian bit for bit in
/// the first entries, a declared vapor cell switches to its own (larger)
/// structure without a new handle, and a revisit is handed the kept one.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn a_presence_change_switches_the_block_structure_on_one_handle() {
    let Started {
        mut joined,
        y,
        yp,
        structure,
        ..
    } = started_full_composition();
    let n = y.len();
    let liquid = VaporPresence::liquid(&joined.network);
    let cells = pattern_cells(&joined);
    let cj = 20.;
    let mut base = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(
        &mut joined,
        &structure,
        0.,
        cj,
        &y,
        &yp,
        &mut base,
        Classes::ALL,
    )
    .unwrap();
    let (base_pointers, base_rows) = structure.pattern.to_i64().unwrap();
    let mut system = Integrated::following_presence(joined, 0., &y, &liquid).unwrap();
    let capacity = system.nonzeros();
    assert!(capacity > base.len(), "the widest key holds more entries");
    let (key, keys) = system.presence_key().unwrap();
    assert!(key.0.is_empty());
    assert_eq!(keys, 2, "the widest key and the liquid one");
    let jacobian = |system: &mut Integrated<_>| {
        let (mut data, mut rows, mut pointers) =
            (vec![0.; capacity], vec![0i64; capacity], vec![0i64; n + 1]);
        system
            .jacobian(0., cj, &y, &yp, &mut data, &mut rows, &mut pointers)
            .unwrap();
        (data, rows, pointers)
    };
    let (data, rows, pointers) = jacobian(&mut system);
    assert_eq!(pointers, base_pointers);
    assert_eq!(&rows[..base.len()], &base_rows[..]);
    assert_eq!(
        data[..base.len()]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        base.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    // A declared vapor cell among the read ones: a new key on this handle.
    let mut one = liquid.clone();
    one.cells[cells[0]] = true;
    assert!(system.follow_presence(0., &y, &one).unwrap());
    let (_, _, pointers) = jacobian(&mut system);
    let entries = pointers[n] as usize;
    assert!(entries > base.len() && entries <= capacity, "{entries}");
    assert_eq!(system.presence_key().unwrap().1, 3);
    // Back to liquid: the kept structure, the S2 matrix again.
    assert!(system.follow_presence(0., &y, &liquid).unwrap());
    assert!(!system.follow_presence(0., &y, &liquid).unwrap());
    let (data, _, pointers) = jacobian(&mut system);
    assert_eq!(pointers, base_pointers);
    assert_eq!(
        data[..base.len()]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        base.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    assert_eq!(system.presence_key().unwrap().1, 3);
}

/// S2-D24's derived class as every S3 run path applies it: each guide
/// current takes `max_j (rtol |p_j|) |∂m/∂p_j|` from the block Jacobian at
/// the composed state, the value RESTART's independent probe recorded on
/// this packet to within its plenum choice (`min` against `max` of the two
/// plena's |p|, under 1 %).
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn the_derived_guide_current_class_is_s2_d24s() {
    let Started {
        mut joined,
        y,
        yp,
        mut atol,
        rtol,
        structure,
        ..
    } = started_full_composition();
    let before = atol.clone();
    let derived =
        derived_tolerances(&mut joined, &structure, 0., &y, &yp, rtol, &mut atol).unwrap();
    assert_eq!(DERIVED_CLASSES, &["rods/GuideCurrent"]);
    let clusters = joined.rods().unwrap().clusters();
    assert_eq!(derived.rows.len(), clusters);
    for (i, (a, b)) in atol.iter().zip(&before).enumerate() {
        match derived.rows.iter().find(|r| r.coordinate == i) {
            Some(r) => {
                assert_eq!(a.to_bits(), r.applied_scaled.to_bits());
                assert_eq!(b.to_bits(), r.replaced_scaled.to_bits());
            }
            None => assert_eq!(a.to_bits(), b.to_bits(), "coordinate {i} not derived"),
        }
    }
    // RESTART 799d0b61's receipt on packet 91d85fc1 (relative basis):
    // 9.6223e-4 kg/s at 149.50 Pa and 6.4362e-6 kg/s per Pa.
    let applied: Vec<f64> = derived.rows.iter().map(|r| r.applied).collect();
    let (lo, hi) = (
        applied.iter().copied().fold(f64::INFINITY, f64::min),
        applied.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    );
    println!(
        "{}",
        serde_json::json!({"rows": derived.rows.len(), "applied_kg_s": [lo, hi],
            "first": derived.rows[0]})
    );
    if std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").is_ok_and(|p| p.contains("91d85fc1")) {
        for a in applied {
            assert!(
                ((a - 9.622295293786392e-4) / 9.622295293786392e-4).abs() < 0.01,
                "{a}"
            );
        }
    }
}

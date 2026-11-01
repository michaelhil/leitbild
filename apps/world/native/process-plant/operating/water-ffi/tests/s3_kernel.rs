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
mod common;
use leitbild_operating_water::unit::{
    clock::process_cpu_s,
    profile::{DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT},
    spine::{
        Started, credited_outputs, started_full_composition, started_s3_composition,
        started_s3_phase_composition,
    },
};

use leitbild_operating_plant::{
    joined::{
        blocks::{Classes, JoinedJacobian, jacobian_blocks},
        presence::{VaporPresence, pattern_cells},
    },
    network::{CellMode, Properties, phase_events::Root, unilateral::Lock},
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial, System},
    joined::{
        Analyses, DERIVED_CLASSES, Discrete, Integrated, JoinedSystem, Matrices, Restart,
        consistent_start, derived_tolerances, discrete_restart, root_directions,
    },
};
use serde_json::Value;

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
    } = started_full_composition(&common::spine()).expect("the S2 composition");
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
    // A composed spray path's three slots stay last (DR-P3-SPRAY): the
    // owners' precede L1's slots, the spray slots follow them.
    let spray = 3 * usize::from(joined.network.spray().is_some());
    let owners = s2_roots - spray;
    assert_eq!(&directions[..owners], &s2_directions[..owners]);
    let roots = joined.network.unilateral_roots();
    for (li, lock) in locks.paths.iter().enumerate() {
        let expected = match lock {
            Lock::Free => -1,
            Lock::Locked(h) if h.orientation().is_some() => 1,
            Lock::Locked(_) => 0,
        };
        assert_eq!(directions[owners + li], expected, "path {li} {lock:?}");
    }
    let mut values = vec![0.; s2_roots + paths];
    joined.roots(0., &y, &yp, &mut values).unwrap();
    assert_eq!(
        values[..owners]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        s2_values[..owners]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>()
    );
    for r in &roots {
        let v = values[owners + r.path()];
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
    // A composed spray path's locked paths (the closed valve, the port's
    // scoped L1) are algebraic already before activation.
    let already = joined
        .network
        .face_layout
        .iter()
        .enumerate()
        .filter(|(li, l)| locks.is_locked(*li) && s2_ids[l.index] == 0.)
        .count();
    assert_eq!(changed_ids, locks.locked() - already);
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
    // Output targets 10 ms apart, as the S2 probes advance (stock's
    // 500-step limit per call; the composed state's first second takes
    // about 1,250 steps).
    for k in 1..=20 {
        let target = 0.01 * f64::from(k);
        match ida.advance(target, &mut y, &mut yp).unwrap() {
            Advance::Reached(t) => assert_eq!(t, target),
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
    let stats = ida.stats().unwrap();
    println!(
        "{}",
        serde_json::json!({"reached_s": 0.2, "steps": stats.steps, "jacobians": stats.jacobians,
            "root_evaluations": stats.root_evaluations})
    );
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
    } = started_full_composition(&common::spine()).expect("the S2 composition");
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
fn the_derived_guide_current_class_is_s2_d24r() {
    let Started {
        mut joined,
        y,
        yp,
        mut atol,
        rtol,
        structure,
        ..
    } = started_full_composition(&common::spine()).expect("the S2 composition");
    let before = atol.clone();
    let credited = credited_outputs(&joined, &common::spine()).expect("the credited outputs");
    assert_eq!(credited.len(), 1);
    assert_eq!(
        credited[0].budget, 50.,
        "ld01-accuracy-contract's core DP budget"
    );
    let derived = derived_tolerances(
        &mut joined,
        &structure,
        0.,
        &y,
        &yp,
        rtol,
        &credited,
        &mut atol,
    )
    .unwrap();
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
    // Every guide current determines core DP: 50 Pa x |dm/dDp| (RESTART
    // 799d0b61's receipt on packet 91d85fc1: 6.4362e-6 kg/s per Pa, so
    // about 3.22e-4 kg/s, the lead's S2-D24r value).
    for r in &derived.rows {
        assert_eq!(r.determines[0].output, "core_dp_pa");
        assert_eq!(
            r.applied,
            r.determines[0].budget * r.determines[0].sensitivity
        );
    }
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
                ((a - 50. * 6.436241968892448e-6) / (50. * 6.436241968892448e-6)).abs() < 0.01,
                "{a}"
            );
        }
    }
}

/// Phase modes on the joined spine (S3-D-P1, KERN's joined block replay):
/// HOUSING.NECK flashed on the composed state (2 kg of saturated vapor at
/// its pressure, PHASE-P7's cell test), with L1 and the phase modes active.
/// The joined block Jacobian on the declared presence's structure equals
/// the colored assembly on the operator's structural pattern, and the state
/// integrates on the block assembly with S3-D3's derived vapor class, every
/// located root (the bubble's own, in its declared direction) restarted by
/// `discrete_restart`, up to NECK's exhaustion.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn an_equilibrium_cell_assembles_by_blocks_and_integrates_on_the_joined_spine() {
    let Started {
        mut joined,
        mut y,
        network_ids,
        mut atol,
        rtol,
        ..
    } = started_full_composition(&common::spine()).expect("the S2 composition");
    let n = y.len();
    let packet: Value = serde_json::from_slice(&common::packet_bytes().1).unwrap();
    let neck = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "HOUSING.NECK")
        .expect("HOUSING.NECK");
    let l = joined.network.cell_layout[neck];
    let sc = joined.scales();
    let p = y[l.base] * sc[l.base];
    let sat = If97
        .saturation_caloric(Scalar::constant(p))
        .expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let v = joined.network.volume(neck);
    let mg = 2.;
    let ml = (v - mg / rg) * rf;
    let (m0, e0, m1, e1) = (l.mass[0], l.energy[0], l.mass[1], l.energy[1]);
    assert_eq!(
        (y[m1], y[e1]),
        (0., 0.),
        "a composed liquid cell holds no vapor"
    );
    joined.network.birth(neck, &mut y).expect("birth");
    y[m0] = (ml + mg) / sc[m0];
    y[e0] = (ml * uf + mg * ug) / sc[e0];
    y[m1] = mg / sc[m1];
    y[e1] = mg * ug / sc[e1];
    assert_eq!(joined.network.cell_modes()[neck], CellMode::Equilibrium);
    let l1 = joined.activate_unilateral(0., &y).expect("L1");
    joined.activate_phase_modes().expect("phase modes");
    let presence = VaporPresence::of(&joined.network, &joined.network.declared_presence(&y));
    let structure =
        JoinedJacobian::compile_for(&mut joined, 0., &y, Some(&presence)).expect("structure");
    // Block against colored at (0, y, 0).
    let zero = vec![0.; n];
    let cj = 20.;
    let mut bv = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(
        &mut joined,
        &structure,
        0.,
        cj,
        &y,
        &zero,
        &mut bv,
        Classes::ALL,
    )
    .expect("joined block assembly");
    let colored = joined.structure().unwrap().0.clone();
    let mut cv = vec![0.; colored.nonzeros()];
    joined
        .jacobian(0., cj, &y, &zero, &mut cv)
        .expect("joined colored assembly");
    let (mut worst, mut at) = (0_f64, serde_json::json!(null));
    for j in 0..n {
        let b = structure.pattern.pointers()[j]..structure.pattern.pointers()[j + 1];
        let c = colored.pointers()[j]..colored.pointers()[j + 1];
        let scale = b
            .clone()
            .map(|q| bv[q].abs())
            .chain(c.clone().map(|q| cv[q].abs()))
            .fold(0., f64::max);
        if scale == 0. {
            continue;
        }
        for q in b {
            let row = structure.pattern.indices()[q];
            let other = colored.position(row, j).map_or(0., |k| cv[k]);
            let e = (bv[q] - other).abs() / scale;
            if e > worst {
                (worst, at) = (
                    e,
                    serde_json::json!({"row": row, "column": j, "blocks": bv[q], "colored": other}),
                );
            }
        }
        for q in c {
            let row = colored.indices()[q];
            if structure.pattern.position(row, j).is_none() && cv[q] != 0. {
                let e = cv[q].abs() / scale;
                if e > worst {
                    (worst, at) = (
                        e,
                        serde_json::json!({"row": row, "column": j, "blocks": null, "colored": cv[q]}),
                    );
                }
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"neck": neck, "block_vs_colored": worst, "worst": at,
            "block_nnz": structure.pattern.nonzeros(), "colored_nnz": colored.nonzeros(),
            "l1_locked": joined.network.unilateral().map(|u| u.locked()), "l1_changes": l1.changes.len()})
    );
    assert!(
        worst < 1e-10,
        "joined block against colored {worst:e} at {at}"
    );
    // The identity, S3-D3's class and the exact start at the flashed state.
    let ids = joined.differential(&network_ids);
    assert_eq!((ids[m1], ids[e1]), (0., 0.));
    // S3-D16b: the contract's credited outputs read no NECK pressure, so a
    // NECK equilibrium cell determines none and takes rtol·|p| through its
    // flash sensitivity, recorded with that rule. This test then declares,
    // for the kernel's mechanics only, one output on NECK's pressure with
    // the contract's PT1 sample-noise budget (labelled test-only; the S3
    // declaration owns the real mapping).
    let nn = joined.offsets().nuclear;
    let contract = credited_outputs(&joined, &common::spine()).expect("the credited outputs");
    let undeclared = joined
        .network
        .equilibrium_credited_tolerances(&y[..nn], &contract, rtol, &mut atol.clone()[..nn])
        .expect("S3-D16b");
    assert_eq!(undeclared.len(), 1);
    assert!(
        undeclared[0]["rule"]
            .as_str()
            .is_some_and(|r| r.starts_with("S3-D16b")),
        "{undeclared:?}"
    );
    let mut credited = contract;
    credited.push(leitbild_operating_plant::network::CreditedOutput {
        name: "TEST-ONLY neck pressure (PT1 sample-noise budget)".into(),
        budget: 200.,
        columns: vec![l.base],
    });
    joined.declare_credited(credited.clone()).unwrap();
    let classes = joined
        .network
        .equilibrium_credited_tolerances(&y[..nn], &credited, rtol, &mut atol[..nn])
        .expect("S3-D16");
    assert_eq!(classes.len(), 1);
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let mut analyses = Analyses::default();
    let (mut yp, start) = consistent_start(
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
    .expect("exact start at the flashed state");
    let nonnegative = joined.network.nonnegative_stocks();
    assert!(!nonnegative.contains(&m1));
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
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    root_directions(&mut ida).unwrap();
    // Integrate with every located root restarted by `discrete_restart`
    // until NECK's exhaustion. The flash is not the composed state's
    // physics (NECK is about 20 K subcooled at full power): the bubble
    // vents through its L1-released vapor path and collapses, and the vapor
    // that reaches a liquid-mode neighbour is C4's declared end ("first
    // vapor into subcooled liquid"), not a state S3 represents. So the run
    // stops at the exhaustion and reports what was located before it.
    let (first_mode, first_l1) = {
        let joined = &ida.system().integrated().joined;
        // A composed spray path's three slots stay last (DR-P3-SPRAY).
        let spray = 3 * usize::from(joined.network.spray().is_some());
        let first_mode = joined.root_count() - spray - 2 * joined.network.pzr.cell;
        (first_mode, first_mode - joined.network.face_layout.len())
    };
    let label = |i: usize, d: i32| -> String {
        if i >= first_mode {
            let c = (i - first_mode) / 2;
            let slot = if (i - first_mode).is_multiple_of(2) {
                "birth/exhaustion"
            } else {
                "dryout"
            };
            format!("cell {c} {slot} {d:+}")
        } else if i >= first_l1 {
            format!("L1 path {} {d:+}", i - first_l1)
        } else {
            format!("owner root {i} {d:+}")
        }
    };
    let exhaustion = first_mode + 2 * neck;
    let mut t = 0.;
    let mut events: Vec<Value> = Vec::new();
    let mut exhausted_at = None;
    'outputs: for k in 1..=20 {
        let target = 0.01 * f64::from(k);
        while t < target {
            match ida.advance(target, &mut y, &mut yp).unwrap() {
                Advance::Reached(time) => t = time,
                Advance::Root { time, directions } => {
                    t = time;
                    // Every located root crosses in its declared direction.
                    let declared = ida.system().integrated().joined.root_directions().unwrap();
                    let located: Vec<(usize, i32)> = directions
                        .iter()
                        .enumerate()
                        .filter(|(_, d)| **d != 0)
                        .map(|(i, d)| (i, *d))
                        .collect();
                    let kinds: Vec<String> = located.iter().map(|(i, d)| label(*i, *d)).collect();
                    for (i, d) in &located {
                        assert_eq!(*d, declared[*i], "{kinds:?}");
                        assert!(*i >= first_l1, "only the bubble's roots: {kinds:?}");
                    }
                    if located.iter().any(|(i, _)| *i == exhaustion) {
                        exhausted_at = Some(t);
                        events.push(
                            serde_json::json!({"t_s": t, "located": kinds, "restarted": false}),
                        );
                        break 'outputs;
                    }
                    let restarted = discrete_restart(
                        &mut ida,
                        t,
                        Discrete::Roots(&directions),
                        &mut y,
                        &network_ids,
                        &atol,
                        rtol,
                        &restart,
                    )
                    .unwrap_or_else(|e| panic!("restart at {t} s, {kinds:?}: {e}"));
                    yp.copy_from_slice(&restarted.yp);
                    events.push(serde_json::json!({"t_s": t, "located": kinds,
                        "transactions": restarted.transactions.iter().map(|x| x.receipt.clone()).collect::<Vec<_>>(),
                        "modes_changed": restarted.modes_changed,
                        "equilibrium_classes": restarted.equilibrium_classes.len()}));
                }
            }
        }
    }
    assert!(!events.is_empty(), "the bubble's roots are located");
    let stats = ida.stats().unwrap();
    println!(
        "{}",
        serde_json::json!({"reached_s": t, "steps": stats.steps, "jacobians": stats.jacobians,
            "start_passes": start.projection_passes, "exhausted_at_s": exhausted_at,
            "events": events, "derived_vapor_class": classes})
    );
}

/// The S3 phase-branch composition (`started_s3_phase_composition`): L1
/// and the phase modes declared on the S2-D24 composition. Its root count
/// is S2's plus one L1 slot per phase path and two mode slots per regular
/// cell, every cell liquid; the exact start holds at the composed state
/// under the L1 identity, and a presence-following handle advances 0.05 s
/// with no event.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn the_s3_phase_composition_starts_and_advances_with_l1_and_the_modes() {
    let s2_roots = started_full_composition(&common::spine())
        .expect("the S2 composition")
        .joined
        .root_count();
    let (
        Started {
            mut joined,
            mut y,
            ids,
            atol,
            rtol,
            structure,
            ..
        },
        derived,
    ) = started_s3_phase_composition(&common::spine()).expect("the S3 phase composition");
    let paths = joined.network.face_layout.len();
    let cells = joined.network.pzr.cell;
    assert_eq!(joined.root_count(), s2_roots + paths + 2 * cells);
    assert!(
        joined
            .network
            .cell_modes()
            .iter()
            .all(|m| *m == CellMode::Liquid)
    );
    assert!(!derived.rows.is_empty());
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let mut analyses = Analyses::default();
    let (mut yp, start) = consistent_start(
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
    .expect("exact start under the L1 identity");
    let liquid = VaporPresence::liquid(&joined.network);
    let mut ida = Ida::new(
        Integrated::following_presence(joined, 0., &y, &liquid).unwrap(),
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
    ida.set_max_order(2).unwrap();
    ida.set_nonlinear_convergence_coefficient(NEWTON_COEFFICIENT)
        .unwrap();
    ida.set_delta_cj_lsetup(DELTA_CJ_LSETUP).unwrap();
    ida.set_init_step(FIRST_STEP_S).unwrap();
    root_directions(&mut ida).unwrap();
    for k in 1..=5 {
        let target = 0.01 * f64::from(k);
        assert_eq!(
            ida.advance(target, &mut y, &mut yp).unwrap(),
            Advance::Reached(target)
        );
    }
    let stats = ida.stats().unwrap();
    println!(
        "{}",
        serde_json::json!({"roots": ida.system().root_count(), "paths": paths, "cells": cells,
            "start_passes": start.projection_passes, "steps": stats.steps, "jacobians": stats.jacobians,
            "root_evaluations": stats.root_evaluations})
    );
}

/// DR-C3-BIRTH05 (owner decision G1): SURGE composed as liquid at the
/// band's credited superheat over saturation at its pressure, born by its
/// located root through `discrete_restart`. The birth moves no stock, and
/// the flash at SURGE's unchanged totals is a finite step: its volume row
/// starts near 3e-3 and its pressure rises. Newton reaches about 3e-10 after
/// the 2 passes of an ordinary restart (C3's stop at 576.32 s), so a birth
/// takes S2-D21's transaction pass bound (12, S3-D41). The born cell's
/// `p, M_g, U_g`, and nothing else, leave the WRMS guard at the birth
/// instant and are reported (S3-D64), and the 1e-12 bound is unchanged. The
/// state handed to the
/// restart is on the manifold (its entry constraint within the bound), and
/// the result is the honest flash: pressure risen by about 0.1 MPa, at least
/// 0.01 kg of vapor (DR-C3-BIRTH05 round 2: C3's 8.8e-5 kg came from an
/// entry state off the manifold), constraints within the bound, and the
/// restart's birth record in physical units.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn a_birth_at_the_credited_superheat_is_a_finite_flash_the_start_completes() {
    let (
        Started {
            mut joined,
            mut y,
            network_ids,
            atol,
            rtol,
            structure,
            ..
        },
        _,
    ) = started_s3_phase_composition(&common::spine()).expect("the S3 phase composition");
    let packet: Value = serde_json::from_slice(&common::packet_bytes().1).unwrap();
    let surge = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "SURGE")
        .expect("SURGE");
    let l = joined.network.cell_layout[surge];
    let sc = joined.scales();
    let (m0, e0, m1, e1) = (l.mass[0], l.energy[0], l.mass[1], l.energy[1]);
    let p0 = y[l.base] * sc[l.base];
    let band = If97.metastable_band().expect("band");
    assert!(
        p0 > band.pressure_range_pa[0] && p0 <= band.pressure_range_pa[1],
        "SURGE at {p0} Pa lies in the band's pressure range"
    );
    let sat = If97
        .saturation_caloric(Scalar::constant(p0))
        .expect("saturation");
    let superheated = If97
        .forward(
            false,
            p0,
            sat.temperature.value + band.credited_max_k,
        )
        .expect("liquid at the credited superheat");
    let v = joined.network.volume(surge);
    let mass = superheated.density_kg_m3 * v;
    y[m0] = mass / sc[m0];
    y[e0] = mass * superheated.internal_energy_j_kg / sc[e0];
    let ids = joined.differential(&network_ids);
    let weights: Vec<f64> = y
        .iter()
        .zip(&atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect();
    let mut analyses = Analyses::default();
    let (mut yp, _) = consistent_start(
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
    .expect("exact start with SURGE superheated");
    let root = joined.network.birth_root(surge, &y).expect("birth root");
    assert!(root.abs() < 1e-6, "SURGE on its birth root: {root} K");
    let p_liquid = y[l.base] * sc[l.base];
    let totals = (y[m0].to_bits(), y[e0].to_bits());
    let liquid = VaporPresence::liquid(&joined.network);
    let mut ida = Ida::new(
        Integrated::following_presence(joined, 0., &y, &liquid).unwrap(),
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
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    ida.set_max_order(2).unwrap();
    restart.configure(&mut ida).unwrap();
    root_directions(&mut ida).unwrap();
    let mut directions = {
        let joined = &ida.system().integrated().joined;
        let spray = 3 * usize::from(joined.network.spray().is_some());
        let first_mode = joined.root_count() - spray - 2 * joined.network.pzr.cell;
        let mut d = vec![0; joined.root_count()];
        d[first_mode + 2 * surge] = 1;
        d
    };
    directions.resize(ida.system().root_count(), 0);
    let restarted = discrete_restart(
        &mut ida,
        0.,
        Discrete::Roots(&directions),
        &mut y,
        &network_ids,
        &atol,
        rtol,
        &restart,
    )
    .unwrap_or_else(|e| panic!("the birth's restart: {e}"));
    yp.copy_from_slice(&restarted.yp);
    let joined = &ida.system().integrated().joined;
    assert_eq!(joined.network.cell_modes()[surge], CellMode::Equilibrium);
    assert!(restarted.modes_changed);
    assert!(restarted.transacted.is_empty());
    assert_eq!(restarted.passes_allowed, 12);
    assert!(
        restarted.constraint_at_entry.value <= 1e-12,
        "the state handed to the birth is on the manifold: {:?}",
        restarted.constraint_at_entry
    );
    let report = &restarted.report;
    assert!(
        report.projection_passes > restart.start_passes,
        "the finite flash needs more than an ordinary restart's passes: {report:?}"
    );
    assert!(report.constraint_after.value <= 1e-12, "{report:?}");
    let exempt = report.exempt.expect("the born cell's coordinates are reported");
    assert_eq!(exempt.coordinates, 3, "only the born cell's p, M_g, U_g: {exempt:?}");
    assert_eq!(exempt.max.row, l.base, "{exempt:?}");
    assert!(report.correction_wrms <= 1., "{report:?}");
    assert_eq!(
        (y[m0].to_bits(), y[e0].to_bits()),
        totals,
        "a birth moves no stock"
    );
    let p = y[l.base] * sc[l.base];
    let (mg, ug) = (y[m1] * sc[m1], y[e1] * sc[e1]);
    assert!(mg >= 0.01 && ug > 0., "vapor at the flash: {mg} kg, {ug} J");
    assert!(p > p_liquid, "the flash raises SURGE's pressure: {p_liquid} -> {p}");
    let [record] = restarted.births.as_slice() else {
        panic!("one birth record: {:?}", restarted.births)
    };
    assert_eq!(record["cell"], surge);
    assert_eq!(record["p_entry_pa"].as_f64(), Some(p_liquid));
    assert_eq!(record["p_flash_pa"].as_f64(), Some(p));
    assert_eq!(record["vapor_kg"].as_f64(), Some(mg));
    let units = &record["correction_tolerance_units"];
    assert_eq!(units["p"].as_f64().map(f64::abs), Some(exempt.max.value), "{units}");
    assert!(units["vapor_mass"].as_f64().is_some_and(f64::is_finite), "{units}");
    // The constant-pressure estimate of the flashed vapor, for the receipt:
    // superheat x M x c_p / h_fg.
    let h_fg = sat.vapor.enthalpy.value - sat.liquid.enthalpy.value;
    let isobaric = band.credited_max_k * mass * superheated.cp_j_kg_k / h_fg;
    println!(
        "{}",
        serde_json::json!({"surge": surge, "volume_m3": v, "mass_kg": mass,
            "superheat_k": band.credited_max_k, "p_liquid_pa": p_liquid, "p_flash_pa": p,
            "dp_pa": p - p_liquid, "vapor_kg": mg, "vapor_j": ug, "isobaric_estimate_kg": isobaric,
            "constraint_before": [report.constraint_before.value, report.constraint_before.row],
            "constraint_after": [report.constraint_after.value, report.constraint_after.row],
            "passes": report.projection_passes, "wrms": report.correction_wrms,
            "constraint_at_entry": [restarted.constraint_at_entry.value, restarted.constraint_at_entry.row],
            "births": restarted.births,
            "transactions": restarted.transactions.iter().map(|x| x.receipt.clone()).collect::<Vec<_>>()})
    );
}

/// The phase-mode owner's transactions through `Joined::transact` (S3-D-P1):
/// at the flashed NECK with L1 and the modes active, a located exhaustion
/// (its slot falling) makes NECK liquid with its vapor slots zeroed and its
/// totals bitwise unchanged; a located birth (its slot rising) makes it
/// equilibrium again with no stock moved; a located dryout refuses (mode G
/// is S6). Each instant also runs L1's transaction on the post-mode state.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn the_phase_mode_transactions_move_no_stock() {
    let Started {
        mut joined, mut y, ..
    } = started_full_composition(&common::spine()).expect("the S2 composition");
    let packet: Value = serde_json::from_slice(&common::packet_bytes().1).unwrap();
    let neck = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "HOUSING.NECK")
        .expect("HOUSING.NECK");
    let l = joined.network.cell_layout[neck];
    let sc = joined.scales();
    let p = y[l.base] * sc[l.base];
    let sat = If97
        .saturation_caloric(Scalar::constant(p))
        .expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let mg = 2.;
    let ml = (joined.network.volume(neck) - mg / rg) * rf;
    let (m0, e0, m1, e1) = (l.mass[0], l.energy[0], l.mass[1], l.energy[1]);
    joined.network.birth(neck, &mut y).expect("birth");
    y[m0] = (ml + mg) / sc[m0];
    y[e0] = (ml * uf + mg * ug) / sc[e0];
    y[m1] = mg / sc[m1];
    y[e1] = mg * ug / sc[e1];
    joined.activate_unilateral(0., &y).expect("L1");
    joined.activate_phase_modes().expect("phase modes");
    // The mode slots precede a composed spray path's three slots (its inlet
    // check and its port's two scoped-L1 paths, last).
    let slot = |joined: &leitbild_operating_plant::joined::operator::Joined<If97>, k: usize| {
        joined.root_count()
            - 3 * usize::from(joined.network.spray().is_some())
            - 2 * joined.network.pzr.cell
            + 2 * neck
            + k
    };
    let others = |a: &[f64], b: &[f64]| {
        a.iter()
            .zip(b)
            .enumerate()
            .filter(|(i, (x, y))| ![m1, e1].contains(i) && x.to_bits() != y.to_bits())
            .map(|(i, _)| i)
            .collect::<Vec<_>>()
    };
    // Exhaustion.
    let before = y.clone();
    let mut directions = vec![0; joined.root_count()];
    directions[slot(&joined, 0)] = -1;
    let done = joined
        .transact(0., &directions, &mut y)
        .expect("exhaustion");
    assert_eq!(joined.network.cell_modes()[neck], CellMode::Liquid);
    assert_eq!((y[m1], y[e1]), (0., 0.));
    let moved = others(&before, &y);
    assert!(
        moved
            .iter()
            .all(|i| joined.network.face_layout.iter().any(|f| f.index == *i)),
        "only L1 impulses may move besides the vapor slots: {moved:?}"
    );
    // Birth.
    let before = y.clone();
    let mut directions = vec![0; joined.root_count()];
    directions[slot(&joined, 0)] = 1;
    let born = joined.transact(0., &directions, &mut y).expect("birth");
    assert_eq!(joined.network.cell_modes()[neck], CellMode::Equilibrium);
    assert_eq!(
        before.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        y.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        "a birth moves no stock"
    );
    // Dryout refuses.
    let mut directions = vec![0; joined.root_count()];
    directions[slot(&joined, 1)] = -1;
    let refused = joined.transact(0., &directions, &mut y).unwrap_err();
    assert!(format!("{refused:?}").contains("mode G"), "{refused:?}");
    println!(
        "{}",
        serde_json::json!({"exhaustion": done.iter().map(|t| t.receipt.clone()).collect::<Vec<_>>(),
            "birth": born.iter().map(|t| t.receipt.clone()).collect::<Vec<_>>(),
            "dryout": format!("{refused:?}")})
    );
}

/// S3-D19 (lead): every owner's discrete state is serialized. Every owner
/// the joined operator composes (its layouts) has an entry in
/// `Joined::discrete_state`, so a new owner without one fails here; and a
/// unit driven into non-default discrete state by its owners' own commands
/// and transactions (stuck cluster, acquired turbine trip, holding loss and
/// its releases, a heater control frame, a relief crack, a phase birth, L1
/// locks) restores into a freshly composed operator with the same snapshot,
/// root count, identity, root directions, next time event, residual rows
/// and root values, bit for bit. A discrete state left out of the snapshot
/// shows as a difference.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn every_owners_discrete_state_survives_a_snapshot() {
    use leitbild_operating_plant::{control::pzr_pressure::Demand, joined::block::Command};
    let (
        Started {
            mut joined,
            mut y,
            yp,
            network_ids,
            ..
        },
        _,
    ) = started_s3_phase_composition(&common::spine()).expect("the S3 phase composition");
    for (owner, _) in joined.layouts() {
        assert!(
            joined.discrete_state().get(owner).is_some(),
            "S3-D19: owner {owner} has no discrete-state entry"
        );
    }
    // Non-default discrete state through the owners' own interfaces.
    // HOOK (OU-C P2): a stuck cluster must be kept singly at composition
    // (it shares its bores' water otherwise), so this composition refuses it;
    // the holding loss below still gives the rods a non-default state.
    assert!(
        joined
            .command(0.1, &mut y, Command::StuckCluster { cluster: 0 })
            .is_err(),
        "a grouped cluster cannot be stuck"
    );
    joined
        .command(0.1, &mut y, Command::TurbineTripAcquired)
        .expect("acquired turbine trip");
    joined
        .command(0.2, &mut y, Command::HoldingLoss)
        .expect("holding loss");
    // ELEC's S3-D12 feed gate (a held input of the SG owner), declared
    // (S3-D27) in both compositions.
    joined.declare_feed_gate().expect("the feed gate");
    joined
        .secondary_mut()
        .unwrap()
        .set_feed_supported(false)
        .expect("the feed gate");
    // C3's initiator: the network's rotor state, no coordinate moved.
    let lost = common::s1_gates()["supplyLoss"]["rotor"].as_u64().unwrap() as usize;
    let unmoved = y.clone();
    joined
        .command(0.2, &mut y, Command::SupplyLoss { rotor: lost })
        .expect("RCP supply loss");
    assert_eq!(
        unmoved.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        y.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        "a supply loss moves no coordinate"
    );
    let request = 0.5 * joined.pzr().request_w();
    joined
        .pzr_mut()
        .apply_control(
            0.2,
            &Demand {
                heater_request_w: request,
                spray_target: 0.,
            },
        )
        .expect("a heater control frame");
    // SG.A's first relief valve cracks (its first root, rising).
    let mut directions = vec![0; joined.root_count()];
    directions[0] = 1;
    joined
        .transact(0.2, &directions, &mut y)
        .expect("a relief crack");
    // A phase birth at HOUSING.NECK (its vapor slots are zero).
    let packet: Value = serde_json::from_slice(&common::packet_bytes().1).unwrap();
    let neck = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "HOUSING.NECK")
        .unwrap();
    joined.network.birth(neck, &mut y).expect("birth");
    let snapshot = joined.discrete_state();
    // A fresh composition of the same packet takes the snapshot.
    let mut fresh = started_full_composition(&common::spine())
        .expect("the S2 composition")
        .joined;
    fresh.declare_feed_gate().expect("the feed gate");
    fresh
        .restore_discrete_state(&snapshot)
        .expect("restore into a fresh composition");
    assert_eq!(fresh.discrete_state(), snapshot, "round trip");
    assert_eq!(fresh.root_count(), joined.root_count());
    assert_eq!(
        fresh.differential(&network_ids),
        joined.differential(&network_ids)
    );
    assert_eq!(
        fresh.root_directions().unwrap(),
        joined.root_directions().unwrap()
    );
    assert_eq!(fresh.next_time_event(0.2), joined.next_time_event(0.2));
    let t = 0.2;
    joined.evaluate(t, &y, &yp, None, 0., None).unwrap();
    fresh.evaluate(t, &y, &yp, None, 0., None).unwrap();
    let bits = |j: &leitbild_operating_plant::joined::operator::Joined<If97>| {
        j.rows()
            .iter()
            .map(|r| r.value.to_bits())
            .collect::<Vec<_>>()
    };
    assert_eq!(bits(&fresh), bits(&joined), "residual rows");
    let (mut a, mut b) = (vec![0.; joined.root_count()], vec![0.; fresh.root_count()]);
    joined.roots(t, &y, &yp, &mut a).unwrap();
    fresh.roots(t, &y, &yp, &mut b).unwrap();
    assert_eq!(
        a.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        b.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        "root values"
    );
    println!("{}", serde_json::json!({"snapshot": snapshot}));
}

/// C3 on the joined spine (R3 lane's hand-over): the RCP supply loss is a
/// class-R command through the frame driver (`Joined::command` sets the
/// rotor unsupported with its shaft free, then `discrete_restart`); the
/// driver counts the network's donor flips (E2b: exact donor by flow sign)
/// and the accepted states inside R3's rod-passage band at every accepted
/// step, as class-O kinds. At power no cluster's annulus current is inside
/// R3's band. The frame period is the IC section's (`LD01_IC_SECTION`).
#[test]
#[ignore = "requires the joined packet, the wiki, the ic section, IF97 and stock IDA/KLU"]
fn an_rcp_supply_loss_restarts_through_the_frame_driver_with_c3s_cost_lines() {
    use leitbild_operating_plant::{
        ic::packet::Section,
        joined::block::Command,
        rotor::{Shaft, Support},
    };
    use leitbild_operating_water::frame::{Class, Client, Diagnostic, Driver, Frame, Setup};
    let section_path = std::env::var("LD01_IC_SECTION").expect("LD01_IC_SECTION");
    let section: Section = serde_json::from_slice(&std::fs::read(&section_path).expect("section"))
        .expect("ic section");
    let (
        Started {
            mut joined,
            mut y,
            mut yp,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        },
        derived,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    let lost = common::s1_gates()["supplyLoss"]["rotor"].as_u64().unwrap() as usize;
    assert!(matches!(
        joined.network.rotor_state(lost).unwrap().support,
        Support::Supported(_)
    ));
    assert_eq!(joined.r3_band_clusters(&y, &yp).unwrap(), 0, "at power");
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let nonnegative = joined.network.nonnegative_stocks();
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).expect("integrable"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    ida.set_max_step(0.02).unwrap();
    let frame = Frame::new(section.frame_s).unwrap();
    let mut driver = Driver::new(frame, Diagnostic::None, process_cpu_s, 0.).unwrap();
    // The driver's event mechanics on stock IDA/KLU (plain IDA builds);
    // MR-1's forced rebuild is guarded in tests/matrix_rebuild.rs.
    driver.matrix_rebuild = leitbild_operating_water::frame::MatrixRebuild::Stock;
    let t_loss = 0.0537; // a non-integer instant, as C3's t0
    driver
        .command(t_loss, Command::SupplyLoss { rotor: lost })
        .unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let until = 0.3;
    let mut clients: Vec<&mut dyn Client<Integrated<If97>>> = Vec::new();
    driver.start(&mut clients, 0., &y, &yp).unwrap();
    driver
        .run(&mut ida, 0., until, &mut y, &mut yp, &mut clients, &setup)
        .expect("C3's initiator through the frame driver");
    driver.close_segment(&ida, until).unwrap();
    let joined = &ida.system().joined;
    let state = joined.network.rotor_state(lost).unwrap();
    assert_eq!(
        (state.support, state.shaft),
        (Support::Unsupported, Shaft::Free)
    );
    let instant = driver
        .log
        .iter()
        .find(|e| e["class"] == "R" && e["t_s"].as_f64() == Some(t_loss))
        .expect("the supply loss's class-R instant");
    assert!(
        instant["restart"]["transactions"]
            .to_string()
            .contains("SupplyLoss"),
        "{instant}"
    );
    // Beside the supply loss, only a composed spray port's scoped L1
    // (DR-P3-SPRAY) restarts, at its located roots.
    let port: Vec<&Value> = driver
        .log
        .iter()
        .filter(|e| e["class"] == "R" && e["t_s"].as_f64() != Some(t_loss))
        .collect();
    assert!(
        port.iter().all(|e| e["restart"]["transactions"]
            .to_string()
            .contains("spray port (scoped L1)")),
        "{port:?}"
    );
    assert_eq!(driver.counts.total(Class::R), 1 + port.len() as u64);
    assert!(driver.observed_states > 0);
    assert_eq!(
        driver.donor_flips.observations as u64,
        driver.observed_states
    );
    assert_eq!(
        driver.counts.get(Class::O, "donor flip"),
        driver.donor_flips.total() as u64
    );
    assert_eq!(driver.r3_band_states, 0, "no rod passage inside R3's band");
    assert_eq!(driver.counts.get(Class::O, "R3 band state"), 0);
    println!(
        "{}",
        serde_json::json!({"rotor": lost, "t_loss_s": t_loss, "until_s": until,
            "observation": driver.observation_json(), "counts": driver.counts.json(),
            "instant": instant, "segments": driver.segments})
    );
}

/// TEST-ONLY: stops at every frame as the PZR controller does (class S)
/// and records each frame's index, instant and the dense interval it was
/// read on (reading the state there).
struct FrameProbe {
    n: usize,
    seen: Vec<(u64, f64, (f64, f64))>,
}
impl leitbild_operating_water::frame::Client<Integrated<If97>> for FrameProbe {
    fn name(&self) -> &str {
        "TEST-ONLY frame probe"
    }
    fn advance(
        &mut self,
        _: &dyn leitbild_operating_water::frame::Dense,
        _: f64,
        _: f64,
    ) -> Result<(), String> {
        Ok(())
    }
    fn frame(
        &mut self,
        k: u64,
        t: f64,
        dense: &dyn leitbild_operating_water::frame::Dense,
    ) -> Result<Vec<leitbild_operating_water::frame::Change<Integrated<If97>>>, String> {
        let mut y = vec![0.; self.n];
        dense.derivative(t, 0, &mut y)?;
        self.seen.push((k, t, dense.interval()));
        Ok(Vec::new())
    }
    fn stop_at_frame(&self, _: u64) -> bool {
        true
    }
}

/// One driven run for [`an_owner_time_event_on_a_frame_instant_is_one_instant`]:
/// the acquired turbine trip at frame `command_frame`, then frame by frame
/// to two frames past `event_frame`, each chunk started from the previous
/// chunk's bound as the S3 cases' harness does.
fn coincident_event_run(command_frame: u64, event_frame: u64) -> Value {
    use leitbild_operating_plant::joined::block::Command;
    use leitbild_operating_water::frame::{Class, Client, Diagnostic, Driver, Frame, Setup};
    let (
        Started {
            joined,
            mut y,
            mut yp,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        },
        derived,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let nonnegative = joined.network.nonnegative_stocks();
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).expect("integrable"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    ida.set_max_step(0.02).unwrap();
    let frame = Frame::new(0.1).unwrap();
    let mut driver = Driver::new(frame, Diagnostic::None, process_cpu_s, 0.).unwrap();
    // The driver's event mechanics on stock IDA/KLU (plain IDA builds);
    // MR-1's forced rebuild is guarded in tests/matrix_rebuild.rs.
    driver.matrix_rebuild = leitbild_operating_water::frame::MatrixRebuild::Stock;
    let t_command = frame.instant(command_frame);
    driver
        .command(t_command, Command::TurbineTripAcquired)
        .unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let mut probe = FrameProbe {
        n: y.len(),
        seen: Vec::new(),
    };
    let mut outcome = {
        let mut clients: Vec<&mut dyn Client<Integrated<If97>>> = vec![&mut probe];
        driver.start(&mut clients, 0., &y, &yp)
    };
    let mut t = 0.;
    for k in 1..=event_frame + 2 {
        if outcome.is_err() {
            break;
        }
        let bound = frame.instant(k);
        let mut clients: Vec<&mut dyn Client<Integrated<If97>>> = vec![&mut probe];
        outcome = driver
            .run(&mut ida, t, bound, &mut y, &mut yp, &mut clients, &setup)
            .map(|_| ());
        t = bound;
    }
    let event: Vec<Value> = driver
        .log
        .iter()
        .filter(|e| e["kinds"].to_string().contains("owner time event"))
        .cloned()
        .collect();
    serde_json::json!({"command_frame": command_frame, "t_command_s": t_command,
        "event_frame": event_frame, "frame_instant_s": frame.instant(event_frame),
        "outcome": outcome.err(), "solver_reached_s": driver.solver_reached_s,
        "r": driver.counts.total(Class::R), "s": driver.counts.total(Class::S),
        "owner_event_instants": event, "log": driver.log,
        "frames": probe.seen.iter().map(|(k, t, (a, b))| serde_json::json!([k, t, a, b])).collect::<Vec<_>>()})
}

/// DR (GATE's C3 preview at 1e581c97, IDA_ILL_INPUT at +22.43 s): an owner
/// time event that falls on a frame instant is one instant. The acquired
/// turbine trip on a frame instant ends its STOP ramp 0.3 s later; by the
/// same arithmetic as C3's 580.5 + 0.3 against 5808 · 0.1, the ramp end at
/// 0.4 + 0.3 lies one ulp before frame 7's 7 · 0.1, and at
/// 0.6000000000000001 + 0.3 one ulp after frame 9's 9 · 0.1. Driven frame by
/// frame with a client stopping at every frame (the PZR controller's S
/// stops), each run completes; the ramp end restarts once, at the owner's
/// own time; the coinciding frame is observed once, on the step that ends
/// at that instant (the plant's left limit, before the change); every frame
/// is observed exactly once.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn an_owner_time_event_on_a_frame_instant_is_one_instant() {
    let runs: Vec<Value> = [(4, 7), (6, 9)]
        .into_iter()
        .map(|(c, e)| coincident_event_run(c, e))
        .collect();
    for r in &runs {
        println!(
            "{}",
            serde_json::json!({"command_frame": r["command_frame"], "t_command_s": r["t_command_s"],
            "frame_instant_s": r["frame_instant_s"], "outcome": r["outcome"], "solver_reached_s": r["solver_reached_s"],
            "r": r["r"], "s": r["s"], "r_instants": r["log"].as_array().unwrap().iter()
                .filter(|e| e["class"] == "R").map(|e| serde_json::json!([e["t_s"], e["kinds"]])).collect::<Vec<_>>(),
            "owner_event_instants": r["owner_event_instants"],
            "frames": r["frames"]})
        );
    }
    for r in &runs {
        assert!(r["outcome"].is_null(), "the run stops: {}", r["outcome"]);
        let instants = r["owner_event_instants"].as_array().unwrap();
        assert_eq!(
            instants.len(),
            1,
            "one owner time event instant: {instants:?}"
        );
        let receipt = instants[0]["restart"]["transactions"].to_string();
        assert!(receipt.contains("STOP ramp end"), "{receipt}");
        let e = instants[0]["t_s"].as_f64().unwrap();
        let f = r["frame_instant_s"].as_f64().unwrap();
        let ulps = (e - f).abs() / (f64::EPSILON * f);
        assert!(
            e != f && ulps <= 2.,
            "the ramp end {e} s and the frame {f} s are one ulp apart"
        );
        let frames = r["frames"].as_array().unwrap();
        let k_event = r["event_frame"].as_u64().unwrap();
        let ks: Vec<u64> = frames.iter().map(|x| x[0].as_u64().unwrap()).collect();
        let expected: Vec<u64> = (0..=k_event + 2).collect();
        assert_eq!(ks, expected, "every frame observed exactly once");
        let at: Vec<&Value> = frames
            .iter()
            .filter(|x| x[0].as_u64() == Some(k_event))
            .collect();
        // Read on the step ending at the instant: before its restart.
        assert_eq!(
            at[0][3].as_f64(),
            Some(e),
            "frame {k_event} read on {:?}",
            at[0]
        );
    }
}

/// TEST-ONLY: reads every frame and never asks a stop (R4-FREE-STEPS).
struct FreeProbe {
    n: usize,
    seen: Vec<(u64, f64)>,
}
impl leitbild_operating_water::frame::Client<Integrated<If97>> for FreeProbe {
    fn name(&self) -> &str {
        "TEST-ONLY free frame probe"
    }
    fn advance(
        &mut self,
        _: &dyn leitbild_operating_water::frame::Dense,
        _: f64,
        _: f64,
    ) -> Result<(), String> {
        Ok(())
    }
    fn frame(
        &mut self,
        k: u64,
        t: f64,
        dense: &dyn leitbild_operating_water::frame::Dense,
    ) -> Result<Vec<leitbild_operating_water::frame::Change<Integrated<If97>>>, String> {
        let mut y = vec![0.; self.n];
        dense.derivative(t, 0, &mut y)?;
        self.seen.push((k, t));
        Ok(Vec::new())
    }
}

/// R4-FREE-STEPS (lead 1 Nov, input latency): under free stepping a run
/// ends with the integrator possibly past its bound. An operator trip
/// declared at that bound (the next frame boundary when it arrives) acts at
/// exactly that boundary: the driver restarts there from the last step's
/// dense output, and the R instant names the command and the integrator's
/// time it rolled back from.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn an_operator_trip_behind_a_free_step_acts_at_its_frame_boundary() {
    use leitbild_operating_plant::joined::block::Command;
    use leitbild_operating_water::frame::{
        Class, Client, Diagnostic, Driver, Frame, Setup, Stepping,
    };
    let (
        Started {
            joined,
            mut y,
            mut yp,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        },
        derived,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let nonnegative = joined.network.nonnegative_stocks();
    let mut ida = Ida::new(
        Integrated::from_blocks(joined, structure, analyses).expect("integrable"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    let frame = Frame::new(0.1).unwrap();
    let mut driver = Driver::new(frame, Diagnostic::None, process_cpu_s, 0.).unwrap();
    driver.matrix_rebuild = leitbild_operating_water::frame::MatrixRebuild::Stock;
    driver.stepping = Stepping::Free;
    let last = 40;
    driver.declare_stop(frame.instant(last)).unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let mut probe = FreeProbe {
        n: y.len(),
        seen: Vec::new(),
    };
    {
        let mut clients: Vec<&mut dyn Client<Integrated<If97>>> = vec![&mut probe];
        driver.start(&mut clients, 0., &y, &yp).unwrap();
    }
    let mut t = 0.;
    let mut boundary: Option<(f64, f64)> = None;
    for k in 1..=last {
        let bound = frame.instant(k);
        let mut clients: Vec<&mut dyn Client<Integrated<If97>>> = vec![&mut probe];
        driver
            .run(&mut ida, t, bound, &mut y, &mut yp, &mut clients, &setup)
            .unwrap_or_else(|e| panic!("run to {bound} s: {e}"));
        t = bound;
        if boundary.is_none() && driver.integrator_s() > bound {
            // The trip arrives now: it acts at this frame boundary, which
            // the integrator has already passed.
            boundary = Some((bound, driver.integrator_s()));
            driver.command(bound, Command::TurbineTripAcquired).unwrap();
        }
    }
    let (at, integrator) = boundary.expect("a free step ran past a frame boundary");
    let trip: Vec<&Value> = driver
        .log
        .iter()
        .filter(|e| e["kinds"].to_string().contains("TurbineTripAcquired"))
        .collect();
    println!(
        "{}",
        serde_json::json!({"boundary_s": at, "integrator_s": integrator, "trip": trip,
            "r": driver.counts.total(Class::R), "frames": probe.seen.len()})
    );
    assert_eq!(trip.len(), 1, "one trip instant: {trip:?}");
    assert_eq!(trip[0]["class"], "R");
    assert_eq!(
        trip[0]["t_s"].as_f64().map(f64::to_bits),
        Some(at.to_bits()),
        "the trip acts at exactly its frame boundary"
    );
    assert_eq!(
        trip[0]["rolled_back_from_s"].as_f64().map(f64::to_bits),
        Some(integrator.to_bits()),
        "from the last step's dense output, behind the integrator"
    );
    let ks: Vec<u64> = probe.seen.iter().map(|(k, _)| *k).collect();
    assert_eq!(ks, (0..=last).collect::<Vec<u64>>(), "every frame observed exactly once");
}

/// The block Jacobian at `(0, y, 0)` against the colored one: the worst
/// entry difference over its column's scale (a colored entry outside the
/// block pattern counts whole), where it is, and the block structure with
/// its values. The block assembly itself refuses an entry outside its
/// pattern.
fn blocks_against_colored(
    joined: &mut leitbild_operating_plant::joined::operator::Joined<If97>,
    y: &[f64],
) -> (f64, Value, JoinedJacobian, Vec<f64>) {
    let n = y.len();
    let structure = JoinedJacobian::compile_for(joined, 0., y, None).expect("structure");
    let zero = vec![0.; n];
    let cj = 20.;
    let mut bv = vec![0.; structure.pattern.nonzeros()];
    jacobian_blocks(joined, &structure, 0., cj, y, &zero, &mut bv, Classes::ALL)
        .expect("joined block assembly");
    let colored = joined.structure().unwrap().0.clone();
    let mut cv = vec![0.; colored.nonzeros()];
    joined
        .jacobian(0., cj, y, &zero, &mut cv)
        .expect("joined colored assembly");
    let (mut worst, mut at) = (0_f64, serde_json::json!(null));
    for j in 0..n {
        let b = structure.pattern.pointers()[j]..structure.pattern.pointers()[j + 1];
        let c = colored.pointers()[j]..colored.pointers()[j + 1];
        let scale = b
            .clone()
            .map(|q| bv[q].abs())
            .chain(c.clone().map(|q| cv[q].abs()))
            .fold(0., f64::max);
        if scale == 0. {
            continue;
        }
        for q in b {
            let row = structure.pattern.indices()[q];
            let other = colored.position(row, j).map_or(0., |k| cv[k]);
            let e = (bv[q] - other).abs() / scale;
            if e > worst {
                (worst, at) = (
                    e,
                    serde_json::json!({"row": row, "column": j, "blocks": bv[q], "colored": other}),
                );
            }
        }
        for q in c {
            let row = colored.indices()[q];
            if structure.pattern.position(row, j).is_none() && cv[q] != 0. {
                (worst, at) = (
                    f64::INFINITY,
                    serde_json::json!({"row": row, "column": j, "blocks": null, "colored": cv[q]}),
                );
            }
        }
    }
    (worst, at, structure, bv)
}

/// S3-D27 (lead): with the S3-D12 feed gate declared, the SG owner's mass
/// rows read the pressure and the relief lifts, so at a gate-closed relief
/// state (SG.A's first relief cracked and lifted) the block Jacobian lies
/// inside the pattern and matches the colored one, and the new entries are
/// structural zeros while the gate is open. Undeclared (S1/S2), the gate
/// refuses to close and the structure is unchanged.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97 and stock IDA/KLU"]
fn a_declared_feed_gate_covers_the_closed_gate_at_a_relief_state() {
    let Started {
        mut joined, mut y, ..
    } = started_full_composition(&common::spine()).expect("the S2 composition");
    assert!(
        joined
            .secondary_mut()
            .unwrap()
            .set_feed_supported(false)
            .is_err(),
        "an undeclared gate does not close"
    );
    let undeclared = joined.structure().unwrap().0.nonzeros();
    joined.declare_feed_gate().expect("the feed gate");
    let declared = joined.structure().unwrap().0.nonzeros();
    let labels: Vec<String> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.labels)
        .collect();
    let at = |label: &str| {
        labels
            .iter()
            .position(|l| l == label)
            .unwrap_or_else(|| panic!("{label}"))
    };
    let (m, p) = (at("SG.A.M_s"), at("SG.A.p_s"));
    let lift = (p..labels.len())
        .find(|i| labels[*i].ends_with(".lift"))
        .expect("SG.A's first relief lift");
    let entry = |s: &JoinedJacobian, v: &[f64], row: usize, column: usize| {
        s.pattern
            .position(row, column)
            .map(|q| v[q])
            .expect("a declared entry")
    };
    // Gate open: the mass row's pressure and lift entries are structural zeros.
    let (open_worst, open_at, s, v) = blocks_against_colored(&mut joined, &y);
    assert_eq!(
        (entry(&s, &v, m, p), entry(&s, &v, m, lift)),
        (0., 0.),
        "F3 (a)'s cancellation is exact with the gate open"
    );
    assert!(open_worst < 1e-12, "{open_worst} at {open_at}");
    // Gate closed, SG.A's first relief cracked and half lifted.
    joined
        .secondary_mut()
        .unwrap()
        .set_feed_supported(false)
        .expect("the declared gate closes");
    let mut directions = vec![0; joined.root_count()];
    directions[0] = 1;
    joined
        .transact(0., &directions, &mut y)
        .expect("SG.A's first relief cracks");
    y[lift] = 0.5 / joined.scales()[lift];
    let (closed_worst, closed_at, s, v) = blocks_against_colored(&mut joined, &y);
    let (dp, dl) = (entry(&s, &v, m, p), entry(&s, &v, m, lift));
    assert!(
        dp != 0. && dl != 0.,
        "the closed gate's mass row reads p and the lift"
    );
    assert!(closed_worst < 1e-12, "{closed_worst} at {closed_at}");
    println!(
        "{}",
        serde_json::json!({"colored_nonzeros": {"undeclared": undeclared, "declared": declared},
            "open": {"worst": open_worst}, "closed": {"worst": closed_worst, "at": closed_at,
            "mass_row_dp": dp, "mass_row_dlift": dl}})
    );
}

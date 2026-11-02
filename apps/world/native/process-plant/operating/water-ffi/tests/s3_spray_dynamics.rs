//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray path in motion (NOT-EVIDENCE check for KERN): from
//! the zero-time joined composition of a packet with the spray path, after
//! a quiet second the controlled stem is issued 0.5 (opening a closed valve:
//! its lock releases, class R, `discrete_restart`); it travels at its rate
//! and arrives (class S: an exact stop, history continued); at +3 s it is
//! issued 0 and its arrival at 0 locks the valve path again (an owner time
//! event, class R). The valve is the quasi-steady restriction and the inlet
//! check its root-located lock (lead decision S3-D25). Recorded every 0.1 s: the
//! stem, the valve and port faces' liquid mass flows, the roof pressure,
//! the line pressure and the primary water mass (regular cells and the PZR
//! cell's stocks).
//!
//! Environment: the joined spine's, with `LD01_OPERATING_HOT_SPINE_PACKET`
//! the spray packet; optionally `LD01_SPRAY_DYNAMICS_RECEIPT`.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;
use leitbild_operating_water::unit::{
    clock::process_cpu_s,
    profile::{DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT},
    spine::{Started, started_s3_composition},
};

use leitbild_operating_plant::{
    control::{pzr_pressure::Demand, spray_valve::StemChange},
    network::{PZR_MASS, stratified},
};
use leitbild_operating_water::{
    ida::{Advance, Ida, Initial},
    joined::{Discrete, Integrated, Restart, discrete_restart},
};
use serde_json::json;

#[test]
#[ignore = "NOT-EVIDENCE check: requires the spray packet, the wiki, IF97 and stock IDA/KLU"]
fn the_spray_valve_opens_delivers_and_closes_on_its_locks() {
    let receipt_path = std::env::var_os("LD01_SPRAY_DYNAMICS_RECEIPT");
    if let Some(p) = &receipt_path {
        assert!(
            !std::path::Path::new(p).exists(),
            "receipts are never overwritten"
        );
    }
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
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
        _derived,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    let spray = *joined.network.spray().expect("a spray packet");
    let heater = joined.pzr().request_w();
    let nonnegative = joined.network.nonnegative_stocks();
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
    ida.set_max_order(2).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    let started = process_cpu_s();
    let observe = |ida: &mut Ida<Integrated<leitbild_operating_water::If97>>,
                   t: f64,
                   y: &[f64],
                   yp: &[f64]| {
        let joined = &mut ida.system_mut().joined;
        joined.evaluate(t, y, yp, None, 0., None).unwrap();
        let net = &joined.network;
        let s = net.scales();
        let flow = |face: usize| {
            net.chart(face, 0)
                .map_or(f64::NAN, |c| c.mass_flow_kg_s.value)
        };
        let l = net.cell_layout[spray.region];
        let mut water = 0.;
        for c in &net.cell_layout {
            water += y[c.mass[0]] * s[c.mass[0]] + y[c.mass[1]] * s[c.mass[1]];
        }
        for o in PZR_MASS {
            let i = net.pzr.base + o;
            water += y[i] * s[i];
        }
        let stem = net.spray().map(|sp| sp.stem.position(t).unwrap()).unwrap();
        json!([
            t,
            stem,
            flow(spray.valve_face),
            flow(spray.port_face),
            y[net.pzr.base + stratified::ROOF_PRESSURE]
                * s[net.pzr.base + stratified::ROOF_PRESSURE],
            y[l.base] * s[l.base],
            water
        ])
    };
    let mut rows = vec![observe(&mut ida, 0., &y, &yp)];
    let mut events = Vec::new();
    let end: f64 = 5.;
    let mut sample_k = 1u32;
    let mut next_sample = 0.1;
    let mut t = 0.;
    // Instants: open at 1 s, close-issue at 4 s; the stem's arrivals follow.
    // Open to 0.5 at 1 s, close at 3 s (the arrival at 4 s locks the path).
    let mut issues = vec![(1., 0.5), (3., 0.)];
    while t < end - 1e-12 {
        let joined = &ida.system().joined;
        let mut stop = end.min(next_sample);
        if let Some((ti, _)) = issues.first() {
            stop = stop.min(*ti);
        }
        // Every stem arrival is an exact stop: R when it closes (owner time
        // event), S otherwise.
        if let Some((a, _)) = joined.network.spray_next_instant(t) {
            stop = stop.min(a);
        }
        ida.stop_at(stop).unwrap();
        let advanced = ida.advance(stop, &mut y, &mut yp);
        if let Err(e) = &advanced {
            panic!("advance from {t} to {stop} failed: {e}; events {events:?}");
        }
        t = match advanced.unwrap() {
            Advance::Reached(r) => r,
            Advance::Root { time, directions } => {
                // The inlet check (the last slot) or any owner's root: R.
                let r = discrete_restart(
                    &mut ida,
                    time,
                    Discrete::Roots(&directions),
                    &mut y,
                    &network_ids,
                    &atol,
                    rtol,
                    &restart,
                )
                .unwrap();
                yp.clone_from(&r.yp);
                events.push(json!({"t_s": time, "event": "located root", "class": "R",
                    "transactions": r.transactions.iter().map(|x| x.receipt.clone()).collect::<Vec<_>>()}));
                t = time;
                continue;
            }
        };
        assert_eq!(t, stop, "stopped exactly");
        if issues.first().is_some_and(|(ti, _)| *ti == t) {
            let (_, target) = issues.remove(0);
            let demand = Demand {
                heater_request_w: heater,
                spray_target: target,
            };
            let (change, receipts) = ida
                .system_mut()
                .joined
                .apply_pzr_control(t, &demand)
                .unwrap();
            if change == StemChange::Lock {
                let r = discrete_restart(
                    &mut ida,
                    t,
                    Discrete::TimeEvent,
                    &mut y,
                    &network_ids,
                    &atol,
                    rtol,
                    &restart,
                )
                .unwrap();
                yp.clone_from(&r.yp);
            }
            events.push(json!({"t_s": t, "issue": target, "class": if change == StemChange::Lock { "R" } else { "S" }, "receipts": receipts}));
        } else if ida
            .system()
            .joined
            .next_time_event(t - 1e-12)
            .is_some_and(|e| e == t)
        {
            // The stem's closing arrival: the owners' time event locks it.
            let r = discrete_restart(
                &mut ida,
                t,
                Discrete::TimeEvent,
                &mut y,
                &network_ids,
                &atol,
                rtol,
                &restart,
            )
            .unwrap();
            yp.clone_from(&r.yp);
            events.push(json!({"t_s": t, "event": "closing arrival", "class": "R",
                "transactions": r.transactions.iter().map(|x| x.receipt.clone()).collect::<Vec<_>>()}));
        }
        // Every stop is at or before the next 0.1 s sample, so at most that
        // one sample is due here (an observation schedule, not an iteration).
        if t >= next_sample - 1e-9 {
            if t >= next_sample - 1e-12 {
                rows.push(observe(&mut ida, t, &y, &yp));
            }
            sample_k += 1;
            next_sample = f64::from(sample_k) / 10.;
        }
    }
    let cpu = process_cpu_s() - started;
    let sp = *ida.system().joined.network.spray().unwrap();
    let closed = sp.closed;
    let receipt = json!({"kind": "s3-spray-path-dynamics", "status": "NOT-EVIDENCE",
        "provenance": common::spine_provenance(), "heater_request_w": heater, "cpu_s": cpu,
        "columns": ["t_s", "stem", "valve_face_kg_s", "port_face_kg_s", "roof_pa", "line_pa", "primary_water_kg"],
        "events": events, "rows": rows, "valve_closed_at_end": closed, "check_closed_at_end": sp.check_closed});
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Some(p) = &receipt_path {
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
    assert!(
        closed || sp.check_closed,
        "the valve path ends locked (closing arrival or the check's contact)"
    );
}

/// The S2-07 settled hold with and without the closed spray path, 20 s from
/// the same instant: the original packet's settled state, and the same
/// state embedded in the spray packet's operator with the line at COLD.A's
/// settled specific state (its own consistent start places it), on the
/// block assembly with S2-D24's derived classes, S2's restart configuration
/// and order 2. Recorded every 0.1 s: the roof pressure, both SG pressures,
/// both main-loop impulses and the line's two face flows. The original's
/// observables may change only through the line (NOT-EVIDENCE, for KERN's
/// S2 re-settle). Environment: `LD01_ORIGINAL_PACKET` (the original),
/// `LD01_OPERATING_HOT_SPINE_PACKET` (the spray packet), `LD01_C1_STATE`.
#[test]
#[ignore = "NOT-EVIDENCE check: requires both packets, a settled state, the wiki, IF97 and stock IDA/KLU"]
fn the_settled_hold_changes_only_through_the_closed_spray_line() {
    let original = std::env::var("LD01_ORIGINAL_PACKET").expect("LD01_ORIGINAL_PACKET");
    let spray_packet = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").expect("the spray packet");
    let state: serde_json::Value = serde_json::from_slice(
        &std::fs::read(std::env::var("LD01_C1_STATE").expect("LD01_C1_STATE")).unwrap(),
    )
    .unwrap();
    let vector = |k: &str| -> Vec<f64> {
        state[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let t0 = state["t_s"].as_f64().unwrap();
    // SAFETY: single-threaded test setup; the composition reads the packet
    // path from the environment.
    unsafe { std::env::set_var("LD01_OPERATING_HOT_SPINE_PACKET", &original) };
    let (old, _) = started_s3_composition(&common::spine()).expect("the S3 composition");
    unsafe { std::env::set_var("LD01_OPERATING_HOT_SPINE_PACKET", &spray_packet) };
    let (new, _) = started_s3_composition(&common::spine()).expect("the S3 composition");
    let (on, nw) = (&old.joined.network, &new.joined.network);
    let (n_old, n_new) = (old.joined.dimension(), new.joined.dimension());
    let no = old.joined.offsets().nuclear;
    let spray = *nw.spray().unwrap();
    let mut map = vec![usize::MAX; n_old];
    for (node, l) in on.cell_layout.iter().enumerate() {
        for k in 0..6 {
            map[l.base + k] = nw.cell_layout[node].base + k;
        }
    }
    for (a, b) in on.pzr.coordinates().zip(nw.pzr.coordinates()) {
        map[a] = b;
    }
    for (li, l) in on.face_layout.iter().enumerate() {
        map[l.index] = nw.face_layout[li].index;
    }
    for (r, i) in on.rotor_index.iter().enumerate() {
        map[*i] = nw.rotor_index[r];
    }
    for (i, m) in map.iter_mut().enumerate().skip(no) {
        *m = i + (n_new - n_old);
    }
    let (y_old, yp_old) = (vector("y"), vector("yp"));
    let mut y_new = vec![0.; n_new];
    let mut yp_new = vec![0.; n_new];
    for (i, j) in map.iter().enumerate() {
        y_new[*j] = y_old[i];
        yp_new[*j] = yp_old[i];
    }
    let regions: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&spray_packet).unwrap()).unwrap();
    let source = regions["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "COLD.A")
        .unwrap();
    let (so, sn) = (on.scales().to_vec(), nw.scales().to_vec());
    let (c, s) = (on.cell_layout[source], nw.cell_layout[spray.region]);
    // The line at rest below the settled roof: COLD.A's settled specific
    // energy and boron fraction, the pressure hydrostatic below the roof
    // with COLD.A's settled density (the composed preparation's own rule),
    // its mass from the property owner's density at that state.
    let phys = |i: usize| y_old[i] * so[i];
    let (m_c, u_c, b_c) = (phys(c.mass[0]), phys(c.energy[0]), phys(c.boron));
    let rho_c = m_c / on.volume(source);
    let roof = phys(on.pzr.base + stratified::ROOF_PRESSURE);
    let regions_line = &regions["mechanics"]["regions"][spray.region];
    let rise = regions["pzrSpray"]["line"]["outletElevation_m"]
        .as_f64()
        .unwrap()
        - regions_line["elevation_m"].as_f64().unwrap();
    let p_line = roof + rho_c * 9.80665 * rise;
    use leitbild_operating_plant::network::Properties;
    let q = leitbild_operating_water::If97
        .caloric(false, p_line, u_c / m_c, false)
        .unwrap();
    let rho_line = leitbild_operating_water::If97.values(&q).density_kg_m3;
    let m_line = rho_line * nw.volume(spray.region);
    for (to, v) in [
        (s.base, p_line),
        (s.mass[0], m_line),
        (s.energy[0], m_line * u_c / m_c),
        (s.boron, m_line * b_c / m_c),
    ] {
        y_new[to] = v / sn[to];
    }
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let span = 20.;
    let run = |s: Started,
               mut y: Vec<f64>,
               mut yp: Vec<f64>|
     -> (Vec<Vec<f64>>, serde_json::Value) {
        let Started {
            joined,
            ids,
            network_ids,
            atol,
            rtol,
            structure,
            analyses,
            ..
        } = s;
        let sg: Vec<(usize, f64)> = {
            let mut k = 0;
            let mut out = Vec::new();
            for (owner, layout) in joined.layouts() {
                for (i, label) in layout.labels.iter().enumerate() {
                    if owner == "secondary" && label.ends_with(".p_s") {
                        out.push((k, layout.scales[i]));
                    }
                    k += 1;
                }
            }
            out
        };
        let net = &joined.network;
        let roof = net.pzr.base + stratified::ROOF_PRESSURE;
        let roof_scale = net.scales()[roof];
        let loops: Vec<(usize, f64)> = [22usize, 30]
            .iter()
            .map(|f| {
                let l = net.face_layout[2 * f];
                (l.index, net.scales()[l.index])
            })
            .collect();
        let line = net.spray().map(|sp| {
            [sp.valve_face, sp.port_face].map(|f| {
                let l = net.face_layout[2 * f];
                (l.index, net.scales()[l.index])
            })
        });
        let nonnegative = net.nonnegative_stocks();
        let mut ida = Ida::new(
            Integrated::from_blocks(joined, structure, analyses).unwrap(),
            Initial {
                time: t0,
                y: &y,
                yp: &yp,
                differential: &ids,
                absolute_tolerance: &atol,
                relative_tolerance: rtol,
            },
        )
        .unwrap();
        ida.set_max_order(2).unwrap();
        ida.constrain_nonnegative(&nonnegative).unwrap();
        restart.configure(&mut ida).unwrap();
        let started = process_cpu_s();
        let r = discrete_restart(
            &mut ida,
            t0,
            Discrete::TimeEvent,
            &mut y,
            &network_ids,
            &atol,
            rtol,
            &restart,
        )
        .unwrap();
        yp.clone_from(&r.yp);
        let start = json!({"projection_passes": r.report.projection_passes, "correction_wrms": r.report.correction_wrms});
        let mut rows = Vec::new();
        let sample = |y: &[f64], t: f64| -> Vec<f64> {
            let mut v = vec![t, y[roof] * roof_scale];
            v.extend(sg.iter().map(|(i, s)| y[*i] * s));
            v.extend(loops.iter().map(|(i, s)| y[*i] * s));
            if let Some(l) = line {
                v.extend(l.iter().map(|(i, s)| y[*i] * s));
            }
            v
        };
        rows.push(sample(&y, t0));
        let end = t0 + span;
        ida.stop_at(end).unwrap();
        let mut t = t0;
        let mut k = 1;
        while t < end {
            let target = (t0 + 0.1 * k as f64).min(end);
            t = match ida.advance(target, &mut y, &mut yp).unwrap() {
                Advance::Reached(r) => r,
                Advance::Root { time, directions } => panic!("root at {time}: {directions:?}"),
            };
            rows.push(sample(&y, t));
            k += 1;
        }
        let stats = ida.stats().unwrap();
        let end_charts = {
            let joined = &mut ida.system_mut().joined;
            joined.evaluate(t, &y, &yp, None, 0., None).unwrap();
            let net = &joined.network;
            net.spray().map(|sp| {
                let l = net.cell_layout[sp.region];
                let sc = net.scales();
                let mut faces = Vec::new();
                for f in [sp.valve_face, sp.port_face] {
                    for k in 0..2 {
                        if let Some(c) = net.chart(f, k) {
                            faces.push(json!({"face": f, "phase": k, "mass_flow_kg_s": c.mass_flow_kg_s.value,
                                "volume_flow_m3_s": c.volume_flow_m3_s.value, "inertance": c.inertance_kg_m4.value,
                                "drive_pa": net.face_drive(f, k).value}));
                        }
                    }
                }
                json!({"line_pa": y[l.base] * sc[l.base], "line_mass_kg": y[l.mass[0]] * sc[l.mass[0]],
                    "line_mass_rate_kg_s": yp[l.mass[0]] * sc[l.mass[0]], "faces": faces})
            })
        };
        (
            rows,
            json!({"end_charts": end_charts, "cpu_s": process_cpu_s() - started, "steps": stats.steps, "jacobians": stats.jacobians,
                "error_test_failures": stats.error_failures, "start": start}),
        )
    };
    let (a, ca) = run(old, y_old, yp_old);
    let (b, cb) = run(new, y_new, yp_new);
    assert_eq!(a.len(), b.len());
    let names = [
        "roof_pa",
        "sg_a_pa",
        "sg_b_pa",
        "loop_a_impulse",
        "loop_b_impulse",
    ];
    let mut diff = serde_json::Map::new();
    for (j, name) in names.iter().enumerate() {
        let d = a
            .iter()
            .zip(&b)
            .map(|(x, y)| (x[j + 1] - y[j + 1]).abs())
            .fold(0., f64::max);
        diff.insert((*name).into(), json!(d));
    }
    let line_max = b
        .iter()
        .map(|r| r[6].abs().max(r[7].abs()))
        .fold(0., f64::max);
    let receipt = json!({"kind": "s3-spray-closed-settled-hold-comparison", "status": "NOT-EVIDENCE",
        "provenance": common::spine_provenance(), "t0_s": t0, "span_s": span,
        "max_abs_difference": diff, "line_impulse_max_pa_s": line_max,
        "line_impulses_end_pa_s": [b.last().unwrap()[6], b.last().unwrap()[7]],
        "original": ca, "with_spray_path": cb,
        "roof_end_pa": [a.last().unwrap()[1], b.last().unwrap()[1]],
        "series_every_second": {"columns": ["t_s", "roof_pa", "sg_a_pa", "sg_b_pa", "loop_a_impulse", "loop_b_impulse", "valve_face_impulse", "port_face_impulse"],
            "original": a.iter().step_by(10).collect::<Vec<_>>(), "with_spray_path": b.iter().step_by(10).collect::<Vec<_>>()}});
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Some(p) = std::env::var_os("LD01_SPRAY_HOLD_RECEIPT") {
        assert!(
            !std::path::Path::new(&p).exists(),
            "receipts are never overwritten"
        );
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
}

/// S3-D19 for the spray path (KERN): an operator whose spray valve a
/// control frame opened (its lock released, the stem travelling) restores
/// into a freshly composed operator with the same snapshot, root count,
/// identity, root directions, next time event, residual rows and root
/// values, bit for bit, while the stem still moves (the unrestored
/// operator's rows differ: lock against restriction); and again after the
/// inlet check closed at its located contact root (the unrestored
/// operator's roots and time events differ).
#[test]
#[ignore = "NOT-EVIDENCE check: requires the spray packet, the wiki, IF97 and stock IDA/KLU"]
fn the_spray_paths_discrete_state_survives_a_snapshot() {
    type Op = leitbild_operating_plant::joined::operator::Joined<leitbild_operating_water::If97>;
    let (
        Started {
            mut joined,
            mut y,
            yp,
            network_ids,
            ..
        },
        _,
    ) = started_s3_composition(&common::spine()).expect("the S3 composition");
    assert!(joined.network.spray().is_some(), "a spray packet");
    let t = 0.3;
    let state = |j: &mut Op, y: &[f64]| {
        j.evaluate(t, y, &yp, None, 0., None).unwrap();
        let rows: Vec<u64> = j.rows().iter().map(|r| r.value.to_bits()).collect();
        let mut roots = vec![0.; j.root_count()];
        j.roots(t, y, &yp, &mut roots).unwrap();
        (
            rows,
            roots.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            j.next_time_event(t),
            j.differential(&network_ids),
            j.root_directions().unwrap(),
        )
    };
    // Restores into a fresh composition bit for bit; returns whether the
    // unrestored operator's rows differ.
    let survives = |joined: &mut Op, y: &[f64]| {
        let snapshot = joined.discrete_state();
        let driven = state(joined, y);
        let mut fresh = started_s3_composition(&common::spine())
            .expect("the S3 composition")
            .0
            .joined;
        let unrestored = state(&mut fresh, y);
        assert_ne!(unrestored, driven, "the unrestored operator must differ");
        fresh
            .restore_discrete_state(&snapshot)
            .expect("restore into a fresh composition");
        assert_eq!(fresh.discrete_state(), snapshot, "round trip");
        let restored = state(&mut fresh, y);
        assert_eq!(restored.2, driven.2, "next time event");
        assert_eq!(restored.3, driven.3, "identity");
        assert_eq!(restored.4, driven.4, "root directions");
        assert_eq!(restored.1, driven.1, "root values");
        assert_eq!(restored.0, driven.0, "residual rows");
        (
            snapshot["network"]["spray"].clone(),
            unrestored.0 != driven.0,
        )
    };
    let heater = joined.pzr().request_w();
    let (change, _) = joined
        .apply_pzr_control(
            0.1,
            &Demand {
                heater_request_w: heater,
                spray_target: 0.5,
            },
        )
        .expect("a control frame opening the spray valve");
    assert_eq!(
        change,
        StemChange::Lock,
        "opening a closed valve releases its lock"
    );
    let (opened, rows_differ) = survives(&mut joined, &y);
    assert!(
        rows_differ,
        "an open valve's restriction row differs from the lock's"
    );
    // The inlet check's slot precedes the port's two (DR-P3-SPRAY).
    let mut directions = vec![0; joined.root_count()];
    let check = directions.len() - 3;
    directions[check] = -1;
    joined
        .transact(0.2, &directions, &mut y)
        .expect("the inlet check's contact");
    let (checked, _) = survives(&mut joined, &y);
    assert_eq!(
        (
            checked["closed"].as_bool(),
            checked["check_closed"].as_bool()
        ),
        (Some(false), Some(true)),
        "{checked}"
    );
    println!("{}", json!({"opened": opened, "check_closed": checked}));
}

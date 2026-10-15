//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray path in motion (NOT-EVIDENCE check for KERN): from
//! the zero-time joined composition of a packet with the spray path, after
//! a quiet second the controlled stem is issued 0.5 (opening a closed valve:
//! its lock releases, class R, `discrete_restart`); it travels at its rate
//! and arrives (class S: an exact stop, history continued); it is
//! held open to +4 s (closing to 0 is refused by the network until its
//! closing lock is represented). Recorded every 0.1 s: the
//! stem, the valve and port faces' liquid mass flows, the roof pressure,
//! the line pressure and the primary water mass (regular cells and the PZR
//! cell's stocks).
//!
//! Environment: the joined spine's, with `LD01_OPERATING_HOT_SPINE_PACKET`
//! the spray packet; optionally `LD01_SPRAY_DYNAMICS_RECEIPT`.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{
    control::{pzr_pressure::Demand, spray_valve::StemChange},
    network::{PZR_MASS, stratified},
};
use leitbild_operating_water::{
    ida::{Advance, Ida, Initial},
    joined::{Discrete, Integrated, Restart, discrete_restart},
};
use serde_json::json;
use spine::{
    DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, started_s3_composition, z1,
};

#[test]
#[ignore = "NOT-EVIDENCE check: requires the spray packet, the wiki, IF97 and stock IDA/KLU"]
fn the_spray_valve_opens_with_its_lock_release_and_delivers() {
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
    ) = started_s3_composition();
    let spray = *joined.network.spray().expect("a spray packet");
    let heater = joined.pzr().unwrap().request_w();
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
    let started = z1::cpu_s();
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
    let end: f64 = 4.;
    let mut next_sample = 0.1;
    let mut t = 0.;
    // Instants: open at 1 s, close-issue at 4 s; the stem's arrivals follow.
    // Closing to 0 is not yet represented (the network refuses it at the
    // stem's arrival): the check opens and holds.
    let mut issues = vec![(1., 0.5)];
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
        t = match ida.advance(stop, &mut y, &mut yp).unwrap() {
            Advance::Reached(r) => r,
            Advance::Root { time, directions } => panic!("root at {time}: {directions:?}"),
        };
        assert_eq!(t, stop, "stopped exactly");
        if issues.first().is_some_and(|(ti, _)| *ti == t) {
            let (_, target) = issues.remove(0);
            let demand = Demand {
                heater_request_w: heater,
                spray_target: target,
                withdrawn: None,
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
        if t >= next_sample - 1e-12 {
            rows.push(observe(&mut ida, t, &y, &yp));
            next_sample += 0.1;
        }
    }
    let cpu = z1::cpu_s() - started;
    let closed = ida.system().joined.network.spray().unwrap().closed;
    let receipt = json!({"kind": "s3-spray-path-dynamics", "status": "NOT-EVIDENCE",
        "provenance": spine::provenance(), "heater_request_w": heater, "cpu_s": cpu,
        "columns": ["t_s", "stem", "valve_face_kg_s", "port_face_kg_s", "roof_pa", "line_pa", "primary_water_kg"],
        "events": events, "rows": rows, "valve_closed_at_end": closed});
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Some(p) = &receipt_path {
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
    assert!(!closed, "the opened valve's path is free");
}

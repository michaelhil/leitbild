//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#breaker-movement-and-passive-opening
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/distribution-and-switching.md#break-before-make-automatic-transfer
//! The ELEC S3 slice appended to the joined spine (ELEC hooks), a check on
//! the composed S2 state, NOT evidence: the generator/shaft/turbine block
//! after the operator's coordinates, the turbine on the SG owner's admitted
//! steam, the generator breaker, AC.A/AC.B supplying the four RCP drives and
//! gating the recorded feed (S3-D12), and the slice's IDAS quadratures.
//!
//! Environment: the joined spine's (packet, wiki, IF97, stock IDAS) plus
//! `ELEC_PACKET`, the electrical packet compiled by
//! `reference-design-operating-electrical.ts`.
#![cfg(all(feature = "quadratures", target_os = "macos"))]
mod common;
use common::cpu;
use leitbild_operating_water::unit::{
    profile::{DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT},
    spine::{Started, started_s3_composition},
};

use leitbild_operating_plant::joined::blocks::JoinedJacobian;
use leitbild_operating_plant::{
    electrical::{
        breaker::{self, Breaker, Contact},
        bus::{self, Distribution, SourceState},
        field,
        slice::{self, Inputs, QUADRATURES, Slice},
    },
    joined::block::Command,
    rotor::Support,
};
use leitbild_operating_water::{
    If97,
    electrical::{Configuration, Electrified, FieldClient, N, PROPOSED_BUDGET},
    frame::{Action, Change, Class, Client, Dense, Diagnostic, Driver, Frame, Reached, Setup},
    ida::{Advance, Ida, Initial},
    joined::{
        Analyses, DerivedTolerances, Discrete, Integrated, JoinedSystem, Restart, discrete_restart,
        root_directions,
    },
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

type Unit = Electrified<Integrated<If97>>;

fn packet() -> Value {
    let path = std::env::var("ELEC_PACKET").expect("ELEC_PACKET: the compiled electrical packet");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn f(v: &Value, path: &[&str]) -> f64 {
    path.iter()
        .fold(v, |v, k| &v[*k])
        .as_f64()
        .unwrap_or_else(|| panic!("{path:?}"))
}

struct Case {
    t0: f64,
    ida: Ida<Unit>,
    y: Vec<f64>,
    yp: Vec<f64>,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    restart: Restart,
    e0: f64,
    n: usize,
    derived: Value,
    /// The joined S3 classes the tolerances carry (the frame driver's
    /// `Setup::derived`).
    joined_derived: DerivedTolerances,
}

/// The joined state to start from: the settled state named by
/// `LD01_S3_STATE` (`{t_s, y, yp, packet}`, as the IC-PROT probe), else the
/// composed state at t = 0 (whose first second is the impulsive transient).
fn initial(s: &Started) -> (f64, Vec<f64>, Vec<f64>) {
    match std::env::var("LD01_S3_STATE") {
        Ok(path) => {
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            let v = |k: &str| -> Vec<f64> {
                state[k]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap())
                    .collect()
            };
            assert_eq!(
                state["packet"].as_str(),
                Some(common::packet_bytes().0.as_str())
            );
            (state["t_s"].as_f64().unwrap(), v("y"), v("yp"))
        }
        Err(_) => (0., s.y.clone(), s.yp.clone()),
    }
}

fn build(offsite_loss_after_s: Option<f64>) -> Case {
    build_with(offsite_loss_after_s, true)
}

/// [`build`], with the slice's IDAS quadratures started on the handle
/// (`quadratures`) or left for the frame driver to start.
fn build_with(offsite_loss_after_s: Option<f64>, quadratures: bool) -> Case {
    let e = packet();
    let (mut s, joined_derived) =
        started_s3_composition(&common::spine()).expect("the S3 composition");
    // S3-D27: the routing gates the feed, so the SG mass rows' structure
    // covers the gate closed; the block structure is compiled after it.
    s.joined.declare_feed_gate().expect("the feed gate");
    s.structure = JoinedJacobian::compile_for(&mut s.joined, 0., &s.y, None)
        .expect("the block structure with the feed gate");
    s.analyses = Analyses::default();
    let (t0, y0, yp0) = initial(&s);
    let rotor_consumers: Vec<String> = (0..s.joined.network.rotor_count())
        .map(|r| ["LD01.P.A1", "LD01.P.A2", "LD01.P.B1", "LD01.P.B2"][r].to_string())
        .collect();
    let nonnegative = s.joined.network.nonnegative_stocks();
    let n = s.y.len();
    let v_line = f(&e, &["boundary", "lineVoltage_V"]);
    let f0 = f(&e, &["boundary", "frequency_Hz"]);
    let live = SourceState {
        energized: true,
        voltage_pu: 1.,
        frequency_hz: f0,
    };
    let params: slice::Parameters = serde_json::from_value(e["slice"].clone()).unwrap();
    let room = f(&e, &["prepared", "room_K"]);
    let slice = Slice::new(
        params,
        Inputs {
            joined: true,
            v_line,
            f_grid_hz: f0,
            carrier_rad_s: slice::prepared_carrier(f0),
            carrier_accel_rad_s2: 0.,
            carrier_from_s: 0.,
            admitted_kg_s: 0.,
            field_v: f(&e, &["prepared", "fieldDemand_V"]),
            room_k: room,
            unit_draw_w: 0.,
            reserve_draw_w: 0.,
        },
    )
    .unwrap();
    let routing = Distribution::prepared(
        serde_json::from_value::<bus::Parameters>(e["distribution"].clone()).unwrap(),
        [live, live],
        [true, true],
        t0,
    )
    .unwrap();
    let breaker = Breaker::new(
        serde_json::from_value::<breaker::Parameters>(e["breaker"].clone()).unwrap(),
        Contact::Closed,
    )
    .unwrap();
    let configuration = Configuration {
        rotor_consumers,
        feed_pumps: vec!["LD01.FW.P1".into(), "LD01.FW.P2".into()],
        field_bus: e["fieldConverterBus"].as_str().unwrap().into(),
        field_demand_v: f(&e, &["prepared", "fieldDemand_V"]),
        fixture_demands_w: serde_json::from_value(e["fixtureConsumerDemand_W"].clone()).unwrap(),
    };
    let mut unit = Electrified::new(
        Integrated::from_blocks(s.joined, s.structure, s.analyses).unwrap(),
        slice,
        breaker,
        routing,
        configuration,
    )
    .unwrap();
    unit.offsite_loss_s = offsite_loss_after_s.map(|d| t0 + d);
    // The slice's prepared state: the generator page's hot original.
    let mut tail = vec![0.; N];
    let mut tail_rates = vec![0.; N];
    let flux: Vec<f64> = serde_json::from_value(e["prepared"]["initialFlux"].clone()).unwrap();
    tail[..3].copy_from_slice(&flux);
    tail[slice::OMEGA] = f(&e, &["prepared", "speed_rad_s"]);
    tail[slice::THETA] = f(&e, &["prepared", "angle_rad"]);
    tail[slice::BODY] = room;
    let tail_ids = unit.appended_start(t0, &mut tail, &mut tail_rates).unwrap();
    let e0 = unit.slice.stored_energy(&tail);
    // Tolerances: the joined S3 classes, then the slice's G12 floors with
    // the S3-D16 stator rows (PROPOSED budget, pending the lead).
    let s_flux = v_line / (2. * std::f64::consts::PI * f0);
    let s_cur = f(&e, &["boundary", "base_VA"]) / v_line;
    let mut slice_atol = vec![
        1e-8 * s_flux,
        1e-8 * s_flux,
        1e-8 * flux[2].abs(),
        1e-8 * s_cur,
        1e-8 * s_cur,
        1e-8 * f(&e, &["prepared", "fieldCurrent_A"]),
        1e-8 * tail[slice::OMEGA],
        1e-8,
        1e-8 * room,
    ];
    let rows = unit.derived_rows(n, &slice_atol, PROPOSED_BUDGET);
    for r in &rows {
        slice_atol[r.coordinate - n] = r.applied_scaled;
    }
    let y = [y0, tail].concat();
    let yp = [yp0, tail_rates].concat();
    let ids = [s.ids.clone(), tail_ids].concat();
    let atol = [s.atol.clone(), slice_atol].concat();
    let mut ida = Ida::new(
        unit,
        Initial {
            time: t0,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: s.rtol,
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
    if quadratures {
        ida.initialize_quadratures(&[0.; 10]).unwrap();
    }
    Case {
        t0,
        ida,
        y,
        yp,
        network_ids: s.network_ids,
        atol,
        rtol: s.rtol,
        restart,
        e0,
        n,
        derived: json!({"joined_rows": joined_derived.rows.len(), "stator": rows}),
        joined_derived,
    }
}

/// Integrate to `horizon` with the commands, located roots and every owner
/// time event (the operator's and the appended slice's) restarted by
/// `discrete_restart`; quadratures carried across restarts.
fn run(c: &mut Case, commands: &[(f64, Command)], span: f64) -> Value {
    let mut t = c.t0;
    let horizon = c.t0 + span;
    let mut q = [0.; 10];
    let mut pending: Vec<(f64, Command)> = commands.iter().map(|(d, k)| (c.t0 + d, *k)).collect();
    let mut restarts: Vec<Value> = Vec::new();
    let mut supports: Vec<Value> = Vec::new();
    let (mut steps, mut jac) = (0i64, 0i64);
    let mut domain_exit: Option<Value> = None;
    let cpu0 = cpu::thread_cpu_s();
    while t < horizon - 1e-12 {
        let mut stop = horizon;
        if let Some(e) = c.ida.system().next_time_event(t) {
            stop = stop.min(e);
        }
        if let Some((tc, _)) = pending.first() {
            stop = stop.min(*tc);
        }
        c.ida.stop_at(stop).unwrap();
        let outcome = c.ida.advance(stop, &mut c.y, &mut c.yp).unwrap();
        let (reached, discrete) = match &outcome {
            Advance::Reached(time) => (*time, None),
            Advance::Root { time, directions } => (*time, Some(directions.clone())),
        };
        t = reached;
        let command = pending
            .first()
            .filter(|(tc, _)| (*tc - t).abs() < 1e-12)
            .map(|(_, k)| *k);
        let event_due = c
            .ida
            .system()
            .next_time_event(t - (t.abs() + 1.) * f64::EPSILON)
            .is_some_and(|e| e <= t);
        if discrete.is_none() && command.is_none() && !event_due {
            continue;
        }
        if command.is_some() {
            pending.remove(0);
        }
        let st = c.ida.stats().unwrap();
        steps += st.steps;
        jac += st.jacobians;
        c.ida.quadratures(&mut q).unwrap();
        let kind = match (&discrete, command) {
            (Some(d), _) => Discrete::Roots(d),
            (None, Some(k)) => Discrete::Command(k),
            (None, None) => Discrete::TimeEvent,
        };
        eprintln!(
            "restart at t0 + {:.6} s: {}",
            t - c.t0,
            kind_name(&discrete, command)
        );
        let restarted = match discrete_restart(
            &mut c.ida,
            t,
            kind,
            &mut c.y,
            &c.network_ids,
            &c.atol,
            c.rtol,
            &c.restart,
        ) {
            Ok(r) => r,
            // The S2 SG domain's declared unsupported exit ends the run (reported).
            Err(e) if e.contains("S2 domain exit") => {
                domain_exit = Some(json!({"t_s": t - c.t0, "reason": e}));
                break;
            }
            Err(e) => panic!("restart at {t} s: {e}"),
        };
        c.yp.copy_from_slice(&restarted.yp);
        c.ida.reinitialize_quadratures(&q).unwrap();
        let network = &c.ida.system().integrated().joined.network;
        let rcp: Vec<bool> = (0..network.rotor_count())
            .map(|r| {
                matches!(
                    network.rotor_state(r).unwrap().support,
                    Support::Supported(_)
                )
            })
            .collect();
        supports.push(json!({"t_s": t - c.t0, "rcp_supported": rcp}));
        restarts.push(
            json!({"t_s": t - c.t0, "kind": format!("{:?}", kind_name(&discrete, command)),
            "appended": restarted.appended, "start_passes": restarted.report.projection_passes}),
        );
    }
    let st = c.ida.stats().unwrap();
    steps += st.steps;
    jac += st.jacobians;
    c.ida.quadratures(&mut q).unwrap();
    let cpu = cpu::thread_cpu_s() - cpu0;
    let unit = c.ida.system();
    let tail = &c.y[c.n..];
    let deposits = unit.mechanism_j;
    let defect = unit.slice.ledger_defect(c.e0, tail, &q, deposits);
    let throughput: f64 = q[..6].iter().map(|v| v.abs()).sum();
    json!({
        "reached_s": t - c.t0, "domain_exit": domain_exit, "steps": steps, "jacobians": jac, "cpu_s": cpu, "restarts": restarts, "supports": supports,
        "quadratures": QUADRATURES.iter().zip(q).map(|(k, v)| (k.to_string(), v)).collect::<BTreeMap<_, _>>(),
        "slice_ledger_defect_J": defect, "throughput_J": throughput, "arc_heat_J": unit.arc_heat_j,
        "speed_rpm": tail[slice::OMEGA] * 60. / (2. * std::f64::consts::PI), "export_W": unit.slice.export_w(tail),
        "log": unit.log.iter().map(|(t, s)| json!({"t_s": t - c.t0, "event": s})).collect::<Vec<_>>(),
    })
}
fn kind_name(roots: &Option<Vec<i32>>, command: Option<Command>) -> String {
    match (roots, command) {
        (Some(_), _) => "located roots".into(),
        (None, Some(c)) => format!("command {c:?}"),
        (None, None) => "owner time event".into(),
    }
}

#[test]
#[ignore = "requires the joined packet, the wiki, IF97, stock IDAS and ELEC_PACKET"]
fn the_generator_joins_the_spine_through_a_turbine_trip_and_an_offsite_loss() {
    cpu::prefer_performance_core();
    // TRIP: the manual turbine trip at 0.5 s; GCB OPEN at its travel end,
    // the unit→reserve transfer, the RCPs and feed without supply for 0.5 s.
    eprintln!("== TRIP");
    let mut trip = build(None);
    let r_trip = run(&mut trip, &[(0.5, Command::TurbineTrip)], 2.0);
    // LOOP (S3-D10): the offsite connection lost at a non-integer time.
    eprintln!("== LOOP");
    let mut loop_ = build(Some(0.6789));
    // The turbine trip C5 takes from the field-supply loss protection (AC.B
    // lost; sampled 0.1 s + 0.1 s transport: IC-PROT's cause), declared here.
    let r_loop = run(&mut loop_, &[(0.6789 + 0.2, Command::TurbineTrip)], 2.0);
    let receipt = json!({"derived": trip.derived, "trip": r_trip, "loop": r_loop});
    println!("{}", serde_json::to_string(&receipt).unwrap());
    if let Ok(path) = std::env::var("ELEC_JOINED_OUT") {
        std::fs::write(path, serde_json::to_string_pretty(&receipt).unwrap()).unwrap();
    }
    for r in [&r_trip, &r_loop] {
        let d = r["slice_ledger_defect_J"].as_f64().unwrap();
        let tp = r["throughput_J"].as_f64().unwrap();
        assert!(d.abs() < 1e-5 * tp, "slice ledger {d} of {tp}");
    }
    let times = |r: &Value, what: &str| -> Vec<f64> {
        r["log"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["event"].as_str().unwrap().contains(what))
            .map(|l| l["t_s"].as_f64().unwrap())
            .collect()
    };
    let gcb = times(&r_trip, "GCB Open");
    assert!(gcb.len() == 1 && (gcb[0] - 0.8).abs() < 1e-9, "{gcb:?}");
    let transfer = times(&r_trip, "transfer to Reserve complete");
    assert!(
        transfer.iter().all(|t| (t - 1.3).abs() < 1e-9) && !transfer.is_empty(),
        "{transfer:?}"
    );
    // RCPs unsupported between the GCB opening and the transfer's completion.
    let rcp_at = |r: &Value, t: f64| -> Vec<bool> {
        r["supports"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|s| s["t_s"].as_f64().unwrap() <= t + 1e-12)
            .map(|s| {
                s["rcp_supported"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_bool().unwrap())
                    .collect()
            })
            .unwrap()
    };
    assert_eq!(rcp_at(&r_trip, 0.9), vec![false; 4]);
    assert_eq!(rcp_at(&r_trip, 1.5), vec![true; 4]);
    assert_eq!(rcp_at(&r_loop, 1.0), vec![false; 4]);
    assert!(r_loop["arc_heat_J"].as_f64().unwrap() > 0.);
}

/// S3-D19 for the appended owners (KERN, reconciling ELEC's hooks): a unit
/// driven by `discrete_restart` through a turbine trip (GCB OPEN requested,
/// pending travel) and the declared offsite loss (stator separated, both
/// sources dead, RCP drives unsupported, the S3-D12 feed gate shut, the
/// breaker's travel completed) restores into a freshly built unit with the
/// same system snapshot, time events, identity, residual rows and root
/// values, bit for bit; the fresh unit before restoring differs (the check
/// sees a left-out state).
#[test]
#[ignore = "requires the joined packet, the wiki, IF97, stock IDAS and ELEC_PACKET"]
fn the_electrical_discrete_state_survives_a_snapshot() {
    use leitbild_operating_water::ida::System;
    let mut c = build(Some(0.5));
    let (t1, t2) = (c.t0 + 0.1, c.t0 + 0.5);
    for (t, kind) in [
        (t1, Discrete::Command(Command::TurbineTrip)),
        (t2, Discrete::TimeEvent),
    ] {
        let r = discrete_restart(
            &mut c.ida,
            t,
            kind,
            &mut c.y,
            &c.network_ids,
            &c.atol,
            c.rtol,
            &c.restart,
        )
        .unwrap_or_else(|e| panic!("restart at {t} s: {e}"));
        c.yp.copy_from_slice(&r.yp);
    }
    let snapshot = c.ida.system().system_discrete_state();
    let e = &snapshot["appended"]["electrical"];
    assert_eq!(e["offsite_lost"], true, "{e}");
    assert_eq!(e["trip_requested"], true);
    assert_eq!(e["inputs"]["joined"], false);
    assert_eq!(snapshot["operator"]["secondary"]["feed_supported"], false);
    let t = t2;
    let state = |u: &mut Unit| {
        let mut rows = vec![0.; u.dimension()];
        u.residual(t, &c.y, &c.yp, &mut rows).unwrap();
        let mut roots = vec![0.; u.root_count()];
        u.roots(t, &c.y, &c.yp, &mut roots).unwrap();
        (
            rows.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            roots.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            u.next_time_event(t),
            u.differential_all(&c.network_ids),
        )
    };
    let driven = state(c.ida.system_mut());
    let mut fresh = build(Some(0.5));
    let unrestored = state(fresh.ida.system_mut());
    assert_ne!(unrestored.0, driven.0, "the unrestored unit must differ");
    fresh
        .ida
        .system_mut()
        .restore_system_discrete_state(&snapshot)
        .expect("restore into a fresh unit");
    assert_eq!(fresh.ida.system().system_discrete_state(), snapshot);
    let restored = state(fresh.ida.system_mut());
    assert_eq!(restored.2, driven.2, "next time event");
    assert_eq!(restored.3, driven.3, "identity");
    assert_eq!(restored.1, driven.1, "root values");
    assert_eq!(restored.0, driven.0, "residual rows");
    println!(
        "{}",
        json!({"t_s": t - c.t0, "electrical": e, "next_event_s": driven.2.map(|x| x - c.t0)})
    );
}

/// C3's supply loss with the slice composed (lead, S3-D28 follow-up): the
/// command reaches the AC routing first, which opens the RCP's consumer
/// contactor; the drive support follows (unsupported, shaft free) and the
/// network's part of the command checks it; the rotor coasts down while the
/// other three keep their nominal support; the restart is class R by
/// `discrete_restart`, with no stop for the unchanged buses.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97, stock IDAS and ELEC_PACKET"]
fn an_rcp_supply_loss_is_routed_through_the_ac_routing() {
    let mut c = build(None);
    let lost = common::s1_gates()["supplyLoss"]["rotor"].as_u64().unwrap() as usize;
    let rotor = |c: &Case, r: usize| {
        let net = &c.ida.system().integrated().joined.network;
        let i = net.rotor_index[r];
        c.y[i] * net.scales()[i]
    };
    let before: Vec<f64> = (0..4).map(|r| rotor(&c, r)).collect();
    let out = run(&mut c, &[(0.1, Command::SupplyLoss { rotor: lost })], 2.);
    let unit = c.ida.system();
    let net = &unit.integrated().joined.network;
    for r in 0..net.rotor_count() {
        let s = net.rotor_state(r).unwrap();
        if r == lost {
            assert_eq!(s.support, Support::Unsupported, "rotor {r}");
        } else {
            assert!(
                matches!(s.support, Support::Supported(_)),
                "rotor {r}: {s:?}"
            );
        }
    }
    let consumer = &unit.configuration.rotor_consumers[lost];
    assert!(!unit.routing.support(consumer).unwrap().contactor_closed);
    assert!(
        out["log"]
            .to_string()
            .contains(&format!("{consumer} supply lost")),
        "{}",
        out["log"]
    );
    let after: Vec<f64> = (0..4).map(|r| rotor(&c, r)).collect();
    let drop = |r: usize| before[r] - after[r];
    assert!(
        (0..4)
            .filter(|r| *r != lost)
            .all(|r| drop(lost) > 10. * drop(r).abs()),
        "the lost rotor coasts down: {before:?} -> {after:?}"
    );
    println!(
        "{}",
        json!({"rotor": lost, "consumer": consumer, "rotor_coordinate_before": before, "rotor_coordinate_after": after,
            "restarts": out["restarts"], "supports": out["supports"], "log": out["log"]})
    );
}

/// A TEST-ONLY client: one class-R decision (a no-op held change) at frame
/// `at`, due at its instant, which the driver restarts late, from the
/// step's interpolant, when the step passed the frame.
struct LateRestart {
    at: u64,
}
impl Client<Unit> for LateRestart {
    fn name(&self) -> &str {
        "TEST-ONLY late class-R decision"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, _: &dyn Dense) -> Result<Vec<Change<Unit>>, String> {
        Ok(if k == self.at {
            vec![Change {
                due_s: t,
                class: Class::R,
                kind: "TEST-ONLY late R".into(),
                action: Action::Held(Box::new(|_| Ok(()))),
            }]
        } else {
            Vec::new()
        })
    }
}

/// PLATFORM (C5 native preview, design.md §12): the frame driver carries
/// the slice's IDAS quadratures (its energy receipts) across every restart
/// as the S2 joined ledger does (S2-14 M2).
/// - A handle whose quadratures were started outside the driver is refused
///   at its first restart.
/// - TRIP through the driver, no clients: the same steps and restarts as
///   [`run`]'s loop, which carries the quadratures itself; state and
///   cumulative quadratures equal its own bitwise.
/// - TRIP with a TEST-ONLY class-R decision at a frame (restarted late,
///   from the step's interpolant) and receipts every 0.25 s: the receipts
///   sum to the cumulative quadratures bitwise and the slice's energy
///   ledger closes on them.
#[test]
#[ignore = "requires the joined packet, the wiki, IF97, stock IDAS and ELEC_PACKET"]
fn the_frame_driver_carries_the_slices_quadratures_across_its_restarts() {
    cpu::prefer_performance_core();
    let frame = Frame::new(0.1).unwrap();
    let span = 2.;
    let trip_after_s = 0.5;
    // Started outside the driver: refused at the first restart.
    let mut c = build(None);
    let mut driver = Driver::new(frame, Diagnostic::None, cpu::thread_cpu_s, c.t0).unwrap();
    driver.command(c.t0 + 0.05, Command::TurbineTrip).unwrap();
    let setup = Setup {
        network_ids: &c.network_ids,
        absolute: &c.atol,
        relative: c.rtol,
        restart: c.restart,
        derived: &c.joined_derived,
    };
    let mut none: Vec<&mut dyn Client<Unit>> = Vec::new();
    let refused = driver
        .run(
            &mut c.ida,
            c.t0,
            c.t0 + 0.1,
            &mut c.y,
            &mut c.yp,
            &mut none,
            &setup,
        )
        .unwrap_err();
    assert!(
        refused.contains("started outside the frame driver"),
        "{refused}"
    );

    // The reference: run()'s own loop, which carries the quadratures.
    let mut reference = build(None);
    let r = run(
        &mut reference,
        &[(trip_after_s, Command::TurbineTrip)],
        span,
    );
    let q_reference: Vec<f64> = QUADRATURES
        .iter()
        .map(|k| r["quadratures"][*k].as_f64().unwrap())
        .collect();

    // The same TRIP through the frame driver, no clients, on stock matrix
    // management as run()'s loop is (a mechanics comparison; MR-1's forced
    // rebuild is guarded in tests/matrix_rebuild.rs).
    let mut c = build_with(None, false);
    let mut driver = Driver::new(frame, Diagnostic::None, cpu::thread_cpu_s, c.t0).unwrap();
    driver.matrix_rebuild = leitbild_operating_water::frame::MatrixRebuild::Stock;
    driver
        .start_quadratures(&mut c.ida, vec![0.; QUADRATURES.len()])
        .unwrap();
    driver
        .command(c.t0 + trip_after_s, Command::TurbineTrip)
        .unwrap();
    let setup = Setup {
        network_ids: &c.network_ids,
        absolute: &c.atol,
        relative: c.rtol,
        restart: c.restart,
        derived: &c.joined_derived,
    };
    let mut none: Vec<&mut dyn Client<Unit>> = Vec::new();
    driver.start(&mut none, c.t0, &c.y, &c.yp).unwrap();
    let Reached::Until(end) = driver
        .run(
            &mut c.ida,
            c.t0,
            c.t0 + span,
            &mut c.y,
            &mut c.yp,
            &mut none,
            &setup,
        )
        .expect("TRIP through the frame driver");
    let q_driven = driver.quadratures_at(&c.ida, end).unwrap();
    let same_state =
        c.y.iter()
            .zip(&reference.y)
            .all(|(a, b)| a.to_bits() == b.to_bits());
    let driven_restarts = driver.counts.total(Class::R);

    // TRIP with a late class-R decision at a frame, receipts every 0.25 s.
    let mut c = build_with(None, false);
    let mut driver = Driver::new(frame, Diagnostic::None, cpu::thread_cpu_s, c.t0).unwrap();
    driver
        .start_quadratures(&mut c.ida, vec![0.; QUADRATURES.len()])
        .unwrap();
    driver
        .command(c.t0 + trip_after_s, Command::TurbineTrip)
        .unwrap();
    let mut late = LateRestart {
        at: frame.at_or_after(c.t0 + 0.26).unwrap(),
    };
    let setup = Setup {
        network_ids: &c.network_ids,
        absolute: &c.atol,
        relative: c.rtol,
        restart: c.restart,
        derived: &c.joined_derived,
    };
    let mut clients: Vec<&mut dyn Client<Unit>> = vec![&mut late];
    driver.start(&mut clients, c.t0, &c.y, &c.yp).unwrap();
    let (mut t, mut previous) = (c.t0, vec![0.; QUADRATURES.len()]);
    let mut sums = vec![0.; QUADRATURES.len()];
    let mut receipts: Vec<Value> = Vec::new();
    for i in 1..=8 {
        let until = c.t0 + 0.25 * f64::from(i);
        let Reached::Until(reached) = driver
            .run(
                &mut c.ida,
                t,
                until,
                &mut c.y,
                &mut c.yp,
                &mut clients,
                &setup,
            )
            .expect("TRIP with a late restart through the frame driver");
        t = reached;
        let q = driver.quadratures_at(&c.ida, t).unwrap();
        for (s, (a, b)) in sums.iter_mut().zip(q.iter().zip(&previous)) {
            *s += a - b;
        }
        receipts.push(json!({"t_s": t - c.t0, "export_J": q[0] - previous[0]}));
        previous = q;
    }
    let cumulative = driver.quadratures_at(&c.ida, t).unwrap();
    let unit = c.ida.system();
    let defect = unit
        .slice
        .ledger_defect(c.e0, &c.y[c.n..], &cumulative, unit.mechanism_j);
    let throughput: f64 = cumulative[..6].iter().map(|v| v.abs()).sum();
    let late_r = driver
        .log
        .iter()
        .find(|e| e["class"] == "R" && e["kinds"].to_string().contains("TEST-ONLY late R"))
        .cloned()
        .expect("the late class-R instant");
    let telescoped: Vec<bool> = sums
        .iter()
        .zip(&cumulative)
        .map(|(s, q)| s.to_bits() == q.to_bits())
        .collect();
    println!(
        "{}",
        json!({"refused": refused,
            "driven": {"same_state_as_reference": same_state, "restarts_r": driven_restarts,
                "quadratures": QUADRATURES.iter().zip(&q_driven).map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>(),
                "reference": QUADRATURES.iter().zip(&q_reference).map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>()},
            "late": {"instant": late_r, "restarts_r": driver.counts.total(Class::R), "receipts": receipts,
                "telescoped_bitwise": QUADRATURES.iter().zip(&telescoped).map(|(k, v)| (k.to_string(), *v)).collect::<BTreeMap<_, _>>(),
                "slice_ledger_defect_J": defect, "throughput_J": throughput}})
    );
    assert!(
        same_state,
        "the driven TRIP leaves the reference's trajectory"
    );
    assert!(driven_restarts >= 3, "{driven_restarts} restarts");
    for (k, (a, b)) in QUADRATURES.iter().zip(q_driven.iter().zip(&q_reference)) {
        assert_eq!(a.to_bits(), b.to_bits(), "{k}: driven {a}, reference {b}");
    }
    assert!(
        late_r["rolled_back_from_s"].is_f64(),
        "the TEST-ONLY decision restarted late: {late_r}"
    );
    // Sensitivity: the late restart discarded the rest of its step; carried
    // from the step's end instead of the interpolant at the restart, the
    // export receipt holding it would exceed its steady predecessor (both
    // before the trip) by the discarded fraction of a receipt.
    let export = |i: usize| receipts[i]["export_J"].as_f64().unwrap();
    let discarded_s =
        late_r["rolled_back_from_s"].as_f64().unwrap() - late_r["t_s"].as_f64().unwrap();
    let steady = (export(1) - export(0)).abs() / export(0);
    assert!(
        steady < 0.1 * discarded_s / 0.25,
        "receipts {} and {}: {steady} against the discarded {discarded_s} s",
        export(0),
        export(1)
    );
    for (k, (s, q)) in QUADRATURES.iter().zip(sums.iter().zip(&cumulative)) {
        assert_eq!(
            s.to_bits(),
            q.to_bits(),
            "{k}: receipts sum to {s}, cumulative {q}"
        );
    }
    assert!(
        defect.abs() < 1e-5 * throughput,
        "slice ledger {defect} of {throughput}"
    );
}

/// ICFIELD: records the commands the frame driver hands the clients
/// (declared ones and, through the driver's hook, client-decided ones).
struct Commands {
    seen: Vec<(f64, Command)>,
}
impl Client<Unit> for Commands {
    fn name(&self) -> &str {
        "TEST-ONLY command recorder"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn frame(&mut self, _: u64, _: f64, _: &dyn Dense) -> Result<Vec<Change<Unit>>, String> {
        Ok(Vec::new())
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Vec<Change<Unit>>, String> {
        self.seen.push((t, command));
        Ok(Vec::new())
    }
}

/// ICFIELD (generator page, field-supply loss): an offsite loss between
/// frames leaves the field converter on AC.B unsupplied. The field
/// controller acquires the loss at the next frame and, one transport
/// later, requests GCB OPEN and the acquired turbine trip in one class-R
/// instant; the trip latches the SG owner's STOP, reaches the clients'
/// retained part (the driver's hook) and the GCB opens one travel later.
/// Needs `ELEC_PACKET` with `fieldProtection` (S3-D44, wiki e522644).
#[test]
#[ignore = "requires the joined packet, the wiki, IF97, stock IDAS and ELEC_PACKET with fieldProtection"]
fn a_loops_field_supply_loss_trips_the_turbine_through_the_field_controller() {
    cpu::prefer_performance_core();
    let frame = Frame::new(0.1).unwrap();
    let loss_after_s = 0.6789;
    let params: field::Parameters = serde_json::from_value(packet()["fieldProtection"].clone())
        .expect("ELEC_PACKET with the field controller's timing (fieldProtection)");
    let mut c = build_with(Some(loss_after_s), false);
    let mut controller = FieldClient::new(&params, frame, c.ida.system()).unwrap();
    let mut recorder = Commands { seen: Vec::new() };
    let mut driver = Driver::new(frame, Diagnostic::None, cpu::thread_cpu_s, c.t0).unwrap();
    driver
        .start_quadratures(&mut c.ida, vec![0.; QUADRATURES.len()])
        .unwrap();
    let setup = Setup {
        network_ids: &c.network_ids,
        absolute: &c.atol,
        relative: c.rtol,
        restart: c.restart,
        derived: &c.joined_derived,
    };
    {
        let mut clients: Vec<&mut dyn Client<Unit>> = vec![&mut controller, &mut recorder];
        driver.start(&mut clients, c.t0, &c.y, &c.yp).unwrap();
        driver
            .run(
                &mut c.ida,
                c.t0,
                c.t0 + 1.5,
                &mut c.y,
                &mut c.yp,
                &mut clients,
                &setup,
            )
            .expect("the LOOP through the frame driver with the field controller");
    }
    // The acquisition reads the left limit: the first frame after the loss.
    let loss = c.t0 + loss_after_s;
    let mut acquired = frame.at_or_after(loss).unwrap();
    if frame.instant(acquired) == loss {
        acquired += 1;
    }
    let decided = frame.instant(acquired + 1);
    let unit = c.ida.system();
    let instant = driver
        .log
        .iter()
        .find(|e| e["kinds"].to_string().contains(field::SUPPLY_LOSS))
        .cloned()
        .expect("the field controller's instant");
    let opened = unit
        .log
        .iter()
        .find(|(_, w)| w == "GCB Open")
        .map(|(t, _)| *t);
    println!(
        "{}",
        json!({"t0_s": c.t0, "loss_s": loss, "acquired_frame_s": frame.instant(acquired), "decided_s": decided,
            "initiation": controller.protection.log, "instant": instant,
            "commands_seen": recorder.seen.iter().map(|(t, k)| json!([t, format!("{k:?}")])).collect::<Vec<_>>(),
            "electrical_log": unit.log, "gcb_open_s": opened, "counts": driver.counts.json()})
    );
    let i = controller.protection.initiated.clone().expect("an initiation");
    assert_eq!((i.cause, i.at_s), (field::SUPPLY_LOSS, decided));
    assert_eq!(instant["class"], "R", "{instant}");
    assert_eq!(instant["t_s"].as_f64(), Some(decided));
    assert_eq!(
        unit.integrated()
            .joined
            .secondary()
            .and_then(|s| s.turbine_trip_time()),
        Some(decided),
        "the STOP latched at the decision"
    );
    assert!(
        unit.log.iter().any(|(t, w)| *t == decided
            && w.starts_with(&format!("GCB OPEN requested by {}", field::SUPPLY_LOSS))),
        "{:?}",
        unit.log
    );
    assert_eq!(recorder.seen, vec![(decided, Command::TurbineTripAcquired)]);
    let opened = opened.expect("the GCB opened");
    assert!(
        (opened - (decided + 0.3)).abs() < 1e-9,
        "GCB open at {opened}"
    );
}

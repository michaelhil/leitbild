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
#[path = "common/cpu.rs"]
mod clock;
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{
    electrical::{
        breaker::{self, Breaker, Contact},
        bus::{self, Distribution, SourceState},
        slice::{self, Inputs, QUADRATURES, Slice},
    },
    joined::block::Command,
    rotor::Support,
};
use leitbild_operating_water::{
    If97,
    electrical::{Configuration, Electrified, N, PROPOSED_BUDGET},
    ida::{Advance, Ida, Initial},
    joined::{Discrete, Integrated, JoinedSystem, Restart, discrete_restart, root_directions},
};
use serde_json::{Value, json};
use spine::{DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, started_s3_composition};
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
}

/// The joined state to start from: the settled state named by
/// `LD01_S3_STATE` (`{t_s, y, yp, packet}`, as the IC-PROT probe), else the
/// composed state at t = 0 (whose first second is the impulsive transient).
fn initial(s: &spine::Started) -> (f64, Vec<f64>, Vec<f64>) {
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
                Some(spine::packet_bytes().0.as_str())
            );
            (state["t_s"].as_f64().unwrap(), v("y"), v("yp"))
        }
        Err(_) => (0., s.y.clone(), s.yp.clone()),
    }
}

fn build(offsite_loss_after_s: Option<f64>) -> Case {
    let e = packet();
    let (s, joined_derived) = started_s3_composition();
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
    ida.initialize_quadratures(&[0.; 10]).unwrap();
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
    let cpu0 = clock::thread_cpu_s();
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
    let cpu = clock::thread_cpu_s() - cpu0;
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
    clock::prefer_performance_core();
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

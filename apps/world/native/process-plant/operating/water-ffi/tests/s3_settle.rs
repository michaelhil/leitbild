//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The S3 settle state (lead decision S3-D28 (3)), NOT evidence: the full S3
//! composition of one packet settled by the S2 settle procedure and its
//! thresholds; C1's initial condition.
//!
//! Composition, from the S2 re-settled state of the same packet (its exact
//! consistent pair at its time, a frame instant):
//! - the joined operator with the spray line composed closed (S3-D25), the
//!   SG two-zone contact map (S3-D26), the recorded feed F3 (a) with the
//!   S3-D12 feed gate declared (S3-D27) and open;
//! - the derived tolerance classes of S2-D24r/S3-D16 applied at the start
//!   state, then L1 and the regular cells' phase modes armed (decision
//!   0014, S3-D-P1);
//! - IC-CTRL's normal PZR pressure control in AUTO, heater changes class S
//!   (S3-D4), spray demand zero (the valve stays closed);
//! - ELEC's slice appended (generator, shaft, turbine on the SG owner's
//!   admitted steam, GCB closed, AC routing): connected at full load from
//!   the electrical packet's prepared state, its stator classes from the
//!   S3-D23 budget (10 A, 1 MW);
//! - IC-PROT's frame driver (0.1 s frame) with stock IDA_ONE_STEP.
//!
//! Settling is S2's: the credited outputs sampled at the declared output
//! interval, the 2 Hz zero-phase-filtered range of each over the declared
//! window against its threshold (`ld01-s2-gates` settling block), checked
//! every 1 s once a window is full; caps from the environment. The settled
//! state is written with the operator's `y`/`y'`, the appended slice's,
//! and every owner's discrete state (S3-D19, `system_discrete_state`).
//!
//! Environment: the joined spine's (packet, wiki, IF97, SUNDIALS, water),
//! `LD01_S2_GATES_SOURCE`, `LD01_S3_SETTLE_FROM` (the S2 settled state of
//! this packet), `LD01_IC_SECTION`, `LD01_PZR_CONTROL_SECTION`,
//! `LD01_PZR_CONTROL_WIKI`, `ELEC_PACKET`, `LD01_S3_SETTLE_CAP_S`,
//! `LD01_S3_SETTLE_CPU_CAP_S`, `LD01_S3_SETTLE_DIR` (a new directory) and
//! `LD01_S3_DECLARATION` (the page holding the S3 cases block, whose
//! `settling.maxStep_s` bounds the settle's step, S3-D35).
//!
//! S3-D35 (lead, 15 Oct; IC-CTRL's DR-P3-PT1-2): the settle's IDA step is
//! bounded by the S3 block's declared maximum (settling phase only, recorded
//! in the receipt), so the settling measure reads step-resolved outputs; the
//! state handed on is the accepted step that ends at the settled sample.
#![cfg(all(feature = "ida", target_os = "macos"))]
#[path = "common/feed_control.rs"]
mod feed_control;
#[path = "common/filter.rs"]
mod filter;
#[path = "common/pzr_control.rs"]
mod pzr_control;
#[path = "common/s3_unit.rs"]
mod s3_unit;
#[path = "joined_spine.rs"]
mod spine;

use leitbild_operating_plant::{
    control::pzr_pressure::{Law, Section as ControlSection},
    electrical::{
        breaker::{self, Breaker, Contact},
        bus::{self, Distribution, SourceState},
        slice::{self, Inputs, Slice},
    },
    ic::packet::Section as IcSection,
    joined::{blocks::JoinedJacobian, operator::Joined, presence::VaporPresence},
    network::{Properties, packet::Packet as NetworkPacket},
};
use leitbild_operating_water::{
    If97,
    electrical::{Configuration, CreditedBudget, Electrified, N},
    frame::{COUNTER_NAMES, Class, Client, Diagnostic, Driver, Frame, Setup},
    ida::{Ida, Initial},
    joined::{
        Discrete, Integrated, JoinedSystem, Restart, derived_tolerances, discrete_restart,
        root_directions,
    },
};
use serde_json::{Map, Value, json};
use spine::{
    DELTA_CJ_LSETUP, FIRST_STEP_S, NEWTON_COEFFICIENT, Started, credited_outputs,
    started_full_composition, z1,
};
use std::path::PathBuf;

type Unit = Electrified<Integrated<If97>>;

const MAX_ORDER: usize = 2;
const CREDITED_BAND_HZ: f64 = 2.;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}
fn env_f64(name: &str) -> f64 {
    env(name)
        .parse()
        .unwrap_or_else(|_| panic!("{name} is a number"))
}
fn read_json(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap_or_else(|e| panic!("{path}: {e}"))
}
fn f(v: &Value, path: &[&str]) -> f64 {
    path.iter()
        .fold(v, |v, k| &v[*k])
        .as_f64()
        .unwrap_or_else(|| panic!("{path:?}"))
}
fn bits(v: &[f64]) -> Vec<String> {
    v.iter().map(|x| format!("{:016x}", x.to_bits())).collect()
}

fn gates_block(text: &str) -> Value {
    let fence = "```ld01-s2-gates";
    let mut found = text.match_indices(fence).map(|(i, _)| i);
    let start = found.next().expect("an ld01-s2-gates block");
    assert!(found.next().is_none(), "exactly one ld01-s2-gates block");
    let body = &text[start + fence.len()..];
    let end = body.find("\n```").expect("the block's closing fence");
    serde_json::from_str(body[..end].trim()).expect("the gates block's JSON")
}

/// The S2 settle's credited quantities (s2_settle.rs), in its order.
struct Credited {
    name: &'static str,
    key: &'static str,
    relative: bool,
}
const CREDITED: [Credited; 8] = [
    Credited {
        name: "core_power_w",
        key: "corePowerRelative",
        relative: true,
    },
    Credited {
        name: "average_coolant_k",
        key: "averageCoolant_K",
        relative: false,
    },
    Credited {
        name: "core_cell_liquid_k",
        key: "cellTemperature_K",
        relative: false,
    },
    Credited {
        name: "pt1_pa",
        key: "pzrRoofPressure_Pa",
        relative: false,
    },
    Credited {
        name: "sg_pressure_pa",
        key: "sgPressure_Pa",
        relative: false,
    },
    Credited {
        name: "pzr_level_m",
        key: "pzrLevel_m",
        relative: false,
    },
    Credited {
        name: "sg_liquid_m3",
        key: "sgLiquidVolume_m3",
        relative: false,
    },
    Credited {
        name: "loop_flow_kg_s",
        key: "loopFlowRelativeChange",
        relative: true,
    },
];

/// The credited outputs at `(t, y, y')` of the operator, as the S2 settle
/// observes them (s2_settle.rs's `observe`, without the reported legs).
fn observe(
    joined: &mut Joined<If97>,
    packet: &NetworkPacket,
    loops: &[usize; 2],
    t: f64,
    y: &[f64],
    yp: &[f64],
) -> Vec<Vec<f64>> {
    joined
        .evaluate(t, y, yp, None, 0., None)
        .expect("observed state");
    let released = joined.heats().nuclear.released_w.value;
    let net = &joined.network;
    let regions = &packet.mechanics.regions;
    let (mut mass, mut weighted, mut core) = (0., 0., Vec::new());
    for (c, l) in net.cell_layout.iter().enumerate() {
        let id = regions[c].id.as_str();
        let p = y[l.base] * net.scales()[l.base];
        let m = y[l.mass[0]] * net.scales()[l.mass[0]];
        let u = y[l.energy[0]] * net.scales()[l.energy[0]];
        let q = net
            .properties()
            .caloric(false, p, u / m, false)
            .expect("cell caloric");
        let temperature = net.properties().values(&q).temperature_k;
        if id != "SURGE" {
            mass += m;
            weighted += m * temperature;
        }
        if id.starts_with("CORE.") {
            core.push(temperature);
        }
    }
    let taps = net.pzr_taps().expect("PZR taps");
    let flows: Vec<f64> = loops
        .iter()
        .map(|f| net.chart(*f, 0).expect("loop chart").mass_flow_kg_s.value)
        .collect();
    let (mut sg_p, mut sg_v) = (Vec::new(), Vec::new());
    let mut k = 0;
    for (owner, layout) in joined.layouts() {
        for (i, label) in layout.labels.iter().enumerate() {
            if owner == "secondary" && label.ends_with(".p_s") {
                sg_p.push(y[k] * layout.scales[i]);
            }
            if owner == "secondary" && label.ends_with(".V_l") {
                sg_v.push(y[k] * layout.scales[i]);
            }
            k += 1;
        }
    }
    vec![
        vec![released],
        vec![weighted / mass],
        core,
        vec![taps.pt1_pa.value],
        sg_p,
        vec![taps.collapsed_level_m.value],
        sg_v,
        flows,
    ]
}

/// The window range of each credited series (filtered, relative where
/// declared), the worst instance per quantity: (range, threshold, holds).
fn ranges(window: &[Vec<Vec<f64>>], dt: f64, thresholds: &[f64]) -> Vec<(f64, f64, bool)> {
    CREDITED
        .iter()
        .enumerate()
        .map(|(q, c)| {
            let instances = window[0][q].len();
            let worst = (0..instances)
                .map(|i| {
                    let series: Vec<f64> = window.iter().map(|s| s[q][i]).collect();
                    let f = filter::zero_phase_lowpass(&series, CREDITED_BAND_HZ, dt);
                    let hi = f.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    let lo = f.iter().cloned().fold(f64::INFINITY, f64::min);
                    let range = hi - lo;
                    if c.relative {
                        (range / filter::mean(&f)).abs()
                    } else {
                        range
                    }
                })
                .fold(0., filter::larger);
            (worst, thresholds[q], worst <= thresholds[q])
        })
        .collect()
}

/// ELEC's slice, breaker, routing and configuration from the electrical
/// packet at `t0`, connected at full load (the packet's prepared state;
/// as `elec_joined.rs`'s composition), and the slice's prepared tail.
fn electrical(
    e: &Value,
    rotors: usize,
    t0: f64,
) -> (Slice, Breaker, Distribution, Configuration, [f64; N]) {
    let v_line = f(e, &["boundary", "lineVoltage_V"]);
    let f0 = f(e, &["boundary", "frequency_Hz"]);
    let live = SourceState {
        energized: true,
        voltage_pu: 1.,
        frequency_hz: f0,
    };
    let params: slice::Parameters = serde_json::from_value(e["slice"].clone()).unwrap();
    let room = f(e, &["prepared", "room_K"]);
    let slice = Slice::new(
        params,
        Inputs {
            joined: true,
            v_line,
            f_grid_hz: f0,
            carrier_rad_s: slice::prepared_carrier(f0),
            carrier_accel_rad_s2: 0.,
            carrier_from_s: t0,
            admitted_kg_s: 0.,
            field_v: f(e, &["prepared", "fieldDemand_V"]),
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
        rotor_consumers: (0..rotors)
            .map(|r| ["LD01.P.A1", "LD01.P.A2", "LD01.P.B1", "LD01.P.B2"][r].to_string())
            .collect(),
        feed_pumps: vec!["LD01.FW.P1".into(), "LD01.FW.P2".into()],
        field_bus: e["fieldConverterBus"].as_str().unwrap().into(),
        field_demand_v: f(e, &["prepared", "fieldDemand_V"]),
        fixture_demands_w: serde_json::from_value(e["fixtureConsumerDemand_W"].clone()).unwrap(),
    };
    let mut tail = [0.; N];
    let flux: Vec<f64> = serde_json::from_value(e["prepared"]["initialFlux"].clone()).unwrap();
    tail[..3].copy_from_slice(&flux);
    tail[slice::OMEGA] = f(e, &["prepared", "speed_rad_s"]);
    tail[slice::THETA] = f(e, &["prepared", "angle_rad"]);
    tail[slice::BODY] = room;
    (slice, breaker, routing, configuration, tail)
}

#[test]
#[ignore = "S3 settle state (S3-D28, NOT evidence): requires the S3 packets, the S2 settled state, the wiki, IF97 and stock IDA/KLU"]
#[allow(clippy::too_many_lines)] // One settle: composition, run, criterion, state and receipt.
fn s3_settle_state_for_c1() {
    let started = z1::cpu_s();
    let gates_path = env("LD01_S2_GATES_SOURCE");
    let gates_text = std::fs::read_to_string(&gates_path).expect("gates source");
    let gates = gates_block(&gates_text);
    let settling = &gates["settling"];
    let window_s = settling["window_s"].as_f64().expect("settling window");
    let output_s = gates["outputInterval_s"].as_f64().expect("output interval");
    let thresholds: Vec<f64> = CREDITED
        .iter()
        .map(|c| {
            settling[c.key]
                .as_f64()
                .unwrap_or_else(|| panic!("settling.{}", c.key))
        })
        .collect();
    let cap_s = env_f64("LD01_S3_SETTLE_CAP_S");
    let cpu_cap_s = env_f64("LD01_S3_SETTLE_CPU_CAP_S");
    let dir = PathBuf::from(env("LD01_S3_SETTLE_DIR"));
    assert!(!dir.exists(), "never overwritten: {}", dir.display());
    std::fs::create_dir_all(&dir).unwrap();
    let samples_per_window = (window_s / output_s).round() as usize;
    let (packet_path, packet_bytes) = spine::packet_bytes();
    let packet_sha256 = spine::sha256(&packet_bytes);
    let network_packet: NetworkPacket =
        serde_json::from_slice(&packet_bytes).expect("network packet");
    let face = |id: &str| {
        network_packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .unwrap_or_else(|| panic!("face {id}"))
    };
    let loops = [face("RETURN.A->DOWN"), face("RETURN.B->DOWN")];
    let from_path = env("LD01_S3_SETTLE_FROM");
    let from = read_json(&from_path);
    assert_eq!(
        from["packet"].as_str(),
        Some(packet_path.as_str()),
        "the S2 settled state of another packet"
    );
    let vector = |k: &str| -> Vec<f64> {
        from[k]
            .as_array()
            .unwrap_or_else(|| panic!("{k}"))
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect()
    };
    let (y, yp) = (vector("y"), vector("yp"));
    let t0 = from["t_s"].as_f64().expect("t_s");
    let ic_path = env("LD01_IC_SECTION");
    let ic: IcSection = serde_json::from_value(read_json(&ic_path)).expect("ic section");
    let frame = Frame::new(ic.frame_s).unwrap();
    assert!(
        (t0 / ic.frame_s - (t0 / ic.frame_s).round()).abs() < 1e-9,
        "C1's start is a frame instant (the control channel commissions there)"
    );

    // The operator: the feed gate declared before any structure (S3-D27),
    // the derived classes at the start state (S2-D24r/S3-D16).
    let Started {
        mut joined,
        network_ids,
        mut atol,
        rtol,
        ..
    } = started_full_composition();
    assert_eq!(y.len(), joined.dimension());
    assert!(
        joined.network.spray().is_some(),
        "the S3 packet composes the spray line"
    );
    joined.declare_feed_gate().expect("the feed gate");
    let structure = JoinedJacobian::compile_for(&mut joined, t0, &y, None).expect("structure");
    let credited = credited_outputs(&joined);
    let derived = derived_tolerances(
        &mut joined,
        &structure,
        t0,
        &y,
        &yp,
        rtol,
        &credited,
        &mut atol,
    )
    .expect("S2-D24r / S3-D16 derived classes at the start state");
    joined.declare_credited(credited).expect("credited outputs");
    // IC-CTRL's control in AUTO, commissioned at the start state.
    let control_path = env("LD01_PZR_CONTROL_SECTION");
    let control_section: ControlSection =
        serde_json::from_value(read_json(&control_path)).expect("control section");
    let law = Law::new(&control_section).unwrap();
    assert_eq!(
        law.frame_s(),
        ic.frame_s,
        "the control frame is the I&C frame"
    );
    let control_wiki = env("LD01_PZR_CONTROL_WIKI");
    let channel = pzr_control::channel_block(&control_wiki, &law);
    let (mut control, prepared_w, start_w) =
        pzr_control::commission(&mut joined, &law, channel, Class::S, None, t0, &y, &yp);
    // L1 and the phase modes armed at the start state.
    let l1 = joined.activate_unilateral(t0, &y).expect("L1");
    joined.activate_phase_modes().expect("phase modes");
    let ids = joined.differential(&network_ids);
    let n = joined.dimension();
    let nonnegative = joined.network.nonnegative_stocks();
    let presence = VaporPresence::of(&joined.network, &joined.network.declared_presence(&y));
    let integrated = Integrated::following_presence(joined, t0, &y, &presence).expect("integrable");

    // ELEC's slice appended, connected at full load.
    let elec_path = env("ELEC_PACKET");
    let e = read_json(&elec_path);
    let rotors = integrated.integrated().joined.network.rotor_count();
    let (slice, breaker, routing, configuration, mut tail) = electrical(&e, rotors, t0);
    let mut unit = Electrified::new(integrated, slice, breaker, routing, configuration)
        .expect("the electrical slice");
    let mut tail_rates = [0.; N];
    let tail_ids = unit
        .appended_start(t0, &mut tail, &mut tail_rates)
        .expect("the slice's prepared start");
    let v_line = f(&e, &["boundary", "lineVoltage_V"]);
    let f0 = f(&e, &["boundary", "frequency_Hz"]);
    let s_flux = v_line / (2. * std::f64::consts::PI * f0);
    let s_cur = f(&e, &["boundary", "base_VA"]) / v_line;
    let mut slice_atol = vec![
        1e-8 * s_flux,
        1e-8 * s_flux,
        1e-8 * tail[2].abs(),
        1e-8 * s_cur,
        1e-8 * s_cur,
        1e-8 * f(&e, &["prepared", "fieldCurrent_A"]),
        1e-8 * tail[slice::OMEGA],
        1e-8,
        1e-8 * tail[slice::BODY],
    ];
    // S3-D23 declares the electrical budgets (10 A, 1 MW) for S3-D16.
    let budget = CreditedBudget {
        ieq_a: 10.,
        export_w: 1e6,
    };
    let stator = unit.derived_rows(n, &slice_atol, budget);
    for r in &stator {
        slice_atol[r.coordinate - n] = r.applied_scaled;
    }
    let mut y_all = [y.as_slice(), &tail].concat();
    let mut yp_all = [yp.as_slice(), &tail_rates].concat();
    let ids_all = [ids.as_slice(), &tail_ids].concat();
    let atol_all = [atol.as_slice(), &slice_atol].concat();
    let restart = Restart {
        newton_coefficient: NEWTON_COEFFICIENT,
        delta_cj_lsetup: DELTA_CJ_LSETUP,
        first_step_s: FIRST_STEP_S,
        start_bound: 1e-12,
        start_passes: 2,
        transaction_passes: 12,
        bound_placement: 1e-12,
    };
    let mut ida = Ida::new(
        unit,
        Initial {
            time: t0,
            y: &y_all,
            yp: &yp_all,
            differential: &ids_all,
            absolute_tolerance: &atol_all,
            relative_tolerance: rtol,
        },
    )
    .expect("stock IDA");
    ida.set_max_order(MAX_ORDER).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    restart.configure(&mut ida).unwrap();
    // S3-D35: the settle's declared maximum step, from the S3 block.
    let declaration_path = env("LD01_S3_DECLARATION");
    let declaration_text = std::fs::read_to_string(&declaration_path).expect("the S3 declaration");
    let settle_max_step_s = s3_unit::cases_block(&declaration_text)
        .and_then(|b| s3_unit::settle_max_step(&b))
        .unwrap_or_else(|e| panic!("S3-D35: {e}"));
    ida.set_max_step(settle_max_step_s).unwrap();
    root_directions(&mut ida).unwrap();
    // The commissioned demand, L1's identity and the slice in force: the
    // exact consistent start at t0.
    let initial = discrete_restart(
        &mut ida,
        t0,
        Discrete::TimeEvent,
        &mut y_all,
        &network_ids,
        &atol_all,
        rtol,
        &restart,
    )
    .expect("the exact consistent start of the S3 composition");
    yp_all.clone_from(&initial.yp);
    control.scratch = vec![0.; y_all.len()];
    let preparation_cpu_s = z1::cpu_s() - started;

    // S3-D34: the class-S jump diagnostic is the harness's, not this run's.
    let mut driver = Driver::new(frame, Diagnostic::None, z1::cpu_s, t0).unwrap();
    let setup = Setup {
        network_ids: &network_ids,
        absolute: &atol_all,
        relative: rtol,
        restart,
        derived: &derived,
    };
    let mut window: std::collections::VecDeque<Vec<Vec<f64>>> = std::collections::VecDeque::new();
    window.push_back(observe(
        &mut ida.system_mut().integrated_mut().joined,
        &network_packet,
        &loops,
        t0,
        &y_all[..n],
        &yp_all[..n],
    ));
    let mut t = t0;
    let mut k: u64 = 0;
    let mut verdict = Value::Null;
    let mut failure: Option<String> = None;
    let mut last_ranges: Vec<(f64, f64, bool)> = Vec::new();
    let mut history: Vec<Value> = Vec::new();
    let checks_every = (1. / output_s).round() as u64;
    let heater = |ida: &Ida<Unit>| {
        ida.system()
            .integrated()
            .joined
            .pzr()
            .map_or(f64::NAN, |b| b.request_w())
    };
    {
        let mut clients: Vec<&mut dyn Client<Unit>> = vec![&mut control];
        if let Err(e) = driver.start(&mut clients, t0, &y_all, &yp_all) {
            failure = Some(format!("driver start: {e}"));
        }
        while failure.is_none() {
            if z1::cpu_s() - started > cpu_cap_s {
                failure = Some(format!("CPU cap {cpu_cap_s} s reached at t = {t} s"));
                break;
            }
            if t - t0 >= cap_s {
                failure = Some(format!(
                    "simulated cap {cap_s} s reached before the thresholds held"
                ));
                break;
            }
            k += 1;
            let next = t0 + k as f64 * output_s;
            if let Err(e) = driver.run(
                &mut ida,
                t,
                next,
                &mut y_all,
                &mut yp_all,
                &mut clients,
                &setup,
            ) {
                failure = Some(format!("frame driver from {t} s to {next} s: {e}"));
                break;
            }
            t = next;
            let c = observe(
                &mut ida.system_mut().integrated_mut().joined,
                &network_packet,
                &loops,
                t,
                &y_all[..n],
                &yp_all[..n],
            );
            window.push_back(c.clone());
            while window.len() > samples_per_window + 1 {
                window.pop_front();
            }
            if k.is_multiple_of(checks_every) && window.len() == samples_per_window + 1 {
                let w: Vec<Vec<Vec<f64>>> = window.iter().cloned().collect();
                let rs = ranges(&w, output_s, &thresholds);
                if k.is_multiple_of(checks_every * 10) {
                    history.push(json!({"t_s": t, "credited": CREDITED.iter().zip(&c).map(|(q, v)| (q.name.to_string(), json!(v))).collect::<Map<String, Value>>(),
                        "ranges": CREDITED.iter().zip(&rs).map(|(q, r)| (q.name.to_string(), json!([r.0, r.1, r.2]))).collect::<Map<String, Value>>(),
                        "cpu_s": z1::cpu_s() - started, "heater_w": heater(&ida)}));
                    eprintln!(
                        "S3 settle t = {t:.1} s: PT1 range {:.1} Pa, P = {:.6e} W, heater {:.0} W, CPU {:.1} s",
                        rs[3].0,
                        c[0][0],
                        heater(&ida),
                        z1::cpu_s() - started
                    );
                }
                last_ranges = rs.clone();
                if rs.iter().all(|r| r.2) {
                    verdict = json!({"settled_at_s": t, "settled_after_s": t - t0, "window_s": window_s,
                        "ranges": CREDITED.iter().zip(&rs).map(|(q, r)| (q.name.to_string(), json!({"range": r.0, "threshold": r.1, "holds": r.2}))).collect::<Map<String, Value>>()});
                    break;
                }
            }
        }
    }
    driver.close_segment(&ida, t).ok();
    let total_cpu_s = z1::cpu_s() - started;
    // The state handed on is the solver's own at the settled sample: the
    // driver stops at every output time, so the last accepted step ends
    // there (never an interpolant inside a longer step).
    if failure.is_none() {
        assert!(
            (driver.solver_reached_s - t).abs() <= 1e-9 * t.abs().max(1.),
            "the settle's state at {t} s is not the solver's (it reached {} s)",
            driver.solver_reached_s
        );
    }
    let snapshot = ida.system().system_discrete_state();
    let state = json!({"t_s": t, "packet": packet_path, "packet_sha256": packet_sha256,
        "y": &y_all[..n], "yp": &yp_all[..n], "y_bits": bits(&y_all[..n]), "yp_bits": bits(&yp_all[..n]),
        "appended": {"owner": "electrical slice (ELEC)", "y": &y_all[n..], "yp": &yp_all[n..],
            "y_bits": bits(&y_all[n..]), "yp_bits": bits(&yp_all[n..])},
        "discrete_state": snapshot,
        "pzr_control": {"in_force_w": control.in_force_w, "note": "C1 re-commissions the controller at its start (the heater demand in force is the PZR block's discrete state)"},
        "composition": "S3-D28 (3): joined + spray closed + SG two-zone + feed gate declared/open + S2-D24r/S3-D16 + L1 + phase modes + PZR control AUTO (S) + ELEC slice connected"});
    let state_bytes = serde_json::to_vec(&state).unwrap();
    let state_file = dir.join("s3-settled-state.json");
    std::fs::write(&state_file, &state_bytes).unwrap();
    let totals: Map<String, Value> = COUNTER_NAMES
        .iter()
        .zip(driver.totals)
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let receipt = json!({
        "kind": "s3-settle-state",
        "status": "NOT evidence: S3 is not declared; C1's initial condition (lead decision S3-D28 (3))",
        "provenance": spine::provenance(),
        "packet": packet_path, "packet_sha256": packet_sha256,
        "from": {"path": from_path, "t_s": t0},
        "sections": {"ic": ic_path, "pzr_control": control_path, "control_wiki": control_wiki, "electrical": elec_path},
        "gates": {"source": gates_path, "sha256": spine::sha256(gates_text.as_bytes()), "settling": settling, "outputInterval_s": output_s},
        "configuration": {"max_order": MAX_ORDER, "newton_coefficient": NEWTON_COEFFICIENT, "delta_cj_lsetup": DELTA_CJ_LSETUP,
            "settle_max_step_s": settle_max_step_s,
            "settle_max_step_rule": "S3-D35: the S3 block's settling.maxStep_s, settling phase only; the state handed on is the solver's at the settled sample",
            "s3_declaration": {"path": declaration_path, "sha256": spine::sha256(declaration_text.as_bytes())},
            "first_step_s": FIRST_STEP_S, "relative_tolerance": rtol, "frame_s": ic.frame_s,
            "integration": "frame driver: stock IDA_ONE_STEP, observation from IDAGetDky, restarts by discrete_restart",
            "derived_tolerances": derived, "stator_rows": stator, "stator_budget": "S3-D23: 10 A, 1 MW",
            "l1_activation_changes": l1.changes.len(), "pzr_control": {"class": "S (S3-D4)", "prepared_request_w": prepared_w, "start_request_w": start_w},
            "caps": {"simulated_s": cap_s, "process_cpu_s": cpu_cap_s},
            "measure": {"filter": filter::DECLARED_FILTER, "cutoff_hz": CREDITED_BAND_HZ, "sampled_s": output_s, "window_s": window_s}},
        "start": {"projection_passes": initial.report.projection_passes, "residual": initial.report.residual.value,
            "correction_wrms": initial.report.correction_wrms, "appended": initial.appended},
        "verdict": verdict, "failure": failure, "reached_s": t,
        "last_ranges": CREDITED.iter().zip(&last_ranges).map(|(q, r)| (q.name.to_string(), json!({"range": r.0, "threshold": r.1, "holds": r.2}))).collect::<Map<String, Value>>(),
        "state": {"file": "s3-settled-state.json", "sha256": spine::sha256(&state_bytes)},
        "counts_by_class": driver.counts.json(), "stock_totals": totals, "observation": driver.observation_json(),
        "pzr_control_changes": control.schedule.len().saturating_sub(1),
        "cpu": {"process_total_s": total_cpu_s, "preparation_s": preparation_cpu_s, "solver_s": driver.cpu.solver_s,
            "observation_s": driver.cpu.observation_s, "restart_s": driver.cpu.restart_s, "held_s": driver.cpu.held_s,
            "per_simulated_s": (total_cpu_s - preparation_cpu_s) / (t - t0).max(1e-9)},
        "electrical_log": ida.system().log,
        "history_every_10_s": history,
        "restart_instants": driver.log.iter().filter(|e| e["class"] == "R").cloned().collect::<Vec<_>>(),
    });
    std::fs::write(
        dir.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    println!(
        "{}",
        json!({"verdict": receipt["verdict"], "failure": receipt["failure"], "reached_s": t, "counts": receipt["stock_totals"],
            "classes": receipt["counts_by_class"], "cpu": total_cpu_s})
    );
    assert!(failure.is_none(), "the S3 settle failed: {failure:?}");
}

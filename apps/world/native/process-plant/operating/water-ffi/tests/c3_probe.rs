//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/reversible-pump-model.md#fluid-and-rotor-energy-accounting
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#e2b-resolved-11-october-delegated
//! A C3-like network probe for the R3 pump-off question (NOT EVIDENCE, not
//! P-3a): the S1 network (L1 active), its RCPs started from rest and run to
//! a settled flow, then one pump's supply lost (S1's supply-loss rotor, the
//! `ld01-s1-gates` `supplyLoss.rotor`) at a non-integer time with the other
//! three running, for C3's 60 s. It measures what C3 needs from the pump-off
//! laws the wiki selects:
//! - the reversible pump model on the idle branch: its flow reversal, the
//!   rotor's coastdown and any reverse rotation;
//! - E2b's exact donor at zero flow: donor flips of every free path between
//!   accepted states (`phase_events::DonorFlips`, class O);
//! - the exact supply-loss transaction (no coordinate moves; the rotor row
//!   changes), the restart count and the cost;
//! - conservation: inventory (mass, tracer, fluid energy, rotor energy) at
//!   the loss and at the end, and the rate identities at every sample;
//! - loop-A flow against C3's 0.70 line and core DP (the rod passages' R3
//!   band is far from any C3 current; the joined spine reports it).
//!
//! Tolerances are S1's declared classes (`ld01-s1-gates`), the rotor's
//! scaled class included; the receipt lists the steps the idle rotor spends
//! where its absolute class dominates (S3-D16's question for that class).
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        Network, RotorState, ToleranceClasses, Tolerances, consistent_start,
        packet::Packet,
        phase_events::DonorFlips,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Ida, Initial},
    network::Integrated,
};
use serde_json::{Value, json};

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
fn cpu_s() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer. 16 is CLOCK_THREAD_CPUTIME_ID on macOS.
    let status = unsafe { clock_gettime(16, &mut t) };
    assert_eq!(status, 0, "thread CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}
fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text.find(&open).expect("strict block") + open.len();
    let end = start + text[start..].find("\n```").expect("unterminated block");
    serde_json::from_str(&text[start..end]).expect("strict block JSON")
}
fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

/// One sample's readings at an observed state.
fn read(
    network: &mut Network<If97>,
    t: f64,
    y: &[f64],
    yp: &[f64],
    faces: &[(String, usize)],
    lower: usize,
    upper: usize,
) -> Value {
    if let Err(e) = network.evaluate(t, y, yp, None, 0., None) {
        return json!({"t":t,"error":format!("{e:?}")});
    }
    let budget = network.current_budget(y, yp);
    let flows: serde_json::Map<String, Value> = faces
        .iter()
        .map(|(id, f)| {
            (
                id.clone(),
                json!(network.chart(*f, 0).map(|c| c.mass_flow_kg_s.value)),
            )
        })
        .collect();
    let omega: Vec<f64> = network
        .rotor_index
        .iter()
        .map(|i| y[*i] * network.scales()[*i] / network.rotor_inertia())
        .collect();
    json!({"t":t,"flows_kg_s":flows,"omega_rad_s":omega,
        "core_dp_pa":network.cell(lower).pressure.value-network.cell(upper).pressure.value,
        "mass_rate_sum_kg_s":budget["mass_receipt_sum_kg_s"],"mass_rate_abs_kg_s":budget["mass_receipt_abs_sum_kg_s"],
        "boron_rate_sum":budget["boron_receipt_sum_kg_eq_s"],
        "energy_identity_w":budget["fluid_plus_rotor_plus_bearing_minus_motor_w"],"energy_identity_terms_w":budget["identity_terms_abs_sum_w"],
        "bearing_loss_w":budget["bearing_loss_w"],"motor_work_w":budget["motor_work_w"],"shaft_power_w":budget["once_paid_shaft_power_w"]})
}

#[test]
#[ignore = "C3-like network probe, NOT EVIDENCE: needs the spine packet (LD01_OPERATING_HOT_SPINE_PACKET), the wiki, maintained IF97 and stock IDA/KLU"]
fn c3_single_rcp_supply_loss_network_probe() {
    let packet_path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").expect("packet");
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let settle_s: f64 = std::env::var("LD01_C3_SETTLE_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150.);
    let pages = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01");
    let gates = strict_block(
        &format!("{pages}/model/build-readiness.md"),
        "ld01-s1-gates",
    );
    let s2 = strict_block(
        &format!("{pages}/model/build-readiness.md"),
        "ld01-s2-gates",
    );
    let p2 = strict_block(
        &format!("{pages}/systems/primary-coolant/pressurizer-thermal-state.md"),
        "ld01-p2-cases",
    );
    let raw: Value = serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).unwrap();
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let regions: Vec<String> = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let face_ids: Vec<String> = raw["mechanics"]["faces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap().to_string())
        .collect();
    let face = |id: &str| face_ids.iter().position(|f| f == id).expect(id);
    let region = |id: &str| regions.iter().position(|r| r == id).expect(id);
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    let lost = gates["supplyLoss"]["rotor"].as_u64().unwrap() as usize;
    let duration_s = 60.; // C3: 60 s from the loss (window 30 s, E2)
    let t_loss = settle_s + 0.37; // a non-integer time, as C3's t0
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let supported = RotorState {
        support: Support::Supported(SpeedRequest::Nominal),
        shaft: Shaft::Free,
    };
    let settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let started = cpu_s();
    let (mut net, prepared, _) =
        prepare::prepare(&packet, If97, &point, &[supported; 4], &settings).expect("preparation");
    let mut y = prepared.y.clone();
    for index in &net.rotor_index {
        y[*index] = 0.;
    }
    let classes = ToleranceClasses {
        relative: f("relativeTolerance"),
        stock_scaled: f("stockScaledAbsolute"),
        tracer_scaled: f("tracerScaledAbsolute"),
        rotor_scaled: f("rotorScaledAbsolute"),
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
    };
    let atol = net.absolute_tolerances(&y, classes).expect("tolerances");
    let rtol = classes.relative;
    let max_order = gates["maxOrder"].as_u64().unwrap() as usize;
    let first_step = p2["eventRestartFirstStep_s"].as_f64().unwrap();
    let dcj = s2["deltaCjLSetup"].as_f64().expect("deltaCjLSetup");
    let coefficient = s2["newtonCoefficient"].as_f64().expect("newtonCoefficient");
    // L1 declared active on the prepared all-liquid state (S3 runs).
    let zero = vec![0.; y.len()];
    net.evaluate(0., &y, &zero, None, 0., None)
        .expect("prepared evaluation");
    let presence = net.stock_presence(&y);
    let activation = net.activate_unilateral(&presence).expect("L1");
    let ids = net.differential(&prepared.differential);
    let weights = error_weights(&y, rtol, &atol);
    let (mut yp, pair) =
        consistent_start(&mut net, 0., &mut y, &ids, &weights, 1e-12, 2).expect("start");
    let nonnegative = net.nonnegative_stocks();
    let lost_index = net.rotor_index[lost];
    let lost_region = regions[raw["hydraulics"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["parameters"]["pump"].is_object())
        .nth(lost)
        .unwrap()["region"]
        .as_u64()
        .unwrap() as usize]
        .clone();
    let idle_faces: Vec<usize> = face_ids
        .iter()
        .enumerate()
        .filter(|(_, id)| id.contains(lost_region.as_str()))
        .map(|(j, _)| j)
        .collect();
    let mut watched: Vec<(String, usize)> = ["RETURN.A->DOWN", "RETURN.B->DOWN"]
        .iter()
        .map(|id| (id.to_string(), face(id)))
        .collect();
    watched.extend(idle_faces.iter().map(|j| (face_ids[*j].clone(), *j)));
    let (lower, upper) = (region("LOWER"), region("UPPER"));
    let mut ida = Ida::new(
        Integrated::colored(net).expect("colored"),
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .expect("IDA");
    ida.set_max_order(max_order).unwrap();
    ida.set_nonlinear_convergence_coefficient(coefficient)
        .unwrap();
    ida.set_delta_cj_lsetup(dcj).unwrap();
    ida.constrain_nonnegative(&nonnegative).unwrap();
    ida.stop_at(t_loss).unwrap();
    // Settle with all four RCPs from rest.
    let mut settle = Vec::new();
    for k in 1..=((settle_s / 10.) as usize) {
        let target = 10. * k as f64;
        match ida.advance(target, &mut y, &mut yp).expect("settle") {
            Advance::Reached(_) => {}
            Advance::Root { .. } => panic!("no roots are declared"),
        }
        let s = read(
            &mut ida.system_mut().network,
            target,
            &y,
            &yp,
            &watched,
            lower,
            upper,
        );
        settle
            .push(json!({"t":target,"flows_kg_s":s["flows_kg_s"],"omega_rad_s":s["omega_rad_s"]}));
    }
    let settle_stats = ida.stats().unwrap();
    let settle_cpu = cpu_s() - started;
    match ida.advance(t_loss, &mut y, &mut yp).expect("to the loss") {
        Advance::Reached(t) => assert_eq!(t, t_loss),
        Advance::Root { .. } => panic!("no roots are declared"),
    }
    let before = read(
        &mut ida.system_mut().network,
        t_loss,
        &y,
        &yp,
        &watched,
        lower,
        upper,
    );
    let nominal_a = before["flows_kg_s"]["RETURN.A->DOWN"].as_f64().unwrap();
    let nominal_b = before["flows_kg_s"]["RETURN.B->DOWN"].as_f64().unwrap();
    let inventory = |net: &Network<If97>, y: &[f64]| {
        net.inventory(
            y,
            Tolerances {
                relative: rtol,
                absolute: &atol,
            },
        )
        .expect("inventory")
        .0
    };
    // The supply-loss transaction: the lost rotor's support only; no
    // coordinate moves. Then the exact consistent start and a stock restart.
    let transaction_cpu = cpu_s();
    let y_before = y.clone();
    let inv_before = inventory(&ida.system().network, &y);
    ida.system_mut().network.set_rotor_state(
        lost,
        RotorState {
            support: Support::Unsupported,
            shaft: Shaft::Free,
        },
    );
    let ids_after = ida.system().network.differential(&prepared.differential);
    let weights = error_weights(&y, rtol, &atol);
    let restart = consistent_start(
        &mut ida.system_mut().network,
        t_loss,
        &mut y,
        &ids_after,
        &weights,
        1e-12,
        2,
    )
    .expect("supply-loss start");
    yp = restart.0;
    let differential_bitwise = y
        .iter()
        .zip(&y_before)
        .zip(&ids_after)
        .filter(|(_, id)| **id == 1.)
        .all(|((a, b), _)| a.to_bits() == b.to_bits());
    let inv_start = inventory(&ida.system().network, &y);
    ida.reinitialize(t_loss, &y, &yp).unwrap();
    ida.set_init_step(first_step).unwrap();
    let end = t_loss + duration_s;
    ida.stop_at(end).unwrap();
    let transaction_s = cpu_s() - transaction_cpu;
    // Stock counters restart with the reinitialized segment (its first
    // solve), so the post-loss counts are the handle's own.
    // Every accepted step: donor flips, the idle rotor and its class.
    let mut flips = DonorFlips::default();
    flips.observe(&ida.system().network, t_loss, &y);
    let rotor_floor = atol[lost_index];
    let mut floor_dominated_steps = 0_usize;
    let mut omega_min = f64::INFINITY;
    let mut reverse_rotation_at: Option<f64> = None;
    let mut idle_reversal_at: Vec<(String, f64)> = Vec::new();
    let mut a_below_070: Option<f64> = None;
    let mut a_min_ratio = f64::INFINITY;
    let mut samples = Vec::new();
    let mut identity_max = 0_f64;
    let mut mass_rate_max = 0_f64;
    let mut next_sample = t_loss;
    let window_end = t_loss + 30.;
    let mut window = None;
    let window_cpu = cpu_s();
    let mut t = t_loss;
    let (mut ys, mut yps) = (vec![0.; y.len()], vec![0.; y.len()]);
    let scale = ida.system().network.scales()[lost_index];
    let inertia = ida.system().network.rotor_inertia();
    while t < end {
        let advanced = ida.step(end, &mut y, &mut yp).expect("step");
        let tn = match advanced {
            Advance::Reached(tn) => tn,
            Advance::Root { .. } => panic!("no roots are declared"),
        };
        flips.observe(&ida.system().network, tn, &y);
        let l = y[lost_index];
        if l.abs() * rtol < rotor_floor {
            floor_dominated_steps += 1;
        }
        let omega = l * scale / inertia;
        omega_min = omega_min.min(omega);
        if omega < 0. && reverse_rotation_at.is_none() {
            reverse_rotation_at = Some(tn);
        }
        if window.is_none() && tn >= window_end {
            window = Some((ida.stats().unwrap(), cpu_s() - window_cpu));
        }
        // Samples on the 0.1 s grid from the dense output.
        while next_sample <= tn {
            ida.dense_output(next_sample, &mut ys, &mut yps)
                .expect("dense output");
            let s = read(
                &mut ida.system_mut().network,
                next_sample,
                &ys,
                &yps,
                &watched,
                lower,
                upper,
            );
            if let Some(a) = s["flows_kg_s"]["RETURN.A->DOWN"].as_f64() {
                let ratio = a / nominal_a;
                a_min_ratio = a_min_ratio.min(ratio);
                if ratio <= 0.70 && a_below_070.is_none() {
                    a_below_070 = Some(next_sample);
                }
            }
            for j in &idle_faces {
                let id = &face_ids[*j];
                if s["flows_kg_s"][id].as_f64().is_some_and(|q| q < 0.)
                    && !idle_reversal_at.iter().any(|(x, _)| x == id)
                {
                    idle_reversal_at.push((id.clone(), next_sample));
                }
            }
            let terms = s["energy_identity_terms_w"].as_f64().unwrap_or(0.);
            identity_max = identity_max
                .max(s["energy_identity_w"].as_f64().unwrap_or(f64::NAN).abs() / (1. + terms));
            mass_rate_max = mass_rate_max.max(
                s["mass_rate_sum_kg_s"].as_f64().unwrap_or(f64::NAN).abs()
                    / (1. + s["mass_rate_abs_kg_s"].as_f64().unwrap_or(0.)),
            );
            let coarse = ((next_sample - t_loss) * 10.).round() as i64;
            if coarse % 10 == 0 || next_sample < t_loss + 2. {
                samples.push(s);
            }
            next_sample = t_loss + (coarse + 1) as f64 * 0.1;
        }
        t = tn;
    }
    let total_cpu = cpu_s() - window_cpu;
    let stats = ida.stats().unwrap();
    let inv_end = inventory(&ida.system().network, &y);
    let delta = |a: [f64; 4], b: [f64; 4]| -> Vec<f64> { (0..4).map(|k| b[k] - a[k]).collect() };
    let stats_json = |s: &leitbild_operating_water::ida::Stats| json!({"steps":s.steps,"residuals":s.residuals,"jacobians":s.jacobians,"error_failures":s.error_failures,"convergence_failures":s.convergence_failures,"last_step_s":s.last_step,"last_order":s.last_order});
    let face_of = |li: usize| ida.system().network.face_layout[li].face;
    let flip_faces: Vec<Value> = flips
        .flips
        .iter()
        .enumerate()
        .filter(|(_, n)| **n > 0)
        .map(|(li, n)| json!({"face":face_ids[face_of(li)],"phase":li%2,"flips":n}))
        .collect();
    let receipt = json!({
        "kind":"ld01-r3-c3-network-probe-NOT-EVIDENCE",
        "provenance":std::env::var("LD01_R3_PROVENANCE").ok().and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "scope":"S1 network with L1 active; four RCPs from rest settled, then supply loss of supplyLoss.rotor with three running, 60 s; S1 tolerance classes; S2's dcj and Newton coefficient; colored Jacobian; exact supply-loss transaction; NOT P-3a, NOT evidence",
        "packet":packet_path,
        "config":{"rtol":rtol,"max_order":max_order,"first_step_after_event_s":first_step,"delta_cj_lsetup":dcj,"newton_coefficient":coefficient,"settle_s":settle_s,"t_loss_s":t_loss,"duration_s":duration_s,"lost_rotor":lost,"lost_pump_region":lost_region},
        "l1_activation":{"changes":activation.changes.len(),"paid_j":activation.energy_paid_j},
        "initial_start":{"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value},
        "settle":{"samples":settle,"stats":stats_json(&settle_stats),"cpu_s":settle_cpu},
        "before_loss":before,
        "transaction":{"restarts":1,"differential_coordinates_bitwise":differential_bitwise,"consistent_start":{"residual":restart.1.residual.value,"constraint_rate":restart.1.constraint_rate.value,"projection_wrms":restart.1.projection.as_ref().map(|p|p.correction_wrms),"passes":restart.1.projection.as_ref().map(|p|p.passes)},"cpu_s":transaction_s,
            "inventory_change_mass_tracer_energy_rotor":delta(inv_before,inv_start)},
        "after_loss":{
            "loop_a_min_ratio":a_min_ratio,"loop_a_first_at_or_below_070_s":a_below_070.map(|x|x-t_loss),
            "idle_branch_reversal_s":idle_reversal_at.iter().map(|(id,x)|json!([id,x-t_loss])).collect::<Vec<_>>(),
            "lost_rotor":{"omega_min_rad_s":omega_min,"reverse_rotation_from_s":reverse_rotation_at.map(|x|x-t_loss),"absolute_class":rotor_floor,"steps_where_absolute_class_dominates":floor_dominated_steps},
            "donor_flips":{"total":flips.total(),"accepted_states":flips.observations,"by_path":flip_faces,"events":flips.events.iter().map(|(x,li)|json!([x-t_loss,face_ids[face_of(*li)],li%2])).collect::<Vec<_>>()},
            "conservation":{"inventory_change_over_60s_mass_tracer_energy_rotor":delta(inv_start,inv_end),"inventory_at_loss":inv_start,"rate_identity_max_relative":identity_max,"mass_rate_sum_max_relative":mass_rate_max},
            "cost":{"window_30s":window.map(|(s,c)|json!({"steps":s.steps,"jacobians":s.jacobians,"error_failures":s.error_failures,"cpu_s":c,"cpu_s_per_s":c/30.})),"total_60s":{"steps":stats.steps,"jacobians":stats.jacobians,"error_failures":stats.error_failures,"convergence_failures":stats.convergence_failures,"cpu_s":total_cpu,"cpu_s_per_s":total_cpu/duration_s},"stats":stats_json(&stats)},
            "nominal_kg_s":{"loop_a":nominal_a,"loop_b":nominal_b},
        },
        "samples":samples,
        "cpu_s":cpu_s()-started,
    });
    if let Ok(path) = std::env::var("LD01_R3_RECEIPT") {
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipts are never overwritten: {path}"
        );
        std::fs::write(&path, serde_json::to_string_pretty(&receipt).unwrap()).expect("receipt");
    }
    println!(
        "{}",
        json!({"after_loss":receipt["after_loss"]["loop_a_min_ratio"],"below_070_s":receipt["after_loss"]["loop_a_first_at_or_below_070_s"],"reversal":receipt["after_loss"]["idle_branch_reversal_s"],"rotor":receipt["after_loss"]["lost_rotor"],"flips":receipt["after_loss"]["donor_flips"]["total"],"cost":receipt["after_loss"]["cost"]["total_60s"],"identity":receipt["after_loss"]["conservation"]["rate_identity_max_relative"],"cpu_s":receipt["cpu_s"]})
    );
    assert!(
        differential_bitwise,
        "the supply-loss transaction moved a differential coordinate"
    );
}

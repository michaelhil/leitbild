//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-treatment-of-uncredited-lumped-modes
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-design-choices-11-october-delegated
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/kinetics.md#post-trip-domain-extension
//! S2's zero-time spectral gate Z6 (G10) on the joined residual, with the
//! trip's excitations, and D3 (a)'s shutdown margin at the same state.
//!
//! These are zero-time receipts: one linearization, no time advanced. The
//! thresholds are S1's (`ld01-s1-gates` `spectrum`, G14). A receipt is
//! written only to a new path (`LD01_S2_SPECTRUM_RECEIPT`), never over a file.
//!
//! # The restriction (lead decision S2-D8)
//!
//! A dense pencil of all 18,603 coordinates does not fit (≈11–15 GB, hours of
//! `dggev`). Two pencils are decomposed instead, both from the joined
//! residual's own colored Jacobian at the state (`A = ∂F/∂y`,
//! `B = ∂F/∂y'`, the solver's scaled rows and coordinates):
//!
//! 1. **Restricted** (`R`): the network, both SG secondaries, the SG metal
//!    and the rod bodies with their guide passages (≈440 coordinates). The
//!    other blocks are frozen, declared explicitly:
//!    - every differential coordinate outside `R` (populations, precursors,
//!      inventories, histories, fuel, clad, helium and passive stores) is held
//!      at its state value: its perturbation is zero and its row is dropped;
//!    - every algebraic coordinate outside `R` (the clad and fuel surfaces)
//!      stays on its own constraint: it is eliminated exactly by the Schur
//!      complement of its block, `A_R = A_RR - A_Rs A_ss^-1 A_sR` (KLU), so
//!      the water sees the walls' instantaneous response at frozen stores.
//!      `B` has no entries in those rows or columns, which is checked.
//!
//!    The pencil with the surfaces held instead (a fixed-temperature wall) is
//!    reported as a sensitivity, not gated.
//! 2. **Coupled nuclear-thermal** (`K`, critic M3): a named restriction of
//!    the same Jacobian that keeps the feedback paths `R` freezes: the 24
//!    regional populations, every carrier's two fuel nodes (the Doppler
//!    functional reads them) and clad store (the heat path to the water), the
//!    network (moderator density, boron), the SG secondaries and metal, and
//!    the rods (rod reactivity). Surfaces are eliminated as in `R`.
//!    Everything else is held at zero perturbation: precursors, poison and
//!    fuel inventories, delayed-energy histories, helium and passive stores.
//!    The held linear blocks (precursors, inventories, histories) are diagonal
//!    in their own coordinates, so their own spectra are their decay
//!    constants (`-lambda`, checked and reported); what holding them drops is
//!    their coupling, chiefly the delayed-neutron return, so the check sees
//!    prompt kinetics. The count is set by the plant (24 + 772 + 386 + 261 +
//!    20 + 156 = 1,619), above the planned 1,000: `dggev` at that size is
//!    about a minute, on the same Accelerate path.
//!
//! Ungated sensitivities: `R` with the surfaces held (a fixed-temperature
//! wall), and the network alone (to attribute network-intrinsic modes).
//!
//! # Predicates (per pencil and state)
//!
//! - infinite modes equal the pencil's algebraic coordinates;
//! - no resolved positive real part;
//! - every marginal mode (sign of `Re λ` unresolved) is tied to a null
//!   direction: `|λ|` itself within its error bound, so `A v ≈ 0`;
//! - no mode above `fastModeHz` with damping below `lightDamping` excited
//!   above `maxExcitationRatio` times its tolerance by a trip event.
//!
//! The trip's events: (E1) the TURBINE TRIP's steam-demand ramp, taken as
//! its full step to zero demand (it bounds the ramp), on the held and the
//! released pencils; (E2) the holding opening, every cluster released, as the
//! residual change of the release at the unchanged state, on the released
//! pencil.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    digest::sha256,
    joined::{
        block::{Class, Command},
        operator::Joined,
        post_trip_domain::{self, Extension, Fixed},
    },
    source_feedback as sf,
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    joined::{Matrices, consistent_start},
    spectrum,
    unit::{
        clock::process_cpu_s,
        profile::error_weights,
        spine::{self, Prepared, S1Settling},
    },
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, time::Instant};
mod common;
use common::{cpu::load_average, s1_gates};
mod z6;
use z6::{Gate, Restriction, held_linear_blocks, judge, pencil, residual};

// ---------------------------------------------------------------------------
// The composed state: joined_spine.rs's Z1 recipe (started_full_composition),
// unchanged: S1's network-only settling exports the settled flows, the
// flowing preparation composes them at the hot reference, the owners and
// surfaces are prepared, and the exact consistent start projects the state.

fn provenance(packet_path: &str, packet_bytes: &[u8]) -> Value {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let wiki = std::env::var("LD01_WIKI_ROOT").ok();
    let water = std::env::var("LD01_OPERATING_WATER_LIB_DIR").ok();
    let water_receipt = water
        .as_ref()
        .and_then(|w| std::fs::read(Path::new(w).join("water-build.json")).ok())
        .map(|b| sha256(&b));
    json!({
        "app_commit": git(&["rev-parse", "HEAD"]),
        "app_worktree_dirty": !git(&["status", "--porcelain", "--untracked-files=no"]).is_empty(),
        "wiki": wiki,
        "wiki_commit": wiki.as_ref().map(|w| git(&["-C", w, "rev-parse", "HEAD"])),
        "packet": packet_path, "packet_sha256": sha256(packet_bytes),
        "water_build": water, "water_build_receipt_sha256": water_receipt,
        "sundials_prefix": std::env::var("LD01_OPERATING_SUNDIALS_PREFIX").ok(),
    })
}

struct Started {
    joined: Joined<If97>,
    raw: Value,
    t: f64,
    y: Vec<f64>,
    yp: Vec<f64>,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    receipt: Value,
}

/// The joined operator composed at the hot reference and exactly started;
/// with `LD01_S2_SPECTRUM_STATE` (`{packet, t_s, y, yp}`, the settling
/// probe's export) the state is that one instead, on the same operator.
fn started() -> Started {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the joined packet");
    let bytes = std::fs::read(&path).expect("packet");
    let raw: Value = serde_json::from_slice(&bytes).expect("packet json");
    let gates = s1_gates();
    let s1 = S1Settling::from_gates(&gates).expect("ld01-s1-gates");
    let network_packet = spine::packets(&bytes).expect("packet").network;
    // Steps (A)-(C) by the unit library's builder; the start below is this
    // probe's own (the colored reference).
    let settled =
        spine::s1_settled_flows(&network_packet, &s1, process_cpu_s).expect("S1 settling");
    let s1_summary = json!({
        "scope": "NOT-EVIDENCE: S1's declared network-only settling, run only to export settled flows (memo §3 (A))",
        "settled_at_s": settled.settled_at_s, "steps": settled.steps, "cpu_s": settled.cpu_s,
    });
    let Prepared {
        mut joined,
        mut y,
        ids,
        network_ids,
        atol,
        classes,
        flowing,
        ..
    } = spine::prepare(&bytes, &settled.flows, &settled.momenta, s1.classes, &[])
        .expect("steps (B)-(C)");
    let weights = error_weights(&y, classes.relative, &atol);
    let (yp, start) = consistent_start(
        &mut joined,
        // The start's matrices since S2-D4 (6d1ee9be): the colored
        // reference, as this probe ran before; blocks are the production's.
        Matrices::Colored,
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        3,
    )
    .expect("exact consistent start");
    let mut receipt = json!({
        "provenance": provenance(&path, &bytes),
        "s1_settling": s1_summary, "flowing_preparation_max_cycle_drive_pa": flowing["max_cycle_drive_pa"].clone(),
        "composed_start": {"residual": [start.residual.value, start.residual.row], "constraint_rate": [start.constraint_rate.value, start.constraint_rate.row],
            "correction_wrms": start.correction_wrms, "projection_passes": start.projection_passes},
    });
    let (t, y, yp) = match std::env::var_os("LD01_S2_SPECTRUM_STATE") {
        None => {
            receipt["state"] = json!({"kind": "composed", "t_s": 0.});
            (0., y, yp)
        }
        Some(file) => {
            let bytes = std::fs::read(&file).expect("state file");
            let state: Value = serde_json::from_slice(&bytes).expect("state json");
            let v = |k: &str| -> Vec<f64> {
                serde_json::from_value(state[k].clone()).unwrap_or_else(|_| panic!("state {k}"))
            };
            let (ys, yps) = (v("y"), v("yp"));
            assert_eq!(ys.len(), y.len(), "state dimension");
            assert_eq!(
                state["packet"].as_str(),
                Some(path.as_str()),
                "state packet"
            );
            let t = state["t_s"].as_f64().expect("t_s");
            receipt["state"] = json!({"kind": "file", "file": file.to_string_lossy(), "sha256": sha256(&bytes), "t_s": t});
            (t, ys, yps)
        }
    };
    Started {
        joined,
        raw,
        t,
        y,
        yp,
        network_ids,
        atol,
        rtol: classes.relative,
        receipt,
    }
}

fn write_receipt(receipt: &Value) {
    if let Some(path) = std::env::var_os("LD01_S2_SPECTRUM_RECEIPT") {
        let path = Path::new(&path);
        assert!(
            !path.exists(),
            "receipts are never overwritten: {}",
            path.display()
        );
        std::fs::write(path, serde_json::to_vec_pretty(receipt).unwrap()).unwrap();
    }
}

/// D3 (a)'s record: the packet's `post_trip_domain` section, or for a packet
/// compiled before it (9eb6e37d) the source compiler's output for the same
/// wiki in the file `LD01_POST_TRIP_DOMAIN`.
fn extension(raw: &Value) -> (Extension, Value) {
    if raw.get("post_trip_domain").is_some() {
        let e = serde_json::from_value(raw["post_trip_domain"].clone()).expect("post_trip_domain");
        return (e, json!({"source": "packet section post_trip_domain"}));
    }
    let file = std::env::var("LD01_POST_TRIP_DOMAIN")
        .expect("pre-D3 packet: LD01_POST_TRIP_DOMAIN names the compiled post_trip_domain section");
    let bytes = std::fs::read(&file).expect("post-trip domain file");
    (
        serde_json::from_slice(&bytes).expect("post-trip domain record"),
        json!({"source": "compiled section file (pre-D3 packet)", "file": file, "sha256": sha256(&bytes)}),
    )
}

/// The margin `delta*` (Δk/k) of D3's operator: `alpha(M + delta* G) = 0`,
/// the smallest real eigenvalue of the pencil `(M, diag(G))` (`dggev`).
fn margin_value(m: &post_trip_domain::Margin) -> f64 {
    let r = m.reactivity_gain.len();
    let mut g = vec![0.; r * r];
    for i in 0..r {
        g[i * r + i] = m.reactivity_gain[i];
    }
    let s = spectrum::decompose(r, &m.operator, &g).expect("margin pencil");
    s.modes
        .iter()
        .map(|x| x.lambda.re)
        .fold(f64::INFINITY, f64::min)
}

#[test]
#[ignore = "zero-time receipt: requires the joined packet, the wiki, maintained IF97, stock IDA/KLU and Accelerate"]
fn z6_restricted_and_coupled_spectrum_with_the_trip_excitations() {
    let wall = Instant::now();
    let cpu0 = process_cpu_s();
    let Started {
        mut joined,
        t,
        y,
        yp,
        network_ids,
        atol,
        rtol,
        mut receipt,
        ..
    } = started();
    let gates = s1_gates();
    let gate = Gate {
        fast_mode_hz: gates["spectrum"]["fastModeHz"].as_f64().unwrap(),
        light_damping: gates["spectrum"]["lightDamping"].as_f64().unwrap(),
        max_excitation_ratio: gates["spectrum"]["maxExcitationRatio"].as_f64().unwrap(),
    };
    let composed_cpu = process_cpu_s() - cpu0;
    let o = joined.offsets();
    let n = joined.dimension();
    let labels: Vec<String> = joined
        .layouts()
        .into_iter()
        .flat_map(|(owner, l)| l.labels.into_iter().map(move |x| format!("{owner}/{x}")))
        .collect();
    let classes: Vec<Class> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.classes)
        .collect();
    let tolerance = spectrum::tolerance(rtol, &y, &atol).expect("tolerance");
    // The restriction: network, secondary, rods, SG metal; surfaces eliminated.
    let keep: Vec<usize> = (0..n)
        .filter(|&i| {
            i < o.nuclear || i >= o.secondary || (i >= o.solids && classes[i] == Class::MetalEnergy)
        })
        .collect();
    let surfaces: Vec<usize> = (o.solids..o.secondary)
        .filter(|&i| classes[i] == Class::Surface)
        .collect();
    // The coupled restriction: regional N, fuel and clad stores, network,
    // SG secondaries and metal, rods; surfaces eliminated; the rest held.
    let coupled: Vec<usize> = (0..n)
        .filter(|&i| {
            keep.contains(&i)
                || matches!(
                    classes[i],
                    Class::RegionalPopulation | Class::FuelEnergy | Class::CladEnergy
                )
        })
        .collect();
    let network_only: Vec<usize> = (0..o.nuclear).collect();
    let (pointers, indices) = {
        let p = &joined.structure().unwrap().0;
        (p.pointers().to_vec(), p.indices().to_vec())
    };
    let owner_of = |i: usize| {
        if i < o.nuclear {
            "network"
        } else if i < o.solids {
            "nuclear"
        } else if i < o.secondary {
            "solids"
        } else if i < o.rods {
            "secondary"
        } else {
            "rods"
        }
    };
    let by_owner = |v: &[f64]| -> Value {
        let mut m: BTreeMap<&str, f64> = BTreeMap::new();
        for (i, x) in v.iter().enumerate() {
            let e = m.entry(owner_of(i)).or_insert(0.);
            *e = e.max(x.abs() / tolerance[i]);
        }
        json!(m)
    };

    // The held pencil at the state, then the TURBINE TRIP.
    let f_state = residual(&mut joined, t, &y, &yp);
    let ids_held = joined.differential(&network_ids);
    let (a0, b0) = pencil(&mut joined, t, &y, &yp);
    let mut y_cmd = y.clone();
    let done = joined
        .command(t, &mut y_cmd, Command::TurbineTrip)
        .expect("TURBINE TRIP");
    assert_eq!(y_cmd, y, "the command changes no coordinate");
    let open = joined.next_time_event(t).expect("the holding opening");
    let f_cmd = residual(&mut joined, t, &y, &yp);
    // The ramp end follows the opening; its full step bounds the ramp (E1).
    let ramp_end = {
        let rods_next = joined.rods().unwrap().next_time_event(t);
        let sg_next = joined.secondary().unwrap().next_time_event(t);
        assert_eq!(rods_next, Some(open));
        sg_next.expect("the steam-demand ramp end")
    };
    let f_ramped = residual(&mut joined, ramp_end, &y, &yp);
    let e1: Vec<f64> = f_ramped.iter().zip(&f_cmd).map(|(a, b)| a - b).collect();
    // The holding opening (E2) at the unchanged state.
    let f_held_open = residual(&mut joined, open, &y, &yp);
    let mut y_open = y.clone();
    let released = joined.time_events(open, &mut y_open).expect("opening");
    assert_eq!(y_open, y, "the release changes no coordinate");
    let ids_open = joined.differential(&network_ids);
    let f_released = residual(&mut joined, open, &y, &yp);
    let e2: Vec<f64> = f_released
        .iter()
        .zip(&f_held_open)
        .map(|(a, b)| a - b)
        .collect();
    let (a1, b1) = pencil(&mut joined, open, &y, &yp);
    let events = json!({
        "state_residual_max_over_tolerance": by_owner(&f_state),
        "turbine_trip": {"t_s": t, "transactions": done.len(), "holding_opening_s": open, "ramp_end_s": ramp_end,
            "command_residual_change_max_over_tolerance": by_owner(&f_cmd.iter().zip(&f_state).map(|(a, b)| a - b).collect::<Vec<_>>())},
        "E1_demand_step_max_over_tolerance": by_owner(&e1),
        "E2_release": {"transactions": released.len(), "released_clusters": released.first().and_then(|d| d.receipt["rods"].as_array().map(|a| a.len())),
            "algebraic_held": ids_held.iter().filter(|v| **v == 0.).count(), "algebraic_released": ids_open.iter().filter(|v| **v == 0.).count(),
            "max_over_tolerance": by_owner(&e2)},
    });

    // Restricted pencils.
    let restriction = Restriction {
        pointers: &pointers,
        indices: &indices,
        keep: &keep,
        eliminate: &surfaces,
    };
    let held_walls = Restriction {
        eliminate: &[],
        ..restriction
    };
    let coupled_restriction = Restriction {
        keep: &coupled,
        ..restriction
    };
    let network_alone = Restriction {
        keep: &network_only,
        eliminate: &[],
        ..restriction
    };
    let mut verdicts = Vec::new();
    let mut pencils = Vec::new();
    let mut held_blocks = Value::Null;
    for (state, a, b, ids, evs) in [
        (
            "held",
            &a0,
            &b0,
            &ids_held,
            vec![("E1 demand step", e1.clone())],
        ),
        (
            "released",
            &a1,
            &b1,
            &ids_open,
            vec![("E1 demand step", e1.clone()), ("E2 release", e2.clone())],
        ),
    ] {
        let forcings: Vec<Vec<f64>> = evs.iter().map(|(_, v)| v.clone()).collect();
        let mut run = |name: &str, r: &Restriction<'_>, gated: bool| {
            let (dense, forced, schur) = r.apply(a, b, &forcings, &labels, ids, &tolerance);
            let named: Vec<(&str, Vec<f64>)> = evs.iter().map(|(n, _)| *n).zip(forced).collect();
            let (mut verdict, go) = judge(&format!("{name}/{state}"), &dense, &named, gate);
            verdict["schur"] = schur;
            verdict["gated"] = json!(gated);
            if gated {
                verdicts.push(go);
            }
            pencils.push(verdict);
        };
        run("restricted", &restriction, true);
        run("coupled-nuclear-thermal", &coupled_restriction, true);
        run("restricted-held-walls", &held_walls, false);
        run("network-alone", &network_alone, false);
        if state == "held" {
            held_blocks = held_linear_blocks(
                &pointers, &indices, a, b, &coupled, &surfaces, &classes, &labels,
            );
        }
    }
    let go = verdicts.iter().all(|g| *g);
    receipt["kind"] = json!("s2-z6-restricted-spectrum");
    receipt["status"] = json!(
        "zero-time receipt (G10 Z6); S2 is not declared: not evidence until revision 7 is published"
    );
    receipt["gate"] = json!({"source": "ld01-s1-gates spectrum (G14)", "fastModeHz": gate.fast_mode_hz, "lightDamping": gate.light_damping, "maxExcitationRatio": gate.max_excitation_ratio});
    receipt["restriction"] = json!({
        "decision": "S2-D8 (lead): network + SG + metal + rods, plus a coupled nuclear-thermal check; both named restrictions of the joined Jacobian (critic M3); Accelerate dggev, no new dependency",
        "restricted": {"coordinates": keep.len(), "network": o.nuclear, "secondary": o.rods - o.secondary, "rods": o.end - o.rods,
            "sg_metal": keep.iter().filter(|&&i| i >= o.solids && i < o.secondary).count(), "pzr_metal": "absent until G6 composes it",
            "frozen_differential": n - keep.len() - surfaces.len(), "eliminated_algebraic_surfaces": surfaces.len(),
            "treatment": "frozen differential coordinates held (zero perturbation, rows dropped); algebraic surfaces on their constraints by the exact Schur complement; held-surface pencil reported as a sensitivity"},
        "coupled_nuclear_thermal": {"coordinates": coupled.len(),
            "kept": "regional populations, fuel nodes and clad stores of every carrier, the network, the SG secondaries and metal, the rods (named rows and columns of the joined Jacobian)",
            "regional_populations": coupled.iter().filter(|&&i| classes[i] == Class::RegionalPopulation).count(),
            "fuel_nodes": coupled.iter().filter(|&&i| classes[i] == Class::FuelEnergy).count(),
            "clad_stores": coupled.iter().filter(|&&i| classes[i] == Class::CladEnergy).count(),
            "eliminated_algebraic_surfaces": surfaces.len(),
            "held": "precursors, fissile/fertile/poison inventories, delayed-energy histories (linear, constant coefficients), helium and passive stores: zero perturbation",
            "held_linear_blocks": held_blocks,
            "planned_bound": "under 1,000 (S2-D8); the plant's 386 carriers x 3 stores set 1,619",
            "critic": "M3 (accepted): named restrictions of the model's own Jacobian, no aggregated surrogate"},
    });
    receipt["events"] = events;
    receipt["pencils"] = json!(pencils);
    receipt["verdict"] = json!(if go {
        "GO: every gated Z6 predicate holds at this state"
    } else {
        "NO-GO: a gated Z6 predicate failed; see pencils[].predicates"
    });
    receipt["cost"] = json!({"composition_cpu_s": composed_cpu, "total_cpu_s": process_cpu_s() - cpu0, "wall_s": wall.elapsed().as_secs_f64(), "load_average_end": load_average()});
    write_receipt(&receipt);
    println!("{}", serde_json::to_string(&receipt["verdict"]).unwrap());
    for p in &pencils {
        println!(
            "{} n={} infinite={}/{} growing={} marginal_untied={} predicates={}",
            p["pencil"],
            p["dimension"],
            p["infinite"]["count"],
            p["infinite"]["algebraic_coordinates_expected"],
            p["resolved_growing"].as_array().unwrap().len(),
            p["marginal_untied"],
            p["predicates"]
        );
    }
}

/// D3 (a) at the state (`admit_accepted`) and Z3's post-trip envelope
/// margin: rods fully in, fuel and moderator at the envelope's coolant
/// temperature, every region's water at its density there, the state's
/// inventories, boron and populations; each envelope point of the Z3
/// receipt in `LD01_Z3_ENVELOPE_RECEIPT` is judged against the 1 % with the
/// water term doubled, and its margin `delta*` reported (nominal factor too).
#[test]
#[ignore = "zero-time receipt: requires the joined packet, the wiki, maintained IF97, stock IDA/KLU, Accelerate and the Z3 envelope receipt"]
fn d3_shutdown_margin_at_the_state_and_on_the_z3_envelope() {
    let cpu0 = process_cpu_s();
    let Started {
        mut joined,
        raw,
        t,
        y,
        yp,
        mut receipt,
        ..
    } = started();
    let (ext, ext_source) = extension(&raw);
    joined.evaluate(t, &y, &yp, None, 0., None).expect("state");
    let phase = joined.region_phases().expect("region phases");
    let at_state =
        post_trip_domain::admit_accepted(joined.nuclear(), &phase, &ext, joined.travel(), t, 0.)
            .expect("the state itself is admitted");
    let nuclear = joined.nuclear();
    let feedback = nuclear.feedback();
    let f = nuclear.feedback_inputs();
    let co = nuclear.coefficients();
    let fixed = Fixed {
        transfer_rates_per_s: co.transfer_rates_per_s,
        emission_fractions: co.emission_fractions,
        outside_fractions: co.outside_fractions,
    };
    let reference: Vec<f64> = raw["feedback_metadata"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["reference_density_kg_m3"].as_f64().unwrap())
        .collect();
    let k = |v: &[f64]| v.iter().map(|x| Scalar::constant(*x)).collect::<Vec<_>>();
    let envelope_file = std::env::var("LD01_Z3_ENVELOPE_RECEIPT")
        .expect("LD01_Z3_ENVELOPE_RECEIPT names the Z3 trip-envelope receipt");
    let envelope_bytes = std::fs::read(&envelope_file).expect("Z3 envelope receipt");
    let envelope: Value = serde_json::from_slice(&envelope_bytes).unwrap();
    let mut nominal = ext;
    nominal.margin_water_term_factor = 1.;
    let mut points = Vec::new();
    let mut all_hold = true;
    for row in envelope["ratios"].as_array().unwrap() {
        let temperature = row["T_C"].as_f64().unwrap() + 273.15;
        let pressure = row["pressure_Pa"].as_f64().unwrap();
        let density = row["rho_kg_m3"].as_f64().unwrap();
        let r = reference.len();
        let (neutrons, boron, fissile, xenon, samarium, opacity) = (
            k(&f.neutrons),
            k(&f.boron_ppm_eq),
            k(&f.fissile_atoms),
            k(&f.xenon_atoms),
            k(&f.samarium_atoms),
            k(&f.capture_loss_change_m2),
        );
        let fuel = vec![Scalar::constant(temperature); f.fuel_temperature_k.len()];
        let water = vec![Scalar::constant(density); r];
        let p = vec![Scalar::constant(pressure); r];
        let moderator = vec![Scalar::constant(temperature); r];
        let travel = vec![Scalar::constant(0.); joined.travel().len()];
        let conditions = sf::Conditions {
            fuel_temperature_k: &fuel,
            water_density_kg_m3: &water,
            boron_ppm_eq: &boron,
            pressure_pa: &p,
            moderator_temperature_k: &moderator,
            fissile_atoms: &fissile,
            xenon_atoms: &xenon,
            samarium_atoms: &samarium,
            capture_loss_change_m2: &opacity,
            achieved_rod_travel_m: &travel,
            capsule_age_s: Scalar::constant(co.capsule_age0_s + t),
        };
        let judged = |e: &Extension| {
            post_trip_domain::admit(
                feedback,
                nuclear.kinetics(),
                fixed,
                &neutrons,
                conditions,
                0.,
                e,
            )
        };
        let doubled = judged(&ext);
        let once = judged(&nominal);
        let margin = |e: &Extension| {
            post_trip_domain::margin_at(
                feedback,
                nuclear.kinetics(),
                fixed,
                &neutrons,
                conditions,
                e,
            )
            .expect("margin at the envelope point")
        };
        let summary = |a: &Result<post_trip_domain::Admission, post_trip_domain::Error>,
                       m: &post_trip_domain::Margin| {
            let verdict = match a {
                Ok(a) => json!({"admitted": true, "domain": a.domain}),
                Err(post_trip_domain::Error::Unsupported { domain, exit, .. }) => {
                    json!({"admitted": false, "domain": domain, "exit": format!("{exit:?}")})
                }
                Err(e) => json!({"error": format!("{e:?}")}),
            };
            json!({"verdict": verdict, "margin_holds": m.holds, "margin_dk_k": margin_value(m),
                "water_term_range": [m.water_terms.iter().cloned().fold(f64::INFINITY, f64::min), m.water_terms.iter().cloned().fold(f64::NEG_INFINITY, f64::max)]})
        };
        let (m2, m1) = (margin(&ext), margin(&nominal));
        let holds = matches!(&doubled, Ok(a) if a.margin.holds);
        all_hold &= holds;
        let ratios: Vec<f64> = reference.iter().map(|rho| density / rho).collect();
        points.push(json!({"temperature": row["temperature"], "T_K": temperature, "pressure_Pa": pressure, "rho_kg_m3": density,
            "density_ratio_range": [ratios.iter().cloned().fold(f64::INFINITY, f64::min), ratios.iter().cloned().fold(f64::NEG_INFINITY, f64::max)],
            "water_term_doubled": summary(&doubled, &m2), "water_term_nominal": summary(&once, &m1)}));
    }
    receipt["kind"] = json!("s2-d3-post-trip-margin");
    receipt["status"] =
        json!("zero-time receipt (D3 (a) predicate and Z3 envelope margin); not a trajectory");
    receipt["extension"] = json!({"record": ext, "source": ext_source});
    let at_state_margin = margin_value(&at_state.margin);
    receipt["at_state"] = json!({"admission": at_state, "margin_dk_k": at_state_margin,
        "note": "at power the source-free operator is near critical, so the margin fails and the compiled domains apply"});
    receipt["z3_envelope"] = json!({"receipt": envelope_file, "sha256": sha256(&envelope_bytes),
        "substitution": "rods fully in (travel 0), fuel and moderator at the envelope coolant temperature, every region's water at the envelope density, the state's populations, boron, fissile, Xe, Sm and capture",
        "points": points, "every_point_holds_with_water_term_doubled": all_hold});
    receipt["cost"] =
        json!({"total_cpu_s": process_cpu_s() - cpu0, "load_average_end": load_average()});
    write_receipt(&receipt);
    println!(
        "{}",
        serde_json::to_string(&json!({"at_state": receipt["at_state"]["margin_dk_k"], "all_hold": all_hold, "points": receipt["z3_envelope"]["points"].as_array().unwrap().iter().map(|p| json!([p["temperature"], p["pressure_Pa"], p["water_term_doubled"]["margin_dk_k"], p["water_term_nominal"]["margin_dk_k"]])).collect::<Vec<_>>()})).unwrap()
    );
}

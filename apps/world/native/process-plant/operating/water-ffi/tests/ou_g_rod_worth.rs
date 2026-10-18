//! DIAG (lane OU-G, BACKLOG ROD-WORTH; owner request 14 A1/B1): LD-01's rod
//! position and shutdown margins in AP1000 DCD Rev. 19 Tier 2 Table 4.3-3's
//! terms, on P1's source-free margin (S2-D13's pencil `(M, diag(1/Λ))`,
//! stock dggev), at the composed hot reference's nuclear stocks. Zero-time,
//! NOT a trajectory and NOT gate evidence. Written once to
//! `LD01_OU_G_RECEIPT`.
//!
//! - Full power (the composed state as composed): the margin with every
//!   cluster at the reference travel, all out and all seated; the held worth
//!   at the reference travel against all out (T4.3-3 item 1 allows 2.00 %).
//! - Hot standby (P1's points: uniform water at `(T, 15.5 MPa)` on IF97,
//!   fuel at `T`, the composed xenon and stocks) at the packet's prepared
//!   boron and at listed comparison borons, at the reported water-term
//!   factors: all out `o`, all seated, the worst single cluster stuck at the
//!   reference travel (P1's convention), the worst stuck fully out (N-1,
//!   GDC 26), and the DCD method `o + 0.93 (N-1 - o)` (T4.3-3 item 4, the
//!   7 % allowance of WCAP-9217).
use leitbild_operating_plant::network::Properties;
use leitbild_operating_water::If97;
use serde_json::{Value, json};

#[path = "joined_spine.rs"]
#[allow(dead_code)]
mod spine;

/// AP1000 T4.3-3 item 4: the N-1 credit less 7 %.
const DCD_CREDIT: f64 = 0.93;
/// P1's reported water-term factors (`ld01-hot-standby-kinetics`).
const FACTORS: [f64; 3] = [1., 1.53, 2.24];

#[cfg(target_os = "macos")]
#[test]
#[ignore = "diag: requires the joined packet, the wiki, IF97, IDA/KLU and Accelerate; writes LD01_OU_G_RECEIPT"]
fn rod_position_and_shutdown_margins() {
    use leitbild_operating_plant::{
        joined::post_trip_domain::{self, Extension, Fixed},
        source_feedback as sf,
        thermal::Scalar,
    };
    let path = std::env::var("LD01_OU_G_RECEIPT").expect("LD01_OU_G_RECEIPT");
    assert!(!std::path::Path::new(&path).exists(), "never overwritten");
    let started = spine::started_full_composition();
    let joined = &started.joined;
    let (packet_path, bytes) = spine::packet_bytes();
    let raw: Value = serde_json::from_slice(&bytes).unwrap();
    let base: Extension = serde_json::from_value(raw["post_trip_domain"].clone()).unwrap();
    let nuclear = joined.nuclear();
    let feedback = nuclear.feedback();
    let f = nuclear.feedback_inputs();
    let co = nuclear.coefficients();
    let fixed = Fixed {
        transfer_rates_per_s: co.transfer_rates_per_s,
        emission_fractions: co.emission_fractions,
        outside_fractions: co.outside_fractions,
    };
    let k = |v: &[f64]| v.iter().map(|x| Scalar::constant(*x)).collect::<Vec<_>>();
    let regions = f.water_density_kg_m3.len();
    let clusters = joined.travel().len();
    let fuel_n = f.fuel_temperature_k.len();
    let reference_travel = raw["rods"]["reference_travel_m"].as_f64().unwrap();
    let full_out = raw["rods"]["normal_travel_m"].as_f64().unwrap();
    let prepared_boron = f.boron_ppm_eq.iter().sum::<f64>() / regions as f64;
    let boron_spread = f
        .boron_ppm_eq
        .iter()
        .map(|b| (b - prepared_boron).abs())
        .fold(0., f64::max);
    let margin = |water: &[f64],
                  pressure: &[f64],
                  moderator: &[f64],
                  fuel: &[f64],
                  boron: &[f64],
                  travel: &[f64],
                  factor: f64|
     -> f64 {
        let (water, pressure, moderator, fuel, boron) =
            (k(water), k(pressure), k(moderator), k(fuel), k(boron));
        let (neutrons, fissile, xenon, samarium, opacity) = (
            k(&f.neutrons),
            k(&f.fissile_atoms),
            k(&f.xenon_atoms),
            k(&f.samarium_atoms),
            k(&f.capture_loss_change_m2),
        );
        let travel = k(travel);
        let conditions = sf::Conditions {
            fuel_temperature_k: &fuel,
            water_density_kg_m3: &water,
            boron_ppm_eq: &boron,
            pressure_pa: &pressure,
            moderator_temperature_k: &moderator,
            fissile_atoms: &fissile,
            xenon_atoms: &xenon,
            samarium_atoms: &samarium,
            capture_loss_change_m2: &opacity,
            achieved_rod_travel_m: &travel,
            capsule_age_s: Scalar::constant(co.capsule_age0_s),
        };
        let mut e = base;
        e.margin_water_term_factor = factor;
        let m = post_trip_domain::margin_at(
            feedback,
            nuclear.kinetics(),
            fixed,
            &neutrons,
            conditions,
            &e,
        )
        .expect("margin");
        let r = m.reactivity_gain.len();
        let mut g = vec![0.; r * r];
        for i in 0..r {
            g[i * r + i] = m.reactivity_gain[i];
        }
        leitbild_operating_water::spectrum::decompose(r, &m.operator, &g)
            .expect("margin pencil")
            .modes
            .iter()
            .map(|x| x.lambda.re)
            .fold(f64::INFINITY, f64::min)
    };
    let all = |t: f64| vec![t; clusters];
    // Full power, the composed state as composed.
    let hfp = |travel: &[f64]| {
        margin(
            &f.water_density_kg_m3,
            &f.pressure_pa,
            &f.moderator_temperature_k,
            &f.fuel_temperature_k,
            &f.boron_ppm_eq,
            travel,
            1.,
        )
    };
    let composed: Vec<f64> = joined.travel().iter().map(|x| x.value).collect();
    let (h_composed, h_reference, h_out, h_seated) = (
        hfp(&composed),
        hfp(&all(reference_travel)),
        hfp(&all(full_out)),
        hfp(&all(0.)),
    );
    let full_power = json!({"margin_composed_travel": h_composed, "margin_all_at_reference": h_reference,
        "margin_all_out": h_out, "margin_all_seated": h_seated,
        "held_worth_at_reference_dk_k": h_reference - h_out, "all_in_worth_dk_k": h_seated - h_out});
    let worst = |m: &dyn Fn(&[f64]) -> f64, at: f64| -> (f64, usize) {
        let mut best = (f64::INFINITY, 0);
        for c in 0..clusters {
            let mut travel = all(0.);
            travel[c] = at;
            let x = m(&travel);
            if x < best.0 {
                best = (x, c);
            }
        }
        best
    };
    let mut hot_standby = Vec::new();
    for (label, t, borons) in [
        (
            "no-load 291.7 C",
            564.85,
            vec![prepared_boron, 500., 1000., 1500.],
        ),
        ("282.2 C (540 F)", 555.37, vec![prepared_boron, 1000.]),
    ] {
        let p = 15.5e6;
        let w = If97.forward(false, p, t).expect("IF97 liquid");
        let (water, pressure, moderator, fuel) = (
            vec![w.density_kg_m3; regions],
            vec![p; regions],
            vec![t; regions],
            vec![t; fuel_n],
        );
        for boron in borons {
            let b = vec![boron; regions];
            for factor in FACTORS {
                let m = |travel: &[f64]| {
                    margin(&water, &pressure, &moderator, &fuel, &b, travel, factor)
                };
                let out = m(&all(full_out));
                let seated = m(&all(0.));
                let (p1, p1_cluster) = worst(&m, reference_travel);
                let (n1, n1_cluster) = worst(&m, full_out);
                hot_standby.push(json!({"state": label, "T_K": t, "pressure_pa": p, "boron_ppm_eq": boron,
                    "factor": factor, "all_out": out, "all_seated": seated,
                    "p1_stuck_at_reference": p1, "p1_cluster": raw["rods"]["clusters"][p1_cluster]["id"],
                    "n1_stuck_full_out": n1, "n1_cluster": raw["rods"]["clusters"][n1_cluster]["id"],
                    "dcd_method": out + DCD_CREDIT * (n1 - out),
                    "all_in_worth": seated - out, "n1_worth": n1 - out, "stuck_worth_full_out": seated - n1,
                    "stuck_worth_at_reference": seated - p1}));
            }
        }
    }
    let receipt = json!({"kind": "DIAG OU-G rod position and shutdown margins (zero-time, NOT a trajectory)",
        "driver": "water-ffi/tests/ou_g_rod_worth.rs::rod_position_and_shutdown_margins",
        "packet": packet_path, "margin": "smallest real mode of S2-D13's source-free pencil; worth = margin difference",
        "reference_travel_m": reference_travel, "full_out_travel_m": full_out,
        "prepared_boron_ppm_eq": prepared_boron, "prepared_boron_spread_ppm_eq": boron_spread,
        "dcd_credit": DCD_CREDIT, "full_power": full_power, "hot_standby": hot_standby});
    std::fs::write(&path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
}

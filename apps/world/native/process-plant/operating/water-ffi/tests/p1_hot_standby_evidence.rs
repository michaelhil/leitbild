//! P1 (OU-C): the hot liquid laws of `LD01-HOT-SOURCE-1` near hot zero power
//! at operating pressure, on maintained IF97, for the comparison with
//! AP1000's published moderator coefficients (kinetics.md, hot-standby
//! kinetics). NOT a run: a property table. For each pressure, band reference
//! density and boron, at each sampled temperature: the density ratio, the
//! laws' moderator coefficient (water term plus the reference-density boron
//! proxy, Doppler excluded, pcm/°F) and the reactivity a cooldown from hot
//! zero power (291.7 °C = 557.06 °F) adds. The receipt is written once to
//! `LD01_P1_EVIDENCE_RECEIPT`.
use leitbild_operating_plant::network::Properties;
use leitbild_operating_water::If97;
use serde_json::{Value, json};

/// `LD01-HOT-SOURCE-1` (kinetics.md `reference-operating-source`): the water
/// worth, the boron proxy and the two band reference densities.
const WATER_WORTH: f64 = 0.15;
const BORON_PER_PPM: f64 = -8e-5;
const REFERENCES: [(&str, f64); 2] = [("upper", 679.3368894359069), ("lower", 715.3052293172567)];

fn kelvin(f: f64) -> f64 {
    (f - 32.) * 5. / 9. + 273.15
}

#[test]
#[ignore = "requires maintained IF97; writes LD01_P1_EVIDENCE_RECEIPT"]
fn hot_source_laws_near_hot_zero_power() {
    let path = std::env::var("LD01_P1_EVIDENCE_RECEIPT").expect("LD01_P1_EVIDENCE_RECEIPT");
    assert!(!std::path::Path::new(&path).exists(), "never overwritten");
    let hzp_f = 557.06;
    let temperatures_f = [520., 530., 540., 550., 556.9, hzp_f];
    let density = |p: f64, f: f64| -> (f64, f64) {
        let t = kelvin(f);
        let w = If97.forward(false, p, t).expect("IF97 liquid");
        // dRho/dT by the point's own expansion coefficient.
        (w.density_kg_m3, -w.density_kg_m3 * w.expansion_per_k)
    };
    let mut table = Vec::new();
    for p in [13.0e6, 14.0e6, 15.2e6, 15.5e6] {
        let (rho_hzp, _) = density(p, hzp_f);
        for (band, reference) in REFERENCES {
            for boron in [0., 500., 1000., 1500., 2000., 2500.] {
                let worth = WATER_WORTH + BORON_PER_PPM * boron;
                let rows: Vec<Value> = temperatures_f
                    .iter()
                    .map(|&f| {
                        let (rho, slope) = density(p, f);
                        json!({"T_F": f, "T_K": kelvin(f), "density_kg_m3": rho, "ratio": rho / reference,
                            "MTC_pcm_F": worth * slope / reference * 1e5 * 5. / 9.,
                            "cooldown_from_hzp_pcm": worth * (rho - rho_hzp) / reference * 1e5})
                    })
                    .collect();
                table.push(
                    json!({"pressure_pa": p, "band": band, "reference_kg_m3": reference,
                    "boron_ppm_eq": boron, "rows": rows}),
                );
            }
        }
    }
    let receipt = json!({"kind": "p1-hot-standby-evidence (NOT a run)", "laws": "LD01-HOT-SOURCE-1: 0.15 (rho/rho_ref - 1) - 8 pcm/ppm_eq x C rho/rho_ref; Doppler excluded",
        "hzp_F": hzp_f, "table": table});
    std::fs::write(&path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
}

mod common;

/// P1: the source-free shutdown margin (Δk/k; the smallest real mode of the
/// pencil `(M, diag(1/Λ))`, S2-D13's stock dggev) of the composed hot
/// reference's nuclear state carried to uniform hot-standby points: every
/// region's water at `(T, p)` on maintained IF97, fuel at `T`, boron at the
/// listed ppm_eq, xenon and the other stocks as composed; all 52 clusters
/// seated, and each cluster in turn stuck at the prepared travel (its worst
/// is the stuck-cluster margin); the water term at the reported factors.
/// Zero-time (NOT a trajectory); the receipt is written once to
/// `LD01_P1_MARGIN_RECEIPT`.
#[cfg(all(feature = "ida", target_os = "macos"))]
#[test]
#[ignore = "requires the joined packet, the wiki, maintained IF97, stock IDA/KLU and Accelerate; writes LD01_P1_MARGIN_RECEIPT"]
fn shutdown_margins_at_the_no_load_point() {
    use leitbild_operating_plant::{
        joined::post_trip_domain::{self, Extension, Fixed},
        source_feedback as sf,
        thermal::Scalar,
    };
    let path = std::env::var("LD01_P1_MARGIN_RECEIPT").expect("LD01_P1_MARGIN_RECEIPT");
    assert!(!std::path::Path::new(&path).exists(), "never overwritten");
    let factors = [1., 1.53, 2.24];
    let started = leitbild_operating_water::unit::spine::started_full_composition(&common::spine())
        .expect("the S2 composition");
    let joined = &started.joined;
    let (_, bytes) = common::packet_bytes();
    let raw: Value = serde_json::from_slice(&bytes).unwrap();
    let extension: Extension = serde_json::from_value(raw["post_trip_domain"].clone()).unwrap();
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
    let reference_travel = raw["rods"]["reference_travel_m"].as_f64().unwrap();
    let margin = |t: f64, p: f64, boron: f64, travel: &[f64], factor: f64| -> f64 {
        let w = If97.forward(false, p, t).expect("IF97 liquid");
        let (water, pressure, moderator) = (
            vec![Scalar::constant(w.density_kg_m3); regions],
            vec![Scalar::constant(p); regions],
            vec![Scalar::constant(t); regions],
        );
        let fuel = vec![Scalar::constant(t); f.fuel_temperature_k.len()];
        let boron = vec![Scalar::constant(boron); regions];
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
        let mut e = extension;
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
    let mut points = Vec::new();
    for (label, t) in [
        ("no-load 291.7 C", 564.85),
        ("285 C", 558.15),
        ("282.2 C (540 F)", 555.37),
    ] {
        for p in [15.5e6, 14.0e6, 13.0e6] {
            for boron in [0., 500., 1000., 1500., 2000.] {
                let mut by_factor = Vec::new();
                for factor in factors {
                    let seated = margin(t, p, boron, &vec![0.; clusters], factor);
                    let (mut worst, mut which) = (f64::INFINITY, 0);
                    for c in 0..clusters {
                        let mut travel = vec![0.; clusters];
                        travel[c] = reference_travel;
                        let m = margin(t, p, boron, &travel, factor);
                        if m < worst {
                            (worst, which) = (m, c);
                        }
                    }
                    by_factor.push(json!({"factor": factor, "all_seated_dk_k": seated,
                        "worst_stuck_dk_k": worst, "worst_stuck_cluster": raw["rods"]["clusters"][which]["id"]}));
                }
                points.push(json!({"state": label, "T_K": t, "pressure_pa": p, "boron_ppm_eq": boron, "margins": by_factor}));
            }
        }
    }
    let receipt = json!({"kind": "p1-no-load-shutdown-margins (zero-time, NOT a trajectory)",
        "basis": "the composed hot reference's nuclear stocks (xenon, samarium, fissile, capture) carried to uniform hot-standby points; fuel at the moderator temperature; the stuck cluster at the prepared travel",
        "factors": {"1": "nominal water term", "1.53": "rodded, measured (Table 4.3-9 + BEAVRS T22, KP-0 evidence)", "2.24": "rodded, AP1000 design limit (Table 4.3-2, boron-matched)"},
        "points": points});
    std::fs::write(&path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
}

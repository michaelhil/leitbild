//! Actual-input finite-state qualification, no time trajectory/calibration.
#[path = "../src/moderator_source.rs"]
mod moderator_source;
use moderator_source::*;
use std::{env, fs, time::Instant};
fn number(words: &mut std::str::SplitWhitespace<'_>) -> f64 {
    words
        .next()
        .expect("Missing input")
        .parse()
        .expect("Invalid number")
}
fn count(words: &mut std::str::SplitWhitespace<'_>) -> usize {
    words
        .next()
        .expect("Missing count")
        .parse()
        .expect("Invalid count")
}
fn array<const N: usize>(words: &mut std::str::SplitWhitespace<'_>) -> [f64; N] {
    std::array::from_fn(|_| number(words))
}
fn near(a: f64, b: f64, scale: f64) {
    assert!(
        (a - b).abs() <= 3e-10 * scale.abs().max(1e-300),
        "Identity {a} != {b}; scale {scale}"
    );
}
fn main() {
    let text = fs::read_to_string(
        env::args()
            .nth(1)
            .expect("Explicit actual fixture required"),
    )
    .unwrap();
    let mut words = text.split_whitespace();
    let nr = count(&mut words);
    let ni = count(&mut words);
    let law = ModeratorLaw {
        absorption: array(&mut words),
        scatter: std::array::from_fn(|_| array(&mut words)),
        speed: array(&mut words),
        boron_sigma: array(&mut words),
        reference_density: number(&mut words),
        hydrogen_emission: array(&mut words),
        boron_emission: array(&mut words),
    };
    let volumes = (0..nr).map(|_| number(&mut words)).collect::<Vec<_>>();
    let mut intersections = Vec::new();
    let mut original = Vec::new();
    for _ in 0..ni {
        intersections.push(Intersection {
            region: count(&mut words),
            volume: number(&mut words),
        });
        original.push(Stocks {
            water_mass: number(&mut words),
            liquid_volume: number(&mut words),
            hydrogen_target: number(&mut words),
            hydrogen_product: number(&mut words),
            mobile_boron10: number(&mut words),
        });
    }
    assert!(words.next().is_none(), "Trailing fixture input");
    let began = Instant::now();
    let model = ModeratorModel::new(law.clone(), volumes.clone(), intersections.clone()).unwrap();
    let mut work = model.workspace();
    assert!(work.coefficients().is_err() && work.rows().is_err());
    model.update(&original, &mut work).unwrap();
    let cp = work.coefficients().unwrap().as_ptr();
    let rp = work.rows().unwrap().as_ptr();
    let neutrons = (0..nr * 7)
        .map(|i| 1. + (i % 19) as f64 / 7.)
        .collect::<Vec<_>>();
    let mut rate = vec![0.; neutrons.len()];
    let mut events = vec![Events::default(); ni];
    model
        .apply(&work, &vec![0.; neutrons.len()], &mut rate, &mut events)
        .unwrap();
    assert!(
        rate.iter().all(|v| *v == 0.)
            && events.iter().all(|e| e.hydrogen == 0.
                && e.boron == 0.
                && e.emitted_photon == 0.
                && e.emitted_charged == 0.)
    );
    // Current same-trial depleted/mixed snapshot, explicitly not reached evolution.
    let current = original
        .iter()
        .enumerate()
        .map(|(i, s)| Stocks {
            water_mass: s.water_mass * 0.7,
            liquid_volume: s.liquid_volume * 0.7,
            hydrogen_target: s.hydrogen_target * 0.7 * (0.3 + 0.06 * (i % 7) as f64),
            hydrogen_product: s.hydrogen_target * 0.7 * (0.7 - 0.06 * (i % 7) as f64),
            mobile_boron10: s.mobile_boron10 * 0.4,
        })
        .collect::<Vec<_>>();
    model.update(&current, &mut work).unwrap();
    assert_eq!(cp, work.coefficients().unwrap().as_ptr());
    assert_eq!(rp, work.rows().unwrap().as_ptr());
    model
        .apply(&work, &neutrons, &mut rate, &mut events)
        .unwrap();
    let mut independent = vec![0.; neutrons.len()];
    let mut scale = vec![0.; neutrons.len()];
    let mut H = 0.;
    let mut B = 0.;
    let mut charge = 0.;
    for (i, (e, s)) in intersections.iter().zip(&current).enumerate() {
        let V = volumes[e.region];
        let fill = s.water_mass / (law.reference_density * V);
        let ratio = s.hydrogen_target / (s.hydrogen_target + s.hydrogen_product);
        let mut hcap = 0.;
        let mut bcap = 0.;
        for g in 0..7 {
            let N = neutrons[e.region * 7 + g];
            let h = law.speed[g] * law.absorption[g] * fill * ratio * N;
            let b = law.speed[g] * law.boron_sigma[g] * s.mobile_boron10 / V * N;
            hcap += h;
            bcap += b;
            independent[e.region * 7 + g] -= h + b;
            scale[e.region * 7 + g] += h + b;
            for to in 0..7 {
                if to == g {
                    continue;
                }
                let transfer = law.speed[g] * law.scatter[g][to] * fill * N;
                independent[e.region * 7 + g] -= transfer;
                independent[e.region * 7 + to] += transfer;
                scale[e.region * 7 + g] += transfer;
                scale[e.region * 7 + to] += transfer;
            }
        }
        near(events[i].hydrogen, hcap, hcap);
        near(events[i].boron, bcap, bcap);
        let q = hcap * (law.hydrogen_emission[0] + law.hydrogen_emission[1])
            + bcap * (law.boron_emission[0] + law.boron_emission[1]);
        near(events[i].emitted_photon + events[i].emitted_charged, q, q);
        let targets = events[i].target_rates();
        assert_eq!(targets[0] + targets[1], 0.);
        assert_eq!(targets[2] + targets[3], 0.);
        H += hcap;
        B += bcap;
        charge += q;
    }
    for ((a, b), s) in rate.iter().zip(&independent).zip(&scale) {
        near(*a, *b, *s);
    }
    near(rate.iter().sum(), -H - B, scale.iter().sum());
    assert!(work.coefficients().unwrap().chunks(49).all(|block| {
        block
            .iter()
            .enumerate()
            .all(|(i, x)| i / 7 == i % 7 || *x >= 0.)
    }));
    // Finite actual-state directional checks of all four local capture sensitivities.
    // Perturbed responses are evaluated by the actual production source.
    let base = work.rows().unwrap().to_vec();
    let mut derivative_checks = 0;
    for variable in 0..4 {
        let mut perturbed = current.clone();
        let mut delta = Vec::with_capacity(ni);
        for s in &mut perturbed {
            let value = match variable {
                0 => &mut s.water_mass,
                1 => &mut s.hydrogen_target,
                2 => &mut s.hydrogen_product,
                _ => &mut s.mobile_boron10,
            };
            let d = *value * 1e-5;
            *value += d;
            delta.push(d);
        }
        model.update(&perturbed, &mut work).unwrap();
        for (i, r) in work.rows().unwrap().iter().enumerate() {
            assert!(r.partials_available);
            for g in 0..7 {
                let (a, b, d) = match variable {
                    0 => (
                        r.hydrogen[g],
                        base[i].hydrogen[g],
                        base[i].d_hydrogen_d_mass[g],
                    ),
                    1 => (
                        r.hydrogen[g],
                        base[i].hydrogen[g],
                        base[i].d_hydrogen_d_target[g],
                    ),
                    2 => (
                        r.hydrogen[g],
                        base[i].hydrogen[g],
                        base[i].d_hydrogen_d_product[g],
                    ),
                    _ => (r.boron[g], base[i].boron[g], base[i].d_boron_d_atoms[g]),
                };
                let fd = (a - b) / delta[i];
                assert!(
                    (fd - d).abs() <= 2e-5 * d.abs().max(1e-300),
                    "Actual coefficient derivative mismatch"
                );
                derivative_checks += 1;
            }
            if variable == 0 {
                near(
                    (r.scatter_scale - base[i].scatter_scale) / delta[i],
                    base[i].d_scatter_scale_d_mass,
                    base[i].d_scatter_scale_d_mass,
                );
            }
        }
    }
    // Actual physical row repartition must preserve coefficients, events and emission.
    let split = intersections
        .iter()
        .flat_map(|e| {
            [Intersection {
                volume: e.volume / 2.,
                ..*e
            }; 2]
        })
        .collect();
    let split_stocks = current
        .iter()
        .flat_map(|s| {
            [Stocks {
                water_mass: s.water_mass / 2.,
                liquid_volume: s.liquid_volume / 2.,
                hydrogen_target: s.hydrogen_target / 2.,
                hydrogen_product: s.hydrogen_product / 2.,
                mobile_boron10: s.mobile_boron10 / 2.,
            }; 2]
        })
        .collect::<Vec<_>>();
    let split_model = ModeratorModel::new(law.clone(), volumes.clone(), split).unwrap();
    let mut sw = split_model.workspace();
    split_model.update(&split_stocks, &mut sw).unwrap();
    model.update(&current, &mut work).unwrap();
    for (a, b) in sw
        .coefficients()
        .unwrap()
        .iter()
        .zip(work.coefficients().unwrap())
    {
        near(*a, *b, b.abs());
    }
    let mut se = vec![Events::default(); ni * 2];
    let mut sr = vec![0.; nr * 7];
    split_model.apply(&sw, &neutrons, &mut sr, &mut se).unwrap();
    near(se.iter().map(|e| e.hydrogen + e.boron).sum(), H + B, H + B);
    near(
        se.iter()
            .map(|e| e.emitted_photon + e.emitted_charged)
            .sum(),
        charge,
        charge,
    );
    // Depletion, vapor-only moderation, dry support and refusal cannot silently reuse old state.
    let depleted = current
        .iter()
        .map(|s| Stocks {
            hydrogen_target: 0.,
            hydrogen_product: s.hydrogen_target + s.hydrogen_product,
            mobile_boron10: 0.,
            ..*s
        })
        .collect::<Vec<_>>();
    model.update(&depleted, &mut work).unwrap();
    model
        .apply(&work, &neutrons, &mut rate, &mut events)
        .unwrap();
    assert!(events.iter().all(|e| e.hydrogen == 0. && e.boron == 0.));
    let vapor = current
        .iter()
        .map(|s| Stocks {
            liquid_volume: 0.,
            mobile_boron10: 0.,
            ..*s
        })
        .collect::<Vec<_>>();
    model.update(&vapor, &mut work).unwrap();
    assert!(work.rows().unwrap().iter().all(|r| !r.partials_available));
    model
        .apply(&work, &neutrons, &mut rate, &mut events)
        .unwrap();
    assert!(events.iter().map(|e| e.hydrogen).sum::<f64>() > 0.);
    let dry = current
        .iter()
        .map(|_| Stocks {
            water_mass: 0.,
            liquid_volume: 0.,
            hydrogen_target: 0.,
            hydrogen_product: 0.,
            mobile_boron10: 0.,
        })
        .collect::<Vec<_>>();
    model.update(&dry, &mut work).unwrap();
    assert!(work.rows().unwrap().iter().all(|r| !r.partials_available));
    model
        .apply(&work, &neutrons, &mut rate, &mut events)
        .unwrap();
    assert!(rate.iter().all(|v| *v == 0.));
    let mut refusals = 0;
    for bad in 0..4 {
        let mut invalid = current.clone();
        match bad {
            0 => invalid[0].water_mass = -1.,
            1 => {
                invalid[0].hydrogen_target = 0.;
                invalid[0].hydrogen_product = 0.;
            }
            2 => invalid[0].liquid_volume = 0.,
            _ => invalid[0].liquid_volume = intersections[0].volume * 2.,
        };
        assert!(model.update(&invalid, &mut work).is_err());
        assert!(work.coefficients().is_err() && work.rows().is_err());
        assert!(
            model
                .apply(&work, &neutrons, &mut rate, &mut events)
                .is_err()
        );
        refusals += 1;
    }
    // Selected fast groups have no credited B10 absorption, not a whole-spectrum claim.
    model.update(&current, &mut work).unwrap();
    let fast = neutrons
        .iter()
        .enumerate()
        .map(|(i, n)| if i % 7 < 2 { *n } else { 0. })
        .collect::<Vec<_>>();
    model.apply(&work, &fast, &mut rate, &mut events).unwrap();
    assert!(events.iter().all(|e| e.boron == 0.));
    let foreign = ModeratorModel::new(law, volumes, intersections).unwrap();
    assert!(foreign.update(&current, &mut work).is_err());
    refusals += 1;
    println!(
        "{{\"passed\":true,\"regions\":{nr},\"intersections\":{ni},\"derivativeChecks\":{derivative_checks},\"refusals\":{refusals},\"snapshotHydrogenEvents_s\":{H},\"snapshotBoronEvents_s\":{B},\"snapshotEmittedCharge_W\":{charge},\"elapsedSeconds\":{},\"trajectory\":false,\"depositedHeat\":false}}",
        began.elapsed().as_secs_f64()
    );
}

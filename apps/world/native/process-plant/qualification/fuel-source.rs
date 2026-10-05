//! Bounded finite-state qualification, not a trajectory or plant initialization.
#[path = "../src/fuel_source.rs"]
mod fuel_source;
use fuel_source::*;
use std::{env, fs, time::Instant};
fn number(words: &mut std::str::SplitWhitespace<'_>) -> f64 {
    words
        .next()
        .expect("Missing fixture input")
        .parse()
        .expect("Invalid finite input")
}
fn count(words: &mut std::str::SplitWhitespace<'_>) -> usize {
    words
        .next()
        .expect("Missing fixture count")
        .parse()
        .expect("Invalid count")
}
fn array<const N: usize>(words: &mut std::str::SplitWhitespace<'_>) -> [f64; N] {
    std::array::from_fn(|_| number(words))
}
fn near(a: f64, b: f64, scale: f64) {
    assert!(
        (a - b).abs() <= 2e-10 * scale.max(1e-18),
        "Independent identity failed: {a} vs {b}, scale {scale}"
    );
}
fn add(rate: &mut [f64], scale: &mut [f64], index: usize, value: f64) {
    rate[index] += value;
    scale[index] += value.abs();
}
fn main() {
    let text = fs::read_to_string(
        env::args()
            .nth(1)
            .expect("Explicit compiled fixture required"),
    )
    .unwrap();
    let mut words = text.split_whitespace();
    let nr = count(&mut words);
    let ns = count(&mut words);
    let nq = count(&mut words);
    let ni = count(&mut words);
    let absorption = array(&mut words);
    let fission = array(&mut words);
    let scatter = std::array::from_fn(|_| array(&mut words));
    let law = FuelLaw {
        absorption,
        fission,
        scatter,
        nu: array(&mut words),
        chi: array(&mut words),
        speed: array(&mut words),
        beta: array(&mut words),
        decay: array(&mut words),
        f_d: number(&mut words),
    };
    let rv = (0..nr).map(|_| number(&mut words)).collect::<Vec<_>>();
    let sv = (0..ns).map(|_| number(&mut words)).collect::<Vec<_>>();
    let cohorts = (0..nq)
        .map(|_| Cohort {
            segment: count(&mut words),
            mass: number(&mut words),
            mu: number(&mut words),
        })
        .collect::<Vec<_>>();
    let intersections = (0..ni)
        .map(|_| {
            let region = count(&mut words);
            let segment = count(&mut words);
            let volume = number(&mut words);
            let n = count(&mut words);
            let weights = (0..n)
                .map(|_| Weight {
                    cohort: count(&mut words),
                    mass: number(&mut words),
                })
                .collect();
            Intersection {
                region,
                segment,
                volume,
                weights,
            }
        })
        .collect();
    let original = (0..ns)
        .map(|_| Stocks {
            reserve: number(&mut words),
            reference_reserve: number(&mut words),
            fertile: number(&mut words),
            reference_fertile: number(&mut words),
        })
        .collect::<Vec<_>>();
    let cold = (0..nq).map(|_| number(&mut words)).collect::<Vec<_>>();
    let prompt = number(&mut words);
    assert!(words.next().is_none(), "Trailing invented fixture input");
    let started = Instant::now();
    let model = FuelModel::new(law, rv.clone(), sv.clone(), cohorts, intersections).unwrap();
    assert_eq!(model.segment_count(), ns);
    let mut work = model.workspace();
    let coefficients = work.coefficients().as_ptr();
    let pattern = model.coordinates().as_ptr();
    model.update(&cold, &original, &mut work).unwrap();
    let mut zero = vec![0.; model.coordinate_count()];
    let mut rate = zero.clone();
    let mut events = vec![[0.; 2]; ni];
    model.apply(&work, &zero, &mut rate, &mut events).unwrap();
    assert!(
        rate.iter().all(|v| *v == 0.) && events.iter().flatten().all(|v| *v == 0.),
        "No invented source floor"
    );
    //A disclosed nonuniform qualification snapshot, not the original cold field.
    for (i, v) in zero.iter_mut().enumerate() {
        *v = 1. + (i % 17) as f64 / 9.;
    }
    let hot = (0..nq)
        .map(|q| 300. + 900. * (q % 11) as f64 / 10.)
        .collect::<Vec<_>>();
    let stocks = original
        .iter()
        .enumerate()
        .map(|(s, o)| Stocks {
            reserve: o.reserve * (0.4 + 0.04 * (s % 9) as f64),
            fertile: o.fertile * (0.3 + 0.06 * (s % 8) as f64),
            ..*o
        })
        .collect::<Vec<_>>();
    model.update(&hot, &stocks, &mut work).unwrap();
    assert_eq!(coefficients, work.coefficients().as_ptr());
    assert_eq!(pattern, model.coordinates().as_ptr());
    assert!(
        model
            .coordinates()
            .iter()
            .zip(work.coefficients())
            .all(|(p, v)| p.row == p.column || *v >= 0.),
        "Non-Metzler transfer"
    );
    model.apply(&work, &zero, &mut rate, &mut events).unwrap();
    let law = model.law();
    let mut expected = 0.;
    let mut budget = 0.;
    let mut fsum = 0.;
    let mut csum = 0.;
    //Independent event evaluation from raw constituent law/native input, not the
    //assembled sparse coefficients. This tests scatter orientation and paid events.
    for (i, e) in model.intersections().iter().enumerate() {
        let mass = e.weights.iter().map(|w| w.mass).sum::<f64>();
        let d = e
            .weights
            .iter()
            .map(|w| w.mass * (hot[w.cohort] / 300.).sqrt())
            .sum::<f64>()
            / mass;
        let mut F = 0.;
        let mut C = 0.;
        for g in 0..GROUPS {
            let flux = law.speed[g] * zero[e.region * GROUPS + g] / rv[e.region];
            let o = stocks[e.segment];
            let f = law.fission[g] * o.reserve / o.reference_reserve * flux * e.volume;
            let c = (law.absorption[g] - law.fission[g]) * o.fertile / o.reference_fertile
                * (if g == 2 || g == 3 {
                    1. + law.f_d * (d - 1.)
                } else {
                    1.
                })
                * flux
                * e.volume;
            F += f;
            C += c;
            expected += (law.nu[g] - 1.) * f - c;
            budget += (law.nu[g] + 1.) * f + c;
        }
        near(events[i][0], F, F);
        near(events[i][1], C, C);
        fsum += F;
        csum += C;
    }
    near(rate.iter().sum(), expected, budget);
    //Full directional7-bin passive operator check assembled independently in
    //a different order; within-group scattering must cancel, not heat/terminate.
    let mut direct = vec![0.; rate.len()];
    let mut local = vec![0.; rate.len()];
    let n_offset = nr * GROUPS;
    let beta = law.beta.iter().sum::<f64>();
    for (i, e) in model.intersections().iter().enumerate() {
        let mut offspring = 0.;
        for g in 0..GROUPS {
            let n = zero[e.region * GROUPS + g];
            let f = work.events()[i].fission[g] * n;
            let c = work.events()[i].capture[g] * n;
            add(&mut direct, &mut local, e.region * GROUPS + g, -f - c);
            offspring += law.nu[g] * f;
            for h in 0..GROUPS {
                if h != g {
                    let transfer = e.volume / rv[e.region] * law.speed[g] * law.scatter[g][h] * n;
                    add(&mut direct, &mut local, e.region * GROUPS + g, -transfer);
                    add(&mut direct, &mut local, e.region * GROUPS + h, transfer);
                }
            }
        }
        for h in 0..GROUPS {
            add(
                &mut direct,
                &mut local,
                e.region * GROUPS + h,
                law.chi[h] * (1. - beta) * offspring,
            );
        }
        for j in 0..DELAYED {
            add(
                &mut direct,
                &mut local,
                n_offset + e.segment * DELAYED + j,
                law.beta[j] * offspring,
            );
            let release =
                law.decay[j] * zero[n_offset + e.segment * DELAYED + j] * e.volume / sv[e.segment];
            for h in 0..GROUPS {
                add(
                    &mut direct,
                    &mut local,
                    e.region * GROUPS + h,
                    law.chi[h] * release,
                );
            }
        }
    }
    for s in 0..ns {
        for j in 0..DELAYED {
            add(
                &mut direct,
                &mut local,
                n_offset + s * DELAYED + j,
                -law.decay[j] * zero[n_offset + s * DELAYED + j],
            );
        }
    }
    for (index, (a, b)) in rate.iter().zip(&direct).enumerate() {
        near(*a, *b, local[index]);
    }
    let release = (0..ns).map(|s| 1. + s as f64 / 13.).collect::<Vec<_>>();
    let mut heat = vec![0.; nq];
    model
        .fuel_heat(&events, prompt, &release, &mut heat)
        .unwrap();
    let heat_expected = prompt * fsum + release.iter().sum::<f64>();
    near(heat.iter().sum(), heat_expected, heat_expected);
    //Actual analytic coefficient derivatives, with independent symmetric probes.
    let row = 0;
    let q = model.intersections()[row].weights[0].cohort;
    let g = 2;
    let analytic = work
        .thermal_derivatives()
        .iter()
        .find(|d| d.intersection == row && d.cohort == q)
        .unwrap()
        .d_capture_d_temperature[g];
    let mut t = hot.clone();
    let dt = 0.001;
    t[q] += dt;
    model.update(&t, &stocks, &mut work).unwrap();
    let plus = work.events()[row].capture[g];
    t[q] -= 2. * dt;
    model.update(&t, &stocks, &mut work).unwrap();
    let minus = work.events()[row].capture[g];
    let thermal_error = ((plus - minus) / (2. * dt) - analytic).abs() / analytic.abs();
    assert!(analytic > 0. && thermal_error < 1e-6);
    model.update(&hot, &stocks, &mut work).unwrap();
    let segment = model.intersections()[row].segment;
    let df = work.events()[row].d_fission_d_reserve[g];
    let dc = work.events()[row].d_capture_d_fertile[g];
    let mut s = stocks.clone();
    let dr = s[segment].reference_reserve * 1e-6;
    s[segment].reserve += dr;
    model.update(&hot, &s, &mut work).unwrap();
    let plus = work.events()[row].fission[g];
    s[segment].reserve -= 2. * dr;
    model.update(&hot, &s, &mut work).unwrap();
    let minus = work.events()[row].fission[g];
    let reserve_error = ((plus - minus) / (2. * dr) - df).abs() / df.abs();
    assert!(reserve_error < 1e-6);
    let mut s = stocks.clone();
    let dcstep = s[segment].reference_fertile * 1e-6;
    s[segment].fertile += dcstep;
    model.update(&hot, &s, &mut work).unwrap();
    let plus = work.events()[row].capture[g];
    s[segment].fertile -= 2. * dcstep;
    model.update(&hot, &s, &mut work).unwrap();
    let minus = work.events()[row].capture[g];
    let target_error = ((plus - minus) / (2. * dcstep) - dc).abs() / dc.abs();
    assert!(target_error < 1e-6);
    let empty = stocks
        .iter()
        .map(|s| Stocks {
            reserve: 0.,
            fertile: 0.,
            ..*s
        })
        .collect::<Vec<_>>();
    model.update(&hot, &empty, &mut work).unwrap();
    model.apply(&work, &zero, &mut rate, &mut events).unwrap();
    assert!(
        events.iter().flatten().all(|v| *v == 0.),
        "Exhausted stock has no fission/capture"
    );
    let mut invalid = hot.clone();
    invalid[q] = f64::NAN;
    assert!(model.update(&invalid, &stocks, &mut work).is_err());
    assert!(
        model.apply(&work, &zero, &mut rate, &mut events).is_err(),
        "Failed workspace cannot become a rate"
    );
    let foreign = FuelModel::new(
        law.clone(),
        rv.clone(),
        sv.clone(),
        model.cohorts().to_vec(),
        model.intersections().to_vec(),
    )
    .unwrap();
    assert!(
        foreign.update(&hot, &stocks, &mut work).is_err(),
        "Same-shape foreign workspace must be rejected"
    );
    let mut overfill = rv.clone();
    overfill[model.intersections()[0].region] = model.intersections()[0].volume / 2.;
    assert!(
        FuelModel::new(
            law.clone(),
            overfill,
            sv.clone(),
            model.cohorts().to_vec(),
            model.intersections().to_vec()
        )
        .is_err()
    );
    //Conservative test-only source subdivision, not another physical mesh choice:
    //retain each material history/cohort once and split N by actual subvolume.
    let refined_regions = rv
        .iter()
        .flat_map(|v| [*v / 2., *v / 2.])
        .collect::<Vec<_>>();
    let refined_intersections = model
        .intersections()
        .iter()
        .flat_map(|e| {
            [0, 1].map(|side| Intersection {
                region: 2 * e.region + side,
                segment: e.segment,
                volume: e.volume / 2.,
                weights: e
                    .weights
                    .iter()
                    .map(|w| Weight {
                        cohort: w.cohort,
                        mass: w.mass / 2.,
                    })
                    .collect(),
            })
        })
        .collect();
    let refined = FuelModel::new(
        law.clone(),
        refined_regions,
        sv.clone(),
        model.cohorts().to_vec(),
        refined_intersections,
    )
    .unwrap();
    let mut rw = refined.workspace();
    refined.update(&hot, &stocks, &mut rw).unwrap();
    let mut rn = vec![0.; refined.coordinate_count()];
    for r in 0..nr {
        for side in 0..2 {
            for g in 0..GROUPS {
                rn[(2 * r + side) * GROUPS + g] = zero[r * GROUPS + g] / 2.;
            }
        }
    }
    rn[2 * nr * GROUPS..].copy_from_slice(&zero[nr * GROUPS..]);
    let mut rr = vec![0.; rn.len()];
    let mut re = vec![[0.; 2]; 2 * ni];
    refined.apply(&rw, &rn, &mut rr, &mut re).unwrap();
    model.update(&hot, &stocks, &mut work).unwrap();
    model.apply(&work, &zero, &mut rate, &mut events).unwrap();
    for r in 0..nr {
        for g in 0..GROUPS {
            near(
                rr[2 * r * GROUPS + g] + rr[(2 * r + 1) * GROUPS + g],
                rate[r * GROUPS + g],
                local[r * GROUPS + g],
            );
        }
    }
    for k in 0..ns * DELAYED {
        near(
            rr[2 * nr * GROUPS + k],
            rate[nr * GROUPS + k],
            local[nr * GROUPS + k],
        );
    }
    let mut rh = vec![0.; nq];
    refined.fuel_heat(&re, prompt, &release, &mut rh).unwrap();
    for (a, b) in heat.iter().zip(&rh) {
        near(*a, *b, a.abs());
    }
    //A genuinely absent fuel component has no ghosts, source or precursor states.
    let absent = FuelModel::new(law.clone(), vec![1.], vec![], vec![], vec![]).unwrap();
    let mut w = absent.workspace();
    absent.update(&[], &[], &mut w).unwrap();
    let mut r = [123.; 7];
    absent.apply(&w, &[1.; 7], &mut r, &mut []).unwrap();
    assert_eq!(r, [0.; 7]);
    let number_error = (direct.iter().sum::<f64>() - expected).abs() / budget;
    println!(
        "{{\"passed\":true,\"regions\":{nr},\"segments\":{ns},\"fuelCohorts\":{nq},\"intersections\":{ni},\"localPatternEntries\":{},\"numberRelativeError\":{number_error:.17e},\"heat_W\":{heat_expected:.17e},\"fissionEvents_s\":{fsum:.17e},\"captureEvents_s\":{csum:.17e},\"thermalDerivativeRelativeError\":{thermal_error:.17e},\"reserveDerivativeRelativeError\":{reserve_error:.17e},\"targetDerivativeRelativeError\":{target_error:.17e},\"nativeSeconds\":{:.9}}}",
        model.coordinates().len(),
        started.elapsed().as_secs_f64()
    );
}

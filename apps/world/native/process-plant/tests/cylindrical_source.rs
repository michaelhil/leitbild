#[path = "../src/cylindrical_source.rs"]
mod cylindrical_source;
// Reuse the strict composed-input reader for the opt-in, non-advancing actual
// workload timing below. No second fixture format or production parser.
#[path = "../src/fuel_source.rs"] mod fuel_source;
#[path = "../src/moderator_source.rs"] mod moderator_source;
#[path = "../src/passive_source.rs"] mod passive_source;
#[path = "../src/transport_source.rs"] mod transport_source;
#[path = "../src/optical_source.rs"] mod optical_source;
#[path = "../src/converter_heat.rs"] mod converter_heat;
#[path = "../qualification/source_input/mod.rs"] mod source_input;
use cylindrical_source::*;
use std::f64::consts::PI;
fn close(a: f64, b: f64, tol: f64) {
    assert!(
        (a - b).abs() <= tol * a.abs().max(b.abs()).max(1e-300),
        "{a:e} vs {b:e}"
    );
}
// TEST-ONLY physical geometry and supplied macro-opacity probes. Production
// amounts, microscopic tables and dimensions come from actual owner inputs.
fn target(inner: f64, outer: f64, escape: bool) -> Target {
    let volume = PI * (outer * outer - inner * inner) * 0.1;
    Target {
        index: 0,
        inner_radius: inner,
        outer_radius: outer,
        length: 0.1,
        multiplicity: 1,
        sigma_m2: [
            0.,
            0.,
            1e-5 * volume,
            0.1 * volume,
            10. * volume,
            1000. * volume,
            10000. * volume,
        ],
        escape_depth: if escape { 1e-6 } else { 0. },
        collection: if escape { 0.5 } else { 0. },
    }
}
fn model(t: Target) -> Model {
    Model::new(
        vec![2., 3.],
        [2.; 7],
        vec![t],
        vec![
            Intersection {
                target: 0,
                region: 0,
                share: 0.4,
            },
            Intersection {
                target: 0,
                region: 1,
                share: 0.6,
            },
        ],
        1,
    )
    .unwrap()
}

// Independent midpoint angular/impact parametrization. Its physical intervals
// remove both inner-circle and outer-tangent roots; no native ray helper used.
fn independent(t: &Target, sigma: f64, n: usize) -> (f64, f64) {
    if sigma == 0. {
        return (0., 0.);
    }
    let ri = t.inner_radius;
    let ro = t.outer_radius;
    let area = 2. * PI * ro * t.length * t.multiplicity as f64;
    let step = PI / (2. * n as f64);
    let mut capture = 0.;
    let mut escaped = 0.;
    for k in 0..n {
        let theta = (k as f64 + 0.5) * step;
        let sine = theta.sin();
        for j in 0..n {
            let angle = (j as f64 + 0.5) * step;
            let values = if ri == 0. {
                vec![(ro * angle.sin(), ro * angle.cos() * step)]
            } else {
                let b = (ri * ri + (ro * ro - ri * ri) * angle.sin().powi(2)).sqrt();
                vec![
                    (ri * angle.cos(), ri * angle.sin() * step),
                    (
                        b,
                        (ro * ro - ri * ri) * angle.sin() * angle.cos() / b * step,
                    ),
                ]
            };
            for (impact, db) in values {
                let outer = ((ro - impact) * (ro + impact)).sqrt();
                let inner = if impact < ri {
                    ((ri - impact) * (ri + impact)).sqrt()
                } else {
                    0.
                };
                let width = if impact < ri {
                    (ro - ri) * (ro + ri) / (outer + inner)
                } else {
                    outer
                };
                let weight = area / (PI * ro) * step * sine * sine * db;
                capture += weight * (-(-sigma * 2. * width / sine).exp_m1());
                if t.escape_depth > 0. {
                    let shell = ro - t.escape_depth;
                    let lo = if impact < shell {
                        ((shell - impact) * (shell + impact)).sqrt()
                    } else {
                        0.
                    };
                    let dx = (outer - lo) / 128.;
                    for q in 0..128 {
                        let x = lo + (q as f64 + 0.5) * dx;
                        let radius = impact.hypot(x);
                        let depth = (ro * ro - impact * impact - x * x) / (ro + radius);
                        let p = 0.5 * (1. - depth / t.escape_depth);
                        escaped += weight * dx * sigma / sine
                            * p
                            * ((-sigma * (outer - x) / sine).exp()
                                + (-sigma * (outer - 2. * inner + x) / sine).exp());
                    }
                }
            }
        }
    }
    (capture, escaped)
}
#[test]
fn physical_zero_thin_and_lateral_black_capture_limits() {
    for (ri, ro) in [(0., 0.004), (0.002, 0.002260358)] {
        let mut t = target(ri, ro, false);
        let volume = PI * (ro * ro - ri * ri) * t.length;
        t.sigma_m2[6] = 1e10 * volume;
        let m = model(t);
        let mut w = m.workspace();
        m.update(&[1.], &mut w).unwrap();
        let r = w.responses().unwrap()[0];
        assert_eq!(r.capture_m2[0], 0.);
        close(r.capture_m2[2], 1e-5 * volume, 2e-7);
        close(r.capture_m2[6], 2. * PI * ro * 0.1 / 4., 2e-12);
        m.update(&[0.], &mut w).unwrap();
        assert!(
            w.responses().unwrap()[0]
                .capture_m2
                .iter()
                .all(|v| *v == 0.)
        );
    }
}
#[test]
fn independent_capture_and_actual_annular_escape_comparison() {
    for t in [target(0., 0.004, false), target(0.002, 0.002260358, true)] {
        let volume =
            PI * (t.outer_radius * t.outer_radius - t.inner_radius * t.inner_radius) * t.length;
        let m = model(t.clone());
        let mut w = m.workspace();
        m.update(&[1.], &mut w).unwrap();
        let r = w.responses().unwrap()[0];
        // These named opacity probes, not an all-opacity quadrature certificate.
        for g in [3, 5, 6] {
            let (capture, escape) = independent(&t, t.sigma_m2[g] / volume, 384);
            close(r.capture_m2[g], capture, 2e-5);
            if t.escape_depth > 0. {
                close(r.energy_escape_m2[g], escape, 2e-4);
                close(r.collected_m2[g], 0.5 * r.energy_escape_m2[g], 2e-15);
            }
        }
    }
}
#[test]
fn same_trial_amount_tangents_full_and_half_and_collection_energy_separation() {
    let t = target(0.002, 0.002260358, true);
    let m = model(t.clone());
    let mut w = m.workspace();
    m.update(&[1.], &mut w).unwrap();
    let base = w.responses().unwrap()[0];
    for h in [1e-4, 5e-5] {
        m.update(&[1. + h], &mut w).unwrap();
        let plus = w.responses().unwrap()[0];
        m.update(&[1. - h], &mut w).unwrap();
        let minus = w.responses().unwrap()[0];
        for g in 2..7 {
            close(
                (plus.capture_m2[g] - minus.capture_m2[g]) / (2. * h),
                base.d_capture_d_amount[g],
                2e-6,
            );
            close(
                (plus.energy_escape_m2[g] - minus.energy_escape_m2[g]) / (2. * h),
                base.d_energy_escape_d_amount[g],
                2e-6,
            );
            close(
                base.d_collected_d_amount[g],
                t.collection * base.d_energy_escape_d_amount[g],
                2e-15,
            );
        }
    }
    for c in [0., 1.] {
        let mut changed = t.clone();
        changed.collection = c;
        let other = model(changed);
        let mut ow = other.workspace();
        other.update(&[1.], &mut ow).unwrap();
        let r = ow.responses().unwrap()[0];
        assert_eq!(r.capture_m2, base.capture_m2);
        assert_eq!(r.energy_escape_m2, base.energy_escape_m2);
        for g in 0..7 {
            assert_eq!(r.collected_m2[g], c * r.energy_escape_m2[g]);
        }
    }
}
#[test]
fn finite_signed_population_ledger_and_acceptance_boundary() {
    let m = model(target(0., 0.004, false));
    let mut w = m.workspace();
    m.update(&[1.], &mut w).unwrap();
    let mut n = vec![1.; 14];
    for i in (0..14).step_by(3) {
        n[i] = -2.;
    }
    let mut rates = vec![0.; 14];
    let mut captures = vec![[0.; 7]; 1];
    let mut collected = captures.clone();
    let mut escaped = captures.clone();
    m.apply(
        &w,
        &n,
        &mut rates,
        &mut captures,
        &mut collected,
        &mut escaped,
    )
    .unwrap();
    close(
        rates.iter().sum::<f64>(),
        -captures[0].iter().sum::<f64>(),
        2e-15,
    );
    assert!(m.validate_accepted_state(&n).is_err());
    m.validate_accepted_state(&vec![0.; 14]).unwrap();
    let r = w.responses().unwrap()[0];
    for g in 0..7 {
        close(
            w.collision().unwrap()[0][g],
            r.capture_m2[g] * 0.4 / 2.,
            2e-15,
        );
    }
}
#[test]
fn no_target_duplication_cut_caps_foreign_workspace_or_invalid_trial_outputs() {
    let t = target(0., 0.004, false);
    assert!(Model::new(vec![1.], [1.; 7], vec![t.clone(), t.clone()], vec![], 1).is_err());
    assert!(
        Model::new(
            vec![1.],
            [1.; 7],
            vec![t.clone()],
            vec![Intersection {
                target: 0,
                region: 0,
                share: 0.5
            }],
            1
        )
        .is_err()
    );
    let m = model(t.clone());
    let other = model(t);
    let mut w = m.workspace();
    m.update(&[1.], &mut w).unwrap();
    assert!(m.geometry_payload_bytes() > 0);
    assert!(w.buffer_bytes() > 0);
    let ptr = w.responses().unwrap().as_ptr();
    m.update(&[0.9], &mut w).unwrap();
    assert_eq!(ptr, w.responses().unwrap().as_ptr());
    assert!(other.update(&[1.], &mut w).is_err());
    assert!(w.responses().is_err());
    assert!(m.update(&[-1.], &mut w).is_err());
    assert!(m.update(&[f64::NAN], &mut w).is_err());
    m.update(&[0.], &mut w).unwrap();
    assert!(w.collision().unwrap().iter().flatten().all(|v| *v == 0.));
}

fn response_bits(r: Response) -> Vec<u64> {
    [r.capture_m2, r.d_capture_d_amount, r.energy_escape_m2,
        r.d_energy_escape_d_amount, r.collected_m2, r.d_collected_d_amount]
        .into_iter().flatten().map(f64::to_bits).collect()
}

#[test]
fn exact_reuse_matches_fresh_responses_and_invalidates_after_failure() {
    let t = target(0.002, 0.002260358, true);
    let m = model(t.clone());
    let fresh = model(t);
    let mut cached = m.workspace();
    for amount in [1., 1., f64::from_bits(1f64.to_bits() + 1), 0., 0., 0.4, 1.] {
        m.update(&[amount], &mut cached).unwrap();
        // A fresh workspace cannot reuse the previous response.
        let mut direct = fresh.workspace();
        fresh.update(&[amount], &mut direct).unwrap();
        assert_eq!(response_bits(cached.responses().unwrap()[0]),
            response_bits(direct.responses().unwrap()[0]));
        assert_eq!(cached.collision().unwrap(), direct.collision().unwrap());
    }
    let mut direct = fresh.workspace();
    for amount in [-1., f64::NAN, f64::INFINITY] {
        assert!(m.update(&[amount], &mut cached).is_err());
        assert!(cached.responses().is_err());
        assert!(cached.collision().is_err());
        m.update(&[1.], &mut cached).unwrap();
        fresh.update(&[1.], &mut direct).unwrap();
        assert_eq!(response_bits(cached.responses().unwrap()[0]),
            response_bits(direct.responses().unwrap()[0]));
    }
    m.update(&[0.], &mut cached).unwrap();
    let zero = cached.responses().unwrap()[0];
    for g in 0..7 {
        assert_eq!(zero.capture_m2[g], 0.);
        assert_eq!(zero.energy_escape_m2[g], 0.);
        if g >= 2 {
            assert!(zero.d_capture_d_amount[g] > 0.);
            assert!(zero.d_energy_escape_d_amount[g] > 0.);
        } else {
            assert_eq!(zero.d_capture_d_amount[g], 0.);
            assert_eq!(zero.d_energy_escape_d_amount[g], 0.);
        }
    }
}

#[test]
fn target_local_reuse_keeps_complete_public_vector_validation() {
    let m = Model::new(vec![1.], [1.; 7], vec![target(0., 0.004, false)],
        vec![Intersection { target: 0, region: 0, share: 1. }], 3).unwrap();
    let mut w = m.workspace();
    m.update(&[1., 2., 3.], &mut w).unwrap();
    let before = response_bits(w.responses().unwrap()[0]);
    m.update(&[1., 4., 5.], &mut w).unwrap();
    assert_eq!(before, response_bits(w.responses().unwrap()[0]));
    assert!(m.update(&[1., 4., f64::NAN], &mut w).is_err());
    assert!(w.responses().is_err());
    m.update(&[1., 4., 5.], &mut w).unwrap();
    assert_eq!(before, response_bits(w.responses().unwrap()[0]));
}

#[test]
fn partial_response_failure_cannot_reuse_partially_updated_keys() {
    let first = target(0., 0.004, false);
    let mut second = first.clone();
    second.index = 1;
    second.sigma_m2[6] = 1e100;
    let m = Model::new(vec![1.], [1.; 7], vec![first, second],
        vec![Intersection { target: 0, region: 0, share: 1. },
             Intersection { target: 1, region: 0, share: 1. }], 2).unwrap();
    let mut w = m.workspace();
    m.update(&[1., 1.], &mut w).unwrap();
    // The first response/key is changed before the second opacity overflows.
    assert!(m.update(&[0.8, f64::MAX], &mut w).is_err());
    assert!(w.responses().is_err());
    m.update(&[0.8, 1.], &mut w).unwrap();
    let mut fresh = m.workspace();
    m.update(&[0.8, 1.], &mut fresh).unwrap();
    assert_eq!(w.responses().unwrap().iter().copied().map(response_bits).collect::<Vec<_>>(),
        fresh.responses().unwrap().iter().copied().map(response_bits).collect::<Vec<_>>());
    assert_eq!(w.collision().unwrap(), fresh.collision().unwrap());
}

#[test]
#[ignore = "Opt-in bounded fixed-state cost check; requires LEITBILD_SOURCE_FIXTURE"]
fn actual_composed_optical_and_cylindrical_cost() {
    use std::{hint::black_box, time::Instant};
    let path = std::env::var("LEITBILD_SOURCE_FIXTURE").expect("Actual frozen fixture required");
    let text = std::fs::read_to_string(path).unwrap();
    let words: Vec<_> = text.split_whitespace().collect();
    let mut cursor = words.iter().copied();
    let composed = source_input::framed(&mut cursor);
    let input = source_input::parse(&composed);
    let models: Vec<_> = input.optical_layers.iter()
        .map(|layers| optical_source::LayerModel::new(layers, &input.amounts).unwrap()).collect();
    let mut work: Vec<_> = models.iter().map(|model| model.workspace()).collect();
    let direction = vec![1e-5; input.nt];
    for (model, w) in models.iter().zip(&mut work) {
        model.update(&input.amounts, w).unwrap();
        model.jvp(&direction, w).unwrap();
    }
    const OPTICAL_REPEATS: usize = 16;
    let clock = Instant::now();
    for _ in 0..OPTICAL_REPEATS {
        for (model, w) in models.iter().zip(&mut work) {
            model.update(black_box(&input.amounts), w).unwrap();
            model.jvp(black_box(&direction), w).unwrap();
        }
    }
    let public_seconds = clock.elapsed().as_secs_f64() / OPTICAL_REPEATS as f64;
    let clock = Instant::now();
    for _ in 0..OPTICAL_REPEATS {
        // The composed owner validates complete vectors once, then calls the
        // dependency-safe local paths. Include that validation in this timing.
        assert!(black_box(&input.amounts).iter().all(|v| v.is_finite() && *v >= 0.));
        assert!(black_box(&direction).iter().all(|v| v.is_finite()));
        for (model, w) in models.iter().zip(&mut work) {
            model.update_dependencies(black_box(&input.amounts), w).unwrap();
            model.jvp_dependencies(black_box(&direction), w).unwrap();
        }
    }
    let local_seconds = clock.elapsed().as_secs_f64() / OPTICAL_REPEATS as f64;

    let mut cylinder = input.cylinder.workspace();
    let clock = Instant::now();
    input.cylinder.update(&input.amounts, &mut cylinder).unwrap();
    let first_seconds = clock.elapsed().as_secs_f64();
    let mut changed = input.amounts.clone();
    for target in &input.cylinders {
        let amount = changed[target.index];
        assert!(amount > 0.);
        changed[target.index] = f64::from_bits(amount.to_bits() + 1);
    }
    const CYLINDER_REPEATS: usize = 16;
    let clock = Instant::now();
    for i in 0..CYLINDER_REPEATS {
        let amounts = if i % 2 == 0 { &changed } else { &input.amounts };
        input.cylinder.update(black_box(amounts), &mut cylinder).unwrap();
    }
    let changed_seconds = clock.elapsed().as_secs_f64() / CYLINDER_REPEATS as f64;
    let clock = Instant::now();
    for _ in 0..CYLINDER_REPEATS {
        input.cylinder.update(black_box(&input.amounts), &mut cylinder).unwrap();
    }
    let reused_seconds = clock.elapsed().as_secs_f64() / CYLINDER_REPEATS as f64;
    let cached: Vec<_> = cylinder.responses().unwrap().iter().copied().map(response_bits).collect();
    let mut fresh = input.cylinder.workspace();
    input.cylinder.update(&input.amounts, &mut fresh).unwrap();
    assert_eq!(cached, fresh.responses().unwrap().iter().copied().map(response_bits).collect::<Vec<_>>());
    assert_eq!(cylinder.collision().unwrap(), fresh.collision().unwrap());
    println!("{{\"kind\":\"fixed-component-cost\",\"regions\":{},\"targets\":{},\"opticalFaces\":{},\"cylinders\":{},\"opticalUpdateAndJvpPublicSeconds\":{public_seconds:e},\"opticalUpdateAndJvpOnceValidatedSeconds\":{local_seconds:e},\"cylinderFirstSeconds\":{first_seconds:e},\"cylinderAllAmountsChangedSeconds\":{changed_seconds:e},\"cylinderExactReuseSeconds\":{reused_seconds:e},\"noTimeAdvanced\":true}}",
        input.nr, input.nt, models.len(), input.cylinders.len());
}

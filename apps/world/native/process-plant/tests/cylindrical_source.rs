#[path = "../src/cylindrical_source.rs"]
mod cylindrical_source;
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

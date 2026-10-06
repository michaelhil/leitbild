#[path = "../src/fuel_source.rs"]
mod fuel_source;
#[path = "../src/moderator_source.rs"]
mod moderator_source;
#[path = "../src/transport_source.rs"]
mod transport_source;
use transport_source::*;
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 2e-9 * a.abs().max(b.abs()).max(1e-12),
        "{a} vs {b}"
    );
}
fn face(law: FaceLaw) -> Face {
    Face {
        left: 0,
        right: Some(1),
        area: 2.,
        left_distance: 0.3,
        right_distance: Some(0.8),
        law,
    }
}
fn input(t: f64) -> OpticalInput {
    OpticalInput {
        transmission: [t; 7],
        loss: [1. - t; 7],
        from_left: vec![
            [if t == 1. { 0. } else { 0.25 }; 7],
            [if t == 1. { 0. } else { 0.75 }; 7],
        ],
        from_right: vec![
            [if t == 1. { 0. } else { 0.8 }; 7],
            [if t == 1. { 0. } else { 0.2 }; 7],
        ],
    }
}
fn model(law: FaceLaw) -> Model {
    Model::new(vec![2., 5.], vec![4., 6.], [3.; 7], vec![face(law)], 2).unwrap()
}
#[test]
fn transparent_reciprocity_amount_matrix_and_disconnected_null_mode() {
    let m = Model::new(
        vec![2., 5., 7.],
        vec![4., 6., 3.],
        [3.; 7],
        vec![face(FaceLaw::Transparent)],
        0,
    )
    .unwrap();
    let mut w = m.workspace();
    m.update(&[[2.; 7], [4.; 7], [1.; 7]], &[], &mut w).unwrap();
    let mut n = vec![0.; 21];
    for g in 0..7 {
        n[g] = 2.;
        n[7 + g] = 5.;
        n[14 + g] = 11.;
    }
    let mut r = n.clone();
    let mut e = [0.; 7];
    m.apply(&w, &n, &mut r, &mut [], &mut e).unwrap();
    assert!(r.iter().all(|v| *v == 0.));
    n[0] = -2.;
    m.apply(&w, &n, &mut r, &mut [], &mut e).unwrap();
    close(r[0] + r[7], 0.);
    assert!(m.validate_accepted_state(&n).is_err());
    let mut matrix = vec![0.; 21];
    for (c, v) in m.coordinates().iter().zip(w.coefficients().unwrap()) {
        matrix[c.row] += v * n[c.column];
    }
    for (a, b) in matrix.iter().zip(&r) {
        close(*a, *b);
    }
    for (c, v) in m.coordinates().iter().zip(w.coefficients().unwrap()) {
        if c.row != c.column {
            assert!(*v >= 0.);
        }
    }
}
#[test]
fn ordered_capture_and_escape_close_signed_number_ledger() {
    let mut faces = vec![face(FaceLaw::Optical {
        targets: vec![0, 1],
    })];
    faces.push(Face {
        left: 1,
        right: None,
        area: 1.,
        left_distance: 0.4,
        right_distance: None,
        law: FaceLaw::Escape,
    });
    let m = Model::new(vec![2., 5.], vec![4., 6.], [3.; 7], faces, 2).unwrap();
    let mut w = m.workspace();
    m.update(&[[2.; 7], [4.; 7]], &[input(0.3)], &mut w)
        .unwrap();
    let n = (0..14)
        .map(|i| if i % 3 == 0 { -1. } else { 2. })
        .collect::<Vec<_>>();
    let mut r = vec![0.; 14];
    let mut c = vec![[0.; 7]; 2];
    let mut e = [0.; 7];
    m.apply(&w, &n, &mut r, &mut c, &mut e).unwrap();
    for g in 0..7 {
        let terms = [r[g], r[g + 7], c[0][g], c[1][g], e[g]];
        assert!(
            terms.iter().sum::<f64>().abs()
                <= 32. * f64::EPSILON * terms.iter().map(|v| v.abs()).sum::<f64>()
        );
    }
    assert!(e.iter().any(|v| *v < 0.));
}
#[test]
fn transparent_black_limits_and_geometrical_split() {
    let col = [[2.; 7], [4.; 7]];
    let m = model(FaceLaw::Optical {
        targets: vec![0, 1],
    });
    let mut w = m.workspace();
    m.update(&col, &[input(1.)], &mut w).unwrap();
    let tr = model(FaceLaw::Transparent);
    let mut tw = tr.workspace();
    tr.update(&col, &[], &mut tw).unwrap();
    let c = w.face_coefficients().unwrap()[0][0];
    close(
        c.exchange.value,
        tw.face_coefficients().unwrap()[0][0].exchange.value,
    );
    assert_eq!(c.capture_left.value, 0.);
    assert_eq!(c.capture_right.value, 0.);
    m.update(&col, &[input(0.)], &mut w).unwrap();
    let c = w.face_coefficients().unwrap()[0][0];
    assert_eq!(c.exchange.value, 0.);
    close(c.capture_left.value, 2. / (2. + 3. * 0.3 * 2.));
    close(c.capture_right.value, 2. / (2. + 3. * 0.8 * 4.));
    let mut half = face(FaceLaw::Transparent);
    half.area = 1.;
    let split = Model::new(
        vec![2., 5.],
        vec![4., 6.],
        [3.; 7],
        vec![half.clone(), half],
        0,
    )
    .unwrap();
    let mut sw = split.workspace();
    split.update(&col, &[], &mut sw).unwrap();
    close(
        sw.face_coefficients()
            .unwrap()
            .iter()
            .map(|x| x[0].exchange.value)
            .sum(),
        tw.face_coefficients().unwrap()[0][0].exchange.value,
    );
}
#[test]
fn analytic_local_collision_transmission_partials_full_half() {
    let m = model(FaceLaw::Optical {
        targets: vec![0, 1],
    });
    let mut w = m.workspace();
    let pattern = m.coordinates().as_ptr();
    let col = [[2.; 7], [4.; 7]];
    m.update(&col, &[input(0.37)], &mut w).unwrap();
    let buffer = w.coefficients().unwrap().as_ptr();
    let faces = w.face_coefficients().unwrap().as_ptr();
    let base = w.face_coefficients().unwrap()[0][0];
    for j in 0..3 {
        for h in [1e-4, 5e-5] {
            let mut plus = col;
            let mut minus = col;
            let mut tp = 0.37;
            let mut tm = 0.37;
            if j < 2 {
                plus[j][0] += h;
                minus[j][0] -= h;
            } else {
                tp += h;
                tm -= h;
            }
            m.update(&plus, &[input(tp)], &mut w).unwrap();
            let a = w.face_coefficients().unwrap()[0][0];
            m.update(&minus, &[input(tm)], &mut w).unwrap();
            let b = w.face_coefficients().unwrap()[0][0];
            for (x, y, z) in [
                (base.exchange, a.exchange, b.exchange),
                (base.capture_left, a.capture_left, b.capture_left),
                (base.capture_right, a.capture_right, b.capture_right),
            ] {
                close(x.derivatives[j], (y.value - z.value) / (2. * h));
            }
        }
    }
    assert_eq!(pattern, m.coordinates().as_ptr());
    assert_eq!(buffer, w.coefficients().unwrap().as_ptr());
    assert_eq!(faces, w.face_coefficients().unwrap().as_ptr());
}
#[test]
fn cap_one_sided_and_strict_optical_errors_invalidate_candidate() {
    let m = model(FaceLaw::Optical {
        targets: vec![0, 1],
    });
    let mut w = m.workspace();
    m.update(&[[0.; 7], [0.; 7]], &[input(0.4)], &mut w)
        .unwrap();
    assert_eq!(
        w.face_coefficients().unwrap()[0][0].exchange.derivatives[0],
        0.
    );
    m.update(&[[0.25; 7], [1. / 6.; 7]], &[input(0.4)], &mut w)
        .unwrap();
    let tie = w.face_coefficients().unwrap()[0][0];
    assert_eq!(tie.exchange.derivatives[0], 0.);
    assert_eq!(tie.exchange.derivatives[1], 0.);
    m.update(&[[0.25 - 1e-6; 7], [1. / 6.; 7]], &[input(0.4)], &mut w)
        .unwrap();
    assert_eq!(
        tie.exchange.value,
        w.face_coefficients().unwrap()[0][0].exchange.value
    );
    let mut bad = input(0.4);
    bad.from_right[1][0] = 0.3;
    assert!(m.update(&[[2.; 7], [4.; 7]], &[bad], &mut w).is_err());
    assert!(w.coefficients().is_err());
    assert!(m.update(&[[2.; 7], [4.; 7]], &[], &mut w).is_err());
    let other = model(FaceLaw::Transparent);
    assert!(other.update(&[[2.; 7], [4.; 7]], &[], &mut w).is_err());
    let mut bad = input(1.);
    bad.from_left[0][0] = 1.;
    assert!(m.update(&[[2.; 7], [4.; 7]], &[bad], &mut w).is_err());
    assert!(m
        .update(&[[f64::MAX; 7], [f64::MAX; 7]], &[input(0.4)], &mut w)
        .is_err());
    assert!(Model::new(
        vec![1.],
        vec![1.],
        [1.; 7],
        vec![Face {
            left: 0,
            right: None,
            area: 1.,
            left_distance: 1.,
            right_distance: None,
            law: FaceLaw::Transparent
        }],
        0
    )
    .is_err());
    m.update(&[[2.; 7], [4.; 7]], &[input(0.4)], &mut w)
        .unwrap();
    assert!(m
        .apply(
            &w,
            &[f64::MAX; 14],
            &mut [0.; 14],
            &mut [[0.; 7]; 2],
            &mut [0.; 7]
        )
        .is_err());
}
#[test]
fn escape_collision_tangent_and_accepted_finite_boundary() {
    let m = Model::new(
        vec![2.],
        vec![4.],
        [3.; 7],
        vec![Face {
            left: 0,
            right: None,
            area: 2.,
            left_distance: 0.3,
            right_distance: None,
            law: FaceLaw::Escape,
        }],
        0,
    )
    .unwrap();
    let mut w = m.workspace();
    m.update(&[[2.; 7]], &[], &mut w).unwrap();
    let c = w.face_coefficients().unwrap()[0][0].escape;
    for h in [1e-4, 5e-5] {
        m.update(&[[2. + h; 7]], &[], &mut w).unwrap();
        let p = w.face_coefficients().unwrap()[0][0].escape.value;
        m.update(&[[2. - h; 7]], &[], &mut w).unwrap();
        let n = w.face_coefficients().unwrap()[0][0].escape.value;
        close(c.derivatives[0], (p - n) / (2. * h));
    }
    assert!(m.validate_accepted_state(&[f64::INFINITY; 7]).is_err());
    assert!(m.validate_accepted_state(&[0.; 6]).is_err());
    m.validate_accepted_state(&[0.; 7]).unwrap();
}
fn fuel() -> fuel_source::FuelModel {
    use fuel_source::*;
    FuelModel::new(
        FuelLaw {
            absorption: [0.4; 7],
            fission: [0.1; 7],
            scatter: [[0.2; 7]; 7],
            nu: [2.; 7],
            chi: [1. / 7.; 7],
            speed: [3.; 7],
            beta: [0.001; 6],
            decay: [0.1; 6],
            f_d: 0.2,
        },
        vec![2.],
        vec![1.],
        vec![Cohort {
            segment: 0,
            mass: 5.,
            mu: 1.,
        }],
        vec![Intersection {
            region: 0,
            segment: 0,
            volume: 1.,
            weights: vec![Weight {
                cohort: 0,
                mass: 5.,
            }],
        }],
    )
    .unwrap()
}
#[test]
fn fuel_signed_trial_and_heat_are_linear_but_accepted_amounts_are_positive() {
    use fuel_source::*;
    let m = fuel();
    let mut w = m.workspace();
    m.update(
        &[300.],
        &[Stocks {
            reserve: 1.,
            reference_reserve: 1.,
            fertile: 1.,
            reference_fertile: 1.,
        }],
        &mut w,
    )
    .unwrap();
    let n = vec![1.; 13];
    let mut r = vec![0.; 13];
    let mut e = vec![[0.; 2]];
    m.apply(&w, &n, &mut r, &mut e).unwrap();
    let rp = r.clone();
    let ep = e.clone();
    let signed = vec![-1.; 13];
    m.apply(&w, &signed, &mut r, &mut e).unwrap();
    for (a, b) in r.iter().zip(rp) {
        close(*a, -b);
    }
    close(e[0][0], -ep[0][0]);
    assert!(m.validate_accepted_state(&signed).is_err());
    m.validate_accepted_state(&vec![0.; 13]).unwrap();
    let mut h = [0.];
    m.fuel_heat(&e, 2., &[-3.], &mut h).unwrap();
    close(h[0], 2. * e[0][0] - 3.);
    let mut collision = vec![[0.; 7]];
    m.collision_into(&w, &mut collision).unwrap();
    close(collision[0][0], 0.5 * (0.4 + 7. * 0.2));
    let mut invalid = signed;
    invalid[0] = f64::NAN;
    assert!(m.apply(&w, &invalid, &mut r, &mut e).is_err());
}
#[test]
fn moderator_collision_contains_absorption_boron_and_self_scatter_once() {
    use moderator_source::*;
    let m = ModeratorModel::new(
        ModeratorLaw {
            absorption: [0.3; 7],
            scatter: [[0.2; 7]; 7],
            speed: [3.; 7],
            boron_sigma: [0.4; 7],
            reference_density: 2.,
            hydrogen_emission: [0.; 2],
            boron_emission: [0.; 2],
        },
        vec![2.],
        vec![Intersection {
            region: 0,
            volume: 1.,
        }],
    )
    .unwrap();
    let mut w = m.workspace();
    m.update(
        &[Stocks {
            water_mass: 2.,
            liquid_volume: 1.,
            hydrogen_target: 1.,
            hydrogen_product: 0.,
            mobile_boron10: 1.,
        }],
        &mut w,
    )
    .unwrap();
    let mut c = vec![[0.; 7]];
    m.collision_into(&w, &mut c).unwrap();
    close(c[0][0], 0.5 * (0.3 + 7. * 0.2) + 0.4 / 2.);
}

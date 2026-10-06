//! Mathematical component fixtures, not LD-01 preparations or time evolution.
use leitbild_plant_numerics::{
    fuel_history::*,
    fuel_source::*,
    heat_history::{Feed, Group, Kernel},
};

fn model(reference: f64) -> Assembly {
    let fuel = FuelModel::new(
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
        vec![2., 3.],
        vec![1., 0.5],
        vec![
            Cohort {
                segment: 0,
                mass: 2.,
                mu: 0.4,
            },
            Cohort {
                segment: 0,
                mass: 3.,
                mu: 0.6,
            },
            Cohort {
                segment: 1,
                mass: 5.,
                mu: 1.,
            },
        ],
        vec![
            Intersection {
                region: 0,
                segment: 0,
                volume: 0.3,
                weights: vec![
                    Weight {
                        cohort: 0,
                        mass: 0.6,
                    },
                    Weight {
                        cohort: 1,
                        mass: 0.9,
                    },
                ],
            },
            Intersection {
                region: 1,
                segment: 0,
                volume: 0.7,
                weights: vec![
                    Weight {
                        cohort: 0,
                        mass: 1.4,
                    },
                    Weight {
                        cohort: 1,
                        mass: 2.1,
                    },
                ],
            },
            Intersection {
                region: 1,
                segment: 1,
                volume: 0.5,
                weights: vec![Weight {
                    cohort: 2,
                    mass: 5.,
                }],
            },
        ],
    )
    .unwrap();
    let heat = Kernel::new(
        (0..25)
            .map(|i| Group {
                feed: if i < 23 {
                    Feed::Fission
                } else {
                    Feed::FertileCapture
                },
                energy_per_event: if i < 23 { 0.1 } else { 0.3 },
                decay_rate: 0.01 * (i + 1) as f64,
            })
            .collect(),
        10.,
    )
    .unwrap();
    Assembly::new(
        fuel,
        vec![
            SegmentPreparation {
                reference_u235: reference,
                reference_u238: 2. * reference,
                sf235_neutrons_per_second: 2.,
                sf238_neutrons_per_second: 3.
            };
            2
        ],
        PoisonLaw {
            yield_i: 0.06,
            yield_xe: 0.003,
            yield_pm: 0.01,
            lambda_i: 0.02,
            lambda_xe: 0.03,
            lambda_pm: 0.01,
            xe_sigma_m2: 0.1,
            sm_sigma_m2: 0.2,
        },
        heat,
        2.5,
        CfLaw {
            initial_energy_j: 1000.,
            initial_neutrons_per_second: 4.,
            decay_rate: 0.01,
            birth_export_j_per_neutron: 0.5,
        },
        vec![(0, 0.25), (1, 0.75)],
    )
    .unwrap()
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() < 2e-10 * (1. + a.abs().max(b.abs())),
        "{a:e} != {b:e}"
    );
}
#[test]
fn original_zero_field_has_real_births_and_histories_but_no_sf_precursors() {
    let m = model(1e28);
    let y = m.initial_state();
    let mut w = m.workspace();
    m.validate_accepted_state(&y).unwrap();
    m.evaluate_into(&[300.; 3], &y, &mut w).unwrap();
    let r = w.rates().unwrap();
    close(r[..14].iter().sum(), 14.); // Two 5 n/s isotope sources plus 4 n/s capsule.
    assert!(r[14..m.fuel_dimension()].iter().all(|v| *v == 0.));
    for s in 0..2 {
        let o = m.history_row(s, 0);
        close(r[o + CONSUMED_235], 0.8);
        close(r[o + SF_238], 1.2);
        close(r[o + CAPTURED_238], 0.);
        close(r[o + IODINE], 0.12);
        assert!(r[o + ENERGY..o + ENERGY + 23].iter().all(|v| *v > 0.));
        assert_eq!(&r[o + ENERGY + 23..o + HISTORY], &[0.; 2]);
    }
    let cf = w.cf().unwrap();
    close(cf.paid_release, cf.capsule_release + cf.birth_export);
    close(r[m.cf_row()], -cf.paid_release);
    let mut progressed = y.clone();
    progressed[m.history_row(0, CONSUMED_235)] = 0.8;
    assert_eq!(1e28 - 0.8, 1e28); // Large donor cannot resolve this real progress in-place.
    m.validate_accepted_state(&progressed).unwrap();
    assert_eq!(progressed[m.history_row(0, CONSUMED_235)], 0.8);
}
#[test]
fn shared_event_count_poison_and_energy_ledgers() {
    let m = model(1000.);
    let mut y = m.initial_state();
    y[..m.fuel_dimension()].fill(2.);
    for s in 0..2 {
        let o = m.history_row(s, 0);
        y[o + CONSUMED_235] = 7.;
        y[o + CAPTURED_238] = 11.;
        y[o + SF_238] = 13.;
        y[o + IODINE] = 3.;
        y[o + XENON] = 4.;
        y[o + PROMETHIUM] = 5.;
        y[o + SAMARIUM] = 6.;
        y[o + ENERGY..o + HISTORY].fill(0.8);
    }
    let mut w = m.workspace();
    m.evaluate_into(&[300.; 3], &y, &mut w).unwrap();
    let r = w.rates().unwrap();
    let mut expected = w.cf().unwrap().births;
    for s in 0..2 {
        let o = m.history_row(s, 0);
        let a = w.segments().unwrap()[s];
        expected += a.induced_fission - a.fertile_capture + 2.5 * (a.sf235 + a.sf238)
            - a.xe_capture
            - a.sm_capture;
        close(r[o + CONSUMED_235], a.induced_fission + a.sf235);
        close(r[o + CAPTURED_238], a.fertile_capture);
        close(r[o + SF_238], a.sf238);
        close(r[o + XENON_PRODUCT], a.xe_capture);
        close(r[o + SAMARIUM_PRODUCT], a.sm_capture);
        close(
            r[o + PROMETHIUM] + r[o + SAMARIUM] + r[o + SAMARIUM_PRODUCT],
            0.01 * (a.induced_fission + a.sf235 + a.sf238),
        );
        close(
            a.prompt_release + a.delayed_release + r[o + ENERGY..o + HISTORY].iter().sum::<f64>(),
            10. * (a.induced_fission + a.sf235 + a.sf238) + 0.6 * a.fertile_capture,
        );
    }
    close(r[..m.fuel_dimension()].iter().sum(), expected);
}
#[test]
fn entire_composed_jvp_matches_full_and_half_local_perturbations() {
    let m = model(1000.);
    let mut y = m.initial_state();
    y[..m.fuel_dimension()].fill(2.);
    for s in 0..2 {
        let o = m.history_row(s, 0);
        y[o..o + HISTORY].fill(3.);
    }
    let t = [420., 530., 610.];
    let dt = [0.7, -0.3, 0.5];
    let dy = (0..y.len())
        .map(|i| 0.1 * ((i % 9) as f64 - 4.))
        .collect::<Vec<_>>();
    let mut w = m.workspace();
    m.evaluate_into(&t, &y, &mut w).unwrap();
    m.jvp_into(&dt, &dy, &mut w).unwrap();
    let mut plus = m.workspace();
    let mut minus = m.workspace();
    for h in [1e-3, 5e-4] {
        let yp = y
            .iter()
            .zip(&dy)
            .map(|(a, d)| a + h * d)
            .collect::<Vec<_>>();
        let ym = y
            .iter()
            .zip(&dy)
            .map(|(a, d)| a - h * d)
            .collect::<Vec<_>>();
        m.evaluate_into(
            &std::array::from_fn::<_, 3, _>(|i| t[i] + h * dt[i]),
            &yp,
            &mut plus,
        )
        .unwrap();
        m.evaluate_into(
            &std::array::from_fn::<_, 3, _>(|i| t[i] - h * dt[i]),
            &ym,
            &mut minus,
        )
        .unwrap();
        for (i, (&a, (&p, &n))) in w
            .rate_jvp()
            .unwrap()
            .iter()
            .zip(plus.rates().unwrap().iter().zip(minus.rates().unwrap()))
            .enumerate()
        {
            let f = (p - n) / (2. * h);
            assert!(
                (a - f).abs() < 2e-7 * (1. + a.abs()),
                "row {i}: {a:e} vs {f:e}"
            );
        }
        for (&a, (&p, &n)) in w.collision_jvp().unwrap().iter().flatten().zip(
            plus.collision()
                .unwrap()
                .iter()
                .flatten()
                .zip(minus.collision().unwrap().iter().flatten()),
        ) {
            close(a, (p - n) / (2. * h));
        }
        for s in 0..2 {
            let p = plus.segments().unwrap()[s];
            let n = minus.segments().unwrap()[s];
            let d = w.segment_jvp().unwrap()[s];
            close(
                d.prompt_release,
                (p.prompt_release - n.prompt_release) / (2. * h),
            );
            close(
                d.delayed_release,
                (p.delayed_release - n.delayed_release) / (2. * h),
            );
        }
    }
}
#[test]
fn signed_trials_are_not_accepted_or_clipped_and_failures_invalidate() {
    let m = model(1000.);
    let mut y = m.initial_state();
    y[..m.fuel_dimension()].fill(-2.);
    y[m.history_row(0, CONSUMED_235)] = -1.;
    y[m.history_row(0, ENERGY)] = -3.;
    let mut w = m.workspace();
    m.evaluate_into(&[300.; 3], &y, &mut w).unwrap();
    assert!(w.rates().unwrap()[m.history_row(0, CONSUMED_235)] < 0.);
    assert!(m.validate_accepted_state(&y).is_err());
    assert_eq!(y[m.history_row(0, CONSUMED_235)], -1.);
    let ptr = w.rates().unwrap().as_ptr();
    m.evaluate_into(&[301.; 3], &m.initial_state(), &mut w)
        .unwrap();
    assert_eq!(ptr, w.rates().unwrap().as_ptr());
    assert!(m
        .jvp_into(&[0.; 2], &vec![0.; m.state_count()], &mut w)
        .is_err());
    assert!(w.rate_jvp().is_err());
    let mut exhausted = m.initial_state();
    exhausted[m.history_row(0, CAPTURED_238)] = 2001.;
    assert!(m.validate_accepted_state(&exhausted).is_err());
    assert!(m.evaluate_into(&[300.; 3], &exhausted, &mut w).is_err());
    assert!(w.rates().is_err());
    assert!(m
        .evaluate_into(&[300.; 3], &vec![f64::NAN; m.state_count()], &mut w)
        .is_err());
    let foreign = model(1000.);
    assert!(foreign
        .evaluate_into(&[300.; 3], &foreign.initial_state(), &mut w)
        .is_err());
}

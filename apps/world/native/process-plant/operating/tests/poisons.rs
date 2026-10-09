use leitbild_operating_plant::poisons::{Input, InputDirection, Model, Parameters};

// Synthetic coefficients; neither an LD-01 yield table nor reactivity calibration.
fn model() -> Model {
    Model::new(Parameters {
        decay_per_s: [0.2, 0.1, 0.05],
        direct_atoms_per_fission: [0.06, 0.003, 0.01, 0.],
    })
    .unwrap()
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-8 * expected.abs().max(1.),
        "{actual} != {expected}"
    );
}

#[test]
fn independent_balance_tracks_direct_production_decay_and_capture() {
    let n = [10., 20., 30., 40.];
    let input = Input {
        fissions_per_s: 100.,
        capture_per_s: [0.01, 0.02, 0.03, 0.04],
    };
    let mut rates = [0.; 4];
    model().rates(&n, input, &mut rates).unwrap();
    near(rates[0], 3.9);
    near(rates[1], -0.1);
    near(rates[2], -1.4);
    near(rates[3], -0.1);
    // Internal I->Xe and Pm->Sm cancel in the sum; Xe decay leaves this tracked set.
    let captures: f64 = n.iter().zip(input.capture_per_s).map(|(n, c)| n * c).sum();
    near(rates.iter().sum::<f64>(), 7.3 - captures - 0.1 * n[1]);
}

#[test]
fn post_trip_daughter_build_up_is_not_deleted_with_fission_power() {
    let mut rates = [0.; 4];
    model()
        .rates(
            &[10., 1., 30., 1.],
            Input {
                fissions_per_s: 0.,
                capture_per_s: [0.; 4],
            },
            &mut rates,
        )
        .unwrap();
    near(rates[0], -2.);
    near(rates[1], 1.9);
    near(rates[2], -1.5);
    near(rates[3], 1.5);
    model()
        .rates(
            &[0., 0., 0., 40.],
            Input {
                fissions_per_s: 0.,
                capture_per_s: [0.; 4],
            },
            &mut rates,
        )
        .unwrap();
    assert_eq!(rates, [0.; 4]); // Stable Sm remains; no invented decay.
}

#[test]
fn equilibrium_satisfies_coupled_parent_daughter_equations() {
    let input = Input {
        fissions_per_s: 100.,
        capture_per_s: [0.01, 0.02, 0.03, 0.04],
    };
    let iodine = 6. / 0.21;
    let xenon = (0.3 + 0.2 * iodine) / 0.12;
    let pm = 1. / 0.08;
    let sm = 0.05 * pm / 0.04;
    let mut rates = [0.; 4];
    model()
        .rates(&[iodine, xenon, pm, sm], input, &mut rates)
        .unwrap();
    for rate in rates {
        near(rate, 0.);
    }
}

#[test]
fn tangent_matches_differentiation_of_state_and_constitutive_inputs() {
    let m = model();
    let n = [10., 20., 30., 40.];
    let v = [-1., 2., -3., 4.];
    let input = Input {
        fissions_per_s: 100.,
        capture_per_s: [0.01, 0.02, 0.03, 0.04],
    };
    let delta = InputDirection {
        fissions_per_s: -5.,
        capture_per_s: [0.001, -0.002, 0.003, -0.004],
    };
    let mut tangent = [0.; 4];
    m.tangent(&n, input, &v, delta, &mut tangent).unwrap();
    let eps = 1e-5;
    let evaluate = |scale: f64| {
        let state = std::array::from_fn(|i| n[i] + scale * v[i]);
        let forcing = Input {
            fissions_per_s: input.fissions_per_s + scale * delta.fissions_per_s,
            capture_per_s: std::array::from_fn(|i| {
                input.capture_per_s[i] + scale * delta.capture_per_s[i]
            }),
        };
        let mut out = [0.; 4];
        m.rates(&state, forcing, &mut out).unwrap();
        out
    };
    let plus = evaluate(eps);
    let minus = evaluate(-eps);
    for i in 0..4 {
        near(tangent[i], (plus[i] - minus[i]) / (2. * eps));
    }
}

#[test]
fn physical_admission_is_separate_from_newton_trials() {
    let m = model();
    assert!(m.validate_accepted_state(&[-1., 0., 0., 0.]).is_err());
    assert!(m.validate_accepted_state(&[0., 0., f64::NAN, 0.]).is_err());
    let input = Input {
        fissions_per_s: 0.,
        capture_per_s: [0.; 4],
    };
    m.rates(&[-1., 0., 0., 0.], input, &mut [0.; 4]).unwrap();
    let signed_trial = Input {
        fissions_per_s: -1.,
        capture_per_s: [-1.; 4],
    };
    assert!(m.validate_accepted_input(signed_trial).is_err());
    m.rates(&[0.; 4], signed_trial, &mut [0.; 4]).unwrap();
    assert!(
        Model::new(Parameters {
            decay_per_s: [0.2, 0.1, 0.],
            direct_atoms_per_fission: [0.; 4]
        })
        .is_err()
    );
}

use leitbild_operating_plant::heat_history::{Error, Group, Model};

// Synthetic coefficients test the equations, not a calibrated LD-01 dataset.
fn model() -> Model {
    Model::new(
        10.,
        vec![
            Group {
                decay_per_s: 0.5,
                retained_joules_per_event: 2.,
            },
            Group {
                decay_per_s: 0.1,
                retained_joules_per_event: 1.,
            },
        ],
    )
    .unwrap()
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-10 * expected.abs().max(1.),
        "{actual} != {expected}"
    );
}

#[test]
fn prompt_release_and_storage_balance_exact_event_budget() {
    let mut rate = [0.; 2];
    let heat = model().rates(&[8., 15.], 4., &mut rate).unwrap();
    near(heat.prompt_w, 28.);
    near(heat.delayed_w, 5.5);
    near(heat.retained_input_w, 12.);
    near(
        heat.prompt_w + heat.delayed_w + rate.iter().sum::<f64>(),
        40.,
    );
}

#[test]
fn shutdown_retains_history_instead_of_following_current_power() {
    let mut rate = [0.; 2];
    let heat = model().rates(&[8., 15.], 0., &mut rate).unwrap();
    near(heat.prompt_w, 0.);
    near(heat.delayed_w, 5.5);
    near(rate.iter().sum::<f64>() + heat.delayed_w, 0.);
}

#[test]
fn analytic_constant_source_solution_satisfies_rates_at_multiple_times() {
    let initial = [1., 9.];
    for time in [0., 0.1, 10., 100.] {
        let lambda = [0.5, 0.1];
        let production = [8., 4.];
        let mut energy = [0.; 2];
        let mut expected = [0.; 2];
        for i in 0..2 {
            let equilibrium = production[i] / lambda[i];
            let decay = f64::exp(-lambda[i] * time);
            energy[i] = equilibrium + (initial[i] - equilibrium) * decay;
            expected[i] = -lambda[i] * (initial[i] - equilibrium) * decay;
        }
        let mut rate = [0.; 2];
        model().rates(&energy, 4., &mut rate).unwrap();
        for i in 0..2 {
            near(rate[i], expected[i]);
        }
    }
}

#[test]
fn fission_and_capture_feed_independently_without_borrowed_energy() {
    let fission = model();
    let capture = Model::new(
        3.,
        vec![Group {
            decay_per_s: 0.2,
            retained_joules_per_event: 3.,
        }],
    )
    .unwrap();
    let mut fission_rate = [0.; 2];
    let mut capture_rate = [0.; 1];
    let a = fission.rates(&[0., 0.], 4., &mut fission_rate).unwrap();
    let b = capture.rates(&[0.], 0., &mut capture_rate).unwrap();
    near(a.retained_input_w, 12.);
    near(b.retained_input_w, 0.);
    let b = capture.rates(&[0.], 7., &mut capture_rate).unwrap();
    near(b.prompt_w, 0.);
    near(b.retained_input_w, 21.);
    near(
        a.prompt_w
            + a.delayed_w
            + fission_rate.iter().sum::<f64>()
            + b.prompt_w
            + b.delayed_w
            + capture_rate[0],
        61.,
    );
}

#[test]
fn exact_tangent_includes_event_rate_direction() {
    let m = model();
    let state = [8., 15.];
    let direction = [-2., 3.];
    let mut tangent = [0.; 2];
    let h = m.tangent(&direction, -0.7, &mut tangent).unwrap();
    let eps = 1e-5;
    let plus = std::array::from_fn::<_, 2, _>(|i| state[i] + eps * direction[i]);
    let minus = std::array::from_fn::<_, 2, _>(|i| state[i] - eps * direction[i]);
    let mut rp = [0.; 2];
    let mut rm = [0.; 2];
    let hp = m.rates(&plus, 4. - eps * 0.7, &mut rp).unwrap();
    let hm = m.rates(&minus, 4. + eps * 0.7, &mut rm).unwrap();
    for i in 0..2 {
        near(tangent[i], (rp[i] - rm[i]) / (2. * eps));
    }
    near(h.prompt_w, (hp.prompt_w - hm.prompt_w) / (2. * eps));
    near(h.delayed_w, (hp.delayed_w - hm.delayed_w) / (2. * eps));
}

#[test]
fn invalid_data_fail_without_clipping_solver_trials() {
    assert!(
        Model::new(
            1.,
            vec![Group {
                decay_per_s: 1.,
                retained_joules_per_event: 2.
            }]
        )
        .is_err()
    );
    assert!(
        Model::new(
            1.,
            vec![Group {
                decay_per_s: 0.,
                retained_joules_per_event: 0.
            }]
        )
        .is_err()
    );
    let m = model();
    assert!(m.validate_accepted_state(&[-1., 0.]).is_err());
    assert!(m.validate_accepted_state(&[f64::NAN, 0.]).is_err());
    assert!(m.validate_accepted_input(-1.).is_err());
    m.rates(&[0., 0.], -1., &mut [0.; 2]).unwrap();
    assert!(m.rates(&[0.], 1., &mut [0.; 2]).is_err());
    m.rates(&[-1., 0.], 1., &mut [0.; 2]).unwrap();
    assert!(matches!(
        m.rates(&[f64::MAX, f64::MAX], f64::MAX, &mut [0.; 2]),
        Err(Error::NonfiniteResult)
    ));
}

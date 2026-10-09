use leitbild_operating_plant::kinetics::{
    DELAYED_GROUPS, Error, InputDirection, Inputs, Model, ReactivityDomain, RegionInput,
    RegionInputDirection, RegionParameters, STATES_PER_REGION, Transfer,
};

// Synthetic numerical fixtures only, NOT selected LD-01 coefficients.
fn region(generation_time_s: f64) -> RegionParameters {
    RegionParameters {
        generation_time_s,
        delayed_fractions: [0.001, 0.0008, 0.0012, 0.001, 0.0011, 0.0009],
        decay_constants_per_s: [0.01, 0.03, 0.1, 0.3, 1., 3.],
        reactivity_domain: ReactivityDomain {
            minimum: -0.3,
            maximum: 0.2,
        },
    }
}

fn input(reactivity: f64, source: f64) -> RegionInput {
    RegionInput {
        reactivity,
        external_source_per_s: source,
    }
}

fn close(actual: f64, expected: f64, relative: f64) {
    assert!(
        (actual - expected).abs() <= relative * (1. + expected.abs()),
        "{actual} != {expected}"
    );
}

fn equilibrium(p: RegionParameters, n: f64) -> [f64; STATES_PER_REGION] {
    let mut state = [0.; STATES_PER_REGION];
    state[0] = n;
    for g in 0..DELAYED_GROUPS {
        state[g + 1] =
            p.delayed_fractions[g] * n / (p.generation_time_s * p.decay_constants_per_s[g]);
    }
    state
}

#[test]
fn independent_global_balance_includes_source_and_cancels_delayed_and_internal_transfers() {
    let p = [region(0.02), region(0.07), region(0.11)];
    let model = Model::new(
        p.to_vec(),
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 2,
            },
            Transfer {
                donor: 2,
                receiver: 0,
            },
            Transfer {
                donor: 2,
                receiver: 1,
            },
        ],
    )
    .unwrap();
    let state: Vec<_> = (0..model.state_dimension())
        .map(|i| 0.3 + i as f64 * 0.2)
        .collect();
    let forcing = [input(-0.02, 0.7), input(0.003, 0.2), input(-0.007, 0.)];
    let mut rates = vec![0.; state.len()];
    model
        .rates(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[0.2, 0.4, 0.1, 0.7],
            },
            &mut rates,
        )
        .unwrap();
    // Derived by summing the equations, not by reusing implementation helpers:
    // d(sum N + sum C)/dt = sum rho_i/Lambda_i*N_i + sum external sources.
    let expected: f64 = (0..3)
        .map(|i| {
            forcing[i].reactivity / p[i].generation_time_s * state[7 * i]
                + forcing[i].external_source_per_s
        })
        .sum();
    close(rates.iter().sum(), expected, 1e-12);
}

#[test]
fn unequal_region_inventories_and_generation_times_can_have_coupled_equilibrium() {
    let p = [region(0.02), region(0.09)];
    let model = Model::new(
        p.to_vec(),
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 0,
            },
        ],
    )
    .unwrap();
    // Unequal inventories, not two separately normalized power amplitudes.
    // k01*N0 = .2*1 = .1*2 = k10*N1.
    let state: Vec<_> = [equilibrium(p[0], 1.), equilibrium(p[1], 2.)].concat();
    let mut rates = vec![0.; state.len()];
    model
        .rates(
            &state,
            Inputs {
                regions: &[input(0., 0.), input(0., 0.)],
                transfer_rates_per_s: &[0.2, 0.1],
            },
            &mut rates,
        )
        .unwrap();
    assert!(rates.iter().all(|x| x.abs() < 1e-13));
}

#[test]
fn subcritical_source_equilibrium_is_not_renormalized_to_nominal_power() {
    let p = region(0.25);
    let model = Model::new(vec![p], vec![]).unwrap();
    let rho = -0.002;
    let source = 0.4;
    // Independently from the total balance: N = -Lambda*S/rho.
    let state = equilibrium(p, -p.generation_time_s * source / rho);
    let mut rates = [0.; 7];
    model
        .rates(
            &state,
            Inputs {
                regions: &[input(rho, source)],
                transfer_rates_per_s: &[],
            },
            &mut rates,
        )
        .unwrap();
    assert!(rates.iter().all(|x| x.abs() < 1e-13));
    let mut doubled = state;
    for x in &mut doubled {
        *x *= 2.;
    }
    model
        .rates(
            &doubled,
            Inputs {
                regions: &[input(rho, source)],
                transfer_rates_per_s: &[],
            },
            &mut rates,
        )
        .unwrap();
    close(rates.iter().sum(), -source, 1e-13);
}

#[test]
fn symmetric_and_antisymmetric_delayed_eigenmodes_match_independent_inhour_relation() {
    let p = region(0.1);
    let k = 0.03;
    let growth_rate = 0.08;
    let delayed_rho: f64 = (0..6)
        .map(|g| p.delayed_fractions[g] * growth_rate / (growth_rate + p.decay_constants_per_s[g]))
        .sum();
    let model = Model::new(
        vec![p, p],
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 0,
            },
        ],
    )
    .unwrap();
    for sign in [1., -1.] {
        // The antisymmetric transfer eigenvalue is -2k; the common mode is 0.
        let rho =
            p.generation_time_s * (growth_rate + if sign < 0. { 2. * k } else { 0. }) + delayed_rho;
        let mut state = vec![0.; 14];
        for (r, n) in [1., sign].into_iter().enumerate() {
            state[7 * r] = n;
            for g in 0..6 {
                state[7 * r + g + 1] = p.delayed_fractions[g] * n
                    / (p.generation_time_s * (growth_rate + p.decay_constants_per_s[g]));
            }
        }
        let mut rates = vec![0.; 14];
        model
            .rates(
                &state,
                Inputs {
                    regions: &[input(rho, 0.), input(rho, 0.)],
                    transfer_rates_per_s: &[k, k],
                },
                &mut rates,
            )
            .unwrap();
        for (actual, value) in rates.iter().zip(&state) {
            close(*actual, growth_rate * value, 1e-12);
        }
    }
}

#[test]
fn zero_inventory_delayed_emission_and_prompt_production_have_correct_boundaries() {
    let p = region(0.1);
    let model = Model::new(vec![p], vec![]).unwrap();
    let forcing = [input(-0.01, 0.)];
    let mut rates = [0.; 7];
    model
        .rates(
            &[0.; 7],
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &mut rates,
        )
        .unwrap();
    assert_eq!(rates, [0.; 7]);
    let mut state = [0.; 7];
    state[3] = 2.;
    model
        .rates(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &mut rates,
        )
        .unwrap();
    close(rates[0], p.decay_constants_per_s[2] * 2., 1e-14);
    close(rates[3], -rates[0], 1e-14);
    close(rates.iter().sum(), 0., 1e-14);
    state = [0.; 7];
    state[0] = 1.;
    model
        .rates(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &mut rates,
        )
        .unwrap();
    for g in 0..6 {
        close(
            rates[g + 1],
            p.delayed_fractions[g] / p.generation_time_s,
            1e-14,
        );
    }
}

#[test]
fn full_tangent_matches_centered_differences_of_states_reactivity_source_and_transfer() {
    let model = Model::new(
        vec![region(0.04), region(0.06)],
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 0,
            },
        ],
    )
    .unwrap();
    let state: Vec<_> = (0..14).map(|i| 1. + i as f64 / 5.).collect();
    let direction: Vec<_> = (0..14).map(|i| (i as f64 - 8.) / 9.).collect();
    let inputs = [input(-0.003, 0.5), input(0.001, 0.4)];
    let rates = [0.03, 0.02];
    let d_inputs = [
        RegionInputDirection {
            reactivity: 0.002,
            external_source_per_s: -0.1,
        },
        RegionInputDirection {
            reactivity: -0.001,
            external_source_per_s: 0.2,
        },
    ];
    let d_rates = [-0.01, 0.04];
    let mut analytic = vec![0.; 14];
    model
        .directional_derivative(
            &state,
            Inputs {
                regions: &inputs,
                transfer_rates_per_s: &rates,
            },
            &direction,
            InputDirection {
                regions: &d_inputs,
                transfer_rates_per_s: &d_rates,
            },
            &mut analytic,
        )
        .unwrap();
    for epsilon in [1e-5, 5e-6] {
        let evaluate = |sign: f64| {
            let x: Vec<_> = state
                .iter()
                .zip(&direction)
                .map(|(x, d)| x + sign * epsilon * d)
                .collect();
            let forcing: Vec<_> = inputs
                .iter()
                .zip(&d_inputs)
                .map(|(x, d)| {
                    input(
                        x.reactivity + sign * epsilon * d.reactivity,
                        x.external_source_per_s + sign * epsilon * d.external_source_per_s,
                    )
                })
                .collect();
            let transfers: Vec<_> = rates
                .iter()
                .zip(d_rates)
                .map(|(x, d)| x + sign * epsilon * d)
                .collect();
            let mut result = vec![0.; 14];
            model
                .rates(
                    &x,
                    Inputs {
                        regions: &forcing,
                        transfer_rates_per_s: &transfers,
                    },
                    &mut result,
                )
                .unwrap();
            result
        };
        let plus = evaluate(1.);
        let minus = evaluate(-1.);
        for ((a, b), expected) in plus.iter().zip(&minus).zip(&analytic) {
            close((a - b) / (2. * epsilon), *expected, 1e-8);
        }
    }
}

#[test]
fn frozen_state_partial_and_input_only_tangent_are_separate_explicit_operations() {
    let p = region(0.1);
    let model = Model::new(vec![p], vec![]).unwrap();
    let forcing = [input(-0.005, 0.7)];
    let state = equilibrium(p, 2.);
    let mut partial = [0.; 7];
    let mut full = [0.; 7];
    model
        .state_jacobian_action(
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &state,
            &mut partial,
        )
        .unwrap();
    model
        .directional_derivative(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &state,
            InputDirection {
                regions: &[RegionInputDirection {
                    reactivity: 0.,
                    external_source_per_s: 0.,
                }],
                transfer_rates_per_s: &[],
            },
            &mut full,
        )
        .unwrap();
    assert_eq!(partial, full);
    model
        .directional_derivative(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &[0.; 7],
            InputDirection {
                regions: &[RegionInputDirection {
                    reactivity: 0.003,
                    external_source_per_s: 0.2,
                }],
                transfer_rates_per_s: &[],
            },
            &mut full,
        )
        .unwrap();
    close(full[0], state[0] * 0.003 / p.generation_time_s + 0.2, 1e-14);
    assert!(full[1..].iter().all(|v| *v == 0.));
}

#[test]
fn common_population_scaling_and_time_unit_scaling_preserve_equations() {
    let p = region(0.04);
    let model = Model::new(vec![p], vec![]).unwrap();
    let state = equilibrium(p, 1.3);
    let forcing = [input(-0.004, 0.2)];
    let mut original = [0.; 7];
    model
        .rates(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[],
            },
            &mut original,
        )
        .unwrap();
    let mut scaled = [0.; 7];
    model
        .rates(
            &state.map(|x| 9. * x),
            Inputs {
                regions: &[input(-0.004, 9. * 0.2)],
                transfer_rates_per_s: &[],
            },
            &mut scaled,
        )
        .unwrap();
    for i in 0..7 {
        close(scaled[i], 9. * original[i], 1e-13);
    }
    let clock_scale = 3.;
    let mut fast_p = p;
    fast_p.generation_time_s /= clock_scale;
    fast_p.decay_constants_per_s = p.decay_constants_per_s.map(|v| v * clock_scale);
    let faster = Model::new(vec![fast_p], vec![]).unwrap();
    faster
        .rates(
            &state,
            Inputs {
                regions: &[input(-0.004, 0.2 * clock_scale)],
                transfer_rates_per_s: &[],
            },
            &mut scaled,
        )
        .unwrap();
    for i in 0..7 {
        close(scaled[i], clock_scale * original[i], 1e-13);
    }
}

#[test]
fn finite_signed_trials_are_not_accepted_or_clipped() {
    let model = Model::new(vec![region(0.1)], vec![]).unwrap();
    let mut state = [0.; 7];
    state[0] = -0.1;
    let mut out = [0.; 7];
    model
        .rates(
            &state,
            Inputs {
                regions: &[input(-0.01, 0.)],
                transfer_rates_per_s: &[],
            },
            &mut out,
        )
        .unwrap();
    assert_eq!(state[0], -0.1);
    assert_eq!(
        model.validate_accepted_state(&state),
        Err(Error::NegativeAcceptedInventory { index: 0 })
    );
    state[0] = 0.;
    model.validate_accepted_state(&state).unwrap();
    state[3] = f64::NAN;
    assert!(
        model
            .rates(
                &state,
                Inputs {
                    regions: &[input(-0.01, 0.)],
                    transfer_rates_per_s: &[]
                },
                &mut out
            )
            .is_err()
    );
}

#[test]
fn constructor_rejects_bad_parameters_domains_and_ambiguous_topology() {
    assert!(matches!(Model::new(vec![], vec![]), Err(Error::EmptyModel)));
    for invalid in [0., -1., f64::NAN, f64::INFINITY, f64::MIN_POSITIVE / 1e20] {
        let mut p = region(0.1);
        p.generation_time_s = invalid;
        assert!(Model::new(vec![p], vec![]).is_err());
    }
    for invalid in [-0.1, f64::NAN, f64::INFINITY] {
        let mut p = region(0.1);
        p.delayed_fractions[2] = invalid;
        assert!(Model::new(vec![p], vec![]).is_err());
    }
    let mut p = region(0.1);
    p.delayed_fractions = [0.2; 6];
    assert!(Model::new(vec![p], vec![]).is_err());
    for invalid in [0., -0.1, f64::NAN, f64::INFINITY] {
        let mut p = region(0.1);
        p.decay_constants_per_s[2] = invalid;
        assert!(Model::new(vec![p], vec![]).is_err());
    }
    for domain in [
        ReactivityDomain {
            minimum: 1.,
            maximum: 0.,
        },
        ReactivityDomain {
            minimum: f64::NAN,
            maximum: 0.,
        },
        ReactivityDomain {
            minimum: -1.,
            maximum: f64::INFINITY,
        },
    ] {
        let mut p = region(0.1);
        p.reactivity_domain = domain;
        assert!(Model::new(vec![p], vec![]).is_err());
    }
    for edge in [
        Transfer {
            donor: 0,
            receiver: 0,
        },
        Transfer {
            donor: 0,
            receiver: 2,
        },
        Transfer {
            donor: 2,
            receiver: 1,
        },
    ] {
        assert!(Model::new(vec![region(0.1); 2], vec![edge]).is_err());
    }
    assert!(matches!(
        Model::new(
            vec![region(0.1); 2],
            vec![
                Transfer {
                    donor: 0,
                    receiver: 1
                };
                2
            ]
        ),
        Err(Error::DuplicateTransfer { edge: 1 })
    ));
}

#[test]
fn stage_validation_rejects_wrong_shapes_nonfinite_forcing_directions_and_overflow() {
    let model = Model::new(
        vec![region(0.1); 2],
        vec![Transfer {
            donor: 0,
            receiver: 1,
        }],
    )
    .unwrap();
    let valid = [input(0., 0.); 2];
    let mut out = [0.; 14];
    assert!(
        model
            .rates(
                &[0.; 13],
                Inputs {
                    regions: &valid,
                    transfer_rates_per_s: &[0.1]
                },
                &mut out
            )
            .is_err()
    );
    assert!(
        model
            .rates(
                &[0.; 14],
                Inputs {
                    regions: &valid[..1],
                    transfer_rates_per_s: &[0.1]
                },
                &mut out
            )
            .is_err()
    );
    assert!(
        model
            .rates(
                &[0.; 14],
                Inputs {
                    regions: &valid,
                    transfer_rates_per_s: &[]
                },
                &mut out
            )
            .is_err()
    );
    assert!(
        model
            .rates(
                &[0.; 14],
                Inputs {
                    regions: &valid,
                    transfer_rates_per_s: &[0.1]
                },
                &mut out[..13]
            )
            .is_err()
    );
    for bad in [input(f64::NAN, 0.), input(0., f64::INFINITY)] {
        assert!(
            model
                .rates(
                    &[0.; 14],
                    Inputs {
                        regions: &[bad, valid[1]],
                        transfer_rates_per_s: &[0.1]
                    },
                    &mut out
                )
                .is_err()
        );
    }
    for bad in [f64::NAN, f64::INFINITY] {
        assert!(
            model
                .rates(
                    &[0.; 14],
                    Inputs {
                        regions: &valid,
                        transfer_rates_per_s: &[bad]
                    },
                    &mut out
                )
                .is_err()
        );
    }
    assert!(
        model
            .directional_derivative(
                &[0.; 14],
                Inputs {
                    regions: &valid,
                    transfer_rates_per_s: &[0.1]
                },
                &[0.; 14],
                InputDirection {
                    regions: &[RegionInputDirection {
                        reactivity: 0.,
                        external_source_per_s: 0.
                    }; 2],
                    transfer_rates_per_s: &[f64::NAN]
                },
                &mut out
            )
            .is_err()
    );
    let mut state = [0.; 14];
    state[0] = f64::MAX;
    assert!(matches!(
        model.rates(
            &state,
            Inputs {
                regions: &[input(-0.3, 0.), valid[1]],
                transfer_rates_per_s: &[0.1]
            },
            &mut out
        ),
        Err(Error::NonfiniteResult { .. })
    ));
}

#[test]
fn finite_signed_constitutive_trials_are_not_silently_physically_admitted() {
    let model = Model::new(
        vec![region(0.1); 2],
        vec![Transfer {
            donor: 0,
            receiver: 1,
        }],
    )
    .unwrap();
    let valid = [input(0., 0.); 2];
    model
        .validate_accepted_inputs(Inputs {
            regions: &valid,
            transfer_rates_per_s: &[0.],
        })
        .unwrap();
    let mut out = [0.; 14];
    for bad in [input(-0.31, 0.), input(0.21, 0.), input(0., -0.1)] {
        let forcing = [bad, valid[1]];
        let trial = Inputs {
            regions: &forcing,
            transfer_rates_per_s: &[0.1],
        };
        model.rates(&[1.; 14], trial, &mut out).unwrap();
        assert!(model.validate_accepted_inputs(trial).is_err());
    }
    let trial = Inputs {
        regions: &valid,
        transfer_rates_per_s: &[-0.1],
    };
    model.rates(&[1.; 14], trial, &mut out).unwrap();
    assert!(model.validate_accepted_inputs(trial).is_err());
    assert!(
        model
            .validate_accepted_inputs(Inputs {
                regions: &[input(f64::NAN, 0.), valid[1]],
                transfer_rates_per_s: &[0.]
            })
            .is_err()
    );
}

#[test]
fn dimensions_are_caller_owned_not_a_hardwired_twenty_four_region_plant() {
    for count in [1, 2, 24, 25] {
        let model = Model::new(vec![region(0.1); count], vec![]).unwrap();
        assert_eq!(model.region_count(), count);
        assert_eq!(model.state_dimension(), count * 7);
        assert_eq!(model.transfer_count(), 0);
        assert_eq!(model.structural_state_jacobian_nonzeros(), count * 19);
    }
    // 168 is the kinetics-only arithmetic at the proposed 24-region topology,
    // not the number of variables or solver constraints in a complete plant.
    assert_eq!(24 * STATES_PER_REGION, 168);
}

#[test]
fn full_tangent_preserves_global_balance_even_when_transfer_rates_change() {
    let p = [region(0.04), region(0.09)];
    let model = Model::new(
        p.to_vec(),
        vec![Transfer {
            donor: 0,
            receiver: 1,
        }],
    )
    .unwrap();
    let state: Vec<_> = (0..14).map(|i| 0.2 + i as f64 / 7.).collect();
    let direction: Vec<_> = (0..14).map(|i| (i as f64 - 3.) / 11.).collect();
    let forcing = [input(-0.003, 0.2), input(0.001, 0.4)];
    let d_forcing = [
        RegionInputDirection {
            reactivity: 0.002,
            external_source_per_s: -0.1,
        },
        RegionInputDirection {
            reactivity: -0.001,
            external_source_per_s: 0.2,
        },
    ];
    let mut derivative = [0.; 14];
    model
        .directional_derivative(
            &state,
            Inputs {
                regions: &forcing,
                transfer_rates_per_s: &[0.3],
            },
            &direction,
            InputDirection {
                regions: &d_forcing,
                transfer_rates_per_s: &[-0.7],
            },
            &mut derivative,
        )
        .unwrap();
    let expected: f64 = (0..2)
        .map(|i| {
            (forcing[i].reactivity * direction[7 * i] + state[7 * i] * d_forcing[i].reactivity)
                / p[i].generation_time_s
                + d_forcing[i].external_source_per_s
        })
        .sum();
    close(derivative.iter().sum(), expected, 1e-12);
}

#[test]
fn physical_nonnegative_inventory_boundaries_have_no_outward_vector_field() {
    let model = Model::new(
        vec![region(0.02), region(0.09)],
        vec![
            Transfer {
                donor: 0,
                receiver: 1,
            },
            Transfer {
                donor: 1,
                receiver: 0,
            },
        ],
    )
    .unwrap();
    let forcing = [input(-0.03, 0.2), input(0.004, 0.)];
    let mut state = vec![0.7; 14];
    let mut rates = vec![0.; 14];
    for boundary in 0..14 {
        state[boundary] = 0.;
        model
            .rates(
                &state,
                Inputs {
                    regions: &forcing,
                    transfer_rates_per_s: &[0.3, 0.7],
                },
                &mut rates,
            )
            .unwrap();
        assert!(
            rates[boundary] >= 0.,
            "negative rate at empty inventory {boundary}"
        );
        state[boundary] = 0.7;
    }
    // This establishes a property of the continuous equations, NOT that an
    // arbitrary discretization or timestep preserves positivity.
}

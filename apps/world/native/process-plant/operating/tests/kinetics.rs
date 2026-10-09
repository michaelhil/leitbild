use leitbild_operating_plant::{heat_history, kinetics::*, poisons};

// Synthetic coefficients test equations, NOT LD-01 physical calibration.
const BETA: [f64; 6] = [0.001, 0.0008, 0.0012, 0.001, 0.0011, 0.0009];
const DECAY: [f64; 6] = [0.01, 0.03, 0.1, 0.3, 1., 3.];
const NU: f64 = 2.5;

fn region(time: f64) -> RegionParameters {
    RegionParameters {
        generation_time_s: time,
        reactivity_domain: ReactivityDomain {
            minimum: -0.3,
            maximum: 0.2,
        },
    }
}
fn material() -> MaterialParameters {
    MaterialParameters {
        delayed_yields_per_fission: BETA.map(|x| NU * x),
        decay_constants_per_s: DECAY,
    }
}
fn r(reactivity: f64, source: f64) -> RegionInput {
    RegionInput {
        reactivity,
        external_source_per_s: source,
    }
}
fn close(actual: f64, expected: f64, scale: f64) {
    assert!(
        (actual - expected).abs() <= scale * (1. + expected.abs()),
        "{actual} != {expected}"
    );
}

struct Fixture {
    model: Model,
    region_inputs: Vec<RegionInput>,
    transfers: Vec<f64>,
    production: Vec<f64>,
    emission: Vec<f64>,
    outside: Vec<f64>,
}
impl Fixture {
    fn inputs(&self) -> Inputs<'_> {
        Inputs {
            regions: &self.region_inputs,
            transfer_rates_per_s: &self.transfers,
            fissions_per_population_s: &self.production,
            emission_fractions: &self.emission,
            outside_fractions: &self.outside,
        }
    }
    fn evaluate(&self, state: &[f64]) -> (Vec<f64>, Vec<f64>, Balance) {
        let mut out = vec![0.; self.model.state_dimension()];
        let mut fissions = vec![0.; self.model.material_count()];
        let balance = self
            .model
            .rates(state, self.inputs(), &mut out, &mut fissions)
            .unwrap();
        (out, fissions, balance)
    }
}
fn identity(times: &[f64]) -> Fixture {
    Fixture {
        model: Model::new(
            times.iter().map(|&t| region(t)).collect(),
            vec![material(); times.len()],
            if times.len() == 2 {
                vec![
                    Transfer {
                        donor: 0,
                        receiver: 1,
                    },
                    Transfer {
                        donor: 1,
                        receiver: 0,
                    },
                ]
            } else {
                vec![]
            },
            (0..times.len())
                .map(|i| Support {
                    region: i,
                    material: i,
                })
                .collect(),
        )
        .unwrap(),
        region_inputs: vec![r(0., 0.); times.len()],
        transfers: if times.len() == 2 {
            vec![0., 0.]
        } else {
            vec![]
        },
        production: times.iter().map(|&t| 1. / (NU * t)).collect(),
        emission: vec![1.; times.len()],
        outside: vec![0.; times.len()],
    }
}
fn split() -> Fixture {
    Fixture {
        model: Model::new(
            vec![region(0.04), region(0.06)],
            vec![material(), material()],
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
            vec![
                Support {
                    region: 0,
                    material: 0,
                },
                Support {
                    region: 1,
                    material: 0,
                },
                Support {
                    region: 0,
                    material: 1,
                },
                Support {
                    region: 1,
                    material: 1,
                },
            ],
        )
        .unwrap(),
        region_inputs: vec![r(-0.003, 0.5), r(0.001, 0.4)],
        transfers: vec![0.03, 0.02],
        production: vec![2., 3., 5., 7.],
        emission: vec![0.2, 0.6, 0.5, 0.5],
        outside: vec![0.2, 0.],
    }
}
fn equilibrium(times: &[f64], populations: &[f64]) -> Vec<f64> {
    let mut state = populations.to_vec();
    for (&t, &n) in times.iter().zip(populations) {
        state.extend((0..6).map(|g| BETA[g] * n / (t * DECAY[g])));
    }
    state
}

#[test]
fn one_bank_identity_recovers_conventional_equilibrium_and_source_response() {
    let mut f = identity(&[0.25]);
    f.region_inputs[0] = r(-0.002, 0.4);
    // Independent total balance N=-Lambda*S/rho; no reset to nominal MW.
    let state = equilibrium(&[0.25], &[50.]);
    let (rates, events, _) = f.evaluate(&state);
    assert!(rates.iter().all(|x| x.abs() < 2e-13));
    close(events[0], 50. / (NU * 0.25), 1e-13);
    let (doubled, _, _) = f.evaluate(&state.iter().map(|x| 2. * x).collect::<Vec<_>>());
    close(doubled.iter().sum(), -0.4, 1e-13);
}

#[test]
fn global_balance_cancels_birth_decay_and_internal_transfer_with_explicit_export() {
    let f = split();
    f.model.validate_accepted_inputs(f.inputs()).unwrap();
    let state: Vec<_> = (0..14).map(|i| 0.3 + i as f64 / 5.).collect();
    let (rates, events, balance) = f.evaluate(&state);
    let expected = -0.003 / 0.04 * state[0] + 0.001 / 0.06 * state[1] + 0.9;
    close(
        rates.iter().sum::<f64>() + balance.delayed_export_per_s,
        expected,
        1e-12,
    );
    close(events[0], 2. * state[0] + 3. * state[1], 1e-13);
    close(events[1], 5. * state[0] + 7. * state[1], 1e-13);
    close(
        balance.delayed_export_per_s,
        (0..6).map(|g| 0.2 * DECAY[g] * state[2 + g]).sum(),
        1e-13,
    );
}

#[test]
fn unequal_extensive_regions_and_generation_times_have_coupled_equilibrium() {
    let mut f = identity(&[0.02, 0.09]);
    f.transfers = vec![0.2, 0.1];
    let (rates, _, _) = f.evaluate(&equilibrium(&[0.02, 0.09], &[1., 2.]));
    assert!(rates.iter().all(|x| x.abs() < 1e-13));
}

#[test]
fn independent_inhour_relation_holds_for_symmetric_and_antisymmetric_modes() {
    let mut f = identity(&[0.1, 0.1]);
    f.transfers = vec![0.03, 0.03];
    let s = 0.08;
    let delayed: f64 = (0..6).map(|g| BETA[g] * s / (s + DECAY[g])).sum();
    for sign in [1., -1.] {
        let rho = 0.1 * (s + if sign < 0. { 0.06 } else { 0. }) + delayed;
        f.region_inputs.fill(r(rho, 0.));
        let mut state = vec![1., sign];
        for n in [1., sign] {
            state.extend((0..6).map(|g| BETA[g] * n / (0.1 * (s + DECAY[g]))));
        }
        let (rates, _, _) = f.evaluate(&state);
        for (rate, value) in rates.iter().zip(state) {
            close(*rate, s * value, 1e-12);
        }
    }
}

#[test]
fn conserving_uniform_material_emission_does_not_prove_local_critical_balance() {
    let mut f = split();
    f.region_inputs.fill(r(0., 0.));
    f.transfers.fill(0.);
    f.production = vec![10., 20., 0., 0.];
    f.emission = vec![0.5, 0.5, 0.5, 0.5];
    f.outside.fill(0.);
    let mut state = vec![1., 3.];
    state.extend((0..6).map(|g| NU * BETA[g] * 70. / DECAY[g]));
    state.extend([0.; 6]);
    let (rates, _, _) = f.evaluate(&state);
    let withheld_difference = NU * BETA.iter().sum::<f64>() * (35. - 10.);
    close(rates[0], withheld_difference, 1e-13);
    close(rates[1], -withheld_difference, 1e-13);
    close(rates.iter().sum(), 0., 1e-12);
    assert!(rates[0].abs() > 0.1); // Global conservation must not hide shape drift.
}

#[test]
fn material_movement_changes_delayed_receipt_not_history_or_its_decay() {
    let mut f = split();
    f.region_inputs.fill(r(0., 0.));
    f.production.fill(0.);
    f.transfers.fill(0.);
    f.emission = vec![1., 0., 0., 1.];
    f.outside.fill(0.);
    let mut state = vec![0., 0.];
    state.extend([2.; 6]);
    state.extend([7.; 6]);
    let before_state = state.clone();
    let (before, _, _) = f.evaluate(&state);
    f.emission = vec![0., 1., 1., 0.];
    let (after, _, _) = f.evaluate(&state);
    assert_eq!(state, before_state);
    assert_eq!(&before[2..], &after[2..]);
    close(before[0], after[1], 1e-13);
    close(before[1], after[0], 1e-13);
    assert_ne!(before[0], after[0]);
}

#[test]
fn wholly_outside_material_keeps_precursors_without_artificial_core_return() {
    let model = Model::new(vec![region(0.1)], vec![material()], vec![], vec![]).unwrap();
    let inputs = Inputs {
        regions: &[r(0., 0.)],
        transfer_rates_per_s: &[],
        fissions_per_population_s: &[],
        emission_fractions: &[],
        outside_fractions: &[1.],
    };
    model.validate_accepted_inputs(inputs).unwrap();
    let mut out = [0.; 7];
    let mut events = [0.];
    let balance = model
        .rates(&[0., 1., 2., 3., 4., 5., 6.], inputs, &mut out, &mut events)
        .unwrap();
    assert_eq!(out[0], 0.);
    assert_eq!(events[0], 0.);
    close(
        out.iter().sum::<f64>() + balance.delayed_export_per_s,
        0.,
        1e-13,
    );
}

#[test]
fn no_population_means_no_fission_but_achieved_precursors_still_emit() {
    let f = identity(&[0.1]);
    assert_eq!(f.evaluate(&[0.; 7]).0, vec![0.; 7]);
    let (out, events, _) = f.evaluate(&[0., 0., 0., 2., 0., 0., 0.]);
    close(out[0], 2. * DECAY[2], 1e-13);
    assert_eq!(out[3], -out[0]);
    assert_eq!(events[0], 0.);
}

#[test]
fn full_tangent_includes_state_production_emission_export_source_and_coupling() {
    let f = split();
    let state: Vec<_> = (0..14).map(|i| 1. + i as f64 / 5.).collect();
    let direction: Vec<_> = (0..14).map(|i| (i as f64 - 8.) / 9.).collect();
    let dr = [r(0.002, -0.1), r(-0.001, 0.2)];
    let dk = [-0.01, 0.04];
    let dg = [-0.2, 0.3, 0.4, -0.5];
    let dw = [0.1, -0.05, -0.1, 0.1];
    let dx = [-0.05, 0.];
    let mut analytic = vec![0.; 14];
    let mut df = [0.; 2];
    let db = f
        .model
        .directional_derivative(
            &state,
            f.inputs(),
            &direction,
            Inputs {
                regions: &dr,
                transfer_rates_per_s: &dk,
                fissions_per_population_s: &dg,
                emission_fractions: &dw,
                outside_fractions: &dx,
            },
            &mut analytic,
            &mut df,
        )
        .unwrap();
    for eps in [1e-5, 5e-6] {
        let at = |sign: f64| {
            let shifted = |x: &[f64], d: &[f64]| {
                x.iter()
                    .zip(d)
                    .map(|(x, d)| x + sign * eps * d)
                    .collect::<Vec<_>>()
            };
            let sr: Vec<_> = f
                .region_inputs
                .iter()
                .zip(dr)
                .map(|(x, d)| {
                    r(
                        x.reactivity + sign * eps * d.reactivity,
                        x.external_source_per_s + sign * eps * d.external_source_per_s,
                    )
                })
                .collect();
            let mut out = vec![0.; 14];
            let mut events = vec![0.; 2];
            let b = f
                .model
                .rates(
                    &shifted(&state, &direction),
                    Inputs {
                        regions: &sr,
                        transfer_rates_per_s: &shifted(&f.transfers, &dk),
                        fissions_per_population_s: &shifted(&f.production, &dg),
                        emission_fractions: &shifted(&f.emission, &dw),
                        outside_fractions: &shifted(&f.outside, &dx),
                    },
                    &mut out,
                    &mut events,
                )
                .unwrap();
            (out, events, b.delayed_export_per_s)
        };
        let plus = at(1.);
        let minus = at(-1.);
        for ((a, b), expected) in plus.0.iter().zip(&minus.0).zip(&analytic) {
            close((a - b) / (2. * eps), *expected, 1e-8);
        }
        for (i, expected) in df.iter().enumerate() {
            close((plus.1[i] - minus.1[i]) / (2. * eps), *expected, 1e-8);
        }
        close(
            (plus.2 - minus.2) / (2. * eps),
            db.delayed_export_per_s,
            1e-8,
        );
        let total_direction = (0..2)
            .map(|i| {
                dr[i].reactivity / [0.04, 0.06][i] * state[i]
                    + f.region_inputs[i].reactivity / [0.04, 0.06][i] * direction[i]
                    + dr[i].external_source_per_s
            })
            .sum::<f64>();
        close(
            analytic.iter().sum::<f64>() + db.delayed_export_per_s,
            total_direction,
            1e-12,
        );
    }
}

#[test]
fn shared_fission_receipt_feeds_heat_and_poison_without_recounting_neutron_precursors() {
    let f = split();
    let (nr, events, _) = f.evaluate(&[1.; 14]);
    // Explicit synthetic chain and reservoir coefficients exercise the join.
    let heat = heat_history::Model::new(
        190.,
        vec![heat_history::Group {
            decay_per_s: 0.1,
            retained_joules_per_event: 12.,
        }],
    )
    .unwrap();
    let poison = poisons::Model::new(poisons::Parameters {
        decay_per_s: [0.01, 0.02, 0.03],
        direct_atoms_per_fission: [0.06, 0.003, 0.01, 0.],
    })
    .unwrap();
    for (a, &feed) in events.iter().enumerate() {
        let mut history_rate = [0.];
        let release = heat.rates(&[100.], feed, &mut history_rate).unwrap();
        close(
            release.prompt_w + release.delayed_w + history_rate[0],
            190. * feed,
            1e-13,
        );
        let mut pr = [0.; 4];
        poison
            .rates(
                &[0.; 4],
                poisons::Input {
                    fissions_per_s: feed,
                    capture_per_s: [0.; 4],
                },
                &mut pr,
            )
            .unwrap();
        close(pr[0], 0.06 * feed, 1e-13);
        for g in 0..6 {
            close(nr[2 + 6 * a + g] + DECAY[g], NU * BETA[g] * feed, 1e-13);
        }
    }
}

#[test]
fn signed_trials_are_evaluable_but_never_admitted_or_clipped() {
    let mut f = identity(&[0.1]);
    let state = [-0.1, 0., 0., 0., 0., 0., 0.];
    assert!(f.evaluate(&state).1[0] < 0.);
    assert!(f.model.validate_accepted_state(&state).is_err());
    f.production[0] = -1.;
    f.emission[0] = -0.2;
    f.outside[0] = 1.2;
    assert!(f.evaluate(&[1.; 7]).0.iter().all(|v| v.is_finite()));
    assert!(f.model.validate_accepted_inputs(f.inputs()).is_err());
}

#[test]
fn missing_or_duplicate_emission_and_invalid_topologies_are_rejected() {
    let mut f = split();
    for outside in [0., 0.4] {
        f.outside[0] = outside;
        assert!(matches!(
            f.model.validate_accepted_inputs(f.inputs()),
            Err(Error::EmissionNotPartitioned { material: 0, .. })
        ));
    }
    for supports in [
        vec![
            Support {
                region: 0,
                material: 0
            };
            2
        ],
        vec![Support {
            region: 1,
            material: 0,
        }],
        vec![Support {
            region: 0,
            material: 1,
        }],
    ] {
        assert!(Model::new(vec![region(0.1)], vec![material()], vec![], supports).is_err());
    }
    assert!(
        Model::new(
            vec![region(0.1)],
            vec![material()],
            vec![Transfer {
                donor: 0,
                receiver: 0
            }],
            vec![]
        )
        .is_err()
    );
}

#[test]
fn bad_parameters_nonfinite_values_lengths_and_overflow_cannot_succeed() {
    for t in [0., -1., f64::INFINITY, f64::NAN, f64::from_bits(1)] {
        assert!(Model::new(vec![region(t)], vec![material()], vec![], vec![]).is_err());
    }
    let f = identity(&[0.1]);
    let mut out = [0.; 7];
    let mut events = [0.];
    assert!(
        f.model
            .rates(&[0.; 6], f.inputs(), &mut out, &mut events)
            .is_err()
    );
    assert!(
        f.model
            .rates(&[f64::NAN; 7], f.inputs(), &mut out, &mut events)
            .is_err()
    );
    let mut overflow = identity(&[0.1]);
    overflow.production[0] = f64::MAX;
    assert!(
        overflow
            .model
            .rates(&[f64::MAX; 7], overflow.inputs(), &mut out, &mut events)
            .is_err()
    );
    let mut m = material();
    m.decay_constants_per_s[0] = 0.;
    assert!(Model::new(vec![region(0.1)], vec![m], vec![], vec![]).is_err());
    m = material();
    m.delayed_yields_per_fission[0] = -1.;
    assert!(Model::new(vec![region(0.1)], vec![m], vec![], vec![]).is_err());
}

#[test]
fn population_amplitude_and_clock_unit_changes_preserve_equations() {
    let f = identity(&[0.04]);
    let state = equilibrium(&[0.04], &[1.3]);
    let original = f.evaluate(&state);
    let scaled = f.evaluate(&state.iter().map(|x| 9. * x).collect::<Vec<_>>());
    for (a, b) in original.0.iter().zip(&scaled.0) {
        close(*b, 9. * a, 1e-13);
    }
    let mut m = material();
    m.decay_constants_per_s = DECAY.map(|v| 3. * v);
    let model = Model::new(
        vec![region(0.04 / 3.)],
        vec![m],
        vec![],
        vec![Support {
            region: 0,
            material: 0,
        }],
    )
    .unwrap();
    let mut out = [0.; 7];
    let mut events = [0.];
    let production = [3. * f.production[0]];
    model
        .rates(
            &state,
            Inputs {
                fissions_per_population_s: &production,
                ..f.inputs()
            },
            &mut out,
            &mut events,
        )
        .unwrap();
    for (actual, original) in out.iter().zip(&original.0) {
        close(*actual, 3. * original, 1e-13);
    }
    close(events[0], 3. * original.1[0], 1e-13);
}

#[test]
fn actual_fixed_input_sparse_census_has_no_duplicate_precursor_bank() {
    let f = split();
    assert_eq!(f.model.state_dimension(), 2 + 2 * 6);
    assert_eq!(
        f.model.structural_state_jacobian_nonzeros(),
        14 + 2 + 4 * 12
    );
    // Check every structural column independently, including zero directions.
    let mut nonzeros = 0;
    let mut matrix = [[0.; 14]; 14];
    f.model
        .state_jacobian_entries(f.inputs(), |row, column, value| {
            matrix[row][column] += value;
        })
        .unwrap();
    for column in 0..14 {
        let mut direction = vec![0.; 14];
        direction[column] = 1.;
        let zeros = Inputs {
            regions: &[r(0., 0.); 2],
            transfer_rates_per_s: &[0.; 2],
            fissions_per_population_s: &[0.; 4],
            emission_fractions: &[0.; 4],
            outside_fractions: &[0.; 2],
        };
        let mut out = [0.; 14];
        let mut events = [0.; 2];
        f.model
            .directional_derivative(
                &[1.; 14],
                f.inputs(),
                &direction,
                zeros,
                &mut out,
                &mut events,
            )
            .unwrap();
        nonzeros += out.iter().filter(|&&x| x != 0.).count();
        for (row, expected) in out.iter().enumerate() {
            close(matrix[row][column], *expected, 1e-13);
        }
    }
    assert_eq!(nonzeros, f.model.structural_state_jacobian_nonzeros());
}

#[test]
fn common_population_normalization_changes_no_physical_fission_feed() {
    let f = split();
    let state: Vec<_> = (0..14).map(|i| 0.2 + i as f64 / 3.).collect();
    let original = f.evaluate(&state);
    let scale = 7.;
    let mut changed = material();
    changed.delayed_yields_per_fission = changed.delayed_yields_per_fission.map(|x| scale * x);
    let model = Model::new(
        vec![region(0.04), region(0.06)],
        vec![changed; 2],
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
        vec![
            Support {
                region: 0,
                material: 0,
            },
            Support {
                region: 1,
                material: 0,
            },
            Support {
                region: 0,
                material: 1,
            },
            Support {
                region: 1,
                material: 1,
            },
        ],
    )
    .unwrap();
    let regions: Vec<_> = f
        .region_inputs
        .iter()
        .map(|v| r(v.reactivity, scale * v.external_source_per_s))
        .collect();
    let production: Vec<_> = f.production.iter().map(|v| v / scale).collect();
    let mut out = [0.; 14];
    let mut events = [0.; 2];
    let balance = model
        .rates(
            &state.iter().map(|x| scale * x).collect::<Vec<_>>(),
            Inputs {
                regions: &regions,
                fissions_per_population_s: &production,
                ..f.inputs()
            },
            &mut out,
            &mut events,
        )
        .unwrap();
    for (actual, before) in out.iter().zip(original.0) {
        close(*actual, scale * before, 1e-12);
    }
    for (actual, before) in events.iter().zip(original.1) {
        close(*actual, before, 1e-13);
    }
    close(
        balance.delayed_export_per_s,
        scale * original.2.delayed_export_per_s,
        1e-13,
    );
}

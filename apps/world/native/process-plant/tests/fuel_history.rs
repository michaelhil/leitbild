//! Mathematical component fixtures, not LD-01 preparations or time evolution.
use leitbild_plant_numerics::{
    fuel_history::Workspace as HistoryWorkspace,
    fuel_history::*,
    fuel_source::*,
    heat_history::{Feed, Group, Kernel},
};

fn model(reference: f64) -> Assembly {
    model_options(reference, false)
}
fn model_options(reference: f64, sparse_law: bool) -> Assembly {
    let fuel = FuelModel::new(
        FuelLaw {
            absorption: [0.4; 7],
            fission: if sparse_law {
                [0.1, 0., 0., 0., 0., 0., 0.]
            } else {
                [0.1; 7]
            },
            scatter: if sparse_law {
                [[0.; 7]; 7]
            } else {
                [[0.2; 7]; 7]
            },
            nu: [2.; 7],
            chi: if sparse_law {
                [1., 0., 0., 0., 0., 0., 0.]
            } else {
                [1. / 7.; 7]
            },
            speed: [3.; 7],
            beta: if sparse_law {
                [0.001, 0., 0., 0., 0., 0.]
            } else {
                [0.001; 6]
            },
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
                energy_per_event: if sparse_law && i != 0 {
                    0.
                } else if i < 23 {
                    0.1
                } else {
                    0.3
                },
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
                sf235_neutrons_per_second: if sparse_law { 0. } else { 2. },
                sf238_neutrons_per_second: if sparse_law { 0. } else { 3. }
            };
            2
        ],
        PoisonLaw {
            yield_i: if sparse_law { 0. } else { 0.06 },
            yield_xe: if sparse_law { 0. } else { 0.003 },
            yield_pm: if sparse_law { 0. } else { 0.01 },
            lambda_i: 0.02,
            lambda_xe: 0.03,
            lambda_pm: 0.01,
            xe_sigma_m2: if sparse_law { 0. } else { 0.1 },
            sm_sigma_m2: if sparse_law { 0. } else { 0.2 },
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

fn sparse_action(
    m: &Assembly,
    w: &HistoryWorkspace,
    dy: &[f64],
) -> (Vec<f64>, Vec<[f64; 7]>, [f64; 2]) {
    let p = m.sparse_patterns();
    let mut a = vec![0.; p.rates.len()];
    let mut c = vec![0.; p.collision.len()];
    let mut d = vec![[0.; 2]; p.diagnostics.len()];
    m.sparse_values(w, &mut a, &mut c, &mut d).unwrap();
    let mut rates = vec![0.; m.state_count()];
    let mut collision = vec![[0.; 7]; m.fuel().volumes().len()];
    let mut diagnostics = [0.; 2];
    for ((row, column), value) in p.rates.iter().zip(a) {
        rates[*row] += value * dy[*column];
    }
    for ((region, group, column), value) in p.collision.iter().zip(c) {
        collision[*region][*group] += value * dy[*column];
    }
    for (column, value) in p.diagnostics.iter().zip(d) {
        for i in 0..2 {
            diagnostics[i] += value[i] * dy[*column];
        }
    }
    (rates, collision, diagnostics)
}

#[test]
fn sparse_complete_state_action_matches_independent_jvp_at_zero_nonzero_and_signed_trials() {
    let m = model(1000.);
    let p = m.sparse_patterns();
    assert!(p.rates.len() > m.state_count());
    assert!(p
        .rates
        .iter()
        .all(|&(r, c)| r < m.state_count() && c < m.state_count()));
    assert!(p
        .collision
        .iter()
        .all(|&(r, g, c)| r < 2 && g < 7 && c < m.state_count()));
    let mut w = m.workspace();
    for kind in 0..4 {
        let mut y = m.initial_state();
        if kind != 0 {
            y[..m.fuel_dimension()].fill(if kind == 2 { -2. } else { 2. });
            for s in 0..2 {
                let row = m.history_row(s, 0);
                y[row..row + HISTORY].fill(if kind == 2 { -3. } else { 3. });
            }
        }
        if kind == 3 {
            for s in 0..2 {
                y[m.history_row(s, CONSUMED_235)] = 1000.;
                y[m.history_row(s, CAPTURED_238)] = 1200.;
                y[m.history_row(s, SF_238)] = 800.;
            }
            y[m.cf_row()] = 0.;
        }
        m.evaluate_into(&[420., 530., 610.], &y, &mut w).unwrap();
        for phase in [0usize, 3] {
            let dy = (0..y.len())
                .map(|i| 0.1 * (((i + phase) % 9) as f64 - 4.))
                .collect::<Vec<_>>();
            m.jvp_into(&[0.; 3], &dy, &mut w).unwrap();
            let (rates, collision, diagnostics) = sparse_action(&m, &w, &dy);
            for (&a, &b) in rates.iter().zip(w.rate_jvp().unwrap()) {
                close(a, b);
            }
            for (&a, &b) in collision
                .iter()
                .flatten()
                .zip(w.collision_jvp().unwrap().iter().flatten())
            {
                close(a, b);
            }
            close(
                diagnostics[0],
                w.rate_jvp().unwrap()[..m.fuel_dimension()].iter().sum(),
            );
            close(
                diagnostics[1],
                w.segment_jvp()
                    .unwrap()
                    .iter()
                    .map(|s| s.prompt_release + s.delayed_release)
                    .sum(),
            );
        }
        let current = m.sparse_patterns();
        assert_eq!(p.rates, current.rates);
        assert_eq!(p.collision, current.collision);
        assert_eq!(p.diagnostics, current.diagnostics);
    }
}

fn actual_event_diagnostics(m: &Assembly, y: &[f64], w: &HistoryWorkspace) -> [f64; 2] {
    // Independently assemble physical events, not sums of source Jacobian rows.
    let mut net = w.cf().unwrap().births;
    for (intersection, event) in m
        .fuel()
        .intersections()
        .iter()
        .zip(w.fuel_events().unwrap())
    {
        for g in 0..7 {
            net += (m.fuel().law().nu[g] - 1.) * event.fission[g] * y[intersection.region * 7 + g];
        }
    }
    let mut release = 0.;
    for segment in w.segments().unwrap() {
        net += m.spontaneous_neutrons_per_event() * (segment.sf235 + segment.sf238)
            - segment.fertile_capture
            - segment.xe_capture
            - segment.sm_capture;
        release += segment.prompt_release + segment.delayed_release;
    }
    [net, release]
}

#[test]
fn sparse_event_diagnostics_match_full_and_half_finite_differences() {
    let m = model(1000.);
    let mut y = m.initial_state();
    y[..m.fuel_dimension()].fill(2.);
    for s in 0..2 {
        let row = m.history_row(s, 0);
        y[row..row + HISTORY].fill(3.);
    }
    let dy = (0..y.len())
        .map(|i| 0.1 * ((i % 9) as f64 - 4.))
        .collect::<Vec<_>>();
    let mut w = m.workspace();
    m.evaluate_into(&[420., 530., 610.], &y, &mut w).unwrap();
    let (_, _, diagnostic) = sparse_action(&m, &w, &dy);
    for h in [1e-3, 5e-4] {
        let mut plus = m.workspace();
        let mut minus = m.workspace();
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
        m.evaluate_into(&[420., 530., 610.], &yp, &mut plus)
            .unwrap();
        m.evaluate_into(&[420., 530., 610.], &ym, &mut minus)
            .unwrap();
        let p = actual_event_diagnostics(&m, &yp, &plus);
        let n = actual_event_diagnostics(&m, &ym, &minus);
        for i in 0..2 {
            close(diagnostic[i], (p[i] - n[i]) / (2. * h));
        }
    }
}

#[test]
fn sparse_values_refuse_invalid_foreign_or_wrong_shape_workspaces() {
    let m = model(1000.);
    let p = m.sparse_patterns();
    let mut r = vec![0.; p.rates.len()];
    let mut c = vec![0.; p.collision.len()];
    let mut d = vec![[0.; 2]; p.diagnostics.len()];
    let mut w = m.workspace();
    assert!(m.sparse_values(&w, &mut r, &mut c, &mut d).is_err());
    m.evaluate_into(&[300.; 3], &m.initial_state(), &mut w)
        .unwrap();
    assert!(model(1000.)
        .sparse_values(&w, &mut r, &mut c, &mut d)
        .is_err());
    assert!(m.sparse_values(&w, &mut r[1..], &mut c, &mut d).is_err());
    assert!(m.sparse_values(&w, &mut r, &mut c[1..], &mut d).is_err());
    assert!(m.sparse_values(&w, &mut r, &mut c, &mut d[1..]).is_err());
    m.sparse_values(&w, &mut r, &mut c, &mut d).unwrap();
    assert!(m
        .evaluate_into(&[300.; 3], &vec![f64::NAN; m.state_count()], &mut w)
        .is_err());
    assert!(m.sparse_values(&w, &mut r, &mut c, &mut d).is_err());
}

#[test]
fn sparse_pattern_prunes_fixed_law_zeros_but_retains_state_vanishing_feedback() {
    let m = model_options(1000., true);
    let p = m.sparse_patterns();
    let n = 14;
    assert!(p.rates.iter().all(|&(r, c)| {
        if r < n && c < n {
            r == c
        } else if r < n && c < m.fuel_dimension() {
            r % 7 == 0
        } else if r < m.fuel_dimension() && c < n {
            (r - n) % 6 == 0
        } else {
            true
        }
    }));
    for s in 0..2 {
        let row = m.history_row(s, 0);
        assert!(!p
            .rates
            .iter()
            .any(|&(r, _)| r == row + XENON_PRODUCT || r == row + SAMARIUM_PRODUCT));
        assert!(p.rates.contains(&(0, row + CONSUMED_235)) || s == 1);
    }
    assert!(p.rates.len() < model(1000.).sparse_patterns().rates.len());
    let mut w = m.workspace();
    for nonzero in [false, true] {
        let mut y = m.initial_state();
        if nonzero {
            y[..m.cf_row()].fill(2.);
        }
        m.evaluate_into(&[420., 530., 610.], &y, &mut w).unwrap();
        let dy = (0..y.len())
            .map(|i| 0.1 * ((i % 9) as f64 - 4.))
            .collect::<Vec<_>>();
        m.jvp_into(&[0.; 3], &dy, &mut w).unwrap();
        let (rates, collision, diagnostic) = sparse_action(&m, &w, &dy);
        for (&a, &b) in rates.iter().zip(w.rate_jvp().unwrap()) {
            close(a, b);
        }
        for (&a, &b) in collision
            .iter()
            .flatten()
            .zip(w.collision_jvp().unwrap().iter().flatten())
        {
            close(a, b);
        }
        close(
            diagnostic[0],
            w.rate_jvp().unwrap()[..m.fuel_dimension()].iter().sum(),
        );
        close(
            diagnostic[1],
            w.segment_jvp()
                .unwrap()
                .iter()
                .map(|s| s.prompt_release + s.delayed_release)
                .sum(),
        );
        assert_eq!(p.rates, m.sparse_patterns().rates);
    }
}

#[test]
fn every_sparse_state_column_matches_the_existing_jvp() {
    for sparse_law in [false, true] {
        let m = model_options(1000., sparse_law);
        let p = m.sparse_patterns();
        let mut y = m.initial_state();
        y[..m.cf_row()].fill(2.);
        let mut w = m.workspace();
        m.evaluate_into(&[420., 530., 610.], &y, &mut w).unwrap();
        let mut values = vec![0.; p.rates.len()];
        let mut collisions = vec![0.; p.collision.len()];
        let mut diagnostics = vec![[0.; 2]; p.diagnostics.len()];
        m.sparse_values(&w, &mut values, &mut collisions, &mut diagnostics)
            .unwrap();
        for column in 0..m.state_count() {
            let mut direction = vec![0.; m.state_count()];
            direction[column] = 1.;
            m.jvp_into(&[0.; 3], &direction, &mut w).unwrap();
            let mut rates = vec![0.; m.state_count()];
            for (&(r, c), &v) in p.rates.iter().zip(&values) {
                if c == column {
                    rates[r] += v;
                }
            }
            for (&a, &b) in rates.iter().zip(w.rate_jvp().unwrap()) {
                close(a, b);
            }
            let mut collision = [[0.; 7]; 2];
            for (&(r, g, c), &v) in p.collision.iter().zip(&collisions) {
                if c == column {
                    collision[r][g] += v;
                }
            }
            for (&a, &b) in collision
                .iter()
                .flatten()
                .zip(w.collision_jvp().unwrap().iter().flatten())
            {
                close(a, b);
            }
            let mut diagnostic = [0.; 2];
            for (&c, v) in p.diagnostics.iter().zip(&diagnostics) {
                if c == column {
                    for i in 0..2 {
                        diagnostic[i] += v[i];
                    }
                }
            }
            close(
                diagnostic[0],
                w.rate_jvp().unwrap()[..m.fuel_dimension()].iter().sum(),
            );
            close(
                diagnostic[1],
                w.segment_jvp()
                    .unwrap()
                    .iter()
                    .map(|s| s.prompt_release + s.delayed_release)
                    .sum(),
            );
        }
    }
}

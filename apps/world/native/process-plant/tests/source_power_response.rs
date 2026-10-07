//! Independent static output/gradient checks using the existing mathematical
//! source apparatus, not another operating preparation or trajectory.
#[path = "source_evolution.rs"]
mod source_fixture;
use leitbild_plant_numerics::{
    fuel_history as fh, fuel_source as fs, heat_history as hh,
    source_evolution::{Evolution, Input},
};

fn split_input() -> Input {
    let mut input = source_fixture::input();
    let old = &input.history;
    let fuel = fs::FuelModel::new(
        old.fuel().law().clone(),
        old.fuel().volumes().to_vec(),
        old.segment_volumes().to_vec(),
        vec![
            fs::Cohort {
                segment: 0,
                mass: 0.6,
                mu: 0.3,
            },
            fs::Cohort {
                segment: 0,
                mass: 1.4,
                mu: 0.7,
            },
        ],
        old.fuel()
            .intersections()
            .iter()
            .map(|e| fs::Intersection {
                region: e.region,
                segment: e.segment,
                volume: e.volume,
                weights: vec![
                    fs::Weight {
                        cohort: 0,
                        mass: 0.3,
                    },
                    fs::Weight {
                        cohort: 1,
                        mass: 0.7,
                    },
                ],
            })
            .collect(),
    )
    .unwrap();
    input.history = fh::Assembly::new(
        fuel,
        old.segment_preparations().to_vec(),
        old.poison_law(),
        hh::Kernel::new(old.energy_groups().to_vec(), old.fission_energy()).unwrap(),
        old.spontaneous_neutrons_per_event(),
        old.cf_law(),
        old.cf_support().to_vec(),
    )
    .unwrap();
    input.temperatures = vec![300., 700.];
    input
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 3e-13 * a.abs().max(b.abs()).max(1.),
        "{a:e} != {b:e}"
    );
}

#[test]
fn canonical_power_and_every_gradient_match_full_source_on_zero_signed_and_depleted_states() {
    let m = Evolution::new(split_input()).unwrap();
    let response = m.fuel_history().power_response().unwrap();
    assert_eq!(response.output_count(), 2);
    for q in 0..response.output_count() {
        let columns = &response.columns()[response.offsets()[q]..response.offsets()[q + 1]];
        assert!(columns.windows(2).all(|p| p[0] < p[1]));
        // Two spatial supports share the SAME depletion and E25 columns.
        assert_eq!(
            columns
                .iter()
                .filter(|&&r| r == m.fuel_history().history_row(0, fh::CONSUMED_235))
                .count(),
            1
        );
    }
    for case in 0..4 {
        let mut y = m.initial_state();
        for i in 0..14 {
            y[i] = match case {
                0 => 0.,
                2 => {
                    if i % 2 == 0 {
                        -(i as f64 + 1.)
                    } else {
                        i as f64 + 1.
                    }
                }
                _ => i as f64 + 1.,
            };
        }
        let h = m.fuel_history().history_row(0, 0);
        y[h] = [0., 100., -10., 999.99][case];
        y[h + 1] = [0., 200., -20., 1999.][case];
        y[h + 2] = [0., 100., -30., 0.99][case];
        for j in 0..25 {
            y[h + fh::ENERGY + j] = if case == 0 {
                0.
            } else {
                0.1 * (j as f64 + 1.) * if case == 2 && j % 2 == 0 { -1. } else { 1. }
            };
        }
        let mut p = vec![0.; response.output_count()];
        let mut g = vec![0.; response.columns().len()];
        response
            .evaluate(&y[..response.state_count()], &mut p, &mut g)
            .unwrap();
        let mut w = m.workspace();
        m.evaluate_into(&y, &mut w).unwrap();
        for (&a, &b) in p.iter().zip(w.fuel_deposition().unwrap()) {
            close(a, b);
        }
        // Every emitted column is independently checked, not only a direction
        // that could cancel duplicate or incorrectly signed donor derivatives.
        for column in 0..response.state_count() {
            let mut dy = vec![0.; m.state_count()];
            dy[column] = 1.;
            m.jvp_into(&dy, &mut w).unwrap();
            for q in 0..p.len() {
                let a = (response.offsets()[q]..response.offsets()[q + 1])
                    .find(|&i| response.columns()[i] == column)
                    .map_or(0., |i| g[i]);
                close(a, w.fuel_deposition_jvp().unwrap()[q]);
            }
        }
        // Distinct radial recipients must preserve allocation, not only SUM.
        close(p[0] / 0.3, p[1] / 0.7);
        // The currently owned fission coefficient has no direct temperature
        // multiplier. Temperature changes capture/dynamics, not this same-time
        // prompt-plus-already-retained release at held N/history.
        m.evaluate_coupled_into(&y, &[450., 600.], &[], &mut w)
            .unwrap();
        for (&a, &b) in p.iter().zip(w.fuel_deposition().unwrap()) {
            close(a, b);
        }
        m.jvp_coupled_into(&vec![0.; m.state_count()], &[0.1, -0.2], &[], &mut w)
            .unwrap();
        for &v in w.fuel_deposition_jvp().unwrap() {
            close(v, 0.);
        }
    }
}

#[test]
fn canonical_power_direction_matches_full_half_differences_and_refuses_nonfinite_shapes() {
    let m = Evolution::new(split_input()).unwrap();
    let r = m.fuel_history().power_response().unwrap();
    let mut y = m.initial_state();
    y[..14].fill(2.);
    let h = m.fuel_history().history_row(0, 0);
    y[h] = 200.;
    y[h + 1] = 300.;
    y[h + 2] = 50.;
    for j in 0..25 {
        y[h + fh::ENERGY + j] = 1. + j as f64;
    }
    let mut p = vec![0.; r.output_count()];
    let mut g = vec![0.; r.columns().len()];
    r.evaluate(&y[..r.state_count()], &mut p, &mut g).unwrap();
    let d = (0..r.state_count())
        .map(|i| 0.01 * ((i % 7) as f64 - 3.))
        .collect::<Vec<_>>();
    for step in [0.01, 0.005] {
        let mut arms = Vec::new();
        for sign in [-1., 1.] {
            let a = y[..r.state_count()]
                .iter()
                .zip(&d)
                .map(|(v, d)| v + sign * step * d)
                .collect::<Vec<_>>();
            let mut value = vec![0.; p.len()];
            r.evaluate(&a, &mut value, &mut vec![0.; g.len()]).unwrap();
            arms.push(value);
        }
        for q in 0..p.len() {
            let dot = (r.offsets()[q]..r.offsets()[q + 1])
                .map(|i| g[i] * d[r.columns()[i]])
                .sum::<f64>();
            let fd = (arms[1][q] - arms[0][q]) / (2. * step);
            assert!((dot - fd).abs() < 1e-9 * dot.abs().max(1.));
        }
    }
    assert!(
        r.evaluate(&y[..r.state_count() - 1], &mut p, &mut g)
            .is_err()
    );
    assert!(
        r.evaluate(&y[..r.state_count()], &mut p[..1], &mut g)
            .is_err()
    );
    assert!(
        r.evaluate(&y[..r.state_count()], &mut p, &mut g[..1])
            .is_err()
    );
    for bad in [f64::NAN, f64::INFINITY] {
        y[0] = bad;
        assert!(r.evaluate(&y[..r.state_count()], &mut p, &mut g).is_err());
    }
}

#[test]
fn positive_law_coefficient_underflow_and_overflow_are_not_structural_zeros() {
    for magnitude in [1e-200, 1e200] {
        let input = source_fixture::input();
        let old = &input.history;
        let mut law = old.fuel().law().clone();
        law.speed.fill(magnitude);
        law.fission.fill(magnitude);
        law.absorption.fill(magnitude.max(0.4));
        let fuel = fs::FuelModel::new(
            law,
            old.fuel().volumes().to_vec(),
            old.segment_volumes().to_vec(),
            old.fuel().cohorts().to_vec(),
            old.fuel().intersections().to_vec(),
        )
        .unwrap();
        let history = fh::Assembly::new(
            fuel,
            old.segment_preparations().to_vec(),
            old.poison_law(),
            hh::Kernel::new(old.energy_groups().to_vec(), old.fission_energy()).unwrap(),
            old.spontaneous_neutrons_per_event(),
            old.cf_law(),
            old.cf_support().to_vec(),
        )
        .unwrap();
        assert!(
            history.power_response().is_err(),
            "positive magnitude={magnitude:e}"
        );
    }
}

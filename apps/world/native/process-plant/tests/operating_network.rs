use leitbild_plant_numerics::operating_network::*;
use leitbild_plant_numerics::{CellGeometry, GRAVITY};

fn fixture() -> Network {
    Network::new(Config {
        secondaries: vec![],
        secondary_heat: vec![],
        water: (0..3)
            .map(|i| Water {
                geometry: CellGeometry {
                    volume: [12., 20., 15.][i],
                    elevation: 3.,
                },
                initial_pressure: [15.2e6, 15.199e6, 15.202e6][i],
                initial_temperature: [310., 300., 305.][i],
                initial_tracer_fraction: [0.002, 0.001, 0.003][i],
            })
            .collect(),
        solids: vec![
            Solid {
                heat_capacity: 75e6,
                initial_temperature: 313.15,
            },
            Solid {
                heat_capacity: 150e6,
                initial_temperature: 295.,
            },
        ],
        hydraulic: vec![
            Hydraulic {
                from: 0,
                to: 1,
                law: LossLaw::EffectiveTotal,
                length: 4.,
                diameter: 0.1264911064,
                roughness: 0.,
                fixed_loss: 37.5,
                grid_multiplier: 0.,
                flow_area: 1.25,
            },
            Hydraulic {
                from: 1,
                to: 2,
                law: LossLaw::EffectiveTotal,
                length: 2.,
                diameter: 0.1561440117,
                roughness: 0.,
                fixed_loss: 25.,
                grid_multiplier: 0.,
                flow_area: 1.25,
            },
        ],
        heat: vec![
            Heat {
                from: 0,
                to: 3,
                law: HeatLaw::LiquidFilm { geometry: 915000. },
            },
            Heat {
                from: 1,
                to: 4,
                law: HeatLaw::Conductance(125000.),
            },
        ],
    })
    .unwrap()
}
fn at(n: &Network, y: &[f64], yp: &[f64], cj: Option<f64>) -> Workspace {
    let mut w = Workspace::new(n);
    w.evaluate(n, y, yp, cj).unwrap();
    w
}
fn entry(n: &Network, w: &Workspace, row: usize, col: usize) -> f64 {
    let a = n.column_pointers[col] as usize;
    let b = n.column_pointers[col + 1] as usize;
    n.row_indices[a..b]
        .binary_search(&(row as i64))
        .map(|i| w.jacobian_values[a + i])
        .unwrap_or(0.)
}

#[test]
fn energy_rate_partials_are_unshifted_actual_rows_and_fail_closed() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 2.;
    y[n.flow_row(1)] = -3.;
    let yp = vec![0.; n.dimension()];
    let zero = at(&n, &y, &yp, Some(0.));
    let mut huge = at(&n, &y, &yp, Some(1e12));
    let mut count = 0;
    huge.visit_energy_rate_partials(&n, |row, col, value| {
        assert_eq!(value, -entry(&n, &zero, row, col));
        if value != 0. {
            count += 1;
        }
    })
    .unwrap();
    assert!(count > 10); // Not a fabricated analytically-zero aggregate row.
    let direction = (0..n.dimension())
        .map(|i| (i as f64 + 1.) * 0.125)
        .collect::<Vec<_>>();
    assert_eq!(
        huge.energy_rate_jvp(&n, &direction).unwrap(),
        zero.energy_rate_jvp(&n, &direction).unwrap()
    );
    assert!(huge.energy_rate_jvp(&fixture(), &direction).is_err());
    let mut invalid = y.clone();
    invalid[0] = f64::NAN;
    assert!(huge.evaluate(&n, &invalid, &yp, Some(1e12)).is_err());
    assert!(huge.energy_rate_jvp(&n, &direction).is_err());
    huge.evaluate(&n, &y, &yp, None).unwrap();
    assert!(huge.visit_energy_rate_partials(&n, |_, _, _| {}).is_err());
}
#[test]
fn joined_finite_secondaries_have_reciprocal_energy_and_local_chart_matrix() {
    let mut c = fixture().config().clone();
    c.secondaries = vec![
        Secondary {
            volume: 120.,
            initial_temperature: 313.15,
            initial_pressure: 101325.,
            initial_liquid_volume: 72.,
            initial_nitrogen_mass: 0.,
            minimum_wetted_liquid_volume: 71.25
        };
        2
    ];
    c.secondary_heat = vec![
        SecondaryHeat {
            solid: 0,
            secondary: 0,
            area: 625.,
            diameter: 0.02,
        },
        SecondaryHeat {
            solid: 1,
            secondary: 1,
            area: 625.,
            diameter: 0.02,
        },
    ];
    let n = Network::new(c).unwrap();
    let mut y = n.initial_state().unwrap();
    assert_eq!(n.dimension(), 23);
    assert_eq!(
        (0..n.dimension()).filter(|&r| n.is_differential(r)).count(),
        11
    );
    y[n.energy_row(3)] += 75e6 * 2.; // deliberate finite warm metal, not forcing
    y[n.secondary_energy_row(0)] += 17.; // explicit off-manifold candidate
    let yp = vec![0.5; n.dimension()];
    let cj = 17.;
    let w = at(&n, &y, &yp, Some(cj));
    let total = (0..n.dimension())
        .filter(|&r| n.is_differential(r) && r != n.total_mass_row() && !(3..6).contains(&r))
        .map(|r| w.rates[r])
        .sum::<f64>();
    assert!(total.abs() < 1e-5);
    assert!(w.secondary_heat_flows[0] > 0. && w.secondary_heat_flows[1] < 0.);
    for k in 0..2 {
        let st = w.secondary_states[k];
        assert!((st.liquid_mass + st.vapor_mass - n.secondary_inventory(k).water).abs() < 1e-8);
    }
    for col in [
        n.energy_row(3),
        n.energy_row(4),
        n.secondary_energy_row(0),
        n.secondary_temperature_row(0),
        n.secondary_pressure_row(0),
        n.secondary_temperature_row(1),
        n.secondary_pressure_row(1),
    ] {
        let h = if col == n.secondary_temperature_row(0) || col == n.secondary_temperature_row(1) {
            0.002
        } else if col == n.secondary_pressure_row(0) || col == n.secondary_pressure_row(1) {
            2.
        } else {
            100.
        };
        for scale in [1., 0.5] {
            let h = h * scale;
            let mut a = y.clone();
            let mut b = y.clone();
            let mut ap = yp.clone();
            let mut bp = yp.clone();
            a[col] += h;
            b[col] -= h;
            ap[col] += cj * h;
            bp[col] -= cj * h;
            let wa = at(&n, &a, &ap, None);
            let wb = at(&n, &b, &bp, None);
            for row in [
                n.energy_row(3),
                n.energy_row(4),
                n.secondary_energy_row(0),
                n.secondary_temperature_row(0),
                n.secondary_pressure_row(0),
                n.secondary_energy_row(1),
                n.secondary_temperature_row(1),
                n.secondary_pressure_row(1),
            ] {
                let fd = (wa.residual[row] - wb.residual[row]) / (2. * h);
                let exact = entry(&n, &w, row, col);
                assert!(
                    (fd - exact).abs() <= 2e-3 * fd.abs().max(exact.abs()).max(1e-3),
                    "row {row} col {col}: FD {fd}, matrix {exact}"
                );
            }
        }
    }
}
#[test]
fn fresh_energy_mass_and_material_identity_is_preserved_not_initial_flow_admission() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let w = at(&n, &y, &vec![0.; y.len()], Some(47.));
    assert_eq!(n.stock_dimension(), 9);
    assert_eq!(n.dimension(), 17);
    assert_eq!(
        (0..n.dimension()).filter(|&r| n.is_differential(r)).count(),
        9
    );
    assert_eq!(n.mechanical_row(0), None);
    let total: f64 = w.chart_mass.iter().sum();
    assert_eq!(y[n.total_mass_row()], total);
    for i in 0..3 {
        assert_eq!(n.eos_pressure(i, &y), n.config().water[i].initial_pressure);
        assert_eq!(y[i], w.chart_energy[i]);
        assert_eq!(
            y[n.marker_row(i)],
            w.chart_mass[i] * n.config().water[i].initial_tracer_fraction
        );
        assert_eq!(w.residual[n.temperature_row(i)], 0.);
        assert!(w.redistribution[i][0] > 0.);
        assert!(w.chart_derivatives[i][3] > 0.);
    }
    assert_eq!(w.residual[n.pressure_row()], 0.);
    assert_eq!(w.rates[n.total_mass_row()], 0.);
    for e in 0..2 {
        assert!(!n.is_differential(n.flow_row(e)));
        assert_eq!(y[n.flow_row(e)], 0.);
    }
    assert!(w.rates[0] > 0.); // Finite warm metal, no prescribed power.
    assert_ne!(w.residual[n.flow_row(0)], 0.); // A guess is not a consistent original.
}
#[test]
fn signed_transport_and_finite_heat_conserve_energy_marker_and_aggregate_mass() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 10.;
    y[n.flow_row(1)] = -20.;
    y[n.mechanical_row(1).unwrap()] = 123.;
    let w = at(&n, &y, &vec![0.; y.len()], None);
    assert_eq!(w.mass_flows, vec![10., -20.]);
    assert_eq!(w.mass_rates, vec![-10., 30., -20.]);
    assert!(w.mass_rates.iter().sum::<f64>().abs() < 1e-12);
    assert!((0..3).map(|i| w.rates[n.marker_row(i)]).sum::<f64>().abs() < 1e-12);
    assert!((0..5).map(|i| w.rates[n.energy_row(i)]).sum::<f64>().abs() < 1e-6);
    assert_eq!(w.rates[n.total_mass_row()], 0.);
    assert!(w.heat_entropy_production > 0.);
    let l = w.liquids[0];
    let h = l.internal_energy + n.mechanical_pressure(0, &y) / l.density + GRAVITY * 3.;
    assert!((w.rates[0] + 10. * h + w.heat_flows[0]).abs() < 1e-7);
}
#[test]
fn off_manifold_energy_and_total_mass_are_not_projected_or_used_as_local_fake_mass() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 10.;
    let before = at(&n, &y, &vec![0.; y.len()], None);
    y[0] += 123.;
    y[n.total_mass_row()] += 4.;
    let after = at(&n, &y, &vec![0.; y.len()], None);
    assert_eq!(before.rates, after.rates);
    assert_eq!(before.chart_mass, after.chart_mass);
    assert_eq!(after.residual[n.temperature_row(0)], 123.);
    assert_eq!(after.residual[n.pressure_row()], 4.);
}
#[test]
fn reduced_mass_matrix_is_non_diagonal_and_matches_independent_yp_perturbations() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let mut yp = vec![0.; y.len()];
    yp[0] = 1e6;
    yp[1] = -2e6;
    yp[2] = 3e6;
    yp[n.total_mass_row()] = 0.37;
    let base = at(&n, &y, &yp, Some(0.));
    let stage = at(&n, &y, &yp, Some(73.));
    assert!(entry(&n, &stage, n.mechanical_row(1).unwrap(), 0) != 0.);
    for col in 0..y.len() {
        let step = if col < 3 { 1000. } else { 1. };
        let mut ap = yp.clone();
        let mut bp = yp.clone();
        ap[col] += step;
        bp[col] -= step;
        let plus = at(&n, &y, &ap, None);
        let minus = at(&n, &y, &bp, None);
        for row in 0..y.len() {
            let observed = (plus.residual[row] - minus.residual[row]) / (2. * step);
            let expected = (entry(&n, &stage, row, col) - entry(&n, &base, row, col)) / 73.;
            assert!(
                (observed - expected).abs() <= 1e-11 + expected.abs() * 1e-8,
                "Fyp row{row} col{col}: {observed} {expected}"
            );
        }
    }
    let sum_a: f64 = base.redistribution.iter().map(|x| x[0]).sum();
    assert!(
        (base.pressure_rate
            - (yp[n.total_mass_row()]
                - (0..3)
                    .map(|i| base.redistribution[i][1] * yp[i])
                    .sum::<f64>())
                / sum_a)
            .abs()
            < 1e-9
    );
    let predicted: f64 = (0..3)
        .map(|i| base.redistribution[i][0] * base.pressure_rate + base.redistribution[i][1] * yp[i])
        .sum();
    assert!((predicted - yp[n.total_mass_row()]).abs() < 1e-12);
}
#[test]
fn full_half_sparse_stage_matrix_matches_off_manifold_signed_trial() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[0] += 123.;
    y[n.total_mass_row()] += 0.4;
    y[n.flow_row(0)] = 10.;
    y[n.flow_row(1)] = -20.;
    y[n.mechanical_row(1).unwrap()] = 70.;
    y[n.mechanical_row(2).unwrap()] = -40.;
    let mut yp = vec![0.37; y.len()];
    yp[0] = 1e6;
    yp[1] = -2e6;
    yp[2] = 3e6;
    let cj = 73.;
    let base = at(&n, &y, &yp, Some(cj));
    for factor in [1., 0.5] {
        for col in 0..y.len() {
            let step = if col < 3 || (7..9).contains(&col) {
                100.
            } else if col < 6 {
                0.0001
            } else if col == n.total_mass_row() {
                0.1
            } else if col == n.pressure_row() {
                1.
            } else if col >= n.temperature_row(0) && col < n.flow_row(0) {
                0.0002
            } else {
                y[col].abs().max(1.) * 1e-5
            };
            let step = step * factor;
            let mut a = y.clone();
            let mut b = y.clone();
            let mut ap = yp.clone();
            let mut bp = yp.clone();
            a[col] += step;
            b[col] -= step;
            ap[col] += cj * step;
            bp[col] -= cj * step;
            let plus = at(&n, &a, &ap, None);
            let minus = at(&n, &b, &bp, None);
            for row in 0..y.len() {
                let observed = (plus.residual[row] - minus.residual[row]) * 0.5;
                let expected = entry(&n, &base, row, col) * step;
                let abs = if row >= n.mechanical_row(1).unwrap() {
                    2e-9
                } else {
                    4e-5
                };
                assert!(
                    (observed - expected).abs() <= abs + expected.abs() * 0.002,
                    "row{row} col{col} factor{factor}: {observed} vs{expected}"
                );
            }
        }
    }
}
#[test]
fn mechanical_pressure_pays_shared_enthalpy_but_never_changes_eos_density() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = -10.;
    let old = at(&n, &y, &vec![0.; y.len()], Some(0.));
    let col = n.mechanical_row(1).unwrap();
    y[col] += 1000.;
    let new = at(&n, &y, &vec![0.; y.len()], Some(0.));
    assert_eq!(old.chart_mass, new.chart_mass);
    let change = 10. * 1000. / old.liquids[1].density;
    assert!((new.rates[0] - old.rates[0] - change).abs() < 1e-8);
    assert!((new.rates[1] - old.rates[1] + change).abs() < 1e-8);
    assert_eq!(entry(&n, &new, n.flow_row(0), col), -1.);
}
#[test]
fn zero_flow_has_one_sided_donor_tangent_not_a_floor_or_fictitious_inertia() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let yp = vec![0.; y.len()];
    let base = at(&n, &y, &yp, Some(197.));
    let q = n.flow_row(0);
    let mut a = y.clone();
    a[q] = 1e-6;
    let plus = at(&n, &a, &yp, None);
    for row in [0, 1, n.marker_row(0), n.marker_row(1)] {
        let d = (plus.residual[row] - base.residual[row]) / 1e-6;
        assert!((d - entry(&n, &base, row, q)).abs() < 0.01);
    }
    assert!(entry(&n, &base, q, q) < 0.); // No cj in algebraic loss row.
    let other = at(&n, &y, &yp, Some(0.));
    assert_eq!(entry(&n, &base, q, q), entry(&n, &other, q, q));
}
#[test]
fn sg_film_uses_same_signed_q_and_local_pressure_coordinate() {
    let mut cfg = fixture().config().clone();
    cfg.heat[0].law = HeatLaw::SgSensible {
        area: 1250.,
        diameter: 0.020,
        flow_area: 1.25,
        hydraulic_edge: 0,
    };
    let n = Network::new(cfg).unwrap();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 6000.;
    let yp = vec![0.; y.len()];
    let base = at(&n, &y, &yp, Some(0.));
    assert!(base.film_nusselt[0] > 3.66);
    for factor in [1., 0.5] {
        let step = 0.1 * factor;
        let mut a = y.clone();
        let mut b = y.clone();
        a[n.flow_row(0)] += step;
        b[n.flow_row(0)] -= step;
        let plus = at(&n, &a, &yp, None);
        let minus = at(&n, &b, &yp, None);
        for row in [0, n.energy_row(3)] {
            let d = (plus.residual[row] - minus.residual[row]) / (2. * step);
            assert!((d - entry(&n, &base, row, n.flow_row(0))).abs() < 0.01 + 0.001 * d.abs());
        }
    }
}
#[test]
fn malformed_disconnected_and_nonfinite_trials_refuse_explicitly() {
    let mut cfg = fixture().config().clone();
    cfg.hydraulic.pop();
    assert!(Network::new(cfg).is_err());
    let mut cfg = fixture().config().clone();
    cfg.water[1].initial_pressure = f64::NAN;
    assert!(Network::new(cfg).is_err());
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    let yp = vec![0.; y.len()];
    let mut w = Workspace::new(&n);
    y[n.total_mass_row()] = 0.;
    assert!(w.evaluate(&n, &y, &yp, None).is_err());
    y = n.initial_state().unwrap();
    y[n.mechanical_row(1).unwrap()] = -20e6;
    assert!(w.evaluate(&n, &y, &yp, None).is_err());
    y = n.initial_state().unwrap();
    assert!(w.evaluate(&n, &y, &yp, Some(f64::NAN)).is_err());
    assert!(w.evaluate(&n, &y[..y.len() - 1], &yp, None).is_err());
    w.chart_mass.pop();
    assert!(w.evaluate(&n, &y, &yp, None).is_err());
}

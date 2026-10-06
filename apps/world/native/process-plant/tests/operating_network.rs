use leitbild_plant_numerics::operating_network::*;
use leitbild_plant_numerics::{CellGeometry, GRAVITY};

fn fixture() -> Network {
    Network::new(Config {
        water: vec![
            Water {
                geometry: CellGeometry {
                    volume: 12.,
                    elevation: 3.,
                },
                initial_pressure: 15.2e6,
                initial_temperature: 310.,
                initial_tracer_fraction: 0.002,
            },
            Water {
                geometry: CellGeometry {
                    volume: 20.,
                    elevation: 3.,
                },
                initial_pressure: 15.199e6,
                initial_temperature: 300.,
                initial_tracer_fraction: 0.001,
            },
            Water {
                geometry: CellGeometry {
                    volume: 15.,
                    elevation: 3.,
                },
                initial_pressure: 15.202e6,
                initial_temperature: 305.,
                initial_tracer_fraction: 0.003,
            },
        ],
        solids: vec![
            Solid {
                heat_capacity: 75.0e6,
                initial_temperature: 313.15,
            },
            Solid {
                heat_capacity: 150.0e6,
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
fn at(network: &Network, y: &[f64], yp: &[f64], cj: Option<f64>) -> Workspace {
    let mut w = Workspace::new(network);
    w.evaluate(network, y, yp, cj).unwrap();
    w
}
fn matrix(network: &Network, w: &Workspace, row: usize, col: usize) -> f64 {
    let a = network.column_pointers[col] as usize;
    let b = network.column_pointers[col + 1] as usize;
    network.row_indices[a..b]
        .binary_search(&(row as i64))
        .map(|i| w.jacobian_values[a + i])
        .unwrap_or(0.)
}

#[test]
fn signed_transfers_and_finite_heat_recipients_conserve_three_stocks() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let w = at(&n, &y, &vec![0.; y.len()], Some(73.));
    assert!(w.mass_flows[0] > 0. && w.mass_flows[1] < 0.);
    assert!(w.heat_flows[0] < 0. && w.heat_flows[1] > 0.);
    for offset in [0, 2] {
        let sum = (0..3).map(|i| w.rates[5 * i + offset]).sum::<f64>();
        assert!(sum.abs() < 1e-12);
    }
    let sum = (0..5).map(|i| w.rates[n.energy_row(i)]).sum::<f64>();
    assert!(sum.abs() < 1e-6);
    assert!(w.rates[n.energy_row(3)] < 0. && w.rates[n.energy_row(4)] > 0.);
    assert!(w.heat_entropy_production > 0.);
    for i in 0..3 {
        assert_eq!(w.residual[5 * i + 3], 0.);
        assert_eq!(w.residual[5 * i + 4], 0.);
    }
    assert_eq!(w.property_requests, 15);
    assert_eq!(at(&n, &y, &vec![0.; y.len()], None).property_requests, 3);
    assert_eq!(n.stock_dimension(), 17);
    assert_eq!(n.dimension(), 19);
    for edge in 0..n.config().hydraulic.len() {
        assert_eq!(w.mass_flows[edge], y[n.flow_row(edge)]);
        assert_eq!(w.rates[n.flow_row(edge)], 0.);
        assert!(w.residual[n.flow_row(edge)].abs() < 1e-9);
    }
}

#[test]
fn sparse_local_ida_matrix_matches_off_manifold_signed_network() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[0] *= 1.001;
    y[1] += 123.;
    y[7] *= 0.99;
    let cj = 73.;
    let yp = vec![0.37; y.len()];
    let base = at(&n, &y, &yp, Some(cj));
    for factor in [1., 0.5] {
        for col in 0..y.len() {
            let step = if col >= n.stock_dimension() {
                y[col].abs().max(1.) * 1e-5
            } else if col >= 15 {
                100.
            } else {
                match col % 5 {
                    0 => y[col] * 1e-6,
                    1 => 100.,
                    2 => 0.0001,
                    3 => 1.,
                    4 => 0.0002,
                    _ => unreachable!(),
                }
            } * factor;
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
                let expected = matrix(&n, &base, row, col) * step;
                assert!(
                    (observed - expected).abs() <= 4e-5 + expected.abs() * 0.002,
                    "row {row} column {col}: {observed} vs {expected}"
                );
            }
        }
    }
}

#[test]
fn zero_flow_has_physical_viscous_limit_and_reversal_changes_real_donor() {
    let mut cfg = fixture().config().clone();
    cfg.hydraulic.truncate(1);
    cfg.heat.clear();
    for w in &mut cfg.water {
        w.initial_pressure = 15.2e6;
        w.initial_temperature = 300.;
    }
    let n = Network::new(cfg).unwrap();
    let y = n.initial_state().unwrap();
    let base = at(&n, &y, &vec![0.; y.len()], Some(0.));
    let flow_row = n.flow_row(0);
    assert_eq!(base.mass_flows[0], 0.);
    assert_eq!(matrix(&n, &base, 0, 3), 0.);
    assert_eq!(matrix(&n, &base, 0, flow_row), 1.);
    assert_eq!(matrix(&n, &base, 5, flow_row), -1.);
    let l = base.liquids[0];
    let viscous = n.config().hydraulic[0].pressure_loss(0., l.density, l.viscosity)[1];
    assert_eq!(matrix(&n, &base, flow_row, flow_row), -viscous);
    assert_eq!(matrix(&n, &base, flow_row, 3), 1.);
    assert_eq!(matrix(&n, &base, flow_row, 8), -1.);
    let mut plus = y.clone();
    plus[flow_row] = 1e-6;
    let a = at(&n, &plus, &vec![0.; y.len()], None);
    let mut minus = y.clone();
    minus[flow_row] = -1e-6;
    let b = at(&n, &minus, &vec![0.; y.len()], None);
    assert!(a.mass_flows[0] > 0. && b.mass_flows[0] < 0.);
    assert!((a.rates[2] / a.rates[0] - y[2] / y[0]).abs() < 1e-15);
    assert!((b.rates[2] / b.rates[0] - y[7] / y[5]).abs() < 1e-15);
    assert!(a.residual[flow_row] < 0. && b.residual[flow_row] > 0.);
    // The chosen q=0 tangent is from-side directional, not smoothed donor data.
    assert!((a.residual[2] / plus[flow_row] - matrix(&n, &base, 2, flow_row)).abs() < 1e-15);
    let altered_yp = vec![12345.; y.len()];
    assert_eq!(at(&n, &y, &altered_yp, Some(917.)).residual[flow_row], 0.);
    assert_eq!(
        matrix(&n, &at(&n, &y, &altered_yp, Some(917.)), flow_row, flow_row),
        -viscous
    );
}

#[test]
fn common_elevation_shift_changes_energy_receipts_by_same_mass_receipt() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let a = at(&n, &y, &vec![0.; y.len()], None);
    let mut cfg = n.config().clone();
    for w in &mut cfg.water {
        w.geometry.elevation += 100.;
    }
    let raised = Network::new(cfg).unwrap();
    let z = raised.initial_state().unwrap();
    let b = at(&raised, &z, &vec![0.; z.len()], None);
    for i in 0..3 {
        assert_eq!(a.mass_flows, b.mass_flows);
        assert!((z[5 * i + 1] - y[5 * i + 1] - GRAVITY * 100. * y[5 * i]).abs() < 2e-5);
        assert!(
            (b.rates[5 * i + 1] - a.rates[5 * i + 1] - GRAVITY * 100. * a.rates[5 * i]).abs()
                < 1e-6
        );
    }
}

#[test]
fn closed_stock_keeps_eos_pressure_response_and_actual_heat_receipt() {
    let mut cfg = fixture().config().clone();
    cfg.hydraulic.clear();
    cfg.heat.truncate(1);
    let n = Network::new(cfg).unwrap();
    let y = n.initial_state().unwrap();
    let w = at(&n, &y, &vec![0.; y.len()], Some(0.));
    assert_eq!(w.rates[0], 0.);
    assert!(w.rates[1] > 0.);
    let mp = -matrix(&n, &w, 3, 3);
    let mt = -matrix(&n, &w, 3, 4);
    let ep = -matrix(&n, &w, 4, 3);
    let et = -matrix(&n, &w, 4, 4);
    let det = mp * et - mt * ep;
    assert!(det > 0.);
    let pdot = -mt * w.rates[1] / det;
    let tdot = mp * w.rates[1] / det;
    assert!(pdot > 0. && tdot > 0.);
    assert_eq!(w.rates[1], -w.rates[n.energy_row(3)]);
}

#[test]
fn invalid_topology_trial_domain_and_nonfinite_values_refuse_explicitly() {
    let mut cfg = fixture().config().clone();
    cfg.hydraulic[0].length = 0.;
    assert!(Network::new(cfg).is_err());
    let mut cfg = fixture().config().clone();
    cfg.heat[0].to = 1;
    assert!(Network::new(cfg).is_err());
    let n = fixture();
    let y = n.initial_state().unwrap();
    for (col, value) in [(0, 0.), (2, -1.), (3, f64::NAN), (4, 0.), (15, -1e12)] {
        let mut x = y.clone();
        x[col] = value;
        assert!(
            Workspace::new(&n)
                .evaluate(&n, &x, &vec![0.; x.len()], None)
                .is_err()
        );
    }
    let mut x = y.clone();
    x[4] = 200.;
    assert!(
        Workspace::new(&n)
            .evaluate(&n, &x, &vec![0.; x.len()], None)
            .is_err()
    );
}

#[test]
fn sg_sensible_uses_natural_transfer_at_zero_and_actual_turbulent_flow_feedback() {
    let mut cfg = fixture().config().clone();
    cfg.heat = vec![Heat {
        from: 0,
        to: 3,
        law: HeatLaw::SgSensible {
            area: 1250.,
            diameter: 0.020,
            flow_area: 1.25,
            hydraulic_edge: 0,
        },
    }];
    let n = Network::new(cfg).unwrap();
    let y = n.initial_state().unwrap();
    let w = at(&n, &y, &vec![0.; y.len()], Some(19.));
    assert!(w.film_nusselt[0] > 3.66);
    assert!(w.heat_flows[0] < 0.);
    assert_eq!(w.property_requests, 42); // 15 network + 3 film + 8*3 local film probes.
    for col in [3, 4, 8, 9, 15, n.flow_row(0)] {
        let step = if col == n.flow_row(0) {
            y[col].abs() * 1e-5
        } else if col == 15 {
            1000.
        } else if col % 5 == 3 {
            0.25
        } else {
            0.0002
        };
        let mut a = y.clone();
        let mut b = y.clone();
        a[col] += step;
        b[col] -= step;
        let ap = at(&n, &a, &vec![0.; y.len()], None);
        let bp = at(&n, &b, &vec![0.; y.len()], None);
        for row in [1, 6, 15] {
            let seen = (ap.residual[row] - bp.residual[row]) * 0.5;
            let expected =
                matrix(&n, &w, row, col) * step - if row == col { 19. * step } else { 0. };
            assert!(
                (seen - expected).abs() < 1e-4 + expected.abs() * 0.003,
                "film row{row} col{col}: {seen} {expected}"
            );
        }
    }
    let mut rest = y.clone();
    rest[n.flow_row(0)] = 0.;
    let r = at(&n, &rest, &vec![0.; y.len()], None);
    assert_eq!(r.mass_flows[0], 0.);
    assert!(r.film_nusselt[0] > 3.66 && r.heat_flows[0] < 0.);
    // A non-constraint-manifold Newton trial still has one consumed q: the
    // same flow drives transport and the turbulent film, without a new inverse.
    let mut fast = y.clone();
    fast[n.flow_row(0)] = 6000.;
    let f = at(&n, &fast, &vec![0.; y.len()], Some(0.));
    assert_eq!(f.mass_flows[0], 6000.);
    assert!(f.film_nusselt[0] > r.film_nusselt[0]);
    assert!(matrix(&n, &f, 15, n.flow_row(0)).abs() > 0.);
    for factor in [1., 0.5] {
        let step = 0.06 * factor;
        let mut plus = fast.clone();
        let mut minus = fast.clone();
        plus[n.flow_row(0)] += step;
        minus[n.flow_row(0)] -= step;
        let a = at(&n, &plus, &vec![0.; y.len()], None);
        let b = at(&n, &minus, &vec![0.; y.len()], None);
        for row in [1, 15, n.flow_row(0)] {
            let seen = (a.residual[row] - b.residual[row]) / (2. * step);
            let expected = matrix(&n, &f, row, n.flow_row(0));
            assert!((seen - expected).abs() < 1e-4 + expected.abs() * 1e-4);
        }
    }
}

#[test]
fn trial_flow_is_independent_coordinate_until_pressure_loss_constraint_is_solved() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let a = at(&n, &y, &vec![0.; y.len()], Some(31.));
    let mut changed = y.clone();
    changed[3] += 100.;
    let b = at(&n, &changed, &vec![0.; y.len()], Some(31.));
    assert_eq!(a.mass_flows, b.mass_flows);
    assert_eq!(a.rates[0], b.rates[0]);
    assert_eq!(a.rates[2], b.rates[2]);
    assert!(b.residual[n.flow_row(0)].abs() > 99.);
    assert_eq!(matrix(&n, &b, n.flow_row(0), n.flow_row(1)), 0.);
    let mut nonfinite = y.clone();
    nonfinite[n.flow_row(0)] = f64::INFINITY;
    assert!(
        Workspace::new(&n)
            .evaluate(&n, &nonfinite, &vec![0.; y.len()], None)
            .is_err()
    );
}

#[test]
fn each_selected_forward_loss_has_local_algebraic_rank_and_endpoint_tangents() {
    for law in [
        LossLaw::EffectiveTotal,
        LossLaw::ChurchillPipe,
        LossLaw::ChurchillAnnulus,
        LossLaw::CoreBundle,
        LossLaw::GuideAnnulus {
            laminar_darcy: 95.98,
        },
        LossLaw::SmoothColebrook,
    ] {
        let mut cfg = fixture().config().clone();
        cfg.hydraulic.truncate(1);
        cfg.hydraulic[0].law = law;
        cfg.hydraulic[0].diameter = 0.05;
        cfg.hydraulic[0].roughness = 2e-6;
        cfg.hydraulic[0].fixed_loss = 1.;
        cfg.hydraulic[0].grid_multiplier = 0.49;
        cfg.water[1].geometry.elevation = 5.;
        cfg.heat.clear();
        let n = Network::new(cfg).unwrap();
        let mut y = n.initial_state().unwrap();
        let flow = n.flow_row(0);
        for q in [-100., 0., 100.] {
            y[flow] = q;
            let base = at(&n, &y, &vec![0.; y.len()], Some(197.));
            let a = base.liquids[0];
            let b = base.liquids[1];
            let rho = (a.density + b.density) * 0.5;
            let mu = (a.viscosity + b.viscosity) * 0.5;
            let loss = n.config().hydraulic[0].pressure_loss(q, rho, mu);
            assert_eq!(
                base.residual[flow],
                y[3] - y[8] - rho * GRAVITY * 2. - loss[0]
            );
            assert_eq!(matrix(&n, &base, flow, flow), -loss[1]);
            assert!(loss[1] > 0.);
            for factor in [1., 0.5] {
                for col in [3, 4, 8, 9, flow] {
                    let step = if col == flow {
                        q.abs().max(1.) * 1e-6
                    } else if col % 5 == 3 {
                        10.
                    } else {
                        1e-3
                    } * factor;
                    let mut plus = y.clone();
                    let mut minus = y.clone();
                    plus[col] += step;
                    minus[col] -= step;
                    let p = at(&n, &plus, &vec![0.; y.len()], None);
                    let m = at(&n, &minus, &vec![0.; y.len()], None);
                    let seen = (p.residual[flow] - m.residual[flow]) * 0.5;
                    let expected = matrix(&n, &base, flow, col) * step;
                    assert!(
                        (seen - expected).abs() <= 5e-5 + expected.abs() * 0.001,
                        "{law:?} q={q} G column={col}: seen={seen}, expected={expected}"
                    );
                }
            }
        }
    }
}

#[test]
fn workspace_cannot_be_reused_with_incompatible_same_size_topology() {
    let n = fixture();
    let mut w = Workspace::new(&n);
    let mut cfg = n.config().clone();
    cfg.heat.push(cfg.heat[0]);
    let changed = Network::new(cfg).unwrap();
    let y = changed.initial_state().unwrap();
    assert!(
        w.evaluate(&changed, &y, &vec![0.; y.len()], Some(1.))
            .is_err()
    );
}

//! Small fixed-state integration counterexamples. This apparatus exercises the
//! actual native contact/receiver code, not a PRHR duty or plant qualification.
use leitbild_plant_numerics::{
    finite_wst, operating_network as n, prhr, prhr_actuator, CellGeometry,
};
fn fixture() -> n::Network {
    n::Network::new(n::Config {
        water: (0..2)
            .map(|i| n::Water {
                geometry: CellGeometry {
                    volume: 1.,
                    elevation: 2.5,
                },
                initial_pressure: 300000.,
                initial_temperature: 300. + i as f64,
                initial_tracer_fraction: 0.001 * (i + 1) as f64,
            })
            .collect(),
        solids: vec![
            n::Solid {
                heat_capacity: 10000.,
                initial_temperature: 302.
            };
            2
        ],
        hydraulic: vec![n::Hydraulic {
            from: 0,
            to: 1,
            from_elevation: 2.5,
            to_elevation: 2.5,
            segments: vec![n::HydraulicSegment {
                law: n::LossLaw::ChurchillPipe,
                length: 1.,
                flow_area: 0.01,
                diameter: 0.1,
                roughness: 15e-6,
                fixed_loss: 2.,
                grid_multiplier: 0.,
            }],
        }],
        heat: vec![n::Heat {
            from: 2,
            to: 3,
            law: n::HeatLaw::Conductance(50.),
        }],
        secondaries: vec![],
        secondary_heat: vec![],
        seat: Some(n::Seat {
            edge: 0,
            area: 0.01,
            full_open_loss: 8.,
        }),
        prhr: Some(prhr::Config {
            wst: finite_wst::Config {
                area_m2: 200.,
                floor_m: 8.,
                hardware_volume_m3: 29.65493,
                hardware_first_moment_m4: 29.65493 * 12.,
                minimum_fully_wet_height_m: 13.28,
                maximum_height_m: 20.,
                surface_mass_transfer_m_s: 0.001,
                initial_water_volume_m3: 1200.,
                initial_temperature_k: 298.15,
            },
            gas: finite_wst::GasBoundary {
                pressure_pa: 101325.,
                temperature_k: 300.,
                vapor_density_kg_m3: 0.01,
            },
            actuator: prhr_actuator::Config {
                stroke_s: 5.,
                spring_energy_j: 2500.,
                closing_power_w: 1000.,
                hold_power_w: 20.,
                room_capacity_j_k: 200e6,
                room_wall_w_k: 20000.,
                room_reference_temperature_k: 298.15,
                initial_opening: 0.,
                initial_room_temperature_k: 299.,
            },
            liquid_contacts: vec![
                prhr::LiquidContact {
                    water: 0,
                    solid: 0,
                    area: 0.1,
                    diameter: 0.1,
                    flow_area: 0.01,
                    flow_edge: 0,
                    half_resistance: 0.01,
                    weight: prhr::ContactWeight::DiscSameSide,
                },
                prhr::LiquidContact {
                    water: 1,
                    solid: 0,
                    area: 0.1,
                    diameter: 0.1,
                    flow_area: 0.01,
                    flow_edge: 0,
                    half_resistance: 0.01,
                    weight: prhr::ContactWeight::DiscOtherSide,
                },
            ],
            pool_contacts: vec![prhr::PoolContact {
                solid: 1,
                area: 1.,
                diameter: 0.1,
                elevation: 12.,
                half_resistance: 0.001,
                bank_factor: 0.5,
            }],
            gas_contacts: vec![prhr::GasContact {
                solid: 0,
                conductance: 0.2,
            }],
            mixing: vec![prhr::Mixing {
                from: 0,
                to: 1,
                area: 0.01,
                separation: 0.5,
                diameter: 0.1,
                slope: 0.5,
                penetration_average: 0.5,
                sg_flow_edge: 0,
                sg_water: 0,
                sg_flow_area: 0.01,
                coefficient: 0.01,
                prandtl: 0.85,
                schmidt: 1.,
            }],
            axial: vec![],
        }),
    })
    .unwrap()
}
fn input(a: f64) -> prhr::Input {
    prhr::Input {
        opening: a,
        opening_rate: 0.2,
        electrical_receipt_w: 0.,
        room_heat_w: 500.,
        ambient_temperature_k: 298.15,
    }
}
fn entry(n: &n::Network, w: &n::Workspace, row: usize, col: usize) -> f64 {
    let a = n.column_pointers[col] as usize;
    let b = n.column_pointers[col + 1] as usize;
    n.row_indices[a..b]
        .binary_search(&(row as i64))
        .map(|i| w.jacobian_values[a + i])
        .unwrap_or(0.)
}
#[test]
fn restriction_admission_uses_current_inverse_flow_equation_at_every_opening() {
    use leitbild_plant_numerics::operating_admission as admission;
    let mut config = fixture().config().clone();
    // Equal actual contact temperatures make the film charts exact without
    // an initialization solve; another finite solid supplies weighting span.
    for water in &mut config.water {
        water.initial_temperature = 300.;
    }
    for solid in &mut config.solids {
        solid.initial_temperature = 300.;
    }
    config.prhr.as_mut().unwrap().wst.initial_temperature_k = 300.;
    config.solids.push(n::Solid {
        heat_capacity: 10000.,
        initial_temperature: 310.,
    });
    config.heat.push(n::Heat {
        from: 2,
        to: 4,
        law: n::HeatLaw::Conductance(1.),
    });
    let n = n::Network::new(config).unwrap();
    let row = n.flow_row(0);
    let seat = n.config().seat.unwrap();
    let mut y = n.initial_state().unwrap();
    let yp = vec![0.; n.dimension()];
    let mut w = n::Workspace::new(&n);
    w.evaluate_with_inputs(&n, &y, &yp, None, &[], Some(input(0.)))
        .unwrap();
    let allocation = admission::weights(&n, &w, &y, 300., 1.).unwrap().flow;
    // The actual refused ACT state carried this arithmetic-scale residual,
    // not a physical leakage law. Keep the numerical state unprojected.
    y[row] = -3.240871356803887e-27;
    w.evaluate_with_inputs(&n, &y, &yp, None, &[], Some(input(0.)))
        .unwrap();
    assert_eq!(w.residual[row], y[row]);
    assert!(admission::seat_flow_ratio(&n, &w, &y, allocation[0]).unwrap() < 1e-18);
    let before = y.clone();
    admission::screen(&n, &w, &y, admission::totals(&n, &y), &allocation).unwrap();
    assert_eq!(before, y);
    // The same inverse-coordinate criterion applies to opening, reclosing,
    // reversed drive, and arbitrarily small positive achieved travel.
    for opening in [0., 1e-10, 0.5, 1., 0.5, 0.] {
        for drive_sign in [-1., 1.] {
            y[n.mechanical_row(1).unwrap()] = 3. * drive_sign;
            y[row] = 0.;
            w.evaluate_with_inputs(&n, &y, &yp, None, &[], Some(input(opening)))
                .unwrap();
            let e = &n.config().hydraulic[0];
            let rho = (w.liquids[0].density + w.liquids[1].density) * 0.5;
            let mu = (w.liquids[0].viscosity + w.liquids[1].viscosity) * 0.5;
            let drive = n.hydraulic_drive(0, &y, &w.liquids).unwrap().0;
            let actual = seat.flow(e, drive, opening, rho, mu).unwrap()[0];
            for refinement in [1., 10.] {
                let flow = vec![allocation[0] / refinement];
                for (fraction, passes) in [(0.5, true), (2., false), (-2., false)] {
                    y[row] = actual + fraction * flow[0];
                    w.evaluate_with_inputs(&n, &y, &yp, None, &[], Some(input(opening)))
                        .unwrap();
                    let ratio = admission::seat_flow_ratio(&n, &w, &y, flow[0]).unwrap();
                    assert_eq!(ratio <= 1., passes);
                    assert_eq!(
                        admission::screen(&n, &w, &y, admission::totals(&n, &y), &flow).is_ok(),
                        passes
                    );
                }
            }
        }
    }
    assert!(admission::seat_flow_ratio(&n, &w, &y, 0.).is_err());
    let mut stale = y.clone();
    stale[row] += allocation[0];
    assert!(admission::seat_flow_ratio(&n, &w, &stale, allocation[0]).is_err());
}
#[test]
fn continuous_position_event_changes_only_owned_identity_rates_and_preserves_residual() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let yp = (0..n.dimension())
        .map(|r| (r as f64 - 7.) * 0.125)
        .collect::<Vec<_>>();
    let before = input(1.);
    let after = prhr::Input {
        opening_rate: 0.,
        room_heat_w: 0.,
        ..before
    };
    let changes = n.prhr().unwrap().rate_event_changes(before, after).unwrap();
    let mut w = n::Workspace::new(&n);
    w.evaluate_with_inputs(&n, &y, &yp, Some(0.), &[], Some(before))
        .unwrap();
    let left = w.residual.clone();
    w.evaluate_with_inputs(&n, &y, &yp, Some(0.), &[], Some(after))
        .unwrap();
    for r in 0..n.dimension() {
        let delta = changes
            .iter()
            .find(|&&(row, _)| row == r)
            .map_or(0., |&(_, d)| d);
        assert_eq!(w.residual[r] - left[r], -delta);
    }
    let mut right_yp = yp.clone();
    for &(r, d) in &changes {
        if d != 0. {
            right_yp[r] += d;
        }
    }
    w.evaluate_with_inputs(&n, &y, &right_yp, Some(0.), &[], Some(after))
        .unwrap();
    assert_eq!(w.residual, left);
    for r in 0..n.dimension() {
        if !changes.iter().any(|&(row, d)| row == r && d != 0.) {
            assert_eq!(right_yp[r].to_bits(), yp[r].to_bits());
        }
    }
    let p = n.prhr().unwrap();
    assert!(p
        .rate_event_changes(
            before,
            prhr::Input {
                opening: 0.5,
                ..after
            }
        )
        .is_err());
    assert!(p
        .rate_event_changes(
            before,
            prhr::Input {
                ambient_temperature_k: 299.,
                ..after
            }
        )
        .is_err());
}
#[test]
fn finite_supply_loss_restore_and_closing_changes_preserve_actual_network_residual_support() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let yp = vec![0.; n.dimension()];
    // Actual selected duty/loss changes: empty battery release, converter
    // restoration behind a latched-open output, and powered closing endstop.
    let cases = [
        (
            0.,
            0.,
            0.2,
            125.26315789473688,
            0.,
            125.26315789473688,
            500.,
        ),
        (1., 0., 0., 0., 1369.5652173913043, 0., 1369.5652173913043),
        (
            0.,
            -0.2,
            0.,
            2239.5652173913045,
            1289.5652173913045,
            1739.5652173913045,
            1289.5652173913045,
        ),
    ];
    for (a, dl, dr, el, er, ql, qr) in cases {
        let left = prhr::Input {
            opening: a,
            opening_rate: dl,
            electrical_receipt_w: el,
            room_heat_w: ql,
            ambient_temperature_k: 298.15,
        };
        let right = prhr::Input {
            opening: a,
            opening_rate: dr,
            electrical_receipt_w: er,
            room_heat_w: qr,
            ambient_temperature_k: 298.15,
        };
        let changes = n.prhr().unwrap().rate_event_changes(left, right).unwrap();
        let mut w = n::Workspace::new(&n);
        w.evaluate_with_inputs(&n, &y, &yp, None, &[], Some(left))
            .unwrap();
        let original = w.residual.clone();
        let mut rates = yp.clone();
        for (r, d) in changes {
            rates[r] += d;
        }
        w.evaluate_with_inputs(&n, &y, &rates, None, &[], Some(right))
            .unwrap();
        for (r, (&old, &new)) in original.iter().zip(&w.residual).enumerate() {
            assert!(
                (old - new).abs()
                    <= 16. * f64::EPSILON * (old.abs() + new.abs() + el + er + ql + qr).max(1.),
                "row{r}"
            );
        }
    }
}
#[test]
fn viscous_scalar_onset_has_finite_generalized_tangent_with_resolved_contrast() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.temperature_row(1)] = y[n.temperature_row(0)];
    let yp = vec![0.; n.dimension()];
    let mut w = n::Workspace::new(&n);
    // Equal temperatures do not erase the actual authored marker contrast.
    // Finite viscous drag bounds the neutral active-set tangent even with a
    // resolved concentration difference; no authored uniformity is assumed.
    w.evaluate_with_inputs(&n, &y, &yp, None, &[], Some(input(0.3)))
        .unwrap();
    let flux = w.residual[n.marker_row(0)];
    w.evaluate_with_inputs(&n, &y, &yp, Some(3.), &[], Some(input(0.3)))
        .unwrap();
    assert_eq!(w.residual[n.marker_row(0)], flux);
    assert!(w.jacobian_values.iter().all(|x| x.is_finite()));
    // These equal-volume, equal-p/T cells now have the same actual quotient;
    // the full scalar flux has a well-defined zero buoyant product tangent.
    y[n.marker_row(1)] = y[n.marker_row(0)];
    w.evaluate_with_inputs(&n, &y, &yp, Some(3.), &[], Some(input(0.3)))
        .unwrap();
    assert!(w.jacobian_values.iter().all(|x| x.is_finite()));
}
#[test]
fn finite_heat_mass_work_and_spring_receipts_close_without_installed_bath() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let mut yp = vec![0.; n.dimension()];
    let l = n.prhr_layout().unwrap();
    yp[l.wst_start + 3] = 0.002;
    let mut w = n::Workspace::new(&n);
    w.evaluate_with_inputs(&n, &y, &yp, Some(2.), &[], Some(input(0.3)))
        .unwrap();
    let balance = n
        .installed_energy_rows()
        .map(|r| w.rates[r])
        .chain(
            n.prhr()
                .unwrap()
                .receipt_rows()
                .map(|(r, s)| s * w.rates[r]),
        )
        .sum::<f64>();
    assert!(balance.abs() < 1e-8, "actual rate balance {balance}");
    assert_eq!(w.rates[l.wst_start] + w.rates[l.gas_mass_exported], 0.);
    assert!(w.rates[l.gas_exported] > 200.); // real p*dV work, not just vapor heat
    assert_eq!(w.rates[l.spring_released], 500.);
    assert!(w.prhr.as_ref().unwrap().pool_heat_w > 0.);
    assert_eq!(n.dimension(), l.dimension);
    assert!(w.evaluate(&n, &y, &yp, None).is_err()); // no implicit open/closed fallback
}
#[test]
fn zero_disc_exposure_keeps_surface_chart_rank_and_true_heat_zero() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let mut w = n::Workspace::new(&n);
    w.evaluate_with_inputs(
        &n,
        &y,
        &vec![0.; n.dimension()],
        Some(1.),
        &[],
        Some(input(0.)),
    )
    .unwrap();
    let surface = n.prhr_layout().unwrap().surface_start + 1;
    assert!(entry(&n, &w, surface, surface) > 1.);
    assert_eq!(entry(&n, &w, n.energy_row(1), surface), 0.);
    assert_eq!(entry(&n, &w, n.flow_row(0), n.flow_row(0)), 1.);
    assert_eq!(
        entry(&n, &w, n.flow_row(0), n.mechanical_row(1).unwrap()),
        0.
    );
}
#[test]
fn assembled_same_trial_jacobian_includes_surface_pool_volume_work_and_scalar_paths() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 0.02;
    let mut yp = vec![0.; n.dimension()];
    let l = n.prhr_layout().unwrap();
    yp[l.wst_start + 3] = 0.002;
    let mut w = n::Workspace::new(&n);
    let cj = 2.;
    let input = Some(input(0.3));
    w.evaluate_with_inputs(&n, &y, &yp, Some(cj), &[], input)
        .unwrap();
    let columns = [
        n.pressure_row(),
        n.temperature_row(0),
        n.temperature_row(1),
        n.flow_row(0),
        n.energy_row(2),
        n.energy_row(3),
        l.wst_start + 2,
        l.wst_start + 3,
        l.room_energy,
        l.surface_start,
        l.surface_start + 1,
        l.surface_start + 2,
    ];
    for col in columns {
        let h = if col == n.pressure_row() {
            1.
        } else if col == n.flow_row(0) {
            1e-6
        } else if col == l.wst_start + 3 {
            1e-4
        } else if col == l.room_energy || col == n.energy_row(2) || col == n.energy_row(3) {
            0.1
        } else {
            1e-4
        };
        let mut plus = y.clone();
        let mut minus = y.clone();
        let mut pp = yp.clone();
        let mut pm = yp.clone();
        plus[col] += h;
        minus[col] -= h;
        pp[col] += cj * h;
        pm[col] -= cj * h;
        let mut a = n::Workspace::new(&n);
        let mut b = n::Workspace::new(&n);
        a.evaluate_with_inputs(&n, &plus, &pp, None, &[], input)
            .unwrap();
        b.evaluate_with_inputs(&n, &minus, &pm, None, &[], input)
            .unwrap();
        for row in 0..n.dimension() {
            let numeric = (a.residual[row] - b.residual[row]) / (2. * h);
            let analytic = entry(&n, &w, row, col);
            let allowed = 2e-3 * numeric.abs().max(analytic.abs()) + 0.01;
            assert!(
                (numeric - analytic).abs() < allowed,
                "row{row} col{col} numeric{numeric} analytic{analytic}"
            );
        }
    }
}

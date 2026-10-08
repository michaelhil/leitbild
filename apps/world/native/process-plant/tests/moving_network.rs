use leitbild_plant_numerics::{CellGeometry, GRAVITY, moving_guide, operating_network::*};
use std::f64::consts::PI;

fn fixture() -> Network {
    let annulus = 24. * PI * (0.0055_f64.powi(2) - 0.00475_f64.powi(2));
    let edge = |from, to, length, area, diameter, fixed_loss| Hydraulic {
        from,
        to,
        from_elevation: 0.,
        to_elevation: 0.,
        segments: vec![HydraulicSegment {
            law: LossLaw::ChurchillPipe,
            length,
            flow_area: area,
            diameter,
            roughness: 1e-6,
            fixed_loss,
            grid_multiplier: 0.,
        }],
    };
    Network::new(Config {
        water: [0.3, annulus * 4.65, 0.5]
            .into_iter()
            .enumerate()
            .map(|(i, volume)| Water {
                geometry: CellGeometry {
                    volume,
                    elevation: 0.,
                },
                initial_pressure: 3e5,
                initial_temperature: 300.,
                initial_tracer_fraction: 0.001 * (i + 1) as f64,
            })
            .collect(),
        solids: vec![],
        hydraulic: vec![
            edge(0, 1, 0., 24. * PI * 0.0055_f64.powi(2), 0.011, 0.8),
            edge(1, 2, 4.65, annulus, 0.0015, 0.8),
            edge(0, 2, 5., 0.01, 0.1, 0.5),
        ],
        heat: vec![],
        secondaries: vec![],
        secondary_heat: vec![],
        seat: None,
        prhr: None,
    })
    .unwrap()
}
fn shapes(n: &Network, y: f64, v: f64) -> Vec<WaterShape> {
    let a = 24. * PI * 0.00475_f64.powi(2);
    let j = a * ((-2.25) * y + 0.5 * y * y);
    let mut s = n
        .config()
        .water
        .iter()
        .map(|w| WaterShape {
            volume_m3: w.geometry.volume,
            first_moment_m4: w.geometry.volume * w.geometry.elevation,
            ..Default::default()
        })
        .collect::<Vec<_>>();
    s[1].volume_m3 += a * y;
    s[1].first_moment_m4 += j;
    s[1].volume_rate_m3_s = a * v;
    s[1].first_moment_rate_m4_s = a * (-2.25 + y) * v;
    s[2].volume_m3 -= a * y;
    s[2].first_moment_m4 -= a * 4.65 * y + j;
    s[2].volume_rate_m3_s = -a * v;
    s[2].first_moment_rate_m4_s = -a * (4.65 - 2.25 + y) * v;
    s
}
fn connections(y: f64, v: f64) -> Vec<MovingConnection> {
    vec![
        MovingConnection {
            edge: 0,
            from_elevation_m: -2.25,
            to_elevation_m: -2.25 + y,
            fluid_work_cell: 1,
            law: moving_hydraulic::Law::Clear {
                outer_radius_m: 0.0055,
                length_m: y,
                multiplicity: 24,
                roughness_m: 1e-6,
                mouth_loss: 0.8,
            },
        },
        MovingConnection {
            edge: 1,
            from_elevation_m: -2.25 + y,
            to_elevation_m: 2.4,
            fluid_work_cell: 1,
            law: moving_hydraulic::Law::Annulus {
                geometry: moving_guide::Geometry {
                    outer_radius_m: 0.0055,
                    inner_radius_m: 0.00475,
                    length_m: 4.65 - y,
                    multiplicity: 24,
                },
                speed_m_s: v,
                roughness_m: 1e-6,
                mouth_loss: 0.8,
            },
        },
    ]
}
fn evaluate(
    n: &Network,
    y: &[f64],
    yp: &[f64],
    cj: Option<f64>,
    s: &[WaterShape],
    c: &[MovingConnection],
) -> Workspace {
    let mut w = Workspace::new(n);
    w.evaluate_with_motion(
        n,
        y,
        yp,
        cj,
        &[],
        None,
        Some(MotionGeometry {
            water: s,
            connections: c,
        }),
    )
    .unwrap();
    w
}
fn action(n: &Network, w: &Workspace, d: &[f64]) -> Vec<f64> {
    let mut a = vec![0.; n.dimension()];
    for (col, &v) in d.iter().enumerate() {
        for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
            a[n.row_indices[k] as usize] += w.jacobian_values[k] * v;
        }
    }
    a
}
fn close(name: &str, a: f64, b: f64, absolute: f64, relative: f64) {
    assert!(
        (a - b).abs() <= absolute + relative * a.abs().max(b.abs()),
        "{name}: {a} vs {b}, error {}",
        (a - b).abs()
    );
}

#[test]
fn shape_and_moving_connection_chain_matches_same_branch_finite_difference() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 0.013;
    y[n.flow_row(1)] = -0.017;
    y[n.flow_row(2)] = 0.004;
    y[n.mechanical_row(1).unwrap()] = 3.;
    y[n.mechanical_row(2).unwrap()] = -2.;
    let yp = (0..n.dimension())
        .map(|i| 0.01 * (i + 1) as f64)
        .collect::<Vec<_>>();
    let (position, speed, dy, dv) = (0.002, 0.008, 0.0004, -0.003);
    let s = shapes(&n, position, speed);
    let c = connections(position, speed);
    let mut w = evaluate(&n, &y, &yp, Some(0.), &s, &c);
    let area = 24. * PI * 0.00475_f64.powi(2);
    let mut ds = vec![WaterShape::default(); 3];
    ds[1] = WaterShape {
        volume_m3: area * dy,
        first_moment_m4: area * (-2.25 + position) * dy,
        volume_rate_m3_s: area * dv,
        first_moment_rate_m4_s: area * ((-2.25 + position) * dv + speed * dy),
    };
    ds[2] = WaterShape {
        volume_m3: -ds[1].volume_m3,
        first_moment_m4: -area * (2.4 + position) * dy,
        volume_rate_m3_s: -ds[1].volume_rate_m3_s,
        first_moment_rate_m4_s: -area * ((2.4 + position) * dv + speed * dy),
    };
    let dc = vec![
        MovingConnectionDirection {
            to_elevation_m: dy,
            length_m: dy,
            ..Default::default()
        },
        MovingConnectionDirection {
            from_elevation_m: dy,
            length_m: -dy,
            speed_m_s: dv,
            ..Default::default()
        },
    ];
    let mut j = vec![0.; n.dimension()];
    let ej = w.add_motion_jvp(&n, &ds, &dc, &mut j).unwrap();
    let e = 1e-3;
    let arms = [-1., 1.].map(|sign| {
        evaluate(
            &n,
            &y,
            &yp,
            None,
            &shapes(&n, position + sign * e * dy, speed + sign * e * dv),
            &connections(position + sign * e * dy, speed + sign * e * dv),
        )
    });
    for row in 0..n.dimension() {
        let fd = (arms[1].residual[row] - arms[0].residual[row]) / (2. * e);
        close(&format!("shape row {row}"), j[row], fd, 2e-5, 2e-5);
    }
    let fd_energy = n
        .installed_energy_rows()
        .map(|r| (arms[1].rates[r] - arms[0].rates[r]) / (2. * e))
        .sum::<f64>();
    close(
        "independent geometry energy rate",
        ej,
        fd_energy,
        1e-8,
        2e-5,
    );
}

#[test]
fn held_geometry_csc_includes_work_compressibility_and_local_shape_rate_partials() {
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    y[n.flow_row(0)] = 0.013;
    y[n.flow_row(1)] = -0.017;
    y[n.flow_row(2)] = 0.004;
    let yp = vec![0.02; n.dimension()];
    let s = shapes(&n, 0.002, 0.008);
    let c = connections(0.002, 0.008);
    let cj = 1.7;
    let w = evaluate(&n, &y, &yp, Some(cj), &s, &c);
    let mut d = vec![0.01; n.dimension()];
    d[n.pressure_row()] = 3.;
    let j = action(&n, &w, &d);
    let e = 1e-3;
    let arms = [-1., 1.].map(|sign| {
        let yy = y
            .iter()
            .zip(&d)
            .map(|(v, d)| v + sign * e * d)
            .collect::<Vec<_>>();
        let pp = yp
            .iter()
            .zip(&d)
            .map(|(v, d)| v + sign * e * cj * d)
            .collect::<Vec<_>>();
        evaluate(&n, &yy, &pp, None, &s, &c)
    });
    for row in 0..n.dimension() {
        let fd = (arms[1].residual[row] - arms[0].residual[row]) / (2. * e);
        close(&format!("state row {row}"), j[row], fd, 3e-5, 3e-5);
    }
}

#[test]
fn moving_counterflow_is_not_hidden_by_zero_bulk_current() {
    use leitbild_plant_numerics::operating_admission;
    let n = fixture();
    let mut y = n.initial_state().unwrap();
    let yp = vec![0.; n.dimension()];
    let s = shapes(&n, 0., 0.008);
    let c = connections(0., 0.008);
    let w = evaluate(&n, &y, &yp, None, &s, &c);
    let d =
        operating_admission::screen(&n, &w, &y, operating_admission::totals(&n, &y), &[1e-5; 3])
            .unwrap();
    assert_eq!(d.speed, 0.);
    assert_eq!(d.moving_wall_speed, 0.008);
    assert_eq!(d.moving_profile_speed_bound, 0.024);
    assert!(d.dynamic_head > 0. && d.omitted_kinetic_energy > 0.);

    y[n.flow_row(1)] = -0.002;
    let w = evaluate(&n, &y, &yp, None, &shapes(&n, 0., 0.), &connections(0., 0.));
    let d =
        operating_admission::screen(&n, &w, &y, operating_admission::totals(&n, &y), &[1e-5; 3])
            .unwrap();
    assert_eq!(d.moving_wall_speed, 0.);
    assert!(d.moving_profile_speed_bound > d.speed);
    assert!(d.dynamic_head > 0. && d.omitted_kinetic_energy > 0.);
}

#[test]
fn zero_length_mouth_original_saddle_is_nonsingular_and_compressible_storage_is_retained() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let yp = vec![0.; n.dimension()];
    let s = shapes(&n, 0., 0.);
    let c = connections(0., 0.);
    let w = evaluate(&n, &y, &yp, Some(1.), &s, &c);
    assert_eq!(w.current_hydraulic_loss(&n, 0).unwrap()[1], 0.);
    assert!(w.hydraulic_diagnostic_band(&n, 0, 1e-5).unwrap() > 0.);
    let dim = n.dimension();
    let mut a = vec![vec![0.; dim]; dim];
    for col in 0..dim {
        for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
            a[n.row_indices[k] as usize][col] = w.jacobian_values[k];
        }
    }
    // Test-only rank reconstruction, not an alternate production solver.
    for col in 0..dim {
        let pivot = (col..dim)
            .max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))
            .unwrap();
        assert_ne!(a[pivot][col], 0., "singular actual ORIGINAL column {col}");
        a.swap(col, pivot);
        for i in col + 1..dim {
            let ratio = a[i][col] / a[col][col];
            for j in col..dim {
                a[i][j] -= ratio * a[col][j];
            }
        }
    }
    let mut slopes = yp.clone();
    slopes[n.pressure_row()] = 1.;
    slopes[n.total_mass_row()] = w.chart_derivatives.iter().map(|d| d[0]).sum();
    for i in 0..3 {
        slopes[i] = w.chart_derivatives[i][2];
    }
    let stored = evaluate(&n, &y, &slopes, None, &s, &c);
    assert!(stored.residual[n.mechanical_row(1).unwrap()] > 0.);
    close(
        "actual compressed guide mass storage",
        stored.residual[n.mechanical_row(1).unwrap()],
        w.chart_derivatives[1][0],
        1e-14,
        1e-12,
    );
}

#[test]
fn fixed_datum_pressure_work_is_opposite_buoyancy_and_empty_motion_is_bit_identical() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let yp = vec![0.; n.dimension()];
    let mut fixed = Workspace::new(&n);
    fixed.evaluate(&n, &y, &yp, Some(1.)).unwrap();
    let still = evaluate(&n, &y, &yp, Some(1.), &shapes(&n, 0., 0.), &[]);
    for (a, b) in fixed.residual.iter().zip(&still.residual) {
        assert_eq!(a.to_bits(), b.to_bits());
    }
    for (a, b) in fixed.jacobian_values.iter().zip(&still.jacobian_values) {
        assert_eq!(a.to_bits(), b.to_bits());
    }
    let (position, speed) = (0.002, 0.008);
    let moved = evaluate(&n, &y, &yp, None, &shapes(&n, position, speed), &[]);
    let area = 24. * PI * 0.00475_f64.powi(2);
    let buoyancy = fixed.liquids[1].density * GRAVITY * area * 4.65;
    close(
        "pressure virtual work",
        moved.shape_pressure_work_w.iter().sum(),
        -buoyancy * speed,
        1e-12,
        1e-12,
    );
    assert_ne!(moved.chart_mass[1].to_bits(), fixed.chart_mass[1].to_bits());
}

#[test]
fn moved_port_and_shape_work_are_covariant_under_vertical_datum_translation() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let yp = vec![0.; n.dimension()];
    let s = shapes(&n, 0.002, 0.008);
    let c = connections(0.002, 0.008);
    let w = evaluate(&n, &y, &yp, Some(0.), &s, &c);
    let dz = 17.;
    let mut config = n.config().clone();
    for a in &mut config.water {
        a.geometry.elevation += dz;
    }
    for a in &mut config.hydraulic {
        a.from_elevation += dz;
        a.to_elevation += dz;
    }
    let translated = Network::new(config).unwrap();
    let mut ys = translated.initial_state().unwrap();
    for i in 0..3 {
        ys[i] = y[i] + w.chart_mass[i] * GRAVITY * dz;
    }
    let ss = s
        .iter()
        .map(|a| WaterShape {
            first_moment_m4: a.first_moment_m4 + dz * a.volume_m3,
            first_moment_rate_m4_s: a.first_moment_rate_m4_s + dz * a.volume_rate_m3_s,
            ..*a
        })
        .collect::<Vec<_>>();
    let cc = c
        .iter()
        .map(|a| MovingConnection {
            from_elevation_m: a.from_elevation_m + dz,
            to_elevation_m: a.to_elevation_m + dz,
            ..*a
        })
        .collect::<Vec<_>>();
    let ww = evaluate(&translated, &ys, &yp, Some(0.), &ss, &cc);
    for i in 0..3 {
        close(
            "translated pressure boundary work",
            w.shape_pressure_work_w[i],
            ww.shape_pressure_work_w[i],
            1e-12,
            1e-12,
        );
    }
    for edge in 0..3 {
        close(
            "translated actual hydraulic head",
            w.current_hydraulic_drive(&n, edge).unwrap().0,
            ww.current_hydraulic_drive(&translated, edge).unwrap().0,
            1e-10,
            1e-12,
        );
    }
    let mut invalid = s.clone();
    invalid[1].volume_m3 = 0.;
    let mut failed = w;
    assert!(
        failed
            .evaluate_with_motion(
                &n,
                &y,
                &yp,
                Some(0.),
                &[],
                None,
                Some(MotionGeometry {
                    water: &invalid,
                    connections: &c
                })
            )
            .is_err()
    );
    assert!(failed.moving_responses().is_err());
}

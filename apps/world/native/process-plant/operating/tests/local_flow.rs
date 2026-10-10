use leitbild_operating_plant::{
    local_flow::{
        Cell, Face, ForceProjection, MomentumSupport, Phase, PressureSegment, add_mean_velocity,
        chart, momentum_residual, pressure_after_segments, project_nonpressure,
    },
    thermal::Scalar,
};
fn s(x: f64) -> Scalar {
    Scalar::constant(x)
}
fn close(a: f64, b: f64, t: f64) {
    assert!(
        (a - b).abs() <= t * (1. + a.abs().max(b.abs())),
        "{a} != {b}"
    );
}
fn phase(alpha: f64, rho: f64, h: f64) -> Phase {
    Phase {
        fraction: s(alpha),
        density: s(rho),
        enthalpy: s(h),
        boron_concentration: s(0.001),
    }
}
fn face() -> Face {
    Face {
        from: 0,
        to: 1,
        flow_area_m2: 1.,
        supports: (0..2)
            .map(|region| MomentumSupport {
                region,
                path_length_m: 1.,
                inverse_area_length_per_m: 1.,
                volume_m3: 1.,
            })
            .collect(),
        pressure_segments: (0..2)
            .map(|region| PressureSegment {
                region,
                path_length_m: 1.,
                elevation_change_m: 1.,
            })
            .collect(),
    }
}
fn sharp() -> [Cell; 2] {
    [
        Cell {
            pressure: s(15e6),
            phase: [Some(phase(1., 660., 1.5e6)), None],
        },
        Cell {
            pressure: s(15e6 - 9.80665 * (660. + 80.)),
            phase: [None, Some(phase(1., 80., 2.8e6))],
        },
    ]
}
#[test]
fn sharp_hydrostatic_two_phase_rest_has_one_well_balanced_pressure_profile() {
    let f = face();
    f.validate(2).unwrap();
    let cells = sharp();
    close(
        pressure_after_segments(&f, &cells, 1).unwrap().value,
        15e6 - 660. * 9.80665,
        1e-12,
    );
    close(
        pressure_after_segments(&f, &cells, 2).unwrap().value,
        cells[1].pressure.value,
        1e-12,
    );
    for k in 0..2 {
        let c = chart(&f, &cells, k, s(0.)).unwrap().unwrap();
        close(c.pressure_gravity_pa.value, 0., 1e-9);
        assert_eq!(c.mass_flow_kg_s.value, 0.);
        assert_eq!(
            momentum_residual(s(0.), c, s(0.)).unwrap().value,
            -c.pressure_gravity_pa.value
        );
    }
    let mut reversed = f.clone();
    for p in &mut reversed.pressure_segments {
        p.elevation_change_m *= -1.;
    }
    let mut reverse_cells = cells;
    reverse_cells[1].pressure = s(15e6 + 9.80665 * (660. + 80.));
    for k in 0..2 {
        close(
            chart(&reversed, &reverse_cells, k, s(0.))
                .unwrap()
                .unwrap()
                .pressure_gravity_pa
                .value,
            0.,
            1e-9,
        );
    }
}
#[test]
fn mixed_hydrostatic_state_retains_opposite_relative_buoyancy() {
    let f = face();
    let mut cells = sharp();
    for c in &mut cells {
        c.phase = [Some(phase(0.5, 660., 1.5e6)), Some(phase(0.5, 80., 2.8e6))];
    }
    let l = chart(&f, &cells, 0, s(0.)).unwrap().unwrap();
    let g = chart(&f, &cells, 1, s(0.)).unwrap().unwrap();
    close(l.pressure_gravity_pa.value, -290. * 9.80665, 1e-12);
    close(g.pressure_gravity_pa.value, 290. * 9.80665, 1e-12);
    close(
        l.pressure_gravity_pa.value + g.pressure_gravity_pa.value,
        0.,
        16. * f64::EPSILON * cells[0].pressure.value,
    );
}
#[test]
fn impulse_does_not_invent_absent_donor_or_duplicate_thermal_heating() {
    let cells = sharp();
    let f = face();
    let forward = chart(&f, &cells, 0, s(1320.)).unwrap().unwrap();
    close(forward.volume_flow_m3_s.value, 2., 1e-12);
    close(forward.mass_flow_kg_s.value, 1320., 1e-12);
    close(forward.enthalpy_flow_w.value, 1320. * 1.5e6, 1e-12);
    close(forward.boron_flow_kg_s.value, 1.32, 1e-12);
    assert_eq!(forward.donor, Some(0));
    let backward = chart(&f, &cells, 0, s(-1320.)).unwrap().unwrap();
    assert!(backward.blocked_absent_donor);
    assert_eq!(backward.donor, None);
    assert_eq!(backward.mass_flow_kg_s.value, 0.);
    assert_eq!(backward.enthalpy_flow_w.value, 0.);
    assert_eq!(backward.boron_flow_kg_s.value, 0.);
    assert!(backward.kinetic_j.value > 0.);
    // All M/H/B output is precisely the donor receipt. No friction/pressure
    // heat, independent empty phase energy or kinetic heater is returned.
    let mut empty = cells;
    empty[0].phase[0] = None;
    assert!(chart(&f, &empty, 0, s(0.)).unwrap().is_none());
    assert!(chart(&f, &empty, 0, s(1.)).is_err());
}
#[test]
fn variable_area_profile_uses_actual_integrals_not_throat_or_mean_velocity_mass() {
    let mut f = face();
    f.flow_area_m2 = 0.25;
    f.supports[0] = MomentumSupport {
        region: 0,
        path_length_m: 2.,
        inverse_area_length_per_m: 1.,
        volume_m3: 4.,
    };
    f.supports[1] = MomentumSupport {
        region: 1,
        path_length_m: 3.,
        inverse_area_length_per_m: 6.,
        volume_m3: 1.5,
    };
    let cells = [Cell {
        pressure: s(15e6),
        phase: [Some(phase(1., 660., 1.5e6)), None],
    }; 2];
    let current = chart(&f, &cells, 0, s(660. * 7. * 2.)).unwrap().unwrap();
    close(current.inertance_kg_m4.value, 660. * 7., 1e-12);
    close(current.volume_flow_m3_s.value, 2., 1e-12);
    close(current.mass_flow_kg_s.value, 1320., 1e-12);
    close(current.kinetic_j.value, 0.5 * 660. * 7. * 4., 1e-12);
    let projection = [
        ForceProjection {
            region: 0,
            coefficient_per_m2: 0.5,
            normal: [1., 0.],
        },
        ForceProjection {
            region: 1,
            coefficient_per_m2: 2.,
            normal: [1., 0.],
        },
    ];
    let mut velocity = [[s(0.); 2]; 2];
    add_mean_velocity(&projection, current.volume_flow_m3_s, &mut velocity).unwrap();
    close(velocity[0][0].value, 1., 1e-12);
    close(velocity[1][0].value, 4., 1e-12);
    let forces = [[s(21.), s(5.)], [s(-3.), s(-2.)]];
    let generalized = project_nonpressure(&projection, &forces).unwrap();
    close(
        generalized.value * current.volume_flow_m3_s.value,
        21. * 1. - 3. * 4.,
        1e-12,
    );
}
#[test]
fn radial_support_uses_log_integral_and_head_only_segments_are_explicit() {
    let mut f = face();
    let pi = std::f64::consts::PI;
    let exact = 2_f64.ln() / (2. * pi * 3.);
    f.supports[0].inverse_area_length_per_m = exact;
    f.supports[0].volume_m3 = pi * 3. * (4. - 1.);
    f.pressure_segments.push(PressureSegment {
        region: 0,
        path_length_m: 0.,
        elevation_change_m: 2.,
    });
    f.validate(2).unwrap();
    let mut cells = sharp();
    cells[1].pressure = s(cells[1].pressure.value - 660. * 9.80665 * 2.);
    let c = chart(&f, &cells, 0, s(0.)).unwrap().unwrap();
    close(c.inertance_kg_m4.value, 660. * exact, 1e-12);
    assert!((exact - 1. / (9. * pi)).abs() > 1e-4);
    close(c.pressure_gravity_pa.value, 0., 1e-9);
    f.supports[0].inverse_area_length_per_m = 0.;
    assert!(f.validate(2).is_err());
}
fn shifted(v: Scalar, d: f64) -> Scalar {
    s(v.value + v.direction * d)
}
fn shift_cells(mut cells: [Cell; 2], d: f64) -> [Cell; 2] {
    for c in &mut cells {
        c.pressure = shifted(c.pressure, d);
        for p in c.phase.iter_mut().flatten() {
            p.fraction = shifted(p.fraction, d);
            p.density = shifted(p.density, d);
            p.enthalpy = shifted(p.enthalpy, d);
            p.boron_concentration = shifted(p.boron_concentration, d);
        }
    }
    cells
}
#[test]
fn whole_face_direction_matches_independent_shifted_current_evaluations() {
    let f = face();
    let mut cells = sharp();
    for (i, c) in cells.iter_mut().enumerate() {
        c.pressure.direction = if i == 0 { 107. } else { -59. };
        c.phase = [Some(phase(0.6, 660., 1.5e6)), Some(phase(0.4, 80., 2.8e6))];
        for (k, p) in c.phase.iter_mut().enumerate() {
            let p = p.as_mut().unwrap();
            p.fraction.direction = if k == 0 { 0.03 } else { -0.03 };
            p.density.direction = if k == 0 { 2. } else { -0.5 };
            p.enthalpy.direction = 109. + i as f64;
            p.boron_concentration.direction = 0.0001;
        }
    }
    let impulse = Scalar::new(1320., 13.);
    let fields = |c: leitbild_operating_plant::local_flow::Chart| {
        [
            c.inertance_kg_m4,
            c.volume_flow_m3_s,
            c.mass_flow_kg_s,
            c.enthalpy_flow_w,
            c.boron_flow_kg_s,
            c.pressure_gravity_pa,
            c.kinetic_j,
        ]
    };
    for k in 0..2 {
        let current = fields(chart(&f, &cells, k, impulse).unwrap().unwrap());
        let h = 1e-3;
        let plus = fields(
            chart(&f, &shift_cells(cells, h), k, shifted(impulse, h))
                .unwrap()
                .unwrap(),
        );
        let minus = fields(
            chart(&f, &shift_cells(cells, -h), k, shifted(impulse, -h))
                .unwrap()
                .unwrap(),
        );
        for j in 0..current.len() {
            close(
                current[j].direction,
                (plus[j].value - minus[j].value) / (2. * h),
                2e-7,
            );
        }
    }
}
#[test]
fn zero_impulse_switch_is_directional_not_a_smooth_or_padded_donor() {
    let f = face();
    let cells = sharp();
    let forward = chart(&f, &cells, 0, Scalar::new(0., 1.)).unwrap().unwrap();
    assert!(forward.selected_branch_direction);
    close(forward.mass_flow_kg_s.direction, 1., 1e-12);
    let backward = chart(&f, &cells, 0, Scalar::new(0., -1.)).unwrap().unwrap();
    assert!(backward.selected_branch_direction && backward.blocked_absent_donor);
    assert_eq!(backward.mass_flow_kg_s.direction, 0.);
}

#[test]
fn retained_mass_kinematics_matches_finite_chart_and_complete_current_direction() {
    use leitbild_operating_plant::local_flow::{ColdOnset, phase_path_kinematics};
    let f = face();
    let mut cells = sharp();
    cells[1].phase[0] = Some(phase(0.3, 500., 1.7e6));
    let volumes = [2., 3.];
    let mass = [Scalar::new(1320., -5.), Scalar::new(450., 7.)];
    let mass_rate = [Scalar::new(-0.3, 0.1), Scalar::new(0.2, -0.05)];
    let impulse = Scalar::new(1620., 20.);
    let actual = phase_path_kinematics(
        &f,
        &mass,
        &mass_rate,
        &volumes,
        impulse,
        s(0.),
        ColdOnset::Unavailable,
    )
    .unwrap();
    let ordinary = chart(&f, &cells, 0, s(1620.)).unwrap().unwrap();
    close(
        actual.inertance_kg_m4.value,
        ordinary.inertance_kg_m4.value,
        1e-12,
    );
    close(
        actual.volume_flow_m3_s.value,
        ordinary.volume_flow_m3_s.value,
        1e-12,
    );
    close(
        actual.inertance_rate_kg_m4_s.value,
        -0.3 / 2. + 0.2 / 3.,
        1e-12,
    );
    // Independent quotient, varying both physical retained mass and impulse.
    let probe = |step| {
        (impulse.value + step * impulse.direction)
            / ((mass[0].value + step * mass[0].direction) / volumes[0]
                + (mass[1].value + step * mass[1].direction) / volumes[1])
    };
    close(
        actual.volume_flow_m3_s.direction,
        (probe(1e-3) - probe(-1e-3)) / 2e-3,
        1e-10,
    );
    let signed = phase_path_kinematics(
        &f,
        &mass.map(|m| -m),
        &mass_rate,
        &volumes,
        impulse,
        s(0.),
        ColdOnset::Unavailable,
    )
    .unwrap();
    close(
        signed.volume_flow_m3_s.value,
        -actual.volume_flow_m3_s.value,
        1e-12,
    );
}

#[test]
fn cold_positive_receipt_uses_actual_force_over_inertia_rate_and_its_direction() {
    use leitbild_operating_plant::local_flow::{ColdOnset, phase_path_kinematics};
    let f = face();
    let volumes = [2., 3.];
    let mass_rate = [Scalar::new(0.4, -0.02), Scalar::new(0.6, 0.04)];
    let force = Scalar::new(-1.2, 0.07);
    let actual = phase_path_kinematics(
        &f,
        &[s(0.); 2],
        &mass_rate,
        &volumes,
        s(0.),
        force,
        ColdOnset::Unavailable,
    )
    .unwrap();
    close(actual.volume_flow_m3_s.value, -3., 1e-12);
    let quotient = |step| {
        (force.value + step * force.direction)
            / ((mass_rate[0].value + step * mass_rate[0].direction) / volumes[0]
                + (mass_rate[1].value + step * mass_rate[1].direction) / volumes[1])
    };
    close(
        actual.volume_flow_m3_s.direction,
        (quotient(1e-3) - quotient(-1e-3)) / 2e-3,
        1e-10,
    );
    // Actual finite one-sided sequence: M=M' t, Pi=F t, with no EOS or seed.
    for t in [1e-1, 1e-4, 1e-9] {
        let finite = phase_path_kinematics(
            &f,
            &mass_rate.map(|x| s(x.value * t)),
            &mass_rate,
            &volumes,
            s(force.value * t),
            force,
            ColdOnset::Unavailable,
        )
        .unwrap();
        close(
            finite.volume_flow_m3_s.value,
            actual.volume_flow_m3_s.value,
            1e-12,
        );
    }
}

#[test]
fn exact_cold_rest_requires_explicit_proof_and_never_hides_finite_impulse() {
    use leitbild_operating_plant::local_flow::{ColdOnset, phase_path_kinematics};
    let f = face();
    let run = |mass: [Scalar; 2], md: [Scalar; 2], impulse, force, onset| {
        phase_path_kinematics(&f, &mass, &md, &[2., 3.], impulse, force, onset)
    };
    assert!(run([s(0.); 2], [s(0.); 2], s(0.), s(0.), ColdOnset::Unavailable).is_err());
    let rest = run(
        [s(0.); 2],
        [s(0.); 2],
        Scalar::new(0., 1.),
        s(0.),
        ColdOnset::ProvenRest,
    )
    .unwrap();
    assert_eq!(rest.volume_flow_m3_s.value, 0.);
    assert_eq!(rest.volume_flow_m3_s.direction, 0.); // Selected inexact onset column.
    assert!(run([s(0.); 2], [s(0.); 2], s(1.), s(0.), ColdOnset::ProvenRest).is_err());
    assert!(run([s(0.); 2], [s(0.); 2], s(0.), s(1.), ColdOnset::ProvenRest).is_err());
    assert!(run([s(0.); 2], [s(-1.); 2], s(0.), s(0.), ColdOnset::ProvenRest).is_err());
    assert!(
        run(
            [Scalar::new(0., f64::NAN); 2],
            [s(0.); 2],
            s(0.),
            s(0.),
            ColdOnset::ProvenRest
        )
        .is_err()
    );
    // The actual proved rest limit, not a universal zero: I=a t², F=b t²,
    // Pi=b t³/3 gives Q=b t/(3a) tending to zero.
    for t in [1e-1, 1e-4, 1e-9] {
        let finite = run(
            [s(2. * t * t), s(3. * t * t)],
            [s(4. * t), s(6. * t)],
            s(6. * t * t * t / 3.),
            s(6. * t * t),
            ColdOnset::Unavailable,
        )
        .unwrap();
        close(finite.volume_flow_m3_s.value, t, 1e-12);
    }
}

#[test]
fn cancelling_signed_mass_is_not_an_empty_phase_onset() {
    use leitbild_operating_plant::local_flow::{ColdOnset, phase_path_kinematics};
    let f = face();
    // These signed Newton masses cancel I exactly, but neither supported
    // phase is absent. Neither a rest nor a positive-receipt birth limit is
    // the missing Cartesian quotient at this singular trial.
    for rate in [[s(0.); 2], [s(1.); 2]] {
        assert_eq!(
            phase_path_kinematics(
                &f,
                &[s(2.), s(-3.)],
                &rate,
                &[2., 3.],
                s(0.),
                s(0.),
                ColdOnset::ProvenRest,
            )
            .unwrap_err(),
            "singular signed phase inertia is not exact absence"
        );
    }
}

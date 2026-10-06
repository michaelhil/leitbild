//! Finite HEADER/RETURN algebraic and tangent witnesses, not a whole primary.
use leitbild_plant_numerics::finite_header_return::{Input, evaluate};
use leitbild_plant_numerics::horizontal_passage::Geometry;
use leitbild_plant_numerics::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch};

fn water(p: f64, t: f64) -> Liquid {
    let mut out = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            pressure: p,
            temperature: t,
        }],
        &mut out,
    )
    .unwrap();
    out[0]
}

fn prepared(ph: f64, th: f64, pd: f64, td: f64, velocity: f64) -> Input {
    let header_geometry = CellGeometry {
        volume: 4.0,
        elevation: 3.0,
    };
    let passage = Geometry {
        area: 2.0 * std::f64::consts::PI * 0.70_f64.powi(2) / 4.0,
        length: 0.50,
        elevation: 3.0,
    };
    let h = water(ph, th);
    let d = water(pd, td);
    let mh = h.density * header_geometry.volume;
    let md = d.density * passage.area * passage.length;
    let w = md * velocity / 3.0;
    let k = 1.5 * w * w / md;
    Input {
        header_geometry,
        passage,
        trial: [
            mh,
            mh * (h.internal_energy + GRAVITY * 3.0),
            ph,
            th,
            md,
            md * (d.internal_energy + GRAVITY * 3.0) + k,
            w,
            pd,
            td,
        ],
        derivative: [0.0; 9],
    }
}

fn close(a: f64, b: f64, relative: f64, absolute: f64) {
    assert!(
        (a - b).abs() <= absolute + relative * a.abs().max(b.abs()),
        "a={a:.17e},b={b:.17e},difference={:.17e}",
        a - b
    );
}

fn availability(donor: Liquid, receiver: Liquid, receiver_p: f64) -> f64 {
    donor.internal_energy
        - receiver.internal_energy
        - receiver.temperature * (donor.entropy - receiver.entropy)
        + receiver_p * (1.0 / donor.density - 1.0 / receiver.density)
}

#[test]
fn finite_pair_conserves_mass_total_energy_and_has_directional_entropy() {
    for (ph, th, pd, td) in [
        (15.23e6, 450.0, 15.2e6, 313.15),
        (15.23e6, 313.15, 15.2e6, 450.0),
        (15.23e6, 600.0, 15.2e6, 599.9),
        (20.5e6, 640.0, 20.49e6, 639.9),
    ] {
        for velocity in [-2.0, -0.2, 0.0, 0.2, 2.0] {
            let input = prepared(ph, th, pd, td, velocity);
            let result = evaluate(input, 0.0).unwrap();
            let h = water(ph, th);
            let d = water(pd, td);
            let q = result.mass_flow;
            close(result.velocity, velocity, 2e-15, 1e-15);
            assert_eq!(result.rates[0] + result.rates[2], 0.0);
            assert_eq!(result.rates[1] + result.rates[3], 0.0);
            assert_eq!(result.rates[0], -q);
            assert_eq!(result.rates[1], -q * result.total_enthalpy);
            close(
                result.kinetic_energy,
                input.trial[4] * velocity * velocity / 6.0,
                2e-15,
                1e-12,
            );
            let entropy = if velocity >= 0.0 {
                close(
                    result.traction_pressure,
                    ph - h.density * velocity * velocity / 2.0,
                    0.0,
                    1e-8,
                );
                close(
                    result.total_enthalpy,
                    h.internal_energy + ph / h.density + GRAVITY * 3.0,
                    2e-15,
                    1e-9,
                );
                close(result.header_entropy_rate, -q * h.entropy, 2e-13, 1e-8);
                q * availability(h, d, pd) / td
            } else {
                assert_eq!(result.traction_pressure, ph);
                close(
                    result.total_enthalpy,
                    d.internal_energy + ph / d.density + velocity * velocity / 2.0 + GRAVITY * 3.0,
                    2e-15,
                    1e-9,
                );
                close(result.duct_entropy_rate, q * d.entropy, 2e-13, 1e-8);
                -q * (availability(d, h, ph) + velocity * velocity / 2.0) / th
            };
            close(
                result.entropy_production,
                result.header_entropy_rate + result.duct_entropy_rate,
                0.0,
                0.0,
            );
            close(result.entropy_production, entropy, 2e-9, 1e-8);
            close(result.expected_entropy_production, entropy, 2e-12, 1e-8);
            assert!(result.entropy_production >= -1e-8);
            assert!(result.residual.iter().all(|x| x.is_finite()));
            close(result.residual[2], 0.0, 0.0, 1e-10);
            close(result.residual[3], 0.0, 0.0, 1e-6);
            close(result.residual[7], 0.0, 0.0, 1e-10);
            close(result.residual[8], 0.0, 0.0, 1e-6);
        }
    }
}

fn perturbed(mut input: Input, column: usize, increment: f64, cj: f64) -> Input {
    input.trial[column] += increment;
    if matches!(column, 0 | 1 | 4 | 5 | 6) {
        input.derivative[column] += cj * increment;
    }
    input
}

#[test]
fn full_half_analytic_matrix_matches_selected_off_manifold_chart_and_zero_branch() {
    for (p, t) in [
        (15.2e6, 313.15),
        (15.2e6, 450.0),
        (15.2e6, 600.0),
        (20.5e6, 640.0),
    ] {
        for velocity in [-1.1, 0.0, 1.3] {
            let mut input = prepared(p + 300.0, t, p, t - 0.01, velocity);
            input.trial[0] *= 1.01;
            input.trial[1] += 1234.0;
            input.trial[4] *= 1.02;
            input.trial[5] += 567.0;
            let cj = 3.7;
            let base = evaluate(input, cj).unwrap();
            let steps = [0.01, 10.0, 100.0, 0.001, 0.01, 10.0, 0.003, 100.0, 0.001];
            for column in 0..9 {
                for fraction in [1.0, 0.5] {
                    let h = if velocity == 0.0 && column == 6 {
                        0.0001 * fraction
                    } else {
                        steps[column] * fraction
                    };
                    let plus = evaluate(perturbed(input, column, h, cj), cj).unwrap();
                    let minus = if velocity == 0.0 && column == 6 {
                        base
                    } else {
                        evaluate(perturbed(input, column, -h, cj), cj).unwrap()
                    };
                    let denominator = if velocity == 0.0 && column == 6 {
                        h
                    } else {
                        2.0 * h
                    };
                    for row in 0..9 {
                        let measured = (plus.residual[row] - minus.residual[row]) / denominator;
                        let expected = base.jacobian[row][column];
                        assert!(
                            (measured - expected).abs()
                                <= 1e-5 + 2e-5 * measured.abs().max(expected.abs()),
                            "p={p},T={t},v={velocity},row={row},column={column},h={h},measured={measured:.17e},analytic={expected:.17e}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn horizontal_rest_datum_and_finite_domain_are_explicit() {
    let input = prepared(15.2e6, 313.15, 15.2e6, 313.15, 0.0);
    let result = evaluate(input, 0.0).unwrap();
    assert_eq!(result.rates, [0.0; 5]);
    assert_eq!(result.entropy_production, 0.0);
    for velocity in [-1.3, 1.1] {
        let input = prepared(15.23e6, 450.0, 15.2e6, 313.15, velocity);
        let a = evaluate(input, 0.0).unwrap();
        let mut shifted = input;
        shifted.header_geometry.elevation += 100.0;
        shifted.passage.elevation += 100.0;
        shifted.trial[1] += a.header_chart_mass * GRAVITY * 100.0;
        shifted.trial[5] += a.duct_chart_mass * GRAVITY * 100.0;
        let b = evaluate(shifted, 0.0).unwrap();
        close(
            b.rates[1] - a.rates[1],
            a.rates[0] * GRAVITY * 100.0,
            2e-13,
            1e-7,
        );
        close(
            b.rates[3] - a.rates[3],
            a.rates[2] * GRAVITY * 100.0,
            2e-13,
            1e-7,
        );
        close(a.entropy_production, b.entropy_production, 2e-9, 1e-8);
        close(a.residual[3], b.residual[3], 0.0, 1e-6);
        close(a.residual[8], b.residual[8], 0.0, 1e-6);
    }
    for index in 0..9 {
        let mut bad = input;
        bad.trial[index] = f64::NAN;
        assert!(evaluate(bad, 0.0).is_err());
        let mut bad = input;
        bad.derivative[index] = f64::INFINITY;
        assert!(evaluate(bad, 0.0).is_err());
    }
    let mut bad = input;
    bad.trial[0] = 0.0;
    assert!(evaluate(bad, 0.0).is_err());
    let mut bad = input;
    bad.trial[4] = -1.0;
    assert!(evaluate(bad, 0.0).is_err());
    let mut bad = input;
    bad.header_geometry.volume = 0.0;
    assert!(evaluate(bad, 0.0).is_err());
    let mut bad = input;
    bad.passage.elevation += 1.0;
    assert!(evaluate(bad, 0.0).is_err());
    assert!(evaluate(input, f64::NAN).is_err());
    assert!(evaluate(prepared(0.3e6, 300.0, 0.3e6, 300.0, 30.0), 0.0).is_err());
}

#[test]
fn equal_state_chart_and_momentum_retain_a_millisecond_acoustic_mode() {
    // ANALYTIC DIAGNOSTIC ONLY, not another trajectory or an operating-model
    // admission. Reconstruct the equal-state linear mode from the actual
    // residual matrix rather than installing an inferred time constant.
    let input = prepared(15.2e6, 313.15, 15.2e6, 313.15, 0.0);
    let result = evaluate(input, 0.0).unwrap();
    let liquid = water(input.trial[2], input.trial[3]);
    let transported_h = liquid.internal_energy
        + input.trial[2] / liquid.density
        + GRAVITY * input.header_geometry.elevation;
    let chart_pressure_per_mass = |mass_row: usize, energy_row: usize, p: usize, t: usize| {
        let mp = -result.jacobian[mass_row][p];
        let mt = -result.jacobian[mass_row][t];
        let ep = -result.jacobian[energy_row][p];
        let et = -result.jacobian[energy_row][t];
        let determinant = mp * et - mt * ep;
        assert!(determinant > 0.0 && determinant.is_finite());
        // dE=(h+gz)dM at rest is the actual common face-energy tangent.
        (et - mt * transported_h) / determinant
    };
    let header_dp_dm = chart_pressure_per_mass(2, 3, 2, 3);
    let duct_dp_dm = chart_pressure_per_mass(7, 8, 7, 8);
    let q_w = result.jacobian[0][6];
    let force_header_p = -result.jacobian[6][2];
    let force_duct_p = result.jacobian[6][7];
    close(result.jacobian[1][6] / q_w, transported_h, 2e-15, 1e-9);
    close(
        result.jacobian[5][6] / result.jacobian[4][6],
        transported_h,
        2e-15,
        1e-9,
    );
    let omega_squared = q_w * (force_header_p * header_dp_dm + force_duct_p * duct_dp_dm);
    let duct_volume = input.passage.area * input.passage.length;
    let expected = 3.0 * liquid.sound_speed.powi(2) / input.passage.length.powi(2)
        * (1.0 + duct_volume / input.header_geometry.volume);
    close(omega_squared, expected, 2e-12, 1e-6);
    let period = 2.0 * std::f64::consts::PI / omega_squared.sqrt();
    assert!(period > 0.001 && period < 0.0012);
    println!(
        "analytic_equal_state_acoustic_period_s={period:.12e},omega_squared={omega_squared:.12e},scope=local_linear_mode_not_trajectory_or_sound_filter"
    );
}

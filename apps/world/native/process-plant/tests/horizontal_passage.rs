use leitbild_plant_numerics::horizontal_passage::{
    Derivative, Face, ForceReceipts, Geometry, Input, Trial, evaluate,
};
use leitbild_plant_numerics::{GRAVITY, Liquid, LiquidQuery, liquid_batch};

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

fn face(pressure: f64, temperature: f64) -> Face {
    Face {
        donor_pressure: pressure,
        donor_temperature: temperature,
        traction_pressure: pressure,
    }
}

// Actual LD-01 RETURN equivalent geometry: two 0.70 m pump areas, 0.50 m
// horizontal developed length at +3 m. States below are algebraic tests, NOT
// original/reached LD-01 preparations or an advancing connected apparatus.
fn input(vl: f64, vr: f64) -> Input {
    let geometry = Geometry {
        area: 2.0 * std::f64::consts::PI * 0.70_f64.powi(2) / 4.0,
        length: 0.50,
        elevation: 3.0,
    };
    let bulk = water(15.2e6, 313.15);
    let mass = bulk.density * geometry.area * geometry.length;
    let kinetic = mass * (vl * vl + vl * vr + vr * vr) / 6.0;
    Input {
        geometry,
        trial: Trial {
            mass,
            energy: mass * (bulk.internal_energy + GRAVITY * geometry.elevation) + kinetic,
            momentum_left: mass * (2.0 * vl + vr) / 6.0,
            momentum_right: mass * (vl + 2.0 * vr) / 6.0,
            pressure: bulk.pressure,
            temperature: bulk.temperature,
        },
        derivative: Derivative::default(),
        left: face(15.23e6, 315.15),
        right: face(15.18e6, 310.15),
        force: ForceReceipts::default(),
    }
}

fn at_state(vl: f64, vr: f64, pressure: f64, temperature: f64) -> Input {
    let mut i = input(vl, vr);
    let bulk = water(pressure, temperature);
    let mass = bulk.density * i.geometry.area * i.geometry.length;
    i.trial = Trial {
        mass,
        energy: mass * (bulk.internal_energy + GRAVITY * i.geometry.elevation)
            + mass * (vl * vl + vl * vr + vr * vr) / 6.0,
        momentum_left: mass * (2.0 * vl + vr) / 6.0,
        momentum_right: mass * (vl + 2.0 * vr) / 6.0,
        pressure,
        temperature,
    };
    i.left = face(pressure + 300.0, temperature + 0.01);
    i.right = face(pressure - 300.0, temperature - 0.01);
    i
}

fn close(a: f64, b: f64, relative: f64, absolute: f64) {
    assert!(
        (a - b).abs() <= absolute + relative * a.abs().max(b.abs()),
        "{a:.17e} != {b:.17e}, difference={:.17e}",
        a - b
    );
}

#[test]
fn exact_changing_mass_kinetic_pressure_and_internal_work() {
    for (pressure, temperature) in [
        (101325.0, 290.0),
        (15.2e6, 313.15),
        (15.2e6, 450.0),
        (15.2e6, 600.0),
        (20.5e6, 640.0),
    ] {
        for (vl, vr) in [
            (2.0, 0.3),
            (-2.0, -0.3),
            (-1.0, 1.0),
            (1.0, -1.0),
            (0.0, 2.0),
            (-2.0, 0.0),
        ] {
            let mut i = at_state(vl, vr, pressure, temperature);
            // Test-only independently projected linear laminar traction, using the
            // actual uniform bulk viscosity and geometry (no implementation law).
            let bulk = water(i.trial.pressure, i.trial.temperature);
            let diameter = (4.0 * i.geometry.area / std::f64::consts::PI).sqrt();
            let scale =
                32.0 * bulk.viscosity * i.geometry.area * i.geometry.length / diameter.powi(2);
            i.force.left = -scale * (2.0 * vl + vr) / 6.0;
            i.force.right = -scale * (vl + 2.0 * vr) / 6.0;
            let e = evaluate(i, 0.0).unwrap();
            let [l, r] = e.velocities;
            let [ql, qr] = e.mass_flows;
            close(
                e.kinetic_energy,
                i.trial.mass * (l * l + l * r + r * r) / 6.0,
                2e-15,
                1e-12,
            );
            close(
                e.rates.momentum_left + e.rates.momentum_right,
                ql * l - qr * r
                    + i.geometry.area * (i.left.traction_pressure - i.right.traction_pressure)
                    + i.force.left
                    + i.force.right,
                2e-14,
                1e-10,
            );
            let independent_pressure = i.geometry.area
                * (i.left.traction_pressure * l
                    - i.right.traction_pressure * r
                    - i.trial.pressure * (l - r));
            let kdot = ql * l * l / 2.0 - qr * r * r / 2.0
                + independent_pressure
                + l * i.force.left
                + r * i.force.right;
            close(e.kinetic_rate, kdot, 3e-12, 2e-8);
            let left = water(i.left.donor_pressure, i.left.donor_temperature);
            let right = water(i.right.donor_pressure, i.right.donor_temperature);
            for (q, velocity, ht, face, p) in [
                (ql, l, e.total_enthalpies[0], left, i.left.traction_pressure),
                (
                    qr,
                    r,
                    e.total_enthalpies[1],
                    right,
                    i.right.traction_pressure,
                ),
            ] {
                close(
                    q * (ht
                        - face.internal_energy
                        - velocity * velocity / 2.0
                        - GRAVITY * i.geometry.elevation),
                    p * i.geometry.area * velocity,
                    2e-15,
                    2e-7,
                );
            }
            let udot = ql * left.internal_energy - qr * right.internal_energy
                + i.trial.pressure * i.geometry.area * (l - r)
                - l * i.force.left
                - r * i.force.right;
            close(e.internal_energy_rate, udot, 2e-13, 1e-7);
            assert!(e.passive_dissipation >= 0.0);
            let entropy = (ql * e.relative_availability[0] - qr * e.relative_availability[1]
                + e.passive_dissipation)
                / bulk.temperature;
            close(e.entropy_defect, entropy, 2e-9, 1e-8);
            // M is materially changing; this test must reject fixed-mass Kdot.
            assert!(e.rates.mass.abs() > 1.0);
            assert!(
                (e.kinetic_rate - (l * e.rates.momentum_left + r * e.rates.momentum_right)).abs()
                    > 1.0
            );
        }
    }
}

#[test]
fn zero_total_momentum_keeps_counterflow_energy_and_overpressure_response() {
    let mut i = input(0.0, 0.0);
    i.left = face(15.1e6, 313.15);
    i.right = i.left;
    let e = evaluate(i, 0.0).unwrap();
    assert_eq!(e.mass_flows, [0.0, 0.0]);
    close(
        e.rates.momentum_left,
        -i.geometry.area * 100000.0,
        0.0,
        1e-8,
    );
    close(
        e.rates.momentum_right,
        i.geometry.area * 100000.0,
        0.0,
        1e-8,
    );
    assert_eq!(e.rates.momentum_left + e.rates.momentum_right, 0.0);
    assert_eq!(e.rates.energy, 0.0);
    // A single common-flow P would miss this nonzero antisymmetric rate.
    let c = input(-1.0, 1.0);
    let e = evaluate(c, 0.0).unwrap();
    assert_eq!(c.trial.momentum_left + c.trial.momentum_right, 0.0);
    assert!(e.kinetic_energy > 0.0);
    let p = c.trial.momentum_left + c.trial.momentum_right;
    let dilation = c.trial.momentum_right - c.trial.momentum_left;
    close(
        e.kinetic_energy,
        (p * p + 3.0 * dilation * dilation) / (2.0 * c.trial.mass),
        2e-15,
        1e-12,
    );
    // Equal physical traces are a genuine horizontal rest invariant.
    i.left = face(i.trial.pressure, i.trial.temperature);
    i.right = i.left;
    let e = evaluate(i, 0.0).unwrap();
    assert_eq!(e.rates.mass, 0.0);
    assert_eq!(e.rates.energy, 0.0);
    assert_eq!(e.rates.momentum_left, 0.0);
    assert_eq!(e.rates.momentum_right, 0.0);
}

#[test]
fn elevation_datum_changes_only_stored_and_carried_potential_energy() {
    let i = input(1.3, -0.7);
    let a = evaluate(i, 0.0).unwrap();
    let mut shifted = i;
    shifted.geometry.elevation += 100.0;
    shifted.trial.energy += i.trial.mass * GRAVITY * 100.0;
    shifted.derivative.energy += a.rates.mass * GRAVITY * 100.0;
    let b = evaluate(shifted, 0.0).unwrap();
    close(
        b.chart_energy - a.chart_energy,
        i.trial.mass * GRAVITY * 100.0,
        2e-14,
        2e-8,
    );
    close(
        b.rates.energy - a.rates.energy,
        a.rates.mass * GRAVITY * 100.0,
        2e-13,
        1e-7,
    );
    close(a.residual[1], b.residual[1], 2e-13, 1e-7);
    close(a.residual[5], b.residual[5], 0.0, 2e-8);
    close(a.kinetic_rate, b.kinetic_rate, 0.0, 1e-12);
    close(a.internal_energy_rate, b.internal_energy_rate, 2e-13, 1e-7);
    close(a.entropy_defect, b.entropy_defect, 0.0, 1e-8);
}

fn perturb(mut i: Input, column: usize, delta: f64, cj: f64) -> Input {
    match column {
        0 => {
            i.trial.mass += delta;
            i.derivative.mass += cj * delta;
        }
        1 => {
            i.trial.energy += delta;
            i.derivative.energy += cj * delta;
        }
        2 => {
            i.trial.momentum_left += delta;
            i.derivative.momentum_left += cj * delta;
        }
        3 => {
            i.trial.momentum_right += delta;
            i.derivative.momentum_right += cj * delta;
        }
        4 => i.trial.pressure += delta,
        5 => i.trial.temperature += delta,
        6 => i.left.donor_pressure += delta,
        7 => i.left.donor_temperature += delta,
        8 => i.left.traction_pressure += delta,
        9 => i.right.donor_pressure += delta,
        10 => i.right.donor_temperature += delta,
        11 => i.right.traction_pressure += delta,
        _ => unreachable!(),
    }
    i
}

#[test]
fn analytic_native_and_face_jacobian_full_half_off_manifold() {
    for (pressure, temperature) in [
        (101325.0, 290.0),
        (15.2e6, 313.15),
        (15.2e6, 450.0),
        (15.2e6, 600.0),
        (20.5e6, 640.0),
    ] {
        for (vl, vr) in [(1.3, -0.7), (-0.8, 1.1), (0.0, 0.0)] {
            let mut i = at_state(vl, vr, pressure, temperature);
            // Deliberately off manifold: derivatives must use independent M in K
            // and velocities, not substitute rho*V in some consumers.
            i.trial.mass *= 1.02;
            i.trial.energy += 1234.0;
            let cj = 3.7;
            let analytic = evaluate(i, cj).unwrap().jacobian;
            let steps = [
                0.01, 10.0, 0.003, 0.003, 100.0, 0.001, 100.0, 0.001, 100.0, 100.0, 0.001, 100.0,
            ];
            for column in 0..12 {
                for fraction in [1.0, 0.5] {
                    let h = steps[column] * fraction;
                    let plus = evaluate(perturb(i, column, h, cj), cj).unwrap();
                    let minus = evaluate(perturb(i, column, -h, cj), cj).unwrap();
                    for row in 0..6 {
                        let measured = (plus.residual[row] - minus.residual[row]) / (2.0 * h);
                        let expected = analytic[row][column];
                        assert!(
                            (measured - expected).abs()
                                <= 1e-5 + 2e-5 * measured.abs().max(expected.abs()),
                            "p={pressure},T={temperature},vL={vl},vR={vr},row={row},column={column},h={h:.17e},measured={measured:.17e},analytic={expected:.17e},difference={:.17e}",
                            measured - expected
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn traction_uses_independent_pressure_and_reports_forward_potential_defect() {
    let mut i = at_state(0.0, 0.0, 20.5e6, 640.0);
    let e = evaluate(i, 0.0).unwrap();
    let states = [
        water(i.trial.pressure, i.trial.temperature),
        water(i.left.donor_pressure, i.left.donor_temperature),
        water(i.right.donor_pressure, i.right.donor_temperature),
    ];
    let given = [
        i.trial.pressure,
        i.left.donor_pressure,
        i.right.donor_pressure,
    ];
    for index in 0..3 {
        assert_eq!(
            e.forward_pressure_defects[index],
            states[index].pressure - given[index]
        );
    }
    // Pressure traction must be exactly temperature-independent even when the
    // dense-property pressure recovery changes its last-bit residual.
    for delta in [0.001, -0.001] {
        i.trial.temperature = 640.0 + delta;
        let changed = evaluate(i, 0.0).unwrap();
        assert_eq!(changed.rates.momentum_left, e.rates.momentum_left);
        assert_eq!(changed.rates.momentum_right, e.rates.momentum_right);
    }
}

#[test]
fn outgoing_face_entropy_defect_is_exposed_not_repaired() {
    let mut i = input(1.0, 1.0);
    i.left = face(i.trial.pressure, i.trial.temperature);
    // Construct an independently valid colder outlet EOS trace. This is NOT
    // an admitted physical donor map; its negative entropy defect must survive.
    i.right = face(i.trial.pressure, 303.15);
    let e = evaluate(i, 0.0).unwrap();
    assert!(e.relative_availability[1] > 0.0);
    assert!(e.entropy_defect < 0.0);
    assert_eq!(e.passive_dissipation, 0.0);
    close(
        e.rates.energy,
        e.mass_flows[0] * e.total_enthalpies[0] - e.mass_flows[1] * e.total_enthalpies[1],
        0.0,
        0.0,
    );
}

#[test]
fn isentropic_outlet_at_other_pressure_still_has_a_disclosed_projection_defect() {
    let mut i = input(1.0, 1.0);
    i.left = face(i.trial.pressure, i.trial.temperature);
    let bulk = water(i.trial.pressure, i.trial.temperature);
    let pressure = 14.0e6;
    let mut temperature = bulk.temperature;
    // TEST ONLY: finite forward-EOS Newton construction of an entropy-matched
    // face. This supplies no runtime donor map or property inverse.
    for _ in 0..12 {
        let face = water(pressure, temperature);
        temperature -= (face.entropy - bulk.entropy) * temperature / face.cp;
    }
    let face_water = water(pressure, temperature);
    close(face_water.entropy, bulk.entropy, 0.0, 1e-9);
    i.right = face(pressure, temperature);
    let e = evaluate(i, 0.0).unwrap();
    assert!(e.relative_availability[1] > 0.0);
    assert!(e.entropy_defect < 0.0);
    close(
        e.entropy_defect,
        -e.mass_flows[1] * e.relative_availability[1] / bulk.temperature,
        2e-7,
        1e-8,
    );
    close(
        e.rates.energy,
        e.mass_flows[0] * e.total_enthalpies[0] - e.mass_flows[1] * e.total_enthalpies[1],
        0.0,
        0.0,
    );
    assert_eq!(e.passive_dissipation, 0.0);
}

#[test]
fn explicit_geometry_stock_property_and_force_refusals() {
    let i = input(1.0, 0.3);
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let mut x = i;
        x.trial.mass = bad;
        assert!(evaluate(x, 0.0).is_err());
        let mut x = i;
        x.geometry.area = bad;
        assert!(evaluate(x, 0.0).is_err());
        let mut x = i;
        x.geometry.length = bad;
        assert!(evaluate(x, 0.0).is_err());
    }
    let mut x = i;
    x.force.left = f64::INFINITY;
    assert!(evaluate(x, 0.0).is_err());
    let mut x = i;
    x.force.left = 1.0;
    assert!(evaluate(x, 0.0).is_err());
    let mut x = i;
    x.trial.energy = f64::NAN;
    assert!(evaluate(x, 0.0).is_err());
    let mut x = i;
    x.left.donor_temperature = 700.0;
    let error = evaluate(x, 0.0).unwrap_err();
    assert_eq!(error.index, 1);
    let mut x = i;
    x.right.donor_pressure = -1.0;
    let error = evaluate(x, 0.0).unwrap_err();
    assert_eq!(error.index, 2);
    assert!(evaluate(i, f64::NAN).is_err());
    // Legitimate projected cross force: left endpoint receives mechanical
    // power, but total stationary force work remains strictly dissipative.
    let mut x = i;
    x.force = ForceReceipts {
        left: 1.0,
        right: -10.0,
    };
    assert!(evaluate(x, 0.0).unwrap().passive_dissipation > 0.0);
}

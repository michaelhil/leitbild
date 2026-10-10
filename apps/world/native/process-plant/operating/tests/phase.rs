use leitbild_operating_plant::phase::{self, Point, Stock};
use leitbild_operating_plant::thermal::Scalar;

// Explicit simple constitutive fixture only. Actual maintained IF97 chart and
// derivative tests live in the opt-in water-ffi package.
fn liquid() -> Point {
    Point {
        pressure_pa: 6e6,
        temperature_k: 550.,
        density_kg_m3: 750.,
        internal_energy_j_kg: 1.2e6,
        enthalpy_j_kg: 1.208e6,
        density_pressure: 3e-6,
        density_temperature: -2.,
        energy_pressure: -0.001,
        energy_temperature: 5000.,
    }
}
fn gas() -> Point {
    Point {
        density_kg_m3: 30.,
        internal_energy_j_kg: 2.5e6,
        enthalpy_j_kg: 2.7e6,
        density_pressure: 4e-6,
        density_temperature: -0.08,
        energy_pressure: -0.002,
        energy_temperature: 2500.,
        ..liquid()
    }
}
fn stock(v: f64, p: Point) -> Stock {
    Stock {
        mass_kg: v * p.density_kg_m3,
        internal_energy_j: v * p.density_kg_m3 * p.internal_energy_j_kg,
    }
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.),
        "{a} != {b}"
    );
}

#[test]
fn separated_stocks_and_absent_phase_are_different_charts() {
    let l = stock(6., liquid());
    let g = stock(4., gas());
    let q = phase::separated_constraints(10., 6., l, g, liquid(), gas()).unwrap();
    for r in q.residual {
        close(r, 0.);
    }
    phase::validate_separated_accepted(10., 6., l, g).unwrap();
    assert!(phase::validate_separated_accepted(10., 10., l, Stock::default()).is_err());
    let s = stock(10., liquid());
    let (r, j) = phase::single_constraints(10., s, liquid()).unwrap();
    for v in r {
        close(v, 0.);
    }
    assert_ne!(j[0][0] * j[1][1] - j[0][1] * j[1][0], 0.);
    phase::validate_single_accepted(s, Stock::default()).unwrap();
    assert!(
        phase::validate_single_accepted(
            s,
            Stock {
                mass_kg: 0.,
                internal_energy_j: 1.
            }
        )
        .is_err()
    );
}

#[test]
fn signed_newton_trials_are_not_physical_acceptance() {
    let l = Stock {
        mass_kg: -1.,
        internal_energy_j: -2e6,
    };
    let g = stock(4., gas());
    phase::separated_constraints(10., -1., l, g, liquid(), gas()).unwrap();
    assert!(phase::validate_separated_accepted(10., -1., l, g).is_err());
    phase::single_constraints(10., l, liquid()).unwrap();
    assert!(phase::validate_single_accepted(l, Stock::default()).is_err());
}

#[test]
fn local_stefan_mass_energy_and_pressure_work_are_reciprocal() {
    for (ql, qg) in [(1e6, 2e5), (-1e6, -2e5), (0., 0.), (1e6, -1e6)] {
        let e = phase::interphase(ql, qg, 1.2e6, 2.7e6).unwrap();
        close(e.liquid_mass_kg_s + e.vapor_mass_kg_s, 0.);
        close(e.liquid_energy_w + e.vapor_energy_w, 0.);
        // Independent local phase equations—not just a global cancelling sum.
        close(e.liquid_energy_w + e.vapor_mass_kg_s * 1.2e6, -ql);
        close(e.vapor_energy_w - e.vapor_mass_kg_s * 2.7e6, -qg);
        let work = phase::phase_volume_work(6e6, -0.03).unwrap();
        close(work[0] + work[1], 0.);
        close(work[0], 180000.);
    }
}

#[test]
fn stefan_tangent_includes_both_endpoint_enthalpies() {
    let x = [1e6, -2e5, 1.2e6, 2.7e6];
    let d = [-3e5, 1e5, 2000., -4000.];
    let analytic = phase::interphase_direction(x[0], x[1], x[2], x[3], d).unwrap();
    let probe = |s: f64| {
        phase::interphase(
            x[0] + s * d[0],
            x[1] + s * d[1],
            x[2] + s * d[2],
            x[3] + s * d[3],
        )
        .unwrap()
    };
    let a = probe(1e-4);
    let b = probe(-1e-4);
    for (actual, numeric) in [
        (
            analytic.liquid_mass_kg_s,
            (a.liquid_mass_kg_s - b.liquid_mass_kg_s) / 2e-4,
        ),
        (
            analytic.vapor_energy_w,
            (a.vapor_energy_w - b.vapor_energy_w) / 2e-4,
        ),
    ] {
        assert!((actual - numeric).abs() < 1e-6 * actual.abs());
    }
    assert!(phase::interphase_direction(1e6, 1e6, 1e6, 2e6, [0., 0., f64::MAX, 0.]).is_err());
}

#[test]
fn sg_endpoint_rates_come_from_own_finite_mass_energy() {
    for vl in [0., 6., 10.] {
        let c = phase::equilibrium_chart(10., vl, liquid(), gas(), 1e-5).unwrap();
        let [pd, vd] = c.rates(-0.4, 1e6).unwrap();
        let [mp, mv, ep, ev] = c.derivative;
        close(mp * pd + mv * vd, -0.4);
        close(ep * pd + ev * vd, 1e6);
    }
    assert!(phase::equilibrium_chart(10., 10.001, liquid(), gas(), 1e-5).is_err());
    let bad = Point {
        pressure_pa: 6e6 + 1.,
        ..gas()
    };
    assert!(
        phase::separated_constraints(10., 6., stock(6., liquid()), stock(4., bad), liquid(), bad)
            .is_err()
    );
    assert!(phase::interphase(1., 1., 10., 10.).is_err());
    assert!(phase::phase_volume_work(f64::NAN, 1.).is_err());
}

// Independent small dense solve of the differentiated constraint rows, used
// only as a test oracle for the locally eliminated production formula.
fn solve<const N: usize>(mut a: [[f64; N]; N], mut b: [f64; N]) -> [f64; N] {
    for k in 0..N {
        let pivot = (k..N)
            .max_by(|&i, &j| a[i][k].abs().total_cmp(&a[j][k].abs()))
            .unwrap();
        a.swap(k, pivot);
        b.swap(k, pivot);
        assert_ne!(a[k][k], 0.);
        let pivot_row = a[k];
        for i in k + 1..N {
            let scale = a[i][k] / a[k][k];
            for (value, pivot_value) in a[i][k..].iter_mut().zip(&pivot_row[k..]) {
                *value -= scale * pivot_value;
            }
            b[i] -= scale * b[k];
        }
    }
    let mut x = [0.; N];
    for i in (0..N).rev() {
        x[i] = (b[i] - (i + 1..N).map(|j| a[i][j] * x[j]).sum::<f64>()) / a[i][i];
    }
    x
}

#[test]
fn separated_rates_differentiate_each_constraint_and_cancel_phase_work() {
    let lp = liquid();
    let gp = Point {
        temperature_k: 590.,
        ..gas()
    };
    let l = stock(6., lp);
    let g = stock(4., gp);
    let c = phase::separated_constraints(10., 6., l, g, lp, gp).unwrap();
    for (mass, heat) in [
        ([0.3, -0.1], [2e6, -4e5]),
        ([-0.7, 0.7], [-9e5, 9e5]),
        ([0., 0.], [-2e4, 5e3]),
        ([0., 0.], [0., 0.]),
    ] {
        let r = phase::present_rates(10., [Some(l), Some(g)], [Some(lp), Some(gp)], mass, heat)
            .unwrap();
        let mut a = c.algebraic_jacobian;
        a[0][3] = -lp.pressure_pa;
        a[1][3] = lp.pressure_pa;
        let raw = [mass[0], heat[0], mass[1], heat[1]];
        let b = std::array::from_fn(|i| {
            -c.stock_jacobian[i]
                .iter()
                .zip(raw)
                .map(|(a, b)| a * b)
                .sum::<f64>()
        });
        let independent = solve(a, b);
        for (actual, expected) in [
            r.pressure_rate_pa_s,
            r.temperature_rate_k_s[0].unwrap(),
            r.temperature_rate_k_s[1].unwrap(),
            r.volume_rate_m3_s[0],
        ]
        .into_iter()
        .zip(independent)
        {
            close(actual, expected);
        }
        close(r.volume_rate_m3_s[0] + r.volume_rate_m3_s[1], 0.);
        let energy_balance =
            r.internal_energy_rate_w.iter().sum::<f64>() - heat.iter().sum::<f64>();
        let energy_scale = r
            .internal_energy_rate_w
            .iter()
            .chain(heat.iter())
            .map(|v| v.abs())
            .sum::<f64>()
            .max(1.);
        assert!(energy_balance.abs() <= 1e-12 * energy_scale);
        for i in 0..2 {
            close(
                r.internal_energy_rate_w[i] - heat[i],
                -lp.pressure_pa * r.volume_rate_m3_s[i],
            );
            let s = [l, g][i];
            let p = [lp, gp][i];
            close(
                r.internal_energy_rate_w[i],
                mass[i] * p.internal_energy_j_kg
                    + s.mass_kg
                        * (p.energy_pressure * r.pressure_rate_pa_s
                            + p.energy_temperature * r.temperature_rate_k_s[i].unwrap()),
            );
        }
    }
}

#[test]
fn pure_rates_have_no_absent_temperature_or_spurious_volume_work() {
    for (i, p) in [liquid(), gas()].into_iter().enumerate() {
        let s = stock(10., p);
        let mut stocks = [None; 2];
        let mut points = [None; 2];
        let mut mass = [0.; 2];
        let mut heat = [0.; 2];
        stocks[i] = Some(s);
        points[i] = Some(p);
        mass[i] = -0.3;
        heat[i] = 5e5;
        let r = phase::present_rates(10., stocks, points, mass, heat).unwrap();
        let (_, j) = phase::single_constraints(10., s, p).unwrap();
        let independent = solve(
            j,
            [
                mass[i] * p.internal_energy_j_kg - heat[i],
                mass[i] / p.density_kg_m3,
            ],
        );
        close(r.pressure_rate_pa_s, independent[0]);
        close(r.temperature_rate_k_s[i].unwrap(), independent[1]);
        close(r.volume_rate_m3_s[i], 0.);
        close(r.internal_energy_rate_w[i], heat[i]);
        assert!(r.temperature_rate_k_s[1 - i].is_none());
        assert_eq!(r.volume_rate_m3_s[1 - i], 0.);
        assert_eq!(r.internal_energy_rate_w[1 - i], 0.);
    }
}

#[test]
fn local_rate_chart_does_not_seed_birth_or_clip_newton_trials() {
    let p = liquid();
    let s = stock(10., p);
    let run =
        |s, p, mass, heat| phase::present_rates(10., [Some(s), None], [Some(p), None], mass, heat);
    run(s, p, [0., 0.], [0., 0.]).unwrap();
    // A signed/incoherent Newton trial is not modified into an accepted stock.
    run(
        Stock {
            mass_kg: -s.mass_kg,
            internal_energy_j: -1.,
        },
        p,
        [0.1, 0.],
        [1e5, 0.],
    )
    .unwrap();
    assert!(run(s, p, [0., 0.1], [0., 1e5]).is_err());
    assert!(run(s, p, [0., 0.], [0., 1.]).is_err());
    assert!(run(Stock::default(), p, [0., 0.], [0., 0.]).is_err());
    assert!(phase::present_rates(10., [None; 2], [None; 2], [0.; 2], [0.; 2]).is_err());
    assert!(phase::present_rates(10., [Some(s), None], [None; 2], [0.; 2], [0.; 2]).is_err());
    assert!(run(s, p, [f64::NAN, 0.], [0.; 2]).is_err());
    assert!(run(s, p, [0.; 2], [f64::INFINITY, 0.]).is_err());
    assert!(
        run(
            s,
            Point {
                density_pressure: 0.,
                density_temperature: 0.,
                ..p
            },
            [0.; 2],
            [1., 0.],
        )
        .is_err()
    );
    assert!(
        run(
            s,
            Point {
                energy_temperature: p.pressure_pa * p.density_temperature / p.density_kg_m3.powi(2),
                ..p
            },
            [0.; 2],
            [0.; 2],
        )
        .is_err()
    );
    let other = Point {
        pressure_pa: p.pressure_pa + 1.,
        ..gas()
    };
    assert!(
        phase::present_rates(
            10.,
            [Some(s), Some(stock(1., other))],
            [Some(p), Some(other)],
            [0.; 2],
            [0.; 2],
        )
        .is_err()
    );
}

#[test]
fn exact_birth_volume_drives_existing_phase_pressure_and_reciprocal_work() {
    let lp = liquid();
    let gp = gas();
    let l = stock(10., lp);
    let mass = [-0.1, 0.2];
    // Actual transported enthalpy, not a saturation/temperature default.
    let heat = [mass[0] * lp.enthalpy_j_kg, mass[1] * gp.enthalpy_j_kg];
    let r = phase::rates_with_birth(
        10.,
        [Some(l), Some(Stock::default())],
        [Some(lp), Some(gp)],
        mass,
        heat,
    )
    .unwrap();
    let born_volume = mass[1] / gp.density_kg_m3;
    let existing_energy = heat[0] + lp.pressure_pa * born_volume;
    let (_, j) = phase::single_constraints(10., l, lp).unwrap();
    let independent = solve(
        j,
        [
            mass[0] * lp.internal_energy_j_kg - existing_energy,
            mass[0] / lp.density_kg_m3 + born_volume,
        ],
    );
    close(r.pressure_rate_pa_s, independent[0]);
    close(r.temperature_rate_k_s[0].unwrap(), independent[1]);
    assert!(r.temperature_rate_k_s[1].is_none());
    close(r.volume_rate_m3_s[0], -born_volume);
    close(r.volume_rate_m3_s[1], born_volume);
    close(r.internal_energy_rate_w[0], existing_energy);
    close(
        r.internal_energy_rate_w[1],
        mass[1] * gp.internal_energy_j_kg,
    );
    close(r.internal_energy_rate_w.iter().sum(), heat.iter().sum());
    // At exactly zero onset, the responsible receipt fixes newborn T but
    // supplies zero present-value M/U/V rates; no fictitious seed appears.
    let onset = phase::rates_with_birth(
        10.,
        [Some(l), Some(Stock::default())],
        [Some(lp), Some(gp)],
        [0.; 2],
        [0.; 2],
    )
    .unwrap();
    close(onset.pressure_rate_pa_s, 0.);
    assert_eq!(onset.volume_rate_m3_s, [0.; 2]);
    assert_eq!(onset.internal_energy_rate_w, [0.; 2]);
    assert!(onset.temperature_rate_k_s[1].is_none());
}

#[test]
fn birth_rates_leave_caloric_row_defects_to_the_actual_newton_row() {
    let lp = liquid();
    let gp = gas();
    let mass = [0., 0.1];
    // Deliberate current Newton caloric-row defect: not accepted/coherent.
    let heat = [0., mass[1] * (gp.enthalpy_j_kg + 2000.)];
    let r = phase::rates_with_birth(
        10.,
        [Some(stock(10., lp)), Some(Stock::default())],
        [Some(lp), Some(gp)],
        mass,
        heat,
    )
    .unwrap();
    close(
        r.internal_energy_rate_w[1] - mass[1] * gp.internal_energy_j_kg,
        mass[1] * 2000.,
    );
    // No alternate caloric convention or silent correction hides the defect.
    close(r.internal_energy_rate_w.iter().sum(), heat.iter().sum());
}

#[test]
fn exact_birth_rejects_withdrawal_and_unowned_heat_but_not_newton_energy_probes() {
    let l = stock(10., liquid());
    let run = |born, mass, heat| {
        phase::rates_with_birth(
            10.,
            [Some(l), Some(born)],
            [Some(liquid()), Some(gas())],
            mass,
            heat,
        )
    };
    assert!(run(Stock::default(), [0., -0.1], [0., -2.7e5]).is_err());
    assert!(run(Stock::default(), [0.; 2], [0., 1.]).is_err());
    let base = run(Stock::default(), [0.; 2], [0.; 2]).unwrap();
    for internal_energy_j in [-1., 1.] {
        let trial = Stock {
            mass_kg: 0.,
            internal_energy_j,
        };
        let rates = run(trial, [0.; 2], [0.; 2]).unwrap();
        assert_eq!(rates.pressure_rate_pa_s, base.pressure_rate_pa_s);
        assert_eq!(rates.internal_energy_rate_w, base.internal_energy_rate_w);
        // Evaluation neither changes the trial nor admits it as an absent
        // physical stock. Existing accepted-state validation remains strict.
        assert_eq!(trial.internal_energy_j, internal_energy_j);
        assert!(phase::validate_single_accepted(l, trial).is_err());
    }
    assert!(
        phase::rates_with_birth(
            10.,
            [Some(Stock::default()); 2],
            [Some(liquid()), Some(gas())],
            [0.1; 2],
            [1e5; 2],
        )
        .is_err()
    );
}

#[test]
fn nonzero_stocks_use_the_same_finite_caloric_chart_in_both_entry_points() {
    let points = [Some(liquid()), Some(gas())];
    let stocks = [Some(stock(6., liquid())), Some(stock(4., gas()))];
    let mass = [0.2, -0.1];
    let heat = [3e5, -2e5];
    let a = phase::present_rates(10., stocks, points, mass, heat).unwrap();
    let b = phase::rates_with_birth(10., stocks, points, mass, heat).unwrap();
    assert_eq!(a.pressure_rate_pa_s, b.pressure_rate_pa_s);
    assert_eq!(a.temperature_rate_k_s, b.temperature_rate_k_s);
    assert_eq!(a.volume_rate_m3_s, b.volume_rate_m3_s);
    assert_eq!(a.internal_energy_rate_w, b.internal_energy_rate_w);
}

fn scalar_phase(mass: f64, p: Point) -> phase::ScalarRatePhase {
    phase::ScalarRatePhase {
        mass: Scalar::constant(mass),
        density: Scalar::constant(p.density_kg_m3),
        specific_u: Scalar::constant(p.internal_energy_j_kg),
        rho_p: Scalar::constant(p.density_pressure),
        rho_t: Scalar::constant(p.density_temperature),
        u_p: Scalar::constant(p.energy_pressure),
        u_t: Scalar::constant(p.energy_temperature),
    }
}

fn compare_current_values(actual: phase::ScalarPhaseRates, expected: phase::PhaseRates) {
    close(actual.pressure_rate_pa_s.value, expected.pressure_rate_pa_s);
    for i in 0..2 {
        close(
            actual.volume_rate_m3_s[i].value,
            expected.volume_rate_m3_s[i],
        );
        close(
            actual.internal_energy_rate_w[i].value,
            expected.internal_energy_rate_w[i],
        );
    }
}

#[test]
fn mass_cancelled_current_rates_match_independently_differentiated_finite_charts() {
    let l = stock(6., liquid());
    let g = stock(4., gas());
    for (stocks, points) in [
        ([Some(l), Some(g)], [Some(liquid()), Some(gas())]),
        ([Some(l), None], [Some(liquid()), None]),
        ([None, Some(g)], [None, Some(gas())]),
    ] {
        let phases =
            std::array::from_fn(|i| stocks[i].map(|s| scalar_phase(s.mass_kg, points[i].unwrap())));
        let mass = std::array::from_fn(|i| if stocks[i].is_some() { -0.2 } else { 0. });
        let heat = std::array::from_fn(|i| if stocks[i].is_some() { 3e5 } else { 0. });
        let expected = phase::present_rates(10., stocks, points, mass, heat).unwrap();
        let actual = phase::current_rates(
            Scalar::constant(6e6),
            phases,
            mass.map(Scalar::constant),
            heat.map(Scalar::constant),
        )
        .unwrap();
        compare_current_values(actual, expected);
        close(actual.pressure_rate_pa_s.direction, 0.);
    }
}

#[test]
fn mass_cancelled_exact_birth_agrees_on_actual_receipt_row_without_seed() {
    let l = stock(10., liquid());
    let mass = [-0.1, 0.2];
    let heat = [
        mass[0] * liquid().enthalpy_j_kg,
        mass[1] * gas().enthalpy_j_kg,
    ];
    let expected = phase::rates_with_birth(
        10.,
        [Some(l), Some(Stock::default())],
        [Some(liquid()), Some(gas())],
        mass,
        heat,
    )
    .unwrap();
    let phases = [
        Some(scalar_phase(l.mass_kg, liquid())),
        Some(scalar_phase(0., gas())),
    ];
    let actual = phase::current_rates(
        Scalar::constant(6e6),
        phases,
        mass.map(Scalar::constant),
        heat.map(Scalar::constant),
    )
    .unwrap();
    compare_current_values(actual, expected);
    assert_eq!(phases[1].unwrap().mass.value, 0.);
    close(
        actual.volume_rate_m3_s[1].value,
        mass[1] / gas().density_kg_m3,
    );
    close(
        actual.internal_energy_rate_w.iter().map(|x| x.value).sum(),
        heat.iter().sum(),
    );
}

// Shift every supplied current coefficient independently. This oracle uses
// the original finite-mass caloric/volume elimination, not the cancelled law.
fn shifted_reference(
    step: f64,
    pressure: Scalar,
    phases: [phase::ScalarRatePhase; 2],
    mass: [Scalar; 2],
    heat: [Scalar; 2],
) -> phase::PhaseRates {
    let shift = |x: Scalar| x.value + step * x.direction;
    let p = shift(pressure);
    let points = phases.map(|s| Point {
        pressure_pa: p,
        temperature_k: 550.,
        density_kg_m3: shift(s.density),
        internal_energy_j_kg: shift(s.specific_u),
        enthalpy_j_kg: shift(s.specific_u) + p / shift(s.density),
        density_pressure: shift(s.rho_p),
        density_temperature: shift(s.rho_t),
        energy_pressure: shift(s.u_p),
        energy_temperature: shift(s.u_t),
    });
    let stocks = std::array::from_fn(|i| {
        Some(Stock {
            mass_kg: shift(phases[i].mass),
            internal_energy_j: shift(phases[i].mass) * points[i].internal_energy_j_kg,
        })
    });
    phase::present_rates(
        10.,
        stocks,
        points.map(Some),
        mass.map(shift),
        heat.map(shift),
    )
    .unwrap()
}

#[test]
fn current_rate_jvp_includes_all_properties_receipts_and_crosses_zero_mass_analytically() {
    let mut l = scalar_phase(stock(6., liquid()).mass_kg, liquid());
    l.mass.direction = -2.;
    l.density.direction = -3.;
    l.specific_u.direction = 1700.;
    l.rho_p.direction = 2e-8;
    l.rho_t.direction = 0.03;
    l.u_p.direction = 2e-5;
    l.u_t.direction = -40.;
    let mut g = scalar_phase(stock(4., gas()).mass_kg, gas());
    g.mass.direction = 0.4;
    g.density.direction = 0.6;
    g.specific_u.direction = -2500.;
    g.rho_p.direction = -3e-8;
    g.rho_t.direction = -0.004;
    g.u_p.direction = -3e-5;
    g.u_t.direction = 25.;
    let pressure = Scalar::new(6e6, 4e4);
    let mass = [Scalar::new(-0.1, 0.03), Scalar::new(0.2, -0.02)];
    let heat = [
        Scalar::new(-0.1 * liquid().enthalpy_j_kg, 2700.),
        Scalar::new(0.2 * gas().enthalpy_j_kg, -1300.),
    ];
    for gas_mass in [stock(4., gas()).mass_kg, 0., -1.] {
        g.mass.value = gas_mass;
        let phases = [l, g];
        let actual = phase::current_rates(pressure, phases.map(Some), mass, heat).unwrap();
        let step = 1e-4;
        let plus = shifted_reference(step, pressure, phases, mass, heat);
        let minus = shifted_reference(-step, pressure, phases, mass, heat);
        let mut directions = vec![(
            actual.pressure_rate_pa_s.direction,
            (plus.pressure_rate_pa_s - minus.pressure_rate_pa_s) / (2. * step),
        )];
        for i in 0..2 {
            directions.push((
                actual.volume_rate_m3_s[i].direction,
                (plus.volume_rate_m3_s[i] - minus.volume_rate_m3_s[i]) / (2. * step),
            ));
            directions.push((
                actual.internal_energy_rate_w[i].direction,
                (plus.internal_energy_rate_w[i] - minus.internal_energy_rate_w[i]) / (2. * step),
            ));
        }
        for (exact, numeric) in directions {
            assert!(
                (exact - numeric).abs() <= 2e-7 * exact.abs().max(numeric.abs()).max(1.),
                "mass={gas_mass}: {exact} != {numeric}"
            );
        }
        close(
            actual.volume_rate_m3_s.iter().map(|x| x.direction).sum(),
            0.,
        );
        close(
            actual
                .internal_energy_rate_w
                .iter()
                .map(|x| x.direction)
                .sum(),
            heat.iter().map(|x| x.direction).sum(),
        );
    }
}

#[test]
fn zero_mass_current_extension_does_not_hide_receipt_row_defect() {
    let mass = [Scalar::constant(0.), Scalar::constant(0.1)];
    let heat = [Scalar::constant(0.), Scalar::constant(0.1 * 2.702e6)];
    let phases = [
        scalar_phase(stock(10., liquid()).mass_kg, liquid()),
        scalar_phase(0., gas()),
    ];
    let actual = phase::current_rates(Scalar::constant(6e6), phases.map(Some), mass, heat).unwrap();
    let signed_probe = [
        phases[0],
        phase::ScalarRatePhase {
            mass: Scalar::new(0., 1.),
            ..phases[1]
        },
    ];
    let plus = shifted_reference(1e-5, Scalar::constant(6e6), signed_probe, mass, heat);
    let minus = shifted_reference(-1e-5, Scalar::constant(6e6), signed_probe, mass, heat);
    // This is the finite-stock residual extension, not physical birth V'=M'/rho.
    assert_ne!(actual.volume_rate_m3_s[1].value, 0.1 / gas().density_kg_m3);
    close(
        actual.volume_rate_m3_s[1].value,
        (plus.volume_rate_m3_s[1] + minus.volume_rate_m3_s[1]) / 2.,
    );
    close(
        actual.internal_energy_rate_w.iter().map(|x| x.value).sum(),
        heat.iter().map(|x| x.value).sum(),
    );
}

#[test]
fn current_rates_reject_missing_phase_directions_nonfinite_and_singular_properties() {
    let pressure = Scalar::constant(6e6);
    let zero = Scalar::constant(0.);
    let p = scalar_phase(7500., liquid());
    let run = |pressure, p, mass, heat| phase::current_rates(pressure, [Some(p), None], mass, heat);
    run(pressure, p, [zero; 2], [zero; 2]).unwrap();
    assert!(run(pressure, p, [zero, Scalar::new(0., 1.)], [zero; 2]).is_err());
    assert!(run(pressure, p, [zero; 2], [zero, Scalar::new(0., 1.)]).is_err());
    assert!(run(Scalar::new(6e6, f64::NAN), p, [zero; 2], [zero; 2]).is_err());
    for bad in [
        phase::ScalarRatePhase { density: zero, ..p },
        phase::ScalarRatePhase {
            mass: Scalar::new(7500., f64::INFINITY),
            ..p
        },
        phase::ScalarRatePhase {
            u_p: Scalar::new(-0.001, f64::NAN),
            ..p
        },
        phase::ScalarRatePhase {
            rho_p: zero,
            rho_t: zero,
            ..p
        },
        phase::ScalarRatePhase {
            u_t: pressure * p.rho_t / (p.density * p.density),
            ..p
        },
        phase::ScalarRatePhase { mass: zero, ..p },
    ] {
        assert!(run(pressure, bad, [zero; 2], [zero; 2]).is_err());
    }
    assert!(phase::current_rates(pressure, [None; 2], [zero; 2], [zero; 2]).is_err());
}

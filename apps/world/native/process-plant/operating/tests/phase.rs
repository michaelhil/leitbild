use leitbild_operating_plant::phase::{self, Point, Stock};

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

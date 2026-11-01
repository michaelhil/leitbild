//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#sbtl-water-properties
//! The SBTL water method through the public boundary (owner decision 1 Nov
//! 2026): this test process selects SBTL once. Its directions are the
//! analytic derivatives of the very functions it evaluates (checked against
//! centred differences of those functions), its caloric inverse recovers its
//! own forward points to round-off, the reference's branch, band and domain
//! refusals hold, and a different second selection refuses. The deviations
//! from the IF97 reference are the water build's own check (its receipt).
use leitbild_operating_water::{
    Branch, CaloricLinearization, Error, WaterMethod, WaterPoint, directional, point, point_ph,
    point_pu, select_water_method, water_method,
};

fn sbtl() {
    select_water_method(WaterMethod::Sbtl).unwrap();
    assert_eq!(water_method(), WaterMethod::Sbtl);
}

fn fields(q: &WaterPoint) -> [f64; 8] {
    [
        q.density_kg_m3,
        q.internal_energy_j_kg,
        q.enthalpy_j_kg,
        q.cp_j_kg_k,
        q.expansion_per_k,
        q.compressibility_per_pa,
        q.viscosity_pa_s,
        q.conductivity_w_m_k,
    ]
}

/// States across both branches: near the 0.1 MPa operating floor, operating, the band's
/// metastable sides, and region 3 near saturation above 16.529 MPa.
fn states() -> Vec<(Branch, f64, f64)> {
    let ts = |p: f64| point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k;
    vec![
        (Branch::Liquid, 1.2e5, 300.),
        (Branch::Liquid, 7e6, 500.),
        (Branch::Liquid, 15.5e6, 580.),
        (Branch::Liquid, 15.5e6, ts(15.5e6) + 1.),
        (Branch::Liquid, 18e6, 624.),
        (Branch::Liquid, 19.7e6, ts(19.7e6) - 0.2),
        (Branch::Vapor, 1.2e5, 400.),
        (Branch::Vapor, 6.5e6, 560.),
        (Branch::Vapor, 6.5e6, ts(6.5e6) - 1.),
        (Branch::Vapor, 18e6, ts(18e6) + 0.5),
        (Branch::Vapor, 19.7e6, 700.),
    ]
}

#[test]
fn sbtl_directions_are_the_derivatives_of_its_own_values() {
    sbtl();
    for (branch, p, t) in states() {
        for (dp, dt) in [(1., 0.), (0., 1.)] {
            let (q, d) = directional(branch, p, t, dp, dt).unwrap();
            assert!(q.cv_j_kg_k.is_nan(), "cv is not tabulated");
            // A centred difference of the evaluated splines, inside one cell.
            let h = if dp != 0. { p * 1e-7 } else { 1e-5 };
            let a = point(branch, p + h * dp, t + h * dt).unwrap();
            let b = point(branch, p - h * dp, t - h * dt).unwrap();
            for ((x, y), (z, v)) in fields(&a)
                .iter()
                .zip(fields(&b))
                .zip(fields(&d).iter().zip(fields(&q)))
            {
                let fd = (x - y) / (2. * h);
                assert!(
                    // Truncation is far below 1e-6 inside a cell; the rest is
                    // the values' rounding over 2h.
                    (fd - z).abs() <= 1e-6 * z.abs() + 1e-13 * v.abs() / h,
                    "{branch:?} {p} {t} ({dp},{dt}): fd {fd} vs analytic {z}"
                );
            }
        }
    }
}

#[test]
fn sbtl_caloric_inverse_recovers_its_points_and_its_directions_are_implicit() {
    sbtl();
    for (branch, p, t) in states() {
        let q = point(branch, p, t).unwrap();
        for enthalpy in [false, true] {
            let target = if enthalpy {
                q.enthalpy_j_kg
            } else {
                q.internal_energy_j_kg
            };
            let r = if enthalpy {
                point_ph(branch, p, target)
            } else {
                point_pu(branch, p, target)
            }
            .unwrap();
            assert!(
                (r.temperature_k - t).abs() <= 1e-9 * t,
                "{branch:?} {p} {t}"
            );
            let c = if enthalpy {
                CaloricLinearization::enthalpy(branch, p, target)
            } else {
                CaloricLinearization::internal_energy(branch, p, target)
            }
            .unwrap();
            // Along (0, dtarget): dT = dtarget / t_T, so the target moves by dtarget.
            let d = c.directional(0., 1.).unwrap();
            let moved = if enthalpy {
                d.enthalpy_j_kg
            } else {
                d.internal_energy_j_kg
            };
            assert!((moved - 1.).abs() <= 1e-9, "{branch:?} {p} {t}: {moved}");
            // Along (dp, 0): the target is held.
            let d = c.directional(1., 0.).unwrap();
            let held = if enthalpy {
                d.enthalpy_j_kg
            } else {
                d.internal_energy_j_kg
            };
            assert!(
                held.abs() <= 1e-8 / q.density_kg_m3,
                "{branch:?} {p} {t}: {held}"
            );
            let [dt, ..] = c.exact_directional(0., 1.).unwrap();
            assert_eq!(dt, c.directional(0., 1.).unwrap().temperature_k);
        }
    }
}

#[test]
fn sbtl_keeps_the_reference_refusals() {
    sbtl();
    let ts = |p: f64| point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k;
    // Above the band's top pressure only stable states; beyond the ceilings none.
    assert_eq!(
        point(Branch::Liquid, 18e6, ts(18e6) + 0.1).unwrap_err(),
        Error::TrialBand
    );
    assert_eq!(
        point(Branch::Vapor, 18e6, ts(18e6) - 0.1).unwrap_err(),
        Error::TrialBand
    );
    assert_eq!(
        point(Branch::Liquid, 20e6f64.next_up(), 600.).unwrap_err(),
        Error::Domain
    );
    assert_eq!(
        point(Branch::Vapor, 20e6f64.next_up(), 700.).unwrap_err(),
        Error::Domain
    );
    // The band's trial end, by value and through the inverse.
    let p = 10e6;
    let top = point(Branch::Liquid, p, ts(p) + 3.).unwrap();
    assert_eq!(
        point(Branch::Liquid, p, ts(p) + 3.01).unwrap_err(),
        Error::TrialBand
    );
    assert_eq!(
        point_pu(Branch::Liquid, p, top.internal_energy_j_kg + 1.).unwrap_err(),
        Error::TrialBand
    );
    // Below region 1's cold end: refused, never clamped.
    let cold = point(Branch::Liquid, p, 273.15).unwrap();
    assert_eq!(
        point_pu(Branch::Liquid, p, cold.internal_energy_j_kg - 1.).unwrap_err(),
        Error::Domain
    );
    // The vapor table ends at region 2's 1073.15 K.
    assert!(point(Branch::Vapor, 1e6, 1073.15).is_ok());
    assert_eq!(
        point(Branch::Vapor, 1e6, 1073.2).unwrap_err(),
        Error::Domain
    );
    // The saturated endpoints are the branch tables at (p, Tsat).
    for p in [1e5, 7e6, 16e6, 18e6, 20e6] {
        let t = ts(p);
        let l = point(Branch::SaturatedLiquid, p, 0.).unwrap();
        let g = point(Branch::SaturatedVapor, p, 0.).unwrap();
        assert_eq!(fields(&l), fields(&point(Branch::Liquid, p, t).unwrap()));
        assert_eq!(fields(&g), fields(&point(Branch::Vapor, p, t).unwrap()));
    }
}

#[test]
fn a_second_selection_of_another_method_refuses() {
    sbtl();
    assert!(select_water_method(WaterMethod::Sbtl).is_ok());
    assert!(select_water_method(WaterMethod::If97).is_err());
    assert_eq!(WaterMethod::parse("if97"), Ok(WaterMethod::If97));
    assert!(WaterMethod::parse("IF97").is_err());
}

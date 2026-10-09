use leitbild_operating_plant::initialization::*;
use leitbild_operating_plant::thermal::*;

fn c(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn geometry() -> FuelGeometry {
    FuelGeometry {
        fuel_radius_m: 0.0041,
        clad_inner_radius_m: 0.00418,
        clad_outer_radius_m: 0.00475,
        rod_length_m: 2.,
        rods: 264.,
        helium_volume_m3: 0.002,
        helium_nr_j_k: 20.,
        accommodation: 0.287,
        fuel_emissivity: 0.7,
        clad_emissivity: 0.7,
    }
}
fn fixed() -> FuelTemperatures {
    FuelTemperatures {
        inner_mean: c(850.),
        outer_mean: c(850.),
        fuel_surface: c(850.),
        helium: c(650.),
        clad_inner: c(600.),
        clad_mean: c(600.),
        clad_outer: c(600.),
    }
}
fn policy() -> SurfacePolicy {
    SurfacePolicy {
        maximum_residual_w: 1e-3,
        maximum_correction_k: 1e-6,
        maximum_iterations: 16,
        maximum_backtracks: 12,
    }
}
// Independent smooth wall is a TEST fixture, not a production coefficient.
fn wall(t: Scalar) -> leitbild_operating_plant::thermal::Result<Scalar> {
    Ok(c(1.1e5) * (t - c(578.15)))
}
fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-8 * (1. + b.abs()), "{a} vs {b}");
}

#[test]
fn massless_surfaces_close_without_changing_finite_temperatures_or_forcing_rates() {
    let fixed = fixed();
    let solved =
        initialize_fuel_surfaces(&geometry(), fixed, [850., 600., 600.], policy(), wall).unwrap();
    assert!(solved.residual_w.into_iter().all(|r| r.abs() <= 1e-3));
    assert!(solved.maximum_correction_k <= 1e-6);
    assert!(solved.iterations > 0 && solved.iterations < 16);
    for (a, b) in [
        (solved.temperatures.inner_mean, fixed.inner_mean),
        (solved.temperatures.outer_mean, fixed.outer_mean),
        (solved.temperatures.helium, fixed.helium),
        (solved.temperatures.clad_mean, fixed.clad_mean),
    ] {
        assert_eq!(a.value, b.value);
        assert_eq!(a.direction, b.direction);
    }
    let rates = fuel_heat_rates(
        &geometry(),
        solved.temperatures,
        [c(3e6), c(3e6)],
        c(solved.water_heat_w),
    )
    .unwrap();
    close(
        (rates.fuel_inner + rates.fuel_outer + rates.helium + rates.clad + rates.water).value,
        6e6,
    );
    assert!(
        rates.helium.value.abs() > 1e4,
        "finite helium is not re-equilibrated"
    );
    assert!(
        rates.fuel_inner.value.abs() > 1e6,
        "consistent is not steady"
    );
    let other =
        initialize_fuel_surfaces(&geometry(), fixed, [700., 650., 575.], policy(), wall).unwrap();
    for (a, b) in [
        (
            solved.temperatures.fuel_surface,
            other.temperatures.fuel_surface,
        ),
        (
            solved.temperatures.clad_inner,
            other.temperatures.clad_inner,
        ),
        (
            solved.temperatures.clad_outer,
            other.temperatures.clad_outer,
        ),
    ] {
        close(a.value, b.value);
    }
}

#[test]
fn final_applied_update_is_checked_and_failure_is_not_step_only_success() {
    let insufficient = SurfacePolicy {
        maximum_iterations: 1,
        ..policy()
    };
    let err =
        initialize_fuel_surfaces(&geometry(), fixed(), [850., 600., 600.], insufficient, wall)
            .unwrap_err();
    let Error::NoConvergence {
        maximum_residual_w,
        iterations,
        ..
    } = err
    else {
        panic!("{err:?}")
    };
    assert_eq!(iterations, 1);
    assert!(maximum_residual_w.is_finite() && maximum_residual_w > 1e-3);
    // The final diagnostic belongs to the applied point, not the old seed.
    let seed = fuel_transfers(&geometry(), fixed(), wall(c(600.)).unwrap()).unwrap();
    let original = seed
        .surface_residuals
        .into_iter()
        .map(|v| v.value.abs())
        .fold(0., f64::max);
    assert!(maximum_residual_w < original);
}

#[test]
fn invalid_stock_direction_seed_policy_and_unavailable_wall_are_refused() {
    let mut t = fixed();
    t.helium.direction = 1.;
    assert_eq!(
        initialize_fuel_surfaces(&geometry(), t, [850., 600., 600.], policy(), wall).unwrap_err(),
        Error::InvalidCoordinates
    );
    assert_eq!(
        initialize_fuel_surfaces(&geometry(), fixed(), [499., 600., 600.], policy(), wall)
            .unwrap_err(),
        Error::InvalidCoordinates
    );
    assert_eq!(
        initialize_fuel_surfaces(
            &geometry(),
            fixed(),
            [850., 600., 600.],
            SurfacePolicy {
                maximum_residual_w: 0.,
                ..policy()
            },
            wall
        )
        .unwrap_err(),
        Error::InvalidPolicy
    );
    assert_eq!(
        initialize_fuel_surfaces(&geometry(), fixed(), [850., 600., 600.], policy(), |_| Err(
            "unavailable physical wall branch"
        ))
        .unwrap_err(),
        Error::Constitutive("unavailable physical wall branch")
    );
}

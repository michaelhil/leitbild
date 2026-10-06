use leitbild_plant_numerics::sg_secondary::*;
fn config() -> Secondary {
    Secondary {
        volume: 120.,
        initial_temperature: 313.15,
        initial_pressure: 101325.,
        initial_liquid_volume: 72.,
        initial_nitrogen_mass: 0.,
        minimum_wetted_liquid_volume: 71.25,
    }
}
#[test]
fn actual_cold_preparation_retains_finite_native_species_and_energy() {
    let s = config();
    let (i, x) = s.prepare().unwrap();
    assert!(i.water > 70000. && i.water < 72000.);
    assert!(i.air > 40. && i.air < 60.);
    assert_eq!(i.nitrogen, 0.);
    assert!((x.liquid_volume - 72.).abs() < 1e-12);
    assert!((x.gas_volume - 48.).abs() < 1e-12);
    assert!((x.liquid_mass + x.vapor_mass - i.water).abs() < 1e-8);
    assert!(x.pressure_residual.abs() < 1e-8);
    assert!(x.saturation_pressure < 101325.);
    assert!(x.energy > 1e10);
    let d = s.derivatives(i, 313.15, 101325.).unwrap();
    assert!(d[3] > 0. && d[0] - d[1] * d[2] / d[3] > 0.);
}
#[test]
fn forward_chart_is_not_a_held_phase_fraction_and_refuses_branch_exits() {
    let s = config();
    let (i, a) = s.prepare().unwrap();
    let b = s.evaluate(i, 314.15, 101325.).unwrap();
    assert!(b.vapor_mass > a.vapor_mass);
    assert_ne!(b.liquid_volume, a.liquid_volume);
    assert_ne!(b.pressure_residual, 0.);
    assert!(b.energy > a.energy);
    assert!(s.evaluate(i, 400., 101325.).is_err());
    let mut dry = s;
    dry.minimum_wetted_liquid_volume = 73.;
    assert!(dry.prepare().is_err());
    let mut bad = s;
    bad.initial_nitrogen_mass = 1e6;
    assert!(bad.prepare().is_err());
    assert!(s.evaluate(i, f64::NAN, 101325.).is_err());
}
#[test]
fn external_film_signed_zero_and_subboiling_domain() {
    let mut count = 0;
    assert_eq!(
        heat(313.15, 101325., 313.15, 625., 0.02, &mut count).unwrap(),
        0.
    );
    let a = heat(313.15, 101325., 310., 625., 0.02, &mut count).unwrap();
    let b = heat(313.15, 101325., 316.3, 625., 0.02, &mut count).unwrap();
    assert!(a < 0. && b > 0.);
    assert!(a * (1. / 313.15 - 1. / 310.) >= 0.);
    assert!(heat(313.15, 101325., 400., 625., 0.02, &mut count).is_err());
    assert!(heat(313.15, 101325., 310., 0., 0.02, &mut count).is_err());
    assert!(count > 0);
}
#[test]
fn whole_flux_tangent_has_exact_zero_limit_and_signed_nonzero_derivatives() {
    let s = config();
    let (_, st) = s.prepare().unwrap();
    let mut count = 0;
    let (q, d) = heat_with_partials(313.15, 101325., 313.15, 625., 0.02, true, &mut count).unwrap();
    let limit = 0.36 * 625. * st.liquid.conductivity / 0.02;
    assert_eq!(q, 0.);
    assert_eq!(d[0], -limit);
    assert_eq!(d[1], 0.);
    assert_eq!(d[2], limit);
    for wall in [310., 316., 313.15001] {
        let values = [313.15, 101325., wall];
        let (_, exact) = heat_with_partials(
            values[0], values[1], values[2], 625., 0.02, true, &mut count,
        )
        .unwrap();
        for j in 0..3 {
            for scale in [1., 0.5] {
                let h = if j == 1 {
                    0.1 * scale
                } else {
                    (wall - 313.15_f64).abs().min(0.1) * 1e-3 * scale
                };
                let mut a = values;
                let mut b = values;
                a[j] += h;
                b[j] -= h;
                let fd = (heat(a[0], a[1], a[2], 625., 0.02, &mut count).unwrap()
                    - heat(b[0], b[1], b[2], 625., 0.02, &mut count).unwrap())
                    / (2. * h);
                assert!(
                    (fd - exact[j]).abs() < 2e-4 * fd.abs().max(exact[j].abs()).max(1.),
                    "wall{wall} col{j}:fd{fd} exact{}",
                    exact[j]
                );
            }
        }
    }
}

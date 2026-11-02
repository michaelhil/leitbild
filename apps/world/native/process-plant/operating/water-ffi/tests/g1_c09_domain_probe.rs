//! G1-C09 scratch probes of the maintained IF97 boundary (test-only).
use leitbild_operating_plant::{
    network::{Properties, stratified::restriction_flux},
    thermal::Scalar,
};
use leitbild_operating_water::{Branch, Domain, If97, If97LowPressure, point, point_in};
#[test]
#[ignore = "G1-C09 domain probe"]
fn g1_c09_domain_probe() {
    for p in [5e3, 7.38e3, 2e4, 5e4, 1.01325e5, 2e5, 5e5, 1e6, 2e6] {
        let pt = point(Branch::Liquid, p, 313.15);
        let sat = <If97 as Properties>::saturation(&If97, Scalar::new(p, 0.));
        println!("p={p:>9} liquid40C={:?} sat={:?}", pt.map(|w| (w.density_kg_m3, w.saturation_departure_k)), sat.as_ref().map(|s| s.temperature.value));
        // The operating owners keep the declared 0.1 MPa floor (operating-phase-properties.md).
        assert_eq!(pt.is_ok() && sat.is_ok(), p >= 1e5, "domain at {p} Pa");
        // S4-D2 hook (owner F5): C09's declared low-pressure owners (FW.TANK
        // pickups and casings below the eye, NPSHa, COND.P, the H1 shell and
        // its drains) are admitted down to 611.657 Pa; liquid at 40 °C is
        // subcooled above psat(40 °C) = 7.38 kPa.
        let low = point_in(Domain::LowPressure, Branch::Liquid, p, 313.15);
        let low_sat = <If97LowPressure as Properties>::saturation(&If97LowPressure, Scalar::new(p, 0.));
        assert!(low_sat.is_ok(), "low-pressure saturation at {p} Pa");
        assert_eq!(low.is_ok(), p > 7.385e3, "low-pressure liquid at 40 °C, {p} Pa: {low:?}");
    }
}
/// A saturated-liquid donor at its own endpoint: restriction_flux from
/// (p, h_f(p)) on the liquid branch, at pressures near a heater shell's.
#[test]
#[ignore = "G1-C09 endpoint probe"]
fn g1_c09_saturated_donor_probe() {
    let mut refused = 0;
    let mut total = 0;
    for base in [0.199e6, 0.796e6, 3.98e6] {
        for k in -20i32..=20 {
            let p = base * (1. + k as f64 * 1e-12);
            for seed in [0., 1.] {
            let hf = <If97 as Properties>::saturation(&If97, Scalar::new(p, seed)).unwrap().liquid.enthalpy;
            let r = restriction_flux(&If97, false, Scalar::new(p, seed), hf, Scalar::new(0.5 * p, 0.));
            total += 1;
            if let Err(e) = &r {
                refused += 1;
                if refused <= 3 {
                    println!("refused p={p} seed={seed} hf={}: {e:?}", hf.value);
                }
            }
            }
        }
    }
    println!("saturated-liquid donors refused: {refused} of {total}");
}

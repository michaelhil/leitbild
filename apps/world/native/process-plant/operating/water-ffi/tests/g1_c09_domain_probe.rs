//! G1-C09 scratch probes of the maintained IF97 boundary (test-only).
use leitbild_operating_plant::{
    network::{Properties, stratified::restriction_flux},
    thermal::Scalar,
};
use leitbild_operating_water::{Branch, If97, point};
#[test]
#[ignore = "G1-C09 domain probe"]
fn g1_c09_domain_probe() {
    for p in [5e3, 7.38e3, 2e4, 5e4, 1.01325e5, 2e5, 5e5, 1e6, 2e6] {
        let pt = point(Branch::Liquid, p, 313.15);
        let sat = <If97 as Properties>::saturation(&If97, Scalar::new(p, 0.));
        println!("p={p:>9} liquid40C={:?} sat={:?}", pt.map(|w| (w.density_kg_m3, w.saturation_departure_k)), sat.as_ref().map(|s| s.temperature.value));
        // The maintained boundary's declared floor is 0.1 MPa (operating-phase-properties.md).
        assert_eq!(pt.is_ok() && sat.is_ok(), p >= 1e5, "domain at {p} Pa");
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

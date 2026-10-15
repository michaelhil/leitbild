//! G1-C09 scratch probe of the maintained IF97 boundary's low-pressure domain (test-only).
use leitbild_operating_plant::{network::Properties, thermal::Scalar};
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

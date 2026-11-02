//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! S4-D2 (owner decision F5, 15 Oct 2026): the water bridge admits IF97's
//! own validity down to the triple-point pressure (611.657 Pa) only for an
//! owner that declares a low-pressure domain; every other owner keeps the
//! selected 0.1 MPa floor. C13's three saturation entries by temperature
//! are on the bridge.
use leitbild_operating_plant::{network::Properties, thermal::Scalar};
use leitbild_operating_water::{
    Branch, CaloricLinearization, Domain, Error, If97, If97LowPressure, point, point_in,
    saturated_vapor_enthalpy, saturated_vapor_viscosity, saturation_caloric, saturation_caloric_in,
    saturation_pressure,
};

fn bits(q: &leitbild_operating_water::WaterPoint) -> Vec<u64> {
    [
        q.pressure_pa,
        q.temperature_k,
        q.density_kg_m3,
        q.internal_energy_j_kg,
        q.enthalpy_j_kg,
        q.cp_j_kg_k,
        q.viscosity_pa_s,
    ]
    .iter()
    .map(|v| v.to_bits())
    .collect()
}

#[test]
fn the_low_pressure_floor_is_admitted_only_for_a_declared_owner() {
    assert_eq!(Domain::Operating.floor_pa(), 1e5);
    assert_eq!(Domain::LowPressure.floor_pa(), 611.657);
    // Below 0.1 MPa: refused for the operating owners, admitted for a
    // declared low-pressure owner (the condenser at 40 °C, the LP2 and H1
    // shells at 0.05 MPa, the containment's 25 °C vapor anchor).
    for p in [611.657, 3.17e3, 7.38e3, 5e4, 99_999.] {
        assert_eq!(saturation_caloric(p, 0.).unwrap_err(), Error::Domain, "{p}");
        let [(l, _), (g, _)] = saturation_caloric_in(Domain::LowPressure, p, 0.).unwrap();
        assert!(l.temperature_k == g.temperature_k && l.density_kg_m3 > g.density_kg_m3);
        let t = l.temperature_k - 1e-3;
        assert_eq!(point(Branch::Liquid, p, t).unwrap_err(), Error::Domain);
        let q = point_in(Domain::LowPressure, Branch::Liquid, p, t).unwrap();
        assert!(q.saturation_departure_k < 0., "{p}: {q:?}");
        assert_eq!(
            CaloricLinearization::internal_energy(Branch::Liquid, p, q.internal_energy_j_kg)
                .unwrap_err(),
            Error::Domain
        );
        let r = CaloricLinearization::internal_energy_in(
            Domain::LowPressure,
            Branch::Liquid,
            p,
            q.internal_energy_j_kg,
        )
        .unwrap();
        assert!((r.point().temperature_k - t).abs() < 1e-9, "{p}");
        assert!(<If97 as Properties>::saturation(&If97, Scalar::new(p, 0.)).is_err());
        assert!(
            <If97LowPressure as Properties>::saturation(&If97LowPressure, Scalar::new(p, 0.))
                .is_ok()
        );
    }
    // Below the triple point: refused in both domains.
    for domain in [Domain::Operating, Domain::LowPressure] {
        assert_eq!(
            saturation_caloric_in(domain, 611., 0.).unwrap_err(),
            Error::Domain
        );
        assert_eq!(
            point_in(domain, Branch::Vapor, f64::NAN, 300.).unwrap_err(),
            Error::Domain
        );
    }
    // At and above 0.1 MPa both domains are the same bridge, bit for bit.
    for (p, t) in [(1e5, 300.), (1e6, 400.), (15e6, 560.)] {
        let a = point(Branch::Liquid, p, t).unwrap();
        let b = point_in(Domain::LowPressure, Branch::Liquid, p, t).unwrap();
        assert_eq!(bits(&a), bits(&b), "{p}");
        let [(la, _), (ga, _)] = saturation_caloric(p, 1.).unwrap();
        let [(lb, _), (gb, _)] = saturation_caloric_in(Domain::LowPressure, p, 1.).unwrap();
        assert_eq!((bits(&la), bits(&ga)), (bits(&lb), bits(&gb)), "{p}");
    }
    // The condenser's saturation at 40 °C.
    let s =
        <If97LowPressure as Properties>::saturation(&If97LowPressure, Scalar::new(7.3849e3, 0.))
            .unwrap();
    assert!(
        (s.temperature.value - 313.15).abs() < 0.01,
        "{}",
        s.temperature.value
    );
}

#[test]
fn c13s_saturation_entries_by_temperature_agree_with_the_low_pressure_bridge() {
    // The containment's 25 °C saturated-vapor anchor (3.17 kPa).
    let t = 298.15;
    let (p, dp) = saturation_pressure(t, 1.).unwrap();
    assert!((p - 3169.9).abs() < 1., "{p}");
    assert!(dp > 0.);
    let [(l, _), (g, _)] = saturation_caloric_in(Domain::LowPressure, p, 0.).unwrap();
    // Region 4's p_T and T_p are inverses to their own accuracy.
    assert!((l.temperature_k - t).abs() < 1e-6, "{}", l.temperature_k);
    let h = saturated_vapor_enthalpy(t).unwrap();
    assert!(
        (h - g.enthalpy_j_kg).abs() < 1e-6 * h,
        "{h} {}",
        g.enthalpy_j_kg
    );
    let (mu, _) = saturated_vapor_viscosity(t, 0.).unwrap();
    assert!(mu > 0. && mu < 2e-5, "{mu}");
}

//! Actual maintained-property common-P chart/receipt witness, no integration.
use leitbild_operating_plant::{
    phase::Point,
    pzr::{self, Active},
};
use serde::Deserialize;
#[derive(Deserialize)]
struct Water {
    p: f64,
    #[serde(rename = "T")]
    t: f64,
    rho: f64,
    u: f64,
    h: f64,
    cp: f64,
    alpha: f64,
    kappa: f64,
}
impl Water {
    fn point(&self) -> Point {
        Point {
            pressure_pa: self.p,
            temperature_k: self.t,
            density_kg_m3: self.rho,
            internal_energy_j_kg: self.u,
            enthalpy_j_kg: self.h,
            density_pressure: self.rho * self.kappa,
            density_temperature: -self.rho * self.alpha,
            energy_pressure: (self.p * self.kappa - self.t * self.alpha) / self.rho,
            energy_temperature: self.cp - self.p * self.alpha / self.rho,
        }
    }
}
#[derive(Deserialize)]
struct Region {
    volume_m3: f64,
    #[serde(rename = "initialPhase")]
    active: Active,
    water: Water,
    mass_kg: f64,
    #[serde(rename = "liquidEnergy_J")]
    ul: f64,
    #[serde(rename = "vaporEnergy_J")]
    ug: f64,
}
#[derive(Deserialize)]
struct Packet {
    regions: Vec<Region>,
    saturated_liquid: Water,
    cold_liquid: Water,
    vapor: Water,
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() < 3e-12 * a.abs().max(b.abs()).max(1.),
        "{a} != {b}"
    );
}
#[test]
#[ignore = "requires LD01_OPERATING_PZR actual property/geometry payload"]
fn actual_pzr_chart_and_changed_state_birth_receipts() {
    let file = std::env::var("LD01_OPERATING_PZR").expect("explicit actual PZR input");
    let p: Packet = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    assert_eq!(p.regions.len(), 10);
    let mut aggregate = 0.;
    for r in &p.regions {
        let q = r.water.point();
        let l = r.active == Active::Liquid;
        let c = pzr::chart(
            r.volume_m3,
            q.pressure_pa,
            if l { 0. } else { 1. },
            r.active,
            if l { Some(q) } else { None },
            if l { None } else { Some(q) },
        )
        .unwrap();
        c.validate_accepted().unwrap();
        close(c.stock[0], r.mass_kg);
        close(c.stock[1], r.ul);
        close(c.stock[2], r.ug);
        aggregate += c.reduced().unwrap().mass[0];
    }
    assert!(aggregate.is_finite() && aggregate != 0.);
    let g = p.vapor.point();
    let before = pzr::chart(3., g.pressure_pa, 1., Active::Vapor, None, Some(g)).unwrap();
    for l in [p.saturated_liquid.point(), p.cold_liquid.point()] {
        // Actual finite displacement receipt, not an epsilon phase seed:
        // admit .002m3 liquid and expel the same volume of existing gas.
        let dv = 0.002;
        let ml = l.density_kg_m3 * dv;
        let mg = g.density_kg_m3 * (3. - dv);
        let after = pzr::chart(
            3.,
            g.pressure_pa,
            mg / (ml + mg),
            Active::TwoPhase,
            Some(l),
            Some(g),
        )
        .unwrap();
        after.validate_accepted().unwrap();
        after.reduced().unwrap();
        close(after.stock[0] - before.stock[0], ml - g.density_kg_m3 * dv);
        close(
            after.stock[1] + after.stock[2] - before.stock[2],
            ml * l.enthalpy_j_kg - g.density_kg_m3 * dv * g.enthalpy_j_kg,
        );
        let birth = pzr::birth(g.pressure_pa, ml, l.enthalpy_j_kg, Some(l)).unwrap();
        close(birth.volume_rate_m3_s, dv);
        close(birth.internal_energy_rate_w, ml * l.internal_energy_j_kg);
        assert!(birth.caloric_residual_w.abs() < 1e-8);
    }
    assert_ne!(p.cold_liquid.t, p.saturated_liquid.t);
    assert!(pzr::require_pure_water(0., 0., 0., 1e-9).is_err());
    eprintln!(
        "actual10-region commonP chart: sumA={aggregate:.12e} kg/Pa; saturated and cold incoming finite birth/volume receipts pass; phase-force/rank/trajectory unadmitted"
    );
}

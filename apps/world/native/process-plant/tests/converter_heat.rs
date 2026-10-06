use leitbild_plant_numerics::converter_heat::*;
fn geometry() -> Geometry { Geometry { film_thickness: 0.0002603579961269216,
    film_density: 2520., film_mu_en: 0.0028, carrier_wall: 0.0002,
    thimble_wall: 0.0005, steel_density: 7920., steel_mu_en: 0.0029 } }
fn sum(q: Rates) -> f64 { q.collector + q.helium + q.wall + q.liquid + q.export }
#[test]
fn serial_paths_pay_charged_and_photon_release_once() {
    let g = geometry(); let m = Model::new(g, 2.34274, 0.45026).unwrap();
    let q = m.apply(7., 0.01, Some(LiquidPath { density: 997., mu_en: 0.003299, chord: 0.012 })).unwrap();
    assert!((sum(q) - q.emitted).abs() < 1e-14);
    assert!(q.liquid > 0. && q.export > 0. && q.helium == 0.0234274);
    let film = 1. - (-g.film_density * g.film_mu_en * g.film_thickness).exp();
    let carrier = 1. - (-g.steel_density * g.steel_mu_en * 2. * g.carrier_wall).exp();
    let wall = 1. - (-g.steel_density * g.steel_mu_en * g.thimble_wall).exp();
    let collector = (7. - 0.01) * 2.34274 + 7. * 0.45026 * (film + (1.-film)*carrier/2.);
    assert!((q.collector - collector).abs() < 1e-14);
    assert!((q.wall - 7. * 0.45026 * (1.-film) * (1.-carrier/2.) * wall).abs() < 1e-14);
}
#[test]
fn dry_zero_and_signed_trials_do_not_invent_a_sink_or_floor() {
    let m = Model::new(geometry(), 2.34274, 0.45026).unwrap();
    let a = m.apply(1., 0.001, None).unwrap();
    let b = m.apply(-1., -0.001, None).unwrap();
    assert!(a.liquid == 0. && a.export > 0. && a.wall > 0. && a.collector > 0.);
    assert_eq!(sum(m.apply(0., 0., None).unwrap()), 0.);
    assert_eq!(sum(a), -sum(b)); assert!((sum(a)-a.emitted).abs() < 1e-15);
    assert!(m.apply(f64::NAN, 0., None).is_err());
    assert!(m.apply(1., 0., Some(LiquidPath { density: 0., mu_en: 0.003299, chord: 0.012 })).is_err());
}
#[test]
fn transparent_and_thin_photon_paths_preserve_actual_shares() {
    let mut g = geometry(); g.film_mu_en = 0.; g.steel_mu_en = 0.;
    let q = Model::new(g, 2., 1.).unwrap().apply(1., 0., None).unwrap();
    assert_eq!(q.export, 1.); assert_eq!(q.wall, 0.); assert_eq!(q.collector, 2.);
    g.film_mu_en = 1e-25;
    let q = Model::new(g, 2., 1.).unwrap().apply(1., 1., None).unwrap();
    assert!(q.collector > 0. && q.collector < 1e-25); // no tiny optical-depth deletion
    assert!(Model::new(Geometry { film_density: -1., ..g }, 2., 1.).is_err());
}

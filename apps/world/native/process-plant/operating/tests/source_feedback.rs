use leitbild_operating_plant::source_feedback::*;
use leitbild_operating_plant::thermal::{Scalar, fuel_feedback_temperature};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn bounds(minimum: f64, maximum: f64) -> Bounds {
    Bounds { minimum, maximum }
}
fn parameters() -> Parameters {
    Parameters {
        generation_time_s: 2e-5,
        nu_effective: 2.43,
        doppler_per_sqrt_k: -0.00115,
        water_worth: 0.15,
        boron_per_ppm_eq: -8e-5,
        rod_worth: 0.10,
        sigma_xe_m2: 2e-22,
        sigma_sm_m2: 4e-24,
        capsule_births_per_s: 4e9,
        capsule_decay_per_s: std::f64::consts::LN_2 / 83469852.,
        inserted_active_bottom_m: -2.,
        rod_active_length_m: 4.,
        rod_maximum_travel_m: 4.,
        domains: Domains {
            fuel_temperature_k: bounds(500., 1800.),
            moderator_temperature_k: bounds(550., 610.),
            pressure_pa: bounds(14e6, 16e6),
            density_ratio: bounds(0.85, 1.1),
            boron_ppm_eq: bounds(0., 2500.),
            fissile_ratio: bounds(0.95, 1.),
            reactivity: bounds(-0.3, 0.15),
            maximum_additional_reference_exposure_s: 172800.,
        },
    }
}
fn metadata() -> (Parameters, Vec<Region>, Vec<Material>, Vec<Support>) {
    let p = parameters();
    let gamma = 1. / (p.generation_time_s * p.nu_effective);
    let regions = (0..2)
        .map(|i| Region {
            rho_base: 0.002 * (i + 1) as f64,
            reference_density_kg_m3: 700.,
            reference_boron_ppm_eq: 1000.,
            reference_rod_overlap: if i == 0 { 0. } else { 0.6 },
            source_weight: 0.5,
            z0_m: -2. + 2. * i as f64,
            z1_m: 2. * i as f64,
            rod_weights: vec![0.5, 0.5],
        })
        .collect();
    let materials = (0..2)
        .map(|_| Material {
            reference_fissile_atoms: 1e26,
            reference_fuel_temperature_k: 850.,
            reference_xenon_atoms: 2e17,
            reference_samarium_atoms: 1e18,
            reference_nonpoison_capture_opacity_m2: 0.001,
        })
        .collect();
    let supports = (0..2)
        .flat_map(|region| {
            (0..2).map(move |material| Support {
                region,
                material,
                production_reference_per_s: 0.5 * gamma,
                exposure_per_population_s_m2: 0.5 * gamma,
                fuel_importance: 0.5,
            })
        })
        .collect();
    (p, regions, materials, supports)
}
fn model() -> Model {
    let (p, r, a, e) = metadata();
    Model::new(p, r, a, e).unwrap()
}
struct Current {
    fuel: Vec<Scalar>,
    density: Vec<Scalar>,
    boron: Vec<Scalar>,
    pressure: Vec<Scalar>,
    moderator: Vec<Scalar>,
    fissile: Vec<Scalar>,
    xenon: Vec<Scalar>,
    samarium: Vec<Scalar>,
    capture: Vec<Scalar>,
    rods: Vec<Scalar>,
    age: Scalar,
}
impl Current {
    fn reference() -> Self {
        Self {
            fuel: vec![s(850.); 2],
            density: vec![s(700.); 2],
            boron: vec![s(1000.); 2],
            pressure: vec![s(15.2e6); 2],
            moderator: vec![s(590.); 2],
            fissile: vec![s(1e26); 2],
            xenon: vec![s(2e17); 2],
            samarium: vec![s(1e18); 2],
            capture: vec![s(0.); 2],
            rods: vec![s(2.8); 2],
            age: s(0.),
        }
    }
    fn conditions(&self) -> Conditions<'_> {
        Conditions {
            fuel_temperature_k: &self.fuel,
            water_density_kg_m3: &self.density,
            boron_ppm_eq: &self.boron,
            pressure_pa: &self.pressure,
            moderator_temperature_k: &self.moderator,
            fissile_atoms: &self.fissile,
            xenon_atoms: &self.xenon,
            samarium_atoms: &self.samarium,
            capture_loss_change_m2: &self.capture,
            achieved_rod_travel_m: &self.rods,
            capsule_age_s: self.age,
        }
    }
    fn shift(&self, h: f64) -> Self {
        let v = |values: &[Scalar]| {
            values
                .iter()
                .map(|v| Scalar::new(v.value + h * v.direction, 0.))
                .collect()
        };
        Self {
            fuel: v(&self.fuel),
            density: v(&self.density),
            boron: v(&self.boron),
            pressure: v(&self.pressure),
            moderator: v(&self.moderator),
            fissile: v(&self.fissile),
            xenon: v(&self.xenon),
            samarium: v(&self.samarium),
            capture: v(&self.capture),
            rods: v(&self.rods),
            age: s(self.age.value + h * self.age.direction),
        }
    }
}
fn flatten(out: &Output) -> Vec<Scalar> {
    out.regions
        .iter()
        .flat_map(|r| [r.reactivity, r.external_source_per_s])
        .chain(out.fissions_per_population_s.iter().copied())
        .chain(out.carrier_fissions_per_s.iter().copied())
        .chain(out.exposure_per_m2_s.iter().copied())
        .chain(
            out.poison_capture_per_s
                .iter()
                .flat_map(|p| [p.xenon, p.samarium]),
        )
        .chain(out.rod_overlap.iter().copied())
        .collect()
}
fn close(a: f64, b: f64, tolerance: f64) {
    assert!((a - b).abs() <= tolerance * b.abs().max(1.), "{a} vs {b}");
}

#[test]
fn reference_and_fissile_response_preserve_one_exposure_and_neutron_loss_budget() {
    let model = model();
    let mut current = Current::reference();
    let n = vec![s(2e12); 2];
    let mut out = Output::new(2, 2, 4);
    model
        .validate_accepted(&n, current.conditions(), 0., &mut out)
        .unwrap();
    close(out.regions[0].reactivity.value, 0.002, 1e-13);
    close(out.regions[1].reactivity.value, 0.004, 1e-13);
    close(
        out.regions
            .iter()
            .map(|r| r.external_source_per_s.value)
            .sum(),
        4e9,
        1e-13,
    );
    let original = out.clone();
    current.fissile[0] = s(0.98e26);
    model.evaluate(&n, current.conditions(), &mut out).unwrap();
    close(
        out.carrier_fissions_per_s[0].value,
        0.98 * original.carrier_fissions_per_s[0].value,
        1e-13,
    );
    close(
        out.exposure_per_m2_s[0].value,
        original.exposure_per_m2_s[0].value,
        1e-13,
    );
    let delta_g = -0.02 * 0.5 / (parameters().nu_effective * parameters().generation_time_s);
    close(
        out.regions[0].reactivity.value - original.regions[0].reactivity.value,
        parameters().generation_time_s * (parameters().nu_effective - 1.) * delta_g,
        1e-13,
    );
    close(
        out.poison_capture_per_s[0].xenon.value,
        original.poison_capture_per_s[0].xenon.value,
        1e-13,
    );
}

#[test]
fn unequal_two_node_feedback_and_all_current_coordinates_have_same_trial_directions() {
    let model = model();
    let mut current = Current::reference();
    current.fuel[0] =
        fuel_feedback_temperature(Scalar::new(950., 3.), Scalar::new(760., -2.)).unwrap();
    assert!(
        (current.fuel[0].value - 855.).abs() > 0.1,
        "not sqrt(meanT)"
    );
    current.density[0] = Scalar::new(690., -1.3);
    current.boron[0] = Scalar::new(980., 4.);
    current.fissile[0] = Scalar::new(0.99e26, -1e22);
    current.xenon[0] = Scalar::new(2.1e17, 1e14);
    current.samarium[0] = Scalar::new(1.1e18, -2e14);
    current.capture[0] = Scalar::new(1e-5, 1e-7);
    current.rods[1] = Scalar::new(2.7, -0.002);
    current.age = Scalar::new(1000., 5.);
    let n = vec![Scalar::new(2e12, 1e10), Scalar::new(1.9e12, -2e10)];
    let mut out = Output::new(2, 2, 4);
    model.evaluate(&n, current.conditions(), &mut out).unwrap();
    let epsilon = 1e-2;
    let probe = |h: f64| {
        let c = current.shift(h);
        let n = n
            .iter()
            .map(|v| s(v.value + h * v.direction))
            .collect::<Vec<_>>();
        let mut o = Output::new(2, 2, 4);
        model.evaluate(&n, c.conditions(), &mut o).unwrap();
        flatten(&o)
    };
    for ((actual, plus), minus) in flatten(&out)
        .iter()
        .zip(probe(epsilon))
        .zip(probe(-epsilon))
    {
        close(
            actual.direction,
            (plus.value - minus.value) / (2. * epsilon),
            3e-6,
        );
    }
}

#[test]
fn signed_trials_are_distinct_from_accepted_stocks_and_original_history_is_not_reset() {
    let model = model();
    let current = Current::reference();
    let n = vec![s(-1.); 2];
    let mut out = Output::new(2, 2, 4);
    model.evaluate(&n, current.conditions(), &mut out).unwrap();
    assert!(out.carrier_fissions_per_s[0].value < 0.);
    assert!(
        model
            .validate_accepted(&n, current.conditions(), 0., &mut out)
            .is_err()
    );
    assert!(
        model
            .validate_accepted(&[s(1.); 2], current.conditions(), 172800.1, &mut out)
            .is_err()
    );
    let (p, mut r, a, e) = metadata();
    r[0].rod_weights = vec![1., 1.];
    assert!(
        Model::new(p, r, a, e).is_err(),
        "52-rod importance must be normalized once"
    );
    let (p, r, a, mut e) = metadata();
    e[0].production_reference_per_s *= 2.;
    assert!(
        Model::new(p, r, a, e).is_err(),
        "common equivalent-neutron normalization"
    );
}

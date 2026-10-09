//! Opt-in actual owner-package consumption. JSON navigation belongs ONLY to
//! this test harness; stage equations remain typed, allocation-free native laws.
//! This evaluates uninitialized surface seeds, not a trajectory or steady plant.
use leitbild_operating_plant::thermal::*;
use leitbild_operating_water::If97;
use serde_json::Value;
use std::collections::HashMap;

fn n(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("missing number {key}"))
}
fn a<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().unwrap().as_slice()
}
fn idx(v: &Value, key: &str) -> usize {
    v[key].as_u64().unwrap() as usize
}
fn id(v: &Value) -> &str {
    v["id"].as_str().unwrap()
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn near(value: f64, expected: f64) {
    assert!(value.is_finite() && expected.is_finite());
    assert!(
        (value - expected).abs() <= 3e-11 * expected.abs().max(1.),
        "{value} != {expected}"
    );
}
fn geometry(v: &Value) -> FuelGeometry {
    FuelGeometry {
        fuel_radius_m: n(v, "fuel_radius_m"),
        clad_inner_radius_m: n(v, "clad_inner_radius_m"),
        clad_outer_radius_m: n(v, "clad_outer_radius_m"),
        rod_length_m: n(v, "rod_length_m"),
        rods: n(v, "rods"),
        helium_volume_m3: n(v, "helium_volume_m3"),
        helium_nr_j_k: n(v, "helium_nr_j_k"),
        accommodation: n(v, "accommodation"),
        fuel_emissivity: n(v, "fuel_emissivity"),
        clad_emissivity: n(v, "clad_emissivity"),
    }
}

#[test]
#[ignore = "requires actual owner-generated LD01_OPERATING_THERMAL_PACKET"]
fn actual_finite_thermal_package_consumes_maintained_water_and_closes_reciprocal_receipts() {
    let path = std::env::var_os("LD01_OPERATING_THERMAL_PACKET")
        .expect("actual thermal package is required");
    let packet: Value = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
    assert_eq!(packet["identity"], "LD01-HOT-THERMAL-1");
    let bands = a(&packet, "fuel_bands");
    let water = a(&packet, "water");
    let helium = a(&packet, "helium");
    let passive = a(&packet, "passive_stores");
    let segments = a(&packet, "sg_segments");
    let secondary = a(&packet, "secondaries");
    assert_eq!(
        (
            bands.len(),
            water.len(),
            helium.len(),
            passive.len(),
            segments.len(),
            secondary.len()
        ),
        (386, 26, 193, 1351, 8, 2)
    );
    let passive_index: HashMap<_, _> = passive
        .iter()
        .enumerate()
        .map(|(i, v)| (id(v), i))
        .collect();
    assert_eq!(passive_index.len(), passive.len());
    let props = If97;
    let mut water_rates = vec![0.; water.len()];
    let mut band_wall = vec![0.; bands.len()];
    let mut helium_rates = vec![0.; helium.len()];
    let mut passive_rates = vec![0.; passive.len()];
    let mut secondary_rates = vec![0.; secondary.len()];
    let mut total = 0.;
    let mut max_surface_defect = 0_f64;
    let mut max_caloric_relative_defect = 0_f64;
    let started = std::time::Instant::now();
    // The selected preparation has ZERO circulation. This is explicit initial
    // constitutive input, not a solved expansion/momentum/pressure field.
    for contact in a(&packet, "core_contacts") {
        let b = idx(contact, "band");
        let w = idx(contact, "water");
        let clad = s(n(&bands[b], "clad_temperature_k"));
        let g = geometry(&bands[b]["geometry"]);
        let density = n(&bands[b], "clad_mass_kg")
            / (std::f64::consts::PI
                * (g.clad_outer_radius_m.powi(2) - g.clad_inner_radius_m.powi(2))
                * g.rod_length_m
                * g.rods);
        let law = WallLaw {
            diameter_m: n(contact, "hydraulic_diameter_m"),
            film: Film::Core,
            emissivity: g.clad_emissivity,
            material: core_wall_material(clad, density).unwrap(),
        };
        let q = liquid_wall(
            &props,
            s(n(&water[w], "pressure_pa")),
            s(n(&water[w], "temperature_k")),
            s(a(&bands[b], "surface_seed_k")[2].as_f64().unwrap()),
            s(0.),
            law,
        )
        .unwrap();
        assert_eq!(
            q.vapor_mass.value, 0.,
            "hot preparation must not hide phase birth"
        );
        let heat = q.heat.value * n(contact, "area_m2");
        band_wall[b] += heat;
        water_rates[w] += heat;
    }
    for (i, b) in bands.iter().enumerate() {
        let temps = a(b, "fuel_temperatures_k");
        let seeds = a(b, "surface_seed_k");
        let he = idx(b, "helium");
        let t = FuelTemperatures {
            inner_mean: s(temps[0].as_f64().unwrap()),
            outer_mean: s(temps[1].as_f64().unwrap()),
            fuel_surface: s(seeds[0].as_f64().unwrap()),
            helium: s(n(&helium[he], "temperature_k")),
            clad_inner: s(seeds[1].as_f64().unwrap()),
            clad_mean: s(n(b, "clad_temperature_k")),
            clad_outer: s(seeds[2].as_f64().unwrap()),
        };
        for (j, temperature) in temps.iter().enumerate() {
            let expected = a(b, "fuel_masses_kg")[j].as_f64().unwrap()
                * fuel_caloric(s(temperature.as_f64().unwrap()))
                    .unwrap()
                    .specific_energy
                    .value;
            let actual = a(b, "fuel_energies_j")[j].as_f64().unwrap();
            near(actual, expected);
            max_caloric_relative_defect =
                max_caloric_relative_defect.max((actual - expected).abs() / expected.abs().max(1.));
        }
        near(
            n(b, "clad_energy_j"),
            n(b, "clad_mass_kg") * clad_caloric(t.clad_mean).unwrap().specific_energy.value,
        );
        let source = a(b, "source_w");
        let q = fuel_heat_rates(
            &geometry(&b["geometry"]),
            t,
            [
                s(source[0].as_f64().unwrap()),
                s(source[1].as_f64().unwrap()),
            ],
            s(band_wall[i]),
        )
        .unwrap();
        total += q.fuel_inner.value + q.fuel_outer.value + q.clad.value;
        helium_rates[he] += q.helium.value;
        for r in q.surface_residuals {
            max_surface_defect = max_surface_defect.max(r.value.abs());
        }
        near(
            fuel_feedback_temperature(t.inner_mean, t.outer_mean)
                .unwrap()
                .value,
            t.inner_mean.value,
        );
    }
    // Finite guide/fitting/plenum calorics and both sides of actual contacts.
    for p in passive {
        near(
            n(p, "energy_j"),
            n(p, "mass_kg")
                * clad_caloric(s(n(p, "temperature_k")))
                    .unwrap()
                    .specific_energy
                    .value,
        );
    }
    for p in helium {
        near(
            n(p, "energy_j"),
            1.5 * n(p, "nr_j_k") * n(p, "temperature_k"),
        );
    }
    for c in a(&packet, "passive_contacts") {
        let solid = passive_index[c["store_id"].as_str().unwrap()];
        let w = idx(c, "water");
        let q = nonfuel_wall(
            s(n(&passive[solid], "temperature_k")),
            s(n(&water[w], "temperature_k")),
            s(n(c, "area_m2")),
            n(c, "liquid_h_w_m2_k"),
            n(c, "wall_log_radius_m"),
        )
        .unwrap()
        .value;
        passive_rates[solid] -= q;
        water_rates[w] += q;
    }
    for c in a(&packet, "plenum_contacts") {
        let he = idx(c, "helium");
        let p = passive_index[c["store_id"].as_str().unwrap()];
        let q = helium_to_plenum(
            s(n(&helium[he], "temperature_k")),
            s(n(&passive[p], "temperature_k")),
            n(c, "area_m2"),
            n(c, "inner_radius_m"),
            n(c, "conduction_factor"),
        )
        .unwrap()
        .value;
        helium_rates[he] -= q;
        passive_rates[p] += q;
    }
    let mut sg_metal_rate = 0.;
    let mut sg_to_secondary = 0.;
    for metal in segments {
        let w = idx(metal, "primary");
        let sec = idx(metal, "secondary");
        let t = s(n(metal, "temperature_k"));
        near(
            n(metal, "energy_j"),
            n(metal, "capacity_j_k") * (t.value - 273.15),
        );
        let law = WallLaw {
            diameter_m: n(metal, "thermal_diameter_m"),
            film: Film::Tube,
            emissivity: 0.3,
            material: WallMaterial {
                conductivity: s(15.),
                density: 8000.,
                cp: s(500.),
            },
        };
        let primary_to_metal = -n(metal, "area_m2")
            * liquid_wall(
                &props,
                s(n(&water[w], "pressure_pa")),
                s(n(&water[w], "temperature_k")),
                t,
                s(0.),
                law,
            )
            .unwrap()
            .heat
            .value;
        let sg = &secondary[sec];
        let metal_to_secondary = secondary_wall(
            &props,
            s(n(sg, "pressure_pa")),
            s(n(sg, "temperature_k")),
            t,
            s(n(sg, "liquid_volume_m3")),
            n(metal, "developed_start_m"),
            n(metal, "developed_end_m"),
            n(metal, "area_m2"),
            n(metal, "thermal_diameter_m"),
            true,
        )
        .unwrap()
        .value;
        if sec == 0 && n(metal, "developed_start_m") == 0. {
            // Same actual endpoint/property branch with pressure-dependent Ts.
            // This verifies a joined water/correlation direction, not just a
            // synthetic constant-property thermal fixture.
            let pressure = Scalar::new(n(sg, "pressure_pa"), 1e4);
            let saturated = props.saturation(pressure).unwrap();
            let directional = secondary_wall(
                &props,
                pressure,
                saturated.temperature,
                Scalar::new(t.value, 1.),
                Scalar::new(n(sg, "liquid_volume_m3"), -0.1),
                n(metal, "developed_start_m"),
                n(metal, "developed_end_m"),
                n(metal, "area_m2"),
                n(metal, "thermal_diameter_m"),
                true,
            )
            .unwrap();
            let probe = |offset: f64| {
                let p = s(pressure.value + offset * pressure.direction);
                let ts = props.saturation(p).unwrap().temperature;
                secondary_wall(
                    &props,
                    p,
                    ts,
                    s(t.value + offset),
                    s(n(sg, "liquid_volume_m3") - 0.1 * offset),
                    n(metal, "developed_start_m"),
                    n(metal, "developed_end_m"),
                    n(metal, "area_m2"),
                    n(metal, "thermal_diameter_m"),
                    true,
                )
                .unwrap()
                .value
            };
            let epsilon = 1e-4;
            let numeric = (probe(epsilon) - probe(-epsilon)) / (2. * epsilon);
            assert!(
                (directional.direction - numeric).abs() < 2e-5 * numeric.abs().max(1.),
                "actual SG JVP {} vs {numeric}",
                directional.direction
            );
        }
        let rates = steam_generator_rates(s(primary_to_metal), s(metal_to_secondary)).unwrap();
        water_rates[w] += rates.primary.value;
        sg_metal_rate += rates.metal.value;
        secondary_rates[sec] += rates.secondary.value;
        sg_to_secondary += metal_to_secondary;
    }
    for (i, source) in a(&packet, "direct_water_source_w").iter().enumerate() {
        water_rates[i] += source.as_f64().unwrap();
    }
    total += water_rates.iter().sum::<f64>()
        + helium_rates.iter().sum::<f64>()
        + passive_rates.iter().sum::<f64>()
        + sg_metal_rate
        + secondary_rates.iter().sum::<f64>();
    near(total, n(&packet, "source_total_w"));
    assert!(
        max_surface_defect > 1.,
        "uninitialized surfaces must be reported, not disguised as consistent"
    );
    eprintln!(
        "{}",
        serde_json::json!({"scope":"actual native constitutive evaluation, zero simulated time; surface seeds NOT initialized",
        "fuel_bands":bands.len(),"core_contacts":a(&packet,"core_contacts").len(),
        "passive_contacts":a(&packet,"passive_contacts").len(),"source_w":n(&packet,"source_total_w"),
        "reciprocal_defect_w":total-n(&packet,"source_total_w"),"max_surface_seed_residual_w":max_surface_defect,
        "max_fuel_caloric_relative_defect":max_caloric_relative_defect,"sg_to_secondary_w":sg_to_secondary,
        "evaluation_seconds_including_test_navigation":started.elapsed().as_secs_f64()})
    );
}

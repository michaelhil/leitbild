//! Test-only JSON navigation. Runtime stage evaluation uses immutable typed
//! metadata and current physical coordinates, never JSON or recalibration.
use leitbild_operating_plant::source_feedback::*;
use leitbild_operating_plant::thermal::Scalar;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    parameters: Parameters,
    regions: Vec<Region>,
    materials: Vec<Material>,
    supports: Vec<Support>,
}
fn vector(v: &Value, key: &str) -> Vec<f64> {
    v[key]
        .as_array()
        .unwrap_or_else(|| panic!("missing {key}"))
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}
struct Coordinates {
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
impl Coordinates {
    fn new(values: &Value, directions: &Value) -> Self {
        let coordinates = |key: &str| {
            let v = vector(values, key);
            let d = vector(directions, key);
            assert_eq!(v.len(), d.len());
            v.into_iter()
                .zip(d)
                .map(|(v, d)| Scalar::new(v, d))
                .collect()
        };
        Self {
            fuel: coordinates("fuel_temperature_k"),
            density: coordinates("water_density_kg_m3"),
            boron: coordinates("boron_ppm_eq"),
            pressure: coordinates("pressure_pa"),
            moderator: coordinates("moderator_temperature_k"),
            fissile: coordinates("fissile_atoms"),
            xenon: coordinates("xenon_atoms"),
            samarium: coordinates("samarium_atoms"),
            capture: coordinates("capture_loss_change_m2"),
            rods: coordinates("achieved_rod_travel_m"),
            age: Scalar::new(
                values["capsule_age_s"].as_f64().unwrap(),
                directions["capsule_age_s"].as_f64().unwrap(),
            ),
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
}
fn close(actual: Scalar, value: f64, direction: f64, name: &str) {
    for (actual, expected, kind) in [
        (actual.value, value, "value"),
        (actual.direction, direction, "direction"),
    ] {
        assert!(actual.is_finite() && expected.is_finite());
        assert!(
            (actual - expected).abs() <= 3e-11 * expected.abs().max(1.),
            "{name} {kind}: {actual} vs {expected}"
        );
    }
}
fn compare(out: &Output, expected: &Value, direction: &Value) {
    let regions = expected["inputs"]["regions"].as_array().unwrap();
    let dirs = direction["inputs"]["regions"].as_array().unwrap();
    assert_eq!(regions.len(), out.regions.len());
    assert_eq!(dirs.len(), out.regions.len());
    for ((actual, v), d) in out.regions.iter().zip(regions).zip(dirs) {
        for (actual, key) in [
            (actual.reactivity, "reactivity"),
            (actual.external_source_per_s, "external_source_per_s"),
        ] {
            close(
                actual,
                v[key].as_f64().unwrap(),
                d[key].as_f64().unwrap(),
                key,
            );
        }
    }
    for (actual, v, d, name) in [
        (
            &out.fissions_per_population_s,
            vector(&expected["inputs"], "fissions_per_population_s"),
            vector(&direction["inputs"], "fissions_per_population_s"),
            "G",
        ),
        (
            &out.carrier_fissions_per_s,
            vector(expected, "carrierFissions_per_s"),
            vector(direction, "carrierFissions_per_s"),
            "material F",
        ),
        (
            &out.exposure_per_m2_s,
            vector(expected, "exposure_per_m2_s"),
            vector(direction, "exposure_per_m2_s"),
            "exposure",
        ),
        (
            &out.rod_overlap,
            vector(expected, "rodOverlap"),
            vector(direction, "rodOverlap"),
            "rod overlap",
        ),
    ] {
        assert_eq!(actual.len(), v.len());
        assert_eq!(actual.len(), d.len());
        for ((actual, v), d) in actual.iter().zip(v).zip(d) {
            close(*actual, v, d, name);
        }
    }
    let v = expected["poisonCapture_per_s"].as_array().unwrap();
    let d = direction["poisonCapture_per_s"].as_array().unwrap();
    assert_eq!(out.poison_capture_per_s.len(), v.len());
    assert_eq!(v.len(), d.len());
    for ((actual, v), d) in out.poison_capture_per_s.iter().zip(v).zip(d) {
        close(
            actual.xenon,
            v["xenon"].as_f64().unwrap(),
            d["xenon"].as_f64().unwrap(),
            "Xe captures",
        );
        close(
            actual.samarium,
            v["samarium"].as_f64().unwrap(),
            d["samarium"].as_f64().unwrap(),
            "Sm captures",
        );
    }
}

#[test]
#[ignore = "requires actual owner-generated LD01_OPERATING_SOURCE_PACKET"]
fn actual_hot_reference_and_combined_perturbation_match_independent_ts_response() {
    let path =
        std::env::var_os("LD01_OPERATING_SOURCE_PACKET").expect("actual source packet required");
    let packet: Value = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
    let metadata: Metadata = serde_json::from_value(packet["metadata"].clone()).unwrap();
    let model = Model::new(
        metadata.parameters,
        metadata.regions,
        metadata.materials,
        metadata.supports,
    )
    .unwrap();
    assert_eq!(
        (
            model.region_count(),
            model.material_count(),
            model.support_count(),
            model.rod_count()
        ),
        (24, 386, 1344, 52)
    );
    let cases = packet["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 2,
        "reference and combined perturbation required"
    );
    let mut out = Output::new(
        model.region_count(),
        model.material_count(),
        model.support_count(),
    );
    for case in cases {
        let coordinates = Coordinates::new(&case["conditions"], &case["d_conditions"]);
        let n = vector(case, "neutrons");
        let d = vector(case, "d_neutrons");
        assert_eq!(n.len(), d.len());
        let neutrons = n
            .into_iter()
            .zip(d)
            .map(|(n, d)| Scalar::new(n, d))
            .collect::<Vec<_>>();
        model
            .evaluate(&neutrons, coordinates.conditions(), &mut out)
            .unwrap();
        compare(&out, &case["expected"], &case["expected_direction"]);
        eprintln!(
            "actual compiled source response PASS: {}",
            case["name"].as_str().unwrap()
        );
    }
}

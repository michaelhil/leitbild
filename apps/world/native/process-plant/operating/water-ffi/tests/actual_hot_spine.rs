//! Test-only conversion of the one actual owner package. Runtime composition
//! is typed; there is no JSON work, coefficient copy or power rebasing at stage.
use leitbild_operating_plant::{
    capture, heat_history, hot_spine as hs, initialization, kinetics, poisons, pressure, pzr,
    pzr_field as pf, source_feedback as sf, surge,
    thermal::{self, Scalar, WaterProperties},
};
use leitbild_operating_water::{Branch, If97, point};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;

#[derive(Default)]
struct PropertyCalls {
    liquid: Cell<usize>,
    vapor: Cell<usize>,
    saturation: Cell<usize>,
    fixed: Cell<usize>,
    wall_vapor_density: Cell<usize>,
    liquid_keys: RefCell<BTreeSet<[u64; 4]>>,
    saturation_keys: RefCell<BTreeSet<[u64; 2]>>,
}
impl WaterProperties for PropertyCalls {
    fn liquid(&self, p: Scalar, t: Scalar) -> thermal::Result<thermal::WaterPoint> {
        self.liquid.set(self.liquid.get() + 1);
        self.liquid_keys.borrow_mut().insert([
            p.value.to_bits(),
            p.direction.to_bits(),
            t.value.to_bits(),
            t.direction.to_bits(),
        ]);
        If97.liquid(p, t)
    }
    fn vapor(&self, p: Scalar, t: Scalar) -> thermal::Result<thermal::WaterPoint> {
        self.vapor.set(self.vapor.get() + 1);
        If97.vapor(p, t)
    }
    fn saturation(&self, p: Scalar) -> thermal::Result<thermal::Saturation> {
        self.saturation.set(self.saturation.get() + 1);
        self.saturation_keys
            .borrow_mut()
            .insert([p.value.to_bits(), p.direction.to_bits()]);
        If97.saturation(p)
    }
    fn saturated_vapor_density(&self, t: Scalar) -> thermal::Result<Scalar> {
        self.wall_vapor_density
            .set(self.wall_vapor_density.get() + 1);
        If97.saturated_vapor_density(t)
    }
}
impl hs::Properties for PropertyCalls {
    fn fixed_liquid(&self, v: f64, p: Scalar, t: Scalar) -> hs::Result<hs::WaterChart> {
        self.fixed.set(self.fixed.get() + 1);
        hs::Properties::fixed_liquid(&If97, v, p, t)
    }
}

fn n(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("missing {key}"))
}
fn a<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().unwrap().as_slice()
}
fn i(v: &Value, key: &str) -> usize {
    v[key].as_u64().unwrap() as usize
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn vecn(v: &Value, key: &str) -> Vec<f64> {
    a(v, key).iter().map(|v| v.as_f64().unwrap()).collect()
}
fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!(actual.is_finite() && expected.is_finite());
    assert!(
        (actual - expected).abs() <= tolerance * expected.abs().max(1.),
        "{actual} vs {expected}"
    );
}
fn geometry(v: &Value) -> thermal::FuelGeometry {
    thermal::FuelGeometry {
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
fn groups(v: &Value, key: &str) -> Vec<heat_history::Group> {
    a(v, key)
        .iter()
        .map(|g| heat_history::Group {
            decay_per_s: n(g, "decay_per_s"),
            retained_joules_per_event: n(g, "retained_joules_per_event"),
        })
        .collect()
}
fn contact(v: &Value, edges: &[pressure::Edge], areas: &[f64]) -> hs::Contact {
    let water = i(v, "water");
    hs::Contact {
        water,
        area: n(v, "area_m2"),
        diameter: n(v, "hydraulic_diameter_m"),
        flow_area: areas[water],
        flow: edges
            .iter()
            .enumerate()
            .filter(|(_, e)| e.from == water || e.to == water)
            .map(|(edge, _)| hs::FlowTerm { edge, weight: 0.5 })
            .collect(),
    }
}
fn model(packet: &Value) -> hs::Model {
    let t = &packet["thermal"];
    let hot = &packet["hot"];
    let e = &hot["energy"];
    let source = &hot["source"];
    let m = &packet["feedback_metadata"];
    let parameters: sf::Parameters = serde_json::from_value(m["parameters"].clone()).unwrap();
    let regions: Vec<sf::Region> = serde_json::from_value(m["regions"].clone()).unwrap();
    let materials: Vec<sf::Material> = serde_json::from_value(m["materials"].clone()).unwrap();
    let supports: Vec<sf::Support> = serde_json::from_value(m["supports"].clone()).unwrap();
    let native_g = vecn(&source["inputs"], "fissions_per_population_s");
    let mut regional_g = vec![0.; regions.len()];
    for (edge, support) in supports.iter().enumerate() {
        close(
            native_g[edge] / support.production_reference_per_s,
            1.,
            2e-12,
        );
        regional_g[support.region] += native_g[edge];
    }
    for (region, gamma) in a(source, "regions").iter().zip(regional_g) {
        let inferred_nu = 1. / (n(region, "generation_time_s") * gamma);
        close(inferred_nu / parameters.nu_effective, 1., 2e-12);
    }
    let sigma = n(e, "fission_cross_section_m2");
    for support in &supports {
        let expected = support.production_reference_per_s
            / (sigma * materials[support.material].reference_fissile_atoms);
        close(support.exposure_per_population_s_m2 / expected, 1., 2e-12);
    }
    for region in a(source, "regions") {
        close(
            n(region, "generation_time_s"),
            parameters.generation_time_s,
            1e-14,
        );
    }
    close(
        parameters.sigma_xe_m2 / n(e, "xenon_cross_section_m2"),
        1.,
        1e-14,
    );
    close(
        parameters.sigma_sm_m2 / n(e, "samarium_cross_section_m2"),
        1.,
        1e-14,
    );
    let feedback = sf::Model::new(parameters, regions, materials, supports).unwrap();
    let kinetics = kinetics::Model::new(
        serde_json::from_value(source["regions"].clone()).unwrap(),
        serde_json::from_value(source["materials"].clone()).unwrap(),
        serde_json::from_value(source["transfers"].clone()).unwrap(),
        serde_json::from_value(source["supports"].clone()).unwrap(),
    )
    .unwrap();
    let edges: Vec<pressure::Edge> = packet["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| pressure::Edge {
            from: i(e, "from"),
            to: i(e, "to"),
        })
        .collect();
    let areas = vecn(packet, "water_flow_area_m2");
    let source_water = a(packet, "source_water")
        .iter()
        .map(|v| v.as_u64().unwrap() as usize)
        .collect::<Vec<_>>();
    let native_support = a(source, "supports");
    let emission = vecn(&source["inputs"], "emission_fractions");
    let bands = a(t, "fuel_bands")
        .iter()
        .enumerate()
        .map(|(band, b)| {
            assert_eq!(b["id"], e["carriers"][band]["id"]);
            let masses = vecn(b, "fuel_masses_kg");
            assert_eq!(masses.len(), 2);
            close(masses[0], masses[1], 1e-14);
            let mut deposition = std::collections::BTreeMap::new();
            for (k, support) in native_support
                .iter()
                .enumerate()
                .filter(|(_, s)| i(s, "material") == band)
            {
                *deposition
                    .entry(source_water[i(support, "region")])
                    .or_insert(0.) += emission[k];
            }
            hs::Band {
                geometry: geometry(&b["geometry"]),
                helium: i(b, "helium"),
                fuel_mass: [masses[0], masses[1]],
                clad_mass: n(b, "clad_mass_kg"),
                contacts: a(t, "core_contacts")
                    .iter()
                    .filter(|c| i(c, "band") == band)
                    .map(|c| contact(c, &edges, &areas))
                    .collect(),
                deposition: deposition.into_iter().collect(),
            }
        })
        .collect();
    let passive = a(t, "passive_stores");
    let solid = |v: &Value| {
        passive
            .iter()
            .position(|p| p["id"] == v["store_id"])
            .unwrap()
    };
    let sg=a(t,"sg_segments").iter().map(|v| {
        let w=i(v,"primary");
        let contact_value=serde_json::json!({"water":w,"area_m2":n(v,"area_m2"),"hydraulic_diameter_m":n(v,"thermal_diameter_m")});
        hs::SgSegment {contact:contact(&contact_value,&edges,&areas),secondary:i(v,"secondary"),start:n(v,"developed_start_m"),
            end:n(v,"developed_end_m"),capacity:n(v,"capacity_j_k")}
    }).collect();
    let capture_groups = groups(e, "capture_groups");
    let capture_energy = capture_groups
        .iter()
        .map(|g| g.retained_joules_per_event)
        .sum();
    hs::Model {
        feedback,
        heat: hs::Heat {
            fission: heat_history::Model::new(
                n(e, "fission_joules_per_event"),
                groups(e, "fission_groups"),
            )
            .unwrap(),
            fertile: heat_history::Model::new(capture_energy, capture_groups).unwrap(),
            capture: capture::Parameters {
                cross_section_m2: n(e, "fertile_cross_section_m2"),
                binding_joules_per_capture: n(e, "fertile_binding_joules_per_capture"),
            },
            binding_coolant_fraction: n(e, "binding_coolant_fraction"),
            prompt_coolant_fraction: n(e, "prompt_fission_coolant_fraction"),
            xenon_binding_j: n(e, "xenon_binding_joules_per_capture"),
            samarium_binding_j: n(e, "samarium_binding_joules_per_capture"),
            xenon_cross_section: n(e, "xenon_cross_section_m2"),
            samarium_cross_section: n(e, "samarium_cross_section_m2"),
            poison: poisons::Model::new(poisons::Parameters {
                decay_per_s: vecn(e, "poison_decay_per_s").try_into().unwrap(),
                direct_atoms_per_fission: vecn(e, "poison_yields_per_fission").try_into().unwrap(),
            })
            .unwrap(),
        },
        bands,
        helium_nr: a(t, "helium").iter().map(|v| n(v, "nr_j_k")).collect(),
        passive_mass: passive.iter().map(|v| n(v, "mass_kg")).collect(),
        passive_contacts: a(t, "passive_contacts")
            .iter()
            .map(|v| hs::PassiveContact {
                solid: solid(v),
                water: i(v, "water"),
                area: n(v, "area_m2"),
                liquid_h: n(v, "liquid_h_w_m2_k"),
                log_radius: n(v, "wall_log_radius_m"),
            })
            .collect(),
        plenum_contacts: a(t, "plenum_contacts")
            .iter()
            .map(|v| hs::PlenumContact {
                helium: i(v, "helium"),
                solid: solid(v),
                area: n(v, "area_m2"),
                radius: n(v, "inner_radius_m"),
                conduction_factor: n(v, "conduction_factor"),
            })
            .collect(),
        sg,
        volumes: a(t, "water").iter().map(|v| n(v, "volume_m3")).collect(),
        source_water,
        edges,
        secondaries: a(t, "secondaries").len(),
        reference_fertile: a(e, "carriers")
            .iter()
            .map(|v| n(v, "fertile_atoms"))
            .collect(),
        kinetics,
        transfer_rates: vecn(&source["inputs"], "transfer_rates_per_s"),
        emission,
        outside: vecn(&source["inputs"], "outside_fractions"),
    }
}

#[derive(Clone)]
struct Current {
    fuel: Vec<hs::FuelState>,
    helium: Vec<Scalar>,
    passive: Vec<Scalar>,
    sg: Vec<Scalar>,
    fuel_u: Vec<[Scalar; 3]>,
    helium_u: Vec<Scalar>,
    passive_u: Vec<Scalar>,
    sg_u: Vec<Scalar>,
    pressure: Scalar,
    water_t: Vec<Scalar>,
    water_u: Vec<Scalar>,
    boron: Vec<Scalar>,
    flow: Vec<Scalar>,
    neutrons: Vec<Scalar>,
    material: Vec<hs::Material>,
    precursors: Vec<Scalar>,
    history: Vec<Vec<Scalar>>,
    rods: Vec<Scalar>,
    age: Scalar,
    secondary: Vec<hs::Secondary>,
}
impl Current {
    fn from_packet(packet: &Value, model: &hs::Model) -> Self {
        let t = &packet["thermal"];
        let carriers = a(&packet["hot"]["energy"], "carriers");
        let prepared = vecn(&packet["hot"]["source"], "prepared_state");
        let fuel = a(t, "fuel_bands")
            .iter()
            .map(|b| {
                let f = vecn(b, "fuel_temperatures_k");
                let seed = vecn(b, "surface_seed_k");
                hs::FuelState {
                    inner: s(f[0]),
                    outer: s(f[1]),
                    surface: s(seed[0]),
                    clad_inner: s(seed[1]),
                    clad_mean: s(n(b, "clad_temperature_k")),
                    clad_outer: s(seed[2]),
                }
            })
            .collect();
        let scalar =
            |values: &[Value], key: &str| values.iter().map(|v| s(n(v, key))).collect::<Vec<_>>();
        Self {
            fuel,
            helium: scalar(a(t, "helium"), "temperature_k"),
            passive: scalar(a(t, "passive_stores"), "temperature_k"),
            sg: scalar(a(t, "sg_segments"), "temperature_k"),
            fuel_u: a(t, "fuel_bands")
                .iter()
                .map(|b| {
                    let u = vecn(b, "fuel_energies_j");
                    [s(u[0]), s(u[1]), s(n(b, "clad_energy_j"))]
                })
                .collect(),
            helium_u: scalar(a(t, "helium"), "energy_j"),
            passive_u: scalar(a(t, "passive_stores"), "energy_j"),
            sg_u: scalar(a(t, "sg_segments"), "energy_j"),
            pressure: s(n(&t["water"][0], "pressure_pa")),
            water_t: scalar(a(t, "water"), "temperature_k"),
            water_u: scalar(a(t, "water"), "energy_j"),
            boron: vecn(packet, "water_boron_amount_kg_eq")
                .into_iter()
                .map(s)
                .collect(),
            // Explicit numerical current-flow seed, not zero expansion or a
            // solved pressure chart. Continuity defects remain in the output.
            flow: vec![s(0.); model.edges.len()],
            neutrons: prepared[..24].iter().copied().map(s).collect(),
            precursors: prepared[24..].iter().copied().map(s).collect(),
            material: carriers
                .iter()
                .map(|c| {
                    let p = vecn(c, "poison_atoms");
                    hs::Material {
                        fissile: s(n(c, "fissile_atoms")),
                        fertile: s(n(c, "fertile_atoms")),
                        iodine: s(p[0]),
                        xenon: s(p[1]),
                        promethium: s(p[2]),
                        samarium: s(p[3]),
                    }
                })
                .collect(),
            history: carriers
                .iter()
                .map(|c| vecn(c, "stores_j").into_iter().map(s).collect())
                .collect(),
            rods: vecn(&packet["feedback_reference"], "achievedRodTravel_m")
                .into_iter()
                .map(s)
                .collect(),
            age: s(n(&packet["feedback_reference"], "capsuleAge_s")),
            secondary: a(t, "secondaries")
                .iter()
                .map(|c| hs::Secondary {
                    pressure: s(n(c, "pressure_pa")),
                    temperature: s(n(c, "temperature_k")),
                    liquid_volume: s(n(c, "liquid_volume_m3")),
                    steam_present: true,
                })
                .collect(),
        }
    }
    fn state(&self) -> hs::State<'_> {
        hs::State {
            fuel: &self.fuel,
            helium_t: &self.helium,
            passive_t: &self.passive,
            sg_t: &self.sg,
            fuel_u: &self.fuel_u,
            helium_u: &self.helium_u,
            passive_u: &self.passive_u,
            sg_u: &self.sg_u,
            pressure: self.pressure,
            water_t: &self.water_t,
            water_u: &self.water_u,
            boron_amount: &self.boron,
            face_flow: &self.flow,
            neutron_population: &self.neutrons,
            material: &self.material,
            precursors: &self.precursors,
            history: &self.history,
            rods: &self.rods,
            age: self.age,
            secondary: &self.secondary,
        }
    }
    fn shift(&self, h: f64) -> Self {
        let mut x = self.clone();
        let shift = |s: &mut Scalar| {
            s.value += h * s.direction;
            s.direction = 0.;
        };
        for f in &mut x.fuel {
            for v in [
                &mut f.inner,
                &mut f.outer,
                &mut f.surface,
                &mut f.clad_inner,
                &mut f.clad_mean,
                &mut f.clad_outer,
            ] {
                shift(v);
            }
        }
        for v in x
            .helium
            .iter_mut()
            .chain(&mut x.passive)
            .chain(&mut x.sg)
            .chain(x.fuel_u.iter_mut().flatten())
            .chain(&mut x.helium_u)
            .chain(&mut x.passive_u)
            .chain(&mut x.sg_u)
            .chain(&mut x.water_t)
            .chain(&mut x.water_u)
            .chain(&mut x.boron)
            .chain(&mut x.flow)
            .chain(&mut x.neutrons)
            .chain(&mut x.precursors)
            .chain(x.history.iter_mut().flatten())
            .chain(&mut x.rods)
        {
            shift(v);
        }
        for m in &mut x.material {
            for v in [
                &mut m.fissile,
                &mut m.fertile,
                &mut m.iodine,
                &mut m.xenon,
                &mut m.promethium,
                &mut m.samarium,
            ] {
                shift(v);
            }
        }
        for secondary in &mut x.secondary {
            for v in [
                &mut secondary.pressure,
                &mut secondary.temperature,
                &mut secondary.liquid_volume,
            ] {
                shift(v);
            }
            // This actual secondary lies on the selected saturated M/U chart.
            // A linear finite offset in both p and Ts can land a few ulps above
            // saturation; the independent probe follows the actual same chart.
            secondary.temperature = If97.saturation(secondary.pressure).unwrap().temperature;
        }
        shift(&mut x.pressure);
        shift(&mut x.age);
        x
    }
    fn initialize(&mut self, model: &hs::Model) {
        let before = self.finite_stocks();
        for (i, b) in model.bands.iter().enumerate() {
            let f = self.fuel[i];
            let fixed = thermal::FuelTemperatures {
                inner_mean: f.inner,
                outer_mean: f.outer,
                fuel_surface: f.surface,
                helium: self.helium[b.helium],
                clad_inner: f.clad_inner,
                clad_mean: f.clad_mean,
                clad_outer: f.clad_outer,
            };
            let wall = |outer: Scalar| -> thermal::Result<Scalar> {
                let mut heat = s(0.);
                let density = b.clad_mass
                    / (std::f64::consts::PI
                        * (b.geometry.clad_outer_radius_m.powi(2)
                            - b.geometry.clad_inner_radius_m.powi(2))
                        * b.geometry.rod_length_m
                        * b.geometry.rods);
                for c in &b.contacts {
                    let flux = c
                        .flow
                        .iter()
                        .fold(s(0.), |sum, t| sum + self.flow[t.edge] * s(t.weight))
                        / s(c.flow_area);
                    let q = thermal::liquid_wall(
                        &If97,
                        self.pressure,
                        self.water_t[c.water],
                        outer,
                        flux,
                        thermal::WallLaw {
                            diameter_m: c.diameter,
                            film: thermal::Film::Core,
                            emissivity: b.geometry.clad_emissivity,
                            material: thermal::core_wall_material(f.clad_mean, density)?,
                        },
                    )?;
                    if q.vapor_mass.value != 0. {
                        return Err("initial primary phase birth");
                    }
                    heat = heat + s(c.area) * q.heat;
                }
                Ok(heat)
            };
            let solved = initialization::initialize_fuel_surfaces(
                &b.geometry,
                fixed,
                [f.surface.value, f.clad_inner.value, f.clad_outer.value],
                initialization::SurfacePolicy {
                    maximum_residual_w: 1e-3,
                    maximum_correction_k: 1e-6,
                    maximum_iterations: 16,
                    maximum_backtracks: 12,
                },
                wall,
            )
            .unwrap();
            self.fuel[i].surface = solved.temperatures.fuel_surface;
            self.fuel[i].clad_inner = solved.temperatures.clad_inner;
            self.fuel[i].clad_outer = solved.temperatures.clad_outer;
        }
        assert_eq!(
            before,
            self.finite_stocks(),
            "initialization altered finite stocks or histories"
        );
    }
    fn finite_stocks(&self) -> Vec<u64> {
        self.fuel_u
            .iter()
            .flatten()
            .chain(&self.helium_u)
            .chain(&self.passive_u)
            .chain(&self.sg_u)
            .chain(&self.water_u)
            .chain(&self.boron)
            .chain(&self.neutrons)
            .chain(&self.precursors)
            .chain(self.history.iter().flatten())
            .copied()
            .chain(self.material.iter().flat_map(|m| {
                [
                    m.fissile,
                    m.fertile,
                    m.iodine,
                    m.xenon,
                    m.promethium,
                    m.samarium,
                ]
            }))
            .map(|s| s.value.to_bits())
            .collect()
    }
}
fn evaluate(model: &hs::Model, x: &Current) -> hs::Work {
    try_evaluate(model, x, None).unwrap()
}
fn try_evaluate(model: &hs::Model, x: &Current, offset: Option<f64>) -> hs::Result<hs::Work> {
    let mut w = model.workspace()?;
    let seed = |value: f64, direction: f64| match offset {
        None => Scalar::new(value, direction),
        Some(h) => s(value + h * direction),
    };
    let f = (0..model.bands.len())
        .map(|i| {
            [
                seed(1e4 + i as f64, 100.),
                seed(2e4 + i as f64, 200.),
                seed(3e4 + i as f64, 300.),
            ]
        })
        .collect::<Vec<_>>();
    let he = vec![seed(10., 0.1); model.helium_nr.len()];
    let p = vec![seed(20., 0.2); model.passive_mass.len()];
    let sg = vec![seed(1e5, 1000.); model.sg.len()];
    let water = (0..model.volumes.len())
        .map(|i| seed(1e6 * (1. + 0.02 * i as f64), 1000. * (1. + 0.01 * i as f64)))
        .collect::<Vec<_>>();
    let zero = vec![s(0.); model.volumes.len()];
    model.evaluate(
        &If97,
        x.state(),
        hs::Rates {
            fuel: &f,
            helium: &he,
            passive: &p,
            sg: &sg,
            pressure: seed(1e4, 100.),
            water: &water,
            boron: &zero,
        },
        hs::External {
            mass: &zero,
            energy: &zero,
            boron: &zero,
        },
        &mut w,
    )?;
    Ok(w)
}
fn flatten(w: &hs::Work) -> Vec<Scalar> {
    w.fuel_rhs
        .iter()
        .flatten()
        .chain(&w.helium_rhs)
        .chain(&w.passive_rhs)
        .chain(&w.sg_rhs)
        .chain(&w.water_rhs)
        .chain(&w.boron_rhs)
        .chain(&w.secondary_heat)
        .chain(w.surface.iter().flatten())
        .chain(w.fuel_residual.iter().flatten())
        .chain(&w.helium_residual)
        .chain(&w.passive_residual)
        .chain(&w.sg_residual)
        .chain(&w.water_residual)
        .chain(&w.continuity)
        .chain(&w.caloric)
        .chain(&w.boron_residual)
        .chain(w.fuel_caloric.iter().flatten())
        .chain(&w.helium_caloric)
        .chain(&w.passive_caloric)
        .chain(&w.sg_caloric)
        .chain(&w.nuclear_rates)
        .chain(w.poison_rates.iter().flatten())
        .chain(&w.fissile_rates)
        .chain(&w.fertile_rates)
        .chain(&w.capture_product_rates)
        .chain(w.history_rates.iter().flatten())
        .chain(&w.fuel_heat)
        .chain(&w.coolant_heat)
        .chain(&w.feedback.carrier_fissions_per_s)
        .chain(&w.feedback.exposure_per_m2_s)
        .copied()
        .chain(
            w.feedback
                .regions
                .iter()
                .flat_map(|r| [r.reactivity, r.external_source_per_s]),
        )
        .chain([w.event_heat, w.released_heat, w.stored_history_rate])
        .collect()
}
fn label(mut index: usize, w: &hs::Work) -> (&'static str, usize) {
    let a = w.fuel_rhs.len();
    for (name, length) in [
        ("fuel_rhs_W", 3 * a),
        ("helium_rhs_W", w.helium_rhs.len()),
        ("passive_rhs_W", w.passive_rhs.len()),
        ("sg_rhs_W", w.sg_rhs.len()),
        ("water_rhs_W", w.water_rhs.len()),
        ("boron_rhs_kgEq_s", w.boron_rhs.len()),
        ("secondary_heat_W", w.secondary_heat.len()),
        ("surface_W", 3 * a),
        ("fuel_residual_W", 3 * a),
        ("helium_residual_W", w.helium_residual.len()),
        ("passive_residual_W", w.passive_residual.len()),
        ("sg_residual_W", w.sg_residual.len()),
        ("water_residual_W", w.water_residual.len()),
        ("continuity_kg_s", w.continuity.len()),
        ("water_caloric_J", w.caloric.len()),
        ("boron_residual_kgEq_s", w.boron_residual.len()),
        ("fuel_caloric_J", 3 * a),
        ("helium_caloric_J", w.helium_caloric.len()),
        ("passive_caloric_J", w.passive_caloric.len()),
        ("sg_caloric_J", w.sg_caloric.len()),
        ("nuclear_rates_equiv_s", w.nuclear_rates.len()),
        ("poison_rates_atoms_s", 4 * a),
        ("fissile_rates_atoms_s", a),
        ("fertile_rates_atoms_s", a),
        ("capture_product_rates_atoms_s", a),
        ("history_rates_W", 25 * a),
        ("fuel_heat_W", a),
        ("coolant_heat_W", a),
        ("carrier_fissions_s", a),
        ("exposure_m2_s", a),
        ("region_feedback_rho_S", 2 * w.feedback.regions.len()),
        ("event_released_stored_heat_W", 3),
    ] {
        if index < length {
            return (name, index);
        }
        index -= length;
    }
    panic!("unknown output index")
}
fn snapshot(w: &hs::Work) -> Vec<[u64; 2]> {
    flatten(w)
        .into_iter()
        .chain(w.feedback.fissions_per_population_s.iter().copied())
        .chain(w.feedback.rod_overlap.iter().copied())
        .chain(
            w.feedback
                .poison_capture_per_s
                .iter()
                .flat_map(|p| [p.xenon, p.samarium]),
        )
        .chain(w.water.iter().flat_map(|p| {
            [
                p.mass,
                p.energy,
                p.density,
                p.projection.mass_p_at_energy,
                p.projection.mass_energy_at_pressure,
                p.projection.enthalpy,
            ]
        }))
        .map(|v| [v.value.to_bits(), v.direction.to_bits()])
        .collect()
}
fn verify_current_bulk(w: &hs::Work, x: &Current) {
    for (owner, (actual, t)) in w.water.iter().zip(&x.water_t).enumerate() {
        let expected = If97.liquid(x.pressure, *t).unwrap();
        for (name, actual, expected) in [
            ("density", actual.thermal.density, expected.density),
            ("viscosity", actual.thermal.viscosity, expected.viscosity),
            (
                "conductivity",
                actual.thermal.conductivity,
                expected.conductivity,
            ),
            ("cp", actual.thermal.cp, expected.cp),
            ("expansion", actual.thermal.expansion, expected.expansion),
            ("enthalpy", actual.thermal.enthalpy, expected.enthalpy),
        ] {
            assert_eq!(
                [actual.value.to_bits(), actual.direction.to_bits()],
                [expected.value.to_bits(), expected.direction.to_bits()],
                "same-call thermal tuple owner{owner} {name}"
            );
        }
    }
}
fn fingerprint(values: &[[u64; 2]]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for bits in values.iter().flatten() {
        for byte in bits.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}
fn budget(w: &hs::Work) {
    let sum = |values: &[Scalar]| values.iter().copied().fold(s(0.), |a, b| a + b);
    let thermal = w
        .fuel_rhs
        .iter()
        .flatten()
        .copied()
        .fold(s(0.), |a, b| a + b)
        + sum(&w.helium_rhs)
        + sum(&w.passive_rhs)
        + sum(&w.sg_rhs)
        + sum(&w.water_rhs)
        + sum(&w.secondary_heat);
    close(thermal.value, w.released_heat.value, 2e-11);
    close(thermal.direction, w.released_heat.direction, 2e-10);
    close(
        (w.released_heat + w.stored_history_rate).value,
        w.event_heat.value,
        2e-11,
    );
    close(
        (w.released_heat + w.stored_history_rate).direction,
        w.event_heat.direction,
        2e-10,
    );
}

/// Independent dense conservation oracle, TEST ONLY. This checks the exact
/// small fixed-donor pressure chart at FROZEN heat(q_trial); it does not replace
/// q_trial in the thermal stage or claim a simultaneous pressure/heat solution.
fn pressure_oracle(model: &hs::Model, x: &Current, w: &hs::Work) -> (f64, f64) {
    let tree = pressure::Tree::new(model.volumes.len(), model.edges.clone(), 0).unwrap();
    let regions = w.water.iter().map(|q| q.projection).collect::<Vec<_>>();
    let mut heat = w.water_rhs.clone();
    for (edge, face) in model.edges.iter().enumerate() {
        let q = x.flow[edge];
        let donor = if q.value >= 0. { face.from } else { face.to };
        let advected = q * regions[donor].enthalpy;
        heat[face.from] = heat[face.from] + advected;
        heat[face.to] = heat[face.to] - advected;
    }
    let external = vec![s(0.); model.volumes.len()];
    let chord = tree.chords().iter().map(|e| x.flow[*e]).collect::<Vec<_>>();
    let mut donors = model.edges.iter().map(|e| e.from).collect::<Vec<_>>();
    let mut projected = tree.workspace();
    let mut complete = false;
    for _ in 0..=model.edges.len() {
        match tree.project(&regions, &heat, &external, &chord, &donors, &mut projected) {
            Ok(()) => {
                complete = true;
                break;
            }
            Err(pressure::Error::InconsistentDonor(_)) => {
                for (e, q) in projected.flows.iter().enumerate() {
                    if q.value != 0. {
                        donors[e] = if q.value > 0. {
                            model.edges[e].from
                        } else {
                            model.edges[e].to
                        };
                    }
                }
            }
            other => panic!("actual fixed-donor pressure chart {other:?}"),
        }
    }
    assert!(complete, "actual pressure donor branches did not close");
    let maximum_defect = projected
        .defects
        .iter()
        .map(|r| r.value.abs())
        .fold(0., f64::max);
    assert!(
        maximum_defect < 1e-8,
        "actual differentiated continuity {maximum_defect}"
    );
    let tree_edges = (0..model.edges.len())
        .filter(|e| !tree.chords().contains(e))
        .collect::<Vec<_>>();
    let n = model.volumes.len();
    assert_eq!(tree_edges.len() + 1, n);
    let mut matrix = vec![vec![0.; n + 1]; n];
    for (i, r) in regions.iter().enumerate() {
        // MPa/s column scaling is numerical conditioning, not a pressure law.
        matrix[i][0] = r.mass_p_at_energy.value * 1e6;
        matrix[i][n] = -r.mass_energy_at_pressure.value * heat[i].value;
    }
    for (e, face) in model.edges.iter().enumerate() {
        for (i, sign) in [(face.from, -1.), (face.to, 1.)] {
            let coefficient = sign
                * (regions[i].mass_energy_at_pressure.value * regions[donors[e]].enthalpy.value
                    - 1.);
            if let Some(column) = tree_edges.iter().position(|t| *t == e) {
                matrix[i][column + 1] += coefficient;
            } else {
                matrix[i][n] -= coefficient * x.flow[e].value;
            }
        }
    }
    for column in 0..n {
        let pivot = (column..n)
            .max_by(|i, j| {
                matrix[*i][column]
                    .abs()
                    .total_cmp(&matrix[*j][column].abs())
            })
            .unwrap();
        assert!(matrix[pivot][column].abs() > 1e-20);
        matrix.swap(column, pivot);
        let scale = matrix[column][column];
        for value in matrix[column].iter_mut().skip(column) {
            *value /= scale;
        }
        let pivot_row = matrix[column].clone();
        for (index, row) in matrix.iter_mut().enumerate() {
            if index == column {
                continue;
            }
            let factor = row[column];
            for (value, pivot) in row.iter_mut().zip(&pivot_row).skip(column) {
                *value -= factor * pivot;
            }
        }
    }
    close(matrix[0][n] * 1e6, projected.pressure_rate.value, 2e-10);
    for (column, e) in tree_edges.iter().enumerate() {
        close(matrix[column + 1][n], projected.flows[*e].value, 2e-10);
    }
    let maximum_flow_change = projected
        .flows
        .iter()
        .zip(&x.flow)
        .map(|(a, b)| (a.value - b.value).abs())
        .fold(0., f64::max);
    (maximum_defect, maximum_flow_change)
}

// Test-only assembly of the actual three-territory transport call. The current
// node velocities and phase face currents are independent Newton trial inputs:
// this deliberately supplies no unselected pressure/kinematic force stencil.
struct SurgePzrReplay {
    field: pf::Model,
    junction: usize,
    mouth: usize,
    line_volume: f64,
    line_state: surge::State,
    pzr_pressure: Scalar,
    pzr_temperature: [Scalar; pf::REGIONS],
    liquid: [bool; pf::REGIONS],
    retained_energy: [f64; pf::REGIONS],
    retained_boron: [Scalar; pf::REGIONS],
    phase: [[Option<pf::Phase>; 2]; pf::REGIONS],
    face_flow: [[Scalar; 2]; pf::FACES],
    external: [[pf::Sources; 2]; pf::REGIONS],
    field_work: pf::Work,
    hot_work: hs::Work,
    fuel_rate: Vec<[Scalar; 3]>,
    helium_rate: Vec<Scalar>,
    passive_rate: Vec<Scalar>,
    sg_rate: Vec<Scalar>,
    zero: Vec<Scalar>,
    external_mass: Vec<Scalar>,
    external_energy: Vec<Scalar>,
    external_boron: Vec<Scalar>,
}
impl SurgePzrReplay {
    fn new(packet: &Value, model: &hs::Model) -> Self {
        let p = &packet["pzr"];
        let region = a(p, "regions");
        let face = a(p, "faces");
        assert_eq!(region.len(), pf::REGIONS);
        assert_eq!(face.len(), pf::FACES);
        let regions = std::array::from_fn(|j| pf::Region {
            volume_m3: n(&region[j], "volume_m3"),
            axial_area_m2: n(&region[j], "axialArea_m2"),
            height_m: n(&region[j], "top_m") - n(&region[j], "bottom_m"),
            solid_perimeter_m: n(&region[j], "solidPerimeter_m"),
            elevation_m: n(&region[j], "elevation_m"),
        });
        let faces = std::array::from_fn(|j| {
            assert_eq!(face[j]["contrastContact"], true);
            let normal = vecn(&face[j], "normal");
            pf::Face {
                from: i(&face[j], "from"),
                to: i(&face[j], "to"),
                area_m2: n(&face[j], "area_m2"),
                distance_m: n(&face[j], "distance_m"),
                normal: [normal[0], normal[1]],
            }
        });
        let port = &packet["external_ports"];
        let line = &port["surge_stock"];
        for owner in region.iter().chain(std::iter::once(line)) {
            assert_eq!(
                n(owner, "airMass_kg"),
                0.,
                "pure-water replay cannot omit air"
            );
            assert_eq!(
                n(owner, "nitrogenMass_kg"),
                0.,
                "pure-water replay cannot omit nitrogen"
            );
        }
        let count = model.volumes.len();
        Self {
            field: pf::Model::new(
                regions,
                faces,
                n(&p["selection"], "interfacialLength_m"),
                n(&p["selection"], "solidRoughness_m"),
                // Owned contrast contact is exactly Af*|alpha_l,a-alpha_l,b|.
                1.,
            )
            .unwrap(),
            junction: i(&port["primary_to_surge"], "primary_water"),
            mouth: i(&port["surge_to_pzr"], "pzr_water"),
            line_volume: n(line, "volume_m3"),
            line_state: surge::State {
                pressure: Scalar::new(n(line, "pressure_Pa"), 700.),
                temperature: Scalar::new(n(line, "temperature_K"), 0.07),
                energy: s(n(line, "internalEnergy_J")),
                boron: Scalar::new(n(line, "absorberTracer_kgEq"), 0.0001),
            },
            pzr_pressure: Scalar::new(n(&p["selection"], "commonPressure_Pa"), -500.),
            pzr_temperature: std::array::from_fn(|j| {
                Scalar::new(n(&region[j]["water"], "T"), 0.03 + j as f64 * 0.002)
            }),
            liquid: std::array::from_fn(|j| region[j]["initialPhase"] == "liquid"),
            retained_energy: std::array::from_fn(|j| {
                n(&region[j], "liquidEnergy_J") + n(&region[j], "vaporEnergy_J")
            }),
            retained_boron: std::array::from_fn(|j| {
                let b = n(&region[j], "absorberTracer_kgEq");
                if region[j]["initialPhase"] == "vapor" {
                    assert_eq!(b, 0., "PZR vapor cannot carry dissolved tracer");
                    s(0.)
                } else {
                    Scalar::new(b, 0.00001 * (j + 1) as f64)
                }
            }),
            phase: [[None; 2]; pf::REGIONS],
            face_flow: [[s(0.); 2]; pf::FACES],
            external: [[pf::Sources::default(); 2]; pf::REGIONS],
            field_work: pf::Work::default(),
            hot_work: model.workspace().unwrap(),
            fuel_rate: vec![[s(0.); 3]; model.bands.len()],
            helium_rate: vec![s(0.); model.helium_nr.len()],
            passive_rate: vec![s(0.); model.passive_mass.len()],
            sg_rate: vec![s(0.); model.sg.len()],
            zero: vec![s(0.); count],
            external_mass: vec![s(0.); count],
            external_energy: vec![s(0.); count],
            external_boron: vec![s(0.); count],
        }
    }

    fn evaluate(
        &mut self,
        model: &hs::Model,
        current: &Current,
        currents: [f64; 2],
        offset: Option<f64>,
        zero_slip: bool,
    ) -> surge::Evaluation {
        let at = |v: Scalar| offset.map_or(v, |h| s(v.value + h * v.direction));
        let pp = at(self.pzr_pressure);
        let saturation = If97.saturation(pp).unwrap();
        for j in 0..pf::REGIONS {
            let k = usize::from(!self.liquid[j]);
            let t = at(self.pzr_temperature[j]);
            // Exact absence: do not recover or query the other phase.
            let water = if k == 0 {
                If97.liquid(pp, t)
            } else {
                If97.vapor(pp, t)
            }
            .unwrap();
            let volume = s(self.field.regions()[j].volume_m3);
            let sign = if k == 0 { 1. } else { -1. };
            let velocity = if zero_slip {
                [s(0.); 2]
            } else {
                [
                    at(Scalar::new(sign * 0.001 * (j + 1) as f64, 0.00001)),
                    at(Scalar::new(sign * 0.003 * (j + 1) as f64, -0.00002)),
                ]
            };
            self.phase[j] = [None; 2];
            self.phase[j][k] = Some(pf::Phase {
                mass: water.density * volume,
                volume,
                temperature: t,
                water,
                velocity,
                // Actual finite prepared/current amount, not a ppm reset to
                // each freshly recovered EOS mass. Vapor amount is exactly0.
                boron_mass: at(self.retained_boron[j]),
            });
        }
        for (j, face) in self.field.faces().iter().enumerate() {
            for k in 0..2 {
                // Actual separate phase transport, including responsible
                // arrivals into absent recipients. Never withdraw an absence.
                let sign = match (self.phase[face.from][k], self.phase[face.to][k]) {
                    (Some(_), Some(_)) => {
                        if j % 2 == 0 {
                            1.
                        } else {
                            -1.
                        }
                    }
                    (Some(_), None) => 1.,
                    (None, Some(_)) => -1.,
                    (None, None) => 0.,
                };
                self.face_flow[j][k] = if sign == 0. {
                    s(0.)
                } else {
                    at(Scalar::new(sign * (0.01 + j as f64 * 0.001), sign * 0.0001))
                };
            }
        }
        let primary = hs::Properties::fixed_liquid(
            &If97,
            model.volumes[self.junction],
            current.pressure,
            current.water_t[self.junction],
        )
        .unwrap();
        let pzr_liquid = self.phase[self.mouth][0].map(|p| surge::Liquid {
            mass: p.mass,
            enthalpy: p.water.enthalpy,
            boron: p.boron_mass,
        });
        let line = surge::evaluate(
            &If97,
            self.line_volume,
            surge::State {
                pressure: at(self.line_state.pressure),
                temperature: at(self.line_state.temperature),
                energy: at(self.line_state.energy),
                boron: at(self.line_state.boron),
            },
            surge::Rates {
                pressure: s(0.),
                energy: s(0.),
                boron: s(0.),
            },
            surge::Liquid {
                mass: primary.mass,
                enthalpy: primary.projection.enthalpy,
                boron: current.boron[self.junction],
            },
            pzr_liquid,
            at(Scalar::new(currents[0], 0.02)),
            at(Scalar::new(currents[1], -0.03)),
            s(0.), // No unowned wall, pressure, drag, or balancing heat.
        )
        .unwrap();
        self.external_mass.fill(s(0.));
        self.external_energy.fill(s(0.));
        self.external_boron.fill(s(0.));
        self.external_mass[self.junction] = line.primary.mass;
        self.external_energy[self.junction] = line.primary.energy;
        self.external_boron[self.junction] = line.primary.boron;
        model
            .evaluate(
                &If97,
                current.state(),
                hs::Rates {
                    fuel: &self.fuel_rate,
                    helium: &self.helium_rate,
                    passive: &self.passive_rate,
                    sg: &self.sg_rate,
                    pressure: s(0.),
                    water: &self.zero,
                    boron: &self.zero,
                },
                hs::External {
                    mass: &self.external_mass,
                    energy: &self.external_energy,
                    boron: &self.external_boron,
                },
                &mut self.hot_work,
            )
            .unwrap();
        self.external.fill([pf::Sources::default(); 2]);
        self.external[self.mouth][0] = pf::Sources {
            mass: line.pzr_liquid.mass,
            enthalpy: line.pzr_liquid.energy,
            boron: line.pzr_liquid.boron,
            // EXCLUDED port momentum: this is only the M/H/B transport join.
            // Zero is an omitted component in this constitutive replay, NOT
            // an admitted zero physical mouth impulse or full force residual.
            momentum: [s(0.); 2],
        };
        self.field
            .evaluate(
                pf::Input {
                    pressure: pp,
                    saturation,
                    phase: &self.phase,
                    face_mass_flow: &self.face_flow,
                },
                &self.external,
                &mut self.field_work,
            )
            .unwrap();
        line
    }

    fn outputs(&self, line: surge::Evaluation) -> Vec<Scalar> {
        let mut values = flatten(&self.hot_work);
        values.extend(
            self.field_work
                .sources
                .iter()
                .flatten()
                .flat_map(|r| [r.mass, r.enthalpy, r.boron, r.momentum[0], r.momentum[1]]),
        );
        values.extend(
            self.field_work
                .birth_receipts
                .iter()
                .flatten()
                .flat_map(|r| [r.mass, r.enthalpy, r.boron, r.momentum[0], r.momentum[1]]),
        );
        values.extend(
            self.field_work
                .mass_defect_kg
                .iter()
                .flatten()
                .chain(&self.field_work.volume_defect_m3)
                .chain(self.field_work.wall_loss_w.iter().flatten())
                .chain(self.field_work.molecular_loss_w.iter().flatten())
                .chain(self.field_work.conversion_mixing_loss_w.iter().flatten())
                .chain(&self.field_work.slip_loss_w)
                .chain(self.field_work.gravity_power_w.iter().flatten())
                .copied(),
        );
        values.extend([
            line.primary.mass,
            line.primary.energy,
            line.primary.boron,
            line.pzr_liquid.mass,
            line.pzr_liquid.energy,
            line.pzr_liquid.boron,
            line.line.mass,
            line.line.energy,
            line.line.boron,
            line.caloric,
            line.continuity,
            line.energy_residual,
            line.boron_residual,
        ]);
        values
    }
}

fn actual_surge_pzr_join(packet: &Value, model: &hs::Model, current: &Current) -> Value {
    let mut replay = SurgePzrReplay::new(packet, model);
    let retained = current.finite_stocks();
    let line_stock = [
        replay.line_state.energy.value.to_bits(),
        replay.line_state.boron.value.to_bits(),
    ];
    let pzr_stock = replay.retained_energy.map(f64::to_bits);
    let pzr_boron_stock = replay.retained_boron.map(|b| b.value.to_bits());
    assert_ne!(current.pressure.value, replay.pzr_pressure.value);
    assert_eq!(replay.line_state.pressure.value, 15.2e6);
    assert_eq!(replay.pzr_pressure.value, 15e6);
    // Zero endpoint receipts at the same source/thermal point provide the
    // independent local primary ledger, not an initialized pressure solution.
    replay.evaluate(model, current, [0., 0.], Some(0.), false);
    let baseline_water = replay.hot_work.water_rhs.clone();
    let baseline_boron = replay.hot_work.boron_rhs.clone();
    let baseline_continuity = replay.hot_work.continuity.clone();
    let mut audit = Vec::new();
    for currents in [[2., -3.], [-2., 3.]] {
        let line = replay.evaluate(model, current, currents, None, false);
        assert!(line.linearizable);
        for j in 0..model.volumes.len() {
            let receipt = if j == replay.junction {
                line.primary
            } else {
                surge::Receipt::default()
            };
            for (actual, expected) in [
                (
                    replay.hot_work.water_rhs[j],
                    baseline_water[j] + receipt.energy,
                ),
                (
                    replay.hot_work.boron_rhs[j],
                    baseline_boron[j] + receipt.boron,
                ),
                (
                    replay.hot_work.continuity[j],
                    baseline_continuity[j] - receipt.mass,
                ),
            ] {
                close(actual.value, expected.value, 2e-13);
                close(actual.direction, expected.direction, 2e-13);
            }
        }
        let sum = |f: fn(&pf::Sources) -> Scalar| {
            replay
                .field_work
                .sources
                .iter()
                .flatten()
                .fold(s(0.), |a, b| a + f(b))
        };
        let mass = line.primary.mass + line.line.mass + sum(|s| s.mass);
        close(mass.value, 0., 1e-12);
        close(mass.direction, 0., 1e-12);
        for (primary, stored, pzr, total) in [
            (
                line.primary.mass,
                line.line.mass,
                line.pzr_liquid.mass,
                sum(|s| s.mass),
            ),
            (
                line.primary.energy,
                line.line.energy,
                line.pzr_liquid.energy,
                sum(|s| s.enthalpy),
            ),
            (
                line.primary.boron,
                line.line.boron,
                line.pzr_liquid.boron,
                sum(|s| s.boron),
            ),
        ] {
            for (value, expected) in [(total.value, pzr.value), (total.direction, pzr.direction)] {
                close(value, expected, 2e-10);
            }
            close(primary.value + stored.value + pzr.value, 0., 2e-9);
            close(
                primary.direction + stored.direction + pzr.direction,
                0.,
                2e-9,
            );
        }
        let heat = replay
            .hot_work
            .fuel_rhs
            .iter()
            .flatten()
            .chain(&replay.hot_work.helium_rhs)
            .chain(&replay.hot_work.passive_rhs)
            .chain(&replay.hot_work.sg_rhs)
            .chain(&replay.hot_work.water_rhs)
            .chain(&replay.hot_work.secondary_heat)
            .copied()
            .fold(s(0.), |a, b| a + b)
            + line.line.energy
            + sum(|s| s.enthalpy);
        close(heat.value, replay.hot_work.released_heat.value, 2e-12);
        close(
            heat.direction,
            replay.hot_work.released_heat.direction,
            2e-10,
        );
        let boron = replay
            .hot_work
            .boron_rhs
            .iter()
            .copied()
            .fold(s(0.), |a, b| a + b)
            + line.line.boron
            + sum(|s| s.boron);
        close(boron.value, 0., 1e-12);
        close(boron.direction, 0., 1e-12);
        assert_eq!(replay.field_work.zero_slip_inexact_contacts, 0);
        assert!(
            replay
                .field_work
                .birth_receipts
                .iter()
                .flatten()
                .any(|r| r.mass.value > 0.)
        );
        let analytic = replay.outputs(line);
        let epsilon = 0.002;
        let plus_line = replay.evaluate(
            model,
            &current.shift(epsilon),
            currents,
            Some(epsilon),
            false,
        );
        let plus = replay.outputs(plus_line);
        let minus_line = replay.evaluate(
            model,
            &current.shift(-epsilon),
            currents,
            Some(-epsilon),
            false,
        );
        let minus = replay.outputs(minus_line);
        let mut maximum = 0_f64;
        for (index, ((actual, plus), minus)) in analytic.iter().zip(plus).zip(minus).enumerate() {
            let numerical = (plus.value - minus.value) / (2. * epsilon);
            let defect = (actual.direction - numerical).abs()
                / actual.direction.abs().max(numerical.abs()).max(1.);
            maximum = maximum.max(defect);
            assert!(
                defect < 3e-5,
                "three-territory current direction index {index}: {} vs {numerical}, defect {defect}",
                actual.direction
            );
        }
        // Re-evaluate the SAME current point: no FD offset enters the receipt.
        let line = replay.evaluate(model, current, currents, None, false);
        let mut maximum_mass_rate_defect = 0_f64;
        let mut maximum_energy_rate_defect = 0_f64;
        for j in 0..pf::REGIONS {
            let k = usize::from(!replay.liquid[j]);
            let phase = replay.phase[j][k].unwrap();
            let wp = point(
                if k == 0 {
                    Branch::Liquid
                } else {
                    Branch::Vapor
                },
                replay.pzr_pressure.value,
                phase.temperature.value,
            )
            .unwrap()
            .phase_point();
            let chart = pzr::chart(
                replay.field.regions()[j].volume_m3,
                replay.pzr_pressure.value,
                k as f64,
                if k == 0 {
                    pzr::Active::Liquid
                } else {
                    pzr::Active::Vapor
                },
                if k == 0 { Some(wp) } else { None },
                if k == 1 { Some(wp) } else { None },
            )
            .unwrap();
            close(
                chart.stock[1] + chart.stock[2],
                replay.retained_energy[j],
                3e-12,
            );
            let source = replay.field_work.sources[j];
            let rows = pzr::rate_constraints(
                chart,
                [0.; 4],
                pzr::Sources {
                    liquid_mass_kg_s: source[0].mass.value,
                    vapor_mass_kg_s: source[1].mass.value,
                    liquid_energy_w: source[0].enthalpy.value,
                    vapor_energy_w: source[1].enthalpy.value,
                },
            )
            .unwrap();
            for (row, (residual, expected)) in rows
                .residual
                .into_iter()
                .zip([
                    source[0].mass.value,
                    source[1].mass.value,
                    source[0].enthalpy.value,
                    source[1].enthalpy.value,
                ])
                .enumerate()
            {
                close(residual, -expected, 1e-14);
                if row < 2 {
                    maximum_mass_rate_defect = maximum_mass_rate_defect.max(residual.abs());
                } else {
                    maximum_energy_rate_defect = maximum_energy_rate_defect.max(residual.abs());
                }
            }
        }
        audit.push(serde_json::json!({"inlet_kg_s":currents[0],"outlet_kg_s":currents[1],
            "line_mass_receipt_kg_s":line.line.mass.value,"primary_enthalpy_receipt_w":line.primary.energy.value,
            "line_enthalpy_receipt_w":line.line.energy.value,"pzr_enthalpy_receipt_w":line.pzr_liquid.energy.value,
            "birth_receipt_count":replay.field_work.birth_receipts.iter().flatten().filter(|r|r.mass.value>0.).count(),
            "maximum_scaled_complete_direction_defect":maximum,
            "global_mass_receipt_defect_kg_s":mass.value,
            "global_thermal_receipt_defect_w":heat.value-replay.hot_work.released_heat.value,
            "global_boron_receipt_defect_kg_eq_s":boron.value,
            "maximum_zero_rate_mass_row_defect_kg_s":maximum_mass_rate_defect,
            "maximum_zero_rate_energy_row_defect_w":maximum_energy_rate_defect}));
    }
    replay.evaluate(model, current, [2., -3.], None, true);
    let zero_slip_inexact_contacts = replay.field_work.zero_slip_inexact_contacts;
    assert!(zero_slip_inexact_contacts > 0);
    let mut stage = current.clone();
    let p0 = stage.pressure.value;
    let t0 = stage.water_t[replay.junction].value;
    let lp0 = replay.line_state.pressure.value;
    let lt0 = replay.line_state.temperature.value;
    let pp0 = replay.pzr_pressure.value;
    let pt0 = replay.pzr_temperature[0].value;
    let timer = std::time::Instant::now();
    for call in 0..50 {
        let c = call as f64;
        stage.pressure.value = p0 + c;
        stage.water_t[replay.junction].value = t0 + c * 1e-4;
        replay.line_state.pressure.value = lp0 + c * 0.7;
        replay.line_state.temperature.value = lt0 + c * 1e-4;
        replay.pzr_pressure.value = pp0 - c * 0.5;
        replay.pzr_temperature[0].value = pt0 + c * 1e-4;
        let result = replay.evaluate(
            model,
            &stage,
            [2. + c * 0.001, -3. - c * 0.001],
            None,
            false,
        );
        std::hint::black_box((result, &replay.hot_work, &replay.field_work));
    }
    let seconds = timer.elapsed().as_secs_f64();
    assert_eq!(retained, current.finite_stocks());
    assert_eq!(
        line_stock,
        [
            replay.line_state.energy.value.to_bits(),
            replay.line_state.boron.value.to_bits()
        ]
    );
    assert_eq!(pzr_stock, replay.retained_energy.map(f64::to_bits));
    assert_eq!(
        pzr_boron_stock,
        replay.retained_boron.map(|b| b.value.to_bits())
    );
    assert_eq!(retained, stage.finite_stocks());
    serde_json::json!({"scope":"same-call actual hot+finite SURGE+ten-region NC-free PZR M/H/B transport and known constitutive ports; no advancement, full force residual, pressure/kinematic stencil or rank admission",
        "pzr_mouth_momentum_scope":"EXCLUDED_UNSELECTED: no physical zero impulse, guessed velocity or pressure traction is admitted by the zero omitted external momentum component",
        "cases":audit,"primary_pressure_pa":p0,"line_pressure_pa":lp0,"pzr_common_pressure_pa":pp0,
        "fresh_zero_slip_inexact_contacts":zero_slip_inexact_contacts,
        "fresh_current_cost":{"calls":50,"seconds":seconds,"seconds_per_call":seconds/50.,
            "scope":"preallocated work/rate/phase/receipt arrays; fresh primary/line/PZR p,T and independent inlet/outlet currents every call; no held property tuple"}})
}

#[test]
#[ignore = "requires actual owner-generated LD01_OPERATING_HOT_SPINE_PACKET"]
fn actual_hot_spine_current_state_receipts_and_complete_direction() {
    let path = std::env::var_os("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("actual combined packet required");
    let packet: Value = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
    let original = packet.clone();
    let model = model(&packet);
    let mut current = Current::from_packet(&packet, &model);
    assert_eq!(
        (
            model.bands.len(),
            model.helium_nr.len(),
            model.passive_mass.len(),
            model.sg.len()
        ),
        (386, 193, 1351, 8)
    );
    assert_eq!((model.volumes.len(), model.edges.len()), (27, 33));
    let started = std::time::Instant::now();
    current.initialize(&model);
    let initialization_only_seconds = started.elapsed().as_secs_f64();
    let reference = evaluate(&model, &current);
    verify_current_bulk(&reference, &current);
    budget(&reference);
    close(
        reference.released_heat.value,
        n(&packet["thermal"], "source_total_w"),
        2e-12,
    );
    assert!(
        reference
            .surface
            .iter()
            .flatten()
            .all(|r| r.value.abs() < 1e-3)
    );
    assert!(
        reference
            .caloric
            .iter()
            .chain(reference.fuel_caloric.iter().flatten())
            .chain(&reference.helium_caloric)
            .chain(&reference.passive_caloric)
            .chain(&reference.sg_caloric)
            .all(|r| r.value.abs() < 1e-4)
    );
    let initialization_seconds = started.elapsed().as_secs_f64();
    // A distinct current physical state, not an initializer rewriting the
    // prepared stocks. Retained histories and reference coefficients survive.
    current.fuel[0].inner.value += 55.;
    current.fuel[0].outer.value -= 20.;
    current.water_t[0].value += 1.;
    current.pressure.value += 1000.;
    current.material[0].fissile.value *= 0.999;
    current.material[0].fertile.value *= 0.9999;
    current.material[0].xenon.value *= 1.01;
    current.material[0].samarium.value *= 0.99;
    current.rods[0].value -= 0.01;
    current.age.value += 100.;
    for (i, q) in current.flow.iter_mut().enumerate() {
        q.value = 100. + i as f64;
    }
    // Caloric coordinates describe this expressly changed physical state.
    for (i, f) in current.fuel.iter().enumerate() {
        current.fuel_u[i] = [
            thermal::fuel_caloric(f.inner).unwrap().specific_energy
                * s(model.bands[i].fuel_mass[0]),
            thermal::fuel_caloric(f.outer).unwrap().specific_energy
                * s(model.bands[i].fuel_mass[1]),
            thermal::clad_caloric(f.clad_mean).unwrap().specific_energy
                * s(model.bands[i].clad_mass),
        ];
    }
    for (i, t) in current.water_t.iter().enumerate() {
        current.water_u[i] =
            hs::Properties::fixed_liquid(&If97, model.volumes[i], current.pressure, *t)
                .unwrap()
                .energy;
    }
    current.initialize(&model);
    current.fuel[0].inner.direction = 3.;
    current.fuel[0].outer.direction = -2.;
    current.fuel[0].surface.direction = 0.03;
    current.fuel[0].clad_inner.direction = -0.02;
    current.fuel[0].clad_mean.direction = 0.01;
    current.fuel[0].clad_outer.direction = 0.02;
    current.pressure.direction = 1000.;
    current.water_t[0].direction = 0.1;
    current.water_u[0].direction = 1e4;
    current.boron[0].direction = 0.01;
    current.helium[0].direction = 0.02;
    current.passive[0].direction = 0.02;
    current.sg[0].direction = 0.03;
    current.material[0].fissile.direction = -current.material[0].fissile.value * 1e-6;
    current.material[0].fertile.direction = -current.material[0].fertile.value * 1e-7;
    current.material[0].iodine.direction = current.material[0].iodine.value * 1e-4;
    current.material[0].xenon.direction = current.material[0].xenon.value * 1e-4;
    current.material[0].promethium.direction = current.material[0].promethium.value * 1e-4;
    current.material[0].samarium.direction = current.material[0].samarium.value * 1e-4;
    for q in &mut current.flow {
        q.direction = 0.2;
    }
    for n in &mut current.neutrons {
        n.direction = n.value * 1e-4;
    }
    for c in &mut current.precursors {
        c.direction = c.value * 1e-5;
    }
    current.history[0][0].direction = current.history[0][0].value * 1e-4;
    current.rods[0].direction = -0.001;
    current.age.direction = 5.;
    current.secondary[0].pressure.direction = 1000.;
    current.secondary[0].temperature = If97
        .saturation(current.secondary[0].pressure)
        .unwrap()
        .temperature;
    current.secondary[0].liquid_volume.direction = -0.01;
    let evaluated = evaluate(&model, &current);
    verify_current_bulk(&evaluated, &current);
    budget(&evaluated);
    let snapshots = [snapshot(&reference), snapshot(&evaluated)];
    let fingerprints = snapshots.iter().map(|v| fingerprint(v)).collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("LD01_OPERATING_HOT_SPINE_SNAPSHOT_WRITE") {
        std::fs::write(path, serde_json::to_vec(&snapshots).unwrap()).unwrap();
    }
    if let Some(path) = std::env::var_os("LD01_OPERATING_HOT_SPINE_SNAPSHOT_EXPECT") {
        let expected: Vec<Vec<[u64; 2]>> =
            serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
        assert_eq!(expected.len(), snapshots.len());
        for (case, (expected, actual)) in expected.iter().zip(&snapshots).enumerate() {
            assert_eq!(expected.len(), actual.len());
            for (row, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                assert_eq!(
                    expected, actual,
                    "whole-stage bitwise value/direction case{case} row{row}"
                );
            }
        }
    }
    let (pressure_constraint_defect, pressure_projected_flow_change) =
        pressure_oracle(&model, &current, &evaluated);
    assert!(
        (evaluated.released_heat.value - reference.released_heat.value).abs() > 1e3,
        "current events must not be rescaled to reference duty"
    );
    assert!(
        (evaluated.feedback.regions[0].reactivity.value
            - reference.feedback.regions[0].reactivity.value)
            .abs()
            > 1e-8
    );
    let mut maximum_scaled_direction_defect = 0_f64;
    let mut direction_audit = Vec::new();
    for epsilon in [1e-3, 2e-3] {
        let plus = try_evaluate(&model, &current.shift(epsilon), Some(epsilon)).unwrap();
        let minus = try_evaluate(&model, &current.shift(-epsilon), Some(-epsilon)).unwrap();
        let mut worst = (0usize, 0., 0., 0.);
        let mut maximum = 0.;
        for (index, ((actual, plus), minus)) in flatten(&evaluated)
            .into_iter()
            .zip(flatten(&plus))
            .zip(flatten(&minus))
            .enumerate()
        {
            let numeric = (plus.value - minus.value) / (2. * epsilon);
            let scale = actual.direction.abs().max(numeric.abs()).max(1.);
            let defect = (actual.direction - numeric).abs() / scale;
            if defect > maximum {
                maximum = defect;
                worst = (
                    index,
                    actual.direction,
                    numeric,
                    (actual.direction - numeric).abs(),
                );
            }
            assert!(
                (actual.direction - numeric).abs() < 3e-5 * scale,
                "complete current JVP {} vs {numeric}",
                actual.direction
            );
        }
        maximum_scaled_direction_defect = maximum_scaled_direction_defect.max(maximum);
        let (group, index) = label(worst.0, &evaluated);
        direction_audit.push(serde_json::json!({"finite_offset":epsilon,"maximum_scaled_defect":maximum,"group":group,"index":index,
          "native_direction":worst.1,"centred_direction":worst.2,"absolute_defect_in_group_units":worst.3}));
    }
    assert_eq!(
        packet, original,
        "original finite stocks/history package changed"
    );
    let mut unavailable = current.shift(0.);
    unavailable.fuel[0].clad_outer = s(700.);
    let error = try_evaluate(&model, &unavailable, None).unwrap_err();
    assert!(error.contains("phase birth"), "{error}");
    let calls = PropertyCalls::default();
    let mut count_work = model.workspace().unwrap();
    let f = vec![[s(0.); 3]; model.bands.len()];
    let he = vec![s(0.); model.helium_nr.len()];
    let passive = vec![s(0.); model.passive_mass.len()];
    let sg = vec![s(0.); model.sg.len()];
    let water = vec![Scalar::new(1e6, 1000.); model.volumes.len()];
    let zero = vec![s(0.); model.volumes.len()];
    model
        .evaluate(
            &calls,
            current.state(),
            hs::Rates {
                fuel: &f,
                helium: &he,
                passive: &passive,
                sg: &sg,
                pressure: Scalar::new(1e4, 100.),
                water: &water,
                boron: &zero,
            },
            hs::External {
                mass: &zero,
                energy: &zero,
                boron: &zero,
            },
            &mut count_work,
        )
        .unwrap();
    let property_calls = serde_json::json!({"liquid":calls.liquid.get(),"unique_liquid_value_and_direction_keys":calls.liquid_keys.borrow().len(),"vapor":calls.vapor.get(),"saturation":calls.saturation.get(),
        "unique_saturation_value_and_direction_keys":calls.saturation_keys.borrow().len(),
        "fixed_liquid":calls.fixed.get(),"wall_saturated_vapor_density":calls.wall_vapor_density.get(),"scope":"one actual same-point residual/RHS+direction; test-only forwarding counts, no cache"});
    let mut release_cost = serde_json::Value::Null;
    if !cfg!(debug_assertions) {
        let mut stage = current.clone();
        let mut workspace = model.workspace().unwrap();
        let f = vec![[s(0.); 3]; model.bands.len()];
        let he = vec![s(0.); model.helium_nr.len()];
        let passive = vec![s(0.); model.passive_mass.len()];
        let sg = vec![s(0.); model.sg.len()];
        let water = vec![Scalar::new(1e6, 1000.); model.volumes.len()];
        let zero = vec![s(0.); model.volumes.len()];
        let p0 = stage.pressure.value;
        let t0 = stage.water_t[0].value;
        let n0 = stage.neutrons[0].value;
        let wall0 = stage.sg[0].value;
        let timer = std::time::Instant::now();
        for call in 0..50 {
            // Independent current trial coordinates on EVERY call, not time
            // stepping, a held constitutive cache or a stationary-duty replay.
            stage.pressure.value = p0 + call as f64;
            stage.water_t[0].value = t0 + 1e-4 * call as f64;
            stage.neutrons[0].value = n0 * (1. + 1e-7 * call as f64);
            stage.sg[0].value = wall0 + 1e-4 * call as f64;
            model
                .evaluate(
                    &If97,
                    stage.state(),
                    hs::Rates {
                        fuel: &f,
                        helium: &he,
                        passive: &passive,
                        sg: &sg,
                        pressure: Scalar::new(1e4, 100.),
                        water: &water,
                        boron: &zero,
                    },
                    hs::External {
                        mass: &zero,
                        energy: &zero,
                        boron: &zero,
                    },
                    &mut workspace,
                )
                .unwrap();
            std::hint::black_box(&workspace);
        }
        release_cost = serde_json::json!({"calls":50,"seconds":timer.elapsed().as_secs_f64(),"seconds_per_same_trial_value_and_direction":timer.elapsed().as_secs_f64()/50.,
            "scope":"reused workspace; four current trial coordinates freshly changed each call; no advancement"});
    }
    let surge_pzr_same_call = actual_surge_pzr_join(&packet, &model, &current);
    assert_eq!(
        packet, original,
        "same-call transport mutated the owner packet"
    );
    eprintln!(
        "{}",
        serde_json::json!({"scope":"actual current hot nuclear/history/thermal/primary residual, no advancement; PZR phase-force join open",
        "primary_regions":model.volumes.len(),"edges":model.edges.len(),"initial_source_w":reference.released_heat.value,
        "perturbed_current_source_w":evaluated.released_heat.value,"source_change_w":evaluated.released_heat.value-reference.released_heat.value,
        "initialized_max_surface_residual_w":reference.surface.iter().flatten().map(|r|r.value.abs()).fold(0.,f64::max),
        "conditional_zero_flow_continuity_residual_kg_s":reference.continuity.iter().map(|r|r.value.abs()).fold(0.,f64::max),
        "frozen_heat_pressure_projection_defect_kg_s":pressure_constraint_defect,"projected_minus_trial_face_flow_kg_s":pressure_projected_flow_change,
        "fixed_stock_startup_seconds":initialization_only_seconds,"initialization_and_one_joined_call_seconds":initialization_seconds,
        "maximum_scaled_complete_direction_defect":maximum_scaled_direction_defect,"direction_offset_audit":direction_audit,"release_same_call_cost":release_cost,"property_calls":property_calls,
        "same_stage_value_direction_fingerprints":fingerprints,"same_stage_scalar_count_per_case":snapshots[0].len(),
        "surge_pzr_same_call":surge_pzr_same_call})
    );
}

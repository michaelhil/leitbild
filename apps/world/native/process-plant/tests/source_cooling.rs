//! Reduced mathematical join apparatus, not an LD-01 operating preparation.
//! Reuse the existing source fixture's owned laws; split only its heat cohort
//! so two radial bands can share one finite gas and one physical water cell.
#[path = "source_evolution.rs"]
mod source_fixture;

use leitbild_plant_numerics::{
    barrel_thermal as bt, cold_pressurizer as cp, finite_surge as surge, fuel_history as fh,
    fuel_source as fs, fuel_thermal as ft, heat_history as hh, operating_network as on,
    source_cooling as sc, source_evolution as se, water_carrier as wc, CellGeometry,
};

pub(crate) fn fixture() -> sc::Model {
    fixture_with_fuel_mass(0.5).unwrap()
}
pub(crate) fn capture_input() -> leitbild_plant_numerics::fuel_capture::Input {
    use leitbild_plant_numerics::fuel_capture::{Band, Input};
    Input {
        capture_j: [0.3, 0.4, 0.5],
        fuel_chord_m: 0.008,
        fuel_density: 10970.,
        fuel_mu: 0.005,
        clad_density: 6506.,
        clad_mu: 0.0026,
        water_mu: 0.003103,
        bands: (0..2)
            .map(|i| Band {
                thermal_band: i,
                water: 1,
                water_chord_m: 0.2,
                clad_thickness_m: [0.000125, 0.00025, 0.000125],
            })
            .collect(),
    }
}
pub(crate) fn fixture_with_contrast() -> sc::Model {
    fixture_with_preparation(0.5, 1.).unwrap()
}
fn fixture_with_fuel_mass(thermal_mass: f64) -> Result<sc::Model, String> {
    fixture_with_preparation(thermal_mass, 0.)
}
// Reduced pressure apparatus with declared finite stores. It reuses the
// component constitutive owners, not a second physical implementation.
pub(crate) fn pressure_fixture(network: &on::Network) -> sc::PressureConnection {
    pressure_fixture_at(network, 0)
}
fn pressure_fixture_at(network: &on::Network, cell: usize) -> sc::PressureConnection {
    let yn = network.initial_state().unwrap();
    let mut wn = on::Workspace::new(network);
    wn.evaluate(network, &yn, &vec![0.; network.dimension()], None)
        .unwrap();
    let liquid = wn.liquids[cell];
    let z = network.config().water[cell].geometry.elevation;
    let boundaries = [0., 1., 3., 6., 9., 12.];
    let input = cp::Input {
        area: 5.,
        height: 12.,
        bottom_elevation: 6.5,
        rods: [
            cp::Rod {
                displacement_area: 0.01,
                height: 1.,
            },
            cp::Rod {
                displacement_area: 0.08,
                height: 3.,
            },
        ],
        minimum_level: 3.,
        maximum_level: 6.,
        minimum_fluid_temperature: 290.,
        maximum_fluid_temperature: 330.,
        maximum_total_pressure: 600000.,
        maximum_vapor_pressure: 20000.,
        air_mass: 0.,
        nitrogen_mass: 0.,
        interface_length: 1.,
        diffusivity_reference: 2.5e-5,
        diffusivity_reference_temperature: 298.15,
        diffusivity_reference_pressure: 101325.,
        diffusivity_exponent: 1.75,
        gas_conductivity: 0.0262,
        wet_coefficient: 1000.,
        gas_coefficient: 5.,
        condensation_speed: 0.01,
        cp0: 469.4448,
        cp1: 0.13480848,
        datum_temperature: 300.,
        minimum_metal_temperature: 290.,
        maximum_metal_temperature: 330.,
        ambient_temperature: 313.15,
        metals: std::array::from_fn(|k| cp::Metal {
            mass: 10.,
            ambient_conductance: 0.1,
            contact: if k < 2 {
                cp::Contact::Rod {
                    height: [1., 3.][k],
                    area: 0.1,
                }
            } else if k < 7 {
                cp::Contact::Shell {
                    bottom: boundaries[k - 2],
                    top: boundaries[k - 1],
                    area: 0.2,
                }
            } else if k == 7 {
                cp::Contact::Bottom { area: 0.2 }
            } else {
                cp::Contact::Top { area: 0.2 }
            },
        }),
        radiation: vec![],
    };
    let bottom = network.mechanical_pressure(cell, &yn)
        + liquid.density * leitbild_plant_numerics::GRAVITY * (z - 6.5);
    let (pressurizer, mut initial_pressurizer) =
        cp::Model::prepare_at_bottom_pressure(input, bottom, 300., 300., 4., [300.; cp::METALS])
            .unwrap();
    // The component preparation is a truthful seed, not a solved Ti chart.
    // This test-only local solve makes chart-guard fixtures consistent; the
    // connected driver still owes the complete joint state AND rate solve.
    let mut chart = pressurizer.workspace();
    for _ in 0..6 {
        pressurizer
            .evaluate(
                &initial_pressurizer,
                &[0.; cp::STATES],
                cp::Balance::default(),
                Some(0.),
                &mut chart,
            )
            .unwrap();
        let delta = pressurizer
            .chart_corrections(&chart, &initial_pressurizer)
            .unwrap();
        for k in 0..7 {
            initial_pressurizer[cp::LIQUID_TEMPERATURE + k] += delta[k];
        }
        if delta.iter().all(|d| d.abs() < 1e-9) {
            break;
        }
    }
    let length = 16.;
    let diameter = 0.3;
    let volume = std::f64::consts::PI * diameter * diameter / 4. * length;
    let surge = surge::Model::new(surge::Input {
        geometry: CellGeometry {
            volume,
            elevation: 3.,
        },
        length,
        diameter,
        roughness: 1.5e-6,
        terminal_loss: 1.5,
        bend_loss_each: 0.2,
        steel_mass: 100.,
        cp0: 469.4448,
        cp1: 0.13480848,
        datum_temperature: 300.,
        minimum_temperature: 290.,
        maximum_temperature: 330.,
        wet_conductance: 10.,
        ambient_conductance: 1.,
        ambient_temperature: 313.15,
    })
    .unwrap();
    let initial_surge = surge
        .prepare(
            network.mechanical_pressure(cell, &yn)
                + liquid.density * leitbild_plant_numerics::GRAVITY * (z - 3.),
            300.,
            300.,
        )
        .unwrap();
    sc::PressureConnection {
        pressurizer,
        surge,
        primary_cell: cell,
        atoms_per_marker: 400.,
        initial_pool: wc::Amounts {
            boron10: 0.8 * initial_pressurizer[cp::LIQUID_MASS],
            ..Default::default()
        },
        initial_line: wc::Amounts {
            boron10: 0.8 * initial_surge[surge::MASS],
            ..Default::default()
        },
        initial_pressurizer,
        initial_surge,
        initial_gas_hydrogen_product: 0.,
    }
}
fn fixture_with_preparation(thermal_mass: f64, contrast: f64) -> Result<sc::Model, String> {
    fixture_with_preparation_at(thermal_mass, contrast, 0)
}
fn fixture_with_preparation_at(
    thermal_mass: f64,
    contrast: f64,
    cell: usize,
) -> Result<sc::Model, String> {
    let network = on::Network::new(on::Config {
        water: (0..2)
            .map(|i| on::Water {
                geometry: CellGeometry {
                    volume: 1.,
                    elevation: 0.,
                },
                initial_pressure: 0.3e6,
                initial_temperature: 300. + i as f64 * contrast,
                initial_tracer_fraction: 0.002,
            })
            .collect(),
        solids: vec![],
        heat: vec![],
        secondaries: vec![],
        secondary_heat: vec![],
        hydraulic: vec![on::Hydraulic {
            from: 0,
            to: 1,
            law: on::LossLaw::EffectiveTotal,
            length: 1.,
            diameter: 0.1,
            roughness: 0.,
            fixed_loss: 2.,
            grid_multiplier: 0.,
            flow_area: 0.1,
        }],
    })
    .unwrap();
    let pressure = pressure_fixture_at(&network, cell);
    let yn = network.initial_state().unwrap();
    let mut wn = on::Workspace::new(&network);
    wn.evaluate(&network, &yn, &vec![0.; network.dimension()], None)
        .unwrap();
    let prep = wn
        .chart_mass
        .iter()
        .map(|&mass| wc::Preparation {
            mass,
            volume: 1.,
            hydrogen_atoms: 80. * mass,
            boron_atoms: 0.8 * mass,
        })
        .collect::<Vec<_>>();
    let carrier = wc::Carrier::new(&prep, vec![wc::Link { from: 0, to: 1 }]).unwrap();
    let mut input = source_fixture::input();
    // The barrel owns four ordinary bulk targets. Keep the original optical
    // and cylindrical targets separate so the joined chain still covers them.
    input.targets.extend([100.; 3]);
    input.passive_stocks[0].targets.extend((4..7).map(|index| {
        leitbild_plant_numerics::passive_source::Target {
            index,
            sigma_m2: [0.005; 7],
        }
    }));
    let old = &input.history;
    let fuel = fs::FuelModel::new(
        old.fuel().law().clone(),
        old.fuel().volumes().to_vec(),
        old.segment_volumes().to_vec(),
        vec![
            fs::Cohort {
                segment: 0,
                mass: 0.5,
                mu: 0.25
            };
            4
        ],
        old.fuel()
            .intersections()
            .iter()
            .map(|e| fs::Intersection {
                region: e.region,
                segment: e.segment,
                volume: e.volume,
                weights: (0..4)
                    .map(|cohort| fs::Weight { cohort, mass: 0.25 })
                    .collect(),
            })
            .collect(),
    )
    .unwrap();
    input.history = fh::Assembly::new(
        fuel,
        old.segment_preparations().to_vec(),
        old.poison_law(),
        hh::Kernel::new(old.energy_groups().to_vec(), old.fission_energy()).unwrap(),
        old.spontaneous_neutrons_per_event(),
        old.cf_law(),
        old.cf_support().to_vec(),
    )
    .unwrap();
    input.temperatures = vec![300.; 4];
    input.water_owners = prep
        .iter()
        .enumerate()
        .map(|(index, p)| se::WaterOwner {
            authority: se::WaterAuthority::External { index },
            hydrogen: p.hydrogen_atoms,
            hydrogen_product: 0.,
            boron: p.boron_atoms,
            boron_product: 0.,
        })
        .collect();
    for i in 0..2 {
        input.row_map[i] = se::WaterRow {
            owner: i,
            h_fraction: 0.,
            b_fraction: 0.,
            volume_fraction: 0.5,
        };
        input.water_rows[i].water_mass = prep[i].mass * 0.5;
        input.water_rows[i].hydrogen_target = prep[i].hydrogen_atoms * 0.5;
        input.water_rows[i].mobile_boron10 = prep[i].boron_atoms * 0.5;
    }
    let thermal = ft::Model::new(
        (0..2)
            .map(|_| ft::Band {
                fuel_radius_m: 0.004,
                clad_inner_radius_m: 0.0041,
                clad_outer_radius_m: 0.0046,
                length_m: 1.,
                rods: 1,
                fuel_masses_kg: vec![thermal_mass; 2],
                clad_masses_kg: vec![0.05, 0.1, 0.05],
                helium: 0,
                water: 1,
                flow_area_m2: 0.1,
                hydraulic_diameter_m: 0.01,
                fuel_emissivity: 0.7,
                clad_emissivity: 0.7,
            })
            .collect(),
        vec![ft::Helium {
            volume_m3: 0.001,
            nr_j_k: 2.,
            accommodation: 0.356,
        }],
        2,
    )
    .unwrap();
    // Both bands heat cell1, while source captures occur in BOTH physical cells.
    sc::Model::new(
        se::Evolution::new(input).unwrap(),
        network,
        thermal,
        carrier,
        bt::Model::new(bt::Input {
            mass_kg: 10.,
            cp_constant_j_kg_k: 469.4448,
            cp_linear_j_kg_k2: 0.13480848,
            datum_k: 300.,
            minimum_k: 290.,
            maximum_k: 1600.,
            initial_temperature_k: 300.,
            steel_density_kg_m3: 7920.,
            host_chord_m: 0.1,
            steel_mu_en_m2_kg: 0.0026,
            liquid_mu_en_m2_kg: 0.003103,
            wet_h_w_m2_k: 250.,
            targets: [0, 4, 5, 6],
            capture_photon_j: [0.1, 0.2, 0.3, 0.4],
            mn_owner: 0,
            mn_electron_j: 2.,
            mn_photon_j: 3.,
            water_count: 2,
            contacts: vec![
                bt::Contact {
                    water: 0,
                    area_m2: 0.2,
                    liquid_chord_m: 0.1,
                },
                bt::Contact {
                    water: 1,
                    area_m2: 0.3,
                    liquid_chord_m: 0.2,
                },
            ],
        })
        .unwrap(),
        pressure,
        capture_input(),
        vec![0, 1, 5, 6],
        vec![None, Some(0)],
        vec![300.; 11],
    )
}
fn resolved(m: &sc::Model) -> Vec<f64> {
    let mut y = m.initial_state().unwrap();
    let l = m.layout;
    y[..m.source.nc_dimension()].fill(3.);
    y[l.network_start + m.network.flow_row(0)] = 2.;
    for i in 0..m.thermal.node_count() {
        y[l.temperatures_start + i] = 330. + i as f64;
    }
    y[l.carrier_start] = 1.;
    y[l.carrier_start + 2] = 0.2;
    y[l.carrier_start + 3] = 3.;
    y[l.carrier_start + 5] = 0.3;
    y[l.barrel_temperature] = 320.;
    let mut w = m.workspace();
    m.evaluate(&y, &vec![0.; m.dimension()], None, &mut w)
        .unwrap();
    y[l.energies_start..l.temperatures_start].copy_from_slice(w.thermal.energies().unwrap());
    y[l.barrel_energy] = w.barrel.energy().unwrap();
    y
}
fn close(a: f64, b: f64, relative: f64, absolute: f64) {
    assert!(
        (a - b).abs() <= absolute + relative * a.abs().max(b.abs()),
        "{a:e} != {b:e}"
    );
}

#[test]
fn complete_actual_heat_tangent_is_cj_independent_and_not_shift_subtraction() {
    let m = fixture();
    let y = resolved(&m);
    let n = m.dimension();
    let yp = vec![0.; n];
    let mut dy = vec![0.; n];
    for i in 0..m.thermal.node_count() {
        dy[m.layout.temperatures_start + i] = 0.1 * (i as f64 + 1.);
    }
    dy[m.layout.network_start + m.network.pressure_row()] = 100.;
    dy[m.layout.network_start + m.network.temperature_row(0)] = 0.2;
    dy[m.layout.network_start + m.network.flow_row(0)] = 0.1;
    // Large independent energy directions make shift recovery unsafe, but
    // must not affect the physical heat-rate derivative.
    dy[m.layout.network_start + m.network.energy_row(0)] = 1e10;
    dy[m.layout.energies_start] = 2e10;
    let mut reference = None;
    for cj in [0., 1., 1e6, 1e12] {
        let mut w = m.workspace();
        assert!(w.complete_energy_rate().is_err());
        m.evaluate(&y, &yp, Some(cj), &mut w).unwrap();
        assert!(w.complete_energy_rate_jvp().is_err());
        assert!(w.complete_energy_rate().unwrap().abs() < 1e-7);
        m.jvp(&dy, cj, &mut w).unwrap();
        let actual = w.complete_energy_rate_jvp().unwrap();
        assert!(actual.abs() < 1e-7, "cj={cj}, tangent={actual:e}");
        if let Some(old) = reference {
            assert_eq!(actual, old);
        } else {
            reference = Some(actual);
        }
        let mut invalid = dy.clone();
        invalid[0] = f64::NAN;
        assert!(m.jvp(&invalid, cj, &mut w).is_err());
        assert!(w.complete_energy_rate_jvp().is_err());
        let mut bad = y.clone();
        bad[0] = f64::NAN;
        assert!(m.evaluate(&bad, &yp, Some(cj), &mut w).is_err());
        assert!(w.complete_energy_rate().is_err());
        assert!(w.complete_energy_rate_jvp().is_err());
    }
}

#[test]
fn full_composed_residual_direction_matches_same_trial_full_half_differences() {
    let m = fixture();
    let mut y = resolved(&m);
    // Unequal donor compositions at q=0 have only a fixed-upwind generalized
    // derivative, not a two-sided derivative. Exercise central FD off the corner.
    y[m.layout.surge_start + surge::LEFT_FLOW] = 0.2;
    y[m.layout.surge_start + surge::RIGHT_FLOW] = -0.1;
    for k in 0..cp::METALS {
        y[m.layout.pressurizer_start + cp::METAL_TEMPERATURE_START + k] = 299.;
    }
    let n = m.dimension();
    let cj = 7.;
    let yp = vec![0.01; n];
    let mut dy = (0..n)
        .map(|i| 0.01 * ((i % 5) as f64 - 2.))
        .collect::<Vec<_>>();
    dy[m.layout.network_start + m.network.pressure_row()] = 100.;
    let mut thermal_direction = dy.clone();
    thermal_direction[m.layout.surge_start + surge::TEMPERATURE] = 0.03;
    thermal_direction[m.layout.surge_start + surge::PRESSURE] = 100.;
    // Preserve the original cancellation-sensitive direction AND an
    // independent nonzero-T direction with a resolved forward-chart signal.
    for dy in [dy, thermal_direction] {
        let mut w = m.workspace();
        m.evaluate(&y, &yp, Some(cj), &mut w).unwrap();
        m.jvp(&dy, cj, &mut w).unwrap();
        let analytic = w.jvp.clone();
        for h in [0.01, 0.005] {
            let arm = |sign: f64| {
                let ya = y
                    .iter()
                    .zip(&dy)
                    .map(|(v, d)| v + sign * h * d)
                    .collect::<Vec<_>>();
                let ypa = yp
                    .iter()
                    .zip(&dy)
                    .map(|(v, d)| v + sign * h * cj * d)
                    .collect::<Vec<_>>();
                let mut a = m.workspace();
                m.evaluate(&ya, &ypa, None, &mut a).unwrap();
                a.residual
            };
            let p = arm(1.);
            let q = arm(-1.);
            for (row, (&a, (&up, &down))) in analytic.iter().zip(p.iter().zip(&q)).enumerate() {
                let fd = (up - down) / (2. * h);
                // A stored E minus its forward chart cancels two large operands.
                // Residual magnitude alone cannot bound the subtraction's ULPs.
                let chart_operand = if row == m.layout.surge_start + surge::TEMPERATURE {
                    2. * y[m.layout.surge_start + surge::ENERGY].abs()
                } else {
                    0.
                };
                let roundoff =
                    16. * f64::EPSILON * (up.abs() + down.abs() + chart_operand) / (2. * h);
                assert!(
                    (a - fd).abs() <= 3e-5 * a.abs().max(fd.abs()) + roundoff + 1e-7,
                    "row={row}, h={h}, analytic={a:e}, fd={fd:e}"
                );
            }
        }
    }
}

#[test]
fn coupled_fluid_rate_matrix_preserves_phase_work_and_reduced_continuity() {
    let m = fixture();
    let y = resolved(&m);
    let n = m.dimension();
    let yp = vec![0.; n];
    let mut w = m.workspace();
    m.evaluate(&y, &yp, Some(0.), &mut w).unwrap();
    let mut rate = (0..n)
        .map(|i| 0.01 * ((i % 7) as f64 - 3.))
        .collect::<Vec<_>>();
    rate[m.layout.pressurizer_start + cp::HEIGHT] = 0.03;
    let mut action = vec![0.; n];
    m.visit_fluid_rate_matrix(&w, |r, c, v| action[r] += v * rate[c])
        .unwrap();
    let mut other = m.workspace();
    m.evaluate(&y, &rate, None, &mut other).unwrap();
    for r in m.fluid_rows() {
        let actual = other.residual[r] - w.residual[r];
        close(action[r], actual, 3e-10, 1e-7);
    }
    let l = m.layout;
    assert_ne!(
        action[l.pressurizer_start + cp::LIQUID_ENERGY],
        rate[l.pressurizer_start + cp::LIQUID_ENERGY]
    );
    // Opposite interface work cancels, independently of the Ti chart.
    close(
        action[l.pressurizer_start + cp::LIQUID_ENERGY]
            + action[l.pressurizer_start + cp::GAS_ENERGY],
        rate[l.pressurizer_start + cp::LIQUID_ENERGY] + rate[l.pressurizer_start + cp::GAS_ENERGY],
        1e-12,
        1e-9,
    );
    let charts = m.forward_chart_rows();
    assert!(!charts.contains(&(l.network_start + m.network.flow_row(0))));
    assert!(!charts.contains(&(l.surge_start + surge::LEFT_FLOW)));
    assert!(charts.contains(&(l.pressurizer_start + cp::HEIGHT)));
    let foreign = fixture();
    assert!(foreign.visit_fluid_rate_matrix(&w, |_, _, _| {}).is_err());
    m.evaluate(&y, &yp, None, &mut w).unwrap();
    assert!(m.visit_fluid_rate_matrix(&w, |_, _, _| {}).is_err());
}

#[test]
fn pressure_material_is_reciprocal_in_both_flow_directions_and_phase_channels() {
    let m = fixture();
    let l = m.layout;
    for sign in [-1., 1.] {
        let mut y = resolved(&m);
        y[l.surge_start + surge::LEFT_FLOW] = sign * 0.2;
        y[l.surge_start + surge::RIGHT_FLOW] = -sign * 0.1;
        y[l.surge_carrier_start] = 2.;
        y[l.pool_carrier_start] = 4.;
        y[l.gas_hydrogen_product] = 0.01;
        y[l.pressurizer_start + cp::INTERFACE_TEMPERATURE] += sign * 0.01;
        y[l.pressurizer_start + cp::METAL_TEMPERATURE_START + 8] -= 1.;
        let mut w = m.workspace();
        m.evaluate(&y, &vec![0.; m.dimension()], Some(2.), &mut w)
            .unwrap();
        let events = w.source.external_water_events().unwrap();
        for (k, source) in [
            (0, events.iter().map(|e| e.hydrogen).sum::<f64>()),
            (1, -events.iter().map(|e| e.boron).sum::<f64>()),
            (2, events.iter().map(|e| e.boron).sum::<f64>()),
        ] {
            let primary = (0..m.carrier.cells())
                .map(|i| w.residual[l.carrier_start + wc::WIDTH * i + k])
                .sum::<f64>();
            let all = primary
                + w.residual[l.surge_carrier_start + k]
                + w.residual[l.pool_carrier_start + k]
                + if k == 0 {
                    w.residual[l.gas_hydrogen_product]
                } else {
                    0.
                };
            close(-all, source, 1e-11, 1e-11);
        }
        assert!(w.complete_energy_rate().unwrap().abs() < 1e-7);
        let mut dy = vec![0.; m.dimension()];
        dy[l.surge_start + surge::LEFT_FLOW] = 0.3;
        dy[l.pool_carrier_start] = 0.1;
        dy[l.gas_hydrogen_product] = 0.001;
        dy[l.pressurizer_start + cp::INTERFACE_TEMPERATURE] = 0.02;
        m.jvp(&dy, 2., &mut w).unwrap();
        assert!(w.complete_energy_rate_jvp().unwrap().abs() < 1e-7);
    }
}

#[test]
fn current_primary_multiplier_and_hydrostatic_pool_ports_share_reduced_energy_packets() {
    // Actual native port construction, not a reservoir whose EOS pressure is
    // silently identified with the distinct mechanical/bottom pressure.
    let m = fixture_with_preparation_at(0.5, 0., 1).unwrap();
    let l = m.layout;
    for pi in [-1., 0., 1.] {
        for sign in [-1., 1.] {
            let mut y = resolved(&m);
            y[l.network_start + m.network.mechanical_row(1).unwrap()] = pi;
            y[l.surge_start + surge::LEFT_FLOW] = sign;
            y[l.surge_start + surge::RIGHT_FLOW] = sign;
            let mut w = m.workspace();
            m.evaluate(&y, &vec![0.; m.dimension()], Some(0.), &mut w)
                .unwrap();
            let d = w.surge.diagnostics().unwrap();
            assert!(d.passive_dissipation_w >= 0., "pi={pi},sign={sign},{d:?}");
            let receipts = w.surge.receipts().unwrap();
            assert_eq!(receipts.mass, [sign, -sign]);
            // Actual primary mechanical and pool hydrostatic ports enter the
            // SAME shared energy account. No inherited kinetic/entropy proof
            // is claimed for this selected sound-filtered resistance law.
            assert!(w.complete_energy_rate().unwrap().abs() < 1e-7);
            let mut direction = vec![0.; m.dimension()];
            direction[l.surge_start + surge::LEFT_FLOW] = 0.3;
            direction[l.surge_start + surge::RIGHT_FLOW] = -0.2;
            m.jvp(&direction, 0., &mut w).unwrap();
            assert!(w.complete_energy_rate_jvp().unwrap().abs() < 1e-7);
        }
    }
}

#[test]
fn once_paid_fuel_wall_and_carrier_receipts_survive_shared_recipient_projection() {
    let m = fixture();
    let y = resolved(&m);
    let yp = vec![0.; m.dimension()];
    let l = m.layout;
    let mut w = m.workspace();
    m.evaluate(&y, &yp, Some(1.), &mut w).unwrap();
    let release = w.source.diagnostics().unwrap().fuel_release_w;
    close(
        w.source.fuel_deposition().unwrap().iter().sum(),
        release,
        2e-14,
        1e-12,
    );
    let wall = w.thermal.wall_rates().unwrap();
    assert_eq!(wall.len(), 2);
    assert!(wall.iter().all(|q| *q > 0.));
    close(
        w.thermal.heat_rates().unwrap().iter().sum::<f64>() + wall.iter().sum::<f64>(),
        release
            + w.capture.fuel_heat().unwrap().iter().sum::<f64>()
            + w.capture.clad_heat().unwrap().iter().sum::<f64>(),
        2e-12,
        1e-8,
    );
    let mut nw = on::Workspace::new(&m.network);
    nw.evaluate(
        &m.network,
        &y[l.network_start..l.carrier_start],
        &yp[l.network_start..l.carrier_start],
        None,
    )
    .unwrap();
    close(
        nw.residual[m.network.energy_row(1)]
            - w.residual[l.network_start + m.network.energy_row(1)],
        wall.iter().sum::<f64>()
            + w.barrel.water_heat().unwrap()[1]
            + w.capture.water_heat().unwrap()[1],
        2e-12,
        1e-8,
    );
    close(
        nw.residual[m.network.energy_row(0)]
            - w.residual[l.network_start + m.network.energy_row(0)],
        w.barrel.water_heat().unwrap()[0] + w.capture.water_heat().unwrap()[0],
        2e-12,
        1e-8,
    );
    let total_thermal_energy_residual = w.residual[l.energies_start..l.temperatures_start]
        .iter()
        .sum::<f64>();
    let total_network_energy_residual = (0..2)
        .map(|i| w.residual[l.network_start + m.network.energy_row(i)])
        .sum::<f64>();
    close(
        total_thermal_energy_residual + total_network_energy_residual + w.residual[l.barrel_energy],
        -release - w.barrel.emitted_rate().unwrap() + w.barrel.export_rate().unwrap()
            - w.capture.emitted_rate().unwrap()
            + w.capture.export_rate().unwrap(),
        2e-11,
        1e-8,
    );
    let events = w.source.external_water_events().unwrap();
    for (component, capture) in [
        (0, events.iter().map(|e| e.hydrogen).sum::<f64>()),
        (2, events.iter().map(|e| e.boron).sum::<f64>()),
    ] {
        close(
            -(w.residual[l.carrier_start + component]
                + w.residual
                    [l.carrier_start + leitbild_plant_numerics::water_carrier::WIDTH + component]),
            capture,
            2e-13,
            1e-12,
        );
    }
}

#[test]
fn matching_owned_successful_state_is_required_and_changed_inputs_are_not_stale() {
    let m = fixture();
    let mut y = resolved(&m);
    let yp = vec![0.; m.dimension()];
    let mut w = m.workspace();
    assert!(m.validate_accepted(&y, &w).is_err());
    m.evaluate(&y, &yp, Some(2.), &mut w).unwrap();
    m.validate_accepted(&y, &w).unwrap();
    let first = w.source.rates().unwrap().to_vec();
    y[m.layout.temperatures_start] += 1.;
    assert!(m.validate_accepted(&y, &w).is_err());
    m.evaluate(&y, &yp, Some(2.), &mut w).unwrap();
    assert_ne!(first, w.source.rates().unwrap());
    let held = w.source.rates().unwrap().to_vec();
    y[m.layout.network_start + m.network.temperature_row(1)] += 1.;
    m.evaluate(&y, &yp, Some(2.), &mut w).unwrap();
    assert_ne!(held, w.source.rates().unwrap()); // Actual water chart changes moderator stocks.
    assert!(m.jvp(&vec![0.; m.dimension()], 3., &mut w).is_err());
    y[m.layout.carrier_start] = -1.;
    m.evaluate(&y, &yp, Some(2.), &mut w).unwrap();
    assert!(m.validate_accepted(&y, &w).is_err()); // Signed trials are not accepted stocks.
    y[m.layout.temperatures_start] = 289.;
    assert!(m.evaluate(&y, &yp, Some(2.), &mut w).is_err());
    assert!(m.validate_accepted(&y, &w).is_err());
    assert!(m.jvp(&vec![0.; m.dimension()], 2., &mut w).is_err());
    let foreign = fixture();
    let fresh = resolved(&m);
    m.evaluate(&fresh, &yp, Some(2.), &mut w).unwrap();
    assert!(foreign.evaluate(&fresh, &yp, Some(2.), &mut w).is_err());
    assert!(m.validate_accepted(&fresh, &w).is_err());
}

#[test]
fn composition_refuses_wrong_fuel_recipient_or_carrier_link_identity() {
    assert!(fixture_with_fuel_mass(0.6).is_err());
    let m = fixture();
    let pressure = pressure_fixture(&m.network);
    // Row2 is clad, not the source's second fuel temperature/deposition owner.
    assert!(sc::Model::new(
        m.source,
        m.network,
        m.thermal,
        m.carrier,
        m.barrel,
        pressure,
        capture_input(),
        vec![0, 2, 5, 6],
        vec![None, Some(0)],
        vec![300.; 11]
    )
    .is_err());
    let m = fixture();
    let pressure = pressure_fixture(&m.network);
    let prep = (0..2)
        .map(|_| wc::Preparation {
            mass: 1000.,
            volume: 1.,
            hydrogen_atoms: 80000.,
            boron_atoms: 800.,
        })
        .collect::<Vec<_>>();
    let wrong = wc::Carrier::new(&prep, vec![wc::Link { from: 1, to: 0 }]).unwrap();
    assert!(sc::Model::new(
        m.source,
        m.network,
        m.thermal,
        wrong,
        m.barrel,
        pressure,
        capture_input(),
        vec![0, 1, 5, 6],
        vec![None, Some(0)],
        vec![300.; 11]
    )
    .is_err());
}

#[test]
fn direct_boron_target_and_product_preserve_closed_total_and_marker_packets() {
    let m = fixture();
    let l = m.layout;
    let mut y = m.initial_state().unwrap();
    y[..m.source.nc_dimension()].fill(3.);
    let yp = vec![0.; m.dimension()];
    // Convert some target to product without changing the original equivalent
    // boron population or its independently retained liquid marker.
    for (i, captured) in [2., 3.].into_iter().enumerate() {
        y[l.carrier_start + wc::WIDTH * i + 1] -= captured;
        y[l.carrier_start + wc::WIDTH * i + 2] += captured;
    }
    let conversion = (y[l.carrier_start + 1] + y[l.carrier_start + 2])
        / y[l.network_start + m.network.marker_row(0)];
    for flow in [-2., 0., 2.] {
        y[l.network_start + m.network.flow_row(0)] = flow;
        let mut w = m.workspace();
        m.evaluate(&y, &yp, Some(3.), &mut w).unwrap();
        let mut sum = 0.;
        let mut dy = vec![0.; m.dimension()];
        dy[..m.source.nc_dimension()].fill(0.01);
        dy[l.network_start + m.network.pressure_row()] = 7.;
        dy[l.network_start + m.network.temperature_row(0)] = 0.01;
        dy[l.network_start + m.network.flow_row(0)] = 0.02;
        for i in 0..m.carrier.cells() {
            let r = l.carrier_start + wc::WIDTH * i;
            let marker = l.network_start + m.network.marker_row(i);
            close(y[r + 1] + y[r + 2], conversion * y[marker], 1e-13, 1e-12);
            let rate = -w.residual[r + 1] - w.residual[r + 2];
            close(
                rate,
                conversion * w.network.rates[m.network.marker_row(i)],
                1e-12,
                1e-11,
            );
            sum += rate;
            dy[marker] = if i == 0 { 0.001 } else { -0.001 };
            dy[r + 1] = conversion * dy[marker] - 0.03;
            dy[r + 2] = 0.03;
        }
        close(sum, 0., 0., 1e-11);
        m.jvp(&dy, 3., &mut w).unwrap();
        let mut sum = 0.;
        for i in 0..m.carrier.cells() {
            let r = l.carrier_start + wc::WIDTH * i;
            let marker = l.network_start + m.network.marker_row(i);
            let rate = 3. * (dy[r + 1] + dy[r + 2]) - w.jvp[r + 1] - w.jvp[r + 2];
            let marker_rate = 3. * dy[marker] - w.jvp[marker];
            close(rate, conversion * marker_rate, 1e-11, 1e-10);
            sum += rate;
        }
        close(sum, 0., 0., 1e-10);
    }
}

#[test]
fn each_actual_gross_capture_channel_pays_one_partition_not_net_poison_rhs() {
    use leitbild_plant_numerics::fuel_history as fh;
    let m = fixture();
    let l = m.layout;
    let h = m.source.fuel_history();
    let row = h.history_row(0, 0);
    let reference = h.segment_preparations()[0].reference_u238;
    for channel in 0..3 {
        let mut y = m.initial_state().unwrap();
        // Suppress fertile events when isolating each nonzero poison channel.
        if channel > 0 {
            y[row + fh::CAPTURED_238] = reference;
        }
        y[row + fh::XENON] = if channel == 1 { 5. } else { 0. };
        y[row + fh::SAMARIUM] = if channel == 2 { 7. } else { 0. };
        for e in h.fuel().intersections() {
            y[e.region * 7 + if channel == 0 { 2 } else { 6 }] = 2.;
        }
        let mut w = m.workspace();
        m.evaluate(&y, &vec![0.; m.dimension()], Some(3.), &mut w)
            .unwrap();
        let events = w.source.fuel_capture_events().unwrap();
        for (i, e) in events.iter().enumerate() {
            assert!(e[channel] > 0.);
            for j in 0..3 {
                if j != channel {
                    assert_eq!(e[j], 0.);
                }
            }
            let c = &w.capture.power_channels().unwrap()[5 * i..5 * i + 5];
            close(
                c[0],
                e[channel] * m.capture.config().capture_j[channel],
                2e-14,
                1e-14,
            );
            close(c[0], c[1..].iter().sum(), 2e-14, 1e-14);
            assert!(c[1..].iter().all(|v| *v > 0.));
        }
        let paid = m
            .capture_paid_rows()
            .map(|(r, q)| q * w.source.rates().unwrap()[r])
            .sum::<f64>();
        close(paid, w.capture.emitted_rate().unwrap(), 2e-14, 1e-13);
        if channel == 1 {
            assert_ne!(
                w.source.rates().unwrap()[row + fh::XENON],
                -events.iter().map(|e| e[1]).sum::<f64>()
            );
        }
        assert!(w.complete_energy_rate().unwrap().abs() < 1e-7);
        // Actual source JVP feeds the same partition, including current T and
        // native liquid-density directions, not manually substituted events.
        let mut dy = vec![0.; m.dimension()];
        dy[..m.source.nc_dimension()].fill(0.01);
        dy[row + fh::XENON] = 0.03;
        dy[row + fh::SAMARIUM] = -0.02;
        for &r in m.fuel_rows() {
            dy[l.temperatures_start + r] = 0.2;
        }
        dy[l.network_start + m.network.temperature_row(1)] = 0.1;
        m.jvp(&dy, 3., &mut w).unwrap();
        close(
            w.capture.emitted_jvp().unwrap(),
            w.capture
                .fuel_heat_jvp()
                .unwrap()
                .iter()
                .chain(w.capture.clad_heat_jvp().unwrap())
                .chain(w.capture.water_heat_jvp().unwrap())
                .sum::<f64>()
                + w.capture.export_jvp().unwrap(),
            2e-13,
            1e-13,
        );
        assert!(w.complete_energy_rate_jvp().unwrap().abs() < 1e-7);
    }
}

#[test]
fn current_capture_sparse_response_all_columns_match_actual_source_events_and_jvp() {
    use leitbild_plant_numerics::fuel_history as fh;
    let m = fixture();
    let h = m.source.fuel_history();
    let response = m.capture.power_response(&m.source).unwrap();
    let mut y = h.initial_state();
    y[..m.source.nc_dimension()].fill(3.);
    let row = h.history_row(0, 0);
    y[row + fh::XENON] = 5.;
    y[row + fh::SAMARIUM] = 7.;
    y[row + fh::CAPTURED_238] = 0.2 * h.segment_preparations()[0].reference_u238;
    let t = vec![310., 315., 320., 325.];
    let q = m.capture.config().capture_j;
    let mut powers = vec![0.; response.output_count()];
    let mut gradients = vec![0.; response.columns().len()];
    let mut w = h.workspace();
    for sign in [1., -1.] {
        for n in &mut y[..m.source.nc_dimension()] {
            *n = sign * n.abs();
        }
        h.evaluate_into(&t, &y, &mut w).unwrap();
        response
            .evaluate(&y, &t, &mut powers, &mut gradients)
            .unwrap();
        for (i, e) in w.capture_events().unwrap().iter().enumerate() {
            close(
                powers[i],
                e.iter().zip(q).map(|(r, q)| r * q).sum(),
                3e-14,
                1e-13,
            );
        }
        for &column in response.columns() {
            let mut dy = vec![0.; y.len()];
            let mut dt = vec![0.; t.len()];
            if column < y.len() {
                dy[column] = 1.;
            } else {
                dt[column - y.len()] = 1.;
            }
            h.jvp_into(&dt, &dy, &mut w).unwrap();
            for i in 0..response.output_count() {
                let exact = w.capture_event_jvp().unwrap()[i]
                    .iter()
                    .zip(q)
                    .map(|(r, q)| r * q)
                    .sum::<f64>();
                let got = (response.offsets()[i]..response.offsets()[i + 1])
                    .filter(|&k| response.columns()[k] == column)
                    .map(|k| gradients[k])
                    .sum::<f64>();
                close(got, exact, 4e-14, 1e-13);
            }
        }
    }
    let other = fixture();
    assert!(m.capture.power_response(&other.source).is_err());
    assert!(response
        .evaluate(&y, &[f64::NAN; 4], &mut powers, &mut gradients)
        .is_err());
    y.fill(0.);
    response
        .evaluate(&y, &t, &mut powers, &mut gradients)
        .unwrap();
    assert!(powers.iter().all(|v| *v == 0.));
    // Zero power does not prune the actual neutron derivative support.
    assert!(gradients.iter().any(|v| *v != 0.));
}

#[test]
fn capture_partition_current_density_signed_direction_and_failure_authority() {
    let m = fixture();
    let capture = &m.capture;
    let n = m.source.fuel_history().fuel().intersections().len();
    let events = vec![[2., 3., 4.]; n];
    let de = vec![[-0.1, 0.2, -0.3]; n];
    let rho = [990., 995.];
    let dr = [0.4, -0.5];
    let mut w = capture.workspace();
    capture.evaluate(&events, &rho, &mut w).unwrap();
    capture.jvp(&de, &dr, &mut w).unwrap();
    let expected = (
        w.fuel_heat_jvp().unwrap().to_vec(),
        w.clad_heat_jvp().unwrap().to_vec(),
        w.water_heat_jvp().unwrap().to_vec(),
        w.export_jvp().unwrap(),
    );
    for eps in [1e-3, 5e-4] {
        let eval = |sign: f64| {
            let mut w = capture.workspace();
            let e = events
                .iter()
                .zip(&de)
                .map(|(e, d)| std::array::from_fn(|j| e[j] + sign * eps * d[j]))
                .collect::<Vec<_>>();
            let r: [f64; 2] = std::array::from_fn(|j| rho[j] + sign * eps * dr[j]);
            capture.evaluate(&e, &r, &mut w).unwrap();
            (
                w.fuel_heat().unwrap().to_vec(),
                w.clad_heat().unwrap().to_vec(),
                w.water_heat().unwrap().to_vec(),
                w.export_rate().unwrap(),
            )
        };
        let plus = eval(1.);
        let minus = eval(-1.);
        for ((a, b), d) in plus
            .0
            .iter()
            .chain(&plus.1)
            .chain(&plus.2)
            .zip(minus.0.iter().chain(&minus.1).chain(&minus.2))
            .zip(expected.0.iter().chain(&expected.1).chain(&expected.2))
        {
            close((a - b) / (2. * eps), *d, 1e-7, 1e-10);
        }
        close((plus.3 - minus.3) / (2. * eps), expected.3, 1e-7, 1e-10);
    }
    let other = fixture();
    assert!(other.capture.evaluate(&events, &rho, &mut w).is_err());
    assert!(w.export_rate().is_err());
    capture.evaluate(&events, &rho, &mut w).unwrap();
    assert!(w.export_jvp().is_err());
    assert!(capture.evaluate(&events, &[-1., 995.], &mut w).is_err());
    assert!(w.fuel_heat().is_err());
    let mut bad = capture_input();
    bad.bands[0].clad_thickness_m[0] *= 2.;
    assert!(leitbild_plant_numerics::fuel_capture::Model::new(
        &m.source,
        &m.thermal,
        m.fuel_rows(),
        bad
    )
    .is_err());
}

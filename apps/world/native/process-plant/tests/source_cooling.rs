//! Reduced mathematical join apparatus, not an LD-01 operating preparation.
//! Reuse the existing source fixture's owned laws; split only its heat cohort
//! so two radial bands can share one finite gas and one physical water cell.
#[path = "source_evolution.rs"]
mod source_fixture;

use leitbild_plant_numerics::{
    CellGeometry, barrel_thermal as bt, fuel_history as fh, fuel_source as fs, fuel_thermal as ft,
    heat_history as hh, operating_network as on, source_cooling as sc, source_evolution as se,
    water_carrier as wc,
};

pub(crate) fn fixture() -> sc::Model {
    fixture_with_fuel_mass(0.5).unwrap()
}
pub(crate) fn fixture_with_contrast() -> sc::Model {
    fixture_with_preparation(0.5, 1.).unwrap()
}
fn fixture_with_fuel_mass(thermal_mass: f64) -> Result<sc::Model, String> {
    fixture_with_preparation(thermal_mass, 0.)
}
fn fixture_with_preparation(thermal_mass: f64, contrast: f64) -> Result<sc::Model, String> {
    let network = on::Network::new(on::Config {
        water: (0..2)
            .map(|i| on::Water {
                geometry: CellGeometry {
                    volume: 1.,
                    elevation: 0.,
                },
                initial_pressure: 1e7,
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
                clad_masses_kg: vec![0.1; 2],
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
        vec![0, 1, 4, 5],
        vec![None, Some(0)],
        vec![300.; 9],
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
    let y = resolved(&m);
    let n = m.dimension();
    let cj = 7.;
    let yp = vec![0.01; n];
    let mut dy = (0..n)
        .map(|i| 0.01 * ((i % 5) as f64 - 2.))
        .collect::<Vec<_>>();
    dy[m.layout.network_start + m.network.pressure_row()] = 100.;
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
            let roundoff = 16. * f64::EPSILON * (up.abs() + down.abs()) / (2. * h);
            assert!(
                (a - fd).abs() <= 3e-5 * a.abs().max(fd.abs()) + roundoff + 1e-7,
                "row={row}, h={h}, analytic={a:e}, fd={fd:e}"
            );
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
        release,
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
        wall.iter().sum::<f64>() + w.barrel.water_heat().unwrap()[1],
        2e-12,
        1e-8,
    );
    close(
        nw.residual[m.network.energy_row(0)]
            - w.residual[l.network_start + m.network.energy_row(0)],
        w.barrel.water_heat().unwrap()[0],
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
        -release - w.barrel.emitted_rate().unwrap() + w.barrel.export_rate().unwrap(),
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
    // Row2 is clad, not the source's second fuel temperature/deposition owner.
    assert!(
        sc::Model::new(
            m.source,
            m.network,
            m.thermal,
            m.carrier,
            m.barrel,
            vec![0, 2, 4, 5],
            vec![None, Some(0)],
            vec![300.; 9]
        )
        .is_err()
    );
    let m = fixture();
    let prep = (0..2)
        .map(|_| wc::Preparation {
            mass: 1000.,
            volume: 1.,
            hydrogen_atoms: 80000.,
            boron_atoms: 800.,
        })
        .collect::<Vec<_>>();
    let wrong = wc::Carrier::new(&prep, vec![wc::Link { from: 1, to: 0 }]).unwrap();
    assert!(
        sc::Model::new(
            m.source,
            m.network,
            m.thermal,
            wrong,
            m.barrel,
            vec![0, 1, 4, 5],
            vec![None, Some(0)],
            vec![300.; 9]
        )
        .is_err()
    );
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

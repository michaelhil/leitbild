//! Small mathematical fixtures; no fabricated LD-01 preparation or trajectory.
use leitbild_plant_numerics::{
    cylindrical_source as cs, fuel_history as fh, fuel_source as fs, heat_history as hh,
    moderator_source as ms, optical_source as os, passive_source as ps, source_evolution::*,
    transport_source as ts,
};
pub(crate) fn input() -> Input {
    let volumes = vec![2., 3.];
    let speed = [3.; 7];
    let fuel = fs::FuelModel::new(
        fs::FuelLaw {
            absorption: [0.4; 7],
            fission: [0.1; 7],
            scatter: [[0.2; 7]; 7],
            nu: [2.; 7],
            chi: [1. / 7.; 7],
            speed,
            beta: [0.001; 6],
            decay: [0.1; 6],
            f_d: 0.2,
        },
        volumes.clone(),
        vec![1.],
        vec![fs::Cohort {
            segment: 0,
            mass: 2.,
            mu: 1.,
        }],
        vec![
            fs::Intersection {
                region: 0,
                segment: 0,
                volume: 0.5,
                weights: vec![fs::Weight {
                    cohort: 0,
                    mass: 1.,
                }],
            },
            fs::Intersection {
                region: 1,
                segment: 0,
                volume: 0.5,
                weights: vec![fs::Weight {
                    cohort: 0,
                    mass: 1.,
                }],
            },
        ],
    )
    .unwrap();
    let heat = hh::Kernel::new(
        (0..25)
            .map(|i| hh::Group {
                feed: if i < 23 {
                    hh::Feed::Fission
                } else {
                    hh::Feed::FertileCapture
                },
                energy_per_event: if i < 23 { 0.1 } else { 0.3 },
                decay_rate: 0.01 * (i + 1) as f64,
            })
            .collect(),
        10.,
    )
    .unwrap();
    let history = fh::Assembly::new(
        fuel,
        vec![fh::SegmentPreparation {
            reference_u235: 1000.,
            reference_u238: 2000.,
            sf235_neutrons_per_second: 2.,
            sf238_neutrons_per_second: 3.,
        }],
        fh::PoisonLaw {
            yield_i: 0.06,
            yield_xe: 0.003,
            yield_pm: 0.01,
            lambda_i: 0.02,
            lambda_xe: 0.03,
            lambda_pm: 0.01,
            xe_sigma_m2: 0.1,
            sm_sigma_m2: 0.2,
        },
        heat,
        2.5,
        fh::CfLaw {
            initial_energy_j: 1000.,
            initial_neutrons_per_second: 4.,
            decay_rate: 0.01,
            birth_export_j_per_neutron: 0.5,
        },
        vec![(0, 0.25), (1, 0.75)],
    )
    .unwrap();
    let moderator = ms::ModeratorModel::new(
        ms::ModeratorLaw {
            absorption: [0.02; 7],
            scatter: [[0.01; 7]; 7],
            speed,
            boron_sigma: [0.001; 7],
            reference_density: 1000.,
            hydrogen_emission: [0., 2.],
            boron_emission: [2., 0.4],
        },
        volumes.clone(),
        vec![
            ms::Intersection {
                region: 0,
                volume: 0.5,
            },
            ms::Intersection {
                region: 1,
                volume: 0.5,
            },
        ],
    )
    .unwrap();
    Input {
        history,
        temperatures: vec![400.],
        moderator,
        water_rows: vec![
            ms::Stocks {
                water_mass: 500.,
                liquid_volume: 0.5,
                hydrogen_target: 40000.,
                hydrogen_product: 0.,
                mobile_boron10: 400.
            };
            2
        ],
        water_owners: vec![WaterOwner {
            authority: WaterAuthority::Closed,
            hydrogen: 100000.,
            hydrogen_product: 0.,
            boron: 1000.,
            boron_product: 0.,
        }],
        external_water_volumes: vec![],
        row_map: vec![
            WaterRow {
                owner: 0,
                h_fraction: 0.4,
                b_fraction: 0.4,
            };
            2
        ],
        targets: vec![100.; 4],
        passive_stocks: vec![ps::Stock {
            volume: 0.1,
            scatter_m1: [0.1; 7],
            targets: vec![ps::Target {
                index: 0,
                sigma_m2: [0.005; 7],
            }],
        }],
        passive_incidence: vec![ps::Intersection {
            stock: 0,
            region: 0,
            volume: 0.1,
        }],
        cylinder_targets: vec![cs::Target {
            index: 2,
            inner_radius: 0.,
            outer_radius: 0.1,
            length: 1.,
            multiplicity: 1,
            sigma_m2: [0.001; 7],
            escape_depth: 0.01,
            collection: 0.5,
        }],
        cylinder_incidence: vec![cs::Intersection {
            target: 0,
            region: 1,
            share: 1.,
        }],
        envelope_lengths: vec![1., 1.],
        faces: vec![
            ts::Face {
                left: 0,
                right: Some(1),
                area: 0.5,
                left_distance: 0.5,
                right_distance: Some(0.5),
                law: ts::FaceLaw::Optical {
                    targets: vec![1, 3],
                },
            },
            ts::Face {
                left: 0,
                right: None,
                area: 0.2,
                left_distance: 0.5,
                right_distance: None,
                law: ts::FaceLaw::Escape,
            },
        ],
        optical_layers: vec![vec![
            os::Layer {
                columns: vec![os::Column {
                    target: 1,
                    atoms_per_m2: 100.,
                    sigma_m2: [0.001; 7],
                }],
            },
            os::Layer {
                columns: vec![os::Column {
                    target: 3,
                    atoms_per_m2: 20.,
                    sigma_m2: [0.002; 7],
                }],
            },
        ]],
        mn: vec![MnTarget {
            target: 0,
            decay_rate: 0.01,
            electron_j: 2.,
            photon_j: 3.,
        }],
    }
}

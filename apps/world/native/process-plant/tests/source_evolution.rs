//! Small mathematical fixtures; no fabricated LD-01 preparation or trajectory.
use leitbild_plant_numerics::{
    cylindrical_source as cs, fuel_history as fh, fuel_source as fs, heat_history as hh,
    moderator_source as ms, optical_source as os, passive_source as ps, source_evolution::*,
    transport_source as ts,
};
fn input() -> Input {
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
            hydrogen: 100000.,
            hydrogen_product: 0.,
            boron: 1000.,
            boron_product: 0.,
        }],
        row_map: vec![
            WaterRow {
                owner: 0,
                h_fraction: 0.4,
                b_fraction: 0.4
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
fn state(m: &Evolution) -> Vec<f64> {
    let mut y = m.initial_state();
    y[..m.nc_dimension()].fill(2.);
    for v in &mut y[m.nc_dimension()..m.cf_row()] {
        *v = 3.;
    }
    y[m.cf_row()] = 10.;
    y[m.water_row(0, false)] = 20.;
    y[m.water_row(0, true)] = 5.;
    for i in 0..4 {
        y[m.target_row(i)] = 4. + i as f64;
    }
    y[m.mn_row(0)] = 1.;
    y
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() < 3e-8 * (1. + a.abs().max(b.abs())),
        "{a:e} != {b:e}"
    );
}
#[test]
fn real_births_shared_owners_and_independent_invariant_derivatives() {
    let m = Evolution::new(input()).unwrap();
    let mut w = m.workspace();
    let cold = m.initial_state();
    m.validate_accepted_state(&cold).unwrap();
    m.evaluate_into(&cold, &mut w).unwrap();
    close(w.rates().unwrap()[..m.nc_dimension()].iter().sum(), 9.);
    assert_eq!(cold[m.cf_row()], 0.);
    assert!(w.rates().unwrap()[m.cf_row()] > 0.);
    let y = state(&m);
    m.validate_accepted_state(&y).unwrap();
    m.evaluate_into(&y, &mut w).unwrap();
    let r = w.rates().unwrap();
    close(r[..m.nc_dimension()].iter().sum(), r[m.ledger_row()]);
    let b = m.conservation(r).unwrap();
    close(b.energy_ledger_defect_j, 0.);
    close(b.neutron_ledger_defect, 0.);
    assert!(r[m.water_row(0, false)] > 0. && r[m.water_row(0, true)] > 0.);
    close(r[m.mn_row(0)], 0.01 * (y[m.target_row(0)] - y[m.mn_row(0)]));
    assert!(w.diagnostics().unwrap().collected_events_s > 0.);
    // Outside-source water remains in the SAME donor: no 0.4/0.8 renormalization.
    let mut full = input();
    full.water_owners[0].hydrogen = 80000.;
    full.water_owners[0].boron = 800.;
    for map in &mut full.row_map {
        map.h_fraction = 0.5;
        map.b_fraction = 0.5;
    }
    let other = Evolution::new(full).unwrap();
    let mut z = state(&other);
    z[other.water_row(0, false)] = 20.;
    let mut q = other.workspace();
    other.evaluate_into(&z, &mut q).unwrap();
    assert!(q.rates().unwrap()[other.water_row(0, false)] < r[m.water_row(0, false)]);
}
#[test]
fn full_jvp_and_nc_block_match_actual_forward_operator() {
    let m = Evolution::new(input()).unwrap();
    let y = state(&m);
    let dy = y
        .iter()
        .enumerate()
        .map(|(i, v)| 0.03 * v + 0.01 * (i % 3) as f64)
        .collect::<Vec<_>>();
    let mut w = m.workspace();
    m.evaluate_into(&y, &mut w).unwrap();
    m.jvp_into(&dy, &mut w).unwrap();
    let a = w.rate_jvp().unwrap().to_vec();
    let mut p = m.workspace();
    let mut n = m.workspace();
    for h in [1e-3, 5e-4] {
        let yp = y
            .iter()
            .zip(&dy)
            .map(|(v, d)| v + h * d)
            .collect::<Vec<_>>();
        let yn = y
            .iter()
            .zip(&dy)
            .map(|(v, d)| v - h * d)
            .collect::<Vec<_>>();
        m.evaluate_into(&yp, &mut p).unwrap();
        m.evaluate_into(&yn, &mut n).unwrap();
        for (i, (&d, (&rp, &rn))) in a
            .iter()
            .zip(p.rates().unwrap().iter().zip(n.rates().unwrap()))
            .enumerate()
        {
            let fd = (rp - rn) / (2. * h);
            assert!(
                (fd - d).abs() < 2e-7 * (1. + d.abs()),
                "row{i}: {fd:e} vs{d:e}"
            );
        }
    }
    let mut direction = dy.clone();
    direction[m.nc_dimension()..].fill(0.);
    m.jvp_into(&direction, &mut w).unwrap();
    let mut values = vec![0.; m.nc_pattern().len()];
    let cj = 3.;
    m.nc_values(&w, cj, &mut values).unwrap();
    let mut product = vec![0.; m.nc_dimension()];
    for ((r, c), a) in m.nc_pattern().iter().zip(values) {
        product[*r] += a * direction[*c];
    }
    for i in 0..m.nc_dimension() {
        close(product[i], cj * direction[i] - w.rate_jvp().unwrap()[i]);
    }
    let mut diagonal = vec![0.; m.state_count() - m.nc_dimension()];
    m.history_diagonal(&w, cj, &mut diagonal).unwrap();
    assert!(diagonal.iter().all(|v| *v >= cj));
}
#[test]
fn zero_opacity_exhaustion_has_finite_analytic_target_derivative() {
    let m = Evolution::new(input()).unwrap();
    let mut y = state(&m);
    y[m.target_row(1)] = 100.;
    y[m.target_row(3)] = 100.;
    let mut w = m.workspace();
    m.evaluate_into(&y, &mut w).unwrap();
    let mut d = vec![0.; m.state_count()];
    d[m.target_row(1)] = -1.;
    d[m.target_row(3)] = -0.2;
    m.jvp_into(&d, &mut w).unwrap();
    let a = w.rate_jvp().unwrap().to_vec();
    let mut p = m.workspace();
    for h in [1e-5, 5e-6] {
        let yp = y.iter().zip(&d).map(|(v, d)| v + h * d).collect::<Vec<_>>();
        m.evaluate_into(&yp, &mut p).unwrap();
        for i in [m.target_row(1), m.target_row(3)] {
            close(a[i], (p.rates().unwrap()[i] - w.rates().unwrap()[i]) / h);
        }
    }
}
#[test]
fn signed_trial_boundary_and_no_stale_buffers() {
    let m = Evolution::new(input()).unwrap();
    let mut y = m.initial_state();
    y[m.water_row(0, false)] = -1.;
    y[0] = -1.;
    let mut w = m.workspace();
    m.evaluate_into(&y, &mut w).unwrap();
    assert!(m.validate_accepted_state(&y).is_err());
    let pointer = w.rates().unwrap().as_ptr();
    m.evaluate_into(&m.initial_state(), &mut w).unwrap();
    assert_eq!(pointer, w.rates().unwrap().as_ptr());
    y[m.water_row(0, false)] = 100001.;
    assert!(m.evaluate_into(&y, &mut w).is_err());
    assert!(w.rates().is_err());
    assert!(m.validate_accepted_state(&y).is_err());
}

#[test]
fn thin_ordered_optical_target_jvp_and_workspace_contract() {
    use leitbild_plant_numerics::optical_source::{Column, Layer, LayerModel};
    for depth in [0.01, 1., 100.] {
        let layers = [
            Layer {
                columns: vec![Column {
                    target: 0,
                    atoms_per_m2: depth,
                    sigma_m2: [1.; 7],
                }],
            },
            Layer {
                columns: vec![Column {
                    target: 1,
                    atoms_per_m2: 1e-10,
                    sigma_m2: [1.; 7],
                }],
            },
        ];
        let m = LayerModel::new(&layers, &[1., 1.]).unwrap();
        let mut w = m.workspace();
        assert!(m.jvp(&[0.3, -0.2], &mut w).is_err());
        m.update(&[1., 1.], &mut w).unwrap();
        m.jvp(&[0.3, -0.2], &mut w).unwrap();
        for h in [1e-4, 5e-5] {
            let mut p = m.workspace();
            let mut n = m.workspace();
            m.update(&[1. + 0.3 * h, 1. - 0.2 * h], &mut p).unwrap();
            m.update(&[1. - 0.3 * h, 1. + 0.2 * h], &mut n).unwrap();
            for (a, fp, fn_) in [
                (w.left_loss_jvp[1][0], p.left_loss[1][0], n.left_loss[1][0]),
                (
                    w.right_loss_jvp[1][0],
                    p.right_loss[1][0],
                    n.right_loss[1][0],
                ),
            ] {
                let fd = (fp - fn_) / (2. * h);
                assert!(
                    (a - fd).abs() <= 2e-6 * a.abs().max(fd.abs()),
                    "{a:e} != {fd:e}"
                );
            }
        }
        w.input.from_left.clear();
        assert!(m.update(&[1., 1.], &mut w).is_err());
        assert!(m.jvp(&[0.3, -0.2], &mut w).is_err());
        let other = LayerModel::new(&layers, &[1., 1.]).unwrap();
        assert!(m.update(&[1., 1.], &mut other.workspace()).is_err());
    }
}

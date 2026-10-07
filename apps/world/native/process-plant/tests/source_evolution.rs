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
}

#[test]
fn local_history_stage_matches_independent_full_jvp_with_incoming_forcing() {
    let m = Evolution::new(input()).unwrap();
    let mut w = m.workspace();
    m.evaluate_into(&state(&m), &mut w).unwrap();
    let rhs = (0..m.state_count())
        .map(|i| 0.13 * ((i % 7) as f64 - 3.))
        .collect::<Vec<_>>();
    let mut p = m.history_preconditioner();
    for cj in [0.01, 3., 1e5] {
        m.prepare_history_preconditioner(&w, cj, &mut p).unwrap();
        let mut ncrhs = vec![0.; m.nc_dimension()];
        let cf = p.prepare_nc_rhs(&rhs, &mut ncrhs).unwrap();
        let mut x = vec![0.; m.state_count()];
        for (i, v) in x[..m.nc_dimension()].iter_mut().enumerate() {
            *v = 0.07 * ((i % 5) as f64 - 2.);
        }
        x[m.cf_row()] = cf;
        let incoming = x.clone();
        m.jvp_into(&incoming, &mut w).unwrap();
        let forcing = w.rate_jvp().unwrap().to_vec();
        let mut cf_only = vec![0.; m.state_count()];
        cf_only[m.cf_row()] = cf;
        m.jvp_into(&cf_only, &mut w).unwrap();
        for i in 0..m.nc_dimension() {
            close(ncrhs[i], rhs[i] + w.rate_jvp().unwrap()[i]);
        }
        m.solve_preconditioner_history(&mut w, &p, &rhs, &mut x)
            .unwrap();
        assert_eq!(&x[..m.nc_dimension()], &incoming[..m.nc_dimension()]);
        assert_eq!(x[m.cf_row()], cf);
        m.jvp_into(&x, &mut w).unwrap();
        let full = w.rate_jvp().unwrap().to_vec();
        // All 34 fuel histories, their coupled U238 depletion, Cf, water,
        // Mn chain and the energy-release audit use their full local stage.
        for i in m.nc_dimension()..m.history_dimension() {
            close(cj * x[i] - full[i], rhs[i]);
        }
        for i in [
            m.water_row(0, false),
            m.water_row(0, true),
            m.mn_row(0),
            m.fuel_release_row(),
        ] {
            close(cj * x[i] - full[i], rhs[i]);
        }
        // Only the target's OWN opacity/collision derivative belongs to P.
        // Other target histories stay coupled in the unchanged outer JVP.
        for t in 0..4 {
            let row = m.target_row(t);
            let mut local = incoming.clone();
            local[row] = x[row];
            m.jvp_into(&local, &mut w).unwrap();
            close(cj * x[row] - w.rate_jvp().unwrap()[row], rhs[row]);
        }
        for row in [m.escape_row(), m.collected_row()] {
            close(cj * x[row] - forcing[row], rhs[row]);
        }
        close(
            cj * (x[..m.nc_dimension()].iter().sum::<f64>() - x[m.ledger_row()]),
            rhs[..m.nc_dimension()].iter().sum::<f64>() - rhs[m.ledger_row()],
        );
    }
    let mut other_workspace = m.workspace();
    m.evaluate_into(&state(&m), &mut other_workspace).unwrap();
    assert!(
        m.solve_preconditioner_history(
            &mut other_workspace,
            &p,
            &rhs,
            &mut vec![0.; m.state_count()]
        )
        .is_err()
    );
    // Exact state reuse preserves the frozen stage; a changed dependency
    // invalidates it. Equal pointers are not evidence of equal dependencies.
    m.evaluate_into(&state(&m), &mut w).unwrap();
    let mut x = vec![0.; m.state_count()];
    m.solve_preconditioner_history(&mut w, &p, &rhs, &mut x)
        .unwrap();
    let mut changed = state(&m);
    changed[0] += 0.01;
    m.evaluate_into(&changed, &mut w).unwrap();
    assert!(
        m.solve_preconditioner_history(&mut w, &p, &rhs, &mut x)
            .is_err()
    );
    m.prepare_history_preconditioner(&w, 3., &mut p).unwrap();
    m.solve_preconditioner_history(&mut w, &p, &rhs, &mut x)
        .unwrap();
    assert!(
        m.prepare_history_preconditioner(&w, f64::NAN, &mut p)
            .is_err()
    );
    assert!(
        p.prepare_nc_rhs(&rhs, &mut vec![0.; m.nc_dimension()])
            .is_err()
    );
}

#[test]
fn exhausted_sf_and_cf_donors_retain_prepared_linear_derivatives() {
    let i = input();
    let rates = i.history.spontaneous_rate_derivatives(0).unwrap();
    assert!(rates.0 > 0. && rates.1 > 0.);
    assert!(i.history.spontaneous_rate_derivatives(1).is_err());
    assert_eq!(i.history.cf_support(), &[(0, 0.25), (1, 0.75)]);
    let cf_law = i.history.cf_law();
    let m = Evolution::new(i).unwrap();
    let mut y = state(&m);
    y[..m.nc_dimension()].fill(0.);
    let r = m.nc_dimension();
    y[r + fh::CONSUMED_235] = 1000.;
    y[r + fh::CAPTURED_238] = 2000.;
    y[r + fh::SF_238] = 0.;
    y[m.cf_row()] = cf_law.initial_energy_j;
    let mut w = m.workspace();
    m.evaluate_into(&y, &mut w).unwrap();
    let mut sf_direction = vec![0.; m.state_count()];
    sf_direction[r + fh::CONSUMED_235] = 1.;
    sf_direction[r + fh::CAPTURED_238] = 1.;
    m.jvp_into(&sf_direction, &mut w).unwrap();
    close(w.rate_jvp().unwrap()[r + fh::CONSUMED_235], -rates.0);
    close(w.rate_jvp().unwrap()[r + fh::SF_238], -rates.1);
    let mut p = m.history_preconditioner();
    m.prepare_history_preconditioner(&w, 2., &mut p).unwrap();
    let mut rhs = vec![0.; m.state_count()];
    rhs[m.cf_row()] = 1.;
    let mut nc = vec![0.; m.nc_dimension()];
    let cf = p.prepare_nc_rhs(&rhs, &mut nc).unwrap();
    close(cf, 1. / (2. + cf_law.decay_rate));
    let mut d = vec![0.; m.state_count()];
    d[m.cf_row()] = cf;
    m.jvp_into(&d, &mut w).unwrap();
    for (a, b) in nc.iter().zip(w.rate_jvp().unwrap()) {
        close(*a, *b);
    }
    let mut x = vec![0.; m.state_count()];
    x[m.cf_row()] = cf;
    m.solve_preconditioner_history(&mut w, &p, &rhs, &mut x)
        .unwrap();
    assert!(x.iter().all(|v| v.is_finite()));
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

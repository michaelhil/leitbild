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
    y[m.mn_product_row(0)] = 1.;
    y
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() < 3e-8 * (1. + a.abs().max(b.abs())),
        "{a:e} != {b:e}"
    );
}
#[test]
fn immutable_physics_accounts_preserve_owned_refs_and_event_budgets() {
    let m = Evolution::new(input()).unwrap();
    let h = m.fuel_history();
    assert_eq!(h.segment_preparations().len(), m.segment_count());
    let p = h.segment_preparations()[0];
    assert_eq!(p.reference_u235, 1000.);
    assert_eq!(p.reference_u238, 2000.);
    assert_eq!(p.sf235_neutrons_per_second, 2.);
    assert_eq!(p.sf238_neutrons_per_second, 3.);
    close(h.fission_energy(), 10.); // Includes the fission-fed reserves once.
    close(
        h.energy_groups()
            .iter()
            .filter(|g| matches!(g.feed, hh::Feed::FertileCapture))
            .map(|g| g.energy_per_event)
            .sum(),
        0.6,
    );
    assert_eq!(h.history_row(0, fh::CONSUMED_235), m.nc_dimension());
    assert_eq!(m.water_owners().len(), 1);
    assert_eq!(m.water_owners()[0].hydrogen, 100000.);
    assert_eq!(m.water_owners()[0].boron, 1000.);
    assert_eq!(m.moderator_law().hydrogen_emission, [0., 2.]);
    assert_eq!(m.moderator_law().boron_emission, [2., 0.4]);
    // All target families share this physical reference array: volume,
    // cylinder and ordered optical targets, not only the Mn subset.
    assert_eq!(m.target_reference_atoms(), &[100.; 4]);
    assert_eq!(m.mn_targets()[0].decay_rate, 0.01);
    assert_eq!(m.mn_targets()[0].electron_j, 2.);
    assert_eq!(m.mn_targets()[0].photon_j, 3.);

    let mut empty = input();
    empty.targets[0] = 0.;
    empty.water_owners[0].boron = 0.;
    for row in &mut empty.water_rows {
        row.mobile_boron10 = 0.;
    }
    let empty = Evolution::new(empty).unwrap();
    assert_eq!(empty.target_reference_atoms()[0], 0.);
    assert_eq!(empty.water_owners()[0].boron, 0.);
    empty
        .validate_accepted_state(&empty.initial_state())
        .unwrap();
}

#[test]
fn unshifted_nc_operator_preserves_stage_and_workspace_contract() {
    let m = Evolution::new(input()).unwrap();
    let mut w = m.workspace();
    let mut literal = vec![0.; m.nc_pattern().len()];
    assert!(m.nc_values(&w, 0., &mut literal).is_err());
    let mut signed = state(&m);
    signed[0] = -0.5;
    for y in [m.initial_state(), state(&m), signed] {
        m.evaluate_into(&y, &mut w).unwrap();
        let mut d = vec![0.; m.state_count()];
        for (i, x) in d[..m.nc_dimension()].iter_mut().enumerate() {
            *x = 0.1 * (i % 5) as f64 - 0.2;
        }
        m.jvp_into(&d, &mut w).unwrap();
        m.nc_values(&w, 0., &mut literal).unwrap();
        let mut shifted = literal.clone();
        m.nc_values(&w, 3., &mut shifted).unwrap();
        let mut product = vec![0.; m.nc_dimension()];
        for (&(r, c), (&a, &b)) in m.nc_pattern().iter().zip(literal.iter().zip(&shifted)) {
            product[r] += a * d[c];
            close(b - a, if r == c { 3. } else { 0. });
        }
        for (i, &a) in product.iter().enumerate() {
            close(a, -w.rate_jvp().unwrap()[i]);
        }
    }

    // Another prepared state does not invalidate a legitimately frozen stage.
    let frozen = literal.clone();
    m.evaluate_into(&m.initial_state(), &mut m.workspace())
        .unwrap();
    m.nc_values(&w, 0., &mut literal).unwrap();
    assert_eq!(literal, frozen);

    let other = Evolution::new(input()).unwrap();
    let mut foreign = other.workspace();
    other
        .evaluate_into(&other.initial_state(), &mut foreign)
        .unwrap();
    assert!(m.nc_values(&foreign, 0., &mut literal).is_err());
    assert_eq!(literal, frozen);
    for cj in [-1., f64::NAN, f64::INFINITY] {
        assert!(m.nc_values(&w, cj, &mut literal).is_err());
    }
    assert!(m.nc_values(&w, 0., &mut literal[..1]).is_err());

    // A failed refresh invalidates that workspace, even if it was previously
    // valid and the caller requests the same old operator afterwards.
    let mut invalid = m.initial_state();
    invalid[m.water_row(0, false)] = m.water_owners()[0].hydrogen + 1.;
    assert!(m.evaluate_into(&invalid, &mut w).is_err());
    assert!(m.nc_values(&w, 0., &mut literal).is_err());
    m.evaluate_into(&m.initial_state(), &mut w).unwrap();
    m.nc_values(&w, 0., &mut literal).unwrap();
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
    close(r[m.mn_product_row(0)], 0.01 * y[m.target_row(0)]);
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
fn complete_sparse_jacobian_preserves_full_couplings_and_solver_basis() {
    let m = Evolution::new(input()).unwrap();
    let j = Jacobian::new(&m).unwrap();
    assert!(j
        .pattern()
        .windows(2)
        .all(|p| (p[0].1, p[0].0) < (p[1].1, p[1].0)));
    let mut w = m.workspace();
    let mut values = vec![0.; j.pattern().len()];
    for y in [m.initial_state(), state(&m)] {
        m.evaluate_into(&y, &mut w).unwrap();
        for cj in [0.01, 3., 1e5] {
            for column in 0..m.state_count() {
                // Small fixture only: independent basis directions exercise
                // every structural column, including zero-state feedback.
                let mut direction = vec![0.; m.state_count()];
                direction[column] = if column % 2 == 0 { 0.7 } else { -0.3 };
                m.jvp_into(&direction, &mut w).unwrap();
                let tangent = w.rate_jvp().unwrap().to_vec();
                j.values(&m, &mut w, cj, &mut values).unwrap();
                let mut product = vec![0.; m.state_count()];
                for (&(r, c), &a) in j.pattern().iter().zip(&values) {
                    product[r] += a * direction[c];
                }
                for row in 0..m.state_count() {
                    let expected = cj * direction[row] - tangent[row];
                    assert!(
                        (product[row] - expected).abs() < 2e-10 * (1. + expected.abs()),
                        "physical row{row} col{column}: {} vs {expected}",
                        product[row]
                    );
                }
                let mut solver_direction = direction.clone();
                solver_direction[m.ledger_row()] =
                    direction[..m.nc_dimension()].iter().sum::<f64>() - direction[m.ledger_row()];
                j.solver_values(&m, &mut w, cj, &mut values).unwrap();
                product.fill(0.);
                for (&(r, c), &a) in j.pattern().iter().zip(&values) {
                    product[r] += a * solver_direction[c];
                }
                let mut expected = tangent.clone();
                expected[m.ledger_row()] =
                    tangent[..m.nc_dimension()].iter().sum::<f64>() - tangent[m.ledger_row()];
                for row in 0..m.state_count() {
                    close(product[row], cj * solver_direction[row] - expected[row]);
                }
            }
        }
    }
    let other = Evolution::new(input()).unwrap();
    let mut foreign = other.workspace();
    other
        .evaluate_into(&other.initial_state(), &mut foreign)
        .unwrap();
    assert!(j.values(&m, &mut foreign, 1., &mut values).is_err());
    assert!(j.values(&other, &mut foreign, 1., &mut values).is_err());
    assert!(j.values(&m, &mut w, f64::NAN, &mut values).is_err());
    assert!(j.values(&m, &mut w, 1., &mut []).is_err());
}

#[test]
fn internal_ordered_panels_keep_both_sides_shared_targets_and_all_jacobian_columns() {
    let mut data = input();
    data.faces.push(ts::Face {
        left: 1,
        right: None,
        area: 0.7,
        left_distance: 0.,
        right_distance: None,
        law: ts::FaceLaw::InternalOptical {
            targets: vec![0, 1, 0],
        },
    });
    // Target 0 is also a bulk target; target 1 is on the shared optical face.
    // Repeating target 0 across ordered layers must differentiate its one stock.
    data.optical_layers.push(
        [(0, 100., 0.003), (1, 80., 0.002), (0, 20., 0.001)]
            .into_iter()
            .map(|(target, atoms_per_m2, sigma)| {
                let mut sigma_m2 = [sigma; 7];
                sigma_m2[1] = 0.;
                os::Layer {
                    columns: vec![os::Column {
                        target,
                        atoms_per_m2,
                        sigma_m2,
                    }],
                }
            })
            .collect(),
    );
    let m = Evolution::new(data).unwrap();
    let base = Evolution::new(input()).unwrap();
    let j = Jacobian::new(&m).unwrap();
    let mut w = m.workspace();
    let mut bw = base.workspace();
    let mut exhausted = state(&m);
    exhausted[m.target_row(0)] = 100. - exhausted[m.mn_product_row(0)];
    exhausted[m.target_row(1)] = 100.;
    for y in [m.initial_state(), state(&m), exhausted] {
        m.evaluate_into(&y, &mut w).unwrap();
        base.evaluate_into(&y, &mut bw).unwrap();
        // Independently count the extra physical absorption and prove that it
        // never becomes escape; zero-opacity group 1 has no panel contribution.
        let capture = [0, 1]
            .iter()
            .map(|&target| {
                w.rates().unwrap()[m.target_row(target)] - bw.rates().unwrap()[m.target_row(target)]
            })
            .sum::<f64>();
        close(
            w.rates().unwrap()[m.ledger_row()] - bw.rates().unwrap()[m.ledger_row()],
            -capture,
        );
        close(
            w.rates().unwrap()[m.escape_row()],
            bw.rates().unwrap()[m.escape_row()],
        );
        close(w.rates().unwrap()[7 + 1], bw.rates().unwrap()[7 + 1]);
        close(
            m.conservation(w.rates().unwrap())
                .unwrap()
                .neutron_ledger_defect,
            0.,
        );
        let mut matrix = vec![0.; j.pattern().len()];
        for column in 0..m.state_count() {
            let mut direction = vec![0.; m.state_count()];
            direction[column] = if column % 2 == 0 { 0.7 } else { -0.3 };
            m.jvp_into(&direction, &mut w).unwrap();
            let mut expected = w.rate_jvp().unwrap().to_vec();
            for solver in [false, true] {
                let mut v = direction.clone();
                if solver {
                    v[m.ledger_row()] = direction[..m.nc_dimension()].iter().sum::<f64>()
                        - direction[m.ledger_row()];
                    expected[m.ledger_row()] =
                        expected[..m.nc_dimension()].iter().sum::<f64>() - expected[m.ledger_row()];
                    j.solver_values(&m, &mut w, 17., &mut matrix).unwrap();
                } else {
                    j.values(&m, &mut w, 17., &mut matrix).unwrap();
                }
                let mut product = vec![0.; m.state_count()];
                for (&(r, c), &a) in j.pattern().iter().zip(&matrix) {
                    product[r] += a * v[c];
                }
                for row in 0..m.state_count() {
                    close(product[row], 17. * v[row] - expected[row]);
                }
            }
        }
    }
}

#[test]
fn sparse_incidence_keeps_shared_feedback_but_not_identically_zero_material_laws() {
    let mut data = input();
    data.passive_stocks[0].targets[0].sigma_m2[0] = 0.;
    data.cylinder_targets[0].sigma_m2[2] = 0.;
    for layer in &mut data.optical_layers[0] {
        for column in &mut layer.columns {
            column.sigma_m2[1] = 0.;
        }
    }
    // Same target in two ordered layers; every layer moves when its one owned
    // progress changes. The target also has a bulk capture contribution.
    data.optical_layers[0].push(os::Layer {
        columns: vec![
            os::Column {
                target: 0,
                atoms_per_m2: 2.,
                sigma_m2: [0.001; 7],
            },
            os::Column {
                target: 1,
                atoms_per_m2: 3.,
                sigma_m2: [0.002; 7],
            },
        ],
    });
    data.faces[0].law = ts::FaceLaw::Optical {
        targets: vec![1, 3, 0, 1],
    };
    let m = Evolution::new(data).unwrap();
    let j = Jacobian::new(&m).unwrap();
    let mut w = m.workspace();
    let mut matrix = vec![0.; j.pattern().len()];
    for y in [m.initial_state(), state(&m)] {
        m.evaluate_into(&y, &mut w).unwrap();
        j.values(&m, &mut w, 2., &mut matrix).unwrap();
        let direction = (0..m.state_count())
            .map(|i| 0.003 * ((i % 11) as f64 - 5.))
            .collect::<Vec<_>>();
        m.jvp_into(&direction, &mut w).unwrap();
        let mut product = vec![0.; m.state_count()];
        for (&(r, c), &v) in j.pattern().iter().zip(&matrix) {
            product[r] += v * direction[c];
        }
        for (i, &d) in w.rate_jvp().unwrap().iter().enumerate() {
            close(product[i], 2. * direction[i] - d);
        }
    }
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
    let mut d = vec![0.; m.state_count()];
    d[m.cf_row()] = 1.;
    m.jvp_into(&d, &mut w).unwrap();
    close(w.rate_jvp().unwrap()[m.cf_row()], -cf_law.decay_rate);
    close(
        w.rate_jvp().unwrap()[..m.nc_dimension()].iter().sum(),
        -cf_law.initial_neutrons_per_second / cf_law.initial_energy_j,
    );
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
fn direct_mn_fe_chain_matches_analytic_decay_and_resolvable_progress_law() {
    let m = Evolution::new(input()).unwrap();
    let mut old_input = input();
    old_input.mn.clear();
    let old = Evolution::new(old_input).unwrap();
    let mut w = m.workspace();
    let mut ow = old.workspace();
    let lambda = m.mn_targets()[0].decay_rate;
    for t in [0., 1., 100.] {
        let mut y = m.initial_state();
        let direct = 3. * (-lambda * t).exp();
        y[m.target_row(0)] = direct;
        y[m.mn_product_row(0)] = 1. + 3. * (-(-lambda * t).exp_m1());
        m.validate_accepted_state(&y).unwrap();
        m.evaluate_into(&y, &mut w).unwrap();
        close(m.consumed_target(&y, 0).unwrap(), 4.);
        close(w.rates().unwrap()[m.target_row(0)], -lambda * direct);
        close(w.rates().unwrap()[m.mn_product_row(0)], lambda * direct);
    }
    // The old resolvable C/F chart gives precisely the same capture law and
    // C'=M'+F'; only its subtraction-based physical domain was problematic.
    let y = state(&m);
    let mut oy = old.initial_state();
    oy[..old.ledger_row()].copy_from_slice(&y[..old.ledger_row()]);
    oy[old.target_row(0)] = m.consumed_target(&y, 0).unwrap();
    m.evaluate_into(&y, &mut w).unwrap();
    old.evaluate_into(&oy, &mut ow).unwrap();
    for row in 0..m.nc_dimension() {
        close(w.rates().unwrap()[row], ow.rates().unwrap()[row]);
    }
    let capture = ow.rates().unwrap()[old.target_row(0)];
    close(
        w.rates().unwrap()[m.target_row(0)] + w.rates().unwrap()[m.mn_product_row(0)],
        capture,
    );
    close(
        w.rates().unwrap()[m.target_row(0)],
        capture - lambda * y[m.target_row(0)],
    );
    close(
        w.diagnostics().unwrap().mn_electron_release_w,
        2. * lambda * y[m.target_row(0)],
    );
}

#[test]
fn direct_mn_survives_unrepresentable_consumption_increment_and_cache_reuse() {
    let mut data = input();
    data.targets[0] = 1e100;
    let m = Evolution::new(data).unwrap();
    let mut w = m.workspace();
    let mut y = m.initial_state();
    y[m.target_row(0)] = 1e-100;
    y[m.mn_product_row(0)] = 1e80;
    assert_eq!(m.consumed_target(&y, 0).unwrap(), y[m.mn_product_row(0)]);
    m.validate_accepted_state(&y).unwrap();
    m.evaluate_into(&y, &mut w).unwrap();
    let decay = w.rates().unwrap()[m.mn_product_row(0)];
    assert!(decay > 0.);
    assert_eq!(decay, 0.01 * 1e-100);
    assert_eq!(w.rates().unwrap()[m.target_row(0)], -decay);
    assert!(w.diagnostics().unwrap().mn_electron_release_w > 0.);
    y[m.target_row(0)] *= 2.;
    // The summed consumption bit pattern has not changed; the authoritative
    // direct-inventory cache key MUST still observe the changed Mn56.
    assert_eq!(m.consumed_target(&y, 0).unwrap(), y[m.mn_product_row(0)]);
    m.evaluate_into(&y, &mut w).unwrap();
    assert_eq!(w.rates().unwrap()[m.mn_product_row(0)], 2. * decay);
    let mut direction = vec![0.; m.state_count()];
    direction[m.target_row(0)] = 1e-100;
    m.jvp_into(&direction, &mut w).unwrap();
    assert_eq!(w.rate_jvp().unwrap()[m.mn_product_row(0)], decay);
    let foreign = Evolution::new(input()).unwrap();
    assert!(m.evaluate_into(&y, &mut foreign.workspace()).is_err());
    y[m.target_row(0)] = -1e-100;
    assert!(m.validate_accepted_state(&y).is_err());
    y[m.target_row(0)] = 1e100;
    y[m.mn_product_row(0)] = 1e100;
    assert!(m.validate_accepted_state(&y).is_err());
    assert!(m.consumed_target(&y[..2], 0).is_err());
    assert!(m.consumed_target(&y, 4).is_err());
    y[m.mn_product_row(0)] = f64::NAN;
    assert!(m.consumed_target(&y, 0).is_err());
}

#[test]
fn mn_consumption_columns_cover_bulk_cylinder_and_ordered_optics() {
    let mut data = input();
    data.mn = (0..4)
        .map(|target| MnTarget {
            target,
            decay_rate: 0.01,
            electron_j: 2.,
            photon_j: 3.,
        })
        .collect();
    let m = Evolution::new(data).unwrap();
    let y = state(&m);
    let mut w = m.workspace();
    m.evaluate_into(&y, &mut w).unwrap();
    let j = Jacobian::new(&m).unwrap();
    let mut matrix = vec![0.; j.pattern().len()];
    j.values(&m, &mut w, 3., &mut matrix).unwrap();
    for i in 0..4 {
        let mut d = vec![0.; m.state_count()];
        d[m.target_row(i)] = 0.7;
        d[m.mn_product_row(i)] = -0.7;
        m.jvp_into(&d, &mut w).unwrap();
        let a = w.rate_jvp().unwrap();
        for (r, &v) in a.iter().enumerate() {
            let expected = if r == m.target_row(i) {
                -0.007
            } else if r == m.mn_product_row(i) {
                0.007
            } else {
                0.
            };
            assert!((v - expected).abs() < 1e-14, "row{r} target{i}: {v}");
        }
        // Full assembled physical matrix includes BOTH consumption columns.
        let mut product = vec![0.; m.state_count()];
        for (&(r, c), &v) in j.pattern().iter().zip(&matrix) {
            product[r] += v * d[c];
        }
        for r in 0..product.len() {
            close(product[r], 3. * d[r] - a[r]);
        }
        // Non-cancelling individual M and Fe columns agree with independent
        // full/half forward differences, including all transport feedback.
        for column in [m.target_row(i), m.mn_product_row(i)] {
            d.fill(0.);
            d[column] = 1.;
            m.jvp_into(&d, &mut w).unwrap();
            let derivative = w.rate_jvp().unwrap().to_vec();
            for h in [1e-5, 5e-6] {
                let mut p = m.workspace();
                let mut n = m.workspace();
                let mut yp = y.clone();
                yp[column] += h;
                let mut yn = y.clone();
                yn[column] -= h;
                m.evaluate_into(&yp, &mut p).unwrap();
                m.evaluate_into(&yn, &mut n).unwrap();
                for r in 0..derivative.len() {
                    close(
                        derivative[r],
                        (p.rates().unwrap()[r] - n.rates().unwrap()[r]) / (2. * h),
                    );
                }
            }
        }
    }
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

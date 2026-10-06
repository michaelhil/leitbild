use leitbild_plant_numerics::primary_constraints::{
    Carrier, Edge, Network, mechanics, project_metric,
};

fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 2e-11 * a.abs().max(b.abs()).max(1.),
        "{a} != {b}"
    );
}
fn dot(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
fn graph(root: usize) -> Network {
    Network::new(
        4,
        &[
            Edge { from: 0, to: 1 },
            Edge { from: 1, to: 2 },
            Edge { from: 2, to: 0 },
            Edge { from: 1, to: 2 },
            Edge { from: 1, to: 3 },
        ],
        root,
    )
    .unwrap()
}

#[test]
fn signed_cycles_and_finite_tree_inventory_have_distinct_mass_rates() {
    let g = graph(0);
    assert_eq!(g.rank(), 3);
    assert_eq!(g.cycle_count(), 2);
    for j in 0..g.cycle_count() {
        let s: Vec<_> = g.cycles().iter().map(|row| row[j]).collect();
        for x in g.divergence(&s).unwrap() {
            close(x, 0.);
        }
        // Pendant inventory has no circulation, but receives redistribution.
        close(s[4], 0.);
    }
    let rates = [-7., 2., 1., 4.];
    for amplitudes in [[0., 0.], [3., -2.], [-3000., 2000.]] {
        let f = g.reconstruct(&amplitudes, &rates).unwrap();
        for (actual, expected) in g.divergence(&f).unwrap().iter().zip(rates) {
            close(*actual, expected);
        }
        close(f[4], 4.);
    }
    for (j, n) in (1..4).enumerate() {
        let t: Vec<_> = g.tree_basis().unwrap().iter().map(|row| row[j]).collect();
        for (i, x) in g.divergence(&t).unwrap().iter().enumerate() {
            close(
                *x,
                if i == n {
                    1.
                } else if i == 0 {
                    -1.
                } else {
                    0.
                },
            );
        }
    }
    assert!(g.tree_lift(&[0., 0., 0., 1.]).is_err());
}

#[test]
fn changed_gauge_preserves_edge_flow_constraints_and_explicit_root_balance() {
    let b = [-7., 2., 1., 4.];
    for root in 0..4 {
        let g = graph(root);
        let f = g.tree_lift(&b).unwrap();
        for (x, y) in g.divergence(&f).unwrap().iter().zip(b) {
            close(*x, y);
        }
        assert!(g.tree_lift(&[-7., 2., 1., 5.]).is_err());
    }
}

#[test]
fn whole_carrier_metric_retains_trunk_crossblocks_and_tree_motion() {
    let g = graph(0);
    let f = g.reconstruct(&[30., 20.], &[-5., 0., 0., 5.]).unwrap();
    let zero = [0.; 5];
    let maps = [
        [0.003, 0., 0., 0., 0.],
        [0., 0.006, 0., 0., 0.],
        [0., 0., 0.002, 0., 0.],
        [0., 0., 0., 0.009, 0.],
        [0., 0., 0., 0., 0.015],
    ];
    let names = ["trunk", "passage1", "return", "passage2", "surge"];
    let carriers: Vec<_> = maps
        .iter()
        .zip(names)
        .map(|(r, owner)| Carrier {
            owner,
            mass: 500.,
            mass_rate: 0.,
            velocity_map: r,
            velocity_map_rate: &zero,
        })
        .collect();
    let m = mechanics(&f, &zero, &carriers).unwrap();
    close(
        m.kinetic_energy,
        carriers
            .iter()
            .map(|c| 0.5 * c.mass * dot(c.velocity_map, &f).powi(2))
            .sum(),
    );
    let ss = project_metric(&m.metric, g.cycles(), g.cycles()).unwrap();
    assert!(ss[0][0] > 0. && ss[1][1] > 0.);
    assert!(ss[0][0] * ss[1][1] - ss[0][1] * ss[1][0] > 0.);
    assert!(
        ss[0][1].abs() > 0.,
        "Shared trunk must not lose cross inertia"
    );
    let t = g.tree_basis().unwrap();
    let st = project_metric(&m.metric, g.cycles(), &t).unwrap();
    assert!(st.iter().flatten().any(|x| x.abs() > 0.));
    let tt = project_metric(&m.metric, &t, &t).unwrap();
    assert!(
        tt[2][2] > 0.,
        "Surge redistribution has real kinetic storage"
    );
}

#[test]
fn changing_mass_and_velocity_map_are_both_in_conjugate_energy_identity() {
    let f = [3., -5.];
    let fd = [-2., 7.];
    let r = [0.3, -0.4];
    let rd = [0.02, 0.07];
    let c = Carrier {
        owner: "finite passage",
        mass: 27.,
        mass_rate: -3.,
        velocity_map: &r,
        velocity_map_rate: &rd,
    };
    let m = mechanics(&f, &fd, &[c]).unwrap();
    close(m.kinetic_rate, m.conjugate_identity_rate);
    let direct =
        0.5 * (-3.) * dot(&r, &f).powi(2) + 27. * dot(&r, &f) * (dot(&r, &fd) + dot(&rd, &f));
    close(m.kinetic_rate, direct);
    let h = 1e-5;
    let energy = |dt: f64| {
        let rt: Vec<_> = r.iter().zip(rd).map(|(a, b)| a + dt * b).collect();
        let ft: Vec<_> = f.iter().zip(fd).map(|(a, b)| a + dt * b).collect();
        0.5 * (27. - 3. * dt) * dot(&rt, &ft).powi(2)
    };
    assert!(((energy(h) - energy(-h)) / (2. * h) - direct).abs() < 1e-6);
    let omitted_map_rate = 0.5 * (-3.) * dot(&r, &f).powi(2) + 27. * dot(&r, &f) * dot(&r, &fd);
    assert!((omitted_map_rate - direct).abs() > 1.);
    let omitted_mass_rate = 27. * dot(&r, &f) * (dot(&r, &fd) + dot(&rd, &f));
    assert!((omitted_mass_rate - direct).abs() > 1.);
}

#[test]
fn pressure_and_specific_mass_multiplier_are_not_conflated() {
    let g = graph(0);
    let f = g.reconstruct(&[100., -40.], &[0.; 4]).unwrap();
    let mu = [3., 7., -2., 11.];
    let mass_force = g.mass_multiplier_force(&mu).unwrap();
    close(dot(&f, &mass_force), dot(&mu, &g.divergence(&f).unwrap()));
    let p = [15e6, 15.1e6, 14.9e6, 16e6];
    let rho = [800., 700., 600., 750., 500.];
    let (force, volume_divergence) = g.pressure_work(&p, &rho, &f).unwrap();
    close(dot(&f, &force), dot(&p, &volume_divergence));
    assert!(dot(&f, &force).abs() > 100.);
    assert!(volume_divergence.iter().any(|x| x.abs() > 0.));
    let (equal_force, equal_div) = g.pressure_work(&p, &[700.; 5], &f).unwrap();
    close(dot(&f, &equal_force), 0.);
    for x in equal_div {
        close(x, 0.);
    }
    let (same_force, _) = g.pressure_work(&[15e6; 4], &rho, &f).unwrap();
    close(dot(&f, &same_force), 0.);
}

#[test]
fn invalid_or_duplicate_primary_inputs_fail_instead_of_losing_inventory() {
    assert!(Network::new(3, &[Edge { from: 0, to: 1 }], 0).is_err());
    assert!(Network::new(2, &[Edge { from: 0, to: 2 }], 0).is_err());
    assert!(Network::new(2, &[Edge { from: 0, to: 0 }], 0).is_err());
    assert!(Network::new(2, &[Edge { from: 0, to: 1 }], 2).is_err());
    let g = graph(0);
    assert!(g.reconstruct(&[1.], &[0.; 4]).is_err());
    assert!(
        g.tree_lift(&[f64::MAX, f64::MAX, -f64::MAX, -f64::MAX])
            .is_err()
    );
    assert!(g.divergence(&[f64::NAN; 5]).is_err());
    assert!(g.divergence(&[f64::MAX; 5]).is_err());
    assert!(g.pressure_work(&[1.; 4], &[0.; 5], &[1.; 5]).is_err());
    assert!(g.pressure_work(&[1.; 4], &[1.; 5], &[1.; 4]).is_err());
    let r = [1.];
    let rd = [0.];
    let c = || Carrier {
        owner: "same",
        mass: 1.,
        mass_rate: 0.,
        velocity_map: &r,
        velocity_map_rate: &rd,
    };
    assert!(mechanics(&[1.], &[0.], &[c(), c()]).is_err());
    assert!(mechanics(&[1.], &[0.], &[Carrier { mass: -1., ..c() }]).is_err());
    assert!(
        mechanics(
            &[1.],
            &[0.],
            &[Carrier {
                velocity_map: &[],
                ..c()
            }]
        )
        .is_err()
    );
    assert!(mechanics(&[f64::INFINITY], &[0.], &[c()]).is_err());
    assert!(
        mechanics(
            &[1.],
            &[0.],
            &[Carrier {
                velocity_map: &rd,
                ..c()
            }]
        )
        .is_err()
    );
    assert!(project_metric(&[vec![1.]], &[vec![1.]], &[vec![f64::NAN]]).is_err());
}

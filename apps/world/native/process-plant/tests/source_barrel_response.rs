//! Reduced law-only fixture. No LD-01 preparation or advancing solve.
#[path = "common/source_input.rs"]
mod source_fixture;
use leitbild_plant_numerics::{
    passive_source as ps, source_evolution::Evolution, transport_source as ts,
};

fn fixture() -> Evolution {
    let mut i = source_fixture::input();
    i.passive_stocks[0].targets = (0..4)
        .map(|index| ps::Target {
            index,
            sigma_m2: [0.001 * (index + 1) as f64; 7],
        })
        .collect();
    i.passive_incidence.push(ps::Intersection {
        stock: 0,
        region: 1,
        volume: 0.02,
    });
    i.passive_incidence[0].volume = 0.08;
    // The component requires a real cylinder owner; retain the original
    // independent path under a fifth target, outside the barrel response.
    i.targets.push(100.);
    i.cylinder_targets[0].index = 4;
    i.optical_layers.clear();
    i.faces[0].law = ts::FaceLaw::Transparent;
    Evolution::new(i).unwrap()
}
#[test]
fn sparse_barrel_release_matches_independent_capture_and_full_jvp() {
    let m = fixture();
    let q = [0.1, 0.2, 0.3, 0.4];
    let response = m.barrel_response([0, 1, 2, 3], q).unwrap();
    for row in response.offsets().windows(2) {
        assert!(
            response.columns()[row[0]..row[1]]
                .windows(2)
                .all(|w| w[0] < w[1])
        );
    }
    let mut power = vec![0.; 2];
    let mut gradient = vec![0.; response.columns().len()];
    for (n, consumed, mn, fe) in [
        (0., 0., 0., 0.),
        (3., 20., 2., 5.),
        (-2., 30., 1., 4.),
        (2., 100., 0., 100.),
        (2., 20., 1e-100, 50.),
    ] {
        let mut y = m.initial_state();
        y[..m.nc_dimension()].fill(n);
        for t in 0..4 {
            y[m.target_row(t)] = consumed;
        }
        y[m.target_row(0)] = mn;
        y[m.mn_product_row(0)] = fe;
        let mut w = m.workspace();
        m.evaluate_into(&y, &mut w).unwrap();
        response.evaluate(&y, &mut power, &mut gradient).unwrap();
        let expected = w
            .target_captures()
            .unwrap()
            .iter()
            .zip(q)
            .map(|(c, q)| c * q)
            .sum::<f64>();
        assert!((power[0] - expected).abs() < 3e-14 * expected.abs().max(1.));
        assert_eq!(power[1], 0.01 * 5. * mn);
        let direction = (0..m.state_count())
            .map(|i| 0.01 * ((i % 7) as f64 - 3.))
            .collect::<Vec<_>>();
        m.jvp_into(&direction, &mut w).unwrap();
        let expected = [
            w.target_capture_jvp()
                .unwrap()
                .iter()
                .zip(q)
                .map(|(c, q)| c * q)
                .sum::<f64>(),
            0.05 * direction[m.target_row(0)],
        ];
        for out in 0..2 {
            let action = (response.offsets()[out]..response.offsets()[out + 1])
                .map(|s| gradient[s] * direction[response.columns()[s]])
                .sum::<f64>();
            assert!((action - expected[out]).abs() < 3e-14 * expected[out].abs().max(1.));
        }
        let mut bad = y.clone();
        bad[response.columns()[0]] = f64::NAN;
        assert!(response.evaluate(&bad, &mut power, &mut gradient).is_err());
    }
}
#[test]
fn capture_accessor_keeps_tiny_birth_separate_from_larger_decay_and_failure_invalidates() {
    let m = fixture();
    let mut y = m.initial_state();
    y[m.target_row(0)] = 1.;
    // Zero field still decays Mn, but its captured-event receipt is exactly zero.
    let mut w = m.workspace();
    m.evaluate_into(&y, &mut w).unwrap();
    assert_eq!(w.target_captures().unwrap()[0], 0.);
    assert_eq!(w.rates().unwrap()[m.target_row(0)], -0.01);
    let mut d = vec![0.; m.state_count()];
    d[m.target_row(0)] = 1.;
    m.jvp_into(&d, &mut w).unwrap();
    assert_eq!(w.target_capture_jvp().unwrap()[0], 0.);
    y[0] = f64::NAN;
    assert!(m.evaluate_into(&y, &mut w).is_err());
    assert!(w.target_captures().is_err());
    assert!(w.target_capture_jvp().is_err());
}

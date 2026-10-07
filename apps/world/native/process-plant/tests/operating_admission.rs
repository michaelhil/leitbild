//! Shared admission counterexamples on a reduced finite native apparatus.
//! Geometry below is test-only; IF97/chart/hydraulic laws remain component-owned.
use leitbild_plant_numerics::{CellGeometry, operating_admission as a, operating_network as n};

fn fixture() -> n::Network {
    n::Network::new(n::Config {
        water: (0..2)
            .map(|i| n::Water {
                geometry: CellGeometry {
                    volume: 1. + i as f64,
                    elevation: 0.,
                },
                initial_pressure: 1e7,
                initial_temperature: 300. + i as f64,
                initial_tracer_fraction: 0.002,
            })
            .collect(),
        solids: vec![n::Solid {
            heat_capacity: 40000.,
            initial_temperature: 310.,
        }],
        hydraulic: vec![n::Hydraulic {
            from: 0,
            to: 1,
            law: n::LossLaw::EffectiveTotal,
            length: 1.,
            diameter: 0.1,
            roughness: 0.,
            fixed_loss: 2.,
            grid_multiplier: 0.,
            flow_area: 0.1,
        }],
        heat: vec![n::Heat {
            from: 0,
            to: 2,
            law: n::HeatLaw::Conductance(50.),
        }],
        secondaries: vec![],
        secondary_heat: vec![],
    })
    .unwrap()
}
fn evaluated(n: &n::Network, y: &[f64]) -> n::Workspace {
    let mut w = n::Workspace::new(n);
    w.evaluate(n, y, &vec![0.; n.dimension()], None).unwrap();
    w
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 2e-15 * a.abs().max(b.abs()),
        "{a:e} != {b:e}"
    );
}

#[test]
fn extracted_weights_retain_literal_scales_and_true_absolute_refinement() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let w = evaluated(&n, &y);
    let normal = a::weights(&n, &w, &y, 300., 1.).unwrap();
    let tight = a::weights(&n, &w, &y, 300., 0.1).unwrap();
    for (&x, &t) in normal.absolute.iter().zip(&tight.absolute) {
        close(t, 0.1 * x);
    }
    assert_eq!(normal.absolute[n.pressure_row()], 100.);
    assert_eq!(normal.absolute[n.total_mass_row()], 1e-5);
    assert_eq!(normal.absolute[n.energy_row(2)], 40.);
    for i in 0..2 {
        assert_eq!(normal.absolute[n.marker_row(i)], 1e-8);
        assert_eq!(normal.absolute[n.temperature_row(i)], 1e-3);
        close(
            normal.absolute[n.energy_row(i)],
            n.mass(i, w.liquids[i]) * w.liquids[i].cp * 1e-3,
        );
    }
    let contrast = w.liquids.iter().map(|l| l.cp).fold(0_f64, f64::max) * 10.
        + (w.liquids[1].enthalpy - w.liquids[0].enthalpy);
    close(normal.flow_contrast, contrast);
    let q = (0..2)
        .map(|i| n.mass(i, w.liquids[i]) * w.liquids[i].cp * 1e-3 / (300. * contrast))
        .fold(f64::INFINITY, f64::min);
    close(normal.flow[0], q);
    assert_eq!(normal.absolute[n.flow_row(0)], normal.flow[0]);
    assert!(a::weights(&n, &w, &y, 0., 1.).is_err());
    assert!(a::weights(&n, &w, &y, 300., f64::NAN).is_err());
}

#[test]
fn existing_mass_energy_marker_thresholds_are_not_bypassed_or_reallocated() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let w = evaluated(&n, &y);
    let expected = a::totals(&n, &y);
    let flow = a::weights(&n, &w, &y, 300., 1.).unwrap().flow;
    a::screen(&n, &w, &y, expected, &flow).unwrap();
    for (i, limit) in [(0, 1e-6), (1, 1.), (2, 1e-8)] {
        let mut inside = expected;
        inside[i] += 0.5 * limit;
        a::screen(&n, &w, &y, inside, &flow).unwrap();
        let mut outside = expected;
        outside[i] += 2. * limit;
        assert!(a::screen(&n, &w, &y, outside, &flow).is_err(), "ledger{i}");
    }
    let mut bad = expected;
    bad[1] = f64::NAN;
    assert!(a::screen(&n, &w, &y, bad, &flow).is_err());
}

#[test]
fn nonfinite_or_singular_current_charts_and_properties_fail_closed() {
    let n = fixture();
    let y = n.initial_state().unwrap();
    let expected = a::totals(&n, &y);
    let base = evaluated(&n, &y);
    let flow = a::weights(&n, &base, &y, 300., 1.).unwrap().flow;
    for fault in 0..6 {
        let mut w = evaluated(&n, &y);
        match fault {
            0 => w.residual[n.temperature_row(0)] = f64::NAN,
            1 => w.chart_derivatives[0][3] = 0.,
            2 => {
                w.liquids[0].cp = f64::NAN;
                w.liquids[1].cp = f64::NAN;
            }
            3 => w.liquids[0].compressibility = f64::NAN,
            4 => w.mass_flows[0] = f64::NAN,
            _ => w.chart_derivatives[0][0] = f64::INFINITY,
        }
        assert!(
            a::screen(&n, &w, &y, expected, &flow).is_err(),
            "fault={fault}"
        );
    }
    let mut w = evaluated(&n, &y);
    w.liquids[0].cp = f64::NAN;
    assert!(a::weights(&n, &w, &y, 300., 1.).is_err());
    let w = evaluated(&n, &y);
    let mut bad = y.clone();
    bad[n.energy_row(2)] = f64::NAN;
    assert!(a::weights(&n, &w, &bad, 300., 1.).is_err());
    let mut w = evaluated(&n, &y);
    w.liquids[0].enthalpy = f64::NAN;
    assert!(a::weights(&n, &w, &y, 300., 1.).is_err());
}

#[test]
fn shared_pressure_and_secondary_chart_corrections_keep_existing_local_limits() {
    let mut config = fixture().config().clone();
    config.secondaries = vec![n::Secondary {
        volume: 120.,
        initial_temperature: 313.15,
        initial_pressure: 101325.,
        initial_liquid_volume: 72.,
        initial_nitrogen_mass: 0.,
        minimum_wetted_liquid_volume: 71.25,
    }];
    let n = n::Network::new(config).unwrap();
    let y = n.initial_state().unwrap();
    let expected = a::totals(&n, &y);
    let base = evaluated(&n, &y);
    let flow = a::weights(&n, &base, &y, 300., 1.).unwrap().flow;
    a::screen(&n, &base, &y, expected, &flow).unwrap();
    let compliance = base
        .chart_derivatives
        .iter()
        .map(|d| d[0] - d[1] * d[2] / d[3])
        .sum::<f64>();
    let mut w = evaluated(&n, &y);
    w.residual[n.pressure_row()] = 6. * compliance;
    assert!(a::screen(&n, &w, &y, expected, &flow).is_err());
    for (delta, passes) in [(0.5e-4, true), (2e-4, false)] {
        let mut w = evaluated(&n, &y);
        let [_, mt, _, et] = w.chart_derivatives[0];
        w.residual[n.temperature_row(0)] = et * delta;
        w.residual[n.pressure_row()] = mt * delta;
        assert_eq!(a::screen(&n, &w, &y, expected, &flow).is_ok(), passes);
    }
    let mut w = evaluated(&n, &y);
    w.residual[n.secondary_temperature_row(0)] = 1e6;
    assert!(a::screen(&n, &w, &y, expected, &flow).is_err());
    let mut w = evaluated(&n, &y);
    w.secondary_states[0].liquid_mass = f64::NAN;
    assert!(a::screen(&n, &w, &y, expected, &flow).is_err());
}

#[test]
fn pressure_split_and_omitted_kinetic_energy_premises_remain_hard_screens() {
    let n = fixture();
    let y0 = n.initial_state().unwrap();
    let expected = a::totals(&n, &y0);
    let base = evaluated(&n, &y0);
    let flow = a::weights(&n, &base, &y0, 300., 1.).unwrap().flow;
    let mut departure = y0.clone();
    departure[n.mechanical_row(1).unwrap()] = 1e6;
    let w = evaluated(&n, &departure);
    assert!(a::screen(&n, &w, &departure, expected, &flow).is_err());
    let mut fast = y0.clone();
    fast[n.flow_row(0)] = 100.;
    let w = evaluated(&n, &fast);
    assert!(a::screen(&n, &w, &fast, expected, &flow).is_err());
    // Fixed-head hydraulic ratio is diagnostic only, not an invented gate.
    let mut unresolved = y0.clone();
    unresolved[n.mechanical_row(1).unwrap()] = 100.;
    let w = evaluated(&n, &unresolved);
    let d = a::screen(&n, &w, &unresolved, expected, &flow).unwrap();
    assert!(d.held_head_ratio > 1.);
}

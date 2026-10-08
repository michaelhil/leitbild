use super::*;
use crate::GRAVITY;

fn config() -> motion::Config {
    motion::Config {
        body_mass_kg: 35.,
        stem_mass_kg: 5.5,
        force_limit_n: 2000.,
        grip_closed_force_n: 2000.,
        gap_stroke_m: 0.01,
        maximum_rate_m_s: 0.008,
        efficiency: 0.8,
        joint_capacity_n: 2000.,
    }
}
fn supply(energy: f64, load: f64) -> dc_supply::Supply {
    dc_supply::Supply::new(
        dc_supply::Config {
            capacity_j: 1e6,
            normal_group_w: 2000.,
            charger_limit_w: 1e4,
            output_limit_w: 2e4,
            charge_efficiency: 0.95,
            discharge_efficiency: 0.95,
            converter_efficiency: 0.92,
        },
        energy,
        dc_supply::Paths {
            charger_available: false,
            battery_available: true,
            output_healthy: true,
        },
        true,
        load,
    )
    .unwrap()
}
fn fixture(n: usize) -> (Fleet, State, Accuracy) {
    let fleet = Fleet::new(
        vec![config(); n],
        supply(1e6, 2000.),
        supply(1e6, 2000.),
        Duty {
            base_a_w: 2000.,
            base_b_w: 2000.,
            holding_w: 20.,
            motive_w: 1000.,
        },
    )
    .unwrap();
    let s = State {
        time_s: 0.,
        motion: vec![
            motion::State {
                body_y_m: 0.,
                body_v_m_s: 0.,
                stem_y_m: 0.,
                stem_v_m_s: 0.,
                reference_y_m: 0.
            };
            n
        ],
        heat: vec![Heat::default(); n],
        external: vec![1e4],
        other_load_export_j: [0.; 2],
    };
    let a = Accuracy {
        position_m: 1e-10,
        velocity_m_s: 1e-9,
        heat_j: 1e-7,
        external_absolute: vec![1e-7],
        relative: 1e-8,
        maximum_step_s: 0.05,
    };
    (fleet, s, a)
}
fn water(_: f64, m: &[motion::State], _: &[f64], p: &mut PortRates) -> Result<(), String> {
    // Test-only finite water energy with dissipative linear drag. Production
    // qualification uses the actual per-guide/plena constitutive network.
    p.external[0] = 0.;
    for (s, f) in m.iter().zip(&mut p.forces) {
        f.body_n = -config().body_mass_kg * GRAVITY - 2. * s.body_v_m_s;
        f.stem_n = -config().stem_mass_kg * GRAVITY - s.stem_v_m_s;
        p.external[0] += 2. * s.body_v_m_s * s.body_v_m_s + s.stem_v_m_s * s.stem_v_m_s;
    }
    Ok(())
}
fn energy(s: &State) -> f64 {
    s.motion
        .iter()
        .map(|m| config().mechanical_energy_j(*m, GRAVITY).unwrap())
        .sum::<f64>()
        + s.heat
            .iter()
            .map(|h| h.jack_j + h.stem_j + h.spider_j)
            .sum::<f64>()
        + s.external.iter().sum::<f64>()
        + s.other_load_export_j.iter().sum::<f64>()
}
#[test]
fn all_52_achieve_withdrawal_then_real_hold_separation_impact_and_energy() {
    let (mut f, mut s, a) = fixture(52);
    assert_eq!(f.command(&s, 0.008, &mut water).unwrap(), Outcome::Reached);
    let initial = energy(&s);
    assert_eq!(
        f.advance(&mut s, 0.5, &a, &mut water).unwrap(),
        Outcome::Reached
    );
    assert!(
        s.motion
            .iter()
            .all(|m| m.body_y_m > 0.0039 && m.body_y_m < 0.004)
    );
    assert!(s.motion.iter().all(|m| m.body_v_m_s == 0.008));
    assert_eq!(f.command(&s, 0., &mut water).unwrap(), Outcome::Reached);
    assert_eq!(
        f.advance(&mut s, 2., &a, &mut water).unwrap(),
        Outcome::Reached
    );
    assert!(
        s.motion
            .iter()
            .all(|m| m.body_y_m == m.stem_y_m && m.body_v_m_s == 0. && m.stem_v_m_s == 0.)
    );
    assert_eq!(f.account.contact_events, 52);
    assert!(f.account.separation_events >= 52);
    assert!(f.account.contact_heat_j > 0.);
    assert!(
        s.heat
            .iter()
            .all(|h| h.stem_j > 0. && h.spider_j > 0. && h.jack_j > 0.)
    );
    let supplied = f
        .supply_states(s.time_s)
        .unwrap()
        .iter()
        .map(|v| v.delivered_j)
        .sum::<f64>();
    let defect = energy(&s) - initial - supplied;
    assert!(
        defect.abs() < 1e-7,
        "energy defect {defect} root {:?}",
        f.account
    );
    assert!(f.account.event_mechanical_adjustment_j.abs() < 1e-8);
    assert!(
        f.account.accepted_steps < 1000,
        "unexpected mechanical work {:?}",
        f.account
    );
}
#[test]
fn copied_partial_motion_retains_dc_thermal_and_contact_history() {
    let (mut f, mut s, a) = fixture(3);
    f.command(&s, 0.008, &mut water).unwrap();
    f.advance(&mut s, 0.25, &a, &mut water).unwrap();
    let (mut g, mut t) = (f.clone(), s.clone());
    for (fleet, state) in [(&mut f, &mut s), (&mut g, &mut t)] {
        fleet.advance(state, 0.5, &a, &mut water).unwrap();
        fleet.command(state, 0., &mut water).unwrap();
        fleet.advance(state, 2., &a, &mut water).unwrap();
    }
    for (i, j) in s.motion.iter().zip(&t.motion) {
        assert_eq!(i, j);
    }
    assert_eq!(s.external, t.external);
    assert_eq!(energy(&s), energy(&t));
    assert_eq!(f.supply_states(2.).unwrap(), g.supply_states(2.).unwrap());
    assert_eq!(f.account.contact_heat_j, g.account.contact_heat_j);
}
#[test]
fn finite_supply_stops_at_exact_boundary_and_drops_motive_not_state() {
    let (mut f, mut s, a) = fixture(1);
    // Exhaust ACT.A at the externally selected command boundary 0.5s.
    f.act_a = supply(2000. * 0.5 / 0.95, 2000.);
    f.command(&s, 0.008, &mut water).unwrap();
    assert_eq!(
        f.advance(&mut s, 1., &a, &mut water).unwrap(),
        Outcome::SupportLost
    );
    assert!(dc_supply::coincident(s.time_s, 0.5));
    assert!(s.motion[0].body_y_m > 0.);
    assert_eq!(f.act_b.requested_w(), 2000.);
    assert_eq!(f.requested_rate_m_s(), 0.);
    assert!(f.advance(&mut s, 1., &a, &mut water).is_err());
}
#[test]
fn refinement_subdivision_and_perturbed_cluster_preserve_independence() {
    let (mut f, mut s, a) = fixture(3);
    // A real separate retained cluster state; no bank mean realigns it.
    s.motion[1].body_y_m = 0.001;
    s.motion[1].stem_y_m = 0.001;
    let (mut g, mut t) = (f.clone(), s.clone());
    let mut tighter = a.clone();
    tighter.position_m *= 0.25;
    tighter.velocity_m_s *= 0.25;
    tighter.heat_j *= 0.25;
    tighter.relative *= 0.25;
    tighter.external_absolute[0] *= 0.25;
    tighter.maximum_step_s *= 0.5;
    for (fleet, state, scale) in [(&mut f, &mut s, &a), (&mut g, &mut t, &tighter)] {
        fleet.command(state, 0.008, &mut water).unwrap();
        fleet.advance(state, 0.5, scale, &mut water).unwrap();
        fleet.command(state, 0., &mut water).unwrap();
        fleet.advance(state, 2., scale, &mut water).unwrap();
    }
    assert!((s.motion[1].body_y_m - s.motion[0].body_y_m - 0.001).abs() < 1e-12);
    assert!(Fleet::distance(&s, &t, &a) < 1.);
}
#[test]
fn uninitialized_or_unfilled_port_cannot_silently_advance() {
    let (mut f, mut s, a) = fixture(1);
    assert!(f.advance(&mut s, 0.5, &a, &mut water).is_err());
    f.command(&s, 0.008, &mut water).unwrap();
    assert!(
        f.advance(&mut s, 0.5, &a, &mut |_, _, _, _| Ok(()))
            .is_err()
    );
    assert_eq!(s.time_s, 0.);
}

#[test]
fn coarse_initial_predictor_retries_without_clipping_physical_geometry() {
    let (mut f, mut s, mut a) = fixture(1);
    a.maximum_step_s = 0.1;
    let mut steep = |_: f64, m: &[motion::State], _: &[f64], p: &mut PortRates| {
        p.external[0] = 0.;
        for (s, q) in m.iter().zip(&mut p.forces) {
            // An actual port refuses an invalid unadmitted geometry too.
            // The complete-step retry must occur before this callback.
            if s.body_y_m < 0. || s.stem_y_m < 0. {
                return Err("Test water cannot evaluate behind its fitting".into());
            }
            // Equal damping rates isolate iteration stiffness from a
            // separate, physical uplift-joint overload refusal.
            let body_drag = 100. * config().body_mass_kg;
            let stem_drag = 100. * config().stem_mass_kg;
            q.body_n = -config().body_mass_kg * GRAVITY - body_drag * s.body_v_m_s;
            q.stem_n = -config().stem_mass_kg * GRAVITY - stem_drag * s.stem_v_m_s;
            p.external[0] += body_drag * s.body_v_m_s.powi(2) + stem_drag * s.stem_v_m_s.powi(2);
        }
        Ok(())
    };
    f.command(&s, 0.008, &mut steep).unwrap();
    let initial = energy(&s);
    f.advance(&mut s, 0.1, &a, &mut steep).unwrap();
    assert!(f.account.rejected_steps > 0);
    assert!(s.motion[0].body_y_m > 0.);
    let delivered = f
        .supply_states(s.time_s)
        .unwrap()
        .iter()
        .map(|q| q.delivered_j)
        .sum::<f64>();
    assert!((energy(&s) - initial - delivered).abs() < 1e-7);
}

#[test]
fn one_tick_output_remainder_advances_one_shared_clock_not_zero_steps() {
    let (mut f, mut s, mut a) = fixture(1);
    s.time_s = 0.5999999999999999;
    s.external = vec![0., 0.];
    a.external_absolute = vec![1e-7, 1e-11];
    let mut nonzero_port = |t, m: &[motion::State], e: &[f64], p: &mut PortRates| {
        water(t, m, e, p)?;
        // Explicit test boundary heat/carrier inputs. Both half-duration
        // contributions must remain even when their clocks cannot advance.
        p.external[0] = 4.;
        p.external[1] = 0.5;
        Ok(())
    };
    f.command(&s, 0., &mut nonzero_port).unwrap();
    let target = 0.6;
    let h = target - s.time_s;
    assert!(s.time_s < target);
    f.advance(&mut s, target, &a, &mut nonzero_port).unwrap();
    assert_eq!(s.time_s, target);
    assert_eq!(f.account.accepted_steps, 1);
    assert!(f.account.minimum_accepted_step_s > 0.);
    assert_eq!(f.account.last_accepted_step_s, target - 0.5999999999999999);
    assert_eq!(f.supply_states(target).unwrap()[0].time_s, target);
    assert_eq!(s.external, [4. * h, 0.5 * h]);
    assert_eq!(s.heat[0].jack_j, 20. * h);
    assert_eq!(s.other_load_export_j, [1980. * h, 2000. * h]);
}

#[test]
fn refused_or_malformed_command_keeps_the_entire_retained_fleet() {
    let (mut f, mut s, a) = fixture(1);
    f.command(&s, 0.008, &mut water).unwrap();
    f.advance(&mut s, 0.1, &a, &mut water).unwrap();
    let before = f.clone();
    assert!(
        f.command(&s, 0., &mut |_, _, _, _| Err(
            "Test admission refusal".into()
        ))
        .is_err()
    );
    for missing in [true, false] {
        let mut malformed = s.clone();
        if missing {
            malformed.motion.clear();
        } else {
            malformed.heat.clear();
        }
        let mut called = false;
        assert!(
            f.command(&malformed, 0., &mut |_, _, _, _| {
                called = true;
                Ok(())
            })
            .is_err()
        );
        assert!(!called);
    }
    assert_eq!(f.rate, before.rate);
    assert_eq!(f.initialized, before.initialized);
    assert_eq!(f.branches, before.branches);
    assert_eq!(f.account, before.account);
    assert_eq!(
        f.supply_states(s.time_s).unwrap(),
        before.supply_states(s.time_s).unwrap()
    );
}

#[test]
fn refused_event_admission_keeps_previous_physical_state_and_branch_history() {
    let (mut f, mut s, a) = fixture(1);
    f.command(&s, 0.008, &mut water).unwrap();
    let before = f.clone();
    let mut last = (s.time_s, s.motion.clone(), s.external.clone());
    let mut port = |t, m: &[motion::State], e: &[f64], p: &mut PortRates| {
        if p.admission {
            if m[0].stem_v_m_s == 0.008 {
                return Err("Test attained speed-event admission refusal".into());
            }
            last = (t, m.to_vec(), e.to_vec());
        }
        water(t, m, e, p)
    };
    let error = f.advance(&mut s, 0.5, &a, &mut port).unwrap_err();
    assert!(error.contains("Test attained speed-event admission refusal"));
    assert_eq!(
        (s.time_s, &s.motion, &s.external),
        (last.0, &last.1, &last.2)
    );
    assert_eq!(f.rate, before.rate);
    assert_eq!(f.branches, before.branches);
    assert_eq!(f.account.velocity_events, before.account.velocity_events);
    assert_eq!(f.account.contact_events, before.account.contact_events);
    assert_eq!(f.account.contact_heat_j, before.account.contact_heat_j);
    assert_eq!(f.account.event_mechanical_adjustment_j, 0.);
    assert_eq!(
        f.supply_states(s.time_s).unwrap(),
        before.supply_states(s.time_s).unwrap()
    );
    assert!(f.account.root_steps > 0); // Actual attempted work remains visible.
}

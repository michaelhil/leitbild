//! One actual-input fuel/history transaction, not an advancing source model.
#[path = "../src/fuel_history.rs"]
mod fuel_history;
#[path = "../src/fuel_source.rs"]
mod fuel_source;
#[path = "../src/heat_history.rs"]
mod heat_history;
use fuel_history::*;
use fuel_source::{Cohort, DELAYED, FuelLaw, FuelModel, GROUPS, Intersection, Weight};
use heat_history::{Feed, Group, Kernel};
use std::{env, fs, time::Instant};
fn number(w: &mut std::str::SplitWhitespace<'_>) -> f64 {
    w.next()
        .expect("Missing input")
        .parse()
        .expect("Invalid input")
}
fn count(w: &mut std::str::SplitWhitespace<'_>) -> usize {
    w.next()
        .expect("Missing count")
        .parse()
        .expect("Invalid count")
}
fn array<const N: usize>(w: &mut std::str::SplitWhitespace<'_>) -> [f64; N] {
    std::array::from_fn(|_| number(w))
}
fn near(a: f64, b: f64, scale: f64) {
    assert!(
        (a - b).abs() <= 2e-10 * scale.max(1e-30),
        "Accounting failed: {a} vs {b}, scale {scale}"
    )
}
fn main() {
    let text = fs::read_to_string(
        env::args()
            .nth(1)
            .expect("Explicit actual fixture required"),
    )
    .unwrap();
    let mut words = text.split_whitespace();
    let fuel_words = count(&mut words);
    let fuel_text = (0..fuel_words)
        .map(|_| words.next().expect("Missing fuel input"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut f = fuel_text.split_whitespace();
    let nr = count(&mut f);
    let ns = count(&mut f);
    let nq = count(&mut f);
    let ni = count(&mut f);
    let law = FuelLaw {
        absorption: array(&mut f),
        fission: array(&mut f),
        scatter: std::array::from_fn(|_| array(&mut f)),
        nu: array(&mut f),
        chi: array(&mut f),
        speed: array(&mut f),
        beta: array(&mut f),
        decay: array(&mut f),
        f_d: number(&mut f),
    };
    let rv = (0..nr).map(|_| number(&mut f)).collect::<Vec<_>>();
    let sv = (0..ns).map(|_| number(&mut f)).collect::<Vec<_>>();
    let cohorts = (0..nq)
        .map(|_| Cohort {
            segment: count(&mut f),
            mass: number(&mut f),
            mu: number(&mut f),
        })
        .collect();
    let incidence = (0..ni)
        .map(|_| {
            let region = count(&mut f);
            let segment = count(&mut f);
            let volume = number(&mut f);
            let n = count(&mut f);
            Intersection {
                region,
                segment,
                volume,
                weights: (0..n)
                    .map(|_| Weight {
                        cohort: count(&mut f),
                        mass: number(&mut f),
                    })
                    .collect(),
            }
        })
        .collect();
    let original = (0..ns).map(|_| array::<4>(&mut f)).collect::<Vec<_>>();
    let temperatures = (0..nq).map(|_| number(&mut f)).collect::<Vec<_>>();
    let prompt = number(&mut f);
    assert!(f.next().is_none());
    assert_eq!(count(&mut words), ns);
    let segments = (0..ns)
        .map(|s| {
            let p = SegmentPreparation {
                reference_u235: number(&mut words),
                reference_u238: number(&mut words),
                sf235_neutrons_per_second: number(&mut words),
                sf238_neutrons_per_second: number(&mut words),
            };
            assert_eq!(p.reference_u235, original[s][0]);
            assert_eq!(p.reference_u235, original[s][1]);
            assert_eq!(p.reference_u238, original[s][2]);
            assert_eq!(p.reference_u238, original[s][3]);
            p
        })
        .collect::<Vec<_>>();
    let poison = PoisonLaw {
        yield_i: number(&mut words),
        yield_xe: number(&mut words),
        yield_pm: number(&mut words),
        lambda_i: number(&mut words),
        lambda_xe: number(&mut words),
        lambda_pm: number(&mut words),
        xe_sigma_m2: number(&mut words),
        sm_sigma_m2: number(&mut words),
    };
    let ng = count(&mut words);
    let fission_energy = number(&mut words);
    let groups = (0..ng)
        .map(|_| Group {
            feed: match count(&mut words) {
                0 => Feed::Fission,
                1 => Feed::FertileCapture,
                _ => panic!("Unknown feed"),
            },
            energy_per_event: number(&mut words),
            decay_rate: number(&mut words),
        })
        .collect::<Vec<_>>();
    let multiplicity = number(&mut words);
    let cf = CfLaw {
        initial_energy_j: number(&mut words),
        initial_neutrons_per_second: number(&mut words),
        decay_rate: number(&mut words),
        birth_export_j_per_neutron: number(&mut words),
    };
    let support_count = count(&mut words);
    let support = (0..support_count)
        .map(|_| (count(&mut words), number(&mut words)))
        .collect();
    assert!(words.next().is_none(), "Trailing unowned input");
    assert_eq!(ng, 25);
    near(
        prompt
            + groups
                .iter()
                .filter(|g| matches!(g.feed, Feed::Fission))
                .map(|g| g.energy_per_event)
                .sum::<f64>(),
        fission_energy,
        fission_energy,
    );
    let construction = Instant::now();
    let a = Assembly::new(
        FuelModel::new(law.clone(), rv.clone(), sv.clone(), cohorts, incidence).unwrap(),
        segments.clone(),
        poison,
        Kernel::new(groups.clone(), fission_energy).unwrap(),
        multiplicity,
        cf,
        support,
    )
    .unwrap();
    let mut work = a.workspace();
    let construction_ms = construction.elapsed().as_secs_f64() * 1000.;
    let cold = a.initial_state();
    a.validate_accepted_state(&cold).unwrap();
    a.evaluate_into(&temperatures, &cold, &mut work).unwrap();
    let cold_rates = work.rates().unwrap();
    let intrinsic = segments
        .iter()
        .map(|p| p.sf235_neutrons_per_second + p.sf238_neutrons_per_second)
        .sum::<f64>();
    near(
        cold_rates[..nr * GROUPS].iter().sum(),
        cf.initial_neutrons_per_second + intrinsic,
        cf.initial_neutrons_per_second + intrinsic,
    );
    assert!(
        cold_rates[nr * GROUPS..a.fuel_dimension()]
            .iter()
            .all(|&v| v == 0.),
        "External SF/Cf must not feed physical precursors"
    );
    let mut cold_fission_release = 0.;
    for s in 0..ns {
        let r = work.segments().unwrap()[s];
        let row = a.history_row(s, 0);
        let sf = r.sf235 + r.sf238;
        assert!(r.sf235 > 0. && r.sf238 > 0.);
        assert_eq!(r.induced_fission, 0.);
        assert_eq!(r.fertile_capture, 0.);
        assert_eq!(cold_rates[row + CONSUMED_235], r.sf235);
        assert_eq!(cold_rates[row + SF_238], r.sf238);
        assert_eq!(cold_rates[row + CAPTURED_238], 0.);
        assert_eq!(cold_rates[row + ENERGY + 23], 0.);
        assert_eq!(cold_rates[row + ENERGY + 24], 0.);
        near(
            r.prompt_release
                + r.delayed_release
                + cold_rates[row + ENERGY..row + HISTORY].iter().sum::<f64>(),
            fission_energy * sf,
            fission_energy * sf,
        );
        cold_fission_release += r.prompt_release + r.delayed_release;
    }
    let mut y = cold.clone();
    // Disclosed nonuniform positive algebra snapshot: not a reached plant state.
    for (i, n) in y[..a.fuel_dimension()].iter_mut().enumerate() {
        *n = 1. + (i % 17) as f64 / 9.;
    }
    for (s, p) in segments.iter().enumerate() {
        let row = a.history_row(s, 0);
        y[row + CONSUMED_235] = 0.01 * p.reference_u235;
        y[row + CAPTURED_238] = 0.02 * p.reference_u238;
        y[row + SF_238] = 0.005 * p.reference_u238;
        for k in IODINE..=SAMARIUM_PRODUCT {
            y[row + k] = 1e18 * (1. + (k + s % 7) as f64 / 10.);
        }
        for k in ENERGY..HISTORY {
            y[row + k] = 1. + (k + s % 11) as f64;
        }
    }
    y[a.cf_row()] *= 0.8;
    let hot = temperatures
        .iter()
        .enumerate()
        .map(|(i, _)| 400. + (i % 11) as f64 * 50.)
        .collect::<Vec<_>>();
    a.validate_accepted_state(&y).unwrap();
    a.evaluate_into(&hot, &y, &mut work).unwrap();
    let rates = work.rates().unwrap();
    let segment_rates = work.segments().unwrap();
    let cfr = work.cf().unwrap();
    near(
        -rates[a.cf_row()],
        cfr.capsule_release + cfr.birth_export,
        cfr.paid_release,
    );
    let mut neutron_budget = cfr.births;
    let mut expected_c_rate = 0.;
    let mut energy_defect = 0_f64;
    let mut energy_scale = 0_f64;
    let mut poison_captures = 0.;
    let mut fuel_fissions = 0.;
    for (s, r) in segment_rates.iter().enumerate() {
        let row = a.history_row(s, 0);
        let f = r.induced_fission + r.sf235 + r.sf238;
        near(
            rates[row + CONSUMED_235],
            r.induced_fission + r.sf235,
            (r.induced_fission + r.sf235).abs(),
        );
        near(
            rates[row + CAPTURED_238] + rates[row + SF_238],
            r.fertile_capture + r.sf238,
            (r.fertile_capture + r.sf238).abs(),
        );
        near(
            rates[row + XENON] + rates[row + XENON_PRODUCT],
            poison.yield_xe * f + poison.lambda_i * y[row + IODINE]
                - poison.lambda_xe * y[row + XENON],
            (poison.yield_xe * f).abs()
                + (poison.lambda_i * y[row + IODINE]).abs()
                + (poison.lambda_xe * y[row + XENON]).abs(),
        );
        near(
            rates[row + SAMARIUM] + rates[row + SAMARIUM_PRODUCT],
            poison.lambda_pm * y[row + PROMETHIUM],
            (poison.lambda_pm * y[row + PROMETHIUM]).abs() + r.sm_capture.abs(),
        );
        let paid = fission_energy * f
            + groups
                .iter()
                .filter(|g| matches!(g.feed, Feed::FertileCapture))
                .map(|g| g.energy_per_event)
                .sum::<f64>()
                * r.fertile_capture;
        let accounted = r.prompt_release
            + r.delayed_release
            + rates[row + ENERGY..row + HISTORY].iter().sum::<f64>();
        near(accounted, paid, paid.abs() + r.delayed_release.abs());
        energy_defect = energy_defect.max((accounted - paid).abs());
        energy_scale = energy_scale.max(paid.abs());
        neutron_budget += multiplicity * (r.sf235 + r.sf238)
            - r.induced_fission
            - r.fertile_capture
            - r.xe_capture
            - r.sm_capture;
        poison_captures += r.xe_capture + r.sm_capture;
        fuel_fissions += r.induced_fission;
    }
    // Independently reconstruct groupwise prompt+delayed event production.
    let beta = law.beta.iter().sum::<f64>();
    for e in a.fuel().intersections() {
        let s = e.segment;
        let row = a.history_row(s, 0);
        let remaining = 1. - y[row + CONSUMED_235] / segments[s].reference_u235;
        for g in 0..GROUPS {
            let event = law.speed[g] * law.fission[g] * remaining * e.volume / rv[e.region]
                * y[e.region * GROUPS + g];
            neutron_budget += law.nu[g] * event;
            expected_c_rate += beta * law.nu[g] * event;
        }
    }
    for s in 0..ns {
        for j in 0..DELAYED {
            expected_c_rate -= law.decay[j] * y[nr * GROUPS + s * DELAYED + j];
        }
    }
    let actual_count_rate = rates[..a.fuel_dimension()].iter().sum::<f64>();
    near(
        actual_count_rate,
        neutron_budget,
        neutron_budget.abs()
            + rates[..a.fuel_dimension()]
                .iter()
                .map(|v| v.abs())
                .sum::<f64>(),
    );
    near(
        rates[nr * GROUPS..a.fuel_dimension()].iter().sum(),
        expected_c_rate,
        expected_c_rate.abs(),
    );
    assert!(poison_captures > 0. && fuel_fissions > 0.);
    let baseline_collision = work.collision().unwrap().to_vec();
    let direction = y
        .iter()
        .enumerate()
        .map(|(i, v)| v * (0.03 + (i % 5) as f64 * 0.01))
        .collect::<Vec<_>>();
    let dt = hot.iter().map(|v| v * 0.02).collect::<Vec<_>>();
    a.jvp_into(&dt, &direction, &mut work).unwrap();
    let analytic = work.rate_jvp().unwrap().to_vec();
    let analytic_collision = work.collision_jvp().unwrap().to_vec();
    let mut other = a.workspace();
    let mut max_error = 0_f64;
    let mut max_collision_error = 0_f64;
    for step in [1e-4, 5e-5] {
        let plus = y
            .iter()
            .zip(&direction)
            .map(|(v, d)| v + step * d)
            .collect::<Vec<_>>();
        let minus = y
            .iter()
            .zip(&direction)
            .map(|(v, d)| v - step * d)
            .collect::<Vec<_>>();
        let tp = hot
            .iter()
            .zip(&dt)
            .map(|(v, d)| v + step * d)
            .collect::<Vec<_>>();
        let tm = hot
            .iter()
            .zip(&dt)
            .map(|(v, d)| v - step * d)
            .collect::<Vec<_>>();
        a.evaluate_into(&tp, &plus, &mut other).unwrap();
        let rp = other.rates().unwrap().to_vec();
        let cp = other.collision().unwrap().to_vec();
        a.evaluate_into(&tm, &minus, &mut other).unwrap();
        let rm = other.rates().unwrap();
        let cm = other.collision().unwrap();
        for i in 0..analytic.len() {
            let fd = (rp[i] - rm[i]) / (2. * step);
            let scale = fd.abs().max(analytic[i].abs()).max(1e-28);
            let err = (fd - analytic[i]).abs() / scale;
            max_error = max_error.max(err);
            assert!(
                err < 2e-6,
                "Full RHS JVP row {i}: {fd} vs {}, error {err}",
                analytic[i]
            );
        }
        for r in 0..nr {
            for g in 0..GROUPS {
                let fd = (cp[r][g] - cm[r][g]) / (2. * step);
                let aj = analytic_collision[r][g];
                let err = (fd - aj).abs() / fd.abs().max(aj.abs()).max(1e-28);
                max_collision_error = max_collision_error.max(err);
                assert!(
                    err < 2e-6,
                    "Collision JVP {r}/{g}: {fd} vs {aj}, error {err}"
                );
            }
        }
    }
    // Poison changes must reach collision in the same transaction, not a stale
    // readout assembled after the transport consumer has taken its coefficients.
    let mut no_poison = y.clone();
    for s in 0..ns {
        no_poison[a.history_row(s, XENON)] = 0.;
        no_poison[a.history_row(s, SAMARIUM)] = 0.;
    }
    a.evaluate_into(&hot, &no_poison, &mut other).unwrap();
    let mut increased = 0;
    for (before, after) in baseline_collision.iter().zip(other.collision().unwrap()) {
        assert!(before[6] >= after[6]);
        if before[6] > after[6] {
            increased += 1;
        }
    }
    assert!(increased > 0);
    // Newton trials may cross zero progress; accepted histories still may not.
    let mut signed = cold.clone();
    signed[a.history_row(0, CONSUMED_235)] = -1.;
    signed[0] = -1.;
    signed[a.history_row(0, ENERGY)] = -1.;
    a.evaluate_into(&temperatures, &signed, &mut other).unwrap();
    assert!(a.validate_accepted_state(&signed).is_err());
    let mut exhausted = y.clone();
    exhausted[a.history_row(0, CONSUMED_235)] = segments[0].reference_u235 * 1.1;
    assert!(a.validate_accepted_state(&exhausted).is_err());
    assert!(a.evaluate_into(&hot, &exhausted, &mut other).is_err());
    assert!(
        other.rates().is_err(),
        "Failed candidate cannot retain readable stale rates"
    );
    // Bounded repeated operations measure one actual RHS/JVP, not seconds advanced.
    let repeats = 10;
    let timer = Instant::now();
    for _ in 0..repeats {
        a.evaluate_into(&hot, &y, &mut work).unwrap();
    }
    let rhs_ms = timer.elapsed().as_secs_f64() * 1000. / repeats as f64;
    let timer = Instant::now();
    for _ in 0..repeats {
        a.jvp_into(&dt, &direction, &mut work).unwrap();
    }
    let jvp_ms = timer.elapsed().as_secs_f64() * 1000. / repeats as f64;
    println!(
        "{{\"passed\":true,\"advancedSeconds\":0,\"regions\":{nr},\"segments\":{ns},\"coordinates\":{},\"historyCoordinates\":{},\"intrinsicNeutronsPerSecond\":{intrinsic},\"coldIntrinsicPromptRelease_W\":{cold_fission_release},\"construction_ms\":{construction_ms},\"rhs_ms\":{rhs_ms},\"jvp_ms\":{jvp_ms},\"knownWorkspaceBytes\":{},\"maxRhsDirectionalRelativeError\":{max_error},\"maxCollisionDirectionalRelativeError\":{max_collision_error},\"maxEnergyLedgerDefect_W\":{energy_defect},\"maxEnergyLedgerScale_W\":{energy_scale},\"sourceIntegrated\":false}}",
        a.state_count(),
        ns * HISTORY + 1,
        work.buffer_bytes()
    );
}

//! Independent hypothesis regression, not a production donor map or inverse.
//! The +/-30 m/s high-pressure envelope is a test purpose, never a runtime cap.
//! The broad envelope FAILED its unchanged screens in the retained first
//! comparison receipt. Passing this regression preserves that rejection; it
//! does not admit a liquid-domain approximation or the stopped time trajectory.
use leitbild_plant_numerics::{Liquid, LiquidQuery, liquid_batch};

fn water(pressure: f64, temperature: f64) -> Result<Liquid, String> {
    let mut result = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            pressure,
            temperature,
        }],
        &mut result,
    )
    .map_err(|error| error.message)?;
    Ok(result[0])
}

fn enthalpy(water: Liquid, pressure: f64) -> f64 {
    water.internal_energy + pressure / water.density
}

/// TEST ONLY. Solve the independent reversible static-face equations using
/// forward p/T queries and analytic first thermodynamic partials. No accepted
/// state is reset, and failed/flash/negative-pressure queries are not clipped.
fn isentropic_face(
    pressure: f64,
    temperature: f64,
    speed: f64,
) -> Result<(f64, f64, Liquid), String> {
    if !speed.is_finite() {
        return Err("Nonfinite qualification speed".into());
    }
    let donor = water(pressure, temperature)?;
    let kinetic = speed * speed / 2.0;
    let target_h = enthalpy(donor, pressure) - kinetic;
    let mut p = pressure - donor.density * kinetic;
    let mut t = temperature - temperature * donor.expansion * kinetic / donor.cp;
    if !p.is_finite() || p <= 0.0 || !t.is_finite() || t <= 0.0 {
        return Err(
            "Reduced entrance leaves the finite positive pressure/temperature domain".into(),
        );
    }
    for _ in 0..20 {
        let face = water(p, t)?;
        let fh = enthalpy(face, p) - target_h;
        let fs = face.entropy - donor.entropy;
        // Fixed prospective numerical comparison criteria, distinct from the
        // physical approximation screens below. Do not relax on a failed run.
        if fh.abs() <= 1e-5 && fs.abs() <= 1e-8 {
            return Ok((p, t, face));
        }
        let hp = (1.0 - t * face.expansion) / face.density;
        let ht = face.cp;
        let sp = -face.expansion / face.density;
        let st = face.cp / t;
        let determinant = hp * st - ht * sp;
        if !determinant.is_finite() || determinant <= 0.0 {
            return Err("Nonpositive reversible-face thermodynamic determinant".into());
        }
        p += (-fh * st + ht * fs) / determinant;
        t += (sp * fh - hp * fs) / determinant;
        if !p.is_finite() || p <= 0.0 || !t.is_finite() || t <= 0.0 {
            return Err("Independent reversible-face Newton left the finite domain".into());
        }
    }
    Err(
        "Independent reversible-face forward Newton did not satisfy its fixed residual criteria"
            .into(),
    )
}

#[test]
fn retain_exact_nozzle_comparison_and_known_dense_counterexamples() {
    // Existing property comparison states, not original/reached plant
    // preparations or a proved interpolated domain. EVERY original row stays.
    // Dense 640 K at 24/30 m/s are actual failed-hypothesis counterexamples,
    // not silently exempted cases or production admission predicates.
    let mut failures = Vec::new();
    let mut counterexamples = 0;
    for (p, t, speeds) in [
        (15.2e6, 313.15, &[0.0, 11.5, 16.0, 24.0, 30.0][..]),
        (15.2e6, 450.0, &[0.0, 11.5, 16.0, 24.0, 30.0][..]),
        (15.2e6, 600.0, &[0.0, 11.5, 16.0, 24.0, 30.0][..]),
        (20.5e6, 640.0, &[0.0, 11.5, 16.0, 24.0, 30.0][..]),
        // The fresh low-pressure original cannot support arbitrary high speed.
        (0.3e6, 300.0, &[0.0, 10.0, 20.0][..]),
    ] {
        let donor = water(p, t).unwrap();
        for &speed in speeds {
            let (pf, tf, face) = match isentropic_face(p, t, speed) {
                Ok(face) => face,
                Err(error) => {
                    failures.push(format!("p={p},T={t},speed={speed}: {error}"));
                    continue;
                }
            };
            let kinetic = speed * speed / 2.0;
            let split_p = p - donor.density * kinetic;
            let pressure_error = (split_p - pf).abs();
            let exact_drop = p - pf;
            let drop_relative = if speed == 0.0 {
                0.0
            } else {
                pressure_error / exact_drop
            };
            let flow_relative = (donor.density / face.density - 1.0).abs();
            let split_h = donor.internal_energy + split_p / donor.density;
            let split_total_h = split_h + kinetic;
            let exact_total_h = enthalpy(face, pf) + kinetic;
            let total_h_error = (split_total_h - exact_total_h).abs();
            let physical_screens_pass =
                flow_relative <= 0.001 && drop_relative <= 0.001 && pressure_error <= 250.0;
            let expected_counterexample =
                p == 20.5e6 && t == 640.0 && (speed == 24.0 || speed == 30.0);
            // Report actual static cooling, not a temperature "error": the
            // reduced donor temperature does not purport to be static-face T.
            println!(
                "p={p},T={t},speed={speed},exact_p={pf:.12e},split_p={split_p:.12e},pressure_error_Pa={pressure_error:.12e},drop_relative={drop_relative:.12e},massflow_relative={flow_relative:.12e},static_delta_T_K={:.12e},total_H_error_J_per_kg={total_h_error:.12e},sound_speed_m_per_s={:.12e},physical_screens_pass={physical_screens_pass},known_counterexample={expected_counterexample}",
                tf - t,
                donor.sound_speed
            );
            for direction in [-1.0, 1.0] {
                let velocity = direction * speed;
                let exact_q = face.density * velocity;
                let split_q = donor.density * velocity;
                assert_eq!(exact_q.signum(), split_q.signum());
            }
            if speed == 0.0 {
                assert_eq!(pf, p);
                assert_eq!(tf, t);
            }
            // UNCHANGED physical screens: 0.1% flow and kinetic pressure drop;
            // 250 Pa is an additional absolute high-pressure envelope screen,
            // not a bound on every pressure-sensitive receiver or near reversal.
            // Numerical convergence/enthalpy checks must pass even for a
            // rejected physical hypothesis; a solver failure is not evidence
            // of its known density-approximation failure.
            if total_h_error > 2e-5 || !exact_drop.is_finite() || exact_drop < 0.0 {
                failures.push(format!("p={p},T={t},speed={speed}: massflow_relative={flow_relative},drop_relative={drop_relative},pressure_error={pressure_error},total_H_error={total_h_error}"));
            }
            if expected_counterexample {
                counterexamples += 1;
                if physical_screens_pass || flow_relative <= 0.001 {
                    failures.push(format!("Known dense-liquid counterexample disappeared at speed={speed}: massflow_relative={flow_relative},drop_relative={drop_relative},pressure_error={pressure_error}"));
                }
            } else if !physical_screens_pass {
                failures.push(format!("Previously passing comparison row failed at p={p},T={t},speed={speed}: massflow_relative={flow_relative},drop_relative={drop_relative},pressure_error={pressure_error}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "Independent comparison regression changed; the broad envelope remains NOT admitted:\n{}",
        failures.join("\n")
    );
    assert_eq!(counterexamples, 2);
    println!(
        "broad_nozzle_envelope_admitted=false,known_dense_counterexamples={counterexamples},scope=exact_fixture_regression_only"
    );
}

#[test]
fn low_pressure_entrance_refuses_negative_pressure_without_clipping() {
    let failure = isentropic_face(0.3e6, 300.0, 30.0).unwrap_err();
    assert!(failure.contains("positive pressure/temperature"));
    assert!(isentropic_face(0.3e6, 300.0, f64::NAN).is_err());
}

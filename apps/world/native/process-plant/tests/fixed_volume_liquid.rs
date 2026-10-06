use leitbild_plant_numerics::fixed_volume_liquid::*;
use leitbild_plant_numerics::{
    CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch, storage_jacobian,
};

fn specimen(temperature: f64, pressure: f64) -> Input {
    let mut liquid = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            temperature,
            pressure,
        }],
        &mut liquid,
    )
    .unwrap();
    let geometry = CellGeometry {
        volume: 4.0,
        elevation: 11.8,
    };
    let mass = geometry.volume * liquid[0].density;
    Input {
        geometry,
        trial: Trial {
            mass,
            energy: mass * (liquid[0].internal_energy + GRAVITY * geometry.elevation),
            pressure,
            temperature,
        },
        derivative: Derivative::default(),
        balance: BalanceRate::default(),
    }
}

fn evaluate(input: Input, cj: f64) -> Evaluation {
    let mut output = [Evaluation::default()];
    evaluate_batch(&[input], cj, &mut output).unwrap();
    output[0]
}

fn perturb(mut input: Input, column: usize, increment: f64, cj: f64) -> Input {
    match column {
        0 => {
            input.trial.mass += increment;
            input.derivative.mass_rate += cj * increment;
        }
        1 => {
            input.trial.energy += increment;
            input.derivative.energy_rate += cj * increment;
        }
        2 => {
            input.trial.pressure += increment;
            input.derivative.pressure_rate += cj * increment;
        }
        3 => {
            input.trial.temperature += increment;
            input.derivative.temperature_rate += cj * increment;
        }
        _ => unreachable!(),
    }
    input
}

#[test]
fn full_local_ida_matrix_matches_off_manifold_residual() {
    let cj = 137.0;
    for (t, p) in [
        (290.0, 101325.0),
        (313.15, 15.2e6),
        (450.0, 15.2e6),
        (600.0, 15.2e6),
        (640.0, 20.5e6),
    ] {
        let mut input = specimen(t, p);
        input.trial.mass *= 1.01;
        input.trial.energy += 12000.0;
        // Prescribed receipts are held fixed, not state-dependent graph laws.
        input.balance = BalanceRate {
            mass_kg_per_second: 0.0,
            energy_watts: 23000.0,
        };
        input.derivative = Derivative {
            mass_rate: 0.0,
            energy_rate: 17000.0,
            pressure_rate: 42.0,
            temperature_rate: 0.3,
        };
        let result = evaluate(input, cj);
        assert_eq!(result.residual[1], -6000.0);
        assert_eq!(result.jacobian[3][0], 0.0);
        assert!((result.residual[3] - 12000.0).abs() < 1e-6);
        let determinant = result.jacobian[2][2] * result.jacobian[3][3]
            - result.jacobian[2][3] * result.jacobian[3][2];
        assert!(determinant > 0.0);
        for factor in [1.0, 0.5] {
            for (column, step) in [input.trial.mass * 1e-6, 100.0, p * 1e-5, 2e-4]
                .into_iter()
                .enumerate()
            {
                let step = step * factor;
                let plus = evaluate(perturb(input, column, step, cj), cj);
                let minus = evaluate(perturb(input, column, -step, cj), cj);
                for row in 0..4 {
                    let observed = (plus.residual[row] - minus.residual[row]) * 0.5;
                    let expected = result.jacobian[row][column] * step;
                    let roundoff = if row == 3 { 2e-5 } else { 2e-8 };
                    assert!(
                        (observed - expected).abs() <= roundoff + expected.abs() * 1e-3,
                        "t={t} p={p} row={row} column={column}: observed={observed} expected={expected}"
                    );
                }
            }
        }
    }
}

#[test]
fn prescribed_changing_heat_and_differentiated_constraint_are_consistent() {
    let mut input = specimen(450.0, 15.2e6);
    let mut liquid = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            temperature: input.trial.temperature,
            pressure: input.trial.pressure,
        }],
        &mut liquid,
    )
    .unwrap();
    let chart = storage_jacobian(input.geometry, liquid[0], 0.0, 0.0).unwrap();
    // Explicit external library-test heating. Not a joined plant source law.
    for heat in [0.0, 35000.0, -17000.0, 21000.0] {
        input.balance.energy_watts = heat;
        input.derivative.energy_rate = heat;
        let [pdot, tdot] = chart.pressure_temperature_increment(0.0, heat).unwrap();
        input.derivative.pressure_rate = pdot;
        input.derivative.temperature_rate = tdot;
        let result = evaluate(input, 97.0);
        assert_eq!(result.residual, [0.0; 4]);
        assert!((chart.mass_pressure * pdot + chart.mass_temperature * tdot).abs() < 1e-9);
        assert!(
            (chart.energy_pressure * pdot + chart.energy_temperature * tdot - heat).abs() < 1e-6
        );
        let mut changed_receipt = input;
        changed_receipt.balance.energy_watts += 13.0;
        let changed = evaluate(changed_receipt, 97.0);
        assert_eq!(changed.residual[1], -13.0);
        assert_eq!(changed.jacobian, result.jacobian);
    }
}

#[test]
fn forward_trial_responds_below_old_inverse_margins_and_owns_fixed_pe() {
    let input = specimen(313.15, 15.2e6);
    let base = evaluate(input, 1.0);
    // Both perturbations are below the earlier inverse's 0.5 Pa / 1e-4 K margins.
    for (column, step) in [(2, 0.125), (3, 2.5e-5)] {
        let changed = evaluate(perturb(input, column, step, 0.0), 1.0);
        assert_ne!(changed.chart_mass, base.chart_mass);
        assert_ne!(changed.chart_energy, base.chart_energy);
        for row in [2, 3] {
            let observed = changed.residual[row] - base.residual[row];
            let expected = base.jacobian[row][column] * step;
            let roundoff = if row == 3 { 2e-6 } else { 2e-10 };
            assert!((observed - expected).abs() < roundoff + expected.abs() * 1e-3);
        }
    }
    let mut raised = input;
    raised.geometry.elevation += 10.0;
    let raised = evaluate(raised, 1.0);
    assert!(
        (raised.chart_energy - base.chart_energy - base.chart_mass * GRAVITY * 10.0).abs() < 1e-6
    );
}

#[test]
fn batch_and_independent_workers_have_identical_current_trial_results() {
    let inputs: Vec<_> = (0..16)
        .map(|i| specimen(313.15 + i as f64, 15.2e6 + i as f64 * 100.0))
        .collect();
    let mut batch = vec![Evaluation::default(); inputs.len()];
    evaluate_batch(&inputs, 31.0, &mut batch).unwrap();
    let mut workspace = Workspace::new(inputs.len());
    let mut reused = vec![Evaluation::default(); inputs.len()];
    workspace.evaluate(&inputs, 31.0, &mut reused).unwrap();
    assert_eq!(reused, batch);
    let mut changed_inputs = inputs.clone();
    changed_inputs[0].trial.temperature += 0.01;
    workspace
        .evaluate(&changed_inputs, 31.0, &mut reused)
        .unwrap();
    assert_ne!(reused[0].chart_mass, batch[0].chart_mass);
    assert_eq!(reused[0], evaluate(changed_inputs[0], 31.0));
    assert!(
        workspace
            .evaluate(&inputs[..1], 31.0, &mut reused[..1])
            .is_err()
    );
    for (input, result) in inputs.iter().zip(&batch) {
        assert_eq!(evaluate(*input, 31.0), *result);
    }
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    let mut outputs = vec![Evaluation::default(); inputs.len()];
                    evaluate_batch(&inputs, 31.0, &mut outputs).unwrap();
                    outputs
                })
            })
            .collect();
        for worker in workers {
            assert_eq!(worker.join().unwrap(), batch);
        }
    });
}

#[test]
fn finite_checks_and_unsupported_phase_fail_explicitly() {
    let input = specimen(313.15, 15.2e6);
    let mut outputs = [Evaluation::default(); 2];
    assert!(evaluate_batch(&[input], 1.0, &mut outputs).is_err());
    assert!(evaluate_batch(&[input], f64::INFINITY, &mut outputs[..1]).is_err());
    let mut invalids = Vec::new();
    let mut bad = input;
    bad.geometry.volume = 0.0;
    invalids.push(bad);
    let mut bad = input;
    bad.geometry.elevation = f64::NAN;
    invalids.push(bad);
    let mut bad = input;
    bad.trial.mass = -1.0;
    invalids.push(bad);
    let mut bad = input;
    bad.trial.energy = f64::NAN;
    invalids.push(bad);
    let mut bad = input;
    bad.derivative.pressure_rate = f64::NAN;
    invalids.push(bad);
    let mut bad = input;
    bad.derivative.temperature_rate = f64::INFINITY;
    invalids.push(bad);
    let mut bad = input;
    bad.balance.mass_kg_per_second = f64::NAN;
    invalids.push(bad);
    let mut bad = input;
    bad.balance.energy_watts = f64::INFINITY;
    invalids.push(bad);
    let mut bad = input;
    bad.trial.pressure = 101325.0;
    bad.trial.temperature = 450.0;
    invalids.push(bad);
    let mut bad = input;
    bad.derivative.energy_rate = f64::MAX;
    bad.balance.energy_watts = -f64::MAX;
    invalids.push(bad);
    for invalid in invalids {
        assert_eq!(
            evaluate_batch(&[input, invalid], 1.0, &mut outputs)
                .unwrap_err()
                .index,
            1
        );
    }
    let mut workspace = Workspace::new(2);
    let mut unsupported = input;
    unsupported.trial.temperature = 450.0;
    unsupported.trial.pressure = 101325.0;
    assert_eq!(
        workspace
            .evaluate(&[input, unsupported], 1.0, &mut outputs)
            .unwrap_err()
            .index,
        1
    );
    workspace
        .evaluate(&[input, input], 1.0, &mut outputs)
        .unwrap();
    assert_eq!(outputs[0], outputs[1]);
}

#[test]
fn c_abi_layout_and_errors_are_explicit() {
    assert_eq!(std::mem::size_of::<Input>(), 96);
    assert_eq!(std::mem::size_of::<Evaluation>(), 176);
    let input = specimen(313.15, 15.2e6);
    let expected = evaluate(input, 19.0);
    let mut output = Evaluation::default();
    let mut failed = usize::MAX;
    let mut error = [0i8; 256];
    unsafe {
        assert_eq!(
            leitbild_fixed_volume_liquid_batch(
                &input,
                &mut output,
                1,
                19.0,
                &mut failed,
                error.as_mut_ptr(),
                error.len()
            ),
            0
        );
        assert_eq!(output, expected);
        assert_eq!(error[0], 0);
        assert_eq!(
            leitbild_fixed_volume_liquid_batch(
                std::ptr::null(),
                &mut output,
                1,
                19.0,
                &mut failed,
                error.as_mut_ptr(),
                error.len()
            ),
            1
        );
        assert_eq!(failed, 0);
        assert_ne!(error[0], 0);
        assert_eq!(
            leitbild_fixed_volume_liquid_batch(
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
                19.0,
                &mut failed,
                error.as_mut_ptr(),
                error.len()
            ),
            0
        );
        assert_eq!(
            leitbild_fixed_volume_liquid_batch(
                &input,
                &mut output,
                1,
                19.0,
                std::ptr::null_mut(),
                error.as_mut_ptr(),
                error.len()
            ),
            2
        );
    }
}

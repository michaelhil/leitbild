use super::*;
#[test]
#[ignore = "Explicit saved-state closed-energy P completion gate; no IDASolve"]
fn archived_energy_p_completion_without_advancement() {
    let started = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_P_REPORT").unwrap());
    let prepared =
        cooling_input::parse(&fs::read_to_string(directory.join("input.txt")).unwrap()).unwrap();
    let model = &prepared.model;
    let n = model.dimension();
    let mut c = tests::callbacks(model);
    c.allowance = 30.;
    let mut resources = Resources::new().unwrap();
    let y = resources.vector(&vec![0.; n]).unwrap();
    let yp = resources.vector(&vec![0.; n]).unwrap();
    let r = resources.vector(&vec![0.; n]).unwrap();
    let z = resources.vector(&vec![0.; n]).unwrap();
    let mut cases = Vec::new();
    for name in [
        "ORIGINAL",
        "input.normal.checkpoint",
        "input.tighter.checkpoint",
    ] {
        let (physical, slopes) = if name == "ORIGINAL" {
            (model.initial_state().unwrap(), vec![0.; n])
        } else {
            let bytes = fs::read(directory.join(name)).unwrap();
            assert_eq!(&bytes[..8], b"LDCOOL01");
            assert_eq!(bytes.len(), 24 + 16 * n);
            let v = bytes[24..]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect::<Vec<_>>();
            (v[..n].to_vec(), v[n..].to_vec())
        };
        let mut solver = physical.clone();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        let mut solver_yp = slopes.clone();
        c.coordinates.transform(&mut solver_yp);
        c.energy.vector_to_solver(&mut solver_yp);
        unsafe { output(y, n) }.unwrap().copy_from_slice(&solver);
        unsafe { output(yp, n) }
            .unwrap()
            .copy_from_slice(&solver_yp);
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { jtsetup(0., y, yp, r, 3., user) }, 0);
        let rhs = (0..n)
            .map(|i| {
                if i == c.energy.row {
                    0.125
                } else {
                    0.001 * (i % 3 + 1) as f64
                }
            })
            .collect::<Vec<_>>();
        let v = resources.vector(&rhs).unwrap();
        assert_eq!(
            unsafe {
                jtimes(
                    0.,
                    y,
                    yp,
                    r,
                    v,
                    r,
                    3.,
                    user,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            0
        );
        let actual_j_before = unsafe { values(r, n) }.unwrap().to_vec();
        assert_eq!(unsafe { psetup(0., y, yp, r, 3., user) }, 0);
        assert!(c.energy_p.unit().iter().all(
            |&(row, _)| row >= model.layout.network_start && row < model.layout.products_start
        ));
        let mut physical_rhs = rhs.clone();
        c.energy.vector_to_physical(&mut physical_rhs);
        let mut baseline = vec![0.; n];
        c.p.solve(model, &physical_rhs, &mut baseline).unwrap();
        c.energy.vector_to_solver(&mut baseline);
        let baseline_g_defect = 3. * baseline[c.energy.row] - rhs[c.energy.row];
        unsafe { output(r, n) }.unwrap().copy_from_slice(&rhs);
        assert_eq!(unsafe { psolve(0., y, yp, r, r, z, 3., 1., user) }, 0);
        let completed = unsafe { values(z, n) }.unwrap().to_vec();
        let completed_g_defect = 3. * completed[c.energy.row] - rhs[c.energy.row];
        assert!(completed_g_defect.abs() <= 1e-12);
        for row in 0..n {
            if row < model.layout.network_start || row >= model.layout.products_start {
                assert_eq!(completed[row], baseline[row]);
            }
        }
        let mut physical_solution = completed;
        c.energy.vector_to_physical(&mut physical_solution);
        let network = &model.network;
        let mut action = vec![0.; network.dimension()];
        let mut gross = action.clone();
        for col in 0..network.dimension() {
            for k in
                network.column_pointers[col] as usize..network.column_pointers[col + 1] as usize
            {
                let row = network.row_indices[k] as usize;
                let value = c.work.network.jacobian_values[k]
                    * physical_solution[model.layout.network_start + col];
                action[row] += value;
                gross[row] += value.abs();
            }
        }
        let mut non_g_error: f64 = 0.;
        for row in 0..network.dimension() {
            if row + model.layout.network_start != c.energy.row {
                let error = (action[row] - physical_rhs[model.layout.network_start + row]).abs();
                non_g_error = non_g_error.max(error);
                assert!(error <= 1e-10 * gross[row].max(1.));
            }
        }
        assert_eq!(
            unsafe {
                jtimes(
                    0.,
                    y,
                    yp,
                    r,
                    v,
                    r,
                    3.,
                    user,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(unsafe { values(r, n) }.unwrap(), actual_j_before);
        let began = Instant::now();
        for _ in 0..100 {
            assert_eq!(unsafe { psolve(0., y, yp, r, v, z, 3., 1., user) }, 0);
        }
        let hundred_p_seconds = began.elapsed().as_secs_f64();
        let nt = model.thermal.node_count();
        let dt = (0..nt)
            .map(|i| 0.01 * (i % 7 + 1) as f64)
            .collect::<Vec<_>>();
        let deposition = vec![1e-9; nt];
        let water = vec![fuel_thermal::WaterDirection::default(); model.thermal.water_count()];
        let began = Instant::now();
        for _ in 0..100 {
            model
                .thermal
                .jvp_into(&dt, &deposition, &water, &mut c.work.thermal)
                .unwrap();
            std::hint::black_box(c.work.thermal.heat_jvp().unwrap());
        }
        let hundred_thermal_jvp = began.elapsed().as_secs_f64();
        let began = Instant::now();
        for _ in 0..100 {
            let mut sum = 0.;
            model
                .thermal
                .visit_heat_derivatives(&c.work.thermal, |_, _, v| sum += v)
                .unwrap();
            std::hint::black_box(sum);
        }
        let hundred_thermal_emitter = began.elapsed().as_secs_f64();
        let mut fresh_work = model.workspace();
        let began = Instant::now();
        for _ in 0..100 {
            model
                .evaluate(&physical, &slopes, Some(3.), &mut fresh_work)
                .unwrap();
            std::hint::black_box(&fresh_work.residual);
        }
        let hundred_whole_prepare = began.elapsed().as_secs_f64();
        let began = Instant::now();
        for _ in 0..100 {
            model
                .evaluate(&physical, &slopes, None, &mut fresh_work)
                .unwrap();
            std::hint::black_box(&fresh_work.residual);
        }
        let hundred_value_prepare = began.elapsed().as_secs_f64();
        cases.push(format!("{{\"frame\":{},\"cj\":3,\"unitResponsePivot\":{},\"exactNonzeros\":{},\"baselineGRowDefect\":{},\"completedGRowDefect\":{},\"maximumNonGNetworkRowDefect\":{},\"otherComponentSolutionsUnchanged\":true,\"actualFullJVPUnchanged\":true,\"hundredCompletedPSolvesSeconds\":{},\"hundredThermalJVPSeconds\":{},\"hundredThermalEmitterSeconds\":{},\"hundredWholeModelEvaluateSeconds\":{},\"hundredWholeModelValueEvaluateSeconds\":{},\"thermalTimingScope\":\"nonzero-T-and-deposition-directions;held-water-directions-zero\",\"prepareTimingScope\":\"whole-current-model-same-y-yp;linearized-Some3-and-value-None;no-P-snapshot-mutation\"}}",quote(name),finite(c.energy_p.pivot()),c.energy_p.nonzeros(),finite(baseline_g_defect),finite(completed_g_defect),finite(non_g_error),finite(hundred_p_seconds),finite(hundred_thermal_jvp),finite(hundred_thermal_emitter),finite(hundred_whole_prepare),finite(hundred_value_prepare)));
        assert!(c.fatal.is_none());
        assert!(started.elapsed().as_secs_f64() < 30.);
    }
    let json = format!(
        "{{\"kind\":\"actual-closed-energy-P-completion-no-advancement\",\"passed\":true,\"dimension\":{n},\"IDASolveCalls\":0,\"seconds\":{},\"costs\":{},\"cases\":[{}]}}",
        finite(started.elapsed().as_secs_f64()),
        c.metrics(),
        cases.join(",")
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap();
    writeln!(file, "{json}").unwrap();
    file.sync_all().unwrap();
    println!("{json}");
}
#[test]
#[ignore = "Explicit archived-input policy4 power gate; no IDASolve"]
fn archived_power_response_and_weights_without_advancement() {
    let start = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_POWER_REPORT").unwrap());
    let prepared =
        cooling_input::parse(&fs::read_to_string(directory.join("input.txt")).unwrap()).unwrap();
    let model = &prepared.model;
    let n = model.dimension();
    let accuracy = cooling_accuracy::Accuracy::new(model, &prepared.target_emissions).unwrap();
    let response = model.source.fuel_history().power_response().unwrap();
    let mut powers = vec![0.; response.output_count()];
    let mut gradients = vec![0.; response.columns().len()];
    let mut c = tests::callbacks(model);
    let mut resources = Resources::new().unwrap();
    let vector = resources.vector(&vec![0.; n]).unwrap();
    let weights = resources.vector(&vec![0.; n]).unwrap();
    let mut cases = Vec::new();
    for name in [
        "ORIGINAL",
        "input.normal.common-0.bin",
        "input.tighter.common-0.bin",
    ] {
        let physical = if name == "ORIGINAL" {
            model.initial_state().unwrap()
        } else {
            let bytes = fs::read(directory.join(name)).unwrap();
            assert_eq!(&bytes[..8], b"LDCCOM01");
            assert_eq!(bytes.len(), 24 + 8 * n);
            assert_eq!(f64::from_le_bytes(bytes[16..24].try_into().unwrap()), 0.001);
            bytes[24..]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect()
        };
        model
            .evaluate(&physical, &vec![0.; n], Some(1.), &mut c.work)
            .unwrap();
        response
            .evaluate(
                &physical[..response.state_count()],
                &mut powers,
                &mut gradients,
            )
            .unwrap();
        let actual = c.work.source.fuel_deposition().unwrap();
        let mut power_error: f64 = 0.;
        for (&a, &b) in actual.iter().zip(&powers) {
            power_error = power_error.max((a - b).abs());
            assert!((a - b).abs() <= 2e-12 * a.abs().max(b.abs()) + 1e-25);
        }
        let mut direction = vec![0.; n];
        for &column in response.columns() {
            direction[column] = ((column % 11) as f64 - 5.)
                * if column < model.source.nc_dimension() {
                    1e-3
                } else {
                    1e-12
                };
        }
        model.jvp(&direction, 1., &mut c.work).unwrap();
        let actual = c.work.source.fuel_deposition_jvp().unwrap();
        let mut action_error: f64 = 0.;
        for q in 0..response.output_count() {
            let range = response.offsets()[q]..response.offsets()[q + 1];
            let (dot, gross) = range
                .map(|k| gradients[k] * direction[response.columns()[k]])
                .fold((0., 0.), |(s, a), v| (s + v, a + v.abs()));
            action_error = action_error.max((dot - actual[q]).abs());
            assert!((dot - actual[q]).abs() <= 4096. * f64::EPSILON * gross + 1e-25);
        }
        let mut solver = physical.clone();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        unsafe { output(vector, n) }
            .unwrap()
            .copy_from_slice(&solver);
        c.absolute = accuracy.absolute(1.).unwrap();
        c.absolute[c.energy.row] = EnergyCoordinates::absolute(n, 1.);
        c.relative = 1e-5;
        c.power_resolution_w = 1e-12;
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { error_weights(vector, weights, user) }, 0);
        let normal = unsafe { values(weights, n) }.unwrap().to_vec();
        let mut box_ratio: f64 = 0.;
        for q in 0..response.output_count() {
            let box_w: f64 = (response.offsets()[q]..response.offsets()[q + 1])
                .map(|k| gradients[k].abs() / normal[response.columns()[k]])
                .sum();
            let budget = 1e-12 + 1e-5 * powers[q].abs();
            box_ratio = box_ratio.max(box_w / budget);
            assert!(box_w <= budget * (1. + 2e-13));
        }
        let mut old_rhs = 0.;
        let mut new_rhs = 0.;
        let mut maximum_tightening: f64 = 1.;
        for (i, &rate) in c.work.source.rates().unwrap()[..response.state_count()]
            .iter()
            .enumerate()
        {
            let old_scale = c.absolute[i] + c.relative * physical[i].abs();
            old_rhs += (rate / old_scale).powi(2);
            new_rhs += (rate * normal[i]).powi(2);
            maximum_tightening = maximum_tightening.max(old_scale * normal[i]);
        }
        let began = Instant::now();
        for _ in 0..100 {
            assert_eq!(unsafe { error_weights(vector, weights, user) }, 0);
        }
        let hundred_seconds = began.elapsed().as_secs_f64();
        c.absolute = accuracy.absolute(10.).unwrap();
        c.absolute[c.energy.row] = EnergyCoordinates::absolute(n, 10.);
        c.relative /= 10.;
        c.power_resolution_w /= 10.;
        assert_eq!(unsafe { error_weights(vector, weights, user) }, 0);
        for (&a, &b) in normal.iter().zip(unsafe { values(weights, n) }.unwrap()) {
            assert!((b - 10. * a).abs() <= 4e-14 * b.abs());
        }
        assert!(c.fatal.is_none());
        assert_eq!(c.residuals, 0);
        assert_eq!(c.bases, 0);
        cases.push(format!("{{\"frame\":{},\"maximumPowerDifferenceW\":{},\"maximumGradientActionDifferenceW\":{},\"maximumBoxBudgetRatio\":{},\"maximumScaleTightening\":{},\"oldHistoryRHSWRMSContribution\":{},\"cappedHistoryRHSWRMSContribution\":{},\"hundredEWTSeconds\":{},\"tenfoldRefinementPassed\":true}}", quote(name), finite(power_error), finite(action_error), finite(box_ratio), finite(maximum_tightening), finite((old_rhs / n as f64).sqrt()), finite((new_rhs / n as f64).sqrt()), finite(hundred_seconds)));
        assert!(start.elapsed().as_secs_f64() < 30.);
    }
    let json = format!(
        "{{\"kind\":\"actual-policy4-power-no-advancement\",\"passed\":true,\"dimension\":{n},\"outputs\":{},\"sparseResponseEntries\":{},\"IDASolveCalls\":0,\"seconds\":{},\"cases\":[{}]}}",
        response.output_count(),
        response.columns().len(),
        finite(start.elapsed().as_secs_f64()),
        cases.join(",")
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap();
    writeln!(file, "{json}").unwrap();
    file.sync_all().unwrap();
    println!("{json}");
}
#[test]
#[ignore = "Explicit archived-input policy3 callback gate; no IDASolve"]
fn archived_energy_chart_callbacks_without_advancement() {
    let start = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_CHART_REPORT").unwrap());
    let prepared =
        cooling_input::parse(&fs::read_to_string(directory.join("input.txt")).unwrap()).unwrap();
    let model = &prepared.model;
    let n = model.dimension();
    let original = model.initial_state().unwrap();
    let mut c = tests::callbacks(model);
    c.allowance = 30.;
    let mut resources = Resources::new().unwrap();
    let y = resources.vector(&original).unwrap();
    let yp = resources.vector(&vec![0.; n]).unwrap();
    let result = resources.vector(&vec![0.; n]).unwrap();
    let mut cases = Vec::new();
    for name in [
        "ORIGINAL",
        "input.normal.checkpoint",
        "input.normal.unadmitted-raw",
    ] {
        let (mut state, slopes) = if name == "ORIGINAL" {
            (original.clone(), vec![0.; n])
        } else {
            let bytes = fs::read(directory.join(name)).unwrap();
            assert_eq!(&bytes[..8], b"LDCOOL01");
            assert_eq!(bytes.len(), 24 + 16 * n);
            let v = bytes[24..]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect::<Vec<_>>();
            (v[..n].to_vec(), v[n..].to_vec())
        };
        // Keep an existing defect and a further injected defect: no projection.
        let mut baseline = state.clone();
        c.energy.state_to_solver(&mut baseline);
        state[c.energy.row] += 2.;
        let mut solver = state.clone();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        assert!((solver[c.energy.row] - baseline[c.energy.row] - 2.).abs() < 1e-5);
        let mut roundtrip = solver.clone();
        c.coordinates.transform(&mut roundtrip);
        c.energy.state_to_physical(&mut roundtrip);
        for i in 0..n {
            if i != c.energy.row {
                assert_eq!(roundtrip[i].to_bits(), state[i].to_bits());
            }
        }
        let roundtrip_error = (roundtrip[c.energy.row] - state[c.energy.row]).abs();
        assert!(roundtrip_error <= 8. * f64::EPSILON * state[c.energy.row].abs().max(1.));
        let mut solver_slopes = slopes;
        c.coordinates.transform(&mut solver_slopes);
        c.energy.vector_to_solver(&mut solver_slopes);
        unsafe { output(y, n) }.unwrap().copy_from_slice(&solver);
        unsafe { output(yp, n) }
            .unwrap()
            .copy_from_slice(&solver_slopes);
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { residual(0., y, yp, result, user) }, 0);
        let f = unsafe { values(result, n) }.unwrap()[c.energy.row];
        let physical_f = c.energy.balance(&c.work.residual);
        assert!(
            (f - physical_f).abs()
                <= 1e-6
                    + 4096. * f64::EPSILON * c.work.residual.iter().map(|x| x.abs()).sum::<f64>()
        );
        let mut direction = (0..n).map(|i| 0.001 / (i + 1) as f64).collect::<Vec<_>>();
        direction[c.energy.row] = 0.125;
        direction[model.layout.energies_start] = 2e10;
        direction[model.layout.temperatures_start] = 0.2;
        let v = resources.vector(&direction).unwrap();
        for cj in [1., 1e12] {
            assert_eq!(unsafe { jtsetup(0., y, yp, result, cj, user) }, 0);
            assert_eq!(
                unsafe {
                    jtimes(
                        0.,
                        y,
                        yp,
                        result,
                        v,
                        result,
                        cj,
                        user,
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                },
                0
            );
            assert_eq!(
                unsafe { values(result, n) }.unwrap()[c.energy.row],
                cj * direction[c.energy.row] - c.work.complete_energy_rate_jvp().unwrap()
            );
        }
        // Existing component P already owns source D. Only wrap its energy basis.
        assert_eq!(unsafe { psetup(0., y, yp, result, 1., user) }, 0);
        let mut rhs = direction.clone();
        c.energy.vector_to_physical(&mut rhs);
        let mut expected = vec![0.; n];
        c.p.solve(model, &rhs, &mut expected).unwrap();
        c.energy.vector_to_solver(&mut expected);
        c.energy_p
            .apply(direction[c.energy.row], &mut expected)
            .unwrap();
        let z = resources.vector(&vec![0.; n]).unwrap();
        assert_eq!(unsafe { psolve(0., y, yp, result, v, z, 1., 1., user) }, 0);
        assert_eq!(unsafe { values(z, n) }.unwrap(), expected);
        assert!(c.fatal.is_none());
        cases.push(format!("{{\"frame\":{},\"injectedDefectJ\":2,\"preservedSolverGJ\":{},\"anchorRoundtripErrorJ\":{},\"solverResidualW\":{},\"independentPhysicalResidualSumW\":{},\"hugeCJ\":1e12,\"PsimilarityPassed\":true}}",quote(name),finite(solver[c.energy.row]),finite(roundtrip_error),finite(f),finite(physical_f)));
        assert!(start.elapsed().as_secs_f64() < 30.);
    }
    let json = format!(
        "{{\"kind\":\"actual-policy3-energy-chart-no-advancement\",\"passed\":true,\"dimension\":{n},\"anchorRow\":{},\"IDASolveCalls\":0,\"seconds\":{},\"cases\":[{}]}}",
        c.energy.row,
        finite(start.elapsed().as_secs_f64()),
        cases.join(",")
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap();
    file.write_all(json.as_bytes()).unwrap();
    file.sync_all().unwrap();
    eprintln!("{json}");
}
#[test]
#[ignore = "Archived actual-state diagnostic; set LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS explicitly"]
fn archived_physical_energy_identity_without_advancement() {
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let prepared =
        cooling_input::parse(&fs::read_to_string(directory.join("input.txt")).unwrap()).unwrap();
    let model = &prepared.model;
    let l = model.layout;
    let initial = model.initial_state().unwrap();
    let accuracy = cooling_accuracy::Accuracy::new(model, &prepared.target_emissions).unwrap();
    let absolute = accuracy.absolute(1.).unwrap();
    let mut network_energy = (0..model.network.config().water.len()
        + model.network.config().solids.len())
        .map(|i| l.network_start + model.network.energy_row(i))
        .collect::<Vec<_>>();
    network_energy.extend(
        (0..model.network.config().secondaries.len())
            .map(|i| l.network_start + model.network.secondary_energy_row(i)),
    );
    let mut energy = network_energy.clone();
    energy.extend(l.energies_start..l.temperatures_start);
    let release = model.source.fuel_release_row();
    let sum = |values: &[f64]| {
        let (mut s, mut c) = (0f64, 0f64);
        for &x in values {
            let t = s + x;
            c += if s.abs() >= x.abs() {
                (s - t) + x
            } else {
                (x - t) + s
            };
            s = t;
        }
        s + c
    };
    for name in ["input.normal.checkpoint", "input.normal.unadmitted-raw"] {
        let bytes = fs::read(directory.join(name)).unwrap();
        assert_eq!(&bytes[..8], b"LDCOOL01");
        let n = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
        assert_eq!(n, model.dimension());
        assert_eq!(bytes.len(), 24 + 16 * n);
        let time = f64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let numbers = bytes[24..]
            .chunks_exact(8)
            .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        let (y, yp) = numbers.split_at(n);
        assert!(numbers.iter().all(|v| v.is_finite()));
        let mut work = model.workspace();
        model.evaluate(y, yp, Some(1.), &mut work).unwrap();
        let internal = network_energy
            .iter()
            .map(|&r| work.network.rates[r - l.network_start])
            .collect::<Vec<_>>();
        let walls = work.thermal.wall_rates().unwrap().to_vec();
        let thermal = work.thermal.heat_rates().unwrap().to_vec();
        let fuel = work.source.rates().unwrap()[release];
        let rhs_identity = sum(&internal) + sum(&walls) + sum(&thermal) - fuel;
        let mut drift = energy
            .iter()
            .map(|&r| y[r] - initial[r])
            .collect::<Vec<_>>();
        drift.push(-(y[release] - initial[release]));
        let mut yp_terms = energy.iter().map(|&r| yp[r]).collect::<Vec<_>>();
        yp_terms.push(-yp[release]);
        let mut residual_terms = energy.iter().map(|&r| work.residual[r]).collect::<Vec<_>>();
        residual_terms.push(-work.residual[release]);
        let coordinates = Coordinates {
            nc: model.source.nc_dimension(),
            ledger: model.source.ledger_row(),
        };
        let mut solver_y = y.to_vec();
        coordinates.transform(&mut solver_y);
        let scales = absolute
            .iter()
            .enumerate()
            .map(|(r, &a)| {
                a + if progress_relative(model, r) {
                    1e-5 * solver_y[r].abs()
                } else {
                    0.
                }
            })
            .collect::<Vec<_>>();
        let mut direction = scales
            .iter()
            .enumerate()
            .map(|(r, &s)| s * if r % 2 == 0 { 0.25 } else { -0.25 })
            .collect::<Vec<_>>();
        let solver_direction = direction.clone();
        coordinates.physical(&solver_direction, &mut direction);
        model.jvp(&direction, 1., &mut work).unwrap();
        let mut action_terms = energy.iter().map(|&r| work.jvp[r]).collect::<Vec<_>>();
        action_terms.push(-work.jvp[release]);
        let mut expected_terms = energy.iter().map(|&r| direction[r]).collect::<Vec<_>>();
        expected_terms.push(-direction[release]);
        let action_error = sum(&action_terms) - sum(&expected_terms);
        let mut worst = energy
            .iter()
            .map(|&r| (r, work.residual[r], work.residual[r].abs() / scales[r]))
            .collect::<Vec<_>>();
        worst.sort_by(|a, b| b.2.total_cmp(&a.2));
        let worst = worst.iter().take(8).map(|&(r,f,w)|format!("{{\"row\":{r},\"physicalResidualW\":{f:e},\"absoluteScaleJ\":{:e},\"residualOverScalePerS\":{w:e}}}",scales[r])).collect::<Vec<_>>().join(",");
        let net_residual = sum(&network_energy
            .iter()
            .map(|&r| work.residual[r])
            .collect::<Vec<_>>());
        let thermal_residual = sum(&work.residual[l.energies_start..l.temperatures_start]);
        eprintln!(
            "{{\"kind\":\"archived-energy-identity-no-advancement\",\"frame\":{},\"provenance\":{},\"time\":{time:e},\"energyDriftFromPreparedJ\":{:e},\"internalNetworkRHSW\":{:e},\"wallToNetworkW\":{:e},\"thermalRHSW\":{:e},\"independentFuelReleaseW\":{fuel:e},\"completeRHSIdentityW\":{rhs_identity:e},\"storedDerivativeIdentityW\":{:e},\"completeResidualIdentityW\":{:e},\"networkResidualSumW\":{net_residual:e},\"thermalResidualSumW\":{thermal_residual:e},\"fuelReleaseResidualW\":{:e},\"cj\":1,\"fullJVPIdentityError\":{action_error:e},\"weightedPointEnergyResiduals\":[{worst}],\"weightScope\":\"raw physical energy residual divided by solver energy scale; not IDA Newton or LTE norm\"}}",
            quote(name),
            quote(if name.ends_with("checkpoint") {
                "retained-admitted-polynomial-endpoint"
            } else {
                "unadmitted-raw-solver-buffers"
            }),
            sum(&drift),
            sum(&internal),
            sum(&walls),
            sum(&thermal),
            sum(&yp_terms),
            sum(&residual_terms),
            work.residual[release]
        );
        let gross = internal
            .iter()
            .chain(&walls)
            .chain(&thermal)
            .map(|v| v.abs())
            .sum::<f64>()
            + fuel.abs();
        assert!(rhs_identity.abs() <= 1e-6 + 4096. * f64::EPSILON * gross);
        assert!(
            action_error.abs()
                <= 1e-6 + 4096. * f64::EPSILON * action_terms.iter().map(|v| v.abs()).sum::<f64>()
        );
    }
}

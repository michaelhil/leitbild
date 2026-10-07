use super::*;

// These diagnostics use the current kernel. Historical snapshot identities are
// intentionally refused; old forensics require the sources retained with that receipt.
fn energy_vector_roundtrip_bound(
    model: &source_cooling::Model,
    anchor: usize,
    original: &[f64],
    mapped_anchor: f64,
    restored: &[f64],
) -> Result<(f64, f64, f64), String> {
    let l = model.layout;
    let rows = model
        .installed_energy_rows()
        .chain([
            model.source.fuel_release_row(),
            l.barrel_released,
            l.barrel_exported,
            l.ambient_exported,
            l.fuel_capture_exported,
        ])
        .map(|r| (r, 1.))
        .chain(model.capture_paid_rows())
        .collect::<Vec<_>>();
    let forward = rows
        .iter()
        .map(|&(r, q)| (q * original[r]).abs())
        .sum::<f64>();
    let inverse = mapped_anchor.abs()
        + rows
            .iter()
            .filter(|&&(r, _)| r != anchor)
            .map(|&(r, q)| (q * original[r]).abs())
            .sum::<f64>();
    let operations = 12. * rows.len() as f64 + 16.;
    let u = f64::EPSILON / 2.;
    // Conservative operation-count gamma budget for both compensated sums,
    // including positive operand accumulation. The cancellation scale is the
    // actual installed-energy/receipt operands, not the small restored anchor.
    let gamma = operations * u / (1. - operations * u);
    let operands = (forward + inverse) / (1. - operations * u);
    let bound = gamma * operands;
    if !operands.is_finite() || !bound.is_finite() || operations * u >= 1. {
        return Err("Invalid energy vector roundtrip arithmetic bound".into());
    }
    for r in 0..original.len() {
        if r != anchor && original[r].to_bits() != restored[r].to_bits() {
            return Err(format!("Energy vector roundtrip changed nonanchor row{r}"));
        }
    }
    let error = (restored[anchor] - original[anchor]).abs();
    if !error.is_finite() || error > bound {
        return Err(format!(
            "Energy vector roundtrip row{anchor}: restored={} expected={} error={error:e} operandSum={operands:e} bound={bound:e}",
            restored[anchor], original[anchor]
        ));
    }
    Ok((error, operands, bound))
}

#[test]
fn energy_vector_roundtrip_uses_all_operands_but_rejects_wrong_mapping() {
    let m = cooling_fixture::fixture();
    let initial = m.initial_state().unwrap();
    let g = EnergyCoordinates::new(&m, &initial).unwrap();
    let mut original = vec![0.; m.dimension()];
    for r in m.installed_energy_rows() {
        original[r] = 0.01 * ((r % 7 + 1) as f64);
    }
    original[m.layout.ambient_exported] = -0.125;
    original[m.layout.fuel_capture_exported] = 0.25;
    for (r, q) in m.capture_paid_rows() {
        original[r] = 0.03 / q;
    }
    let mut mapped = original.clone();
    g.vector_to_solver(&mut mapped);
    let mapped_anchor = mapped[g.row];
    g.vector_to_physical(&mut mapped);
    energy_vector_roundtrip_bound(&m, g.row, &original, mapped_anchor, &mapped).unwrap();
    mapped[g.row] -= original[m.layout.fuel_capture_exported];
    assert!(energy_vector_roundtrip_bound(&m, g.row, &original, mapped_anchor, &mapped).is_err());
    mapped = original.clone();
    g.vector_to_solver(&mut mapped);
    g.vector_to_physical(&mut mapped);
    mapped[g.row] -= original[m.layout.ambient_exported];
    assert!(energy_vector_roundtrip_bound(&m, g.row, &original, mapped_anchor, &mapped).is_err());
    mapped = original.clone();
    mapped[m.layout.barrel_temperature] =
        f64::from_bits(original[m.layout.barrel_temperature].to_bits() + 1);
    assert!(energy_vector_roundtrip_bound(&m, g.row, &original, mapped_anchor, &mapped).is_err());
}

#[test]
#[ignore = "Explicit actual seven-frame pressure and fuel-binding entry proof; no IDASolve; 30 s maximum"]
fn actual_pressure_entry_without_advancement() {
    use leitbild_plant_numerics::cold_pressurizer as cp;
    let started = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_PRESSURE_REPORT").unwrap());
    let deadline = || {
        if started.elapsed().as_secs_f64() < 30. {
            Ok(())
        } else {
            Err("Pressure entry proof30s allowance exhausted".to_string())
        }
    };
    let mut cases = Vec::new();
    let result = (|| -> Result<(), String> {
        let prepared = cooling_input::parse(
            &fs::read_to_string(directory.join("input.txt")).map_err(|e| e.to_string())?,
        )?;
        let m = &prepared.model;
        let l = m.layout;
        let n = m.dimension();
        let initial = m.initial_state()?;
        let accuracy = cooling_accuracy::Accuracy::new(m, &prepared.target_emissions)?;
        let mut w = m.workspace();
        m.evaluate(&initial, &vec![0.; n], Some(0.), &mut w)?;
        let range = |values: &[f64]| {
            [
                values.iter().copied().fold(f64::INFINITY, f64::min),
                values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            ]
        };
        let primary_t = (0..m.carrier.cells())
            .map(|i| initial[l.network_start + m.network.temperature_row(i)])
            .collect::<Vec<_>>();
        let primary_mass = initial[l.network_start + m.network.total_mass_row()];
        let primary_energy = (0..m.carrier.cells())
            .map(|i| initial[l.network_start + m.network.energy_row(i)])
            .sum::<f64>();
        let primary_b = (0..m.carrier.cells())
            .map(|i| initial[l.carrier_start + water_carrier::WIDTH * i + 1])
            .sum::<f64>();
        let preparation_json = format!(
            "{{\"scope\":\"fresh-physical-initial-stocks-before-IC;not-reached-state-reset\",\"primaryTemperatureRangeK\":{:?},\"primaryMassKg\":{primary_mass},\"primaryEnergyJ\":{primary_energy},\"primaryHydrogenTargetAtoms\":{},\"primaryBoron10Atoms\":{primary_b},\"thermalTemperatureRangeK\":{:?},\"sourcePreparedFuelTemperatureRangeK\":{:?},\"barrelTemperatureK\":{},\"surge\":{{\"liquidTemperatureK\":{},\"steelTemperatureK\":{},\"massKg\":{},\"energyJ\":{}}},\"pressurizer\":{{\"liquidTemperatureK\":{},\"gasTemperatureK\":{},\"liquidMassKg\":{},\"vaporMassKg\":{},\"liquidEnergyJ\":{},\"gasEnergyJ\":{},\"derivedAirMassKg\":{}}}}}",
            range(&primary_t), m.carrier.hydrogen_per_kg()*primary_mass,
            range(&initial[l.temperatures_start..l.barrel_energy]),range(m.source.prepared_temperatures()),
            initial[l.barrel_temperature],initial[l.surge_start+finite_surge::TEMPERATURE],
            initial[l.surge_start+finite_surge::STEEL_TEMPERATURE],initial[l.surge_start+finite_surge::MASS],
            initial[l.surge_start+finite_surge::ENERGY],initial[l.pressurizer_start+cp::LIQUID_TEMPERATURE],
            initial[l.pressurizer_start+cp::GAS_TEMPERATURE],initial[l.pressurizer_start+cp::LIQUID_MASS],
            initial[l.pressurizer_start+cp::VAPOR_MASS],initial[l.pressurizer_start+cp::LIQUID_ENERGY],
            initial[l.pressurizer_start+cp::GAS_ENERGY],m.pressure_connection().pressurizer.input().air_mass
        );
        let head = [
            -w.residual[l.surge_start + finite_surge::LEFT_FLOW],
            -w.residual[l.surge_start + finite_surge::RIGHT_FLOW],
        ];
        let pressure_scale = initial[l.surge_start + finite_surge::PRESSURE].abs()
            + initial[l.network_start + m.network.pressure_row()].abs()
            + w.pressurizer.diagnostics()?.bottom_pressure.abs();
        if head
            .iter()
            .any(|f| f.abs() > 1024. * f64::EPSILON * pressure_scale)
        {
            return Err(format!(
                "Fresh selected hydrostatic head is not roundoff-zero: {head:?}"
            ));
        }
        deadline()?;
        for refinement in [1., 10.] {
            let mut y = initial.clone();
            let mut yp = vec![0.; n];
            let mut trace = cooling_initial::Trace::default();
            let initialization = cooling_initial::initialize(
                m,
                &mut y,
                &mut yp,
                &accuracy.absolute(refinement)?,
                &mut w,
                started,
                30.,
                1e-5 / refinement,
                &mut trace,
            );
            // Retain the actual failed operands, not merely an empty cases
            // array. Fluid rows plus differentiated chart rates are contained
            // here; no 72k source-state dump or second physical evaluation.
            if let Err(reason) = &initialization {
                let path = report.with_extension(format!("ic-{refinement}.json"));
                let rows = m.fluid_rows().map(|r| format!(
                    "{{\"row\":{r},\"differential\":{},\"state\":{},\"rate\":{},\"residualFromLastSuccessfulPreparation\":{}}}",
                    m.is_differential(r), finite(y[r]), finite(yp[r]), finite(w.residual[r])
                )).collect::<Vec<_>>().join(",");
                let snapshot = format!(
                    "{{\"scope\":\"raw-joint-IC-iterate-not-admitted;stored-workspace-residual-not-recomputed\",\"refinement\":{refinement},\"reason\":{},\"iterations\":{},\"fluid\":[{rows}]}}",
                    quote(reason),
                    trace.json()
                );
                use std::io::Write;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|e| e.to_string())?;
                writeln!(file, "{snapshot}").map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                cases.push(format!("{{\"refinement\":{refinement},\"passed\":false,\"preparation\":{preparation_json},\"initializationTrace\":{},\"failedIterateFile\":{}}}", trace.json(), quote(&path.to_string_lossy())));
            }
            let ic = initialization?;
            let case_index = cases.len();
            cases.push(format!("{{\"refinement\":{refinement},\"passed\":false,\"preparation\":{preparation_json},\"completedStage\":\"joint-initialization\",\"initialization\":{},\"initializationTrace\":{}}}",ic.json(),trace.json()));
            deadline()?;
            accuracy.carrier_ledger(m, &y)?;
            let g = EnergyCoordinates::new(m, &initial)?;
            let mut off = y.clone();
            off[l.pressurizer_start + cp::INTERFACE_TEMPERATURE] += 1e-4;
            m.evaluate(&off, &yp, Some(0.), &mut w)?;
            let independent = g.balance(&yp) - g.balance(&w.residual);
            let rate = w.complete_energy_rate()?;
            let energy_error = (independent - rate).abs();
            let capture_totals = cooling_capture::power_totals(w.capture.power_channels()?)?;
            if capture_totals.iter().any(|v| *v < 0.) {
                return Err(
                    "Actual fuel-binding entry cannot have negative accepted nuclear power"
                        .into(),
                );
            }
            let capture_closure = capture_totals[0] - capture_totals[1..].iter().sum::<f64>();
            if capture_closure.abs() > 4096. * f64::EPSILON * capture_totals[0] {
                return Err(format!(
                    "Actual fuel-binding local allocation fails closure: {capture_closure:e}"
                ));
            }
            let capture_paid_rate = m
                .capture_paid_rows()
                .map(|(r, q)| q * (yp[r] - w.residual[r]))
                .sum::<f64>();
            if (capture_paid_rate - capture_totals[0]).abs()
                > 4096. * f64::EPSILON * capture_totals[0]
            {
                return Err(
                    "Actual gross-capture progress does not pay emitted binding energy".into(),
                );
            }
            let capture_json = format!("{{\"channelOrder\":[\"emitted\",\"self\",\"clad\",\"water\",\"export\"],\"actualPowerTotalsW\":{},\"existingProgressPaidRateW\":{},\"allocationDefectW\":{},\"scope\":\"same-current-workspace;fresh-zero-source-valid;nonzero-class-partitions-qualified-by-foundation-tests;no-extra-RHS-EOS-or-trajectory\"}}",
                numbers(&capture_totals),finite(capture_paid_rate),finite(capture_closure));
            let scale = g.balance(&yp).abs() + g.balance(&w.residual).abs() + rate.abs();
            if energy_error > 1e-6 + 4096. * f64::EPSILON * scale {
                return Err(format!(
                    "Off-interface independent energy RHS identity {energy_error:e}"
                ));
            }
            let mut direction = vec![0.; n];
            for r in m.installed_energy_rows() {
                direction[r] = 0.01 * ((r % 7 + 1) as f64);
            }
            direction[l.pressurizer_start + cp::HEIGHT] = 1e-3;
            direction[l.pressurizer_start + cp::INTERFACE_TEMPERATURE] = 1e-3;
            direction[l.surge_start + finite_surge::LEFT_FLOW] = 1e-3;
            direction[l.surge_start + finite_surge::RIGHT_FLOW] = -1e-3;
            direction[l.ambient_exported] = -0.1;
            direction[l.fuel_capture_exported] = 0.03;
            for (r, q) in m.capture_paid_rows() {
                direction[r] = 0.01 / q;
            }
            m.jvp(&direction, 0., &mut w)?;
            let unshifted_error = (g.balance(&w.jvp) + w.complete_energy_rate_jvp()?).abs();
            let gross = w.jvp.iter().map(|v| v.abs()).sum::<f64>();
            if unshifted_error > 1e-6 + 4096. * f64::EPSILON * gross {
                return Err(format!(
                    "Unshifted complete energy JVP identity {unshifted_error:e}"
                ));
            }
            // Affine states and linear vectors include every newly installed
            // store and signed export, without suppressing an injected defect.
            let mut injected = y.clone();
            injected[g.row] += 0.25;
            injected[l.ambient_exported] = -0.125;
            let physical = injected.clone();
            g.state_to_solver(&mut injected);
            let defect = injected[g.row];
            g.state_to_physical(&mut injected);
            if injected != physical || defect == 0. {
                return Err("Pressure energy state roundtrip/independent defect failed".into());
            }
            let original = direction.clone();
            g.vector_to_solver(&mut direction);
            let mapped_anchor = direction[g.row];
            g.vector_to_physical(&mut direction);
            let (roundtrip_error, roundtrip_operands, roundtrip_bound) =
                energy_vector_roundtrip_bound(m, g.row, &original, mapped_anchor, &direction)?;
            let roundtrip_json = format!(
                "{{\"row\":{},\"actual\":{},\"expected\":{},\"error\":{roundtrip_error:e},\"operandSum\":{roundtrip_operands:e},\"bound\":{roundtrip_bound:e}}}",
                g.row, direction[g.row], original[g.row]
            );
            deadline()?;
            let mut c = tests::callbacks(m);
            c.allowance = 30.;
            c.start = started;
            c.absolute = accuracy.absolute(refinement)?;
            c.relative = 1e-5 / refinement;
            c.power_resolution_w = cooling_accuracy::DEPOSIT_RESOLUTION_W / refinement;
            let mut solver = y.clone();
            c.coordinates.transform(&mut solver);
            c.energy.state_to_solver(&mut solver);
            let mut slope = yp.clone();
            c.coordinates.transform(&mut slope);
            c.energy.vector_to_solver(&mut slope);
            let mut resources = Resources::new()?;
            let sy = resources.vector(&solver)?;
            let syp = resources.vector(&slope)?;
            let rhs = (0..n)
                .map(|i| if i % 2 == 0 { 1e-4 } else { -2e-4 })
                .collect::<Vec<_>>();
            let rv = resources.vector(&rhs)?;
            let zv = resources.vector(&vec![0.; n])?;
            let user = (&mut c as *mut Callbacks<'_>).cast();
            let began = Instant::now();
            checked(
                unsafe { psetup(0., sy, syp, rv, 3., user) },
                "Actual pressure Psetup",
            )?;
            checked(
                unsafe { psolve(0., sy, syp, rv, rv, zv, 3., 1., user) },
                "Actual pressure Psolve",
            )?;
            let p_seconds = began.elapsed().as_secs_f64();
            let mut solution = unsafe { values(zv, n) }?.to_vec();
            if solution[g.row] != rhs[g.row] / 3. {
                return Err("Actual completed P energy row failed".into());
            }
            c.energy.vector_to_physical(&mut solution);
            let mut physical_rhs = rhs.clone();
            c.energy.vector_to_physical(&mut physical_rhs);
            m.evaluate(&y, &yp, Some(3.), &mut w)?;
            let mut previous_scales = (0..n)
                .map(|r| state_error_scale(m, r, solver[r], c.absolute[r], c.relative))
                .collect::<Vec<_>>();
            c.power_weights.cap(
                &solver[..m.source.history_dimension()],
                c.relative,
                c.power_resolution_w,
                &mut previous_scales,
                &mut c.power_work,
            )?;
            c.barrel_weights.cap(
                &solver[..l.source_end],
                c.relative,
                c.power_resolution_w,
                &mut previous_scales,
            )?;
            let mut current_scales = previous_scales.clone();
            let weight_started = Instant::now();
            c.capture_weights.cap(
                &solver,
                c.relative,
                c.power_resolution_w,
                &mut current_scales,
            )?;
            let capture_weight_seconds = weight_started.elapsed().as_secs_f64();
            let changed_rows = previous_scales
                .iter()
                .zip(&current_scales)
                .filter(|(a, b)| a > b)
                .count();
            let max_tightening = previous_scales
                .iter()
                .zip(&current_scales)
                .map(|(a, b)| a / b)
                .fold(1., f64::max);
            let mut rates = yp
                .iter()
                .zip(&w.residual)
                .map(|(a, b)| a - b)
                .collect::<Vec<_>>();
            c.coordinates.transform(&mut rates);
            c.energy.vector_to_solver(&mut rates);
            let weighted_rhs = |scales: &[f64]| {
                (rates
                    .iter()
                    .zip(scales)
                    .map(|(r, s)| (r / s).powi(2))
                    .sum::<f64>()
                    / n as f64)
                    .sqrt()
            };
            let old_rhs = weighted_rhs(&previous_scales);
            let new_rhs = weighted_rhs(&current_scales);
            if !max_tightening.is_finite() || !old_rhs.is_finite() || !new_rhs.is_finite() {
                return Err("Nonfinite fuel-binding weight entry diagnostic".into());
            }
            let (capture_outputs, capture_gradients, capture_nonzero_gradients) = c.capture_weights.structure();
            if capture_nonzero_gradients == 0 { return Err("Fresh fuel-binding entry lost current source response support".into()); }
            let capture_weights_json = format!("{{\"scope\":\"one-current-state-no-advance;old-fission-barrel-caps-retained;not-cost-certificate\",\"outputs\":{capture_outputs},\"gradientEntries\":{capture_gradients},\"nonzeroCurrentGradients\":{capture_nonzero_gradients},\"seconds\":{capture_weight_seconds},\"tightenedRows\":{changed_rows},\"maxScaleTightening\":{max_tightening},\"oldWeightedRHSNorm\":{old_rhs},\"newWeightedRHSNorm\":{new_rhs}}}");
            let mut action = vec![0.; n];
            let mut gross = vec![0.; n];
            m.visit_fluid_jacobian(&w, |r, col, a| {
                let v = a * solution[col];
                action[r] += v;
                gross[r] += v.abs();
            })?;
            let mut p_error = 0_f64;
            for r in m.fluid_rows() {
                if r != g.row {
                    let e = (action[r] - physical_rhs[r]).abs();
                    p_error = p_error.max(e);
                    if e > 1e-10 * gross[r].max(1.) {
                        return Err(format!(
                            "Actual completed non-G border row{r} failed: {e:e}"
                        ));
                    }
                }
            }
            deadline()?;
            let mut v = original.clone();
            c.coordinates.transform(&mut v);
            c.energy.vector_to_solver(&mut v);
            v[g.row] = 0.125;
            unsafe { output(rv, n) }?.copy_from_slice(&v);
            checked(
                unsafe { jtsetup(0., sy, syp, zv, 1e12, user) },
                "Actual huge-cj JTsetup",
            )?;
            checked(
                unsafe {
                    jtimes(
                        0.,
                        sy,
                        syp,
                        zv,
                        rv,
                        zv,
                        1e12,
                        user,
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                },
                "Actual huge-cj JVP",
            )?;
            let expected = 1e12 * v[g.row] - c.work.complete_energy_rate_jvp()?;
            let huge_error = (unsafe { values(zv, n) }?[g.row] - expected).abs();
            if huge_error > 32. * f64::EPSILON * expected.abs().max(1.) {
                return Err(format!(
                    "Huge-cj direct unshifted G action failed: {huge_error:e}"
                ));
            }
            c.convergence.budget(started, 30.);
            let status = c
                .convergence
                .corrected_chart(&solver, &slope, &vec![0.; n], 1.)?;
            if status != 0 {
                return Err(format!(
                    "Actual current candidate closure refused: {status}"
                ));
            }
            m.evaluate(&y, &yp, Some(0.), &mut w)?;
            let mass_rows = [
                l.network_start + m.network.total_mass_row(),
                l.pressurizer_start + cp::LIQUID_MASS,
                l.pressurizer_start + cp::VAPOR_MASS,
                l.surge_start + finite_surge::MASS,
            ];
            let mass_rate = mass_rows
                .iter()
                .map(|&r| yp[r] - w.residual[r])
                .sum::<f64>();
            let boron_rows = (0..m.carrier.cells())
                .flat_map(|i| {
                    [
                        l.carrier_start + water_carrier::WIDTH * i + 1,
                        l.carrier_start + water_carrier::WIDTH * i + 2,
                    ]
                })
                .chain([
                    l.surge_carrier_start + 1,
                    l.surge_carrier_start + 2,
                    l.pool_carrier_start + 1,
                    l.pool_carrier_start + 2,
                ]);
            let boron_rate = boron_rows
                .map(|r| (yp[r] - w.residual[r]) / m.pressure_connection().atoms_per_marker)
                .sum::<f64>();
            if mass_rate.abs() > 1e-10 || boron_rate.abs() > 1e-10 {
                return Err(format!(
                    "Actual closed fluid/material RHS leak: {mass_rate:e}/{boron_rate:e}"
                ));
            }
            let hydraulic = w.surge.diagnostics()?;
            let flow = w.surge.receipts()?.mass;
            cases[case_index] = format!(
                "{{\"refinement\":{refinement},\"passed\":true,\"preparation\":{preparation_json},\"initialization\":{},\"initializationTrace\":{},\"energyVectorRoundtrip\":{roundtrip_json},\"freshHydraulicResidualPa\":{head:?},\"jointActualFlowKgS\":[{},{}],\"heightRateMPerS\":{},\"closedWaterRateKgPerS\":{mass_rate:e},\"closedBRateKgEquivalentPerS\":{boron_rate:e},\"fuelBinding\":{capture_json},\"fuelBindingErrorWeights\":{capture_weights_json},\"offInterfaceRHSIdentityErrorW\":{energy_error:e},\"unshiftedEnergyJVPIdentityError\":{unshifted_error:e},\"hugeCjEnergyActionError\":{huge_error:e},\"completedPNonGMaxError\":{p_error:e},\"onePSetupAndSolveSeconds\":{p_seconds},\"passiveHydraulicDissipationW\":{},\"kineticTemperatureEquivalentK\":{:?},\"currentCandidateFlowClosureRatio\":{}}}",
                ic.json(),
                trace.json(),
                flow[0],
                -flow[1],
                yp[l.pressurizer_start + cp::HEIGHT],
                hydraulic.passive_dissipation_w,
                hydraulic.kinetic_temperature_equivalent_k,
                c.convergence.max_converged_flow()
            );
            deadline()?;
        }
        Ok(())
    })();
    let elapsed = started.elapsed().as_secs_f64();
    let reason = result
        .as_ref()
        .err()
        .map_or("Complete actual entry proof without advancement", |e| {
            e.as_str()
        });
    let json = format!(
        "{{\"kind\":\"actual-pressure-entry-no-advancement\",\"passed\":{},\"elapsedSeconds\":{elapsed},\"allowanceSeconds\":30,\"IDASolveCalls\":0,\"reason\":{},\"cases\":[{}]}}",
        result.is_ok(),
        quote(reason),
        cases.join(",")
    );
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap();
    writeln!(file, "{json}").unwrap();
    file.sync_all().unwrap();
    println!("{json}");
    assert!(
        result.is_ok(),
        "Actual pressure entry refused; immutable receipt retained: {reason}"
    );
}

#[test]
#[ignore = "Explicit saved carrier3 global/local balance diagnostic; no IDASolve"]
fn archived_carrier_global_and_local_transport_without_advancement() {
    let started = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_CARRIER_REPORT").unwrap());
    let prepared =
        cooling_input::parse(&fs::read_to_string(directory.join("input.txt")).unwrap()).unwrap();
    let m = &prepared.model;
    let l = m.layout;
    let n = m.dimension();
    let nw = m.carrier.cells();
    let initial = m.initial_state().unwrap();
    let conversion = m
        .carrier
        .initial()
        .iter()
        .map(|p| p.boron10 + p.boron)
        .sum::<f64>()
        / (0..nw)
            .map(|i| initial[l.network_start + m.network.marker_row(i)])
            .sum::<f64>();
    let mut cases = Vec::new();
    for name in ["input.normal.checkpoint", "input.normal.unadmitted-raw"] {
        let bytes = fs::read(directory.join(name)).unwrap();
        assert_eq!(&bytes[..8], b"LDFBST01");
        assert_eq!(
            u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            n as u64
        );
        assert_eq!(bytes.len(), 24 + 16 * n);
        let time = f64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let all = bytes[24..]
            .chunks_exact(8)
            .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert!(all.iter().all(|x| x.is_finite()));
        let (y, yp) = all.split_at(n);
        let mut w = m.workspace();
        m.evaluate(y, yp, Some(1.), &mut w).unwrap();
        let marker = |i| l.network_start + m.network.marker_row(i);
        let b = |i| l.carrier_start + water_carrier::WIDTH * i + 1;
        let amounts = (0..nw)
            .map(|i| water_carrier::Amounts {
                hydrogen: y[b(i) - 1],
                boron10: y[b(i)],
                boron: y[b(i) + 1],
            })
            .collect::<Vec<_>>();
        let a = (0..nw)
            .map(|i| (y[b(i)] + y[b(i) + 1]) / conversion - y[marker(i)])
            .collect::<Vec<_>>();
        let mut rates = vec![water_carrier::Amounts::default(); nw];
        m.carrier
            .rates_into(
                &w.network.chart_mass,
                &amounts,
                &w.network.mass_flows,
                w.source.external_water_events().unwrap(),
                &mut rates,
            )
            .unwrap();
        let mut expected = vec![0.; nw];
        for (link, &q) in m.carrier.links().iter().zip(&w.network.mass_flows) {
            let donor = if q >= 0. { link.from } else { link.to };
            let flux = q * a[donor] / w.network.chart_mass[donor];
            expected[link.from] -= flux;
            expected[link.to] += flux;
        }
        let actual = (0..nw)
            .map(|i| {
                (rates[i].boron10 + rates[i].boron) / conversion
                    - w.network.rates[m.network.marker_row(i)]
            })
            .collect::<Vec<_>>();
        let rhs_error = actual
            .iter()
            .zip(&expected)
            .map(|(a, b)| (a - b).abs())
            .fold(0f64, f64::max);
        let mut d = vec![0.; n];
        d[l.network_start + m.network.pressure_row()] = 2.;
        for i in 0..nw {
            d[b(i)] = conversion * (i as f64 + 1.) * 1e-4;
            d[b(i) + 1] = -conversion * (i as f64) * 3e-5;
            d[marker(i)] = (i as f64) * 2e-5;
            d[l.network_start + m.network.temperature_row(i)] = 1e-3;
        }
        for e in 0..m.carrier.links().len() {
            d[l.network_start + m.network.flow_row(e)] = 1e-3;
        }
        m.jvp(&d, 1., &mut w).unwrap();
        let da = (0..nw)
            .map(|i| (d[b(i)] + d[b(i) + 1]) / conversion - d[marker(i)])
            .collect::<Vec<_>>();
        let mut expected_j = da.clone();
        for (e, (link, &q)) in m
            .carrier
            .links()
            .iter()
            .zip(&w.network.mass_flows)
            .enumerate()
        {
            let donor = if q >= 0. { link.from } else { link.to };
            let mass = w.network.chart_mass[donor];
            let partial = w.network.chart_derivatives[donor];
            let dm = partial[0] * 2. + partial[1] * 1e-3;
            let dq = d[l.network_start + m.network.flow_row(e)];
            let flux = dq * a[donor] / mass + q * (da[donor] / mass - a[donor] / mass * dm / mass);
            expected_j[link.from] += flux;
            expected_j[link.to] -= flux;
        }
        let j_error = (0..nw)
            .map(|i| {
                ((w.jvp[b(i)] + w.jvp[b(i) + 1]) / conversion - w.jvp[marker(i)] - expected_j[i])
                    .abs()
            })
            .fold(0f64, f64::max);
        let global_b = (0..nw)
            .map(|i| ((y[b(i)] - initial[b(i)]) + (y[b(i) + 1] - initial[b(i) + 1])) / conversion)
            .sum::<f64>();
        let global_rhs = rates
            .iter()
            .map(|p| (p.boron10 + p.boron) / conversion)
            .sum::<f64>();
        let global_j = (0..nw)
            .map(|i| (w.jvp[b(i)] + w.jvp[b(i) + 1] - d[b(i)] - d[b(i) + 1]) / conversion)
            .sum::<f64>();
        let local = a.iter().map(|x| x.abs()).fold(0f64, f64::max);
        let roundoff = (0..nw)
            .map(|i| {
                f64::EPSILON
                    * ((y[b(i)].abs() + y[b(i) + 1].abs()) / conversion + y[marker(i)].abs())
            })
            .fold(0f64, f64::max);
        assert!(global_b.abs() < 1e-8 && global_rhs.abs() < 1e-12 && global_j.abs() < 1e-12);
        assert!(
            rhs_error < 1e-12 && j_error < 1e-12,
            "{rhs_error:e} {j_error:e}"
        );
        cases.push(format!("{{\"frame\":{},\"time\":{time:e},\"globalBChangeKgEquivalent\":{global_b:e},\"maxLocalBMarkerDifferenceKg\":{local:e},\"singleOperationRoundoffScaleKg\":{roundoff:e},\"globalBRHSKgPerS\":{global_rhs:e},\"globalBJVPBalanceError\":{global_j:e},\"localUpwindRHSIdentityErrorKgPerS\":{rhs_error:e},\"localUpwindJVPIdentityError\":{j_error:e}}}",quote(name)));
    }
    let seconds = started.elapsed().as_secs_f64();
    assert!(seconds < 10.);
    let json = format!(
        "{{\"kind\":\"saved-carrier3-balance-no-advancement\",\"passed\":true,\"representativeCj\":1,\"actualStageCjAvailable\":false,\"elapsedSeconds\":{seconds},\"classification\":\"local-independent-tracer-disagreement-not-global-B-loss\",\"cases\":[{}]}}",
        cases.join(",")
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap();
    use std::io::Write;
    file.write_all(json.as_bytes()).unwrap();
    file.sync_all().unwrap();
    eprintln!("{json}");
}

// Saved-state diagnostic only. The callback bridge uses the SAME complete
// current JVP and owned frozen P as production; it never invokes IDASolve.
struct ChartLinear<'a> {
    callbacks: *mut Callbacks<'a>,
    y: Handle,
    yp: Handle,
    residual: Handle,
    cj: f64,
}
unsafe extern "C" fn chart_atimes(user: Handle, v: Handle, out: Handle) -> c_int {
    let a = unsafe { &mut *(user as *mut ChartLinear<'_>) };
    unsafe {
        jtimes(
            0.,
            a.y,
            a.yp,
            a.residual,
            v,
            out,
            a.cj,
            a.callbacks.cast(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    }
}
unsafe extern "C" fn chart_psolve(
    user: Handle,
    rhs: Handle,
    out: Handle,
    delta: f64,
    side: c_int,
) -> c_int {
    if side != 1 {
        return -1;
    }
    let a = unsafe { &mut *(user as *mut ChartLinear<'_>) };
    unsafe {
        psolve(
            0.,
            a.y,
            a.yp,
            a.residual,
            rhs,
            out,
            a.cj,
            delta,
            a.callbacks.cast(),
        )
    }
}
fn shared_chart(
    n: &operating_network::Network,
    w: &operating_network::Workspace,
) -> (f64, f64, f64, f64, Vec<f64>) {
    let rm = w.residual[n.pressure_row()];
    let mut compliance = 0.;
    let mut projected = rm;
    let mut contributions = Vec::new();
    for (i, &[mp, mt, ep, et]) in w.chart_derivatives.iter().enumerate() {
        compliance += mp - mt * ep / et;
        let value = mt / et * w.residual[n.temperature_row(i)];
        projected -= value;
        contributions.push(value);
    }
    let dp = projected / compliance;
    let dt = w
        .chart_derivatives
        .iter()
        .enumerate()
        .map(|(i, &[_, _, ep, et])| ((w.residual[n.temperature_row(i)] - ep * dp) / et).abs())
        .fold(0f64, f64::max);
    assert!([rm, compliance, projected, dp, dt]
        .iter()
        .all(|v| v.is_finite()));
    assert!(compliance > 0.);
    (rm, compliance, dp, dt, contributions)
}

#[test]
#[ignore = "Explicit two-frame barrel chart/linear diagnostic; no IDASolve"]
fn archived_barrel_chart_and_linear_correction_without_advancement() {
    barrel_chart_linear_diagnostic(false);
}
#[test]
#[ignore = "Explicit prepared/admitted/failed old-new linear-budget proof; no IDASolve"]
fn archived_barrel_closure_linear_budgets_without_advancement() {
    barrel_chart_linear_diagnostic(true);
}
fn barrel_chart_linear_diagnostic(candidate_proof: bool) {
    let started = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_CHART_REPORT").unwrap());
    assert!(
        !report.exists(),
        "Diagnostic evidence must not be overwritten"
    );
    let prepared =
        cooling_input::parse(&fs::read_to_string(directory.join("input.txt")).unwrap()).unwrap();
    let model = &prepared.model;
    let n = model.dimension();
    let network = &model.network;
    let l = model.layout;
    let accuracy = cooling_accuracy::Accuracy::new(model, &prepared.target_emissions).unwrap();
    let mut c = tests::callbacks(model);
    c.start = started;
    c.allowance = 30.;
    c.absolute = accuracy.absolute(1.).unwrap();
    c.absolute[c.energy.row] = EnergyCoordinates::absolute(n, 1.);
    // No current cj is retained in the failed receipt. This is deliberately
    // a held representative, NOT a replay of the unavailable FLC stage.
    let cj = 1.;
    let old_delta = 0.05 * 0.33 * (n as f64).sqrt();
    let deltas = if candidate_proof {
        vec![old_delta, cooling_convergence::LINEAR_L2_BUDGET]
    } else {
        vec![old_delta]
    };
    let mut resources = Resources::new().unwrap();
    let zero = vec![0.; n];
    let y = resources.vector(&zero).unwrap();
    let yp = resources.vector(&zero).unwrap();
    let r = resources.vector(&zero).unwrap();
    let rhs = resources.vector(&zero).unwrap();
    let x = resources.vector(&zero).unwrap();
    let pr = resources.vector(&zero).unwrap();
    let weights = resources.vector(&zero).unwrap();
    resources.spgmr(x, 30, 0).unwrap();
    let mut cases = Vec::new();
    let mut proof_passed = true;
    let mut names = vec!["input.normal.checkpoint", "input.normal.unadmitted-raw"];
    if candidate_proof {
        names.insert(0, "prepared-ORIGINAL");
    }
    for name in &names {
        let (time, all) = if *name == "prepared-ORIGINAL" {
            let physical = model.initial_state().unwrap();
            let mut slopes = vec![0.; n];
            let mut prepared_work = model.workspace();
            model
                .evaluate(&physical, &slopes, None, &mut prepared_work)
                .unwrap();
            for i in 0..n {
                if model.is_differential(i) {
                    slopes[i] = -prepared_work.residual[i];
                }
            }
            (0., physical.into_iter().chain(slopes).collect::<Vec<_>>())
        } else {
            let bytes = fs::read(directory.join(name)).unwrap();
            assert_eq!(&bytes[..8], b"LDFBST01");
            assert_eq!(
                u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
                n as u64
            );
            assert_eq!(bytes.len(), 24 + 16 * n);
            let time = f64::from_le_bytes(bytes[16..24].try_into().unwrap());
            let all = bytes[24..]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect::<Vec<_>>();
            (time, all)
        };
        assert!(all.iter().all(|v| v.is_finite()));
        let physical = &all[..n];
        let slopes = &all[n..];
        let mut solver = physical.to_vec();
        c.coordinates.transform(&mut solver);
        c.energy.state_to_solver(&mut solver);
        let mut solver_yp = slopes.to_vec();
        c.coordinates.transform(&mut solver_yp);
        c.energy.vector_to_solver(&mut solver_yp);
        unsafe { output(y, n) }.unwrap().copy_from_slice(&solver);
        unsafe { output(yp, n) }
            .unwrap()
            .copy_from_slice(&solver_yp);
        let user = (&mut c as *mut Callbacks<'_>).cast();
        assert_eq!(unsafe { residual(time, y, yp, r, user) }, 0);
        let f = unsafe { values(r, n) }.unwrap().to_vec();
        assert_eq!(unsafe { jtsetup(time, y, yp, r, cj, user) }, 0);
        let (rm, compliance, dp, dt, contributions) = shared_chart(network, &c.work.network);
        if name.ends_with("unadmitted-raw") {
            assert!(
                (dp - (-5.333785814256547)).abs() < 1e-9,
                "Archived raw state does not reproduce actual screen dp: {dp:e}"
            );
        }
        let chart_residuals = (0..network.config().water.len())
            .map(|i| c.work.network.residual[network.temperature_row(i)])
            .collect::<Vec<_>>();
        // Independent exact chart-row formula versus the complete composed JVP.
        let mut direction = vec![0.; n];
        direction[l.network_start + network.pressure_row()] = 100.;
        direction[l.network_start + network.total_mass_row()] = 1e-4;
        for i in 0..network.config().water.len() {
            direction[l.network_start + network.energy_row(i)] = 100. * (i % 3 + 1) as f64;
            direction[l.network_start + network.temperature_row(i)] = 1e-3 * ((i % 3) as f64 - 1.);
        }
        model.jvp(&direction, cj, &mut c.work).unwrap();
        let mut expected = vec![(
            network.pressure_row(),
            direction[l.network_start + network.total_mass_row()],
            direction[l.network_start + network.total_mass_row()].abs(),
        )];
        for (i, &[mp, mt, ep, et]) in c.work.network.chart_derivatives.iter().enumerate() {
            let p = direction[l.network_start + network.pressure_row()];
            let t = direction[l.network_start + network.temperature_row(i)];
            expected[0].1 -= mp * p + mt * t;
            expected[0].2 += (mp * p).abs() + (mt * t).abs();
            let e = direction[l.network_start + network.energy_row(i)];
            expected.push((
                network.temperature_row(i),
                e - ep * p - et * t,
                e.abs() + (ep * p).abs() + (et * t).abs(),
            ));
        }
        let mut action_error = 0f64;
        for &(row, expected, gross) in &expected {
            let error = (c.work.jvp[l.network_start + row] - expected).abs();
            action_error = action_error.max(error / gross.max(1e-30));
            assert!(error <= 2048. * f64::EPSILON * gross);
        }
        let mut fd_errors = Vec::new();
        let mut probe = model.workspace();
        for h in [1., 0.5] {
            let plus = physical
                .iter()
                .zip(&direction)
                .map(|(&v, &d)| v + h * d)
                .collect::<Vec<_>>();
            let minus = physical
                .iter()
                .zip(&direction)
                .map(|(&v, &d)| v - h * d)
                .collect::<Vec<_>>();
            model.evaluate(&plus, slopes, None, &mut probe).unwrap();
            let fp = expected
                .iter()
                .map(|&(row, _, _)| probe.residual[l.network_start + row])
                .collect::<Vec<_>>();
            model.evaluate(&minus, slopes, None, &mut probe).unwrap();
            let mut max = 0f64;
            for (k, &(row, exact, gross)) in expected.iter().enumerate() {
                let fm = probe.residual[l.network_start + row];
                let error = ((fp[k] - fm) / (2. * h) - exact).abs();
                max = max.max(error / gross.max(1e-30));
                // Explicit state-subtraction roundoff plus directional
                // truncation, not a new physical or solve admission screen.
                let noise = 64.
                    * f64::EPSILON
                    * (fp[k].abs()
                        + fm.abs()
                        + if k == 0 {
                            physical[l.network_start + network.total_mass_row()].abs()
                        } else {
                            physical[l.network_start + network.energy_row(k - 1)].abs()
                        })
                    / h;
                assert!(
                    error <= 2e-5 * gross + noise,
                    "Chart FD row {row}: {error:e}"
                );
            }
            fd_errors.push(max);
        }
        // Return to exactly this saved trial after FD; P has its own snapshot.
        assert_eq!(unsafe { jtsetup(time, y, yp, r, cj, user) }, 0);
        assert_eq!(unsafe { psetup(time, y, yp, r, cj, user) }, 0);
        assert_eq!(unsafe { error_weights(y, weights, user) }, 0);
        for &delta in &deltas {
            unsafe { output(rhs, n) }
                .unwrap()
                .iter_mut()
                .zip(&f)
                .for_each(|(b, &f)| *b = -f);
            assert_eq!(
                unsafe { psolve(time, y, yp, r, rhs, pr, cj, delta, user) },
                0
            );
            let w = unsafe { values(weights, n) }.unwrap().to_vec();
            let pre = unsafe { values(pr, n) }.unwrap().to_vec();
            let norm = pre.iter().zip(&w).fold(0f64, |s, (&v, &w)| s.hypot(v * w));
            let pressure_correction = pre[l.network_start + network.pressure_row()];
            let mut bridge = ChartLinear {
                callbacks: &mut c,
                y,
                yp,
                residual: r,
                cj,
            };
            let linear_user = (&mut bridge as *mut ChartLinear<'_>).cast();
            checked(
                unsafe { SUNLinSolSetATimes(resources.solver, linear_user, chart_atimes) },
                "Diagnostic current complete JVP",
            )
            .unwrap();
            checked(
                unsafe {
                    SUNLinSolSetPreconditioner(resources.solver, linear_user, None, chart_psolve)
                },
                "Diagnostic frozen P",
            )
            .unwrap();
            checked(
                unsafe { SUNLinSolSetScalingVectors(resources.solver, weights, weights) },
                "Diagnostic production scales",
            )
            .unwrap();
            checked(
                unsafe { SUNLinSolInitialize(resources.solver) },
                "Diagnostic SPGMR init",
            )
            .unwrap();
            unsafe { output(x, n) }.unwrap().fill(0.);
            checked(
                unsafe { SUNLinSolSetZeroGuess(resources.solver, 1) },
                "Diagnostic zero guess",
            )
            .unwrap();
            let began = Instant::now();
            let status =
                unsafe { SUNLinSolSolve(resources.solver, ptr::null_mut(), x, rhs, delta) };
            let solve_seconds = began.elapsed().as_secs_f64();
            assert!(c.fatal.is_none(), "{:?}", c.fatal);
            let iterations = unsafe { SUNLinSolNumIters(resources.solver) };
            let reported_norm = unsafe { SUNLinSolResNorm(resources.solver) };
            assert_eq!(unsafe { chart_atimes(linear_user, x, r) }, 0);
            let action = unsafe { values(r, n) }.unwrap().to_vec();
            let b = unsafe { values(rhs, n) }.unwrap();
            unsafe { output(r, n) }
                .unwrap()
                .iter_mut()
                .zip(b.iter().zip(&action))
                .for_each(|(r, (&b, &a))| *r = b - a);
            assert_eq!(unsafe { chart_psolve(linear_user, r, pr, delta, 1) }, 0);
            let true_norm = unsafe { values(pr, n) }
                .unwrap()
                .iter()
                .zip(&w)
                .fold(0f64, |s, (&v, &w)| s.hypot(v * w));
            let mut correction = vec![0.; n];
            c.coordinates
                .physical(unsafe { values(x, n) }.unwrap(), &mut correction);
            c.energy.vector_to_physical(&mut correction);
            let candidate = physical
                .iter()
                .zip(&correction)
                .map(|(&v, &d)| v + d)
                .collect::<Vec<_>>();
            let candidate_slopes = slopes
                .iter()
                .zip(&correction)
                .map(|(&v, &d)| v + cj * d)
                .collect::<Vec<_>>();
            model
                .evaluate(&candidate, &candidate_slopes, None, &mut probe)
                .unwrap();
            let (_, _, after_dp, after_dt, _) = shared_chart(network, &probe.network);
            let charts = operating_admission::chart_corrections(
                network,
                &probe.network,
                &candidate[l.network_start..l.carrier_start],
            )
            .unwrap();
            let chart_passed = charts.check().is_ok();
            let guard_started = Instant::now();
            let guard_status = c
                .convergence
                .corrected_chart(&solver, &solver_yp, unsafe { values(x, n) }.unwrap(), cj)
                .unwrap();
            let guard_seconds = guard_started.elapsed().as_secs_f64();
            assert_eq!(
                guard_status == 0,
                chart_passed,
                "Actual current-candidate guard disagrees with independent full-model chart"
            );
            if candidate_proof && delta == cooling_convergence::LINEAR_L2_BUDGET {
                proof_passed &= status == 0 && true_norm <= delta && chart_passed;
            }
            cases.push(format!("{{\"frame\":{},\"time\":{},\"linearDelta\":{},\"currentCandidateChartPassed\":{chart_passed},\"actualGuardStatus\":{guard_status},\"actualGuardSeconds\":{guard_seconds},\"stateProvenance\":{},\"massResidualKg\":{},\"complianceKgPerPa\":{},\"sharedPressureCorrectionPa\":{},\"maximumTemperatureCorrectionK\":{},\"energyChartResidualsJ\":{},\"energyProjectedMassContributionsKg\":{},\"exactJVPContributorRelativeError\":{},\"centralFDContributorRelativeErrors\":{},\"scaledPreconditionedNegativeFNorm\":{},\"PPressureCorrectionPa\":{},\"SPGMRStatus\":{status},\"SPGMRIterations\":{iterations},\"SPGMRReportedNorm\":{},\"independentScaledPreconditionedResidualNorm\":{},\"solveSeconds\":{},\"correctedCandidateChartPressurePa\":{},\"correctedCandidateChartTemperatureK\":{}}}",
            quote(name),finite(time),finite(delta),quote(if *name=="prepared-ORIGINAL" {"fresh-prepared-no-IDACalcIC"} else if name.ends_with("checkpoint") {"admitted-retained-polynomial-yp"} else {"archived-unadmitted-raw-stage;dp-reproduced-not-a-retained-failed-endpoint-claim"}),finite(rm),finite(compliance),finite(dp),finite(dt),numbers(&chart_residuals),numbers(&contributions),finite(action_error),numbers(&fd_errors),finite(norm),finite(pressure_correction),finite(reported_norm),finite(true_norm),finite(solve_seconds),finite(after_dp),finite(after_dt)));
            assert!(started.elapsed().as_secs_f64() < 28.57);
        }
    }
    let json = format!(
        "{{\"kind\":\"saved-barrel-shared-chart-linear-diagnostic\",\"passed\":{proof_passed},\"IDASolveCalls\":0,\"frames\":{},\"dimension\":{n},\"cj\":{cj},\"cjScope\":\"held-representative-not-actual;receipt-does-not-retain-current-cj\",\"linearDeltas\":{},\"linearSettings\":\"old-sqrt(n)-control-and-declared-factor1-candidate;maxl30;restart0;zero-guess;same-current-full-JVP-and-frozen-P\",\"seconds\":{},\"costs\":{},\"cases\":[{}]}}",
        names.len(),
        numbers(&deltas),
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
    assert!(
        proof_passed,
        "Held candidate linear/chart proof refused; receipt retained"
    );
}
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
            assert_eq!(&bytes[..8], b"LDFBST01");
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
        assert!(
            c.energy_p
                .unit()
                .iter()
                .all(|&(row, _)| row >= model.layout.network_start
                    && row < model.layout.carrier_start)
        );
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
            if row < model.layout.network_start || row >= model.layout.carrier_start {
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
            assert_eq!(&bytes[..8], b"LDFBCM01");
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
            assert_eq!(&bytes[..8], b"LDFBST01");
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
    energy.push(l.barrel_energy);
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
        assert_eq!(&bytes[..8], b"LDFBST01");
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
        let rhs_identity = sum(&internal) + sum(&walls) + sum(&thermal) - fuel
            + sum(work.barrel.water_heat().unwrap())
            + work.barrel.heat_rate().unwrap()
            - work.barrel.emitted_rate().unwrap()
            + work.barrel.export_rate().unwrap();
        let mut drift = energy
            .iter()
            .map(|&r| y[r] - initial[r])
            .collect::<Vec<_>>();
        drift.push(-(y[release] - initial[release]));
        drift.push(-(y[l.barrel_released] - initial[l.barrel_released]));
        drift.push(y[l.barrel_exported] - initial[l.barrel_exported]);
        let mut yp_terms = energy.iter().map(|&r| yp[r]).collect::<Vec<_>>();
        yp_terms.push(-yp[release]);
        yp_terms.push(-yp[l.barrel_released]);
        yp_terms.push(yp[l.barrel_exported]);
        let mut residual_terms = energy.iter().map(|&r| work.residual[r]).collect::<Vec<_>>();
        residual_terms.push(-work.residual[release]);
        residual_terms.push(-work.residual[l.barrel_released]);
        residual_terms.push(work.residual[l.barrel_exported]);
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
        action_terms.push(-work.jvp[l.barrel_released]);
        action_terms.push(work.jvp[l.barrel_exported]);
        let mut expected_terms = energy.iter().map(|&r| direction[r]).collect::<Vec<_>>();
        expected_terms.push(-direction[release]);
        expected_terms.push(-direction[l.barrel_released]);
        expected_terms.push(direction[l.barrel_exported]);
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

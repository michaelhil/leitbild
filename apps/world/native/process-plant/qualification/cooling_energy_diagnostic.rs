use super::*;

#[test]
#[ignore = "Explicit actual twelve-frame finite ACT/PRHR nuclear heat entry proof; no IDASolve; 30 s total"]
fn actual_prhr_entry_without_advancement() {
    let started = Instant::now();
    let directory = PathBuf::from(std::env::var("LEITBILD_COOLING_DIAGNOSTIC_ARTIFACTS").unwrap());
    let report = PathBuf::from(std::env::var("LEITBILD_COOLING_PRESSURE_REPORT").unwrap());
    let deadline = || {
        if started.elapsed().as_secs_f64() < 30. {
            Ok(())
        } else {
            Err("Actual PRHR entry exceeded30s total".to_string())
        }
    };
    let mut cases = Vec::new();
    let result = (|| -> Result<(), String> {
        let prepared = cooling_input::parse(
            &fs::read_to_string(directory.join("input.txt")).map_err(|e| e.to_string())?,
        )?;
        let m = &prepared.model;
        let n = m.dimension();
        let base = m.layout.network_start;
        let p = m
            .network
            .prhr()
            .ok_or("Actual entry requires selected PRHR apparatus")?;
        let schedule = PrhrSchedule::new(m, prepared.prhr_action, prepared.actuation.as_ref())?
            .ok_or("Missing retained PRHR mechanism")?;
        let input = schedule.input(0., 0.)?;
        let initial = m.initial_state_with_prhr_input(Some(input))?;
        let accuracy = cooling_accuracy::Accuracy::new(m, &prepared.target_emissions, Some(input))?;
        let g = EnergyCoordinates::new(m, &initial)?;
        for refinement in [1., 10.] {
            deadline()?;
            let case = cases.len();
            cases.push(format!("{{\"refinement\":{refinement},\"passed\":false,\"completedStage\":\"prepared-original-stocks\"}}"));
            let mut y = initial.clone();
            let mut yp = vec![0.; n];
            let mut w = m.workspace();
            let absolute = accuracy.absolute(refinement)?;
            let mut trace = cooling_initial::Trace::default();
            let init = cooling_initial::initialize(
                m,
                &mut y,
                &mut yp,
                &absolute,
                &mut w,
                started,
                30.,
                1e-5 / refinement,
                &mut trace,
                Some(input),
            );
            if let Err(e) = &init {
                cases[case]=format!("{{\"refinement\":{refinement},\"passed\":false,\"completedStage\":\"joint-original-entry\",\"reason\":{},\"initializationTrace\":{}}}",quote(e),trace.json());
            }
            let init = init?;
            cases[case]=format!("{{\"refinement\":{refinement},\"passed\":false,\"completedStage\":\"joint-fixed-stock-initialization\",\"initialization\":{},\"initializationTrace\":{}}}",init.json(),trace.json());
            for row in 0..n {
                if m.is_differential(row) && y[row].to_bits() != initial[row].to_bits() {
                    return Err(format!(
                        "Actual PRHR entry changed differential owner row{row}"
                    ));
                }
            }
            deadline()?;
            m.evaluate_with_prhr_input(&y, &yp, Some(0.), &mut w, Some(input))?;
            m.validate_accepted(&y, &w)?;
            accuracy.prhr_ledgers(m, &y)?;
            accuracy.carrier_ledger(m, &y)?;
            schedule.audit(0., &y)?;
            let charts = operating_admission::chart_corrections(
                &m.network,
                &w.network,
                &y[base..m.layout.carrier_start],
            )?;
            charts.check()?;
            let mut chart_rates = vec![0.; n];
            m.visit_fluid_jacobian(&w, |r, c, v| chart_rates[r] += v * yp[c])?;
            let mut max_forward = 0_f64;
            for row in m.forward_chart_rows() {
                max_forward = max_forward.max(chart_rates[row].abs());
            }
            // Independent complete physical energy-coordinate assembly includes
            // finite WST/ROOM and every signed support/boundary receipt.
            let independent = g.balance(&yp) - g.balance(&w.residual);
            let energy_rate = w.complete_energy_rate()?;
            let mut weighted = m
                .installed_energy_rows()
                .map(|r| (r, 1.))
                .collect::<Vec<_>>();
            weighted.extend([
                (m.source.fuel_release_row(), -1.),
                (m.layout.barrel_released, -1.),
                (m.layout.barrel_exported, 1.),
                (m.layout.ambient_exported, 1.),
                (m.layout.fuel_capture_exported, 1.),
                (m.layout.mobile_capture_exported, 1.),
                (m.layout.mobile_capture_boundary_exported, 1.),
            ]);
            weighted.extend(m.capture_paid_rows().map(|(r, q)| (r, -q)));
            weighted.extend(m.mobile_capture_paid_rows().map(|(r, q)| (r, -q)));
            weighted.extend(p.receipt_rows().map(|(r, s)| (base + r, s)));
            let gross = weighted
                .iter()
                .map(|&(r, s)| s.abs() * (yp[r].abs() + w.residual[r].abs()))
                .sum::<f64>();
            let balance_error = (independent - energy_rate).abs();
            if balance_error > 1e-6 + 4096. * f64::EPSILON * gross {
                return Err(format!(
                    "Actual PRHR independent energy RHS mismatch {balance_error}"
                ));
            }
            let mobile_json = cooling_mobile::entry_receipt(m, &w, &yp)?;
            let q = p.layout;
            // Exercise the actual reciprocal volume-work Fyp, not an identity
            // differential mask substituted for the composed finite pool.
            let mut rate_direction = vec![0.; n];
            rate_direction[base + q.wst_start + 3] = 1e-7;
            let mut matrix_action = vec![0.; n];
            m.visit_fluid_rate_matrix(&w, |r, c, v| matrix_action[r] += v * rate_direction[c])?;
            let mut changed_yp = yp.clone();
            for i in 0..n {
                changed_yp[i] += rate_direction[i];
            }
            let mut shifted = m.workspace();
            m.evaluate_with_prhr_input(&y, &changed_yp, None, &mut shifted, Some(input))?;
            let mut fyp_error = 0_f64;
            for row in m.fluid_rows() {
                let d = shifted.residual[row] - w.residual[row];
                let error = (d - matrix_action[row]).abs();
                fyp_error = fyp_error.max(error);
                if error
                    > 1e-6
                        + 4096.
                            * f64::EPSILON
                            * (shifted.residual[row].abs()
                                + w.residual[row].abs()
                                + matrix_action[row].abs())
                {
                    return Err(format!("Actual PRHR Fyp row{row} mismatch {error}"));
                }
            }
            let cj = 3.;
            let mut jvp_ratio = 0_f64;
            let mut probe_ratios = Vec::new();
            // Exact zero-contrast film derivatives are independently proved in
            // shared-law tests. Partition assembly coverage without a numerical
            // near-zero classifier: first pool/ROOM/receipts, then every actual
            // liquid film at bulk minus0.1K. No differential stock changes or
            // acceptance of these off-equilibrium algebraic trial coordinates.
            for probe in 0..2 {
                let mut trial = y.clone();
                if probe == 1 {
                    for (i, c) in p.config.liquid_contacts.iter().enumerate() {
                        trial[base + q.surface_start + i] =
                            trial[base + m.network.temperature_row(c.water)] - 0.1;
                    }
                }
                m.evaluate_with_prhr_input(&trial, &yp, Some(cj), &mut w, Some(input))?;
                let mut direction = vec![0.; n];
                for row in q.wst_start..q.dimension {
                    direction[base + row] =
                        absolute[base + row] * 0.25 * if row % 2 == 0 { 1. } else { -1. };
                }
                for i in 0..p.config.liquid_contacts.len() {
                    let row = base + q.surface_start + i;
                    if probe == 0 {
                        direction[row] = 0.;
                    }
                }
                if probe == 1 {
                    for row in 0..n {
                        if row < base + q.surface_start
                            || row >= base + q.surface_start + p.config.liquid_contacts.len()
                        {
                            direction[row] = 0.;
                        }
                    }
                }
                m.jvp(&direction, cj, &mut w)?;
                let analytic = w.jvp.clone();
                let h = 0.25;
                let mut plus = trial.clone();
                let mut minus = trial.clone();
                let mut pp = yp.clone();
                let mut mp = yp.clone();
                for i in 0..n {
                    plus[i] += h * direction[i];
                    minus[i] -= h * direction[i];
                    pp[i] += h * cj * direction[i];
                    mp[i] -= h * cj * direction[i];
                }
                let mut wp = m.workspace();
                let mut wm = m.workspace();
                m.evaluate_with_prhr_input(&plus, &pp, None, &mut wp, Some(input))?;
                m.evaluate_with_prhr_input(&minus, &mp, None, &mut wm, Some(input))?;
                let mut this_ratio = 0_f64;
                let mut worst_jvp = String::new();
                for row in m.fluid_rows() {
                    let fd = (wp.residual[row] - wm.residual[row]) / (2. * h);
                    let scale = 1e-6
                        + 0.001 * analytic[row].abs().max(fd.abs())
                        + 128. * f64::EPSILON * (wp.residual[row].abs() + wm.residual[row].abs())
                            / h;
                    let ratio = (fd - analytic[row]).abs() / scale;
                    if ratio > this_ratio || !ratio.is_finite() {
                        this_ratio = ratio;
                        let local = row.checked_sub(base);
                        let identity = local.map_or_else(
                            || "outside-network".to_string(),
                            |r| {
                                if r >= q.wst_start && r < q.wst_start + 4 {
                                    format!(
                                        "WST.{}",
                                        ["mass", "energy", "temperature-chart", "volume-chart"]
                                            [r - q.wst_start]
                                    )
                                } else if r == q.room_energy {
                                    "ROOM.A.energy".into()
                                } else if r >= q.surface_start && r < q.spring_released {
                                    format!("PRHR.surface-temperature.{}", r - q.surface_start)
                                } else if r >= q.spring_released && r < q.dimension {
                                    format!("PRHR.receipt.{}", r - q.spring_released)
                                } else {
                                    format!("network.row.{r}")
                                }
                            },
                        );
                        worst_jvp = format!("{{\"globalRow\":{row},\"identity\":{},\"analytic\":{},\"finiteDifference\":{},\"plusResidual\":{},\"minusResidual\":{},\"denominator\":{},\"step\":{h},\"ratio\":{}}}",quote(&identity),finite(analytic[row]),finite(fd),finite(wp.residual[row]),finite(wm.residual[row]),finite(scale),finite(ratio));
                    }
                }
                if !this_ratio.is_finite() || this_ratio > 1. {
                    let directions = (q.wst_start..q.dimension).map(|r| {
                    let row=base+r;
                    format!("{{\"globalRow\":{row},\"prhrLocalRow\":{},\"state\":{},\"direction\":{},\"plusActualDelta\":{},\"minusActualDelta\":{}}}",r-q.wst_start,finite(trial[row]),finite(direction[row]),finite(plus[row]-trial[row]),finite(minus[row]-trial[row]))
                }).collect::<Vec<_>>().join(",");
                    cases[case]=format!("{{\"refinement\":{refinement},\"passed\":false,\"completedStage\":\"same-trial-JVP-finite-difference\",\"probe\":{probe},\"initialization\":{},\"initializationTrace\":{},\"worstDirectionalRow\":{},\"directions\":[{}]}}",init.json(),trace.json(),worst_jvp,directions);
                    return Err(format!(
                        "Actual PRHR CSC/JVP directional check probe{probe} ratio {this_ratio}"
                    ));
                }
                jvp_ratio = jvp_ratio.max(this_ratio);
                probe_ratios.push(this_ratio);
                deadline()?;
            }
            deadline()?;
            let mut pre = cooling_block::Preconditioner::new(m, &y, &yp, Some(input))?;
            pre.setup(m, &y, &yp, cj, Some(input))?;
            let mut rhs = vec![0.; n];
            for row in q.wst_start..q.dimension {
                rhs[base + row] = absolute[base + row] * 0.25;
            }
            let mut solution = vec![0.; n];
            pre.solve(m, &rhs, &mut solution)?;
            m.evaluate_with_prhr_input(&y, &yp, Some(cj), &mut w, Some(input))?;
            m.jvp(&solution, cj, &mut w)?;
            let mut p_scaled_residual = 0_f64;
            for row in m.fluid_rows() {
                p_scaled_residual =
                    p_scaled_residual.max((w.jvp[row] - rhs[row]).abs() / absolute[row]);
            }
            if !p_scaled_residual.is_finite() {
                return Err("Nonfinite actual PRHR approximate-P scaled residual".into());
            }
            let current = w
                .network
                .prhr
                .as_ref()
                .ok_or("Missing actual PRHR diagnostic workspace")?;
            let room_rate_defect = yp[base + q.room_energy] - w.residual[base + q.room_energy]
                + yp[base + q.room_ambient_exported]
                - w.residual[base + q.room_ambient_exported]
                - yp[base + q.electrical_received]
                + w.residual[base + q.electrical_received]
                - yp[base + q.spring_released]
                + w.residual[base + q.spring_released];
            if room_rate_defect.abs() > 1e-6 {
                return Err(format!(
                    "Actual finite ROOM.A rate first law leak {room_rate_defect} W"
                ));
            }
            cases[case]=format!("{{\"refinement\":{refinement},\"passed\":true,\"mobileBinding\":{mobile_json},\"allDifferentialStockBitsPreserved\":true,\"initialization\":{},\"initializationTrace\":{},\"actualOpening\":{},\"springReleaseRateW\":{},\"finiteRoomEnergyJ\":{},\"finitePoolMassKg\":{},\"finitePoolEnergyJ\":{},\"poolHeatReceiptW\":{},\"surfaceWorkExportW\":{},\"connectorExportW\":{},\"poolChartCorrections\":{:?},\"filmChartCorrectionK\":{},\"forwardRateResidualMixedUnits\":{},\"independentEnergyRHSIdentityErrorW\":{},\"reciprocalVolumeWorkFypErrorW\":{},\"sameTrialJVPFiniteDifferenceRatio\":{},\"jvpProbeRatios\":{:?},\"jvpProbeScopes\":[\"initialized finite-pool ROOM receipts; all liquid surfaces unperturbed\",\"each actual liquid surface at its bulk minus0.1K; differential stocks unchanged; unaccepted trial only\"],\"approximatePScaledFluidResidualDiagnostic\":{},\"approximatePScope\":\"finite-same-trial-preconditioner-response;not-exact-inverse-or-convergence-certificate\"}}",
                init.json(),trace.json(),finite(input.opening),finite(current.spring_release_w),finite(y[base+q.room_energy]),
                finite(y[base+q.wst_start]),finite(y[base+q.wst_start+1]),finite(current.pool_heat_w),finite(current.wst.gas_export_rate_w),
                finite(current.connector_export_w),charts.pool,finite(charts.surface_temperature),finite(max_forward),finite(balance_error),
                finite(fyp_error),finite(jvp_ratio),probe_ratios,finite(p_scaled_residual));
            deadline()?;
        }
        Ok(())
    })();
    let reason = result.as_ref().err().map_or(
        "Actual PRHR original entry proved; no advancement",
        String::as_str,
    );
    let json=format!("{{\"kind\":\"actual-prhr-entry-no-advancement\",\"passed\":{},\"elapsedSeconds\":{},\"allowanceSeconds\":30,\"IDASolveCalls\":0,\"reason\":{},\"cases\":[{}]}}",result.is_ok(),finite(started.elapsed().as_secs_f64()),quote(reason),cases.join(","));
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
        "Actual PRHR entry refused; immutable result retained: {reason}"
    );
}

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
            l.mobile_capture_exported,
            l.mobile_capture_boundary_exported,
        ])
        .map(|r| (r, 1.))
        .chain(model.capture_paid_rows())
        .chain(model.mobile_capture_paid_rows())
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
#[ignore = "Explicit actual eleven-frame pressure and nuclear-binding entry proof, PRHR disabled; no IDASolve; 30 s maximum"]
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
        let accuracy = cooling_accuracy::Accuracy::new(m, &prepared.target_emissions, None)?;
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
                None,
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
                    "Actual fuel-binding entry cannot have negative accepted nuclear power".into(),
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
            let (capture_outputs, capture_gradients, capture_nonzero_gradients) =
                c.capture_weights.structure();
            if capture_nonzero_gradients == 0 {
                return Err("Fresh fuel-binding entry lost current source response support".into());
            }
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
            let mobile_json = cooling_mobile::entry_receipt(m, &w, &yp)?;
            cases[case_index] = format!(
                "{{\"refinement\":{refinement},\"passed\":true,\"mobileBinding\":{mobile_json},\"preparation\":{preparation_json},\"initialization\":{},\"initializationTrace\":{},\"energyVectorRoundtrip\":{roundtrip_json},\"freshHydraulicResidualPa\":{head:?},\"jointActualFlowKgS\":[{},{}],\"heightRateMPerS\":{},\"closedWaterRateKgPerS\":{mass_rate:e},\"closedBRateKgEquivalentPerS\":{boron_rate:e},\"fuelBinding\":{capture_json},\"fuelBindingErrorWeights\":{capture_weights_json},\"offInterfaceRHSIdentityErrorW\":{energy_error:e},\"unshiftedEnergyJVPIdentityError\":{unshifted_error:e},\"hugeCjEnergyActionError\":{huge_error:e},\"completedPNonGMaxError\":{p_error:e},\"onePSetupAndSolveSeconds\":{p_seconds},\"passiveHydraulicDissipationW\":{},\"kineticTemperatureEquivalentK\":{:?},\"currentCandidateFlowClosureRatio\":{}}}",
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

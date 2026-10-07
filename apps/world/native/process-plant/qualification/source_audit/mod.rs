//! Nonadvancing proof/cost check on a retained actual source state. No IDA
//! trajectory, accepted-state projection, physics substitution or readiness.
use super::*;

fn identity(defect: f64, scale: f64, what: &str) -> Result<(), String> {
    if !defect.is_finite()
        || !scale.is_finite()
        || defect.abs() > 256. * f64::EPSILON * scale.max(1e-30)
    {
        return Err(format!("{what}: defect={defect:e}, scale={scale:e}"));
    }
    Ok(())
}
fn event_identity(defect: f64, scale: f64, what: &str) -> Result<(), String> {
    if !defect.is_finite() || !scale.is_finite() || defect.abs() > 1e-10 * scale.max(1e-30) {
        return Err(format!("{what}: defect={defect:e}, scale={scale:e}"));
    }
    Ok(())
}

pub(super) fn audit(model: &Evolution, path: &str, cj: f64) -> Result<(), String> {
    if !cj.is_finite() || cj <= 0. {
        return Err("Invalid audited stage coefficient".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let n = model.state_count();
    if bytes.len() != 33 + 16 * n
        || &bytes[..9] != b"LDSOURCE1"
        || u64::from_le_bytes(bytes[9..17].try_into().unwrap()) != n as u64
    {
        return Err("Wrong retained source checkpoint format/dimension".into());
    }
    let time = f64::from_le_bytes(bytes[17..25].try_into().unwrap());
    let state = bytes[33..33 + n * 8]
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect::<Vec<_>>();
    let yp = bytes[33 + n * 8..]
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect::<Vec<_>>();
    if !time.is_finite() || yp.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite retained checkpoint".into());
    }
    // This state was refused by the old integrated ledger. Its physical
    // domains, derivative and independent defect remain evidence, not fixed.
    model.validate_accepted_state(&state)?;
    let old_balance = model.conservation(&state).map_err(str::to_owned)?;
    let old_slope = model.conservation(&yp).map_err(str::to_owned)?;
    let mut cases = vec![("original", model.initial_state()), ("failed", state)];
    let mut changed = cases[1].1.clone();
    changed[model.target_row(0)] += 1e-3;
    cases.push(("changed-progress", changed));
    let mut work = model.workspace();
    for (name, y) in cases {
        model.validate_accepted_state(&y)?;
        let begin = Instant::now();
        model.evaluate_into(&y, &mut work).map_err(str::to_owned)?;
        let fresh_seconds = begin.elapsed().as_secs_f64();
        let r = work.rates().map_err(str::to_owned)?.to_vec();
        let b = model.conservation(&r).map_err(str::to_owned)?;
        // Use the existing independent gross-event screen, not a roundoff
        // bound on already cancelled net rates. Internal event arithmetic
        // has a much larger scale than the resulting stock derivatives.
        event_identity(
            b.neutron_ledger_defect,
            work.diagnostics()
                .map_err(str::to_owned)?
                .neutron_event_scale_s,
            "RHS number",
        )?;
        identity(
            b.energy_ledger_defect_j,
            b.energy_ledger_scale_j,
            "RHS selected energy",
        )?;
        let start = Instant::now();
        for _ in 0..8 {
            model.evaluate_into(&y, &mut work).map_err(str::to_owned)?;
        }
        let reuse_seconds = start.elapsed().as_secs_f64() / 8.;
        // Signed perturbations of every coordinate, not just a source-only
        // vector. Scaled to actual reached values without changing the state.
        let direction = y
            .iter()
            .enumerate()
            .map(|(i, v)| 0.03 * ((i % 11) as f64 - 5.) * (1. + v.abs()))
            .collect::<Vec<_>>();
        let start = Instant::now();
        for _ in 0..8 {
            model
                .jvp_into(&direction, &mut work)
                .map_err(str::to_owned)?;
        }
        let jvp_seconds = start.elapsed().as_secs_f64() / 8.;
        let tangent = work.rate_jvp().map_err(str::to_owned)?.to_vec();
        let b = model.conservation(&tangent).map_err(str::to_owned)?;
        event_identity(
            b.neutron_ledger_defect,
            tangent[..model.nc_dimension()]
                .iter()
                .map(|v| v.abs())
                .sum::<f64>()
                + tangent[model.ledger_row()].abs(),
            "JVP number",
        )?;
        identity(
            b.energy_ledger_defect_j,
            b.energy_ledger_scale_j,
            "JVP selected energy",
        )?;
        let mut p = Preconditioner::new(model)?;
        let start = Instant::now();
        p.setup(model, &y, cj, ptr::null_mut(), start, 0.)?;
        let setup_seconds = start.elapsed().as_secs_f64();
        let mut vectors = Resources::new()?;
        let rhs = vectors.vector(&direction)?;
        let result = vectors.vector(&vec![0.; n])?;
        let start = Instant::now();
        for _ in 0..8 {
            p.solve(model, rhs, result)?;
        }
        let p_seconds = start.elapsed().as_secs_f64() / 8.;
        let x = unsafe { values(result, n) }?.to_vec();
        let coordinates = Coordinates {
            nc: model.nc_dimension(),
            ledger: model.ledger_row(),
        };
        let mut transformed_rhs = direction.clone();
        coordinates.transform(&mut transformed_rhs);
        let tr = vectors.vector(&transformed_rhs)?;
        p.solve_solver_coordinates(model, tr, result)?;
        let transformed_solution = unsafe { values(result, n) }?;
        let mut expected = x.clone();
        coordinates.transform(&mut expected);
        let transform_scale =
            x.iter().map(|v| v.abs()).sum::<f64>() + direction.iter().map(|v| v.abs()).sum::<f64>();
        for (a, b) in transformed_solution.iter().zip(&expected) {
            identity(a - b, transform_scale, "Transformed actual P")?;
        }
        let mut roundtrip = y.clone();
        coordinates.transform(&mut roundtrip);
        coordinates.transform(&mut roundtrip);
        identity(
            roundtrip[model.ledger_row()] - y[model.ledger_row()],
            y[..model.nc_dimension()]
                .iter()
                .map(|v| v.abs())
                .sum::<f64>()
                + y[model.ledger_row()].abs(),
            "Physical checkpoint roundtrip",
        )?;
        // Exercise the actual native callbacks, not merely equivalent helper
        // algebra beside them. No IDA memory or advancing solve is created.
        let mut callbacks = Callbacks::new(model, model.workspace(), Instant::now(), 30.)?;
        let user = (&mut callbacks as *mut Callbacks<'_>).cast();
        let mut sy = y.clone();
        coordinates.transform(&mut sy);
        let mut syp = yp.clone();
        coordinates.transform(&mut syp);
        let sy = vectors.vector(&sy)?;
        let syp = vectors.vector(&syp)?;
        let residual_out = vectors.vector(&vec![0.; n])?;
        checked(
            unsafe { residual(time, sy, syp, residual_out, user) },
            "Actual transformed residual callback",
        )?;
        let mut expected_residual = yp.iter().zip(&r).map(|(p, f)| p - f).collect::<Vec<_>>();
        coordinates.transform(&mut expected_residual);
        let scale = yp.iter().chain(&r).map(|v| v.abs()).sum::<f64>();
        for (i, (&a, &b)) in unsafe { values(residual_out, n) }?
            .iter()
            .zip(&expected_residual)
            .enumerate()
        {
            identity(
                a - b,
                if i == model.ledger_row() {
                    scale
                } else {
                    a.abs() + b.abs()
                },
                "Actual residual basis equivalence",
            )?;
        }
        checked(
            unsafe { jtsetup(time, sy, syp, residual_out, cj, user) },
            "Actual JT setup callback",
        )?;
        checked(
            unsafe {
                jtimes(
                    time,
                    sy,
                    syp,
                    residual_out,
                    tr,
                    result,
                    cj,
                    user,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            },
            "Actual transformed JVP callback",
        )?;
        let mut expected_action = direction
            .iter()
            .zip(&tangent)
            .map(|(v, j)| cj * v - j)
            .collect::<Vec<_>>();
        coordinates.transform(&mut expected_action);
        let scale = direction.iter().map(|v| cj * v.abs()).sum::<f64>()
            + tangent.iter().map(|v| v.abs()).sum::<f64>();
        for (i, (&a, &b)) in unsafe { values(result, n) }?
            .iter()
            .zip(&expected_action)
            .enumerate()
        {
            identity(
                a - b,
                if i == model.ledger_row() {
                    scale
                } else {
                    a.abs() + b.abs()
                },
                "Actual JVP basis equivalence",
            )?;
        }
        let bx = model.conservation(&x).map_err(str::to_owned)?;
        let br = model.conservation(&direction).map_err(str::to_owned)?;
        identity(
            cj * bx.neutron_ledger_defect - br.neutron_ledger_defect,
            cj * (x[..model.nc_dimension()]
                .iter()
                .map(|v| v.abs())
                .sum::<f64>()
                + x[model.ledger_row()].abs())
                + br.neutron_ledger_scale,
            "P number row combination",
        )?;
        identity(
            cj * bx.energy_ledger_defect_j - br.energy_ledger_defect_j,
            cj * bx.energy_ledger_scale_j + br.energy_ledger_scale_j,
            "P selected energy",
        )?;
        model.jvp_into(&x, &mut work).map_err(str::to_owned)?;
        let ax = x
            .iter()
            .zip(work.rate_jvp().map_err(str::to_owned)?)
            .map(|(x, j)| cj * x - j)
            .collect::<Vec<_>>();
        let ba = model.conservation(&ax).map_err(str::to_owned)?;
        identity(
            ba.neutron_ledger_defect - br.neutron_ledger_defect,
            ax[..model.nc_dimension()]
                .iter()
                .map(|v| v.abs())
                .sum::<f64>()
                + ax[model.ledger_row()].abs()
                + br.neutron_ledger_scale,
            "True stage projected number residual",
        )?;
        // Counterexample: a post-solve componentwise positivity correction
        // changes the invariant. P cannot make a nonconservative correction
        // or inherited state drift disappear; independent screening remains.
        let mut corrected = x.clone();
        corrected[0] += 1.;
        let bc = model.conservation(&corrected).map_err(str::to_owned)?;
        if (bc.neutron_ledger_defect - bx.neutron_ledger_defect - 1.).abs() > 1e-6 {
            return Err("Constraint-correction counterexample was not resolved".into());
        }
        println!(
            "{{\"kind\":\"source-static-audit\",\"case\":{},\"passed\":true,\"advancement\":false,\"freshRHSSeconds\":{},\"exactReuseSeconds\":{},\"JVPSeconds\":{},\"PSetupSeconds\":{},\"PSolveSeconds\":{},\"RHSNumberDefect\":{},\"JVPNumberDefect\":{},\"PNumberDefect\":{},\"PEnergyDefectJ\":{},\"trueStageProjectedNumberResidual\":{},\"priorIntegratedNumberDefectUnchanged\":{},\"priorSlopeNumberDefectUnchanged\":{},\"priorTime\":{},\"noWholePlantReadinessCredit\":true}}",
            quote(name),
            finite(fresh_seconds),
            finite(reuse_seconds),
            finite(jvp_seconds),
            finite(setup_seconds),
            finite(p_seconds),
            finite(model.conservation(&r).unwrap().neutron_ledger_defect),
            finite(b.neutron_ledger_defect),
            finite(cj * bx.neutron_ledger_defect - br.neutron_ledger_defect),
            finite(cj * bx.energy_ledger_defect_j - br.energy_ledger_defect_j),
            finite(ba.neutron_ledger_defect - br.neutron_ledger_defect),
            finite(old_balance.neutron_ledger_defect),
            finite(old_slope.neutron_ledger_defect),
            finite(time)
        );
    }
    Ok(())
}

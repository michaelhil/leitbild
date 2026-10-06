//! Bounded failure diagnosis only. No alternate production Jacobian/solver.
//! Nested module, not an independently advancing Cargo example.
use super::ida_support::*;
use leitbild_plant_numerics::operating_network::*;
fn product(n: &Network, a: &[f64], x: &[f64]) -> Vec<f64> {
    let mut b = vec![0.; n.dimension()];
    for col in 0..x.len() {
        for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
            b[n.row_indices[k] as usize] += a[k] * x[col];
        }
    }
    b
}
pub fn audit(
    n: &Network,
    y: &[f64],
    yp: &[f64],
    cj: f64,
    weights: &[f64],
    label: &str,
) -> Result<(), String> {
    let began = std::time::Instant::now();
    let dim = n.dimension();
    let nw = n.config().water.len();
    let mut w = Workspace::new(n);
    w.evaluate(n, y, yp, Some(cj))?;
    let mut queries = w.property_requests;
    let a = w.jacobian_values.clone();
    let residual = w.residual.clone();
    let flows = w.mass_flows.clone();
    let mut drives = vec![];
    let mut loss_slopes = vec![];
    for (j, edge) in n.config().hydraulic.iter().enumerate() {
        let rho = (w.liquids[edge.from].density + w.liquids[edge.to].density) * 0.5;
        let mu = (w.liquids[edge.from].viscosity + w.liquids[edge.to].viscosity) * 0.5;
        drives.push(
            y[5 * edge.from + 3]
                - y[5 * edge.to + 3]
                - rho
                    * 9.80665
                    * (n.config().water[edge.to].geometry.elevation
                        - n.config().water[edge.from].geometry.elevation),
        );
        loss_slopes.push(edge.pressure_loss(flows[j], rho, mu)[1]);
    }
    let mut row_norm = vec![0_f64; dim];
    for col in 0..dim {
        for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
            let row = n.row_indices[k] as usize;
            row_norm[row] = row_norm[row].max((a[k] * weights[col]).abs());
        }
    }
    let known: Vec<f64> = (0..dim)
        .map(|i| weights[i] * ((i * 17 % 31) as f64 / 31. - 0.5))
        .collect();
    let b = product(n, &a, &known);
    let mut factor_results = vec![];
    for equilibrated in [false, true] {
        let mut resources = Resources::new()?;
        let x = resources.vector(&vec![0.; dim])?;
        let rhs: Vec<f64> = (0..dim)
            .map(|i| {
                if equilibrated {
                    b[i] / row_norm[i]
                } else {
                    b[i]
                }
            })
            .collect();
        let rhs_vector = resources.vector(&rhs)?;
        let matrix = resources.matrix(dim as i64, a.len() as i64)?;
        let vals: Vec<f64> = a
            .iter()
            .enumerate()
            .map(|(k, v)| {
                if equilibrated {
                    v / row_norm[n.row_indices[k] as usize]
                } else {
                    *v
                }
            })
            .collect();
        matrix_data(matrix, &n.column_pointers, &n.row_indices, &vals)?;
        let solver = resources.solver(x)?;
        checked(
            unsafe { SUNLinSolInitialize(solver) },
            "audit KLU initialize",
        )?;
        checked(
            unsafe { SUNLinSolSetup(solver, matrix) },
            "audit KLU factor",
        )?;
        checked(
            unsafe { SUNLinSolSolve(solver, matrix, x, rhs_vector, 0.) },
            "audit KLU solve",
        )?;
        let solution = unsafe { std::slice::from_raw_parts(N_VGetArrayPointer_Serial(x), dim) };
        let seen = product(n, &a, solution);
        let mut correction = 0_f64;
        let mut backward = 0_f64;
        for i in 0..dim {
            correction = correction.max((solution[i] - known[i]).abs() / weights[i]);
            backward = backward.max((seen[i] - b[i]).abs() / row_norm[i]);
        }
        let stage_rhs: Vec<f64> = (0..dim)
            .map(|i| {
                if equilibrated {
                    -residual[i] / row_norm[i]
                } else {
                    -residual[i]
                }
            })
            .collect();
        let stage_rhs_vector = resources.vector(&stage_rhs)?;
        checked(
            unsafe { SUNLinSolSolve(solver, matrix, x, stage_rhs_vector, 0.) },
            "audit actual residual solve",
        )?;
        let solution = unsafe { std::slice::from_raw_parts(N_VGetArrayPointer_Serial(x), dim) };
        let seen = product(n, &a, solution);
        let actual_correction = (0..dim)
            .map(|i| solution[i].abs() / weights[i])
            .fold(0_f64, f64::max);
        let actual_backward = (0..dim)
            .map(|i| (seen[i] + residual[i]).abs() / row_norm[i])
            .fold(0_f64, f64::max);
        factor_results.push(format!("{{\"equilibratedRows\":{equilibrated},\"maxWeightedCorrectionError\":{correction},\"maxRowNormalizedBackwardResidual\":{backward},\"actualResidualMaxWeightedCorrection\":{actual_correction},\"actualResidualMaxRowNormalizedBackwardResidual\":{actual_backward}}}"));
    }
    let mut columns = vec![];
    for col in 0..dim {
        let mut step = if col < 5 * nw {
            match col % 5 {
                0 => y[col].abs() * 1e-6,
                1 => y[col].abs() * 1e-6,
                2 => weights[col] * 100.,
                3 => 0.1,
                4 => 1e-5,
                _ => unreachable!(),
            }
        } else if col < n.stock_dimension() {
            weights[col] * 100.
        } else {
            // Direct flow perturbations stay on the current donor branch when
            // nonzero. At rest, report the actual signed branch crossing.
            if y[col] == 0. {
                weights[col]
            } else {
                y[col].abs() * 1e-5
            }
        };
        // q is independent at a Newton trial: pressure probes no longer change
        // flow through an inner inverse. Do not inherit its tiny-drive FD step.
        step = step.max(y[col].abs() * f64::EPSILON * 8.);
        let mut reports = vec![];
        for scale in [1., 0.5] {
            let delta = step * scale;
            let mut plus = y.to_vec();
            let mut minus = y.to_vec();
            plus[col] += delta;
            // Passive tracer has a one-sided physical boundary at zero.
            if !(col < 5 * nw && col % 5 == 2 && y[col] < delta) {
                minus[col] -= delta;
            }
            let actual_delta = plus[col] - minus[col];
            let mut pp = yp.to_vec();
            let mut pm = yp.to_vec();
            pp[col] += cj * (plus[col] - y[col]);
            pm[col] += cj * (minus[col] - y[col]);
            w.evaluate(n, &plus, &pp, None)?;
            queries += w.property_requests;
            let fp = w.residual.clone();
            let qp = w.mass_flows.clone();
            w.evaluate(n, &minus, &pm, None)?;
            queries += w.property_requests;
            let fm = w.residual.clone();
            let qm = w.mass_flows.clone();
            let mut expected = vec![0.; dim];
            for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
                expected[n.row_indices[k] as usize] = a[k];
            }
            let mut max = 0_f64;
            let mut worst = 0;
            let mut max_transport = 0_f64;
            let mut transport_worst = 0;
            for row in 0..dim {
                let fd = (fp[row] - fm[row]) / actual_delta;
                let err = (fd - expected[row]).abs() * weights[col] / row_norm[row];
                if err > max {
                    max = err;
                    worst = row;
                }
                if row < 5 * nw && row % 5 < 3 && err > max_transport {
                    max_transport = err;
                    transport_worst = row;
                }
            }
            let reversals = (0..flows.len()).filter(|&i| qp[i] * qm[i] < 0.).count();
            let relative_flow = (0..flows.len())
                .filter(|&i| flows[i] != 0.)
                .map(|i| ((qp[i] - flows[i]).abs().max((qm[i] - flows[i]).abs())) / flows[i].abs())
                .fold(0_f64, f64::max);
            reports.push(format!("{{\"actualDelta\":{actual_delta},\"maxRowNormalizedDerivativeDefect\":{max},\"worstRow\":{worst},\"transportDefect\":{max_transport},\"transportWorstRow\":{transport_worst},\"flowReversals\":{reversals},\"maxRelativeFlowChange\":{relative_flow}}}"));
        }
        columns.push(format!(
            "{{\"column\":{col},\"probes\":[{}]}}",
            reports.join(",")
        ));
    }
    let capacitance: Vec<f64> = (0..nw)
        .map(|i| {
            let col = 5 * i + 3;
            let row = 5 * i + 3;
            let start = n.column_pointers[col] as usize;
            let end = n.column_pointers[col + 1] as usize;
            -a[start
                + n.row_indices[start..end]
                    .binary_search(&(row as i64))
                    .unwrap()]
        })
        .collect();
    println!(
        "{{\"scope\":\"bounded-operating-matrix-audit\",\"state\":\"{label}\",\"cj\":{cj},\"unknowns\":{dim},\"elapsed_s\":{},\"propertyTuples\":{queries},\"flows_kg_s\":{:?},\"drives_Pa\":{:?},\"lossSlope_Pa_s_kg\":{:?},\"pressureCapacitance_kg_Pa\":{:?},\"factorization\":[{}],\"columns\":[{}]}}",
        began.elapsed().as_secs_f64(),
        flows,
        drives,
        loss_slopes,
        capacitance,
        factor_results.join(","),
        columns.join(",")
    );
    Ok(())
}

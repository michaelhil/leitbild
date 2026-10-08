//! Bounded failure diagnosis only. No alternate production Jacobian/solver.
//! Nested module, not an independently advancing Cargo example.
use super::ida_support::*;
use leitbild_plant_numerics::operating_network::*;
// Equation categories are independent of coordinate IDs. The index-reduced
// continuity rows are transport, even though their coordinates are mechanical.
fn flow_range(n: &Network) -> std::ops::Range<usize> {
    let start = n.flow_row(0);
    start..start + n.config().hydraulic.len()
}
fn row_kind(n: &Network, row: usize) -> usize {
    if row >= n.base_dimension() {
        return if n.is_differential(row) { 0 } else { 2 };
    }
    if row < n.stock_dimension() || row >= flow_range(n).end {
        0
    } else if flow_range(n).contains(&row) {
        1
    } else {
        2
    }
}
fn state_probe(n: &Network, y: &[f64], weights: &[f64], col: usize) -> f64 {
    if col >= n.base_dimension() {
        return match (col - n.base_dimension()) % 3 {
            0 => 100.,
            1 => 1e-5,
            _ => 0.1,
        };
    }
    let nw = n.config().water.len();
    if col < nw {
        100. // finite water energy, J
    } else if col < 2 * nw {
        weights[col] * 100. // nonnegative marker inventory
    } else if col == n.total_mass_row() {
        y[col].abs() * 1e-6 // aggregate water mass, kg
    } else if col < n.stock_dimension() {
        100. // finite solid energy, J
    } else if col == n.pressure_row() || col >= flow_range(n).end {
        0.1 // thermodynamic pressure or mechanical multiplier, Pa
    } else if col < flow_range(n).start {
        1e-5 // material temperature, K
    } else {
        y[col].abs().max(weights[col]) * 1e-4 // signed kg/s
    }
}
fn product(n: &Network, a: &[f64], x: &[f64]) -> Vec<f64> {
    let mut b = vec![0.; n.dimension()];
    for col in 0..x.len() {
        for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
            b[n.row_indices[k] as usize] += a[k] * x[col];
        }
    }
    b
}
/// Independent fixed-state F_y and full F_yp checks, followed by actual
/// positive-cj KLU tests. No trajectory or alternate production operator.
pub fn fixed(
    n: &Network,
    y: &[f64],
    yp: &[f64],
    weights: &[f64],
    cjs: &[f64],
    label: &str,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let dim = n.dimension();
    let nw = n.config().water.len();
    if y.len() != dim
        || yp.len() != dim
        || weights.len() != dim
        || cjs.is_empty()
        || !weights.iter().all(|x| x.is_finite() && *x > 0.)
        || !cjs.iter().all(|x| x.is_finite() && *x > 0.)
    {
        return Err("Invalid fixed audit dimensions, weights or cj".into());
    }
    let mut w = Workspace::new(n);
    w.evaluate(n, y, yp, Some(0.))?;
    let mut queries = w.property_requests;
    let fy = w.jacobian_values.clone();
    let residual = w.residual.clone();
    let mut residual_max = [0_f64; 3];
    for row in 0..dim {
        let kind = row_kind(n, row);
        residual_max[kind] = residual_max[kind].max(residual[row].abs());
    }
    let mut columns = vec![];
    for col in 0..dim {
        let step = state_probe(n, y, weights, col);
        let mut probes = vec![];
        for factor in [1., 0.5] {
            let mut plus = y.to_vec();
            let mut minus = y.to_vec();
            plus[col] += step * factor;
            let one_sided = (col >= nw && col < 2 * nw && y[col] < step * factor)
                || (flow_range(n).contains(&col) && y[col] == 0.);
            if !one_sided {
                minus[col] -= step * factor;
            }
            let delta = plus[col] - minus[col];
            let flow_branch_crossed = flow_range(n).contains(&col) && plus[col] * minus[col] < 0.;
            if delta == 0. {
                return Err(format!("Unresolvable fixed audit probe column {col}"));
            }
            w.evaluate(n, &plus, yp, None)?;
            queries += w.property_requests;
            let fp = w.residual.clone();
            w.evaluate(n, &minus, yp, None)?;
            queries += w.property_requests;
            let fm = w.residual.clone();
            let mut expected = vec![0.; dim];
            for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
                expected[n.row_indices[k] as usize] = fy[k];
            }
            let mut worst = [0_f64; 3];
            let mut rows = [0; 3];
            let mut values = [[0.; 2]; 3];
            for row in 0..dim {
                let seen = (fp[row] - fm[row]) / delta;
                let relative =
                    (seen - expected[row]).abs() / seen.abs().max(expected[row].abs()).max(1e-6);
                let kind = row_kind(n, row);
                if relative > worst[kind] {
                    worst[kind] = relative;
                    rows[kind] = row;
                    values[kind] = [seen, expected[row]];
                }
            }
            probes.push(format!("{{\"actualDelta\":{delta},\"oneSided\":{one_sided},\"flowBranchCrossed\":{flow_branch_crossed},\"maxRelativeDefect_Transport_Hydraulic_Chart\":{worst:?},\"worstRows\":{rows:?},\"seenExpected\":{values:?}}}"));
        }
        columns.push(format!(
            "{{\"column\":{col},\"probes\":[{}]}}",
            probes.join(",")
        ));
    }
    // Independently observe F_yp, including off-diagonal index-reduced
    // continuity coefficients. Never assume coordinate IDs imply a diagonal
    // mass matrix. Every derivative coordinate is probed, including algebraic
    // coordinates whose genuine F_yp column must be zero.
    let mut fyp = vec![vec![0.; dim]; dim];
    let mut derivative_probes = vec![];
    for col in 0..dim {
        let step = yp[col].abs().max(1.) * 1e-4;
        let mut seen = vec![];
        let mut deltas = vec![];
        for factor in [1., 0.5] {
            let mut plus = yp.to_vec();
            let mut minus = yp.to_vec();
            plus[col] += step * factor;
            minus[col] -= step * factor;
            let delta = plus[col] - minus[col];
            if delta == 0. {
                return Err(format!("Unresolvable derivative audit column {col}"));
            }
            w.evaluate(n, y, &plus, None)?;
            queries += w.property_requests;
            let fp = w.residual.clone();
            w.evaluate(n, y, &minus, None)?;
            queries += w.property_requests;
            seen.push(
                (0..dim)
                    .map(|row| (fp[row] - w.residual[row]) / delta)
                    .collect::<Vec<_>>(),
            );
            deltas.push(delta);
        }
        let mut worst = 0_f64;
        let mut worst_row = 0;
        for row in 0..dim {
            let error = (seen[0][row] - seen[1][row]).abs()
                / seen[0][row].abs().max(seen[1][row].abs()).max(1e-12);
            if error > worst {
                worst = error;
                worst_row = row;
            }
        }
        fyp[col].copy_from_slice(&seen[0]);
        derivative_probes.push(format!("{{\"column\":{col},\"actualDeltas\":{deltas:?},\"fullHalfRelativeDefect\":{worst},\"worstRow\":{worst_row}}}"));
    }
    let mut factorizations = vec![];
    for &cj in cjs {
        w.evaluate(n, y, yp, Some(cj))?;
        queries += w.property_requests;
        let a = w.jacobian_values.clone();
        let mut seen_mass = vec![vec![0.; dim]; dim];
        for col in 0..dim {
            for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
                seen_mass[col][n.row_indices[k] as usize] = (a[k] - fy[k]) / cj;
            }
        }
        let mut mass_absolute = 0_f64;
        let mut mass_relative = 0_f64;
        let mut mass_worst = [0; 2];
        let mut mass_values = [0.; 2];
        for col in 0..dim {
            for row in 0..dim {
                let seen = seen_mass[col][row];
                let expected = fyp[col][row];
                let difference = (seen - expected).abs();
                mass_absolute = mass_absolute.max(difference);
                let relative = difference / seen.abs().max(expected.abs()).max(1e-12);
                if relative > mass_relative {
                    mass_relative = relative;
                    mass_worst = [row, col];
                    mass_values = [seen, expected];
                }
            }
        }
        let mass_record = format!(
            "\"massMatrixMaxAbsoluteCoefficientDefect\":{mass_absolute},\"massMatrixMaxRelativeEntryDefect\":{mass_relative},\"massMatrixWorstRowColumn\":{mass_worst:?},\"massMatrixSeenExpected\":{mass_values:?}"
        );
        let mut row_norm = vec![0_f64; dim];
        for col in 0..dim {
            for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
                let row = n.row_indices[k] as usize;
                row_norm[row] = row_norm[row].max((a[k] * weights[col]).abs());
            }
        }
        if row_norm.iter().any(|x| !x.is_finite() || *x <= 0.) {
            return Err("Fixed audit has an empty or nonfinite weighted matrix row".into());
        }
        for scale in ["raw", "row-and-column"] {
            let mut resource = Resources::new()?;
            let x = resource.vector(&vec![0.; dim])?;
            let matrix = resource.matrix(dim as i64, a.len() as i64)?;
            let mut vals = a.clone();
            if scale != "raw" {
                for col in 0..dim {
                    for k in n.column_pointers[col] as usize..n.column_pointers[col + 1] as usize {
                        vals[k] *= weights[col] / row_norm[n.row_indices[k] as usize];
                    }
                }
            }
            matrix_data(matrix, &n.column_pointers, &n.row_indices, &vals)?;
            let solver = resource.solver(x)?;
            checked(
                unsafe { SUNLinSolInitialize(solver) },
                "fixed KLU initialize",
            )?;
            let setup = unsafe { SUNLinSolSetup(solver, matrix) };
            if setup != 0 {
                factorizations.push(format!(
                    "{{\"cj\":{cj},\"scale\":\"{scale}\",\"factorStatus\":{setup},{mass_record}}}"
                ));
                continue;
            }
            for mode in ["mixed", "common-pressure", "actual-residual"] {
                let known: Vec<f64> = (0..dim)
                    .map(|i| {
                        if mode == "common-pressure" {
                            if i == n.pressure_row() {
                                weights[i]
                            } else {
                                0.
                            }
                        } else {
                            weights[i] * ((i * 17 % 31) as f64 / 31. - 0.5)
                        }
                    })
                    .collect();
                let rhs = if mode == "actual-residual" {
                    residual.iter().map(|v| -v).collect()
                } else {
                    product(n, &a, &known)
                };
                let b = resource.vector(
                    &(0..dim)
                        .map(|i| {
                            if scale == "raw" {
                                rhs[i]
                            } else {
                                rhs[i] / row_norm[i]
                            }
                        })
                        .collect::<Vec<_>>(),
                )?;
                let solve = unsafe { SUNLinSolSolve(solver, matrix, x, b, 0.) };
                if solve != 0 {
                    factorizations.push(format!("{{\"cj\":{cj},\"scale\":\"{scale}\",\"mode\":\"{mode}\",\"solveStatus\":{solve}}}"));
                    continue;
                }
                let raw = unsafe { std::slice::from_raw_parts(N_VGetArrayPointer_Serial(x), dim) };
                let solution: Vec<f64> = (0..dim)
                    .map(|i| {
                        if scale == "raw" {
                            raw[i]
                        } else {
                            raw[i] * weights[i]
                        }
                    })
                    .collect();
                let seen = product(n, &a, &solution);
                let correction = (0..dim)
                    .map(|i| {
                        if mode == "actual-residual" {
                            solution[i].abs() / weights[i]
                        } else {
                            (solution[i] - known[i]).abs() / weights[i]
                        }
                    })
                    .fold(0_f64, f64::max);
                let backward = (0..dim)
                    .map(|i| (seen[i] - rhs[i]).abs() / row_norm[i])
                    .fold(0_f64, f64::max);
                factorizations.push(format!("{{\"cj\":{cj},\"scale\":\"{scale}\",\"mode\":\"{mode}\",{mass_record},\"maxWeightedCorrectionOrError\":{correction},\"maxPhysicalRowNormalizedBackwardResidual\":{backward}}}"));
            }
        }
    }
    println!(
        "{{\"scope\":\"nonadvancing-operating-matrix-audit\",\"state\":\"{label}\",\"unknowns\":{dim},\"nnz\":{},\"propertyTuples\":{queries},\"elapsed_s\":{},\"maxResidual_Transport_Hydraulic_Chart\":{residual_max:?},\"FDcj\":0,\"FDRelativeDenominatorFloor\":0.000001,\"columns\":[{}],\"derivativeColumns\":[{}],\"massMatrixRelativeDenominatorFloor\":1e-12,\"factorizations\":[{}]}}",
        fy.len(),
        started.elapsed().as_secs_f64(),
        columns.join(","),
        derivative_probes.join(","),
        factorizations.join(",")
    );
    Ok(())
}
pub fn audit(
    n: &Network,
    y: &[f64],
    yp: &[f64],
    cj: f64,
    weights: &[f64],
    label: &str,
) -> Result<(), String> {
    fixed(n, y, yp, weights, &[cj], label)
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use leitbild_plant_numerics::CellGeometry;

    #[test]
    fn reduced_layout_categories_and_probes_do_not_treat_continuity_as_pressure_chart() {
        let water = Water {
            geometry: CellGeometry {
                volume: 1.,
                elevation: 0.,
            },
            initial_pressure: 300000.,
            initial_temperature: 300.,
            initial_tracer_fraction: 0.,
        };
        let n = Network::new(Config {
            secondaries: vec![],
            secondary_heat: vec![],
            seat: None,
            prhr: None,
            water: vec![water, water],
            solids: vec![Solid {
                heat_capacity: 1000.,
                initial_temperature: 313.,
            }],
            hydraulic: vec![Hydraulic {
                from: 0,
                to: 1,
                from_elevation: 0.,
                to_elevation: 0.,
                segments: vec![HydraulicSegment {
                    law: LossLaw::EffectiveTotal,
                    length: 1.,
                    flow_area: 0.1,
                    diameter: 0.356,
                    roughness: 0.,
                    fixed_loss: 1.,
                    grid_multiplier: 0.,
                }],
            }],
            heat: vec![],
        })
        .unwrap();
        assert_eq!(n.dimension(), 11);
        assert_eq!(n.stock_dimension(), 6);
        assert_eq!(flow_range(&n), 9..10);
        assert_eq!(
            (0..11).map(|row| row_kind(&n, row)).collect::<Vec<_>>(),
            vec![0, 0, 0, 0, 0, 0, 2, 2, 2, 1, 0]
        );
        let mut y = vec![1.; n.dimension()];
        y[n.total_mass_row()] = 40.;
        let weights = vec![0.2; n.dimension()];
        assert_eq!(state_probe(&n, &y, &weights, n.energy_row(0)), 100.);
        assert_eq!(state_probe(&n, &y, &weights, n.marker_row(0)), 20.);
        assert!((state_probe(&n, &y, &weights, n.total_mass_row()) - 40e-6).abs() < 1e-18);
        assert_eq!(state_probe(&n, &y, &weights, n.energy_row(2)), 100.);
        assert_eq!(state_probe(&n, &y, &weights, n.pressure_row()), 0.1);
        assert_eq!(state_probe(&n, &y, &weights, n.temperature_row(0)), 1e-5);
        assert_eq!(state_probe(&n, &y, &weights, n.flow_row(0)), 1e-4);
        assert_eq!(
            state_probe(&n, &y, &weights, n.mechanical_row(1).unwrap()),
            0.1
        );
        let mut c = n.config().clone();
        c.secondaries.push(Secondary {
            volume: 120.,
            initial_temperature: 313.15,
            initial_pressure: 101325.,
            initial_liquid_volume: 72.,
            initial_nitrogen_mass: 0.,
            minimum_wetted_liquid_volume: 71.25,
        });
        let n = Network::new(c).unwrap();
        let y = n.initial_state().unwrap();
        let weights = vec![1.; n.dimension()];
        let u = n.secondary_energy_row(0);
        let t = n.secondary_temperature_row(0);
        let p = n.secondary_pressure_row(0);
        assert_eq!(
            [row_kind(&n, u), row_kind(&n, t), row_kind(&n, p)],
            [0, 2, 2]
        );
        assert_eq!(
            [
                n.is_differential(u),
                n.is_differential(t),
                n.is_differential(p)
            ],
            [true, false, false]
        );
        assert_eq!(
            [
                state_probe(&n, &y, &weights, u),
                state_probe(&n, &y, &weights, t),
                state_probe(&n, &y, &weights, p)
            ],
            [100., 1e-5, 0.1]
        );
    }
}

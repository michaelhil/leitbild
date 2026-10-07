//! Fixed energy-order block Gauss–Seidel using the pinned spatial KLU solver.
//! This is only P: the IDA residual and matrix-free Jacobian remain fully coupled.
use super::ida_support::*;
use super::{finite, numbers, output, quote, telemetry_stats, values};
use leitbild_plant_numerics::{
    fuel_source::GROUPS,
    source_evolution::{Evolution, HistoryPreconditioner, Workspace},
};
use std::{
    io::{self, Write},
    time::Instant,
};

struct SpatialBlock {
    owned: Resources,
    b: Handle,
    x: Handle,
    pointers: Vec<i64>,
    indices: Vec<i64>,
    slots: Vec<usize>,
    coefficients: Vec<f64>,
    /// A(row, earlier-energy-column), applied with its actual signed value.
    earlier: Vec<(usize, usize, usize)>,
}
struct PrecursorRow {
    diagonal: usize,
    forcing: Vec<(usize, usize)>,
}
pub(super) struct GroupSweep {
    blocks: Vec<SpatialBlock>,
    precursor: Vec<PrecursorRow>,
    regions: usize,
    nc: usize,
    entries: usize,
    pub(super) factors: u64,
    pub(super) factor_seconds: f64,
    pub(super) spatial_solves: u64,
    pub(super) spatial_solve_seconds: f64,
    pub(super) group_factor_seconds: [f64; GROUPS],
}
impl GroupSweep {
    fn new(regions: usize, nc: usize, pattern: &[(usize, usize)]) -> Result<Self, String> {
        let neutrons = regions
            .checked_mul(GROUPS)
            .ok_or("Neutron dimension overflow")?;
        if regions == 0 || nc < neutrons || pattern.iter().any(|&(r, c)| r >= nc || c >= nc) {
            return Err("Invalid spatial-group pattern dimensions".into());
        }
        let mut blocks = Vec::with_capacity(GROUPS);
        for g in 0..GROUPS {
            let mut slots = pattern
                .iter()
                .enumerate()
                .filter_map(|(k, &(r, c))| {
                    (r < neutrons && c < neutrons && r % GROUPS == g && c % GROUPS == g)
                        .then_some(k)
                })
                .collect::<Vec<_>>();
            slots.sort_unstable_by_key(|&k| (pattern[k].1 / GROUPS, pattern[k].0 / GROUPS));
            let mut pointers = vec![0i64; regions + 1];
            let mut indices = Vec::with_capacity(slots.len());
            let mut diagonal = vec![false; regions];
            let mut previous = None;
            for &k in &slots {
                let (r, c) = (pattern[k].0 / GROUPS, pattern[k].1 / GROUPS);
                if previous == Some((r, c)) {
                    return Err("Duplicate spatial matrix entry".into());
                }
                previous = Some((r, c));
                pointers[c + 1] += 1;
                indices.push(r as i64);
                if r == c {
                    diagonal[r] = true;
                }
            }
            if diagonal.iter().any(|v| !v) {
                return Err("Missing spatial diagonal".into());
            }
            for c in 0..regions {
                pointers[c + 1] += pointers[c];
            }
            let earlier =
                pattern
                    .iter()
                    .enumerate()
                    .filter_map(|(k, &(r, c))| {
                        (r < neutrons && r % GROUPS == g && c < neutrons && c % GROUPS < g)
                            .then_some((r / GROUPS, c, k))
                    })
                    .collect();
            let mut owned = Resources::new()?;
            let b = owned.vector(&vec![0.; regions])?;
            let x = owned.vector(&vec![0.; regions])?;
            owned.matrix(regions as i64, slots.len() as i64)?;
            owned.solver(x)?;
            checked(
                unsafe { SUNLinSolInitialize(owned.solver) },
                "Initialize spatial KLU",
            )?;
            blocks.push(SpatialBlock {
                owned,
                b,
                x,
                pointers,
                indices,
                coefficients: vec![0.; slots.len()],
                slots,
                earlier,
            });
        }
        let mut diagonal = vec![None; nc - neutrons];
        let mut forcing = vec![Vec::new(); nc - neutrons];
        for (k, &(r, c)) in pattern
            .iter()
            .enumerate()
            .filter(|entry| entry.1.0 >= neutrons)
        {
            let i = r - neutrons;
            if c < neutrons {
                forcing[i].push((c, k));
            } else if r == c && diagonal[i].replace(k).is_none() {
            } else {
                return Err("Nonlocal precursor coupling unsupported by selected P".into());
            }
        }
        let precursor = diagonal
            .into_iter()
            .zip(forcing)
            .map(|(d, f)| {
                Ok(PrecursorRow {
                    diagonal: d.ok_or("Missing precursor diagonal")?,
                    forcing: f,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            blocks,
            precursor,
            regions,
            nc,
            entries: pattern.len(),
            factors: 0,
            factor_seconds: 0.,
            spatial_solves: 0,
            spatial_solve_seconds: 0.,
            group_factor_seconds: [0.; GROUPS],
        })
    }
    fn assemble(&mut self, coefficients: &[f64]) -> Result<(), String> {
        if coefficients.len() != self.entries || coefficients.iter().any(|v| !v.is_finite()) {
            return Err("Invalid/nonfinite group matrix".into());
        }
        for b in &mut self.blocks {
            for (v, &slot) in b.coefficients.iter_mut().zip(&b.slots) {
                *v = coefficients[slot];
            }
            matrix_data(b.owned.matrix, &b.pointers, &b.indices, &b.coefficients)?;
        }
        Ok(())
    }
    fn factor_group(&mut self, g: usize) -> i32 {
        let t = Instant::now();
        let b = &mut self.blocks[g];
        let status = unsafe { SUNLinSolSetup(b.owned.solver, b.owned.matrix) };
        let seconds = t.elapsed().as_secs_f64();
        self.factors += 1;
        self.factor_seconds += seconds;
        self.group_factor_seconds[g] += seconds;
        status
    }
    /// Exactly one forward energy sweep, indices 0..GROUPS (owner groups 1..7).
    /// Later-group and precursor feedback are omitted in P, never in J*v.
    fn solve(
        &mut self,
        coefficients: &[f64],
        rhs: &[f64],
        solution: &mut [f64],
    ) -> Result<(), String> {
        if coefficients.len() != self.entries
            || rhs.len() != self.nc
            || solution.len() != self.nc
            || rhs.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid group-sweep vectors".into());
        }
        solution.fill(0.);
        for g in 0..GROUPS {
            let start = Instant::now();
            let b = &mut self.blocks[g];
            let input = unsafe { output(b.b, self.regions) }?;
            for r in 0..self.regions {
                input[r] = rhs[r * GROUPS + g];
            }
            for &(r, c, k) in &b.earlier {
                input[r] -= coefficients[k] * solution[c];
            }
            let status = unsafe { SUNLinSolSolve(b.owned.solver, b.owned.matrix, b.x, b.b, 0.) };
            self.spatial_solves += 1;
            self.spatial_solve_seconds += start.elapsed().as_secs_f64();
            checked(status, "Spatial-group KLU solve")?;
            let result = unsafe { values(b.x, self.regions) }?;
            for r in 0..self.regions {
                solution[r * GROUPS + g] = result[r];
            }
        }
        let neutrons = self.regions * GROUPS;
        for (i, p) in self.precursor.iter().enumerate() {
            let diagonal = coefficients[p.diagonal];
            if !diagonal.is_finite() || diagonal <= 0. {
                return Err("Invalid precursor stage diagonal".into());
            }
            let mut v = rhs[neutrons + i];
            for &(c, k) in &p.forcing {
                v -= coefficients[k] * solution[c];
            }
            solution[neutrons + i] = v / diagonal;
        }
        if solution.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite group-sweep result".into());
        }
        Ok(())
    }
}

/// Numeric P-stage physics has its OWN workspace. JTsetup can change the main
/// workspace without changing this fixed preconditioner during a Krylov solve.
pub(super) struct Preconditioner {
    sweep: GroupSweep,
    work: Workspace,
    history: HistoryPreconditioner,
    coefficients: Vec<f64>,
    rhs: Vec<f64>,
    nc_rhs: Vec<f64>,
    pub(super) setups: u64,
    pub(super) solves: u64,
    pub(super) setup_seconds: f64,
    pub(super) solve_seconds: f64,
    pub(super) assembly_seconds: f64,
    pub(super) factor_seconds: f64,
    pub(super) history_solve_seconds: f64,
    valid: bool,
    cj: f64,
}
impl Preconditioner {
    pub(super) fn metrics_json(&self) -> String {
        let order = (0..GROUPS)
            .map(|g| g.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let nnz = self
            .sweep
            .blocks
            .iter()
            .map(|b| b.slots.len().to_string())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"method\":\"spatial-KLU-fixed-forward-energy-GS-local-history\",\"energyGroupOrderZeroBased\":[{order}],\"groupCount\":{GROUPS},\"rowsPerGroup\":{},\"nonzerosPerGroup\":[{nnz}],\"setupAttempts\":{},\"factorAttempts\":{},\"spatialSolveAttempts\":{},\"preconditionerSolveAttempts\":{},\"assemblySeconds\":{},\"factorSeconds\":{},\"groupFactorSeconds\":{},\"spatialSolveSeconds\":{},\"historySolveSeconds\":{},\"setupSeconds\":{},\"solveSeconds\":{}}}",
            self.sweep.regions,
            self.setups,
            self.sweep.factors,
            self.sweep.spatial_solves,
            self.solves,
            finite(self.assembly_seconds),
            finite(self.factor_seconds),
            numbers(&self.sweep.group_factor_seconds),
            finite(self.sweep.spatial_solve_seconds),
            finite(self.history_solve_seconds),
            finite(self.setup_seconds),
            finite(self.solve_seconds)
        )
    }
    pub(super) fn new(model: &Evolution) -> Result<Self, String> {
        Ok(Self {
            sweep: GroupSweep::new(
                model.region_count(),
                model.nc_dimension(),
                model.nc_pattern(),
            )?,
            work: model.workspace(),
            history: model.history_preconditioner(),
            coefficients: vec![0.; model.nc_pattern().len()],
            rhs: vec![0.; model.state_count()],
            nc_rhs: vec![0.; model.nc_dimension()],
            setups: 0,
            solves: 0,
            setup_seconds: 0.,
            solve_seconds: 0.,
            assembly_seconds: 0.,
            factor_seconds: 0.,
            history_solve_seconds: 0.,
            valid: false,
            cj: 0.,
        })
    }
    pub(super) fn setup(
        &mut self,
        model: &Evolution,
        state: &[f64],
        cj: f64,
        memory: Handle,
        started: Instant,
        last: f64,
    ) -> Result<(), String> {
        let start = Instant::now();
        self.valid = false;
        self.setups += 1;
        self.phase("group-setup-enter", None, cj, memory, started, last, None)?;
        model
            .evaluate_into(state, &mut self.work)
            .map_err(str::to_owned)?;
        model
            .nc_values(&self.work, cj, &mut self.coefficients)
            .map_err(str::to_owned)?;
        model
            .prepare_history_preconditioner(&self.work, cj, &mut self.history)
            .map_err(str::to_owned)?;
        self.sweep.assemble(&self.coefficients)?;
        self.assembly_seconds += start.elapsed().as_secs_f64();
        for g in 0..GROUPS {
            self.phase(
                "spatial-factor-enter",
                Some(g),
                cj,
                memory,
                started,
                last,
                None,
            )?;
            let status = self.sweep.factor_group(g);
            self.factor_seconds = self.sweep.factor_seconds;
            self.phase(
                "spatial-factor-exit",
                Some(g),
                cj,
                memory,
                started,
                last,
                Some(status),
            )?;
            checked(status, "Spatial-group numeric KLU setup")?;
        }
        self.valid = true;
        self.cj = cj;
        self.setup_seconds += start.elapsed().as_secs_f64();
        self.phase("group-setup-exit", None, cj, memory, started, last, Some(0))
    }
    pub(super) fn solve(&mut self, model: &Evolution, r: Handle, z: Handle) -> Result<(), String> {
        self.solve_selected(model, r, z, false)
    }
    pub(super) fn solve_solver_coordinates(
        &mut self,
        model: &Evolution,
        r: Handle,
        z: Handle,
    ) -> Result<(), String> {
        self.solve_selected(model, r, z, true)
    }
    fn solve_selected(
        &mut self,
        model: &Evolution,
        r: Handle,
        z: Handle,
        solver_coordinates: bool,
    ) -> Result<(), String> {
        let start = Instant::now();
        if !self.valid {
            return Err("Unprepared spatial/history preconditioner".into());
        }
        self.solves += 1;
        let n = self.rhs.len();
        self.rhs.copy_from_slice(unsafe { values(r, n) }?);
        let defect_rhs = self.rhs[model.ledger_row()];
        if solver_coordinates {
            self.rhs[model.ledger_row()] =
                self.rhs[..model.nc_dimension()].iter().sum::<f64>() - defect_rhs;
        }
        let xcf = self
            .history
            .prepare_nc_rhs(&self.rhs, &mut self.nc_rhs)
            .map_err(str::to_owned)?;
        let solution = unsafe { output(z, n) }?;
        solution.fill(0.);
        self.sweep.solve(
            &self.coefficients,
            &self.nc_rhs,
            &mut solution[..model.nc_dimension()],
        )?;
        solution[model.cf_row()] = xcf;
        let t = Instant::now();
        let history_result = model
            .solve_preconditioner_history(&mut self.work, &self.history, &self.rhs, solution)
            .map_err(str::to_owned);
        self.history_solve_seconds += t.elapsed().as_secs_f64();
        self.solve_seconds += start.elapsed().as_secs_f64();
        history_result?;
        if solver_coordinates {
            // Algebraically T P^-1 T^-1, evaluated directly in this row to
            // avoid subtracting two large nearly equal intermediate counts.
            solution[model.ledger_row()] = defect_rhs / self.cj;
        }
        if solution.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite preconditioner result".into());
        }
        Ok(())
    }
    pub(super) fn phase(
        &self,
        phase: &str,
        group: Option<usize>,
        cj: f64,
        memory: Handle,
        started: Instant,
        last: f64,
        status: Option<i32>,
    ) -> Result<(), String> {
        let (stats, error) = telemetry_stats(memory);
        println!(
            "{{\"kind\":\"solver-phase\",\"phase\":{},\"energyGroupIndex\":{},\"lastAdmittedTime\":{},\"aggregateElapsedSeconds\":{},\"cj\":{},\"setupAttempts\":{},\"completedSetupSeconds\":{},\"completedAssemblySeconds\":{},\"completedFactorSeconds\":{},\"spatialFactorAttempts\":{},\"spatialSolveAttempts\":{},\"spatialSolveSeconds\":{},\"historySolveSeconds\":{},\"preconditionerSolveAttempts\":{},\"completedPreconditionerSolveSeconds\":{},\"preconditionerMetrics\":{},\"status\":{},\"solverStats\":{stats},\"telemetryStatsError\":{error}}}",
            quote(phase),
            group.map_or("null".into(), |g| g.to_string()),
            finite(last),
            finite(started.elapsed().as_secs_f64()),
            finite(cj),
            self.setups,
            finite(self.setup_seconds),
            finite(self.assembly_seconds),
            finite(self.factor_seconds),
            self.sweep.factors,
            self.sweep.spatial_solves,
            finite(self.sweep.spatial_solve_seconds),
            finite(self.history_solve_seconds),
            self.solves,
            finite(self.solve_seconds),
            self.metrics_json(),
            status.map_or("null".into(), |s| s.to_string())
        );
        io::stdout()
            .flush()
            .map_err(|e| format!("Solver phase flush: {e}"))
    }
}

#[cfg(test)]
#[path = "../../tests/source_evolution.rs"]
mod fixture;
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entire_selected_lower_preconditioner_has_its_declared_stage_residual() {
        let model = Evolution::new(fixture::input()).unwrap();
        let state = model.initial_state();
        let mut p = Preconditioner::new(&model).unwrap();
        let cj = 2.5;
        p.setup(&model, &state, cj, std::ptr::null_mut(), Instant::now(), 0.)
            .unwrap();
        let rhs = (0..model.state_count())
            .map(|i| 0.02 * (i % 9) as f64 - 0.07)
            .collect::<Vec<_>>();
        let mut vectors = Resources::new().unwrap();
        let r = vectors.vector(&rhs).unwrap();
        let z = vectors.vector(&vec![0.; rhs.len()]).unwrap();
        p.solve(&model, r, z).unwrap();
        let x = unsafe { values(z, rhs.len()) }.unwrap().to_vec();
        // Independently apply the ORIGINAL exact Jacobian. At the zero-field
        // fixture, off-target history capture sensitivities vanish. Number
        // completion is an exact row combination, not the approximate ledger
        // row previously inherited from the dropped history feedback.
        let mut work = model.workspace();
        model.evaluate_into(&state, &mut work).unwrap();
        model.jvp_into(&x, &mut work).unwrap();
        let tangent = work.rate_jvp().unwrap().to_vec();
        for row in model.nc_dimension()..rhs.len() {
            if row == model.ledger_row() {
                continue;
            }
            let applied = cj * x[row] - tangent[row];
            assert!(
                (applied - rhs[row]).abs() < 3e-13,
                "history row{row}: {applied:e} != {:e}",
                rhs[row]
            );
        }
        let px = model.conservation(&x).unwrap();
        let b = model.conservation(&rhs).unwrap();
        assert!((cj * px.neutron_ledger_defect - b.neutron_ledger_defect).abs() < 3e-13);
        assert!((cj * px.energy_ledger_defect_j - b.energy_ledger_defect_j).abs() < 3e-13);
        let mut only_cf = vec![0.; rhs.len()];
        only_cf[model.cf_row()] = x[model.cf_row()];
        model.jvp_into(&only_cf, &mut work).unwrap();
        let cf_force = work.rate_jvp().unwrap();
        let n = model.region_count() * GROUPS;
        let mut applied = vec![0.; model.nc_dimension()];
        for (&(row, col), &a) in model.nc_pattern().iter().zip(&p.coefficients) {
            if (row < n && col < n && col % GROUPS <= row % GROUPS) || row >= n {
                applied[row] += a * x[col];
            }
        }
        for row in 0..model.nc_dimension() {
            applied[row] -= cf_force[row];
            assert!((applied[row] - rhs[row]).abs() < 3e-13, "NC row{row}");
        }
        // Refreshing JT's independent workspace must not invalidate Pstage.
        let mut another = state.clone();
        another[0] = 0.2;
        model.evaluate_into(&another, &mut work).unwrap();
        p.solve(&model, r, z).unwrap();
        assert_eq!(unsafe { values(z, rhs.len()) }.unwrap(), x);
    }
    #[test]
    fn spatial_group_sweep_matches_its_signed_block_triangular_matrix() {
        let regions = 2;
        let n = regions * GROUPS;
        let nc = n + 2;
        let mut pattern = Vec::new();
        let mut coefficients = Vec::new();
        for r in 0..n {
            for c in 0..n {
                let v = if r == c {
                    4. + (r % GROUPS) as f64
                } else if r % GROUPS == c % GROUPS {
                    -0.3
                } else if r % GROUPS > c % GROUPS && r / GROUPS == c / GROUPS {
                    -0.02 * (1 + c % GROUPS) as f64
                } else if r % GROUPS < c % GROUPS && r / GROUPS == c / GROUPS {
                    0.01
                } else {
                    continue;
                };
                pattern.push((r, c));
                coefficients.push(v);
            }
        }
        for r in n..nc {
            pattern.push((r, r));
            coefficients.push(3.);
            pattern.push((r, r - n));
            coefficients.push(-0.4);
        }
        // Precursor->N is deliberately omitted in P, not silently included.
        pattern.push((0, n));
        coefficients.push(-0.2);
        let mut p = GroupSweep::new(regions, nc, &pattern).unwrap();
        p.assemble(&coefficients).unwrap();
        for g in 0..GROUPS {
            checked(p.factor_group(g), "Test spatial factor").unwrap();
        }
        let exact = (0..nc).map(|i| 0.2 - 0.03 * i as f64).collect::<Vec<_>>();
        let mut rhs = vec![0.; nc];
        for (&(r, c), &a) in pattern.iter().zip(&coefficients) {
            if (r < n && c < n && c % GROUPS <= r % GROUPS) || r >= n {
                rhs[r] += a * exact[c];
            }
        }
        let mut result = vec![0.; nc];
        p.solve(&coefficients, &rhs, &mut result).unwrap();
        for (a, b) in result.iter().zip(&exact) {
            assert!((a - b).abs() < 2e-14);
        }
        assert_eq!(p.factors, GROUPS as u64);
        assert_eq!(p.spatial_solves, GROUPS as u64);
        // A second current-cj factor refresh uses the SAME symbolic pattern.
        for (k, &(r, c)) in pattern.iter().enumerate() {
            if r == c {
                coefficients[k] += 7.;
            }
        }
        p.assemble(&coefficients).unwrap();
        for g in 0..GROUPS {
            checked(p.factor_group(g), "Test refreshed spatial factor").unwrap();
        }
        rhs.fill(0.);
        for (&(r, c), &a) in pattern.iter().zip(&coefficients) {
            if (r < n && c < n && c % GROUPS <= r % GROUPS) || r >= n {
                rhs[r] += a * exact[c];
            }
        }
        p.solve(&coefficients, &rhs, &mut result).unwrap();
        for (a, b) in result.iter().zip(&exact) {
            assert!((a - b).abs() < 2e-14);
        }
        let mut invalid = pattern.clone();
        invalid.push((n, n + 1));
        assert!(GroupSweep::new(regions, nc, &invalid).is_err());
    }
}

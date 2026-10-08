//! Fixed component block P. Exact coupled chains remain in the outer JVP.
//! Source retains its selected energy ILU/precursor/slow factors. Thermal E/T,
//! fluid and carrier advection each have their own immutable numerical stage.
use super::{ida_support::*, output, source_block, values};
use leitbild_plant_numerics::{
    source_cooling::{Model, Workspace},
    source_evolution::Jacobian,
};
use std::{
    collections::{BTreeSet, HashMap},
    time::Instant,
};

pub(super) struct Sparse {
    resources: Resources,
    b: Handle,
    x: Handle,
    pointers: Vec<i64>,
    rows: Vec<i64>,
    lookup: HashMap<(usize, usize), usize>,
    values: Vec<f64>,
    size: usize,
}
impl Sparse {
    pub(super) fn new(
        size: usize,
        coordinates: impl IntoIterator<Item = (usize, usize)>,
    ) -> Result<Self, String> {
        let mut p = coordinates
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if size == 0 || p.iter().any(|&(r, c)| r >= size || c >= size) {
            return Err("Invalid coupled P pattern".into());
        }
        p.sort_unstable_by_key(|&(r, c)| (c, r));
        let mut pointers = vec![0; size + 1];
        let mut rows = Vec::with_capacity(p.len());
        let mut lookup = HashMap::new();
        for (i, &(r, c)) in p.iter().enumerate() {
            pointers[c + 1] += 1;
            rows.push(r as i64);
            lookup.insert((r, c), i);
        }
        for i in 0..size {
            pointers[i + 1] += pointers[i];
        }
        // Mechanical multipliers and continuity form a DAE saddle-point
        // block: a structural diagonal in every row is NOT a rank condition.
        // KLU supplies its normal row/column pivoting; no zero entries added.
        let mut resources = Resources::new()?;
        let b = resources.vector(&vec![0.; size])?;
        let x = resources.vector(&vec![0.; size])?;
        resources.matrix(size as i64, p.len() as i64)?;
        resources.solver(x)?;
        checked(
            unsafe { SUNLinSolInitialize(resources.solver) },
            "Initialize coupled KLU",
        )?;
        Ok(Self {
            resources,
            b,
            x,
            pointers,
            rows,
            lookup,
            values: vec![0.; p.len()],
            size,
        })
    }
    pub(super) fn add(&mut self, r: usize, c: usize, v: f64) -> Result<(), String> {
        let slot = self
            .lookup
            .get(&(r, c))
            .ok_or("Coupled P emission outside immutable pattern")?;
        self.values[*slot] += v;
        Ok(())
    }
    pub(super) fn clear(&mut self) {
        self.values.fill(0.);
    }
    pub(super) fn factor(&mut self) -> Result<(), String> {
        if self.values.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite coupled P matrix".into());
        }
        matrix_data(
            self.resources.matrix,
            &self.pointers,
            &self.rows,
            &self.values,
        )?;
        checked(
            unsafe { SUNLinSolSetup(self.resources.solver, self.resources.matrix) },
            "Factor coupled KLU",
        )
    }
    pub(super) fn solve(&mut self, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
        if rhs.len() != self.size || out.len() != self.size || rhs.iter().any(|v| !v.is_finite()) {
            return Err("Invalid coupled P RHS".into());
        }
        unsafe { output(self.b, self.size) }?.copy_from_slice(rhs);
        checked(
            unsafe {
                SUNLinSolSolve(
                    self.resources.solver,
                    self.resources.matrix,
                    self.x,
                    self.b,
                    0.,
                )
            },
            "Solve coupled KLU",
        )?;
        out.copy_from_slice(unsafe { values(self.x, self.size) }?);
        if out.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite coupled P solution".into());
        }
        Ok(())
    }
    /// Contributor-scaled backward error of the actual assembled matrix.
    pub(super) fn backward_error(&self, rhs: &[f64], x: &[f64]) -> (usize, f64, f64, f64) {
        let mut residual = rhs.iter().map(|v| -v).collect::<Vec<_>>();
        let mut scale = rhs.iter().map(|v| v.abs()).collect::<Vec<_>>();
        for (c, &xc) in x.iter().enumerate() {
            for slot in self.pointers[c] as usize..self.pointers[c + 1] as usize {
                let r = self.rows[slot] as usize;
                let v = self.values[slot] * xc;
                residual[r] += v;
                scale[r] += v.abs();
            }
        }
        residual
            .iter()
            .zip(scale)
            .enumerate()
            .map(|(r, (v, s))| (r, if s == 0. { v.abs() } else { v.abs() / s }, v.abs(), s))
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .unwrap()
    }
}
pub(super) struct Preconditioner {
    source: source_block::BlockPreconditioner,
    source_jac: Jacobian,
    source_values: Vec<f64>,
    thermal: Sparse,
    fluid: Sparse,
    fluid_rows: Vec<usize>,
    fluid_indices: HashMap<usize, usize>,
    fluid_rhs: Vec<f64>,
    fluid_solution: Vec<f64>,
    barrel: Sparse,
    absorber_guide: Sparse,
    receipt_cj: f64,
    work: Workspace,
    valid: bool,
    setups: u64,
    solves: u64,
    setup_seconds: f64,
    solve_seconds: f64,
}
impl Preconditioner {
    pub fn new(
        model: &Model,
        initial: &[f64],
        yp: &[f64],
        prhr: Option<leitbild_plant_numerics::prhr::Input>,
    ) -> Result<Self, String> {
        let mut work = model.workspace();
        model.evaluate_with_prhr_input(initial, yp, Some(1.), &mut work, prhr)?;
        let source_jac = Jacobian::new(&model.source)?;
        let source = source_block::BlockPreconditioner::new(&model.source, source_jac.pattern())?;
        let source_values = vec![0.; source_jac.pattern().len()];
        let nt = model.thermal.node_count();
        let mut thermal_pattern = Vec::new();
        for i in 0..nt {
            thermal_pattern.extend([(i, i), (nt + i, i), (nt + i, nt + i)]);
        }
        model
            .thermal
            .visit_heat_derivatives(&work.thermal, |r, c, _| thermal_pattern.push((r, nt + c)))?;
        let thermal = Sparse::new(2 * nt, thermal_pattern)?;
        let fluid_rows = model.fluid_rows().collect::<Vec<_>>();
        let fluid_indices = fluid_rows
            .iter()
            .enumerate()
            .map(|(i, &r)| (r, i))
            .collect::<HashMap<_, _>>();
        if fluid_indices.len() != fluid_rows.len() {
            return Err("Duplicate coupled fluid coordinate".into());
        }
        let mut fluid_pattern = Vec::new();
        let mut invalid = false;
        model.visit_fluid_jacobian(&work, |r, c, _| {
            match (fluid_indices.get(&r), fluid_indices.get(&c)) {
                (Some(&r), Some(&c)) => fluid_pattern.push((r, c)),
                _ => invalid = true,
            }
        })?;
        if invalid {
            return Err("Fluid P emission outside owned border".into());
        }
        let fluid = Sparse::new(fluid_rows.len(), fluid_pattern)?;
        let fluid_rhs = vec![0.; fluid_rows.len()];
        let fluid_solution = vec![0.; fluid_rows.len()];
        let barrel = Sparse::new(4, [(0, 0), (0, 1), (1, 0), (1, 1), (2, 2), (3, 3)])?;
        let nh = model.absorber_guide.host_count();
        let mut host_pattern = Vec::new();
        for i in 0..nh {
            host_pattern.extend([(i, i), (nh + i, i), (nh + i, nh + i)]);
        }
        model
            .absorber_guide
            .visit_host_jacobian(&work.absorber_guide, |r, c, _| {
                host_pattern.push((r, nh + c))
            })?;
        let absorber_guide = Sparse::new(2 * nh, host_pattern)?;
        Ok(Self {
            source,
            source_jac,
            source_values,
            thermal,
            fluid,
            fluid_rows,
            fluid_indices,
            fluid_rhs,
            fluid_solution,
            barrel,
            absorber_guide,
            receipt_cj: 0.,
            work,
            valid: false,
            setups: 0,
            solves: 0,
            setup_seconds: 0.,
            solve_seconds: 0.,
        })
    }
    pub fn setup(
        &mut self,
        model: &Model,
        y: &[f64],
        yp: &[f64],
        cj: f64,
        prhr: Option<leitbild_plant_numerics::prhr::Input>,
    ) -> Result<(), String> {
        self.valid = false;
        self.receipt_cj = cj;
        let started = Instant::now();
        self.setups += 1;
        let result = (|| {
            if !cj.is_finite() || cj <= 0. {
                return Err("Nonpositive coupled P cj".into());
            }
            model.evaluate_with_prhr_input(y, yp, Some(cj), &mut self.work, prhr)?;
            self.source_jac.solver_values(
                &model.source,
                &mut self.work.source,
                cj,
                &mut self.source_values,
            )?;
            self.source.setup(&self.source_values)?;
            self.fluid.values.fill(0.);
            let mut fluid_error = None;
            model.visit_fluid_jacobian(&self.work, |r, c, v| {
                if fluid_error.is_none() {
                    fluid_error = match (self.fluid_indices.get(&r), self.fluid_indices.get(&c)) {
                        (Some(&r), Some(&c)) => self.fluid.add(r, c, v).err(),
                        _ => Some("Fluid P emission outside owned border".into()),
                    };
                }
            })?;
            if let Some(error) = fluid_error {
                return Err(error);
            }
            self.fluid.factor()?;
            self.thermal.values.fill(0.);
            let nt = model.thermal.node_count();
            for (i, &capacity) in self.work.thermal.capacities()?.iter().enumerate() {
                self.thermal.add(i, i, cj)?;
                self.thermal.add(nt + i, i, 1.)?;
                self.thermal.add(nt + i, nt + i, -capacity)?;
            }
            let mut error = None;
            model
                .thermal
                .visit_heat_derivatives(&self.work.thermal, |r, c, v| {
                    if error.is_none() {
                        error = self.thermal.add(r, nt + c, -v).err();
                    }
                })?;
            if let Some(e) = error {
                return Err(e);
            }
            self.thermal.factor()?;
            self.barrel.values.fill(0.);
            self.barrel.add(0, 0, cj)?;
            let b = model.barrel.config();
            self.barrel.add(
                0,
                1,
                b.wet_h_w_m2_k * b.contacts.iter().map(|c| c.area_m2).sum::<f64>(),
            )?;
            self.barrel.add(1, 0, 1.)?;
            self.barrel.add(1, 1, -self.work.barrel.capacity()?)?;
            self.barrel.add(2, 2, cj)?;
            self.barrel.add(3, 3, cj)?;
            self.barrel.factor()?;
            self.absorber_guide.clear();
            let nh = model.absorber_guide.host_count();
            for (i, &capacity) in self.work.absorber_guide.capacity.iter().enumerate() {
                self.absorber_guide.add(i, i, cj)?;
                self.absorber_guide.add(nh + i, i, 1.)?;
                self.absorber_guide.add(nh + i, nh + i, -capacity)?;
            }
            let mut error = None;
            model
                .absorber_guide
                .visit_host_jacobian(&self.work.absorber_guide, |r, c, v| {
                    if error.is_none() {
                        error = self.absorber_guide.add(r, nh + c, -v).err();
                    }
                })?;
            if let Some(e) = error {
                return Err(e);
            }
            self.absorber_guide.factor()?;
            Ok(())
        })();
        self.setup_seconds += started.elapsed().as_secs_f64();
        self.valid = result.is_ok();
        result
    }
    pub fn solve(&mut self, model: &Model, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
        let started = Instant::now();
        self.solves += 1;
        let result = (|| {
            if !self.valid || rhs.len() != model.dimension() || out.len() != model.dimension() {
                return Err("Unavailable coupled P snapshot".into());
            }
            let l = model.layout;
            self.source
                .solve(&rhs[..l.source_end], &mut out[..l.source_end])?;
            for (i, &r) in self.fluid_rows.iter().enumerate() {
                self.fluid_rhs[i] = rhs[r];
            }
            self.fluid
                .solve(&self.fluid_rhs, &mut self.fluid_solution)?;
            for (i, &r) in self.fluid_rows.iter().enumerate() {
                out[r] = self.fluid_solution[i];
            }
            self.thermal.solve(
                &rhs[l.energies_start..l.barrel_energy],
                &mut out[l.energies_start..l.barrel_energy],
            )?;
            self.barrel.solve(
                &rhs[l.barrel_energy..l.pressurizer_start],
                &mut out[l.barrel_energy..l.pressurizer_start],
            )?;
            self.absorber_guide.solve(
                &rhs[l.absorber_guide_energies_start..l.absorber_guide_exported],
                &mut out[l.absorber_guide_energies_start..l.absorber_guide_exported],
            )?;
            for r in [
                l.fuel_capture_exported,
                l.mobile_capture_exported,
                l.mobile_capture_boundary_exported,
                l.absorber_guide_exported,
            ] {
                out[r] = rhs[r] / self.receipt_cj;
                if !out[r].is_finite() {
                    return Err("Nonfinite binding export preconditioner solution".into());
                }
            }
            Ok(())
        })();
        self.solve_seconds += started.elapsed().as_secs_f64();
        if result.is_err() {
            self.valid = false;
        }
        result
    }
    pub fn metrics_json(&self) -> String {
        format!(
            "{{\"identity\":\"source9-thermalETKLU-coupledPrimarySurgePZRMaterialKLU-barrelETauditsKLU-absorberGuideETKLU;remaining-cross-component-feedback-outer-only\",\"setups\":{},\"solves\":{},\"setupSeconds\":{},\"solveSeconds\":{},\"source\":{}}}",
            self.setups,
            self.solves,
            self.setup_seconds,
            self.solve_seconds,
            self.source.metrics_json()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::cooling_fixture as fixture;
    use super::*;
    fn action(matrix: &Sparse, x: &[f64]) -> Vec<f64> {
        let mut b = vec![0.; matrix.size];
        for (&(r, c), &k) in &matrix.lookup {
            b[r] += matrix.values[k] * x[c];
        }
        b
    }
    #[test]
    fn independent_thermal_action_exact_block_solve_and_refresh() {
        let model = fixture::fixture();
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let mut p = Preconditioner::new(&model, &y, &yp, None).unwrap();
        let nt = model.thermal.node_count();
        for cj in [3., 19.] {
            p.setup(&model, &y, &yp, cj, None).unwrap();
            let x = (0..2 * nt)
                .map(|i| 0.01 * (i + 1) as f64)
                .collect::<Vec<_>>();
            // Independent directional consumer, not the derivative emitter
            // used to construct the matrix itself.
            model
                .thermal
                .jvp_into(
                    &x[nt..],
                    &vec![0.; nt],
                    &vec![
                        leitbild_plant_numerics::fuel_thermal::WaterDirection::default();
                        model.carrier.cells()
                    ],
                    &mut p.work.thermal,
                )
                .unwrap();
            let mut expected = vec![0.; 2 * nt];
            for i in 0..nt {
                expected[i] = cj * x[i] - p.work.thermal.heat_jvp().unwrap()[i];
                expected[nt + i] = x[i] - p.work.thermal.energy_jvp().unwrap()[i];
            }
            let actual = action(&p.thermal, &x);
            for (&a, &b) in actual.iter().zip(&expected) {
                assert!((a - b).abs() < 1e-11 * (1. + a.abs() + b.abs()));
            }
            let mut solved = vec![0.; 2 * nt];
            p.thermal.solve(&expected, &mut solved).unwrap();
            for (&a, &b) in solved.iter().zip(&x) {
                assert!((a - b).abs() < 1e-10 * (1. + b.abs()), "{a} vs {b}");
            }
            let x = (0..p.fluid.size)
                .map(|i| 0.001 / (1. + i as f64))
                .collect::<Vec<_>>();
            let rhs = action(&p.fluid, &x);
            let mut out = vec![0.; x.len()];
            p.fluid.solve(&rhs, &mut out).unwrap();
            for (&a, &b) in out.iter().zip(&x) {
                assert!((a - b).abs() < 1e-9 * (1. + b.abs()));
            }
        }
    }
    #[test]
    fn failed_setup_and_solve_invalidate_whole_snapshot() {
        let model = fixture::fixture();
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let mut p = Preconditioner::new(&model, &y, &yp, None).unwrap();
        p.setup(&model, &y, &yp, 3., None).unwrap();
        let n = model.dimension();
        assert!(p
            .solve(&model, &vec![f64::NAN; n], &mut vec![0.; n])
            .is_err());
        assert!(p.solve(&model, &vec![0.; n], &mut vec![0.; n]).is_err());
        p.setup(&model, &y, &yp, 3., None).unwrap();
        let mut receipt_rhs = vec![0.; n];
        receipt_rhs[model.layout.fuel_capture_exported] = 12.;
        let mut solved = vec![0.; n];
        p.solve(&model, &receipt_rhs, &mut solved).unwrap();
        assert_eq!(solved[model.layout.fuel_capture_exported], 4.);
        receipt_rhs[model.layout.fuel_capture_exported] = f64::INFINITY;
        assert!(p.solve(&model, &receipt_rhs, &mut solved).is_err());
        assert!(p.solve(&model, &vec![0.; n], &mut solved).is_err());
        p.setup(&model, &y, &yp, 3., None).unwrap();
        assert!(p.setup(&model, &y, &yp, 0., None).is_err());
        assert!(p.solve(&model, &vec![0.; n], &mut vec![0.; n]).is_err());
    }
    #[test]
    fn barrel_block_matches_independent_held_water_jvp_and_refresh() {
        let model = fixture::fixture();
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let mut p = Preconditioner::new(&model, &y, &yp, None).unwrap();
        for cj in [0.1, 7., 1e12] {
            p.setup(&model, &y, &yp, cj, None).unwrap();
            let x = [0.3, 0.02, -0.4, 0.5];
            model
                .barrel
                .jvp(
                    x[1],
                    &[0.; 4],
                    0.,
                    &vec![
                        leitbild_plant_numerics::barrel_thermal::WaterDirection::default();
                        model.carrier.cells()
                    ],
                    &mut p.work.barrel,
                )
                .unwrap();
            let expected = [
                cj * x[0] - p.work.barrel.heat_jvp().unwrap(),
                x[0] - p.work.barrel.capacity().unwrap() * x[1],
                cj * x[2],
                cj * x[3],
            ];
            let actual = action(&p.barrel, &x);
            for (&a, &b) in actual.iter().zip(&expected) {
                assert!((a - b).abs() <= 1e-14 * (1. + a.abs() + b.abs()));
            }
            let mut solved = [0.; 4];
            p.barrel.solve(&expected, &mut solved).unwrap();
            for (&a, &b) in solved.iter().zip(&x) {
                assert!((a - b).abs() <= 1e-11 * (1. + b.abs()));
            }
        }
    }
    #[test]
    fn finite_body_guide_block_matches_current_host_action_and_sparse_solve() {
        let model = fixture::fixture();
        let l = model.layout;
        let mut y = model.initial_state().unwrap();
        y[l.absorber_guide_temperatures_start + 1] = 310.;
        y[l.absorber_guide_temperatures_start + 2] = 295.;
        let yp = vec![0.; model.dimension()];
        let mut p = Preconditioner::new(&model, &y, &yp, None).unwrap();
        let nh = model.absorber_guide.host_count();
        for cj in [0.1, 7., 1e12] {
            p.setup(&model, &y, &yp, cj, None).unwrap();
            let x = (0..2 * nh)
                .map(|i| 0.02 * (i + 1) as f64)
                .collect::<Vec<_>>();
            let mut direction = vec![0.; model.dimension()];
            direction[l.absorber_guide_energies_start..l.absorber_guide_exported]
                .copy_from_slice(&x);
            model.jvp(&direction, cj, &mut p.work).unwrap();
            let expected =
                p.work.jvp[l.absorber_guide_energies_start..l.absorber_guide_exported].to_vec();
            let actual = action(&p.absorber_guide, &x);
            for (&a, &b) in actual.iter().zip(&expected) {
                assert!((a - b).abs() < 1e-11 * (1. + a.abs() + b.abs()));
            }
            let mut solved = vec![0.; 2 * nh];
            p.absorber_guide.solve(&expected, &mut solved).unwrap();
            for (&a, &b) in solved.iter().zip(&x) {
                assert!((a - b).abs() < 1e-10 * (1. + b.abs()));
            }
        }
    }
}

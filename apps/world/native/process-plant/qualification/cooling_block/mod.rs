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

struct Sparse {
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
    fn new(
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
    fn add(&mut self, r: usize, c: usize, v: f64) -> Result<(), String> {
        let slot = self
            .lookup
            .get(&(r, c))
            .ok_or("Coupled P emission outside immutable pattern")?;
        self.values[*slot] += v;
        Ok(())
    }
    fn factor(&mut self) -> Result<(), String> {
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
    fn solve(&mut self, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
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
}
pub(super) struct Preconditioner {
    source: source_block::BlockPreconditioner,
    source_jac: Jacobian,
    source_values: Vec<f64>,
    thermal: Sparse,
    network: Sparse,
    carrier: Sparse,
    barrel: Sparse,
    work: Workspace,
    valid: bool,
    setups: u64,
    solves: u64,
    setup_seconds: f64,
    solve_seconds: f64,
}
impl Preconditioner {
    pub fn new(model: &Model, initial: &[f64], yp: &[f64]) -> Result<Self, String> {
        let mut work = model.workspace();
        model.evaluate(initial, yp, Some(1.), &mut work)?;
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
        let n = &model.network;
        let mut network_pattern = Vec::new();
        for c in 0..n.dimension() {
            for k in n.column_pointers[c] as usize..n.column_pointers[c + 1] as usize {
                network_pattern.push((n.row_indices[k] as usize, c));
            }
        }
        let network = Sparse::new(n.dimension(), network_pattern)?;
        let mut carrier_pattern = (0..2 * model.carrier.cells())
            .map(|i| (i, i))
            .collect::<Vec<_>>();
        for e in model.carrier.links() {
            for s in 0..2 {
                carrier_pattern.extend([
                    (2 * e.from + s, 2 * e.to + s),
                    (2 * e.to + s, 2 * e.from + s),
                ]);
            }
        }
        let carrier = Sparse::new(2 * model.carrier.cells(), carrier_pattern)?;
        let barrel = Sparse::new(4, [(0, 0), (0, 1), (1, 0), (1, 1), (2, 2), (3, 3)])?;
        Ok(Self {
            source,
            source_jac,
            source_values,
            thermal,
            network,
            carrier,
            barrel,
            work,
            valid: false,
            setups: 0,
            solves: 0,
            setup_seconds: 0.,
            solve_seconds: 0.,
        })
    }
    pub fn setup(&mut self, model: &Model, y: &[f64], yp: &[f64], cj: f64) -> Result<(), String> {
        self.valid = false;
        let started = Instant::now();
        self.setups += 1;
        let result = (|| {
            if !cj.is_finite() || cj <= 0. {
                return Err("Nonpositive coupled P cj".into());
            }
            model.evaluate(y, yp, Some(cj), &mut self.work)?;
            self.source_jac.solver_values(
                &model.source,
                &mut self.work.source,
                cj,
                &mut self.source_values,
            )?;
            self.source.setup(&self.source_values)?;
            self.network
                .values
                .copy_from_slice(&self.work.network.jacobian_values);
            self.network.factor()?;
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
            self.carrier.values.fill(0.);
            for i in 0..2 * model.carrier.cells() {
                self.carrier.add(i, i, cj)?;
            }
            for (e, &q) in model
                .carrier
                .links()
                .iter()
                .zip(&self.work.network.mass_flows)
            {
                let (donor, receiver) = if q >= 0. {
                    (e.from, e.to)
                } else {
                    (e.to, e.from)
                };
                let a = q.abs() / self.work.network.chart_mass[donor];
                for s in 0..2 {
                    self.carrier.add(2 * donor + s, 2 * donor + s, a)?;
                    self.carrier.add(2 * receiver + s, 2 * donor + s, -a)?;
                }
            }
            self.carrier.factor()?;
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
            self.network.solve(
                &rhs[l.network_start..l.products_start],
                &mut out[l.network_start..l.products_start],
            )?;
            self.carrier.solve(
                &rhs[l.products_start..l.energies_start],
                &mut out[l.products_start..l.energies_start],
            )?;
            self.thermal.solve(
                &rhs[l.energies_start..l.barrel_energy],
                &mut out[l.energies_start..l.barrel_energy],
            )?;
            self.barrel
                .solve(&rhs[l.barrel_energy..], &mut out[l.barrel_energy..])?;
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
            "{{\"identity\":\"source9-thermalETKLU-networkKLU-carrierAdvectionKLU-barrelETauditsKLU;cross-component-feedback-outer-only\",\"setups\":{},\"solves\":{},\"setupSeconds\":{},\"solveSeconds\":{},\"source\":{}}}",
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
        let mut p = Preconditioner::new(&model, &y, &yp).unwrap();
        let nt = model.thermal.node_count();
        for cj in [3., 19.] {
            p.setup(&model, &y, &yp, cj).unwrap();
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
            let x = vec![0.3; 2 * model.carrier.cells()];
            let rhs = action(&p.carrier, &x);
            let mut out = vec![0.; x.len()];
            p.carrier.solve(&rhs, &mut out).unwrap();
            for (&a, &b) in out.iter().zip(&x) {
                assert!((a - b).abs() < 1e-12);
            }
        }
    }
    #[test]
    fn failed_setup_and_solve_invalidate_whole_snapshot() {
        let model = fixture::fixture();
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let mut p = Preconditioner::new(&model, &y, &yp).unwrap();
        p.setup(&model, &y, &yp, 3.).unwrap();
        let n = model.dimension();
        assert!(
            p.solve(&model, &vec![f64::NAN; n], &mut vec![0.; n])
                .is_err()
        );
        assert!(p.solve(&model, &vec![0.; n], &mut vec![0.; n]).is_err());
        p.setup(&model, &y, &yp, 3.).unwrap();
        assert!(p.setup(&model, &y, &yp, 0.).is_err());
        assert!(p.solve(&model, &vec![0.; n], &mut vec![0.; n]).is_err());
    }
    #[test]
    fn barrel_block_matches_independent_held_water_jvp_and_refresh() {
        let model = fixture::fixture();
        let y = model.initial_state().unwrap();
        let yp = vec![0.; model.dimension()];
        let mut p = Preconditioner::new(&model, &y, &yp).unwrap();
        for cj in [0.1, 7., 1e12] {
            p.setup(&model, &y, &yp, cj).unwrap();
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
}

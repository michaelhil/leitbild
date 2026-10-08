//! Fixed physical-energy forward block sweep of the complete signed-D matrix.
//! Seven spatial energy blocks, then complete precursors, then complete slow
//! states. All earlier-block forcing is exact; later feedback is omitted only
//! in P, never the full outer operator. Seven scalar spatial blocks use fixed
//! ILU(0); complete precursor and slow blocks retain KLU. No fallback/order sweep.
mod ilu0;
use super::ida_support::*;
use super::{output, values};
use ilu0::Ilu0;
use leitbild_plant_numerics::{fuel_source::GROUPS, source_evolution::Evolution};
use std::{
    collections::HashSet,
    io::{self, Write},
    time::Instant,
};

enum Factor {
    SpatialIlu0(Ilu0),
    RetainedKlu {
        owned: Resources,
        b: Handle,
        x: Handle,
        pointers: Vec<i64>,
        indices: Vec<i64>,
        repivots: KluRepivots,
    },
}
impl Factor {
    fn name(&self) -> &'static str {
        match self {
            Self::SpatialIlu0(_) => "fixed-pattern-ILU0",
            Self::RetainedKlu { .. } => "KLU",
        }
    }
}
struct Block {
    factor: Factor,
    size: usize,
    rows: Vec<usize>,
    slots: Vec<usize>,
    coefficients: Vec<f64>,
    earlier: Vec<(usize, usize, usize)>,
    earlier_values: Vec<f64>,
    rhs: Vec<f64>,
    factor_attempts: u64,
    factor_seconds: f64,
    solve_attempts: u64,
    solve_seconds: f64,
}
impl Block {
    fn new(
        rows: Vec<usize>,
        mut slots: Vec<usize>,
        earlier: Vec<(usize, usize, usize)>,
        local: &[usize],
        pattern: &[(usize, usize)],
        spatial: bool,
    ) -> Result<Self, String> {
        let size = rows.len();
        slots.sort_unstable_by_key(|&k| (local[pattern[k].1], local[pattern[k].0]));
        let mut pointers = vec![0i64; size + 1];
        let mut indices = Vec::with_capacity(slots.len());
        let mut diagonal = vec![false; size];
        for &k in &slots {
            let (r, c) = (local[pattern[k].0], local[pattern[k].1]);
            pointers[c + 1] += 1;
            indices.push(r as i64);
            if r == c {
                diagonal[r] = true;
            }
        }
        if diagonal.iter().any(|&present| !present) {
            return Err("Missing energy-ordered stage diagonal".into());
        }
        for c in 0..size {
            pointers[c + 1] += pointers[c];
        }
        let factor = if spatial {
            let coordinates = slots
                .iter()
                .map(|&k| (local[pattern[k].0], local[pattern[k].1]))
                .collect::<Vec<_>>();
            Factor::SpatialIlu0(Ilu0::new(size, &coordinates)?)
        } else {
            let mut owned = Resources::new()?;
            let b = owned.vector(&vec![0.; size])?;
            let x = owned.vector(&vec![0.; size])?;
            owned.matrix(size as i64, slots.len() as i64)?;
            owned.solver(x)?;
            checked(
                unsafe { SUNLinSolInitialize(owned.solver) },
                "Initialize retained KLU",
            )?;
            Factor::RetainedKlu {
                owned,
                b,
                x,
                pointers,
                indices,
                repivots: KluRepivots::default(),
            }
        };
        Ok(Self {
            factor,
            size,
            rows,
            coefficients: vec![0.; slots.len()],
            slots,
            earlier_values: vec![0.; earlier.len()],
            earlier,
            rhs: vec![0.; size],
            factor_attempts: 0,
            factor_seconds: 0.,
            solve_attempts: 0,
            solve_seconds: 0.,
        })
    }
    fn factor(&mut self, entries: &[f64], name: &str) -> Result<(), String> {
        for (a, &slot) in self.coefficients.iter_mut().zip(&self.slots) {
            *a = entries[slot];
        }
        for (a, &(_, _, slot)) in self.earlier_values.iter_mut().zip(&self.earlier) {
            *a = entries[slot];
        }
        println!(
            "{{\"kind\":\"block-factor-start\",\"block\":\"{name}\",\"factor\":\"{}\",\"rows\":{},\"nonzeros\":{},\"attempt\":{}}}",
            self.factor.name(),
            self.size,
            self.slots.len(),
            self.factor_attempts + 1
        );
        io::stdout()
            .flush()
            .map_err(|e| format!("Block factor progress flush: {e}"))?;
        let start = Instant::now();
        let result = match &mut self.factor {
            Factor::SpatialIlu0(ilu) => ilu.factor(&self.coefficients),
            Factor::RetainedKlu {
                owned,
                pointers,
                indices,
                repivots,
                ..
            } => matrix_data(owned.matrix, pointers, indices, &self.coefficients)
                .and_then(|()| setup_retained_klu(owned.solver, owned.matrix, name, repivots)),
        };
        let status = if result.is_ok() { 0 } else { -1 };
        let seconds = start.elapsed().as_secs_f64();
        self.factor_attempts += 1;
        self.factor_seconds += seconds;
        println!(
            "{{\"kind\":\"block-factor-complete\",\"block\":\"{name}\",\"status\":{status},\"seconds\":{seconds:e}}}"
        );
        io::stdout()
            .flush()
            .map_err(|e| format!("Block factor progress flush: {e}"))?;
        result
    }
    fn solve(&mut self, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
        for (b, &r) in self.rhs.iter_mut().zip(&self.rows) {
            *b = rhs[r];
        }
        for (&(r, c, _), &a) in self.earlier.iter().zip(&self.earlier_values) {
            self.rhs[r] -= a * out[c];
        }
        if self.rhs.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite earlier-block forcing".into());
        }
        let start = Instant::now();
        let result = match &mut self.factor {
            Factor::SpatialIlu0(ilu) => ilu.solve(&mut self.rhs),
            Factor::RetainedKlu { owned, b, x, .. } => (|| {
                unsafe { output(*b, self.size) }?.copy_from_slice(&self.rhs);
                checked(
                    unsafe { SUNLinSolSolve(owned.solver, owned.matrix, *x, *b, 0.) },
                    "Retained KLU solve",
                )?;
                self.rhs.copy_from_slice(unsafe { values(*x, self.size) }?);
                Ok(())
            })(),
        };
        self.solve_attempts += 1;
        self.solve_seconds += start.elapsed().as_secs_f64();
        result?;
        if self.rhs.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite energy-ordered solution".into());
        }
        for (&r, &v) in self.rows.iter().zip(&self.rhs) {
            out[r] = v;
        }
        Ok(())
    }
}

pub(super) struct BlockPreconditioner {
    size: usize,
    entries: usize,
    blocks: Vec<Block>,
    lower_nonzeros: usize,
    upper_nonzeros: usize,
    valid: bool,
    factor_failed: bool,
    setups: u64,
    solves: u64,
    setup_seconds: f64,
    solve_seconds: f64,
}
impl BlockPreconditioner {
    pub(super) fn new(model: &Evolution, pattern: &[(usize, usize)]) -> Result<Self, String> {
        Self::with_dimensions(
            model.state_count(),
            model
                .region_count()
                .checked_mul(GROUPS)
                .ok_or("Neutron size overflow")?,
            model.nc_dimension(),
            pattern,
        )
    }
    fn with_dimensions(
        size: usize,
        neutrons: usize,
        nc: usize,
        pattern: &[(usize, usize)],
    ) -> Result<Self, String> {
        if neutrons == 0
            || neutrons % GROUPS != 0
            || nc <= neutrons
            || nc >= size
            || i64::try_from(size).is_err()
            || i64::try_from(pattern.len()).is_err()
        {
            return Err("Invalid energy-ordered dimensions".into());
        }
        let mut seen = HashSet::with_capacity(pattern.len());
        for &(r, c) in pattern {
            if r >= size || c >= size || !seen.insert((r, c)) {
                return Err("Invalid/duplicate energy-ordered pattern entry".into());
            }
        }
        let labels = (0..size)
            .map(|r| {
                if r < neutrons {
                    r % GROUPS
                } else if r < nc {
                    GROUPS
                } else {
                    GROUPS + 1
                }
            })
            .collect::<Vec<_>>();
        let mut local = vec![0usize; size];
        let mut rows = vec![Vec::new(); GROUPS + 2];
        for (r, &label) in labels.iter().enumerate() {
            local[r] = rows[label].len();
            rows[label].push(r);
        }
        let mut diagonal_slots = vec![Vec::new(); GROUPS + 2];
        let mut earlier = vec![Vec::new(); GROUPS + 2];
        let mut upper_nonzeros = 0;
        for (k, &(r, c)) in pattern.iter().enumerate() {
            if labels[r] == labels[c] {
                diagonal_slots[labels[r]].push(k);
            } else if labels[r] > labels[c] {
                earlier[labels[r]].push((local[r], c, k));
            } else {
                upper_nonzeros += 1;
            }
        }
        let lower_nonzeros = earlier.iter().map(Vec::len).sum();
        let blocks = rows
            .into_iter()
            .zip(diagonal_slots)
            .zip(earlier)
            .enumerate()
            .map(|(i, ((rows, slots), earlier))| {
                Block::new(rows, slots, earlier, &local, pattern, i < GROUPS)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            size,
            entries: pattern.len(),
            blocks,
            lower_nonzeros,
            upper_nonzeros,
            valid: false,
            factor_failed: false,
            setups: 0,
            solves: 0,
            setup_seconds: 0.,
            solve_seconds: 0.,
        })
    }
    pub(super) fn setup(&mut self, entries: &[f64]) -> Result<(), String> {
        self.valid = false;
        self.setups += 1;
        let start = Instant::now();
        let result = (|| {
            if self.factor_failed {
                return Err("Energy-ordered factor previously failed; instance is terminal".into());
            }
            if entries.len() != self.entries || entries.iter().any(|v| !v.is_finite()) {
                return Err("Invalid/nonfinite energy-ordered stage entries".into());
            }
            for (i, block) in self.blocks.iter_mut().enumerate() {
                let name = if i < GROUPS {
                    format!("energy-{}", i + 1)
                } else if i == GROUPS {
                    "complete-precursor".into()
                } else {
                    "complete-slow".into()
                };
                if let Err(error) = block.factor(entries, &name) {
                    self.factor_failed = true;
                    return Err(error);
                }
            }
            Ok(())
        })();
        self.setup_seconds += start.elapsed().as_secs_f64();
        self.valid = result.is_ok();
        result
    }
    /// Applies the immutable P from the last successful setup. No current-J
    /// coefficients are consumed, and failed setup invalidates the whole P.
    /// A failed factor is terminal: no shift, retry or alternate factor is used.
    pub(super) fn solve(&mut self, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
        self.solves += 1;
        let start = Instant::now();
        let result = (|| {
            if !self.valid
                || rhs.len() != self.size
                || out.len() != self.size
                || rhs.iter().any(|v| !v.is_finite())
            {
                return Err("Unprepared/invalid energy-ordered solve".into());
            }
            out.fill(0.);
            for block in &mut self.blocks {
                block.solve(rhs, out)?;
            }
            Ok(())
        })();
        self.solve_seconds += start.elapsed().as_secs_f64();
        if result.is_err() {
            self.valid = false;
        }
        result
    }
    pub(super) fn metrics_json(&self) -> String {
        let block = |b: &Block| {
            format!(
                "{{\"factor\":\"{}\",\"rows\":{},\"nonzeros\":{},\"factorAttempts\":{},\"factorSeconds\":{:e},\"solveAttempts\":{},\"solveSeconds\":{:e},\"kluRepivots\":{}}}",
                b.factor.name(),
                b.size,
                b.slots.len(),
                b.factor_attempts,
                b.factor_seconds,
                b.solve_attempts,
                b.solve_seconds,
                match &b.factor {
                    Factor::RetainedKlu { repivots, .. } => repivots.json(),
                    Factor::SpatialIlu0(_) => "null".into(),
                },
            )
        };
        let blocks = self.blocks.iter().map(block).collect::<Vec<_>>().join(",");
        format!(
            "{{\"identity\":\"fixed-energy-1-to-7-ILU0-then-complete-precursor-and-slow-KLU-forward-sweep\",\"energyGroups\":{GROUPS},\"numericSnapshotOwned\":true,\"prepared\":{},\"setups\":{},\"solves\":{},\"setupSeconds\":{:e},\"solveSeconds\":{:e},\"lowerNonzeros\":{},\"omittedUpperNonzeros\":{},\"blocks\":[{blocks}]}}",
            self.valid,
            self.setups,
            self.solves,
            self.setup_seconds,
            self.solve_seconds,
            self.lower_nonzeros,
            self.upper_nonzeros,
        )
    }
}

#[cfg(test)]
#[path = "../../tests/source_evolution.rs"]
mod fixture;
#[cfg(test)]
mod tests {
    use super::*;
    use leitbild_plant_numerics::source_evolution::Jacobian;
    fn product(
        pattern: &[(usize, usize)],
        entries: &[f64],
        neutrons: usize,
        nc: usize,
        x: &[f64],
        lower: bool,
    ) -> Vec<f64> {
        let mut b = vec![0.; x.len()];
        for (&(r, c), &a) in pattern.iter().zip(entries) {
            let label = |i| {
                if i < neutrons {
                    i % GROUPS
                } else if i < nc {
                    GROUPS
                } else {
                    GROUPS + 1
                }
            };
            if !lower || label(r) >= label(c) {
                b[r] += a * x[c];
            }
        }
        b
    }
    #[test]
    fn complete_fixture_lower_block_action_zero_and_nonzero_and_refreshed_stage() {
        // This fixture has only two regions per energy, so ILU(0) drops no
        // fill. Its original lower-matrix action is therefore exact here;
        // ilu0's independent four-region tests cover the approximate case.
        let m = Evolution::new(fixture::input()).unwrap();
        let j = Jacobian::new(&m).unwrap();
        let mut p = BlockPreconditioner::new(&m, j.pattern()).unwrap();
        let mut w = m.workspace();
        let mut y = m.initial_state();
        let mut entries = vec![0.; j.pattern().len()];
        let x = (0..m.state_count())
            .map(|i| 0.1 - 0.003 * i as f64)
            .collect::<Vec<_>>();
        let mut out = vec![0.; x.len()];
        assert!(p.solve(&x, &mut out).is_err());
        for stage in 0..3 {
            if stage > 0 {
                y[..m.nc_dimension()].fill(2.);
                for v in &mut y[m.nc_dimension()..m.cf_row()] {
                    *v = 3.;
                }
                y[m.cf_row()] = 10.;
                y[m.water_row(0, false)] = 20.;
                y[m.water_row(0, true)] = 5.;
                for i in 0..4 {
                    y[m.target_row(i)] = 4. + i as f64;
                }
                y[m.mn_product_row(0)] = 1.;
            }
            if stage == 2 {
                y[m.target_row(0)] = 100. - y[m.mn_product_row(0)];
                y[m.target_row(1)] = 100.;
            }
            m.evaluate_into(&y, &mut w).unwrap();
            for cj in [3., 10.] {
                j.solver_values(&m, &mut w, cj, &mut entries).unwrap();
                let b = product(
                    j.pattern(),
                    &entries,
                    m.region_count() * GROUPS,
                    m.nc_dimension(),
                    &x,
                    true,
                );
                p.setup(&entries).unwrap();
                // Mutating the caller's current-J buffer cannot change frozen P.
                let frozen = entries.clone();
                entries.fill(f64::NAN);
                p.solve(&b, &mut out).unwrap();
                for (i, (&a, &expected)) in out.iter().zip(&x).enumerate() {
                    assert!(
                        (a - expected).abs() < 2e-10 * (1. + expected.abs()),
                        "row{i}: {a} != {expected}"
                    );
                }
                let applied = product(
                    j.pattern(),
                    &frozen,
                    m.region_count() * GROUPS,
                    m.nc_dimension(),
                    &out,
                    true,
                );
                for r in 0..x.len() {
                    assert!(
                        (applied[r] - b[r]).abs() < 2e-10 * (1. + b[r].abs()),
                        "selected P row{r}"
                    );
                }
                let full = product(
                    j.pattern(),
                    &frozen,
                    m.region_count() * GROUPS,
                    m.nc_dimension(),
                    &out,
                    false,
                );
                for r in m.nc_dimension()..x.len() {
                    assert!(
                        (full[r] - b[r]).abs() < 2e-10 * (1. + b[r].abs()),
                        "slow row{r}"
                    );
                }
                assert!(full[..m.nc_dimension()]
                    .iter()
                    .zip(&b)
                    .any(|(&a, &b)| (a - b).abs() > 1e-7));
            }
        }
        assert_eq!(p.setups, 6);
        assert_eq!(p.blocks.len(), GROUPS + 2);
        assert_eq!(p.blocks[0].rows, vec![0, GROUPS]);
        assert!(p.blocks[..GROUPS]
            .iter()
            .all(|b| matches!(b.factor, Factor::SpatialIlu0(_))));
        assert!(p.blocks[GROUPS..]
            .iter()
            .all(|b| matches!(b.factor, Factor::RetainedKlu { .. })));
        assert!(p.blocks.iter().all(|b| b.factor_attempts == 6));
        assert!(p.setup(&entries).is_err());
        assert!(p.solve(&x, &mut out).is_err());
        assert!(p.metrics_json().contains("\"prepared\":false"));
    }
    #[test]
    fn invalid_patterns_and_singular_refresh_fail_closed() {
        let n = GROUPS + 2;
        let nc = GROUPS + 1;
        let diagonal = (0..n).map(|r| (r, r)).collect::<Vec<_>>();
        let mut missing = diagonal.clone();
        missing.pop();
        let mut duplicate = diagonal.clone();
        duplicate.push((0, 0));
        let mut outside = diagonal.clone();
        outside.push((n, 0));
        for (size, neutrons, precursor_end, pattern) in [
            (n, 0, nc, diagonal.clone()),
            (n, GROUPS - 1, nc, diagonal.clone()),
            (n, GROUPS, GROUPS, diagonal.clone()),
            (n, GROUPS, n, diagonal.clone()),
            (n, GROUPS, nc, missing),
            (n, GROUPS, nc, duplicate),
            (n, GROUPS, nc, outside),
        ] {
            assert!(
                BlockPreconditioner::with_dimensions(size, neutrons, precursor_end, &pattern)
                    .is_err()
            );
        }
        let mut pattern = diagonal;
        pattern.push((n - 1, 0));
        let mut entries = vec![2.; n];
        entries.push(-3.);
        let mut rhs = vec![2.; n];
        rhs[n - 1] = -1.;
        let mut p = BlockPreconditioner::with_dimensions(n, GROUPS, nc, &pattern).unwrap();
        p.setup(&entries).unwrap();
        let mut out = vec![0.; n];
        p.solve(&rhs, &mut out).unwrap();
        assert_eq!(out, vec![1.; n]);
        let mut singular = entries.clone();
        singular[n - 1] = 0.;
        assert!(p.setup(&singular).is_err());
        assert!(p.solve(&rhs, &mut out).is_err());
        assert!(p.setup(&entries).is_err());
        let mut fresh = BlockPreconditioner::with_dimensions(n, GROUPS, nc, &pattern).unwrap();
        fresh.setup(&entries).unwrap();
        rhs[0] = f64::NAN;
        assert!(fresh.solve(&rhs, &mut out).is_err());
        assert!(fresh.solve(&[1.], &mut out).is_err());
        assert!(fresh.solve(&vec![1.; n], &mut out).is_err());
        let mut overflow = BlockPreconditioner::with_dimensions(n, GROUPS, nc, &pattern).unwrap();
        let mut tiny = entries.clone();
        tiny[0] = 1e-300;
        overflow.setup(&tiny).unwrap();
        let mut huge_rhs = vec![1.; n];
        huge_rhs[0] = 1e300;
        assert!(overflow.solve(&huge_rhs, &mut out).is_err());
        // A failed triangular solve invalidates the whole public P, even
        // though its immutable numerical factor has not been overwritten.
        assert!(overflow.solve(&vec![1.; n], &mut out).is_err());
        let mut spatial_failure =
            BlockPreconditioner::with_dimensions(n, GROUPS, nc, &pattern).unwrap();
        let mut zero_pivot = entries.clone();
        zero_pivot[0] = 0.;
        assert!(spatial_failure.setup(&zero_pivot).is_err());
        assert!(spatial_failure.setup(&entries).is_err());
        assert!(spatial_failure.solve(&rhs, &mut out).is_err());
    }
}

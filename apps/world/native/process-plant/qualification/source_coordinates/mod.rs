//! Exact linear solver-only basis: D=sum(N,C)-independent event ledger L.
//! Physical owners/checkpoints use L. D's RHS is the independently evaluated
//! balance discrepancy, not an imposed zero or an accepted-state projection.
#[derive(Clone, Copy)]
pub(super) struct Coordinates {
    pub nc: usize,
    pub ledger: usize,
}
impl Coordinates {
    /// T and T^-1 coincide: all unchanged rows retain their physical units.
    pub fn transform(self, values: &mut [f64]) {
        values[self.ledger] = values[..self.nc].iter().sum::<f64>() - values[self.ledger];
    }
    pub fn physical(self, solver: &[f64], out: &mut [f64]) {
        out.copy_from_slice(solver);
        self.transform(out);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transformation_retains_independent_defects_and_signed_coordinates() {
        let c = Coordinates { nc: 2, ledger: 3 };
        let mut state = vec![2e8, 3e8, 7., 5e8 + 437.];
        let initial = state.clone();
        c.transform(&mut state);
        assert_eq!(state[3], -437.);
        c.transform(&mut state);
        assert_eq!(state, initial);
        // Independent event rate differs: transformed RHS must expose it.
        let mut rates = vec![1e7, 2e7, 0., 3e7 + 0.25];
        c.transform(&mut rates);
        assert_eq!(rates[3], -0.25);
        // A component-only constraint change is not an exact physical solve.
        let mut solver = vec![-0.01, 2., 0., 0.];
        let mut before = solver.clone();
        c.transform(&mut before);
        solver[0] = 0.;
        c.transform(&mut solver);
        assert!((solver[3] - before[3] - 0.01).abs() < 1e-15);
    }
}

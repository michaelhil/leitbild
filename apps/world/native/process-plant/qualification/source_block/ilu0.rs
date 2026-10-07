//! Fixed-pattern, unpivoted ILU(0) for the selected scalar spatial blocks only.
//! No fill, shift, pivot replacement, reordering, retry or alternate factor.
//! Numeric work is sparse-row intersection work; triangular solves are O(nnz).

pub(super) struct Ilu0 {
    pointers: Vec<usize>,
    columns: Vec<usize>,
    diagonal: Vec<usize>,
    input_slots: Vec<usize>,
    values: Vec<f64>,
    valid: bool,
}
impl Ilu0 {
    pub(super) fn new(size: usize, pattern: &[(usize, usize)]) -> Result<Self, String> {
        let mut order = (0..pattern.len()).collect::<Vec<_>>();
        order.sort_unstable_by_key(|&k| pattern[k]);
        if size == 0
            || size.checked_add(1).is_none()
            || order
                .iter()
                .any(|&k| pattern[k].0 >= size || pattern[k].1 >= size)
            || order.windows(2).any(|w| pattern[w[0]] == pattern[w[1]])
        {
            return Err("Invalid/duplicate ILU(0) structural pattern".into());
        }
        let mut pointers = vec![0; size + 1];
        let mut columns = Vec::with_capacity(pattern.len());
        let mut diagonal = vec![usize::MAX; size];
        for (slot, &k) in order.iter().enumerate() {
            let (r, c) = pattern[k];
            pointers[r + 1] += 1;
            columns.push(c);
            if r == c {
                diagonal[r] = slot;
            }
        }
        if diagonal.contains(&usize::MAX) {
            return Err("Missing ILU(0) structural diagonal".into());
        }
        for r in 0..size {
            pointers[r + 1] += pointers[r];
        }
        Ok(Self {
            pointers,
            columns,
            diagonal,
            input_slots: order,
            values: vec![0.; pattern.len()],
            valid: false,
        })
    }
    pub(super) fn factor(&mut self, entries: &[f64]) -> Result<(), String> {
        self.valid = false;
        if entries.len() != self.values.len() || entries.iter().any(|v| !v.is_finite()) {
            return Err("Invalid/nonfinite ILU(0) numeric entries".into());
        }
        for (a, &k) in self.values.iter_mut().zip(&self.input_slots) {
            *a = entries[k];
        }
        for i in 0..self.diagonal.len() {
            for k in self.pointers[i]..self.diagonal[i] {
                let j = self.columns[k];
                let pivot = self.values[self.diagonal[j]];
                if pivot == 0. || !pivot.is_finite() {
                    return Err(format!("ILU(0) zero/nonfinite pivot at row {j}"));
                }
                let multiplier = self.values[k] / pivot;
                if !multiplier.is_finite() {
                    return Err(format!("ILU(0) nonfinite multiplier at row {i}"));
                }
                self.values[k] = multiplier;
                // Update only the intersection of row i and the upper row j.
                // Positions absent from the fixed pattern are discarded, even
                // when their numerical fill would be nonzero.
                let (mut a, mut b) = (k + 1, self.diagonal[j] + 1);
                while a < self.pointers[i + 1] && b < self.pointers[j + 1] {
                    match self.columns[a].cmp(&self.columns[b]) {
                        std::cmp::Ordering::Less => a += 1,
                        std::cmp::Ordering::Greater => b += 1,
                        std::cmp::Ordering::Equal => {
                            self.values[a] -= multiplier * self.values[b];
                            if !self.values[a].is_finite() {
                                return Err(format!("ILU(0) nonfinite update at row {i}"));
                            }
                            a += 1;
                            b += 1;
                        }
                    }
                }
            }
            let pivot = self.values[self.diagonal[i]];
            if pivot == 0. || !pivot.is_finite() {
                return Err(format!("ILU(0) zero/nonfinite pivot at row {i}"));
            }
        }
        self.valid = true;
        Ok(())
    }
    /// Overwrite rhs with U^-1 L^-1 rhs. Partial output on failure is invalid.
    pub(super) fn solve(&self, rhs: &mut [f64]) -> Result<(), String> {
        if !self.valid || rhs.len() != self.diagonal.len() || rhs.iter().any(|v| !v.is_finite()) {
            return Err("Unprepared/invalid ILU(0) solve".into());
        }
        for i in 0..rhs.len() {
            for k in self.pointers[i]..self.diagonal[i] {
                rhs[i] -= self.values[k] * rhs[self.columns[k]];
            }
            if !rhs[i].is_finite() {
                return Err("Nonfinite ILU(0) forward solve".into());
            }
        }
        for i in (0..rhs.len()).rev() {
            for k in self.diagonal[i] + 1..self.pointers[i + 1] {
                rhs[i] -= self.values[k] * rhs[self.columns[k]];
            }
            rhs[i] /= self.values[self.diagonal[i]];
            if !rhs[i].is_finite() {
                return Err("Nonfinite ILU(0) backward solve".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_pattern_factor_and_solve_match_independent_dense_ilu_not_original_inverse() {
        let a = [
            [4., -1., -1., 0.],
            [-1., 4., 0., -1.],
            [-1., 0., 4., -1.],
            [0., -1., -1., 4.],
        ];
        for retain_zero in [false, true] {
            let pattern = (0..4)
                .flat_map(|r| {
                    (0..4).filter_map(move |c| {
                        (a[r][c] != 0. || retain_zero && (r, c) == (1, 2)).then_some((r, c))
                    })
                })
                .rev()
                .collect::<Vec<_>>(); // input need not be CSR ordered
            let mut ilu = Ilu0::new(4, &pattern).unwrap();
            let entries = pattern.iter().map(|&(r, c)| a[r][c]).collect::<Vec<_>>();
            // Independent dense zero-fill oracle: mask immutable coordinates,
            // not the numerical nonzero pattern of this stage.
            let mut mask = [[false; 4]; 4];
            for &(r, c) in &pattern {
                mask[r][c] = true;
            }
            let mut expected = a;
            for i in 0..4 {
                for j in 0..i {
                    if mask[i][j] {
                        expected[i][j] /= expected[j][j];
                        for k in j + 1..4 {
                            if mask[i][k] {
                                expected[i][k] -= expected[i][j] * expected[j][k];
                            }
                        }
                    }
                }
            }
            ilu.factor(&entries).unwrap();
            for r in 0..4 {
                for k in ilu.pointers[r]..ilu.pointers[r + 1] {
                    assert_eq!(ilu.values[k], expected[r][ilu.columns[k]]);
                }
            }
            if retain_zero {
                assert_ne!(expected[1][2], 0.);
            }
            let x = [0.2, -1.3, 2.1, -0.4];
            let mut ux = [0.; 4];
            for r in 0..4 {
                for c in r..4 {
                    ux[r] += expected[r][c] * x[c];
                }
            }
            let mut rhs = ux;
            for r in 0..4 {
                for c in 0..r {
                    rhs[r] += expected[r][c] * ux[c];
                }
            }
            let original = (0..4)
                .map(|r| a[r].iter().zip(x).map(|(a, x)| a * x).sum::<f64>())
                .collect::<Vec<_>>();
            assert!(rhs.iter().zip(&original).any(|(a, b)| (a - b).abs() > 1e-3));
            ilu.solve(&mut rhs).unwrap();
            for (a, b) in rhs.iter().zip(x) {
                assert!((a - b).abs() < 1e-14);
            }
            // Fresh numeric factors, unchanged structure; signed pivots valid.
            let signed = entries.iter().map(|v| -*v).collect::<Vec<_>>();
            ilu.factor(&signed).unwrap();
            assert!(ilu.values[ilu.diagonal[0]] < 0.);
            let mut signed_rhs = ux;
            for r in 0..4 {
                for c in 0..r {
                    signed_rhs[r] += expected[r][c] * ux[c];
                }
            }
            for v in &mut signed_rhs {
                *v = -*v;
            }
            ilu.solve(&mut signed_rhs).unwrap();
            for (a, b) in signed_rhs.iter().zip(x) {
                assert!((a - b).abs() < 1e-14);
            }
        }
    }

    #[test]
    fn invalid_patterns_breakdown_overflow_and_failed_refresh_are_explicit() {
        for pattern in [
            vec![],
            vec![(0, 0)],
            vec![(0, 0), (1, 1), (0, 0)],
            vec![(0, 0), (1, 1), (2, 0)],
        ] {
            assert!(Ilu0::new(2, &pattern).is_err());
        }
        let mut ilu = Ilu0::new(2, &[(0, 0), (0, 1), (1, 0), (1, 1)]).unwrap();
        let mut rhs = [1., 2.];
        assert!(ilu.solve(&mut rhs).is_err());
        ilu.factor(&[2., 1., 1., 2.]).unwrap();
        assert!(ilu.factor(&[0., 1., 1., 2.]).is_err());
        assert!(ilu.solve(&mut rhs).is_err());
        assert!(ilu.factor(&[1e-300, 1e300, 1e300, 1.]).is_err());
        assert!(ilu.factor(&[1., f64::NAN, 0., 1.]).is_err());
        assert!(ilu.factor(&[1.]).is_err());
        ilu.factor(&[1., 0., 0., 1.]).unwrap();
        assert!(ilu.solve(&mut [1.]).is_err());
        assert!(ilu.solve(&mut [1., f64::INFINITY]).is_err());
    }
}

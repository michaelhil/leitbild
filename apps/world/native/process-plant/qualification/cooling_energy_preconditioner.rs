//! One closed-energy row of the APPROXIMATE P, not of the physical F/J.
//! If u=Pbar^-1 eG, this applies the inverse of Pbar with only its G row
//! replaced by cj*eG^T. All other Pbar equations are preserved.
pub(super) struct EnergyRow {
    row: usize,
    size: usize,
    unit: Vec<(usize, f64)>,
    pivot: f64,
    cj: f64,
    valid: bool,
}
impl EnergyRow {
    pub fn new(size: usize, row: usize) -> Result<Self, String> {
        if size == 0 || row >= size {
            return Err("Invalid energy P row".into());
        }
        Ok(Self {
            row,
            size,
            unit: Vec::new(),
            pivot: 0.,
            cj: 0.,
            valid: false,
        })
    }
    pub fn invalidate(&mut self) {
        self.valid = false;
    }
    /// Unit response and cj belong to the SAME immutable Psetup snapshot.
    pub fn prepare(&mut self, cj: f64, unit: &[f64]) -> Result<(), String> {
        self.invalidate();
        if unit.len() != self.size
            || !cj.is_finite()
            || cj <= 0.
            || !cj.recip().is_finite()
            || unit.iter().any(|v| !v.is_finite())
            || unit[self.row] == 0.
        {
            return Err("Singular/nonfinite closed-energy P completion".into());
        }
        self.unit.clear();
        self.unit
            .extend(unit.iter().copied().enumerate().filter(|(_, v)| *v != 0.));
        self.pivot = unit[self.row];
        self.cj = cj;
        self.valid = true;
        Ok(())
    }
    pub fn check(&self) -> Result<(), String> {
        if self.valid {
            Ok(())
        } else {
            Err("Unavailable closed-energy P snapshot".into())
        }
    }
    /// `solution` initially contains Pbar^-1 rhs. Never changes rhs or an
    /// accepted state. Uses frozen cj even when current JTsetup has advanced.
    pub fn apply(&mut self, rhs_g: f64, solution: &mut [f64]) -> Result<(), String> {
        let result = (|| {
            self.check()?;
            if !rhs_g.is_finite()
                || solution.len() != self.size
                || solution.iter().any(|v| !v.is_finite())
            {
                return Err("Invalid closed-energy P vectors".into());
            }
            let target = rhs_g / self.cj;
            let alpha = (target - solution[self.row]) / self.pivot;
            if !alpha.is_finite() {
                return Err("Nonfinite closed-energy P correction".into());
            }
            for &(row, u) in &self.unit {
                solution[row] += alpha * u;
                if !solution[row].is_finite() {
                    return Err("Nonfinite closed-energy P solution".into());
                }
            }
            // Reconstruct the solved P row directly rather than lose a tiny
            // target in zG + alpha*uG cancellation. This is a P SOLUTION only.
            solution[self.row] = target;
            Ok(())
        })();
        if result.is_err() {
            self.invalidate();
        }
        result
    }
    pub fn pivot(&self) -> f64 {
        self.pivot
    }
    pub fn nonzeros(&self) -> usize {
        self.unit.len()
    }
    #[cfg(test)]
    pub fn unit(&self) -> &[(usize, f64)] {
        &self.unit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Independent dense inverse for Pbar=[[2,1,0],[1,3,1],[0,1,2]].
    fn base(b: [f64; 3]) -> [f64; 3] {
        [
            (5. * b[0] - 2. * b[1] + b[2]) / 8.,
            (-2. * b[0] + 4. * b[1] - 2. * b[2]) / 8.,
            (b[0] - 2. * b[1] + 5. * b[2]) / 8.,
        ]
    }
    #[test]
    fn complete_row_keeps_every_other_equation_and_owned_cj() {
        let mut p = EnergyRow::new(3, 1).unwrap();
        for cj in [0.01, 3., 1e12] {
            p.prepare(cj, &base([0., 1., 0.])).unwrap();
            for b in [[1., 2., 3.], [-2., 0.125, 7.], [0., 1., 0.]] {
                let mut z = base(b);
                p.apply(b[1], &mut z).unwrap();
                let action = [2. * z[0] + z[1], cj * z[1], z[1] + 2. * z[2]];
                for i in 0..3 {
                    assert!((action[i] - b[i]).abs() <= 1e-12 * b[i].abs().max(1.));
                }
            }
        }
    }
    #[test]
    fn singular_failed_refresh_and_solve_invalidate_without_fallback() {
        let mut p = EnergyRow::new(3, 1).unwrap();
        for (cj, u) in [
            (0., base([0., 1., 0.])),
            (1., [1., 0., 1.]),
            (f64::INFINITY, [1.; 3]),
        ] {
            assert!(p.prepare(cj, &u).is_err());
            assert!(p.check().is_err());
        }
        p.prepare(1., &base([0., 1., 0.])).unwrap();
        assert!(p.apply(f64::NAN, &mut [0.; 3]).is_err());
        assert!(p.apply(1., &mut [0.; 3]).is_err());
        p.prepare(2., &base([0., 1., 0.])).unwrap();
        assert!(p.check().is_ok());
    }
}

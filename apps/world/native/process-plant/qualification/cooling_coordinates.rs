//! Solver-only affine energy chart. Physical owners retain every E and the
//! independent fission/barrel release, existing gross binding progress weighted
//! by its event Q, photon exports and signed ambient receipts. No balance is
//! imposed or reset here.
use leitbild_plant_numerics::source_cooling::Model;

pub(super) struct EnergyCoordinates {
    pub row: usize,
    anchor_initial: f64,
    receipts: Vec<(usize, f64, f64)>,
    energies: Vec<(usize, f64)>,
}
fn sum(values: impl Iterator<Item = f64>) -> f64 {
    let (mut s, mut c) = (0f64, 0f64);
    for v in values {
        let t = s + v;
        c += if s.abs() >= v.abs() {
            (s - t) + v
        } else {
            (v - t) + s
        };
        s = t;
    }
    s + c
}
impl EnergyCoordinates {
    pub fn new(model: &Model, initial: &[f64]) -> Result<Self, String> {
        if initial.len() != model.dimension() || initial.iter().any(|v| !v.is_finite()) {
            return Err("Invalid energy-chart preparation".into());
        }
        let n = &model.network;
        let l = model.layout;
        let network_rows = (0..n.config().water.len() + n.config().solids.len())
            .map(|i| l.network_start + n.energy_row(i))
            .chain(
                (0..n.config().secondaries.len())
                    .map(|i| l.network_start + n.secondary_energy_row(i)),
            )
            .collect::<Vec<_>>();
        // Replace a large network E, never the small independently paid release.
        let row = *network_rows
            .iter()
            .max_by(|&&a, &&b| initial[a].abs().total_cmp(&initial[b].abs()))
            .ok_or("Energy chart needs installed network energy")?;
        let rows = model.installed_energy_rows().collect::<Vec<_>>();
        if !model.is_differential(row) {
            return Err("Energy-chart anchor is not differential".into());
        }
        let receipts = [
            (model.source.fuel_release_row(), -1.),
            (l.barrel_released, -1.),
            (l.barrel_exported, 1.),
            (l.ambient_exported, 1.),
            (l.fuel_capture_exported, 1.),
        ]
        .into_iter()
        .chain(model.capture_paid_rows().map(|(row, q)| (row, -q)))
        .map(|(r, sign)| (r, sign, initial[r]))
        .collect();
        Ok(Self {
            row,
            anchor_initial: initial[row],
            receipts,
            energies: rows.into_iter().map(|r| (r, initial[r])).collect(),
        })
    }
    /// Affine state map: installed E change minus independent release, plus
    /// independently integrated photon and signed ambient exports.
    pub fn state_to_solver(&self, values: &mut [f64]) {
        values[self.row] = sum(self.energies.iter().map(|&(r, e0)| values[r] - e0).chain(
            self.receipts
                .iter()
                .map(|&(r, sign, initial)| sign * (values[r] - initial)),
        ));
    }
    pub fn state_to_physical(&self, values: &mut [f64]) {
        values[self.row] = self.anchor_initial
            + sum(std::iter::once(values[self.row])
                .chain(
                    self.energies
                        .iter()
                        .filter(|&&(r, _)| r != self.row)
                        .map(|&(r, b)| -(values[r] - b)),
                )
                .chain(
                    self.receipts
                        .iter()
                        .map(|&(r, sign, initial)| -sign * (values[r] - initial)),
                ));
    }
    /// Linear map for rates, residuals, directions and corrections: T v.
    pub fn balance(&self, values: &[f64]) -> f64 {
        sum(self
            .energies
            .iter()
            .map(|&(r, _)| values[r])
            .chain(self.receipts.iter().map(|&(r, sign, _)| sign * values[r])))
    }
    pub fn vector_to_solver(&self, values: &mut [f64]) {
        values[self.row] = self.balance(values);
    }
    pub fn vector_to_physical(&self, values: &mut [f64]) {
        values[self.row] = sum(std::iter::once(values[self.row])
            .chain(
                self.energies
                    .iter()
                    .filter(|&&(r, _)| r != self.row)
                    .map(|&(r, _)| -values[r]),
            )
            .chain(self.receipts.iter().map(|&(r, sign, _)| -sign * values[r])));
    }
    pub fn absolute(dimension: usize, refinement: f64) -> f64 {
        // Prospective allocation: 1 J /100, remove single-row WRMS dilution.
        // Not a proof of a trajectory-wide 1 J error bound; physical gate remains.
        0.01 / (dimension as f64).sqrt() / refinement
    }
}

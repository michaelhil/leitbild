//! Qualification-only local-power error-scale allocation. This first-order
//! BOX budget is not a WRMS-to-trajectory accuracy theorem. The independent
//! local deposited-power refined-pair criterion remains unchanged.
use leitbild_plant_numerics::{
    fuel_history::PowerResponse,
    source_evolution::{BarrelResponse, Evolution},
};
use std::sync::Arc;

fn capped_scale(current: f64, gradient: f64, allocation: f64) -> Result<f64, String> {
    if !current.is_finite()
        || current <= 0.
        || !gradient.is_finite()
        || gradient < 0.
        || !allocation.is_finite()
        || allocation <= 0.
    {
        return Err("Invalid local-power contribution scale".into());
    }
    // Avoid overflowing a division by a tiny derivative when the current
    // finite control is already stronger. Product overflow requires reduction.
    if gradient * current <= allocation {
        return Ok(current);
    }
    let cap = allocation / gradient;
    if !cap.is_finite() || cap <= 0. {
        return Err("Unrepresentable local-power error scale".into());
    }
    Ok(current.min(cap))
}
pub(super) struct PowerWeights {
    response: PowerResponse,
    owner: Arc<()>,
}
pub(super) struct PowerWorkspace {
    powers: Vec<f64>,
    gradients: Vec<f64>,
    owner: Arc<()>,
}
impl PowerWeights {
    pub fn new(source: &Evolution) -> Result<Self, String> {
        let response = source.fuel_history().power_response()?;
        // Both solver balance charts lie OUTSIDE the only consumed prefix.
        // Refuse a changed layout rather than silently reading transformed data.
        if response.state_count() != source.history_dimension()
            || response.state_count() > source.ledger_row()
        {
            return Err("Fuel power response overlaps a solver balance coordinate".into());
        }
        Ok(Self {
            response,
            owner: Arc::new(()),
        })
    }
    pub fn workspace(&self) -> PowerWorkspace {
        PowerWorkspace {
            powers: vec![0.; self.response.output_count()],
            gradients: vec![0.; self.response.columns().len()],
            owner: self.owner.clone(),
        }
    }
    /// `y` is the physical fuel/history prefix, identical in both solver charts.
    /// Existing stronger controls are retained. All recipient rows contribute;
    /// no observed failing coordinate or output value selects the support.
    pub fn cap(
        &self,
        y: &[f64],
        relative: f64,
        resolution_w: f64,
        scales: &mut [f64],
        w: &mut PowerWorkspace,
    ) -> Result<(), String> {
        let n = self.response.state_count();
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() < n
            || scales.len() < n
            || !relative.is_finite()
            || relative < 0.
            || !resolution_w.is_finite()
            || resolution_w <= 0.
        {
            return Err("Invalid local-power scale inputs/workspace".into());
        }
        self.response
            .evaluate(&y[..n], &mut w.powers, &mut w.gradients)?;
        cap_response(
            y,
            relative,
            resolution_w,
            scales,
            &w.powers,
            &w.gradients,
            self.response.columns(),
            self.response.offsets(),
            |c| c,
        )?;
        Ok(())
    }
}

fn cap_response(
    y: &[f64],
    relative: f64,
    resolution_w: f64,
    scales: &mut [f64],
    powers: &[f64],
    all_gradients: &[f64],
    all_columns: &[usize],
    offsets: &[usize],
    map_column: impl Fn(usize) -> usize,
) -> Result<(), String> {
    for q in 0..powers.len() {
        let range = offsets[q]..offsets[q + 1];
        let columns = &all_columns[range.clone()];
        let gradients = &all_gradients[range];
        if columns.is_empty() {
            continue;
        }
        let m = columns.len() as f64; // immutable structural support, including state zeros
        let mut sum = 0.;
        let mut correction = 0.;
        for (&column, &gradient) in columns.iter().zip(gradients) {
            let column = map_column(column);
            let moment = (gradient * y[column]).abs();
            let next = sum + moment;
            correction += if sum.abs() >= moment {
                (sum - next) + moment
            } else {
                (moment - next) + sum
            };
            sum = next;
        }
        let moment = sum + correction;
        let relative_power = relative * powers[q].abs();
        if !moment.is_finite() || !relative_power.is_finite() {
            return Err("Nonfinite local-power response budget".into());
        }
        for (&column, &gradient) in columns.iter().zip(gradients) {
            let column = map_column(column);
            let scale = scales[column];
            if !scale.is_finite() || scale <= 0. {
                return Err("Invalid existing local-power scale".into());
            }
            if gradient == 0. {
                continue;
            }
            let share = if moment == 0. {
                1. / m
            } else {
                (gradient * y[column]).abs() / moment
            };
            let budget = resolution_w / m + relative_power * share;
            scales[column] = capped_scale(scale, gradient.abs(), budget)?;
        }
    }
    Ok(())
}

pub(super) struct BarrelWeights {
    response: BarrelResponse,
    powers: Vec<f64>,
    gradients: Vec<f64>,
}
impl BarrelWeights {
    pub fn new(
        source: &Evolution,
        targets: [usize; 4],
        emission: [f64; 4],
    ) -> Result<Self, String> {
        let response = source.barrel_response(targets, emission)?;
        // Response columns never consume the independent signed D ledger.
        if response.columns().contains(&source.ledger_row()) {
            return Err("Barrel response overlaps source balance coordinate".into());
        }
        let powers = vec![0.; response.output_count()];
        let gradients = vec![0.; response.columns().len()];
        Ok(Self {
            response,
            powers,
            gradients,
        })
    }
    pub fn cap(
        &mut self,
        y: &[f64],
        relative: f64,
        resolution: f64,
        scales: &mut [f64],
    ) -> Result<(), String> {
        let n = self.response.state_count();
        if y.len() < n
            || scales.len() < n
            || !relative.is_finite()
            || relative < 0.
            || !resolution.is_finite()
            || resolution <= 0.
        {
            return Err("Invalid barrel power scales".into());
        }
        self.response
            .evaluate(&y[..n], &mut self.powers, &mut self.gradients)?;
        cap_response(
            y,
            relative,
            resolution,
            scales,
            &self.powers,
            &self.gradients,
            self.response.columns(),
            self.response.offsets(),
            |c| c,
        )?;
        Ok(())
    }
}

/// Current nuclear binding emission response. The only gathered values are
/// the actual, non-contiguous fuel temperatures; source history stays in place.
/// Does not evaluate EOS/RHS or replace the prepared current JVP workspace.
pub(super) struct CaptureWeights {
    response: leitbild_plant_numerics::fuel_capture::PowerResponse,
    temperatures: Vec<f64>,
    temperature_rows: Vec<usize>,
    powers: Vec<f64>,
    gradients: Vec<f64>,
}
impl CaptureWeights {
    pub fn structure(&self) -> (usize, usize, usize) {
        (
            self.response.output_count(),
            self.response.columns().len(),
            self.gradients.iter().filter(|g| **g != 0.).count(),
        )
    }
    pub fn new(model: &leitbild_plant_numerics::source_cooling::Model) -> Result<Self, String> {
        let response = model.capture.power_response(&model.source)?;
        let temperature_rows = model
            .fuel_rows()
            .iter()
            .map(|&r| model.layout.temperatures_start + r)
            .collect::<Vec<_>>();
        if response.history_state_count() != model.source.history_dimension()
            || response.state_count() != response.history_state_count() + temperature_rows.len()
            || response.history_state_count() > model.source.ledger_row()
        {
            return Err("Fuel binding response overlaps transformed solver coordinates".into());
        }
        Ok(Self {
            temperatures: vec![0.; temperature_rows.len()],
            powers: vec![0.; response.output_count()],
            gradients: vec![0.; response.columns().len()],
            temperature_rows,
            response,
        })
    }
    pub fn cap(
        &mut self,
        y: &[f64],
        relative: f64,
        resolution: f64,
        scales: &mut [f64],
    ) -> Result<(), String> {
        let n = self.response.history_state_count();
        if y.len() != scales.len()
            || y.len() < n
            || self.temperature_rows.iter().any(|&r| r >= y.len())
            || !relative.is_finite()
            || relative < 0.
            || !resolution.is_finite()
            || resolution <= 0.
        {
            return Err("Invalid fuel binding error weights".into());
        }
        for (t, &r) in self.temperatures.iter_mut().zip(&self.temperature_rows) {
            *t = y[r];
        }
        self.response.evaluate(
            &y[..n],
            &self.temperatures,
            &mut self.powers,
            &mut self.gradients,
        )?;
        cap_response(
            y,
            relative,
            resolution,
            scales,
            &self.powers,
            &self.gradients,
            self.response.columns(),
            self.response.offsets(),
            |c| {
                if c < n {
                    c
                } else {
                    self.temperature_rows[c - n]
                }
            },
        )
    }
}

#[cfg(test)]
#[path = "../tests/source_evolution.rs"]
mod source_fixture;
#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> Evolution {
        Evolution::new(source_fixture::input()).unwrap()
    }
    #[test]
    fn every_recipient_box_budget_and_true_refinement() {
        let source = model();
        let policy = PowerWeights::new(&source).unwrap();
        let mut w = policy.workspace();
        for amount in [0., 1e-12, -0.1, 0.1, 100.] {
            let mut y = source.initial_state();
            for (i, value) in y[..source.history_dimension() - 1].iter_mut().enumerate() {
                *value = amount * (1. + (i % 7) as f64);
            }
            let original = vec![0.001; y.len()];
            let mut scales = original.clone();
            policy.cap(&y, 1e-5, 1e-12, &mut scales, &mut w).unwrap();
            assert!(scales.iter().zip(&original).all(|(s, old)| s <= old));
            for q in 0..policy.response.output_count() {
                let range = policy.response.offsets()[q]..policy.response.offsets()[q + 1];
                let box_w: f64 = policy.response.columns()[range.clone()]
                    .iter()
                    .zip(&w.gradients[range])
                    .map(|(&c, &g)| g.abs() * scales[c])
                    .sum();
                let budget = 1e-12 + 1e-5 * w.powers[q].abs();
                assert!(box_w <= budget * (1. + 1e-14), "{box_w} > {budget}");
            }
            let mut refined = original.iter().map(|v| v / 10.).collect::<Vec<_>>();
            policy.cap(&y, 1e-6, 1e-13, &mut refined, &mut w).unwrap();
            for (normal, tight) in scales.iter().zip(refined) {
                assert!((normal / 10. - tight).abs() <= 2e-14 * tight);
            }
        }
    }
    #[test]
    fn zero_gradients_keep_controls_and_invalid_inputs_refuse() {
        let source = model();
        let policy = PowerWeights::new(&source).unwrap();
        let mut w = policy.workspace();
        let mut y = source.initial_state();
        let mut scales = vec![0.001; y.len()];
        policy.cap(&y, 1e-5, 1e-12, &mut scales, &mut w).unwrap();
        assert_eq!(scales[source.history_dimension() - 1], 0.001); // Cf never deposits here
        let foreign = PowerWeights::new(&source).unwrap();
        assert!(foreign.cap(&y, 1e-5, 1e-12, &mut scales, &mut w).is_err());
        y[0] = f64::NAN;
        assert!(policy.cap(&y, 1e-5, 1e-12, &mut scales, &mut w).is_err());
    }
    #[test]
    fn tiny_gradient_retains_already_stricter_finite_scale_without_division_overflow() {
        assert_eq!(
            capped_scale(0.001, f64::from_bits(1), 1e-12).unwrap(),
            0.001
        );
        assert_eq!(capped_scale(10., 2., 1.).unwrap(), 0.5);
        assert_eq!(capped_scale(0.001, 0., 1e-12).unwrap(), 0.001);
        assert!(capped_scale(1., f64::INFINITY, 1.).is_err());
    }
    #[test]
    fn barrel_current_channels_coalesce_box_support_and_refine_tenfold() {
        let model = super::super::cooling_fixture::fixture();
        let source = &model.source;
        let b = model.barrel.config();
        let mut policy = BarrelWeights::new(source, b.targets, b.capture_photon_j).unwrap();
        for magnitude in [0., -0.2, 2.] {
            let mut y = source.initial_state();
            for (i, n) in y[..source.nc_dimension()].iter_mut().enumerate() {
                *n = magnitude * (1. + (i % 3) as f64);
            }
            for &t in &b.targets {
                y[source.target_row(t)] = magnitude;
            }
            let mut scales = vec![0.001; y.len()];
            policy.cap(&y, 1e-5, 1e-12, &mut scales).unwrap();
            for q in 0..policy.response.output_count() {
                let range = policy.response.offsets()[q]..policy.response.offsets()[q + 1];
                let box_value = policy.response.columns()[range.clone()]
                    .iter()
                    .zip(&policy.gradients[range])
                    .map(|(&c, &g)| g.abs() * scales[c])
                    .sum::<f64>();
                assert!(box_value <= (1e-12 + 1e-5 * policy.powers[q].abs()) * (1. + 1e-14));
            }
            let mut tight = vec![0.0001; y.len()];
            policy.cap(&y, 1e-6, 1e-13, &mut tight).unwrap();
            for (&a, &b) in scales.iter().zip(&tight) {
                assert!((a / 10. - b).abs() <= 3e-14 * b);
            }
            y[source.ledger_row()] = 42.;
            let mut same = vec![0.001; y.len()];
            policy.cap(&y, 1e-5, 1e-12, &mut same).unwrap();
            assert_eq!(scales, same);
        }
    }
    #[test]
    fn binding_current_source_temperature_support_and_tenfold_refinement() {
        let model = super::super::cooling_fixture::fixture_with_contrast();
        let mut policy = CaptureWeights::new(&model).unwrap();
        let mut y = model.initial_state().unwrap();
        for n in &mut y[..model.source.nc_dimension()] {
            *n = 2.;
        }
        let original = y.clone();
        let mut scales = vec![1e12; y.len()];
        policy.cap(&y, 1e-5, 1e-12, &mut scales).unwrap();
        let n = policy.response.history_state_count();
        for i in 0..policy.response.output_count() {
            let range = policy.response.offsets()[i]..policy.response.offsets()[i + 1];
            let bound: f64 = policy.response.columns()[range.clone()]
                .iter()
                .zip(&policy.gradients[range])
                .map(|(&c, &g)| {
                    let r = if c < n {
                        c
                    } else {
                        policy.temperature_rows[c - n]
                    };
                    g.abs() * scales[r]
                })
                .sum();
            assert!(bound <= (1e-12 + 1e-5 * policy.powers[i].abs()) * (1. + 2e-14));
        }
        let mut tight = vec![1e11; y.len()];
        policy.cap(&y, 1e-6, 1e-13, &mut tight).unwrap();
        for (&a, &b) in scales.iter().zip(&tight) {
            assert!((a / 10. - b).abs() <= 5e-14 * b);
        }
        assert_eq!(y, original);
        let before = policy.powers.clone();
        for &r in &policy.temperature_rows {
            y[r] += 1.;
        }
        policy.cap(&y, 1e-5, 1e-12, &mut scales).unwrap();
        assert_ne!(policy.powers, before);
        y[policy.temperature_rows[0]] = f64::NAN;
        assert!(policy.cap(&y, 1e-5, 1e-12, &mut scales).is_err());
        assert!(policy.cap(&original, f64::NAN, 1e-12, &mut scales).is_err());
    }
}

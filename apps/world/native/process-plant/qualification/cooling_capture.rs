//! Qualification of the paid FUEL binding channel, separately from fission/E25
//! and large sensible thermal redistribution. No additional physical state.
use leitbild_plant_numerics::source_cooling::Model;

/// Five inspectable totals, not a second dump of every retained native state.
/// Pair admission still compares every local channel and the complete SUMABS.
pub(super) fn power_totals(channels: &[f64]) -> Result<[f64; 5], String> {
    if channels.is_empty() || channels.len() % 5 != 0 || channels.iter().any(|v| !v.is_finite()) {
        return Err("Invalid fuel-binding power channels".into());
    }
    let mut totals = [0.; 5];
    for row in channels.chunks_exact(5) {
        for i in 0..5 {
            totals[i] += row[i];
        }
    }
    if totals.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite fuel-binding power totals".into());
    }
    Ok(totals)
}

pub(super) fn paid_energy(model: &Model, y: &[f64], initial: &[f64]) -> Result<f64, String> {
    if y.len() != model.dimension() || initial.len() != y.len() {
        return Err("Wrong fuel-binding accounting state shape".into());
    }
    // Subtract each canonical progress BEFORE applying Q. Never subtract the
    // remaining ~1e28-atom donor or two separately rounded energy totals.
    let (mut total, mut correction) = (0f64, 0f64);
    for (row, q) in model.capture_paid_rows() {
        let v = q * (y[row] - initial[row]);
        let next = total + v;
        correction += if total.abs() >= v.abs() {
            (total - next) + v
        } else {
            (v - next) + total
        };
        total = next;
    }
    let result = total + correction;
    if !result.is_finite() {
        return Err("Nonfinite fuel-binding accounting".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paid_progress_is_distinct_from_fission_and_uses_prepared_offsets() {
        let model = crate::cooling_fixture::fixture_with_contrast();
        let mut initial = model.initial_state().unwrap();
        let mut y = initial.clone();
        let rows = model.capture_paid_rows().collect::<Vec<_>>();
        assert!(!rows.is_empty());
        for (i, &(row, q)) in rows.iter().enumerate() {
            initial[row] = 1e10 + i as f64;
            y[row] = initial[row] + 100.;
            assert!(q.is_finite() && q > 0.);
        }
        let expected = rows.iter().map(|(_, q)| q * 100.).sum::<f64>();
        assert!(
            (paid_energy(&model, &y, &initial).unwrap() - expected).abs()
                <= 8. * f64::EPSILON * expected.abs()
        );
        y[model.source.fuel_release_row()] += 123.;
        assert!(
            (paid_energy(&model, &y, &initial).unwrap() - expected).abs()
                <= 8. * f64::EPSILON * expected.abs()
        );
    }
}

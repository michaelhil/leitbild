//! Nuclear-only mobile birth heat accounting, independent of sensible cooling
//! and the later position of transported capture products.
use leitbild_plant_numerics::source_cooling::Model;
pub(super) const POLICY: &str = "birth-site-primary-H-B;physical-liquid-self;physical-origin-diffuse-serial-clad-barrel;explicit-unrepresented-wall-boundary";
pub(super) const DEVELOPMENT_POLICY: &str = "separate-positive-H-B-paid-and-finite-recipient-power;min-normal-tighter>10-pair-difference+20-existing-resolution";
pub(super) fn developed(
    paid_a: [f64; 2],
    paid_b: [f64; 2],
    finite_a: f64,
    finite_b: f64,
) -> Result<bool, String> {
    let resolved = |a: f64, b: f64, resolution: f64| -> Result<bool, String> {
        if !a.is_finite() || !b.is_finite() {
            return Err("Nonfinite mobile development signal".into());
        }
        Ok(a.min(b) > 10. * (a - b).abs() + 20. * resolution)
    };
    Ok(resolved(paid_a[0], paid_b[0], super::ENERGY_ATOL)?
        && resolved(paid_a[1], paid_b[1], super::ENERGY_ATOL)?
        && resolved(
            finite_a,
            finite_b,
            super::cooling_accuracy::DEPOSIT_RESOLUTION_W,
        )?)
}
pub(super) fn power_totals(channels: &[f64]) -> Result<[f64; 12], String> {
    if channels.is_empty() || channels.len() % 12 != 0 || channels.iter().any(|v| !v.is_finite()) {
        return Err("Invalid mobile-capture power channels".into());
    }
    let mut totals = [0.; 12];
    for row in channels.chunks_exact(12) {
        for k in 0..12 {
            totals[k] += row[k];
        }
    }
    if totals.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite mobile-capture power total".into());
    }
    Ok(totals)
}
pub(super) fn paid_species(model: &Model, y: &[f64], initial: &[f64]) -> Result<[f64; 2], String> {
    if y.len() != model.dimension() || initial.len() != y.len() {
        return Err("Wrong mobile-capture paid state shape".into());
    }
    let mut result = [0.; 2];
    for (species, q) in model.mobile_capture.paid_energy().into_iter().enumerate() {
        let (mut sum, mut correction) = (0_f64, 0_f64);
        for row in model.mobile_product_rows(species) {
            let v = q * (y[row] - initial[row]);
            let next = sum + v;
            correction += if sum.abs() >= v.abs() {
                (sum - next) + v
            } else {
                (v - next) + sum
            };
            sum = next;
        }
        result[species] = sum + correction;
    }
    if result.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite mobile-capture paid energy".into());
    }
    Ok(result)
}
pub(super) fn paid_energy(model: &Model, y: &[f64], initial: &[f64]) -> Result<f64, String> {
    Ok(paid_species(model, y, initial)?.iter().sum())
}

/// Inspect the already prepared composed state. No extra RHS, source solve,
/// property call or physical stock is introduced by this entry proof.
pub(super) fn entry_receipt(
    model: &Model,
    w: &leitbild_plant_numerics::source_cooling::Workspace,
    yp: &[f64],
) -> Result<String, String> {
    if yp.len() != model.dimension() {
        return Err("Wrong mobile entry rate shape".into());
    }
    let delivery = w.mobile_capture.value()?;
    let totals = power_totals(&delivery.channels)?;
    if totals.iter().any(|v| *v < 0.) {
        return Err("Negative current mobile binding power".into());
    }
    let mut paid = [0.; 2];
    let mut defects = [0.; 2];
    for species in 0..2 {
        let k = 6 * species;
        defects[species] = totals[k] - totals[k + 1..k + 6].iter().sum::<f64>();
        if defects[species].abs() > 4096. * f64::EPSILON * totals[k] {
            return Err(format!(
                "Mobile species {species} allocation does not close"
            ));
        }
        let q = model.mobile_capture.paid_energy()[species];
        let mut operands = 0.;
        for row in model.mobile_product_rows(species) {
            paid[species] += q * (yp[row] - w.residual[row]);
            operands += q * (yp[row].abs() + w.residual[row].abs());
        }
        if (paid[species] - totals[k]).abs() > 4096. * f64::EPSILON * (operands + totals[k]) {
            return Err(format!(
                "Mobile species {species} complete product RHS does not pay actual births"
            ));
        }
    }
    let recipient = delivery.recipient_power().sum::<f64>();
    let emitted = totals[0] + totals[6];
    let defect = emitted - recipient - delivery.exported - delivery.boundary_exported;
    if defect.abs() > 4096. * f64::EPSILON * emitted {
        return Err("Mobile finite recipients and exclusive exports do not close".into());
    }
    Ok(format!("{{\"policy\":{},\"routeCount\":{},\"wallOriginCount\":{},\"actualSpeciesPowerTotalsW\":{},\"canonicalCompleteProductPaidRateW\":{},\"speciesAllocationDefectsW\":{},\"finiteRecipientPowerW\":{},\"exclusiveExportPowerW\":[{},{}],\"recipientClosureDefectW\":{},\"scope\":\"same-current-workspace;fresh-zero-birth-valid;nonzero-partition-and-grid-invariance-foundation-tests;no-extra-RHS-EOS-or-trajectory\"}}",
        super::quote(POLICY),model.mobile_capture.route_count(),model.mobile_capture.origin_count(),super::numbers(&totals),super::numbers(&paid),super::numbers(&defects),super::finite(recipient),super::finite(delivery.exported),super::finite(delivery.boundary_exported),super::finite(defect)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn developed_mobile_heat_requires_both_species_and_real_resolved_recipient_power() {
        assert!(developed([1., 2.], [1., 2.], 3., 3.).unwrap());
        for (a, b, fa, fb) in [
            ([0., 0.], [0., 0.], 0., 0.),
            ([1., 0.], [1., 0.], 3., 3.),
            ([1., 2.], [1., 2.], 0., 0.),
            ([1., 2.], [1., 2.], 3., 4.),
            ([1., 2.], [1., 3.], 3., 3.),
            ([1., 2.], [1., 2.], 1e-12, 1e-12),
        ] {
            assert!(!developed(a, b, fa, fb).unwrap());
        }
        assert!(developed([f64::NAN, 2.], [1., 2.], 3., 3.).is_err());
    }
}

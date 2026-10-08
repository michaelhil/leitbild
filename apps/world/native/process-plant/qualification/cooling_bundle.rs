//! Nuclear-only receipts for the finite BODY/guide join. Sensible conditioning
//! cannot qualify a missing capture path. No additional emission history.
use super::{
    cooling_accuracy::{self, Sample},
    finite, numbers, ENERGY_ATOL,
};
use leitbild_plant_numerics::source_cooling::{Model, Workspace};

pub(super) const POLICY:&str="fixed-original-finite-BODY-guide;actual-birth-region-cohort;canonical-products;full-physical-host-photons";
pub(super) fn powers(w: &Workspace) -> Vec<f64> {
    let v = &w.absorber_guide.value;
    v.family_emitted
        .into_iter()
        .chain(std::iter::once(v.exported))
        .chain(v.nuclear_host.iter().copied())
        .chain(v.nuclear_water.iter().copied())
        .collect()
}
pub(super) fn paid(model: &Model, y: &[f64], initial: &[f64]) -> Result<f64, String> {
    if y.len() != model.dimension() || initial.len() != y.len() {
        return Err("BODY/guide paid-state shape".into());
    }
    let q = model
        .absorber_guide
        .paid_rows()
        .map(|(i, q)| q * (y[i] - initial[i]))
        .sum::<f64>();
    if !q.is_finite() {
        return Err("Nonfinite BODY/guide paid release".into());
    }
    Ok(q)
}
pub(super) fn compare(
    model: &Model,
    a: &Sample,
    b: &Sample,
    initial: &[f64],
    mut record: Option<&mut cooling_accuracy::Comparison>,
) -> Result<(f64, f64, f64), String> {
    let expected = 4 + model.absorber_guide.host_count() + model.carrier.cells();
    if a.bundle_power.len() != expected || b.bundle_power.len() != expected {
        return Err("BODY/guide nuclear power shape".into());
    }
    for v in [&a.bundle_power, &b.bundle_power] {
        let emitted = v[..3].iter().sum::<f64>();
        if !emitted.is_finite()
            || (emitted - v[3] - v[4..].iter().sum::<f64>()).abs()
                > 256. * f64::EPSILON * emitted.abs().max(1e-30)
        {
            return Err("BODY/guide nuclear channel partition refused".into());
        }
    }
    let (local, sumabs) = cooling_accuracy::deposit_comparison(&a.bundle_power, &b.bundle_power)?;
    if let Some(r) = record.as_mut() {
        let i = local.1;
        let x = a.bundle_power[i];
        let y = b.bundle_power[i];
        r.record(
            "BODY-guide-nuclear-channel-W",
            i,
            x,
            y,
            (x - y).abs(),
            1e-3 * y.abs() + 20. * cooling_accuracy::DEPOSIT_RESOLUTION_W,
        )?;
        let x = a.bundle_power.iter().map(|v| v.abs()).sum::<f64>();
        let y = b.bundle_power.iter().map(|v| v.abs()).sum::<f64>();
        let difference = a
            .bundle_power
            .iter()
            .zip(&b.bundle_power)
            .map(|(x, y)| (x - y).abs())
            .sum::<f64>();
        r.record(
            "BODY-guide-nuclear-channel-SUMABS-W",
            0,
            x,
            y,
            difference,
            1e-3 * y + 20. * cooling_accuracy::DEPOSIT_RESOLUTION_W * b.bundle_power.len() as f64,
        )?;
    }
    let x = paid(model, &a.y, initial)?;
    let y = paid(model, &b.y, initial)?;
    let mut energy = super::ratio((x - y).abs(), 1e-3 * y.abs() + 20. * ENERGY_ATOL)?;
    for (i, q) in model.absorber_guide.paid_rows() {
        if let Some(r) = record.as_mut() {
            r.record(
                "BODY-guide-canonical-paid-local-J",
                i,
                q * (a.y[i] - initial[i]),
                q * (b.y[i] - initial[i]),
                q * (a.y[i] - b.y[i]).abs(),
                1e-3 * q * (b.y[i] - initial[i]).abs() + 20. * ENERGY_ATOL,
            )?;
        }
        energy = energy.max(super::ratio(
            q * (a.y[i] - b.y[i]).abs(),
            1e-3 * q * (b.y[i] - initial[i]).abs() + 20. * ENERGY_ATOL,
        )?);
    }
    let i = model.layout.absorber_guide_exported;
    if let Some(r) = record.as_mut() {
        r.record(
            "BODY-guide-paid-total-J",
            i,
            x,
            y,
            (x - y).abs(),
            1e-3 * y.abs() + 20. * ENERGY_ATOL,
        )?;
        r.record(
            "BODY-guide-export-J",
            i,
            a.y[i] - initial[i],
            b.y[i] - initial[i],
            (a.y[i] - b.y[i]).abs(),
            1e-3 * (b.y[i] - initial[i]).abs() + 20. * ENERGY_ATOL,
        )?;
    }
    energy = energy.max(super::ratio(
        (a.y[i] - b.y[i]).abs(),
        1e-3 * (b.y[i] - initial[i]).abs() + 20. * ENERGY_ATOL,
    )?);
    Ok((local.0, sumabs, energy))
}
pub(super) fn developed(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len()
        && a.len() > 4
        && (0..3).all(|i| {
            a[i].is_finite()
                && b[i].is_finite()
                && a[i].min(b[i])
                    > 10. * (a[i] - b[i]).abs() + 20. * cooling_accuracy::DEPOSIT_RESOLUTION_W
        })
        && {
            let x = a[4..].iter().sum::<f64>();
            let y = b[4..].iter().sum::<f64>();
            x.is_finite()
                && y.is_finite()
                && x.min(y) > 10. * (x - y).abs() + 20. * cooling_accuracy::DEPOSIT_RESOLUTION_W
        }
}
/// Actual finite guide cooling must be resolved, not merely nonzero emission.
/// BODY capture development is separately required; cold BODY drift may be
/// below the selected temperature resolution and is not forced artificially.
pub(super) fn thermal_witness(
    model: &Model,
    a: &Sample,
    b: &Sample,
    initial: &[f64],
) -> (usize, f64, f64, bool) {
    let mut witness = (0, 0f64, 0f64, false);
    for (h, host) in model.absorber_guide.config().hosts.iter().enumerate() {
        if host.zr_mass_kg == 0. {
            continue;
        }
        let i = model.layout.absorber_guide_temperatures_start + h;
        let x = (a.y[i] - initial[i]).abs();
        let y = (b.y[i] - initial[i]).abs();
        if x.min(y) > witness.1.min(witness.2) {
            witness = (
                h,
                x,
                y,
                x.min(y) > 10. * (a.y[i] - b.y[i]).abs() + 20. * cooling_accuracy::TEMPERATURE_ATOL,
            );
        }
    }
    witness
}
pub(super) fn report(
    model: &Model,
    a: &Sample,
    b: &Sample,
    initial: &[f64],
    ratios: [f64; 3],
) -> Result<String, String> {
    let witness = thermal_witness(model, a, b, initial);
    let passed = ratios.iter().all(|q| q.is_finite() && *q <= 1.)
        && developed(&a.bundle_power, &b.bundle_power)
        && witness.3;
    Ok(format!("{{\"kind\":\"absorber-guide-pair\",\"passed\":{passed},\"policy\":\"{POLICY}\",\"hosts\":{},\"powerLocalRatio\":{},\"powerSUMABSRatio\":{},\"paidEnergyRatio\":{},\"developedAllCaptureFamilies\":{},\"familyOrder\":[\"BODY-B10\",\"BODY-304-and-Mn\",\"GUIDE-Zr\"],\"normalFamilyPowerW\":{},\"tighterFamilyPowerW\":{},\"normalPaidJ\":{},\"tighterPaidJ\":{},\"normalExportJ\":{},\"tighterExportJ\":{},\"normalFiniteRecipientPowerW\":{},\"tighterFiniteRecipientPowerW\":{},\"guideThermalWitness\":{{\"host\":{},\"normalChangeK\":{},\"tighterChangeK\":{},\"resolved\":{}}}}}",model.absorber_guide.host_count(),finite(ratios[0]),finite(ratios[1]),finite(ratios[2]),developed(&a.bundle_power,&b.bundle_power),numbers(&a.bundle_power[..3]),numbers(&b.bundle_power[..3]),finite(paid(model,&a.y,initial)?),finite(paid(model,&b.y,initial)?),finite(a.y[model.layout.absorber_guide_exported]-initial[model.layout.absorber_guide_exported]),finite(b.y[model.layout.absorber_guide_exported]-initial[model.layout.absorber_guide_exported]),finite(a.bundle_power[4..].iter().sum()),finite(b.bundle_power[4..].iter().sum()),witness.0,finite(witness.1),finite(witness.2),witness.3))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_wrong_zero_cannot_qualify_new_nuclear_path() {
        assert!(!developed(&[0.; 6], &[0.; 6]));
        assert!(developed(
            &[1e-6, 2e-6, 3e-6, 0., 1e-6],
            &[1e-6, 2e-6, 3e-6, 0., 1e-6]
        ));
        assert!(!developed(
            &[1e-6, 0., 3e-6, 0., 1e-6],
            &[1e-6, 0., 3e-6, 0., 1e-6]
        ));
        assert!(!developed(
            &[1e-6, 2e-6, 3e-6, 0., 0.],
            &[1e-6, 2e-6, 3e-6, 0., 0.]
        ));
    }
}

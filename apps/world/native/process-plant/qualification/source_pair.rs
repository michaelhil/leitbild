//! Shared source-consequences-1 common-time comparison. No integrator or
//! physical law; source-only and joined cooling qualifiers use this same policy.
use super::{COUNT_ATOL, ENERGY_ATOL, finite, quote, ratio, source_accuracy::Accuracy};
use leitbild_plant_numerics::{
    fuel_history, fuel_source,
    source_evolution::{Diagnostics, Evolution},
};

pub(super) struct SourceSample<'a> {
    pub time: f64,
    pub y: &'a [f64],
    pub d: Diagnostics,
    pub captured_targets: &'a [f64],
    pub nc_coefficients: &'a [f64],
}

#[derive(Debug)]
pub(super) struct LocalDiscrepancy {
    pub time: f64,
    pub source: &'static str,
    pub index: usize,
    pub family: &'static str,
    pub normal: f64,
    pub tighter: f64,
    pub difference: f64,
    pub bound: f64,
    pub atol: f64,
    pub ratio: f64,
}
impl LocalDiscrepancy {
    pub fn json(&self) -> String {
        format!(
            "{{\"time\":{},\"source\":{},\"index\":{},\"family\":{},\"normal\":{},\"tighter\":{},\"absoluteDifference\":{},\"bound\":{},\"atol\":{},\"ratio\":{}}}",
            finite(self.time),
            quote(self.source),
            self.index,
            quote(self.family),
            finite(self.normal),
            finite(self.tighter),
            finite(self.difference),
            finite(self.bound),
            finite(self.atol),
            finite(self.ratio)
        )
    }
}
pub(super) fn local_family(model: &Evolution, row: usize) -> &'static str {
    if row < model.region_count() * fuel_source::GROUPS {
        "neutrons"
    } else if row < model.nc_dimension() {
        "precursors"
    } else if row == model.cf_row() {
        "Cf-spent"
    } else if row < model.history_dimension() {
        if model.is_energy_row(row) {
            "E25"
        } else {
            "fuel-isotope-poison-products"
        }
    } else if row < model.target_row(0) {
        "shared-water-HB"
    } else if row < model.mn_product_row(0) {
        if model
            .mn_targets()
            .iter()
            .any(|m| model.target_row(m.target) == row)
        {
            "Mn56-inventory"
        } else {
            "target-capture-progress"
        }
    } else if row < model.ledger_row() {
        "Fe56-product"
    } else {
        "independent-audit-integrals"
    }
}
pub(super) fn local_discrepancy(
    model: &Evolution,
    a: &SourceSample<'_>,
    b: &SourceSample<'_>,
) -> Result<LocalDiscrepancy, String> {
    if a.time != b.time
        || !a.time.is_finite()
        || a.y.len() != model.state_count()
        || b.y.len() != model.state_count()
        || a.captured_targets.len() != b.captured_targets.len()
        || a.captured_targets.len() != model.mn_product_row(0) - model.target_row(0)
    {
        return Err("Wrong local common-output comparison shape/time".into());
    }
    let mut worst = None;
    for (source, index, x, y, atol) in
        a.y.iter()
            .zip(b.y)
            .enumerate()
            .map(|(i, (&x, &y))| {
                (
                    "native-state-row",
                    i,
                    x,
                    y,
                    if model.is_energy_row(i) {
                        ENERGY_ATOL
                    } else {
                        COUNT_ATOL
                    },
                )
            })
            .chain(
                a.captured_targets
                    .iter()
                    .zip(b.captured_targets)
                    .enumerate()
                    .map(|(i, (&x, &y))| ("derived-capture-target", i, x, y, COUNT_ATOL)),
            )
    {
        let difference = (x - y).abs();
        let bound = 1e-3 * y.abs() + 20. * atol;
        let value = ratio(difference, bound)?;
        if worst
            .as_ref()
            .is_none_or(|w: &LocalDiscrepancy| value > w.ratio)
        {
            worst = Some(LocalDiscrepancy {
                time: a.time,
                source,
                index,
                family: if source == "native-state-row" {
                    local_family(model, index)
                } else {
                    "physical-target-capture-consumption"
                },
                normal: x,
                tighter: y,
                difference,
                bound,
                atol,
                ratio: value,
            });
        }
    }
    worst.ok_or("Empty local comparison".into())
}
pub(super) fn pair_families(model: &Evolution) -> Vec<Vec<usize>> {
    // Never SUMABS unlike units (counts and joules) into one error family.
    let mut families = vec![
        (0..model.region_count() * fuel_source::GROUPS).collect::<Vec<_>>(),
        (model.region_count() * fuel_source::GROUPS..model.nc_dimension()).collect(),
    ];
    for slot in 0..fuel_history::ENERGY {
        families.push(
            (0..model.segment_count())
                .map(|s| model.nc_dimension() + s * fuel_history::HISTORY + slot)
                .collect(),
        );
    }
    families.push(
        model
            .energy_rows()
            .filter(|&i| i < model.cf_row())
            .collect(),
    );
    families.push(vec![model.cf_row()]);
    families.push((model.history_dimension()..model.target_row(0)).collect());
    families.push((model.target_row(0)..model.mn_product_row(0)).collect());
    // Live Mn inventories must also stand alone: unrelated passive capture
    // progress must not dilute their aggregate comparison.
    families.push(
        model
            .mn_targets()
            .iter()
            .map(|target| model.target_row(target.target))
            .collect(),
    );
    families.push((model.mn_product_row(0)..model.ledger_row()).collect());
    families.push(vec![model.escape_row(), model.collected_row()]);
    families.push(vec![model.fuel_release_row()]);
    families
}

pub(super) struct RawPairComparator {
    pub families: Vec<Vec<usize>>,
}
pub(super) struct PairComparison {
    pub local: LocalDiscrepancy,
    pub family_ratio: f64,
    pub observable_ratio: f64,
    pub compared_families: usize,
    pub negligible_families: usize,
    pub raw_local_ratio: f64,
    pub raw_family_ratio: f64,
    pub nc_ratio: f64,
    pub nc_worst: Option<(usize, usize, f64, f64, f64)>,
}
impl PairComparison {
    pub fn failed(&self) -> bool {
        self.local.ratio > 1.
            || self.family_ratio > 1.
            || self.observable_ratio > 1.
            || self.nc_ratio > 1.
    }
    pub fn json(&self) -> String {
        format!(
            "{{\"comparisonScope\":\"one-common-time;not-full-pair\",\"accuracyPolicy\":\"source-consequences-1\",\"time\":{},\"local\":{},\"SUMABSFamilyPairRatio\":{},\"observablePairRatio\":{},\"comparedFamilyOutputs\":{},\"negligibleFamilyOutputs\":{},\"rawAtomCountDiagnostic\":{{\"localPairRatio\":{},\"SUMABSFamilyPairRatio\":{},\"admission\":false}},\"NCOperatorPairRatio\":{},\"worstNCOperator\":{}}}",
            finite(self.local.time),
            self.local.json(),
            finite(self.family_ratio),
            finite(self.observable_ratio),
            self.compared_families,
            self.negligible_families,
            finite(self.raw_local_ratio),finite(self.raw_family_ratio),finite(self.nc_ratio),
            self.nc_worst.map_or("null".into(), |(row,column,normal,tighter,scale)| format!("{{\"row\":{row},\"column\":{column},\"normal\":{},\"tighter\":{},\"rowScale\":{}}}",finite(normal),finite(tighter),finite(scale)))
        )
    }
}
impl RawPairComparator {
    pub fn new(model: &Evolution) -> Self {
        Self {
            families: pair_families(model),
        }
    }
    pub fn compare(
        &self,
        model: &Evolution,
        a: &SourceSample<'_>,
        b: &SourceSample<'_>,
    ) -> Result<PairComparison, String> {
        if b.time <= 0. {
            return Err("Invalid paired observable time".into());
        }
        let mut result = PairComparison {
            local: local_discrepancy(model, a, b)?,
            family_ratio: 0.,
            observable_ratio: 0.,
            compared_families: 0,
            negligible_families: 0,
            raw_local_ratio: 0.,
            raw_family_ratio: 0.,
            nc_ratio: 0.,
            nc_worst: None,
        };
        // Native M/F receive the existing coordinate checks above.
        // Also retain the OLD physical capture C=M+F comparison and
        // its unchanged local and SUMABS-family thresholds.
        if a.captured_targets.len() != b.captured_targets.len()
            || a.captured_targets.len() != model.mn_product_row(0) - model.target_row(0)
        {
            return Err("Wrong common-output capture-consumption dimension".into());
        }
        let mut capture_error = 0.;
        let mut capture_signal = 0.;
        for (&x, &y) in a.captured_targets.iter().zip(b.captured_targets) {
            capture_error += (x - y).abs();
            capture_signal += y.abs();
        }
        let capture_resolution = 20. * COUNT_ATOL * b.captured_targets.len() as f64;
        if !capture_error.is_finite()
            || !capture_signal.is_finite()
            || !capture_resolution.is_finite()
        {
            return Err("Nonfinite capture-consumption comparison".into());
        }
        if capture_signal > 100. * capture_resolution {
            result.compared_families += 1;
            result.family_ratio = result.family_ratio.max(ratio(
                capture_error,
                1e-3 * capture_signal + capture_resolution,
            )?);
        } else {
            result.negligible_families += 1;
        }
        for rows in &self.families {
            let error = rows.iter().map(|&i| (a.y[i] - b.y[i]).abs()).sum::<f64>();
            let signal = rows.iter().map(|&i| b.y[i].abs()).sum::<f64>();
            let resolution = rows
                .iter()
                .map(|&i| {
                    20. * if model.is_energy_row(i) {
                        ENERGY_ATOL
                    } else {
                        COUNT_ATOL
                    }
                })
                .sum::<f64>();
            if !signal.is_finite() || !resolution.is_finite() || !error.is_finite() {
                return Err("Nonfinite family comparison operand".into());
            }
            if signal > 100. * resolution {
                result.compared_families += 1;
                result.family_ratio = result
                    .family_ratio
                    .max(ratio(error, 1e-3 * signal + resolution)?);
            } else {
                result.negligible_families += 1;
            }
        }
        for (x, y, absolute_resolution) in [
            (
                a.d.induced_fission_events_s,
                b.d.induced_fission_events_s,
                COUNT_ATOL,
            ),
            (a.d.escape_neutrons_s, b.d.escape_neutrons_s, COUNT_ATOL),
            (a.d.collected_events_s, b.d.collected_events_s, COUNT_ATOL),
            (a.d.capture_events_s, b.d.capture_events_s, COUNT_ATOL),
            (a.d.cf_release_w, b.d.cf_release_w, ENERGY_ATOL),
            (a.d.fuel_release_w, b.d.fuel_release_w, ENERGY_ATOL),
            (
                a.d.mn_electron_release_w,
                b.d.mn_electron_release_w,
                ENERGY_ATOL,
            ),
            (
                a.d.mn_photon_release_w,
                b.d.mn_photon_release_w,
                ENERGY_ATOL,
            ),
        ] {
            result.observable_ratio = result.observable_ratio.max(ratio(
                (x - y).abs(),
                1e-3 * y.abs() + 20. * absolute_resolution / b.time,
            )?);
        }
        Ok(result)
    }
}

// The old atom-count comparison remains evidence, not an admission rule for
// coordinates explicitly replaced by the fixed provisional consequence table.
pub(super) struct PairComparator<'a> {
    pub raw: RawPairComparator,
    pub accuracy: &'a Accuracy,
    pub families: Vec<Vec<usize>>,
}
impl<'a> PairComparator<'a> {
    pub fn new(model: &Evolution, accuracy: &'a Accuracy) -> Self {
        Self {
            raw: RawPairComparator::new(model),
            accuracy,
            families: pair_families(model)
                .into_iter()
                .map(|rows| {
                    rows.into_iter()
                        .filter(|&r| !accuracy.affected(r))
                        .collect()
                })
                .collect(),
        }
    }
    pub fn compare(
        &self,
        model: &Evolution,
        a: &SourceSample<'_>,
        b: &SourceSample<'_>,
    ) -> Result<PairComparison, String> {
        let mut result = self.raw.compare(model, a, b)?;
        result.raw_local_ratio = result.local.ratio;
        result.raw_family_ratio = result.family_ratio;
        let mut selected = None;
        for (i, (&x, &y)) in
            a.y.iter()
                .zip(b.y)
                .enumerate()
                .filter(|(i, _)| !self.accuracy.affected(*i))
        {
            let atol = if model.is_energy_row(i) {
                ENERGY_ATOL
            } else {
                COUNT_ATOL
            };
            let difference = (x - y).abs();
            let bound = 1e-3 * y.abs() + 20. * atol;
            let r = ratio(difference, bound)?;
            if selected
                .as_ref()
                .is_none_or(|w: &LocalDiscrepancy| r > w.ratio)
            {
                selected = Some(LocalDiscrepancy {
                    time: b.time,
                    source: "strict-unaffected-native-row",
                    index: i,
                    family: local_family(model, i),
                    normal: x,
                    tighter: y,
                    difference,
                    bound,
                    atol,
                    ratio: r,
                });
            }
        }
        for c in self.accuracy.consequences(&a.y, &b.y, b.time)? {
            if selected.as_ref().is_none_or(|w| c.ratio > w.ratio) {
                selected = Some(LocalDiscrepancy {
                    time: b.time,
                    source: "selected-local-consequence",
                    index: c.row,
                    family: c.family,
                    normal: c.normal,
                    tighter: c.tighter,
                    difference: c.difference,
                    bound: c.bound,
                    atol: if c.family == "remaining-donor-count" {
                        COUNT_ATOL
                    } else {
                        ENERGY_ATOL
                    },
                    ratio: c.ratio,
                });
            }
        }
        result.local = selected.ok_or("Empty selected comparison")?;
        result.family_ratio = 0.;
        result.compared_families = 0;
        result.negligible_families = 0;
        for rows in &self.families {
            if rows.is_empty() {
                continue;
            }
            let error = rows.iter().map(|&r| (a.y[r] - b.y[r]).abs()).sum::<f64>();
            let signal = rows.iter().map(|&r| b.y[r].abs()).sum::<f64>();
            let resolution = rows
                .iter()
                .map(|&r| {
                    20. * if model.is_energy_row(r) {
                        ENERGY_ATOL
                    } else {
                        COUNT_ATOL
                    }
                })
                .sum::<f64>();
            if !error.is_finite() || !signal.is_finite() || !resolution.is_finite() {
                return Err("Nonfinite selected family".into());
            }
            if signal > 100. * resolution {
                result.compared_families += 1;
                result.family_ratio = result
                    .family_ratio
                    .max(ratio(error, 1e-3 * signal + resolution)?);
            } else {
                result.negligible_families += 1;
            }
        }
        let pattern = model.nc_pattern();
        if a.nc_coefficients.len() != pattern.len() || b.nc_coefficients.len() != pattern.len() {
            return Err("Wrong current NC coefficient comparison shape".into());
        }
        let mut row_scale = vec![0f64; model.nc_dimension()];
        for ((&(row, _), &x), &y) in pattern.iter().zip(a.nc_coefficients).zip(b.nc_coefficients) {
            if !x.is_finite() || !y.is_finite() {
                return Err("Nonfinite current NC coefficient".into());
            }
            row_scale[row] = row_scale[row].max(x.abs()).max(y.abs());
        }
        for ((&(row, column), &x), &y) in
            pattern.iter().zip(a.nc_coefficients).zip(b.nc_coefficients)
        {
            if !x.is_finite() {
                return Err("Nonfinite normal NC coefficient".into());
            }
            let difference = (x - y).abs();
            let r = if row_scale[row] == 0. {
                if difference != 0. {
                    return Err("Nonzero comparison against exact-zero NC row".into());
                }
                0.
            } else {
                ratio(difference, 1e-3 * row_scale[row])?
            };
            if result.nc_worst.is_none() || r > result.nc_ratio {
                result.nc_ratio = r;
                result.nc_worst = Some((row, column, x, y, row_scale[row]));
            }
        }
        Ok(result)
    }
}

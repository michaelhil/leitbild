//! Sparse current gross binding-power response; shares the source constitutive
//! recipes, without EOS, source transport, stage mutation or per-call allocation.
use super::*;
struct Row {
    recipe: crate::fuel_source::CaptureRecipe,
    neutron: usize,
    captured: usize,
    spontaneous: usize,
    xenon: usize,
    samarium: usize,
    reference: f64,
    poison: [f64; 2],
    slots: Vec<usize>,
}
pub struct CapturePowerResponse {
    history: usize,
    temperatures: usize,
    q: [f64; 3],
    rows: Vec<Row>,
    offsets: Vec<usize>,
    columns: Vec<usize>,
}
impl CapturePowerResponse {
    pub(crate) fn new(a: &Assembly, q: [f64; 3]) -> Result<Self, String> {
        if q.iter().any(|x| !x.is_finite() || *x <= 0.) {
            return Err("Invalid capture event energies".into());
        }
        let mut result = Self {
            history: a.state_count(),
            temperatures: a.fuel.cohorts().len(),
            q,
            rows: Vec::new(),
            offsets: vec![0],
            columns: Vec::new(),
        };
        for (i, e) in a.fuel.intersections().iter().enumerate() {
            let h = a.history_row(e.segment, 0);
            let recipe = a.fuel.capture_recipe(i).clone();
            let poison = [a.poison.xe_sigma_m2, a.poison.sm_sigma_m2].map(|s| {
                poison_capture_coefficient(
                    a.fuel.law().speed[6],
                    a.fuel.volumes()[e.region],
                    e.volume / a.volumes[e.segment],
                    s,
                )
            });
            for g in 0..GROUPS {
                let active = a.fuel.law().absorption[g] > a.fuel.law().fission[g];
                let paid = q[0] * recipe.base[g];
                if !paid.is_finite() || (active && paid == 0.) {
                    return Err("Unrepresentable positive fertile-capture power coefficient".into());
                }
            }
            for (j, s) in [a.poison.xe_sigma_m2, a.poison.sm_sigma_m2]
                .into_iter()
                .enumerate()
            {
                let paid = q[j + 1] * poison[j];
                if !paid.is_finite() || (s > 0. && paid == 0.) {
                    return Err("Unrepresentable positive poison-capture power coefficient".into());
                }
            }
            if recipe
                .base
                .iter()
                .chain(poison.iter())
                .any(|x| !x.is_finite() || *x < 0.)
            {
                return Err("Unrepresentable capture response coefficient".into());
            }
            let mut columns = (0..GROUPS)
                .map(|g| e.region * GROUPS + g)
                .collect::<Vec<_>>();
            columns.extend([h + CAPTURED_238, h + SF_238, h + XENON, h + SAMARIUM]);
            columns.extend(recipe.weights.iter().map(|&(c, _)| result.history + c));
            columns.sort_unstable();
            columns.dedup();
            let start = result.columns.len();
            let mut raw = (0..GROUPS)
                .map(|g| e.region * GROUPS + g)
                .collect::<Vec<_>>();
            raw.extend([h + CAPTURED_238, h + SF_238, h + XENON, h + SAMARIUM]);
            raw.extend(recipe.weights.iter().map(|&(c, _)| result.history + c));
            let slots = raw
                .iter()
                .map(|c| start + columns.binary_search(c).unwrap())
                .collect();
            result.columns.extend(columns);
            result.offsets.push(result.columns.len());
            result.rows.push(Row {
                recipe,
                neutron: e.region * GROUPS,
                captured: h + CAPTURED_238,
                spontaneous: h + SF_238,
                xenon: h + XENON,
                samarium: h + SAMARIUM,
                reference: a.segments[e.segment].reference_u238,
                poison,
                slots,
            });
        }
        Ok(result)
    }
    pub fn history_state_count(&self) -> usize {
        self.history
    }
    pub fn state_count(&self) -> usize {
        self.history + self.temperatures
    }
    pub fn output_count(&self) -> usize {
        self.rows.len()
    }
    pub fn columns(&self) -> &[usize] {
        &self.columns
    }
    pub fn offsets(&self) -> &[usize] {
        &self.offsets
    }
    pub fn evaluate(
        &self,
        y: &[f64],
        temperatures: &[f64],
        powers: &mut [f64],
        gradients: &mut [f64],
    ) -> Result<(), String> {
        if y.len() != self.history
            || temperatures.len() != self.temperatures
            || powers.len() != self.rows.len()
            || gradients.len() != self.columns.len()
            || y.iter().any(|v| !v.is_finite())
            || temperatures
                .iter()
                .any(|v| !v.is_finite() || *v < 290. || *v > 2000.)
        {
            return Err("Invalid current capture-power response".into());
        }
        gradients.fill(0.);
        for (i, r) in self.rows.iter().enumerate() {
            // Preserve the actual source's ordered finite-reserve arithmetic.
            let remaining = r.reference - y[r.captured] - y[r.spontaneous];
            let ratio = remaining / r.reference;
            let (capture, unit) = r
                .recipe
                .current_and_unit(|c| (temperatures[c] / 300.).sqrt(), ratio);
            let mut fertile = 0.;
            let mut dspent = 0.;
            for g in 0..GROUPS {
                fertile += capture[g] * y[r.neutron + g];
                gradients[r.slots[g]] += self.q[0] * capture[g];
                dspent -= self.q[0] * unit[g] / r.reference * y[r.neutron + g];
            }
            gradients[r.slots[GROUPS]] += dspent;
            gradients[r.slots[GROUPS + 1]] += dspent;
            let n = y[r.neutron + 6];
            let xe = r.poison[0] * n * y[r.xenon];
            let sm = r.poison[1] * n * y[r.samarium];
            gradients[r.slots[6]] +=
                self.q[1] * r.poison[0] * y[r.xenon] + self.q[2] * r.poison[1] * y[r.samarium];
            gradients[r.slots[GROUPS + 2]] += self.q[1] * r.poison[0] * n;
            gradients[r.slots[GROUPS + 3]] += self.q[2] * r.poison[1] * n;
            for (j, &(c, m)) in r.recipe.weights.iter().enumerate() {
                let root = (temperatures[c] / 300.).sqrt();
                let d = (2..=3)
                    .map(|g| r.recipe.thermal_partial_root(g, m, root, ratio) * y[r.neutron + g])
                    .sum::<f64>();
                gradients[r.slots[GROUPS + 4 + j]] += self.q[0] * d;
            }
            powers[i] = self.q[0] * fertile + self.q[1] * xe + self.q[2] * sm;
        }
        if powers
            .iter()
            .chain(gradients.iter())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite current capture-power response".into());
        }
        Ok(())
    }
}

//! Current bulk-capture/Mn release response, with fixed sparse support. This
//! owns no thermal routing or evaluated-stage cache.
use super::Evolution;
use std::collections::BTreeSet;

struct Capture {
    neutron: usize,
    consumed: Vec<usize>,
    reference: f64,
    gain: f64,
    neutron_slot: usize,
    consumed_slots: Vec<usize>,
}
pub struct BarrelResponse {
    dimension: usize,
    offsets: [usize; 3],
    columns: Vec<usize>,
    captures: Vec<Capture>,
    decay: Vec<(usize, usize, f64)>,
}
impl Evolution {
    /// Two positive physical release channels: prompt target binding and
    /// selected Mn electron+photon decay. Signed finite solver trials are not
    /// clipped. Route/density sensitivities belong to the coupled heat law.
    pub fn barrel_response(
        &self,
        targets: [usize; 4],
        emission: [f64; 4],
    ) -> Result<BarrelResponse, &'static str> {
        if targets.iter().copied().collect::<BTreeSet<_>>().len() != 4
            || emission.iter().any(|q| !q.is_finite() || *q <= 0.)
        {
            return Err("Invalid barrel response target/emission ownership");
        }
        if self
            .input
            .cylinder_targets
            .iter()
            .any(|t| targets.contains(&t.index))
            || self
                .input
                .optical_layers
                .iter()
                .flatten()
                .flat_map(|l| &l.columns)
                .any(|c| targets.contains(&c.target))
        {
            return Err("Barrel bulk response cannot include optical/cylindrical target ownership");
        }
        let terms = self.passive.capture_response(&targets)?;
        let mut support = BTreeSet::new();
        let mut captures = Vec::new();
        for (target, neutron, coefficient) in terms {
            let q = emission[targets.iter().position(|&t| t == target).unwrap()];
            let reference = self.input.targets[target];
            let gain = coefficient * reference * q;
            if !reference.is_finite() || reference <= 0. || !gain.is_finite() || gain <= 0. {
                return Err("Unrepresentable structural barrel power response");
            }
            let mut consumed = vec![self.target_row(target)];
            if let Some(i) = self.mn_owner[target] {
                consumed.push(self.mn_product_row(i));
            }
            support.insert(neutron);
            support.extend(consumed.iter().copied());
            captures.push(Capture {
                neutron,
                consumed,
                reference,
                gain,
                neutron_slot: 0,
                consumed_slots: Vec::new(),
            });
        }
        let mut columns = support.into_iter().collect::<Vec<_>>();
        let prompt_end = columns.len();
        for t in &mut captures {
            t.neutron_slot = columns.binary_search(&t.neutron).unwrap();
            t.consumed_slots = t
                .consumed
                .iter()
                .map(|r| columns.binary_search(r).unwrap())
                .collect();
        }
        let mut decay = Vec::new();
        for m in self.input.mn.iter().filter(|m| targets.contains(&m.target)) {
            let row = self.target_row(m.target);
            let gain = m.decay_rate * (m.electron_j + m.photon_j);
            if !gain.is_finite() || gain <= 0. {
                return Err("Unrepresentable barrel Mn release response");
            }
            let slot = columns.len();
            columns.push(row);
            decay.push((row, slot, gain));
        }
        if decay.len() != 1 {
            return Err("Barrel response needs one actual Mn owner");
        }
        Ok(BarrelResponse {
            dimension: self.state_count(),
            offsets: [0, prompt_end, columns.len()],
            columns,
            captures,
            decay,
        })
    }
}
impl BarrelResponse {
    pub fn state_count(&self) -> usize {
        self.dimension
    }
    pub fn output_count(&self) -> usize {
        2
    }
    pub fn offsets(&self) -> &[usize] {
        &self.offsets
    }
    pub fn columns(&self) -> &[usize] {
        &self.columns
    }
    pub fn evaluate(
        &self,
        y: &[f64],
        powers: &mut [f64],
        gradients: &mut [f64],
    ) -> Result<(), &'static str> {
        if y.len() != self.dimension
            || powers.len() != 2
            || gradients.len() != self.columns.len()
            || self.columns.iter().any(|&r| !y[r].is_finite())
        {
            return Err("Invalid current barrel response buffers/state");
        }
        powers.fill(0.);
        gradients.fill(0.);
        for t in &self.captures {
            let consumed = t.consumed.iter().map(|&r| y[r]).sum::<f64>();
            let actual = t.gain * ((t.reference - consumed) / t.reference);
            powers[0] += actual * y[t.neutron];
            gradients[t.neutron_slot] += actual;
            let donor = -t.gain * y[t.neutron] / t.reference;
            for &slot in &t.consumed_slots {
                gradients[slot] += donor;
            }
        }
        for &(row, slot, gain) in &self.decay {
            powers[1] += gain * y[row];
            gradients[slot] += gain;
        }
        if powers
            .iter()
            .chain(gradients.iter())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite current barrel power response");
        }
        Ok(())
    }
}

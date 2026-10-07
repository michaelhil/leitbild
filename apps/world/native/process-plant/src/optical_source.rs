//! Actual ordered, no-scattering planar absorber layers. This is the rack/gate
//! law, NOT the bulk head, cylindrical body or converter-film law.
//! NIST DLMF 8.19.8/12/13/17 supplies E_n series, recurrence and derivatives.
use crate::transport_source::{GROUPS, OpticalInput};
const GAMMA: f64 = 0.5772156649015329;

#[derive(Clone, Copy, Debug)]
pub struct Attenuation {
    pub transmission: f64,
    /// Computed independently of 1-T near transparency; never an opacity floor.
    pub loss: f64,
    pub derivative: f64,
}

fn continued(n: usize, x: f64) -> Result<f64, &'static str> {
    // Contracted form of the positive-real E_n continued fraction. Modified
    // Lentz iteration; a zero/nonfinite divisor refuses instead of a floor.
    let mut b = x + n as f64;
    let mut c = f64::MAX;
    let mut d = 1. / b;
    let mut h = d;
    for i in 1..=256 {
        let a = -(i as f64) * (n - 1 + i) as f64;
        b += 2.;
        let denominator = a * d + b;
        c = b + a / c;
        if denominator == 0. || c == 0. || !denominator.is_finite() || !c.is_finite() {
            return Err("Exponential integral lost finite continued fraction");
        }
        d = 1. / denominator;
        let change = c * d;
        h *= change;
        if (change - 1.).abs() <= 8. * f64::EPSILON {
            return Ok(h * (-x).exp());
        }
    }
    Err("Exponential integral did not converge")
}

/// T=2E3(tau), dT/dtau=-2E2(tau); tau is actual finite target column depth.
pub fn attenuation(tau: f64) -> Result<Attenuation, &'static str> {
    if !tau.is_finite() || tau < 0. {
        return Err("Invalid physical optical depth");
    }
    if tau == 0. {
        return Ok(Attenuation {
            transmission: 1.,
            loss: 0.,
            derivative: -2.,
        });
    }
    let (t, loss, e2) = if tau <= 1. {
        let mut loss = 2. * tau - tau * tau * (1.5 - GAMMA - tau.ln());
        let mut factorial_power = tau * tau / 2.;
        // Nonlogarithmic tail of the n=3 series. Direct loss avoids subtracting
        // nearly equal unit transmissions for dilute physical target stocks.
        for k in 3..=128 {
            factorial_power *= -tau / k as f64;
            let term = 2. * factorial_power / (k - 2) as f64;
            loss += term;
            if term.abs() <= f64::EPSILON * loss.abs() {
                break;
            }
            if k == 128 {
                return Err("Exponential integral series did not converge");
            }
        }
        let mut e1 = -GAMMA - tau.ln();
        let mut term = -tau;
        for k in 1..=128 {
            let delta = -term / k as f64;
            e1 += delta;
            if delta.abs() <= f64::EPSILON * e1.abs() {
                break;
            }
            term *= -tau / (k + 1) as f64;
            if k == 128 {
                return Err("E1 series did not converge");
            }
        }
        (1. - loss, loss, (-tau).exp() - tau * e1)
    } else {
        let t = 2. * continued(3, tau)?;
        (t, 1. - t, continued(2, tau)?)
    };
    if !t.is_finite()
        || !(0. ..=1.).contains(&t)
        || !loss.is_finite()
        || !(0. ..=1.).contains(&loss)
        || !e2.is_finite()
        || e2 < 0.
    {
        return Err("Invalid evaluated optical response");
    }
    Ok(Attenuation {
        transmission: t,
        loss,
        derivative: -2. * e2,
    })
}

fn layer_loss(before: f64, depth: f64) -> Result<f64, &'static str> {
    if depth == 0. {
        return Ok(0.);
    }
    if before == 0. {
        return Ok(attenuation(depth)?.loss);
    }
    // Integrate the analytic derivative for a very thin layer behind a thick
    // one: subtracting rounded E3 values could falsely delete its captures.
    if depth <= 1e-5 * (1. + before) {
        const X: [f64; 4] = [
            0.1834346424956498,
            0.525532409916329,
            0.7966664774136267,
            0.9602898564975363,
        ];
        const W: [f64; 4] = [
            0.362683783378362,
            0.3137066458778873,
            0.2223810344533745,
            0.1012285362903763,
        ];
        let mut value = 0.;
        for k in 0..4 {
            for sign in [-1., 1.] {
                value -= W[k] * attenuation(before + depth * (1. + sign * X[k]) / 2.)?.derivative;
            }
        }
        return Ok(value * depth / 2.);
    }
    let a = attenuation(before)?;
    let b = attenuation(before + depth)?;
    Ok(if a.loss < 0.5 {
        b.loss - a.loss
    } else {
        a.transmission - b.transmission
    })
}

#[derive(Clone, Debug)]
pub struct Column {
    pub target: usize,
    pub atoms_per_m2: f64,
    pub sigma_m2: [f64; GROUPS],
}
#[derive(Clone, Debug)]
pub struct Layer {
    pub columns: Vec<Column>,
}
pub struct LayerResponse {
    /// Flattened in physical left-to-right layer order, including shared IDs.
    pub targets: Vec<usize>,
    pub input: OpticalInput,
    pub transmission_derivative: [f64; GROUPS],
}

pub fn layer_response(layers: &[Layer]) -> Result<LayerResponse, &'static str> {
    if layers.is_empty() || layers.iter().any(|l| l.columns.is_empty()) {
        return Err("Missing actual optical layer targets");
    }
    let targets: Vec<_> = layers
        .iter()
        .flat_map(|l| l.columns.iter().map(|c| c.target))
        .collect();
    let mut from_left = vec![[0.; GROUPS]; targets.len()];
    let mut from_right = from_left.clone();
    let mut transmission = [0.; GROUPS];
    let mut loss = [0.; GROUPS];
    let mut derivative = [0.; GROUPS];
    for g in 0..GROUPS {
        let depths: Vec<_> = layers
            .iter()
            .map(|l| {
                l.columns
                    .iter()
                    .map(|c| {
                        if !c.atoms_per_m2.is_finite()
                            || c.atoms_per_m2 < 0.
                            || !c.sigma_m2[g].is_finite()
                            || c.sigma_m2[g] < 0.
                        {
                            return Err("Invalid optical target column");
                        }
                        let d = c.atoms_per_m2 * c.sigma_m2[g];
                        if !d.is_finite() {
                            return Err("Nonfinite optical target depth");
                        }
                        Ok(d)
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        let sums: Vec<f64> = depths.iter().map(|d| d.iter().sum()).collect();
        let total: f64 = sums.iter().sum();
        let response = attenuation(total)?;
        transmission[g] = response.transmission;
        loss[g] = response.loss;
        derivative[g] = response.derivative;
        if response.loss == 0. {
            continue;
        }
        let mut prefix = 0.;
        let mut j = 0;
        for (k, d) in depths.iter().enumerate() {
            let thickness = sums[k];
            // Recompute nonnegative suffix by actual remaining layer depths;
            // subtraction can leave a negative ulp at the final real layer.
            let remaining: f64 = sums[k + 1..].iter().sum();
            let left = layer_loss(prefix, thickness)? / response.loss;
            let right = layer_loss(remaining, thickness)? / response.loss;
            for &part in d {
                if thickness > 0. {
                    from_left[j][g] = left * part / thickness;
                    from_right[j][g] = right * part / thickness;
                }
                j += 1;
            }
            prefix += thickness;
        }
        for allocations in [&from_left, &from_right] {
            let sum: f64 = allocations.iter().map(|a| a[g]).sum();
            if (sum - 1.).abs() > 3e-12
                || allocations.iter().any(|a| !a[g].is_finite() || a[g] < 0.)
            {
                return Err("Optical target allocation failed conservation");
            }
        }
    }
    Ok(LayerResponse {
        targets,
        input: OpticalInput {
            transmission,
            loss,
            from_left,
            from_right,
        },
        transmission_derivative: derivative,
    })
}

/// Fixed physical layer/target mapping for advancing finite material histories.
/// Target coefficients are prepared once; no runtime allocation or opacity floor.
pub struct LayerModel {
    columns: Vec<(usize, [f64; GROUPS])>,
    ends: Vec<usize>,
    consumed_targets: Vec<usize>,
    target_count: usize,
    owner: std::sync::Arc<()>,
}
pub struct LayerWorkspace {
    pub input: OpticalInput,
    /// Unnormalized per-target side probabilities. Unlike normalized
    /// allocations, their derivatives exist at complete transparency.
    pub left_loss: Vec<[f64; GROUPS]>,
    pub right_loss: Vec<[f64; GROUPS]>,
    pub left_loss_jvp: Vec<[f64; GROUPS]>,
    pub right_loss_jvp: Vec<[f64; GROUPS]>,
    pub transmission_jvp: [f64; GROUPS],
    depths: Vec<[f64; GROUPS]>,
    direction: Vec<[f64; GROUPS]>,
    sums: Vec<[f64; GROUPS]>,
    sum_direction: Vec<[f64; GROUPS]>,
    response: [Attenuation; GROUPS],
    left: Vec<[SideLoss; GROUPS]>,
    right: Vec<[SideLoss; GROUPS]>,
    amount_bits: Vec<u64>,
    owner: std::sync::Arc<()>,
    valid: bool,
}
impl LayerWorkspace {
    /// Retained numeric Vec payload only, excluding allocator/model metadata.
    pub fn buffer_bytes(&self) -> usize {
        (self.input.from_left.len()
            + self.input.from_right.len()
            + self.left_loss.len()
            + self.right_loss.len()
            + self.left_loss_jvp.len()
            + self.right_loss_jvp.len()
            + self.depths.len()
            + self.direction.len()
            + self.sums.len()
            + self.sum_direction.len())
            * std::mem::size_of::<[f64; GROUPS]>()
            + (self.left.len() + self.right.len()) * std::mem::size_of::<[SideLoss; GROUPS]>()
            + self.amount_bits.len() * std::mem::size_of::<u64>()
    }
}
/// Stage-local scalar factors, not an expanded target-by-target Jacobian.
#[derive(Clone, Copy, Default)]
struct SideLoss {
    loss: f64,
    before: f64,
    depth: f64,
}

fn side_loss(before: f64, depth: f64) -> Result<SideLoss, &'static str> {
    let loss = layer_loss(before, depth)?;
    let (db, dd) = if depth == 0. {
        (0., -attenuation(before)?.derivative)
    } else if before > 0. && depth <= 1e-5 * (1. + before) {
        // The SAME stable thin-layer quadrature as layer_loss_jvp below,
        // factored into its two linear directional coefficients once/stage.
        const X: [f64; 4] = [
            0.1834346424956498,
            0.525532409916329,
            0.7966664774136267,
            0.9602898564975363,
        ];
        const W: [f64; 4] = [
            0.362683783378362,
            0.3137066458778873,
            0.2223810344533745,
            0.1012285362903763,
        ];
        let (mut db, mut dd) = (0., 0.);
        for k in 0..4 {
            for sign in [-1., 1.] {
                let s = (1. + sign * X[k]) / 2.;
                let x = before + depth * s;
                let second = 2. * e1(x)?;
                db -= W[k] * depth * second / 2.;
                dd += W[k] * (-attenuation(x)?.derivative - depth * second * s) / 2.;
            }
        }
        (db, dd)
    } else {
        let end = attenuation(before + depth)?.derivative;
        (attenuation(before)?.derivative - end, -end)
    };
    if [loss, db, dd].iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite optical side-loss factors");
    }
    Ok(SideLoss {
        loss,
        before: db,
        depth: dd,
    })
}
fn e1(x: f64) -> Result<f64, &'static str> {
    if !x.is_finite() || x <= 0. {
        return Err("E1 positive argument required");
    }
    if x > 1. {
        return continued(1, x);
    }
    let mut value = -GAMMA - x.ln();
    let mut term = -x;
    for k in 1..=128 {
        let delta = -term / k as f64;
        value += delta;
        if delta.abs() <= f64::EPSILON * value.abs() {
            return Ok(value);
        }
        term *= -x / (k + 1) as f64;
    }
    Err("E1 derivative series did not converge")
}
#[cfg(test)]
fn layer_loss_jvp(before: f64, depth: f64, db: f64, dd: f64) -> Result<f64, &'static str> {
    if depth == 0. {
        return Ok(-attenuation(before)?.derivative * dd);
    }
    if before == 0. && db == 0. {
        return Ok(-attenuation(depth)?.derivative * dd);
    }
    if before > 0. && depth <= 1e-5 * (1. + before) {
        const X: [f64; 4] = [
            0.1834346424956498,
            0.525532409916329,
            0.7966664774136267,
            0.9602898564975363,
        ];
        const W: [f64; 4] = [
            0.362683783378362,
            0.3137066458778873,
            0.2223810344533745,
            0.1012285362903763,
        ];
        let mut value = 0.;
        for k in 0..4 {
            for sign in [-1., 1.] {
                let s = (1. + sign * X[k]) / 2.;
                let x = before + depth * s;
                value += W[k]
                    * (-attenuation(x)?.derivative * dd - depth * 2. * e1(x)? * (db + s * dd))
                    / 2.;
            }
        }
        return Ok(value);
    }
    Ok(
        (attenuation(before)?.derivative - attenuation(before + depth)?.derivative) * db
            - attenuation(before + depth)?.derivative * dd,
    )
}
impl LayerModel {
    pub fn new(layers: &[Layer], references: &[f64]) -> Result<Self, &'static str> {
        layer_response(layers)?;
        let mut columns = Vec::new();
        let mut ends = Vec::new();
        let mut consumed_targets = Vec::new();
        for l in layers {
            for c in &l.columns {
                if c.target >= references.len()
                    || !references[c.target].is_finite()
                    || references[c.target] < 0.
                    || (references[c.target] == 0. && c.atoms_per_m2 != 0.)
                {
                    return Err("Unowned optical reference target");
                }
                let scale = if references[c.target] > 0. {
                    c.atoms_per_m2 / references[c.target]
                } else {
                    0.
                };
                let coefficient = std::array::from_fn(|g| scale * c.sigma_m2[g]);
                if coefficient.iter().any(|v| !v.is_finite()) {
                    return Err("Nonfinite optical target coefficient");
                }
                columns.push((c.target, coefficient));
                if !consumed_targets.contains(&c.target) {
                    consumed_targets.push(c.target);
                }
            }
            ends.push(columns.len());
        }
        Ok(Self {
            columns,
            ends,
            consumed_targets,
            target_count: references.len(),
            owner: std::sync::Arc::new(()),
        })
    }
    pub fn targets(&self) -> impl Iterator<Item = usize> + '_ {
        self.columns.iter().map(|c| c.0)
    }
    pub fn workspace(&self) -> LayerWorkspace {
        let n = self.columns.len();
        let l = self.ends.len();
        LayerWorkspace {
            input: OpticalInput {
                transmission: [0.; GROUPS],
                loss: [0.; GROUPS],
                from_left: vec![[0.; GROUPS]; n],
                from_right: vec![[0.; GROUPS]; n],
            },
            left_loss: vec![[0.; GROUPS]; n],
            right_loss: vec![[0.; GROUPS]; n],
            left_loss_jvp: vec![[0.; GROUPS]; n],
            right_loss_jvp: vec![[0.; GROUPS]; n],
            transmission_jvp: [0.; GROUPS],
            depths: vec![[0.; GROUPS]; n],
            direction: vec![[0.; GROUPS]; n],
            sums: vec![[0.; GROUPS]; l],
            sum_direction: vec![[0.; GROUPS]; l],
            response: [Attenuation {
                transmission: 0.,
                loss: 0.,
                derivative: 0.,
            }; GROUPS],
            left: vec![[SideLoss::default(); GROUPS]; l],
            right: vec![[SideLoss::default(); GROUPS]; l],
            amount_bits: vec![0; self.consumed_targets.len()],
            owner: self.owner.clone(),
            valid: false,
        }
    }
    pub fn update(&self, amounts: &[f64], w: &mut LayerWorkspace) -> Result<(), &'static str> {
        // Public boundary checks the complete supplied physical vector. The
        // composed owner may do this once before all its face-local updates.
        if amounts.iter().any(|v| !v.is_finite() || *v < 0.) {
            w.valid = false;
            return Err("Invalid advancing optical target amounts");
        }
        self.update_dependencies(amounts, w)
    }
    /// Face-local path after the composed owner has validated the full vector.
    /// Still checks length, workspace ownership and every consumed amount.
    pub(crate) fn update_dependencies(
        &self,
        amounts: &[f64],
        w: &mut LayerWorkspace,
    ) -> Result<(), &'static str> {
        let was_valid = w.valid;
        w.valid = false;
        self.check_workspace(w)?;
        if amounts.len() != self.target_count
            || self
                .columns
                .iter()
                .any(|&(target, _)| !amounts[target].is_finite() || amounts[target] < 0.)
        {
            return Err("Invalid advancing optical target amounts");
        }
        let unchanged = was_valid
            && self
                .consumed_targets
                .iter()
                .zip(&w.amount_bits)
                .all(|(&target, &bits)| amounts[target].to_bits() == bits);
        if !unchanged {
            w.sums.fill([0.; GROUPS]);
            let mut start = 0;
            for (l, &end) in self.ends.iter().enumerate() {
                for j in start..end {
                    for g in 0..GROUPS {
                        w.depths[j][g] = self.columns[j].1[g] * amounts[self.columns[j].0];
                        w.sums[l][g] += w.depths[j][g];
                    }
                }
                start = end;
            }
            for g in 0..GROUPS {
                let total = w.sums.iter().map(|s| s[g]).sum::<f64>();
                let a = attenuation(total)?;
                w.response[g] = a;
                let mut before = 0.;
                for l in 0..self.ends.len() {
                    let depth = w.sums[l][g];
                    let after = w.sums[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                    let left = side_loss(before, depth)?;
                    let right = side_loss(after, depth)?;
                    w.left[l][g] = left;
                    w.right[l][g] = right;
                    before += depth;
                }
            }
            for (&target, bits) in self.consumed_targets.iter().zip(&mut w.amount_bits) {
                *bits = amounts[target].to_bits();
            }
        }
        // Public output buffers can be modified by their caller. Reconstruct
        // them even on an exact dependency hit, without special functions.
        for g in 0..GROUPS {
            let a = w.response[g];
            w.input.transmission[g] = a.transmission;
            w.input.loss[g] = a.loss;
            let mut start = 0;
            for (l, &end) in self.ends.iter().enumerate() {
                let depth = w.sums[l][g];
                for j in start..end {
                    let fraction = if depth > 0. {
                        w.depths[j][g] / depth
                    } else {
                        0.
                    };
                    w.left_loss[j][g] = w.left[l][g].loss * fraction;
                    w.right_loss[j][g] = w.right[l][g].loss * fraction;
                    w.input.from_left[j][g] = if a.loss > 0. {
                        w.left_loss[j][g] / a.loss
                    } else {
                        0.
                    };
                    w.input.from_right[j][g] = if a.loss > 0. {
                        w.right_loss[j][g] / a.loss
                    } else {
                        0.
                    };
                }
                start = end;
            }
        }
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        amount_direction: &[f64],
        w: &mut LayerWorkspace,
    ) -> Result<(), &'static str> {
        if amount_direction.iter().any(|v| !v.is_finite()) {
            return Err("Invalid optical amount direction");
        }
        self.jvp_dependencies(amount_direction, w)
    }
    /// Face-local direction path after one composed full-vector validation.
    pub(crate) fn jvp_dependencies(
        &self,
        amount_direction: &[f64],
        w: &mut LayerWorkspace,
    ) -> Result<(), &'static str> {
        self.check_workspace(w)?;
        if !w.valid
            || amount_direction.len() != self.target_count
            || self
                .columns
                .iter()
                .any(|&(target, _)| !amount_direction[target].is_finite())
        {
            return Err("Invalid optical amount direction");
        }
        self.jvp_columns(w, |target| amount_direction[target])
    }
    /// Emit derivatives with respect to each distinct consumed target amount.
    /// Side-loss rows retain `targets()` column order, including repeated
    /// targets in different layers. A shared target is perturbed in every
    /// column at once and emitted only once. No whole-vector unit direction
    /// is allocated or validated for these local analytic contractions.
    ///
    /// The callback's slices are borrowed scratch valid only during that call.
    /// Base responses remain valid; directional scratch ends with the last
    /// emitted partial, so a subsequent independent JVP must be requested.
    /// Discard the complete emitted transaction if any later partial fails.
    pub fn emit_partials(
        &self,
        w: &mut LayerWorkspace,
        mut emit: impl FnMut(usize, &[f64; GROUPS], &[[f64; GROUPS]], &[[f64; GROUPS]]),
    ) -> Result<(), &'static str> {
        self.check_workspace(w)?;
        if !w.valid {
            return Err("Unprepared optical partial stage");
        }
        for &target in &self.consumed_targets {
            self.jvp_columns(
                w,
                |column_target| if column_target == target { 1. } else { 0. },
            )?;
            emit(
                target,
                &w.transmission_jvp,
                &w.left_loss_jvp,
                &w.right_loss_jvp,
            );
        }
        Ok(())
    }
    fn jvp_columns(
        &self,
        w: &mut LayerWorkspace,
        amount_direction: impl Fn(usize) -> f64,
    ) -> Result<(), &'static str> {
        w.sum_direction.fill([0.; GROUPS]);
        let mut start = 0;
        for (l, &end) in self.ends.iter().enumerate() {
            for j in start..end {
                for g in 0..GROUPS {
                    w.direction[j][g] = self.columns[j].1[g] * amount_direction(self.columns[j].0);
                    w.sum_direction[l][g] += w.direction[j][g];
                }
            }
            start = end;
        }
        for g in 0..GROUPS {
            let dtotal = w.sum_direction.iter().map(|s| s[g]).sum::<f64>();
            w.transmission_jvp[g] = w.response[g].derivative * dtotal;
            let mut db = 0.;
            let mut start = 0;
            for (l, &end) in self.ends.iter().enumerate() {
                let depth = w.sums[l][g];
                let dd = w.sum_direction[l][g];
                let da = w.sum_direction[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                let left = w.left[l][g];
                let right = w.right[l][g];
                let dl = left.before * db + left.depth * dd;
                let dr = right.before * da + right.depth * dd;
                for j in start..end {
                    let part = w.depths[j][g];
                    let dp = w.direction[j][g];
                    if depth == 0. {
                        w.left_loss_jvp[j][g] = left.depth * dp;
                        w.right_loss_jvp[j][g] = right.depth * dp;
                    } else {
                        let fraction = part / depth;
                        let df = (dp - fraction * dd) / depth;
                        w.left_loss_jvp[j][g] = dl * fraction + left.loss * df;
                        w.right_loss_jvp[j][g] = dr * fraction + right.loss * df;
                    }
                }
                db += dd;
                start = end;
            }
        }
        if w.left_loss_jvp
            .iter()
            .chain(&w.right_loss_jvp)
            .flatten()
            .chain(&w.transmission_jvp)
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite advancing optical JVP");
        }
        Ok(())
    }
    fn check_workspace(&self, w: &LayerWorkspace) -> Result<(), &'static str> {
        let n = self.columns.len();
        if !std::sync::Arc::ptr_eq(&self.owner, &w.owner)
            || [
                w.input.from_left.len(),
                w.input.from_right.len(),
                w.left_loss.len(),
                w.right_loss.len(),
                w.left_loss_jvp.len(),
                w.right_loss_jvp.len(),
                w.depths.len(),
                w.direction.len(),
            ]
            .iter()
            .any(|&l| l != n)
            || [
                w.sums.len(),
                w.sum_direction.len(),
                w.left.len(),
                w.right.len(),
            ]
            .iter()
            .any(|&l| l != self.ends.len())
            || w.amount_bits.len() != self.consumed_targets.len()
        {
            return Err("Wrong advancing optical workspace");
        }
        Ok(())
    }
}

#[cfg(test)]
mod partial_tests {
    use super::*;

    // Pre-refactor direct directional formula. It deliberately recomputes all
    // scalar responses instead of reading any prepared SideLoss factors.
    fn direct_jvp(
        model: &LayerModel,
        w: &LayerWorkspace,
        dy: &[f64],
    ) -> ([f64; GROUPS], Vec<[f64; GROUPS]>, Vec<[f64; GROUPS]>) {
        let mut direction = vec![[0.; GROUPS]; model.columns.len()];
        let mut sums = vec![[0.; GROUPS]; model.ends.len()];
        let mut start = 0;
        for (l, &end) in model.ends.iter().enumerate() {
            for j in start..end {
                for g in 0..GROUPS {
                    direction[j][g] = model.columns[j].1[g] * dy[model.columns[j].0];
                    sums[l][g] += direction[j][g];
                }
            }
            start = end;
        }
        let mut transmission = [0.; GROUPS];
        let mut left = vec![[0.; GROUPS]; direction.len()];
        let mut right = left.clone();
        for g in 0..GROUPS {
            let total = w.sums.iter().map(|s| s[g]).sum::<f64>();
            transmission[g] =
                attenuation(total).unwrap().derivative * sums.iter().map(|s| s[g]).sum::<f64>();
            let (mut before, mut db, mut start) = (0., 0., 0);
            for (l, &end) in model.ends.iter().enumerate() {
                let depth = w.sums[l][g];
                let dd = sums[l][g];
                let after = w.sums[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                let da = sums[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                let base_left = layer_loss(before, depth).unwrap();
                let base_right = layer_loss(after, depth).unwrap();
                let dl = layer_loss_jvp(before, depth, db, dd).unwrap();
                let dr = layer_loss_jvp(after, depth, da, dd).unwrap();
                for j in start..end {
                    let part = w.depths[j][g];
                    let dp = direction[j][g];
                    if depth == 0. {
                        left[j][g] = -attenuation(before).unwrap().derivative * dp;
                        right[j][g] = -attenuation(after).unwrap().derivative * dp;
                    } else {
                        let fraction = part / depth;
                        let df = (dp - fraction * dd) / depth;
                        left[j][g] = dl * fraction + base_left * df;
                        right[j][g] = dr * fraction + base_right * df;
                    }
                }
                before += depth;
                db += dd;
                start = end;
            }
        }
        (transmission, left, right)
    }

    fn assert_direct(model: &LayerModel, w: &mut LayerWorkspace, direction: &[f64]) {
        let (t, l, r) = direct_jvp(model, w, direction);
        model.jvp(direction, w).unwrap();
        for g in 0..GROUPS {
            let scale = t[g].abs() + l.iter().chain(&r).map(|a| a[g].abs()).sum::<f64>();
            for (a, b) in std::iter::once(t[g])
                .chain(l.iter().map(|a| a[g]))
                .chain(r.iter().map(|a| a[g]))
                .zip(
                    std::iter::once(w.transmission_jvp[g])
                        .chain(w.left_loss_jvp.iter().map(|a| a[g]))
                        .chain(w.right_loss_jvp.iter().map(|a| a[g])),
                )
            {
                assert!(
                    (a - b).abs() <= 2e-12 * scale.max(1e-300),
                    "{a:e} versus {b:e}, scale {scale:e}"
                );
            }
        }
    }

    #[test]
    fn prepared_side_factors_match_direct_formula_including_zero_and_thin_limits() {
        for before in [0., 1e-20, 0.2, 1., 20., 1000.] {
            for depth in [
                0.,
                1e-20,
                1e-6,
                1e-5 * (1. + before),
                1.000001e-5 * (1. + before),
                0.3,
                20.,
            ] {
                let p = side_loss(before, depth).unwrap();
                assert_eq!(p.loss, layer_loss(before, depth).unwrap());
                for (db, dd) in [(0., 0.), (0., 1.), (1., 0.), (0.3, -0.7), (-1., 1.)] {
                    let direct = layer_loss_jvp(before, depth, db, dd).unwrap();
                    let factored = p.before * db + p.depth * dd;
                    let scale = (p.before * db).abs() + (p.depth * dd).abs();
                    assert!(
                        (direct - factored).abs() <= 2e-12 * scale.max(1e-300),
                        "before {before:e} depth {depth:e}: {direct:e} versus {factored:e}"
                    );
                }
            }
        }
    }

    #[test]
    fn prepared_direction_contraction_matches_direct_ordered_shared_target_operator() {
        let layers = [
            Layer {
                columns: vec![column(1, 0.2), column(3, 0.1)],
            },
            Layer {
                columns: vec![column(1, 0.3)],
            },
            Layer {
                columns: vec![column(4, 1e-20), column(1, 0.7)],
            },
        ];
        let model = LayerModel::new(&layers, &[1.; 5]).unwrap();
        let mut w = model.workspace();
        for amounts in [
            [0.; 5],
            [1., 0., 1., 0.8, 0.],
            [1., 1e-20, 1., 1., 1.],
            [1., 0.8, 1., 1.2, 0.6],
            [1., 1000., 1., 1000., 1000.],
        ] {
            model.update(&amounts, &mut w).unwrap();
            for direction in [
                [0.; 5],
                [0.9, -0.3, -0.2, 0.4, 0.7],
                [0., 0.1, 0., -1.2, 0.],
                [0., 1e-20, 0., -1e-20, 1e-20],
            ] {
                assert_direct(&model, &mut w, &direction);
            }
        }
    }

    #[test]
    fn exact_dependency_reuse_republishes_outputs_and_failed_preparation_cannot_reuse() {
        let layers = [
            Layer {
                columns: vec![column(1, 0.2)],
            },
            Layer {
                columns: vec![column(3, 2.)],
            },
        ];
        let model = LayerModel::new(&layers, &[1.; 5]).unwrap();
        let amounts = [0.2, 0.8, 0.4, 1.2, 0.6];
        let direction = [0.1, -0.3, 0.2, 0.4, -0.1];
        let mut w = model.workspace();
        model.update(&amounts, &mut w).unwrap();
        let base = (
            w.input.transmission,
            w.input.loss,
            w.left_loss.clone(),
            w.right_loss.clone(),
            w.input.from_left.clone(),
            w.input.from_right.clone(),
        );
        let ptr = w.left.as_ptr();
        let mut unconsumed_changed = amounts;
        unconsumed_changed[0] = 100.;
        w.input.transmission.fill(f64::NAN);
        w.input.loss.fill(f64::NAN);
        w.left_loss.fill([f64::NAN; GROUPS]);
        w.right_loss.fill([f64::NAN; GROUPS]);
        w.input.from_left.fill([f64::NAN; GROUPS]);
        w.input.from_right.fill([f64::NAN; GROUPS]);
        model.update(&unconsumed_changed, &mut w).unwrap();
        assert_eq!(ptr, w.left.as_ptr());
        assert_eq!(
            base,
            (
                w.input.transmission,
                w.input.loss,
                w.left_loss.clone(),
                w.right_loss.clone(),
                w.input.from_left.clone(),
                w.input.from_right.clone()
            )
        );
        assert_direct(&model, &mut w, &direction);

        let mut changed = amounts;
        changed[1] = f64::from_bits(changed[1].to_bits() + 1);
        model.update(&changed, &mut w).unwrap();
        assert_eq!(w.amount_bits[0], changed[1].to_bits());
        let mut invalid = changed;
        invalid[1] = 0.5; // partial candidate changes before later overflow
        invalid[3] = f64::MAX;
        assert!(model.update(&invalid, &mut w).is_err());
        assert!(!w.valid);
        assert!(model.jvp(&direction, &mut w).is_err());
        model.update(&changed, &mut w).unwrap();
        let mut fresh = model.workspace();
        model.update(&changed, &mut fresh).unwrap();
        assert_eq!(w.input.transmission, fresh.input.transmission);
        assert_eq!(w.left_loss, fresh.left_loss);
        assert_eq!(w.right_loss, fresh.right_loss);
        assert_direct(&model, &mut w, &direction);
        model.jvp(&direction, &mut fresh).unwrap();
        assert_eq!(w.left_loss_jvp, fresh.left_loss_jvp);
        assert_eq!(w.right_loss_jvp, fresh.right_loss_jvp);
        let mut invalid_unconsumed = changed;
        invalid_unconsumed[0] = f64::NAN;
        assert!(model.update(&invalid_unconsumed, &mut w).is_err());
        assert!(!w.valid);
        model.update(&changed, &mut w).unwrap();
        w.depths.pop();
        assert!(model.update(&changed, &mut w).is_err());
        assert!(!w.valid);
    }

    fn column(target: usize, depth: f64) -> Column {
        Column {
            target,
            atoms_per_m2: depth,
            sigma_m2: std::array::from_fn(|g| if g == 0 { 0. } else { 1. + g as f64 / 7. }),
        }
    }

    #[test]
    fn emitted_local_partials_match_independent_directions_and_ordered_shared_targets() {
        let layers = [
            Layer {
                columns: vec![column(1, 0.2), column(3, 0.1)],
            },
            Layer {
                columns: vec![column(1, 0.3)],
            },
            Layer {
                columns: vec![column(4, 1e-20), column(1, 0.7)],
            },
        ];
        let model = LayerModel::new(&layers, &[1., 2., 1., 4., 1.]).unwrap();
        let direction = [0.9, -0.3, -0.2, 0.4, 0.7];
        for amounts in [[0.; 5], [0.1, 0.8, 0.2, 1.2, 0.6]] {
            let mut w = model.workspace();
            model.update(&amounts, &mut w).unwrap();
            let base = (
                w.input.transmission,
                w.left_loss.clone(),
                w.right_loss.clone(),
            );
            let mut partials = Vec::new();
            model
                .emit_partials(&mut w, |target, transmission, left, right| {
                    partials.push((target, *transmission, left.to_vec(), right.to_vec()));
                })
                .unwrap();
            assert_eq!(
                partials.iter().map(|p| p.0).collect::<Vec<_>>(),
                vec![1, 3, 4]
            );
            assert_eq!(
                (
                    w.input.transmission,
                    w.left_loss.clone(),
                    w.right_loss.clone()
                ),
                base
            );
            let mut total_transmission = [0.; GROUPS];
            let mut total_left = vec![[0.; GROUPS]; model.columns.len()];
            let mut total_right = total_left.clone();
            for (target, transmission, left, right) in partials {
                let mut unit = [0.; 5];
                unit[target] = 1.;
                model.jvp(&unit, &mut w).unwrap();
                assert_eq!(transmission, w.transmission_jvp);
                assert_eq!(left, w.left_loss_jvp);
                assert_eq!(right, w.right_loss_jvp);
                for g in 0..GROUPS {
                    let scale = transmission[g].abs().max(1e-30);
                    assert!(
                        (left.iter().map(|a| a[g]).sum::<f64>() + transmission[g]).abs()
                            < 2e-12 * scale
                    );
                    assert!(
                        (right.iter().map(|a| a[g]).sum::<f64>() + transmission[g]).abs()
                            < 2e-12 * scale
                    );
                    total_transmission[g] += transmission[g] * direction[target];
                    for j in 0..left.len() {
                        total_left[j][g] += left[j][g] * direction[target];
                        total_right[j][g] += right[j][g] * direction[target];
                    }
                }
            }
            model.jvp(&direction, &mut w).unwrap();
            for (a, b) in total_transmission
                .iter()
                .chain(total_left.iter().flatten())
                .chain(total_right.iter().flatten())
                .zip(
                    w.transmission_jvp
                        .iter()
                        .chain(w.left_loss_jvp.iter().flatten())
                        .chain(w.right_loss_jvp.iter().flatten()),
                )
            {
                assert!(
                    (a - b).abs() <= 2e-12 * a.abs().max(b.abs()).max(1e-30),
                    "{a:e} versus {b:e}"
                );
            }
        }
    }

    #[test]
    fn local_partials_require_the_actual_valid_model_stage() {
        let layers = [Layer {
            columns: vec![column(1, 0.2)],
        }];
        let model = LayerModel::new(&layers, &[1.; 3]).unwrap();
        let other = LayerModel::new(&layers, &[1.; 3]).unwrap();
        let mut w = model.workspace();
        let mut calls = 0;
        assert!(
            model
                .emit_partials(&mut w, |_, _, _, _| calls += 1)
                .is_err()
        );
        model.update(&[1.; 3], &mut w).unwrap();
        assert!(
            other
                .emit_partials(&mut w, |_, _, _, _| calls += 1)
                .is_err()
        );
        assert!(model.update(&[1., -1., 1.], &mut w).is_err());
        assert!(
            model
                .emit_partials(&mut w, |_, _, _, _| calls += 1)
                .is_err()
        );
        assert_eq!(calls, 0);
        model.update(&[1.; 3], &mut w).unwrap();
        model
            .emit_partials(&mut w, |target, _, _, _| {
                assert_eq!(target, 1);
                calls += 1;
            })
            .unwrap();
        assert_eq!(calls, 1);
    }
}

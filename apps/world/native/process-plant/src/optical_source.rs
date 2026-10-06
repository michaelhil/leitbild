//! Actual ordered, no-scattering planar absorber layers. This is the rack/gate
//! law, NOT the bulk head, cylindrical body or converter-film law.
//! NIST DLMF 8.19.8/12/13/17 supplies E_n series, recurrence and derivatives.
use crate::transport_source::{OpticalInput, GROUPS};
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
    }
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
            }
            ends.push(columns.len());
        }
        Ok(Self {
            columns,
            ends,
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
            owner: self.owner.clone(),
            valid: false,
        }
    }
    pub fn update(&self, amounts: &[f64], w: &mut LayerWorkspace) -> Result<(), &'static str> {
        w.valid = false;
        self.check_workspace(w)?;
        if amounts.len() != self.target_count || amounts.iter().any(|v| !v.is_finite() || *v < 0.) {
            return Err("Invalid advancing optical target amounts");
        }
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
            w.input.transmission[g] = a.transmission;
            w.input.loss[g] = a.loss;
            let mut before = 0.;
            let mut start = 0;
            for (l, &end) in self.ends.iter().enumerate() {
                let depth = w.sums[l][g];
                let after = w.sums[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                let left = layer_loss(before, depth)?;
                let right = layer_loss(after, depth)?;
                for j in start..end {
                    let fraction = if depth > 0. {
                        w.depths[j][g] / depth
                    } else {
                        0.
                    };
                    w.left_loss[j][g] = left * fraction;
                    w.right_loss[j][g] = right * fraction;
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
                before += depth;
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
        self.check_workspace(w)?;
        if !w.valid
            || amount_direction.len() != self.target_count
            || amount_direction.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid optical amount direction");
        }
        w.sum_direction.fill([0.; GROUPS]);
        let mut start = 0;
        for (l, &end) in self.ends.iter().enumerate() {
            for j in start..end {
                for g in 0..GROUPS {
                    w.direction[j][g] = self.columns[j].1[g] * amount_direction[self.columns[j].0];
                    w.sum_direction[l][g] += w.direction[j][g];
                }
            }
            start = end;
        }
        for g in 0..GROUPS {
            let total = w.sums.iter().map(|s| s[g]).sum::<f64>();
            let dtotal = w.sum_direction.iter().map(|s| s[g]).sum::<f64>();
            w.transmission_jvp[g] = attenuation(total)?.derivative * dtotal;
            let mut before = 0.;
            let mut db = 0.;
            let mut start = 0;
            for (l, &end) in self.ends.iter().enumerate() {
                let depth = w.sums[l][g];
                let dd = w.sum_direction[l][g];
                let after = w.sums[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                let da = w.sum_direction[l + 1..].iter().map(|s| s[g]).sum::<f64>();
                let left = layer_loss(before, depth)?;
                let right = layer_loss(after, depth)?;
                let dl = layer_loss_jvp(before, depth, db, dd)?;
                let dr = layer_loss_jvp(after, depth, da, dd)?;
                for j in start..end {
                    let part = w.depths[j][g];
                    let dp = w.direction[j][g];
                    if depth == 0. {
                        w.left_loss_jvp[j][g] = -attenuation(before)?.derivative * dp;
                        w.right_loss_jvp[j][g] = -attenuation(after)?.derivative * dp;
                    } else {
                        let fraction = part / depth;
                        let df = (dp - fraction * dd) / depth;
                        w.left_loss_jvp[j][g] = dl * fraction + left * df;
                        w.right_loss_jvp[j][g] = dr * fraction + right * df;
                    }
                }
                before += depth;
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
            ]
            .iter()
            .any(|&l| l != n)
        {
            return Err("Wrong advancing optical workspace");
        }
        Ok(())
    }
}

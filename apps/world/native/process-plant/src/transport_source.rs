//! Seven-group face transport contribution, not a complete reactor source.
//! Caller supplies same-trial collision sums and physical optical transmission/
//! ordered capture allocations. No opacity library, material update or heat sink.
use std::sync::Arc;
pub const GROUPS: usize = 7;

#[derive(Clone, Debug)]
pub enum FaceLaw {
    Transparent,
    Optical {
        targets: Vec<usize>,
    },
    /// One physical panel wholly inside an isotropic region. It removes
    /// neutrons from both incident sides; it is not a self-face or bulk collider.
    InternalOptical {
        targets: Vec<usize>,
    },
    Escape,
}
#[derive(Clone, Debug)]
pub struct Face {
    pub left: usize,
    pub right: Option<usize>,
    pub area: f64,
    pub left_distance: f64,
    pub right_distance: Option<f64>,
    pub law: FaceLaw,
}
#[derive(Clone, Debug)]
pub struct OpticalInput {
    pub transmission: [f64; GROUPS],
    /// Independently evaluated 1-T: a dilute nonzero capture must survive even
    /// when its rounded transmission is exactly one.
    pub loss: [f64; GROUPS],
    pub from_left: Vec<[f64; GROUPS]>,
    pub from_right: Vec<[f64; GROUPS]>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Scalar {
    pub value: f64,
    /// Local partials w.r.t. left collision, right collision, transmission.
    /// Collision cap ties use its inactive one-sided derivative (not smooth).
    pub derivatives: [f64; 3],
}
#[derive(Clone, Copy, Debug, Default)]
pub struct FaceCoefficients {
    pub exchange: Scalar,
    pub capture_left: Scalar,
    pub capture_right: Scalar,
    pub escape: Scalar,
    /// Smooth capture/loss factor, including the transparent endpoint. This
    /// permits target-probability derivatives without differentiating 0/0
    /// normalized allocation fractions at an exhausted optical layer.
    pub capture_per_loss_left: Scalar,
    pub capture_per_loss_right: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct Coordinate {
    pub row: usize,
    pub column: usize,
}
pub struct Workspace {
    face_coefficients: Vec<[FaceCoefficients; GROUPS]>,
    coefficients: Vec<f64>,
    allocations: Vec<OpticalInput>,
    owner: Arc<()>,
    valid: bool,
}
impl Workspace {
    /// Known Vec element payload only, excludes allocator and solver overhead.
    pub fn buffer_bytes(&self) -> usize {
        self.face_coefficients.len() * std::mem::size_of::<[FaceCoefficients; GROUPS]>()
            + self.coefficients.len() * std::mem::size_of::<f64>()
            + self.allocations.len() * std::mem::size_of::<OpticalInput>()
            + self
                .allocations
                .iter()
                .map(|x| {
                    (x.from_left.len() + x.from_right.len()) * std::mem::size_of::<[f64; GROUPS]>()
                })
                .sum::<usize>()
    }
    pub fn face_coefficients(&self) -> Result<&[[FaceCoefficients; GROUPS]], &'static str> {
        if !self.valid {
            return Err("Unprepared transport workspace");
        }
        Ok(&self.face_coefficients)
    }
    pub fn coefficients(&self) -> Result<&[f64], &'static str> {
        if !self.valid {
            return Err("Unprepared transport workspace");
        }
        Ok(&self.coefficients)
    }
}
pub struct Model {
    volumes: Vec<f64>,
    envelope_lengths: Vec<f64>,
    speed: [f64; GROUPS],
    faces: Vec<Face>,
    target_count: usize,
    coordinates: Vec<Coordinate>,
    owner: Arc<()>,
}
fn positive(x: f64) -> bool {
    x.is_finite() && x > 0.
}
fn nonnegative(x: f64) -> bool {
    x.is_finite() && x >= 0.
}
fn quotient(num: f64, dn: [f64; 3], det: f64, dd: [f64; 3]) -> Scalar {
    let value = num / det;
    Scalar {
        value,
        derivatives: std::array::from_fn(|j| (dn[j] - value * dd[j]) / det),
    }
}
fn optical(area: f64, rl: f64, rr: f64, dl: f64, dr: f64, t: f64, loss: f64) -> FaceCoefficients {
    let xl = rl / 4.;
    let xr = rr / 4.;
    let one = loss * (2. - loss);
    // Nonnegative determinant form avoids subtracting near-equal thick terms.
    let det = 0.25 * one + 0.5 * (xl + xr) * (1. + t * t) + xl * xr * one;
    let dd = [
        0.25 * (0.5 * (1. + t * t) + xr * one) * dl,
        0.25 * (0.5 * (1. + t * t) + xl * one) * dr,
        2. * t * (-0.25 + 0.5 * (xl + xr) - xl * xr),
    ];
    let a = area / 4.;
    let nl = 0.5 * loss * loss + xr * one;
    let nr = 0.5 * loss * loss + xl * one;
    FaceCoefficients {
        exchange: quotient(a * t, [0., 0., a], det, dd),
        capture_left: quotient(
            a * nl,
            [0., a * 0.25 * one * dr, a * (-loss - 2. * xr * t)],
            det,
            dd,
        ),
        capture_right: quotient(
            a * nr,
            [a * 0.25 * one * dl, 0., a * (-loss - 2. * xl * t)],
            det,
            dd,
        ),
        escape: Scalar::default(),
        capture_per_loss_left: quotient(
            a * (0.5 * loss + xr * (2. - loss)),
            [0., a * 0.25 * (2. - loss) * dr, a * (-0.5 + xr)],
            det,
            dd,
        ),
        capture_per_loss_right: quotient(
            a * (0.5 * loss + xl * (2. - loss)),
            [a * 0.25 * (2. - loss) * dl, 0., a * (-0.5 + xl)],
            det,
            dd,
        ),
    }
}
fn internal_optical(area: f64, loss: f64) -> FaceCoefficients {
    let side = area / 4.;
    let capture = Scalar {
        value: side * loss,
        derivatives: [0., 0., -side],
    };
    let per_loss = Scalar {
        value: side,
        derivatives: [0.; 3],
    };
    FaceCoefficients {
        capture_left: capture,
        capture_right: capture,
        capture_per_loss_left: per_loss,
        capture_per_loss_right: per_loss,
        ..FaceCoefficients::default()
    }
}
impl Model {
    pub fn new(
        volumes: Vec<f64>,
        envelope_lengths: Vec<f64>,
        speed: [f64; GROUPS],
        faces: Vec<Face>,
        target_count: usize,
    ) -> Result<Self, &'static str> {
        if volumes.is_empty()
            || volumes.len() != envelope_lengths.len()
            || volumes.len().checked_mul(GROUPS).is_none()
            || volumes
                .iter()
                .chain(&envelope_lengths)
                .chain(&speed)
                .any(|v| !positive(*v))
            || envelope_lengths.iter().any(|v| !positive(1. / v))
        {
            return Err("Invalid transport volume/envelope/speed");
        }
        let mut coordinates = Vec::new();
        for f in &faces {
            if f.left >= volumes.len() || !positive(f.area) {
                return Err("Invalid transport face geometry");
            }
            match (&f.law, f.right, f.right_distance) {
                (FaceLaw::InternalOptical { .. }, None, None) if f.left_distance == 0. => {}
                (FaceLaw::Escape, None, None) if positive(f.left_distance) => {}
                (FaceLaw::Transparent | FaceLaw::Optical { .. }, Some(r), Some(d))
                    if r < volumes.len()
                        && r != f.left
                        && positive(d)
                        && positive(f.left_distance) => {}
                _ => return Err("Inconsistent shared/escape face"),
            }
            if let FaceLaw::Optical { targets } | FaceLaw::InternalOptical { targets } = &f.law {
                if targets.is_empty() || targets.iter().any(|t| *t >= target_count) {
                    return Err("Unowned optical capture layers");
                }
            }
            for g in 0..GROUPS {
                let l = f.left * GROUPS + g;
                coordinates.push(Coordinate { row: l, column: l });
                if let Some(r) = f.right {
                    let r = r * GROUPS + g;
                    coordinates.extend([
                        Coordinate { row: l, column: r },
                        Coordinate { row: r, column: l },
                        Coordinate { row: r, column: r },
                    ]);
                }
            }
        }
        Ok(Self {
            volumes,
            envelope_lengths,
            speed,
            faces,
            target_count,
            coordinates,
            owner: Arc::new(()),
        })
    }
    pub fn coordinates(&self) -> &[Coordinate] {
        &self.coordinates
    }
    pub fn faces(&self) -> &[Face] {
        &self.faces
    }
    pub fn coordinate_count(&self) -> usize {
        self.volumes.len() * GROUPS
    }
    pub fn validate_accepted_state(&self, n: &[f64]) -> Result<(), &'static str> {
        if n.len() != self.coordinate_count() || n.iter().any(|v| !nonnegative(*v)) {
            return Err("Invalid accepted transport neutron amounts");
        }
        Ok(())
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            face_coefficients: vec![[FaceCoefficients::default(); GROUPS]; self.faces.len()],
            coefficients: vec![0.; self.coordinates.len()],
            allocations: self
                .faces
                .iter()
                .filter_map(|f| match &f.law {
                    FaceLaw::Optical { targets } | FaceLaw::InternalOptical { targets } => {
                        Some(OpticalInput {
                            transmission: [0.; GROUPS],
                            loss: [0.; GROUPS],
                            from_left: vec![[0.; GROUPS]; targets.len()],
                            from_right: vec![[0.; GROUPS]; targets.len()],
                        })
                    }
                    _ => None,
                })
                .collect(),
            owner: Arc::clone(&self.owner),
            valid: false,
        }
    }
    /// No workspace/coefficients from a failed update may be consumed.
    /// Fractions describe ordered physical layer receipts, not a default sink.
    pub fn update(
        &self,
        collision: &[[f64; GROUPS]],
        optical_inputs: &[OpticalInput],
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        work.valid = false;
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || collision.len() != self.volumes.len()
            || collision.iter().flatten().any(|v| !nonnegative(*v))
            || optical_inputs.len() != work.allocations.len()
        {
            return Err("Invalid transport collision/optical workspace");
        }
        let mut oi = 0;
        let mut ci = 0;
        for (fi, f) in self.faces.iter().enumerate() {
            if let FaceLaw::Optical { targets } | FaceLaw::InternalOptical { targets } = &f.law {
                let input = &optical_inputs[oi];
                if input.from_left.len() != targets.len()
                    || input.from_right.len() != targets.len()
                    || input
                        .transmission
                        .iter()
                        .chain(input.loss.iter())
                        .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
                    || input
                        .from_left
                        .iter()
                        .chain(&input.from_right)
                        .flatten()
                        .any(|v| !nonnegative(*v))
                {
                    return Err("Incomplete optical layer allocation");
                }
                for g in 0..GROUPS {
                    if (input.transmission[g] + input.loss[g] - 1.).abs() > 8. * f64::EPSILON {
                        return Err("Inconsistent optical transmission/loss");
                    }
                    for side in [&input.from_left, &input.from_right] {
                        let sum = side.iter().map(|x| x[g]).sum::<f64>();
                        if (input.loss[g] == 0. && sum != 0.)
                            || (input.loss[g] > 0.
                                && (!sum.is_finite() || (sum - 1.).abs() > 64. * f64::EPSILON))
                        {
                            return Err("Optical capture allocation does not close");
                        }
                    }
                }
                work.allocations[oi].transmission = input.transmission;
                work.allocations[oi].loss = input.loss;
                work.allocations[oi]
                    .from_left
                    .copy_from_slice(&input.from_left);
                work.allocations[oi]
                    .from_right
                    .copy_from_slice(&input.from_right);
            }
            for g in 0..GROUPS {
                if matches!(f.law, FaceLaw::InternalOptical { .. }) {
                    let c = internal_optical(f.area, optical_inputs[oi].loss[g]);
                    work.face_coefficients[fi][g] = c;
                    work.coefficients[ci] = -(c.capture_left.value + c.capture_right.value)
                        * self.speed[g]
                        / self.volumes[f.left];
                    ci += 1;
                    continue;
                }
                let cl = collision[f.left][g];
                let cap = 1. / self.envelope_lengths[f.left];
                let rl = 3. * f.left_distance * cl.max(cap);
                let dl = if cl > cap { 3. * f.left_distance } else { 0. };
                if !positive(rl) || !dl.is_finite() {
                    return Err("Unrepresentable left resistance");
                }
                let c = if let Some(r) = f.right {
                    let cr = collision[r][g];
                    let cap = 1. / self.envelope_lengths[r];
                    let rr = 3. * f.right_distance.unwrap() * cr.max(cap);
                    let dr = if cr > cap {
                        3. * f.right_distance.unwrap()
                    } else {
                        0.
                    };
                    if !positive(rr) || !dr.is_finite() || !(rl + rr).is_finite() {
                        return Err("Unrepresentable shared resistance");
                    }
                    match &f.law {
                        FaceLaw::Transparent => FaceCoefficients {
                            exchange: quotient(f.area, [0.; 3], rl + rr, [dl, dr, 0.]),
                            ..FaceCoefficients::default()
                        },
                        FaceLaw::Optical { .. } => optical(
                            f.area,
                            rl,
                            rr,
                            dl,
                            dr,
                            optical_inputs[oi].transmission[g],
                            optical_inputs[oi].loss[g],
                        ),
                        FaceLaw::Escape | FaceLaw::InternalOptical { .. } => unreachable!(),
                    }
                } else {
                    FaceCoefficients {
                        escape: quotient(f.area, [0.; 3], 2. + rl, [dl, 0., 0.]),
                        ..FaceCoefficients::default()
                    }
                };
                if [c.exchange, c.capture_left, c.capture_right, c.escape]
                    .iter()
                    .any(|x| !nonnegative(x.value) || x.derivatives.iter().any(|v| !v.is_finite()))
                {
                    return Err("Unrepresentable transport face candidate");
                }
                work.face_coefficients[fi][g] = c;
                let vl = self.speed[g] / self.volumes[f.left];
                work.coefficients[ci] =
                    -(c.exchange.value + c.capture_left.value + c.escape.value) * vl;
                ci += 1;
                if let Some(r) = f.right {
                    let vr = self.speed[g] / self.volumes[r];
                    work.coefficients[ci] = c.exchange.value * vr;
                    work.coefficients[ci + 1] = c.exchange.value * vl;
                    work.coefficients[ci + 2] = -(c.exchange.value + c.capture_right.value) * vr;
                    ci += 3;
                }
            }
            if matches!(
                f.law,
                FaceLaw::Optical { .. } | FaceLaw::InternalOptical { .. }
            ) {
                oi += 1;
            }
        }
        if work.coefficients.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite transport amount matrix");
        }
        work.valid = true;
        Ok(())
    }
    /// Additive source contribution only. Signed finite trial N is not history.
    /// On error all caller outputs are rejected, including any partial receipts.
    pub fn apply(
        &self,
        work: &Workspace,
        n: &[f64],
        rate: &mut [f64],
        capture: &mut [[f64; GROUPS]],
        escape: &mut [f64; GROUPS],
    ) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || !work.valid
            || n.len() != self.coordinate_count()
            || rate.len() != n.len()
            || capture.len() != self.target_count
            || n.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid transport trial/output workspace");
        }
        rate.fill(0.);
        capture.fill([0.; GROUPS]);
        escape.fill(0.);
        let mut oi = 0;
        for (f, cs) in self.faces.iter().zip(&work.face_coefficients) {
            for g in 0..GROUPS {
                let l = f.left * GROUPS + g;
                let pl = self.speed[g] * n[l] / self.volumes[f.left];
                let c = cs[g];
                if let FaceLaw::InternalOptical { targets } = &f.law {
                    rate[l] -= (c.capture_left.value + c.capture_right.value) * pl;
                    for (j, target) in targets.iter().enumerate() {
                        capture[*target][g] += pl
                            * (c.capture_left.value * work.allocations[oi].from_left[j][g]
                                + c.capture_right.value * work.allocations[oi].from_right[j][g]);
                    }
                } else if let Some(r) = f.right {
                    let r = r * GROUPS + g;
                    let pr = self.speed[g] * n[r] / self.volumes[r / GROUPS];
                    let transfer = c.exchange.value * (pr - pl);
                    rate[l] += transfer - c.capture_left.value * pl;
                    rate[r] -= transfer + c.capture_right.value * pr;
                    if let FaceLaw::Optical { targets } = &f.law {
                        for (j, target) in targets.iter().enumerate() {
                            capture[*target][g] +=
                                c.capture_left.value * pl * work.allocations[oi].from_left[j][g]
                                    + c.capture_right.value
                                        * pr
                                        * work.allocations[oi].from_right[j][g];
                        }
                    }
                } else {
                    let loss = c.escape.value * pl;
                    rate[l] -= loss;
                    escape[g] += loss;
                }
            }
            if matches!(
                f.law,
                FaceLaw::Optical { .. } | FaceLaw::InternalOptical { .. }
            ) {
                oi += 1;
            }
        }
        if rate
            .iter()
            .chain(capture.iter().flatten())
            .chain(escape.iter())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite transport trial receipts");
        }
        Ok(())
    }
}

//! Selected isotropic lateral-chord capture, with no opaque cylinder end faces.
//! Homogeneous B10 bodies use the inherited volume-incidence projection. The
//! annular converter additionally integrates its selected outer-depth escape
//! probability; collected expectation is not an acquired instrument signal.
use std::{collections::HashSet, f64::consts::PI, sync::Arc};
pub const GROUPS: usize = 7;
const ORDER: usize = 48;
const SHELL_ORDER: usize = 24;

#[derive(Clone, Debug)]
pub struct Target {
    pub index: usize,
    pub inner_radius: f64,
    pub outer_radius: f64,
    pub length: f64,
    pub multiplicity: usize,
    pub sigma_m2: [f64; GROUPS],
    /// Zero for an ordinary body; positive for the converter escape reduction.
    pub escape_depth: f64,
    pub collection: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Intersection {
    pub target: usize,
    pub region: usize,
    pub share: f64,
}
#[derive(Clone, Copy, Default, Debug)]
pub struct Response {
    pub capture_m2: [f64; GROUPS],
    pub d_capture_d_amount: [f64; GROUPS],
    pub energy_escape_m2: [f64; GROUPS],
    pub d_energy_escape_d_amount: [f64; GROUPS],
    pub collected_m2: [f64; GROUPS],
    pub d_collected_d_amount: [f64; GROUPS],
}
#[derive(Clone, Copy)]
struct Ray {
    weight: f64,
    path: f64,
}
#[derive(Clone, Copy)]
struct EscapePoint {
    weight: f64,
    path: f64,
}
struct Prepared {
    target: Target,
    volume: f64,
    lateral_area: f64,
    rays: Vec<Ray>,
    escape: Vec<EscapePoint>,
}
pub struct Model {
    volumes: Vec<f64>,
    speed: [f64; GROUPS],
    targets: Vec<Prepared>,
    intersections: Vec<Intersection>,
    target_count: usize,
    owner: Arc<()>,
}
pub struct Workspace {
    shares: Vec<f64>,
    share_sums: Vec<f64>,
    responses: Vec<Response>,
    collision: Vec<[f64; GROUPS]>,
    // Response AND its amount derivatives depend only on this target amount;
    // geometry, cross sections and collection are immutable model-owned data.
    amount_bits: Vec<u64>,
    owner: Arc<()>,
    valid: bool,
}
impl Workspace {
    pub fn responses(&self) -> Result<&[Response], &'static str> {
        if !self.valid {
            return Err("Unprepared cylinder workspace");
        }
        Ok(&self.responses)
    }
    pub fn collision(&self) -> Result<&[[f64; GROUPS]], &'static str> {
        if !self.valid {
            return Err("Unprepared cylinder workspace");
        }
        Ok(&self.collision)
    }
    pub fn buffer_bytes(&self) -> usize {
        self.responses.len() * std::mem::size_of::<Response>()
            + self.collision.len() * std::mem::size_of::<[f64; GROUPS]>()
            + self.amount_bits.len() * std::mem::size_of::<u64>()
            + (self.shares.len() + self.share_sums.len()) * 8
    }
}

// A private, fixed integration rule, not an adaptive response/solver framework.
fn gauss(n: usize, lo: f64, hi: f64) -> Result<Vec<(f64, f64)>, &'static str> {
    let mut rows = Vec::with_capacity(n);
    for i in 0..n.div_ceil(2) {
        let mut x = (PI * (i as f64 + 0.75) / (n as f64 + 0.5)).cos();
        let mut converged = false;
        for _ in 0..32 {
            let (mut a, mut b) = (1., 0.);
            for j in 1..=n {
                let c = b;
                b = a;
                a = ((2 * j - 1) as f64 * x * b - (j - 1) as f64 * c) / j as f64;
            }
            let derivative = n as f64 * (x * a - b) / (x * x - 1.);
            let next = x - a / derivative;
            if !next.is_finite() || !derivative.is_finite() {
                return Err("Nonfinite fixed cylinder quadrature");
            }
            if (next - x).abs() <= 4. * f64::EPSILON {
                x = next;
                converged = true;
                break;
            }
            x = next;
        }
        if !converged {
            return Err("Fixed cylinder quadrature did not converge");
        }
        // Recompute the derivative at the final node.
        let (mut a, mut b) = (1., 0.);
        for j in 1..=n {
            let c = b;
            b = a;
            a = ((2 * j - 1) as f64 * x * b - (j - 1) as f64 * c) / j as f64;
        }
        let derivative = n as f64 * (x * a - b) / (x * x - 1.);
        let weight = (hi - lo) / ((1. - x * x) * derivative * derivative);
        let mid = (lo + hi) / 2.;
        let half = (hi - lo) / 2.;
        rows.push((mid - half * x, weight));
        if rows.len() < n {
            rows.push((mid + half * x, weight));
        }
    }
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(rows)
}
fn prepare(target: Target) -> Result<Prepared, &'static str> {
    let t = &target;
    let ri = t.inner_radius;
    let ro = t.outer_radius;
    if ![ri, ro, t.length, t.escape_depth, t.collection]
        .iter()
        .all(|v| v.is_finite())
        || ri < 0.
        || ro <= ri
        || t.length <= 0.
        || t.multiplicity == 0
        || t.escape_depth < 0.
        || t.escape_depth > ro - ri
        || !(0. ..=1.).contains(&t.collection)
        || (t.escape_depth == 0. && t.collection != 0.)
        || t.sigma_m2.iter().any(|v| !v.is_finite() || *v < 0.)
    {
        return Err("Invalid physical cylinder/annular target");
    }
    let volume = PI * (ro - ri) * (ro + ri) * t.length * t.multiplicity as f64;
    let lateral_area = 2. * PI * ro * t.length * t.multiplicity as f64;
    if !volume.is_finite() || volume <= 0. || !lateral_area.is_finite() {
        return Err("Unrepresentable cylinder geometry");
    }
    let theta = gauss(ORDER, 0., PI / 2.)?;
    let shell = if t.escape_depth > 0. {
        ro - t.escape_depth
    } else {
        ro
    };
    // Remove the inner-circle and outer-tangent square-root endpoints. A
    // direct beta split leaves a resolvable thin-limit quadrature defect.
    let mut impact_rule = Vec::new();
    if ri > 0. {
        for (angle, w) in gauss(ORDER, 0., PI / 2.)? {
            impact_rule.push((ri * angle.cos(), w * ri * angle.sin()));
        }
    }
    let delta = (ro - ri) * (ro + ri);
    let mut cuts = vec![0., PI / 2.];
    if t.escape_depth > 0. && shell > ri {
        cuts.push((((shell - ri) * (shell + ri) / delta).sqrt()).asin());
    }
    cuts.sort_by(f64::total_cmp);
    cuts.dedup();
    for bounds in cuts.windows(2) {
        for (angle, w) in gauss(ORDER, bounds[0], bounds[1])? {
            let impact = (ri * ri + delta * angle.sin().powi(2)).sqrt();
            impact_rule.push((impact, w * delta * angle.sin() * angle.cos() / impact));
        }
    }
    let depth_rule = if t.escape_depth > 0. {
        gauss(SHELL_ORDER, -1., 1.)?
    } else {
        Vec::new()
    };
    let mut rays = Vec::with_capacity(theta.len() * impact_rule.len());
    let mut escape = Vec::new();
    for &(angle, wa) in &theta {
        let sine = angle.sin();
        for &(impact, wb) in &impact_rule {
            let outer = ((ro - impact) * (ro + impact)).sqrt();
            let inner = if impact < ri {
                ((ri - impact) * (ri + impact)).sqrt()
            } else {
                0.
            };
            let half_material = if impact < ri {
                (ro - ri) * (ro + ri) / (outer + inner)
            } else {
                outer
            };
            let path = 2. * half_material / sine;
            // Four angular symmetries: A/(pi*R) * integral sin²(theta) db.
            let weight = lateral_area / (PI * ro) * wa * wb * sine * sine;
            rays.push(Ray { weight, path });
            if t.escape_depth == 0. {
                continue;
            }
            let lower = if impact < shell {
                ((shell - impact) * (shell + impact)).sqrt()
            } else {
                0.
            };
            let width = if impact < shell {
                (ro - shell) * (ro + shell) / (outer + lower)
            } else {
                outer
            };
            for &(node, w) in &depth_rule {
                let x = lower + width * (node + 1.) / 2.;
                let radius = impact.hypot(x);
                let depth = (ro * ro - impact * impact - x * x) / (ro + radius);
                let probability = 0.5 * (1. - depth / t.escape_depth);
                let ew = weight * w * width / 2. * probability / sine;
                let entering = (outer - x) / sine;
                let exiting = (outer - 2. * inner + x) / sine;
                if !ew.is_finite() || ew < 0. || probability > 0.5 || entering < 0. || exiting < 0.
                {
                    return Err("Invalid finite annular escape geometry");
                }
                escape.push(EscapePoint {
                    weight: ew,
                    path: entering,
                });
                escape.push(EscapePoint {
                    weight: ew,
                    path: exiting,
                });
            }
        }
    }
    Ok(Prepared {
        target,
        volume,
        lateral_area,
        rays,
        escape,
    })
}
impl Model {
    pub fn new(
        volumes: Vec<f64>,
        speed: [f64; GROUPS],
        targets: Vec<Target>,
        intersections: Vec<Intersection>,
        target_count: usize,
    ) -> Result<Self, &'static str> {
        if volumes.is_empty()
            || volumes
                .iter()
                .chain(&speed)
                .any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("Invalid cylinder source domain");
        }
        let mut ids = HashSet::new();
        if targets.is_empty()
            || targets
                .iter()
                .any(|t| t.index >= target_count || !ids.insert(t.index))
        {
            return Err("Unowned/duplicated cylinder target");
        }
        let prepared = targets
            .into_iter()
            .map(prepare)
            .collect::<Result<Vec<_>, _>>()?;
        let mut sums = vec![0.; prepared.len()];
        let mut seen = HashSet::new();
        for e in &intersections {
            if e.target >= prepared.len()
                || e.region >= volumes.len()
                || !e.share.is_finite()
                || e.share < 0.
                || !seen.insert((e.target, e.region))
            {
                return Err("Invalid cylinder source incidence");
            }
            sums[e.target] += e.share;
        }
        if sums
            .iter()
            .any(|s| !s.is_finite() || (*s - 1.).abs() > 3e-11)
        {
            return Err("Cylinder incidence does not cover actual target");
        }
        Ok(Self {
            volumes,
            speed,
            targets: prepared,
            intersections,
            target_count,
            owner: Arc::new(()),
        })
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            shares: self.intersections.iter().map(|e| e.share).collect(),
            share_sums: vec![0.; self.targets.len()],
            responses: vec![Response::default(); self.targets.len()],
            collision: vec![[0.; GROUPS]; self.volumes.len()],
            amount_bits: vec![0; self.targets.len()],
            owner: self.owner.clone(),
            valid: false,
        }
    }
    pub fn geometry_payload_bytes(&self) -> usize {
        self.targets
            .iter()
            .map(|t| {
                t.rays.len() * std::mem::size_of::<Ray>()
                    + t.escape.len() * std::mem::size_of::<EscapePoint>()
            })
            .sum()
    }
    pub fn update(&self, amounts: &[f64], work: &mut Workspace) -> Result<(), &'static str> {
        self.update_geometry(amounts, None, work)
    }
    pub fn update_with_shares(
        &self,
        amounts: &[f64],
        shares: &[f64],
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.update_geometry(amounts, Some(shares), work)
    }
    fn update_geometry(
        &self,
        amounts: &[f64],
        shares: Option<&[f64]>,
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        let reuse = work.valid;
        work.valid = false;
        if !Arc::ptr_eq(&work.owner, &self.owner)
            || amounts.len() != self.target_count
            || amounts.iter().any(|v| !v.is_finite() || *v < 0.)
            || shares.is_some_and(|v| {
                v.len() != self.intersections.len() || v.iter().any(|x| !x.is_finite() || *x < 0.)
            })
        {
            return Err("Invalid actual cylinder target/workspace");
        }
        work.share_sums.fill(0.);
        let mut same_geometry = true;
        for (i, e) in self.intersections.iter().enumerate() {
            let value = shares.map_or(e.share, |v| v[i]);
            same_geometry &= value.to_bits() == work.shares[i].to_bits();
            work.shares[i] = value;
            work.share_sums[e.target] += value;
        }
        if work
            .share_sums
            .iter()
            .any(|s| !s.is_finite() || (*s - 1.).abs() > 3e-11)
        {
            return Err("Current cylinder incidence does not cover target");
        }
        // Never reuse through a failed update. Exact bits, not an amount
        // tolerance, control reuse; unrelated valid targets cannot affect us.
        if reuse
            && same_geometry
            && self
                .targets
                .iter()
                .zip(&work.amount_bits)
                .all(|(p, bits)| amounts[p.target.index].to_bits() == *bits)
        {
            work.valid = true;
            return Ok(());
        }
        work.collision.fill([0.; GROUPS]);
        for (j, (p, r)) in self.targets.iter().zip(&mut work.responses).enumerate() {
            let amount = amounts[p.target.index];
            if reuse && amount.to_bits() == work.amount_bits[j] {
                continue;
            }
            *r = Response::default();
            for g in 0..GROUPS {
                // An exactly zero microscopic cross section has identically
                // zero response and derivative at every amount. Do not confuse
                // it with zero amount at positive sigma (nonzero derivative).
                if p.target.sigma_m2[g] == 0. {
                    r.d_capture_d_amount[g] = p.target.sigma_m2[g];
                    continue;
                }
                let slope = p.target.sigma_m2[g] / p.volume;
                let sigma = amount * slope;
                if !slope.is_finite() || !sigma.is_finite() {
                    return Err("Nonfinite cylindrical opacity");
                }
                if sigma == 0. {
                    r.d_capture_d_amount[g] = p.target.sigma_m2[g];
                } else {
                    for ray in &p.rays {
                        let attenuation = (-sigma * ray.path).exp();
                        r.capture_m2[g] += ray.weight * (-(-sigma * ray.path).exp_m1());
                        r.d_capture_d_amount[g] += ray.weight * ray.path * attenuation * slope;
                    }
                }
                for point in &p.escape {
                    let x = sigma * point.path;
                    let attenuation = (-x).exp();
                    r.energy_escape_m2[g] += point.weight * sigma * attenuation;
                    // An opaque limiting sample may have x=inf; its derivative is zero.
                    if x.is_finite() {
                        r.d_energy_escape_d_amount[g] +=
                            point.weight * (1. - x) * attenuation * slope;
                    }
                }
                r.collected_m2[g] = p.target.collection * r.energy_escape_m2[g];
                r.d_collected_d_amount[g] = p.target.collection * r.d_energy_escape_d_amount[g];
                if ![
                    r.capture_m2[g],
                    r.d_capture_d_amount[g],
                    r.energy_escape_m2[g],
                    r.d_energy_escape_d_amount[g],
                    r.collected_m2[g],
                    r.d_collected_d_amount[g],
                ]
                .iter()
                .all(|v| v.is_finite())
                    || r.capture_m2[g] < 0.
                    || r.capture_m2[g] > p.lateral_area / 4. * (1. + 3e-11)
                    || r.energy_escape_m2[g] < 0.
                    || r.energy_escape_m2[g] > r.capture_m2[g] * (1. + 3e-10)
                {
                    return Err("Cylinder response lost finite capture/escape bounds");
                }
            }
            work.amount_bits[j] = amount.to_bits();
        }
        for (e, &share) in self.intersections.iter().zip(&work.shares) {
            for g in 0..GROUPS {
                work.collision[e.region][g] +=
                    work.responses[e.target].capture_m2[g] * share / self.volumes[e.region];
            }
        }
        if work.collision.iter().flatten().any(|v| !v.is_finite()) {
            return Err("Nonfinite cylinder collision candidate");
        }
        work.valid = true;
        Ok(())
    }
    /// Replaces this contribution's outputs. Finite signed N trials are allowed;
    /// current material amounts remain physical and caller owns accepted commits.
    pub fn apply(
        &self,
        work: &Workspace,
        n: &[f64],
        rates: &mut [f64],
        captures: &mut [[f64; GROUPS]],
        collected: &mut [[f64; GROUPS]],
        energy_escape: &mut [[f64; GROUPS]],
    ) -> Result<(), &'static str> {
        if !work.valid
            || !Arc::ptr_eq(&work.owner, &self.owner)
            || n.len() != self.volumes.len() * GROUPS
            || rates.len() != n.len()
            || captures.len() != self.target_count
            || collected.len() != self.target_count
            || energy_escape.len() != self.target_count
            || n.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid cylindrical source application");
        }
        rates.fill(0.);
        captures.fill([0.; GROUPS]);
        collected.fill([0.; GROUPS]);
        energy_escape.fill([0.; GROUPS]);
        for (e, &share) in self.intersections.iter().zip(&work.shares) {
            let t = &self.targets[e.target].target;
            let r = &work.responses[e.target];
            for g in 0..GROUPS {
                let flux =
                    share * self.speed[g] * n[e.region * GROUPS + g] / self.volumes[e.region];
                let c = r.capture_m2[g] * flux;
                rates[e.region * GROUPS + g] -= c;
                captures[t.index][g] += c;
                collected[t.index][g] += r.collected_m2[g] * flux;
                energy_escape[t.index][g] += r.energy_escape_m2[g] * flux;
            }
        }
        if rates
            .iter()
            .chain(captures.iter().flatten())
            .chain(collected.iter().flatten())
            .chain(energy_escape.iter().flatten())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite cylindrical candidate rates");
        }
        Ok(())
    }
    pub fn validate_accepted_state(&self, n: &[f64]) -> Result<(), &'static str> {
        if n.len() != self.volumes.len() * GROUPS || n.iter().any(|v| !v.is_finite() || *v < 0.) {
            return Err("Nonphysical accepted cylinder field");
        }
        Ok(())
    }
}

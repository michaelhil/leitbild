//! Finite ordinary volume-material reactions in the selected comparator.
//! Self-scattering affects transport collision, not net population loss. Actual
//! optical stock capture belongs to the face law, not this second volume path.
//! Cylinder/converter response and photon deposition are separate consumers.
use std::{collections::HashSet, sync::Arc};
pub const GROUPS: usize = 7;
#[derive(Clone, Debug)]
pub struct Target {
    pub index: usize,
    pub sigma_m2: [f64; GROUPS],
}
#[derive(Clone, Debug)]
pub struct Stock {
    pub volume: f64,
    pub scatter_m1: [f64; GROUPS],
    pub targets: Vec<Target>,
}
#[derive(Clone, Copy, Debug)]
pub struct Intersection {
    pub stock: usize,
    pub region: usize,
    pub volume: f64,
}
pub struct Model {
    volumes: Vec<f64>,
    speed: [f64; GROUPS],
    stocks: Vec<Stock>,
    intersections: Vec<Intersection>,
    target_count: usize,
    births: usize,
    owner: Arc<()>,
}
pub struct Workspace {
    volumes: Vec<f64>,
    represented: Vec<f64>,
    capture: Vec<[f64; GROUPS]>,
    collision: Vec<[f64; GROUPS]>,
    owner: Arc<()>,
    valid: bool,
}
fn capture_coefficient(amount: f64, fraction: f64, sigma: f64, volume: f64, speed: f64) -> f64 {
    (amount * fraction) * sigma / volume * speed
}
impl Workspace {
    pub fn collision(&self) -> Result<&[[f64; GROUPS]], &'static str> {
        if !self.valid {
            return Err("Unprepared passive workspace");
        }
        Ok(&self.collision)
    }
    pub fn buffer_bytes(&self) -> usize {
        (self.capture.len() + self.collision.len()) * std::mem::size_of::<[f64; GROUPS]>()
            + (self.volumes.len() + self.represented.len()) * 8
    }
}
impl Model {
    pub fn birth_count(&self) -> usize {
        self.births
    }
    /// Fixed gross-capture support for named finite bulk targets. Coefficients
    /// use the same per-amount primitive as the physical update, never a
    /// prepared-state zero to select support.
    pub fn capture_response(
        &self,
        targets: &[usize],
    ) -> Result<Vec<(usize, usize, f64)>, &'static str> {
        if targets.iter().any(|&t| t >= self.target_count)
            || targets.iter().copied().collect::<HashSet<_>>().len() != targets.len()
        {
            return Err("Invalid passive capture response targets");
        }
        let mut out = Vec::new();
        for e in &self.intersections {
            let s = &self.stocks[e.stock];
            for t in &s.targets {
                if !targets.contains(&t.index) {
                    continue;
                }
                for g in 0..GROUPS {
                    if t.sigma_m2[g] == 0. {
                        continue;
                    }
                    let gain = capture_coefficient(
                        1.,
                        e.volume / s.volume,
                        t.sigma_m2[g],
                        self.volumes[e.region],
                        self.speed[g],
                    );
                    if !gain.is_finite() || gain < 0. {
                        return Err("Unrepresentable structural passive capture response");
                    }
                    if gain == 0. {
                        continue;
                    }
                    out.push((t.index, e.region * GROUPS + g, gain));
                }
            }
        }
        if targets.iter().any(|t| !out.iter().any(|e| e.0 == *t)) {
            return Err("Passive capture response target has no nonzero bulk law");
        }
        Ok(out)
    }
    pub fn new(
        volumes: Vec<f64>,
        speed: [f64; GROUPS],
        stocks: Vec<Stock>,
        intersections: Vec<Intersection>,
        target_count: usize,
    ) -> Result<Self, &'static str> {
        if volumes.is_empty()
            || volumes
                .iter()
                .chain(&speed)
                .any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("Invalid passive source domain");
        }
        let mut targets = HashSet::new();
        for s in &stocks {
            if !s.volume.is_finite()
                || s.volume <= 0.
                || s.scatter_m1.iter().any(|v| !v.is_finite() || *v < 0.)
            {
                return Err("Invalid finite passive stock");
            }
            for t in &s.targets {
                if t.index >= target_count
                    || !targets.insert(t.index)
                    || t.sigma_m2.iter().any(|v| !v.is_finite() || *v < 0.)
                {
                    return Err("Invalid/duplicated finite volume target ownership");
                }
            }
        }
        let mut seen = HashSet::new();
        let mut represented = vec![0.; stocks.len()];
        for e in &intersections {
            if e.stock >= stocks.len()
                || e.region >= volumes.len()
                || !e.volume.is_finite()
                || e.volume < 0.
                || !seen.insert((e.stock, e.region))
            {
                return Err("Invalid/duplicated passive material intersection");
            }
            represented[e.stock] += e.volume;
        }
        for (s, &v) in stocks.iter().zip(&represented) {
            if v > s.volume * (1. + 3e-11) {
                return Err("Passive incidence creates material");
            }
        }
        let births = intersections
            .iter()
            .map(|e| stocks[e.stock].targets.len())
            .sum();
        Ok(Self {
            volumes,
            speed,
            stocks,
            intersections,
            target_count,
            births,
            owner: Arc::new(()),
        })
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            volumes: self.intersections.iter().map(|e| e.volume).collect(),
            represented: vec![0.; self.stocks.len()],
            capture: vec![
                [0.; GROUPS];
                self.intersections
                    .iter()
                    .map(|e| self.stocks[e.stock].targets.len())
                    .sum()
            ],
            collision: vec![[0.; GROUPS]; self.volumes.len()],
            owner: self.owner.clone(),
            valid: false,
        }
    }
    pub fn update(&self, amounts: &[f64], work: &mut Workspace) -> Result<(), &'static str> {
        self.update_geometry(amounts, None, work)
    }
    /// Current volumes on the immutable reachable incidence union. A zero
    /// intersection removes this contribution, not its target/history identity.
    pub fn update_with_volumes(
        &self,
        amounts: &[f64],
        volumes: &[f64],
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.update_geometry(amounts, Some(volumes), work)
    }
    fn update_geometry(
        &self,
        amounts: &[f64],
        volumes: Option<&[f64]>,
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        work.valid = false;
        if !Arc::ptr_eq(&work.owner, &self.owner)
            || amounts.len() != self.target_count
            || amounts.iter().any(|v| !v.is_finite() || *v < 0.)
            || volumes.is_some_and(|v| {
                v.len() != self.intersections.len() || v.iter().any(|x| !x.is_finite() || *x < 0.)
            })
        {
            return Err("Invalid actual passive target stocks/workspace");
        }
        work.represented.fill(0.);
        for (i, e) in self.intersections.iter().enumerate() {
            let v = volumes.map_or(e.volume, |v| v[i]);
            work.volumes[i] = v;
            work.represented[e.stock] += v;
        }
        if self
            .stocks
            .iter()
            .zip(&work.represented)
            .any(|(s, v)| !v.is_finite() || *v > s.volume * (1. + 3e-11))
        {
            return Err("Current passive incidence creates material");
        }
        work.collision.fill([0.; GROUPS]);
        let mut i = 0;
        for (e, &volume) in self.intersections.iter().zip(&work.volumes) {
            let s = &self.stocks[e.stock];
            for g in 0..GROUPS {
                work.collision[e.region][g] += s.scatter_m1[g] * volume / self.volumes[e.region];
            }
            for t in &s.targets {
                for g in 0..GROUPS {
                    let amount = amounts[t.index] * (volume / s.volume);
                    let coefficient = amount * t.sigma_m2[g] / self.volumes[e.region];
                    work.capture[i][g] = capture_coefficient(
                        amounts[t.index],
                        volume / s.volume,
                        t.sigma_m2[g],
                        self.volumes[e.region],
                        self.speed[g],
                    );
                    work.collision[e.region][g] += coefficient;
                }
                i += 1;
            }
        }
        if work
            .collision
            .iter()
            .chain(&work.capture)
            .flatten()
            .any(|v| !v.is_finite() || *v < 0.)
        {
            return Err("Unrepresentable passive reaction candidate");
        }
        work.valid = true;
        Ok(())
    }
    /// Add rates to caller-owned accumulators. Events debit the single actual
    /// target and create its product once; no thermal recipient is invented.
    pub fn apply(
        &self,
        work: &Workspace,
        n: &[f64],
        rates: &mut [f64],
        captures: &mut [f64],
        births: &mut [f64],
    ) -> Result<(), &'static str> {
        self.apply_inner(work, n, rates, captures, births, None)
    }
    /// Preserve the ordinary paid events, exposing their per-material-volume
    /// density to physical sub-incidence consumers. Empty reachable rows use
    /// the same coefficient primitive at unit material volume; no 0/0, floor,
    /// or extra full capture traversal is introduced.
    pub(crate) fn apply_with_birth_density(
        &self, work: &Workspace, amounts: &[f64], n: &[f64], rates: &mut [f64],
        captures: &mut [f64], births: &mut [f64], density: &mut [f64],
    ) -> Result<(), &'static str> {
        if amounts.len() != self.target_count || amounts.iter().any(|x| !x.is_finite() || *x < 0.)
            || density.len() != self.birth_count()
        { return Err("Invalid passive birth-density application"); }
        self.apply_inner(work, n, rates, captures, births, Some((amounts, density)))
    }
    fn apply_inner(
        &self, work: &Workspace, n: &[f64], rates: &mut [f64], captures: &mut [f64],
        births: &mut [f64], mut density: Option<(&[f64], &mut [f64])>,
    ) -> Result<(), &'static str> {
        if !work.valid
            || !Arc::ptr_eq(&work.owner, &self.owner)
            || n.len() != self.volumes.len() * GROUPS
            || rates.len() != n.len()
            || captures.len() != self.target_count
            || births.len() != self.birth_count()
            || n.iter()
                .chain(rates.iter())
                .chain(captures.iter())
                .any(|v| !v.is_finite())
        {
            return Err("Invalid passive source application");
        }
        let mut i = 0;
        for (j, e) in self.intersections.iter().enumerate() {
            for t in &self.stocks[e.stock].targets {
                let mut event = 0.;
                let mut empty_density = 0.;
                for g in 0..GROUPS {
                    let r = work.capture[i][g] * n[e.region * GROUPS + g];
                    rates[e.region * GROUPS + g] -= r;
                    event += r;
                    if work.volumes[j] == 0. {
                        if let Some((amounts, _)) = &density {
                            empty_density += capture_coefficient(amounts[t.index],
                                1. / self.stocks[e.stock].volume, t.sigma_m2[g],
                                self.volumes[e.region], self.speed[g]) * n[e.region * GROUPS + g];
                        }
                    }
                }
                captures[t.index] += event;
                births[i] = event;
                if let Some((_, d)) = &mut density {
                    d[i] = if work.volumes[j] > 0. { event / work.volumes[j] } else { empty_density };
                    if !d[i].is_finite() { return Err("Invalid passive birth density"); }
                }
                i += 1;
            }
        }
        if rates.iter().chain(captures.iter()).any(|v| !v.is_finite()) {
            return Err("Nonfinite passive candidate rate");
        }
        Ok(())
    }
}

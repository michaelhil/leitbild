//! Regional FUEL contribution only: induced events, scattering, local prompt
//! births and six carried precursor amounts. No moderator/absorber/transport,
//! external births, poison, source calibration or time integrator.
use std::collections::HashSet;
use std::sync::Arc;

pub const GROUPS: usize = 7;
pub const DELAYED: usize = 6;

#[derive(Clone, Debug)]
pub struct FuelLaw {
    pub absorption: [f64; GROUPS], //m^-1; includes fission termination
    pub fission: [f64; GROUPS],
    pub scatter: [[f64; GROUPS]; GROUPS], //from-group rows, to-group columns
    pub nu: [f64; GROUPS],
    pub chi: [f64; GROUPS], //one actual-sum normalized prompt/delayed spectrum
    pub speed: [f64; GROUPS],
    pub beta: [f64; DELAYED],
    pub decay: [f64; DELAYED],
    pub f_d: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Cohort {
    pub segment: usize,
    pub mass: f64, //reference fuel ONLY, kg
    pub mu: f64,   //retained segment release, ONCE per cohort
}
#[derive(Clone, Copy, Debug)]
pub struct Weight {
    pub cohort: usize,
    pub mass: f64,
}
#[derive(Clone, Debug)]
pub struct Intersection {
    pub region: usize,
    pub segment: usize,
    pub volume: f64,          //actual rod-composite intersection, m^3
    pub weights: Vec<Weight>, //actual reference-fuel-mass W, kg
}
#[derive(Clone, Copy, Debug)]
pub struct Stocks {
    pub reserve: f64,
    pub reference_reserve: f64,
    pub fertile: f64,
    pub reference_fertile: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Coordinate {
    pub row: usize,
    pub column: usize,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct EventCoefficients {
    pub fission: [f64; GROUPS], //events/s per neutron amount
    pub capture: [f64; GROUPS],
    pub d_fission_d_reserve: [f64; GROUPS],
    pub d_capture_d_fertile: [f64; GROUPS],
}
#[derive(Clone, Copy, Debug)]
pub struct ThermalDerivative {
    pub intersection: usize,
    pub cohort: usize,
    pub d_capture_d_temperature: [f64; GROUPS],
}
pub struct Workspace {
    coefficients: Vec<f64>, //same immutable coordinate pattern on every trial
    events: Vec<EventCoefficients>,
    thermal_derivatives: Vec<ThermalDerivative>,
    root_temperature: Vec<f64>,
    owner: Arc<()>,
    valid: bool,
}
impl Workspace {
    pub fn coefficients(&self) -> &[f64] {
        &self.coefficients
    }
    pub fn events(&self) -> &[EventCoefficients] {
        &self.events
    }
    pub fn thermal_derivatives(&self) -> &[ThermalDerivative] {
        &self.thermal_derivatives
    }
}
pub struct FuelModel {
    law: FuelLaw,
    region_volumes: Vec<f64>,
    segment_volumes: Vec<f64>,
    cohorts: Vec<Cohort>,
    intersections: Vec<Intersection>,
    coordinates: Vec<Coordinate>,
    weight_total: Vec<f64>,
    owner: Arc<()>,
}
fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.
}
fn nonnegative(v: f64) -> bool {
    v.is_finite() && v >= 0.
}
fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= 2e-11 * b.abs().max(1e-12)
}
impl FuelModel {
    /// Compile physical incidence and the LOCAL sparse-block pattern once.
    /// Repeated coordinates from different materials are additive contributions.
    pub fn new(
        law: FuelLaw,
        region_volumes: Vec<f64>,
        segment_volumes: Vec<f64>,
        cohorts: Vec<Cohort>,
        intersections: Vec<Intersection>,
    ) -> Result<Self, &'static str> {
        if !region_volumes.iter().all(|v| positive(*v))
            || !segment_volumes.iter().all(|v| positive(*v))
            || !(0. ..=1.).contains(&law.f_d)
            || !law.f_d.is_finite()
            || !law
                .absorption
                .iter()
                .chain(law.fission.iter())
                .chain(law.chi.iter())
                .all(|v| nonnegative(*v))
            || !law.scatter.iter().flatten().all(|v| nonnegative(*v))
            || !law
                .speed
                .iter()
                .chain(law.nu.iter())
                .chain(law.decay.iter())
                .all(|v| positive(*v))
            || !law.beta.iter().all(|v| nonnegative(*v))
            || law.beta.iter().sum::<f64>() >= 1.
            || !same(law.chi.iter().sum(), 1.)
            || (0..GROUPS).any(|g| law.absorption[g] < law.fission[g])
        {
            return Err("Invalid owned SI fuel law/support");
        }
        let mut segment_mass = vec![0.; segment_volumes.len()];
        let mut release = vec![0.; segment_volumes.len()];
        let mut assigned = vec![0.; cohorts.len()];
        for c in &cohorts {
            if c.segment >= segment_volumes.len() || !positive(c.mass) || !positive(c.mu) {
                return Err("Invalid retained fuel cohort");
            }
            segment_mass[c.segment] += c.mass;
            release[c.segment] += c.mu;
        }
        let mut covered = vec![0.; segment_volumes.len()];
        let mut region_occupied = vec![0.; region_volumes.len()];
        let mut seen = HashSet::new();
        let mut coordinates = Vec::new();
        let n_offset = region_volumes.len() * GROUPS;
        for e in &intersections {
            if e.region >= region_volumes.len()
                || e.segment >= segment_volumes.len()
                || !positive(e.volume)
                || !seen.insert((e.region, e.segment))
                || e.weights.is_empty()
            {
                return Err("Invalid/duplicated fuel intersection");
            }
            covered[e.segment] += e.volume;
            region_occupied[e.region] += e.volume;
            let mut local = HashSet::new();
            for w in &e.weights {
                if w.cohort >= cohorts.len()
                    || cohorts[w.cohort].segment != e.segment
                    || !positive(w.mass)
                    || !local.insert(w.cohort)
                {
                    return Err("Invalid actual thermal W incidence");
                }
                assigned[w.cohort] += w.mass;
            }
            if !same(
                e.weights.iter().map(|w| w.mass).sum(),
                segment_mass[e.segment] * e.volume / segment_volumes[e.segment],
            ) {
                return Err("Thermal/reference mass does not cover composite intersection");
            }
            //Dense7x7 LOCAL blocks; no dense global matrix or per-trial pattern.
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    coordinates.push(Coordinate {
                        row: e.region * GROUPS + h,
                        column: e.region * GROUPS + g,
                    });
                }
            }
            for j in 0..DELAYED {
                for g in 0..GROUPS {
                    coordinates.push(Coordinate {
                        row: n_offset + e.segment * DELAYED + j,
                        column: e.region * GROUPS + g,
                    });
                }
            }
            for g in 0..GROUPS {
                for j in 0..DELAYED {
                    coordinates.push(Coordinate {
                        row: e.region * GROUPS + g,
                        column: n_offset + e.segment * DELAYED + j,
                    });
                }
            }
        }
        if region_occupied
            .iter()
            .zip(&region_volumes)
            .any(|(occupied, volume)| !occupied.is_finite() || occupied > volume)
            || segment_volumes
                .iter()
                .enumerate()
                .any(|(s, v)| !same(covered[s], *v) || !same(release[s], 1.))
            || cohorts.iter().enumerate().any(|(q, c)| {
                !same(assigned[q], c.mass) || !same(c.mu, c.mass / segment_mass[c.segment])
            })
        {
            return Err("Missing material/thermal/history coverage");
        }
        for s in 0..segment_volumes.len() {
            for j in 0..DELAYED {
                let index = n_offset + s * DELAYED + j;
                coordinates.push(Coordinate {
                    row: index,
                    column: index,
                });
            }
        }
        let weight_total = intersections
            .iter()
            .map(|e| e.weights.iter().map(|w| w.mass).sum())
            .collect();
        Ok(Self {
            law,
            region_volumes,
            segment_volumes,
            cohorts,
            intersections,
            coordinates,
            weight_total,
            owner: Arc::new(()),
        })
    }
    pub fn coordinate_count(&self) -> usize {
        self.region_volumes.len() * GROUPS + self.segment_volumes.len() * DELAYED
    }
    pub fn law(&self) -> &FuelLaw {
        &self.law
    }
    pub fn coordinates(&self) -> &[Coordinate] {
        &self.coordinates
    }
    pub fn intersections(&self) -> &[Intersection] {
        &self.intersections
    }
    pub fn cohorts(&self) -> &[Cohort] {
        &self.cohorts
    }
    pub fn segment_count(&self) -> usize {
        self.segment_volumes.len()
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            coefficients: vec![0.; self.coordinates.len()],
            events: vec![EventCoefficients::default(); self.intersections.len()],
            thermal_derivatives: self
                .intersections
                .iter()
                .enumerate()
                .flat_map(|(i, e)| {
                    e.weights.iter().map(move |w| ThermalDerivative {
                        intersection: i,
                        cohort: w.cohort,
                        d_capture_d_temperature: [0.; GROUPS],
                    })
                })
                .collect(),
            root_temperature: vec![0.; self.cohorts.len()],
            owner: Arc::clone(&self.owner),
            valid: false,
        }
    }
    /// Update caller-owned numerical workspace from SAME-TRIAL temperatures and
    /// actual finite instance stocks. No reference ratio defaults or stock reset.
    pub fn update(
        &self,
        temperatures: &[f64],
        stocks: &[Stocks],
        work: &mut Workspace,
    ) -> Result<(), &'static str> {
        work.valid = false;
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || temperatures.len() != self.cohorts.len()
            || stocks.len() != self.segment_volumes.len()
            || temperatures
                .iter()
                .any(|t| !t.is_finite() || !(290. ..=2000.).contains(t))
            || stocks.iter().any(|s| {
                !positive(s.reference_reserve)
                    || !positive(s.reference_fertile)
                    || !nonnegative(s.reserve)
                    || !nonnegative(s.fertile)
                    || s.reserve > s.reference_reserve
                    || s.fertile > s.reference_fertile
            })
            || work.coefficients.len() != self.coordinates.len()
            || work.events.len() != self.intersections.len()
            || work.root_temperature.len() != self.cohorts.len()
            || work.thermal_derivatives.len()
                != self
                    .intersections
                    .iter()
                    .map(|e| e.weights.len())
                    .sum::<usize>()
        {
            return Err("Invalid same-trial fuel instance inputs/workspace");
        }
        let beta = self.law.beta.iter().sum::<f64>();
        for (root, t) in work.root_temperature.iter_mut().zip(temperatures) {
            *root = (t / 300.).sqrt();
        }
        let mut offset = 0;
        let mut thermal_index = 0;
        for (i, e) in self.intersections.iter().enumerate() {
            let stock = stocks[e.segment];
            let mass = self.weight_total[i];
            let d = e
                .weights
                .iter()
                .map(|w| w.mass * work.root_temperature[w.cohort])
                .sum::<f64>()
                / mass;
            let multiplier = 1. + self.law.f_d * (d - 1.);
            let f = stock.reserve / stock.reference_reserve;
            let t = stock.fertile / stock.reference_fertile;
            let fraction = e.volume / self.region_volumes[e.region];
            let mut events = EventCoefficients::default();
            for g in 0..GROUPS {
                let response = if g == 2 || g == 3 { multiplier } else { 1. };
                let factor = self.law.speed[g] * fraction;
                events.fission[g] = factor * self.law.fission[g] * f;
                events.capture[g] =
                    factor * (self.law.absorption[g] - self.law.fission[g]) * t * response;
                events.d_fission_d_reserve[g] =
                    factor * self.law.fission[g] / stock.reference_reserve;
                events.d_capture_d_fertile[g] =
                    factor * (self.law.absorption[g] - self.law.fission[g]) * response
                        / stock.reference_fertile;
            }
            work.events[i] = events;
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    let scatter = if h == g {
                        -self.law.scatter[g]
                            .iter()
                            .enumerate()
                            .filter(|(k, _)| *k != g)
                            .map(|(_, v)| v)
                            .sum::<f64>()
                    } else {
                        self.law.scatter[g][h]
                    };
                    let loss = if h == g {
                        -(events.fission[g] + events.capture[g])
                    } else {
                        0.
                    };
                    work.coefficients[offset] = fraction * self.law.speed[g] * scatter
                        + loss
                        + self.law.chi[h] * (1. - beta) * self.law.nu[g] * events.fission[g];
                    offset += 1;
                }
            }
            for j in 0..DELAYED {
                for g in 0..GROUPS {
                    work.coefficients[offset] =
                        self.law.beta[j] * self.law.nu[g] * events.fission[g];
                    offset += 1;
                }
            }
            for g in 0..GROUPS {
                for j in 0..DELAYED {
                    work.coefficients[offset] = self.law.chi[g] * self.law.decay[j] * e.volume
                        / self.segment_volumes[e.segment];
                    offset += 1;
                }
            }
            for w in &e.weights {
                let deriv = &mut work.thermal_derivatives[thermal_index];
                deriv.intersection = i;
                deriv.cohort = w.cohort;
                deriv.d_capture_d_temperature.fill(0.);
                for g in [2, 3] {
                    deriv.d_capture_d_temperature[g] = fraction
                        * self.law.speed[g]
                        * (self.law.absorption[g] - self.law.fission[g])
                        * t
                        * self.law.f_d
                        * w.mass
                        / mass
                        / (600. * work.root_temperature[w.cohort]);
                }
                thermal_index += 1;
            }
        }
        for _ in &self.segment_volumes {
            for j in 0..DELAYED {
                work.coefficients[offset] = -self.law.decay[j];
                offset += 1;
            }
        }
        if work
            .coefficients
            .iter()
            .chain(work.events.iter().flat_map(|e| {
                e.fission
                    .iter()
                    .chain(e.capture.iter())
                    .chain(e.d_fission_d_reserve.iter())
                    .chain(e.d_capture_d_fertile.iter())
            }))
            .chain(
                work.thermal_derivatives
                    .iter()
                    .flat_map(|d| d.d_capture_d_temperature.iter()),
            )
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite fuel coefficient candidate");
        }
        work.valid = true;
        Ok(())
    }
    /// Return this component's additive contribution, NEVER complete plant Ndot.
    /// Errors invalidate caller candidates; partial arrays are not accepted state.
    pub fn apply(
        &self,
        work: &Workspace,
        state: &[f64],
        rate: &mut [f64],
        event_rates: &mut [[f64; 2]],
    ) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || !work.valid
            || state.len() != self.coordinate_count()
            || rate.len() != state.len()
            || event_rates.len() != self.intersections.len()
            || state.iter().any(|v| !nonnegative(*v))
        {
            return Err("Invalid fuel contribution state/workspace");
        }
        rate.fill(0.);
        for (index, value) in self.coordinates.iter().zip(&work.coefficients) {
            rate[index.row] += value * state[index.column];
        }
        for (i, e) in self.intersections.iter().enumerate() {
            event_rates[i] = [0.; 2];
            for g in 0..GROUPS {
                let n = state[e.region * GROUPS + g];
                event_rates[i][0] += work.events[i].fission[g] * n;
                event_rates[i][1] += work.events[i].capture[g] * n;
            }
        }
        if rate
            .iter()
            .chain(event_rates.iter().flatten())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite fuel rate candidate");
        }
        Ok(())
    }
    /// Originating-fuel prompt energy and actual E25 segment RELEASE only.
    /// Caller supplies the owned prompt J/event and current retained release.
    /// Capture binding/photon/other thermal owners are deliberately NOT here.
    pub fn fuel_heat(
        &self,
        event_rates: &[[f64; 2]],
        prompt_j_per_event: f64,
        segment_release: &[f64],
        heat: &mut [f64],
    ) -> Result<(), &'static str> {
        if event_rates.len() != self.intersections.len()
            || segment_release.len() != self.segment_volumes.len()
            || heat.len() != self.cohorts.len()
            || !nonnegative(prompt_j_per_event)
            || event_rates
                .iter()
                .flatten()
                .chain(segment_release.iter())
                .any(|v| !nonnegative(*v))
        {
            return Err("Invalid paid fuel heat input");
        }
        heat.fill(0.);
        for (i, e) in self.intersections.iter().enumerate() {
            let mass = self.weight_total[i];
            for w in &e.weights {
                heat[w.cohort] += prompt_j_per_event * event_rates[i][0] * w.mass / mass;
            }
        }
        for (q, c) in self.cohorts.iter().enumerate() {
            heat[q] += c.mu * segment_release[c.segment];
        }
        if heat.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite fuel heat candidate");
        }
        Ok(())
    }
}

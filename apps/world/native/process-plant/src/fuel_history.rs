//! Complete FUEL-history contribution, not a whole-source operator/integrator.
//! Existing N/C incidence is reused. Finite isotope consumption is retained as
//! small progress/product amounts instead of subtracting tiny events in-place
//! from ~1e28-atom stocks. Moderator/passive histories and transport remain the
//! caller's separately owned contributions. Returned energy is RELEASE, not
//! deposited/advanced thermal energy. Geometry/temperature are supplied inputs.
//! Poison/fertile capture event rates are exposed; this block does not silently
//! assign their separate binding emission to a fuel thermal recipient.
use crate::fuel_source::{FuelModel, Stocks, Workspace as FuelWorkspace, DELAYED, GROUPS};
use crate::heat_history::{Kernel, Rates};
use std::sync::Arc;

pub const HISTORY: usize = 34;
pub const CONSUMED_235: usize = 0;
pub const CAPTURED_238: usize = 1;
pub const SF_238: usize = 2;
pub const IODINE: usize = 3;
pub const XENON: usize = 4;
pub const PROMETHIUM: usize = 5;
pub const SAMARIUM: usize = 6;
pub const XENON_PRODUCT: usize = 7;
pub const SAMARIUM_PRODUCT: usize = 8;
pub const ENERGY: usize = 9;

#[derive(Clone, Copy, Debug)]
pub struct SegmentPreparation {
    pub reference_u235: f64,
    pub reference_u238: f64,
    /// Actual original isotope neutron/s, not spontaneous events/s.
    pub sf235_neutrons_per_second: f64,
    pub sf238_neutrons_per_second: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct PoisonLaw {
    pub yield_i: f64,
    pub yield_xe: f64,
    pub yield_pm: f64,
    pub lambda_i: f64,
    pub lambda_xe: f64,
    pub lambda_pm: f64,
    pub xe_sigma_m2: f64,
    pub sm_sigma_m2: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct CfLaw {
    /// Aged finite effective donor and its matching original emission.
    pub initial_energy_j: f64,
    pub initial_neutrons_per_second: f64,
    pub decay_rate: f64,
    pub birth_export_j_per_neutron: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct SegmentRates {
    pub induced_fission: f64,
    pub fertile_capture: f64,
    pub sf235: f64,
    pub sf238: f64,
    pub xe_capture: f64,
    pub sm_capture: f64,
    pub prompt_release: f64,
    pub delayed_release: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct CfRates {
    pub births: f64,
    pub paid_release: f64,
    pub capsule_release: f64,
    pub birth_export: f64,
}
pub struct Assembly {
    fuel: FuelModel,
    segments: Vec<SegmentPreparation>,
    volumes: Vec<f64>,
    poison: PoisonLaw,
    heat: Kernel,
    spontaneous_neutrons_per_event: f64,
    cf: CfLaw,
    cf_support: Vec<(usize, f64)>,
    owner: Arc<()>,
}
pub struct Workspace {
    fuel: FuelWorkspace,
    stocks: Vec<Stocks>,
    events: Vec<[f64; 2]>,
    event_direction: Vec<[f64; 2]>,
    state: Vec<f64>,
    temperatures: Vec<f64>,
    rates: Vec<f64>,
    direction: Vec<f64>,
    collision: Vec<[f64; GROUPS]>,
    collision_direction: Vec<[f64; GROUPS]>,
    segments: Vec<SegmentRates>,
    segment_direction: Vec<SegmentRates>,
    cf: CfRates,
    cf_direction: CfRates,
    owner: Arc<()>,
    valid: bool,
    direction_valid: bool,
}
impl Workspace {
    pub fn fuel_coefficients(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(self.fuel.coefficients())
    }
    pub fn fuel_events(&self) -> Result<&[crate::fuel_source::EventCoefficients], &'static str> {
        self.check()?;
        Ok(self.fuel.events())
    }
    pub fn rates(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.rates)
    }
    pub fn collision(&self) -> Result<&[[f64; GROUPS]], &'static str> {
        self.check()?;
        Ok(&self.collision)
    }
    pub fn segments(&self) -> Result<&[SegmentRates], &'static str> {
        self.check()?;
        Ok(&self.segments)
    }
    pub fn cf(&self) -> Result<CfRates, &'static str> {
        self.check()?;
        Ok(self.cf)
    }
    pub fn rate_jvp(&self) -> Result<&[f64], &'static str> {
        self.check_direction()?;
        Ok(&self.direction)
    }
    pub fn collision_jvp(&self) -> Result<&[[f64; GROUPS]], &'static str> {
        self.check_direction()?;
        Ok(&self.collision_direction)
    }
    pub fn segment_jvp(&self) -> Result<&[SegmentRates], &'static str> {
        self.check_direction()?;
        Ok(&self.segment_direction)
    }
    pub fn cf_jvp(&self) -> Result<CfRates, &'static str> {
        self.check_direction()?;
        Ok(self.cf_direction)
    }
    fn check(&self) -> Result<(), &'static str> {
        if self.valid {
            Ok(())
        } else {
            Err("Invalid fuel-history candidate")
        }
    }
    fn check_direction(&self) -> Result<(), &'static str> {
        self.check()?;
        if self.direction_valid {
            Ok(())
        } else {
            Err("Invalid fuel-history JVP candidate")
        }
    }
    /// Known retained Vec element payload, not total allocator/model/solver RAM.
    pub fn buffer_bytes(&self) -> usize {
        self.fuel.buffer_bytes()
            + self.stocks.len() * std::mem::size_of::<Stocks>()
            + (self.events.len() + self.event_direction.len()) * std::mem::size_of::<[f64; 2]>()
            + (self.state.len() + self.temperatures.len() + self.rates.len() + self.direction.len())
                * 8
            + (self.collision.len() + self.collision_direction.len())
                * std::mem::size_of::<[f64; GROUPS]>()
            + (self.segments.len() + self.segment_direction.len())
                * std::mem::size_of::<SegmentRates>()
    }
}
fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.
}
fn nonnegative(v: f64) -> bool {
    v.is_finite() && v >= 0.
}
impl Assembly {
    pub fn poison_law(&self) -> PoisonLaw {
        self.poison
    }
    pub fn segment_volumes(&self) -> &[f64] {
        &self.volumes
    }
    pub fn energy_groups(&self) -> &[crate::heat_history::Group] {
        self.heat.groups()
    }
    pub fn spontaneous_neutrons_per_event(&self) -> f64 {
        self.spontaneous_neutrons_per_event
    }
    pub fn fission_energy(&self) -> f64 {
        // The heat kernel owns this exact event budget.
        self.heat.fission_energy()
    }
    pub fn cf_decay_rate(&self) -> f64 {
        self.cf.decay_rate
    }
    pub fn new(
        fuel: FuelModel,
        segments: Vec<SegmentPreparation>,
        poison: PoisonLaw,
        heat: Kernel,
        spontaneous_neutrons_per_event: f64,
        cf: CfLaw,
        cf_support: Vec<(usize, f64)>,
    ) -> Result<Self, &'static str> {
        let initial_cf_release = cf.initial_energy_j * cf.decay_rate;
        let initial_cf_export = cf.initial_neutrons_per_second * cf.birth_export_j_per_neutron;
        if segments.len() != fuel.segment_count()
            || heat.group_count() != 25
            || segments.iter().any(|s| {
                !positive(s.reference_u235)
                    || !positive(s.reference_u238)
                    || !nonnegative(s.sf235_neutrons_per_second)
                    || !nonnegative(s.sf238_neutrons_per_second)
            })
            || [
                poison.yield_i,
                poison.yield_xe,
                poison.yield_pm,
                poison.xe_sigma_m2,
                poison.sm_sigma_m2,
            ]
            .iter()
            .any(|&v| !nonnegative(v))
            || [
                poison.lambda_i,
                poison.lambda_xe,
                poison.lambda_pm,
                cf.initial_energy_j,
                cf.initial_neutrons_per_second,
                cf.decay_rate,
            ]
            .iter()
            .any(|&v| !positive(v))
            || !positive(spontaneous_neutrons_per_event)
            || !nonnegative(cf.birth_export_j_per_neutron)
            || cf_support.is_empty()
            || cf_support
                .iter()
                .any(|&(r, w)| r >= fuel.volumes().len() || !positive(w))
            || (cf_support.iter().map(|(_, w)| w).sum::<f64>() - 1.).abs() > 2e-11
            || !initial_cf_release.is_finite()
            || !initial_cf_export.is_finite()
            || initial_cf_release < initial_cf_export
        {
            return Err("Invalid complete fuel-history preparation/law");
        }
        let mut seen = std::collections::HashSet::new();
        if cf_support.iter().any(|(r, _)| !seen.insert(*r)) {
            return Err("Duplicate Cf spatial support");
        }
        let mut volumes = vec![0.; segments.len()];
        for e in fuel.intersections() {
            volumes[e.segment] += e.volume;
        }
        if volumes.iter().any(|&v| !positive(v)) {
            return Err("Missing finite fuel history support");
        }
        fuel.coordinate_count()
            .checked_add(
                segments
                    .len()
                    .checked_mul(HISTORY)
                    .ok_or("Fuel-history size overflow")?,
            )
            .and_then(|v| v.checked_add(1))
            .ok_or("Fuel-history size overflow")?;
        Ok(Self {
            fuel,
            segments,
            volumes,
            poison,
            heat,
            spontaneous_neutrons_per_event,
            cf,
            cf_support,
            owner: Arc::new(()),
        })
    }
    pub fn fuel(&self) -> &FuelModel {
        &self.fuel
    }
    pub fn fuel_dimension(&self) -> usize {
        self.fuel.coordinate_count()
    }
    pub fn state_count(&self) -> usize {
        self.fuel_dimension() + self.segments.len() * HISTORY + 1
    }
    pub fn history_row(&self, segment: usize, slot: usize) -> usize {
        self.fuel_dimension() + segment * HISTORY + slot
    }
    pub fn cf_row(&self) -> usize {
        self.state_count() - 1
    }
    pub fn initial_state(&self) -> Vec<f64> {
        let mut y = vec![0.; self.state_count()];
        y[self.cf_row()] = self.cf.initial_energy_j;
        y
    }
    pub fn workspace(&self) -> Workspace {
        let nr = self.fuel.volumes().len();
        let ns = self.segments.len();
        Workspace {
            fuel: self.fuel.workspace(),
            stocks: vec![
                Stocks {
                    reserve: 0.,
                    reference_reserve: 1.,
                    fertile: 0.,
                    reference_fertile: 1.
                };
                ns
            ],
            events: vec![[0.; 2]; self.fuel.intersections().len()],
            event_direction: vec![[0.; 2]; self.fuel.intersections().len()],
            state: vec![0.; self.state_count()],
            temperatures: vec![0.; self.fuel.cohorts().len()],
            rates: vec![0.; self.state_count()],
            direction: vec![0.; self.state_count()],
            collision: vec![[0.; GROUPS]; nr],
            collision_direction: vec![[0.; GROUPS]; nr],
            segments: vec![SegmentRates::default(); ns],
            segment_direction: vec![SegmentRates::default(); ns],
            cf: CfRates::default(),
            cf_direction: CfRates::default(),
            owner: self.owner.clone(),
            valid: false,
            direction_valid: false,
        }
    }
    /// Physical commit boundary, never a Newton-trial clipping operation.
    pub fn validate_accepted_state(&self, y: &[f64]) -> Result<(), &'static str> {
        if y.len() != self.state_count() || y.iter().any(|&v| !nonnegative(v)) {
            return Err("Negative/nonfinite accepted fuel history");
        }
        self.fuel
            .validate_accepted_state(&y[..self.fuel_dimension()])?;
        for (s, p) in self.segments.iter().enumerate() {
            let h = &y[self.history_row(s, 0)..self.history_row(s, 0) + HISTORY];
            if h[CONSUMED_235] > p.reference_u235 || h[CAPTURED_238] + h[SF_238] > p.reference_u238
            {
                return Err("Exhausted accepted fuel isotope donor");
            }
        }
        if y[self.cf_row()] > self.cf.initial_energy_j {
            return Err("Renewed accepted Cf donor");
        }
        Ok(())
    }
    pub fn evaluate_into(
        &self,
        temperatures: &[f64],
        y: &[f64],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.valid = false;
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() != self.state_count()
            || y.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid fuel-history trial/workspace");
        }
        for (s, p) in self.segments.iter().enumerate() {
            let h = &y[self.history_row(s, 0)..self.history_row(s, 0) + HISTORY];
            w.stocks[s] = Stocks {
                reserve: p.reference_u235 - h[CONSUMED_235],
                reference_reserve: p.reference_u235,
                fertile: p.reference_u238 - h[CAPTURED_238] - h[SF_238],
                reference_fertile: p.reference_u238,
            };
        }
        self.fuel.update(temperatures, &w.stocks, &mut w.fuel)?;
        self.fuel.apply(
            &w.fuel,
            &y[..self.fuel_dimension()],
            &mut w.rates[..self.fuel_dimension()],
            &mut w.events,
        )?;
        self.fuel.collision_into(&w.fuel, &mut w.collision)?;
        w.rates[self.fuel_dimension()..].fill(0.);
        w.segments.fill(SegmentRates::default());
        for (e, event) in self.fuel.intersections().iter().zip(&w.events) {
            w.segments[e.segment].induced_fission += event[0];
            w.segments[e.segment].fertile_capture += event[1];
        }
        for (s, p) in self.segments.iter().enumerate() {
            let row = self.history_row(s, 0);
            let h = &y[row..row + HISTORY];
            let r = &mut w.segments[s];
            r.sf235 = p.sf235_neutrons_per_second / self.spontaneous_neutrons_per_event
                * (w.stocks[s].reserve / p.reference_u235);
            r.sf238 = p.sf238_neutrons_per_second / self.spontaneous_neutrons_per_event
                * (w.stocks[s].fertile / p.reference_u238);
            w.rates[row + CONSUMED_235] = r.induced_fission + r.sf235;
            w.rates[row + CAPTURED_238] = r.fertile_capture;
            w.rates[row + SF_238] = r.sf238;
            let heat = self
                .heat
                .rhs_into(
                    &h[ENERGY..],
                    Rates {
                        fission: r.induced_fission + r.sf235 + r.sf238,
                        fertile_capture: r.fertile_capture,
                    },
                    &mut w.rates[row + ENERGY..row + HISTORY],
                )
                .map_err(|_| "Invalid fuel-history heat candidate")?;
            r.prompt_release = heat.prompt;
            r.delayed_release = heat.delayed;
        }
        for e in self.fuel.intersections() {
            let row = self.history_row(e.segment, 0);
            let h = &y[row..row + HISTORY];
            let r = &mut w.segments[e.segment];
            let weight = e.volume / self.volumes[e.segment];
            let flux =
                self.fuel.law().speed[6] * y[e.region * GROUPS + 6] / self.fuel.volumes()[e.region];
            let xe = self.poison.xe_sigma_m2 * h[XENON] * weight / self.fuel.volumes()[e.region];
            let sm = self.poison.sm_sigma_m2 * h[SAMARIUM] * weight / self.fuel.volumes()[e.region];
            let cx = flux * self.poison.xe_sigma_m2 * h[XENON] * weight;
            let cs = flux * self.poison.sm_sigma_m2 * h[SAMARIUM] * weight;
            r.xe_capture += cx;
            r.sm_capture += cs;
            w.rates[e.region * GROUPS + 6] -= cx + cs;
            w.collision[e.region][6] += xe + sm;
            for g in 0..GROUPS {
                w.rates[e.region * GROUPS + g] += self.fuel.law().chi[g]
                    * self.spontaneous_neutrons_per_event
                    * (r.sf235 + r.sf238)
                    * weight;
            }
        }
        for s in 0..self.segments.len() {
            let row = self.history_row(s, 0);
            let h = &y[row..row + HISTORY];
            let r = w.segments[s];
            let f = r.induced_fission + r.sf235 + r.sf238;
            w.rates[row + IODINE] = self.poison.yield_i * f - self.poison.lambda_i * h[IODINE];
            w.rates[row + XENON] = self.poison.yield_xe * f + self.poison.lambda_i * h[IODINE]
                - self.poison.lambda_xe * h[XENON]
                - r.xe_capture;
            w.rates[row + PROMETHIUM] =
                self.poison.yield_pm * f - self.poison.lambda_pm * h[PROMETHIUM];
            w.rates[row + SAMARIUM] = self.poison.lambda_pm * h[PROMETHIUM] - r.sm_capture;
            w.rates[row + XENON_PRODUCT] = r.xe_capture;
            w.rates[row + SAMARIUM_PRODUCT] = r.sm_capture;
        }
        w.cf = self.cf_rates(y[self.cf_row()]);
        w.rates[self.cf_row()] = -w.cf.paid_release;
        for &(region, weight) in &self.cf_support {
            for g in 0..GROUPS {
                w.rates[region * GROUPS + g] += self.fuel.law().chi[g] * weight * w.cf.births;
            }
        }
        if w.rates
            .iter()
            .chain(w.collision.iter().flatten())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite fuel-history rate/collision candidate");
        }
        w.state.copy_from_slice(y);
        w.temperatures.copy_from_slice(temperatures);
        w.valid = true;
        Ok(())
    }
    fn cf_rates(&self, energy: f64) -> CfRates {
        let births = self.cf.initial_neutrons_per_second * (energy / self.cf.initial_energy_j);
        let paid_release = self.cf.decay_rate * energy;
        let birth_export = self.cf.birth_export_j_per_neutron * births;
        CfRates {
            births,
            paid_release,
            capsule_release: paid_release - birth_export,
            birth_export,
        }
    }
    /// Analytic directional derivative of THIS contribution and its collision
    /// sum. No transport derivative, global assembled Jacobian or stage solver.
    pub fn jvp_into(
        &self,
        dtemperatures: &[f64],
        dy: &[f64],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || dy.len() != self.state_count()
            || dtemperatures.len() != w.temperatures.len()
            || dy.iter().chain(dtemperatures).any(|v| !v.is_finite())
        {
            return Err("Invalid fuel-history direction/workspace");
        }
        w.direction.fill(0.);
        w.collision_direction.fill([0.; GROUPS]);
        w.segment_direction.fill(SegmentRates::default());
        w.event_direction.fill([0.; 2]);
        for (c, a) in self.fuel.coordinates().iter().zip(w.fuel.coefficients()) {
            w.direction[c.row] += a * dy[c.column];
        }
        for (i, e) in self.fuel.intersections().iter().enumerate() {
            let row = self.history_row(e.segment, 0);
            let dr = -dy[row + CONSUMED_235];
            let dt = -dy[row + CAPTURED_238] - dy[row + SF_238];
            for g in 0..GROUPS {
                let k = w.fuel.events()[i];
                let n = w.state[e.region * GROUPS + g];
                w.event_direction[i][0] +=
                    k.fission[g] * dy[e.region * GROUPS + g] + k.d_fission_d_reserve[g] * dr * n;
                w.event_direction[i][1] +=
                    k.capture[g] * dy[e.region * GROUPS + g] + k.d_capture_d_fertile[g] * dt * n;
                let df = k.d_fission_d_reserve[g] * dr;
                let dc = k.d_capture_d_fertile[g] * dt;
                self.add_fuel_coefficient_direction(
                    e.region,
                    e.segment,
                    g,
                    n,
                    df,
                    dc,
                    &mut w.direction,
                );
                w.collision_direction[e.region][g] += (df + dc) / self.fuel.law().speed[g];
            }
        }
        for d in w.fuel.thermal_derivatives() {
            let e = &self.fuel.intersections()[d.intersection];
            for g in 0..GROUPS {
                let dc = d.d_capture_d_temperature[g] * dtemperatures[d.cohort];
                let n = w.state[e.region * GROUPS + g];
                w.event_direction[d.intersection][1] += dc * n;
                w.direction[e.region * GROUPS + g] -= dc * n;
                w.collision_direction[e.region][g] += dc / self.fuel.law().speed[g];
            }
        }
        for (e, de) in self.fuel.intersections().iter().zip(&w.event_direction) {
            w.segment_direction[e.segment].induced_fission += de[0];
            w.segment_direction[e.segment].fertile_capture += de[1];
        }
        for (s, p) in self.segments.iter().enumerate() {
            let row = self.history_row(s, 0);
            let dh = &dy[row..row + HISTORY];
            let r = &mut w.segment_direction[s];
            r.sf235 = -p.sf235_neutrons_per_second
                / self.spontaneous_neutrons_per_event
                / p.reference_u235
                * dh[CONSUMED_235];
            r.sf238 = -p.sf238_neutrons_per_second
                / self.spontaneous_neutrons_per_event
                / p.reference_u238
                * (dh[CAPTURED_238] + dh[SF_238]);
            w.direction[row + CONSUMED_235] = r.induced_fission + r.sf235;
            w.direction[row + CAPTURED_238] = r.fertile_capture;
            w.direction[row + SF_238] = r.sf238;
            let heat = self
                .heat
                .rhs_into(
                    &dh[ENERGY..],
                    Rates {
                        fission: r.induced_fission + r.sf235 + r.sf238,
                        fertile_capture: r.fertile_capture,
                    },
                    &mut w.direction[row + ENERGY..row + HISTORY],
                )
                .map_err(|_| "Invalid fuel-history heat JVP")?;
            r.prompt_release = heat.prompt;
            r.delayed_release = heat.delayed;
        }
        for e in self.fuel.intersections() {
            let row = self.history_row(e.segment, 0);
            let h = &w.state[row..row + HISTORY];
            let dh = &dy[row..row + HISTORY];
            let weight = e.volume / self.volumes[e.segment];
            let scale = self.fuel.law().speed[6] * weight / self.fuel.volumes()[e.region];
            let cx = self.poison.xe_sigma_m2
                * scale
                * (h[XENON] * dy[e.region * GROUPS + 6]
                    + dh[XENON] * w.state[e.region * GROUPS + 6]);
            let cs = self.poison.sm_sigma_m2
                * scale
                * (h[SAMARIUM] * dy[e.region * GROUPS + 6]
                    + dh[SAMARIUM] * w.state[e.region * GROUPS + 6]);
            let r = &mut w.segment_direction[e.segment];
            r.xe_capture += cx;
            r.sm_capture += cs;
            w.direction[e.region * GROUPS + 6] -= cx + cs;
            w.collision_direction[e.region][6] += weight / self.fuel.volumes()[e.region]
                * (self.poison.xe_sigma_m2 * dh[XENON] + self.poison.sm_sigma_m2 * dh[SAMARIUM]);
            for g in 0..GROUPS {
                w.direction[e.region * GROUPS + g] += self.fuel.law().chi[g]
                    * self.spontaneous_neutrons_per_event
                    * (r.sf235 + r.sf238)
                    * weight;
            }
        }
        for s in 0..self.segments.len() {
            let row = self.history_row(s, 0);
            let dh = &dy[row..row + HISTORY];
            let r = w.segment_direction[s];
            let f = r.induced_fission + r.sf235 + r.sf238;
            w.direction[row + IODINE] = self.poison.yield_i * f - self.poison.lambda_i * dh[IODINE];
            w.direction[row + XENON] = self.poison.yield_xe * f + self.poison.lambda_i * dh[IODINE]
                - self.poison.lambda_xe * dh[XENON]
                - r.xe_capture;
            w.direction[row + PROMETHIUM] =
                self.poison.yield_pm * f - self.poison.lambda_pm * dh[PROMETHIUM];
            w.direction[row + SAMARIUM] = self.poison.lambda_pm * dh[PROMETHIUM] - r.sm_capture;
            w.direction[row + XENON_PRODUCT] = r.xe_capture;
            w.direction[row + SAMARIUM_PRODUCT] = r.sm_capture;
        }
        w.cf_direction = self.cf_rates(dy[self.cf_row()]);
        w.direction[self.cf_row()] = -w.cf_direction.paid_release;
        for &(region, weight) in &self.cf_support {
            for g in 0..GROUPS {
                w.direction[region * GROUPS + g] +=
                    self.fuel.law().chi[g] * weight * w.cf_direction.births;
            }
        }
        if w.direction
            .iter()
            .chain(w.collision_direction.iter().flatten())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite fuel-history JVP candidate");
        }
        w.direction_valid = true;
        Ok(())
    }
    fn add_fuel_coefficient_direction(
        &self,
        region: usize,
        segment: usize,
        g: usize,
        n: f64,
        df: f64,
        dc: f64,
        out: &mut [f64],
    ) {
        out[region * GROUPS + g] -= (df + dc) * n;
        let beta = self.fuel.law().beta.iter().sum::<f64>();
        for h in 0..GROUPS {
            out[region * GROUPS + h] +=
                self.fuel.law().chi[h] * (1. - beta) * self.fuel.law().nu[g] * df * n;
        }
        let c0 = self.fuel.volumes().len() * GROUPS + segment * DELAYED;
        for j in 0..DELAYED {
            out[c0 + j] += self.fuel.law().beta[j] * self.fuel.law().nu[g] * df * n;
        }
    }
}

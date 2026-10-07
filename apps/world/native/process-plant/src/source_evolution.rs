//! Birth-driven represented source at fixed ORIGINAL geometry/temperature.
//! All represented finite targets and fuel histories evolve. No thermal bath,
//! deposited-heat state, acquired detector, live plant or production-mesh claim.
//! IDA is external; this file owns reusable RHS/JVP and a sparse N/C
//! preconditioning block, never a second time integrator.
use crate::{
    cylindrical_source as cs, fuel_history as fh, fuel_source::GROUPS, moderator_source as ms,
    optical_source as os, passive_source as ps, transport_source as ts,
};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

#[derive(Clone, Copy, Debug)]
pub struct WaterOwner {
    pub hydrogen: f64,
    pub hydrogen_product: f64,
    pub boron: f64,
    pub boron_product: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct WaterRow {
    pub owner: usize,
    pub h_fraction: f64,
    pub b_fraction: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct MnTarget {
    pub target: usize,
    pub decay_rate: f64,
    pub electron_j: f64,
    pub photon_j: f64,
}
pub struct Input {
    pub history: fh::Assembly,
    pub temperatures: Vec<f64>,
    pub moderator: ms::ModeratorModel,
    pub water_rows: Vec<ms::Stocks>,
    pub water_owners: Vec<WaterOwner>,
    pub row_map: Vec<WaterRow>,
    pub targets: Vec<f64>,
    pub passive_stocks: Vec<ps::Stock>,
    pub passive_incidence: Vec<ps::Intersection>,
    pub cylinder_targets: Vec<cs::Target>,
    pub cylinder_incidence: Vec<cs::Intersection>,
    pub envelope_lengths: Vec<f64>,
    pub faces: Vec<ts::Face>,
    pub optical_layers: Vec<Vec<os::Layer>>,
    pub mn: Vec<MnTarget>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Diagnostics {
    pub neutrons: f64,
    pub precursors: f64,
    pub retained_energy_j: f64,
    pub fission_events_s: f64,
    pub net_neutron_events_s: f64,
    pub escape_neutrons_s: f64,
    pub collected_events_s: f64,
    pub induced_fission_events_s: f64,
    pub neutron_event_scale_s: f64,
    pub capture_events_s: f64,
    pub cf_births_s: f64,
    pub cf_release_w: f64,
    pub cf_export_w: f64,
    pub fuel_release_w: f64,
    pub mn_electron_release_w: f64,
    pub mn_photon_release_w: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Balances {
    pub neutron_ledger_defect: f64,
    pub neutron_ledger_scale: f64,
    pub energy_ledger_defect_j: f64,
    pub energy_ledger_scale_j: f64,
}
pub struct Evolution {
    input: Input,
    passive: ps::Model,
    cylinder: cs::Model,
    transport: ts::Model,
    optical: Vec<os::LayerModel>,
    initial_cf: f64,
    pattern: Vec<(usize, usize)>,
    lookup: HashMap<(usize, usize), usize>,
    owner: Arc<()>,
}
pub struct Workspace {
    history: fh::Workspace,
    moderator: ms::Workspace,
    passive: ps::Workspace,
    cylinder: cs::Workspace,
    transport: ts::Workspace,
    optical: Vec<os::LayerWorkspace>,
    optical_inputs: Vec<ts::OpticalInput>,
    history_state: Vec<f64>,
    history_direction: Vec<f64>,
    zero_temperature: Vec<f64>,
    state: Vec<f64>,
    rates: Vec<f64>,
    jvp: Vec<f64>,
    water: Vec<ms::Stocks>,
    amounts: Vec<f64>,
    amount_direction: Vec<f64>,
    collision: Vec<[f64; GROUPS]>,
    collision_direction: Vec<[f64; GROUPS]>,
    scratch: Vec<f64>,
    water_events: Vec<ms::Events>,
    passive_capture: Vec<f64>,
    cylinder_capture: Vec<[f64; GROUPS]>,
    optical_capture: Vec<[f64; GROUPS]>,
    collected: Vec<[f64; GROUPS]>,
    charged_escape: Vec<[f64; GROUPS]>,
    escape: [f64; GROUPS],
    diagnostics: Diagnostics,
    valid: bool,
    jvp_valid: bool,
    owner: Arc<()>,
    evaluation_serial: u64,
    stage_owner: Arc<()>,
    preconditioner_direction: Vec<f64>,
}
#[derive(Clone, Copy, Default)]
struct LocalFuel {
    fissile: f64,
    capture: f64,
    sf238: f64,
    xe: f64,
    sm: f64,
}
/// Fixed-current-stage local history blocks, NOT another physical model or
/// integrator. Off-owner optical and history→N/C feedback is omitted only in P.
pub struct HistoryPreconditioner {
    owner: Arc<()>,
    valid: bool,
    serial: u64,
    workspace_owner: Option<Arc<()>>,
    cj: f64,
    nc: usize,
    n: usize,
    cf: usize,
    cf_decay: f64,
    cf_column: Vec<f64>,
    fuel: Vec<LocalFuel>,
    loss: Vec<f64>,
    optical: Vec<os::LayerWorkspace>,
    target_direction: Vec<f64>,
    target_collision: HashMap<(usize, usize), [f64; GROUPS]>,
}
impl HistoryPreconditioner {
    /// Cf spent energy leads the block ordering. Its signed neutron forcing is
    /// negative: more spent energy means fewer remaining source births.
    pub fn prepare_nc_rhs(&self, rhs: &[f64], out: &mut [f64]) -> Result<f64, &'static str> {
        if !self.valid
            || rhs.len() != self.n
            || out.len() != self.nc
            || rhs.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid prepared Cf/N-C preconditioner input");
        }
        let cf = rhs[self.cf] / (self.cj + self.cf_decay);
        for i in 0..self.nc {
            out[i] = rhs[i] + self.cf_column[i] * cf;
        }
        if !cf.is_finite() || out.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite prepared Cf/N-C forcing");
        }
        Ok(cf)
    }
}
impl Workspace {
    pub fn rates(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.rates)
    }
    pub fn rate_jvp(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("Invalid source JVP candidate");
        }
        Ok(&self.jvp)
    }
    pub fn diagnostics(&self) -> Result<Diagnostics, &'static str> {
        self.check()?;
        Ok(self.diagnostics)
    }
    fn check(&self) -> Result<(), &'static str> {
        if self.valid {
            Ok(())
        } else {
            Err("Invalid source evolution candidate")
        }
    }
    /// Explicit retained payload estimate only; excludes model/factors/allocator.
    pub fn buffer_bytes(&self) -> usize {
        self.history.buffer_bytes()
            + self.moderator.buffer_bytes()
            + self.passive.buffer_bytes()
            + self.cylinder.buffer_bytes()
            + self.transport.buffer_bytes()
            + self
                .optical
                .iter()
                .map(os::LayerWorkspace::buffer_bytes)
                .sum::<usize>()
            + self
                .optical_inputs
                .iter()
                .map(|v| {
                    (v.from_left.len() + v.from_right.len()) * std::mem::size_of::<[f64; GROUPS]>()
                })
                .sum::<usize>()
            + (self.history_state.len()
                + self.history_direction.len()
                + self.preconditioner_direction.len()
                + self.zero_temperature.len()
                + self.state.len()
                + self.rates.len()
                + self.jvp.len()
                + self.amounts.len()
                + self.amount_direction.len()
                + self.scratch.len()
                + self.passive_capture.len())
                * 8
            + (self.collision.len()
                + self.collision_direction.len()
                + self.cylinder_capture.len()
                + self.optical_capture.len()
                + self.collected.len()
                + self.charged_escape.len())
                * std::mem::size_of::<[f64; GROUPS]>()
            + self.water.len() * std::mem::size_of::<ms::Stocks>()
            + self.water_events.len() * std::mem::size_of::<ms::Events>()
    }
}
fn nn(x: f64) -> bool {
    x.is_finite() && x >= 0.
}
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 4e-11 * a.abs().max(b.abs()).max(1e-30)
}
impl Evolution {
    pub fn new(input: Input) -> Result<Self, &'static str> {
        let v = input.history.fuel().volumes();
        let speed = input.history.fuel().law().speed;
        if input.moderator.volumes() != v
            || input.moderator.law().speed != speed
            || input.water_rows.len() != input.row_map.len()
            || input.row_map.len() != input.moderator.intersections().len()
            || input.water_owners.is_empty()
            || input.temperatures.len() != input.history.fuel().cohorts().len()
            || input
                .temperatures
                .iter()
                .any(|t| !t.is_finite() || !(290. ..=2000.).contains(t))
            || input.targets.iter().any(|&x| !nn(x))
        {
            return Err("Invalid source evolution owner map");
        }
        let mut hs = vec![0.; input.water_owners.len()];
        let mut bs = hs.clone();
        for (r, m) in input.water_rows.iter().zip(&input.row_map) {
            if m.owner >= hs.len() || !nn(m.h_fraction) || !nn(m.b_fraction) {
                return Err("Invalid water owner incidence");
            }
            let o = input.water_owners[m.owner];
            if ![o.hydrogen, o.hydrogen_product, o.boron, o.boron_product]
                .iter()
                .all(|&x| nn(x))
                || o.hydrogen <= 0.
                || !close(r.hydrogen_target, m.h_fraction * o.hydrogen)
                || !close(r.hydrogen_product, m.h_fraction * o.hydrogen_product)
                || !close(r.mobile_boron10, m.b_fraction * o.boron)
            {
                return Err("Water owner totals/fractions mismatch");
            }
            hs[m.owner] += m.h_fraction;
            bs[m.owner] += m.b_fraction;
        }
        if hs
            .iter()
            .chain(&bs)
            .any(|x| !x.is_finite() || *x > 1. + 4e-11)
        {
            return Err("Water source incidence exceeds full owner");
        }
        let mut seen = BTreeSet::new();
        for m in &input.mn {
            if m.target >= input.targets.len()
                || !seen.insert(m.target)
                || !m.decay_rate.is_finite()
                || m.decay_rate <= 0.
                || !nn(m.electron_j)
                || !nn(m.photon_j)
            {
                return Err("Invalid retained Mn56 owner");
            }
        }
        let passive = ps::Model::new(
            v.to_vec(),
            speed,
            input.passive_stocks.clone(),
            input.passive_incidence.clone(),
            input.targets.len(),
        )?;
        let cylinder = cs::Model::new(
            v.to_vec(),
            speed,
            input.cylinder_targets.clone(),
            input.cylinder_incidence.clone(),
            input.targets.len(),
        )?;
        let transport = ts::Model::new(
            v.to_vec(),
            input.envelope_lengths.clone(),
            speed,
            input.faces.clone(),
            input.targets.len(),
        )?;
        let optical = input
            .optical_layers
            .iter()
            .map(|l| os::LayerModel::new(l, &input.targets))
            .collect::<Result<Vec<_>, _>>()?;
        let optical_faces = input
            .faces
            .iter()
            .filter_map(|f| {
                if let ts::FaceLaw::Optical { targets } = &f.law {
                    Some(targets)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if optical_faces.len() != optical.len()
            || optical
                .iter()
                .zip(optical_faces)
                .any(|(m, t)| !m.targets().eq(t.iter().copied()))
        {
            return Err("Optical face/target order mismatch");
        }
        let initial = input.history.initial_state();
        let initial_cf = initial[input.history.cf_row()];
        let mut entries = BTreeSet::new();
        let nc = input.history.fuel_dimension();
        for c in input.history.fuel().coordinates() {
            entries.insert((c.row, c.column));
        }
        for c in transport.coordinates() {
            entries.insert((c.row, c.column));
        }
        for r in 0..v.len() {
            for g in 0..GROUPS {
                for h in 0..GROUPS {
                    entries.insert((r * GROUPS + h, r * GROUPS + g));
                }
            }
        }
        for j in 0..nc {
            entries.insert((j, j));
        }
        let pattern = entries.into_iter().collect::<Vec<_>>();
        let lookup = pattern.iter().enumerate().map(|(i, c)| (*c, i)).collect();
        let result = Self {
            input,
            passive,
            cylinder,
            transport,
            optical,
            initial_cf,
            pattern,
            lookup,
            owner: Arc::new(()),
        };
        result
            .history_dimension()
            .checked_add(
                result
                    .input
                    .water_owners
                    .len()
                    .checked_mul(2)
                    .ok_or("Source size overflow")?,
            )
            .and_then(|n| n.checked_add(result.input.targets.len()))
            .and_then(|n| n.checked_add(result.input.mn.len()))
            .and_then(|n| n.checked_add(4))
            .ok_or("Source size overflow")?;
        Ok(result)
    }
    pub fn nc_dimension(&self) -> usize {
        self.input.history.fuel_dimension()
    }
    pub fn history_dimension(&self) -> usize {
        self.input.history.state_count()
    }
    pub fn water_row(&self, i: usize, boron: bool) -> usize {
        self.history_dimension() + 2 * i + usize::from(boron)
    }
    pub fn target_row(&self, i: usize) -> usize {
        self.history_dimension() + 2 * self.input.water_owners.len() + i
    }
    pub fn mn_row(&self, i: usize) -> usize {
        self.target_row(self.input.targets.len()) + i
    }
    pub fn ledger_row(&self) -> usize {
        self.mn_row(self.input.mn.len())
    }
    pub fn escape_row(&self) -> usize {
        self.ledger_row() + 1
    }
    pub fn collected_row(&self) -> usize {
        self.ledger_row() + 2
    }
    pub fn fuel_release_row(&self) -> usize {
        self.ledger_row() + 3
    }
    pub fn state_count(&self) -> usize {
        self.ledger_row() + 4
    }
    pub fn region_count(&self) -> usize {
        self.input.history.fuel().volumes().len()
    }
    pub fn segment_count(&self) -> usize {
        self.input.history.fuel().segment_count()
    }
    pub fn cf_decay_rate(&self) -> f64 {
        self.input.history.cf_decay_rate()
    }
    pub fn cf_row(&self) -> usize {
        self.input.history.cf_row()
    }
    pub fn prepared_cf_energy(&self) -> f64 {
        self.initial_cf
    }
    pub fn energy_rows(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.input.history.fuel().segment_count())
            .flat_map(move |s| {
                (fh::ENERGY..fh::HISTORY).map(move |j| self.input.history.history_row(s, j))
            })
            .chain([self.cf_row(), self.fuel_release_row()])
    }
    pub fn is_energy_row(&self, row: usize) -> bool {
        row == self.cf_row()
            || row == self.fuel_release_row()
            || (row >= self.nc_dimension()
                && row < self.cf_row()
                && (row - self.nc_dimension()) % fh::HISTORY >= fh::ENERGY)
    }
    pub fn conservation(&self, y: &[f64]) -> Result<Balances, &'static str> {
        if y.len() != self.state_count() || y.iter().any(|x| !x.is_finite()) {
            return Err("Invalid source conservation state");
        }
        let count = y[..self.nc_dimension()].iter().sum::<f64>();
        let mut stored = 0.;
        let mut paid = 0.;
        let capture_energy = self
            .input
            .history
            .energy_groups()
            .iter()
            .filter(|g| matches!(g.feed, crate::heat_history::Feed::FertileCapture))
            .map(|g| g.energy_per_event)
            .sum::<f64>();
        for s in 0..self.segment_count() {
            let o = self.input.history.history_row(s, 0);
            stored += y[o + fh::ENERGY..o + fh::HISTORY].iter().sum::<f64>();
            paid += self.input.history.fission_energy()
                * (y[o + fh::CONSUMED_235] + y[o + fh::SF_238])
                + capture_energy * y[o + fh::CAPTURED_238];
        }
        Ok(Balances {
            neutron_ledger_defect: count - y[self.ledger_row()],
            neutron_ledger_scale: count.abs()
                + y[self.ledger_row()].abs()
                + y[self.escape_row()].abs(),
            energy_ledger_defect_j: stored + y[self.fuel_release_row()] - paid,
            energy_ledger_scale_j: stored.abs() + y[self.fuel_release_row()].abs() + paid.abs(),
        })
    }
    pub fn initial_state(&self) -> Vec<f64> {
        let mut y = self.input.history.initial_state();
        y[self.cf_row()] = 0.;
        y.resize(self.state_count(), 0.);
        y
    }
    pub fn nc_pattern(&self) -> &[(usize, usize)] {
        &self.pattern
    }
    pub fn workspace(&self) -> Workspace {
        let n = self.input.history.fuel().volumes().len() * GROUPS;
        let nt = self.input.targets.len();
        let optical = self
            .optical
            .iter()
            .map(|m| m.workspace())
            .collect::<Vec<_>>();
        let optical_inputs = optical.iter().map(|w| w.input.clone()).collect();
        Workspace {
            history: self.input.history.workspace(),
            moderator: self.input.moderator.workspace(),
            passive: self.passive.workspace(),
            cylinder: self.cylinder.workspace(),
            transport: self.transport.workspace(),
            optical,
            optical_inputs,
            history_state: vec![0.; self.history_dimension()],
            history_direction: vec![0.; self.history_dimension()],
            zero_temperature: vec![0.; self.input.temperatures.len()],
            state: vec![0.; self.state_count()],
            rates: vec![0.; self.state_count()],
            jvp: vec![0.; self.state_count()],
            water: self.input.water_rows.clone(),
            amounts: vec![0.; nt],
            amount_direction: vec![0.; nt],
            collision: vec![[0.; GROUPS]; n / GROUPS],
            collision_direction: vec![[0.; GROUPS]; n / GROUPS],
            scratch: vec![0.; n],
            water_events: vec![ms::Events::default(); self.input.water_rows.len()],
            passive_capture: vec![0.; nt],
            cylinder_capture: vec![[0.; GROUPS]; nt],
            optical_capture: vec![[0.; GROUPS]; nt],
            collected: vec![[0.; GROUPS]; nt],
            charged_escape: vec![[0.; GROUPS]; nt],
            escape: [0.; GROUPS],
            diagnostics: Diagnostics::default(),
            valid: false,
            jvp_valid: false,
            owner: self.owner.clone(),
            evaluation_serial: 0,
            stage_owner: Arc::new(()),
            preconditioner_direction: vec![0.; self.state_count()],
        }
    }
    pub fn validate_accepted_state(&self, y: &[f64]) -> Result<(), String> {
        if y.len() != self.state_count() {
            return Err(format!(
                "Accepted source dimension {} != {}",
                y.len(),
                self.state_count()
            ));
        }
        if let Some((row, value)) = y
            .iter()
            .enumerate()
            .find(|(i, x)| !x.is_finite() || (**x < 0. && *i != self.ledger_row()))
        {
            return Err(format!(
                "Nonphysical accepted source coordinate row={row},value={value:e}"
            ));
        }
        // Spent Cf and remaining Cf have the SAME [0,Eprep] physical bounds;
        // all other history coordinates are identical. No per-screen copying.
        self.input
            .history
            .validate_accepted_state(&y[..self.history_dimension()])
            .map_err(|e| format!("Fuel-history accepted boundary: {e}"))?;
        for (i, o) in self.input.water_owners.iter().enumerate() {
            if y[self.water_row(i, false)] > o.hydrogen || y[self.water_row(i, true)] > o.boron {
                return Err(format!(
                    "Exhausted accepted water owner={i},Hprogress={:e},Hreference={:e},Bprogress={:e},Breference={:e}",
                    y[self.water_row(i, false)],
                    o.hydrogen,
                    y[self.water_row(i, true)],
                    o.boron
                ));
            }
        }
        for (i, &a) in self.input.targets.iter().enumerate() {
            if y[self.target_row(i)] > a {
                return Err(format!(
                    "Exhausted accepted passive target={i},row={},progress={:e},reference={a:e}",
                    self.target_row(i),
                    y[self.target_row(i)]
                ));
            }
        }
        for (i, m) in self.input.mn.iter().enumerate() {
            if y[self.mn_row(i)] > y[self.target_row(m.target)] {
                return Err(format!(
                    "Negative accepted Mn56 owner={i},target={},captured={:e},decayed={:e}",
                    m.target,
                    y[self.target_row(m.target)],
                    y[self.mn_row(i)]
                ));
            }
        }
        Ok(())
    }
    pub fn evaluate_into(&self, y: &[f64], w: &mut Workspace) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() != self.state_count()
            || y.iter().any(|x| !x.is_finite())
        {
            w.valid = false;
            w.jvp_valid = false;
            return Err("Invalid source trial/workspace");
        }
        // Reuse only the complete, bit-identical dependency vector of this
        // valid workspace. IDA residual/JT setup commonly request that same
        // state. Pointer identity, approximate equality and failed trials are
        // not cache keys. Independent P-stage workspaces remain independent.
        if w.valid
            && y.iter()
                .zip(&w.state)
                .all(|(a, b)| a.to_bits() == b.to_bits())
        {
            return Ok(());
        }
        w.valid = false;
        w.jvp_valid = false;
        let n = self.input.history.fuel().volumes().len() * GROUPS;
        let volumes = self.input.history.fuel().volumes();
        w.history_state
            .copy_from_slice(&y[..self.history_dimension()]);
        w.history_state[self.cf_row()] = self.initial_cf - y[self.cf_row()];
        self.input.history.evaluate_into(
            &self.input.temperatures,
            &w.history_state,
            &mut w.history,
        )?;
        w.rates.fill(0.);
        w.rates[..self.history_dimension()].copy_from_slice(w.history.rates()?);
        w.rates[self.cf_row()] = -w.rates[self.cf_row()];
        w.collision.copy_from_slice(w.history.collision()?);
        for (i, (r, m)) in self
            .input
            .water_rows
            .iter()
            .zip(&self.input.row_map)
            .enumerate()
        {
            w.water[i].hydrogen_target =
                r.hydrogen_target - m.h_fraction * y[self.water_row(m.owner, false)];
            w.water[i].hydrogen_product =
                r.hydrogen_product + m.h_fraction * y[self.water_row(m.owner, false)];
            w.water[i].mobile_boron10 =
                r.mobile_boron10 - m.b_fraction * y[self.water_row(m.owner, true)];
        }
        self.input.moderator.update(&w.water, &mut w.moderator)?;
        self.input
            .moderator
            .apply(&w.moderator, &y[..n], &mut w.scratch, &mut w.water_events)?;
        for i in 0..n {
            w.rates[i] += w.scratch[i];
        }
        for (i, m) in self.input.row_map.iter().enumerate() {
            w.rates[self.water_row(m.owner, false)] += w.water_events[i].hydrogen;
            w.rates[self.water_row(m.owner, true)] += w.water_events[i].boron;
        }
        self.input
            .moderator
            .collision_into(&w.moderator, &mut w.collision_direction)?;
        for r in 0..volumes.len() {
            for g in 0..GROUPS {
                w.collision[r][g] += w.collision_direction[r][g];
            }
        }
        for (i, &a) in self.input.targets.iter().enumerate() {
            w.amounts[i] = a - y[self.target_row(i)];
        }
        self.passive.update(&w.amounts, &mut w.passive)?;
        w.passive_capture.fill(0.);
        w.scratch.fill(0.);
        self.passive
            .apply(&w.passive, &y[..n], &mut w.scratch, &mut w.passive_capture)?;
        for i in 0..n {
            w.rates[i] += w.scratch[i];
        }
        for (i, &c) in w.passive_capture.iter().enumerate() {
            w.rates[self.target_row(i)] += c;
        }
        let pc = w.passive.collision()?;
        for r in 0..volumes.len() {
            for g in 0..GROUPS {
                w.collision[r][g] += pc[r][g];
            }
        }
        self.cylinder.update(&w.amounts, &mut w.cylinder)?;
        self.cylinder.apply(
            &w.cylinder,
            &y[..n],
            &mut w.scratch,
            &mut w.cylinder_capture,
            &mut w.collected,
            &mut w.charged_escape,
        )?;
        for i in 0..n {
            w.rates[i] += w.scratch[i];
        }
        for i in 0..self.input.targets.len() {
            w.rates[self.target_row(i)] += w.cylinder_capture[i].iter().sum::<f64>();
        }
        let cc = w.cylinder.collision()?;
        for r in 0..volumes.len() {
            for g in 0..GROUPS {
                w.collision[r][g] += cc[r][g];
            }
        }
        for (i, m) in self.optical.iter().enumerate() {
            m.update_dependencies(&w.amounts, &mut w.optical[i])?;
            let a = &w.optical[i].input;
            w.optical_inputs[i].transmission = a.transmission;
            w.optical_inputs[i].loss = a.loss;
            w.optical_inputs[i].from_left.copy_from_slice(&a.from_left);
            w.optical_inputs[i]
                .from_right
                .copy_from_slice(&a.from_right);
        }
        self.transport
            .update(&w.collision, &w.optical_inputs, &mut w.transport)?;
        self.transport.apply(
            &w.transport,
            &y[..n],
            &mut w.scratch,
            &mut w.optical_capture,
            &mut w.escape,
        )?;
        for i in 0..n {
            w.rates[i] += w.scratch[i];
        }
        for i in 0..self.input.targets.len() {
            w.rates[self.target_row(i)] += w.optical_capture[i].iter().sum::<f64>();
        }
        let mut d = Diagnostics::default();
        d.neutrons = y[..n].iter().sum();
        d.precursors = y[n..self.nc_dimension()].iter().sum();
        for s in 0..self.input.history.fuel().segment_count() {
            let row = self.input.history.history_row(s, fh::ENERGY);
            d.retained_energy_j += y[row..row + 25].iter().sum::<f64>();
        }
        for (e, k) in self
            .input
            .history
            .fuel()
            .intersections()
            .iter()
            .zip(w.history.fuel_events()?)
        {
            for g in 0..GROUPS {
                d.net_neutron_events_s += (self.input.history.fuel().law().nu[g] - 1.)
                    * k.fission[g]
                    * y[e.region * GROUPS + g];
                d.neutron_event_scale_s += (self.input.history.fuel().law().nu[g] + 1.)
                    * (k.fission[g] * y[e.region * GROUPS + g]).abs();
            }
        }
        for s in w.history.segments()? {
            d.induced_fission_events_s += s.induced_fission;
            d.fission_events_s += s.induced_fission + s.sf235 + s.sf238;
            d.fuel_release_w += s.prompt_release + s.delayed_release;
            d.net_neutron_events_s += self.input.history.spontaneous_neutrons_per_event()
                * (s.sf235 + s.sf238)
                - s.fertile_capture
                - s.xe_capture
                - s.sm_capture;
            d.neutron_event_scale_s += self.input.history.spontaneous_neutrons_per_event()
                * (s.sf235.abs() + s.sf238.abs())
                + s.fertile_capture.abs()
                + s.xe_capture.abs()
                + s.sm_capture.abs();
        }
        let cf = w.history.cf()?;
        d.cf_births_s = cf.births;
        d.cf_release_w = cf.paid_release;
        d.cf_export_w = cf.birth_export;
        d.net_neutron_events_s += cf.births;
        d.neutron_event_scale_s += cf.births.abs();
        for e in &w.water_events {
            d.capture_events_s += e.hydrogen + e.boron;
            d.neutron_event_scale_s += e.hydrogen.abs() + e.boron.abs();
        }
        d.capture_events_s += w.passive_capture.iter().sum::<f64>()
            + w.cylinder_capture.iter().flatten().sum::<f64>()
            + w.optical_capture.iter().flatten().sum::<f64>();
        d.escape_neutrons_s = w.escape.iter().sum();
        d.collected_events_s = w.collected.iter().flatten().sum();
        d.net_neutron_events_s -= d.capture_events_s + d.escape_neutrons_s;
        d.neutron_event_scale_s += w.passive_capture.iter().map(|v| v.abs()).sum::<f64>()
            + w.cylinder_capture
                .iter()
                .flatten()
                .map(|v| v.abs())
                .sum::<f64>()
            + w.optical_capture
                .iter()
                .flatten()
                .map(|v| v.abs())
                .sum::<f64>()
            + w.escape.iter().map(|v| v.abs()).sum::<f64>();
        for (i, m) in self.input.mn.iter().enumerate() {
            let decay = m.decay_rate * (y[self.target_row(m.target)] - y[self.mn_row(i)]);
            w.rates[self.mn_row(i)] = decay;
            d.mn_electron_release_w += m.electron_j * decay;
            d.mn_photon_release_w += m.photon_j * decay;
        }
        w.rates[self.ledger_row()] = d.net_neutron_events_s;
        w.rates[self.escape_row()] = d.escape_neutrons_s;
        w.rates[self.collected_row()] = d.collected_events_s;
        w.rates[self.fuel_release_row()] = d.fuel_release_w;
        if w.rates.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite represented source candidate");
        }
        w.state.copy_from_slice(y);
        w.diagnostics = d;
        w.evaluation_serial = w
            .evaluation_serial
            .checked_add(1)
            .ok_or("Source evaluation serial exhausted")?;
        w.valid = true;
        Ok(())
    }
    /// Full analytic represented-source direction. Only preconditioning, not
    /// this derivative, omits N/C↔material and inter-target optical couplings.
    pub fn jvp_into(&self, dy: &[f64], w: &mut Workspace) -> Result<(), &'static str> {
        self.jvp_selected::<false>(dy, w)
    }
    /// INCOMING is private to P: its direction contains N/C and Cf only and
    /// only history/escape/collection/release rows are consumed. Share the
    /// actual event derivatives, but do not calculate a discarded spatial
    /// transport field or zero material/optical partials on every P solve.
    fn jvp_selected<const INCOMING: bool>(
        &self,
        dy: &[f64],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.jvp_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || dy.len() != self.state_count()
            || dy.iter().any(|x| !x.is_finite())
        {
            return Err("Invalid source JVP trial/workspace");
        }
        let volumes = self.input.history.fuel().volumes();
        let speed = self.input.history.fuel().law().speed;
        w.history_direction
            .copy_from_slice(&dy[..self.history_dimension()]);
        w.history_direction[self.cf_row()] = -dy[self.cf_row()];
        self.input
            .history
            .jvp_into(&w.zero_temperature, &w.history_direction, &mut w.history)?;
        w.jvp.fill(0.);
        w.jvp[..self.history_dimension()].copy_from_slice(w.history.rate_jvp()?);
        w.jvp[self.cf_row()] = -w.jvp[self.cf_row()];
        w.collision_direction
            .copy_from_slice(w.history.collision_jvp()?);
        let mut net = w.jvp[..self.nc_dimension()].iter().sum::<f64>();
        let mut escape = 0.;
        let mut collected = 0.;
        for r in 0..if INCOMING { 0 } else { self.region_count() } {
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    w.jvp[r * GROUPS + h] +=
                        w.moderator.coefficients()?[r * 49 + h * 7 + g] * dy[r * GROUPS + g];
                }
            }
        }
        for (i, (e, m)) in self
            .input
            .moderator
            .intersections()
            .iter()
            .zip(&self.input.row_map)
            .enumerate()
        {
            let c = w.moderator.rows()?[i];
            let dh = dy[self.water_row(m.owner, false)] * m.h_fraction;
            let db = dy[self.water_row(m.owner, true)] * m.b_fraction;
            let mut eh = 0.;
            let mut eb = 0.;
            for g in 0..GROUPS {
                let a = (c.d_hydrogen_d_product[g] - c.d_hydrogen_d_target[g]) * dh;
                let b = -c.d_boron_d_atoms[g] * db;
                let pos = e.region * GROUPS + g;
                let ch = a * w.state[pos] + c.hydrogen[g] * dy[pos];
                let cb = b * w.state[pos] + c.boron[g] * dy[pos];
                eh += ch;
                eb += cb;
                w.jvp[pos] -= (a + b) * w.state[pos];
                w.collision_direction[e.region][g] += (a + b) / speed[g];
            }
            w.jvp[self.water_row(m.owner, false)] += eh;
            w.jvp[self.water_row(m.owner, true)] += eb;
            net -= eh + eb;
        }
        for i in 0..self.input.targets.len() {
            w.amount_direction[i] = -dy[self.target_row(i)];
        }
        for e in &self.input.passive_incidence {
            let s = &self.input.passive_stocks[e.stock];
            for t in &s.targets {
                for g in 0..GROUPS {
                    let factor = t.sigma_m2[g] * e.volume / s.volume / volumes[e.region];
                    let pos = e.region * GROUPS + g;
                    let dcap = speed[g]
                        * factor
                        * (w.amounts[t.index] * dy[pos]
                            + w.amount_direction[t.index] * w.state[pos]);
                    w.jvp[pos] -= dcap;
                    w.jvp[self.target_row(t.index)] += dcap;
                    net -= dcap;
                    w.collision_direction[e.region][g] += factor * w.amount_direction[t.index];
                }
            }
        }
        for e in &self.input.cylinder_incidence {
            let t = &self.input.cylinder_targets[e.target];
            let c = w.cylinder.responses()?[e.target];
            for g in 0..GROUPS {
                let pos = e.region * GROUPS + g;
                let factor = e.share * speed[g] / volumes[e.region];
                let da = w.amount_direction[t.index];
                let dcap = factor
                    * (c.capture_m2[g] * dy[pos] + c.d_capture_d_amount[g] * da * w.state[pos]);
                w.jvp[pos] -= dcap;
                w.jvp[self.target_row(t.index)] += dcap;
                net -= dcap;
                collected += factor
                    * (c.collected_m2[g] * dy[pos] + c.d_collected_d_amount[g] * da * w.state[pos]);
                w.collision_direction[e.region][g] +=
                    e.share / volumes[e.region] * c.d_capture_d_amount[g] * da;
            }
        }
        if !INCOMING {
            for (i, m) in self.optical.iter().enumerate() {
                m.jvp_dependencies(&w.amount_direction, &mut w.optical[i])?;
            }
        }
        let mut oi = 0;
        for (f, coeff) in self
            .input
            .faces
            .iter()
            .zip(w.transport.face_coefficients()?)
        {
            if INCOMING && f.right.is_some() && !matches!(f.law, ts::FaceLaw::Optical { .. }) {
                continue;
            }
            for g in 0..GROUPS {
                let l = f.left * GROUPS + g;
                let pl = speed[g] * w.state[l] / volumes[f.left];
                let dpl = speed[g] * dy[l] / volumes[f.left];
                let dt = if !INCOMING && matches!(f.law, ts::FaceLaw::Optical { .. }) {
                    w.optical[oi].transmission_jvp[g]
                } else {
                    0.
                };
                let direction = [
                    w.collision_direction[f.left][g],
                    f.right.map_or(0., |r| w.collision_direction[r][g]),
                    dt,
                ];
                let dc = |s: ts::Scalar| {
                    s.derivatives
                        .iter()
                        .zip(direction)
                        .map(|(a, b)| a * b)
                        .sum::<f64>()
                };
                let c = coeff[g];
                if let Some(r) = f.right {
                    let pos = r * GROUPS + g;
                    let pr = speed[g] * w.state[pos] / volumes[r];
                    let dpr = speed[g] * dy[pos] / volumes[r];
                    let exchange = dc(c.exchange) * (pr - pl) + c.exchange.value * (dpr - dpl);
                    let capl = dc(c.capture_left) * pl + c.capture_left.value * dpl;
                    let capr = dc(c.capture_right) * pr + c.capture_right.value * dpr;
                    w.jvp[l] += exchange - capl;
                    w.jvp[pos] -= exchange + capr;
                    net -= capl + capr;
                    if let ts::FaceLaw::Optical { targets } = &f.law {
                        let o = &w.optical[oi];
                        let rl = c.capture_per_loss_left;
                        let rr = c.capture_per_loss_right;
                        for (j, &target) in targets.iter().enumerate() {
                            w.jvp[self.target_row(target)] += if INCOMING {
                                rl.value * dpl * o.left_loss[j][g]
                                    + rr.value * dpr * o.right_loss[j][g]
                            } else {
                                (dc(rl) * pl + rl.value * dpl) * o.left_loss[j][g]
                                    + rl.value * pl * o.left_loss_jvp[j][g]
                                    + (dc(rr) * pr + rr.value * dpr) * o.right_loss[j][g]
                                    + rr.value * pr * o.right_loss_jvp[j][g]
                            };
                        }
                    }
                } else {
                    let value = dc(c.escape) * pl + c.escape.value * dpl;
                    w.jvp[l] -= value;
                    net -= value;
                    escape += value;
                }
            }
            if matches!(f.law, ts::FaceLaw::Optical { .. }) {
                oi += 1;
            }
        }
        for (i, m) in self.input.mn.iter().enumerate() {
            w.jvp[self.mn_row(i)] =
                m.decay_rate * (dy[self.target_row(m.target)] - dy[self.mn_row(i)]);
        }
        w.jvp[self.ledger_row()] = net;
        w.jvp[self.escape_row()] = escape;
        w.jvp[self.collected_row()] = collected;
        w.jvp[self.fuel_release_row()] = w
            .history
            .segment_jvp()?
            .iter()
            .map(|r| r.prompt_release + r.delayed_release)
            .sum();
        if w.jvp.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite full source JVP");
        }
        w.jvp_valid = !INCOMING;
        Ok(())
    }
    pub fn nc_values(&self, w: &Workspace, cj: f64, out: &mut [f64]) -> Result<(), &'static str> {
        w.check()?;
        if out.len() != self.pattern.len() || !cj.is_finite() || cj <= 0. {
            return Err("Invalid N/C preconditioner output");
        }
        out.fill(0.);
        let volumes = self.input.history.fuel().volumes();
        let speed = self.input.history.fuel().law().speed;
        for (c, &a) in self
            .input
            .history
            .fuel()
            .coordinates()
            .iter()
            .zip(w.history.fuel_coefficients()?)
        {
            out[self.lookup[&(c.row, c.column)]] -= a;
        }
        for (c, &a) in self
            .transport
            .coordinates()
            .iter()
            .zip(w.transport.coefficients()?)
        {
            out[self.lookup[&(c.row, c.column)]] -= a;
        }
        let p = self.input.history.poison_law();
        for e in self.input.history.fuel().intersections() {
            let o = self.input.history.history_row(e.segment, 0);
            let k = speed[6] * e.volume
                / self.input.history.segment_volumes()[e.segment]
                / volumes[e.region]
                * (p.xe_sigma_m2 * w.state[o + fh::XENON]
                    + p.sm_sigma_m2 * w.state[o + fh::SAMARIUM]);
            out[self.lookup[&(e.region * GROUPS + 6, e.region * GROUPS + 6)]] += k;
        }
        for r in 0..volumes.len() {
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    out[self.lookup[&(r * GROUPS + h, r * GROUPS + g)]] -=
                        w.moderator.coefficients()?[r * 49 + h * 7 + g];
                }
            }
        }
        for e in &self.input.passive_incidence {
            let s = &self.input.passive_stocks[e.stock];
            for t in &s.targets {
                for g in 0..GROUPS {
                    let k = speed[g] * t.sigma_m2[g] * w.amounts[t.index] * e.volume
                        / s.volume
                        / volumes[e.region];
                    out[self.lookup[&(e.region * GROUPS + g, e.region * GROUPS + g)]] += k;
                }
            }
        }
        for e in &self.input.cylinder_incidence {
            for g in 0..GROUPS {
                let k = speed[g] * w.cylinder.responses()?[e.target].capture_m2[g] * e.share
                    / volumes[e.region];
                out[self.lookup[&(e.region * GROUPS + g, e.region * GROUPS + g)]] += k;
            }
        }
        for i in 0..self.nc_dimension() {
            out[self.lookup[&(i, i)]] += cj;
        }
        if out.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite N/C preconditioner");
        }
        Ok(())
    }
    pub fn history_preconditioner(&self) -> HistoryPreconditioner {
        let nc = self.nc_dimension();
        let cf = self.input.history.cf_law();
        let mut column = vec![0.; nc];
        for &(r, weight) in self.input.history.cf_support() {
            for g in 0..GROUPS {
                column[r * GROUPS + g] -= self.input.history.fuel().law().chi[g]
                    * weight
                    * cf.initial_neutrons_per_second
                    / cf.initial_energy_j;
            }
        }
        HistoryPreconditioner {
            owner: self.owner.clone(),
            valid: false,
            serial: 0,
            workspace_owner: None,
            cj: 0.,
            nc,
            n: self.state_count(),
            cf: self.cf_row(),
            cf_decay: cf.decay_rate,
            cf_column: column,
            fuel: vec![LocalFuel::default(); self.segment_count()],
            loss: vec![0.; self.state_count() - nc],
            optical: self.optical.iter().map(|m| m.workspace()).collect(),
            target_direction: vec![0.; self.input.targets.len()],
            target_collision: HashMap::new(),
        }
    }
    /// Fixed-current-stage local fuel/poison/energy, water and target blocks.
    /// Optical target self partials are retained; off-target partials are not.
    pub fn prepare_history_preconditioner(
        &self,
        w: &Workspace,
        cj: f64,
        p: &mut HistoryPreconditioner,
    ) -> Result<(), &'static str> {
        p.valid = false;
        w.check()?;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !Arc::ptr_eq(&self.owner, &p.owner)
            || !cj.is_finite()
            || cj <= 0.
        {
            return Err("Invalid local history preconditioner stage/workspace");
        }
        p.cj = cj;
        p.serial = w.evaluation_serial;
        p.workspace_owner = Some(w.stage_owner.clone());
        p.fuel.fill(LocalFuel::default());
        p.loss.fill(0.);
        p.target_collision.clear();
        let volumes = self.input.history.fuel().volumes();
        let speed = self.input.history.fuel().law().speed;
        let poison = self.input.history.poison_law();
        for s in 0..self.segment_count() {
            let (a, b) = self.input.history.spontaneous_rate_derivatives(s)?;
            p.fuel[s].fissile = a;
            p.fuel[s].sf238 = b;
        }
        for (e, k) in self
            .input
            .history
            .fuel()
            .intersections()
            .iter()
            .zip(w.history.fuel_events()?)
        {
            let f = &mut p.fuel[e.segment];
            for g in 0..GROUPS {
                let n = w.state[e.region * GROUPS + g];
                f.fissile += k.d_fission_d_reserve[g] * n;
                f.capture += k.d_capture_d_fertile[g] * n;
            }
            let flux = speed[6] * w.state[e.region * GROUPS + 6] / volumes[e.region] * e.volume
                / self.input.history.segment_volumes()[e.segment];
            f.xe += poison.xe_sigma_m2 * flux;
            f.sm += poison.sm_sigma_m2 * flux;
        }
        for (i, (e, m)) in self
            .input
            .moderator
            .intersections()
            .iter()
            .zip(&self.input.row_map)
            .enumerate()
        {
            let c = w.moderator.rows()?[i];
            for g in 0..GROUPS {
                let n = w.state[e.region * GROUPS + g];
                p.loss[self.water_row(m.owner, false) - p.nc] -=
                    (c.d_hydrogen_d_product[g] - c.d_hydrogen_d_target[g]) * m.h_fraction * n;
                p.loss[self.water_row(m.owner, true) - p.nc] +=
                    c.d_boron_d_atoms[g] * m.b_fraction * n;
            }
        }
        for e in &self.input.passive_incidence {
            let s = &self.input.passive_stocks[e.stock];
            for t in &s.targets {
                let dc = p
                    .target_collision
                    .entry((t.index, e.region))
                    .or_insert([0.; GROUPS]);
                for g in 0..GROUPS {
                    let k = t.sigma_m2[g] * e.volume / s.volume / volumes[e.region];
                    p.loss[self.target_row(t.index) - p.nc] +=
                        speed[g] * k * w.state[e.region * GROUPS + g];
                    dc[g] -= k;
                }
            }
        }
        for e in &self.input.cylinder_incidence {
            let t = &self.input.cylinder_targets[e.target];
            let c = w.cylinder.responses()?[e.target];
            let dc = p
                .target_collision
                .entry((t.index, e.region))
                .or_insert([0.; GROUPS]);
            for g in 0..GROUPS {
                let k = c.d_capture_d_amount[g] * e.share / volumes[e.region];
                p.loss[self.target_row(t.index) - p.nc] +=
                    speed[g] * k * w.state[e.region * GROUPS + g];
                dc[g] -= k;
            }
        }
        let mut oi = 0;
        p.target_direction.fill(0.);
        for (face, coeff) in self
            .input
            .faces
            .iter()
            .zip(w.transport.face_coefficients()?)
        {
            if let ts::FaceLaw::Optical { targets } = &face.law {
                let r = face
                    .right
                    .ok_or("Optical preconditioner exterior unsupported")?;
                self.optical[oi].update_dependencies(&w.amounts, &mut p.optical[oi])?;
                for (j, &target) in targets.iter().enumerate() {
                    p.target_direction[target] = -1.;
                    let result =
                        self.optical[oi].jvp_dependencies(&p.target_direction, &mut p.optical[oi]);
                    p.target_direction[target] = 0.;
                    result?;
                    let o = &p.optical[oi];
                    for g in 0..GROUPS {
                        let dl = p
                            .target_collision
                            .get(&(target, face.left))
                            .map_or(0., |a| a[g]);
                        let dr = p.target_collision.get(&(target, r)).map_or(0., |a| a[g]);
                        let dir = [dl, dr, o.transmission_jvp[g]];
                        let derivative = |s: ts::Scalar| {
                            s.derivatives
                                .iter()
                                .zip(dir)
                                .map(|(a, b)| a * b)
                                .sum::<f64>()
                        };
                        let c = coeff[g];
                        let pl = speed[g] * w.state[face.left * GROUPS + g] / volumes[face.left];
                        let pr = speed[g] * w.state[r * GROUPS + g] / volumes[r];
                        let dcap = (derivative(c.capture_per_loss_left) * o.left_loss[j][g]
                            + c.capture_per_loss_left.value * o.left_loss_jvp[j][g])
                            * pl
                            + (derivative(c.capture_per_loss_right) * o.right_loss[j][g]
                                + c.capture_per_loss_right.value * o.right_loss_jvp[j][g])
                                * pr;
                        p.loss[self.target_row(target) - p.nc] -= dcap;
                    }
                }
                oi += 1;
            }
        }
        for (i, m) in self.input.mn.iter().enumerate() {
            p.loss[self.mn_row(i) - p.nc] = m.decay_rate;
        }
        for f in &p.fuel {
            if [
                cj + f.fissile,
                cj + f.capture + f.sf238,
                cj + poison.lambda_i,
                cj + poison.lambda_xe + f.xe,
                cj + poison.lambda_pm,
                cj + f.sm,
            ]
            .iter()
            .any(|v| !v.is_finite() || *v <= 0.)
            {
                return Err("Invalid local fuel-history preconditioner pivot");
            }
        }
        if !(cj + p.cf_decay).is_finite()
            || p.loss
                .iter()
                .any(|k| !k.is_finite() || !(cj + k).is_finite() || cj + k <= 0.)
        {
            return Err("Invalid local target-history preconditioner pivot");
        }
        p.valid = true;
        Ok(())
    }
    /// Contract the shared event derivatives with incoming N/C and Cf only.
    /// The final number-ledger row completes the invariant of the full stage,
    /// not the dropped history feedback of the approximate spatial blocks.
    pub fn solve_preconditioner_history(
        &self,
        w: &mut Workspace,
        p: &HistoryPreconditioner,
        rhs: &[f64],
        out: &mut [f64],
    ) -> Result<(), &'static str> {
        w.check()?;
        if !p.valid
            || !Arc::ptr_eq(&self.owner, &p.owner)
            || !Arc::ptr_eq(&self.owner, &w.owner)
            || p.serial != w.evaluation_serial
            || !p
                .workspace_owner
                .as_ref()
                .is_some_and(|owner| Arc::ptr_eq(owner, &w.stage_owner))
            || rhs.len() != self.state_count()
            || out.len() != self.state_count()
            || rhs.iter().chain(out.iter()).any(|v| !v.is_finite())
        {
            return Err("Invalid/stale local history preconditioner solve");
        }
        let mut direction = std::mem::take(&mut w.preconditioner_direction);
        direction.fill(0.);
        direction[..p.nc].copy_from_slice(&out[..p.nc]);
        direction[p.cf] = out[p.cf];
        let result = self.jvp_selected::<true>(&direction, w);
        w.preconditioner_direction = direction;
        result?;
        let force = &w.jvp;
        let cj = p.cj;
        let poison = self.input.history.poison_law();
        let mut local_release = 0.;
        let prompt = self.input.history.fission_energy()
            - self
                .input
                .history
                .energy_groups()
                .iter()
                .filter(|g| matches!(g.feed, crate::heat_history::Feed::Fission))
                .map(|g| g.energy_per_event)
                .sum::<f64>();
        for s in 0..self.segment_count() {
            let row = self.input.history.history_row(s, 0);
            let f = p.fuel[s];
            let b = |slot: usize| rhs[row + slot] + force[row + slot];
            out[row + fh::CONSUMED_235] = b(fh::CONSUMED_235) / (cj + f.fissile);
            let total = (b(fh::CAPTURED_238) + b(fh::SF_238)) / (cj + f.capture + f.sf238);
            out[row + fh::CAPTURED_238] = (b(fh::CAPTURED_238) - f.capture * total) / cj;
            out[row + fh::SF_238] = (b(fh::SF_238) - f.sf238 * total) / cj;
            let df = -f.fissile * out[row + fh::CONSUMED_235] - f.sf238 * total;
            let dc = -f.capture * total;
            out[row + fh::IODINE] = (b(fh::IODINE) + poison.yield_i * df) / (cj + poison.lambda_i);
            out[row + fh::XENON] =
                (b(fh::XENON) + poison.yield_xe * df + poison.lambda_i * out[row + fh::IODINE])
                    / (cj + poison.lambda_xe + f.xe);
            out[row + fh::PROMETHIUM] =
                (b(fh::PROMETHIUM) + poison.yield_pm * df) / (cj + poison.lambda_pm);
            out[row + fh::SAMARIUM] =
                (b(fh::SAMARIUM) + poison.lambda_pm * out[row + fh::PROMETHIUM]) / (cj + f.sm);
            out[row + fh::XENON_PRODUCT] =
                (b(fh::XENON_PRODUCT) + f.xe * out[row + fh::XENON]) / cj;
            out[row + fh::SAMARIUM_PRODUCT] =
                (b(fh::SAMARIUM_PRODUCT) + f.sm * out[row + fh::SAMARIUM]) / cj;
            local_release += prompt * df;
            for (i, g) in self.input.history.energy_groups().iter().enumerate() {
                let feed = match g.feed {
                    crate::heat_history::Feed::Fission => df,
                    crate::heat_history::Feed::FertileCapture => dc,
                };
                let e = row + fh::ENERGY + i;
                out[e] = (rhs[e] + force[e] + g.energy_per_event * feed) / (cj + g.decay_rate);
                local_release += g.decay_rate * out[e];
            }
        }
        for i in self.history_dimension()..self.ledger_row() {
            out[i] = (rhs[i] + force[i]) / (cj + p.loss[i - p.nc]);
        }
        for (i, m) in self.input.mn.iter().enumerate() {
            let row = self.mn_row(i);
            out[row] = (rhs[row] + force[row] + m.decay_rate * out[self.target_row(m.target)])
                / (cj + m.decay_rate);
        }
        for row in [self.escape_row(), self.collected_row()] {
            out[row] = (rhs[row] + force[row]) / cj;
        }
        // ℓ=(1 over N/C, -1 over the independently evolved event ledger),
        // ℓ(cj I-R')=cj ℓ. This is an exact row combination in P, not a reset
        // or projection of an accepted state/ledger. Inexact Newton and IDA
        // constraint corrections still require independent admission checks.
        out[self.ledger_row()] = out[..p.nc].iter().sum::<f64>()
            + (rhs[self.ledger_row()] - rhs[..p.nc].iter().sum::<f64>()) / cj;
        out[self.fuel_release_row()] =
            (rhs[self.fuel_release_row()] + force[self.fuel_release_row()] + local_release) / cj;
        if out.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite local history preconditioner result");
        }
        Ok(())
    }
}

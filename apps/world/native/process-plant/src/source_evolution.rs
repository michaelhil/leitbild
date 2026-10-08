//! Birth-driven represented source on a fixed source mesh and reachable
//! incidence union, with current material and water geometry. Closed callers
//! supply the prepared temperature boundary; coupled callers supply actual
//! same-trial fuel temperatures and externally owned primary-water stocks.
//! No thermal bath, deposited-heat state, acquired detector, live plant or
//! production-mesh claim. Achieved deposition receipts have explicit scope.
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
mod jacobian;
pub use jacobian::Jacobian;
mod barrel_response;
pub use barrel_response::BarrelResponse;

#[derive(Clone, Copy, Debug)]
pub enum WaterAuthority {
    Closed,
    External { index: usize },
}
#[derive(Clone, Copy, Debug)]
pub struct WaterOwner {
    pub authority: WaterAuthority,
    pub hydrogen: f64,
    pub hydrogen_product: f64,
    pub boron: f64,
    pub boron_product: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct WaterRow {
    pub owner: usize,
    /// Closed-owner amount fractions; both must be zero for external owners.
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
    /// Prepared closed-boundary temperatures and coupled input shape.
    pub temperatures: Vec<f64>,
    pub moderator: ms::ModeratorModel,
    pub water_rows: Vec<ms::Stocks>,
    pub water_owners: Vec<WaterOwner>,
    /// Actual prepared bulk cavity volume, by external index. Liquid
    /// occupation is a separate stock; closed owners need no entry here.
    pub external_water_volumes: Vec<f64>,
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
/// Stage geometry on one immutable reachable incidence union. These arrays
/// contain no targets, material inventories, fuel history, or time state.
/// A caller must derive all of them from the same actual physical pose.
#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    pub passive_volumes: Vec<f64>,
    pub cylinder_shares: Vec<f64>,
    pub moderator_volumes: Vec<f64>,
    pub external_water_volumes: Vec<f64>,
}
impl Geometry {
    pub fn zero_direction(&self) -> Self {
        Self {
            passive_volumes: vec![0.; self.passive_volumes.len()],
            cylinder_shares: vec![0.; self.cylinder_shares.len()],
            moderator_volumes: vec![0.; self.moderator_volumes.len()],
            external_water_volumes: vec![0.; self.external_water_volumes.len()],
        }
    }
    fn arrays(&self) -> [&[f64]; 4] {
        [
            &self.passive_volumes,
            &self.cylinder_shares,
            &self.moderator_volumes,
            &self.external_water_volumes,
        ]
    }
    fn same_bits(&self, other: &Self) -> bool {
        self.arrays().into_iter().zip(other.arrays()).all(|(a, b)| {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.to_bits() == b.to_bits())
        })
    }
    fn copy_from(&mut self, other: &Self) {
        self.passive_volumes.copy_from_slice(&other.passive_volumes);
        self.cylinder_shares.copy_from_slice(&other.cylinder_shares);
        self.moderator_volumes
            .copy_from_slice(&other.moderator_volumes);
        self.external_water_volumes
            .copy_from_slice(&other.external_water_volumes);
    }
    fn buffer_bytes(&self) -> usize {
        self.arrays().iter().map(|a| a.len() * 8).sum()
    }
}
pub struct Evolution {
    input: Input,
    geometry: Geometry,
    zero_geometry: Geometry,
    closed_water: Vec<Option<usize>>,
    closed_water_count: usize,
    external_water_count: usize,
    external_row_owners: Vec<Option<usize>>,
    zero_temperature: Vec<f64>,
    // Fixed physical ownership: Mn targets use direct Mn56 + Fe inventories,
    // other targets retain cumulative capture progress.
    mn_owner: Vec<Option<usize>>,
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
    geometry: Geometry,
    geometry_sums: Vec<f64>,
    cylinder_direction_sums: Vec<[f64; 2]>,
    history: fh::Workspace,
    moderator: ms::Workspace,
    passive: ps::Workspace,
    cylinder: cs::Workspace,
    transport: ts::Workspace,
    optical: Vec<os::LayerWorkspace>,
    optical_inputs: Vec<ts::OpticalInput>,
    history_state: Vec<f64>,
    history_direction: Vec<f64>,
    temperatures: Vec<f64>,
    segment_release: Vec<f64>,
    external_water: Vec<ms::Stocks>,
    external_bulk: Vec<ms::Bulk>,
    external_events: Vec<ms::Events>,
    external_event_direction: Vec<ms::Events>,
    fuel_deposition: Vec<f64>,
    fuel_deposition_direction: Vec<f64>,
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
    water_event_direction: Vec<ms::Events>,
    passive_capture: Vec<f64>,
    passive_births: Vec<f64>,
    passive_birth_direction: Vec<f64>,
    target_captures: Vec<f64>,
    target_capture_direction: Vec<f64>,
    cylinder_capture: Vec<[f64; GROUPS]>,
    optical_capture: Vec<[f64; GROUPS]>,
    collected: Vec<[f64; GROUPS]>,
    charged_escape: Vec<[f64; GROUPS]>,
    escape: [f64; GROUPS],
    diagnostics: Diagnostics,
    valid: bool,
    jvp_valid: bool,
    owner: Arc<()>,
}
impl Workspace {
    pub(crate) fn owner_token(&self) -> &Arc<()> {
        &self.owner
    }
    pub fn passive_birth_events(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.passive_births)
    }
    pub fn passive_birth_event_jvp(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("No current passive birth direction");
        }
        Ok(&self.passive_birth_direction)
    }
    pub fn fuel_capture_events(&self) -> Result<&[[f64; 3]], &'static str> {
        self.check()?;
        self.history.capture_events()
    }
    pub fn fuel_capture_event_jvp(&self) -> Result<&[[f64; 3]], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("No current source direction");
        }
        self.history.capture_event_jvp()
    }
    /// Actual target capture events before any Mn product decay. Retained
    /// separately so a tiny capture is not recovered by cancelling decay.
    pub fn target_captures(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.target_captures)
    }
    pub fn target_capture_jvp(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("Invalid source JVP candidate");
        }
        Ok(&self.target_capture_direction)
    }
    /// Achieved captures debit the externally owned carrier exactly once.
    pub fn external_water_events(&self) -> Result<&[ms::Events], &'static str> {
        self.check()?;
        Ok(&self.external_events)
    }
    pub fn external_water_event_jvp(&self) -> Result<&[ms::Events], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("Invalid source JVP candidate");
        }
        Ok(&self.external_event_direction)
    }
    /// Birth-site events before native-cell aggregation. Thermal routing must
    /// retain this region/material identity instead of heating advected products.
    pub fn water_birth_events(&self) -> Result<&[ms::Events], &'static str> {
        self.check()?;
        Ok(&self.water_events)
    }
    pub fn water_birth_event_jvp(&self) -> Result<&[ms::Events], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("Invalid source birth-event direction");
        }
        Ok(&self.water_event_direction)
    }
    /// Only the selected prompt-fission/E25 release path. Other binding,
    /// activation and capsule emissions are NOT silently deposited here.
    pub fn fuel_deposition(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.fuel_deposition)
    }
    pub fn fuel_deposition_jvp(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        if !self.jvp_valid {
            return Err("Invalid source JVP candidate");
        }
        Ok(&self.fuel_deposition_direction)
    }
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
            + self.geometry.buffer_bytes()
            + self.geometry_sums.len() * 8
            + self.cylinder_direction_sums.len() * 16
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
                + self.temperatures.len()
                + self.segment_release.len()
                + self.passive_births.len()
                + self.passive_birth_direction.len()
                + self.fuel_deposition.len()
                + self.fuel_deposition_direction.len()
                + self.state.len()
                + self.rates.len()
                + self.jvp.len()
                + self.amounts.len()
                + self.amount_direction.len()
                + self.scratch.len()
                + self.passive_capture.len()
                + self.target_captures.len()
                + self.target_capture_direction.len())
                * 8
            + (self.collision.len()
                + self.collision_direction.len()
                + self.cylinder_capture.len()
                + self.optical_capture.len()
                + self.collected.len()
                + self.charged_escape.len())
                * std::mem::size_of::<[f64; GROUPS]>()
            + self.water.len() * std::mem::size_of::<ms::Stocks>()
            + (self.water_events.len() + self.water_event_direction.len())
                * std::mem::size_of::<ms::Events>()
            + (self.external_events.len() + self.external_event_direction.len())
                * std::mem::size_of::<ms::Events>()
            + self.external_water.len() * std::mem::size_of::<ms::Stocks>()
            + self.external_bulk.len() * std::mem::size_of::<ms::Bulk>()
    }
}
fn nn(x: f64) -> bool {
    x.is_finite() && x >= 0.
}
fn close(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= 4e-11 * a.abs().max(b.abs()).max(1e-30)
}
fn stock_bits(s: &ms::Stocks) -> [u64; 5] {
    [
        s.water_mass.to_bits(),
        s.liquid_volume.to_bits(),
        s.hydrogen_target.to_bits(),
        s.hydrogen_product.to_bits(),
        s.mobile_boron10.to_bits(),
    ]
}
impl Evolution {
    /// Existing volume-material application order, retained before target aggregation.
    pub fn passive_birth_rows(&self) -> impl Iterator<Item = (usize, usize, usize)> + '_ {
        self.input
            .passive_incidence
            .iter()
            .flat_map(|e| {
                self.input.passive_stocks[e.stock]
                    .targets
                    .iter()
                    .map(move |t| (t.index, e.region))
            })
            .enumerate()
            .map(|(i, (t, r))| (i, t, r))
    }
    /// Actual represented external-water birth rows, not closed bay inventories.
    pub fn external_water_birth_rows(&self) -> impl Iterator<Item = (usize, usize, usize)> + '_ {
        self.input.row_map.iter().enumerate().filter_map(|(i, m)| {
            match self.input.water_owners[m.owner].authority {
                WaterAuthority::External { index } => {
                    Some((i, self.input.moderator.intersections()[i].region, index))
                }
                WaterAuthority::Closed => None,
            }
        })
    }
    pub fn mobile_capture_emissions(&self) -> [[f64; 2]; 2] {
        let law = self.input.moderator.law();
        [law.hydrogen_emission, law.boron_emission]
    }
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
        let mut vs = hs.clone();
        let mut external_indexes = BTreeSet::new();
        let mut closed_water = vec![None; input.water_owners.len()];
        let mut closed_water_count = 0;
        for (i, o) in input.water_owners.iter().enumerate() {
            if ![o.hydrogen, o.hydrogen_product, o.boron, o.boron_product]
                .iter()
                .all(|x| nn(*x))
                || o.hydrogen <= 0.
            {
                return Err("Invalid physical water preparation");
            }
            match o.authority {
                WaterAuthority::Closed => {
                    closed_water[i] = Some(closed_water_count);
                    closed_water_count += 1;
                }
                WaterAuthority::External { index } => {
                    if !external_indexes.insert(index) {
                        return Err("Duplicate external water owner");
                    }
                }
            }
        }
        if external_indexes
            .iter()
            .copied()
            .ne(0..external_indexes.len())
        {
            return Err("External water indexes must be complete and contiguous");
        }
        if input.external_water_volumes.len() != external_indexes.len()
            || input
                .external_water_volumes
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("Invalid prepared external bulk water volumes");
        }
        let external_row_owners = input
            .row_map
            .iter()
            .map(|m| {
                input
                    .water_owners
                    .get(m.owner)
                    .and_then(|o| match o.authority {
                        WaterAuthority::Closed => None,
                        WaterAuthority::External { index } => Some(index),
                    })
            })
            .collect();
        for (i, (r, m)) in input.water_rows.iter().zip(&input.row_map).enumerate() {
            if m.owner >= hs.len()
                || !nn(m.h_fraction)
                || !nn(m.b_fraction)
                || ms::Bulk::new(*r, input.moderator.intersections()[i].volume).is_err()
                || ![
                    r.water_mass,
                    r.liquid_volume,
                    r.hydrogen_target,
                    r.hydrogen_product,
                    r.mobile_boron10,
                ]
                .iter()
                .all(|&x| nn(x))
                || (r.water_mass == 0.) != (r.liquid_volume == 0.)
            {
                return Err("Invalid water owner incidence");
            }
            let o = input.water_owners[m.owner];
            let (h_fraction, b_fraction) = match o.authority {
                WaterAuthority::Closed => (m.h_fraction, m.b_fraction),
                WaterAuthority::External { index } if m.h_fraction == 0. && m.b_fraction == 0. => {
                    let fraction = input.moderator.intersections()[i].volume
                        / input.external_water_volumes[index];
                    vs[m.owner] += fraction;
                    (fraction, fraction)
                }
                _ => return Err("Water row projection does not match its authority"),
            };
            if !close(r.hydrogen_target, h_fraction * o.hydrogen)
                || !close(r.hydrogen_product, h_fraction * o.hydrogen_product)
                || !close(r.mobile_boron10, b_fraction * o.boron)
            {
                return Err("Water owner totals/fractions mismatch");
            }
            hs[m.owner] += m.h_fraction;
            bs[m.owner] += m.b_fraction;
        }
        if hs
            .iter()
            .chain(&bs)
            .chain(&vs)
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
                if let ts::FaceLaw::Optical { targets } | ts::FaceLaw::InternalOptical { targets } =
                    &f.law
                {
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
        let mut mn_owner = vec![None; input.targets.len()];
        for (i, m) in input.mn.iter().enumerate() {
            mn_owner[m.target] = Some(i);
        }
        let zero_temperature = vec![0.; input.temperatures.len()];
        let geometry = Geometry {
            passive_volumes: input.passive_incidence.iter().map(|e| e.volume).collect(),
            cylinder_shares: input.cylinder_incidence.iter().map(|e| e.share).collect(),
            moderator_volumes: input
                .moderator
                .intersections()
                .iter()
                .map(|e| e.volume)
                .collect(),
            external_water_volumes: input.external_water_volumes.clone(),
        };
        let zero_geometry = geometry.zero_direction();
        let result = Self {
            input,
            geometry,
            zero_geometry,
            closed_water,
            closed_water_count,
            external_water_count: external_indexes.len(),
            external_row_owners,
            zero_temperature,
            mn_owner,
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
                    .closed_water_count
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
    /// Immutable carried fuel/history laws and finite preparation accounts.
    pub fn fuel_history(&self) -> &fh::Assembly {
        &self.input.history
    }
    pub(crate) fn owner_token(&self) -> Arc<()> {
        self.owner.clone()
    }
    pub fn capture_progress_rows(&self) -> impl Iterator<Item = [usize; 3]> + '_ {
        (0..self.segment_count()).map(|s| {
            let r = self.input.history.history_row(s, 0);
            [
                r + fh::CAPTURED_238,
                r + fh::XENON_PRODUCT,
                r + fh::SAMARIUM_PRODUCT,
            ]
        })
    }
    pub fn water_owners(&self) -> &[WaterOwner] {
        &self.input.water_owners
    }
    pub fn moderator_law(&self) -> &ms::ModeratorLaw {
        self.input.moderator.law()
    }
    pub fn target_reference_atoms(&self) -> &[f64] {
        &self.input.targets
    }
    pub fn water_row(&self, i: usize, boron: bool) -> usize {
        self.closed_water_row(i, boron)
            .expect("External water has no source-owned history coordinate")
    }
    pub fn closed_water_row(&self, owner: usize, boron: bool) -> Option<usize> {
        self.closed_water
            .get(owner)
            .copied()
            .flatten()
            .map(|i| self.history_dimension() + 2 * i + usize::from(boron))
    }
    pub fn external_water_count(&self) -> usize {
        self.external_water_count
    }
    pub fn prepared_temperatures(&self) -> &[f64] {
        &self.input.temperatures
    }
    pub fn prepared_geometry(&self) -> &Geometry {
        &self.geometry
    }
    /// Mn targets store DIRECT Mn56 inventory; all other targets store capture
    /// progress. Use consumed_target for a target's cumulative consumption.
    pub fn target_row(&self, i: usize) -> usize {
        self.history_dimension() + 2 * self.closed_water_count + i
    }
    /// Direct Fe decay-product inventory, not cumulative Mn56 capture.
    pub fn mn_product_row(&self, i: usize) -> usize {
        self.target_row(self.input.targets.len()) + i
    }
    pub fn mn_targets(&self) -> &[MnTarget] {
        &self.input.mn
    }
    pub fn target_count(&self) -> usize {
        self.input.targets.len()
    }
    pub fn consumed_target(&self, y: &[f64], target: usize) -> Result<f64, &'static str> {
        if y.len() != self.state_count() || target >= self.input.targets.len() {
            return Err("Invalid target consumption state/index");
        }
        let value = self.target_consumption(y, target);
        if !y[self.target_row(target)].is_finite()
            || self.mn_owner[target].is_some_and(|i| !y[self.mn_product_row(i)].is_finite())
            || !value.is_finite()
        {
            return Err("Nonfinite target consumption");
        }
        Ok(value)
    }
    // Also applies to signed tangent vectors: consumption is a linear map.
    fn target_consumption(&self, y: &[f64], target: usize) -> f64 {
        y[self.target_row(target)] + self.mn_owner[target].map_or(0., |i| y[self.mn_product_row(i)])
    }
    pub fn ledger_row(&self) -> usize {
        self.mn_product_row(self.input.mn.len())
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
            geometry: self.geometry.clone(),
            geometry_sums: vec![0.; self.input.water_owners.len()],
            cylinder_direction_sums: vec![[0.; 2]; self.input.cylinder_targets.len()],
            history: self.input.history.workspace(),
            moderator: self.input.moderator.workspace(),
            passive: self.passive.workspace(),
            cylinder: self.cylinder.workspace(),
            transport: self.transport.workspace(),
            optical,
            optical_inputs,
            history_state: vec![0.; self.history_dimension()],
            history_direction: vec![0.; self.history_dimension()],
            temperatures: self.input.temperatures.clone(),
            segment_release: vec![0.; self.segment_count()],
            external_water: vec![
                ms::Stocks {
                    water_mass: 0.,
                    liquid_volume: 0.,
                    hydrogen_target: 0.,
                    hydrogen_product: 0.,
                    mobile_boron10: 0.
                };
                self.external_water_count
            ],
            external_bulk: vec![ms::Bulk::default(); self.external_water_count],
            external_events: vec![ms::Events::default(); self.external_water_count],
            external_event_direction: vec![ms::Events::default(); self.external_water_count],
            fuel_deposition: vec![0.; self.input.temperatures.len()],
            fuel_deposition_direction: vec![0.; self.input.temperatures.len()],
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
            water_event_direction: vec![ms::Events::default(); self.input.water_rows.len()],
            passive_capture: vec![0.; nt],
            passive_births: vec![0.; self.passive.birth_count()],
            passive_birth_direction: vec![0.; self.passive.birth_count()],
            target_captures: vec![0.; nt],
            target_capture_direction: vec![0.; nt],
            cylinder_capture: vec![[0.; GROUPS]; nt],
            optical_capture: vec![[0.; GROUPS]; nt],
            collected: vec![[0.; GROUPS]; nt],
            charged_escape: vec![[0.; GROUPS]; nt],
            escape: [0.; GROUPS],
            diagnostics: Diagnostics::default(),
            valid: false,
            jvp_valid: false,
            owner: self.owner.clone(),
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
            if self.closed_water[i].is_none() {
                continue;
            }
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
            let consumed = self.consumed_target(y, i).map_err(str::to_owned)?;
            if consumed > a {
                return Err(format!(
                    "Exhausted accepted passive target={i},row={},progress={:e},reference={a:e}",
                    self.target_row(i),
                    consumed
                ));
            }
        }
        Ok(())
    }
    pub fn evaluate_into(&self, y: &[f64], w: &mut Workspace) -> Result<(), &'static str> {
        if self.external_water_count != 0 {
            w.valid = false;
            w.jvp_valid = false;
            return Err("Closed source boundary cannot supply external water");
        }
        self.evaluate_coupled_into(y, &self.input.temperatures, &[], w)
    }
    /// Same-trial thermal/material boundary. Externally owned water receives
    /// capture events, never independently advanced duplicate source stocks.
    pub fn evaluate_coupled_into(
        &self,
        y: &[f64],
        temperatures: &[f64],
        external_water: &[ms::Stocks],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.evaluate_with_geometry_into(y, temperatures, external_water, &self.geometry, w)
    }
    /// Same trial source/material/water geometry. Models and target histories
    /// are never reconstructed when a BODY crosses a source-region plane.
    pub fn evaluate_with_geometry_into(
        &self,
        y: &[f64],
        temperatures: &[f64],
        external_water: &[ms::Stocks],
        geometry: &Geometry,
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() != self.state_count()
            || y.iter().any(|x| !x.is_finite())
            || temperatures.len() != self.input.temperatures.len()
            || temperatures
                .iter()
                .any(|t| !t.is_finite() || !(290. ..=2000.).contains(t))
            || external_water.len() != self.external_water_count
            || external_water.iter().any(|s| {
                ![
                    s.water_mass,
                    s.liquid_volume,
                    s.hydrogen_target,
                    s.mobile_boron10,
                ]
                .iter()
                .all(|x| nn(*x))
                    || !s.hydrogen_product.is_finite()
                    || !(s.hydrogen_target + s.hydrogen_product).is_finite()
                    || s.water_mass <= 0.
                    || s.liquid_volume <= 0.
                    || s.hydrogen_target + s.hydrogen_product <= 0.
            })
        {
            w.valid = false;
            w.jvp_valid = false;
            return Err("Invalid source trial/workspace");
        }
        if geometry
            .arrays()
            .into_iter()
            .zip(self.geometry.arrays())
            .any(|(a, b)| a.len() != b.len() || a.iter().any(|x| !nn(*x)))
        {
            w.valid = false;
            w.jvp_valid = false;
            return Err("Invalid current source geometry");
        }
        if geometry.external_water_volumes.iter().any(|v| *v <= 0.) {
            w.valid = false;
            w.jvp_valid = false;
            return Err("Nonpositive current physical water bulk volume");
        }
        w.geometry_sums.fill(0.);
        for (i, m) in self.input.row_map.iter().enumerate() {
            match self.input.water_owners[m.owner].authority {
                WaterAuthority::Closed
                    if geometry.moderator_volumes[i].to_bits()
                        != self.geometry.moderator_volumes[i].to_bits() =>
                {
                    w.valid = false;
                    w.jvp_valid = false;
                    return Err("Closed prepared water cannot change geometry without its owner");
                }
                WaterAuthority::External { index } => {
                    w.geometry_sums[m.owner] +=
                        geometry.moderator_volumes[i] / geometry.external_water_volumes[index];
                }
                _ => {}
            }
        }
        if w.geometry_sums
            .iter()
            .any(|s| !s.is_finite() || *s > 1. + 4e-11)
        {
            w.valid = false;
            w.jvp_valid = false;
            return Err("Current water source incidence exceeds owner");
        }
        // Reuse only the complete, bit-identical dependency vector of this
        // valid workspace. IDA residual/JT setup commonly request that same
        // state. Pointer identity, approximate equality and failed trials are
        // not cache keys. Independent P-stage workspaces remain independent.
        if w.valid
            && geometry.same_bits(&w.geometry)
            && y.iter()
                .zip(&w.state)
                .all(|(a, b)| a.to_bits() == b.to_bits())
            && temperatures
                .iter()
                .zip(&w.temperatures)
                .all(|(a, b)| a.to_bits() == b.to_bits())
            && external_water
                .iter()
                .zip(&w.external_water)
                .all(|(a, b)| stock_bits(a) == stock_bits(b))
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
        self.input
            .history
            .evaluate_into(temperatures, &w.history_state, &mut w.history)?;
        w.rates.fill(0.);
        w.rates[..self.history_dimension()].copy_from_slice(w.history.rates()?);
        w.rates[self.cf_row()] = -w.rates[self.cf_row()];
        w.collision.copy_from_slice(w.history.collision()?);
        for (index, s) in external_water.iter().enumerate() {
            w.external_bulk[index] = ms::Bulk::new(*s, geometry.external_water_volumes[index])?;
        }
        for (i, (r, m)) in self
            .input
            .water_rows
            .iter()
            .zip(&self.input.row_map)
            .enumerate()
        {
            match self.input.water_owners[m.owner].authority {
                WaterAuthority::Closed => {
                    w.water[i] = *r;
                    w.water[i].hydrogen_target =
                        r.hydrogen_target - m.h_fraction * y[self.water_row(m.owner, false)];
                    w.water[i].hydrogen_product =
                        r.hydrogen_product + m.h_fraction * y[self.water_row(m.owner, false)];
                    w.water[i].mobile_boron10 =
                        r.mobile_boron10 - m.b_fraction * y[self.water_row(m.owner, true)];
                }
                // External rows are views of the prepared physical bulk below,
                // not multiplied stock copies. Only closed rows read w.water.
                WaterAuthority::External { .. } => {}
            }
        }
        self.input.moderator.update_projected(
            &w.water,
            &geometry.moderator_volumes,
            &w.external_bulk,
            &self.external_row_owners,
            &mut w.moderator,
        )?;
        self.input
            .moderator
            .apply(&w.moderator, &y[..n], &mut w.scratch, &mut w.water_events)?;
        for i in 0..n {
            w.rates[i] += w.scratch[i];
        }
        w.external_events.fill(ms::Events::default());
        for (i, m) in self.input.row_map.iter().enumerate() {
            let e = w.water_events[i];
            match self.input.water_owners[m.owner].authority {
                WaterAuthority::Closed => {
                    w.rates[self.water_row(m.owner, false)] += e.hydrogen;
                    w.rates[self.water_row(m.owner, true)] += e.boron;
                }
                WaterAuthority::External { index } => {
                    let out = &mut w.external_events[index];
                    out.hydrogen += e.hydrogen;
                    out.boron += e.boron;
                    out.emitted_charged += e.emitted_charged;
                    out.emitted_photon += e.emitted_photon;
                }
            }
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
            w.amounts[i] = a - self.consumed_target(y, i)?;
        }
        self.passive
            .update_with_volumes(&w.amounts, &geometry.passive_volumes, &mut w.passive)?;
        w.passive_capture.fill(0.);
        w.scratch.fill(0.);
        self.passive.apply(
            &w.passive,
            &y[..n],
            &mut w.scratch,
            &mut w.passive_capture,
            &mut w.passive_births,
        )?;
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
        self.cylinder
            .update_with_shares(&w.amounts, &geometry.cylinder_shares, &mut w.cylinder)?;
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
        for (i, c) in w.target_captures.iter_mut().enumerate() {
            *c = w.rates[self.target_row(i)];
        }
        for (i, m) in self.input.mn.iter().enumerate() {
            let decay = m.decay_rate * y[self.target_row(m.target)];
            w.rates[self.target_row(m.target)] -= decay;
            w.rates[self.mn_product_row(i)] = decay;
            d.mn_electron_release_w += m.electron_j * decay;
            d.mn_photon_release_w += m.photon_j * decay;
        }
        w.rates[self.ledger_row()] = d.net_neutron_events_s;
        w.rates[self.escape_row()] = d.escape_neutrons_s;
        w.rates[self.collected_row()] = d.collected_events_s;
        w.rates[self.fuel_release_row()] = d.fuel_release_w;
        for (out, s) in w.segment_release.iter_mut().zip(w.history.segments()?) {
            *out = self.input.history.prompt_fission_energy() * (s.sf235 + s.sf238)
                + s.delayed_release;
        }
        self.input.history.fuel().fuel_heat(
            w.history.achieved_events()?,
            self.input.history.prompt_fission_energy(),
            &w.segment_release,
            &mut w.fuel_deposition,
        )?;
        if w.rates.iter().any(|v| !v.is_finite())
            || w.external_events.iter().any(|e| {
                ![e.hydrogen, e.boron, e.emitted_charged, e.emitted_photon]
                    .iter()
                    .all(|x| x.is_finite())
            })
        {
            return Err("Nonfinite represented source candidate");
        }
        w.state.copy_from_slice(y);
        w.temperatures.copy_from_slice(temperatures);
        w.external_water.copy_from_slice(external_water);
        w.geometry.copy_from(geometry);
        w.diagnostics = d;
        w.valid = true;
        Ok(())
    }
    /// Full analytic represented-source direction. Only preconditioning, not
    /// this derivative, omits N/C↔material and inter-target optical couplings.
    pub fn jvp_into(&self, dy: &[f64], w: &mut Workspace) -> Result<(), &'static str> {
        if self.external_water_count != 0 {
            w.jvp_valid = false;
            return Err("Closed source direction cannot supply external water");
        }
        self.jvp_coupled_into(dy, &self.zero_temperature, &[], w)
    }
    pub fn jvp_coupled_into(
        &self,
        dy: &[f64],
        dtemperatures: &[f64],
        dexternal_water: &[ms::Stocks],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.jvp_with_geometry_into(dy, dtemperatures, dexternal_water, &self.zero_geometry, w)
    }
    /// Geometry direction is on the branch selected by the caller's current
    /// physical pose. It is not a second material/time state or a numerical
    /// perturbation of model preparation.
    pub fn jvp_with_geometry_into(
        &self,
        dy: &[f64],
        dtemperatures: &[f64],
        dexternal_water: &[ms::Stocks],
        dgeometry: &Geometry,
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.jvp_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || dy.len() != self.state_count()
            || dy.iter().any(|x| !x.is_finite())
            || dtemperatures.len() != self.input.temperatures.len()
            || dtemperatures.iter().any(|x| !x.is_finite())
            || dexternal_water.len() != self.external_water_count
            || dexternal_water.iter().any(|s| {
                [
                    s.water_mass,
                    s.liquid_volume,
                    s.hydrogen_target,
                    s.hydrogen_product,
                    s.mobile_boron10,
                ]
                .iter()
                .any(|x| !x.is_finite())
            })
            || dgeometry
                .arrays()
                .into_iter()
                .zip(self.geometry.arrays())
                .any(|(a, b)| a.len() != b.len() || a.iter().any(|x| !x.is_finite()))
        {
            return Err("Invalid source JVP trial/workspace");
        }
        w.cylinder_direction_sums.fill([0.; 2]);
        for (e, &d) in self
            .input
            .cylinder_incidence
            .iter()
            .zip(&dgeometry.cylinder_shares)
        {
            let s = &mut w.cylinder_direction_sums[e.target];
            s[0] += d;
            s[1] += d.abs();
        }
        if w.cylinder_direction_sums
            .iter()
            .any(|s| s[0].abs() > 4e-11 * s[1])
        {
            return Err("Cylinder geometry direction creates target share");
        }
        for (i, m) in self.input.row_map.iter().enumerate() {
            if matches!(
                self.input.water_owners[m.owner].authority,
                WaterAuthority::Closed
            ) && dgeometry.moderator_volumes[i] != 0.
            {
                return Err("Closed water geometry direction lacks an owner");
            }
        }
        let volumes = self.input.history.fuel().volumes();
        let speed = self.input.history.fuel().law().speed;
        w.history_direction
            .copy_from_slice(&dy[..self.history_dimension()]);
        w.history_direction[self.cf_row()] = -dy[self.cf_row()];
        self.input
            .history
            .jvp_into(dtemperatures, &w.history_direction, &mut w.history)?;
        w.jvp.fill(0.);
        w.jvp[..self.history_dimension()].copy_from_slice(w.history.rate_jvp()?);
        w.jvp[self.cf_row()] = -w.jvp[self.cf_row()];
        w.collision_direction
            .copy_from_slice(w.history.collision_jvp()?);
        let mut net = w.jvp[..self.nc_dimension()].iter().sum::<f64>();
        let mut escape = 0.;
        let mut collected = 0.;
        for r in 0..self.region_count() {
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    w.jvp[r * GROUPS + h] +=
                        w.moderator.coefficients()?[r * 49 + h * 7 + g] * dy[r * GROUPS + g];
                }
            }
        }
        w.external_event_direction.fill(ms::Events::default());
        for (i, (e, m)) in self
            .input
            .moderator
            .intersections()
            .iter()
            .zip(&self.input.row_map)
            .enumerate()
        {
            let c = w.moderator.rows()?[i];
            let (ds, downer_volume, dpatch_volume) =
                match self.input.water_owners[m.owner].authority {
                    WaterAuthority::Closed => {
                        let dh = dy[self.water_row(m.owner, false)] * m.h_fraction;
                        (
                            ms::Stocks {
                                water_mass: 0.,
                                liquid_volume: 0.,
                                hydrogen_target: -dh,
                                hydrogen_product: dh,
                                mobile_boron10: -dy[self.water_row(m.owner, true)] * m.b_fraction,
                            },
                            0.,
                            0.,
                        )
                    }
                    WaterAuthority::External { index } => (
                        dexternal_water[index],
                        dgeometry.external_water_volumes[index],
                        dgeometry.moderator_volumes[i],
                    ),
                };
            // One owner-first law supplies value, material/shape direction and
            // held-geometry CSC partials. An empty union patch still has its
            // physical owner's concentration, so its entering limit is finite.
            let direction = self.input.moderator.row_direction(
                i,
                ds,
                downer_volume,
                dpatch_volume,
                &w.moderator,
            )?;
            let mut eh = 0.;
            let mut eb = 0.;
            for g in 0..GROUPS {
                let a = direction.hydrogen[g];
                let b = direction.boron[g];
                let pos = e.region * GROUPS + g;
                let ch = a * w.state[pos] + c.hydrogen[g] * dy[pos];
                let cb = b * w.state[pos] + c.boron[g] * dy[pos];
                eh += ch;
                eb += cb;
                w.jvp[pos] -= (a + b) * w.state[pos];
                w.collision_direction[e.region][g] += (a + b) / speed[g];
                let dscale = direction.scatter_scale;
                for h in 0..GROUPS {
                    let scatter = self.input.moderator.law().scatter[g][h];
                    w.collision_direction[e.region][g] += dscale * scatter;
                    if h != g {
                        let transfer = speed[g] * scatter * dscale * w.state[pos];
                        w.jvp[e.region * GROUPS + h] += transfer;
                        w.jvp[pos] -= transfer;
                    }
                }
            }
            match self.input.water_owners[m.owner].authority {
                WaterAuthority::Closed => {
                    w.jvp[self.water_row(m.owner, false)] += eh;
                    w.jvp[self.water_row(m.owner, true)] += eb;
                }
                WaterAuthority::External { index } => {
                    let out = &mut w.external_event_direction[index];
                    out.hydrogen += eh;
                    out.boron += eb;
                    let law = self.input.moderator.law();
                    out.emitted_charged +=
                        eh * law.hydrogen_emission[0] + eb * law.boron_emission[0];
                    out.emitted_photon +=
                        eh * law.hydrogen_emission[1] + eb * law.boron_emission[1];
                }
            }
            let law = self.input.moderator.law();
            w.water_event_direction[i] = ms::Events {
                hydrogen: eh,
                boron: eb,
                emitted_charged: eh * law.hydrogen_emission[0] + eb * law.boron_emission[0],
                emitted_photon: eh * law.hydrogen_emission[1] + eb * law.boron_emission[1],
            };
            net -= eh + eb;
        }
        for i in 0..self.input.targets.len() {
            w.amount_direction[i] = -self.target_consumption(dy, i);
        }
        let mut passive_birth = 0;
        w.passive_birth_direction.fill(0.);
        for (i, e) in self.input.passive_incidence.iter().enumerate() {
            let s = &self.input.passive_stocks[e.stock];
            let volume = w.geometry.passive_volumes[i];
            let dvolume = dgeometry.passive_volumes[i];
            for g in 0..GROUPS {
                w.collision_direction[e.region][g] += s.scatter_m1[g] * dvolume / volumes[e.region];
            }
            for t in &s.targets {
                for g in 0..GROUPS {
                    let factor = t.sigma_m2[g] / s.volume / volumes[e.region];
                    let pos = e.region * GROUPS + g;
                    let dcap = speed[g]
                        * factor
                        * (volume
                            * (w.amounts[t.index] * dy[pos]
                                + w.amount_direction[t.index] * w.state[pos])
                            + dvolume * w.amounts[t.index] * w.state[pos]);
                    w.jvp[pos] -= dcap;
                    w.jvp[self.target_row(t.index)] += dcap;
                    w.passive_birth_direction[passive_birth] += dcap;
                    net -= dcap;
                    w.collision_direction[e.region][g] += factor
                        * (volume * w.amount_direction[t.index] + dvolume * w.amounts[t.index]);
                }
                passive_birth += 1;
            }
        }
        for (i, e) in self.input.cylinder_incidence.iter().enumerate() {
            let t = &self.input.cylinder_targets[e.target];
            let c = w.cylinder.responses()?[e.target];
            for g in 0..GROUPS {
                let pos = e.region * GROUPS + g;
                let share = w.geometry.cylinder_shares[i];
                let dshare = dgeometry.cylinder_shares[i];
                let factor = share * speed[g] / volumes[e.region];
                let dfactor = dshare * speed[g] / volumes[e.region];
                let da = w.amount_direction[t.index];
                let dcap = factor
                    * (c.capture_m2[g] * dy[pos] + c.d_capture_d_amount[g] * da * w.state[pos])
                    + dfactor * c.capture_m2[g] * w.state[pos];
                w.jvp[pos] -= dcap;
                w.jvp[self.target_row(t.index)] += dcap;
                net -= dcap;
                collected += factor
                    * (c.collected_m2[g] * dy[pos] + c.d_collected_d_amount[g] * da * w.state[pos])
                    + dfactor * c.collected_m2[g] * w.state[pos];
                w.collision_direction[e.region][g] += (share * c.d_capture_d_amount[g] * da
                    + dshare * c.capture_m2[g])
                    / volumes[e.region];
            }
        }
        for (i, m) in self.optical.iter().enumerate() {
            m.jvp_dependencies(&w.amount_direction, &mut w.optical[i])?;
        }
        let mut oi = 0;
        for (f, coeff) in self
            .input
            .faces
            .iter()
            .zip(w.transport.face_coefficients()?)
        {
            let optical = matches!(
                f.law,
                ts::FaceLaw::Optical { .. } | ts::FaceLaw::InternalOptical { .. }
            );
            let right = f
                .right
                .or_else(|| matches!(f.law, ts::FaceLaw::InternalOptical { .. }).then_some(f.left));
            for g in 0..GROUPS {
                let l = f.left * GROUPS + g;
                let pl = speed[g] * w.state[l] / volumes[f.left];
                let dpl = speed[g] * dy[l] / volumes[f.left];
                let dt = if optical {
                    w.optical[oi].transmission_jvp[g]
                } else {
                    0.
                };
                let direction = [
                    w.collision_direction[f.left][g],
                    right.map_or(0., |r| w.collision_direction[r][g]),
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
                if let Some(r) = right {
                    let pos = r * GROUPS + g;
                    let pr = speed[g] * w.state[pos] / volumes[r];
                    let dpr = speed[g] * dy[pos] / volumes[r];
                    let exchange = dc(c.exchange) * (pr - pl) + c.exchange.value * (dpr - dpl);
                    let capl = dc(c.capture_left) * pl + c.capture_left.value * dpl;
                    let capr = dc(c.capture_right) * pr + c.capture_right.value * dpr;
                    w.jvp[l] += exchange - capl;
                    w.jvp[pos] -= exchange + capr;
                    net -= capl + capr;
                    if let ts::FaceLaw::Optical { targets }
                    | ts::FaceLaw::InternalOptical { targets } = &f.law
                    {
                        let o = &w.optical[oi];
                        let rl = c.capture_per_loss_left;
                        let rr = c.capture_per_loss_right;
                        for (j, &target) in targets.iter().enumerate() {
                            w.jvp[self.target_row(target)] += (dc(rl) * pl + rl.value * dpl)
                                * o.left_loss[j][g]
                                + rl.value * pl * o.left_loss_jvp[j][g]
                                + (dc(rr) * pr + rr.value * dpr) * o.right_loss[j][g]
                                + rr.value * pr * o.right_loss_jvp[j][g];
                        }
                    }
                } else {
                    let value = dc(c.escape) * pl + c.escape.value * dpl;
                    w.jvp[l] -= value;
                    net -= value;
                    escape += value;
                }
            }
            if optical {
                oi += 1;
            }
        }
        for (i, c) in w.target_capture_direction.iter_mut().enumerate() {
            *c = w.jvp[self.target_row(i)];
        }
        for (i, m) in self.input.mn.iter().enumerate() {
            let decay = m.decay_rate * dy[self.target_row(m.target)];
            w.jvp[self.target_row(m.target)] -= decay;
            w.jvp[self.mn_product_row(i)] = decay;
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
        for (out, s) in w.segment_release.iter_mut().zip(w.history.segment_jvp()?) {
            *out = self.input.history.prompt_fission_energy() * (s.sf235 + s.sf238)
                + s.delayed_release;
        }
        self.input.history.fuel().fuel_heat(
            w.history.achieved_event_jvp()?,
            self.input.history.prompt_fission_energy(),
            &w.segment_release,
            &mut w.fuel_deposition_direction,
        )?;
        if w.jvp.iter().any(|x| !x.is_finite())
            || w.external_event_direction.iter().any(|e| {
                ![e.hydrogen, e.boron, e.emitted_charged, e.emitted_photon]
                    .iter()
                    .all(|x| x.is_finite())
            })
        {
            return Err("Nonfinite full source JVP");
        }
        w.jvp_valid = true;
        Ok(())
    }
    /// Fixed-pattern `cj I - d(N,C)'/d(N,C)` at this workspace's prepared
    /// physical state. `cj=0` exposes the literal unshifted operator; a valid
    /// independently frozen workspace need not be the latest evaluated state.
    pub fn nc_values(&self, w: &Workspace, cj: f64, out: &mut [f64]) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &w.owner) {
            return Err("Foreign source N/C workspace");
        }
        w.check()?;
        if out.len() != self.pattern.len() || !cj.is_finite() || cj < 0. {
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
        for (i, e) in self.input.passive_incidence.iter().enumerate() {
            let s = &self.input.passive_stocks[e.stock];
            for t in &s.targets {
                for g in 0..GROUPS {
                    let k = speed[g]
                        * t.sigma_m2[g]
                        * w.amounts[t.index]
                        * w.geometry.passive_volumes[i]
                        / s.volume
                        / volumes[e.region];
                    out[self.lookup[&(e.region * GROUPS + g, e.region * GROUPS + g)]] += k;
                }
            }
        }
        for (i, e) in self.input.cylinder_incidence.iter().enumerate() {
            for g in 0..GROUPS {
                let k = speed[g]
                    * w.cylinder.responses()?[e.target].capture_m2[g]
                    * w.geometry.cylinder_shares[i]
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
}

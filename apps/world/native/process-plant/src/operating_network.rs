//! Offline cold, stable-liquid thermodynamic pressure territory.
//! Regional E/B and finite metal E remain conservative differential histories.
//! One finite aggregate mass fixes the thermodynamic pressure; thermal regions
//! are NOT independent compression stores. Relative mechanical pressure drives
//! signed quasi-steady links and pays the same shared donor pressure work.
//! EOS excludes that mechanical correction: this is an explicit cold pressure
//! approximation, not exact compressible entropy, phase or coastdown physics.
//! No pump, rotor, maintained boundary, nested chart inverse or acoustic mode.
use crate::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::collections::BTreeSet;
use std::sync::Arc;
mod hydraulic;
pub mod moving_chart;
pub mod moving_hydraulic;
use crate::sg_secondary::{Inventory as SecondaryInventory, State as SecondaryState};
pub use crate::sg_secondary::{Secondary, SecondaryHeat};
pub use hydraulic::{Hydraulic, HydraulicSegment, LossLaw, Seat};
pub use moving_hydraulic::{
    Connection as MovingConnection, Direction as MovingConnectionDirection,
};
pub const SOLID_DATUM_K: f64 = 300.;

/// Keep the signed inventory defect, rather than first rounding a large
/// positive inventory sum and then subtracting it. Small mass-chart defects
/// drive the shared pressure and therefore low-resistance connected flows.
/// This is the same physical chart for fixed and moving territories.
fn mass_chart_residual(total: f64, masses: &[f64]) -> f64 {
    let (mut sum, mut correction) = (total, 0.);
    for &mass in masses {
        let value = -mass;
        let next = sum + value;
        correction += if sum.abs() >= value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    sum + correction
}

#[derive(Clone, Copy, Debug)]
pub struct Water {
    pub geometry: CellGeometry,
    pub initial_pressure: f64,
    pub initial_temperature: f64,
    /// Passive mobile kg-equivalent/kg; not additional physical mass.
    pub initial_tracer_fraction: f64,
}
/// One same-trial transaction, signed INTO the liquid territory at `cell`.
/// The caller owns the finite neighbor and donor selection. Energy includes
/// the caller's actual enthalpy/gravity/work convention; this layer adds none.
#[derive(Clone, Copy, Debug)]
pub struct LiquidPort {
    pub cell: usize,
    pub mass_rate: f64,
    pub energy_rate: f64,
    pub marker_rate: f64,
}
/// Actual finite water geometry and its same-stage time contraction. EOS and
/// pressure-port datums remain the ORIGINAL fixed physical elevations.
#[derive(Clone, Copy, Debug, Default)]
pub struct WaterShape {
    pub volume_m3: f64,
    pub first_moment_m4: f64,
    pub volume_rate_m3_s: f64,
    pub first_moment_rate_m4_s: f64,
}
#[derive(Clone, Copy)]
pub struct MotionGeometry<'a> {
    pub water: &'a [WaterShape],
    pub connections: &'a [moving_hydraulic::Connection],
}
#[derive(Clone, Copy, Debug)]
pub struct Solid {
    pub heat_capacity: f64,
    pub initial_temperature: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum HeatLaw {
    Conductance(f64),
    LiquidFilm {
        geometry: f64,
    },
    SgSensible {
        area: f64,
        diameter: f64,
        flow_area: f64,
        hydraulic_edge: usize,
    },
}
#[derive(Clone, Copy, Debug)]
pub struct Heat {
    pub from: usize,
    pub to: usize,
    pub law: HeatLaw,
}
#[derive(Clone, Debug)]
pub struct Config {
    pub water: Vec<Water>,
    pub solids: Vec<Solid>,
    pub hydraulic: Vec<Hydraulic>,
    pub heat: Vec<Heat>,
    pub secondaries: Vec<Secondary>,
    pub secondary_heat: Vec<SecondaryHeat>,
    pub seat: Option<Seat>,
    pub prhr: Option<crate::prhr::Config>,
}

pub struct Network {
    config: Config,
    /// Fixed ORIGINAL hydrostatic offsets, not a reached-state projection.
    pressure_offsets: Vec<f64>,
    secondary_inventories: Vec<SecondaryInventory>,
    pub column_pointers: Vec<i64>,
    pub row_indices: Vec<i64>,
    energy_rate_slots: Vec<(usize, usize)>,
    owner: Arc<()>,
    prhr: Option<crate::prhr::Model>,
}
impl Network {
    pub fn new(config: Config) -> Result<Self, String> {
        let nw = config.water.len();
        if nw == 0
            || nw
                .checked_mul(4)
                .and_then(|x| x.checked_add(config.solids.len()))
                .and_then(|x| x.checked_add(config.hydraulic.len()))
                .and_then(|x| x.checked_add(1))
                .and_then(|x| {
                    config
                        .secondaries
                        .len()
                        .checked_mul(3)
                        .and_then(|s| x.checked_add(s))
                })
                .is_none()
        {
            return Err("Invalid pressure-territory size".into());
        }
        for w in &config.water {
            if ![
                w.geometry.volume,
                w.geometry.elevation,
                w.initial_pressure,
                w.initial_temperature,
                w.initial_tracer_fraction,
            ]
            .iter()
            .all(|x| x.is_finite())
                || w.geometry.volume <= 0.
                || w.initial_pressure <= 0.
                || w.initial_temperature <= 0.
                || w.initial_tracer_fraction < 0.
            {
                return Err("Invalid original water/geometry/tracer input".into());
            }
        }
        for s in &config.solids {
            if !s.heat_capacity.is_finite()
                || s.heat_capacity <= 0.
                || !s.initial_temperature.is_finite()
                || s.initial_temperature <= 0.
            {
                return Err("Invalid finite solid input".into());
            }
        }
        for edge in &config.hydraulic {
            if edge.from >= nw
                || edge.to >= nw
                || edge.from == edge.to
                || edge.segments.is_empty()
                || !edge.from_elevation.is_finite()
                || !edge.to_elevation.is_finite()
            {
                return Err("Invalid hydraulic incidence/serial geometry".into());
            }
            for e in &edge.segments {
                if !e.length.is_finite()
                    || e.length < 0.
                    || (e.length == 0. && e.fixed_loss <= 0.)
                    || !e.diameter.is_finite()
                    || e.diameter <= 0.
                    || !e.flow_area.is_finite()
                    || e.flow_area <= 0.
                    || !e.roughness.is_finite()
                    || e.roughness < 0.
                    || e.roughness / e.diameter > 0.1
                    || !e.fixed_loss.is_finite()
                    || e.fixed_loss < 0.
                    || !e.grid_multiplier.is_finite()
                    || e.grid_multiplier < 0.
                    || matches!(e.law,LossLaw::GuideAnnulus{laminar_darcy}
                    if !laminar_darcy.is_finite() || laminar_darcy<=0.)
                {
                    return Err("Invalid hydraulic contact".into());
                }
            }
        }
        if config.seat.is_some_and(|s| {
            s.edge >= config.hydraulic.len()
                || !s.area.is_finite()
                || s.area <= 0.
                || !s.full_open_loss.is_finite()
                || s.full_open_loss <= 0.
        }) {
            return Err("Invalid selected variable seat".into());
        }
        // One pressure territory and one mechanical gauge require a connected
        // incidence. This is topology rank, not a general phase/index proof.
        let mut seen = vec![false; nw];
        seen[0] = true;
        loop {
            let mut changed = false;
            for e in &config.hydraulic {
                if seen[e.from] && !seen[e.to] {
                    seen[e.to] = true;
                    changed = true;
                }
                if seen[e.to] && !seen[e.from] {
                    seen[e.from] = true;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        if seen.iter().any(|x| !x) {
            return Err("Disconnected pressure territory".into());
        }
        let nt = nw + config.solids.len();
        for e in &config.heat {
            if e.from >= nt || e.to >= nt || e.from == e.to {
                return Err("Invalid thermal contact".into());
            }
            let coefficient = match e.law {
                HeatLaw::Conductance(g) => g,
                HeatLaw::LiquidFilm { geometry } => {
                    if e.from >= nw || e.to < nw {
                        return Err("Liquid film requires water and solid".into());
                    }
                    geometry
                }
                HeatLaw::SgSensible {
                    area,
                    diameter,
                    flow_area,
                    hydraulic_edge,
                } => {
                    if e.from >= nw
                        || e.to < nw
                        || hydraulic_edge >= config.hydraulic.len()
                        || !diameter.is_finite()
                        || diameter <= 0.
                        || !flow_area.is_finite()
                        || flow_area <= 0.
                        || ![
                            config.hydraulic[hydraulic_edge].from,
                            config.hydraulic[hydraulic_edge].to,
                        ]
                        .contains(&e.from)
                    {
                        return Err("Invalid SG sensible-film incidence/geometry".into());
                    }
                    area
                }
            };
            if !coefficient.is_finite() || coefficient <= 0. {
                return Err("Nonpositive thermal contact".into());
            }
        }
        let anchor = config.water[0].initial_pressure;
        let secondary_inventories: Vec<_> = config
            .secondaries
            .iter()
            .map(|s| s.prepare().map(|x| x.0))
            .collect::<Result<_, _>>()?;
        for h in &config.secondary_heat {
            if h.solid >= config.solids.len()
                || h.secondary >= config.secondaries.len()
                || !h.area.is_finite()
                || h.area <= 0.
                || !h.diameter.is_finite()
                || h.diameter <= 0.
            {
                return Err("Invalid secondary thermal incidence/geometry".into());
            }
        }
        let pressure_offsets: Vec<_> = config
            .water
            .iter()
            .map(|w| w.initial_pressure - anchor)
            .collect();
        let prhr = config
            .prhr
            .clone()
            .map(|p| {
                crate::prhr::Model::new(
                    p,
                    4 * nw
                        + 1
                        + config.solids.len()
                        + config.hydraulic.len()
                        + 3 * config.secondaries.len(),
                    nw,
                    config.solids.len(),
                    config.hydraulic.len(),
                )
            })
            .transpose()?;
        if config.seat.is_some() != prhr.is_some() {
            return Err(
                "Selected PRHR requires its physical seat and finite receiver together".into(),
            );
        }
        let mut network = Self {
            config,
            pressure_offsets,
            secondary_inventories,
            column_pointers: vec![],
            row_indices: vec![],
            energy_rate_slots: vec![],
            owner: Arc::new(()),
            prhr,
        };
        let n = network.dimension();
        let mut pattern = vec![BTreeSet::new(); n];
        let p = network.pressure_row();
        let m = network.total_mass_row();
        for row in 0..network.stock_dimension() {
            pattern[row].insert(row);
        }
        pattern[m].insert(p);
        for i in 0..nw {
            let t = network.temperature_row(i);
            pattern[i].insert(t);
            pattern[p].insert(t);
            pattern[t].insert(t);
            pattern[p].insert(p);
            pattern[t].insert(p);
            // The reduced pressure-rate quotient is a global arrowhead, not
            // a hidden differentiated constraint or global finite difference.
            for j in 1..nw {
                let row = network.mechanical_row(j).unwrap();
                for col in [i, m, p, t] {
                    pattern[col].insert(row);
                }
            }
        }
        for (edge, e) in network.config.hydraulic.iter().enumerate() {
            let q = network.flow_row(edge);
            pattern[q].insert(q);
            pattern[p].insert(q);
            for node in [e.from, e.to] {
                let t = network.temperature_row(node);
                pattern[t].insert(q);
                if let Some(pi) = network.mechanical_row(node) {
                    pattern[pi].insert(q);
                }
                if let Some(row) = network.mechanical_row(node) {
                    pattern[q].insert(row);
                }
                for recipient in [e.from, e.to] {
                    pattern[q].insert(recipient);
                    pattern[q].insert(network.marker_row(recipient));
                    pattern[p].insert(recipient);
                    pattern[t].insert(recipient);
                    pattern[p].insert(network.marker_row(recipient));
                    pattern[t].insert(network.marker_row(recipient));
                    pattern[network.marker_row(node)].insert(network.marker_row(recipient));
                    if let Some(pi) = network.mechanical_row(node) {
                        pattern[pi].insert(recipient);
                    }
                }
            }
        }
        for e in &network.config.heat {
            let rows = [network.energy_row(e.from), network.energy_row(e.to)];
            for thermal in [e.from, e.to] {
                let column = if thermal < nw {
                    network.temperature_row(thermal)
                } else {
                    network.energy_row(thermal)
                };
                for row in rows {
                    pattern[column].insert(row);
                }
            }
            if matches!(
                e.law,
                HeatLaw::LiquidFilm { .. } | HeatLaw::SgSensible { .. }
            ) {
                for row in rows {
                    pattern[p].insert(row);
                }
            }
            if let HeatLaw::SgSensible { hydraulic_edge, .. } = e.law {
                for row in rows {
                    pattern[network.flow_row(hydraulic_edge)].insert(row);
                }
            }
        }
        for k in 0..network.config.secondaries.len() {
            let u = network.secondary_energy_row(k);
            let t = u + 1;
            let sp = u + 2;
            pattern[u].insert(u);
            pattern[u].insert(t);
            for col in [t, sp] {
                pattern[col].insert(t);
                pattern[col].insert(sp);
            }
        }
        for h in &network.config.secondary_heat {
            let u = network.secondary_energy_row(h.secondary);
            let metal = network.energy_row(nw + h.solid);
            for col in [metal, u + 1, u + 2] {
                for row in [metal, u] {
                    pattern[col].insert(row);
                }
            }
        }
        if let Some(prhr) = &network.prhr {
            let l = prhr.layout;
            for row in l.wst_start..l.dimension {
                pattern[row].insert(row);
            }
            for col in l.wst_start..l.wst_start + 4 {
                for row in l.wst_start..l.wst_start + 4 {
                    pattern[col].insert(row);
                }
                pattern[col].insert(l.gas_exported);
                pattern[col].insert(l.gas_mass_exported);
            }
            pattern[l.room_energy].insert(l.room_ambient_exported);
            for (i, c) in prhr.config.liquid_contacts.iter().enumerate() {
                let surface = l.surface_start + i;
                for col in [
                    p,
                    network.temperature_row(c.water),
                    network.flow_row(c.flow_edge),
                    network.energy_row(nw + c.solid),
                    surface,
                ] {
                    for row in [
                        network.energy_row(c.water),
                        network.energy_row(nw + c.solid),
                        surface,
                    ] {
                        pattern[col].insert(row);
                    }
                }
            }
            for (i, c) in prhr.config.pool_contacts.iter().enumerate() {
                let surface = l.surface_start + prhr.config.liquid_contacts.len() + i;
                for col in [
                    l.wst_start + 2,
                    l.wst_start + 3,
                    network.energy_row(nw + c.solid),
                    surface,
                ] {
                    for row in [l.wst_start + 1, network.energy_row(nw + c.solid), surface] {
                        pattern[col].insert(row);
                    }
                }
            }
            for c in &prhr.config.gas_contacts {
                pattern[network.energy_row(nw + c.solid)].insert(l.connector_exported);
            }
            for c in &prhr.config.mixing {
                for col in [
                    p,
                    network.temperature_row(c.from),
                    network.temperature_row(c.to),
                    network.temperature_row(c.sg_water),
                    network.flow_row(c.sg_flow_edge),
                    network.marker_row(c.from),
                    network.marker_row(c.to),
                ] {
                    for row in [
                        c.from,
                        c.to,
                        network.marker_row(c.from),
                        network.marker_row(c.to),
                    ] {
                        pattern[col].insert(row);
                    }
                }
            }
            for c in &prhr.config.axial {
                for col in [
                    p,
                    network.temperature_row(c.from),
                    network.temperature_row(c.to),
                ] {
                    pattern[col].insert(c.from);
                    pattern[col].insert(c.to);
                }
            }
        }
        network.column_pointers.push(0);
        for column in pattern {
            network
                .row_indices
                .extend(column.into_iter().map(|x| x as i64));
            network
                .column_pointers
                .push(network.row_indices.len() as i64);
        }
        let energy_rows = (0..network.config.water.len() + network.config.solids.len())
            .map(|i| network.energy_row(i))
            .chain((0..network.config.secondaries.len()).map(|i| network.secondary_energy_row(i)))
            .chain(network.prhr.iter().flat_map(|p| p.energy_rows()))
            .collect::<BTreeSet<_>>();
        for col in 0..network.dimension() {
            for slot in
                network.column_pointers[col] as usize..network.column_pointers[col + 1] as usize
            {
                if energy_rows.contains(&(network.row_indices[slot] as usize)) {
                    network.energy_rate_slots.push((col, slot));
                }
            }
        }
        Ok(network)
    }
    pub fn config(&self) -> &Config {
        &self.config
    }
    pub fn prhr(&self) -> Option<&crate::prhr::Model> {
        self.prhr.as_ref()
    }
    pub fn prhr_layout(&self) -> Option<crate::prhr::Layout> {
        self.prhr.as_ref().map(|p| p.layout)
    }
    pub fn installed_energy_rows(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.config.water.len() + self.config.solids.len())
            .map(|i| self.energy_row(i))
            .chain((0..self.config.secondaries.len()).map(|i| self.secondary_energy_row(i)))
            .chain(self.prhr.iter().flat_map(|p| p.energy_rows()))
    }
    fn check_ports(&self, ports: &[LiquidPort]) -> Result<(), String> {
        if ports.iter().any(|p| {
            p.cell >= self.config.water.len()
                || ![p.mass_rate, p.energy_rate, p.marker_rate]
                    .iter()
                    .all(|x| x.is_finite())
        }) {
            return Err("Invalid liquid port cell/transaction".into());
        }
        Ok(())
    }
    /// Add the exact constant incidence of port-rate DIRECTIONS to a complete
    /// residual tangent. The held-port CSC excludes the caller-owned response
    /// derivatives: the coupled caller must supply them here exactly once.
    /// `energy_rate_jvp` likewise needs the sum of these energy-rate directions
    /// when forming the complete open-territory energy-rate tangent.
    pub fn add_port_jvp(
        &self,
        directions: &[LiquidPort],
        action: &mut [f64],
    ) -> Result<(), String> {
        self.check_ports(directions)?;
        if action.len() != self.dimension() || action.iter().any(|x| !x.is_finite()) {
            return Err("Invalid liquid port tangent shape/value".into());
        }
        for p in directions {
            action[self.total_mass_row()] -= p.mass_rate;
            action[self.energy_row(p.cell)] -= p.energy_rate;
            action[self.marker_row(p.cell)] -= p.marker_rate;
            if let Some(row) = self.mechanical_row(p.cell) {
                action[row] -= p.mass_rate;
            }
        }
        if action.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite liquid port tangent".into());
        }
        Ok(())
    }
    pub fn mass(&self, node: usize, liquid: Liquid) -> f64 {
        self.config.water[node].geometry.volume * liquid.density
    }
    pub fn stock_dimension(&self) -> usize {
        2 * self.config.water.len() + 1 + self.config.solids.len()
    }
    pub fn pressure_row(&self) -> usize {
        self.stock_dimension()
    }
    pub fn temperature_row(&self, node: usize) -> usize {
        self.pressure_row() + 1 + node
    }
    pub fn flow_row(&self, edge: usize) -> usize {
        self.pressure_row() + 1 + self.config.water.len() + edge
    }
    pub fn mechanical_row(&self, node: usize) -> Option<usize> {
        (node > 0).then(|| self.flow_row(self.config.hydraulic.len()) + node - 1)
    }
    pub fn dimension(&self) -> usize {
        self.prhr.as_ref().map_or(
            self.base_dimension() + 3 * self.config.secondaries.len(),
            |p| p.layout.dimension,
        )
    }
    pub fn base_dimension(&self) -> usize {
        self.flow_row(self.config.hydraulic.len()) + self.config.water.len() - 1
    }
    pub fn secondary_energy_row(&self, k: usize) -> usize {
        self.base_dimension() + 3 * k
    }
    pub fn secondary_temperature_row(&self, k: usize) -> usize {
        self.secondary_energy_row(k) + 1
    }
    pub fn secondary_pressure_row(&self, k: usize) -> usize {
        self.secondary_energy_row(k) + 2
    }
    pub fn secondary_inventory(&self, k: usize) -> SecondaryInventory {
        self.secondary_inventories[k]
    }
    pub fn total_mass_row(&self) -> usize {
        2 * self.config.water.len()
    }
    pub fn marker_row(&self, node: usize) -> usize {
        self.config.water.len() + node
    }
    pub fn energy_row(&self, thermal: usize) -> usize {
        let nw = self.config.water.len();
        if thermal < nw {
            thermal
        } else {
            2 * nw + 1 + thermal - nw
        }
    }
    pub fn is_differential(&self, row: usize) -> bool {
        assert!(row < self.dimension());
        row < self.stock_dimension()
            || (row >= self.base_dimension()
                && row < self.base_dimension() + 3 * self.config.secondaries.len()
                && (row - self.base_dimension()) % 3 == 0)
            || self.prhr.as_ref().is_some_and(|p| {
                let l = p.layout;
                row == l.wst_start
                    || row == l.wst_start + 1
                    || row == l.room_energy
                    || row >= l.spring_released
            })
    }
    pub fn pressure_offset(&self, node: usize) -> f64 {
        self.pressure_offsets[node]
    }
    pub fn eos_pressure(&self, node: usize, y: &[f64]) -> f64 {
        y[self.pressure_row()] + self.pressure_offsets[node]
    }
    pub fn relative_pressure(&self, node: usize, y: &[f64]) -> f64 {
        self.mechanical_row(node).map_or(0., |r| y[r])
    }
    pub fn mechanical_pressure(&self, node: usize, y: &[f64]) -> f64 {
        self.eos_pressure(node, y) + self.relative_pressure(node, y)
    }
    /// Signed force head at the actual hydraulic ports. The shared absolute
    /// EOS pressure cancels analytically; diagnostics must not reconstruct it
    /// by subtracting two large total pressures. The second result is the sum
    /// of absolute arithmetic operands, not an additional physical head.
    /// Liquids are the caller's already prepared current EOS values: no query
    /// or stock recovery is performed here.
    pub fn hydraulic_drive(
        &self,
        edge: usize,
        y: &[f64],
        liquids: &[Liquid],
    ) -> Result<(f64, f64), String> {
        let e = self
            .config
            .hydraulic
            .get(edge)
            .ok_or("Hydraulic drive edge")?;
        self.hydraulic_drive_at(edge, e.from_elevation, e.to_elevation, y, liquids)
    }
    fn hydraulic_drive_at(
        &self,
        edge: usize,
        from_elevation: f64,
        to_elevation: f64,
        y: &[f64],
        liquids: &[Liquid],
    ) -> Result<(f64, f64), String> {
        if y.len() != self.dimension() || liquids.len() != self.config.water.len() {
            return Err("Hydraulic drive state/property shape".into());
        }
        let e = self
            .config
            .hydraulic
            .get(edge)
            .ok_or("Hydraulic drive edge")?;
        let dz = to_elevation - from_elevation;
        let ga =
            GRAVITY * (self.config.water[e.from].geometry.elevation - from_elevation - 0.5 * dz);
        let gb = GRAVITY * (to_elevation - self.config.water[e.to].geometry.elevation - 0.5 * dz);
        let (pa, pb) = (
            self.relative_pressure(e.from, y),
            self.relative_pressure(e.to, y),
        );
        let (ha, hb) = (ga * liquids[e.from].density, gb * liquids[e.to].density);
        let drive = self.pressure_offsets[e.from] - self.pressure_offsets[e.to] + pa - pb + ha + hb;
        let scale = self.pressure_offsets[e.from].abs()
            + self.pressure_offsets[e.to].abs()
            + pa.abs()
            + pb.abs()
            + ha.abs()
            + hb.abs();
        if !drive.is_finite()
            || !scale.is_finite()
            || ![liquids[e.from].density, liquids[e.to].density]
                .iter()
                .all(|v| v.is_finite() && *v > 0.)
        {
            return Err("Nonfinite hydraulic drive/property".into());
        }
        Ok((drive, scale))
    }
    pub fn temperature(&self, thermal: usize, y: &[f64]) -> f64 {
        let nw = self.config.water.len();
        if thermal < nw {
            y[self.temperature_row(thermal)]
        } else {
            SOLID_DATUM_K
                + y[self.energy_row(thermal)] / self.config.solids[thermal - nw].heat_capacity
        }
    }
    pub fn initial_state(&self) -> Result<Vec<f64>, String> {
        let queries: Vec<_> = self
            .config
            .water
            .iter()
            .map(|w| LiquidQuery {
                pressure: w.initial_pressure,
                temperature: w.initial_temperature,
            })
            .collect();
        let mut water = vec![Liquid::default(); queries.len()];
        liquid_batch(&queries, &mut water)
            .map_err(|e| format!("Original water {}: {}", e.index, e.message))?;
        let mut y = vec![0.; self.dimension()];
        y[self.pressure_row()] = self.config.water[0].initial_pressure;
        for (i, (w, l)) in self.config.water.iter().zip(water).enumerate() {
            let mass = w.geometry.volume * l.density;
            y[i] = mass * (l.internal_energy + GRAVITY * w.geometry.elevation);
            y[self.marker_row(i)] = mass * w.initial_tracer_fraction;
            y[self.total_mass_row()] += mass;
            y[self.temperature_row(i)] = w.initial_temperature;
        }
        for (i, s) in self.config.solids.iter().enumerate() {
            y[self.energy_row(self.config.water.len() + i)] =
                s.heat_capacity * (s.initial_temperature - SOLID_DATUM_K);
        }
        for (k, s) in self.config.secondaries.iter().enumerate() {
            let st = s.evaluate(
                self.secondary_inventory(k),
                s.initial_temperature,
                s.initial_pressure,
            )?;
            y[self.secondary_energy_row(k)] = st.energy;
            y[self.secondary_temperature_row(k)] = s.initial_temperature;
            y[self.secondary_pressure_row(k)] = s.initial_pressure;
        }
        if let Some(p) = &self.prhr {
            let l = p.layout;
            y[l.wst_start..l.wst_start + 4].copy_from_slice(&p.wst.prepare(p.config.gas)?);
            y[l.room_energy] = p.actuator.prepare()[crate::prhr_actuator::ROOM_ENERGY];
            for (i, c) in p.config.liquid_contacts.iter().enumerate() {
                y[l.surface_start + i] = self.temperature(self.config.water.len() + c.solid, &y);
            }
            for (i, c) in p.config.pool_contacts.iter().enumerate() {
                y[l.surface_start + p.config.liquid_contacts.len() + i] =
                    self.temperature(self.config.water.len() + c.solid, &y);
            }
        }
        if y.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite original stock".into());
        }
        // q/pi=0 is ONLY an initialization guess. Joint consistent preparation
        // must solve heat-driven expansion and the actual head/loss constraints.
        Ok(y)
    }
}

pub struct Workspace {
    pub residual: Vec<f64>,
    pub rates: Vec<f64>,
    pub jacobian_values: Vec<f64>,
    pub liquids: Vec<Liquid>,
    pub mass_flows: Vec<f64>,
    pub heat_flows: Vec<f64>,
    pub chart_mass: Vec<f64>,
    pub chart_energy: Vec<f64>,
    /// M_p,M_T,E_p,E_T, with independent P/T and fixed original offsets.
    pub chart_derivatives: Vec<[f64; 4]>,
    /// a=M_p-M_T E_p/E_T; b=M_T/E_T.
    pub redistribution: Vec<[f64; 2]>,
    /// Current geometry, with actual time contractions; no new stock owner.
    pub water_shapes: Vec<WaterShape>,
    /// Pressure traction work into each finite water owner, before wall work.
    pub shape_pressure_work_w: Vec<f64>,
    pub pressure_rate: f64,
    pub mass_rates: Vec<f64>,
    pub heat_entropy_production: f64,
    pub property_requests: usize,
    pub film_nusselt: Vec<f64>,
    pub film_raw_prandtl_ratio: Vec<f64>,
    pub secondary_states: Vec<SecondaryState>,
    pub secondary_heat_flows: Vec<f64>,
    pub prhr: Option<crate::prhr::Workspace>,
    queries: Vec<LiquidQuery>,
    probe_queries: Vec<LiquidQuery>,
    probes: Vec<Liquid>,
    // mu_p,mu_T,k_p,k_T,a_p,a_T,b_p,b_T,cp_p,cp_T; bounded LOCAL probes.
    local_derivatives: Vec<[f64; 10]>,
    energy_rate_partials: Vec<f64>,
    owner: Arc<()>,
    energy_rate_valid: bool,
    chart_state: Vec<f64>,
    chart_rates: Vec<f64>,
    shape_mass_rates: Vec<f64>,
    shape_rate_partials: Vec<[f64; 2]>,
    moving_connections: Vec<moving_hydraulic::Connection>,
    moving_responses: Vec<moving_hydraulic::Response>,
    moving_by_edge: Vec<Option<usize>>,
    shape_chart_directions: Vec<[f64; 3]>,
    chart_valid: bool,
}
fn chart(w: Water, l: Liquid, p: f64, t: f64) -> Result<([f64; 4], [f64; 2]), String> {
    let c = moving_chart::inventory_chart(
        w.geometry,
        moving_chart::ShapeDirection {
            volume_m2: 0.,
            first_moment_m3: 0.,
        },
        l,
        p,
        t,
    )?;
    Ok((
        c.thermal_partials,
        [c.redistribution[0], c.redistribution[1]],
    ))
}
impl Workspace {
    fn evaluate_prhr(
        &mut self,
        n: &Network,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        input: crate::prhr::Input,
    ) -> Result<(), String> {
        use crate::finite_wst as pool;
        let p = n.prhr.as_ref().ok_or("Missing selected PRHR owner")?;
        let l = p.layout;
        let nw = n.config.water.len();
        let mut w = self.prhr.take().ok_or("Missing selected PRHR workspace")?;
        let result = (|| {
            w.pool_heat_w = 0.;
            w.connector_export_w = 0.;
            w.property_requests = 0;
            w.input = Some(input);
            let wy: [f64; 4] = y[l.wst_start..l.wst_start + 4].try_into().unwrap();
            let wyp: [f64; 4] = yp[l.wst_start..l.wst_start + 4].try_into().unwrap();
            p.wst.evaluate(&wy, &wyp, 0., p.config.gas, &mut w.wst)?;
            w.mixing
                .resize(p.config.mixing.len(), crate::prhr::MixingState::default());
            for (i, c) in p.config.mixing.iter().enumerate() {
                let sg = self.liquids[c.sg_water];
                let velocity = self.mass_flows[c.sg_flow_edge] / (sg.density * c.sg_flow_area);
                let pressure = 0.5 * (n.eos_pressure(c.from, y) + n.eos_pressure(c.to, y));
                let r = crate::prhr_mixing::evaluate(
                    c,
                    pressure,
                    n.temperature(c.from, y),
                    n.temperature(c.to, y),
                    velocity,
                    cj.is_some(),
                    &mut w.property_requests,
                )?;
                let chain = |d: [f64; 4]| {
                    [
                        d[0] - d[3] * velocity * sg.compressibility,
                        d[1],
                        d[2],
                        d[3] * velocity * sg.expansion,
                        d[3] / (sg.density * c.sg_flow_area),
                    ]
                };
                let heat = chain(r.heat_partials);
                let scalar = chain(r.scalar_partials);
                w.mixing[i] = crate::prhr::MixingState {
                    coefficient: r.scalar_kg_s,
                    partials: scalar,
                };
                self.rates[c.from] -= r.heat_w;
                self.rates[c.to] += r.heat_w;
                self.residual[c.from] += r.heat_w;
                self.residual[c.to] -= r.heat_w;
                let concentrations = [
                    y[n.marker_row(c.from)] / self.chart_mass[c.from],
                    y[n.marker_row(c.to)] / self.chart_mass[c.to],
                ];
                let contrast = concentrations[0] - concentrations[1];
                let flux = r.scalar_kg_s * contrast;
                self.rates[n.marker_row(c.from)] -= flux;
                self.rates[n.marker_row(c.to)] += flux;
                self.residual[n.marker_row(c.from)] += flux;
                self.residual[n.marker_row(c.to)] -= flux;
                if cj.is_some() {
                    let cols = [
                        n.pressure_row(),
                        n.temperature_row(c.from),
                        n.temperature_row(c.to),
                        n.temperature_row(c.sg_water),
                        n.flow_row(c.sg_flow_edge),
                    ];
                    for j in 0..5 {
                        self.add(n, c.from, cols[j], heat[j]);
                        self.add(n, c.to, cols[j], -heat[j]);
                        self.add(n, n.marker_row(c.from), cols[j], scalar[j] * contrast);
                        self.add(n, n.marker_row(c.to), cols[j], -scalar[j] * contrast);
                    }
                    for (index, (node, sign)) in [(c.from, 1.), (c.to, -1.)].into_iter().enumerate()
                    {
                        let l = self.liquids[node];
                        let conc = concentrations[index];
                        for (col, dconc) in [
                            (n.marker_row(node), 1. / self.chart_mass[node]),
                            (n.pressure_row(), -conc * l.compressibility),
                            (n.temperature_row(node), conc * l.expansion),
                        ] {
                            let value = r.scalar_kg_s * sign * dconc;
                            self.add(n, n.marker_row(c.from), col, value);
                            self.add(n, n.marker_row(c.to), col, -value);
                        }
                    }
                }
            }
            for c in &p.config.axial {
                let a = self.liquids[c.from];
                let b = self.liquids[c.to];
                let sum = a.conductivity + b.conductivity;
                let harmonic = 2. * a.conductivity * b.conductivity / sum;
                let contrast = n.temperature(c.from, y) - n.temperature(c.to, y);
                let area = c.area * if c.seat { input.opening } else { 1. };
                let g = harmonic * area / c.separation;
                let q = g * contrast;
                self.rates[c.from] -= q;
                self.rates[c.to] += q;
                self.residual[c.from] += q;
                self.residual[c.to] -= q;
                if cj.is_some() {
                    let da =
                        2. * b.conductivity * b.conductivity / (sum * sum) * area / c.separation;
                    let db =
                        2. * a.conductivity * a.conductivity / (sum * sum) * area / c.separation;
                    for (col, dq) in [
                        (
                            n.pressure_row(),
                            contrast
                                * (da * self.local_derivatives[c.from][2]
                                    + db * self.local_derivatives[c.to][2]),
                        ),
                        (
                            n.temperature_row(c.from),
                            g + contrast * da * self.local_derivatives[c.from][3],
                        ),
                        (
                            n.temperature_row(c.to),
                            -g + contrast * db * self.local_derivatives[c.to][3],
                        ),
                    ] {
                        self.add(n, c.from, col, dq);
                        self.add(n, c.to, col, -dq);
                    }
                }
            }
            for (i, c) in p.config.liquid_contacts.iter().enumerate() {
                let surface = l.surface_start + i;
                let metal = n.energy_row(nw + c.solid);
                let cap = n.config.solids[c.solid].heat_capacity;
                let temperature = n.temperature(nw + c.solid, y);
                let (v, d) = sensible_with_partials(
                    n.eos_pressure(c.water, y),
                    n.temperature(c.water, y),
                    y[surface],
                    self.mass_flows[c.flow_edge],
                    c.area,
                    c.diameter,
                    c.flow_area,
                    cj.is_some(),
                    &mut w.property_requests,
                )?;
                let fraction = c.weight.fraction(input.opening);
                let q = fraction * v.0;
                self.rates[c.water] -= q;
                self.rates[metal] += q;
                self.residual[c.water] += q;
                self.residual[metal] -= q;
                self.residual[surface] = y[surface] - temperature - c.half_resistance * v.0;
                if cj.is_some() {
                    for (col, partial) in [
                        (n.pressure_row(), d[0]),
                        (n.temperature_row(c.water), d[1]),
                        (surface, d[2]),
                        (n.flow_row(c.flow_edge), d[3]),
                    ] {
                        self.add(n, c.water, col, fraction * partial);
                        self.add(n, metal, col, -fraction * partial);
                        self.add(n, surface, col, -c.half_resistance * partial);
                    }
                    self.add(n, surface, surface, 1.);
                    self.add(n, surface, metal, -1. / cap);
                }
            }
            for (i, c) in p.config.pool_contacts.iter().enumerate() {
                let surface = l.surface_start + p.config.liquid_contacts.len() + i;
                let metal = n.energy_row(nw + c.solid);
                let cap = n.config.solids[c.solid].heat_capacity;
                let temperature = n.temperature(nw + c.solid, y);
                let pressure = w.wst.local_pressure_pa(c.elevation)?;
                let (q, d) = crate::sg_secondary::heat_with_partials(
                    wy[pool::TEMPERATURE],
                    pressure,
                    y[surface],
                    c.area * c.bank_factor,
                    c.diameter,
                    cj.is_some(),
                    &mut w.property_requests,
                )?;
                w.pool_heat_w += q;
                self.rates[metal] -= q;
                self.residual[metal] += q;
                self.residual[surface] = y[surface] - temperature + c.half_resistance * q;
                if cj.is_some() {
                    let depth = w.wst.surface_height_m - c.elevation;
                    let dpdt = -w.wst.liquid.density * w.wst.liquid.expansion * GRAVITY * depth;
                    let dpdv = w.wst.liquid.density * GRAVITY / p.config.wst.area_m2;
                    for (col, partial) in [
                        (l.wst_start + pool::TEMPERATURE, d[0] + d[1] * dpdt),
                        (l.wst_start + pool::VOLUME, d[1] * dpdv),
                        (surface, d[2]),
                    ] {
                        self.add(n, metal, col, partial);
                        self.add(n, l.wst_start + pool::ENERGY, col, -partial);
                        self.add(n, surface, col, c.half_resistance * partial);
                    }
                    self.add(n, surface, surface, 1.);
                    self.add(n, surface, metal, -1. / cap);
                }
            }
            for c in &p.config.gas_contacts {
                let metal = n.energy_row(nw + c.solid);
                let q =
                    c.conductance * (n.temperature(nw + c.solid, y) - p.config.gas.temperature_k);
                w.connector_export_w += q;
                self.rates[metal] -= q;
                self.residual[metal] += q;
                if cj.is_some() {
                    let partial = c.conductance / n.config.solids[c.solid].heat_capacity;
                    self.add(n, metal, metal, partial);
                    self.add(n, l.connector_exported, metal, -partial);
                }
            }
            w.wst.add_heat(w.pool_heat_w)?;
            for i in 0..4 {
                self.residual[l.wst_start + i] = w.wst.residual[i];
            }
            self.rates[l.wst_start + pool::MASS] = -w.wst.surface_mass_rate_kg_s;
            self.rates[l.wst_start + pool::ENERGY] = w.pool_heat_w - w.wst.gas_export_rate_w;
            if let Some(cj) = cj {
                let matrix = w.wst.jacobian(cj)?;
                for (i, row) in matrix.iter().enumerate() {
                    for (j, &value) in row.iter().enumerate() {
                        self.add(n, l.wst_start + i, l.wst_start + j, value);
                    }
                }
                for j in 0..4 {
                    let mut direction = [0.; 4];
                    direction[j] = 1.;
                    self.add(
                        n,
                        l.gas_exported,
                        l.wst_start + j,
                        -w.wst.gas_export_jvp(&direction, cj)?,
                    );
                    self.add(
                        n,
                        l.gas_mass_exported,
                        l.wst_start + j,
                        -matrix[pool::MASS][j] + if j == pool::MASS { cj } else { 0. },
                    );
                }
            }
            w.room_temperature_k = p.config.actuator.room_reference_temperature_k
                + y[l.room_energy] / p.config.actuator.room_capacity_j_k;
            if !w.room_temperature_k.is_finite() || w.room_temperature_k <= 0. {
                return Err("Invalid finite PRHR ROOM.A temperature".into());
            }
            w.room_ambient_export_w = p.config.actuator.room_wall_w_k
                * (w.room_temperature_k - input.ambient_temperature_k);
            w.spring_release_w = p.config.actuator.spring_energy_j * input.opening_rate;
            w.electrical_receipt_w = input.electrical_receipt_w;
            w.room_heat_w = input.room_heat_w;
            self.rates[l.room_energy] = input.room_heat_w - w.room_ambient_export_w;
            self.residual[l.room_energy] = yp[l.room_energy] - self.rates[l.room_energy];
            for (row, rate) in [
                (l.spring_released, w.spring_release_w),
                (l.gas_exported, w.wst.gas_export_rate_w),
                (l.connector_exported, w.connector_export_w),
                (l.gas_mass_exported, w.wst.surface_mass_rate_kg_s),
                (l.electrical_received, input.electrical_receipt_w),
                (l.room_ambient_exported, w.room_ambient_export_w),
            ] {
                self.rates[row] = rate;
                self.residual[row] = yp[row] - rate;
                if let Some(cj) = cj {
                    self.add(n, row, row, cj);
                }
            }
            if let Some(cj) = cj {
                let partial = p.config.actuator.room_wall_w_k / p.config.actuator.room_capacity_j_k;
                self.add(n, l.room_energy, l.room_energy, cj + partial);
                self.add(n, l.room_ambient_exported, l.room_energy, -partial);
            }
            self.property_requests += w.property_requests;
            Ok(())
        })();
        self.prhr = Some(w);
        result
    }
    pub fn new(n: &Network) -> Self {
        let nw = n.config.water.len();
        let nh = n.config.heat.len();
        Self {
            residual: vec![0.; n.dimension()],
            rates: vec![0.; n.dimension()],
            jacobian_values: vec![0.; n.row_indices.len()],
            liquids: vec![Liquid::default(); nw],
            mass_flows: vec![0.; n.config.hydraulic.len()],
            heat_flows: vec![0.; nh],
            chart_mass: vec![0.; nw],
            chart_energy: vec![0.; nw],
            chart_derivatives: vec![[0.; 4]; nw],
            redistribution: vec![[0.; 2]; nw],
            water_shapes: n
                .config
                .water
                .iter()
                .map(|w| WaterShape {
                    volume_m3: w.geometry.volume,
                    first_moment_m4: w.geometry.volume * w.geometry.elevation,
                    ..WaterShape::default()
                })
                .collect(),
            shape_pressure_work_w: vec![0.; nw],
            pressure_rate: 0.,
            mass_rates: vec![0.; nw],
            heat_entropy_production: 0.,
            property_requests: 0,
            film_nusselt: vec![0.; nh],
            film_raw_prandtl_ratio: vec![0.; nh],
            secondary_states: vec![SecondaryState::default(); n.config.secondaries.len()],
            secondary_heat_flows: vec![0.; n.config.secondary_heat.len()],
            prhr: n.prhr.as_ref().map(|_| crate::prhr::Workspace::default()),
            queries: vec![
                LiquidQuery {
                    pressure: 0.,
                    temperature: 0.
                };
                nw
            ],
            probe_queries: vec![
                LiquidQuery {
                    pressure: 0.,
                    temperature: 0.
                };
                4 * nw
            ],
            probes: vec![Liquid::default(); 4 * nw],
            local_derivatives: vec![[0.; 10]; nw],
            energy_rate_partials: vec![0.; n.energy_rate_slots.len()],
            owner: n.owner.clone(),
            energy_rate_valid: false,
            chart_state: vec![0.; n.dimension()],
            chart_rates: vec![0.; n.dimension()],
            shape_mass_rates: vec![0.; nw],
            shape_rate_partials: vec![[0.; 2]; nw],
            moving_connections: vec![],
            moving_responses: vec![],
            moving_by_edge: vec![None; n.config.hydraulic.len()],
            shape_chart_directions: vec![[0.; 3]; nw],
            chart_valid: false,
        }
    }
    /// Read-only physical chart consumers must use this owner's successful
    /// preparation at the exact supplied current state, not a stale trial.
    pub fn check_current_chart(&self, n: &Network, y: &[f64]) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &n.owner)
            || !self.chart_valid
            || y.len() != n.dimension()
            || self.chart_state.len() != y.len()
            || self
                .chart_state
                .iter()
                .zip(y)
                .any(|(a, b)| a.to_bits() != b.to_bits())
        {
            return Err("Network chart requires current owned value preparation".into());
        }
        Ok(())
    }
    /// Same retained local property probes used by the network Jacobian.
    /// Caller must have evaluated this workspace with cj=Some at this trial.
    /// Return viscosity, conductivity and cp directions; no second EOS call.
    pub fn film_property_direction(&self, node: usize, dp: f64, dt: f64) -> [f64; 3] {
        let d = self.local_derivatives[node];
        [
            d[0] * dp + d[1] * dt,
            d[2] * dp + d[3] * dt,
            d[8] * dp + d[9] * dt,
        ]
    }
    pub fn moving_responses(&self) -> Result<&[moving_hydraulic::Response], String> {
        if !self.chart_valid {
            return Err("Moving traction requires current network preparation".into());
        }
        Ok(&self.moving_responses)
    }
    /// Actual endpoint head, including current moving ports. Admission must
    /// use this view rather than reconstructing a fixed-geometry connection.
    pub fn current_hydraulic_drive(&self, n: &Network, edge: usize) -> Result<(f64, f64), String> {
        self.check_current_chart(n, &self.chart_state)?;
        if edge >= n.config.hydraulic.len() {
            return Err("Current hydraulic edge".into());
        }
        let e = &n.config.hydraulic[edge];
        let (from, to) =
            self.moving_by_edge[edge].map_or((e.from_elevation, e.to_elevation), |i| {
                let c = self.moving_connections[i];
                (c.from_elevation_m, c.to_elevation_m)
            });
        n.hydraulic_drive_at(edge, from, to, &self.chart_state, &self.liquids)
    }
    pub fn current_hydraulic_loss(&self, n: &Network, edge: usize) -> Result<[f64; 4], String> {
        self.check_current_chart(n, &self.chart_state)?;
        let e = n
            .config
            .hydraulic
            .get(edge)
            .ok_or("Current hydraulic loss edge")?;
        if let Some(i) = self.moving_by_edge[edge] {
            let r = self.moving_responses[i];
            Ok([
                r.loss_pa,
                r.loss_partials[0],
                r.loss_partials[2],
                r.loss_partials[1],
            ])
        } else {
            Ok(e.pressure_loss(
                self.chart_state[n.flow_row(edge)],
                0.5 * (self.liquids[e.from].density + self.liquids[e.to].density),
                0.5 * (self.liquids[e.from].viscosity + self.liquids[e.to].viscosity),
            ))
        }
    }
    pub fn moving_connection(&self, edge: usize) -> Result<Option<MovingConnection>, String> {
        if !self.chart_valid || edge >= self.moving_by_edge.len() {
            return Err("Current moving connection needs owned chart".into());
        }
        Ok(self.moving_by_edge[edge].map(|i| self.moving_connections[i]))
    }
    /// At positive slope retain the existing linear held-head diagnostic.
    /// A real mouth at exact rest instead uses its actual finite +/- flow
    /// allocation loss increments. Neither is a coupled Newton-error bound.
    pub fn hydraulic_diagnostic_band(
        &self,
        n: &Network,
        edge: usize,
        flow_atol: f64,
    ) -> Result<f64, String> {
        if !flow_atol.is_finite() || flow_atol <= 0. {
            return Err("Invalid current flow diagnostic allocation".into());
        }
        let loss = self.current_hydraulic_loss(n, edge)?;
        if loss[1] > 0. {
            return Ok(loss[1] * flow_atol);
        }
        let e = &n.config.hydraulic[edge];
        let q = self.chart_state[n.flow_row(edge)];
        let rho = 0.5 * (self.liquids[e.from].density + self.liquids[e.to].density);
        let mu = 0.5 * (self.liquids[e.from].viscosity + self.liquids[e.to].viscosity);
        let value = |q| -> Result<f64, String> {
            if let Some(i) = self.moving_by_edge[edge] {
                Ok(self.moving_connections[i].law.evaluate(q, rho, mu)?.loss_pa)
            } else {
                Ok(e.pressure_loss(q, rho, mu)[0])
            }
        };
        let band = (value(q + flow_atol)? - loss[0]).min(loss[0] - value(q - flow_atol)?);
        if !band.is_finite() || band <= 0. {
            return Err("Unresolvable actual mouth diagnostic band".into());
        }
        Ok(band)
    }
    /// Inner-wall traction/work direction from the SAME prepared local
    /// response; no repeated constitutive law or EOS call during a Krylov JVP.
    pub fn moving_response_direction(
        &self,
        n: &Network,
        index: usize,
        dstate: &[f64],
        geometry: moving_hydraulic::Direction,
    ) -> Result<moving_hydraulic::ResponseDirection, String> {
        if !Arc::ptr_eq(&self.owner, &n.owner)
            || !self.energy_rate_valid
            || dstate.len() != n.dimension()
            || dstate.iter().any(|v| !v.is_finite())
        {
            return Err("Moving traction direction needs current Jacobian/state".into());
        }
        let c = self
            .moving_connections
            .get(index)
            .ok_or("Moving traction index")?;
        let e = &n.config.hydraulic[c.edge];
        let dp = dstate[n.pressure_row()];
        let mut drho = 0.;
        let mut dmu = 0.;
        for node in [e.from, e.to] {
            let l = self.liquids[node];
            let dt = dstate[n.temperature_row(node)];
            drho += 0.5 * l.density * (l.compressibility * dp - l.expansion * dt);
            dmu +=
                0.5 * (self.local_derivatives[node][0] * dp + self.local_derivatives[node][1] * dt);
        }
        self.moving_responses[index].direction([
            dstate[n.flow_row(c.edge)],
            drho,
            dmu,
            geometry.speed_m_s,
            geometry.length_m,
        ])
    }
    /// Add only the current-geometry/time-contraction chain to a held-geometry
    /// network Jacobian action. State/property chains are already in its CSC.
    /// The returned scalar is the independently formed installed-energy RATE
    /// direction, before any cj shift; it is not assumed to be zero.
    pub fn add_motion_jvp(
        &mut self,
        n: &Network,
        water: &[WaterShape],
        connections: &[moving_hydraulic::Direction],
        action: &mut [f64],
    ) -> Result<f64, String> {
        let nw = n.config.water.len();
        if !Arc::ptr_eq(&self.owner, &n.owner)
            || !self.energy_rate_valid
            || !self.chart_valid
            || water.len() != nw
            || connections.len() != self.moving_connections.len()
            || action.len() != n.dimension()
            || action.iter().any(|v| !v.is_finite())
            || water.iter().any(|s| {
                [
                    s.volume_m3,
                    s.first_moment_m4,
                    s.volume_rate_m3_s,
                    s.first_moment_rate_m4_s,
                ]
                .iter()
                .any(|v| !v.is_finite())
            })
            || connections.iter().any(|s| {
                [
                    s.from_elevation_m,
                    s.to_elevation_m,
                    s.length_m,
                    s.speed_m_s,
                ]
                .iter()
                .any(|v| !v.is_finite())
            })
        {
            return Err("Invalid current moving network direction".into());
        }
        let y = &self.chart_state;
        let yp = &self.chart_rates;
        let mut energy_rate = 0.;
        let mut pressure_numerator = 0.;
        let sum_a = self.redistribution.iter().map(|x| x[0]).sum::<f64>();
        for i in 0..nw {
            let l = self.liquids[i];
            let q = self.queries[i];
            let s = self.water_shapes[i];
            let d = water[i];
            let [_, _, ep, et] = self.chart_derivatives[i];
            let b = self.redistribution[i][1];
            let dum = l.internal_energy * d.volume_m3 + GRAVITY * d.first_moment_m4;
            let dmp = l.density * l.compressibility * d.volume_m3;
            let dmt = -l.density * l.expansion * d.volume_m3;
            let dep = l.density * l.compressibility * dum
                + d.volume_m3 * (q.pressure * l.compressibility - q.temperature * l.expansion);
            let det = -l.density * l.expansion * dum
                + d.volume_m3 * (l.density * l.cp - q.pressure * l.expansion);
            let db = (dmt - b * det) / et;
            let da = dmp - b * dep - ep * db;
            let eyrate = l.density
                * (l.internal_energy * s.volume_rate_m3_s + GRAVITY * s.first_moment_rate_m4_s);
            let deyrate = l.density
                * (l.internal_energy * d.volume_rate_m3_s + GRAVITY * d.first_moment_rate_m4_s);
            let dc = l.density * d.volume_rate_m3_s - db * eyrate - b * deyrate;
            self.shape_chart_directions[i] = [da, db, dc];
            pressure_numerator -= db * yp[i] + dc + da * self.pressure_rate;
            action[n.pressure_row()] -= l.density * d.volume_m3;
            action[n.temperature_row(i)] -= l.density * dum;
            let phead = q.pressure
                + n.relative_pressure(i, y)
                + l.density * GRAVITY * n.config.water[i].geometry.elevation;
            let dw = -phead * d.volume_rate_m3_s + l.density * GRAVITY * d.first_moment_rate_m4_s;
            action[i] -= dw;
            energy_rate += dw;
        }
        let dp_rate = pressure_numerator / sum_a;
        for i in 1..nw {
            let [da, db, dc] = self.shape_chart_directions[i];
            action[n.mechanical_row(i).unwrap()] +=
                da * self.pressure_rate + self.redistribution[i][0] * dp_rate + db * yp[i] + dc;
        }
        for (edge, e) in n.config.hydraulic.iter().enumerate() {
            let q = y[n.flow_row(edge)];
            let donor = if q >= 0. { e.from } else { e.to };
            let dm = self.liquids[donor].density * water[donor].volume_m3;
            let dc = -y[n.marker_row(donor)] / self.chart_mass[donor] * dm / self.chart_mass[donor];
            action[n.marker_row(e.from)] += q * dc;
            action[n.marker_row(e.to)] -= q * dc;
        }
        for ((c, r), d) in self
            .moving_connections
            .iter()
            .zip(&self.moving_responses)
            .zip(connections)
        {
            let e = &n.config.hydraulic[c.edge];
            let rho_a = self.liquids[e.from].density;
            let rho_b = self.liquids[e.to].density;
            let ddrive = 0.5 * GRAVITY * (rho_b - rho_a) * (d.from_elevation_m + d.to_elevation_m);
            let dr = r.direction([0., 0., 0., d.speed_m_s, d.length_m])?;
            action[n.flow_row(c.edge)] += ddrive - dr.loss_pa;
            action[c.fluid_work_cell] -= dr.fluid_wall_work_w;
            energy_rate += dr.fluid_wall_work_w;
        }
        if action.iter().any(|v| !v.is_finite()) || !energy_rate.is_finite() {
            return Err("Nonfinite moving network chain".into());
        }
        Ok(energy_rate)
    }
    /// Aggregate installed-energy RATE tangent, saved before any cj shift.
    /// Uses the existing independently assembled sparse energy rows, not an
    /// assumed conservative zero and not subtraction of large shifted actions.
    pub fn energy_rate_jvp(&self, n: &Network, direction: &[f64]) -> Result<f64, String> {
        if !Arc::ptr_eq(&self.owner, &n.owner)
            || !self.energy_rate_valid
            || direction.len() != n.dimension()
            || direction.iter().any(|v| !v.is_finite())
        {
            return Err("Network energy-rate tangent needs current owned Jacobian".into());
        }
        let (mut s, mut c) = (0f64, 0f64);
        for (&partial, &(col, _)) in self.energy_rate_partials.iter().zip(&n.energy_rate_slots) {
            let v = partial * direction[col];
            let t = s + v;
            c += if s.abs() >= v.abs() {
                (s - t) + v
            } else {
                (v - t) + s
            };
            s = t;
        }
        let result = s + c;
        if !result.is_finite() {
            return Err("Nonfinite network energy-rate tangent".into());
        }
        Ok(result)
    }
    pub fn visit_energy_rate_partials(
        &self,
        n: &Network,
        mut emit: impl FnMut(usize, usize, f64),
    ) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &n.owner) || !self.energy_rate_valid {
            return Err("Network energy-rate partials need current owned Jacobian".into());
        }
        for (&value, &(col, slot)) in self.energy_rate_partials.iter().zip(&n.energy_rate_slots) {
            emit(n.row_indices[slot] as usize, col, value);
        }
        Ok(())
    }
    fn add(&mut self, n: &Network, row: usize, col: usize, v: f64) {
        let start = n.column_pointers[col] as usize;
        let end = n.column_pointers[col + 1] as usize;
        let slot = n.row_indices[start..end]
            .binary_search(&(row as i64))
            .expect("Compiled pressure-territory incidence");
        self.jacobian_values[start + slot] += v;
    }
    pub fn evaluate(
        &mut self,
        n: &Network,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
    ) -> Result<(), String> {
        self.evaluate_with_ports(n, y, yp, cj, &[])
    }
    /// Forward chart and balances with explicitly supplied finite-neighbor
    /// transactions. The sparse Jacobian differentiates the network at HELD
    /// port rates; use `Network::add_port_jvp` for their coupled response.
    pub fn evaluate_with_ports(
        &mut self,
        n: &Network,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        ports: &[LiquidPort],
    ) -> Result<(), String> {
        self.evaluate_with_inputs(n, y, yp, cj, ports, None)
    }
    /// Actual variable-seat position is a held input at this exact stage time.
    pub fn evaluate_with_inputs(
        &mut self,
        n: &Network,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        ports: &[LiquidPort],
        prhr_input: Option<crate::prhr::Input>,
    ) -> Result<(), String> {
        self.evaluate_with_motion(n, y, yp, cj, ports, prhr_input, None)
    }
    /// One current network evaluation. Motion changes the existing finite
    /// inventory chart and physical connection laws, never EOS pressure datums.
    pub fn evaluate_with_motion(
        &mut self,
        n: &Network,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        ports: &[LiquidPort],
        prhr_input: Option<crate::prhr::Input>,
        motion: Option<MotionGeometry<'_>>,
    ) -> Result<(), String> {
        self.energy_rate_valid = false;
        self.chart_valid = false;
        match (&n.prhr, prhr_input) {
            (Some(p), Some(input)) => p.validate_input(input)?,
            (None, None) => (),
            _ => return Err("Selected seat requires one actual achieved opening".into()),
        }
        let opening = prhr_input.map(|i| i.opening);
        n.check_ports(ports)?;
        let nw = n.config.water.len();
        let dim = n.dimension();
        let pcol = n.pressure_row();
        if !Arc::ptr_eq(&self.owner, &n.owner)
            || self.energy_rate_partials.len() != n.energy_rate_slots.len()
            || y.len() != dim
            || yp.len() != dim
            || self.residual.len() != dim
            || self.chart_state.len() != dim
            || self.rates.len() != dim
            || self.jacobian_values.len() != n.row_indices.len()
            || self.liquids.len() != nw
            || self.chart_mass.len() != nw
            || self.chart_energy.len() != nw
            || self.chart_derivatives.len() != nw
            || self.redistribution.len() != nw
            || self.mass_rates.len() != nw
            || self.queries.len() != nw
            || self.probe_queries.len() != 4 * nw
            || self.probes.len() != 4 * nw
            || self.local_derivatives.len() != nw
            || self.mass_flows.len() != n.config.hydraulic.len()
            || self.heat_flows.len() != n.config.heat.len()
            || self.film_nusselt.len() != n.config.heat.len()
            || self.film_raw_prandtl_ratio.len() != n.config.heat.len()
            || self.secondary_states.len() != n.config.secondaries.len()
            || self.secondary_heat_flows.len() != n.config.secondary_heat.len()
            || y.iter().chain(yp).any(|x| !x.is_finite())
            || cj.is_some_and(|x| !x.is_finite() || x < 0.)
            || y[n.total_mass_row()] <= 0.
        {
            return Err("Invalid pressure-territory trial shape/value".into());
        }
        self.property_requests = 0;
        self.rates.fill(0.);
        self.residual.fill(0.);
        self.jacobian_values.fill(0.);
        self.mass_rates.fill(0.);
        self.shape_mass_rates.fill(0.);
        self.shape_pressure_work_w.fill(0.);
        self.shape_rate_partials.fill([0.; 2]);
        self.moving_by_edge.fill(None);
        self.moving_connections.clear();
        self.moving_responses.clear();
        if let Some(m) = motion {
            if m.water.len() != nw
                || m.water.iter().any(|s| {
                    s.volume_m3 <= 0.
                        || [
                            s.volume_m3,
                            s.first_moment_m4,
                            s.volume_rate_m3_s,
                            s.first_moment_rate_m4_s,
                        ]
                        .iter()
                        .any(|v| !v.is_finite())
                })
            {
                return Err("Invalid current moving water shape".into());
            }
            self.water_shapes.copy_from_slice(m.water);
            for (i, c) in m.connections.iter().enumerate() {
                if c.edge >= n.config.hydraulic.len()
                    || self.moving_by_edge[c.edge].is_some()
                    || c.fluid_work_cell >= nw
                    || ![
                        n.config.hydraulic[c.edge].from,
                        n.config.hydraulic[c.edge].to,
                    ]
                    .contains(&c.fluid_work_cell)
                    || [c.from_elevation_m, c.to_elevation_m]
                        .iter()
                        .any(|v| !v.is_finite())
                    || n.config.seat.is_some_and(|s| s.edge == c.edge)
                {
                    return Err("Invalid or duplicate moving hydraulic incidence".into());
                }
                self.moving_by_edge[c.edge] = Some(i);
                self.moving_connections.push(*c);
                self.moving_responses
                    .push(moving_hydraulic::Response::default());
            }
        } else {
            for (s, w) in self.water_shapes.iter_mut().zip(&n.config.water) {
                *s = WaterShape {
                    volume_m3: w.geometry.volume,
                    first_moment_m4: w.geometry.volume * w.geometry.elevation,
                    ..WaterShape::default()
                };
            }
        }
        self.heat_entropy_production = 0.;
        self.film_nusselt.fill(0.);
        self.film_raw_prandtl_ratio.fill(0.);
        for i in 0..nw {
            let p = n.eos_pressure(i, y);
            let t = n.temperature(i, y);
            if p <= 0. || t <= 0. || n.mechanical_pressure(i, y) <= 0. || y[n.marker_row(i)] < 0. {
                return Err(format!("Invalid water trial {i}"));
            }
            self.queries[i] = LiquidQuery {
                pressure: p,
                temperature: t,
            };
        }
        for i in nw..nw + n.config.solids.len() {
            if n.temperature(i, y) <= 0. {
                return Err("Nonpositive finite solid temperature".into());
            }
        }
        self.property_requests += nw;
        liquid_batch(&self.queries, &mut self.liquids)
            .map_err(|e| format!("Water node {}: {}", e.index, e.message))?;
        for i in 0..nw {
            let l = self.liquids[i];
            let q = self.queries[i];
            if motion.is_some() {
                let s = self.water_shapes[i];
                let c = moving_chart::inventory_chart(
                    CellGeometry {
                        volume: s.volume_m3,
                        elevation: s.first_moment_m4 / s.volume_m3,
                    },
                    moving_chart::ShapeDirection {
                        volume_m2: s.volume_rate_m3_s,
                        first_moment_m3: s.first_moment_rate_m4_s,
                    },
                    l,
                    q.pressure,
                    q.temperature,
                )?;
                self.chart_mass[i] = c.mass_kg;
                self.chart_energy[i] = c.energy_j;
                self.chart_derivatives[i] = c.thermal_partials;
                self.redistribution[i] = [c.redistribution[0], c.redistribution[1]];
                self.shape_mass_rates[i] = c.redistribution[2];
                let phead = q.pressure
                    + n.relative_pressure(i, y)
                    + GRAVITY * l.density * n.config.water[i].geometry.elevation;
                let work =
                    -phead * s.volume_rate_m3_s + GRAVITY * l.density * s.first_moment_rate_m4_s;
                self.shape_pressure_work_w[i] = work;
                self.rates[i] += work;
            } else {
                self.chart_mass[i] = n.config.water[i].geometry.volume * l.density;
                self.chart_energy[i] = self.chart_mass[i]
                    * (l.internal_energy + GRAVITY * n.config.water[i].geometry.elevation);
                (self.chart_derivatives[i], self.redistribution[i]) =
                    chart(n.config.water[i], l, q.pressure, q.temperature)?;
            }
        }
        if cj.is_some() {
            for i in 0..nw {
                let q = self.queries[i];
                let dp = (q.pressure * 1e-5).max(0.1).min(q.pressure * 0.01);
                let dt = 1e-3;
                self.probe_queries[4 * i] = LiquidQuery {
                    pressure: q.pressure + dp,
                    ..q
                };
                self.probe_queries[4 * i + 1] = LiquidQuery {
                    pressure: q.pressure - dp,
                    ..q
                };
                self.probe_queries[4 * i + 2] = LiquidQuery {
                    temperature: q.temperature + dt,
                    ..q
                };
                self.probe_queries[4 * i + 3] = LiquidQuery {
                    temperature: q.temperature - dt,
                    ..q
                };
            }
            self.property_requests += 4 * nw;
            liquid_batch(&self.probe_queries, &mut self.probes)
                .map_err(|e| format!("Local coefficient probe {}: {}", e.index, e.message))?;
            for i in 0..nw {
                let l = self.liquids[i];
                let dp =
                    self.probe_queries[4 * i].pressure - self.probe_queries[4 * i + 1].pressure;
                let dt = self.probe_queries[4 * i + 2].temperature
                    - self.probe_queries[4 * i + 3].temperature;
                let mut ab = [[0.; 2]; 4];
                for (k, out) in ab.iter_mut().enumerate() {
                    let q = self.probe_queries[4 * i + k];
                    let s = self.water_shapes[i];
                    let water = Water {
                        geometry: CellGeometry {
                            volume: s.volume_m3,
                            elevation: if motion.is_some() {
                                s.first_moment_m4 / s.volume_m3
                            } else {
                                n.config.water[i].geometry.elevation
                            },
                        },
                        ..n.config.water[i]
                    };
                    *out = chart(water, self.probes[4 * i + k], q.pressure, q.temperature)?.1;
                }
                let [a, b, c, d] = [
                    self.probes[4 * i],
                    self.probes[4 * i + 1],
                    self.probes[4 * i + 2],
                    self.probes[4 * i + 3],
                ];
                self.local_derivatives[i] = [
                    (a.viscosity - b.viscosity) / dp,
                    (c.viscosity - d.viscosity) / dt,
                    (a.conductivity - b.conductivity) / dp,
                    (c.conductivity - d.conductivity) / dt,
                    (ab[0][0] - ab[1][0]) / dp,
                    (ab[2][0] - ab[3][0]) / dt,
                    (ab[0][1] - ab[1][1]) / dp,
                    (ab[2][1] - ab[3][1]) / dt,
                    (a.cp - b.cp) / dp,
                    (c.cp - d.cp) / dt,
                ];
                if motion.is_some() {
                    let s = self.water_shapes[i];
                    let shape_rate = |liquid: Liquid, b: f64| {
                        liquid.density * s.volume_rate_m3_s
                            - b * liquid.density
                                * (liquid.internal_energy * s.volume_rate_m3_s
                                    + GRAVITY * s.first_moment_rate_m4_s)
                    };
                    self.shape_rate_partials[i] = [
                        (shape_rate(a, ab[0][1]) - shape_rate(b, ab[1][1])) / dp,
                        (shape_rate(c, ab[2][1]) - shape_rate(d, ab[3][1])) / dt,
                    ];
                    let v = s.volume_rate_m3_s;
                    let j = s.first_moment_rate_m4_s;
                    let pressure_work_partial = |drho: f64, dp: f64| {
                        -v * dp + GRAVITY * drho * (j - n.config.water[i].geometry.elevation * v)
                    };
                    self.add(
                        n,
                        i,
                        pcol,
                        -pressure_work_partial(l.density * l.compressibility, 1.),
                    );
                    self.add(
                        n,
                        i,
                        n.temperature_row(i),
                        -pressure_work_partial(-l.density * l.expansion, 0.),
                    );
                    if let Some(col) = n.mechanical_row(i) {
                        self.add(n, i, col, v);
                    }
                }
            }
        }
        for (edge, e) in n.config.hydraulic.iter().enumerate() {
            let row = n.flow_row(edge);
            let seat = n.config.seat.filter(|s| s.edge == edge);
            let a = seat.map_or(1., |_| opening.expect("validated seat opening"));
            let q = y[row];
            self.mass_flows[edge] = q;
            let rho = (self.liquids[e.from].density + self.liquids[e.to].density) * 0.5;
            let mu = (self.liquids[e.from].viscosity + self.liquids[e.to].viscosity) * 0.5;
            // P cancels exactly: do not subtract two large total pressures to
            // obtain a near-rest mechanical head.
            let moving = self.moving_by_edge[edge].map(|i| (i, self.moving_connections[i]));
            let (from_z, to_z) = moving.map_or((e.from_elevation, e.to_elevation), |(_, c)| {
                (c.from_elevation_m, c.to_elevation_m)
            });
            if moving.is_some()
                && [(e.from, from_z), (e.to, to_z)]
                    .into_iter()
                    .any(|(node, z)| {
                        let p = n.mechanical_pressure(node, y)
                            + self.liquids[node].density
                                * GRAVITY
                                * (n.config.water[node].geometry.elevation - z);
                        !p.is_finite() || p <= 0.
                    })
            {
                return Err(format!(
                    "Moving connection lost positive actual port pressure {edge}"
                ));
            }
            let (drive, _) = n.hydraulic_drive_at(edge, from_z, to_z, y, &self.liquids)?;
            let loss = if let Some((i, c)) = moving {
                let response = c.law.evaluate(q, rho, mu)?;
                self.moving_responses[i] = response;
                self.rates[c.fluid_work_cell] += response.fluid_wall_work_w;
                [
                    response.loss_pa,
                    response.loss_partials[0],
                    response.loss_partials[2],
                    response.loss_partials[1],
                ]
            } else {
                e.pressure_loss(q, rho, mu)
            };
            let actual_mouth_only = e
                .segments
                .iter()
                .all(|s| s.length == 0. && s.fixed_loss > 0.);
            if !loss.iter().all(|x| x.is_finite())
                || loss[1] < 0.
                || (loss[1] == 0.
                    && !actual_mouth_only
                    && !moving
                        .is_some_and(|(_, c)| matches!(c.law, moving_hydraulic::Law::Clear { .. })))
            {
                return Err(format!("Invalid forward hydraulic loss {edge}"));
            }
            let inverse = seat.map(|s| s.flow(e, drive, a, rho, mu)).transpose()?;
            self.residual[row] = inverse.map_or(drive - loss[0], |value| q - value[0]);
            let donor = if q >= 0. { e.from } else { e.to };
            let l = self.liquids[donor];
            let pi = n.relative_pressure(donor, y);
            let t = n.temperature(donor, y);
            let h = l.internal_energy
                + n.mechanical_pressure(donor, y) / l.density
                + GRAVITY * n.config.water[donor].geometry.elevation;
            let c = y[n.marker_row(donor)] / self.chart_mass[donor];
            for (recipient, s) in [(e.from, -1.), (e.to, 1.)] {
                self.mass_rates[recipient] += s * q;
                self.rates[recipient] += s * q * h;
                self.rates[n.marker_row(recipient)] += s * q * c;
            }
            if cj.is_some() {
                let dz = to_z - from_z;
                let ga = GRAVITY * (n.config.water[e.from].geometry.elevation - from_z - 0.5 * dz);
                let gb = GRAVITY * (to_z - n.config.water[e.to].geometry.elevation - 0.5 * dz);
                self.add(n, row, row, if inverse.is_some() { 1. } else { -loss[1] });
                let mut gp = 0.;
                for (node, s, gravity) in [(e.from, 1., ga), (e.to, -1., gb)] {
                    let lnode = self.liquids[node];
                    let d = self.local_derivatives[node];
                    let rp = lnode.density * lnode.compressibility * 0.5;
                    let rt = -lnode.density * lnode.expansion * 0.5;
                    let property_partial = |density_direction: f64, mu_direction: f64| {
                        if let Some(inv) = inverse {
                            -inv[1] * gravity * (2. * density_direction)
                                - inv[2] * mu_direction * 0.5
                                - inv[3] * density_direction
                        } else {
                            gravity * (2. * density_direction)
                                - loss[2] * mu_direction * 0.5
                                - loss[3] * density_direction
                        }
                    };
                    gp += property_partial(rp, d[0]);
                    self.add(n, row, n.temperature_row(node), property_partial(rt, d[1]));
                    if let Some((i, c)) = moving {
                        let partial = self.moving_responses[i].fluid_wall_work_partials;
                        self.add(
                            n,
                            c.fluid_work_cell,
                            pcol,
                            -partial[1] * rp - partial[2] * d[0] * 0.5,
                        );
                        self.add(
                            n,
                            c.fluid_work_cell,
                            n.temperature_row(node),
                            -partial[1] * rt - partial[2] * d[1] * 0.5,
                        );
                    }
                    if let Some(col) = n.mechanical_row(node) {
                        self.add(n, row, col, s * inverse.map_or(1., |v| -v[1]));
                    }
                    if let Some(r) = n.mechanical_row(node) {
                        self.add(n, r, row, s);
                    }
                }
                if let Some((i, c)) = moving {
                    self.add(
                        n,
                        c.fluid_work_cell,
                        row,
                        -self.moving_responses[i].fluid_wall_work_partials[0],
                    );
                }
                self.add(n, row, pcol, gp);
                for (recipient, s) in [(e.from, 1.), (e.to, -1.)] {
                    self.add(n, recipient, row, s * h);
                    self.add(n, n.marker_row(recipient), row, s * c);
                    self.add(
                        n,
                        recipient,
                        pcol,
                        s * q * (1. - t * l.expansion - pi * l.compressibility) / l.density,
                    );
                    self.add(
                        n,
                        recipient,
                        n.temperature_row(donor),
                        s * q * (l.cp + pi * l.expansion / l.density),
                    );
                    if let Some(col) = n.mechanical_row(donor) {
                        self.add(n, recipient, col, s * q / l.density);
                    }
                    self.add(
                        n,
                        n.marker_row(recipient),
                        n.marker_row(donor),
                        s * q / self.chart_mass[donor],
                    );
                    self.add(
                        n,
                        n.marker_row(recipient),
                        pcol,
                        -s * q * c * l.compressibility,
                    );
                    self.add(
                        n,
                        n.marker_row(recipient),
                        n.temperature_row(donor),
                        s * q * c * l.expansion,
                    );
                }
            }
        }
        for (edge, e) in n.config.heat.iter().enumerate() {
            let ta = n.temperature(e.from, y);
            let tb = n.temperature(e.to, y);
            let (g, q, partials) = match e.law {
                HeatLaw::Conductance(g) => (g, g * (ta - tb), None),
                HeatLaw::LiquidFilm { geometry } => {
                    let g = geometry * self.liquids[e.from].conductivity;
                    (g, g * (ta - tb), None)
                }
                HeatLaw::SgSensible {
                    area,
                    diameter,
                    flow_area,
                    hydraulic_edge,
                } => {
                    let p = n.eos_pressure(e.from, y);
                    let flow = self.mass_flows[hydraulic_edge];
                    let (result, partials) = sensible_with_partials(
                        p,
                        ta,
                        tb,
                        flow,
                        area,
                        diameter,
                        flow_area,
                        cj.is_some(),
                        &mut self.property_requests,
                    )?;
                    self.film_nusselt[edge] = result.1;
                    self.film_raw_prandtl_ratio[edge] = result.2;
                    (0., result.0, cj.map(|_| partials))
                }
            };
            self.heat_flows[edge] = q;
            self.heat_entropy_production += q * (1. / tb - 1. / ta);
            self.rates[n.energy_row(e.from)] -= q;
            self.rates[n.energy_row(e.to)] += q;
            if cj.is_some() {
                if let (HeatLaw::SgSensible { hydraulic_edge, .. }, Some(d)) = (e.law, partials) {
                    for (row, s) in [(n.energy_row(e.from), 1.), (n.energy_row(e.to), -1.)] {
                        self.add(n, row, pcol, s * d[0]);
                        self.add(n, row, n.temperature_row(e.from), s * d[1]);
                        self.add(
                            n,
                            row,
                            n.energy_row(e.to),
                            s * d[2] / n.config.solids[e.to - nw].heat_capacity,
                        );
                        self.add(n, row, n.flow_row(hydraulic_edge), s * d[3]);
                    }
                } else {
                    for (node, sign) in [(e.from, 1.), (e.to, -1.)] {
                        let (col, dt) = if node < nw {
                            (n.temperature_row(node), 1.)
                        } else {
                            (
                                n.energy_row(node),
                                1. / n.config.solids[node - nw].heat_capacity,
                            )
                        };
                        for (recipient, s) in [(e.from, 1.), (e.to, -1.)] {
                            self.add(n, n.energy_row(recipient), col, s * sign * g * dt);
                        }
                    }
                    if let HeatLaw::LiquidFilm { geometry } = e.law {
                        for (col, dk) in [
                            (pcol, self.local_derivatives[e.from][2]),
                            (n.temperature_row(e.from), self.local_derivatives[e.from][3]),
                        ] {
                            for (recipient, s) in [(e.from, 1.), (e.to, -1.)] {
                                self.add(
                                    n,
                                    n.energy_row(recipient),
                                    col,
                                    s * geometry * dk * (ta - tb),
                                );
                            }
                        }
                    }
                }
            }
        }
        // A port changes both aggregate inventory and its actual local mass
        // divergence. Apply BEFORE differential and reduced-continuity rows;
        // adding energy alone after assembly would leave a false closed mass.
        for p in ports {
            self.mass_rates[p.cell] += p.mass_rate;
            self.rates[n.total_mass_row()] += p.mass_rate;
            self.rates[n.energy_row(p.cell)] += p.energy_rate;
            self.rates[n.marker_row(p.cell)] += p.marker_rate;
        }
        for row in 0..n.stock_dimension() {
            self.residual[row] = yp[row] - self.rates[row];
        }
        for (k, s) in n.config.secondaries.iter().enumerate() {
            let u = n.secondary_energy_row(k);
            let t = u + 1;
            let sp = u + 2;
            let st = s.evaluate(n.secondary_inventory(k), y[t], y[sp])?;
            self.property_requests += 2;
            self.secondary_states[k] = st;
            self.residual[t] = y[u] - st.energy;
            self.residual[sp] = st.pressure_residual;
            if cj.is_some() {
                self.add(n, t, u, 1.);
                let d = s.derivatives(n.secondary_inventory(k), y[t], y[sp])?;
                self.property_requests += 8;
                self.add(n, t, t, -d[0]);
                self.add(n, t, sp, -d[1]);
                self.add(n, sp, t, d[2]);
                self.add(n, sp, sp, d[3]);
            }
        }
        for (k, h) in n.config.secondary_heat.iter().enumerate() {
            let u = n.secondary_energy_row(h.secondary);
            let t = u + 1;
            let sp = u + 2;
            let metal = n.energy_row(nw + h.solid);
            let wall = n.temperature(nw + h.solid, y);
            let (q, partials) = crate::sg_secondary::heat_with_partials(
                y[t],
                y[sp],
                wall,
                h.area,
                h.diameter,
                cj.is_some(),
                &mut self.property_requests,
            )?;
            self.secondary_heat_flows[k] = q;
            self.rates[metal] -= q;
            self.rates[u] += q;
            self.residual[metal] += q;
            self.heat_entropy_production += q * (1. / y[t] - 1. / wall);
            if cj.is_some() {
                for j in 0..3 {
                    let d = partials[j];
                    let col = [t, sp, metal][j];
                    let d = if j == 2 {
                        d / n.config.solids[h.solid].heat_capacity
                    } else {
                        d
                    };
                    self.add(n, metal, col, d);
                    self.add(n, u, col, -d);
                }
            }
        }
        for k in 0..n.config.secondaries.len() {
            let u = n.secondary_energy_row(k);
            self.residual[u] = yp[u] - self.rates[u];
        }
        if let Some(input) = prhr_input {
            self.evaluate_prhr(n, y, yp, cj, input)?;
        }
        self.residual[pcol] = mass_chart_residual(y[n.total_mass_row()], &self.chart_mass);
        let sum_a: f64 = self.redistribution.iter().map(|x| x[0]).sum();
        if !sum_a.is_finite() || sum_a <= 0. {
            return Err("Singular aggregate pressure chart".into());
        }
        self.pressure_rate = (yp[n.total_mass_row()]
            - (0..nw)
                .map(|i| self.redistribution[i][1] * yp[i] + self.shape_mass_rates[i])
                .sum::<f64>())
            / sum_a;
        for i in 0..nw {
            self.residual[n.temperature_row(i)] = y[i] - self.chart_energy[i];
            if let Some(row) = n.mechanical_row(i) {
                let [a, b] = self.redistribution[i];
                self.residual[row] = a * self.pressure_rate + b * yp[i] + self.shape_mass_rates[i]
                    - self.mass_rates[i];
            }
            if cj.is_some() {
                let [mp, mt, ep, et] = self.chart_derivatives[i];
                self.add(n, pcol, pcol, -mp);
                self.add(n, pcol, n.temperature_row(i), -mt);
                self.add(n, n.temperature_row(i), i, 1.);
                self.add(n, n.temperature_row(i), pcol, -ep);
                self.add(n, n.temperature_row(i), n.temperature_row(i), -et);
            }
        }
        if let Some(cj) = cj {
            self.add(n, pcol, n.total_mass_row(), 1.);
            let dp_rate: f64 = -(0..nw)
                .map(|j| {
                    self.local_derivatives[j][6] * yp[j]
                        + self.pressure_rate * self.local_derivatives[j][4]
                        + self.shape_rate_partials[j][0]
                })
                .sum::<f64>()
                / sum_a;
            for i in 1..nw {
                let row = n.mechanical_row(i).unwrap();
                let [a, b] = self.redistribution[i];
                let d = self.local_derivatives[i];
                self.add(
                    n,
                    row,
                    pcol,
                    d[4] * self.pressure_rate
                        + d[6] * yp[i]
                        + self.shape_rate_partials[i][0]
                        + a * dp_rate,
                );
                self.add(n, row, n.total_mass_row(), cj * a / sum_a);
                for j in 0..nw {
                    let dj = self.local_derivatives[j];
                    let dt_rate = -(dj[7] * yp[j]
                        + self.pressure_rate * dj[5]
                        + self.shape_rate_partials[j][1])
                        / sum_a;
                    let local = if i == j {
                        d[5] * self.pressure_rate + d[7] * yp[i] + self.shape_rate_partials[i][1]
                    } else {
                        0.
                    };
                    self.add(n, row, n.temperature_row(j), local + a * dt_rate);
                    self.add(
                        n,
                        row,
                        j,
                        cj * ((if i == j { b } else { 0. })
                            - a * self.redistribution[j][1] / sum_a),
                    );
                }
            }
        }
        if let Some(cj) = cj {
            for (value, &(col, slot)) in self
                .energy_rate_partials
                .iter_mut()
                .zip(&n.energy_rate_slots)
            {
                let row = n.row_indices[slot] as usize;
                let already_shifted = n
                    .prhr
                    .as_ref()
                    .is_some_and(|p| p.energy_rows().contains(&row));
                *value = -self.jacobian_values[slot]
                    + if already_shifted && col == row {
                        cj
                    } else {
                        0.
                    };
            }
            for row in 0..n.stock_dimension() {
                self.add(n, row, row, cj);
            }
            for k in 0..n.config.secondaries.len() {
                let row = n.secondary_energy_row(k);
                self.add(n, row, row, cj);
            }
        }
        if self
            .residual
            .iter()
            .chain(&self.rates)
            .chain(&self.jacobian_values)
            .chain(&self.mass_flows)
            .chain(&self.mass_rates)
            .chain(&self.heat_flows)
            .chain(&self.chart_mass)
            .chain(&self.chart_energy)
            .any(|x| !x.is_finite())
            || !self.pressure_rate.is_finite()
        {
            return Err("Nonfinite pressure-territory result".into());
        }
        self.energy_rate_valid = cj.is_some();
        self.chart_state.copy_from_slice(y);
        self.chart_rates.copy_from_slice(yp);
        self.chart_valid = true;
        Ok(())
    }
}

const SENSIBLE_CONTRAST_POWERS: [f64; 4] = [0., 0.25, 1. / 3., 0.];

/// Current-owner stable sensible-film law; no phase/NC continuation. The
/// signed contrast and active Nusselt branch are differentiated analytically.
/// Local property probes never traverse the |contrast| power or max branches.
pub(crate) fn sensible_with_partials(
    p: f64,
    t: f64,
    wall: f64,
    flow: f64,
    area: f64,
    diameter: f64,
    flow_area: f64,
    tangent: bool,
    requests: &mut usize,
) -> Result<((f64, f64, f64), [f64; 4]), String> {
    let (coefficients, scale, ratio) =
        sensible_coefficients(p, t, wall, flow, area, diameter, flow_area, requests)?;
    let delta = t - wall;
    let mut branch = 0;
    let mut conductance = coefficients[0];
    for j in 1..4 {
        let candidate = coefficients[j] * delta.abs().powf(SENSIBLE_CONTRAST_POWERS[j]);
        if candidate > conductance {
            conductance = candidate;
            branch = j;
        }
    }
    let value = (conductance * delta, conductance / scale, ratio);
    let mut d = [0.; 4];
    if tangent {
        let values = [p, t, wall, flow];
        let steps = [
            (p * 1e-5).max(0.1).min(p * 0.01),
            1e-3,
            1e-3,
            (flow.abs() * 1e-5).max(1e-5),
        ];
        for j in 0..4 {
            let mut a = values;
            let mut b = values;
            a[j] += steps[j];
            b[j] -= steps[j];
            let hi =
                sensible_coefficients(a[0], a[1], a[2], a[3], area, diameter, flow_area, requests)?
                    .0;
            let lo =
                sensible_coefficients(b[0], b[1], b[2], b[3], area, diameter, flow_area, requests)?
                    .0;
            d[j] = delta
                * delta.abs().powf(SENSIBLE_CONTRAST_POWERS[branch])
                * (hi[branch] - lo[branch])
                / (2. * steps[j]);
        }
        let contrast = conductance * (1. + SENSIBLE_CONTRAST_POWERS[branch]);
        d[1] += contrast;
        d[2] -= contrast;
    }
    if ![value.0, value.1, value.2]
        .iter()
        .chain(&d)
        .all(|x| x.is_finite())
    {
        return Err("Nonfinite SG sensible-film result/tangent".into());
    }
    Ok((value, d))
}
/// Smooth conductance factors for the constant, quarter-power, one-third-
/// power and forced branches. The explicit temperature powers live above.
fn sensible_coefficients(
    p: f64,
    t: f64,
    wall: f64,
    flow: f64,
    area: f64,
    d: f64,
    a: f64,
    requests: &mut usize,
) -> Result<([f64; 4], f64, f64), String> {
    let queries = [
        LiquidQuery {
            pressure: p,
            temperature: t,
        },
        LiquidQuery {
            pressure: p,
            temperature: 0.5 * (t + wall),
        },
        LiquidQuery {
            pressure: p,
            temperature: wall,
        },
    ];
    let mut liquids = [Liquid::default(); 3];
    *requests += 3;
    liquid_batch(&queries, &mut liquids).map_err(|e| {
        format!(
            "SG sensible stable-liquid reference {}: {}",
            e.index, e.message
        )
    })?;
    let [bulk, film, w] = liquids;
    let re = flow.abs() * d / (a * bulk.viscosity);
    let pr = bulk.viscosity * bulk.cp / bulk.conductivity;
    let pr_wall = w.viscosity * w.cp / w.conductivity;
    let ratio = pr / pr_wall;
    if !ratio.is_finite() || !(0.05..=20.).contains(&ratio) {
        return Err("Unsupported sensible-film Pr/Prwall source range".into());
    }
    let rayleigh_per_k =
        GRAVITY * bulk.expansion * d.powi(3) * pr / (bulk.viscosity / film.density).powi(2);
    if !rayleigh_per_k.is_finite() || rayleigh_per_k < 0. {
        return Err("Unsupported SG natural-film expansion branch".into());
    }
    let turbulent = if re > 1000. {
        let f = (1.58 * re.ln() - 3.28).powi(-2);
        (f / 2.) * (re - 1000.) * pr / (1. + 12.7 * (f / 2.).sqrt() * (pr.powf(2. / 3.) - 1.))
            * ratio.powf(0.11)
    } else {
        0.
    };
    let scale = area * bulk.conductivity / d;
    let factors = [
        3.66 * scale,
        0.59 * rayleigh_per_k.powf(0.25) * scale,
        0.13 * rayleigh_per_k.powf(1. / 3.) * scale,
        turbulent * scale,
    ];
    if !scale.is_finite() || scale <= 0. || factors.iter().any(|v| !v.is_finite() || *v < 0.) {
        return Err("Nonfinite SG sensible-film coefficients".into());
    }
    Ok((factors, scale, ratio))
}

#[cfg(test)]
mod sensible_tests {
    use super::*;

    #[test]
    fn aggregate_mass_chart_retains_signed_multi_owner_defect() {
        // Exact integer reference: all terms and their true sum are f64
        // representable, but summing the positive owners first loses 96 kg.
        // The physical chart has one total owner in both fixed and moving
        // networks; neither owner ordering nor a large common stock may hide
        // the actual small signed defect.
        let base = 2_f64.powi(53);
        let mut owners = vec![1.; 97];
        owners[0] = base;
        let total = base + 96.;
        assert_eq!(total - owners.iter().sum::<f64>(), 96.);
        assert_eq!(mass_chart_residual(total, &owners), 0.);
        assert_eq!(mass_chart_residual(total + 2., &owners), 2.);
        owners.reverse();
        assert_eq!(mass_chart_residual(total, &owners), 0.);
        assert_eq!(mass_chart_residual(total - 2., &owners), -2.);
        // A moving boundary transfers material between finite owners without
        // changing their aggregate. Keep that same small chart defect.
        owners[0] += 0.25;
        owners[1] -= 0.25;
        assert_eq!(mass_chart_residual(total + 2., &owners), 2.);
    }

    #[test]
    fn zero_contrast_has_exact_selected_floor_tangent_not_a_cross_branch_secant() {
        let mut requests = 0;
        let ((q, nu, _), d) = sensible_with_partials(
            300000.,
            293.15,
            293.15,
            0.,
            1.,
            0.5,
            0.2,
            true,
            &mut requests,
        )
        .unwrap();
        let (_, scale, _) =
            sensible_coefficients(300000., 293.15, 293.15, 0., 1., 0.5, 0.2, &mut requests)
                .unwrap();
        assert_eq!(q, 0.);
        assert!((nu - 3.66).abs() <= f64::EPSILON * 3.66);
        assert_eq!(d, [0., 3.66 * scale, -3.66 * scale, 0.]);
    }

    #[test]
    fn active_signed_flux_tangents_cover_natural_crossover_and_forced_branches() {
        let mut requests = 0;
        let (c, _, _) =
            sensible_coefficients(300000., 293.15, 293.15, 0., 1., 0.5, 0.2, &mut requests)
                .unwrap();
        let crossover = (c[0] / c[1]).powi(4);
        for delta in [0., crossover * 0.5, crossover * 2., 1e-4, 0.1, 5.] {
            for sign in [-1., 1.] {
                for flow in [0., 100.] {
                    let t = 293.15;
                    let wall = t + sign * delta;
                    let (_, d) = sensible_with_partials(
                        300000.,
                        t,
                        wall,
                        flow,
                        1.,
                        0.5,
                        0.2,
                        true,
                        &mut requests,
                    )
                    .unwrap();
                    // Stay within the selected contrast branch. The zero
                    // case uses the derived physical plateau scale, not an
                    // arbitrary temperature floor in the constitutive law.
                    let h = if delta == 0. {
                        crossover * 0.01
                    } else {
                        delta * 1e-3
                    };
                    let hi_wall = wall + h;
                    let lo_wall = wall - h;
                    assert!(hi_wall > lo_wall);
                    let hi = sensible_with_partials(
                        300000.,
                        t,
                        hi_wall,
                        flow,
                        1.,
                        0.5,
                        0.2,
                        false,
                        &mut requests,
                    )
                    .unwrap()
                    .0
                    .0;
                    let lo = sensible_with_partials(
                        300000.,
                        t,
                        lo_wall,
                        flow,
                        1.,
                        0.5,
                        0.2,
                        false,
                        &mut requests,
                    )
                    .unwrap()
                    .0
                    .0;
                    let fd = (hi - lo) / (hi_wall - lo_wall);
                    assert!(
                        (fd - d[2]).abs() <= 1e-5 * fd.abs().max(d[2].abs()),
                        "delta={delta} sign={sign} flow={flow} fd={fd} tangent={}",
                        d[2]
                    );
                }
            }
        }
    }
}

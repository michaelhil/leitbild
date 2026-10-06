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
mod hydraulic;
use crate::sg_secondary::{Inventory as SecondaryInventory, State as SecondaryState};
pub use crate::sg_secondary::{Secondary, SecondaryHeat};
pub use hydraulic::{Hydraulic, LossLaw};
pub const SOLID_DATUM_K: f64 = 300.;

#[derive(Clone, Copy, Debug)]
pub struct Water {
    pub geometry: CellGeometry,
    pub initial_pressure: f64,
    pub initial_temperature: f64,
    /// Passive mobile kg-equivalent/kg; not additional physical mass.
    pub initial_tracer_fraction: f64,
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
}

pub struct Network {
    config: Config,
    /// Fixed ORIGINAL hydrostatic offsets, not a reached-state projection.
    pressure_offsets: Vec<f64>,
    secondary_inventories: Vec<SecondaryInventory>,
    pub column_pointers: Vec<i64>,
    pub row_indices: Vec<i64>,
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
        for e in &config.hydraulic {
            if e.from >= nw
                || e.to >= nw
                || e.from == e.to
                || !e.length.is_finite()
                || e.length <= 0.
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
        let mut network = Self {
            config,
            pressure_offsets,
            secondary_inventories,
            column_pointers: vec![],
            row_indices: vec![],
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
        network.column_pointers.push(0);
        for column in pattern {
            network
                .row_indices
                .extend(column.into_iter().map(|x| x as i64));
            network
                .column_pointers
                .push(network.row_indices.len() as i64);
        }
        Ok(network)
    }
    pub fn config(&self) -> &Config {
        &self.config
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
        self.base_dimension() + 3 * self.config.secondaries.len()
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
            || (row >= self.base_dimension() && (row - self.base_dimension()) % 3 == 0)
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
    pub pressure_rate: f64,
    pub mass_rates: Vec<f64>,
    pub heat_entropy_production: f64,
    pub property_requests: usize,
    pub film_nusselt: Vec<f64>,
    pub film_raw_prandtl_ratio: Vec<f64>,
    pub secondary_states: Vec<SecondaryState>,
    pub secondary_heat_flows: Vec<f64>,
    queries: Vec<LiquidQuery>,
    probe_queries: Vec<LiquidQuery>,
    probes: Vec<Liquid>,
    // mu_p,mu_T,k_p,k_T,a_p,a_T,b_p,b_T; bounded LOCAL property probes only.
    local_derivatives: Vec<[f64; 8]>,
}
fn chart(w: Water, l: Liquid, p: f64, t: f64) -> Result<([f64; 4], [f64; 2]), String> {
    let m = w.geometry.volume * l.density;
    let u = l.internal_energy + GRAVITY * w.geometry.elevation;
    let mp = m * l.compressibility;
    let mt = -m * l.expansion;
    let ep = u * mp + w.geometry.volume * (p * l.compressibility - t * l.expansion);
    let et = u * mt + m * (l.cp - p * l.expansion / l.density);
    if ![mp, mt, ep, et].iter().all(|x| x.is_finite()) || et <= 0. {
        return Err("Singular local energy chart".into());
    }
    let a = mp - mt * ep / et;
    let b = mt / et;
    if !a.is_finite() || !b.is_finite() || a <= 0. {
        return Err("Unsupported local pressure/energy chart".into());
    }
    Ok(([mp, mt, ep, et], [a, b]))
}
impl Workspace {
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
            pressure_rate: 0.,
            mass_rates: vec![0.; nw],
            heat_entropy_production: 0.,
            property_requests: 0,
            film_nusselt: vec![0.; nh],
            film_raw_prandtl_ratio: vec![0.; nh],
            secondary_states: vec![SecondaryState::default(); n.config.secondaries.len()],
            secondary_heat_flows: vec![0.; n.config.secondary_heat.len()],
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
            local_derivatives: vec![[0.; 8]; nw],
        }
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
        let nw = n.config.water.len();
        let dim = n.dimension();
        let pcol = n.pressure_row();
        if y.len() != dim
            || yp.len() != dim
            || self.residual.len() != dim
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
            self.chart_mass[i] = n.config.water[i].geometry.volume * l.density;
            self.chart_energy[i] = self.chart_mass[i]
                * (l.internal_energy + GRAVITY * n.config.water[i].geometry.elevation);
            (self.chart_derivatives[i], self.redistribution[i]) =
                chart(n.config.water[i], l, q.pressure, q.temperature)?;
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
                let dp =
                    self.probe_queries[4 * i].pressure - self.probe_queries[4 * i + 1].pressure;
                let dt = self.probe_queries[4 * i + 2].temperature
                    - self.probe_queries[4 * i + 3].temperature;
                let mut ab = [[0.; 2]; 4];
                for (k, out) in ab.iter_mut().enumerate() {
                    let q = self.probe_queries[4 * i + k];
                    *out = chart(
                        n.config.water[i],
                        self.probes[4 * i + k],
                        q.pressure,
                        q.temperature,
                    )?
                    .1;
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
                ];
            }
        }
        for (edge, e) in n.config.hydraulic.iter().enumerate() {
            let row = n.flow_row(edge);
            let q = y[row];
            self.mass_flows[edge] = q;
            let rho = (self.liquids[e.from].density + self.liquids[e.to].density) * 0.5;
            let mu = (self.liquids[e.from].viscosity + self.liquids[e.to].viscosity) * 0.5;
            let dz =
                n.config.water[e.to].geometry.elevation - n.config.water[e.from].geometry.elevation;
            // P cancels exactly: do not subtract two large total pressures to
            // obtain a near-rest mechanical head.
            let drive = n.pressure_offsets[e.from] - n.pressure_offsets[e.to]
                + n.relative_pressure(e.from, y)
                - n.relative_pressure(e.to, y)
                - rho * GRAVITY * dz;
            let loss = e.pressure_loss(q, rho, mu);
            if !loss.iter().all(|x| x.is_finite()) || loss[1] <= 0. {
                return Err(format!("Invalid forward hydraulic loss {edge}"));
            }
            self.residual[row] = drive - loss[0];
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
                self.add(n, row, row, -loss[1]);
                let mut gp = 0.;
                for (node, s) in [(e.from, 1.), (e.to, -1.)] {
                    let lnode = self.liquids[node];
                    let d = self.local_derivatives[node];
                    let rp = lnode.density * lnode.compressibility * 0.5;
                    let rt = -lnode.density * lnode.expansion * 0.5;
                    gp += -GRAVITY * dz * rp - loss[2] * d[0] * 0.5 - loss[3] * rp;
                    self.add(
                        n,
                        row,
                        n.temperature_row(node),
                        -GRAVITY * dz * rt - loss[2] * d[1] * 0.5 - loss[3] * rt,
                    );
                    if let Some(col) = n.mechanical_row(node) {
                        self.add(n, row, col, s);
                    }
                    if let Some(r) = n.mechanical_row(node) {
                        self.add(n, r, row, s);
                    }
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
                    let result = sg_sensible(
                        p,
                        ta,
                        tb,
                        flow,
                        area,
                        diameter,
                        flow_area,
                        &mut self.property_requests,
                    )?;
                    self.film_nusselt[edge] = result.1;
                    self.film_raw_prandtl_ratio[edge] = result.2;
                    let partials = if cj.is_some() {
                        let values = [p, ta, tb, flow];
                        let steps = [
                            (p * 1e-5).max(0.1).min(p * 0.01),
                            1e-3,
                            1e-3,
                            (flow.abs() * 1e-5).max(1e-5),
                        ];
                        let mut d = [0.; 4];
                        for j in 0..4 {
                            let mut a = values;
                            let mut b = values;
                            a[j] += steps[j];
                            b[j] -= steps[j];
                            let plus = sg_sensible(
                                a[0],
                                a[1],
                                a[2],
                                a[3],
                                area,
                                diameter,
                                flow_area,
                                &mut self.property_requests,
                            )?
                            .0;
                            let minus = sg_sensible(
                                b[0],
                                b[1],
                                b[2],
                                b[3],
                                area,
                                diameter,
                                flow_area,
                                &mut self.property_requests,
                            )?
                            .0;
                            d[j] = (plus - minus) / (2. * steps[j]);
                        }
                        Some(d)
                    } else {
                        None
                    };
                    (0., result.0, partials)
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
        for row in 0..n.stock_dimension() {
            self.residual[row] = yp[row] - self.rates[row];
            if let Some(cj) = cj {
                self.add(n, row, row, cj);
            }
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
            if let Some(c) = cj {
                self.add(n, u, u, c);
            }
        }
        self.residual[pcol] = y[n.total_mass_row()] - self.chart_mass.iter().sum::<f64>();
        let sum_a: f64 = self.redistribution.iter().map(|x| x[0]).sum();
        if !sum_a.is_finite() || sum_a <= 0. {
            return Err("Singular aggregate pressure chart".into());
        }
        self.pressure_rate = (yp[n.total_mass_row()]
            - (0..nw)
                .map(|i| self.redistribution[i][1] * yp[i])
                .sum::<f64>())
            / sum_a;
        for i in 0..nw {
            self.residual[n.temperature_row(i)] = y[i] - self.chart_energy[i];
            if let Some(row) = n.mechanical_row(i) {
                let [a, b] = self.redistribution[i];
                self.residual[row] = a * self.pressure_rate + b * yp[i] - self.mass_rates[i];
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
                    d[4] * self.pressure_rate + d[6] * yp[i] + a * dp_rate,
                );
                self.add(n, row, n.total_mass_row(), cj * a / sum_a);
                for j in 0..nw {
                    let dj = self.local_derivatives[j];
                    let dt_rate = -(dj[7] * yp[j] + self.pressure_rate * dj[5]) / sum_a;
                    let local = if i == j {
                        d[5] * self.pressure_rate + d[7] * yp[i]
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
        if self
            .residual
            .iter()
            .chain(&self.rates)
            .chain(&self.jacobian_values)
            .chain(&self.mass_flows)
            .chain(&self.heat_flows)
            .chain(&self.chart_mass)
            .chain(&self.chart_energy)
            .any(|x| !x.is_finite())
            || !self.pressure_rate.is_finite()
        {
            return Err("Nonfinite pressure-territory result".into());
        }
        Ok(())
    }
}

/// Current-owner stable sensible-film law; no phase/NC continuation.
fn sg_sensible(
    p: f64,
    t: f64,
    wall: f64,
    flow: f64,
    area: f64,
    d: f64,
    a: f64,
    requests: &mut usize,
) -> Result<(f64, f64, f64), String> {
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
    let ra = GRAVITY * bulk.expansion * (wall - t).abs() * d.powi(3) * pr
        / (bulk.viscosity / film.density).powi(2);
    if !ra.is_finite() || ra < 0. {
        return Err("Unsupported SG natural-film expansion branch".into());
    }
    let natural = (0.59 * ra.powf(0.25)).max(0.13 * ra.powf(1. / 3.));
    let turbulent = if re > 1000. {
        let f = (1.58 * re.ln() - 3.28).powi(-2);
        (f / 2.) * (re - 1000.) * pr / (1. + 12.7 * (f / 2.).sqrt() * (pr.powf(2. / 3.) - 1.))
            * ratio.clamp(0.05, 20.).powf(0.11)
    } else {
        0.
    };
    let nu = 3.66_f64.max(natural).max(turbulent);
    let q = area * nu * bulk.conductivity / d * (t - wall);
    if !q.is_finite() || !nu.is_finite() || !ratio.is_finite() || ratio <= 0. {
        return Err("Nonfinite SG sensible-film result".into());
    }
    Ok((q, nu, ratio))
}

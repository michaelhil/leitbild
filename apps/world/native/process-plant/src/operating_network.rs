//! Offline finite stable-liquid pressure/thermal network.
//! Selected reduced energy is M*(u+g*z), with no fluid kinetic energy, inertial
//! passage, pump/rotor, phase, nuclear source or maintained external boundary.
//! Short links are algebraic viscous/form-loss paths. Their pressure relaxation
//! is not a claim to remove every fast lumped mode or qualify natural circulation.
//! Shared donor enthalpy/elevation/tracer and thermal receipts are reciprocal.
use crate::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::collections::BTreeSet;
mod hydraulic;
pub use hydraulic::{Hydraulic, LossLaw};

pub const SOLID_DATUM_K: f64 = 300.;

#[derive(Clone, Copy, Debug)]
pub struct Water {
    pub geometry: CellGeometry,
    pub initial_pressure: f64,
    pub initial_temperature: f64,
    /// Passive mobile kg-equivalent tracer/kg water; not extra physical mass.
    pub initial_tracer_fraction: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Solid {
    /// Authored constant sensible heat capacity, J/K; not a prescribed heater.
    pub heat_capacity: f64,
    pub initial_temperature: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum HeatLaw {
    Conductance(f64), // W/K, with an authored applicability domain.
    /// Selected low-flow Nu*A/D, m; source must be water, recipient solid.
    /// G=geometry*k(current source water). Not a general SG correlation.
    LiquidFilm {
        geometry: f64,
    },
    /// Current SG sensible liquid film, no boiling/phase continuation.
    SgSensible {
        area: f64,
        diameter: f64,
        flow_area: f64,
        hydraulic_edge: usize,
    },
}
#[derive(Clone, Copy, Debug)]
pub struct Heat {
    /// Thermal indices: water first, then solids. Not equipment identifiers.
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
}

/// Immutable compiled incidence and sparse pattern. Mutable solver/property
/// buffers belong to Workspace, never another unit or global shared state.
pub struct Network {
    config: Config,
    pub column_pointers: Vec<i64>,
    pub row_indices: Vec<i64>,
}
impl Network {
    pub fn new(config: Config) -> Result<Self, String> {
        let nw = config.water.len();
        let nt = nw + config.solids.len();
        if nw == 0
            || nw
                .checked_mul(5)
                .and_then(|x| x.checked_add(config.solids.len()))
                .is_none()
        {
            return Err("Invalid operating-network size".into());
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
                || !e.roughness.is_finite()
                || e.roughness < 0.
                || e.roughness / e.diameter > 0.1
                || !e.fixed_loss.is_finite()
                || e.fixed_loss < 0.
                || !e.grid_multiplier.is_finite()
                || e.grid_multiplier < 0.
                || matches!(e.law,LossLaw::GuideAnnulus{laminar_darcy} if !laminar_darcy.is_finite() || laminar_darcy<=0.)
                || !e.flow_area.is_finite()
                || e.flow_area <= 0.
            {
                return Err("Invalid viscous hydraulic contact".into());
            }
        }
        for e in &config.heat {
            if e.from >= nt || e.to >= nt || e.from == e.to {
                return Err("Invalid thermal contact".into());
            }
            let coefficient = match e.law {
                HeatLaw::Conductance(g) => g,
                HeatLaw::LiquidFilm { geometry } => {
                    if e.from >= nw || e.to < nw {
                        return Err(
                            "Liquid film requires water source and finite solid recipient".into(),
                        );
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
        let n = 5 * nw + config.solids.len();
        let mut pattern = vec![BTreeSet::new(); n];
        for i in 0..nw {
            for column in 5 * i..5 * i + 5 {
                for row in 5 * i..5 * i + 5 {
                    pattern[column].insert(row);
                }
            }
        }
        for i in 5 * nw..n {
            pattern[i].insert(i);
        }
        for e in &config.hydraulic {
            for node in [e.from, e.to] {
                for column in 5 * node..5 * node + 5 {
                    for recipient in [e.from, e.to] {
                        for row in 5 * recipient..5 * recipient + 3 {
                            pattern[column].insert(row);
                        }
                    }
                }
            }
        }
        let energy_row = |i: usize| if i < nw { 5 * i + 1 } else { 5 * nw + i - nw };
        let temperature_column = |i: usize| if i < nw { 5 * i + 4 } else { 5 * nw + i - nw };
        for e in &config.heat {
            for column in [temperature_column(e.from), temperature_column(e.to)] {
                for row in [energy_row(e.from), energy_row(e.to)] {
                    pattern[column].insert(row);
                }
            }
            if matches!(
                e.law,
                HeatLaw::LiquidFilm { .. } | HeatLaw::SgSensible { .. }
            ) {
                for row in [energy_row(e.from), energy_row(e.to)] {
                    pattern[5 * e.from + 3].insert(row);
                }
            }
            if let HeatLaw::SgSensible { hydraulic_edge, .. } = e.law {
                for node in [
                    config.hydraulic[hydraulic_edge].from,
                    config.hydraulic[hydraulic_edge].to,
                ] {
                    for column in [5 * node + 3, 5 * node + 4] {
                        for row in [energy_row(e.from), energy_row(e.to)] {
                            pattern[column].insert(row);
                        }
                    }
                }
            }
        }
        let mut column_pointers = vec![0];
        let mut row_indices = Vec::new();
        for column in pattern {
            row_indices.extend(column.into_iter().map(|x| x as i64));
            column_pointers.push(row_indices.len() as i64);
        }
        Ok(Self {
            config,
            column_pointers,
            row_indices,
        })
    }
    pub fn dimension(&self) -> usize {
        5 * self.config.water.len() + self.config.solids.len()
    }
    pub fn config(&self) -> &Config {
        &self.config
    }
    pub fn energy_row(&self, thermal: usize) -> usize {
        let nw = self.config.water.len();
        if thermal < nw {
            5 * thermal + 1
        } else {
            5 * nw + thermal - nw
        }
    }
    pub fn temperature(&self, thermal: usize, y: &[f64]) -> f64 {
        let nw = self.config.water.len();
        if thermal < nw {
            y[5 * thermal + 4]
        } else {
            SOLID_DATUM_K
                + y[5 * nw + thermal - nw] / self.config.solids[thermal - nw].heat_capacity
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
        for (i, (w, l)) in self.config.water.iter().zip(water).enumerate() {
            let mass = w.geometry.volume * l.density;
            y[5 * i] = mass;
            y[5 * i + 1] = mass * (l.internal_energy + GRAVITY * w.geometry.elevation);
            y[5 * i + 2] = mass * w.initial_tracer_fraction;
            y[5 * i + 3] = w.initial_pressure;
            y[5 * i + 4] = w.initial_temperature;
        }
        for (i, s) in self.config.solids.iter().enumerate() {
            y[5 * self.config.water.len() + i] =
                s.heat_capacity * (s.initial_temperature - SOLID_DATUM_K);
        }
        Ok(y)
    }
}

pub struct Workspace {
    pub residual: Vec<f64>,
    /// Differential balance rates; algebraic slots are zero, not owned stocks.
    pub rates: Vec<f64>,
    pub jacobian_values: Vec<f64>,
    pub liquids: Vec<Liquid>,
    pub mass_flows: Vec<f64>,
    pub heat_flows: Vec<f64>,
    pub heat_entropy_production: f64,
    pub property_requests: usize,
    pub film_nusselt: Vec<f64>,
    pub film_raw_prandtl_ratio: Vec<f64>,
    flow_derivatives: Vec<[f64; 4]>,
    queries: Vec<LiquidQuery>,
    probe_queries: Vec<LiquidQuery>,
    probes: Vec<Liquid>,
    transport_derivatives: Vec<[f64; 4]>, // mu_p,mu_T,k_p,k_T
}
impl Workspace {
    pub fn new(network: &Network) -> Self {
        let nw = network.config.water.len();
        Self {
            residual: vec![0.; network.dimension()],
            rates: vec![0.; network.dimension()],
            jacobian_values: vec![0.; network.row_indices.len()],
            liquids: vec![Liquid::default(); nw],
            mass_flows: vec![0.; network.config.hydraulic.len()],
            heat_flows: vec![0.; network.config.heat.len()],
            heat_entropy_production: 0.,
            property_requests: 0,
            film_nusselt: vec![0.; network.config.heat.len()],
            film_raw_prandtl_ratio: vec![0.; network.config.heat.len()],
            flow_derivatives: vec![[0.; 4]; network.config.hydraulic.len()],
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
            transport_derivatives: vec![[0.; 4]; nw],
        }
    }
    fn add(&mut self, network: &Network, row: usize, column: usize, value: f64) {
        let start = network.column_pointers[column] as usize;
        let end = network.column_pointers[column + 1] as usize;
        let slot = network.row_indices[start..end]
            .binary_search(&(row as i64))
            .expect("Compiled local incidence");
        self.jacobian_values[start + slot] += value;
    }
    /// One forward tuple per water state. Jacobians add bounded LOCAL p/T
    /// transport-property probes only; no global residual probes/nested inverse.
    /// Piecewise donor selection is directional at zero unequal-state flow.
    pub fn evaluate(
        &mut self,
        network: &Network,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
    ) -> Result<(), String> {
        let nw = network.config.water.len();
        let n = network.dimension();
        if y.len() != n
            || yp.len() != n
            || self.residual.len() != n
            || self.rates.len() != n
            || self.liquids.len() != nw
            || self.queries.len() != nw
            || self.probes.len() != 4 * nw
            || self.probe_queries.len() != 4 * nw
            || self.transport_derivatives.len() != nw
            || self.mass_flows.len() != network.config.hydraulic.len()
            || self.flow_derivatives.len() != network.config.hydraulic.len()
            || self.heat_flows.len() != network.config.heat.len()
            || self.film_nusselt.len() != network.config.heat.len()
            || self.film_raw_prandtl_ratio.len() != network.config.heat.len()
            || self.jacobian_values.len() != network.row_indices.len()
            || y.iter().chain(yp).any(|x| !x.is_finite())
            || cj.is_some_and(|x| !x.is_finite())
        {
            return Err("Invalid network trial shape/value".into());
        }
        self.property_requests = 0;
        self.rates.fill(0.);
        self.jacobian_values.fill(0.);
        self.heat_entropy_production = 0.;
        for i in 0..nw {
            if y[5 * i] <= 0. || y[5 * i + 2] < 0. || y[5 * i + 3] <= 0. || y[5 * i + 4] <= 0. {
                return Err(format!("Invalid water trial at node {i}"));
            }
            self.queries[i] = LiquidQuery {
                pressure: y[5 * i + 3],
                temperature: y[5 * i + 4],
            };
        }
        for thermal in nw..nw + network.config.solids.len() {
            if network.temperature(thermal, y) <= 0. {
                return Err(format!("Nonpositive solid temperature {thermal}"));
            }
        }
        self.property_requests += nw;
        liquid_batch(&self.queries, &mut self.liquids)
            .map_err(|e| format!("Water node {}: {}", e.index, e.message))?;
        if cj.is_some()
            && (!network.config.hydraulic.is_empty()
                || network.config.heat.iter().any(|e| {
                    matches!(
                        e.law,
                        HeatLaw::LiquidFilm { .. } | HeatLaw::SgSensible { .. }
                    )
                }))
        {
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
            liquid_batch(&self.probe_queries, &mut self.probes).map_err(|e| {
                format!(
                    "Local transport derivative probe {}: {}",
                    e.index, e.message
                )
            })?;
            for i in 0..nw {
                let dp =
                    self.probe_queries[4 * i].pressure - self.probe_queries[4 * i + 1].pressure;
                let dt = self.probe_queries[4 * i + 2].temperature
                    - self.probe_queries[4 * i + 3].temperature;
                let [a, b, c, d] = [
                    self.probes[4 * i],
                    self.probes[4 * i + 1],
                    self.probes[4 * i + 2],
                    self.probes[4 * i + 3],
                ];
                self.transport_derivatives[i] = [
                    (a.viscosity - b.viscosity) / dp,
                    (c.viscosity - d.viscosity) / dt,
                    (a.conductivity - b.conductivity) / dp,
                    (c.conductivity - d.conductivity) / dt,
                ];
            }
        }
        for (edge, e) in network.config.hydraulic.iter().enumerate() {
            let a = self.liquids[e.from];
            let b = self.liquids[e.to];
            let rho = (a.density + b.density) * 0.5;
            let mu = (a.viscosity + b.viscosity) * 0.5;
            let dz = network.config.water[e.to].geometry.elevation
                - network.config.water[e.from].geometry.elevation;
            let drive = y[5 * e.from + 3] - y[5 * e.to + 3] - rho * GRAVITY * dz;
            let (q, loss) = hydraulic::flow(e, drive, rho, mu)
                .map_err(|s| format!("Hydraulic edge {edge}: {s}"))?;
            self.mass_flows[edge] = q;
            let donor = if q >= 0. { e.from } else { e.to };
            let l = self.liquids[donor];
            let h = l.internal_energy
                + y[5 * donor + 3] / l.density
                + GRAVITY * network.config.water[donor].geometry.elevation;
            let concentration = y[5 * donor + 2] / y[5 * donor];
            for (recipient, sign) in [(e.from, -1.), (e.to, 1.)] {
                self.rates[5 * recipient] += sign * q;
                self.rates[5 * recipient + 1] += sign * q * h;
                self.rates[5 * recipient + 2] += sign * q * concentration;
            }
            if cj.is_some() {
                for (side, (node, pressure_sign)) in
                    [(e.from, 1.), (e.to, -1.)].into_iter().enumerate()
                {
                    let lnode = self.liquids[node];
                    for (j, drho, dmu) in [
                        (
                            3,
                            lnode.density * lnode.compressibility * 0.5,
                            self.transport_derivatives[node][0] * 0.5,
                        ),
                        (
                            4,
                            -lnode.density * lnode.expansion * 0.5,
                            self.transport_derivatives[node][1] * 0.5,
                        ),
                    ] {
                        let dd = if j == 3 { pressure_sign } else { 0. };
                        let dd = dd - GRAVITY * dz * drho;
                        let dq = (dd - loss[2] * dmu - loss[3] * drho) / loss[1];
                        self.flow_derivatives[edge][2 * side + j - 3] = dq;
                        let dh = if node == donor {
                            if j == 3 {
                                (1. - y[5 * node + 4] * lnode.expansion) / lnode.density
                            } else {
                                lnode.cp
                            }
                        } else {
                            0.
                        };
                        for (recipient, sign) in [(e.from, 1.), (e.to, -1.)] {
                            self.add(network, 5 * recipient, 5 * node + j, sign * dq);
                            self.add(
                                network,
                                5 * recipient + 1,
                                5 * node + j,
                                sign * (dq * h + q * dh),
                            );
                            self.add(
                                network,
                                5 * recipient + 2,
                                5 * node + j,
                                sign * dq * concentration,
                            );
                        }
                    }
                }
                for (recipient, sign) in [(e.from, 1.), (e.to, -1.)] {
                    self.add(
                        network,
                        5 * recipient + 2,
                        5 * donor,
                        -sign * q * concentration / y[5 * donor],
                    );
                    self.add(
                        network,
                        5 * recipient + 2,
                        5 * donor + 2,
                        sign * q / y[5 * donor],
                    );
                }
            }
        }
        for (edge, e) in network.config.heat.iter().enumerate() {
            let ta = network.temperature(e.from, y);
            let tb = network.temperature(e.to, y);
            let (g, q, film_partials) = match e.law {
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
                    let p = y[5 * e.from + 3];
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
            self.rates[network.energy_row(e.from)] -= q;
            self.rates[network.energy_row(e.to)] += q;
            if cj.is_some() {
                if let (HeatLaw::SgSensible { hydraulic_edge, .. }, Some(d)) =
                    (e.law, film_partials)
                {
                    let recipient = nw + (e.to - nw);
                    for (row, s) in [
                        (network.energy_row(e.from), 1.),
                        (network.energy_row(e.to), -1.),
                    ] {
                        self.add(network, row, 5 * e.from + 3, s * d[0]);
                        self.add(network, row, 5 * e.from + 4, s * d[1]);
                        self.add(
                            network,
                            row,
                            network.energy_row(recipient),
                            s * d[2] / network.config.solids[e.to - nw].heat_capacity,
                        );
                        let h = network.config.hydraulic[hydraulic_edge];
                        for (side, node) in [h.from, h.to].into_iter().enumerate() {
                            for j in 0..2 {
                                self.add(
                                    network,
                                    row,
                                    5 * node + 3 + j,
                                    s * d[3] * self.flow_derivatives[hydraulic_edge][2 * side + j],
                                );
                            }
                        }
                    }
                    continue;
                }
                for (node, sign) in [(e.from, 1.), (e.to, -1.)] {
                    let (column, dt) = if node < nw {
                        (5 * node + 4, 1.)
                    } else {
                        (
                            network.energy_row(node),
                            1. / network.config.solids[node - nw].heat_capacity,
                        )
                    };
                    for (recipient, s) in [(e.from, 1.), (e.to, -1.)] {
                        self.add(
                            network,
                            network.energy_row(recipient),
                            column,
                            s * sign * g * dt,
                        );
                    }
                }
                if let HeatLaw::LiquidFilm { geometry } = e.law {
                    for (column, dk) in [
                        (5 * e.from + 3, self.transport_derivatives[e.from][2]),
                        (5 * e.from + 4, self.transport_derivatives[e.from][3]),
                    ] {
                        for (recipient, s) in [(e.from, 1.), (e.to, -1.)] {
                            self.add(
                                network,
                                network.energy_row(recipient),
                                column,
                                s * geometry * dk * (ta - tb),
                            );
                        }
                    }
                }
            }
        }
        for i in 0..n {
            self.residual[i] = yp[i] - self.rates[i];
        }
        for (i, w) in network.config.water.iter().enumerate() {
            let l = self.liquids[i];
            let mass = w.geometry.volume * l.density;
            let u = l.internal_energy + GRAVITY * w.geometry.elevation;
            let p = y[5 * i + 3];
            let t = y[5 * i + 4];
            self.residual[5 * i + 3] = y[5 * i] - mass;
            self.residual[5 * i + 4] = y[5 * i + 1] - mass * u;
            if let Some(cj) = cj {
                for j in 0..3 {
                    self.add(network, 5 * i + j, 5 * i + j, cj);
                }
                self.add(network, 5 * i + 3, 5 * i, 1.);
                self.add(network, 5 * i + 4, 5 * i + 1, 1.);
                let mp = mass * l.compressibility;
                let mt = -mass * l.expansion;
                self.add(network, 5 * i + 3, 5 * i + 3, -mp);
                self.add(network, 5 * i + 3, 5 * i + 4, -mt);
                self.add(
                    network,
                    5 * i + 4,
                    5 * i + 3,
                    -(u * mp + w.geometry.volume * (p * l.compressibility - t * l.expansion)),
                );
                self.add(
                    network,
                    5 * i + 4,
                    5 * i + 4,
                    -(u * mt + mass * (l.cp - p * l.expansion / l.density)),
                );
            }
        }
        if let Some(cj) = cj {
            for i in 5 * nw..n {
                self.add(network, i, i, cj);
            }
        }
        if self
            .residual
            .iter()
            .chain(&self.rates)
            .chain(&self.jacobian_values)
            .chain(&self.mass_flows)
            .chain(&self.heat_flows)
            .any(|x| !x.is_finite())
        {
            return Err("Nonfinite operating network result".into());
        }
        Ok(())
    }
}

/// Same current-owner sensible-film formulas and property convention. This
/// bounded stable-liquid block refuses a wall/film outside stable liquid; it
/// does not install the owner's Tsat-bounded boiling or NC continuation.
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

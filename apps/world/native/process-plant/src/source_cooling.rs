//! One offline cold source/fuel/primary/SG/barrel/pressure-support residual.
//! Component owners retain
//! their laws; this module owns ONLY their physical incidence and chain rule.
//! Includes fertile/Xe/Sm prompt-binding photons into existing fuel/clad/water,
//! the selected finite-barrel capture/decay path and restricted cold
//! liquid/steam/air pressurizer with its finite mixed surge line.
//! No time integrator, Pack installation, other unjoined binding recipients,
//! all-passage acoustic mesh, hot geometry or primary phase continuation is implied.
use crate::{
    absorber_guide as ag, barrel_thermal as bt, cold_pressurizer as cp, finite_surge as fs,
    fuel_capture as fc, fuel_thermal as ft, mobile_capture as mc, moderator_source::Stocks,
    operating_network as on, sg_secondary, source_evolution as se, water_carrier as wc,
};
use std::sync::Arc;
mod pressure;
pub use pressure::PressureConnection;

#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub source_end: usize,
    pub network_start: usize,
    pub carrier_start: usize,
    pub energies_start: usize,
    pub temperatures_start: usize,
    pub barrel_energy: usize,
    pub barrel_temperature: usize,
    pub barrel_released: usize,
    pub barrel_exported: usize,
    pub pressurizer_start: usize,
    pub surge_start: usize,
    pub surge_carrier_start: usize,
    pub pool_carrier_start: usize,
    pub gas_hydrogen_product: usize,
    pub ambient_exported: usize,
    pub fuel_capture_exported: usize,
    pub mobile_capture_exported: usize,
    pub mobile_capture_boundary_exported: usize,
    pub absorber_guide_energies_start: usize,
    pub absorber_guide_temperatures_start: usize,
    pub absorber_guide_exported: usize,
    pub dimension: usize,
}
pub struct Model {
    pub source: se::Evolution,
    pub network: on::Network,
    pub thermal: ft::Model,
    pub carrier: wc::Carrier,
    pub barrel: bt::Model,
    pub capture: fc::Model,
    pub mobile_capture: mc::Model,
    pub absorber_guide: ag::Model,
    pub layout: Layout,
    pressure_connection: PressureConnection,
    /// SOURCE fuel-cohort ordering -> thermal node ordering.
    fuel_rows: Vec<usize>,
    /// Native incoming core flow for film; all other water cells have no fuel wall.
    water_flows: Vec<Option<usize>>,
    original_temperature: Vec<f64>,
    owner: Arc<()>,
}
pub struct Workspace {
    pub source: se::Workspace,
    pub network: on::Workspace,
    pub thermal: ft::Workspace,
    pub barrel: bt::Workspace,
    pub capture: fc::Workspace,
    pub mobile_capture: mc::Workspace,
    pub absorber_guide: ag::Workspace,
    pub pressurizer: cp::Workspace,
    pub surge: fs::Workspace,
    pub residual: Vec<f64>,
    pub jvp: Vec<f64>,
    mass: Vec<f64>,
    dmass: Vec<f64>,
    density: Vec<f64>,
    ddensity: Vec<f64>,
    products: Vec<wc::Amounts>,
    dproducts: Vec<wc::Amounts>,
    product_rates: Vec<wc::Amounts>,
    product_jvp: Vec<wc::Amounts>,
    stocks: Vec<Stocks>,
    dstocks: Vec<Stocks>,
    fuel_temperature: Vec<f64>,
    dfuel_temperature: Vec<f64>,
    deposited: Vec<f64>,
    ddeposited: Vec<f64>,
    water: Vec<ft::Water>,
    dwater: Vec<ft::WaterDirection>,
    barrel_water: Vec<bt::Water>,
    dbarrel_water: Vec<bt::WaterDirection>,
    dflows: Vec<f64>,
    state: Vec<f64>,
    jacobian_cj: Option<f64>,
    owner: Arc<()>,
    valid: bool,
    energy_rate_balance: f64,
    energy_rate_tangent: Option<f64>,
    hot_liquid: crate::Liquid,
    pressure_ports: [fs::Port; 2],
    pool_port: Option<cp::PortResponse>,
    pressure_material_rates: [f64; 10],
}
fn array<const N: usize>(slice: &[f64]) -> &[f64; N] {
    slice.try_into().expect("validated component layout")
}
fn compensated(values: impl Iterator<Item = f64>) -> f64 {
    let (mut s, mut c) = (0f64, 0f64);
    for v in values {
        let t = s + v;
        c += if s.abs() >= v.abs() {
            (s - t) + v
        } else {
            (v - t) + s
        };
        s = t;
    }
    s + c
}
impl Workspace {
    /// Read-only current primary view for a separately retained coefficient
    /// diagnostic. Never a second state owner or a frozen integration input.
    pub fn external_stocks(&self) -> Result<&[Stocks], String> {
        if !self.valid {
            return Err("No current composed carrier view".into());
        }
        Ok(&self.stocks)
    }
    /// Actual independently assembled installed-energy rate minus paid fuel,
    /// barrel and existing-product capture release, plus their photon and
    /// signed ambient exports.
    /// Never replaced with the
    /// analytically expected zero.
    pub fn complete_energy_rate(&self) -> Result<f64, String> {
        if !self.valid {
            return Err("No current composed energy-rate balance".into());
        }
        Ok(self.energy_rate_balance)
    }
    /// Same rate balance differentiated by the last successful full JVP,
    /// without recovering tiny rates by subtracting large cj-shifted actions.
    pub fn complete_energy_rate_jvp(&self) -> Result<f64, String> {
        if !self.valid {
            return Err("No current composed energy-rate tangent".into());
        }
        self.energy_rate_tangent
            .ok_or("No current composed energy-rate tangent".into())
    }
}
impl Model {
    pub fn new(
        source: se::Evolution,
        network: on::Network,
        thermal: ft::Model,
        carrier: wc::Carrier,
        barrel: bt::Model,
        pressure_connection: PressureConnection,
        capture: fc::Input,
        mobile_capture: mc::Input,
        absorber_guide: ag::Input,
        fuel_rows: Vec<usize>,
        water_flows: Vec<Option<usize>>,
        original_temperature: Vec<f64>,
    ) -> Result<Self, String> {
        let nw = network.config().water.len();
        let nt = thermal.node_count();
        if pressure_connection.primary_cell >= nw
            || !pressure_connection.atoms_per_marker.is_finite()
            || pressure_connection.atoms_per_marker <= 0.
            || pressure_connection
                .initial_pressurizer
                .iter()
                .chain(&pressure_connection.initial_surge)
                .any(|v| !v.is_finite())
            || pressure_connection
                .initial_pool
                .values()
                .iter()
                .chain(&pressure_connection.initial_line.values())
                .chain(std::iter::once(
                    &pressure_connection.initial_gas_hydrogen_product,
                ))
                .any(|v| !v.is_finite() || *v < 0.)
        {
            return Err("Invalid finite pressure-support preparation".into());
        }
        if source.external_water_count() != nw
            || carrier.cells() != nw
            || thermal.water_count() != nw
            || water_flows.len() != nw
            || barrel.config().water_count != nw
            || barrel
                .config()
                .targets
                .iter()
                .any(|&t| t >= source.target_count())
            || barrel.config().mn_owner >= source.mn_targets().len()
            || original_temperature.len() != nt
            || original_temperature.iter().any(|x| !x.is_finite())
            || fuel_rows.len() != source.prepared_temperatures().len()
            || fuel_rows.len() != thermal.fuel_node_count()
            || fuel_rows
                .iter()
                .any(|&r| r >= nt || !thermal.is_fuel_node(r))
            || fuel_rows
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != fuel_rows.len()
            || water_flows.iter().enumerate().any(|(i, e)| {
                e.is_some_and(|e| {
                    e >= network.config().hydraulic.len() || network.config().hydraulic[e].to != i
                })
            })
            || (0..thermal.band_count()).any(|b| water_flows[thermal.band_water(b)].is_none())
            || carrier.links().len() != network.config().hydraulic.len()
            || carrier
                .links()
                .iter()
                .zip(&network.config().hydraulic)
                .any(|(a, b)| a.from != b.from || a.to != b.to)
            || carrier
                .volumes()
                .iter()
                .zip(&network.config().water)
                .any(|(a, b)| a.to_bits() != b.geometry.volume.to_bits())
        {
            return Err("Invalid cold source/cooling incidence".into());
        }
        let mn = source.mn_targets()[barrel.config().mn_owner];
        if !barrel.config().targets.contains(&mn.target)
            || mn.electron_j.to_bits() != barrel.config().mn_electron_j.to_bits()
            || mn.photon_j.to_bits() != barrel.config().mn_photon_j.to_bits()
        {
            return Err("Barrel Mn emission/target ownership mismatch".into());
        }
        for (&r, &t) in fuel_rows.iter().zip(source.prepared_temperatures()) {
            if original_temperature[r].to_bits() != t.to_bits() {
                return Err("Source and thermal ORIGINAL preparation differ".into());
            }
        }
        // Both preparations come from the same physical cohort records. Do
        // not permit a separately authored caloric mass or an accidental
        // permutation to change the temperature response of source fuel.
        if fuel_rows
            .iter()
            .zip(source.fuel_history().fuel().cohorts())
            .any(|(&r, c)| {
                thermal
                    .fuel_mass_kg(r)
                    .is_none_or(|m| m.to_bits() != c.mass.to_bits())
            })
        {
            return Err("Source and thermal fuel reference masses differ".into());
        }
        let ns = source.state_count();
        let nn = network.dimension();
        let carrier_start = ns.checked_add(nn).ok_or("Coupled layout overflow")?;
        let energies_start = carrier_start
            .checked_add(wc::WIDTH * nw)
            .ok_or("Coupled layout overflow")?;
        let temperatures_start = energies_start
            .checked_add(nt)
            .ok_or("Coupled layout overflow")?;
        let barrel_energy = temperatures_start
            .checked_add(nt)
            .ok_or("Coupled layout overflow")?;
        let barrel_temperature = barrel_energy
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let barrel_released = barrel_energy
            .checked_add(2)
            .ok_or("Coupled layout overflow")?;
        let barrel_exported = barrel_energy
            .checked_add(3)
            .ok_or("Coupled layout overflow")?;
        let pressurizer_start = barrel_energy
            .checked_add(4)
            .ok_or("Coupled layout overflow")?;
        let surge_start = pressurizer_start
            .checked_add(cp::STATES)
            .ok_or("Coupled layout overflow")?;
        let surge_carrier_start = surge_start
            .checked_add(fs::STATES)
            .ok_or("Coupled layout overflow")?;
        let pool_carrier_start = surge_carrier_start
            .checked_add(wc::WIDTH)
            .ok_or("Coupled layout overflow")?;
        let gas_hydrogen_product = pool_carrier_start
            .checked_add(wc::WIDTH)
            .ok_or("Coupled layout overflow")?;
        let ambient_exported = gas_hydrogen_product
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let fuel_capture_exported = ambient_exported
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let mobile_capture_exported = fuel_capture_exported
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let mobile_capture_boundary_exported = mobile_capture_exported
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let absorber_guide_energies_start = mobile_capture_boundary_exported
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let absorber_guide_temperatures_start = absorber_guide_energies_start
            .checked_add(absorber_guide.hosts.len())
            .ok_or("Coupled layout overflow")?;
        let absorber_guide_exported = absorber_guide_temperatures_start
            .checked_add(absorber_guide.hosts.len())
            .ok_or("Coupled layout overflow")?;
        let dimension = absorber_guide_exported
            .checked_add(1)
            .ok_or("Coupled layout overflow")?;
        let capture = fc::Model::new(&source, &thermal, &fuel_rows, capture)?;
        let absorber_guide = ag::Model::new(&source, nw, absorber_guide)?;
        let mobile_capture = mc::Model::new(
            &source,
            mc::CladRecipients {node_count:thermal.node_count(),rows:(0..thermal.band_count()).flat_map(|b|thermal.clad_rows(b)).collect()},
            nw,
            absorber_guide.host_count(),
            mobile_capture,
        )?;
        Ok(Self {
            source,
            network,
            thermal,
            carrier,
            barrel,
            capture,
            mobile_capture,
            absorber_guide,
            pressure_connection,
            fuel_rows,
            water_flows,
            original_temperature,
            layout: Layout {
                source_end: ns,
                network_start: ns,
                carrier_start,
                energies_start,
                temperatures_start,
                barrel_energy,
                barrel_temperature,
                barrel_released,
                barrel_exported,
                pressurizer_start,
                surge_start,
                surge_carrier_start,
                pool_carrier_start,
                gas_hydrogen_product,
                ambient_exported,
                fuel_capture_exported,
                mobile_capture_exported,
                mobile_capture_boundary_exported,
                absorber_guide_energies_start,
                absorber_guide_temperatures_start,
                absorber_guide_exported,
                dimension,
            },
            owner: Arc::new(()),
        })
    }
    pub fn fuel_rows(&self) -> &[usize] {
        &self.fuel_rows
    }
    /// Existing physical capture products are the independent paid receipt;
    /// initial amounts must be subtracted BEFORE multiplying by event energy.
    pub fn capture_paid_rows(&self) -> impl Iterator<Item = (usize, f64)> + '_ {
        self.source
            .capture_progress_rows()
            .flat_map(|rows| rows.into_iter().zip(self.capture.config().capture_j))
    }
    /// Canonical transported capture products in the closed connected water
    /// inventory. Species0 is hydrogen product, species1 boron product. These
    /// are not heat deposited at the product's current recipient location.
    pub fn mobile_product_rows(&self, species: usize) -> impl Iterator<Item = usize> + '_ {
        assert!(species < 2, "Invalid mobile product species");
        let l = self.layout;
        let offset = if species == 0 { 0 } else { 2 };
        (0..self.carrier.cells())
            .map(move |i| l.carrier_start + wc::WIDTH * i + offset)
            .chain([
                l.surge_carrier_start + offset,
                l.pool_carrier_start + offset,
            ])
            .chain((species == 0).then_some(l.gas_hydrogen_product))
    }
    /// Complete closed-compartment birth receipt. Products may subsequently
    /// move; their local distribution is NEVER used to deposit binding heat.
    pub fn mobile_capture_paid_rows(&self) -> impl Iterator<Item = (usize, f64)> + '_ {
        self.mobile_capture
            .paid_energy()
            .into_iter()
            .enumerate()
            .flat_map(move |(species, q)| self.mobile_product_rows(species).map(move |r| (r, q)))
    }
    pub fn dimension(&self) -> usize {
        self.layout.dimension
    }
    pub fn pressure_connection(&self) -> &PressureConnection {
        &self.pressure_connection
    }
    /// Installed physical energies exactly once; gross release/export receipts
    /// are independent audits, never installed stores.
    pub fn installed_energy_rows(&self) -> impl Iterator<Item = usize> + '_ {
        let l = self.layout;
        self.network
            .installed_energy_rows()
            .map(move |r| l.network_start + r)
            .chain(l.energies_start..l.temperatures_start)
            .chain(std::iter::once(l.barrel_energy))
            .chain(l.absorber_guide_energies_start..l.absorber_guide_temperatures_start)
            .chain(
                self.pressure_connection
                    .pressurizer
                    .energy_rows()
                    .map(move |r| l.pressurizer_start + r),
            )
            .chain(
                self.pressure_connection
                    .surge
                    .energy_rows()
                    .map(move |r| l.surge_start + r),
            )
    }
    pub fn fluid_rows(&self) -> impl Iterator<Item = usize> + '_ {
        (self.layout.network_start..self.layout.energies_start)
            .chain(self.layout.pressurizer_start..=self.layout.ambient_exported)
    }
    pub fn is_differential(&self, row: usize) -> bool {
        let l = self.layout;
        row < l.source_end
            || (row < l.carrier_start && self.network.is_differential(row - l.network_start))
            || (row >= l.carrier_start && row < l.temperatures_start)
            || row == l.barrel_energy
            || row == l.barrel_released
            || row == l.barrel_exported
            || (row >= l.pressurizer_start
                && row < l.surge_start
                && self
                    .pressure_connection
                    .pressurizer
                    .is_differential(row - l.pressurizer_start))
            || (row >= l.surge_start
                && row < l.surge_carrier_start
                && self
                    .pressure_connection
                    .surge
                    .is_differential(row - l.surge_start))
            || (row >= l.surge_carrier_start && row <= l.ambient_exported)
            || row == l.fuel_capture_exported
            || row == l.mobile_capture_exported
            || row == l.mobile_capture_boundary_exported
            || (row >= l.absorber_guide_energies_start && row < l.absorber_guide_temperatures_start)
            || row == l.absorber_guide_exported
    }
    pub fn workspace(&self) -> Workspace {
        let nw = self.carrier.cells();
        let nt = self.thermal.node_count();
        let stock = Stocks {
            water_mass: 0.,
            liquid_volume: 0.,
            hydrogen_target: 0.,
            hydrogen_product: 0.,
            mobile_boron10: 0.,
        };
        let water = ft::Water {
            pressure_pa: 0.,
            temperature_k: 0.,
            saturation_temperature_k: 0.,
            mass_flow_kg_s: 0.,
            conductivity_w_m_k: 0.,
            viscosity_pa_s: 0.,
            cp_j_kg_k: 0.,
        };
        Workspace {
            source: self.source.workspace(),
            network: on::Workspace::new(&self.network),
            thermal: self.thermal.workspace(),
            barrel: self.barrel.workspace(),
            capture: self.capture.workspace(),
            mobile_capture: self.mobile_capture.workspace(),
            absorber_guide: self.absorber_guide.workspace(),
            pressurizer: self.pressure_connection.pressurizer.workspace(),
            surge: self.pressure_connection.surge.workspace(),
            residual: vec![0.; self.dimension()],
            jvp: vec![0.; self.dimension()],
            mass: vec![0.; nw],
            dmass: vec![0.; nw],
            density: vec![0.; nw],
            ddensity: vec![0.; nw],
            products: vec![wc::Amounts::default(); nw],
            dproducts: vec![wc::Amounts::default(); nw],
            product_rates: vec![wc::Amounts::default(); nw],
            product_jvp: vec![wc::Amounts::default(); nw],
            stocks: vec![stock; nw],
            dstocks: vec![stock; nw],
            fuel_temperature: vec![0.; self.fuel_rows.len()],
            dfuel_temperature: vec![0.; self.fuel_rows.len()],
            deposited: vec![0.; nt],
            ddeposited: vec![0.; nt],
            water: vec![water; nw],
            dwater: vec![ft::WaterDirection::default(); nw],
            barrel_water: vec![
                bt::Water {
                    temperature_k: 0.,
                    density_kg_m3: 0.,
                    saturation_temperature_k: 0.
                };
                nw
            ],
            dbarrel_water: vec![bt::WaterDirection::default(); nw],
            dflows: vec![0.; self.network.config().hydraulic.len()],
            state: vec![0.; self.dimension()],
            jacobian_cj: None,
            owner: self.owner.clone(),
            valid: false,
            energy_rate_balance: 0.,
            energy_rate_tangent: None,
            hot_liquid: crate::Liquid::default(),
            pressure_ports: [fs::Port::default(); 2],
            pool_port: None,
            pressure_material_rates: [0.; 10],
        }
    }
    /// Fresh physical preparation. Caller still solves network algebraic
    /// consistency; a zero-filled derivative is NOT a solved initial state.
    pub fn initial_state(&self) -> Result<Vec<f64>, String> {
        self.initial_state_with_prhr_input(None)
    }
    pub fn initial_state_with_prhr_input(
        &self,
        input: Option<crate::prhr::Input>,
    ) -> Result<Vec<f64>, String> {
        let l = self.layout;
        let mut y = vec![0.; self.dimension()];
        y[..l.source_end].copy_from_slice(&self.source.initial_state());
        y[l.network_start..l.carrier_start].copy_from_slice(&self.network.initial_state()?);
        y[l.temperatures_start..l.barrel_energy].copy_from_slice(&self.original_temperature);
        y[l.barrel_temperature] = self.barrel.initial_temperature();
        for (i, h) in self.absorber_guide.config().hosts.iter().enumerate() {
            y[l.absorber_guide_temperatures_start + i] = h.initial_k;
            y[l.absorber_guide_energies_start + i] =
                self.absorber_guide.energy_capacity(i, h.initial_k)?.0;
        }
        let p = &self.pressure_connection;
        y[l.pressurizer_start..l.surge_start].copy_from_slice(&p.initial_pressurizer);
        y[l.surge_start..l.surge_carrier_start].copy_from_slice(&p.initial_surge);
        y[l.surge_carrier_start..l.pool_carrier_start].copy_from_slice(&p.initial_line.values());
        y[l.pool_carrier_start..l.gas_hydrogen_product].copy_from_slice(&p.initial_pool.values());
        y[l.gas_hydrogen_product] = p.initial_gas_hydrogen_product;
        for (i, a) in self.carrier.initial().iter().enumerate() {
            y[l.carrier_start + wc::WIDTH * i..l.carrier_start + wc::WIDTH * (i + 1)]
                .copy_from_slice(&a.values());
        }
        let mut w = self.workspace();
        let yp = vec![0.; self.dimension()];
        self.evaluate_with_prhr_input(&y, &yp, None, &mut w, input)?;
        y[l.energies_start..l.temperatures_start].copy_from_slice(w.thermal.energies()?);
        y[l.barrel_energy] = w.barrel.energy()?;
        Ok(y)
    }
    pub fn evaluate(
        &self,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        w: &mut Workspace,
    ) -> Result<(), String> {
        self.evaluate_with_prhr_input(y, yp, cj, w, None)
    }
    pub fn evaluate_with_prhr_input(
        &self,
        y: &[f64],
        yp: &[f64],
        cj: Option<f64>,
        w: &mut Workspace,
        input: Option<crate::prhr::Input>,
    ) -> Result<(), String> {
        w.valid = false;
        w.jacobian_cj = None;
        w.energy_rate_tangent = None;
        w.pool_port = None;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || y.len() != self.dimension()
            || yp.len() != self.dimension()
            || y.iter().chain(yp).any(|x| !x.is_finite())
            || cj.is_some_and(|c| !c.is_finite() || c < 0.)
        {
            return Err("Invalid composed cold trial/workspace".into());
        }
        let l = self.layout;
        let yn = &y[l.network_start..l.carrier_start];
        let p = &self.pressure_connection;
        let primary = p.primary_cell;
        let pressure = self.network.eos_pressure(primary, yn);
        let temperature = self.network.temperature(primary, yn);
        let mut liquid = [crate::Liquid::default()];
        crate::liquid_batch(
            &[crate::LiquidQuery {
                pressure,
                temperature,
            }],
            &mut liquid,
        )
        .map_err(|e| e.message)?;
        w.hot_liquid = liquid[0];
        let (ports, pool_port) = self.current_pressure_ports(
            yn,
            w.hot_liquid,
            array(&y[l.pressurizer_start..l.surge_start]),
        )?;
        w.pressure_ports = ports;
        w.pool_port = Some(pool_port);
        p.surge.evaluate(
            array(&y[l.surge_start..l.surge_carrier_start]),
            array(&yp[l.surge_start..l.surge_carrier_start]),
            &w.pressure_ports,
            cj,
            &mut w.surge,
        )?;
        let receipts = w.surge.receipts()?;
        p.pressurizer.evaluate(
            array(&y[l.pressurizer_start..l.surge_start]),
            array(&yp[l.pressurizer_start..l.surge_start]),
            cp::Balance {
                mass: -receipts.mass[1],
                energy: -receipts.energy[1],
            },
            cj,
            &mut w.pressurizer,
        )?;
        let mass = self.network.mass(primary, w.hot_liquid);
        let (material, _) = self.pressure_material(
            y,
            None,
            mass,
            0.,
            w.pressurizer.diagnostics()?,
            None,
            [receipts.mass[0], -receipts.mass[1]],
        )?;
        w.pressure_material_rates = material;
        w.network.evaluate_with_inputs(
            &self.network,
            yn,
            &yp[l.network_start..l.carrier_start],
            cj,
            &[on::LiquidPort {
                cell: primary,
                mass_rate: -receipts.mass[0],
                energy_rate: -receipts.energy[0],
                marker_rate: (material[1] + material[2]) / p.atoms_per_marker,
            }],
            input,
        )?;
        for i in 0..self.carrier.cells() {
            w.mass[i] = w.network.chart_mass[i];
            w.products[i] = wc::Amounts {
                hydrogen: y[l.carrier_start + wc::WIDTH * i],
                boron10: y[l.carrier_start + wc::WIDTH * i + 1],
                boron: y[l.carrier_start + wc::WIDTH * i + 2],
            };
            let liquid = w.network.liquids[i];
            w.density[i] = liquid.density;
            w.water[i] = ft::Water {
                pressure_pa: liquid.pressure,
                temperature_k: liquid.temperature,
                saturation_temperature_k: sg_secondary::cold_saturation_temperature(
                    liquid.temperature,
                    liquid.pressure,
                )?,
                mass_flow_kg_s: self.water_flows[i].map_or(0., |e| w.network.mass_flows[e]),
                conductivity_w_m_k: liquid.conductivity,
                viscosity_pa_s: liquid.viscosity,
                cp_j_kg_k: liquid.cp,
            };
            w.barrel_water[i] = bt::Water {
                temperature_k: liquid.temperature,
                density_kg_m3: liquid.density,
                saturation_temperature_k: w.water[i].saturation_temperature_k,
            };
        }
        self.carrier
            .stocks_into(&w.mass, &w.products, &mut w.stocks)?;
        for (t, &r) in w.fuel_temperature.iter_mut().zip(&self.fuel_rows) {
            *t = y[l.temperatures_start + r];
        }
        self.source.evaluate_coupled_into(
            &y[..l.source_end],
            &w.fuel_temperature,
            &w.stocks,
            &mut w.source,
        )?;
        w.deposited.fill(0.);
        for (&r, &q) in self.fuel_rows.iter().zip(w.source.fuel_deposition()?) {
            w.deposited[r] = q;
        }
        self.capture
            .evaluate(w.source.fuel_capture_events()?, &w.density, &mut w.capture)?;
        self.mobile_capture.evaluate(
            &self.source,
            w.source.water_birth_events()?,
            &w.density,
            &mut w.mobile_capture,
        )?;
        for (&r, &q) in self.fuel_rows.iter().zip(w.capture.fuel_heat()?) {
            w.deposited[r] += q;
        }
        for (q, &c) in w.deposited.iter_mut().zip(w.capture.clad_heat()?) {
            *q += c;
        }
        for (q, &c) in w.deposited.iter_mut().zip(&w.mobile_capture.value()?.clad) {
            *q += c;
        }
        if cj.is_some() {
            self.thermal.evaluate_into(
                &y[l.temperatures_start..l.barrel_energy],
                &w.deposited,
                &w.water,
                &mut w.thermal,
            )?;
        } else {
            self.thermal.evaluate_values_into(
                &y[l.temperatures_start..l.barrel_energy],
                &w.deposited,
                &w.water,
                &mut w.thermal,
            )?;
        }
        let b = self.barrel.config();
        let mn = self.source.mn_targets()[b.mn_owner];
        let target_captures = w.source.target_captures()?;
        let captures = b.targets.map(|t| target_captures[t]);
        self.barrel.evaluate(
            y[l.barrel_temperature],
            &captures,
            mn.decay_rate * y[self.source.target_row(mn.target)],
            &w.barrel_water,
            &mut w.barrel,
        )?;
        self.absorber_guide.evaluate(
            &y[l.absorber_guide_temperatures_start..l.absorber_guide_exported],
            &w.source,
            &y[..l.source_end],
            &w.barrel_water,
            &mut w.absorber_guide,
        )?;
        self.carrier.rates_into(
            &w.mass,
            &w.products,
            &w.network.mass_flows,
            w.source.external_water_events()?,
            &mut w.product_rates,
        )?;
        if let (Some(p), Some(pw)) = (self.network.prhr(), &w.network.prhr) {
            for (c, response) in p.config.mixing.iter().zip(&pw.mixing) {
                let a = w.products[c.from].values();
                let b = w.products[c.to].values();
                let flux = std::array::from_fn::<_, 3, _>(|k| {
                    response.coefficient * (a[k] / w.mass[c.from] - b[k] / w.mass[c.to])
                });
                let ar = w.product_rates[c.from].values();
                let br = w.product_rates[c.to].values();
                w.product_rates[c.from] =
                    wc::Amounts::from_values(std::array::from_fn(|k| ar[k] - flux[k]));
                w.product_rates[c.to] =
                    wc::Amounts::from_values(std::array::from_fn(|k| br[k] + flux[k]));
            }
        }
        let primary_values = w.product_rates[primary].values();
        w.product_rates[primary] =
            wc::Amounts::from_values(std::array::from_fn(|k| primary_values[k] + material[k]));
        for i in 0..l.source_end {
            w.residual[i] = yp[i] - w.source.rates()?[i];
        }
        w.residual[l.network_start..l.carrier_start].copy_from_slice(&w.network.residual);
        for i in 0..self.carrier.cells() {
            for (k, rate) in w.product_rates[i].values().into_iter().enumerate() {
                w.residual[l.carrier_start + wc::WIDTH * i + k] =
                    yp[l.carrier_start + wc::WIDTH * i + k] - rate;
            }
        }
        for b in 0..self.thermal.band_count() {
            w.residual[l.network_start + self.network.energy_row(self.thermal.band_water(b))] -=
                w.thermal.wall_rates()?[b];
        }
        for (i, &q) in w.barrel.water_heat()?.iter().enumerate() {
            w.residual[l.network_start + self.network.energy_row(i)] -= q;
        }
        for (i, &q) in w.capture.water_heat()?.iter().enumerate() {
            w.residual[l.network_start + self.network.energy_row(i)] -= q;
        }
        for (i, &q) in w.mobile_capture.value()?.water.iter().enumerate() {
            w.residual[l.network_start + self.network.energy_row(i)] -= q;
        }
        for (i, &q) in w.absorber_guide.value.water.iter().enumerate() {
            w.residual[l.network_start + self.network.energy_row(i)] -= q;
        }
        for i in 0..self.absorber_guide.host_count() {
            w.residual[l.absorber_guide_energies_start + i] = yp
                [l.absorber_guide_energies_start + i]
                - w.absorber_guide.value.host[i]
                - w.mobile_capture.value()?.host[i];
            w.residual[l.absorber_guide_temperatures_start + i] =
                y[l.absorber_guide_energies_start + i] - w.absorber_guide.energy[i];
        }
        w.residual[l.absorber_guide_exported] =
            yp[l.absorber_guide_exported] - w.absorber_guide.value.exported;
        for i in 0..self.thermal.node_count() {
            w.residual[l.energies_start + i] =
                yp[l.energies_start + i] - w.thermal.heat_rates()?[i];
            w.residual[l.temperatures_start + i] =
                y[l.energies_start + i] - w.thermal.energies()?[i];
        }
        w.residual[l.barrel_energy] =
            yp[l.barrel_energy] - w.barrel.heat_rate()? - w.mobile_capture.value()?.barrel;
        w.residual[l.barrel_temperature] = y[l.barrel_energy] - w.barrel.energy()?;
        w.residual[l.barrel_released] = yp[l.barrel_released] - w.barrel.emitted_rate()?;
        w.residual[l.barrel_exported] = yp[l.barrel_exported] - w.barrel.export_rate()?;
        w.residual[l.pressurizer_start..l.surge_start].copy_from_slice(w.pressurizer.residual()?);
        w.residual[l.surge_start..l.surge_carrier_start].copy_from_slice(w.surge.residual()?);
        for (i, &rate) in material[3..9].iter().enumerate() {
            w.residual[l.surge_carrier_start + i] = yp[l.surge_carrier_start + i] - rate;
        }
        w.residual[l.gas_hydrogen_product] = yp[l.gas_hydrogen_product] - material[9];
        w.residual[l.ambient_exported] = yp[l.ambient_exported]
            - w.pressurizer.diagnostics()?.ambient_heat
            - receipts.ambient_heat;
        w.residual[l.fuel_capture_exported] =
            yp[l.fuel_capture_exported] - w.capture.export_rate()?;
        w.residual[l.mobile_capture_exported] =
            yp[l.mobile_capture_exported] - w.mobile_capture.value()?.exported;
        w.residual[l.mobile_capture_boundary_exported] =
            yp[l.mobile_capture_boundary_exported] - w.mobile_capture.value()?.boundary_exported;
        if w.residual.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite composed residual".into());
        }
        w.energy_rate_balance = compensated(
            self.network
                .installed_energy_rows()
                .map(|r| w.network.rates[r])
                .chain(
                    self.network
                        .prhr()
                        .into_iter()
                        .flat_map(|p| p.receipt_rows())
                        .map(|(r, s)| s * w.network.rates[r]),
                )
                .chain(w.thermal.wall_rates()?.iter().copied())
                .chain(w.thermal.heat_rates()?.iter().copied())
                .chain(w.barrel.water_heat()?.iter().copied())
                .chain(w.capture.water_heat()?.iter().copied())
                .chain(w.mobile_capture.value()?.water.iter().copied())
                .chain(w.mobile_capture.value()?.host.iter().copied())
                .chain(w.absorber_guide.value.host.iter().copied())
                .chain(w.absorber_guide.value.water.iter().copied())
                .chain([w.absorber_guide.value.exported])
                .chain(
                    self.absorber_guide
                        .paid_rows()
                        .map(|(r, q)| -q * w.source.rates().expect("successful source")[r]),
                )
                .chain([
                    w.mobile_capture.value()?.barrel,
                    w.mobile_capture.value()?.exported,
                    w.mobile_capture.value()?.boundary_exported,
                ])
                .chain(
                    self.mobile_capture
                        .paid_energy()
                        .into_iter()
                        .enumerate()
                        .map(|(species, q)| {
                            let product = if species == 0 { 0 } else { 2 };
                            -q * compensated(
                                w.product_rates
                                    .iter()
                                    .map(|r| r.values()[product])
                                    .chain([material[3 + product], material[6 + product]])
                                    .chain((species == 0).then_some(material[9])),
                            )
                        }),
                )
                .chain(
                    self.capture_paid_rows()
                        .map(|(r, q)| -q * w.source.rates().expect("successful source")[r]),
                )
                .chain([w.capture.export_rate()?])
                .chain([
                    w.barrel.heat_rate()?,
                    -w.barrel.emitted_rate()?,
                    w.barrel.export_rate()?,
                ])
                .chain(std::iter::once(
                    -w.source.rates()?[self.source.fuel_release_row()],
                ))
                .chain(w.surge.receipts()?.energy.into_iter())
                .chain([
                    receipts.wall_heat,
                    -receipts.wall_heat - receipts.ambient_heat,
                ])
                .chain(w.pressurizer.energy_rates()?.into_iter())
                .chain([w.pressurizer.diagnostics()?.ambient_heat + receipts.ambient_heat]),
        );
        if !w.energy_rate_balance.is_finite() {
            return Err("Nonfinite composed energy-rate balance".into());
        }
        w.state.copy_from_slice(y);
        w.jacobian_cj = cj;
        w.valid = true;
        Ok(())
    }
    /// Complete residual Jacobian action, including externally owned source
    /// columns. Same selected upwind/heat branches throughout one linear solve.
    pub fn jvp(&self, dy: &[f64], cj: f64, w: &mut Workspace) -> Result<(), String> {
        w.energy_rate_tangent = None;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || w.jacobian_cj != Some(cj)
            || dy.len() != self.dimension()
            || dy.iter().any(|v| !v.is_finite())
        {
            return Err("Composed JVP requires current evaluated trial and matching cj".into());
        }
        let l = self.layout;
        let dn = &dy[l.network_start..l.carrier_start];
        let dp = dn[self.network.pressure_row()];
        for i in 0..self.carrier.cells() {
            let dt = dn[self.network.temperature_row(i)];
            let d = w.network.chart_derivatives[i];
            w.dmass[i] = d[0] * dp + d[1] * dt;
            w.dproducts[i] = wc::Amounts {
                hydrogen: dy[l.carrier_start + wc::WIDTH * i],
                boron10: dy[l.carrier_start + wc::WIDTH * i + 1],
                boron: dy[l.carrier_start + wc::WIDTH * i + 2],
            };
            let [mu, k, cp] = w.network.film_property_direction(i, dp, dt);
            w.dwater[i] = ft::WaterDirection {
                temperature_k: dt,
                mass_flow_kg_s: self.water_flows[i].map_or(0., |e| dn[self.network.flow_row(e)]),
                conductivity_w_m_k: k,
                viscosity_pa_s: mu,
                cp_j_kg_k: cp,
            };
            w.dbarrel_water[i] = bt::WaterDirection {
                temperature_k: dt,
                density_kg_m3: w.network.liquids[i].density
                    * (w.network.liquids[i].compressibility * dp
                        - w.network.liquids[i].expansion * dt),
            };
            w.ddensity[i] = w.dbarrel_water[i].density_kg_m3;
        }
        for (e, dq) in w.dflows.iter_mut().enumerate() {
            *dq = dn[self.network.flow_row(e)];
        }
        self.carrier
            .stock_jvp_into(&w.dmass, &w.dproducts, &mut w.dstocks)?;
        for (t, &r) in w.dfuel_temperature.iter_mut().zip(&self.fuel_rows) {
            *t = dy[l.temperatures_start + r];
        }
        self.source.jvp_coupled_into(
            &dy[..l.source_end],
            &w.dfuel_temperature,
            &w.dstocks,
            &mut w.source,
        )?;
        w.ddeposited.fill(0.);
        for (&r, &q) in self.fuel_rows.iter().zip(w.source.fuel_deposition_jvp()?) {
            w.ddeposited[r] = q;
        }
        self.capture.jvp(
            w.source.fuel_capture_event_jvp()?,
            &w.ddensity,
            &mut w.capture,
        )?;
        self.mobile_capture.jvp(
            w.source.water_birth_event_jvp()?,
            &w.ddensity,
            &mut w.mobile_capture,
        )?;
        for (&r, &q) in self.fuel_rows.iter().zip(w.capture.fuel_heat_jvp()?) {
            w.ddeposited[r] += q;
        }
        for (q, &c) in w.ddeposited.iter_mut().zip(w.capture.clad_heat_jvp()?) {
            *q += c;
        }
        for (q, &c) in w
            .ddeposited
            .iter_mut()
            .zip(&w.mobile_capture.direction()?.clad)
        {
            *q += c;
        }
        self.thermal.jvp_into(
            &dy[l.temperatures_start..l.barrel_energy],
            &w.ddeposited,
            &w.dwater,
            &mut w.thermal,
        )?;
        let b = self.barrel.config();
        let mn = self.source.mn_targets()[b.mn_owner];
        let target_captures = w.source.target_capture_jvp()?;
        let captures = b.targets.map(|t| target_captures[t]);
        self.barrel.jvp(
            dy[l.barrel_temperature],
            &captures,
            mn.decay_rate * dy[self.source.target_row(mn.target)],
            &w.dbarrel_water,
            &mut w.barrel,
        )?;
        self.absorber_guide.jvp(
            &dy[l.absorber_guide_temperatures_start..l.absorber_guide_exported],
            &w.source,
            &dy[..l.source_end],
            &w.dbarrel_water,
            &mut w.absorber_guide,
        )?;
        self.carrier.jvp_into(
            &w.mass,
            &w.products,
            &w.network.mass_flows,
            &w.dmass,
            &w.dproducts,
            &w.dflows,
            w.source.external_water_event_jvp()?,
            &mut w.product_jvp,
        )?;
        if let (Some(p), Some(pw)) = (self.network.prhr(), &w.network.prhr) {
            for (c, response) in p.config.mixing.iter().zip(&pw.mixing) {
                let cols = [
                    self.network.pressure_row(),
                    self.network.temperature_row(c.from),
                    self.network.temperature_row(c.to),
                    self.network.temperature_row(c.sg_water),
                    self.network.flow_row(c.sg_flow_edge),
                ];
                let dk = (0..5)
                    .map(|j| response.partials[j] * dn[cols[j]])
                    .sum::<f64>();
                let a = w.products[c.from].values();
                let b = w.products[c.to].values();
                let da = w.dproducts[c.from].values();
                let db = w.dproducts[c.to].values();
                let flux = std::array::from_fn::<_, 3, _>(|k| {
                    let ca = a[k] / w.mass[c.from];
                    let cb = b[k] / w.mass[c.to];
                    dk * (ca - cb)
                        + response.coefficient
                            * (da[k] / w.mass[c.from]
                                - ca * w.dmass[c.from] / w.mass[c.from]
                                - db[k] / w.mass[c.to]
                                + cb * w.dmass[c.to] / w.mass[c.to])
                });
                let ar = w.product_jvp[c.from].values();
                let br = w.product_jvp[c.to].values();
                w.product_jvp[c.from] =
                    wc::Amounts::from_values(std::array::from_fn(|k| ar[k] - flux[k]));
                w.product_jvp[c.to] =
                    wc::Amounts::from_values(std::array::from_fn(|k| br[k] + flux[k]));
            }
        }
        let (pool_action, line_action, line_tangent, phase_tangent, material_tangent) =
            self.pressure_tangent(dy, cj, w)?;
        let primary = self.pressure_connection.primary_cell;
        let primary_values = w.product_jvp[primary].values();
        w.product_jvp[primary] = wc::Amounts::from_values(std::array::from_fn(|k| {
            primary_values[k] + material_tangent[k]
        }));
        w.jvp.fill(0.);
        for i in 0..l.source_end {
            w.jvp[i] = cj * dy[i] - w.source.rate_jvp()?[i];
        }
        for (col, &direction) in dn.iter().enumerate() {
            for k in self.network.column_pointers[col] as usize
                ..self.network.column_pointers[col + 1] as usize
            {
                w.jvp[l.network_start + self.network.row_indices[k] as usize] +=
                    w.network.jacobian_values[k] * direction;
            }
        }
        self.network.add_port_jvp(
            &[on::LiquidPort {
                cell: primary,
                mass_rate: -line_tangent.mass[0],
                energy_rate: -line_tangent.energy[0],
                marker_rate: (material_tangent[1] + material_tangent[2])
                    / self.pressure_connection.atoms_per_marker,
            }],
            &mut w.jvp[l.network_start..l.carrier_start],
        )?;
        for i in 0..self.carrier.cells() {
            for (k, rate) in w.product_jvp[i].values().into_iter().enumerate() {
                w.jvp[l.carrier_start + wc::WIDTH * i + k] =
                    cj * dy[l.carrier_start + wc::WIDTH * i + k] - rate;
            }
        }
        for b in 0..self.thermal.band_count() {
            w.jvp[l.network_start + self.network.energy_row(self.thermal.band_water(b))] -=
                w.thermal.wall_jvp()?[b];
        }
        for (i, &q) in w.barrel.water_heat_jvp()?.iter().enumerate() {
            w.jvp[l.network_start + self.network.energy_row(i)] -= q;
        }
        for (i, &q) in w.capture.water_heat_jvp()?.iter().enumerate() {
            w.jvp[l.network_start + self.network.energy_row(i)] -= q;
        }
        for (i, &q) in w.mobile_capture.direction()?.water.iter().enumerate() {
            w.jvp[l.network_start + self.network.energy_row(i)] -= q;
        }
        for (i, &q) in w.absorber_guide.direction.water.iter().enumerate() {
            w.jvp[l.network_start + self.network.energy_row(i)] -= q;
        }
        for i in 0..self.absorber_guide.host_count() {
            w.jvp[l.absorber_guide_energies_start + i] = cj
                * dy[l.absorber_guide_energies_start + i]
                - w.absorber_guide.direction.host[i]
                - w.mobile_capture.direction()?.host[i];
            w.jvp[l.absorber_guide_temperatures_start + i] = dy
                [l.absorber_guide_energies_start + i]
                - w.absorber_guide.capacity[i] * dy[l.absorber_guide_temperatures_start + i];
        }
        w.jvp[l.absorber_guide_exported] =
            cj * dy[l.absorber_guide_exported] - w.absorber_guide.direction.exported;
        for i in 0..self.thermal.node_count() {
            w.jvp[l.energies_start + i] = cj * dy[l.energies_start + i] - w.thermal.heat_jvp()?[i];
            w.jvp[l.temperatures_start + i] = dy[l.energies_start + i] - w.thermal.energy_jvp()?[i];
        }
        w.jvp[l.barrel_energy] =
            cj * dy[l.barrel_energy] - w.barrel.heat_jvp()? - w.mobile_capture.direction()?.barrel;
        w.jvp[l.barrel_temperature] =
            dy[l.barrel_energy] - w.barrel.capacity()? * dy[l.barrel_temperature];
        w.jvp[l.barrel_released] = cj * dy[l.barrel_released] - w.barrel.emitted_jvp()?;
        w.jvp[l.barrel_exported] = cj * dy[l.barrel_exported] - w.barrel.export_jvp()?;
        w.jvp[l.pressurizer_start..l.surge_start].copy_from_slice(&pool_action);
        w.jvp[l.surge_start..l.surge_carrier_start].copy_from_slice(&line_action);
        for (i, &rate) in material_tangent[3..9].iter().enumerate() {
            w.jvp[l.surge_carrier_start + i] = cj * dy[l.surge_carrier_start + i] - rate;
        }
        w.jvp[l.gas_hydrogen_product] = cj * dy[l.gas_hydrogen_product] - material_tangent[9];
        w.jvp[l.ambient_exported] = cj * dy[l.ambient_exported]
            - phase_tangent[cp::DIAGNOSTIC_AMBIENT_HEAT]
            - line_tangent.ambient_heat;
        w.jvp[l.fuel_capture_exported] =
            cj * dy[l.fuel_capture_exported] - w.capture.export_jvp()?;
        w.jvp[l.mobile_capture_exported] =
            cj * dy[l.mobile_capture_exported] - w.mobile_capture.direction()?.exported;
        w.jvp[l.mobile_capture_boundary_exported] = cj * dy[l.mobile_capture_boundary_exported]
            - w.mobile_capture.direction()?.boundary_exported;
        if w.jvp.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite composed JVP".into());
        }
        let balance = compensated(
            std::iter::once(w.network.energy_rate_jvp(&self.network, dn)?)
                .chain(
                    self.network
                        .prhr()
                        .into_iter()
                        .flat_map(|p| p.receipt_rows())
                        .map(|(r, s)| s * (cj * dn[r] - w.jvp[l.network_start + r])),
                )
                .chain(w.thermal.wall_jvp()?.iter().copied())
                .chain(w.thermal.heat_jvp()?.iter().copied())
                .chain(w.barrel.water_heat_jvp()?.iter().copied())
                .chain(w.capture.water_heat_jvp()?.iter().copied())
                .chain(w.mobile_capture.direction()?.water.iter().copied())
                .chain(w.mobile_capture.direction()?.host.iter().copied())
                .chain(w.absorber_guide.direction.host.iter().copied())
                .chain(w.absorber_guide.direction.water.iter().copied())
                .chain([w.absorber_guide.direction.exported])
                .chain(
                    self.absorber_guide
                        .paid_rows()
                        .map(|(r, q)| -q * w.source.rate_jvp().expect("successful source JVP")[r]),
                )
                .chain([
                    w.mobile_capture.direction()?.barrel,
                    w.mobile_capture.direction()?.exported,
                    w.mobile_capture.direction()?.boundary_exported,
                ])
                .chain(
                    self.mobile_capture
                        .paid_energy()
                        .into_iter()
                        .enumerate()
                        .map(|(species, q)| {
                            let product = if species == 0 { 0 } else { 2 };
                            -q * compensated(
                                w.product_jvp
                                    .iter()
                                    .map(|r| r.values()[product])
                                    .chain([
                                        material_tangent[3 + product],
                                        material_tangent[6 + product],
                                    ])
                                    .chain((species == 0).then_some(material_tangent[9])),
                            )
                        }),
                )
                .chain(
                    self.capture_paid_rows()
                        .map(|(r, q)| -q * w.source.rate_jvp().expect("successful source JVP")[r]),
                )
                .chain([w.capture.export_jvp()?])
                .chain([
                    w.barrel.heat_jvp()?,
                    -w.barrel.emitted_jvp()?,
                    w.barrel.export_jvp()?,
                ])
                .chain(std::iter::once(
                    -w.source.rate_jvp()?[self.source.fuel_release_row()],
                ))
                .chain([
                    -line_tangent.energy[0],
                    line_tangent.energy[0],
                    line_tangent.energy[1],
                    line_tangent.wall_heat,
                    -line_tangent.wall_heat - line_tangent.ambient_heat,
                ])
                .chain(std::iter::once(
                    self.pressure_connection
                        .pressurizer
                        .complete_energy_rate_jvp(
                            &w.pressurizer,
                            array(&dy[l.pressurizer_start..l.surge_start]),
                            cp::Balance {
                                mass: -line_tangent.mass[1],
                                energy: -line_tangent.energy[1],
                            },
                        )?,
                ))
                .chain([phase_tangent[cp::DIAGNOSTIC_AMBIENT_HEAT] + line_tangent.ambient_heat]),
        );
        if !balance.is_finite() {
            return Err("Nonfinite composed energy-rate tangent".into());
        }
        w.energy_rate_tangent = Some(balance);
        Ok(())
    }
    /// Domain and ownership only. Caller additionally admits current E(T),
    /// hydraulic/chart corrections, independent ledgers and the paired error
    /// policy. A successful constitutive evaluation is NOT solver admission.
    pub fn validate_accepted(&self, y: &[f64], w: &Workspace) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || y.len() != self.dimension()
            || y.iter()
                .zip(&w.state)
                .any(|(a, b)| a.to_bits() != b.to_bits())
        {
            return Err("Accepted composed state has no matching successful evaluation".into());
        }
        self.source
            .validate_accepted_state(&y[..self.layout.source_end])?;
        self.carrier.validate_accepted(&w.mass, &w.products)?;
        let l = self.layout;
        let h = self.carrier.hydrogen_per_kg();
        for (row, mass) in [
            (l.surge_carrier_start, y[l.surge_start + fs::MASS]),
            (
                l.pool_carrier_start,
                y[l.pressurizer_start + cp::LIQUID_MASS],
            ),
        ] {
            let a = &y[row..row + wc::WIDTH];
            let total = h * mass;
            if a.iter().any(|v| *v < 0.) || !total.is_finite() || a[0] > total {
                return Err("Invalid accepted pressure-support liquid chemistry".into());
            }
        }
        let gas_total = h * y[l.pressurizer_start + cp::VAPOR_MASS];
        if !gas_total.is_finite()
            || y[l.gas_hydrogen_product] < 0.
            || y[l.gas_hydrogen_product] > gas_total
        {
            return Err("Invalid accepted pressure-support vapor hydrogen".into());
        }
        if y[self.layout.barrel_released] < 0.
            || y[self.layout.barrel_exported] < 0.
            || y[l.fuel_capture_exported] < 0.
            || y[l.mobile_capture_exported] < 0.
            || y[l.mobile_capture_boundary_exported] < 0.
            || y[l.absorber_guide_exported] < 0.
        {
            return Err("Negative accepted nuclear release/export history".into());
        }
        Ok(())
    }
}

//! One offline cold source/fuel/primary/SG residual. Component owners retain
//! their laws; this module owns ONLY their physical incidence and chain rule.
//! No time integrator, Pack installation, recipient for unjoined binding heat,
//! acoustic mode, hot geometry or phase continuation is implied.
use crate::{fuel_thermal as ft, moderator_source::Stocks, operating_network as on,
    source_evolution as se, water_carrier as wc, sg_secondary};
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub source_end: usize,
    pub network_start: usize,
    pub products_start: usize,
    pub energies_start: usize,
    pub temperatures_start: usize,
    pub dimension: usize,
}
pub struct Model {
    pub source: se::Evolution,
    pub network: on::Network,
    pub thermal: ft::Model,
    pub carrier: wc::Carrier,
    pub layout: Layout,
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
    pub residual: Vec<f64>,
    pub jvp: Vec<f64>,
    mass: Vec<f64>, dmass: Vec<f64>,
    products: Vec<wc::Products>, dproducts: Vec<wc::Products>,
    product_rates: Vec<wc::Products>, product_jvp: Vec<wc::Products>,
    stocks: Vec<Stocks>, dstocks: Vec<Stocks>,
    fuel_temperature: Vec<f64>, dfuel_temperature: Vec<f64>,
    deposited: Vec<f64>, ddeposited: Vec<f64>,
    water: Vec<ft::Water>, dwater: Vec<ft::WaterDirection>,
    dflows: Vec<f64>,
    state: Vec<f64>,
    jacobian_cj: Option<f64>,
    owner: Arc<()>,
    valid: bool,
    energy_rate_balance: f64,
    energy_rate_tangent: Option<f64>,
}
fn compensated(values: impl Iterator<Item=f64>)->f64 {
    let (mut s,mut c)=(0f64,0f64);
    for v in values {let t=s+v;c+=if s.abs()>=v.abs(){(s-t)+v}else{(v-t)+s};s=t;}
    s+c
}
impl Workspace {
    /// Read-only current primary view for a separately retained coefficient
    /// diagnostic. Never a second state owner or a frozen integration input.
    pub fn external_stocks(&self)->Result<&[Stocks],String> {
        if !self.valid {return Err("No current composed carrier view".into());} Ok(&self.stocks)
    }
    /// Actual independently assembled installed-energy rate minus paid fuel
    /// release. Never replaced with the analytically expected zero.
    pub fn complete_energy_rate(&self)->Result<f64,String> {
        if !self.valid {return Err("No current composed energy-rate balance".into());}
        Ok(self.energy_rate_balance)
    }
    /// Same rate balance differentiated by the last successful full JVP,
    /// without recovering tiny rates by subtracting large cj-shifted actions.
    pub fn complete_energy_rate_jvp(&self)->Result<f64,String> {
        if !self.valid {return Err("No current composed energy-rate tangent".into());}
        self.energy_rate_tangent.ok_or("No current composed energy-rate tangent".into())
    }
}
impl Model {
    pub fn new(source: se::Evolution, network: on::Network, thermal: ft::Model,
        carrier: wc::Carrier, fuel_rows: Vec<usize>, water_flows: Vec<Option<usize>>,
        original_temperature: Vec<f64>) -> Result<Self,String> {
        let nw=network.config().water.len(); let nt=thermal.node_count();
        if source.external_water_count()!=nw || carrier.cells()!=nw || thermal.water_count()!=nw || water_flows.len()!=nw
            || original_temperature.len()!=nt || original_temperature.iter().any(|x| !x.is_finite())
            || fuel_rows.len()!=source.prepared_temperatures().len()
            || fuel_rows.len()!=thermal.fuel_node_count()
            || fuel_rows.iter().any(|&r| r>=nt || !thermal.is_fuel_node(r))
            || fuel_rows.iter().copied().collect::<std::collections::BTreeSet<_>>().len()!=fuel_rows.len()
            || water_flows.iter().enumerate().any(|(i,e)| e.is_some_and(|e|
                e>=network.config().hydraulic.len() || network.config().hydraulic[e].to!=i))
            || (0..thermal.band_count()).any(|b|water_flows[thermal.band_water(b)].is_none())
            || carrier.links().len()!=network.config().hydraulic.len()
            || carrier.links().iter().zip(&network.config().hydraulic).any(|(a,b)|a.from!=b.from||a.to!=b.to)
            || carrier.volumes().iter().zip(&network.config().water).any(|(a,b)|a.to_bits()!=b.geometry.volume.to_bits()) {
            return Err("Invalid cold source/cooling incidence".into());
        }
        for (&r,&t) in fuel_rows.iter().zip(source.prepared_temperatures()) {
            if original_temperature[r].to_bits()!=t.to_bits() {
                return Err("Source and thermal ORIGINAL preparation differ".into());
            }
        }
        // Both preparations come from the same physical cohort records. Do
        // not permit a separately authored caloric mass or an accidental
        // permutation to change the temperature response of source fuel.
        if fuel_rows.iter().zip(source.fuel_history().fuel().cohorts())
            .any(|(&r,c)|thermal.fuel_mass_kg(r).is_none_or(|m|m.to_bits()!=c.mass.to_bits())) {
            return Err("Source and thermal fuel reference masses differ".into());
        }
        let ns=source.state_count(); let nn=network.dimension();
        let products_start=ns.checked_add(nn).ok_or("Coupled layout overflow")?;
        let energies_start=products_start.checked_add(2*nw).ok_or("Coupled layout overflow")?;
        let temperatures_start=energies_start.checked_add(nt).ok_or("Coupled layout overflow")?;
        let dimension=temperatures_start.checked_add(nt).ok_or("Coupled layout overflow")?;
        Ok(Self {source,network,thermal,carrier,fuel_rows,water_flows,original_temperature,
            layout:Layout {source_end:ns,network_start:ns,products_start,energies_start,temperatures_start,dimension},
            owner:Arc::new(())})
    }
    pub fn fuel_rows(&self)->&[usize] {&self.fuel_rows}
    pub fn dimension(&self)->usize {self.layout.dimension}
    pub fn is_differential(&self,row:usize)->bool {
        let l=self.layout;
        row<l.source_end || (row<l.products_start && self.network.is_differential(row-l.network_start))
            || (row>=l.products_start && row<l.temperatures_start)
    }
    pub fn workspace(&self)->Workspace {
        let nw=self.carrier.cells(); let nt=self.thermal.node_count();
        let stock=Stocks{water_mass:0.,liquid_volume:0.,hydrogen_target:0.,hydrogen_product:0.,mobile_boron10:0.};
        let water=ft::Water{pressure_pa:0.,temperature_k:0.,saturation_temperature_k:0.,mass_flow_kg_s:0.,
            conductivity_w_m_k:0.,viscosity_pa_s:0.,cp_j_kg_k:0.};
        Workspace{source:self.source.workspace(),network:on::Workspace::new(&self.network),thermal:self.thermal.workspace(),
            residual:vec![0.;self.dimension()],jvp:vec![0.;self.dimension()],mass:vec![0.;nw],dmass:vec![0.;nw],
            products:vec![wc::Products::default();nw],dproducts:vec![wc::Products::default();nw],
            product_rates:vec![wc::Products::default();nw],product_jvp:vec![wc::Products::default();nw],
            stocks:vec![stock;nw],dstocks:vec![stock;nw],fuel_temperature:vec![0.;self.fuel_rows.len()],
            dfuel_temperature:vec![0.;self.fuel_rows.len()],deposited:vec![0.;nt],ddeposited:vec![0.;nt],
            water:vec![water;nw],dwater:vec![ft::WaterDirection::default();nw],
            dflows:vec![0.;self.network.config().hydraulic.len()],state:vec![0.;self.dimension()],
            jacobian_cj:None,owner:self.owner.clone(),valid:false,energy_rate_balance:0.,energy_rate_tangent:None}
    }
    /// Fresh physical preparation. Caller still solves network algebraic
    /// consistency; a zero-filled derivative is NOT a solved initial state.
    pub fn initial_state(&self)->Result<Vec<f64>,String> {
        let l=self.layout; let mut y=vec![0.;self.dimension()];
        y[..l.source_end].copy_from_slice(&self.source.initial_state());
        y[l.network_start..l.products_start].copy_from_slice(&self.network.initial_state()?);
        y[l.temperatures_start..].copy_from_slice(&self.original_temperature);
        let mut w=self.workspace(); let yp=vec![0.;self.dimension()];
        self.evaluate(&y,&yp,None,&mut w)?;
        y[l.energies_start..l.temperatures_start].copy_from_slice(w.thermal.energies()?);
        Ok(y)
    }
    pub fn evaluate(&self,y:&[f64],yp:&[f64],cj:Option<f64>,w:&mut Workspace)->Result<(),String> {
        w.valid=false;w.jacobian_cj=None;w.energy_rate_tangent=None;
        if !Arc::ptr_eq(&self.owner,&w.owner) || y.len()!=self.dimension() || yp.len()!=self.dimension()
            || y.iter().chain(yp).any(|x| !x.is_finite()) || cj.is_some_and(|c| !c.is_finite()||c<0.) {
            return Err("Invalid composed cold trial/workspace".into());
        }
        let l=self.layout;let yn=&y[l.network_start..l.products_start];
        w.network.evaluate(&self.network,yn,&yp[l.network_start..l.products_start],cj)?;
        for i in 0..self.carrier.cells() {
            w.mass[i]=w.network.chart_mass[i];
            w.products[i]=wc::Products{hydrogen:y[l.products_start+2*i],boron:y[l.products_start+2*i+1]};
            let liquid=w.network.liquids[i];
            w.water[i]=ft::Water{pressure_pa:liquid.pressure,temperature_k:liquid.temperature,
                saturation_temperature_k:sg_secondary::cold_saturation_temperature(liquid.temperature,liquid.pressure)?,
                mass_flow_kg_s:self.water_flows[i].map_or(0.,|e|w.network.mass_flows[e]),
                conductivity_w_m_k:liquid.conductivity,viscosity_pa_s:liquid.viscosity,cp_j_kg_k:liquid.cp};
        }
        self.carrier.stocks_into(&w.mass,&w.products,&mut w.stocks)?;
        for (t,&r) in w.fuel_temperature.iter_mut().zip(&self.fuel_rows) {*t=y[l.temperatures_start+r];}
        self.source.evaluate_coupled_into(&y[..l.source_end],&w.fuel_temperature,&w.stocks,&mut w.source)?;
        w.deposited.fill(0.);
        for (&r,&q) in self.fuel_rows.iter().zip(w.source.fuel_deposition()?) {w.deposited[r]=q;}
        if cj.is_some() {
            self.thermal.evaluate_into(&y[l.temperatures_start..],&w.deposited,&w.water,&mut w.thermal)?;
        } else {
            self.thermal.evaluate_values_into(&y[l.temperatures_start..],&w.deposited,&w.water,&mut w.thermal)?;
        }
        self.carrier.rates_into(&w.mass,&w.products,&w.network.mass_flows,w.source.external_water_events()?,&mut w.product_rates)?;
        for i in 0..l.source_end {w.residual[i]=yp[i]-w.source.rates()?[i];}
        w.residual[l.network_start..l.products_start].copy_from_slice(&w.network.residual);
        for i in 0..self.carrier.cells() {
            w.residual[l.products_start+2*i]=yp[l.products_start+2*i]-w.product_rates[i].hydrogen;
            w.residual[l.products_start+2*i+1]=yp[l.products_start+2*i+1]-w.product_rates[i].boron;
        }
        for b in 0..self.thermal.band_count() {
            w.residual[l.network_start+self.network.energy_row(self.thermal.band_water(b))]-=w.thermal.wall_rates()?[b];
        }
        for i in 0..self.thermal.node_count() {
            w.residual[l.energies_start+i]=yp[l.energies_start+i]-w.thermal.heat_rates()?[i];
            w.residual[l.temperatures_start+i]=y[l.energies_start+i]-w.thermal.energies()?[i];
        }
        if w.residual.iter().any(|x|!x.is_finite()) {return Err("Nonfinite composed residual".into());}
        w.energy_rate_balance=compensated(
            (0..self.network.config().water.len()+self.network.config().solids.len())
                .map(|i|w.network.rates[self.network.energy_row(i)])
                .chain((0..self.network.config().secondaries.len()).map(|i|w.network.rates[self.network.secondary_energy_row(i)]))
                .chain(w.thermal.wall_rates()?.iter().copied())
                .chain(w.thermal.heat_rates()?.iter().copied())
                .chain(std::iter::once(-w.source.rates()?[self.source.fuel_release_row()])));
        if !w.energy_rate_balance.is_finite() {return Err("Nonfinite composed energy-rate balance".into());}
        w.state.copy_from_slice(y);w.jacobian_cj=cj;w.valid=true;Ok(())
    }
    /// Complete residual Jacobian action, including externally owned source
    /// columns. Same selected upwind/heat branches throughout one linear solve.
    pub fn jvp(&self,dy:&[f64],cj:f64,w:&mut Workspace)->Result<(),String> {
        w.energy_rate_tangent=None;
        if !Arc::ptr_eq(&self.owner,&w.owner) || !w.valid || w.jacobian_cj!=Some(cj)
            || dy.len()!=self.dimension() || dy.iter().any(|v|!v.is_finite()) {
            return Err("Composed JVP requires current evaluated trial and matching cj".into());
        }
        let l=self.layout; let dn=&dy[l.network_start..l.products_start];
        let dp=dn[self.network.pressure_row()];
        for i in 0..self.carrier.cells() {
            let dt=dn[self.network.temperature_row(i)];let d=w.network.chart_derivatives[i];
            w.dmass[i]=d[0]*dp+d[1]*dt;
            w.dproducts[i]=wc::Products{hydrogen:dy[l.products_start+2*i],boron:dy[l.products_start+2*i+1]};
            let [mu,k,cp]=w.network.film_property_direction(i,dp,dt);
            w.dwater[i]=ft::WaterDirection{temperature_k:dt,
                mass_flow_kg_s:self.water_flows[i].map_or(0.,|e|dn[self.network.flow_row(e)]),
                conductivity_w_m_k:k,viscosity_pa_s:mu,cp_j_kg_k:cp};
        }
        for (e,dq) in w.dflows.iter_mut().enumerate() {*dq=dn[self.network.flow_row(e)];}
        self.carrier.stock_jvp_into(&w.dmass,&w.dproducts,&mut w.dstocks)?;
        for (t,&r) in w.dfuel_temperature.iter_mut().zip(&self.fuel_rows) {*t=dy[l.temperatures_start+r];}
        self.source.jvp_coupled_into(&dy[..l.source_end],&w.dfuel_temperature,&w.dstocks,&mut w.source)?;
        w.ddeposited.fill(0.);
        for (&r,&q) in self.fuel_rows.iter().zip(w.source.fuel_deposition_jvp()?) {w.ddeposited[r]=q;}
        self.thermal.jvp_into(&dy[l.temperatures_start..],&w.ddeposited,&w.dwater,&mut w.thermal)?;
        self.carrier.jvp_into(&w.mass,&w.products,&w.network.mass_flows,&w.dmass,&w.dproducts,&w.dflows,
            w.source.external_water_event_jvp()?,&mut w.product_jvp)?;
        w.jvp.fill(0.);
        for i in 0..l.source_end {w.jvp[i]=cj*dy[i]-w.source.rate_jvp()?[i];}
        for (col,&direction) in dn.iter().enumerate() {
            for k in self.network.column_pointers[col] as usize..self.network.column_pointers[col+1] as usize {
                w.jvp[l.network_start+self.network.row_indices[k] as usize]+=w.network.jacobian_values[k]*direction;
            }
        }
        for i in 0..self.carrier.cells() {
            w.jvp[l.products_start+2*i]=cj*dy[l.products_start+2*i]-w.product_jvp[i].hydrogen;
            w.jvp[l.products_start+2*i+1]=cj*dy[l.products_start+2*i+1]-w.product_jvp[i].boron;
        }
        for b in 0..self.thermal.band_count() {
            w.jvp[l.network_start+self.network.energy_row(self.thermal.band_water(b))]-=w.thermal.wall_jvp()?[b];
        }
        for i in 0..self.thermal.node_count() {
            w.jvp[l.energies_start+i]=cj*dy[l.energies_start+i]-w.thermal.heat_jvp()?[i];
            w.jvp[l.temperatures_start+i]=dy[l.energies_start+i]-w.thermal.energy_jvp()?[i];
        }
        if w.jvp.iter().any(|x| !x.is_finite()) {return Err("Nonfinite composed JVP".into());}
        let balance=compensated(std::iter::once(w.network.energy_rate_jvp(&self.network,dn)?)
            .chain(w.thermal.wall_jvp()?.iter().copied())
            .chain(w.thermal.heat_jvp()?.iter().copied())
            .chain(std::iter::once(-w.source.rate_jvp()?[self.source.fuel_release_row()])));
        if !balance.is_finite() {return Err("Nonfinite composed energy-rate tangent".into());}
        w.energy_rate_tangent=Some(balance);
        Ok(())
    }
    /// Domain and ownership only. Caller additionally admits current E(T),
    /// hydraulic/chart corrections, independent ledgers and the paired error
    /// policy. A successful constitutive evaluation is NOT solver admission.
    pub fn validate_accepted(&self,y:&[f64],w:&Workspace)->Result<(),String> {
        if !Arc::ptr_eq(&self.owner,&w.owner)||!w.valid||y.len()!=self.dimension()
            || y.iter().zip(&w.state).any(|(a,b)| a.to_bits()!=b.to_bits()) {
            return Err("Accepted composed state has no matching successful evaluation".into());
        }
        self.source.validate_accepted_state(&y[..self.layout.source_end])?;
        self.carrier.validate_accepted(&w.mass,&w.products)?;
        Ok(())
    }
}

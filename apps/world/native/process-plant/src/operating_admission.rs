//! Shared cold-network qualification weights and physical admission. These
//! are prospective engineering screens, not calibrated plant error bounds.
//! Inputs are an already evaluated CURRENT network workspace; composed callers
//! supply the actual exchanged-energy expectation, never claim a closed bath.
use crate::{operating_network::{Network,Workspace},GRAVITY};

pub const CHART_PRESSURE_LIMIT_PA: f64 = 5.;
pub const CHART_TEMPERATURE_LIMIT_K: f64 = 1e-4;

/// Pointwise EOS consistency, distinct from integration error or conservation.
/// The workspace must have been prepared at this exact current network state.
#[derive(Debug)]
pub struct ChartCorrections {
    pub primary: [f64; 2],
    pub secondary: [f64; 2],
    pub property_requests: usize,
    primary_context: (usize, f64, f64),
    secondary_context: Option<(usize, f64, f64)>,
}
impl ChartCorrections {
    /// Same physical limits for accepted endpoints and nonlinear convergence.
    pub fn check(&self) -> Result<(), String> {
        if self.primary.iter().chain(&self.secondary).any(|v|!v.is_finite()||*v<0.) {
            return Err("Invalid current network chart corrections".into());
        }
        if self.secondary[0] > CHART_PRESSURE_LIMIT_PA
            || self.secondary[1] > CHART_TEMPERATURE_LIMIT_K
        {
            let Some((k, dp, dt)) = self.secondary_context else {
                return Err("Invalid current secondary chart corrections".into());
            };
            return Err(format!(
                "Returned wet secondary chart {k}: dp={dp}, dT={dt}"
            ));
        }
        if self.primary[0] > CHART_PRESSURE_LIMIT_PA || self.primary[1] > CHART_TEMPERATURE_LIMIT_K
        {
            let (i, dp, dt) = self.primary_context;
            return Err(format!(
                "Returned shared chart correction node {i}: dp={dp}, dT={dt}"
            ));
        }
        Ok(())
    }
}

/// Holding differential regional energies and total mass fixed, solve the
/// current arrow chart for its pressure/temperature correction. This neither
/// projects the state nor changes the EOS, residual or solver error weights.
pub fn chart_corrections(
    n: &Network,
    w: &Workspace,
    y: &[f64],
) -> Result<ChartCorrections, String> {
    if y.len() != n.dimension()
        || y.iter().any(|v| !v.is_finite())
        || w.residual.len() != n.dimension()
        || w.chart_derivatives.len() != n.config().water.len()
        || w.residual.iter().any(|v| !v.is_finite())
        || w.chart_derivatives
            .iter()
            .any(|a| a.iter().any(|v| !v.is_finite()) || a[3] <= 0.)
    {
        return Err("Invalid current network chart input".into());
    }
    w.check_current_chart(n, y)?;
    let mut result = ChartCorrections {
        primary: [0.; 2],
        secondary: [0.; 2],
        property_requests: 0,
        primary_context: (0, 0., 0.),
        secondary_context: None,
    };
    let mut compliance = 0.;
    let mut dm = w.residual[n.pressure_row()];
    for (i, &[mp, mt, ep, et]) in w.chart_derivatives.iter().enumerate() {
        compliance += mp - mt * ep / et;
        dm -= mt / et * w.residual[n.temperature_row(i)];
    }
    if !compliance.is_finite() || compliance <= 0. {
        return Err("Returned shared inventory chart rank".into());
    }
    let dp = dm / compliance;
    for (i, &[_, _, ep, et]) in w.chart_derivatives.iter().enumerate() {
        let dt = (w.residual[n.temperature_row(i)] - ep * dp) / et;
        if !dp.is_finite() || !dt.is_finite() {
            return Err(format!(
                "Returned shared chart correction node {i}: dp={dp}, dT={dt}"
            ));
        }
        if i == 0 || (dp.abs() <= CHART_PRESSURE_LIMIT_PA && dt.abs() > result.primary[1]) {
            result.primary_context = (i, dp, dt);
        }
        result.primary[0] = result.primary[0].max(dp.abs());
        result.primary[1] = result.primary[1].max(dt.abs());
    }
    let mut worst_secondary = 0.;
    for (k, s) in n.config().secondaries.iter().enumerate() {
        let tr = n.secondary_temperature_row(k);
        let pr = n.secondary_pressure_row(k);
        let a = s.derivatives(n.secondary_inventory(k), y[tr], y[pr])?;
        result.property_requests += 8;
        let ru = w.residual[tr];
        let rg = w.residual[pr];
        let dt = (ru + a[1] * rg / a[3]) / (a[0] - a[1] * a[2] / a[3]);
        let dp = (-rg - a[2] * dt) / a[3];
        if !dp.is_finite() || !dt.is_finite() {
            return Err(format!(
                "Returned wet secondary chart {k}: dp={dp}, dT={dt}"
            ));
        }
        let ratio = (dp.abs() / CHART_PRESSURE_LIMIT_PA).max(dt.abs() / CHART_TEMPERATURE_LIMIT_K);
        if result.secondary_context.is_none() || ratio > worst_secondary {
            result.secondary_context = Some((k, dp, dt));
            worst_secondary = ratio;
        }
        result.secondary[0] = result.secondary[0].max(dp.abs());
        result.secondary[1] = result.secondary[1].max(dt.abs());
    }
    Ok(result)
}

#[derive(Default,Debug)]
pub struct Diagnostics {
    pub ledgers:[f64;3], pub chart:[f64;2], pub secondary_chart:[f64;2],
    pub secondary_material_volume:[f64;2], pub pressure_split:[f64;3],
    pub flow_law_residual:f64, pub held_head_ratio:f64, pub head_roundoff_to_flow_band:f64,
    pub reynolds:f64, pub reynolds_edge:usize, pub speed:f64,
    pub kinetic_temperature:f64, pub dynamic_head:f64, pub omitted_kinetic_energy:f64,
    pub property_requests:usize,
}
pub fn totals(n:&Network,y:&[f64])->[f64;3] {
    let nw=n.config().water.len();
    [y[n.total_mass_row()],(0..nw+n.config().solids.len()).map(|i|y[n.energy_row(i)]).sum::<f64>()
        +(0..n.config().secondaries.len()).map(|k|y[n.secondary_energy_row(k)]).sum::<f64>(),
        (0..nw).map(|i|y[n.marker_row(i)]).sum()]
}
pub fn held_head_ratio(defect:f64,diagonal:f64,atol:f64)->Result<f64,String> {
    let band=diagonal*atol;
    if !defect.is_finite()||!band.is_finite()||band<=0. {return Err("Unresolvable hydraulic diagnostic band".into());}
    Ok(defect.abs()/band)
}
pub struct Weights { pub absolute:Vec<f64>,pub flow:Vec<f64>,pub flow_contrast:f64,pub property_requests:usize }
pub fn weights(n:&Network,w:&Workspace,y:&[f64],horizon:f64,factor:f64)->Result<Weights,String> {
    if y.len()!=n.dimension()||y.iter().any(|v|!v.is_finite())
        ||w.liquids.len()!=n.config().water.len()
        ||w.liquids.iter().any(|l|!l.enthalpy.is_finite()||[l.density,l.cp].iter().any(|v|!v.is_finite()||*v<=0.))
        ||!horizon.is_finite()||horizon<=0.||!factor.is_finite()||factor<=0. {
        return Err("Invalid network weighting inputs".into());
    }
    let nw=n.config().water.len();let ns=n.config().solids.len();let mut absolute=vec![0.;n.dimension()];
    for i in 0..nw {
        absolute[n.energy_row(i)]=n.mass(i,w.liquids[i])*w.liquids[i].cp*1e-3*factor;
        absolute[n.marker_row(i)]=1e-8*factor;absolute[n.temperature_row(i)]=1e-3*factor;
        if let Some(row)=n.mechanical_row(i){absolute[row]=100.*factor;}
    }
    absolute[n.total_mass_row()]=1e-5*factor;absolute[n.pressure_row()]=100.*factor;
    for i in 0..ns {absolute[n.energy_row(nw+i)]=n.config().solids[i].heat_capacity*1e-3*factor;}
    for (k,s) in n.config().secondaries.iter().enumerate() {
        let t=n.secondary_temperature_row(k);let p=n.secondary_pressure_row(k);
        let d=s.derivatives(n.secondary_inventory(k),y[t],y[p])?;
        absolute[n.secondary_energy_row(k)]=(d[0]-d[1]*d[2]/d[3])*1e-3*factor;
        absolute[t]=1e-3*factor;absolute[p]=100.*factor;
    }
    let temperatures:Vec<_>=(0..nw+ns).map(|i|n.temperature(i,y)).collect();
    let tmin=temperatures.iter().copied().fold(f64::INFINITY,f64::min);
    let tmax=temperatures.iter().copied().fold(f64::NEG_INFINITY,f64::max);
    let max_cp=w.liquids.iter().map(|l|l.cp).fold(0_f64,f64::max);
    let heads:Vec<_>=(0..nw).map(|i|w.liquids[i].enthalpy+GRAVITY*n.config().water[i].geometry.elevation).collect();
    let flow_contrast=max_cp*(tmax-tmin)+heads.iter().copied().fold(f64::NEG_INFINITY,f64::max)
        -heads.iter().copied().fold(f64::INFINITY,f64::min);
    if !flow_contrast.is_finite()||flow_contrast<=0. {return Err("Flow weighting requires the declared finite thermal contrast".into());}
    let mut degrees=vec![0_usize;nw];
    for e in &n.config().hydraulic {degrees[e.from]+=1;degrees[e.to]+=1;}
    let flow:Vec<_>=n.config().hydraulic.iter().map(|e|[e.from,e.to].iter().map(|&i|
        n.mass(i,w.liquids[i])*w.liquids[i].cp*1e-3*factor/(horizon*degrees[i] as f64*flow_contrast))
        .fold(f64::INFINITY,f64::min)).collect();
    for (e,&v) in flow.iter().enumerate() {absolute[n.flow_row(e)]=v;}
    if absolute.iter().any(|v|!v.is_finite()||*v<=0.) {return Err("Invalid network error weight".into());}
    Ok(Weights{absolute,flow,flow_contrast,property_requests:8*n.config().secondaries.len()})
}

/// Does not re-evaluate or modify the trial. expected_totals is independently
/// derived by the caller from original stocks and actual boundary receipts.
pub fn screen(n:&Network,w:&Workspace,y:&[f64],expected_totals:[f64;3],flow_atol:&[f64])->Result<Diagnostics,String> {
    if y.len()!=n.dimension()||flow_atol.len()!=n.config().hydraulic.len()
        ||y.iter().chain(&expected_totals).chain(flow_atol).any(|v|!v.is_finite())
        ||flow_atol.iter().any(|v|*v<=0.) {
        return Err("Invalid current network admission input".into());
    }
    let nw=n.config().water.len();
    if w.residual.len()!=n.dimension()||w.liquids.len()!=nw||w.chart_derivatives.len()!=nw
        ||w.mass_flows.len()!=flow_atol.len()||w.secondary_states.len()!=n.config().secondaries.len()
        ||w.residual.iter().chain(&w.mass_flows).any(|v|!v.is_finite())
        ||w.chart_derivatives.iter().any(|a|a.iter().any(|v|!v.is_finite())||a[3]<=0.)
        ||w.liquids.iter().any(|l|[l.pressure,l.temperature,l.density,l.cp,l.compressibility,l.viscosity]
            .iter().any(|v|!v.is_finite()||*v<=0.)) {
        return Err("Invalid current network admission workspace".into());
    }
    let mut d=Diagnostics::default();let actual=totals(n,y);
    for i in 0..3 {d.ledgers[i]=(actual[i]-expected_totals[i]).abs();}
    if d.ledgers.iter().any(|v|!v.is_finite())||d.ledgers[0]>1e-6||d.ledgers[1]>1.||d.ledgers[2]>1e-8 {
        return Err(format!("Closed stock ledger refused: {:?}",d.ledgers));
    }
    let charts=chart_corrections(n,w,y)?;
    charts.check()?;
    d.secondary_chart=charts.secondary;
    d.chart=[charts.primary[0].max(charts.secondary[0]),charts.primary[1].max(charts.secondary[1])];
    d.property_requests+=charts.property_requests;
    for (k,s) in n.config().secondaries.iter().enumerate() {
        let st=w.secondary_states[k];let inv=n.secondary_inventory(k);
        let dm=((st.liquid_mass+st.vapor_mass)-inv.water).abs();let dv=(st.liquid_volume+st.gas_volume-s.volume).abs();
        d.secondary_material_volume[0]=d.secondary_material_volume[0].max(dm);d.secondary_material_volume[1]=d.secondary_material_volume[1].max(dv);
        if !dm.is_finite()||!dv.is_finite()||dm>1e-6||dv>1e-10 {return Err("Closed secondary water ledger refused".into());}
    }
    for i in 0..nw {
        let liquid=w.liquids[i];let pi=n.mechanical_pressure(i,y)-n.eos_pressure(i,y);
        for (j,value) in [pi.abs(),(liquid.compressibility*pi).abs(),pi.abs()/(liquid.density*liquid.cp)].into_iter().enumerate(){d.pressure_split[j]=d.pressure_split[j].max(value);}
        if (liquid.compressibility*pi).abs()>1e-4||pi.abs()/(liquid.density*liquid.cp)>0.01 {return Err(format!("Cold pressure-split approximation exceeded at node {i}: pi={pi}"));}
    }
    for (edge,(e,&q)) in n.config().hydraulic.iter().zip(&w.mass_flows).enumerate() {
        let rho=(w.liquids[e.from].density+w.liquids[e.to].density)*0.5;
        let mu=(w.liquids[e.from].viscosity+w.liquids[e.to].viscosity)*0.5;
        let v=q.abs()/(rho*e.flow_area);let re=q.abs()*e.diameter/(e.flow_area*mu);
        let head=rho*GRAVITY*(n.config().water[e.to].geometry.elevation-n.config().water[e.from].geometry.elevation);
        let pf=n.mechanical_pressure(e.from,y);let pt=n.mechanical_pressure(e.to,y);
        let noise=8.*f64::EPSILON*(pf.abs()+pt.abs()+head.abs());let loss=e.pressure_loss(q,rho,mu);
        let defect=-(pf-pt-head)+loss[0];let band=loss[1]*flow_atol[edge];
        d.held_head_ratio=d.held_head_ratio.max(held_head_ratio(defect,loss[1],flow_atol[edge])?);
        d.head_roundoff_to_flow_band=d.head_roundoff_to_flow_band.max(noise/band);d.flow_law_residual=d.flow_law_residual.max(defect.abs());
        if re>d.reynolds {d.reynolds=re;d.reynolds_edge=edge;}
        d.speed=d.speed.max(v);let cp=w.liquids[e.from].cp.min(w.liquids[e.to].cp);
        d.kinetic_temperature=d.kinetic_temperature.max(v*v/(2.*cp));d.dynamic_head=d.dynamic_head.max(rho*v*v/2.);
        d.omitted_kinetic_energy+=e.length/e.flow_area*q*q/(2.*rho);
    }
    if d.kinetic_temperature>1e-3||d.dynamic_head>100. {return Err(format!("Cold momentum/energy approximation exceeded: K/cp={}, dynamic head={}",d.kinetic_temperature,d.dynamic_head));}
    Ok(d)
}

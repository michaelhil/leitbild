//! Solver coordinates for the selected autonomous finite armature. The
//! physical owner remains unchanged: every consumer sees its exact state on
//! the sole SOURCE/water clock. GAP/V retain their evidence rows but become
//! algebraic zero-deviation identities, and C = JACK_HEAT - D(t) integrates
//! only non-armature heat. D includes continuous damping and the once-only
//! accepted open stop. The physical GAP/V jump changes neither solver target.
use leitbild_plant_numerics::{control_armature as ca, control_release as cr, source_motion as sm};

#[derive(Clone, Copy)]
struct Rows { gap: usize, velocity: usize, jack: usize }

pub(super) struct Coordinates {
    dimension: usize,
    config: Option<ca::Config>,
    rows: Vec<Rows>,
}

#[derive(Clone, Copy)]
struct Sample { state: ca::State, rate: ca::State, heat: f64, heat_rate: f64 }

impl Coordinates {
    pub fn new(model: &sm::Model) -> Result<Self, String> {
        let config=model.release.as_ref().map(|r|r.input.armature);
        if let Some(c)=config {c.validate()?;}
        Ok(Self {dimension:model.dimension(),config,
            rows:if config.is_some() {(0..model.clusters()).map(|k|Rows {
                gap:model.release_row(k,cr::GAP),velocity:model.release_row(k,cr::GAP_V),
                jack:model.motion_row(k,sm::JACK_HEAT),
            }).collect()} else {Vec::new()}})
    }
    fn shape(&self, values: &[f64]) -> Result<(), String> {
        if values.len()!=self.dimension {Err("Wrong exact-armature coordinate dimension".into())} else {Ok(())}
    }
    fn retained<'a>(&self,time:f64,mode:&'a sm::Mode)->Result<Option<&'a cr::Mode>,String> {
        if !time.is_finite() || time<0. {return Err("Invalid exact-armature common-clock time".into());}
        match (self.config,mode.release.as_ref()) {
            (None,None)=>Ok(None),
            (Some(_),Some(retained))=>{retained.validate(self.rows.len())?;Ok(Some(retained))},
            _=>Err("Exact-armature coordinates differ from retained physical owner".into()),
        }
    }
    fn sample(config:ca::Config,mode:&cr::Mode,k:usize,time:f64)->Result<Sample,String> {
        let zero=ca::State::default();
        let sample=match mode.armatures[k] {
            ca::Mode::Latched|ca::Mode::StuckLatched=>Sample {state:zero,rate:zero,heat:0.,heat_rate:0.},
            ca::Mode::Opening=>{
                let response=config.exact(mode.openings[k].ok_or("Missing actual armature opening epoch")?,time)?;
                Sample {state:response.state,rate:ca::State {gap_m:response.state.velocity_m_s,
                    velocity_m_s:response.acceleration_m_s2},heat:response.damping_heat_j,
                    heat_rate:response.damping_to_jack_w}
            },
            ca::Mode::Open=>{
                let epoch=mode.openings[k].ok_or("Missing actual open-armature epoch")?;
                if time<epoch.epoch_time_s {return Err("Open armature precedes its actual release epoch".into());}
                config.validate_accepted(epoch.state,ca::Mode::Opening)?;
                let state=ca::State {gap_m:config.stroke_m,velocity_m_s:0.};
                Sample {state,rate:zero,heat:config.energy_j(epoch.state)?-config.energy_j(state)?,heat_rate:0.}
            },
        };
        if !sample.heat.is_finite() || sample.heat<0. || !sample.heat_rate.is_finite() || sample.heat_rate<0. {
            return Err("Invalid exact-armature heat chart".into());
        }
        Ok(sample)
    }
    fn map(&self,time:f64,mode:&sm::Mode,values:&mut [f64],rate:bool,recover:bool)->Result<(),String> {
        self.shape(values)?;
        let Some(retained)=self.retained(time,mode)? else {return Ok(());};
        let config=self.config.ok_or("Missing exact-armature physical configuration")?;
        // Prepare every sample before changing any coordinate. Invalid history
        // cannot leave a half-decoded physical vector.
        let samples=(0..self.rows.len()).map(|k|Self::sample(config,retained,k,time)).collect::<Result<Vec<_>,_>>()?;
        for (rows,sample) in self.rows.iter().zip(samples) {
            let heat=if rate {sample.heat_rate} else {sample.heat};
            values[rows.jack]+=if recover {heat} else {-heat};
            if recover {
                let actual=if rate {sample.rate} else {sample.state};
                values[rows.gap]=actual.gap_m;values[rows.velocity]=actual.velocity_m_s;
            } else {values[rows.gap]=0.;values[rows.velocity]=0.;}
        }
        Ok(())
    }
    pub fn recover_state(&self,time:f64,mode:&sm::Mode,values:&mut [f64])->Result<(),String> {
        self.map(time,mode,values,false,true)
    }
    pub fn recover_rates(&self,time:f64,mode:&sm::Mode,values:&mut [f64])->Result<(),String> {
        self.map(time,mode,values,true,true)
    }
    pub fn encode_state(&self,time:f64,mode:&sm::Mode,values:&mut [f64])->Result<(),String> {
        self.map(time,mode,values,false,false)
    }
    pub fn encode_rates(&self,time:f64,mode:&sm::Mode,values:&mut [f64])->Result<(),String> {
        self.map(time,mode,values,true,false)
    }
    pub fn direction_to_physical(&self,values:&mut [f64])->Result<(),String> {
        self.shape(values)?;
        for rows in &self.rows {values[rows.gap]=0.;values[rows.velocity]=0.;}
        Ok(())
    }
    pub fn residual(&self,time:f64,mode:&sm::Mode,raw:&[f64],out:&mut [f64])->Result<(),String> {
        self.shape(raw)?;self.shape(out)?;
        self.retained(time,mode)?;
        self.identity_rows(raw,out)
    }
    /// Both JVP and P solves have exact identity rows in these two algebraic
    /// coordinates. No physical GAP direction enters any remaining equation.
    pub fn identity_rows(&self,raw:&[f64],out:&mut [f64])->Result<(),String> {
        self.shape(raw)?;self.shape(out)?;
        for rows in &self.rows {out[rows.gap]=raw[rows.gap];out[rows.velocity]=raw[rows.velocity];}
        Ok(())
    }
    pub fn is_differential(&self,model:&sm::Model,row:usize)->bool {
        if self.config.is_some() && row>=model.release_row(0,0) && row<self.dimension
            && (row-model.release_row(0,0))%cr::WIDTH<2 {false} else {model.is_differential(row)}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn apparatus()->(Coordinates,sm::Mode) {
        // Test-only coordinate map, not a production plant/model bypass.
        let config=ca::Config {mass_kg:1.,stroke_m:0.01,spring_n_m:20_000.,damping_n_s_m:20.};
        let coords=Coordinates {dimension:6,config:Some(config),rows:vec![Rows {gap:2,velocity:3,jack:0}]};
        let mut mode=sm::Mode::new(sm::Input {requested_rate_m_s:0.,motive_power_w:0.,holding_power_w:1.},1).unwrap();
        let mut release=cr::Mode::new(1).unwrap();release.initial_density=Some(997.);
        release.armature_support_event(0,config,ca::State::default(),32.,false,ca::ReleaseFailure::None).unwrap();
        mode.release=Some(release);(coords,mode)
    }
    fn close(a:f64,b:f64) {assert!((a-b).abs()<=128.*f64::EPSILON*(1.+a.abs()+b.abs()),"{a} != {b}");}
    #[test]
    fn state_and_rate_round_trip_opening_and_open() {
        let (coords,mut mode)=apparatus();
        for open in [false,true] {
            if open {mode.release.as_mut().unwrap().armatures[0]=ca::Mode::Open;}
            let mut physical=vec![2.,7.,99.,88.,5.,6.];
            coords.recover_state(32.02,&mode,&mut physical).unwrap();
            let original=physical.clone();coords.encode_state(32.02,&mode,&mut physical).unwrap();
            close(physical[0],2.);assert_eq!(&physical[2..4],&[0.,0.]);
            coords.recover_state(32.02,&mode,&mut physical).unwrap();
            for (a,b) in physical.iter().zip(&original) {close(*a,*b);}
            let mut rates=vec![3.,7.,99.,88.,5.,6.];
            coords.recover_rates(32.02,&mode,&mut rates).unwrap();let original=rates.clone();
            coords.encode_rates(32.02,&mode,&mut rates).unwrap();close(rates[0],3.);
            assert_eq!(&rates[2..4],&[0.,0.]);
            coords.recover_rates(32.02,&mode,&mut rates).unwrap();
            for (a,b) in rates.iter().zip(original) {close(*a,b);}
        }
    }
    #[test]
    fn exact_rows_ignore_iterated_gap_and_have_identity_actions() {
        let (coords,mode)=apparatus();let mut a=vec![2.,7.,99.,88.,5.,6.];let mut b=a.clone();
        b[2]=-123.;b[3]=456.;coords.recover_state(32.001,&mode,&mut a).unwrap();
        coords.recover_state(32.001,&mode,&mut b).unwrap();assert_eq!(a,b);
        let raw=vec![3.,4.,5.,6.,7.,8.];let mut direction=raw.clone();
        coords.direction_to_physical(&mut direction).unwrap();
        assert_eq!(direction,vec![3.,4.,0.,0.,7.,8.]);
        coords.identity_rows(&raw,&mut direction).unwrap();assert_eq!(direction,raw);
        let mut residual=vec![42.;6];coords.residual(32.001,&mode,&raw,&mut residual).unwrap();
        assert_eq!(residual[2],raw[2]);assert_eq!(residual[3],raw[3]);
        let mut encoded=a.clone();coords.encode_state(32.001,&mode,&mut encoded).unwrap();
        coords.residual(32.001,&mode,&encoded,&mut residual).unwrap();
        assert_eq!(&residual[2..4],&[0.,0.]);
        assert_eq!(residual[0],42.);assert_eq!(residual[4],42.);
        assert!(coords.recover_state(31.,&mode,&mut a).is_err());
        assert!(coords.direction_to_physical(&mut [0.;5]).is_err());
    }
    #[test]
    fn physical_stop_heat_preserves_non_armature_jack_coordinate() {
        let (coords,mut mode)=apparatus();let config=coords.config.unwrap();
        let epoch=mode.release.as_ref().unwrap().openings[0].unwrap();
        let (mut lower,mut upper)=(32.,32.02);
        for _ in 0..60 {
            let middle=0.5*(lower+upper);
            if config.exact(epoch,middle).unwrap().state.gap_m<config.stroke_m {lower=middle;} else {upper=middle;}
        }
        let time=upper;let exact=config.exact(epoch,time).unwrap();
        let incoming=ca::State {gap_m:config.stroke_m,velocity_m_s:exact.state.velocity_m_s};
        let (stopped,branch,stop_heat)=config.open_stop(incoming,ca::Mode::Opening).unwrap();
        assert_eq!(branch,ca::Mode::Open);
        let mut before=vec![4.+exact.damping_heat_j,0.,incoming.gap_m,incoming.velocity_m_s,0.,0.];
        coords.encode_state(time,&mode,&mut before).unwrap();
        let mut after=vec![4.+exact.damping_heat_j+stop_heat,0.,stopped.gap_m,stopped.velocity_m_s,0.,0.];
        mode.release.as_mut().unwrap().armatures[0]=ca::Mode::Open;
        coords.encode_state(time,&mode,&mut after).unwrap();close(before[0],after[0]);close(after[0],4.);
        assert_eq!(&before[2..4],&[0.,0.]);assert_eq!(&after[2..4],&[0.,0.]);
        // The anchor is history, not a new zero-heat epoch at the impact.
        assert_eq!(mode.release.as_ref().unwrap().openings[0],Some(epoch));
    }
}

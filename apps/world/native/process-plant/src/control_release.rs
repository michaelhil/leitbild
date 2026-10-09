//! Bounded cold release state and physical contact receipts. The connected
//! SOURCE/motion residual owns the clock, water and all existing heat stocks.
//! These receivers retain impact increments only, not total material heat.
use crate::{absorber_motion as am, control_armature as ca,
    control_release_hydraulics as rh, source_evolution as se};
use std::collections::BTreeSet;

pub const WIDTH: usize = 4;
pub const GAP: usize = 0;
pub const GAP_V: usize = 1;
pub const FITTING_HEAT: usize = 2;
pub const COLLAR_HEAT: usize = 3;
pub const EXTRA_ROOTS: usize = 4;

#[derive(Clone, Debug)]
pub struct Receiver {
    pub targets: Vec<usize>,
    pub volume_m3: f64,
    pub mass_kg: f64,
    pub initial_k: f64,
}
#[derive(Clone, Debug)]
pub struct Contact {
    pub fitting: Receiver,
    pub collar: Receiver,
    pub collar_stock_fraction: f64,
    pub collar_slice_mass_kg: f64,
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum NormalStopPolicy {
    /// Historical abrupt anchored-reference/full-grip brake, retained as a
    /// contrary applicability case even when a normal coast policy is selected.
    AbruptBrake,
    /// Authored backdrivable/freewheel transmission with no always-on brake.
    BackdrivableCoastToHold,
}
/// Cause is supplied by the single actual finite A/B support owner. Input
/// values alone cannot distinguish a healthy stop from controller/B failure.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum SupportCause {
    NormalStop,
    HealthyContinuity,
    FaultOrInvalidatedIntent,
}
#[derive(Clone, Debug)]
pub struct Input {
    pub lift_m: f64,
    pub minimum_stem_m: f64,
    pub armature: ca::Config,
    pub maximum_density_departure: f64,
    pub moving_impact_share: f64,
    pub jacks: Receiver,
    pub contacts: Vec<Contact>,
    pub shoulder: rh::Shoulder,
    pub broad: rh::BroadSelection,
    pub normal_stop: NormalStopPolicy,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Mode {
    /// Bound only after admitted initial consistency; never reconstructed on
    /// support restoration or a later consistent-initialization transaction.
    pub initial_density: Option<f64>,
    pub armatures: Vec<ca::Mode>,
    /// Actual accepted release epoch and initial finite state. This is history
    /// on the composition's sole clock, not an independently advanced clock.
    pub openings: Vec<Option<ca::Opening>>,
    pub body_seated: Vec<bool>,
    pub stem_stopped: Vec<bool>,
}
impl Mode {
    pub fn new(clusters: usize) -> Result<Self, String> {
        if clusters == 0 { return Err("Empty cold release bank".into()); }
        Ok(Self { initial_density: None, armatures: vec![ca::Mode::Latched; clusters],
            openings: vec![None;clusters],
            body_seated: vec![false; clusters], stem_stopped: vec![false; clusters] })
    }
    pub fn validate(&self, clusters: usize) -> Result<(), String> {
        if self.armatures.len()!=clusters || self.body_seated.len()!=clusters
            || self.stem_stopped.len()!=clusters || self.openings.len()!=clusters
            || self.initial_density.is_some_and(|rho| !rho.is_finite() || rho<=0.)
            || (self.initial_density.is_none() && self.armatures.iter().any(|m| *m!=ca::Mode::Latched))
        { return Err("Invalid retained cold release mode".into()); }
        for (branch,epoch) in self.armatures.iter().zip(&self.openings) {
            if matches!(branch,ca::Mode::Opening|ca::Mode::Open)!=epoch.is_some()
                || epoch.is_some_and(|e|!e.epoch_time_s.is_finite() || e.epoch_time_s<0.
                    || !e.state.gap_m.is_finite() || e.state.gap_m<0.
                    || !e.state.velocity_m_s.is_finite() || e.state.velocity_m_s<0.)
            {return Err("Retained armature branch lacks its actual release epoch".into());}
        }
        Ok(())
    }
    /// The accepted support transaction records a release epoch exactly once.
    /// Restored power retains both the physical branch and its original epoch.
    pub fn armature_support_event(&mut self,cluster:usize,config:ca::Config,state:ca::State,
        time_s:f64,hold_available:bool,failure:ca::ReleaseFailure)->Result<(),String>
    {
        self.validate(self.armatures.len())?;
        if !time_s.is_finite() || time_s<0. || cluster>=self.armatures.len()
            || self.openings[cluster].is_some_and(|e|time_s<e.epoch_time_s)
        {return Err("Invalid accepted armature support-event time/cluster".into());}
        let old=self.armatures[cluster];
        let next=config.support_event(state,old,hold_available,failure)?;
        let opening=if old==ca::Mode::Latched && next==ca::Mode::Opening {
            Some(ca::Opening {epoch_time_s:time_s,state})
        } else {self.openings[cluster]};
        if next!=ca::Mode::Latched && self.initial_density.is_none() {
            return Err("Armature release requires its admitted initial liquid density".into());
        }
        self.armatures[cluster]=next;self.openings[cluster]=opening;
        Ok(())
    }
    pub fn snapshot_words(&self) -> Result<String,String> {
        self.validate(self.armatures.len())?;
        let mut out=format!("COLD_RELEASE {} {}\n",self.armatures.len(),
            self.initial_density.map_or_else(||"unbound".into(),|rho|format!("{rho:.17e}")));
        for k in 0..self.armatures.len() {
            let a=match self.armatures[k] {ca::Mode::Latched=>"latched",ca::Mode::StuckLatched=>"stuck",
                ca::Mode::Opening=>"opening",ca::Mode::Open=>"open"};
            out.push_str(&format!("{a} {} {}",u8::from(self.body_seated[k]),u8::from(self.stem_stopped[k])));
            match self.openings[k] {
                None=>out.push_str(" none\n"),
                Some(e)=>out.push_str(&format!(" epoch {:.17e} {:.17e} {:.17e}\n",
                    e.epoch_time_s,e.state.gap_m,e.state.velocity_m_s)),
            }
        }
        Ok(out)
    }
    pub fn restore_words(words:&[&str],clusters:usize)->Result<Self,String> {
        if words.len()<3 || words[0]!="COLD_RELEASE"
            || words[1].parse::<usize>().ok()!=Some(clusters)
        {return Err("Wrong retained cold release frame".into());}
        let mut m=Self::new(clusters)?;
        m.initial_density=if words[2]=="unbound" {None} else {
            Some(words[2].parse().map_err(|_|"Invalid retained release density")?) };
        let boolean=|s|match s {"0"=>Ok(false),"1"=>Ok(true),_=>Err("Invalid retained release stop".to_string())};
        let number=|s:&str|s.parse::<f64>().map_err(|_|"Invalid retained armature epoch".to_string());
        let mut cursor=3;
        for k in 0..clusters {
            let row=words.get(cursor..cursor+4).ok_or("Incomplete retained armature epoch")?;
            m.armatures[k]=match row[0] {"latched"=>ca::Mode::Latched,"stuck"=>ca::Mode::StuckLatched,
                "opening"=>ca::Mode::Opening,"open"=>ca::Mode::Open,_=>return Err("Invalid retained armature branch".into())};
            m.body_seated[k]=boolean(row[1])?;m.stem_stopped[k]=boolean(row[2])?;
            cursor+=4;
            m.openings[k]=match row[3] {
                "none"=>None,
                "epoch"=>{
                    let epoch=words.get(cursor..cursor+3).ok_or("Incomplete retained armature epoch")?;
                    cursor+=3;
                    Some(ca::Opening {epoch_time_s:number(epoch[0])?,state:ca::State {
                        gap_m:number(epoch[1])?,velocity_m_s:number(epoch[2])?,
                    }})
                },
                _=>return Err("Invalid retained armature epoch kind".into()),
            };
        }
        if cursor!=words.len() {return Err("Trailing retained armature epoch fields".into());}
        m.validate(clusters)?;Ok(m)
    }
}
pub struct Model { pub input: Input }
fn same(a:f64,b:f64)->bool {a.is_finite() && b.is_finite() && a>0. && b>0.
    && (a-b).abs()<=64.*f64::EPSILON*a.abs().max(b.abs())}
impl Model {
    pub fn recontact(&self,c:am::Config,s:am::State,added_mass:f64)->Result<am::Impact,String> {
        if !added_mass.is_finite() || added_mass<0. {return Err("Invalid neck contact inertia".into());}
        // Conserves the generalized momentum of the retained kinetic metric.
        // It is not a claim about integral axial liquid momentum or pressure
        // impulses in the fixed enclosure. Lost extended KE heats the joint.
        Ok(am::Config {stem_mass_kg:c.stem_mass_kg+added_mass,..c}.recontact(s)?)
    }
    pub fn new(source:&se::Evolution, input:Input, clusters:usize, density_steel:f64,
        minimum_stem:f64, maximum_stem:f64, gap_stroke:f64)->Result<Self,String>
    {
        input.armature.validate()?;
        if input.contacts.len()!=clusters || clusters==0 || input.lift_m!=0.25
            || input.minimum_stem_m.to_bits()!=minimum_stem.to_bits() || minimum_stem>=0.
            || maximum_stem<input.lift_m || input.armature.stroke_m!=gap_stroke
            || input.maximum_density_departure!=0.01 || input.moving_impact_share!=0.5
        {return Err("Cold release differs from selected connected geometry/contact reduction".into());}
        let bind=|r:&Receiver,count:usize|->Result<(),String> {
            if r.targets.len()!=count || !same(r.volume_m3,r.volume_m3) || !same(r.mass_kg,r.mass_kg)
                || r.initial_k!=300.
                || !same(source.passive_stock_for_targets(&r.targets)?.volume,r.volume_m3)
            {return Err("Cold release receiver differs from its actual SOURCE material stock".into());}
            Ok(())
        };
        bind(&input.jacks,4)?;
        if !same(input.jacks.mass_kg,input.jacks.volume_m3*density_steel)
            || input.armature.mass_kg*clusters as f64>=input.jacks.mass_kg
        {return Err("Cold release armature is not a slice of actual jack mass".into());}
        let mut fittings=BTreeSet::new();
        let collar_targets=&input.contacts[0].collar.targets;
        for contact in &input.contacts {
            bind(&contact.fitting,1)?;bind(&contact.collar,4)?;
            if contact.fitting.mass_kg!=10. || !fittings.insert(contact.fitting.targets[0]) || contact.collar.targets!=*collar_targets
                || contact.collar.targets==input.jacks.targets
                || contact.collar_stock_fraction!=1./(2.*clusters as f64)
                || !same(contact.collar.mass_kg,contact.collar.volume_m3*density_steel)
                || !same(contact.collar_slice_mass_kg,contact.collar.mass_kg*contact.collar_stock_fraction)
            {return Err("Cold release duplicates or changes a finite contact recipient".into());}
        }
        Ok(Self {input})
    }
    pub fn selection(&self, initial_density:f64, maximum_stem:f64)->rh::Selection {
        rh::Selection {initial_density,minimum_stem:self.input.minimum_stem_m,maximum_stem,
            maximum_density_departure:self.input.maximum_density_departure,shoulder:self.input.shoulder}
    }
    pub fn armature_state(&self, y:&[f64])->Result<ca::State,String> {
        if y.len()!=WIDTH {return Err("Wrong cold release state".into());}
        Ok(ca::State {gap_m:y[GAP],velocity_m_s:y[GAP_V]})
    }
    /// BODY seating cannot spend STEM metal or neck kinetic energy.
    pub fn body_impact(&self,c:am::Config,s:am::State)->Result<(am::State,f64,f64),String> {
        if s.body_y_m!=0. || s.body_v_m_s>=0. {return Err("BODY impact needs actual incoming spider/fitting contact".into());}
        let lost=0.5*c.body_mass_kg*s.body_v_m_s.powi(2);
        if !lost.is_finite() {return Err("Nonfinite BODY impact energy".into());}
        Ok((am::State {body_v_m_s:0.,..s},self.input.moving_impact_share*lost,(1.-self.input.moving_impact_share)*lost))
    }
    /// Metal impact and neck KE have different recipients. The returned third
    /// energy is paid entirely to actual UPPER, and debited from bulk-water /
    /// extended-mechanics work once. No grip impulse acts at the shoulder.
    pub fn stem_impact(&self,c:am::Config,s:am::State,neck_ke:f64)->Result<(am::State,f64,f64,f64),String> {
        if s.stem_y_m!=self.input.minimum_stem_m || s.stem_v_m_s>=0.
            || !neck_ke.is_finite() || neck_ke<0.
        {return Err("STEM impact needs actual incoming shoulder/collar contact".into());}
        let lost=0.5*c.stem_mass_kg*s.stem_v_m_s.powi(2);
        if !lost.is_finite() {return Err("Nonfinite STEM impact energy".into());}
        Ok((am::State {stem_v_m_s:0.,..s},self.input.moving_impact_share*lost,(1.-self.input.moving_impact_share)*lost,neck_ke))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model()->Model {
        // Test-only finite contact apparatus. No production material/source
        // constructor is bypassed by the actual connected owner.
        Model {input:Input {lift_m:0.25,minimum_stem_m:8.45-8.49,
            armature:ca::Config {mass_kg:1.,stroke_m:0.01,spring_n_m:20_000.,damping_n_s_m:20.},
            maximum_density_departure:0.01,moving_impact_share:0.5,
            jacks:Receiver {targets:vec![],volume_m3:1.,mass_kg:1.,initial_k:300.},contacts:vec![],
            shoulder:rh::Shoulder {radius_m:0.01,bottom_m:8.49,top_m:8.5},
            broad:rh::BroadSelection {body_area_m2:0.04,stem_area_m2:0.00012,coefficient:1.28},
            normal_stop:NormalStopPolicy::AbruptBrake}}
    }
    fn config()->am::Config {am::Config {body_mass_kg:35.,stem_mass_kg:5.44,force_limit_n:2000.,
        grip_closed_force_n:2000.,gap_stroke_m:0.01,maximum_rate_m_s:0.008,efficiency:0.8,joint_capacity_n:2500.}}
    fn state()->am::State {am::State {body_y_m:0.,body_v_m_s:-0.7,stem_y_m:-0.01,
        stem_v_m_s:-0.9,reference_y_m:0.25}}
    fn close(a:f64,b:f64) {assert!((a-b).abs()<=64.*f64::EPSILON*(1.+a.abs()+b.abs()),"{a} != {b}");}
    #[test]
    fn body_seating_spends_only_body_ke_and_retains_stem_and_neck() {
        let m=model();let c=config();let s=state();let mass=0.27;
        let neck=0.5*mass*s.stem_v_m_s.powi(2);
        let (after,spider,fitting)=m.body_impact(c,s).unwrap();
        assert_eq!(after.stem_y_m.to_bits(),s.stem_y_m.to_bits());
        assert_eq!(after.stem_v_m_s.to_bits(),s.stem_v_m_s.to_bits());
        assert_eq!(after.reference_y_m.to_bits(),s.reference_y_m.to_bits());
        assert_eq!(after.body_y_m,0.);assert_eq!(after.body_v_m_s,0.);
        close(spider,fitting);close(spider+fitting,0.5*c.body_mass_kg*s.body_v_m_s.powi(2));
        close(0.5*mass*after.stem_v_m_s.powi(2),neck);
        close(c.mechanical_energy_j(s,crate::GRAVITY).unwrap()+neck,
            c.mechanical_energy_j(after,crate::GRAVITY).unwrap()+neck+spider+fitting);
        assert!(m.body_impact(c,after).is_err());
        assert!(m.body_impact(c,am::State {body_y_m:1e-12,..s}).is_err());
    }
    #[test]
    fn collar_spends_stem_metal_and_neck_once_to_distinct_recipients() {
        let m=model();let c=config();let s=am::State {stem_y_m:m.input.minimum_stem_m,body_v_m_s:0.,..state()};
        let neck=0.5*0.27*s.stem_v_m_s.powi(2);
        let (after,stem,collar,water)=m.stem_impact(c,s,neck).unwrap();
        close(stem,collar);close(stem+collar,0.5*c.stem_mass_kg*s.stem_v_m_s.powi(2));
        assert_eq!(water,neck);assert_eq!(after.body_v_m_s,s.body_v_m_s);assert_eq!(after.stem_v_m_s,0.);
        // Both independently owned balance domains close under ΔW=-Kneck.
        let before=c.mechanical_energy_j(s,crate::GRAVITY).unwrap()+neck;
        let receipt=-neck;
        close(c.mechanical_energy_j(after,crate::GRAVITY).unwrap()+stem+collar-receipt,before);
        close(water+receipt,0.);
        assert!(m.stem_impact(c,after,0.).is_err());
        assert!(m.stem_impact(c,s,-1e-12).is_err());
    }
    #[test]
    fn generalized_bayonet_impulse_handles_both_signs_of_neck_ke_change() {
        let m=model();let c=config();let mass=0.27;
        let mut signs=BTreeSet::new();
        for (body,stem) in [(-0.5,0.),(0.,0.4)] {
            let s=am::State {body_y_m:0.1,stem_y_m:0.1,body_v_m_s:body,stem_v_m_s:stem,..state()};
            let impact=m.recontact(c,s,mass).unwrap();let v=impact.state.stem_v_m_s;
            close(impact.state.body_v_m_s,v);
            close(c.body_mass_kg*body+(c.stem_mass_kg+mass)*stem,
                (c.body_mass_kg+c.stem_mass_kg+mass)*v);
            let before=0.5*c.body_mass_kg*body*body+0.5*(c.stem_mass_kg+mass)*stem*stem;
            let after=0.5*(c.body_mass_kg+c.stem_mass_kg+mass)*v*v;
            let loss=0.5*c.body_mass_kg*(c.stem_mass_kg+mass)/(c.body_mass_kg+c.stem_mass_kg+mass)*(body-stem).powi(2);
            close(before-after,loss);close(impact.stem_heat_j+impact.spider_heat_j,loss);
            signs.insert((v*v-stem*stem).is_sign_positive());
            assert_eq!(c.stem_mass_kg,5.44);
        }
        assert_eq!(signs.len(),2);
    }
    #[test]
    fn checkpoint_retains_density_failures_stops_and_unbound_lifecycle() {
        let mut mode=Mode::new(52).unwrap();
        assert_eq!(mode,Mode::restore_words(&mode.snapshot_words().unwrap().split_whitespace().collect::<Vec<_>>(),52).unwrap());
        mode.initial_density=Some(997.0000000000001);
        for k in 0..52 {mode.armatures[k]=[ca::Mode::Latched,ca::Mode::StuckLatched,ca::Mode::Opening,ca::Mode::Open][k%4];
            if matches!(mode.armatures[k],ca::Mode::Opening|ca::Mode::Open) {
                mode.openings[k]=Some(ca::Opening {epoch_time_s:32.+k as f64*0.001,state:ca::State::default()});
            }
            mode.body_seated[k]=k%3==0;mode.stem_stopped[k]=k%5==0;}
        let words=mode.snapshot_words().unwrap();let restored=Mode::restore_words(&words.split_whitespace().collect::<Vec<_>>(),52).unwrap();
        assert_eq!(mode,restored);assert_eq!(words,restored.snapshot_words().unwrap());
        mode.initial_density=None;assert!(mode.snapshot_words().is_err());
        for bad in ["COLD_RELEASE 0 unbound","COLD_RELEASE 1 NaN latched 0 0 none",
            "COLD_RELEASE 1 997 opening 2 0 epoch 32 0 0","COLD_RELEASE 1 unbound opening 0 0 epoch 32 0 0",
            "COLD_RELEASE 1 997 opening 0 0 none","COLD_RELEASE 1 997 latched 0 0 epoch 32 0 0",
            "COLD_RELEASE 1 997 open 0 0 epoch NaN 0 0","COLD_RELEASE 1 997 opening 0 0 epoch -1 0 0",
            "COLD_RELEASE 1 997 opening 0 0 epoch 32 -1 0","COLD_RELEASE 1 997 opening 0 0 epoch 32 0 -1",
            "COLD_RELEASE 1 997 opening 0 0 epoch 32 0 0 extra",
            // Deliberately refuse old frames without retained exact history.
            "COLD_RELEASE 1 997 opening 0 0"] {
            assert!(Mode::restore_words(&bad.split_whitespace().collect::<Vec<_>>(),1).is_err());
        }
    }
    #[test]
    fn accepted_release_epoch_is_once_only_and_failed_transactions_are_atomic() {
        let config=model().input.armature;let state=ca::State::default();
        let mut mode=Mode::new(2).unwrap();let before=mode.clone();
        assert!(mode.armature_support_event(0,config,state,32.,false,ca::ReleaseFailure::None).is_err());
        assert_eq!(mode,before);
        mode.initial_density=Some(997.);
        mode.armature_support_event(0,config,state,32.,false,ca::ReleaseFailure::None).unwrap();
        mode.armature_support_event(1,config,state,32.,false,ca::ReleaseFailure::DetentJammed).unwrap();
        let opening=mode.openings[0].unwrap();
        assert_eq!(mode.armatures[1],ca::Mode::StuckLatched);assert_eq!(mode.openings[1],None);
        let actual=config.exact(opening,32.001).unwrap().state;
        mode.armature_support_event(0,config,actual,32.001,true,ca::ReleaseFailure::None).unwrap();
        assert_eq!(mode.armatures[0],ca::Mode::Opening);assert_eq!(mode.openings[0],Some(opening));
        mode.armatures[0]=ca::Mode::Open;
        mode.armature_support_event(0,config,ca::State {gap_m:config.stroke_m,velocity_m_s:0.},33.,true,ca::ReleaseFailure::None).unwrap();
        assert_eq!(mode.armatures[0],ca::Mode::Open);assert_eq!(mode.openings[0],Some(opening));
        let before=mode.clone();
        assert!(mode.armature_support_event(0,config,state,31.,true,ca::ReleaseFailure::None).is_err());
        assert_eq!(mode,before);
        let text=mode.snapshot_words().unwrap();
        assert_eq!(mode,Mode::restore_words(&text.split_whitespace().collect::<Vec<_>>(),2).unwrap());
    }
}

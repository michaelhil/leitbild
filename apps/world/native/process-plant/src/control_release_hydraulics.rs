//! Selected bounded cold release additions to the existing neck force owner.
//! The serial enclosure and already prepared slender-shaft response remain
//! in control_motion_forces. Its final span is replaced by the actual shoulder
//! using the same native law. No water, momentum, energy or clock is added here.
//! Canonical plug-current momentum and moving-tip geometry are separate
//! reversible ports; their constrained sum pays the derived neck KE once.
use crate::{control_motion_forces as cf, control_source_geometry as cg, moving_guide,
    operating_network as on, GRAVITY};
use std::f64::consts::PI;

const N:usize=6;
/// Prepared partial order: STEM pose, STEM speed, current UPPER density,
/// viscosity, absolute pressure at its immutable datum, saturation pressure.
pub type Partials=[f64;N];
#[derive(Clone,Copy,Debug,Default)]
struct D {v:f64,p:Partials}
impl D {
    fn constant(v:f64)->Self {Self{v,p:[0.;N]}}
    fn variable(v:f64,k:usize)->Self {let mut a=Self::constant(v);a.p[k]=1.;a}
    fn scale(self,s:f64)->Self {Self{v:self.v*s,p:self.p.map(|v|v*s)}}
    fn add(self,b:Self)->Self {Self{v:self.v+b.v,p:std::array::from_fn(|i|self.p[i]+b.p[i])}}
    fn sub(self,b:Self)->Self {self.add(b.scale(-1.))}
    fn mul(self,b:Self)->Self {Self{v:self.v*b.v,p:std::array::from_fn(|i|self.p[i]*b.v+self.v*b.p[i])}}
    fn direction(self,d:Partials)->f64 {self.p.into_iter().zip(d).map(|(a,b)|a*b).sum()}
}
#[derive(Clone,Copy,Debug)]
pub struct Upper {
    pub density:f64,
    pub viscosity:f64,
    /// Absolute mechanical pressure at the network's fixed original datum,
    /// not a changed centroid, an end pressure or a bare EOS correction.
    pub pressure_pa:f64,
    pub datum_m:f64,
    pub saturation_pressure_pa:f64,
}
impl Upper {
    pub fn from_current(n:&on::Network,y:&[f64],work:&on::Workspace,upper:usize,
        saturation_pressure_pa:f64)->Result<Self,String>
    {
        work.check_current_chart(n,y)?;
        let l=work.liquids.get(upper).ok_or("Absent actual release UPPER liquid")?;
        Ok(Self{density:l.density,viscosity:l.viscosity,
            pressure_pa:n.mechanical_pressure(upper,y),
            datum_m:n.config().water[upper].geometry.elevation,saturation_pressure_pa})
    }
}
#[derive(Clone,Copy,Debug)]
pub struct Selection {
    /// Bind once from the admitted initial native UPPER chart; retain on restore.
    pub initial_density:f64,
    pub minimum_stem:f64,
    pub maximum_stem:f64,
    pub maximum_density_departure:f64,
    pub shoulder:Shoulder,
}
/// Actual terminal enlargement; no added mass, material or displacement.
#[derive(Clone,Copy,Debug)]
pub struct Shoulder {pub radius_m:f64,pub bottom_m:f64,pub top_m:f64}
/// Authored cold quiescent-plenum bluff-body reduction. The BODY area is the
/// spider's solid radial envelope, not its material-volume divided by height.
/// This does not reconstruct a local velocity field or qualify hot throughflow.
#[derive(Clone,Copy,Debug)]
pub struct BroadSelection {pub body_area_m2:f64,pub stem_area_m2:f64,pub coefficient:f64}
#[derive(Clone,Copy,Debug)]
pub struct BroadPrepared {
    pub body_force_n:f64,pub stem_force_n:f64,pub fluid_work_w:f64,
    body:D,stem:D,work:D,
}
impl BroadSelection {
    pub fn prepare(&self,body_speed:f64,stem_speed:f64,density:f64)->Result<BroadPrepared,String> {
        if ![self.body_area_m2,self.stem_area_m2,self.coefficient,body_speed,stem_speed,density]
            .iter().all(|x|x.is_finite()) || self.body_area_m2<=0. || self.stem_area_m2<=0.
            || self.coefficient<=0. || density<=0.
        {return Err("Invalid cold quiescent-plenum drag input".into());}
        let rho=D::variable(density,2);let bv=D::variable(body_speed,0);let sv=D::variable(stem_speed,1);
        let drag=|v:D,area:f64|rho.mul(v.mul(v).scale(v.v.signum())).scale(-0.5*self.coefficient*area);
        let body=drag(bv,self.body_area_m2);let stem=drag(sv,self.stem_area_m2);
        let work=body.mul(bv).add(stem.mul(sv)).scale(-1.);
        Ok(BroadPrepared{body_force_n:finite(body.v)?,stem_force_n:finite(stem.v)?,
            fluid_work_w:finite(work.v)?,body,stem,work})
    }
    /// Held applicability diagnostic only. A port-mean velocity is not the
    /// unresolved local spider velocity. No nonzero-flow power port is added.
    pub fn throughflow_force_change_n(&self,body_speed:f64,stem_speed:f64,density:f64,
        fluid_speed:f64)->Result<[f64;2],String>
    {
        if !fluid_speed.is_finite() {return Err("Nonfinite broad-drag throughflow diagnostic".into());}
        let rest=self.prepare(body_speed,stem_speed,density)?;
        let flowing=self.prepare(body_speed-fluid_speed,stem_speed-fluid_speed,density)?;
        Ok([flowing.body_force_n-rest.body_force_n,flowing.stem_force_n-rest.stem_force_n])
    }
}
impl BroadPrepared {
    /// Direction order: current density, BODY speed, STEM speed.
    pub fn direction(&self,density:f64,body_speed:f64,stem_speed:f64)->Result<[f64;3],String> {
        let d=[body_speed,stem_speed,density,0.,0.,0.];
        if d.iter().any(|x|!x.is_finite()) {return Err("Nonfinite broad-drag direction".into());}
        Ok([finite(self.body.direction(d))?,finite(self.stem.direction(d))?,finite(self.work.direction(d))?])
    }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum Location {
    InletPlenum, InletAnnulus, InterfaceLower(usize), InterfaceUpper(usize),
    ShoulderBelow, ShoulderAbove, TipBelow, TipAbove, ClosedCap,
}
#[derive(Clone,Copy,Debug)]
pub struct Pressure {
    pub location:Location,
    pub elevation_m:f64,
    /// p-pvap = base + acceleration_coefficient * actual STEM acceleration.
    /// The coefficient includes the actual Qdot=-Ashaft*astem sign.
    pub base_margin_pa:f64,
    pub acceleration_coefficient:f64,
    base:D,
    coefficient:D,
}
impl Default for Pressure {
    fn default()->Self {Self{location:Location::InletPlenum,elevation_m:0.,base_margin_pa:0.,
        acceleration_coefficient:0.,base:D::constant(0.),coefficient:D::constant(0.)}}
}
#[derive(Clone,Copy,Debug)]
pub struct WetMargin {
    pub location:Location,
    pub elevation_m:f64,
    pub margin_pa:f64,
}
#[derive(Clone,Copy,Debug,Default)]
pub struct Prepared {
    pub added_mass_kg:f64,
    pub added_mass_pose_partial:f64,
    pub kinetic_j:f64,
    /// Total non-acceleration inertial force. Add this and -M*a, not the
    /// canonical geometry port again. Metal mass and gravity remain unchanged.
    pub geometry_force_n:f64,
    pub form_force_n:f64,
    /// The only localized-loss heat credit; -form_force*v = Q*sum(deltaP).
    pub form_fluid_work_w:f64,
    /// Replace the already consumed slender final10mm shear/work by the same
    /// native annular law at the actual shoulder radius. Add this correction
    /// once; it is not another whole-neck friction credit.
    pub shoulder_force_correction_n:f64,
    pub shoulder_fluid_work_correction_w:f64,
    pub density_ratio:f64,
    pub pressures:[Pressure;17],
    mass:D,kinetic:D,geometry_force:D,form_force:D,form_work:D,
    inertance:D,inertance_pose_partial:f64,shaft_area:f64,q:D,speed:D,
    shoulder_force:D,shoulder_work:D,
}
#[derive(Clone,Copy,Debug)]
pub struct Direction {
    pub added_mass_kg:f64,
    pub kinetic_j:f64,
    pub geometry_force_n:f64,
    pub form_force_n:f64,
    pub form_fluid_work_w:f64,
    pub shoulder_force_correction_n:f64,
    pub shoulder_fluid_work_correction_w:f64,
}
impl Prepared {
    pub fn direction(&self,d:Partials)->Result<Direction,String> {
        if d.iter().any(|x|!x.is_finite()) {return Err("Nonfinite release hydraulic direction".into());}
        Ok(Direction{added_mass_kg:self.mass.direction(d),kinetic_j:self.kinetic.direction(d),
            geometry_force_n:self.geometry_force.direction(d),form_force_n:self.form_force.direction(d),
            form_fluid_work_w:self.form_work.direction(d),
            shoulder_force_correction_n:self.shoulder_force.direction(d),
            shoulder_fluid_work_correction_w:self.shoulder_work.direction(d)})
    }
    pub fn inertial_force_n(&self,acceleration:f64)->Result<f64,String> {
        finite(self.geometry_force_n-self.added_mass_kg*acceleration)
    }
    pub fn inertial_force_direction_n(&self,acceleration:f64,dacceleration:f64,d:Partials)->Result<f64,String> {
        let tangent=self.direction(d)?;
        finite(tangent.geometry_force_n-tangent.added_mass_kg*acceleration-self.added_mass_kg*dacceleration)
    }
    pub fn kinetic_rate_w(&self,acceleration:f64)->Result<f64,String> {
        finite(self.added_mass_kg*self.speed.v*acceleration
            +0.5*self.added_mass_pose_partial*self.speed.v.powi(3))
    }
    pub fn kinetic_rate_direction_w(&self,acceleration:f64,dacceleration:f64,d:Partials)->Result<f64,String> {
        let tangent=self.direction(d)?;let v=self.speed.v;let dv=d[1];
        finite(tangent.added_mass_kg*v*acceleration+self.added_mass_kg*(dv*acceleration+v*dacceleration)
            +1.5*self.added_mass_pose_partial*v*v*dv)
    }
    /// Canonical generalized pressure equivalent d(IQ)/dt. With an enlarged
    /// terminal shoulder this is a work port normalized by shaft area, not
    /// the actual tip pressure; use `pressures` for local static admission.
    pub fn inertial_pressure_pa(&self,acceleration:f64)->Result<f64,String> {
        finite(-self.inertance.v*self.shaft_area*acceleration
            +self.inertance_pose_partial*self.speed.v*self.q.v)
    }
    pub fn shape_port_force_n(&self)->f64 {0.5*self.inertance_pose_partial*self.q.v*self.q.v}
    pub fn wet_margin(&self,acceleration:f64)->Result<WetMargin,String> {
        if !acceleration.is_finite() {return Err("Nonfinite actual release acceleration".into());}
        let mut minimum=None;
        for p in &self.pressures {
            let margin=WetMargin{location:p.location,elevation_m:p.elevation_m,
                margin_pa:finite(p.base_margin_pa+p.acceleration_coefficient*acceleration)?};
            if minimum.is_none_or(|old:WetMargin|margin.margin_pa<old.margin_pa) {minimum=Some(margin);}
        }
        minimum.ok_or("Empty release pressure support".into())
    }
    /// Held current-location branch. Do not choose the minimum anew per JVP.
    pub fn pressure_direction(&self,index:usize,acceleration:f64,dacceleration:f64,d:Partials)->Result<f64,String> {
        let p=self.pressures.get(index).ok_or("Foreign release pressure location")?;
        if d.iter().any(|x|!x.is_finite()) {return Err("Nonfinite release pressure direction".into());}
        finite(p.base.direction(d)+p.coefficient.direction(d)*acceleration+p.acceleration_coefficient*dacceleration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{moving_guide,operating_network::moving_hydraulic as mh};
    fn stem()->cf::Stem {
        cf::Stem{radius_m:0.006,bottom_m:2.445,top_m:8.5,passages:vec![
            cf::StemPassage{bottom_m:4.,top_m:8.,outer_radius_m:0.125},
            cf::StemPassage{bottom_m:8.,top_m:8.05,outer_radius_m:0.025},
            cf::StemPassage{bottom_m:8.05,top_m:8.05+0.1,outer_radius_m:0.00625},
            cf::StemPassage{bottom_m:8.05+0.1,top_m:8.35,outer_radius_m:0.025},
            cf::StemPassage{bottom_m:8.35,top_m:8.35+0.1,outer_radius_m:0.00625},
            cf::StemPassage{bottom_m:8.35+0.1,top_m:13.6,outer_radius_m:0.025},
        ]}
    }
    fn selection()->Selection {Selection{initial_density:997.,minimum_stem:8.35+0.1-8.49,
        maximum_stem:1.54,maximum_density_departure:0.01,
        shoulder:Shoulder{radius_m:0.01,bottom_m:8.49,top_m:8.5}}}
    fn upper()->Upper {Upper{density:997.,viscosity:0.000855,pressure_pa:300000.,datum_m:2.5,
        saturation_pressure_pa:3536.5894}}
    /// Test-only preparation through the actual shared constitutive law; the
    /// production boundary consumes cf's already prepared values instead.
    fn evaluate(y:f64,v:f64,u:Upper)->Prepared {
        evaluate_selected(selection(),y,v,u)
    }
    fn evaluate_selected(selected:Selection,y:f64,v:f64,u:Upper)->Prepared {
        let s=stem();let stage:Vec<_>=s.passages.iter().map(|p| {
            let x=cg::overlap(s.bottom_m,s.top_m,p.bottom_m,p.top_m,y,true);
            let a=mh::closed_stem(moving_guide::Geometry{outer_radius_m:p.outer_radius_m,
                inner_radius_m:s.radius_m,length_m:x[0],multiplicity:1},v,2e-6,u.density,u.viscosity).unwrap();
            let mut partials=a.loss_partials;partials[3]*=x[1];
            let mut force_partials=a.force_partials;force_partials[3]*=x[1];
            cf::StemPassageStage{length_m:x[0],length_pose_partial:x[1],loss_pa:a.loss_pa,loss_partials:partials,
                force_n:a.force_n,force_partials}
        }).collect();
        selected.prepare_stage(&s,&stage,y,v,u,2e-6).unwrap()
    }
    fn close(a:f64,b:f64,relative:f64) {
        assert!((a-b).abs()<=relative*(1.+a.abs()+b.abs()),"{a} vs {b}");
    }
    #[test]
    fn canonical_ports_pay_exact_neck_ke_and_preserve_actual_metal_mass() {
        for y in [selection().minimum_stem,0.,0.25,1.54] {for v in [-0.3,0.,0.3] {for a in [-GRAVITY,0.,GRAVITY] {
            let p=evaluate(y,v,upper());let shaft=PI*stem().radius_m.powi(2);let q=-shaft*v;
            let kdot=p.added_mass_kg*v*a+0.5*p.added_mass_pose_partial*v.powi(3);
            close(p.inertial_pressure_pa(a).unwrap()*q-p.shape_port_force_n()*v,kdot,2e-14);
            close(shaft*p.inertial_pressure_pa(a).unwrap()+p.shape_port_force_n(),p.inertial_force_n(a).unwrap(),2e-14);
            close(p.inertial_force_n(a).unwrap()*v,-kdot,2e-14);
            close(p.form_fluid_work_w,-p.form_force_n*v,2e-14);
            assert!(p.form_fluid_work_w>=0.);
            if v==0. {assert_eq!(p.kinetic_j,0.);assert_eq!(p.form_force_n,0.);assert_eq!(p.form_fluid_work_w,0.);}
        }}}
        let p=evaluate(0.25,0.,upper());
        assert!(p.added_mass_kg>0.269&&p.added_mass_kg<0.272);
        assert!(p.added_mass_pose_partial>0.&&p.added_mass_pose_partial<0.008);
    }
    #[test]
    fn static_and_reversed_pressure_use_smaller_area_head_and_real_cap() {
        let u=upper();let rest=evaluate(0.25,0.,u);
        for p in rest.pressures {close(p.base_margin_pa,u.pressure_pa+u.density*GRAVITY*(u.datum_m-p.elevation_m)-u.saturation_pressure_pa,2e-14);}
        assert_eq!(rest.wet_margin(0.).unwrap().location,Location::ClosedCap);
        let s=stem();let shaft=PI*s.radius_m.powi(2);
        for v in [-0.25,0.25] {
            let p=evaluate(0.25,v,u);let q=-shaft*v;
            let below=p.pressures.iter().find(|p|p.location==Location::TipBelow).unwrap();
            let above=p.pressures.iter().find(|p|p.location==Location::TipAbove).unwrap();
            let full=PI*s.passages[5].outer_radius_m.powi(2);
            let ann=full-PI*selection().shoulder.radius_m.powi(2);let relative=-full*v;
            let shoulder_velocity=-PI*selection().shoulder.radius_m.powi(2)*v/ann;
            close(ann*(shoulder_velocity-v),full*(-v),2e-14);
            let moving_frame=0.5*selection().initial_density*((shoulder_velocity-v).powi(2)-v*v);
            let ratio=ann/full;let k=if relative>0. {(1.-ratio).powi(2)} else {0.5*(1.-ratio).powf(0.75)};
            let nose_loss=k*u.density*relative*relative.abs()/(2.*ann*ann);
            close(above.base_margin_pa-below.base_margin_pa,moving_frame-nose_loss,2e-11);
            // The collar throat static head is not its total-pressure head.
            let b=p.pressures.iter().find(|p|p.location==Location::InterfaceLower(1)).unwrap();
            let t=p.pressures.iter().find(|p|p.location==Location::InterfaceUpper(1)).unwrap();
            let large=PI*s.passages[1].outer_radius_m.powi(2)-shaft;
            let small=PI*s.passages[2].outer_radius_m.powi(2)-shaft;
            let ratio=small/large;let k=if q>0. {0.5*(1.-ratio).powf(0.75)} else {(1.-ratio).powi(2)};
            let loss=k*u.density*q*q.abs()/(2.*small*small);
            close(t.base_margin_pa-b.base_margin_pa,0.5*selection().initial_density*((q/large).powi(2)-(q/small).powi(2))-loss,2e-12);
        }
        assert!(evaluate(0.25,-0.5,u).wet_margin(0.).unwrap().margin_pa<0.);
    }
    #[test]
    fn prepared_force_ke_and_each_static_pressure_direction_match_signed_differences() {
        let u=upper();let (y,a,da,h)=(0.17,-3.7,0.4,1e-5);
        let d=[0.02,-0.03,0.2,0.00001,12.,0.2];
        for v in [-0.25,0.25] {
            let p=evaluate(y,v,u);let exact=p.direction(d).unwrap();
            let arms=[-1.,1.].map(|s|evaluate(y+s*h*d[0],v+s*h*d[1],Upper{density:u.density+s*h*d[2],
                viscosity:u.viscosity+s*h*d[3],pressure_pa:u.pressure_pa+s*h*d[4],
                saturation_pressure_pa:u.saturation_pressure_pa+s*h*d[5],..u}));
            for (x,lo,hi) in [(exact.added_mass_kg,arms[0].added_mass_kg,arms[1].added_mass_kg),
                (exact.kinetic_j,arms[0].kinetic_j,arms[1].kinetic_j),
                (exact.geometry_force_n,arms[0].geometry_force_n,arms[1].geometry_force_n),
                (exact.form_force_n,arms[0].form_force_n,arms[1].form_force_n),
                (exact.form_fluid_work_w,arms[0].form_fluid_work_w,arms[1].form_fluid_work_w),
                (exact.shoulder_force_correction_n,arms[0].shoulder_force_correction_n,arms[1].shoulder_force_correction_n),
                (exact.shoulder_fluid_work_correction_w,arms[0].shoulder_fluid_work_correction_w,arms[1].shoulder_fluid_work_correction_w)] {
                close(x,(hi-lo)/(2.*h),3e-7);
            }
            close(p.inertial_force_direction_n(a,da,d).unwrap(),
                (arms[1].inertial_force_n(a+h*da).unwrap()-arms[0].inertial_force_n(a-h*da).unwrap())/(2.*h),3e-7);
            close(p.kinetic_rate_direction_w(a,da,d).unwrap(),
                (arms[1].kinetic_rate_w(a+h*da).unwrap()-arms[0].kinetic_rate_w(a-h*da).unwrap())/(2.*h),3e-7);
            close(p.kinetic_rate_w(a).unwrap(),-p.inertial_force_n(a).unwrap()*v,2e-14);
            for i in 0..17 {
                let exact=p.pressure_direction(i,a,da,d).unwrap();
                let val=|k:usize,acc:f64|arms[k].pressures[i].base_margin_pa+arms[k].pressures[i].acceleration_coefficient*acc;
                close(exact,(val(1,a+h*da)-val(0,a-h*da))/(2.*h),3e-6);
            }
        }
    }
    #[test]
    fn actual_shoulder_replaces_exact_native_span_and_owns_both_moving_steps() {
        let s=stem();let selected=selection();let h=selected.shoulder.top_m-selected.shoulder.bottom_m;
        let shaft=PI*s.radius_m.powi(2);let shoulder=PI*selected.shoulder.radius_m.powi(2);
        let full=PI*s.passages[5].outer_radius_m.powi(2);let u=upper();
        // mass_at consumes only the selected stem geometry, not network or
        // force-stage data. Other plan fields are intentionally irrelevant.
        let plan=cf::Plan{lower:0,upper:1,bottom:0.,top:1.,guide_radius:0.02,body_radius:0.01,
            rodlets:1,roughness:2e-6,mouth:0.,bindings:vec![],stems:vec![s.clone()]};
        for y in [selected.minimum_stem,0.,0.25] {for v in [-0.3,0.,0.3] {
            let p=evaluate(y,v,u);
            assert_eq!(selected.mass_at(&plan,0,y).unwrap(),(p.added_mass_kg,p.added_mass_pose_partial));
            let expected_mass=selected.initial_density*s.passages.iter().enumerate().map(|(i,passage)| {
                let length=cg::overlap(s.bottom_m,s.top_m,passage.bottom_m,passage.top_m,y,true)[0];
                let area=PI*passage.outer_radius_m.powi(2)-shaft;
                shaft*shaft*(length-if i==5 {h} else {0.})/area
            }).sum::<f64>()+selected.initial_density*shoulder*shoulder*h/(full-shoulder);
            close(p.added_mass_kg,expected_mass,2e-14);
            let law=|radius|mh::closed_stem(moving_guide::Geometry{outer_radius_m:s.passages[5].outer_radius_m,
                inner_radius_m:radius,length_m:h,multiplicity:1},v,2e-6,u.density,u.viscosity).unwrap();
            let old=law(s.radius_m);let actual=law(selected.shoulder.radius_m);
            close(p.shoulder_force_correction_n,actual.force_n-old.force_n,2e-14);
            close(p.shoulder_fluid_work_correction_w,actual.fluid_work_w-old.fluid_work_w,2e-14);
            let below=p.pressures.iter().find(|p|p.location==Location::ShoulderBelow).unwrap();
            let above=p.pressures.iter().find(|p|p.location==Location::ShoulderAbove).unwrap();
            close(above.acceleration_coefficient,below.acceleration_coefficient,2e-14);
            let a=full-shaft;let b=full-shoulder;let relative=-full*v;
            let ratio=b/a;let k=if relative>=0. {0.5*(1.-ratio).powf(0.75)} else {(1.-ratio).powi(2)};
            let loss=k*u.density*relative*relative.abs()/(2.*b*b);
            let us=-shaft*v/a;let uc=-shoulder*v/b;
            close(above.base_margin_pa-below.base_margin_pa,
                0.5*selected.initial_density*((us-v).powi(2)-(uc-v).powi(2))-loss,2e-11);
            let tip=p.pressures.iter().find(|p|p.location==Location::TipBelow).unwrap();
            close(tip.acceleration_coefficient-above.acceleration_coefficient,
                selected.initial_density*shoulder*h/b,2e-12);
        }}
        assert!(selected.mass_at(&plan,1,0.).is_err());
        assert!(selected.mass_at(&plan,0,selected.minimum_stem-1e-9).is_err());
    }
    #[test]
    fn broad_surrogate_is_signed_reciprocal_with_exact_zero_and_uncertainty_scaling() {
        let selected=BroadSelection{body_area_m2:PI*0.115_f64.powi(2),
            stem_area_m2:PI*0.006_f64.powi(2)+2.*0.003*0.002,coefficient:1.28};
        for b in [-0.3,0.,0.3] {for s in [-0.4,0.,0.4] {
            let p=selected.prepare(b,s,997.).unwrap();
            close(p.fluid_work_w,-p.body_force_n*b-p.stem_force_n*s,2e-14);
            assert!(p.fluid_work_w>=0.);
            for scale in [0.5,2.] {
                let altered=BroadSelection{coefficient:selected.coefficient*scale,..selected}.prepare(b,s,997.).unwrap();
                close(altered.body_force_n,scale*p.body_force_n,2e-14);
                close(altered.stem_force_n,scale*p.stem_force_n,2e-14);
                close(altered.fluid_work_w,scale*p.fluid_work_w,2e-14);
            }
            let (dr,db,ds,h)=(0.2,0.03,-0.02,1e-5);
            let exact=p.direction(dr,db,ds).unwrap();
            let lo=selected.prepare(b-h*db,s-h*ds,997.-h*dr).unwrap();
            let hi=selected.prepare(b+h*db,s+h*ds,997.+h*dr).unwrap();
            for (x,a,z) in [(exact[0],lo.body_force_n,hi.body_force_n),
                (exact[1],lo.stem_force_n,hi.stem_force_n),(exact[2],lo.fluid_work_w,hi.fluid_work_w)] {
                close(x,(z-a)/(2.*h),3e-7);
            }
        }}
        let zero=selected.prepare(0.,0.,997.).unwrap();
        assert_eq!([zero.body_force_n,zero.stem_force_n,zero.fluid_work_w],[0.;3]);
        assert_eq!(zero.direction(1.,1.,1.).unwrap(),[0.;3]);
        let flow=selected.throughflow_force_change_n(0.,0.,997.,0.01).unwrap();
        assert!(flow.into_iter().all(|f|f>0.)); // finite at rest; no division by body speed
        assert!(selected.prepare(f64::NAN,0.,997.).is_err());
    }
    #[test]
    fn disappearing_shoulder_base_has_no_floor_or_duplicate_viscous_span() {
        let s=stem();let mut selected=selection();selected.shoulder.radius_m=s.radius_m;
        for v in [-0.3,0.,0.3] {
            let p=evaluate_selected(selected,0.25,v,upper());
            let a=p.pressures.iter().find(|p|p.location==Location::ShoulderBelow).unwrap();
            let b=p.pressures.iter().find(|p|p.location==Location::ShoulderAbove).unwrap();
            assert_eq!(a.base_margin_pa,b.base_margin_pa);
            assert_eq!(a.acceleration_coefficient,b.acceleration_coefficient);
            assert_eq!(p.shoulder_force_correction_n,0.);
            assert_eq!(p.shoulder_fluid_work_correction_w,0.);
            let shaft=PI*s.radius_m.powi(2);
            let expected=selected.initial_density*shaft*shaft*s.passages.iter().map(|passage| {
                cg::overlap(s.bottom_m,s.top_m,passage.bottom_m,passage.top_m,0.25,true)[0]
                    /(PI*passage.outer_radius_m.powi(2)-shaft)
            }).sum::<f64>();
            close(p.added_mass_kg,expected,2e-14);
        }
    }
    #[test]
    fn geometry_material_and_trial_pressure_refusals_are_not_clipped() {
        let s=stem();let u=upper();
        assert!(selection().prepare_stage(&s,&[],0.,0.,u,2e-6).is_err());
        assert!(evaluate(0.,0.,u).direction([f64::NAN;6]).is_err());
        assert!(evaluate(0.,0.,u).wet_margin(f64::NAN).is_err());
        let mut p=evaluate(0.,0.,u);p.pressures[0].acceleration_coefficient=f64::MAX;
        assert!(p.wet_margin(f64::MAX).is_err());
        let stage=[cf::StemPassageStage::default();6];
        assert!(selection().prepare_stage(&s,&stage,0.,0.,Upper{density:1008.,..u},2e-6).is_err());
        assert!(selection().prepare_stage(&s,&stage,selection().minimum_stem-1e-9,0.,u,2e-6).is_err());
        assert!(selection().prepare_stage(&s,&stage,1.540001,0.,u,2e-6).is_err());
    }
}
fn finite(v:f64)->Result<f64,String> {
    if v.is_finite() {Ok(v)} else {Err("Nonfinite release hydraulic result".into())}
}
impl Selection {
    /// Pure current-geometry energy support for event accounting/checkpoints.
    /// No property law, distributed friction, fluid state or new anchor is
    /// evaluated here; the same function supplies the stage's added mass.
    pub fn mass_at(&self,plan:&cf::Plan,cluster:usize,pose:f64)->Result<(f64,f64),String> {
        self.mass_from_stem(plan.stems.get(cluster).ok_or("Foreign release mass stem")?,pose)
    }
    fn mass_from_stem(&self,stem:&cf::Stem,pose:f64)->Result<(f64,f64),String> {
        if stem.passages.len()!=6 || ![self.initial_density,self.minimum_stem,self.maximum_stem,pose,
            stem.radius_m,stem.bottom_m,stem.top_m,self.shoulder.radius_m,self.shoulder.bottom_m,self.shoulder.top_m]
            .iter().all(|x|x.is_finite()) || self.initial_density<=0. || stem.radius_m<=0.
            || pose<self.minimum_stem || pose>self.maximum_stem || self.maximum_stem<=self.minimum_stem
            || self.shoulder.radius_m<stem.radius_m || self.shoulder.top_m!=stem.top_m
            || self.shoulder.top_m<=self.shoulder.bottom_m
        {return Err("Release mass outside selected geometry/anchor".into());}
        let shaft=PI*stem.radius_m.powi(2);let shoulder=PI*self.shoulder.radius_m.powi(2);
        let p=&stem.passages;
        if stem.bottom_m+self.maximum_stem>=p[0].bottom_m
            || self.shoulder.bottom_m+self.minimum_stem<p[5].bottom_m
            || stem.top_m+self.maximum_stem>=p[5].top_m
        {return Err("Release mass loses its complete serial support".into());}
        let mut sum=0.;
        for (i,a) in p.iter().enumerate() {
            let area=PI*a.outer_radius_m.powi(2)-shaft;
            if ![a.bottom_m,a.top_m,a.outer_radius_m,area].iter().all(|x|x.is_finite())
                || area<=0. || a.top_m<=a.bottom_m || (i>0&&p[i-1].top_m!=a.bottom_m)
            {return Err("Release mass has invalid serial geometry".into());}
            let length=if i==5 {self.shoulder.bottom_m+pose-a.bottom_m} else {a.top_m-a.bottom_m};
            sum+=shaft*shaft*length/area;
        }
        let final_area=PI*p[5].outer_radius_m.powi(2);
        if shoulder>=final_area {return Err("Release shoulder closes its annulus".into());}
        sum+=shoulder*shoulder*(self.shoulder.top_m-self.shoulder.bottom_m)/(final_area-shoulder);
        Ok((finite(self.initial_density*sum)?,finite(self.initial_density*shaft*shaft/(final_area-shaft))?))
    }
    pub fn prepare_current(&self,plan:&cf::Plan,work:&cf::Workspace,n:&on::Network,
        y:&[f64],nw:&on::Workspace,cluster:usize,pose:cg::Pose,speed:f64,
        saturation_pressure_pa:f64)->Result<Prepared,String>
    {
        work.check_current_network_state(plan,n,y)?;
        let upper=Upper::from_current(n,y,nw,plan.upper,saturation_pressure_pa)?;
        self.prepare(plan,work,cluster,pose,speed,upper)
    }
    pub fn prepare(&self,plan:&cf::Plan,work:&cf::Workspace,cluster:usize,
        pose:cg::Pose,speed:f64,upper:Upper)->Result<Prepared,String>
    {
        let stage=work.stem_passage_stage(plan,cluster,pose,speed)?;
        let stem=plan.stems.get(cluster).ok_or("Foreign release stem")?;
        self.prepare_stage(stem,stage,pose.stem,speed,upper,plan.roughness)
    }
    fn prepare_stage(&self,stem:&cf::Stem,stage:&[cf::StemPassageStage],pose:f64,speed:f64,upper:Upper,
        roughness:f64)->Result<Prepared,String>
    {
        if ![self.initial_density,self.minimum_stem,self.maximum_stem,self.maximum_density_departure,
            self.shoulder.radius_m,self.shoulder.bottom_m,self.shoulder.top_m,roughness,
            pose,speed,upper.density,upper.viscosity,upper.pressure_pa,upper.datum_m,upper.saturation_pressure_pa]
            .iter().all(|x|x.is_finite()) || self.initial_density<=0.
            || self.maximum_stem<=self.minimum_stem || self.maximum_density_departure<=0.
            || upper.density<=0. || upper.viscosity<=0. || upper.pressure_pa<=0.
            || upper.saturation_pressure_pa<=0. || pose<self.minimum_stem || pose>self.maximum_stem
            || (upper.density/self.initial_density-1.).abs()>self.maximum_density_departure
            || stem.passages.len()!=6 || stage.len()!=stem.passages.len() || roughness<0.
        {return Err("Release hydraulics outside selected cold geometry/material domain".into());}
        let passages=&stem.passages;
        let shaft=PI*stem.radius_m.powi(2);
        let shoulder=self.shoulder;let h=shoulder.top_m-shoulder.bottom_m;
        let outer=PI*passages[5].outer_radius_m.powi(2);
        let enlarged=PI*shoulder.radius_m.powi(2);let shoulder_annulus=outer-enlarged;
        if !shaft.is_finite() || shaft<=0. || stem.bottom_m+self.maximum_stem>=passages[0].bottom_m
            || stem.top_m+self.minimum_stem<=passages[5].bottom_m
            || stem.top_m+self.maximum_stem>=passages[5].top_m
            || shoulder.top_m!=stem.top_m || h<=0. || shoulder.radius_m<stem.radius_m
            || shoulder_annulus<=0. || shoulder.bottom_m+self.minimum_stem<passages[5].bottom_m
        {return Err("Release stem does not occupy the complete selected serial circuit".into());}
        let areas:[f64;6]=std::array::from_fn(|i|PI*passages[i].outer_radius_m.powi(2)-shaft);
        for (i,p) in passages.iter().enumerate() {
            let s=stage[i];
            if !areas[i].is_finite() || areas[i]<=0. || ![s.length_m,s.length_pose_partial,s.loss_pa,s.force_n]
                .iter().chain(&s.loss_partials).chain(&s.force_partials).all(|x|x.is_finite()) || s.length_m<=0.
                || (i>0&&passages[i-1].top_m!=p.bottom_m)
                || (i<5&&(s.length_pose_partial!=0.||s.length_m!=p.top_m-p.bottom_m))
                || (i==5&&s.length_pose_partial!=1.)
            {return Err("Release hydraulic passage differs from the current force stage".into());}
        }
        let v=D::variable(speed,1);let rho=D::variable(upper.density,2);let q=v.scale(-shaft);
        let pressure=D::variable(upper.pressure_pa,4);let pvap=D::variable(upper.saturation_pressure_pa,5);
        let (mass_value,my)=self.mass_from_stem(stem,pose)?;
        let mut mass=D::constant(mass_value);mass.p[0]=my;
        let inertance=mass.scale(1./(shaft*shaft));let iy=my/(shaft*shaft);
        let mut distributed=[D::constant(0.);6];
        for (i,s) in stage.iter().enumerate() {
            let mut loss=D::constant(s.loss_pa);
            loss.p[0]=s.loss_partials[3];loss.p[1]=s.loss_partials[2];
            loss.p[2]=s.loss_partials[0];loss.p[3]=s.loss_partials[1];
            distributed[i]=loss;
        }
        // The exact native law already consumed the slender span. Replace
        // only its terminal h metres; all remaining distributed preparation
        // continues to be owned by the current force stage.
        let actual=on::moving_hydraulic::closed_stem(moving_guide::Geometry{
            outer_radius_m:passages[5].outer_radius_m,inner_radius_m:shoulder.radius_m,length_m:h,multiplicity:1},
            speed,roughness,upper.density,upper.viscosity)?;
        let prepared=|value:f64,p:[f64;4]|D{v:value,p:[0.,p[2],p[0],p[1],0.,0.]};
        let final_stage=stage[5];let fraction=h/final_stage.length_m;
        // Native distributed force/loss are exactly linear in occupied L.
        // h is constant, so its pose partial is exactly zero; do not recover
        // that cancellation by subtracting quotient derivatives.
        let old_loss=prepared(final_stage.loss_pa,final_stage.loss_partials).scale(fraction);
        let actual_loss=if shoulder.radius_m==stem.radius_m {old_loss}
            else {prepared(actual.loss_pa,actual.loss_partials)};
        distributed[5]=distributed[5].sub(old_loss);
        let shoulder_force=if shoulder.radius_m==stem.radius_m {D::constant(0.)}
            else {prepared(actual.force_n,actual.force_partials)
                .sub(prepared(final_stage.force_n,final_stage.force_partials).scale(fraction))};
        let shoulder_work=shoulder_force.mul(v).scale(-1.);
        let kinetic=mass.mul(v.mul(v)).scale(0.5);let geometry_force=v.mul(v).scale(-0.5*my);
        let form:[D;5]=std::array::from_fn(|i| {
            let low=areas[i].min(areas[i+1]);let high=areas[i].max(areas[i+1]);let r=low/high;
            let contraction=if q.v>=0. {areas[i+1]<areas[i]} else {areas[i]<areas[i+1]};
            let k=if contraction {0.5*(1.-r).powf(0.75)} else {(1.-r).powi(2)};
            let mut qa=q.mul(q);qa=qa.scale(q.v.signum());
            // q|q| has exact derivative zero at reversal; K's selected side
            // cannot introduce a floor, smoothing or spurious zero-flow loss.
            qa.mul(rho).scale(k/(2.*low*low))
        });
        // Moving base/nose: in the body's frame the same relative volume
        // current R=-Afull*v passes both transitions. Reusing the selected
        // sudden-change surrogate there is an authored moving-step reduction,
        // not empirical validation of an unsteady shoulder.
        let relative=v.scale(-outer);
        let moving_loss=|low_area:f64,upper_area:f64| {
            let low=low_area.min(upper_area);let high=low_area.max(upper_area);let ratio=low/high;
            let contraction=if relative.v>=0. {upper_area<low_area} else {low_area<upper_area};
            let k=if contraction {0.5*(1.-ratio).powf(0.75)} else {(1.-ratio).powi(2)};
            relative.mul(relative).scale(relative.v.signum()).mul(rho).scale(k/(2.*low*low))
        };
        let base_loss=moving_loss(areas[5],shoulder_annulus);
        let nose_loss=moving_loss(shoulder_annulus,outer);
        let form_total=form.iter().fold(D::constant(0.),|a,b|a.add(*b));
        let moving_total=base_loss.add(nose_loss);
        let form_force=form_total.scale(shaft).add(moving_total.scale(outer));
        let form_work=form_total.mul(q).add(moving_total.mul(relative));
        // Between these endpoints the selected pressure is affine in z:
        // constant annular speed and distributed gradient, plus hydrostatics
        // and plug acceleration. Both sides of each physical jump and the
        // moving tip/cap therefore cover every possible serial minimum.
        let mut pressures=[Pressure::default();17];
        let mut next=0;
        let mut push=|out:&mut [Pressure;17],location,z:D,velocity:D,loss:D,coefficient:D,recovery:D| {
            let base=pressure.add(rho.mul(D::constant(upper.datum_m).sub(z)).scale(GRAVITY))
                .sub(loss).sub(velocity.mul(velocity).scale(0.5*self.initial_density)).add(recovery).sub(pvap);
            out[next]=Pressure{location,elevation_m:z.v,base_margin_pa:base.v,
                acceleration_coefficient:coefficient.v,base,coefficient};
            next+=1;
        };
        push(&mut pressures,Location::InletPlenum,D::constant(passages[0].bottom_m),D::constant(0.),D::constant(0.),D::constant(0.),D::constant(0.));
        push(&mut pressures,Location::InletAnnulus,D::constant(passages[0].bottom_m),q.scale(1./areas[0]),D::constant(0.),D::constant(0.),D::constant(0.));
        let (mut loss,mut iprefix)=(D::constant(0.),D::constant(0.));
        for i in 0..6 {
            loss=loss.add(distributed[i]);
            let mut length=D::constant(stage[i].length_m-if i==5 {h} else {0.});length.p[0]=stage[i].length_pose_partial;
            iprefix=iprefix.add(length.scale(self.initial_density*shaft/areas[i]));
            if i<5 {
                let z=D::constant(passages[i].top_m);
                push(&mut pressures,Location::InterfaceLower(i),z,q.scale(1./areas[i]),loss,iprefix,D::constant(0.));
                loss=loss.add(form[i]);
                push(&mut pressures,Location::InterfaceUpper(i),z,q.scale(1./areas[i+1]),loss,iprefix,D::constant(0.));
            }
        }
        let base_z=D::variable(shoulder.bottom_m+pose,0);let tip_z=D::variable(shoulder.top_m+pose,0);
        let shaft_velocity=q.scale(1./areas[5]);let shoulder_velocity=v.scale(-enlarged/shoulder_annulus);
        push(&mut pressures,Location::ShoulderBelow,base_z,shaft_velocity,loss,iprefix,D::constant(0.));
        // Relative Bernoulli: p+rho*(u-v)^2/2 is continuous apart from
        // the signed localized loss. Lab kinetic head is already separate.
        let base_recovery=v.mul(shoulder_velocity.sub(shaft_velocity)).scale(self.initial_density);
        loss=loss.add(base_loss);
        push(&mut pressures,Location::ShoulderAbove,base_z,shoulder_velocity,loss,iprefix,base_recovery);
        loss=loss.add(actual_loss);iprefix=iprefix.add(D::constant(self.initial_density*enlarged*h/shoulder_annulus));
        push(&mut pressures,Location::TipBelow,tip_z,shoulder_velocity,loss,iprefix,base_recovery);
        loss=loss.add(nose_loss);
        let tip_recovery=base_recovery.sub(v.mul(shoulder_velocity).scale(self.initial_density));
        push(&mut pressures,Location::TipAbove,tip_z,D::constant(0.),loss,iprefix,tip_recovery);
        push(&mut pressures,Location::ClosedCap,D::constant(passages[5].top_m),D::constant(0.),loss,iprefix,tip_recovery);
        if pressures.iter().any(|p|!p.base_margin_pa.is_finite()||!p.acceleration_coefficient.is_finite()
            ||p.base.p.iter().chain(&p.coefficient.p).any(|x|!x.is_finite()))
            || ![mass.v,kinetic.v,geometry_force.v,form_force.v,form_work.v].iter().all(|x|x.is_finite())
            || form_work.v<0.
        {return Err("Invalid release pressure/work preparation".into());}
        Ok(Prepared{added_mass_kg:mass.v,added_mass_pose_partial:my,kinetic_j:kinetic.v,
            geometry_force_n:geometry_force.v,form_force_n:form_force.v,form_fluid_work_w:form_work.v,
            shoulder_force_correction_n:shoulder_force.v,shoulder_fluid_work_correction_w:shoulder_work.v,
            density_ratio:upper.density/self.initial_density,pressures,mass,kinetic,geometry_force,
            form_force,form_work,inertance,inertance_pose_partial:iy,shaft_area:shaft,q,speed:v,
            shoulder_force,shoulder_work})
    }
}

//! Current operating-network traction on the separate finite body and stem.
//! This layer owns no water, mechanical history, heat store or clock. Its
//! closed-cap shaft passages use the selected cold local incompressible
//! redistribution reduction inside the existing compressible UPPER owner.
use crate::{absorber_motion as am, control_source_geometry as cg, moving_guide,
    operating_network as on, GRAVITY};
use on::moving_hydraulic::{self as mh, Law, StemResponse};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub cluster: usize,
    pub cell: usize,
    pub lower_edge: usize,
    pub upper_edge: usize,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StemPassage {
    pub bottom_m: f64,
    pub top_m: f64,
    pub outer_radius_m: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Stem {
    pub radius_m: f64,
    pub bottom_m: f64,
    pub top_m: f64,
    /// Disjoint actual housing, cap bore, collar bores and neck spans.
    /// Slender-shaft drag excludes stub/lug/shoulder form drag; their full
    /// displaced volumes still enter the shared geometry and buoyancy.
    pub passages: Vec<StemPassage>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub lower: usize,
    pub upper: usize,
    pub bottom: f64,
    pub top: f64,
    pub guide_radius: f64,
    pub body_radius: f64,
    pub rodlets: u32,
    pub roughness: f64,
    pub mouth: f64,
    pub bindings: Vec<Binding>,
    /// Immutable cluster order, independent of hydraulic binding order.
    pub stems: Vec<Stem>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct StemPassageStage {
    pub length_m: f64,
    pub length_pose_partial: f64,
    pub loss_pa: f64,
    /// Current density, viscosity, actual STEM speed and actual STEM pose.
    pub loss_partials: [f64; mh::STEM_PARTIALS],
    /// Same already evaluated native response, retained for exact short-span
    /// replacement by the selected actual terminal shoulder.
    pub force_n: f64,
    pub force_partials: [f64; mh::STEM_PARTIALS],
}
pub struct Workspace {
    pub forces: Vec<am::Forces>,
    /// The sole neck excess-pressure/shear energy credit into UPPER.
    pub stem_fluid_work_w: f64,
    /// Independent positive constitutive identity; do not add as more heat.
    pub stem_dissipation_w: f64,
    stem: Vec<StemResponse>,
    stem_passages: Vec<Vec<StemPassageStage>>,
    plan: Plan,
    poses: Vec<cg::Pose>,
    velocity: Vec<cg::Direction>,
    network_state: Vec<f64>,
    network_owner: Option<Arc<()>>,
    binding_by_cluster: Vec<usize>,
    valid: bool,
}
impl Workspace {
    pub fn new(plan: &Plan) -> Self {
        let mut binding_by_cluster=vec![usize::MAX;plan.bindings.len()];
        for (i,b) in plan.bindings.iter().enumerate() {
            if let Some(slot)=binding_by_cluster.get_mut(b.cluster) { *slot=i; }
        }
        Self {
            forces: vec![am::Forces { body_n: 0., stem_n: 0. }; plan.bindings.len()],
            stem_fluid_work_w: 0., stem_dissipation_w: 0.,
            stem: vec![StemResponse::default(); plan.stems.len()],
            stem_passages: plan.stems.iter().map(|s| vec![StemPassageStage::default();s.passages.len()]).collect(),
            plan: plan.clone(), poses: vec![], velocity: vec![], network_state: vec![],
            network_owner: None, binding_by_cluster, valid: false,
        }
    }
    /// The release pressure/inertance helper consumes the actual force owner's
    /// prepared overlaps and distributed losses; it owns no parallel topology
    /// or repeated annular constitutive preparation.
    pub fn stem_passage_stage(&self, plan:&Plan, cluster:usize, pose:cg::Pose,
        speed:f64) -> Result<&[StemPassageStage],String>
    {
        let old=self.poses.get(cluster).ok_or("Absent current stem force stage")?;
        if !self.valid || self.plan!=*plan || old.stem.to_bits()!=pose.stem.to_bits()
            || old.stem_right!=pose.stem_right
            || self.velocity[cluster].stem.to_bits()!=speed.to_bits()
        { return Err("Release hydraulics requires the exact current stem force stage".into()); }
        Ok(&self.stem_passages[cluster])
    }
    pub fn check_current_network_state(&self,plan:&Plan,n:&on::Network,y:&[f64])->Result<(),String> {
        if !self.valid || self.plan!=*plan
            || !self.network_owner.as_ref().is_some_and(|owner|Arc::ptr_eq(owner,n.owner_token()))
            || y.len()!=self.network_state.len()
            || y.iter().zip(&self.network_state).any(|(a,b)|a.to_bits()!=b.to_bits())
        {return Err("Release hydraulics requires the exact current force/network stage".into());}
        Ok(())
    }
}
fn finite_direction(d: &[cg::Direction], n: usize) -> bool {
    d.len() == n && d.iter().all(|q| q.body.is_finite() && q.stem.is_finite())
}
/// An exact owned force linearization with its common network/property
/// direction checked once. Both the complete JVP and held-fluid component P
/// contract the same one-cluster action; this retains no independent stage.
pub struct DirectionStage<'a> {
    plan: &'a Plan,
    network: &'a on::Network,
    network_work: &'a on::Workspace,
    geometry: &'a cg::Workspace,
    state_direction: &'a [f64],
    work: &'a Workspace,
    dp: f64,
    upper_density_direction: f64,
    upper_viscosity_direction: f64,
}
impl DirectionStage<'_> {
    fn density(&self,node:usize) -> f64 {
        let l=self.network_work.liquids[node];
        l.density*(l.compressibility*self.dp
            -l.expansion*self.state_direction[self.network.temperature_row(node)])
    }
    fn binding(&self,b:&Binding,dy:cg::Direction,dvelocity:cg::Direction)
        -> Result<(am::Forces,f64),String>
    {
        let n=self.network;let nw=self.network_work;
        let p=self.geometry.water_partials[b.cluster];
        let du=self.upper_density_direction;let lu=nw.liquids[self.plan.upper];
        let dg=self.density(b.cell);
        let dhead=|node:usize|n.relative_pressure(node,self.state_direction)
            +self.density(node)*GRAVITY*n.config().water[node].geometry.elevation;
        let g=on::MovingConnectionDirection {from_elevation_m:dy.body,to_elevation_m:0.,
            length_m:-dy.body,speed_m_s:dvelocity.body};
        let response_index=nw.moving_response_index(b.upper_edge)?.ok_or("Absent current guide response")?;
        let wall=nw.moving_response_direction(n,response_index,self.state_direction,g)?.wall_force_n;
        let sd=[du,self.upper_viscosity_direction,dvelocity.stem,dy.stem];
        let dot=|p:[f64;mh::STEM_PARTIALS]|p.into_iter().zip(sd).map(|(x,y)|x*y).sum::<f64>();
        let sr=self.work.stem[b.cluster];
        let force=am::Forces {
            body_n:p.guide_body.volume*(dhead(b.cell)-dhead(self.plan.upper))
                -GRAVITY*(dg*p.guide_body.moment+nw.liquids[b.cell].density*p.guide_body.moment_second*dy.body
                    +du*p.upper_body.moment+lu.density*p.upper_body.moment_second*dy.body)+wall,
            stem_n:-GRAVITY*(du*p.upper_stem.moment+lu.density*p.upper_stem.moment_second*dy.stem)
                +dot(sr.force_partials),
        };
        let work=dot(sr.fluid_work_partials);
        if !work.is_finite() || !force.body_n.is_finite() || !force.stem_n.is_finite() {
            return Err("Nonfinite current control fluid-force direction".into());
        }
        Ok((force,work))
    }
    /// One actual cluster, independent of the physical binding-array order.
    /// Other clusters' mechanical directions are exactly zero in the held-fluid
    /// component P and need not be evaluated to obtain this local action.
    pub fn cluster(&self,cluster:usize,pose:cg::Direction,velocity:cg::Direction)
        -> Result<(am::Forces,f64),String>
    {
        if ![pose.body,pose.stem,velocity.body,velocity.stem].iter().all(|x|x.is_finite()) {
            return Err("Control fluid-force direction requires its exact value stage".into());
        }
        let index=*self.work.binding_by_cluster.get(cluster).ok_or("Absent current force cluster")?;
        let binding=self.plan.bindings.get(index).ok_or("Absent current force binding")?;
        self.binding(binding,pose,velocity)
    }
}
impl Plan {
    fn check_shape_stage(&self,nw:&on::Workspace,geometry:&cg::Workspace,
        velocity:&[cg::Direction]) -> Result<(),String>
    {
        if nw.water_shapes.len()!=geometry.value.water.len() {
            return Err("Current force/network water support mismatch".into());
        }
        for (a,b) in nw.water_shapes.iter().zip(&geometry.value.water) {
            if a.volume_m3.to_bits()!=b.volume.to_bits() || a.first_moment_m4.to_bits()!=b.moment.to_bits() {
                return Err("Control force requires the current network water geometry".into());
            }
        }
        let (mut upper_v,mut upper_j)=(0.,0.);
        for (k,p) in geometry.water_partials.iter().enumerate() {
            upper_v+=p.upper_body.volume*velocity[k].body;
            upper_v+=p.upper_stem.volume*velocity[k].stem;
            upper_j+=p.upper_body.moment*velocity[k].body;
            upper_j+=p.upper_stem.moment*velocity[k].stem;
        }
        for b in &self.bindings {
            let p=geometry.water_partials[b.cluster].guide_body;
            let shape=nw.water_shapes[b.cell];
            if shape.volume_rate_m3_s!=p.volume*velocity[b.cluster].body
                || shape.first_moment_rate_m4_s!=p.moment*velocity[b.cluster].body
            { return Err("Control force requires actual guide shape rates".into()); }
        }
        let shape=nw.water_shapes[self.upper];
        // Signed zero represents the same exact zero contraction.
        if shape.volume_rate_m3_s!=upper_v || shape.first_moment_rate_m4_s!=upper_j {
            return Err("Control force requires actual body/stem UPPER shape rates".into());
        }
        Ok(())
    }
    pub fn check(&self, n: &on::Network, clusters: usize) -> Result<(), String> {
        let nw = n.config().water.len();
        if self.bindings.len() != clusters || self.stems.len() != clusters
            || self.lower >= nw || self.upper >= nw || self.lower == self.upper
            || ![self.bottom,self.top,self.guide_radius,self.body_radius,self.roughness,self.mouth]
                .iter().all(|x| x.is_finite()) || self.top <= self.bottom || self.body_radius <= 0.
            || self.guide_radius <= self.body_radius || self.rodlets == 0
            || self.roughness < 0. || self.mouth < 0.
        { return Err("Invalid current control hydraulic plan".into()); }
        let mut cells = std::collections::BTreeSet::new();
        let mut edges = cells.clone();
        let mut ids = cells.clone();
        for b in &self.bindings {
            if b.cluster >= clusters || b.cell >= nw || b.cell == self.lower || b.cell == self.upper
                || b.lower_edge >= n.config().hydraulic.len() || b.upper_edge >= n.config().hydraulic.len()
                || !ids.insert(b.cluster) || !cells.insert(b.cell)
                || !edges.insert(b.lower_edge) || !edges.insert(b.upper_edge)
            { return Err("Repeated/out-of-range actual guide binding".into()); }
            let a = &n.config().hydraulic[b.lower_edge];
            let z = &n.config().hydraulic[b.upper_edge];
            if a.from != self.lower || a.to != b.cell || z.from != b.cell || z.to != self.upper {
                return Err("Current guide binding differs from the physical network".into());
            }
        }
        for s in &self.stems {
            if ![s.radius_m,s.bottom_m,s.top_m].iter().all(|x| x.is_finite())
                || s.radius_m <= 0. || s.top_m <= s.bottom_m || s.passages.is_empty()
            { return Err("Invalid actual slender-stem support".into()); }
            let mut end = f64::NEG_INFINITY;
            for p in &s.passages {
                if ![p.bottom_m,p.top_m,p.outer_radius_m].iter().all(|x| x.is_finite())
                    || p.top_m <= p.bottom_m || p.bottom_m < end || p.outer_radius_m <= s.radius_m
                { return Err("Invalid/overlapping physical stem passage".into()); }
                end = p.top_m;
            }
            if s.top_m > end { return Err("Original stem exceeds the closed enclosure".into()); }
        }
        Ok(())
    }
    pub fn connections_into(&self, poses: &[cg::Pose], velocity: &[cg::Direction],
        out: &mut Vec<on::MovingConnection>) -> Result<(), String>
    {
        let nc = self.bindings.len();
        if poses.len() != nc || !finite_direction(velocity,nc) {
            return Err("Current hydraulic pose/rate coverage".into());
        }
        out.clear();
        for b in &self.bindings {
            let y = poses[b.cluster].body;
            if !y.is_finite() || y < 0. || y >= self.top-self.bottom {
                return Err("Outside current occupied-guide support".into());
            }
            let tip = self.bottom+y;
            out.extend([
                on::MovingConnection { edge: b.lower_edge, from_elevation_m:self.bottom,
                    to_elevation_m:tip, fluid_work_cell:b.cell,
                    law:Law::Clear { outer_radius_m:self.guide_radius,length_m:y,
                        multiplicity:self.rodlets,roughness_m:self.roughness,mouth_loss:self.mouth } },
                on::MovingConnection { edge:b.upper_edge,from_elevation_m:tip,
                    to_elevation_m:self.top,fluid_work_cell:b.cell,
                    law:Law::Annulus { geometry:moving_guide::Geometry {
                        outer_radius_m:self.guide_radius,inner_radius_m:self.body_radius,
                        length_m:self.top-self.bottom-y,multiplicity:self.rodlets },
                        speed_m_s:velocity[b.cluster].body,roughness_m:self.roughness,mouth_loss:self.mouth } },
            ]);
        }
        Ok(())
    }
    pub fn directions_into(&self, pose: &[cg::Direction], velocity: &[cg::Direction],
        out: &mut Vec<on::MovingConnectionDirection>) -> Result<(), String>
    {
        if !finite_direction(pose,self.bindings.len()) || !finite_direction(velocity,self.bindings.len()) {
            return Err("Current hydraulic direction coverage".into());
        }
        out.clear();
        for b in &self.bindings {
            let y = pose[b.cluster].body;
            out.extend([
                on::MovingConnectionDirection { from_elevation_m:0.,to_elevation_m:y,length_m:y,speed_m_s:0. },
                on::MovingConnectionDirection { from_elevation_m:y,to_elevation_m:0.,length_m:-y,
                    speed_m_s:velocity[b.cluster].body },
            ]);
        }
        Ok(())
    }
    pub fn evaluate(&self, n:&on::Network, y:&[f64], nw:&on::Workspace, geometry:&cg::Workspace,
        poses:&[cg::Pose], velocity:&[cg::Direction], out:&mut Workspace) -> Result<(),String>
    {
        out.valid=false;
        out.network_owner=None;
        self.check(n,self.bindings.len())?;
        nw.check_current_chart(n,y)?;
        geometry.check_current_poses(poses).map_err(String::from)?;
        if out.plan != *self || !finite_direction(velocity,self.bindings.len())
            || geometry.water_partials.len()!=self.bindings.len()
            || out.forces.len()!=self.bindings.len() || out.stem.len()!=self.stems.len()
        { return Err("Current control-force support/owner mismatch".into()); }
        self.check_shape_stage(nw,geometry,velocity)?;
        let responses=nw.moving_responses()?;
        if responses.len()!=2*self.bindings.len() { return Err("Current guide response coverage".into()); }
        out.stem_fluid_work_w=0.;
        out.stem_dissipation_w=0.;
        let upper=self.upper;
        let lu=nw.liquids[upper];
        let phead=|node:usize| n.pressure_offset(node)+n.relative_pressure(node,y)
            +nw.liquids[node].density*GRAVITY*n.config().water[node].geometry.elevation;
        for b in &self.bindings {
            let p=geometry.water_partials[b.cluster];
            if p.guide_body.volume+p.upper_body.volume!=0. || p.upper_stem.volume!=0. {
                return Err("Control displacement lacks a closed pressure-work incidence".into());
            }
            let c=nw.moving_connection(b.upper_edge)?.ok_or("Absent current guide annulus")?;
            let response_index=nw.moving_response_index(b.upper_edge)?.ok_or("Absent current guide response")?;
            if c.edge!=b.upper_edge || c.fluid_work_cell!=b.cell
                || c.from_elevation_m.to_bits()!=(self.bottom+poses[b.cluster].body).to_bits()
                || c.to_elevation_m.to_bits()!=self.top.to_bits()
            { return Err("Stale current guide hydraulic geometry".into()); }
            match c.law {
                Law::Annulus{geometry:g,speed_m_s:v,..} if
                    g.length_m.to_bits()==(self.top-self.bottom-poses[b.cluster].body).to_bits()
                    && v.to_bits()==velocity[b.cluster].body.to_bits() => (),
                _=>return Err("Current guide force must consume the actual moving annulus".into()),
            }
            let stem=&self.stems[b.cluster];
            let pose=poses[b.cluster];
            if stem.top_m+pose.stem>stem.passages.last().unwrap().top_m {
                return Err("Current stem crosses its closed enclosure".into());
            }
            let v=velocity[b.cluster].stem;
            let mut sr=StemResponse::default();
            for (pi,passage) in stem.passages.iter().enumerate() {
                let shape=cg::overlap(stem.bottom_m,stem.top_m,passage.bottom_m,passage.top_m,
                    pose.stem,pose.stem_right);
                let a=mh::closed_stem(moving_guide::Geometry { outer_radius_m:passage.outer_radius_m,
                    inner_radius_m:stem.radius_m,length_m:shape[0],multiplicity:1 },v,self.roughness,
                    lu.density,lu.viscosity)?;
                let mut loss_partials=a.loss_partials;
                loss_partials[3]*=shape[1];
                let mut force_partials=a.force_partials;
                force_partials[3]*=shape[1];
                out.stem_passages[b.cluster][pi]=StemPassageStage {length_m:shape[0],
                    length_pose_partial:shape[1],loss_pa:a.loss_pa,loss_partials,
                    force_n:a.force_n,force_partials};
                sr.force_n+=a.force_n;
                sr.fluid_work_w+=a.fluid_work_w;
                sr.dissipation_w+=a.dissipation_w;
                for j in 0..mh::STEM_PARTIALS {
                    let scale=if j==3 {shape[1]} else {1.};
                    sr.force_partials[j]+=a.force_partials[j]*scale;
                    sr.fluid_work_partials[j]+=a.fluid_work_partials[j]*scale;
                    sr.dissipation_partials[j]+=a.dissipation_partials[j]*scale;
                }
            }
            out.stem[b.cluster]=sr;
            out.forces[b.cluster]=am::Forces {
                body_n:p.guide_body.volume*(phead(b.cell)-phead(upper))
                    -GRAVITY*(nw.liquids[b.cell].density*p.guide_body.moment+lu.density*p.upper_body.moment)
                    +responses[response_index].wall_force_n,
                stem_n:-GRAVITY*lu.density*p.upper_stem.moment+sr.force_n,
            };
            out.stem_fluid_work_w+=sr.fluid_work_w;
            out.stem_dissipation_w+=sr.dissipation_w;
        }
        if out.forces.iter().any(|f| !f.body_n.is_finite()||!f.stem_n.is_finite())
            || !out.stem_fluid_work_w.is_finite() || !out.stem_dissipation_w.is_finite()
        { return Err("Nonfinite current control fluid force/work".into()); }
        out.poses.clear();out.poses.extend_from_slice(poses);
        out.velocity.clear();out.velocity.extend_from_slice(velocity);
        out.network_state.clear();out.network_state.extend_from_slice(y);
        out.network_owner=Some(n.owner_token().clone());
        out.valid=true;
        Ok(())
    }
    /// Validate the complete owned value stage and common network direction
    /// once before any local pose/rate contractions. No EOS or law is repeated.
    pub fn direction_stage<'a>(&'a self,n:&'a on::Network,y:&[f64],nw:&'a on::Workspace,
        geometry:&'a cg::Workspace,dstate:&'a [f64],w:&'a Workspace)
        -> Result<DirectionStage<'a>,String>
    {
        w.check_current_network_state(self,n,y)?;
        nw.check_current_chart(n,y)?;
        geometry.check_current_poses(&w.poses).map_err(String::from)?;
        if !w.valid || w.plan!=*self || dstate.len()!=n.dimension()
            || dstate.iter().any(|x|!x.is_finite())
        { return Err("Control fluid-force direction requires its exact value stage".into()); }
        self.check_shape_stage(nw,geometry,&w.velocity)?;
        let dp=dstate[n.pressure_row()];
        let density=|node:usize| {let l=nw.liquids[node];
            l.density*(l.compressibility*dp-l.expansion*dstate[n.temperature_row(node)])};
        let du=density(self.upper);
        let dmu=nw.film_property_direction(self.upper,dp,dstate[n.temperature_row(self.upper)])[0];
        Ok(DirectionStage {plan:self,network:n,network_work:nw,geometry,state_direction:dstate,
            work:w,dp,upper_density_direction:du,upper_viscosity_direction:dmu})
    }
    /// Complete current state and pose/rate chain. Returns the UPPER neck-work
    /// direction from the same canonical actions as the local component P.
    pub fn direction(&self,n:&on::Network,y:&[f64],nw:&on::Workspace,geometry:&cg::Workspace,
        dstate:&[f64],dpose:&[cg::Direction],dvelocity:&[cg::Direction],w:&Workspace,
        out:&mut Vec<am::Forces>) -> Result<f64,String>
    {
        let stage=self.direction_stage(n,y,nw,geometry,dstate,w)?;
        if !finite_direction(dpose,self.bindings.len()) || !finite_direction(dvelocity,self.bindings.len()) {
            return Err("Control fluid-force direction requires its exact value stage".into());
        }
        out.resize(self.bindings.len(),am::Forces {body_n:0.,stem_n:0.});
        let mut work=0.;
        for b in &self.bindings {
            let (force,local_work)=stage.binding(b,dpose[b.cluster],dvelocity[b.cluster])?;
            out[b.cluster]=force;
            work+=local_work;
        }
        if !work.is_finite() || out.iter().any(|f|!f.body_n.is_finite()||!f.stem_n.is_finite()) {
            return Err("Nonfinite current control fluid-force direction".into());
        }
        Ok(work)
    }
}

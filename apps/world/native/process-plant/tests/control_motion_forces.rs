use leitbild_plant_numerics::{control_motion_forces as cf, control_source_geometry as cg,
    operating_network as on, source_evolution as se, CellGeometry};
use std::f64::consts::PI;

pub fn fixture() -> (on::Network,cg::Prepared,cf::Plan) {
    let (ro,ri)=(0.0055,0.00475);
    let (outer,body)=(PI*ro*ro,PI*ri*ri);
    let water=vec![cg::Water{volume:1.,moment:-1.},
        cg::Water{volume:(outer-body)*2.,moment:(outer-body)*2.},cg::Water{volume:2.,moment:6.}];
    let geometry=cg::Prepared::new(cg::Input {
        clusters:1,maximum_body:0.5,minimum_stem:0.,maximum_stem:0.5,bottom:0.,top:2.,
        active_bottom:0.3,active_length:1.,active_top:1.3,head:4.,housing_top:6.,neck_top:8.,
        rodlets:1.,guide_radius:ro,body_radius:ri,guide_area:outer,body_area:body,
        water:water.clone(),upper:2,guides:vec![1],passive:vec![],cylinders:vec![],
        intruders:vec![cg::Intruder{cluster:0,motion:cg::Motion::Body,lo:2.1,hi:2.3,area:0.00001},
            cg::Intruder{cluster:0,motion:cg::Motion::Stem,lo:3.7,hi:4.3,area:PI*0.006f64.powi(2)}],
        patches:vec![],row_water:vec![],routes:vec![],origins:vec![],contacts:vec![],barrel_paths:vec![],
    },&se::Geometry{passive_volumes:vec![],cylinder_shares:vec![],moderator_volumes:vec![],
        external_water_volumes:water.iter().map(|w|w.volume).collect()}).unwrap();
    let network=on::Network::new(on::Config {
        water:water.iter().enumerate().map(|(i,w)|on::Water {
            geometry:CellGeometry{volume:w.volume,elevation:w.moment/w.volume},
            initial_pressure:300000.+[0.,30.,-40.][i],initial_temperature:300.+i as f64,
            initial_tracer_fraction:0.001,
        }).collect(),solids:vec![],heat:vec![],secondaries:vec![],secondary_heat:vec![],seat:None,prhr:None,
        hydraulic:vec![(0,1),(1,2)].into_iter().map(|(from,to)|on::Hydraulic {
            from,to,from_elevation:0.,to_elevation:2.,segments:vec![on::HydraulicSegment {
                law:on::LossLaw::ChurchillPipe,length:2.,flow_area:outer-body,diameter:2.*(ro-ri),
                roughness:2e-6,fixed_loss:0.5,grid_multiplier:0.,
            }],
        }).collect(),
    }).unwrap();
    let plan=cf::Plan { lower:0,upper:2,bottom:0.,top:2.,guide_radius:ro,body_radius:ri,rodlets:1,
        roughness:2e-6,mouth:0.5,bindings:vec![cf::Binding{cluster:0,cell:1,lower_edge:0,upper_edge:1}],
        stems:vec![cf::Stem{radius_m:0.006,bottom_m:3.7,top_m:4.3,passages:vec![
            cf::StemPassage{bottom_m:3.,top_m:4.1,outer_radius_m:0.125},
            cf::StemPassage{bottom_m:4.1,top_m:4.2,outer_radius_m:0.00625},
            cf::StemPassage{bottom_m:4.2,top_m:8.,outer_radius_m:0.025},
        ]}],
    };
    plan.check(&network,1).unwrap();
    (network,geometry,plan)
}
pub fn stage(n:&on::Network,g:&cg::Prepared,p:&cf::Plan,y:&[f64],pose:cg::Pose,velocity:cg::Direction,
    reverse_connections:bool) -> (on::Workspace,cg::Workspace,cf::Workspace)
{
    let zero=cg::Direction::default();
    let mut gw=g.workspace();
    g.evaluate_into(&[pose],&[zero],&mut gw).unwrap();
    g.water_rates_into(&[velocity],&[zero],&mut gw).unwrap();
    let water:Vec<_>=gw.value.water.iter().zip(&gw.water_rates).map(|(v,r)|on::WaterShape {
        volume_m3:v.volume,first_moment_m4:v.moment,volume_rate_m3_s:r.volume,first_moment_rate_m4_s:r.moment,
    }).collect();
    let mut c=vec![];p.connections_into(&[pose],&[velocity],&mut c).unwrap();
    if reverse_connections { c.reverse(); }
    let mut nw=on::Workspace::new(n);
    nw.evaluate_with_motion(n,y,&vec![0.;n.dimension()],Some(1.),&[],None,
        Some(on::MotionGeometry{water:&water,connections:&c})).unwrap();
    let mut fw=cf::Workspace::new(p);
    p.evaluate(n,y,&nw,&gw,&[pose],&[velocity],&mut fw).unwrap();
    (nw,gw,fw)
}
fn pose() -> cg::Pose {cg::Pose{body:0.05,stem:0.07,body_right:true,stem_right:true,seated:false}}
fn velocity() -> cg::Direction {cg::Direction{body:0.008,stem:-0.006}}
#[test]
fn real_network_work_and_separate_stem_drag_have_reciprocal_forces() {
    let (n,g,p)=fixture();
    let mut y=n.initial_state().unwrap();
    y[n.flow_row(0)]=0.0003;y[n.flow_row(1)]=-0.0002;
    y[n.mechanical_row(1).unwrap()]=20.;y[n.mechanical_row(2).unwrap()]=-10.;
    let v=velocity();
    for reverse in [false,true] {
        let (nw,_,fw)=stage(&n,&g,&p,&y,pose(),v,reverse);
        let fluid=nw.shape_pressure_work_w.iter().sum::<f64>()
            +nw.moving_responses().unwrap().iter().map(|r|r.fluid_wall_work_w).sum::<f64>()
            +fw.stem_fluid_work_w;
        let mechanical=fw.forces[0].body_n*v.body+fw.forces[0].stem_n*v.stem;
        assert!((fluid+mechanical).abs()<1e-11*(1.+fluid.abs()+mechanical.abs()));
        assert!(fw.stem_fluid_work_w>0.);
        assert!((fw.stem_fluid_work_w-fw.stem_dissipation_w).abs()<1e-13);
    }
}
#[test]
fn original_rest_has_zero_neck_work_and_admits_signed_zero_contractions() {
    let (n,g,p)=fixture();let y=n.initial_state().unwrap();
    let q=cg::Pose{body:0.,stem:0.,seated:true,..pose()};
    let (_,_,fw)=stage(&n,&g,&p,&y,q,cg::Direction::default(),false);
    assert_eq!(fw.stem_fluid_work_w,0.);
    assert_eq!(fw.stem_dissipation_w,0.);
    assert!(fw.forces[0].body_n>0.);
    assert!(fw.forces[0].stem_n>0.);
}
#[test]
fn force_jvp_includes_pressure_density_viscosity_pose_and_both_velocities() {
    let (n,g,p)=fixture();
    let mut y=n.initial_state().unwrap();
    y[n.flow_row(0)]=0.0003;y[n.flow_row(1)]=-0.0002;
    let mut dy=vec![0.;n.dimension()];
    dy[n.pressure_row()]=1000.;dy[n.flow_row(0)]=0.00001;dy[n.flow_row(1)]=-0.00003;
    for i in 0..3 {dy[n.temperature_row(i)]=0.03*(i+1) as f64;}
    dy[n.mechanical_row(1).unwrap()]=2.;dy[n.mechanical_row(2).unwrap()]=-3.;
    let dpose=cg::Direction{body:0.02,stem:-0.03};
    let dv=cg::Direction{body:0.003,stem:0.004};
    let (q,v)=(pose(),velocity());
    let (nw,gw,fw)=stage(&n,&g,&p,&y,q,v,false);
    let mut direction=vec![];
    let work=p.direction(&n,&y,&nw,&gw,&dy,&[dpose],&[dv],&fw,&mut direction).unwrap();
    let h=1e-5;
    let arms=[-1.,1.].map(|sign|{
        let yn:Vec<_>=y.iter().zip(&dy).map(|(x,d)|x+sign*h*d).collect();
        stage(&n,&g,&p,&yn,cg::Pose{body:q.body+sign*h*dpose.body,stem:q.stem+sign*h*dpose.stem,..q},
            cg::Direction{body:v.body+sign*h*dv.body,stem:v.stem+sign*h*dv.stem},false).2
    });
    for (exact,lo,hi) in [(direction[0].body_n,arms[0].forces[0].body_n,arms[1].forces[0].body_n),
        (direction[0].stem_n,arms[0].forces[0].stem_n,arms[1].forces[0].stem_n),
        (work,arms[0].stem_fluid_work_w,arms[1].stem_fluid_work_w)] {
        let fd=(hi-lo)/(2.*h);
        assert!((exact-fd).abs()<2e-6*(1.+exact.abs()),"{exact} vs {fd}");
    }
}
#[test]
fn stale_network_geometry_rates_and_force_stage_refuse() {
    let (n,g,p)=fixture();let y=n.initial_state().unwrap();
    let (mut nw,gw,mut fw)=stage(&n,&g,&p,&y,pose(),velocity(),false);
    let mut next=pose();next.stem+=1e-6;
    assert!(p.evaluate(&n,&y,&nw,&gw,&[next],&[velocity()],&mut fw).is_err());
    assert!(p.direction(&n,&y,&nw,&gw,&vec![0.;n.dimension()],&[cg::Direction::default()],
        &[cg::Direction::default()],&fw,&mut vec![]).is_err());
    nw.water_shapes[p.upper].first_moment_rate_m4_s+=1e-7;
    assert!(p.evaluate(&n,&y,&nw,&gw,&[pose()],&[velocity()],&mut fw).is_err());
}
#[test]
fn release_absolute_pressure_binds_shared_pressure_offset_and_mechanical_correction_once() {
    use leitbild_plant_numerics::control_release_hydraulics::Upper;
    let (n,g,p)=fixture();let mut y=n.initial_state().unwrap();
    y[n.mechanical_row(p.upper).unwrap()]=-37.;
    let (nw,_,fw)=stage(&n,&g,&p,&y,pose(),velocity(),false);
    let a=Upper::from_current(&n,&y,&nw,p.upper,3536.).unwrap();
    assert_eq!(a.pressure_pa,n.mechanical_pressure(p.upper,&y));
    assert_eq!(a.pressure_pa,y[n.pressure_row()]+n.pressure_offset(p.upper)-37.);
    assert_eq!(a.datum_m,n.config().water[p.upper].geometry.elevation);
    assert_eq!(a.density,nw.liquids[p.upper].density);
    assert_eq!(a.viscosity,nw.liquids[p.upper].viscosity);
    let mut next=y.clone();next[n.pressure_row()]+=1234.;
    next[n.mechanical_row(p.upper).unwrap()]+=19.;
    assert!(Upper::from_current(&n,&next,&nw,p.upper,3536.).is_err());
    assert!(fw.check_current_network_state(&p,&n,&next).is_err());
    let (next_work,_,_)=stage(&n,&g,&p,&next,pose(),velocity(),false);
    let b=Upper::from_current(&n,&next,&next_work,p.upper,3536.).unwrap();
    assert_eq!(b.pressure_pa-a.pressure_pa,1234.+19.);
}
#[test]
fn equal_config_and_state_cannot_rebind_prepared_forces_to_a_foreign_network() {
    use leitbild_plant_numerics::control_release_hydraulics::Selection;
    let (n,g,p)=fixture();let y=n.initial_state().unwrap();
    let (nw,gw,mut fw)=stage(&n,&g,&p,&y,pose(),velocity(),false);
    let foreign=on::Network::new(n.config().clone()).unwrap();
    let (foreign_work,foreign_geometry,_)=stage(&foreign,&g,&p,&y,pose(),velocity(),false);
    fw.check_current_network_state(&p,&n,&y).unwrap();
    assert!(fw.check_current_network_state(&p,&foreign,&y).is_err());
    let zero=vec![0.;y.len()];let dp=[cg::Direction::default()];let mut df=vec![];
    p.direction(&n,&y,&nw,&gw,&zero,&dp,&dp,&fw,&mut df).unwrap();
    assert!(p.direction(&foreign,&y,&foreign_work,&foreign_geometry,&zero,&dp,&dp,&fw,&mut df).is_err());
    let selection=Selection{initial_density:nw.liquids[p.upper].density,
        minimum_stem:0.,maximum_stem:0.5,maximum_density_departure:0.01};
    let error=selection.prepare_current(&p,&fw,&foreign,&y,&foreign_work,0,pose(),velocity().stem,3536.).unwrap_err();
    assert!(error.contains("exact current force/network stage"),"{error}");
    // A refused foreign preparation cannot leave the original force stage live.
    assert!(p.evaluate(&foreign,&y,&nw,&gw,&[pose()],&[velocity()],&mut fw).is_err());
    assert!(fw.check_current_network_state(&p,&n,&y).is_err());
    assert!(p.direction(&n,&y,&nw,&gw,&zero,&dp,&dp,&fw,&mut df).is_err());
    p.evaluate(&n,&y,&nw,&gw,&[pose()],&[velocity()],&mut fw).unwrap();
    fw.check_current_network_state(&p,&n,&y).unwrap();
}

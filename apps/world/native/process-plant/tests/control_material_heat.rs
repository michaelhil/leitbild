//! Small coherent operators, not an LD-01 trajectory or fabricated preparation.
use leitbild_plant_numerics::{barrel_thermal as bt, control_material_heat as cm,
    control_source_geometry as cg, moderator_source as ms, passive_source as ps,
    source_evolution as se};
#[path = "common/source_input.rs"] mod source_fixture;
#[path = "../src/passive_source.rs"] mod owning_passive;

fn fixture() -> (se::Evolution, cg::Prepared, cm::Model) {
    fixture_with_minimum(0.)
}
fn fixture_with_minimum(minimum_stem:f64) -> (se::Evolution,cg::Prepared,cm::Model) {
    let mut input = source_fixture::input();
    input.targets.extend([100.; 8]);
    for targets in [[4,5,6,7], [8,9,10,11]] {
        input.passive_stocks.push(ps::Stock { volume:0.1,scatter_m1:[0.;7],
            targets: targets.into_iter().map(|index| ps::Target{index,sigma_m2:[0.005;7]}).collect() });
    }
    input.passive_stocks[2].volume=0.102;
    input.passive_incidence.extend([
        ps::Intersection{stock:1,region:0,volume:0.1},
        ps::Intersection{stock:2,region:0,volume:0.102},
        ps::Intersection{stock:2,region:1,volume:0.},
    ]);
    input.mn.extend([7,11].map(|target| se::MnTarget {
        target,decay_rate:0.01,electron_j:2.,photon_j:3.,
    }));
    input.water_owners = (0..3).map(|index| se::WaterOwner {
        authority:se::WaterAuthority::External{index},hydrogen:100000.,
        hydrogen_product:0.,boron:1000.,boron_product:0.,
    }).collect();
    input.external_water_volumes=vec![1.,1.,2.];
    for row in &mut input.row_map { row.h_fraction=0.;row.b_fraction=0.; }
    for row in &mut input.water_rows { row.hydrogen_target=50000.;row.mobile_boron10=500.; }
    let source=se::Evolution::new(input).unwrap();
    let spans=|lo,hi| vec![cg::Span{lo,hi,area:0.1}];
    let stem_spans=||vec![cg::Span{lo:3.,hi:4.,area:0.1},cg::Span{lo:3.9,hi:4.,area:0.02}];
    let passive=vec![
        cg::Passive{original:0.1,moving:None},
        cg::Passive{original:0.1,moving:Some(cg::Moving{cluster:0,motion:cg::Motion::Body,
            lo:0.,hi:4.,spans:spans(2.,3.)})},
        cg::Passive{original:0.102,moving:Some(cg::Moving{cluster:0,motion:cg::Motion::Stem,
            lo:0.,hi:4.,spans:stem_spans()})},
        cg::Passive{original:0.,moving:Some(cg::Moving{cluster:0,motion:cg::Motion::Stem,
            lo:4.,hi:8.,spans:stem_spans()})},
    ];
    let geometry=cg::Prepared::new(cg::Input {
        clusters:1,maximum_body:0.25,minimum_stem,maximum_stem:0.5,bottom:0.,top:2.,active_bottom:0.3,
        active_length:1.,active_top:1.3,head:3.25,housing_top:3.75,neck_top:8.,
        rodlets:1.,guide_radius:0.0055,body_radius:0.00475,
        guide_area:std::f64::consts::PI*0.0055f64.powi(2),body_area:std::f64::consts::PI*0.00475f64.powi(2),
        water:vec![cg::Water{volume:1.,moment:-1.},cg::Water{volume:1.,moment:1.},
            cg::Water{volume:2.,moment:6.}],upper:2,guides:vec![1],passive,
        cylinders:vec![cg::Cylinder{original:1.,cluster:None,lo:0.,hi:1.,factor:1.}],
        intruders:vec![],patches:vec![],row_water:vec![],routes:vec![],contacts:vec![],barrel_paths:vec![],
        origins:[0.2,0.02,0.005].into_iter().enumerate().map(|(i,l)|cg::Origin {
            kind:if i==0 {cg::OriginKind::Upper} else {cg::OriginKind::Housing {
                change:i,radius:if i==1 {0.125} else {0.025},length:if i==1 {0.5} else {4.},
            }},
            original_volume:l/4.,original_boundary:1.,paths:vec![],
        }).collect(),
    },source.prepared_geometry()).unwrap();
    let hosts=[(cm::Kind::Spider,[4,5,6,7],1),(cm::Kind::Stem,[8,9,10,11],2)]
        .into_iter().map(|(kind,targets,mn_owner)|cm::Host{cluster:0,kind,targets,
            capture_photon_j:[5.,6.,7.,8.],mn_owner,
            volume_m3:if kind==cm::Kind::Stem {0.102} else {0.1},self_chord_m:0.012}).collect();
    let routes=vec![
        cm::Route{host:0,source_region:0,water:2,origin:0,lo:0.,hi:3.25,spans:spans(2.,3.)},
        cm::Route{host:1,source_region:0,water:2,origin:0,lo:0.,hi:3.25,spans:spans(3.,4.)},
        cm::Route{host:1,source_region:0,water:2,origin:1,lo:3.25,hi:3.75,spans:spans(3.,4.)},
        cm::Route{host:1,source_region:0,water:2,origin:2,lo:3.75,hi:4.,spans:stem_spans()},
        cm::Route{host:1,source_region:1,water:2,origin:2,lo:4.,hi:8.,spans:stem_spans()},
    ];
    let heat=cm::Model::new(&source,&geometry,3,cm::Input {density_steel:7920.,mu_steel_1:0.003,
        mu_water_1:0.003103,hosts,routes}).unwrap();
    (source,geometry,heat)
}
fn pose(body:f64,stem:f64)->cg::Pose {
    cg::Pose{body,stem,body_right:true,stem_right:true,seated:body==0.}
}
fn water()->Vec<bt::Water> {
    vec![bt::Water{temperature_k:300.,density_kg_m3:1000.,saturation_temperature_k:400.};3]
}
fn source_water(g:&cg::Workspace)->Vec<ms::Stocks> {
    g.value.water.iter().map(|v|ms::Stocks{water_mass:1000.*v.volume,liquid_volume:v.volume,
        hydrogen_target:100000.,hydrogen_product:0.,mobile_boron10:1000.}).collect()
}
fn zero_source_water()->Vec<ms::Stocks> {
    vec![ms::Stocks{water_mass:0.,liquid_volume:0.,hydrogen_target:0.,hydrogen_product:0.,mobile_boron10:0.};3]
}
fn state(s:&se::Evolution)->Vec<f64> {
    let mut y=s.initial_state();
    for (i,x) in y[..s.nc_dimension()].iter_mut().enumerate() {*x=1.+0.13*i as f64;}
    y[s.target_row(7)]=3.;y[s.target_row(11)]=5.;y
}
fn stage(s:&se::Evolution,g:&cg::Prepared,m:&cm::Model,y:&[f64],p:cg::Pose,d:cg::Direction)
    ->(se::Workspace,cg::Workspace,cm::Workspace) {
    let mut gw=g.workspace();g.evaluate_into(&[p],&[d],&mut gw).unwrap();
    let mut sw=s.workspace();s.evaluate_with_geometry_into(y,s.prepared_temperatures(),
        &source_water(&gw),&gw.value.source,&mut sw).unwrap();
    let mut hw=m.workspace();m.evaluate(y,&sw,&[p],&gw,&water(),&mut hw).unwrap();
    (sw,gw,hw)
}
fn close(a:f64,b:f64) {assert!((a-b).abs()<=3e-10*a.abs().max(b.abs()).max(1e-10),"{a:.17e} != {b:.17e}");}
#[test]
fn signed_stem_crossing_and_inward_stop_preserve_whole_material_and_heat() {
    let (s,g,m)=fixture_with_minimum(-0.04);let y=state(&s);
    for stem in [-0.04,-0.02,0.,0.02] {
        let (sw,gw,hw)=stage(&s,&g,&m,&y,pose(0.1,stem),cg::Direction{body:0.,stem:-0.01});
        close(gw.value.source.passive_volumes[2]+gw.value.source.passive_volumes[3],0.102);
        let q=hw.value().unwrap();
        close(q.emitted,q.metal_total()+q.water.iter().sum::<f64>()+q.exported);
        sw.check_current_state(&y).unwrap();
    }
    let mut p=pose(0.1,0.);p.stem_right=false;
    let mut gw=g.workspace();g.evaluate_into(&[p],&[cg::Direction{body:0.,stem:-0.01}],&mut gw).unwrap();
    let mut sw=s.workspace();s.evaluate_with_geometry_into(&y,s.prepared_temperatures(),&source_water(&gw),&gw.value.source,&mut sw).unwrap();
    let mut hw=m.workspace();m.evaluate(&y,&sw,&[p],&gw,&water(),&mut hw).unwrap();
    p.stem=-0.04;
    assert!(g.evaluate_into(&[p],&[cg::Direction::default()],&mut gw).is_err());
    assert!(m.evaluate(&y,&sw,&[p],&gw,&water(),&mut hw).is_err());
    assert!(hw.value().is_err());
}
fn closure(v:&cm::Delivery) {
    close(v.emitted,v.metal_total()+v.water.iter().sum::<f64>()+v.exported);
    for row in &v.channels {for base in [0,4] {close(row[base],row[base+1]+row[base+2]+row[base+3]);}}
}
#[test]
fn birth_local_paths_and_retained_decay_pay_each_partition_once() {
    let (s,g,m)=fixture();let y=state(&s);let (sw,_,hw)=stage(&s,&g,&m,&y,pose(0.1,0.1),cg::Direction::default());
    let v=hw.value().unwrap();closure(v);
    let paid=m.paid_rows().map(|(i,q)|q*sw.rates().unwrap()[i]).sum::<f64>();close(paid,v.emitted);
    assert!(v.channels[2][2]/v.channels[2][0]>v.channels[3][2]/v.channels[3][0]);
    assert!(v.charged_metal>0. && v.photon_metal>0. && v.exported>0.);
    // Same thermal UPPER owner is not permission to enlarge a neck path to
    // the external bath: a deliberately wrong chord has a resolvable error.
    let tr=(-7920.*0.003*0.012f64).exp();
    let wrong=v.channels[3][0]*tr*(1.-(-1000.*0.003103*0.2f64).exp());
    assert!((wrong-v.channels[3][2]).abs()>0.1*v.channels[3][0]);
    assert_eq!(y,state(&s));
}
#[test]
fn whole_mn_moves_on_its_own_stock_with_no_current_capture_and_pose_restores_bits() {
    let(s,g,m)=fixture();let mut y=state(&s);y[..s.nc_dimension()].fill(0.);let before=y.clone();
    let (_,_,a)=stage(&s,&g,&m,&y,pose(0.1,0.05),cg::Direction::default());
    let (_,_,b)=stage(&s,&g,&m,&y,pose(0.1,0.3),cg::Direction::default());
    let (a,b)=(a.value().unwrap(),b.value().unwrap());
    assert_eq!(a.family_emitted[0],0.);assert_eq!(b.family_emitted[0],0.);
    close(a.family_emitted[1],b.family_emitted[1]);close(a.metal[0],b.metal[0]);close(a.metal[1],b.metal[1]);
    assert!(a.channels[4][4]<b.channels[4][4]);assert!(a.exported<b.exported);
    let (_,_,c)=stage(&s,&g,&m,&y,pose(0.1,0.05),cg::Direction::default());
    assert_eq!(a.channels,c.value().unwrap().channels);assert_eq!(y,before);
}
#[test]
fn exact_zero_entering_density_and_full_heat_jvp_match_one_sided_difference() {
    let(s,g,m)=fixture();let y=state(&s);let p=pose(0.1,0.);
    let d=cg::Direction{body:0.,stem:0.02};let(mut sw,gw,mut hw)=stage(&s,&g,&m,&y,p,d);
    let dy=vec![0.;y.len()];
    s.jvp_with_geometry_into(&dy,&[0.],&zero_source_water(),&gw.direction.source,&mut sw).unwrap();
    m.jvp(&sw,&[d],&gw,&vec![bt::WaterDirection::default();3],&mut hw).unwrap();
    let exact=hw.direction().unwrap();closure(exact);
    assert_eq!(hw.value().unwrap().channels[4],[0.;8]);assert!(exact.channels[4][0]>0.);
    let h=1e-5;let (_,_,next)=stage(&s,&g,&m,&y,pose(p.body,p.stem+h*d.stem),d);
    for (i,row) in exact.channels.iter().enumerate(){for k in 0..8{
        let fd=(next.value().unwrap().channels[i][k]-hw.value().unwrap().channels[i][k])/h;
        // Unchanged channels subtract two O(100) values; their resolvable FD
        // floor is assembly roundoff divided by h, not a physical tolerance.
        let assembly=64.*f64::EPSILON*next.value().unwrap().channels[i][k].abs()
            .max(hw.value().unwrap().channels[i][k].abs())/h;
        assert!((row[k]-fd).abs()<=1e-6*row[k].abs()+assembly,"route{i} channel{k}: {} vs{fd}",row[k]);
    }}
    let births=sw.passive_birth_events().unwrap();let densities=sw.passive_birth_density().unwrap();
    for(i,_,_,j)in s.passive_birth_geometry_rows(){close(births[i],densities[i]*sw.passive_volumes().unwrap()[j]);}
    let dpaid=m.paid_rows().map(|(i,q)|q*sw.rate_jvp().unwrap()[i]).sum::<f64>();close(dpaid,exact.emitted);
}
#[test]
fn representably_small_positive_support_converges_to_the_exact_zero_density_without_floor() {
    let(s,g,m)=fixture();let y=state(&s);
    let(sw,_,_)=stage(&s,&g,&m,&y,pose(0.1,0.),cg::Direction::default());
    let rows:Vec<_>=s.passive_birth_geometry_rows().filter(|(_,t,r,_)|*t>=8&&*r==1).collect();
    let zero:Vec<_>=rows.iter().map(|(i,_,_,_)|sw.passive_birth_density().unwrap()[*i]).collect();
    for p in [1e-10,1e-50,1e-200,1e-300] {
        let(sw,_,hw)=stage(&s,&g,&m,&y,pose(0.1,p),cg::Direction::default());
        for((i,_,_,j),z)in rows.iter().zip(&zero) {
            let v=sw.passive_volumes().unwrap()[*j];let d=sw.passive_birth_density().unwrap()[*i];
            let b=sw.passive_birth_events().unwrap()[*i];assert!(v>0.&&b>0.&&d>0.);
            assert!((d-z).abs()<=8.*f64::EPSILON*z.abs());
            assert!((d*v-b).abs()<=2.*f64::EPSILON*b.abs());
        }
        assert!(hw.value().unwrap().channels[4][0]>0.);
    }
}
#[test]
fn signed_full_jvp_resolves_capture_inventory_density_pose_and_liquid_attenuation() {
    let(s,g,m)=fixture();let y=state(&s);let p=pose(0.1,0.12);
    let d=cg::Direction{body:0.01,stem:-0.02};let(mut sw,gw,mut hw)=stage(&s,&g,&m,&y,p,d);
    let mut dy=vec![0.;y.len()];for(i,x)in dy[..s.nc_dimension()].iter_mut().enumerate(){*x=0.01*(i+1)as f64;}
    dy[s.target_row(7)]=0.3;dy[s.mn_product_row(1)]=-0.1;dy[s.target_row(11)]=-0.2;
    let dw=vec![bt::WaterDirection{temperature_k:0.,density_kg_m3:0.7};3];
    s.jvp_with_geometry_into(&dy,&[0.],&zero_source_water(),&gw.direction.source,&mut sw).unwrap();
    m.jvp(&sw,&[d],&gw,&dw,&mut hw).unwrap();let exact=hw.direction().unwrap().clone();closure(&exact);
    let h=1e-5;let mut arms=Vec::new();
    for sign in [-1.,1.]{let yy:Vec<_>=y.iter().zip(&dy).map(|(a,b)|a+sign*h*b).collect();
        let pp=pose(p.body+sign*h*d.body,p.stem+sign*h*d.stem);
        let(mut ss,gg,mut hh)=stage(&s,&g,&m,&yy,pp,d);
        // Source density does not depend on liquid density in this ordinary
        // passive primitive; actual stage still owns all moderator recipients.
        s.evaluate_with_geometry_into(&yy,s.prepared_temperatures(),&source_water(&gg),&gg.value.source,&mut ss).unwrap();
        let mut ww=water();for x in &mut ww{x.density_kg_m3+=sign*h*0.7;}
        m.evaluate(&yy,&ss,&[pp],&gg,&ww,&mut hh).unwrap();arms.push(hh.value().unwrap().clone());
    }
    for(i,row)in exact.channels.iter().enumerate(){for k in 0..8{
        let fd=(arms[1].channels[i][k]-arms[0].channels[i][k])/(2.*h);
        assert!((row[k]-fd).abs()<2e-6*row[k].abs().max(1e-8),"route{i} channel{k}: {} vs{fd}",row[k]);
    }}
}
#[test]
fn failed_prepare_wrong_state_pose_direction_and_route_coverage_invalidate_outputs() {
    let(s,g,m)=fixture();let y=state(&s);let p=pose(0.1,0.1);
    let(mut sw,mut gw,mut hw)=stage(&s,&g,&m,&y,p,cg::Direction::default());
    let mut wrong=y.clone();wrong[s.target_row(7)]+=1.;
    assert!(m.evaluate(&wrong,&sw,&[p],&gw,&water(),&mut hw).is_err());assert!(hw.value().is_err());
    m.evaluate(&y,&sw,&[p],&gw,&water(),&mut hw).unwrap();
    s.jvp_with_geometry_into(&vec![0.;y.len()],&[0.],&zero_source_water(),&gw.direction.source,&mut sw).unwrap();
    assert!(m.jvp(&sw,&[cg::Direction{body:0.,stem:1.}],&gw,&vec![bt::WaterDirection::default();3],&mut hw).is_err());
    assert!(hw.direction().is_err());
    assert!(g.evaluate_into(&[pose(-1.,0.1)],&[cg::Direction::default()],&mut gw).is_err());
    assert!(m.jvp(&sw,&[cg::Direction::default()],&gw,&vec![bt::WaterDirection::default();3],&mut hw).is_err());
    let mut bad=m.config().clone();bad.routes.pop();assert!(cm::Model::new(&s,&g,3,bad).is_err());
    let mut bad=m.config().clone();bad.routes[2].hi-=0.1;let bad=cm::Model::new(&s,&g,3,bad).unwrap();
    let(_,gg,_)=stage(&s,&g,&m,&y,p,cg::Direction::default());
    assert!(bad.evaluate(&y,&sw,&[p],&gg,&water(),&mut bad.workspace()).is_err());
}
#[test]
fn density_accessor_preserves_every_old_paid_bit_including_signed_trials_and_zero_support() {
    use owning_passive as p;
    let m=p::Model::new(vec![2.,4.],[3.;7],vec![p::Stock{volume:1.,scatter_m1:[0.;7],
        targets:vec![p::Target{index:0,sigma_m2:[0.2;7]}]}],vec![
        p::Intersection{stock:0,region:0,volume:0.1},p::Intersection{stock:0,region:1,volume:0.},
    ],1).unwrap();
    let mut w=m.workspace();m.update(&[50.],&mut w).unwrap();
    for sign in [-1.,1.] {
        let n:Vec<_>=(0..14).map(|i|sign*(1.+0.13*i as f64)).collect();
        let(mut old,mut new)=(vec![0.;14],vec![0.;14]);
        let(mut oc,mut nc)=(vec![0.;1],vec![0.;1]);
        let(mut ob,mut nb)=(vec![0.;2],vec![0.;2]);let mut density=vec![0.;2];
        m.apply(&w,&n,&mut old,&mut oc,&mut ob).unwrap();
        m.apply_with_birth_density(&w,&[50.],&n,&mut new,&mut nc,&mut nb,&mut density).unwrap();
        for(a,b)in old.iter().zip(&new).chain(oc.iter().zip(&nc)).chain(ob.iter().zip(&nb)) {
            assert_eq!(a.to_bits(),b.to_bits());
        }
        assert_eq!(density[0].is_sign_negative(),sign<0.);
        assert_eq!(density[1].is_sign_negative(),sign<0.);
        let independent=(0..7).map(|g|3.*50.*0.2/4.*n[7+g]).sum::<f64>();close(density[1],independent);
    }
}
#[test]
fn exact_geometry_owner_recipient_and_selected_endpoint_branch_are_required() {
    let(s,g,m)=fixture();let y=state(&s);let p=pose(0.1,0.1);
    let(sw,_,mut hw)=stage(&s,&g,&m,&y,p,cg::Direction::default());
    let(_,other,_)=fixture();let mut foreign=other.workspace();
    other.evaluate_into(&[p],&[cg::Direction::default()],&mut foreign).unwrap();
    assert!(m.evaluate(&y,&sw,&[p],&foreign,&water(),&mut hw).is_err());assert!(hw.value().is_err());
    let mut bad=m.config().clone();bad.routes[2].water=1;assert!(cm::Model::new(&s,&g,3,bad).is_err());
    let mut gw=g.workspace();let max=pose(0.25,0.1);g.evaluate_into(&[max],&[cg::Direction::default()],&mut gw).unwrap();
    let mut ss=s.workspace();s.evaluate_with_geometry_into(&y,s.prepared_temperatures(),&source_water(&gw),&gw.value.source,&mut ss).unwrap();
    assert!(m.evaluate(&y,&ss,&[max],&gw,&water(),&mut hw).is_err());
    let inward=cg::Pose{body_right:false,..max};g.evaluate_into(&[inward],&[cg::Direction::default()],&mut gw).unwrap();
    s.evaluate_with_geometry_into(&y,s.prepared_temperatures(),&source_water(&gw),&gw.value.source,&mut ss).unwrap();
    m.evaluate(&y,&ss,&[inward],&gw,&water(),&mut hw).unwrap();
}
#[test]
fn exact_reachable_source_subset_refuses_missing_extra_reordered_and_foreign_spans() {
    let(s,g,m)=fixture();
    assert_eq!(g.input().passive[2].moving.as_ref().unwrap().spans.len(),2);
    assert_eq!(m.config().routes[1].spans.len(),1); // shoulder is above this primary origin forever
    cm::Model::new(&s,&g,3,m.config().clone()).unwrap();
    for change in 0..4 {
        let mut bad=m.config().clone();
        match change {
            0=>{bad.routes[3].spans.pop();},
            1=>{bad.routes[1].spans.push(g.input().passive[2].moving.as_ref().unwrap().spans[1]);},
            2=>bad.routes[3].spans.reverse(),
            _=>bad.routes[3].spans[1].area*=1.01,
        }
        let error=match cm::Model::new(&s,&g,3,bad){Ok(_)=>panic!("malformed subset admitted"),Err(e)=>e};
        assert!(error.contains("route ")&&error.contains("host 1 Stem cluster 0 region 0 origin ")&&error.contains("reachable span"),"{error}");
    }
    // The filtered physical routes and complete SOURCE spans have identical
    // V/J and selected one-sided derivatives at every span/boundary cut.
    let mut cuts=vec![0.,g.input().maximum_stem];
    for r in m.config().routes.iter().filter(|r|r.host==1) {
        for p in &g.input().passive[2].moving.as_ref().unwrap().spans {
            for y in [r.lo-p.lo,r.lo-p.hi,r.hi-p.lo,r.hi-p.hi] {
                if y>0.&&y<g.input().maximum_stem {cuts.push(y);}
            }
        }
    }
    cuts.sort_by(f64::total_cmp);cuts.dedup();
    let probes:Vec<_>=cuts.iter().copied().chain(cuts.windows(2).map(|w|0.5*(w[0]+w[1]))).collect();
    for y in probes {for right in [false,true] {
        if y==0.&&!right||y==g.input().maximum_stem&&right {continue;}
        for r in m.config().routes.iter().filter(|r|r.host==1) {
            let moving=g.input().passive[if r.source_region==0 {2} else {3}].moving.as_ref().unwrap();
            for field in [0,1,2,3] {
                let sum=|spans:&[cg::Span]|spans.iter().map(|p|p.area*cg::overlap(p.lo,p.hi,r.lo,r.hi,y,right)[field]).sum::<f64>();
                assert_eq!(sum(&r.spans).to_bits(),sum(&moving.spans).to_bits());
            }
        }
    }}
}

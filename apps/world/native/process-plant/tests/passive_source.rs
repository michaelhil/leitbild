#[path="../src/passive_source.rs"] mod passive_source;
use passive_source::*;
fn make()->Model{Model::new(vec![2.,4.],[3.;7],vec![Stock{volume:5.,scatter_m1:[10.;7],targets:vec![Target{index:0,sigma_m2:[0.2;7]}]}],
    vec![Intersection{stock:0,region:0,volume:1.},Intersection{stock:0,region:1,volume:3.}],1).unwrap()}
#[test] fn actual_target_incidence_depletion_and_self_scatter_close_without_cloning_atoms(){
    let m=make();let mut w=m.workspace();m.update(&[50.],&mut w).unwrap();
    assert_eq!(w.collision().unwrap(),&[[6.;7],[9.;7]]);
    let n=vec![2.;14];let mut rates=vec![0.;14];let mut events=vec![0.];m.apply(&w,&n,&mut rates,&mut events).unwrap();
    let independent=7.*(2.*3./2.*(50.*1./5.)*0.2+2.*3./4.*(50.*3./5.)*0.2);
    assert!((events[0]-independent).abs()<1e-13);
    assert!((rates.iter().sum::<f64>()+events[0]).abs()<1e-13);
    m.update(&[0.],&mut w).unwrap();assert_eq!(w.collision().unwrap(),&[[5.;7],[7.5;7]]);
    rates.fill(0.);events.fill(0.);m.apply(&w,&n,&mut rates,&mut events).unwrap();assert_eq!(events,[0.]);assert!(rates.iter().all(|r|*r==0.));
}
#[test] fn signed_solver_population_is_linear_but_invalid_material_or_foreign_workspace_refuses(){
    let m=make();let mut w=m.workspace();m.update(&[50.],&mut w).unwrap();
    let mut rates=vec![0.;14];let mut events=vec![0.];m.apply(&w,&vec![-2.;14],&mut rates,&mut events).unwrap();
    assert!(events[0]<0.);assert!((rates.iter().sum::<f64>()+events[0]).abs()<1e-13);
    let other=make();assert!(other.update(&[50.],&mut w).is_err());assert!(w.collision().is_err());
    assert!(m.update(&[-1.],&mut w).is_err());assert!(m.apply(&w,&vec![2.;14],&mut rates,&mut events).is_err());
    assert!(Model::new(vec![1.],[1.;7],vec![Stock{volume:1.,scatter_m1:[0.;7],targets:vec![]}],vec![Intersection{stock:0,region:0,volume:2.}],0).is_err());
}

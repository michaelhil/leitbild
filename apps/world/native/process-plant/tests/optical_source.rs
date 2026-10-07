#[path="../src/transport_source.rs"] mod transport_source;
#[path="../src/optical_source.rs"] mod optical_source;
use optical_source::*;
fn close(a:f64,b:f64,rtol:f64){ assert!((a-b).abs()<=rtol*a.abs().max(b.abs()).max(1e-300),"{a:e} versus {b:e}"); }
fn column(target:usize,depth:f64)->Column{Column{target,atoms_per_m2:depth,sigma_m2:[1.;7]}}
#[test]
fn actual_exponential_integral_matches_independent_angular_integral_and_known_value(){
    close(attenuation(1.).unwrap().transmission,2.*0.10969196719776014,3e-14);
    close(attenuation(1.).unwrap().derivative,-2.*0.14849550677592205,3e-14);
    for tau in [0.,1e-8,0.01,0.1,0.999,1.000001,2.,5.,20.,100.] {
        // Composite Simpson directly on its independently reconstructed angular
        // definition 2*integral_0^1(mu*exp(-tau/mu))dmu, not the E_n algorithm.
        let n=65536;
        let f=|mu:f64|if mu==0. {0.} else {2.*mu*(-tau/mu).exp()};
        let mut sum=f(0.)+f(1.);
        for i in 1..n {sum+=if i%2==0 {2.}else{4.}*f(i as f64/n as f64);}
        let integral=sum/(3.*n as f64);
        close(attenuation(tau).unwrap().transmission,integral,2e-11);
    }
}
#[test]
fn dilute_stock_and_thin_layer_behind_thick_material_survive_rounding(){
    let a=attenuation(1e-20).unwrap();
    assert_eq!(a.transmission,1.);close(a.loss,2e-20,1e-15);
    let r=layer_response(&[Layer{columns:vec![column(0,1.)]},Layer{columns:vec![column(1,1e-20)]}]).unwrap();
    assert!(r.input.from_left[1][0]>0.);
    assert!(r.input.from_right[1][0]>0.);
    // Its thin asymptote depends on the actually preceding material.
    close(r.input.from_left[1][0],2.*0.14849550677592205*1e-20/attenuation(1.).unwrap().loss,1e-13);
    let m=transport_source::Model::new(vec![1.,1.],vec![1.,1.],[1.;7],vec![transport_source::Face{
        left:0,right:Some(1),area:1.,left_distance:1.,right_distance:Some(1.),law:transport_source::FaceLaw::Optical{targets:vec![0]}}],1).unwrap();
    let r=layer_response(&[Layer{columns:vec![column(0,1e-20)]}]).unwrap();
    let mut w=m.workspace();m.update(&[[1.;7],[1.;7]],&[r.input],&mut w).unwrap();
    assert!(w.face_coefficients().unwrap()[0][0].capture_left.value>0.);
}
#[test]
fn ordered_actual_targets_conserve_and_reversing_the_layers_reverses_side_allocation(){
    let layers=vec![Layer{columns:vec![column(0,0.1),column(1,0.2)]},Layer{columns:vec![column(0,2.)]}];
    let a=layer_response(&layers).unwrap();
    let b=layer_response(&[layers[1].clone(),layers[0].clone()]).unwrap();
    assert_eq!(a.targets,vec![0,1,0]);
    for g in 0..7 {
        close(a.input.transmission[g],b.input.transmission[g],1e-14);
        close(a.input.from_left.iter().map(|a|a[g]).sum(),1.,1e-13);
        close(a.input.from_right.iter().map(|a|a[g]).sum(),1.,1e-13);
        close(a.input.from_left[0][g]+a.input.from_left[1][g],b.input.from_right[1][g]+b.input.from_right[2][g],1e-13);
        close(a.input.from_left[0][g]/a.input.from_left[1][g],0.5,1e-14);
    }
    let transparent=layer_response(&[Layer{columns:vec![column(0,0.)]}]).unwrap();
    assert_eq!(transparent.input.transmission,[1.;7]);assert_eq!(transparent.input.from_left,vec![[0.;7]]);
    assert_eq!(attenuation(1000.).unwrap().transmission,0.); // ordinary f64 underflow, not a physical cap
}
#[test]
fn local_derivative_and_algorithm_branch_join(){
    for x in [0.01,0.2,0.999999,1.,1.000001,2.,20.] {
        let h=x*1e-5;
        let fd=(attenuation(x+h).unwrap().transmission-attenuation(x-h).unwrap().transmission)/(2.*h);
        close(fd,attenuation(x).unwrap().derivative,2e-7);
    }
    assert!(attenuation(-1.).is_err());assert!(attenuation(f64::NAN).is_err());assert!(attenuation(f64::INFINITY).is_err());
    assert!(layer_response(&[]).is_err());assert!(layer_response(&[Layer{columns:vec![]}]).is_err());
    assert!(layer_response(&[Layer{columns:vec![column(0,-1.)]}]).is_err());
}

#[test]
fn face_local_paths_match_public_boundary_and_validate_consumed_dependencies() {
    let layers = [Layer { columns: vec![column(1, 0.2)] },
        Layer { columns: vec![column(3, 1e-20), column(1, 0.1)] }];
    let model = LayerModel::new(&layers, &[1.; 5]).unwrap();
    let mut public = model.workspace();
    let mut local = model.workspace();
    let amounts = [0.2, 0.8, 0.4, 1.2, 0.6];
    let direction = [0.1, -0.3, 0.2, 0.4, -0.1];
    model.update(&amounts, &mut public).unwrap();
    model.update_dependencies(&amounts, &mut local).unwrap();
    model.jvp(&direction, &mut public).unwrap();
    model.jvp_dependencies(&direction, &mut local).unwrap();
    assert_eq!(public.input.transmission, local.input.transmission);
    assert_eq!(public.input.loss, local.input.loss);
    assert_eq!(public.input.from_left, local.input.from_left);
    assert_eq!(public.input.from_right, local.input.from_right);
    assert_eq!(public.left_loss_jvp, local.left_loss_jvp);
    assert_eq!(public.right_loss_jvp, local.right_loss_jvp);
    assert_eq!(public.transmission_jvp, local.transmission_jvp);

    // Public APIs must still reject invalid unconsumed entries. The internal
    // path's caller validates those once for the entire composition.
    let mut invalid = amounts;
    invalid[4] = f64::NAN;
    assert!(model.update(&invalid, &mut public).is_err());
    model.update_dependencies(&invalid, &mut local).unwrap();
    let mut invalid_direction = direction;
    invalid_direction[4] = f64::INFINITY;
    assert!(model.jvp(&invalid_direction, &mut local).is_err());
    model.jvp_dependencies(&invalid_direction, &mut local).unwrap();
    for invalid_value in [-1., f64::NAN, f64::INFINITY] {
        invalid[1] = invalid_value;
        assert!(model.update_dependencies(&invalid, &mut local).is_err());
        assert!(model.jvp_dependencies(&direction, &mut local).is_err());
    }
    model.update_dependencies(&amounts, &mut local).unwrap();
    invalid_direction[1] = f64::NAN;
    assert!(model.jvp_dependencies(&invalid_direction, &mut local).is_err());
    assert!(model.update_dependencies(&amounts[..4], &mut local).is_err());
    assert!(model.jvp_dependencies(&direction[..4], &mut local).is_err());
    let other = LayerModel::new(&layers, &[1.; 5]).unwrap();
    assert!(other.update_dependencies(&amounts, &mut local).is_err());
}

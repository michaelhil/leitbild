//! Water chemistry on actual signed liquid packets. H uses the admitted
//! original water population's reference atoms/kg and a direct capture product.
//! B10 and its capture product are independent LIQUID inventories: boiling
//! cannot re-create boron from a fixed initial concentration on return.
use crate::moderator_source::{Events, Stocks};

#[derive(Clone, Copy, Debug)]
pub struct Preparation {
    pub mass: f64,
    pub volume: f64,
    pub hydrogen_atoms: f64,
    pub boron_atoms: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Amounts {
    pub hydrogen: f64,
    pub boron10: f64,
    pub boron: f64,
}
pub const WIDTH: usize = 3;
impl Amounts {
    pub fn values(self) -> [f64; WIDTH] { [self.hydrogen, self.boron10, self.boron] }
    pub fn from_values(v: [f64; WIDTH]) -> Self { Self { hydrogen:v[0], boron10:v[1], boron:v[2] } }
}
#[derive(Clone, Copy, Debug)]
pub struct Link {
    pub from: usize,
    pub to: usize,
}
pub struct Carrier {
    volumes: Vec<f64>,
    links: Vec<Link>,
    hydrogen_per_kg: f64,
    initial: Vec<Amounts>,
}
fn positive(x: f64) -> bool { x.is_finite() && x > 0. }
fn finite(p: Amounts) -> bool { p.values().iter().all(|x|x.is_finite()) }
impl Carrier {
    /// One H reference per kg is required for the admitted water population.
    /// Boron may differ by cell; it is independently transported, not inferred.
    pub fn new(preparation: &[Preparation], links: Vec<Link>) -> Result<Self, &'static str> {
        if preparation.is_empty() || preparation.iter().any(|p|
            !positive(p.mass) || !positive(p.volume) || !positive(p.hydrogen_atoms)
            || !p.boron_atoms.is_finite() || p.boron_atoms < 0.) {
            return Err("Invalid liquid carrier preparation");
        }
        let h = preparation[0].hydrogen_atoms / preparation[0].mass;
        if !positive(h) || preparation.iter().any(|p| {
            let hp = p.hydrogen_atoms / p.mass;
            !positive(hp) || (hp-h).abs() > 2e-11*h.abs().max(hp.abs())
        }) {
            return Err("Water population requires one hydrogen reference per kg");
        }
        if links.iter().any(|l| l.from >= preparation.len() || l.to >= preparation.len() || l.from == l.to) {
            return Err("Invalid water carrier link");
        }
        Ok(Self { volumes: preparation.iter().map(|p| p.volume).collect(), links,
            hydrogen_per_kg: h,
            initial: preparation.iter().map(|p|Amounts {boron10:p.boron_atoms,..Default::default()}).collect() })
    }
    pub fn cells(&self) -> usize { self.volumes.len() }
    pub fn volumes(&self) -> &[f64] { &self.volumes }
    pub fn links(&self) -> &[Link] { &self.links }
    pub fn hydrogen_per_kg(&self) -> f64 { self.hydrogen_per_kg }
    pub fn initial(&self) -> &[Amounts] { &self.initial }
    fn inputs(&self, mass: &[f64], products: &[Amounts]) -> Result<(), &'static str> {
        if mass.len()!=self.cells() || products.len()!=self.cells()
            || mass.iter().any(|&m| !positive(m)) || products.iter().any(|&p| !finite(p)) {
            return Err("Invalid current liquid carrier inputs");
        }
        Ok(())
    }
    /// Signed product trials are permitted, but remaining targets cannot be
    /// negative in the constitutive source law. Physical commit is stricter.
    pub fn stocks_into(&self, mass: &[f64], products: &[Amounts], out: &mut [Stocks]) -> Result<(), &'static str> {
        self.stocks_with_volumes_into(mass,products,&self.volumes,out)
    }
    /// Actual current liquid occupation, supplied by the same physical chart
    /// as mass. No re-preparation or repartition of retained carrier products.
    pub fn stocks_with_volumes_into(&self, mass:&[f64], products:&[Amounts], volumes:&[f64], out:&mut [Stocks]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        if out.len()!=self.cells() || volumes.len()!=self.cells() || volumes.iter().any(|v|!positive(*v)) { return Err("Water carrier current volume/output shape"); }
        for i in 0..self.cells() {
            let h = self.hydrogen_per_kg*mass[i]-products[i].hydrogen;
            let b = products[i].boron10;
            if !h.is_finite() || !b.is_finite() || h<0. || b<0. {
                return Err("Water carrier trial exhausted a target");
            }
            out[i]=Stocks { water_mass: mass[i], liquid_volume: volumes[i],
                hydrogen_target:h, hydrogen_product:products[i].hydrogen, mobile_boron10:b };
        }
        Ok(())
    }
    /// Directions of the SAME stocks, including mass-dependent total carriers.
    pub fn stock_jvp_into(&self, dmass: &[f64], dproducts: &[Amounts], out: &mut [Stocks]) -> Result<(), &'static str> {
        self.stock_direction(dmass,dproducts,None,out)
    }
    pub fn stock_jvp_with_volumes_into(&self, dmass:&[f64], dproducts:&[Amounts], dvolumes:&[f64], out:&mut [Stocks]) -> Result<(), &'static str> {
        self.stock_direction(dmass,dproducts,Some(dvolumes),out)
    }
    fn stock_direction(&self, dmass:&[f64], dproducts:&[Amounts], dvolumes:Option<&[f64]>, out:&mut [Stocks]) -> Result<(), &'static str> {
        if dmass.len()!=self.cells() || dproducts.len()!=self.cells() || out.len()!=self.cells()
            || dmass.iter().any(|v| !v.is_finite()) || dproducts.iter().any(|&p| !finite(p))
            || dvolumes.is_some_and(|v| v.len()!=self.cells() || v.iter().any(|x|!x.is_finite())) {
            return Err("Invalid water carrier stock direction");
        }
        for i in 0..self.cells() {
            out[i]=Stocks { water_mass:dmass[i], liquid_volume:dvolumes.map_or(0.,|v|v[i]),
                hydrogen_target:self.hydrogen_per_kg*dmass[i]-dproducts[i].hydrogen,
                hydrogen_product:dproducts[i].hydrogen,
                mobile_boron10:dproducts[i].boron10 };
            if !out[i].hydrogen_target.is_finite() || !out[i].mobile_boron10.is_finite() {
                return Err("Unrepresentable water carrier stock direction");
            }
        }
        Ok(())
    }
    pub fn validate_accepted(&self, mass: &[f64], products: &[Amounts]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        for (&m,&p) in mass.iter().zip(products) {
            let h=self.hydrogen_per_kg*m;
            if !h.is_finite() || p.values().iter().any(|x| *x<0.) || p.hydrogen>h {
                return Err("Invalid accepted water products/targets"); }
        }
        Ok(())
    }
    /// Each capture is credited exactly once. Output is a candidate and must
    /// be discarded on error. No per-call allocation or second mass-flow law.
    pub fn rates_into(&self, mass:&[f64], products:&[Amounts], flows:&[f64], captures:&[Events], out:&mut [Amounts]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        self.rate_shapes(flows,captures,out)?;
        for (r,c) in out.iter_mut().zip(captures) { *r=Amounts {hydrogen:c.hydrogen,boron10:-c.boron,boron:c.boron}; }
        for (l,&q) in self.links.iter().zip(flows) {
            let d=if q>=0. {l.from} else {l.to};
            let h=q*products[d].hydrogen/mass[d];
            let b=q*products[d].boron/mass[d];
            let target=q*products[d].boron10/mass[d];
            out[l.from].hydrogen-=h; out[l.to].hydrogen+=h;
            out[l.from].boron-=b; out[l.to].boron+=b;
            out[l.from].boron10-=target; out[l.to].boron10+=target;
        }
        if out.iter().any(|&p| !finite(p)) { return Err("Unrepresentable carrier rates"); }
        Ok(())
    }
    fn rate_shapes(&self, flows:&[f64], captures:&[Events], out:&[Amounts]) -> Result<(), &'static str> {
        if flows.len()!=self.links.len() || captures.len()!=self.cells() || out.len()!=self.cells()
            || flows.iter().any(|v| !v.is_finite())
            || captures.iter().any(|c| !c.hydrogen.is_finite() || !c.boron.is_finite()) {
            return Err("Invalid carrier flow/capture buffer");
        }
        Ok(())
    }
    /// A fixed-upwind generalized Jacobian: at zero q choose the from side.
    /// This is a linear action for a Krylov solver, NOT a two-sided derivative
    /// at a zero-flow interface with unequal concentrations. Never switch the
    /// chosen zero-flow branch based on dq inside a supposedly linear JVP.
    pub fn jvp_into(&self, mass:&[f64], products:&[Amounts], flows:&[f64], dmass:&[f64], dproducts:&[Amounts], dflows:&[f64], dcaptures:&[Events], out:&mut [Amounts]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        self.rate_shapes(flows,dcaptures,out)?;
        if dmass.len()!=self.cells() || dproducts.len()!=self.cells() || dflows.len()!=self.links.len()
            || dmass.iter().chain(dflows).any(|v| !v.is_finite()) || dproducts.iter().any(|&p| !finite(p)) {
            return Err("Invalid carrier rate direction");
        }
        for (r,c) in out.iter_mut().zip(dcaptures) { *r=Amounts {hydrogen:c.hydrogen,boron10:-c.boron,boron:c.boron}; }
        for ((l,&q),&dq) in self.links.iter().zip(flows).zip(dflows) {
            let d=if q>=0. {l.from} else {l.to};
            let derivative=|p:f64,dp:f64| dq*p/mass[d]+q*(dp/mass[d]-(p/mass[d])*(dmass[d]/mass[d]));
            let h=derivative(products[d].hydrogen,dproducts[d].hydrogen);
            let b=derivative(products[d].boron,dproducts[d].boron);
            let target=derivative(products[d].boron10,dproducts[d].boron10);
            out[l.from].hydrogen-=h; out[l.to].hydrogen+=h;
            out[l.from].boron-=b; out[l.to].boron+=b;
            out[l.from].boron10-=target; out[l.to].boron10+=target;
        }
        if out.iter().any(|&p| !finite(p)) { return Err("Unrepresentable carrier JVP"); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_volume_changes_occupation_not_owned_products_and_has_exact_direction() {
        let c=carrier();let p=c.initial().to_vec();let mut s=[empty();2];
        c.stocks_with_volumes_into(&[2.,3.],&p,&[0.9,2.1],&mut s).unwrap();
        assert_eq!([s[0].liquid_volume,s[1].liquid_volume],[0.9,2.1]);
        assert_eq!([s[0].mobile_boron10,s[1].mobile_boron10],[4.,9.]);
        assert_eq!(c.initial()[0].boron10,4.);assert_eq!(c.volumes(),&[1.,2.]);
        let mut d=[empty();2];c.stock_jvp_with_volumes_into(&[0.2,-0.2],&[Amounts::default();2],&[-0.1,0.1],&mut d).unwrap();
        assert_eq!([d[0].liquid_volume,d[1].liquid_volume],[-0.1,0.1]);
        assert_eq!([d[0].hydrogen_target,d[1].hydrogen_target],[2.,-2.]);
        assert!(c.stocks_with_volumes_into(&[2.,3.],&p,&[0.,3.],&mut s).is_err());
        assert!(c.stock_jvp_with_volumes_into(&[0.,0.],&[Amounts::default();2],&[f64::NAN,0.],&mut d).is_err());
        c.stocks_into(&[2.,3.],&p,&mut s).unwrap();assert_eq!(s[0].liquid_volume,1.);
    }
    fn carrier()->Carrier { Carrier::new(&[Preparation {mass:2.,volume:1.,hydrogen_atoms:20.,boron_atoms:4.},
        Preparation {mass:3.,volume:2.,hydrogen_atoms:30.,boron_atoms:9.}],vec![Link {from:0,to:1}]).unwrap() }
    fn empty()->Stocks { Stocks {water_mass:0.,liquid_volume:0.,hydrogen_target:0.,hydrogen_product:0.,mobile_boron10:0.} }
    #[test] fn native_boron_is_independent_of_water_mass() {
        let c=carrier(); let mut p=c.initial().to_vec(); p[0].hydrogen=1.;
        let mut s=[empty();2]; c.stocks_into(&[1.,4.],&p,&mut s).unwrap();
        assert_eq!(s[0].hydrogen_target,9.); assert_eq!(s[1].hydrogen_target,40.);
        assert_eq!(s[0].mobile_boron10,4.); assert_eq!(s[1].mobile_boron10,9.);
        c.validate_accepted(&[1.,4.],&p).unwrap();
        p[0].boron10=-1.;
        assert!(c.stocks_into(&[1.,4.],&p,&mut s).is_err());
        assert!(c.validate_accepted(&[1.,4.],&p).is_err());
        p[0].boron10=0.; p[0].hydrogen=11.;
        assert!(c.validate_accepted(&[1.,4.],&p).is_err());
    }
    #[test] fn refuse_invalid_water_population_or_unowned_preparation() {
        let p=Preparation {mass:1.,volume:1.,hydrogen_atoms:10.,boron_atoms:2.};
        assert!(Carrier::new(&[p,Preparation {hydrogen_atoms:11.,..p}],vec![]).is_err());
        assert!(Carrier::new(&[p],vec![Link {from:0,to:1}]).is_err());
        assert!(Carrier::new(&[],vec![]).is_err());
        assert!(Carrier::new(&[Preparation {boron_atoms:f64::NAN,..p}],vec![]).is_err());
        assert!(Carrier::new(&[Preparation {mass:1e-300,hydrogen_atoms:1e300,..p}],vec![]).is_err());
    }
    #[test] fn signed_packets_and_capture_move_target_to_product_once() {
        let c=carrier(); let p=[Amounts {hydrogen:2.,boron10:4.,boron:1.},Amounts {hydrogen:12.,boron10:9.,boron:3.}];
        let capture=[Events {hydrogen:0.3,boron:0.1,..Default::default()},Events {hydrogen:0.2,boron:0.4,..Default::default()}];
        let mut r=[Amounts::default();2];
        for q in [2.,-2.,0.] {
            c.rates_into(&[2.,3.],&p,&[q],&capture,&mut r).unwrap();
            assert!((r[0].hydrogen+r[1].hydrogen-0.5).abs()<1e-14);
            assert!((r[0].boron+r[1].boron-0.5).abs()<1e-14);
            assert!((r[0].boron10+r[1].boron10+0.5).abs()<1e-14);
            let donor=if q>=0. {0} else {1};
            assert!((r[1].boron10-(-0.4+q*p[donor].boron10/[2.,3.][donor])).abs()<1e-14);
        }
    }
    #[test] fn full_direction_matches_same_packet_on_both_branches() {
        let c=carrier(); let m=[2.,3.]; let p=[Amounts {hydrogen:2.,boron10:4.,boron:1.},Amounts {hydrogen:12.,boron10:9.,boron:3.}];
        let dm=[0.2,-0.1]; let dp=[Amounts {hydrogen:0.3,boron10:0.2,boron:0.1},Amounts {hydrogen:-0.2,boron10:0.1,boron:0.4}];
        let dc=[Events {hydrogen:0.1,boron:-0.2,..Default::default()};2];
        for q in [2.,-2.] {
            let mut j=[Amounts::default();2]; c.jvp_into(&m,&p,&[q],&dm,&dp,&[0.7],&dc,&mut j).unwrap();
            let mut arms=[[Amounts::default();2];2]; let e=1e-5;
            for (k,sign) in [-1.,1.].into_iter().enumerate() {
                let mm=std::array::from_fn::<_,2,_>(|i|m[i]+sign*e*dm[i]);
                let pp=std::array::from_fn::<_,2,_>(|i|Amounts::from_values(std::array::from_fn(|k|p[i].values()[k]+sign*e*dp[i].values()[k])));
                let cc=[Events {hydrogen:sign*e*dc[0].hydrogen,boron:sign*e*dc[0].boron,..Default::default()};2];
                c.rates_into(&mm,&pp,&[q+sign*e*0.7],&cc,&mut arms[k]).unwrap();
            }
            for i in 0..2 { for k in 0..WIDTH {
                assert!(((arms[1][i].values()[k]-arms[0][i].values()[k])/(2.*e)-j[i].values()[k]).abs()<1e-9);
            }}
        }
    }
    #[test] fn zero_flow_jvp_is_linear_and_uses_declared_donor() {
        let c=carrier(); let p=[Amounts {hydrogen:2.,boron10:4.,boron:1.},Amounts {hydrogen:12.,boron10:9.,boron:3.}];
        let mut a=[Amounts::default();2]; let mut b=a;
        for (dq,out) in [(1.,&mut a),(-1.,&mut b)] {
            c.jvp_into(&[2.,3.],&p,&[0.],&[0.;2],&[Amounts::default();2],&[dq],&[Events::default();2],out).unwrap();
        }
        for k in 0..WIDTH { assert_eq!(a[1].values()[k],-b[1].values()[k]); }
        assert_eq!(a[1].boron10,2.);
    }
}

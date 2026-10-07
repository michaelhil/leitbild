//! Closed, homogeneous-reference primary chemistry on the actual water packets.
//! Reference H and B counts per kg are invariant only for this closed liquid
//! apparatus. Two direct products per hydraulic cell retain captures and move
//! on the SAME signed mass flows. They are not passive-marker aliases.
use crate::moderator_source::{Events, Stocks};

#[derive(Clone, Copy, Debug)]
pub struct Preparation {
    pub mass: f64,
    pub volume: f64,
    pub hydrogen_atoms: f64,
    pub boron_atoms: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Products {
    pub hydrogen: f64,
    pub boron: f64,
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
    boron_per_kg: f64,
}
fn positive(x: f64) -> bool { x.is_finite() && x > 0. }
fn finite(p: Products) -> bool { p.hydrogen.is_finite() && p.boron.is_finite() }
impl Carrier {
    /// Refuse a nonhomogeneous preparation instead of erasing its chemistry.
    /// h/b per kg are source-owner inputs, not constants inferred from a label.
    pub fn new(preparation: &[Preparation], links: Vec<Link>) -> Result<Self, &'static str> {
        if preparation.is_empty() || preparation.iter().any(|p|
            !positive(p.mass) || !positive(p.volume) || !positive(p.hydrogen_atoms)
            || !p.boron_atoms.is_finite() || p.boron_atoms < 0.) {
            return Err("Invalid homogeneous liquid carrier preparation");
        }
        let h = preparation[0].hydrogen_atoms / preparation[0].mass;
        let b = preparation[0].boron_atoms / preparation[0].mass;
        if !positive(h) || !b.is_finite() || preparation.iter().any(|p| {
            let hp = p.hydrogen_atoms / p.mass;
            let bp = p.boron_atoms / p.mass;
            !hp.is_finite() || !bp.is_finite() || (p.boron_atoms>0. && bp==0.)
                || (hp-h).abs() > 2e-11*h.abs().max(hp.abs())
                || (bp-b).abs() > 2e-11*b.abs().max(bp.abs())
        }) {
            return Err("Nonhomogeneous H/B reference requires independent transported totals");
        }
        if links.iter().any(|l| l.from >= preparation.len() || l.to >= preparation.len() || l.from == l.to) {
            return Err("Invalid water carrier link");
        }
        Ok(Self { volumes: preparation.iter().map(|p| p.volume).collect(), links,
            hydrogen_per_kg: h, boron_per_kg: b })
    }
    pub fn cells(&self) -> usize { self.volumes.len() }
    pub fn volumes(&self) -> &[f64] { &self.volumes }
    pub fn links(&self) -> &[Link] { &self.links }
    pub fn reference_per_kg(&self) -> [f64; 2] { [self.hydrogen_per_kg, self.boron_per_kg] }
    fn inputs(&self, mass: &[f64], products: &[Products]) -> Result<(), &'static str> {
        if mass.len()!=self.cells() || products.len()!=self.cells()
            || mass.iter().any(|&m| !positive(m)) || products.iter().any(|&p| !finite(p)) {
            return Err("Invalid current liquid carrier inputs");
        }
        Ok(())
    }
    /// Signed product trials are permitted, but remaining targets cannot be
    /// negative in the constitutive source law. Physical commit is stricter.
    pub fn stocks_into(&self, mass: &[f64], products: &[Products], out: &mut [Stocks]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        if out.len()!=self.cells() { return Err("Water carrier output shape"); }
        for i in 0..self.cells() {
            let h = self.hydrogen_per_kg*mass[i]-products[i].hydrogen;
            let b = self.boron_per_kg*mass[i]-products[i].boron;
            if !h.is_finite() || !b.is_finite() || h<0. || b<0. {
                return Err("Water carrier trial exhausted a target");
            }
            out[i]=Stocks { water_mass: mass[i], liquid_volume: self.volumes[i],
                hydrogen_target:h, hydrogen_product:products[i].hydrogen, mobile_boron10:b };
        }
        Ok(())
    }
    /// Directions of the SAME stocks, including mass-dependent total carriers.
    pub fn stock_jvp_into(&self, dmass: &[f64], dproducts: &[Products], out: &mut [Stocks]) -> Result<(), &'static str> {
        if dmass.len()!=self.cells() || dproducts.len()!=self.cells() || out.len()!=self.cells()
            || dmass.iter().any(|v| !v.is_finite()) || dproducts.iter().any(|&p| !finite(p)) {
            return Err("Invalid water carrier stock direction");
        }
        for i in 0..self.cells() {
            out[i]=Stocks { water_mass:dmass[i], liquid_volume:0.,
                hydrogen_target:self.hydrogen_per_kg*dmass[i]-dproducts[i].hydrogen,
                hydrogen_product:dproducts[i].hydrogen,
                mobile_boron10:self.boron_per_kg*dmass[i]-dproducts[i].boron };
            if !out[i].hydrogen_target.is_finite() || !out[i].mobile_boron10.is_finite() {
                return Err("Unrepresentable water carrier stock direction");
            }
        }
        Ok(())
    }
    pub fn validate_accepted(&self, mass: &[f64], products: &[Products]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        for (&m,&p) in mass.iter().zip(products) {
            let h=self.hydrogen_per_kg*m; let b=self.boron_per_kg*m;
            if !h.is_finite() || !b.is_finite() || p.hydrogen<0. || p.boron<0. || p.hydrogen>h
                || p.boron>b { return Err("Invalid accepted water products/targets"); }
        }
        Ok(())
    }
    /// Each capture is credited exactly once. Output is a candidate and must
    /// be discarded on error. No per-call allocation or second mass-flow law.
    pub fn rates_into(&self, mass:&[f64], products:&[Products], flows:&[f64], captures:&[Events], out:&mut [Products]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        self.rate_shapes(flows,captures,out)?;
        for (r,c) in out.iter_mut().zip(captures) { *r=Products {hydrogen:c.hydrogen,boron:c.boron}; }
        for (l,&q) in self.links.iter().zip(flows) {
            let d=if q>=0. {l.from} else {l.to};
            let h=q*products[d].hydrogen/mass[d];
            let b=q*products[d].boron/mass[d];
            out[l.from].hydrogen-=h; out[l.to].hydrogen+=h;
            out[l.from].boron-=b; out[l.to].boron+=b;
        }
        if out.iter().any(|&p| !finite(p)) { return Err("Unrepresentable carrier rates"); }
        Ok(())
    }
    fn rate_shapes(&self, flows:&[f64], captures:&[Events], out:&[Products]) -> Result<(), &'static str> {
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
    pub fn jvp_into(&self, mass:&[f64], products:&[Products], flows:&[f64], dmass:&[f64], dproducts:&[Products], dflows:&[f64], dcaptures:&[Events], out:&mut [Products]) -> Result<(), &'static str> {
        self.inputs(mass,products)?;
        self.rate_shapes(flows,dcaptures,out)?;
        if dmass.len()!=self.cells() || dproducts.len()!=self.cells() || dflows.len()!=self.links.len()
            || dmass.iter().chain(dflows).any(|v| !v.is_finite()) || dproducts.iter().any(|&p| !finite(p)) {
            return Err("Invalid carrier rate direction");
        }
        for (r,c) in out.iter_mut().zip(dcaptures) { *r=Products {hydrogen:c.hydrogen,boron:c.boron}; }
        for ((l,&q),&dq) in self.links.iter().zip(flows).zip(dflows) {
            let d=if q>=0. {l.from} else {l.to};
            let derivative=|p:f64,dp:f64| dq*p/mass[d]+q*(dp/mass[d]-(p/mass[d])*(dmass[d]/mass[d]));
            let h=derivative(products[d].hydrogen,dproducts[d].hydrogen);
            let b=derivative(products[d].boron,dproducts[d].boron);
            out[l.from].hydrogen-=h; out[l.to].hydrogen+=h;
            out[l.from].boron-=b; out[l.to].boron+=b;
        }
        if out.iter().any(|&p| !finite(p)) { return Err("Unrepresentable carrier JVP"); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn carrier()->Carrier { Carrier::new(&[Preparation {mass:2.,volume:1.,hydrogen_atoms:20.,boron_atoms:4.},
        Preparation {mass:3.,volume:2.,hydrogen_atoms:30.,boron_atoms:6.}],vec![Link {from:0,to:1}]).unwrap() }
    fn empty()->Stocks { Stocks {water_mass:0.,liquid_volume:0.,hydrogen_target:0.,hydrogen_product:0.,mobile_boron10:0.} }
    #[test] fn refuse_nonuniform_or_unowned_preparation() {
        let p=Preparation {mass:1.,volume:1.,hydrogen_atoms:10.,boron_atoms:2.};
        assert!(Carrier::new(&[p,Preparation {boron_atoms:2.1,..p}],vec![]).is_err());
        assert!(Carrier::new(&[p],vec![Link {from:0,to:1}]).is_err());
        assert!(Carrier::new(&[],vec![]).is_err());
        assert!(Carrier::new(&[p,Preparation {mass:1e-300,hydrogen_atoms:1e300,..p}],vec![]).is_err());
        assert!(Carrier::new(&[Preparation {mass:1e300,hydrogen_atoms:1e300,boron_atoms:1e-300,..p}],vec![]).is_err());
    }
    #[test] fn actual_mass_and_products_are_one_source_view() {
        let c=carrier(); let p=[Products {hydrogen:1.,boron:0.5};2]; let mut s=[empty();2];
        c.stocks_into(&[1.,4.],&p,&mut s).unwrap();
        assert_eq!(s[0].hydrogen_target,9.); assert_eq!(s[1].hydrogen_target,39.);
        assert_eq!(s[0].mobile_boron10,1.5); assert_eq!(s[1].mobile_boron10,7.5);
        c.validate_accepted(&[1.,4.],&p).unwrap();
        assert!(c.validate_accepted(&[1.,4.],&[Products {hydrogen:-1.,boron:0.};2]).is_err());
        assert!(c.validate_accepted(&[1.,4.],&[Products {hydrogen:0.,boron:3.};2]).is_err());
        assert!(c.validate_accepted(&[f64::MAX,4.],&[Products::default();2]).is_err());
    }
    #[test] fn signed_packets_and_capture_ledger() {
        let c=carrier(); let p=[Products {hydrogen:2.,boron:1.},Products {hydrogen:12.,boron:3.}];
        let capture=[Events {hydrogen:0.3,boron:0.1,..Default::default()},Events {hydrogen:0.2,boron:0.4,..Default::default()}];
        let mut r=[Products::default();2];
        for q in [2.,-2.,0.] {
            c.rates_into(&[2.,3.],&p,&[q],&capture,&mut r).unwrap();
            assert!((r[0].hydrogen+r[1].hydrogen-0.5).abs()<1e-14);
            assert!((r[0].boron+r[1].boron-0.5).abs()<1e-14);
            let donor=if q>=0. {0} else {1};
            assert!((r[1].hydrogen-(0.2+q*p[donor].hydrogen/[2.,3.][donor])).abs()<1e-14);
        }
    }
    #[test] fn full_direction_matches_perturbed_same_packet_on_both_branches() {
        let c=carrier(); let m=[2.,3.]; let p=[Products {hydrogen:2.,boron:1.},Products {hydrogen:12.,boron:3.}];
        let dm=[0.2,-0.1]; let dp=[Products {hydrogen:0.3,boron:0.1},Products {hydrogen:-0.2,boron:0.4}];
        let dc=[Events {hydrogen:0.1,boron:-0.2,..Default::default()};2];
        for q in [2.,-2.] {
            let mut j=[Products::default();2]; c.jvp_into(&m,&p,&[q],&dm,&dp,&[0.7],&dc,&mut j).unwrap();
            let mut arms=[[Products::default();2];2]; let e=1e-5;
            for (k,sign) in [-1.,1.].into_iter().enumerate() {
                let mm=std::array::from_fn::<_,2,_>(|i|m[i]+sign*e*dm[i]);
                let pp=std::array::from_fn::<_,2,_>(|i|Products {hydrogen:p[i].hydrogen+sign*e*dp[i].hydrogen,boron:p[i].boron+sign*e*dp[i].boron});
                let cc=[Events {hydrogen:sign*e*dc[0].hydrogen,boron:sign*e*dc[0].boron,..Default::default()};2];
                c.rates_into(&mm,&pp,&[q+sign*e*0.7],&cc,&mut arms[k]).unwrap();
            }
            for i in 0..2 { assert!(((arms[1][i].hydrogen-arms[0][i].hydrogen)/(2.*e)-j[i].hydrogen).abs()<1e-9);
                assert!(((arms[1][i].boron-arms[0][i].boron)/(2.*e)-j[i].boron).abs()<1e-9); }
        }
    }
    #[test] fn zero_flow_jvp_is_linear_and_uses_declared_branch() {
        let c=carrier(); let p=[Products {hydrogen:2.,boron:1.},Products {hydrogen:12.,boron:3.}];
        let mut a=[Products::default();2]; let mut b=a;
        for (dq,out) in [(1.,&mut a),(-1.,&mut b)] {
            c.jvp_into(&[2.,3.],&p,&[0.],&[0.;2],&[Products::default();2],&[dq],&[Events::default();2],out).unwrap();
        }
        assert_eq!(a[1].hydrogen,1.); assert_eq!(a[1].hydrogen,-b[1].hydrogen);
    }
}

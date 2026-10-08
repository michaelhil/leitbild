//! Finite cold 304 barrel: one caloric owner, actual signed liquid contacts,
//! and the selected serial photon self/liquid/export projection. No gamma
//! field, phase continuation, thermostat or second capture event is created.
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub struct Contact {
    pub water: usize,
    pub area_m2: f64,
    pub liquid_chord_m: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Model {
        Model::new(Input {
            mass_kg: 20.,
            cp_constant_j_kg_k: 469.4448,
            cp_linear_j_kg_k2: 0.13480848,
            datum_k: 300.,
            minimum_k: 290.,
            maximum_k: 1600.,
            initial_temperature_k: 300.,
            steel_density_kg_m3: 7920.,
            host_chord_m: 0.1,
            steel_mu_en_m2_kg: 0.0026,
            liquid_mu_en_m2_kg: 0.003103,
            wet_h_w_m2_k: 250.,
            targets: [0, 1, 2, 3],
            capture_photon_j: [1., 2., 3., 4.],
            mn_owner: 0,
            mn_electron_j: 2.,
            mn_photon_j: 3.,
            water_count: 3,
            contacts: vec![
                Contact {
                    water: 0,
                    area_m2: 2.,
                    liquid_chord_m: 0.1,
                },
                Contact {
                    water: 2,
                    area_m2: 3.,
                    liquid_chord_m: 0.2,
                },
            ],
        })
        .unwrap()
    }
    fn waters() -> Vec<Water> {
        vec![
            Water {
                temperature_k: 300.,
                density_kg_m3: 1000.,
                saturation_temperature_k: 450.
            };
            3
        ]
    }
    fn close(a: f64, b: f64) {
        assert!(
            (a - b).abs() <= 1e-9 + 2e-12 * a.abs().max(b.abs()),
            "{a:e} != {b:e}"
        );
    }
    #[test]
    fn finite_caloric_datum_and_owned_bounds() {
        let m = fixture();
        assert_eq!(m.energy(300.).unwrap(), 0.);
        assert!(m.energy(290.).unwrap() < 0.);
        for t in [290., 300., 450., 1599.] {
            let h = 1e-3;
            let fd = (m.energy(t + h).unwrap() - m.energy(t.max(290.)).unwrap()) / h;
            assert!((fd - m.heat_capacity(t).unwrap()).abs() < 0.003);
        }
        assert!(m.energy(289.).is_err());
        assert!(m.energy(1601.).is_err());
    }
    #[test]
    fn independent_serial_paths_reciprocity_and_direct_nuclear_receipts() {
        let m = fixture();
        let mut w = m.workspace();
        let water = waters();
        let captures = [1., 2., 3., 4.];
        m.evaluate(320., &captures, 2., &water, &mut w).unwrap();
        let photons = 30. + 6.;
        let charged = 4.;
        let host = (-7920. * 0.0026_f64 * 0.1).exp();
        close(
            w.nuclear_heat_rate().unwrap(),
            charged + photons * (1. - host),
        );
        let mut export = 0.;
        for (j, c) in m.config().contacts.iter().enumerate() {
            let transmission = (-1000. * 0.003103_f64 * c.liquid_chord_m).exp();
            let incoming = photons * host * [0.4, 0.6][j];
            close(
                w.water_photon_heat().unwrap()[c.water],
                incoming * (1. - transmission),
            );
            export += incoming * transmission;
        }
        close(w.export_rate().unwrap(), export);
        close(
            w.heat_rate().unwrap() + w.water_heat().unwrap().iter().sum::<f64>() + export,
            w.emitted_rate().unwrap(),
        );
        assert_eq!(w.water_heat().unwrap()[1], 0.);
        // Nuclear paths must not disappear beside an enormous sensible term.
        let before = w.water_photon_heat().unwrap().to_vec();
        m.evaluate(400., &captures, 2., &water, &mut w).unwrap();
        assert_eq!(before, w.water_photon_heat().unwrap());
        m.evaluate(300., &[0.; 4], 0., &water, &mut w).unwrap();
        assert_eq!(w.heat_rate().unwrap(), 0.);
        assert_eq!(w.export_rate().unwrap(), 0.);
        assert!(w.water_heat().unwrap().iter().all(|x| *x == 0.));
    }
    #[test]
    fn full_signed_direction_and_changed_density_match_finite_differences() {
        let m = fixture();
        let water = waters();
        let c = [1., 2., 3., 4.];
        let dc = [-0.3, 0.2, -0.1, 0.4];
        let dw = vec![
            WaterDirection {
                temperature_k: 0.2,
                density_kg_m3: -0.4
            };
            3
        ];
        let mut w = m.workspace();
        m.evaluate(320., &c, 2., &water, &mut w).unwrap();
        m.jvp(-0.1, &dc, -0.2, &dw, &mut w).unwrap();
        let action = [
            w.heat_jvp().unwrap(),
            w.emitted_jvp().unwrap(),
            w.export_jvp().unwrap(),
        ];
        for h in [0.01, 0.005] {
            let arm = |s: f64| {
                let mut a = m.workspace();
                let wa = water
                    .iter()
                    .map(|v| Water {
                        temperature_k: v.temperature_k + s * h * 0.2,
                        density_kg_m3: v.density_kg_m3 - s * h * 0.4,
                        ..*v
                    })
                    .collect::<Vec<_>>();
                let ca = std::array::from_fn(|i| c[i] + s * h * dc[i]);
                m.evaluate(320. - s * h * 0.1, &ca, 2. - s * h * 0.2, &wa, &mut a)
                    .unwrap();
                a
            };
            let p = arm(1.);
            let q = arm(-1.);
            for (a, (p, q)) in action.iter().zip(
                [
                    p.heat_rate().unwrap(),
                    p.emitted_rate().unwrap(),
                    p.export_rate().unwrap(),
                ]
                .into_iter()
                .zip([
                    q.heat_rate().unwrap(),
                    q.emitted_rate().unwrap(),
                    q.export_rate().unwrap(),
                ]),
            ) {
                assert!((a - (p - q) / (2. * h)).abs() < 1e-7 + 2e-7 * a.abs());
            }
            for (i, &a) in w.water_heat_jvp().unwrap().iter().enumerate() {
                assert!(
                    (a - (p.water_heat().unwrap()[i] - q.water_heat().unwrap()[i]) / (2. * h))
                        .abs()
                        < 1e-7 + 2e-7 * a.abs()
                );
            }
        }
        close(
            w.heat_jvp().unwrap()
                + w.water_heat_jvp().unwrap().iter().sum::<f64>()
                + w.export_jvp().unwrap(),
            w.emitted_jvp().unwrap(),
        );
    }
    #[test]
    fn limits_signed_trials_and_failure_ownership_are_explicit() {
        let m = fixture();
        let water = waters();
        let mut w = m.workspace();
        assert!(w.heat_rate().is_err());
        m.evaluate(299., &[-1., -2., -3., -4.], -2., &water, &mut w)
            .unwrap();
        assert!(w.emitted_rate().unwrap() < 0.);
        assert!(w.heat_jvp().is_err());
        let mut dry = water.clone();
        dry[0].density_kg_m3 = 0.;
        assert!(m.evaluate(300., &[1.; 4], 1., &dry, &mut w).is_err());
        assert!(w.heat_rate().is_err());
        assert!(m
            .jvp(
                0.,
                &[0.; 4],
                0.,
                &vec![WaterDirection::default(); 3],
                &mut w
            )
            .is_err());
        m.evaluate(300., &[1.; 4], 1., &water, &mut w).unwrap();
        let other = fixture();
        assert!(other.evaluate(300., &[1.; 4], 1., &water, &mut w).is_err());
        assert!(w.heat_rate().is_err());
        assert!(m.evaluate(450., &[1.; 4], 1., &water, &mut w).is_err());
        for (steel, liquid) in [(0., 0.), (1e-20, 1e-20), (1., 1.)] {
            let mut cfg = fixture().input;
            cfg.steel_mu_en_m2_kg = steel;
            cfg.liquid_mu_en_m2_kg = liquid;
            let a = Model::new(cfg).unwrap();
            let mut aw = a.workspace();
            a.evaluate(300., &[1.; 4], 0., &water, &mut aw).unwrap();
            close(
                aw.nuclear_heat_rate().unwrap()
                    + aw.water_photon_heat().unwrap().iter().sum::<f64>()
                    + aw.export_rate().unwrap(),
                aw.emitted_rate().unwrap(),
            );
        }
    }
    #[test]
    fn current_chords_preserve_wrappers_and_give_conservative_signed_direction() {
        let m = fixture();
        let water = waters();
        let captures = [2., 3., 4., 5.];
        let mut w = m.workspace();
        let mut old = m.workspace();
        m.evaluate(320., &captures, 2., &water, &mut old).unwrap();
        m.evaluate_with_chords(320., &captures, 2., &water, m.chords(), &mut w)
            .unwrap();
        assert_eq!(
            old.water_heat()
                .unwrap()
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>(),
            w.water_heat()
                .unwrap()
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            old.export_rate().unwrap().to_bits(),
            w.export_rate().unwrap().to_bits()
        );
        let held_dw = vec![
            WaterDirection {
                temperature_k: 0.2,
                density_kg_m3: 0.4,
            };
            water.len()
        ];
        m.jvp(0.1, &[0.1, -0.2, 0.3, -0.4], -0.2, &held_dw, &mut old)
            .unwrap();
        m.jvp_with_chord_direction(
            0.1,
            &[0.1, -0.2, 0.3, -0.4],
            -0.2,
            &held_dw,
            &vec![0.; m.chords().len()],
            &mut w,
        )
        .unwrap();
        assert_eq!(
            old.water_heat_jvp()
                .unwrap()
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>(),
            w.water_heat_jvp()
                .unwrap()
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            old.export_jvp().unwrap().to_bits(),
            w.export_jvp().unwrap().to_bits()
        );
        let chords: Vec<_> = m
            .chords()
            .iter()
            .enumerate()
            .map(|(i, c)| c * (1.1 + 0.1 * i as f64))
            .collect();
        let dc = vec![0.03, -0.02];
        let de = [0.1, -0.2, 0.3, -0.4];
        let dm = -0.2;
        let dt = 0.1;
        let dw = vec![
            WaterDirection {
                temperature_k: 0.2,
                density_kg_m3: 0.4
            };
            water.len()
        ];
        m.evaluate_with_chords(320., &captures, 2., &water, &chords, &mut w)
            .unwrap();
        assert_ne!(
            old.water_photon_heat().unwrap(),
            w.water_photon_heat().unwrap()
        );
        m.jvp_with_chord_direction(dt, &de, dm, &dw, &dc, &mut w)
            .unwrap();
        close(
            w.heat_jvp().unwrap()
                + w.water_heat_jvp().unwrap().iter().sum::<f64>()
                + w.export_jvp().unwrap(),
            w.emitted_jvp().unwrap(),
        );
        let h = 1e-4;
        let mut plus = m.workspace();
        let mut minus = m.workspace();
        for (sign, s) in [(1., &mut plus), (-1., &mut minus)] {
            let ca = std::array::from_fn(|i| captures[i] + sign * h * de[i]);
            let wa = water
                .iter()
                .zip(&dw)
                .map(|(a, d)| Water {
                    temperature_k: a.temperature_k + sign * h * d.temperature_k,
                    density_kg_m3: a.density_kg_m3 + sign * h * d.density_kg_m3,
                    ..*a
                })
                .collect::<Vec<_>>();
            let ch = chords
                .iter()
                .zip(&dc)
                .map(|(c, d)| c + sign * h * d)
                .collect::<Vec<_>>();
            m.evaluate_with_chords(320. + sign * h * dt, &ca, 2. + sign * h * dm, &wa, &ch, s)
                .unwrap();
        }
        for ((a, p), q) in w
            .water_heat_jvp()
            .unwrap()
            .iter()
            .zip(plus.water_heat().unwrap())
            .zip(minus.water_heat().unwrap())
        {
            assert!((a - (p - q) / (2. * h)).abs() < 1e-7 + 1e-6 * a.abs());
        }
        assert!(
            (w.export_jvp().unwrap()
                - (plus.export_rate().unwrap() - minus.export_rate().unwrap()) / (2. * h))
                .abs()
                < 1e-7
        );
        m.evaluate(320., &captures, 2., &water, &mut w).unwrap();
        assert_eq!(
            old.export_rate().unwrap().to_bits(),
            w.export_rate().unwrap().to_bits()
        );
        assert!(m
            .jvp_with_chord_direction(dt, &de, dm, &dw, &[], &mut w)
            .is_err());
        assert!(w.export_jvp().is_err());
        for bad in [0., -1., f64::NAN] {
            let mut ch = chords.clone();
            ch[0] = bad;
            assert!(m
                .evaluate_with_chords(320., &captures, 2., &water, &ch, &mut w)
                .is_err());
            assert!(w.export_rate().is_err());
        }
    }
}
#[derive(Clone, Debug)]
pub struct Input {
    pub mass_kg: f64,
    pub cp_constant_j_kg_k: f64,
    pub cp_linear_j_kg_k2: f64,
    pub datum_k: f64,
    pub minimum_k: f64,
    pub maximum_k: f64,
    pub initial_temperature_k: f64,
    pub steel_density_kg_m3: f64,
    pub host_chord_m: f64,
    pub steel_mu_en_m2_kg: f64,
    pub liquid_mu_en_m2_kg: f64,
    pub wet_h_w_m2_k: f64,
    pub targets: [usize; 4],
    pub capture_photon_j: [f64; 4],
    pub mn_owner: usize,
    pub mn_electron_j: f64,
    pub mn_photon_j: f64,
    pub water_count: usize,
    pub contacts: Vec<Contact>,
}
#[derive(Clone, Copy, Debug)]
pub struct Water {
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub saturation_temperature_k: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct WaterDirection {
    pub temperature_k: f64,
    pub density_kg_m3: f64,
}
pub struct Model {
    input: Input,
    weights: Vec<f64>,
    original_chords: Vec<f64>,
    self_absorption: f64,
    self_transmission: f64,
    owner: Arc<()>,
}
pub struct Workspace {
    energy: f64,
    capacity: f64,
    heat: f64,
    nuclear_heat: f64,
    emitted: f64,
    export: f64,
    water: Vec<f64>,
    water_photon: Vec<f64>,
    water_tangent: Vec<f64>,
    absorption: Vec<f64>,
    transmission: Vec<f64>,
    chords: Vec<f64>,
    contact_density: Vec<f64>,
    photon: f64,
    heat_tangent: f64,
    nuclear_heat_tangent: f64,
    water_photon_tangent: Vec<f64>,
    emitted_tangent: f64,
    export_tangent: f64,
    valid: bool,
    direction_valid: bool,
    owner: Arc<()>,
}
impl Workspace {
    fn check(&self) -> Result<(), &'static str> {
        if self.valid {
            Ok(())
        } else {
            Err("No current barrel preparation")
        }
    }
    fn check_direction(&self) -> Result<(), &'static str> {
        self.check()?;
        if self.direction_valid {
            Ok(())
        } else {
            Err("No current barrel direction")
        }
    }
    pub fn energy(&self) -> Result<f64, &'static str> {
        self.check()?;
        Ok(self.energy)
    }
    pub fn capacity(&self) -> Result<f64, &'static str> {
        self.check()?;
        Ok(self.capacity)
    }
    pub fn heat_rate(&self) -> Result<f64, &'static str> {
        self.check()?;
        Ok(self.heat)
    }
    pub fn nuclear_heat_rate(&self) -> Result<f64, &'static str> {
        self.check()?;
        Ok(self.nuclear_heat)
    }
    pub fn water_photon_heat(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.water_photon)
    }
    pub fn emitted_rate(&self) -> Result<f64, &'static str> {
        self.check()?;
        Ok(self.emitted)
    }
    pub fn export_rate(&self) -> Result<f64, &'static str> {
        self.check()?;
        Ok(self.export)
    }
    pub fn water_heat(&self) -> Result<&[f64], &'static str> {
        self.check()?;
        Ok(&self.water)
    }
    pub fn heat_jvp(&self) -> Result<f64, &'static str> {
        self.check_direction()?;
        Ok(self.heat_tangent)
    }
    pub fn nuclear_heat_jvp(&self) -> Result<f64, &'static str> {
        self.check_direction()?;
        Ok(self.nuclear_heat_tangent)
    }
    pub fn water_photon_heat_jvp(&self) -> Result<&[f64], &'static str> {
        self.check_direction()?;
        Ok(&self.water_photon_tangent)
    }
    pub fn emitted_jvp(&self) -> Result<f64, &'static str> {
        self.check_direction()?;
        Ok(self.emitted_tangent)
    }
    pub fn export_jvp(&self) -> Result<f64, &'static str> {
        self.check_direction()?;
        Ok(self.export_tangent)
    }
    pub fn water_heat_jvp(&self) -> Result<&[f64], &'static str> {
        self.check_direction()?;
        Ok(&self.water_tangent)
    }
}
impl Model {
    pub fn new(input: Input) -> Result<Self, &'static str> {
        let p = &input;
        if p.water_count == 0
            || p.contacts.is_empty()
            || [
                p.mass_kg,
                p.cp_constant_j_kg_k,
                p.datum_k,
                p.minimum_k,
                p.maximum_k,
                p.initial_temperature_k,
                p.steel_density_kg_m3,
                p.host_chord_m,
                p.wet_h_w_m2_k,
            ]
            .iter()
            .any(|x| !x.is_finite() || *x <= 0.)
            || [
                p.cp_linear_j_kg_k2,
                p.steel_mu_en_m2_kg,
                p.liquid_mu_en_m2_kg,
                p.mn_electron_j,
                p.mn_photon_j,
            ]
            .iter()
            .chain(&p.capture_photon_j)
            .any(|x| !x.is_finite() || *x < 0.)
            || p.minimum_k >= p.maximum_k
            || p.datum_k < p.minimum_k
            || p.datum_k > p.maximum_k
            || p.initial_temperature_k < p.minimum_k
            || p.initial_temperature_k > p.maximum_k
            || p.targets
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != 4
            || p.contacts.iter().any(|c| {
                c.water >= p.water_count
                    || !c.area_m2.is_finite()
                    || c.area_m2 <= 0.
                    || !c.liquid_chord_m.is_finite()
                    || c.liquid_chord_m <= 0.
            })
            || p.contacts
                .iter()
                .map(|c| c.water)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != p.contacts.len()
        {
            return Err("Invalid finite cold barrel input");
        }
        let area: f64 = p.contacts.iter().map(|c| c.area_m2).sum();
        let tau = p.steel_density_kg_m3 * p.steel_mu_en_m2_kg * p.host_chord_m;
        if !area.is_finite()
            || !tau.is_finite()
            || !(area * p.wet_h_w_m2_k).is_finite()
            || p.contacts.iter().any(|c| c.area_m2 * p.wet_h_w_m2_k == 0.)
        {
            return Err("Unrepresentable barrel geometry/opacity/contact");
        }
        let weights = p
            .contacts
            .iter()
            .map(|c| c.area_m2 / area)
            .collect::<Vec<_>>();
        if weights.iter().any(|x| !x.is_finite() || *x <= 0.) {
            return Err("Unrepresentable barrel contact weights");
        }
        let original_chords = input.contacts.iter().map(|c| c.liquid_chord_m).collect();
        let model = Self {
            input,
            weights,
            original_chords,
            self_absorption: -(-tau).exp_m1(),
            self_transmission: (-tau).exp(),
            owner: Arc::new(()),
        };
        model.energy(model.input.minimum_k)?;
        model.energy(model.input.maximum_k)?;
        model.heat_capacity(model.input.maximum_k)?;
        Ok(model)
    }
    pub fn config(&self) -> &Input {
        &self.input
    }
    pub fn chords(&self) -> &[f64] {
        &self.original_chords
    }
    pub fn initial_temperature(&self) -> f64 {
        self.input.initial_temperature_k
    }
    /// Held-water sensible-contact derivative; nuclear host absorption is
    /// temperature independent under the selected fixed-material projection.
    pub fn self_heat_derivative(&self) -> f64 {
        -self.input.wet_h_w_m2_k * self.input.contacts.iter().map(|c| c.area_m2).sum::<f64>()
    }
    pub fn heat_capacity(&self, t: f64) -> Result<f64, &'static str> {
        let p = &self.input;
        if !t.is_finite() || t < p.minimum_k || t > p.maximum_k {
            return Err("Barrel outside owned 304 thermal domain");
        }
        let c = p.mass_kg * (p.cp_constant_j_kg_k + p.cp_linear_j_kg_k2 * t);
        if !c.is_finite() || c <= 0. {
            return Err("Unrepresentable barrel heat capacity");
        }
        Ok(c)
    }
    pub fn energy(&self, t: f64) -> Result<f64, &'static str> {
        self.heat_capacity(t)?;
        let p = &self.input;
        let e = p.mass_kg
            * (t - p.datum_k)
            * (p.cp_constant_j_kg_k + 0.5 * p.cp_linear_j_kg_k2 * (t + p.datum_k));
        if !e.is_finite() {
            return Err("Unrepresentable barrel sensible energy");
        }
        Ok(e)
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            energy: 0.,
            capacity: 0.,
            heat: 0.,
            nuclear_heat: 0.,
            emitted: 0.,
            export: 0.,
            water: vec![0.; self.input.water_count],
            water_photon: vec![0.; self.input.water_count],
            water_photon_tangent: vec![0.; self.input.water_count],
            nuclear_heat_tangent: 0.,
            water_tangent: vec![0.; self.input.water_count],
            absorption: vec![0.; self.input.contacts.len()],
            transmission: vec![0.; self.input.contacts.len()],
            chords: vec![0.; self.input.contacts.len()],
            contact_density: vec![0.; self.input.contacts.len()],
            photon: 0.,
            heat_tangent: 0.,
            emitted_tangent: 0.,
            export_tangent: 0.,
            valid: false,
            direction_valid: false,
            owner: self.owner.clone(),
        }
    }
    /// Event trials may be signed; finite physical inventories are admitted by
    /// their source owner, not clipped or re-integrated in this thermal block.
    pub fn evaluate(
        &self,
        t: f64,
        captures: &[f64; 4],
        mn_decay: f64,
        water: &[Water],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.evaluate_with_chords(t, captures, mn_decay, water, &self.original_chords, w)
    }
    /// Same finite barrel and fixed receiving contacts, with current physical
    /// liquid path chords. Geometry owns no source, heat or liquid history.
    pub fn evaluate_with_chords(
        &self,
        t: f64,
        captures: &[f64; 4],
        mn_decay: f64,
        water: &[Water],
        chords: &[f64],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.valid = false;
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || water.len() != self.input.water_count
            || chords.len() != self.input.contacts.len()
            || chords.iter().any(|c| !c.is_finite() || *c <= 0.)
            || captures
                .iter()
                .chain(std::iter::once(&mn_decay))
                .any(|x| !x.is_finite())
        {
            return Err("Invalid barrel trial/workspace");
        }
        w.energy = self.energy(t)?;
        w.capacity = self.heat_capacity(t)?;
        let photon = captures
            .iter()
            .zip(self.input.capture_photon_j)
            .map(|(c, q)| c * q)
            .sum::<f64>()
            + mn_decay * self.input.mn_photon_j;
        let charged = mn_decay * self.input.mn_electron_j;
        w.photon = photon;
        w.emitted = photon + charged;
        w.nuclear_heat = charged + photon * self.self_absorption;
        w.heat = w.nuclear_heat;
        w.export = 0.;
        w.water.fill(0.);
        w.water_photon.fill(0.);
        for (j, c) in self.input.contacts.iter().enumerate() {
            let a = water[c.water];
            if !a.temperature_k.is_finite()
                || a.temperature_k <= 0.
                || !a.density_kg_m3.is_finite()
                || a.density_kg_m3 <= 0.
                || !a.saturation_temperature_k.is_finite()
                || a.temperature_k >= a.saturation_temperature_k
                || t >= a.saturation_temperature_k
            {
                return Err("Barrel contact outside cold fully-liquid scope");
            }
            w.chords[j] = chords[j];
            w.contact_density[j] = a.density_kg_m3;
            let tau = a.density_kg_m3 * self.input.liquid_mu_en_m2_kg * chords[j];
            if !tau.is_finite() {
                return Err("Unrepresentable barrel liquid opacity");
            }
            w.absorption[j] = -(-tau).exp_m1();
            w.transmission[j] = (-tau).exp();
            let incident = photon * self.self_transmission * self.weights[j];
            let q = c.area_m2 * self.input.wet_h_w_m2_k * (t - a.temperature_k);
            w.water_photon[c.water] = incident * w.absorption[j];
            w.heat -= q;
            w.water[c.water] += q + w.water_photon[c.water];
            w.export += incident * w.transmission[j];
        }
        if [w.energy, w.capacity, w.heat, w.emitted, w.export]
            .iter()
            .chain(&w.water)
            .any(|x| !x.is_finite())
        {
            return Err("Unrepresentable barrel heat transaction");
        }
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        dt: f64,
        dcaptures: &[f64; 4],
        dmn_decay: f64,
        dwater: &[WaterDirection],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.jvp_current(dt, dcaptures, dmn_decay, dwater, None, w)
    }
    pub fn jvp_with_chord_direction(
        &self,
        dt: f64,
        dcaptures: &[f64; 4],
        dmn_decay: f64,
        dwater: &[WaterDirection],
        chords: &[f64],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        self.jvp_current(dt, dcaptures, dmn_decay, dwater, Some(chords), w)
    }
    fn jvp_current(
        &self,
        dt: f64,
        dcaptures: &[f64; 4],
        dmn_decay: f64,
        dwater: &[WaterDirection],
        chords: Option<&[f64]>,
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || dwater.len() != self.input.water_count
            || chords.is_some_and(|c| {
                c.len() != self.input.contacts.len() || c.iter().any(|c| !c.is_finite())
            })
            || dcaptures
                .iter()
                .chain([&dt, &dmn_decay])
                .any(|x| !x.is_finite())
            || dwater
                .iter()
                .any(|d| !d.temperature_k.is_finite() || !d.density_kg_m3.is_finite())
        {
            return Err("Invalid barrel direction/preparation");
        }
        let photon = dcaptures
            .iter()
            .zip(self.input.capture_photon_j)
            .map(|(c, q)| c * q)
            .sum::<f64>()
            + dmn_decay * self.input.mn_photon_j;
        let charged = dmn_decay * self.input.mn_electron_j;
        w.emitted_tangent = photon + charged;
        w.nuclear_heat_tangent = charged + photon * self.self_absorption;
        w.heat_tangent = w.nuclear_heat_tangent;
        w.export_tangent = 0.;
        w.water_tangent.fill(0.);
        w.water_photon_tangent.fill(0.);
        for (j, c) in self.input.contacts.iter().enumerate() {
            let d = dwater[c.water];
            let base = w.photon * self.self_transmission * self.weights[j];
            let direction = photon * self.self_transmission * self.weights[j];
            let mut da =
                w.transmission[j] * self.input.liquid_mu_en_m2_kg * w.chords[j] * d.density_kg_m3;
            if let Some(chords) = chords {
                // Keep the held-input derivative's original multiplication
                // order; the independent current-path contribution is additive.
                da += w.transmission[j]
                    * self.input.liquid_mu_en_m2_kg
                    * w.contact_density[j]
                    * chords[j];
            }
            let q = c.area_m2 * self.input.wet_h_w_m2_k * (dt - d.temperature_k);
            w.water_photon_tangent[c.water] = direction * w.absorption[j] + base * da;
            w.heat_tangent -= q;
            w.water_tangent[c.water] += q + w.water_photon_tangent[c.water];
            w.export_tangent += direction * w.transmission[j] - base * da;
        }
        if [w.heat_tangent, w.emitted_tangent, w.export_tangent]
            .iter()
            .chain(&w.water_tangent)
            .any(|x| !x.is_finite())
        {
            return Err("Unrepresentable barrel heat direction");
        }
        w.direction_valid = true;
        Ok(())
    }
}

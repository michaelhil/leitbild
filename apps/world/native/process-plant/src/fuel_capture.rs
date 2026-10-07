//! Paid fertile/Xe/Sm prompt binding photons into existing cold fuel, clad and
//! primary recipients. No fission/E25 rebilling, gamma transport or new solid.
pub use crate::fuel_history::CapturePowerResponse as PowerResponse;
use crate::{fuel_thermal as ft, source_evolution as se};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct Band {
    pub thermal_band: usize,
    pub water: usize,
    pub water_chord_m: f64,
    pub clad_thickness_m: [f64; 3],
}
#[derive(Clone, Debug)]
pub struct Input {
    pub capture_j: [f64; 3],
    pub fuel_chord_m: f64,
    pub fuel_density: f64,
    pub fuel_mu: f64,
    pub clad_density: f64,
    pub clad_mu: f64,
    pub water_mu: f64,
    pub bands: Vec<Band>,
}
struct CompiledBand {
    input: Band,
    clad_rows: [usize; 3],
    clad_shares: [f64; 3],
    beyond_clad: f64,
}
pub struct Model {
    input: Input,
    bands: Vec<CompiledBand>,
    fuel_self: f64,
    fuel_incidence: Vec<Vec<(usize, f64)>>,
    band_incidence: Vec<Vec<(usize, f64)>>,
    thermal_nodes: usize,
    fuel_nodes: usize,
    waters: usize,
    owner: Arc<()>,
    source_owner: Arc<()>,
}
pub struct Workspace {
    fuel: Vec<f64>,
    clad: Vec<f64>,
    water: Vec<f64>,
    channels: Vec<f64>,
    dfuel: Vec<f64>,
    dclad: Vec<f64>,
    dwater: Vec<f64>,
    dchannels: Vec<f64>,
    absorption: Vec<[f64; 2]>, // value and derivative with respect to current rho
    emission: Vec<f64>,
    demission: Vec<f64>,
    owner: Arc<()>,
    valid: bool,
    direction_valid: bool,
}
fn absorption(rho: f64, mu: f64, chord: f64) -> Result<f64, String> {
    let tau = rho * mu * chord;
    if !tau.is_finite() || tau <= 0. {
        return Err("Unrepresentable positive fuel-capture optical depth".into());
    }
    Ok(-(-tau).exp_m1())
}
impl Model {
    pub fn new(
        source: &se::Evolution,
        thermal: &ft::Model,
        fuel_rows: &[usize],
        input: Input,
    ) -> Result<Self, String> {
        if input
            .capture_j
            .iter()
            .chain([
                &input.fuel_chord_m,
                &input.fuel_density,
                &input.fuel_mu,
                &input.clad_density,
                &input.clad_mu,
                &input.water_mu,
            ])
            .any(|v| !v.is_finite() || *v <= 0.)
            || input.bands.len() != thermal.band_count()
            || fuel_rows.len() != source.fuel_history().fuel().cohorts().len()
            || fuel_rows.len() != thermal.fuel_node_count()
            || fuel_rows
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != fuel_rows.len()
        {
            return Err("Invalid complete fuel-capture partition".into());
        }
        let fuel_self = absorption(input.fuel_density, input.fuel_mu, input.fuel_chord_m)?;
        let mut bands = Vec::new();
        for (i, b) in input.bands.iter().enumerate() {
            let rows = thermal.clad_rows(i).collect::<Vec<_>>();
            if b.thermal_band != i
                || b.water != thermal.band_water(i)
                || rows.len() != 3
                || !b.water_chord_m.is_finite()
                || b.water_chord_m <= 0.
                || b.clad_thickness_m
                    .iter()
                    .any(|v| !v.is_finite() || *v <= 0.)
            {
                return Err("Fuel-capture band/recipient identity mismatch".into());
            }
            if b.clad_thickness_m
                .iter()
                .zip(thermal.clad_thicknesses(i))
                .any(|(&a, b)| (a - b).abs() > 64. * f64::EPSILON * b.abs())
            {
                return Err("Fuel-capture clad geometry mismatch".into());
            }
            let mut remainder = 1. - fuel_self;
            let mut clad_shares = [0.; 3];
            for (s, &thickness) in clad_shares.iter_mut().zip(&b.clad_thickness_m) {
                let a = absorption(input.clad_density, input.clad_mu, thickness)?;
                *s = remainder * a;
                remainder *= 1. - a;
            }
            bands.push(CompiledBand {
                input: b.clone(),
                clad_rows: rows.try_into().unwrap(),
                clad_shares,
                beyond_clad: remainder,
            });
        }
        let mut cohort_band = vec![usize::MAX; fuel_rows.len()];
        for (q, &row) in fuel_rows.iter().enumerate() {
            for b in 0..thermal.band_count() {
                if thermal.fuel_rows(b).contains(&row) {
                    cohort_band[q] = b;
                    break;
                }
            }
            if cohort_band[q] == usize::MAX {
                return Err("Missing actual fuel-capture thermal recipient".into());
            }
        }
        let fuel = source.fuel_history().fuel();
        let mut fuel_incidence = vec![Vec::new(); fuel.intersections().len()];
        let mut band_incidence = vec![Vec::new(); fuel.intersections().len()];
        fuel.visit_heat_incidence(|q, i, w| {
            if let Some(i) = i {
                fuel_incidence[i].push((q, w));
                let b = cohort_band[q];
                if let Some((_, share)) = band_incidence[i].iter_mut().find(|(j, _)| *j == b) {
                    *share += w;
                } else {
                    band_incidence[i].push((b, w));
                }
            }
        });
        Ok(Self {
            thermal_nodes: thermal.node_count(),
            fuel_nodes: fuel_rows.len(),
            waters: thermal.water_count(),
            input,
            bands,
            fuel_self,
            fuel_incidence,
            band_incidence,
            owner: Arc::new(()),
            source_owner: source.owner_token(),
        })
    }
    pub fn config(&self) -> &Input {
        &self.input
    }
    pub fn power_response(&self, source: &se::Evolution) -> Result<PowerResponse, String> {
        if !Arc::ptr_eq(&self.source_owner, &source.owner_token()) {
            return Err("Foreign fuel-capture source owner".into());
        }
        source
            .fuel_history()
            .capture_power_response(self.input.capture_j)
    }
    pub fn workspace(&self) -> Workspace {
        Workspace {
            fuel: vec![0.; self.fuel_nodes],
            clad: vec![0.; self.thermal_nodes],
            water: vec![0.; self.waters],
            channels: vec![0.; 5 * self.fuel_incidence.len()],
            dfuel: vec![0.; self.fuel_nodes],
            dclad: vec![0.; self.thermal_nodes],
            dwater: vec![0.; self.waters],
            dchannels: vec![0.; 5 * self.fuel_incidence.len()],
            absorption: vec![[0.; 2]; self.bands.len()],
            emission: vec![0.; self.fuel_incidence.len()],
            demission: vec![0.; self.fuel_incidence.len()],
            owner: self.owner.clone(),
            valid: false,
            direction_valid: false,
        }
    }
    pub fn evaluate(
        &self,
        events: &[[f64; 3]],
        densities: &[f64],
        w: &mut Workspace,
    ) -> Result<(), String> {
        w.valid = false;
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || events.len() != self.fuel_incidence.len()
            || densities.len() != self.waters
            || events.iter().flatten().any(|v| !v.is_finite())
            || densities.iter().any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("Invalid current fuel-capture partition trial".into());
        }
        for (b, a) in self.bands.iter().zip(&mut w.absorption) {
            let mu_l = self.input.water_mu * b.input.water_chord_m;
            a[0] = absorption(
                densities[b.input.water],
                self.input.water_mu,
                b.input.water_chord_m,
            )?;
            a[1] = mu_l * (-densities[b.input.water] * mu_l).exp();
        }
        for (p, e) in w.emission.iter_mut().zip(events) {
            *p = e.iter().zip(self.input.capture_j).map(|(r, q)| r * q).sum();
        }
        self.partition(
            &w.emission,
            None,
            &w.absorption,
            &mut w.fuel,
            &mut w.clad,
            &mut w.water,
            &mut w.channels,
        )?;
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        devents: &[[f64; 3]],
        ddensities: &[f64],
        w: &mut Workspace,
    ) -> Result<(), String> {
        w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || !w.valid
            || devents.len() != self.fuel_incidence.len()
            || ddensities.len() != self.waters
            || devents
                .iter()
                .flatten()
                .chain(ddensities)
                .any(|v| !v.is_finite())
        {
            return Err("No matching current fuel-capture direction".into());
        }
        // Directional emitted power shares the same owned event-Q contraction.
        for (p, e) in w.demission.iter_mut().zip(devents) {
            *p = e.iter().zip(self.input.capture_j).map(|(r, q)| r * q).sum();
        }
        self.partition(
            &w.demission,
            Some((&w.emission, ddensities)),
            &w.absorption,
            &mut w.dfuel,
            &mut w.dclad,
            &mut w.dwater,
            &mut w.dchannels,
        )?;
        w.direction_valid = true;
        Ok(())
    }
    fn partition(
        &self,
        powers: &[f64],
        direction: Option<(&[f64], &[f64])>,
        a: &[[f64; 2]],
        fuel: &mut [f64],
        clad: &mut [f64],
        water: &mut [f64],
        channels: &mut [f64],
    ) -> Result<(), String> {
        fuel.fill(0.);
        clad.fill(0.);
        water.fill(0.);
        channels.fill(0.);
        for (i, &p) in powers.iter().enumerate() {
            channels[5 * i] = p;
            channels[5 * i + 1] = p * self.fuel_self;
            for &(q, s) in &self.fuel_incidence[i] {
                fuel[q] += p * self.fuel_self * s;
            }
            for &(b, s) in &self.band_incidence[i] {
                let band = &self.bands[b];
                for (&r, &f) in band.clad_rows.iter().zip(&band.clad_shares) {
                    let q = p * s * f;
                    clad[r] += q;
                    channels[5 * i + 2] += q;
                }
                let density_term =
                    direction.map_or(0., |(base, dd)| base[i] * a[b][1] * dd[band.input.water]);
                let q = s * band.beyond_clad * (p * a[b][0] + density_term);
                let x = s * band.beyond_clad * (p * (1. - a[b][0]) - density_term);
                water[band.input.water] += q;
                channels[5 * i + 3] += q;
                channels[5 * i + 4] += x;
            }
        }
        if fuel
            .iter()
            .chain(clad.iter())
            .chain(water.iter())
            .chain(channels.iter())
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite fuel-capture partition".into());
        }
        Ok(())
    }
}
impl Workspace {
    fn check(&self, direction: bool) -> Result<(), String> {
        if self.valid && (!direction || self.direction_valid) {
            Ok(())
        } else {
            Err("No current fuel-capture partition".into())
        }
    }
    pub fn fuel_heat(&self) -> Result<&[f64], String> {
        self.check(false)?;
        Ok(&self.fuel)
    }
    pub fn clad_heat(&self) -> Result<&[f64], String> {
        self.check(false)?;
        Ok(&self.clad)
    }
    pub fn water_heat(&self) -> Result<&[f64], String> {
        self.check(false)?;
        Ok(&self.water)
    }
    /// Per actual source/material intersection: emitted, self fuel, clad,
    /// actual recipient water, export. These exclude all sensible contact heat.
    pub fn power_channels(&self) -> Result<&[f64], String> {
        self.check(false)?;
        Ok(&self.channels)
    }
    pub fn emitted_rate(&self) -> Result<f64, String> {
        self.check(false)?;
        Ok(self.channels.chunks_exact(5).map(|q| q[0]).sum())
    }
    pub fn export_rate(&self) -> Result<f64, String> {
        self.check(false)?;
        Ok(self.channels.chunks_exact(5).map(|q| q[4]).sum())
    }
    pub fn fuel_heat_jvp(&self) -> Result<&[f64], String> {
        self.check(true)?;
        Ok(&self.dfuel)
    }
    pub fn clad_heat_jvp(&self) -> Result<&[f64], String> {
        self.check(true)?;
        Ok(&self.dclad)
    }
    pub fn water_heat_jvp(&self) -> Result<&[f64], String> {
        self.check(true)?;
        Ok(&self.dwater)
    }
    pub fn emitted_jvp(&self) -> Result<f64, String> {
        self.check(true)?;
        Ok(self.dchannels.chunks_exact(5).map(|q| q[0]).sum())
    }
    pub fn export_jvp(&self) -> Result<f64, String> {
        self.check(true)?;
        Ok(self.dchannels.chunks_exact(5).map(|q| q[4]).sum())
    }
}

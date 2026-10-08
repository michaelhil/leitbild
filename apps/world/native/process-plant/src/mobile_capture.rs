//! Birth-site primary H/B binding heat. Physical liquid origins retain local
//! capture incidence, while photons leaving them use a fixed diffuse physical
//! wall map, independent of the neutron partition. Uninstalled wall duty exits
//! the represented thermal domain; it is NOT claimed free-space escape.
use crate::{fuel_thermal, moderator_source::Events, source_evolution};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recipient {
    Clad(usize),
    Barrel,
    Host(usize),
}
#[derive(Clone, Debug)]
pub struct Wall {
    pub recipient: Recipient,
    pub thickness_m: f64,
    pub density_kg_m3: f64,
    pub mu: [f64; 2], // 0.5/1MeV energy absorption m²/kg
}
#[derive(Clone, Debug)]
pub struct Path {
    pub share: f64,
    pub stages: Vec<Wall>,
}
#[derive(Clone, Debug)]
pub struct WallOrigin {
    pub unrepresented_wall_share: f64,
    pub paths: Vec<Path>,
}
#[derive(Clone, Copy, Debug)]
pub struct Route {
    pub region: usize,
    pub water: usize,
    pub birth_share: f64,
    pub liquid_chord_m: f64,
    pub wall_origin: usize,
}
#[derive(Clone, Debug)]
pub struct Input {
    pub water_mu: [f64; 2],
    pub wall_origins: Vec<WallOrigin>,
    pub routes: Vec<Route>,
}
struct CompiledPath {
    fractions: Vec<[f64; 2]>,
}
struct CompiledWallOrigin {
    input: WallOrigin,
    paths: Vec<CompiledPath>,
    wall_share: [f64; 2],
    escape_share: [f64; 2],
}
struct CompiledRoute {
    input: Route,
    event: usize,
}
pub struct Model {
    wall_origins: Vec<CompiledWallOrigin>,
    routes: Vec<CompiledRoute>,
    emission: [[f64; 2]; 2], // species H/B, charged/photon
    water_mu: [f64; 2],
    waters: usize,
    clad_nodes: usize,
    hosts: usize,
    event_count: usize,
    source_owner: Arc<()>,
    owner: Arc<()>,
}
#[derive(Default)]
pub struct Delivery {
    pub water: Vec<f64>,
    pub clad: Vec<f64>,
    pub barrel: f64,
    pub host: Vec<f64>,
    pub exported: f64,
    pub boundary_exported: f64,
    /// Per birth then H/B: emitted, charged, liquid photon, installed wall,
    /// beyond-installed-wall export, unrepresented-wall boundary export.
    pub channels: Vec<f64>,
}
pub struct Workspace {
    value: Delivery,
    direction: Delivery,
    events: Vec<Events>,
    absorption: Vec<[[f64; 2]; 2]>, // birth route, H/B, value/density partial
    outgoing: Vec<[f64; 2]>,
    owner: Arc<()>,
    valid: bool,
    direction_valid: bool,
}
impl Delivery {
    /// Existing finite recipient order: native waters, thermal nodes (only
    /// actual clad entries can be nonzero), then the finite barrel.
    pub fn recipient_power(&self) -> impl Iterator<Item = f64> + '_ {
        self.water
            .iter()
            .chain(&self.clad)
            .copied()
            .chain([self.barrel])
            .chain(self.host.iter().copied())
    }
}
fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.
}
fn unit(v: f64) -> bool {
    v.is_finite() && (0. ..=1.).contains(&v)
}
fn optical(rho: f64, mu: f64, length: f64) -> Result<[f64; 2], String> {
    let coefficient = mu * length;
    let tau = rho * coefficient;
    if !positive(tau) || !positive(coefficient) {
        return Err("Unrepresentable mobile-capture optical path".into());
    }
    Ok([-(-tau).exp_m1(), coefficient * (-tau).exp()])
}
impl Model {
    pub fn new(
        source: &source_evolution::Evolution,
        thermal: &fuel_thermal::Model,
        waters: usize,
        hosts: usize,
        input: Input,
    ) -> Result<Self, String> {
        if waters != source.external_water_count() || input.water_mu.iter().any(|&v| !positive(v)) {
            return Err("Invalid mobile-capture water/material owner".into());
        }
        let mut source_rows = BTreeMap::new();
        for (row, region, water) in source.external_water_birth_rows() {
            if source_rows.insert((region, water), (row, 0.)).is_some() {
                return Err("Ambiguous mobile-capture birth region/water".into());
            }
        }
        let clad = (0..thermal.band_count())
            .flat_map(|b| thermal.clad_rows(b))
            .collect::<Vec<_>>();
        let event_count = source
            .external_water_birth_rows()
            .map(|(r, _, _)| r + 1)
            .max()
            .unwrap_or(0);
        let mut origins = Vec::with_capacity(input.wall_origins.len());
        for origin in input.wall_origins {
            if !unit(origin.unrepresented_wall_share) {
                return Err("Invalid mobile-capture physical liquid origin".into());
            }
            let mut paths = Vec::with_capacity(origin.paths.len());
            let mut shares = origin.unrepresented_wall_share;
            let mut wall_share = [0.; 2];
            let mut escape_share = [0.; 2];
            for p in &origin.paths {
                if !positive(p.share) || p.share > 1. || p.stages.is_empty() {
                    return Err("Invalid actual mobile-capture wall path".into());
                }
                shares += p.share;
                let mut escaped = [1.; 2];
                let mut fractions = Vec::with_capacity(p.stages.len());
                for w in &p.stages {
                    if !positive(w.thickness_m)
                        || !positive(w.density_kg_m3)
                        || w.mu.iter().any(|&v| !positive(v))
                        || matches!(w.recipient, Recipient::Clad(i) if !clad.contains(&i))
                        || matches!(w.recipient, Recipient::Host(i) if i>=hosts)
                    {
                        return Err("Invalid actual installed mobile-capture wall".into());
                    }
                    let absorption = [
                        optical(w.density_kg_m3, w.mu[0], w.thickness_m)?[0],
                        optical(w.density_kg_m3, w.mu[1], w.thickness_m)?[0],
                    ];
                    let fraction = std::array::from_fn(|k| escaped[k] * absorption[k]);
                    for k in 0..2 {
                        escaped[k] *= 1. - absorption[k];
                        wall_share[k] += p.share * fraction[k];
                    }
                    fractions.push(fraction);
                }
                for k in 0..2 {
                    escape_share[k] += p.share * escaped[k];
                }
                paths.push(CompiledPath { fractions });
            }
            if (shares - 1.).abs() > 128. * f64::EPSILON * (origin.paths.len() + 1) as f64 {
                return Err("Mobile-capture full physical wall boundary is not partitioned".into());
            }
            origins.push(CompiledWallOrigin {
                input: origin,
                paths,
                wall_share,
                escape_share,
            });
        }
        let mut used = vec![false; origins.len()];
        let mut births = Vec::with_capacity(input.routes.len());
        for b in input.routes {
            origins
                .get(b.wall_origin)
                .ok_or("Foreign mobile-capture physical origin")?;
            let (event, sum) = source_rows
                .get_mut(&(b.region, b.water))
                .ok_or("Mobile capture names an absent or closed source birth row")?;
            if b.water >= waters
                || !positive(b.liquid_chord_m)
                || !positive(b.birth_share)
                || b.birth_share > 1.
            {
                return Err("Invalid mobile-capture birth share".into());
            }
            *sum += b.birth_share;
            used[b.wall_origin] = true;
            births.push(CompiledRoute {
                input: b,
                event: *event,
            });
        }
        if used.iter().any(|used| !used)
            || source_rows
                .values()
                .any(|(_, sum)| (*sum - 1.).abs() > 2e-11)
        {
            return Err("Mobile-capture birth coverage incomplete or duplicated".into());
        }
        let emission = source.mobile_capture_emissions();
        if emission.iter().flatten().any(|v| !v.is_finite() || *v < 0.)
            || emission.iter().any(|q| q[0] + q[1] <= 0.)
        {
            return Err("Invalid owned mobile binding emission".into());
        }
        Ok(Self {
            wall_origins: origins,
            routes: births,
            emission,
            water_mu: input.water_mu,
            waters,
            clad_nodes: thermal.node_count(),
            hosts,
            event_count,
            source_owner: source.owner_token(),
            owner: Arc::new(()),
        })
    }
    pub fn paid_energy(&self) -> [f64; 2] {
        self.emission.map(|q| q[0] + q[1])
    }
    pub fn route_count(&self) -> usize {
        self.routes.len()
    }
    pub fn origin_count(&self) -> usize {
        self.wall_origins.len()
    }
    pub fn wall_origins(&self) -> impl Iterator<Item = &WallOrigin> {
        self.wall_origins.iter().map(|o| &o.input)
    }
    pub fn routes(&self) -> impl Iterator<Item = &Route> {
        self.routes.iter().map(|b| &b.input)
    }
    pub fn workspace(&self) -> Workspace {
        let delivery = || Delivery {
            water: vec![0.; self.waters],
            clad: vec![0.; self.clad_nodes],
            host: vec![0.; self.hosts],
            channels: vec![0.; 12 * self.routes.len()],
            ..Delivery::default()
        };
        Workspace {
            value: delivery(),
            direction: delivery(),
            events: vec![Events::default(); self.event_count],
            absorption: vec![[[0.; 2]; 2]; self.routes.len()],
            outgoing: vec![[0.; 2]; self.wall_origins.len()],
            owner: self.owner.clone(),
            valid: false,
            direction_valid: false,
        }
    }
    pub fn evaluate(
        &self,
        source: &source_evolution::Evolution,
        events: &[Events],
        densities: &[f64],
        work: &mut Workspace,
    ) -> Result<(), String> {
        work.valid = false;
        work.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || !Arc::ptr_eq(&self.source_owner, &source.owner_token())
            || events.len() < self.event_count
            || densities.len() != self.waters
            || densities.iter().any(|&v| !positive(v))
        {
            return Err("Foreign or invalid mobile-capture current stage".into());
        }
        work.events.copy_from_slice(&events[..self.event_count]);
        for (r, a) in self.routes.iter().zip(&mut work.absorption) {
            for species in 0..2 {
                a[species] = optical(
                    densities[r.input.water],
                    self.water_mu[1 - species],
                    r.input.liquid_chord_m,
                )?;
            }
        }
        self.partition(
            events,
            None,
            &work.absorption,
            &mut work.outgoing,
            &mut work.value,
        )?;
        work.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        events: &[Events],
        ddensity: &[f64],
        work: &mut Workspace,
    ) -> Result<(), String> {
        work.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &work.owner)
            || !work.valid
            || events.len() < self.event_count
            || ddensity.len() != self.waters
            || ddensity.iter().any(|v| !v.is_finite())
        {
            return Err("No matching mobile-capture direction".into());
        }
        self.partition(
            events,
            Some((&work.events, ddensity)),
            &work.absorption,
            &mut work.outgoing,
            &mut work.direction,
        )?;
        work.direction_valid = true;
        Ok(())
    }
    fn partition(
        &self,
        events: &[Events],
        direction: Option<(&[Events], &[f64])>,
        absorption: &[[[f64; 2]; 2]],
        outgoing: &mut [[f64; 2]],
        out: &mut Delivery,
    ) -> Result<(), String> {
        out.water.fill(0.);
        out.clad.fill(0.);
        out.channels.fill(0.);
        outgoing.fill([0.; 2]);
        out.barrel = 0.;
        out.host.fill(0.);
        out.exported = 0.;
        out.boundary_exported = 0.;
        for (i, b) in self.routes.iter().enumerate() {
            let origin = &self.wall_origins[b.input.wall_origin];
            let o = &origin.input;
            for species in 0..2 {
                let count = |e: &Events| if species == 0 { e.hydrogen } else { e.boron };
                let event = count(&events[b.event]) * b.input.birth_share;
                let charged = event * self.emission[species][0];
                let photon = event * self.emission[species][1];
                let a = absorption[i][species];
                let da = direction.map_or(0., |(base, drho)| {
                    count(&base[b.event])
                        * b.input.birth_share
                        * self.emission[species][1]
                        * a[1]
                        * drho[b.input.water]
                });
                let liquid = photon * a[0] + da;
                let remainder = photon * (1. - a[0]) - da;
                outgoing[b.input.wall_origin][species] += remainder;
                let channel = &mut out.channels[12 * i + 6 * species..12 * i + 6 * species + 6];
                channel[0] = charged + photon;
                channel[1] = charged;
                channel[2] = liquid;
                channel[3] = remainder * origin.wall_share[1 - species];
                channel[4] = remainder * origin.escape_share[1 - species];
                channel[5] = remainder * o.unrepresented_wall_share;
                out.water[b.input.water] += charged + liquid;
                out.exported += channel[4];
                out.boundary_exported += channel[5];
            }
        }
        // Physical wall traversal is paid once per origin, never once per
        // neutron grid cell or duplicated across every possible wall.
        for (origin, power) in self.wall_origins.iter().zip(outgoing.iter()) {
            for (path, prepared) in origin.input.paths.iter().zip(&origin.paths) {
                for (wall, fraction) in path.stages.iter().zip(&prepared.fractions) {
                    let heat =
                        power[0] * path.share * fraction[1] + power[1] * path.share * fraction[0];
                    match wall.recipient {
                        Recipient::Clad(n) => out.clad[n] += heat,
                        Recipient::Barrel => out.barrel += heat,
                        Recipient::Host(n) => out.host[n] += heat,
                    }
                }
            }
        }
        if out
            .water
            .iter()
            .chain(&out.clad)
            .chain(&out.host)
            .chain(&out.channels)
            .chain([&out.barrel, &out.exported, &out.boundary_exported])
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite mobile-capture delivery".into());
        }
        Ok(())
    }
}
impl Workspace {
    pub fn value(&self) -> Result<&Delivery, String> {
        if self.valid {
            Ok(&self.value)
        } else {
            Err("No current mobile-capture delivery".into())
        }
    }
    pub fn direction(&self) -> Result<&Delivery, String> {
        if self.valid && self.direction_valid {
            Ok(&self.direction)
        } else {
            Err("No current mobile-capture direction".into())
        }
    }
}

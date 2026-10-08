//! Birth-site primary H/B binding heat. Physical liquid origins retain local
//! capture incidence, while photons leaving them use a diffuse physical
//! wall map, independent of the neutron partition. Uninstalled wall duty exits
//! the represented thermal domain; it is NOT claimed free-space escape.
use crate::{moderator_source::Events, source_evolution};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recipient {
    Clad(usize),
    Barrel,
    Host(usize),
}
/// Immutable finite thermal layout. Only these rows can receive CLAD power;
/// the capture partition does not need or own a fuel thermal model.
#[derive(Clone, Debug)]
pub struct CladRecipients {
    pub node_count: usize,
    pub rows: Vec<usize>,
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
/// Current geometry in the model's immutable route/origin/path/wall order.
/// Paths and walls are flattened origin -> path -> serial wall. The same
/// shape carries a signed, selected-branch geometry direction. Material,
/// event, finite recipient and source identities never change here.
#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    pub birth_shares: Vec<f64>,
    pub liquid_chords_m: Vec<f64>,
    pub path_shares: Vec<f64>,
    pub wall_thicknesses_m: Vec<f64>,
    pub boundary_shares: Vec<f64>,
}
impl Geometry {
    fn from_input(input: &Input) -> Self {
        Self {
            birth_shares: input.routes.iter().map(|r| r.birth_share).collect(),
            liquid_chords_m: input.routes.iter().map(|r| r.liquid_chord_m).collect(),
            path_shares: input
                .wall_origins
                .iter()
                .flat_map(|o| &o.paths)
                .map(|p| p.share)
                .collect(),
            wall_thicknesses_m: input
                .wall_origins
                .iter()
                .flat_map(|o| &o.paths)
                .flat_map(|p| &p.stages)
                .map(|w| w.thickness_m)
                .collect(),
            boundary_shares: input
                .wall_origins
                .iter()
                .map(|o| o.unrepresented_wall_share)
                .collect(),
        }
    }
    pub fn zero_direction(&self) -> Self {
        Self {
            birth_shares: vec![0.; self.birth_shares.len()],
            liquid_chords_m: vec![0.; self.liquid_chords_m.len()],
            path_shares: vec![0.; self.path_shares.len()],
            wall_thicknesses_m: vec![0.; self.wall_thicknesses_m.len()],
            boundary_shares: vec![0.; self.boundary_shares.len()],
        }
    }
    fn same_shape(&self, other: &Self) -> bool {
        self.birth_shares.len() == other.birth_shares.len()
            && self.liquid_chords_m.len() == other.liquid_chords_m.len()
            && self.path_shares.len() == other.path_shares.len()
            && self.wall_thicknesses_m.len() == other.wall_thicknesses_m.len()
            && self.boundary_shares.len() == other.boundary_shares.len()
    }
    fn values(&self) -> impl Iterator<Item = f64> + '_ {
        self.birth_shares
            .iter()
            .chain(&self.liquid_chords_m)
            .chain(&self.path_shares)
            .chain(&self.wall_thicknesses_m)
            .chain(&self.boundary_shares)
            .copied()
    }
    fn copy_from(&mut self, other: &Self) {
        self.birth_shares.copy_from_slice(&other.birth_shares);
        self.liquid_chords_m.copy_from_slice(&other.liquid_chords_m);
        self.path_shares.copy_from_slice(&other.path_shares);
        self.wall_thicknesses_m
            .copy_from_slice(&other.wall_thicknesses_m);
        self.boundary_shares.copy_from_slice(&other.boundary_shares);
    }
}
struct CompiledRoute {
    input: Route,
    event: usize,
}
struct Direction<'a> {
    events: &'a [Events],
    ddensity: &'a [f64],
    geometry: Option<&'a Geometry>,
    outgoing: &'a [[f64; 2]],
    wall_fractions: &'a [[f64; 2]],
    wall_share: &'a [[f64; 2]],
    escape_share: &'a [[f64; 2]],
}
pub struct Model {
    wall_origins: Vec<WallOrigin>,
    routes: Vec<CompiledRoute>,
    emission: [[f64; 2]; 2], // species H/B, charged/photon
    water_mu: [f64; 2],
    waters: usize,
    clad_nodes: usize,
    hosts: usize,
    event_count: usize,
    route_groups: Vec<Vec<usize>>,
    source_owner: Arc<()>,
    owner: Arc<()>,
    geometry: Geometry,
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
    absorption: Vec<[[f64; 3]; 2]>, // birth route, H/B, value/density/chord partial
    outgoing: Vec<[f64; 2]>,
    direction_outgoing: Vec<[f64; 2]>,
    geometry: Geometry,
    wall_transmissions: Vec<[f64; 2]>,
    wall_absorption: Vec<[f64; 2]>,
    wall_fractions: Vec<[f64; 2]>,
    wall_fraction_direction: Vec<[f64; 2]>,
    origin_wall_share: Vec<[f64; 2]>,
    origin_escape_share: Vec<[f64; 2]>,
    origin_wall_direction: Vec<[f64; 2]>,
    origin_escape_direction: Vec<[f64; 2]>,
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
fn optical(rho: f64, mu: f64, length: f64) -> Result<[f64; 3], String> {
    let coefficient = mu * length;
    let tau = rho * coefficient;
    if !positive(rho)
        || !positive(mu)
        || !length.is_finite()
        || length < 0.
        || !tau.is_finite()
        || tau < 0.
    {
        return Err("Unrepresentable mobile-capture optical path".into());
    }
    let transmission = (-tau).exp();
    Ok([
        -(-tau).exp_m1(),
        coefficient * transmission,
        rho * mu * transmission,
    ])
}
impl Model {
    pub fn new(
        source: &source_evolution::Evolution,
        clad: CladRecipients,
        waters: usize,
        hosts: usize,
        input: Input,
    ) -> Result<Self, String> {
        let geometry = Geometry::from_input(&input);
        if waters != source.external_water_count() || input.water_mu.iter().any(|&v| !positive(v)) {
            return Err("Invalid mobile-capture water/material owner".into());
        }
        let mut source_rows = BTreeMap::new();
        for (row, region, water) in source.external_water_birth_rows() {
            if source_rows.insert((region, water), (row, 0.)).is_some() {
                return Err("Ambiguous mobile-capture birth region/water".into());
            }
        }
        let mut clad_rows = BTreeSet::new();
        if clad
            .rows
            .iter()
            .any(|&row| row >= clad.node_count || !clad_rows.insert(row))
        {
            return Err("Invalid mobile-capture finite CLAD recipient layout".into());
        }
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
            let mut shares = origin.unrepresented_wall_share;
            for p in &origin.paths {
                if !unit(p.share) || p.stages.is_empty() {
                    return Err("Invalid actual mobile-capture wall path".into());
                }
                shares += p.share;
                for w in &p.stages {
                    if !w.thickness_m.is_finite()
                        || w.thickness_m < 0.
                        || !positive(w.density_kg_m3)
                        || w.mu.iter().any(|&v| !positive(v))
                        || matches!(w.recipient, Recipient::Clad(i) if !clad_rows.contains(&i))
                        || matches!(w.recipient, Recipient::Host(i) if i>=hosts)
                    {
                        return Err("Invalid actual installed mobile-capture wall".into());
                    }
                    optical(w.density_kg_m3, w.mu[0], w.thickness_m)?;
                    optical(w.density_kg_m3, w.mu[1], w.thickness_m)?;
                }
            }
            if (shares - 1.).abs() > 128. * f64::EPSILON * (origin.paths.len() + 1) as f64 {
                return Err("Mobile-capture full physical wall boundary is not partitioned".into());
            }
            origins.push(origin);
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
                || !b.liquid_chord_m.is_finite()
                || b.liquid_chord_m < 0.
                || !unit(b.birth_share)
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
        let mut route_groups = BTreeMap::<usize, Vec<usize>>::new();
        for (i, r) in births.iter().enumerate() {
            route_groups.entry(r.event).or_default().push(i);
        }
        Ok(Self {
            wall_origins: origins,
            routes: births,
            emission,
            water_mu: input.water_mu,
            waters,
            clad_nodes: clad.node_count,
            hosts,
            event_count,
            route_groups: route_groups.into_values().collect(),
            source_owner: source.owner_token(),
            owner: Arc::new(()),
            geometry,
        })
    }
    pub fn paid_energy(&self) -> [f64; 2] {
        self.emission.map(|q| q[0] + q[1])
    }
    pub fn geometry(&self) -> &Geometry {
        &self.geometry
    }
    pub fn route_count(&self) -> usize {
        self.routes.len()
    }
    pub fn origin_count(&self) -> usize {
        self.wall_origins.len()
    }
    pub fn wall_origins(&self) -> impl Iterator<Item = &WallOrigin> {
        self.wall_origins.iter()
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
            absorption: vec![[[0.; 3]; 2]; self.routes.len()],
            outgoing: vec![[0.; 2]; self.wall_origins.len()],
            direction_outgoing: vec![[0.; 2]; self.wall_origins.len()],
            geometry: self.geometry.clone(),
            wall_transmissions: vec![[0.; 2]; self.geometry.wall_thicknesses_m.len()],
            wall_absorption: vec![[0.; 2]; self.geometry.wall_thicknesses_m.len()],
            wall_fractions: vec![[0.; 2]; self.geometry.wall_thicknesses_m.len()],
            wall_fraction_direction: vec![[0.; 2]; self.geometry.wall_thicknesses_m.len()],
            origin_wall_share: vec![[0.; 2]; self.wall_origins.len()],
            origin_escape_share: vec![[0.; 2]; self.wall_origins.len()],
            origin_wall_direction: vec![[0.; 2]; self.wall_origins.len()],
            origin_escape_direction: vec![[0.; 2]; self.wall_origins.len()],
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
        self.evaluate_with_geometry(source, events, densities, &self.geometry, work)
    }
    fn validate_geometry(&self, geometry: &Geometry, direction: bool) -> Result<(), String> {
        if !self.geometry.same_shape(geometry) || geometry.values().any(|v| !v.is_finite()) {
            return Err("Invalid mobile-capture geometry shape/value".into());
        }
        if !direction {
            for (name, values, share) in [
                ("birth_shares", &geometry.birth_shares, true),
                ("path_shares", &geometry.path_shares, true),
                ("boundary_shares", &geometry.boundary_shares, true),
                ("liquid_chords_m", &geometry.liquid_chords_m, false),
                ("wall_thicknesses_m", &geometry.wall_thicknesses_m, false),
            ] {
                if let Some((i, v)) = values
                    .iter()
                    .enumerate()
                    .find(|(_, v)| if share { !unit(**v) } else { **v < 0. })
                {
                    return Err(format!(
                        "Nonphysical current mobile-capture geometry {name}[{i}]={v:.17e}"
                    ));
                }
            }
        }
        let partition = |sum: f64, sumabs: f64, count: usize| {
            let expected = if direction { 0. } else { 1. };
            let scale = if direction { sumabs } else { count as f64 };
            (sum - expected).abs() <= 128. * f64::EPSILON * scale
        };
        for group in &self.route_groups {
            let sum = group.iter().map(|&i| geometry.birth_shares[i]).sum();
            let sumabs = group.iter().map(|&i| geometry.birth_shares[i].abs()).sum();
            if !partition(sum, sumabs, group.len()) {
                return Err("Current mobile-capture birth partition is incomplete".into());
            }
        }
        let mut path = 0;
        for (i, origin) in self.wall_origins.iter().enumerate() {
            let paths = &geometry.path_shares[path..path + origin.paths.len()];
            let sum = geometry.boundary_shares[i] + paths.iter().sum::<f64>();
            let sumabs =
                geometry.boundary_shares[i].abs() + paths.iter().map(|v| v.abs()).sum::<f64>();
            if !partition(sum, sumabs, paths.len() + 1) {
                return Err("Current mobile-capture physical boundary is not partitioned".into());
            }
            path += paths.len();
        }
        Ok(())
    }
    /// Prepare current wall traversal once per exact geometry. Source events
    /// and water density are not cache keys for these immutable material paths.
    fn prepare_geometry(
        &self,
        geometry: &Geometry,
        reuse: bool,
        work: &mut Workspace,
    ) -> Result<(), String> {
        self.validate_geometry(geometry, false)?;
        if reuse
            && work
                .geometry
                .values()
                .zip(geometry.values())
                .all(|(a, b)| a.to_bits() == b.to_bits())
        {
            return Ok(());
        }
        work.origin_wall_share.fill([0.; 2]);
        work.origin_escape_share.fill([0.; 2]);
        let (mut path_index, mut wall_index) = (0, 0);
        for (i, origin) in self.wall_origins.iter().enumerate() {
            for path in &origin.paths {
                let share = geometry.path_shares[path_index];
                let mut escaped = [1.; 2];
                for wall in &path.stages {
                    let thickness = geometry.wall_thicknesses_m[wall_index];
                    let unchanged = reuse
                        && thickness.to_bits()
                            == work.geometry.wall_thicknesses_m[wall_index].to_bits();
                    for k in 0..2 {
                        let tau = wall.density_kg_m3 * wall.mu[k] * thickness;
                        if !tau.is_finite() {
                            return Err("Unrepresentable current mobile-capture wall depth".into());
                        }
                        let transmission = if unchanged {
                            work.wall_transmissions[wall_index][k]
                        } else {
                            (-tau).exp()
                        };
                        let absorbed = if unchanged {
                            work.wall_absorption[wall_index][k]
                        } else {
                            -(-tau).exp_m1()
                        };
                        let fraction = escaped[k] * absorbed;
                        work.wall_transmissions[wall_index][k] = transmission;
                        work.wall_absorption[wall_index][k] = absorbed;
                        work.wall_fractions[wall_index][k] = fraction;
                        escaped[k] *= transmission;
                        work.origin_wall_share[i][k] += share * fraction;
                    }
                    wall_index += 1;
                }
                for k in 0..2 {
                    work.origin_escape_share[i][k] += share * escaped[k];
                }
                path_index += 1;
            }
        }
        work.geometry.copy_from(geometry);
        Ok(())
    }
    fn prepare_geometry_direction(
        &self,
        direction: Option<&Geometry>,
        work: &mut Workspace,
    ) -> Result<(), String> {
        work.wall_fraction_direction.fill([0.; 2]);
        work.origin_wall_direction.fill([0.; 2]);
        work.origin_escape_direction.fill([0.; 2]);
        let Some(direction) = direction else {
            return Ok(());
        };
        self.validate_geometry(direction, true)?;
        let (mut path_index, mut wall_index) = (0, 0);
        for (i, origin) in self.wall_origins.iter().enumerate() {
            for path in &origin.paths {
                let share = work.geometry.path_shares[path_index];
                let dshare = direction.path_shares[path_index];
                let (mut escaped, mut descaped) = ([1.; 2], [0.; 2]);
                for wall in &path.stages {
                    for k in 0..2 {
                        let transmission = work.wall_transmissions[wall_index][k];
                        let absorbed = work.wall_absorption[wall_index][k];
                        let dtransmission = -wall.density_kg_m3
                            * wall.mu[k]
                            * transmission
                            * direction.wall_thicknesses_m[wall_index];
                        let dfraction = descaped[k] * absorbed - escaped[k] * dtransmission;
                        work.wall_fraction_direction[wall_index][k] = dfraction;
                        work.origin_wall_direction[i][k] +=
                            dshare * work.wall_fractions[wall_index][k] + share * dfraction;
                        descaped[k] = descaped[k] * transmission + escaped[k] * dtransmission;
                        escaped[k] *= transmission;
                    }
                    wall_index += 1;
                }
                for k in 0..2 {
                    work.origin_escape_direction[i][k] += dshare * escaped[k] + share * descaped[k];
                }
                path_index += 1;
            }
        }
        Ok(())
    }
    pub fn evaluate_with_geometry(
        &self,
        source: &source_evolution::Evolution,
        events: &[Events],
        densities: &[f64],
        geometry: &Geometry,
        work: &mut Workspace,
    ) -> Result<(), String> {
        let reuse = work.valid;
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
        self.prepare_geometry(geometry, reuse, work)?;
        work.events.copy_from_slice(&events[..self.event_count]);
        for (i, (r, a)) in self.routes.iter().zip(&mut work.absorption).enumerate() {
            for species in 0..2 {
                a[species] = optical(
                    densities[r.input.water],
                    self.water_mu[1 - species],
                    geometry.liquid_chords_m[i],
                )?;
            }
        }
        self.partition(
            events,
            None,
            &work.geometry,
            &work.absorption,
            &work.wall_fractions,
            &work.origin_wall_share,
            &work.origin_escape_share,
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
        self.jvp_inner(events, ddensity, None, work)
    }
    pub fn jvp_with_geometry_direction(
        &self,
        events: &[Events],
        ddensity: &[f64],
        geometry: &Geometry,
        work: &mut Workspace,
    ) -> Result<(), String> {
        self.jvp_inner(events, ddensity, Some(geometry), work)
    }
    fn jvp_inner(
        &self,
        events: &[Events],
        ddensity: &[f64],
        geometry: Option<&Geometry>,
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
        self.prepare_geometry_direction(geometry, work)?;
        self.partition(
            events,
            Some(Direction {
                events: &work.events,
                ddensity,
                geometry,
                outgoing: &work.outgoing,
                wall_fractions: &work.wall_fraction_direction,
                wall_share: &work.origin_wall_direction,
                escape_share: &work.origin_escape_direction,
            }),
            &work.geometry,
            &work.absorption,
            &work.wall_fractions,
            &work.origin_wall_share,
            &work.origin_escape_share,
            &mut work.direction_outgoing,
            &mut work.direction,
        )?;
        work.direction_valid = true;
        Ok(())
    }
    fn partition(
        &self,
        events: &[Events],
        direction: Option<Direction<'_>>,
        geometry: &Geometry,
        absorption: &[[[f64; 3]; 2]],
        wall_fractions: &[[f64; 2]],
        wall_share: &[[f64; 2]],
        escape_share: &[[f64; 2]],
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
            let origin = b.input.wall_origin;
            for species in 0..2 {
                let count = |e: &Events| if species == 0 { e.hydrogen } else { e.boron };
                let share = geometry.birth_shares[i];
                let base_event = direction
                    .as_ref()
                    .map_or(0., |d| count(&d.events[b.event]) * share);
                let event = count(&events[b.event]) * share
                    + direction.as_ref().map_or(0., |d| {
                        count(&d.events[b.event]) * d.geometry.map_or(0., |g| g.birth_shares[i])
                    });
                let charged = event * self.emission[species][0];
                let photon = event * self.emission[species][1];
                let a = absorption[i][species];
                let da = direction.as_ref().map_or(0., |d| {
                    base_event
                        * self.emission[species][1]
                        * (a[1] * d.ddensity[b.input.water]
                            + a[2] * d.geometry.map_or(0., |g| g.liquid_chords_m[i]))
                });
                let liquid = photon * a[0] + da;
                let remainder = photon * (1. - a[0]) - da;
                let base_remainder = base_event * self.emission[species][1] * (1. - a[0]);
                outgoing[origin][species] += remainder;
                let channel = &mut out.channels[12 * i + 6 * species..12 * i + 6 * species + 6];
                channel[0] = charged + photon;
                channel[1] = charged;
                channel[2] = liquid;
                channel[3] = remainder * wall_share[origin][1 - species]
                    + direction
                        .as_ref()
                        .map_or(0., |d| base_remainder * d.wall_share[origin][1 - species]);
                channel[4] = remainder * escape_share[origin][1 - species]
                    + direction
                        .as_ref()
                        .map_or(0., |d| base_remainder * d.escape_share[origin][1 - species]);
                channel[5] = remainder * geometry.boundary_shares[origin]
                    + direction.as_ref().map_or(0., |d| {
                        base_remainder * d.geometry.map_or(0., |g| g.boundary_shares[origin])
                    });
                out.water[b.input.water] += charged + liquid;
                out.exported += channel[4];
                out.boundary_exported += channel[5];
            }
        }
        // Physical wall traversal is paid once per origin, never once per
        // neutron grid cell or duplicated across every possible wall.
        let (mut path_index, mut wall_index) = (0, 0);
        for (i, origin) in self.wall_origins.iter().enumerate() {
            let power = outgoing[i];
            for path in &origin.paths {
                let share = geometry.path_shares[path_index];
                for wall in &path.stages {
                    let fraction = wall_fractions[wall_index];
                    let mut heat = power[0] * share * fraction[1] + power[1] * share * fraction[0];
                    if let Some(d) = &direction {
                        let base = d.outgoing[i];
                        let dshare = d.geometry.map_or(0., |g| g.path_shares[path_index]);
                        let dfraction = d.wall_fractions[wall_index];
                        heat += base[0] * (dshare * fraction[1] + share * dfraction[1])
                            + base[1] * (dshare * fraction[0] + share * dfraction[0]);
                    }
                    match wall.recipient {
                        Recipient::Clad(n) => out.clad[n] += heat,
                        Recipient::Barrel => out.barrel += heat,
                        Recipient::Host(n) => out.host[n] += heat,
                    }
                    wall_index += 1;
                }
                path_index += 1;
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

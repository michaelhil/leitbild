//! Moving STEM/SPIDER ordinary-304 capture and retained Mn heat projection.
//!
//! Owns no material/history/temperature/time state: SOURCE owns the immutable
//! targets and direct Mn inventory; the existing finite apparatus heat stocks
//! receive `metal`. The selected bounded-cold sensible-contact cut is adiabatic.
//! Explicit optical self chords are reduced mean-member surrogates, not new
//! frame geometry, exact radiating surface, angular transport, or dose credit.
//! Escaped photons use the current physical primary-origin liquid envelope,
//! then export from this represented thermal domain (not necessarily space).
use crate::{barrel_thermal as bt, control_source_geometry as cg, source_evolution as se};
use std::{collections::{BTreeMap, BTreeSet}, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind { Spider, Stem }
#[derive(Clone, Debug)]
pub struct Host {
    pub cluster: usize,
    pub kind: Kind,
    /// Fe, Cr, Ni, Mn: these are existing SOURCE target indices.
    pub targets: [usize; 4],
    pub capture_photon_j: [f64; 4],
    pub mn_owner: usize,
    pub volume_m3: f64,
    pub self_chord_m: f64,
}
#[derive(Clone, Debug)]
pub struct Route {
    pub host: usize,
    pub source_region: usize,
    pub water: usize,
    pub origin: usize,
    /// Stationary intersection of SOURCE region and physical primary origin.
    pub lo: f64,
    pub hi: f64,
    /// Actual rigid material spans, shifted by this host's own achieved pose.
    pub spans: Vec<cg::Span>,
}
#[derive(Clone, Debug)]
pub struct Input {
    pub density_steel: f64,
    pub mu_steel_1: f64,
    pub mu_water_1: f64,
    pub hosts: Vec<Host>,
    pub routes: Vec<Route>,
}
#[derive(Clone, Debug)]
pub struct Delivery {
    pub metal: Vec<f64>,
    pub water: Vec<f64>,
    pub exported: f64,
    pub emitted: f64,
    /// Prompt ordinary capture, retained Mn decay.
    pub family_emitted: [f64; 2],
    pub charged_metal: f64,
    pub photon_metal: f64,
    /// Per fixed physical route: prompt [emitted,metal,water,export], followed
    /// by Mn [emitted,metal,water,export]. Kept separate even when decay power
    /// is far below the prompt aggregate's floating-point resolution.
    pub channels: Vec<[f64; 8]>,
}
impl Delivery {
    fn new(n: usize, nw: usize, nr: usize) -> Self {
        Self { metal: vec![0.; n], water: vec![0.; nw], exported: 0., emitted: 0.,
            family_emitted: [0.; 2], charged_metal: 0., photon_metal: 0., channels: vec![[0.; 8]; nr] }
    }
    fn clear(&mut self) {
        self.metal.fill(0.); self.water.fill(0.); self.exported = 0.; self.emitted = 0.;
        self.family_emitted = [0.; 2]; self.charged_metal = 0.; self.photon_metal = 0.;
        self.channels.fill([0.; 8]);
    }
    pub fn metal_total(&self) -> f64 { self.metal.iter().sum() }
    fn finite(&self) -> bool {
        self.metal.iter().chain(&self.water).chain([
            &self.exported, &self.emitted, &self.charged_metal, &self.photon_metal,
        ]).chain(&self.family_emitted).chain(self.channels.iter().flatten()).all(|x| x.is_finite())
    }
}
struct Group { incidence: usize, routes: Vec<usize> }
pub struct Model {
    input: Input,
    births: Vec<[usize; 4]>,
    groups: Vec<Group>,
    mn_rows: Vec<usize>,
    mn_products: Vec<usize>,
    mn_law: Vec<se::MnTarget>,
    self_transmission: Vec<f64>,
    paid: Vec<(usize, f64)>,
    source_dimension: usize,
    water_count: usize,
    source_owner: Arc<()>,
    geometry_owner: Arc<()>,
    maximum_body: f64,
    minimum_stem: f64,
    maximum_stem: f64,
    owner: Arc<()>,
}
pub struct Workspace {
    value: Delivery,
    direction: Delivery,
    volumes: Vec<f64>,
    partials: Vec<f64>,
    chords: Vec<f64>,
    transmission: Vec<f64>,
    photons: Vec<[f64; 2]>,
    source_state: Vec<f64>,
    source_volumes: Vec<f64>,
    poses: Vec<cg::Pose>,
    water: Vec<bt::Water>,
    host_volumes: Vec<f64>,
    host_direction: Vec<[f64; 2]>,
    owner: Arc<()>,
    valid: bool,
    direction_valid: bool,
}
impl Workspace {
    pub fn value(&self) -> Result<&Delivery, &'static str> {
        if !self.valid { return Err("Unprepared moving-steel heat"); }
        Ok(&self.value)
    }
    pub fn direction(&self) -> Result<&Delivery, &'static str> {
        if !self.valid || !self.direction_valid { return Err("Unprepared moving-steel heat direction"); }
        Ok(&self.direction)
    }
}
fn pos(x: f64) -> bool { x.is_finite() && x > 0. }
fn nn(x: f64) -> bool { x.is_finite() && x >= 0. }
fn same_volume(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && (a-b).abs() <= 3e-11 * a.abs().max(b.abs())
}
impl Model {
    pub fn new(source: &se::Evolution, geometry: &cg::Prepared, water_count: usize, input: Input) -> Result<Self, String> {
        if water_count == 0 || input.hosts.is_empty() || input.routes.is_empty()
            || ![input.density_steel, input.mu_steel_1, input.mu_water_1].into_iter().all(pos)
        { return Err("Invalid moving-steel heat input".into()); }
        let plan = geometry.input();
        if plan.water.len() != water_count { return Err("Moving-steel physical water layout differs".into()); }
        let mut targets = BTreeSet::new();
        let mut identities = BTreeSet::new();
        let mut mn_rows = Vec::new();
        let mut mn_products = Vec::new();
        let mut mn_law = Vec::new();
        let mut paid = BTreeMap::<usize, f64>::new();
        for h in &input.hosts {
            if h.cluster >= plan.clusters || !identities.insert((h.cluster, h.kind)) || !pos(h.volume_m3) || !pos(h.self_chord_m)
                || h.capture_photon_j.iter().any(|q| !pos(*q))
                || h.targets.iter().any(|t| *t >= source.target_count() || !targets.insert(*t))
            { return Err("Invalid or duplicate moving-steel material host".into()); }
            let mn = *source.mn_targets().get(h.mn_owner).ok_or("Foreign moving-steel Mn owner")?;
            if mn.target != h.targets[3] { return Err("Moving-steel Mn target differs from host".into()); }
            for (&t, &q) in h.targets.iter().zip(&h.capture_photon_j) {
                *paid.entry(source.target_row(t)).or_default() += q;
            }
            // Mn target is direct Mn56, not cumulative captures: its final Fe
            // row carries both already-paid capture and subsequently released decay.
            *paid.entry(source.mn_product_row(h.mn_owner)).or_default() +=
                h.capture_photon_j[3] + mn.electron_j + mn.photon_j;
            mn_rows.push(source.target_row(mn.target));
            mn_products.push(source.mn_product_row(h.mn_owner));
            mn_law.push(mn);
        }
        let mut lookup = BTreeMap::new();
        for (birth, target, region, incidence) in source.passive_birth_geometry_rows() {
            if targets.contains(&target) && lookup.insert((target, region), (birth, incidence)).is_some() {
                return Err("Ambiguous moving-steel SOURCE incidence".into());
            }
        }
        let mut keys = BTreeSet::new();
        let mut covered = BTreeSet::new();
        let mut groups = BTreeMap::<(usize, usize), Group>::new();
        let mut births = Vec::new();
        for (i, r) in input.routes.iter().enumerate() {
            let h = input.hosts.get(r.host).ok_or("Foreign moving-steel route host")?;
            if r.water >= water_count || !r.lo.is_finite() || !r.hi.is_finite() || r.hi <= r.lo
                || r.spans.is_empty() || r.spans.iter().any(|s| {
                    !s.lo.is_finite() || !s.hi.is_finite() || s.hi <= s.lo || !pos(s.area)
                }) || !keys.insert((r.host, r.source_region, r.origin))
            { return Err("Invalid moving-steel physical route".into()); }
            let origin = plan.origins.get(r.origin).ok_or("Foreign moving-steel physical origin")?;
            let expected_water = match origin.kind {
                cg::OriginKind::Upper | cg::OriginKind::Housing { .. } => plan.upper,
                cg::OriginKind::Guide(k) => plan.guides[k],
                _ => {
                    let mut water = None;
                    for route in plan.routes.iter().filter(|p| p.origin == r.origin) {
                        let w = plan.row_water[route.row];
                        if water.is_some_and(|a| a != w) { return Err("Ambiguous moving-steel physical liquid recipient".into()); }
                        water = Some(w);
                    }
                    water.ok_or("Moving-steel origin lacks an owned physical liquid recipient")?
                }
            };
            if r.water != expected_water { return Err("Moving-steel route uses another origin's water".into()); }
            let mut b = [0; 4];
            let mut incidence = None;
            for (k, &t) in h.targets.iter().enumerate() {
                let &(j, row) = lookup.get(&(t, r.source_region)).ok_or("Moving-steel route lacks SOURCE birth")?;
                if incidence.is_some_and(|a| a != row) { return Err("Moving-steel targets have different incidence".into()); }
                incidence = Some(row); b[k] = j; covered.insert((t, r.source_region));
            }
            let group = groups.entry((r.host, r.source_region)).or_insert_with(|| Group {
                incidence: incidence.unwrap(), routes: Vec::new(),
            });
            let moving = plan.passive.get(group.incidence).and_then(|p| p.moving.as_ref())
                .ok_or_else(|| format!("Moving-steel route {i} host {} {:?} cluster {} region {} origin {} incidence {} lacks its moving SOURCE geometry",
                    r.host, h.kind, h.cluster, r.source_region, r.origin, group.incidence))?;
            let same_motion = matches!((h.kind, moving.motion),
                (Kind::Spider, cg::Motion::Body) | (Kind::Stem, cg::Motion::Stem));
            if moving.cluster != h.cluster || !same_motion || r.lo < moving.lo || r.hi > moving.hi
            {
                return Err(format!("Moving-steel route {i} host {} {:?} cluster {} region {} origin {} incidence {} differs from its actual moving SOURCE support: cluster/motion/bounds, route=[{},{}], source=[{},{}], source_cluster={}, source_motion={:?}",
                    r.host, h.kind, h.cluster, r.source_region, r.origin, group.incidence,
                    r.lo, r.hi, moving.lo, moving.hi, moving.cluster, moving.motion));
            }
            // A SOURCE region can straddle two primary enclosures. The heat
            // route owns the entire ordered subset that can reach this actual
            // enclosure over the selected travel, not arbitrary contributors
            // and not pieces that only touch at an excluded outward endpoint.
            let maximum = match h.kind { Kind::Spider => plan.maximum_body, Kind::Stem => plan.maximum_stem };
            let minimum = match h.kind { Kind::Spider => 0., Kind::Stem => plan.minimum_stem };
            let reachable = || moving.spans.iter().filter(|s| s.hi + maximum > r.lo && s.lo + minimum < r.hi);
            let expected_count = reachable().count();
            if r.spans.len() != expected_count {
                return Err(format!("Moving-steel route {i} host {} {:?} cluster {} region {} origin {} incidence {} differs from its actual moving SOURCE support: reachable span count {} vs expected {expected_count}, route=[{},{}], maximum={maximum}",
                    r.host, h.kind, h.cluster, r.source_region, r.origin, group.incidence,
                    r.spans.len(), r.lo, r.hi));
            }
            for (span, (a, b)) in r.spans.iter().zip(reachable()).enumerate() {
                if a.lo.to_bits() != b.lo.to_bits() || a.hi.to_bits() != b.hi.to_bits() || a.area.to_bits() != b.area.to_bits() {
                    return Err(format!("Moving-steel route {i} host {} {:?} cluster {} region {} origin {} incidence {} differs from its actual moving SOURCE support: reachable span {span}, actual={a:?}, expected={b:?}",
                        r.host, h.kind, h.cluster, r.source_region, r.origin, group.incidence));
                }
            }
            group.routes.push(i);
            births.push(b);
        }
        if covered.len() != lookup.len() || input.hosts.iter().any(|h| h.targets.iter().any(|t| {
            !lookup.keys().any(|(a, _)| a == t)
        })) { return Err("Moving-steel routes omit SOURCE material support".into()); }
        let self_transmission = input.hosts.iter().map(|h| {
            (-input.density_steel * input.mu_steel_1 * h.self_chord_m).exp()
        }).collect();
        Ok(Self { input, births, groups: groups.into_values().collect(), mn_rows, mn_products,
            mn_law, self_transmission, paid: paid.into_iter().collect(), source_dimension: source.state_count(),
            water_count, source_owner: source.owner_token(), geometry_owner: geometry.owner_token(),
            maximum_body: plan.maximum_body, minimum_stem: plan.minimum_stem,
            maximum_stem: plan.maximum_stem, owner: Arc::new(()) })
    }
    pub fn config(&self) -> &Input { &self.input }
    pub fn host_count(&self) -> usize { self.input.hosts.len() }
    pub fn paid_rows(&self) -> impl Iterator<Item=(usize, f64)> + '_ { self.paid.iter().copied() }
    pub fn workspace(&self) -> Workspace {
        let n = self.input.routes.len();
        Workspace { value: Delivery::new(self.host_count(), self.water_count, n),
            direction: Delivery::new(self.host_count(), self.water_count, n), volumes: vec![0.; n],
            partials: vec![0.; n], chords: vec![0.; n], transmission: vec![0.; n], photons: vec![[0.; 2]; n],
            source_state: vec![0.; self.source_dimension], source_volumes: Vec::new(), poses: Vec::new(),
            water: vec![bt::Water { temperature_k: 0., density_kg_m3: 0., saturation_temperature_k: 0. }; self.water_count],
            host_volumes: vec![0.; self.host_count()], host_direction: vec![[0.; 2]; self.host_count()],
            owner: self.owner.clone(), valid: false, direction_valid: false }
    }
    pub fn evaluate(&self, source_y: &[f64], sw: &se::Workspace, poses: &[cg::Pose],
        geometry: &cg::Workspace, water: &[bt::Water], w: &mut Workspace) -> Result<(), String>
    {
        w.valid = false; w.direction_valid = false;
        if !Arc::ptr_eq(&self.owner, &w.owner) || !Arc::ptr_eq(&self.source_owner, sw.owner_token())
            || !Arc::ptr_eq(&self.geometry_owner, geometry.owner_token())
            || water.len() != self.water_count || source_y.len() != self.source_dimension
        { return Err("Invalid moving-steel heat workspace/source owner".into()); }
        sw.check_current_state(source_y)?;
        geometry.check_current_poses(poses)?;
        let density = sw.passive_birth_density()?;
        let source_volumes = sw.passive_volumes()?;
        w.host_volumes.fill(0.);
        for (i, r) in self.input.routes.iter().enumerate() {
            let h = &self.input.hosts[r.host];
            let p = poses.get(h.cluster).ok_or("Foreign moving-steel cluster pose")?;
            let (y, right) = match h.kind { Kind::Spider => (p.body, p.body_right), Kind::Stem => (p.stem, p.stem_right) };
            let maximum = match h.kind { Kind::Spider => self.maximum_body, Kind::Stem => self.maximum_stem };
            let minimum = match h.kind { Kind::Spider => 0., Kind::Stem => self.minimum_stem };
            if y == maximum && right { return Err("Moving-steel maximum travel requires its inward one-sided branch".into()); }
            if h.kind == Kind::Stem && minimum < 0. && y == minimum && !right {
                return Err("Moving-steel minimum travel requires its inward one-sided branch".into());
            }
            let mut v = 0.; let mut dv = 0.;
            for s in &r.spans { let a = cg::overlap(s.lo, s.hi, r.lo, r.hi, y, right);
                v += s.area * a[0]; dv += s.area * a[1]; }
            if !nn(v) || !dv.is_finite() { return Err("Invalid current moving-steel material volume".into()); }
            w.volumes[i] = v; w.partials[i] = dv; w.host_volumes[r.host] += v;
            w.chords[i] = geometry.origin_chord_m(r.origin)?;
            let liquid = water[r.water];
            if !pos(liquid.density_kg_m3) || !liquid.temperature_k.is_finite()
                || !liquid.saturation_temperature_k.is_finite() || liquid.temperature_k >= liquid.saturation_temperature_k
                || !pos(w.chords[i])
            { return Err("Moving-steel photon recipient left cold liquid scope".into()); }
            w.transmission[i] = (-liquid.density_kg_m3 * self.input.mu_water_1 * w.chords[i]).exp();
        }
        for (h, v) in self.input.hosts.iter().zip(&w.host_volumes) {
            if !same_volume(h.volume_m3, *v) { return Err("Current moving-steel routes do not cover whole rigid stock".into()); }
        }
        for g in &self.groups {
            let v = g.routes.iter().map(|i| w.volumes[*i]).sum();
            if !same_volume(v, source_volumes[g.incidence]) { return Err("Moving-steel heat and SOURCE material volumes differ".into()); }
        }
        w.value.clear();
        for (i, r) in self.input.routes.iter().enumerate() {
            let h = &self.input.hosts[r.host]; let law = self.mn_law[r.host];
            let prompt = (0..4).map(|k| density[self.births[i][k]] * w.volumes[i] * h.capture_photon_j[k]).sum::<f64>();
            let decay = law.decay_rate * source_y[self.mn_rows[r.host]] * w.volumes[i] / h.volume_m3;
            let charged = decay * law.electron_j;
            let photon = prompt + decay * law.photon_j;
            let tr = self.self_transmission[r.host]; let tl = w.transmission[i];
            w.photons[i] = [prompt, decay * law.photon_j];
            for (family, (c, p)) in [(0., prompt), (charged, decay * law.photon_j)].into_iter().enumerate() {
                w.value.channels[i][4 * family..4 * family + 4].copy_from_slice(&[
                    c + p, c + p * (1. - tr), p * tr * (1. - tl), p * tr * tl,
                ]);
            }
            w.value.metal[r.host] += charged + photon * (1. - tr);
            w.value.water[r.water] += photon * tr * (1. - tl);
            w.value.exported += photon * tr * tl;
            w.value.emitted += charged + photon;
            w.value.family_emitted[0] += prompt;
            w.value.family_emitted[1] += charged + decay * law.photon_j;
            w.value.charged_metal += charged; w.value.photon_metal += photon * (1. - tr);
        }
        if !w.value.finite() { return Err("Nonfinite moving-steel heat".into()); }
        w.source_state.copy_from_slice(source_y); w.source_volumes.clear(); w.source_volumes.extend_from_slice(source_volumes);
        w.poses.clear(); w.poses.extend_from_slice(poses); w.water.copy_from_slice(water);
        w.valid = true; Ok(())
    }
    pub fn jvp(&self, sw: &se::Workspace, pose_direction: &[cg::Direction], geometry: &cg::Workspace,
        water: &[bt::WaterDirection], w: &mut Workspace) -> Result<(), String>
    {
        w.direction_valid = false;
        if !w.valid || !Arc::ptr_eq(&self.owner, &w.owner) || !Arc::ptr_eq(&self.source_owner, sw.owner_token())
            || !Arc::ptr_eq(&self.geometry_owner, geometry.owner_token())
            || water.len() != self.water_count || water.iter().any(|d| !d.density_kg_m3.is_finite())
        { return Err("No current moving-steel heat linearization".into()); }
        sw.check_current_state(&w.source_state)?;
        geometry.check_current_poses(&w.poses)?; geometry.check_current_direction(pose_direction)?;
        if sw.passive_volumes()?.iter().zip(&w.source_volumes).any(|(a,b)| a.to_bits() != b.to_bits()) {
            return Err("Moving-steel SOURCE geometry changed after heat preparation".into());
        }
        let density = sw.passive_birth_density()?;
        let ddensity = sw.passive_birth_density_jvp()?;
        let source_dvolumes = sw.passive_volume_jvp()?;
        let source_rates = sw.rate_jvp()?;
        let dvolume = |i: usize| -> Result<f64, String> {
            let h = &self.input.hosts[self.input.routes[i].host];
            let p = pose_direction.get(h.cluster).ok_or("Foreign moving-steel pose direction")?;
            Ok(w.partials[i] * match h.kind { Kind::Spider => p.body, Kind::Stem => p.stem })
        };
        for g in &self.groups {
            let mut sum = 0.; let mut scale = 0.;
            for &i in &g.routes { let v = dvolume(i)?; sum += v; scale += v.abs(); }
            let expected = source_dvolumes[g.incidence]; scale += expected.abs();
            if !sum.is_finite() || (sum-expected).abs() > 3e-11 * scale {
                return Err("Moving-steel heat and SOURCE volume directions differ".into());
            }
        }
        w.host_direction.fill([0.; 2]);
        for (i, r) in self.input.routes.iter().enumerate() {
            let v = dvolume(i)?; w.host_direction[r.host][0] += v; w.host_direction[r.host][1] += v.abs();
        }
        if w.host_direction.iter().any(|v| !v[0].is_finite() || v[0].abs() > 3e-11*v[1]) {
            return Err("Moving-steel direction changes whole rigid stock volume".into());
        }
        w.direction.clear();
        for (i, r) in self.input.routes.iter().enumerate() {
            let h = &self.input.hosts[r.host]; let law = self.mn_law[r.host]; let dv = dvolume(i)?;
            let dprompt = (0..4).map(|k| (ddensity[self.births[i][k]] * w.volumes[i]
                + density[self.births[i][k]] * dv) * h.capture_photon_j[k]).sum::<f64>();
            // The sole SOURCE product-row derivative is lambda*dMn56. No
            // second history derivative or independent isotope clock is used.
            let ddecay = (source_rates[self.mn_products[r.host]] * w.volumes[i]
                + law.decay_rate * w.source_state[self.mn_rows[r.host]] * dv) / h.volume_m3;
            let charged = ddecay * law.electron_j; let photon = dprompt + ddecay * law.photon_j;
            let tr = self.self_transmission[r.host]; let tl = w.transmission[i];
            let dl = geometry.origin_chord_direction_m(r.origin)?;
            let dtl = -tl * self.input.mu_water_1 * (water[r.water].density_kg_m3 * w.chords[i]
                + w.water[r.water].density_kg_m3 * dl);
            for (family, (c, p)) in [(0., dprompt), (charged, ddecay * law.photon_j)].into_iter().enumerate() {
                w.direction.channels[i][4 * family..4 * family + 4].copy_from_slice(&[
                    c + p, c + p * (1. - tr), tr * (p * (1. - tl) - w.photons[i][family] * dtl),
                    tr * (p * tl + w.photons[i][family] * dtl),
                ]);
            }
            w.direction.metal[r.host] += charged + photon * (1. - tr);
            w.direction.water[r.water] += w.direction.channels[i][2] + w.direction.channels[i][6];
            w.direction.exported += w.direction.channels[i][3] + w.direction.channels[i][7];
            w.direction.emitted += charged + photon;
            w.direction.family_emitted[0] += dprompt;
            w.direction.family_emitted[1] += charged + ddecay * law.photon_j;
            w.direction.charged_metal += charged; w.direction.photon_metal += photon * (1. - tr);
        }
        if !w.direction.finite() { return Err("Nonfinite moving-steel heat direction".into()); }
        w.direction_valid = true; Ok(())
    }
}

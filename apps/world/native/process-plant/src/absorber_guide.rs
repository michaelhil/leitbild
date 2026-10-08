//! Fully wet BODY/guide thermal connection. Physical host
//! resolution is independent of neutron boxes: one composite BODY per cluster,
//! one radial guide mean per actual FA/cohort/axial span. This is not motion,
//! peak-temperature, dry-contact or gamma-transport qualification. Material
//! and recipient identities stay fixed; current contact geometry is an
//! explicit same-stage input, not a replacement material/history model.
use crate::{barrel_thermal as bt, fuel_thermal as ft, source_evolution as se};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Clone, Debug)]
pub struct Caloric {
    pub steel_cp0: f64,
    pub steel_cp1: f64,
    pub datum_k: f64,
    pub body_min_k: f64,
    pub body_max_k: f64,
    pub guide_min_k: f64,
    pub guide_max_k: f64,
    pub b4c_cp_points: Vec<[f64; 2]>,
}
#[derive(Clone, Copy, Debug)]
pub struct Host {
    pub b4c_mass_kg: f64,
    pub steel_mass_kg: f64,
    pub zr_mass_kg: f64,
    pub initial_k: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Contact {
    pub host: usize,
    pub water: usize,
    pub area_m2: f64,
    /// Rsolid=geometry/k: cylindrical radial half-wall or true-end axial half-span.
    pub solid_geometry_m_inv: f64,
    pub liquid_chord_m: f64,
}
/// Same fixed-union contact order as `Input::contacts`. Zero area is a
/// currently inactive physical contact, not permission to omit its recipient.
/// The same record carries a signed, selected-branch geometry direction.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContactGeometry {
    pub area_m2: f64,
    pub solid_geometry_m_inv: f64,
    pub liquid_chord_m: f64,
}
impl From<Contact> for ContactGeometry {
    fn from(c: Contact) -> Self {
        Self {
            area_m2: c.area_m2,
            solid_geometry_m_inv: c.solid_geometry_m_inv,
            liquid_chord_m: c.liquid_chord_m,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Axial {
    pub a: usize,
    pub b: usize,
    pub area_over_distance_m: f64,
}
#[derive(Clone, Debug)]
pub struct Body {
    pub host: usize,
    pub targets: [usize; 5],
    pub capture_j: [f64; 5],
    pub b_photon_j: f64,
    pub mn_owner: usize,
    pub b4c_chord_m: f64,
    pub steel_chord_m: f64,
    pub steel_shell_m: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct GuideBirth {
    pub target: usize,
    pub region: usize,
    pub host: usize,
    pub share: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Photons {
    pub density_b4c: f64,
    pub density_steel: f64,
    pub density_zr: f64,
    pub mu_b4c_05: f64,
    pub mu_steel_05: f64,
    pub mu_steel_1: f64,
    pub mu_zr_1: f64,
    pub mu_water_05: f64,
    pub mu_water_1: f64,
    pub guide_chord_m: f64,
    pub guide_capture_j: f64,
}
#[derive(Clone, Debug)]
pub struct Input {
    pub caloric: Caloric,
    pub wet_h: f64,
    pub photons: Photons,
    pub hosts: Vec<Host>,
    pub contacts: Vec<Contact>,
    pub axial: Vec<Axial>,
    pub bodies: Vec<Body>,
    pub guide_births: Vec<GuideBirth>,
}
#[derive(Clone, Copy)]
enum Birth {
    Target(usize),
    Passive(usize),
    Mn { row: usize, lambda: f64 },
}
#[derive(Clone, Copy)]
struct Emission {
    birth: Birth,
    host: usize,
    share: f64,
    charged: f64,
    photon: f64,
    transmission: f64,
    class: usize,
    family: usize,
}
#[derive(Clone, Debug)]
pub struct Delivery {
    pub host: Vec<f64>,
    pub water: Vec<f64>,
    pub nuclear_host: Vec<f64>,
    pub nuclear_water: Vec<f64>,
    pub exported: f64,
    pub emitted: f64,
    pub family_emitted: [f64; 3],
}
pub struct Workspace {
    pub energy: Vec<f64>,
    pub capacity: Vec<f64>,
    pub value: Delivery,
    pub direction: Delivery,
    escaped: Vec<[f64; 2]>,
    descaped: Vec<[f64; 2]>,
    conductance: Vec<f64>,
    dconductance_d_host: Vec<f64>,
    liquid_transmission: Vec<[f64; 2]>,
    geometry: Vec<ContactGeometry>,
    fractions: Vec<f64>,
    areas: Vec<f64>,
    direction_areas: Vec<f64>,
    temperatures: Vec<f64>,
    water: Vec<bt::Water>,
    owner: Arc<()>,
    valid: bool,
}
pub struct Model {
    input: Input,
    emissions: Vec<Emission>,
    paid: Vec<(usize, f64)>,
    geometry: Vec<ContactGeometry>,
    water_count: usize,
    source_dimension: usize,
    source_owner: Arc<()>,
    owner: Arc<()>,
}
fn positive(x: f64) -> bool {
    x.is_finite() && x > 0.
}
fn nn(x: f64) -> bool {
    x.is_finite() && x >= 0.
}
fn delivery(n: usize, nw: usize) -> Delivery {
    Delivery {
        host: vec![0.; n],
        water: vec![0.; nw],
        nuclear_host: vec![0.; n],
        nuclear_water: vec![0.; nw],
        exported: 0.,
        emitted: 0.,
        family_emitted: [0.; 3],
    }
}
impl Delivery {
    fn clear(&mut self) {
        self.host.fill(0.);
        self.water.fill(0.);
        self.nuclear_host.fill(0.);
        self.nuclear_water.fill(0.);
        self.exported = 0.;
        self.emitted = 0.;
        self.family_emitted = [0.; 3];
    }
}
impl Model {
    pub fn new(source: &se::Evolution, water_count: usize, input: Input) -> Result<Self, String> {
        let c = &input.caloric;
        let p = input.photons;
        let n = input.hosts.len();
        if n == 0
            || input.bodies.is_empty()
            || input.guide_births.is_empty()
            || !positive(input.wet_h)
            || !c.datum_k.is_finite()
            || !positive(c.steel_cp0)
            || !nn(c.steel_cp1)
            || !(c.body_min_k <= c.datum_k && c.datum_k <= c.body_max_k)
            || !(c.guide_min_k >= 290.
                && c.guide_max_k <= 1800.
                && c.guide_min_k <= c.datum_k
                && c.datum_k <= c.guide_max_k)
            || c.datum_k != 300.
            || c.b4c_cp_points.len() < 2
            || c.b4c_cp_points
                .iter()
                .any(|v| !positive(v[0]) || !positive(v[1]))
            || c.b4c_cp_points.windows(2).any(|v| v[1][0] <= v[0][0])
            || c.b4c_cp_points[0][0] > c.body_min_k
            || c.b4c_cp_points.last().unwrap()[0] < c.body_max_k
            || [
                p.density_b4c,
                p.density_steel,
                p.density_zr,
                p.guide_chord_m,
                p.guide_capture_j,
            ]
            .iter()
            .any(|v| !positive(*v))
            || [
                p.mu_b4c_05,
                p.mu_steel_05,
                p.mu_steel_1,
                p.mu_zr_1,
                p.mu_water_05,
                p.mu_water_1,
            ]
            .iter()
            .any(|v| !nn(*v))
        {
            return Err("Invalid BODY/guide material selection".into());
        }
        for h in &input.hosts {
            let body = positive(h.b4c_mass_kg) && positive(h.steel_mass_kg) && h.zr_mass_kg == 0.;
            let guide = h.b4c_mass_kg == 0. && h.steel_mass_kg == 0. && positive(h.zr_mass_kg);
            let bounds = if body {
                (c.body_min_k, c.body_max_k)
            } else {
                (c.guide_min_k, c.guide_max_k)
            };
            if !(body || guide)
                || !h.initial_k.is_finite()
                || h.initial_k < bounds.0
                || h.initial_k > bounds.1
            {
                return Err("Invalid finite BODY/guide host".into());
            }
        }
        let mut areas = vec![0.; n];
        for v in &input.contacts {
            if v.host >= n
                || v.water >= water_count
                || !nn(v.area_m2)
                || !nn(v.solid_geometry_m_inv)
                || !nn(v.liquid_chord_m)
                || (v.area_m2 > 0. && v.liquid_chord_m == 0.)
                || (input.hosts[v.host].zr_mass_kg == 0. && v.solid_geometry_m_inv != 0.)
            {
                return Err("Invalid actual BODY/guide wet contact".into());
            }
            areas[v.host] += v.area_m2;
        }
        if areas.iter().any(|v| !positive(*v)) {
            return Err("Finite BODY/guide host lacks real wet contacts".into());
        }
        let mut pairs = BTreeSet::new();
        for v in &input.axial {
            if v.a >= n
                || v.b >= n
                || v.a == v.b
                || !positive(v.area_over_distance_m)
                || input.hosts[v.a].zr_mass_kg == 0.
                || input.hosts[v.b].zr_mass_kg == 0.
                || !pairs.insert((v.a.min(v.b), v.a.max(v.b)))
            {
                return Err("Invalid guide axial metal link".into());
            }
        }
        let geometry = input.contacts.iter().copied().map(Into::into).collect();
        let mut emissions = Vec::new();
        let mut paid = BTreeMap::<usize, f64>::new();
        let mut targets = BTreeSet::new();
        let mut body_hosts = BTreeSet::new();
        for b in &input.bodies {
            if b.host >= n
                || input.hosts[b.host].b4c_mass_kg == 0.
                || !body_hosts.insert(b.host)
                || b.targets
                    .iter()
                    .any(|t| *t >= source.target_count() || !targets.insert(*t))
                || b.capture_j.iter().any(|v| !positive(*v))
                || !nn(b.b_photon_j)
                || b.b_photon_j > b.capture_j[0]
                || [b.b4c_chord_m, b.steel_chord_m, b.steel_shell_m]
                    .iter()
                    .any(|v| !positive(*v))
                || b.mn_owner >= source.mn_targets().len()
                || source.mn_targets()[b.mn_owner].target != b.targets[4]
            {
                return Err("Invalid immutable BODY source ownership".into());
            }
            for k in 0..5 {
                let target = b.targets[k];
                let q = b.capture_j[k];
                *paid.entry(source.target_row(target)).or_default() += q;
                if k == 4 {
                    *paid.entry(source.mn_product_row(b.mn_owner)).or_default() += q;
                }
                emissions.push(Emission {
                    birth: Birth::Target(target),
                    host: b.host,
                    share: 1.,
                    charged: if k == 0 { q - b.b_photon_j } else { 0. },
                    photon: if k == 0 { b.b_photon_j } else { q },
                    transmission: if k == 0 {
                        (-p.density_b4c * p.mu_b4c_05 * b.b4c_chord_m
                            - p.density_steel * p.mu_steel_05 * b.steel_shell_m)
                            .exp()
                    } else {
                        (-p.density_steel * p.mu_steel_1 * b.steel_chord_m).exp()
                    },
                    class: usize::from(k != 0),
                    family: usize::from(k != 0),
                });
            }
            let mn = source.mn_targets()[b.mn_owner];
            *paid.entry(source.mn_product_row(b.mn_owner)).or_default() +=
                mn.electron_j + mn.photon_j;
            emissions.push(Emission {
                birth: Birth::Mn {
                    row: source.target_row(mn.target),
                    lambda: mn.decay_rate,
                },
                host: b.host,
                share: 1.,
                charged: mn.electron_j,
                photon: mn.photon_j,
                transmission: (-p.density_steel * p.mu_steel_1 * b.steel_chord_m).exp(),
                class: 1,
                family: 1,
            });
        }
        let mut rows = BTreeMap::<(usize, usize), Vec<usize>>::new();
        for (i, t, r) in source.passive_birth_rows() {
            rows.entry((t, r)).or_default().push(i);
        }
        let mut sums = BTreeMap::<(usize, usize), f64>::new();
        let mut guides = BTreeSet::new();
        let mut guide_hosts = BTreeSet::new();
        for b in &input.guide_births {
            if b.host >= n
                || input.hosts[b.host].zr_mass_kg == 0.
                || !positive(b.share)
                // Shared physical clipping sums round differently from their
                // disjoint subsets. Admit only the same arithmetic envelope
                // as the complete partition check; never renormalize weights.
                || b.share > 1. + 64. * f64::EPSILON
                || b.target >= source.target_count()
                || targets.contains(&b.target)
            {
                return Err("Invalid guide birth-local allocation".into());
            }
            let matches = rows
                .get(&(b.target, b.region))
                .ok_or("Guide source region has no actual volume-material birth")?;
            *sums.entry((b.target, b.region)).or_default() += b.share;
            guides.insert(b.target);
            guide_hosts.insert(b.host);
            for &i in matches {
                emissions.push(Emission {
                    birth: Birth::Passive(i),
                    host: b.host,
                    share: b.share,
                    charged: 0.,
                    photon: p.guide_capture_j,
                    transmission: (-p.density_zr * p.mu_zr_1 * p.guide_chord_m).exp(),
                    class: 1,
                    family: 2,
                });
            }
        }
        if sums.values().any(|s| (*s - 1.).abs() > 64. * f64::EPSILON)
            || rows
                .keys()
                .any(|&(t, r)| guides.contains(&t) && !sums.contains_key(&(t, r)))
            || input.hosts.iter().enumerate().any(|(i, h)| {
                if h.zr_mass_kg > 0. {
                    !guide_hosts.contains(&i)
                } else {
                    !body_hosts.contains(&i)
                }
            })
        {
            return Err("Incomplete physical BODY/guide source partition".into());
        }
        for t in guides {
            *paid.entry(source.target_row(t)).or_default() += p.guide_capture_j;
        }
        Ok(Self {
            input,
            emissions,
            paid: paid.into_iter().collect(),
            geometry,
            water_count,
            source_dimension: source.state_count(),
            source_owner: source.owner_token(),
            owner: Arc::new(()),
        })
    }
    pub fn config(&self) -> &Input {
        &self.input
    }
    pub fn geometry(&self) -> &[ContactGeometry] {
        &self.geometry
    }
    pub fn host_count(&self) -> usize {
        self.input.hosts.len()
    }
    pub fn paid_rows(&self) -> impl Iterator<Item = (usize, f64)> + '_ {
        self.paid.iter().copied()
    }
    pub fn energy_capacity(&self, i: usize, t: f64) -> Result<(f64, f64), String> {
        let h = *self.input.hosts.get(i).ok_or("Unknown BODY/guide host")?;
        let c = &self.input.caloric;
        let (lo, hi) = if h.zr_mass_kg > 0. {
            (c.guide_min_k, c.guide_max_k)
        } else {
            (c.body_min_k, c.body_max_k)
        };
        if !t.is_finite() || t < lo || t > hi {
            return Err("BODY/guide caloric domain exceeded".into());
        }
        if h.zr_mass_kg > 0. {
            return Ok((
                h.zr_mass_kg * ft::clad_energy(t),
                h.zr_mass_kg * ft::clad_cp(t),
            ));
        }
        let cp = |v: f64| {
            let p = &c.b4c_cp_points;
            let j = p
                .windows(2)
                .position(|w| v <= w[1][0])
                .unwrap_or(p.len() - 2);
            p[j][1] + (p[j + 1][1] - p[j][1]) / (p[j + 1][0] - p[j][0]) * (v - p[j][0])
        };
        let primitive = |a: f64, b: f64| {
            c.b4c_cp_points
                .windows(2)
                .map(|v| {
                    let lo = a.max(v[0][0]);
                    let hi = b.min(v[1][0]);
                    if hi <= lo {
                        0.
                    } else {
                        let slope = (v[1][1] - v[0][1]) / (v[1][0] - v[0][0]);
                        let ca = v[0][1] + slope * (lo - v[0][0]);
                        (hi - lo) * (ca + 0.5 * slope * (hi - lo))
                    }
                })
                .sum::<f64>()
        };
        let eb = if t >= c.datum_k {
            primitive(c.datum_k, t)
        } else {
            -primitive(t, c.datum_k)
        };
        let dt = t - c.datum_k;
        let es = dt * (c.steel_cp0 + 0.5 * c.steel_cp1 * (t + c.datum_k));
        Ok((
            h.b4c_mass_kg * eb + h.steel_mass_kg * es,
            h.b4c_mass_kg * cp(t) + h.steel_mass_kg * (c.steel_cp0 + c.steel_cp1 * t),
        ))
    }
    pub fn workspace(&self) -> Workspace {
        let n = self.host_count();
        Workspace {
            energy: vec![0.; n],
            capacity: vec![0.; n],
            value: delivery(n, self.water_count),
            direction: delivery(n, self.water_count),
            escaped: vec![[0.; 2]; n],
            descaped: vec![[0.; 2]; n],
            conductance: vec![0.; self.input.contacts.len()],
            dconductance_d_host: vec![0.; self.input.contacts.len()],
            liquid_transmission: vec![[0.; 2]; self.input.contacts.len()],
            geometry: self.geometry.clone(),
            fractions: vec![0.; self.input.contacts.len()],
            areas: vec![0.; n],
            direction_areas: vec![0.; n],
            temperatures: vec![0.; n],
            water: vec![
                bt::Water {
                    temperature_k: 0.,
                    density_kg_m3: 0.,
                    saturation_temperature_k: 0.
                };
                self.water_count
            ],
            owner: self.owner.clone(),
            valid: false,
        }
    }
    pub fn evaluate(
        &self,
        temps: &[f64],
        sw: &se::Workspace,
        source_y: &[f64],
        water: &[bt::Water],
        w: &mut Workspace,
    ) -> Result<(), String> {
        self.evaluate_with_geometry(temps, sw, source_y, water, &self.geometry, w)
    }
    pub fn evaluate_with_geometry(
        &self,
        temps: &[f64],
        sw: &se::Workspace,
        source_y: &[f64],
        water: &[bt::Water],
        geometry: &[ContactGeometry],
        w: &mut Workspace,
    ) -> Result<(), String> {
        w.valid = false;
        if !Arc::ptr_eq(&w.owner, &self.owner)
            || !Arc::ptr_eq(&self.source_owner, sw.owner_token())
            || source_y.len() != self.source_dimension
            || temps.len() != self.host_count()
            || water.len() != self.water_count
            || geometry.len() != self.input.contacts.len()
        {
            return Err("Invalid BODY/guide workspace shape or source owner".into());
        }
        w.areas.fill(0.);
        for (c, g) in self.input.contacts.iter().zip(geometry) {
            if !nn(g.area_m2)
                || !nn(g.solid_geometry_m_inv)
                || !nn(g.liquid_chord_m)
                || (g.area_m2 > 0. && g.liquid_chord_m == 0.)
                || (self.input.hosts[c.host].zr_mass_kg == 0. && g.solid_geometry_m_inv != 0.)
            {
                return Err("Invalid current BODY/guide contact geometry".into());
            }
            w.areas[c.host] += g.area_m2;
        }
        if w.areas.iter().any(|a| !positive(*a)) {
            return Err("Current finite BODY/guide host lacks wet contacts".into());
        }
        for ((c, g), fraction) in self
            .input
            .contacts
            .iter()
            .zip(geometry)
            .zip(&mut w.fractions)
        {
            *fraction = g.area_m2 / w.areas[c.host];
        }
        w.geometry.copy_from_slice(geometry);
        w.value.clear();
        w.escaped.fill([0.; 2]);
        for (i, &t) in temps.iter().enumerate() {
            let (e, c) = self.energy_capacity(i, t)?;
            w.energy[i] = e;
            w.capacity[i] = c;
        }
        let captures = sw.target_captures()?;
        let births = sw.passive_birth_events()?;
        for e in &self.emissions {
            let rate = e.share
                * match e.birth {
                    Birth::Target(i) => captures[i],
                    Birth::Passive(i) => births[i],
                    Birth::Mn { row, lambda } => lambda * source_y[row],
                };
            let emitted = rate * (e.charged + e.photon);
            w.value.emitted += emitted;
            w.value.family_emitted[e.family] += emitted;
            w.value.nuclear_host[e.host] += rate * (e.charged + e.photon * (1. - e.transmission));
            w.escaped[e.host][e.class] += rate * e.photon * e.transmission;
        }
        w.value.host.copy_from_slice(&w.value.nuclear_host);
        for (i, c) in self.input.contacts.iter().enumerate() {
            let geometry = geometry[i];
            let t = temps[c.host];
            let v = water[c.water];
            if !positive(v.density_kg_m3)
                || !v.temperature_k.is_finite()
                || !v.saturation_temperature_k.is_finite()
                || v.temperature_k >= v.saturation_temperature_k
                || t >= v.saturation_temperature_k
            {
                return Err("BODY/guide contact left cold fully-liquid scope".into());
            }
            let k = ft::clad_k(t);
            // This form retains the finite one-sided area derivative at a
            // currently zero-area union contact; no division by zero/floor.
            let ha = self.input.wet_h * geometry.area_m2;
            let g = ha / (1. + ha * geometry.solid_geometry_m_inv / k);
            let q = g * (t - v.temperature_k);
            w.conductance[i] = g;
            w.dconductance_d_host[i] =
                g * g * geometry.solid_geometry_m_inv * ft::clad_k_derivative(t) / (k * k);
            w.value.host[c.host] -= q;
            w.value.water[c.water] += q;
            for (s, mu) in [
                self.input.photons.mu_water_05,
                self.input.photons.mu_water_1,
            ]
            .into_iter()
            .enumerate()
            {
                let tr = (-v.density_kg_m3 * mu * geometry.liquid_chord_m).exp();
                w.liquid_transmission[i][s] = tr;
                let incoming = w.escaped[c.host][s] * w.fractions[i];
                let q = incoming * (1. - tr);
                w.value.water[c.water] += q;
                w.value.nuclear_water[c.water] += q;
                w.value.exported += incoming * tr;
            }
        }
        for l in &self.input.axial {
            let q = l.area_over_distance_m * ft::clad_k_increment(temps[l.b], temps[l.a]);
            w.value.host[l.a] -= q;
            w.value.host[l.b] += q;
        }
        if w.value
            .host
            .iter()
            .chain(&w.value.water)
            .chain(&w.energy)
            .chain(&w.capacity)
            .chain([&w.value.exported, &w.value.emitted])
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite BODY/guide thermal response".into());
        }
        w.temperatures.copy_from_slice(temps);
        w.water.copy_from_slice(water);
        w.valid = true;
        Ok(())
    }
    pub fn jvp(
        &self,
        dt: &[f64],
        sw: &se::Workspace,
        dsource_y: &[f64],
        water: &[bt::WaterDirection],
        w: &mut Workspace,
    ) -> Result<(), String> {
        self.jvp_inner(dt, sw, dsource_y, water, None, w)
    }
    pub fn jvp_with_geometry_direction(
        &self,
        dt: &[f64],
        sw: &se::Workspace,
        dsource_y: &[f64],
        water: &[bt::WaterDirection],
        geometry: &[ContactGeometry],
        w: &mut Workspace,
    ) -> Result<(), String> {
        self.jvp_inner(dt, sw, dsource_y, water, Some(geometry), w)
    }
    fn jvp_inner(
        &self,
        dt: &[f64],
        sw: &se::Workspace,
        dsource_y: &[f64],
        water: &[bt::WaterDirection],
        geometry: Option<&[ContactGeometry]>,
        w: &mut Workspace,
    ) -> Result<(), String> {
        if !w.valid
            || !Arc::ptr_eq(&w.owner, &self.owner)
            || !Arc::ptr_eq(&self.source_owner, sw.owner_token())
            || dsource_y.len() != self.source_dimension
            || dt.len() != self.host_count()
            || water.len() != self.water_count
            || geometry.is_some_and(|g| g.len() != self.input.contacts.len())
        {
            return Err("No current BODY/guide linearization".into());
        }
        w.direction_areas.fill(0.);
        if let Some(direction) = geometry {
            for (c, g) in self.input.contacts.iter().zip(direction) {
                if ![g.area_m2, g.solid_geometry_m_inv, g.liquid_chord_m]
                    .iter()
                    .all(|v| v.is_finite())
                    || (self.input.hosts[c.host].zr_mass_kg == 0. && g.solid_geometry_m_inv != 0.)
                {
                    return Err("Invalid BODY/guide geometry direction".into());
                }
                w.direction_areas[c.host] += g.area_m2;
            }
        }
        w.direction.clear();
        w.descaped.fill([0.; 2]);
        let captures = sw.target_capture_jvp()?;
        let births = sw.passive_birth_event_jvp()?;
        for e in &self.emissions {
            let rate = e.share
                * match e.birth {
                    Birth::Target(i) => captures[i],
                    Birth::Passive(i) => births[i],
                    Birth::Mn { row, lambda } => lambda * dsource_y[row],
                };
            let emitted = rate * (e.charged + e.photon);
            w.direction.emitted += emitted;
            w.direction.family_emitted[e.family] += emitted;
            w.direction.nuclear_host[e.host] +=
                rate * (e.charged + e.photon * (1. - e.transmission));
            w.descaped[e.host][e.class] += rate * e.photon * e.transmission;
        }
        w.direction.host.copy_from_slice(&w.direction.nuclear_host);
        for (i, c) in self.input.contacts.iter().enumerate() {
            let v = water[c.water];
            let g = w.geometry[i];
            let dg = geometry.map_or(ContactGeometry::default(), |d| d[i]);
            let k = ft::clad_k(w.temperatures[c.host]);
            let denominator = 1. + self.input.wet_h * g.area_m2 * g.solid_geometry_m_inv / k;
            let dconductance = self.input.wet_h / denominator.powi(2) * dg.area_m2
                - w.conductance[i].powi(2) / k * dg.solid_geometry_m_inv;
            let q = w.conductance[i] * (dt[c.host] - v.temperature_k)
                + (w.dconductance_d_host[i] * dt[c.host] + dconductance)
                    * (w.temperatures[c.host] - w.water[c.water].temperature_k);
            w.direction.host[c.host] -= q;
            w.direction.water[c.water] += q;
            for (s, mu) in [
                self.input.photons.mu_water_05,
                self.input.photons.mu_water_1,
            ]
            .into_iter()
            .enumerate()
            {
                let tr = w.liquid_transmission[i][s];
                let dtr = -tr
                    * mu
                    * (g.liquid_chord_m * v.density_kg_m3
                        + w.water[c.water].density_kg_m3 * dg.liquid_chord_m);
                let dfraction =
                    (dg.area_m2 - w.fractions[i] * w.direction_areas[c.host]) / w.areas[c.host];
                let incoming = w.escaped[c.host][s] * w.fractions[i];
                let dincoming =
                    w.descaped[c.host][s] * w.fractions[i] + w.escaped[c.host][s] * dfraction;
                let q = dincoming * (1. - tr) - incoming * dtr;
                w.direction.water[c.water] += q;
                w.direction.nuclear_water[c.water] += q;
                w.direction.exported += dincoming * tr + incoming * dtr;
            }
        }
        for l in &self.input.axial {
            let q = l.area_over_distance_m
                * (ft::clad_k(w.temperatures[l.a]) * dt[l.a]
                    - ft::clad_k(w.temperatures[l.b]) * dt[l.b]);
            w.direction.host[l.a] -= q;
            w.direction.host[l.b] += q;
        }
        if w.direction
            .host
            .iter()
            .chain(&w.direction.water)
            .chain([&w.direction.exported, &w.direction.emitted])
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite BODY/guide directional response".into());
        }
        Ok(())
    }
    /// Exact host-only operator; current liquid/source coupling remains in the
    /// full composed JVP. Sparse P consumes these entries without property calls.
    pub fn visit_host_jacobian(
        &self,
        w: &Workspace,
        mut emit: impl FnMut(usize, usize, f64),
    ) -> Result<(), String> {
        if !w.valid || !Arc::ptr_eq(&self.owner, &w.owner) {
            return Err("Unprepared BODY/guide host Jacobian".into());
        }
        for (i, c) in self.input.contacts.iter().enumerate() {
            emit(
                c.host,
                c.host,
                -w.conductance[i]
                    - w.dconductance_d_host[i]
                        * (w.temperatures[c.host] - w.water[c.water].temperature_k),
            );
        }
        for l in &self.input.axial {
            let a = l.area_over_distance_m * ft::clad_k(w.temperatures[l.a]);
            let b = l.area_over_distance_m * ft::clad_k(w.temperatures[l.b]);
            emit(l.a, l.a, -a);
            emit(l.a, l.b, b);
            emit(l.b, l.a, a);
            emit(l.b, l.b, -b);
        }
        Ok(())
    }
}

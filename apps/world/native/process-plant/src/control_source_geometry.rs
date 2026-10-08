//! Prepared cold moving-control geometry. Owns no material, liquid, thermal or
//! nuclear history. One physical union supplies every current consumer; the
//! integrator supplies the accepted contact/one-sided branch explicitly.
use crate::{absorber_guide as ag, mobile_capture as mc, source_evolution as se};
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub struct Pose {
    pub body: f64,
    pub stem: f64,
    pub body_right: bool,
    pub stem_right: bool,
    pub seated: bool,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Direction {
    pub body: f64,
    pub stem: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Water {
    pub volume: f64,
    pub moment: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum Motion {
    Body,
    Stem,
}
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub lo: f64,
    pub hi: f64,
    pub area: f64,
}
pub struct Moving {
    pub cluster: usize,
    pub motion: Motion,
    pub lo: f64,
    pub hi: f64,
    pub spans: Vec<Span>,
}
pub struct Passive {
    pub original: f64,
    pub moving: Option<Moving>,
}
pub struct Cylinder {
    pub original: f64,
    pub cluster: Option<usize>,
    pub lo: f64,
    pub hi: f64,
    pub factor: f64,
}
pub struct Intruder {
    pub cluster: usize,
    pub motion: Motion,
    pub lo: f64,
    pub hi: f64,
    pub area: f64,
}
pub struct HousingClip {
    pub intruder: usize,
    pub area: f64,
    pub lo: f64,
    pub hi: f64,
}
pub enum PatchKind {
    Fixed,
    Upper,
    Guide {
        cluster: usize,
        outer: f64,
        body: f64,
        lo: f64,
        hi: f64,
    },
    Housing {
        clips: Vec<HousingClip>,
    },
}
pub struct Patch {
    pub original: f64,
    pub kind: PatchKind,
}
#[derive(Clone, Copy)]
pub enum OriginKind {
    Fixed,
    Lower,
    Upper,
    Guide(usize),
    Housing {
        change: usize,
        radius: f64,
        length: f64,
    },
}
#[derive(Clone, Copy)]
pub enum Material {
    Active,
    Lower,
    Upper,
}
#[derive(Clone, Copy)]
pub enum Recipient {
    Lower,
    Guide,
    Upper,
}
pub enum PathRole {
    Fixed(f64),
    Side {
        cluster: usize,
        material: Material,
        inside: bool,
    },
    End {
        cluster: usize,
        top: bool,
        recipient: Recipient,
    },
}
pub struct Path {
    pub role: PathRole,
    pub thickness: Vec<f64>,
}
pub struct Origin {
    pub kind: OriginKind,
    pub original_volume: f64,
    pub original_boundary: f64,
    pub paths: Vec<Path>,
}
#[derive(Clone, Copy)]
pub enum ContactRole {
    Fixed,
    GuideSide,
    UpperSide,
    BottomLower,
    BottomGuide,
    TopUpper,
}
pub struct Contact {
    pub role: ContactRole,
    pub cluster: usize,
    pub origin: usize,
    pub area: f64,
    pub solid: f64,
}
pub struct Route {
    pub patch: usize,
    pub row: usize,
    pub origin: usize,
}
/// The BARREL retains its selected reduced optical envelope. It shares the
/// physical origin's current volume change, not the mobile full-contact area.
pub struct BarrelPath {
    pub origin: usize,
    pub original_volume: f64,
    pub original_boundary: f64,
    pub boundary_volume_slope: f64,
}
pub struct Input {
    pub clusters: usize,
    pub maximum_body: f64,
    pub maximum_stem: f64,
    pub bottom: f64,
    pub top: f64,
    pub active_bottom: f64,
    pub active_length: f64,
    pub active_top: f64,
    pub head: f64,
    pub housing_top: f64,
    pub neck_top: f64,
    pub rodlets: f64,
    pub guide_radius: f64,
    pub body_radius: f64,
    pub guide_area: f64,
    pub body_area: f64,
    pub water: Vec<Water>,
    pub upper: usize,
    pub guides: Vec<usize>,
    pub passive: Vec<Passive>,
    pub cylinders: Vec<Cylinder>,
    pub intruders: Vec<Intruder>,
    pub patches: Vec<Patch>,
    pub row_water: Vec<usize>,
    pub routes: Vec<Route>,
    pub origins: Vec<Origin>,
    pub contacts: Vec<Contact>,
    pub barrel_paths: Vec<BarrelPath>,
}
pub struct Prepared {
    input: Input,
    moderator_prefix: Vec<f64>,
    owner: Arc<()>,
}
pub struct Stage {
    /// Immutable receiving prefix followed by primary moderator rows; the
    /// external-water volume covers the whole network, not just SOURCE support.
    pub source: se::Geometry,
    pub contacts: Vec<ag::ContactGeometry>,
    pub mobile: mc::Geometry,
    pub water: Vec<Water>,
    pub barrel_chords_m: Vec<f64>,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Partial {
    pub volume: f64,
    pub moment: f64,
    pub moment_second: f64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct WaterPartials {
    pub guide_body: Partial,
    pub upper_body: Partial,
    pub upper_stem: Partial,
}
pub struct Workspace {
    pub value: Stage,
    pub direction: Stage,
    pub water_partials: Vec<WaterPartials>,
    pub water_rates: Vec<Water>,
    pub water_rate_direction: Vec<Water>,
    changes: [(D, D); 3],
    patches: Vec<D>,
    rows: Vec<D>,
    envelopes: Vec<(D, D)>,
    poses: Vec<Pose>,
    pose_direction: Vec<Direction>,
    valid: bool,
    owner: Arc<()>,
}
impl Workspace {
    pub(crate) fn owner_token(&self) -> &Arc<()> { &self.owner }
    /// A force/heat consumer must use the actual current preparation,
    /// including its retained one-sided and contact branches.
    pub fn check_current_poses(&self, poses: &[Pose]) -> Result<(), &'static str> {
        if !self.valid || self.poses.len() != poses.len() || self.poses.iter().zip(poses).any(|(a,b)| {
            a.body.to_bits() != b.body.to_bits() || a.stem.to_bits() != b.stem.to_bits()
                || a.body_right != b.body_right || a.stem_right != b.stem_right || a.seated != b.seated
        }) {
            return Err("Control geometry requires the exact current pose and branch");
        }
        Ok(())
    }
    pub fn check_current_direction(&self, direction: &[Direction]) -> Result<(), &'static str> {
        if !self.valid || self.pose_direction.len() != direction.len()
            || self.pose_direction.iter().zip(direction).any(|(a, b)| {
                a.body.to_bits() != b.body.to_bits() || a.stem.to_bits() != b.stem.to_bits()
            })
        {
            return Err("Control geometry requires its exact current pose direction");
        }
        Ok(())
    }
    /// Physical liquid-origin envelope, never the containing thermal aggregate.
    pub fn origin_chord_m(&self, origin: usize) -> Result<f64, &'static str> {
        if !self.valid { return Err("Unprepared control photon origin"); }
        self.envelopes.get(origin).map(|e| e.1[0]).ok_or("Foreign control photon origin")
    }
    pub fn origin_chord_direction_m(&self, origin: usize) -> Result<f64, &'static str> {
        if !self.valid { return Err("Unprepared control photon origin direction"); }
        self.envelopes.get(origin).map(|e| e.1[1]).ok_or("Foreign control photon origin")
    }
}
type D = [f64; 2];
fn c(x: f64) -> D {
    [x, 0.]
}
fn add(a: D, b: D) -> D {
    [a[0] + b[0], a[1] + b[1]]
}
fn sub(a: D, b: D) -> D {
    [a[0] - b[0], a[1] - b[1]]
}
fn scale(a: D, s: f64) -> D {
    [a[0] * s, a[1] * s]
}
fn div(a: D, b: D) -> D {
    [a[0] / b[0], (a[1] * b[0] - a[0] * b[1]) / (b[0] * b[0])]
}
fn sqrt(a: D) -> D {
    let s = a[0].sqrt();
    [s, a[1] / (2. * s)]
}
/// Same branch-exact physical interval law as the compiler comparator. The
/// second moment derivative is local, needed only for d(Jdot), not a Hessian.
pub fn overlap(lo: f64, hi: f64, bottom: f64, top: f64, y: f64, right: bool) -> [f64; 5] {
    let lg = y - (bottom - lo);
    let ug = y - (top - hi);
    let ml = lg >= 0.;
    let mu = ug <= 0.;
    let l = if ml { lo + y } else { bottom };
    let u = if mu { hi + y } else { top };
    let length = if ml {
        if mu {
            hi - lo
        } else {
            (top - lo) - y
        }
    } else if mu {
        (hi - bottom) + y
    } else {
        top - bottom
    };
    if length < 0. {
        return [0.; 5];
    }
    let dl = if lg > 0. {
        1.
    } else if lg < 0. {
        0.
    } else if right {
        1.
    } else {
        0.
    };
    let du = if ug < 0. {
        1.
    } else if ug > 0. {
        0.
    } else if right {
        0.
    } else {
        1.
    };
    let raw: f64 = du - dl;
    let dlength = if length > 0. {
        raw
    } else if right {
        raw.max(0.)
    } else {
        raw.min(0.)
    };
    let mean = if ml {
        if mu {
            (lo + hi) / 2. + y
        } else {
            top - length / 2.
        }
    } else if mu {
        bottom + length / 2.
    } else {
        (bottom + top) / 2.
    };
    let dj = if length > 0. {
        if du == dl {
            if du == 1. {
                length
            } else {
                0.
            }
        } else if du == 1. {
            u
        } else {
            -l
        }
    } else {
        l * dlength
    };
    [
        length,
        dlength,
        length * mean,
        dj,
        if length > 0. || dlength != 0. {
            raw
        } else {
            0.
        },
    ]
}
fn clipped(lo: f64, hi: f64, bottom: f64, top: f64, y: D, right: bool) -> (D, D, [f64; 5]) {
    let q = overlap(lo, hi, bottom, top, y[0], right);
    ([q[0], q[1] * y[1]], [q[2], q[3] * y[1]], q)
}
fn pair(s: &mut f64, d: &mut f64, x: D) {
    *s = x[0];
    *d = x[1];
}
fn valid_span(lo: f64, hi: f64) -> bool {
    lo.is_finite() && hi.is_finite() && hi > lo
}
fn positive(x: f64) -> bool {
    x.is_finite() && x > 0.
}
impl Prepared {
    pub(crate) fn owner_token(&self) -> Arc<()> { self.owner.clone() }
    pub fn new(input: Input, original: &se::Geometry) -> Result<Self, &'static str> {
        let i = &input;
        let n = i.clusters;
        if original.passive_volumes.len() != i.passive.len()
            || original.cylinder_shares.len() != i.cylinders.len()
            || original.external_water_volumes.len() != i.water.len()
            || original.moderator_volumes.len() < i.row_water.len()
        {
            return Err("Prepared SOURCE/current geometry layouts differ");
        }
        let moderator_prefix = original.moderator_volumes
            [..original.moderator_volumes.len() - i.row_water.len()]
            .to_vec();
        if moderator_prefix.iter().any(|v| !v.is_finite() || *v < 0.) {
            return Err("Invalid immutable receiving moderator prefix");
        }
        if n == 0
            || i.guides.len() != n
            || i.upper >= i.water.len()
            || i.guides.iter().any(|&g| g >= i.water.len() || g == i.upper)
            || i.guides
                .iter()
                .enumerate()
                .any(|(j, g)| i.guides[..j].contains(g))
            || ![
                i.maximum_body,
                i.maximum_stem,
                i.active_length,
                i.rodlets,
                i.guide_radius,
                i.body_radius,
                i.guide_area,
                i.body_area,
            ]
            .into_iter()
            .all(positive)
            || !(i.guide_radius > i.body_radius && i.guide_area > i.body_area)
            || !valid_span(i.bottom, i.top)
            || !valid_span(i.active_bottom, i.active_bottom + i.active_length)
            || !valid_span(i.top, i.head)
            || !valid_span(i.head, i.housing_top)
            || !valid_span(i.housing_top, i.neck_top)
            || !i.active_top.is_finite()
            || i.water
                .iter()
                .any(|w| !positive(w.volume) || !w.moment.is_finite())
            || i.row_water.iter().any(|&w| w >= i.water.len())
        {
            return Err("Invalid current-control geometry domain/owner layout");
        }
        for p in &i.passive {
            if !p.original.is_finite() || p.original < 0. {
                return Err("Invalid passive original geometry");
            }
            if let Some(m) = &p.moving {
                if m.cluster >= n
                    || !valid_span(m.lo, m.hi)
                    || m.spans.is_empty()
                    || m.spans
                        .iter()
                        .any(|s| !valid_span(s.lo, s.hi) || !positive(s.area))
                {
                    return Err("Invalid moving passive support");
                }
            }
        }
        for q in &i.cylinders {
            if !q.original.is_finite()
                || q.original < 0.
                || q.original > 1.
                || q.cluster
                    .is_some_and(|k| k >= n || !valid_span(q.lo, q.hi) || !positive(q.factor))
            {
                return Err("Invalid moving cylinder support");
            }
        }
        if i.intruders
            .iter()
            .any(|q| q.cluster >= n || !valid_span(q.lo, q.hi) || !positive(q.area))
        {
            return Err("Invalid moving intrusion support");
        }
        for p in &i.patches {
            if !p.original.is_finite() || p.original < 0. {
                return Err("Invalid source-water patch");
            }
            match &p.kind {
                PatchKind::Guide {
                    cluster,
                    outer,
                    body,
                    lo,
                    hi,
                } if *cluster >= n
                    || !valid_span(*lo, *hi)
                    || !positive(*outer)
                    || !positive(*body)
                    || outer < body =>
                {
                    return Err("Invalid guide patch support")
                }
                PatchKind::Housing { clips }
                    if clips.iter().any(|q| {
                        q.intruder >= i.intruders.len()
                            || !positive(q.area)
                            || !valid_span(q.lo, q.hi)
                    }) =>
                {
                    return Err("Invalid housing patch support")
                }
                _ => (),
            }
        }
        for o in &i.origins {
            if !positive(o.original_volume) || !positive(o.original_boundary) {
                return Err("Invalid physical photon origin");
            }
            match o.kind {
                OriginKind::Guide(k) if k >= n => return Err("Invalid photon guide identity"),
                OriginKind::Housing {
                    change,
                    radius,
                    length,
                } if !(change == 1 || change == 2) || !positive(radius) || !positive(length) => {
                    return Err("Invalid photon housing support")
                }
                _ => (),
            }
            for p in &o.paths {
                if p.thickness.iter().any(|&t| !t.is_finite() || t < 0.) {
                    return Err("Invalid physical photon wall");
                }
                match p.role {
                    PathRole::Fixed(a) if !a.is_finite() || a < 0. => {
                        return Err("Invalid fixed photon area")
                    }
                    PathRole::Side { cluster, .. } | PathRole::End { cluster, .. }
                        if cluster >= n =>
                    {
                        return Err("Invalid photon cluster identity")
                    }
                    _ => (),
                }
            }
        }
        if i.routes.iter().any(|r| {
            r.patch >= i.patches.len() || r.row >= i.row_water.len() || r.origin >= i.origins.len()
        }) || i.contacts.iter().any(|c| {
            c.origin >= i.origins.len()
                || !c.area.is_finite()
                || c.area < 0.
                || !c.solid.is_finite()
                || c.solid < 0.
                || (!matches!(c.role, ContactRole::Fixed) && c.cluster >= n)
        }) {
            return Err("Invalid fixed current consumer identities");
        }
        if i.barrel_paths.iter().any(|p| {
            p.origin >= i.origins.len()
                || !p.original_volume.is_finite()
                || p.original_volume <= 0.
                || !p.original_boundary.is_finite()
                || p.original_boundary <= 0.
                || !p.boundary_volume_slope.is_finite()
                || p.boundary_volume_slope < 0.
        }) {
            return Err("Invalid current barrel photon origin");
        }
        Ok(Self {
            input,
            moderator_prefix,
            owner: Arc::new(()),
        })
    }
    pub fn input(&self) -> &Input {
        &self.input
    }
    pub fn workspace(&self) -> Workspace {
        let i = &self.input;
        let np = i.origins.iter().map(|o| o.paths.len()).sum();
        let nw = i
            .origins
            .iter()
            .flat_map(|o| &o.paths)
            .map(|p| p.thickness.len())
            .sum();
        let stage = || Stage {
            source: se::Geometry {
                passive_volumes: vec![0.; i.passive.len()],
                cylinder_shares: vec![0.; i.cylinders.len()],
                moderator_volumes: vec![0.; self.moderator_prefix.len() + i.row_water.len()],
                external_water_volumes: vec![0.; i.water.len()],
            },
            contacts: vec![
                ag::ContactGeometry {
                    area_m2: 0.,
                    solid_geometry_m_inv: 0.,
                    liquid_chord_m: 0.
                };
                i.contacts.len()
            ],
            mobile: mc::Geometry {
                birth_shares: vec![0.; i.routes.len()],
                liquid_chords_m: vec![0.; i.routes.len()],
                path_shares: vec![0.; np],
                wall_thicknesses_m: vec![0.; nw],
                boundary_shares: vec![0.; i.origins.len()],
            },
            water: vec![Water::default(); i.water.len()],
            barrel_chords_m: vec![0.; i.barrel_paths.len()],
        };
        Workspace {
            value: stage(),
            direction: stage(),
            water_partials: vec![WaterPartials::default(); i.clusters],
            water_rates: vec![Water::default(); i.water.len()],
            water_rate_direction: vec![Water::default(); i.water.len()],
            changes: [(c(0.), c(0.)); 3],
            patches: vec![c(0.); i.patches.len()],
            rows: vec![c(0.); i.row_water.len()],
            envelopes: vec![(c(0.), c(0.)); i.origins.len()],
            poses: vec![
                Pose {
                    body: 0.,
                    stem: 0.,
                    body_right: true,
                    stem_right: true,
                    seated: true
                };
                i.clusters
            ],
            pose_direction: vec![Direction::default(); i.clusters],
            valid: false,
            owner: Arc::clone(&self.owner),
        }
    }
    fn check_workspace(&self, w: &Workspace) -> bool {
        let i = &self.input;
        if !Arc::ptr_eq(&self.owner, &w.owner)
            || w.poses.len() != i.clusters
            || w.pose_direction.len() != i.clusters
            || w.water_partials.len() != i.clusters
            || w.water_rates.len() != i.water.len()
            || w.water_rate_direction.len() != i.water.len()
            || w.patches.len() != i.patches.len()
            || w.rows.len() != i.row_water.len()
            || w.envelopes.len() != i.origins.len()
        {
            return false;
        }
        let paths = i.origins.iter().map(|o| o.paths.len()).sum::<usize>();
        let walls = i
            .origins
            .iter()
            .flat_map(|o| &o.paths)
            .map(|p| p.thickness.len())
            .sum::<usize>();
        [&w.value, &w.direction].into_iter().all(|s| {
            s.source.passive_volumes.len() == i.passive.len()
                && s.source.cylinder_shares.len() == i.cylinders.len()
                && s.source.moderator_volumes.len()
                    == self.moderator_prefix.len() + i.row_water.len()
                && s.source.external_water_volumes.len() == i.water.len()
                && s.water.len() == i.water.len()
                && s.barrel_chords_m.len() == i.barrel_paths.len()
                && s.contacts.len() == i.contacts.len()
                && s.mobile.birth_shares.len() == i.routes.len()
                && s.mobile.liquid_chords_m.len() == i.routes.len()
                && s.mobile.path_shares.len() == paths
                && s.mobile.wall_thicknesses_m.len() == walls
                && s.mobile.boundary_shares.len() == i.origins.len()
        })
    }
    pub fn evaluate_into(
        &self,
        poses: &[Pose],
        direction: &[Direction],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        w.valid = false;
        let i = &self.input;
        if poses.len() != i.clusters || direction.len() != i.clusters || !self.check_workspace(w) {
            return Err("Wrong current cluster geometry/workspace shape");
        }
        for (p, d) in poses.iter().zip(direction) {
            if ![p.body, p.stem, d.body, d.stem]
                .into_iter()
                .all(f64::is_finite)
                || p.body < 0.
                || p.body > i.maximum_body
                || p.stem < 0.
                || p.stem > i.maximum_stem
                || (p.body == 0. && !p.body_right)
                || (p.stem == 0. && !p.stem_right)
                || (p.seated && p.body != 0.)
            {
                return Err("Current pose outside selected cold support branch");
            }
        }
        let y = |k: usize, m: Motion| match m {
            Motion::Body => ([poses[k].body, direction[k].body], poses[k].body_right),
            Motion::Stem => ([poses[k].stem, direction[k].stem], poses[k].stem_right),
        };
        for (j, p) in i.passive.iter().enumerate() {
            let mut v = c(p.original);
            if let Some(m) = &p.moving {
                v = c(0.);
                let (y, right) = y(m.cluster, m.motion);
                for s in &m.spans {
                    v = add(
                        v,
                        scale(clipped(s.lo, s.hi, m.lo, m.hi, y, right).0, s.area),
                    );
                }
            }
            pair(
                &mut w.value.source.passive_volumes[j],
                &mut w.direction.source.passive_volumes[j],
                v,
            );
        }
        for (j, q) in i.cylinders.iter().enumerate() {
            let v = if let Some(k) = q.cluster {
                let (y, right) = y(k, Motion::Body);
                scale(
                    clipped(
                        i.active_bottom,
                        i.active_bottom + i.active_length,
                        q.lo,
                        q.hi,
                        y,
                        right,
                    )
                    .0,
                    q.factor,
                )
            } else {
                c(q.original)
            };
            pair(
                &mut w.value.source.cylinder_shares[j],
                &mut w.direction.source.cylinder_shares[j],
                v,
            );
        }
        for (j, original) in i.water.iter().enumerate() {
            w.value.water[j] = *original;
            w.direction.water[j] = Water::default();
        }
        w.changes.fill((c(0.), c(0.)));
        w.water_partials.fill(WaterPartials::default());
        let length = i.top - i.bottom;
        for k in 0..i.clusters {
            let (y, right) = y(k, Motion::Body);
            let (l, j, q) = clipped(i.bottom, i.top, i.bottom, i.top, y, right);
            let v = sub(c(i.guide_area * length), scale(l, i.body_area));
            let moment = sub(
                c(i.guide_area * (i.top * i.top - i.bottom * i.bottom) / 2.),
                scale(j, i.body_area),
            );
            let cell = i.guides[k];
            w.value.water[cell] = Water {
                volume: v[0],
                moment: moment[0],
            };
            w.direction.water[cell] = Water {
                volume: v[1],
                moment: moment[1],
            };
            w.water_partials[k].guide_body = Partial {
                volume: -i.body_area * q[1],
                moment: -i.body_area * q[3],
                moment_second: -i.body_area * q[4],
            };
            let (l, j, q) = clipped(i.bottom, i.top, i.top, i.head, y, right);
            w.changes[0].0 = sub(w.changes[0].0, scale(l, i.body_area));
            w.changes[0].1 = sub(w.changes[0].1, scale(j, i.body_area));
            w.water_partials[k].upper_body = Partial {
                volume: -i.body_area * q[1],
                moment: -i.body_area * q[3],
                moment_second: -i.body_area * q[4],
            };
        }
        for q in &i.intruders {
            let (y, right) = y(q.cluster, q.motion);
            for (idx, (lo, hi)) in [
                (i.active_top, i.head),
                (i.head, i.housing_top),
                (i.housing_top, i.neck_top),
            ]
            .into_iter()
            .enumerate()
            {
                let (l, j, current) = clipped(q.lo, q.hi, lo, hi, y, right);
                let (ol, oj, _) = clipped(q.lo, q.hi, lo, hi, c(0.), right);
                w.changes[idx].0 = sub(w.changes[idx].0, scale(sub(l, ol), q.area));
                w.changes[idx].1 = sub(w.changes[idx].1, scale(sub(j, oj), q.area));
                let p = match q.motion {
                    Motion::Body => &mut w.water_partials[q.cluster].upper_body,
                    Motion::Stem => &mut w.water_partials[q.cluster].upper_stem,
                };
                p.volume -= q.area * current[1];
                p.moment -= q.area * current[3];
                p.moment_second -= q.area * current[4];
            }
        }
        let mut upper_v = c(i.water[i.upper].volume);
        let mut upper_j = c(i.water[i.upper].moment);
        for &(v, j) in &w.changes {
            upper_v = add(upper_v, v);
            upper_j = add(upper_j, j);
        }
        w.value.water[i.upper] = Water {
            volume: upper_v[0],
            moment: upper_j[0],
        };
        w.direction.water[i.upper] = Water {
            volume: upper_v[1],
            moment: upper_j[1],
        };
        for (j, p) in i.patches.iter().enumerate() {
            w.patches[j] = match &p.kind {
                PatchKind::Fixed => c(p.original),
                PatchKind::Upper => add(c(p.original), w.changes[0].0),
                PatchKind::Guide {
                    cluster,
                    outer,
                    body,
                    lo,
                    hi,
                } => {
                    let (y, right) = y(*cluster, Motion::Body);
                    sub(
                        c(outer * (hi - lo)),
                        scale(clipped(i.bottom, i.top, *lo, *hi, y, right).0, *body),
                    )
                }
                PatchKind::Housing { clips } => {
                    let mut v = c(p.original);
                    for clip in clips {
                        let q = &i.intruders[clip.intruder];
                        let (y, right) = y(q.cluster, q.motion);
                        let l = clipped(q.lo, q.hi, clip.lo, clip.hi, y, right).0;
                        let old = clipped(q.lo, q.hi, clip.lo, clip.hi, c(0.), right).0;
                        v = sub(v, scale(sub(l, old), clip.area));
                    }
                    v
                }
            };
        }
        w.rows.fill(c(0.));
        for r in &i.routes {
            w.rows[r.row] = add(w.rows[r.row], w.patches[r.patch]);
        }
        let circumference = i.rodlets * 2. * std::f64::consts::PI * i.body_radius;
        for (j, o) in i.origins.iter().enumerate() {
            let (v, a) = match o.kind {
                OriginKind::Guide(k) => {
                    let (y, _) = y(k, Motion::Body);
                    let v = [
                        w.value.water[i.guides[k]].volume,
                        w.direction.water[i.guides[k]].volume,
                    ];
                    let ends = 2.
                        * if poses[k].seated {
                            i.guide_area - i.body_area
                        } else {
                            i.guide_area
                        };
                    let a = add(
                        c(i.rodlets * 2. * std::f64::consts::PI * i.guide_radius * length + ends),
                        scale(sub(c(length), y), circumference),
                    );
                    (v, a)
                }
                kind => {
                    let change = match kind {
                        OriginKind::Upper => Some(w.changes[0].0),
                        OriginKind::Housing { change, .. } => Some(w.changes[change].0),
                        _ => None,
                    };
                    let v = change.map_or(c(o.original_volume), |d| add(c(o.original_volume), d));
                    let mut a = c(o.original_boundary);
                    match kind {
                        OriginKind::Lower => {
                            a = sub(
                                a,
                                c(i.body_area * poses.iter().filter(|p| !p.seated).count() as f64),
                            )
                        }
                        OriginKind::Upper => {
                            let mut total = c(0.);
                            for k in 0..i.clusters {
                                total = add(total, y(k, Motion::Body).0);
                            }
                            a = add(a, scale(total, circumference));
                        }
                        OriginKind::Housing { radius, length, .. } => {
                            let ri = sqrt(sub(
                                c(radius * radius),
                                scale(v, 1. / (i.clusters as f64 * std::f64::consts::PI * length)),
                            ));
                            a = add(
                                scale(
                                    add(c(radius), ri),
                                    i.clusters as f64 * 2. * std::f64::consts::PI * length,
                                ),
                                scale(v, 2. / length),
                            );
                        }
                        _ => (),
                    }
                    (v, a)
                }
            };
            if !positive(v[0]) || !positive(a[0]) {
                return Err("Nonpositive current photon envelope");
            }
            w.envelopes[j] = (a, div(scale(v, 4.), a));
        }
        let area = |role: &PathRole| -> D {
            match *role {
                PathRole::Fixed(a) => c(a),
                PathRole::End {
                    cluster,
                    top,
                    recipient,
                } => c(if top {
                    if matches!(recipient, Recipient::Upper) {
                        i.body_area
                    } else {
                        0.
                    }
                } else if matches!(recipient, Recipient::Lower) {
                    if poses[cluster].seated {
                        i.body_area
                    } else {
                        0.
                    }
                } else if matches!(recipient, Recipient::Guide) && !poses[cluster].seated {
                    i.body_area
                } else {
                    0.
                }),
                PathRole::Side {
                    cluster,
                    material,
                    inside,
                } => {
                    let (lo, hi) = match material {
                        Material::Active => (i.active_bottom, i.active_bottom + i.active_length),
                        Material::Lower => (i.bottom, i.active_bottom),
                        Material::Upper => (i.active_bottom + i.active_length, i.top),
                    };
                    let (bottom, top) = if inside {
                        (i.bottom, i.top)
                    } else {
                        (i.top, i.head)
                    };
                    let (y, right) = y(cluster, Motion::Body);
                    scale(clipped(lo, hi, bottom, top, y, right).0, circumference)
                }
            }
        };
        let (mut path_index, mut wall_index) = (0, 0);
        for (j, o) in i.origins.iter().enumerate() {
            let mut total = c(0.);
            for p in &o.paths {
                let share = div(area(&p.role), w.envelopes[j].0);
                total = add(total, share);
                pair(
                    &mut w.value.mobile.path_shares[path_index],
                    &mut w.direction.mobile.path_shares[path_index],
                    share,
                );
                path_index += 1;
                for &thickness in &p.thickness {
                    w.value.mobile.wall_thicknesses_m[wall_index] = thickness;
                    w.direction.mobile.wall_thicknesses_m[wall_index] = 0.;
                    wall_index += 1;
                }
            }
            pair(
                &mut w.value.mobile.boundary_shares[j],
                &mut w.direction.mobile.boundary_shares[j],
                sub(c(1.), total),
            );
        }
        for (j, q) in i.contacts.iter().enumerate() {
            let a = match q.role {
                ContactRole::Fixed => c(q.area),
                ContactRole::GuideSide => {
                    scale(sub(c(length), y(q.cluster, Motion::Body).0), circumference)
                }
                ContactRole::UpperSide => scale(y(q.cluster, Motion::Body).0, circumference),
                ContactRole::TopUpper => c(i.body_area),
                ContactRole::BottomLower => c(if poses[q.cluster].seated {
                    i.body_area
                } else {
                    0.
                }),
                ContactRole::BottomGuide => c(if poses[q.cluster].seated {
                    0.
                } else {
                    i.body_area
                }),
            };
            w.value.contacts[j] = ag::ContactGeometry {
                area_m2: a[0],
                solid_geometry_m_inv: q.solid,
                liquid_chord_m: w.envelopes[q.origin].1[0],
            };
            w.direction.contacts[j] = ag::ContactGeometry {
                area_m2: a[1],
                solid_geometry_m_inv: 0.,
                liquid_chord_m: w.envelopes[q.origin].1[1],
            };
        }
        for (j, r) in i.routes.iter().enumerate() {
            let share = div(w.patches[r.patch], w.rows[r.row]);
            let chord = w.envelopes[r.origin].1;
            pair(
                &mut w.value.mobile.birth_shares[j],
                &mut w.direction.mobile.birth_shares[j],
                share,
            );
            pair(
                &mut w.value.mobile.liquid_chords_m[j],
                &mut w.direction.mobile.liquid_chords_m[j],
                chord,
            );
        }
        for (j, path) in i.barrel_paths.iter().enumerate() {
            let delta = match i.origins[path.origin].kind {
                OriginKind::Upper => w.changes[0].0,
                OriginKind::Housing { change, .. } => w.changes[change].0,
                _ => c(0.),
            };
            let volume = add(c(path.original_volume), delta);
            let boundary = add(
                c(path.original_boundary),
                scale(delta, path.boundary_volume_slope),
            );
            if volume[0] <= 0. || boundary[0] <= 0. {
                return Err("Invalid current barrel optical envelope");
            }
            pair(
                &mut w.value.barrel_chords_m[j],
                &mut w.direction.barrel_chords_m[j],
                div(scale(volume, 4.), boundary),
            );
        }
        for (j, &v) in self.moderator_prefix.iter().enumerate() {
            w.value.source.moderator_volumes[j] = v;
            w.direction.source.moderator_volumes[j] = 0.;
        }
        for (j, v) in w.rows.iter().copied().enumerate() {
            if !(v[0] > 0. && v[0] <= w.value.water[i.row_water[j]].volume) {
                return Err("Invalid current source-water partition");
            }
            let row = self.moderator_prefix.len() + j;
            pair(
                &mut w.value.source.moderator_volumes[row],
                &mut w.direction.source.moderator_volumes[row],
                v,
            );
        }
        for (j, v) in w.value.water.iter().enumerate() {
            w.value.source.external_water_volumes[j] = v.volume;
            w.direction.source.external_water_volumes[j] = w.direction.water[j].volume;
        }
        for stage in [&w.value, &w.direction] {
            if stage
                .source
                .passive_volumes
                .iter()
                .chain(&stage.source.cylinder_shares)
                .chain(&stage.source.moderator_volumes)
                .chain(&stage.source.external_water_volumes)
                .chain(&stage.mobile.birth_shares)
                .chain(&stage.mobile.path_shares)
                .chain(&stage.mobile.boundary_shares)
                .chain(&stage.mobile.liquid_chords_m)
                .chain(&stage.mobile.wall_thicknesses_m)
                .chain(&stage.barrel_chords_m)
                .any(|x| !x.is_finite())
                || stage
                    .water
                    .iter()
                    .any(|v| !v.volume.is_finite() || !v.moment.is_finite())
                || stage.contacts.iter().any(|c| {
                    ![c.area_m2, c.solid_geometry_m_inv, c.liquid_chord_m]
                        .into_iter()
                        .all(f64::is_finite)
                })
            {
                return Err("Nonfinite current control geometry");
            }
        }
        if w.value.water.iter().any(|v| v.volume <= 0.)
            || w.value.source.passive_volumes.iter().any(|v| *v < 0.)
            || w.value
                .source
                .cylinder_shares
                .iter()
                .chain(&w.value.mobile.birth_shares)
                .chain(&w.value.mobile.path_shares)
                .chain(&w.value.mobile.boundary_shares)
                .any(|v| !(0. ..=1.).contains(v))
            || w.value
                .contacts
                .iter()
                .any(|c| c.area_m2 < 0. || c.liquid_chord_m <= 0.)
        {
            return Err("Current geometric admission failed");
        }
        if w.value.barrel_chords_m.iter().any(|&c| c <= 0.) {
            return Err("Invalid current barrel photon chord");
        }
        w.poses.copy_from_slice(poses);
        w.pose_direction.copy_from_slice(direction);
        w.valid = true;
        Ok(())
    }
    /// Contraction of the SAME current shape with actual motion velocities,
    /// including the local quadratic first-moment term in its coupled JVP.
    pub fn water_rates_into(
        &self,
        velocity: &[Direction],
        dvelocity: &[Direction],
        w: &mut Workspace,
    ) -> Result<(), &'static str> {
        if !w.valid
            || !self.check_workspace(w)
            || velocity.len() != self.input.clusters
            || dvelocity.len() != velocity.len()
            || velocity
                .iter()
                .chain(dvelocity)
                .any(|v| !v.body.is_finite() || !v.stem.is_finite())
        {
            return Err("Invalid current water geometry-rate stage");
        }
        w.water_rates.fill(Water::default());
        w.water_rate_direction.fill(Water::default());
        let mut apply = |cell: usize, p: Partial, v: f64, dv: f64, dy: f64| {
            w.water_rates[cell].volume += p.volume * v;
            w.water_rates[cell].moment += p.moment * v;
            w.water_rate_direction[cell].volume += p.volume * dv;
            w.water_rate_direction[cell].moment += p.moment * dv + p.moment_second * v * dy;
        };
        for k in 0..velocity.len() {
            let p = w.water_partials[k];
            let v = velocity[k];
            let dv = dvelocity[k];
            let dy = w.pose_direction[k];
            apply(self.input.guides[k], p.guide_body, v.body, dv.body, dy.body);
            apply(self.input.upper, p.upper_body, v.body, dv.body, dy.body);
            apply(self.input.upper, p.upper_stem, v.stem, dv.stem, dy.stem);
        }
        if w.water_rates
            .iter()
            .chain(&w.water_rate_direction)
            .any(|q| !q.volume.is_finite() || !q.moment.is_finite())
        {
            return Err("Nonfinite current water shape-rate contraction");
        }
        Ok(())
    }
}
impl Workspace {
    pub fn valid(&self) -> bool {
        self.valid
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> Prepared {
        Prepared::new(
            Input {
                clusters: 1,
                maximum_body: 0.5,
                maximum_stem: 0.5,
                bottom: 0.,
                top: 2.,
                active_bottom: 0.3,
                active_length: 1.,
                active_top: 1.3,
                head: 4.,
                housing_top: 6.,
                neck_top: 8.,
                rodlets: 1.,
                guide_radius: 2.,
                body_radius: 1.,
                guide_area: 2.,
                body_area: 1.,
                water: vec![
                    Water {
                        volume: 2.,
                        moment: 2.,
                    },
                    Water {
                        volume: 10.,
                        moment: 30.,
                    },
                    Water {
                        volume: 1.,
                        moment: 8.,
                    },
                ],
                upper: 1,
                guides: vec![0],
                passive: vec![],
                cylinders: vec![],
                intruders: vec![
                    Intruder {
                        cluster: 0,
                        motion: Motion::Body,
                        lo: 2.1,
                        hi: 2.3,
                        area: 0.1,
                    },
                    Intruder {
                        cluster: 0,
                        motion: Motion::Stem,
                        lo: 3.7,
                        hi: 4.3,
                        area: 0.2,
                    },
                ],
                patches: vec![],
                row_water: vec![],
                routes: vec![],
                origins: vec![],
                contacts: vec![],
                barrel_paths: vec![],
            },
            &se::Geometry {
                passive_volumes: vec![],
                cylinder_shares: vec![],
                moderator_volumes: vec![0.4],
                external_water_volumes: vec![2., 10., 1.],
            },
        )
        .unwrap()
    }
    fn pose(body: f64, stem: f64) -> Pose {
        Pose {
            body,
            stem,
            body_right: true,
            stem_right: true,
            seated: false,
        }
    }
    #[test]
    fn overlap_preserves_exact_contained_length_and_one_sided_touching() {
        for y in [0.003, 0.00300001, 0.1] {
            let q = overlap(0.2, 0.8, 0., 2., y, true);
            assert_eq!(q[0], 0.8 - 0.2);
            assert_eq!(q[1], 0.);
            assert_eq!(q[3], q[0]);
            assert_eq!(q[4], 0.);
        }
        let incoming = overlap(0., 1., 1., 2., 0., true);
        assert_eq!(incoming, [0., 1., 0., 1., 1.]);
        let outgoing = overlap(0., 1., 1., 2., 0., false);
        assert_eq!(outgoing, [0.; 5]);
        assert_eq!(overlap(0., 1., 0., 1., 0., true), [1., -1., 0.5, 0., -1.]);
        assert_eq!(overlap(0., 1., 0., 1., 0., false), [1., 1., 0.5, 1., 1.]);
    }
    #[test]
    fn sparse_rate_direction_includes_curvature_and_independent_stem_speed() {
        let p = model();
        let mut w = p.workspace();
        let pose = pose(0.05, 0.07);
        let d = Direction {
            body: 0.03,
            stem: -0.02,
        };
        let v = Direction {
            body: 0.008,
            stem: 0.006,
        };
        let dv = Direction {
            body: -0.01,
            stem: 0.02,
        };
        p.evaluate_into(&[pose], &[d], &mut w).unwrap();
        p.water_rates_into(&[v], &[dv], &mut w).unwrap();
        assert!(w.water_partials[0].guide_body.moment_second != 0.);
        assert_eq!(w.value.water[2].volume, 1.);
        assert_eq!(w.water_rates[2].moment, 0.);
        assert!((w.water_rates.iter().map(|w| w.volume).sum::<f64>()).abs() < 1e-14);
        let h = 1e-5;
        let mut plus = p.workspace();
        let mut minus = p.workspace();
        for (sign, s) in [(1., &mut plus), (-1., &mut minus)] {
            p.evaluate_into(
                &[Pose {
                    body: pose.body + sign * h * d.body,
                    stem: pose.stem + sign * h * d.stem,
                    ..pose
                }],
                &[Direction::default()],
                s,
            )
            .unwrap();
            p.water_rates_into(
                &[Direction {
                    body: v.body + sign * h * dv.body,
                    stem: v.stem + sign * h * dv.stem,
                }],
                &[Direction::default()],
                s,
            )
            .unwrap();
        }
        for k in 0..3 {
            assert!(
                (w.water_rate_direction[k].volume
                    - (plus.water_rates[k].volume - minus.water_rates[k].volume) / (2. * h))
                    .abs()
                    < 1e-10
            );
            assert!(
                (w.water_rate_direction[k].moment
                    - (plus.water_rates[k].moment - minus.water_rates[k].moment) / (2. * h))
                    .abs()
                    < 1e-10
            );
        }
    }
    #[test]
    fn foreign_or_resized_workspace_and_unselected_branch_refuse() {
        let p = model();
        let foreign = model();
        let mut w = foreign.workspace();
        let zero = [Direction::default()];
        assert!(p.evaluate_into(&[pose(0.01, 0.01)], &zero, &mut w).is_err());
        let mut w = p.workspace();
        w.value.source.external_water_volumes.clear();
        assert!(p.evaluate_into(&[pose(0.01, 0.01)], &zero, &mut w).is_err());
        let mut w = p.workspace();
        assert!(p
            .evaluate_into(
                &[Pose {
                    body_right: false,
                    ..pose(0., 0.)
                }],
                &zero,
                &mut w
            )
            .is_err());
        assert!(!w.valid());
        assert!(p.water_rates_into(&zero, &zero, &mut w).is_err());
    }
}

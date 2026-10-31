//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#s2-operating-rod-block
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#rod-bore-water-state
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#grip-manual-disconnect-and-achieved-motion
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#s2-holding-circuit-boundary
//! The rod block: 52 moving spider-and-bodies (H7), the water of their guide
//! bores as its own state (P2), the bores' two open mouths and the network
//! cell volumes the bodies displace above the bores.
//!
//! Per cluster, in this order: achieved travel `y` (m), body velocity `v`
//! (m/s, upward positive), the lower mouth's upward mass current `m_lo` and
//! the upper mouth's `m_up` (kg/s). `y' = v` always. A FREE body obeys
//! `M v' = F_end + F_wall + B_spider + F_drag - M g`; a HELD or SEATED body
//! has the algebraic row `v = 0`. The two mouth rows are steady, each over
//! its own path to the bores' reference height where its hydrostatics end
//! (P2-FIX-1, [`RodBlock::mouth_paths`]): LOWER's mouth pressure less the
//! bores' at the lower mouth less the lower mouth and the clear and annular
//! segments of `[z_lo, z_ref]`, and the bores' pressure at the upper mouth
//! less UPPER's less the segments of `[z_ref, z_up]` and the upper mouth.
//!
//! The bores' water is one well-mixed water region per bore group: the
//! clusters with the same sector shares (exchangeable in every law here),
//! each cluster declared at composition kept singly (the stuck cluster of
//! G7). A group owns its water's mass `M`, internal energy `U` and boron
//! amount `B` (differential, the native mass, energy and species laws) and
//! its pressure `p` at the bores' fixed reference elevation (algebraic, the
//! network's EOS row `M/rho(p, U/M) - V = 0` on the maintained caloric
//! point). `V` is its members' bore volume less their inserted bodies, so
//! the water a falling body displaces leaves through the mouths by the
//! group's own mass balance (R2 is its consequence). The column, the clear
//! bores and the annulus use the bores' own water; each mouth's loss uses
//! the water passing it (its donor by sign, R3's C1 blend over the band at
//! the upper, annulus mouth). Transport is exact donor by each mouth's sign.
//! The bodies' wall work and the boundary work `-p V'` enter the bores'
//! energy; the spider's drag work enters the plena it occupies through the
//! single heat port, and the network pays `-p V'` of the plena volumes the
//! bodies and spider displace above the bores. The bores' water is not in
//! the sector inventory: [`carve`] removes it from the network packet once,
//! before the network is compiled. The stem stays with the drive line (H7).
//! The holding circuit opens at the declared delay after the manual turbine
//! TRIP (H6); grip release is then immediate (G3). A seated body's arrival
//! energy is deposited once into its fuel assembly's top fitting. Every
//! value comes from the compiled `rods` section and the network packet;
//! nothing is defaulted, clipped or floored, and nothing is iterated here:
//! the prepared bore water is LOWER's prepared water (its specific internal
//! energy and boron) at the bores' reference, the currents start at zero, and the joined exact consistent
//! start solves the algebraic coordinates (DR13-ROD).
pub mod geometry;
pub mod guide;

use crate::{
    joined::block::{
        CellVolume, Class, Command, Coordinates, Fluid, Layout, OwnerAccount, Receipts, Rods,
        Structure, Transaction, restored_time, snapshot_object, snapshot_time,
    },
    local_flow::Phase,
    network::{Failure, Properties, Water, packet::Packet},
    thermal::Scalar,
};
use geometry::{Branch, Profile};
use guide::{Annulus, Passage, s};
use serde::Deserialize;
use serde_json::json;
use std::f64::consts::PI;

/// The compiled `rods` section of the spine packet.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub identity: String,
    /// The 52 clusters in the source feedback's rod order.
    pub clusters: Vec<ClusterSection>,
    pub bodies: Bodies,
    pub spider: Spider,
    pub guide: Guide,
    pub cells: Cells,
    pub gravity_m_s2: f64,
    /// Achieved travel of the prepared hold.
    pub reference_travel_m: f64,
    /// Upper end of the admitted travel geometry.
    pub normal_travel_m: f64,
    pub holding: Holding,
    pub spider_drag: SpiderDrag,
    pub provenance: Vec<Provenance>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClusterSection {
    pub id: String,
    pub fuel_assembly: String,
    pub lattice: [i32; 2],
    /// Share of the cluster's body area in the sectors NE, NW, SW, SE.
    pub sector_shares: [f64; 4],
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bodies {
    pub count: u32,
    pub radius_m: f64,
    pub length_m: f64,
    pub seated_bottom_m: f64,
    /// The bodies' B4C and steel of one cluster.
    pub mass_kg: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spider {
    pub mass_kg: f64,
    pub volume_m3: f64,
    pub seated_bottom_m: f64,
    pub height_m: f64,
    pub radius_m: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guide {
    pub bore_radius_m: f64,
    pub lower_mouth_m: f64,
    pub upper_mouth_m: f64,
    pub roughness_m: f64,
    pub lower_mouth_loss: f64,
    pub upper_mouth_loss: f64,
    /// R3's blend band, as an annulus speed: the upper mouth's donor water
    /// is blended over |annulus volume current| below this speed times the
    /// annulus area.
    pub blend_speed_m_s: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Span {
    pub region: String,
    pub bottom_m: f64,
    pub top_m: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cells {
    pub lower: Span,
    /// Sectors NE, NW, SW, SE, each with its lower and upper core band.
    pub core: [[Span; 2]; 4],
    pub upper: Span,
    pub housing_main: Span,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Holding {
    /// Declared S2 boundary from the manual turbine TRIP to the holding
    /// circuit opening (H6).
    pub turbine_trip_to_opening_s: f64,
}
/// The broad spider drag in S2: an open selection is carried explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, tag = "selection", rename_all = "kebab-case")]
pub enum SpiderDrag {
    /// Not yet selected: a free body refuses to evaluate.
    Pending,
    /// `F = -0.5 rho C pi r^2 v|v|` on the spider envelope disk.
    EnvelopeDisk { coefficient: f64 },
    /// Declared omission.
    Omitted,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub name: String,
    pub sha256: String,
}
/// The `rods` key of the spine packet, read beside the other sections.
#[derive(Debug, Deserialize)]
pub struct RodPacket {
    pub rods: Section,
}

/// Discrete mode of one spider-and-bodies, retained block state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Mode {
    Held,
    Free,
    Seated,
}

/// One network region as the block sees it.
#[derive(Clone, Copy, Debug)]
pub struct Region<'a> {
    pub id: &'a str,
    pub elevation_m: f64,
}

/// Offsets of one cluster's coordinates.
pub const TRAVEL: usize = 0;
pub const VELOCITY: usize = 1;
pub const LOWER_CURRENT: usize = 2;
pub const UPPER_CURRENT: usize = 3;
pub const CLUSTER_COORDINATES: usize = 4;
/// Offsets of one bore group's coordinates, after every cluster's.
pub const BORE_MASS: usize = 0;
pub const BORE_ENERGY: usize = 1;
pub const BORE_BORON: usize = 2;
pub const BORE_PRESSURE: usize = 3;
pub const GROUP_COORDINATES: usize = 4;

/// LOWER's prepared water, the bores' prepared water at their reference.
#[derive(Clone, Copy, Debug)]
pub struct LowerWater {
    pub pressure_pa: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    /// Boron amount per kg of water (kg_eq/kg).
    pub boron_concentration: f64,
}

/// LOWER's liquid in a state being converted to the bores' state
/// ([`RodBlock::bore_stocks_at`]): pressure at LOWER's reference and the
/// liquid's density, viscosity, specific internal energy and boron.
#[derive(Clone, Copy, Debug)]
pub struct LowerField {
    pub pressure_pa: f64,
    pub density_kg_m3: f64,
    pub viscosity_pa_s: f64,
    pub internal_energy_j_kg: f64,
    pub boron_concentration: f64,
}

/// What [`carve`] removed: per swept cell (network index), the bores' free
/// water volume at the prepared travel and the cell's volume after.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Carve {
    pub cells: Vec<(usize, f64, f64)>,
}

#[derive(Clone, Debug)]
struct Cluster {
    id: String,
    fuel_assembly: String,
    group: usize,
}
#[derive(Clone, Debug)]
struct Group {
    members: Vec<usize>,
    single: bool,
}
/// One network plenum the bodies and spider move through above the bores:
/// index and axial span.
#[derive(Clone, Debug)]
struct Plenum {
    index: usize,
    bottom: f64,
    top: f64,
}

/// The bores' water of one group in one evaluation.
#[derive(Clone, Copy, Debug)]
pub struct Bore {
    /// Pressure at the bores' reference elevation.
    pub pressure: Scalar,
    pub mass: Scalar,
    pub density: Scalar,
    pub enthalpy: Scalar,
    pub viscosity: Scalar,
    pub boron_concentration: Scalar,
    /// The members' free bore volume.
    pub volume: Scalar,
}

/// Every force and mouth balance of one cluster in one evaluation
/// (physical, upward positive).
#[derive(Clone, Copy, Debug)]
pub struct Forces {
    pub tip_pressure: Scalar,
    pub top_pressure: Scalar,
    pub end_face: Scalar,
    pub wall: Scalar,
    pub spider_buoyancy: Scalar,
    pub spider_drag: Scalar,
    /// `F_end + F_wall + B_spider + F_drag - M g`.
    pub net: Scalar,
    /// The lower and the upper mouth's steady balances (Pa).
    pub lower_residual: Scalar,
    pub upper_residual: Scalar,
    /// The annulus enhancement on the upper and the lower mouth's path.
    pub chi: Scalar,
    pub lower_chi: Scalar,
    /// Both annulus segments' dissipation and the upper mouth's, W.
    pub annulus_dissipation: Scalar,
    /// The mouths' upward mass currents (kg/s).
    pub lower_current: Scalar,
    pub upper_current: Scalar,
    /// R3's weight on the bores' water at the upper mouth: 1 above the band,
    /// 0 below it.
    pub upper_mouth_weight: Scalar,
    /// The densities of the water passing the lower and the upper mouth.
    pub lower_mouth_density: Scalar,
    pub upper_mouth_density: Scalar,
    pub bore: Bore,
}

/// The lengths (m) of the clear and annular segments on each mouth's path
/// to the bores' reference height (P2-FIX-1). Their sums over both paths are
/// the bores' clear and annular lengths.
#[derive(Clone, Copy, Debug)]
pub struct MouthPaths {
    pub lower_clear: Scalar,
    pub lower_annulus: Scalar,
    pub upper_clear: Scalar,
    pub upper_annulus: Scalar,
}

/// One member cluster of a bore group in one evaluation: its index, forces
/// and mouth transport.
type Member = (usize, Forces, [(usize, [Scalar; 3]); 2]);

/// R3's C1 weight on the annulus volume current over its band, `x`:
/// `1/2 + 3x/4 - x^3/4` on `|x| < 1`, with zero slope at both edges.
fn blend(x: Scalar) -> Scalar {
    s(0.5) + s(0.75) * x - s(0.25) * x * x * x
}

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(reason.into())
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(reason.into())
}
fn scalar(w: &Water, d: &Water, field: fn(&Water) -> f64) -> Scalar {
    Scalar::new(field(w), field(d))
}

/// The swept cells holding the bores, in [`carve`]'s order: LOWER, the
/// eight core cells (sector by sector, lower band first), UPPER; each with
/// its axial span and, per cluster, its share of the cluster's bores.
fn bore_cells(section: &Section) -> Vec<(&Span, Vec<f64>)> {
    let n = section.clusters.len();
    let mut cells = vec![(&section.cells.lower, vec![1.; n])];
    for (k, sector) in section.cells.core.iter().enumerate() {
        for band in sector {
            cells.push((
                band,
                section
                    .clusters
                    .iter()
                    .map(|c| c.sector_shares[k])
                    .collect(),
            ));
        }
    }
    cells.push((&section.cells.upper, vec![1.; n]));
    cells
}

/// Remove the 52 clusters' bore water from the sector inventory of the
/// network packet, once, before the network is compiled: each swept cell
/// loses the bores' free volume it holds at the prepared travel (its share
/// of the 24 bores over its span less the bodies inside them), and its
/// prepared mass, energy and boron scale with its volume, so its prepared
/// water keeps its state. The returned record is what [`RodBlock::from_packet`]
/// checks the network packet against.
pub fn carve(section: &Section, packet: &mut Packet) -> Result<Carve, Failure> {
    let g = &section.guide;
    let b = &section.bodies;
    let clear_area = b.count as f64 * PI * g.bore_radius_m * g.bore_radius_m;
    let body_area = b.count as f64 * PI * b.radius_m * b.radius_m;
    let tip = b.seated_bottom_m + section.reference_travel_m;
    let length = |lo: f64, hi: f64, bottom: f64, top: f64| (hi.min(top) - lo.max(bottom)).max(0.);
    let mut out = Vec::new();
    for (span, weights) in bore_cells(section) {
        let index = packet
            .mechanics
            .regions
            .iter()
            .position(|r| r.id == span.region)
            .ok_or_else(|| fatal(format!("rods carve: no network region {}", span.region)))?;
        let bore = length(span.bottom_m, span.top_m, g.lower_mouth_m, g.upper_mouth_m);
        let body = length(span.bottom_m, span.top_m, tip, g.upper_mouth_m);
        let removed: f64 = weights.iter().sum::<f64>() * (clear_area * bore - body_area * body);
        let region = &mut packet.mechanics.regions[index];
        let before = region.volume_m3;
        let after = before - removed;
        if !(removed >= 0. && after > 0. && after.is_finite()) {
            return Err(fatal(format!(
                "rods carve: {} cannot give {removed} m3 of bore water from {before} m3",
                span.region
            )));
        }
        region.volume_m3 = after;
        let ratio = after / before;
        let water =
            packet.thermal.water.get_mut(index).ok_or_else(|| {
                fatal(format!("rods carve: {} has no prepared water", span.region))
            })?;
        water.mass_kg *= ratio;
        water.energy_j *= ratio;
        let boron = packet
            .water_boron_amount_kg_eq
            .get_mut(index)
            .ok_or_else(|| fatal(format!("rods carve: {} has no prepared boron", span.region)))?;
        *boron *= ratio;
        out.push((index, removed, after));
    }
    Ok(Carve { cells: out })
}

pub struct RodBlock {
    clusters: Vec<Cluster>,
    groups: Vec<Group>,
    regular: usize,
    /// The plena the bodies' upper parts and the spiders move through:
    /// UPPER above the bores, then HOUSING.MAIN.
    plena: [Plenum; 2],
    lower: usize,
    upper: usize,
    main: usize,
    /// Pressure-reference elevations of LOWER, UPPER and HOUSING.MAIN.
    z_lower: f64,
    z_upper: f64,
    z_main: f64,
    /// The UPPER/HOUSING.MAIN plane.
    z_interface: f64,
    /// The bores' reference elevation: the guides' mid-height.
    z_bore: f64,
    body_area: f64,
    body_bottom: f64,
    body_top: f64,
    spider_bottom: f64,
    spider_height: f64,
    spider_volume: f64,
    spider_area: f64,
    /// The assembly's C1 displaced-area profile above the guide top
    /// (E-EVT lever (b), [`Profile`]).
    profile: Profile,
    mass: f64,
    guide_bottom: f64,
    guide_top: f64,
    /// One cluster's bore volume from mouth to mouth, m3.
    bore_volume: f64,
    passage: Passage,
    /// R3's band in annulus volume current, m3/s.
    blend_volume_current: f64,
    gravity: f64,
    reference_travel: f64,
    span: (f64, f64),
    spider_drag: SpiderDrag,
    holding_delay: f64,
    /// Displaced volume of each cluster in each plenum at the prepared
    /// travel, which the compiled cell volumes already exclude.
    reference_displacement: [Vec<f64>; 2],
    layout: Layout,
    prepared: Vec<f64>,
    modes: Vec<Mode>,
    failed_release: Vec<bool>,
    holding_open_at: Option<f64>,
    /// Set only for a conservation-account evaluation
    /// ([`Rods::capture_account`]): the next value evaluation also records
    /// the bodies' power ledger, which no residual or Jacobian pays for.
    capture: bool,
    /// The recorded power ledger summed over the clusters: the bodies'
    /// fluid-force power, the heat paid to the water and the boundary work
    /// the network and the bores pay through `-p V'` (W).
    captured: Option<[f64; 3]>,
}

impl RodBlock {
    /// Compile the block from its section and the carved network packet it
    /// moves ([`carve`], whose record it checks): its region identities and
    /// elevations, and LOWER's prepared water, which prepares the bores'.
    /// `singles` are the clusters kept in their own bore group (a declared
    /// stuck cluster).
    pub fn from_packet<P: Properties>(
        section: &Section,
        network: &Packet,
        carved: &Carve,
        properties: &P,
        singles: &[usize],
    ) -> Result<Self, Failure> {
        let expected = bore_cells(section).len();
        if carved.cells.len() != expected
            || carved.cells.iter().any(|(i, _, after)| {
                network
                    .mechanics
                    .regions
                    .get(*i)
                    .is_none_or(|r| r.volume_m3.to_bits() != after.to_bits())
            })
        {
            return Err(fatal(
                "rods: the network packet is not the one carve() removed the bores' water from",
            ));
        }
        let regions: Vec<Region<'_>> = network
            .mechanics
            .regions
            .iter()
            .map(|r| Region {
                id: &r.id,
                elevation_m: r.elevation_m,
            })
            .collect();
        let lower = regions
            .iter()
            .position(|r| r.id == section.cells.lower.region)
            .ok_or_else(|| fatal("rods: no LOWER region"))?;
        let water = network
            .thermal
            .water
            .get(lower)
            .ok_or_else(|| fatal("rods: LOWER has no prepared water owner"))?;
        let boron = network
            .water_boron_amount_kg_eq
            .get(lower)
            .ok_or_else(|| fatal("rods: LOWER has no prepared boron"))?;
        let lower_water = LowerWater {
            pressure_pa: water.pressure_pa,
            density_kg_m3: water.mass_kg / network.mechanics.regions[lower].volume_m3,
            internal_energy_j_kg: water.energy_j / water.mass_kg,
            boron_concentration: boron / water.mass_kg,
        };
        Self::new(
            section,
            &regions,
            network.pzr.cell.index,
            &lower_water,
            properties,
            singles,
        )
    }

    /// Compile the block over the network's regions (packet order; the first
    /// `regular` are regular cells) with LOWER's prepared water. Each bore
    /// group's prepared water is LOWER's water carried to the bores'
    /// reference elevation on LOWER's density, at LOWER's specific internal
    /// energy and boron concentration (the network's own caloric target);
    /// the mouth currents start at zero and the joined consistent start
    /// solves them with the bores' pressures.
    pub fn new<P: Properties>(
        section: &Section,
        regions: &[Region<'_>],
        regular: usize,
        lower_water: &LowerWater,
        properties: &P,
        singles: &[usize],
    ) -> Result<Self, Failure> {
        let index = |id: &str| {
            regions
                .iter()
                .position(|r| r.id == id)
                .ok_or_else(|| fatal(format!("rods: no network region {id}")))
        };
        let positive = |name: &str, v: f64| {
            if v.is_finite() && v > 0. {
                Ok(v)
            } else {
                Err(fatal(format!(
                    "rods: {name} must be finite and positive, got {v}"
                )))
            }
        };
        let n = section.clusters.len();
        let b = &section.bodies;
        let g = &section.guide;
        let sp = &section.spider;
        for (name, v) in [
            ("body radius", b.radius_m),
            ("body length", b.length_m),
            ("body mass", b.mass_kg),
            ("spider mass", sp.mass_kg),
            ("spider volume", sp.volume_m3),
            ("spider height", sp.height_m),
            ("spider radius", sp.radius_m),
            ("bore radius", g.bore_radius_m),
            ("gravity", section.gravity_m_s2),
            ("reference travel", section.reference_travel_m),
            ("normal travel", section.normal_travel_m),
            ("holding delay", section.holding.turbine_trip_to_opening_s),
            ("lower mouth loss", g.lower_mouth_loss),
            ("upper mouth loss", g.upper_mouth_loss),
            ("passage blend speed", g.blend_speed_m_s),
            ("prepared LOWER pressure", lower_water.pressure_pa),
            ("prepared LOWER density", lower_water.density_kg_m3),
        ] {
            positive(name, v)?;
        }
        if !(lower_water.internal_energy_j_kg.is_finite()
            && lower_water.boron_concentration.is_finite()
            && lower_water.boron_concentration >= 0.)
        {
            return Err(fatal("rods: prepared LOWER water"));
        }
        if n == 0
            || b.count == 0
            || g.roughness_m < 0.
            || !g.roughness_m.is_finite()
            || b.radius_m >= g.bore_radius_m
            || g.upper_mouth_m <= g.lower_mouth_m
            || b.seated_bottom_m != g.lower_mouth_m
            || b.seated_bottom_m + b.length_m < g.upper_mouth_m
            || section.reference_travel_m > section.normal_travel_m
            || sp.seated_bottom_m < g.upper_mouth_m
            // The C1 profile joins the bodies' tops to the spider's bottom.
            || (b.seated_bottom_m + b.length_m - sp.seated_bottom_m).abs() > 1e-12
        {
            return Err(fatal(
                "rods: the bodies must be seated at the guides' lower mouths and span them, the spider above the bores on the bodies' tops",
            ));
        }
        if let SpiderDrag::EnvelopeDisk { coefficient } = section.spider_drag {
            positive("spider drag coefficient", coefficient)?;
        }
        if singles.iter().any(|c| *c >= n) {
            return Err(fatal("rods: a single cluster outside the block"));
        }
        // Bore groups: equal sector shares (bitwise), first appearance first;
        // a declared single in its own group.
        let mut groups: Vec<Group> = Vec::new();
        let mut shares_of: Vec<Option<[u64; 4]>> = Vec::new();
        let mut clusters = Vec::with_capacity(n);
        for (c, cs) in section.clusters.iter().enumerate() {
            if cs.sector_shares.iter().any(|w| !(0. ..=1.).contains(w))
                || (cs.sector_shares.iter().sum::<f64>() - 1.).abs() > 1e-14
            {
                return Err(fatal(format!(
                    "rods: {} sector shares {:?} do not close",
                    cs.id, cs.sector_shares
                )));
            }
            let key = cs.sector_shares.map(f64::to_bits);
            let single = singles.contains(&c);
            let group = match (!single)
                .then(|| shares_of.iter().position(|k| *k == Some(key)))
                .flatten()
            {
                Some(k) => {
                    groups[k].members.push(c);
                    k
                }
                None => {
                    groups.push(Group {
                        members: vec![c],
                        single,
                    });
                    shares_of.push((!single).then_some(key));
                    groups.len() - 1
                }
            };
            clusters.push(Cluster {
                id: cs.id.clone(),
                fuel_assembly: cs.fuel_assembly.clone(),
                group,
            });
        }
        let cl = &section.cells;
        let plenum = |span: &Span| -> Result<Plenum, Failure> {
            Ok(Plenum {
                index: index(&span.region)?,
                bottom: span.bottom_m,
                top: span.top_m,
            })
        };
        // The bores' spans tile the axis below the spiders: LOWER below the
        // core, the four sector columns over the core, UPPER, then
        // HOUSING.MAIN, whose plena take the bodies above the bores.
        let core = &cl.core[0];
        if !(cl.lower.top_m == core[0].bottom_m
            && cl.core.iter().all(|s| {
                s[0].bottom_m == core[0].bottom_m
                    && s[0].top_m == s[1].bottom_m
                    && s[1].top_m == core[1].top_m
            })
            && core[1].top_m == cl.upper.bottom_m
            && cl.upper.top_m == cl.housing_main.bottom_m
            && cl.lower.bottom_m <= g.lower_mouth_m
            && cl.upper.bottom_m <= g.upper_mouth_m
            && cl.upper.top_m > g.upper_mouth_m)
        {
            return Err(fatal("rods: swept cell spans do not tile the axis"));
        }
        let mut seen: Vec<usize> = std::iter::once(&cl.lower)
            .chain(cl.core.iter().flatten())
            .chain([&cl.upper, &cl.housing_main])
            .map(|s| index(&s.region))
            .collect::<Result<_, _>>()?;
        seen.sort_unstable();
        seen.dedup();
        if seen.len() != 11 || seen.iter().any(|c| *c >= regular) {
            return Err(fatal("rods: swept cells must be distinct regular cells"));
        }
        let plena = [plenum(&cl.upper)?, plenum(&cl.housing_main)?];
        let (lower, upper, main) = (index(&cl.lower.region)?, plena[0].index, plena[1].index);
        let elevation = |i: usize| regions[i].elevation_m;
        let annulus = Annulus::new(g.bore_radius_m, b.radius_m, b.count as f64).map_err(fatal)?;
        let head =
            lower_water.density_kg_m3 * section.gravity_m_s2 * (g.upper_mouth_m - g.lower_mouth_m);
        let clear_area = b.count as f64 * PI * g.bore_radius_m * g.bore_radius_m;
        let body_area = b.count as f64 * PI * b.radius_m * b.radius_m;
        // Scales: the admitted travel, the free-fall speed over it, the guide's
        // hydrostatic head, and the current a free jet would carry under it.
        let travel_scale = section.normal_travel_m;
        let speed_scale = (2. * section.gravity_m_s2 * travel_scale).sqrt();
        let current_scale = clear_area * (2. * lower_water.density_kg_m3 * head).sqrt();
        positive("guide head scale", head)?;
        // The bores' prepared water: LOWER's carried to the bores' reference.
        let z_bore = 0.5 * (g.lower_mouth_m + g.upper_mouth_m);
        let bore_pressure = lower_water.pressure_pa
            + lower_water.density_kg_m3 * section.gravity_m_s2 * (elevation(lower) - z_bore);
        let point = properties
            .caloric(
                false,
                bore_pressure,
                lower_water.internal_energy_j_kg,
                false,
            )
            .map_err(|e| fatal(format!("rods: prepared bore water: {e}")))?;
        let bore_water = properties.values(&point);
        let bore_volume = clear_area * (g.upper_mouth_m - g.lower_mouth_m);
        let inserted = g.upper_mouth_m - (b.seated_bottom_m + section.reference_travel_m);
        let free = bore_volume - body_area * inserted;
        positive("prepared free bore volume", free)?;
        let mut layout = Layout::default();
        let mut prepared =
            Vec::with_capacity(CLUSTER_COORDINATES * n + GROUP_COORDINATES * groups.len());
        for c in &clusters {
            layout.push(
                format!("y[{}]", c.id),
                Class::RodPosition,
                true,
                travel_scale,
                travel_scale,
            );
            layout.push(
                format!("v[{}]", c.id),
                Class::RodVelocity,
                false,
                speed_scale,
                speed_scale,
            );
            layout.push(
                format!("m_lower[{}]", c.id),
                Class::GuideCurrent,
                false,
                current_scale,
                head,
            );
            layout.push(
                format!("m_upper[{}]", c.id),
                Class::GuideCurrent,
                false,
                current_scale,
                head,
            );
            prepared.extend([section.reference_travel_m, 0., 0., 0.]);
        }
        for (k, grp) in groups.iter().enumerate() {
            let volume = free * grp.members.len() as f64;
            let mass = bore_water.density_kg_m3 * volume;
            let energy = mass * bore_water.internal_energy_j_kg;
            let boron = mass * lower_water.boron_concentration;
            let label = format!("bore{k}[{}]", clusters[grp.members[0]].id);
            layout.push(format!("M_{label}"), Class::PhaseMass, true, mass, mass);
            layout.push(
                format!("U_{label}"),
                Class::PhaseEnergy,
                true,
                energy.abs(),
                energy.abs(),
            );
            let boron_scale = if boron == 0. { mass * 0.001 } else { boron };
            layout.push(
                format!("B_{label}"),
                Class::Tracer,
                true,
                boron_scale,
                boron_scale,
            );
            layout.push(
                format!("p_{label}"),
                Class::CellPressure,
                false,
                bore_pressure,
                volume,
            );
            prepared.extend([mass, energy, boron, bore_pressure]);
        }
        layout.validate("rods")?;
        let mut block = Self {
            clusters,
            groups,
            regular,
            lower,
            upper,
            main,
            z_lower: elevation(lower),
            z_upper: elevation(upper),
            z_main: elevation(main),
            z_interface: cl.upper.top_m,
            z_bore,
            body_area,
            body_bottom: b.seated_bottom_m,
            body_top: b.seated_bottom_m + b.length_m,
            spider_bottom: sp.seated_bottom_m,
            spider_height: sp.height_m,
            spider_volume: sp.volume_m3,
            spider_area: PI * sp.radius_m * sp.radius_m,
            profile: Profile::new(body_area, sp.seated_bottom_m, sp.height_m, sp.volume_m3)
                .map_err(fatal)?,
            mass: b.mass_kg + sp.mass_kg,
            guide_bottom: g.lower_mouth_m,
            guide_top: g.upper_mouth_m,
            bore_volume,
            passage: Passage {
                annulus,
                clear_area,
                bore_diameter: 2. * g.bore_radius_m,
                roughness: g.roughness_m,
                lower_mouth_loss: g.lower_mouth_loss,
                upper_mouth_loss: g.upper_mouth_loss,
            },
            blend_volume_current: g.blend_speed_m_s * annulus.area,
            gravity: section.gravity_m_s2,
            reference_travel: section.reference_travel_m,
            span: (cl.lower.bottom_m, cl.housing_main.top_m),
            spider_drag: section.spider_drag,
            holding_delay: section.holding.turbine_trip_to_opening_s,
            reference_displacement: [Vec::new(), Vec::new()],
            plena,
            layout,
            prepared,
            modes: vec![Mode::Held; n],
            failed_release: vec![false; n],
            holding_open_at: None,
            capture: false,
            captured: None,
        };
        if block.z_interface >= block.z_main {
            return Err(fatal(
                "rods: HOUSING.MAIN's reference lies below its bottom plane",
            ));
        }
        block.reference_displacement = [0, 1].map(|k| {
            (0..n)
                .map(|_| {
                    block
                        .displacement(k, section.reference_travel_m)
                        .0
                })
                .collect()
        });
        Ok(block)
    }

    fn base(c: usize) -> usize {
        CLUSTER_COORDINATES * c
    }
    fn group_base(&self, g: usize) -> usize {
        CLUSTER_COORDINATES * self.clusters.len() + GROUP_COORDINATES * g
    }

    /// Displaced volume of one cluster in plenum `k` at travel `y`: its
    /// bodies above the bores and its spider on the assembly's C1 profile,
    /// with its slope and curvature in `y`.
    fn displacement(&self, k: usize, y: f64) -> (f64, f64, f64) {
        let cell = &self.plena[k];
        self.profile
            .displaced(cell.bottom.max(self.guide_top), cell.top, y)
    }

    fn admit_travel(&self, c: usize, y: f64) -> Result<(), Failure> {
        let top = self.spider_bottom + self.spider_height + y;
        if !y.is_finite()
            || self.body_bottom + y < self.span.0
            || top > self.span.1
            || self.guide_top - (self.body_bottom + y) <= 0.
        {
            return Err(recoverable(format!(
                "rods: {} travel {y} m leaves the swept-cell geometry",
                self.clusters[c].id
            )));
        }
        Ok(())
    }

    /// The passive store a seat of cluster `c` deposits its arrival energy
    /// into: its fuel assembly's top fitting ([`Rods::deposit_stores`]).
    fn fitting(&self, c: usize) -> String {
        format!("{}/top-fitting", self.clusters[c].fuel_assembly)
    }
    /// The bodies' mode, discrete retained state.
    pub fn modes(&self) -> &[Mode] {
        &self.modes
    }
    pub fn set_mode(&mut self, c: usize, mode: Mode) {
        self.modes[c] = mode;
    }
    /// The contrary case's stuck cluster (G7): its grip never releases. Only
    /// a cluster kept in its own bore group can be stuck.
    pub fn set_failed_release(&mut self, c: usize) -> Result<(), Failure> {
        self.require_single(c)?;
        self.failed_release[c] = true;
        Ok(())
    }
    /// Whether cluster `c`'s grip is declared stuck (G7).
    pub fn failed_release(&self, c: usize) -> bool {
        self.failed_release[c]
    }
    fn require_single(&self, c: usize) -> Result<(), Failure> {
        let g = &self.groups[self.clusters[c].group];
        if !g.single {
            return Err(fatal(format!(
                "rods: {} shares its bore water with {} clusters; a stuck cluster is kept singly at composition",
                self.clusters[c].id,
                g.members.len()
            )));
        }
        Ok(())
    }
    /// G7's declared malfunction ([`Command::StuckCluster`]): cluster `c`'s
    /// grip stays closed when the holding circuit opens. Only a held cluster
    /// whose release is not yet due and that was kept singly at composition
    /// can be declared, and only once; nothing moves, so no coordinate or
    /// differential identity changes.
    fn stick(&mut self, t: f64, c: usize) -> Result<Transaction, Failure> {
        let n = self.clusters.len();
        let Some(cluster) = self.clusters.get(c) else {
            return Err(fatal(format!(
                "rods: stuck cluster {c} is not one of the {n} clusters"
            )));
        };
        let id = cluster.id.clone();
        if !t.is_finite() {
            return Err(fatal("rods: stuck-cluster command time"));
        }
        if self.modes[c] != Mode::Held {
            return Err(fatal(format!(
                "rods: {id} is {:?}, not held: a stuck grip is declared before its release",
                self.modes[c]
            )));
        }
        if let Some(open) = self.holding_open_at
            && open <= t
        {
            return Err(fatal(format!(
                "rods: the holding circuit opened at {open} s, so {id}'s release is already due"
            )));
        }
        if self.failed_release[c] {
            return Err(fatal(format!("rods: {id} is already declared stuck")));
        }
        self.set_failed_release(c)?;
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"owner": "rods", "command": "StuckCluster", "t_s": t, "cluster": id, "index": c,
                "grip": "stays closed when the holding circuit opens; every other cluster releases normally (G7)",
                "holding_circuit_opens_s": self.holding_open_at}),
        })
    }
    /// The holding circuit opens at `t`: the manual reactor-trip interrupt
    /// of G7's no-turbine-trip case. The turbine TRIP opens it after the
    /// declared delay instead ([`Command::TurbineTrip`]).
    pub fn open_holding_circuit(&mut self, t: f64) -> Result<Transaction, Failure> {
        if self.holding_open_at.is_some() {
            return Err(fatal(
                "rods: the holding circuit is already open or opening",
            ));
        }
        self.holding_open_at = Some(t);
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"holding_circuit_opens_s": t, "grip_release": "at the opening (armature omitted, G3)"}),
        })
    }
    pub fn holding_open_at(&self) -> Option<f64> {
        self.holding_open_at
    }
    /// Network cell indices of LOWER, UPPER and HOUSING.MAIN.
    pub fn plena(&self) -> [usize; 3] {
        [self.lower, self.upper, self.main]
    }
    /// Moving mass of one cluster (bodies and spider), kg.
    pub fn moving_mass(&self) -> f64 {
        self.mass
    }
    /// Achieved travel of the prepared hold, m.
    pub fn reference_travel(&self) -> f64 {
        self.reference_travel
    }
    /// Network cell indices whose volume the bodies and spiders move: UPPER
    /// and HOUSING.MAIN.
    pub fn swept_cells(&self) -> Vec<usize> {
        self.plena.iter().map(|c| c.index).collect()
    }
    /// The bore groups' members, cluster indices.
    pub fn bore_groups(&self) -> Vec<Vec<usize>> {
        self.groups.iter().map(|g| g.members.clone()).collect()
    }
    /// The bore group of cluster `c`.
    pub fn group_of(&self, c: usize) -> usize {
        self.clusters[c].group
    }
    /// Index of cluster `c`'s coordinate `offset` in the block's layout.
    pub fn cluster_index(c: usize, offset: usize) -> usize {
        Self::base(c) + offset
    }
    /// Index of bore group `g`'s coordinate `offset` in the block's layout.
    pub fn group_index(&self, g: usize, offset: usize) -> usize {
        self.group_base(g) + offset
    }

    /// State conversion (P2): each bore group's `[M, U, B, p]` for the
    /// clusters' travels, velocities and lower-mouth currents of a state
    /// whose LOWER liquid is `lower`. The bores hold LOWER's water (its
    /// specific internal energy and boron) at the pressure that closes the
    /// group's first member's lower mouth balance at its current: a first
    /// estimate with the column and the lower path's segments (P2-FIX-1) on
    /// LOWER's water, then the same
    /// balance on the bores' water at that estimate (its density and
    /// viscosity), the lower mouth's loss on its donor as the rows take it.
    /// Two explicit evaluations, nothing iterated; what remains (the
    /// density's change between them, about 1e-6 kg/m3) the joined exact
    /// consistent start removes.
    pub fn bore_stocks_at<P: Properties>(
        &self,
        properties: &P,
        lower: &LowerField,
        travel: &[f64],
        velocity: &[f64],
        lower_current: &[f64],
    ) -> Result<Vec<[f64; 4]>, Failure> {
        let n = self.clusters.len();
        if travel.len() != n || velocity.len() != n || lower_current.len() != n {
            return Err(fatal(
                "rods: one travel, one velocity and one lower current per cluster",
            ));
        }
        let mouth = lower.pressure_pa
            + lower.density_kg_m3 * self.gravity * (self.z_lower - self.guide_bottom);
        let water = |pressure: f64| -> Result<Water, Failure> {
            let point = properties
                .caloric(false, pressure, lower.internal_energy_j_kg, false)
                .map_err(|e| fatal(format!("rods: converted bore water: {e}")))?;
            Ok(properties.values(&point))
        };
        let mut out = Vec::with_capacity(self.groups.len());
        for group in &self.groups {
            let c = group.members[0];
            self.admit_travel(c, travel[c])?;
            let path = self.mouth_paths(
                s(self.body_bottom + travel[c]),
                Branch::of_rate(velocity[c]),
            );
            let (current, speed) = (s(lower_current[c]), s(velocity[c]));
            // The balance with the column and the lower path's segments on
            // `(rho, mu)` and the lower mouth on its donor.
            let closing = |rho: f64, mu: f64| {
                let donor = if current.value > 0. {
                    lower.density_kg_m3
                } else {
                    rho
                };
                let loss = self.passage.lower_mouth(current, s(donor))
                    + self.passage.clear(current, s(rho), s(mu), path.lower_clear)
                    + self
                        .passage
                        .annulus(current, speed, s(rho), s(mu), path.lower_annulus)
                        .loss;
                mouth - loss.value - rho * self.gravity * (self.z_bore - self.guide_bottom)
            };
            let first = water(closing(lower.density_kg_m3, lower.viscosity_pa_s))?;
            let pressure = closing(first.density_kg_m3, first.viscosity_pa_s);
            let w = water(pressure)?;
            let mut volume = 0.;
            for &m in &group.members {
                self.admit_travel(m, travel[m])?;
                volume += self.bore_volume
                    - self.body_area * (self.guide_top - (self.body_bottom + travel[m]));
            }
            let mass = w.density_kg_m3 * volume;
            out.push([
                mass,
                mass * lower.internal_energy_j_kg,
                mass * lower.boron_concentration,
                pressure,
            ]);
        }
        Ok(out)
    }

    /// The group's free bore volume at these travels: its members' bores
    /// less their inserted bodies (the tips lie inside the bores).
    fn bore_volume_at(&self, g: usize, x: &Coordinates<'_>) -> Scalar {
        let mut volume = s(0.);
        for &c in &self.groups[g].members {
            let tip = s(self.body_bottom) + x.value(Self::base(c) + TRAVEL);
            volume = volume + s(self.bore_volume) - s(self.body_area) * (s(self.guide_top) - tip);
        }
        volume
    }
    /// The group's free volume rate: its members' travel rates.
    fn bore_volume_rate(&self, g: usize, x: &Coordinates<'_>) -> Scalar {
        let mut rate = s(0.);
        for &c in &self.groups[g].members {
            rate = rate + s(self.body_area) * x.rate(Self::base(c) + TRAVEL);
        }
        rate
    }

    /// The bores' water of group `g` at these coordinates: its maintained
    /// liquid caloric point at its pressure and specific internal energy.
    pub fn bore<P: Properties>(
        &self,
        properties: &P,
        g: usize,
        x: &Coordinates<'_>,
    ) -> Result<Bore, Failure> {
        let base = self.group_base(g);
        let (mass, energy, boron, pressure) = (
            x.value(base + BORE_MASS),
            x.value(base + BORE_ENERGY),
            x.value(base + BORE_BORON),
            x.value(base + BORE_PRESSURE),
        );
        if !(mass.value > 0. && mass.value.is_finite() && pressure.value > 0.) {
            return Err(recoverable(format!(
                "rods: bore group {g} trial mass {} kg at {} Pa",
                mass.value, pressure.value
            )));
        }
        let specific = energy / mass;
        let point = properties
            .caloric(false, pressure.value, specific.value, false)
            .map_err(|e| recoverable(format!("rods: bore group {g} water: {e}")))?;
        let w = properties.values(&point);
        let d = if pressure.direction == 0. && specific.direction == 0. {
            Water::default()
        } else {
            properties
                .direction(&point, pressure.direction, specific.direction)
                .map_err(|e| recoverable(format!("rods: bore group {g} water direction: {e}")))?
        };
        Ok(Bore {
            pressure,
            mass,
            density: scalar(&w, &d, |w| w.density_kg_m3),
            enthalpy: scalar(&w, &d, |w| w.enthalpy_j_kg),
            viscosity: scalar(&w, &d, |w| w.viscosity_pa_s),
            boron_concentration: boron / mass,
            volume: self.bore_volume_at(g, x),
        })
    }

    /// Every group's bores' water at these coordinates.
    fn bores<P: Properties>(
        &self,
        properties: &P,
        x: &Coordinates<'_>,
    ) -> Result<Vec<Bore>, Failure> {
        (0..self.groups.len())
            .map(|g| self.bore(properties, g, x))
            .collect()
    }

    /// The segments of each mouth's path to the bores' reference height
    /// `z_bore` at the tip elevation `tip` (P2-FIX-1). The lower path is the
    /// clear bore up to the tip or the reference, whichever is lower, and
    /// the annulus from a tip below the reference up to it; the upper path
    /// the clear bore from the reference up to a tip above it and the
    /// annulus from the higher of the two to the guide top. A tip at the
    /// reference takes the travel direction's side (insertion and rest:
    /// below), as the moving volumes' kinks do.
    pub fn mouth_paths(&self, tip: Scalar, branch: Branch) -> MouthPaths {
        let below =
            tip.value < self.z_bore || (tip.value == self.z_bore && branch == Branch::Insertion);
        if below {
            MouthPaths {
                lower_clear: tip - s(self.guide_bottom),
                lower_annulus: s(self.z_bore) - tip,
                upper_clear: s(0.),
                upper_annulus: s(self.guide_top - self.z_bore),
            }
        } else {
            MouthPaths {
                lower_clear: s(self.z_bore - self.guide_bottom),
                lower_annulus: s(0.),
                upper_clear: tip - s(self.z_bore),
                upper_annulus: s(self.guide_top) - tip,
            }
        }
    }

    /// The bores' pressure at elevation `z`, about their reference with
    /// their own density.
    fn bore_pressure_at(&self, bore: &Bore, z: Scalar) -> Scalar {
        bore.pressure + bore.density * s(self.gravity) * (s(self.z_bore) - z)
    }

    /// Network static pressure at elevation `z` (with its direction) along
    /// the UPPER/HOUSING.MAIN column. Each cell carries its own well-balanced
    /// head about its reference; between the interface plane and
    /// HOUSING.MAIN's reference the two reconstructions' mismatch at the
    /// interface is distributed linearly, which is the network's own face
    /// path reconstruction (`pressure_after_segments`) of the vertical
    /// UPPER-to-HOUSING.MAIN face, so the end-face pressure is continuous
    /// when a body top crosses the plane.
    fn column_pressure(&self, fluid: &Fluid<'_>, z: Scalar) -> Scalar {
        let g = s(self.gravity);
        let at = |cell: usize, reference: f64, z: Scalar| {
            fluid.cells[cell].pressure + fluid.mixture_density(cell) * g * (s(reference) - z)
        };
        let upper = |z: Scalar| at(self.upper, self.z_upper, z);
        let main = |z: Scalar| at(self.main, self.z_main, z);
        if z.value <= self.z_interface {
            upper(z)
        } else if z.value < self.z_main {
            let plane = s(self.z_interface);
            let mismatch = upper(plane) - main(plane);
            main(z) + mismatch * (s(self.z_main) - z) / s(self.z_main - self.z_interface)
        } else {
            main(z)
        }
    }

    /// Each plenum's mixture density and share of the spider's volume on
    /// the assembly's profile.
    fn spider_cells(&self, fluid: &Fluid<'_>, y: Scalar) -> [(usize, Scalar, Scalar); 2] {
        [0, 1].map(|k| {
            let cell = &self.plena[k];
            let (value, slope) = self.profile.spider_in(cell.bottom, cell.top, y.value);
            let fraction = Scalar::new(value, slope * y.direction) / s(self.spider_volume);
            (cell.index, fluid.mixture_density(cell.index), fraction)
        })
    }

    fn liquid(fluid: &Fluid<'_>, cell: usize) -> Result<Phase, Failure> {
        fluid.cells[cell].phase[0]
            .ok_or_else(|| recoverable(format!("rods: guide plenum cell {cell} has no liquid")))
    }

    /// Every force and mouth balance of cluster `c` at these coordinates,
    /// this fluid state and its group's bores' water.
    pub fn forces(
        &self,
        c: usize,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
        bore: &Bore,
    ) -> Result<Forces, Failure> {
        let base = Self::base(c);
        let (y, v, m_lo, m_up) = (
            x.value(base + TRAVEL),
            x.value(base + VELOCITY),
            x.value(base + LOWER_CURRENT),
            x.value(base + UPPER_CURRENT),
        );
        self.admit_travel(c, y.value)?;
        let branch = Branch::of_rate(x.rate(base + TRAVEL).value);
        let g = s(self.gravity);
        let (lower_liquid, upper_liquid) = (
            Self::liquid(fluid, self.lower)?,
            Self::liquid(fluid, self.upper)?,
        );
        // Each mouth's loss on the water passing it: LOWER's entering, the
        // bores' leaving; at the upper (annulus) mouth R3's C1 blend of the
        // bores' and UPPER's water over the band of the annulus volume current.
        let lower_mouth_density = if m_lo.value > 0. {
            lower_liquid.density
        } else {
            bore.density
        };
        let reversal = m_up / bore.density / s(self.blend_volume_current);
        let weight = if reversal.value >= 1. {
            s(1.)
        } else if reversal.value <= -1. {
            s(0.)
        } else {
            blend(reversal)
        };
        let upper_mouth_density = weight * bore.density + (s(1.) - weight) * upper_liquid.density;
        let lower_mouth = fluid.cells[self.lower].pressure
            + fluid.mixture_density(self.lower) * g * s(self.z_lower - self.guide_bottom);
        let upper_mouth = fluid.cells[self.upper].pressure
            + fluid.mixture_density(self.upper) * g * s(self.z_upper - self.guide_top);
        let tip = s(self.body_bottom) + y;
        // P2-FIX-1: each mouth's friction over its own path to the bores'
        // reference height, where its hydrostatics end: the clear and
        // annular segments of [guide bottom, z_bore] for the lower mouth,
        // of [z_bore, guide top] for the upper.
        let path = self.mouth_paths(tip, branch);
        let (rho, mu) = (bore.density, bore.viscosity);
        let ann_lo = self.passage.annulus(m_lo, v, rho, mu, path.lower_annulus);
        let ann_up = self.passage.annulus(m_up, v, rho, mu, path.upper_annulus);
        let (upper_mouth_loss, upper_mouth_dissipation) =
            self.passage.upper_mouth(m_up, upper_mouth_density);
        let lower_loss = self.passage.lower_mouth(m_lo, lower_mouth_density)
            + self.passage.clear(m_lo, rho, mu, path.lower_clear)
            + ann_lo.loss;
        let clear_up = self.passage.clear(m_up, rho, mu, path.upper_clear);
        let upper_loss = ann_up.loss + clear_up + upper_mouth_loss;
        let lower_residual =
            lower_mouth - self.bore_pressure_at(bore, s(self.guide_bottom)) - lower_loss;
        let upper_residual =
            self.bore_pressure_at(bore, s(self.guide_top)) - upper_mouth - upper_loss;
        let wall = ann_lo.wall_force + ann_up.wall_force;
        // The pressure the end faces see, on the path between the reference
        // and the tips: above the lower path's annulus below the reference,
        // below the upper path's clear bore above it.
        let tip_pressure = self.bore_pressure_at(bore, tip) + ann_lo.loss - clear_up;
        let top_pressure = self.column_pressure(fluid, s(self.body_top) + y);
        let end_face = s(self.body_area) * (tip_pressure - top_pressure);
        // Mixture density over the spider's height, cell by cell.
        let mut spider_density = s(0.);
        for (_, density, fraction) in self.spider_cells(fluid, y) {
            spider_density = spider_density + density * fraction;
        }
        let spider_buoyancy = spider_density * g * s(self.spider_volume);
        let spider_drag = match self.spider_drag {
            SpiderDrag::EnvelopeDisk { coefficient } => {
                s(-0.5 * coefficient * self.spider_area) * spider_density * guide::signed_square(v)
            }
            SpiderDrag::Omitted | SpiderDrag::Pending => s(0.),
        };
        let net = end_face + wall + spider_buoyancy + spider_drag - s(self.mass) * g;
        Ok(Forces {
            tip_pressure,
            top_pressure,
            end_face,
            wall,
            spider_buoyancy,
            spider_drag,
            net,
            lower_residual,
            upper_residual,
            chi: ann_up.chi,
            lower_chi: ann_lo.chi,
            annulus_dissipation: ann_lo.dissipation + ann_up.dissipation + upper_mouth_dissipation,
            lower_current: m_lo,
            upper_current: m_up,
            upper_mouth_weight: weight,
            lower_mouth_density,
            upper_mouth_density,
            bore: *bore,
        })
    }

    /// Cluster `c`'s mouth transport into the network, `(cell, [mass,
    /// enthalpy, tracer])` entering the cell, each mouth's stream from its
    /// donor by its sign: LOWER loses `m_lo`, UPPER receives `m_up`.
    #[allow(clippy::type_complexity)]
    fn transport(
        &self,
        f: &Forces,
        fluid: &Fluid<'_>,
    ) -> Result<[(usize, [Scalar; 3]); 2], Failure> {
        let (lower, upper) = (
            Self::liquid(fluid, self.lower)?,
            Self::liquid(fluid, self.upper)?,
        );
        let bore = (f.bore.enthalpy, f.bore.boron_concentration);
        let (m_lo, m_up) = (f.lower_current, f.upper_current);
        let (h_lo, c_lo) = if m_lo.value > 0. {
            (lower.enthalpy, lower.boron_concentration)
        } else {
            bore
        };
        let (h_up, c_up) = if m_up.value > 0. {
            bore
        } else {
            (upper.enthalpy, upper.boron_concentration)
        };
        Ok([
            (self.lower, [-m_lo, -m_lo * h_lo, -m_lo * c_lo]),
            (self.upper, [m_up, m_up * h_up, m_up * c_up]),
        ])
    }

    /// The moving bodies' mechanical and fluid power ledger of one cluster
    /// (W): bodies' fluid-force power, heat paid to the water (wall work to
    /// the bores, spider drag to the plena), and the boundary work the
    /// plena and the bores pay through `-p V'` on their pressures.
    pub fn power(
        &self,
        c: usize,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
        bore: &Bore,
    ) -> Result<[f64; 3], Failure> {
        let f = self.forces(c, x, fluid, bore)?;
        let base = Self::base(c);
        let v = x.value(base + VELOCITY).value;
        let fluid_force = f.net.value + self.mass * self.gravity;
        let heat = -(f.wall.value + f.spider_drag.value) * v;
        let rate = x.rate(base + TRAVEL).value;
        // -p V' of the bores (V' = A_b y') and of the plena (V' = -dD/dy y').
        let mut boundary = -bore.pressure.value * self.body_area * rate;
        for (k, cell) in self.plena.iter().enumerate() {
            let (_, slope, _) = self.displacement(k, x.value(base + TRAVEL).value);
            boundary += fluid.cells[cell.index].pressure.value * slope * rate;
        }
        Ok([fluid_force * v, heat, boundary])
    }

    /// Cluster `c`'s rows (physical: travel rate, motion or rest, the two
    /// mouth balances), its mouth transport and the spider's drag work into
    /// the plena, as [`Rods::rows`] composes them; and its forces.
    fn cluster_rows(
        &self,
        c: usize,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
        bore: &Bore,
        receipts: &mut Receipts<'_>,
    ) -> Result<([Scalar; 4], Forces), Failure> {
        let f = self.forces(c, x, fluid, bore)?;
        let base = Self::base(c);
        let (y, v) = (x.value(base + TRAVEL), x.value(base + VELOCITY));
        let travel = x.rate(base + TRAVEL) - v;
        let motion = match self.modes[c] {
            Mode::Free => {
                if self.spider_drag == SpiderDrag::Pending {
                    return Err(fatal(
                        "rods: a free body needs the S2 spider-drag selection, which is pending (envelope disk or declared omission)",
                    ));
                }
                x.rate(base + VELOCITY) - f.net / s(self.mass)
            }
            Mode::Held | Mode::Seated => v,
        };
        for (cell, [mass, enthalpy, tracer]) in self.transport(&f, fluid)? {
            receipts.add(cell, 0, mass, enthalpy, tracer)?;
        }
        let drag_work = -f.spider_drag * v;
        for (cell, _, fraction) in self.spider_cells(fluid, y) {
            if fraction.value != 0. || fraction.direction != 0. {
                receipts.heat(cell, fraction * drag_work)?;
            }
        }
        Ok(([travel, motion, f.lower_residual, f.upper_residual], f))
    }

    /// Group `g`'s rows (physical): its water's mass, energy and boron
    /// balances over its members' mouths, with the bodies' wall work and the
    /// boundary work `-p V'`, and its EOS row `M/rho - V`.
    fn group_rows(
        &self,
        g: usize,
        x: &Coordinates<'_>,
        bore: &Bore,
        members: &[Member],
    ) -> [Scalar; 4] {
        let base = self.group_base(g);
        let (mut mass, mut energy, mut boron) = (s(0.), s(0.), s(0.));
        for (c, f, [(_, lower), (_, upper)]) in members {
            // Into the bores: what leaves LOWER and what UPPER does not get.
            mass = mass - lower[0] - upper[0];
            energy = energy - lower[1] - upper[1];
            boron = boron - lower[2] - upper[2];
            let v = x.value(Self::base(*c) + VELOCITY);
            energy = energy - f.wall * v;
        }
        energy = energy - bore.pressure * self.bore_volume_rate(g, x);
        [
            x.rate(base + BORE_MASS) - mass,
            x.rate(base + BORE_ENERGY) - energy,
            x.rate(base + BORE_BORON) - boron,
            bore.mass / bore.density - bore.volume,
        ]
    }

    /// The rows of the listed local units (cluster `u < n`, bore group
    /// `u - n`), `(own row, value)`, with only the clusters' receipts.
    fn unit_rows<P: Properties>(
        &self,
        properties: &P,
        x: &Coordinates<'_>,
        fluid: &Fluid<'_>,
        units: &[usize],
        receipts: &mut Receipts<'_>,
        out: &mut Vec<(usize, Scalar)>,
    ) -> Result<(), Failure> {
        let n = self.clusters.len();
        let mut bores: Vec<Option<Bore>> = vec![None; self.groups.len()];
        let mut bore = |g: usize| -> Result<Bore, Failure> {
            if let Some(b) = bores[g] {
                return Ok(b);
            }
            let b = self.bore(properties, g, x)?;
            bores[g] = Some(b);
            Ok(b)
        };
        for &u in units {
            if u < n {
                let b = bore(self.clusters[u].group)?;
                let (r, _) = self.cluster_rows(u, x, fluid, &b, receipts)?;
                out.extend((0..CLUSTER_COORDINATES).map(|k| (Self::base(u) + k, r[k])));
            } else if u - n < self.groups.len() {
                let g = u - n;
                let b = bore(g)?;
                let mut members = Vec::with_capacity(self.groups[g].members.len());
                for &c in &self.groups[g].members {
                    let f = self.forces(c, x, fluid, &b)?;
                    let t = self.transport(&f, fluid)?;
                    members.push((c, f, t));
                }
                let r = self.group_rows(g, x, &b, &members);
                out.extend((0..GROUP_COORDINATES).map(|k| (self.group_base(g) + k, r[k])));
            } else {
                return Err(fatal(format!("rods: unit {u} outside the block")));
            }
        }
        Ok(())
    }
}

/// Whether the fluid state of `cell` carries any direction: its pressure,
/// a present phase's fraction, density, enthalpy or concentration, or a
/// caloric point's direction.
fn moved(fluid: &Fluid<'_>, cell: usize) -> bool {
    let c = &fluid.cells[cell];
    c.pressure.direction != 0.
        || c.phase.iter().flatten().any(|p| {
            [p.fraction, p.density, p.enthalpy, p.boron_concentration]
                .iter()
                .any(|v| v.direction != 0.)
        })
        || fluid.points[cell].iter().flatten().any(|(_, d)| {
            [
                d.pressure_pa,
                d.temperature_k,
                d.density_kg_m3,
                d.internal_energy_j_kg,
                d.enthalpy_j_kg,
                d.cp_j_kg_k,
                d.expansion_per_k,
                d.compressibility_per_pa,
                d.viscosity_pa_s,
                d.conductivity_w_m_k,
            ]
            .iter()
            .any(|v| *v != 0.)
        })
}

impl<P: Properties> Rods<P> for RodBlock {
    fn layout(&self) -> &Layout {
        &self.layout
    }
    fn capture_account(&mut self, on: bool) {
        self.capture = on;
    }
    fn account(&self, x: Coordinates<'_>, rows: &[Scalar]) -> Result<OwnerAccount, Failure> {
        if rows.len() != self.layout.len() || x.len() != self.layout.len() {
            return Err(fatal("rods: account layout"));
        }
        let (mut energy, mut rate) = (0., 0.);
        for c in 0..self.clusters.len() {
            let base = Self::base(c);
            let (y, v) = (x.value(base + TRAVEL).value, x.value(base + VELOCITY).value);
            energy += 0.5 * self.mass * v * v + self.mass * self.gravity * y;
            // The rows' own rates: y' = v always; v' = F_net / M for a free
            // body, whose row is v' - F_net/M. A held or seated body's row
            // is the constraint v = 0 and pays no kinetic rate.
            let travel = x.rate(base + TRAVEL).value - rows[base + TRAVEL].value;
            let acceleration = match self.modes[c] {
                Mode::Free => x.rate(base + VELOCITY).value - rows[base + VELOCITY].value,
                Mode::Held | Mode::Seated => 0.,
            };
            rate += self.mass * v * acceleration + self.mass * self.gravity * travel;
        }
        Ok(OwnerAccount {
            mechanical_j: energy,
            mechanical_rate_w: rate,
            crossings: Vec::new(),
            received_heat_w: Vec::new(),
            power: self.captured,
        })
    }
    fn prepared(&self) -> Vec<f64> {
        self.prepared.clone()
    }
    fn differential(&self) -> Vec<f64> {
        let mut ids: Vec<f64> = self
            .modes
            .iter()
            .flat_map(|mode| [1., if *mode == Mode::Free { 1. } else { 0. }, 0., 0.])
            .collect();
        for _ in &self.groups {
            ids.extend([1., 1., 1., 0.]);
        }
        ids
    }
    // S5 snapshot hook (PLATFORM, claude/ld01-s5-host; KERN reconciles):
    // every cluster's mode and declared failed release, and the holding
    // circuit's opening time.
    fn discrete_state(&self) -> serde_json::Value {
        json!({
            "modes": self.modes.iter().map(|m| match m {
                Mode::Held => "held", Mode::Free => "free", Mode::Seated => "seated",
            }).collect::<Vec<_>>(),
            "failed_release": self.failed_release,
            "holding_open_at": snapshot_time(self.holding_open_at),
        })
    }
    fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure> {
        let o = snapshot_object(
            state,
            "rods",
            &["modes", "failed_release", "holding_open_at"],
        )?;
        let n = self.clusters.len();
        let modes = o["modes"]
            .as_array()
            .filter(|a| a.len() == n)
            .ok_or_else(|| fatal("rods snapshot: one mode per cluster"))?
            .iter()
            .map(|m| match m.as_str() {
                Some("held") => Ok(Mode::Held),
                Some("free") => Ok(Mode::Free),
                Some("seated") => Ok(Mode::Seated),
                other => Err(fatal(format!("rods snapshot: mode {other:?}"))),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let failed = o["failed_release"]
            .as_array()
            .filter(|a| a.len() == n)
            .ok_or_else(|| fatal("rods snapshot: one failed-release flag per cluster"))?
            .iter()
            .map(|f| {
                f.as_bool()
                    .ok_or_else(|| fatal("rods snapshot: failed-release flag"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        for (c, stuck) in failed.iter().enumerate() {
            if *stuck {
                self.require_single(c)?;
            }
        }
        self.holding_open_at = restored_time(&o["holding_open_at"])?;
        self.modes = modes;
        self.failed_release = failed;
        Ok(())
    }
    fn next_time_event(&self, t: f64) -> Option<f64> {
        self.holding_open_at.filter(|open| *open > t)
    }
    fn time_event(&mut self, p: &P, t: f64, y: &mut [f64]) -> Result<Option<Transaction>, Failure> {
        // The holding circuit opens at `t`: every held cluster that is not
        // stuck releases here, since its release root (t - open) is exactly
        // zero at the stop and would never report a crossing. A release the
        // root already transacted left no held cluster: nothing is due.
        let directions: Vec<i32> = (0..self.clusters.len())
            .map(|c| i32::from(self.modes[c] == Mode::Held && !self.failed_release[c]))
            .collect();
        if self.holding_open_at != Some(t) || directions.iter().all(|d| *d == 0) {
            return Ok(None);
        }
        Rods::<P>::transact(self, p, t, &directions, y).map(Some)
    }
    /// Startup: the bores' water is prepared as LOWER's composed water
    /// carried to the bores' reference on LOWER's density, at LOWER's
    /// specific internal energy and boron, each group at its free volume at
    /// the prepared travel; the mouth currents stay zero. Nothing is solved
    /// here (DR13-ROD): the joined exact consistent start solves the
    /// currents and the bores' pressures.
    fn prepare(&mut self, properties: &P, fluid: &Fluid<'_>) -> Result<Transaction, Failure> {
        let liquid = Self::liquid(fluid, self.lower)?;
        let (point, _) = fluid.points[self.lower][0]
            .ok_or_else(|| fatal("rods: LOWER has no liquid point to prepare the bores"))?;
        let pressure = fluid.cells[self.lower].pressure.value
            + liquid.density.value * self.gravity * (self.z_lower - self.z_bore);
        let w = properties
            .caloric(false, pressure, point.internal_energy_j_kg, false)
            .map_err(|e| fatal(format!("rods: prepared bore water: {e}")))?;
        let w = properties.values(&w);
        let inserted = self.guide_top - (self.body_bottom + self.reference_travel);
        let free = self.bore_volume - self.body_area * inserted;
        let mut groups = Vec::with_capacity(self.groups.len());
        for g in 0..self.groups.len() {
            let volume = free * self.groups[g].members.len() as f64;
            let mass = w.density_kg_m3 * volume;
            let base = self.group_base(g);
            self.prepared[base + BORE_MASS] = mass;
            self.prepared[base + BORE_ENERGY] = mass * w.internal_energy_j_kg;
            self.prepared[base + BORE_BORON] = mass * liquid.boron_concentration.value;
            self.prepared[base + BORE_PRESSURE] = pressure;
            groups.push(json!({"members": self.groups[g].members, "mass_kg": mass}));
        }
        Ok(Transaction {
            deposits: Vec::new(),
            receipt: json!({"rods": "bore water prepared as LOWER's composed water at the bores' reference; mouth currents zero; the joined consistent start solves the algebraic coordinates (DR13-ROD)",
                "bore_pressure_pa": pressure, "bore_density_kg_m3": w.density_kg_m3, "bore_groups": groups}),
        })
    }
    fn prepared_stocks(&self) -> Vec<usize> {
        (0..self.groups.len())
            .flat_map(|g| {
                let base = self.group_base(g);
                [base + BORE_MASS, base + BORE_ENERGY, base + BORE_BORON]
            })
            .collect()
    }
    fn deposit_stores(&self) -> Vec<String> {
        (0..self.clusters.len()).map(|c| self.fitting(c)).collect()
    }
    fn clusters(&self) -> usize {
        self.clusters.len()
    }
    fn travel(&self, x: Coordinates<'_>, out: &mut [Scalar]) -> Result<(), Failure> {
        if out.len() != self.clusters.len() || x.len() != self.layout.len() {
            return Err(fatal("rods: travel layout"));
        }
        for (c, t) in out.iter_mut().enumerate() {
            *t = x.value(Self::base(c) + TRAVEL);
        }
        Ok(())
    }
    fn volumes(
        &self,
        x: Coordinates<'_>,
        compiled_m3: &[f64],
        out: &mut [CellVolume],
    ) -> Result<(), Failure> {
        if out.len() != compiled_m3.len()
            || compiled_m3.len() != self.regular
            || x.len() != self.layout.len()
        {
            return Err(fatal("rods: cell volume layout"));
        }
        for (o, v) in out.iter_mut().zip(compiled_m3) {
            *o = CellVolume {
                volume_m3: s(*v),
                rate_m3_s: s(0.),
            };
        }
        for c in 0..self.clusters.len() {
            self.admit_travel(c, x.value(Self::base(c) + TRAVEL).value)?;
        }
        for (k, cell) in self.plena.iter().enumerate() {
            let mut volume = s(compiled_m3[cell.index]);
            let mut rate = s(0.);
            for c in 0..self.clusters.len() {
                let y = x.value(Self::base(c) + TRAVEL);
                let r = x.rate(Self::base(c) + TRAVEL);
                let (d, slope, curvature) = self.displacement(k, y.value);
                // V = V_compiled + D(y_ref) - D(y); V' = -dD/dy y'.
                volume = volume
                    + Scalar::new(self.reference_displacement[k][c] - d, -slope * y.direction);
                rate = rate - Scalar::new(slope, curvature * y.direction) * r;
            }
            out[cell.index] = CellVolume {
                volume_m3: volume,
                rate_m3_s: rate,
            };
        }
        Ok(())
    }
    fn rows(
        &mut self,
        properties: &P,
        _: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure> {
        if rows.len() != self.layout.len() || x.len() != self.layout.len() {
            return Err(fatal("rods: row layout"));
        }
        let n = self.clusters.len();
        let bores = self.bores(properties, &x)?;
        let mut members: Vec<Vec<Member>> = vec![Vec::new(); self.groups.len()];
        for c in 0..n {
            let g = self.clusters[c].group;
            let (r, f) = self.cluster_rows(c, &x, fluid, &bores[g], receipts)?;
            rows[Self::base(c)..Self::base(c) + CLUSTER_COORDINATES].copy_from_slice(&r);
            let t = self.transport(&f, fluid)?;
            members[g].push((c, f, t));
        }
        for (g, bore) in bores.iter().enumerate() {
            let r = self.group_rows(g, &x, bore, &members[g]);
            let base = self.group_base(g);
            rows[base..base + GROUP_COORDINATES].copy_from_slice(&r);
        }
        // A value evaluation replaces the record: the captured ledger is
        // always the last value evaluation's, or none.
        if !x.seeded() {
            self.captured = None;
            if self.capture {
                let mut ledger = [0.; 3];
                for c in 0..n {
                    let b = &bores[self.clusters[c].group];
                    for (sum, part) in ledger.iter_mut().zip(self.power(c, &x, fluid, b)?) {
                        *sum += part;
                    }
                }
                self.captured = Some(ledger);
            }
        }
        Ok(())
    }
    fn rows_local(
        &mut self,
        properties: &P,
        _: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        clusters: &[usize],
        receipts: &mut Receipts<'_>,
        out: &mut Vec<(usize, Scalar)>,
    ) -> Result<(), Failure> {
        out.clear();
        if x.len() != self.layout.len() {
            return Err(fatal("rods: row layout"));
        }
        self.unit_rows(properties, &x, fluid, clusters, receipts, out)
    }
    /// The local units (cluster `u < n`, bore group `u - n`) whose rows or
    /// receipts read a listed moved cell: every unit reads LOWER, UPPER or
    /// HOUSING.MAIN, and no unit reads another cell.
    fn readers(
        &self,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        cells: &[usize],
        _faces: &[usize],
        out: &mut Vec<usize>,
    ) -> Result<(), Failure> {
        out.clear();
        if x.len() != self.layout.len() {
            return Err(fatal("rods: reader layout"));
        }
        if cells.iter().any(|c| {
            *c < self.regular && [self.lower, self.upper, self.main].contains(c) && moved(fluid, *c)
        }) {
            out.extend(0..self.clusters.len() + self.groups.len());
        }
        Ok(())
    }
    /// The local units reading own coordinate `i`: a cluster's are read by
    /// itself and its bore group, a group's by itself and its members.
    fn coordinate_readers(&self, i: usize, out: &mut Vec<usize>) -> Result<(), Failure> {
        out.clear();
        if i >= self.layout.len() {
            return Err(fatal(format!("rods: coordinate {i} outside the block")));
        }
        let n = self.clusters.len();
        let cluster_end = CLUSTER_COORDINATES * n;
        if i < cluster_end {
            let c = i / CLUSTER_COORDINATES;
            out.extend([c, n + self.clusters[c].group]);
        } else {
            let g = (i - cluster_end) / GROUP_COORDINATES;
            out.push(n + g);
            out.extend(self.groups[g].members.iter().copied());
        }
        Ok(())
    }
    fn structure(&self) -> Structure {
        let n = self.clusters.len();
        let plena = vec![self.lower, self.upper, self.main];
        let rows = self.layout.len();
        let mut st = Structure {
            own: Vec::with_capacity(rows),
            cells: Vec::with_capacity(rows),
            faces: vec![Vec::new(); rows],
            heat: vec![Vec::new(); rows],
            receipts: Vec::new(),
            volumes: Vec::new(),
            outputs: (0..n).map(|c| vec![Self::base(c) + TRAVEL]).collect(),
        };
        let group_state = |g: usize| -> Vec<usize> {
            (0..GROUP_COORDINATES)
                .map(|k| self.group_base(g) + k)
                .collect()
        };
        for c in 0..n {
            let base = Self::base(c);
            let own: Vec<usize> = (0..CLUSTER_COORDINATES)
                .map(|k| base + k)
                .chain(group_state(self.clusters[c].group))
                .collect();
            st.own.push(vec![base + TRAVEL, base + VELOCITY]);
            st.cells.push(Vec::new());
            for _ in 1..CLUSTER_COORDINATES {
                st.own.push(own.clone());
                st.cells.push(plena.clone());
            }
        }
        for (g, group) in self.groups.iter().enumerate() {
            let own: Vec<usize> = group
                .members
                .iter()
                .flat_map(|c| (0..CLUSTER_COORDINATES).map(move |k| Self::base(*c) + k))
                .chain(group_state(g))
                .collect();
            for _ in 0..GROUP_COORDINATES {
                st.own.push(own.clone());
                st.cells.push(plena.clone());
            }
        }
        // Receipts: the mouths' transport into LOWER and UPPER and the
        // spiders' drag work into UPPER and HOUSING.MAIN, each reading its
        // cluster and its bore group, and the plena.
        let writers: Vec<usize> = (0..rows).collect();
        for cell in [self.lower, self.upper, self.main] {
            st.receipts.push((cell, writers.clone(), plena.clone()));
        }
        for cell in &self.plena {
            st.volumes
                .push((cell.index, (0..n).map(|c| Self::base(c) + TRAVEL).collect()));
        }
        st
    }
    fn root_count(&self) -> usize {
        self.clusters.len()
    }
    /// Only a seated body's lift-off root reads the fluid (its forces);
    /// release and seat roots read time and travel.
    fn roots_read_fluid(&self) -> bool {
        self.modes.contains(&Mode::Seated)
    }
    /// The clusters whose upper (annulus) mouth's volume current lies
    /// strictly inside R3's band, on the bores' density `M/V` (their EOS
    /// row's value at a solved state).
    fn r3_band(&self, x: Coordinates<'_>, _: &Fluid<'_>) -> Result<usize, Failure> {
        Ok((0..self.clusters.len())
            .filter(|&c| {
                let g = self.clusters[c].group;
                let density = x.value(self.group_base(g) + BORE_MASS).value
                    / self.bore_volume_at(g, &x).value;
                let m_up = x.value(Self::base(c) + UPPER_CURRENT).value;
                (m_up / density / self.blend_volume_current).abs() < 1.
            })
            .count())
    }
    fn roots(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure> {
        if out.len() != self.clusters.len() {
            return Err(fatal("rods: root layout"));
        }
        for (c, root) in out.iter_mut().enumerate() {
            *root = match self.modes[c] {
                // Release when the holding circuit opens, unless stuck.
                Mode::Held => match self.holding_open_at {
                    Some(open) if !self.failed_release[c] => t - open,
                    _ => 1.,
                },
                // Seat at zero travel.
                Mode::Free => x.value(Self::base(c) + TRAVEL).value,
                // Lift-off when the seat would have to pull.
                Mode::Seated => {
                    let bore = self.bore(properties, self.clusters[c].group, &x)?;
                    -self.forces(c, &x, fluid, &bore)?.net.value
                }
            };
        }
        Ok(())
    }
    /// The bank seat (E-EVT, plan r4): the free clusters have one law and
    /// one datum, so a bank released by one holding opening reaches its
    /// seats as one physical event, and only the integration's error
    /// separates their located roots. When a free cluster's seat root is
    /// located, every other free, descending cluster whose travel is zero
    /// within its own error weight (`0 <= y w <= 1`) seats in the same
    /// transaction. Its residue is reported as the located one's is.
    fn coincident(
        &self,
        y: &[f64],
        weights: &[f64],
        directions: &mut [i32],
    ) -> Result<usize, Failure> {
        let n = self.clusters.len();
        if directions.len() != n || y.len() != self.layout.len() || weights.len() != y.len() {
            return Err(fatal("rods: coincident-root layout"));
        }
        if !(0..n).any(|c| directions[c] < 0 && self.modes[c] == Mode::Free) {
            return Ok(0);
        }
        let mut added = 0;
        for (c, direction) in directions.iter_mut().enumerate() {
            let base = Self::base(c);
            let (travel, weight) = (y[base + TRAVEL], weights[base + TRAVEL]);
            if *direction == 0
                && self.modes[c] == Mode::Free
                && y[base + VELOCITY] < 0.
                && travel >= 0.
                && travel * weight <= 1.
            {
                *direction = -1;
                added += 1;
            }
        }
        Ok(added)
    }
    fn transact(
        &mut self,
        _: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure> {
        if directions.len() != self.clusters.len() || y.len() != self.layout.len() {
            return Err(fatal("rods: transaction layout"));
        }
        let mut deposits = Vec::new();
        let mut events = Vec::new();
        for (c, &direction) in directions.iter().enumerate() {
            if direction == 0 {
                continue;
            }
            let id = &self.clusters[c].id;
            let base = Self::base(c);
            match self.modes[c] {
                Mode::Held => {
                    let open = self.holding_open_at.ok_or_else(|| {
                        fatal(format!(
                            "rods: {id} released with the holding circuit closed"
                        ))
                    })?;
                    if self.failed_release[c] || t < open {
                        return Err(fatal(format!(
                            "rods: {id} release root without its release"
                        )));
                    }
                    self.modes[c] = Mode::Free;
                    events.push(json!({"cluster": id, "event": "grip release", "t_s": t, "travel_m": y[base + TRAVEL]}));
                }
                Mode::Free => {
                    if direction > 0 {
                        return Err(fatal(format!("rods: {id} crossed its seat upward")));
                    }
                    // Fully inelastic seat: the arrival energy enters the
                    // contacted fitting once; the body rests on the seat.
                    let speed = y[base + VELOCITY];
                    let energy = 0.5 * self.mass * speed * speed;
                    let residue = y[base + TRAVEL];
                    y[base + TRAVEL] = 0.;
                    y[base + VELOCITY] = 0.;
                    self.modes[c] = Mode::Seated;
                    let store = self.fitting(c);
                    deposits.push((store.clone(), energy));
                    events.push(json!({"cluster": id, "event": "seat", "t_s": t, "arrival_speed_m_s": speed, "arrival_energy_j": energy, "fitting": store, "located_travel_residue_m": residue, "potential_energy_residue_j": self.mass * self.gravity * residue}));
                }
                Mode::Seated => {
                    if direction > 0 {
                        return Err(fatal(format!("rods: {id} seat reaction rose through zero")));
                    }
                    self.modes[c] = Mode::Free;
                    events.push(json!({"cluster": id, "event": "lift-off", "t_s": t}));
                }
            }
        }
        Ok(Transaction {
            deposits,
            receipt: json!({"rods": events}),
        })
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure> {
        match command {
            Command::StuckCluster { cluster } => self.stick(t, cluster),
            // C3's initiator is the network's (a rotor's supply); the rods
            // schedule nothing for it.
            Command::SupplyLoss { rotor } => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"supply_loss_rotor": rotor, "t_s": t, "holding": "unchanged"}),
            }),
            // HOOK (C4 lane): C4's relief malfunction is the PZR owner's;
            // the rods schedule nothing for it.
            Command::ReliefStuckOpen => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"relief_stuck_open": true, "t_s": t, "holding": "unchanged"}),
            }),
            Command::ManualReactorTrip => self.open_holding_circuit(t),
            // S3 (C16, acquired protection): with acquired protection the
            // turbine TRIP schedules nothing here; the protection's holding
            // path opens the circuit at its decided instant.
            Command::HoldingLoss => self.open_holding_circuit(t),
            Command::TurbineTripAcquired => Ok(Transaction {
                deposits: Vec::new(),
                receipt: json!({"turbine_trip_s": t, "holding": "the reactor-trip request travels the acquired protection; no declared opening (S3, C16)"}),
            }),
            Command::TurbineTrip => {
                let open = t + self.holding_delay;
                if self.holding_open_at.is_some() {
                    return Err(fatal(
                        "rods: the holding circuit is already open or opening",
                    ));
                }
                self.holding_open_at = Some(open);
                Ok(Transaction {
                    deposits: Vec::new(),
                    receipt: json!({"turbine_trip_s": t, "holding_circuit_opens_s": open, "declared_delay_s": self.holding_delay, "grip_release": "at the opening (armature omitted, G3)"}),
                })
            }
        }
    }
}

//! The rod block (P2: the bores' water as its own state) on explicit
//! fixtures: the record geometry restated here, the retained at-power field
//! of the Z4 disposition with its printed water properties (research
//! `operating-joined-spine-s2/dispositions/z4-receipt.json`) and a
//! differentiable liquid anchored at Z4's LOWER water for the bores' caloric
//! points. Sector shares are synthetic. Neither is a compiled packet or an
//! S2 state; the actual-packet receipt lives in water-ffi.
use leitbild_operating_plant::{
    joined::block::{CellVolume, Command, Coordinates, Fluid, Receipts, Rods},
    local_flow::{Cell, Phase},
    network::{Band, BandReport, MetastableBand, Properties, Water},
    rods::{
        BORE_BORON, BORE_ENERGY, BORE_MASS, BORE_PRESSURE, Bodies, CLUSTER_COORDINATES, Cells,
        ClusterSection, Guide, Holding, LOWER_CURRENT, LowerWater, Mode, Region, RodBlock, Section,
        Span, Spider, SpiderDrag, Stem, TRAVEL, UPPER_CURRENT, VELOCITY, geometry::Branch,
    },
    sparse::{Coloring, Pattern, compare_with_dense, scatter},
    thermal::{Saturation, Scalar},
};
use std::time::Instant;

const G: f64 = 9.80665;
const REGIONS: [(&str, f64); 13] = [
    ("LOWER", -3.),
    ("CORE.NE.1", -1.),
    ("CORE.NE.2", 1.),
    ("CORE.NW.1", -1.),
    ("CORE.NW.2", 1.),
    ("CORE.SW.1", -1.),
    ("CORE.SW.2", 1.),
    ("CORE.SE.1", -1.),
    ("CORE.SE.2", 1.),
    ("UPPER", 3.),
    ("HOUSING.MAIN", 6.),
    ("HOUSING.NECK", 10.825),
    ("PZR", 18.5),
];
const REGULAR: usize = 12;
const VOLUMES: [f64; 12] = [
    28.1789708, 2.5690191, 2.5369520, 2.5690191, 2.5369520, 2.5690191, 2.5369520, 2.5690191,
    2.5369520, 32.0833548, 10.0618815, 0.5445115,
];
/// R4-ROD2-STEM: the record's 12 mm, 6 m stainless stem (7920 kg/m3) as the
/// fixture's named stem mass; the drive-rod mass of record is the packet's.
const STEM_RADIUS: f64 = 0.006;
const STEM_LENGTH: f64 = 6.;
fn stem_mass() -> f64 {
    std::f64::consts::PI * STEM_RADIUS * STEM_RADIUS * STEM_LENGTH * 7920.
}
const N: usize = 52;

// Z4's LOWER water (connected-primary-initialization.md :308): 15.2 MPa at
// -2 m, 563.15 K, IF97 density and viscosity as printed; the fixture's
// enthalpy and boron.
const RHO_L: f64 = 745.708757;
const MU_L: f64 = 9.238812e-05;
const H_L: f64 = 1.2715e6;
const T_L: f64 = 563.15;
/// LOWER's pressure at its reference (-3 m).
fn p_lower() -> f64 {
    15_200_000. + RHO_L * G
}
fn u_lower() -> f64 {
    H_L - p_lower() / RHO_L
}

/// A differentiable compressible liquid anchored at Z4's LOWER water:
/// `rho = rho_L exp(KAPPA (p - p_L) - BETA (T - T_L))`, `u = u_L + CU (T -
/// T_L)`, constant viscosity. A fixture of the property interface, not
/// plant data.
const KAPPA: f64 = 1.4e-9;
const BETA: f64 = 2.4e-3;
const CU: f64 = 5350.;
#[derive(Clone, Copy)]
struct Liquid;
fn liquid(p: f64, t: f64) -> Water {
    let density = RHO_L * (KAPPA * (p - p_lower()) - BETA * (t - T_L)).exp();
    let u = u_lower() + CU * (t - T_L);
    Water {
        pressure_pa: p,
        temperature_k: t,
        density_kg_m3: density,
        internal_energy_j_kg: u,
        enthalpy_j_kg: u + p / density,
        cp_j_kg_k: CU + p * BETA / density,
        expansion_per_k: BETA,
        compressibility_per_pa: KAPPA,
        viscosity_pa_s: MU_L,
        conductivity_w_m_k: 0.55,
    }
}
impl Properties for Liquid {
    type Caloric = Water;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        if vapor {
            return Err("liquid fixture".into());
        }
        Ok(liquid(p, t))
    }
    fn caloric(&self, vapor: bool, p: f64, u: f64, enthalpy: bool) -> Result<Water, String> {
        if vapor || enthalpy || !(p.is_finite() && p > 0. && u.is_finite()) {
            return Err("outside the liquid fixture".into());
        }
        Ok(liquid(p, T_L + (u - u_lower()) / CU))
    }
    fn values(&self, point: &Water) -> Water {
        *point
    }
    fn direction(&self, w: &Water, dp: f64, du: f64) -> Result<Water, String> {
        let dt = du / CU;
        let rho = w.density_kg_m3;
        let drho = rho * (KAPPA * dp - BETA * dt);
        Ok(Water {
            pressure_pa: dp,
            temperature_k: dt,
            density_kg_m3: drho,
            internal_energy_j_kg: du,
            enthalpy_j_kg: du + dp / rho - w.pressure_pa * drho / (rho * rho),
            ..Water::default()
        })
    }
    fn saturation(&self, _: Scalar) -> Result<Saturation, String> {
        Err("liquid fixture".into())
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        Err("liquid fixture".into())
    }
    fn band(&self, _: &Water) -> BandReport {
        BandReport {
            departure_k: 0.,
            band: Band::Stable,
        }
    }
}

fn span(region: &str, bottom: f64, top: f64) -> Span {
    Span {
        region: region.into(),
        bottom_m: bottom,
        top_m: top,
    }
}
fn shares(c: usize) -> [f64; 4] {
    let mut shares = [0.; 4];
    if c.is_multiple_of(13) {
        shares[c % 4] = 0.5;
        shares[(c + 1) % 4] = 0.5;
    } else {
        shares[c % 4] = 1.;
    }
    shares
}
fn section(drag: SpiderDrag) -> Section {
    let clusters = (0..N)
        .map(|c| ClusterSection {
            id: format!("LD01.CR.{:03}", c + 1),
            fuel_assembly: format!("FA{c}"),
            lattice: [0, 0],
            sector_shares: shares(c),
        })
        .collect();
    let core = ["NE", "NW", "SW", "SE"].map(|k| {
        [
            span(&format!("CORE.{k}.1"), -2., 0.),
            span(&format!("CORE.{k}.2"), 0., 2.),
        ]
    });
    Section {
        identity: "fixture".into(),
        clusters,
        // The record: 24 bodies of 9.5 mm, 4.65 m seated at -2.25 m; B4C and
        // steel 14.597 + 16.407 kg; the 4 kg spider at +2.40..+2.50 m.
        bodies: Bodies {
            count: 24,
            radius_m: 0.00475,
            length_m: 4.65,
            seated_bottom_m: -2.25,
            mass_kg: 14.597096105639615 + 16.407177491761953,
        },
        spider: Spider {
            mass_kg: 4.,
            volume_m3: 4. / 7920.,
            seated_bottom_m: 2.4,
            height_m: 0.1,
            radius_m: 0.115,
        },
        stem: Stem {
            mass_kg: stem_mass(),
            radius_m: STEM_RADIUS,
            length_m: STEM_LENGTH,
        },
        guide: Guide {
            bore_radius_m: 0.0055,
            lower_mouth_m: -2.25,
            upper_mouth_m: 2.4,
            roughness_m: 2e-6,
            lower_mouth_loss: 0.5,
            upper_mouth_loss: 0.5,
            blend_speed_m_s: 1e-3,
        },
        cells: Cells {
            lower: span("LOWER", -6.9, -2.),
            core,
            upper: span("UPPER", 2., 4.),
            housing_main: span("HOUSING.MAIN", 4., 8.),
            housing_neck: span("HOUSING.NECK", 8.05, 13.6),
        },
        gravity_m_s2: G,
        reference_travel_m: 2.8,
        normal_travel_m: 4.,
        holding: Holding {
            turbine_trip_to_opening_s: 0.2,
        },
        spider_drag: drag,
        provenance: Vec::new(),
    }
}
fn lower_water() -> LowerWater {
    LowerWater {
        pressure_pa: p_lower(),
        density_kg_m3: RHO_L,
        internal_energy_j_kg: u_lower(),
        boron_concentration: 1e-3,
    }
}
fn block_with(drag: SpiderDrag, singles: &[usize]) -> RodBlock {
    let regions: Vec<Region<'_>> = REGIONS
        .iter()
        .map(|(id, z)| Region {
            id,
            elevation_m: *z,
        })
        .collect();
    RodBlock::new(
        &section(drag),
        &regions,
        REGULAR,
        &lower_water(),
        &Liquid,
        singles,
    )
    .unwrap()
}
/// E-NUC: every cluster declared single, so each is its own motion class
/// and the per-cluster tests see per-cluster coordinates.
fn block(drag: SpiderDrag) -> RodBlock {
    block_with(drag, &(0..N).collect::<Vec<_>>())
}
/// The fixture's bore groups as motion classes (nothing declared single).
fn grouped_block(drag: SpiderDrag) -> RodBlock {
    block_with(drag, &[])
}
fn layout(b: &RodBlock) -> &leitbild_operating_plant::joined::block::Layout {
    Rods::<Liquid>::layout(b)
}
fn ci(b: &RodBlock, c: usize, k: usize) -> usize {
    b.cluster_index(c, k)
}

/// One cell's water: pressure at its reference, liquid density, viscosity,
/// enthalpy and boron concentration, each with an explicit direction.
#[derive(Clone, Copy)]
struct Water1 {
    p: Scalar,
    rho: Scalar,
    mu: Scalar,
    h: Scalar,
    c: Scalar,
}
/// The retained at-power field of Z4: LOWER 15.2 MPa at -2 m (563.15 K),
/// UPPER 15,056,166 Pa at +2 m (593.15 K); HOUSING.MAIN and HOUSING.NECK
/// share UPPER's water at rest. Densities and viscosities are Z4's IF97 values as printed.
fn z4_field(upper_shift_pa: f64) -> Vec<Water1> {
    let (ru, mu) = (678.920757, 8.023731e-05);
    let pu = 15_056_166. - upper_shift_pa - ru * G * (3. - 2.);
    let pm = 15_056_166. - upper_shift_pa - ru * G * (6. - 2.);
    let pn = 15_056_166. - upper_shift_pa - ru * G * (10.825 - 2.);
    let w = |p: f64, rho: f64, mu: f64, h: f64| Water1 {
        p: Scalar::constant(p),
        rho: Scalar::constant(rho),
        mu: Scalar::constant(mu),
        h: Scalar::constant(h),
        c: Scalar::constant(1e-3),
    };
    let core = w(15.1e6, 715.3, 8.6e-5, 1.39e6);
    let mut cells = vec![w(p_lower(), RHO_L, MU_L, H_L)];
    cells.extend([core; 8]);
    cells.push(w(pu, ru, mu, 1.4545e6));
    cells.push(w(pm, ru, mu, 1.4545e6));
    cells.push(w(pn, ru, mu, 1.4545e6));
    cells
}
struct FluidData {
    cells: Vec<Cell>,
    points: Vec<[Option<(Water, Water)>; 2]>,
    zeros: Vec<Scalar>,
    elevations: Vec<f64>,
    volumes: Vec<f64>,
    current: Vec<Scalar>,
}
fn fluid_data(water: &[Water1]) -> FluidData {
    let mut cells: Vec<Cell> = water
        .iter()
        .map(|w| Cell {
            pressure: w.p,
            phase: [
                Some(Phase {
                    fraction: Scalar::constant(1.),
                    density: w.rho,
                    enthalpy: w.h,
                    boron_concentration: w.c,
                }),
                None,
            ],
        })
        .collect();
    cells.push(cells[REGULAR - 1]);
    let points = water
        .iter()
        .map(|w| {
            let value = Water {
                pressure_pa: w.p.value,
                density_kg_m3: w.rho.value,
                enthalpy_j_kg: w.h.value,
                viscosity_pa_s: w.mu.value,
                ..Water::default()
            };
            let direction = Water {
                pressure_pa: w.p.direction,
                density_kg_m3: w.rho.direction,
                enthalpy_j_kg: w.h.direction,
                viscosity_pa_s: w.mu.direction,
                ..Water::default()
            };
            [Some((value, direction)), None]
        })
        .collect();
    let mut volumes = VOLUMES.to_vec();
    volumes.push(59.7);
    FluidData {
        cells,
        points,
        zeros: vec![Scalar::constant(0.); REGULAR],
        elevations: REGIONS.iter().map(|r| r.1).collect(),
        current: VOLUMES.iter().map(|v| Scalar::constant(*v)).collect(),
        volumes,
    }
}
fn fluid(d: &FluidData) -> Fluid<'_> {
    Fluid {
        cells: &d.cells,
        points: &d.points,
        liquid_mass: &d.zeros,
        vapor_mass: &d.zeros,
        tracer: &d.zeros,
        charts: &[],
        endpoints: &[],
        elevations: &d.elevations,
        volumes: &d.volumes,
        current_volumes: &d.current,
    }
}
fn solver(b: &RodBlock, physical: &[f64]) -> Vec<f64> {
    physical
        .iter()
        .zip(&layout(b).scales)
        .map(|(v, s)| v / s)
        .collect()
}
fn rates(b: &RodBlock, physical: &[f64]) -> Vec<f64> {
    solver(b, physical)
}
/// Rows, the per-cell receipts and the moving volumes of one evaluation.
fn evaluate(
    b: &mut RodBlock,
    y: &[f64],
    yp: &[f64],
    seed: Option<&[f64]>,
    cj: f64,
    water: &[Water1],
) -> (Vec<Scalar>, Vec<[[Scalar; 3]; 2]>, Vec<CellVolume>) {
    let d = fluid_data(water);
    let f = fluid(&d);
    let mut rows = vec![Scalar::constant(0.); y.len()];
    let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
    let scales = layout(b).scales.clone();
    let x = Coordinates::new(y, yp, seed, cj, &scales).unwrap();
    Rods::<Liquid>::rows(
        b,
        &Liquid,
        0.,
        x,
        &f,
        &mut Receipts::new(&mut cells),
        &mut rows,
    )
    .unwrap();
    let mut volumes = vec![
        CellVolume {
            volume_m3: Scalar::constant(0.),
            rate_m3_s: Scalar::constant(0.)
        };
        REGULAR
    ];
    Rods::<Liquid>::volumes(b, x, &VOLUMES, &mut volumes).unwrap();
    (rows, cells, volumes)
}

/// Set every group's bores' pressure so that member `probe`'s lower mouth
/// balance holds at its current, and the group's mass to its EOS row's
/// value there (explicit: one linear correction of a near-linear balance
/// and one forward property evaluation, no iteration).
fn steady_bores(b: &RodBlock, physical: &mut [f64], water: &[Water1]) {
    // Two explicit corrections: since P2-FIX-1 a pose below the reference
    // puts the lower path's annulus (tens of kPa) into the first, whose
    // column compressibility (2e-5 of it) the second removes.
    for _ in 0..2 {
        steady_bores_once(b, physical, water);
    }
}

fn steady_bores_once(b: &RodBlock, physical: &mut [f64], water: &[Water1]) {
    let d = fluid_data(water);
    let f = fluid(&d);
    for (g, members) in b.bore_groups().iter().enumerate() {
        let probe = members[0];
        let y = solver(b, physical);
        let yp = vec![0.; y.len()];
        let x = Coordinates::new(&y, &yp, None, 0., &layout(b).scales).unwrap();
        let bore = b.bore(&Liquid, g, &x).unwrap();
        let forces = b.forces(probe, &x, &f, &bore).unwrap();
        // The lower balance falls one-for-one with the bores' reference
        // pressure (to the column's compressibility, 2e-5).
        let p = physical[b.group_index(g, BORE_PRESSURE)] + forces.lower_residual.value;
        let mass = physical[b.group_index(g, BORE_MASS)];
        let u = physical[b.group_index(g, BORE_ENERGY)] / mass;
        let w = Liquid.caloric(false, p, u, false).unwrap();
        let volume = bore.volume.value;
        let m = w.density_kg_m3 * volume;
        physical[b.group_index(g, BORE_PRESSURE)] = p;
        physical[b.group_index(g, BORE_ENERGY)] = m * u;
        physical[b.group_index(g, BORE_BORON)] *= m / mass;
        physical[b.group_index(g, BORE_MASS)] = m;
    }
}

/// Every cluster held at `travel` with both mouth currents `current` and the
/// bores at the matching steady pressure.
fn held(b: &mut RodBlock, water: &[Water1], travel: f64, current: f64) -> Vec<f64> {
    for c in 0..N {
        b.set_mode(c, Mode::Held);
    }
    let mut physical = Rods::<Liquid>::prepared(b);
    for c in 0..N {
        physical[ci(b, c, TRAVEL)] = travel;
        physical[ci(b, c, LOWER_CURRENT)] = current;
        physical[ci(b, c, UPPER_CURRENT)] = current;
    }
    // The groups' prepared water at their free volume at this travel.
    let y = solver(b, &physical);
    let yp = vec![0.; y.len()];
    for g in 0..b.bore_groups().len() {
        let x = Coordinates::new(&y, &yp, None, 0., &layout(b).scales).unwrap();
        let bore = b.bore(&Liquid, g, &x).unwrap();
        let ratio = bore.volume.value / (bore.mass.value / bore.density.value);
        for k in [BORE_MASS, BORE_ENERGY, BORE_BORON] {
            physical[b.group_index(g, k)] *= ratio;
        }
    }
    steady_bores(b, &mut physical, water);
    physical
}

#[test]
fn one_motion_class_holds_every_cluster_but_the_declared_singles() {
    let b = grouped_block(SpiderDrag::Omitted);
    let groups = b.bore_groups();
    // EVT-RODS-BANK: one class of all 52, its water region merging the
    // fixture's 8 sector-share bore groups (c % 13 == 0 split, the rest by
    // c % 4): its water coordinates stand for 8 regions, its motion for 52.
    assert_eq!(groups, vec![(0..N).collect::<Vec<_>>()]);
    assert_eq!(layout(&b).len(), CLUSTER_COORDINATES + 4);
    assert_eq!(
        layout(&b).multiplicity,
        [vec![N; CLUSTER_COORDINATES], vec![8; 4]].concat()
    );
    let single = block_with(SpiderDrag::Omitted, &[5, 7]);
    assert_eq!(single.bore_groups().len(), 3);
    assert_eq!(single.bore_groups()[single.group_of(0)].len(), N - 2);
    assert_eq!(single.bore_groups()[single.group_of(5)], vec![5]);
    assert_eq!(single.bore_groups()[single.group_of(7)], vec![7]);
    // The prepared bore water is LOWER's at the bores' mid-height (+0.075 m)
    // on LOWER's density, at LOWER's specific internal energy and boron.
    let prepared = Rods::<Liquid>::prepared(&b);
    let p = prepared[b.group_index(0, BORE_PRESSURE)];
    assert!((p - (p_lower() - RHO_L * G * 3.075)).abs() < 1e-6, "{p}");
    let (m, u, boron) = (
        prepared[b.group_index(0, BORE_MASS)],
        prepared[b.group_index(0, BORE_ENERGY)],
        prepared[b.group_index(0, BORE_BORON)],
    );
    assert!((u / m - u_lower()).abs() < 1e-6 && (boron / m - 1e-3).abs() < 1e-15);
    let free =
        24. * std::f64::consts::PI * (0.0055_f64.powi(2) * 4.65 - 0.00475_f64.powi(2) * 1.85);
    let members = groups[0].len() as f64;
    let rho = Liquid
        .caloric(false, p, u_lower(), false)
        .unwrap()
        .density_kg_m3;
    assert!((m - rho * free * members).abs() < 1e-9 * m, "{m}");
    // Every current starts at zero (DR13-ROD: the consistent start solves).
    assert!(
        (0..N)
            .all(|c| prepared[ci(&b, c, LOWER_CURRENT)] == 0. && prepared[ci(&b, c, UPPER_CURRENT)] == 0.)
    );
}

#[test]
fn z4_force_balance_and_insertion_margins_are_reproduced() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    // Z4 "guide passage from LOWER" rows: travel, current, tip and top
    // pressure, end-face and wall force, bodies' net downward force. The
    // bores' water is LOWER's at its own pressure, 3e-5 lighter than Z4's
    // donor: the series balance at Z4's current differs by about a pascal.
    let z4 = [
        (
            2.8, 1.315701, 15180092.4, 15034860.6, 247.064, 30.691, 62.157,
        ),
        (
            1.25, 0.954673, 15192341.2, 15045180.4, 250.346, 31.169, 58.398,
        ),
        (
            0.1, 0.816464, 15201036.6, 15052837.0, 252.113, 31.315, 56.484,
        ),
    ];
    let mut minimum = f64::INFINITY;
    for (travel, current, tip, top, end, wall, net_down) in z4 {
        let physical = held(&mut b, &water, travel, current);
        let y = solver(&b, &physical);
        let yp = vec![0.; y.len()];
        let d = fluid_data(&water);
        let f = fluid(&d);
        let scales = layout(&b).scales.clone();
        let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
        let rows = evaluate(&mut b, &y, &yp, None, 0., &water).0;
        for c in [0, 13, 51] {
            let bore = b.bore(&Liquid, b.group_of(c), &x).unwrap();
            let forces = b.forces(c, &x, &f, &bore).unwrap();
            println!(
                "{travel}: tip {} top {} end {} wall {} net {} lower {} upper {}",
                forces.tip_pressure.value,
                forces.top_pressure.value,
                forces.end_face.value,
                forces.wall.value,
                forces.net.value,
                forces.lower_residual.value,
                forces.upper_residual.value
            );
            // Two explicit corrections close the lower balance.
            assert!(forces.lower_residual.value.abs() < 0.1, "{travel}: lower");
            // Z4's current closes the series balance to its own pascal; since
            // P2-FIX-1 a pose below the reference also shifts the bores'
            // reference pressure by the lower path's annulus (about 40 kPa at
            // 1.25 m), and the bores' density with it (kappa rho 40 kPa,
            // 5e-5), which changes the annulus volume current's loss by about
            // 7 Pa: Z4's current is then the steady one to 5e-5 of itself.
            // Bound: 1e-4 of the bores' pressure drop, about 15 Pa.
            assert!(
                forces.upper_residual.value.abs() < 1e-4 * (tip - top),
                "{travel}: upper {}",
                forces.upper_residual.value
            );
            assert!(
                (forces.tip_pressure.value - tip).abs() < 1.,
                "{travel}: tip"
            );
            assert!((forces.top_pressure.value - top).abs() < 0.2);
            assert!((forces.end_face.value - end).abs() < 0.01, "{travel}: end");
            assert!((forces.wall.value - wall).abs() < 5e-3, "{travel}: wall");
            // Z4's receipt predates R4-ROD2-STEM: its net is the bodies' and
            // spider's alone. The stem adds its weight less its end faces,
            // which at rest is its weight less its buoyancy in UPPER's water.
            let stem = forces.stem_end.value - stem_mass() * G;
            let buoyancy = 678.920757 * G * std::f64::consts::PI * STEM_RADIUS * STEM_RADIUS * STEM_LENGTH;
            assert!((forces.stem_end.value - buoyancy).abs() < 1e-6, "{travel}: stem end");
            assert!((-(forces.net.value - stem) - net_down).abs() < 0.01, "{travel}: net");
            // The bores' EOS row holds at the prepared water.
            let eos = rows[b.group_index(b.group_of(c), BORE_PRESSURE)].value;
            assert!(eos.abs() < 1e-12, "EOS {eos}");
            minimum = minimum.min(-(forces.net.value - stem));
        }
    }
    // The H7 margins: 62 N at release, 56 N at the minimum over the travels.
    assert!(minimum > 56. && minimum < 57.);
}

/// A state with mixed modes away from kinks, and nonzero rates.
fn mixed(b: &mut RodBlock, water: &[Water1]) -> (Vec<f64>, Vec<f64>) {
    let mut physical = held(b, water, 2.8, 1.3157);
    let mut rate = vec![0.; physical.len()];
    for c in 0..N {
        let mode = [Mode::Held, Mode::Free, Mode::Free, Mode::Seated][c % 4];
        b.set_mode(c, mode);
        if mode == Mode::Free {
            physical[ci(b, c, TRAVEL)] = 0.4 + 0.035 * c as f64;
            physical[ci(b, c, VELOCITY)] = -0.3 - 0.03 * c as f64;
            rate[ci(b, c, TRAVEL)] = physical[ci(b, c, VELOCITY)];
            rate[ci(b, c, VELOCITY)] = -1.1;
        } else if mode == Mode::Seated {
            physical[ci(b, c, TRAVEL)] = 0.;
        }
        physical[ci(b, c, LOWER_CURRENT)] *= 1. - 0.6 * (c % 7) as f64 / 6.;
        physical[ci(b, c, UPPER_CURRENT)] *= 1. + 0.01 * (c % 5) as f64;
    }
    for g in 0..b.bore_groups().len() {
        rate[b.group_index(g, BORE_MASS)] = -0.03;
        rate[b.group_index(g, BORE_ENERGY)] = 4e4;
        rate[b.group_index(g, BORE_BORON)] = -2e-5;
        physical[b.group_index(g, BORE_PRESSURE)] += 150. * g as f64;
    }
    (solver(b, &physical), rates(b, &rate))
}

#[test]
fn analytic_directions_match_differences_and_the_colored_jacobian_is_the_dense_one() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let n = y.len();
    let rows_scale = layout(&b).row_scales.clone();
    let cj = 37.;
    let scaled = |rows: &[Scalar]| -> Vec<f64> {
        rows.iter()
            .zip(&rows_scale)
            .map(|(r, s)| r.value / s)
            .collect()
    };
    let directions = |b: &mut RodBlock, d: &[f64]| -> Vec<f64> {
        let (rows, _, _) = evaluate(b, &y, &yp, Some(d), cj, &water);
        rows.iter()
            .zip(&rows_scale)
            .map(|(r, s)| r.direction / s)
            .collect()
    };
    // G10: every coordinate direction and 20 random ones, 1e-6 relative in
    // the scaled-row norm against central differences of y and y'.
    let mut seeds: Vec<Vec<f64>> = (0..n)
        .map(|j| (0..n).map(|i| if i == j { 1. } else { 0. }).collect())
        .collect();
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    for _ in 0..20 {
        seeds.push(
            (0..n)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state % 2001) as f64 / 1000. - 1.
                })
                .collect(),
        );
    }
    let mut worst = 0_f64;
    for d in &seeds {
        let exact = directions(&mut b, d);
        let h = 1e-7;
        let arm = |b: &mut RodBlock, sign: f64| {
            let ys: Vec<f64> = y.iter().zip(d).map(|(v, e)| v + sign * h * e).collect();
            let yps: Vec<f64> = yp
                .iter()
                .zip(d)
                .map(|(v, e)| v + sign * h * cj * e)
                .collect();
            let (rows, _, _) = evaluate(b, &ys, &yps, None, 0., &water);
            scaled(&rows)
        };
        let (plus, minus) = (arm(&mut b, 1.), arm(&mut b, -1.));
        let fd: Vec<f64> = plus
            .iter()
            .zip(&minus)
            .map(|(p, m)| (p - m) / (2. * h))
            .collect();
        let norm = exact.iter().map(|v| v * v).sum::<f64>().sqrt();
        let error = exact
            .iter()
            .zip(&fd)
            .map(|(a, f)| (a - f) * (a - f))
            .sum::<f64>()
            .sqrt();
        if norm > 0. {
            worst = worst.max(error / norm);
        }
    }
    assert!(worst < 1e-6, "worst relative directional error {worst}");

    // Colored assembly over the declared own-coordinate structure.
    let structure = Rods::<Liquid>::structure(&b);
    let columns: Vec<Vec<usize>> = (0..n)
        .map(|j| {
            let mut rows: Vec<usize> = (0..n).filter(|r| structure.own[*r].contains(&j)).collect();
            rows.sort_unstable();
            rows
        })
        .collect();
    let pattern = Pattern::from_columns(n, &columns).unwrap();
    let coloring = Coloring::greedy(&pattern);
    coloring.verify(&pattern).unwrap();
    let signs = vec![1.; n];
    let mut values = vec![0.; pattern.nonzeros()];
    for color in 0..coloring.count() {
        let seed = coloring.seed(color, &signs).unwrap();
        let (rows, _, _) = evaluate(&mut b, &y, &yp, Some(&seed), cj, &water);
        let directions: Vec<f64> = rows.iter().map(|r| r.direction).collect();
        scatter(&pattern, &coloring, color, &directions, &signs, &mut values).unwrap();
    }
    let mut dense = vec![0.; n * n];
    for j in 0..n {
        let mut seed = vec![0.; n];
        seed[j] = 1.;
        let (rows, _, _) = evaluate(&mut b, &y, &yp, Some(&seed), cj, &water);
        for (i, r) in rows.iter().enumerate() {
            dense[j * n + i] = r.direction;
        }
    }
    let comparison = compare_with_dense(&pattern, &values, &dense).unwrap();
    assert!(comparison.is_bitwise_exact(), "{comparison:?}");
    println!("colors {}", coloring.count());

    // Local units: each coordinate's readers reproduce the full rows bitwise.
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = layout(&b).scales.clone();
    for j in [
        0,
        1,
        2,
        3,
        4 * 13 + 2,
        ci(&b, 51, UPPER_CURRENT),
        b.group_index(0, BORE_MASS),
        b.group_index(7, BORE_PRESSURE),
    ] {
        let mut seed = vec![0.; n];
        seed[j] = 1.;
        let (full, _, _) = evaluate(&mut b, &y, &yp, Some(&seed), cj, &water);
        let x = Coordinates::new(&y, &yp, Some(&seed), cj, &scales).unwrap();
        let mut units = Vec::new();
        Rods::<Liquid>::coordinate_readers(&b, j, &mut units).unwrap();
        let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
        let mut out = Vec::new();
        Rods::<Liquid>::rows_local(
            &mut b,
            &Liquid,
            0.,
            x,
            &f,
            &units,
            &mut Receipts::new(&mut cells),
            &mut out,
        )
        .unwrap();
        let listed: std::collections::BTreeSet<usize> = out.iter().map(|(i, _)| *i).collect();
        for (i, r) in &out {
            assert_eq!(r.value.to_bits(), full[*i].value.to_bits());
            assert_eq!(r.direction.to_bits(), full[*i].direction.to_bits());
        }
        for (i, r) in full.iter().enumerate() {
            if !listed.contains(&i) {
                assert_eq!(r.direction, 0., "row {i} reads coordinate {j} unlisted");
            }
        }
    }
}

#[test]
fn fluid_directions_enter_rows_and_receipts_exactly() {
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let base = z4_field(0.);
    let (y, yp) = mixed(&mut b, &base);
    // Seed each plenum's and two core cells' pressure, density, viscosity,
    // enthalpy and tracer (the bores no longer read the core cells), and
    // HOUSING.NECK's, which the stem's top reads (R4-ROD2-STEM).
    for cell in [0, 1, 4, 9, 10, 11] {
        for field in 0..5 {
            let seeded = |sign: f64, direction: f64| {
                let mut w = base.clone();
                let x = &mut w[cell];
                let item = *[&mut x.p, &mut x.rho, &mut x.mu, &mut x.h, &mut x.c][field];
                let step = [10., 0.05, 1e-9, 1., 1e-7][field];
                let value = Scalar::new(item.value + sign * step, direction);
                match field {
                    0 => x.p = value,
                    1 => x.rho = value,
                    2 => x.mu = value,
                    3 => x.h = value,
                    _ => x.c = value,
                }
                (w, step)
            };
            let (w0, step) = seeded(0., 1.);
            let zero = vec![0.; y.len()];
            let (rows, cells, _) = evaluate(&mut b, &y, &yp, Some(&zero), 0., &w0);
            let (wp, _) = seeded(1., 0.);
            let (wm, _) = seeded(-1., 0.);
            let (rp, cp, _) = evaluate(&mut b, &y, &yp, None, 0., &wp);
            let (rm, cm, _) = evaluate(&mut b, &y, &yp, None, 0., &wm);
            let check = |exact: f64, p: f64, m: f64, what: &str| {
                let fd = (p - m) / (2. * step);
                // Central-difference roundoff of rows of magnitude |p|.
                let roundoff = 8. * f64::EPSILON * p.abs().max(m.abs()) / step;
                assert!(
                    (exact - fd).abs() <= 1e-5 * exact.abs().max(fd.abs()) + roundoff + 1e-10,
                    "cell {cell} field {field} {what}: {exact} vs {fd}"
                );
            };
            for i in 0..rows.len() {
                check(
                    rows[i].direction,
                    rp[i].value,
                    rm[i].value,
                    &format!("row {i}"),
                );
            }
            for i in 0..REGULAR {
                for k in 0..3 {
                    check(
                        cells[i][0][k].direction,
                        cp[i][0][k].value,
                        cm[i][0][k].value,
                        &format!("receipt {i}/{k}"),
                    );
                }
            }
            if (1..9).contains(&cell) {
                assert!(
                    rows.iter().all(|r| r.direction == 0.),
                    "core cell {cell} is read"
                );
            }
        }
    }
}

#[test]
fn the_bores_and_the_network_exchange_mass_energy_and_tracer_exactly() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let (rows, cells, volumes) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let physical_rate = |i: usize| yp[i] * layout(&b).scales[i];
    // The bores' stock rates the rows imply (rate less row) against the
    // network's receipts: mass and tracer exactly, energy up to the bodies'
    // wall work and the bores' boundary work.
    let groups = b.bore_groups().len();
    let implied = |k: usize| -> f64 {
        (0..groups)
            .map(|g| {
                let i = b.group_index(g, k);
                physical_rate(i) - rows[i].value
            })
            .sum()
    };
    let into = |k: usize| cells.iter().map(|c| c[0][k].value).sum::<f64>();
    let scale = |k: usize| cells.iter().map(|c| c[0][k].value.abs()).sum::<f64>();
    assert!(
        (implied(BORE_MASS) + into(0)).abs() <= 1e-12 * scale(0),
        "mass"
    );
    assert!(
        (implied(BORE_BORON) + into(2)).abs() <= 1e-12 * scale(2),
        "boron"
    );
    let d = fluid_data(&water);
    let f = fluid(&d);
    let x = Coordinates::new(&y, &yp, None, 0., &layout(&b).scales).unwrap();
    let (mut wall, mut drag, mut bore_work) = (0., 0., 0.);
    for c in 0..N {
        let bore = b.bore(&Liquid, b.group_of(c), &x).unwrap();
        let forces = b.forces(c, &x, &f, &bore).unwrap();
        let v = x.value(ci(&b, c, VELOCITY)).value;
        wall += -forces.wall.value * v;
        drag += -forces.spider_drag.value * v;
        bore_work += -bore.pressure.value
            * 24.
            * std::f64::consts::PI
            * 0.00475_f64.powi(2)
            * x.rate(ci(&b, c, TRAVEL)).value;
    }
    let energy = implied(BORE_ENERGY) + into(1) - drag;
    assert!(
        (energy - wall - bore_work).abs() <= 1e-10 * scale(1),
        "energy {energy} vs {}",
        wall + bore_work
    );
    // Only LOWER and UPPER exchange water with the bores; the spider's drag
    // work enters UPPER and HOUSING.MAIN as heat.
    for (cell, receipt) in cells.iter().enumerate().take(9).skip(1) {
        assert!(receipt[0].iter().all(|v| v.value == 0.), "core cell {cell}");
    }
    assert_eq!(cells[10][0][0].value, 0.);
    // Volume: the plena's free volume and the bores' free volume together
    // are constant.
    let plena: f64 = volumes.iter().map(|v| v.rate_m3_s.value).sum();
    let bores: f64 = (0..N)
        .map(|c| 24. * std::f64::consts::PI * 0.00475_f64.powi(2) * x.rate(ci(&b, c, TRAVEL)).value)
        .sum();
    assert!((plena + bores).abs() < 1e-15, "{plena} + {bores}");
}

#[test]
fn the_bodies_work_enters_the_water_once() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let (_, cells, volumes) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let x = Coordinates::new(&y, &yp, None, 0., &layout(&b).scales).unwrap();
    let (mut heat, mut boundary, mut drag, mut bores) = (0., 0., 0., 0.);
    for c in 0..N {
        let bore = b.bore(&Liquid, b.group_of(c), &x).unwrap();
        let [_, h, w] = b.power(c, &x, &f, &bore).unwrap();
        let forces = b.forces(c, &x, &f, &bore).unwrap();
        let v = x.value(ci(&b, c, VELOCITY)).value;
        assert!(
            (h + (forces.wall.value + forces.spider_drag.value) * v).abs()
                <= 1e-12 * h.abs().max(1.)
        );
        heat += h;
        boundary += w;
        drag += -forces.spider_drag.value * v;
        bores += -bore.pressure.value
            * 24.
            * std::f64::consts::PI
            * 0.00475_f64.powi(2)
            * x.rate(ci(&b, c, TRAVEL)).value;
    }
    assert!(heat > 0.);
    // The heat port of the plena carries the spider's drag work, and the
    // transported enthalpy of the mouths besides.
    let ported: f64 = cells[10][0][1].value;
    assert!(ported > 0. && ported <= drag * (1. + 1e-12));
    // The boundary work the plena pay, -p V', and the bores', are the
    // bodies' own.
    let paid: f64 = volumes
        .iter()
        .enumerate()
        .map(|(i, v)| -water[i].p.value * v.rate_m3_s.value)
        .sum();
    assert!(
        (paid + bores - boundary).abs() <= 1e-9 * boundary.abs(),
        "{paid} + {bores} vs {boundary}"
    );
}

#[test]
fn trip_release_seat_and_the_stuck_cluster_follow_the_modes() {
    let water = z4_field(0.);
    // E-NUC: per-cluster roots and directions need every cluster its own
    // motion class; the grouped refusal is checked on the fixture's groups.
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8, 1.3157);
    b.set_failed_release(5).unwrap();
    // A cluster sharing its bores' water cannot be stuck.
    let mut shared = block_with(SpiderDrag::Omitted, &[5]);
    assert!(shared.set_failed_release(6).is_err());
    let t = Rods::<Liquid>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    assert_eq!(b.holding_open_at(), Some(1.7));
    assert!(t.deposits.is_empty());
    let d = fluid_data(&water);
    let f = fluid(&d);
    let mut roots = vec![0.; N];
    let y = solver(&b, &physical);
    let yp = vec![0.; y.len()];
    let scales = layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    Rods::<Liquid>::roots(&mut b, &Liquid, 1.65, x, &f, &mut roots).unwrap();
    assert!((roots[0] + 0.05).abs() < 1e-12 && roots[5] == 1.);
    let mut directions = vec![1; N];
    directions[5] = 0;
    Rods::<Liquid>::transact(&mut b, &Liquid, 1.7, &directions, &mut physical).unwrap();
    assert_eq!(b.modes()[0], Mode::Free);
    assert_eq!(b.modes()[5], Mode::Held);
    let ids = Rods::<Liquid>::differential(&b);
    assert_eq!(ids[ci(&b, 0, VELOCITY)], 1.);
    assert_eq!(ids[ci(&b, 5, VELOCITY)], 0.);
    assert_eq!(ids[b.group_index(0, BORE_MASS)], 1.);
    assert_eq!(ids[b.group_index(0, BORE_PRESSURE)], 0.);
    // A free body at the seat: inelastic, its energy into its fitting.
    physical[ci(&b, 0, TRAVEL)] = 1e-13;
    physical[ci(&b, 0, VELOCITY)] = -2.0;
    // E-EVT bank seat: a free, descending cluster whose travel is zero
    // within its error weight seats in the same event; one further off, one
    // rising and the held one do not.
    for (c, travel, speed) in [(1, 3e-9, -2.0), (2, 1e-3, -2.0), (3, 3e-9, 0.5), (5, 0., 0.)] {
        physical[ci(&b, c, TRAVEL)] = travel;
        physical[ci(&b, c, VELOCITY)] = speed;
    }
    let mut directions = vec![0; N];
    directions[0] = -1;
    let weights = vec![1e8; physical.len()];
    let added = Rods::<Liquid>::coincident(&b, &physical, &weights, &mut directions).unwrap();
    assert_eq!(added, 1);
    assert_eq!((directions[1], directions[2], directions[3], directions[5]), (-1, 0, 0, 0));
    let mut no_seat = vec![0; N];
    assert_eq!(Rods::<Liquid>::coincident(&b, &physical, &weights, &mut no_seat).unwrap(), 0);
    let seat = Rods::<Liquid>::transact(&mut b, &Liquid, 2.9, &directions, &mut physical).unwrap();
    assert_eq!(b.modes()[0], Mode::Seated);
    assert_eq!(b.modes()[1], Mode::Seated);
    assert_eq!(b.modes()[2], Mode::Free);
    assert_eq!(
        (physical[ci(&b, 0, TRAVEL)], physical[ci(&b, 0, VELOCITY)]),
        (0., 0.)
    );
    assert_eq!(
        (physical[ci(&b, 1, TRAVEL)], physical[ci(&b, 1, VELOCITY)]),
        (0., 0.)
    );
    assert_eq!(seat.deposits.len(), 2);
    assert_eq!(seat.deposits[0].0, "FA0/top-fitting");
    assert!((seat.deposits[0].1 - 0.5 * b.moving_mass() * 4.).abs() < 1e-9);
    // A seated body's root is its seat reaction, positive in this field (at
    // the 0.1 m travel's Z4 current, not re-solved at the seat).
    let mut seated = held(&mut b, &water, 0., 0.816464);
    for c in 0..N {
        b.set_mode(c, if c == 5 { Mode::Held } else { Mode::Free });
    }
    b.set_mode(0, Mode::Seated);
    seated[ci(&b, 0, TRAVEL)] = 0.;
    let y = solver(&b, &seated);
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    Rods::<Liquid>::roots(&mut b, &Liquid, 3., x, &f, &mut roots).unwrap();
    // R4-ROD2-STEM: the stem adds its weight less its buoyancy in UPPER's
    // water, 48.2 N, to the bodies' 56.5 N of Z4.
    let stem = stem_mass() * G
        - 678.920757 * G * std::f64::consts::PI * STEM_RADIUS * STEM_RADIUS * STEM_LENGTH;
    assert!(
        roots[0] > 55. + stem && roots[0] < 57. + stem,
        "seat reaction root {}",
        roots[0]
    );
    // WORLD2's E0 (lead, 1 Nov): a further trip command with the circuit
    // open or opening is acknowledged and changes nothing.
    let before = Rods::<Liquid>::discrete_state(&b);
    for (t, c) in [
        (2., Command::TurbineTrip),
        (2.1, Command::ManualReactorTrip),
        (2.2, Command::HoldingLoss),
    ] {
        let tx = Rods::<Liquid>::command(&mut b, t, c).unwrap();
        assert_eq!(tx.receipt["acknowledged"], true, "{c:?}");
        assert!(tx.deposits.is_empty());
        assert_eq!(Rods::<Liquid>::discrete_state(&b), before, "{c:?} changes no state");
    }
}

/// WORLD2's E0, the real plant's way (lead, 1 Nov): a manual reactor trip
/// while the turbine trip's opening is still scheduled opens the circuit at
/// the command's instant; the scheduled opening then finds it open, and any
/// later trip is acknowledged with no change.
#[test]
fn the_seated_lift_off_root_is_the_net_force_on_the_mouth_rows() {
    // R4-ROD2-SEAT: the lift-off root's seated balance differs from `net`
    // by exactly the mouth rows' and the EOS row's residuals:
    //   seated - net = A_b r_lo + B (r_lo + r_up) + B g H (rho(p) - M/V),
    // so it equals `net` on every consistent state and does not follow the
    // currents or the bores' pressure where those rows are off.
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let base = held(&mut b, &water, 0., 0.816464);
    for c in 0..N {
        b.set_mode(c, Mode::Seated);
    }
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = layout(&b).scales.clone();
    let area = 24. * std::f64::consts::PI * 0.00475 * 0.00475;
    let couette = {
        // The exact concentric moving-inner-wall factor of the 24 bores.
        let (o, i) = (0.0055_f64, 0.00475_f64);
        let eta = (o / i).ln();
        24. * std::f64::consts::PI * ((o * o - i * i) / (2. * eta) - i * i)
    };
    let height = 2.4 - -2.25;
    for (shift_lo, shift_up, shift_p) in [
        (0., 0., 0.),
        (0.7, -0.4, 0.),
        (-1.9, 1.3, 2.0e4),
        (2.3, 0.2, -3.5e4),
    ] {
        let mut physical = base.clone();
        for c in 0..N {
            physical[ci(&b, c, LOWER_CURRENT)] += shift_lo;
            physical[ci(&b, c, UPPER_CURRENT)] += shift_up;
        }
        for g in 0..b.bore_groups().len() {
            physical[b.group_index(g, BORE_PRESSURE)] += shift_p;
        }
        let y = solver(&b, &physical);
        let yp = vec![0.; y.len()];
        let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
        for c in [0, 13, 51] {
            let bore = b.bore(&Liquid, b.group_of(c), &x).unwrap();
            let forces = b.forces(c, &x, &f, &bore).unwrap();
            let seated = b.seated_net(c, &x, &f, &bore).unwrap().value;
            let eos = bore.density.value - bore.mass.value / bore.volume.value;
            let expected = forces.net.value
                + area * forces.lower_residual.value
                + couette * (forces.lower_residual.value + forces.upper_residual.value)
                + couette * G * height * eos;
            assert!(
                (seated - expected).abs() < 1e-9 * (1. + forces.end_face.value.abs()),
                "{c} {shift_lo} {shift_up} {shift_p}: seated {seated} expected {expected}"
            );
            if shift_lo == 0. && shift_p == 0. {
                // The held steady state at the 0.1 m current: the upper row
                // is off by Z4's small current mismatch only.
                assert!(
                    (seated - forces.net.value).abs()
                        < couette * forces.upper_residual.value.abs() + 1e-6
                );
            } else {
                // Off the rows, `net` follows the currents and the bores'
                // pressure; the seated balance reads neither.
                assert!(
                    (seated - forces.net.value).abs() > 1e-3,
                    "{c}: rows off yet equal"
                );
            }
        }
    }
}

#[test]
fn a_manual_trip_during_a_scheduled_opening_opens_the_circuit_at_once() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let _ = held(&mut b, &water, 2.8, 1.3157);
    let trip = Rods::<Liquid>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    let delay = trip.receipt["declared_delay_s"].as_f64().unwrap();
    assert!(delay > 0.);
    assert_eq!(b.holding_open_at(), Some(1.5 + delay));
    assert_eq!(Rods::<Liquid>::next_time_event(&b, 1.5), Some(1.5 + delay));
    // The manual trip inside the delay: open now, earlier than scheduled.
    let t = 1.5 + 0.5 * delay;
    let tx = Rods::<Liquid>::command(&mut b, t, Command::ManualReactorTrip).unwrap();
    assert!(tx.receipt.get("acknowledged").is_none(), "{}", tx.receipt);
    assert_eq!(b.holding_open_at(), Some(t));
    // The scheduled opening is no longer an event: the circuit is open.
    assert_eq!(Rods::<Liquid>::next_time_event(&b, t), None);
    let before = Rods::<Liquid>::discrete_state(&b);
    for (at, c) in [
        (1.5 + delay, Command::TurbineTrip),
        (1.5 + delay, Command::ManualReactorTrip),
        (1.5 + 2. * delay, Command::HoldingLoss),
    ] {
        let tx = Rods::<Liquid>::command(&mut b, at, c).unwrap();
        assert_eq!(tx.receipt["acknowledged"], true, "{c:?}");
        assert_eq!(Rods::<Liquid>::discrete_state(&b), before, "{c:?} changes no state");
    }
}

#[test]
fn the_holding_opening_releases_every_held_cluster_once_as_a_time_event() {
    let water = z4_field(0.);
    let mut b = block_with(SpiderDrag::Omitted, &[5]);
    let mut physical = held(&mut b, &water, 2.8, 1.3157);
    b.set_failed_release(5).unwrap();
    assert!(
        Rods::<Liquid>::time_event(&mut b, &Liquid, 1.7, &mut physical)
            .unwrap()
            .is_none()
    );
    Rods::<Liquid>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    let open = Rods::<Liquid>::next_time_event(&b, 1.5).unwrap();
    assert!(
        Rods::<Liquid>::time_event(&mut b, &Liquid, 1.6, &mut physical)
            .unwrap()
            .is_none()
    );
    let before = physical.clone();
    let tx = Rods::<Liquid>::time_event(&mut b, &Liquid, open, &mut physical)
        .unwrap()
        .expect("the opening is due");
    assert!(tx.deposits.is_empty());
    assert_eq!(physical, before, "a release moves no coordinate");
    for c in 0..N {
        let expected = if c == 5 { Mode::Held } else { Mode::Free };
        assert_eq!(b.modes()[c], expected, "cluster {c}");
    }
    assert!(
        Rods::<Liquid>::time_event(&mut b, &Liquid, open, &mut physical)
            .unwrap()
            .is_none()
    );
    assert_eq!(Rods::<Liquid>::next_time_event(&b, open), None);
}

/// X4.4 (lane ROD): the rate drive moves every held class at the common
/// rate through its travel row only; at rest its rows are a held block's
/// bitwise; the holding opening releases the driven classes and returns a
/// driven stuck one to HELD; the snapshot carries the rate exactly when
/// driven.
#[test]
fn the_rate_drive_enters_only_the_travel_rows_and_the_opening_ends_it() {
    let water = z4_field(0.);
    let mut b = block_with(SpiderDrag::Omitted, &[5]);
    let physical = held(&mut b, &water, 2.8, 1.3157);
    let y = solver(&b, &physical);
    let yp = vec![0.; y.len()];
    let (held_rows, held_cells, _) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let held_state = Rods::<Liquid>::discrete_state(&b);
    assert!(
        Rods::<Liquid>::set_drive(&mut b, 1., None).is_err(),
        "not engaged"
    );
    Rods::<Liquid>::set_drive(&mut b, 1., Some(0.)).unwrap();
    assert_eq!(Rods::<Liquid>::drive(&b), Some(0.));
    assert!(b.modes().iter().all(|m| *m == Mode::Driven));
    let (rest_rows, rest_cells, _) = evaluate(&mut b, &y, &yp, None, 0., &water);
    let bits = |r: &[Scalar]| {
        r.iter()
            .map(|v| (v.value.to_bits(), v.direction.to_bits()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        bits(&rest_rows),
        bits(&held_rows),
        "at rest a driven block's rows are a held one's"
    );
    assert_eq!(format!("{rest_cells:?}"), format!("{held_cells:?}"));
    assert_eq!(Rods::<Liquid>::differential(&b), {
        let mut h = block_with(SpiderDrag::Omitted, &[5]);
        held(&mut h, &water, 2.8, 1.3157);
        Rods::<Liquid>::differential(&h)
    });
    Rods::<Liquid>::set_drive(&mut b, 1.1, Some(-0.004)).unwrap();
    let (rows, _, _) = evaluate(&mut b, &y, &yp, None, 0., &water);
    for (i, (a, h)) in rows.iter().zip(&held_rows).enumerate() {
        let travel =
            (0..b.bore_groups().len()).any(|c| b.cluster_index(b.bore_groups()[c][0], TRAVEL) == i);
        if travel {
            assert_eq!(a.value, h.value + 0.004, "row {i}: y' - v - u");
        } else {
            assert_eq!(a.value.to_bits(), h.value.to_bits(), "row {i} unchanged");
        }
    }
    // The snapshot carries the rate exactly while driven.
    let driven_state = Rods::<Liquid>::discrete_state(&b);
    assert!(driven_state.get("drive_m_s").is_some() && held_state.get("drive_m_s").is_none());
    let mut r = block_with(SpiderDrag::Omitted, &[5]);
    Rods::<Liquid>::restore_discrete_state(&mut r, &driven_state).unwrap();
    assert_eq!(Rods::<Liquid>::drive(&r), Some(-0.004));
    let mut forged = driven_state.clone();
    forged.as_object_mut().unwrap().remove("drive_m_s");
    assert!(Rods::<Liquid>::restore_discrete_state(&mut r, &forged).is_err());
    // The opening releases the driven classes; the stuck one is held.
    b.set_failed_release(5).unwrap();
    Rods::<Liquid>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    assert!(
        Rods::<Liquid>::set_drive(&mut b, 1.6, Some(0.002)).is_ok(),
        "a rate change before the opening"
    );
    let open = Rods::<Liquid>::next_time_event(&b, 1.5).unwrap();
    let mut p = physical.clone();
    Rods::<Liquid>::time_event(&mut b, &Liquid, open, &mut p)
        .unwrap()
        .expect("the opening is due");
    for c in 0..N {
        let expected = if c == 5 { Mode::Held } else { Mode::Free };
        assert_eq!(b.modes()[c], expected, "cluster {c}");
    }
    assert_eq!(Rods::<Liquid>::drive(&b), None);
    assert!(
        Rods::<Liquid>::set_drive(&mut b, open, Some(0.)).is_err(),
        "no engagement once open"
    );
}

/// B1 (lane ROD): the stuck cluster is out exactly when it is held with a
/// declared stuck grip and every other class is seated.
#[test]
fn the_stuck_cluster_is_out_once_every_other_class_is_seated() {
    let water = z4_field(0.);
    let mut b = block_with(SpiderDrag::Omitted, &[5]);
    held(&mut b, &water, 2.8, 1.3157);
    assert!(!Rods::<Liquid>::stuck_out(&b), "nothing declared");
    b.set_failed_release(5).unwrap();
    assert!(!Rods::<Liquid>::stuck_out(&b), "the bank is still held");
    for c in 0..N {
        if c != 5 {
            b.set_mode(c, Mode::Free);
        }
    }
    assert!(!Rods::<Liquid>::stuck_out(&b), "the bank is still falling");
    for c in 0..N {
        if c != 5 {
            b.set_mode(c, Mode::Seated);
        }
    }
    assert!(Rods::<Liquid>::stuck_out(&b));
}

#[test]
fn the_stuck_cluster_command_keeps_one_grip_closed_at_the_opening() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 2.8, 1.3157);
    let before = physical.clone();
    let identity = Rods::<Liquid>::differential(&b);
    let tx = Rods::<Liquid>::command(&mut b, 1.5, Command::StuckCluster { cluster: 5 }).unwrap();
    assert!(tx.deposits.is_empty());
    assert_eq!(tx.receipt["command"], "StuckCluster");
    assert_eq!(tx.receipt["cluster"], "LD01.CR.006");
    assert_eq!(tx.receipt["index"], 5);
    assert!(b.failed_release(5));
    assert!((0..N).filter(|c| *c != 5).all(|c| !b.failed_release(c)));
    assert_eq!(Rods::<Liquid>::differential(&b), identity);
    assert_eq!(
        Rods::<Liquid>::next_time_event(&b, 1.5),
        None,
        "no time event"
    );
    // Refused: twice, a cluster that does not exist, one sharing its bores.
    assert!(Rods::<Liquid>::command(&mut b, 1.5, Command::StuckCluster { cluster: 5 }).is_err());
    assert!(Rods::<Liquid>::command(&mut b, 1.5, Command::StuckCluster { cluster: 52 }).is_err());
    let mut shared = block_with(SpiderDrag::Omitted, &[5, 7]);
    held(&mut shared, &water, 2.8, 1.3157);
    assert!(Rods::<Liquid>::command(&mut shared, 1.5, Command::StuckCluster { cluster: 6 }).is_err());
    Rods::<Liquid>::command(&mut b, 1.5, Command::TurbineTrip).unwrap();
    let open = Rods::<Liquid>::next_time_event(&b, 1.5).unwrap();
    Rods::<Liquid>::command(&mut b, 1.6, Command::StuckCluster { cluster: 7 }).unwrap();
    let d = fluid_data(&water);
    let f = fluid(&d);
    let y = solver(&b, &physical);
    let yp = vec![0.; y.len()];
    let scales = layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    let mut roots = vec![0.; N];
    Rods::<Liquid>::roots(&mut b, &Liquid, 1.65, x, &f, &mut roots).unwrap();
    for (c, root) in roots.iter().enumerate() {
        if c == 5 || c == 7 {
            assert_eq!(*root, 1., "cluster {c}");
        } else {
            assert!((root - (1.65 - open)).abs() < 1e-12, "cluster {c}");
        }
    }
    let tx = Rods::<Liquid>::time_event(&mut b, &Liquid, open, &mut physical)
        .unwrap()
        .expect("the opening is due");
    assert_eq!(tx.receipt["rods"].as_array().unwrap().len(), 50);
    assert_eq!(physical, before, "a release moves no coordinate");
    for c in 0..N {
        let expected = if c == 5 || c == 7 {
            Mode::Held
        } else {
            Mode::Free
        };
        assert_eq!(b.modes()[c], expected, "cluster {c}");
        assert_eq!(
            Rods::<Liquid>::differential(&b)[ci(&b, c, VELOCITY)],
            if expected == Mode::Free { 1. } else { 0. }
        );
    }
    assert!(Rods::<Liquid>::command(&mut b, open, Command::StuckCluster { cluster: 0 }).is_err());
    let mut other = block_with(SpiderDrag::Omitted, &[5]);
    held(&mut other, &water, 2.8, 1.3157);
    Rods::<Liquid>::command(&mut other, 0., Command::ManualReactorTrip).unwrap();
    assert!(Rods::<Liquid>::command(&mut other, 0., Command::StuckCluster { cluster: 5 }).is_err());
    // A snapshot naming a stuck cluster that shares its bores is refused.
    let mut grouped = grouped_block(SpiderDrag::Omitted);
    let state = Rods::<Liquid>::discrete_state(&b);
    assert!(Rods::<Liquid>::restore_discrete_state(&mut grouped, &state).is_err());
}

#[test]
fn a_free_body_refuses_a_pending_spider_drag_selection() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Pending);
    let physical = held(&mut b, &water, 2.8, 1.3157);
    b.set_mode(0, Mode::Free);
    let y = solver(&b, &physical);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let mut rows = vec![Scalar::constant(0.); y.len()];
    let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
    let yp = vec![0.; y.len()];
    let scales = layout(&b).scales.clone();
    let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
    assert!(
        Rods::<Liquid>::rows(
            &mut b,
            &Liquid,
            0.,
            x,
            &f,
            &mut Receipts::new(&mut cells),
            &mut rows
        )
        .is_err()
    );
}

/// The packet's hydrostatic preparation: LOWER 745.7, core 715.3/679.3,
/// UPPER 679.3 kg/m3 with the network's well-balanced head and no flow.
fn hydrostatic() -> Vec<Water1> {
    let mut water = z4_field(0.);
    let (rl, r1, r2, ru) = (745.7088, 715.3052, 679.3369, 679.3369);
    let pl = 15.2e6;
    let pu = pl - G * (rl + 2. * r1 + 2. * r2 + ru);
    water[0].p = Scalar::constant(pl);
    water[0].rho = Scalar::constant(rl);
    water[9].p = Scalar::constant(pu);
    water[9].rho = Scalar::constant(ru);
    water[10].p = Scalar::constant(pu - 3. * ru * G);
    water[10].rho = Scalar::constant(ru);
    water[11].p = Scalar::constant(pu - 7.825 * ru * G);
    water[11].rho = Scalar::constant(ru);
    water
}

/// One cluster's two mouth balances with their exact directions along the
/// cluster's currents, at travel `y`, speed `v`, currents `(m_lo, m_up)`,
/// the bores' reference pressure `p` and their water `(rho, u)`.
fn mouths(
    b: &RodBlock,
    water: &[Water1],
    y: f64,
    v: f64,
    currents: (f64, f64),
    p: f64,
) -> (Scalar, Scalar) {
    let d = fluid_data(water);
    let f = fluid(&d);
    let scales = layout(b).scales.clone();
    let mut physical = Rods::<Liquid>::prepared(b);
    let g = b.group_of(0);
    physical[ci(b, 0, TRAVEL)] = y;
    physical[ci(b, 0, VELOCITY)] = v;
    physical[ci(b, 0, LOWER_CURRENT)] = currents.0;
    physical[ci(b, 0, UPPER_CURRENT)] = currents.1;
    physical[b.group_index(g, BORE_PRESSURE)] = p;
    let x = solver(b, &physical);
    let mut seed = vec![0.; x.len()];
    seed[ci(b, 0, LOWER_CURRENT)] = 1. / scales[ci(b, 0, LOWER_CURRENT)];
    seed[ci(b, 0, UPPER_CURRENT)] = 1. / scales[ci(b, 0, UPPER_CURRENT)];
    let yp = vec![0.; x.len()];
    let c = Coordinates::new(&x, &yp, Some(&seed), 0., &scales).unwrap();
    let bore = b.bore(&Liquid, g, &c).unwrap();
    let forces = b.forces(0, &c, &f, &bore).unwrap();
    (forces.lower_residual, forces.upper_residual)
}

#[test]
fn the_hydrostatic_field_has_a_zero_flow_bore_state_and_no_band_set_current() {
    // R3's band-set current is gone: with the bores' own water there is a
    // steady state with both currents exactly zero, at the bore density
    // that balances the plena's hydrostatic difference over the guide.
    let water = hydrostatic();
    let b = block(SpiderDrag::Omitted);
    let lower_mouth = water[0].p.value + water[0].rho.value * G * (-3. - -2.25);
    let upper_mouth = water[9].p.value + water[9].rho.value * G * (3. - 2.4);
    let balance = (lower_mouth - upper_mouth) / (G * 4.65);
    assert!(balance > 679.34 && balance < 745.71, "{balance}");
    // At that density and the matching reference pressure both balances
    // vanish at zero current (the mouths and friction carry none).
    let p = lower_mouth - balance * G * (0.075 - -2.25);
    let point = |rho: f64| (rho / RHO_L).ln();
    let u = u_lower() - CU * (point(balance) - KAPPA * (p - p_lower())) / BETA;
    let mut physical = Rods::<Liquid>::prepared(&b);
    let g = b.group_of(0);
    let m = physical[b.group_index(g, BORE_MASS)];
    physical[b.group_index(g, BORE_ENERGY)] = m * u;
    let probe = |physical: &[f64], currents: (f64, f64)| {
        let d = fluid_data(&water);
        let f = fluid(&d);
        let mut physical = physical.to_vec();
        physical[ci(&b, 0, LOWER_CURRENT)] = currents.0;
        physical[ci(&b, 0, UPPER_CURRENT)] = currents.1;
        physical[b.group_index(g, BORE_PRESSURE)] = p;
        let y = solver(&b, &physical);
        let yp = vec![0.; y.len()];
        let x = Coordinates::new(&y, &yp, None, 0., &layout(&b).scales).unwrap();
        let bore = b.bore(&Liquid, g, &x).unwrap();
        let forces = b.forces(0, &x, &f, &bore).unwrap();
        (
            bore.density.value,
            forces.lower_residual.value,
            forces.upper_residual.value,
        )
    };
    let (rho, lower, upper) = probe(&physical, (0., 0.));
    assert!((rho - balance).abs() < 1e-9 * balance, "{rho} vs {balance}");
    assert!(lower.abs() < 1e-6 && upper.abs() < 1e-6, "{lower} {upper}");
    // LOWER's heavier water in the bores drives a downward flow instead:
    // both balances are negative at zero current, so both currents fall.
    let (_, lower, upper) = probe(&Rods::<Liquid>::prepared(&b), (0., 0.));
    println!("LOWER water in the bores at zero current: lower {lower} upper {upper} Pa");
    assert!(lower + upper < 0.);
}

#[test]
fn the_mouth_balances_are_continuous_and_c1_through_zero_and_the_annulus_reversal() {
    // No band step: across zero of either current, at rest in the
    // hydrostatic field and falling at 2.14 m/s (C3's reversal) and 4.8 m/s
    // in the at-power field, both balances are continuous and C1.
    let p = p_lower() - RHO_L * G * 3.075;
    for (water, v) in [
        (hydrostatic(), 0.),
        (z4_field(0.), -2.14),
        (z4_field(0.), -4.8),
    ] {
        let b = block(SpiderDrag::Omitted);
        let band =
            745.7 * 1e-3 * 24. * std::f64::consts::PI * (0.0055_f64.powi(2) - 0.00475_f64.powi(2));
        for offset in [-band, -0.3 * band, 0., 0.6 * band, band, 30. * band] {
            for (lower, upper) in [(offset, 0.4), (-1.2, offset)] {
                let h = 1e-9;
                let (r_lo, r_up) = mouths(&b, &water, 1.48, v, (lower, upper), p);
                let at =
                    |dl: f64, du: f64| mouths(&b, &water, 1.48, v, (lower + dl, upper + du), p);
                let ((ll, _), (rl, _)) = (at(-h, 0.), at(h, 0.));
                let ((_, lu), (_, ru)) = (at(0., -h), at(0., h));
                // The exact directions along (1, 1) are the sums of both
                // one-sided slopes on each side.
                let slope = |r: Scalar, left: f64, right: f64| {
                    let (dl, dr) = ((r.value - left) / h, (right - r.value) / h);
                    for s in [dl, dr] {
                        assert!(
                            (s - r.direction).abs() <= 2e-4 * r.direction.abs() + 1e-3,
                            "v {v} at ({lower}, {upper}): {dl} {dr} vs {}",
                            r.direction
                        );
                    }
                };
                slope(r_lo, ll.value, rl.value);
                slope(r_up, lu.value, ru.value);
            }
        }
    }
}

#[test]
fn cost_per_evaluation() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::EnvelopeDisk { coefficient: 1.28 });
    let (y, yp) = mixed(&mut b, &water);
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = layout(&b).scales.clone();
    let mut rows = vec![Scalar::constant(0.); y.len()];
    let mut cells = vec![[[Scalar::constant(0.); 3]; 2]; REGULAR];
    let mut volumes = vec![
        CellVolume {
            volume_m3: Scalar::constant(0.),
            rate_m3_s: Scalar::constant(0.)
        };
        REGULAR
    ];
    let seed: Vec<f64> = (0..y.len()).map(|i| (i % 3) as f64).collect();
    let mut time = |seeded: bool| {
        let mut samples = Vec::new();
        for _ in 0..2000 {
            let x = Coordinates::new(&y, &yp, seeded.then_some(&seed[..]), 11., &scales).unwrap();
            let started = Instant::now();
            Rods::<Liquid>::volumes(&b, x, &VOLUMES, &mut volumes).unwrap();
            Rods::<Liquid>::rows(
                &mut b,
                &Liquid,
                0.,
                x,
                &f,
                &mut Receipts::new(&mut cells),
                &mut rows,
            )
            .unwrap();
            samples.push(started.elapsed().as_secs_f64());
        }
        samples.sort_by(f64::total_cmp);
        samples[samples.len() / 2]
    };
    let (value, seeded) = (time(false), time(true));
    println!(
        "{{\"kind\":\"rods-cost-NOT-EVIDENCE\",\"clusters\":52,\"groups\":8,\"value_median_us\":{:.2},\"seeded_median_us\":{:.2}}}",
        value * 1e6,
        seeded * 1e6
    );
    assert!(value < 1e-3 && seeded < 1e-3);
}

#[test]
fn a_converted_state_holds_lower_water_at_the_balancing_bore_pressure() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let current = 1.315701;
    let stocks = b
        .bore_stocks_at(
            &Liquid,
            &leitbild_operating_plant::rods::LowerField {
                pressure_pa: p_lower(),
                density_kg_m3: RHO_L,
                viscosity_pa_s: MU_L,
                internal_energy_j_kg: u_lower(),
                boron_concentration: 1e-3,
            },
            &[2.8; N],
            &[0.; N],
            &[current; N],
        )
        .unwrap();
    let mut physical = Rods::<Liquid>::prepared(&b);
    for c in 0..N {
        physical[ci(&b, c, LOWER_CURRENT)] = current;
        physical[ci(&b, c, UPPER_CURRENT)] = current;
    }
    for (g, s) in stocks.iter().enumerate() {
        for (k, v) in [BORE_MASS, BORE_ENERGY, BORE_BORON, BORE_PRESSURE]
            .iter()
            .zip(s)
        {
            physical[b.group_index(g, *k)] = *v;
        }
    }
    let y = solver(&b, &physical);
    let yp = vec![0.; y.len()];
    let (rows, _, _) = evaluate(&mut b, &y, &yp, None, 0., &water);
    for g in 0..stocks.len() {
        // The EOS row holds; the lower mouth closes on the bores' own water
        // (to its density's change between the two evaluations), the upper
        // to their 3e-5 lighter column (a few pascals), for the consistent
        // start to remove.
        assert!(rows[b.group_index(g, BORE_PRESSURE)].value.abs() < 1e-12);
        let c = b.bore_groups()[g][0];
        assert!(
            rows[ci(&b, c, LOWER_CURRENT)].value.abs() < 1e-2,
            "lower {}",
            rows[ci(&b, c, LOWER_CURRENT)].value
        );
        assert!(
            rows[ci(&b, c, UPPER_CURRENT)].value.abs() < 4.,
            "upper {}",
            rows[ci(&b, c, UPPER_CURRENT)].value
        );
    }
}

/// P2-FIX-1: a seated body's tip sits at the lower mouth, and the lower
/// path still runs up the annulus to the bores' reference height, so at rest
/// the lower balance keeps the annulus's laminar slope in its current (the
/// bare mouth loss alone has none: `m|m|`). The seated post-trip -4 of the
/// joint P2 + N1 C3 run came from that missing slope.
#[test]
fn a_seated_lower_balance_keeps_a_laminar_slope_at_rest() {
    let water = z4_field(0.);
    let mut b = block(SpiderDrag::Omitted);
    let mut physical = held(&mut b, &water, 0., 0.);
    for c in 0..N {
        b.set_mode(c, Mode::Seated);
    }
    let d = fluid_data(&water);
    let f = fluid(&d);
    let scales = layout(&b).scales.clone();
    let lower = |physical: &[f64]| -> f64 {
        let y = solver(&b, physical);
        let yp = vec![0.; y.len()];
        let x = Coordinates::new(&y, &yp, None, 0., &scales).unwrap();
        let bore = b.bore(&Liquid, b.group_of(0), &x).unwrap();
        b.forces(0, &x, &f, &bore).unwrap().lower_residual.value
    };
    let h = 1e-6;
    physical[ci(&b, 0, LOWER_CURRENT)] = h;
    let up = lower(&physical);
    physical[ci(&b, 0, LOWER_CURRENT)] = -h;
    let down = lower(&physical);
    let slope = (up - down) / (2. * h);
    // The exact laminar annulus over the reference's 2.325 m: of the order of
    // the Z4 annulus's 1e5 Pa per kg/s over its whole length.
    let paths = b.mouth_paths(Scalar::constant(-2.25), Branch::Insertion);
    assert!((paths.lower_annulus.value - 2.325).abs() < 1e-12 && paths.lower_clear.value == 0.);
    assert!((paths.upper_annulus.value - 2.325).abs() < 1e-12 && paths.upper_clear.value == 0.);
    assert!(slope < -1e4, "seated lower slope {slope} Pa per kg/s");
    // The paths tile the guide at any pose: total clear and annular lengths
    // are the tip's.
    for tip in [-2.25, -1., 0.075, 0.55, 1.75] {
        for branch in [Branch::Insertion, Branch::Withdrawal] {
            let p = b.mouth_paths(Scalar::constant(tip), branch);
            assert!(((p.lower_clear + p.upper_clear).value - (tip + 2.25)).abs() < 1e-12);
            assert!(((p.lower_annulus + p.upper_annulus).value - (2.4 - tip)).abs() < 1e-12);
        }
    }
}

#[test]
fn a_packet_layout_state_reduces_to_the_bank_exactly_or_is_refused() {
    // EVT-RODS-BANK: 52 clusters x 4, then the 8 sector-share groups x 4.
    let b = grouped_block(SpiderDrag::Omitted);
    let mut keys: Vec<[f64; 4]> = Vec::new();
    let old: Vec<usize> = (0..N)
        .map(|c| match keys.iter().position(|k| *k == shares(c)) {
            Some(k) => k,
            None => {
                keys.push(shares(c));
                keys.len() - 1
            }
        })
        .collect();
    assert_eq!(keys.len(), 8);
    let mut full: Vec<f64> = (0..N).flat_map(|_| [0.7, 0., 0.31, 0.29]).collect();
    full[CLUSTER_COORDINATES * 3 + LOWER_CURRENT] = 0.31 * (1. + 4e-16);
    for g in 0..8 {
        full.extend([1. + 1e-16 * g as f64, 0.9, 0.8, 0.99]);
    }
    let (y, spread) = b.reduce_packet_state(&full).unwrap();
    assert_eq!(y.len(), CLUSTER_COORDINATES + 4);
    assert_eq!(&y[..4], &[0.7, 0., 0.31, 0.29]);
    assert!(spread[1] > 0. && spread[1] < 1e-15);
    // The region's stock is its groups' member-weighted sum.
    let members = |g: usize| old.iter().filter(|o| **o == g).count() as f64;
    let m: f64 = (0..8).map(|g| (1. + 1e-16 * g as f64) * members(g)).sum::<f64>() / N as f64;
    assert_eq!(y[CLUSTER_COORDINATES + BORE_MASS], m);
    assert_eq!(y[CLUSTER_COORDINATES + BORE_PRESSURE], 0.99);
    // NUC review: groups whose stocks differ beyond round-off are refused in
    // a state and merged in its rates.
    let water = CLUSTER_COORDINATES * N;
    let mut far = full.clone();
    far[water + 4 * 3 + BORE_ENERGY] = 0.9 * (1. + 1e-12);
    assert!(b.reduce_packet_state(&far).is_err());
    assert!(b.reduce_packet_rates(&far).is_ok());
    // A member whose travel differs is not a replica: refused.
    full[CLUSTER_COORDINATES * 7 + TRAVEL] = 0.7000000000000001;
    assert!(b.reduce_packet_state(&full).is_err());
    assert!(b.reduce_packet_state(&full[..10]).is_err());
}

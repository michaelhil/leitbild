//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/reservoir-and-containment.md#compact-operating-allocation-15-october-2026
//! G1-C13 Gate-1 design prototype: a TEST-ONLY standalone containment block
//! (the ELEC-slice pattern: own rows, dense analytic block). It is never
//! joined to the unit, never integrated and never a gate. It reads the
//! compiled containment packet (`LD01_G1_C13_PACKET`, from
//! `apps/world/scripts/reference-design-operating-containment.ts`) and checks,
//! at the prepared quiet state and at five declared probe states:
//! - the census (differential/algebraic coordinates, structural nnz);
//! - the scaled zero-time residual (≤ 1e-12) and the prepared root values;
//! - the declared direction of every port input on its receiving rows, at
//!   the prepared state and at an active probe;
//! - forward-mode (IF97 exact rho/u/h directions) partials against central
//!   differences (1e-6 relative);
//! - the iteration matrix `dF/dy + cj dF/dy'` nonsingular for cj 1e1..1e5,
//!   with no `1/cj` pivot (one index-1 DAE: S4-D5);
//! - the CPU cost of one residual and one dense Jacobian.
//!
//! Owners and coordinates (wiki allocation table): CNV gas `M_air, M_N2,
//! M_w, E_mix | p, T, V_mix, M_d, v_t`; shell remainder `U`; 16 local bay
//! hosts `U`; four open pools WST, GUTTER, FLOOR, SUMP `M, E, B | T, V, h,
//! m_b`; PCC tank `M`; exterior film `M, H | T, m_evap`. Bulk boiling and
//! film evaporation are equilibrium modes (S3-D-P1, S4-D5): energy stays
//! differential, the saturated endpoint splits it into an algebraic `M`, and
//! the phase change is the net flow minus `M'`; the `m_b`/`m_evap` slots are
//! unused in those modes. Bays (C17: surfaces,
//! liquid temperatures, occupied volume), PRHR (C11), releases (C06),
//! capture heat and ROOM.B (C12) are held port inputs.
//!
//! The containment declares a low-pressure domain (S4-D2, owner decision
//! F5): its water states use the bridge's `Domain::LowPressure` (down to
//! 611.657 Pa), and `p_sat(T)`, the 25°C vapor anchor and the
//! saturated-vapor viscosity use C13's three saturation entries by
//! temperature.
// Test-only dense-matrix loops and fixed four-pool tables.
#![allow(
    clippy::too_many_arguments,
    clippy::needless_range_loop,
    clippy::useless_vec
)]
use leitbild_operating_water::{
    Branch, Domain, directional_in, point_in, saturated_vapor_enthalpy, saturated_vapor_viscosity,
    saturation_pressure,
};
use serde_json::{Value, json};
use std::ops::{Add, Div, Mul, Neg, Sub};

mod common;
use common::cpu;

/// Standard gravity of the network and of the collection checker.
const G: f64 = 9.80665;
/// S4-D13: the FLOOR→SUMP drains carry path inertance (a differential flow
/// per channel), since the wiki selects no low-Reynolds branch for their
/// square-root law. The wiki gives the channels no length or area, so their
/// inertance `∫dx/A` is a wiki-engineering gap. This is a STRUCTURAL CHECK
/// VALUE ONLY, not a selection: the rows, partials and directions do not
/// depend on it, and the pivots are re-checked at 1e2 and 1e6 1/m.
const DRAIN_INERTANCE_CHECK_PER_M: f64 = 1e4;

// ---------------------------------------------------------------- dual numbers
#[derive(Clone, Copy, Debug, PartialEq)]
struct D {
    v: f64,
    d: f64,
}
impl D {
    fn c(v: f64) -> Self {
        Self { v, d: 0. }
    }
    fn new(v: f64, d: f64) -> Self {
        Self { v, d }
    }
    fn sqrt(self) -> Self {
        let s = self.v.sqrt();
        Self::new(s, if self.d == 0. { 0. } else { self.d / (2. * s) })
    }
    fn powf(self, e: f64) -> Self {
        let d = if self.d == 0. {
            0.
        } else {
            e * self.v.powf(e - 1.) * self.d
        };
        Self::new(self.v.powf(e), d)
    }
    /// Positive part raised to 3/2: C1, slope zero at the crest.
    fn crest(self) -> Self {
        if self.v > 0. {
            let s = self.v.sqrt();
            Self::new(self.v * s, 1.5 * s * self.d)
        } else {
            Self::c(0.)
        }
    }
}
impl Add for D {
    type Output = D;
    fn add(self, o: D) -> D {
        D::new(self.v + o.v, self.d + o.d)
    }
}
impl Sub for D {
    type Output = D;
    fn sub(self, o: D) -> D {
        D::new(self.v - o.v, self.d - o.d)
    }
}
impl Mul for D {
    type Output = D;
    fn mul(self, o: D) -> D {
        D::new(self.v * o.v, self.d * o.v + self.v * o.d)
    }
}
impl Div for D {
    type Output = D;
    fn div(self, o: D) -> D {
        D::new(self.v / o.v, (self.d * o.v - self.v * o.d) / (o.v * o.v))
    }
}
impl Neg for D {
    type Output = D;
    fn neg(self) -> D {
        D::new(-self.v, -self.d)
    }
}
impl Add<f64> for D {
    type Output = D;
    fn add(self, o: f64) -> D {
        D::new(self.v + o, self.d)
    }
}
impl Sub<f64> for D {
    type Output = D;
    fn sub(self, o: f64) -> D {
        D::new(self.v - o, self.d)
    }
}
impl Mul<f64> for D {
    type Output = D;
    fn mul(self, o: f64) -> D {
        D::new(self.v * o, self.d * o)
    }
}
impl Div<f64> for D {
    type Output = D;
    fn div(self, o: f64) -> D {
        D::new(self.v / o, self.d / o)
    }
}
fn c(v: f64) -> D {
    D::c(v)
}

// ------------------------------------------------- the single property boundary
/// IF97 liquid at (p, T): density, specific internal energy, enthalpy.
fn liquid(p: D, t: D) -> Result<(D, D, D), String> {
    let (q, d) = directional_in(Domain::LowPressure, Branch::Liquid, p.v, t.v, p.d, t.d)
        .map_err(|e| format!("IF97 liquid at {} Pa, {} K: {e}", p.v, t.v))?;
    Ok((
        D::new(q.density_kg_m3, d.density_kg_m3),
        D::new(q.internal_energy_j_kg, d.internal_energy_j_kg),
        D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    ))
}
/// IF97 saturated-liquid endpoint at p: density, internal energy, enthalpy.
fn saturated_liquid(p: D) -> Result<(D, D, D), String> {
    let (q, d) = directional_in(
        Domain::LowPressure,
        Branch::SaturatedLiquid,
        p.v,
        0.,
        p.d,
        0.,
    )
    .map_err(|e| format!("IF97 saturated liquid at {} Pa: {e}", p.v))?;
    Ok((
        D::new(q.density_kg_m3, d.density_kg_m3),
        D::new(q.internal_energy_j_kg, d.internal_energy_j_kg),
        D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    ))
}
/// IF97 saturation pressure at T (lane hook).
fn psat(t: D) -> Result<D, String> {
    let (v, d) = saturation_pressure(t.v, t.d).map_err(|e| format!("IF97 p_sat({}): {e}", t.v))?;
    Ok(D::new(v, d))
}
/// IF97 saturated-vapor viscosity at T (lane hook).
fn mu_vapor(t: D) -> Result<D, String> {
    let (v, d) =
        saturated_vapor_viscosity(t.v, t.d).map_err(|e| format!("IF97 mu_g,sat({}): {e}", t.v))?;
    Ok(D::new(v, d))
}
/// IF97 saturation temperature at p.
fn tsat(p: D) -> Result<D, String> {
    let (q, d) = directional_in(
        Domain::LowPressure,
        Branch::SaturatedLiquid,
        p.v,
        0.,
        p.d,
        0.,
    )
    .map_err(|e| format!("IF97 Tsat({}): {e}", p.v))?;
    Ok(D::new(q.temperature_k, d.temperature_k))
}

// ------------------------------------------------------------------- the packet
fn num(v: &Value, path: &str) -> f64 {
    path.split('.')
        .fold(v, |v, k| &v[k])
        .as_f64()
        .unwrap_or_else(|| panic!("packet field {path}"))
}
#[derive(Clone, Debug)]
struct Patch {
    id: String,
    /// Bay indices WELL=0, CANAL=1, POOL=2, one per side.
    sides: Vec<usize>,
    floor: bool,
    area: f64,
    z: f64,
    /// Wall rectangles [width, bottom, top]; empty for a floor patch.
    rects: Vec<[f64; 3]>,
    capacity: f64,
}
impl Patch {
    /// Covered fraction and uncovered centroid of one side at bay surface `h`.
    fn cover(&self, h: f64) -> (f64, f64) {
        if self.floor {
            return (if h > self.z { 1. } else { 0. }, self.z);
        }
        let (mut wet, mut dry, mut moment) = (0., 0., 0.);
        for &[w, b, t] in &self.rects {
            let lo = h.clamp(b, t);
            wet += w * (lo - b);
            dry += w * (t - lo);
            moment += w * (t * t - lo * lo) / 2.;
        }
        (
            wet / self.area,
            if dry > 0. { moment / dry } else { self.z },
        )
    }
}
#[derive(Clone, Debug)]
struct PoolGeo {
    id: String,
    area: f64,
    floor: f64,
    hw_volume: f64,
    hw_moment: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Law {
    /// Chutes and spills: `1.7 b ([hA-zc]+^1.5 - [hB-zc]+^1.5)`.
    Backwater,
    /// The SUMP rim: head over the higher of the rim and the receiving surface.
    ReceivingSurface,
}
#[derive(Clone, Debug)]
struct Crest {
    id: String,
    from: usize,
    to: usize,
    width: f64,
    crest: f64,
    law: Law,
}
#[derive(Clone, Debug)]
struct Prm {
    v_gas0: f64,
    t0: f64,
    p0: f64,
    ra: f64,
    cva: f64,
    rv: f64,
    cpv: f64,
    rn: f64,
    cvn: f64,
    tref: f64,
    z0: f64,
    hv_ref: f64,
    shell_t0: f64,
    gdry: f64,
    kcond: f64,
    a_total: f64,
    rem_area: f64,
    rem_cap: f64,
    upper: (f64, f64),
    lower: (f64, f64),
    patches: Vec<Patch>,
    bay_floors: [f64; 3],
    pools: Vec<PoolGeo>,
    wst_water: f64,
    wst_t0: f64,
    wst_tracer: f64,
    weir: f64,
    ksurf: f64,
    crests: Vec<Crest>,
    drain_face: f64,
    drain_ref_m: f64,
    drain_ref_dp: f64,
    rho_ref: f64,
    drain_inertance: f64,
    drop_d: f64,
    drag: [f64; 5],
    mu_air: [f64; 3],
    mu_n2: [f64; 3],
    tank_v: f64,
    tank_area: f64,
    tank_bottom: f64,
    film_datum: f64,
    feed_full: f64,
    feed_href: f64,
    film_mref: f64,
    film_g: f64,
    runoff_tau: f64,
    gamb: f64,
    t_amb: f64,
    p_amb: f64,
    rho_tank: f64,
    h_tank: f64,
    h_vsat_amb: f64,
}
const WST: usize = 0;
const GUTTER: usize = 1;
const FLOOR: usize = 2;
const SUMP: usize = 3;
const BAYS: [&str; 3] = ["WELL", "CANAL", "POOL"];
fn pool_index(id: &str) -> usize {
    match id {
        "WST" => WST,
        "GUTTER" => GUTTER,
        "FLOOR" => FLOOR,
        "SUMP" => SUMP,
        _ => panic!("unknown pool {id}"),
    }
}
fn load() -> (Prm, Value) {
    let path = std::env::var("LD01_G1_C13_PACKET")
        .expect("LD01_G1_C13_PACKET: the compiled containment packet (G1-C13 prototype input)");
    let v: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("packet")).expect("json");
    let a = &v["atmosphere"];
    let t0 = num(a, "initialTemperature_K");
    let p0 = num(a, "initialPressure_Pa");
    let tref = num(a, "referenceTemperature_K");
    // h_v_ref: IF97's saturated-vapor enthalpy at the reference temperature.
    let hv_ref = saturated_vapor_enthalpy(tref).expect("h_g(T_ref)");
    let patches = v["shell"]["local"]
        .as_array()
        .expect("local")
        .iter()
        .map(|p| Patch {
            id: p["id"].as_str().unwrap().into(),
            sides: p["bays"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| BAYS.iter().position(|x| *x == b.as_str().unwrap()).unwrap())
                .collect(),
            floor: p["kind"] == "floor",
            area: num(p, "area_m2"),
            z: num(p, "elevation_m"),
            rects: p["rectangles_m"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    [
                        r[0].as_f64().unwrap(),
                        r[1].as_f64().unwrap(),
                        r[2].as_f64().unwrap(),
                    ]
                })
                .collect(),
            capacity: num(p, "capacity_J_K"),
        })
        .collect::<Vec<_>>();
    assert_eq!(patches.len(), 16, "sixteen local hosts");
    let mut bay_floors = [f64::NAN; 3];
    for h in patches.iter().filter(|h| h.floor) {
        bay_floors[h.sides[0]] = h.z;
    }
    let mut pools = vec![];
    let mut wst = (0., 0., 0.);
    for p in v["pools"].as_array().expect("pools") {
        let id = p["id"].as_str().unwrap();
        assert_eq!(
            pool_index(id),
            pools.len(),
            "pool order WST, GUTTER, FLOOR, SUMP"
        );
        let (hv, hm) = if p["hardware"].is_null() {
            (0., 0.)
        } else {
            (
                num(p, "hardware.volume_m3"),
                num(p, "hardware.firstMoment_m4"),
            )
        };
        if id == "WST" {
            wst = (
                num(p, "initialWater_m3"),
                num(p, "initialTemperature_K"),
                num(p, "initialTracer_kg_kg"),
            );
        }
        pools.push(PoolGeo {
            id: id.into(),
            area: num(p, "area_m2"),
            floor: num(p, "floor_m"),
            hw_volume: hv,
            hw_moment: hm,
        });
    }
    let crests = v["paths"]["crests"]
        .as_array()
        .expect("crests")
        .iter()
        .map(|q| Crest {
            id: q["id"].as_str().unwrap().into(),
            from: pool_index(q["from"].as_str().unwrap()),
            to: pool_index(q["to"].as_str().unwrap()),
            width: num(q, "width_m"),
            crest: num(q, "crest_m"),
            law: match q["law"].as_str().unwrap() {
                "backwater" => Law::Backwater,
                "receiving-surface" => Law::ReceivingSurface,
                other => panic!("unknown crest law {other}"),
            },
        })
        .collect();
    let dr = &v["paths"]["drains"];
    let rho_ref = liquid(
        c(num(dr, "referencePressure_Pa")),
        c(num(dr, "referenceTemperature_K")),
    )
    .unwrap()
    .0
    .v;
    let dp = &v["droplets"];
    let mu = |k: &str| {
        [
            num(dp, &format!("{k}.reference_Pa_s")),
            num(dp, &format!("{k}.referenceTemperature_K")),
            num(dp, &format!("{k}.exponent")),
        ]
    };
    assert_eq!(dp["vaporViscosity"], "native-saturated-vapor");
    let x = &v["exterior"];
    let (t_amb, p_amb) = (
        num(x, "ambient.temperature_K"),
        num(x, "ambient.pressure_Pa"),
    );
    let tank_t = num(x, "tank.temperature_K");
    let (rho_tank, _, h_tank) = liquid(c(p_amb), c(tank_t)).unwrap();
    let h_vsat_amb = point_in(Domain::LowPressure, Branch::SaturatedVapor, p_amb, 0.)
        .unwrap()
        .enthalpy_j_kg;
    let s = &v["shell"];
    let cat = &s["remainder"]["catchments"];
    assert_eq!(cat[0]["id"], "UPPER");
    assert_eq!(cat[1]["id"], "LOWER");
    let prm = Prm {
        v_gas0: num(a, "gasVolume_m3"),
        t0,
        p0,
        ra: num(a, "airGasConstant_J_kgK"),
        cva: num(a, "airCv_J_kgK"),
        rv: num(a, "vaporGasConstant_J_kgK"),
        cpv: num(a, "vaporCp_J_kgK"),
        rn: num(a, "nitrogenGasConstant_J_kgK"),
        cvn: num(a, "nitrogenCv_J_kgK"),
        tref,
        z0: num(a, "origin_m"),
        hv_ref,
        shell_t0: num(s, "initialTemperature_K"),
        gdry: num(s, "dryContactTotal_W_K"),
        kcond: num(s, "condensationVelocity_m_s"),
        a_total: num(s, "totalArea_m2"),
        rem_area: num(s, "remainder.area_m2"),
        rem_cap: num(s, "remainder.capacity_J_K"),
        upper: (num(&cat[0], "area_m2"), num(&cat[0], "elevation_m")),
        lower: (num(&cat[1], "area_m2"), num(&cat[1], "elevation_m")),
        patches,
        bay_floors,
        pools,
        wst_water: wst.0,
        wst_t0: wst.1,
        wst_tracer: wst.2,
        weir: num(&v["paths"], "crestCoefficient"),
        ksurf: num(&v["paths"], "surfaceTransferVelocity_m_s"),
        crests,
        drain_face: num(dr, "face_m"),
        drain_ref_m: num(dr, "reference_kg_s"),
        drain_ref_dp: num(dr, "referenceHead_Pa"),
        drain_inertance: DRAIN_INERTANCE_CHECK_PER_M,
        rho_ref,
        drop_d: num(dp, "diameter_m"),
        drag: [
            num(dp, "dragStokes"),
            num(dp, "dragCorrection"),
            num(dp, "dragExponent"),
            num(dp, "dragReynoldsLimit"),
            num(dp, "newtonDrag"),
        ],
        mu_air: mu("airViscosity"),
        mu_n2: mu("nitrogenViscosity"),
        tank_v: num(x, "tank.volume_m3"),
        tank_area: num(x, "tank.area_m2"),
        tank_bottom: num(x, "tank.bottom_m"),
        film_datum: num(x, "filmDatum_m"),
        feed_full: num(x, "fullOpenFeed_kg_s"),
        feed_href: num(x, "feedReferenceHead_m"),
        film_mref: num(x, "film.referenceMass_kg"),
        film_g: num(x, "film.conductance_W_K"),
        runoff_tau: num(x, "film.runoffResidence_s"),
        gamb: num(x, "dryConductance_W_K"),
        t_amb,
        p_amb,
        rho_tank: rho_tank.v,
        h_tank: h_tank.v,
        h_vsat_amb,
    };
    (prm, v)
}

// --------------------------------------------------------------------- layout
const MAIR: usize = 0;
const MN2: usize = 1;
const MW: usize = 2;
const EMIX: usize = 3;
const P: usize = 4;
const T: usize = 5;
const VMIX: usize = 6;
const MD: usize = 7;
const REM: usize = 8;
const LOC0: usize = 9;
const POOL0: usize = 25;
const PM: usize = 0;
const PE: usize = 1;
const PB: usize = 2;
const PT: usize = 3;
const PV: usize = 4;
const PH: usize = 5;
const PMB: usize = 6;
const TANK: usize = 53;
const FM: usize = 54;
const FH: usize = 55;
const FT: usize = 56;
const FEV: usize = 57;
const VT: usize = 58;
/// FLOOR→SUMP drain channel mass flows (S4-D13 inertance form).
const DR0: usize = 59;
const N: usize = 61;
fn pool(i: usize, slot: usize) -> usize {
    POOL0 + 7 * i + slot
}
/// The mode-dependent classification (S3-D-P1 slot reinterpretation): a
/// boiling pool's `M` and an evaporating film's `M` are algebraic (the
/// saturated-endpoint split of their differential energy).
fn is_diff(i: usize, m: &Modes) -> bool {
    if (POOL0..TANK).contains(&i) && (i - POOL0) % 7 == PM && m.pools[(i - POOL0) / 7] == Pool::B {
        return false;
    }
    if i == FM && m.film == Film::Evap {
        return false;
    }
    differential(i)
}
/// The declared (prepared) classification.
fn differential(i: usize) -> bool {
    match i {
        MAIR | MN2 | MW | EMIX | REM | TANK | FM | FH | DR0 | 60 => true,
        LOC0..POOL0 => true,
        _ if (POOL0..TANK).contains(&i) => (i - POOL0) % 7 < 3,
        _ => false,
    }
}
fn name(i: usize, p: &Prm) -> String {
    match i {
        MAIR => "CNV.M_air".into(),
        MN2 => "CNV.M_N2".into(),
        MW => "CNV.M_w".into(),
        EMIX => "CNV.E_mix".into(),
        P => "CNV.p".into(),
        T => "CNV.T".into(),
        VMIX => "CNV.V_mix".into(),
        MD => "CNV.M_d".into(),
        VT => "CNV.v_t".into(),
        DR0 | 60 => format!("FLOOR-SUMP.DRAIN.{}.m", i - DR0 + 1),
        REM => "SHELL.REMAINDER.U".into(),
        TANK => "PCC.TANK.M".into(),
        FM => "PCC.FILM.M".into(),
        FH => "PCC.FILM.H".into(),
        FT => "PCC.FILM.T".into(),
        FEV => "PCC.FILM.m_evap".into(),
        _ if (LOC0..POOL0).contains(&i) => format!("HOST.{}.U", p.patches[i - LOC0].id),
        _ => {
            let k = i - POOL0;
            let slot = ["M", "E", "B", "T", "V", "h", "m_b"][k % 7];
            format!("{}.{slot}", p.pools[k / 7].id)
        }
    }
}

// ---------------------------------------------------------------------- modes
#[derive(Clone, Copy, Debug, PartialEq)]
enum Gas {
    /// No droplets: M_d = 0.
    V,
    /// Droplets: vapor saturated at the mixture temperature.
    E,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Pool {
    Empty,
    L,
    B,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Film {
    Dry,
    Wet,
    Evap,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Donor {
    Pool,
    Gas,
}
#[derive(Clone, Debug)]
struct Modes {
    gas: Gas,
    /// Catchments: 0 upper, 1 lower, 2.. local patches.
    condense: [bool; 18],
    pools: [Pool; 4],
    /// Held donor of each pool's signed surface exchange.
    donors: [Donor; 4],
    lower_covered: bool,
    film: Film,
    tank_empty: bool,
    drains_locked: bool,
}
impl Modes {
    fn prepared() -> Self {
        Self {
            gas: Gas::V,
            condense: [false; 18],
            pools: [Pool::L, Pool::Empty, Pool::Empty, Pool::Empty],
            donors: [Donor::Pool; 4],
            lower_covered: false,
            film: Film::Dry,
            tank_empty: false,
            drains_locked: true,
        }
    }
}

// ---------------------------------------------------------------- port inputs
#[derive(Clone, Debug)]
struct Inputs {
    /// C06 release gas phase into CNV: water (kg/s) and its Ht; air and N2
    /// (kg/s) at their temperature and port elevation.
    break_water: f64,
    break_water_ht: f64,
    break_air: f64,
    break_n2: f64,
    break_nc_t: f64,
    break_nc_z: f64,
    /// C06 release liquid into SUMP: mass, Ht, tracer mass fraction.
    break_liquid: f64,
    break_liquid_ht: f64,
    break_liquid_tracer: f64,
    /// C11 ADS1–3 sparger into WST; its air to CNV at the sparger elevation.
    ads_water: f64,
    ads_ht: f64,
    ads_tracer: f64,
    ads_air: f64,
    ads_nc_t: f64,
    ads_nc_z: f64,
    /// C11 PRHR external contact heat into WST (W).
    prhr_q: f64,
    /// C11 GIV (WST) and RECIRC (SUMP) withdrawals (kg/s, positive out).
    giv: f64,
    recirc: f64,
    /// C11 accumulator N2 vent (kg/s) at its temperature and elevation.
    acc_n2: f64,
    acc_n2_t: f64,
    acc_n2_z: f64,
    /// Actuator owner's PCC opening in [0,1].
    pcc_a: f64,
    /// Site: ambient temperature, dry-path impairment factor.
    t_amb: f64,
    impairment: f64,
    /// C17 bays (WELL, CANAL, POOL): surface elevation, liquid temperature,
    /// and the change of their occupied volume since preparation.
    bay_surface: [f64; 3],
    bay_t: [f64; 3],
    bay_volume: f64,
    /// Radiation/capture receipts: remainder, then the 16 hosts (W).
    capture: [f64; 17],
    /// Path open fractions: crests in packet order, then the two drains.
    crest_open: Vec<f64>,
    drain_open: [f64; 2],
}
impl Inputs {
    fn quiet(p: &Prm) -> Self {
        Self {
            break_water: 0.,
            break_water_ht: 2.8e6,
            break_air: 0.,
            break_n2: 0.,
            break_nc_t: p.t0,
            break_nc_z: 0.,
            break_liquid: 0.,
            break_liquid_ht: 1.3e6,
            break_liquid_tracer: 0.,
            ads_water: 0.,
            ads_ht: 2.7e6,
            ads_tracer: 0.,
            ads_air: 0.,
            ads_nc_t: p.t0,
            ads_nc_z: 9.,
            prhr_q: 0.,
            giv: 0.,
            recirc: 0.,
            acc_n2: 0.,
            acc_n2_t: p.t0,
            acc_n2_z: 0.,
            pcc_a: 0.,
            t_amb: p.t_amb,
            impairment: 1.,
            bay_surface: p.bay_floors,
            bay_t: [p.t0; 3],
            bay_volume: 0.,
            capture: [0.; 17],
            crest_open: vec![1.; p.crests.len()],
            drain_open: [1., 1.],
        }
    }
}

// ------------------------------------------------------------------- residual
struct Eval {
    f: Vec<D>,
    rhs: Vec<D>,
    /// Boil-off of each B pool and the film's evaporation, `net - M'`
    /// (observations and exhaustion roots; zero outside those modes).
    boil: Vec<f64>,
    evap: f64,
}
/// Rows in coordinate order. Differential rows are `y' - rhs`; algebraic rows
/// are the constraints of the allocation table. `rhs` is also returned for
/// the directional checks. `v_avail` is the preparation's available
/// enclosure: prepared gas plus prepared liquid and C17 occupancy.
fn residual(
    p: &Prm,
    m: &Modes,
    u: &Inputs,
    v_avail: f64,
    y: &[D],
    yp: &[D],
) -> Result<Eval, String> {
    let mut rhs = vec![c(0.); N];
    let mut f = vec![c(0.); N];
    let (mair, mn2, mw, e, pr, t, vmix, md) =
        (y[MAIR], y[MN2], y[MW], y[EMIX], y[P], y[T], y[VMIX], y[MD]);
    let hv = |t: D| (t - p.tref) * p.cpv + p.hv_ref;
    let uv = |t: D| hv(t) - t * p.rv;
    let mv = mw - md;
    let drop = if m.gas == Gas::E {
        Some(liquid(pr, t)?)
    } else {
        None
    };
    let vgas = match drop {
        Some((rho, _, _)) => vmix - md / rho,
        None => vmix,
    };
    let umix = mair * (t - p.tref) * p.cva
        + mn2 * (t - p.tref) * p.cvn
        + mv * uv(t)
        + drop.map_or(c(0.), |(_, ud, _)| md * ud);
    let rho_vb = mv / vgas;
    let htv_gas = hv(t) + G * p.z0;
    let gper = p.gdry / p.a_total;
    let rs = |tj: D| -> Result<D, String> { Ok(psat(tj)? / (tj * p.rv)) };

    // Pool states (Empty owns no temperature, level or head and is never read).
    struct Ps {
        rho: D,
        hs: D,
    }
    let mut ps: Vec<Option<Ps>> = vec![];
    for (i, g) in p.pools.iter().enumerate() {
        let (pm, pe, pt, pv, ph) = (
            y[pool(i, PM)],
            y[pool(i, PE)],
            y[pool(i, PT)],
            y[pool(i, PV)],
            y[pool(i, PH)],
        );
        f[pool(i, PH)] = (ph - g.floor) * g.area - g.hw_volume - pv;
        let moment = (ph * ph - g.floor * g.floor) * (g.area / 2.) - g.hw_moment;
        match m.pools[i] {
            Pool::Empty => {
                f[pool(i, PT)] = pt - p.t0; // placeholder, read by no row
                f[pool(i, PV)] = pv;
                f[pool(i, PMB)] = y[pool(i, PMB)];
                ps.push(None);
            }
            Pool::L => {
                let (rho, uu, hs) = liquid(pr, pt)?;
                f[pool(i, PT)] = pe - (pm * uu + rho * moment * G);
                f[pool(i, PV)] = pv - pm / rho;
                f[pool(i, PMB)] = y[pool(i, PMB)];
                ps.push(Some(Ps { rho, hs }));
            }
            Pool::B => {
                // Equilibrium mode (S3-D-P1): E stays differential; the liquid
                // is the saturated endpoint at p_CNV, so M is the algebraic
                // split of E (no metastable evaluation, first derivatives
                // only). The boil-off is never a coordinate: it is the pool's
                // net flow minus the rate of its algebraic M, paid below.
                let (rho, uu, hs) = saturated_liquid(pr)?;
                f[pool(i, PM)] = pe - (pm * uu + rho * moment * G);
                f[pool(i, PT)] = pt - tsat(pr)?;
                f[pool(i, PV)] = pv - pm / rho;
                f[pool(i, PMB)] = y[pool(i, PMB)]; // unused slot in mode B
                ps.push(Some(Ps { rho, hs }));
            }
        }
    }
    let level = |i: usize| y[pool(i, PH)];
    let tracer = |i: usize| y[pool(i, PB)] / y[pool(i, PM)];

    let mut pm = vec![c(0.); 4];
    let mut pen = vec![c(0.); 4];
    let mut pb = vec![c(0.); 4];
    let (mut g_air, mut g_n2, mut g_w, mut g_e) = (c(0.), c(0.), c(0.), c(0.));
    let trem = y[REM] / p.rem_cap + p.tref;
    let mut q_rem = c(u.capture[0]);
    let tloc: Vec<D> = p
        .patches
        .iter()
        .enumerate()
        .map(|(k, q)| y[LOC0 + k] / q.capacity + p.tref)
        .collect();
    let mut q_loc: Vec<D> = (0..16).map(|k| c(u.capture[1 + k])).collect();

    // Condensation on a catchment of temperature tj, uncovered area a, formation z.
    let condense = |tj: D, a: f64, z: f64| -> Result<(D, D, D), String> {
        let mj = (rho_vb - rs(tj)?) * (p.kcond * a);
        let (_, _, hl) = liquid(pr, tj)?;
        let htl = hl + G * z;
        Ok((mj, htl, mj * (htv_gas - htl)))
    };
    // Upper catchment → GUTTER.
    let (au, zu) = p.upper;
    let q = (t - trem) * (gper * au);
    q_rem = q_rem + q;
    g_e = g_e - q;
    if m.condense[0] {
        let (mj, htl, duty) = condense(trem, au, zu)?;
        q_rem = q_rem + duty;
        g_w = g_w - mj;
        g_e = g_e - mj * htv_gas;
        pm[GUTTER] = pm[GUTTER] + mj;
        pen[GUTTER] = pen[GUTTER] + mj * htl;
    }
    // Lower remainder → FLOOR, or submerged contact once FLOOR covers +6 m.
    let (al, zl) = p.lower;
    if !m.lower_covered {
        let q = (t - trem) * (gper * al);
        q_rem = q_rem + q;
        g_e = g_e - q;
        if m.condense[1] {
            let (mj, htl, duty) = condense(trem, al, zl)?;
            q_rem = q_rem + duty;
            g_w = g_w - mj;
            g_e = g_e - mj * htv_gas;
            pm[FLOOR] = pm[FLOOR] + mj;
            pen[FLOOR] = pen[FLOOR] + mj * htl;
        }
    } else {
        let q = (y[pool(FLOOR, PT)] - trem) * (gper * al);
        q_rem = q_rem + q;
        pen[FLOOR] = pen[FLOOR] - q;
    }
    // Local bay hosts: per side, the covered and uncovered shares from the
    // bay surface; condensation on the uncovered share at its actual
    // centroid into the bay (a C17 port, leaving C13).
    for (k, h) in p.patches.iter().enumerate() {
        let side = h.area / h.sides.len() as f64;
        for &bay in &h.sides {
            let (w, z_open) = h.cover(u.bay_surface[bay]);
            let q = (t - tloc[k]) * (gper * side * (1. - w));
            q_loc[k] = q_loc[k] + q;
            g_e = g_e - q;
            q_loc[k] = q_loc[k] + (c(u.bay_t[bay]) - tloc[k]) * (gper * side * w);
            if m.condense[2 + k] && w < 1. {
                let (mj, _htl, duty) = condense(tloc[k], side * (1. - w), z_open)?;
                q_loc[k] = q_loc[k] + duty;
                g_w = g_w - mj;
                g_e = g_e - mj * htv_gas;
            }
        }
    }
    // Exterior: dry path (impairment), finite film, partitioned by area.
    let wet = match m.film {
        Film::Dry => None,
        _ => {
            let fm = y[FM] / p.film_mref;
            Some(if fm.v < 1. { fm } else { c(1.) })
        }
    };
    let mut q_film = c(0.);
    let mut exterior = |tj: D, a: f64| -> D {
        let mut q = (c(u.t_amb) - tj) * (u.impairment * p.gamb * a / p.a_total);
        if let Some(w) = wet {
            let qf = (y[FT] - tj) * w * (p.film_g * a / p.a_total);
            q_film = q_film - qf;
            q = q + qf;
        }
        q
    };
    q_rem = q_rem + exterior(trem, p.rem_area);
    for (k, h) in p.patches.iter().enumerate() {
        q_loc[k] = q_loc[k] + exterior(tloc[k], h.area);
    }

    // Pool surfaces ↔ gas (signed, held donor), and boil-off in mode B.
    for i in 0..4 {
        if ps[i].is_none() {
            continue;
        }
        let ti = y[pool(i, PT)];
        let ms = (rs(ti)? - rho_vb) * (p.ksurf * p.pools[i].area);
        let ht = match m.donors[i] {
            Donor::Pool => hv(ti) + level(i) * G,
            Donor::Gas => htv_gas,
        };
        pm[i] = pm[i] - ms;
        pen[i] = pen[i] - ms * ht;
        g_w = g_w + ms;
        g_e = g_e + ms * ht;
    }
    // Crest paths (signed, actual donor; an empty owner has no surface).
    let surface = |i: usize| ps[i].as_ref().map(|_| level(i));
    for (j, cr) in p.crests.iter().enumerate() {
        let b = u.crest_open[j];
        if b == 0. {
            continue;
        }
        let net = match cr.law {
            Law::Backwater => {
                let head = |i: usize| surface(i).map_or(c(0.), |h| (h - cr.crest).crest());
                head(cr.from) - head(cr.to)
            }
            Law::ReceivingSurface => {
                // S4-D15: the rim acts only while the SUMP (its `from`)
                // surface is at or above the rim; below, deck water reaches
                // the pit only through the drains.
                if surface(cr.from).is_none_or(|h| h.v < cr.crest) {
                    continue;
                }
                let over = |donor: usize, receiver: usize| match surface(donor) {
                    None => c(0.),
                    Some(h) => {
                        let reference = match surface(receiver) {
                            Some(r) if r.v > cr.crest => r,
                            _ => c(cr.crest),
                        };
                        (h - reference).crest()
                    }
                };
                over(cr.from, cr.to) - over(cr.to, cr.from)
            }
        };
        let qv = net * (p.weir * cr.width * b);
        if qv.v == 0. && qv.d == 0. {
            continue;
        }
        let donor = if qv.v >= 0. { cr.from } else { cr.to };
        let s = ps[donor]
            .as_ref()
            .ok_or_else(|| format!("{}: donor without liquid", cr.id))?;
        let mflow = s.rho * qv;
        let ht = s.hs + level(donor) * G;
        let tr = mflow * tracer(donor);
        pm[cr.from] = pm[cr.from] - mflow;
        pen[cr.from] = pen[cr.from] - mflow * ht;
        pb[cr.from] = pb[cr.from] - tr;
        pm[cr.to] = pm[cr.to] + mflow;
        pen[cr.to] = pen[cr.to] + mflow * ht;
        pb[cr.to] = pb[cr.to] + tr;
    }
    // FLOOR → SUMP drains (S4-D13): each channel's mass flow is differential,
    // `I*m' = dP_face - K*m|m|` with `K = dP_ref/(m_ref*b)^2 * rho_ref/rho_donor`
    // (the selected 50 kg/s at 5 kPa), so the slope at zero drive is bounded.
    // Locked (no donor above the +4.1 m mouth, or blocked): zero flow, held.
    // Face pressure above the common CNV pressure, which cancels exactly.
    let face = |i: usize| -> D {
        match &ps[i] {
            Some(s) if level(i).v > p.drain_face => s.rho * (level(i) - p.drain_face) * G,
            _ => c(0.),
        }
    };
    let dp = face(FLOOR) - face(SUMP);
    for k in 0..2 {
        let (mflow, b) = (y[DR0 + k], u.drain_open[k]);
        if m.drains_locked || b == 0. {
            rhs[DR0 + k] = c(0.);
            continue;
        }
        // Held donor: the flow's sign (at exactly zero, the drive's).
        let forward = if mflow.v != 0. {
            mflow.v > 0.
        } else {
            dp.v >= 0.
        };
        let donor = if forward { FLOOR } else { SUMP };
        let s = ps[donor].as_ref().ok_or("drain donor without liquid")?;
        let kq = s.rho * (p.drain_ref_m * p.drain_ref_m * b * b / p.rho_ref);
        let loss = mflow * (if mflow.v < 0. { -mflow } else { mflow }) * p.drain_ref_dp / kq;
        rhs[DR0 + k] = (dp - loss) / p.drain_inertance;
        let ht = s.hs + level(donor) * G;
        pm[FLOOR] = pm[FLOOR] - mflow;
        pen[FLOOR] = pen[FLOOR] - mflow * ht;
        pb[FLOOR] = pb[FLOOR] - mflow * tracer(donor);
        pm[SUMP] = pm[SUMP] + mflow;
        pen[SUMP] = pen[SUMP] + mflow * ht;
        pb[SUMP] = pb[SUMP] + mflow * tracer(donor);
    }
    // Droplet settling (mode E): terminal speed v_t from the drag balance,
    // residence (20 - FLOOR surface)/v_t, settled liquid into FLOOR.
    match drop {
        None => f[VT] = y[VT],
        Some((rho_l, _, h_d)) => {
            let vt = y[VT];
            let mg = mair + mn2 + mv;
            let rho_g = mg / vgas;
            let law = |k: [f64; 3]| (t / k[1]).powf(k[2]) * k[0];
            let mu_g = (mair * law(p.mu_air) + mn2 * law(p.mu_n2) + mv * mu_vapor(t)?) / mg;
            let d = p.drop_d;
            let pi = std::f64::consts::PI;
            let re = rho_g * vt * d / mu_g;
            let weight = (rho_l - rho_g) * (pi * d * d * d / 6. * G);
            let [stokes, corr, expo, limit, newton] = p.drag;
            // 0.5 Cd rho_g (pi d^2/4) v^2 with Cd = 24/Re (1 + 0.15 Re^0.687).
            f[VT] = if re.v < limit {
                mu_g * vt * (pi * d * stokes / 8.) * (re.powf(expo) * corr + 1.) - weight
            } else {
                rho_g * vt * vt * (0.5 * newton * pi * d * d / 4.) - weight
            };
            let floor_surface = match ps[FLOOR] {
                Some(_) => level(FLOOR),
                None => c(p.pools[FLOOR].floor),
            };
            let settle = md * vt / (c(p.z0) - floor_surface);
            let ht = h_d + G * p.z0;
            g_w = g_w - settle;
            g_e = g_e - settle * ht;
            pm[FLOOR] = pm[FLOOR] + settle;
            pen[FLOOR] = pen[FLOOR] + settle * ht;
        }
    }
    // Port inputs (C06, C11): gas phase and NC into CNV, liquids to receivers.
    let h_nc = |cv: f64, r: f64, tin: f64, z: f64| cv * (tin - p.tref) + r * tin + G * z;
    g_w = g_w + u.break_water;
    g_e = g_e + u.break_water * u.break_water_ht;
    g_air = g_air + u.break_air + u.ads_air;
    g_e = g_e
        + u.break_air * h_nc(p.cva, p.ra, u.break_nc_t, u.break_nc_z)
        + u.ads_air * h_nc(p.cva, p.ra, u.ads_nc_t, u.ads_nc_z);
    g_n2 = g_n2 + u.break_n2 + u.acc_n2;
    g_e = g_e
        + u.break_n2 * h_nc(p.cvn, p.rn, u.break_nc_t, u.break_nc_z)
        + u.acc_n2 * h_nc(p.cvn, p.rn, u.acc_n2_t, u.acc_n2_z);
    pm[SUMP] = pm[SUMP] + u.break_liquid;
    pen[SUMP] = pen[SUMP] + u.break_liquid * u.break_liquid_ht;
    pb[SUMP] = pb[SUMP] + u.break_liquid * u.break_liquid_tracer;
    pm[WST] = pm[WST] + u.ads_water;
    pen[WST] = pen[WST] + u.ads_water * u.ads_ht + u.prhr_q;
    pb[WST] = pb[WST] + u.ads_water * u.ads_tracer;
    for (i, out) in [(WST, u.giv), (SUMP, u.recirc)] {
        // An uncovered (empty) intake has no donor: the C11 intake law gives zero.
        if out != 0.
            && let Some(s) = &ps[i]
        {
            let ht = s.hs + level(i) * G;
            pm[i] = pm[i] - out;
            pen[i] = pen[i] - ht * out;
            pb[i] = pb[i] - tracer(i) * out;
        }
    }

    // Boil-off of each B pool: its net flow minus the rate of its algebraic
    // M, carried at the vapor convention `h_v(T) + g*surface` into CNV; the
    // same expression leaves the pool's E and enters the gas once.
    let mut boil = vec![0.; 4];
    for i in 0..4 {
        if m.pools[i] == Pool::B {
            let mb = pm[i] - yp[pool(i, PM)];
            let htb = hv(y[pool(i, PT)]) + level(i) * G;
            pen[i] = pen[i] - mb * htb;
            g_w = g_w + mb;
            g_e = g_e + mb * htb;
            boil[i] = mb.v;
        }
    }

    // CNV rows.
    rhs[MAIR] = g_air;
    rhs[MN2] = g_n2;
    rhs[MW] = g_w;
    rhs[EMIX] = g_e - pr * yp[VMIX];
    f[T] = e - (umix + (mair + mn2 + mw) * (G * p.z0));
    f[P] = pr * vgas - (mair * p.ra + mn2 * p.rn + mv * p.rv) * t;
    let liquids = (0..4).fold(c(0.), |s, i| s + y[pool(i, PV)]);
    f[VMIX] = vmix - (c(v_avail - u.bay_volume) - liquids);
    f[MD] = match m.gas {
        Gas::V => md,
        Gas::E => mv * p.rv * t - psat(t)? * vgas,
    };
    rhs[REM] = q_rem;
    rhs[LOC0..POOL0].copy_from_slice(&q_loc);
    for i in 0..4 {
        rhs[pool(i, PM)] = pm[i];
        rhs[pool(i, PE)] = pen[i] - pr * yp[pool(i, PV)];
        rhs[pool(i, PB)] = pb[i];
    }
    // PCC tank and film.
    let head = y[TANK] / (p.rho_tank * p.tank_area) + (p.tank_bottom - p.film_datum);
    let feed = if m.tank_empty || u.pcc_a == 0. {
        c(0.)
    } else {
        (head / p.feed_href).sqrt() * (u.pcc_a * p.feed_full)
    };
    rhs[TANK] = -feed;
    let mut evap = 0.;
    match m.film {
        Film::Dry => {
            rhs[FM] = feed;
            rhs[FH] = feed * p.h_tank;
            f[FT] = y[FT] - p.t_amb; // placeholder, read by no row
            f[FEV] = y[FEV];
        }
        Film::Wet | Film::Evap => {
            let hf = if m.film == Film::Wet {
                liquid(c(p.p_amb), y[FT])?.2
            } else {
                saturated_liquid(c(p.p_amb))?.2
            };
            let runoff = y[FM] / p.runoff_tau;
            f[FEV] = y[FEV]; // unused slot: evaporation is not a coordinate
            if m.film == Film::Wet {
                rhs[FM] = feed - runoff;
                rhs[FH] = feed * p.h_tank - runoff * hf + q_film;
                f[FT] = y[FH] - y[FM] * hf;
            } else {
                // Evaporating at ambient saturation (equilibrium mode): H
                // differential, M its endpoint split, evaporation = net - M'.
                let me = feed - runoff - yp[FM];
                rhs[FH] = feed * p.h_tank - runoff * hf - me * p.h_vsat_amb + q_film;
                f[FM] = y[FH] - y[FM] * hf;
                f[FT] = y[FT] - tsat(c(p.p_amb))?;
                evap = me.v;
            }
        }
    }
    for i in 0..N {
        if is_diff(i, m) {
            f[i] = yp[i] - rhs[i];
        }
    }
    Ok(Eval { f, rhs, boil, evap })
}

// -------------------------------------------------------------- preparation
/// The prepared quiet state: CNV saturated at 25°C and 101.325 kPa, shell and
/// hosts at 25°C (zero energy), WST at 25°C at the CNV pressure, other pools
/// and the film empty, tank full, bays dry (C17's power-operation bays enter
/// through `bay_surface` and the available enclosure). Returns the state and
/// the available enclosure: prepared gas + prepared liquids (+ C17 occupancy).
fn prepare(p: &Prm) -> (Vec<f64>, f64) {
    let mut y = vec![0.; N];
    let t0 = p.t0;
    let v = p.v_gas0;
    // Vapor density first, so the prepared drive is the residual's expression.
    let rho_s = psat(c(t0)).unwrap().v / (t0 * p.rv);
    let mv = rho_s * v;
    let pv = mv * p.rv * t0 / v;
    let ma = (p.p0 - pv) * v / (p.ra * t0);
    let hv = (t0 - p.tref) * p.cpv + p.hv_ref;
    let u = ma * p.cva * (t0 - p.tref) + mv * (hv - p.rv * t0);
    y[MAIR] = ma;
    y[MW] = mv;
    y[EMIX] = u + (ma + mv) * G * p.z0;
    y[P] = p.p0;
    y[T] = t0;
    y[REM] = p.rem_cap * (p.shell_t0 - p.tref);
    for (k, h) in p.patches.iter().enumerate() {
        y[LOC0 + k] = h.capacity * (p.shell_t0 - p.tref);
    }
    let mut liquids = 0.;
    for (i, g) in p.pools.iter().enumerate() {
        if i == WST {
            let (rho, uu, _) = liquid(c(p.p0), c(p.wst_t0)).unwrap();
            let m = p.wst_water * rho.v;
            let h = g.floor + (p.wst_water + g.hw_volume) / g.area;
            let moment = g.area * (h * h - g.floor * g.floor) / 2. - g.hw_moment;
            y[pool(i, PM)] = m;
            y[pool(i, PB)] = m * p.wst_tracer;
            y[pool(i, PE)] = m * uu.v + rho.v * G * moment;
            y[pool(i, PT)] = p.wst_t0;
            y[pool(i, PV)] = p.wst_water;
            y[pool(i, PH)] = h;
            liquids += p.wst_water;
        } else {
            y[pool(i, PT)] = t0;
            y[pool(i, PH)] = g.floor;
        }
    }
    y[VMIX] = v;
    y[TANK] = p.tank_v * p.rho_tank;
    y[FT] = p.t_amb;
    (y, v + liquids)
}

// -------------------------------------------------------------------- checks
struct Case<'a> {
    p: &'a Prm,
    m: Modes,
    u: Inputs,
    v_avail: f64,
    y: Vec<f64>,
    yp: Vec<f64>,
}
fn duals(y: &[f64]) -> Vec<D> {
    y.iter().map(|&v| c(v)).collect()
}
impl Case<'_> {
    fn eval_at(&self, u: &Inputs, y: &[f64]) -> Eval {
        residual(
            self.p,
            &self.m,
            u,
            self.v_avail,
            &duals(y),
            &duals(&self.yp),
        )
        .expect("residual")
    }
    fn eval(&self) -> Eval {
        self.eval_at(&self.u, &self.y)
    }
    /// Dense Jacobians dF/dy and dF/dy' by forward-mode columns.
    fn jacobian(&self) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
        let mut jy = vec![vec![0.; N]; N];
        let mut jp = vec![vec![0.; N]; N];
        for j in 0..N {
            let mut yd = duals(&self.y);
            yd[j].d = 1.;
            let r = residual(
                self.p,
                &self.m,
                &self.u,
                self.v_avail,
                &yd,
                &duals(&self.yp),
            )
            .expect("seeded residual");
            for i in 0..N {
                jy[i][j] = r.f[i].d;
            }
            let mut ypd = duals(&self.yp);
            ypd[j].d = 1.;
            let r = residual(
                self.p,
                &self.m,
                &self.u,
                self.v_avail,
                &duals(&self.y),
                &ypd,
            )
            .expect("seeded residual");
            for i in 0..N {
                jp[i][j] = r.f[i].d;
            }
        }
        (jy, jp)
    }
}
fn col_scale(i: usize, y0: &[f64], p: &Prm) -> f64 {
    let gas = y0[MAIR] + y0[MW];
    match i {
        MAIR | MN2 | MW | MD => gas,
        EMIX => y0[EMIX].abs(),
        P => p.p0,
        T | FT => p.t0,
        VMIX => p.v_gas0,
        VT => 1.,
        DR0 | 60 => p.drain_ref_m,
        REM => p.rem_cap,
        TANK => y0[TANK],
        FM => p.film_mref,
        FH => p.film_mref * p.h_tank,
        FEV => p.feed_full,
        _ if (LOC0..POOL0).contains(&i) => p.patches[i - LOC0].capacity,
        _ => match (i - POOL0) % 7 {
            PM | PMB => y0[pool(WST, PM)],
            PE => y0[pool(WST, PE)].abs(),
            PB => y0[pool(WST, PB)],
            PT => p.t0,
            PV => p.wst_water,
            _ => 1.,
        },
    }
}
/// Row scale: the residual unit of each row at its coordinate's scale.
fn row_scale(i: usize, m: &Modes, y0: &[f64], p: &Prm) -> f64 {
    let e_wst = y0[pool(WST, PE)].abs();
    match i {
        T => y0[EMIX].abs(),
        P => p.p0 * p.v_gas0,
        MD if m.gas == Gas::E => p.p0 * p.v_gas0,
        // The weight of one drop of water: 1000 kg/m3 * pi d^3/6 * g.
        VT if m.gas == Gas::E => 1000. * std::f64::consts::PI * p.drop_d.powi(3) / 6. * G,
        // Placeholders (dry film, empty pools) and the B/evaporating T rows are temperatures.
        FT if m.film != Film::Wet => p.t0,
        FT => p.film_mref * p.h_tank,
        FM if m.film == Film::Evap => p.film_mref * p.h_tank,
        _ if (POOL0..TANK).contains(&i) => {
            let k = (i - POOL0) / 7;
            match (i - POOL0) % 7 {
                PT if m.pools[k] != Pool::L => p.t0,
                PT => e_wst,
                PH => p.pools[k].area,
                PM if m.pools[k] == Pool::B => e_wst,
                _ => col_scale(i, y0, p),
            }
        }
        _ => col_scale(i, y0, p),
    }
}
fn scaled_max(f: &[D], m: &Modes, y0: &[f64], p: &Prm) -> (f64, usize) {
    let mut worst = (0., 0);
    for (i, r) in f.iter().enumerate() {
        let s = r.v.abs() / row_scale(i, m, y0, p);
        if s > worst.0 {
            worst = (s, i);
        }
    }
    worst
}
/// Central differences on y (yp held) against the forward-mode columns, at
/// three declared steps (1e-5, 1e-3 and 1e-2 of the coordinate scale) and
/// the Richardson combination of 1e-3 and 2e-3: the smaller steps' roundoff
/// dominates where a row's magnitude dwarfs one entry's contribution (exactly
/// linear couplings such as a drain flow's enthalpy in a boiling pool's
/// boil-off), the larger steps' truncation elsewhere. An entry passes when
/// one agrees.
fn compare(k: &Case, y0: &[f64], jy: &[Vec<f64>]) -> (f64, usize, f64, String) {
    let p = k.p;
    let (mut worst, mut checked, mut floor_worst, mut at) = (0f64, 0usize, 0f64, String::new());
    let cd = |j: usize, rel: f64| -> Vec<f64> {
        let h = rel * k.y[j].abs().max(col_scale(j, y0, p));
        let (mut a, mut b) = (k.y.clone(), k.y.clone());
        a[j] += h;
        b[j] -= h;
        let fa = k.eval_at(&k.u, &a).f;
        let fb = k.eval_at(&k.u, &b).f;
        let actual = a[j] - b[j];
        (0..N).map(|i| (fa[i].v - fb[i].v) / actual).collect()
    };
    for j in 0..N {
        let (small, large, double, coarse) = (cd(j, 1e-5), cd(j, 1e-3), cd(j, 2e-3), cd(j, 1e-2));
        // Richardson on the larger step: O(h^4) truncation, little roundoff.
        let richardson: Vec<f64> = (0..N).map(|i| (4. * large[i] - double[i]) / 3.).collect();
        for i in 0..N {
            let ad = jy[i][j];
            let s = col_scale(j, y0, p) / row_scale(i, &k.m, y0, p);
            let rel = |fd: f64| (ad - fd).abs() / ad.abs().max(fd.abs());
            let big = ad.abs().max(small[i].abs()).max(large[i].abs()) * s;
            if big > 1e-8 {
                checked += 1;
                let r = rel(small[i])
                    .min(rel(large[i]))
                    .min(rel(richardson[i]))
                    .min(rel(coarse[i]));
                if r > worst {
                    worst = r;
                    at = format!(
                        "d {} / d {}: AD {ad:e}, CD {:e} / {:e} / R {:e}",
                        name(i, p),
                        name(j, p),
                        small[i],
                        large[i],
                        richardson[i]
                    );
                }
            } else {
                floor_worst = floor_worst.max((ad - small[i]).abs() * s);
            }
        }
    }
    (worst, checked, floor_worst, at)
}
/// Smallest pivot (scaled matrix, partial pivoting) of dF/dy + cj dF/dy'.
fn min_pivot(k: &Case, y0: &[f64], jy: &[Vec<f64>], jp: &[Vec<f64>], cj: f64) -> f64 {
    let mut a: Vec<Vec<f64>> = (0..N)
        .map(|i| {
            (0..N)
                .map(|j| {
                    (jy[i][j] + cj * jp[i][j]) * col_scale(j, y0, k.p) / row_scale(i, &k.m, y0, k.p)
                })
                .collect()
        })
        .collect();
    let mut smallest = f64::INFINITY;
    for col in 0..N {
        let piv = (col..N)
            .max_by(|&r, &s| a[r][col].abs().total_cmp(&a[s][col].abs()))
            .unwrap();
        a.swap(col, piv);
        let d = a[col][col];
        smallest = smallest.min(d.abs());
        if d == 0. {
            return 0.;
        }
        for r in col + 1..N {
            let factor = a[r][col] / d;
            if factor != 0. {
                for q in col..N {
                    a[r][q] -= factor * a[col][q];
                }
            }
        }
    }
    smallest
}
fn pattern(jy: &[Vec<f64>], jp: &[Vec<f64>], into: &mut [Vec<bool>]) {
    for i in 0..N {
        for j in 0..N {
            if jy[i][j] != 0. || jp[i][j] != 0. {
                into[i][j] = true;
            }
        }
    }
}

/// A probe state built explicitly from chosen primitives (no solve): warm
/// gas, cooler shell, warm WST, wet gutter, FLOOR above its drain mouth, wet
/// SUMP, wet film, a warm POOL bay at +5 m. `boiling`: SUMP (and with
/// `flooded` every pool) on the saturation line in mode B, the film
/// evaporating; `droplets`: gas mode E; `flooded`: every crest, both drains
/// and the covered lower catchment act, and every pool donor is the gas.
fn probe(p: &Prm, boiling: bool, droplets: bool, flooded: bool) -> (Modes, Inputs, Vec<f64>, f64) {
    let mut m = Modes::prepared();
    let (mut y, v_avail) = prepare(p);
    let mut u = Inputs::quiet(p);
    u.bay_surface = [p.bay_floors[0], p.bay_floors[1], 5.];
    u.bay_t = [p.t0, p.t0, 340.];
    let tg = 330.;
    let ma = y[MAIR];
    let pv_sat = psat(c(tg)).unwrap().v;
    let md = if droplets { 50. } else { 0. };
    let (v_wst, v_gut, v_flo, v_sum) = if flooded {
        (1490., 12., 1700., 1610.)
    } else {
        (p.wst_water * 1.01, 3., 120., 300.)
    };
    let vmix = v_avail - (v_wst + v_gut + v_flo + v_sum);
    let (mut vl, mut ud) = (0., 0.);
    if droplets {
        let (rho, uu, _) = liquid(c(1.3e5), c(tg)).unwrap();
        vl = md / rho.v;
        ud = uu.v;
    }
    let vgas = vmix - vl;
    let saturation = if droplets { 1. } else { 0.9 };
    let mv = saturation * pv_sat * vgas / (p.rv * tg);
    let pr = (ma * p.ra + mv * p.rv) * tg / vgas;
    let hv = (tg - p.tref) * p.cpv + p.hv_ref;
    let uu = ma * p.cva * (tg - p.tref) + mv * (hv - p.rv * tg) + md * ud;
    y[MW] = mv + md;
    y[MD] = md;
    y[EMIX] = uu + (ma + mv + md) * G * p.z0;
    y[P] = pr;
    y[T] = tg;
    y[VMIX] = vmix;
    if droplets {
        m.gas = Gas::E;
        y[VT] = 3.;
    }
    y[REM] = p.rem_cap * (300. - p.tref);
    for (k, h) in p.patches.iter().enumerate() {
        y[LOC0 + k] = h.capacity * (300. + k as f64 * 0.5 - p.tref);
    }
    m.condense = [true; 18];
    let ts = tsat(c(pr)).unwrap().v;
    let every = flooded && boiling;
    let mut set = |i: usize, vol: f64, tp: f64, b: f64, mode: Pool| {
        let g = &p.pools[i];
        let (rho, uu, _) = if mode == Pool::B {
            saturated_liquid(c(pr)).unwrap()
        } else {
            liquid(c(pr), c(tp)).unwrap()
        };
        let mass = vol * rho.v;
        let h = g.floor + (vol + g.hw_volume) / g.area;
        let moment = g.area * (h * h - g.floor * g.floor) / 2. - g.hw_moment;
        y[pool(i, PM)] = mass;
        y[pool(i, PE)] = mass * uu.v + rho.v * G * moment;
        y[pool(i, PB)] = mass * b;
        y[pool(i, PT)] = if mode == Pool::B { ts } else { tp };
        y[pool(i, PV)] = vol;
        y[pool(i, PH)] = h;

        m.pools[i] = mode;
    };
    let mode = |b: bool| if b { Pool::B } else { Pool::L };
    set(WST, v_wst, 315., p.wst_tracer, mode(every));
    set(GUTTER, v_gut, 320., 0., mode(every));
    set(FLOOR, v_flo, 325., 0., mode(every));
    set(SUMP, v_sum, 340., 0.001, mode(boiling));
    m.lower_covered = flooded;
    m.donors = if flooded {
        [Donor::Gas; 4]
    } else {
        [Donor::Pool, Donor::Gas, Donor::Pool, Donor::Pool]
    };
    m.drains_locked = false;
    y[DR0] = 10.;
    y[DR0 + 1] = 10.;
    if boiling {
        m.film = Film::Evap;
        let (_, _, hf) = saturated_liquid(c(p.p_amb)).unwrap();
        y[FM] = 8000.;
        y[FH] = 8000. * hf.v;
        y[FT] = tsat(c(p.p_amb)).unwrap().v;
    } else {
        m.film = Film::Wet;
        let tf = 313.15;
        let (_, _, hf) = liquid(c(p.p_amb), c(tf)).unwrap();
        y[FM] = 8000.;
        y[FH] = 8000. * hf.v;
        y[FT] = tf;
    }
    (m, u, y, v_avail)
}

type Change = Box<dyn Fn(&mut Inputs, &mut Vec<f64>)>;
/// A labelled change and the declared sign of each receiving row.
type Declared<'a> = (&'a str, Change, Vec<(usize, i32)>);
fn ch(f: impl Fn(&mut Inputs, &mut Vec<f64>) + 'static) -> Change {
    Box::new(f)
}
/// One declared direction: a change of inputs or state and the sign of each
/// receiving row (`rhs` for differential rows, the residual for algebraic).
fn direction(
    k: &Case,
    names: &[String],
    label: &str,
    change: &Change,
    expect: &[(usize, i32)],
) -> Value {
    let base = k.eval();
    let (mut u, mut y) = (k.u.clone(), k.y.clone());
    change(&mut u, &mut y);
    let after = k.eval_at(&u, &y);
    let mut rows = vec![];
    for &(row, sign) in expect {
        let value = |e: &Eval| {
            if is_diff(row, &k.m) {
                e.rhs[row].v
            } else {
                e.f[row].v
            }
        };
        let delta = value(&after) - value(&base);
        let ok = match sign {
            1 => delta > 0.,
            -1 => delta < 0.,
            _ => delta == 0.,
        };
        assert!(
            ok,
            "{label}: {} moved {delta:e}, declared {sign}",
            names[row]
        );
        rows.push(json!({"row": names[row], "declared": sign, "delta": delta}));
    }
    json!({"change": label, "rows": rows})
}

#[test]
fn g1_c13_containment_prototype() {
    let (p, packet) = load();
    let (y0, v_avail) = prepare(&p);
    let quiet = |m: Modes| Case {
        p: &p,
        m,
        u: Inputs::quiet(&p),
        v_avail,
        y: y0.clone(),
        yp: vec![0.; N],
    };
    let prepared = quiet(Modes::prepared());
    let names: Vec<String> = (0..N).map(|i| name(i, &p)).collect();

    // G1.2 census agrees with the compiler's.
    let d = (0..N).filter(|&i| differential(i)).count();
    assert_eq!(
        d as f64,
        num(&packet, "census.differential"),
        "differential census"
    );
    assert_eq!(
        (N - d) as f64,
        num(&packet, "census.algebraic"),
        "algebraic census"
    );

    // G1.3 (a): scaled zero-time residual at the prepared state.
    let r0 = prepared.eval();
    let (z1, worst_row) = scaled_max(&r0.f, &prepared.m, &y0, &p);
    assert!(
        z1 <= 1e-12,
        "scaled residual {z1:e} at {}",
        names[worst_row]
    );
    // Prepared root values that sit on their thresholds (every host at 25°C):
    // the condensation drive and the droplet birth, on the inactive side.
    let ps0 = psat(c(p.t0)).unwrap().v;
    let drive = y0[MW] / y0[VMIX] - ps0 / (p.t0 * p.rv);
    let birth = y0[MW] * p.rv * y0[T] / y0[VMIX] - ps0;
    assert!(
        drive <= 0. && birth <= 0.,
        "prepared roots on the active side: {drive:e}, {birth:e}"
    );

    // Empty-receiver placeholders and levels and the dry-film placeholder
    // are read by no other row.
    let (jy0, jp0) = prepared.jacobian();
    for col in [GUTTER, FLOOR, SUMP]
        .iter()
        .flat_map(|&i| [pool(i, PT), pool(i, PH)])
        .chain([FT])
    {
        for r in 0..N {
            if r != col {
                assert_eq!(jy0[r][col], 0., "{} reads {}", names[r], names[col]);
            }
        }
    }

    // G1.3 (b): directions at the prepared state.
    let mut directions = vec![];
    let mut amb = vec![(REM, 1)];
    amb.extend((0..16).map(|j| (LOC0 + j, 1)));
    let at_prepared: Vec<Declared> = vec![
        (
            "C06 release gas water +1 kg/s",
            ch(|u, _| u.break_water = 1.),
            vec![(MW, 1), (EMIX, 1)],
        ),
        (
            "C06 release water Ht +1 kJ/kg at 1 kg/s",
            ch(|u, _| {
                u.break_water = 1.;
                u.break_water_ht += 1e3
            }),
            vec![(EMIX, 1)],
        ),
        (
            "C06 release air +0.1 kg/s",
            ch(|u, _| u.break_air = 0.1),
            vec![(MAIR, 1), (EMIX, 1)],
        ),
        (
            "C11 accumulator N2 vent +0.1 kg/s",
            ch(|u, _| u.acc_n2 = 0.1),
            vec![(MN2, 1), (EMIX, 1)],
        ),
        (
            "C06 release liquid to SUMP +1 kg/s",
            ch(|u, _| {
                u.break_liquid = 1.;
                u.break_liquid_tracer = 0.002
            }),
            vec![
                (pool(SUMP, PM), 1),
                (pool(SUMP, PE), 1),
                (pool(SUMP, PB), 1),
            ],
        ),
        (
            "C11 ADS sparger water into WST +1 kg/s",
            ch(|u, _| {
                u.ads_water = 1.;
                u.ads_tracer = 0.002
            }),
            vec![(pool(WST, PM), 1), (pool(WST, PE), 1), (pool(WST, PB), 1)],
        ),
        (
            "C11 ADS sparger air to CNV +0.01 kg/s",
            ch(|u, _| u.ads_air = 0.01),
            vec![(MAIR, 1), (EMIX, 1)],
        ),
        (
            "C11 PRHR heat into WST +1 MW",
            ch(|u, _| u.prhr_q = 1e6),
            vec![(pool(WST, PE), 1)],
        ),
        (
            "C11 GIV withdrawal from WST +1 kg/s",
            ch(|u, _| u.giv = 1.),
            vec![
                (pool(WST, PM), -1),
                (pool(WST, PE), -1),
                (pool(WST, PB), -1),
            ],
        ),
        (
            "C11 RECIRC withdrawal from the empty SUMP (no donor)",
            ch(|u, _| u.recirc = 1.),
            vec![(pool(SUMP, PM), 0), (pool(SUMP, PE), 0)],
        ),
        (
            "PCC opening +0.1",
            ch(|u, _| u.pcc_a = 0.1),
            vec![(TANK, -1), (FM, 1), (FH, 1)],
        ),
        (
            "Site ambient temperature +1 K",
            ch(|u, _| u.t_amb += 1.),
            amb,
        ),
        (
            "Capture receipt +1 kW on the remainder and WELL.FLOOR",
            ch(|u, _| {
                u.capture[0] = 1e3;
                u.capture[1] = 1e3
            }),
            vec![(REM, 1), (LOC0, 1)],
        ),
        (
            "C17 bay occupancy +1 m3",
            ch(|u, _| u.bay_volume = 1.),
            vec![(VMIX, 1)],
        ),
        (
            "CNV gas temperature +0.1 K",
            ch(|_, y| y[T] += 0.1),
            vec![(REM, 1), (LOC0, 1), (EMIX, -1)],
        ),
        (
            "WST temperature +0.1 K",
            ch(|_, y| y[pool(WST, PT)] += 0.1),
            vec![(MW, 1), (pool(WST, PM), -1), (EMIX, 1)],
        ),
        (
            "Shell remainder +1 MJ",
            ch(|_, y| y[REM] += 1e6),
            vec![(REM, -1), (EMIX, 1)],
        ),
    ];
    for (label, change, expect) in &at_prepared {
        directions.push(direction(
            &prepared,
            &names,
            &format!("prepared: {label}"),
            change,
            expect,
        ));
    }
    // The births' transaction state: every catchment condensing.
    let mut births = quiet(Modes::prepared());
    births.m.condense = [true; 18];
    directions.push(direction(
        &births,
        &names,
        "births: CNV vapor +1 kg",
        &ch(|_, y| y[MW] += 1.),
        &[
            (MW, -1),
            (REM, 1),
            (LOC0, 1),
            (pool(GUTTER, PM), 1),
            (pool(FLOOR, PM), 1),
            (pool(WST, PM), 1),
        ],
    ));

    // G1.3 (c): forward-mode partials vs central differences, iteration
    // matrices, and the structural pattern over the prepared and five probes.
    let mut pat = vec![vec![false; N]; N];
    pattern(&jy0, &jp0, &mut pat);
    let mut partials = vec![];
    let mut pivots = vec![];
    let record = |k: &Case,
                  label: &str,
                  jy: &[Vec<f64>],
                  jp: &[Vec<f64>],
                  partials: &mut Vec<Value>,
                  pivots: &mut Vec<Value>| {
        let (w, n, fl, at) = compare(k, &y0, jy);
        assert!(w <= 1e-6, "{label}: AD vs CD {w:e} at {at}");
        partials.push(json!({"state": label, "checked": n, "maxRelative": w, "worst": at, "floorMaxScaled": fl,
            "pressure_Pa": k.y[P], "gasTemperature_K": k.y[T]}));
        let piv: Vec<f64> = [1e1, 1e3, 1e5]
            .iter()
            .map(|&cj| min_pivot(k, &y0, jy, jp, cj))
            .collect();
        assert!(
            piv.iter().all(|&x| x > 1e-14),
            "{label}: singular iteration matrix {piv:?}"
        );
        pivots.push(json!({"state": label, "cj": [1e1, 1e3, 1e5], "minScaledPivot": piv}));
    };
    record(
        &prepared,
        "prepared",
        &jy0,
        &jp0,
        &mut partials,
        &mut pivots,
    );
    let mut probes: Vec<Case> = vec![];
    for (label, boiling, droplets, flooded) in [
        ("probe-L-V", false, false, false),
        ("probe-B-V", true, false, false),
        ("probe-L-E", false, true, false),
        ("probe-flooded-L-V", false, false, true),
        ("probe-flooded-B-E", true, true, true),
    ] {
        let (m, u, y, va) = probe(&p, boiling, droplets, flooded);
        let mut k = Case {
            p: &p,
            m,
            u,
            v_avail: va,
            y,
            yp: vec![0.; N],
        };
        // y' from the rows' own rates, so differential rows vanish; a boiling
        // pool's M' and an evaporating film's M' are set for a boil-off of
        // 2 kg/s and an evaporation of 0.5 kg/s, then the rates again.
        let r = k.eval();
        for i in 0..4 {
            if k.m.pools[i] == Pool::B {
                k.yp[pool(i, PM)] = r.boil[i] - 2.;
            }
        }
        if k.m.film == Film::Evap {
            k.yp[FM] = r.evap - 0.5;
        }
        let r = k.eval();
        for i in 0..N {
            if is_diff(i, &k.m) {
                k.yp[i] = r.rhs[i].v;
            }
        }
        let r = k.eval();
        let (boil, evap) = (r.boil.clone(), r.evap);
        let (jy, jp) = k.jacobian();
        pattern(&jy, &jp, &mut pat);
        record(&k, label, &jy, &jp, &mut partials, &mut pivots);
        if let Some(last) = partials.last_mut() {
            last["boilOff_kg_s"] = json!(boil);
            last["filmEvaporation_kg_s"] = json!(evap);
        }
        probes.push(k);
    }

    // G1.3 (b, continued): directions at the active probe (condensation,
    // gutter returns, drains, wet film and a warm POOL bay at +5 m).
    let a = &probes[0];
    let pool_east = LOC0 + p.patches.iter().position(|h| h.id == "POOL.EAST").unwrap();
    let pool_floor = LOC0 + p.patches.iter().position(|h| h.id == "POOL.FLOOR").unwrap();
    let at_active: Vec<Declared> = vec![
        (
            "Dry-path impairment 1 → 0.5 (shell above ambient)",
            ch(|u, _| u.impairment = 0.5),
            vec![(REM, 1), (LOC0, 1)],
        ),
        (
            "Both gutter returns blocked",
            ch(|u, _| {
                u.crest_open[0] = 0.;
                u.crest_open[1] = 0.
            }),
            vec![(pool(GUTTER, PM), 1), (pool(WST, PM), -1)],
        ),
        (
            "FLOOR drain 1 half blocked (decelerates its flow)",
            ch(|u, _| u.drain_open[0] = 0.5),
            vec![(DR0, -1), (DR0 + 1, 0)],
        ),
        (
            "FLOOR surface +1 cm over the drain mouth",
            ch(|_, y| y[pool(FLOOR, PH)] += 0.01),
            vec![(DR0, 1), (DR0 + 1, 1)],
        ),
        (
            "Drain 1 flow +1 kg/s",
            ch(|_, y| y[DR0] += 1.),
            vec![(pool(FLOOR, PM), -1), (pool(SUMP, PM), 1), (DR0, -1)],
        ),
        (
            "C17 POOL surface +5 → +6 m (covers condensing wall)",
            ch(|u, _| u.bay_surface[2] = 6.),
            vec![(pool_east, -1), (MW, 1)],
        ),
        (
            "C17 POOL liquid +1 K",
            ch(|u, _| u.bay_t[2] += 1.),
            vec![(pool_floor, 1), (pool_east, 1)],
        ),
        (
            "C17 bay occupancy +1 m3",
            ch(|u, _| u.bay_volume = 1.),
            vec![(VMIX, 1)],
        ),
        (
            "C06 air +0.1 kg/s, its temperature +10 K",
            ch(|u, _| {
                u.break_air = 0.1;
                u.break_nc_t += 10.
            }),
            vec![(EMIX, 1)],
        ),
        (
            "C06 liquid Ht +1 kJ/kg at 1 kg/s",
            ch(|u, _| {
                u.break_liquid = 1.;
                u.break_liquid_ht += 1e3
            }),
            vec![(pool(SUMP, PE), 1)],
        ),
        (
            "C11 ADS Ht +1 kJ/kg at 1 kg/s",
            ch(|u, _| {
                u.ads_water = 1.;
                u.ads_ht += 1e3
            }),
            vec![(pool(WST, PE), 1)],
        ),
        (
            "C11 RECIRC withdrawal from the wet SUMP +1 kg/s",
            ch(|u, _| u.recirc = 1.),
            vec![
                (pool(SUMP, PM), -1),
                (pool(SUMP, PE), -1),
                (pool(SUMP, PB), -1),
            ],
        ),
        (
            "PCC opening +0.1 onto the wet film",
            ch(|u, _| u.pcc_a = 0.1),
            vec![(TANK, -1), (FM, 1), (FH, 1)],
        ),
        (
            "Capture receipt +1 kW on POOL.EAST",
            ch(move |u, _| u.capture[1 + pool_east - LOC0] = 1e3),
            vec![(pool_east, 1)],
        ),
    ];
    for (label, change, expect) in &at_active {
        directions.push(direction(
            a,
            &names,
            &format!("active: {label}"),
            change,
            expect,
        ));
    }
    // Equilibrium (B) mode at held rates: what enters the boiling SUMP leaves
    // as vapor into CNV through net - M'; its energy enters the pool's E.
    let boiling: Vec<Declared> = vec![(
        "boiling SUMP: liquid inflow +1 kg/s",
        ch(|u, _| u.break_liquid = 1.),
        vec![(MW, 1), (EMIX, 1)],
    )];
    for (label, change, expect) in &boiling {
        directions.push(direction(
            &probes[1],
            &names,
            &format!("B mode: {label}"),
            change,
            expect,
        ));
    }
    // With 1 kg/s already entering the boiling SUMP, a warmer stream raises
    // the pool's E (the extra mass itself leaves as vapor at held M').
    let feeding = Case {
        p: &p,
        m: probes[1].m.clone(),
        u: Inputs {
            break_liquid: 1.,
            ..probes[1].u.clone()
        },
        v_avail,
        y: probes[1].y.clone(),
        yp: probes[1].yp.clone(),
    };
    directions.push(direction(
        &feeding,
        &names,
        "B mode: boiling SUMP fed 1 kg/s, its Ht +1 kJ/kg",
        &ch(|u, _| u.break_liquid_ht += 1e3),
        &[(pool(SUMP, PE), 1)],
    ));
    directions.push(direction(
        &probes[2],
        &names,
        "droplets: M_d +1 kg settles into FLOOR",
        &ch(|_, y| {
            y[MD] += 1.;
            y[MW] += 1.
        }),
        &[(pool(FLOOR, PM), 1), (MW, -1)],
    ));

    // G1.4 cost: one residual and one dense Jacobian (forward-mode columns).
    cpu::prefer_performance_core();
    let reps = 2000;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        std::hint::black_box(prepared.eval());
    }
    let res_quiet = (cpu::thread_cpu_s() - t0) / reps as f64;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        std::hint::black_box(a.eval());
    }
    let res_active = (cpu::thread_cpu_s() - t0) / reps as f64;
    let jreps = 50;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..jreps {
        std::hint::black_box(a.jacobian());
    }
    let jac_dense = (cpu::thread_cpu_s() - t0) / jreps as f64;

    // S4-D13 drains: the iteration matrix at the active probe for drain
    // inertances two decades either side of the structural check value.
    let mut inertance = vec![];
    for value in [1e2, 1e6] {
        let q = Prm {
            drain_inertance: value,
            ..p.clone()
        };
        let k = Case {
            p: &q,
            m: a.m.clone(),
            u: a.u.clone(),
            v_avail: a.v_avail,
            y: a.y.clone(),
            yp: a.yp.clone(),
        };
        let (jy, jp) = k.jacobian();
        let piv: Vec<f64> = [1e1, 1e3, 1e5]
            .iter()
            .map(|&cj| min_pivot(&k, &y0, &jy, &jp, cj))
            .collect();
        assert!(
            piv.iter().all(|&x| x > 1e-14),
            "drain inertance {value}: singular {piv:?}"
        );
        inertance
            .push(json!({"inertance_per_m": value, "cj": [1e1, 1e3, 1e5], "minScaledPivot": piv}));
    }

    let nnz: usize = pat.iter().map(|r| r.iter().filter(|&&x| x).count()).sum();
    let receipt = json!({
        "lane": "g1-c13",
        "kind": "Gate-1 design prototype (test-only, never joined, never a gate)",
        "packetProvenance": packet["provenance"],
        "census": {"differential": d, "algebraic": N - d, "total": N, "structuralNnz": nnz},
        "compilerCensus": packet["census"],
        "zeroTime": {"scaledMax": z1, "worstRow": names[worst_row],
            "preparedRoots": {"condensationDrive_kg_m3": drive, "dropletBirth_Pa": birth},
            "initialVaporPartial_Pa": y0[MW] * p.rv * p.t0 / y0[VMIX], "initialAir_kg": y0[MAIR], "initialVapor_kg": y0[MW],
            "availableEnclosure_m3": v_avail, "wstMass_kg": y0[pool(WST, PM)], "wstSurface_m": y0[pool(WST, PH)], "hvRef_J_kg": p.hv_ref},
        "directions": directions,
        "partials": partials,
        "iterationMatrix": pivots,
        "drainInertance": {"structuralCheckValue_per_m": DRAIN_INERTANCE_CHECK_PER_M,
            "note": "not a selection: the wiki gives the drain channels no geometry (S4-D13 wiki engineering item)",
            "pivotsAtOtherValues": inertance},
        "cost": {"residualQuiet_s": res_quiet, "residualActive_s": res_active, "denseJacobian_s": jac_dense,
            "denseSweeps": 2 * N, "loadAverage": cpu::load_average()},
    });
    if let Ok(out) = std::env::var("LD01_G1_C13_RECEIPT") {
        std::fs::write(&out, serde_json::to_string_pretty(&receipt).unwrap()).expect("receipt");
    }
    println!("{}", serde_json::to_string_pretty(&receipt).unwrap());
}

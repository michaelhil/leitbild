//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/reservoir-and-containment.md#compact-operating-allocation-15-october-2026
//! G1-C13 Gate-1 design prototype: a TEST-ONLY standalone containment block
//! (the ELEC-slice pattern: own rows, dense analytic block). It is never
//! joined to the unit, never integrated and never a gate. It reads the
//! compiled containment packet (`LD01_G1_C13_PACKET`, from
//! `apps/world/scripts/reference-design-operating-containment.ts`) and checks,
//! at the prepared quiet state and at three declared probe states:
//! - the census (differential/algebraic coordinates, structural nnz);
//! - the scaled zero-time residual (≤ 1e-12);
//! - the declared direction of every port input on its receiving rows;
//! - forward-mode (IF97 exact rho/u/h directions) partials against central
//!   differences (1e-6 relative);
//! - the CPU cost of one residual and one dense Jacobian.
//!
//! Owners and coordinates (wiki allocation table): CNV gas `M_air, M_N2,
//! M_w, E_mix | p, T, V_mix, M_d`; shell remainder `U`; 16 local bay hosts
//! `U`; four open pools WST, GUTTER, FLOOR, SUMP `M, E, B | T, V, h, m_b`;
//! PCC tank `M`; exterior film `M, H | T, m_evap`. Bays (C17), PRHR (C11),
//! breaks (C06) and ROOM.B (C12) are held port inputs. Droplet settling is
//! not executable (no air/N2 viscosity law in the wiki: open item) and is
//! absent from the E-mode rows checked here.
// Test-only dense-matrix loops and fixed four-pool tables.
#![allow(
    clippy::too_many_arguments,
    clippy::needless_range_loop,
    clippy::useless_vec
)]
use leitbild_operating_water::{
    Branch, directional, point, saturated_vapor_enthalpy, saturation_pressure,
};
use serde_json::{Value, json};
use std::ops::{Add, Div, Mul, Neg, Sub};

#[path = "common/cpu.rs"]
mod cpu;

/// Standard gravity of the network and of the collection checker.
const G: f64 = 9.80665;

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
    let (q, d) = directional(Branch::Liquid, p.v, t.v, p.d, t.d)
        .map_err(|e| format!("IF97 liquid at {} Pa, {} K: {e}", p.v, t.v))?;
    Ok((
        D::new(q.density_kg_m3, d.density_kg_m3),
        D::new(q.internal_energy_j_kg, d.internal_energy_j_kg),
        D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    ))
}
/// IF97 saturated-liquid endpoint at p: density, internal energy, enthalpy.
fn saturated_liquid(p: D) -> Result<(D, D, D), String> {
    let (q, d) = directional(Branch::SaturatedLiquid, p.v, 0., p.d, 0.)
        .map_err(|e| format!("IF97 saturated liquid at {} Pa: {e}", p.v))?;
    Ok((
        D::new(q.density_kg_m3, d.density_kg_m3),
        D::new(q.internal_energy_j_kg, d.internal_energy_j_kg),
        D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    ))
}
/// IF97 saturation pressure at T (the lane's marked hook).
fn psat(t: D) -> Result<D, String> {
    let (v, d) = saturation_pressure(t.v, t.d).map_err(|e| format!("IF97 p_sat({}): {e}", t.v))?;
    Ok(D::new(v, d))
}
/// IF97 saturation temperature at p and the saturation slope dTsat/dp.
fn tsat(p: D) -> Result<(D, D), String> {
    let (q, d) = directional(Branch::SaturatedLiquid, p.v, 0., p.d, 0.)
        .map_err(|e| format!("IF97 Tsat({}): {e}", p.v))?;
    Ok((
        D::new(q.temperature_k, d.temperature_k),
        D::new(q.saturation_slope_k_pa, d.saturation_slope_k_pa),
    ))
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
    sides: Vec<usize>, // bay indices WELL=0, CANAL=1, POOL=2
    area: f64,
    z: f64,
    capacity: f64,
}
#[derive(Clone, Debug)]
struct PoolGeo {
    id: String,
    area: f64,
    floor: f64,
    hw_volume: f64,
    hw_moment: f64,
}
#[derive(Clone, Debug)]
struct Crest {
    id: String,
    from: usize,
    to: usize,
    width: f64,
    crest: f64,
}
#[derive(Clone, Debug)]
struct Prm {
    v_gas0: f64,
    v_avail: f64,
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
    // h_v_ref: the boundary's saturated-vapor enthalpy at the reference temperature.
    let tref = num(a, "referenceTemperature_K");
    let hv_ref = saturated_vapor_enthalpy(tref).expect("h_g(T_ref)");
    let bays = ["WELL", "CANAL", "POOL"];
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
                .map(|b| bays.iter().position(|x| *x == b.as_str().unwrap()).unwrap())
                .collect(),
            area: num(p, "area_m2"),
            z: num(p, "elevation_m"),
            capacity: num(p, "capacity_J_K"),
        })
        .collect::<Vec<_>>();
    assert_eq!(patches.len(), 16, "sixteen local hosts");
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
    let x = &v["exterior"];
    let (t_amb, p_amb) = (
        num(x, "ambient.temperature_K"),
        num(x, "ambient.pressure_Pa"),
    );
    let tank_t = num(x, "tank.temperature_K");
    let (rho_tank, _, h_tank) = liquid(c(p_amb), c(tank_t)).unwrap();
    let h_vsat_amb = point(Branch::SaturatedVapor, p_amb, 0.)
        .unwrap()
        .enthalpy_j_kg;
    let s = &v["shell"];
    let cat = &s["remainder"]["catchments"];
    let prm = Prm {
        v_gas0: num(a, "gasVolume_m3"),
        v_avail: num(a, "enclosure_m3") - num(a, "prhrEnvelope_m3"),
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
        rho_ref,
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
    assert_eq!(cat[0]["id"], "UPPER");
    assert_eq!(cat[1]["id"], "LOWER");
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
const N: usize = 58;
fn pool(i: usize, slot: usize) -> usize {
    POOL0 + 7 * i + slot
}
fn differential(i: usize) -> bool {
    match i {
        MAIR | MN2 | MW | EMIX | REM | TANK | FM | FH => true,
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
        REM => "SHELL.REMAINDER.U".into(),
        TANK => "PCC.TANK.M".into(),
        FM => "PCC.FILM.M".into(),
        FH => "PCC.FILM.H".into(),
        FT => "PCC.FILM.T".into(),
        FEV => "PCC.FILM.m_evap".into(),
        _ if (LOC0..POOL0).contains(&i) => format!("HOST.{}.U", p.patches[i - LOC0].id),
        _ => {
            let k = i - POOL0;
            format!(
                "{}.{}",
                p.pools[k / 7].id,
                ["M", "E", "B", "T", "V", "h", "m_b"][k % 7]
            )
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
    /// C06 release gas phase into CNV: water, air, N2 (kg/s) and their Ht.
    break_water: f64,
    break_water_ht: f64,
    break_air: f64,
    break_n2: f64,
    break_nc_t: f64,
    /// C06 release liquid into SUMP: mass, Ht, tracer mass fraction.
    break_liquid: f64,
    break_liquid_ht: f64,
    break_liquid_tracer: f64,
    /// C11 ADS1–3 sparger into WST; its NC to CNV.
    ads_water: f64,
    ads_ht: f64,
    ads_tracer: f64,
    ads_air: f64,
    /// C11 PRHR external contact heat into WST (W).
    prhr_q: f64,
    /// C11 GIV (WST) and RECIRC (SUMP) withdrawals (kg/s, positive out).
    giv: f64,
    recirc: f64,
    /// C11 accumulator N2 vent (kg/s) at its temperature.
    acc_n2: f64,
    acc_n2_t: f64,
    /// Actuator owner's PCC opening in [0,1].
    pcc_a: f64,
    /// Site: ambient temperature, dry-path impairment factor.
    t_amb: f64,
    impairment: f64,
    /// C17 bays (WELL, CANAL, POOL): covered fraction of each patch side, liquid T, liquid volume in CNV.
    cover: Vec<Vec<f64>>,
    bay_t: [f64; 3],
    bay_volume: f64,
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
            break_liquid: 0.,
            break_liquid_ht: 1.3e6,
            break_liquid_tracer: 0.,
            ads_water: 0.,
            ads_ht: 2.7e6,
            ads_tracer: 0.,
            ads_air: 0.,
            prhr_q: 0.,
            giv: 0.,
            recirc: 0.,
            acc_n2: 0.,
            acc_n2_t: p.t0,
            pcc_a: 0.,
            t_amb: p.t_amb,
            impairment: 1.,
            cover: p.patches.iter().map(|q| vec![0.; q.sides.len()]).collect(),
            bay_t: [p.t0; 3],
            bay_volume: 0.,
            crest_open: vec![1.; p.crests.len()],
            drain_open: [1., 1.],
        }
    }
}

// ------------------------------------------------------------------- residual
struct Eval {
    f: Vec<D>,
    rhs: Vec<D>,
}
/// Rows in coordinate order. Differential rows are `y' - rhs`; algebraic rows
/// are the constraints of the allocation table. `rhs` is also returned for
/// the directional checks.
fn residual(p: &Prm, m: &Modes, u: &Inputs, y: &[D], yp: &[D]) -> Result<Eval, String> {
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

    // Pool states (Empty owns no temperature and is never read).
    struct Ps {
        rho: D,
        hs: D,
    }
    let mut ps: Vec<Option<Ps>> = vec![];
    for (i, g) in p.pools.iter().enumerate() {
        let (pm, pe, pt, pv, ph, pmb) = (
            y[pool(i, PM)],
            y[pool(i, PE)],
            y[pool(i, PT)],
            y[pool(i, PV)],
            y[pool(i, PH)],
            y[pool(i, PMB)],
        );
        f[pool(i, PH)] = (ph - g.floor) * g.area - g.hw_volume - pv;
        match m.pools[i] {
            Pool::Empty => {
                f[pool(i, PT)] = pt - p.t0; // placeholder, read by no row
                f[pool(i, PV)] = pv;
                f[pool(i, PMB)] = pmb;
                ps.push(None);
            }
            Pool::L => {
                let (rho, uu, hs) = liquid(pr, pt)?;
                let moment = (ph * ph - g.floor * g.floor) * (g.area / 2.) - g.hw_moment;
                f[pool(i, PT)] = pe - (pm * uu + rho * moment * G);
                f[pool(i, PV)] = pv - pm / rho;
                f[pool(i, PMB)] = pmb;
                ps.push(Some(Ps { rho, hs }));
            }
            Pool::B => {
                // On the saturated endpoint at the CNV pressure (no metastable
                // evaluation); the manifold constraint holds the m_b slot
                // (index-2 Hessenberg: m_b enters only the M and E rows).
                let (rho, uu, hs) = saturated_liquid(pr)?;
                let (ts, _) = tsat(pr)?;
                let moment = (ph * ph - g.floor * g.floor) * (g.area / 2.) - g.hw_moment;
                f[pool(i, PT)] = pt - ts;
                f[pool(i, PV)] = pv - pm / rho;
                f[pool(i, PMB)] = pe - (pm * uu + rho * moment * G);
                let _ = pmb;
                ps.push(Some(Ps { rho, hs }));
            }
        }
    }
    let level = |i: usize| y[pool(i, PH)];
    let tracer = |i: usize| y[pool(i, PB)] / y[pool(i, PM)];

    // Transfers into owners: (mass, energy, tracer) per pool; gas sums.
    let mut pm = vec![c(0.); 4];
    let mut pen = vec![c(0.); 4];
    let mut pb = vec![c(0.); 4];
    let (mut g_air, mut g_n2, mut g_w, mut g_e) = (c(0.), c(0.), c(0.), c(0.));
    // Shell hosts: remainder and locals.
    let trem = y[REM] / p.rem_cap + p.tref;
    let mut q_rem = c(0.);
    let tloc: Vec<D> = p
        .patches
        .iter()
        .enumerate()
        .map(|(k, q)| y[LOC0 + k] / q.capacity + p.tref)
        .collect();
    let mut q_loc = vec![c(0.); 16];

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
    // Local bay hosts: gas and wet shares per side, condensation into the bay (C17 port).
    for (k, h) in p.patches.iter().enumerate() {
        let side = h.area / h.sides.len() as f64;
        for (s, &bay) in h.sides.iter().enumerate() {
            let w = u.cover[k][s];
            let q = (t - tloc[k]) * (gper * side * (1. - w));
            q_loc[k] = q_loc[k] + q;
            g_e = g_e - q;
            q_loc[k] = q_loc[k] + (c(u.bay_t[bay]) - tloc[k]) * (gper * side * w);
            if m.condense[2 + k] && w < 1. {
                let (mj, _htl, duty) = condense(tloc[k], side * (1. - w), h.z)?;
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

    // Pool surfaces ↔ gas (signed, held donor).
    for i in 0..4 {
        if ps[i].is_some() {
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
            if m.pools[i] == Pool::B {
                let mb = y[pool(i, PMB)];
                let htb = hv(ti) + level(i) * G;
                pm[i] = pm[i] - mb;
                pen[i] = pen[i] - mb * htb;
                g_w = g_w + mb;
                g_e = g_e + mb * htb;
            }
        }
    }
    // Crest paths: chutes, spills, sump rim (signed, actual donor).
    for (j, cr) in p.crests.iter().enumerate() {
        let b = u.crest_open[j];
        if b == 0. {
            continue;
        }
        // An empty owner holds no liquid: it supplies no head (its h is unread).
        let head = |i: usize| {
            if ps[i].is_some() {
                (level(i) - cr.crest).crest()
            } else {
                c(0.)
            }
        };
        let qv = (head(cr.from) - head(cr.to)) * (p.weir * cr.width * b);
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
    // FLOOR → SUMP drains (lock at equal face pressure).
    if !m.drains_locked {
        // Face pressure above the common CNV pressure, which cancels exactly.
        let face = |i: usize| -> D {
            match &ps[i] {
                Some(s) if level(i).v > p.drain_face => s.rho * (level(i) - p.drain_face) * G,
                _ => c(0.),
            }
        };
        let dp = face(FLOOR) - face(SUMP);
        if dp.v != 0. {
            let donor = if dp.v > 0. { FLOOR } else { SUMP };
            let s = ps[donor].as_ref().ok_or("drain donor without liquid")?;
            let mag = (if dp.v > 0. { dp } else { -dp }) / p.drain_ref_dp * s.rho / p.rho_ref;
            for b in u.drain_open {
                let mut mflow = mag.sqrt() * (p.drain_ref_m * b);
                if dp.v < 0. {
                    mflow = -mflow;
                }
                let ht = s.hs + level(donor) * G;
                pm[FLOOR] = pm[FLOOR] - mflow;
                pen[FLOOR] = pen[FLOOR] - mflow * ht;
                pb[FLOOR] = pb[FLOOR] - mflow * tracer(donor);
                pm[SUMP] = pm[SUMP] + mflow;
                pen[SUMP] = pen[SUMP] + mflow * ht;
                pb[SUMP] = pb[SUMP] + mflow * tracer(donor);
            }
        }
    }
    // Port inputs (C06, C11): gas phase and NC into CNV, liquids to receivers.
    let h_nc = |cv: f64, r: f64, tin: f64| cv * (tin - p.tref) + r * tin;
    g_w = g_w + u.break_water;
    g_e = g_e + u.break_water * u.break_water_ht;
    g_air = g_air + u.break_air + u.ads_air;
    g_e = g_e + (u.break_air + u.ads_air) * h_nc(p.cva, p.ra, u.break_nc_t);
    g_n2 = g_n2 + u.break_n2 + u.acc_n2;
    g_e = g_e
        + u.break_n2 * h_nc(p.cvn, p.rn, u.break_nc_t)
        + u.acc_n2 * h_nc(p.cvn, p.rn, u.acc_n2_t);
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

    // CNV rows.
    rhs[MAIR] = g_air;
    rhs[MN2] = g_n2;
    rhs[MW] = g_w;
    rhs[EMIX] = g_e - pr * yp[VMIX];
    f[T] = e - (umix + (mair + mn2 + mw) * (G * p.z0));
    f[P] = pr * vgas - (mair * p.ra + mn2 * p.rn + mv * p.rv) * t;
    let liquids = (0..4).fold(c(0.), |s, i| s + y[pool(i, PV)]);
    f[VMIX] = vmix - (c(p.v_avail - u.bay_volume) - liquids);
    f[MD] = match m.gas {
        Gas::V => md,
        Gas::E => mv * p.rv * t - psat(t)? * vgas,
    };
    // Hosts.
    rhs[REM] = q_rem;
    rhs[LOC0..POOL0].copy_from_slice(&q_loc);
    // Pools.
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
            rhs[FM] = feed - runoff - y[FEV];
            rhs[FH] = feed * p.h_tank - runoff * hf - y[FEV] * p.h_vsat_amb + q_film;
            if m.film == Film::Wet {
                f[FT] = y[FH] - y[FM] * hf;
                f[FEV] = y[FEV];
            } else {
                // Evaporating at ambient saturation: T on the endpoint, the
                // manifold constraint in the m_evap slot (index-2 Hessenberg).
                f[FT] = y[FT] - tsat(c(p.p_amb))?.0;
                f[FEV] = y[FH] - y[FM] * hf;
            }
        }
    }
    for i in 0..N {
        if differential(i) {
            f[i] = yp[i] - rhs[i];
        }
    }
    Ok(Eval { f, rhs })
}

// -------------------------------------------------------------- preparation
/// The prepared quiet state: CNV saturated at 25°C and 101.325 kPa, shell and
/// hosts at 25°C (zero energy), WST at 25°C at the CNV pressure, other pools
/// and the film empty, tank full.
fn prepare(p: &Prm) -> Vec<f64> {
    let mut y = vec![0.; N];
    let t0 = p.t0;
    let pv = psat(c(t0)).unwrap().v;
    let v = p.v_gas0;
    let mv = pv * v / (p.rv * t0);
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
        } else {
            y[pool(i, PT)] = t0;
            y[pool(i, PH)] = g.floor;
        }
    }
    y[VMIX] = p.v_avail - p.wst_water;
    y[TANK] = p.tank_v * p.rho_tank;
    y[FT] = p.t_amb;
    y
}

// -------------------------------------------------------------------- checks
fn duals(y: &[f64]) -> Vec<D> {
    y.iter().map(|&v| c(v)).collect()
}
fn eval(p: &Prm, m: &Modes, u: &Inputs, y: &[f64], yp: &[f64]) -> Eval {
    residual(p, m, u, &duals(y), &duals(yp)).expect("residual")
}
fn col_scale(i: usize, y0: &[f64], p: &Prm) -> f64 {
    let gas = y0[MAIR] + y0[MW];
    match i {
        MAIR | MN2 | MW | MD => gas,
        EMIX => y0[EMIX].abs(),
        P => p.p0,
        T | FT => p.t0,
        VMIX => p.v_gas0,
        REM => p.rem_cap,
        TANK => y0[TANK],
        FM => p.film_mref,
        FH => p.film_mref * p.h_tank,
        FEV => p.feed_full,
        _ if (LOC0..POOL0).contains(&i) => p.patches[i - LOC0].capacity,
        _ => {
            let (k, s) = ((i - POOL0) / 7, (i - POOL0) % 7);
            let mw = y0[pool(WST, PM)];
            match s {
                PM => mw,
                PE => y0[pool(WST, PE)].abs(),
                PB => y0[pool(WST, PB)],
                PT => p.t0,
                PV => p.wst_water,
                PH => 1.,
                _ => {
                    let _ = k;
                    mw
                }
            }
        }
    }
}
/// Row scale: the residual unit of each row at its coordinate's scale.
fn row_scale(i: usize, m: &Modes, y0: &[f64], p: &Prm) -> f64 {
    match i {
        T => y0[EMIX].abs(),
        P => p.p0 * p.v_gas0,
        MD if m.gas == Gas::E => p.p0 * p.v_gas0,
        FT if m.film == Film::Evap => p.t0,
        FT => p.film_mref * p.h_tank,
        FEV if m.film == Film::Evap => p.film_mref * p.h_tank,
        _ if (POOL0..TANK).contains(&i) => {
            let s = (i - POOL0) % 7;
            match s {
                PT if m.pools[(i - POOL0) / 7] == Pool::B => p.t0,
                PT => y0[pool(WST, PE)].abs(),
                PH => p.pools[(i - POOL0) / 7].area,
                PMB if m.pools[(i - POOL0) / 7] == Pool::B => y0[pool(WST, PE)].abs(),
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
/// Dense Jacobians dF/dy and dF/dy' by forward-mode columns.
fn jacobian(
    p: &Prm,
    m: &Modes,
    u: &Inputs,
    y: &[f64],
    yp: &[f64],
) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let mut jy = vec![vec![0.; N]; N];
    let mut jp = vec![vec![0.; N]; N];
    for j in 0..N {
        let mut yd = duals(y);
        yd[j].d = 1.;
        let r = residual(p, m, u, &yd, &duals(yp)).expect("seeded residual");
        for i in 0..N {
            jy[i][j] = r.f[i].d;
        }
        let mut ypd = duals(yp);
        ypd[j].d = 1.;
        let r = residual(p, m, u, &duals(y), &ypd).expect("seeded residual");
        for i in 0..N {
            jp[i][j] = r.f[i].d;
        }
    }
    (jy, jp)
}
/// Central differences on y (yp held) against the forward-mode columns, at
/// two declared steps (1e-5 and 1e-3 of the coordinate scale): the smaller
/// step's roundoff dominates where a row's magnitude dwarfs one entry's
/// contribution (energy rows of ~1e9 J against a droplet term), the larger
/// step's truncation elsewhere. An entry passes when either step agrees.
fn compare(
    p: &Prm,
    m: &Modes,
    u: &Inputs,
    y: &[f64],
    yp: &[f64],
    y0: &[f64],
    jy: &[Vec<f64>],
) -> (f64, usize, f64, String) {
    let (mut worst, mut checked, mut floor_worst, mut at) = (0f64, 0usize, 0f64, String::new());
    let cd = |j: usize, rel: f64| -> Vec<f64> {
        let h = rel * y[j].abs().max(col_scale(j, y0, p));
        let (mut a, mut b) = (y.to_vec(), y.to_vec());
        a[j] += h;
        b[j] -= h;
        let fa = eval(p, m, u, &a, yp).f;
        let fb = eval(p, m, u, &b, yp).f;
        let actual = a[j] - b[j];
        (0..N).map(|i| (fa[i].v - fb[i].v) / actual).collect()
    };
    for j in 0..N {
        let (small, large) = (cd(j, 1e-5), cd(j, 1e-3));
        for i in 0..N {
            let ad = jy[i][j];
            let s = col_scale(j, y0, p) / row_scale(i, m, y0, p);
            let rel = |fd: f64| (ad - fd).abs() / ad.abs().max(fd.abs());
            let big = ad.abs().max(small[i].abs()).max(large[i].abs()) * s;
            if big > 1e-8 {
                checked += 1;
                let (r1, r2) = (rel(small[i]), rel(large[i]));
                let r = r1.min(r2);
                if r > worst {
                    worst = r;
                    at = format!(
                        "d {} / d {}: AD {ad:e}, CD {:e} / {:e}",
                        name(i, p),
                        name(j, p),
                        small[i],
                        large[i]
                    );
                }
            } else {
                floor_worst = floor_worst.max((ad - small[i]).abs() * s);
            }
        }
    }
    (worst, checked, floor_worst, at)
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
/// unsaturated gas, cooler shell, warm WST, wet gutter, FLOOR above its drain
/// mouth, wet SUMP, wet film. With `boiling`, SUMP sits on the saturation
/// line at the CNV pressure in mode B.
fn probe(p: &Prm, boiling: bool, droplets: bool, flooded: bool) -> (Modes, Vec<f64>) {
    let mut m = Modes::prepared();
    let mut y = prepare(p);
    let tg = 330.;
    let ma = y[MAIR];
    // Water in the gas: 0.9 of saturation (mode V) or saturated plus droplets (mode E).
    let pv_sat = psat(c(tg)).unwrap().v;
    let md = if droplets { 50. } else { 0. };
    let (mut vl, mut ud) = (0., 0.);
    // Liquid volumes chosen first; V_mix follows.
    // Flooded: every crest, both drains and the covered lower catchment act.
    let (v_wst, v_gut, v_flo, v_sum) = if flooded {
        (1490., 12., 1700., 1610.)
    } else {
        (p.wst_water * 1.01, 3., 120., 300.)
    };
    let pool_set: [(usize, f64, f64); 3] = [
        (GUTTER, v_gut, 320.),
        (FLOOR, v_flo, 325.),
        (SUMP, v_sum, 340.),
    ];
    let mut liquids = v_wst;
    for (_, v, _) in pool_set {
        liquids += v;
    }
    let vmix = p.v_avail - liquids;
    // Total pressure from a first guess is only needed for the droplet density;
    // use the prepared pressure for the droplet state, then the EOS pressure
    // (the probe is a derivative point, not a consistent equilibrium).
    let pr_guess = 1.3e5;
    if droplets {
        let (rho, u, _) = liquid(c(pr_guess), c(tg)).unwrap();
        vl = md / rho.v;
        ud = u.v;
    }
    let vgas = vmix - vl;
    let mv = if droplets {
        pv_sat * vgas / (p.rv * tg)
    } else {
        0.9 * pv_sat * vgas / (p.rv * tg)
    };
    let pr = (ma * p.ra + mv * p.rv) * tg / vgas;
    let hv = (tg - p.tref) * p.cpv + p.hv_ref;
    let u = ma * p.cva * (tg - p.tref) + mv * (hv - p.rv * tg) + md * ud;
    y[MW] = mv + md;
    y[MD] = md;
    y[EMIX] = u + (ma + mv + md) * G * p.z0;
    y[P] = pr;
    y[T] = tg;
    y[VMIX] = vmix;
    if droplets {
        m.gas = Gas::E;
    }
    // Shell 300 K, hosts 300–310 K: below the dew point, condensing.
    y[REM] = p.rem_cap * (300. - p.tref);
    for (k, h) in p.patches.iter().enumerate() {
        y[LOC0 + k] = h.capacity * (300. + k as f64 * 0.5 - p.tref);
    }
    m.condense = [true; 18];
    // Pools.
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
        y[pool(i, PT)] = tp;
        y[pool(i, PV)] = vol;
        y[pool(i, PH)] = h;
        m.pools[i] = mode;
    };
    let ts = tsat(c(pr)).unwrap().0.v;
    let every = flooded && boiling;
    let mode = |b: bool| if b { Pool::B } else { Pool::L };
    let temp = |b: bool, t: f64| if b { ts } else { t };
    set(WST, v_wst, temp(every, 315.), p.wst_tracer, mode(every));
    set(GUTTER, v_gut, temp(every, 320.), 0., mode(every));
    set(FLOOR, v_flo, temp(every, 325.), 0., mode(every));
    set(SUMP, v_sum, temp(boiling, 340.), 0.001, mode(boiling));
    for i in 0..4 {
        if m.pools[i] == Pool::B {
            y[pool(i, PMB)] = 2.;
        }
    }
    m.lower_covered = flooded;
    m.donors = [Donor::Pool, Donor::Gas, Donor::Pool, Donor::Pool];
    m.drains_locked = false;
    // Film: wet below the full-wet mass at 40°C, or evaporating at ambient saturation.
    if boiling {
        m.film = Film::Evap;
        let (_, _, hf) = saturated_liquid(c(p.p_amb)).unwrap();
        y[FM] = 8000.;
        y[FH] = 8000. * hf.v;
        y[FT] = tsat(c(p.p_amb)).unwrap().0.v;
        y[FEV] = 0.5;
    } else {
        m.film = Film::Wet;
        let tf = 313.15;
        let (_, _, hf) = liquid(c(p.p_amb), c(tf)).unwrap();
        y[FM] = 8000.;
        y[FH] = 8000. * hf.v;
        y[FT] = tf;
    }
    (m, y)
}

fn census(pat: &[Vec<bool>]) -> Value {
    let d = (0..N).filter(|&i| differential(i)).count();
    let nnz: usize = pat.iter().map(|r| r.iter().filter(|&&x| x).count()).sum();
    json!({"differential": d, "algebraic": N - d, "total": N, "structuralNnz": nnz})
}

#[test]
fn g1_c13_containment_prototype() {
    let (p, packet) = load();
    let quiet = Inputs::quiet(&p);
    let m0 = Modes::prepared();
    let y0 = prepare(&p);
    let yp0 = vec![0.; N];
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
    let r0 = eval(&p, &m0, &quiet, &y0, &yp0);
    let (z1, worst_row) = scaled_max(&r0.f, &m0, &y0, &p);
    assert!(
        z1 <= 1e-12,
        "scaled residual {z1:e} at {}",
        names[worst_row]
    );
    // Initial dry air and vapor from P, T, V; WST level from water and displacement.
    let pv = psat(c(p.t0)).unwrap().v;

    // Empty-receiver placeholders are read by no row: their columns are zero
    // except their own placeholder row.
    let (jy0, jp0) = jacobian(&p, &m0, &quiet, &y0, &yp0);
    for i in [GUTTER, FLOOR, SUMP] {
        let col = pool(i, PT);
        for r in 0..N {
            if r != col {
                assert_eq!(
                    jy0[r][col], 0.,
                    "{} reads the empty placeholder {}",
                    names[r], names[col]
                );
            }
        }
    }
    for i in [GUTTER, FLOOR, SUMP] {
        let col = pool(i, PH);
        for r in 0..N {
            if r != col {
                assert_eq!(
                    jy0[r][col], 0.,
                    "{} reads the empty level {}",
                    names[r], names[col]
                );
            }
        }
    }
    for r in 0..N {
        if r != FT {
            assert_eq!(
                jy0[r][FT], 0.,
                "{} reads the dry film placeholder",
                names[r]
            );
        }
    }

    // G1.3 (b): directions of every port input at the prepared state (rhs).
    let mut directions = vec![];
    let mut check =
        |label: &str, change: &dyn Fn(&mut Inputs), modes: &Modes, expect: &[(usize, i32)]| {
            let mut u = Inputs::quiet(&p);
            let before = eval(&p, modes, &u, &y0, &yp0).rhs;
            change(&mut u);
            let after = eval(&p, modes, &u, &y0, &yp0).rhs;
            let mut rows = vec![];
            for &(row, sign) in expect {
                let delta = after[row].v - before[row].v;
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
            directions.push(json!({"input": label, "rows": rows}));
        };
    check(
        "C06 release gas water +1 kg/s",
        &|u| u.break_water = 1.,
        &m0,
        &[(MW, 1), (EMIX, 1)],
    );
    check(
        "C06 release water Ht +1 kJ/kg at 1 kg/s",
        &|u| {
            u.break_water = 1.;
            u.break_water_ht += 1e3
        },
        &m0,
        &[(EMIX, 1)],
    );
    check(
        "C06 release air +0.1 kg/s",
        &|u| u.break_air = 0.1,
        &m0,
        &[(MAIR, 1), (EMIX, 1)],
    );
    check(
        "C11 accumulator N2 vent +0.1 kg/s",
        &|u| u.acc_n2 = 0.1,
        &m0,
        &[(MN2, 1), (EMIX, 1)],
    );
    check(
        "C06 release liquid to SUMP +1 kg/s",
        &|u| {
            u.break_liquid = 1.;
            u.break_liquid_tracer = 0.002
        },
        &m0,
        &[
            (pool(SUMP, PM), 1),
            (pool(SUMP, PE), 1),
            (pool(SUMP, PB), 1),
        ],
    );
    check(
        "C11 ADS sparger water into WST +1 kg/s",
        &|u| {
            u.ads_water = 1.;
            u.ads_tracer = 0.002
        },
        &m0,
        &[(pool(WST, PM), 1), (pool(WST, PE), 1), (pool(WST, PB), 1)],
    );
    check(
        "C11 ADS sparger air to CNV +0.01 kg/s",
        &|u| u.ads_air = 0.01,
        &m0,
        &[(MAIR, 1), (EMIX, 1)],
    );
    check(
        "C11 PRHR heat into WST +1 MW",
        &|u| u.prhr_q = 1e6,
        &m0,
        &[(pool(WST, PE), 1)],
    );
    check(
        "C11 GIV withdrawal from WST +1 kg/s",
        &|u| u.giv = 1.,
        &m0,
        &[
            (pool(WST, PM), -1),
            (pool(WST, PE), -1),
            (pool(WST, PB), -1),
        ],
    );
    check(
        "C11 RECIRC withdrawal from the empty SUMP (no donor)",
        &|u| u.recirc = 1.,
        &m0,
        &[(pool(SUMP, PM), 0), (pool(SUMP, PE), 0)],
    );
    check(
        "PCC opening +0.1",
        &|u| u.pcc_a = 0.1,
        &m0,
        &[(TANK, -1), (FM, 1), (FH, 1)],
    );
    let mut amb_rows = vec![(REM, 1)];
    amb_rows.extend((0..16).map(|k| (LOC0 + k, 1)));
    check(
        "Site ambient temperature +1 K",
        &|u| u.t_amb += 1.,
        &m0,
        &amb_rows,
    );
    check(
        "Site dry-path impairment 1 → 0.5 at equal temperatures",
        &|u| u.impairment = 0.5,
        &m0,
        &[(REM, 0)],
    );
    check(
        "Gutter returns blocked while the gutter is dry",
        &|u| {
            u.crest_open[0] = 0.;
            u.crest_open[1] = 0.
        },
        &m0,
        &[(pool(WST, PM), 0), (pool(GUTTER, PM), 0)],
    );
    check(
        "C17 bay coverage +0.5 at equal temperatures",
        &|u| u.cover[0][0] = 0.5,
        &m0,
        &[(LOC0, 0)],
    );
    // Internal couplings after the condensation births (all catchments active).
    let mut mc = m0.clone();
    mc.condense = [true; 18];
    let mut state_check =
        |label: &str, j: usize, dy: f64, modes: &Modes, expect: &[(usize, i32)]| {
            let before = eval(&p, modes, &quiet, &y0, &yp0).rhs;
            let mut y = y0.clone();
            y[j] += dy;
            let after = eval(&p, modes, &quiet, &y, &yp0).rhs;
            let mut rows = vec![];
            for &(row, sign) in expect {
                let delta = after[row].v - before[row].v;
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
            directions.push(json!({"state": label, "rows": rows}));
        };
    state_check(
        "CNV vapor +1 kg (condensation active)",
        MW,
        1.,
        &mc,
        &[
            (MW, -1),
            (REM, 1),
            (LOC0, 1),
            (pool(GUTTER, PM), 1),
            (pool(FLOOR, PM), 1),
            (pool(WST, PM), 1),
        ],
    );
    state_check(
        "CNV gas temperature +0.1 K",
        T,
        0.1,
        &m0,
        &[(REM, 1), (LOC0, 1), (EMIX, -1)],
    );
    state_check(
        "WST temperature +0.1 K",
        pool(WST, PT),
        0.1,
        &m0,
        &[(MW, 1), (pool(WST, PM), -1), (EMIX, 1)],
    );
    state_check(
        "Shell remainder +1 MJ",
        REM,
        1e6,
        &m0,
        &[(REM, -1), (EMIX, 1)],
    );

    // G1.3 (c): forward-mode partials vs central differences, four states.
    let mut pat = vec![vec![false; N]; N];
    pattern(&jy0, &jp0, &mut pat);
    let mut partials = vec![];
    let (w, n, fl, at) = compare(&p, &m0, &quiet, &y0, &yp0, &y0, &jy0);
    assert!(w <= 1e-6, "prepared: AD vs CD {w:e} at {at}");
    partials.push(json!({"state": "prepared", "checked": n, "maxRelative": w, "worst": at, "floorMaxScaled": fl}));
    let mut probes = vec![];
    for (label, boiling, droplets, flooded) in [
        ("probe-L-V", false, false, false),
        ("probe-B-V", true, false, false),
        ("probe-L-E", false, true, false),
        ("probe-flooded-L-V", false, false, true),
        ("probe-flooded-B-E", true, true, true),
    ] {
        let (m, y) = probe(&p, boiling, droplets, flooded);
        // y' from the rows' own rates: differential rows then vanish.
        let r = eval(&p, &m, &quiet, &y, &yp0);
        let mut yp = vec![0.; N];
        for i in 0..N {
            if differential(i) {
                yp[i] = r.rhs[i].v;
            }
        }
        let (jy, jp) = jacobian(&p, &m, &quiet, &y, &yp);
        pattern(&jy, &jp, &mut pat);
        let (w, n, fl, at) = compare(&p, &m, &quiet, &y, &yp, &y0, &jy);
        assert!(w <= 1e-6, "{label}: AD vs CD {w:e} at {at}");
        partials.push(json!({"state": label, "checked": n, "maxRelative": w, "worst": at, "floorMaxScaled": fl,
            "pressure_Pa": y[P], "gasTemperature_K": y[T]}));
        probes.push((m, y, yp));
    }

    // G1.4 cost: one residual and one dense Jacobian (forward-mode columns).
    cpu::prefer_performance_core();
    let reps = 2000;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        std::hint::black_box(eval(&p, &m0, &quiet, &y0, &yp0));
    }
    let res_quiet = (cpu::thread_cpu_s() - t0) / reps as f64;
    let (ma, ya, ypa) = &probes[0];
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        std::hint::black_box(eval(&p, ma, &quiet, ya, ypa));
    }
    let res_active = (cpu::thread_cpu_s() - t0) / reps as f64;
    let jreps = 50;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..jreps {
        std::hint::black_box(jacobian(&p, ma, &quiet, ya, ypa));
    }
    let jac_dense = (cpu::thread_cpu_s() - t0) / jreps as f64;

    let census = census(&pat);
    let receipt = json!({
        "lane": "g1-c13",
        "kind": "Gate-1 design prototype (test-only, never joined, never a gate)",
        "packetProvenance": packet["provenance"],
        "census": census,
        "compilerCensus": packet["census"],
        "zeroTime": {"scaledMax": z1, "worstRow": names[worst_row],
            "initialVaporPartial_Pa": pv, "initialAir_kg": y0[MAIR], "initialVapor_kg": y0[MW],
            "wstMass_kg": y0[pool(WST, PM)], "wstSurface_m": y0[pool(WST, PH)], "hvRef_J_kg": p.hv_ref},
        "directions": directions,
        "partials": partials,
        "cost": {"residualQuiet_s": res_quiet, "residualActive_s": res_active, "denseJacobian_s": jac_dense,
            "loadAverage": cpu::load_average()},
    });
    if let Ok(out) = std::env::var("LD01_G1_C13_RECEIPT") {
        std::fs::write(&out, serde_json::to_string_pretty(&receipt).unwrap()).expect("receipt");
    }
    println!("{}", serde_json::to_string_pretty(&receipt).unwrap());
}

//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/injection-and-depressurization.md#compact-operating-allocation-15-october-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/cmt-receiving-geometry.md#liquid-aperture-viscous-and-inertial-continuation
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/cmt-transport.md#two-face-stationary-constriction
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/injection-and-depressurization.md#accumulator-gas-and-water-energy
//! G1-C11 Gate-1 design prototype for the injection sources: a TEST-ONLY
//! standalone block (the ELEC-slice pattern: own rows, dense forward-mode
//! partials). It is never joined to the unit, never integrated and never a
//! gate. It reads the compiled passive packet (`LD01_G1_C11_PACKET`, from
//! `apps/world/scripts/reference-design-operating-passive.ts`) and checks,
//! at the prepared state and at three declared probe states:
//! - the census and the structural nnz;
//! - the scaled zero-time residual (≤ 1e-12);
//! - that the allocation reproduces the owners' cited sizing losses;
//! - the declared direction of every port input on its receiving rows;
//! - forward-mode partials (IF97 exact rho/u/h directions) against central
//!   differences (1e-6 relative), one-sided at an upwind donor kink;
//! - the iteration matrix `dF/dy + cj dF/dy'` nonsingular for cj 1e1..1e5;
//! - the CPU cost of one residual and one dense Jacobian.
//!
//! Owners (allocation table, decisions C11-D1..D7), per train A/B: CMT
//! layers L1..L6, BAL cells RUN/RISER.1/RISER.2/DIST and the outlet cell
//! OUT as S3 regular cells (`p | M_l, U_l, M_g, U_g, B`), DVI with its neck
//! water (+ `M_air, M_N2`); S3 phase paths (`Π_l, Π_g`) between layers,
//! along the BAL (tap→RUN carries the isolation), tank→OUT (isolations),
//! OUT→DVI (meter, check body, discharge, check) and DVI→DOWNCOMER (neck);
//! three hole rings (thin-screen law, algebraic); the ACC two stores
//! (`M_l, E_l, B, M_N2, M_air, M_v, E_g | p_I, z_I, T_l, T_g`) with outlet
//! and vent; the GIV and RECIRC retained columns (`M_w, M_air, M_N2, E, B |
//! p_c, T_c`) with source and terminal devices. Unit-wide: the six ADS 1–3
//! chambers (`M_w, M_air, M_N2, E, B | p, T`), their twelve devices and the
//! two ADS 4 devices. C06 ports (COLD tap, DOWNCOMER, PZR roof), C13 ports
//! (WST/SUMP surfaces, pool temperature, CNV pressure) and every valve stem
//! are held inputs. Gas and two-phase device flow (C06's discharge law) and
//! the E/G phase modes are declared, not evaluated here.
// Test-only dense-matrix loops and fixed owner tables.
#![cfg(any(target_os = "macos", target_os = "linux"))]
#![allow(
    clippy::too_many_arguments,
    clippy::needless_range_loop,
    clippy::type_complexity
)]
use leitbild_operating_water::{Branch, directional, point_ph, point_pu, saturation_caloric};
use serde_json::{Value, json};
use std::ops::{Add, Div, Mul, Neg, Sub};

mod common;
use common::cpu;

/// Standard gravity of the network and of the passive owners' checkers.
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
    fn abs(self) -> Self {
        if self.v < 0. { -self } else { self }
    }
    fn ln(self) -> Self {
        Self::new(self.v.ln(), self.d / self.v)
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
/// IF97 state of one branch at (p, T): density, internal energy, enthalpy,
/// viscosity (exact rho/u/h directions; the boundary's disclosed
/// coefficient probe for viscosity).
#[derive(Clone, Copy)]
struct St {
    rho: D,
    u: D,
    h: D,
    mu: D,
    t: D,
}
fn state(branch: Branch, p: D, t: D) -> Result<St, String> {
    let (q, d) = directional(branch, p.v, t.v, p.d, t.d)
        .map_err(|e| format!("IF97 {branch:?} at {} Pa, {} K: {e}", p.v, t.v))?;
    Ok(St {
        rho: D::new(q.density_kg_m3, d.density_kg_m3),
        u: D::new(q.internal_energy_j_kg, d.internal_energy_j_kg),
        h: D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
        mu: D::new(
            q.viscosity_pa_s,
            viscosity_direction(branch, p, t, d.viscosity_pa_s),
        ),
        t,
    })
}
/// The viscosity tangent along the seed by a central difference of the
/// boundary's own viscosity values (steps ≤ 1 kPa and ≤ 0.01 K). The
/// boundary's coefficient probe agrees only to about 1e-5 relative, which
/// is a property of the probe, not of a C11 law; the prototype's partials
/// therefore use this tangent (test-only, as G1-C13 did for vapor viscosity).
fn viscosity_direction(branch: Branch, p: D, t: D, _probe: f64) -> f64 {
    if p.d == 0. && t.d == 0. {
        return 0.;
    }
    let s = 1. / (p.d.abs() / 1e3).max(t.d.abs() / 1e-2);
    let mu = |k: f64| {
        leitbild_operating_water::point(branch, p.v + k * s * p.d, t.v + k * s * t.d)
            .map(|q| q.viscosity_pa_s)
            .unwrap_or(f64::NAN)
    };
    (mu(1.) - mu(-1.)) / (2. * s)
}
/// Temperature at (p, u) on a branch with its exact direction: the boundary's
/// own inverse for the value, the (p, T) directions for the tangent.
fn temperature_pu(branch: Branch, p: D, u: D) -> Result<D, String> {
    let q = point_pu(branch, p.v, u.v).map_err(|e| format!("IF97 (p,u) {} {}: {e}", p.v, u.v))?;
    let t = q.temperature_k;
    let (_, dp) = directional(branch, p.v, t, 1., 0.).map_err(|e| e.to_string())?;
    let (_, dt) = directional(branch, p.v, t, 0., 1.).map_err(|e| e.to_string())?;
    Ok(D::new(
        t,
        (u.d - dp.internal_energy_j_kg * p.d) / dt.internal_energy_j_kg,
    ))
}
fn temperature_ph(branch: Branch, p: f64, h: f64) -> f64 {
    point_ph(branch, p, h).expect("IF97 (p,h)").temperature_k
}

// ------------------------------------------------------------------ the packet
fn num(v: &Value, path: &str) -> f64 {
    v.pointer(path)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("packet field {path}"))
}
fn arr<'a>(v: &'a Value, path: &str) -> &'a Vec<Value> {
    v.pointer(path)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("packet array {path}"))
}

/// Darcy friction, smooth or rough: 64/Re through 2300, Colebrook from 4000,
/// linear in Re between (the owners' selected transition). Returns the
/// pressure loss for mass flow m through length L of bore D, area A.
fn darcy_loss(m: D, rho: D, mu: D, length: f64, d: f64, area: f64, roughness: f64) -> D {
    if m.v == 0. {
        // Analytic laminar limit: 32 mu L u / D^2 with u = m/(rho A).
        return mu * m * (32. * length / (area * d * d)) / rho;
    }
    let re = m.abs() * (d / area) / mu;
    let laminar = |re: D| c(64.) / re;
    let colebrook = |re: D| -> D {
        // x = 1/sqrt(f): x + 2 log10(rr/3.7 + 2.51 x / Re) = 0; value by
        // fixed point, tangent by the implicit function theorem.
        let rr = roughness / d;
        // Colebrook's fixed point is a contraction; 60 passes reach its double
        // value from x = 8 (a scalar constitutive evaluation, test-only).
        let mut x = 8f64;
        for _ in 0..60 {
            x = -2. * (rr / 3.7 + 2.51 * x / re.v).log10();
        }
        let a = rr / 3.7 + 2.51 * x / re.v;
        let k = 2. / std::f64::consts::LN_10 / a;
        let f_re = k * (-2.51 * x / (re.v * re.v));
        let f_x = 1. + k * 2.51 / re.v;
        let dx = -f_re / f_x * re.d;
        let xd = D::new(x, dx);
        c(1.) / (xd * xd)
    };
    let f = if re.v <= 2300. {
        laminar(re)
    } else if re.v >= 4000. {
        colebrook(re)
    } else {
        let (f0, f1) = (64. / 2300., colebrook(c(4000.)).v);
        c(f0) + (re - 2300.) * ((f1 - f0) / 1700.)
    };
    f * m * m.abs() * (length / (2. * d * area * area)) / rho
}
/// K velocity heads at bore area A.
fn heads(k: f64, m: D, rho: D, area: f64) -> D {
    m * m.abs() * (k / (2. * area * area)) / rho
}
/// Velocity heads of a stationary constriction of effective area a in bore A
/// (liquid limit of the two-face law).
fn k_of(a: f64, area: f64) -> f64 {
    (area / a).powi(2) - 1.
}

#[derive(Clone, Debug)]
struct Layer {
    v: f64,
    z: f64,
}
#[derive(Clone, Debug)]
struct Path {
    from: usize,
    to: usize,
    junction: f64,
    inertance: f64,
    area: f64,
    bore: f64,
    roughness: f64,
    pipe: f64,
    k: f64,
    k_variable: f64,
    preload: f64,
}
const TAP: usize = usize::MAX - 1;
const DC: usize = usize::MAX - 2;

struct Prm {
    layers: Vec<Layer>,
    bal: Vec<Layer>,
    out: Layer,
    dvi: Layer,
    paths: Vec<Path>,
    rings: Vec<(f64, f64)>,
    hole: f64,
    cd: f64,
    cmt_t: f64,
    tracer: f64,
    acc: Value,
    columns: Vec<Value>,
    gravity: Value,
    chamber_v: f64,
    chamber_z: f64,
    cold_p: f64,
    cold_h: f64,
    roof_p: f64,
    cold_density: f64,
    packet: Value,
}
// Cell order within a train.
const NCELL: usize = 12; // L1..L6, RUN, R1, R2, DIST, OUT, DVI
const RUN: usize = 6;
const DIST: usize = 9;
const OUT: usize = 10;
const DVI: usize = 11;

fn load() -> (Prm, Value) {
    let path = std::env::var("LD01_G1_C11_PACKET").expect(
        "LD01_G1_C11_PACKET: the passive packet from reference-design-operating-passive.ts",
    );
    let text = std::fs::read_to_string(&path).expect("packet");
    let p: Value = serde_json::from_str(&text).expect("packet json");
    let layers: Vec<Layer> = arr(&p, "/cmt/layers")
        .iter()
        .map(|l| Layer {
            v: num(l, "/volume_m3"),
            z: num(l, "/centroid_m"),
        })
        .collect();
    assert_eq!(layers.len(), 6, "six CMT layers (C11-D1)");
    let bal: Vec<Layer> = arr(&p, "/cmt/balance/cells")
        .iter()
        .map(|l| Layer {
            v: num(l, "/volume_m3"),
            z: num(l, "/centroid_m"),
        })
        .collect();
    let out = Layer {
        v: num(&p, "/cmt/outlet/cell/volume_m3"),
        z: num(&p, "/cmt/outlet/cell/centroid_m"),
    };
    let dvi = Layer {
        v: num(&p, "/dvi/volume_m3"),
        z: num(&p, "/dvi/elevation_m"),
    };
    let bore = num(&p, "/cmt/balance/bore_m");
    let area = std::f64::consts::PI * bore * bore / 4.;
    let rough = num(&p, "/cmt/balance/roughness_m");
    let mut paths = Vec::new();
    // Interlayer paths: tank cut area, centroid separation, bulk smooth-wall drag.
    for (i, f) in arr(&p, "/cmt/interfaces").iter().enumerate() {
        paths.push(Path {
            from: i,
            to: i + 1,
            junction: num(f, "/elevation_m"),
            inertance: num(f, "/length_m") / num(f, "/area_m2"),
            area: num(f, "/area_m2"),
            bore: num(f, "/hydraulicDiameter_m"),
            roughness: 0.,
            pipe: num(f, "/length_m"),
            k: 0.,
            k_variable: 0.,
            preload: 0.,
        });
    }
    // BAL: tap->RUN (isolation), RUN->R1, R1->R2, R2->DIST.
    let k_bal = k_of(num(&p, "/cmt/balance/isolation/area_m2"), area);
    for (i, b) in arr(&p, "/cmt/balance/paths").iter().enumerate() {
        let iso = b["isolation"].as_bool().unwrap();
        paths.push(Path {
            from: if i == 0 { TAP } else { RUN + i - 1 },
            to: RUN + i,
            junction: num(b, "/junction_m"),
            inertance: num(b, "/length_m") / area,
            area,
            bore,
            roughness: rough,
            pipe: num(b, "/length_m"),
            k: 0.,
            k_variable: if iso { k_bal } else { 0. },
            preload: 0.,
        });
    }
    // Outlet: tank (L1)->OUT carries the isolations, OUT->DVI the meter, check body, discharge and check.
    let o = &p["cmt"]["outlet"];
    let half = num(o, "/cell/length_m") / 2.;
    let k_iso = k_of(num(o, "/isolation/area_m2"), area);
    let k_low = k_of(num(o, "/meter/area_m2"), area) + k_of(num(o, "/check/area_m2"), area) + 1.;
    let oroughness = num(o, "/roughness_m");
    let opaths = arr(o, "/paths");
    paths.push(Path {
        from: 0,
        to: OUT,
        junction: num(&opaths[0], "/junction_m"),
        inertance: half / area,
        area,
        bore,
        roughness: oroughness,
        pipe: half,
        k: 0.,
        k_variable: k_iso,
        preload: 0.,
    });
    paths.push(Path {
        from: OUT,
        to: DVI,
        junction: num(&opaths[1], "/junction_m"),
        inertance: half / area,
        area,
        bore,
        roughness: oroughness,
        pipe: half,
        k: k_low,
        k_variable: 0.,
        preload: num(o, "/check/crack_Pa"),
    });
    // DVI neck to the DOWNCOMER: wall, one side-entry velocity head, form loss, meter.
    let nb = num(&p, "/dvi/neck/bore_m");
    let na = std::f64::consts::PI * nb * nb / 4.;
    paths.push(Path {
        from: DVI,
        to: DC,
        junction: num(&p, "/dvi/elevation_m"),
        inertance: num(&p, "/dvi/neck/length_m") / na,
        area: na,
        bore: nb,
        roughness: num(&p, "/dvi/neck/roughness_m"),
        pipe: num(&p, "/dvi/neck/length_m"),
        k: 1.
            + num(&p, "/dvi/neck/formVelocityHeads")
            + k_of(num(&p, "/dvi/neck/meterArea_m2"), na),
        k_variable: 0.,
        preload: 0.,
    });
    let rings = arr(&p, "/cmt/rings/list")
        .iter()
        .map(|r| (num(r, "/elevation_m"), num(r, "/area_m2")))
        .collect();
    let witness = &p["boundary"]["coldWitness"];
    let prm = Prm {
        layers,
        bal,
        out,
        dvi,
        paths,
        rings,
        hole: num(&p, "/cmt/rings/holeDiameter_m"),
        cd: num(&p, "/cmt/rings/Cd"),
        cmt_t: num(&p, "/cmt/temperature_K"),
        tracer: num(&p, "/cmt/tracer_kg_kg"),
        acc: p["acc"].clone(),
        columns: arr(&p, "/gravity/columns").clone(),
        gravity: p["gravity"].clone(),
        chamber_v: num(&p, "/ads/chambers/0/volume_m3"),
        chamber_z: num(&p, "/ads/chambers/0/elevation_m"),
        cold_p: num(witness, "/pressure_Pa"),
        cold_h: num(witness, "/enthalpy_J_kg"),
        roof_p: num(&p, "/boundary/pzrRoof/pressure_Pa"),
        cold_density: num(&p, "/dvi/neck/referenceDensity_kg_m3"),
        packet: p.clone(),
    };
    (prm, p)
}

// ------------------------------------------------------------------ the layout
// Per train: 12 cells x 6 slots, DVI + 2 NC, 12 paths x 2, 3 rings x 2,
// ACC 11 + outlet 2 + vent 2, GIV/RECIRC (7 + 2 + 2) each.
const CELL_SLOTS: usize = 6;
const NPATH: usize = 12;
const T_CELLS: usize = 0;
const T_NC: usize = NCELL * CELL_SLOTS; // DVI M_air, M_N2
const T_PATHS: usize = T_NC + 2;
const T_RINGS: usize = T_PATHS + NPATH * 2;
const T_ACC: usize = T_RINGS + 6;
const T_ACC_OUT: usize = T_ACC + 11;
const T_VENT: usize = T_ACC_OUT + 2;
const T_COL: usize = T_VENT + 2; // two columns x 11
const PER_TRAIN: usize = T_COL + 22;
const U_CHAMBERS: usize = 2 * PER_TRAIN;
const U_DEVICES: usize = U_CHAMBERS + 6 * 7;
const U_ADS4: usize = U_DEVICES + 24;
const N: usize = U_ADS4 + 4;
// ACC slots: differential then algebraic.
const AML: usize = 0;
const AEL: usize = 1;
const AB: usize = 2;
const AMN: usize = 3;
const AMA: usize = 4;
const AMV: usize = 5;
const AEG: usize = 6;
const API: usize = 7;
const AZI: usize = 8;
const ATL: usize = 9;
const ATG: usize = 10;
// Column slots.
const CMW: usize = 0;
const CMA: usize = 1;
const CMN: usize = 2;
const CE: usize = 3;
const CB: usize = 4;
const CP: usize = 5;
const CT: usize = 6;
const CSRC: usize = 7;
const CTERM: usize = 9;

fn cell(t: usize, k: usize, slot: usize) -> usize {
    t * PER_TRAIN + T_CELLS + k * CELL_SLOTS + slot
}
fn path(t: usize, j: usize, phase: usize) -> usize {
    t * PER_TRAIN + T_PATHS + 2 * j + phase
}
fn ring(t: usize, j: usize, phase: usize) -> usize {
    t * PER_TRAIN + T_RINGS + 2 * j + phase
}
fn acc(t: usize, s: usize) -> usize {
    t * PER_TRAIN + T_ACC + s
}
fn column(t: usize, j: usize, s: usize) -> usize {
    t * PER_TRAIN + T_COL + 11 * j + s
}
fn chamber(j: usize, s: usize) -> usize {
    U_CHAMBERS + 7 * j + s
}

fn name(i: usize) -> String {
    if i < U_CHAMBERS {
        let t = ["A", "B"][i / PER_TRAIN];
        let r = i % PER_TRAIN;
        let cells = [
            "L1", "L2", "L3", "L4", "L5", "L6", "RUN", "RISER.1", "RISER.2", "DIST", "OUT", "DVI",
        ];
        let slots = ["p", "M_l", "U_l", "M_g", "U_g", "B"];
        if r < T_NC {
            return format!("{t}.{}.{}", cells[r / CELL_SLOTS], slots[r % CELL_SLOTS]);
        }
        if r < T_PATHS {
            return format!("{t}.DVI.{}", ["M_air", "M_N2"][r - T_NC]);
        }
        if r < T_RINGS {
            let names = [
                "L1-L2", "L2-L3", "L3-L4", "L4-L5", "L5-L6", "TAP-RUN", "RUN-R1", "R1-R2",
                "R2-DIST", "L1-OUT", "OUT-DVI", "DVI-DC",
            ];
            return format!(
                "{t}.path.{}.{}",
                names[(r - T_PATHS) / 2],
                ["Pi_l", "Pi_g"][(r - T_PATHS) % 2]
            );
        }
        if r < T_ACC {
            return format!(
                "{t}.ring.{}.{}",
                (r - T_RINGS) / 2 + 1,
                ["m_l", "m_g"][(r - T_RINGS) % 2]
            );
        }
        if r < T_ACC_OUT {
            let s = [
                "M_l", "E_l", "B", "M_N2", "M_air", "M_v", "E_g", "p_I", "z_I", "T_l", "T_g",
            ];
            return format!("{t}.ACC.{}", s[r - T_ACC]);
        }
        if r < T_VENT {
            return format!("{t}.ACC.outlet.{}", ["m_l", "m_g"][r - T_ACC_OUT]);
        }
        if r < T_COL {
            return format!("{t}.ACC.vent.{}", ["m_l", "m_g"][r - T_VENT]);
        }
        let j = (r - T_COL) / 11;
        let s = [
            "M_w", "M_air", "M_N2", "E", "B", "p_c", "T_c", "src.m_l", "src.m_g", "term.m_l",
            "term.m_g",
        ];
        return format!("{t}.{}.{}", ["GIV", "RECIRC"][j], s[(r - T_COL) % 11]);
    }
    if i < U_DEVICES {
        let s = ["M_w", "M_air", "M_N2", "E", "B", "p", "T"];
        return format!(
            "ADS.chamber.{}.{}",
            (i - U_CHAMBERS) / 7,
            s[(i - U_CHAMBERS) % 7]
        );
    }
    if i < U_ADS4 {
        return format!(
            "ADS.device.{}.{}",
            (i - U_DEVICES) / 2,
            ["m_l", "m_g"][(i - U_DEVICES) % 2]
        );
    }
    format!(
        "ADS4.{}.{}",
        (i - U_ADS4) / 2,
        ["m_l", "m_g"][(i - U_ADS4) % 2]
    )
}

/// Declared classification (the census): differential slots.
fn declared_differential(i: usize) -> bool {
    if i < U_CHAMBERS {
        let r = i % PER_TRAIN;
        if r < T_NC {
            return r % CELL_SLOTS != 0;
        }
        if r < T_PATHS {
            return true;
        }
        if r < T_RINGS {
            return true;
        }
        if r < T_ACC {
            return false;
        }
        if r < T_ACC_OUT {
            return r - T_ACC < API;
        }
        if r < T_COL {
            return false;
        }
        // Column storage slots, and (S4-D13) the source/terminal path impulses.
        return (r - T_COL) % 11 != CP && (r - T_COL) % 11 != CT;
    }
    if i < U_DEVICES {
        return (i - U_CHAMBERS) % 7 < 5;
    }
    false
}

// ----------------------------------------------------------- modes and inputs
#[derive(Clone)]
struct Modes {
    /// Locked phase paths (L1): (train, path, phase).
    locked: Vec<[bool; 2]>,
    /// Locked algebraic links: ACC outlet, vent, column source/terminal, per train.
    acc_locked: [bool; 2],
    vent_locked: [bool; 2],
    src_locked: [[bool; 2]; 2],
    term_locked: [[bool; 2]; 2],
    /// Regular cells in the equilibrium mode E (S3-D-P1), per train and cell.
    e_cells: Vec<bool>,
}
#[derive(Clone)]
struct Inputs {
    tap_p: f64,
    tap_h: f64,
    dc_p: f64,
    dc_h: f64,
    roof_p: f64,
    wst_surface: f64,
    wst_t: f64,
    sump_surface: f64,
    cnv_p: f64,
    /// Stems: BAL isolation, CMT outlet isolations (a1+a2)/2, ACC isolation, column source opening x screen.
    x_bal: f64,
    x_out: f64,
    x_acc: f64,
    x_src: [f64; 2],
}

struct Eval {
    f: Vec<D>,
}

/// A regular cell's view: its liquid state (mode L: at (p, U/M); mode E:
/// the saturated-liquid endpoint at p) and, in E, the saturated vapor.
#[derive(Clone, Copy)]
struct Cv {
    p: D,
    m: D,
    st: St,
    vap: Option<St>,
    c: D,
    z: f64,
}
/// A saturated endpoint at p with its exact directions along the saturation line.
fn saturated(branch: Branch, p: D) -> Result<St, String> {
    let (q, d) = directional(branch, p.v, 0., p.d, 0.)
        .map_err(|e| format!("IF97 {branch:?} at {} Pa: {e}", p.v))?;
    let t = D::new(q.temperature_k, d.temperature_k);
    Ok(St {
        rho: D::new(q.density_kg_m3, d.density_kg_m3),
        u: D::new(q.internal_energy_j_kg, d.internal_energy_j_kg),
        h: D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
        mu: D::new(
            q.viscosity_pa_s,
            viscosity_direction(branch, p, t, d.viscosity_pa_s),
        ),
        t,
    })
}
fn view(y: &[D], i0: usize, z: f64, equilibrium: bool) -> Result<Cv, String> {
    let (p, m, u) = (y[i0], y[i0 + 1], y[i0 + 2]);
    if equilibrium {
        // Slots M_l, U_l hold the totals; M_g is algebraic (S3-D-P1).
        let liquid = saturated(Branch::SaturatedLiquid, p)?;
        let vapor = saturated(Branch::SaturatedVapor, p)?;
        return Ok(Cv {
            p,
            m,
            st: liquid,
            vap: Some(vapor),
            c: y[i0 + 5] / (m - y[i0 + 3]),
            z,
        });
    }
    let t = temperature_pu(Branch::Liquid, p, u / m)?;
    let st = state(Branch::Liquid, p, t)?;
    Ok(Cv {
        p,
        m,
        st,
        vap: None,
        c: y[i0 + 5] / m,
        z,
    })
}

/// The residual F(y, y') of every C11 source owner.
fn residual(y: &[D], yp: &[D], m: &Modes, inp: &Inputs, p: &Prm) -> Result<Eval, String> {
    let mut f = vec![c(0.); N];
    for t in 0..2 {
        // Cells.
        let geo: Vec<&Layer> = p
            .layers
            .iter()
            .chain(p.bal.iter())
            .chain([&p.out, &p.dvi])
            .collect();
        let mut cv = Vec::with_capacity(NCELL);
        for k in 0..NCELL {
            cv.push(view(y, cell(t, k, 0), geo[k].z, m.e_cells[t * NCELL + k])?);
        }
        // Rates accumulated per cell: mass, energy, tracer.
        let mut dm = vec![c(0.); NCELL];
        let mut de = vec![c(0.); NCELL];
        let mut db = vec![c(0.); NCELL];
        // Port views at +3 m: the C06 COLD tap and DOWNCOMER (held).
        let port = |pp: f64, hh: f64| -> Result<Cv, String> {
            let tt = temperature_ph(Branch::Liquid, pp, hh);
            Ok(Cv {
                p: c(pp),
                m: c(1.),
                st: state(Branch::Liquid, c(pp), c(tt))?,
                vap: None,
                c: c(p.tracer),
                z: 3.,
            })
        };
        let tap = port(inp.tap_p, inp.tap_h)?;
        let dcv = port(inp.dc_p, inp.dc_h)?;
        let get = |k: usize| -> Cv {
            match k {
                TAP => tap,
                DC => dcv,
                _ => cv[k],
            }
        };
        // Signed transfer m from a to b with donor by sign.
        let transfer =
            |a: usize, b: usize, mf: D, dm: &mut Vec<D>, de: &mut Vec<D>, db: &mut Vec<D>| {
                let donor = if mf.v >= 0. { get(a) } else { get(b) };
                let ht = donor.st.h + G * donor.z;
                if a < NCELL {
                    dm[a] = dm[a] - mf;
                    de[a] = de[a] - mf * (ht - G * get(a).z);
                    db[a] = db[a] - mf * donor.c;
                }
                if b < NCELL {
                    dm[b] = dm[b] + mf;
                    de[b] = de[b] + mf * (ht - G * get(b).z);
                    db[b] = db[b] + mf * donor.c;
                }
            };
        // Phase paths.
        for (j, q) in p.paths.iter().enumerate() {
            let (a, b) = (get(q.from), get(q.to));
            let il = path(t, j, 0);
            let ig = path(t, j, 1);
            // Vapor paths: absent donor phase everywhere (L mode): locked, Π_g = 0.
            f[ig] = y[ig];
            if m.locked[t * NPATH + j][0] {
                f[il] = y[il];
                continue;
            }
            let mf = y[il] / q.inertance;
            let drive = (a.p + a.st.rho * (G * (a.z - q.junction)))
                - (b.p + b.st.rho * (G * (b.z - q.junction)))
                - q.preload;
            let donor = if mf.v >= 0. { a } else { b };
            let x = match (t, j) {
                (_, 5) => inp.x_bal,
                (_, 9) => inp.x_out,
                _ => 1.,
            };
            let mut loss = darcy_loss(
                mf,
                donor.st.rho,
                donor.st.mu,
                q.pipe,
                q.bore,
                q.area,
                q.roughness,
            );
            loss = loss + heads(q.k + q.k_variable / (x * x), mf, donor.st.rho, q.area);
            f[il] = yp[il] - (drive - loss);
            transfer(q.from, q.to, mf, &mut dm, &mut de, &mut db);
        }
        // Hole rings: thin-screen law at each ring elevation, DIST -> L6 positive.
        for (j, &(z, area)) in p.rings.iter().enumerate() {
            let (a, b) = (cv[DIST], cv[5]);
            let delta = (a.p + a.st.rho * (G * (a.z - z))) - (b.p + b.st.rho * (G * (b.z - z)));
            let donor = if delta.v >= 0. { a } else { b };
            let mu_bar = (a.st.mu + b.st.mu) * 0.5;
            let a_mu = mu_bar * (6. * std::f64::consts::PI / p.hole);
            let b_rho = donor.st.rho / (2. * p.cd * p.cd);
            let vn = delta * 2. / (a_mu + (a_mu * a_mu + b_rho * delta.abs() * 4.).sqrt());
            let mf = donor.st.rho * vn * area;
            let il = ring(t, j, 0);
            f[il] = y[il] - mf;
            f[ring(t, j, 1)] = y[ring(t, j, 1)];
            transfer(DIST, 5, y[il], &mut dm, &mut de, &mut db);
        }
        // ACC two stores.
        let a0 = |s: usize| y[acc(t, s)];
        let accp = &p.acc;
        let (area, zb, zr) = (
            num(accp, "/area_m2"),
            num(accp, "/bottom_m"),
            num(accp, "/roof_m"),
        );
        let (rn, cvn) = (
            num(accp, "/nitrogen/R_J_kgK"),
            num(accp, "/nitrogen/cv_J_kgK"),
        );
        let (ra, cva) = (
            num(&p.gravity, "/columns/1/fill/R_J_kgK"),
            num(&p.gravity, "/columns/1/fill/cv_J_kgK"),
        );
        let (pi, zi, tl, tg) = (a0(API), a0(AZI), a0(ATL), a0(ATG));
        let hl = zi - zb;
        let rho_i = state(Branch::Liquid, pi, tl)?.rho;
        let plc = pi + rho_i * hl * (G / 2.);
        let lc = state(Branch::Liquid, plc, tl)?;
        let hg = c(zr) - zi;
        let mgas = a0(AMN) + a0(AMA);
        let rho_g = mgas / (hg * area);
        let pgc = pi - rho_g * hg * (G / 2.);
        // The gas store's water vapor (C11-D4) is absent at preparation and in the cases (no evaporation away from the
        // stability boundary): its IF97 partial-pressure term is not evaluated here; M_v enters only its own rate row;
        f[acc(t, API)] = a0(AML) - lc.rho * hl * area;
        f[acc(t, AZI)] = pgc * hg * area - (a0(AMN) * rn + a0(AMA) * ra) * tg;
        f[acc(t, ATL)] = a0(AEL) - a0(AML) * (lc.u + (zi + zb) * (G / 2.));
        f[acc(t, ATG)] = a0(AEG)
            - ((a0(AMN) * cvn + a0(AMA) * cva) * (tg - 298.15) + mgas * (zi + zr) * (G / 2.));
        let i_out = t * PER_TRAIN + T_ACC_OUT;
        let pbottom = pi + lc.rho * hl * G;
        let bottom = state(Branch::Liquid, pbottom, tl)?;
        let dvi = cv[DVI];
        if m.acc_locked[t] {
            f[i_out] = y[i_out];
        } else {
            let bore = num(accp, "/outlet/bore_m");
            let ab = std::f64::consts::PI * bore * bore / 4.;
            let (av, am) = (
                num(accp, "/outlet/variableArea_m2") * inp.x_acc,
                num(accp, "/outlet/meterArea_m2"),
            );
            let r =
                ((1. - (av / ab).powi(2)) / (av * av) + (1. - (am / ab).powi(2)) / (am * am)) / 2.;
            let crack = num(accp, "/outlet/checks") * num(accp, "/outlet/checkCrack_Pa");
            let delta = pbottom - dvi.p - crack;
            f[i_out] = y[i_out] - (delta * (bottom.rho / r)).sqrt();
        }
        f[i_out + 1] = y[i_out + 1];
        let vent = t * PER_TRAIN + T_VENT;
        f[vent] = y[vent];
        f[vent + 1] = y[vent + 1];
        let mout = y[i_out];
        f[acc(t, AML)] = yp[acc(t, AML)] + mout;
        f[acc(t, AEL)] = yp[acc(t, AEL)] + pi * yp[acc(t, AZI)] * area + mout * (bottom.h + G * zb);
        f[acc(t, AB)] = yp[acc(t, AB)] + mout * (a0(AB) / a0(AML));
        f[acc(t, AMN)] = yp[acc(t, AMN)];
        f[acc(t, AMA)] = yp[acc(t, AMA)];
        f[acc(t, AMV)] = yp[acc(t, AMV)];
        f[acc(t, AEG)] = yp[acc(t, AEG)] - pi * yp[acc(t, AZI)] * area;
        dm[DVI] = dm[DVI] + mout;
        de[DVI] = de[DVI] + mout * (bottom.h + G * (zb - p.dvi.z));
        db[DVI] = db[DVI] + mout * (a0(AB) / a0(AML));
        // GIV (water) and RECIRC (dry air) retained columns.
        for j in 0..2 {
            let col = &p.columns[j];
            let (v, zc, zm, zt) = (
                num(col, "/volume_m3"),
                num(col, "/centroid_m"),
                num(col, "/mouth_m"),
                num(col, "/terminal_m"),
            );
            let k = |s: usize| y[column(t, j, s)];
            let (pc, tc) = (k(CP), k(CT));
            let (rho_c, u_c, h_c) = if j == 0 {
                let s = state(Branch::Liquid, pc, tc)?;
                (s.rho, s.u, s.h)
            } else {
                let rho = pc / (tc * ra);
                let u = (tc - 298.15) * cva;
                (rho, u, u + tc * ra)
            };
            let mass = if j == 0 { k(CMW) } else { k(CMA) };
            f[column(t, j, CP)] = mass - rho_c * v;
            f[column(t, j, CT)] = k(CE) - mass * (u_c + G * zc);
            let src = column(t, j, CSRC);
            let term = column(t, j, CTERM);
            // S4-D13: the source and terminal devices sit on inertance paths, each over half the
            // column's developed length (the selected device law has no low-Reynolds branch);
            // their losses are the devices' velocity heads K = (A/a)^2 - 1 at the frozen areas.
            let surface = if j == 0 {
                inp.wst_surface
            } else {
                inp.sump_surface
            };
            let ab = {
                let b = num(col, "/bore_m");
                std::f64::consts::PI * b * b / 4.
            };
            // Effective area frozen from the element's own liquid sizing point (60 kg/s, 25 C donor, receiver 101325 Pa).
            let calibration = |drop: f64| -> Result<f64, String> {
                let s = state(
                    Branch::Liquid,
                    c(num(&p.gravity, "/calibration/pressure_Pa") + drop),
                    c(num(&p.gravity, "/calibration/temperature_K")),
                )?;
                let mref = num(&p.gravity, "/calibration/flow_kg_s");
                Ok(mref / (2. * s.rho.v * drop + (mref / ab).powi(2)).sqrt())
            };
            let pool = state(Branch::Liquid, c(inp.cnv_p), c(inp.wst_t))?;
            let mut msrc = c(0.);
            assert!(
                j == 0 || m.src_locked[t][j],
                "RECIRC from an empty SUMP draws CNV gas: C06's discharge law, not evaluated here"
            );
            let inertance = num(col, "/length_m") / 2. / ab;
            if m.src_locked[t][j] {
                f[src] = y[src];
            } else {
                let p_mouth_pool = c(inp.cnv_p) + pool.rho * (G * (surface - zm));
                let p_mouth_col = pc + rho_c * (G * (zc - zm));
                let flow = y[src] / inertance;
                let k = ((ab / calibration(num(col, "/sourceDrop_Pa"))?).powi(2) - 1.)
                    / (inp.x_src[j] * inp.x_src[j]);
                let donor_rho = if flow.v >= 0. { pool.rho } else { rho_c };
                let loss = flow * flow.abs() * (k / (2. * ab * ab)) / donor_rho;
                f[src] = yp[src] - (p_mouth_pool - p_mouth_col - loss);
                msrc = flow;
            }
            f[src + 1] = y[src + 1];
            let mut mterm = c(0.);
            if m.term_locked[t][j] {
                f[term] = y[term];
            } else {
                let p_term = pc + rho_c * (G * (zc - zt));
                let flow = y[term] / inertance;
                let k = (ab / calibration(num(col, "/meterDrop_Pa"))?).powi(2) - 1.;
                let loss = flow * flow.abs() * (k / (2. * ab * ab)) / rho_c;
                f[term] = yp[term] - (p_term - dvi.p - num(&p.gravity, "/checkCrack_Pa") - loss);
                mterm = flow;
            }
            f[term + 1] = y[term + 1];
            // Column balances: mouth inflow carries the pool's Ht = h_s + g*surface; terminal outflow the column's h + g z (constant on its adiabat).
            let pool_ht = pool.h + G * surface;
            let col_ht = h_c + G * zc;
            let in_e = if msrc.v >= 0. {
                msrc * pool_ht
            } else {
                msrc * col_ht
            };
            let massslot = if j == 0 { CMW } else { CMA };
            for s in [CMW, CMA, CMN] {
                f[column(t, j, s)] =
                    yp[column(t, j, s)] - if s == massslot { msrc - mterm } else { c(0.) };
            }
            f[column(t, j, CE)] = yp[column(t, j, CE)] - (in_e - mterm * col_ht);
            let pool_c = num(&p.packet, "/gravity/columns/0/fill/tracer_kg_kg");
            let cin = if j == 0 { pool_c } else { 0. };
            let ccol = if mass.v > 0. { k(CB) / mass } else { c(0.) };
            f[column(t, j, CB)] = yp[column(t, j, CB)] - (msrc * cin - mterm * ccol);
            dm[DVI] = dm[DVI] + mterm;
            de[DVI] = de[DVI] + mterm * (col_ht - G * p.dvi.z);
            db[DVI] = db[DVI] + mterm * ccol;
        }
        // Cell rows.
        for k in 0..NCELL {
            let i0 = cell(t, k, 0);
            let v = geo[k].v;
            if let Some(vap) = cv[k].vap {
                // Equilibrium mode: EOS on p, totals differential, split on M_g, definition on U_g.
                let (mt, ut, mg) = (y[i0 + 1], y[i0 + 2], y[i0 + 3]);
                let liq = cv[k].st;
                f[i0] = (mt - mg) / liq.rho + mg / vap.rho - v;
                f[i0 + 1] = yp[i0 + 1] - dm[k];
                f[i0 + 2] = yp[i0 + 2] - de[k];
                f[i0 + 3] = ut - (mt - mg) * liq.u - mg * vap.u;
                f[i0 + 4] = y[i0 + 4] - mg * vap.u;
                f[i0 + 5] = yp[i0 + 5] - db[k];
                continue;
            }
            f[i0] = y[i0 + 1] / cv[k].st.rho - v;
            f[i0 + 1] = yp[i0 + 1] - dm[k];
            f[i0 + 2] = yp[i0 + 2] - de[k];
            f[i0 + 3] = yp[i0 + 3];
            f[i0 + 4] = yp[i0 + 4];
            f[i0 + 5] = yp[i0 + 5] - db[k];
        }
        let nc = t * PER_TRAIN + T_NC;
        f[nc] = yp[nc];
        f[nc + 1] = yp[nc + 1];
    }
    // ADS chambers (G at the dew point): vapor branch, all devices locked here.
    for j in 0..6 {
        let s = state(Branch::Vapor, y[chamber(j, 5)], y[chamber(j, 6)])?;
        f[chamber(j, 5)] = y[chamber(j, 0)] - s.rho * p.chamber_v;
        f[chamber(j, 6)] = y[chamber(j, 3)] - y[chamber(j, 0)] * (s.u + G * p.chamber_z);
        for k in 0..5 {
            f[chamber(j, k)] = yp[chamber(j, k)];
        }
    }
    for i in U_DEVICES..N {
        f[i] = y[i];
    }
    let _ = inp.roof_p;
    Ok(Eval { f })
}

// ------------------------------------------------------- preparation and probes
/// Held C13 values: WST surface +14.148275 m and 25 C (`ld01-cnv-pools`),
/// CNV 101.325 kPa (`ld01-cnv-atmosphere`), SUMP empty at its −2 m floor.
fn prepared_inputs(p: &Prm) -> Inputs {
    Inputs {
        tap_p: p.cold_p,
        tap_h: p.cold_h,
        dc_p: p.cold_p,
        dc_h: p.cold_h,
        roof_p: p.roof_p,
        wst_surface: 14.148275,
        wst_t: 298.15,
        sump_surface: -2.,
        cnv_p: 101325.,
        x_bal: 1.,
        x_out: 0.,
        x_acc: 1.,
        x_src: [0., 0.],
    }
}
fn rho_at(p: f64, t: f64) -> f64 {
    state(Branch::Liquid, c(p), c(t)).unwrap().rho.v
}
/// Hydrostatic march across a junction: p_b with p_a + rho_a g (z_a − z_j) = p_b + rho_b(p_b) g (z_b − z_j).
fn march(pa: f64, rho_a: f64, za: f64, zj: f64, zb: f64, tb: f64) -> f64 {
    let target = pa + rho_a * G * (za - zj);
    // Scalar hydrostatic preparation: rho(p) varies by ~1e-6 over a cell, 60 passes reach the double value.
    let mut pb = target;
    for _ in 0..60 {
        pb = target - rho_at(pb, tb) * G * (zb - zj);
    }
    pb
}
/// Set a liquid cell from (p, T): M = rho V, U = M u, B = c M.
fn set_cell(y: &mut [f64], i0: usize, v: f64, pp: f64, t: f64, conc: f64) {
    let s = state(Branch::Liquid, c(pp), c(t)).unwrap();
    let m = s.rho.v * v;
    y[i0] = pp;
    y[i0 + 1] = m;
    y[i0 + 2] = m * s.u.v;
    y[i0 + 3] = 0.;
    y[i0 + 4] = 0.;
    y[i0 + 5] = m * conc;
}

struct Prepared {
    y: Vec<f64>,
    modes: Modes,
    inputs: Inputs,
    checks: Value,
}

/// The prepared state (allocation "Births, exhaustions …" and the preparations it cites).
fn prepare(p: &Prm) -> Prepared {
    prepare_with(p, prepared_inputs(p), None)
}
/// The preparation at given C06 port states; `cap` puts the receiving layer
/// L6 in the equilibrium mode with that vapor volume above its liquid.
fn prepare_with(p: &Prm, inp: Inputs, cap: Option<f64>) -> Prepared {
    let mut y = vec![0.; N];
    let t_tap = temperature_ph(Branch::Liquid, inp.tap_p, inp.tap_h);
    let mut checks = json!({});
    for t in 0..2 {
        // BAL: hot, isothermal at the tap temperature, marched from the tap with the residual's drive.
        let rho_tap = rho_at(inp.tap_p, t_tap);
        let mut pa = inp.tap_p;
        let (mut rho_a, mut za) = (rho_tap, 3.);
        for (i, q) in p.paths[5..9].iter().enumerate() {
            let k = RUN + i;
            let pb = march(pa, rho_a, za, q.junction, p.bal[i].z, t_tap);
            set_cell(&mut y, cell(t, k, 0), p.bal[i].v, pb, t_tap, p.tracer);
            pa = pb;
            rho_a = rho_at(pb, t_tap);
            za = p.bal[i].z;
        }
        // Tank: the cold column below the hot BAL rise, equal at the +12 m datum
        // ("Initial pressure follows the COLD port and the hot balance-line hydrostatic rise, then the cold-water column").
        let (p_dist, rho_dist, z_dist) = (pa, rho_a, za);
        let (l6, mut rho_up) = if let Some(vg) = cap {
            // Saturated receiving layer: the liquid's saturation density in the march (60 passes).
            let target = p_dist + rho_dist * G * (z_dist - 12.);
            let mut pp = target;
            for _ in 0..60 {
                pp = target
                    - saturated(Branch::SaturatedLiquid, c(pp)).unwrap().rho.v
                        * G
                        * (p.layers[5].z - 12.);
            }
            let liq = saturated(Branch::SaturatedLiquid, c(pp)).unwrap();
            let vap = saturated(Branch::SaturatedVapor, c(pp)).unwrap();
            let (mf, mg) = (liq.rho.v * (p.layers[5].v - vg), vap.rho.v * vg);
            let i0 = cell(t, 5, 0);
            y[i0] = pp;
            y[i0 + 1] = mf + mg;
            y[i0 + 2] = mf * liq.u.v + mg * vap.u.v;
            y[i0 + 3] = mg;
            y[i0 + 4] = mg * vap.u.v;
            y[i0 + 5] = mf * p.tracer;
            (pp, liq.rho.v)
        } else {
            let pp = march(p_dist, rho_dist, z_dist, 12., p.layers[5].z, p.cmt_t);
            set_cell(&mut y, cell(t, 5, 0), p.layers[5].v, pp, p.cmt_t, p.tracer);
            (pp, rho_at(pp, p.cmt_t))
        };
        let mut upper = l6;
        for k in (0..5).rev() {
            let q = &p.paths[k];
            let pk = march(
                upper,
                rho_up,
                p.layers[k + 1].z,
                q.junction,
                p.layers[k].z,
                p.cmt_t,
            );
            set_cell(&mut y, cell(t, k, 0), p.layers[k].v, pk, p.cmt_t, p.tracer);
            rho_up = rho_at(pk, p.cmt_t);
            upper = pk;
        }
        // DVI at the C06 +3 m state; OUT seated against it (drive exactly 0 without preload).
        let t_dc = temperature_ph(Branch::Liquid, inp.dc_p, inp.dc_h);
        set_cell(&mut y, cell(t, DVI, 0), p.dvi.v, inp.dc_p, t_dc, p.tracer);
        let rho_dvi = rho_at(inp.dc_p, t_dc);
        let p_out = march(
            inp.dc_p,
            rho_dvi,
            p.dvi.z,
            p.paths[10].junction,
            p.out.z,
            p.cmt_t,
        );
        set_cell(&mut y, cell(t, OUT, 0), p.out.v, p_out, p.cmt_t, p.tracer);
        // ACC: zI=+6.5 m, 298.15 K, pI=5 MPa; one-point quadrature (C11-D5).
        let a = &p.acc;
        let (area, zb, zr, zi) = (
            num(a, "/area_m2"),
            num(a, "/bottom_m"),
            num(a, "/roof_m"),
            num(a, "/interface_m"),
        );
        let (pi, tt) = (num(a, "/interfacePressure_Pa"), num(a, "/temperature_K"));
        let (rn, cvn) = (num(a, "/nitrogen/R_J_kgK"), num(a, "/nitrogen/cv_J_kgK"));
        let hl = zi - zb;
        let plc = pi + rho_at(pi, tt) * G * hl / 2.;
        let lc = state(Branch::Liquid, c(plc), c(tt)).unwrap();
        let ml = lc.rho.v * area * hl;
        let hg = zr - zi;
        let mn = pi * area * hg / (rn * tt + G * hg / 2.);
        y[acc(t, AML)] = ml;
        y[acc(t, AEL)] = ml * (lc.u.v + G * (zi + zb) / 2.);
        y[acc(t, AB)] = ml * num(a, "/tracer_kg_kg");
        y[acc(t, AMN)] = mn;
        y[acc(t, AEG)] = mn * cvn * (tt - 298.15) + mn * G * (zi + zr) / 2.;
        y[acc(t, API)] = pi;
        y[acc(t, AZI)] = zi;
        y[acc(t, ATL)] = tt;
        y[acc(t, ATG)] = tt;
        if t == 0 {
            checks["accLiquid_kg"] = json!({"prepared": ml, "selected": num(a, "/selected/liquid_kg"),
                "relative": (ml - num(a, "/selected/liquid_kg")) / num(a, "/selected/liquid_kg")});
            checks["accNitrogen_kg"] = json!({"prepared": mn, "selected": num(a, "/selected/nitrogen_kg"),
                "relative": (mn - num(a, "/selected/nitrogen_kg")) / num(a, "/selected/nitrogen_kg")});
        }
        // GIV: service-filled from the 25 C WST pool's hydrostatic mouth state along the caloric adiabat (h + g z constant).
        let col = &p.columns[0];
        let (v, zc, zm) = (
            num(col, "/volume_m3"),
            num(col, "/centroid_m"),
            num(col, "/mouth_m"),
        );
        let pool = state(Branch::Liquid, c(inp.cnv_p), c(inp.wst_t)).unwrap();
        let pm = inp.cnv_p + pool.rho.v * G * (inp.wst_surface - zm);
        // The pool's own head transformation from its 25 C surface: h + g z constant, so the mouth is
        // marginally warmer than 25 C ("the native mouth temperature is not constrained to exactly 25°C").
        let hm = pool.h.v + G * (inp.wst_surface - zm);
        let mut pc = pm + rho_at(pm, inp.wst_t) * G * (zm - zc);
        let hc = hm + G * (zm - zc);
        for _ in 0..50 {
            let tc = temperature_ph(Branch::Liquid, pc, hc);
            let rho_mid = rho_at(0.5 * pc + 0.5 * pm, tc);
            pc = pm + rho_mid * G * (zm - zc);
        }
        let tc = temperature_ph(Branch::Liquid, pc, hc);
        let s = state(Branch::Liquid, c(pc), c(tc)).unwrap();
        let mw = s.rho.v * v;
        y[column(t, 0, CMW)] = mw;
        y[column(t, 0, CE)] = mw * (s.u.v + G * zc);
        y[column(t, 0, CB)] = mw * num(&p.packet, "/gravity/columns/0/fill/tracer_kg_kg");
        y[column(t, 0, CP)] = pc;
        y[column(t, 0, CT)] = tc;
        // RECIRC: dry air at CNV pressure at the −1.8 m mouth, ideal-air adiabat (cp = cv + R).
        let col = &p.columns[1];
        let (v, zc, zm) = (
            num(col, "/volume_m3"),
            num(col, "/centroid_m"),
            num(col, "/mouth_m"),
        );
        let (ra, cva) = (num(col, "/fill/R_J_kgK"), num(col, "/fill/cv_J_kgK"));
        let tm = num(col, "/fill/temperature_K");
        let tcr = tm - G * (zc - zm) / (cva + ra);
        let mut pcr = inp.cnv_p;
        for _ in 0..50 {
            pcr = inp.cnv_p
                - (0.5 * pcr + 0.5 * inp.cnv_p) / (ra * (0.5 * tcr + 0.5 * tm)) * G * (zc - zm);
        }
        let ma = pcr / (ra * tcr) * v;
        y[column(t, 1, CMA)] = ma;
        y[column(t, 1, CE)] = ma * (cva * (tcr - 298.15) + G * zc);
        y[column(t, 1, CP)] = pcr;
        y[column(t, 1, CT)] = tcr;
        if t == 0 {
            checks["givWater_kg"] = json!({"prepared": mw, "prose": 250.594779, "relative": (mw - 250.594779) / 250.594779,
                "mouthTemperature_K": temperature_ph(Branch::Liquid, pm, hm)});
            checks["recircAir_kg"] =
                json!({"prepared": ma, "prose": 0.223160, "relative": (ma - 0.223160) / 0.223160});
        }
    }
    // ADS chambers: saturated vapor at the prepared PZR roof pressure.
    let [(_, _), (vap, _)] = saturation_caloric(p.roof_p, 0.).unwrap();
    for j in 0..6 {
        let s = state(Branch::Vapor, c(p.roof_p), c(vap.temperature_k)).unwrap();
        let mw = s.rho.v * p.chamber_v;
        y[chamber(j, 0)] = mw;
        y[chamber(j, 3)] = mw * (s.u.v + G * p.chamber_z);
        y[chamber(j, 5)] = p.roof_p;
        y[chamber(j, 6)] = vap.temperature_k;
    }
    let mut modes = Modes {
        locked: vec![[false, true]; 2 * NPATH],
        acc_locked: [true; 2],
        vent_locked: [true; 2],
        src_locked: [[true; 2]; 2],
        term_locked: [[true; 2]; 2],
        e_cells: vec![false; 2 * NCELL],
    };
    if cap.is_some() {
        for t in 0..2 {
            modes.e_cells[t * NCELL + 5] = true;
        }
    }
    for t in 0..2 {
        modes.locked[t * NPATH + 9][0] = true; // tank->OUT: isolations closed
        modes.locked[t * NPATH + 10][0] = true; // OUT->DVI: check seated
    }
    // Ring flows: the algebraic law at the prepared pressures.
    let yd: Vec<D> = y.iter().map(|&v| c(v)).collect();
    let zero = vec![c(0.); N];
    let e = residual(&yd, &zero, &modes, &inp, p).expect("prepared residual");
    for t in 0..2 {
        for j in 0..3 {
            let i = ring(t, j, 0);
            y[i] -= e.f[i].v;
        }
    }
    Prepared {
        y,
        modes,
        inputs: inp,
        checks,
    }
}

/// Consistent rates: for every differential row of the form y' − g(y), y' = g(y).
fn consistent(y: &[f64], m: &Modes, inp: &Inputs, p: &Prm) -> Vec<f64> {
    let yd: Vec<D> = y.iter().map(|&v| c(v)).collect();
    let mut yp = vec![0.; N];
    // The ACC energy rows carry p_I A z_I'; z_I' follows from the closure rows at fixed stocks
    // (only the outlet changes M_l, and the gas store is closed): two passes settle it exactly.
    for _ in 0..3 {
        let ypd: Vec<D> = yp.iter().map(|&v| c(v)).collect();
        let e = residual(&yd, &ypd, m, inp, p).unwrap();
        for i in 0..N {
            if is_differential(i, m) {
                yp[i] -= e.f[i].v;
            }
        }
        // z_I' from the liquid volume change: dV_l = d(M_l/rho) at fixed T_l and p_I (one-point).
        for t in 0..2 {
            let rho = state(Branch::Liquid, c(y[acc(t, API)]), c(y[acc(t, ATL)]))
                .unwrap()
                .rho
                .v;
            yp[acc(t, AZI)] = yp[acc(t, AML)] / (rho * num(&p.acc, "/area_m2"));
        }
    }
    yp
}
/// Actual classification in the evaluated modes: a locked path's Π row is algebraic.
fn is_differential(i: usize, m: &Modes) -> bool {
    if i < U_CHAMBERS {
        let t = i / PER_TRAIN;
        let r = i % PER_TRAIN;
        if (T_PATHS..T_RINGS).contains(&r) {
            let j = (r - T_PATHS) / 2;
            let phase = (r - T_PATHS) % 2;
            return !m.locked[t * NPATH + j][phase];
        }
        if r < T_NC && m.e_cells[t * NCELL + r / CELL_SLOTS] && matches!(r % CELL_SLOTS, 3 | 4) {
            return false;
        }
        if r >= T_COL {
            let j = (r - T_COL) / 11;
            let s = (r - T_COL) % 11;
            if s == CSRC || s == CSRC + 1 {
                return s == CSRC && !m.src_locked[t][j];
            }
            if s == CTERM || s == CTERM + 1 {
                return s == CTERM && !m.term_locked[t][j];
            }
        }
    }
    declared_differential(i)
}

/// The C06 port states for the cap probe: COLD tap and DOWNCOMER at 7 MPa, 550 K.
fn cap_inputs(p: &Prm) -> Inputs {
    let mut inp = prepared_inputs(p);
    let h = state(Branch::Liquid, c(7e6), c(550.)).unwrap().h.v;
    inp.tap_p = 7e6;
    inp.dc_p = 7e6;
    inp.tap_h = h;
    inp.dc_h = h;
    inp
}
/// Probe P1: CMT delivering at 20 kg/s through BAL, tank and outlet (stems open).
fn probe_cmt(base: &Prepared, p: &Prm) -> Prepared {
    let mut s = Prepared {
        y: base.y.clone(),
        modes: base.modes.clone(),
        inputs: base.inputs.clone(),
        checks: json!({}),
    };
    s.inputs.x_out = 1.;
    for t in 0..2 {
        s.modes.locked[t * NPATH + 9][0] = false;
        s.modes.locked[t * NPATH + 10][0] = false;
        for j in 0..NPATH - 1 {
            let q = &p.paths[j];
            // Down the tank (L(k+1) -> Lk is negative in from->to orientation), forward elsewhere.
            let m = if j < 5 { -20. } else { 20. };
            s.y[path(t, j, 0)] = m * q.inertance;
        }
    }
    s
}
/// Probe P2: ACC injecting into a DVI at 4.9 MPa, 500 K (and the DOWNCOMER with it).
fn probe_acc(base: &Prepared, p: &Prm) -> Prepared {
    let mut s = Prepared {
        y: base.y.clone(),
        modes: base.modes.clone(),
        inputs: base.inputs.clone(),
        checks: json!({}),
    };
    let st = state(Branch::Liquid, c(4.9e6), c(500.)).unwrap();
    s.inputs.dc_p = 4.9e6;
    s.inputs.dc_h = st.h.v;
    for t in 0..2 {
        set_cell(&mut s.y, cell(t, DVI, 0), p.dvi.v, 4.9e6, 500., p.tracer);
        s.modes.acc_locked[t] = false;
    }
    resolve_links(&mut s, p);
    s
}
/// Probe P3: GIV delivering into a DVI at 0.15 MPa, 350 K; the column 5 kPa below its prepared pressure.
fn probe_giv(base: &Prepared, p: &Prm) -> Prepared {
    let mut s = Prepared {
        y: base.y.clone(),
        modes: base.modes.clone(),
        inputs: base.inputs.clone(),
        checks: json!({}),
    };
    let st = state(Branch::Liquid, c(1.5e5), c(350.)).unwrap();
    s.inputs.dc_p = 1.5e5;
    s.inputs.dc_h = st.h.v;
    s.inputs.x_src = [1., 0.];
    for t in 0..2 {
        set_cell(&mut s.y, cell(t, DVI, 0), p.dvi.v, 1.5e5, 350., p.tracer);
        let col = &p.columns[0];
        let (v, zc) = (num(col, "/volume_m3"), num(col, "/centroid_m"));
        let pc = s.y[column(t, 0, CP)] - 5000.;
        let tc = s.y[column(t, 0, CT)];
        let w = state(Branch::Liquid, c(pc), c(tc)).unwrap();
        let mw = w.rho.v * v;
        s.y[column(t, 0, CMW)] = mw;
        s.y[column(t, 0, CE)] = mw * (w.u.v + G * zc);
        s.y[column(t, 0, CB)] = mw * num(&p.packet, "/gravity/columns/0/fill/tracer_kg_kg");
        s.y[column(t, 0, CP)] = pc;
        s.modes.src_locked[t][0] = false;
        s.modes.term_locked[t][0] = false;
        // Path impulses (S4-D13) for 30 kg/s through the source and the terminal.
        let ab = std::f64::consts::PI * num(col, "/bore_m").powi(2) / 4.;
        let inertance = num(col, "/length_m") / 2. / ab;
        s.y[column(t, 0, CSRC)] = 30. * inertance;
        s.y[column(t, 0, CTERM)] = 30. * inertance;
    }
    resolve_links(&mut s, p);
    s
}
/// Algebraic flow coordinates from their laws at the state (rows y − law).
fn resolve_links(s: &mut Prepared, p: &Prm) {
    let zero = vec![c(0.); N];
    for _ in 0..2 {
        let yd: Vec<D> = s.y.iter().map(|&v| c(v)).collect();
        let e = residual(&yd, &zero, &s.modes, &s.inputs, p).unwrap();
        for t in 0..2 {
            for i in [
                ring(t, 0, 0),
                ring(t, 1, 0),
                ring(t, 2, 0),
                t * PER_TRAIN + T_ACC_OUT,
            ] {
                s.y[i] -= e.f[i].v;
            }
        }
    }
}

// ---------------------------------------------------------------- the checks
fn duals(y: &[f64]) -> Vec<D> {
    y.iter().map(|&v| c(v)).collect()
}
fn eval_f(y: &[f64], yp: &[f64], s: &Prepared, inp: &Inputs, p: &Prm) -> Vec<f64> {
    residual(&duals(y), &duals(yp), &s.modes, inp, p)
        .unwrap()
        .f
        .iter()
        .map(|d| d.v)
        .collect()
}
fn row_scale(i: usize, y: &[f64], p: &Prm) -> f64 {
    if i < U_CHAMBERS {
        let t = i / PER_TRAIN;
        let r = i % PER_TRAIN;
        if r < T_NC {
            let k = r / CELL_SLOTS;
            let i0 = cell(t, k, 0);
            return match r % CELL_SLOTS {
                0 => [
                    p.layers.iter().map(|l| l.v).collect::<Vec<_>>(),
                    p.bal.iter().map(|l| l.v).collect(),
                    vec![p.out.v, p.dvi.v],
                ]
                .concat()[k],
                1 => y[i0 + 1],
                2 | 3 | 4 => y[i0 + 2].abs() + y[i0 + 1] * G * 20.,
                _ => y[i0 + 5],
            };
        }
        if r < T_PATHS {
            return 1.;
        }
        if r < T_RINGS {
            let j = (r - T_PATHS) / 2;
            let q = &p.paths[j];
            return if q.from < NCELL {
                y[cell(t, q.from, 0)]
            } else {
                p.cold_p
            };
        }
        if r < T_ACC {
            return 25.;
        }
        if r < T_ACC_OUT {
            let s = r - T_ACC;
            let mn = y[acc(t, AMN)];
            return match s {
                AML | API => y[acc(t, AML)],
                AB => y[acc(t, AB)],
                AEL | ATL => y[acc(t, AEL)].abs(),
                AMN | AMA | AMV => mn,
                AZI => y[acc(t, API)] * 15.,
                _ => y[acc(t, AEG)].abs().max(mn * 742. * 298.15),
            };
        }
        if r < T_COL {
            return 100.;
        }
        let j = (r - T_COL) / 11;
        let s = (r - T_COL) % 11;
        let mass = y[column(t, j, CMW)].max(y[column(t, j, CMA)]);
        return match s {
            CMW | CMA | CMN | CB | CP => mass,
            CE | CT => y[column(t, j, CE)].abs().max(mass * 1e5),
            // Path rows (S4-D13): pressure balances at the column's pressure.
            _ => y[column(t, j, CP)],
        };
    }
    if i < U_DEVICES {
        let j = (i - U_CHAMBERS) / 7;
        return match (i - U_CHAMBERS) % 7 {
            3 | 6 => y[chamber(j, 3)].abs(),
            _ => y[chamber(j, 0)],
        };
    }
    1.
}
/// Column scales: stock slots by their own row's stock magnitude, so that a
/// differential row's dF/dy' entry scales to cj; pressures, temperatures,
/// heights, impulses (25 kg/s x inertance) and flows by their own magnitudes.
fn col_scale(i: usize, y: &[f64], p: &Prm) -> f64 {
    if i < U_CHAMBERS {
        let t = i / PER_TRAIN;
        let r = i % PER_TRAIN;
        if r < T_NC {
            return if r % CELL_SLOTS == 0 {
                y[i]
            } else {
                row_scale(i, y, p)
            };
        }
        if r < T_PATHS {
            return 1.;
        }
        if r < T_RINGS {
            return 25. * p.paths[(r - T_PATHS) / 2].inertance;
        }
        if r < T_ACC {
            return 25.;
        }
        if r < T_ACC_OUT {
            return match r - T_ACC {
                API => y[acc(t, API)],
                AZI => 1.,
                ATL | ATG => 300.,
                _ => row_scale(i, y, p),
            };
        }
        if r < T_COL {
            return 100.;
        }
        let j = (r - T_COL) / 11;
        return match (r - T_COL) % 11 {
            CP => y[column(t, j, CP)],
            CT => 300.,
            // Path impulses: 60 kg/s (the sizing flow) times the half-column inertance.
            CSRC.. => {
                let col = &p.columns[j];
                60. * num(col, "/length_m")
                    / 2.
                    / (std::f64::consts::PI * num(col, "/bore_m").powi(2) / 4.)
            }
            _ => row_scale(i, y, p),
        };
    }
    if i < U_DEVICES {
        return match (i - U_CHAMBERS) % 7 {
            5 | 6 => y[i],
            _ => row_scale(i, y, p),
        };
    }
    1.
}

/// Dense forward-mode Jacobians dF/dy and dF/dy' (column by column).
fn jacobians(s: &Prepared, yp: &[f64], p: &Prm) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let mut jy = vec![vec![0.; N]; N];
    let mut jp = vec![vec![0.; N]; N];
    for k in 0..N {
        for (which, out) in [(0, &mut jy), (1, &mut jp)] {
            let mut y = duals(&s.y);
            let mut ypd = duals(yp);
            if which == 0 {
                y[k].d = 1.;
            } else {
                ypd[k].d = 1.;
            }
            let e = residual(&y, &ypd, &s.modes, &s.inputs, p).unwrap();
            for i in 0..N {
                out[i][k] = e.f[i].d;
            }
        }
    }
    (jy, jp)
}
/// Forward-mode against differences: central (best of two steps and Richardson), one-sided forward at an upwind kink.
fn compare(s: &Prepared, yp: &[f64], jy: &[Vec<f64>], p: &Prm) -> (f64, usize, String) {
    let (mut worst, mut count, mut at) = (0f64, 0usize, String::new());
    for k in 0..N {
        let kink = name(k).contains("Pi_l")
            && s.y[k] == 0.
            && !s.modes.locked[(k / PER_TRAIN) * NPATH + ((k % PER_TRAIN) - T_PATHS) / 2][0];
        let diff = |h: f64| -> Vec<f64> {
            let mut a = s.y.clone();
            let mut b = s.y.clone();
            a[k] += h;
            if kink {
                let fa = eval_f(&a, yp, s, &s.inputs, p);
                let fb = eval_f(&b, yp, s, &s.inputs, p);
                return fa.iter().zip(&fb).map(|(x, y)| (x - y) / h).collect();
            }
            b[k] -= h;
            let fa = eval_f(&a, yp, s, &s.inputs, p);
            let fb = eval_f(&b, yp, s, &s.inputs, p);
            fa.iter()
                .zip(&fb)
                .map(|(x, y)| (x - y) / (2. * h))
                .collect()
        };
        let scale = col_scale(k, &s.y, p);
        // Steps: pressures enter through differences of ~1e7 Pa values, so the
        // candidate set reaches down to 1e-9 of the column scale.
        let steps = [1e-3, 1e-4, 1e-5, 1e-7, 1e-9];
        let ds: Vec<Vec<f64>> = steps.iter().map(|&h| diff(h * scale)).collect();
        let halves: Vec<Vec<f64>> = steps.iter().map(|&h| diff(2. * h * scale)).collect();
        for i in 0..N {
            let a = jy[i][k];
            let rs = row_scale(i, &s.y, p);
            let mag = a.abs().max(ds[0][i].abs()) * scale / rs;
            if mag < 1e-11 {
                continue;
            }
            count += 1;
            let mut candidates = Vec::new();
            for (d, d2) in ds.iter().zip(&halves) {
                candidates.push(d[i]);
                // Central: (4 d(h) - d(2h))/3; forward at a kink: 2 d(h) - d(2h).
                candidates.push(if kink {
                    2. * d[i] - d2[i]
                } else {
                    (4. * d[i] - d2[i]) / 3.
                });
            }
            let err = candidates
                .iter()
                .map(|fd| (a - fd).abs() / a.abs().max(fd.abs()))
                .fold(f64::INFINITY, f64::min);
            if err > worst {
                worst = err;
                at = format!("d {} / d {}", name(i), name(k));
            }
        }
    }
    (worst, count, at)
}
fn min_pivot(jy: &[Vec<f64>], jp: &[Vec<f64>], cj: f64, s: &Prepared, p: &Prm) -> f64 {
    let mut a: Vec<Vec<f64>> = (0..N)
        .map(|i| {
            (0..N)
                .map(|k| (jy[i][k] + cj * jp[i][k]) * col_scale(k, &s.y, p) / row_scale(i, &s.y, p))
                .collect()
        })
        .collect();
    let mut least = f64::INFINITY;
    for col in 0..N {
        let piv = (col..N)
            .max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))
            .unwrap();
        a.swap(col, piv);
        let v = a[col][col];
        least = least.min(v.abs());
        if v == 0. {
            return 0.;
        }
        for r in col + 1..N {
            let f = a[r][col] / v;
            if f != 0. {
                for k in col..N {
                    a[r][k] -= f * a[col][k];
                }
            }
        }
    }
    least
}

struct Change {
    label: &'static str,
    apply: fn(&mut Inputs),
    rows: Vec<(usize, i32)>,
}
fn direction(s: &Prepared, yp: &[f64], p: &Prm, ch: &Change) -> Vec<Value> {
    let base = eval_f(&s.y, yp, s, &s.inputs, p);
    let mut inp = s.inputs.clone();
    (ch.apply)(&mut inp);
    let moved = eval_f(&s.y, yp, s, &inp, p);
    ch.rows
        .iter()
        .map(|&(i, sign)| {
            // Rows are `slot − expression`: the implied change of the expression is −ΔF.
            let delta = -(moved[i] - base[i]);
            let ok = match sign {
                0 => delta == 0.,
                1 => delta > 0.,
                _ => delta < 0.,
            };
            assert!(
                ok,
                "{}: {} moved {delta:e}, declared sign {sign}",
                ch.label,
                name(i)
            );
            json!({"input": ch.label, "row": name(i), "declared": sign, "delta": delta})
        })
        .collect()
}

fn provenance(var: &str) -> Value {
    let path = std::env::var(var).unwrap_or_default();
    let bytes = std::fs::read(&path).unwrap_or_default();
    json!({"path": path, "bytes": bytes.len(), "sha256": sha256_hex(&bytes)})
}
/// SHA-256 (FIPS 180-4) for the receipt's packet identity; test-only.
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[test]
#[ignore = "G1-C11 design prototype: needs LD01_G1_C11_PACKET"]
fn g1_c11_sources_zero_time() {
    let (p, packet) = load();
    // Census (declared classification).
    let differential = (0..N).filter(|&i| declared_differential(i)).count();
    let algebraic = N - differential;
    println!("census: {differential} differential + {algebraic} algebraic = {N}");

    // Sizing reproductions: the allocation's laws give the owners' cited losses.
    let area = std::f64::consts::PI * 0.2 * 0.2 / 4.;
    let cold = state(Branch::Liquid, c(15.2e6), c(313.15)).unwrap();
    let m25 = c(25.);
    let o = &packet["cmt"]["outlet"];
    let pipe = darcy_loss(
        m25,
        cold.rho,
        cold.mu,
        num(o, "/cell/length_m"),
        0.2,
        area,
        num(o, "/roughness_m"),
    )
    .v;
    let reproduce = |k: f64, m: f64, rho: f64| heads(k, c(m), c(rho), area).v;
    let hot = state(Branch::Liquid, c(15.2e6), c(563.15)).unwrap();
    let neck_rho = p.cold_density;
    let rep = json!({
        "outletPipe_Pa": [pipe, num(o, "/losses_Pa/pipe")],
        "outletMeter_Pa": [reproduce(k_of(num(o, "/meter/area_m2"), area), 25., cold.rho.v), num(o, "/losses_Pa/meter")],
        "outletCheck_Pa": [reproduce(k_of(num(o, "/check/area_m2"), area), 25., cold.rho.v), num(o, "/losses_Pa/openCheck")],
        "outletDischarge_Pa": [reproduce(1., 25., cold.rho.v), num(o, "/losses_Pa/discharge")],
        "outletIsolations_Pa": [reproduce(k_of(num(o, "/isolation/area_m2"), area), 25., cold.rho.v), num(o, "/losses_Pa/isolation")],
        "balIsolation_Pa": [reproduce(k_of(num(&packet, "/cmt/balance/isolation/area_m2"), area), 25., hot.rho.v), num(&packet, "/cmt/balance/isolation/referenceLoss_Pa")],
        "neckSideEntry_Pa": [reproduce(1., 100., neck_rho), num(&packet, "/dvi/neck/sideEntryLoss_Pa")],
        "neckForm_Pa": [reproduce(num(&packet, "/dvi/neck/formVelocityHeads"), 100., neck_rho), num(&packet, "/dvi/neck/formLoss_Pa")],
        "neckMeter_Pa": [reproduce(k_of(num(&packet, "/dvi/neck/meterArea_m2"), area), 100., neck_rho), num(&packet, "/dvi/neck/meterLoss_Pa")],
        "accVariableArea_m2": [100. / (2. * state(Branch::Liquid, c(5e6), c(298.15)).unwrap().rho.v * 9e5 + (100f64 / area).powi(2)).sqrt(), num(&packet, "/acc/outlet/variableArea_m2")],
        "accMeterArea_m2": [100. / (2. * state(Branch::Liquid, c(4.1e6), c(298.15)).unwrap().rho.v * 1e5 + (100f64 / area).powi(2)).sqrt(), num(&packet, "/acc/outlet/meterArea_m2")],
    });
    let mut reproductions = serde_json::Map::new();
    for (k, v) in rep.as_object().unwrap() {
        let (a, b) = (v[0].as_f64().unwrap(), v[1].as_f64().unwrap());
        reproductions.insert(
            k.clone(),
            json!({"allocation": a, "owner": b, "relative": (a - b) / b}),
        );
        println!("reproduce {k}: {a} vs {b} ({:+.2e})", (a - b) / b);
    }

    let base = prepare(&p);
    let states: Vec<(&str, Prepared)> = vec![
        (
            "prepared",
            Prepared {
                y: base.y.clone(),
                modes: base.modes.clone(),
                inputs: base.inputs.clone(),
                checks: base.checks.clone(),
            },
        ),
        ("P1 CMT delivering", probe_cmt(&base, &p)),
        ("P2 ACC injecting", probe_acc(&base, &p)),
        ("P3 GIV delivering", probe_giv(&base, &p)),
        // P4: the receiving layer L6 in mode E with a 0.01 m3 steam cap above covered rings (S3-D-P1, C11-D2).
        (
            "P4 receiving layer E",
            prepare_with(&p, cap_inputs(&p), Some(0.01)),
        ),
    ];
    let mut pattern = vec![vec![false; N]; N];
    let mut report = Vec::new();
    let mut directions = Vec::new();
    for (label, s) in &states {
        let yp = consistent(&s.y, &s.modes, &s.inputs, &p);
        let f = eval_f(&s.y, &yp, s, &s.inputs, &p);
        let (mut worst, mut at) = (0f64, 0usize);
        for i in 0..N {
            let r = f[i].abs() / row_scale(i, &s.y, &p);
            if r > worst {
                worst = r;
                at = i;
            }
        }
        let (jy, jp) = jacobians(s, &yp, &p);
        for i in 0..N {
            for k in 0..N {
                if jy[i][k] != 0. || jp[i][k] != 0. {
                    pattern[i][k] = true;
                }
            }
        }
        let (err, entries, where_) = compare(s, &yp, &jy, &p);
        let pivots: Vec<f64> = [1e1, 1e3, 1e5]
            .iter()
            .map(|&cj| min_pivot(&jy, &jp, cj, s, &p))
            .collect();
        println!(
            "{label}: scaled residual {worst:.2e} at {}; partials {err:.2e} over {entries} ({where_}); pivots {pivots:?}",
            name(at)
        );
        report.push(json!({"state": label, "scaledResidual": worst, "at": name(at), "partials": {"maxRelative": err, "entries": entries, "at": where_},
            "minScaledPivot": {"cj1e1": pivots[0], "cj1e3": pivots[1], "cj1e5": pivots[2]}}));
        assert!(
            worst <= 1e-12,
            "{label}: scaled residual {worst:e} at {}",
            name(at)
        );
        assert!(err <= 1e-6, "{label}: partials {err:e} at {where_}");
        assert!(
            pivots.iter().all(|&v| v > 0.),
            "{label}: singular iteration matrix"
        );
        // Directions.
        let changes: Vec<Change> = match *label {
            "prepared" => vec![
                Change {
                    label: "+COLD tap pressure",
                    apply: |i| i.tap_p += 100.,
                    rows: vec![(path(0, 5, 0), 1), (path(1, 5, 0), 1)],
                },
                Change {
                    label: "+COLD tap enthalpy (zero flow)",
                    apply: |i| i.tap_h += 100.,
                    rows: vec![(path(0, 5, 0), 0), (cell(0, RUN, 2), 0)],
                },
                Change {
                    label: "+DOWNCOMER pressure",
                    apply: |i| i.dc_p += 100.,
                    rows: vec![(path(0, 11, 0), -1), (path(1, 11, 0), -1)],
                },
                Change {
                    label: "+WST surface (GIV source closed)",
                    apply: |i| i.wst_surface += 0.01,
                    rows: vec![(column(0, 0, CSRC), 0)],
                },
                Change {
                    label: "+PZR roof pressure (ADS closed)",
                    apply: |i| i.roof_p += 1000.,
                    rows: vec![(U_DEVICES, 0), (chamber(0, 0), 0)],
                },
            ],
            "P1 CMT delivering" => vec![
                Change {
                    label: "CMT outlet stem closing",
                    apply: |i| i.x_out -= 0.01,
                    rows: vec![(path(0, 9, 0), -1), (path(1, 9, 0), -1)],
                },
                Change {
                    label: "BAL stem closing",
                    apply: |i| i.x_bal -= 0.01,
                    rows: vec![(path(0, 5, 0), -1)],
                },
                Change {
                    label: "+COLD tap pressure",
                    apply: |i| i.tap_p += 100.,
                    rows: vec![(path(0, 5, 0), 1)],
                },
                Change {
                    label: "+COLD tap enthalpy",
                    apply: |i| i.tap_h += 100.,
                    rows: vec![(cell(0, RUN, 2), 1)],
                },
                Change {
                    label: "+DOWNCOMER pressure",
                    apply: |i| i.dc_p += 100.,
                    rows: vec![(path(0, 11, 0), -1)],
                },
            ],
            "P4 receiving layer E" => vec![
                Change {
                    label: "+COLD tap pressure",
                    apply: |i| i.tap_p += 100.,
                    rows: vec![(path(0, 5, 0), 1)],
                },
                Change {
                    label: "+DOWNCOMER pressure",
                    apply: |i| i.dc_p += 100.,
                    rows: vec![(path(0, 11, 0), -1)],
                },
            ],
            "P2 ACC injecting" => vec![
                Change {
                    label: "ACC stem closing",
                    apply: |i| i.x_acc -= 0.01,
                    rows: vec![(T_ACC_OUT, -1), (PER_TRAIN + T_ACC_OUT, -1)],
                },
                Change {
                    label: "+DOWNCOMER pressure",
                    apply: |i| i.dc_p += 100.,
                    rows: vec![(path(0, 11, 0), -1)],
                },
            ],
            _ => vec![
                Change {
                    label: "+WST surface",
                    apply: |i| i.wst_surface += 0.01,
                    rows: vec![(column(0, 0, CSRC), 1), (column(1, 0, CSRC), 1)],
                },
                Change {
                    label: "+CNV pressure",
                    apply: |i| i.cnv_p += 100.,
                    rows: vec![(column(0, 0, CSRC), 1)],
                },
                Change {
                    label: "+WST temperature",
                    apply: |i| i.wst_t += 0.5,
                    rows: vec![(column(0, 0, CSRC), -1)],
                },
                Change {
                    label: "GIV source stem closing",
                    apply: |i| i.x_src[0] -= 0.01,
                    rows: vec![(column(0, 0, CSRC), -1)],
                },
            ],
        };
        for ch in &changes {
            directions.extend(direction(s, &yp, &p, ch));
        }
    }
    // The located birth is exact (S3-D-P1): a saturated L6 in mode L and the same stocks
    // in mode E with M_g = U_g = 0 give the same rows; the E rows hold at the birth.
    let born = prepare_with(&p, cap_inputs(&p), Some(0.));
    let mut liquid = Prepared {
        y: born.y.clone(),
        modes: born.modes.clone(),
        inputs: born.inputs.clone(),
        checks: json!({}),
    };
    for t in 0..2 {
        liquid.modes.e_cells[t * NCELL + 5] = false;
    }
    let yp_l = consistent(&liquid.y, &liquid.modes, &liquid.inputs, &p);
    let f_e = eval_f(&born.y, &yp_l, &born, &born.inputs, &p);
    let f_l = eval_f(&liquid.y, &yp_l, &liquid, &liquid.inputs, &p);
    let (mut same, mut e_rows) = (0f64, 0f64);
    for i in 0..N {
        let r = row_scale(i, &born.y, &p);
        let e_slot = i < U_CHAMBERS
            && (i % PER_TRAIN) < T_NC
            && (i % PER_TRAIN) / CELL_SLOTS == 5
            && matches!((i % PER_TRAIN) % CELL_SLOTS, 3 | 4);
        if e_slot {
            e_rows = e_rows.max(f_e[i].abs() / r);
        } else {
            same = same.max((f_e[i] - f_l[i]).abs() / r);
        }
    }
    println!(
        "birth transaction: rows unchanged to {same:.2e}; E split/definition rows at the birth {e_rows:.2e}"
    );
    assert!(
        same <= 1e-12 && e_rows <= 1e-12,
        "birth transaction not exact"
    );
    let birth = json!({"rowsUnchanged": same, "equilibriumRowsAtBirth": e_rows, "layer": "L6", "pressure_Pa": born.y[cell(0, 5, 0)]});
    let nnz = pattern
        .iter()
        .map(|r| r.iter().filter(|&&b| b).count())
        .sum::<usize>();
    println!(
        "structural nnz (union over states): {nnz}; directions {}",
        directions.len()
    );

    // Cost: one residual and one dense Jacobian at the prepared state.
    cpu::prefer_performance_core();
    let s0 = &states[0].1;
    let yp0 = consistent(&s0.y, &s0.modes, &s0.inputs, &p);
    let reps = 50;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        let _ = eval_f(&s0.y, &yp0, s0, &s0.inputs, &p);
    }
    let residual_s = (cpu::thread_cpu_s() - t0) / reps as f64;
    let t1 = cpu::thread_cpu_s();
    let _ = jacobians(s0, &yp0, &p);
    let jacobian_s = cpu::thread_cpu_s() - t1;
    println!(
        "cost: residual {residual_s:.3e} s, dense Jacobian {jacobian_s:.3e} s (2N forward sweeps)"
    );

    let receipt = json!({
        "lane": "g1-c11", "prototype": "g1_c11_sources", "kind": "test-only standalone block, never joined, never a gate",
        "census": {"differential": differential, "algebraic": algebraic, "total": N, "structuralNnz": nnz},
        "preparedChecks": base.checks, "birthTransaction": birth, "reproductions": reproductions, "states": report, "directions": directions,
        "cost": {"residual_s": residual_s, "denseJacobian_s": jacobian_s, "sweeps": 2 * N, "loadAverage": cpu::load_average()},
        "provenance": {"packet": provenance("LD01_G1_C11_PACKET"), "waterLibrary": std::env::var("LD01_OPERATING_WATER_LIB_DIR").unwrap_or_default(),
            "appCommit": std::env::var("LD01_G1_C11_APP_COMMIT").unwrap_or_default(), "wikiCommit": std::env::var("LD01_G1_C11_WIKI_COMMIT").unwrap_or_default()},
    });
    if let Ok(out) = std::env::var("LD01_G1_C11_RECEIPT") {
        assert!(
            !std::path::Path::new(&out).exists(),
            "receipts are never overwritten: {out}"
        );
        std::fs::write(&out, serde_json::to_string_pretty(&receipt).unwrap()).unwrap();
        println!("receipt {out}");
    }
}

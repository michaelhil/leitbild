//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/injection-and-depressurization.md#compact-operating-allocation-15-october-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/residual-heat-exchanger.md#selected-ordinary-liquid-transport-and-thermal-contacts
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/residual-heat-exchanger.md#finite-region-thermal-and-material-mixing
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/residual-heat-exchanger.md#phase-and-exposure-contact-continuation
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/residual-heat-exchanger.md#frozen-reduced-thermal-comparison
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/residual-heat-exchanger.md#selected-independent-thermal-preparations
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-fluid-model.md#cold-prhr-operating-join
//! G1-C11 Gate-1 design prototype for the PRHR part of C11 (decision C11-D6):
//! a TEST-ONLY standalone block (the ELEC-slice pattern: own rows, dense
//! forward-mode partials). It is never joined to the unit, never integrated
//! and never a gate. It reads the compiled passive packet
//! (`LD01_G1_C11_PACKET`, from `apps/world/scripts/reference-design-operating-passive.ts`,
//! sections `prhr` and `boundary`) and checks, at the prepared state (bank at
//! `preparedBank_K`, closed seat) and at two declared probes (open seat x=1
//! at prepared temperatures; a warmer bank below nucleate onset at x=0.5):
//! - the census and the structural nnz (union of dF/dy and dF/dy' patterns);
//! - the scaled zero-time residual (≤ 1e-12) with consistent y';
//! - the declared direction of every port input on its receiving rows;
//! - forward-mode partials (IF97 exact rho/u/h directions; the boundary's
//!   disclosed coefficient probes for mu, k, cp, alpha) against central
//!   differences (1e-6 relative), one-sided at a kink;
//! - the iteration matrix `dF/dy + cj dF/dy'` nonsingular for cj 1e1..1e5;
//! - the CPU cost of one residual and one dense Jacobian.
//!
//! Owners and coordinates (S3 conventions, the cold-join partition):
//! - 19 water regions, S3 regular cells `p | M_l, U_l, M_g, U_g, B`, mode L
//!   (vapor slots zero, rows `M_g' = 0`, `U_g' = 0`): EOS row
//!   `M_l v(p, U_l/M_l) - V = 0`; stored energy `U + M g z_cell`; faces carry
//!   the donor's `h + g z_donor`;
//! - 38 steel stores (36 radial halves/shells + 2 disc halves), `U = C T`
//!   (caloric zero at 0 K);
//! - 20 non-seat links, S3 phase paths: `Pi_l = I m` with `I = sum L/A`,
//!   row `Pi_l' = drive - loss` (drive: each side's static pressure
//!   reconstructed with its own density to the junction elevation
//!   `(z_from + z_to)/2`; loss: per-segment Churchill all-regime Darcy at the
//!   actual Re plus `K m|m|/(2 rho A^2)`, upwind donor); `Pi_g` locked (L1:
//!   row `Pi_g = 0`, no transport);
//! - the seat (S3-D25 pattern): closed, L1 lock rows `m_l = 0`, `m_g = 0` and
//!   no transport; open, `drive = (valveK/x^2) m|m|/(2 rho A^2) + segment
//!   friction` as an algebraic row in `m_l`;
//! - 35 ADDED algebraic surface temperatures (19 water-to-steel inner
//!   contacts, 2 disc faces, 14 pool contacts): the selected series law
//!   "solve the shared surface temperature/heat", row
//!   `T_s - T_center -/+ R_half q(T_s) = 0`.
//!
//! Laws: INL primary film `max(3.66, natural, Gnielinski)` (signed heat);
//! Churchill–Chu horizontal cylinder times `bankFactor` outside (signed;
//! film at `(T_pool + min(T_s, T_sat))/2`); nucleate onset (INL, 38°) is a
//! ROOT (`T_onb - T_s`), refused if reached (boiling branch not
//! implemented); radial, disc and shell conduction; connector exterior
//! through 100 mm insulation to a held containment environment; molecular
//! axial conduction on the non-mixing links (seat area times x); return
//! scalar mixing on the three return faces including the SG-outlet end.
//! HOT.A.after, SG.A.PRIMARY.outlet, WST and CNV are held ports.
// Test-only dense-matrix loops and fixed owner tables.
#![cfg(any(target_os = "macos", target_os = "linux"))]
#![allow(
    clippy::too_many_arguments,
    clippy::needless_range_loop,
    clippy::type_complexity
)]
use leitbild_operating_water::{
    Branch, WaterPoint, directional, directional_pu, point, saturation_caloric, surface_tension,
};
use serde_json::{Value, json};
use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

mod common;
use common::cpu;

/// Standard gravity of the network and of the PRHR owners' checkers.
const G: f64 = 9.80665;
/// Partials classification only: a film contact whose |contrast| is below
/// this sits on its zero-contrast cusp (|dT|^(1/4), ^(1/3), ^(1/6) Nusselt
/// branches), where a finite secant is not the derivative (cold join).
const CUSP_K: f64 = 1e-6;

// ---------------------------------------------------------------- dual numbers
#[derive(Clone, Copy, Debug, PartialEq)]
struct D {
    v: f64,
    d: f64,
}
impl D {
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
    fn powf(self, e: f64) -> Self {
        let d = if self.d == 0. {
            0.
        } else {
            e * self.v.powf(e - 1.) * self.d
        };
        Self::new(self.v.powf(e), d)
    }
    fn powi(self, n: i32) -> Self {
        let d = if self.d == 0. {
            0.
        } else {
            n as f64 * self.v.powi(n - 1) * self.d
        };
        Self::new(self.v.powi(n), d)
    }
    /// Larger by value; a tie keeps `self` (the native's strict `>`).
    fn max(self, o: D) -> D {
        if o.v > self.v { o } else { self }
    }
    fn min(self, o: D) -> D {
        if o.v < self.v { o } else { self }
    }
    /// Positive part with the inactive zero selected at exactly zero.
    fn pos(self) -> D {
        if self.v > 0. { self } else { c(0.) }
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
impl AddAssign for D {
    fn add_assign(&mut self, o: D) {
        *self = *self + o;
    }
}
impl SubAssign for D {
    fn sub_assign(&mut self, o: D) {
        *self = *self - o;
    }
}
fn c(v: f64) -> D {
    D::new(v, 0.)
}
/// A row sum and the sum of its terms' magnitudes (the difference-quotient
/// roundoff bound of the partials check; never part of a residual value).
#[derive(Clone, Copy, Debug)]
struct Acc {
    v: D,
    a: f64,
}
impl AddAssign<D> for Acc {
    fn add_assign(&mut self, o: D) {
        self.v += o;
        self.a += o.v.abs();
    }
}
impl SubAssign<D> for Acc {
    fn sub_assign(&mut self, o: D) {
        self.v -= o;
        self.a += o.v.abs();
    }
}
fn acc() -> Acc {
    Acc { v: c(0.), a: 0. }
}

// ------------------------------------------------- the single property boundary
/// Liquid state with every field's direction: rho/u/h exact, mu/k/cp/alpha by
/// the boundary's disclosed same-branch coefficient probes.
#[derive(Clone, Copy, Debug)]
struct Water {
    t: D,
    rho: D,
    h: D,
    mu: D,
    k: D,
    cp: D,
    beta: D,
}
fn water(q: WaterPoint, d: WaterPoint) -> Water {
    Water {
        t: D::new(q.temperature_k, d.temperature_k),
        rho: D::new(q.density_kg_m3, d.density_kg_m3),
        h: D::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
        mu: D::new(q.viscosity_pa_s, d.viscosity_pa_s),
        k: D::new(q.conductivity_w_m_k, d.conductivity_w_m_k),
        cp: D::new(q.cp_j_kg_k, d.cp_j_kg_k),
        beta: D::new(q.expansion_per_k, d.expansion_per_k),
    }
}
/// IF97 liquid at (p, T).
fn liquid(p: D, t: D) -> Water {
    let (q, d) = directional(Branch::Liquid, p.v, t.v, p.d, t.d)
        .unwrap_or_else(|e| panic!("IF97 liquid at {} Pa, {} K: {e}", p.v, t.v));
    water(q, d)
}
/// IF97 liquid at (p, u): the boundary's own caloric inverse and its implicit
/// exact tangent (the S3 regular cell's EOS chart).
fn liquid_pu(p: D, u: D) -> Water {
    let (q, d) = directional_pu(Branch::Liquid, p.v, u.v, p.d, u.d)
        .unwrap_or_else(|e| panic!("IF97 liquid at {} Pa, u {} J/kg: {e}", p.v, u.v));
    water(q, d)
}
/// IF97 saturated-liquid endpoint at p: T_sat, rho_l, h_l, and the vapor's.
fn saturation(p: f64) -> (f64, f64, f64, f64, f64) {
    let [(l, _), (v, _)] =
        saturation_caloric(p, 0.).unwrap_or_else(|e| panic!("IF97 saturation at {p} Pa: {e}"));
    (
        l.temperature_k,
        l.density_kg_m3,
        l.enthalpy_j_kg,
        v.density_kg_m3,
        v.enthalpy_j_kg,
    )
}

// ------------------------------------------------------------------ the packet
fn num(v: &Value, path: &str) -> f64 {
    v.pointer(path)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("packet field {path} missing"))
}
fn arr<'a>(v: &'a Value, path: &str) -> &'a Vec<Value> {
    v.pointer(path)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("packet array {path} missing"))
}
fn text(v: &Value, path: &str) -> String {
    v.pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("packet text {path} missing"))
        .to_string()
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum End {
    Hot,
    Sg,
    Cell(usize),
}
#[derive(Clone, Debug)]
struct Part {
    id: String,
    length: f64,
    bore: f64,
    outside: f64,
    parallel: f64,
    z: f64,
    volume: f64,
    immersed: bool,
}
#[derive(Clone, Debug)]
struct Steel {
    id: String,
    cap: f64,
    r_in: f64,
    r_out: f64,
}
#[derive(Clone, Copy, Debug)]
struct Seg {
    length: f64,
    area: f64,
    bore: f64,
    eps: f64,
    k: f64,
}
#[derive(Clone, Debug)]
struct Link {
    name: String,
    from: End,
    to: End,
    segs: Vec<Seg>,
    inertance: f64,
}
#[derive(Clone, Copy, Debug)]
enum Flow {
    Link(usize),
    Seat,
}
/// One water-to-steel inner contact: film in series with the half cell.
#[derive(Clone, Copy, Debug)]
struct Inner {
    part: usize,
    steel: usize,
    area: f64,
    bore: f64,
    flow_area: f64,
    flow: Flow,
    r: f64,
}
/// One disc face: one surface temperature, its area split between the two
/// cavities by the rotating fractions; each face's area counted once.
#[derive(Clone, Copy, Debug)]
struct Face {
    steel: usize,
    upstream: bool,
}
#[derive(Clone, Copy, Debug)]
struct Pool {
    steel: usize,
    area: f64,
    outside: f64,
    z: f64,
    r: f64,
}
#[derive(Clone, Copy, Debug)]
struct Cond {
    a: usize,
    b: usize,
    g: f64,
}
#[derive(Clone, Copy, Debug)]
struct Axial {
    from: End,
    to: End,
    area: f64,
    separation: f64,
    seat: bool,
}
#[derive(Clone, Copy, Debug)]
struct Mix {
    a: End,
    b: End,
    dx: f64,
    w: f64,
}
const P: usize = 0;
const ML: usize = 1;
const UL: usize = 2;
const MG: usize = 3;
const UG: usize = 4;
const B: usize = 5;
const SLOTS: [&str; 6] = ["p", "M_l", "U_l", "M_g", "U_g", "B"];

struct Model {
    parts: Vec<Part>,
    steel: Vec<Steel>,
    links: Vec<Link>,
    seat: Link,
    up: usize,
    dn: usize,
    inner: Vec<Inner>,
    faces: Vec<Face>,
    pool: Vec<Pool>,
    gas: Vec<Cond>,
    conds: Vec<Cond>,
    axial: Vec<Axial>,
    mix: Vec<Mix>,
    // constants
    z_hot: f64,
    z_sg: f64,
    valve_k: f64,
    seat_area: f64,
    disc_area: f64,
    disc_bore: f64,
    disc_r: f64,
    bank_factor: f64,
    mix_bore: f64,
    mix_area: f64,
    mix_slope: f64,
    mix_coef: f64,
    pr_t: f64,
    sc_t: f64,
    first_exposure: f64,
    bank_k: f64,
    m_ref: f64,
    seat_scale: f64,
    // layout
    nc: usize,
    ns: usize,
    nl: usize,
    n: usize,
}
impl Model {
    fn cell(&self, r: usize, k: usize) -> usize {
        6 * r + k
    }
    fn st(&self, s: usize) -> usize {
        6 * self.nc + s
    }
    fn pil(&self, l: usize) -> usize {
        6 * self.nc + self.ns + 2 * l
    }
    fn pig(&self, l: usize) -> usize {
        self.pil(l) + 1
    }
    fn seat_l(&self) -> usize {
        6 * self.nc + self.ns + 2 * self.nl
    }
    fn seat_g(&self) -> usize {
        self.seat_l() + 1
    }
    fn ts(&self, k: usize) -> usize {
        self.seat_g() + 1 + k
    }
    fn n_surf(&self) -> usize {
        self.inner.len() + self.faces.len() + self.pool.len()
    }
    fn z(&self, e: End) -> f64 {
        match e {
            End::Hot => self.z_hot,
            End::Sg => self.z_sg,
            End::Cell(r) => self.parts[r].z,
        }
    }
    fn end_name(&self, e: End) -> String {
        match e {
            End::Hot => "HOT.A.after".into(),
            End::Sg => "SG.A.PRIMARY.outlet".into(),
            End::Cell(r) => self.parts[r].id.clone(),
        }
    }
    /// Slot census (the compiler's convention: both phase impulses of a path
    /// are differential slots) and the differential ROW in mode L.
    fn slot_differential(&self, i: usize) -> bool {
        if i < 6 * self.nc {
            return i % 6 != P;
        }
        i < self.seat_l()
    }
    fn is_diff(&self, i: usize) -> bool {
        if i >= self.pil(0) && i < self.seat_l() {
            return (i - self.pil(0)).is_multiple_of(2);
        }
        self.slot_differential(i)
    }
    fn name(&self, i: usize) -> String {
        if i < 6 * self.nc {
            return format!("{}.{}", self.parts[i / 6].id, SLOTS[i % 6]);
        }
        if i < self.pil(0) {
            return format!("{}.U", self.steel[i - 6 * self.nc].id);
        }
        if i < self.seat_l() {
            let l = (i - self.pil(0)) / 2;
            let ph = if (i - self.pil(0)).is_multiple_of(2) {
                "l"
            } else {
                "g"
            };
            return format!("{}.Pi_{ph}", self.links[l].name);
        }
        if i == self.seat_l() {
            return "PRHR.SEAT.m_l".into();
        }
        if i == self.seat_g() {
            return "PRHR.SEAT.m_g".into();
        }
        let k = i - self.ts(0);
        let ni = self.inner.len();
        if k < ni {
            format!("{}.Ts", self.steel[self.inner[k].steel].id)
        } else if k < ni + self.faces.len() {
            format!("{}.face.Ts", self.steel[self.faces[k - ni].steel].id)
        } else {
            format!(
                "{}.pool.Ts",
                self.steel[self.pool[k - ni - self.faces.len()].steel].id
            )
        }
    }
}

fn load() -> (Model, Value, String) {
    let path = std::env::var("LD01_G1_C11_PACKET")
        .expect("LD01_G1_C11_PACKET: the compiled passive packet (G1-C11 prototype input)");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("packet"))
        .expect("packet json");
    let pr = &v["prhr"];
    let parts: Vec<Part> = arr(&v, "/prhr/parts")
        .iter()
        .map(|p| Part {
            id: text(p, "/id"),
            length: num(p, "/length_m"),
            bore: num(p, "/diameter_m"),
            outside: num(p, "/outsideDiameter_m"),
            parallel: num(p, "/parallel"),
            z: num(p, "/elevation_m"),
            volume: num(p, "/waterVolume_m3"),
            immersed: p["immersed"].as_bool().expect("immersed"),
        })
        .collect();
    assert_eq!(parts.len(), 19, "C11-D6: 19 water regions");
    let index = |id: &str| -> usize {
        parts
            .iter()
            .position(|p| p.id == id)
            .unwrap_or_else(|| panic!("PRHR region {id}"))
    };
    let end = |id: &str| -> End {
        match id {
            "HOT.A.after" => End::Hot,
            "SG.A.PRIMARY.outlet" => End::Sg,
            _ => End::Cell(index(id)),
        }
    };
    let mut steel: Vec<Steel> = arr(&v, "/prhr/steel")
        .iter()
        .map(|s| Steel {
            id: text(s, "/id"),
            cap: num(s, "/capacity_J_K"),
            r_in: num(s, "/innerResistance_K_W"),
            r_out: num(s, "/outerResistance_K_W"),
        })
        .collect();
    assert_eq!(steel.len(), 36, "two halves per region and two seat shells");
    for d in arr(&v, "/prhr/disc") {
        steel.push(Steel {
            id: text(d, "/id"),
            cap: num(d, "/capacity_J_K"),
            r_in: f64::NAN,
            r_out: f64::NAN,
        });
    }
    assert_eq!(steel.len(), 38, "C11-D6: 38 steel stores");
    let sidx = |id: &str| -> usize {
        steel
            .iter()
            .position(|s| s.id == id)
            .unwrap_or_else(|| panic!("PRHR steel {id}"))
    };
    let roughness_ok = |s: &Value| num(s, "/roughness_m") >= 0.;
    let mut links = vec![];
    let mut seat = None;
    for l in arr(&v, "/prhr/links") {
        let segs: Vec<Seg> = arr(l, "/segments")
            .iter()
            .map(|s| {
                assert!(roughness_ok(s));
                Seg {
                    length: num(s, "/length_m"),
                    area: num(s, "/area_m2"),
                    bore: num(s, "/diameter_m"),
                    eps: num(s, "/roughness_m") / num(s, "/diameter_m"),
                    k: num(s, "/fixedLoss"),
                }
            })
            .collect();
        let (from, to) = (text(l, "/from"), text(l, "/to"));
        let link = Link {
            name: format!("{from}->{to}"),
            from: end(&from),
            to: end(&to),
            inertance: segs.iter().map(|s| s.length / s.area).sum(),
            segs,
        };
        if l["seat"].as_bool().expect("seat flag") {
            assert!(seat.is_none(), "one seat");
            seat = Some(link);
        } else {
            links.push(link);
        }
    }
    let seat = seat.expect("the seat link");
    assert_eq!(links.len(), 20, "C11-D6: 20 non-seat paths");
    let (up, dn) = (index("PRHR.SEAT.UP"), index("PRHR.SEAT.DOWN"));
    assert!(seat.from == End::Cell(up) && seat.to == End::Cell(dn));
    let link_index = |from: End, to: End| -> usize {
        links
            .iter()
            .position(|l| l.from == from && l.to == to)
            .unwrap_or_else(|| panic!("PRHR link {from:?}->{to:?}"))
    };
    let geo = &pr["geometry"];
    let ks = num(geo, "/steelConductivity_W_mK");
    // Inner contacts (reference-design-prhr-cooling.ts): water -> STEEL.1 or
    // the seat SHELL; representative flow = the unique incoming link, the
    // far lower header its outgoing link, the seat shells the seat flow.
    let mut inner = vec![];
    let mut pool = vec![];
    let mut gas = vec![];
    let mut conds = vec![];
    let ins = num(pr, "/connectors/insulation_m");
    let k_ins = num(pr, "/connectors/insulationConductivity_W_mK");
    let h_ext = num(pr, "/connectors/exteriorCoefficient_W_m2K");
    for (r, p) in parts.iter().enumerate() {
        let shell = p.id.starts_with("PRHR.SEAT.");
        let s_in = sidx(&format!(
            "{}{}",
            p.id,
            if shell { ".SHELL" } else { ".STEEL.1" }
        ));
        let s_out = sidx(&format!(
            "{}{}",
            p.id,
            if shell { ".SHELL" } else { ".STEEL.2" }
        ));
        let flow = if shell {
            Flow::Seat
        } else if p.id == "PRHR.LOWER.2" {
            Flow::Link(link_index(End::Cell(r), end("PRHR.RETURN.BANK")))
        } else {
            let incoming: Vec<usize> = (0..links.len())
                .filter(|&l| links[l].to == End::Cell(r))
                .collect();
            assert_eq!(incoming.len(), 1, "representative film flow of {}", p.id);
            Flow::Link(incoming[0])
        };
        inner.push(Inner {
            part: r,
            steel: s_in,
            area: std::f64::consts::PI * p.bore * p.length * p.parallel,
            bore: p.bore,
            flow_area: p.parallel * std::f64::consts::PI * p.bore * p.bore / 4.,
            flow,
            r: steel[s_in].r_in,
        });
        if p.immersed {
            pool.push(Pool {
                steel: s_out,
                area: std::f64::consts::PI * p.outside * p.length * p.parallel,
                outside: p.outside,
                z: p.z,
                r: steel[s_out].r_out,
            });
        } else {
            // Cold join: "100 mm / 0.06 W/(m K) insulation and 8 W/(m2 K)
            // exterior coefficient on actual pipe radii" to the supplied
            // containment environment (not ROOM.A).
            let ro = p.outside / 2.;
            let ri = ro + ins;
            let resistance = steel[s_out].r_out
                + (ri / ro).ln() / (2. * std::f64::consts::PI * k_ins * p.length)
                + 1. / (h_ext * 2. * std::f64::consts::PI * ri * p.length);
            gas.push(Cond {
                a: s_out,
                b: usize::MAX,
                g: 1. / resistance,
            });
        }
        if !shell {
            // Radial center-to-center conduction: ln(r2/r1)/(2 pi k L n)
            // = R_in(STEEL.2) - R_in(STEEL.1) of the packet's half cells.
            let g = 1. / (steel[s_out].r_in - steel[s_in].r_in);
            assert!(g.is_finite() && g > 0.);
            conds.push(Cond {
                a: s_in,
                b: s_out,
                g,
            });
        }
    }
    let (d1, d2) = (sidx("PRHR.DISC.1"), sidx("PRHR.DISC.2"));
    conds.push(Cond {
        a: d1,
        b: d2,
        g: num(pr, "/discCenterConductance_W_K"),
    });
    conds.push(Cond {
        a: sidx("PRHR.SEAT.UP.SHELL"),
        b: sidx("PRHR.SEAT.DOWN.SHELL"),
        g: num(pr, "/shellCenterConductance_W_K"),
    });
    // DEVIATION (reported): the packet carries the disc capacity and its
    // center conductance but not `reference-prhr-isolation`'s disc diameter
    // and thickness. They are recovered exactly from the isolation audit's
    // own definitions: C_half = rho cp A t/2, G = 2 k A/t, so
    // A = sqrt(C_half G/(rho cp k)), t = 2 C_half/(rho cp A), and the face
    // half-cell resistance t/(4 k A) = 1/(2 G) (reference-design-prhr-cooling.ts).
    let (rho_s, cp_s) = (num(geo, "/steelDensity_kg_m3"), num(geo, "/steelCp_J_kgK"));
    let c_half = steel[d1].cap;
    let g_disc = num(pr, "/discCenterConductance_W_K");
    let disc_area = (c_half * g_disc / (rho_s * cp_s * ks)).sqrt();
    let disc_bore = (4. * disc_area / std::f64::consts::PI).sqrt();
    let disc_r = 1. / (2. * g_disc);
    let faces = vec![
        Face {
            steel: d1,
            upstream: true,
        },
        Face {
            steel: d2,
            upstream: false,
        },
    ];
    // Return scalar mixing (reference-design-prhr-cooling.ts): SG outlet,
    // RETURN.ENTRANCE, RETURN.BANK, LOWER.2 at [0, l/2, (l+L)/2, L] along
    // the cold connector, s from SG to bank.
    let dmix = num(geo, "/coldConnector/id_m");
    let lmix = num(geo, "/coldConnector/length_m");
    let entry = num(pr, "/mixing/penetrationBores") * dmix;
    let coords = [0., entry / 2., (entry + lmix) / 2., lmix];
    let ids = [
        End::Sg,
        end("PRHR.RETURN.ENTRANCE"),
        end("PRHR.RETURN.BANK"),
        end("PRHR.LOWER.2"),
    ];
    let mut mix = vec![];
    for i in 0..3 {
        let (lo, hi) = (coords[i], coords[i + 1]);
        mix.push(Mix {
            a: ids[i],
            b: ids[i + 1],
            dx: hi - lo,
            w: entry / (hi - lo) * ((-lo / entry).exp() - (-hi / entry).exp()),
        });
    }
    let mixed = |a: End, b: End| {
        mix.iter()
            .any(|m| (m.a == a && m.b == b) || (m.a == b && m.b == a))
    };
    for m in &mix {
        assert!(
            links
                .iter()
                .any(|l| (l.from == m.a && l.to == m.b) || (l.from == m.b && l.to == m.a)),
            "return mixing pair is an actual link"
        );
    }
    // Molecular axial conduction on every link not carrying return mixing
    // (cold join: counted once): min segment area, separation = A sum L/A.
    let mut axial = vec![];
    for l in links.iter().chain(std::iter::once(&seat)) {
        if mixed(l.from, l.to) {
            continue;
        }
        let area = l.segs.iter().map(|s| s.area).fold(f64::INFINITY, f64::min);
        axial.push(Axial {
            from: l.from,
            to: l.to,
            area,
            separation: area * l.inertance,
            seat: l.seat_flag(&seat),
        });
    }
    let cal = &geo["calibration"];
    let seat_area = seat.segs[0].area;
    let valve_k = num(pr, "/valveK");
    let m_ref = num(cal, "/flow_kg_s");
    let seat_scale =
        valve_k * m_ref * m_ref / (2. * num(cal, "/density_kg_m3") * seat_area * seat_area);
    let model = Model {
        nc: parts.len(),
        ns: steel.len(),
        nl: links.len(),
        n: 0,
        z_hot: num(&v, "/boundary/hotAfter/elevation_m"),
        z_sg: num(&v, "/boundary/sgOutlet/elevation_m"),
        valve_k,
        seat_area,
        disc_area,
        disc_bore,
        disc_r,
        bank_factor: num(pr, "/contact/bankFactor"),
        mix_bore: dmix,
        mix_area: std::f64::consts::PI * dmix * dmix / 4.,
        mix_slope: (num(geo, "/tubes/bottom_m") - num(geo, "/coldTerminal_m")) / lmix,
        mix_coef: num(pr, "/mixing/coefficient"),
        pr_t: num(pr, "/mixing/turbulentPrandtl"),
        sc_t: num(pr, "/mixing/turbulentSchmidt"),
        first_exposure: num(pr, "/pool/firstExposure_m"),
        bank_k: num(pr, "/preparedBank_K"),
        m_ref,
        seat_scale,
        parts,
        steel,
        links,
        seat,
        up,
        dn,
        inner,
        faces,
        pool,
        gas,
        conds,
        axial,
        mix,
    };
    let mut model = model;
    model.n = model.ts(0) + model.n_surf();
    assert_eq!(model.z_hot, num(geo, "/hotTerminal_m"));
    assert_eq!(model.z_sg, num(geo, "/coldTerminal_m"));
    (model, v, path)
}
impl Link {
    fn seat_flag(&self, seat: &Link) -> bool {
        self.from == seat.from && self.to == seat.to
    }
}

// ------------------------------------------------------------------ the ports
/// Held port values. C06 (`boundary`): HOT.A.after and SG.A.PRIMARY.outlet
/// states and the SG main velocity. C13: WST temperature and surface
/// (`ld01-cnv-pools`: 25°C, +14.148275 m), CNV pressure and the containment
/// environment of the exposed connectors (`ld01-cnv-atmosphere`: 101.325 kPa,
/// 25°C). Seat opening x (C11-D7 held trajectory). Boron: the primary
/// dissolved-absorber fraction is NOT in the packet (reported missing); it is
/// held at 0 at the preparation and declared only at the warm probe.
#[derive(Clone, Copy, Debug)]
struct Inputs {
    p_hot: f64,
    t_hot: f64,
    p_sg: f64,
    t_sg: f64,
    u_sg: f64,
    c_hot: f64,
    c_sg: f64,
    t_wst: f64,
    surface: f64,
    p_cnv: f64,
    t_env: f64,
    x: f64,
}
impl Inputs {
    fn prepared(v: &Value) -> Self {
        Inputs {
            p_hot: num(v, "/boundary/hotAfter/pressure_Pa"),
            t_hot: num(v, "/boundary/hotAfter/temperature_K"),
            p_sg: num(v, "/boundary/sgOutlet/pressure_Pa"),
            t_sg: num(v, "/boundary/sgOutlet/temperature_K"),
            u_sg: num(v, "/boundary/sgOutletVelocity_m_s"),
            c_hot: 0.,
            c_sg: 0.,
            // ld01-cnv-pools wst.initialTemperature_C 25.
            t_wst: 298.15,
            // ld01-cnv-pools wst.initialSurface_m.
            surface: 14.148275,
            // ld01-cnv-atmosphere initialTotalPressure_kPa 101.325.
            p_cnv: 101325.,
            // ld01-cnv-atmosphere initialTemperature_C 25.
            t_env: 298.15,
            x: 0.,
        }
    }
}

// ------------------------------------------------------------------ the laws
/// Churchill's all-regime Darcy factor times Re (8x the paper's factor,
/// equations 5 and 18). Below Re = 1 the turbulent term is < 1e-109 of the
/// laminar 64^12/8^12 term, so the laminar limit is the double result.
fn friction_re(re: D, eps: f64) -> D {
    if re.v < 1. {
        return c(64.);
    }
    let x = (c(7.) / re).powf(0.9) + 0.27 * eps;
    let a = (-x.ln() * 2.457).powi(16);
    let b = (c(37530.) / re).powi(16);
    let t = re.powi(12) * (a + b).powf(-1.5);
    (t + 8f64.powi(12)).powf(1. / 12.) * 8.
}
/// Per-segment Churchill friction at the actual Re plus fixed losses:
/// `f L/D m|m|/(2 rho A^2) = fRe mu L m/(2 rho A D^2)` (finite slope at 0).
fn path_loss(segs: &[Seg], m: D, rho: D, mu: D) -> D {
    let mut loss = c(0.);
    for s in segs {
        let re = m.abs() * (s.bore / s.area) / mu;
        let fre = friction_re(re, s.eps);
        loss += fre * mu * m * (s.length / (2. * s.area * s.bore * s.bore)) / rho;
        loss += m * m.abs() * (s.k / (2. * s.area * s.area)) / rho;
    }
    loss
}
/// INL primary film (max of Nu=3.66, natural convection on |Tw - Ts|,
/// Gnielinski above Re 1000), signed heat from water to its surface, W.
fn film(p: D, bulk: &Water, ts: D, flow: D, area: f64, bore: f64, flow_area: f64) -> D {
    let wall = liquid(p, ts);
    let mid = liquid(p, (bulk.t + ts) * 0.5);
    let re = flow.abs() * (bore / flow_area) / bulk.mu;
    let pr = bulk.mu * bulk.cp / bulk.k;
    let ratio = pr / (wall.mu * wall.cp / wall.k);
    assert!(
        (0.05..=20.).contains(&ratio.v),
        "unsupported film Pr/Pr_wall {}",
        ratio.v
    );
    let ra_k = bulk.beta * pr * (G * bore.powi(3)) / (bulk.mu / mid.rho).powi(2);
    assert!(ra_k.v >= 0., "unsupported natural-film expansion branch");
    let delta = bulk.t - ts;
    let mut nu = c(3.66);
    if delta.v != 0. {
        let ra = ra_k * delta.abs();
        nu = nu.max(ra.powf(0.25) * 0.59).max(ra.powf(1. / 3.) * 0.13);
    }
    if re.v > 1000. {
        let f = (re.ln() * 1.58 - 3.28).powi(-2);
        let half = f * 0.5;
        let turb = half * (re - 1000.) * pr / ((pr.powf(2. / 3.) - 1.) * half.sqrt() * 12.7 + 1.)
            * ratio.powf(0.11);
        nu = nu.max(turb);
    }
    nu * bulk.k * (area / bore) * delta
}
/// Churchill–Chu horizontal-cylinder coefficient, unscaled, W/(m2 K), on
/// |Ts - T_pool| with film properties at (T_pool + min(Ts, Tsat))/2.
fn pool_coefficient(ts: D, pz: f64, tsat: f64, t_pool: f64, outside: f64) -> D {
    let tf = (ts.min(c(tsat)) + t_pool) * 0.5;
    let w = liquid(c(pz), tf);
    let pr = w.mu * w.cp / w.k;
    let nu = w.mu / w.rho;
    let alpha = w.k / (w.rho * w.cp);
    let ra_k = w.beta * (G * outside.powi(3)) / (nu * alpha);
    let delta = ts - t_pool;
    // The heat multiplies this by delta: at delta = 0 the derivative of
    // |delta|^(1/6) (unbounded) is not needed, its product with delta is 0.
    let x = if delta.v == 0. {
        c(0.)
    } else {
        delta.abs().powf(1. / 6.)
    };
    let cc = ra_k.powf(1. / 6.) * 0.387 / ((c(0.559) / pr).powf(9. / 16.) + 1.).powf(8. / 27.);
    let z = cc * x + 0.6;
    z * z * w.k / outside
}
/// Signed pre-onset pool heat from the surface, times bankFactor once, W.
fn pool_heat(ts: D, pz: f64, tsat: f64, t_pool: f64, area: f64, outside: f64, bank: f64) -> D {
    pool_coefficient(ts, pz, tsat, t_pool, outside) * (bank * area) * (ts - t_pool)
}
/// Common-pressure density difference rho_b - rho_a with the cold join's
/// cancellation-band trapezoid (prhr_mixing.rs `density_difference`).
fn density_difference(a: &Water, b: &Water) -> D {
    let raw = b.rho - a.rho;
    let da = -(a.rho * a.beta);
    let db = -(b.rho * b.beta);
    let dt = b.t - a.t;
    let gamma3 = 3. * f64::EPSILON / (1. - 3. * f64::EPSILON);
    let cancellation = raw.v.abs() <= gamma3 * a.rho.v.abs() + gamma3 * b.rho.v.abs();
    let short = dt.v.abs() <= f64::EPSILON.sqrt() * a.t.v.abs().min(b.t.v.abs());
    let monotone = da.v != 0. && db.v != 0. && da.v.signum() == db.v.signum();
    if dt.v != 0. && cancellation && short && monotone {
        dt * (da + db) * 0.5
    } else {
        raw
    }
}

// ------------------------------------------------------------------ residual
struct Eval {
    f: Vec<D>,
    /// Differential rows: the rate the row implies (y' at fixed others).
    rhs: Vec<f64>,
    pool_heat_w: f64,
    connector_w: f64,
    /// Contrasts for the cusp classification: inner (water - Ts), face
    /// [up, down] (water - Ts), pool (Ts - T_WST).
    inner_dt: Vec<f64>,
    face_dt: Vec<[f64; 2]>,
    pool_dt: Vec<f64>,
    /// Return mixing pairs (T_a - T_b).
    mix_dt: Vec<f64>,
    /// Per row: the sum of its terms' magnitudes.
    mag: Vec<f64>,
    seat_drive_pa: f64,
}

/// The declared junction elevation of a face: the mean of its two ends'.
fn junction(m: &Model, from: End, to: End) -> f64 {
    0.5 * (m.z(from) + m.z(to))
}

fn deposit(acc: &mut [Acc], e: End, value: D) {
    if let End::Cell(r) = e {
        acc[r] += value;
    }
}

fn residual(m: &Model, u: &Inputs, y: &[D], yp: &[D]) -> Eval {
    let n = m.n;
    let nc = m.nc;
    let mut f = vec![c(0.); n];
    let mut rhs = vec![0.; n];
    let cw: Vec<Water> = (0..nc)
        .map(|r| liquid_pu(y[m.cell(r, P)], y[m.cell(r, UL)] / y[m.cell(r, ML)]))
        .collect();
    let hot = liquid(c(u.p_hot), c(u.t_hot));
    let sg = liquid(c(u.p_sg), c(u.t_sg));
    let end_p = |e: End| match e {
        End::Hot => c(u.p_hot),
        End::Sg => c(u.p_sg),
        End::Cell(r) => y[m.cell(r, P)],
    };
    let end_w = |e: End| match e {
        End::Hot => hot,
        End::Sg => sg,
        End::Cell(r) => cw[r],
    };
    let end_c = |e: End| match e {
        End::Hot => c(u.c_hot),
        End::Sg => c(u.c_sg),
        End::Cell(r) => y[m.cell(r, B)] / y[m.cell(r, ML)],
    };
    // Hydrostatic face reconstruction to the junction elevation.
    let drive = |from: End, to: End| -> D {
        let zj = junction(m, from, to);
        (end_p(from) - end_w(from).rho * (G * (zj - m.z(from))))
            - (end_p(to) - end_w(to).rho * (G * (zj - m.z(to))))
    };
    let drive_mag = |from: End, to: End| -> f64 {
        let zj = junction(m, from, to);
        end_p(from).v.abs()
            + end_p(to).v.abs()
            + (end_w(from).rho.v * G * (zj - m.z(from))).abs()
            + (end_w(to).rho.v * G * (zj - m.z(to))).abs()
    };
    let mut mag = vec![0.; n];
    let mut mass = vec![acc(); nc];
    let mut energy = vec![acc(); nc];
    let mut boron = vec![acc(); nc];
    let mut heat_w = vec![acc(); nc];
    let mut heat_s = vec![acc(); m.ns];
    let mut flows = vec![c(0.); m.nl];
    let transport =
        |mass: &mut [Acc], energy: &mut [Acc], boron: &mut [Acc], from: End, to: End, q: D| {
            let donor = if q.v >= 0. { from } else { to };
            let wd = end_w(donor);
            let en = q * (wd.h + G * m.z(donor));
            let bf = q * end_c(donor);
            deposit(mass, from, -q);
            deposit(mass, to, q);
            deposit(energy, from, -en);
            deposit(energy, to, en);
            deposit(boron, from, -bf);
            deposit(boron, to, bf);
        };
    // S3 phase paths.
    for (l, k) in m.links.iter().enumerate() {
        let q = y[m.pil(l)] / k.inertance;
        flows[l] = q;
        let wd = end_w(if q.v >= 0. { k.from } else { k.to });
        let r = drive(k.from, k.to) - path_loss(&k.segs, q, wd.rho, wd.mu);
        rhs[m.pil(l)] = r.v;
        mag[m.pil(l)] = yp[m.pil(l)].v.abs() + drive_mag(k.from, k.to) + r.v.abs();
        mag[m.pig(l)] = y[m.pig(l)].v.abs();
        f[m.pil(l)] = yp[m.pil(l)] - r;
        // L1 lock of the absent vapor phase: row Pi_g, no transport.
        f[m.pig(l)] = y[m.pig(l)];
        transport(&mut mass, &mut energy, &mut boron, k.from, k.to, q);
    }
    // The seat: algebraic restriction (S3-D25), L1 lock while closed.
    let ms = y[m.seat_l()];
    let seat_drive = drive(m.seat.from, m.seat.to);
    if u.x == 0. {
        f[m.seat_l()] = ms;
        mag[m.seat_l()] = ms.v.abs();
    } else {
        let wd = end_w(if ms.v >= 0. { m.seat.from } else { m.seat.to });
        let valve =
            ms * ms.abs() * (m.valve_k / (u.x * u.x) / (2. * m.seat_area * m.seat_area)) / wd.rho;
        let loss = path_loss(&m.seat.segs, ms, wd.rho, wd.mu);
        f[m.seat_l()] = seat_drive - loss - valve;
        mag[m.seat_l()] = drive_mag(m.seat.from, m.seat.to) + loss.v.abs() + valve.v.abs();
        transport(
            &mut mass,
            &mut energy,
            &mut boron,
            m.seat.from,
            m.seat.to,
            ms,
        );
    }
    f[m.seat_g()] = y[m.seat_g()];
    let flow_of = |fl: Flow| match fl {
        Flow::Link(l) => flows[l],
        Flow::Seat => ms,
    };
    let t_steel = |s: usize| y[m.st(s)] / m.steel[s].cap;
    // Inner water-to-steel contacts: film in series with the half cell.
    let mut inner_dt = vec![];
    for (k, ct) in m.inner.iter().enumerate() {
        let w = cw[ct.part];
        let ts = y[m.ts(k)];
        let v = film(
            y[m.cell(ct.part, P)],
            &w,
            ts,
            flow_of(ct.flow),
            ct.area,
            ct.bore,
            ct.flow_area,
        );
        heat_w[ct.part] -= v;
        heat_s[ct.steel] += v;
        f[m.ts(k)] = ts - t_steel(ct.steel) - v * ct.r;
        mag[m.ts(k)] = ts.v.abs() + t_steel(ct.steel).v.abs() + (v.v * ct.r).abs();
        inner_dt.push(w.t.v - ts.v);
    }
    // Disc faces: (1 +/- cos(pi x/2))/2 of each face's area per cavity.
    let own = 0.5 * (1. + (std::f64::consts::FRAC_PI_2 * u.x).cos());
    let mut face_dt = vec![];
    for (k, fc) in m.faces.iter().enumerate() {
        let i = m.ts(m.inner.len() + k);
        let ts = y[i];
        let (w_up, w_dn) = if fc.upstream {
            (own, 1. - own)
        } else {
            (1. - own, own)
        };
        let mut total = c(0.);
        let mut dts = [0.; 2];
        for (j, (cell, w)) in [(m.up, w_up), (m.dn, w_dn)].into_iter().enumerate() {
            let v = film(
                y[m.cell(cell, P)],
                &cw[cell],
                ts,
                ms,
                m.disc_area,
                m.disc_bore,
                m.seat_area,
            ) * w;
            heat_w[cell] -= v;
            total += v;
            dts[j] = cw[cell].t.v - ts.v;
        }
        heat_s[fc.steel] += total;
        f[i] = ts - t_steel(fc.steel) - total * m.disc_r;
        mag[i] = ts.v.abs() + t_steel(fc.steel).v.abs() + (total.v * m.disc_r).abs();
        face_dt.push(dts);
    }
    // Pool contacts (fully immersed; exposure root surface - firstExposure).
    let rho_pool = point(Branch::Liquid, u.p_cnv, u.t_wst)
        .expect("IF97 pool")
        .density_kg_m3;
    let mut pool_dt = vec![];
    let mut pool_total = 0.;
    for (k, pc) in m.pool.iter().enumerate() {
        let i = m.ts(m.inner.len() + m.faces.len() + k);
        let ts = y[i];
        let pz = u.p_cnv + rho_pool * G * (u.surface - pc.z);
        let (tsat, ..) = saturation(pz);
        let q = pool_heat(ts, pz, tsat, u.t_wst, pc.area, pc.outside, m.bank_factor);
        heat_s[pc.steel] -= q;
        f[i] = ts - t_steel(pc.steel) + q * pc.r;
        mag[i] = ts.v.abs() + t_steel(pc.steel).v.abs() + (q.v * pc.r).abs();
        pool_dt.push(ts.v - u.t_wst);
        pool_total += q.v;
    }
    // Exposed connectors to the held containment environment.
    let mut connector = 0.;
    for g in &m.gas {
        let q = (t_steel(g.a) - u.t_env) * g.g;
        heat_s[g.a] -= q;
        connector += q.v;
    }
    // Radial, disc through-thickness and shell axial conduction.
    for cd in &m.conds {
        let q = (t_steel(cd.a) - t_steel(cd.b)) * cd.g;
        heat_s[cd.a] -= q;
        heat_s[cd.b] += q;
    }
    // Molecular axial water conduction (seat gap: area times x).
    for ax in &m.axial {
        let (a, b) = (end_w(ax.from), end_w(ax.to));
        let kh = a.k * b.k * 2. / (a.k + b.k);
        let area = ax.area * if ax.seat { u.x } else { 1. };
        let q = kh * (a.t - b.t) * (area / ax.separation);
        deposit(&mut heat_w, ax.from, -q);
        deposit(&mut heat_w, ax.to, q);
    }
    // Return scalar mixing (reference-prhr-mixing), common face pressure.
    let mut mix_dt = vec![];
    for mx in &m.mix {
        let pf = (end_p(mx.a) + end_p(mx.b)) * 0.5;
        let (ta, tb) = (end_w(mx.a).t, end_w(mx.b).t);
        let a = liquid(pf, ta);
        let b = liquid(pf, tb);
        let rho = (a.rho + b.rho) * 0.5;
        let cp = (a.cp + b.cp) * 0.5;
        let mu = (a.mu + b.mu) * 0.5;
        let unstable = (density_difference(&a, &b) * m.mix_slope).pos();
        let bdrive = unstable * (G * m.mix_bore) / rho;
        let lambda = mu * 32. / (rho * m.mix_bore);
        let ub = bdrive * 2. / (lambda + (lambda * lambda + bdrive * 4.).sqrt());
        let eddy = (ub + u.u_sg.abs() * mx.w) * (m.mix_coef * m.mix_bore);
        let kh = a.k * b.k * 2. / (a.k + b.k);
        let gq = (kh + rho * cp * eddy / m.pr_t) * (m.mix_area / mx.dx);
        let q = gq * (ta - tb);
        mix_dt.push(ta.v - tb.v);
        let km = rho * eddy * (m.mix_area / (m.sc_t * mx.dx));
        let j = km * (end_c(mx.a) - end_c(mx.b));
        deposit(&mut heat_w, mx.a, -q);
        deposit(&mut heat_w, mx.b, q);
        deposit(&mut boron, mx.a, -j);
        deposit(&mut boron, mx.b, j);
    }
    // Cell rows.
    for r in 0..nc {
        let i = |k| m.cell(r, k);
        f[i(P)] = y[i(ML)] / cw[r].rho - m.parts[r].volume;
        mag[i(P)] = (y[i(ML)] / cw[r].rho).v.abs() + m.parts[r].volume;
        rhs[i(ML)] = mass[r].v.v;
        f[i(ML)] = yp[i(ML)] - mass[r].v;
        mag[i(ML)] = yp[i(ML)].v.abs() + mass[r].a;
        let e = energy[r].v + heat_w[r].v;
        let gz = G * m.parts[r].z;
        rhs[i(UL)] = e.v - gz * yp[i(ML)].v;
        f[i(UL)] = yp[i(UL)] + yp[i(ML)] * gz - e;
        mag[i(UL)] = yp[i(UL)].v.abs() + (gz * yp[i(ML)].v).abs() + energy[r].a + heat_w[r].a;
        f[i(MG)] = yp[i(MG)];
        f[i(UG)] = yp[i(UG)];
        mag[i(MG)] = yp[i(MG)].v.abs();
        mag[i(UG)] = yp[i(UG)].v.abs();
        rhs[i(B)] = boron[r].v.v;
        f[i(B)] = yp[i(B)] - boron[r].v;
        mag[i(B)] = yp[i(B)].v.abs() + boron[r].a;
    }
    for s in 0..m.ns {
        rhs[m.st(s)] = heat_s[s].v.v;
        f[m.st(s)] = yp[m.st(s)] - heat_s[s].v;
        mag[m.st(s)] = yp[m.st(s)].v.abs() + heat_s[s].a;
    }
    mag[m.seat_g()] = y[m.seat_g()].v.abs();
    for (i, x) in f.iter().enumerate() {
        assert!(
            x.v.is_finite() && x.d.is_finite(),
            "nonfinite row {}",
            m.name(i)
        );
    }
    Eval {
        f,
        rhs,
        pool_heat_w: pool_total,
        connector_w: connector,
        inner_dt,
        face_dt,
        pool_dt,
        mix_dt,
        mag,
        seat_drive_pa: seat_drive.v,
    }
}

/// Nucleate-onset ROOT per pool contact, `T_onb - T_s` (positive below
/// onset; INL onset as reference-design-native-pool-contact.ts `wet_state`:
/// F = 1 - exp(-phi^3 - phi/2), phi = 38°, unscaled Churchill–Chu h, pool
/// bulk conductivity at (p, T_pool)).
fn onset_roots(m: &Model, u: &Inputs, y: &[f64]) -> Vec<f64> {
    let rho_pool = point(Branch::Liquid, u.p_cnv, u.t_wst)
        .expect("IF97 pool")
        .density_kg_m3;
    let phi = 38f64.to_radians();
    let ff = 1. - (-phi.powi(3) - 0.5 * phi).exp();
    m.pool
        .iter()
        .enumerate()
        .map(|(k, pc)| {
            let ts = y[m.ts(m.inner.len() + m.faces.len() + k)];
            let pz = u.p_cnv + rho_pool * G * (u.surface - pc.z);
            let (tsat, _, hl, rv, hv) = saturation(pz);
            let h = pool_coefficient(c(ts), pz, tsat, u.t_wst, pc.outside).v;
            let (sigma, _) = surface_tension(tsat, 0.).expect("IF97 surface tension");
            let kp = point(Branch::Liquid, pz, u.t_wst)
                .expect("IF97 pool bulk")
                .conductivity_w_m_k;
            let on = 2. * h * sigma * tsat / (ff * ff * rv * (hv - hl) * kp);
            let ton = u.t_wst + 0.25 * (on.sqrt() + (on + 4. * (tsat - u.t_wst)).sqrt()).powi(2);
            ton - ts
        })
        .collect()
}

// --------------------------------------------------------------- preparation
/// The prepared state: bank (all water downstream of the seat and the bank
/// steel) at preparedBank_K, zero flows, closed seat; SEAT.UP water and the
/// upstream disc/shell halves at the HOT.A.after state. Pressures by the
/// residual's own drive convention, marched along the links from the SG
/// outlet and from HOT.A.after; each step is a scalar fixed point in
/// rho(p) run a fixed number of times and checked to machine precision.
fn prepare(m: &Model, u: &Inputs) -> (Vec<f64>, Value) {
    let nc = m.nc;
    let t_cell: Vec<f64> = (0..nc)
        .map(|r| if r == m.up { u.t_hot } else { m.bank_k })
        .collect();
    let rho = |p: f64, t: f64| {
        point(Branch::Liquid, p, t)
            .expect("IF97 preparation")
            .density_kg_m3
    };
    let mut p: Vec<Option<f64>> = vec![None; nc];
    let known = |p: &[Option<f64>], e: End| -> Option<(f64, f64, f64)> {
        match e {
            End::Hot => Some((u.p_hot, rho(u.p_hot, u.t_hot), m.z_hot)),
            End::Sg => Some((u.p_sg, rho(u.p_sg, u.t_sg), m.z_sg)),
            End::Cell(r) => p[r].map(|pp| (pp, rho(pp, t_cell[r]), m.parts[r].z)),
        }
    };
    let mut tree = vec![];
    let mut steps = 0usize;
    for _pass in 0..nc {
        for (l, k) in m.links.iter().enumerate() {
            let (a, b) = (known(&p, k.from), known(&p, k.to));
            let zj = junction(m, k.from, k.to);
            let (unknown, base) = match (a, b, k.from, k.to) {
                (Some((pa, ra, za)), None, _, End::Cell(r)) => (r, pa - ra * G * (zj - za)),
                (None, Some((pb, rb, zb)), End::Cell(r), _) => (r, pb - rb * G * (zj - zb)),
                _ => continue,
            };
            let (tz, zz) = (t_cell[unknown], m.parts[unknown].z);
            // p_x = base + rho(p_x, T_x) g (z_j - z_x): contraction factor
            // g |z_j - z_x| rho kappa < 1e-5; 24 passes reach the fixed point.
            let mut px = base;
            for _ in 0..24 {
                px = base + rho(px, tz) * G * (zj - zz);
            }
            let next = base + rho(px, tz) * G * (zj - zz);
            assert!(
                (next - px).abs() <= 2. * f64::EPSILON * px,
                "hydrostatic fixed point of {} not at machine precision",
                m.parts[unknown].id
            );
            p[unknown] = Some(px);
            tree.push(l);
            steps += 1;
        }
    }
    assert_eq!(steps, nc, "every region reached once by the march");
    let p: Vec<f64> = p
        .iter()
        .enumerate()
        .map(|(r, x)| x.unwrap_or_else(|| panic!("region {} unprepared", m.parts[r].id)))
        .collect();
    let mut y = vec![0.; m.n];
    let mut bank_mass = 0.;
    let mut bank_u = 0.;
    for r in 0..nc {
        let q = point(Branch::Liquid, p[r], t_cell[r]).expect("IF97 preparation");
        let mass = q.density_kg_m3 * m.parts[r].volume;
        y[m.cell(r, P)] = p[r];
        y[m.cell(r, ML)] = mass;
        y[m.cell(r, UL)] = mass * q.internal_energy_j_kg;
        // B = c_initial M with the adjacent primary's fraction (held port).
        y[m.cell(r, B)] = mass * if r == m.up { u.c_hot } else { u.c_sg };
        if r != m.up {
            bank_mass += mass;
            bank_u += mass * q.internal_energy_j_kg;
        }
    }
    let hot_steel = ["PRHR.SEAT.UP.SHELL", "PRHR.DISC.1"];
    for (s, st) in m.steel.iter().enumerate() {
        let t = if hot_steel.contains(&st.id.as_str()) {
            u.t_hot
        } else {
            m.bank_k
        };
        y[m.st(s)] = st.cap * t;
    }
    // Surfaces at their contacted temperatures (zero contrast).
    for (k, ct) in m.inner.iter().enumerate() {
        y[m.ts(k)] = t_cell[ct.part];
    }
    for (k, fc) in m.faces.iter().enumerate() {
        y[m.ts(m.inner.len() + k)] = if fc.upstream { u.t_hot } else { m.bank_k };
    }
    for k in 0..m.pool.len() {
        y[m.ts(m.inner.len() + m.faces.len() + k)] = u.t_wst;
    }
    // Loop closure: links not in the march tree carry the hydrostatic mismatch.
    let closure: Vec<Value> = (0..m.links.len())
        .filter(|l| !tree.contains(l))
        .map(|l| json!({"link": m.links[l].name}))
        .collect();
    let diag = json!({
        "bankWaterMass_kg": bank_mass, "bankWaterInternalEnergy_J": bank_u,
        "wikiPreparedBank25C": {"mass_kg": 29004.350, "internalEnergy_J": 3.008292e9,
            "note": "residual-heat-exchanger.md 'Finite preparation and transport evidence' (HEOS preparation; IF97 here, not imported)"},
        "marchTreeLinks": tree.len(), "loopClosureLinks": closure,
        "seatUpPressure_Pa": p[m.up], "seatDownPressure_Pa": p[m.dn],
    });
    (y, diag)
}

/// y' from the rows' own rates: every differential row vanishes.
fn consistent_yp(m: &Model, u: &Inputs, y: &[f64]) -> Vec<f64> {
    let zero = vec![0.; m.n];
    let r = residual(m, u, &duals(y), &duals(&zero));
    let mut yp = vec![0.; m.n];
    for i in 0..m.n {
        if m.is_diff(i) {
            yp[i] = r.rhs[i];
        }
    }
    // U rows carry g z M'; recompute with the mass rates in place.
    let r = residual(m, u, &duals(y), &duals(&yp));
    for i in 0..m.n {
        if m.is_diff(i) {
            yp[i] = r.rhs[i];
        }
    }
    yp
}

// -------------------------------------------------------------------- checks
fn duals(y: &[f64]) -> Vec<D> {
    y.iter().map(|&v| c(v)).collect()
}
struct Scales {
    col: Vec<f64>,
    row_closed: Vec<f64>,
}
fn scales(m: &Model, y0: &[f64]) -> Scales {
    let mut col = vec![0.; m.n];
    let mut row = vec![0.; m.n];
    for r in 0..m.nc {
        let (mass, energy) = (y0[m.cell(r, ML)], y0[m.cell(r, UL)].abs());
        for (k, s) in [
            (P, y0[m.cell(r, P)]),
            (ML, mass),
            (UL, energy),
            (MG, mass),
            (UG, energy),
            (B, mass),
        ] {
            col[m.cell(r, k)] = s;
            row[m.cell(r, k)] = s;
        }
        row[m.cell(r, P)] = m.parts[r].volume;
    }
    for s in 0..m.ns {
        col[m.st(s)] = y0[m.st(s)].abs();
        row[m.st(s)] = y0[m.st(s)].abs();
    }
    for (l, k) in m.links.iter().enumerate() {
        for i in [m.pil(l), m.pig(l)] {
            col[i] = k.inertance * m.m_ref;
            row[i] = k.inertance * m.m_ref;
        }
    }
    for i in [m.seat_l(), m.seat_g()] {
        col[i] = m.m_ref;
        row[i] = m.m_ref;
    }
    for k in 0..m.n_surf() {
        col[m.ts(k)] = m.bank_k;
        row[m.ts(k)] = m.bank_k;
    }
    Scales {
        col,
        row_closed: row,
    }
}
impl Scales {
    /// The open seat's row is a pressure: scaled by the full-open valve drop
    /// at the calibration flow and density.
    fn row(&self, m: &Model, u: &Inputs, i: usize) -> f64 {
        if i == m.seat_l() && u.x != 0. {
            m.seat_scale
        } else {
            self.row_closed[i]
        }
    }
}

struct Case<'a> {
    m: &'a Model,
    u: Inputs,
    y: Vec<f64>,
    yp: Vec<f64>,
}
impl Case<'_> {
    fn eval_at(&self, u: &Inputs, y: &[f64]) -> Eval {
        residual(self.m, u, &duals(y), &duals(&self.yp))
    }
    fn eval(&self) -> Eval {
        self.eval_at(&self.u, &self.y)
    }
    fn jacobian(&self) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
        let n = self.m.n;
        let mut jy = vec![vec![0.; n]; n];
        let mut jp = vec![vec![0.; n]; n];
        for j in 0..n {
            let mut yd = duals(&self.y);
            yd[j].d = 1.;
            let r = residual(self.m, &self.u, &yd, &duals(&self.yp));
            for i in 0..n {
                jy[i][j] = r.f[i].d;
            }
            let mut ypd = duals(&self.yp);
            ypd[j].d = 1.;
            let r = residual(self.m, &self.u, &duals(&self.y), &ypd);
            for i in 0..n {
                jp[i][j] = r.f[i].d;
            }
        }
        (jy, jp)
    }
}
fn scaled_max(k: &Case, sc: &Scales, f: &[D]) -> (f64, usize) {
    let mut worst = (0., 0);
    for (i, r) in f.iter().enumerate() {
        let s = r.v.abs() / sc.row(k.m, &k.u, i);
        if s > worst.0 {
            worst = (s, i);
        }
    }
    worst
}

/// Entries (row, col) on a zero-contrast film cusp, declared from the
/// state's contrasts before any difference is taken.
fn cusp_set(k: &Case, e: &Eval) -> std::collections::BTreeSet<(usize, usize)> {
    let m = k.m;
    let mut set = std::collections::BTreeSet::new();
    let mut add = |rows: &[usize], cols: &[usize]| {
        for &r in rows {
            for &c in cols {
                set.insert((r, c));
            }
        }
    };
    for (i, ct) in m.inner.iter().enumerate() {
        if e.inner_dt[i].abs() < CUSP_K {
            let w = |s| m.cell(ct.part, s);
            add(
                &[w(UL), m.st(ct.steel), m.ts(i)],
                &[w(P), w(ML), w(UL), m.ts(i)],
            );
        }
    }
    for (j, fc) in m.faces.iter().enumerate() {
        let i = m.ts(m.inner.len() + j);
        for (side, cell) in [m.up, m.dn].into_iter().enumerate() {
            if e.face_dt[j][side].abs() < CUSP_K {
                let w = |s| m.cell(cell, s);
                add(&[w(UL), m.st(fc.steel), i], &[w(P), w(ML), w(UL), i]);
            }
        }
    }
    for (j, pc) in m.pool.iter().enumerate() {
        let i = m.ts(m.inner.len() + m.faces.len() + j);
        if e.pool_dt[j].abs() < CUSP_K {
            add(&[m.st(pc.steel), i], &[i]);
        }
    }
    // Return mixing at neutral buoyancy: the positive part of the density
    // contrast and the viscous-inertial root ub = 2B/(lambda + sqrt(lambda^2
    // + 4B)), whose curvature scale is a contrast near 1e-6 K.
    for (j, mx) in m.mix.iter().enumerate() {
        if e.mix_dt[j].abs() < CUSP_K {
            let cells: Vec<usize> = [mx.a, mx.b]
                .iter()
                .filter_map(|e| if let End::Cell(r) = e { Some(*r) } else { None })
                .collect();
            let rows: Vec<usize> = cells
                .iter()
                .flat_map(|&r| [m.cell(r, UL), m.cell(r, B)])
                .collect();
            let cols: Vec<usize> = cells
                .iter()
                .flat_map(|&r| [m.cell(r, P), m.cell(r, ML), m.cell(r, UL)])
                .collect();
            add(&rows, &cols);
        }
    }
    set
}

/// Forward-mode columns against differences in y (y' held): two-sided at
/// 1e-5 and 1e-3 of the column scale and the Richardson of 1e-3/2e-3 (as
/// C13); where none agrees, the one-sided Richardson 2D(h)-D(2h) at 1e-5 on
/// either side (an exact kink: upwind donor at zero flow, a positive part,
/// the residual's own branch). Entries failing both must lie in the
/// declared zero-contrast cusp set; any other failure fails the test.
/// Roundoff: a row whose terms are much larger than one entry's change (the
/// 350 kg/s advected enthalpy against a small conduction partial) admits its
/// difference-quotient roundoff bound `16 eps sum|terms| / h` (scaled per
/// variant); such entries are counted separately.
fn compare(k: &Case, sc: &Scales, jy: &[Vec<f64>], label: &str) -> Value {
    let m = k.m;
    let n = m.n;
    let base = k.eval();
    let cusps = cusp_set(k, &base);
    let f0: Vec<f64> = base.f.iter().map(|x| x.v).collect();
    let at = |j: usize, h: f64| -> (Vec<f64>, f64) {
        let mut y = k.y.clone();
        y[j] += h;
        let actual = y[j] - k.y[j];
        (k.eval_at(&k.u, &y).f.iter().map(|x| x.v).collect(), actual)
    };
    let (mut worst, mut checked, mut floor_worst, mut worst_at) =
        (0f64, 0usize, 0f64, String::new());
    let (mut kink_n, mut kink_worst) = (0usize, 0f64);
    let (mut cusp_n, mut cusp_worst) = (0usize, 0f64);
    let (mut round_n, mut round_worst) = (0usize, 0f64);
    let mut failures = vec![];
    for j in 0..n {
        let s = k.y[j].abs().max(sc.col[j]);
        let two = |rel: f64| -> Vec<f64> {
            let (a, ha) = at(j, rel * s);
            let (b, hb) = at(j, -rel * s);
            (0..n).map(|i| (a[i] - b[i]) / (ha - hb)).collect()
        };
        let (small, large, double) = (two(1e-5), two(1e-3), two(2e-3));
        let rich: Vec<f64> = (0..n).map(|i| (4. * large[i] - double[i]) / 3.).collect();
        let one = |sign: f64| -> Vec<f64> {
            let (a, ha) = at(j, sign * 1e-5 * s);
            let (b, hb) = at(j, sign * 2e-5 * s);
            (0..n)
                .map(|i| 2. * (a[i] - f0[i]) / ha - (b[i] - f0[i]) / hb)
                .collect()
        };
        let (fwd, bwd) = (one(1.), one(-1.));
        let (h1, h2) = (1e-5 * s, 1e-3 * s);
        for i in 0..n {
            let ad = jy[i][j];
            let noise = 16. * f64::EPSILON * base.mag[i];
            // Fraction of the roundoff allowance used (<= 1 passes).
            let used = |fd: f64, allow: f64| {
                ((ad - fd).abs() - 1e-6 * ad.abs().max(fd.abs())).max(0.) / allow
            };
            let scale = sc.col[j] / sc.row(m, &k.u, i);
            let rel = |fd: f64| (ad - fd).abs() / ad.abs().max(fd.abs());
            let big = ad.abs().max(small[i].abs()).max(large[i].abs()) * scale;
            if big <= 1e-8 {
                floor_worst = floor_worst.max((ad - small[i]).abs() * scale);
                continue;
            }
            checked += 1;
            let r2 = rel(small[i]).min(rel(large[i])).min(rel(rich[i]));
            let r1 = rel(fwd[i]).min(rel(bwd[i]));
            if r2 <= 1e-6 {
                if r2 > worst {
                    worst = r2;
                    worst_at = format!(
                        "d {} / d {}: AD {ad:e}, CD {:e} / {:e} / R {:e}",
                        m.name(i),
                        m.name(j),
                        small[i],
                        large[i],
                        rich[i]
                    );
                }
            } else if r1 <= 1e-6 {
                kink_n += 1;
                kink_worst = kink_worst.max(r1);
            } else if let Some(u) = [
                used(small[i], noise / h1),
                used(large[i], noise / h2),
                used(rich[i], 1.5 * noise / h2),
                used(fwd[i], 5. * noise / h1),
                used(bwd[i], 5. * noise / h1),
            ]
            .into_iter()
            .filter(|&u| u <= 1.)
            .reduce(f64::min)
            {
                round_n += 1;
                round_worst = round_worst.max(u);
            } else if cusps.contains(&(i, j)) {
                cusp_n += 1;
                cusp_worst = cusp_worst.max(r2.min(r1));
            } else {
                failures.push(format!(
                    "d {} / d {}: AD {ad:e}, CD {:e} / {:e} / R {:e}, one-sided {:e} / {:e}",
                    m.name(i),
                    m.name(j),
                    small[i],
                    large[i],
                    rich[i],
                    fwd[i],
                    bwd[i]
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{label}: {} partials disagree outside the declared cusps:\n{}",
        failures.len(),
        failures.join("\n")
    );
    json!({"checked": checked, "maxRelative": worst, "worst": worst_at, "floorMaxScaled": floor_worst,
        "kinkEntries": {"count": kink_n, "maxRelativeOneSided": kink_worst},
        "roundoffLimitedEntries": {"count": round_n, "maxFractionOfAllowance": round_worst,
            "allowance": "16 eps sum|row terms| / h per difference quotient"},
        "zeroContrastCuspEntries": {"declared": cusps.len(), "excluded": cusp_n, "bestRelative": cusp_worst}})
}
/// Smallest pivot (scaled matrix, partial pivoting) of dF/dy + cj dF/dy'.
fn min_pivot(k: &Case, sc: &Scales, jy: &[Vec<f64>], jp: &[Vec<f64>], cj: f64) -> f64 {
    let n = k.m.n;
    let mut a: Vec<Vec<f64>> = (0..n)
        .map(|i| {
            (0..n)
                .map(|j| (jy[i][j] + cj * jp[i][j]) * sc.col[j] / sc.row(k.m, &k.u, i))
                .collect()
        })
        .collect();
    let mut smallest = f64::INFINITY;
    for col in 0..n {
        let piv = (col..n)
            .max_by(|&r, &s| a[r][col].abs().total_cmp(&a[s][col].abs()))
            .unwrap();
        a.swap(col, piv);
        let d = a[col][col];
        smallest = smallest.min(d.abs());
        if d == 0. {
            return 0.;
        }
        for r in col + 1..n {
            let factor = a[r][col] / d;
            if factor != 0. {
                for q in col..n {
                    a[r][q] -= factor * a[col][q];
                }
            }
        }
    }
    smallest
}
fn pattern(jy: &[Vec<f64>], jp: &[Vec<f64>], into: &mut [Vec<bool>]) {
    for i in 0..jy.len() {
        for j in 0..jy.len() {
            if jy[i][j] != 0. || jp[i][j] != 0. {
                into[i][j] = true;
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Obs {
    Row(usize),
    Root(usize),
}
type Change = Box<dyn Fn(&mut Inputs, &mut Vec<f64>)>;
type Declared<'a> = (&'a str, Change, Vec<(Obs, i32)>);
fn ch(f: impl Fn(&mut Inputs, &mut Vec<f64>) + 'static) -> Change {
    Box::new(f)
}
/// One declared direction: the sign of each receiving observable (`rhs` for
/// a differential row, the residual for an algebraic row, an onset root),
/// declared before evaluating; rows that also moved are recorded. A
/// declared 0 admits a change within 1e-12 of the row scale (a contrast that
/// is zero only to the caloric inverse's precision), reported as exact or not.
fn direction(k: &Case, sc: &Scales, label: &str, change: &Change, expect: &[(Obs, i32)]) -> Value {
    let m = k.m;
    let base = k.eval();
    let (mut u, mut y) = (k.u, k.y.clone());
    change(&mut u, &mut y);
    let after = k.eval_at(&u, &y);
    let (r0, r1) = (onset_roots(m, &k.u, &k.y), onset_roots(m, &u, &y));
    let value = |e: &Eval, roots: &[f64], o: Obs| match o {
        Obs::Row(i) if m.is_diff(i) => e.rhs[i],
        Obs::Row(i) => e.f[i].v,
        Obs::Root(j) => roots[j],
    };
    let label_of = |o: Obs| match o {
        Obs::Row(i) => m.name(i),
        Obs::Root(j) => format!("{}.onsetRoot", m.steel[m.pool[j].steel].id),
    };
    let mut rows = vec![];
    for &(o, sign) in expect {
        let delta = value(&after, &r1, o) - value(&base, &r0, o);
        let scale = match o {
            Obs::Row(i) => sc.row(m, &k.u, i),
            Obs::Root(_) => 1.,
        };
        let ok = match sign {
            1 => delta > 0.,
            -1 => delta < 0.,
            _ => delta.abs() <= 1e-12 * scale,
        };
        assert!(
            ok,
            "{label}: {} moved {delta:e}, declared {sign}",
            label_of(o)
        );
        rows.push(json!({"observable": label_of(o), "declared": sign, "delta": delta, "scaledDelta": delta / scale}));
    }
    let declared: Vec<usize> = expect
        .iter()
        .filter_map(|(o, _)| if let Obs::Row(i) = o { Some(*i) } else { None })
        .collect();
    let mut also = vec![];
    for i in 0..m.n {
        if declared.contains(&i) {
            continue;
        }
        let d = value(&after, &r1, Obs::Row(i)) - value(&base, &r0, Obs::Row(i));
        if d != 0. {
            also.push(json!({"row": m.name(i), "delta": d}));
        }
    }
    json!({"change": label, "declared": rows, "undeclaredRowsMoved": also})
}

fn git_head(dir: &str) -> (String, bool) {
    let out = std::process::Command::new("git")
        .args(["-C", dir, "rev-parse", "HEAD"])
        .output()
        .expect("git rev-parse");
    let dirty = std::process::Command::new("git")
        .args(["-C", dir, "status", "--porcelain"])
        .output()
        .expect("git status");
    (
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        !dirty.stdout.is_empty(),
    )
}
fn sha256(path: &str) -> String {
    let out = std::process::Command::new("shasum")
        .args(["-a", "256", path])
        .output()
        .expect("shasum");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

/// Declared probe flows: `total` through the main path, half per tube group
/// (and on the header links that carry one group).
fn probe_flows(m: &Model, y: &mut [f64], total: f64) {
    for (l, k) in m.links.iter().enumerate() {
        let id = |e: End| m.end_name(e);
        let half = id(k.from).starts_with("PRHR.TUBE.")
            || id(k.to).starts_with("PRHR.TUBE.")
            || (id(k.from) == "PRHR.UPPER.1" && id(k.to) == "PRHR.UPPER.2")
            || (id(k.from) == "PRHR.LOWER.1" && id(k.to) == "PRHR.LOWER.2");
        y[m.pil(l)] = k.inertance * if half { total / 2. } else { total };
    }
    y[m.seat_l()] = total;
}

#[test]
#[ignore = "G1-C11 PRHR prototype: needs LD01_G1_C11_PACKET, LD01_G1_C11_WIKI and the operating IF97 library"]
fn g1_c11_prhr_prototype() {
    let (m, packet, packet_path) = load();
    let n = m.n;
    let u0 = Inputs::prepared(&packet);
    let (y0, prep) = prepare(&m, &u0);
    let sc = scales(&m, &y0);
    let yp0 = consistent_yp(&m, &u0, &y0);
    let prepared = Case {
        m: &m,
        u: u0,
        y: y0.clone(),
        yp: yp0.clone(),
    };

    // G1.2 census: slots (the compiler's convention) and mode-L rows.
    let slot_d = (0..n).filter(|&i| m.slot_differential(i)).count();
    let row_d = (0..n).filter(|&i| m.is_diff(i)).count();
    let compiler: Vec<&Value> = arr(&packet, "/census/owners")
        .iter()
        .filter(|o| o["owner"].as_str().unwrap().starts_with("PRHR"))
        .collect();
    let (cd, ca): (f64, f64) = compiler.iter().fold((0., 0.), |(d, a), o| {
        (d + num(o, "/differential"), a + num(o, "/algebraic"))
    });
    assert_eq!(
        slot_d as f64, cd,
        "differential slots agree with the compiler"
    );
    assert_eq!(
        (n - slot_d) as f64,
        ca,
        "algebraic slots, the shared surface temperatures included (PRHR.SURFACES), agree"
    );

    // G1.3 (a): scaled zero-time residual with consistent y'.
    let r0 = prepared.eval();
    let (z1, worst_row) = scaled_max(&prepared, &sc, &r0.f);
    assert!(
        z1 <= 1e-12,
        "scaled residual {z1:e} at {}",
        m.name(worst_row)
    );
    // Hydrostatic mismatch: the consistent Pi' of every path.
    let mut mismatch = vec![];
    let (mut mis_max, mut mis_at) = (0f64, String::new());
    for (l, k) in m.links.iter().enumerate() {
        let v = yp0[m.pil(l)];
        if v.abs() > mis_max {
            mis_max = v.abs();
            mis_at = k.name.clone();
        }
        mismatch.push(json!({"link": k.name, "consistentPiDot_Pa": v}));
    }
    let roots0 = onset_roots(&m, &u0, &y0);
    let onset0 = roots0.iter().cloned().fold(f64::INFINITY, f64::min);
    assert!(onset0 > 0., "prepared state at nucleate onset");
    let exposure = u0.surface - m.first_exposure;
    assert!(exposure > 0., "prepared bank exposed");

    // Probes.
    let mut open = Case {
        m: &m,
        u: Inputs { x: 1., ..u0 },
        y: y0.clone(),
        yp: vec![0.; n],
    };
    probe_flows(&m, &mut open.y, m.m_ref);
    open.yp = consistent_yp(&m, &open.u, &open.y);
    // Warm bank below onset: water 363.15 K, inner halves 358.15 K, outer
    // halves 353.15 K, surfaces midway; reversed circulation -40 kg/s,
    // x = 0.5; declared probe boron fractions.
    let mut warm = Case {
        m: &m,
        u: Inputs {
            x: 0.5,
            c_hot: 0.9e-3,
            c_sg: 1.2e-3,
            ..u0
        },
        y: y0.clone(),
        yp: vec![0.; n],
    };
    {
        let y = &mut warm.y;
        let (tw, t1, t2) = (363.15, 358.15, 353.15);
        // A warmer return below a cooler bank (actively mixing faces).
        let t_of = |r: usize| match m.parts[r].id.as_str() {
            _ if r == m.up => u0.t_hot,
            "PRHR.RETURN.ENTRANCE" => 368.15,
            "PRHR.RETURN.BANK" => 365.65,
            _ => tw,
        };
        for r in 0..m.nc {
            let t = t_of(r);
            let q = point(Branch::Liquid, y[m.cell(r, P)], t).expect("IF97 probe");
            let mass = q.density_kg_m3 * m.parts[r].volume;
            y[m.cell(r, ML)] = mass;
            y[m.cell(r, UL)] = mass * q.internal_energy_j_kg;
            let cfrac = if m.parts[r].id == "PRHR.RETURN.ENTRANCE" {
                1.1e-3
            } else {
                1e-3
            };
            y[m.cell(r, B)] = mass * cfrac;
        }
        for (s, st) in m.steel.iter().enumerate() {
            let t = match st.id.as_str() {
                "PRHR.SEAT.UP.SHELL" => 585.,
                "PRHR.DISC.1" => 570.,
                id if id.ends_with(".STEEL.2") => t2,
                _ => t1,
            };
            y[m.st(s)] = st.cap * t;
        }
        let tc = |y: &[f64], s: usize| y[m.st(s)] / m.steel[s].cap;
        for (k, ct) in m.inner.iter().enumerate() {
            y[m.ts(k)] = 0.5 * (t_of(ct.part) + tc(y, ct.steel));
        }
        for (k, fc) in m.faces.iter().enumerate() {
            let side = if fc.upstream { m.up } else { m.dn };
            y[m.ts(m.inner.len() + k)] = 0.5 * (t_of(side) + tc(y, fc.steel));
        }
        for (k, pc) in m.pool.iter().enumerate() {
            y[m.ts(m.inner.len() + m.faces.len() + k)] = 0.5 * (tc(y, pc.steel) + u0.t_wst);
        }
        probe_flows(&m, y, -40.);
    }
    warm.yp = consistent_yp(&m, &warm.u, &warm.y);
    let roots_warm = onset_roots(&m, &warm.u, &warm.y);
    let onset_warm = roots_warm.iter().cloned().fold(f64::INFINITY, f64::min);
    assert!(onset_warm > 0., "warm probe reached nucleate onset");

    // G1.3 (b): directions.
    let cell =
        |id: &str, k: usize| m.cell(m.parts.iter().position(|p| p.id == id).expect("region"), k);
    let link = |from: &str, to: &str| {
        m.pil(
            m.links
                .iter()
                .position(|l| l.name == format!("{from}->{to}"))
                .expect("link"),
        )
    };
    let pool_rows: Vec<(Obs, i32)> = (0..m.pool.len())
        .map(|k| (Obs::Row(m.ts(m.inner.len() + m.faces.len() + k)), -1))
        .collect();
    // A warmer pool takes less heat from (or gives more to) the outer halves.
    let pool_steel: Vec<(Obs, i32)> = m
        .pool
        .iter()
        .map(|pc| (Obs::Row(m.st(pc.steel)), 1))
        .collect();
    let pool_twst: Vec<(Obs, i32)> = pool_rows.iter().chain(&pool_steel).cloned().collect();
    let pool_zero: Vec<(Obs, i32)> = pool_rows.iter().map(|&(o, _)| (o, 0)).collect();
    let roots_up: Vec<(Obs, i32)> = (0..m.pool.len()).map(|k| (Obs::Root(k), 1)).collect();
    let exterior: Vec<(Obs, i32)> = m.gas.iter().map(|g| (Obs::Row(m.st(g.a)), 1)).collect();
    let hot_in = link("HOT.A.after", "PRHR.SEAT.UP");
    let sg_out = link("PRHR.RETURN.ENTRANCE", "SG.A.PRIMARY.outlet");
    let (up_u, dn_u) = (cell("PRHR.SEAT.UP", UL), cell("PRHR.SEAT.DOWN", UL));
    let ent_u = cell("PRHR.RETURN.ENTRANCE", UL);
    let bank_u = cell("PRHR.RETURN.BANK", UL);
    let low_u = cell("PRHR.LOWER.2", UL);
    let (face1, face2) = (m.ts(m.inner.len()), m.ts(m.inner.len() + 1));
    let seat = m.seat_l();
    let disc1 = m.st(m.faces[0].steel);
    let disc2 = m.st(m.faces[1].steel);
    let at_prepared: Vec<Declared> = vec![
        (
            "HOT.A.after pressure +1 kPa (seat closed)",
            ch(|u, _| u.p_hot += 1e3),
            vec![(Obs::Row(hot_in), 1), (Obs::Row(seat), 0)],
        ),
        (
            "HOT.A.after temperature +1 K (axial conduction into SEAT.UP; same elevation, no drive)",
            ch(|u, _| u.t_hot += 1.),
            vec![(Obs::Row(up_u), 1), (Obs::Row(hot_in), 0)],
        ),
        (
            "SG outlet pressure +1 kPa",
            ch(|u, _| u.p_sg += 1e3),
            vec![(Obs::Row(sg_out), -1)],
        ),
        (
            "SG outlet temperature +1 K (lighter SG side; stronger SG-end mixing)",
            ch(|u, _| u.t_sg += 1.),
            vec![(Obs::Row(sg_out), -1), (Obs::Row(ent_u), 1)],
        ),
        (
            "SG outlet velocity +0.1 m/s (stirring)",
            ch(|u, _| u.u_sg += 0.1),
            vec![
                (Obs::Row(ent_u), 1),
                (Obs::Row(bank_u), 0),
                (Obs::Row(low_u), 0),
            ],
        ),
        (
            "WST temperature +1 K",
            ch(|u, _| u.t_wst += 1.),
            pool_twst.clone(),
        ),
        (
            "WST surface +0.1 m (zero pool contrast: no pool heat)",
            ch(|u, _| u.surface += 0.1),
            pool_zero.clone(),
        ),
        (
            "CNV pressure +1 kPa (zero pool contrast: no pool heat)",
            ch(|u, _| u.p_cnv += 1e3),
            pool_zero.clone(),
        ),
        (
            "Containment environment +1 K (exposed connectors)",
            ch(|u, _| u.t_env += 1.),
            exterior.iter().map(|&(o, _)| (o, 1)).collect(),
        ),
    ];
    let mut directions = vec![];
    for (label, change, expect) in &at_prepared {
        directions.push(direction(
            &prepared,
            &sc,
            &format!("prepared: {label}"),
            change,
            expect,
        ));
    }
    let at_open: Vec<Declared> = vec![
        (
            "seat opening +0.01 at x=1, m>0 (valve loss falls; seat gap and disc faces turn)",
            ch(|u, _| u.x += 0.01),
            vec![
                (Obs::Row(seat), 1),
                (Obs::Row(up_u), -1),
                (Obs::Row(dn_u), 1),
                (Obs::Row(face1), 1),
                (Obs::Row(face2), -1),
                (Obs::Row(disc1), -1),
                (Obs::Row(disc2), 1),
            ],
        ),
        (
            "HOT.A.after pressure +1 kPa (open)",
            ch(|u, _| u.p_hot += 1e3),
            vec![(Obs::Row(hot_in), 1), (Obs::Row(seat), 0)],
        ),
    ];
    for (label, change, expect) in &at_open {
        directions.push(direction(
            &open,
            &sc,
            &format!("open: {label}"),
            change,
            expect,
        ));
    }
    let at_warm: Vec<Declared> = vec![
        (
            "seat opening +0.01 at x=0.5, m<0 (reverse flow: the signed loss rises toward zero)",
            ch(|u, _| u.x += 0.01),
            // SEAT.DOWN gains by the wider gap and both disc faces turning.
            vec![(Obs::Row(seat), -1), (Obs::Row(dn_u), 1)],
        ),
        (
            "WST temperature +1 K (warm bank)",
            ch(|u, _| u.t_wst += 1.),
            pool_twst.clone(),
        ),
        (
            "WST surface +0.1 m (deeper: higher local saturation, onset recedes)",
            ch(|u, _| u.surface += 0.1),
            roots_up.clone(),
        ),
        (
            "CNV pressure +1 kPa (onset recedes)",
            ch(|u, _| u.p_cnv += 1e3),
            roots_up.clone(),
        ),
        (
            "SG outlet velocity +0.1 m/s (SG hotter and richer than ENTRANCE, ENTRANCE than BANK)",
            ch(|u, _| u.u_sg += 0.1),
            vec![
                (Obs::Row(ent_u), 1),
                (Obs::Row(cell("PRHR.RETURN.ENTRANCE", B)), 1),
                (Obs::Row(bank_u), 1),
                (Obs::Row(cell("PRHR.RETURN.BANK", B)), 1),
            ],
        ),
        (
            "SG boron fraction +1e-4 (scalar mixing into ENTRANCE)",
            ch(|u, _| u.c_sg += 1e-4),
            vec![(Obs::Row(cell("PRHR.RETURN.ENTRANCE", B)), 1)],
        ),
    ];
    for (label, change, expect) in &at_warm {
        directions.push(direction(
            &warm,
            &sc,
            &format!("warm: {label}"),
            change,
            expect,
        ));
    }

    // G1.3 (c) and G1.2 pattern: partials, iteration matrices, nnz.
    let mut pat = vec![vec![false; n]; n];
    let mut partials = vec![];
    let mut pivots = vec![];
    for (label, k) in [
        ("prepared", &prepared),
        ("open x=1", &open),
        ("warm x=0.5", &warm),
    ] {
        let (jy, jp) = k.jacobian();
        pattern(&jy, &jp, &mut pat);
        let mut cmp = compare(k, &sc, &jy, label);
        if label.starts_with("warm") {
            assert_eq!(
                cmp["zeroContrastCuspEntries"]["excluded"], 0,
                "the warm probe has every contrast nonzero: no cusp exclusion"
            );
        }
        cmp["state"] = json!(label);
        partials.push(cmp);
        let piv: Vec<f64> = [1e1, 1e3, 1e5]
            .iter()
            .map(|&cj| min_pivot(k, &sc, &jy, &jp, cj))
            .collect();
        assert!(
            piv.iter().all(|&x| x > 1e-14),
            "{label}: singular iteration matrix {piv:?}"
        );
        let e = k.eval();
        pivots.push(json!({"state": label, "cj": [1e1, 1e3, 1e5], "minScaledPivot": piv,
            "poolHeat_W": e.pool_heat_w, "connectorHeat_W": e.connector_w, "seatDrive_Pa": e.seat_drive_pa}));
    }
    let nnz: usize = pat.iter().map(|r| r.iter().filter(|&&x| x).count()).sum();

    // G1.4 cost.
    cpu::prefer_performance_core();
    let reps = 200;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        std::hint::black_box(prepared.eval());
    }
    let res_prepared = (cpu::thread_cpu_s() - t0) / reps as f64;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..reps {
        std::hint::black_box(warm.eval());
    }
    let res_warm = (cpu::thread_cpu_s() - t0) / reps as f64;
    let jreps = 3;
    let t0 = cpu::thread_cpu_s();
    for _ in 0..jreps {
        std::hint::black_box(warm.jacobian());
    }
    let jac = (cpu::thread_cpu_s() - t0) / jreps as f64;

    let app = env!("CARGO_MANIFEST_DIR");
    let wiki = std::env::var("LD01_G1_C11_WIKI").expect("LD01_G1_C11_WIKI: the wiki worktree");
    let (app_head, app_dirty) = git_head(app);
    let (wiki_head, wiki_dirty) = git_head(&wiki);
    let receipt = json!({
        "lane": "g1-c11",
        "kind": "Gate-1 design prototype, PRHR part of C11 (test-only, never joined, never a gate)",
        "provenance": {"appHead": app_head, "appDirty": app_dirty, "wikiHead": wiki_head, "wikiDirty": wiki_dirty,
            "packet": packet_path, "packetSha256": sha256(&packet_path), "packetProvenance": packet["provenance"],
            "operatingWaterLibDir": std::env::var("LD01_OPERATING_WATER_LIB_DIR").unwrap_or_default()},
        "census": {"slots": {"differential": slot_d, "algebraic": n - slot_d, "total": n},
            "modeLRows": {"differential": row_d, "algebraic": n - row_d,
                "note": "the 20 locked vapor impulses are differential slots with algebraic L1 rows Pi_g = 0"},
            "compilerPrhr": {"differential": cd, "algebraic": ca},
            "addedAlgebraicSurfaceTemperatures": {"total": m.n_surf(), "innerContacts": m.inner.len(),
                "discFaces": m.faces.len(), "poolContacts": m.pool.len()},
            "structuralNnz": nnz, "patternStates": ["prepared", "open x=1", "warm x=0.5"]},
        "zeroTime": {"scaledMax": z1, "worstRow": m.name(worst_row),
            "hydrostaticMismatch": {"maxAbsConsistentPiDot_Pa": mis_max, "at": mis_at, "links": mismatch},
            "closedSeatDrive_Pa": r0.seat_drive_pa, "preparation": prep,
            "roots": {"minNucleateOnsetMargin_K": onset0, "exposureMargin_m": exposure,
                "packetInitialSurface_m": num(&packet, "/prhr/pool/initialSurface_m"), "heldSurface_m": u0.surface},
            "poolHeat_W": r0.pool_heat_w, "connectorHeat_W": r0.connector_w},
        "probes": {"open": "x=1, prepared temperatures, declared 350 kg/s (calibration flow) through the bank, 175 per group",
            "warm": "x=0.5, water 363.15 K, inner halves 358.15, outer 353.15, surfaces midway, -40 kg/s, declared boron 1e-3 (ENTRANCE 1.1e-3, SG 1.2e-3, HOT 0.9e-3)",
            "warmMinNucleateOnsetMargin_K": onset_warm},
        "directions": directions,
        "partials": partials,
        "iterationMatrix": pivots,
        "cost": {"residualPrepared_s": res_prepared, "residualWarm_s": res_warm, "denseJacobian_s": jac,
            "denseSweeps": 2 * n, "loadAverage": cpu::load_average()},
        "deviationsAndMissing": [
            "MISSING: primary dissolved-absorber fraction at HOT.A.after/SG outlet (C06 port; residual-heat-exchanger.md selects B = c_initial M with the adjacent primary's fraction) is not in the packet: held 0 at the preparation, declared only at the warm probe",
            "MISSING in packet: reference-prhr-isolation discDiameter_m/discThickness_m; recovered exactly from disc capacity and center conductance (A = sqrt(C_half G/(rho cp k)), R_face = 1/(2G)); disc diameter and thickness reported below",
            "ADDED: 35 algebraic surface temperatures (19 inner, 2 disc faces, 14 pool) for the selected series film law",
            "REPRESENTATION: one surface temperature per disc face with its area split by the rotating fractions (wiki: each face's area counted once); the native cold join used four full-area face/side contacts weighted after the series solve",
            "SCOPE: pool boiling branch not implemented; nucleate onset is a root refused at every evaluated state; exposure (surface - firstExposure) a root, fully immersed here",
            "PORTS: WST surface 14.148275 m held from ld01-cnv-pools (packet pool.initialSurface_m reported beside it)"
        ],
        "disc": {"area_m2": m.disc_area, "diameter_m": m.disc_bore, "faceResistance_K_W": m.disc_r,
            "thickness_m": 2. * m.steel[m.faces[0].steel].cap / (num(&packet, "/prhr/geometry/steelDensity_kg_m3") * num(&packet, "/prhr/geometry/steelCp_J_kgK") * m.disc_area)},
    });
    let text = serde_json::to_string_pretty(&receipt).unwrap();
    if let Ok(out) = std::env::var("LD01_G1_C11_PRHR_RECEIPT") {
        assert!(
            !std::path::Path::new(&out).exists(),
            "receipt {out} exists: receipts are never overwritten"
        );
        std::fs::write(&out, &text).expect("receipt");
    }
    println!("{text}");
}

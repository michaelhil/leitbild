//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/turbine-and-regeneration-dynamics.md#compact-operating-allocation-15-october-2026
//! G1-C10 Gate-1 standalone block prototype: steam, turbine and condenser.
//! TEST ONLY: never joined to the kernel, never a gate, no trajectory.
//!
//! Own rows on maintained IF97 (the ELEC-slice pattern), at zero time:
//! - nine fluid stores, each `M_w, M_air, M_N2, U` (COND `E=U+PE`)
//!   differential and `p, h` algebraic;
//! - the RH wall, four casing bodies, two condenser walls and two CW cells
//!   (one differential energy each), and the STOP/ADM junction pressure;
//! - signed nozzle branches through the kernel's
//!   [`stratified::restriction_flux`], and five turbine intervals with the
//!   selected finite torque law.
//!
//! Neighbours' quantities are held port inputs: SG faces (C08), C09's
//! receiving shells and flows, C12's CW, C15's speed and C12's room.
//!
//! Every row and its partials are computed in one forward-mode pass per
//! direction (property directions from the IF97 boundary), so "analytic"
//! here means the exact directional derivative of the same computation. It
//! is compared with central differences. Noncondensable masses are
//! coordinates, but this prototype evaluates the pure-water branch only and
//! refuses a nonzero gas mass (no S5 composition admits gas: G1-C10 ports
//! A1).
//! Opt-in: `LD01_G1_C10_PACKET` (compiled by
//! `reference-design-operating-steam.ts`) and `LD01_G1_C10_RECEIPT`.
use leitbild_operating_plant::{
    network::{Properties, ports::G, properties as props, stratified},
    thermal::{Saturation, Scalar},
};
// S4-D2 (owner decision F5): C10 declares a low-pressure domain for its
// vacuum stores (TG.LP2 0.05 MPa, LD01.COND 7.38 kPa); the prototype's one
// property object is the bridge's low-pressure owner (its Gate-1 evidence ran
// on a library with IF97's own floor). Per-store scoping is for the joined
// owner.
use leitbild_operating_water::If97LowPressure;
use serde_json::{Value, json};

mod common;
use common::cpu;

const NS: usize = 9;
const MW: usize = 0;
const MA: usize = 1;
const MN: usize = 2;
const U: usize = 3;
const P: usize = 4;
const H: usize = 5;
const SOLIDS: usize = 6 * NS; // RH wall, casings HP1/HP2/LP1/LP2, COND walls 1/2
const CELLS: usize = SOLIDS + 7;
const JUNCTION: usize = CELLS + 2;
const N: usize = JUNCTION + 1;
const HEADER: usize = 0;
const HP1: usize = 1;
const HP2: usize = 2;
const SEP: usize = 3;
const RHP: usize = 4;
const RHS: usize = 5;
const LP1: usize = 6;
const LP2: usize = 7;
const COND: usize = 8;
const IDS: [&str; NS] = [
    "MS.HEADER",
    "TG.HP1",
    "TG.HP2",
    "TG.SEP",
    "TG.RH.PROCESS",
    "TG.RH.SHELL",
    "TG.LP1",
    "TG.LP2",
    "LD01.COND",
];
const CASED: [usize; 4] = [HP1, HP2, LP1, LP2];

fn c(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn sqrt(x: Scalar) -> Scalar {
    let v = x.value.sqrt();
    Scalar::new(v, if v > 0. { x.direction / (2. * v) } else { 0. })
}
fn num(v: &Value, key: &str) -> f64 {
    v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("packet field {key} missing"))
}

fn sat<Q: Properties>(pp: &Q, p: Scalar) -> Result<Saturation, String> {
    Properties::saturation_caloric(pp, p)
}
/// Single-phase inverse at `(p, h)`: density, temperature, internal energy.
fn single<Q: Properties>(
    pp: &Q,
    p: Scalar,
    h: Scalar,
    vapor: bool,
) -> Result<(Scalar, Scalar), String> {
    let (q, d) = props::inverse_thermodynamic(pp, p, h, usize::from(vapor), true, None)
        .map_err(|e| format!("{e:?}"))?;
    Ok((
        Scalar::new(q.density_kg_m3, d.density_kg_m3),
        Scalar::new(q.temperature_k, d.temperature_k),
    ))
}

/// The pure-water store closure at `(p, h)`: homogeneous equilibrium in the dome.
#[derive(Clone, Copy)]
struct State {
    rho: Scalar,
    t: Scalar,
    /// Quality and the saturation endpoints when wet.
    wet: Option<(Scalar, Saturation)>,
    /// Compressed liquid below the dome.
    subcooled: bool,
    hf: Scalar,
    hg: Scalar,
}
fn closure<Q: Properties>(pp: &Q, p: Scalar, h: Scalar) -> Result<State, String> {
    let s = sat(pp, p)?;
    let (hf, hg) = (s.liquid.enthalpy, s.vapor.enthalpy);
    if h.value < hf.value || h.value > hg.value {
        let (rho, t) = single(pp, p, h, h.value > hg.value)?;
        return Ok(State {
            rho,
            t,
            wet: None,
            subcooled: h.value < hf.value,
            hf,
            hg,
        });
    }
    let x = (h - hf) / (hg - hf);
    let v = (c(1.) - x) / s.liquid.density + x / s.vapor.density;
    Ok(State {
        rho: c(1.) / v,
        t: s.temperature,
        wet: Some((x, s)),
        subcooled: false,
        hf,
        hg,
    })
}
/// Liquid mass and volume of a store of total water `m`.
fn liquid(m: Scalar, st: &State) -> (Scalar, Scalar) {
    match st.wet {
        Some((x, s)) => {
            let ml = m * (c(1.) - x);
            (ml, ml / s.liquid.density)
        }
        None if st.subcooled => (m, m / st.rho),
        None => (c(0.), c(0.)),
    }
}

/// Mass flux per unit area from donor `(p0, h0)` to `pb` (pb < p0).
fn flux<Q: Properties>(pp: &Q, p0: Scalar, h0: Scalar, pb: Scalar) -> Result<Scalar, String> {
    let s0 = sat(pp, p0)?;
    let vapor = h0.value >= s0.liquid.enthalpy.value;
    stratified::restriction_flux(pp, vapor, p0, h0, pb)
        .map(|f| f.mass_flux)
        .map_err(|e| format!("{e:?}"))
}
/// Specific volume on the energy adiabat (the restriction path's own rule).
fn path_volume<Q: Properties>(pp: &Q, p: Scalar, h: Scalar) -> Result<Scalar, String> {
    Ok(c(1.) / closure(pp, p, h)?.rho)
}
/// Reversible drop `h0 - h(pb)` along `dh/dp = v` by RK4 in ln p (0.02, the restriction law's
/// own step; coarser steps only for the cost-option diagnostic).
fn adiabat_drop_step<Q: Properties>(
    pp: &Q,
    p0: Scalar,
    h0: Scalar,
    pb: Scalar,
    step: f64,
) -> Result<Scalar, String> {
    let ratio = (-step).exp();
    let (mut p, mut h) = (p0, h0);
    while p.value > pb.value {
        let next = if p.value * ratio > pb.value {
            p * c(ratio)
        } else {
            pb
        };
        let dp = next - p;
        let mid = (p + next) * c(0.5);
        let k1 = path_volume(pp, p, h)?;
        let k2 = path_volume(pp, mid, h + dp * k1 * c(0.5))?;
        let k3 = path_volume(pp, mid, h + dp * k2 * c(0.5))?;
        let k4 = path_volume(pp, next, h + dp * k3)?;
        h = h + dp * (k1 + c(2.) * k2 + c(2.) * k3 + k4) / c(6.);
        p = next;
    }
    Ok(h0 - h)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Face {
    Homogeneous,
    /// SEP upper pickup: gas below the sill, area partition across the span.
    Pickup,
    /// Bottom drain: liquid while above the 5 % pickup, gas at or below.
    Bottom,
}
#[derive(Clone, Copy, Debug)]
enum End {
    Store(usize, Face),
    Sg(usize),
    Junction,
    /// C09 receiving shell: index into the held receiver pressures.
    Shell(usize),
}
#[derive(Clone, Debug)]
enum Law {
    Nozzle {
        check: bool,
    },
    Interval {
        radius: f64,
        eta: f64,
        reference: f64,
    },
}
#[derive(Clone, Debug)]
struct Branch {
    id: String,
    from: End,
    to: End,
    law: Law,
    area: f64,
    opening: f64,
}

/// Held port inputs (directions seed the port checks).
#[derive(Clone, Copy)]
struct Ports {
    p_sg: [Scalar; 2],
    /// C09 shells H2, H4.
    p_shell: [Scalar; 2],
    /// C09 extraction withdrawals H4 (HP2), H3 (SEP pickup), H2 (LP1), H1 (LP2).
    ext: [Scalar; 4],
    m_h1: Scalar,
    h_h1: Scalar,
    m_cond: Scalar,
    m_cw: Scalar,
    /// C12's inlet total enthalpy at cell 1 (port P9).
    h_cw: Scalar,
    /// Each cell's hydraulic pressure: the native cells need it (P9 extension; held, not seeded).
    p_cell: [Scalar; 2],
    omega: Scalar,
    t_room: Scalar,
}
const PORT_NAMES: [&str; 15] = [
    "C08 SG.A pressure",
    "C08 SG.B pressure",
    "C09 H2 shell pressure",
    "C09 H4 shell pressure",
    "C09 H4 extraction flow",
    "C09 H3 extraction flow",
    "C09 H2 extraction flow",
    "C09 H1 extraction flow",
    "C09 H1 drain flow (P7)",
    "C09 H1 drain enthalpy (P7)",
    "C09 COND.P flow (P8)",
    "C12 CW flow",
    "C12 CW inlet total enthalpy",
    "C15 shaft speed",
    "C12 room temperature",
];
impl Ports {
    fn seeded(&self, k: usize, d: f64) -> Ports {
        let mut q = *self;
        let bump = |x: &mut Scalar| x.direction = d;
        match k {
            0 => bump(&mut q.p_sg[0]),
            1 => bump(&mut q.p_sg[1]),
            2 => bump(&mut q.p_shell[0]),
            3 => bump(&mut q.p_shell[1]),
            4..=7 => bump(&mut q.ext[k - 4]),
            8 => bump(&mut q.m_h1),
            9 => bump(&mut q.h_h1),
            10 => bump(&mut q.m_cond),
            11 => bump(&mut q.m_cw),
            12 => bump(&mut q.h_cw),
            13 => bump(&mut q.omega),
            14 => bump(&mut q.t_room),
            _ => unreachable!(),
        }
        q
    }
    fn value(&self, k: usize) -> f64 {
        match k {
            0 | 1 => self.p_sg[k].value,
            2 | 3 => self.p_shell[k - 2].value,
            4..=7 => self.ext[k - 4].value,
            8 => self.m_h1.value,
            9 => self.h_h1.value,
            10 => self.m_cond.value,
            11 => self.m_cw.value,
            12 => self.h_cw.value,
            13 => self.omega.value,
            14 => self.t_room.value,
            _ => unreachable!(),
        }
    }
    fn shifted(&self, k: usize, dv: f64) -> Ports {
        let mut q = *self;
        let add = |x: &mut Scalar| x.value += dv;
        match k {
            0 => add(&mut q.p_sg[0]),
            1 => add(&mut q.p_sg[1]),
            2 => add(&mut q.p_shell[0]),
            3 => add(&mut q.p_shell[1]),
            4..=7 => add(&mut q.ext[k - 4]),
            8 => add(&mut q.m_h1),
            9 => add(&mut q.h_h1),
            10 => add(&mut q.m_cond),
            11 => add(&mut q.m_cw),
            12 => add(&mut q.h_cw),
            13 => add(&mut q.omega),
            14 => add(&mut q.t_room),
            _ => unreachable!(),
        }
        q
    }
}

struct Model {
    volume: [f64; NS],
    casing: [(f64, f64); 4],
    room_contact: f64,
    rh_wall: (f64, f64, f64),    // capacity, shell G, process G
    cond_walls: [(f64, f64); 2], // capacity, G (shell = water side)
    /// Fixed cell masses (native water at the prepared state).
    cells: [f64; 2],
    branches: Vec<Branch>,
    sep_pickup: (f64, f64),
    drain_fraction: f64,
    hotwell_area: f64,
    eye: f64,
    flow_scale: f64,
    /// Cost breakdown only: the interval drops held at their cycle references.
    reference_drops: bool,
    /// RK4 step in ln p of the interval reversible drops: 0.1 by S4-D8 (the restriction
    /// law's own 0.02 is kept for the flows and measured here as the comparison).
    drop_step: f64,
}

/// One evaluation: rows and a few diagnostics.
struct Eval {
    rows: Vec<Scalar>,
    torque: Scalar,
    aero_work: Scalar,
    flows: Vec<(String, Scalar)>,
}

impl Model {
    fn face<Q: Properties>(
        &self,
        pp: &Q,
        y: &[Scalar],
        st: &[State],
        e: End,
        ports: &Ports,
    ) -> (Scalar, Scalar) {
        match e {
            End::Store(i, Face::Homogeneous) => (y[6 * i + P], y[6 * i + H]),
            End::Store(i, Face::Pickup) => (y[6 * i + P], st[i].hg),
            End::Store(i, Face::Bottom) => {
                let (_, vl) = liquid(y[6 * i + MW], &st[i]);
                let h = if vl.value > self.drain_fraction * self.volume[i] {
                    st[i].hf
                } else {
                    st[i].hg
                };
                (y[6 * i + P], h)
            }
            End::Sg(k) => {
                let s = sat(pp, ports.p_sg[k]).expect("SG saturation");
                (ports.p_sg[k], s.vapor.enthalpy)
            }
            End::Junction => (y[JUNCTION], y[6 * HEADER + H]),
            End::Shell(k) => (ports.p_shell[k], c(f64::NAN)),
        }
    }
    fn eval<Q: Properties>(
        &self,
        pp: &Q,
        y: &[Scalar],
        yp: &[Scalar],
        ports: &Ports,
    ) -> Result<Eval, String> {
        let mut st = Vec::with_capacity(NS);
        for i in 0..NS {
            if y[6 * i + MA].value != 0. || y[6 * i + MN].value != 0. {
                return Err(format!(
                    "{}: nonzero noncondensable mass is outside this prototype",
                    IDS[i]
                ));
            }
            st.push(closure(pp, y[6 * i + P], y[6 * i + H])?);
        }
        let mut dm = [c(0.); NS];
        let mut de = [c(0.); NS];
        let mut to_junction = c(0.);
        let mut from_junction = c(0.);
        let mut torque = c(0.);
        let mut work = c(0.);
        let mut flows = Vec::new();
        for b in &self.branches {
            if b.opening == 0. {
                flows.push((b.id.clone(), c(0.)));
                continue;
            }
            let (pu, hu) = self.face(pp, y, &st, b.from, ports);
            let (pd, hd) = self.face(pp, y, &st, b.to, ports);
            let forward = pu.value > pd.value;
            let (p0, h0, pb) = if forward { (pu, hu, pd) } else { (pd, hd, pu) };
            let blocked = matches!(b.law, Law::Nozzle { check: true }) && !forward;
            let m = if pu.value == pd.value || blocked {
                c(0.)
            } else {
                if h0.value.is_nan() {
                    return Err(format!(
                        "{}: reverse flow from a C09 shell is outside this prototype",
                        b.id
                    ));
                }
                let g = match (b.from, forward) {
                    // SEP upper pickup: area partition between gas and liquid.
                    (End::Store(i, Face::Pickup), true) => {
                        let (_, vl) = liquid(y[6 * i + MW], &st[i]);
                        let f = ((vl - c(self.sep_pickup.0))
                            / c(self.sep_pickup.1 - self.sep_pickup.0))
                        .value;
                        if f > 0. {
                            return Err(
                                "SEP pickup coverage is outside this zero-time prototype".into()
                            );
                        }
                        flux(pp, p0, h0, pb)?
                    }
                    _ => flux(pp, p0, h0, pb)?,
                };
                let m = c(b.area * b.opening) * g;
                if forward { m } else { -m }
            };
            flows.push((b.id.clone(), m));
            // Transported total enthalpy is the donor's; intervals withdraw work.
            let mut received = m * h0;
            let sent = m * h0;
            if let (
                Law::Interval {
                    radius,
                    eta,
                    reference,
                },
                true,
            ) = (&b.law, forward && m.value != 0.)
            {
                let drop = match self.reference_drops {
                    true => c(*reference),
                    false => adiabat_drop_step(pp, p0, h0, pb, self.drop_step)?,
                };
                let v = sqrt(c(2.) * drop);
                let tau = c(2. * eta * radius) * m * (v - c(*radius) * ports.omega);
                let p_aero = tau * ports.omega;
                torque = torque + tau;
                work = work + p_aero;
                received = received - p_aero;
            }
            match b.from {
                End::Store(i, _) => {
                    dm[i] = dm[i] - m;
                    de[i] = de[i] - sent;
                }
                End::Junction => from_junction = from_junction + m,
                _ => {}
            }
            match b.to {
                End::Store(i, _) => {
                    dm[i] = dm[i] + m;
                    de[i] = de[i] + received;
                }
                End::Junction => to_junction = to_junction + m,
                _ => {}
            }
        }
        // C09 extraction withdrawals (held flows; donor material is this owner's).
        for (k, (i, face)) in [
            (HP2, Face::Homogeneous),
            (SEP, Face::Pickup),
            (LP1, Face::Homogeneous),
            (LP2, Face::Homogeneous),
        ]
        .into_iter()
        .enumerate()
        {
            let (_, h) = self.face(pp, y, &st, End::Store(i, face), ports);
            dm[i] = dm[i] - ports.ext[k];
            de[i] = de[i] - ports.ext[k] * h;
        }
        // COND: H1 drain in (P7), condensate out at the eye (P8) with h + g z.
        let (ml_c, vl_c) = liquid(y[6 * COND + MW], &st[COND]);
        let surface = c(self.eye) + vl_c / c(self.hotwell_area);
        dm[COND] = dm[COND] + ports.m_h1 - ports.m_cond;
        de[COND] =
            de[COND] + ports.m_h1 * ports.h_h1 - ports.m_cond * (st[COND].hf + c(G) * surface);
        // Solids.
        let t_of = |i: usize| st[i].t;
        let mut rows = vec![c(0.); N];
        let (cw, gs, gp) = self.rh_wall;
        let tw = y[SOLIDS] / c(cw) + c(273.15);
        let q_shell = c(gs) * (t_of(RHS) - tw);
        let q_proc = c(gp) * (tw - t_of(RHP));
        de[RHS] = de[RHS] - q_shell;
        de[RHP] = de[RHP] + q_proc;
        rows[SOLIDS] = yp[SOLIDS] - (q_shell - q_proc);
        for (k, i) in CASED.into_iter().enumerate() {
            let (cap, g) = self.casing[k];
            let tb = y[SOLIDS + 1 + k] / c(cap) + c(273.15);
            let q = c(g) * (t_of(i) - tb);
            let q_room = c(self.room_contact) * (tb - ports.t_room);
            de[i] = de[i] - q;
            rows[SOLIDS + 1 + k] = yp[SOLIDS + 1 + k] - (q - q_room);
        }
        // Native-water cells (the condenser page's preparation selects native water;
        // S4-D4 as corrected): fixed mass, energy differential, T and h recovered at
        // each cell's hydraulic pressure.
        let mut h_in = ports.h_cw;
        for k in 0..2 {
            let (cap, g) = self.cond_walls[k];
            let tw = y[SOLIDS + 5 + k] / c(cap) + c(273.15);
            let u = y[CELLS + k] / c(self.cells[k]);
            let (q, d) = props::inverse_thermodynamic(pp, ports.p_cell[k], u, 0, false, None)
                .map_err(|e| format!("CW cell {k}: {e:?}"))?;
            let tc = Scalar::new(q.temperature_k, d.temperature_k);
            let hc = Scalar::new(q.enthalpy_j_kg, d.enthalpy_j_kg);
            let q_shell = c(g) * (t_of(COND) - tw);
            let q_water = c(g) * (tw - tc);
            de[COND] = de[COND] - q_shell;
            rows[SOLIDS + 5 + k] = yp[SOLIDS + 5 + k] - (q_shell - q_water);
            rows[CELLS + k] = yp[CELLS + k] - (ports.m_cw * (h_in - hc) + q_water);
            h_in = hc;
        }
        for i in 0..NS {
            let b = 6 * i;
            let (m, u, p, h) = (y[b + MW], y[b + U], y[b + P], y[b + H]);
            rows[b + MW] = yp[b + MW] - dm[i];
            rows[b + MA] = yp[b + MA];
            rows[b + MN] = yp[b + MN];
            rows[b + U] = yp[b + U] - de[i];
            rows[b + P] = m - c(self.volume[i]) * st[i].rho;
            let mut energy = m * (h - p / st[i].rho);
            if i == COND {
                // PE = g M_l (z_floor + level/2), level = V_l / area.
                energy = energy + c(G) * ml_c * (c(self.eye) + vl_c / c(2. * self.hotwell_area));
            }
            rows[b + H] = u - energy;
        }
        rows[JUNCTION] = (to_junction - from_junction) / c(self.flow_scale);
        Ok(Eval {
            rows,
            torque,
            aero_work: work,
            flows,
        })
    }
}

fn store_end(id: &str, face: Face) -> End {
    match id {
        "SG.A" => End::Sg(0),
        "SG.B" => End::Sg(1),
        "TG.ADM.JUNCTION" => End::Junction,
        "FW.H2.SHELL" => End::Shell(0),
        "FW.H4.SHELL" => End::Shell(1),
        _ => End::Store(
            IDS.iter()
                .position(|s| *s == id)
                .unwrap_or_else(|| panic!("unknown end {id}")),
            face,
        ),
    }
}

struct Prepared {
    model: Model,
    y: Vec<f64>,
    ports: Ports,
    sizing: Vec<Value>,
    t_cond_sat: f64,
}

fn prepare(packet: &Value) -> Prepared {
    // Stores at their prepared (p, h).
    let mut ph = [(0., 0.); NS];
    let mut vol = [0.; NS];
    for (i, s) in packet["stores"].as_array().unwrap().iter().enumerate() {
        assert_eq!(s["id"], IDS[i]);
        vol[i] = num(s, "volume_m3");
        let pr = &s["prepared"];
        let p = num(pr, "pressure_Pa");
        let h = match pr["kind"].as_str().unwrap() {
            "throttledSaturatedVapor" => {
                sat(&If97LowPressure, c(num(pr, "fromSaturationPressure_Pa")))
                    .unwrap()
                    .vapor
                    .enthalpy
                    .value
            }
            "pressureEnthalpy" => num(pr, "enthalpy_J_kg"),
            "pressureTemperature" => {
                Properties::forward(&If97LowPressure, true, p, num(pr, "temperature_K"))
                    .unwrap()
                    .enthalpy_j_kg
            }
            "saturatedLiquidVolume" => {
                let s = sat(&If97LowPressure, c(p)).unwrap();
                let vl = num(pr, "liquid_m3");
                let (ml, mg) = (
                    s.liquid.density.value * vl,
                    s.vapor.density.value * (vol[i] - vl),
                );
                (ml * s.liquid.enthalpy.value + mg * s.vapor.enthalpy.value) / (ml + mg)
            }
            k => panic!("unknown preparation {k}"),
        };
        ph[i] = (p, h);
    }
    let t_cond_sat = sat(&If97LowPressure, c(ph[COND].0))
        .unwrap()
        .temperature
        .value;
    let mut y = vec![0.; N];
    let mut temps = [0.; NS];
    for i in 0..NS {
        let (p, h) = ph[i];
        let st = closure(&If97LowPressure, c(p), c(h)).unwrap();
        let pr = &packet["stores"][i]["prepared"];
        // M and U from the preparation's own route (phase split or forward p-T), not from
        // the (p, h) closure the rows use, so the zero-time rows test that closure.
        let (m, mut e) = match pr["kind"].as_str().unwrap() {
            "saturatedLiquidVolume" => {
                let s = sat(&If97LowPressure, c(p)).unwrap();
                let vl = num(pr, "liquid_m3");
                let (rf, rg) = (s.liquid.density.value, s.vapor.density.value);
                let (ml, mg) = (rf * vl, rg * (vol[i] - vl));
                (
                    ml + mg,
                    ml * (s.liquid.enthalpy.value - p / rf)
                        + mg * (s.vapor.enthalpy.value - p / rg),
                )
            }
            "pressureTemperature" => {
                let w = Properties::forward(&If97LowPressure, true, p, num(pr, "temperature_K"))
                    .unwrap();
                let m = vol[i] * w.density_kg_m3;
                (m, m * w.internal_energy_j_kg)
            }
            _ => {
                let m = vol[i] * st.rho.value;
                (m, m * (h - p / st.rho.value))
            }
        };
        if i == COND {
            let (ml, vl) = liquid(c(m), &st);
            let area = num(&packet["condenser"], "hotwellArea_m2");
            e += G * ml.value * (num(&packet["condenser"], "floor_m") + vl.value / (2. * area));
        }
        y[6 * i + MW] = m;
        y[6 * i + U] = e;
        y[6 * i + P] = p;
        y[6 * i + H] = h;
        temps[i] = st.t.value;
    }
    // RH wall: halfway between the shell's saturation and the process outlet;
    // each side's conductance from the reference reheat duty.
    let rh = &packet["reheater"];
    let rz = &rh["sizing"];
    let hg_sep = sat(&If97LowPressure, c(num(&rz["processInlet"], "pressure_Pa")))
        .unwrap()
        .vapor
        .enthalpy
        .value;
    let q_ref = num(rz, "processFlow_kg_s") * (num(rz, "processOutlet_J_kg") - hg_sep);
    let t_out = num(rz, "processOutlet_K");
    let t_sat_rhs = temps[RHS];
    let t_w0 = 0.5 * (t_sat_rhs + t_out);
    let rh_wall = (
        num(rh, "wall_J_K"),
        q_ref / (t_sat_rhs - t_w0),
        q_ref / (t_w0 - t_out),
    );
    let reheater_sizing = json!({"referenceDuty_W": q_ref, "shellSaturation_K": t_sat_rhs, "wallPrepared_K": t_w0,
        "shellConductance_W_K": rh_wall.1, "processConductance_W_K": rh_wall.2});
    y[SOLIDS] = rh_wall.0 * (t_w0 - 273.15);
    let mut casing = [(0., 0.); 4];
    for (k, i) in CASED.into_iter().enumerate() {
        let cs = &packet["stores"][i]["casing"];
        casing[k] = (num(cs, "capacity_J_K"), num(cs, "contact_W_K"));
        y[SOLIDS + 1 + k] = casing[k].0 * (temps[i] - 273.15);
    }
    let cd = &packet["condenser"];
    let mut cond_walls = [(0., 0.); 2];
    let mut cells = [0.; 2];
    // Cell pressures from the compiler: the owner's equal split with C12's prepared head (P9).
    let p_cell = [
        num(&cd["cells"][0], "pressure_Pa"),
        num(&cd["cells"][1], "pressure_Pa"),
    ];
    for k in 0..2 {
        let w = &cd["walls"][k];
        cond_walls[k] = (num(w, "capacity_J_K"), num(w, "shellConductance_W_K"));
        assert_eq!(
            num(w, "shellConductance_W_K"),
            num(w, "waterConductance_W_K")
        );
        y[SOLIDS + 5 + k] = cond_walls[k].0 * (num(w, "prepared_K") - 273.15);
        let cl = &cd["cells"][k];
        let w =
            Properties::forward(&If97LowPressure, false, p_cell[k], num(cl, "prepared_K")).unwrap();
        cells[k] = num(cl, "volume_m3") * w.density_kg_m3;
        y[CELLS + k] = cells[k] * w.internal_energy_j_kg;
    }
    y[JUNCTION] = num(&packet["junctions"][0], "prepared_Pa");
    // Branch areas from their sizing points with the runtime nozzle law.
    let mut branches = Vec::new();
    let mut sizing = Vec::new();
    let mut areas = std::collections::BTreeMap::new();
    let requests = &packet["prepared"]["requests"];
    let opening_of = |id: &str| -> f64 {
        match id {
            "MS.ISO.A" | "MS.ISO.B" => num(requests, "msIsolation"),
            "TG.STOP" => num(requests, "stop"),
            "TG.ADM" => num(requests, "admission"),
            "TG.RH.ISO" => num(requests, "reheaterIsolation"),
            "TG.BYP" => num(requests, "bypass"),
            "TG.SEP.DRAIN" => num(requests, "separatorDrain"),
            "TG.SEP.EMERGENCY" => num(requests, "separatorEmergency"),
            "TG.RH.DRAIN" => num(requests, "reheaterDrain"),
            _ => 1.,
        }
    };
    let inlet = |b: &Value, from: usize| -> (f64, f64) {
        let si = &b["sizingInlet"];
        if si.is_null() {
            return ph[from];
        }
        let p = num(si, "pressure_Pa");
        match si["kind"].as_str().unwrap() {
            "saturatedVapor" => (p, sat(&If97LowPressure, c(p)).unwrap().vapor.enthalpy.value),
            "saturatedLiquid" => (
                p,
                sat(&If97LowPressure, c(p)).unwrap().liquid.enthalpy.value,
            ),
            "throttledSaturatedVapor" => (
                p,
                sat(&If97LowPressure, c(num(si, "fromSaturationPressure_Pa")))
                    .unwrap()
                    .vapor
                    .enthalpy
                    .value,
            ),
            k => panic!("unknown sizing inlet {k}"),
        }
    };
    for b in packet["branches"].as_array().unwrap() {
        let id = b["id"].as_str().unwrap().to_string();
        let (from_id, to_id) = (b["from"].as_str().unwrap(), b["to"].as_str().unwrap());
        let from_face = match (id.as_str(), from_id) {
            ("TG.SEP.RH", _) => Face::Pickup,
            ("TG.SEP.DRAIN" | "TG.SEP.EMERGENCY" | "TG.RH.DRAIN", _) => Face::Bottom,
            _ => Face::Homogeneous,
        };
        let from = store_end(from_id, from_face);
        let to = store_end(to_id, Face::Homogeneous);
        let from_index = match from {
            End::Store(i, _) => i,
            _ => HEADER,
        };
        let (law, area, record) = match b["law"].as_str().unwrap() {
            "nozzle" => {
                let (p0, h0) = inlet(b, from_index);
                let pb = num(b, "sizingOutlet_Pa");
                let g = flux(&If97LowPressure, c(p0), c(h0), c(pb)).unwrap().value;
                let area = match b["areaOf"].as_str() {
                    Some(other) => *areas.get(other).expect("areaOf precedes"),
                    None => num(b, "sizingFlow_kg_s") / (num(b, "sizingOpening") * g),
                };
                (
                    Law::Nozzle {
                        check: b["check"].as_bool().unwrap_or(false),
                    },
                    area,
                    json!({"id": id, "inlet_Pa": p0, "inletEnthalpy_J_kg": h0, "outlet_Pa": pb, "flux_kg_m2_s": g, "area_m2": area}),
                )
            }
            "interval" => {
                let (p0, h0) = ph[from_index];
                let to_index = match to {
                    End::Store(i, _) => i,
                    _ => unreachable!(),
                };
                let pb = ph[to_index].0;
                let g = flux(&If97LowPressure, c(p0), c(h0), c(pb)).unwrap().value;
                let area = num(b, "sizingFlow_kg_s") / g;
                (
                    Law::Interval {
                        radius: num(b, "radius_m"),
                        eta: num(b, "efficiency"),
                        reference: num(b, "referenceDrop_J_kg"),
                    },
                    area,
                    json!({"id": id, "inlet_Pa": p0, "inletEnthalpy_J_kg": h0, "outlet_Pa": pb, "flux_kg_m2_s": g, "area_m2": area}),
                )
            }
            "fixedArea" => {
                let area = num(b, "cdA_m2");
                let sz = &b["sizing"];
                let p0 = num(sz, "inlet_Pa");
                let g = flux(
                    &If97LowPressure,
                    c(p0),
                    sat(&If97LowPressure, c(p0)).unwrap().vapor.enthalpy,
                    c(num(sz, "outlet_Pa")),
                )
                .unwrap()
                .value;
                (
                    Law::Nozzle { check: false },
                    area,
                    json!({"id": id, "area_m2": area, "ownerSizingFlow_kg_s": num(sz, "flow_kg_s"), "kernelFlowAtOwnerSizing_kg_s": area * g}),
                )
            }
            k => panic!("unknown law {k}"),
        };
        areas.insert(id.clone(), area);
        sizing.push(record);
        branches.push(Branch {
            opening: opening_of(&id),
            id,
            from,
            to,
            law,
            area,
        });
    }
    sizing.push(json!({"id": "TG.RH.WALL", "sizing": reheater_sizing}));
    let held = &packet["heldPortsAtPreparation"];
    let ext = &held["extraction_kg_s"];
    let rec = &packet["receivers"];
    let p_sg = num(&packet["prepared"], "sg_Pa");
    let h1 = sat(&If97LowPressure, c(num(rec, "h1Shell_Pa")))
        .unwrap()
        .liquid
        .enthalpy
        .value;
    let ports = Ports {
        p_sg: [c(p_sg), c(p_sg)],
        p_shell: [c(num(rec, "h2Shell_Pa")), c(num(rec, "h4Shell_Pa"))],
        ext: [
            c(num(ext, "H4")),
            c(num(ext, "H3")),
            c(num(ext, "H2")),
            c(num(ext, "H1")),
        ],
        m_h1: c(num(held, "h1Drain_kg_s")),
        h_h1: c(h1),
        m_cond: c(num(held, "condensate_kg_s")),
        // C12's prepared P9 port: condenser flow and cell-1 inlet total enthalpy.
        m_cw: c(num(&cd["c12Port"], "cwFlow_kg_s")),
        h_cw: c(num(&cd["c12Port"], "inletTotalEnthalpy_J_kg")),
        p_cell: [c(p_cell[0]), c(p_cell[1])],
        omega: c(num(&packet["shaft"], "referenceSpeed_rad_s")),
        // Held port: C12's ROOM.B preparation, `ld01-support-rooms.initialB_C` 25.634 °C
        // (C12 wiki 349d4ed); in S5 the room is a labelled ledger (C12 port P17).
        t_room: c(273.15 + 25.634),
    };
    let sep = &packet["separator"];
    let pickup = sep["pickup_m3"].as_array().unwrap();
    let model = Model {
        volume: vol,
        casing,
        room_contact: num(&packet["casing"], "roomContact_W_K"),
        rh_wall,
        cond_walls,
        cells,
        branches,
        sep_pickup: (pickup[0].as_f64().unwrap(), pickup[1].as_f64().unwrap()),
        drain_fraction: num(sep, "drainPickupFraction"),
        hotwell_area: num(cd, "hotwellArea_m2"),
        eye: num(cd, "floor_m"),
        flow_scale: num(held, "condensate_kg_s"),
        reference_drops: false,
        // S4-D8: the interval reversible drops on RK4 step 0.1 in ln p.
        drop_step: 0.1,
    };
    Prepared {
        model,
        y,
        ports,
        sizing,
        t_cond_sat,
    }
}

fn scalars(y: &[f64], seed: Option<usize>) -> Vec<Scalar> {
    y.iter()
        .enumerate()
        .map(|(j, v)| Scalar::new(*v, if Some(j) == seed { 1. } else { 0. }))
        .collect()
}
fn values(v: &[Scalar]) -> Vec<f64> {
    v.iter().map(|x| x.value).collect()
}
/// Rates f(y): the differential rows at y' = 0, negated; algebraic rows as they are.
fn rates(m: &Model, y: &[f64], ports: &Ports) -> Vec<f64> {
    let e = m
        .eval(&If97LowPressure, &scalars(y, None), &vec![c(0.); N], ports)
        .unwrap();
    e.rows.iter().map(|r| -r.value).collect()
}
fn differential(k: usize) -> bool {
    if k < SOLIDS { k % 6 < P } else { k < JUNCTION }
}
/// Row scale for the scaled residual: flows for mass rows, enthalpy flows for energy rows,
/// the retained stock for algebraic rows.
fn row_scale(k: usize, y: &[f64], flow: f64) -> f64 {
    if k < SOLIDS {
        let b = k - k % 6;
        match k % 6 {
            MW | MA | MN => flow,
            U => flow * 3e6,
            P => y[b + MW].abs(),
            _ => y[b + U].abs(),
        }
    } else if k < JUNCTION {
        1e8
    } else {
        1.
    }
}
fn coordinate_scale(j: usize, y: &[f64]) -> f64 {
    y[j].abs()
        .max(if j < SOLIDS && j % 6 == MA || j < SOLIDS && j % 6 == MN {
            1.
        } else {
            1e-3
        })
}

/// Analytic Jacobian dF/dy (forward mode, one pass per column) and central differences.
fn jacobians(m: &Model, y: &[f64], yp: &[f64], ports: &Ports) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let ypc: Vec<Scalar> = yp.iter().map(|v| c(*v)).collect();
    let mut a = vec![vec![0.; N]; N];
    let mut d = vec![vec![0.; N]; N];
    for j in 0..N {
        let e = m
            .eval(&If97LowPressure, &scalars(y, Some(j)), &ypc, ports)
            .unwrap();
        for (row, r) in a.iter_mut().zip(&e.rows) {
            row[j] = r.direction;
        }
        if j < SOLIDS && (j % 6 == MA || j % 6 == MN) {
            // Pure-water prototype: no row reads the gas masses but their own rate rows.
            for (dr, ar) in d.iter_mut().zip(&a) {
                dr[j] = ar[j];
            }
            continue;
        }
        let h = 1e-6 * coordinate_scale(j, y);
        let (mut up, mut dn) = (y.to_vec(), y.to_vec());
        up[j] += h;
        dn[j] -= h;
        let fu = values(
            &m.eval(&If97LowPressure, &scalars(&up, None), &ypc, ports)
                .unwrap()
                .rows,
        );
        let fd = values(
            &m.eval(&If97LowPressure, &scalars(&dn, None), &ypc, ports)
                .unwrap()
                .rows,
        );
        for k in 0..N {
            d[k][j] = (fu[k] - fd[k]) / (2. * h);
        }
    }
    (a, d)
}
/// Two measures over every entry of the analytic (a) and central (c) Jacobians:
/// - `significant`: worst `|a-c|/max(|a|,|c|)` over entries whose scaled size
///   `|a_kj| s_j` is at least 1e-3 of the row's dominant scaled entry;
/// - `scaled`: worst `|a-c| s_j / dominant_k` over all entries, which judges a
///   near-cancellation remainder against the terms it cancels.
///
/// Both must be at most 1e-6.
fn compare(
    a: &[Vec<f64>],
    d: &[Vec<f64>],
    y: &[f64],
    skip: &dyn Fn(usize, usize) -> bool,
) -> (f64, f64, Value, usize, usize) {
    let (mut significant, mut scaled, mut at, mut compared, mut nnz) =
        (0f64, 0f64, json!(null), 0, 0);
    for k in 0..N {
        let dominant = (0..N)
            .map(|j| a[k][j].abs() * coordinate_scale(j, y))
            .fold(0., f64::max);
        for j in 0..N {
            if a[k][j] != 0. || d[k][j] != 0. {
                nnz += 1;
            }
            if skip(k, j) || (a[k][j] == 0. && d[k][j] == 0.) {
                continue;
            }
            compared += 1;
            let sj = coordinate_scale(j, y);
            let e_scaled = (a[k][j] - d[k][j]).abs() * sj / dominant;
            scaled = scaled.max(e_scaled);
            if a[k][j].abs() * sj >= 1e-3 * dominant {
                let err = (a[k][j] - d[k][j]).abs() / a[k][j].abs().max(d[k][j].abs());
                if err > significant {
                    significant = err;
                    at = json!({"row": name(k), "column": name(j), "analytic": a[k][j], "central": d[k][j]});
                }
            }
        }
    }
    (significant, scaled, at, compared, nnz)
}
fn name(k: usize) -> String {
    if k < SOLIDS {
        format!(
            "{}.{}",
            IDS[k / 6],
            ["M_w", "M_air", "M_N2", "U", "p", "h"][k % 6]
        )
    } else if k < CELLS {
        [
            "RH.WALL",
            "CASING.HP1",
            "CASING.HP2",
            "CASING.LP1",
            "CASING.LP2",
            "COND.WALL1",
            "COND.WALL2",
        ][k - SOLIDS]
            .into()
    } else if k < JUNCTION {
        format!("CW.CELL{}", k - CELLS + 1)
    } else {
        "ADM.JUNCTION.p".into()
    }
}

#[test]
#[ignore = "requires LD01_G1_C10_PACKET (and writes LD01_G1_C10_RECEIPT)"]
fn g1_c10_zero_time_block() {
    let path = std::env::var("LD01_G1_C10_PACKET").expect("LD01_G1_C10_PACKET");
    let packet: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    // The vacuum stores (LP2 0.05 MPa, COND 7.38 kPa) need water states below
    // 0.1 MPa: admitted by the declared low-pressure domain (S4-D2).
    if let Err(e) = sat(&If97LowPressure, c(5e4)) {
        if let Ok(out) = std::env::var("LD01_G1_C10_RECEIPT") {
            let r = json!({"scope": "G1-C10 prototype on the maintained boundary", "blocker": "B1",
                "refusal": e, "packetSha256": packet["provenance"]["packetSha256"]});
            std::fs::write(out, serde_json::to_string_pretty(&r).unwrap() + "\n").unwrap();
        }
        panic!(
            "BLOCKER B1: the linked operating IF97 boundary refuses p < 0.1 MPa ({e}); \
            model/operating-phase-properties.md selects 0.1-17 MPa, so TG.LP2 (0.05 MPa) and LD01.COND (7.38 kPa) cannot be evaluated"
        );
    }
    let pr = prepare(&packet);
    let (m, y, ports) = (&pr.model, &pr.y, &pr.ports);
    let flow = m.flow_scale;
    // G1.2: census.
    let differential_count = (0..N).filter(|k| differential(*k)).count();
    assert_eq!((differential_count, N - differential_count), (45, 19));
    // G1.3 (a): consistent derivative and the scaled residual at the prepared state.
    let f = rates(m, y, ports);
    let yp: Vec<f64> = (0..N)
        .map(|k| if differential(k) { f[k] } else { 0. })
        .collect();
    let ypc: Vec<Scalar> = yp.iter().map(|v| c(*v)).collect();
    let e = m
        .eval(&If97LowPressure, &scalars(y, None), &ypc, ports)
        .unwrap();
    let scaled: Vec<f64> = (0..N)
        .map(|k| e.rows[k].value.abs() / row_scale(k, y, flow))
        .collect();
    let (worst_row, worst) = scaled
        .iter()
        .enumerate()
        .fold((0, 0.), |b, (k, v)| if *v > b.1 { (k, *v) } else { b });
    assert!(
        worst <= 1e-12,
        "scaled residual {worst:e} at {}",
        name(worst_row)
    );
    assert!(
        (pr.t_cond_sat - 313.15).abs() < 1e-6,
        "COND saturation {} K",
        pr.t_cond_sat
    );
    // G1.3 (b): port directions on every receiving row (rates = -rows at y' = 0).
    let zero = vec![c(0.); N];
    // A choked drain does not see its receiver: its declared sign is zero.
    let choked = |donor: f64, receiver: f64| {
        let s = sat(&If97LowPressure, c(donor)).unwrap();
        stratified::restriction_flux(
            &If97LowPressure,
            false,
            c(donor),
            s.liquid.enthalpy,
            c(receiver),
        )
        .unwrap()
        .choked
    };
    let sep_choked = choked(y[6 * SEP + P], ports.p_shell[0].value);
    let rh_choked = choked(y[6 * RHS + P], ports.p_shell[1].value);
    let drain_sign = |ch: bool| if ch { 0. } else { 1. };
    let declared: Vec<(usize, Vec<(usize, f64)>)> = vec![
        (0, vec![(6 * HEADER + MW, 1.), (6 * HEADER + U, 1.)]),
        (1, vec![(6 * HEADER + MW, 1.), (6 * HEADER + U, 1.)]),
        (
            2,
            vec![
                (6 * SEP + MW, drain_sign(sep_choked)),
                (6 * SEP + U, drain_sign(sep_choked)),
            ],
        ),
        (
            3,
            vec![
                (6 * RHS + MW, drain_sign(rh_choked)),
                (6 * RHS + U, drain_sign(rh_choked)),
            ],
        ),
        (4, vec![(6 * HP2 + MW, -1.), (6 * HP2 + U, -1.)]),
        (5, vec![(6 * SEP + MW, -1.), (6 * SEP + U, -1.)]),
        (6, vec![(6 * LP1 + MW, -1.), (6 * LP1 + U, -1.)]),
        (7, vec![(6 * LP2 + MW, -1.), (6 * LP2 + U, -1.)]),
        (8, vec![(6 * COND + MW, 1.), (6 * COND + U, 1.)]),
        (9, vec![(6 * COND + U, 1.)]),
        (10, vec![(6 * COND + MW, -1.), (6 * COND + U, -1.)]),
        (11, vec![(CELLS, -1.), (CELLS + 1, -1.)]),
        (12, vec![(CELLS, 1.)]),
        (
            14,
            vec![
                (SOLIDS + 1, 1.),
                (SOLIDS + 2, 1.),
                (SOLIDS + 3, 1.),
                (SOLIDS + 4, 1.),
            ],
        ),
    ];
    let mut directional = Vec::new();
    let mut port_worst: f64 = 0.;
    for (k, rows) in &declared {
        let ev = m
            .eval(
                &If97LowPressure,
                &scalars(y, None),
                &zero,
                &ports.seeded(*k, 1.),
            )
            .unwrap();
        let dv = 1e-6 * ports.value(*k).abs().max(1.);
        let fu = values(
            &m.eval(
                &If97LowPressure,
                &scalars(y, None),
                &zero,
                &ports.shifted(*k, dv),
            )
            .unwrap()
            .rows,
        );
        let fd = values(
            &m.eval(
                &If97LowPressure,
                &scalars(y, None),
                &zero,
                &ports.shifted(*k, -dv),
            )
            .unwrap()
            .rows,
        );
        for (row, sign) in rows {
            let analytic = -ev.rows[*row].direction;
            let central = -(fu[*row] - fd[*row]) / (2. * dv);
            if *sign == 0. {
                assert!(
                    analytic == 0. && central == 0.,
                    "choked port {} still moves {} ({analytic:e}, {central:e})",
                    PORT_NAMES[*k],
                    name(*row)
                );
            } else {
                assert!(
                    analytic * sign > 0.,
                    "port {} moves {} with the wrong sign ({analytic:e})",
                    PORT_NAMES[*k],
                    name(*row)
                );
            }
            let rel = if analytic == central {
                0.
            } else {
                (analytic - central).abs() / analytic.abs().max(central.abs())
            };
            port_worst = port_worst.max(rel);
            directional.push(json!({"port": PORT_NAMES[*k], "row": name(*row), "declared": sign, "rate_per_unit": analytic, "central": central, "relative": rel}));
        }
    }
    // Shaft speed: the torque output falls with speed (C15's receiving row);
    // each receiving store's energy rate moves with sign(2 R omega - v) of its interval.
    let ev = m
        .eval(
            &If97LowPressure,
            &scalars(y, None),
            &zero,
            &ports.seeded(13, 1.),
        )
        .unwrap();
    assert!(
        ev.torque.direction < 0.,
        "turbine torque must fall with speed"
    );
    // G1.3 (c): analytic partials against central differences.
    let sep_rh = |k: usize, j: usize| {
        // The equal-pressure SEP/RH start is the nozzle law's square-root branch point:
        // the one-sided slope is unbounded, the kernel reports zero. Those entries are
        // compared at the displaced state below instead.
        (k == 6 * SEP + MW || k == 6 * SEP + U || k == 6 * RHP + MW || k == 6 * RHP + U)
            && (j == 6 * SEP + P
                || j == 6 * RHP + P
                || j == 6 * SEP + H
                || j == 6 * RHP + H
                || j == 6 * SEP + MW)
    };
    let t0 = cpu::thread_cpu_s();
    let (a0, d0) = jacobians(m, y, &yp, ports);
    let jac_pair_cpu = cpu::thread_cpu_s() - t0;
    let (w0, s0, at0, n0, nnz0) = compare(&a0, &d0, y, &sep_rh);
    // Displaced state: SEP 1 kPa above RH, bypass and emergency drain partly open,
    // so every branch carries flow and every entry is compared.
    let mut y1 = y.clone();
    y1[6 * SEP + P] += 1000.;
    let mut m1 = prepare(&packet).model;
    for b in &mut m1.branches {
        if b.id == "TG.BYP" {
            b.opening = 0.3;
        }
        if b.id == "TG.SEP.EMERGENCY" {
            b.opening = 0.2;
        }
    }
    let f1 = rates(&m1, &y1, ports);
    let yp1: Vec<f64> = (0..N)
        .map(|k| if differential(k) { f1[k] } else { 0. })
        .collect();
    let (a1, d1) = jacobians(&m1, &y1, &yp1, ports);
    let (w1, s1, at1, n1, nnz1) = compare(&a1, &d1, &y1, &|_, _| false);
    assert!(
        w0 <= 1e-6 && s0 <= 1e-6,
        "prepared-state partials disagree {w0:e}/{s0:e} at {at0}"
    );
    assert!(
        w1 <= 1e-6 && s1 <= 1e-6,
        "displaced-state partials disagree {w1:e}/{s1:e} at {at1}"
    );
    // G1.2: structural pattern = union of nonzeros at both states, plus dF/dy' (differential rows).
    let mut union = 0;
    for k in 0..N {
        for j in 0..N {
            if a0[k][j] != 0. || a1[k][j] != 0. || d0[k][j] != 0. || d1[k][j] != 0. {
                union += 1;
            }
        }
    }
    // Greedy column colouring of that pattern (the colored-Jacobian sweep count).
    let pattern =
        |k: usize, j: usize| a0[k][j] != 0. || a1[k][j] != 0. || d0[k][j] != 0. || d1[k][j] != 0.;
    let mut colour = vec![usize::MAX; N];
    for j in 0..N {
        let mut used = std::collections::BTreeSet::new();
        for (i, ci) in colour.iter().enumerate().take(j) {
            if (0..N).any(|k| pattern(k, j) && pattern(k, i)) {
                used.insert(*ci);
            }
        }
        colour[j] = (0..).find(|x| !used.contains(x)).unwrap();
    }
    let colours = colour.iter().max().unwrap() + 1;
    // G1.4: cost of one value-only residual and one colored Jacobian (colours directional passes),
    // on the plain IF97 boundary and on one evaluation's shared boundary (the kernel's
    // per-evaluation cache), and the share of the five interval adiabats.
    cpu::prefer_performance_core();
    let reps = 50;
    let timed = |f: &dyn Fn()| {
        let t0 = cpu::thread_cpu_s();
        for _ in 0..reps {
            f();
        }
        (cpu::thread_cpu_s() - t0) / reps as f64
    };
    let residual_s = timed(&|| {
        std::hint::black_box(
            m.eval(&If97LowPressure, &scalars(y, None), &ypc, ports)
                .unwrap(),
        );
    });
    let residual_shared_s = timed(&|| {
        let shared = props::Shared::new(&If97LowPressure);
        std::hint::black_box(m.eval(&shared, &scalars(y, None), &ypc, ports).unwrap());
    });
    let mut mref = prepare(&packet).model;
    mref.reference_drops = true;
    let residual_reference_drops_s = timed(&|| {
        let shared = props::Shared::new(&If97LowPressure);
        std::hint::black_box(mref.eval(&shared, &scalars(y, None), &ypc, ports).unwrap());
    });
    let jacobian = |shared: bool| {
        let t0 = cpu::thread_cpu_s();
        for _ in 0..5 {
            for col in 0..colours {
                let seeded: Vec<Scalar> = y
                    .iter()
                    .enumerate()
                    .map(|(j, v)| Scalar::new(*v, if colour[j] == col { 1. } else { 0. }))
                    .collect();
                if shared {
                    let cache = props::Shared::new(&If97LowPressure);
                    std::hint::black_box(m.eval(&cache, &seeded, &ypc, ports).unwrap());
                } else {
                    std::hint::black_box(m.eval(&If97LowPressure, &seeded, &ypc, ports).unwrap());
                }
            }
        }
        (cpu::thread_cpu_s() - t0) / 5.
    };
    let jacobian_s = jacobian(false);
    let jacobian_shared_s = jacobian(true);
    // G1.4 cost option: the interval drops on a coarser RK4 step (0.05 / 0.1 in ln p),
    // shared boundary; residual and colored Jacobian, and the prepared aero work.
    let mut step_options = Vec::new();
    for step in [0.02, 0.05] {
        let mut ms = prepare(&packet).model;
        ms.drop_step = step;
        let r = timed(&|| {
            let shared = props::Shared::new(&If97LowPressure);
            std::hint::black_box(ms.eval(&shared, &scalars(y, None), &ypc, ports).unwrap());
        });
        let t0 = cpu::thread_cpu_s();
        for _ in 0..5 {
            for col in 0..colours {
                let seeded: Vec<Scalar> = y
                    .iter()
                    .enumerate()
                    .map(|(j, v)| Scalar::new(*v, if colour[j] == col { 1. } else { 0. }))
                    .collect();
                let cache = props::Shared::new(&If97LowPressure);
                std::hint::black_box(ms.eval(&cache, &seeded, &ypc, ports).unwrap());
            }
        }
        let jac = (cpu::thread_cpu_s() - t0) / 5.;
        let work = ms
            .eval(&If97LowPressure, &scalars(y, None), &ypc, ports)
            .unwrap()
            .aero_work
            .value;
        step_options.push(json!({"stepLnP": step, "residualShared_s": r, "coloredJacobianShared_s": jac,
            "aeroWork_W": work, "aeroWorkRelativeVsDefaultStep0.1": (work - e.aero_work.value) / e.aero_work.value}));
    }
    // D2 check of the wiki's statement: the old 5.98 MPa header against the 6.36314 MPa SG.
    let ms = m.branches.iter().find(|b| b.id == "MS.ISO.A").unwrap();
    let hg_sg = sat(&If97LowPressure, ports.p_sg[0]).unwrap().vapor.enthalpy;
    let old_ratio = ms.area
        * flux(&If97LowPressure, ports.p_sg[0], hg_sg, c(5.98e6))
            .unwrap()
            .value
        / pr.model.flow_scale
        * 2.;
    // Reversible-drop step diagnostic: the five interval drops at the prepared state
    // with coarser RK4 steps in ln p, against the 0.02 the restriction law uses.
    let mut drop_steps = Vec::new();
    for step in [0.02, 0.05, 0.1, 0.2] {
        let shared = props::Shared::new(&If97LowPressure);
        let t0 = cpu::thread_cpu_s();
        let mut drops = Vec::new();
        for b in m
            .branches
            .iter()
            .filter(|b| matches!(b.law, Law::Interval { .. }))
        {
            let (End::Store(i, _), End::Store(o, _)) = (b.from, b.to) else {
                unreachable!()
            };
            let d = adiabat_drop_step(
                &shared,
                c(y[6 * i + P]),
                c(y[6 * i + H]),
                c(y[6 * o + P]),
                step,
            )
            .unwrap();
            drops.push(d.value);
        }
        drop_steps.push((step, cpu::thread_cpu_s() - t0, drops));
    }
    let reference: Vec<f64> = drop_steps[0].2.clone();
    let drop_steps: Vec<Value> = drop_steps
        .iter()
        .map(|(step, cpu_s, drops)| {
            let worst = drops.iter().zip(&reference).map(|(d, r)| ((d - r) / r).abs()).fold(0., f64::max);
            json!({"stepLnP": step, "cpu_s": cpu_s, "drops_J_kg": drops, "worstRelativeVsStep0.02": worst})
        })
        .collect();
    // S4-D7: the machine phasor prepared at this turbine's prepared net shaft power (closed form,
    // the generator owner's unity-power-factor formulas, hardware fixed), checked on the dq law.
    let gp = &packet["generatorPreparation"];
    let sh = &packet["shaft"];
    let omega0 = num(sh, "referenceSpeed_rad_s");
    let tau_net =
        e.torque.value * (1. - num(sh, "loadLossFraction")) - num(sh, "drag_Nm_per_rad_s") * omega0;
    let p_shaft = tau_net * omega0;
    let (v, rs, ls, mm, lf, rf, pp) = (
        num(gp, "lineVoltage_V"),
        num(gp, "resistance_ohm"),
        num(gp, "statorInductance_H"),
        num(gp, "mutual_H"),
        num(gp, "fieldInductance_H"),
        num(gp, "fieldResistance_ohm"),
        num(gp, "polePairs"),
    );
    let we = 2. * std::f64::consts::PI * num(gp, "frequency_Hz");
    let x = ls * we;
    let s3 = 3f64.sqrt();
    let i = (-s3 * v + (3. * v * v + 12. * rs * p_shaft).sqrt()) / (6. * rs);
    let emf = s3 * (v / s3 + rs * i).hypot(x * i);
    let ifield = emf / (we * mm);
    let delta = (x * i).atan2(v / s3 + rs * i);
    let theta = delta - std::f64::consts::FRAC_PI_2;
    let (id, iq) = (-s3 * i * delta.sin(), -s3 * i * delta.cos());
    let flux = [ls * id + mm * ifield, ls * iq, mm * id + lf * ifield];
    let det = ls * lf - mm * mm;
    let (cd, cq, cf) = (
        (lf * flux[0] - mm * flux[2]) / det,
        flux[1] / ls,
        (ls * flux[2] - mm * flux[0]) / det,
    );
    let (vd, vq) = (v * theta.cos(), -v * theta.sin());
    let flux_rates = [
        vd - rs * cd + pp * omega0 * flux[1],
        vq - rs * cq - pp * omega0 * flux[0],
        rf * ifield - rf * cf,
    ];
    let balance = p_shaft + pp * mm * cf * cq * omega0;
    assert!(
        balance.abs() <= 1e-9 * p_shaft,
        "S4-D7 shaft balance {balance} W"
    );
    assert!(
        flux_rates.iter().all(|r| r.abs() < 1e-6),
        "S4-D7 flux rates {flux_rates:?}"
    );
    let s4d7 = json!({"netShaft_W": p_shaft, "phaseCurrent_A": i, "fieldCurrent_A": ifield, "fieldDemand_V": rf * ifield,
        "angle_rad": theta, "initialFlux": flux, "export_W": s3 * v * i, "balance_W": balance, "fluxRates_V": flux_rates});
    // Preparation rates (the declared nonsteady start) and branch flows.
    let rates_json: Vec<Value> = (0..N)
        .filter(|k| differential(*k) && f[*k] != 0.)
        .map(|k| json!({"row": name(k), "rate": f[k]}))
        .collect();
    let flows: Vec<Value> = e
        .flows
        .iter()
        .map(|(id, v)| json!({"id": id, "kg_s": v.value}))
        .collect();
    let receipt = json!({
        "scope": "G1-C10 standalone block prototype at zero time: TEST ONLY, never joined to the kernel, never a gate",
        "packetSha256": packet["provenance"]["packetSha256"],
        "census": {"differential": differential_count, "algebraic": N - differential_count, "coordinates": N,
            "structuralNnzDy": union, "dyPrimeNnz": differential_count, "colours": colours},
        "zeroTime": {"worstScaledRow": worst, "atRow": name(worst_row), "condenserSaturation_K": pr.t_cond_sat},
        "directional": {"checks": directional, "worstRelativeVsCentral": port_worst, "torqueSpeedPartial_Nms": ev.torque.direction,
            "chokedDrains": {"separator": sep_choked, "reheater": rh_choked}},
        "partials": {
            "prepared": {"worstRelativeSignificant": w0, "worstScaled": s0, "at": at0, "compared": n0, "nonzeros": nnz0,
                "excluded": "SEP/RH equal-pressure branch point (rows SEP/RHP M,U; columns SEP/RHP p,h and SEP M_w)",
                "metric": "significant: |a-c|/max(|a|,|c|) over entries with |a| s_j >= 1e-3 of the row's dominant scaled entry; scaled: |a-c| s_j / dominant over all entries"},
            "displaced": {"worstRelativeSignificant": w1, "worstScaled": s1, "at": at1, "compared": n1, "nonzeros": nnz1, "state": "SEP +1 kPa, BYP 0.3, SEP emergency 0.2"},
            "jacobianPairCpu_s": jac_pair_cpu},
        "cost": {"residual_s": residual_s, "residualShared_s": residual_shared_s, "residualSharedReferenceDrops_s": residual_reference_drops_s,
            "coloredJacobian_s": jacobian_s, "coloredJacobianShared_s": jacobian_shared_s, "colours": colours,
            "dropStepOptions": step_options,
            "loadavg": cpu::load_average()},
        "d2": {"oldHeaderMsFlowOverSizing": old_ratio},
        "dropStepDiagnostic": drop_steps,
        "torque_Nm": e.torque.value, "aeroWork_W": e.aero_work.value,
        "s4d7": s4d7,
        "sizing": pr.sizing, "flowsAtPreparation": flows, "preparationRates": rates_json,
    });
    if let Ok(out) = std::env::var("LD01_G1_C10_RECEIPT") {
        std::fs::write(out, serde_json::to_string_pretty(&receipt).unwrap() + "\n").unwrap();
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&receipt["census"]).unwrap()
    );
    println!(
        "worst scaled row {worst:e}; partials {w0:e}/{w1:e}; residual {residual_s:e} / shared {residual_shared_s:e} / reference drops {residual_reference_drops_s:e} s; jacobian {jacobian_s:e} / shared {jacobian_shared_s:e} s; old-header MS ratio {old_ratio}"
    );
}

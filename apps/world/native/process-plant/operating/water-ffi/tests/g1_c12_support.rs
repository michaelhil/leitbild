//! spec: world/packs/process-plant/reference-designs/ld-01/systems/support-services/thermal-water-and-air.md#compact-operating-allocation-15-october-2026
//! G1-C12 design prototype: the S5 compact support reduction (both CCW/SW
//! trains) as one standalone block with its own rows and an analytic dense
//! Jacobian. TEST ONLY: never joined to the kernel, never a gate. It checks
//! Gate 1's G1.2 (census and pattern) and G1.3 (zero-time residual,
//! directional port check, analytic partials against central differences)
//! and measures the block's own evaluation cost for G1.4.
//!
//! Parameters come only from the C12 support packet
//! (`reference-design-operating-support.ts`, env `LD01_C12_SUPPORT_PACKET`).
//! Laws, as the allocation selects them:
//! - water cells: fixed mass `M=rho(p,T0)*V` at the prepared pressure,
//!   differential U, algebraic T from `M*u(p,T)-U=0` (native IF97 liquid);
//!   advection carries the donor's `h(p,T)`; pump fluid power enters the
//!   delivered stream once;
//! - CCW flow: the owner's sizing intersection at speed n and bypass x,
//!   `m=n*sqrt(1.25*dp0/(Klocal+Kcommon(x)+0.25*dp0/m0^2))`, jackets split by
//!   reference flow, cooler/bypass by conductance; SW flow
//!   `m=sqrt(n^2*a+b)` with the bay-level head in b, zero while not positive
//!   (discharge check);
//! - pump work (low-pressure continuation, fL=1):
//!   `P=max(Puseful/eta_h, Puseful+0.01*P0*n^3)`, rotor
//!   `J*w'=Tm-P/w-Td`, tracking drive `Tm=clamp(P/w+Td+J*(w_req-w)/3 s,0,cap)`;
//! - walls, jackets, motor and oil stores: the owner's mixed-cell laws.
#![cfg(any(target_os = "macos", target_os = "linux"))]
// Dense test-only index arithmetic over rows and columns.
#![allow(clippy::needless_range_loop)]
use leitbild_operating_water::{Branch, WaterPoint, directional, point, point_pu};
use serde_json::{Value, json};

#[path = "common/cpu.rs"]
mod cpu;

fn get(v: &Value, path: &str) -> f64 {
    v.pointer(path)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("packet field {path} missing"))
}

/// Native liquid point and its exact temperature direction at fixed pressure.
fn liquid(p: f64, t: f64) -> (WaterPoint, WaterPoint) {
    directional(Branch::Liquid, p, t, 0., 1.).expect("IF97 liquid")
}

#[derive(Clone, Copy)]
struct Cell {
    p: f64,
    v: f64,
    m: f64,
    t0: f64,
}
impl Cell {
    fn new(c: &Value) -> Self {
        let (p, v, t0) = (
            get(c, "/pressure_Pa"),
            get(c, "/volume_m3"),
            get(c, "/initial_K"),
        );
        let q = point(Branch::Liquid, p, t0).expect("IF97");
        Cell {
            p,
            v,
            m: q.density_kg_m3 * v,
            t0,
        }
    }
}

struct Pump {
    omega0: f64,
    m0: f64,
    dp0: f64,
    rho0: f64,
    eta_h: f64,
    eta_m: f64,
    p0: f64,
    pd0: f64,
    j: f64,
    track: f64,
    cap: f64,
    churn: f64,
}
impl Pump {
    fn new(p: &Value) -> Self {
        Pump {
            omega0: get(p, "/omega0_rad_s"),
            m0: get(p, "/referenceFlow_kg_s"),
            dp0: get(p, "/referenceHead_Pa"),
            rho0: get(p, "/referenceDensity_kg_m3"),
            eta_h: get(p, "/hydraulicEfficiency"),
            eta_m: get(p, "/motorEfficiency"),
            p0: get(p, "/fluidPower0_W"),
            pd0: get(p, "/dragPower0_W"),
            j: get(p, "/inertia_kg_m2"),
            track: get(p, "/trackingTime_s"),
            cap: get(p, "/torqueCap_N_m"),
            churn: get(p, "/churnFraction"),
        }
    }
    /// Fluid power `max(Pu/eta, Pu+Pchurn)` and its partials in (m, omega).
    fn power(&self, m: f64, w: f64) -> (f64, f64, f64) {
        let n = w / self.omega0;
        let dp = self.dp0 * (1.25 * n * n - 0.25 * (m / self.m0).powi(2));
        let (ddp_m, ddp_w) = (
            -0.5 * self.dp0 * m / (self.m0 * self.m0),
            2.5 * self.dp0 * n / self.omega0,
        );
        let pu = m / self.rho0 * dp;
        assert!(
            pu >= 0.,
            "the S5 reduction admits nonnegative useful pump power only"
        );
        let (dpu_m, dpu_w) = ((dp + m * ddp_m) / self.rho0, m / self.rho0 * ddp_w);
        let base = pu * (1. / self.eta_h - 1.);
        let churn = self.churn * self.p0 * n.powi(3);
        if base >= churn {
            (pu / self.eta_h, dpu_m / self.eta_h, dpu_w / self.eta_h)
        } else {
            let dchurn_w = 3. * self.churn * self.p0 * n * n / self.omega0;
            (pu + churn, dpu_m, dpu_w + dchurn_w)
        }
    }
}

struct Jacket {
    id: String,
    w: f64,
    g: f64,
    cell: Cell,
    metal: Option<(f64, f64)>, // (capacity, initial T)
    u: usize,
    t: usize,
    tm: Option<usize>,
}
struct SwPath {
    id: String,
    f: f64,
    cell: Cell,
    u: usize,
    t: usize,
}
struct Train {
    id: String,
    pc: Pump,
    ps: Pump,
    motor: [(f64, f64, f64); 2], // (capacity, ambient conductance, initial T) CCW, SW
    kl: f64,
    kcf: f64,
    kcv: f64,
    kbf: f64,
    kbv: f64,
    sup: Cell,
    ret: Cell,
    cool: Cell,
    wall: (f64, f64, f64, f64), // capacity, Gccw, Gsw, initial
    jackets: Vec<Jacket>,
    sw: Vec<SwPath>,
    ks: f64,
    z_dis: f64,
    x0: f64,
    prepared_flow: f64,
    prepared_cooler_flow: f64,
    // coordinates
    u_sup: usize,
    u_ret: usize,
    u_cool: usize,
    t_wall: usize,
    w_c: usize,
    w_s: usize,
    tm_c: usize,
    tm_s: usize,
    x: usize,
    t_sup: usize,
    t_ret: usize,
    t_cool: usize,
    m_c: usize,
    m_s: usize,
    oil: Option<(usize, usize)>, // bulk, cooler T (CCW.B)
}

struct Oil {
    k: f64, // rho*cp
    cb: f64,
    cc: f64,
    g: f64,
    t0: f64,
}

#[derive(Clone)]
struct Ports {
    motor_heat: Vec<Vec<f64>>, // per train, per jacket (0 for TG.OIL)
    oil_heat: f64,
    oil_flow: f64,
    gen_metal: f64,
    bay: f64,
    bay_level: f64,
    ambient: f64,
    supported: [[bool; 2]; 2], // [train][CCW, SW]
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Diff,
    Alg,
}

struct Model {
    trains: Vec<Train>,
    oil: Oil,
    gen_g: f64,
    g: f64,
    rho0: f64,
    atm: f64,
    displaced_bound: f64,
    names: Vec<String>,
    kinds: Vec<Kind>,
    coef: Vec<f64>,
}

struct Out {
    /// G_i(y): for a differential row -(rate right-hand side), for an
    /// algebraic row its residual. F = coef*y' + G.
    g: Vec<f64>,
    /// Sum of the absolute terms of each row (its scale).
    mag: Vec<f64>,
    jac: Option<Vec<(usize, usize, f64)>>,
}
impl Out {
    fn new(n: usize, jac: bool) -> Self {
        Out {
            g: vec![0.; n],
            mag: vec![0.; n],
            jac: jac.then(Vec::new),
        }
    }
    /// Add `value` to row i of G (with its magnitude).
    fn term(&mut self, i: usize, value: f64) {
        self.g[i] += value;
        self.mag[i] += value.abs();
    }
    fn d(&mut self, i: usize, j: usize, value: f64) {
        if let Some(jac) = &mut self.jac {
            jac.push((i, j, value));
        }
    }
}

impl Model {
    fn push(&mut self, name: String, kind: Kind, coef: f64) -> usize {
        self.names.push(name);
        self.kinds.push(kind);
        self.coef.push(if kind == Kind::Diff { coef } else { 0. });
        self.names.len() - 1
    }

    fn new(packet: &Value) -> Self {
        let s5 = &packet["s5"];
        let o = &s5["oil"];
        let mut m = Model {
            trains: vec![],
            oil: Oil {
                k: get(o, "/density_kg_m3") * get(o, "/heatCapacity_J_kg_K"),
                cb: get(o, "/bulkCapacity_J_K"),
                cc: get(o, "/coolerCapacity_J_K"),
                g: get(o, "/coolerConductance_W_K"),
                t0: get(o, "/initial_K"),
            },
            gen_g: get(s5, "/generatorCooler/conductance_W_K"),
            g: get(s5, "/constants/gravity_m_s2"),
            rho0: get(s5, "/constants/referenceDensity_kg_m3"),
            atm: get(s5, "/constants/atmosphere_Pa"),
            displaced_bound: get(s5, "/constants/displacedVolumeBound_m3"),
            names: vec![],
            kinds: vec![],
            coef: vec![],
        };
        for t in s5["trains"].as_array().expect("trains") {
            let id = t["id"].as_str().expect("train id").to_string();
            let c = &t["ccw"];
            let s = &t["sw"];
            let cells = &c["cells"];
            let (sup, ret, cool) = (
                Cell::new(&cells["supply"]),
                Cell::new(&cells["return"]),
                Cell::new(&cells["cooler"]),
            );
            let pc = Pump::new(&c["pump"]);
            let ps = Pump::new(&s["pump"]);
            let motor = |v: &Value| {
                (
                    get(v, "/capacity_J_K"),
                    get(v, "/ambientConductance_W_K"),
                    get(v, "/initial_K"),
                )
            };
            let jackets_v = c["jackets"].as_array().expect("jackets");
            let sum_ref: f64 = jackets_v.iter().map(|j| get(j, "/reference_kg_s")).sum();
            let paths_v = s["paths"].as_array().expect("sw paths");
            let inv: Vec<f64> = paths_v
                .iter()
                .map(|q| 1. / get(q, "/resistance_Pa_per_kg2_s2").sqrt())
                .collect();
            let inv_sum: f64 = inv.iter().sum();
            let mut tr = Train {
                id: id.clone(),
                motor: [motor(&c["motor"]), motor(&s["motor"])],
                kl: get(c, "/network/localK_Pa_per_kg2_s2"),
                kcf: get(c, "/network/coolerFixed_Pa"),
                kcv: get(c, "/network/coolerValve_Pa"),
                kbf: get(c, "/network/bypassFixed_Pa"),
                kbv: get(c, "/network/bypassValve_Pa"),
                sup,
                ret,
                cool,
                wall: (
                    get(c, "/wall/capacity_J_K"),
                    get(c, "/wall/ccwConductance_W_K"),
                    get(c, "/wall/swConductance_W_K"),
                    get(c, "/wall/initial_K"),
                ),
                jackets: vec![],
                sw: vec![],
                ks: 1. / (inv_sum * inv_sum),
                z_dis: get(s, "/dischargeElevation_m"),
                x0: get(c, "/bypass/initial"),
                prepared_flow: get(c, "/prepared/flow_kg_s"),
                prepared_cooler_flow: get(c, "/prepared/coolerFlow_kg_s"),
                pc,
                ps,
                u_sup: 0,
                u_ret: 0,
                u_cool: 0,
                t_wall: 0,
                w_c: 0,
                w_s: 0,
                tm_c: 0,
                tm_s: 0,
                x: 0,
                t_sup: 0,
                t_ret: 0,
                t_cool: 0,
                m_c: 0,
                m_s: 0,
                oil: None,
            };
            let n = |name: &str| format!("{id}.{name}");
            tr.u_sup = m.push(n("CCW.SUPPLY.U"), Kind::Diff, 1.);
            tr.u_ret = m.push(n("CCW.RETURN.U"), Kind::Diff, 1.);
            tr.u_cool = m.push(n("CCW.COOLER.U"), Kind::Diff, 1.);
            tr.t_wall = m.push(n("CCW.HX.WALL.T"), Kind::Diff, tr.wall.0);
            for jv in jackets_v {
                let jid = jv["id"].as_str().expect("jacket id").to_string();
                let metal = jv["metalCapacity_J_K"]
                    .as_f64()
                    .map(|cap| (cap, get(jv, "/metalInitial_K")));
                let cell = Cell {
                    p: get(jv, "/pressure_Pa"),
                    v: get(jv, "/volume_m3"),
                    m: point(
                        Branch::Liquid,
                        get(jv, "/pressure_Pa"),
                        get(jv, "/initial_K"),
                    )
                    .expect("IF97")
                    .density_kg_m3
                        * get(jv, "/volume_m3"),
                    t0: get(jv, "/initial_K"),
                };
                let u = m.push(n(&format!("JKT.{jid}.U")), Kind::Diff, 1.);
                let tm =
                    metal.map(|(cap, _)| m.push(n(&format!("{jid}.MOTOR.T")), Kind::Diff, cap));
                tr.jackets.push(Jacket {
                    id: jid,
                    w: get(jv, "/reference_kg_s") / sum_ref,
                    g: get(jv, "/conductance_W_K"),
                    cell,
                    metal,
                    u,
                    t: 0,
                    tm,
                });
            }
            if tr.jackets.iter().any(|j| j.metal.is_none()) {
                let b = m.push(n("TG.OIL.BULK.T"), Kind::Diff, m.oil.cb);
                let cc = m.push(n("TG.OIL.COOLER.T"), Kind::Diff, m.oil.cc);
                tr.oil = Some((b, cc));
            }
            for (k, q) in paths_v.iter().enumerate() {
                let pid = q["id"].as_str().expect("path id").to_string();
                let cell = Cell {
                    p: get(q, "/pressure_Pa"),
                    v: get(q, "/volume_m3"),
                    m: point(Branch::Liquid, get(q, "/pressure_Pa"), get(q, "/initial_K"))
                        .expect("IF97")
                        .density_kg_m3
                        * get(q, "/volume_m3"),
                    t0: get(q, "/initial_K"),
                };
                let u = m.push(n(&format!("SW.{pid}.U")), Kind::Diff, 1.);
                tr.sw.push(SwPath {
                    id: pid,
                    f: inv[k] / inv_sum,
                    cell,
                    u,
                    t: 0,
                });
            }
            tr.w_c = m.push(n("CCW.P.OMEGA"), Kind::Diff, tr.pc.j);
            tr.w_s = m.push(n("SW.P.OMEGA"), Kind::Diff, tr.ps.j);
            tr.tm_c = m.push(n("CCW.P.MOTOR.T"), Kind::Diff, tr.motor[0].0);
            tr.tm_s = m.push(n("SW.P.MOTOR.T"), Kind::Diff, tr.motor[1].0);
            tr.x = m.push(n("CCW.HX.BYP.X"), Kind::Diff, 1.);
            tr.t_sup = m.push(n("CCW.SUPPLY.T"), Kind::Alg, 0.);
            tr.t_ret = m.push(n("CCW.RETURN.T"), Kind::Alg, 0.);
            tr.t_cool = m.push(n("CCW.COOLER.T"), Kind::Alg, 0.);
            for jk in &mut tr.jackets {
                jk.t = m.push(n(&format!("JKT.{}.T", jk.id)), Kind::Alg, 0.);
            }
            for q in &mut tr.sw {
                q.t = m.push(n(&format!("SW.{}.T", q.id)), Kind::Alg, 0.);
            }
            tr.m_c = m.push(n("CCW.FLOW"), Kind::Alg, 0.);
            tr.m_s = m.push(n("SW.FLOW"), Kind::Alg, 0.);
            m.trains.push(tr);
        }
        m
    }

    fn n(&self) -> usize {
        self.names.len()
    }

    /// CCW flow target `n*M(x)` and the cooler fraction c(x), with partials.
    fn ccw_flow(tr: &Train, w: f64, x: f64) -> (f64, f64, f64, f64, f64) {
        let p = &tr.pc;
        let n = w / p.omega0;
        // c_h = m0 (1-x)/sqrt(Kcf (1-x)^2 + Kcv), c_b = m0 x/sqrt(Kbf x^2 + Kbv)
        let (ox, m0) = (1. - x, p.m0);
        let dh = tr.kcf * ox * ox + tr.kcv;
        let db = tr.kbf * x * x + tr.kbv;
        let ch = m0 * ox / dh.sqrt();
        let cb = m0 * x / db.sqrt();
        let ch_x = -m0 * tr.kcv / dh.powf(1.5);
        let cb_x = m0 * tr.kbv / db.powf(1.5);
        let s = ch + cb;
        let kc = 1. / (s * s);
        let kc_x = -2. / (s * s * s) * (ch_x + cb_x);
        let a = 1.25 * p.dp0;
        let d = tr.kl + kc + 0.25 * p.dp0 / (m0 * m0);
        let big_m = (a / d).sqrt();
        let big_m_x = -0.5 * a.sqrt() * d.powf(-1.5) * kc_x;
        let c = ch / s;
        let c_x = (ch_x * cb - ch * cb_x) / (s * s);
        (n * big_m, big_m / p.omega0, n * big_m_x, c, c_x)
    }

    /// SW flow target `sqrt(n^2 a + b)` (zero while not positive) and d/dw.
    fn sw_flow(&self, tr: &Train, w: f64, level: f64) -> (f64, f64) {
        let p = &tr.ps;
        let n = w / p.omega0;
        let den = tr.ks + 0.25 * p.dp0 / (p.m0 * p.m0);
        let a = 1.25 * p.dp0 / den;
        let b = self.rho0 * self.g * (level - tr.z_dis) / den;
        let arg = n * n * a + b;
        if arg <= 0. {
            (0., 0.)
        } else if b == 0. {
            (n * a.sqrt(), a.sqrt() / p.omega0)
        } else {
            (arg.sqrt(), n * a / (arg.sqrt() * p.omega0))
        }
    }

    /// Rotor right-hand side `Tm-P/w-Td` and motor-store heat, with partials
    /// in (m, w). Tracking request toward w0 while supported.
    #[allow(clippy::type_complexity)]
    fn rotor(p: &Pump, m: f64, w: f64, supported: bool) -> ((f64, f64, f64), (f64, f64, f64)) {
        let (pw, pw_m, pw_w) = p.power(m, w);
        let td = p.pd0 * w / (p.omega0 * p.omega0);
        let td_w = p.pd0 / (p.omega0 * p.omega0);
        let request = pw / w + td + p.j * (p.omega0 - w) / p.track;
        let k = 1. / p.eta_m - 1.;
        if supported && request > 0. && request < p.cap {
            // unsaturated tracking: Tm - P/w - Td = J (w0 - w)/track
            let rate = (p.j * (p.omega0 - w) / p.track, 0., -p.j / p.track);
            let tm_w = request * w; // motor shaft power
            let tm_w_m = pw_m;
            let tm_w_w = pw_w + 2. * td_w * w + p.j * (p.omega0 - 2. * w) / p.track;
            let heat = (k * tm_w + td * w, k * tm_w_m, k * tm_w_w + 2. * td_w * w);
            (rate, heat)
        } else {
            let tm = if supported {
                request.clamp(0., p.cap)
            } else {
                0.
            };
            let rate = (
                tm - pw / w - td,
                -pw_m / w,
                -(pw_w / w - pw / (w * w)) - td_w,
            );
            let heat = (k * tm * w + td * w, 0., k * tm + 2. * td_w * w);
            (rate, heat)
        }
    }

    fn eval(&self, y: &[f64], ports: &Ports, jac: bool) -> Out {
        let mut o = Out::new(self.n(), jac);
        let h_bay = point(Branch::Liquid, self.atm, ports.bay)
            .expect("IF97 bay")
            .enthalpy_j_kg;
        for (ti, tr) in self.trains.iter().enumerate() {
            // water cells: u(p,T), h(p,T) and their T-derivatives
            let cell_state = |c: &Cell, t: usize| liquid(c.p, y[t]);
            let (sp, sd) = cell_state(&tr.sup, tr.t_sup);
            let (rp, rd) = cell_state(&tr.ret, tr.t_ret);
            let (cp, cd) = cell_state(&tr.cool, tr.t_cool);
            // EOS rows
            for (c, u, t, q, d) in [
                (&tr.sup, tr.u_sup, tr.t_sup, &sp, &sd),
                (&tr.ret, tr.u_ret, tr.t_ret, &rp, &rd),
                (&tr.cool, tr.u_cool, tr.t_cool, &cp, &cd),
            ] {
                o.term(t, c.m * q.internal_energy_j_kg);
                o.term(t, -y[u]);
                o.d(t, t, c.m * d.internal_energy_j_kg);
                o.d(t, u, -1.);
            }
            let (x, mc, ms, wc, ws) = (y[tr.x], y[tr.m_c], y[tr.m_s], y[tr.w_c], y[tr.w_s]);
            // flow rows
            let (mc_t, mc_w, mc_x, c, c_x) = Self::ccw_flow(tr, wc, x);
            o.term(tr.m_c, mc);
            o.term(tr.m_c, -mc_t);
            o.d(tr.m_c, tr.m_c, 1.);
            o.d(tr.m_c, tr.w_c, -mc_w);
            o.d(tr.m_c, tr.x, -mc_x);
            let (ms_t, ms_w) = self.sw_flow(tr, ws, ports.bay_level);
            o.term(tr.m_s, ms);
            o.term(tr.m_s, -ms_t);
            o.d(tr.m_s, tr.m_s, 1.);
            o.d(tr.m_s, tr.w_s, -ms_w);
            let (hs, hr, hc) = (sp.enthalpy_j_kg, rp.enthalpy_j_kg, cp.enthalpy_j_kg);
            let (hs_t, hr_t, hc_t) = (sd.enthalpy_j_kg, rd.enthalpy_j_kg, cd.enthalpy_j_kg);
            // supply: f = c m h_C + (1-c) m h_R - m h_S ; G = -f
            o.term(tr.u_sup, -(c * mc * hc));
            o.term(tr.u_sup, -((1. - c) * mc * hr));
            o.term(tr.u_sup, mc * hs);
            o.d(tr.u_sup, tr.t_cool, -c * mc * hc_t);
            o.d(tr.u_sup, tr.t_ret, -(1. - c) * mc * hr_t);
            o.d(tr.u_sup, tr.t_sup, mc * hs_t);
            o.d(tr.u_sup, tr.m_c, -(c * hc + (1. - c) * hr - hs));
            o.d(tr.u_sup, tr.x, -c_x * mc * (hc - hr));
            // pump power (CCW) and jacket inflow
            let (pc, pc_m, pc_w) = tr.pc.power(mc, wc);
            // return: f = sum w_j m h_j - m h_R
            o.term(tr.u_ret, mc * hr);
            o.d(tr.u_ret, tr.t_ret, mc * hr_t);
            let mut sum_wh = 0.;
            let t_hx = tr.sw[0].t;
            for jk in &tr.jackets {
                let (jp, jd) = liquid(jk.cell.p, y[jk.t]);
                o.term(jk.t, jk.cell.m * jp.internal_energy_j_kg);
                o.term(jk.t, -y[jk.u]);
                o.d(jk.t, jk.t, jk.cell.m * jd.internal_energy_j_kg);
                o.d(jk.t, jk.u, -1.);
                let (hj, hj_t) = (jp.enthalpy_j_kg, jd.enthalpy_j_kg);
                o.term(tr.u_ret, -(jk.w * mc * hj));
                o.d(tr.u_ret, jk.t, -jk.w * mc * hj_t);
                sum_wh += jk.w * hj;
                // jacket: f = w (m (h_S - h_j) + P_c) + G (T_hot - T_j)
                let hot = jk.tm.unwrap_or_else(|| tr.oil.expect("oil pair").1);
                o.term(jk.u, -(jk.w * mc * (hs - hj)));
                o.term(jk.u, -(jk.w * pc));
                o.term(jk.u, -(jk.g * (y[hot] - y[jk.t])));
                o.d(jk.u, tr.t_sup, -jk.w * mc * hs_t);
                o.d(jk.u, jk.t, jk.w * mc * hj_t + jk.g);
                o.d(jk.u, hot, -jk.g);
                o.d(jk.u, tr.m_c, -jk.w * (hs - hj) - jk.w * pc_m);
                o.d(jk.u, tr.w_c, -jk.w * pc_w);
                if let Some(tm) = jk.tm {
                    let j = tr
                        .jackets
                        .iter()
                        .position(|q| q.id == jk.id)
                        .expect("jacket");
                    // metal: C T' = Q - G (T_m - T_j)
                    o.term(tm, -ports.motor_heat[ti][j]);
                    o.term(tm, jk.g * (y[tm] - y[jk.t]));
                    o.d(tm, tm, jk.g);
                    o.d(tm, jk.t, -jk.g);
                }
            }
            o.d(tr.u_ret, tr.m_c, -(sum_wh - hr));
            if let Some((b, cc)) = tr.oil {
                let jo = tr
                    .jackets
                    .iter()
                    .find(|q| q.tm.is_none())
                    .expect("oil jacket")
                    .t;
                let (k, q) = (self.oil.k, ports.oil_flow);
                // bulk: Cb Tb' = Qoil - k q (Tb - Tc)
                o.term(b, -ports.oil_heat);
                o.term(b, k * q * (y[b] - y[cc]));
                o.d(b, b, k * q);
                o.d(b, cc, -k * q);
                // cooler: Cc Tc' = k q (Tb - Tc) - G (Tc - Tj)
                o.term(cc, -(k * q * (y[b] - y[cc])));
                o.term(cc, self.oil.g * (y[cc] - y[jo]));
                o.d(cc, b, -k * q);
                o.d(cc, cc, k * q + self.oil.g);
                o.d(cc, jo, -self.oil.g);
            }
            // cooler water: f = c m (h_R - h_C) - Gc (T_C - T_w)
            let (gc, gs) = (tr.wall.1, tr.wall.2);
            o.term(tr.u_cool, -(c * mc * (hr - hc)));
            o.term(tr.u_cool, gc * (y[tr.t_cool] - y[tr.t_wall]));
            o.d(tr.u_cool, tr.t_ret, -c * mc * hr_t);
            o.d(tr.u_cool, tr.t_cool, c * mc * hc_t + gc);
            o.d(tr.u_cool, tr.t_wall, -gc);
            o.d(tr.u_cool, tr.m_c, -c * (hr - hc));
            o.d(tr.u_cool, tr.x, -c_x * mc * (hr - hc));
            // wall: f = Gc (T_C - T_w) - Gs (T_w - T_HX)
            o.term(tr.t_wall, -(gc * (y[tr.t_cool] - y[tr.t_wall])));
            o.term(tr.t_wall, gs * (y[tr.t_wall] - y[t_hx]));
            o.d(tr.t_wall, tr.t_cool, -gc);
            o.d(tr.t_wall, tr.t_wall, gc + gs);
            o.d(tr.t_wall, t_hx, -gs);
            // SW paths: f = f_k (m (h_bay - h_k) + P_s) + Q_k
            let (psw, psw_m, psw_w) = tr.ps.power(ms, ws);
            for q in &tr.sw {
                let (qp, qd) = liquid(q.cell.p, y[q.t]);
                o.term(q.t, q.cell.m * qp.internal_energy_j_kg);
                o.term(q.t, -y[q.u]);
                o.d(q.t, q.t, q.cell.m * qd.internal_energy_j_kg);
                o.d(q.t, q.u, -1.);
                let (hk, hk_t) = (qp.enthalpy_j_kg, qd.enthalpy_j_kg);
                o.term(q.u, -(q.f * ms * (h_bay - hk)));
                o.term(q.u, -(q.f * psw));
                o.d(q.u, q.t, q.f * ms * hk_t);
                o.d(q.u, tr.m_s, -q.f * (h_bay - hk) - q.f * psw_m);
                o.d(q.u, tr.w_s, -q.f * psw_w);
                if q.id == "HX" {
                    o.term(q.u, -(gs * (y[tr.t_wall] - y[q.t])));
                    o.d(q.u, tr.t_wall, -gs);
                    o.d(q.u, q.t, gs);
                } else {
                    o.term(q.u, -(self.gen_g * (ports.gen_metal - y[q.t])));
                    o.d(q.u, q.t, self.gen_g);
                }
            }
            // rotors and pump motor stores
            for (pump, w_i, m_i, tm_i, store, sup) in [
                (
                    &tr.pc,
                    tr.w_c,
                    tr.m_c,
                    tr.tm_c,
                    tr.motor[0],
                    ports.supported[ti][0],
                ),
                (
                    &tr.ps,
                    tr.w_s,
                    tr.m_s,
                    tr.tm_s,
                    tr.motor[1],
                    ports.supported[ti][1],
                ),
            ] {
                let ((r, r_m, r_w), (h, h_m, h_w)) = Self::rotor(pump, y[m_i], y[w_i], sup);
                o.term(w_i, -r);
                o.d(w_i, m_i, -r_m);
                o.d(w_i, w_i, -r_w);
                // C T' = heat - Ga (T - Tamb)
                o.term(tm_i, -h);
                o.term(tm_i, store.1 * (y[tm_i] - ports.ambient));
                o.d(tm_i, m_i, -h_m);
                o.d(tm_i, w_i, -h_w);
                o.d(tm_i, tm_i, store.1);
            }
            // bypass actuator: stopped at its demand (x' = 0); a moving mode is a
            // known-time class-S change of this one rate.
            o.term(tr.x, 0.);
        }
        o
    }

    /// The prepared state: U from (p, T0), algebraic T = T0, flows from their laws.
    fn prepared(&self, ports: &Ports) -> Vec<f64> {
        let mut y = vec![0.; self.n()];
        for tr in &self.trains {
            for (c, u, t) in [
                (&tr.sup, tr.u_sup, tr.t_sup),
                (&tr.ret, tr.u_ret, tr.t_ret),
                (&tr.cool, tr.u_cool, tr.t_cool),
            ] {
                y[t] = c.t0;
                y[u] = c.m
                    * point(Branch::Liquid, c.p, c.t0)
                        .expect("IF97")
                        .internal_energy_j_kg;
            }
            for jk in &tr.jackets {
                y[jk.t] = jk.cell.t0;
                y[jk.u] = jk.cell.m
                    * point(Branch::Liquid, jk.cell.p, jk.cell.t0)
                        .expect("IF97")
                        .internal_energy_j_kg;
                if let (Some(tm), Some((_, t0))) = (jk.tm, jk.metal) {
                    y[tm] = t0;
                }
            }
            for q in &tr.sw {
                y[q.t] = q.cell.t0;
                y[q.u] = q.cell.m
                    * point(Branch::Liquid, q.cell.p, q.cell.t0)
                        .expect("IF97")
                        .internal_energy_j_kg;
            }
            if let Some((b, cc)) = tr.oil {
                y[b] = self.oil.t0;
                y[cc] = self.oil.t0;
            }
            y[tr.t_wall] = tr.wall.3;
            y[tr.w_c] = tr.pc.omega0;
            y[tr.w_s] = tr.ps.omega0;
            y[tr.tm_c] = tr.motor[0].2;
            y[tr.tm_s] = tr.motor[1].2;
            y[tr.x] = tr.x0;
            y[tr.m_c] = Self::ccw_flow(tr, y[tr.w_c], y[tr.x]).0;
            y[tr.m_s] = self.sw_flow(tr, y[tr.w_s], ports.bay_level).0;
        }
        y
    }

    /// Consistent derivatives: y' = -G/coef on differential rows, zero elsewhere.
    fn derivatives(&self, y: &[f64], ports: &Ports) -> Vec<f64> {
        let o = self.eval(y, ports, false);
        (0..self.n())
            .map(|i| {
                if self.kinds[i] == Kind::Diff {
                    -o.g[i] / self.coef[i]
                } else {
                    0.
                }
            })
            .collect()
    }

    /// F(y, y') and its row scales.
    fn residual(&self, y: &[f64], yp: &[f64], ports: &Ports) -> (Vec<f64>, Vec<f64>) {
        let o = self.eval(y, ports, false);
        let f = (0..self.n())
            .map(|i| self.coef[i] * yp[i] + o.g[i])
            .collect();
        let s = (0..self.n())
            .map(|i| (self.coef[i] * yp[i]).abs() + o.mag[i])
            .collect();
        (f, s)
    }

    /// Loop water displaced beyond its prepared volumes (CCW cells and jackets).
    fn displaced(&self, y: &[f64]) -> Vec<f64> {
        self.trains
            .iter()
            .map(|tr| {
                let mut cells: Vec<(&Cell, usize)> = vec![
                    (&tr.sup, tr.t_sup),
                    (&tr.ret, tr.t_ret),
                    (&tr.cool, tr.t_cool),
                ];
                cells.extend(tr.jackets.iter().map(|j| (&j.cell, j.t)));
                cells
                    .iter()
                    .map(|(c, t)| {
                        c.m / point(Branch::Liquid, c.p, y[*t])
                            .expect("IF97")
                            .density_kg_m3
                            - c.v
                    })
                    .sum()
            })
            .collect()
    }
}

/// Rate of every differential row after the algebraic coordinates are made
/// consistent with `ports` (flows from their laws; T unchanged with U fixed).
fn consistent_rates(m: &Model, y: &[f64], ports: &Ports) -> Vec<f64> {
    let mut z = y.to_vec();
    for tr in &m.trains {
        z[tr.m_c] = Model::ccw_flow(tr, z[tr.w_c], z[tr.x]).0;
        z[tr.m_s] = m.sw_flow(tr, z[tr.w_s], ports.bay_level).0;
    }
    m.derivatives(&z, ports)
}

fn packet() -> Value {
    let path = std::env::var("LD01_C12_SUPPORT_PACKET")
        .expect("LD01_C12_SUPPORT_PACKET: the C12 support packet from reference-design-operating-support.ts");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("read packet"))
        .expect("packet JSON")
}

fn ports(packet: &Value, model: &Model) -> Ports {
    let p = &packet["s5"]["ports"];
    Ports {
        motor_heat: model
            .trains
            .iter()
            .map(|tr| {
                tr.jackets
                    .iter()
                    .map(|j| {
                        if j.tm.is_some() {
                            get(p, &format!("/motorHeat_W/{}", j.id))
                        } else {
                            0.
                        }
                    })
                    .collect()
            })
            .collect(),
        oil_heat: get(p, "/oilHeat_W"),
        oil_flow: get(p, "/oilFlow_m3_s"),
        gen_metal: get(p, "/generatorMetal_K"),
        bay: get(p, "/bay_K"),
        bay_level: get(p, "/bayLevel_m"),
        ambient: get(p, "/ambient_K"),
        supported: [[true; 2]; 2],
    }
}

#[test]
#[ignore = "G1-C12 design prototype: needs LD01_C12_SUPPORT_PACKET"]
fn g1_c12_support_zero_time() {
    let packet = packet();
    let model = Model::new(&packet);
    let ports0 = ports(&packet, &model);
    let n = model.n();
    let y = model.prepared(&ports0);
    let yp = model.derivatives(&y, &ports0);

    // G1.2 census and structural pattern (dF/dy union dF/dy')
    let jac = model.eval(&y, &ports0, true).jac.expect("jacobian");
    let mut pattern: std::collections::BTreeSet<(usize, usize)> =
        jac.iter().map(|&(i, j, _)| (i, j)).collect();
    for i in 0..n {
        if model.kinds[i] == Kind::Diff {
            pattern.insert((i, i));
        }
    }
    let differential = model.kinds.iter().filter(|k| **k == Kind::Diff).count();
    let algebraic = n - differential;

    // the prepared flows are the calculator's (the TS sizing intersection)
    for tr in &model.trains {
        let (mc, _, _, c, _) = Model::ccw_flow(tr, tr.pc.omega0, tr.x0);
        assert!(
            (mc - tr.prepared_flow).abs() <= 1e-9 * tr.prepared_flow,
            "{} CCW flow {mc} vs {}",
            tr.id,
            tr.prepared_flow
        );
        assert!(
            (c * mc - tr.prepared_cooler_flow).abs() <= 1e-9 * tr.prepared_flow,
            "{} cooler flow",
            tr.id
        );
        let ms = y[tr.m_s];
        assert!(
            (ms - tr.ps.m0).abs() <= 1e-9 * tr.ps.m0,
            "{} SW flow {ms} vs {}",
            tr.id,
            tr.ps.m0
        );
    }

    // G1.3 zero-time residual
    let (f, s) = model.residual(&y, &yp, &ports0);
    let mut worst = (0., 0usize);
    for i in 0..n {
        let r = if s[i] > 0. {
            f[i].abs() / s[i]
        } else {
            f[i].abs()
        };
        assert!(
            s[i] > 0. || f[i] == 0.,
            "row {} has no scale but a residual",
            model.names[i]
        );
        if r > worst.0 {
            worst = (r, i);
        }
    }
    assert!(
        worst.0 <= 1e-12,
        "scaled residual {} at {}",
        worst.0,
        model.names[worst.1]
    );

    // G1.3 analytic partials against central differences of G(y)
    let mut dense = vec![0.; n * n];
    for &(i, j, v) in &jac {
        dense[i * n + j] += v;
    }
    let mut fd = vec![0.; n * n];
    for j in 0..n {
        let h = 1e-6 * y[j].abs().max(1.);
        let (mut a, mut b) = (y.clone(), y.clone());
        a[j] += h;
        b[j] -= h;
        let (ga, gb) = (
            model.eval(&a, &ports0, false).g,
            model.eval(&b, &ports0, false).g,
        );
        for i in 0..n {
            fd[i * n + j] = (ga[i] - gb[i]) / (2. * h);
        }
    }
    let mut partial_worst = (0., String::new());
    let mut partials_compared = 0;
    for i in 0..n {
        let row_max = (0..n)
            .map(|j| dense[i * n + j].abs().max(fd[i * n + j].abs()))
            .fold(0., f64::max);
        for j in 0..n {
            let (a, d) = (dense[i * n + j], fd[i * n + j]);
            if a == 0. && d == 0. {
                continue;
            }
            assert!(
                pattern.contains(&(i, j)) || d.abs() <= 1e-9 * row_max,
                "unpatterned partial {} / {}: {d}",
                model.names[i],
                model.names[j]
            );
            partials_compared += 1;
            let rel = (a - d).abs() / row_max;
            if rel > partial_worst.0 {
                partial_worst = (rel, format!("{} / {}", model.names[i], model.names[j]));
            }
        }
    }
    assert!(
        partial_worst.0 <= 1e-6,
        "analytic vs central difference {} at {}",
        partial_worst.0,
        partial_worst.1
    );

    // G1.3 directional port check: a +delta on each port moves every receiving
    // rate with its declared sign (consistent algebraic flows).
    let base = consistent_rates(&model, &y, &ports0);
    let idx = |name: &str| {
        model
            .names
            .iter()
            .position(|q| q == name)
            .unwrap_or_else(|| panic!("{name}"))
    };
    let mut directional_rows = vec![];
    let mut check = |port: &str, p: Ports, expect: Vec<(&str, i32)>, yy: &[f64], base: &[f64]| {
        let r = consistent_rates(&model, yy, &p);
        for (row, sign) in expect {
            let d = r[idx(row)] - base[idx(row)];
            let observed = if d > 0. {
                1
            } else if d < 0. {
                -1
            } else {
                0
            };
            assert_eq!(observed, sign, "port {port}: row {row} moved {d}");
            directional_rows.push(json!({"port": port, "row": row, "declared": sign, "change": d}));
        }
    };
    for (ti, tr) in model.trains.iter().enumerate() {
        for (j, jk) in tr.jackets.iter().enumerate() {
            if jk.tm.is_none() {
                continue;
            }
            let mut p = ports0.clone();
            p.motor_heat[ti][j] += 1e-3;
            let row = format!("{}.{}.MOTOR.T", tr.id, jk.id);
            check(
                &format!("P1-P4 motor heat {}", jk.id),
                p,
                vec![(&row, 1)],
                &y,
                &base,
            );
        }
    }
    let mut p = ports0.clone();
    p.oil_heat *= 1. + 1e-6;
    check(
        "P6 oil heat",
        p,
        vec![("B.TG.OIL.BULK.T", 1), ("B.TG.OIL.COOLER.T", 0)],
        &y,
        &base,
    );
    // oil flow carries no heat at the identical split; at a 1 K bulk excess it
    // moves the pair with the declared signs
    let mut p = ports0.clone();
    p.oil_flow *= 1. + 1e-6;
    check(
        "P5 oil flow (identical split)",
        p.clone(),
        vec![("B.TG.OIL.BULK.T", 0), ("B.TG.OIL.COOLER.T", 0)],
        &y,
        &base,
    );
    let mut y_split = y.clone();
    y_split[idx("B.TG.OIL.BULK.T")] += 1.;
    let base_split = consistent_rates(&model, &y_split, &ports0);
    check(
        "P5 oil flow (bulk +1 K)",
        p,
        vec![("B.TG.OIL.BULK.T", -1), ("B.TG.OIL.COOLER.T", 1)],
        &y_split,
        &base_split,
    );
    let mut p = ports0.clone();
    p.gen_metal += 1e-4;
    check(
        "P8 generator metal T",
        p,
        vec![("B.SW.GEN.U", 1), ("B.SW.HX.U", 0)],
        &y,
        &base,
    );
    let mut p = ports0.clone();
    p.bay += 1e-4;
    check(
        "P9 bay temperature",
        p,
        vec![("A.SW.HX.U", 1), ("B.SW.HX.U", 1), ("B.SW.GEN.U", 1)],
        &y,
        &base,
    );
    let mut p = ports0.clone();
    p.bay_level += 1e-4;
    // more SW flow at a cooler inflow than the cells: the cells' rates fall;
    // the tracking drive pays the extra torque (motor heat rises, rotor rate 0)
    check(
        "P9 bay level",
        p,
        vec![
            ("A.SW.HX.U", -1),
            ("B.SW.HX.U", -1),
            ("B.SW.GEN.U", -1),
            ("A.SW.P.MOTOR.T", 1),
            ("B.SW.P.MOTOR.T", 1),
            ("A.SW.P.OMEGA", 0),
        ],
        &y,
        &base,
    );
    let mut p = ports0.clone();
    p.ambient += 1e-4;
    check(
        "P15 ambient",
        p,
        vec![
            ("A.CCW.P.MOTOR.T", 1),
            ("A.SW.P.MOTOR.T", 1),
            ("B.CCW.P.MOTOR.T", 1),
            ("B.SW.P.MOTOR.T", 1),
        ],
        &y,
        &base,
    );
    // P11 motive support lost (class S): rotor decelerates, motor heat falls
    let mut p = ports0.clone();
    p.supported[1][0] = false;
    check(
        "P11 CCW.B.P support lost",
        p,
        vec![
            ("B.CCW.P.OMEGA", -1),
            ("B.CCW.P.MOTOR.T", -1),
            ("A.CCW.P.OMEGA", 0),
        ],
        &y,
        &base,
    );

    // prepared nonsteadiness (declared: the preparation is not equilibrated)
    let mut rates = vec![];
    for i in 0..n {
        if model.kinds[i] == Kind::Diff {
            let per_kelvin = if model.names[i].ends_with(".U") {
                // dU/dt over M*du/dT of its own cell -> K/s
                let t_name = model.names[i].trim_end_matches(".U").to_string() + ".T";
                let t = idx(&t_name);
                let row = jac
                    .iter()
                    .filter(|&&(r, c, _)| r == t && c == t)
                    .map(|&(_, _, v)| v)
                    .sum::<f64>();
                yp[i] / row
            } else {
                yp[i]
            };
            rates.push(json!({"coordinate": model.names[i], "rate": per_kelvin,
                "unit": if model.names[i].ends_with("OMEGA") { "rad/s2" } else if model.names[i].ends_with(".X") { "1/s" } else { "K/s" }}));
        }
    }
    // EOS round trip: each cell's T recovered from U/M by the maintained
    // pure-phase inverse at its prepared pressure equals its prepared T
    let mut eos_worst: f64 = 0.;
    for tr in &model.trains {
        let mut cells: Vec<(&Cell, usize, usize)> = vec![
            (&tr.sup, tr.u_sup, tr.t_sup),
            (&tr.ret, tr.u_ret, tr.t_ret),
            (&tr.cool, tr.u_cool, tr.t_cool),
        ];
        cells.extend(tr.jackets.iter().map(|j| (&j.cell, j.u, j.t)));
        cells.extend(tr.sw.iter().map(|q| (&q.cell, q.u, q.t)));
        for (c, u, t) in cells {
            let back = point_pu(Branch::Liquid, c.p, y[u] / c.m)
                .expect("IF97 inverse")
                .temperature_k;
            eos_worst = eos_worst.max((back - y[t]).abs());
        }
    }
    assert!(eos_worst <= 1e-9, "EOS round trip {eos_worst} K");
    let displaced = model.displaced(&y);
    for d in &displaced {
        assert!(d.abs() <= 1e-9, "prepared displaced volume {d}");
    }

    // G1.4 the block's own evaluation cost (CPU, this machine)
    cpu::prefer_performance_core();
    let reps = 2000;
    let t0 = cpu::thread_cpu_s();
    let mut sink = 0.;
    for _ in 0..reps {
        sink += model.residual(&y, &yp, &ports0).0[0];
    }
    let residual_s = (cpu::thread_cpu_s() - t0) / reps as f64;
    let t1 = cpu::thread_cpu_s();
    for _ in 0..reps {
        sink += model.eval(&y, &ports0, true).jac.expect("jac").len() as f64;
    }
    let jacobian_s = (cpu::thread_cpu_s() - t1) / reps as f64;
    assert!(sink.is_finite());

    let receipt = json!({
        "scope": "G1-C12 zero-time design prototype (test only; never joined, never a gate)",
        "packetSha256": packet["provenance"]["packetSha256"],
        "census": {"coordinates": n, "differential": differential, "algebraic": algebraic,
            "structuralNonzeros": pattern.len(), "perTrain": model.trains.iter().map(|tr| json!({"train": tr.id,
                "jackets": tr.jackets.iter().map(|j| j.id.clone()).collect::<Vec<_>>(),
                "swPaths": tr.sw.iter().map(|q| q.id.clone()).collect::<Vec<_>>()})).collect::<Vec<_>>()},
        "coordinates": model.names.iter().zip(&model.kinds).map(|(q, k)| json!([q, format!("{k:?}")])).collect::<Vec<_>>(),
        "zeroTime": {"scaledMaxRow": worst.0, "row": model.names[worst.1], "bound": 1e-12, "eosRoundTrip_K": eos_worst},
        "partials": {"compared": partials_compared, "maxRowRelativeDifference": partial_worst.0, "at": partial_worst.1, "bound": 1e-6,
            "rule": "central differences of G(y), h = 1e-6 max(|y_j|, 1), row-max relative"},
        "directional": directional_rows,
        "preparedFlows": model.trains.iter().map(|tr| json!({"train": tr.id, "ccw_kg_s": y[tr.m_c], "calculator_kg_s": tr.prepared_flow,
            "sw_kg_s": y[tr.m_s], "bypass": y[tr.x]})).collect::<Vec<_>>(),
        "preparedRates": rates,
        "displacedVolume_m3": displaced, "displacedVolumeBound_m3": model.displaced_bound,
        "cost": {"residual_cpu_s": residual_s, "jacobian_cpu_s": jacobian_s, "repetitions": reps, "load": cpu::load_average()},
    });
    println!(
        "G1_C12_RECEIPT {}",
        serde_json::to_string(&receipt).expect("receipt")
    );
    if let Ok(path) = std::env::var("LD01_C12_RECEIPT") {
        let provenance =
            |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("a receipt needs {k}"));
        let mut receipt = receipt;
        receipt["provenance"] = json!({
            "appCommit": provenance("LD01_C12_APP_COMMIT"),
            "wikiCommit": provenance("LD01_C12_WIKI_COMMIT"),
            "packet": provenance("LD01_C12_SUPPORT_PACKET"),
            "packetSha256": packet["provenance"]["packetSha256"],
            "consumed": packet["provenance"]["consumed"],
            "waterBuild": provenance("LD01_OPERATING_WATER_LIB_DIR"),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        });
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipts are never overwritten: {path}"
        );
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&receipt).expect("receipt") + "\n",
        )
        .expect("write receipt");
    }
}

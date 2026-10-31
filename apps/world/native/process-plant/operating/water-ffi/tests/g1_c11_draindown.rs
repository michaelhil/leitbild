//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/injection-and-depressurization.md#compact-operating-allocation-15-october-2026
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/passive-cooling/cmt-transport.md#separated-steam-cap-and-depletion
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/engineered-safety-actuation.md#selected-inventory-and-staged-release-sequence
//! G1-C11 critic H1 probe: CMT draindown time to the ADS stage-1 and stage-4
//! level settings under three tank representations. TEST ONLY, never joined,
//! never a gate; integrated with stock SUNDIALS IDA/KLU through the crate's
//! wrapper (stock IDACalcIC at every segment start, stock root finding).
//!
//! Probe boundary (declared, P7-style): the BAL is already voided; its tap
//! (+3 m) supplies saturated steam at `P_S`; DVI is held at `P_S` at +3 m;
//! the tank starts full of the prepared 40 °C water. Liquid and saturation
//! properties are taken at `P_S` (low-Mach: the cap pressure moves by less
//! than 0.1 MPa, ≤ 5e-5 in density). The outlet path carries the allocation's
//! losses (Darcy over 8 m, the isolations, meter, open check body, one
//! discharge head, the 1 kPa check preload) at the bottom layer's liquid;
//! the BAL carries steam with the phase-agnostic passive loss law (S3-D-P8:
//! Darcy over the route with steam properties, the isolation's velocity
//! heads, the holes' inertial thin-screen term) and the steam column from the
//! tap to the surface. The LT is the selected cold-DP channel,
//! `L = 5.95 + DP/(g rho_cal)`, ideal reference column at 15.2 MPa / 40 °C.
//!
//! Representations:
//! - `instant-6`, `instant-12`: C11-D1 + C11-D2: fixed layers (six; twelve
//!   = each halved), donor advection downward, steam into the topmost
//!   subcooled layer condenses at once until that whole layer saturates
//!   (stage R), then the surface descends through it (stage S);
//! - `plug`: the ideal sharp thermocline (the clean separated cap's
//!   condensation-free limit): steam fills the space above a horizontal
//!   surface, the liquid below stays at 40 °C.
#![cfg(all(feature = "ida", any(target_os = "macos", target_os = "linux")))]
#![allow(clippy::too_many_arguments, clippy::needless_range_loop)]
use leitbild_operating_water::{
    Branch, directional,
    ida::{Advance, Failure, Ida, Initial, KluOrdering, System},
    point, point_ph, saturation_caloric,
};
use serde_json::{Value, json};
use std::ops::{Add, Div, Mul, Neg, Sub};

const G: f64 = 9.80665;

#[derive(Clone, Copy, Debug)]
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
    fn abs(self) -> Self {
        if self.v < 0. { -self } else { self }
    }
    fn sqrt(self) -> Self {
        let s = self.v.sqrt();
        Self::new(s, if self.d == 0. { 0. } else { self.d / (2. * s) })
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
impl Mul<f64> for D {
    type Output = D;
    fn mul(self, o: f64) -> D {
        D::new(self.v * o, self.d * o)
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
fn c(v: f64) -> D {
    D::c(v)
}

fn num(v: &Value, path: &str) -> f64 {
    v.pointer(path)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("packet field {path}"))
}

// ------------------------------------------------------------ tank geometry
/// The free-area law A(z) of the CMT geometry owner from the compiled inputs.
#[derive(Clone)]
struct Tank {
    r: f64,
    a: f64,
    tip0: f64,
    tip1: f64,
    body0: f64,
    body1: f64,
    rb: f64,
    rf: f64,
    mouth: f64,
    roof: f64,
}
impl Tank {
    fn shell2(&self, z: f64) -> (f64, f64) {
        // (R_wall^2, d R_wall^2/dz)
        let (x, dx) = if z - self.tip0 <= self.tip1 - z {
            (z - self.tip0, 1.)
        } else {
            (self.tip1 - z, -1.)
        };
        if x >= self.a {
            (self.r * self.r, 0.)
        } else {
            let s = x / self.a;
            (
                self.r * self.r * (2. * s - s * s),
                self.r * self.r * (2. - 2. * s) / self.a * dx,
            )
        }
    }
    fn obstruction2(&self, z: f64) -> f64 {
        if z >= self.body0 && z <= self.body1 {
            self.rb * self.rb
        } else if z > self.body1 {
            self.rf * self.rf
        } else {
            0.
        }
    }
    fn area(&self, z: D) -> D {
        if z.v < self.mouth || z.v > self.roof {
            return c(0.);
        }
        let (s2, ds) = self.shell2(z.v);
        let net = s2 - self.obstruction2(z.v);
        if net <= 0. {
            c(0.)
        } else {
            D::new(std::f64::consts::PI * net, std::f64::consts::PI * ds * z.d)
        }
    }
    /// Free volume between z0 < z1: two-point Gauss per piece between the
    /// geometric breaks (exact for the piecewise quadratic area).
    fn volume(&self, z0: f64, z1: f64) -> f64 {
        let mut cuts = vec![
            z0,
            z1,
            self.tip0 + self.a,
            self.tip1 - self.a,
            self.body0,
            self.body1,
        ];
        cuts.retain(|&z| z >= z0 && z <= z1);
        cuts.sort_by(f64::total_cmp);
        cuts.dedup();
        let mut v = 0.;
        for w in cuts.windows(2) {
            let (m, h) = ((w[0] + w[1]) / 2., (w[1] - w[0]) / 2.);
            for s in [-1., 1.] {
                v += h * self.area(c(m + s * h / 3f64.sqrt())).v;
            }
        }
        v
    }
}

// --------------------------------------------------------------- properties
/// Liquid at the probe pressure as a function of specific enthalpy:
/// density with its exact tangent, dρ/dh (value), viscosity (value).
fn liquid(p: f64, h: D) -> Result<(D, f64, f64), String> {
    // A trial beyond the liquid's admitted band is recoverable: stock IDA retries.
    let t = point_ph(Branch::Liquid, p, h.v)
        .map_err(|e| format!("IF97 (p,h) {h:?}: {e}"))?
        .temperature_k;
    let (q, d) =
        directional(Branch::Liquid, p, t, 0., 1.).map_err(|e| format!("IF97 liquid: {e}"))?;
    let drho_dh = d.density_kg_m3 / d.enthalpy_j_kg;
    Ok((
        D::new(q.density_kg_m3, drho_dh * h.d),
        drho_dh,
        q.viscosity_pa_s,
    ))
}
/// Darcy: 64/Re through 2300, Colebrook from 4000, linear between (value for
/// the friction factor; the laminar limit at zero flow).
fn darcy(m: D, rho: f64, mu: f64, length: f64, d: f64, area: f64, rough: f64) -> D {
    if m.v == 0. {
        return m * (32. * mu * length / (rho * area * d * d));
    }
    // Friction factor and its Re-derivative: laminar 64/Re, Colebrook (implicit tangent), linear blend.
    let colebrook = |re: f64| -> (f64, f64) {
        let mut x = 8f64;
        for _ in 0..60 {
            x = -2. * (rough / d / 3.7 + 2.51 * x / re).log10();
        }
        let a = rough / d / 3.7 + 2.51 * x / re;
        let k = 2. / std::f64::consts::LN_10 / a;
        let dx = -(k * (-2.51 * x / (re * re))) / (1. + k * 2.51 / re);
        (1. / (x * x), -2. / (x * x * x) * dx)
    };
    let re_v = m.v.abs() * d / (area * mu);
    let dre = m.d.abs().max(0.) * 0. + (if m.v >= 0. { m.d } else { -m.d }) * d / (area * mu);
    let (f, df) = if re_v <= 2300. {
        (64. / re_v, -64. / (re_v * re_v))
    } else if re_v >= 4000. {
        colebrook(re_v)
    } else {
        let (f4, _) = colebrook(4000.);
        (
            64. / 2300. + (re_v - 2300.) * (f4 - 64. / 2300.) / 1700.,
            (f4 - 64. / 2300.) / 1700.,
        )
    };
    let fd = D::new(f, df * dre);
    m * m.abs() * fd * (length / (2. * d * rho * area * area))
}

struct Prm {
    tank: Tank,
    p_s: f64,
    h0: f64,
    hf: f64,
    rhof: f64,
    hg: f64,
    rhog: f64,
    mug: f64,
    rho_cal: f64,
    upper_tap: f64,
    // Outlet path.
    pipe_l: f64,
    bore: f64,
    rough: f64,
    k_out: f64,
    crack: f64,
    // BAL steam path.
    bal_l: f64,
    k_bal: f64,
    holes: f64,
    cd: f64,
    low: f64,
    lowlow: f64,
}
impl Prm {
    fn pipe_area(&self) -> f64 {
        std::f64::consts::PI * self.bore * self.bore / 4.
    }
    /// The cap pressure at the surface from the BAL's steam flow (S3-D-P8 gas form).
    fn bal_residual(&self, p_t: D, m_s: D, z_s: D) -> D {
        let a = self.pipe_area();
        let loss = darcy(
            m_s, self.rhog, self.mug, self.bal_l, self.bore, a, self.rough,
        ) + m_s * m_s.abs() * (self.k_bal / (2. * self.rhog * a * a))
            + m_s
                * m_s.abs()
                * (1. / (2. * self.rhog * self.cd * self.cd * self.holes * self.holes));
        p_t - c(self.p_s) + (z_s - 3.) * (self.rhog * G) + loss
    }
    /// The outlet's drive minus its losses, at the bottom liquid's state.
    fn outlet_residual(&self, p_bottom: D, m_o: D, rho1: D, mu1: f64) -> D {
        let a = self.pipe_area();
        let drive = p_bottom + rho1 * (G * (self.tank.mouth - 3.)) - self.p_s - self.crack;
        let loss = darcy(m_o, rho1.v, mu1, self.pipe_l, self.bore, a, self.rough)
            + m_o * m_o.abs() * (self.k_out / (2. * a * a)) / rho1;
        drive - loss
    }
}

// ------------------------------------------------------------------ stages
#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    /// Surface in layer k (1-based), saturated liquid below the surface, full layers 1..k-1.
    S(usize),
    /// Layer k full and subcooled, receiving condensing steam; full layers 1..k.
    R(usize),
    /// Ideal sharp thermocline: one cold liquid column below the surface.
    Plug,
}

struct Seg {
    prm: std::rc::Rc<Prm>,
    cuts: Vec<f64>,
    vols: Vec<f64>,
    stage: Stage,
}
impl Seg {
    fn n(&self) -> usize {
        match self.stage {
            Stage::S(k) => 2 * k + 2,
            Stage::R(k) => 2 * k + 3,
            Stage::Plug => 4,
        }
    }
    fn differential(&self) -> Vec<f64> {
        let mut id = vec![0.; self.n()];
        match self.stage {
            Stage::S(k) => {
                for j in 0..k {
                    id[j] = 1.;
                }
            }
            Stage::R(k) => {
                for j in 0..k {
                    id[j] = 1.;
                }
                id[2 * k + 2] = 1.;
            }
            Stage::Plug => id[0] = 1.,
        }
        id
    }
    /// The residual (dual numbers), in variable order.
    fn rows(&self, y: &[D], yp: &[D]) -> Result<Vec<D>, String> {
        let p = &self.prm;
        let n = self.n();
        let mut r = vec![c(0.); n];
        match self.stage {
            Stage::Plug => {
                let (z, m_o, p_t, m_s) = (y[0], y[1], y[2], y[3]);
                let a = p.tank.area(z);
                let (rho0, _, mu0) = liquid(p.p_s, c(p.h0))?;
                r[0] = rho0 * a * yp[0] + m_o;
                let bottom = p_t + rho0 * (z - p.tank.mouth) * G;
                r[1] = p.outlet_residual(bottom, m_o, rho0, mu0);
                r[2] = p.bal_residual(p_t, m_s, z);
                r[3] = m_s + a * yp[0] * p.rhog;
            }
            Stage::S(k) => {
                let z = y[0];
                let h = |j: usize| y[j]; // layers 1..k-1 at indices 1..k-1
                let w = |j: usize| y[k + j]; // w_0..w_{k-1}
                let (p_t, m_s) = (y[2 * k], y[2 * k + 1]);
                let a = p.tank.area(z);
                r[0] = a * yp[0] * p.rhof + w(k - 1);
                let mut column = (z - self.cuts[k - 1]) * (p.rhof * G);
                for j in 1..k {
                    let (rho, drho, _) = liquid(p.p_s, h(j))?;
                    let up = if j + 1 < k { h(j + 1) } else { c(p.hf) };
                    let v = self.vols[j - 1];
                    r[j] = (rho + h(j) * drho) * yp[j] * v - (w(j) * up - w(j - 1) * h(j));
                    r[k + j] = yp[j] * (drho * v) - (w(j) - w(j - 1));
                    column = column + rho * (G * (self.cuts[j] - self.cuts[j - 1]));
                }
                let (rho1, mu1) = if k > 1 {
                    let (rho, _, mu) = liquid(p.p_s, h(1))?;
                    (rho, mu)
                } else {
                    (c(p.rhof), liquid(p.p_s, c(p.hf))?.2)
                };
                r[k] = p.outlet_residual(p_t + column, w(0), rho1, mu1);
                r[2 * k] = p.bal_residual(p_t, m_s, z);
                r[2 * k + 1] = m_s + a * yp[0] * p.rhog;
            }
            Stage::R(k) => {
                let h = |j: usize| y[j - 1]; // layers 1..k at indices 0..k-1
                let w = |j: usize| y[k + j];
                let (cond, p_t) = (y[2 * k], y[2 * k + 1]);
                let mut column = c(0.);
                for j in 1..=k {
                    let (rho, drho, _) = liquid(p.p_s, h(j))?;
                    let v = self.vols[j - 1];
                    let inflow = if j < k { w(j) * h(j + 1) } else { cond * p.hg };
                    let above = if j < k { w(j) } else { cond };
                    r[j - 1] = (rho + h(j) * drho) * yp[j - 1] * v - (inflow - w(j - 1) * h(j));
                    let mass_row = if j < k { k + j } else { 2 * k };
                    r[mass_row] = yp[j - 1] * (drho * v) - (above - w(j - 1));
                    column = column + rho * (G * (self.cuts[j] - self.cuts[j - 1]));
                }
                let (rho1, _, mu1) = liquid(p.p_s, h(1))?;
                r[k] = p.outlet_residual(p_t + column, w(0), rho1, mu1);
                r[2 * k + 1] = p.bal_residual(p_t, cond, c(self.cuts[k]));
                r[2 * k + 2] = yp[2 * k + 2] - cond;
            }
        }
        Ok(r)
    }
    /// The LT indication and the stage roots.
    fn indication(&self, y: &[f64]) -> f64 {
        let p = &self.prm;
        let (zm, zu) = (p.tank.mouth, p.upper_tap);
        let seg = |z0: f64, z1: f64, rho: f64| (z1.min(zu) - z0.max(zm)).max(0.) * rho * G;
        let mut dp = 0.;
        let surface = match self.stage {
            Stage::Plug => {
                dp += seg(zm, y[0], liquid(p.p_s, c(p.h0)).unwrap().0.v);
                y[0]
            }
            Stage::S(k) => {
                for j in 1..k {
                    dp += seg(
                        self.cuts[j - 1],
                        self.cuts[j],
                        liquid(p.p_s, c(y[j])).unwrap().0.v,
                    );
                }
                dp += seg(self.cuts[k - 1], y[0], p.rhof);
                y[0]
            }
            Stage::R(k) => {
                for j in 1..=k {
                    dp += seg(
                        self.cuts[j - 1],
                        self.cuts[j],
                        liquid(p.p_s, c(y[j - 1])).unwrap().0.v,
                    );
                }
                self.cuts[k]
            }
        };
        dp += seg(surface, zu, p.rhog);
        5.95 + (dp - p.rho_cal * G * (zu - zm)) / (G * p.rho_cal)
    }
    fn root_values(&self, y: &[f64]) -> Vec<f64> {
        let p = &self.prm;
        let l = self.indication(y);
        let stage_root = match self.stage {
            Stage::S(k) => y[0] - self.cuts[k - 1],
            Stage::R(k) => y[k - 1] - p.hf,
            Stage::Plug => y[0] - p.tank.mouth,
        };
        vec![stage_root, l - p.low, l - p.lowlow]
    }
}
impl System for Seg {
    /// Unreduced: every coordinate stands for itself (E-NUC).
    fn multiplicities(&self) -> Option<Vec<f64>> {
        None
    }
    fn dimension(&self) -> usize {
        self.n()
    }
    fn nonzeros(&self) -> usize {
        self.n() * self.n()
    }
    fn root_count(&self) -> usize {
        3
    }
    fn klu_ordering(&self) -> KluOrdering {
        KluOrdering::Colamd
    }
    fn residual(&mut self, _t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let yd: Vec<D> = y.iter().map(|&v| c(v)).collect();
        let ypd: Vec<D> = yp.iter().map(|&v| c(v)).collect();
        let rows = self.rows(&yd, &ypd).map_err(Failure::Recoverable)?;
        for (o, r) in out.iter_mut().zip(rows) {
            if !r.v.is_finite() {
                return Err(Failure::Recoverable("nonfinite probe row".into()));
            }
            *o = r.v;
        }
        Ok(())
    }
    fn jacobian(
        &mut self,
        _t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let n = self.n();
        for col in 0..n {
            let mut yd: Vec<D> = y.iter().map(|&v| c(v)).collect();
            let mut ypd: Vec<D> = yp.iter().map(|&v| c(v)).collect();
            yd[col].d = 1.;
            ypd[col].d = cj;
            let f = self.rows(&yd, &ypd).map_err(Failure::Recoverable)?;
            pointers[col] = (col * n) as i64;
            for row in 0..n {
                data[col * n + row] = f[row].d;
                rows[col * n + row] = row as i64;
            }
        }
        pointers[n] = (n * n) as i64;
        Ok(())
    }
    fn roots(&mut self, _t: f64, y: &[f64], _yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        out.copy_from_slice(&self.root_values(y));
        Ok(())
    }
}

/// One closed-form flow guess for a segment's stock IDACalcIC (no iteration):
/// losses scale as m², so m = 25 kg/s × sqrt(available drive / losses at
/// 25 kg/s), the BAL carrying the condensing steam (stage R) or only the
/// displacement steam (stages S and plug). Returns (m_o, m_s, p_t).
fn guess(prm: &Prm, stage: Stage, cuts: &[f64], h: &[f64], z: f64) -> (f64, f64, f64) {
    let a = prm.pipe_area();
    let (surface, condensing) = match stage {
        Stage::R(k) => (cuts[k].min(z.max(cuts[k])), true),
        _ => (z, false),
    };
    let mut column = 0.;
    let mut bottom = (
        liquid(prm.p_s, c(prm.h0)).unwrap().0.v,
        liquid(prm.p_s, c(prm.h0)).unwrap().2,
    );
    match stage {
        Stage::Plug => column = bottom.0 * G * (surface - prm.tank.mouth),
        Stage::S(k) | Stage::R(k) => {
            let full = if matches!(stage, Stage::S(_)) {
                k - 1
            } else {
                k
            };
            for j in 1..=full {
                let (rho, _, mu) = liquid(prm.p_s, c(h[j - 1])).unwrap();
                if j == 1 {
                    bottom = (rho.v, mu);
                }
                column += rho.v * G * (cuts[j] - cuts[j - 1]);
            }
            if let Stage::S(k) = stage {
                column += prm.rhof * G * (surface - cuts[k - 1]);
                if k == 1 {
                    bottom = (prm.rhof, bottom.1);
                }
            }
        }
    }
    let drive =
        column + bottom.0 * G * (prm.tank.mouth - 3.) - prm.rhog * G * (surface - 3.) - prm.crack;
    let out25 = darcy(
        c(25.),
        bottom.0,
        bottom.1,
        prm.pipe_l,
        prm.bore,
        a,
        prm.rough,
    )
    .v + 625. * prm.k_out / (2. * bottom.0 * a * a);
    let per = if condensing { 1. } else { prm.rhog / prm.rhof };
    let bal25 = prm.bal_residual(c(0.), c(25. * per), c(3.)).v + prm.p_s;
    let m_o = 25. * (drive.max(0.) / (out25 + bal25)).sqrt();
    let p_t = prm.p_s - prm.rhog * G * (surface - 3.) - bal25 * (m_o / 25.).powi(2);
    (m_o, m_o * per, p_t)
}

/// One draindown run; returns the LT crossing times, the stage history and the steam condensed per layer.
fn run(prm: std::rc::Rc<Prm>, cuts: Vec<f64>, plug: bool, horizon: f64) -> Value {
    let vols: Vec<f64> = cuts
        .windows(2)
        .map(|w| prm.tank.volume(w[0], w[1]))
        .collect();
    let nl = vols.len();
    let mut stage = if plug { Stage::Plug } else { Stage::R(nl) };
    let mut t = 0.;
    // State carried between segments: layer enthalpies, surface, flows.
    let mut h: Vec<f64> = vec![prm.h0; nl];
    // The free area vanishes at the roof; a surface starts at the +11.95 m upper tap
    // (the 0.025 m³ above it is outside the LT span and is taken as steam-filled at the start).
    let top = prm.tank.roof.min(prm.upper_tap);
    let mut z = top;
    // Flow guesses for the first stock IDACalcIC (the outlet sizing flow; steam by volume replacement).
    let (mut m_o, mut m_s) = (25., if plug { 25. * prm.rhog / prm.rhof } else { 25. });
    let mut p_t = prm.p_s - prm.rhog * G * (z - 3.);
    (m_o, m_s, p_t) = guess(&prm, stage, &cuts, &h, z);
    let (mut low, mut lowlow) = (None::<f64>, None::<f64>);
    let mut condensed = vec![0.; nl];
    let mut history = Vec::new();
    let mut failure: Option<String> = None;
    while t < horizon && lowlow.is_none() {
        let seg = Seg {
            prm: prm.clone(),
            cuts: cuts.clone(),
            vols: vols.clone(),
            stage,
        };
        let n = seg.n();
        let mut y = vec![0.; n];
        let mut atol = vec![1e-3; n];
        match stage {
            Stage::Plug => {
                y = vec![z, m_o, p_t, m_s];
                atol = vec![1e-6, 1e-3, 10., 1e-4];
            }
            Stage::S(k) => {
                y[0] = z;
                atol[0] = 1e-6;
                for j in 1..k {
                    y[j] = h[j - 1];
                    atol[j] = 1e-2;
                }
                for j in 0..k {
                    y[k + j] = m_o;
                }
                y[2 * k] = p_t;
                y[2 * k + 1] = m_s;
                atol[2 * k] = 10.;
            }
            Stage::R(k) => {
                for j in 1..=k {
                    y[j - 1] = h[j - 1];
                    atol[j - 1] = 1e-2;
                }
                for j in 0..k {
                    y[k + j] = m_o;
                }
                y[2 * k] = m_s;
                y[2 * k + 1] = p_t;
                atol[2 * k + 1] = 10.;
                atol[2 * k + 2] = 1e-3;
            }
        }
        let yp = vec![0.; n];
        let id = seg.differential();
        let start_roots = seg.root_values(&y);
        let mut ida = Ida::new(
            seg,
            Initial {
                time: t,
                y: &y,
                yp: &yp,
                differential: &id,
                absolute_tolerance: &atol,
                relative_tolerance: 1e-6,
            },
        )
        .expect("stock IDA");
        let mut y = y;
        let mut yp = yp;
        if let Err(e) = ida.initialize(t + 1e-3, &mut y, &mut yp) {
            failure = Some(format!("stock IDACalcIC at {stage:?}, t = {t} s: {e}"));
            break;
        }
        // Stage root rising for R (saturation), falling otherwise; LT roots falling.
        let dir0 = if matches!(stage, Stage::R(_)) { 1 } else { -1 };
        ida.set_root_directions(&[dir0, -1, -1])
            .expect("root directions");
        history.push(json!({"stage": format!("{stage:?}"), "t_s": t, "startRoots": start_roots}));
        let next = loop {
            let step = match ida.advance(horizon, &mut y, &mut yp) {
                Ok(step) => step,
                Err(e) => {
                    failure = Some(format!("stock IDA at {stage:?}: {e}"));
                    break None;
                }
            };
            match step {
                Advance::Reached(time) => {
                    t = time;
                    break None;
                }
                Advance::Root { time, directions } => {
                    t = time;
                    if directions[1] != 0 && low.is_none() {
                        low = Some(time);
                    }
                    if directions[2] != 0 && lowlow.is_none() {
                        lowlow = Some(time);
                        break None;
                    }
                    if directions[0] != 0 {
                        break Some(());
                    }
                }
            }
        };
        // Carry the state across the transaction.
        match stage {
            Stage::Plug => {
                z = y[0];
                m_o = y[1];
                p_t = y[2];
                m_s = y[3];
            }
            Stage::S(k) => {
                z = y[0];
                for j in 1..k {
                    h[j - 1] = y[j];
                }
                h[k - 1] = prm.hf;
                m_o = y[k];
                p_t = y[2 * k];
                m_s = y[2 * k + 1];
                if next.is_some() {
                    if k == 1 {
                        break;
                    }
                    stage = if h[k - 2] >= prm.hf {
                        Stage::S(k - 1)
                    } else {
                        Stage::R(k - 1)
                    };
                    z = cuts[k - 1];
                    (m_o, m_s, p_t) = guess(&prm, stage, &cuts, &h, z);
                }
            }
            Stage::R(k) => {
                for j in 1..=k {
                    h[j - 1] = y[j - 1];
                }
                m_o = y[k];
                m_s = y[2 * k];
                p_t = y[2 * k + 1];
                condensed[k - 1] += y[2 * k + 2];
                if next.is_some() {
                    stage = Stage::S(k);
                    z = cuts[k].min(top);
                    (m_o, m_s, p_t) = guess(&prm, stage, &cuts, &h, z);
                }
            }
        }
        if next.is_none() || failure.is_some() {
            break;
        }
    }
    json!({"lowLevel_s": low, "lowLowLevel_s": lowlow, "end_s": t, "stages": history, "failure": failure,
        "condensedPerLayer_kg": condensed, "layerCuts_m": cuts, "layerVolumes_m3": vols})
}

#[test]
#[ignore = "G1-C11 critic H1 probe: needs LD01_G1_C11_PACKET"]
fn g1_c11_cmt_draindown_timing() {
    let path = std::env::var("LD01_G1_C11_PACKET").expect("LD01_G1_C11_PACKET");
    let packet: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let g = &packet["cmt"]["geometry"];
    let tank = Tank {
        r: num(g, "/shellRadius_m"),
        a: num(g, "/headDepth_m"),
        tip0: num(g, "/bottomTip_m"),
        tip1: num(g, "/topTip_m"),
        body0: num(g, "/bodyBottom_m"),
        body1: num(g, "/bodyTop_m"),
        rb: num(g, "/bodyRadius_m"),
        rf: num(g, "/feedRadius_m"),
        mouth: num(&packet, "/cmt/mouth_m"),
        roof: num(&packet, "/cmt/roof_m"),
    };
    let six: Vec<f64> = std::iter::once(num(&packet, "/cmt/layers/0/bottom_m"))
        .chain(
            packet["cmt"]["layers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| num(l, "/top_m")),
        )
        .collect();
    let halve = |cuts: &[f64]| -> Vec<f64> {
        cuts.windows(2)
            .flat_map(|w| [w[0], (w[0] + w[1]) / 2.])
            .chain([*cuts.last().unwrap()])
            .collect()
    };
    let twelve = halve(&six);
    // A refinement witness (not a candidate representation): each layer halved twice.
    let twentyfour = halve(&twelve);
    let pressures: Vec<f64> = std::env::var("LD01_G1_C11_PROBE_MPA")
        .unwrap_or("8".into())
        .split(',')
        .map(|s| s.parse::<f64>().unwrap() * 1e6)
        .collect();
    let a_pipe = std::f64::consts::PI * 0.2 * 0.2 / 4.;
    let k_of = |a: f64| (a_pipe / a).powi(2) - 1.;
    let o = &packet["cmt"]["outlet"];
    let holes: f64 = packet["cmt"]["rings"]["list"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| num(r, "/area_m2"))
        .sum();
    let bal_cells = packet["cmt"]["balance"]["cells"].as_array().unwrap();
    let mut results = Vec::new();
    for &p_s in &pressures {
        let [(liq, _), (vap, _)] = saturation_caloric(p_s, 0.).unwrap();
        let mug = point(Branch::SaturatedVapor, p_s, 0.)
            .unwrap()
            .viscosity_pa_s;
        let h0 = directional(
            Branch::Liquid,
            p_s,
            num(&packet, "/cmt/temperature_K"),
            0.,
            0.,
        )
        .unwrap()
        .0
        .enthalpy_j_kg;
        let prm = std::rc::Rc::new(Prm {
            tank: tank.clone(),
            p_s,
            h0,
            hf: liq.enthalpy_j_kg,
            rhof: liq.density_kg_m3,
            hg: vap.enthalpy_j_kg,
            rhog: vap.density_kg_m3,
            mug,
            rho_cal: directional(Branch::Liquid, 15.2e6, 313.15, 0., 0.)
                .unwrap()
                .0
                .density_kg_m3,
            upper_tap: num(&packet, "/cmt/upperTap_m"),
            pipe_l: num(o, "/cell/length_m"),
            bore: num(o, "/bore_m"),
            rough: num(o, "/roughness_m"),
            k_out: k_of(num(o, "/isolation/area_m2"))
                + k_of(num(o, "/meter/area_m2"))
                + k_of(num(o, "/check/area_m2"))
                + 1.,
            crack: num(o, "/check/crack_Pa"),
            bal_l: bal_cells.iter().map(|c| num(c, "/length_m")).sum(),
            k_bal: k_of(num(&packet, "/cmt/balance/isolation/area_m2")),
            holes,
            cd: num(&packet, "/cmt/rings/Cd"),
            low: num(&packet, "/sequence/cmtLowLevel_m"),
            lowlow: num(&packet, "/sequence/cmtLowLowLevel_m"),
        });
        let horizon = 6000.;
        let plug = run(prm.clone(), six.clone(), true, horizon);
        let i6 = run(prm.clone(), six.clone(), false, horizon);
        let i12 = run(prm.clone(), twelve.clone(), false, horizon);
        let i24 = run(prm.clone(), twentyfour.clone(), false, horizon);
        println!(
            "p_s {} MPa: plug low {:?} lowlow {:?}; instant-6 {:?} {:?}; instant-12 {:?} {:?}",
            p_s / 1e6,
            plug["lowLevel_s"],
            plug["lowLowLevel_s"],
            i6["lowLevel_s"],
            i6["lowLowLevel_s"],
            i12["lowLevel_s"],
            i12["lowLowLevel_s"]
        );
        println!(
            "  condensed per layer (kg): six {}; twelve {}",
            i6["condensedPerLayer_kg"], i12["condensedPerLayer_kg"]
        );
        results.push(json!({"steamPressure_Pa": p_s, "saturation": {"hf": liq.enthalpy_j_kg, "hg": vap.enthalpy_j_kg, "rhof": liq.density_kg_m3, "rhog": vap.density_kg_m3},
            "plug": plug, "instant6": i6, "instant12": i12, "instant24": i24}));
    }
    let receipt = json!({"lane": "g1-c11", "probe": "g1_c11_draindown (critic H1)", "kind": "test-only, stock IDA, never joined, never a gate",
        "boundary": "BAL voided; saturated steam at the tap; DVI at the same pressure at +3 m; tank full of 40 C water; properties at the probe pressure",
        "results": results,
        "provenance": {"packet": path, "appCommit": std::env::var("LD01_G1_C11_APP_COMMIT").unwrap_or_default()}});
    if let Ok(out) = std::env::var("LD01_G1_C11_DRAIN_RECEIPT") {
        assert!(
            !std::path::Path::new(&out).exists(),
            "receipts are never overwritten: {out}"
        );
        std::fs::write(&out, serde_json::to_string_pretty(&receipt).unwrap()).unwrap();
        println!("receipt {out}");
    }
}

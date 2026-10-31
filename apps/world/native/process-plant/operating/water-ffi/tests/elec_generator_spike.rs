//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! ELEC S3 spike, a measurement only (NOT evidence, NOT a production path):
//! the selected balanced machine (two stator flux linkages, field linkage,
//! shaft, angle) on a declared stiff 10 kV / 50 Hz bus in stock IDA with the
//! S2 event-window configuration (BDF <= 2, coefficient 0.33, dcj 0.1, first
//! step 1e-4 s), through declared excitations. Parameters come only from the
//! page's strict `reference-generator` block via the existing checker's
//! parser (`reference-design-generator.ts`), passed as JSON in
//! ELEC_GENERATOR_PARAMS. The imposed shaft torque, the excitations and the
//! padding dimension are declared spike apparatus, not plant inputs.
//!
//! Padding: `pad` extra coordinates with residual y' = 0 have exactly zero
//! local error and only change N in stock IDA's WRMS norm; they show how the
//! machine's error weighs inside a composed DAE of N coordinates.
#![cfg(feature = "ida")]
use leitbild_operating_water::ida::{Failure, Ida, Initial, System};
use serde_json::{Value, json};
use std::{f64::consts::PI, io::Write};

mod common;
use common::cpu;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Connected,
    Open,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Order {
    /// The selected machine: stator flux linkages differential.
    Full,
    /// Owner option O4 (diagnostic): stator transients neglected, the stator
    /// voltage equations algebraic; everything else unchanged.
    Reduced,
    /// O4b (diagnostic): as Reduced, with rated speed in the stator speed
    /// voltages (the usual form that keeps the swing damping).
    ReducedRated,
}
#[derive(Clone, Debug)]
struct Machine {
    ls: f64,
    m: f64,
    lf: f64,
    rs: f64,
    rf: f64,
    j: f64,
    p: f64,
    /// rated mechanical speed (O4b only)
    wr: f64,
    v: f64,
    f: f64,
    vf: f64,
    tau: f64,
    mode: Mode,
    order: Order,
    pad: usize,
}
const N0: usize = 8; // ld lq lf w th id iq if
impl Machine {
    fn n(&self) -> usize {
        N0 + self.pad
    }
    fn differential(&self) -> Vec<f64> {
        let stator = if self.mode == Mode::Connected && self.order == Order::Full {
            1.
        } else {
            0.
        };
        let mut d = vec![stator, stator, 1., 1., 1., 0., 0., 0.];
        d.extend(std::iter::repeat_n(1., self.pad));
        d
    }
    fn currents(&self, ld: f64, lq: f64, lf: f64) -> [f64; 3] {
        let det = self.ls * self.lf - self.m * self.m;
        [
            (self.lf * ld - self.m * lf) / det,
            lq / self.ls,
            (self.ls * lf - self.m * ld) / det,
        ]
    }
    /// The machine's eight rows (physical units).
    fn rows(&self, y: &[f64], yp: &[f64], out: &mut [f64]) {
        let (ld, lq, lf, w, th, id, iq, i_f) = (y[0], y[1], y[2], y[3], y[4], y[5], y[6], y[7]);
        let (vd, vq) = (self.v * th.cos(), -self.v * th.sin());
        match (self.mode, self.order) {
            (Mode::Open, _) => {
                out[0] = id;
                out[1] = iq;
            }
            (Mode::Connected, Order::Full) => {
                out[0] = yp[0] - (vd - self.rs * id + self.p * w * lq);
                out[1] = yp[1] - (vq - self.rs * iq - self.p * w * ld);
            }
            (Mode::Connected, Order::Reduced) => {
                out[0] = -(vd - self.rs * id + self.p * w * lq);
                out[1] = -(vq - self.rs * iq - self.p * w * ld);
            }
            (Mode::Connected, Order::ReducedRated) => {
                out[0] = -(vd - self.rs * id + self.p * self.wr * lq);
                out[1] = -(vq - self.rs * iq - self.p * self.wr * ld);
            }
        }
        out[2] = yp[2] - (self.vf - self.rf * i_f);
        out[3] = self.j * yp[3] - (self.tau + self.p * self.m * i_f * iq);
        out[4] = yp[4] - (self.p * w - 2. * PI * self.f);
        out[5] = ld - (self.ls * id + self.m * i_f);
        out[6] = lq - self.ls * iq;
        out[7] = lf - (self.m * id + self.lf * i_f);
    }
    /// Dense 8x8 block of dF/dy + cj dF/dy', column-major.
    fn block(&self, cj: f64, y: &[f64]) -> [[f64; 8]; 8] {
        let (ld, lq, w, th, iq, i_f) = (y[0], y[1], y[3], y[4], y[6], y[7]);
        let mut g = [[0.; 8]; 8]; // g[col][row]
        let stator_cj = if self.mode == Mode::Connected && self.order == Order::Full {
            cj
        } else {
            0.
        };
        match self.mode {
            Mode::Open => {
                g[5][0] = 1.;
                g[6][1] = 1.;
            }
            Mode::Connected => {
                let (ws, dw) = if self.order == Order::ReducedRated {
                    (self.wr, 0.)
                } else {
                    (w, 1.)
                };
                g[0][0] = stator_cj;
                g[1][0] = -self.p * ws;
                g[3][0] = -self.p * lq * dw;
                g[4][0] = self.v * th.sin();
                g[5][0] = self.rs;
                g[1][1] = stator_cj;
                g[0][1] = self.p * ws;
                g[3][1] = self.p * ld * dw;
                g[4][1] = self.v * th.cos();
                g[6][1] = self.rs;
            }
        }
        g[2][2] = cj;
        g[7][2] = self.rf;
        g[3][3] = self.j * cj;
        g[7][3] = -self.p * self.m * iq;
        g[6][3] = -self.p * self.m * i_f;
        g[4][4] = cj;
        g[3][4] = -self.p;
        g[0][5] = 1.;
        g[5][5] = -self.ls;
        g[7][5] = -self.m;
        g[1][6] = 1.;
        g[6][6] = -self.ls;
        g[2][7] = 1.;
        g[5][7] = -self.m;
        g[7][7] = -self.lf;
        g
    }
    /// Exact consistent (y, y') for the current mode from the retained
    /// differential coordinates (lf, w, th; and ld, lq when connected-full).
    fn consistent(&self, y: &mut [f64], yp: &mut [f64]) {
        let (lf, w, th) = (y[2], y[3], y[4]);
        let rates = |s: &Machine, y: &mut [f64]| -> [f64; 5] {
            // algebraic closure for the mode, then the differential rates
            match (s.mode, s.order) {
                (Mode::Connected, Order::Full) => {}
                (Mode::Open, _) => {
                    y[5] = 0.;
                    y[6] = 0.;
                    y[7] = y[2] / s.lf;
                    y[0] = s.m * y[7];
                    y[1] = 0.;
                }
                (Mode::Connected, Order::Reduced | Order::ReducedRated) => {
                    let ws = if s.order == Order::ReducedRated {
                        s.wr
                    } else {
                        y[3]
                    };
                    let z = s.reduced_stator(y[2], ws, y[4]);
                    y[0] = z[0];
                    y[1] = z[1];
                }
            }
            let c = s.currents(y[0], y[1], y[2]);
            y[5] = c[0];
            y[6] = c[1];
            y[7] = c[2];
            let (vd, vq) = (s.v * y[4].cos(), -s.v * y[4].sin());
            [
                vd - s.rs * c[0] + s.p * y[3] * y[1],
                vq - s.rs * c[1] - s.p * y[3] * y[0],
                s.vf - s.rf * c[2],
                (s.tau + s.p * s.m * c[2] * c[1]) / s.j,
                s.p * y[3] - 2. * PI * s.f,
            ]
        };
        let r = rates(self, y);
        yp[2] = r[2];
        yp[3] = r[3];
        yp[4] = r[4];
        match (self.mode, self.order) {
            (Mode::Connected, Order::Full) => {
                yp[0] = r[0];
                yp[1] = r[1];
            }
            _ => {
                // algebraic stator: time derivative along the differential rates
                let e = 1e-6;
                let mut a = y.to_vec();
                let mut b = y.to_vec();
                a[2] = lf + e * yp[2];
                a[3] = w + e * yp[3];
                a[4] = th + e * yp[4];
                b[2] = lf - e * yp[2];
                b[3] = w - e * yp[3];
                b[4] = th - e * yp[4];
                rates(self, &mut a);
                rates(self, &mut b);
                yp[0] = (a[0] - b[0]) / (2. * e);
                yp[1] = (a[1] - b[1]) / (2. * e);
            }
        }
        let det = self.ls * self.lf - self.m * self.m;
        yp[5] = (self.lf * yp[0] - self.m * yp[2]) / det;
        yp[6] = yp[1] / self.ls;
        yp[7] = (self.ls * yp[2] - self.m * yp[0]) / det;
        yp[N0..].fill(0.);
    }
    /// O4: (ld, lq) from the algebraic stator at given lf, w, th (linear).
    fn reduced_stator(&self, lf: f64, w: f64, th: f64) -> [f64; 2] {
        let det = self.ls * self.lf - self.m * self.m;
        let (vd, vq) = (self.v * th.cos(), -self.v * th.sin());
        // 0 = vd - rs*(lf_*ld - m*lf)/det + p w lq ; 0 = vq - rs*lq/ls - p w ld
        let a = [
            [-self.rs * self.lf / det, self.p * w],
            [-self.p * w, -self.rs / self.ls],
        ];
        let b = [-vd - self.rs * self.m * lf / det, -vq];
        let d = a[0][0] * a[1][1] - a[0][1] * a[1][0];
        [
            (b[0] * a[1][1] - a[0][1] * b[1]) / d,
            (a[0][0] * b[1] - b[0] * a[1][0]) / d,
        ]
    }
    fn export_w(&self, y: &[f64]) -> f64 {
        if self.mode == Mode::Open {
            return 0.;
        }
        let (vd, vq) = (self.v * y[4].cos(), -self.v * y[4].sin());
        -(vd * y[5] + vq * y[6])
    }
}
impl System for Machine {
    fn dimension(&self) -> usize {
        self.n()
    }
    fn nonzeros(&self) -> usize {
        64 + self.pad
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        self.rows(y, yp, out);
        out[N0..].copy_from_slice(&yp[N0..]);
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        y: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let g = self.block(cj, y);
        let mut k = 0;
        for (c, col) in g.iter().enumerate() {
            pointers[c] = k as i64;
            for (r, v) in col.iter().enumerate() {
                data[k] = *v;
                rows[k] = r as i64;
                k += 1;
            }
        }
        for (c, pointer) in pointers.iter_mut().enumerate().take(self.n()).skip(N0) {
            *pointer = k as i64;
            data[k] = cj;
            rows[k] = c as i64;
            k += 1;
        }
        pointers[self.n()] = k as i64;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
enum Event {
    None,
    /// Turbine torque scaled by the factor (held boundary, restart).
    Torque(f64),
    /// Generator breaker opens: the page's zero-duration passive arc limit
    /// (field linkage retained, id=iq=0), shaft torque set to `tau`.
    Open(f64),
    /// Breaker closes onto the bus.
    Close,
    /// Bus voltage scaled by the factor.
    Voltage(f64),
    /// Relative-angle reference change theta += rad (a per-boundary
    /// coordinate conversion of this size; no owner choice implied).
    Angle(f64),
    /// Bus frequency set to Hz.
    Frequency(f64),
}
struct Case {
    name: &'static str,
    event: Event,
    initial: Initial0,
    /// Class S held-input updates from the event time on: (period s, bus
    /// frequency step Hz), alternating f0 + step and f0, applied at a stop
    /// with retained BDF history (no IDAReInit), as S3-D1 class S.
    updates: Option<(f64, f64)>,
}
#[derive(Clone, Copy)]
enum Initial0 {
    /// The page's hot original sizing phasor; shaft torque = referenceShaft/omega0.
    Sizing,
    /// Open breaker, field at `field_factor` x matched no-load current,
    /// speed (1+slip) omega0, terminal phase error `phase_rad` at the event.
    OpenNoLoad {
        field_factor: f64,
        slip: f64,
        phase_rad: f64,
    },
}
#[derive(Clone, Copy, Debug)]
enum Classes {
    /// G12: S1's scaled 1e-8 floor times each coordinate's declared scale.
    G12,
    /// S2-D24 pattern (diagnostic): stator flux class from the flux vector's
    /// own relative class (rotation-invariant), currents derived through
    /// |di/dlambda| = 1/L'd.
    Derived,
}
struct Config {
    name: String,
    order: Order,
    classes: Classes,
    pad: usize,
    relative: f64,
    cap: Option<f64>,
}

fn param(v: &Value, path: &[&str]) -> f64 {
    let mut x = v;
    for p in path {
        x = &x[*p];
    }
    x.as_f64()
        .unwrap_or_else(|| panic!("missing compiled parameter {path:?}"))
}

#[allow(clippy::too_many_lines)]
fn run(
    params: &Value,
    case: &Case,
    cfg: &Config,
    t_event: f64,
    horizon: f64,
    trace: &mut dyn Write,
) -> Value {
    let b = &params["basis"];
    let v = param(b, &["lineVoltage_V"]);
    let f0 = param(b, &["frequency_Hz"]);
    let p = param(b, &["polePairs"]);
    let w0 = param(params, &["parameters", "speed"]);
    let mut m = Machine {
        ls: param(params, &["parameters", "statorInductance"]),
        m: param(params, &["parameters", "mutual"]),
        lf: param(params, &["parameters", "fieldInductance"]),
        rs: param(params, &["parameters", "resistance"]),
        rf: param(params, &["parameters", "fieldResistance"]),
        j: param(params, &["parameters", "inertia"]),
        p,
        wr: w0,
        v,
        f: f0,
        vf: 0.,
        tau: 0.,
        mode: Mode::Connected,
        order: cfg.order,
        pad: cfg.pad,
    };
    let n = m.n();
    let mut y = vec![0.; n];
    let mut yp = vec![0.; n];
    let field0 = param(b, &["fieldCurrent_A"]);
    match case.initial {
        Initial0::Sizing => {
            let flux = &params["parameters"]["initialFlux"];
            y[0] = flux[0].as_f64().unwrap();
            y[1] = flux[1].as_f64().unwrap();
            y[2] = flux[2].as_f64().unwrap();
            y[3] = w0;
            y[4] = param(params, &["parameters", "angle"]);
            m.vf = m.rf * field0;
            m.tau = param(b, &["referenceShaft_W"]) / w0;
        }
        Initial0::OpenNoLoad {
            field_factor,
            slip,
            phase_rad,
        } => {
            m.mode = Mode::Open;
            let matched = v / (p * w0 * m.m);
            let i_f = field_factor * matched;
            y[2] = m.lf * i_f;
            y[3] = w0 * (1. + slip);
            // terminal phase = th + pi/2 at steady field; drift p*w - 2 pi f
            y[4] = -PI / 2. + phase_rad - (p * y[3] - 2. * PI * f0) * t_event;
            m.vf = m.rf * i_f;
            m.tau = 0.;
        }
    }
    m.consistent(&mut y, &mut yp);
    let det = m.ls * m.lf - m.m * m.m;
    let ld_t = det / m.lf; // L'd
    let s_flux = v / (2. * PI * f0);
    let s_cur = param(b, &["base_VA"]) / v;
    let rel = cfg.relative;
    let reference = cfg.relative / 1e-5; // R2-style: absolute classes scale with rtol
    let mut atol = match cfg.classes {
        Classes::G12 => vec![
            1e-8 * s_flux,
            1e-8 * s_flux,
            1e-8 * (m.lf * field0).abs(),
            1e-8 * w0,
            1e-8,
            1e-8 * s_cur,
            1e-8 * s_cur,
            1e-8 * field0,
        ],
        Classes::Derived => vec![
            1e-5 * s_flux,
            1e-5 * s_flux,
            1e-8 * (m.lf * field0).abs(),
            1e-8 * w0,
            1e-8,
            1e-5 * s_flux / ld_t,
            1e-5 * s_flux / ld_t,
            1e-8 * field0,
        ],
    };
    for a in atol.iter_mut() {
        *a *= reference;
    }
    atol.extend(std::iter::repeat_n(1e-8, cfg.pad));
    let ids = m.differential();
    let mut ida = Ida::new(
        m,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rel,
        },
    )
    .expect("stock IDA");
    let configure = |ida: &mut Ida<Machine>| {
        ida.set_max_order(2).unwrap();
        ida.set_nonlinear_convergence_coefficient(0.33).unwrap();
        ida.set_delta_cj_lsetup(0.1).unwrap();
        ida.set_init_step(1e-4).unwrap();
        if let Some(c) = cfg.cap {
            ida.set_max_step(c).unwrap();
        }
    };
    configure(&mut ida);
    let has_event = !matches!(case.event, Event::None) || case.updates.is_some();
    if has_event {
        ida.stop_at(t_event).unwrap();
    }
    let mut next_update = if case.updates.is_some() {
        t_event
    } else {
        f64::INFINITY
    };
    let mut update_count = 0usize;
    // windows after the event: counts per window
    let edges = [0., 0.1, 0.5, 2., 10., horizon - t_event];
    let mut win = vec![[0i64; 5]; edges.len() - 1]; // steps, errfails, J(setups), newton, residuals
    let mut acc = [0i64; 6]; // completed-segment totals: steps, errf, setups, newton, res, convf
    let mut last = [0i64; 6];
    let mut h_trace: Vec<(f64, f64, i32)> = vec![];
    let cpu0 = cpu::thread_cpu_s();
    let mut cpu_event = 0.;
    let mut t = 0.;
    // output grid (IDA interpolation, no extra steps); finer for the tight reference so
    // stock's 500-step limit per call is not reached while it resolves the stator mode
    let fine = if cfg.relative < 1e-7 { 0.0005 } else { 0.002 };
    let dt = |t: f64| {
        if t >= t_event && t < t_event + 2. {
            fine
        } else {
            0.01
        }
    };
    let mut e = vec![0.; n];
    let mut wts = vec![0.; n];
    let mut class_peak = [0f64; 4]; // max share of WRMS^2 per class after event: stator flux, stator current, field, mech
    let mut applied = !has_event;
    let mut max_ieq = 0f64;
    let mut energy = 0.; // trapezoid on the output grid (diagnostic)
    let mut p_prev = ida.system().export_w(&y);
    while t < horizon - 1e-12 {
        let mut target = (t + dt(t)).min(horizon);
        if !applied && target > t_event {
            target = t_event;
        }
        if target > next_update {
            target = next_update;
        }
        let reached = ida
            .advance(target, &mut y, &mut yp)
            .unwrap()
            .reached()
            .unwrap();
        let s = ida.stats().unwrap();
        let cur = [
            s.steps,
            s.error_failures,
            s.linear_setups,
            s.nonlinear_iterations,
            s.residuals,
            s.convergence_failures,
        ];
        let tot: Vec<i64> = (0..6).map(|k| acc[k] + cur[k]).collect();
        if applied && has_event {
            let rel_t = reached - t_event;
            let mut k = 0;
            while k + 1 < edges.len() && rel_t > edges[k + 1] + 1e-12 {
                k += 1;
            }
            let k = k.min(win.len() - 1);
            for q in 0..5 {
                win[k][q] += tot[q] - last[q];
            }
        }
        last.copy_from_slice(&tot[..6]);
        let order = ida.error_diagnostics(&mut e, &mut wts).unwrap();
        if applied && reached > t_event {
            let sum =
                |r: &[usize]| r.iter().map(|&i| (e[i] * wts[i]).powi(2)).sum::<f64>() / n as f64;
            let shares = [sum(&[0, 1]), sum(&[5, 6]), sum(&[2, 7]), sum(&[3, 4])];
            for (c, s) in class_peak.iter_mut().zip(shares) {
                *c = c.max(s);
            }
            h_trace.push((reached - t_event, s.last_step, order));
        }
        let sys = ida.system();
        let pw = sys.export_w(&y);
        energy += 0.5 * (pw + p_prev) * (reached - t);
        p_prev = pw;
        let ieq = (y[5] * y[5] + y[6] * y[6]).sqrt() / 3f64.sqrt();
        if applied && reached > t_event {
            max_ieq = max_ieq.max(ieq);
        }
        writeln!(
            trace,
            "{{\"case\":\"{}\",\"cfg\":\"{}\",\"t\":{},\"P\":{},\"w\":{},\"th\":{},\"ieq\":{},\"if\":{},\"ld\":{},\"lq\":{},\"steps\":{},\"h\":{},\"q\":{}}}",
            case.name, cfg.name, reached, pw, y[3], y[4], ieq, y[7], y[0], y[1], tot[0], s.last_step, order
        )
        .unwrap();
        t = reached;
        if (t - next_update).abs() < 1e-12 {
            // class S: held-input change at a stop, BDF history retained
            let (period, step) = case.updates.unwrap();
            update_count += 1;
            let f = if update_count % 2 == 1 { f0 + step } else { f0 };
            ida.system_mut().f = f;
            applied = true;
            next_update += period;
            if next_update < horizon - 1e-9 {
                ida.stop_at(next_update).unwrap();
            } else {
                next_update = f64::INFINITY;
            }
        } else if !applied && (t - t_event).abs() < 1e-12 {
            // apply the event as a restart (class R): ordered state write,
            // exact consistent start, IDAReInit.
            cpu_event = cpu::thread_cpu_s();
            for k in 0..6 {
                acc[k] += cur[k];
            }
            last.copy_from_slice(&acc);
            ida.current_state(&mut y, &mut yp).unwrap();
            let mut sys = ida.system().clone();
            match case.event {
                Event::None => {}
                Event::Torque(f) => sys.tau *= f,
                Event::Open(tau) => {
                    sys.mode = Mode::Open;
                    sys.tau = tau;
                }
                Event::Close => sys.mode = Mode::Connected,
                Event::Voltage(f) => sys.v *= f,
                Event::Angle(d) => y[4] += d,
                Event::Frequency(hz) => sys.f = hz,
            }
            sys.consistent(&mut y, &mut yp);
            let ids = sys.differential();
            *ida.system_mut() = sys;
            ida.reinitialize(t, &y, &yp).unwrap();
            ida.set_differential(&ids).unwrap();
            applied = true;
        }
    }
    let cpu = cpu::thread_cpu_s() - cpu0;
    // quiet time: first time after which every step is >= 5 ms (20 ms cap counts as quiet)
    let quiet = |limit: f64| {
        let mut tq = 0.;
        for (tt, h, _) in &h_trace {
            if *h < limit {
                tq = *tt;
            }
        }
        tq
    };
    let total: Vec<i64> = (0..6).map(|k| last[k]).collect();
    json!({
        "case": case.name, "config": cfg.name, "n": n, "relative": rel, "cap_s": cfg.cap,
        "classes": format!("{:?}", cfg.classes), "order": format!("{:?}", cfg.order),
        "atol": &atol[..N0],
        "totals": {"steps": total[0], "error_failures": total[1], "linear_setups": total[2],
            "newton": total[3], "residuals": total[4], "convergence_failures": total[5]},
        "windows_after_event_s": edges, "windows": win.iter().map(|w| json!({"steps": w[0], "error_failures": w[1], "linear_setups": w[2], "newton": w[3], "residuals": w[4]})).collect::<Vec<_>>(),
        "last_h_below_1ms_s": quiet(1e-3), "last_h_below_5ms_s": quiet(5e-3), "last_h_below_20ms_s": quiet(0.02),
        "min_h_after_event": h_trace.iter().map(|x| x.1).fold(f64::INFINITY, f64::min),
        "class_peak_wrms2_share": {"stator_flux": class_peak[0], "stator_current": class_peak[1], "field": class_peak[2], "mechanical": class_peak[3]},
        "max_ieq_after_event_A": max_ieq, "export_energy_trapezoid_J": energy,
        "end": {"t": t, "w": y[3], "th": y[4], "P": ida.system().export_w(&y)},
        "cpu_s": cpu, "cpu_after_event_s": if has_event { cpu::thread_cpu_s() - cpu_event } else { 0. },
        "class_s_updates": update_count,
    })
}

#[test]
#[ignore = "ELEC spike: run with ELEC_GENERATOR_PARAMS and ELEC_SPIKE_OUT"]
fn elec_generator_stiffness_spike() {
    cpu::prefer_performance_core();
    let path = std::env::var("ELEC_GENERATOR_PARAMS").expect("ELEC_GENERATOR_PARAMS");
    let out = std::env::var("ELEC_SPIKE_OUT").expect("ELEC_SPIKE_OUT");
    let horizon: f64 = std::env::var("ELEC_SPIKE_HORIZON").map_or(61., |s| s.parse().unwrap());
    let only = std::env::var("ELEC_SPIKE_ONLY").ok();
    let params: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let deg = PI / 180.;
    let cases = [
        Case {
            name: "Q0 quiet sizing point",
            event: Event::None,
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "L10 torque -10%",
            event: Event::Torque(0.9),
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "BO breaker open + torque 0",
            event: Event::Open(0.),
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "BC0 matched close",
            event: Event::Close,
            initial: Initial0::OpenNoLoad {
                field_factor: 1.,
                slip: 0.,
                phase_rad: 0.,
            },
            updates: None,
        },
        Case {
            name: "BC10 synchrocheck-limit close (10 deg, +0.1 Hz, +5% V)",
            event: Event::Close,
            initial: Initial0::OpenNoLoad {
                field_factor: 1.05,
                slip: 0.1 / 50.,
                phase_rad: 10. * deg,
            },
            updates: None,
        },
        Case {
            name: "V1 bus voltage -1%",
            event: Event::Voltage(0.99),
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "A01 angle conversion 0.1 deg",
            event: Event::Angle(0.1 * deg),
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "A1 angle conversion 1 deg",
            event: Event::Angle(1. * deg),
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "F bus frequency 49.9 Hz",
            event: Event::Frequency(49.9),
            initial: Initial0::Sizing,
            updates: None,
        },
        Case {
            name: "QF quiet + 1 s class-S bus-frequency updates 1 mHz",
            event: Event::None,
            initial: Initial0::Sizing,
            updates: Some((1.0, 0.001)),
        },
    ];
    let joined = 18_603;
    let s1 = 261;
    let configs = [
        Config {
            name: "full G12 N8".into(),
            order: Order::Full,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "full G12 N261".into(),
            order: Order::Full,
            classes: Classes::G12,
            pad: s1 - N0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "full G12 N18603".into(),
            order: Order::Full,
            classes: Classes::G12,
            pad: joined - N0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "full G12 N18603 cap20ms".into(),
            order: Order::Full,
            classes: Classes::G12,
            pad: joined - N0,
            relative: 1e-5,
            cap: Some(0.02),
        },
        Config {
            name: "full derived N8".into(),
            order: Order::Full,
            classes: Classes::Derived,
            pad: 0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "full derived N18603".into(),
            order: Order::Full,
            classes: Classes::Derived,
            pad: joined - N0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "O4 G12 N8".into(),
            order: Order::Reduced,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "O4 G12 N18603".into(),
            order: Order::Reduced,
            classes: Classes::G12,
            pad: joined - N0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "O4b G12 N8".into(),
            order: Order::ReducedRated,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "O4b G12 N18603".into(),
            order: Order::ReducedRated,
            classes: Classes::G12,
            pad: joined - N0,
            relative: 1e-5,
            cap: None,
        },
        Config {
            name: "O4b ref R1R2 N8".into(),
            order: Order::ReducedRated,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-7,
            cap: Some(0.0025),
        },
        Config {
            name: "full ref tight N8".into(),
            order: Order::Full,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-8,
            cap: Some(0.001),
        },
        Config {
            name: "full ref R1R2 N8".into(),
            order: Order::Full,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-7,
            cap: Some(0.0025),
        },
        Config {
            name: "O4 ref R1R2 N8".into(),
            order: Order::Reduced,
            classes: Classes::G12,
            pad: 0,
            relative: 1e-7,
            cap: Some(0.0025),
        },
    ];
    let mut trace =
        std::io::BufWriter::new(std::fs::File::create(format!("{out}.trace.jsonl")).unwrap());
    let mut results = vec![];
    for case in &cases {
        for cfg in &configs {
            if let Some(o) = &only
                && !cfg.name.contains(o.as_str())
                && !case.name.contains(o.as_str())
            {
                continue;
            }
            let r = run(&params, case, cfg, 1., horizon, &mut trace);
            eprintln!(
                "{:<58} {:<26} steps {:>6} J {:>5} errf {:>4} N {:>6} min_h {:.2e} h<1ms until {:.3} h<5ms until {:.3} h<20ms until {:.3} cpu {:.3}",
                case.name,
                cfg.name,
                r["totals"]["steps"],
                r["totals"]["linear_setups"],
                r["totals"]["error_failures"],
                r["totals"]["newton"],
                r["min_h_after_event"].as_f64().unwrap_or(f64::NAN),
                r["last_h_below_1ms_s"],
                r["last_h_below_5ms_s"],
                r["last_h_below_20ms_s"],
                r["cpu_s"]
            );
            results.push(r);
        }
    }
    trace.flush().unwrap();
    let receipt = json!({
        "kind": "ELEC S3 generator stiffness spike (measurement, NOT evidence)",
        "params": path, "page": params["page"], "pageSha256": params["pageSha256"],
        "solver": {"maxOrder": 2, "newtonCoefficient": 0.33, "dcj": 0.1, "initStep_s": 1e-4, "eventClass": "R (IDAReInit + exact consistent start)"},
        "padding": "extra coordinates y'=0: zero local error, only N in the WRMS norm",
        "horizon_s": horizon, "event_s": 1.0,
        "load": cpu::load_average(),
        "results": results,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&receipt).unwrap()).unwrap();
}

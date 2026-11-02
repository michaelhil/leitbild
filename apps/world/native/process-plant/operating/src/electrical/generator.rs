//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#breaker-movement-and-passive-opening
//! The selected balanced machine as equation rows, NOT a breaker, field
//! switch, protection or Grid owner. Power-invariant Park form, motor current
//! positive into the machine, `p` pole pairs:
//!
//! ```text
//! lambda_d = Ls*id + M*if ; lambda_q = Ls*iq ; lambda_f = M*id + Lf*if
//! dot(lambda_d) = vd - Rs*id + p*omega*lambda_q
//! dot(lambda_q) = vq - Rs*iq - p*omega*lambda_d
//! dot(lambda_f) = vf - Rf*if
//! tau_em = p*M*if*iq ; Pgrid_export = -(vd*id + vq*iq)
//! vd = V*cos(theta), vq = -V*sin(theta) (connected)
//! ```
//!
//! Currents are algebraic coordinates recovered through the inductance matrix
//! (rows 3-5), never by a division by speed. With the stator separated
//! (`Mode::Open`) the stator rows become `id = 0`, `iq = 0` and the stator
//! linkages algebraic. The page's zero-duration passive arc limit is the
//! transaction [`Machine::arc_quench`]; it retains field linkage and deposits
//! exactly `(Ls - M^2/Lf)*id^2/2 + Ls*iq^2/2` for the breaker body.
//! The external boundary is an input (`v_line`, and the relative angle theta
//! as the caller's state). The carrier reaches theta as a continuous input
//! through the caller's angle row (owner decision D2, [`super::slice`]);
//! nothing here writes theta at a boundary.

/// Machine constants, derived once from the page's strict block by the
/// operating electrical compiler. Every field is required.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    #[serde(rename = "statorInductance_H")]
    pub ls: f64,
    #[serde(rename = "mutual_H")]
    pub m: f64,
    #[serde(rename = "fieldInductance_H")]
    pub lf: f64,
    #[serde(rename = "statorResistance_ohm")]
    pub rs: f64,
    #[serde(rename = "fieldResistance_ohm")]
    pub rf: f64,
    #[serde(rename = "polePairs")]
    pub pole_pairs: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Stator joined to the stiff balanced boundary.
    Connected,
    /// Stator separated at an achieved contact: id = iq = 0.
    Open,
}

/// Machine coordinates `[lambda_d, lambda_q, lambda_f, id, iq, if]` in the
/// order of the six rows; speed and angle belong to the caller.
pub const COORDINATES: usize = 6;
/// Partial derivatives of the six rows by `[ld, lq, lf, id, iq, if, omega, theta]`.
pub type Block = [[f64; COORDINATES + 2]; COORDINATES];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Machine {
    pub parameters: Parameters,
}

impl Machine {
    pub fn new(parameters: Parameters) -> Result<Self, String> {
        let p = parameters;
        let positive = [p.ls, p.m, p.lf, p.rs, p.rf, p.pole_pairs];
        if positive.iter().any(|v| !v.is_finite() || *v <= 0.) || p.ls * p.lf <= p.m * p.m {
            return Err("generator needs positive constants and Ls*Lf > M^2".into());
        }
        Ok(Self { parameters })
    }
    /// Currents from linkages by the positive-definite inductance matrix.
    pub fn currents(&self, ld: f64, lq: f64, lf: f64) -> [f64; 3] {
        let p = self.parameters;
        let det = p.ls * p.lf - p.m * p.m;
        [
            (p.lf * ld - p.m * lf) / det,
            lq / p.ls,
            (p.ls * lf - p.m * ld) / det,
        ]
    }
    /// Terminal voltage vector of the connected boundary.
    pub fn terminal(v_line: f64, theta: f64) -> (f64, f64) {
        (v_line * theta.cos(), -v_line * theta.sin())
    }
    /// The six rows at `x = [ld, lq, lf, id, iq, if]` with linkage rates
    /// `xp[0..3]`, shaft speed `omega`, angle `theta`, field voltage `vf`.
    #[allow(clippy::too_many_arguments)]
    pub fn rows(
        &self,
        mode: Mode,
        x: &[f64],
        xp: &[f64],
        omega: f64,
        theta: f64,
        v_line: f64,
        vf: f64,
        out: &mut [f64],
    ) {
        let p = self.parameters;
        let (ld, lq, lf, id, iq, i_f) = (x[0], x[1], x[2], x[3], x[4], x[5]);
        match mode {
            Mode::Connected => {
                let (vd, vq) = Self::terminal(v_line, theta);
                out[0] = xp[0] - (vd - p.rs * id + p.pole_pairs * omega * lq);
                out[1] = xp[1] - (vq - p.rs * iq - p.pole_pairs * omega * ld);
            }
            Mode::Open => {
                out[0] = id;
                out[1] = iq;
            }
        }
        out[2] = xp[2] - (vf - p.rf * i_f);
        out[3] = ld - (p.ls * id + p.m * i_f);
        out[4] = lq - p.ls * iq;
        out[5] = lf - (p.m * id + p.lf * i_f);
    }
    /// `dF/dx + cj*dF/dx'` of the six rows; columns `[ld, lq, lf, id, iq, if, omega, theta]`.
    /// `dvf_dif` carries a field-dump law `vf = -Rdump*if` when the caller uses one.
    #[allow(clippy::too_many_arguments)]
    pub fn block(
        &self,
        mode: Mode,
        cj: f64,
        x: &[f64],
        omega: f64,
        theta: f64,
        v_line: f64,
        dvf_dif: f64,
    ) -> Block {
        let p = self.parameters;
        let mut g = [[0.; COORDINATES + 2]; COORDINATES];
        match mode {
            Mode::Connected => {
                let pp = p.pole_pairs;
                g[0] = [
                    cj,
                    -pp * omega,
                    0.,
                    p.rs,
                    0.,
                    0.,
                    -pp * x[1],
                    v_line * theta.sin(),
                ];
                g[1] = [
                    pp * omega,
                    cj,
                    0.,
                    0.,
                    p.rs,
                    0.,
                    pp * x[0],
                    v_line * theta.cos(),
                ];
            }
            Mode::Open => {
                g[0][3] = 1.;
                g[1][4] = 1.;
            }
        }
        g[2][2] = cj;
        g[2][5] = p.rf - dvf_dif;
        g[3] = [1., 0., 0., -p.ls, 0., -p.m, 0., 0.];
        g[4] = [0., 1., 0., 0., -p.ls, 0., 0., 0.];
        g[5] = [0., 0., 1., -p.m, 0., -p.lf, 0., 0.];
        g
    }
    /// Electromagnetic torque (positive accelerates the rotor) and its
    /// partials by `(iq, if)`.
    pub fn torque(&self, iq: f64, i_f: f64) -> (f64, f64, f64) {
        let k = self.parameters.pole_pairs * self.parameters.m;
        (k * i_f * iq, k * i_f, k * iq)
    }
    /// Signed export `-(vd*id + vq*iq)` (W); zero with the stator separated.
    pub fn export_w(&self, mode: Mode, id: f64, iq: f64, theta: f64, v_line: f64) -> f64 {
        match mode {
            Mode::Connected => {
                let (vd, vq) = Self::terminal(v_line, theta);
                -(vd * id + vq * iq)
            }
            Mode::Open => 0.,
        }
    }
    /// Magnetic energy `(ld*id + lq*iq + lf*if)/2` (J).
    pub fn magnetic_energy(x: &[f64]) -> f64 {
        0.5 * (x[0] * x[3] + x[1] * x[4] + x[2] * x[5])
    }
    /// Stator and field copper heat (W).
    pub fn copper(&self, x: &[f64]) -> (f64, f64) {
        let p = self.parameters;
        (p.rs * (x[3] * x[3] + x[4] * x[4]), p.rf * x[5] * x[5])
    }
    /// The page's zero-duration passive arc limit at an achieved stator
    /// separation: field linkage retained, `id = iq = 0`, `if = lambda_f/Lf`,
    /// `lambda_d = M*if`, `lambda_q = 0`. Returns the exact heat for the
    /// breaker body. Applied once, at the separation, as a restart transaction.
    pub fn arc_quench(&self, x: &mut [f64]) -> f64 {
        let p = self.parameters;
        let (id, iq) = (x[3], x[4]);
        let heat = 0.5 * (p.ls - p.m * p.m / p.lf) * id * id + 0.5 * p.ls * iq * iq;
        let i_f = x[2] / p.lf;
        x[0] = p.m * i_f;
        x[1] = 0.;
        x[3] = 0.;
        x[4] = 0.;
        x[5] = i_f;
        heat
    }
    /// Exact consistent `(x, xp)` of the mode from the retained linkages (both
    /// stator linkages when connected; the field linkage when open), given
    /// speed, angle, its rate and the field voltage.
    #[allow(clippy::too_many_arguments)]
    pub fn consistent(
        &self,
        mode: Mode,
        x: &mut [f64],
        xp: &mut [f64],
        omega: f64,
        theta: f64,
        v_line: f64,
        vf: f64,
    ) {
        let p = self.parameters;
        if mode == Mode::Open {
            x[0] = p.m * x[2] / p.lf;
            x[1] = 0.;
        }
        let c = self.currents(x[0], x[1], x[2]);
        x[3..6].copy_from_slice(&c);
        let det = p.ls * p.lf - p.m * p.m;
        xp[2] = vf - p.rf * c[2];
        match mode {
            Mode::Connected => {
                let (vd, vq) = Self::terminal(v_line, theta);
                xp[0] = vd - p.rs * c[0] + p.pole_pairs * omega * x[1];
                xp[1] = vq - p.rs * c[1] - p.pole_pairs * omega * x[0];
            }
            Mode::Open => {
                // id' = iq' = 0: if' = lf'/Lf, ld' = M*if', lq' = 0
                xp[0] = p.m * xp[2] / p.lf;
                xp[1] = 0.;
            }
        }
        xp[3] = (p.lf * xp[0] - p.m * xp[2]) / det;
        xp[4] = xp[1] / p.ls;
        xp[5] = (p.ls * xp[2] - p.m * xp[0]) / det;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The page's selected machine (compiled values; see the operating electrical compiler).
    fn machine() -> Machine {
        Machine::new(Parameters {
            ls: 0.0004340589357051691,
            m: 0.027233839635419258,
            lf: 3.4174254244198505,
            rs: 0.0015075765093079583,
            rf: 0.125,
            pole_pairs: 2.,
        })
        .unwrap()
    }
    const V: f64 = 10000.;
    const W0: f64 = 157.07963267948966;
    #[test]
    fn sizing_phasor_is_a_steady_state_with_the_page_export() {
        let g = machine();
        let mut x = [
            19.1729492244487,
            -26.01353622770377,
            4620.379635392113,
            0.,
            0.,
            0.,
        ];
        let mut xp = [0.; 6];
        let theta = -0.6351532999637338;
        g.consistent(Mode::Connected, &mut x, &mut xp, W0, theta, V, 250.);
        assert!(xp[..3].iter().all(|r| r.abs() < 1e-8), "{xp:?}");
        let p = g.export_w(Mode::Connected, x[3], x[4], theta, V);
        assert!((p - 1010126272.326275).abs() < 1e-3, "{p}");
        let (tau, _, _) = g.torque(x[4], x[5]);
        assert!((-tau * W0 - 1025508905.915).abs() < 1e-2);
        let mut out = [0.; 6];
        g.rows(Mode::Connected, &x, &xp, W0, theta, V, 250., &mut out);
        assert!(out.iter().all(|r| r.abs() < 1e-8), "{out:?}");
    }
    #[test]
    fn local_ledger_block_and_passive_arc_limit() {
        let g = machine();
        let (omega, theta, vf) = (0.97 * W0, 0.4, 210.);
        let mut x = [12., -20., 4000., 0., 0., 0.];
        let mut xp = [0.; 6];
        g.consistent(Mode::Connected, &mut x, &mut xp, omega, theta, V, vf);
        // dWmag + Qs + Qf + tau*omega = vf*if - P_export
        let dw = x[3] * xp[0] + x[4] * xp[1] + x[5] * xp[2];
        let (qs, qf) = g.copper(&x);
        let (tau, _, _) = g.torque(x[4], x[5]);
        let rhs = vf * x[5] - g.export_w(Mode::Connected, x[3], x[4], theta, V);
        assert!((dw + qs + qf + tau * omega - rhs).abs() < 1e-6 * rhs.abs());
        // block against central differences of the rows
        let blk = g.block(Mode::Connected, 0., &x, omega, theta, V, 0.);
        let f = |x: &[f64], om: f64, th: f64| {
            let mut o = [0.; 6];
            g.rows(Mode::Connected, x, &xp, om, th, V, vf, &mut o);
            o
        };
        for k in 0..8 {
            let h = 1e-6 * if k < 6 { x[k].abs().max(1.) } else { 1. };
            let (mut a, mut b) = (x, x);
            let (mut oa, mut ob, mut ta, mut tb) = (omega, omega, theta, theta);
            match k {
                0..=5 => {
                    a[k] += h;
                    b[k] -= h;
                }
                6 => {
                    oa += h;
                    ob -= h;
                }
                _ => {
                    ta += h;
                    tb -= h;
                }
            }
            let (fa, fb) = (f(&a, oa, ta), f(&b, ob, tb));
            for r in 0..6 {
                let fd = (fa[r] - fb[r]) / (2. * h);
                assert!(
                    (fd - blk[r][k]).abs() < 1e-5 * (1. + fd.abs()),
                    "row {r} col {k}: {fd} vs {}",
                    blk[r][k]
                );
            }
        }
        // arc limit: magnetic energy falls by exactly the deposited heat, field linkage kept
        let before = Machine::magnetic_energy(&x);
        let lf = x[2];
        let heat = g.arc_quench(&mut x);
        assert!(heat > 0. && x[2] == lf && x[3] == 0. && x[4] == 0.);
        assert!((before - Machine::magnetic_energy(&x) - heat).abs() < 1e-9 * before);
    }
}

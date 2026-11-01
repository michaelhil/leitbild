//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/turbine-and-regeneration-dynamics.md#shaft-generator-and-governor
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/turbine-and-regeneration-dynamics.md#turbine-valve-governor-and-dump-x43
//! X4.3 (plan r4, lane TURB): the connected LOAD governor, the admission
//! valve ADM and the `LD01.TG.GEN.WT` power channel as three continuous
//! coordinates `[w, I, a]` appended after the electrical slice's. Nothing
//! here integrates; the electrical wrapper composes the rows and the block.
//!
//! - `w' = (P_export - w) / tau_WT` (GEN.WT's 0.1 s lag; its 1 MW rounding,
//!   0.1 s sampling and transport omitted in the continuous law, labelled);
//! - **x43-5 (lead ruling, 1 Nov; design row): the standard large-turbine
//!   structure.** x43-4's fast power loop (`u* = 0.5 e + I` on GEN.WT)
//!   destabilised the 1 Hz swing mode. Now `u* = P_set/scale + I -
//!   (omega/omega0 - 1)/droop`: the wiki's 5 % droop on shaft speed about the
//!   load reference (the request over the start's full-open export,
//!   judgement), `u = clamp(u*, 0, 1)`;
//! - `I' = Ki (P_set - w)/B + (u - u*) Ki/Kp`: GEN.WT only as the slow trim
//!   (Ki = the wiki's 0.2/s: a 5 s time constant, far below the swing band),
//!   with back-calculation anti-windup, tracking time `Kp/Ki` (judgement);
//! - `a' = clamp((u - a)/tau_a, -1/T_ADM, +1/T_ADM)`: ADM's 1 s full travel
//!   as a rate bound; `tau_a` the governor's 0.1 s sampling as the position
//!   loop's time constant (labelled judgement). The corners are continuous
//!   in value and not located (FEED's pattern).
//! - `P_set(t)` is the Grid's request through the 10 %/s setpoint ramp: a
//!   held input changed only at Grid exchanges, entering only `I'` and
//!   `a'` (class S, S3-D4).
//! - After a turbine trip (a class-R instant) the mode is CLOSED: the LOAD
//!   intent is invalidated, the integral is frozen and ADM closes at its own
//!   travel (spring return); no automatic recovery.
use std::fmt;

pub const N: usize = 3;
pub const W: usize = 0;
pub const I: usize = 1;
pub const A: usize = 2;

/// The wiki's `ld01-governor` block.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct GovernorBlock {
    pub sample_s: f64,
    pub droop: f64,
    #[serde(rename = "setpointRamp_per_s")]
    pub setpoint_ramp_per_s: f64,
    pub proportional: f64,
    #[serde(rename = "integral_per_s")]
    pub integral_per_s: f64,
    #[serde(rename = "base_W")]
    pub base_w: f64,
    pub overspeed_pu: f64,
}

/// The X4.3 block (`ld01-governor-x43`): the continuous law's two lags.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuousBlock {
    /// GEN.WT's first-order lag (generator page).
    #[serde(rename = "wattLag_s")]
    pub watt_lag_s: f64,
    /// The position loop's time constant (judgement: the 0.1 s sampling).
    #[serde(rename = "positionLag_s")]
    pub position_lag_s: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Parameters {
    pub governor: GovernorBlock,
    pub continuous: ContinuousBlock,
    /// ADM's full travel (`ld01-steam-valve-travel` `admission_s`).
    pub admission_travel_s: f64,
    /// Rated mechanical speed (rad/s): the carrier over the pole pairs.
    pub omega0_rad_s: f64,
}

impl Parameters {
    pub fn validate(&self) -> Result<(), String> {
        let g = self.governor;
        let c = self.continuous;
        let positive = [
            g.droop,
            g.setpoint_ramp_per_s,
            g.proportional,
            g.integral_per_s,
            g.base_w,
            c.watt_lag_s,
            c.position_lag_s,
            self.admission_travel_s,
            self.omega0_rad_s,
        ];
        if positive.iter().any(|v| !(v.is_finite() && *v > 0.)) {
            return Err(format!("governor parameters must be positive: {self:?}"));
        }
        Ok(())
    }
    /// The back-calculation gain `Ki/Kp` (1 / tracking time).
    pub fn tracking_per_s(&self) -> f64 {
        self.governor.integral_per_s / self.governor.proportional
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Mode {
    /// Established connected LOAD.
    Load,
    /// After a turbine trip: LOAD intent invalidated, ADM to closed.
    Closed,
}

/// The governor's held inputs (S3-D19: exact bits).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Held {
    pub mode: Mode,
    /// The setpoint ramp: from `from_w` at `from_s` toward `to_w`.
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub from_w: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub to_w: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub from_s: f64,
    /// The load reference's valve scale: the start's terminal export at
    /// ADM full open (W per unit opening; judgement, x43-5).
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub scale_w: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Governor {
    pub parameters: Parameters,
    pub held: Held,
}

/// The law's values and partials at one state.
#[derive(Clone, Copy, Debug)]
pub struct Law {
    /// The slow GEN.WT trim's integrand `Ki (P_set - w)/B` (1/s).
    pub trim: f64,
    /// `u* = P_set/scale + I - (omega/omega0 - 1)/droop`.
    pub raw: f64,
    pub demand: f64,
    /// `du/du*` (1 inside the bounds, 0 on a bound).
    pub demand_slope: f64,
    pub raw_w: f64,
    pub raw_omega: f64,
    pub trim_w: f64,
    pub trim_omega: f64,
}

impl fmt::Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl Governor {
    /// LOAD at `t0` with the setpoint at `request_w` (no ramp in force)
    /// and the load reference's valve scale `scale_w`.
    pub fn new(
        parameters: Parameters,
        t0: f64,
        request_w: f64,
        scale_w: f64,
    ) -> Result<Self, String> {
        parameters.validate()?;
        if !(request_w.is_finite() && t0.is_finite() && scale_w.is_finite() && scale_w > 0.) {
            return Err(format!("governor request {request_w} W at {t0} s"));
        }
        Ok(Self {
            parameters,
            held: Held {
                mode: Mode::Load,
                from_w: request_w,
                to_w: request_w,
                from_s: t0,
                scale_w,
            },
        })
    }
    /// The setpoint at `t`: the request through the 10 %/s ramp.
    pub fn setpoint_w(&self, t: f64) -> f64 {
        let h = self.held;
        let r = self.parameters.governor.setpoint_ramp_per_s * self.parameters.governor.base_w;
        let moved = r * (t - h.from_s).max(0.);
        if h.to_w >= h.from_w {
            (h.from_w + moved).min(h.to_w)
        } else {
            (h.from_w - moved).max(h.to_w)
        }
    }
    /// A new request at `t` (a Grid exchange): the ramp continues from the
    /// setpoint in force. `false` when it changes nothing.
    pub fn request(&mut self, t: f64, request_w: f64) -> Result<bool, String> {
        if !request_w.is_finite() {
            return Err(format!("governor request {request_w} W"));
        }
        if self.held.mode != Mode::Load {
            return Err(
                "the governor is not in LOAD: a request needs a deliberate transfer".into(),
            );
        }
        let now = self.setpoint_w(t);
        if request_w.to_bits() == self.held.to_w.to_bits()
            && now.to_bits() == self.held.to_w.to_bits()
        {
            return Ok(false);
        }
        self.held = Held {
            mode: Mode::Load,
            from_w: now,
            to_w: request_w,
            from_s: t,
            scale_w: self.held.scale_w,
        };
        Ok(true)
    }
    /// The turbine trip (class R): CLOSED, the integral frozen.
    pub fn trip(&mut self) -> bool {
        let changed = self.held.mode != Mode::Closed;
        self.held.mode = Mode::Closed;
        changed
    }
    /// The law at `(t, w, omega, I)` (x43-5, lead ruling 1 Nov): speed droop
    /// on the shaft speed about the load reference `P_set/scale + I`; the
    /// GEN.WT error enters only the slow trim `I' = Ki (P_set - w)/B`.
    pub fn law(&self, t: f64, w: f64, omega: f64, integral: f64) -> Law {
        let p = &self.parameters;
        let g = p.governor;
        let set = self.setpoint_w(t);
        let trim = g.integral_per_s * (set - w) / g.base_w;
        let raw = set / self.held.scale_w + integral - (omega / p.omega0_rad_s - 1.) / g.droop;
        let (demand, demand_slope) = match self.held.mode {
            Mode::Closed => (0., 0.),
            Mode::Load if raw <= 0. => (0., 0.),
            Mode::Load if raw >= 1. => (1., 0.),
            Mode::Load => (raw, 1.),
        };
        Law {
            trim,
            raw,
            demand,
            demand_slope,
            raw_w: 0.,
            raw_omega: -1. / (g.droop * p.omega0_rad_s),
            trim_w: -g.integral_per_s / g.base_w,
            trim_omega: 0.,
        }
    }
    /// The position rate bound's value and slope at `v = (u - a)/tau_a`.
    fn travel(&self, v: f64) -> (f64, f64) {
        let r = 1. / self.parameters.admission_travel_s;
        if v <= -r {
            (-r, 0.)
        } else if v >= r {
            (r, 0.)
        } else {
            (v, 1.)
        }
    }
    /// The three rows at `x = [w, I, a]`, rates `xp`, the terminal export
    /// (W) and shaft speed (rad/s), physical units.
    pub fn rows(&self, t: f64, x: &[f64], xp: &[f64], export_w: f64, omega: f64, out: &mut [f64]) {
        let p = &self.parameters;
        let l = self.law(t, x[W], omega, x[I]);
        out[W] = xp[W] - (export_w - x[W]) / p.continuous.watt_lag_s;
        out[I] = match self.held.mode {
            Mode::Load => xp[I] - (l.trim + p.tracking_per_s() * (l.demand - l.raw)),
            Mode::Closed => xp[I],
        };
        let (rate, _) = self.travel((l.demand - x[A]) / p.continuous.position_lag_s);
        out[A] = xp[A] - rate;
    }
    /// Exact consistent rates at `x`.
    pub fn rates(&self, t: f64, x: &[f64], export_w: f64, omega: f64, xp: &mut [f64]) {
        let mut r = [0.; N];
        self.rows(t, x, &[0.; N], export_w, omega, &mut r);
        for k in 0..N {
            xp[k] = -r[k];
        }
    }
    /// `dF/dx + cj dF/dx'` of the three rows: `(own 3x3, d/d export, d/d omega)`.
    pub fn block(
        &self,
        t: f64,
        cj: f64,
        x: &[f64],
        omega: f64,
    ) -> ([[f64; N]; N], [f64; N], [f64; N]) {
        let p = &self.parameters;
        let l = self.law(t, x[W], omega, x[I]);
        let tau_w = p.continuous.watt_lag_s;
        let tau_a = p.continuous.position_lag_s;
        let mut g = [[0.; N]; N];
        let mut d_export = [0.; N];
        let mut d_omega = [0.; N];
        g[W][W] = cj + 1. / tau_w;
        d_export[W] = -1. / tau_w;
        // u* partials: w, omega, I.
        let (rw, ro, ri) = (l.raw_w, l.raw_omega, 1.);
        let du = l.demand_slope;
        if self.held.mode == Mode::Load {
            let kb = p.tracking_per_s();
            g[I][W] = -(l.trim_w + kb * (du - 1.) * rw);
            d_omega[I] = -(l.trim_omega + kb * (du - 1.) * ro);
            g[I][I] = cj - kb * (du - 1.) * ri;
        } else {
            g[I][I] = cj;
        }
        let (_, dr) = self.travel((l.demand - x[A]) / tau_a);
        g[A][A] = cj + dr / tau_a;
        g[A][W] = -dr * du * rw / tau_a;
        d_omega[A] = -dr * du * ro / tau_a;
        g[A][I] = -dr * du * ri / tau_a;
        (g, d_export, d_omega)
    }
    /// The tracking transfer into LOAD: `I` such that `u* = a` at the state.
    pub fn tracking_integral(&self, t: f64, w: f64, omega: f64, opening: f64) -> f64 {
        opening - self.law(t, w, omega, 0.).raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn governor() -> Governor {
        let p = Parameters {
            governor: GovernorBlock {
                sample_s: 0.1,
                droop: 0.05,
                setpoint_ramp_per_s: 0.1,
                proportional: 0.5,
                integral_per_s: 0.2,
                base_w: 1.1e9,
                overspeed_pu: 1.1,
            },
            continuous: ContinuousBlock {
                watt_lag_s: 0.1,
                position_lag_s: 0.1,
            },
            admission_travel_s: 1.,
            omega0_rad_s: 50. * std::f64::consts::PI,
        };
        Governor::new(p, 0., 1.0e9, 1.02e9).unwrap()
    }
    #[test]
    fn ramp_holds_ten_percent_per_second_and_continues_from_the_setpoint() {
        let mut g = governor();
        assert_eq!(g.setpoint_w(5.), 1.0e9);
        assert!(!g.request(1., 1.0e9).unwrap());
        assert!(g.request(1., 0.9e9).unwrap());
        assert!((g.setpoint_w(1.5) - (1.0e9 - 0.55e8)).abs() < 1e-3);
        assert_eq!(g.setpoint_w(3.), 0.9e9);
        // A new request mid-ramp starts from the setpoint in force.
        let mut h = governor();
        h.request(0., 0.8e9).unwrap();
        h.request(0.5, 1.0e9).unwrap();
        assert!((h.held.from_w - (1.0e9 - 0.55e8)).abs() < 1e-3);
        h.trip();
        assert!(h.request(2., 1.0e9).is_err());
    }
    #[test]
    fn block_matches_differences_of_the_rows() {
        let g = governor();
        let w0 = 50. * std::f64::consts::PI;
        for (x, omega) in [
            ([0.98e9, 0.4, 0.7], w0 * 1.001),
            ([1.0e9, 1.2, 0.99], w0),
            ([1.0e9, 0.3, 0.2], w0 * 0.999),
        ] {
            let cj = 7.;
            let (b, de, dom) = g.block(0.3, cj, &x, omega);
            let xp = [1., 2., 3.];
            let f = |x: &[f64; 3], xp: &[f64; 3], e: f64, o: f64| {
                let mut r = [0.; 3];
                g.rows(0.3, x, xp, e, o, &mut r);
                r
            };
            let e0 = 1.01e9;
            let base = f(&x, &xp, e0, omega);
            for c in 0..3 {
                let h = 1e-7 * x[c].abs().max(1.);
                let mut xx = x;
                xx[c] += h;
                let mut xxp = xp;
                xxp[c] += cj * h;
                let r = f(&xx, &xxp, e0, omega);
                for k in 0..3 {
                    let fd = (r[k] - base[k]) / h;
                    assert!(
                        (fd - b[k][c]).abs() <= 1e-5 * (1. + fd.abs()),
                        "row {k} col {c}: {fd} vs {}",
                        b[k][c]
                    );
                }
            }
            let r = f(&x, &xp, e0 + 1., omega);
            for k in 0..3 {
                assert!(((r[k] - base[k]) - de[k]).abs() < 1e-6);
            }
            let r = f(&x, &xp, e0, omega + 1e-6);
            for k in 0..3 {
                assert!(((r[k] - base[k]) / 1e-6 - dom[k]).abs() < 1e-4 * (1. + dom[k].abs()));
            }
        }
    }
    #[test]
    fn tracking_transfer_is_quiet_and_trip_closes_the_valve() {
        let mut g = governor();
        let w0 = g.parameters.omega0_rad_s;
        let i = g.tracking_integral(0., 1.0e9, w0, 0.6);
        let l = g.law(0., 1.0e9, w0, i);
        assert!((l.demand - 0.6).abs() < 1e-15);
        let mut r = [0.; 3];
        g.rows(0., &[1.0e9, i, 0.6], &[0.; 3], 1.0e9, w0, &mut r);
        assert!(r.iter().all(|v| v.abs() < 1e-12), "{r:?}");
        g.trip();
        g.rows(0., &[1.0e9, i, 0.6], &[0.; 3], 1.0e9, w0, &mut r);
        assert_eq!(r[I], 0.);
        assert_eq!(r[A], 1.); // closing at the 1 s full-travel bound
    }
}

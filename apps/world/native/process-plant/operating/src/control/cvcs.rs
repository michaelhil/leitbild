//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/inventory-and-chemistry.md#normal-inventory-controller
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/inventory-and-chemistry.md#compact-normal-inventory-control-plan-r4-1-november-2026
//! The normal inventory controller (`ld01-cvcs-controller`, with the
//! programmed level `ld01-pzr-level-program`), realized continuously (plan
//! r4 X4.2, lead decision R4-CVCS under the owner's 31 October instruction:
//! real time at every frame):
//!
//! ```text
//! L_set     = program(T)                     (constant outside its ends)
//! per branch, sigma = +1 charging, -1 letdown (lead R4-CVCS-PI):
//! eL = sigma (L_set - L)   r* = G (eL - band) + IL   r = sclamp(r*, 0, R)
//! IL' = (G/Ti) eL + (r_applied - r*)/Ti      (back-calculation, Ti = Kp/Ki)
//! e = (r - f)/F    u* = bias + Kp e + I    u = clamp(u*, 0, 1)
//! I' = Ki e + (u - u*) Ki/Kp                 (back-calculation)
//! s' = clamp((u - s)/tau, -v, v)             (first-order stem)
//! ```
//!
//! `L` is the lagged PZR level indication, `T` the lagged loop average,
//! `f` the lagged branch flow. The outer level loop keeps the wiki's
//! proportional gain `G` beyond the band and adds integral action on the
//! level error from the programmed setpoint, integral time `Ti` (judgement,
//! `levelIntegralTime_s`): the standard pressurizer level controller, which
//! holds the setpoint against a continuing shrink. `r_applied` is the request
//! in force: `r` in AUTO, the MANUAL or withdrawn request otherwise (then
//! the integral only tracks it). `sclamp` is the smooth band (judgement,
//! `deadbandWidth_m`); the clamps on `u` and the stroke rate are continuous
//! in value and are not located. The law owns no state: the CVCS owner
//! carries the lags, both integrals and both stems as differential
//! coordinates and evaluates these rates in its rows.
use crate::{network::Failure, thermal::Scalar};
use serde::{Deserialize, Serialize};

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("CVCS control: {}", reason.into()))
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
/// A hard clamp, continuous in value: a constant at its bounds.
pub fn clamp(x: Scalar, r: [f64; 2]) -> Scalar {
    if x.value < r[0] {
        s(r[0])
    } else if x.value > r[1] {
        s(r[1])
    } else {
        x
    }
}
/// `ln(1 + e^z)` and its direction `sigma(z) dz`, without overflow.
pub fn softplus(z: Scalar) -> Scalar {
    let v = z.value;
    let value = v.max(0.) + (-v.abs()).exp().ln_1p();
    let sigma = if v >= 0. {
        1. / (1. + (-v).exp())
    } else {
        let e = v.exp();
        e / (1. + e)
    };
    Scalar::new(value, sigma * z.direction)
}
/// The smooth band: `lo + w [softplus((x - lo)/w) - softplus((x - hi)/w)]`,
/// within `w ln 2` of `clamp(x, lo, hi)` at either end and converging to it
/// away from the ends.
pub fn sclamp(x: Scalar, r: [f64; 2], w: f64) -> Scalar {
    s(r[0]) + s(w) * (softplus((x - s(r[0])) / s(w)) - softplus((x - s(r[1])) / s(w)))
}

/// `ld01-pzr-level-program`'s two points.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProgramPoint {
    #[serde(rename = "loopAverage_K")]
    pub loop_average_k: f64,
    pub level_m: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Program {
    #[serde(rename = "fullPower")]
    pub full_power: ProgramPoint,
    #[serde(rename = "noLoad")]
    pub no_load: ProgramPoint,
}
impl Program {
    /// `L_set` at loop average `t`: linear between the points, constant
    /// outside them (R12-B3).
    pub fn setpoint(&self, t: Scalar) -> Scalar {
        let (a, b) = (self.no_load, self.full_power);
        let x = clamp(
            (t - s(a.loop_average_k)) / s(b.loop_average_k - a.loop_average_k),
            [0., 1.],
        );
        s(a.level_m) + s(b.level_m - a.level_m) * x
    }
}

/// `ld01-cvcs-controller`'s gains, ranges and lags with the compact
/// allocation's judgement values (`ld01-cvcs`).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Controller {
    #[serde(rename = "requestGain_kg_s_m")]
    pub request_gain_kg_s_m: f64,
    #[serde(rename = "requestRange_kg_s")]
    pub request_range_kg_s: [f64; 2],
    pub band_m: f64,
    #[serde(rename = "flowNormalization_kg_s")]
    pub flow_normalization_kg_s: f64,
    #[serde(rename = "valveBias")]
    pub valve_bias: f64,
    #[serde(rename = "innerProportional")]
    pub inner_proportional: f64,
    #[serde(rename = "innerIntegral_per_s")]
    pub inner_integral_per_s: f64,
    #[serde(rename = "valveRange")]
    pub valve_range: [f64; 2],
    #[serde(rename = "flowLag_s")]
    pub flow_lag_s: f64,
    #[serde(rename = "flowSpan_kg_s")]
    pub flow_span_kg_s: [f64; 2],
    #[serde(rename = "deadbandWidth_m")]
    pub deadband_width_m: f64,
    /// R4-CVCS-PI (judgement): the outer level loop's integral time.
    #[serde(rename = "levelIntegralTime_s")]
    pub level_integral_time_s: f64,
    #[serde(rename = "loopAverageLag_s")]
    pub loop_average_lag_s: f64,
    #[serde(rename = "stemTimeConstant_s")]
    pub stem_time_constant_s: f64,
    #[serde(rename = "strokePerSecond")]
    pub stroke_per_second: f64,
}

/// One branch's outer level loop at one state, with directions.
#[derive(Clone, Copy, Debug)]
pub struct Outer {
    /// The AUTO request `r` (kg/s).
    pub request: Scalar,
    /// `r*`, the unsaturated request (kg/s).
    pub unsaturated: Scalar,
    /// The integral's error term `(G/Ti) eL` (kg/s per s).
    pub error_rate: Scalar,
}

/// One branch's inner loop at one state, with directions.
#[derive(Clone, Copy, Debug)]
pub struct Inner {
    /// The valve demand `u`.
    pub demand: Scalar,
    /// `I'` (1/s).
    pub integral_rate: Scalar,
}

impl Controller {
    pub fn validate(&self) -> Result<(), Failure> {
        let pos = |v: f64| v.is_finite() && v > 0.;
        let range = |r: [f64; 2]| r[0].is_finite() && r[1].is_finite() && r[0] < r[1];
        if !([
            self.request_gain_kg_s_m,
            self.band_m,
            self.flow_normalization_kg_s,
            self.inner_proportional,
            self.inner_integral_per_s,
            self.flow_lag_s,
            self.deadband_width_m,
            self.level_integral_time_s,
            self.loop_average_lag_s,
            self.stem_time_constant_s,
            self.stroke_per_second,
        ]
        .into_iter()
        .all(pos)
            && [
                self.request_range_kg_s,
                self.valve_range,
                self.flow_span_kg_s,
            ]
            .into_iter()
            .all(range)
            && self.request_range_kg_s[0] == 0.
            && (self.valve_range[0]..=self.valve_range[1]).contains(&self.valve_bias))
        {
            return Err(fatal("controller values"));
        }
        Ok(())
    }
    /// One branch's outer loop (`charging` sign +1, letdown -1) at lagged
    /// level `l` (m), setpoint `setpoint` (m) and its integral `il` (kg/s).
    pub fn outer(&self, charging: bool, l: Scalar, setpoint: Scalar, il: Scalar) -> Outer {
        let g = self.request_gain_kg_s_m;
        let w = g * self.deadband_width_m;
        let e = if charging { setpoint - l } else { l - setpoint };
        let unsaturated = s(g) * (e - s(self.band_m)) + il;
        Outer {
            request: sclamp(unsaturated, self.request_range_kg_s, w),
            unsaturated,
            error_rate: s(g / self.level_integral_time_s) * e,
        }
    }
    /// The outer integral's rate with request `applied` in force: the
    /// error term in AUTO, plus back-calculation over the integral time
    /// `Ti = Kp/Ki` toward the request in force (which is the AUTO request
    /// in AUTO, so the term is the saturation excess); outside AUTO only the
    /// tracking term (`auto` false).
    pub fn outer_rate(&self, o: &Outer, applied: Scalar, auto: bool) -> Scalar {
        let tracking = (applied - o.unsaturated) / s(self.level_integral_time_s);
        if auto {
            o.error_rate + tracking
        } else {
            tracking
        }
    }
    /// The inner loop at request `r` and lagged flow `f` (kg/s) and
    /// integral `i`. `closed` (a stopped branch) demands the valve closed
    /// and only tracks the integral to it, `I' = (0 - u*) Ki/Kp`, so a
    /// permitted restart does not reapply an old accumulated opening.
    pub fn inner(&self, r: Scalar, f: Scalar, i: Scalar, closed: bool) -> Inner {
        let e = (r - f) / s(self.flow_normalization_kg_s);
        let unsat = s(self.valve_bias) + s(self.inner_proportional) * e + i;
        let tracking = s(self.inner_integral_per_s / self.inner_proportional);
        if closed {
            return Inner {
                demand: s(self.valve_range[0]),
                integral_rate: (s(self.valve_range[0]) - unsat) * tracking,
            };
        }
        let demand = clamp(unsat, self.valve_range);
        Inner {
            demand,
            integral_rate: s(self.inner_integral_per_s) * e + (demand - unsat) * tracking,
        }
    }
    /// The integral of the tracked point: demand `u` at zero error.
    pub fn tracked_integral(&self, u: f64) -> f64 {
        u - self.valve_bias
    }
    /// The stem's rate toward demand `u` from position `x`.
    pub fn stem_rate(&self, u: Scalar, x: Scalar) -> Scalar {
        let v = self.stroke_per_second;
        clamp((u - x) / s(self.stem_time_constant_s), [-v, v])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller() -> Controller {
        Controller {
            request_gain_kg_s_m: 5.,
            request_range_kg_s: [0., 5.],
            band_m: 0.1,
            flow_normalization_kg_s: 5.,
            valve_bias: 0.7,
            inner_proportional: 0.3,
            inner_integral_per_s: 0.2,
            valve_range: [0., 1.],
            flow_lag_s: 0.25,
            flow_span_kg_s: [-7.5, 7.5],
            deadband_width_m: 0.01,
            level_integral_time_s: 120.,
            loop_average_lag_s: 1.,
            stem_time_constant_s: 0.1,
            stroke_per_second: 0.1,
        }
    }
    fn program() -> Program {
        Program {
            full_power: ProgramPoint {
                loop_average_k: 577.58,
                level_m: 6.,
            },
            no_load: ProgramPoint {
                loop_average_k: 564.816667,
                level_m: 4.633,
            },
        }
    }

    #[test]
    fn the_smooth_band_stays_within_w_ln2_of_the_clamp_and_carries_its_slope() {
        let w = 0.05;
        for x in [-3., -0.2, -0.05, 0., 0.05, 0.3, 2.5, 4.95, 5., 5.05, 8.] {
            let a = sclamp(Scalar::new(x, 1.), [0., 5.], w);
            let hard = x.clamp(0., 5.);
            assert!((a.value - hard).abs() <= w * 2f64.ln() + 1e-15, "x {x}");
            // The slope is the central difference of the value law.
            let h = 1e-6;
            let fd = (sclamp(s(x + h), [0., 5.], w).value - sclamp(s(x - h), [0., 5.], w).value)
                / (2. * h);
            assert!(
                (a.direction - fd).abs() < 1e-7,
                "x {x}: {} vs {fd}",
                a.direction
            );
        }
        assert!(softplus(s(800.)).value == 800. && softplus(s(-800.)).value == 0.);
    }

    #[test]
    fn the_program_and_the_requests_follow_the_wiki_law_outside_the_smoothing() {
        let (c, p) = (controller(), program());
        assert!((p.setpoint(s(577.58)).value - 6.).abs() < 1e-12);
        assert!((p.setpoint(s(564.816667)).value - 4.633).abs() < 1e-12);
        assert_eq!(p.setpoint(s(590.)).value, 6.);
        assert_eq!(p.setpoint(s(550.)).value, 4.633);
        let requests = |l: f64| {
            let (c0, l0) = (
                c.outer(true, s(l), s(6.), s(0.)),
                c.outer(false, s(l), s(6.), s(0.)),
            );
            (c0.request, l0.request)
        };
        // With zero integrals the requests are the wiki's law: on the
        // setpoint both are below 3e-6 kg/s.
        let (rc, rl) = requests(6.);
        assert!(rc.value < 3e-6 && rl.value < 3e-6 && rc.value > 0.);
        // 0.5 m low: the wiki's clamp(5 (5.9 - 5.5), 0, 5) = 2 kg/s.
        let (rc, rl) = requests(5.5);
        assert!((rc.value - 2.).abs() < 1e-12 && rl.value < 1e-15);
        let (rc, rl) = requests(7.5);
        assert!((rl.value - 5.).abs() < 1e-12 && rc.value < 1e-15);
    }

    #[test]
    fn the_outer_integral_removes_the_offset_and_tracks_outside_auto() {
        let c = controller();
        // 0.5 m low with no integral: 2 kg/s, and the integral grows at
        // (G/Ti) e = 5/120 x 0.5 kg/s per s.
        let o = c.outer(true, s(5.5), s(6.), s(0.));
        assert!((o.request.value - 2.).abs() < 1e-12);
        let rate = c.outer_rate(&o, o.request, true);
        assert!((rate.value - 5. / 120. * 0.5).abs() < 1e-12);
        // At the setpoint with the integral carrying the shrink's makeup the
        // request is that makeup and the integral holds.
        let o = c.outer(true, s(6.), s(6.), s(2. + 0.5));
        assert!((o.request.value - 2.).abs() < 1e-12);
        assert!(c.outer_rate(&o, o.request, true).value.abs() < 1e-12);
        // Above the setpoint the request is zero, and the back-calculation
        // holds the charging integral at G band, where the unsaturated
        // request is the error's own proportional part.
        let o = c.outer(true, s(7.), s(6.), s(0.5));
        assert!(o.request.value < 1e-15);
        assert!(c.outer_rate(&o, o.request, true).value.abs() < 1e-12);
        // Outside AUTO the integral only tracks the request in force.
        let o = c.outer(true, s(5.5), s(6.), s(0.));
        let r = c.outer_rate(&o, s(1.), false);
        assert!((r.value - (1. - 2.) / 120.).abs() < 1e-12);
    }

    #[test]
    fn the_inner_loop_tracks_holds_and_closes() {
        let c = controller();
        // At the tracked point the integral rate is zero and the demand u.
        let u = 0.42;
        let i = c.tracked_integral(u);
        let at = c.inner(s(3.), s(3.), s(i), false);
        assert!((at.demand.value - u).abs() < 1e-15 && at.integral_rate.value.abs() < 1e-15);
        // Flow short of the request opens the valve and integrates up.
        let low = c.inner(s(3.), s(2.), s(i), false);
        assert!(low.demand.value > u && low.integral_rate.value > 0.);
        // Saturated high: the back-calculation pulls the integral down.
        let sat = c.inner(s(5.), s(0.), s(0.5), false);
        assert_eq!(sat.demand.value, 1.);
        assert!(sat.integral_rate.value < 0.);
        // A stopped branch demands closed and tracks the integral there.
        let closed = c.inner(s(5.), s(0.), s(0.2), true);
        assert_eq!(closed.demand.value, 0.);
        assert!((closed.integral_rate.value + (0.7 + 0.3 + 0.2) / 1.5).abs() < 1e-12);
        // The stem: first order, within the stroke rate.
        assert!((c.stem_rate(s(0.5), s(0.495)).value - 0.05).abs() < 1e-12);
        assert_eq!(c.stem_rate(s(1.), s(0.)).value, 0.1);
        assert_eq!(c.stem_rate(s(0.), s(1.)).value, -0.1);
    }
}

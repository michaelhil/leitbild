//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#selected-cascade-law
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#modes-and-transfer
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#continuous-realization-plan-r4-31-october-2026
//! The three-element SG level control law of one SG (`ld01-feed-cascade`),
//! realized continuously (owner, 31 October 2026: real time at every frame;
//! the 0.1 s sampled law forced 295 stops in 60 s): the outer level loop
//! trims the steam-flow feedforward into a requested feed flow, the inner
//! loop turns the feed-flow error into the FCV demand, with the page's gains
//! and channel lags unchanged.
//!
//! ```text
//! eL = lsp − l   r* = s + KpL eL + IL       r = clamp(r*)    IL' = KiL eL + (r − r*) KiL/KpL
//! eF = r − f     u* = bias + KpF eF + IF    u_d = clamp(u*)  IF' = KiF eF + (u_d − u*) KiF/KpF
//! ```
//!
//! `l` is the lagged NR1 channel normalized to its span, `s` and `f` the
//! lagged steam and feed flow channels normalized by the one-SG nominal feed
//! flow `m0`. Anti-windup is back-calculation, its tracking time each loop's
//! integral time `Kp/Ki` (owner, 31 October 2026; it replaces the page's
//! directional rule, whose switched rate chattered at the valve's lower
//! bound). The law owns no state: the SG owner carries the
//! lags, both integrals and the stem as differential coordinates and
//! evaluates these rates in its rows. The clamps' corners are continuous in
//! value and not located.
use crate::{network::Failure, thermal::Scalar};
use serde::{Deserialize, Serialize};

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("feed control: {}", reason.into()))
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn clamp(x: Scalar, r: [f64; 2]) -> Scalar {
    if x.value < r[0] {
        s(r[0])
    } else if x.value > r[1] {
        s(r[1])
    } else {
        x
    }
}

/// `ld01-feed-cascade`'s gains, ranges and lags, unchanged (normalized
/// units), with the NR span and lag of `ld01-sg-level-channels`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Cascade {
    #[serde(rename = "levelSetpoint")]
    pub level_setpoint: f64,
    #[serde(rename = "outerProportional")]
    pub outer_proportional: f64,
    #[serde(rename = "outerIntegral_per_s")]
    pub outer_integral_per_s: f64,
    #[serde(rename = "requestRange")]
    pub request_range: [f64; 2],
    #[serde(rename = "valveBias")]
    pub valve_bias: f64,
    #[serde(rename = "valveRange")]
    pub valve_range: [f64; 2],
    #[serde(rename = "innerProportional")]
    pub inner_proportional: f64,
    #[serde(rename = "innerIntegral_per_s")]
    pub inner_integral_per_s: f64,
    #[serde(rename = "feedFlowLag_s")]
    pub feed_flow_lag_s: f64,
    #[serde(rename = "feedFlowSpan")]
    pub feed_flow_span: [f64; 2],
    #[serde(rename = "steamFlowLag_s")]
    pub steam_flow_lag_s: f64,
    #[serde(rename = "steamFlowSpan")]
    pub steam_flow_span: [f64; 2],
    #[serde(rename = "narrowSpan_m")]
    pub narrow_span_m: [f64; 2],
    #[serde(rename = "nrLag_s")]
    pub nr_lag_s: f64,
}

/// The controller's normal mode (the page's MANUAL, AUTO and HOLD).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Mode {
    Manual,
    Auto,
    Hold,
}

/// The law at one state, with directions.
#[derive(Clone, Copy, Debug)]
pub struct Law {
    /// Requested feed flow, normalized.
    pub request: Scalar,
    /// FCV demand.
    pub demand: Scalar,
    /// `IL'` and `IF'` (1/s).
    pub outer_rate: Scalar,
    pub inner_rate: Scalar,
}

/// Back-calculation anti-windup (owner, 31 October 2026): the integral's
/// rate plus the saturation excess `clamp(x) - x` fed back over the loop's
/// integral time `kp/ki` (no new tuning value), so the rate is continuous
/// in the state. The directional rule's switched rate chattered at the
/// valve's lower bound (C2 worst 763 CPU-s/s, 13,403 convergence failures).
fn integral_rate(
    gain: f64,
    proportional: f64,
    error: Scalar,
    unsat: Scalar,
    range: [f64; 2],
) -> Scalar {
    let excess = clamp(unsat, range) - unsat;
    s(gain) * error + excess * s(gain / proportional)
}

impl Cascade {
    pub fn validate(&self) -> Result<(), Failure> {
        let pos = |v: f64| v.is_finite() && v > 0.;
        let range = |r: [f64; 2]| r[0].is_finite() && r[1].is_finite() && r[0] < r[1];
        if !([
            self.outer_proportional,
            self.outer_integral_per_s,
            self.inner_proportional,
            self.inner_integral_per_s,
            self.feed_flow_lag_s,
            self.steam_flow_lag_s,
            self.nr_lag_s,
        ]
        .into_iter()
        .all(pos)
            && [
                self.request_range,
                self.valve_range,
                self.feed_flow_span,
                self.steam_flow_span,
                self.narrow_span_m,
            ]
            .into_iter()
            .all(range)
            && (0. ..=1.).contains(&self.level_setpoint)
            && (self.valve_range[0]..=self.valve_range[1]).contains(&self.valve_bias))
        {
            return Err(fatal("cascade values"));
        }
        Ok(())
    }

    /// The AUTO law at the lagged channels (level m, flows kg/s) and both
    /// integrals.
    pub fn auto(
        &self,
        m0: f64,
        level_m: Scalar,
        steam_kg_s: Scalar,
        feed_kg_s: Scalar,
        outer: Scalar,
        inner: Scalar,
    ) -> Law {
        let [lo, hi] = self.narrow_span_m;
        let l = (level_m - s(lo)) / s(hi - lo);
        let (st, f) = (steam_kg_s / s(m0), feed_kg_s / s(m0));
        let el = s(self.level_setpoint) - l;
        let r_unsat = st + s(self.outer_proportional) * el + outer;
        let request = clamp(r_unsat, self.request_range);
        let ef = request - f;
        let u_unsat = s(self.valve_bias) + s(self.inner_proportional) * ef + inner;
        Law {
            request,
            demand: clamp(u_unsat, self.valve_range),
            outer_rate: integral_rate(
                self.outer_integral_per_s,
                self.outer_proportional,
                el,
                r_unsat,
                self.request_range,
            ),
            inner_rate: integral_rate(
                self.inner_integral_per_s,
                self.inner_proportional,
                ef,
                u_unsat,
                self.valve_range,
            ),
        }
    }

    /// The page's tracked transfer into AUTO at observed position `u` and
    /// lagged channels: `IL = f − s − KpL eL` (request `r = f`), `IF = u −
    /// bias − KpF (r − f)` (first demand `u`). Refused when a channel lies
    /// outside its span or the feed outside the request range.
    pub fn tracked(
        &self,
        m0: f64,
        level_m: f64,
        steam_kg_s: f64,
        feed_kg_s: f64,
        u: f64,
    ) -> Result<(f64, f64), Failure> {
        let [lo, hi] = self.narrow_span_m;
        let (st, f) = (steam_kg_s / m0, feed_kg_s / m0);
        if !((lo..=hi).contains(&level_m)
            && (self.steam_flow_span[0]..=self.steam_flow_span[1]).contains(&st)
            && (self.feed_flow_span[0]..=self.feed_flow_span[1]).contains(&f)
            && (self.request_range[0]..=self.request_range[1]).contains(&f))
        {
            return Err(fatal(format!(
                "AUTO entry refused: level {level_m} m, steam {st}, feed {f} (normalized)"
            )));
        }
        let el = self.level_setpoint - (level_m - lo) / (hi - lo);
        Ok((f - st - self.outer_proportional * el, u - self.valve_bias))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn law() -> Cascade {
        Cascade {
            level_setpoint: 0.6,
            outer_proportional: 1.,
            outer_integral_per_s: 0.025,
            request_range: [0., 1.2],
            valve_bias: 0.7,
            valve_range: [0., 1.],
            inner_proportional: 0.3,
            inner_integral_per_s: 0.2,
            feed_flow_lag_s: 0.25,
            feed_flow_span: [0., 1.5],
            steam_flow_lag_s: 0.25,
            steam_flow_span: [0., 1.5],
            narrow_span_m: [4., 9.],
            nr_lag_s: 0.5,
        }
    }

    #[test]
    fn the_tracked_point_demands_the_observed_position_and_a_low_level_raises_it() {
        let (c, m0) = (law(), 800.);
        let (il, i_f) = c.tracked(m0, 6.94, 820., 820., 0.877).unwrap();
        let at = c.auto(m0, s(6.94), s(820.), s(820.), s(il), s(i_f));
        assert!((at.demand.value - 0.877).abs() < 1e-12);
        assert!((at.request.value - 820. / 800.).abs() < 1e-12);
        let low = c.auto(m0, s(6.5), s(820.), s(820.), s(il), s(i_f));
        assert!(low.demand.value > 0.877 && low.outer_rate.value > 0.);
    }

    #[test]
    fn back_calculation_pulls_a_saturated_integral_back_and_out_of_span_refuses_auto() {
        let (c, m0) = (law(), 800.);
        let sat = c.auto(m0, s(4.), s(1100.), s(500.), s(0.), s(0.4));
        assert_eq!(sat.request.value, 1.2);
        assert_eq!(sat.demand.value, 1.);
        // r* = 1.975 above 1.2: KiL eL = 0.015 against (1.2 - 1.975) 0.025.
        assert!(sat.outer_rate.value < 0. && sat.inner_rate.value < 0.);
        let inside = c.auto(m0, s(6.9), s(800.), s(800.), s(0.), s(0.));
        assert!((inside.outer_rate.value - 0.025 * (0.6 - 2.9 / 5.)).abs() < 1e-15);
        assert!(c.tracked(m0, 3.9, 800., 800., 0.7).is_err());
    }
}

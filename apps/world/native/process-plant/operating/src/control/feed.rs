//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#selected-cascade-law
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/feedwater/control-and-faults.md#modes-and-transfer
//! The three-element SG level control law of one SG (`ld01-feed-cascade`),
//! sampled on the declared 0.1 s I&C frame: the outer level loop trims the
//! steam-flow feedforward into a requested feed flow, the inner loop turns
//! the feed-flow error into the FCV demand.
//!
//! ```text
//! eL = lsp − l            r = clamp(s + KpL eL + IL, r_lo, r_hi)   dIL/dt = KiL eL
//! eF = r − f              u = clamp(bias + KpF eF + IF, u_lo, u_hi) dIF/dt = KiF eF
//! ```
//!
//! `l` is the selected NR channel normalized to its span, `s` and `f` the
//! steam and feed flow channels normalized by the one-SG nominal feed flow
//! `m0`. Each integral advances once per frame by the frame's error
//! (forward), and stops while saturation and the error would drive the
//! unsaturated output farther outward (the page's directional anti-windup).
//! The law owns no plant state and never reads solver truth: it takes the
//! acquired (lagged) channel values and the observed FCV position, and
//! returns a valve demand that the composing frame driver applies to the
//! SG owner's FCV stem (a held-input change at the frame instant, class S).
//! An unusable or out-of-span input withdraws AUTO to HOLD (the last demand
//! retained); there is no substitute input and no single-element fallback.
use crate::network::Failure;
use serde::{Deserialize, Serialize};

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("feed control: {}", reason.into()))
}

/// `ld01-feed-cascade`, unchanged (normalized units).
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
    #[serde(rename = "sample_s")]
    pub sample_s: f64,
    #[serde(rename = "feedFlowLag_s")]
    pub feed_flow_lag_s: f64,
    #[serde(rename = "feedFlowSpan")]
    pub feed_flow_span: [f64; 2],
    #[serde(rename = "steamFlowLag_s")]
    pub steam_flow_lag_s: f64,
    #[serde(rename = "steamFlowSpan")]
    pub steam_flow_span: [f64; 2],
    /// `ld01-sg-level-channels`: the narrow span (m) and the NR lag (s).
    #[serde(rename = "narrowSpan_m")]
    pub narrow_span_m: [f64; 2],
    #[serde(rename = "nrLag_s")]
    pub nr_lag_s: f64,
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
            self.sample_s,
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
}

/// The controller's normal mode (the page's MANUAL, AUTO and HOLD).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub enum Mode {
    Manual,
    Auto,
    Hold,
}

/// One frame's acquired inputs of one SG, in physical units; `None` where
/// the channel is unusable (unavailable or out of span).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Inputs {
    pub level_m: Option<f64>,
    pub steam_kg_s: Option<f64>,
    pub feed_kg_s: Option<f64>,
    /// The observed (delivered) FCV position.
    pub position: f64,
}

/// One SG's controller state: the mode, both integrals and the demand.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Controller {
    pub mode: Mode,
    pub outer_integral: f64,
    pub inner_integral: f64,
    pub demand: f64,
    /// The last requested feed flow (normalized), AUTO only.
    pub request: f64,
}

/// One frame's decision, for the receipt.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Decision {
    pub mode: Mode,
    pub level: Option<f64>,
    pub request: f64,
    pub demand: f64,
    /// AUTO withdrawn to HOLD at this frame.
    pub withdrawn: bool,
}

/// Directional anti-windup: integrate unless the unsaturated output lies
/// beyond a bound and the error drives it farther out.
fn integrate(integral: f64, gain: f64, error: f64, dt: f64, unsat: f64, range: [f64; 2]) -> f64 {
    if (unsat > range[1] && error > 0.) || (unsat < range[0] && error < 0.) {
        integral
    } else {
        integral + gain * error * dt
    }
}

impl Controller {
    /// MANUAL at a prepared demand (the page's initial mode).
    pub fn manual(demand: f64, law: &Cascade) -> Result<Self, Failure> {
        law.validate()?;
        if !(law.valve_range[0]..=law.valve_range[1]).contains(&demand) {
            return Err(fatal(format!(
                "MANUAL demand {demand} outside the valve range"
            )));
        }
        Ok(Self {
            mode: Mode::Manual,
            outer_integral: 0.,
            inner_integral: 0.,
            demand,
            request: 0.,
        })
    }

    fn normalized(law: &Cascade, m0: f64, i: &Inputs) -> Option<(f64, f64, f64)> {
        let [lo, hi] = law.narrow_span_m;
        let l = i.level_m.filter(|v| (lo..=hi).contains(v))?;
        let s = i
            .steam_kg_s
            .map(|v| v / m0)
            .filter(|v| (law.steam_flow_span[0]..=law.steam_flow_span[1]).contains(v))?;
        let f = i
            .feed_kg_s
            .map(|v| v / m0)
            .filter(|v| (law.feed_flow_span[0]..=law.feed_flow_span[1]).contains(v))?;
        Some(((l - lo) / (hi - lo), s, f))
    }

    /// The tracked MANUAL/HOLD → AUTO transfer (the page's tracking law):
    /// `IL = f − s − KpL eL` (request `r = f`), `IF = u_obs − bias −
    /// KpF (r − f)` (first output `u_obs`). Refused with unusable inputs or
    /// a feed flow outside the request range.
    pub fn transfer_to_auto(&mut self, law: &Cascade, m0: f64, i: &Inputs) -> Result<(), Failure> {
        let (l, s, f) = Self::normalized(law, m0, i)
            .ok_or_else(|| fatal("AUTO entry needs valid level, steam and feed inputs"))?;
        if !(law.request_range[0]..=law.request_range[1]).contains(&f) {
            return Err(fatal(format!(
                "AUTO entry refused: feed {f} outside the request range"
            )));
        }
        let el = law.level_setpoint - l;
        self.outer_integral = f - s - law.outer_proportional * el;
        self.inner_integral = i.position - law.valve_bias;
        self.request = f;
        self.demand = i.position;
        self.mode = Mode::Auto;
        Ok(())
    }

    /// One frame: the demand in force after it.
    pub fn frame(&mut self, law: &Cascade, m0: f64, i: &Inputs) -> Decision {
        let mut withdrawn = false;
        let level = i.level_m;
        if self.mode == Mode::Auto {
            match Self::normalized(law, m0, i) {
                None => {
                    self.mode = Mode::Hold;
                    withdrawn = true;
                }
                Some((l, s, f)) => {
                    let dt = law.sample_s;
                    let el = law.level_setpoint - l;
                    let r_unsat = s + law.outer_proportional * el + self.outer_integral;
                    let r = r_unsat.clamp(law.request_range[0], law.request_range[1]);
                    self.outer_integral = integrate(
                        self.outer_integral,
                        law.outer_integral_per_s,
                        el,
                        dt,
                        r_unsat,
                        law.request_range,
                    );
                    let ef = r - f;
                    let u_unsat =
                        law.valve_bias + law.inner_proportional * ef + self.inner_integral;
                    let u = u_unsat.clamp(law.valve_range[0], law.valve_range[1]);
                    self.inner_integral = integrate(
                        self.inner_integral,
                        law.inner_integral_per_s,
                        ef,
                        dt,
                        u_unsat,
                        law.valve_range,
                    );
                    self.request = r;
                    self.demand = u;
                }
            }
        }
        Decision {
            mode: self.mode,
            level,
            request: self.request,
            demand: self.demand,
            withdrawn,
        }
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
            sample_s: 0.1,
            feed_flow_lag_s: 0.25,
            feed_flow_span: [0., 1.5],
            steam_flow_lag_s: 0.25,
            steam_flow_span: [0., 1.5],
            narrow_span_m: [4., 9.],
            nr_lag_s: 0.5,
        }
    }

    #[test]
    fn the_tracked_transfer_is_bumpless_and_a_low_level_raises_demand() {
        let (law, m0) = (law(), 800.);
        let mut c = Controller::manual(0.877, &law).unwrap();
        let at = Inputs {
            level_m: Some(6.94),
            steam_kg_s: Some(820.),
            feed_kg_s: Some(820.),
            position: 0.877,
        };
        c.transfer_to_auto(&law, m0, &at).unwrap();
        let d = c.frame(&law, m0, &at);
        assert!((d.demand - 0.877).abs() < 1e-12 && (d.request - 820. / 800.).abs() < 1e-12);
        let low = Inputs {
            level_m: Some(6.5),
            ..at
        };
        let d = c.frame(&law, m0, &low);
        assert!(d.demand > 0.877 && d.request > 820. / 800.);
    }

    #[test]
    fn an_out_of_span_level_withdraws_auto_to_hold_and_keeps_the_demand() {
        let (law, m0) = (law(), 800.);
        let mut c = Controller::manual(0.5, &law).unwrap();
        let at = Inputs {
            level_m: Some(7.),
            steam_kg_s: Some(400.),
            feed_kg_s: Some(400.),
            position: 0.5,
        };
        c.transfer_to_auto(&law, m0, &at).unwrap();
        let d = c.frame(
            &law,
            m0,
            &Inputs {
                level_m: Some(3.9),
                ..at
            },
        );
        assert!(d.withdrawn && d.mode == Mode::Hold && d.demand == 0.5);
    }

    #[test]
    fn saturation_stops_the_outward_integral() {
        let (law, m0) = (law(), 800.);
        let mut c = Controller::manual(1., &law).unwrap();
        let at = Inputs {
            level_m: Some(7.),
            steam_kg_s: Some(800.),
            feed_kg_s: Some(800.),
            position: 1.,
        };
        c.transfer_to_auto(&law, m0, &at).unwrap();
        let empty = Inputs {
            level_m: Some(4.),
            steam_kg_s: Some(1100.),
            feed_kg_s: Some(500.),
            ..at
        };
        c.frame(&law, m0, &empty);
        let (il, i_f) = (c.outer_integral, c.inner_integral);
        c.frame(&law, m0, &empty);
        assert_eq!((c.outer_integral, c.inner_integral), (il, i_f));
        assert_eq!(c.demand, 1.);
    }
}

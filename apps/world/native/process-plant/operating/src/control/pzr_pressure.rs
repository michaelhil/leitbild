//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation
//! The normal PZR pressure control law in AUTO: from the delivered PT1
//! sample to the heater power request and the controlled-spray opening
//! demand, evaluated once per 0.1 s I&C frame (S3-D1, class S or R when
//! its output changes).
//!
//! The law is the owner's proportional/dead-band selection, unchanged:
//!
//! ```text
//! P_request = C clamp[(p_set − p_PT1)/B, 0, 1]
//! x_spray   = clamp[(p_PT1 − p_set − s_start)/(s_full − s_start), 0, 1]
//! ```
//!
//! with `C` the heater capacity, `B` the proportional band, `p_set` the
//! commissioned setpoint and the spray offsets relative to it. `p_PT1` is
//! the delivered acquired sample (range-checked, quantized, lagged and
//! transported by its channel owner); the law never reads solver
//! pressure. A sample that is unavailable, out of range or older than the
//! freshness bound withdraws AUTO: zero heater request and closed spray
//! demand, reported. There is no integral state, no staging latch and no
//! duty-cycle scheduler: the heater request is one continuous number that
//! the equipment splits over its banks (`Heaters::bank_powers`).
//!
//! Every value comes from the compiled `pzrControl` section
//! (`reference-design-operating-pzr-control.ts`, strict wiki blocks only).
use crate::{network::Failure, thermal::Scalar};
use serde::{Deserialize, Serialize};

/// R4-PZR-PI (lead 1 Nov 2026): the continuous pressure master. One demand
/// `D = (p_L − p_set) + I` from the PT1 channel lag `p_L` (a PZR owner
/// coordinate) and the master integral `I` (Pa, a PZR owner coordinate)
/// drives the heaters and the controlled spray:
///
/// ```text
/// P   = (C/B) sclamp(−D, [0, B], w)                     heater request
/// u   = smin1((D − s0)/(s1 − s0), w/(s1 − s0))          spray demand, D ≥ s0
/// I'  = (sclamp(D, [−B, s1], w) − I)/Ti                 back-calculation
/// ```
///
/// `I' = e/Ti + (clamp(D) − D)/Ti` with `e = p_L − p_set`: back-calculation
/// anti-windup with tracking time `Kp/Ki = Ti` (unit proportional gain on
/// the Pa demand), as FEED's and CVCS's controllers. The capacity, band,
/// setpoint and spray offsets are the owners' values, unchanged; `Ti` and
/// the corner width `w` are the lead's judgement (R4-PZR-PI: Ti screened on
/// the S2 diagnostics; w = 1 kPa, the PT1 quantum, a control-law smoothing
/// after CVCS's smooth band, not numerical damping). The spray demand's
/// lower end `D = s0` is a located root of the PZR owner (the valve leaves
/// or returns to its closed lock, class R), so only its upper corner is
/// smoothed; [`Master::spray_demand`] is linear from 0 at `s0`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Master {
    #[serde(rename = "setpoint_Pa")]
    pub setpoint_pa: f64,
    #[serde(rename = "heaterCapacity_W")]
    pub heater_capacity_w: f64,
    #[serde(rename = "heaterProportionalBand_Pa")]
    pub heater_band_pa: f64,
    #[serde(rename = "sprayStartAboveSetpoint_Pa")]
    pub spray_start_pa: f64,
    #[serde(rename = "sprayFullAboveSetpoint_Pa")]
    pub spray_full_pa: f64,
    /// The PT1 channel's first-order lag time constant.
    pub lag_s: f64,
    /// R4-PZR-PI: the master's integral time (judgement).
    #[serde(rename = "integralTime_s")]
    pub integral_time_s: f64,
    /// R4-PZR-PI: the corner width on the demand (the PT1 quantum).
    #[serde(rename = "smoothingWidth_Pa")]
    pub smoothing_width_pa: f64,
    /// R4-PZR-PI (S-b): the spray stem's first-order time constant toward
    /// its demand within the valve's stroke rate (judgement, FEED's and
    /// CVCS's 0.1 s).
    #[serde(rename = "sprayStemTimeConstant_s")]
    pub spray_stem_time_constant_s: f64,
}

fn sc(v: f64) -> Scalar {
    Scalar::constant(v)
}

/// `w softplus` smooth minimum of `v` and 1 that is exact at 0:
/// `v − ε [softplus((v − 1)/ε) − softplus(−1/ε)]`.
fn smin1(v: Scalar, eps: f64) -> Scalar {
    use crate::control::cvcs::softplus;
    v - sc(eps) * (softplus((v - sc(1.)) / sc(eps)) - softplus(sc(-1. / eps)))
}

impl Master {
    /// Admits the owners' values: positive capacity, band, lag, integral
    /// time, width and stem time constant; a spray band above the setpoint.
    pub fn validate(&self) -> Result<(), Failure> {
        for (name, v) in [
            ("setpoint_Pa", self.setpoint_pa),
            ("heaterCapacity_W", self.heater_capacity_w),
            ("heaterProportionalBand_Pa", self.heater_band_pa),
            ("sprayFullAboveSetpoint_Pa", self.spray_full_pa),
            ("lag_s", self.lag_s),
            ("integralTime_s", self.integral_time_s),
            ("smoothingWidth_Pa", self.smoothing_width_pa),
            ("sprayStemTimeConstant_s", self.spray_stem_time_constant_s),
        ] {
            if !(v.is_finite() && v > 0.) {
                return Err(fatal(format!(
                    "continuous master: {name} must be positive and finite, not {v}"
                )));
            }
        }
        if !(self.spray_start_pa.is_finite()
            && self.spray_start_pa > 0.
            && self.spray_start_pa < self.spray_full_pa)
        {
            return Err(fatal(format!(
                "continuous master: spray band [{}, {}] Pa above the setpoint",
                self.spray_start_pa, self.spray_full_pa
            )));
        }
        Ok(())
    }
    /// `D = (p_L − p_set) + I`, Pa.
    pub fn demand(&self, lag: Scalar, integral: Scalar) -> Scalar {
        lag - sc(self.setpoint_pa) + integral
    }
    /// The heater request at demand `d`, W, in `[0, C]`: `(C/B)` times the
    /// smooth band of `−d` over `[0, B]`. The band's value is mathematically
    /// at most `B`; a rounding above it is the band's end.
    pub fn heater_request(&self, d: Scalar) -> Scalar {
        use crate::control::cvcs::sclamp;
        let (c, b) = (self.heater_capacity_w, self.heater_band_pa);
        let f = sclamp(-d, [0., b], self.smoothing_width_pa) / sc(b);
        let f = if f.value > 1. { Scalar::new(1., f.direction) } else { f };
        sc(c) * f
    }
    /// The spray demand at `d` while the valve is open (`d ≥ s0`, the
    /// located root's side): linear from 0 at `s0`, its upper corner at
    /// `s1` smoothed by `w`.
    pub fn spray_demand(&self, d: Scalar) -> Scalar {
        let span = self.spray_full_pa - self.spray_start_pa;
        smin1(
            (d - sc(self.spray_start_pa)) / sc(span),
            self.smoothing_width_pa / span,
        )
    }
    /// The spray root: `d − s0` (the valve leaves its lock rising through
    /// zero and returns to it falling).
    pub fn spray_root(&self, d: f64) -> f64 {
        d - self.spray_start_pa
    }
    /// `I'` (Pa/s): back-calculation toward the smoothly clamped demand.
    pub fn integral_rate(&self, d: Scalar, integral: Scalar) -> Scalar {
        use crate::control::cvcs::sclamp;
        (sclamp(
            d,
            [-self.heater_band_pa, self.spray_full_pa],
            self.smoothing_width_pa,
        ) - integral)
            / sc(self.integral_time_s)
    }
    /// The bank-split width, W: the request per corner width, `(C/B) w`
    /// (30 kW at 1 kPa: the adjacent PT1 bins' request difference).
    pub fn split_width_w(&self) -> f64 {
        self.heater_capacity_w / self.heater_band_pa * self.smoothing_width_pa
    }
    /// The demand whose heater request is `request_w`, Pa: the closed-form
    /// inverse of the strictly decreasing [`Master::heater_request`]. With
    /// `r = P B/(C w)` and `β = B/w`, `softplus(a) − softplus(a − β) = r`
    /// gives `e^a = expm1(r)/(−expm1(r − β))` and `D = −w a`. Refused outside
    /// `(0, C)`: zero heat or full heat has no unique demand.
    pub fn demand_for_request(&self, request_w: f64) -> Result<f64, Failure> {
        let (c, b, w) = (self.heater_capacity_w, self.heater_band_pa, self.smoothing_width_pa);
        if !(request_w.is_finite() && request_w > 0. && request_w < c) {
            return Err(fatal(format!(
                "a prepared heater request {request_w} W outside (0, {c}) W has no master demand"
            )));
        }
        let (r, beta) = (request_w * b / (c * w), b / w);
        let a = r.exp_m1().ln() - (-(r - beta).exp_m1()).ln();
        let d = -w * a;
        if !d.is_finite() {
            return Err(fatal(format!("no finite master demand for {request_w} W")));
        }
        Ok(d)
    }
}

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("PZR pressure control: {}", reason.into()))
}

/// The compiled `pzrControl` section: the owners' values, unchanged.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    /// `ld01-pzr-pressure-control`: the commissioned PT1 setpoint.
    #[serde(rename = "setpoint_Pa")]
    pub setpoint_pa: f64,
    /// `reference-pressurizer-normal-thermal`: capacity and band.
    #[serde(rename = "heaterCapacity_W")]
    pub heater_capacity_w: f64,
    #[serde(rename = "heaterProportionalBand_Pa")]
    pub heater_band_pa: f64,
    /// `ld01-pzr-pressure-control`: the controlled-spray offsets above the
    /// setpoint where demand starts and where it is full.
    #[serde(rename = "sprayStartAboveSetpoint_Pa")]
    pub spray_start_pa: f64,
    #[serde(rename = "sprayFullAboveSetpoint_Pa")]
    pub spray_full_pa: f64,
    /// `ld01-pzr-pressure-control`: the largest sample age the law
    /// consumes (the shared simulation-time freshness rule).
    #[serde(rename = "freshness_s")]
    pub freshness_s: f64,
    /// `reference-pzr-pressure-channel`: the acquisition sample, which is
    /// the control frame.
    #[serde(rename = "sample_s")]
    pub sample_s: f64,
    /// `reference-pzr-pressure-channel`: the channel span, for the
    /// usability check of a delivered value.
    #[serde(rename = "spanMinimum_Pa")]
    pub span_minimum_pa: f64,
    #[serde(rename = "spanMaximum_Pa")]
    pub span_maximum_pa: f64,
    /// The compiler's consumed pages and blocks, for receipts only.
    pub provenance: serde_json::Value,
}

/// A delivered PT1 sample's quality, as its channel owner reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Quality {
    Usable,
    Unavailable,
    BelowRange,
    AboveRange,
}

/// One delivered PT1 sample: the quantized value, its acquisition time
/// (age is judged from it, not from delivery) and its quality.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Sample {
    pub value_pa: f64,
    pub acquired_s: f64,
    pub quality: Quality,
}

/// Why AUTO withdrew to zero heater and closed spray.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Withdrawal {
    /// No sample has been delivered.
    NoSample,
    /// The channel reports the sample unusable.
    Quality(Quality),
    /// The sample is older than the freshness bound, or from the future.
    Age,
}

/// The law's demands at one frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Demand {
    /// Nominal-voltage heater power request, W, in `[0, capacity]`.
    pub heater_request_w: f64,
    /// Controlled-spray opening demand, stem fraction in `[0, 1]`.
    pub spray_target: f64,
    pub withdrawn: Option<Withdrawal>,
}

/// The validated AUTO law.
#[derive(Clone, Debug)]
pub struct Law {
    setpoint_pa: f64,
    capacity_w: f64,
    band_pa: f64,
    spray_start_pa: f64,
    spray_full_pa: f64,
    freshness_s: f64,
    sample_s: f64,
    span: [f64; 2],
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0., 1.)
}

impl Law {
    /// Admits the section: positive capacity, band, frame and freshness; a
    /// spray band above the setpoint with its start below its full point;
    /// the setpoint inside the channel span. Nothing is defaulted.
    pub fn new(section: &Section) -> Result<Self, Failure> {
        let s = section;
        for (name, v) in [
            ("setpoint_Pa", s.setpoint_pa),
            ("heaterCapacity_W", s.heater_capacity_w),
            ("heaterProportionalBand_Pa", s.heater_band_pa),
            ("sprayFullAboveSetpoint_Pa", s.spray_full_pa),
            ("freshness_s", s.freshness_s),
            ("sample_s", s.sample_s),
            ("spanMaximum_Pa", s.span_maximum_pa),
        ] {
            if !(v.is_finite() && v > 0.) {
                return Err(fatal(format!(
                    "{name} must be positive and finite, not {v}"
                )));
            }
        }
        if !(s.spray_start_pa.is_finite()
            && s.spray_start_pa >= 0.
            && s.spray_start_pa < s.spray_full_pa)
        {
            return Err(fatal(format!(
                "spray band [{}, {}] Pa above the setpoint must start at or above it and below its full point",
                s.spray_start_pa, s.spray_full_pa
            )));
        }
        if !(s.span_minimum_pa.is_finite()
            && s.span_minimum_pa < s.setpoint_pa
            && s.setpoint_pa < s.span_maximum_pa)
        {
            return Err(fatal("the setpoint must lie inside the PT1 channel span"));
        }
        Ok(Self {
            setpoint_pa: s.setpoint_pa,
            capacity_w: s.heater_capacity_w,
            band_pa: s.heater_band_pa,
            spray_start_pa: s.spray_start_pa,
            spray_full_pa: s.spray_full_pa,
            freshness_s: s.freshness_s,
            sample_s: s.sample_s,
            span: [s.span_minimum_pa, s.span_maximum_pa],
        })
    }
    pub fn setpoint_pa(&self) -> f64 {
        self.setpoint_pa
    }
    pub fn capacity_w(&self) -> f64 {
        self.capacity_w
    }
    pub fn band_pa(&self) -> f64 {
        self.band_pa
    }
    pub fn spray_start_pa(&self) -> f64 {
        self.spray_start_pa
    }
    pub fn spray_full_pa(&self) -> f64 {
        self.spray_full_pa
    }
    /// The control frame, s: the acquisition sample interval.
    pub fn frame_s(&self) -> f64 {
        self.sample_s
    }

    /// The AUTO demands at `now_s` from the latest delivered sample.
    pub fn auto(&self, sample: Option<&Sample>, now_s: f64) -> Demand {
        let withdrawn = |w| Demand {
            heater_request_w: 0.,
            spray_target: 0.,
            withdrawn: Some(w),
        };
        let Some(sample) = sample else {
            return withdrawn(Withdrawal::NoSample);
        };
        if sample.quality != Quality::Usable {
            return withdrawn(Withdrawal::Quality(sample.quality));
        }
        let age = now_s - sample.acquired_s;
        if !(age.is_finite() && age >= 0. && age <= self.freshness_s) {
            return withdrawn(Withdrawal::Age);
        }
        let p = sample.value_pa;
        if !(p.is_finite() && self.span[0] <= p && p <= self.span[1]) {
            // A usable sample is inside the span by the channel's own
            // range check; anything else is a channel defect.
            return withdrawn(Withdrawal::Quality(Quality::Unavailable));
        }
        Demand {
            heater_request_w: self.capacity_w * clamp01((self.setpoint_pa - p) / self.band_pa),
            spray_target: clamp01(
                (p - self.setpoint_pa - self.spray_start_pa)
                    / (self.spray_full_pa - self.spray_start_pa),
            ),
            withdrawn: None,
        }
    }
}

/// What one frame's evaluation changed against the demands in force.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Frame {
    pub t_s: f64,
    pub demand: Demand,
    /// The heater request in force before this frame, W.
    pub heater_before_w: f64,
    pub spray_before: f64,
}
impl Frame {
    /// A held-input change at this frame instant: the composing driver
    /// classifies it (S3-D1 class S under the smallness criterion, else R).
    pub fn changes(&self) -> bool {
        self.demand.heater_request_w != self.heater_before_w
            || self.demand.spray_target != self.spray_before
    }
}

/// The AUTO controller: the law and the demands in force. Its only memory
/// is the last issued demand; there is no integral, filter or latch.
#[derive(Clone, Debug)]
pub struct Controller {
    law: Law,
    in_force: Demand,
}
impl Controller {
    /// Starts with the demands the equipment is prepared with (the
    /// commissioning's initial intent), so the first frame reports its
    /// change against them.
    pub fn new(law: Law, heater_request_w: f64, spray_target: f64) -> Result<Self, Failure> {
        if !(heater_request_w.is_finite()
            && (0. ..=law.capacity_w).contains(&heater_request_w)
            && (0. ..=1.).contains(&spray_target))
        {
            return Err(fatal(format!(
                "prepared demands {heater_request_w} W, spray {spray_target} outside their ranges"
            )));
        }
        Ok(Self {
            law,
            in_force: Demand {
                heater_request_w,
                spray_target,
                withdrawn: None,
            },
        })
    }
    pub fn law(&self) -> &Law {
        &self.law
    }
    pub fn in_force(&self) -> Demand {
        self.in_force
    }
    /// Evaluate the law at the frame instant `t_s` on the latest delivered
    /// sample and put its demands in force.
    pub fn frame(&mut self, t_s: f64, sample: Option<&Sample>) -> Frame {
        let demand = self.law.auto(sample, t_s);
        let frame = Frame {
            t_s,
            demand,
            heater_before_w: self.in_force.heater_request_w,
            spray_before: self.in_force.spray_target,
        };
        self.in_force = demand;
        frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owners' values (wiki): setpoint 14,864,186.8055 Pa, 3 MW over
    /// 100 kPa, spray from +20 to +100 kPa, 2 s freshness, 0.1 s sample,
    /// span 0–20 MPa.
    fn section() -> Section {
        Section {
            setpoint_pa: 14_864_186.805_5,
            heater_capacity_w: 3e6,
            heater_band_pa: 1e5,
            spray_start_pa: 2e4,
            spray_full_pa: 1e5,
            freshness_s: 2.,
            sample_s: 0.1,
            span_minimum_pa: 0.,
            span_maximum_pa: 2e7,
            provenance: serde_json::Value::Null,
        }
    }
    fn usable(value_pa: f64, acquired_s: f64) -> Sample {
        Sample {
            value_pa,
            acquired_s,
            quality: Quality::Usable,
        }
    }

    #[test]
    fn adjacent_bins_request_the_owners_commands_30_kw_apart() {
        // The owner's executed comparison: 14.862 MPa -> 65,604.16590 W,
        // 14.863 MPa -> 35,604.16590 W, spray zero at both. That receipt
        // used the unrounded commissioned setpoint; the selected printed
        // 14,864,186.8055 Pa gives 0.9 mW less (3e-5 Pa of setpoint).
        let law = Law::new(&section()).unwrap();
        let a = law.auto(Some(&usable(14_862_000., 0.)), 0.1);
        let b = law.auto(Some(&usable(14_863_000., 0.)), 0.1);
        assert!((a.heater_request_w - 65_604.165_90).abs() < 1e-3);
        assert!((b.heater_request_w - 35_604.165_90).abs() < 1e-3);
        assert!((a.heater_request_w - b.heater_request_w - 30_000.).abs() < 1e-6);
        assert_eq!((a.spray_target, b.spray_target), (0., 0.));
        assert_eq!(a.withdrawn, None);
    }

    #[test]
    fn heaters_saturate_and_spray_ramps_between_its_offsets() {
        let law = Law::new(&section()).unwrap();
        let sp = 14_864_186.805_5;
        let low = law.auto(Some(&usable(sp - 2e5, 0.)), 0.);
        assert_eq!(low.heater_request_w, 3e6);
        let at = law.auto(Some(&usable(sp, 0.)), 0.);
        assert_eq!((at.heater_request_w, at.spray_target), (0., 0.));
        let start = law.auto(Some(&usable(sp + 2e4, 0.)), 0.);
        assert_eq!(start.spray_target, 0.);
        let mid = law.auto(Some(&usable(sp + 6e4, 0.)), 0.);
        assert!((mid.spray_target - 0.5).abs() < 1e-12);
        let full = law.auto(Some(&usable(sp + 2e5, 0.)), 0.);
        assert_eq!((full.heater_request_w, full.spray_target), (0., 1.));
    }

    #[test]
    fn unusable_stale_or_missing_evidence_withdraws_to_zero_and_closed() {
        let law = Law::new(&section()).unwrap();
        let low = 14_000_000.;
        assert_eq!(law.auto(None, 1.).withdrawn, Some(Withdrawal::NoSample));
        let stale = law.auto(Some(&usable(low, 0.)), 2.000_001);
        assert_eq!(stale.withdrawn, Some(Withdrawal::Age));
        assert_eq!((stale.heater_request_w, stale.spray_target), (0., 0.));
        // Exactly the freshness bound is still fresh.
        assert_eq!(law.auto(Some(&usable(low, 0.)), 2.).withdrawn, None);
        let future = law.auto(Some(&usable(low, 1.)), 0.9);
        assert_eq!(future.withdrawn, Some(Withdrawal::Age));
        let below = Sample {
            quality: Quality::BelowRange,
            ..usable(0., 0.)
        };
        assert_eq!(
            law.auto(Some(&below), 0.1).withdrawn,
            Some(Withdrawal::Quality(Quality::BelowRange))
        );
    }

    #[test]
    fn a_frame_reports_its_change_against_the_demands_in_force() {
        let law = Law::new(&section()).unwrap();
        // Prepared with S2's constant demand (P4's 19.59 kW).
        let mut c = Controller::new(law, 19_590., 0.).unwrap();
        let f = c.frame(0.1, Some(&usable(14_860_000., 0.)));
        assert!(f.changes());
        assert_eq!(f.heater_before_w, 19_590.);
        let again = c.frame(0.2, Some(&usable(14_860_000., 0.1)));
        assert!(!again.changes());
        assert_eq!(again.heater_before_w, f.demand.heater_request_w);
    }

    fn master() -> Master {
        Master {
            setpoint_pa: 14_864_186.805_5,
            heater_capacity_w: 3e6,
            heater_band_pa: 1e5,
            spray_start_pa: 172_369.,
            spray_full_pa: 517_107.,
            lag_s: 0.2,
            integral_time_s: 300.,
            smoothing_width_pa: 1000.,
            spray_stem_time_constant_s: 0.1,
        }
    }

    #[test]
    fn the_master_is_the_owners_law_away_from_its_corners() {
        // R4-PZR-PI: away from the corners the heater request is the
        // proportional law on the demand, the spray demand its ramp.
        let m = master();
        m.validate().unwrap();
        let close = |a: f64, b: f64, tol: f64| (a - b).abs() <= tol;
        for d in [-60_000., -40_000., -20_000.] {
            let p = m.heater_request(Scalar::new(d, 1.));
            assert!(close(p.value, 3e6 * (-d / 1e5), 1e-3), "{d}: {}", p.value);
            assert!(close(p.direction, -30., 1e-6), "{d}");
        }
        assert!(m.heater_request(sc(50_000.)).value < 1e-9);
        assert!(close(m.heater_request(sc(-200_000.)).value, 3e6, 1e-6));
        // The D = 0 corner: (C/B) w ln 2 = 20.79 kW.
        assert!(close(m.heater_request(sc(0.)).value, 30. * 1000. * 2f64.ln(), 1e-6));
        // Spray: exactly 0 at s0, the ramp inside, 1 beyond s1.
        assert_eq!(m.spray_demand(sc(172_369.)).value, 0.);
        let mid = m.spray_demand(Scalar::new(0.5 * (172_369. + 517_107.), 1.));
        assert!(close(mid.value, 0.5, 1e-9));
        assert!(close(mid.direction, 1. / 344_738., 1e-15));
        assert!(close(m.spray_demand(sc(700_000.)).value, 1., 1e-12));
    }

    #[test]
    fn the_integral_tracks_the_clamped_demand_and_the_request_inverts() {
        let m = master();
        // Inside the range I' = e/Ti; saturated, I relaxes to the clamp.
        let (e, i) = (-5_000., -2_000.);
        let d = m.demand(sc(m.setpoint_pa + e), sc(i));
        assert!((m.integral_rate(d, sc(i)).value - e / 300.).abs() < 1e-9);
        let d = m.demand(sc(m.setpoint_pa + 900_000.), sc(0.));
        assert!((m.integral_rate(d, sc(0.)).value - 517_107. / 300.).abs() < 1e-6);
        // The prepared request's demand reproduces it.
        for w in [56_383.158_95, 80_610., 1.5e6] {
            let d = m.demand_for_request(w).unwrap();
            assert!((m.heater_request(sc(d)).value - w).abs() <= 1e-9 * w, "{w}");
        }
        assert!(m.demand_for_request(0.).is_err());
        assert!(m.demand_for_request(3e6).is_err());
        assert!(m.split_width_w() == 30_000.);
    }

    #[test]
    fn inadmissible_sections_refuse() {
        let mut s = section();
        s.spray_start_pa = 1e5;
        assert!(Law::new(&s).is_err());
        let mut s = section();
        s.heater_band_pa = 0.;
        assert!(Law::new(&s).is_err());
        let mut s = section();
        s.setpoint_pa = 2.1e7;
        assert!(Law::new(&s).is_err());
        let law = Law::new(&section()).unwrap();
        assert!(Controller::new(law, 3.1e6, 0.).is_err());
    }
}

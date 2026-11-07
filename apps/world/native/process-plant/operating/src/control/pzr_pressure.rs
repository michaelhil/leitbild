//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation
//! The normal PZR pressure control in AUTO (R4-PZR-PI, lead 1 November
//! 2026): the continuous pressure master [`Master`], on the PT1 channel's
//! lag and the master's own integral, both PZR owner coordinates, with the
//! controlled-spray stem (`joined::pzr`). The owner's proportional law is
//! its value with the integral zero, away from its smoothed corners:
//!
//! ```text
//! P_request = C clamp[(p_set − p)/B, 0, 1]
//! x_spray   = clamp[(p − p_set − s_start)/(s_full − s_start), 0, 1]
//! ```
//!
//! with `C` the heater capacity, `B` the proportional band, `p_set` the
//! commissioned setpoint and the spray offsets relative to it. The law
//! never reads solver pressure. The sampled law's AUTO withdrawal on an
//! unusable sample is not part of the continuous master: the lag leaving
//! the PT1 channel's span ends the case loudly at that frame (the S3
//! client's reduction, `unit::pzr_control`).
//!
//! Every value comes from the compiled `pzrControl` section and the
//! packet's `pzrMetal.continuousControl`
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
        let f = if f.value > 1. {
            Scalar::new(1., f.direction)
        } else {
            f
        };
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
        let (c, b, w) = (
            self.heater_capacity_w,
            self.heater_band_pa,
            self.smoothing_width_pa,
        );
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

/// A held demand put in force between solver segments (the PZR block's
/// held form, `joined::pzr::Pzr::apply_control`, and the spray path's held
/// stem, `joined::operator::Joined::apply_pzr_control`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Demand {
    /// Nominal-voltage heater power request, W, in `[0, capacity]`.
    pub heater_request_w: f64,
    /// Controlled-spray opening demand, stem fraction in `[0, 1]`.
    pub spray_target: f64,
}

/// The validated `pzrControl` section: the owners' values the continuous
/// master's packet values must equal (`unit::pzr_control::commission`).
#[derive(Clone, Debug)]
pub struct Law {
    setpoint_pa: f64,
    capacity_w: f64,
    band_pa: f64,
    spray_start_pa: f64,
    spray_full_pa: f64,
    sample_s: f64,
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
            sample_s: s.sample_s,
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
        assert!(close(
            m.heater_request(sc(0.)).value,
            30. * 1000. * 2f64.ln(),
            1e-6
        ));
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
    }
}

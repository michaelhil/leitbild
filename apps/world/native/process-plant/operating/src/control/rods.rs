//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-and-verification.md#automatic-rod-control-x44
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/control-absorber-and-guide-water.md#grip-manual-disconnect-and-achieved-motion
//! Automatic rod control (plan r4 X4.4): the AP1000 DCD §7.7.1 structure on
//! LD-01's one group, sampled on the 0.1 s I&C frame. It turns acquired
//! evidence (the Tavg, turbine-load, nuclear-power and bank-position
//! channels, delivered by the composing client) into the common requested
//! rate of the rods' rate drive; it owns no plant state and never reads
//! solver truth.
//!
//! ```text
//! Tref   = T_nl + (T_fp − T_nl) clamp(L, 0, 1)
//! e      = (Tavg − Tref) + K_pm (x − z),   x = P_n − L,   z' = (x − z)/τ_pm
//! speed  = 0 inside the dead band (lock-up hysteresis), else
//!          s_min + (s_max − s_min) clamp((|e| − b)/(e_max − b), 0, 1) steps/min
//! rate   = −sign(e) min(speed · stroke/steps/60, v_max), bounded so the
//!          acquired position stays inside the travel limits after one frame
//! ```
//!
//! `L` is the lagged turbine-load channel (fraction of the prepared
//! admission), `P_n` the nuclear-power channel (fraction of the hot
//! reference's fission rate), `x − z` the power-mismatch rate-lag. The
//! rate-lag is continued exactly over each frame for an input linear between
//! frame samples. Positive error (too hot, or nuclear power above load)
//! inserts. LD-01 has one group of 52 clusters, so there is no bank
//! sequencing or overlap (the wiki selects one group).
//!
//! Every value comes from the strict wiki block `ld01-rod-control`; the
//! full-power Tavg is measured on the composing client's Tavg channel at the
//! packet's prepared hot reference. AP1000-typical speeds, dead band and
//! lock-up are scaled to LD-01's stroke and labelled judgement in the block.
use crate::network::Failure;
use serde::{Deserialize, Serialize};

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("rod control: {}", reason.into()))
}

/// The `ld01-rod-control` block, unchanged.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Section {
    /// The control frame (the I&C sample interval).
    pub sample_s: f64,
    /// Designed no-load Tavg (owner R12-B1).
    #[serde(rename = "noLoadTavg_K")]
    pub no_load_tavg_k: f64,
    /// Dead band and lock-up on |e|: motion starts at the dead band and
    /// stops below the lock-up.
    #[serde(rename = "deadBand_K")]
    pub dead_band_k: f64,
    #[serde(rename = "lockUp_K")]
    pub lock_up_k: f64,
    /// Speed program: `minimum` steps/min at the dead band rising linearly
    /// to `maximum` at `maximumSpeedError_K`.
    #[serde(rename = "minimumSpeed_steps_min")]
    pub minimum_speed_steps_min: f64,
    #[serde(rename = "maximumSpeed_steps_min")]
    pub maximum_speed_steps_min: f64,
    #[serde(rename = "maximumSpeedError_K")]
    pub maximum_speed_error_k: f64,
    /// Steps over LD-01's stroke, and the stroke.
    #[serde(rename = "stepsPerStroke")]
    pub steps_per_stroke: f64,
    #[serde(rename = "stroke_m")]
    pub stroke_m: f64,
    /// The rate drive's ordinary limit (`ordinarySpeedLimit_m_s`).
    #[serde(rename = "ordinarySpeedLimit_m_s")]
    pub ordinary_speed_limit_m_s: f64,
    /// Power-mismatch channel: gain on the rate-lag of `P_n − L` and its
    /// time constant.
    #[serde(rename = "mismatchGain_K")]
    pub mismatch_gain_k: f64,
    #[serde(rename = "mismatchRateLag_s")]
    pub mismatch_rate_lag_s: f64,
    /// AUTO's travel limits (acquired bank position), m.
    #[serde(rename = "travelLimits_m")]
    pub travel_limits_m: [f64; 2],
    /// Channels: Tavg (loop RTD lag and quantum), turbine load (steam-flow
    /// channel lag), bank position (BANK.POS lag).
    #[serde(rename = "tavgLag_s")]
    pub tavg_lag_s: f64,
    #[serde(rename = "tavgQuantum_K")]
    pub tavg_quantum_k: f64,
    #[serde(rename = "loadLag_s")]
    pub load_lag_s: f64,
    #[serde(rename = "positionLag_s")]
    pub position_lag_s: f64,
}

/// `z(h)` of `z' = (x − z)/τ` from `z0` for `x` linear from `x0` to `x1`
/// over `h` (exact).
pub fn lag(z0: f64, x0: f64, x1: f64, h: f64, tau: f64) -> f64 {
    if h == 0. {
        return z0;
    }
    let a = (x1 - x0) / h;
    x1 - a * tau + (z0 - x0 + a * tau) * (-h / tau).exp()
}

/// The channels' delivered values at one frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Evidence {
    pub tavg_k: f64,
    /// Turbine load, fraction of the prepared admission.
    pub load: f64,
    /// Nuclear power, fraction of the hot reference.
    pub nuclear: f64,
    /// Bank position, m.
    pub position_m: f64,
}

/// The law's decision at one frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Decision {
    pub tref_k: f64,
    pub temperature_error_k: f64,
    pub mismatch_k: f64,
    pub error_k: f64,
    pub moving: bool,
    /// The requested common rate, m/s (positive withdraws).
    pub rate_m_s: f64,
}

/// The validated law.
#[derive(Clone, Debug)]
pub struct Law {
    s: Section,
    full_power_tavg_k: f64,
}

impl Law {
    /// Admits the block and the measured full-power Tavg: positive frame,
    /// lags, speeds, stroke and limit; a lock-up below the dead band below
    /// the maximum-speed error; the full-power Tavg above the no-load one;
    /// ordered travel limits. Nothing is defaulted.
    pub fn new(section: &Section, full_power_tavg_k: f64) -> Result<Self, Failure> {
        let s = section;
        for (name, v) in [
            ("sample_s", s.sample_s),
            ("noLoadTavg_K", s.no_load_tavg_k),
            ("lockUp_K", s.lock_up_k),
            ("minimumSpeed_steps_min", s.minimum_speed_steps_min),
            ("stepsPerStroke", s.steps_per_stroke),
            ("stroke_m", s.stroke_m),
            ("ordinarySpeedLimit_m_s", s.ordinary_speed_limit_m_s),
            ("mismatchRateLag_s", s.mismatch_rate_lag_s),
            ("tavgLag_s", s.tavg_lag_s),
            ("tavgQuantum_K", s.tavg_quantum_k),
            ("loadLag_s", s.load_lag_s),
            ("positionLag_s", s.position_lag_s),
        ] {
            if !(v.is_finite() && v > 0.) {
                return Err(fatal(format!(
                    "{name} must be positive and finite, not {v}"
                )));
            }
        }
        if !(s.lock_up_k < s.dead_band_k && s.dead_band_k < s.maximum_speed_error_k) {
            return Err(fatal(
                "lock-up < dead band < maximum-speed error is required",
            ));
        }
        if !(s.maximum_speed_steps_min.is_finite()
            && s.minimum_speed_steps_min < s.maximum_speed_steps_min)
        {
            return Err(fatal("the minimum speed must lie below the maximum"));
        }
        if !(s.mismatch_gain_k.is_finite() && s.mismatch_gain_k >= 0.) {
            return Err(fatal("the mismatch gain must be finite and nonnegative"));
        }
        let [lo, hi] = s.travel_limits_m;
        if !(lo.is_finite() && hi.is_finite() && 0. <= lo && lo < hi && hi <= s.stroke_m) {
            return Err(fatal("travel limits must be ordered inside the stroke"));
        }
        if !(full_power_tavg_k.is_finite() && full_power_tavg_k > s.no_load_tavg_k) {
            return Err(fatal(format!(
                "full-power Tavg {full_power_tavg_k} K must lie above the no-load {} K",
                s.no_load_tavg_k
            )));
        }
        Ok(Self {
            s: s.clone(),
            full_power_tavg_k,
        })
    }
    pub fn section(&self) -> &Section {
        &self.s
    }
    pub fn full_power_tavg_k(&self) -> f64 {
        self.full_power_tavg_k
    }
    pub fn frame_s(&self) -> f64 {
        self.s.sample_s
    }
    /// The Tavg program at turbine load `load`.
    pub fn tref_k(&self, load: f64) -> f64 {
        self.s.no_load_tavg_k
            + (self.full_power_tavg_k - self.s.no_load_tavg_k) * load.clamp(0., 1.)
    }
    /// The speed program's rate magnitude (m/s) at |e| while moving.
    pub fn speed_m_s(&self, error_k: f64) -> f64 {
        let s = &self.s;
        let u = ((error_k.abs() - s.dead_band_k) / (s.maximum_speed_error_k - s.dead_band_k))
            .clamp(0., 1.);
        let steps =
            s.minimum_speed_steps_min + (s.maximum_speed_steps_min - s.minimum_speed_steps_min) * u;
        (steps / 60. * s.stroke_m / s.steps_per_stroke).min(s.ordinary_speed_limit_m_s)
    }
}

/// The AUTO controller: the law, its hysteresis state, the mismatch
/// rate-lag and the rate in force.
#[derive(Clone, Debug)]
pub struct Controller {
    law: Law,
    moving: bool,
    /// The rate-lag's state and its input at the last frame.
    lag: f64,
    input: f64,
    rate: f64,
}

impl Controller {
    /// Commissioned on the first delivered evidence: the rate-lag settled
    /// on it (no mismatch term), not moving, the drive at rest.
    pub fn new(law: Law, first: &Evidence) -> Result<Self, Failure> {
        let x = first.nuclear - first.load;
        if !x.is_finite() {
            return Err(fatal("commissioning evidence is not finite"));
        }
        Ok(Self {
            law,
            moving: false,
            lag: x,
            input: x,
            rate: 0.,
        })
    }
    pub fn law(&self) -> &Law {
        &self.law
    }
    pub fn rate(&self) -> f64 {
        self.rate
    }
    /// Evaluate at a frame, `h` after the previous one, on the delivered
    /// evidence, and put the requested rate in force.
    pub fn frame(&mut self, h: f64, e: &Evidence) -> Result<Decision, Failure> {
        let s = &self.law.s;
        if ![e.tavg_k, e.load, e.nuclear, e.position_m]
            .iter()
            .all(|v| v.is_finite())
            || !(h.is_finite() && h >= 0.)
        {
            return Err(fatal(format!("evidence {e:?} over {h} s is not finite")));
        }
        let x = e.nuclear - e.load;
        self.lag = lag(self.lag, self.input, x, h, s.mismatch_rate_lag_s);
        self.input = x;
        let mismatch = s.mismatch_gain_k * (x - self.lag);
        let tref = self.law.tref_k(e.load);
        let temperature = e.tavg_k - tref;
        let error = temperature + mismatch;
        self.moving = if self.moving {
            error.abs() >= s.lock_up_k
        } else {
            error.abs() >= s.dead_band_k
        };
        let mut rate = if self.moving {
            -error.signum() * self.law.speed_m_s(error)
        } else {
            0.
        };
        // AUTO's travel limits on the acquired position, one frame ahead.
        let [lo, hi] = s.travel_limits_m;
        let frame = s.sample_s;
        rate = rate.clamp(
            ((lo - e.position_m) / frame).min(0.),
            ((hi - e.position_m) / frame).max(0.),
        );
        self.rate = rate;
        Ok(Decision {
            tref_k: tref,
            temperature_error_k: temperature,
            mismatch_k: mismatch,
            error_k: error,
            moving: self.moving,
            rate_m_s: rate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section() -> Section {
        Section {
            sample_s: 0.1,
            no_load_tavg_k: 564.82,
            dead_band_k: 1.5 / 1.8,
            lock_up_k: 1. / 1.8,
            minimum_speed_steps_min: 8.,
            maximum_speed_steps_min: 72.,
            maximum_speed_error_k: 3. / 1.8,
            steps_per_stroke: 228.,
            stroke_m: 4.,
            ordinary_speed_limit_m_s: 0.008,
            mismatch_gain_k: 5.,
            mismatch_rate_lag_s: 30.,
            travel_limits_m: [0., 4.],
            tavg_lag_s: 1.,
            tavg_quantum_k: 0.1,
            load_lag_s: 0.25,
            position_lag_s: 0.1,
        }
    }
    fn at(tavg_k: f64, load: f64, nuclear: f64, position_m: f64) -> Evidence {
        Evidence {
            tavg_k,
            load,
            nuclear,
            position_m,
        }
    }

    #[test]
    fn the_program_and_the_speeds_scale_to_the_stroke() {
        let law = Law::new(&section(), 573.).unwrap();
        assert_eq!(law.tref_k(0.), 564.82);
        assert_eq!(law.tref_k(1.), 573.);
        assert_eq!(law.tref_k(1.2), 573.);
        // 8 steps/min of 4 m/228 at the dead band; the 8 mm/s cap binds
        // above 27.36 steps/min.
        assert!((law.speed_m_s(1.5 / 1.8) - 8. / 60. * 4. / 228.).abs() < 1e-15);
        assert_eq!(law.speed_m_s(3. / 1.8), 0.008);
        assert_eq!(law.speed_m_s(10.), 0.008);
    }

    #[test]
    fn dead_band_lock_up_and_direction() {
        let law = Law::new(&section(), 573.).unwrap();
        let mut c = Controller::new(law, &at(573., 1., 1., 3.48)).unwrap();
        // Inside the dead band: no motion.
        assert_eq!(c.frame(0.1, &at(573.8, 1., 1., 3.48)).unwrap().rate_m_s, 0.);
        // Above it: insert.
        let d = c.frame(0.1, &at(574., 1., 1., 3.48)).unwrap();
        assert!(d.moving && d.rate_m_s < 0.);
        // Between lock-up and dead band: keeps moving.
        assert!(c.frame(0.1, &at(573.6, 1., 1., 3.48)).unwrap().rate_m_s < 0.);
        // Below the lock-up: stops.
        assert_eq!(c.frame(0.1, &at(573.5, 1., 1., 3.48)).unwrap().rate_m_s, 0.);
        // Too cold: withdraw.
        assert!(c.frame(0.1, &at(572., 1., 1., 3.48)).unwrap().rate_m_s > 0.);
    }

    #[test]
    fn a_load_rise_withdraws_through_the_program_and_the_mismatch() {
        let law = Law::new(&section(), 573.).unwrap();
        let t90 = 564.82 + 0.9 * (573. - 564.82);
        let mut c = Controller::new(law, &at(t90, 0.9, 0.9, 3.48)).unwrap();
        // Load 90 -> 100 %: Tref +0.818 K (inside the band alone), and the
        // mismatch −10 % × 5 K.
        let d = c.frame(0.1, &at(t90, 1., 0.9, 3.48)).unwrap();
        assert!((d.tref_k - 573.).abs() < 1e-12);
        assert!(d.mismatch_k < -0.49 && d.rate_m_s > 0.);
        // The rate-lag decays to zero at a held mismatch.
        let mut last = d;
        for _ in 0..3000 {
            last = c.frame(0.1, &at(573., 1., 0.9, 3.48)).unwrap();
        }
        assert!(last.mismatch_k.abs() < 1e-3);
    }

    #[test]
    fn the_travel_limits_bound_the_rate_one_frame_ahead() {
        let law = Law::new(&section(), 573.).unwrap();
        let mut c = Controller::new(law, &at(573., 1., 1., 3.9995)).unwrap();
        let d = c.frame(0.1, &at(560., 1., 1., 3.9995)).unwrap();
        assert!((d.rate_m_s - 0.005).abs() < 1e-12);
        let d = c.frame(0.1, &at(560., 1., 1., 4.)).unwrap();
        assert_eq!(d.rate_m_s, 0.);
    }

    #[test]
    fn the_lag_is_exact_for_a_ramp() {
        // z' = (x − z)/τ with x = t from z(0) = −τ stays at t − τ.
        let z = lag(-2., 0., 1., 1., 2.);
        assert!((z - (1. - 2.)).abs() < 1e-15);
    }

    #[test]
    fn inadmissible_blocks_refuse() {
        let mut s = section();
        s.lock_up_k = 1.;
        assert!(Law::new(&s, 573.).is_err());
        assert!(Law::new(&section(), 560.).is_err());
        let mut s = section();
        s.travel_limits_m = [0., 4.5];
        assert!(Law::new(&s, 573.).is_err());
    }
}

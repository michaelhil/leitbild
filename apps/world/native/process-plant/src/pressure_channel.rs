//! Selected offline PZR pressure acquisition: powered electronic lag, sampled
//! range/quantization, and finite transport history. It does not read a plant,
//! infer quality from truth, vote protection, or prescribe solver step sizes.
//!
//! The caller supplies the actual tap-pressure polynomial of each accepted
//! plant interval. The passive lag is continued analytically outside the plant
//! nonlinear solve and error norm; it does not feed back into that plant. Only the selected equal
//! sample/transport interval is supported: one pending sample suffices. Copies
//! retain the whole acquisition, not a newly timestamped old indication.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub lag_s: f64,
    pub min_pa: f64,
    pub max_pa: f64,
    pub quantum_pa: f64,
    pub sample_s: f64,
    pub transport_s: f64,
}

impl Config {
    pub fn validate(self) -> Result<(), String> {
        if [
            self.lag_s,
            self.min_pa,
            self.max_pa,
            self.quantum_pa,
            self.sample_s,
            self.transport_s,
        ]
        .iter()
        .any(|x| !x.is_finite())
            || self.lag_s <= 0.
            || self.min_pa < 0.
            || self.max_pa <= self.min_pa
            || self.quantum_pa <= 0.
            || self.quantum_pa > self.max_pa - self.min_pa
            || self.sample_s <= 0.
            || self.transport_s != self.sample_s
        {
            return Err("Invalid selected pressure-channel configuration".into());
        }
        Ok(())
    }

    /// Exact continuation of `response_dot=(pressure-response)/lag_s` under
    /// the caller's accepted pressure polynomial. Entries are RAW derivatives
    /// at the interval START: `[p, p', ..., p^(q)]`, q <= 5, not Taylor
    /// coefficients. Exactness is relative to that polynomial, not the true
    /// plant trajectory. Split intervals at power changes; an unpowered
    /// electronic response is retained, never reset on restoration.
    pub fn advance_polynomial(
        self,
        response_pa: f64,
        dt_s: f64,
        derivatives_start: &[f64],
        powered: bool,
    ) -> Result<f64, String> {
        self.validate()?;
        if !response_pa.is_finite()
            || !dt_s.is_finite()
            || dt_s < 0.
            || derivatives_start.is_empty()
            || derivatives_start.len() > 6
            || derivatives_start.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid pressure response polynomial".into());
        }
        if !powered || dt_s == 0. {
            return Ok(response_pa);
        }
        let z = dt_s / self.lag_s;
        if !z.is_finite() {
            return Err("Unrepresentable pressure response interval".into());
        }
        // w_k = z * integral_0^1 exp[-z(1-u)] u^k du.
        // For small z the recurrence subtracts nearly equal terms; use its
        // convergent series instead. For z>1 and q<=5 recurrence is stable.
        let mut weights = [0.; 6];
        weights[0] = -(-z).exp_m1();
        for k in 1..derivatives_start.len() {
            weights[k] = if z <= 1. {
                let mut term = z / (k + 1) as f64;
                let mut sum = term;
                let mut j = 0;
                loop {
                    term *= -z / (k + j + 2) as f64;
                    let next = sum + term;
                    if next == sum {
                        break sum;
                    }
                    sum = next;
                    j += 1;
                }
            } else {
                1. - k as f64 / z * weights[k - 1]
            };
        }
        let mut result = response_pa + weights[0] * (derivatives_start[0] - response_pa);
        let mut power_over_factorial = 1.;
        for k in 1..derivatives_start.len() {
            power_over_factorial *= dt_s / k as f64;
            result += derivatives_start[k] * power_over_factorial * weights[k];
        }
        if !result.is_finite() {
            return Err("Unrepresentable pressure response continuation".into());
        }
        Ok(result)
    }

    fn sample(self, lag_pa: f64, faults: Faults) -> Result<Quality, String> {
        let raw = faults.stuck_pa.unwrap_or(lag_pa) + faults.bias_pa;
        if !raw.is_finite() {
            return Err("Unrepresentable pressure-channel acquired value".into());
        }
        // Assess the physical indicated range BEFORE rounding. An overrange
        // sample cannot become an apparently exact in-range endpoint.
        if raw < self.min_pa {
            return Ok(Quality::BelowRange {
                bound_pa: self.min_pa,
            });
        }
        if raw > self.max_pa {
            return Ok(Quality::AboveRange {
                bound_pa: self.max_pa,
            });
        }
        let quantized = (raw / self.quantum_pa).round() * self.quantum_pa;
        if !quantized.is_finite() {
            return Err("Unrepresentable pressure-channel quantization".into());
        }
        Ok(Quality::Value(quantized))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Faults {
    /// Applied to the retained lag response (or explicit stuck response), not
    /// to physical pressure. Plausible biased samples remain usable evidence.
    pub bias_pa: f64,
    /// Frozen pre-bias instrument response. Fresh acquisitions retain new
    /// timestamps; no hidden truth comparison labels a stuck sample BAD.
    pub stuck_pa: Option<f64>,
    /// Withhold deliveries and discard in-flight/new samples. Releasing the
    /// hold requires a new acquisition; old held samples are never replayed.
    pub transport_hold: bool,
}

impl Faults {
    fn validate(self) -> Result<(), String> {
        if !self.bias_pa.is_finite() || self.stuck_pa.is_some_and(|x| !x.is_finite()) {
            return Err("Nonfinite pressure-channel fault".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Quality {
    Value(f64),
    BelowRange { bound_pa: f64 },
    AboveRange { bound_pa: f64 },
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Delivered {
    pub acquired_at_s: f64,
    pub delivered_at_s: f64,
    pub quality: Quality,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Acquisition {
    config: Config,
    epoch_s: f64,
    next_tick: u64,
    last_time_s: f64,
    pending: Option<Delivered>,
    delivered: Option<Delivered>,
    available: bool,
}

impl Acquisition {
    pub fn new(config: Config, epoch_s: f64) -> Result<Self, String> {
        config.validate()?;
        if !epoch_s.is_finite() || epoch_s < 0. || epoch_s + config.sample_s <= epoch_s {
            return Err("Invalid pressure-channel acquisition epoch".into());
        }
        Ok(Self {
            config,
            epoch_s,
            next_tick: 0,
            last_time_s: epoch_s,
            pending: None,
            delivered: None,
            available: false,
        })
    }

    fn tick_time(&self, tick: u64) -> Result<f64, String> {
        // Integer-indexed deadlines avoid accumulating a floating time step.
        let time = self.epoch_s + tick as f64 * self.config.sample_s;
        if !time.is_finite()
            || (tick > 0 && time <= self.epoch_s + (tick - 1) as f64 * self.config.sample_s)
        {
            return Err("Pressure-channel acquisition clock exhausted".into());
        }
        Ok(time)
    }

    pub fn next_event_s(&self) -> Result<f64, String> {
        self.tick_time(self.next_tick)
    }

    pub fn delivered(&self) -> Option<Delivered> {
        self.delivered.map(|sample| {
            if self.available {
                sample
            } else {
                Delivered {
                    quality: Quality::Unavailable,
                    ..sample
                }
            }
        })
    }

    /// Process a scheduled sample/delivery, or a support/fault change before
    /// it. A skipped sample is an error: the caller cannot replace its unknown
    /// old lag value with today's pressure. Repeated calls at one time do not
    /// duplicate acquisitions. Consumers execute after the same-time effects.
    pub fn process_due(
        &mut self,
        now_s: f64,
        lag_pa: f64,
        powered: bool,
        faults: Faults,
    ) -> Result<(), String> {
        faults.validate()?;
        let due = self.next_event_s()?;
        if !now_s.is_finite() || !lag_pa.is_finite() || now_s < self.last_time_s || now_s > due {
            return Err("Invalid or skipped pressure-channel acquisition time".into());
        }
        // Calculate all potentially refusing work before mutating retained
        // state. A failed acquisition cannot advance clocks or erase history.
        let advance = now_s == due;
        let new_pending = if advance && powered && !faults.transport_hold {
            let next = self
                .next_tick
                .checked_add(1)
                .ok_or("Pressure-channel acquisition tick overflow")?;
            Some(Delivered {
                acquired_at_s: now_s,
                delivered_at_s: self.tick_time(next)?,
                quality: self.config.sample(lag_pa, faults)?,
            })
        } else {
            None
        };
        let next_tick = if advance {
            self.next_tick
                .checked_add(1)
                .ok_or("Pressure-channel acquisition tick overflow")?
        } else {
            self.next_tick
        };
        if advance {
            self.tick_time(next_tick)?;
        }
        if advance
            && powered
            && !faults.transport_hold
            && self
                .pending
                .is_some_and(|sample| sample.delivered_at_s != now_s)
        {
            return Err("Pressure-channel pending delivery clock mismatch".into());
        }

        if !powered {
            self.pending = None;
            // Lost electronics acquired nothing: preserve actual old sample
            // timestamps, or None when no sample was ever delivered.
            self.available = false;
        } else if faults.transport_hold {
            self.pending = None;
        } else if advance {
            if let Some(sample) = self.pending.take() {
                self.delivered = Some(sample);
                self.available = true;
            }
        }
        if advance {
            self.pending = new_pending;
        }
        self.next_tick = next_tick;
        self.last_time_s = now_s;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            lag_s: 0.2,
            min_pa: 0.,
            max_pa: 20e6,
            quantum_pa: 1000.,
            sample_s: 0.1,
            transport_s: 0.1,
        }
    }
    fn tick(a: &mut Acquisition, p: f64) {
        a.process_due(a.next_event_s().unwrap(), p, true, Faults::default())
            .unwrap();
    }
    #[test]
    fn exact_constant_linear_response_and_power_restoration() {
        let c = config();
        let actual = c
            .advance_polynomial(100_000., 0.1, &[105_000.], true)
            .unwrap();
        let expected = 105_000. - 5000. * (-0.5f64).exp();
        assert!((actual - expected).abs() < 1e-10);
        let slope = 2000.;
        let actual = c
            .advance_polynomial(100_000., 0.3, &[100_000., slope], true)
            .unwrap();
        let expected = 100_000. + slope * (0.3 - c.lag_s * (1. - (-1.5f64).exp()));
        assert!((actual - expected).abs() < 1e-10);
        let retained = c
            .advance_polynomial(actual, 10., &[200_000.], false)
            .unwrap();
        assert_eq!(actual, retained);
        let restored = c
            .advance_polynomial(retained, 0.1, &[200_000.], true)
            .unwrap();
        assert!(restored > retained && restored < 200_000.);
    }
    fn translated(d: &[f64], t: f64) -> Vec<f64> {
        (0..d.len())
            .map(|k| {
                let mut factor = 1.;
                let mut sum = d[k];
                for j in k + 1..d.len() {
                    factor *= t / (j - k) as f64;
                    sum += d[j] * factor;
                }
                sum
            })
            .collect()
    }
    #[test]
    fn quintic_matches_independent_particular_solution_and_translated_partition() {
        let c = config();
        let d = [100_000., 2000., -400., 70., -10., 2.];
        let x0 = 99_000.;
        let particular = |ds: &[f64]| {
            ds.iter()
                .enumerate()
                .map(|(k, v)| v * (-c.lag_s).powi(k as i32))
                .sum::<f64>()
        };
        for dt in [0.01, 0.2, 0.201, 0.3, 1., 10.] {
            let expected =
                particular(&translated(&d, dt)) + (x0 - particular(&d)) * (-dt / c.lag_s).exp();
            let actual = c.advance_polynomial(x0, dt, &d, true).unwrap();
            assert!(
                (actual - expected).abs() < 1e-8,
                "dt={dt}: {actual}/{expected}"
            );
            let first = c.advance_polynomial(x0, dt * 0.37, &d, true).unwrap();
            let split = c
                .advance_polynomial(first, dt * 0.63, &translated(&d, dt * 0.37), true)
                .unwrap();
            assert!((actual - split).abs() < 1e-8, "partition at{dt}");
        }
    }
    #[test]
    fn tiny_and_long_intervals_do_not_cancel_or_hold_the_input() {
        let c = config();
        let dt = 1e-12;
        let actual = c.advance_polynomial(0., dt, &[0., 1.], true).unwrap();
        let expected = dt * dt / (2. * c.lag_s) * (1. - dt / (3. * c.lag_s));
        assert!((actual / expected - 1.).abs() < 1e-14);
        assert_eq!(c.advance_polynomial(10., 0., &[1.], true).unwrap(), 10.);
        assert_eq!(c.advance_polynomial(0., 1e6, &[3.], true).unwrap(), 3.);
        let ramp = c.advance_polynomial(0., 1e6, &[0., 1.], true).unwrap();
        assert!((ramp - (1e6 - c.lag_s)).abs() < 1e-9);
        for d in [vec![], vec![1.; 7], vec![f64::NAN]] {
            assert!(c.advance_polynomial(0., 1., &d, true).is_err());
        }
    }
    #[test]
    fn fresh_start_waits_for_real_acquisition_and_transport() {
        let mut a = Acquisition::new(config(), 0.).unwrap();
        assert_eq!(a.delivered(), None);
        tick(&mut a, 15e6 + 500.);
        assert_eq!(a.delivered(), None);
        tick(&mut a, 16e6);
        assert_eq!(
            a.delivered(),
            Some(Delivered {
                acquired_at_s: 0.,
                delivered_at_s: 0.1,
                quality: Quality::Value(15_001_000.)
            })
        );
        tick(&mut a, 17e6);
        assert_eq!(a.delivered().unwrap().quality, Quality::Value(16e6));
    }
    #[test]
    fn range_is_assessed_before_rounding_and_bounds_are_not_exact_values() {
        let c = config();
        assert_eq!(
            c.sample(-0.1, Faults::default()).unwrap(),
            Quality::BelowRange { bound_pa: 0. }
        );
        assert_eq!(
            c.sample(20e6 + 0.1, Faults::default()).unwrap(),
            Quality::AboveRange { bound_pa: 20e6 }
        );
        assert_eq!(
            c.sample(20e6, Faults::default()).unwrap(),
            Quality::Value(20e6)
        );
        assert_eq!(
            c.sample(499., Faults::default()).unwrap(),
            Quality::Value(0.)
        );
        assert_eq!(
            c.sample(500., Faults::default()).unwrap(),
            Quality::Value(1000.)
        );
    }
    #[test]
    fn bias_and_fresh_stuck_do_not_use_hidden_truth_quality() {
        let mut a = Acquisition::new(config(), 0.).unwrap();
        let f = Faults {
            bias_pa: 1500.,
            stuck_pa: Some(12e6),
            transport_hold: false,
        };
        for _ in 0..3 {
            a.process_due(a.next_event_s().unwrap(), 19e6, true, f)
                .unwrap();
        }
        let d = a.delivered().unwrap();
        assert_eq!(d.quality, Quality::Value(12_002_000.));
        assert_eq!(d.acquired_at_s, 0.1);
    }
    #[test]
    fn finite_step_response_is_sampled_then_delivered_not_truth_at_delivery_time() {
        let c = config();
        let mut a = Acquisition::new(c, 0.).unwrap();
        tick(&mut a, 100_000.);
        // Analytic independently held-pressure response is a test oracle,
        // not the advancing plant path. The plant supplies its coupled lag.
        let lag_at_sample = 105_000. - 5_000. * (-0.1 / c.lag_s).exp();
        tick(&mut a, lag_at_sample);
        assert_eq!(a.delivered().unwrap().quality, Quality::Value(100_000.));
        tick(&mut a, 105_000. - 5_000. * (-0.2 / c.lag_s).exp());
        assert_eq!(
            a.delivered().unwrap(),
            Delivered {
                acquired_at_s: 0.1,
                delivered_at_s: 0.2,
                quality: Quality::Value(102_000.)
            }
        );
    }
    #[test]
    fn power_loss_invalidates_pending_and_restore_does_not_retimestamp_old_value() {
        let mut a = Acquisition::new(config(), 0.).unwrap();
        tick(&mut a, 15e6);
        a.process_due(0.05, 15e6, false, Faults::default()).unwrap();
        assert_eq!(a.delivered(), None);
        a.process_due(0.075, 15e6, true, Faults::default()).unwrap();
        assert_eq!(a.delivered(), None);
        tick(&mut a, 16e6);
        assert_eq!(a.delivered(), None);
        tick(&mut a, 17e6);
        assert_eq!(
            a.delivered().unwrap(),
            Delivered {
                acquired_at_s: 0.1,
                delivered_at_s: 0.2,
                quality: Quality::Value(16e6)
            }
        );
    }
    #[test]
    fn transport_hold_retains_original_age_and_discards_old_backlog() {
        let mut a = Acquisition::new(config(), 0.).unwrap();
        tick(&mut a, 15e6);
        tick(&mut a, 16e6);
        let first = a.delivered();
        a.process_due(
            0.15,
            17e6,
            true,
            Faults {
                transport_hold: true,
                ..Faults::default()
            },
        )
        .unwrap();
        a.process_due(
            a.next_event_s().unwrap(),
            18e6,
            true,
            Faults {
                transport_hold: true,
                ..Faults::default()
            },
        )
        .unwrap();
        assert_eq!(a.delivered(), first);
        a.process_due(0.25, 19e6, true, Faults::default()).unwrap();
        tick(&mut a, 19e6);
        assert_eq!(a.delivered(), first);
        tick(&mut a, 20e6);
        assert_eq!(a.delivered().unwrap().acquired_at_s, 0.1 * 3.);
        assert_eq!(a.delivered().unwrap().quality, Quality::Value(19e6));
    }
    #[test]
    fn power_loss_retains_actual_last_acquisition_timestamp() {
        let mut a = Acquisition::new(config(), 0.).unwrap();
        tick(&mut a, 15e6);
        tick(&mut a, 16e6);
        a.process_due(0.15, 17e6, false, Faults::default()).unwrap();
        assert_eq!(
            a.delivered(),
            Some(Delivered {
                acquired_at_s: 0.,
                delivered_at_s: 0.1,
                quality: Quality::Unavailable
            })
        );
        a.process_due(0.175, 17e6, true, Faults::default()).unwrap();
        assert_eq!(a.delivered().unwrap().acquired_at_s, 0.);
        assert_eq!(a.delivered().unwrap().quality, Quality::Unavailable);
    }
    #[test]
    fn exact_tick_schedule_copy_and_no_duplicate_sample() {
        let mut a = Acquisition::new(config(), 3.).unwrap();
        tick(&mut a, 1e6);
        let mut b = a.clone();
        a.process_due(3., 2e6, true, Faults::default()).unwrap();
        for _ in 0..1000 {
            tick(&mut a, 2e6);
            tick(&mut b, 2e6);
        }
        assert_eq!(a, b);
        assert_eq!(a.next_event_s().unwrap(), 3. + 1001. * 0.1);
    }
    #[test]
    fn skipped_or_reversed_time_and_failed_input_leave_state_unchanged() {
        let mut a = Acquisition::new(config(), 0.).unwrap();
        let old = a.clone();
        assert!(a.process_due(0.1, 15e6, true, Faults::default()).is_err());
        assert_eq!(a, old);
        assert!(a
            .process_due(0., f64::NAN, true, Faults::default())
            .is_err());
        assert_eq!(a, old);
        tick(&mut a, 15e6);
        let old = a.clone();
        assert!(a.process_due(-0.1, 15e6, true, Faults::default()).is_err());
        assert!(a
            .process_due(
                0.1,
                15e6,
                true,
                Faults {
                    bias_pa: f64::NAN,
                    ..Faults::default()
                }
            )
            .is_err());
        assert_eq!(a, old);
    }
    #[test]
    fn invalid_configs_and_unresolvable_clock_refuse() {
        for c in [
            Config {
                lag_s: 0.,
                ..config()
            },
            Config {
                transport_s: 0.2,
                ..config()
            },
            Config {
                max_pa: 0.,
                ..config()
            },
            Config {
                quantum_pa: f64::INFINITY,
                ..config()
            },
        ] {
            assert!(Acquisition::new(c, 0.).is_err());
        }
        assert!(Acquisition::new(config(), 1e18).is_err());
        assert!(config()
            .advance_polynomial(f64::INFINITY, 0., &[0.], true)
            .is_err());
        assert!(config().advance_polynomial(0., -1., &[0.], true).is_err());
    }
}

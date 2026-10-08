//! Original LD-01 acquired PZR pressure protective decisions, offline only.
//! Powered division memory and requests are NOT contacts, reactor insertion,
//! CMT delivery or heater isolation. Supplies/configuration are explicit inputs
//! supplied by the integrating owner, not inferred from plant or fault truth.
use crate::pressure_channel::{Delivered, Quality};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Configuration {
    Cold,
    Power,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    HighPressure,
    LowPressure,
    Unavailable,
}
impl Cause {
    fn index(self) -> usize {
        match self {
            Self::HighPressure => 0,
            Self::LowPressure => 1,
            Self::Unavailable => 2,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    pub maximum_age_s: f64,
    pub recovery_s: f64,
    pub high_pa: f64,
    pub high_qualification_s: f64,
    pub low_pa: f64,
    pub low_qualification_s: f64,
    pub unavailable_qualification_s: f64,
    pub reset_low_pa: f64,
    pub reset_high_pa: f64,
    pub reset_qualification_s: f64,
}
impl Settings {
    fn validate(self) -> Result<(), String> {
        let fields = [
            self.maximum_age_s,
            self.recovery_s,
            self.high_pa,
            self.high_qualification_s,
            self.low_pa,
            self.low_qualification_s,
            self.unavailable_qualification_s,
            self.reset_low_pa,
            self.reset_high_pa,
            self.reset_qualification_s,
        ];
        if fields.iter().any(|v| !v.is_finite() || *v <= 0.)
            || !(self.low_pa < self.reset_low_pa
                && self.reset_low_pa < self.reset_high_pa
                && self.reset_high_pa < self.high_pa)
        {
            return Err("Invalid selected PZR pressure protection settings".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Inputs {
    pub readings: [Option<Delivered>; 3],
    /// Actual instrument supply boundary, also before the first delivery.
    pub channel_powered: [bool; 3],
    pub division_powered: [bool; 3],
    /// Already accepted configuration, not a request or admission permission.
    pub accepted_configuration: [Configuration; 3],
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Division {
    usable_since: [Option<f64>; 3],
    seen_usable: [bool; 3],
    recovery_required: [bool; 3],
    condition_since: [Option<f64>; 3],
    reset_since: Option<f64>,
    causes: [Option<f64>; 3],
    powered: bool,
    configuration: Configuration,
    current: [bool; 3],
}
#[derive(Clone, Debug, PartialEq)]
pub struct Protection {
    settings: Settings,
    divisions: [Division; 3],
    last_time_s: Option<f64>,
    readings: [Option<Delivered>; 3],
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Assessment {
    /// First actual acceptance time per division and named cause.
    pub causes: [[Option<f64>; 3]; 3],
    /// Accepted powered software demand only; no physical delivery is claimed.
    pub trip_requests: [bool; 3],
    pub cmt_requests: [bool; 3],
    pub heater_isolation_requests: [bool; 3],
    pub qualified_channels: [[bool; 3]; 3],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetOutcome {
    Cleared,
    NotLatched,
    DivisionUnpowered,
    EvidenceNotQualified,
    InitiationActive,
    /// COLD also needs LT/HOT/temperature/relief-lineup evidence, not PT alone.
    ColdResetUnsupported,
}
fn since(condition: bool, timer: &mut Option<f64>, now: f64) {
    if condition {
        timer.get_or_insert(now);
    } else {
        *timer = None;
    }
}
fn elapsed(timer: Option<f64>, interval: f64, now: f64) -> bool {
    timer.is_some_and(|start| now >= start + interval)
}
fn usable(reading: Option<Delivered>, now: f64, maximum_age: f64) -> bool {
    let Some(r) = reading else { return false };
    if !r.acquired_at_s.is_finite()
        || !r.delivered_at_s.is_finite()
        || r.acquired_at_s < 0.
        || r.delivered_at_s < 0.
        || r.acquired_at_s > r.delivered_at_s
        || r.delivered_at_s > now
        || now > r.acquired_at_s + maximum_age
    {
        return false;
    }
    match r.quality {
        Quality::Value(v) => v.is_finite(),
        Quality::BelowRange { bound_pa } | Quality::AboveRange { bound_pa } => bound_pa.is_finite(),
        Quality::Unavailable => false,
    }
}
fn high(reading: Delivered, threshold: f64) -> bool {
    match reading.quality {
        Quality::Value(v) => v >= threshold,
        Quality::AboveRange { bound_pa } => bound_pa >= threshold,
        _ => false,
    }
}
fn low(reading: Delivered, threshold: f64) -> bool {
    match reading.quality {
        Quality::Value(v) => v <= threshold,
        Quality::BelowRange { bound_pa } => bound_pa <= threshold,
        _ => false,
    }
}
impl Protection {
    pub fn new(settings: Settings) -> Result<Self, String> {
        settings.validate()?;
        Ok(Self {
            settings,
            divisions: [Division {
                usable_since: [None; 3],
                seen_usable: [false; 3],
                recovery_required: [false; 3],
                condition_since: [None; 3],
                reset_since: None,
                causes: [None; 3],
                powered: false,
                configuration: Configuration::Cold,
                current: [false; 3],
            }; 3],
            last_time_s: None,
            readings: [None; 3],
        })
    }
    /// Evaluate at every actual delivered-input/support/configuration change
    /// and at `next_deadline_s()`. Timers use simulation time, not UI refresh.
    /// This function consumes only acquired evidence, never exact pressure.
    pub fn advance(&mut self, now: f64, input: Inputs) -> Result<Assessment, String> {
        if !now.is_finite() || now < 0. || self.last_time_s.is_some_and(|t| now < t) {
            return Err("PZR pressure decision time must be finite and monotone".into());
        }
        if self
            .next_deadline_s()
            .is_some_and(|deadline| now > deadline)
        {
            return Err(
                "PZR pressure decision skipped a required qualification/freshness boundary".into(),
            );
        }
        for reading in input.readings.iter().flatten() {
            if !reading.acquired_at_s.is_finite()
                || !reading.delivered_at_s.is_finite()
                || reading.acquired_at_s < 0.
                || reading.delivered_at_s < reading.acquired_at_s
                || reading.delivered_at_s > now
                || match reading.quality {
                    Quality::Value(v) => !v.is_finite(),
                    Quality::BelowRange { bound_pa } | Quality::AboveRange { bound_pa } => {
                        !bound_pa.is_finite()
                    }
                    Quality::Unavailable => false,
                }
            {
                return Err("Malformed delivered PZR pressure evidence".into());
            }
        }
        self.last_time_s = Some(now);
        self.readings = input.readings;
        let s = self.settings;
        let availability = std::array::from_fn::<_, 3, _>(|j| {
            input.channel_powered[j] && usable(input.readings[j], now, s.maximum_age_s)
        });
        let mut qualified_channels = [[false; 3]; 3];
        for (k, d) in self.divisions.iter_mut().enumerate() {
            d.powered = input.division_powered[k];
            d.configuration = input.accepted_configuration[k];
            for (j, available) in availability.iter().enumerate() {
                since(d.powered && *available, &mut d.usable_since[j], now);
                if !d.powered || !*available {
                    // Pending first acquisition is not recovery from failure.
                    // A known lost supply or delivered unusable report is.
                    if !d.powered
                        || !input.channel_powered[j]
                        || d.seen_usable[j]
                        || input.readings[j].is_some()
                    {
                        d.recovery_required[j] = true;
                    }
                } else {
                    d.seen_usable[j] = true;
                    qualified_channels[k][j] =
                        !d.recovery_required[j] || elapsed(d.usable_since[j], s.recovery_s, now);
                    if qualified_channels[k][j] {
                        d.recovery_required[j] = false;
                    }
                }
            }
            let qualified = qualified_channels[k];
            let high_votes = (0..3)
                .filter(|j| qualified[*j] && input.readings[*j].is_some_and(|r| high(r, s.high_pa)))
                .count();
            let low_votes = (0..3)
                .filter(|j| qualified[*j] && input.readings[*j].is_some_and(|r| low(r, s.low_pa)))
                .count();
            let conditions = [
                d.powered && high_votes >= 2,
                d.powered && d.configuration == Configuration::Power && low_votes >= 2,
                d.powered && qualified.iter().filter(|v| **v).count() < 2,
            ];
            d.current = conditions;
            for j in 0..3 {
                since(conditions[j], &mut d.condition_since[j], now);
                let duration = [
                    s.high_qualification_s,
                    s.low_qualification_s,
                    s.unavailable_qualification_s,
                ][j];
                if elapsed(d.condition_since[j], duration, now) {
                    d.causes[j].get_or_insert(now);
                }
            }
            let reset_evidence = d.powered
                && d.configuration == Configuration::Power
                && (0..3).all(|j| {
                    qualified[j]
                        && matches!(input.readings[j],
                    Some(Delivered { quality: Quality::Value(v), .. })
                    if v >= s.reset_low_pa && v <= s.reset_high_pa)
                });
            since(reset_evidence, &mut d.reset_since, now);
        }
        Ok(self.assessment(qualified_channels))
    }
    fn assessment(&self, qualified_channels: [[bool; 3]; 3]) -> Assessment {
        let causes = self.divisions.map(|d| d.causes);
        let trip_requests = self
            .divisions
            .map(|d| d.powered && d.causes.iter().any(Option::is_some));
        let cmt_requests = self.divisions.map(|d| d.powered && d.causes[1].is_some());
        let heater_isolation_requests = self
            .divisions
            .map(|d| d.powered && (d.causes[0].is_some() || d.causes[2].is_some()));
        Assessment {
            causes,
            trip_requests,
            cmt_requests,
            heater_isolation_requests,
            qualified_channels,
        }
    }
    /// Explicit cause-only reset at the latest evaluated boundary. No request
    /// can clear a division latch, injection, another cause or an actuator.
    pub fn reset_cause(
        &mut self,
        now: f64,
        division: usize,
        cause: Cause,
    ) -> Result<ResetOutcome, String> {
        if self.last_time_s != Some(now) || division >= 3 {
            return Err("Pressure cause reset requires current evaluated division".into());
        }
        let d = &mut self.divisions[division];
        let j = cause.index();
        if d.causes[j].is_none() {
            return Ok(ResetOutcome::NotLatched);
        }
        if !d.powered {
            return Ok(ResetOutcome::DivisionUnpowered);
        }
        if d.current[j] || d.causes[j] == Some(now) {
            return Ok(ResetOutcome::InitiationActive);
        }
        if d.configuration == Configuration::Cold {
            return Ok(ResetOutcome::ColdResetUnsupported);
        }
        if !elapsed(d.reset_since, self.settings.reset_qualification_s, now) {
            return Ok(ResetOutcome::EvidenceNotQualified);
        }
        d.causes[j] = None;
        Ok(ResetOutcome::Cleared)
    }
    /// Earliest pending physical-evidence age or qualification boundary. There
    /// is no maximum physics step: this belongs to the accepted-time observer.
    pub fn next_deadline_s(&self) -> Option<f64> {
        let now = self.last_time_s?;
        let s = self.settings;
        let mut next: Option<f64> = None;
        let mut consider = |t: f64| {
            if t > now && t.is_finite() {
                next = Some(next.map_or(t, |x| x.min(t)));
            }
        };
        for r in self.readings.iter().flatten() {
            if usable(Some(*r), now, s.maximum_age_s) {
                // Age exactly at the limit remains usable; expire at the next
                // representable time rather than invent a physical grace band.
                consider((r.acquired_at_s + s.maximum_age_s).next_up());
            }
        }
        for d in &self.divisions {
            for (j, start) in d.usable_since.iter().enumerate() {
                if d.recovery_required[j] {
                    if let Some(t) = start {
                        consider(t + s.recovery_s);
                    }
                }
            }
            for (j, start) in d.condition_since.iter().enumerate() {
                if let Some(t) = start {
                    consider(
                        t + [
                            s.high_qualification_s,
                            s.low_qualification_s,
                            s.unavailable_qualification_s,
                        ][j],
                    );
                }
            }
            if let Some(t) = d.reset_since {
                consider(t + s.reset_qualification_s);
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        Settings {
            maximum_age_s: 0.3,
            recovery_s: 1.,
            high_pa: 15.5e6,
            high_qualification_s: 0.2,
            low_pa: 13e6,
            low_qualification_s: 0.5,
            unavailable_qualification_s: 1.,
            reset_low_pa: 13.5e6,
            reset_high_pa: 15.2e6,
            reset_qualification_s: 5.,
        }
    }
    fn input(t: f64, values: [Quality; 3], config: Configuration) -> Inputs {
        Inputs {
            readings: values.map(|quality| {
                Some(Delivered {
                    quality,
                    acquired_at_s: t,
                    delivered_at_s: t,
                })
            }),
            division_powered: [true; 3],
            channel_powered: [true; 3],
            accepted_configuration: [config; 3],
        }
    }
    fn value(v: f64) -> [Quality; 3] {
        [Quality::Value(v); 3]
    }
    fn step(
        p: &mut Protection,
        end: f64,
        values: [Quality; 3],
        config: Configuration,
    ) -> Assessment {
        // Actual fresh delivery boundaries plus every internal deadline.
        loop {
            let now = p.last_time_s.unwrap_or(0.);
            if now >= end {
                return p.advance(end, input(end, values, config)).unwrap();
            }
            let t = p.next_deadline_s().unwrap_or(end).min((now + 0.1).min(end));
            p.advance(t, input(t, values, config)).unwrap();
        }
    }
    #[test]
    fn fresh_cold_qualifies_without_a_false_low_pressure_trip() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(0.26e6), Configuration::Cold))
            .unwrap();
        let a = step(&mut p, 3., value(0.26e6), Configuration::Cold);
        assert_eq!(a.causes, [[None; 3]; 3]);
        assert_eq!(a.qualified_channels, [[true; 3]; 3]);
        assert_eq!(a.trip_requests, [false; 3]);
    }
    #[test]
    fn high_vote_requires_two_then_actual_duration_and_latches() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(14e6), Configuration::Power))
            .unwrap();
        step(&mut p, 1.1, value(14e6), Configuration::Power);
        let one = [
            Quality::Value(16e6),
            Quality::Value(14e6),
            Quality::Unavailable,
        ];
        step(&mut p, 2., one, Configuration::Power);
        assert!(p.divisions.iter().all(|d| d.causes[0].is_none()));
        let two = [Quality::Value(16e6); 3];
        p.advance(2., input(2., two, Configuration::Power)).unwrap();
        let before = step(&mut p, 2.19, two, Configuration::Power);
        assert!(before.causes.iter().all(|d| d[0].is_none()));
        let a = step(&mut p, 2.2, two, Configuration::Power);
        assert_eq!(a.causes[0][0], Some(2.2));
        assert_eq!(a.heater_isolation_requests, [true; 3]);
        assert_eq!(a.cmt_requests, [false; 3]);
        step(&mut p, 3., value(14e6), Configuration::Power);
        assert_eq!(p.divisions[0].causes[0], Some(2.2));
    }
    #[test]
    fn range_bounds_vote_conclusively_but_do_not_supply_reset_values() {
        let mut p = Protection::new(settings()).unwrap();
        let above = [Quality::AboveRange { bound_pa: 20e6 }; 3];
        p.advance(0., input(0., above, Configuration::Power))
            .unwrap();
        step(&mut p, 1.2, above, Configuration::Power);
        assert_eq!(p.divisions[0].causes[0], Some(0.2));
        assert_eq!(
            p.reset_cause(1.2, 0, Cause::HighPressure).unwrap(),
            ResetOutcome::InitiationActive
        );
        let below = [Quality::BelowRange { bound_pa: 0. }; 3];
        step(&mut p, 2., below, Configuration::Power);
        assert!(p.divisions[0].causes[1].is_some());
        assert!(p.divisions[0].reset_since.is_none());
    }
    #[test]
    fn explicit_hot_reset_clears_only_named_cause_and_cold_reset_is_unsupported() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(12e6), Configuration::Power))
            .unwrap();
        step(&mut p, 2., value(12e6), Configuration::Power);
        assert!(p.divisions[0].causes[1].is_some());
        p.advance(2., input(2., value(14e6), Configuration::Power))
            .unwrap();
        step(&mut p, 6.99, value(14e6), Configuration::Power);
        assert_eq!(
            p.reset_cause(6.99, 0, Cause::LowPressure).unwrap(),
            ResetOutcome::EvidenceNotQualified
        );
        step(&mut p, 7., value(14e6), Configuration::Power);
        assert_eq!(
            p.reset_cause(7., 0, Cause::LowPressure).unwrap(),
            ResetOutcome::Cleared
        );
        assert!(p.divisions[1].causes[1].is_some());
        let accepted = p
            .advance(7., input(7., value(14e6), Configuration::Cold))
            .unwrap();
        // The input is already accepted configuration, not a modeled transfer.
        // Its cold applicability suppresses NEW low initiation, not old cause.
        assert!(accepted.cmt_requests[1]);
        assert_eq!(
            p.reset_cause(7., 1, Cause::LowPressure).unwrap(),
            ResetOutcome::ColdResetUnsupported
        );
    }
    #[test]
    fn power_loss_preserves_causes_but_cannot_evaluate_or_send_a_demand() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(16e6), Configuration::Power))
            .unwrap();
        step(&mut p, 1.2, value(16e6), Configuration::Power);
        let mut i = input(1.2, value(16e6), Configuration::Power);
        i.division_powered[0] = false;
        let a = p.advance(1.2, i).unwrap();
        assert_eq!(a.trip_requests, [false, true, true]);
        assert_eq!(a.causes[0][0], Some(0.2));
        assert_eq!(a.qualified_channels[0], [false; 3]);
        assert_eq!(
            p.reset_cause(1.2, 0, Cause::HighPressure).unwrap(),
            ResetOutcome::DivisionUnpowered
        );
    }
    #[test]
    fn age_future_time_and_missing_evidence_never_vote_as_zero() {
        let r = Delivered {
            acquired_at_s: 1.,
            delivered_at_s: 1.1,
            quality: Quality::Value(12e6),
        };
        assert!(usable(Some(r), 1.3, 0.3));
        assert!(!usable(Some(r), 1.3f64.next_up(), 0.3));
        assert!(!usable(Some(r), 1.09, 0.3));
        assert!(!usable(
            Some(Delivered {
                acquired_at_s: -0.1,
                delivered_at_s: 0.,
                quality: Quality::Value(12e6)
            }),
            0.,
            0.3
        ));
        let mut p = Protection::new(settings()).unwrap();
        p.advance(
            0.,
            input(0., [Quality::Unavailable; 3], Configuration::Power),
        )
        .unwrap();
        step(&mut p, 1., [Quality::Unavailable; 3], Configuration::Power);
        assert_eq!(p.divisions[0].causes, [None, None, Some(1.)]);
        assert_eq!(p.assessment([[false; 3]; 3]).cmt_requests, [false; 3]);
    }
    #[test]
    fn first_real_delivery_is_not_recovery_or_fictitious_prior_history() {
        let mut p = Protection::new(settings()).unwrap();
        let mut pending = input(0., value(0.26e6), Configuration::Cold);
        pending.readings = [None; 3];
        let before = p.advance(0., pending).unwrap();
        assert_eq!(before.qualified_channels, [[false; 3]; 3]);
        let first = p
            .advance(0.1, input(0.1, value(0.26e6), Configuration::Cold))
            .unwrap();
        assert_eq!(first.qualified_channels, [[true; 3]; 3]);
        assert_eq!(p.divisions[0].usable_since, [Some(0.1); 3]);
        let final_state = step(&mut p, 2., value(0.26e6), Configuration::Cold);
        assert_eq!(final_state.causes, [[None; 3]; 3]);
    }
    #[test]
    fn actual_channel_transport_drives_first_qualification_and_plausible_fault_request() {
        use crate::pressure_channel::{Acquisition, Config, Faults};
        let config = Config {
            lag_s: 0.2,
            min_pa: 0.,
            max_pa: 20e6,
            quantum_pa: 1000.,
            sample_s: 0.1,
            transport_s: 0.1,
        };
        for bias in [0., 15.34e6] {
            let mut channels =
                std::array::from_fn::<_, 3, _>(|_| Acquisition::new(config, 0.).unwrap());
            let mut p = Protection::new(settings()).unwrap();
            let mut assessment = None;
            for tick in 0..=20 {
                let t = tick as f64 * 0.1;
                for channel in &mut channels {
                    channel
                        .process_due(
                            t,
                            0.26e6,
                            true,
                            Faults {
                                bias_pa: bias,
                                ..Faults::default()
                            },
                        )
                        .unwrap();
                }
                let mut i = input(t, value(0.26e6), Configuration::Cold);
                i.readings = std::array::from_fn(|j| channels[j].delivered());
                let a = p.advance(t, i).unwrap();
                if tick == 0 {
                    assert_eq!(a.qualified_channels, [[false; 3]; 3]);
                }
                if tick == 1 {
                    assert_eq!(a.qualified_channels, [[true; 3]; 3]);
                }
                assessment = Some(a);
            }
            let a = assessment.unwrap();
            assert!(a.causes.iter().all(|d| d[2].is_none()));
            if bias == 0. {
                assert_eq!(a.trip_requests, [false; 3]);
            } else {
                assert_eq!(a.trip_requests, [true; 3]);
                assert_eq!(a.causes[0][0], Some(0.1 + 0.2));
            }
        }
    }
    #[test]
    fn malformed_delivered_record_refuses_before_mutating_retained_history() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(14e6), Configuration::Power))
            .unwrap();
        for (acquired, delivered, quality) in [
            (-0.1, 0., Quality::Value(14e6)),
            (0., -0.1, Quality::Value(14e6)),
            (0.2, 0.1, Quality::Value(14e6)),
            (0.1, 0.2, Quality::Value(14e6)),
            (f64::NAN, 0.1, Quality::Value(14e6)),
            (0., 0.1, Quality::Value(f64::NAN)),
        ] {
            let before = p.clone();
            let mut i = input(0.1, value(14e6), Configuration::Power);
            i.readings[0] = Some(Delivered {
                acquired_at_s: acquired,
                delivered_at_s: delivered,
                quality,
            });
            assert!(p.advance(0.1, i).is_err());
            assert_eq!(p, before);
        }
    }
    #[test]
    fn known_initial_supply_failure_requires_recovery_and_never_clears_cause() {
        let mut p = Protection::new(settings()).unwrap();
        let mut pending = input(0., value(0.26e6), Configuration::Cold);
        pending.readings = [None; 3];
        pending.channel_powered = [false; 3];
        p.advance(0., pending).unwrap();
        let first = p
            .advance(0.1, input(0.1, value(0.26e6), Configuration::Cold))
            .unwrap();
        assert_eq!(first.qualified_channels, [[false; 3]; 3]);
        let late = step(&mut p, 1.1, value(0.26e6), Configuration::Cold);
        assert_eq!(late.qualified_channels, [[true; 3]; 3]);
        assert_eq!(late.causes[0][2], Some(1.));
        assert_eq!(late.cmt_requests, [false; 3]);
        assert_eq!(
            p.reset_cause(1.1, 0, Cause::Unavailable).unwrap(),
            ResetOutcome::ColdResetUnsupported
        );
    }
    #[test]
    fn late_first_delivery_cannot_erase_a_real_unavailable_initiation() {
        let mut p = Protection::new(settings()).unwrap();
        let mut pending = input(0., value(0.26e6), Configuration::Cold);
        pending.readings = [None; 3];
        p.advance(0., pending).unwrap();
        let a = p.advance(1., pending).unwrap();
        assert_eq!(a.causes[0][2], Some(1.));
        let b = p
            .advance(1.1, input(1.1, value(0.26e6), Configuration::Cold))
            .unwrap();
        assert_eq!(b.qualified_channels, [[true; 3]; 3]);
        assert_eq!(b.causes[0][2], Some(1.));
        assert_eq!(b.trip_requests, [true; 3]);
        assert_eq!(b.cmt_requests, [false; 3]);
    }
    #[test]
    fn copy_mid_recovery_preserves_real_loss_and_requalification_boundaries() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(14e6), Configuration::Power))
            .unwrap();
        step(&mut p, 1., value(14e6), Configuration::Power);
        p.advance(
            1.,
            input(1., [Quality::Unavailable; 3], Configuration::Power),
        )
        .unwrap();
        p.advance(1.1, input(1.1, value(14e6), Configuration::Power))
            .unwrap();
        step(&mut p, 1.5, value(14e6), Configuration::Power);
        let mut copy = p.clone();
        let a = step(&mut p, 2.1, value(14e6), Configuration::Power);
        step(&mut copy, 1.55, value(14e6), Configuration::Power);
        let b = step(&mut copy, 2.1, value(14e6), Configuration::Power);
        assert_eq!(a, b);
        assert_eq!(p, copy);
        assert_eq!(a.causes[0][2], Some(2.));
        assert_eq!(a.qualified_channels, [[true; 3]; 3]);
    }
    #[test]
    fn skipped_deadline_rejects_and_clone_retains_exact_qualification_history() {
        let mut p = Protection::new(settings()).unwrap();
        p.advance(0., input(0., value(14e6), Configuration::Power))
            .unwrap();
        assert!(
            p.advance(1.1, input(1.1, value(14e6), Configuration::Power))
                .is_err()
        );
        step(&mut p, 1.1, value(14e6), Configuration::Power);
        p.advance(1.1, input(1.1, value(16e6), Configuration::Power))
            .unwrap();
        let mut copy = p.clone();
        let a = step(&mut p, 3., value(16e6), Configuration::Power);
        step(&mut copy, 1.15, value(16e6), Configuration::Power);
        let b = step(&mut copy, 3., value(16e6), Configuration::Power);
        // Same change boundary must be applied in both copies before differing
        // observation partitions. Repeated evaluation at one time accrues none.
        assert_eq!(a, b);
        assert_eq!(p, copy);
        assert!(
            p.advance(2., input(2., value(14e6), Configuration::Power))
                .is_err()
        );
    }
}

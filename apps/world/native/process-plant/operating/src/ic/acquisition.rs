//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#healthy-acquired-channel-transport
//! Acquisition: a retained first-order electronic response continued
//! exactly under each accepted step's polynomial of the observed quantity
//! (independent of the plant's Newton and error test, no physical step cap),
//! then electronic bias or fresh-stuck output, range assessment before
//! nearest-quantum rounding, sampling at frame instants and transport by
//! whole frames. Discrete state reports (the turbine controls' retained
//! trip) use the same sampling and transport without a response law.
//!
//! Power loss freezes the response, makes delivered evidence unavailable at
//! once and discards samples in flight; restoration needs a new acquisition.
//! A transport hold retains the old delivered sample with its acquisition
//! frame and discards in-flight samples; nothing held is replayed.
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): a real number as
/// its exact IEEE-754 bits, 16 hex digits (`joined::block::snapshot_time`).
pub fn snapshot_real(x: f64) -> Value {
    crate::joined::block::snapshot_time(Some(x))
}
/// The inverse of [`snapshot_real`]; anything else refuses.
pub fn restored_real(v: &Value, what: &str) -> Result<f64, String> {
    crate::joined::block::restored_time(v)
        .map_err(|e| format!("{what}: {e:?}"))?
        .ok_or_else(|| format!("{what}: a real number's bits, not null"))
}
/// An optional real number ([`snapshot_real`] or null).
pub fn restored_real_option(v: &Value, what: &str) -> Result<Option<f64>, String> {
    crate::joined::block::restored_time(v).map_err(|e| format!("{what}: {e:?}"))
}
/// The snapshot object `v` with exactly `keys`, refused otherwise.
pub fn snapshot_fields<'a>(
    v: &'a Value,
    owner: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    crate::joined::block::snapshot_object(v, owner, keys).map_err(|e| format!("{e:?}"))
}
/// A snapshot boolean, refused otherwise.
pub fn restored_bool(v: &Value, what: &str) -> Result<bool, String> {
    v.as_bool()
        .ok_or_else(|| format!("{what}: a boolean, not {v}"))
}
/// A snapshot frame index, refused otherwise.
pub fn restored_frame(v: &Value, what: &str) -> Result<u64, String> {
    v.as_u64()
        .ok_or_else(|| format!("{what}: a frame index, not {v}"))
}
/// An optional snapshot frame index.
pub fn restored_frame_option(v: &Value, what: &str) -> Result<Option<u64>, String> {
    match v {
        Value::Null => Ok(None),
        v => restored_frame(v, what).map(Some),
    }
}

/// Exact continuation over `dt` of `r' = (q - r) / lag` under the
/// polynomial `q(a + s) = Σ_j q_j s^j / j!`, `derivatives = [q_0, …, q_p]`
/// the raw derivatives at the interval start (`p <= 5`). Exact relative to
/// that polynomial; the integrator's polynomial is the accepted trajectory.
pub fn lag_continuation(
    response: f64,
    lag_s: f64,
    dt: f64,
    derivatives: &[f64],
) -> Result<f64, String> {
    if !(response.is_finite() && lag_s > 0. && lag_s.is_finite() && dt.is_finite() && dt >= 0.)
        || derivatives.is_empty()
        || derivatives.len() > 6
        || derivatives.iter().any(|v| !v.is_finite())
    {
        return Err(format!(
            "lag continuation: response {response}, lag {lag_s} s, dt {dt} s, {} derivatives",
            derivatives.len()
        ));
    }
    if dt == 0. {
        return Ok(response);
    }
    let z = dt / lag_s;
    // w_k = z ∫_0^1 exp(-z(1-u)) u^k du. For z <= 1 the alternating series
    // Σ_j (-1)^j z^(j+1) k!/(k+j+1)! (a fixed 24 terms reach far below
    // 1 ulp for k <= 5); for z > 1 the recurrence w_k = 1 - k w_{k-1} / z is
    // stable.
    let mut w = [0.; 6];
    w[0] = -(-z).exp_m1();
    for k in 1..derivatives.len() {
        w[k] = if z <= 1. {
            let mut term = z / (k + 1) as f64;
            let mut sum = term;
            for j in 0..24 {
                term *= -z / (k + j + 2) as f64;
                sum += term;
            }
            sum
        } else {
            1. - k as f64 / z * w[k - 1]
        };
    }
    let mut result = response + w[0] * (derivatives[0] - response);
    let mut power = 1.;
    for k in 1..derivatives.len() {
        power *= dt / k as f64;
        result += derivatives[k] * power * w[k];
    }
    if !result.is_finite() {
        return Err("lag continuation is not finite".into());
    }
    Ok(result)
}

/// The quantity itself at the end of `dt` under its polynomial (raw
/// derivatives at the interval start): the response of a channel with no
/// electronic lag of its own.
pub fn polynomial_at(dt: f64, derivatives: &[f64]) -> Result<f64, String> {
    if !(dt.is_finite() && dt >= 0.)
        || derivatives.is_empty()
        || derivatives.iter().any(|v| !v.is_finite())
    {
        return Err(format!(
            "polynomial value: dt {dt} s, {} derivatives",
            derivatives.len()
        ));
    }
    let (mut result, mut power) = (derivatives[0], 1.);
    for (k, d) in derivatives.iter().enumerate().skip(1) {
        power *= dt / k as f64;
        result += d * power;
    }
    Ok(result)
}

/// Selected analog channel: response lag, indicated span, quantum, the
/// band that establishes no sign, sampling and transport (units of its
/// quantity). `lag_s` zero is a channel whose response the plant owner
/// already holds as its own coordinate (the SG owner's continuous FT lags):
/// the acquisition adds no second lag. `None` (an explicit `null` in the packet) is a channel the
/// owners give no span, quantization or band in these units (the current
/// proxy's ratio form has no absolute span; SG NR has no quantization).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalogConfig {
    pub lag_s: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub quantum: Option<f64>,
    /// `|indication| <= band` establishes a bounded magnitude, no sign.
    pub indeterminate_band: Option<f64>,
    pub sample_s: f64,
    pub transport_s: f64,
}
impl AnalogConfig {
    pub fn validate(&self) -> Result<(), String> {
        let optional = [self.min, self.max, self.quantum, self.indeterminate_band];
        let bad = !(self.lag_s.is_finite()
            && self.lag_s >= 0.
            && self.sample_s.is_finite()
            && self.sample_s > 0.
            && self.transport_s.is_finite()
            && self.transport_s >= 0.)
            || optional.iter().flatten().any(|v| !v.is_finite())
            || matches!((self.min, self.max), (Some(a), Some(b)) if b <= a)
            || self.quantum.is_some_and(|q| q <= 0.)
            || matches!((self.min, self.max, self.quantum), (Some(a), Some(b), Some(q)) if q > b - a)
            || self.indeterminate_band.is_some_and(|b| b < 0.);
        if bad {
            return Err(format!("invalid analog channel {self:?}"));
        }
        Ok(())
    }
}

/// What one acquired sample establishes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Quality {
    Value(f64),
    /// The actual indication lies below this bound (the span's minimum).
    BelowRange(f64),
    /// The actual indication lies above this bound (the span's maximum).
    AboveRange(f64),
    /// The indication's magnitude is at most this bound; no sign is
    /// established (the main-loop FT's low-flow band).
    Indeterminate(f64),
}

impl Quality {
    /// S5 snapshot hook: `{"value" | "below" | "above" | "indeterminate": bits}`.
    pub fn snapshot(&self) -> Value {
        let (k, x) = match *self {
            Quality::Value(x) => ("value", x),
            Quality::BelowRange(x) => ("below", x),
            Quality::AboveRange(x) => ("above", x),
            Quality::Indeterminate(x) => ("indeterminate", x),
        };
        json!({ k: snapshot_real(x) })
    }
    /// The inverse of [`Quality::snapshot`].
    pub fn restored(v: &Value) -> Result<Self, String> {
        let (k, x) = v
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.iter().next())
            .ok_or_else(|| format!("a sample quality snapshot is one keyed bound, not {v}"))?;
        let x = restored_real(x, "sample quality")?;
        match k.as_str() {
            "value" => Ok(Quality::Value(x)),
            "below" => Ok(Quality::BelowRange(x)),
            "above" => Ok(Quality::AboveRange(x)),
            "indeterminate" => Ok(Quality::Indeterminate(x)),
            other => Err(format!("sample quality {other}")),
        }
    }
}

/// A sample in flight or delivered, in frame indices.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample<T> {
    pub acquired: u64,
    pub delivered: u64,
    pub value: T,
}

/// Injected electronic faults (instrument mechanism, not plant truth).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Faults {
    /// Added after the response, before range and rounding.
    pub bias: f64,
    /// Frozen pre-bias output; fresh samples keep fresh acquisition frames.
    pub stuck: Option<f64>,
    pub transport_hold: bool,
}

/// Sampling and whole-frame transport of one channel's evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery<T: Copy> {
    /// Frames between samples.
    pub sample_frames: u64,
    /// Frames from acquisition to delivery.
    pub transport_frames: u64,
    in_flight: Vec<Sample<T>>,
    delivered: Option<Sample<T>>,
}
impl<T: Copy> Delivery<T> {
    pub fn new(sample_frames: u64, transport_frames: u64) -> Result<Self, String> {
        if sample_frames == 0 {
            return Err("a channel samples at least once per frame interval".into());
        }
        Ok(Self {
            sample_frames,
            transport_frames,
            in_flight: Vec::new(),
            delivered: None,
        })
    }
    /// Whether frame `k` is an acquisition frame of this channel.
    pub fn due(&self, k: u64) -> bool {
        k.is_multiple_of(self.sample_frames)
    }
    pub fn send(&mut self, k: u64, value: T, hold: bool) {
        if !hold {
            self.in_flight.push(Sample {
                acquired: k,
                delivered: k + self.transport_frames,
                value,
            });
        }
    }
    /// Deliver every sample due at or before frame `k`; the latest wins.
    pub fn deliver(&mut self, k: u64, hold: bool) {
        if hold {
            self.in_flight.clear();
            return;
        }
        let (due, rest): (Vec<_>, Vec<_>) = self.in_flight.iter().partition(|s| s.delivered <= k);
        self.in_flight = rest;
        if let Some(latest) = due.into_iter().max_by_key(|s| s.acquired) {
            self.delivered = Some(latest);
        }
    }
    pub fn delivered(&self) -> Option<Sample<T>> {
        self.delivered
    }
    /// Power loss: no delivered evidence, nothing in flight.
    pub fn lose(&mut self) {
        self.in_flight.clear();
        self.delivered = None;
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): the samples
    /// in flight and the delivered one, each `[acquired, delivered, value]`
    /// with its value as `encode` writes it. The sampling and transport are
    /// the section's, recomposed on restore.
    pub fn snapshot(&self, encode: impl Fn(&T) -> Value) -> Value {
        let sample = |s: &Sample<T>| json!([s.acquired, s.delivered, encode(&s.value)]);
        json!({"in_flight": self.in_flight.iter().map(sample).collect::<Vec<_>>(),
            "delivered": self.delivered.as_ref().map(sample)})
    }
    /// Restore [`Delivery::snapshot`] exactly; anything else refuses.
    pub fn restore(
        &mut self,
        v: &Value,
        decode: impl Fn(&Value) -> Result<T, String>,
    ) -> Result<(), String> {
        let o = snapshot_fields(v, "delivery", &["in_flight", "delivered"])?;
        let sample = |s: &Value| -> Result<Sample<T>, String> {
            match s.as_array().map(Vec::as_slice) {
                Some([a, d, value]) => Ok(Sample {
                    acquired: restored_frame(a, "a sample's acquisition")?,
                    delivered: restored_frame(d, "a sample's delivery")?,
                    value: decode(value)?,
                }),
                _ => Err(format!(
                    "a sample snapshot is [acquired, delivered, value], not {s}"
                )),
            }
        };
        let in_flight = o["in_flight"]
            .as_array()
            .ok_or("delivery: in_flight is not an array")?
            .iter()
            .map(sample)
            .collect::<Result<Vec<_>, _>>()?;
        let delivered = match &o["delivered"] {
            Value::Null => None,
            s => Some(sample(s)?),
        };
        self.in_flight = in_flight;
        self.delivered = delivered;
        Ok(())
    }
}

/// One analog channel: the retained response and its delivery.
#[derive(Clone, Debug, PartialEq)]
pub struct Analog {
    pub id: String,
    /// The instrumentation supply group (I1, I2, I3) powering it.
    pub supply: String,
    pub config: AnalogConfig,
    response: f64,
    powered: bool,
    pub faults: Faults,
    pub delivery: Delivery<Quality>,
    /// An input stage outside its own span at this acquisition (the PZR
    /// LT's pressure interfaces): the indication computed at that stage's
    /// span limit is reported as a bound in this direction, never as an
    /// exact value ("valid overrange retains range status").
    pub input_overrange: Option<Overrange>,
}

/// The direction an out-of-span input stage moves the indication.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overrange {
    /// The actual indication lies above the computed one.
    Above,
    /// The actual indication lies below the computed one.
    Below,
}
impl Analog {
    /// Balanced initialization: the retained response equals the plant
    /// quantity at the start, with nothing yet acquired or delivered.
    pub fn new(
        id: &str,
        supply: &str,
        config: AnalogConfig,
        frame_s: f64,
        initial: f64,
    ) -> Result<Self, String> {
        config.validate()?;
        let frame = super::Frame::new(frame_s)?;
        if !initial.is_finite() {
            return Err(format!("{id}: initial response {initial}"));
        }
        Ok(Self {
            id: id.into(),
            supply: supply.into(),
            config,
            response: initial,
            powered: true,
            faults: Faults::default(),
            input_overrange: None,
            delivery: Delivery::new(
                frame.frames_in(config.sample_s)?,
                frame.frames_in(config.transport_s)?,
            )?,
        })
    }
    pub fn response(&self) -> f64 {
        self.response
    }
    pub fn powered(&self) -> bool {
        self.powered
    }
    /// Continue the electronic response over `dt` under the quantity's
    /// polynomial (raw derivatives at the interval start). Frozen unpowered.
    pub fn advance(&mut self, dt: f64, derivatives: &[f64]) -> Result<(), String> {
        if self.powered {
            self.response = if self.config.lag_s == 0. {
                polynomial_at(dt, derivatives)
            } else {
                lag_continuation(self.response, self.config.lag_s, dt, derivatives)
            }
            .map_err(|e| format!("{}: {e}", self.id))?;
        }
        Ok(())
    }
    /// The indication an acquisition at this moment yields.
    pub fn indication(&self) -> Result<Quality, String> {
        let raw = self.faults.stuck.unwrap_or(self.response) + self.faults.bias;
        if !raw.is_finite() {
            return Err(format!("{}: indication {raw}", self.id));
        }
        // Range before rounding: an out-of-range value never rounds back
        // onto an endpoint. Half bins round away from zero (toward greater
        // absolute value).
        let c = &self.config;
        Ok(match (c.min, c.max) {
            (Some(min), _) if raw < min => Quality::BelowRange(min),
            (_, Some(max)) if raw > max => Quality::AboveRange(max),
            // An input stage at its span limit: the computed indication is a
            // bound, assessed before rounding as every range is.
            _ if self.input_overrange == Some(Overrange::Above) => Quality::AboveRange(raw),
            _ if self.input_overrange == Some(Overrange::Below) => Quality::BelowRange(raw),
            _ => match c.indeterminate_band {
                Some(band) if raw.abs() <= band => Quality::Indeterminate(band),
                _ => Quality::Value(c.quantum.map_or(raw, |q| (raw / q).round() * q)),
            },
        })
    }
    /// Acquire at frame `k` if it is an acquisition frame and powered.
    pub fn acquire(&mut self, k: u64) -> Result<(), String> {
        if self.powered && self.delivery.due(k) {
            let q = self.indication()?;
            self.delivery.send(k, q, self.faults.transport_hold);
        }
        Ok(())
    }
    pub fn deliver(&mut self, k: u64) {
        if self.powered {
            self.delivery.deliver(k, self.faults.transport_hold);
        }
    }
    pub fn set_powered(&mut self, powered: bool) {
        if self.powered && !powered {
            self.delivery.lose();
        }
        self.powered = powered;
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): the retained
    /// response, supply, injected faults, input-stage status and delivery,
    /// exact. Identity, supply group and configuration are the section's.
    pub fn snapshot(&self) -> Value {
        json!({"id": self.id, "response": snapshot_real(self.response), "powered": self.powered,
            "faults": {"bias": snapshot_real(self.faults.bias),
                "stuck": crate::joined::block::snapshot_time(self.faults.stuck),
                "transport_hold": self.faults.transport_hold},
            "input_overrange": self.input_overrange.map(|o| match o {
                Overrange::Above => "above",
                Overrange::Below => "below",
            }),
            "delivery": self.delivery.snapshot(Quality::snapshot)})
    }
    /// Restore [`Analog::snapshot`] of the same channel exactly.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let o = snapshot_fields(
            v,
            "analog channel",
            &[
                "id",
                "response",
                "powered",
                "faults",
                "input_overrange",
                "delivery",
            ],
        )?;
        if o["id"].as_str() != Some(self.id.as_str()) {
            return Err(format!("channel {} restored from {}", self.id, o["id"]));
        }
        let f = snapshot_fields(
            &o["faults"],
            "channel faults",
            &["bias", "stuck", "transport_hold"],
        )?;
        let faults = Faults {
            bias: restored_real(&f["bias"], "channel bias")?,
            stuck: restored_real_option(&f["stuck"], "channel stuck output")?,
            transport_hold: restored_bool(&f["transport_hold"], "channel transport hold")?,
        };
        let input_overrange = match &o["input_overrange"] {
            Value::Null => None,
            Value::String(s) if s == "above" => Some(Overrange::Above),
            Value::String(s) if s == "below" => Some(Overrange::Below),
            other => return Err(format!("input-stage status {other}")),
        };
        self.delivery.restore(&o["delivery"], Quality::restored)?;
        self.response = restored_real(&o["response"], "channel response")?;
        self.powered = restored_bool(&o["powered"], "channel supply")?;
        self.faults = faults;
        self.input_overrange = input_overrange;
        Ok(())
    }
}

/// One discrete state report (true: the reported state holds), e.g. the
/// turbine controls' retained trip, sampled and transported like a channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub id: String,
    pub supply: String,
    powered: bool,
    pub transport_hold: bool,
    pub delivery: Delivery<bool>,
}
impl Report {
    pub fn new(
        id: &str,
        supply: &str,
        frame_s: f64,
        sample_s: f64,
        transport_s: f64,
    ) -> Result<Self, String> {
        let frame = super::Frame::new(frame_s)?;
        Ok(Self {
            id: id.into(),
            supply: supply.into(),
            powered: true,
            transport_hold: false,
            delivery: Delivery::new(frame.frames_in(sample_s)?, frame.frames_in(transport_s)?)?,
        })
    }
    pub fn acquire(&mut self, k: u64, state: bool) {
        if self.powered && self.delivery.due(k) {
            self.delivery.send(k, state, self.transport_hold);
        }
    }
    pub fn deliver(&mut self, k: u64) {
        if self.powered {
            self.delivery.deliver(k, self.transport_hold);
        }
    }
    pub fn powered(&self) -> bool {
        self.powered
    }
    pub fn set_powered(&mut self, powered: bool) {
        if self.powered && !powered {
            self.delivery.lose();
        }
        self.powered = powered;
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): supply,
    /// transport hold and delivery, exact.
    pub fn snapshot(&self) -> Value {
        json!({"id": self.id, "powered": self.powered, "transport_hold": self.transport_hold,
            "delivery": self.delivery.snapshot(|b| Value::Bool(*b))})
    }
    /// Restore [`Report::snapshot`] of the same report exactly.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let o = snapshot_fields(
            v,
            "report",
            &["id", "powered", "transport_hold", "delivery"],
        )?;
        if o["id"].as_str() != Some(self.id.as_str()) {
            return Err(format!("report {} restored from {}", self.id, o["id"]));
        }
        self.delivery
            .restore(&o["delivery"], |b| restored_bool(b, "a report's state"))?;
        self.powered = restored_bool(&o["powered"], "report supply")?;
        self.transport_hold = restored_bool(&o["transport_hold"], "report transport hold")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lag_is_exact_for_a_constant_and_a_ramp() {
        // Constant q: r = q + (r0 - q) e^{-dt/τ}.
        let r = lag_continuation(0., 0.2, 0.1, &[1.]).unwrap();
        assert!((r - (1. - (-0.5f64).exp())).abs() < 1e-15);
        // Ramp q = a + b s from r0 = a - bτ (the steady lagged ramp):
        // r stays a + b(s - τ).
        let (a, b, tau) = (15.2e6, -2.0e5, 0.2);
        for dt in [1e-4, 0.02, 0.1, 0.36, 3.] {
            let r = lag_continuation(a - b * tau, tau, dt, &[a, b]).unwrap();
            let exact = a + b * (dt - tau);
            assert!(
                (r - exact).abs() <= 1e-9 * exact.abs(),
                "dt {dt}: {r} vs {exact}"
            );
        }
        // A quadratic against the closed form r(t) for q = c s^2, r0 = 0:
        // r = c[t^2 - 2τt + 2τ^2(1 - e^{-t/τ})].
        let (c, tau) = (3.0, 0.5);
        for dt in [0.01, 0.4, 0.6, 2.0] {
            let r = lag_continuation(0., tau, dt, &[0., 0., 2. * c]).unwrap();
            let exact = c * (dt * dt - 2. * tau * dt + 2. * tau * tau * (-(-dt / tau).exp_m1()));
            assert!(
                (r - exact).abs() <= 1e-12 * exact.abs().max(1e-12),
                "dt {dt}"
            );
        }
        // Splitting an interval changes nothing beyond round-off.
        let d = [1.0, 0.3, -0.2];
        let whole = lag_continuation(0.5, 0.2, 0.3, &d).unwrap();
        let mid = lag_continuation(0.5, 0.2, 0.1, &d).unwrap();
        // Derivatives at the split point of the same polynomial.
        let s = 0.1;
        let d2 = [d[0] + d[1] * s + d[2] * s * s / 2., d[1] + d[2] * s, d[2]];
        let split = lag_continuation(mid, 0.2, 0.2, &d2).unwrap();
        assert!((whole - split).abs() < 1e-14);
        assert!(lag_continuation(0., 0., 0.1, &[1.]).is_err());
        assert!(lag_continuation(0., 0.2, 0.1, &[]).is_err());
    }

    /// A channel without a lag of its own reads the quantity's polynomial
    /// at the interval end; a negative lag is still refused.
    #[test]
    fn a_zero_lag_channel_reads_the_quantity_itself() {
        let config = AnalogConfig {
            lag_s: 0.,
            ..pt()
        };
        let mut a = Analog::new("FT", "I1", config, 0.1, 1.).unwrap();
        // q(s) = 1 + 0.5 s - 3 s^2 over 0.2 s.
        a.advance(0.2, &[1., 0.5, -6.]).unwrap();
        assert!((a.response() - (1. + 0.1 - 0.12)).abs() < 1e-15);
        assert!(polynomial_at(0.1, &[]).is_err());
        assert!(
            AnalogConfig {
                lag_s: -0.1,
                ..pt()
            }
            .validate()
            .is_err()
        );
    }

    fn pt() -> AnalogConfig {
        AnalogConfig {
            lag_s: 0.2,
            min: Some(0.),
            max: Some(20e6),
            quantum: Some(1000.),
            indeterminate_band: None,
            sample_s: 0.1,
            transport_s: 0.1,
        }
    }

    #[test]
    fn range_is_assessed_before_rounding_and_half_bins_round_up_in_magnitude() {
        let mut a = Analog::new("PT1", "I1", pt(), 0.1, 15_000_500.).unwrap();
        assert_eq!(a.indication().unwrap(), Quality::Value(15_001_000.));
        a.faults.bias = -15_000_500. - 400.;
        assert_eq!(a.indication().unwrap(), Quality::BelowRange(0.));
        a.faults.bias = 5.1e6;
        assert_eq!(a.indication().unwrap(), Quality::AboveRange(20e6));
        a.faults.bias = 0.;
        a.faults.stuck = Some(1.0e6);
        assert_eq!(a.indication().unwrap(), Quality::Value(1.0e6));
    }

    #[test]
    fn a_band_establishes_magnitude_only_and_unset_fields_are_absent() {
        let ft = AnalogConfig {
            lag_s: 0.25,
            min: Some(-1.5),
            max: Some(1.5),
            quantum: Some(5. / 8849.),
            indeterminate_band: Some(10. / 8849.),
            sample_s: 0.1,
            transport_s: 0.1,
        };
        let mut a = Analog::new("FT", "I1", ft, 0.1, 9e-4).unwrap();
        assert_eq!(a.indication().unwrap(), Quality::Indeterminate(10. / 8849.));
        a.faults.bias = -3e-3;
        assert!(matches!(a.indication().unwrap(), Quality::Value(v) if v < 0.));
        let proxy = AnalogConfig {
            lag_s: 0.2,
            min: None,
            max: None,
            quantum: None,
            indeterminate_band: None,
            sample_s: 0.1,
            transport_s: 0.1,
        };
        let b = Analog::new("P1", "I1", proxy, 0.1, 0.9987654321).unwrap();
        assert_eq!(b.indication().unwrap(), Quality::Value(0.9987654321));
        let bad = AnalogConfig {
            quantum: Some(0.),
            ..proxy
        };
        assert!(Analog::new("P1", "I1", bad, 0.1, 1.).is_err());
    }

    #[test]
    fn an_input_stage_overrange_reports_a_bound_not_a_value() {
        let lt = AnalogConfig {
            lag_s: 0.5,
            min: Some(-1.),
            max: Some(13.),
            quantum: Some(0.01),
            indeterminate_band: None,
            sample_s: 0.1,
            transport_s: 0.1,
        };
        let mut a = Analog::new("LT1", "I1", lt, 0.1, 6.0049).unwrap();
        assert_eq!(a.indication().unwrap(), Quality::Value(6.0));
        a.input_overrange = Some(Overrange::Above);
        assert_eq!(a.indication().unwrap(), Quality::AboveRange(6.0049));
        a.input_overrange = Some(Overrange::Below);
        assert_eq!(a.indication().unwrap(), Quality::BelowRange(6.0049));
        // The indicated span's own status comes first.
        let mut b = Analog::new("LT2", "I2", lt, 0.1, 14.).unwrap();
        b.input_overrange = Some(Overrange::Below);
        assert_eq!(b.indication().unwrap(), Quality::AboveRange(13.));
    }

    #[test]
    fn samples_travel_whole_frames_and_power_loss_discards_them() {
        let mut a = Analog::new("PT1", "I1", pt(), 0.1, 15.2e6).unwrap();
        a.acquire(10).unwrap();
        a.deliver(10);
        assert_eq!(a.delivery.delivered(), None);
        a.deliver(11);
        let s = a.delivery.delivered().unwrap();
        assert_eq!((s.acquired, s.delivered), (10, 11));
        a.acquire(11).unwrap();
        a.set_powered(false);
        assert_eq!(a.delivery.delivered(), None);
        a.advance(1., &[0.]).unwrap();
        assert_eq!(a.response(), 15.2e6, "an unpowered response is frozen");
        a.set_powered(true);
        a.deliver(12);
        assert_eq!(a.delivery.delivered(), None, "nothing in flight survives");
        // A transport hold keeps the old sample and its acquisition frame.
        a.acquire(12).unwrap();
        a.deliver(13);
        a.faults.transport_hold = true;
        a.acquire(13).unwrap();
        a.deliver(14);
        assert_eq!(a.delivery.delivered().unwrap().acquired, 12);
        a.faults.transport_hold = false;
        a.deliver(15);
        assert_eq!(a.delivery.delivered().unwrap().acquired, 12, "no replay");
    }

    #[test]
    fn a_report_samples_a_discrete_state() {
        let mut r = Report::new("TG", "ACT.B", 0.1, 0.1, 0.1).unwrap();
        r.acquire(5, false);
        r.deliver(6);
        assert!(!r.delivery.delivered().unwrap().value);
        r.acquire(6, true);
        r.deliver(6);
        assert!(!r.delivery.delivered().unwrap().value);
        r.deliver(7);
        assert!(r.delivery.delivered().unwrap().value);
        assert!(Report::new("TG", "ACT.B", 0.1, 0.15, 0.1).is_err());
    }
}

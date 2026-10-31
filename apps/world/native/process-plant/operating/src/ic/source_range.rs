//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/nuclear-observation-apparatus.md#obtained-counts-and-common-charge-not-a-noiseless-source-meter
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/nuclear-observation-apparatus.md#fixed-obtained-window-evidence
//! `LD01.CORE.NI.SHUTDOWN`: the I2 SOURCE-pulse path's obtained 60 s window
//! record. One inhomogeneous Poisson detected-event process of rate
//! `Rref · proxy(t)` (the converter's collected events, in the current
//! proxy's ratio form) plus the frontend's dark rate. A nonparalyzable
//! deadtime blocks arrivals after each accepted event. Counts are drawn
//! from one retained random stream, only on accepted trajectory intervals.
//!
//! Fixed windows on the I&C frame grid: a complete powered window keeps its
//! accepted count `N` and live exposure `E`, with the exponential-martingale
//! compensator band `[A_L, A_U]`, the background-subtracted excess
//! `[S_L, S_U]` and the detectability decision. A window whose mean
//! incident occupancy reaches the selected guard draws no count and is
//! recorded as saturated: near pulse saturation the guard fails anyway and
//! no count is inverted. That is a declared limit, not a mean published as
//! a measurement.
use super::acquisition::{
    restored_bool, restored_frame, restored_real, restored_real_option, snapshot_fields,
    snapshot_real,
};
use super::{Frame, packet::SourceRangeSpec};
use serde_json::{Value, json};

/// One completed window's evidence (all times on the simulation axis).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowRecord {
    pub end_s: f64,
    /// Powered over the whole window.
    pub complete: bool,
    /// The mean incident occupancy reached the guard in some interval: no
    /// count was drawn.
    pub saturated: bool,
    /// Accepted physical-plus-dark events (absent when saturated).
    pub count: Option<u64>,
    /// Powered time less deadtime blocking inside the window.
    pub live_s: Option<f64>,
    pub compensator: Option<[f64; 2]>,
    pub excess: Option<[f64; 2]>,
    /// Source detectability (complete, unsaturated, `S_L > 0`, `S_L` at
    /// least the minimum excess count, incident band occupancy below the
    /// guard).
    pub detectable: bool,
}

/// SplitMix64: the retained random stream (one per path).
fn next_uniform(state: &mut u64) -> f64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    // (0, 1): never zero, so the exponential draw stays finite.
    ((z >> 11) as f64 + 0.5) * (1. / (1u64 << 53) as f64)
}

/// `∫_{x0}^{x1} Σ_k q_k s^k / k! ds` for the polynomial `derivatives`.
fn integral(derivatives: &[f64], x0: f64, x1: f64) -> f64 {
    let (mut sum, mut factorial, mut p0, mut p1) = (0., 1., x0, x1);
    for (k, q) in derivatives.iter().enumerate() {
        factorial *= (k + 1) as f64;
        sum += q * (p1 - p0) / factorial;
        p0 *= x0;
        p1 *= x1;
    }
    sum
}

/// The SOURCE path's state.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceRange {
    pub spec: SourceRangeSpec,
    frame: Frame,
    frames_per_window: u64,
    rng: u64,
    powered: bool,
    /// The window being accumulated (its index on the frame grid).
    window: Option<u64>,
    count: u64,
    covered_s: f64,
    dead_s: f64,
    saturated: bool,
    /// An accepted event's block reaching beyond the last interval.
    dead_until: f64,
    pending: Vec<WindowRecord>,
    delivered: Option<WindowRecord>,
}

impl SourceRange {
    pub fn new(spec: &SourceRangeSpec, frame: Frame) -> Result<Self, String> {
        let s = spec;
        if !(s.rref_events_per_s > 0.
            && s.rref_events_per_s.is_finite()
            && s.dark_per_s >= 0.
            && s.deadtime_s > 0.
            && s.alpha > 0.
            && s.alpha < 1.
            && s.theta > 0.
            && s.maximum_occupancy > 0.
            && s.background_per_s[0] >= 0.
            && s.background_per_s[1] >= s.background_per_s[0])
        {
            return Err(format!("{}: invalid SOURCE selection {s:?}", s.id));
        }
        let frames_per_window = frame.frames_in(s.window_s)?;
        frame.frames_in(s.sample_s)?;
        frame.frames_in(s.transport_s)?;
        Ok(Self {
            spec: spec.clone(),
            frame,
            frames_per_window,
            rng: s.seed,
            powered: true,
            window: None,
            count: 0,
            covered_s: 0.,
            dead_s: 0.,
            saturated: false,
            dead_until: f64::NEG_INFINITY,
            pending: Vec::new(),
            delivered: None,
        })
    }
    fn window_start(&self, w: u64) -> f64 {
        self.frame.instant(w * self.frames_per_window)
    }
    fn window_of(&self, t: f64) -> u64 {
        // The window holding `t` on the frame grid (a boundary starts one).
        let mut w = (t / (self.frames_per_window as f64 * self.frame.instant(1))).floor() as u64;
        while self.window_start(w + 1) <= t {
            w += 1;
        }
        while w > 0 && self.window_start(w) > t {
            w -= 1;
        }
        w
    }
    pub fn set_powered(&mut self, powered: bool) {
        self.powered = powered;
    }
    /// The accepted trajectory over `[from, to]` with the current proxy's
    /// polynomial there (`proxy_derivatives` at `from`).
    pub fn advance(&mut self, from: f64, to: f64, proxy_derivatives: &[f64]) -> Result<(), String> {
        if to.is_nan() || from.is_nan() || to <= from {
            return Err(format!("{}: interval [{from}, {to}]", self.spec.id));
        }
        let mut a = from;
        while a < to {
            let w = self.window_of(a);
            if self.window != Some(w) {
                self.close_window()?;
                self.window = Some(w);
            }
            let end = self.window_start(w + 1);
            let b = to.min(end);
            if self.powered {
                self.interval(from, a, b, proxy_derivatives)?;
                self.covered_s += b - a;
            }
            a = b;
            if b == end {
                self.close_window()?;
                self.window = Some(w + 1);
            }
        }
        Ok(())
    }
    /// One powered sub-interval `[a, b]` inside the current window; the
    /// polynomial `q` is taken about `origin` (absolute times throughout).
    fn interval(&mut self, origin: f64, a: f64, b: f64, q: &[f64]) -> Result<(), String> {
        let s = &self.spec;
        let hazard = |u0: f64, u1: f64| {
            s.rref_events_per_s * integral(q, u0 - origin, u1 - origin) + s.dark_per_s * (u1 - u0)
        };
        let total = hazard(a, b);
        if !(total.is_finite() && total >= 0.) {
            return Err(format!("{}: event hazard {total} over [{a}, {b}] s", s.id));
        }
        // The occupancy guard on the interval's mean incident rate.
        if total / (b - a) * s.deadtime_s >= s.maximum_occupancy {
            self.saturated = true;
            self.dead_until = f64::NEG_INFINITY;
            return Ok(());
        }
        // A block an earlier accepted event carries into this interval.
        let mut cur = a;
        if self.dead_until > a {
            let until = self.dead_until.min(b);
            self.dead_s += until - a;
            cur = until;
        }
        // Thinning (Lewis-Shedler): candidates of a homogeneous process at
        // a majorant of the rate over the interval, each kept with probability
        // rate / majorant. Exact for the polynomial's rate, with no root search.
        let span = b - origin;
        let (mut majorant, mut power, mut factorial) = (s.dark_per_s, 1., 1.);
        for (k, qk) in q.iter().enumerate() {
            if k > 0 {
                power *= span;
                factorial *= k as f64;
            }
            majorant += s.rref_events_per_s * qk.abs() * power / factorial;
        }
        let rate = |u: f64| {
            let x = u - origin;
            let (mut sum, mut term) = (0., 1.);
            for (k, qk) in q.iter().enumerate() {
                if k > 0 {
                    term *= x / k as f64;
                }
                sum += qk * term;
            }
            s.rref_events_per_s * sum + s.dark_per_s
        };
        let mut block_end = f64::NEG_INFINITY;
        while cur < b && majorant > 0. {
            cur += -next_uniform(&mut self.rng).ln() / majorant;
            if cur >= b {
                break;
            }
            let r = rate(cur);
            if r.is_nan() || r < 0. {
                return Err(format!("{}: event rate {r} at {cur} s", s.id));
            }
            if next_uniform(&mut self.rng) * majorant >= r {
                continue;
            }
            self.count += 1;
            block_end = cur + s.deadtime_s;
            self.dead_s += block_end.min(b) - cur;
            cur = block_end;
        }
        // Only an accepted event's block reaches into the next interval.
        self.dead_until = if block_end > b {
            block_end
        } else {
            f64::NEG_INFINITY
        };
        Ok(())
    }
    /// Close the current window (if any) into a record.
    fn close_window(&mut self) -> Result<(), String> {
        let Some(w) = self.window else { return Ok(()) };
        let s = &self.spec;
        let length = self.window_start(w + 1) - self.window_start(w);
        let complete = (self.covered_s - length).abs() <= 1e-9 * length;
        let record = if self.saturated {
            WindowRecord {
                end_s: self.window_start(w + 1),
                complete,
                saturated: true,
                count: None,
                live_s: None,
                compensator: None,
                excess: None,
                detectable: false,
            }
        } else {
            let n = self.count as f64;
            let e = self.covered_s - self.dead_s;
            let c = (2. / s.alpha).ln();
            let a_l = ((s.theta * n - c) / s.theta.exp_m1()).max(0.);
            let a_u = (s.theta * n + c) / -(-s.theta).exp_m1();
            let s_l = (a_l - s.background_per_s[1] * e).max(0.);
            let s_u = (a_u - s.background_per_s[0] * e).max(0.);
            let detectable = complete
                && e > 0.
                && s_l > 0.
                && s_l >= s.minimum_excess_count
                && a_u / e * s.deadtime_s < s.maximum_occupancy;
            WindowRecord {
                end_s: self.window_start(w + 1),
                complete,
                saturated: false,
                count: Some(self.count),
                live_s: Some(e),
                compensator: Some([a_l, a_u]),
                excess: Some([s_l, s_u]),
                detectable,
            }
        };
        self.pending.push(record);
        self.window = None;
        self.count = 0;
        self.covered_s = 0.;
        self.dead_s = 0.;
        self.saturated = false;
        Ok(())
    }
    /// Frame `k`: deliver every record whose end plus sample and transport
    /// lies at or before the frame instant (the latest wins). Unpowered,
    /// nothing is delivered and in-flight records are discarded.
    pub fn frame(&mut self, k: u64) {
        let tk = self.frame.instant(k);
        let lag = self.spec.sample_s + self.spec.transport_s;
        if !self.powered {
            self.pending.clear();
            self.delivered = None;
            return;
        }
        let due: Vec<WindowRecord> = self
            .pending
            .iter()
            .filter(|r| r.end_s + lag <= tk + 1e-9)
            .copied()
            .collect();
        self.pending.retain(|r| r.end_s + lag > tk + 1e-9);
        if let Some(last) = due.last() {
            self.delivered = Some(*last);
        }
    }
    /// The delivered record and whether its age at frame `k` is within the
    /// selected maximum (window-END timestamp).
    pub fn delivered(&self, k: u64) -> Option<(WindowRecord, bool)> {
        let tk = self.frame.instant(k);
        self.delivered
            .map(|r| (r, tk - r.end_s <= self.spec.maximum_age_s + 1e-9))
    }
    /// S5 snapshot hook: everything a later frame reads, exact.
    pub fn snapshot(&self) -> Value {
        let rec = |r: &WindowRecord| {
            json!({"end_s": snapshot_real(r.end_s), "complete": r.complete, "saturated": r.saturated,
                "count": r.count, "live_s": r.live_s.map(snapshot_real),
                "compensator": r.compensator.map(|v| v.map(snapshot_real)),
                "excess": r.excess.map(|v| v.map(snapshot_real)), "detectable": r.detectable})
        };
        json!({"rng": self.rng, "powered": self.powered, "window": self.window, "count": self.count,
            "covered_s": snapshot_real(self.covered_s), "dead_s": snapshot_real(self.dead_s),
            "saturated": self.saturated,
            "dead_until": if self.dead_until.is_finite() { snapshot_real(self.dead_until) } else { Value::Null },
            "pending": self.pending.iter().map(rec).collect::<Vec<_>>(),
            "delivered": self.delivered.as_ref().map(rec)})
    }
    /// Restore [`SourceRange::snapshot`] exactly.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let o = snapshot_fields(
            v,
            "source range",
            &[
                "rng",
                "powered",
                "window",
                "count",
                "covered_s",
                "dead_s",
                "saturated",
                "dead_until",
                "pending",
                "delivered",
            ],
        )?;
        let pair = |v: &Value, what: &str| -> Result<Option<[f64; 2]>, String> {
            match v {
                Value::Null => Ok(None),
                Value::Array(a) if a.len() == 2 => Ok(Some([
                    restored_real(&a[0], what)?,
                    restored_real(&a[1], what)?,
                ])),
                other => Err(format!("{what}: {other}")),
            }
        };
        let rec = |v: &Value| -> Result<WindowRecord, String> {
            let r = snapshot_fields(
                v,
                "window record",
                &[
                    "end_s",
                    "complete",
                    "saturated",
                    "count",
                    "live_s",
                    "compensator",
                    "excess",
                    "detectable",
                ],
            )?;
            Ok(WindowRecord {
                end_s: restored_real(&r["end_s"], "window end")?,
                complete: restored_bool(&r["complete"], "window complete")?,
                saturated: restored_bool(&r["saturated"], "window saturated")?,
                count: match &r["count"] {
                    Value::Null => None,
                    c => Some(c.as_u64().ok_or("window count")?),
                },
                live_s: restored_real_option(&r["live_s"], "window live exposure")?,
                compensator: pair(&r["compensator"], "window compensator")?,
                excess: pair(&r["excess"], "window excess")?,
                detectable: restored_bool(&r["detectable"], "window detectable")?,
            })
        };
        self.rng = o["rng"]
            .as_u64()
            .ok_or("source range: random stream state")?;
        self.powered = restored_bool(&o["powered"], "source range supply")?;
        self.window = match &o["window"] {
            Value::Null => None,
            w => Some(restored_frame(w, "source range window")?),
        };
        self.count = o["count"].as_u64().ok_or("source range count")?;
        self.covered_s = restored_real(&o["covered_s"], "source range coverage")?;
        self.dead_s = restored_real(&o["dead_s"], "source range dead time")?;
        self.saturated = restored_bool(&o["saturated"], "source range saturation")?;
        self.dead_until = restored_real_option(&o["dead_until"], "source range block")?
            .unwrap_or(f64::NEG_INFINITY);
        self.pending = o["pending"]
            .as_array()
            .ok_or("source range pending")?
            .iter()
            .map(rec)
            .collect::<Result<_, _>>()?;
        self.delivered = match &o["delivered"] {
            Value::Null => None,
            r => Some(rec(r)?),
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(rref: f64) -> SourceRangeSpec {
        SourceRangeSpec {
            id: "LD01.CORE.NI.SHUTDOWN".into(),
            supply: "I2".into(),
            rref_events_per_s: rref,
            dark_per_s: 1.,
            deadtime_s: 1e-6,
            window_s: 60.,
            alpha: 0.01,
            theta: 0.1,
            minimum_excess_count: 400.,
            background_per_s: [0., 2.],
            maximum_occupancy: 0.1,
            sample_s: 0.1,
            transport_s: 0.1,
            maximum_age_s: 60.2,
            seed: 1,
        }
    }
    fn run(s: &mut SourceRange, from: f64, to: f64, proxy: f64) {
        let mut t = from;
        while t < to {
            let b = (t + 0.1).min(to);
            s.advance(t, b, &[proxy]).unwrap();
            t = b;
        }
    }

    #[test]
    fn a_constant_low_rate_counts_within_its_poisson_band_and_the_live_incidence_holds() {
        // 30 events/s total: Rref·proxy = 29, dark 1.
        let frame = Frame::new(0.1).unwrap();
        let mut s = SourceRange::new(&spec(29e6), frame).unwrap();
        run(&mut s, 0., 120.0, 1e-6);
        s.frame(1202);
        let (r, fresh) = s.delivered(1202).unwrap();
        assert!(fresh && r.complete && !r.saturated);
        let n = r.count.unwrap() as f64;
        // 1,800 expected; 6 sigma ≈ 255.
        assert!((n - 1800.).abs() < 255., "{n}");
        let (e, tau) = (r.live_s.unwrap(), 1e-6);
        let t = 60.;
        assert!(
            ((n - 1.) * tau).max(0.) <= t - e + 1e-12 && t - e <= (t).min((n + 1.) * tau) + 1e-12
        );
        let [a_l, a_u] = r.compensator.unwrap();
        assert!(a_l < n && n < a_u);
    }

    #[test]
    fn a_snapshot_restores_the_same_future_and_power_loss_withholds_delivery() {
        let frame = Frame::new(0.1).unwrap();
        let mut a = SourceRange::new(&spec(29e6), frame).unwrap();
        run(&mut a, 0., 37.3, 1e-6);
        let mut b = SourceRange::new(&spec(29e6), frame).unwrap();
        b.restore(&a.snapshot()).unwrap();
        run(&mut a, 37.3, 61.0, 1e-6);
        run(&mut b, 37.3, 61.0, 1e-6);
        assert_eq!(a, b);
        a.set_powered(false);
        a.frame(610);
        assert!(a.delivered(610).is_none());
    }

    #[test]
    fn at_power_the_occupancy_guard_records_a_saturated_window_with_no_count() {
        let frame = Frame::new(0.1).unwrap();
        let mut s = SourceRange::new(&spec(3.4e10), frame).unwrap();
        run(&mut s, 0., 60.0, 1.0);
        s.frame(602);
        let (r, _) = s.delivered(602).unwrap();
        assert!(r.saturated && r.count.is_none() && !r.detectable);
    }

    #[test]
    fn a_window_entered_mid_way_is_incomplete() {
        let frame = Frame::new(0.1).unwrap();
        let mut s = SourceRange::new(&spec(29e6), frame).unwrap();
        run(&mut s, 30.0, 60.0, 1e-6);
        s.frame(602);
        let (r, _) = s.delivered(602).unwrap();
        assert!(!r.complete && !r.detectable);
    }
}

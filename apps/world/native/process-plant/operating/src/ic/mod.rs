//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/source-and-primary-protection.md#observation-ownership-and-commissioning-settings
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/steam-generator-protection.md#voting-and-degraded-operation
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! Acquired protection, the S3 slice of C16: acquisition of plant
//! quantities through their selected electronic response, sampling and
//! transport; three powered division processors with qualification timers
//! and latched named causes; and the physical two-of-three holding path to
//! `LD01.TRIP.HOLD`. It reads no plant state itself: the composing driver
//! feeds each accepted step's polynomial of the observed quantities and the
//! declared commands, and applies the holding loss the path decides at its
//! frame instant as a class-R restart (lead decision S3-D1).
//!
//! Every number (setpoints, durations, spans, lags, sampling, transport,
//! ages) comes from the compiled `ic` packet section, whose compiler reads
//! only strict wiki blocks. The voting, latching and holding-circuit rules
//! are the owner pages' selected logic, implemented here once.
//!
//! Time inside the I&C is integer frame indices on the declared frame
//! (`k · period`): acquisition, delivery, age and qualification are counted
//! in frames, so no sum of decimal times ever decides an order.
pub mod acquisition;
pub mod division;
pub mod holding;
pub mod packet;
pub mod protection;
pub mod source_range;
pub mod vote;

/// The declared I&C frame: instants `k · period_s`, integer indexed, on the
/// simulation-time axis (epoch 0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    period_s: f64,
}
impl Frame {
    pub fn new(period_s: f64) -> Result<Self, String> {
        if !(period_s.is_finite() && period_s > 0.) {
            return Err(format!("frame period {period_s} s"));
        }
        Ok(Self { period_s })
    }
    pub fn period_s(&self) -> f64 {
        self.period_s
    }
    /// Instant of frame `k`, always by the same product.
    pub fn instant(&self, k: u64) -> f64 {
        k as f64 * self.period_s
    }
    /// The smallest `k` with `instant(k) >= t` (exact comparison).
    pub fn at_or_after(&self, t: f64) -> Result<u64, String> {
        if !(t.is_finite() && t >= 0.) {
            return Err(format!("frame index of {t} s"));
        }
        let mut k = (t / self.period_s).ceil() as u64;
        if self.instant(k) < t {
            k += 1;
        }
        if k > 0 && self.instant(k - 1) >= t {
            k -= 1;
        }
        Ok(k)
    }
    /// Whole frames in a selected duration, refused unless the duration is
    /// a whole number of frames to within its decimal representation (a
    /// 0.5 s qualification on the 0.1 s frame is 5 frames).
    pub fn frames_in(&self, duration_s: f64) -> Result<u64, String> {
        let n = duration_s / self.period_s;
        let whole = n.round();
        if !(duration_s.is_finite() && duration_s >= 0.) || (n - whole).abs() > 1e-9 * n.max(1.) {
            return Err(format!(
                "{duration_s} s is not a whole number of {} s frames",
                self.period_s
            ));
        }
        Ok(whole as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::Frame;

    #[test]
    fn frame_instants_are_integer_indexed_and_durations_whole() {
        let f = Frame::new(0.1).unwrap();
        assert_eq!(f.instant(5220), 522.0);
        assert_eq!(f.at_or_after(522.0).unwrap(), 5220);
        assert_eq!(f.at_or_after(522.05).unwrap(), 5221);
        assert_eq!(f.at_or_after(0.).unwrap(), 0);
        // Just above an instant: the next frame.
        assert_eq!(f.at_or_after(f.instant(7) + 1e-15).unwrap(), 8);
        assert_eq!(f.frames_in(0.5).unwrap(), 5);
        assert_eq!(f.frames_in(0.2).unwrap(), 2);
        assert_eq!(f.frames_in(0.3).unwrap(), 3);
        assert_eq!(f.frames_in(1.).unwrap(), 10);
        assert_eq!(f.frames_in(5.).unwrap(), 50);
        assert_eq!(f.frames_in(0.).unwrap(), 0);
        assert!(f.frames_in(0.25).is_err());
        assert!(Frame::new(0.).is_err());
    }
}

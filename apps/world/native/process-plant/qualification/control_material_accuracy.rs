//! Nuclear-only cold control-steel comparison. Sensible/mechanical heat cannot
//! hide a missing prompt/Mn route. Uses the inherited cold nuclear consequence
//! policy, not the much larger apparatus sensible-heat resolution.
use super::{finite, numbers};

pub const RESOLUTION: f64 = 1e-12;
#[derive(Clone)]
pub struct Sample {
    pub time: f64,
    pub powers: Vec<f64>,
    pub paid: Vec<f64>,
    pub receipts: [f64; 2],
}
impl Sample {
    pub fn json(&self) -> String {
        format!("{{\"time\":{},\"powersW\":{},\"paidJ\":{},\"receiptsJ\":{}}}",
            finite(self.time), numbers(&self.powers), numbers(&self.paid), numbers(&self.receipts))
    }
}
#[derive(Clone, Debug)]
pub struct Comparison {
    pub time: f64,
    pub family: &'static str,
    pub row: usize,
    pub normal: f64,
    pub tighter: f64,
    pub bound: f64,
    pub ratio: f64,
    pub sumabs_ratio: f64,
}
impl Comparison {
    pub fn json(&self) -> String {
        format!("{{\"time\":{},\"family\":\"{}\",\"row\":{},\"normal\":{},\"tighter\":{},\"bound\":{},\"ratio\":{},\"sumabsRatio\":{}}}",
            finite(self.time), self.family, self.row, finite(self.normal), finite(self.tighter),
            finite(self.bound), finite(self.ratio), finite(self.sumabs_ratio))
    }
    pub fn failed(&self) -> bool { self.ratio > 1. || self.sumabs_ratio > 1. }
}
pub fn compare(a: &Sample, b: &Sample) -> Result<Comparison, String> {
    if a.time != b.time || !a.time.is_finite() || a.time < 0. {
        return Err("Control material common time differs".into());
    }
    let mut result = Comparison { time: a.time, family: "power-W", row: 0,
        normal: 0., tighter: 0., bound: 20. * RESOLUTION, ratio: 0., sumabs_ratio: 0. };
    for (family, x, y) in [
        ("power-W", a.powers.as_slice(), b.powers.as_slice()),
        ("paid-J", a.paid.as_slice(), b.paid.as_slice()),
        ("transfer-export-J", a.receipts.as_slice(), b.receipts.as_slice()),
    ] {
        if x.is_empty() || x.len() != y.len()
            || x.iter().chain(y).any(|v| !v.is_finite() || *v < 0.) {
            return Err("Malformed nuclear-only control material comparison".into());
        }
        let (mut sum_difference, mut sum_signal) = (0., 0.);
        for (row, (&normal, &tighter)) in x.iter().zip(y).enumerate() {
            let bound = 1e-3 * tighter.abs() + 20. * RESOLUTION;
            let difference = (normal - tighter).abs();
            let ratio = difference / bound;
            if ratio > result.ratio {
                result.family = family; result.row = row; result.normal = normal;
                result.tighter = tighter; result.bound = bound; result.ratio = ratio;
            }
            sum_difference += difference;
            sum_signal += tighter.abs();
        }
        result.sumabs_ratio = result.sumabs_ratio.max(
            sum_difference / (1e-3 * sum_signal + 20. * RESOLUTION * x.len() as f64));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Sample {
        Sample { time: 2., powers: vec![1e-6, 2e-6, 0.], paid: vec![2e-5, 3e-5], receipts: [1e-5, 2e-5] }
    }
    #[test]
    fn missing_prompt_decay_or_recipient_and_cancelling_redistribution_fail() {
        let a = sample();
        assert!(!compare(&a, &a).unwrap().failed());
        for row in 0..a.powers.len() {
            let mut b = sample(); b.powers[row] += 1e-7;
            let c = compare(&a, &b).unwrap();
            assert!(c.failed()); assert_eq!(c.family, "power-W"); assert_eq!(c.row, row);
        }
        let mut b = sample(); b.powers[0] += 1e-7; b.powers[1] -= 1e-7;
        assert!(compare(&a, &b).unwrap().failed());
        for row in 0..2 {
            let mut b = sample(); b.paid[row] += 1e-5;
            assert!(compare(&a, &b).unwrap().failed());
            let mut b = sample(); b.receipts[row] += 1e-5;
            assert!(compare(&a, &b).unwrap().failed());
        }
    }
    #[test]
    fn malformed_or_wrong_time_channels_refuse_and_exact_zero_is_compared() {
        let a = sample();
        for invalid in [f64::NAN, f64::INFINITY, -1.] {
            let mut b = sample(); b.powers[0] = invalid; assert!(compare(&a, &b).is_err());
        }
        let mut b = sample(); b.time += 1.; assert!(compare(&a, &b).is_err());
        let mut b = sample(); b.powers.pop(); assert!(compare(&a, &b).is_err());
        let mut b = sample(); b.powers[2] = 1e-11; assert!(!compare(&a, &b).unwrap().failed());
        b.powers[2] = 3e-11; assert!(compare(&a, &b).unwrap().failed());
    }
}

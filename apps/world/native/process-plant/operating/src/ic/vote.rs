//! spec: world/packs/process-plant/reference-designs/ld-01/safety/steam-generator-protection.md#what-constitutes-usable-evidence
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/steam-generator-protection.md#voting-and-degraded-operation
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/source-and-primary-protection.md#observation-ownership-and-commissioning-settings
//! Channel evidence against a threshold predicate, and the selected
//! three-channel vote: three usable require two affirmative, two usable
//! require both, one or none cannot establish the predicate (the family's
//! insufficient-evidence function then qualifies separately).
use super::acquisition::Quality;
use serde::Deserialize;

/// An inclusive threshold predicate on an indication.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Side {
    AtOrBelow(f64),
    AtOrAbove(f64),
    /// Strictly above: "conclusively exceeds" (the arming proxy).
    Above(f64),
}

/// What one usable sample establishes about the predicate: `Some` when it
/// is conclusive. A range bound is conclusive only on its own side of the
/// setting; it is never an exact value.
pub fn predicate(q: Quality, side: Side) -> Option<bool> {
    match (q, side) {
        (Quality::Value(v), Side::AtOrBelow(s)) => Some(v <= s),
        (Quality::Value(v), Side::AtOrAbove(s)) => Some(v >= s),
        // Actual below `bound`.
        (Quality::BelowRange(bound), Side::AtOrBelow(s)) => (bound <= s).then_some(true),
        (Quality::BelowRange(bound), Side::AtOrAbove(s)) => (bound <= s).then_some(false),
        // Actual above `bound`.
        (Quality::AboveRange(bound), Side::AtOrAbove(s)) => (bound >= s).then_some(true),
        (Quality::AboveRange(bound), Side::AtOrBelow(s)) => (bound >= s).then_some(false),
        (Quality::Value(v), Side::Above(s)) => Some(v > s),
        (Quality::BelowRange(bound), Side::Above(s)) => (bound <= s).then_some(false),
        (Quality::AboveRange(bound), Side::Above(s)) => (bound >= s).then_some(true),
        // Magnitude at most `b`, sign unknown: conclusive only if the whole
        // interval [-b, b] lies on one side.
        (Quality::Indeterminate(b), Side::AtOrBelow(s)) => interval(b <= s, -b > s),
        (Quality::Indeterminate(b), Side::AtOrAbove(s)) => interval(-b >= s, b < s),
        (Quality::Indeterminate(b), Side::Above(s)) => interval(-b > s, b <= s),
    }
}
fn interval(all: bool, none: bool) -> Option<bool> {
    if all {
        Some(true)
    } else if none {
        Some(false)
    } else {
        None
    }
}

/// Whether a usable sample lies conclusively inside `[low, high]`: only an
/// in-range value can (a bound never establishes band membership).
pub fn within(q: Quality, low: f64, high: f64) -> bool {
    matches!(q, Quality::Value(v) if (low..=high).contains(&v))
}

/// The voted predicate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vote {
    Satisfied,
    NotSatisfied,
    /// Fewer than two channels can resolve the predicate.
    Insufficient,
}

/// Vote the conclusive evidence of the family's usable channels (`None`:
/// a channel that cannot resolve this predicate supplies no vote).
pub fn vote(evidence: &[Option<bool>]) -> Result<Vote, String> {
    if evidence.len() > 3 {
        return Err(format!(
            "{} channels in a three-channel family",
            evidence.len()
        ));
    }
    let usable: Vec<bool> = evidence.iter().flatten().copied().collect();
    let affirmative = usable.iter().filter(|v| **v).count();
    Ok(match usable.len() {
        3 if affirmative >= 2 => Vote::Satisfied,
        3 => Vote::NotSatisfied,
        2 if affirmative == 2 => Vote::Satisfied,
        2 => Vote::NotSatisfied,
        _ => Vote::Insufficient,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_usable_need_two_two_need_both_one_establishes_nothing() {
        use Vote::*;
        assert_eq!(
            vote(&[Some(true), Some(true), Some(false)]).unwrap(),
            Satisfied
        );
        assert_eq!(
            vote(&[Some(true), Some(false), Some(false)]).unwrap(),
            NotSatisfied
        );
        assert_eq!(vote(&[Some(true), None, Some(true)]).unwrap(), Satisfied);
        assert_eq!(
            vote(&[Some(true), None, Some(false)]).unwrap(),
            NotSatisfied
        );
        assert_eq!(vote(&[Some(true), None, None]).unwrap(), Insufficient);
        assert_eq!(vote(&[None, None, None]).unwrap(), Insufficient);
        assert!(vote(&[None; 4]).is_err());
    }

    #[test]
    fn bounds_are_conclusive_only_on_their_side() {
        let low = Side::AtOrBelow(13e6);
        let high = Side::AtOrAbove(15.5e6);
        assert_eq!(predicate(Quality::Value(13e6), low), Some(true));
        assert_eq!(predicate(Quality::Value(13.001e6), low), Some(false));
        assert_eq!(predicate(Quality::Value(15.5e6), high), Some(true));
        assert_eq!(predicate(Quality::BelowRange(0.), low), Some(true));
        assert_eq!(predicate(Quality::BelowRange(0.), high), Some(false));
        assert_eq!(predicate(Quality::AboveRange(20e6), high), Some(true));
        assert_eq!(predicate(Quality::AboveRange(20e6), low), Some(false));
        // A bound beyond the setting cannot decide it (SG NR 4 m bound
        // against a 3 m setting, for instance).
        assert_eq!(
            predicate(Quality::BelowRange(4.), Side::AtOrBelow(3.)),
            None
        );
        assert_eq!(
            predicate(Quality::AboveRange(9.), Side::AtOrAbove(9.5)),
            None
        );
        assert_eq!(
            predicate(Quality::Value(0.2), Side::Above(0.2)),
            Some(false)
        );
        assert_eq!(
            predicate(Quality::Value(0.21), Side::Above(0.2)),
            Some(true)
        );
        // The FT band (±10 kg/s): conclusively below 0.70 of nominal, never
        // a sign.
        assert_eq!(
            predicate(Quality::Indeterminate(1e-3), Side::AtOrBelow(0.7)),
            Some(true)
        );
        assert_eq!(
            predicate(Quality::Indeterminate(1e-3), Side::AtOrAbove(0.8)),
            Some(false)
        );
        assert_eq!(
            predicate(Quality::Indeterminate(1e-3), Side::AtOrBelow(0.)),
            None
        );
        assert!(within(Quality::Value(14e6), 13.5e6, 15.2e6));
        assert!(!within(Quality::BelowRange(0.), -1., 1.));
    }
}

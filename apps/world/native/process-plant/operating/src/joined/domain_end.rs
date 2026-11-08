//! R4-ENDED: the named domain ends of a stopped unit. A table, not a
//! classifier: a refusal names one of these ends, or it stays a failure.
//!
//! - **`solidPzr`** (S3-D17): the stratified cell's level refusal, or the
//!   PZR vapor zone's inverse refused where the zone cannot outlast the next
//!   I&C frame: `M/|Ṁ|`, with `M` the refused state's vapor mass and `Ṁ` the
//!   last accepted state's rate, is shorter than the frame period. The frame
//!   is the unit's own declared period, not a tuned constant, and unlike the
//!   refused step it does not collapse to zero at a wall. A zone that would
//!   outlast the frame is not exhausted, so its refused inverse stays a
//!   failure.
//! - **`neckDryout`**: the dryout root of HOUSING.NECK (mode G is S6 scope).
//!   Another cell's dryout stays a failure.
//!
//! Nothing else is an end. C4 and C4-I do not reach rule I's 8 MPa floor
//! (no receipt below 10.6 MPa), which the unit does not judge, so it is not
//! in this table.
//!
//! The refusals are read from the cause the driver returned, so a refused
//! trial Newton recovered from names nothing: [`Refused`] is taken only after
//! the last accepted step.

use serde::Serialize;

use crate::network::stratified::{SOLID_PZR_LIMIT, VAPOR_ZONE_INVERSE};

/// One named end of the unit's domain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum DomainEnd {
    SolidPzr,
    NeckDryout,
}

impl DomainEnd {
    /// The end's name in the record.
    pub const fn label(self) -> &'static str {
        match self {
            Self::SolidPzr => "solidPzr",
            Self::NeckDryout => "neckDryout",
        }
    }
    /// The end in words, for the Plant.
    pub const fn plain(self) -> &'static str {
        match self {
            Self::SolidPzr => "pressurizer solid",
            Self::NeckDryout => "HOUSING.NECK dryout",
        }
    }
}

/// The last evaluation refused: its time and the PZR vapor mass it read (kg).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Refused {
    pub t: f64,
    pub vapor_mass_kg: f64,
}

/// What a stop offers the table.
#[derive(Clone, Copy, Debug)]
pub struct Stop<'a> {
    /// The cause the driver returned.
    pub cause: &'a str,
    /// The last refused evaluation.
    pub refused: Option<Refused>,
    /// The cell of a dryout the operator refused, if any.
    pub dryout: Option<usize>,
    /// HOUSING.NECK's cell.
    pub neck: Option<usize>,
    /// The last accepted step's time and PZR vapor mass rate (kg/s).
    pub accepted_s: f64,
    pub vapor_mass_rate_kg_s: f64,
    /// The unit's I&C frame period.
    pub frame_s: f64,
}

/// The end this stop names, or `None`: a failure.
pub fn named_end(stop: &Stop<'_>) -> Option<DomainEnd> {
    if stop.cause.contains(SOLID_PZR_LIMIT) {
        return Some(DomainEnd::SolidPzr);
    }
    if stop.cause.contains(VAPOR_ZONE_INVERSE) {
        // A refusal before the last accepted step was recovered from.
        let refused = stop.refused.filter(|r| r.t >= stop.accepted_s)?;
        let lasts = refused.vapor_mass_kg.abs() / stop.vapor_mass_rate_kg_s.abs();
        return (lasts < stop.frame_s).then_some(DomainEnd::SolidPzr);
    }
    match (stop.dryout, stop.neck) {
        (Some(c), Some(neck)) if c == neck => Some(DomainEnd::NeckDryout),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(cause: &str) -> Stop<'_> {
        Stop {
            cause,
            refused: None,
            dryout: None,
            neck: Some(7),
            accepted_s: 100.,
            vapor_mass_rate_kg_s: -33.8,
            frame_s: 0.1,
        }
    }

    #[test]
    fn the_level_refusals_name_the_solid_end() {
        for cause in [
            "stratified PZR: mixture level reaches upper port PZR.SPRAY: the solid-PZR structural limit",
            "fatal IDA callback: L1 root evaluation: Recoverable(\"stratified PZR: mixture level reaches the top head: the solid-PZR structural limit\")",
            "stock IDA status -8; last unavailable trial: Some(\"stratified PZR: mixture level reaches the relief port PZR.RELIEF: the solid-PZR structural limit\")",
        ] {
            assert_eq!(named_end(&stop(cause)), Some(DomainEnd::SolidPzr));
        }
    }

    #[test]
    fn the_vapor_inverse_ends_only_where_the_zone_cannot_outlast_a_frame() {
        let cause = "stratified PZR: the PZR vapor zone's inverse: actual local IF97 inverse";
        // The record: 12.6 g at 33.8 kg/s is 0.37 ms.
        let mut at = stop(cause);
        at.refused = Some(Refused {
            t: 100.02,
            vapor_mass_kg: 0.0126,
        });
        assert_eq!(named_end(&at), Some(DomainEnd::SolidPzr));
        // At a wall the step has collapsed: the refusal stands at the last
        // accepted time, and the end is still named (OVERP's R4-TIME-STOPPED).
        at.refused = Some(Refused {
            t: 100.,
            vapor_mass_kg: 0.0126,
        });
        assert_eq!(named_end(&at), Some(DomainEnd::SolidPzr));
        let stopped = "solver time stopped at 100 s: stock IDA accepted a step of 1e-20 s that \
            does not advance time; last unavailable trial: Some(\"stratified PZR: the PZR vapor \
            zone's inverse: actual local IF97 inverse\")";
        at.cause = stopped;
        assert_eq!(named_end(&at), Some(DomainEnd::SolidPzr));
        at.cause = cause;
        // A zone that would outlast the frame is a failure.
        at.refused = Some(Refused {
            t: 100.,
            vapor_mass_kg: 4.,
        });
        assert_eq!(named_end(&at), None);
        // So is a refusal the run recovered from, a stagnant zone, and an
        // inverse with no refused state.
        at.refused = Some(Refused {
            t: 99.9,
            vapor_mass_kg: 0.0126,
        });
        assert_eq!(named_end(&at), None);
        at.refused = Some(Refused {
            t: 100.,
            vapor_mass_kg: 0.0126,
        });
        at.vapor_mass_rate_kg_s = 0.;
        assert_eq!(named_end(&at), None);
        assert_eq!(named_end(&stop(cause)), None);
    }

    #[test]
    fn only_necks_dryout_ends_and_nothing_else_is_named() {
        let mut at = stop("dryout of cell 7 at t = 3 s: mode G is S6 scope (C4's declared end)");
        at.dryout = Some(7);
        assert_eq!(named_end(&at), Some(DomainEnd::NeckDryout));
        at.dryout = Some(3);
        assert_eq!(named_end(&at), None);
        for cause in [
            "stock IDA status -4; last unavailable trial: None",
            "actual local IF97 inverse p=1 specific=2 phase=1 h=false",
            "L1 root evaluation: a dryout of something",
            "pressure 7.9 MPa is below the floor",
        ] {
            assert_eq!(named_end(&stop(cause)), None, "{cause}");
        }
    }
}

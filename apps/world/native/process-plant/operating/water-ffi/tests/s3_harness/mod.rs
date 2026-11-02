//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-a3-pilot
//! The S3 case harness (C1–C3, and C5 from its own block: [`c5`]), included
//! by `s3_cases.rs`.
//!
//! - [`declaration`]: the pinned `ld01-s3-cases-c1c3` block read as data, the
//!   pin, the TBD register and each case's refusals (open values, missing
//!   model prerequisites);
//! - the timeline (`leitbild_operating_water::unit::timeline`): a
//!   frame-driven run's events on the case clock, from the driver's and the
//!   protection's own logs;
//! - [`observe`]: rule I on every accepted step and the gate observation
//!   (identities, ledgers, credited outputs, fingerprint) through the
//!   frame driver's observer hook;
//! - [`families`]: the gate families beside the lines (cost, smoothness,
//!   repeatability, spectra, directions, SS-1, SS-2);
//! - [`lines`]: every sequence line of a case judged on its timeline, with
//!   its window read from the block; a declared line the harness cannot
//!   judge is reported as such, never passed.
#![allow(dead_code)] // The unit tests and the case run use different subsets.
pub mod c4;
pub mod c5;
pub mod counters;
pub mod declaration;
pub mod families;
pub mod lines;
pub mod observe;

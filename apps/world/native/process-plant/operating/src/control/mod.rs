//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#ordinary-pressure-regulation
//! Normal (non-protective) control laws of the operating unit, sampled on
//! the declared 0.1 s I&C frame (S3-D1). Each law turns acquired evidence
//! into equipment demands; it owns no plant state and never reads solver
//! truth. Applying a demand to equipment is the composing frame driver's:
//! a held-input change at a frame instant, class S or R under S3-D1.
pub mod feed;
pub mod pzr_pressure;
pub mod rods;
pub mod spray_valve;

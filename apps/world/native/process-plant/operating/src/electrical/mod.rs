//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! ELEC S3 slice (C14/C15 slice): generator, generator breaker, auxiliary AC
//! routing and their composition with the turbine admission → torque block.
//! Equation blocks and discrete owners only; no integrator, no exchange law
//! (the Grid side's), no live runtime. The carrier is a continuous input of
//! the slice's angle row (owner decision D2). The field controller's
//! field-supply-loss protection is the generator page's (`field`, ICFIELD).
//! The five DC supply groups (`dc`, on the page's provider `dc_supply`) are
//! report-only in LD-01 1.0 (PROC T5).
pub mod breaker;
pub mod bus;
pub mod dc;
pub mod dc_supply;
pub mod field;
pub mod generator;
pub mod slice;

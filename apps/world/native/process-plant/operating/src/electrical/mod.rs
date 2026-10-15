//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#one-convention-and-conservative-machine-equations
//! ELEC S3 slice (C14/C15 slice): generator, generator breaker, auxiliary AC
//! routing and their composition with the turbine admission → torque block.
//! Equation blocks and discrete owners only; no integrator, no exchange law,
//! no carrier-angle choice, no live runtime.
pub mod breaker;
pub mod bus;
pub mod generator;
pub mod slice;

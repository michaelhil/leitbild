//! Reusable equation blocks for the approved compact operating model.
//!
//! This standalone crate does not import the fine research kernel, select a
//! solver, prepare a successful plant state, or install the live LD-01 runtime.
//! Callers own plant coefficients, equipment mappings and constitutive inputs.

pub mod capture;
pub mod heat_history;
pub mod kinetics;
pub mod poisons;

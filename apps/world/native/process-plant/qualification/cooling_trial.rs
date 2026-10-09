//! Shared existing cold qualification trial-domain and error-scale policy.
//! The advancing and fixed-stage entries must not maintain different lists.
use leitbild_plant_numerics::{control_source_geometry, source_cooling};
pub(super) fn progress_relative(model: &source_cooling::Model, row: usize) -> bool {
    row < model.layout.source_end
        || (model.layout.carrier_start..model.layout.energies_start).contains(&row)
        || row == model.layout.barrel_released
        || row == model.layout.barrel_exported
        || row == model.layout.fuel_capture_exported
        || row == model.layout.mobile_capture_exported
        || row == model.layout.mobile_capture_boundary_exported
        || row == model.layout.absorber_guide_exported
        || (model.layout.surge_carrier_start..=model.layout.gas_hydrogen_product).contains(&row)
}
pub(super) fn state_error_scale(
    model: &source_cooling::Model,
    row: usize,
    value: f64,
    absolute: f64,
    relative: f64,
) -> f64 {
    absolute
        + if progress_relative(model, row) {
            relative * value.abs()
        } else {
            0.
        }
}
pub(super) fn recoverable(error: &str) -> bool {
    matches!(
        error,
        "Invalid same-trial fuel instance inputs/workspace"
            | "Invalid native water/finite target/liquid B10 support"
            | "Invalid actual passive target stocks/workspace"
            | "Invalid actual cylinder target/workspace"
            | "Invalid advancing optical target amounts"
            | "Water carrier trial exhausted a target"
            | "Clad wall outside selected preboiling liquid branch"
            | "Fuel/clad temperature outside selected material domain"
            | "Helium temperature outside selected cold package domain"
            | "Nonpositive finite solid temperature"
            | "Unsupported local pressure/energy chart"
            | "Cold surge left its finite liquid/temperature domain"
            | "PZR left positive cold dilute pool/cushion domain"
            | "PZR pool left selected covered cold envelope"
            | "PZR metal caloric domain"
            | "Cold PZR interface left dilute separated-water branch"
    ) || error == control_source_geometry::OUTSIDE_TRIAL_DOMAIN
        || error.starts_with("Invalid water trial ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_finite_control_trial_domain_is_retryable() {
        assert!(recoverable(control_source_geometry::OUTSIDE_TRIAL_DOMAIN));
        for e in ["Nonfinite current control geometry pose/direction",
            "Current control pose inconsistent with retained branch",
            "Wrong current cluster geometry/workspace shape"] {
            assert!(!recoverable(e));
        }
    }
}

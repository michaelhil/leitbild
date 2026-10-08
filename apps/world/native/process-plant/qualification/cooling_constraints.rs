//! Shared physical positivity constraints for the existing SOURCE/cooling
//! prefix. Appended mechanisms add their own coordinates at their owner.
use leitbild_plant_numerics::{cold_pressurizer, finite_surge, source_cooling};

pub fn physical_constraints(model: &source_cooling::Model, energy_row: usize) -> Vec<f64> {
    let l = model.layout;
    let mut out = vec![0.; model.dimension()];
    out[..l.source_end].fill(1.);
    out[model.source.ledger_row()] = 0.;
    out[energy_row] = 0.;
    out[l.carrier_start..l.energies_start].fill(1.);
    out[l.temperatures_start..l.barrel_energy].fill(2.);
    out[l.barrel_temperature] = 2.;
    out[l.barrel_released] = 1.;
    out[l.barrel_exported] = 1.;
    out[l.fuel_capture_exported] = 1.;
    out[l.mobile_capture_exported] = 1.;
    out[l.mobile_capture_boundary_exported] = 1.;
    out[l.absorber_guide_temperatures_start..l.absorber_guide_exported].fill(2.);
    out[l.absorber_guide_exported] = 1.;
    for row in [
        cold_pressurizer::LIQUID_MASS,
        cold_pressurizer::VAPOR_MASS,
        cold_pressurizer::LIQUID_TEMPERATURE,
        cold_pressurizer::GAS_TEMPERATURE,
        cold_pressurizer::SURFACE_PRESSURE,
        cold_pressurizer::VAPOR_PRESSURE,
        cold_pressurizer::HEIGHT,
        cold_pressurizer::INTERFACE_TEMPERATURE,
        cold_pressurizer::LIQUID_PRESSURE,
    ] {
        out[l.pressurizer_start + row] = 2.;
    }
    out[l.pressurizer_start + cold_pressurizer::METAL_TEMPERATURE_START..l.surge_start].fill(2.);
    for row in [
        finite_surge::MASS,
        finite_surge::PRESSURE,
        finite_surge::TEMPERATURE,
        finite_surge::STEEL_TEMPERATURE,
    ] {
        out[l.surge_start + row] = 2.;
    }
    out[l.surge_carrier_start..=l.gas_hydrogen_product].fill(1.);
    // Ambient receipt and both signed endpoint flows remain unconstrained.
    out
}

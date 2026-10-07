//! Required fresh pressure-support preparation; never a reached-state reset.
use super::*;
use leitbild_plant_numerics::{CellGeometry, GRAVITY, cold_pressurizer as cp, finite_surge as fs};

/// Fresh preparation of the selected bulk-density hydrostatic force, not a
/// runtime inverse or a correction to reached stocks.
fn fresh_line_pressure(
    takeoff: f64,
    temperature: f64,
    height_difference: f64,
) -> Result<(f64, f64), String> {
    let mut pressure = takeoff;
    for _ in 0..12 {
        let mut liquid = [leitbild_plant_numerics::Liquid::default()];
        leitbild_plant_numerics::liquid_batch(
            &[leitbild_plant_numerics::LiquidQuery {
                pressure,
                temperature,
            }],
            &mut liquid,
        )
        .map_err(|e| format!("Fresh surge hydrostatic property: {e:?}"))?;
        let l = liquid[0];
        let head = l.density * GRAVITY * height_difference;
        let residual = pressure - takeoff - head;
        let derivative = 1. - l.density * l.compressibility * GRAVITY * height_difference;
        if !residual.is_finite() || !derivative.is_finite() || derivative <= 0. {
            return Err("Invalid fresh surge hydrostatic derivative".into());
        }
        if residual.abs() <= 8. * f64::EPSILON * (pressure.abs() + takeoff.abs() + head.abs()) {
            return Ok((pressure, l.density));
        }
        pressure -= residual / derivative;
        if !pressure.is_finite() || pressure <= 0. {
            return Err("Nonpositive fresh surge hydrostatic pressure".into());
        }
    }
    Err("Fresh surge hydrostatic preparation exceeded12iterations".into())
}

pub(super) fn parse(
    words: &[&str],
    network: &operating_network::Network,
    initial: &[f64],
    work: &operating_network::Workspace,
    href: f64,
    bref: f64,
) -> Result<source_cooling::PressureConnection, String> {
    let mut w = words.iter().copied();
    let primary_cell = count(&mut w);
    if primary_cell >= network.config().water.len() {
        return Err("Pressure takeoff is not a primary water cell".into());
    }
    let surge = fs::Model::new(fs::Input {
        geometry: CellGeometry {
            volume: number(&mut w),
            elevation: number(&mut w),
        },
        length: number(&mut w),
        diameter: number(&mut w),
        roughness: number(&mut w),
        terminal_loss: number(&mut w),
        bend_loss_each: number(&mut w),
        steel_mass: number(&mut w),
        cp0: number(&mut w),
        cp1: number(&mut w),
        datum_temperature: number(&mut w),
        minimum_temperature: number(&mut w),
        maximum_temperature: number(&mut w),
        wet_conductance: number(&mut w),
        ambient_conductance: number(&mut w),
        ambient_temperature: number(&mut w),
    })?;
    let area = number(&mut w);
    let height = number(&mut w);
    let bottom_elevation = number(&mut w);
    let rods = std::array::from_fn(|_| cp::Rod {
        displacement_area: number(&mut w),
        height: number(&mut w),
    });
    let mut input = cp::Input {
        area,
        height,
        bottom_elevation,
        rods,
        minimum_level: number(&mut w),
        maximum_level: number(&mut w),
        minimum_fluid_temperature: number(&mut w),
        maximum_fluid_temperature: number(&mut w),
        maximum_total_pressure: number(&mut w),
        maximum_vapor_pressure: number(&mut w),
        air_mass: 0.,
        nitrogen_mass: number(&mut w),
        interface_length: number(&mut w),
        diffusivity_reference: number(&mut w),
        diffusivity_reference_temperature: number(&mut w),
        diffusivity_reference_pressure: number(&mut w),
        diffusivity_exponent: number(&mut w),
        gas_conductivity: number(&mut w),
        wet_coefficient: number(&mut w),
        gas_coefficient: number(&mut w),
        condensation_speed: number(&mut w),
        cp0: number(&mut w),
        cp1: number(&mut w),
        datum_temperature: number(&mut w),
        minimum_metal_temperature: number(&mut w),
        maximum_metal_temperature: number(&mut w),
        ambient_temperature: number(&mut w),
        metals: [cp::Metal {
            mass: 0.,
            ambient_conductance: 0.,
            contact: cp::Contact::Bottom { area: 0. },
        }; cp::METALS],
        radiation: Vec::new(),
    };
    for metal in &mut input.metals {
        let mass = number(&mut w);
        let ambient_conductance = number(&mut w);
        let tag = count(&mut w);
        let contact = match tag {
            0 => cp::Contact::Rod {
                height: number(&mut w),
                area: number(&mut w),
            },
            1 => cp::Contact::Shell {
                bottom: number(&mut w),
                top: number(&mut w),
                area: number(&mut w),
            },
            2 => cp::Contact::Bottom {
                area: number(&mut w),
            },
            3 => cp::Contact::Top {
                area: number(&mut w),
            },
            _ => return Err("Unknown pressure metal contact".into()),
        };
        *metal = cp::Metal {
            mass,
            ambient_conductance,
            contact,
        };
    }
    let nr = count(&mut w);
    if nr > w.len() / 3 {
        return Err("Pressure radiation count exceeds frame".into());
    }
    input.radiation = (0..nr)
        .map(|_| cp::Radiation {
            from: count(&mut w),
            to: count(&mut w),
            effective_area: number(&mut w),
        })
        .collect();
    let tl = number(&mut w);
    let tg = number(&mut w);
    let level = number(&mut w);
    let metals = std::array::from_fn(|_| number(&mut w));
    let line_temperature = number(&mut w);
    let line_steel_temperature = number(&mut w);
    if w.next().is_some() {
        return Err("Trailing pressure-support frame".into());
    }
    let takeoff_pressure = network.mechanical_pressure(primary_cell, initial);
    let takeoff_height = network.config().water[primary_cell].geometry.elevation;
    let line_height = surge.input().geometry.elevation;
    let (line_pressure, density) = fresh_line_pressure(
        takeoff_pressure,
        line_temperature,
        takeoff_height - line_height,
    )?;
    let bottom_pressure = line_pressure + density * GRAVITY * (line_height - bottom_elevation);
    let (pressurizer, initial_pressurizer) =
        cp::Model::prepare_at_bottom_pressure(input, bottom_pressure, tl, tg, level, metals)?;
    let initial_surge = surge.prepare(line_pressure, line_temperature, line_steel_temperature)?;
    let marker = initial[network.marker_row(primary_cell)];
    let initial_b = bref * work.chart_mass[primary_cell];
    let atoms_per_marker = initial_b / marker;
    if !atoms_per_marker.is_finite() || atoms_per_marker <= 0. {
        return Err(
            "Pressure chemistry requires finite positive original B/marker conversion".into(),
        );
    }
    let material = |mass: f64| water_carrier::Amounts {
        hydrogen: 0.,
        boron10: bref * mass,
        boron: 0.,
    };
    if !href.is_finite() || href <= 0. {
        return Err("Pressure chemistry requires actual water H reference".into());
    }
    Ok(source_cooling::PressureConnection {
        primary_cell,
        surge,
        pressurizer,
        initial_line: material(initial_surge[fs::MASS]),
        initial_pool: material(initial_pressurizer[cp::LIQUID_MASS]),
        initial_gas_hydrogen_product: 0.,
        atoms_per_marker,
        initial_surge,
        initial_pressurizer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_hydrostatic_seed_uses_actual_line_density_and_closes_both_halves() {
        for dz in [-8., 0., 8.] {
            let (p, rho) = fresh_line_pressure(3e5, 301., dz).unwrap();
            let defect = p - 3e5 - rho * GRAVITY * dz;
            assert!(
                defect.abs() <= 8. * f64::EPSILON * (p.abs() + 3e5 + (rho * GRAVITY * dz).abs())
            );
            let bottom = p + rho * GRAVITY * 4.;
            assert!((p - bottom + rho * GRAVITY * 4.).abs() < 1e-10);
        }
        assert!(fresh_line_pressure(f64::NAN, 300., 0.).is_err());
    }
}

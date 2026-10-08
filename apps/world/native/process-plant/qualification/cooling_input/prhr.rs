//! One explicit optional apparatus frame, not a legacy frame reader. Geometry,
//! resource boundaries and the qualification action have separate ownership.
use super::{count, number, PrhrAction};
use leitbild_plant_numerics::{finite_wst, operating_network, prhr, prhr_actuator};

fn boolean<'a>(words: &mut impl Iterator<Item = &'a str>) -> Result<bool, String> {
    match words.next() {
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => Err("Expected explicit PRHR boolean 0/1".into()),
    }
}

pub(super) fn parse(
    frame: &[&str],
    config: &mut operating_network::Config,
) -> Result<Option<PrhrAction>, String> {
    let mut words = frame.iter().copied();
    if !boolean(&mut words)? {
        if words.next().is_some() {
            return Err("Disabled PRHR frame has trailing data".into());
        }
        return Ok(None);
    }
    let seat = operating_network::Seat {
        edge: count(&mut words),
        area: number(&mut words),
        full_open_loss: number(&mut words),
    };
    let wst = finite_wst::Config {
        area_m2: number(&mut words),
        floor_m: number(&mut words),
        hardware_volume_m3: number(&mut words),
        hardware_first_moment_m4: number(&mut words),
        minimum_fully_wet_height_m: number(&mut words),
        maximum_height_m: number(&mut words),
        surface_mass_transfer_m_s: number(&mut words),
        initial_water_volume_m3: number(&mut words),
        initial_temperature_k: number(&mut words),
    };
    let gas = finite_wst::GasBoundary::from_relative_humidity(
        number(&mut words),
        number(&mut words),
        number(&mut words),
    )?;
    let actuator = prhr_actuator::Config {
        stroke_s: number(&mut words),
        spring_energy_j: number(&mut words),
        closing_power_w: number(&mut words),
        hold_power_w: number(&mut words),
        room_capacity_j_k: number(&mut words),
        room_wall_w_k: number(&mut words),
        room_reference_temperature_k: number(&mut words),
        initial_opening: number(&mut words),
        initial_room_temperature_k: number(&mut words),
    };
    let action = PrhrAction {
        blocked: boolean(&mut words)?,
        ambient_temperature_k: number(&mut words),
    };
    if !action.ambient_temperature_k.is_finite() || action.ambient_temperature_k <= 0. {
        return Err("Invalid PRHR qualification action/boundary".into());
    }
    let n = count(&mut words);
    if n > words.len() / 8 {
        return Err("PRHR liquid contacts exceed frame".into());
    }
    let mut liquid_contacts = Vec::with_capacity(n);
    for _ in 0..n {
        let water = count(&mut words);
        let solid = count(&mut words);
        let area = number(&mut words);
        let diameter = number(&mut words);
        let flow_area = number(&mut words);
        let flow_edge = count(&mut words);
        let half_resistance = number(&mut words);
        let weight = match count(&mut words) {
            0 => prhr::ContactWeight::Fixed,
            1 => prhr::ContactWeight::DiscSameSide,
            2 => prhr::ContactWeight::DiscOtherSide,
            _ => return Err("Unknown physical disc contact weight".into()),
        };
        liquid_contacts.push(prhr::LiquidContact {
            water,
            solid,
            area,
            diameter,
            flow_area,
            flow_edge,
            half_resistance,
            weight,
        });
    }
    let n = count(&mut words);
    if n > words.len() / 6 {
        return Err("PRHR pool contacts exceed frame".into());
    }
    let pool_contacts = (0..n)
        .map(|_| prhr::PoolContact {
            solid: count(&mut words),
            area: number(&mut words),
            diameter: number(&mut words),
            elevation: number(&mut words),
            half_resistance: number(&mut words),
            bank_factor: number(&mut words),
        })
        .collect();
    let n = count(&mut words);
    if n > words.len() / 2 {
        return Err("PRHR gas contacts exceed frame".into());
    }
    let gas_contacts = (0..n)
        .map(|_| prhr::GasContact {
            solid: count(&mut words),
            conductance: number(&mut words),
        })
        .collect();
    let n = count(&mut words);
    if n > words.len() / 5 {
        return Err("PRHR axial contacts exceed frame".into());
    }
    let axial = (0..n)
        .map(|_| {
            Ok(prhr::Axial {
                from: count(&mut words),
                to: count(&mut words),
                area: number(&mut words),
                separation: number(&mut words),
                seat: boolean(&mut words)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let n = count(&mut words);
    if n > words.len() / 13 {
        return Err("PRHR mixing contacts exceed frame".into());
    }
    let mixing = (0..n)
        .map(|_| prhr::Mixing {
            from: count(&mut words),
            to: count(&mut words),
            area: number(&mut words),
            separation: number(&mut words),
            diameter: number(&mut words),
            slope: number(&mut words),
            penetration_average: number(&mut words),
            sg_flow_edge: count(&mut words),
            sg_water: count(&mut words),
            sg_flow_area: number(&mut words),
            coefficient: number(&mut words),
            prandtl: number(&mut words),
            schmidt: number(&mut words),
        })
        .collect();
    if words.next().is_some() {
        return Err("Trailing PRHR apparatus frame".into());
    }
    config.seat = Some(seat);
    config.prhr = Some(prhr::Config {
        wst,
        gas,
        actuator,
        liquid_contacts,
        pool_contacts,
        gas_contacts,
        axial,
        mixing,
    });
    Ok(Some(action))
}

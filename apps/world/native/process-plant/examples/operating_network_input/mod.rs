//! Shared strict numerical input for the offline network and fixed matrix audit.
use leitbild_plant_numerics::operating_network::*;
use leitbild_plant_numerics::original_water::OriginalField;
pub struct Input {
    pub config: Config,
    pub horizon: f64,
    pub budget: f64,
}
pub fn value<T: std::str::FromStr>(
    tokens: &mut std::str::SplitWhitespace<'_>,
) -> Result<T, String> {
    tokens
        .next()
        .ok_or("Missing operating network numeric input")?
        .parse()
        .map_err(|_| "Invalid operating network numeric input".into())
}

pub fn parse(tokens: &mut std::str::SplitWhitespace<'_>) -> Result<Input, String> {
    let nw: usize = value(tokens)?;
    let ns: usize = value(tokens)?;
    let ne: usize = value(tokens)?;
    let nh: usize = value(tokens)?;
    let horizon: f64 = value(tokens)?;
    let budget: f64 = value(tokens)?;
    if !horizon.is_finite()
        || horizon < 60.
        || horizon > 300.
        || horizon.fract() != 0.
        || !budget.is_finite()
        || budget <= 0.
        || budget > 120.
    {
        return Err(
            "Expected useful integer horizon 60..300 s and aggregate allowance <=120 s".into(),
        );
    }
    let anchor_p: f64 = value(tokens)?;
    let anchor_t: f64 = value(tokens)?;
    let anchor_z: f64 = value(tokens)?;
    let minimum_span: f64 = value(tokens)?;
    let original_mass_screen: f64 = value(tokens)?;
    let original = OriginalField::new(
        anchor_p,
        anchor_t,
        anchor_z,
        minimum_span,
        original_mass_screen,
    )?;
    let mut water = vec![];
    for _ in 0..nw {
        let volume = value(tokens)?;
        let elevation = value(tokens)?;
        let initial_tracer_fraction = value(tokens)?;
        let liquid = original.at(elevation)?;
        water.push(Water {
            geometry: leitbild_plant_numerics::CellGeometry { volume, elevation },
            initial_pressure: liquid.pressure,
            initial_temperature: liquid.temperature,
            initial_tracer_fraction,
        });
    }
    let mut solids = vec![];
    for _ in 0..ns {
        solids.push(Solid {
            heat_capacity: value(tokens)?,
            initial_temperature: value(tokens)?,
        });
    }
    let mut hydraulic = vec![];
    for _ in 0..ne {
        let kind: u32 = value(tokens)?;
        let from = value(tokens)?;
        let to = value(tokens)?;
        let length = value(tokens)?;
        let flow_area = value(tokens)?;
        let diameter = value(tokens)?;
        let roughness = value(tokens)?;
        let fixed_loss = value(tokens)?;
        let grid_value: f64 = value(tokens)?;
        let law = match kind {
            0 => LossLaw::EffectiveTotal,
            1 => LossLaw::ChurchillPipe,
            2 => LossLaw::ChurchillAnnulus,
            3 => LossLaw::CoreBundle,
            4 => LossLaw::GuideAnnulus {
                laminar_darcy: grid_value,
            },
            5 => LossLaw::SmoothColebrook,
            _ => return Err("Unknown explicitly supported hydraulic law".into()),
        };
        hydraulic.push(Hydraulic {
            from,
            to,
            law,
            length,
            flow_area,
            diameter,
            roughness,
            fixed_loss,
            grid_multiplier: if kind == 4 { 0. } else { grid_value },
        });
    }
    let mut heat = vec![];
    for _ in 0..nh {
        let kind: u32 = value(tokens)?;
        let from = value(tokens)?;
        let to = value(tokens)?;
        let law = match kind {
            0 => HeatLaw::Conductance(value(tokens)?),
            1 => HeatLaw::LiquidFilm {
                geometry: value(tokens)?,
            },
            2 => HeatLaw::SgSensible {
                area: value(tokens)?,
                diameter: value(tokens)?,
                flow_area: value(tokens)?,
                hydraulic_edge: value(tokens)?,
            },
            _ => return Err("Unknown explicitly supported thermal law".into()),
        };
        heat.push(Heat { from, to, law });
    }
    let nk: usize = value(tokens)?;
    let ncontact: usize = value(tokens)?;
    let mut secondaries = vec![];
    let mut secondary_heat = vec![];
    for _ in 0..nk {
        secondaries.push(Secondary {
            volume: value(tokens)?,
            initial_temperature: value(tokens)?,
            initial_pressure: value(tokens)?,
            initial_liquid_volume: value(tokens)?,
            initial_nitrogen_mass: value(tokens)?,
            minimum_wetted_liquid_volume: value(tokens)?,
        });
    }
    for _ in 0..ncontact {
        secondary_heat.push(SecondaryHeat {
            solid: value(tokens)?,
            secondary: value(tokens)?,
            area: value(tokens)?,
            diameter: value(tokens)?,
        });
    }
    let config = Config {
        water,
        solids,
        hydraulic,
        heat,
        secondaries,
        secondary_heat,
    };
    Network::new(config.clone())?;
    Ok(Input {
        config,
        horizon,
        budget,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const INPUT: &str = "2 1 1 1 300 120 300000 300 2.5 0.5 2e-8
        1 2.5 0.002 2 2.5 0.002 1000 313
        0 0 1 1 0.1 0.356 0 1 0
        0 0 2 10 0 0";
    #[test]
    fn unchanged_network_format_stops_exactly_before_diagnostic_suffix() {
        let with_suffix = format!("{INPUT} 7");
        let mut tokens = with_suffix.split_whitespace();
        let input = parse(&mut tokens).unwrap();
        assert_eq!(input.horizon, 300.);
        assert_eq!(input.budget, 120.);
        assert_eq!(input.config.water.len(), 2);
        assert_eq!(input.config.solids.len(), 1);
        assert_eq!(input.config.hydraulic.len(), 1);
        assert_eq!(input.config.heat.len(), 1);
        assert_eq!(Network::new(input.config).unwrap().dimension(), 11);
        assert_eq!(tokens.next(), Some("7"));
        assert_eq!(tokens.next(), None);
    }
    #[test]
    fn malformed_numeric_input_is_not_skipped() {
        assert!(parse(&mut "2 1".split_whitespace()).is_err());
        let invalid = INPUT.replace("0 0 1 1 0.1", "99 0 1 1 0.1");
        assert!(parse(&mut invalid.split_whitespace()).is_err());
    }
}

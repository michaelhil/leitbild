//! A finite ORIGINAL point preparation, not neutron or hydraulic advancement.
use leitbild_plant_numerics::{GRAVITY, original_water::OriginalField};
use std::io::{self, Read};

fn main() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let mut values = input.split_whitespace();
    let mut number = || {
        values
            .next()
            .ok_or("Missing original input")?
            .parse::<f64>()
            .map_err(|e| e.to_string())
    };
    let p = number()?;
    let t = number()?;
    let z = number()?;
    let minimum_span = number()?;
    let relative_mass_screen = number()?;
    let count = number()?;
    if count < 1.0 || count.fract() != 0.0 || count > 1_000_000.0 {
        return Err("Invalid point count".into());
    }
    let field = OriginalField::new(p, t, z, minimum_span, relative_mass_screen)?;
    let mixed = field.mixed_lower()?;
    let datum = field.at(z)?;
    println!(
        "{{\"kind\":\"datum\",\"pressure_Pa\":{:.17e},\"temperature_K\":{:.17e},\"entropy_J_kg_K\":{:.17e},\"H_J_kg\":{:.17e}}}",
        datum.pressure,
        datum.temperature,
        datum.entropy,
        datum.enthalpy + GRAVITY * z
    );
    for _ in 0..count as usize {
        let kind = number()?;
        let elevation = number()?;
        if kind != 0.0 && kind != 1.0 {
            return Err("Unknown original field owner".into());
        }
        let q = if kind == 1.0 {
            mixed
        } else {
            field.at(elevation)?
        };
        println!(
            "{{\"pressure_Pa\":{:.17e},\"temperature_K\":{:.17e},\"density_kg_m3\":{:.17e},\"u_J_kg\":{:.17e},\"h_J_kg\":{:.17e},\"s_J_kg_K\":{:.17e}}}",
            q.pressure, q.temperature, q.density, q.internal_energy, q.enthalpy, q.entropy
        );
    }
    if values.next().is_some() {
        return Err("Trailing original input".into());
    }
    Ok(())
}

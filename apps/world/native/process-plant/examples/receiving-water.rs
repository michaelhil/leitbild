//! ORIGINAL receiving-bay bulk property preparation. Not the primary H/S field
//! or a reached-state reset. The bay owner selects uniform density at its CNV
//! surface P/T; geometric moments and finite stocks are assembled by Bun.
use leitbild_plant_numerics::{Liquid, LiquidQuery, liquid_batch};
use std::io::{self, Read};

fn main() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let mut words = input.split_whitespace();
    let count = words
        .next()
        .ok_or("Missing count")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    if count == 0 || count > input.len() / 2 {
        return Err("Invalid receiving point count".into());
    }
    let mut queries = Vec::with_capacity(count);
    for _ in 0..count {
        let mut number = || {
            words
                .next()
                .ok_or("Missing receiving datum")?
                .parse::<f64>()
                .map_err(|e| e.to_string())
        };
        queries.push(LiquidQuery {
            pressure: number()?,
            temperature: number()?,
        });
    }
    if words.next().is_some() {
        return Err("Trailing receiving input".into());
    }
    let mut output = vec![Liquid::default(); count];
    liquid_batch(&queries, &mut output)
        .map_err(|e| format!("Receiving datum {}: {}", e.index, e.message))?;
    for q in output {
        println!(
            "{{\"pressure_Pa\":{:.17e},\"temperature_K\":{:.17e},\"density_kg_m3\":{:.17e},\"u_J_kg\":{:.17e},\"h_J_kg\":{:.17e}}}",
            q.pressure, q.temperature, q.density, q.internal_energy, q.enthalpy
        );
    }
    Ok(())
}

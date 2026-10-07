use super::{count, number};
use leitbild_plant_numerics::fuel_capture::{Band, Input};
pub(super) fn parse(words: &[&str]) -> Result<Input, String> {
    let mut w = words.iter().copied();
    if w.len() < 10 {
        return Err("Incomplete required fuel-capture frame".into());
    }
    let input = Input {
        capture_j: std::array::from_fn(|_| number(&mut w)),
        fuel_chord_m: number(&mut w),
        fuel_density: number(&mut w),
        fuel_mu: number(&mut w),
        clad_density: number(&mut w),
        clad_mu: number(&mut w),
        water_mu: number(&mut w),
        bands: Vec::new(),
    };
    let n = count(&mut w);
    if n == 0 || w.len() != 6 * n {
        return Err("Fuel-capture band/frame size mismatch".into());
    }
    let bands = (0..n)
        .map(|_| Band {
            thermal_band: count(&mut w),
            water: count(&mut w),
            water_chord_m: number(&mut w),
            clad_thickness_m: std::array::from_fn(|_| number(&mut w)),
        })
        .collect();
    Ok(Input { bands, ..input })
}

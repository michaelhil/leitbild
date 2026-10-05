//! Matched local cost probe, not plant advancement or a server benchmark.
use leitbild_plant_numerics::*;
use std::{hint::black_box, time::Instant};

fn main() {
    let mut query = [LiquidQuery {
        temperature: 313.15,
        pressure: 15.2e6,
    }; 128];
    let mut water = [Liquid::default(); 128];
    let g = CellGeometry {
        volume: 0.03,
        elevation: 5.,
    };
    for width in [1, 128] {
        for repetition in 0..3 {
            let began = Instant::now();
            let mut checksum = 0.;
            for batch in 0..128 {
                for (j, q) in query[..width].iter_mut().enumerate() {
                    let i = batch * width + j;
                    *q = LiquidQuery {
                        temperature: 313.15 + (i % 200) as f64 * 0.1,
                        pressure: 15.2e6 + (i % 100) as f64 * 100.,
                    };
                }
                liquid_batch(black_box(&query[..width]), black_box(&mut water[..width])).unwrap();
                for w in &water[..width] {
                    let p = 1.2 * g.volume * w.density;
                    let s = storage(g, *w, p, 2.).unwrap();
                    let j = storage_jacobian(g, *w, p, 2.).unwrap();
                    checksum += black_box(
                        s.energy
                            + j.energy_temperature
                            + j.mass_pressure
                            + j.energy_pressure
                            + j.mass_temperature
                            + j.energy_momentum,
                    );
                }
            }
            println!(
                "{{\"language\":\"rust\",\"width\":{width},\"repetition\":{repetition},\"tuples\":{},\"seconds\":{},\"checksum\":{checksum}}}",
                width * 128,
                began.elapsed().as_secs_f64()
            );
        }
    }
}

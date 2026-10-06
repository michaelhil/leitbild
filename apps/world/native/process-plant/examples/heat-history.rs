//! Offline cost witness of actual group data and repeated material stages.
//! No neutron calculation, source qualification or whole-unit speed claim.
use leitbild_plant_numerics::heat_history::{Feed, Group, Kernel, Rates};
use std::{
    hint::black_box,
    io::{self, Read},
    time::Instant,
};
fn main() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let mut tokens = input.split_whitespace();
    fn next<T: std::str::FromStr>(tokens: &mut std::str::SplitWhitespace<'_>) -> Result<T, String> {
        tokens
            .next()
            .ok_or("Missing input")?
            .parse()
            .map_err(|_| "Invalid input".into())
    }
    let segments: usize = next(&mut tokens)?;
    let count: usize = next(&mut tokens)?;
    let fission_energy: f64 = next(&mut tokens)?;
    let mut groups = Vec::with_capacity(count);
    for _ in 0..count {
        let feed = match next::<u8>(&mut tokens)? {
            0 => Feed::Fission,
            1 => Feed::FertileCapture,
            _ => return Err("Invalid feed".into()),
        };
        groups.push(Group {
            feed,
            energy_per_event: next(&mut tokens)?,
            decay_rate: next(&mut tokens)?,
        });
    }
    let size = segments
        .checked_mul(count)
        .ok_or("Unrepresentable material bank")?;
    if size == 0 {
        return Err("Empty material bank".into());
    }
    let history: Vec<f64> = (0..size)
        .map(|_| next(&mut tokens))
        .collect::<Result<_, _>>()?;
    if tokens.next().is_some() {
        return Err("Unexpected input".into());
    }
    let kernel = Kernel::new(groups, fission_energy)?;
    let mut trial = vec![0.; size];
    let mut rhs = vec![0.; size];
    let start = Instant::now();
    let mut stages = 0usize;
    let mut checksum = 0.;
    // Duration controls measurement precision only. It is not a simulated
    // interval or an artificial source-update cadence.
    while start.elapsed().as_secs_f64() < 0.25 {
        let cj = 10. + (stages % 13) as f64;
        for segment in 0..segments {
            let range = segment * count..(segment + 1) * count;
            let rates = Rates {
                fission: 1e17 * (1. + (segment % 7) as f64 / 100.),
                fertile_capture: 7e16,
            };
            let heat = kernel.stage_into(
                cj,
                &history[range.clone()],
                black_box(rates),
                &mut trial[range.clone()],
            )?;
            kernel.rhs_into(&trial[range.clone()], rates, &mut rhs[range])?;
            checksum += black_box(heat.delayed);
        }
        stages += 1;
    }
    let seconds = start.elapsed().as_secs_f64();
    println!(
        "{{\"segments\":{segments},\"groups\":{},\"physicalStores\":{size},\"stageAndRhsEvaluations\":{stages},\"wallSeconds\":{seconds},\"secondsPerMaterialBankStageAndRhs\":{},\"checksum\":{checksum},\"scope\":\"history block only; no neutron, material feedback or thermal solve\"}}",
        kernel.group_count(),
        seconds / stages as f64
    );
    Ok(())
}

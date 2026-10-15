//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#trial-and-accepted-states
//! Evaluations on and next to the saturation line are deterministic and
//! smooth to round-off (DR S3-REBIRTH). A just-exhausted cell sits on its
//! saturated endpoint, `u = u_f(p0)`; the restart's projection moves its
//! pressure by a few parts in 1e9 and needs the cell's density there smooth
//! well below its 1e-12 bound. The probe inverts `(p, u_f(p0))` at 201
//! pressures within ±1e-9 relative of `p0`, on each branch's endpoint, and
//! measures the relative density's scatter about its least-squares line and
//! the jump of the two sides' lines at `p0`. The floor is the forward EOS's
//! own round-off: region 1's u(T) carries about 1e-14 of u in round-off near
//! saturation, which at 15.5 MPa is about 1e-13 in density at fixed u (the
//! accepted inverse sat at up to its 2e-12 tolerance, 2e-11 in density).
use leitbild_operating_water::{Branch, CaloricLinearization, point};

fn endpoint(branch: Branch, p: f64) -> f64 {
    let saturated = match branch {
        Branch::Liquid => Branch::SaturatedLiquid,
        _ => Branch::SaturatedVapor,
    };
    point(saturated, p, 0.).unwrap().internal_energy_j_kg
}

/// Least-squares line `a + b x` of `samples`; returns `(a, b, max scatter)`.
fn line(samples: &[(f64, f64)]) -> (f64, f64, f64) {
    let m = samples.len() as f64;
    let (mx, my) = samples
        .iter()
        .fold((0., 0.), |(a, b), (x, y)| (a + x / m, b + y / m));
    let (sxx, sxy) = samples.iter().fold((0., 0.), |(a, b), (x, y)| {
        (a + (x - mx) * (x - mx), b + (x - mx) * (y - my))
    });
    let b = sxy / sxx;
    let max = samples
        .iter()
        .fold(0_f64, |a, (x, y)| a.max((y - (my + b * (x - mx))).abs()));
    (my - b * mx, b, max)
}

/// `(scatter, jump)` of the relative density along the sweep at `p0`.
fn sweep(branch: Branch, p0: f64) -> (f64, f64) {
    let u = endpoint(branch, p0);
    let rho0 = CaloricLinearization::internal_energy(branch, p0, u)
        .unwrap()
        .point()
        .density_kg_m3;
    let samples: Vec<(f64, f64)> = (-100i32..=100)
        .map(|k| {
            let x = f64::from(k) * 1e-11;
            let q = CaloricLinearization::internal_energy(branch, p0 * (1. + x), u)
                .unwrap_or_else(|e| panic!("{branch:?} p0={p0} k={k}: {e:?}"))
                .point();
            (x, q.density_kg_m3 / rho0 - 1.)
        })
        .collect();
    let (_, _, scatter) = line(&samples);
    let below: Vec<_> = samples.iter().copied().filter(|(x, _)| *x <= 0.).collect();
    let above: Vec<_> = samples.iter().copied().filter(|(x, _)| *x >= 0.).collect();
    let (a, _, _) = line(&below);
    let (b, _, _) = line(&above);
    (scatter, b - a)
}

const PRESSURES: [f64; 6] = [2.5e6, 7e6, 10e6, 14e6, 14_927_136.866, 15.5e6];

#[test]
fn the_saturated_endpoint_is_smooth_to_round_off_in_pressure() {
    let mut report = Vec::new();
    let mut worst = 0_f64;
    for p0 in PRESSURES {
        for branch in [Branch::Liquid, Branch::Vapor] {
            let (scatter, jump) = sweep(branch, p0);
            worst = worst.max(scatter).max(jump.abs());
            report.push(format!(
                "{branch:?} p0={p0}: scatter {scatter:.2e}, jump {jump:.2e}"
            ));
        }
    }
    println!("{}", report.join("\n"));
    assert!(worst <= 2e-13, "worst {worst:e}");
}

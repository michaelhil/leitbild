//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! DR S3-REBIRTH's projection-bound miss (KERN, NOT evidence): C2 stopped at
//! +27.47 s when SURGE's exhaustion restart left its EOS row at 1.50e-12
//! against the 1e-12 constraint bound. The row is the cell's relative
//! volume defect `(Σ M_k / ρ_k(p, u_k) − V) / V`, and the liquid density
//! comes from the maintained IF97 inverse `(p, u) → T`, whose declared
//! convergence test admits an energy defect of 2e-12 of `max(|u|, u_T T)`.
//! The probe measures the row's own evaluation noise along a line in the
//! cell's pressure: at a liquid SURGE 1 K below saturation and at a
//! just-exhausted SURGE (saturated liquid, u = u_f(p)), 201 pressures within
//! ±1e-9 relative of the root are evaluated and the scatter of the row about
//! its least-squares line is reported (the line itself is the Jacobian the
//! projection uses). A scatter near the bound means the projection cannot
//! meet the bound there, whatever the number of passes.
//!
//! Environment: `LD01_PHASE_PACKET` (the S3 base packet) and maintained IF97.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        Properties, RotorState,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::Scalar,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

#[test]
#[ignore = "DR S3-REBIRTH bound (KERN), NOT EVIDENCE: needs the S3 base packet (LD01_PHASE_PACKET) and maintained IF97"]
fn the_eos_row_noise_of_a_just_exhausted_cell_reaches_the_projection_bound() {
    let path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let surge = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == "SURGE")
        .expect("SURGE");
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (mut net, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let sc = net.scales().to_vec();
    let l = net.cell_layout[surge];
    let volume = net.volume(surge);
    let yp = vec![0.; prepared.y.len()];
    let mut cases = Vec::new();
    // C2's SURGE pressures after the trip lie near 14 MPa; the prepared
    // pressure and 14 MPa bracket them.
    let p0 = prepared.y[l.base] * sc[l.base];
    for p in [p0, 14.0e6] {
        let sat = If97.saturation_caloric(s(p)).expect("saturation");
        let ts = sat.temperature.value;
        for (label, temperature) in [
            ("1 K subcooled", ts - 1.),
            (
                "2 mK subcooled (outside the inverse's 1 mK end margin)",
                ts - 2e-3,
            ),
            ("0.5 mK subcooled (inside the end margin)", ts - 0.5e-3),
            ("saturated liquid", ts),
        ] {
            let q = if label == "saturated liquid" {
                (
                    sat.liquid.density.value,
                    sat.liquid.enthalpy.value - p / sat.liquid.density.value,
                )
            } else {
                let w = If97.forward(false, p, temperature).expect("liquid");
                (w.density_kg_m3, w.internal_energy_j_kg)
            };
            // The cell full of this liquid at p: its EOS row is zero there.
            let mut y = prepared.y.clone();
            let mass = q.0 * volume;
            y[l.base] = p / sc[l.base];
            y[l.mass[0]] = mass / sc[l.mass[0]];
            y[l.energy[0]] = mass * q.1 / sc[l.energy[0]];
            y[l.mass[1]] = 0.;
            y[l.energy[1]] = 0.;
            let mut samples = Vec::new();
            for k in -100i32..=100 {
                let pk = p * (1. + f64::from(k) * 1e-11);
                y[l.base] = pk / sc[l.base];
                if net.evaluate(0., &y, &yp, None, 0., None).is_ok() {
                    samples.push((pk - p, net.rows()[l.base].value));
                }
            }
            // Least-squares line r = a + b dp, and the scatter about it.
            let m = samples.len() as f64;
            let (sx, sy) = samples
                .iter()
                .fold((0., 0.), |(a, b), (x, r)| (a + x, b + r));
            let (mx, my) = (sx / m, sy / m);
            let (sxx, sxy) = samples.iter().fold((0., 0.), |(a, b), (x, r)| {
                (a + (x - mx) * (x - mx), b + (x - mx) * (r - my))
            });
            let slope = sxy / sxx;
            let scatter: Vec<f64> = samples
                .iter()
                .map(|(x, r)| r - (my + slope * (x - mx)))
                .collect();
            let max = scatter.iter().fold(0_f64, |a, v| a.max(v.abs()));
            let rms = (scatter.iter().map(|v| v * v).sum::<f64>() / m).sqrt();
            let line_step = (slope * p * 1e-11).abs();
            // The same scatter on each side of the base pressure, each side
            // about its own line, and the jump between the two lines at dp = 0.
            let side = |upper: bool| {
                let part: Vec<(f64, f64)> = samples
                    .iter()
                    .copied()
                    .filter(|(x, _)| if upper { *x > 0. } else { *x < 0. })
                    .collect();
                let m = part.len() as f64;
                let (mx, my) = part
                    .iter()
                    .fold((0., 0.), |(a, b), (x, r)| (a + x / m, b + r / m));
                let (sxx, sxy) = part.iter().fold((0., 0.), |(a, b), (x, r)| {
                    (a + (x - mx) * (x - mx), b + (x - mx) * (r - my))
                });
                let b = sxy / sxx;
                let max = part
                    .iter()
                    .fold(0_f64, |a, (x, r)| a.max((r - (my + b * (x - mx))).abs()));
                (my - b * mx, max)
            };
            let ((below_at_0, below_max), (above_at_0, above_max)) = (side(false), side(true));
            cases.push(json!({"p_pa": p, "state": label, "t_k": temperature,
                "evaluated": samples.len(), "row_slope_per_pa": slope, "row_change_per_sample": line_step,
                "scatter_max": max, "scatter_rms": rms, "projection_bound": 1e-12,
                "below": {"scatter_max": below_max}, "above": {"scatter_max": above_max},
                "jump_at_base": above_at_0 - below_at_0}));
        }
    }
    println!(
        "{}",
        json!({"cell": "SURGE", "row": l.base, "cases": cases})
    );
}

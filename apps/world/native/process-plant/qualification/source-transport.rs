//! Actual-input PARTIAL fuel + PRIMARY moderator + transparent/escape algebra.
//! Not complete material/optical/source assembly, initial field or trajectory.
#[path = "../src/fuel_source.rs"]
mod fuel_source;
#[path = "../src/moderator_source.rs"]
mod moderator_source;
#[path = "../src/transport_source.rs"]
mod transport_source;
use std::{env, fs, time::Instant};
type Words<'a> = std::iter::Copied<std::slice::Iter<'a, &'a str>>;
fn number(w: &mut Words<'_>) -> f64 {
    let x: f64 = w
        .next()
        .expect("Missing number")
        .parse()
        .expect("Invalid number");
    assert!(x.is_finite(), "Nonfinite fixture");
    x
}
fn count(w: &mut Words<'_>) -> usize {
    let x = w
        .next()
        .expect("Missing count")
        .parse()
        .expect("Invalid count");
    x
}
fn array<const N: usize>(w: &mut Words<'_>) -> [f64; N] {
    std::array::from_fn(|_| number(w))
}
fn framed<'a>(w: &mut Words<'a>) -> Vec<&'a str> {
    let n = count(w);
    assert!(n <= w.len(), "Frame exceeds remaining fixture tokens");
    w.by_ref().take(n).collect()
}
fn near(a: f64, b: f64, scale: f64) {
    assert!(
        (a - b).abs() <= 3e-10 * scale.max(1e-300),
        "Independent number identity {a} != {b}, scale {scale}"
    );
}
fn fuel(
    tokens: &[&str],
) -> (
    fuel_source::FuelModel,
    Vec<fuel_source::Stocks>,
    Vec<f64>,
    f64,
) {
    use fuel_source::*;
    let mut w = tokens.iter().copied();
    let nr = count(&mut w);
    let ns = count(&mut w);
    let nq = count(&mut w);
    let ni = count(&mut w);
    assert!(
        [nr, ns, nq, ni].iter().all(|x| *x <= tokens.len()),
        "Fuel size exceeds payload"
    );
    let law = FuelLaw {
        absorption: array(&mut w),
        fission: array(&mut w),
        scatter: std::array::from_fn(|_| array(&mut w)),
        nu: array(&mut w),
        chi: array(&mut w),
        speed: array(&mut w),
        beta: array(&mut w),
        decay: array(&mut w),
        f_d: number(&mut w),
    };
    let rv = (0..nr).map(|_| number(&mut w)).collect();
    let sv = (0..ns).map(|_| number(&mut w)).collect();
    let cohorts = (0..nq)
        .map(|_| Cohort {
            segment: count(&mut w),
            mass: number(&mut w),
            mu: number(&mut w),
        })
        .collect();
    let intersections = (0..ni)
        .map(|_| {
            let region = count(&mut w);
            let segment = count(&mut w);
            let volume = number(&mut w);
            let nw = count(&mut w);
            assert!(nw <= w.len(), "Weights exceed remaining fixture");
            let weights = (0..nw)
                .map(|_| Weight {
                    cohort: count(&mut w),
                    mass: number(&mut w),
                })
                .collect();
            Intersection {
                region,
                segment,
                volume,
                weights,
            }
        })
        .collect();
    let stocks = (0..ns)
        .map(|_| Stocks {
            reserve: number(&mut w),
            reference_reserve: number(&mut w),
            fertile: number(&mut w),
            reference_fertile: number(&mut w),
        })
        .collect();
    let temperatures = (0..nq).map(|_| number(&mut w)).collect();
    let prompt = number(&mut w);
    assert!(prompt >= 0.);
    assert!(w.next().is_none(), "Trailing fuel fixture");
    (
        FuelModel::new(law, rv, sv, cohorts, intersections).unwrap(),
        stocks,
        temperatures,
        prompt,
    )
}
fn moderator(
    tokens: &[&str],
) -> (
    moderator_source::ModeratorModel,
    Vec<moderator_source::Stocks>,
) {
    use moderator_source::*;
    let mut w = tokens.iter().copied();
    let nr = count(&mut w);
    let ni = count(&mut w);
    assert!(
        nr <= tokens.len() && ni <= tokens.len(),
        "Moderator size exceeds payload"
    );
    let law = ModeratorLaw {
        absorption: array(&mut w),
        scatter: std::array::from_fn(|_| array(&mut w)),
        speed: array(&mut w),
        boron_sigma: array(&mut w),
        reference_density: number(&mut w),
        hydrogen_emission: array(&mut w),
        boron_emission: array(&mut w),
    };
    let volumes = (0..nr).map(|_| number(&mut w)).collect();
    let mut intersections = Vec::new();
    let mut stocks = Vec::new();
    for _ in 0..ni {
        intersections.push(Intersection {
            region: count(&mut w),
            volume: number(&mut w),
        });
        stocks.push(Stocks {
            water_mass: number(&mut w),
            liquid_volume: number(&mut w),
            hydrogen_target: number(&mut w),
            hydrogen_product: number(&mut w),
            mobile_boron10: number(&mut w),
        });
    }
    assert!(w.next().is_none(), "Trailing moderator fixture");
    (
        ModeratorModel::new(law, volumes, intersections).unwrap(),
        stocks,
    )
}
fn main() {
    let started = Instant::now();
    let text = fs::read_to_string(
        env::args()
            .nth(1)
            .expect("Explicit composed fixture required"),
    )
    .unwrap();
    assert_eq!(env::args().len(), 2, "Only one explicit fixture argument");
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    let mut w = tokens.iter().copied();
    let ft = framed(&mut w);
    let mt = framed(&mut w);
    let (fuel, stocks, temperatures, prompt) = fuel(&ft);
    let (moderator, water) = moderator(&mt);
    let nr = count(&mut w);
    let nf = count(&mut w);
    assert!(
        nr <= w.len() && nf <= w.len(),
        "Transport size exceeds payload"
    );
    let speed: [f64; 7] = array(&mut w);
    let volumes = (0..nr).map(|_| number(&mut w)).collect::<Vec<_>>();
    let ell = (0..nr).map(|_| number(&mut w)).collect();
    assert_eq!(volumes, fuel.volumes(), "Fuel region map mismatch");
    assert_eq!(
        volumes,
        moderator.volumes(),
        "Moderator region map mismatch"
    );
    assert_eq!(speed, fuel.law().speed);
    assert_eq!(speed, moderator.law().speed);
    let mut escape_faces = 0;
    let faces = (0..nf)
        .map(|_| {
            let left = count(&mut w);
            let right: isize = w
                .next()
                .expect("Missing face right")
                .parse()
                .expect("Invalid face right");
            let area = number(&mut w);
            let left_distance = number(&mut w);
            let rd = number(&mut w);
            assert!(right >= -1, "Invalid exterior index");
            let (right, right_distance, law) = if right == -1 {
                escape_faces += 1;
                assert_eq!(rd, 0.);
                (None, None, transport_source::FaceLaw::Escape)
            } else {
                (
                    Some(right as usize),
                    Some(rd),
                    transport_source::FaceLaw::Transparent,
                )
            };
            transport_source::Face {
                left,
                right,
                area,
                left_distance,
                right_distance,
                law,
            }
        })
        .collect();
    let supplied = (0..nr).map(|_| array::<7>(&mut w)).collect::<Vec<_>>();
    assert!(w.next().is_none(), "Trailing composed payload");
    let transport = transport_source::Model::new(volumes, ell, speed, faces, 0).unwrap();
    let mut fw = fuel.workspace();
    let mut mw = moderator.workspace();
    let mut tw = transport.workspace();
    let workspace_pattern_payload_bytes = fw.buffer_bytes()
        + mw.buffer_bytes()
        + tw.buffer_bytes()
        + fuel.coordinates().len() * std::mem::size_of::<fuel_source::Coordinate>()
        + transport.coordinates().len() * std::mem::size_of::<transport_source::Coordinate>();
    let construction_seconds = started.elapsed().as_secs_f64();
    let update_start = Instant::now();
    fuel.update(&temperatures, &stocks, &mut fw).unwrap();
    moderator.update(&water, &mut mw).unwrap();
    let mut collision = vec![[0.; 7]; nr];
    let mut mc = collision.clone();
    fuel.collision_into(&fw, &mut collision).unwrap();
    moderator.collision_into(&mw, &mut mc).unwrap();
    let mut collision_error: f64 = 0.;
    for i in 0..nr {
        for g in 0..7 {
            collision[i][g] += mc[i][g];
            near(
                collision[i][g],
                supplied[i][g],
                collision[i][g].abs() + supplied[i][g].abs(),
            );
            collision_error = collision_error.max((collision[i][g] - supplied[i][g]).abs());
        }
    }
    transport.update(&collision, &[], &mut tw).unwrap();
    let update_seconds = update_start.elapsed().as_secs_f64();
    let mut n = vec![0.; fuel.coordinate_count()];
    let mut fr = n.clone();
    let mut mr = vec![0.; nr * 7];
    let mut tr = mr.clone();
    let mut fe = vec![[0.; 2]; fuel.intersections().len()];
    let mut me = vec![moderator_source::Events::default(); water.len()];
    let mut esc = [0.; 7];
    let mut heat = vec![0.; fuel.cohorts().len()];
    let release = vec![0.; fuel.segment_count()];
    let apply_start = Instant::now();
    let mut composed_apply_seconds = 0.;
    let mut max_number_error: f64 = 0.;
    let mut max_relative_error: f64 = 0.;
    let mut max_matrix_error: f64 = 0.;
    for probe in 0..3 {
        // Explicit algebra probes: zero original amounts, positive synthetic,
        // finite signed Newton synthetic. Neither synthetic is prepared history.
        for (i, x) in n.iter_mut().enumerate() {
            *x = if probe == 0 {
                0.
            } else {
                (1. + (i % 17) as f64 / 9.) * if probe == 2 && i % 3 == 0 { -1. } else { 1. }
            };
        }
        let call_start = Instant::now();
        fuel.apply(&fw, &n, &mut fr, &mut fe).unwrap();
        moderator
            .apply(&mw, &n[..nr * 7], &mut mr, &mut me)
            .unwrap();
        transport
            .apply(&tw, &n[..nr * 7], &mut tr, &mut [], &mut esc)
            .unwrap();
        fuel.fuel_heat(&fe, prompt, &release, &mut heat).unwrap();
        composed_apply_seconds += call_start.elapsed().as_secs_f64();
        if probe == 0 {
            assert!(fr
                .iter()
                .chain(&mr)
                .chain(&tr)
                .chain(heat.iter())
                .all(|v| *v == 0.));
            fuel.validate_accepted_state(&n).unwrap();
            transport.validate_accepted_state(&n[..nr * 7]).unwrap();
        }
        if probe == 2 {
            assert!(fuel.validate_accepted_state(&n).is_err());
            assert!(transport.validate_accepted_state(&n[..nr * 7]).is_err());
        }
        if probe == 1 {
            fuel.validate_accepted_state(&n).unwrap();
            transport.validate_accepted_state(&n[..nr * 7]).unwrap();
        }
        let mut expected = 0.;
        let mut scale = 0.;
        for (e, c) in fuel.intersections().iter().zip(fw.events()) {
            for g in 0..7 {
                let ng = n[e.region * 7 + g];
                let values = [
                    (fuel.law().nu[g] - 1.) * c.fission[g] * ng,
                    -c.capture[g] * ng,
                ];
                for v in values {
                    expected += v;
                    scale += v.abs();
                }
            }
        }
        for e in &me {
            expected -= e.hydrogen + e.boron;
            scale += e.hydrogen.abs() + e.boron.abs();
        }
        for v in esc {
            expected -= v;
            scale += v.abs();
        }
        let measured = fr.iter().sum::<f64>() + mr.iter().sum::<f64>() + tr.iter().sum::<f64>();
        near(measured, expected, scale);
        max_number_error = max_number_error.max((measured - expected).abs());
        max_relative_error =
            max_relative_error.max((measured - expected).abs() / scale.max(1e-300));
        // Independent sparse N tangent matvec, with shared-face duplicates additive.
        let mut matrix = vec![0.; nr * 7];
        let mut matrix_scale = vec![0.; nr * 7];
        for (c, v) in transport
            .coordinates()
            .iter()
            .zip(tw.coefficients().unwrap())
        {
            matrix[c.row] += v * n[c.column];
            matrix_scale[c.row] += (v * n[c.column]).abs();
        }
        for ((a, b), scale) in matrix.iter().zip(&tr).zip(&matrix_scale) {
            near(*a, *b, *scale + b.abs());
            max_matrix_error = max_matrix_error.max((a - b).abs());
        }
    }
    let apply_seconds = apply_start.elapsed().as_secs_f64();
    println!("{{\"passed\":true,\"scope\":\"PARTIAL fuel+PRIMARY moderator+transparent/escape algebra; no complete source, covered optics, external births, target evolution, heat recipients or trajectory\",\"regions\":{nr},\"neutron_coordinates\":{},\"precursor_coordinates\":{},\"shared_transparent_faces\":{},\"escape_faces\":{escape_faces},\"transport_entries\":{},\"fuel_entries\":{},\"probes\":[\"original-zero-component-state\",\"positive-synthetic-operator\",\"signed-synthetic-Newton-operator\"],\"accepted_boundary_checks\":true,\"workspace_pattern_payload_bytes\":{workspace_pattern_payload_bytes},\"memory_scope\":\"known workspace/pattern Vec element payload only; excludes model, caller arrays, allocator and solver\",\"collision_max_difference\":{collision_error:e},\"number_balance_max_absolute\":{max_number_error:e},\"number_balance_max_scaled\":{max_relative_error:e},\"transport_matvec_max_difference\":{max_matrix_error:e},\"construction_seconds\":{construction_seconds},\"same_snapshot_update_seconds\":{update_seconds},\"three_composed_apply_seconds\":{composed_apply_seconds},\"three_probe_check_seconds\":{apply_seconds},\"total_seconds\":{}}}",nr*7,fuel.segment_count()*6,nf-escape_faces,transport.coordinates().len(),fuel.coordinates().len(),started.elapsed().as_secs_f64());
}

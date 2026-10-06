//! Actual-input material/body/converter transaction with converter-only physical
//! energy recipient/export rates. No full source/history/thermal trajectory.
#[path = "../src/cylindrical_source.rs"]
mod cylindrical_source;
#[path = "../src/converter_heat.rs"]
mod converter_heat;
#[path = "../src/fuel_source.rs"]
mod fuel_source;
#[path = "../src/moderator_source.rs"]
mod moderator_source;
#[path = "../src/optical_source.rs"]
mod optical_source;
#[path = "../src/passive_source.rs"]
mod passive_source;
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
    let nt = count(&mut w);
    let amounts = (0..nt).map(|_| number(&mut w)).collect::<Vec<_>>();
    let emissions = (0..nt).map(|_| array::<2>(&mut w)).collect::<Vec<_>>();
    let ns = count(&mut w);
    let passive_stocks = (0..ns)
        .map(|_| {
            let volume = number(&mut w);
            let scatter_m1 = array(&mut w);
            let n_targets = count(&mut w);
            let targets = (0..n_targets)
                .map(|_| passive_source::Target {
                    index: count(&mut w),
                    sigma_m2: array(&mut w),
                })
                .collect();
            passive_source::Stock {
                volume,
                scatter_m1,
                targets,
            }
        })
        .collect::<Vec<_>>();
    let ni = count(&mut w);
    let passive_incidence = (0..ni)
        .map(|_| passive_source::Intersection {
            stock: count(&mut w),
            region: count(&mut w),
            volume: number(&mut w),
        })
        .collect::<Vec<_>>();
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
    let mut optical_inputs = Vec::new();
    let mut optical_faces = 0;
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
            let nl = count(&mut w);
            let response = if nl > 0 {
                assert!(right >= 0, "Optical exterior unsupported");
                let layers = (0..nl)
                    .map(|_| {
                        let nc = count(&mut w);
                        optical_source::Layer {
                            columns: (0..nc)
                                .map(|_| optical_source::Column {
                                    target: count(&mut w),
                                    atoms_per_m2: number(&mut w),
                                    sigma_m2: array(&mut w),
                                })
                                .collect(),
                        }
                    })
                    .collect::<Vec<_>>();
                Some(optical_source::layer_response(&layers).unwrap())
            } else {
                None
            };
            assert!(right >= -1, "Invalid exterior index");
            let (right, right_distance, law) = if right == -1 {
                escape_faces += 1;
                assert_eq!(rd, 0.);
                (None, None, transport_source::FaceLaw::Escape)
            } else {
                let law = if let Some(response) = response {
                    optical_faces += 1;
                    optical_inputs.push(response.input);
                    transport_source::FaceLaw::Optical {
                        targets: response.targets,
                    }
                } else {
                    transport_source::FaceLaw::Transparent
                };
                (Some(right as usize), Some(rd), law)
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
    let nc = count(&mut w);
    let cylinders = (0..nc).map(|_| cylindrical_source::Target {
        index: count(&mut w), inner_radius: number(&mut w), outer_radius: number(&mut w),
        length: number(&mut w), multiplicity: count(&mut w), sigma_m2: array(&mut w),
        escape_depth: number(&mut w), collection: number(&mut w),
    }).collect::<Vec<_>>();
    let nci = count(&mut w);
    let cylinder_incidence = (0..nci).map(|_| cylindrical_source::Intersection {
        target: count(&mut w), region: count(&mut w), share: number(&mut w),
    }).collect::<Vec<_>>();
    let converter_index = count(&mut w);
    let converter_model = converter_heat::Model::new(converter_heat::Geometry {
        film_thickness: number(&mut w), film_density: number(&mut w), film_mu_en: number(&mut w),
        carrier_wall: number(&mut w), thimble_wall: number(&mut w), steel_density: number(&mut w),
        steel_mu_en: number(&mut w),
    }, number(&mut w), number(&mut w)).unwrap();
    let converter_liquid = converter_heat::LiquidPath {
        density: number(&mut w), mu_en: number(&mut w), chord: number(&mut w),
    };
    assert!(w.next().is_none(), "Trailing composed payload");
    assert!(converter_index < nt && nc > 1 && nci > 0);
    assert_eq!(cylinders.iter().filter(|q| q.index == converter_index && q.escape_depth > 0.).count(), 1);
    let cylinder = cylindrical_source::Model::new(volumes.clone(), speed, cylinders.clone(), cylinder_incidence.clone(), nt).unwrap();
    let passive = passive_source::Model::new(
        volumes.clone(),
        speed,
        passive_stocks.clone(),
        passive_incidence.clone(),
        nt,
    )
    .unwrap();
    let transport = transport_source::Model::new(volumes, ell, speed, faces, nt).unwrap();
    let mut fw = fuel.workspace();
    let mut mw = moderator.workspace();
    let mut tw = transport.workspace();
    let mut pw = passive.workspace();
    let mut cw = cylinder.workspace();
    let workspace_pattern_payload_bytes = fw.buffer_bytes()
        + mw.buffer_bytes()
        + tw.buffer_bytes()
        + pw.buffer_bytes()
        + cw.buffer_bytes()
        + fuel.coordinates().len() * std::mem::size_of::<fuel_source::Coordinate>()
        + transport.coordinates().len() * std::mem::size_of::<transport_source::Coordinate>();
    let construction_seconds = started.elapsed().as_secs_f64();
    let update_start = Instant::now();
    fuel.update(&temperatures, &stocks, &mut fw).unwrap();
    moderator.update(&water, &mut mw).unwrap();
    passive.update(&amounts, &mut pw).unwrap();
    cylinder.update(&amounts, &mut cw).unwrap();
    let mut collision = vec![[0.; 7]; nr];
    let mut mc = collision.clone();
    fuel.collision_into(&fw, &mut collision).unwrap();
    moderator.collision_into(&mw, &mut mc).unwrap();
    let mut collision_error: f64 = 0.;
    for i in 0..nr {
        for g in 0..7 {
            collision[i][g] += mc[i][g] + pw.collision().unwrap()[i][g];
            near(
                collision[i][g],
                supplied[i][g],
                collision[i][g].abs() + supplied[i][g].abs(),
            );
            collision_error = collision_error.max((collision[i][g] - supplied[i][g]).abs());
            // Supplied independent subtotal excludes cylinders. Add their same
            // actual target coefficient before the transport half-cell law.
            collision[i][g] += cw.collision().unwrap()[i][g];
        }
    }
    transport
        .update(&collision, &optical_inputs, &mut tw)
        .unwrap();
    let update_seconds = update_start.elapsed().as_secs_f64();
    let mut n = vec![0.; fuel.coordinate_count()];
    let mut fr = n.clone();
    let mut mr = vec![0.; nr * 7];
    let mut tr = mr.clone();
    let mut pr = mr.clone();
    let mut pc = vec![0.; nt];
    let mut cr = vec![0.; nr * 7];
    let mut cc = vec![[0.; 7]; nt];
    let mut collected = cc.clone();
    let mut charged_escape = cc.clone();
    let mut oc = vec![[0.; 7]; nt];
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
    let mut capture_emission = [0.; 2];
    let mut max_energy_error: f64 = 0.;
    let mut wet_converter = converter_heat::Rates::default();
    let mut dry_converter = wet_converter;
    let mut converter_captures = 0.;
    let mut converter_detected = 0.;
    let mut converter_escaped_charged = 0.;
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
        pr.fill(0.);
        pc.fill(0.);
        passive.apply(&pw, &n[..nr * 7], &mut pr, &mut pc).unwrap();
        cylinder.apply(&cw, &n[..nr * 7], &mut cr, &mut cc, &mut collected, &mut charged_escape).unwrap();
        transport
            .apply(&tw, &n[..nr * 7], &mut tr, &mut oc, &mut esc)
            .unwrap();
        fuel.fuel_heat(&fe, prompt, &release, &mut heat).unwrap();
        composed_apply_seconds += call_start.elapsed().as_secs_f64();
        if probe == 0 {
            assert!(
                fr.iter()
                    .chain(&mr)
                    .chain(&tr)
                    .chain(&pr)
                    .chain(&pc)
                    .chain(&cr)
                    .chain(cc.iter().flatten())
                    .chain(collected.iter().flatten())
                    .chain(charged_escape.iter().flatten())
                    .chain(oc.iter().flatten())
                    .chain(heat.iter())
                    .all(|v| *v == 0.)
            );
            fuel.validate_accepted_state(&n).unwrap();
            transport.validate_accepted_state(&n[..nr * 7]).unwrap();
            cylinder.validate_accepted_state(&n[..nr * 7]).unwrap();
        }
        if probe == 2 {
            assert!(fuel.validate_accepted_state(&n).is_err());
            assert!(transport.validate_accepted_state(&n[..nr * 7]).is_err());
            assert!(cylinder.validate_accepted_state(&n[..nr * 7]).is_err());
        }
        if probe == 1 {
            fuel.validate_accepted_state(&n).unwrap();
            transport.validate_accepted_state(&n[..nr * 7]).unwrap();
            cylinder.validate_accepted_state(&n[..nr * 7]).unwrap();
            assert!(cc.iter().flatten().chain(collected.iter().flatten()).chain(charged_escape.iter().flatten()).all(|v| *v >= 0.));
            for g in 0..7 { assert!(charged_escape[converter_index][g] <= cc[converter_index][g]);
                assert!(collected[converter_index][g] <= charged_escape[converter_index][g]); }
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
        let mut independent_capture = vec![0.; nt];
        for e in &passive_incidence {
            let s = &passive_stocks[e.stock];
            for target in &s.targets {
                for g in 0..7 {
                    independent_capture[target.index] +=
                        amounts[target.index] * e.volume / s.volume * target.sigma_m2[g]
                            / fuel.volumes()[e.region]
                            * speed[g]
                            * n[e.region * 7 + g];
                }
            }
        }
        for j in 0..nt {
            near(
                pc[j],
                independent_capture[j],
                pc[j].abs() + independent_capture[j].abs(),
            );
            let optical = oc[j].iter().sum::<f64>();
            let cylindrical = cc[j].iter().sum::<f64>();
            expected -= pc[j] + optical + cylindrical;
            scale += pc[j].abs() + oc[j].iter().chain(cc[j].iter()).map(|x| x.abs()).sum::<f64>();
            if probe == 1 {
                for k in 0..2 {
                    capture_emission[k] += (pc[j] + optical + cylindrical) * emissions[j][k];
                }
            }
        }
        let measured = fr.iter().sum::<f64>()
            + mr.iter().sum::<f64>()
            + tr.iter().sum::<f64>()
            + pr.iter().sum::<f64>() + cr.iter().sum::<f64>();
        near(measured, expected, scale);
        max_number_error = max_number_error.max((measured - expected).abs());
        max_relative_error =
            max_relative_error.max((measured - expected).abs() / scale.max(1e-300));
        // Independent SAME effective absorption contraction closes this loss,
        // while tests separately challenge the integral/geometry coefficients.
        for r in 0..nr { for g in 0..7 { let loss = cw.collision().unwrap()[r][g] * speed[g] * n[r*7+g];
            near(cr[r*7+g], -loss, cr[r*7+g].abs()+loss.abs()); } }
        let capture = cc[converter_index].iter().sum::<f64>();
        let escaped = charged_escape[converter_index].iter().sum::<f64>();
        for liquid in [Some(converter_liquid), None] {
            let energy = converter_model.apply(capture, escaped, liquid).unwrap();
            let sum = energy.collector + energy.helium + energy.wall + energy.liquid + energy.export;
            let paid = capture * emissions[converter_index].iter().sum::<f64>();
            near(sum, paid, sum.abs()+paid.abs());
            max_energy_error = max_energy_error.max((sum-paid).abs());
            if probe == 1 {
                assert!([energy.collector, energy.helium, energy.wall, energy.liquid, energy.export].iter().all(|v| *v>=0.));
                if liquid.is_some() { wet_converter=energy; } else { dry_converter=energy; assert_eq!(energy.liquid,0.); }
            }
        }
        if probe == 1 { converter_captures=capture; converter_escaped_charged=escaped;
            converter_detected=collected[converter_index].iter().sum::<f64>(); }
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
    // Actual finite target exhaustion changes capture, without changing fixed
    // ordinary elastic scattering. It does not substitute for target evolution.
    passive.update(&vec![0.; nt], &mut pw).unwrap();
    pr.fill(0.);
    pc.fill(0.);
    passive.apply(&pw, &n[..nr * 7], &mut pr, &mut pc).unwrap();
    assert!(pc.iter().chain(&pr).all(|v| *v == 0.));
    cylinder.update(&vec![0.; nt], &mut cw).unwrap();
    cylinder.apply(&cw, &n[..nr*7], &mut cr, &mut cc, &mut collected, &mut charged_escape).unwrap();
    assert!(cr.iter().chain(cc.iter().flatten()).chain(collected.iter().flatten()).chain(charged_escape.iter().flatten()).all(|v| *v==0.));
    assert!(
        optical_faces > 0 && nt > 0 && ni > 0,
        "Missing composed physical families"
    );
    let apply_seconds = apply_start.elapsed().as_secs_f64();
    println!("{{\"kind\":\"converter-physical-energy-rates\",\"body_targets\":{},\"converter_targets\":1,\"cylinder_intersections\":{nci},\"capture_events_per_s\":{converter_captures},\"detected_expectation_per_s\":{converter_detected},\"escaped_charged_events_per_s\":{converter_escaped_charged},\"emitted_binding_W\":{},\"wet_W\":{{\"collector\":{},\"He.3\":{},\"WALL.3\":{},\"Core.2.GUIDE\":{},\"export\":{}}},\"absent_liquid_counterfactual_W\":{{\"collector\":{},\"He.3\":{},\"WALL.3\":{},\"liquid\":{},\"export\":{}}},\"energy_balance_max_absolute_W\":{max_energy_error:e},\"cylinder_target_exhaustion_checked\":true,\"cylinder_geometry_payload_bytes\":{},\"thermal_states_advanced\":false,\"obtained_observation\":false}}", nc-1, wet_converter.emitted, wet_converter.collector,wet_converter.helium,wet_converter.wall,wet_converter.liquid,wet_converter.export,dry_converter.collector,dry_converter.helium,dry_converter.wall,dry_converter.liquid,dry_converter.export,cylinder.geometry_payload_bytes());
    println!(
        "{{\"passed\":true,\"scope\":\"Actual material/body/converter capture and converter-only energy routing; no full births/history/thermal trajectory\",\"regions\":{nr},\"neutron_coordinates\":{},\"precursor_coordinates\":{},\"shared_transparent_faces\":{},\"optical_faces\":{optical_faces},\"escape_faces\":{escape_faces},\"passive_stocks\":{ns},\"passive_intersections\":{ni},\"finite_targets_including_converter\":{nt},\"transport_entries\":{},\"fuel_entries\":{},\"probes\":[\"original-zero-component-state\",\"positive-synthetic-operator\",\"signed-synthetic-Newton-operator\"],\"accepted_boundary_checks\":true,\"volume_target_exhaustion_checked\":true,\"selected_solid_passive_converter_binding_emission_charged_J_per_s\":{},\"selected_solid_passive_converter_binding_emission_photon_J_per_s\":{},\"all_emission_is_deposited_heat\":false,\"workspace_pattern_payload_bytes\":{workspace_pattern_payload_bytes},\"memory_scope\":\"known workspace/pattern Vec element payload only; excludes geometry reported separately, model, caller arrays, allocator and solver\",\"base_collision_max_difference\":{collision_error:e},\"number_balance_max_absolute\":{max_number_error:e},\"number_balance_max_scaled\":{max_relative_error:e},\"transport_matvec_max_difference\":{max_matrix_error:e},\"construction_seconds\":{construction_seconds},\"same_snapshot_update_seconds\":{update_seconds},\"three_composed_apply_seconds\":{composed_apply_seconds},\"three_probe_check_seconds\":{apply_seconds},\"total_seconds\":{}}}",
        nr * 7,
        fuel.segment_count() * 6,
        nf - escape_faces - optical_faces,
        transport.coordinates().len(),
        fuel.coordinates().len(),
        capture_emission[0],
        capture_emission[1],
        started.elapsed().as_secs_f64()
    );
}

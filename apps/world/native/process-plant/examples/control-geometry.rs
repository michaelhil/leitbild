//! Bounded compiler/native equality check; not an advancing plant model.
#[path = "../qualification/control_geometry_input.rs"]
mod geometry_input;
use geometry_input::Reader;
use leitbild_plant_numerics::{control_source_geometry as g, source_evolution as se};
use std::io::{self, Read};

fn stage(r: &mut Reader<'_>) -> Result<g::Stage, String> {
    let passive_volumes = r.many(|r| r.number())?;
    let cylinder_shares = r.many(|r| r.number())?;
    let moderator_volumes = r.many(|r| r.number())?;
    let contacts = r.many(|r| {
        Ok(leitbild_plant_numerics::absorber_guide::ContactGeometry {
            area_m2: r.number()?,
            solid_geometry_m_inv: r.number()?,
            liquid_chord_m: r.number()?,
        })
    })?;
    let birth_shares = r.many(|r| r.number())?;
    let liquid_chords_m = r.many(|r| r.number())?;
    let path_shares = r.many(|r| r.number())?;
    let wall_thicknesses_m = r.many(|r| r.number())?;
    let boundary_shares = r.many(|r| r.number())?;
    let water = r.many(|r| {
        Ok(g::Water {
            volume: r.number()?,
            moment: r.number()?,
        })
    })?;
    let external_water_volumes = water.iter().map(|w| w.volume).collect();
    Ok(g::Stage {
        source: se::Geometry {
            passive_volumes,
            cylinder_shares,
            moderator_volumes,
            external_water_volumes,
        },
        contacts,
        mobile: leitbild_plant_numerics::mobile_capture::Geometry {
            birth_shares,
            liquid_chords_m,
            path_shares,
            wall_thicknesses_m,
            boundary_shares,
        },
        water,
        barrel_chords_m: Vec::new(),
    })
}
fn flat(s: &g::Stage) -> Vec<f64> {
    s.source
        .passive_volumes
        .iter()
        .chain(&s.source.cylinder_shares)
        .chain(&s.source.moderator_volumes)
        .chain(&s.source.external_water_volumes)
        .copied()
        .chain(
            s.contacts
                .iter()
                .flat_map(|q| [q.area_m2, q.solid_geometry_m_inv, q.liquid_chord_m]),
        )
        .chain(
            s.mobile
                .birth_shares
                .iter()
                .chain(&s.mobile.liquid_chords_m)
                .chain(&s.mobile.path_shares)
                .chain(&s.mobile.wall_thicknesses_m)
                .chain(&s.mobile.boundary_shares)
                .copied(),
        )
        .chain(s.water.iter().flat_map(|q| [q.volume, q.moment]))
        .chain(s.barrel_chords_m.iter().copied())
        .collect()
}
fn compare(a: &[f64], b: &[f64], atol: f64, rtol: f64) -> Result<(f64, usize, f64, f64), String> {
    if a.len() != b.len() {
        return Err("Comparator shape differs".into());
    }
    let mut worst = (0., 0, 0., atol);
    for (k, (&a, &b)) in a.iter().zip(b).enumerate() {
        let ratio = (a - b).abs() / (atol + rtol * a.abs().max(b.abs()));
        if !ratio.is_finite() {
            return Err(format!("Nonfinite comparison {k}"));
        }
        if ratio > worst.0 {
            worst = (ratio, k, (a - b).abs(), atol + rtol * a.abs().max(b.abs()));
        }
    }
    if worst.0 > 1. {
        return Err(format!(
            "Geometry mismatch ratio={} index={} native={} TS={}",
            worst.0, worst.1, a[worst.1], b[worst.1]
        ));
    }
    Ok(worst)
}
fn groups(s: &g::Stage) -> [(&'static str, usize); 12] {
    [
        ("passive_m3", s.source.passive_volumes.len()),
        ("cylinder_fraction", s.source.cylinder_shares.len()),
        ("moderator_m3", s.source.moderator_volumes.len()),
        ("external_bulk_m3", s.source.external_water_volumes.len()),
        ("contact_area_solid_chord", 3 * s.contacts.len()),
        ("mobile_birth_fraction", s.mobile.birth_shares.len()),
        ("mobile_liquid_chord_m", s.mobile.liquid_chords_m.len()),
        ("mobile_path_fraction", s.mobile.path_shares.len()),
        ("mobile_wall_thickness_m", s.mobile.wall_thicknesses_m.len()),
        ("mobile_boundary_fraction", s.mobile.boundary_shares.len()),
        ("water_V_J", 2 * s.water.len()),
        ("barrel_chord_m", s.barrel_chords_m.len()),
    ]
}
fn main() -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let words: Vec<_> = text.split_whitespace().collect();
    let mut r = Reader::new(&words);
    let plan_words = r.many(|r| r.number())?;
    let plan_text: Vec<_> = plan_words.iter().map(|x| x.to_string()).collect();
    let plan_refs: Vec<_> = plan_text.iter().map(String::as_str).collect();
    let input = geometry_input::parse(&plan_refs)?;
    let n = input.clusters;
    let nw = input.water.len();
    let cases = r.count()?;
    let prefix = vec![1.25, 2.5];
    let original = se::Geometry {
        passive_volumes: vec![0.; input.passive.len()],
        cylinder_shares: vec![0.; input.cylinders.len()],
        moderator_volumes: vec![0.; prefix.len() + input.row_water.len()],
        external_water_volumes: vec![0.; nw],
    };
    let mut original = original;
    original.moderator_volumes[..prefix.len()].copy_from_slice(&prefix);
    let prepared = g::Prepared::new(input, &original).map_err(str::to_string)?;
    let mut w = prepared.workspace();
    let mut plus = prepared.workspace();
    let mut minus = prepared.workspace();
    let mut worst: f64 = 0.;
    let mut rate_worst: f64 = 0.;
    let mut fields = 0usize;
    let mut reports = [(0., 0, 0., 2e-13); 12];
    let mut group_names = [""; 12];
    let original_volume = prepared.input().water.iter().map(|w| w.volume).sum::<f64>();
    let mut volume_defect: f64 = 0.;
    let mut volume_rate_defect: f64 = 0.;
    let mut volume_rate_direction_defect: f64 = 0.;
    for _ in 0..cases {
        let poses = (0..n)
            .map(|_| {
                Ok(g::Pose {
                    body: r.number()?,
                    stem: r.number()?,
                    body_right: r.boolean()?,
                    stem_right: r.boolean()?,
                    seated: r.boolean()?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let direction = (0..n)
            .map(|_| {
                Ok(g::Direction {
                    body: r.number()?,
                    stem: r.number()?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let velocity = (0..n)
            .map(|_| {
                Ok(g::Direction {
                    body: r.number()?,
                    stem: r.number()?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let dvelocity = (0..n)
            .map(|_| {
                Ok(g::Direction {
                    body: r.number()?,
                    stem: r.number()?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut expected = stage(&mut r)?;
        let mut dexpected = stage(&mut r)?;
        expected.barrel_chords_m = r.many(|r| r.number())?;
        dexpected.barrel_chords_m = r.many(|r| r.number())?;
        expected
            .source
            .moderator_volumes
            .splice(0..0, prefix.clone());
        dexpected.source.moderator_volumes.splice(0..0, [0., 0.]);
        prepared
            .evaluate_into(&poses, &direction, &mut w)
            .map_err(str::to_string)?;
        for (a, b) in [(&w.value, &expected), (&w.direction, &dexpected)] {
            let shapes = groups(a);
            let a = flat(a);
            let b = flat(b);
            fields += a.len();
            worst = worst.max(compare(&a, &b, 2e-13, 2e-12)?.0);
            let mut offset = 0;
            for (g, (name, n)) in shapes.into_iter().enumerate() {
                group_names[g] = name;
                let q = compare(&a[offset..offset + n], &b[offset..offset + n], 2e-13, 2e-12)?;
                if q.0 > reports[g].0 {
                    reports[g] = q;
                }
                offset += n;
            }
        }
        prepared
            .water_rates_into(&velocity, &dvelocity, &mut w)
            .map_err(str::to_string)?;
        volume_defect = volume_defect
            .max((w.value.water.iter().map(|w| w.volume).sum::<f64>() - original_volume).abs());
        volume_rate_defect =
            volume_rate_defect.max(w.water_rates.iter().map(|w| w.volume).sum::<f64>().abs());
        volume_rate_direction_defect = volume_rate_direction_defect.max(
            w.water_rate_direction
                .iter()
                .map(|w| w.volume)
                .sum::<f64>()
                .abs(),
        );
        let h = 1e-5;
        let shifted = |sign: f64| {
            poses
                .iter()
                .zip(&direction)
                .map(|(p, d)| g::Pose {
                    body: p.body + sign * h * d.body,
                    stem: p.stem + sign * h * d.stem,
                    ..*p
                })
                .collect::<Vec<_>>()
        };
        let shifted_v = |sign: f64| {
            velocity
                .iter()
                .zip(&dvelocity)
                .map(|(v, d)| g::Direction {
                    body: v.body + sign * h * d.body,
                    stem: v.stem + sign * h * d.stem,
                })
                .collect::<Vec<_>>()
        };
        let zero = vec![g::Direction::default(); n];
        prepared
            .evaluate_into(&shifted(1.), &zero, &mut plus)
            .map_err(str::to_string)?;
        prepared
            .water_rates_into(&shifted_v(1.), &zero, &mut plus)
            .map_err(str::to_string)?;
        prepared
            .evaluate_into(&shifted(-1.), &zero, &mut minus)
            .map_err(str::to_string)?;
        prepared
            .water_rates_into(&shifted_v(-1.), &zero, &mut minus)
            .map_err(str::to_string)?;
        let finite: Vec<_> = plus
            .water_rates
            .iter()
            .zip(&minus.water_rates)
            .flat_map(|(a, b)| {
                [
                    (a.volume - b.volume) / (2. * h),
                    (a.moment - b.moment) / (2. * h),
                ]
            })
            .collect();
        let analytic: Vec<_> = w
            .water_rate_direction
            .iter()
            .flat_map(|q| [q.volume, q.moment])
            .collect();
        rate_worst = rate_worst.max(compare(&analytic, &finite, 1e-10, 1e-8)?.0);
    }
    r.end()?;
    if volume_defect > 1e-10 * original_volume
        || volume_rate_defect > 1e-12
        || volume_rate_direction_defect > 1e-12
    {
        return Err("Current enclosed-water shape partition failed".into());
    }
    let groups = group_names
        .iter()
        .zip(reports)
        .filter(|(n, _)| **n != "end")
        .map(|(n, q)| {
            format!(
                "\"{n}\":{{\"ratio\":{},\"index\":{},\"absolute\":{},\"bound\":{}}}",
                q.0, q.1, q.2, q.3
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    println!("{{\"pass\":true,\"scope\":\"Prepared native current-pose compiler equivalence and contracted Vdot/Jdot JVP; no advancement claim\",\"cases\":{cases},\"water_owners\":{nw},\"compared_fields\":{fields},\"maximum_equivalence_ratio\":{worst},\"maximum_rate_direction_ratio\":{rate_worst},\"consumer_comparisons\":{{{groups}}},\"maximum_volume_defect_m3\":{volume_defect},\"maximum_volume_rate_defect_m3_s\":{volume_rate_defect},\"maximum_volume_rate_direction_defect\":{volume_rate_direction_defect},\"wall_seconds\":{}}}",start.elapsed().as_secs_f64());
    Ok(())
}

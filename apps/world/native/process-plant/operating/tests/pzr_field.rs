use leitbild_operating_plant::{
    pzr::{self, Active, FiniteReceipt, PhaseInventory},
    pzr_field::{FACES, Face, Input, Model, Phase, REGIONS, Region, Sources, Work},
    thermal::{Saturation, Scalar, WaterPoint},
};
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn close(a: f64, b: f64, t: f64) {
    assert!(
        (a - b).abs() <= t * (1. + a.abs().max(b.abs())),
        "{a} != {b}"
    );
}
// Actual 5m² vessel/two-bank geometry, synthetic smooth properties only.
fn model() -> Model {
    let bands = [0., 1., 3., 6., 9., 12.];
    let pi = std::f64::consts::PI;
    let ri = (0.5 / pi).sqrt();
    let ro = (5. / pi).sqrt();
    let radius = [
        2. * ri / 3.,
        (2. / 3.) * (ro * ro * ro - ri * ri * ri) / (ro * ro - ri * ri),
    ];
    let regions = std::array::from_fn(|i| {
        let lo = bands[i / 2];
        let hi = bands[i / 2 + 1];
        let rods = if i / 2 == 0 {
            288.
        } else if i / 2 == 1 {
            256.
        } else {
            0.
        };
        let area = if i % 2 == 0 {
            0.5 - rods * pi * 0.01_f64.powi(2)
        } else {
            4.5
        };
        Region {
            volume_m3: area * (hi - lo),
            axial_area_m2: area,
            height_m: hi - lo,
            solid_perimeter_m: if i % 2 == 0 {
                rods * pi * 0.02
            } else {
                2. * pi * ro
            },
            elevation_m: 6.5 + (lo + hi) / 2.,
        }
    });
    let mut faces = Vec::new();
    for b in 0..5 {
        faces.push(Face {
            from: 2 * b,
            to: 2 * b + 1,
            area_m2: 2. * pi * ri * (bands[b + 1] - bands[b]),
            distance_m: radius[1] - radius[0],
            normal: [1., 0.],
        });
        if b < 4 {
            for lane in 0..2 {
                faces.push(Face {
                    from: 2 * b + lane,
                    to: 2 * (b + 1) + lane,
                    area_m2: regions[2 * b + lane].axial_area_m2,
                    distance_m: regions[2 * (b + 1) + lane].elevation_m
                        - regions[2 * b + lane].elevation_m,
                    normal: [0., 1.],
                });
            }
        }
    }
    Model::new(regions, faces.try_into().unwrap(), 0.003, 0.000045, 1.).unwrap()
}
fn properties(t: Scalar, vapor: bool) -> WaterPoint {
    WaterPoint {
        density: s(if vapor { 80. } else { 660. })
            - s(if vapor { 0.2 } else { 0.7 }) * (t - s(600.)),
        viscosity: s(if vapor { 2e-5 } else { 1e-4 }) + s(1e-8) * (t - s(600.)),
        conductivity: s(if vapor { 0.06 } else { 0.6 }) + s(1e-5) * (t - s(600.)),
        cp: s(if vapor { 3000. } else { 5000. }) + s(0.3) * (t - s(600.)),
        expansion: s(0.002),
        enthalpy: s(if vapor { 2.6e6 } else { 1.4e6 }) + s(4000.) * (t - s(600.)),
    }
}
fn saturation(h: f64) -> Saturation {
    let t = Scalar::new(615. + h * 0.01, 0.01);
    Saturation {
        temperature: t,
        liquid: properties(t, false),
        vapor: properties(t, true),
        surface_tension: s(0.025),
    }
}
fn phases(m: &Model, h: f64) -> [[Option<Phase>; 2]; REGIONS] {
    let v = |x: f64, d: f64| Scalar::new(x + h * d, d);
    std::array::from_fn(|i| {
        std::array::from_fn(|k| {
            let t = v(
                if k == 0 {
                    600. + i as f64 * 0.2
                } else {
                    630. + i as f64 * 0.1
                },
                if k == 0 { 0.2 } else { -0.1 },
            );
            let alpha = v(0.75 - 0.035 * i as f64, 0.0001 * (i + 1) as f64);
            let volume = s(m.regions()[i].volume_m3) * if k == 0 { alpha } else { s(1.) - alpha };
            let water = properties(t, k == 1);
            let mass = volume * water.density;
            Some(Phase {
                mass,
                volume,
                temperature: t,
                water,
                velocity: if k == 0 {
                    [v(0.02 + i as f64 * 0.001, 0.003), v(0.03, 0.002)]
                } else {
                    [v(-0.01, -0.001), v(0.13 + i as f64 * 0.001, -0.002)]
                },
                boron_mass: if k == 0 {
                    mass * v(0.0005 + i as f64 * 1e-6, 1e-7)
                } else {
                    s(0.)
                },
            })
        })
    })
}
fn flows(h: f64) -> [[Scalar; 2]; FACES] {
    std::array::from_fn(|i| {
        [
            Scalar::new(0.1 + i as f64 * 0.01 + h * 0.001, 0.001),
            Scalar::new(-0.02 - i as f64 * 0.001 + h * 0.0001, 0.0001),
        ]
    })
}
fn evaluate(m: &Model, h: f64) -> Work {
    let phase = phases(m, h);
    let q = flows(h);
    let mut w = Work::default();
    m.evaluate(
        Input {
            pressure: Scalar::new(15e6 + h * 10., 10.),
            saturation: saturation(h),
            phase: &phase,
            face_mass_flow: &q,
        },
        &[[Sources::default(); 2]; REGIONS],
        &mut w,
    )
    .unwrap();
    w
}
fn values(w: &Work) -> Vec<Scalar> {
    w.sources
        .iter()
        .flatten()
        .flat_map(|r| [r.mass, r.enthalpy, r.momentum[0], r.momentum[1], r.boron])
        .chain(w.wall_loss_w.iter().flatten().copied())
        .chain(w.molecular_loss_w.iter().flatten().copied())
        .chain(w.conversion_mixing_loss_w.iter().flatten().copied())
        .chain(w.slip_loss_w.iter().copied())
        .chain(w.gravity_power_w.iter().flatten().copied())
        .chain(w.volume_defect_m3.iter().copied())
        .chain(w.mass_defect_kg.iter().flatten().copied())
        .collect()
}

#[test]
fn direct_field_balances_material_heat_and_tracer_without_mechanical_heaters() {
    let m = model();
    let w = evaluate(&m, 0.);
    let total = |f: fn(&Sources) -> Scalar| w.sources.iter().flatten().fold(s(0.), |a, r| a + f(r));
    for q in [total(|r| r.mass), total(|r| r.enthalpy), total(|r| r.boron)] {
        close(q.value, 0., 1e-7);
        close(q.direction, 0., 1e-7);
    }
    assert!(w.wall_loss_w.iter().flatten().all(|q| q.value >= 0.));
    assert!(w.slip_loss_w.iter().all(|q| q.value > 0.));
    assert!(w.molecular_loss_w.iter().flatten().all(|q| q.value >= 0.));
    assert!(
        w.conversion_mixing_loss_w
            .iter()
            .flatten()
            .all(|q| q.value >= 0.)
    );
    // Dissipation is positive but summed thermal H still has no extra heater.
    assert!(w.wall_loss_w.iter().flatten().map(|q| q.value).sum::<f64>() > 0.);
    assert_eq!(w.zero_slip_inexact_contacts, 0);
    let x = phases(&m, 0.);
    let q = flows(0.);
    m.validate_accepted(&Input {
        pressure: s(15e6),
        saturation: saturation(0.),
        phase: &x,
        face_mass_flow: &q,
    })
    .unwrap();
    for r in w.mass_defect_kg.iter().flatten().chain(&w.volume_defect_m3) {
        close(r.value, 0., 1e-10);
        close(r.direction, 0., 1e-10);
    }
}
#[test]
fn smooth_current_directions_include_every_transport_property_and_force_port() {
    let m = model();
    let base = values(&evaluate(&m, 0.));
    let h = 1e-4;
    let plus = values(&evaluate(&m, h));
    let minus = values(&evaluate(&m, -h));
    for (i, ((a, p), n)) in base.iter().zip(plus).zip(minus).enumerate() {
        let fd = (p.value - n.value) / (2. * h);
        assert!(
            (a.direction - fd).abs() < 3e-6 * (1. + a.direction.abs().max(fd.abs())),
            "row{i}: {} != {fd}",
            a.direction
        );
    }
}
#[test]
fn exact_absence_has_responsible_arrivals_and_no_phantom_caloric_or_tracer_owner() {
    let m = model();
    let mut x = phases(&m, 0.);
    for (i, node) in x.iter_mut().enumerate() {
        let k = usize::from(i >= 6);
        let mut p = node[k].unwrap();
        p.volume = s(m.regions()[i].volume_m3);
        p.mass = p.volume * p.water.density;
        p.velocity = [s(0.); 2];
        p.boron_mass = if k == 0 { p.mass * s(0.0005) } else { s(0.) };
        *node = [None; 2];
        node[k] = Some(p);
    }
    let mut q = [[s(0.); 2]; FACES];
    let mut w = Work::default();
    let run = |q: &[[Scalar; 2]; FACES], external: &[[Sources; 2]; REGIONS], w: &mut Work| {
        m.evaluate(
            Input {
                pressure: s(15e6),
                saturation: saturation(0.),
                phase: &x,
                face_mass_flow: q,
            },
            external,
            w,
        )
    };
    let zero = [[Sources::default(); 2]; REGIONS];
    run(&q, &zero, &mut w).unwrap();
    assert_eq!(w.zero_slip_inexact_contacts, 2);
    assert!(
        w.birth_receipts
            .iter()
            .flatten()
            .all(|r| r.mass.value == 0.)
    );
    let edge = m
        .faces()
        .iter()
        .position(|f| f.from == 4 && f.to == 6)
        .unwrap();
    q[edge][1] = s(-0.1);
    run(&q, &zero, &mut w).unwrap();
    close(w.birth_receipts[4][1].mass.value, 0.1, 1e-14);
    close(
        w.birth_receipts[4][1].enthalpy.value,
        0.1 * x[6][1].unwrap().water.enthalpy.value,
        1e-14,
    );
    assert_eq!(w.birth_receipts[4][1].boron.value, 0.);
    q[edge][1] = s(0.1);
    assert!(run(&q, &zero, &mut w).unwrap_err().contains("absent donor"));
    q[edge][1] = Scalar::new(0., -0.1);
    run(&q, &zero, &mut w).unwrap();
    close(w.birth_receipts[4][1].mass.direction, 0.1, 1e-14);
    assert_eq!(w.birth_receipts[4][1].enthalpy.value, 0.);
    q[edge][1] = s(0.);
    let mut wrong = zero;
    wrong[4][1].enthalpy = s(1.);
    assert!(
        run(&q, &wrong, &mut w)
            .unwrap_err()
            .contains("no independent")
    );
    wrong[4][1].mass = Scalar::new(0., 1.);
    assert!(
        run(&q, &wrong, &mut w)
            .unwrap_err()
            .contains("no independent")
    );
    wrong = zero;
    wrong[4][1].mass = s(0.1);
    wrong[4][1].boron = s(0.001);
    assert!(run(&q, &wrong, &mut w).unwrap_err().contains("boron"));
}
#[test]
fn zero_slip_heat_value_keeps_sqrt_cusp_and_declares_inexact_linearization() {
    let m = model();
    let mut x = phases(&m, 0.);
    for node in &mut x {
        for p in node.iter_mut().flatten() {
            for v in [
                &mut p.mass,
                &mut p.volume,
                &mut p.temperature,
                &mut p.boron_mass,
            ] {
                v.direction = 0.;
            }
            p.water = properties(p.temperature, p.water.density.value < 100.);
            p.velocity = [s(0.); 2];
        }
        node[1].as_mut().unwrap().velocity[1].direction = 1.;
    }
    let sat = {
        let mut q = saturation(0.);
        q.temperature.direction = 0.;
        q.liquid = properties(q.temperature, false);
        q.vapor = properties(q.temperature, true);
        q
    };
    let q = [[s(0.); 2]; FACES];
    let external = [[Sources::default(); 2]; REGIONS];
    let run = |x: &[[Option<Phase>; 2]; REGIONS]| {
        let mut w = Work::default();
        m.evaluate(
            Input {
                pressure: s(15e6),
                saturation: sat,
                phase: x,
                face_mass_flow: &q,
            },
            &external,
            &mut w,
        )
        .unwrap();
        w
    };
    let base = run(&x);
    assert!(base.zero_slip_inexact_contacts >= 10);
    assert_eq!(base.sources[0][0].enthalpy.direction, 0.);
    let mut a = x;
    let mut b = x;
    for node in &mut a {
        node[1].as_mut().unwrap().velocity[1].value = 1e-8;
    }
    for node in &mut b {
        node[1].as_mut().unwrap().velocity[1].value = 4e-8;
    }
    let da = run(&a).sources[0][0].enthalpy.value - base.sources[0][0].enthalpy.value;
    let db = run(&b).sources[0][0].enthalpy.value - base.sources[0][0].enthalpy.value;
    assert!(da.abs() > 1.);
    close(db / da, 2., 1e-7);
    // The one-sided quotient grows as 1/sqrt(delta); returned zero is explicitly
    // an inexact Newton coefficient, not a finite exact physical derivative.
    assert!((da / 1e-8).abs() > (db / 4e-8).abs() * 1.9);
}
#[test]
fn actual_finite_birth_and_exhaustion_preserve_work_momentum_and_residue() {
    let before = [
        PhaseInventory::default(),
        PhaseInventory {
            mass_kg: 10.,
            internal_energy_j: 26e6,
            momentum_kg_m_s: [1., 2.],
            dissolved_boron_kg: 0.,
        },
    ];
    let receipt = [
        FiniteReceipt {
            mass_kg: 1.,
            thermal_enthalpy_j: 1.4e6,
            phase_volume_m3: 0.002,
            momentum_kg_m_s: [0.3, -0.1],
            dissolved_boron_kg: 0.0005,
        },
        FiniteReceipt {
            phase_volume_m3: -0.002,
            ..FiniteReceipt::default()
        },
    ];
    let born = pzr::apply_phase_receipts(15e6, before, receipt).unwrap();
    assert_eq!(born.active, Active::TwoPhase);
    assert_eq!(born.phase_volume_defect_m3, 0.);
    close(
        born.inventory.iter().map(|p| p.internal_energy_j).sum(),
        27.4e6,
        1e-14,
    );
    assert_eq!(born.inventory[1].momentum_kg_m_s, before[1].momentum_kg_m_s);
    let mut removal = [
        FiniteReceipt {
            mass_kg: -1.,
            thermal_enthalpy_j: -1.4e6,
            phase_volume_m3: -0.002,
            momentum_kg_m_s: [-0.3, 0.1],
            dissolved_boron_kg: 0.,
        },
        FiniteReceipt {
            phase_volume_m3: 0.002,
            ..FiniteReceipt::default()
        },
    ];
    assert!(
        pzr::apply_phase_receipts(15e6, born.inventory, removal)
            .unwrap_err()
            .contains("residue")
    );
    removal[0].dissolved_boron_kg = -0.0005;
    let gone = pzr::apply_phase_receipts(15e6, born.inventory, removal).unwrap();
    assert_eq!(gone.active, Active::Vapor);
    assert_eq!(gone.inventory[0].mass_kg, 0.);
    assert_eq!(
        gone.inventory[1].internal_energy_j,
        before[1].internal_energy_j
    );
    // Actual transfer destination must own removed boron; it cannot disappear
    // through a phase-layout change or be reassigned to vapor.
    let mut wrong = receipt;
    wrong[1].dissolved_boron_kg = 0.0005;
    assert!(pzr::apply_phase_receipts(15e6, before, wrong).is_err());
    // Each updated phase energy remains finite, but the aggregate volume row
    // must also refuse overflow rather than publish an infinite diagnostic.
    let finite_stocks = [PhaseInventory {
        mass_kg: 1.,
        ..PhaseInventory::default()
    }; 2];
    let overflowing_volume = [FiniteReceipt {
        phase_volume_m3: 1e308,
        ..FiniteReceipt::default()
    }; 2];
    assert!(pzr::apply_phase_receipts(1., finite_stocks, overflowing_volume).is_err());
}

#[test]
fn reversal_uses_actual_liquid_donor_and_signed_trials_are_not_clipped() {
    let m = model();
    let mut x = phases(&m, 0.);
    let zero = [[Sources::default(); 2]; REGIONS];
    let mut q = [[s(0.); 2]; FACES];
    let mut a = Work::default();
    let mut b = Work::default();
    let run = |x: &[[Option<Phase>; 2]; REGIONS], q: &[[Scalar; 2]; FACES], w: &mut Work| {
        m.evaluate(
            Input {
                pressure: s(15e6),
                saturation: saturation(0.),
                phase: x,
                face_mass_flow: q,
            },
            &zero,
            w,
        )
    };
    q[0][0] = s(0.1);
    run(&x, &q, &mut a).unwrap();
    q[0][0] = s(-0.1);
    run(&x, &q, &mut b).unwrap();
    let f = m.faces()[0];
    let l = x[f.from][0].unwrap();
    let r = x[f.to][0].unwrap();
    close(
        b.sources[f.from][0].enthalpy.value - a.sources[f.from][0].enthalpy.value,
        0.1 * (l.water.enthalpy.value + r.water.enthalpy.value),
        1e-11,
    );
    close(
        b.sources[f.from][0].boron.value - a.sources[f.from][0].boron.value,
        0.1 * (l.boron_mass.value / l.mass.value + r.boron_mass.value / r.mass.value),
        1e-12,
    );
    x[0][0].as_mut().unwrap().mass.value = -1.;
    run(&x, &q, &mut b).unwrap();
    assert!(b.mass_defect_kg[0][0].value < 0.);
    assert_eq!(x[0][0].unwrap().mass.value, -1.);
    assert!(
        m.validate_accepted(&Input {
            pressure: s(15e6),
            saturation: saturation(0.),
            phase: &x,
            face_mass_flow: &q
        })
        .is_err()
    );
    x[0][0].as_mut().unwrap().mass.value = f64::NAN;
    assert!(run(&x, &q, &mut b).is_err());
    assert!(
        m.validate_accepted(&Input {
            pressure: s(15e6),
            saturation: saturation(0.),
            phase: &x,
            face_mass_flow: &q
        })
        .is_err()
    );
}

#[test]
fn accepted_admission_refuses_nonfinite_state_property_and_flow_seeds() {
    let m = model();
    let phase = phases(&m, 0.);
    let q = flows(0.);
    let sat = saturation(0.);
    let admit = |pressure,
                 saturation,
                 phase: &[[Option<Phase>; 2]; REGIONS],
                 face_mass_flow: &[[Scalar; 2]; FACES]| {
        m.validate_accepted(&Input {
            pressure,
            saturation,
            phase,
            face_mass_flow,
        })
    };
    admit(s(15e6), sat, &phase, &q).unwrap();
    let fields: [fn(&mut Phase) -> &mut Scalar; 12] = [
        |p| &mut p.mass,
        |p| &mut p.volume,
        |p| &mut p.temperature,
        |p| &mut p.velocity[0],
        |p| &mut p.velocity[1],
        |p| &mut p.boron_mass,
        |p| &mut p.water.density,
        |p| &mut p.water.viscosity,
        |p| &mut p.water.conductivity,
        |p| &mut p.water.cp,
        |p| &mut p.water.expansion,
        |p| &mut p.water.enthalpy,
    ];
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for direction in [false, true] {
            let invalidate = |v: &mut Scalar| {
                if direction {
                    v.direction = bad;
                } else {
                    v.value = bad;
                }
            };
            for k in 0..2 {
                for select in fields {
                    let mut x = phase;
                    invalidate(select(x[0][k].as_mut().unwrap()));
                    assert!(admit(s(15e6), sat, &x, &q).is_err());
                }
            }
            let mut p = s(15e6);
            invalidate(&mut p);
            assert!(admit(p, sat, &phase, &q).is_err());
            let mut saturation = sat;
            invalidate(&mut saturation.temperature);
            assert!(admit(s(15e6), saturation, &phase, &q).is_err());
            for k in 0..2 {
                let mut current = q;
                invalidate(&mut current[0][k]);
                assert!(admit(s(15e6), sat, &phase, &current).is_err());
            }
        }
    }
}

#[test]
fn accepted_admission_requires_positive_phase_domains_and_no_vapor_boron() {
    let m = model();
    let phase = phases(&m, 0.);
    let q = flows(0.);
    let sat = saturation(0.);
    let admit = |pressure, saturation, phase: &[[Option<Phase>; 2]; REGIONS]| {
        m.validate_accepted(&Input {
            pressure,
            saturation,
            phase,
            face_mass_flow: &q,
        })
    };
    let positive_fields: [fn(&mut Phase) -> &mut Scalar; 7] = [
        |p| &mut p.mass,
        |p| &mut p.volume,
        |p| &mut p.temperature,
        |p| &mut p.water.density,
        |p| &mut p.water.viscosity,
        |p| &mut p.water.conductivity,
        |p| &mut p.water.cp,
    ];
    for invalid in [0., -1.] {
        assert!(admit(s(invalid), sat, &phase).is_err());
        let mut saturation = sat;
        saturation.temperature = s(invalid);
        assert!(admit(s(15e6), saturation, &phase).is_err());
        saturation = sat;
        saturation.vapor.enthalpy = saturation.liquid.enthalpy + s(invalid);
        assert!(admit(s(15e6), saturation, &phase).is_err());
        for k in 0..2 {
            for select in positive_fields {
                let mut x = phase;
                *select(x[0][k].as_mut().unwrap()) = s(invalid);
                assert!(admit(s(15e6), sat, &x).is_err());
            }
        }
    }
    for boron in [Scalar::new(1e-9, 0.), Scalar::new(0., 1e-9)] {
        let mut x = phase;
        x[0][1].as_mut().unwrap().boron_mass = boron;
        assert!(admit(s(15e6), sat, &x).is_err());
    }
    // A missing phase owns no fields; a fully empty region still needs its
    // separately specified evacuated-domain chart, not positive placeholders.
    let mut x = phase;
    x[0] = [None; 2];
    assert!(admit(s(15e6), sat, &x).is_err());
}

#[test]
fn bounded_fresh_constitutive_port_cost_is_not_a_trajectory_or_eos_benchmark() {
    if cfg!(debug_assertions) {
        return;
    }
    let m = model();
    let mut x = phases(&m, 0.);
    let mut q = flows(0.);
    let external = [[Sources::default(); 2]; REGIONS];
    let mut w = Work::default();
    let timer = std::time::Instant::now();
    for i in 0..50 {
        q[0][0].value = 0.1 + i as f64 * 1e-5;
        x[0][1].as_mut().unwrap().velocity[1].value = 0.13 + i as f64 * 1e-5;
        m.evaluate(
            Input {
                pressure: s(15e6),
                saturation: saturation(0.),
                phase: &x,
                face_mass_flow: &q,
            },
            &external,
            &mut w,
        )
        .unwrap();
        std::hint::black_box(&w);
    }
    eprintln!(
        "PZR field: 50 fresh current-flow/velocity calls {:.9}s; actual geometry/synthetic borrowed properties, no EOS/property cost or advancement",
        timer.elapsed().as_secs_f64()
    );
}

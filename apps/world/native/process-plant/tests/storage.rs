use leitbild_plant_numerics::*;

fn liquid(t: f64, p: f64) -> Liquid {
    let mut out = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            temperature: t,
            pressure: p,
        }],
        &mut out,
    )
    .unwrap();
    out[0]
}

#[test]
fn actual_liquid_storage_and_derivatives() {
    for (t, p) in [
        (290., 101325.),
        (313.15, 15.2e6),
        (450., 15.2e6),
        (600., 15.2e6),
        (640., 20.5e6),
    ] {
        let w = liquid(t, p);
        let g = CellGeometry {
            volume: 0.03,
            elevation: 5.,
        };
        let momentum = 1.2 * g.volume * w.density;
        let s = storage(g, w, momentum, 2.).unwrap();
        assert!((w.enthalpy - w.internal_energy - w.pressure / w.density).abs() < 1e-6);
        let j = storage_jacobian(g, w, momentum, 2.).unwrap();
        let ks = w.compressibility - w.temperature * w.expansion * w.expansion / (w.density * w.cp);
        assert!(ks > 0.);
        let determinant =
            j.mass_pressure * j.energy_temperature - j.mass_temperature * j.energy_pressure;
        assert!((determinant / (s.mass * s.mass * w.cp * ks) - 1.).abs() < 1e-8);
        for factor in [1., 0.5] {
            for (dp, dt, dmom, dq) in [
                (p * 1e-5 * factor, 0., 0., 0.),
                (0., 2e-4 * factor, 0., 0.),
                (0., 0., momentum * 1e-5 * factor, 0.),
                (0., 0., 0., 0.1 * factor),
            ] {
                let plus = storage(g, liquid(t + dt, p + dp), momentum + dmom, 2. + dq).unwrap();
                let minus = storage(g, liquid(t - dt, p - dp), momentum - dmom, 2. - dq).unwrap();
                let mass_change = (plus.mass - minus.mass) / 2.;
                let energy_change = (plus.energy - minus.energy) / 2.;
                let expected_mass = j.mass_pressure * dp + j.mass_temperature * dt;
                let expected_energy = j.energy_pressure * dp
                    + j.energy_temperature * dt
                    + j.energy_momentum * dmom
                    + dq;
                assert!((mass_change - expected_mass).abs() < 1e-9 + expected_mass.abs() * 1e-3);
                assert!(
                    (energy_change - expected_energy).abs() < 1e-3 + expected_energy.abs() * 1e-3
                );
            }
        }
        let rates = j.pressure_temperature_increment(0.01, 100.).unwrap();
        assert!((j.mass_pressure * rates[0] + j.mass_temperature * rates[1] - 0.01).abs() < 1e-10);
        assert!(
            (j.energy_pressure * rates[0] + j.energy_temperature * rates[1] - 100.).abs() < 1e-6
        );
        let recovered = recover_liquid(
            g,
            s,
            LiquidQuery {
                temperature: t + 0.02,
                pressure: p * 1.0001,
            },
            RecoveryAccuracy {
                mass_kg: s.mass * 1e-12,
                energy_j: 1e-5,
                iterations: 16,
            },
        )
        .unwrap();
        assert!((recovered.pressure - p).abs() <= 1.);
        assert!((recovered.temperature - t).abs() <= 1e-5);
    }
}

#[test]
fn batch_matches_scalar_and_independent_workers() {
    let queries: Vec<_> = (0..128)
        .map(|i| LiquidQuery {
            temperature: 313.15 + 0.1 * (i as f64),
            pressure: 15.2e6 + 100. * (i as f64),
        })
        .collect();
    let mut batch = vec![Liquid::default(); queries.len()];
    liquid_batch(&queries, &mut batch).unwrap();
    for (i, q) in queries.iter().enumerate() {
        let s = liquid(q.temperature, q.pressure);
        assert_eq!(batch[i].density, s.density);
        assert_eq!(batch[i].internal_energy, s.internal_energy);
    }
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    let mut own = vec![Liquid::default(); queries.len()];
                    liquid_batch(&queries, &mut own).unwrap();
                    own
                })
            })
            .collect();
        for worker in workers {
            let own = worker.join().unwrap();
            for i in 0..queries.len() {
                assert_eq!(own[i].density, batch[i].density);
            }
        }
    });
}

#[test]
fn explicit_failure_and_owned_energy() {
    let queries = [
        LiquidQuery {
            temperature: 313.15,
            pressure: 15.2e6,
        },
        LiquidQuery {
            temperature: 450.,
            pressure: 101325.,
        },
    ];
    let mut out = [Liquid::default(); 2];
    assert_eq!(liquid_batch(&queries, &mut out).unwrap_err().index, 1);
    assert!(liquid_batch(&queries, &mut out[..1]).is_err());
    let w = liquid(313.15, 15.2e6);
    assert!(
        storage(
            CellGeometry {
                volume: 1.,
                elevation: 0.
            },
            Liquid { expansion: 1., ..w },
            0.,
            0.
        )
        .is_err()
    );
    let g = CellGeometry {
        volume: 1.,
        elevation: 0.,
    };
    for invalid in [
        Liquid {
            cv: f64::INFINITY,
            ..w
        },
        Liquid {
            sound_speed: f64::INFINITY,
            ..w
        },
        Liquid {
            viscosity: f64::INFINITY,
            ..w
        },
        Liquid {
            conductivity: f64::INFINITY,
            ..w
        },
    ] {
        assert!(storage(g, invalid, 0., 0.).is_err());
    }
    assert!(storage(g, w, 0., -1.).is_err());
    assert!(storage(CellGeometry { volume: 0., ..g }, w, 0., 0.).is_err());
    let base = storage(g, w, 0., 0.).unwrap();
    let raised = storage(
        CellGeometry {
            elevation: 10.,
            ..g
        },
        w,
        0.,
        3.,
    )
    .unwrap();
    assert!((raised.energy - base.energy - base.mass * GRAVITY * 10. - 3.).abs() < 1e-6);
}

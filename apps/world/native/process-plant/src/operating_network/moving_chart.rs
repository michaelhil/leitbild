//! Forward inventory chart for a cold sound-filtered territory. Pressure datum
//! stays fixed; the actual water volume/first moment need not stay fixed.
//! This pure operator is also consumed by the existing fixed network at zero
//! shape derivative. No inventory projection, EOS calls or moving-network
//! advancement is implied by exposing its prospective shape terms.
use crate::{CellGeometry, Liquid, GRAVITY};

#[derive(Clone, Copy, Debug)]
pub struct ShapeDirection {
    pub volume_m2: f64,
    pub first_moment_m3: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct InventoryChart {
    pub mass_kg: f64,
    pub energy_j: f64,
    /// [M_p,M_T,E_p,E_T] with pressure at the retained fixed reference datum.
    pub thermal_partials: [f64; 4],
    /// [M_y,E_y] for one supplied geometry direction; several independent
    /// cluster directions reuse the same thermal chart without another EOS.
    pub shape_partials: [f64; 2],
    /// Mdot=a*Pdot+b*Edot+c*ydot, not a new compression store.
    pub redistribution: [f64; 3],
}
pub fn inventory_chart(
    geometry: CellGeometry,
    shape: ShapeDirection,
    l: Liquid,
    p: f64,
    t: f64,
) -> Result<InventoryChart, String> {
    if ![
        geometry.volume,
        geometry.elevation,
        shape.volume_m2,
        shape.first_moment_m3,
        l.density,
        l.internal_energy,
        l.cp,
        l.compressibility,
        l.expansion,
        p,
        t,
    ]
    .iter()
    .all(|x| x.is_finite())
        || geometry.volume <= 0.
        || l.density <= 0.
        || p <= 0.
        || t <= 0.
    {
        return Err("Invalid forward moving-volume chart".into());
    }
    // Preserve the existing fixed chart's arithmetic and energy datum.
    let m = geometry.volume * l.density;
    let u = l.internal_energy + GRAVITY * geometry.elevation;
    let mp = m * l.compressibility;
    let mt = -m * l.expansion;
    let ep = u * mp + geometry.volume * (p * l.compressibility - t * l.expansion);
    let et = u * mt + m * (l.cp - p * l.expansion / l.density);
    if ![mp, mt, ep, et].iter().all(|x| x.is_finite()) || et <= 0. {
        return Err("Singular local energy chart".into());
    }
    let a = mp - mt * ep / et;
    let b = mt / et;
    let my = l.density * shape.volume_m2;
    let ey = l.density * (l.internal_energy * shape.volume_m2 + GRAVITY * shape.first_moment_m3);
    let c = my - b * ey;
    if ![a, b, c, my, ey].iter().all(|x| x.is_finite()) || a <= 0. {
        return Err("Unsupported local pressure/energy chart".into());
    }
    let energy = m * u;
    if !m.is_finite() || !energy.is_finite() {
        return Err("Unrepresentable forward moving inventory".into());
    }
    Ok(InventoryChart {
        mass_kg: m,
        energy_j: energy,
        thermal_partials: [mp, mt, ep, et],
        shape_partials: [my, ey],
        redistribution: [a, b, c],
    })
}
/// Aggregate pressure rate for actual conservative M/E rates. Each supplied
/// shape mass-rate is the already-contracted sum_j(c_ij*ydot_j) for ONE
/// territory; its thermal chart/energy rate is counted once, even when many
/// independent cluster coordinates displace that territory.
pub fn shared_pressure_rate(
    total_mass_rate: f64,
    charts: &[InventoryChart],
    energy_rates: &[f64],
    shape_mass_rates: &[f64],
) -> Result<f64, &'static str> {
    if charts.is_empty()
        || charts.len() != energy_rates.len()
        || charts.len() != shape_mass_rates.len()
        || !total_mass_rate.is_finite()
        || energy_rates
            .iter()
            .chain(shape_mass_rates)
            .any(|x| !x.is_finite())
    {
        return Err("Invalid aggregate moving-volume rate input");
    }
    let mut a = 0.;
    let mut rest = 0.;
    for ((c, e), shape_rate) in charts.iter().zip(energy_rates).zip(shape_mass_rates) {
        if c.redistribution.iter().any(|x| !x.is_finite()) || c.redistribution[0] <= 0. {
            return Err("Invalid retained moving-volume rate chart");
        }
        a += c.redistribution[0];
        rest += c.redistribution[1] * e + shape_rate;
    }
    if !a.is_finite() || !rest.is_finite() {
        return Err("Unrepresentable aggregate moving-volume chart");
    }
    let rate = (total_mass_rate - rest) / a;
    if !rate.is_finite() {
        return Err("Unrepresentable aggregate moving-volume pressure rate");
    }
    Ok(rate)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{liquid_batch, LiquidQuery};
    fn liquid(p: f64, t: f64) -> Liquid {
        let mut out = [Liquid::default()];
        liquid_batch(
            &[LiquidQuery {
                pressure: p,
                temperature: t,
            }],
            &mut out,
        )
        .unwrap();
        out[0]
    }
    fn near(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() < tol * (1. + a.abs() + b.abs()), "{a} != {b}");
    }
    #[test]
    fn shape_and_thermal_derivatives_match_current_native_eos() {
        let (p, t) = (3e5, 300.);
        let l = liquid(p, t);
        let v = 0.4;
        let j = 0.1;
        let s = ShapeDirection {
            volume_m2: 0.001,
            first_moment_m3: -0.002,
        };
        let c = inventory_chart(
            CellGeometry {
                volume: v,
                elevation: j / v,
            },
            s,
            l,
            p,
            t,
        )
        .unwrap();
        let h = 1e-5;
        let eval = |d: f64| {
            let vp = v + d * s.volume_m2;
            let jp = j + d * s.first_moment_m3;
            inventory_chart(
                CellGeometry {
                    volume: vp,
                    elevation: jp / vp,
                },
                s,
                l,
                p,
                t,
            )
            .unwrap()
        };
        let a = eval(h);
        let b = eval(-h);
        near(
            (a.mass_kg - b.mass_kg) / (2. * h),
            c.shape_partials[0],
            2e-8,
        );
        near(
            (a.energy_j - b.energy_j) / (2. * h),
            c.shape_partials[1],
            2e-8,
        );
        for (k, h) in [0.1, 1e-3].into_iter().enumerate() {
            let (pp, tp, pm, tm) = if k == 0 {
                (p + h, t, p - h, t)
            } else {
                (p, t + h, p, t - h)
            };
            let a = inventory_chart(
                CellGeometry {
                    volume: v,
                    elevation: j / v,
                },
                s,
                liquid(pp, tp),
                pp,
                tp,
            )
            .unwrap();
            let b = inventory_chart(
                CellGeometry {
                    volume: v,
                    elevation: j / v,
                },
                s,
                liquid(pm, tm),
                pm,
                tm,
            )
            .unwrap();
            near(
                (a.mass_kg - b.mass_kg) / (2. * h),
                c.thermal_partials[k],
                2e-6,
            );
            near(
                (a.energy_j - b.energy_j) / (2. * h),
                c.thermal_partials[2 + k],
                2e-6,
            );
        }
    }
    #[test]
    fn aggregate_continuity_includes_real_shape_rate_and_preserves_fixed_chart() {
        let l = liquid(3e5, 300.);
        let fixed = ShapeDirection {
            volume_m2: 0.,
            first_moment_m3: 0.,
        };
        let c = inventory_chart(
            CellGeometry {
                volume: 0.4,
                elevation: 1.,
            },
            fixed,
            l,
            3e5,
            300.,
        )
        .unwrap();
        assert_eq!(c.redistribution[2], 0.);
        let charts = [
            inventory_chart(
                CellGeometry {
                    volume: 0.4,
                    elevation: 1.,
                },
                ShapeDirection {
                    volume_m2: 0.001,
                    first_moment_m3: -0.002,
                },
                l,
                3e5,
                300.,
            )
            .unwrap(),
            inventory_chart(
                CellGeometry {
                    volume: 5.,
                    elevation: 3.,
                },
                ShapeDirection {
                    volume_m2: -0.001,
                    first_moment_m3: -0.003,
                },
                l,
                3e5,
                300.,
            )
            .unwrap(),
        ];
        let rates = [20., -19.];
        let velocities = [0.008, 0.008];
        let massrate = 0.003;
        let shape_rates = [
            charts[0].redistribution[2] * velocities[0],
            charts[1].redistribution[2] * velocities[1],
        ];
        let pd = shared_pressure_rate(massrate, &charts, &rates, &shape_rates).unwrap();
        let sum: f64 = charts
            .iter()
            .zip(rates)
            .zip(velocities)
            .map(|((c, e), v)| {
                c.redistribution[0] * pd + c.redistribution[1] * e + c.redistribution[2] * v
            })
            .sum();
        near(sum, massrate, 1e-12);
        let no_shape = shared_pressure_rate(massrate, &[c, c], &rates, &[0., 0.]).unwrap();
        assert!((pd - no_shape).abs() > 1e-3);
    }
    #[test]
    fn independent_pose_terms_do_not_duplicate_one_territory_capacity() {
        let l = liquid(3e5, 300.);
        let geometry = CellGeometry {
            volume: 5.,
            elevation: 3.,
        };
        let directions = [
            ShapeDirection {
                volume_m2: 0.001,
                first_moment_m3: 0.003,
            },
            ShapeDirection {
                volume_m2: -0.002,
                first_moment_m3: -0.007,
            },
        ];
        let charts =
            directions.map(|shape| inventory_chart(geometry, shape, l, 3e5, 300.).unwrap());
        assert_eq!(charts[0].thermal_partials, charts[1].thermal_partials);
        let velocities = [0.008, -0.003];
        let contracted = charts[0].redistribution[2] * velocities[0]
            + charts[1].redistribution[2] * velocities[1];
        let pd = shared_pressure_rate(0., &charts[..1], &[20.], &[contracted]).unwrap();
        near(
            charts[0].redistribution[0] * pd + charts[0].redistribution[1] * 20. + contracted,
            0.,
            1e-12,
        );
    }
    #[test]
    fn zero_shape_preserves_previous_fixed_chart_arithmetic_bits() {
        for (p, t, v, z) in [
            (1e5, 293.15, 0.4, -2.25),
            (3e5, 306., 10., 2.4),
            (1e6, 330., 5., 8.5),
        ] {
            let l = liquid(p, t);
            let m = v * l.density;
            let u = l.internal_energy + GRAVITY * z;
            let mp = m * l.compressibility;
            let mt = -m * l.expansion;
            let ep = u * mp + v * (p * l.compressibility - t * l.expansion);
            let et = u * mt + m * (l.cp - p * l.expansion / l.density);
            let a = mp - mt * ep / et;
            let b = mt / et;
            let c = inventory_chart(
                CellGeometry {
                    volume: v,
                    elevation: z,
                },
                ShapeDirection {
                    volume_m2: 0.,
                    first_moment_m3: 0.,
                },
                l,
                p,
                t,
            )
            .unwrap();
            for (old, new) in [mp, mt, ep, et, a, b].into_iter().zip(
                c.thermal_partials
                    .into_iter()
                    .chain(c.redistribution[..2].iter().copied()),
            ) {
                assert_eq!(old.to_bits(), new.to_bits());
            }
            assert_eq!(c.redistribution[2], 0.);
        }
    }
}

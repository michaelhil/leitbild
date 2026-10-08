//! Selected cold-return scalar exchange, separate from net hydraulic transport.
//! Both potential densities are recovered at one common pressure. No added
//! water stock, counterstream momentum, minimum turnover or turbulent cache.
use crate::{liquid_batch, Liquid, LiquidQuery, GRAVITY};

#[derive(Clone, Copy, Debug)]
pub struct Mixing {
    pub from: usize,
    pub to: usize,
    pub area: f64,
    pub separation: f64,
    pub diameter: f64,
    pub slope: f64,
    pub penetration_average: f64,
    pub sg_flow_edge: usize,
    pub sg_water: usize,
    pub sg_flow_area: f64,
    pub coefficient: f64,
    pub prandtl: f64,
    pub schmidt: f64,
}
impl Mixing {
    pub fn validate(&self) -> Result<(), String> {
        if self.from == self.to
            || ![
                self.area,
                self.separation,
                self.diameter,
                self.sg_flow_area,
                self.coefficient,
                self.prandtl,
                self.schmidt,
            ]
            .iter()
            .all(|x| x.is_finite() && *x > 0.)
            || !self.slope.is_finite()
            || self.slope.abs() > 1.
            || !self.penetration_average.is_finite()
            || !(0.0..=1.0).contains(&self.penetration_average)
        {
            return Err("Invalid physical PRHR return mixing interval".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Response {
    /// Positive heat moves from the lower/SG end to the upper/bank end.
    pub heat_w: f64,
    /// Reciprocal species flux is this coefficient times actual concentration
    /// difference, NOT another pair of water mass/advection currents.
    pub scalar_kg_s: f64,
    /// Local constitutive partials [common p, Tfrom, Tto, actual SG velocity].
    /// At SG velocity zero, |U| uses its zero generalized-Newton selection,
    /// not a classical derivative for nonzero heat/scalar contrast.
    /// At neutral buoyancy the positive-part drive also uses its inactive
    /// zero generalized selection. Both cusps are bounded Lipschitz, not
    /// classical derivatives at nonzero transported contrast.
    pub heat_partials: [f64; 4],
    pub scalar_partials: [f64; 4],
}

/// Selected effective circular-cell drag: v² + (32 nu / D) v = drive.
/// The 32 comes from circular Poiseuille mean-flow drag; this is an authored
/// gradient-diffusion closure, not resolved countercurrent pipe momentum or
/// calibrated low-drive startup timing. The inertial asymptote retains the
/// former sqrt(drive) selection; finite viscosity gives bounded onset slopes.
/// Rationalizing the positive root avoids cancellation as drive tends to zero.
fn buoyant_speed(drive: f64, drag: f64) -> f64 {
    2. * drive / (drag + drag.hypot(2. * drive.sqrt()))
}

fn properties(x: [f64; 4], requests: &mut usize) -> Result<[Liquid; 2], String> {
    if !x.iter().all(|v| v.is_finite()) || x[0] <= 0. || x[1] <= 0. || x[2] <= 0. {
        return Err("Invalid PRHR mixing trial".into());
    }
    let queries = [
        LiquidQuery {
            pressure: x[0],
            temperature: x[1],
        },
        LiquidQuery {
            pressure: x[0],
            temperature: x[2],
        },
    ];
    let mut water = [Liquid::default(); 2];
    *requests += queries.len();
    liquid_batch(&queries, &mut water)
        .map_err(|e| format!("PRHR mixing liquid {}: {}", e.index, e.message))?;
    Ok(water)
}
/// Stable local EOS divided difference, not a buoyancy threshold. Independent
/// rounded densities lose their difference before adjacent temperatures lose
/// theirs. On a short, locally monotone interval integrate rho_T with the
/// endpoint trapezoid: its omitted term is O((Tb-Ta)^3), rather than the O(rho
/// epsilon) subtraction noise. The sqrt(epsilon) relative interval selects a
/// numerical short-interval evaluation; it does not zero any physical flux.
/// Resolvable density differences and intervals crossing a density extremum
/// retain their direct EOS evaluation.
/// The arithmetic cancellation bound selects an evaluation formula; it is
/// not a certified forward-error bound for the complete native IF97 routine.
fn density_difference(a: &Liquid, b: &Liquid, ta: f64, tb: f64) -> (f64, bool) {
    let raw = b.density - a.density;
    let da = -a.density * a.expansion;
    let db = -b.density * b.expansion;
    let dt = tb - ta;
    let gamma3 = 3. * f64::EPSILON / (1. - 3. * f64::EPSILON);
    let cancellation = raw.abs() <= gamma3 * a.density.abs() + gamma3 * b.density.abs();
    let short = dt.abs() <= f64::EPSILON.sqrt() * ta.abs().min(tb.abs());
    let monotone = da != 0. && db != 0. && da.signum() == db.signum();
    let repaired = dt != 0. && cancellation && short && monotone;
    (if repaired { dt * (da + db) / 2. } else { raw }, repaired)
}
pub fn evaluate(
    c: &Mixing,
    p: f64,
    ta: f64,
    tb: f64,
    sg_velocity: f64,
    tangent: bool,
    requests: &mut usize,
) -> Result<Response, String> {
    c.validate()?;
    let x = [p, ta, tb, sg_velocity];
    let [a, b] = properties(x, requests)?;
    let rho = (a.density + b.density) / 2.;
    let cp = (a.cp + b.cp) / 2.;
    let mu = (a.viscosity + b.viscosity) / 2.;
    let (density_difference, divided_difference) = density_difference(&a, &b, ta, tb);
    let density_contrast = density_difference * c.slope;
    let unstable = density_contrast.max(0.);
    let drive = GRAVITY * c.diameter * unstable / rho;
    let viscous_drag = 32. * mu / (rho * c.diameter);
    let buoyant_velocity = buoyant_speed(drive, viscous_drag);
    let eddy = c.coefficient * c.diameter * (x[3].abs() * c.penetration_average + buoyant_velocity);
    let molecular = 2. * a.conductivity * b.conductivity / (a.conductivity + b.conductivity);
    let heat = (molecular + rho * cp * eddy / c.prandtl) * c.area / c.separation * (x[1] - x[2]);
    let scalar = rho * eddy / c.schmidt * c.area / c.separation;
    if !heat.is_finite() || !scalar.is_finite() || scalar < 0. {
        return Err("Nonfinite PRHR scalar mixing result".into());
    }
    let mut result = Response {
        heat_w: heat,
        scalar_kg_s: scalar,
        heat_partials: [0.; 4],
        scalar_partials: [0.; 4],
    };
    if tangent {
        // Probe only smooth cp/conductivity/viscosity and rho_T coefficients.
        // Density derivatives come from this same EOS; drive and abs branches are differentiated
        // at the actual trial, never across a fixed temperature stencil.
        let dp = (p * 1e-5).max(0.1).min(p * 0.01);
        let dt = 1e-3;
        let queries = [
            LiquidQuery {
                pressure: p + dp,
                temperature: ta,
            },
            LiquidQuery {
                pressure: p - dp,
                temperature: ta,
            },
            LiquidQuery {
                pressure: p + dp,
                temperature: tb,
            },
            LiquidQuery {
                pressure: p - dp,
                temperature: tb,
            },
            LiquidQuery {
                pressure: p,
                temperature: ta + dt,
            },
            LiquidQuery {
                pressure: p,
                temperature: ta - dt,
            },
            LiquidQuery {
                pressure: p,
                temperature: tb + dt,
            },
            LiquidQuery {
                pressure: p,
                temperature: tb - dt,
            },
        ];
        let mut probes = [Liquid::default(); 8];
        *requests += queries.len();
        liquid_batch(&queries, &mut probes)
            .map_err(|e| format!("PRHR mixing coefficient {}: {}", e.index, e.message))?;
        let drhoa = [
            a.density * a.compressibility,
            -a.density * a.expansion,
            0.,
            0.,
        ];
        let drhob = [
            b.density * b.compressibility,
            0.,
            -b.density * b.expansion,
            0.,
        ];
        // Differentiate the SAME cancellation-safe contrast used by the value
        // law. The existing smooth property probes also supply rho_Tp/rho_TT;
        // no new property queries or full-flux secants are introduced.
        let rho_t = |q: &Liquid| -q.density * q.expansion;
        let da_t = [
            (rho_t(&probes[0]) - rho_t(&probes[1])) / (2. * dp),
            (rho_t(&probes[4]) - rho_t(&probes[5])) / (2. * dt),
            0.,
            0.,
        ];
        let db_t = [
            (rho_t(&probes[2]) - rho_t(&probes[3])) / (2. * dp),
            0.,
            (rho_t(&probes[6]) - rho_t(&probes[7])) / (2. * dt),
            0.,
        ];
        let da = [
            (
                (probes[0].conductivity - probes[1].conductivity) / (2. * dp),
                (probes[0].cp - probes[1].cp) / (2. * dp),
                (probes[0].viscosity - probes[1].viscosity) / (2. * dp),
            ),
            (
                (probes[4].conductivity - probes[5].conductivity) / (2. * dt),
                (probes[4].cp - probes[5].cp) / (2. * dt),
                (probes[4].viscosity - probes[5].viscosity) / (2. * dt),
            ),
            (0., 0., 0.),
            (0., 0., 0.),
        ];
        let db = [
            (
                (probes[2].conductivity - probes[3].conductivity) / (2. * dp),
                (probes[2].cp - probes[3].cp) / (2. * dp),
                (probes[2].viscosity - probes[3].viscosity) / (2. * dp),
            ),
            (0., 0., 0.),
            (
                (probes[6].conductivity - probes[7].conductivity) / (2. * dt),
                (probes[6].cp - probes[7].cp) / (2. * dt),
                (probes[6].viscosity - probes[7].viscosity) / (2. * dt),
            ),
            (0., 0., 0.),
        ];
        let conductivity_sum = a.conductivity + b.conductivity;
        let scale = c.area / c.separation;
        let velocity_sign = if sg_velocity == 0. {
            0.
        } else {
            sg_velocity.signum()
        };
        for j in 0..4 {
            let drho = (drhoa[j] + drhob[j]) / 2.;
            let dcp = (da[j].1 + db[j].1) / 2.;
            let dmu = (da[j].2 + db[j].2) / 2.;
            let dmolecular = 2.
                * (b.conductivity.powi(2) * da[j].0 + a.conductivity.powi(2) * db[j].0)
                / conductivity_sum.powi(2);
            let ddensity = if divided_difference {
                let dtemperature = if j == 1 {
                    -1.
                } else if j == 2 {
                    1.
                } else {
                    0.
                };
                dtemperature * (rho_t(&a) + rho_t(&b)) / 2. + (tb - ta) * (da_t[j] + db_t[j]) / 2.
            } else {
                drhob[j] - drhoa[j]
            };
            let dbuoyant = if unstable > 0. {
                let ddrive = GRAVITY
                    * c.diameter
                    * (ddensity * c.slope / rho - unstable * drho / rho.powi(2));
                let ddrag = viscous_drag * (dmu / mu - drho / rho);
                (ddrive - buoyant_velocity * ddrag) / (2. * buoyant_velocity + viscous_drag)
            } else {
                0.
            };
            let deddy = c.coefficient
                * c.diameter
                * (dbuoyant
                    + if j == 3 {
                        velocity_sign * c.penetration_average
                    } else {
                        0.
                    });
            let effective = rho * cp * eddy / c.prandtl;
            let deffective = (drho * cp * eddy + rho * dcp * eddy + rho * cp * deddy) / c.prandtl;
            let dcontrast = if j == 1 {
                1.
            } else if j == 2 {
                -1.
            } else {
                0.
            };
            result.heat_partials[j] = scale
                * ((dmolecular + deffective) * (ta - tb) + (molecular + effective) * dcontrast);
            result.scalar_partials[j] = scale / c.schmidt * (drho * eddy + rho * deddy);
        }
        if result
            .heat_partials
            .iter()
            .chain(&result.scalar_partials)
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite PRHR mixing tangent".into());
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viscous_inertial_speed_has_finite_low_drive_and_inertial_limits() {
        let drag = 32. * 1e-6 / 0.5;
        assert_eq!(buoyant_speed(0., drag), 0.);
        let mut previous = 0.;
        for ratio in [1e-12, 1e-6, 1., 1e6, 1e12] {
            let drive = ratio * drag * drag;
            let speed = buoyant_speed(drive, drag);
            assert!(speed > previous);
            previous = speed;
            assert!((speed * (speed + drag) - drive).abs() <= 4. * f64::EPSILON * drive);
            let derivative = 1. / (2. * speed + drag);
            let h = drive * 1e-4;
            let fd = (buoyant_speed(drive + h, drag) - buoyant_speed(drive - h, drag)) / (2. * h);
            assert!((derivative - fd).abs() <= 2e-8 * derivative);
            if ratio == 1e-12 {
                assert!((speed / (drive / drag) - 1.).abs() < 2e-12);
                assert!((derivative * drag - 1.).abs() < 3e-12);
            }
            if ratio == 1e12 {
                assert!((speed / drive.sqrt() - 1.).abs() < 1e-6);
                assert!((derivative * 2. * drive.sqrt() - 1.).abs() < 1e-6);
            }
        }
    }
    #[test]
    fn fixed_drag_selection_has_explicit_constitutive_uncertainty_not_a_floor() {
        // 16/64 brackets selected 32 using the generic test geometry and
        // reached cold T/p/U, NOT the compiled plant interval geometry.
        // This is not calibration, a coupled receipt or transient uncertainty credit.
        let mut requests = 0;
        let c = geometry();
        let ta = 293.15001023855996;
        let tb = 293.15000178743566;
        let [a, b] = properties([235583.7067, ta, tb, 0.0130827937], &mut requests).unwrap();
        let rho = (a.density + b.density) / 2.;
        let nu = (a.viscosity + b.viscosity) / (2. * rho);
        let drho = density_difference(&a, &b, ta, tb).0;
        let drive = GRAVITY * c.diameter * drho * c.slope / rho;
        let speeds = [16., 32., 64.].map(|factor| buoyant_speed(drive, factor * nu / c.diameter));
        assert!(speeds[0] > speeds[1] && speeds[1] > speeds[2] && speeds[2] > 0.);
        assert!(speeds[0] < drive.sqrt());
        let forcing = 0.0130827937 * c.penetration_average;
        let q = speeds.map(|v| {
            (v + forcing) * rho * (a.cp + b.cp) / 2. * c.coefficient * c.diameter / c.prandtl
                * c.area
                / c.separation
                * (ta - tb)
        });
        let scalar = speeds.map(|v| {
            (v + forcing) * rho * c.coefficient * c.diameter / c.schmidt * c.area / c.separation
        });
        println!("representative test-geometry viscous mixing sensitivity at reached cold T/p/U (not compiled plant receipt): speed16/32/64={speeds:?}; effectiveHeat16/32/64={q:?}; scalar16/32/64={scalar:?}; inertialSpeed={}; forcedSpeed={forcing}; viscousResponseScale_s={}", drive.sqrt(), c.diameter.powi(2)/(32.*nu));
    }
    fn geometry() -> Mixing {
        Mixing {
            from: 0,
            to: 1,
            area: std::f64::consts::PI * 0.5_f64.powi(2) / 4.,
            separation: 0.25,
            diameter: 0.5,
            slope: 8.04 / 11.,
            penetration_average: 1. - (-1_f64).exp(),
            sg_flow_edge: 0,
            sg_water: 2,
            sg_flow_area: 2.,
            coefficient: 0.01,
            prandtl: 0.9,
            schmidt: 0.7,
        }
    }
    #[test]
    fn stable_rest_has_only_molecular_heat_no_fictitious_scalar_flow() {
        let c = geometry();
        let mut n = 0;
        let r = evaluate(&c, 300000., 293.15, 298.15, 0., true, &mut n).unwrap();
        assert_eq!(r.scalar_kg_s, 0.);
        assert!(r.heat_w < 0.);
        assert!(r.heat_w * (1. / 298.15 - 1. / 293.15) >= 0.);
        assert_eq!(n, 10);
    }
    #[test]
    fn unstable_density_and_actual_sg_stirring_both_produce_exchange() {
        let c = geometry();
        let mut n = 0;
        let unstable = evaluate(&c, 300000., 298.15, 293.15, 0., true, &mut n).unwrap();
        let stirred = evaluate(&c, 300000., 298.15, 293.15, 0.1, true, &mut n).unwrap();
        let reversed = evaluate(&c, 300000., 298.15, 293.15, -0.1, true, &mut n).unwrap();
        assert!(unstable.scalar_kg_s > 0. && unstable.heat_w > 0.);
        assert!(stirred.scalar_kg_s > unstable.scalar_kg_s && stirred.heat_w > unstable.heat_w);
        assert_eq!(stirred.heat_w, reversed.heat_w);
        assert_eq!(stirred.scalar_kg_s, reversed.scalar_kg_s);
    }
    #[test]
    fn reversed_coordinate_keeps_physical_heat_and_species_reciprocal() {
        let c = geometry();
        let mut n = 0;
        let a = evaluate(&c, 300000., 298.15, 293.15, 0.1, true, &mut n).unwrap();
        let b = evaluate(
            &Mixing {
                from: 1,
                to: 0,
                slope: -c.slope,
                ..c
            },
            300000.,
            293.15,
            298.15,
            0.1,
            true,
            &mut n,
        )
        .unwrap();
        let a0 = evaluate(&c, 300000., 298.15, 293.15, 0., false, &mut n).unwrap();
        let b0 = evaluate(
            &Mixing {
                from: 1,
                to: 0,
                slope: -c.slope,
                ..c
            },
            300000.,
            293.15,
            298.15,
            0.,
            false,
            &mut n,
        )
        .unwrap();
        assert_eq!(a0.heat_w, -b0.heat_w);
        assert_eq!(a0.scalar_kg_s, b0.scalar_kg_s);
        assert_eq!(a.heat_w, -b.heat_w);
        assert_eq!(a.scalar_kg_s, b.scalar_kg_s);
    }
    #[test]
    fn equal_temperature_has_zero_heat_and_no_unforced_exchange() {
        let mut n = 0;
        let c = geometry();
        let r = evaluate(&c, 300000., 298.15, 298.15, 0., true, &mut n).unwrap();
        assert_eq!(r.heat_w, 0.);
        assert_eq!(r.scalar_kg_s, 0.);
        assert!(r
            .heat_partials
            .iter()
            .chain(&r.scalar_partials)
            .all(|x| x.is_finite()));
        assert!(evaluate(
            &Mixing {
                separation: 0.,
                ..c
            },
            300000.,
            298.15,
            298.15,
            0.,
            false,
            &mut n
        )
        .is_err());
    }
    #[test]
    fn representable_temperature_contrast_is_not_rounded_density_onset() {
        let c = geometry();
        let ta = 293.15_f64;
        let mut requests = 0;
        // Two adjacent temperatures on this monotone liquid branch can have
        // the same rounded density. That is not the mathematical EOS onset.
        let mut pair = None;
        for offset in 1..=32 {
            let tb = f64::from_bits(ta.to_bits() + offset);
            let [a, b] = properties([300000., ta, tb, 0.], &mut requests).unwrap();
            if a.density == b.density {
                pair = Some(tb);
                break;
            }
        }
        let tb = pair.expect("native EOS reproduces tiny contrast cancellation");
        for (from, to) in [(ta, tb), (tb, ta)] {
            let r = evaluate(&c, 300000., from, to, 0., true, &mut requests).unwrap();
            assert!(r.heat_w.is_finite());
            assert!(r
                .heat_partials
                .iter()
                .chain(&r.scalar_partials)
                .all(|x| x.is_finite()));
        }
    }
    #[test]
    fn stable_divided_difference_preserves_resolvable_values_and_reversed_geometry() {
        let c = geometry();
        let mut requests = 0;
        let ta = 293.15_f64;
        let tb = f64::from_bits(ta.to_bits() + 32);
        for p in [100000., 300000., 1000000.] {
            let [a, b] = properties([p, ta, tb, 0.], &mut requests).unwrap();
            let (difference, repaired) = density_difference(&a, &b, ta, tb);
            assert!(repaired && difference < 0.);
            let (reverse, reversed_repair) = density_difference(&b, &a, tb, ta);
            assert!(reversed_repair);
            assert_eq!(difference, -reverse);
            let forward = evaluate(&c, p, ta, tb, 0.1, true, &mut requests).unwrap();
            let reversed = evaluate(
                &Mixing {
                    from: c.to,
                    to: c.from,
                    slope: -c.slope,
                    ..c
                },
                p,
                tb,
                ta,
                0.1,
                true,
                &mut requests,
            )
            .unwrap();
            assert_eq!(forward.heat_w, -reversed.heat_w);
            assert_eq!(forward.scalar_kg_s, reversed.scalar_kg_s);
            // A physically resolved contrast keeps the original value bits.
            let [a, b] = properties([p, ta, ta + 1e-4, 0.], &mut requests).unwrap();
            let (difference, repaired) = density_difference(&a, &b, ta, ta + 1e-4);
            assert!(!repaired);
            assert_eq!(difference.to_bits(), (b.density - a.density).to_bits());
        }
        // Do not bridge a real density maximum merely because endpoint
        // densities happen to agree. This synthetic endpoint pair exercises
        // only the numerical selection, not a new water EOS.
        let [a, mut b] = properties([300000., ta, tb, 0.], &mut requests).unwrap();
        b.density = a.density;
        b.expansion = -a.expansion;
        assert_eq!(density_difference(&a, &b, ta, tb), (0., false));
        assert_eq!(density_difference(&a, &a, ta, ta), (0., false));
    }
    #[test]
    fn cancellation_safe_contrast_tangent_matches_representable_local_probes() {
        let c = geometry();
        let ta = 293.15_f64;
        let tb = f64::from_bits(ta.to_bits() - 64);
        let mut requests = 0;
        let p = 300000.;
        let response = evaluate(&c, p, ta, tb, 0., true, &mut requests).unwrap();
        assert!(response.scalar_kg_s > 0.);
        for j in 0..3 {
            let x = [p, ta, tb];
            let mut hi = x;
            let mut lo = x;
            if j == 0 {
                hi[j] += 1.;
                lo[j] -= 1.;
            } else {
                hi[j] = f64::from_bits(x[j].to_bits() + 2);
                lo[j] = f64::from_bits(x[j].to_bits() - 2);
            }
            let plus = evaluate(&c, hi[0], hi[1], hi[2], 0., false, &mut requests).unwrap();
            let minus = evaluate(&c, lo[0], lo[1], lo[2], 0., false, &mut requests).unwrap();
            let delta = hi[j] - lo[j];
            for (observed, expected) in [
                (
                    (plus.heat_w - minus.heat_w) / delta,
                    response.heat_partials[j],
                ),
                (
                    (plus.scalar_kg_s - minus.scalar_kg_s) / delta,
                    response.scalar_partials[j],
                ),
            ] {
                assert!(
                    (observed - expected).abs()
                        <= 1e-3 * observed.abs().max(expected.abs()) + 1e-18,
                    "tiny contrast column {j}: {expected} != {observed}"
                );
            }
        }
    }
    #[test]
    fn small_positive_buoyancy_tangent_stays_on_actual_branch() {
        // Actual near-isothermal return contrast reached by the connected
        // tighter PRHR case. A +/-0.001 K whole-flux secant crosses onset.
        let c = Mixing {
            separation: 5.25,
            slope: 8.04 / 11.,
            penetration_average: 9.647443384752795e-7,
            ..geometry()
        };
        let (p, ta, tb, velocity) = (
            324880.4898398793,
            293.15001023855996,
            293.15000178743566,
            0.013075,
        );
        let mut requests = 0;
        let response = evaluate(&c, p, ta, tb, velocity, true, &mut requests).unwrap();
        for h in [1e-7, 5e-8] {
            let hi = evaluate(&c, p, ta + h, tb, velocity, false, &mut requests).unwrap();
            let lo = evaluate(&c, p, ta - h, tb, velocity, false, &mut requests).unwrap();
            let delta = (ta + h) - (ta - h);
            for (observed, expected) in [
                ((hi.heat_w - lo.heat_w) / delta, response.heat_partials[1]),
                (
                    (hi.scalar_kg_s - lo.scalar_kg_s) / delta,
                    response.scalar_partials[1],
                ),
            ] {
                assert!(
                    (observed - expected).abs() <= 1e-3 * observed.abs().max(expected.abs()),
                    "actual branch tangent {expected} differs from shrinking probe {observed}"
                );
            }
        }
    }
    #[test]
    fn neutral_buoyancy_uses_bounded_inactive_generalized_tangent() {
        let mut n = 0;
        let response = evaluate(&geometry(), 300000., 293.15, 293.15, 0., true, &mut n).unwrap();
        assert_eq!(response.heat_w, 0.);
        assert_eq!(response.scalar_kg_s, 0.);
        assert_eq!(response.scalar_partials, [0.; 4]);
        assert!(response.heat_partials.iter().all(|x| x.is_finite()));
        assert!(response.heat_partials[1] > 0.);
        assert_eq!(response.heat_partials[1], -response.heat_partials[2]);
    }
    #[test]
    fn factored_tangents_match_stable_unstable_and_reversed_stirring() {
        let c = geometry();
        let mut requests = 0;
        for (ta, tb, u) in [
            (298.15, 293.15, 0.1),
            (298.15, 293.15, -0.1),
            (293.15, 298.15, 0.1),
            (293.15, 298.15, -0.1),
        ] {
            let x = [300000., ta, tb, u];
            let response = evaluate(&c, x[0], x[1], x[2], x[3], true, &mut requests).unwrap();
            for (j, h) in [1., 1e-4, 1e-4, 1e-5].into_iter().enumerate() {
                let mut hi = x;
                let mut lo = x;
                hi[j] += h;
                lo[j] -= h;
                let plus = evaluate(&c, hi[0], hi[1], hi[2], hi[3], false, &mut requests).unwrap();
                let minus = evaluate(&c, lo[0], lo[1], lo[2], lo[3], false, &mut requests).unwrap();
                let delta = hi[j] - lo[j];
                for (observed, expected) in [
                    (
                        (plus.heat_w - minus.heat_w) / delta,
                        response.heat_partials[j],
                    ),
                    (
                        (plus.scalar_kg_s - minus.scalar_kg_s) / delta,
                        response.scalar_partials[j],
                    ),
                ] {
                    assert!(
                        (observed - expected).abs()
                            <= 2e-4 * observed.abs().max(expected.abs()) + 1e-10,
                        "column {j}: {expected} differs from independent {observed}"
                    );
                }
            }
        }
    }
}

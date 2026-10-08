//! Actual concentric moving-inner-wall constitutive primitive. No held-current
//! piston assumption, EOS calls, time integration, or extra fluid inventory.
//! A graph caller must supply the actual signed native current and own both
//! end-face pressures; the resulting body traction/work is reciprocal.
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub outer_radius_m: f64,
    pub inner_radius_m: f64,
    pub length_m: f64,
    pub multiplicity: u32,
}
#[derive(Clone, Copy, Debug)]
pub struct Laminar {
    pub current_m3_s: f64,
    pub gradient_pa_m: f64,
    pub body_wall_force_n: f64,
    pub dissipation_w: f64,
    pub pressure_and_wall_work_w: f64,
    /// Partial derivatives at fixed geometry, [Q, v, mu].
    pub gradient_partials: [f64; 3],
    pub wall_force_partials: [f64; 3],
    pub area_m2: f64,
    pub hydraulic_diameter_m: f64,
    pub laminar_darcy_shape: f64,
}
impl Geometry {
    fn factors(self) -> Result<(f64, f64, f64, f64, f64), &'static str> {
        let (ro, ri, l) = (self.outer_radius_m, self.inner_radius_m, self.length_m);
        if ![ro, ri, l].iter().all(|v| v.is_finite())
            || !(ro > ri && ri > 0. && l > 0.)
            || self.multiplicity == 0
        {
            return Err("Invalid moving guide annulus geometry");
        }
        let eta = ((ro - ri) / ri).ln_1p();
        let e2 = (2. * eta).exp();
        // Same exact concentric solution evaluated without thin-gap
        // cancellation. At eta<1e-3 omitted terms are below f64 roundoff.
        let shape = if eta < 1e-3 {
            let z = eta * eta;
            4. * ri.powi(4)
                * e2
                * eta.powi(3)
                * (1. / 3. + z * (4. / 45. + z * (1. / 105. + z * 8. / 14175.)))
        } else {
            ro.powi(4) - ri.powi(4) - ((ro - ri) * (ro + ri)).powi(2) / eta
        };
        let couette = if eta < 1e-3 {
            ri * ri
                * eta
                * (1.
                    + eta
                        * (2. / 3.
                            + eta
                                * (1. / 3.
                                    + eta * (2. / 15. + eta * (2. / 45. + eta * 4. / 315.)))))
        } else {
            ri * ri * ((2. * eta).exp_m1() / (2. * eta) - 1.)
        };
        let n = self.multiplicity as f64;
        let area = n * PI * (ro - ri) * (ro + ri);
        let b = n * PI * couette;
        let c = n * 2. * PI / eta;
        let conductance = n * PI * shape / 8.;
        let dh = 2. * (ro - ri);
        let darcy = 16. * (ro - ri) * (ro + ri) * dh * dh / shape;
        if ![area, b, c, conductance, darcy]
            .iter()
            .all(|v| v.is_finite() && *v > 0.)
        {
            return Err("Unrepresentable moving guide mobility");
        }
        Ok((area, b, c, conductance, darcy))
    }
    /// Invert Q=B*v+Cq*G for the actual current, never Q=-Abody*v.
    /// G is pressure gradient minus rho*g; wall force is fluid ON body.
    pub fn laminar(
        self,
        current_m3_s: f64,
        body_speed_m_s: f64,
        viscosity_pa_s: f64,
    ) -> Result<Laminar, &'static str> {
        if ![current_m3_s, body_speed_m_s, viscosity_pa_s]
            .iter()
            .all(|v| v.is_finite())
            || viscosity_pa_s <= 0.
        {
            return Err("Invalid moving guide current/material");
        }
        let (area, b, c, cq0, darcy) = self.factors()?;
        let mu = viscosity_pa_s;
        let v = body_speed_m_s;
        let q = current_m3_s;
        let l = self.length_m;
        let cq = cq0 / mu;
        let gradient = (q - b * v) / cq;
        let wall = l * (b * gradient - c * mu * v);
        let dissipation = l * (cq * gradient * gradient + c * mu * v * v);
        let dg = [1. / cq, -b / cq, gradient / mu];
        let df = [l * b * dg[0], l * (b * dg[1] - c * mu), wall / mu];
        let work = gradient * l * q - wall * v;
        if ![gradient, wall, dissipation, work]
            .iter()
            .chain(dg.iter())
            .chain(df.iter())
            .all(|x| x.is_finite())
        {
            return Err("Unrepresentable moving guide constitutive state");
        }
        Ok(Laminar {
            current_m3_s: q,
            gradient_pa_m: gradient,
            body_wall_force_n: wall,
            dissipation_w: dissipation,
            pressure_and_wall_work_w: work,
            gradient_partials: dg,
            wall_force_partials: df,
            area_m2: area,
            hydraulic_diameter_m: 2. * (self.outer_radius_m - self.inner_radius_m),
            laminar_darcy_shape: darcy,
        })
    }
    /// Apply the authored SAME positive turbulent enhancement to pressure
    /// gradient, body wall traction and dissipation. The graph's current
    /// property/Churchill evaluator owns chi and its partials, not this helper.
    pub fn enhanced(self, q: f64, v: f64, mu: f64, chi: f64) -> Result<Laminar, &'static str> {
        self.laminar(q, v, mu)?.enhanced(chi)
    }
}
impl Laminar {
    /// Scale an already evaluated SAME-stage primitive without repeating its
    /// immutable-radius logarithms/mobility. This is value reuse, not a cache;
    /// the caller still owns the current chi and its chained derivatives.
    pub fn enhanced(mut self, chi: f64) -> Result<Self, &'static str> {
        if !chi.is_finite() || chi < 1. {
            return Err("Invalid moving guide excess-resistance selection");
        }
        self.gradient_pa_m *= chi;
        self.body_wall_force_n *= chi;
        self.dissipation_w *= chi;
        self.pressure_and_wall_work_w *= chi;
        // These are the partials at HELD chi; the caller chains its actual
        // Reynolds/property/geometry derivative, not a fabricated constant chi.
        self.gradient_partials.iter_mut().for_each(|x| *x *= chi);
        self.wall_force_partials.iter_mut().for_each(|x| *x *= chi);
        if ![
            self.gradient_pa_m,
            self.body_wall_force_n,
            self.dissipation_w,
            self.pressure_and_wall_work_w,
        ]
        .iter()
        .chain(self.gradient_partials.iter())
        .chain(self.wall_force_partials.iter())
        .all(|x| x.is_finite())
        {
            return Err("Unrepresentable enhanced moving guide constitutive state");
        }
        Ok(self)
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Shape {
    pub volume_m3: f64,
    pub first_moment_m4: f64,
    pub dvolume_dy_m2: f64,
    pub dmoment_dy_m3: f64,
}
/// Retained side of an actual axial-boundary event, not a JVP-direction switch.
#[derive(Clone, Copy, Debug)]
pub enum AxialBranch {
    PositiveTravel,
    NegativeTravel,
}
/// Actual fixed enclosure minus a translating solid axial segment. This is
/// an analytical piecewise branch, not an occupancy/remapping rule. The caller
/// must stop/reselect at a physical axial-boundary crossing.
pub fn free_shape(
    enclosure_area_m2: f64,
    z0: f64,
    z1: f64,
    solid_area_m2: f64,
    solid_bottom: f64,
    solid_top: f64,
    y: f64,
    branch: AxialBranch,
) -> Result<Shape, &'static str> {
    if ![
        enclosure_area_m2,
        z0,
        z1,
        solid_area_m2,
        solid_bottom,
        solid_top,
        y,
    ]
    .iter()
    .all(|v| v.is_finite())
        || !(enclosure_area_m2 > solid_area_m2
            && solid_area_m2 >= 0.
            && z1 > z0
            && solid_top > solid_bottom)
    {
        return Err("Invalid moving free-volume enclosure");
    }
    let lo = z0.max(solid_bottom + y);
    let hi = z1.min(solid_top + y);
    let positive = matches!(branch, AxialBranch::PositiveTravel);
    let entering =
        hi == lo && ((positive && solid_top + y == z0) || (!positive && solid_bottom + y == z1));
    let (overlap, moment, dv, dj) = if hi > lo || entering {
        // The accepted event side is fixed for the complete stage and all
        // tangent directions. It is not selected from a Newton perturbation.
        let dl = if solid_bottom + y > z0 || (positive && solid_bottom + y == z0) {
            1.
        } else {
            0.
        };
        let dh = if solid_top + y < z1 || (!positive && solid_top + y == z1) {
            1.
        } else {
            0.
        };
        (
            hi - lo,
            0.5 * (hi - lo) * (hi + lo),
            dh - dl,
            hi * dh - lo * dl,
        )
    } else {
        (0., 0., 0., 0.)
    };
    let volume = enclosure_area_m2 * (z1 - z0) - solid_area_m2 * overlap;
    let j = enclosure_area_m2 * 0.5 * (z1 - z0) * (z1 + z0) - solid_area_m2 * moment;
    if !volume.is_finite() || volume <= 0. || !j.is_finite() {
        return Err("Invalid moving free inventory");
    }
    Ok(Shape {
        volume_m3: volume,
        first_moment_m4: j,
        dvolume_dy_m2: -solid_area_m2 * dv,
        dmoment_dy_m3: -solid_area_m2 * dj,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evaluated_enhancement_reuse_preserves_every_original_output_bit() {
        for q in [-1e-6, 0., 1e-6] {
            for v in [-0.008, 0., 0.008] {
                for chi in [1., 1.5, 12.] {
                    let base = g().laminar(q, v, 0.000854).unwrap();
                    let reused = base.enhanced(chi).unwrap();
                    let direct = g().enhanced(q, v, 0.000854, chi).unwrap();
                    for (actual, expected) in [
                        (reused.gradient_pa_m, base.gradient_pa_m * chi),
                        (reused.body_wall_force_n, base.body_wall_force_n * chi),
                        (reused.dissipation_w, base.dissipation_w * chi),
                        (
                            reused.pressure_and_wall_work_w,
                            base.pressure_and_wall_work_w * chi,
                        ),
                        (reused.current_m3_s, base.current_m3_s),
                        (reused.area_m2, base.area_m2),
                        (reused.hydraulic_diameter_m, base.hydraulic_diameter_m),
                        (reused.laminar_darcy_shape, base.laminar_darcy_shape),
                        (direct.gradient_pa_m, reused.gradient_pa_m),
                        (direct.body_wall_force_n, reused.body_wall_force_n),
                    ] {
                        assert_eq!(actual.to_bits(), expected.to_bits());
                    }
                    for (actual, expected) in reused
                        .gradient_partials
                        .into_iter()
                        .chain(reused.wall_force_partials)
                        .zip(
                            base.gradient_partials
                                .into_iter()
                                .chain(base.wall_force_partials)
                                .map(|x| x * chi),
                        )
                    {
                        assert_eq!(actual.to_bits(), expected.to_bits());
                    }
                }
            }
        }
        assert!(
            g().laminar(0., 0., 0.000854)
                .unwrap()
                .enhanced(0.9)
                .is_err()
        );
        assert!(
            g().laminar(0., 0., 0.000854)
                .unwrap()
                .enhanced(f64::NAN)
                .is_err()
        );
    }
    fn g() -> Geometry {
        Geometry {
            outer_radius_m: 0.0055,
            inner_radius_m: 0.00475,
            length_m: 4.65,
            multiplicity: 24,
        }
    }
    fn near(a: f64, b: f64, tol: f64) {
        assert!(
            (a - b).abs() <= tol * (1. + a.abs() + b.abs()),
            "{a} != {b}"
        );
    }
    #[test]
    fn actual_current_reciprocity_reversal_and_positive_dissipation() {
        for (q, v) in [
            (0., 0.),
            (1e-5, 0.),
            (0., 0.008),
            (1e-5, 0.008),
            (-1e-5, -0.008),
            (-1e-5, 0.008),
        ] {
            let a = g().laminar(q, v, 0.001).unwrap();
            let b = g().laminar(-q, -v, 0.001).unwrap();
            assert!(a.dissipation_w >= 0.);
            near(a.dissipation_w, a.pressure_and_wall_work_w, 1e-12);
            near(a.gradient_pa_m, -b.gradient_pa_m, 1e-12);
            near(a.body_wall_force_n, -b.body_wall_force_n, 1e-12);
            let c = g().enhanced(q, v, 0.001, 2.).unwrap();
            near(c.dissipation_w, 2. * a.dissipation_w, 1e-12);
            near(c.pressure_and_wall_work_w, c.dissipation_w, 1e-12);
        }
    }
    #[test]
    fn analytic_current_velocity_and_viscosity_tangents() {
        let x = [1e-5, 0.008, 0.001];
        let a = g().laminar(x[0], x[1], x[2]).unwrap();
        for (k, h) in [1e-9, 1e-7, 1e-8].into_iter().enumerate() {
            let mut p = x;
            let mut m = x;
            p[k] += h;
            m[k] -= h;
            let p = g().laminar(p[0], p[1], p[2]).unwrap();
            let m = g().laminar(m[0], m[1], m[2]).unwrap();
            near(
                (p.gradient_pa_m - m.gradient_pa_m) / (2. * h),
                a.gradient_partials[k],
                2e-8,
            );
            near(
                (p.body_wall_force_n - m.body_wall_force_n) / (2. * h),
                a.wall_force_partials[k],
                2e-8,
            );
        }
    }
    #[test]
    fn thinner_clearance_grows_real_resistance_without_losing_mobility() {
        let mut previous = 0.;
        for gap in [0.00075, 0.0001, 1e-6, 1e-8] {
            let mut s = g();
            s.inner_radius_m = s.outer_radius_m - gap;
            let r = s.laminar(1e-6, 0., 0.001).unwrap();
            assert!(r.gradient_pa_m > previous);
            previous = r.gradient_pa_m;
            near(r.pressure_and_wall_work_w, r.dissipation_w, 1e-11);
        }
        assert!(g().enhanced(1e-5, 0.008, 0.001, f64::MAX).is_err());
    }
    #[test]
    fn moving_shape_keeps_volume_and_first_moment_reciprocal() {
        let area = 24. * PI * 0.0095f64.powi(2) / 4.;
        let y = 0.003;
        let guide = free_shape(
            24. * PI * 0.011f64.powi(2) / 4.,
            -2.25,
            2.4,
            area,
            -2.25,
            2.4,
            y,
            AxialBranch::PositiveTravel,
        )
        .unwrap();
        let upper = free_shape(
            1.,
            2.4,
            8.,
            area,
            -2.25,
            2.4,
            y,
            AxialBranch::PositiveTravel,
        )
        .unwrap();
        near(guide.dvolume_dy_m2 + upper.dvolume_dy_m2, 0., 1e-13);
        near(
            guide.dmoment_dy_m3 + upper.dmoment_dy_m3,
            -area * 4.65,
            1e-13,
        );
        let h = 1e-6;
        let p = free_shape(
            24. * PI * 0.011f64.powi(2) / 4.,
            -2.25,
            2.4,
            area,
            -2.25,
            2.4,
            y + h,
            AxialBranch::PositiveTravel,
        )
        .unwrap();
        let m = free_shape(
            24. * PI * 0.011f64.powi(2) / 4.,
            -2.25,
            2.4,
            area,
            -2.25,
            2.4,
            y - h,
            AxialBranch::PositiveTravel,
        )
        .unwrap();
        near(
            (p.volume_m3 - m.volume_m3) / (2. * h),
            guide.dvolume_dy_m2,
            1e-11,
        );
        near(
            (p.first_moment_m4 - m.first_moment_m4) / (2. * h),
            guide.dmoment_dy_m3,
            1e-11,
        );
    }
    #[test]
    fn axial_contact_side_is_retained_and_has_correct_one_sided_tangent() {
        let area = 0.001;
        for (branch, step) in [
            (AxialBranch::PositiveTravel, 1e-6),
            (AxialBranch::NegativeTravel, -1e-6),
        ] {
            for (z0, z1) in [(-2.25, 2.4), (-3., -2.25), (2.4, 3.)] {
                let a = free_shape(1., z0, z1, area, -2.25, 2.4, 0., branch).unwrap();
                let b = free_shape(1., z0, z1, area, -2.25, 2.4, step, branch).unwrap();
                near((b.volume_m3 - a.volume_m3) / step, a.dvolume_dy_m2, 1e-9);
                near(
                    (b.first_moment_m4 - a.first_moment_m4) / step,
                    a.dmoment_dy_m3,
                    1e-9,
                );
            }
        }
        let p = free_shape(
            1.,
            2.4,
            3.,
            area,
            -2.25,
            2.4,
            0.,
            AxialBranch::PositiveTravel,
        )
        .unwrap();
        let m = free_shape(
            1.,
            2.4,
            3.,
            area,
            -2.25,
            2.4,
            0.,
            AxialBranch::NegativeTravel,
        )
        .unwrap();
        assert_eq!(p.volume_m3, m.volume_m3);
        assert_eq!(p.dvolume_dy_m2, -area);
        assert_eq!(m.dvolume_dy_m2, 0.);
    }
}

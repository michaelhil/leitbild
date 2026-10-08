//! Same-stage moving connections for the existing pressure territory. These
//! are constitutive laws, not a flow solver or an additional fluid owner.
use super::{HydraulicSegment, LossLaw};
use crate::moving_guide;
use std::f64::consts::PI;

/// Partial ordering shared by every returned constitutive quantity:
/// [mass current, density, viscosity, inner-wall speed, physical length].
pub const PARTIALS: usize = 5;

#[derive(Clone, Copy, Debug)]
pub enum Law {
    Clear {
        outer_radius_m: f64,
        length_m: f64,
        multiplicity: u32,
        roughness_m: f64,
        mouth_loss: f64,
    },
    Annulus {
        geometry: moving_guide::Geometry,
        speed_m_s: f64,
        roughness_m: f64,
        mouth_loss: f64,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct Connection {
    pub edge: usize,
    pub from_elevation_m: f64,
    pub to_elevation_m: f64,
    /// Actual receiving fluid for inner-wall work, independent of upwind.
    pub fluid_work_cell: usize,
    pub law: Law,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Direction {
    pub from_elevation_m: f64,
    pub to_elevation_m: f64,
    pub length_m: f64,
    pub speed_m_s: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Response {
    pub loss_pa: f64,
    pub loss_partials: [f64; PARTIALS],
    /// Fluid-on-inner-wall force; cap pressure traction is separate.
    pub wall_force_n: f64,
    pub wall_force_partials: [f64; PARTIALS],
    pub dissipation_w: f64,
    pub dissipation_partials: [f64; PARTIALS],
    /// Opposite of mechanical wall traction power, paid once to fluid.
    pub fluid_wall_work_w: f64,
    pub fluid_wall_work_partials: [f64; PARTIALS],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ResponseDirection {
    pub loss_pa: f64,
    pub wall_force_n: f64,
    pub dissipation_w: f64,
    pub fluid_wall_work_w: f64,
}

impl Response {
    pub fn direction(self, d: [f64; PARTIALS]) -> Result<ResponseDirection, String> {
        let dot = |p: [f64; PARTIALS]| p.into_iter().zip(d).map(|(a, b)| a * b).sum();
        let out = ResponseDirection {
            loss_pa: dot(self.loss_partials),
            wall_force_n: dot(self.wall_force_partials),
            dissipation_w: dot(self.dissipation_partials),
            fluid_wall_work_w: dot(self.fluid_wall_work_partials),
        };
        if d.iter().any(|v| !v.is_finite())
            || [
                out.loss_pa,
                out.wall_force_n,
                out.dissipation_w,
                out.fluid_wall_work_w,
            ]
            .iter()
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite moving connection direction".into());
        }
        Ok(out)
    }
}

impl Law {
    pub fn evaluate(self, q: f64, rho: f64, mu: f64) -> Result<Response, String> {
        if [q, rho, mu].iter().any(|v| !v.is_finite()) || rho <= 0. || mu <= 0. {
            return Err("Invalid moving connection current/material".into());
        }
        let (length, area, diameter, roughness, mouth, base) = match self {
            Self::Clear {
                outer_radius_m: r,
                length_m: l,
                multiplicity: n,
                roughness_m: rough,
                mouth_loss: k,
            } => {
                if !r.is_finite() || r <= 0. || !l.is_finite() || l < 0. || n == 0 {
                    return Err("Invalid actual clear connection geometry".into());
                }
                (l, n as f64 * PI * r * r, 2. * r, rough, k, None)
            }
            Self::Annulus {
                geometry: g,
                speed_m_s: v,
                roughness_m: rough,
                mouth_loss: k,
            } => {
                let a = g.laminar(q / rho, v, mu).map_err(String::from)?;
                (
                    g.length_m,
                    a.area_m2,
                    a.hydraulic_diameter_m,
                    rough,
                    k,
                    Some((a, v)),
                )
            }
        };
        if !roughness.is_finite()
            || roughness < 0.
            || roughness / diameter > 0.1
            || !mouth.is_finite()
            || mouth < 0.
            || (length == 0. && mouth == 0.)
        {
            return Err("Invalid moving passage roughness/mouth or empty connection".into());
        }
        let mouth_value = mouth * q * q.abs() / (2. * rho * area * area);
        let mouth_partials = [
            if q == 0. {
                0.
            } else {
                2. * mouth_value.abs() / q.abs()
            },
            -mouth_value / rho,
            0.,
            0.,
            0.,
        ];
        let mut out = Response::default();
        if let Some((base, speed)) = base {
            let u = q / (rho * area);
            let effective_speed = ((u * u + (u - speed).powi(2)) * 0.5).sqrt();
            let effective = rho * area * effective_speed;
            let segment = HydraulicSegment {
                law: LossLaw::GuideAnnulus {
                    laminar_darcy: base.laminar_darcy_shape,
                },
                length: 1.,
                flow_area: area,
                diameter,
                roughness,
                fixed_loss: 0.,
                grid_multiplier: 0.,
            };
            let molecular = base.laminar_darcy_shape * mu / (2. * rho * area * diameter.powi(2));
            let mut dchi = [0.; PARTIALS];
            let chi = if effective == 0. {
                1.
            } else {
                let loss = segment.pressure_loss(effective, rho, mu);
                let raw = loss[0] / (molecular * effective);
                if raw > 1. {
                    let d_effective = [
                        (2. * u - speed) / (2. * effective_speed),
                        area * (effective_speed - u * (2. * u - speed) / (2. * effective_speed)),
                        0.,
                        rho * area * (speed - u) / (2. * effective_speed),
                        0.,
                    ];
                    for j in 0..PARTIALS {
                        let dloss = loss[1] * d_effective[j]
                            + if j == 1 {
                                loss[3]
                            } else if j == 2 {
                                loss[2]
                            } else {
                                0.
                            };
                        let dmolecular = if j == 1 {
                            -molecular / rho
                        } else if j == 2 {
                            molecular / mu
                        } else {
                            0.
                        };
                        dchi[j] = dloss / (molecular * effective)
                            - raw * (dmolecular / molecular + d_effective[j] / effective);
                    }
                    raw
                } else {
                    1.
                }
            };
            let gradient = base.gradient_pa_m * chi;
            let wall = base.body_wall_force_n * chi;
            out.loss_pa = gradient * length + mouth_value;
            out.wall_force_n = wall;
            out.fluid_wall_work_w = -wall * speed;
            // Retain the positive constitutive quadratic rather than recover
            // a small dissipation by subtracting large reciprocal works.
            out.dissipation_w = base.dissipation_w * chi + mouth_value * q / rho;
            let dgradient = [
                base.gradient_partials[0] / rho,
                -base.gradient_partials[0] * q / rho.powi(2),
                base.gradient_partials[2],
                base.gradient_partials[1],
                0.,
            ];
            let dwall = [
                base.wall_force_partials[0] / rho,
                -base.wall_force_partials[0] * q / rho.powi(2),
                base.wall_force_partials[2],
                base.wall_force_partials[1],
                base.body_wall_force_n / length,
            ];
            for j in 0..PARTIALS {
                out.loss_partials[j] = length * (chi * dgradient[j] + base.gradient_pa_m * dchi[j])
                    + if j == 4 { gradient } else { 0. }
                    + mouth_partials[j];
                out.wall_force_partials[j] = chi * dwall[j] + base.body_wall_force_n * dchi[j];
                out.fluid_wall_work_partials[j] =
                    -speed * out.wall_force_partials[j] - if j == 3 { wall } else { 0. };
            }
        } else {
            let segment = HydraulicSegment {
                law: LossLaw::ChurchillPipe,
                length: 1.,
                flow_area: area,
                diameter,
                roughness,
                fixed_loss: 0.,
                grid_multiplier: 0.,
            };
            let unit = segment.pressure_loss(q, rho, mu);
            out.loss_pa = length * unit[0] + mouth_value;
            out.loss_partials = [
                length * unit[1] + mouth_partials[0],
                length * unit[3] + mouth_partials[1],
                length * unit[2],
                0.,
                unit[0],
            ];
            out.dissipation_w = out.loss_pa * q / rho;
        }
        let qvolume = q / rho;
        for j in 0..PARTIALS {
            let dqvolume = if j == 0 {
                1. / rho
            } else if j == 1 {
                -q / rho.powi(2)
            } else {
                0.
            };
            out.dissipation_partials[j] = out.loss_partials[j] * qvolume
                + out.loss_pa * dqvolume
                + out.fluid_wall_work_partials[j];
        }
        if [
            out.loss_pa,
            out.wall_force_n,
            out.dissipation_w,
            out.fluid_wall_work_w,
        ]
        .iter()
        .chain(&out.loss_partials)
        .chain(&out.wall_force_partials)
        .chain(&out.dissipation_partials)
        .chain(&out.fluid_wall_work_partials)
        .any(|v| !v.is_finite())
            || out.loss_partials[0] < 0.
            || out.dissipation_w < 0.
        {
            return Err("Invalid moving connection response/monotonicity/dissipation".into());
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn annulus(v: f64, length: f64) -> Law {
        Law::Annulus {
            geometry: moving_guide::Geometry {
                outer_radius_m: 0.0055,
                inner_radius_m: 0.00475,
                length_m: length,
                multiplicity: 24,
            },
            speed_m_s: v,
            roughness_m: 1e-6,
            mouth_loss: 0.8,
        }
    }
    #[test]
    fn reciprocal_work_and_all_material_motion_partials() {
        for q in [-0.03, 0., 0.03, 3.] {
            let (rho, mu, v, l) = (997., 0.001, 0.008, 4.6);
            let a = annulus(v, l).evaluate(q, rho, mu).unwrap();
            assert!(
                (a.dissipation_w - (a.loss_pa * q / rho - a.wall_force_n * v)).abs()
                    < 1e-12 * (1. + a.dissipation_w)
            );
            let d = [0.1, 0.2, 0.00002, 0.003, -0.2];
            let e = 1e-5;
            let arms = [-1., 1.].map(|s| {
                annulus(v + s * e * d[3], l + s * e * d[4])
                    .evaluate(q + s * e * d[0], rho + s * e * d[1], mu + s * e * d[2])
                    .unwrap()
            });
            let j = a.direction(d).unwrap();
            for (name, x, y, z) in [
                ("loss", j.loss_pa, arms[0].loss_pa, arms[1].loss_pa),
                (
                    "wall",
                    j.wall_force_n,
                    arms[0].wall_force_n,
                    arms[1].wall_force_n,
                ),
                (
                    "dissipation",
                    j.dissipation_w,
                    arms[0].dissipation_w,
                    arms[1].dissipation_w,
                ),
                (
                    "work",
                    j.fluid_wall_work_w,
                    arms[0].fluid_wall_work_w,
                    arms[1].fluid_wall_work_w,
                ),
            ] {
                let fd = (z - y) / (2. * e);
                assert!(
                    (x - fd).abs() < 1e-6 * (1. + x.abs()),
                    "{name} q{q}: {x} vs {fd}"
                );
            }
        }
    }
    #[test]
    fn real_zero_length_mouth_has_no_invented_friction() {
        let law = Law::Clear {
            outer_radius_m: 0.0055,
            length_m: 0.,
            multiplicity: 24,
            roughness_m: 1e-6,
            mouth_loss: 0.8,
        };
        let rest = law.evaluate(0., 997., 0.001).unwrap();
        assert_eq!(rest.loss_pa, 0.);
        assert_eq!(rest.loss_partials[0], 0.);
        assert_eq!(rest.wall_force_n, 0.);
        assert!(law.evaluate(0.1, 997., 0.001).unwrap().dissipation_w > 0.);
    }
}

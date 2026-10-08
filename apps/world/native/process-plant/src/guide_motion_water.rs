//! Short cold, incompressible mechanical apparatus, NOT the compressible
//! operating network or a source/thermal qualification. Native properties are
//! prepared once; finite energy, marker and gravitational inventory still move.
//! One real mixed water owner per cluster, finite plena and actual parallel
//! return passages. Currents and head are solved together, never prescribed.
use crate::absorber_motion::{Forces, State};
use crate::moving_guide::Geometry;
use crate::operating_network::{Hydraulic, HydraulicSegment, LossLaw};
use crate::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct Bulk {
    pub volume_m3: f64,
    pub first_moment_m4: f64,
}
/// Disjoint actual pressure-housing/collar/neck spans. The closed top implies
/// Q=-Astem*v ONLY in these stem passages, not in the open BODY guides.
#[derive(Clone, Copy, Debug)]
pub struct StemPassage {
    pub bottom_m: f64,
    pub top_m: f64,
    pub outer_radius_m: f64,
}
#[derive(Clone, Debug)]
pub struct Cluster {
    pub outer_radius_m: f64,
    pub body_radius_m: f64,
    pub bottom_m: f64,
    pub top_m: f64,
    pub rodlets: u32,
    pub body_volume_m3: f64,
    pub spider_volume_m3: f64,
    pub stem_radius_m: f64,
    pub stem_bottom_m: f64,
    pub stem_top_m: f64,
    pub stem_volume_m3: f64,
    pub stem_passages: Vec<StemPassage>,
    pub roughness_m: f64,
    pub mouth_loss: f64,
}
#[derive(Clone, Debug)]
pub struct Config {
    pub clusters: Vec<Cluster>,
    pub lower: Bulk,
    /// Includes represented external core/empty-guide water and the complete
    /// housing/neck water once. It is an explicit cold mixed-plenum reduction.
    pub upper: Bulk,
    pub returns: Vec<Hydraulic>,
    /// Absolute pressure at the explicitly owned elevation; the mechanical
    /// correction remains UPPER pi=0. Neither datum follows a moving centroid.
    pub pressure_pa: f64,
    pub pressure_datum_m: f64,
    pub temperature_k: f64,
    pub marker_fraction: f64,
}
pub struct Model {
    pub config: Config,
    pub liquid: Liquid,
}
#[derive(Clone, Debug)]
pub struct Stage {
    /// Fluid forces only; caller adds actual weight once.
    pub forces: Vec<Forces>,
    /// Finite total energy (including gravitational PE), then mobile marker.
    pub rates: Vec<f64>,
    pub geometry: Vec<CellGeometry>,
    pub temperatures: Vec<f64>,
    pub head_pa: f64,
    pub guide_in_m3_s: Vec<f64>,
    pub guide_out_m3_s: Vec<f64>,
    pub return_m3_s: Vec<f64>,
    pub dissipation_w: f64,
    pub sensible_rate_w: f64,
    pub energy_defect_w: f64,
    pub dissipation_defect_w: f64,
    pub iterations: usize,
}
fn positive(v: f64) -> bool {
    v.is_finite() && v > 0.
}
impl Model {
    pub fn new(config: Config) -> Result<Self, String> {
        if config.clusters.is_empty()
            || config.returns.is_empty()
            || !positive(config.pressure_pa)
            || !config.pressure_datum_m.is_finite()
            || !positive(config.temperature_k)
            || !config.marker_fraction.is_finite()
            || config.marker_fraction < 0.
            || [config.lower, config.upper]
                .iter()
                .any(|b| !positive(b.volume_m3) || !b.first_moment_m4.is_finite())
        {
            return Err("Invalid finite cold guide apparatus".into());
        }
        for c in &config.clusters {
            if ![
                c.outer_radius_m,
                c.body_radius_m,
                c.body_volume_m3,
                c.stem_radius_m,
                c.stem_volume_m3,
            ]
            .iter()
            .all(|v| positive(*v))
                || c.outer_radius_m <= c.body_radius_m
                || c.rodlets == 0
                || ![
                    c.bottom_m,
                    c.top_m,
                    c.spider_volume_m3,
                    c.stem_bottom_m,
                    c.stem_top_m,
                    c.roughness_m,
                    c.mouth_loss,
                ]
                .iter()
                .all(|v| v.is_finite())
                || c.top_m <= c.bottom_m
                || c.spider_volume_m3 < 0.
                || c.stem_top_m <= c.stem_bottom_m
                || c.roughness_m < 0.
                || c.mouth_loss < 0.
                || c.stem_passages.is_empty()
            {
                return Err("Invalid cold cluster water geometry".into());
            }
            let area = c.rodlets as f64 * PI * c.body_radius_m.powi(2);
            if (c.body_volume_m3 - area * (c.top_m - c.bottom_m)).abs() > 1e-10 * c.body_volume_m3
                || c.stem_volume_m3
                    < PI * c.stem_radius_m.powi(2) * (c.stem_top_m - c.stem_bottom_m) * (1. - 1e-10)
            {
                return Err("Cold body/stem physical volume mismatch".into());
            }
            let mut last = f64::NEG_INFINITY;
            for p in &c.stem_passages {
                if ![p.bottom_m, p.top_m, p.outer_radius_m]
                    .iter()
                    .all(|v| v.is_finite())
                    || p.top_m <= p.bottom_m
                    || p.bottom_m < last
                    || p.outer_radius_m <= c.stem_radius_m
                {
                    return Err("Invalid or overlapping stem water passages".into());
                }
                last = p.top_m;
            }
            if c.stem_top_m > last {
                return Err("Original cold stem crosses its closed pressure enclosure".into());
            }
        }
        for r in &config.returns {
            if r.segments.is_empty() {
                return Err("Empty physical cold return".into());
            }
            for s in &r.segments {
                if ![s.length, s.flow_area, s.diameter]
                    .iter()
                    .all(|v| positive(*v))
                    || ![s.roughness, s.fixed_loss, s.grid_multiplier]
                        .iter()
                        .all(|v| v.is_finite() && *v >= 0.)
                    || s.roughness / s.diameter > 0.1
                {
                    return Err("Invalid cold return segment".into());
                }
            }
        }
        let mut liquid = [Liquid::default()];
        liquid_batch(
            &[LiquidQuery {
                pressure: config.pressure_pa,
                temperature: config.temperature_k,
            }],
            &mut liquid,
        )
        .map_err(|e| e.message)?;
        Ok(Self {
            config,
            liquid: liquid[0],
        })
    }
    pub fn nodes(&self) -> usize {
        self.config.clusters.len() + 2
    }
    pub fn dimension(&self) -> usize {
        2 * self.nodes()
    }
    pub fn shapes(&self, states: &[State]) -> Result<Vec<CellGeometry>, String> {
        if states.len() != self.config.clusters.len() {
            return Err("Cold guide cluster coverage".into());
        }
        let mut out = Vec::with_capacity(self.nodes());
        out.push(CellGeometry {
            volume: self.config.lower.volume_m3,
            elevation: self.config.lower.first_moment_m4 / self.config.lower.volume_m3,
        });
        let mut upper = self.config.upper;
        for (c, s) in self.config.clusters.iter().zip(states) {
            let y = s.body_y_m;
            if ![y, s.body_v_m_s, s.stem_y_m, s.stem_v_m_s]
                .iter()
                .all(|v| v.is_finite())
                || y < 0.
                || y >= c.top_m - c.bottom_m
                || s.stem_y_m < 0.
                || c.stem_top_m + s.stem_y_m > c.stem_passages.last().unwrap().top_m
            {
                return Err("Outside short cold seated-head motion domain".into());
            }
            let full = c.rodlets as f64 * PI * c.outer_radius_m.powi(2);
            let solid = c.rodlets as f64 * PI * c.body_radius_m.powi(2);
            let original_v = (full - solid) * (c.top_m - c.bottom_m);
            let original_j = (full - solid) * (c.top_m.powi(2) - c.bottom_m.powi(2)) / 2.;
            let dv = solid * y;
            let dj = solid * (c.bottom_m * y + y * y / 2.);
            out.push(CellGeometry {
                volume: original_v + dv,
                elevation: (original_j + dj) / (original_v + dv),
            });
            upper.volume_m3 -= dv;
            upper.first_moment_m4 -=
                c.body_volume_m3 * y + dj + c.spider_volume_m3 * y + c.stem_volume_m3 * s.stem_y_m;
        }
        if !positive(upper.volume_m3) || !upper.first_moment_m4.is_finite() {
            return Err("Exhausted cold upper water geometry".into());
        }
        out.push(CellGeometry {
            volume: upper.volume_m3,
            elevation: upper.first_moment_m4 / upper.volume_m3,
        });
        Ok(out)
    }
    pub fn initial_state(&self) -> Result<Vec<f64>, String> {
        let s = vec![
            State {
                body_y_m: 0.,
                body_v_m_s: 0.,
                stem_y_m: 0.,
                stem_v_m_s: 0.,
                reference_y_m: 0.
            };
            self.config.clusters.len()
        ];
        let shape = self.shapes(&s)?;
        let mut out = Vec::with_capacity(self.dimension());
        out.extend(
            shape
                .iter()
                .map(|g| self.liquid.density * g.volume * GRAVITY * g.elevation),
        );
        out.extend(
            shape
                .iter()
                .map(|g| self.liquid.density * g.volume * self.config.marker_fraction),
        );
        Ok(out)
    }
    /// Independent applicability check, not a refresh/reset of frozen laws.
    /// Bounds are selected by the apparatus caller BEFORE its trajectory.
    pub fn check_property_departure(
        &self,
        stage: &Stage,
        maximum_k: f64,
        maximum_fraction: f64,
    ) -> Result<[f64; 4], String> {
        if !positive(maximum_k)
            || !positive(maximum_fraction)
            || stage.geometry.len() != self.nodes()
            || stage.temperatures.len() != self.nodes()
        {
            return Err("Invalid cold applicability check".into());
        }
        let queries: Vec<_> = stage
            .geometry
            .iter()
            .zip(&stage.temperatures)
            .enumerate()
            .map(|(i, (g, t))| LiquidQuery {
                temperature: *t,
                pressure: self.config.pressure_pa
                    + if i == 0 { stage.head_pa } else { 0. }
                    + self.liquid.density * GRAVITY * (self.config.pressure_datum_m - g.elevation),
            })
            .collect();
        let mut actual = vec![Liquid::default(); queries.len()];
        liquid_batch(&queries, &mut actual).map_err(|e| e.message)?;
        let mut worst = [0_f64; 4];
        for (q, l) in queries.iter().zip(actual) {
            for (i, value) in [
                (q.temperature - self.config.temperature_k).abs(),
                (l.density / self.liquid.density - 1.).abs(),
                (l.viscosity / self.liquid.viscosity - 1.).abs(),
                (l.cp / self.liquid.cp - 1.).abs(),
            ]
            .into_iter()
            .enumerate()
            {
                worst[i] = worst[i].max(value);
            }
        }
        if worst[0] > maximum_k || worst[1..].iter().any(|v| *v > maximum_fraction) {
            return Err(format!(
                "Cold incompressible apparatus applicability exceeded: {worst:?}"
            ));
        }
        Ok(worst)
    }
    fn annulus(
        &self,
        g: Geometry,
        q: f64,
        v: f64,
        roughness: f64,
    ) -> Result<(crate::moving_guide::Laminar, f64), String> {
        let base = g
            .laminar(q, v, self.liquid.viscosity)
            .map_err(String::from)?;
        let u = q / base.area_m2;
        let speed = ((u * u + (u - v) * (u - v)) / 2.).sqrt();
        let effective = self.liquid.density * base.area_m2 * speed;
        let s = HydraulicSegment {
            law: LossLaw::GuideAnnulus {
                laminar_darcy: base.laminar_darcy_shape,
            },
            length: 1.,
            flow_area: base.area_m2,
            diameter: base.hydraulic_diameter_m,
            roughness,
            fixed_loss: 0.,
            grid_multiplier: 0.,
        };
        let molecular = base.laminar_darcy_shape * self.liquid.viscosity
            / (2. * self.liquid.density * base.area_m2 * base.hydraulic_diameter_m.powi(2));
        let (chi, dchi) = if effective == 0. {
            (1., 0.)
        } else {
            let loss = s.pressure_loss(effective, self.liquid.density, self.liquid.viscosity);
            let chi = loss[0] / (molecular * effective);
            let de_dq = self.liquid.density * (2. * u - v) / (2. * speed);
            (
                chi,
                (loss[1] * effective - loss[0]) / (molecular * effective * effective) * de_dq,
            )
        };
        let result = base.enhanced(chi.max(1.)).map_err(String::from)?;
        let slope = result.gradient_partials[0]
            + if chi > 1. {
                base.gradient_pa_m * dchi
            } else {
                0.
            };
        if !positive(slope) {
            return Err("Nonmonotone cold moving guide branch".into());
        }
        Ok((result, slope))
    }
    /// Total excess pressure loss, local Q derivative, clear-bottom loss,
    /// moving wall force and all actual passage dissipation.
    fn guide(&self, c: &Cluster, s: State, q: f64) -> Result<[f64; 5], String> {
        let area = c.rodlets as f64 * PI * c.body_radius_m.powi(2);
        let full = c.rodlets as f64 * PI * c.outer_radius_m.powi(2);
        let ann = full - area;
        let qin = q + area * s.body_v_m_s;
        let rho = self.liquid.density;
        let mut bottom = 0.;
        let mut slope = 0.;
        if s.body_y_m > 0. {
            let pipe = HydraulicSegment {
                law: LossLaw::ChurchillPipe,
                length: s.body_y_m,
                flow_area: full,
                diameter: 2. * c.outer_radius_m,
                roughness: c.roughness_m,
                fixed_loss: 0.,
                grid_multiplier: 0.,
            }
            .pressure_loss(rho * qin, rho, self.liquid.viscosity);
            bottom = pipe[0];
            slope = rho * pipe[1];
        }
        // Both mouths are real losses. Their cross-sections follow the
        // current geometry; at ORIGINAL the lower mouth is still occupied.
        let inlet_area = if s.body_y_m == 0. { ann } else { full };
        let kb = c.mouth_loss * rho / (2. * inlet_area.powi(2));
        let kt = c.mouth_loss * rho / (2. * ann.powi(2));
        bottom += kb * qin * qin.abs();
        slope += 2. * kb * qin.abs();
        let top = kt * q * q.abs();
        let g = Geometry {
            outer_radius_m: c.outer_radius_m,
            inner_radius_m: c.body_radius_m,
            length_m: c.top_m - c.bottom_m - s.body_y_m,
            multiplicity: c.rodlets,
        };
        let (a, da) = self.annulus(g, q, s.body_v_m_s, c.roughness_m)?;
        Ok([
            bottom + a.gradient_pa_m * g.length_m + top,
            slope + da * g.length_m + 2. * kt * q.abs(),
            bottom,
            a.body_wall_force_n,
            bottom * qin + a.dissipation_w + top * q,
        ])
    }
    pub fn evaluate(&self, states: &[State], external: &[f64]) -> Result<Stage, String> {
        if external.len() != self.dimension() || external.iter().any(|v| !v.is_finite()) {
            return Err("Cold water retained energy/marker shape".into());
        }
        let geometry = self.shapes(states)?;
        let n = self.config.clusters.len();
        let nodes = self.nodes();
        let upper = nodes - 1;
        let rho = self.liquid.density;
        let temperatures: Vec<_> = geometry
            .iter()
            .enumerate()
            .map(|(i, g)| {
                self.config.temperature_k
                    + (external[i] / (rho * g.volume) - GRAVITY * g.elevation) / self.liquid.cp
            })
            .collect();
        if temperatures.iter().any(|t| !positive(*t)) || external[nodes..].iter().any(|b| *b < 0.) {
            return Err("Invalid cold water thermal/carrier state".into());
        }
        let mut flows = vec![0.; n + self.config.returns.len()];
        let mut head = 0.;
        let mut iterations = 0;
        for iteration in 0..48 {
            iterations = iteration + 1;
            let mut f = Vec::with_capacity(flows.len());
            let mut d = Vec::with_capacity(flows.len());
            for (i, (&q, c)) in flows.iter().zip(&self.config.clusters).enumerate() {
                let r = self.guide(c, states[i], q)?;
                f.push(r[0]);
                d.push(r[1]);
            }
            for (i, r) in self.config.returns.iter().enumerate() {
                let a = r.pressure_loss(rho * flows[n + i], rho, self.liquid.viscosity);
                f.push(a[0]);
                d.push(rho * a[1]);
            }
            if f.iter().chain(&d).any(|v| !v.is_finite()) || d.iter().any(|v| *v <= 0.) {
                return Err("Invalid cold hydraulic Schur stage".into());
            }
            let displaced: f64 = self
                .config
                .clusters
                .iter()
                .zip(states)
                .map(|(c, s)| c.rodlets as f64 * PI * c.body_radius_m.powi(2) * s.body_v_m_s)
                .sum();
            let continuity = flows.iter().sum::<f64>() + displaced;
            let pressure_error = f.iter().map(|v| (v - head).abs()).fold(0., f64::max);
            if continuity.abs() <= 1e-15 && pressure_error <= 1e-9 + 1e-11 * head.abs() {
                break;
            }
            if iteration == 47 {
                return Err(format!(
                    "Cold guide hydraulic closure: continuity={continuity}, pressure={pressure_error}"
                ));
            }
            let dh = -(continuity + f.iter().zip(&d).map(|(f, d)| (head - f) / d).sum::<f64>())
                / d.iter().map(|d| 1. / d).sum::<f64>();
            head += dh;
            for i in 0..flows.len() {
                flows[i] += (head - f[i]) / d[i];
            }
        }
        let mut rates = vec![0.; self.dimension()];
        let mut forces = Vec::with_capacity(n);
        let mut ins = Vec::with_capacity(n);
        let mut dissipation = 0.;
        let mut traction_power = 0.;
        let mut pe_rate = 0.;
        // Each transfer has one donor and exactly opposite incidence. Here
        // p is the potential-inclusive head p(z)+rho*g*z, not raw local p(z):
        // the retained energy already includes PE. End-face work below uses
        // actual local pressure. Do not add gravity or friction heat twice.
        let mut transfer = |a: usize, b: usize, q: f64, pa: f64, pb: f64| {
            let donor = if q >= 0. { a } else { b };
            let p = if q >= 0. { pa } else { pb };
            let u = self.liquid.cp * (temperatures[donor] - self.config.temperature_k);
            let h = u + p / rho;
            let mass = rho * q;
            let marker = external[nodes + donor] / (rho * geometry[donor].volume);
            rates[a] -= mass * h;
            rates[b] += mass * h;
            rates[nodes + a] -= mass * marker;
            rates[nodes + b] += mass * marker;
        };
        let mut local = Vec::with_capacity(n);
        let pressure_zero = self.config.pressure_pa + rho * GRAVITY * self.config.pressure_datum_m;
        for (i, c) in self.config.clusters.iter().enumerate() {
            let s = states[i];
            let q = flows[i];
            let solid = c.rodlets as f64 * PI * c.body_radius_m.powi(2);
            let qin = q + solid * s.body_v_m_s;
            let g = self.guide(c, s, q)?;
            let full = c.rodlets as f64 * PI * c.outer_radius_m.powi(2);
            let ann = full - solid;
            let inlet = if s.body_y_m == 0. { ann } else { full };
            let mouth_bottom = c.mouth_loss * rho * qin * qin.abs() / (2. * inlet.powi(2));
            let mouth_top = c.mouth_loss * rho * q * q.abs() / (2. * ann.powi(2));
            transfer(
                0,
                i + 1,
                qin,
                pressure_zero + head,
                pressure_zero + head - mouth_bottom,
            );
            transfer(i + 1, upper, q, pressure_zero + mouth_top, pressure_zero);
            ins.push(qin);
            dissipation += g[4];
            local.push(g);
        }
        for (i, _) in self.config.returns.iter().enumerate() {
            let q = flows[n + i];
            transfer(0, upper, q, pressure_zero + head, pressure_zero);
            dissipation += head * q;
        }
        for (i, c) in self.config.clusters.iter().enumerate() {
            let s = states[i];
            let solid = c.rodlets as f64 * PI * c.body_radius_m.powi(2);
            let [_, _, bottom, wall, _] = local[i];
            let body_force = rho * GRAVITY * (c.body_volume_m3 + c.spider_volume_m3)
                + solid * (head - bottom)
                + wall;
            // The stem moves inside a genuinely closed-top housing. Its
            // pressure-end traction plus wall shear pays exactly -D, with no
            // extra kinetic/fluid-friction store or invented piston condition.
            let stem_area = PI * c.stem_radius_m.powi(2);
            let mut stem_drag = 0.;
            for p in &c.stem_passages {
                let lo = p.bottom_m.max(c.stem_bottom_m + s.stem_y_m);
                let hi = p.top_m.min(c.stem_top_m + s.stem_y_m);
                if hi <= lo {
                    continue;
                }
                let g = Geometry {
                    outer_radius_m: p.outer_radius_m,
                    inner_radius_m: c.stem_radius_m,
                    length_m: hi - lo,
                    multiplicity: 1,
                };
                let (a, _) =
                    self.annulus(g, -stem_area * s.stem_v_m_s, s.stem_v_m_s, c.roughness_m)?;
                stem_drag += stem_area * a.gradient_pa_m * g.length_m + a.body_wall_force_n;
                dissipation += a.dissipation_w;
            }
            let stem_force = rho * GRAVITY * c.stem_volume_m3 + stem_drag;
            // Actual cap pressures include gravity at their changing heights.
            let pbottom = pressure_zero + head - bottom - rho * GRAVITY * (c.bottom_m + s.body_y_m);
            let ptop = pressure_zero - rho * GRAVITY * (c.top_m + s.body_y_m);
            if pbottom <= 0. || ptop <= 0. {
                return Err("Cold apparatus lost positive end-face pressure".into());
            }
            rates[i + 1] -= (solid * pbottom + wall) * s.body_v_m_s;
            rates[upper] += solid * ptop * s.body_v_m_s
                - rho * GRAVITY * c.spider_volume_m3 * s.body_v_m_s
                - stem_force * s.stem_v_m_s;
            traction_power += body_force * s.body_v_m_s + stem_force * s.stem_v_m_s;
            pe_rate -= rho
                * GRAVITY
                * ((c.body_volume_m3 + c.spider_volume_m3) * s.body_v_m_s
                    + c.stem_volume_m3 * s.stem_v_m_s);
            forces.push(Forces {
                body_n: body_force,
                stem_n: stem_force,
            });
        }
        let energy = rates[..nodes].iter().sum::<f64>();
        let sensible = energy - pe_rate;
        if rates.iter().chain(flows.iter()).any(|v| !v.is_finite())
            || !head.is_finite()
            || !dissipation.is_finite()
            || dissipation < -1e-12
        {
            return Err("Invalid cold fluid work/carrier result".into());
        }
        Ok(Stage {
            forces,
            rates,
            geometry,
            temperatures,
            head_pa: head,
            guide_in_m3_s: ins,
            guide_out_m3_s: flows[..n].to_vec(),
            return_m3_s: flows[n..].to_vec(),
            dissipation_w: dissipation,
            sensible_rate_w: sensible,
            energy_defect_w: energy + traction_power,
            dissipation_defect_w: sensible - dissipation,
            iterations,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cluster() -> Cluster {
        let ro: f64 = 0.0055;
        let ri: f64 = 0.00475;
        let stem: f64 = 0.006;
        Cluster {
            outer_radius_m: ro,
            body_radius_m: ri,
            bottom_m: -2.25,
            top_m: 2.4,
            rodlets: 24,
            body_volume_m3: 24. * PI * ri.powi(2) * 4.65,
            spider_volume_m3: 4. / 7920.,
            stem_radius_m: stem,
            stem_bottom_m: 2.5,
            stem_top_m: 8.5,
            stem_volume_m3: PI * stem.powi(2) * 6.,
            stem_passages: vec![
                StemPassage {
                    bottom_m: 4.,
                    top_m: 8.05,
                    outer_radius_m: 0.125,
                },
                StemPassage {
                    bottom_m: 8.05,
                    top_m: 8.15,
                    outer_radius_m: 0.00625,
                },
                StemPassage {
                    bottom_m: 8.15,
                    top_m: 13.6,
                    outer_radius_m: 0.025,
                },
            ],
            roughness_m: 2e-6,
            mouth_loss: 0.5,
        }
    }
    fn model(n: usize) -> Model {
        Model::new(Config {
            clusters: vec![cluster(); n],
            lower: Bulk {
                volume_m3: 10.,
                first_moment_m4: -30.,
            },
            upper: Bulk {
                volume_m3: 40.,
                first_moment_m4: 140.,
            },
            returns: vec![Hydraulic {
                from: 0,
                to: 1,
                from_elevation: -2.25,
                to_elevation: 2.4,
                segments: vec![HydraulicSegment {
                    law: LossLaw::ChurchillPipe,
                    length: 4.65,
                    flow_area: 0.3,
                    diameter: 0.1,
                    roughness: 2e-6,
                    fixed_loss: 1.,
                    grid_multiplier: 0.,
                }],
            }],
            pressure_pa: 300000.,
            pressure_datum_m: 2.5,
            temperature_k: 300.,
            marker_fraction: 0.001,
        })
        .unwrap()
    }
    fn state(y: f64, v: f64) -> State {
        State {
            body_y_m: y,
            body_v_m_s: v,
            stem_y_m: y,
            stem_v_m_s: v,
            reference_y_m: y,
        }
    }
    fn thermal_state(m: &Model, s: &[State]) -> Vec<f64> {
        let g = m.shapes(s).unwrap();
        let mut e = Vec::new();
        e.extend(
            g.iter()
                .map(|g| m.liquid.density * g.volume * GRAVITY * g.elevation),
        );
        e.extend(
            g.iter()
                .map(|g| m.liquid.density * g.volume * m.config.marker_fraction),
        );
        e
    }
    #[test]
    fn absolute_pressure_datum_translates_with_physical_geometry_not_centroids() {
        let original = model(2);
        let mut config = original.config.clone();
        let offset = 17.;
        config.pressure_datum_m += offset;
        for b in [&mut config.lower, &mut config.upper] {
            b.first_moment_m4 += b.volume_m3 * offset;
        }
        for c in &mut config.clusters {
            c.bottom_m += offset;
            c.top_m += offset;
            c.stem_bottom_m += offset;
            c.stem_top_m += offset;
            for p in &mut c.stem_passages {
                p.bottom_m += offset;
                p.top_m += offset;
            }
        }
        let translated = Model::new(config).unwrap();
        let states = [state(0.003, 0.008), state(0.002, -0.003)];
        let a = original
            .evaluate(&states, &thermal_state(&original, &states))
            .unwrap();
        let b = translated
            .evaluate(&states, &thermal_state(&translated, &states))
            .unwrap();
        assert!((a.head_pa - b.head_pa).abs() < 1e-9);
        for (x, y) in a.forces.iter().zip(&b.forces) {
            assert!((x.body_n - y.body_n).abs() < 1e-9);
            assert!((x.stem_n - y.stem_n).abs() < 1e-9);
        }
        for (x, y) in a.temperatures.iter().zip(&b.temperatures) {
            assert!((x - y).abs() < 1e-12);
        }
        assert!((a.sensible_rate_w - b.sensible_rate_w).abs() < 1e-8);
        for (x, y) in original
            .check_property_departure(&a, 0.05, 0.01)
            .unwrap()
            .iter()
            .zip(translated.check_property_departure(&b, 0.05, 0.01).unwrap())
        {
            assert!((x - y).abs() < 1e-12);
        }
    }
    #[test]
    fn rest_has_no_hidden_flow_heat_or_marker_source() {
        let m = model(52);
        let s = vec![state(0., 0.); 52];
        let e = m.initial_state().unwrap();
        let r = m.evaluate(&s, &e).unwrap();
        assert_eq!(r.head_pa, 0.);
        assert_eq!(r.dissipation_w, 0.);
        assert!(r.rates.iter().all(|r| *r == 0.));
        assert!(
            r.guide_in_m3_s
                .iter()
                .chain(&r.guide_out_m3_s)
                .all(|q| *q == 0.)
        );
        assert!(m.check_property_departure(&r, 0.05, 0.01).is_ok());
    }
    #[test]
    fn distinct_clusters_have_actual_open_currents_and_reciprocal_work() {
        let m = model(52);
        let s: Vec<_> = (0..52)
            .map(|i| {
                state(
                    0.001 + 1e-5 * i as f64,
                    if i % 3 == 0 { -0.003 } else { 0.008 },
                )
            })
            .collect();
        let r = m.evaluate(&s, &thermal_state(&m, &s)).unwrap();
        assert!(r.dissipation_w > 0.);
        assert!(r.energy_defect_w.abs() < 1e-10, "{}", r.energy_defect_w);
        assert!(
            r.dissipation_defect_w.abs() < 1e-10,
            "{}",
            r.dissipation_defect_w
        );
        let mut displaced = 0.;
        for (i, c) in m.config.clusters.iter().enumerate() {
            let volume_rate = c.rodlets as f64 * PI * c.body_radius_m.powi(2) * s[i].body_v_m_s;
            assert!((r.guide_in_m3_s[i] - r.guide_out_m3_s[i] - volume_rate).abs() < 1e-18);
            assert!(
                (r.rates[m.nodes() + i + 1]
                    - m.liquid.density * volume_rate * m.config.marker_fraction)
                    .abs()
                    < 1e-14
            );
            displaced += volume_rate;
        }
        assert!(
            (r.guide_in_m3_s.iter().sum::<f64>() + r.return_m3_s.iter().sum::<f64>()).abs() < 1e-15
        );
        assert!(
            (r.guide_out_m3_s.iter().sum::<f64>() + r.return_m3_s.iter().sum::<f64>() + displaced)
                .abs()
                < 1e-15
        );
        assert!(r.rates[m.nodes()..].iter().sum::<f64>().abs() < 1e-14);
        // The installed open return permits a different actual Q; it is not
        // the closed-return/piston constraint disguised as a solver result.
        assert!(r.guide_out_m3_s[1] > 0.);
    }
    #[test]
    fn first_moment_and_volume_follow_all_independent_bodies_and_stems() {
        let m = model(3);
        let a = vec![state(0., 0.); 3];
        let mut b = a.clone();
        b[0].body_y_m = 0.001;
        b[0].stem_y_m = 0.0007;
        b[2].body_y_m = 0.002;
        b[2].stem_y_m = 0.0015;
        let ga = m.shapes(&a).unwrap();
        let gb = m.shapes(&b).unwrap();
        let v = |g: &[CellGeometry]| g.iter().map(|g| g.volume).sum::<f64>();
        let j = |g: &[CellGeometry]| g.iter().map(|g| g.volume * g.elevation).sum::<f64>();
        assert!((v(&ga) - v(&gb)).abs() < 1e-13);
        let expected: f64 = m
            .config
            .clusters
            .iter()
            .zip(&b)
            .map(|(c, s)| {
                (c.body_volume_m3 + c.spider_volume_m3) * s.body_y_m + c.stem_volume_m3 * s.stem_y_m
            })
            .sum();
        assert!((j(&ga) - j(&gb) - expected).abs() < 5e-14);
        assert_eq!(ga[2].volume, gb[2].volume);
        assert_ne!(ga[1].volume, gb[1].volume);
    }
    #[test]
    fn nonuniform_marker_uses_actual_upwind_donor_on_each_reversing_mouth() {
        let m = model(2);
        let states = [state(0.003, 0.008), state(0.002, -0.008)];
        let mut external = thermal_state(&m, &states);
        let geometry = m.shapes(&states).unwrap();
        let concentrations = [0.0002, 0.001, 0.004, 0.008];
        for i in 0..m.nodes() {
            external[m.nodes() + i] = concentrations[i] * m.liquid.density * geometry[i].volume;
        }
        let stage = m.evaluate(&states, &external).unwrap();
        let mut expected = vec![0.; m.nodes()];
        let mut scatter = |from: usize, to: usize, q: f64| {
            let donor = if q >= 0. { from } else { to };
            let flux = m.liquid.density * q * concentrations[donor];
            expected[from] -= flux;
            expected[to] += flux;
        };
        let upper = m.nodes() - 1;
        for i in 0..states.len() {
            scatter(0, i + 1, stage.guide_in_m3_s[i]);
            scatter(i + 1, upper, stage.guide_out_m3_s[i]);
        }
        for q in &stage.return_m3_s {
            scatter(0, upper, *q);
        }
        assert!(stage.guide_in_m3_s.iter().any(|q| *q > 0.));
        assert!(stage.guide_in_m3_s.iter().any(|q| *q < 0.));
        for (actual, expected) in stage.rates[m.nodes()..].iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-15);
        }
        assert!(stage.rates[m.nodes()..].iter().sum::<f64>().abs() < 1e-15);
    }
    #[test]
    fn nose_sides_reversal_and_return_resistance_are_real() {
        let m = model(1);
        for y in [0., 1e-12, 1e-6, 0.001] {
            for v in [-0.008, 0., 0.008] {
                let s = [state(y, v)];
                let r = m.evaluate(&s, &thermal_state(&m, &s)).unwrap();
                assert!(r.dissipation_w >= 0.);
                assert!(r.energy_defect_w.abs() < 1e-12);
                assert!(r.dissipation_defect_w.abs() < 1e-12);
            }
        }
        let s = [state(0.001, 0.008)];
        let r = m.evaluate(&s, &thermal_state(&m, &s)).unwrap();
        let mut c = m.config.clone();
        c.returns[0].segments[0].diameter *= 0.1;
        c.returns[0].segments[0].flow_area *= 0.01;
        let restricted = Model::new(c).unwrap();
        let rr = restricted
            .evaluate(&s, &thermal_state(&restricted, &s))
            .unwrap();
        assert!(rr.head_pa.abs() > r.head_pa.abs());
        assert!(rr.forces[0].body_n < r.forces[0].body_n);
    }
    #[test]
    fn applicability_refuses_warm_or_invalid_states_without_reset() {
        let m = model(1);
        let s = [state(0., 0.)];
        let mut e = m.initial_state().unwrap();
        e[1] += m.liquid.density * m.shapes(&s).unwrap()[1].volume * m.liquid.cp * 0.1;
        let original = e.clone();
        let r = m.evaluate(&s, &e).unwrap();
        assert!(m.check_property_departure(&r, 0.05, 0.01).is_err());
        assert_eq!(e, original);
        e[m.nodes() + 1] = -1.;
        assert!(m.evaluate(&s, &e).is_err());
        assert!(m.evaluate(&[state(-1e-6, 0.)], &original).is_err());
        let mut escaped = s;
        escaped[0].stem_y_m = 6.;
        assert!(m.shapes(&escaped).is_err());
        let mut config = m.config.clone();
        config.clusters[0].stem_top_m = 14.;
        assert!(Model::new(config).is_err());
    }
}

//! Full physical SOURCE/cooling graph at one mechanical stage. No time
//! integrator, prescribed trajectory, cloned inventory or live installation.
//! Reuses the advancing driver's parser, joint initializer and actual KLU.
#![allow(dead_code)]
#[path = "cooling_accuracy.rs"]
mod cooling_accuracy;
#[path = "cooling_actuation.rs"]
mod cooling_actuation;
#[path = "cooling_block/mod.rs"]
mod cooling_block;
#[path = "cooling_bundle.rs"]
mod cooling_bundle;
#[path = "cooling_capture.rs"]
mod cooling_capture;
#[path = "cooling_convergence.rs"]
mod cooling_convergence;
#[path = "cooling_coordinates.rs"]
mod cooling_coordinates;
#[cfg(test)]
#[path = "../tests/source_cooling.rs"]
mod cooling_fixture;
#[path = "cooling_initial.rs"]
mod cooling_initial;
#[path = "cooling_input/mod.rs"]
mod cooling_input;
#[path = "cooling_mobile.rs"]
mod cooling_mobile;
#[path = "cooling_trial.rs"]
mod cooling_trial;
#[path = "evolution_input/mod.rs"]
mod evolution_input;
#[path = "control_geometry_input.rs"]
mod geometry_input;
use cooling_trial::{recoverable, state_error_scale};
#[path = "../examples/ida_support/mod.rs"]
mod ida_support;
#[path = "../examples/operating_network_input/mod.rs"]
mod operating_network_input;
#[path = "source_accuracy.rs"]
mod source_accuracy;
#[path = "source_block/mod.rs"]
mod source_block;
#[path = "source_coordinates/mod.rs"]
mod source_coordinates;
#[path = "source_input/mod.rs"]
mod source_input;
#[path = "source_pair.rs"]
mod source_pair;
use ida_support::*;
use leitbild_plant_numerics::{
    GRAVITY, barrel_thermal, control_source_geometry as cg, converter_heat, cylindrical_source,
    fuel_history, fuel_source, fuel_thermal, heat_history, moderator_source, moving_guide,
    operating_admission, operating_network, optical_source, passive_source, source_cooling,
    source_evolution, transport_source, water_carrier,
};
use operating_network::moving_hydraulic::Law;
use operating_network::{MotionGeometry, MovingConnection, MovingConnectionDirection, WaterShape};
use source_evolution::Evolution;
use source_input::{count, framed, number};
use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::Path,
    slice,
    time::Instant,
};
const COUNT_ATOL: f64 = 1e-3;
const ENERGY_ATOL: f64 = 1e-12;
const HORIZON: f64 = 300.;
use cooling_accuracy::OUTPUTS;
fn finite(x: f64) -> String {
    if x.is_finite() {
        format!("{x:e}")
    } else {
        "null".into()
    }
}
fn quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
fn numbers(x: &[f64]) -> String {
    format!(
        "[{}]",
        x.iter().map(|&x| finite(x)).collect::<Vec<_>>().join(",")
    )
}
fn ratio(n: f64, d: f64) -> Result<f64, String> {
    if !n.is_finite() || !d.is_finite() || d <= 0. {
        Err("Invalid numerical comparison scale".into())
    } else {
        Ok(n / d)
    }
}
unsafe fn values<'a>(v: Handle, n: usize) -> Result<&'a [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong qualification vector".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null qualification vector".into());
    }
    Ok(unsafe { slice::from_raw_parts(p, n) })
}
unsafe fn output<'a>(v: Handle, n: usize) -> Result<&'a mut [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong qualification output".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null qualification output".into());
    }
    Ok(unsafe { slice::from_raw_parts_mut(p, n) })
}
struct Binding {
    cluster: usize,
    cell: usize,
    lower_edge: usize,
    upper_edge: usize,
}
struct HydraulicPlan {
    lower: usize,
    upper: usize,
    bottom: f64,
    top: f64,
    guide_radius: f64,
    body_radius: f64,
    rodlets: u32,
    roughness: f64,
    mouth: f64,
    bindings: Vec<Binding>,
}
impl HydraulicPlan {
    fn connections(&self, poses: &[cg::Pose], velocity: &[cg::Direction]) -> Vec<MovingConnection> {
        self.bindings
            .iter()
            .flat_map(|b| {
                let y = poses[b.cluster].body;
                let v = velocity[b.cluster].body;
                let tip = self.bottom + y;
                [
                    MovingConnection {
                        edge: b.lower_edge,
                        from_elevation_m: self.bottom,
                        to_elevation_m: tip,
                        fluid_work_cell: b.cell,
                        law: Law::Clear {
                            outer_radius_m: self.guide_radius,
                            length_m: y,
                            multiplicity: self.rodlets,
                            roughness_m: self.roughness,
                            mouth_loss: self.mouth,
                        },
                    },
                    MovingConnection {
                        edge: b.upper_edge,
                        from_elevation_m: tip,
                        to_elevation_m: self.top,
                        fluid_work_cell: b.cell,
                        law: Law::Annulus {
                            geometry: moving_guide::Geometry {
                                outer_radius_m: self.guide_radius,
                                inner_radius_m: self.body_radius,
                                length_m: self.top - self.bottom - y,
                                multiplicity: self.rodlets,
                            },
                            speed_m_s: v,
                            roughness_m: self.roughness,
                            mouth_loss: self.mouth,
                        },
                    },
                ]
            })
            .collect()
    }
    fn direction(
        &self,
        pose: &[cg::Direction],
        velocity: &[cg::Direction],
    ) -> Vec<MovingConnectionDirection> {
        self.bindings
            .iter()
            .flat_map(|b| {
                let y = pose[b.cluster].body;
                let v = velocity[b.cluster].body;
                [
                    MovingConnectionDirection {
                        from_elevation_m: 0.,
                        to_elevation_m: y,
                        length_m: y,
                        speed_m_s: 0.,
                    },
                    MovingConnectionDirection {
                        from_elevation_m: y,
                        to_elevation_m: 0.,
                        length_m: -y,
                        speed_m_s: v,
                    },
                ]
            })
            .collect()
    }
    fn check(&self, n: &operating_network::Network, clusters: usize) -> Result<(), String> {
        if self.bindings.len() != clusters
            || self.lower >= n.config().water.len()
            || self.upper >= n.config().water.len()
            || self.top <= self.bottom
            || self.rodlets == 0
        {
            return Err("Invalid moving hydraulic bindings".into());
        }
        let mut cells = std::collections::BTreeSet::new();
        let mut edges = cells.clone();
        let mut ids = cells.clone();
        for b in &self.bindings {
            if b.cluster >= clusters
                || b.cell >= n.config().water.len()
                || b.lower_edge >= n.config().hydraulic.len()
                || b.upper_edge >= n.config().hydraulic.len()
                || !ids.insert(b.cluster)
                || !cells.insert(b.cell)
                || !edges.insert(b.lower_edge)
                || !edges.insert(b.upper_edge)
            {
                return Err("Repeated/out-of-range actual guide binding".into());
            }
            let a = &n.config().hydraulic[b.lower_edge];
            let z = &n.config().hydraulic[b.upper_edge];
            if a.from != self.lower || a.to != b.cell || z.from != b.cell || z.to != self.upper {
                return Err("Moving guide binding differs from physical graph".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Case {
    pose: Vec<cg::Pose>,
    direction: Vec<cg::Direction>,
    velocity: Vec<cg::Direction>,
    dvelocity: Vec<cg::Direction>,
}
struct Current {
    geometry: cg::Workspace,
    water: Vec<WaterShape>,
    dwater: Vec<WaterShape>,
    connections: Vec<MovingConnection>,
    dconnections: Vec<MovingConnectionDirection>,
}
impl Current {
    fn new(p: &cg::Prepared, h: &HydraulicPlan, c: &Case) -> Result<Self, String> {
        let mut geometry = p.workspace();
        p.evaluate_into(&c.pose, &c.direction, &mut geometry)
            .map_err(str::to_string)?;
        p.water_rates_into(&c.velocity, &c.dvelocity, &mut geometry)
            .map_err(str::to_string)?;
        let water = geometry
            .value
            .water
            .iter()
            .zip(&geometry.water_rates)
            .map(|(v, r)| WaterShape {
                volume_m3: v.volume,
                first_moment_m4: v.moment,
                volume_rate_m3_s: r.volume,
                first_moment_rate_m4_s: r.moment,
            })
            .collect();
        let dwater = geometry
            .direction
            .water
            .iter()
            .zip(&geometry.water_rate_direction)
            .map(|(v, r)| WaterShape {
                volume_m3: v.volume,
                first_moment_m4: v.moment,
                volume_rate_m3_s: r.volume,
                first_moment_rate_m4_s: r.moment,
            })
            .collect();
        Ok(Self {
            geometry,
            water,
            dwater,
            connections: h.connections(&c.pose, &c.velocity),
            dconnections: h.direction(&c.direction, &c.dvelocity),
        })
    }
    fn value(&self) -> source_cooling::CurrentGeometry<'_> {
        source_cooling::CurrentGeometry {
            source: &self.geometry.value.source,
            contacts: &self.geometry.value.contacts,
            mobile: &self.geometry.value.mobile,
            barrel_chords_m: &self.geometry.value.barrel_chords_m,
            network: MotionGeometry {
                water: &self.water,
                connections: &self.connections,
            },
        }
    }
    fn direction(&self) -> source_cooling::GeometryDirection<'_> {
        source_cooling::GeometryDirection {
            source: &self.geometry.direction.source,
            contacts: &self.geometry.direction.contacts,
            mobile: &self.geometry.direction.mobile,
            barrel_chords_m: &self.geometry.direction.barrel_chords_m,
            water: &self.dwater,
            connections: &self.dconnections,
        }
    }
}
fn matrix_check(
    model: &source_cooling::Model,
    w: &source_cooling::Workspace,
) -> Result<String, String> {
    let began = Instant::now();
    let rows = model.fluid_rows().collect::<Vec<_>>();
    let map = rows
        .iter()
        .enumerate()
        .map(|(i, &r)| (r, i))
        .collect::<HashMap<_, _>>();
    let mut entries = Vec::new();
    model.visit_fluid_jacobian(w, |r, c, v| {
        if let (Some(&r), Some(&c)) = (map.get(&r), map.get(&c)) {
            entries.push((r, c, v))
        }
    })?;
    let mut matrix = cooling_block::Sparse::new(
        "Actual full98 current-fluid saddle KLU",
        rows.len(),
        entries.iter().map(|&(r, c, _)| (r, c)),
    )?;
    for &(r, c, v) in &entries {
        matrix.add(r, c, v)?
    }
    matrix.factor()?;
    let rhs = (0..rows.len())
        .map(|i| ((i + 1) as f64).sin())
        .collect::<Vec<_>>();
    let mut x = vec![0.; rows.len()];
    matrix.solve(&rhs, &mut x)?;
    let (row, error, absolute, scale) = matrix.backward_error(&rhs, &x);
    if error > 1e-10 {
        return Err(format!(
            "Full current-fluid KLU backward error {error} row {}",
            rows[row]
        ));
    }
    Ok(format!(
        "{{\"rows\":{},\"entries\":{},\"cj\":1,\"seconds\":{},\"maxContributorScaledBackwardError\":{error},\"row\":{},\"absolute\":{absolute},\"contributorSum\":{scale}}}",
        rows.len(),
        entries.len(),
        began.elapsed().as_secs_f64(),
        rows[row]
    ))
}

/// Dimensional numerical discrimination, not integration tolerances or plant
/// empirical accuracy. Huge count RHS differences remain conditioning
/// diagnostics; the separately qualified coefficient/assembly chain owns them.
fn fd_group(model: &source_cooling::Model, row: usize) -> (&'static str, f64, bool) {
    let l = model.layout;
    if row < l.source_end
        || (l.carrier_start..l.energies_start).contains(&row)
        || (l.surge_carrier_start..=l.gas_hydrogen_product).contains(&row)
    {
        return ("count_per_second_conditioning_diagnostic", 1e-3, false);
    }
    if (l.network_start..l.carrier_start).contains(&row) {
        let r = row - l.network_start;
        let n = &model.network;
        let nw = n.config().water.len();
        let q0 = n.flow_row(0);
        let q1 = q0 + n.config().hydraulic.len();
        if (q0..q1).contains(&r) {
            return ("hydraulic_Pa", 1e-5, true);
        }
        if r == n.pressure_row() {
            return ("aggregate_chart_kg", 1e-7, true);
        }
        if (n.temperature_row(0)..q0).contains(&r) {
            return ("caloric_chart_J", 1e-3, true);
        }
        if (nw..2 * nw).contains(&r)
            || (q1..n.base_dimension()).contains(&r)
            || r == n.total_mass_row()
        {
            return ("material_rate_kg_per_s", 1e-9, true);
        }
        if r < n.stock_dimension() {
            return ("finite_energy_rate_W", 1e-5, true);
        }
        return ("unchanged_PRHR_geometry", 1e-9, true);
    }
    if (l.energies_start..l.temperatures_start).contains(&row)
        || row == l.barrel_energy
        || (l.absorber_guide_energies_start..l.absorber_guide_temperatures_start).contains(&row)
    {
        return ("finite_energy_rate_W", 1e-5, true);
    }
    if (l.temperatures_start..l.barrel_energy).contains(&row)
        || row == l.barrel_temperature
        || (l.absorber_guide_temperatures_start..l.absorber_guide_exported).contains(&row)
    {
        return ("caloric_chart_J", 1e-3, true);
    }
    if [
        l.barrel_exported,
        l.fuel_capture_exported,
        l.mobile_capture_exported,
        l.mobile_capture_boundary_exported,
        l.absorber_guide_exported,
        l.ambient_exported,
    ]
    .contains(&row)
    {
        return ("exported_energy_rate_W", 1e-8, true);
    }
    ("unchanged_pressure_support_geometry", 1e-9, true)
}
#[derive(Default)]
struct Comparison {
    fields: usize,
    nonzero: usize,
    ratio: f64,
    row: usize,
    absolute: f64,
    analytic: f64,
    fd: f64,
    gated: bool,
}
fn geometry_fd(
    model: &source_cooling::Model,
    p: &cg::Prepared,
    h: &HydraulicPlan,
    c: &Case,
    y: &[f64],
    yp: &[f64],
    input: Option<leitbild_plant_numerics::prhr::Input>,
    analytic: &[f64],
    directory: &Path,
) -> Result<String, String> {
    let began = Instant::now();
    let step = 1e-5;
    let shift = |sign: f64| Case {
        pose: c
            .pose
            .iter()
            .zip(&c.direction)
            .map(|(p, d)| cg::Pose {
                body: p.body + sign * step * d.body,
                stem: p.stem + sign * step * d.stem,
                ..*p
            })
            .collect(),
        direction: c.direction.clone(),
        velocity: c
            .velocity
            .iter()
            .zip(&c.dvelocity)
            .map(|(v, d)| cg::Direction {
                body: v.body + sign * step * d.body,
                stem: v.stem + sign * step * d.stem,
            })
            .collect(),
        dvelocity: c.dvelocity.clone(),
    };
    let mut arms = Vec::new();
    for (arm, sign) in [-1., 1.].into_iter().enumerate() {
        let current = Current::new(p, h, &shift(sign))?;
        let mut w = model.workspace();
        model.evaluate_with_current_geometry(y, yp, None, &mut w, input, current.value())?;
        fs::write(
            directory.join(format!("geometry-fd-arm-{arm}.json")),
            format!(
                "{{\"epsilonM\":{step},\"sign\":{sign},\"residual\":{}}}",
                numbers(&w.residual)
            ),
        )
        .map_err(|e| e.to_string())?;
        arms.push(w.residual);
    }
    let mut groups = std::collections::BTreeMap::<&str, Comparison>::new();
    for row in 0..model.dimension() {
        let fd = (arms[1][row] - arms[0][row]) / (2. * step);
        let a = analytic[row];
        let (name, atol, gated) = fd_group(model, row);
        let ratio = (a - fd).abs() / (atol + 3e-5 * a.abs().max(fd.abs()));
        if !ratio.is_finite() {
            return Err(format!("Nonfinite geometry derivative row {row}"));
        }
        let g = groups.entry(name).or_default();
        g.fields += 1;
        g.nonzero += usize::from(a != 0.);
        g.gated = gated;
        if ratio > g.ratio {
            g.ratio = ratio;
            g.row = row;
            g.absolute = (a - fd).abs();
            g.analytic = a;
            g.fd = fd;
        }
    }
    let fields=groups.iter().map(|(name,g)|format!("{{\"name\":{},\"checkedFields\":{},\"nonzeroAnalyticFields\":{},\"acceptanceGate\":{},\"maxRatio\":{},\"worstRow\":{},\"absoluteDifference\":{},\"analytic\":{},\"finiteDifference\":{}}}",quote(name),g.fields,g.nonzero,g.gated,g.ratio,g.row,g.absolute,g.analytic,g.fd)).collect::<Vec<_>>().join(",");
    let report = format!(
        "{{\"epsilonM\":{step},\"relativeDiscrimination\":3e-5,\"seconds\":{},\"countRHSStatus\":\"diagnostic-only;coefficient-and-assembly-qualification-is-separate\",\"groups\":[{fields}]}}",
        began.elapsed().as_secs_f64()
    );
    fs::write(directory.join("geometry-fd-comparison.json"), &report).map_err(|e| e.to_string())?;
    if let Some((name, g)) = groups.iter().find(|(_, g)| g.gated && g.ratio > 1.) {
        return Err(format!(
            "Current composed geometry derivative failed {name} ratio {} row {} (see retained comparison)",
            g.ratio, g.row
        ));
    }
    Ok(report)
}
fn reciprocal(
    model: &source_cooling::Model,
    y: &[f64],
    yp: &[f64],
    h: &HydraulicPlan,
    c: &Case,
    current: &Current,
    w: &source_cooling::Workspace,
) -> Result<String, String> {
    let n = &model.network;
    let yn = &y[model.layout.network_start..model.layout.carrier_start];
    let r = w.network.moving_responses()?;
    let (mut mechanical, mut mechanical_scale, mut body_forces, mut stem_forces) =
        (0., 0., Vec::new(), Vec::new());
    for (i, b) in h.bindings.iter().enumerate() {
        let p = &current.geometry.water_partials[b.cluster];
        let g = b.cell;
        let u = h.upper;
        let rg = w.network.liquids[g].density;
        let ru = w.network.liquids[u].density;
        let offset = |node: usize| n.pressure_offset(node) + n.relative_pressure(node, yn);
        // The common thermodynamic pressure cancels analytically because
        // body/upper V_y sum to zero. Never subtract two large cap pressures.
        if p.guide_body.volume + p.upper_body.volume != 0. {
            return Err("Body pressure virtual-work volume incidence does not cancel".into());
        }
        let pg = offset(g) + rg * GRAVITY * n.config().water[g].geometry.elevation;
        let pu = offset(u) + ru * GRAVITY * n.config().water[u].geometry.elevation;
        let force = p.guide_body.volume * (pg - pu)
            - GRAVITY * (rg * p.guide_body.moment + ru * p.upper_body.moment)
            + r[2 * i + 1].wall_force_n;
        let stem = -GRAVITY * ru * p.upper_stem.moment;
        body_forces.push(force);
        stem_forces.push(stem);
        mechanical += force * c.velocity[b.cluster].body + stem * c.velocity[b.cluster].stem;
        mechanical_scale +=
            (force * c.velocity[b.cluster].body).abs() + (stem * c.velocity[b.cluster].stem).abs();
    }
    let pressure = w.network.shape_pressure_work_w.iter().sum::<f64>();
    let wall = r.iter().map(|r| r.fluid_wall_work_w).sum::<f64>();
    let defect = pressure + wall + mechanical;
    let scale = w
        .network
        .shape_pressure_work_w
        .iter()
        .map(|v| v.abs())
        .sum::<f64>()
        + r.iter().map(|r| r.fluid_wall_work_w.abs()).sum::<f64>()
        + mechanical_scale;
    if defect.abs() > 1e-9 + 128. * f64::EPSILON * scale {
        return Err(format!(
            "Current guide pressure/wall virtual-work defect {defect} W"
        ));
    }
    let balance = w.complete_energy_rate()? - (pressure + wall);
    let sumscale = model
        .installed_energy_rows()
        .map(|i| yp[i].abs() + w.residual[i].abs())
        .sum::<f64>()
        + scale;
    if balance.abs() > 1e-8 + 256. * f64::EPSILON * sumscale {
        return Err(format!(
            "Composed energy receipt defect after actual mechanical work: {balance} W"
        ));
    }
    Ok(format!(
        "{{\"fluidPressureWorkW\":{pressure},\"fluidWallWorkW\":{wall},\"oppositeMechanicalPowerW\":{mechanical},\"reciprocalDefectW\":{defect},\"composedEnergyDefectAfterMechanicalWorkW\":{balance},\"bodyFluidForcesN\":{},\"stemBuoyancyOnlyN\":{},\"stemNeckDragJoined\":false}}",
        numbers(&body_forces),
        numbers(&stem_forces)
    ))
}
fn retain(
    path: &Path,
    y: &[f64],
    yp: &[f64],
    w: &source_cooling::Workspace,
    trace: &cooling_initial::Trace,
) -> Result<(), String> {
    fs::write(path,format!("{{\"state\":{},\"rates\":{},\"residual\":{},\"jvp\":{},\"waterMass\":{},\"flows\":{},\"initialization\":{}}}",
        numbers(y),numbers(yp),numbers(&w.residual),numbers(&w.jvp),numbers(&w.network.chart_mass),numbers(&w.network.mass_flows),trace.json())).map_err(|e|e.to_string())
}
fn run() -> Result<(), String> {
    let began = Instant::now();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("Expected wall allowance and NEW artifact directory".into());
    }
    let allowance: f64 = args[0].parse().map_err(|_| "Invalid stage allowance")?;
    if !allowance.is_finite() || allowance <= 0. {
        return Err("Positive stage allowance required".into());
    }
    let directory = Path::new(&args[1]);
    if !directory.is_dir() {
        return Err("Artifact directory must already exist".into());
    }
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let words = text.split_whitespace().collect::<Vec<_>>();
    let mut raw = words.iter().copied();
    let fixture = framed(&mut raw).join(" ");
    let plan = framed(&mut raw);
    let passive = (0..count(&mut raw))
        .map(|_| passive_source::Intersection {
            stock: count(&mut raw),
            region: count(&mut raw),
            volume: number(&mut raw),
        })
        .collect::<Vec<_>>();
    let cylinder = (0..count(&mut raw))
        .map(|_| cylindrical_source::Intersection {
            target: count(&mut raw),
            region: count(&mut raw),
            share: number(&mut raw),
        })
        .collect::<Vec<_>>();
    let lower = count(&mut raw);
    let upper = count(&mut raw);
    let bottom = number(&mut raw);
    let top = number(&mut raw);
    let guide_radius = number(&mut raw);
    let body_radius = number(&mut raw);
    let rodlets = count(&mut raw)
        .try_into()
        .map_err(|_| "Rodlet count exceeds u32")?;
    let roughness = number(&mut raw);
    let mouth = number(&mut raw);
    let bindings = (0..count(&mut raw))
        .map(|_| Binding {
            cluster: count(&mut raw),
            cell: count(&mut raw),
            lower_edge: count(&mut raw),
            upper_edge: count(&mut raw),
        })
        .collect();
    let hydraulic = HydraulicPlan {
        lower,
        upper,
        bottom,
        top,
        guide_radius,
        body_radius,
        rodlets,
        roughness,
        mouth,
        bindings,
    };
    let input = geometry_input::parse(&plan)?;
    let clusters = input.clusters;
    let count_cases = count(&mut raw);
    let mut cases = Vec::with_capacity(count_cases);
    for _ in 0..count_cases {
        let pose = (0..clusters)
            .map(|_| {
                let body = number(&mut raw);
                let stem = number(&mut raw);
                let body_right = count(&mut raw);
                let stem_right = count(&mut raw);
                let seated = count(&mut raw);
                assert!(
                    body_right <= 1 && stem_right <= 1 && seated <= 1,
                    "Invalid explicit physical branch"
                );
                cg::Pose {
                    body,
                    stem,
                    body_right: body_right == 1,
                    stem_right: stem_right == 1,
                    seated: seated == 1,
                }
            })
            .collect();
        let mut direction = || {
            (0..clusters)
                .map(|_| cg::Direction {
                    body: number(&mut raw),
                    stem: number(&mut raw),
                })
                .collect::<Vec<_>>()
        };
        let d = direction();
        let velocity = direction();
        let dvelocity = direction();
        cases.push(Case {
            pose,
            direction: d,
            velocity,
            dvelocity,
        });
    }
    if raw.next().is_some() {
        return Err("Trailing current-cooling input".into());
    }
    let prepared = cooling_input::parse_with_source_incidence(&fixture, &passive, &cylinder)?;
    let model = &prepared.model;
    hydraulic.check(&model.network, clusters)?;
    let geometry =
        cg::Prepared::new(input, model.source.prepared_geometry()).map_err(str::to_string)?;
    let schedule =
        cooling_actuation::Schedule::new(model, prepared.prhr_action, prepared.actuation.as_ref())?;
    let initial_prhr = schedule.as_ref().map(|s| s.input(0., 0.)).transpose()?;
    let initial = model.initial_state_with_prhr_input(initial_prhr)?;
    let accuracy =
        cooling_accuracy::Accuracy::new(model, &prepared.target_emissions, initial_prhr)?;
    let mut results = Vec::new();
    let mut original_residual = None;
    let mut original_state = None;
    let mut original_rates = None;
    let source_reference = initial[..model.layout.source_end].to_vec();
    for (index, c) in cases.iter().enumerate() {
        if began.elapsed().as_secs_f64() >= allowance {
            return Err("Current-cooling stage allowance exhausted".into());
        }
        let stage_start = Instant::now();
        let current = Current::new(&geometry, &hydraulic, c)?;
        let time_case = Case {
            pose: c.pose.clone(),
            direction: c.velocity.clone(),
            velocity: c.velocity.clone(),
            dvelocity: vec![cg::Direction::default(); clusters],
        };
        let time = Current::new(&geometry, &hydraulic, &time_case)?;
        let mut y = initial.clone();
        let mut yp = vec![0.; model.dimension()];
        let mut work = model.workspace();
        let mut trace = cooling_initial::Trace::default();
        model.evaluate_with_current_geometry(
            &y,
            &yp,
            Some(0.),
            &mut work,
            initial_prhr,
            current.value(),
        )?;
        let mut absolute = accuracy.absolute(1.)?;
        let network_weights = operating_admission::weights(
            &model.network,
            &work.network,
            &y[model.layout.network_start..model.layout.carrier_start],
            300.,
            1.,
        )?;
        absolute[model.layout.network_start..model.layout.carrier_start]
            .copy_from_slice(&network_weights.absolute);
        model.evaluate_with_current_geometry(
            &y,
            &yp,
            Some(1.),
            &mut work,
            initial_prhr,
            current.value(),
        )?;
        let prepared_matrix = matrix_check(model, &work)?;
        let prepared_lower_slopes = hydraulic
            .bindings
            .iter()
            .map(|b| {
                work.network
                    .current_hydraulic_loss(&model.network, b.lower_edge)
                    .map(|r| r[1])
            })
            .collect::<Result<Vec<_>, _>>()?;
        let moving = cooling_initial::Moving {
            value: current.value(),
            time: time.direction(),
        };
        let report = cooling_initial::initialize_with_geometry(
            model,
            &mut y,
            &mut yp,
            &absolute,
            &mut work,
            began,
            allowance,
            1e-6,
            &mut trace,
            initial_prhr,
            &moving,
        );
        if let Err(e) = report {
            retain(
                &directory.join(format!("case-{index}-FAILED.json")),
                &y,
                &yp,
                &work,
                &trace,
            )?;
            return Err(format!("Current-cooling case {index}: {e}"));
        }
        let report = report.unwrap();
        if source_reference
            .iter()
            .zip(&y)
            .any(|(a, b)| a.to_bits() != b.to_bits())
        {
            return Err("SOURCE history changed during held-stage consistency".into());
        }
        model.evaluate_with_current_geometry(
            &y,
            &yp,
            Some(1.),
            &mut work,
            initial_prhr,
            current.value(),
        )?;
        let matrix = matrix_check(model, &work)?;
        let energy = reciprocal(model, &y, &yp, &hydraulic, c, &current, &work)?;
        let mouth_slopes = hydraulic
            .bindings
            .iter()
            .map(|b| {
                work.network
                    .current_hydraulic_loss(&model.network, b.lower_edge)
                    .map(|r| r[1])
            })
            .collect::<Result<Vec<_>, _>>()?;
        let diagnostics = operating_admission::screen(
            &model.network,
            &work.network,
            &y[model.layout.network_start..model.layout.carrier_start],
            operating_admission::totals(
                &model.network,
                &initial[model.layout.network_start..model.layout.carrier_start],
            ),
            &network_weights.flow,
        )?;
        model.jvp_with_current_geometry(
            &vec![0.; model.dimension()],
            1.,
            &mut work,
            current.direction(),
        )?;
        if index == 0 {
            original_residual = Some(work.residual.clone());
            original_state = Some(y.clone());
            original_rates = Some(yp.clone());
        }
        if index + 1 == cases.len() && c.pose.iter().all(|p| p.body == 0. && p.stem == 0.) {
            if original_residual.as_ref().is_some_and(|r| {
                r.iter()
                    .zip(&work.residual)
                    .any(|(a, b)| a.to_bits() != b.to_bits())
            }) {
                return Err("Restored ORIGINAL complete residual differs".into());
            }
            for (name, before, after) in [
                ("state", original_state.as_ref().unwrap(), &y),
                ("rates", original_rates.as_ref().unwrap(), &yp),
            ] {
                if before
                    .iter()
                    .zip(after)
                    .any(|(a, b)| a.to_bits() != b.to_bits())
                {
                    return Err(format!("Restored ORIGINAL complete {name} differs"));
                }
            }
        }
        retain(
            &directory.join(format!("case-{index}.json")),
            &y,
            &yp,
            &work,
            &trace,
        )?;
        let fd = if c.direction.iter().any(|d| d.body != 0. || d.stem != 0.)
            || c.dvelocity.iter().any(|d| d.body != 0. || d.stem != 0.)
        {
            let fd_dir = directory.join(format!("case-{index}-geometry-fd"));
            fs::create_dir(&fd_dir).map_err(|e| e.to_string())?;
            geometry_fd(
                model,
                &geometry,
                &hydraulic,
                c,
                &y,
                &yp,
                initial_prhr,
                &work.jvp,
                &fd_dir,
            )?
        } else {
            "null".into()
        };
        results.push(format!("{{\"case\":{index},\"seconds\":{},\"fixedDifferentialStocksBitwisePreserved\":true,\"initialization\":{},\"preparedZeroFlowMatrix\":{prepared_matrix},\"preparedLowerMouthSlopesPaPerKgS\":{},\"matrix\":{matrix},\"geometryJVP\":{fd},\"work\":{energy},\"lowerMouthSlopesPaPerKgS\":{},\"currentAdmission\":{{\"chart\":{:?},\"pressureSplit\":{:?},\"bulkSpeedMPerS\":{},\"movingWallSpeedMPerS\":{},\"movingProfileSpeedBoundMPerS\":{},\"dynamicHeadPa\":{},\"omittedKineticEnergyBoundJ\":{}}}}}",
            stage_start.elapsed().as_secs_f64(),report.json(),numbers(&prepared_lower_slopes),numbers(&mouth_slopes),diagnostics.chart,diagnostics.pressure_split,diagnostics.speed,
            diagnostics.moving_wall_speed,diagnostics.moving_profile_speed_bound,diagnostics.dynamic_head,diagnostics.omitted_kinetic_energy));
        eprintln!(
            "Current cooling stage {index} consistent in {:.4}s",
            stage_start.elapsed().as_secs_f64()
        );
    }
    println!(
        "{{\"status\":\"PASS\",\"scope\":\"full-PRHR-SOURCE-cooling-current-stage-and-joint-consistency;not-a-trajectory\",\"waterOwners\":{},\"controlClusters\":{clusters},\"unknowns\":{},\"sourceHistoryAdvanced\":false,\"trajectoryAdmitted\":false,\"mechanicalDynamicsJoined\":false,\"stemNeckDragJoined\":false,\"liveModelInstalled\":false,\"elapsedS\":{},\"cases\":[{}]}}",
        model.carrier.cells(),
        model.dimension(),
        began.elapsed().as_secs_f64(),
        results.join(",")
    );
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        println!(
            "{{\"status\":\"FAIL\",\"scope\":\"full-current-cooling-stage\",\"error\":{}}}",
            quote(&e)
        );
        std::process::exit(1)
    }
}

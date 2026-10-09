//! Accepted-time cold control motion joined to the full SOURCE/water/thermal
//! residual. Offline qualification only; no live LD-01 installation.
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
#[path = "cooling_constraints.rs"]
mod cooling_constraints;
#[path = "cooling_convergence.rs"]
mod cooling_convergence;
#[path = "cooling_coordinates.rs"]
mod cooling_coordinates;
#[path = "cooling_energy_preconditioner.rs"]
mod cooling_energy_preconditioner;
#[cfg(test)]
#[path = "../tests/source_cooling.rs"]
mod cooling_fixture;
#[path = "cooling_initial.rs"]
mod cooling_initial;
#[path = "cooling_input/mod.rs"]
mod cooling_input;
#[path = "cooling_mobile.rs"]
mod cooling_mobile;
#[path = "cooling_power.rs"]
mod cooling_power;
#[path = "cooling_trial.rs"]
mod cooling_trial;
#[path = "evolution_input/mod.rs"]
mod evolution_input;
#[path = "control_geometry_input.rs"]
mod geometry_input;
#[path = "../examples/ida_support/mod.rs"]
mod ida_support;
#[path = "motion_support.rs"]
mod motion_support;
#[path = "control_material_accuracy.rs"]
mod control_material_accuracy;
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
use cooling_accuracy::{Sample, OUTPUTS};
use cooling_trial::{recoverable, state_error_scale};
use ida_support::*;
use leitbild_plant_numerics::{
    absorber_motion as am, barrel_thermal, control_motion_forces as cf,
    control_source_geometry as cg, converter_heat, cylindrical_source, dc_supply as dc,
    fuel_history, fuel_source, fuel_thermal, heat_history, moderator_source, operating_admission,
    operating_network, optical_source, passive_source, prhr, source_cooling, source_evolution,
    source_motion as sm, control_material_heat as cm, transport_source, water_carrier,
};
use source_evolution::Evolution;
use std::{
    cell::RefCell,
    ffi::c_int,
    fs,
    io::{self, Read, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    ptr,
    rc::Rc,
    slice,
    time::Instant,
};
const COUNT_ATOL: f64 = 1e-3;
const ENERGY_ATOL: f64 = 1e-12;
const HORIZON: f64 = 300.; // Existing physical compiler validation ceiling, not this case's horizon.
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
        x.iter().map(|&v| finite(v)).collect::<Vec<_>>().join(",")
    )
}
fn ratio(n: f64, d: f64) -> Result<f64, String> {
    if !n.is_finite() || !d.is_finite() || d <= 0. {
        Err("Invalid comparison scale".into())
    } else {
        Ok(n / d)
    }
}
unsafe fn values<'a>(v: Handle, n: usize) -> Result<&'a [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong motion vector".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null motion vector".into());
    }
    Ok(unsafe { slice::from_raw_parts(p, n) })
}
unsafe fn output<'a>(v: Handle, n: usize) -> Result<&'a mut [f64], String> {
    if v.is_null() || unsafe { N_VGetLength_Serial(v) } != n as i64 {
        return Err("Wrong motion output".into());
    }
    let p = unsafe { N_VGetArrayPointer_Serial(v) };
    if p.is_null() {
        return Err("Null motion output".into());
    }
    Ok(unsafe { slice::from_raw_parts_mut(p, n) })
}
#[link(name = "sundials_ida")]
unsafe extern "C" {
    fn IDAWFtolerances(
        mem: Handle,
        f: unsafe extern "C" fn(Handle, Handle, Handle) -> c_int,
    ) -> c_int;
    fn IDASetSuppressAlg(mem: Handle, s: c_int) -> c_int;
    fn IDAReInit(mem: Handle, t: f64, y: Handle, yp: Handle) -> c_int;
    fn IDARootInit(
        mem: Handle,
        n: c_int,
        f: unsafe extern "C" fn(f64, Handle, Handle, *mut f64, Handle) -> c_int,
    ) -> c_int;
    fn IDAGetRootInfo(mem: Handle, roots: *mut c_int) -> c_int;
    fn IDAGetErrWeights(mem: Handle, weights: Handle) -> c_int;
    fn IDAGetEstLocalErrors(mem: Handle, errors: Handle) -> c_int;
    fn IDAGetCurrentCj(mem: Handle, cj: *mut f64) -> c_int;
    fn IDAGetCurrentTime(mem: Handle, time: *mut f64) -> c_int;
}
fn weighted_contributors(values: &[f64], weights: &[f64], differential: impl Fn(usize) -> bool) -> String {
    let mut rows = values.iter().zip(weights).enumerate()
        .filter(|(r,_)| differential(*r))
        .map(|(r,(&value,&weight))| (r,value,weight,(value*weight).abs()))
        .collect::<Vec<_>>();
    let norm = rows.iter().fold(0_f64,|s,q|s.hypot(q.3)) / (values.len() as f64).sqrt();
    rows.sort_unstable_by(|a,b|b.3.total_cmp(&a.3));
    rows.truncate(8);
    format!("{{\"differentialWRMS\":{},\"topRows\":[{}]}}",finite(norm),
        rows.iter().map(|(r,v,w,q)|format!("{{\"row\":{r},\"value\":{},\"weight\":{},\"weightedMagnitude\":{}}}",finite(*v),finite(*w),finite(*q))).collect::<Vec<_>>().join(","))
}
struct Case {
    burst: f64,
    hold: f64,
    position: f64,
    velocity: f64,
    heat: f64,
    relative: f64,
}
impl Case {
    fn horizon(&self) -> f64 {
        self.burst + self.hold
    }
}
struct Prepared {
    model: sm::Model,
    emissions: Vec<[f64; 2]>,
    a: cooling_actuation::Schedule,
    b: dc::Supply,
    holding: f64,
    motive: f64,
    base_b: f64,
    rate: f64,
    case: Case,
}
fn parse(text: &str) -> Result<Prepared, String> {
    let all = text.split_whitespace().collect::<Vec<_>>();
    let mut words = all.iter().copied();
    let fixture = source_input::framed(&mut words);
    let plan = source_input::framed(&mut words);
    let remaining = words.collect::<Vec<_>>();
    let mut reader = geometry_input::Reader::new(&remaining);
    let r = &mut reader;
    let passive = r.many(|r| {
        Ok(passive_source::Intersection {
            stock: r.count()?,
            region: r.count()?,
            volume: r.number()?,
        })
    })?;
    let cylinder = r.many(|r| {
        Ok(cylindrical_source::Intersection {
            target: r.count()?,
            region: r.count()?,
            share: r.number()?,
        })
    })?;
    let lower = r.count()?;
    let upper = r.count()?;
    let bottom = r.number()?;
    let top = r.number()?;
    let guide_radius = r.number()?;
    let body_radius = r.number()?;
    let rodlets = r.count()?.try_into().map_err(|_| "Rodlet count")?;
    let roughness = r.number()?;
    let mouth = r.number()?;
    let bindings = r.many(|r| {
        Ok(cf::Binding {
            cluster: r.count()?,
            cell: r.count()?,
            lower_edge: r.count()?,
            upper_edge: r.count()?,
        })
    })?;
    let cfg = am::Config {
        body_mass_kg: r.number()?,
        stem_mass_kg: r.number()?,
        force_limit_n: r.number()?,
        grip_closed_force_n: r.number()?,
        gap_stroke_m: r.number()?,
        maximum_rate_m_s: r.number()?,
        efficiency: r.number()?,
        joint_capacity_n: r.number()?,
    };
    cfg.validate()?;
    let radius_m = r.number()?;
    let bottom_m = r.number()?;
    let top_m = r.number()?;
    let passages = r.many(|r| {
        Ok(cf::StemPassage {
            outer_radius_m: r.number()?,
            bottom_m: r.number()?,
            top_m: r.number()?,
        })
    })?;
    let bconfig = dc::Config {
        capacity_j: r.number()?,
        normal_group_w: r.number()?,
        charger_limit_w: r.number()?,
        output_limit_w: r.number()?,
        charge_efficiency: r.number()?,
        discharge_efficiency: r.number()?,
        converter_efficiency: r.number()?,
    };
    let energy = r.number()?;
    let paths = dc::Paths {
        charger_available: r.boolean()?,
        battery_available: r.boolean()?,
        output_healthy: r.boolean()?,
    };
    let closed = r.boolean()?;
    let holding = r.number()?;
    let motive = r.number()?;
    let base_b = r.number()?;
    let rate = r.number()?;
    let case = Case {
        burst: r.number()?,
        hold: r.number()?,
        position: r.number()?,
        velocity: r.number()?,
        heat: r.number()?,
        relative: r.number()?,
    };
    if [
        case.burst,
        case.hold,
        case.position,
        case.velocity,
        case.heat,
        case.relative,
    ]
    .iter()
    .any(|v| !v.is_finite() || *v <= 0.)
        || case.horizon() > HORIZON
    {
        return Err("Invalid connected motion case".into());
    }
    let density_steel = r.number()?;
    let mu_steel_1 = r.number()?;
    let mu_water_1 = r.number()?;
    let hosts = r.many(|r| {
        let cluster = r.count()?;
        let kind = match r.count()? { 0 => cm::Kind::Stem, 1 => cm::Kind::Spider,
            _ => return Err("Invalid control steel host kind".into()) };
        Ok(cm::Host { cluster, kind,
            targets: [r.count()?,r.count()?,r.count()?,r.count()?],
            capture_photon_j: [r.number()?,r.number()?,r.number()?,r.number()?],
            mn_owner:r.count()?,volume_m3:r.number()?,self_chord_m:r.number()? })
    })?;
    let routes = r.many(|r| Ok(cm::Route {
        host:r.count()?,source_region:r.count()?,water:r.count()?,origin:r.count()?,
        lo:r.number()?,hi:r.number()?,spans:r.many(|r| Ok(cg::Span {lo:r.number()?,hi:r.number()?,area:r.number()?}))?
    }))?;
    reader.end()?;
    let p = cooling_input::parse_with_source_incidence(&fixture.join(" "), &passive, &cylinder)?;
    let a = cooling_actuation::Schedule::new(&p.model, p.prhr_action, p.actuation.as_ref())?
        .ok_or("Missing ACT.A/PRHR")?;
    let ginput = geometry_input::parse(&plan)?;
    let n = ginput.clusters;
    let geometry =
        cg::Prepared::new(ginput, p.model.source.prepared_geometry()).map_err(str::to_string)?;
    let hydraulic = cf::Plan {
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
        stems: vec![
            cf::Stem {
                radius_m,
                bottom_m,
                top_m,
                passages
            };
            n
        ],
    };
    let material = cm::Model::new(&p.model.source,&geometry,p.model.network.config().water.len(),
        cm::Input {density_steel,mu_steel_1,mu_water_1,hosts,routes})?;
    let model = sm::Model::new(p.model, geometry, hydraulic, vec![cfg; n], material)?;
    let b = dc::Supply::new(bconfig, energy, paths, closed, base_b + motive)?;
    Ok(Prepared {
        model,
        emissions: p.target_emissions,
        a,
        b,
        holding,
        motive,
        base_b,
        rate,
        case,
    })
}
struct Callbacks<'a> {
    ida: Handle,
    model: &'a sm::Model,
    work: sm::Workspace,
    root_work: sm::RootWorkspace,
    p: cooling_block::Preconditioner,
    mp: sm::MechanicalPreconditioner,
    convergence: cooling_convergence::Convergence<'a>,
    energy: cooling_coordinates::EnergyCoordinates,
    coordinates: source_coordinates::Coordinates,
    ep: cooling_energy_preconditioner::EnergyRow,
    state: Vec<f64>,
    slopes: Vec<f64>,
    direction: Vec<f64>,
    rhs: Vec<f64>,
    absolute: Vec<f64>,
    relative: f64,
    power: cooling_power::PowerWeights,
    power_work: cooling_power::PowerWorkspace,
    barrel: cooling_power::BarrelWeights,
    capture: cooling_power::CaptureWeights,
    resolution: f64,
    support: Rc<RefCell<motion_support::Support>>,
    mode: Rc<RefCell<sm::Mode>>,
    start: Instant,
    allowance: f64,
    fatal: Option<String>,
    calls: [u64; 4],
    seconds: [f64; 4],
    root_calls: u64,
    root_seconds: f64,
    root_properties: u64,
    weights_seconds: f64,
    psolve_seconds: f64,
    audit_seconds: f64,
    observation_seconds: f64,
    retention_seconds: f64,
    audit_pool: leitbild_plant_numerics::cold_pressurizer::Workspace,
    audit_line: leitbild_plant_numerics::finite_surge::Workspace,
}
impl Callbacks<'_> {
    fn decode(&self, x: &[f64], rate: bool) -> Vec<f64> {
        let mut y = vec![0.; x.len()];
        self.coordinates.physical(x, &mut y);
        if rate {
            self.energy.vector_to_physical(&mut y)
        } else {
            self.energy.state_to_physical(&mut y)
        }
        self.model.mechanical_to_physical(&mut y);
        y
    }
    fn encode(&self, x: &mut [f64], rate: bool) {
        self.model.mechanical_to_solver(x);
        self.coordinates.transform(x);
        if rate {
            self.energy.vector_to_solver(x)
        } else {
            self.energy.state_to_solver(x)
        }
    }
    fn evaluate(&mut self, t: f64, y: Handle, yp: Handle, cj: Option<f64>) -> Result<(), String> {
        self.coordinates.physical(
            unsafe { values(y, self.model.dimension()) }?,
            &mut self.state,
        );
        self.energy.state_to_physical(&mut self.state);
        self.model.mechanical_to_physical(&mut self.state);
        self.coordinates.physical(
            unsafe { values(yp, self.model.dimension()) }?,
            &mut self.slopes,
        );
        self.energy.vector_to_physical(&mut self.slopes);
        self.model.mechanical_to_physical(&mut self.slopes);
        let input = self
            .support
            .borrow()
            .prhr_input(t, self.state[self.support.borrow().a.room_row])?;
        self.model.evaluate(
            &self.state,
            &self.slopes,
            cj,
            &mut self.work,
            Some(input),
            &self.mode.borrow(),
        )
    }
    fn metrics(&self) -> String {
        format!(
            "{{\"residuals\":{},\"bases\":{},\"actions\":{},\"recoverable\":{},\"fullEvaluations\":{},\"reusedEvaluations\":{},\"residualSeconds\":{},\"baseSeconds\":{},\"actionSeconds\":{},\"PSeconds\":{},\"rootCalls\":{},\"rootSeconds\":{},\"rootPropertyRequests\":{},\"weightsSeconds\":{},\"PSolveSeconds\":{},\"auditSeconds\":{},\"observationSeconds\":{},\"retentionSeconds\":{},\"timingScope\":\"nonoverlapping-callback-audit-observation-retention;P-and-convergence-internals-nested\",\"convergence\":{},\"P\":{}}}",
            self.calls[0],
            self.calls[1],
            self.calls[2],
            self.calls[3],
            self.work.full_evaluations,
            self.work.reused_evaluations,
            self.seconds[0],
            self.seconds[1],
            self.seconds[2],
            self.seconds[3],
            self.root_calls,
            self.root_seconds,
            self.root_properties,
            self.weights_seconds,
            self.psolve_seconds,
            self.audit_seconds,
            self.observation_seconds,
            self.retention_seconds,
            self.convergence.json(),
            self.p.metrics_json()
        )
    }
}
fn callback(user: Handle, f: impl FnOnce(&mut Callbacks<'_>) -> Result<(), String>) -> c_int {
    if user.is_null() {
        return -1;
    }
    let c = unsafe { &mut *(user as *mut Callbacks<'_>) };
    match catch_unwind(AssertUnwindSafe(|| {
        if c.start.elapsed().as_secs_f64() > c.allowance {
            return Err("Aggregate motion/cooling allowance exhausted".into());
        }
        f(c)
    })) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) if recoverable(&e) => {
            c.calls[3] += 1;
            1
        }
        Ok(Err(e)) => {
            c.fatal = Some(e);
            -1
        }
        Err(_) => {
            c.fatal = Some("Contained motion callback panic".into());
            -1
        }
    }
}
unsafe extern "C" fn residual(t: f64, y: Handle, yp: Handle, r: Handle, u: Handle) -> c_int {
    callback(u, |c| {
        let started = Instant::now();
        c.calls[0] += 1;
        let mut cj = 0.;
        checked(unsafe { IDAGetCurrentCj(c.ida, &mut cj) }, "Current residual linearization coefficient")?;
        // Prepare the actual current shift once. A matching J-times setup can
        // then consume this exact owned stage, without another full RHS pass.
        c.evaluate(t, y, yp, Some(cj))?;
        let n = c.model.dimension();
        let z = unsafe { output(r, n) }?;
        z.copy_from_slice(&c.work.residual);
        c.model.mechanical_to_solver(z);
        c.coordinates.transform(z);
        let rates = c.work.cooling.source.rates()?;
        z[c.coordinates.ledger] = unsafe { values(yp, n) }?[c.coordinates.ledger]
            - (rates[..c.coordinates.nc].iter().sum::<f64>() - rates[c.coordinates.ledger]);
        // This chart closes only prefix thermal energy + independently integrated
        // fluid work. Mechanical KE is nonlinear and audited independently.
        z[c.energy.row] =
            unsafe { values(yp, n) }?[c.energy.row] - c.work.thermal_work_energy_rate()?;
        c.seconds[0] += started.elapsed().as_secs_f64();
        Ok(())
    })
}
unsafe extern "C" fn jtsetup(
    t: f64,
    y: Handle,
    yp: Handle,
    _: Handle,
    cj: f64,
    u: Handle,
) -> c_int {
    callback(u, |c| {
        let started = Instant::now();
        c.calls[1] += 1;
        let result = c.evaluate(t, y, yp, Some(cj));
        c.seconds[1] += started.elapsed().as_secs_f64();
        result
    })
}
unsafe extern "C" fn jtimes(
    _: f64,
    _: Handle,
    _: Handle,
    _: Handle,
    v: Handle,
    jv: Handle,
    cj: f64,
    u: Handle,
    _: Handle,
    _: Handle,
) -> c_int {
    callback(u, |c| {
        let started = Instant::now();
        c.calls[2] += 1;
        let n = c.model.dimension();
        let raw = unsafe { values(v, n) }?;
        c.coordinates.physical(raw, &mut c.direction);
        c.energy.vector_to_physical(&mut c.direction);
        c.model.mechanical_to_physical(&mut c.direction);
        c.model.jvp(&c.direction, cj, &mut c.work)?;
        let z = unsafe { output(jv, n) }?;
        z.copy_from_slice(&c.work.jvp);
        c.model.mechanical_to_solver(z);
        c.coordinates.transform(z);
        let tangent = c.work.cooling.source.rate_jvp()?;
        z[c.coordinates.ledger] = cj * raw[c.coordinates.ledger]
            - (tangent[..c.coordinates.nc].iter().sum::<f64>() - tangent[c.coordinates.ledger]);
        // Complete wrapper balance equals thermal balance + mechanical balance.
        // Recover the desired affine-rate tangent without a cancellation cj*dE.
        z[c.energy.row] = cj * raw[c.energy.row] - c.work.thermal_work_energy_rate_jvp()?;
        c.seconds[2] += started.elapsed().as_secs_f64();
        Ok(())
    })
}
fn physical_p(c: &mut Callbacks<'_>, rhs: &[f64], out: &mut [f64]) -> Result<(), String> {
    let end = c.model.layout.cooling_end;
    c.p.solve(&c.model.cooling, &rhs[..end], &mut out[..end])?;
    c.mp.solve_solver(&rhs[end..], &mut out[end..])
}
unsafe extern "C" fn psetup(t: f64, y: Handle, yp: Handle, _: Handle, cj: f64, u: Handle) -> c_int {
    callback(u, |c| {
        let started = Instant::now();
        c.ep.invalidate();
        c.evaluate(t, y, yp, Some(cj))?;
        c.p.setup_prepared(&c.model.cooling, &mut c.work.cooling, cj)?;
        c.mp.setup(c.model, &c.work, cj)?;
        let mut rhs = std::mem::take(&mut c.rhs);
        rhs.fill(0.);
        rhs[c.energy.row] = 1.;
        c.energy.vector_to_physical(&mut rhs);
        let mut out = std::mem::take(&mut c.direction);
        let solved = physical_p(c, &rhs, &mut out);
        c.rhs = rhs;
        solved?;
        c.energy.vector_to_solver(&mut out);
        let prepared = c.ep.prepare(cj, &out);
        c.direction = out;
        prepared?;
        c.seconds[3] += started.elapsed().as_secs_f64();
        Ok(())
    })
}
unsafe extern "C" fn psolve(
    _: f64,
    _: Handle,
    _: Handle,
    _: Handle,
    r: Handle,
    z: Handle,
    _: f64,
    _: f64,
    u: Handle,
) -> c_int {
    callback(u, |c| {
        let began = Instant::now();
        let n = c.model.dimension();
        let raw = unsafe { values(r, n) }?;
        let g = raw[c.energy.row];
        let mut rhs = std::mem::take(&mut c.rhs);
        rhs.copy_from_slice(raw);
        c.energy.vector_to_physical(&mut rhs);
        let out = unsafe { output(z, n) }?;
        let solved = physical_p(c, &rhs, out);
        c.rhs = rhs;
        solved?;
        c.energy.vector_to_solver(out);
        let applied = c.ep.apply(g, out);
        c.psolve_seconds += began.elapsed().as_secs_f64();
        applied
    })
}
unsafe extern "C" fn weights(y: Handle, w: Handle, u: Handle) -> c_int {
    callback(u, |c| {
        let began = Instant::now();
        let n = c.model.dimension();
        let raw = unsafe { values(y, n) }?;
        let out = unsafe { output(w, n) }?;
        for i in 0..n {
            out[i] = if i < c.model.layout.cooling_end {
                state_error_scale(&c.model.cooling, i, raw[i], c.absolute[i], c.relative)
            } else {
                c.absolute[i]
            };
        }
        c.power.cap(
            &raw[..c.model.cooling.source.history_dimension()],
            c.relative,
            c.resolution,
            out,
            &mut c.power_work,
        )?;
        c.barrel.cap(
            &raw[..c.model.cooling.layout.source_end],
            c.relative,
            c.resolution,
            out,
        )?;
        c.capture.cap(
            &raw[..c.model.layout.cooling_end],
            c.relative,
            c.resolution,
            &mut out[..c.model.layout.cooling_end],
        )?;
        for v in out {
            if !v.is_finite() || *v <= 0. {
                return Err("Invalid moving error weight".into());
            }
            *v = 1. / *v;
        }
        c.weights_seconds += began.elapsed().as_secs_f64();
        Ok(())
    })
}
unsafe extern "C" fn roots(t: f64, y: Handle, yp: Handle, g: *mut f64, u: Handle) -> c_int {
    callback(u, |c| {
        let began = Instant::now();
        c.root_calls += 1;
        if g.is_null() {
            return Err("Null moving root vector".into());
        }
        c.coordinates
            .physical(unsafe { values(y, c.model.dimension()) }?, &mut c.state);
        c.energy.state_to_physical(&mut c.state);
        c.model.mechanical_to_physical(&mut c.state);
        c.coordinates
            .physical(unsafe { values(yp, c.model.dimension()) }?, &mut c.slopes);
        c.energy.vector_to_physical(&mut c.slopes);
        c.model.mechanical_to_physical(&mut c.slopes);
        let pi = c
            .support
            .borrow()
            .prhr_input(t, c.state[c.support.borrow().a.room_row])?;
        let result = c.model.roots_at(
            &c.state,
            &c.slopes,
            Some(pi),
            &c.mode.borrow(),
            &mut c.root_work,
            unsafe { slice::from_raw_parts_mut(g, c.model.root_count()) },
        );
        c.root_properties += c.root_work.network.property_requests as u64;
        c.root_seconds += began.elapsed().as_secs_f64();
        result
    })
}
fn sample(
    model: &source_cooling::Model,
    y: &[f64],
    w: &source_cooling::Workspace,
    t: f64,
) -> Result<Sample, String> {
    let q = w.surge.receipts()?;
    Ok(Sample {
        time: t,
        y: y.to_vec(),
        source_d: w.source.diagnostics()?,
        source_captures: cooling_accuracy::captured_targets(model, y)?,
        source_nc: cooling_accuracy::nc_coefficients(model, &w.source)?,
        deposition: w.source.fuel_deposition()?.to_vec(),
        water_mass: w.network.chart_mass.clone(),
        barrel_power: cooling_accuracy::barrel_powers(w)?,
        capture_power: w.capture.power_channels()?.to_vec(),
        mobile_power: w.mobile_capture.value()?.channels.clone(),
        mobile_recipient_power: w.mobile_capture.value()?.recipient_power().collect(),
        bundle_power: cooling_bundle::powers(w),
        surge_flow: [q.mass[0], -q.mass[1]],
    })
}
fn retain(path: &Path, time: f64, y: &[f64], yp: &[f64]) -> Result<(), String> {
    let pending = PathBuf::from(format!("{}.pending", path.display()));
    let f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    let mut f = io::BufWriter::new(f);
    f.write_all(&time.to_le_bytes())
        .map_err(|e| e.to_string())?;
    for &v in y.iter().chain(yp) {
        f.write_all(&v.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    f.flush().map_err(|e| e.to_string())?;
    f.get_ref().sync_all().map_err(|e| e.to_string())?;
    drop(f);
    let published = fs::hard_link(&pending, path).map_err(|e| e.to_string());
    let cleanup = fs::remove_file(&pending).map_err(|e| e.to_string());
    published.and(cleanup)
}
fn retain_mode(path: &Path, mode: &sm::Mode) -> Result<(), String> {
    let body = mode.snapshot_words()?;
    if sm::Mode::restore_words(&body)? != *mode {
        return Err("Mechanical mode round trip differs".into());
    }
    let target = PathBuf::from(format!("{}.mode.txt", path.display()));
    let pending = PathBuf::from(format!("{}.pending", target.display()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    let published = fs::hard_link(&pending, &target).map_err(|e| e.to_string());
    let cleanup = fs::remove_file(&pending).map_err(|e| e.to_string());
    published.and(cleanup)
}
struct Arm {
    samples: Vec<Sample>,
    motion: Vec<Vec<f64>>,
    material: Vec<control_material_accuracy::Sample>,
    final_y: Vec<f64>,
    summary: String,
}
fn audit(
    c: &mut Callbacks<'_>,
    accuracy: &cooling_accuracy::Accuracy,
    time: f64,
    y: &[f64],
    yp: &[f64],
    initial_mechanical: f64,
    adjustment: f64,
    initial_balance: f64,
    initial: &[f64],
    flow: &[f64],
) -> Result<(f64, f64), String> {
    let began = Instant::now();
    let m = c.model;
    let b = &m.cooling;
    let end = m.layout.cooling_end;
    let l = b.layout;
    let input = c
        .support
        .borrow()
        .prhr_input(time, y[c.support.borrow().a.room_row])?;
    m.evaluate(y, yp, None, &mut c.work, Some(input), &c.mode.borrow())?;
    m.validate_accepted(y, &c.work)?;
    accuracy.carrier_ledger(b, &y[..end])?;
    accuracy.prhr_ledgers(b, &y[..end])?;
    cooling_accuracy::admit_source(b, &y[..end], &c.work.cooling.source, time)?;
    c.support.borrow().audit(time, y)?;
    let mut expected = accuracy.expected_network_totals(b, &y[..end])?;
    // This moving composition transfers energy across the cooling boundary.
    // Its fresh signed receipt starts at zero: positive work is water→mechanics.
    // The generic fixed-boundary cooling expectation must not know this owner.
    expected[1] -= y[m.layout.fluid_mechanical_work];
    expected[1] += m.control_material.paid_rows().map(|(row,q)| q*(y[row]-initial[row])).sum::<f64>()
        - (y[m.layout.nuclear_to_apparatus]-initial[m.layout.nuclear_to_apparatus])
        - (y[m.layout.control_photon_export]-initial[m.layout.control_photon_export]);
    operating_admission::screen(
        &b.network,
        &c.work.cooling.network,
        &y[l.network_start..l.carrier_start],
        expected,
        flow,
    )?;
    for (r, cp) in c.work.cooling.thermal.capacities()?.iter().enumerate() {
        if c.work.residual[l.temperatures_start + r].abs() / cp > 1e-4 {
            return Err("Moving thermal caloric chart".into());
        }
    }
    for (r, cp) in c.work.cooling.absorber_guide.capacity.iter().enumerate() {
        if c.work.residual[l.absorber_guide_temperatures_start + r].abs() / cp > 1e-4 {
            return Err("Moving BODY/guide caloric chart".into());
        }
    }
    if c.work.residual[l.barrel_temperature].abs() / c.work.cooling.barrel.capacity()? > 1e-4 {
        return Err("Moving barrel caloric chart".into());
    }
    // Dedicated admission workspaces, never a previously prepared solver stage.
    // The correction call overwrites their current trial, so allocation has no
    // physical or validity role and need not recur at every accepted step.
    let (p, s) = b.pressure_chart_corrections(
        &c.work.cooling.network,
        &y[..end],
        &yp[..end],
        &mut c.audit_pool,
        &mut c.audit_line,
    )?;
    cooling_accuracy::check_pressure_chart(
        b,
        &p,
        &s,
        cooling_accuracy::pressure_level_head_scale(b, &y[..end], &c.audit_pool)?,
    )?;
    if cooling_convergence::pressure_caloric_ratio(b, &y[..end], &c.audit_pool, &c.audit_line)? > 1.
        || cooling_convergence::pressure_flow_ratio(b, &c.audit_line)? > 1.
    {
        return Err("Moving pressure caloric/flow closure".into());
    }
    let mech = m.mechanical_energy_j(y)? + m.apparatus_heat_j(y)?
        - initial_mechanical
        - y[m.layout.fluid_mechanical_work]
        - (y[m.layout.nuclear_to_apparatus]-initial[m.layout.nuclear_to_apparatus])
        - c.support.borrow().holding_j(time)?
        - c.support.borrow().motive_j(time)?
        - adjustment;
    let mechanical_bound = m.clusters() as f64 * 1e-5
        + 128.
            * f64::EPSILON
            * (m.mechanical_energy_j(y)?.abs()
                + m.apparatus_heat_j(y)?.abs()
                + initial_mechanical.abs()
                + y[m.layout.fluid_mechanical_work].abs()
                + (y[m.layout.nuclear_to_apparatus]-initial[m.layout.nuclear_to_apparatus]).abs()
                + c.support.borrow().holding_j(time)?
                + c.support.borrow().motive_j(time)?
                + adjustment.abs());
    if mech.abs() > mechanical_bound {
        return Err(format!(
            "Independent moving mechanical work/heat defect {mech:e} J bound{mechanical_bound:e}"
        ));
    }
    let mut balance = y.to_vec();
    c.energy.state_to_solver(&mut balance);
    let energy = (balance[c.energy.row] - initial_balance).abs();
    if energy > 1. {
        return Err(format!(
            "Independent prefix thermal+fluid-work balance defect {energy:e} J"
        ));
    }
    c.audit_seconds += began.elapsed().as_secs_f64();
    Ok((mech.abs(), energy))
}
fn check_root_workspace(
    model: &sm::Model,
    y: &[f64],
    yp: &[f64],
    work: &mut sm::Workspace,
    input: prhr::Input,
    mode: &sm::Mode,
) -> Result<(), String> {
    // Own the exact linearization being tested. Admission/value-only evaluation
    // intentionally invalidates cj; never borrow a preceding solver stage.
    model.evaluate(y, yp, Some(1.), work, Some(input), mode)?;
    let mut direction = vec![0.; model.dimension()];
    let base = &model.cooling;
    direction[base.layout.network_start + base.network.pressure_row()] = 17.;
    for k in 0..base.network.config().water.len() {
        direction[base.layout.network_start + base.network.temperature_row(k)] =
            0.001 * ((k + 1) as f64).sin();
    }
    for k in 0..model.clusters() {
        let position = 0.001 * ((k + 1) as f64).sin();
        let velocity = 0.001 * ((k + 1) as f64).cos();
        for field in [sm::BODY_Y, sm::STEM_Y] {
            direction[model.motion_row(k, field)] = position;
        }
        for field in [sm::BODY_V, sm::STEM_V] {
            direction[model.motion_row(k, field)] = velocity;
        }
    }
    model.jvp(&direction, 1., work)?;
    let before = work.jvp.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
    let before_energy = work.thermal_work_energy_rate_jvp()?.to_bits();
    let mut full = vec![0.; model.root_count()];
    model.roots(y, work, &mut full)?;
    let mut light = vec![0.; model.root_count()];
    let mut root_work = model.root_workspace();
    model.roots_at(y, yp, Some(input), mode, &mut root_work, &mut light)?;
    for (row, (a, b)) in full.iter().zip(&light).enumerate() {
        if a.to_bits() != b.to_bits() {
            return Err(format!(
                "Current full/light root {row} differs: {a:e} vs {b:e}"
            ));
        }
    }
    model.jvp(&direction, 1., work)?;
    if let Some(row) = work
        .jvp
        .iter()
        .zip(before)
        .position(|(v, bits)| v.to_bits() != bits)
    {
        return Err(format!(
            "Lightweight roots changed prepared full JVP row {row}"
        ));
    }
    if work.thermal_work_energy_rate_jvp()?.to_bits() != before_energy {
        return Err("Lightweight roots changed prepared affine energy tangent".into());
    }
    Ok(())
}
fn run(
    p: &Prepared,
    accuracy: &cooling_accuracy::Accuracy,
    refinement: f64,
    start: Instant,
    allowance: f64,
    dir: &Path,
    reference: Option<&Arm>,
) -> Result<Arm, String> {
    let m = &p.model;
    let b = &m.cooling;
    let end = m.layout.cooling_end;
    let n = m.dimension();
    let begin = Instant::now();
    let support = Rc::new(RefCell::new(motion_support::Support::new(
        p.a.clone(),
        p.b.clone(),
        p.holding,
        p.motive,
        p.base_b,
        p.rate,
        p.case.burst,
    )?));
    let mode = Rc::new(RefCell::new(sm::Mode::new(
        support.borrow().motion_input(0.)?,
        m.clusters(),
    )?));
    let initial_input = support.borrow().prhr_input(0., 0.)?;
    let mut y = m.initial_state(Some(initial_input))?;
    let mut yp = vec![0.; n];
    let mut w = m.workspace();
    let input = support
        .borrow()
        .prhr_input(0., y[support.borrow().a.room_row])?;
    m.evaluate(&y, &yp, Some(0.), &mut w, Some(input), &mode.borrow())?;
    let mut absolute = accuracy.absolute(refinement)?;
    let network_weights = operating_admission::weights(
        &b.network,
        &w.cooling.network,
        &y[b.layout.network_start..b.layout.carrier_start],
        300.,
        refinement,
    )?;
    absolute[b.layout.network_start..b.layout.carrier_start]
        .copy_from_slice(&network_weights.absolute);
    let mut timework = m.workspace();
    m.evaluate(
        &y,
        &yp,
        Some(0.),
        &mut timework,
        Some(input),
        &mode.borrow(),
    )?;
    m.prepare_time_direction(&mut timework)?;
    let moving = cooling_initial::Moving {
        value: timework.current_geometry(),
        time: timework.geometry_direction(),
    };
    let init = cooling_initial::initialize_with_geometry(
        b,
        &mut y[..end],
        &mut yp[..end],
        &absolute,
        &mut w.cooling,
        start,
        allowance,
        1e-5 / refinement,
        &mut cooling_initial::Trace::default(),
        Some(input),
        &moving,
    )?;
    m.evaluate(&y, &yp, Some(1.), &mut w, Some(input), &mode.borrow())?;
    m.set_mechanical_rates(&y, &mut yp, &w)?;
    let initial_mechanical = m.mechanical_energy_j(&y)? + m.apparatus_heat_j(&y)?;
    let mut energy = cooling_coordinates::EnergyCoordinates::new(b, &y[..end])?;
    energy.add_receipt(
        m.layout.fluid_mechanical_work,
        1.,
        y[m.layout.fluid_mechanical_work],
    )?;
    for row in [m.layout.nuclear_to_apparatus,m.layout.control_photon_export] {
        energy.add_receipt(row,1.,y[row])?;
    }
    for (row,q) in m.control_material.paid_rows() {
        energy.add_receipt(row,-q,y[row])?;
    }
    absolute.resize(n, 0.);
    for k in 0..m.clusters() {
        for field in 0..sm::WIDTH {
            absolute[m.motion_row(k, field)] = match field {
                sm::BODY_Y | sm::STEM_Y | sm::REFERENCE_Y => p.case.position,
                sm::BODY_V | sm::STEM_V => p.case.velocity,
                _ => p.case.heat,
            } / refinement;
        }
    }
    absolute[m.layout.fluid_mechanical_work] = p.case.heat / refinement;
    for row in [m.layout.nuclear_to_apparatus,m.layout.control_photon_export] {
        absolute[row] = control_material_accuracy::RESOLUTION / refinement;
    }
    absolute[energy.row] = cooling_coordinates::EnergyCoordinates::absolute(n, refinement);
    let mut convergence = cooling_convergence::Convergence::new(b, Some(input))?;
    convergence.seat_flow_allocation(&absolute[..end])?;
    convergence.budget(start, allowance);
    let modes = mode.clone();
    let supplies = support.clone();
    let mut candidate = m.workspace();
    convergence.current_candidate_preparer(n, energy.clone(), move |t, yy, yypp, network| {
        let mut physical = yy.to_vec();
        let mut rates = yypp.to_vec();
        m.mechanical_to_physical(&mut physical);
        m.mechanical_to_physical(&mut rates);
        m.prepare_geometry(&physical, None, &mut candidate, &modes.borrow())?;
        let l = b.layout;
        let pi = supplies
            .borrow()
            .prhr_input(t, physical[supplies.borrow().a.room_row])?;
        network.evaluate_with_motion(
            &b.network,
            &physical[l.network_start..l.carrier_start],
            &rates[l.network_start..l.carrier_start],
            None,
            &[],
            Some(pi),
            Some(operating_network::MotionGeometry {
                water: &candidate.water,
                connections: &candidate.connections,
            }),
        )
    })?;
    let power = cooling_power::PowerWeights::new(&b.source)?;
    let power_work = power.workspace();
    let pw = cooling_block::Preconditioner::new_prepared(
        b,
        std::mem::replace(&mut w.cooling, b.workspace()),
    )?;
    m.evaluate(&y, &yp, Some(1.), &mut w, Some(input), &mode.borrow())?;
    let mut c = Box::new(Callbacks {
        ida: ptr::null_mut(),
        model: m,
        work: w,
        root_work: m.root_workspace(),
        p: pw,
        mp: sm::MechanicalPreconditioner::new(m),
        convergence,
        energy,
        coordinates: source_coordinates::Coordinates {
            nc: b.source.nc_dimension(),
            ledger: b.source.ledger_row(),
        },
        ep: cooling_energy_preconditioner::EnergyRow::new(n, 0)?,
        state: vec![0.; n],
        slopes: vec![0.; n],
        direction: vec![0.; n],
        rhs: vec![0.; n],
        absolute,
        relative: 1e-5 / refinement,
        power,
        power_work,
        barrel: cooling_power::BarrelWeights::new(
            &b.source,
            b.barrel.config().targets,
            b.barrel.config().capture_photon_j,
        )?,
        capture: cooling_power::CaptureWeights::new(b)?,
        resolution: cooling_accuracy::DEPOSIT_RESOLUTION_W / refinement,
        support,
        mode,
        start,
        allowance,
        fatal: None,
        calls: [0; 4],
        seconds: [0.; 4],
        root_calls: 0,
        root_seconds: 0.,
        root_properties: 0,
        weights_seconds: 0.,
        psolve_seconds: 0.,
        audit_seconds: 0.,
        observation_seconds: 0.,
        retention_seconds: 0.,
        audit_pool: b.pressure_connection().pressurizer.workspace(),
        audit_line: b.pressure_connection().surge.workspace(),
    });
    c.ep = cooling_energy_preconditioner::EnergyRow::new(n, c.energy.row)?;
    let initial_physical = y.clone();
    let initial_balance = {
        let mut z = y.clone();
        c.energy.state_to_solver(&mut z);
        z[c.energy.row]
    };
    c.encode(&mut y, false);
    c.encode(&mut yp, true);
    let mut owned = Resources::new()?;
    let yy = owned.vector(&y)?;
    let yypp = owned.vector(&yp)?;
    // Separate public solver diagnostics. Never reuse state, rate or stage
    // buffers for an error-estimate query.
    let diagnostic_weights = owned.vector(&vec![0.; n])?;
    let diagnostic_errors = owned.vector(&vec![0.; n])?;
    let ids = owned.vector(
        &(0..n)
            .map(|r| f64::from(m.is_differential(r)))
            .collect::<Vec<_>>(),
    )?;
    let mut cs = cooling_constraints::physical_constraints(b, c.energy.row);
    cs.resize(n, 0.);
    for k in 0..m.clusters() {
        // BODY_Y is the relative gap in solver coordinates. It must bracket
        // contact with signed trials; only the owned root transaction may
        // apply the physical impulse. Accepted gaps remain nonnegative.
        cs[m.motion_row(k, sm::BODY_Y)] = 0.;
        cs[m.motion_row(k, sm::STEM_Y)] = 1.;
        for f in sm::JACK_HEAT..sm::WIDTH {
            cs[m.motion_row(k, f)] = 1.;
        }
    }
    for row in [m.layout.nuclear_to_apparatus, m.layout.control_photon_export] {
        cs[row] = 1.;
    }
    let cs = owned.vector(&cs)?;
    owned.spgmr(yy, 30, 0)?;
    owned.ida = unsafe { IDACreate(owned.context) };
    if owned.ida.is_null() {
        return Err("Null moving IDA".into());
    }
    c.ida = owned.ida;
    checked(
        unsafe { IDAInit(owned.ida, residual, 0., yy, yypp) },
        "Moving IDA init",
    )?;
    checked(
        unsafe { IDASetUserData(owned.ida, (&mut *c as *mut Callbacks<'_>).cast()) },
        "Moving callback owner",
    )?;
    checked(
        unsafe { IDASetId(owned.ida, ids) },
        "Moving differential ids",
    )?;
    checked(
        unsafe { IDASetSuppressAlg(owned.ida, 1) },
        "Moving differential temporal control",
    )?;
    checked(
        unsafe { IDAWFtolerances(owned.ida, weights) },
        "Moving physical/power scales",
    )?;
    checked(
        unsafe { IDASetConstraints(owned.ida, cs) },
        "Moving independent constraints",
    )?;
    checked(
        unsafe { IDASetLinearSolver(owned.ida, owned.solver, ptr::null_mut()) },
        "Moving SPGMR",
    )?;
    checked(
        unsafe { IDASetJacTimes(owned.ida, Some(jtsetup), jtimes) },
        "Moving analytic JVP",
    )?;
    checked(
        unsafe { IDASetPreconditioner(owned.ida, psetup, psolve) },
        "Moving current component P",
    )?;
    checked(
        unsafe { IDASetEpsLin(owned.ida, cooling_convergence::EPS_LIN) },
        "Moving linear coefficient",
    )?;
    checked(
        unsafe { IDASetNonlinConvCoef(owned.ida, cooling_convergence::NONLINEAR_COEFFICIENT) },
        "Moving nonlinear coefficient",
    )?;
    checked(
        unsafe { IDASetLSNormFactor(owned.ida, 1.) },
        "Moving dimension independent linear norm",
    )?;
    let nonlinear = owned.newton(yy)?;
    checked(
        unsafe { IDASetNonlinearSolver(owned.ida, nonlinear) },
        "Moving Newton",
    )?;
    c.convergence.install(owned.ida, nonlinear)?;
    checked(
        unsafe { IDARootInit(owned.ida, m.root_count() as c_int, roots) },
        "Moving native event roots",
    )?;
    let horizon = p.case.horizon();
    let outputs = [
        0.,
        0.00001,
        0.0001,
        0.001,
        0.01,
        0.1,
        0.25,
        p.case.burst,
        0.75,
        1.,
        2.,
        5.,
        10.,
        30.,
        horizon,
    ];
    let mut samples = Vec::new();
    let mut motions = Vec::new();
    let mut material_samples = Vec::new();
    let mut material_comparisons = Vec::new();
    let mut chord_sensitivity = String::from("null");
    let mut structural_temperatures = String::from("null");
    let mut comparisons = Vec::new();
    let mut motion_comparisons = Vec::new();
    let mut events = Vec::new();
    let mut event_snapshots = Vec::new();
    let mut performance_planes = Vec::new();
    let mut time = 0.;
    let mut last_admitted = 0.;
    let mut initial_admitted = false;
    let mut steps: u64 = 0;
    let mut root_adjustment = 0.;
    let mut ics = 0;
    let mut ic_seconds = 0.;
    let mut startup_ic_seconds = 0.;
    let mut initial_weighted_rates = String::from("null");
    let mut max_mech = 0_f64;
    let mut max_energy = 0_f64;
    let mut admitted_y = initial_physical.clone();
    let mut admitted_yp = c.decode(&yp, true);
    let mut admitted_support = c.support.borrow().clone();
    let mut admitted_mode = c.mode.borrow().clone();
    let mut next_output = 0;
    let mut last_checkpoint = Instant::now();
    let result = (|| -> Result<(), String> {
        // The prefix initializer is only a warm guess: the complete residual
        // now includes structural nuclear delivery. Solve all algebraic states
        // and differential rates once, without advancing any physical stock.
        let fixed = unsafe { values(yy, n) }?.to_vec();
        let began = Instant::now();
        let status = unsafe { IDACalcIC(owned.ida, 1, outputs[1]) };
        startup_ic_seconds = began.elapsed().as_secs_f64();
        checked(status, "Actual whole-composition startup IC")?;
        checked(
            unsafe { IDAGetConsistentIC(owned.ida, yy, yypp) },
            "Actual whole-composition startup IC vectors",
        )?;
        startup_ic_seconds = began.elapsed().as_secs_f64();
        if let Some(e) = c.fatal.clone().or(c.convergence.fatal.clone()) {
            return Err(e);
        }
        let actual = unsafe { values(yy, n) }?;
        if (0..n).any(|r| m.is_differential(r)
            && fixed[r].to_bits() != actual[r].to_bits()) {
            return Err("Startup IC changed differential stocks".into());
        }
        admitted_y = c.decode(unsafe { values(yy, n) }?, false);
        admitted_yp = c.decode(unsafe { values(yypp, n) }?, true);
        if (0..n).any(|r| m.is_differential(r)
            && admitted_y[r].to_bits() != initial_physical[r].to_bits()) {
            return Err("Startup IC changed decoded physical stocks".into());
        }
        audit(&mut c, accuracy, 0., &admitted_y, &admitted_yp,
            initial_mechanical, 0., initial_balance, &initial_physical,
            &network_weights.flow)?;
        // YA_YDP_INIT solves differential rates, not auxiliary algebraic
        // derivatives. Governing continuity derives its pressure rate from
        // actual mass/energy rates; algebraic yp is not a new chart-rate proof.
        check_root_workspace(m, &admitted_y, &admitted_yp, &mut c.work,
            input, &c.mode.borrow())?;
        initial_admitted = true;
        checked(unsafe { weights(yy, diagnostic_weights, &mut *c as *mut _ as Handle) }, "Initial diagnostic error weights")?;
        initial_weighted_rates = weighted_contributors(
            unsafe { values(yypp,n) }?, unsafe { values(diagnostic_weights,n) }?, |r|m.is_differential(r));
        loop {
            let physical_stop = c.support.borrow().next(horizon)?;
            // This bounded mechanical exercise has sparse explicit observation planes.
            // Never query a past support/mode after a physical event transaction.
            let observation_stop = outputs
                .get(next_output)
                .copied()
                .filter(|&t| t > time)
                .unwrap_or(horizon);
            let stop = physical_stop.min(observation_stop);
            checked(
                unsafe { IDASetStopTime(owned.ida, stop) },
                "Moving next actual support/command event",
            )?;
            let status = if steps == 0 && next_output == 0 {
                0
            } else {
                unsafe { IDASolve(owned.ida, stop, &mut time, yy, yypp, 2) }
            };
            if let Some(e) = c.fatal.clone().or(c.convergence.fatal.clone()) {
                return Err(e);
            }
            if status < 0 {
                return Err(format!("Moving IDA failed status{status} at {time}"));
            }
            let mut py = c.decode(unsafe { values(yy, n) }?, false);
            let mut pyp = c.decode(unsafe { values(yypp, n) }?, true);
            let mut committed_event = false;
            let mut committed_audit = None;
            // Process root equality before endpoint branch admission, but retain the
            // last admitted transaction if any downstream current chart refuses it.
            if status == 2 || (time > 0. && dc::coincident(time, physical_stop) && time < horizon) {
                let mut next_mode = c.mode.borrow().clone();
                let mut next_support = c.support.borrow().clone();
                let old_support = c.support.borrow().clone();
                let old_mode = c.mode.borrow().clone();
                let mut next_adjustment = root_adjustment;
                let mut pending_events = Vec::new();
                let transaction = (|| -> Result<(f64, f64), String> {
                    let pi = old_support.prhr_input(time, py[old_support.a.room_row])?;
                    m.evaluate(&py, &pyp, None, &mut c.work, Some(pi), &old_mode)?;
                    let mut init_required = false;
                    if status == 2 {
                        let mut found = vec![0; m.root_count()];
                        checked(
                            unsafe { IDAGetRootInfo(owned.ida, found.as_mut_ptr()) },
                            "Moving located roots",
                        )?;
                        let event = m.accept_roots(
                            &mut py,
                            &c.work,
                            &mut next_mode,
                            &found,
                            sm::RootAccuracy {
                                position_m: p.case.position / refinement,
                                velocity_m_s: p.case.velocity / refinement,
                            },
                        )?;
                        next_adjustment += event.mechanical_adjustment_j;
                        init_required = event.needs_fluid_initialization;
                        pending_events.push(format!("{{\"time\":{time},\"velocityEvents\":{},\"contactEvents\":{},\"separationEvents\":{},\"realImpactHeatJ\":{},\"signedRootAdjustmentJ\":{}}}",event.velocity_events,event.contact_events,event.separation_events,finite(event.contact_heat_j),finite(event.mechanical_adjustment_j)));
                    }
                    if dc::coincident(time, physical_stop) {
                        next_support.accept(time)?;
                        let pi = next_support.prhr_input(time, py[next_support.a.room_row])?;
                        m.evaluate(&py, &pyp, None, &mut c.work, Some(pi), &next_mode)?;
                        next_mode =
                            m.select_mode(&py, &c.work, next_support.motion_input(time)?)?;
                        pending_events.push(format!(
                            "{{\"time\":{time},\"commandOrSupport\":true,\"requestedRate\":{}}}",
                            finite(next_mode.input.requested_rate_m_s)
                        ));
                    }
                    *c.mode.borrow_mut() = next_mode;
                    *c.support.borrow_mut() = next_support;
                    let pi = c
                        .support
                        .borrow()
                        .prhr_input(time, py[c.support.borrow().a.room_row])?;
                    m.evaluate(&py, &pyp, None, &mut c.work, Some(pi), &c.mode.borrow())?;
                    m.set_mechanical_rates(&py, &mut pyp, &c.work)?;
                    c.encode(&mut py, false);
                    c.encode(&mut pyp, true);
                    unsafe { output(yy, n) }?.copy_from_slice(&py);
                    unsafe { output(yypp, n) }?.copy_from_slice(&pyp);
                    checked(
                        unsafe { IDAReInit(owned.ida, time, yy, yypp) },
                        "Moving event reinit",
                    )?;
                    if init_required {
                        let began = Instant::now();
                        let fixed = py.clone();
                        checked(
                            unsafe { IDACalcIC(owned.ida, 1, time + OUTPUTS[0]) },
                            "Actual whole-composition event IC",
                        )?;
                        checked(
                            unsafe { IDAGetConsistentIC(owned.ida, yy, yypp) },
                            "Actual whole-composition event IC vectors",
                        )?;
                        if let Some(e) = c.fatal.clone().or(c.convergence.fatal.clone()) {
                            return Err(e);
                        }
                        let actual = unsafe { values(yy, n) }?;
                        if (0..n).any(|r| {
                            m.is_differential(r) && fixed[r].to_bits() != actual[r].to_bits()
                        }) {
                            return Err("Event IC changed differential stocks".into());
                        }
                        ics += 1;
                        ic_seconds += began.elapsed().as_secs_f64();
                    }
                    py = c.decode(unsafe { values(yy, n) }?, false);
                    pyp = c.decode(unsafe { values(yypp, n) }?, true);
                    audit(
                        &mut c,
                        accuracy,
                        time,
                        &py,
                        &pyp,
                        initial_mechanical,
                        next_adjustment,
                        initial_balance,
                        &initial_physical,
                        &network_weights.flow,
                    )
                })();
                match transaction {
                    Err(e) => {
                        *c.mode.borrow_mut() = old_mode;
                        *c.support.borrow_mut() = old_support;
                        return Err(format!("Atomic event admission refused: {e}"));
                    }
                    Ok(audited) => committed_audit = Some(audited),
                }
                root_adjustment = next_adjustment;
                events.extend(pending_events);
                committed_event = true;
            }
            // The successful event transaction already admitted these exact
            // physical vectors and modes. No intervening mutation needs a
            // second full SOURCE/water evaluation of the same transaction.
            let (me, eb) = if let Some(audited) = committed_audit { audited } else { audit(
                &mut c,
                accuracy,
                time,
                &py,
                &pyp,
                initial_mechanical,
                root_adjustment,
                initial_balance,
                &initial_physical,
                &network_weights.flow,
            )? };
            max_mech = max_mech.max(me);
            max_energy = max_energy.max(eb);
            last_admitted = time;
            admitted_y = py;
            admitted_yp = pyp;
            admitted_support = c.support.borrow().clone();
            admitted_mode = c.mode.borrow().clone();
            steps += 1;
            if committed_event {
                let retention_began = Instant::now();
                let index = event_snapshots.len();
                let path = dir.join(format!("event-{index}.bin"));
                retain(&path, time, &admitted_y, &admitted_yp)?;
                c.support.borrow().retain(&path, time)?;
                retain_mode(&path, &c.mode.borrow())?;
                c.retention_seconds += retention_began.elapsed().as_secs_f64();
                event_snapshots.push(format!("{{\"time\":{time},\"index\":{index}}}"));
            }
            while next_output < outputs.len() && outputs[next_output] <= time {
                let observation_began = Instant::now();
                let t = outputs[next_output];
                let (oy, op) = if dc::coincident(t, time) {
                    (admitted_y.clone(), admitted_yp.clone())
                } else {
                    checked(
                        unsafe { IDAGetDky(owned.ida, t, 0, yy) },
                        "Moving common observation state",
                    )?;
                    let oy = c.decode(unsafe { values(yy, n) }?, false);
                    checked(
                        unsafe { IDAGetDky(owned.ida, t, 1, yypp) },
                        "Moving common observation slope",
                    )?;
                    (oy, c.decode(unsafe { values(yypp, n) }?, true))
                };
                let pi = c
                    .support
                    .borrow()
                    .prhr_input(t, oy[c.support.borrow().a.room_row])?;
                m.evaluate(&oy, &op, None, &mut c.work, Some(pi), &c.mode.borrow())?;
                let s = sample(b, &oy[..end], &c.work.cooling, t)?;
                let motion = oy[end..].to_vec();
                let material = control_material_accuracy::Sample {
                    time:t,
                    powers:c.work.control_material.value()?.channels.iter().flatten().copied().collect(),
                    paid:m.control_material.paid_rows().map(|(row,q)|q*(oy[row]-initial_physical[row])).collect(),
                    receipts:[oy[m.layout.nuclear_to_apparatus]-initial_physical[m.layout.nuclear_to_apparatus],
                        oy[m.layout.control_photon_export]-initial_physical[m.layout.control_photon_export]],
                };
                if let Some(reference) = reference {
                    let comparison=control_material_accuracy::compare(&reference.material[next_output],&material)?;
                    if comparison.failed() { return Err(format!("Control material refined pair failed: {}",comparison.json())); }
                    material_comparisons.push(comparison.json());
                    if t > 0. {
                        let comparison =
                            accuracy.compare_one(b, &reference.samples[next_output], &s)?;
                        comparisons.push(comparison.json());
                        if comparison.failed() {
                            return Err(format!(
                                "Inherited full SOURCE/cooling pair failed at {t}: {}",
                                comparison.json()
                            ));
                        }
                    } else if s
                        .y
                        .iter()
                        .zip(&reference.samples[0].y)
                        .any(|(a, b)| a.to_bits() != b.to_bits())
                    {
                        // Initial algebraic IC may differ within its admitted tighter chart; only
                        // physical differential stocks must be bitwise identical between arms.
                        if (0..end).any(|r| {
                            b.is_differential(r)
                                && s.y[r].to_bits() != reference.samples[0].y[r].to_bits()
                        }) {
                            return Err("Refinement changed initial differential stock".into());
                        }
                    }
                    let mut worst = (0., 0);
                    for (j, (&a, &bb)) in reference.motion[next_output]
                        .iter()
                        .zip(&motion)
                        .enumerate()
                    {
                        let scale = if j >= sm::WIDTH*m.clusters() {
                            1e-5
                        } else {
                            match j % sm::WIDTH {
                                sm::BODY_Y | sm::STEM_Y | sm::REFERENCE_Y => 1e-7,
                                sm::BODY_V | sm::STEM_V => 1e-7,
                                _ => 1e-5,
                            }
                        };
                        let q = (a - bb).abs() / scale;
                        if q > worst.0 {
                            worst = (q, j)
                        }
                    }
                    if worst.0 > 1. {
                        return Err(format!(
                            "Mechanical refined pair failed {t}: ratio{} suffixrow{}",
                            worst.0, worst.1
                        ));
                    }
                    let row = worst.1;
                    let a = reference.motion[next_output][row];
                    let bb = motion[row];
                    let bound = if row >= sm::WIDTH*m.clusters() {
                        1e-5
                    } else {
                        match row % sm::WIDTH {
                            sm::BODY_Y | sm::STEM_Y | sm::REFERENCE_Y | sm::BODY_V | sm::STEM_V => {
                                1e-7
                            }
                            _ => 1e-5,
                        }
                    };
                    motion_comparisons.push(format!("{{\"time\":{t},\"suffixRow\":{row},\"normal\":{},\"tighter\":{},\"difference\":{},\"bound\":{},\"ratio\":{}}}",finite(a),finite(bb),finite((a-bb).abs()),finite(bound),finite(worst.0)));
                }
                let retention_began = Instant::now();
                retain(&dir.join(format!("common-{next_output}.bin")), t, &oy, &op)?;
                c.support
                    .borrow()
                    .retain(&dir.join(format!("common-{next_output}.bin")), t)?;
                retain_mode(
                    &dir.join(format!("common-{next_output}.bin")),
                    &c.mode.borrow(),
                )?;
                fs::write(
                    dir.join(format!("common-{next_output}.support.json")),
                    c.support.borrow().json(t)?,
                )
                .map_err(|e| e.to_string())?;
                let retained_seconds = retention_began.elapsed().as_secs_f64();
                c.retention_seconds += retained_seconds;
                samples.push(s);
                material_samples.push(material);
                if t == horizon {
                    structural_temperatures = numbers(&m.structural_temperatures(&oy)?);
                    let sensitivity=m.control_chord_sensitivity(&c.work)?;
                    chord_sensitivity=format!("[{}]",sensitivity.iter().zip([0.5,1.,2.]).map(|(d,scale)|format!(
                        "{{\"scale\":{scale},\"emittedW\":{},\"metalW\":{},\"waterW\":{},\"exportW\":{},\"familyEmittedW\":{}}}",
                        finite(d.emitted),finite(d.metal_total()),finite(d.water.iter().sum()),finite(d.exported),numbers(&d.family_emitted))).collect::<Vec<_>>().join(","));
                }
                motions.push(motion);
                c.observation_seconds += observation_began.elapsed().as_secs_f64() - retained_seconds;
                performance_planes.push(format!("{{\"time\":{t},\"wallSeconds\":{},\"steps\":{steps},\"residuals\":{},\"bases\":{},\"actions\":{},\"residualSeconds\":{},\"baseSeconds\":{},\"actionSeconds\":{},\"PSeconds\":{},\"PSolveSeconds\":{},\"rootSeconds\":{},\"weightsSeconds\":{},\"auditSeconds\":{},\"observationSeconds\":{},\"retentionSeconds\":{}}}",
                    begin.elapsed().as_secs_f64(),c.calls[0],c.calls[1],c.calls[2],
                    c.seconds[0],c.seconds[1],c.seconds[2],c.seconds[3],c.psolve_seconds,
                    c.root_seconds,c.weights_seconds,c.audit_seconds,c.observation_seconds,c.retention_seconds));
                next_output += 1;
            }
            if steps > 0 && (steps.is_power_of_two() || last_checkpoint.elapsed().as_secs_f64() > 1.) {
                // IDA's estimate belongs to its last accepted internal step,
                // not necessarily the interpolated root/output time. ReInit
                // resets that history: no estimate is meaningful at an event
                // commit or the initial zero-time return.
                if time > 0. && !committed_event {
                    let mut last_step = 0.;
                    let mut internal_time = 0.;
                    checked(unsafe { IDAGetLastStep(owned.ida, &mut last_step) }, "Accepted internal-step diagnostic size")?;
                    checked(unsafe { IDAGetCurrentTime(owned.ida, &mut internal_time) }, "Accepted internal-step diagnostic time")?;
                    checked(unsafe { IDAGetErrWeights(owned.ida, diagnostic_weights) }, "Accepted internal-step diagnostic weights")?;
                    checked(unsafe { IDAGetEstLocalErrors(owned.ida, diagnostic_errors) }, "Accepted internal-step diagnostic LTE")?;
                    let diagnostic = weighted_contributors(unsafe { values(diagnostic_errors,n) }?,
                        unsafe { values(diagnostic_weights,n) }?, |r|m.is_differential(r));
                    eprintln!("{{\"kind\":\"motion-accepted-LTE\",\"refinement\":{refinement},\"returnedTime\":{},\"internalTime\":{},\"lastStepS\":{},\"contributors\":{diagnostic}}}",finite(time),finite(internal_time),finite(last_step));
                }
                eprintln!(
                    "Moving arm{refinement}: admitted{time:.9}s/{horizon}, {steps} steps, aggregate{:.3}s",
                    start.elapsed().as_secs_f64()
                );
                last_checkpoint = Instant::now();
            }
            if time >= horizon {
                break;
            }
        }
        if samples.len() != outputs.len() {
            return Err("Missing common-time trajectory observations".into());
        }
        if c.mode.borrow().branches.iter().any(|q| {
            q.joint != am::JointMode::Contact || q.regulator != am::RegulatorBranch::HoldRest
        }) || (0..m.clusters()).any(|k| {
            admitted_y[m.motion_row(k, sm::BODY_Y)] <= 1e-7
                || admitted_y[m.motion_row(k, sm::STEM_Y)] <= 1e-7
        }) {
            return Err("All52 actual motion did not settle in resolved Contact/HoldRest".into());
        }
        if let Some(reference) = reference {
            let a=&reference.material.last().ok_or("Missing control material normal sample")?.powers;
            let bb=&material_samples.last().ok_or("Missing control material tighter sample")?.powers;
            for family in 0..2 {
                // Resolve both actual prompt and Mn metal delivery separately.
                let x=a.chunks_exact(8).map(|c|c[4*family+1]).sum::<f64>();
                let z=bb.chunks_exact(8).map(|c|c[4*family+1]).sum::<f64>();
                if x.min(z) <= 10.*(x-z).abs()+20.*control_material_accuracy::RESOLUTION {
                    return Err(format!("Control material family{family} metal delivery not resolved above paired uncertainty: {x:e}/{z:e} W"));
                }
            }
            if !cooling_bundle::developed(
                &reference.samples.last().unwrap().bundle_power,
                &samples.last().unwrap().bundle_power,
            ) {
                return Err(
                    "Actual BODY/guide nuclear recipients not developed above refined uncertainty"
                        .into(),
                );
            }
        }
        Ok(())
    })();
    if result.is_err() {
        // Diagnostic only: never confuse a returned/refused candidate with the
        // separately retained admitted transaction below. A refused event may
        // already have restored its old support/mode; do not label these raw
        // solver buffers as a restartable physical checkpoint.
        let returned_y = c.decode(unsafe { values(yy, n) }?, false);
        let returned_yp = c.decode(unsafe { values(yypp, n) }?, true);
        retain(
            &dir.join("solver-returned-NOT-ADMITTED.bin"),
            time,
            &returned_y,
            &returned_yp,
        )?;
    }
    let retention_began = Instant::now();
    let terminal_path = dir.join(if initial_admitted {
        "terminal-admitted.bin"
    } else {
        "initial-fixed-stocks-NOT-ADMITTED.bin"
    });
    retain(
        &terminal_path,
        last_admitted,
        &admitted_y,
        &admitted_yp,
    )?;
    admitted_support.retain(&terminal_path, last_admitted)?;
    retain_mode(&terminal_path, &admitted_mode)?;
    c.retention_seconds += retention_began.elapsed().as_secs_f64();
    let terminal = format!(
        "{{\"passed\":{},\"lastAdmittedTime\":{},\"solverReturnedTime\":{},\"reason\":{},\"seconds\":{},\"steps\":{},\"initialization\":{},\"startupICSeconds\":{},\"initialWeightedRates\":{},\"eventICCalls\":{},\"eventICSeconds\":{},\"maxMechanicalDefectJ\":{},\"maxThermalWorkDefectJ\":{},\"events\":[{}],\"eventSnapshots\":[{}],\"comparisons\":[{}],\"motionComparisons\":[{}],\"controlMaterialSamples\":[{}],\"controlMaterialComparisons\":[{}],\"controlChordSensitivity\":{},\"structuralTemperaturesK\":{},\"costs\":{},\"performancePlanes\":[{}],\"support\":{},\"finalMotion\":{}}}",
        result.is_ok(),
        finite(last_admitted),
        finite(time),
        result.as_ref().err().map_or("null".into(), |e| quote(e)),
        begin.elapsed().as_secs_f64(),
        steps,
        init.json(),
        finite(startup_ic_seconds),
        initial_weighted_rates,
        ics,
        ic_seconds,
        finite(max_mech),
        finite(max_energy),
        events.join(","),
        event_snapshots.join(","),
        comparisons.join(","),
        motion_comparisons.join(","),
        material_samples.iter().map(|s|s.json()).collect::<Vec<_>>().join(","),
        material_comparisons.join(","),
        chord_sensitivity,
        structural_temperatures,
        c.metrics(),
        performance_planes.join(","),
        admitted_support
            .json(last_admitted)
            .unwrap_or("null".into()),
        numbers(&admitted_y[end..])
    );
    fs::write(dir.join("result.json"), &terminal).map_err(|e| e.to_string())?;
    result?;
    Ok(Arm {
        samples,
        motion: motions,
        material: material_samples,
        final_y: admitted_y,
        summary: terminal,
    })
}
fn execute() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("Expected wall allowance and NEW artifact directory".into());
    }
    let allowance = args[0].parse::<f64>().map_err(|e| e.to_string())?;
    if !allowance.is_finite() || allowance <= 0. || allowance > 180. {
        return Err("Invalid bounded allowance".into());
    }
    let directory = PathBuf::from(&args[1]);
    let start = Instant::now();
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let p = parse(&text)?;
    let input = p.a.input(0., 0.)?;
    let accuracy = cooling_accuracy::Accuracy::new(&p.model.cooling, &p.emissions, Some(input))?;
    fs::create_dir(directory.join("normal")).map_err(|e| e.to_string())?;
    fs::create_dir(directory.join("tighter")).map_err(|e| e.to_string())?;
    let normal = run(
        &p,
        &accuracy,
        1.,
        start,
        allowance,
        &directory.join("normal"),
        None,
    )?;
    let tighter = run(
        &p,
        &accuracy,
        10.,
        start,
        allowance,
        &directory.join("tighter"),
        Some(&normal),
    )?;
    if (0..p.model.clusters()).any(|k| {
        normal.final_y[p.model.motion_row(k, sm::BODY_Y)] <= 20. * p.case.position
            || normal.final_y[p.model.motion_row(k, sm::STEM_Y)] <= 20. * p.case.position
    }) {
        return Err("Actual all-cluster motion not developed".into());
    }
    println!(
        "{{\"status\":\"PASS\",\"scope\":\"cold-all52-accepted-motion-full98-SOURCE-water-thermal-single-clock\",\"trajectoryAdmitted\":true,\"liveModelInstalled\":false,\"unknowns\":{},\"waterOwners\":{},\"clusters\":{},\"controlSteelHosts\":{},\"controlSteelRoutes\":{},\"controlPaidRows\":[{}],\"elapsedS\":{},\"normal\":{},\"tighter\":{}}}",
        p.model.dimension(),
        p.model.cooling.carrier.cells(),
        p.model.clusters(),
        p.model.control_material.host_count(),
        p.model.control_material.config().routes.len(),
        p.model.control_material.paid_rows().map(|(row,q)|format!("[{row},{}]",finite(q))).collect::<Vec<_>>().join(","),
        start.elapsed().as_secs_f64(),
        normal.summary,
        tighter.summary
    );
    Ok(())
}

#[cfg(test)]
#[test]
#[ignore = "requires explicit LEITBILD_MOTION_INPUT frozen physical frame; no advancement"]
fn retained_current_material_frame_constructs_without_advancement() {
    let path = std::env::var("LEITBILD_MOTION_INPUT").expect("explicit retained physical frame");
    let p = parse(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(p.model.dimension(), 75866);
    assert_eq!(p.model.control_material.host_count(), 104);
    assert_eq!(p.model.control_material.config().routes.len(), 360);
}
#[cfg(test)]
#[test]
#[ignore = "requires explicit frozen input and admitted initial full frame; no advancement"]
fn retained_initial_source_rate_weight_diagnosis() {
    let p = parse(&fs::read_to_string(std::env::var("LEITBILD_MOTION_INPUT").unwrap()).unwrap()).unwrap();
    let bytes=fs::read(std::env::var("LEITBILD_MOTION_INITIAL_FRAME").unwrap()).unwrap();
    let frame=bytes.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
    let m=&p.model;
    assert_eq!(bytes.len(),8*(1+2*m.dimension()));
    assert_eq!(frame[0],0.);
    let source=&m.cooling.source;
    let n=source.state_count();
    let y=&frame[1..1+n];
    let yp=&frame[1+m.dimension()..1+m.dimension()+n];
    let policy=source_accuracy::Accuracy::new(source,&p.emissions).unwrap();
    let mut scales=policy.absolute(1.).unwrap();
    for (a,v) in scales.iter_mut().zip(y) { *a+=1e-5*v.abs(); }
    // These are the same emitted-power caps as the actual composed callback.
    let power=cooling_power::PowerWeights::new(source).unwrap();
    let mut work=power.workspace();
    power.cap(&y[..source.history_dimension()],1e-5,cooling_accuracy::DEPOSIT_RESOLUTION_W,
        &mut scales,&mut work).unwrap();
    let mut barrel=cooling_power::BarrelWeights::new(source,m.cooling.barrel.config().targets,
        m.cooling.barrel.config().capture_photon_j).unwrap();
    barrel.cap(y,1e-5,cooling_accuracy::DEPOSIT_RESOLUTION_W,&mut scales).unwrap();
    let physical=&frame[1..1+m.dimension()];
    let mut full_scales=scales.clone();
    full_scales.resize(m.layout.cooling_end,1.);
    let mut capture=cooling_power::CaptureWeights::new(&m.cooling).unwrap();
    capture.cap(&physical[..m.layout.cooling_end],1e-5,cooling_accuracy::DEPOSIT_RESOLUTION_W,&mut full_scales).unwrap();
    scales.copy_from_slice(&full_scales[..n]);
    let mut raw=y.to_vec();
    let mut rates=yp.to_vec();
    let coordinates=source_coordinates::Coordinates{nc:source.nc_dimension(),ledger:source.ledger_row()};
    coordinates.transform(&mut raw);coordinates.transform(&mut rates);
    // The ledger is a transformed balance, not the large original paid history.
    scales[source.ledger_row()]=policy.absolute(1.).unwrap()[source.ledger_row()]+1e-5*raw[source.ledger_row()].abs();
    let weights=scales.iter().map(|s|1./s).collect::<Vec<_>>();
    eprintln!("SOURCE_WEIGHT_DIAG dimension={n} nc={} cf={} ledger={} report={}",source.nc_dimension(),source.cf_row(),source.ledger_row(),
        weighted_contributors(&rates,&weights,|_|true));
}
#[cfg(test)]
#[test]
#[ignore = "explicit retained input/arm; fixed complete native work pattern, no advancement"]
fn retained_geometry_direction_and_native_work_pattern() {
    fn fields(s: &cg::Stage) -> Vec<f64> {
        s.source.passive_volumes.iter().chain(&s.source.cylinder_shares)
            .chain(&s.source.moderator_volumes).chain(&s.source.external_water_volumes)
            .chain(&s.mobile.birth_shares).chain(&s.mobile.path_shares)
            .chain(&s.mobile.boundary_shares).chain(&s.mobile.liquid_chords_m)
            .chain(&s.mobile.wall_thicknesses_m).chain(&s.barrel_chords_m).copied()
            .chain(s.water.iter().flat_map(|q| [q.volume, q.moment]))
            .chain(s.contacts.iter().flat_map(|q| [q.area_m2, q.solid_geometry_m_inv, q.liquid_chord_m]))
            .collect()
    }
    let all_started = Instant::now();
    let input = std::env::var("LEITBILD_MOTION_INPUT").expect("explicit frozen input");
    let arm = PathBuf::from(std::env::var("LEITBILD_MOTION_RETAINED_ARM").expect("explicit retained arm"));
    let p = parse(&fs::read_to_string(input).unwrap()).unwrap();
    let m = &p.model;
    let support = motion_support::Support::new(p.a.clone(),p.b.clone(),p.holding,p.motive,
        p.base_b,p.rate,p.case.burst).unwrap();
    let mut timed = [0.;5];
    let mut counts = [0_usize;5];
    let mut proof_fields = 0_usize;
    let mut empty_entry = false;
    // Same retained stages and work count in both separately compiled source
    // variants. This is core F/base/J/P/admission work, not a solver trajectory,
    // and does not measure weights, root search, output or startup step counts.
    for name in ["common-0.bin", "event-2.bin", "terminal-admitted.bin"] {
        assert!(all_started.elapsed().as_secs_f64() < 15., "bounded retained work proof expired");
        let path = arm.join(name);
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len(),8*(1+2*m.dimension()));
        let frame = bytes.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
        let t = frame[0];
        let y = &frame[1..1+m.dimension()];
        let yp = &frame[1+m.dimension()..];
        let mode = sm::Mode::restore_words(&fs::read_to_string(path.with_extension("bin.mode.txt")).unwrap()).unwrap();
        let support_words = fs::read_to_string(path.with_extension("bin.motion-support.txt")).unwrap()
            .split_whitespace().map(|s|s.parse::<f64>().unwrap()).collect::<Vec<_>>();
        let stage_support = support.restore_words(&support_words).unwrap();
        assert_eq!(stage_support.motion_input(t).unwrap(),mode.input);
        let pi = stage_support.prhr_input(t,y[stage_support.a.room_row]).unwrap();
        let poses = (0..m.clusters()).map(|k| cg::Pose {
            body:y[m.motion_row(k,sm::BODY_Y)],stem:y[m.motion_row(k,sm::STEM_Y)],
            body_right:mode.geometry[k].body_right,stem_right:mode.geometry[k].stem_right,
            seated:mode.geometry[k].seated,
        }).collect::<Vec<_>>();
        let velocity = (0..m.clusters()).map(|k|cg::Direction {
            body:y[m.motion_row(k,sm::BODY_V)],stem:y[m.motion_row(k,sm::STEM_V)],
        }).collect::<Vec<_>>();
        let directions = [(1.,0.),(0.,-1.),(1.,-2.),(-1.,2.),(0.,0.)].map(|(body,stem)| {
            let mut dy = vec![0.;m.dimension()];
            for k in 0..m.clusters() {
                let q = (k as f64+1.)/m.clusters() as f64;
                dy[m.motion_row(k,sm::BODY_Y)] = body*q*0.001;
                dy[m.motion_row(k,sm::STEM_Y)] = stem*q*0.001;
                dy[m.motion_row(k,sm::BODY_V)] = -body*q*0.002;
                dy[m.motion_row(k,sm::STEM_V)] = stem*q*0.003;
            }
            dy
        });
        let cj = 1000.;
        let mut w = m.workspace();
        m.evaluate(y,yp,Some(cj),&mut w,Some(pi),&mode).unwrap();
        m.validate_accepted(y,&w).unwrap();
        let values = fields(&w.geometry.value);
        let mut direct = m.geometry.workspace();
        for dy in &directions {
            let dpose = (0..m.clusters()).map(|k|cg::Direction {
                body:dy[m.motion_row(k,sm::BODY_Y)],stem:dy[m.motion_row(k,sm::STEM_Y)],
            }).collect::<Vec<_>>();
            let dv = (0..m.clusters()).map(|k|cg::Direction {
                body:dy[m.motion_row(k,sm::BODY_V)],stem:dy[m.motion_row(k,sm::STEM_V)],
            }).collect::<Vec<_>>();
            m.jvp(dy,cj,&mut w).unwrap();
            m.geometry.evaluate_into(&poses,&dpose,&mut direct).unwrap();
            m.geometry.water_rates_into(&velocity,&dv,&mut direct).unwrap();
            assert_eq!(values,fields(&w.geometry.value),"value mutation at {name}");
            assert_eq!(values,fields(&direct.value),"direct value mismatch at {name}");
            for (row,(a,b)) in fields(&w.geometry.direction).into_iter().zip(fields(&direct.direction)).enumerate() {
                assert!((a-b).abs()<=64.*f64::EPSILON*(a.abs()+b.abs()),
                    "{name} geometry field {row}: prepared={a:e}, direct={b:e}");
                proof_fields+=1;
            }
            for (a,b) in w.geometry.water_rate_direction.iter().zip(&direct.water_rate_direction) {
                assert_eq!(a.volume,b.volume); assert_eq!(a.moment,b.moment);
            }
            empty_entry |= direct.value.source.cylinder_shares.iter().zip(&direct.direction.source.cylinder_shares)
                .any(|(&value,&direction)|value==0.&&direction!=0.);
            assert!(w.jvp.iter().all(|q|q.is_finite()));
        }
        let mut bp = cooling_block::Preconditioner::new_prepared(&m.cooling,
            std::mem::replace(&mut w.cooling,m.cooling.workspace())).unwrap();
        let mut mp = sm::MechanicalPreconditioner::new(m);
        let mut out = vec![0.;m.dimension()];
        let mut rhs = directions[2].clone();
        m.mechanical_to_solver(&mut rhs);
        for repeat in 0..4 {
            assert!(all_started.elapsed().as_secs_f64()<15.,"bounded retained work proof expired");
            for base in [false,true] {
                let started = Instant::now();
                m.evaluate(y,yp,if base {Some(cj)} else {None},&mut w,Some(pi),&mode).unwrap();
                timed[0]+=started.elapsed().as_secs_f64(); counts[0]+=1;
            }
            if repeat==0 {
                let started=Instant::now();
                bp.setup_prepared(&m.cooling,&mut w.cooling,cj).unwrap();
                mp.setup(m,&w,cj).unwrap();
                timed[2]+=started.elapsed().as_secs_f64(); counts[2]+=1;
            }
            for dy in &directions {
                let started=Instant::now();
                m.jvp(dy,cj,&mut w).unwrap();
                timed[1]+=started.elapsed().as_secs_f64(); counts[1]+=1;
            }
            for _ in 0..6 {
                let started=Instant::now();
                let end=m.layout.cooling_end;
                bp.solve(&m.cooling,&rhs[..end],&mut out[..end]).unwrap();
                mp.solve_solver(&rhs[end..],&mut out[end..]).unwrap();
                assert!(out.iter().all(|q|q.is_finite()));
                timed[3]+=started.elapsed().as_secs_f64(); counts[3]+=1;
            }
            let started=Instant::now();
            m.evaluate(y,yp,None,&mut w,Some(pi),&mode).unwrap();
            m.validate_accepted(y,&w).unwrap();
            timed[4]+=started.elapsed().as_secs_f64(); counts[4]+=1;
        }
    }
    assert!(empty_entry,"actual ORIGINAL empty-support entering derivative not exercised");
    eprintln!("RETAINED_NATIVE_WORK_PATTERN frames=3 repeats=4 counts={counts:?} seconds={timed:?} proofFields={proof_fields} emptyEntry={empty_entry} measuredSeconds={} completeProofSeconds={}",
        timed.iter().sum::<f64>(),all_started.elapsed().as_secs_f64());
}
#[cfg(test)]
#[test]
#[ignore = "explicit frozen input/admitted initial frame; exact owned-stage reuse, no advancement"]
fn retained_owned_stage_reuse_keys_and_failure_invalidation() {
    let p=parse(&fs::read_to_string(std::env::var("LEITBILD_MOTION_INPUT").unwrap()).unwrap()).unwrap();
    let path=PathBuf::from(std::env::var("LEITBILD_MOTION_INITIAL_FRAME").unwrap());
    let bytes=fs::read(&path).unwrap();
    let m=&p.model;
    assert_eq!(bytes.len(),8*(1+2*m.dimension()));
    let frame=bytes.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
    assert_eq!(frame[0],0.);
    let y=&frame[1..1+m.dimension()];let yp=&frame[1+m.dimension()..];
    let mode=sm::Mode::restore_words(&fs::read_to_string(path.with_extension("bin.mode.txt")).unwrap()).unwrap();
    let pi=p.a.input(0.,y[p.a.room_row]).unwrap();
    let mut w=m.workspace();
    m.evaluate(y,yp,None,&mut w,Some(pi),&mode).unwrap();
    let residual=w.residual.clone();let rates=w.rates.clone();let geometry=w.geometry.value.source.clone();
    let energy=w.complete_energy_rate().unwrap();let thermal=w.thermal_work_energy_rate().unwrap();
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();
    assert_eq!(w.full_evaluations,2);assert_eq!(w.reused_evaluations,0);
    assert_eq!(residual,w.residual);assert_eq!(rates,w.rates);assert_eq!(geometry,w.geometry.value.source);
    assert_eq!(energy.to_bits(),w.complete_energy_rate().unwrap().to_bits());
    assert_eq!(thermal.to_bits(),w.thermal_work_energy_rate().unwrap().to_bits());
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();
    assert_eq!(w.full_evaluations,2);assert_eq!(w.reused_evaluations,1);
    let mut misses=2;
    // An exact dependency changes, then restoration, each requires fresh work.
    let mut yy=y.to_vec();yy[m.motion_row(0,sm::JACK_HEAT)]=1e-9;
    m.evaluate(&yy,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    let mut pp=yp.to_vec();pp[m.motion_row(0,sm::JACK_HEAT)]+=1e-9;
    m.evaluate(y,&pp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    m.evaluate(y,yp,Some(2.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    for changed in 0..3 {
        let mut other=mode.clone();
        match changed {
            0=>other.input.holding_power_w+=0.01,
            1=>other.geometry[0].seated=!other.geometry[0].seated,
            _=>other.branches[0].joint=am::JointMode::Separated,
        }
        m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&other).unwrap();misses+=1;
        m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    }
    for field in 0..5 {
        let mut other=pi;
        match field {
            0=>other.opening+=1e-8,1=>other.opening_rate+=1e-8,
            2=>other.electrical_receipt_w+=1e-8,3=>other.room_heat_w+=1e-8,
            _=>other.ambient_temperature_k+=1e-8,
        }
        // Some independently changed achieved-input fields are physically
        // incompatible. They must attempt fresh preparation and invalidate,
        // never silently reuse the former valid stage.
        let changed=m.evaluate(y,yp,Some(1.),&mut w,Some(other),&mode);misses+=1;
        if changed.is_err() {assert!(w.complete_energy_rate().is_err());}
        m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    }
    assert_eq!(w.full_evaluations,misses);assert_eq!(w.reused_evaluations,1);
    let zero=vec![0.;m.dimension()];
    m.jvp(&zero,1.,&mut w).unwrap();
    assert!(w.complete_energy_rate_jvp().is_ok());
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    assert!(w.complete_energy_rate_jvp().is_err());
    assert!(w.geometry.direction.source.passive_volumes.iter().all(|q|*q==0.));
    assert!(m.jvp(&zero,2.,&mut w).is_err());
    assert!(w.complete_energy_rate().is_err());
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    m.evaluate(y,yp,None,&mut w,Some(pi),&mode).unwrap();misses+=1;
    m.evaluate(y,yp,None,&mut w,Some(pi),&mode).unwrap();misses+=1;
    assert_eq!(w.full_evaluations,misses);assert_eq!(w.reused_evaluations,1);
    let mut invalid=zero;invalid[0]=f64::NAN;
    assert!(m.jvp(&invalid,1.,&mut w).is_err());
    assert!(w.complete_energy_rate().is_err());
    m.evaluate(y,yp,Some(1.),&mut w,Some(pi),&mode).unwrap();misses+=1;
    assert_eq!(w.full_evaluations,misses);
    m.validate_accepted(y,&w).unwrap();
    let support=motion_support::Support::new(p.a.clone(),p.b.clone(),p.holding,p.motive,p.base_b,p.rate,p.case.burst).unwrap();
    for name in ["common-1.bin","terminal-admitted.bin"] {
        let stage=path.parent().unwrap().join(name);
        let bytes=fs::read(&stage).unwrap();
        assert_eq!(bytes.len(),8*(1+2*m.dimension()));
        let frame=bytes.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
        let t=frame[0];let y=&frame[1..1+m.dimension()];let yp=&frame[1+m.dimension()..];
        let mode=sm::Mode::restore_words(&fs::read_to_string(stage.with_extension("bin.mode.txt")).unwrap()).unwrap();
        let words=fs::read_to_string(stage.with_extension("bin.motion-support.txt")).unwrap()
            .split_whitespace().map(|s|s.parse::<f64>().unwrap()).collect::<Vec<_>>();
        let supply=support.restore_words(&words).unwrap();
        let pi=supply.prhr_input(t,y[supply.a.room_row]).unwrap();
        let mut reused=m.workspace();let mut fresh=m.workspace();
        m.evaluate(y,yp,None,&mut fresh,Some(pi),&mode).unwrap();
        m.evaluate(y,yp,Some(3.),&mut reused,Some(pi),&mode).unwrap();
        assert_eq!(fresh.residual,reused.residual);assert_eq!(fresh.rates,reused.rates);
        assert_eq!(fresh.complete_energy_rate().unwrap().to_bits(),reused.complete_energy_rate().unwrap().to_bits());
        assert_eq!(fresh.thermal_work_energy_rate().unwrap().to_bits(),reused.thermal_work_energy_rate().unwrap().to_bits());
        m.evaluate(y,yp,Some(3.),&mut reused,Some(pi),&mode).unwrap();
        assert_eq!(reused.full_evaluations,1);assert_eq!(reused.reused_evaluations,1);
        m.evaluate(y,yp,Some(3.),&mut fresh,Some(pi),&mode).unwrap();
        let mut d=vec![0.;m.dimension()];
        for k in 0..m.clusters() {
            d[m.motion_row(k,sm::BODY_Y)]=0.001;
            d[m.motion_row(k,sm::STEM_Y)]=-0.002;
            d[m.motion_row(k,sm::BODY_V)]=-0.003;
            d[m.motion_row(k,sm::STEM_V)]=0.004;
        }
        m.jvp(&d,3.,&mut reused).unwrap();m.jvp(&d,3.,&mut fresh).unwrap();
        for (a,b) in reused.jvp.iter().zip(&fresh.jvp) {assert_eq!(a.to_bits(),b.to_bits());}
        for (a,b) in reused.cooling.source.rate_jvp().unwrap().iter().zip(fresh.cooling.source.rate_jvp().unwrap()) {
            assert_eq!(a.to_bits(),b.to_bits());
        }
        assert_eq!(reused.complete_energy_rate_jvp().unwrap().to_bits(),fresh.complete_energy_rate_jvp().unwrap().to_bits());
        assert_eq!(reused.thermal_work_energy_rate_jvp().unwrap().to_bits(),fresh.thermal_work_energy_rate_jvp().unwrap().to_bits());
        if name=="common-1.bin" {assert!((0..m.clusters()).any(|k|y[m.motion_row(k,sm::STEM_V)]!=0.));}
        else {assert!(mode.branches.iter().all(|b|b.regulator==am::RegulatorBranch::HoldRest));}
        m.validate_accepted(y,&reused).unwrap();m.validate_accepted(y,&fresh).unwrap();
    }
    eprintln!("OWNED_STAGE_REUSE_PROOF full={} reused={} sameSomeNoneBits=true allKeysAndDirectionInvalidation=true",w.full_evaluations,w.reused_evaluations);
}
fn main() {
    if let Err(e) = execute() {
        println!(
            "{{\"status\":\"FAIL\",\"trajectoryAdmitted\":false,\"error\":{}}}",
            quote(&e)
        );
        std::process::exit(1)
    }
}

//! Finite COLD-header / actual RETURN entrance qualification, offline only.
//! The remote duct end and other header ports are LABORATORY seals, not LD-01
//! equipment/alignment. No maintained pressure, heat, flow, DOWN or circulation.
mod ida_support;
use ida_support::*;
use leitbild_plant_numerics::finite_header_return::{Evaluation, Input, evaluate};
use leitbild_plant_numerics::horizontal_passage::Geometry;
use leitbild_plant_numerics::{CellGeometry, GRAVITY, Liquid, LiquidQuery, liquid_batch};
use std::{
    ffi::c_int,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    time::Instant,
};

const N: usize = 9;
const DIFFERENTIAL: [usize; 5] = [0, 1, 4, 5, 6];
const HORIZON: f64 = 10.;
const SAMPLES: usize = 100;

struct Work {
    header: CellGeometry,
    passage: Geometry,
    started: Instant,
    budget: f64,
    residuals: u64,
    jacobians: u64,
    evaluations: u64,
    property_requests: u64,
    errors: u64,
    last_error: Option<String>,
    budget_exhausted: bool,
    admitted_time: f64,
    admitted_state: [f64; N],
    returned_time: f64,
    returned_state: Option<[f64; N]>,
}
impl Work {
    fn evaluation(&mut self, y: [f64; N], yp: [f64; N], cj: f64) -> Result<Evaluation, String> {
        if self.started.elapsed().as_secs_f64() >= self.budget {
            self.budget_exhausted = true;
            return Err("Aggregate numerical allowance exhausted".into());
        }
        self.evaluations += 1;
        let result = evaluate(
            Input {
                header_geometry: self.header,
                passage: self.passage,
                trial: y,
                derivative: yp,
            },
            cj,
        );
        self.property_requests += match &result {
            Ok(e) => e.property_tuple_requests as u64,
            Err(e) => e.property_tuple_requests as u64,
        };
        result.map_err(|e| format!("Finite entrance: {}", e.message))
    }
}
fn callback(
    user: Handle,
    jac: bool,
    action: impl FnOnce(&mut Work) -> Result<(), String>,
) -> c_int {
    if user.is_null() {
        return -1;
    }
    let w = unsafe { &mut *user.cast::<Work>() };
    if jac {
        w.jacobians += 1;
    } else {
        w.residuals += 1;
    }
    match catch_unwind(AssertUnwindSafe(|| action(w))) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            w.errors += 1;
            let retryable = e.starts_with("Finite entrance:") && !w.budget_exhausted;
            w.last_error = Some(e);
            if retryable { 1 } else { -1 }
        }
        Err(_) => {
            w.errors += 1;
            w.last_error = Some("Panic contained at IDA boundary".into());
            -1
        }
    }
}
unsafe extern "C" fn residual(_t: f64, y: Handle, yp: Handle, out: Handle, user: Handle) -> c_int {
    callback(user, false, |w| {
        let e = w.evaluation(vector_values(y)?, vector_values(yp)?, 0.)?;
        if out.is_null() || unsafe { N_VGetLength_Serial(out) } != N as i64 {
            return Err("Residual vector length mismatch".into());
        }
        let data = unsafe { N_VGetArrayPointer_Serial(out) };
        if data.is_null() {
            return Err("Null residual data".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(e.residual.as_ptr(), data, N);
        }
        Ok(())
    })
}
fn write_matrix(matrix: Handle, jac: [[f64; N]; N]) -> Result<(), String> {
    // Tiny joined block: full fixed CSC storage, but analytic LOCAL derivatives.
    // No global finite-difference residual probes or dense plant backend.
    let pointers: [i64; N + 1] = std::array::from_fn(|j| (j * N) as i64);
    let indices: [i64; N * N] = std::array::from_fn(|j| (j % N) as i64);
    let values: [f64; N * N] = std::array::from_fn(|j| jac[j % N][j / N]);
    matrix_data(matrix, &pointers, &indices, &values)
}
unsafe extern "C" fn jacobian(
    _t: f64,
    cj: f64,
    y: Handle,
    yp: Handle,
    _rr: Handle,
    matrix: Handle,
    user: Handle,
    _a: Handle,
    _b: Handle,
    _c: Handle,
) -> c_int {
    callback(user, true, |w| {
        let e = w.evaluation(vector_values(y)?, vector_values(yp)?, cj)?;
        write_matrix(matrix, e.jacobian)
    })
}
fn solve2(a: f64, b: f64, c: f64, d: f64, x: f64, y: f64) -> Result<[f64; 2], String> {
    let det = a * d - b * c;
    if !det.is_finite() || det == 0. {
        return Err("Singular forward chart".into());
    }
    let v = [(d * x - b * y) / det, (a * y - c * x) / det];
    if v.iter().any(|x| !x.is_finite()) {
        return Err("Nonfinite chart correction".into());
    }
    Ok(v)
}
fn slopes(e: &Evaluation) -> Result<[f64; N], String> {
    let mut yp = [0.; N];
    for (&row, rate) in DIFFERENTIAL.iter().zip(e.rates) {
        yp[row] = rate;
    }
    for [r0, r1, p, t] in [[2, 3, 2, 3], [7, 8, 7, 8]] {
        let x = -DIFFERENTIAL
            .iter()
            .map(|&k| e.jacobian[r0][k] * yp[k])
            .sum::<f64>();
        let y = -DIFFERENTIAL
            .iter()
            .map(|&k| e.jacobian[r1][k] * yp[k])
            .sum::<f64>();
        let v = solve2(
            e.jacobian[r0][p],
            e.jacobian[r0][t],
            e.jacobian[r1][p],
            e.jacobian[r1][t],
            x,
            y,
        )?;
        yp[p] = v[0];
        yp[t] = v[1];
    }
    Ok(yp)
}
fn screen(
    y: [f64; N],
    e: &Evaluation,
    initial: [f64; N],
    entropy0: f64,
    property_requests: &mut u64,
) -> Result<[f64; 7], String> {
    let mut correction = [0.; 4];
    for (i, [r0, r1, p, t]) in [[2, 3, 2, 3], [7, 8, 7, 8]].into_iter().enumerate() {
        let v = solve2(
            e.jacobian[r0][p],
            e.jacobian[r0][t],
            e.jacobian[r1][p],
            e.jacobian[r1][t],
            e.residual[r0],
            e.residual[r1],
        )?;
        correction[2 * i] = v[0];
        correction[2 * i + 1] = v[1];
    }
    let mut water = [Liquid::default(); 2];
    *property_requests += 2;
    liquid_batch(
        &[
            LiquidQuery {
                pressure: y[2],
                temperature: y[3],
            },
            LiquidQuery {
                pressure: y[7],
                temperature: y[8],
            },
        ],
        &mut water,
    )
    .map_err(|e| e.message)?;
    let values = [
        (y[0] + y[4]) - (initial[0] + initial[4]),
        (y[1] + y[5]) - (initial[1] + initial[5]),
        correction[0],
        correction[1],
        correction[2],
        correction[3],
        y[0] * water[0].entropy + y[4] * water[1].entropy - entropy0,
    ];
    if values.iter().any(|x| !x.is_finite()) {
        return Err("Nonfinite admission screen".into());
    }
    // Prospective local feedback checks: neither plant temporal accuracy nor sensor precision.
    let limits = [1e-6, 0.1, 5., 1e-4, 5., 1e-4];
    if values[..6].iter().zip(limits).any(|(v, l)| v.abs() > l) || values[6] < -1e-5 {
        return Err(format!("Joined local admission refused: {values:?}"));
    }
    if e.entropy_production < -1e-7 {
        return Err(format!(
            "Negative joined entropy rate {}",
            e.entropy_production
        ));
    }
    if e.velocity.abs() > 30. {
        return Err(
            "Laboratory trajectory left the declared nozzle-comparison speed envelope".into(),
        );
    }
    Ok(values)
}
struct ResultRun {
    samples: Vec<[f64; N]>,
    wall_seconds: f64,
    steps: i64,
    residuals: u64,
    jacobians: u64,
    property_requests: u64,
    max_screens: [f64; 7],
    max_speed: f64,
    max_pressure_feedback: f64,
    max_mass_feedback: f64,
    extrema_flow: [f64; 2],
    end_entropy_gain: f64,
}
fn run_case(
    case: &str,
    ph: f64,
    th: f64,
    pd: f64,
    td: f64,
    tolerance: f64,
    began: Instant,
    budget: f64,
) -> Result<ResultRun, String> {
    let header = CellGeometry {
        volume: 4.,
        elevation: 3.,
    };
    let passage = Geometry {
        area: 2. * std::f64::consts::PI * 0.7_f64.powi(2) / 4.,
        length: 0.5,
        elevation: 3.,
    };
    let mut water = [Liquid::default(); 2];
    liquid_batch(
        &[
            LiquidQuery {
                pressure: ph,
                temperature: th,
            },
            LiquidQuery {
                pressure: pd,
                temperature: td,
            },
        ],
        &mut water,
    )
    .map_err(|e| e.message)?;
    let mh = water[0].density * header.volume;
    let md = water[1].density * passage.area * passage.length;
    let initial = [
        mh,
        mh * (water[0].internal_energy + GRAVITY * 3.),
        ph,
        th,
        md,
        md * (water[1].internal_energy + GRAVITY * 3.),
        0.,
        pd,
        td,
    ];
    let entropy0 = mh * water[0].entropy + md * water[1].entropy;
    let mut w = Box::new(Work {
        header,
        passage,
        started: began,
        budget,
        residuals: 0,
        jacobians: 0,
        evaluations: 0,
        property_requests: 2,
        errors: 0,
        last_error: None,
        budget_exhausted: false,
        admitted_time: 0.,
        admitted_state: initial,
        returned_time: 0.,
        returned_state: None,
    });
    let outcome = (|| -> Result<ResultRun, String> {
        let e0 = w.evaluation(initial, [0.; N], 0.)?;
        let yp0 = slopes(&e0)?;
        let e0 = w.evaluation(initial, yp0, 0.)?;
        let check0 = screen(initial, &e0, initial, entropy0, &mut w.property_requests)?;
        let mut r = Resources::new()?;
        let y = r.vector(&initial)?;
        let yp = r.vector(&yp0)?;
        let absolute = [1e-7, 1e-2, 1., 1e-6, 1e-7, 1e-2, 1e-7, 1., 1e-6].map(|v| v * tolerance);
        let atol = r.vector(&absolute)?;
        let mut ids = [0.; N];
        for i in DIFFERENTIAL {
            ids[i] = 1.;
        }
        let id = r.vector(&ids)?;
        let matrix = r.matrix(N as i64, (N * N) as i64)?;
        write_matrix(matrix, e0.jacobian)?;
        let solver = r.solver(y)?;
        r.ida = unsafe { IDACreate(r.context) };
        if r.ida.is_null() {
            return Err("IDACreate null".into());
        }
        checked(
            unsafe { IDASetUserData(r.ida, (&mut *w as *mut Work).cast()) },
            "IDASetUserData",
        )?;
        checked(unsafe { IDAInit(r.ida, residual, 0., y, yp) }, "IDAInit")?;
        checked(
            unsafe { IDASVtolerances(r.ida, 1e-8 * tolerance, atol) },
            "IDA tolerances",
        )?;
        checked(unsafe { IDASetId(r.ida, id) }, "IDA differential id")?;
        checked(
            unsafe { IDASetLinearSolver(r.ida, solver, matrix) },
            "IDA KLU",
        )?;
        checked(
            unsafe { IDASetJacFn(r.ida, jacobian) },
            "IDA analytic Jacobian",
        )?;
        let case_start = Instant::now();
        let mut time = 0.;
        let mut samples = Vec::with_capacity(SAMPLES + 1);
        samples.push(initial);
        let mut maximum = check0.map(f64::abs);
        let mut max_speed: f64 = 0.;
        let mut pressure_feedback: f64 = 0.;
        let mut mass_feedback: f64 = 0.;
        let mut extrema_flow = [0_f64; 2];
        let mut entropy_gain = 0.;
        for sample in 1..=SAMPLES {
            let target = HORIZON * sample as f64 / SAMPLES as f64;
            checked(
                unsafe { IDASetStopTime(r.ida, target) },
                "IDA exact common-time stop",
            )?;
            while time < target {
                if began.elapsed().as_secs_f64() >= budget {
                    return Err(format!("{case}: numerical budget at admitted {time}s"));
                }
                let previous = time;
                let mut returned_time = time;
                let status = unsafe { IDASolve(r.ida, target, &mut returned_time, y, yp, 2) };
                w.returned_time = returned_time;
                w.returned_state = Some(vector_values(y)?);
                if status < 0 || status > 1 {
                    return Err(format!(
                        "{case}: IDA {status} after admitted {previous}s: {:?}",
                        w.last_error
                    ));
                }
                if !returned_time.is_finite() || returned_time <= previous || returned_time > target
                {
                    return Err("Invalid returned time".into());
                }
                let state = vector_values(y)?;
                let derivative = vector_values(yp)?;
                let e = w.evaluation(state, derivative, 0.)?;
                let screens = screen(state, &e, initial, entropy0, &mut w.property_requests)?;
                // Solver attainment becomes independently admitted state ONLY here.
                time = returned_time;
                w.admitted_time = time;
                w.admitted_state = state;
                for (m, v) in maximum.iter_mut().zip(screens) {
                    *m = m.max(v.abs());
                }
                entropy_gain = screens[6];
                max_speed = max_speed.max(e.velocity.abs());
                pressure_feedback = pressure_feedback.max((state[2] - ph).abs());
                mass_feedback = mass_feedback.max((state[0] - mh).abs());
                extrema_flow[0] = extrema_flow[0].min(e.mass_flow);
                extrema_flow[1] = extrema_flow[1].max(e.mass_flow);
                if time == target {
                    samples.push(state);
                }
            }
        }
        if samples.len() != SAMPLES + 1
            || max_speed <= 1e-6
            || pressure_feedback <= 10.
            || mass_feedback <= 1e-5
            || extrema_flow[0] >= -1e-5
            || extrema_flow[1] <= 1e-5
        {
            return Err(format!(
                "{case}: insufficient resolved finite feedback: speed={max_speed}, pressure={pressure_feedback}, mass={mass_feedback}, flow={extrema_flow:?}"
            ));
        }
        let mut steps = 0;
        checked(unsafe { IDAGetNumSteps(r.ida, &mut steps) }, "IDA steps")?;
        let mut failures = 0;
        checked(
            unsafe { IDAGetNumNonlinSolvConvFails(r.ida, &mut failures) },
            "IDA nonlinear failures",
        )?;
        let result = ResultRun {
            samples,
            wall_seconds: case_start.elapsed().as_secs_f64(),
            steps,
            residuals: w.residuals,
            jacobians: w.jacobians,
            property_requests: w.property_requests,
            max_screens: maximum,
            max_speed,
            max_pressure_feedback: pressure_feedback,
            max_mass_feedback: mass_feedback,
            extrema_flow,
            end_entropy_gain: entropy_gain,
        };
        println!(
            "{{\"case\":\"{case}\",\"tolerance_scale\":{tolerance},\"horizon_s\":{HORIZON},\"wall_seconds\":{},\"steps\":{},\"residuals\":{},\"jacobians\":{},\"property_tuple_requests\":{},\"nonlinear_failures\":{failures},\"max_screens\":{:?},\"max_speed\":{},\"header_pressure_feedback_Pa\":{},\"header_mass_feedback_kg\":{},\"signed_flow_extrema\":{:?},\"entropy_gain_J_per_K\":{},\"final_state\":{:?}}}",
            result.wall_seconds,
            result.steps,
            result.residuals,
            result.jacobians,
            result.property_requests,
            result.max_screens,
            result.max_speed,
            result.max_pressure_feedback,
            result.max_mass_feedback,
            result.extrema_flow,
            result.end_entropy_gain,
            result.samples.last().unwrap()
        );
        drop(r);
        Ok(result)
    })();
    if let Err(message) = &outcome {
        // Retain every failed candidate separately from the last admitted state.
        // Debug string escaping is JSON-compatible for these diagnostic texts.
        let candidate = w
            .returned_state
            .map(|state| format!("{state:?}"))
            .unwrap_or_else(|| "null".into());
        println!(
            "{{\"case\":\"{case}\",\"tolerance_scale\":{tolerance},\"passed\":false,\"failure\":{message:?},\"last_admitted_time_s\":{},\"last_admitted_state\":{:?},\"solver_returned_time_s\":{},\"solver_returned_state\":{},\"residual_callbacks\":{},\"jacobian_callbacks\":{},\"property_tuple_requests\":{},\"callback_errors\":{},\"budget_exhausted\":{}}}",
            w.admitted_time,
            w.admitted_state,
            w.returned_time,
            candidate,
            w.residuals,
            w.jacobians,
            w.property_requests,
            w.errors,
            w.budget_exhausted
        );
    }
    outcome
}
fn run() -> Result<(), String> {
    let began = Instant::now();
    let budget = std::env::args()
        .nth(1)
        .ok_or("Need aggregate numerical allowance seconds")?
        .parse::<f64>()
        .map_err(|_| "Invalid allowance")?;
    if !budget.is_finite() || budget <= 0. {
        return Err("Invalid allowance".into());
    }
    klu_fixture()?;
    for (case, ph, th, pd, td) in [
        ("cold_positive", 15.2e6 + 250., 313.15, 15.2e6, 314.15),
        ("cold_negative", 15.2e6 - 250., 313.15, 15.2e6, 314.15),
        ("hot_positive", 15.2e6 + 250., 599., 15.2e6, 600.),
    ] {
        let normal = run_case(case, ph, th, pd, td, 1., began, budget)?;
        let tighter = run_case(case, ph, th, pd, td, 0.25, began, budget)?;
        let mut difference = [0_f64; N];
        for (a, b) in normal.samples.iter().zip(&tighter.samples) {
            for i in 0..N {
                difference[i] = difference[i].max((a[i] - b[i]).abs());
            }
        }
        // Shared-time physical discrepancy, separate from conservative chart checks.
        let dv = normal
            .samples
            .iter()
            .zip(&tighter.samples)
            .map(|(a, b)| (3. * a[6] / a[4] - 3. * b[6] / b[4]).abs())
            .fold(0_f64, f64::max);
        if difference[2] > 5.
            || difference[7] > 5.
            || difference[3] > 1e-4
            || difference[8] > 1e-4
            || dv > 1e-5
        {
            return Err(format!(
                "{case}: tighter-pair refused {difference:?}, velocity={dv}"
            ));
        }
        println!(
            "{{\"comparison\":\"{case}\",\"common_times\":{},\"max_coordinate_difference\":{difference:?},\"max_velocity_difference_m_per_s\":{dv},\"passed\":true}}",
            normal.samples.len()
        );
    }
    println!(
        "{{\"scope\":\"finite_header_return_entrance_with_laboratory_seals\",\"passed\":true,\"total_wall_seconds\":{},\"no_DOWN_or_circulation_or_host_throughput_claim\":true}}",
        began.elapsed().as_secs_f64()
    );
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

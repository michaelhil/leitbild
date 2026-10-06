//! Offline IDA/KLU library and sealed-liquid heat-receipt witness only.
//! No flow, branch momentum, phase, controller or installed plant is represented.
//! ABI: pinned SUNDIALS 7.5, DOUBLE, INT64, non-MPI serial build.
use leitbild_plant_numerics::fixed_volume_liquid::{
    BalanceRate, Derivative, Evaluation, Input, Trial, Workspace,
};
use leitbild_plant_numerics::{
    CellGeometry, Liquid, LiquidQuery, liquid_batch, storage, storage_jacobian,
};
use std::{
    ffi::{c_int, c_long, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    time::Instant,
};

type Handle = *mut c_void;
type ResidualFn = unsafe extern "C" fn(f64, Handle, Handle, Handle, Handle) -> c_int;
type JacobianFn = unsafe extern "C" fn(
    f64,
    f64,
    Handle,
    Handle,
    Handle,
    Handle,
    Handle,
    Handle,
    Handle,
    Handle,
) -> c_int;

#[link(name = "sundials_core")]
#[link(name = "sundials_nvecserial")]
#[link(name = "sundials_sunmatrixsparse")]
#[link(name = "sundials_sunlinsolklu")]
#[link(name = "sundials_ida")]
unsafe extern "C" {
    fn SUNContext_Create(comm: c_int, out: *mut Handle) -> c_int;
    fn SUNContext_Free(context: *mut Handle) -> c_int;
    fn N_VNew_Serial(length: i64, context: Handle) -> Handle;
    fn N_VGetArrayPointer_Serial(vector: Handle) -> *mut f64;
    fn N_VDestroy_Serial(vector: Handle);
    fn SUNSparseMatrix(
        rows: i64,
        columns: i64,
        entries: i64,
        format: c_int,
        context: Handle,
    ) -> Handle;
    fn SUNSparseMatrix_Data(matrix: Handle) -> *mut f64;
    fn SUNSparseMatrix_IndexValues(matrix: Handle) -> *mut i64;
    fn SUNSparseMatrix_IndexPointers(matrix: Handle) -> *mut i64;
    fn SUNMatDestroy(matrix: Handle);
    fn SUNLinSol_KLU(vector: Handle, matrix: Handle, context: Handle) -> Handle;
    fn SUNLinSolInitialize(solver: Handle) -> c_int;
    fn SUNLinSolSetup(solver: Handle, matrix: Handle) -> c_int;
    fn SUNLinSolSolve(
        solver: Handle,
        matrix: Handle,
        x: Handle,
        b: Handle,
        tolerance: f64,
    ) -> c_int;
    fn SUNLinSolFree(solver: Handle) -> c_int;
    fn IDACreate(context: Handle) -> Handle;
    fn IDAInit(memory: Handle, residual: ResidualFn, t: f64, y: Handle, yp: Handle) -> c_int;
    fn IDASetUserData(memory: Handle, user: Handle) -> c_int;
    fn IDASVtolerances(memory: Handle, relative: f64, absolute: Handle) -> c_int;
    fn IDASetId(memory: Handle, id: Handle) -> c_int;
    fn IDASetLinearSolver(memory: Handle, solver: Handle, matrix: Handle) -> c_int;
    fn IDASetJacFn(memory: Handle, jacobian: JacobianFn) -> c_int;
    fn IDASetStopTime(memory: Handle, stop: f64) -> c_int;
    fn IDASolve(
        memory: Handle,
        tout: f64,
        time: *mut f64,
        y: Handle,
        yp: Handle,
        task: c_int,
    ) -> c_int;
    fn IDAGetNumSteps(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetNumResEvals(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetNumJacEvals(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetNumLinSolvSetups(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetNumErrTestFails(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetNumNonlinSolvIters(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetNumNonlinSolvConvFails(memory: Handle, value: *mut c_long) -> c_int;
    fn IDAGetCurrentTime(memory: Handle, value: *mut f64) -> c_int;
    fn IDAFree(memory: *mut Handle);
}

fn checked(status: c_int, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} returned {status}"))
    }
}

/// Every partially created allocation is owned before the next fallible call.
struct Resources {
    context: Handle,
    vectors: Vec<Handle>,
    matrix: Handle,
    solver: Handle,
    ida: Handle,
}
impl Resources {
    fn new() -> Result<Self, String> {
        let mut out = Self {
            context: ptr::null_mut(),
            vectors: Vec::new(),
            matrix: ptr::null_mut(),
            solver: ptr::null_mut(),
            ida: ptr::null_mut(),
        };
        checked(
            unsafe { SUNContext_Create(0, &mut out.context) },
            "SUNContext_Create",
        )?;
        if out.context.is_null() {
            return Err("SUNContext_Create returned null".into());
        }
        Ok(out)
    }
    fn vector(&mut self, values: &[f64]) -> Result<Handle, String> {
        let vector = unsafe { N_VNew_Serial(values.len() as i64, self.context) };
        if vector.is_null() {
            return Err("N_VNew_Serial returned null".into());
        }
        self.vectors.push(vector);
        let data = unsafe { N_VGetArrayPointer_Serial(vector) };
        if data.is_null() {
            return Err("Serial vector has null data".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(values.as_ptr(), data, values.len());
        }
        Ok(vector)
    }
    fn matrix(&mut self, n: i64, entries: i64) -> Result<Handle, String> {
        self.matrix = unsafe { SUNSparseMatrix(n, n, entries, 0, self.context) };
        if self.matrix.is_null() {
            Err("SUNSparseMatrix(CSC) returned null".into())
        } else {
            Ok(self.matrix)
        }
    }
    fn solver(&mut self, vector: Handle) -> Result<Handle, String> {
        self.solver = unsafe { SUNLinSol_KLU(vector, self.matrix, self.context) };
        if self.solver.is_null() {
            Err("Actual SUNLinSol_KLU constructor returned null".into())
        } else {
            Ok(self.solver)
        }
    }
}
impl Drop for Resources {
    fn drop(&mut self) {
        unsafe {
            if !self.ida.is_null() {
                IDAFree(&mut self.ida);
            }
            if !self.solver.is_null() {
                SUNLinSolFree(self.solver);
            }
            if !self.matrix.is_null() {
                SUNMatDestroy(self.matrix);
            }
            for vector in self.vectors.drain(..) {
                N_VDestroy_Serial(vector);
            }
            if !self.context.is_null() {
                SUNContext_Free(&mut self.context);
            }
        }
    }
}

fn matrix_data(
    matrix: Handle,
    pointers: &[i64],
    indices: &[i64],
    values: &[f64],
) -> Result<(), String> {
    if matrix.is_null() || indices.len() != values.len() {
        return Err("Invalid owned CSC input".into());
    }
    let (p, i, v) = unsafe {
        (
            SUNSparseMatrix_IndexPointers(matrix),
            SUNSparseMatrix_IndexValues(matrix),
            SUNSparseMatrix_Data(matrix),
        )
    };
    if p.is_null() || i.is_null() || v.is_null() {
        return Err("Owned CSC allocation has null buffer".into());
    }
    unsafe {
        ptr::copy_nonoverlapping(pointers.as_ptr(), p, pointers.len());
        ptr::copy_nonoverlapping(indices.as_ptr(), i, indices.len());
        ptr::copy_nonoverlapping(values.as_ptr(), v, values.len());
    }
    Ok(())
}

fn vector4(vector: Handle) -> Result<[f64; 4], String> {
    if vector.is_null() {
        return Err("Null callback vector".into());
    }
    let data = unsafe { N_VGetArrayPointer_Serial(vector) };
    if data.is_null() {
        return Err("Null callback serial data".into());
    }
    // Only used with the four-coordinate vectors owned by this example/IDA.
    Ok(unsafe { [*data, *data.add(1), *data.add(2), *data.add(3)] })
}

fn klu_fixture() -> Result<(f64, f64), String> {
    let mut r = Resources::new()?;
    let x = r.vector(&[0., 0., 0.])?;
    let b = r.vector(&[8., -4., 14.])?;
    let a = r.matrix(3, 7)?;
    // A=[[2,-3,0],[4,1,-2],[-1,0,5]], exact x=[1,-2,3].
    matrix_data(
        a,
        &[0, 3, 5, 7],
        &[0, 1, 2, 0, 1, 1, 2],
        &[2., 4., -1., -3., 1., -2., 5.],
    )?;
    let solver = r.solver(x)?;
    checked(
        unsafe { SUNLinSolInitialize(solver) },
        "KLU fixture initialize",
    )?;
    checked(
        unsafe { SUNLinSolSetup(solver, a) },
        "KLU fixture factorization",
    )?;
    checked(
        unsafe { SUNLinSolSolve(solver, a, x, b, 0.) },
        "KLU fixture solve",
    )?;
    let data = unsafe { N_VGetArrayPointer_Serial(x) };
    if data.is_null() {
        return Err("KLU fixture solution data null".into());
    }
    let answer = unsafe { [*data, *data.add(1), *data.add(2)] };
    let errors = [answer[0] - 1., answer[1] + 2., answer[2] - 3.];
    let residual = [
        2. * answer[0] - 3. * answer[1] - 8.,
        4. * answer[0] + answer[1] - 2. * answer[2] + 4.,
        -answer[0] + 5. * answer[2] - 14.,
    ];
    let error = errors.into_iter().map(f64::abs).fold(0., f64::max);
    let defect = residual.into_iter().map(f64::abs).fold(0., f64::max);
    if !answer.iter().all(|x| x.is_finite()) || error > 1e-12 || defect > 1e-12 {
        return Err(format!(
            "KLU signed nonsymmetric fixture refusal: error={error}, residual={defect}"
        ));
    }
    Ok((error, defect))
}

struct Work {
    geometry: CellGeometry,
    heat_watts: f64,
    workspace: Workspace,
    start: Instant,
    budget_seconds: f64,
    residual_callbacks: u64,
    jacobian_callbacks: u64,
    diagnostic_evaluations: u64,
    block_evaluation_requests: u64,
    callback_errors: u64,
    last_error: Option<String>,
    budget_exhausted: bool,
}
impl Work {
    fn evaluate(&mut self, y: [f64; 4], yp: [f64; 4], cj: f64) -> Result<Evaluation, String> {
        self.block_evaluation_requests += 1;
        let input = Input {
            geometry: self.geometry,
            trial: Trial {
                mass: y[0],
                energy: y[1],
                pressure: y[2],
                temperature: y[3],
            },
            derivative: Derivative {
                mass_rate: yp[0],
                energy_rate: yp[1],
                pressure_rate: yp[2],
                temperature_rate: yp[3],
            },
            balance: BalanceRate {
                mass_kg_per_second: 0.,
                energy_watts: self.heat_watts,
            },
        };
        let mut output = [Evaluation::default()];
        self.workspace
            .evaluate(&[input], cj, &mut output)
            .map_err(|e| format!("Fixed-volume owner {}: {}", e.index, e.message))?;
        Ok(output[0])
    }
    fn budget(&mut self) -> Result<(), String> {
        if self.start.elapsed().as_secs_f64() >= self.budget_seconds {
            self.budget_exhausted = true;
            return Err("Declared wall-clock allowance exhausted".into());
        }
        Ok(())
    }
}

/// Catch every Rust unwind at the C boundary; no callback can unwind into IDA.
fn callback(
    user: Handle,
    is_jacobian: bool,
    operation: impl FnOnce(&mut Work) -> Result<(), String>,
) -> c_int {
    if user.is_null() {
        return -1;
    }
    let work = unsafe { &mut *user.cast::<Work>() };
    if is_jacobian {
        work.jacobian_callbacks += 1;
    } else {
        work.residual_callbacks += 1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        work.budget()?;
        operation(work)
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(message)) => {
            work.callback_errors += 1;
            work.last_error = Some(message);
            if work.budget_exhausted { -1 } else { 1 }
        }
        Err(_) => {
            work.callback_errors += 1;
            work.last_error = Some("Rust panic caught at IDA callback boundary".into());
            -1
        }
    }
}

unsafe extern "C" fn residual(
    _t: f64,
    y: Handle,
    yp: Handle,
    output: Handle,
    user: Handle,
) -> c_int {
    callback(user, false, |work| {
        let result = work.evaluate(vector4(y)?, vector4(yp)?, 0.)?;
        if output.is_null() {
            return Err("Null residual vector".into());
        }
        let data = unsafe { N_VGetArrayPointer_Serial(output) };
        if data.is_null() {
            return Err("Null residual data".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(result.residual.as_ptr(), data, 4);
        }
        Ok(())
    })
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
    callback(user, true, |work| {
        let j = work.evaluate(vector4(y)?, vector4(yp)?, cj)?.jacobian;
        matrix_data(
            matrix,
            &[0, 2, 4, 6, 8],
            &[0, 2, 1, 3, 2, 3, 2, 3],
            &[
                j[0][0], j[2][0], j[1][1], j[3][1], j[2][2], j[3][2], j[2][3], j[3][3],
            ],
        )
    })
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn statistic(
    memory: Handle,
    getter: unsafe extern "C" fn(Handle, *mut c_long) -> c_int,
    label: &str,
) -> Result<c_long, String> {
    let mut value = 0;
    checked(unsafe { getter(memory, &mut value) }, label)?;
    Ok(value)
}

/// Prospective sealed-store component admission, not plant temporal accuracy.
/// Corrections derive from the actual forward chart at the returned state.
fn screens(
    y: [f64; 4],
    evaluation: Evaluation,
    initial: [f64; 4],
    heat: f64,
    time: f64,
) -> Result<[f64; 4], String> {
    let j = evaluation.jacobian;
    let (mp, mt, ep, et) = (-j[2][2], -j[2][3], -j[3][2], -j[3][3]);
    let det = mp * et - mt * ep;
    if !det.is_finite() || det <= 0. {
        return Err("Returned forward chart lost stable rank".into());
    }
    let rm = evaluation.residual[2];
    let re = evaluation.residual[3];
    let values = [
        y[0] - initial[0],
        y[1] - initial[1] - heat * time,
        (rm * et - mt * re) / det,
        (mp * re - rm * ep) / det,
    ];
    if !values.iter().all(|v| v.is_finite()) {
        return Err("Nonfinite sealed-store admission quantity".into());
    }
    Ok(values)
}

fn screen_json(values: [f64; 4]) -> String {
    format!(
        "{{\"mass_ledger_defect_kg\":{},\"energy_ledger_defect_J\":{},\"chart_pressure_correction_Pa\":{},\"chart_temperature_correction_K\":{}}}",
        values[0], values[1], values[2], values[3]
    )
}

fn run() -> Result<(), String> {
    let start = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 7 {
        return Err(
            "Usage: fixed-volume-ida V_m3 z_m p_Pa T_K imposed_heat_W horizon_s wall_budget_s"
                .into(),
        );
    }
    let mut values = [0.; 7];
    for (out, argument) in values.iter_mut().zip(&args) {
        *out = argument
            .parse::<f64>()
            .map_err(|_| format!("Invalid numeric argument: {argument}"))?;
    }
    if !values.iter().all(|v| v.is_finite())
        || values[0] <= 0.
        || values[2] <= 0.
        || values[3] <= 0.
        || values[4] <= 0.
        || values[5] <= 0.
        || values[6] <= 0.
    {
        return Err("Invalid positive heat-only witness inputs".into());
    }
    let [
        volume,
        elevation,
        pressure,
        temperature,
        heat,
        horizon,
        budget,
    ] = values;
    let (fixture_error, fixture_residual) = klu_fixture()?;
    let geometry = CellGeometry { volume, elevation };
    let mut liquid = [Liquid::default()];
    liquid_batch(
        &[LiquidQuery {
            pressure,
            temperature,
        }],
        &mut liquid,
    )
    .map_err(|e| e.message)?;
    let initial = storage(geometry, liquid[0], 0., 0.)?;
    let tangent = storage_jacobian(geometry, liquid[0], 0., 0.)?;
    let [pdot, tdot] = tangent.pressure_temperature_increment(0., heat)?;
    let y0 = [initial.mass, initial.energy, pressure, temperature];
    let yp0 = [0., heat, pdot, tdot];
    let mut work = Box::new(Work {
        geometry,
        heat_watts: heat,
        workspace: Workspace::new(1),
        start,
        budget_seconds: budget,
        residual_callbacks: 0,
        jacobian_callbacks: 0,
        diagnostic_evaluations: 0,
        block_evaluation_requests: 0,
        callback_errors: 0,
        last_error: None,
        budget_exhausted: false,
    });
    let initial_evaluation = work.evaluate(y0, yp0, 0.)?;
    work.diagnostic_evaluations += 1;
    let mut r = Resources::new()?;
    let y = r.vector(&y0)?;
    let yp = r.vector(&yp0)?;
    // Physical coordinates, absolute allowances disclosed in the receipt.
    let atol_values = [1e-7, 1e-2, 1e-2, 1e-7];
    let atol = r.vector(&atol_values)?;
    let id = r.vector(&[1., 1., 0., 0.])?;
    let matrix = r.matrix(4, 8)?;
    let j = initial_evaluation.jacobian;
    matrix_data(
        matrix,
        &[0, 2, 4, 6, 8],
        &[0, 2, 1, 3, 2, 3, 2, 3],
        &[
            j[0][0], j[2][0], j[1][1], j[3][1], j[2][2], j[3][2], j[2][3], j[3][3],
        ],
    )?;
    let solver = r.solver(y)?;
    r.ida = unsafe { IDACreate(r.context) };
    if r.ida.is_null() {
        return Err("IDACreate returned null".into());
    }
    checked(
        unsafe { IDASetUserData(r.ida, (&mut *work as *mut Work).cast()) },
        "IDASetUserData",
    )?;
    checked(unsafe { IDAInit(r.ida, residual, 0., y, yp) }, "IDAInit")?;
    checked(
        unsafe { IDASVtolerances(r.ida, 1e-8, atol) },
        "IDASVtolerances",
    )?;
    checked(unsafe { IDASetId(r.ida, id) }, "IDASetId")?;
    // Algebraic error control remains enabled; no IDASetSuppressAlg call.
    checked(
        unsafe { IDASetLinearSolver(r.ida, solver, matrix) },
        "IDASetLinearSolver",
    )?;
    checked(unsafe { IDASetJacFn(r.ida, jacobian) }, "IDASetJacFn")?;
    checked(unsafe { IDASetStopTime(r.ida, horizon) }, "IDASetStopTime")?;
    let mut accepted_time = 0.;
    let mut accepted_y = y0;
    let mut accepted_yp = yp0;
    let mut accepted_evaluation = initial_evaluation;
    let mut max_mass_chart: f64 = initial_evaluation.residual[2].abs();
    let mut max_energy_chart: f64 = initial_evaluation.residual[3].abs();
    let limits = [1e-6, 0.1, 5., 1e-4];
    let initial_screens = screens(y0, initial_evaluation, y0, heat, 0.)?;
    if initial_screens
        .iter()
        .zip(limits)
        .any(|(v, limit)| v.abs() > limit)
    {
        return Err(format!(
            "Initial component admission refusal: {}",
            screen_json(initial_screens)
        ));
    }
    let mut maximum_screens = initial_screens.map(f64::abs);
    let mut accepted_screens = initial_screens;
    let mut refusal = String::from("null");
    let mut ida_status = 0;
    let status;
    loop {
        if work.budget().is_err() {
            status = "budget_exhausted";
            break;
        }
        let mut returned_time = accepted_time;
        ida_status = unsafe { IDASolve(r.ida, horizon, &mut returned_time, y, yp, 2) };
        if ida_status < 0 {
            status = if work.budget_exhausted {
                "budget_exhausted"
            } else {
                "ida_failure"
            };
            break;
        }
        if ida_status > 1 {
            status = "unexpected_ida_return";
            break;
        }
        let next_y = vector4(y)?;
        let next_yp = vector4(yp)?;
        let next_evaluation = match work.evaluate(next_y, next_yp, 0.) {
            Ok(value) => value,
            Err(message) => {
                work.last_error = Some(message);
                status = "accepted_state_refusal";
                break;
            }
        };
        work.diagnostic_evaluations += 1;
        if !returned_time.is_finite() || returned_time <= accepted_time || returned_time > horizon {
            status = "invalid_accepted_time";
            break;
        }
        let candidate_screens = match screens(next_y, next_evaluation, y0, heat, returned_time) {
            Ok(value) => value,
            Err(message) => {
                work.last_error = Some(message);
                status = "component_admission_refusal";
                break;
            }
        };
        for (maximum, value) in maximum_screens.iter_mut().zip(candidate_screens) {
            *maximum = maximum.max(value.abs());
        }
        max_mass_chart = max_mass_chart.max(next_evaluation.residual[2].abs());
        max_energy_chart = max_energy_chart.max(next_evaluation.residual[3].abs());
        if candidate_screens
            .iter()
            .zip(limits)
            .any(|(value, limit)| value.abs() > limit)
        {
            refusal = format!(
                "{{\"solver_returned_time_s\":{returned_time},\"observed\":{}}}",
                screen_json(candidate_screens)
            );
            status = "component_admission_refusal";
            break;
        }
        // IDA success becomes component-admitted time only after these screens.
        accepted_time = returned_time;
        accepted_y = next_y;
        accepted_yp = next_yp;
        accepted_evaluation = next_evaluation;
        accepted_screens = candidate_screens;
        if accepted_time == horizon {
            status = "completed";
            break;
        }
    }
    let getters: [(unsafe extern "C" fn(Handle, *mut c_long) -> c_int, &str); 7] = [
        (IDAGetNumSteps, "steps"),
        (IDAGetNumResEvals, "residuals"),
        (IDAGetNumJacEvals, "jacobians"),
        (IDAGetNumLinSolvSetups, "linear_setups"),
        (IDAGetNumErrTestFails, "error_test_failures"),
        (IDAGetNumNonlinSolvIters, "nonlinear_iterations"),
        (IDAGetNumNonlinSolvConvFails, "nonlinear_failures"),
    ];
    let mut stats = String::new();
    for (i, (getter, name)) in getters.into_iter().enumerate() {
        let value = statistic(r.ida, getter, name)?;
        if i > 0 {
            stats.push(',');
        }
        stats.push_str(&format!("\"{name}\":{value}"));
    }
    let error = work
        .last_error
        .as_deref()
        .map(json_string)
        .unwrap_or_else(|| "null".into());
    let receipt_heat = heat * accepted_time;
    let energy_ledger_defect = accepted_y[1] - initial.energy - receipt_heat;
    let mass_ledger_defect = accepted_y[0] - initial.mass;
    let mut solver_attained_time = 0.;
    checked(
        unsafe { IDAGetCurrentTime(r.ida, &mut solver_attained_time) },
        "IDAGetCurrentTime",
    )?;
    if !solver_attained_time.is_finite() {
        return Err("IDA returned nonfinite current time".into());
    }
    let passed = status == "completed" && accepted_time == horizon;
    let accepted_screen_json = screen_json(accepted_screens);
    let maximum_screen_json = screen_json(maximum_screens);
    // Separate numerical solver attainment from independently admitted time.
    // A component refusal can leave IDA ahead of the last admitted snapshot.
    let attainment_json = format!(
        "{{\"solver_attained_time_s\":{solver_attained_time},\"component_admitted_time_s\":{accepted_time}}}"
    );
    stats.push_str(&format!(",\"attainment\":{attainment_json}"));
    println!(
        "{{\"scope\":\"sealed_single_liquid_imposed_heat_receipt\",\"status\":{},\"passed\":{passed},\"ida_return\":{ida_status},\"accepted_time_s\":{accepted_time},\"requested_horizon_s\":{horizon},\"wall_seconds\":{},\"wall_budget_s\":{budget},\"klu_signed_fixture\":{{\"passed\":true,\"solution_error\":{fixture_error},\"residual\":{fixture_residual}}},\"input\":{{\"V_m3\":{volume},\"z_m\":{elevation},\"p_Pa\":{pressure},\"T_K\":{temperature},\"prescribed_heat_W\":{heat}}},\"tolerances\":{{\"relative\":1e-8,\"absolute\":[1e-7,1e-2,1e-2,1e-7],\"algebraic_error_control\":true}},\"component_limits\":{{\"mass_ledger_kg\":1e-6,\"energy_ledger_J\":0.1,\"chart_pressure_correction_Pa\":5,\"chart_temperature_correction_K\":1e-4}},\"accepted_screens\":{accepted_screen_json},\"maximum_observed_absolute_screens\":{maximum_screen_json},\"refusal\":{refusal},\"initial_state\":{:?},\"initial_derivative\":{:?},\"accepted_state\":{:?},\"accepted_derivative\":{:?},\"heat_receipt_J\":{receipt_heat},\"mass_ledger_defect_kg\":{mass_ledger_defect},\"energy_ledger_defect_J\":{energy_ledger_defect},\"accepted_residual\":{:?},\"max_mass_chart_defect_kg\":{max_mass_chart},\"max_energy_chart_defect_J\":{max_energy_chart},\"callbacks\":{{\"residual\":{},\"jacobian\":{},\"diagnostic_evaluations\":{},\"property_tuple_request_upper_bound\":{},\"callback_errors\":{}}},\"solver\":{{{stats}}},\"last_callback_error\":{error}}}",
        json_string(status),
        start.elapsed().as_secs_f64(),
        y0,
        yp0,
        accepted_y,
        accepted_yp,
        accepted_evaluation.residual,
        work.residual_callbacks,
        work.jacobian_callbacks,
        work.diagnostic_evaluations,
        1 + work.block_evaluation_requests,
        work.callback_errors
    );
    // Resources die while callback Work is still owned; IDA never retains a
    // pointer beyond IDAFree, and failed candidate vectors were not admitted.
    drop(r);
    if status == "completed" {
        Ok(())
    } else {
        Err(format!("Witness stopped with {status}"))
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", error);
        std::process::exit(1);
    }
}

//! Narrow pinned SUNDIALS serial DOUBLE/INT64 + KLU ownership for offline examples.
//! Shared to avoid duplicating unsafe ABI/resource cleanup between witnesses.
//! No integrator policy, physics, fallback backend or production registration.
use std::{
    ffi::{CStr, c_char, c_int, c_long, c_void},
    ptr,
};

pub(crate) type Handle = *mut c_void;
unsafe extern "C" {
    fn leitbild_sundials_versions(
        compiled: *mut c_int,
        linked: *mut c_int,
        label: *mut c_char,
        capacity: c_int,
    ) -> c_int;
    fn leitbild_sunnewton_convergence(
        solver: Handle,
        test: *mut Option<ConvergenceTestFn>,
        data: *mut Handle,
    ) -> c_int;
}
pub(crate) type ConvergenceTestFn =
    unsafe extern "C" fn(Handle, Handle, Handle, f64, Handle, Handle) -> c_int;
#[derive(Clone, Copy)]
pub(crate) struct StockConvergence {
    pub test: ConvergenceTestFn,
    pub data: Handle,
}
/// Capture after IDASetNonlinearSolver installs its own CTest, before wrapping.
pub(crate) fn stock_convergence(solver: Handle) -> Result<StockConvergence, String> {
    let mut test = None;
    let mut data = ptr::null_mut();
    checked(
        unsafe { leitbild_sunnewton_convergence(solver, &mut test, &mut data) },
        "Public Newton convergence accessor",
    )?;
    Ok(StockConvergence {
        test: test.ok_or("Null stock Newton convergence test")?,
        data,
    })
}

fn checked_sundials_version(
    status: c_int,
    compiled: [c_int; 3],
    linked: [c_int; 3],
    label: &[u8],
) -> Result<(), String> {
    if status != 0 || compiled != [7, 5, 0] || linked != compiled || !label.is_empty() {
        return Err(format!(
            "SUNDIALS ABI/version refusal: status={status}, compiled={compiled:?}, linked={linked:?}, label={label:?}"
        ));
    }
    Ok(())
}

/// Header ABI facts are compiled in C; runtime core version is checked before
/// any solver allocation. Same-version library/patch identity belongs to Bun's
/// actual linked-closure admission, not this version check.
fn check_sundials_runtime() -> Result<(), String> {
    let mut compiled = [0; 3];
    let mut linked = [0; 3];
    let mut label = [0 as c_char; 64];
    let status = unsafe {
        leitbild_sundials_versions(
            compiled.as_mut_ptr(),
            linked.as_mut_ptr(),
            label.as_mut_ptr(),
            label.len() as c_int,
        )
    };
    // Do not trust an unterminated native version label.
    if !label.contains(&0) {
        return Err("Unterminated SUNDIALS runtime version label".into());
    }
    let label = unsafe { CStr::from_ptr(label.as_ptr()) }.to_bytes();
    checked_sundials_version(status, compiled, linked, label)
}
pub(crate) type ATimesFn = unsafe extern "C" fn(Handle, Handle, Handle) -> c_int;
pub(crate) type LinearPrecSetupFn = unsafe extern "C" fn(Handle) -> c_int;
pub(crate) type LinearPrecSolveFn =
    unsafe extern "C" fn(Handle, Handle, Handle, f64, c_int) -> c_int;
pub(crate) type ResidualFn = unsafe extern "C" fn(f64, Handle, Handle, Handle, Handle) -> c_int;
pub(crate) type JacobianFn = unsafe extern "C" fn(
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
pub(crate) type PrecSetupFn =
    unsafe extern "C" fn(f64, Handle, Handle, Handle, f64, Handle) -> c_int;
pub(crate) type PrecSolveFn =
    unsafe extern "C" fn(f64, Handle, Handle, Handle, Handle, Handle, f64, f64, Handle) -> c_int;
pub(crate) type JacTimesFn = unsafe extern "C" fn(
    f64,
    Handle,
    Handle,
    Handle,
    Handle,
    Handle,
    f64,
    Handle,
    Handle,
    Handle,
) -> c_int;

#[link(name = "sundials_core")]
#[link(name = "sundials_nvecserial")]
#[link(name = "sundials_sunmatrixsparse")]
#[link(name = "sundials_sunlinsolklu")]
#[link(name = "sundials_sunlinsolspgmr")]
#[link(name = "sundials_sunnonlinsolnewton")]
#[link(name = "sundials_ida")]
unsafe extern "C" {
    pub(crate) fn SUNContext_Create(comm: c_int, out: *mut Handle) -> c_int;
    pub(crate) fn SUNContext_Free(context: *mut Handle) -> c_int;
    pub(crate) fn N_VNew_Serial(length: i64, context: Handle) -> Handle;
    pub(crate) fn N_VGetArrayPointer_Serial(vector: Handle) -> *mut f64;
    pub(crate) fn N_VGetLength_Serial(vector: Handle) -> i64;
    pub(crate) fn N_VDestroy_Serial(vector: Handle);
    pub(crate) fn SUNSparseMatrix(
        rows: i64,
        columns: i64,
        entries: i64,
        format: c_int,
        context: Handle,
    ) -> Handle;
    pub(crate) fn SUNSparseMatrix_Data(matrix: Handle) -> *mut f64;
    pub(crate) fn SUNSparseMatrix_IndexValues(matrix: Handle) -> *mut i64;
    pub(crate) fn SUNSparseMatrix_IndexPointers(matrix: Handle) -> *mut i64;
    pub(crate) fn SUNSparseMatrix_Rows(matrix: Handle) -> i64;
    pub(crate) fn SUNSparseMatrix_Columns(matrix: Handle) -> i64;
    pub(crate) fn SUNSparseMatrix_NNZ(matrix: Handle) -> i64;
    pub(crate) fn SUNMatDestroy(matrix: Handle);
    pub(crate) fn SUNLinSol_KLU(vector: Handle, matrix: Handle, context: Handle) -> Handle;
    pub(crate) fn SUNLinSol_SPGMR(
        vector: Handle,
        pretype: c_int,
        maxl: c_int,
        context: Handle,
    ) -> Handle;
    pub(crate) fn SUNLinSol_SPGMRSetMaxRestarts(solver: Handle, restarts: c_int) -> c_int;
    pub(crate) fn SUNLinSolInitialize(solver: Handle) -> c_int;
    pub(crate) fn SUNLinSolSetATimes(solver: Handle, data: Handle, atimes: ATimesFn) -> c_int;
    pub(crate) fn SUNLinSolSetPreconditioner(
        solver: Handle,
        data: Handle,
        setup: Option<LinearPrecSetupFn>,
        solve: LinearPrecSolveFn,
    ) -> c_int;
    pub(crate) fn SUNLinSolSetScalingVectors(solver: Handle, left: Handle, right: Handle) -> c_int;
    pub(crate) fn SUNLinSolSetZeroGuess(solver: Handle, zero: c_int) -> c_int;
    pub(crate) fn SUNLinSolNumIters(solver: Handle) -> c_int;
    pub(crate) fn SUNLinSolResNorm(solver: Handle) -> f64;
    pub(crate) fn SUNLinSolSetup(solver: Handle, matrix: Handle) -> c_int;
    pub(crate) fn SUNLinSolSolve(
        solver: Handle,
        matrix: Handle,
        x: Handle,
        b: Handle,
        tolerance: f64,
    ) -> c_int;
    pub(crate) fn SUNLinSolFree(solver: Handle) -> c_int;
    pub(crate) fn IDACreate(context: Handle) -> Handle;
    pub(crate) fn IDAInit(
        memory: Handle,
        residual: ResidualFn,
        t: f64,
        y: Handle,
        yp: Handle,
    ) -> c_int;
    pub(crate) fn IDASetUserData(memory: Handle, user: Handle) -> c_int;
    pub(crate) fn SUNNonlinSol_Newton(vector: Handle, context: Handle) -> Handle;
    pub(crate) fn SUNNonlinSolFree(solver: Handle) -> c_int;
    pub(crate) fn SUNNonlinSolSetConvTestFn(
        solver: Handle,
        test: ConvergenceTestFn,
        data: Handle,
    ) -> c_int;
    pub(crate) fn IDASetNonlinearSolver(memory: Handle, solver: Handle) -> c_int;
    pub(crate) fn IDAGetNonlinearSystemData(
        memory: Handle,
        time: *mut f64,
        y_pred: *mut Handle,
        yp_pred: *mut Handle,
        y: *mut Handle,
        yp: *mut Handle,
        residual: *mut Handle,
        cj: *mut f64,
        user: *mut Handle,
    ) -> c_int;
    pub(crate) fn IDASetLSNormFactor(memory: Handle, factor: f64) -> c_int;
    pub(crate) fn IDASetEpsLin(memory: Handle, factor: f64) -> c_int;
    pub(crate) fn IDASetNonlinConvCoef(memory: Handle, coefficient: f64) -> c_int;
    pub(crate) fn IDASVtolerances(memory: Handle, relative: f64, absolute: Handle) -> c_int;
    pub(crate) fn IDASetId(memory: Handle, id: Handle) -> c_int;
    pub(crate) fn IDASetConstraints(memory: Handle, constraints: Handle) -> c_int;
    pub(crate) fn IDASetLinearSolver(memory: Handle, solver: Handle, matrix: Handle) -> c_int;
    pub(crate) fn IDASetJacFn(memory: Handle, jacobian: JacobianFn) -> c_int;
    pub(crate) fn IDASetJacTimes(
        memory: Handle,
        setup: Option<PrecSetupFn>,
        product: JacTimesFn,
    ) -> c_int;
    pub(crate) fn IDASetPreconditioner(
        memory: Handle,
        setup: PrecSetupFn,
        solve: PrecSolveFn,
    ) -> c_int;
    pub(crate) fn IDACalcIC(memory: Handle, option: c_int, tout: f64) -> c_int;
    pub(crate) fn IDAGetConsistentIC(memory: Handle, y: Handle, yp: Handle) -> c_int;
    pub(crate) fn IDASetStopTime(memory: Handle, stop: f64) -> c_int;
    pub(crate) fn IDASolve(
        memory: Handle,
        tout: f64,
        time: *mut f64,
        y: Handle,
        yp: Handle,
        task: c_int,
    ) -> c_int;
    pub(crate) fn IDAGetNumSteps(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumResEvals(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumJacEvals(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinSolvSetups(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumErrTestFails(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumNonlinSolvIters(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumNonlinSolvConvFails(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetCurrentTime(memory: Handle, value: *mut f64) -> c_int;
    pub(crate) fn IDAGetActualInitStep(memory: Handle, value: *mut f64) -> c_int;
    pub(crate) fn IDAGetCurrentStep(memory: Handle, value: *mut f64) -> c_int;
    pub(crate) fn IDAGetLastStep(memory: Handle, value: *mut f64) -> c_int;
    pub(crate) fn IDAGetCurrentCj(memory: Handle, value: *mut f64) -> c_int;
    pub(crate) fn IDAGetDky(memory: Handle, time: f64, order: c_int, output: Handle) -> c_int;
    pub(crate) fn IDAGetNumPrecEvals(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumPrecSolves(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinIters(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumLinConvFails(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAGetNumJtimesEvals(memory: Handle, value: *mut c_long) -> c_int;
    pub(crate) fn IDAFree(memory: *mut Handle);
}

pub(crate) fn checked(status: c_int, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} returned {status}"))
    }
}

/// A nonnegative IDASolve return never overrides a sticky fatal callback.
/// Pinned 7.5 idaLsSolve does not map every SUNLS_ATIMES failure status.
/// https://github.com/LLNL/sundials/blob/v7.5.0/src/ida/ida_ls.c
pub(crate) fn checked_ida_step(status: c_int, fatal_callback: Option<&str>) -> Result<(), String> {
    if status < 0 || fatal_callback.is_some() {
        Err(format!(
            "IDASolve returned {status}; fatal callback={fatal_callback:?}"
        ))
    } else {
        Ok(())
    }
}

/// Read IDA's retained endpoint polynomial, without overwriting its raw
/// ONE_STEP output/work vectors. Pinned 7.5 IDANls can correct `ee` for a
/// small inequality violation without updating raw `yy/yp`; IDACompleteStep
/// then updates retained `phi`. k=1 is the polynomial derivative, NOT a
/// promise of the Newton-stage/BDF residual derivative on variable steps.
/// https://github.com/LLNL/sundials/blob/v7.5.0/src/ida/ida.c
pub(crate) fn retained_endpoint(
    memory: Handle,
    time: f64,
    raw_y: Handle,
    raw_yp: Handle,
    retained_y: Handle,
    retained_yp: Handle,
) -> Result<(), String> {
    if memory.is_null()
        || !time.is_finite()
        || raw_y.is_null()
        || raw_yp.is_null()
        || raw_y == raw_yp
        || retained_y.is_null()
        || retained_yp.is_null()
        || retained_y == retained_yp
        || [raw_y, raw_yp].contains(&retained_y)
        || [raw_y, raw_yp].contains(&retained_yp)
    {
        return Err("Invalid/aliased retained IDA endpoint buffers".into());
    }
    let length = unsafe { N_VGetLength_Serial(raw_y) };
    if length <= 0
        || [raw_yp, retained_y, retained_yp]
            .iter()
            .any(|&v| unsafe { N_VGetLength_Serial(v) } != length)
    {
        return Err("Mismatched retained IDA endpoint vector dimensions".into());
    }
    let mut current = f64::NAN;
    checked(
        unsafe { IDAGetCurrentTime(memory, &mut current) },
        "IDAGetCurrentTime retained endpoint",
    )?;
    if time != current {
        return Err(format!(
            "Requested retained endpoint time {time:e} is not current IDA time {current:e}"
        ));
    }
    checked(
        unsafe { IDAGetDky(memory, time, 0, retained_y) },
        "IDAGetDky retained endpoint state",
    )?;
    checked(
        unsafe { IDAGetDky(memory, time, 1, retained_yp) },
        "IDAGetDky retained endpoint polynomial derivative",
    )?;
    for vector in [retained_y, retained_yp] {
        let data = unsafe { N_VGetArrayPointer_Serial(vector) };
        if data.is_null()
            || unsafe { std::slice::from_raw_parts(data, length as usize) }
                .iter()
                .any(|v| !v.is_finite())
        {
            return Err("Nonfinite retained IDA endpoint state/derivative".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod retained_endpoint_tests {
    use super::*;
    #[test]
    fn selected_header_and_linked_runtime_versions_match() {
        check_sundials_runtime().unwrap();
        assert!(checked_sundials_version(0, [7, 5, 0], [7, 5, 0], b"").is_ok());
        for (status, compiled, linked, label) in [
            (1, [7, 5, 0], [7, 5, 0], b"".as_slice()),
            (0, [7, 9, 0], [7, 9, 0], b"".as_slice()),
            (0, [7, 5, 0], [7, 9, 0], b"".as_slice()),
            (0, [7, 5, 0], [7, 5, 0], b"dev".as_slice()),
        ] {
            assert!(checked_sundials_version(status, compiled, linked, label).is_err());
        }
    }
    #[test]
    fn fatal_callback_refuses_success_and_stop_time_before_endpoint_admission() {
        for status in [0, 1] {
            assert!(checked_ida_step(status, None).is_ok());
            let error = checked_ida_step(status, Some("fatal JVP callback")).unwrap_err();
            assert!(error.contains("fatal JVP callback"));
            assert!(error.contains(&format!("returned {status}")));
        }
        assert!(checked_ida_step(-4, None).is_err());
        assert!(checked_ida_step(-4, Some("fatal JVP callback")).is_err());
    }

    unsafe extern "C" fn boundary_residual(
        _: f64,
        _: Handle,
        yp: Handle,
        residual: Handle,
        _: Handle,
    ) -> c_int {
        let slopes = unsafe { N_VGetArrayPointer_Serial(yp) };
        let out = unsafe { N_VGetArrayPointer_Serial(residual) };
        if slopes.is_null() || out.is_null() {
            return -1;
        }
        // Deliberately inadmissible test-only x'=-tiny drives IDA's small
        // constraint-correction path. The unconstrained clock fixes startup.
        unsafe {
            *out = *slopes + 1e-9;
            *out.add(1) = *slopes.add(1) - 1.;
        }
        0
    }
    unsafe extern "C" fn boundary_jacobian(
        _: f64,
        cj: f64,
        _: Handle,
        _: Handle,
        _: Handle,
        matrix: Handle,
        _: Handle,
        _: Handle,
        _: Handle,
        _: Handle,
    ) -> c_int {
        if matrix_data(matrix, &[0, 1, 2], &[0, 1], &[cj, cj]).is_ok() {
            0
        } else {
            -1
        }
    }
    fn values(vector: Handle) -> Vec<f64> {
        unsafe { std::slice::from_raw_parts(N_VGetArrayPointer_Serial(vector), 2).to_vec() }
    }
    #[test]
    fn retained_endpoint_keeps_constraint_state_derivative_and_raw_buffers_separate() {
        let mut owned = Resources::new().unwrap();
        let y = owned.vector(&[0., 0.]).unwrap();
        let yp = owned.vector(&[-1e-9, 1.]).unwrap();
        let kept_y = owned.vector(&[0., 0.]).unwrap();
        let kept_yp = owned.vector(&[0., 0.]).unwrap();
        let atol = owned.vector(&[1e-3, 1e-3]).unwrap();
        let constraint = owned.vector(&[1., 0.]).unwrap();
        owned.matrix(2, 2).unwrap();
        owned.solver(y).unwrap();
        owned.ida = unsafe { IDACreate(owned.context) };
        assert!(!owned.ida.is_null());
        checked(
            unsafe { IDAInit(owned.ida, boundary_residual, 0., y, yp) },
            "test IDAInit",
        )
        .unwrap();
        checked(
            unsafe { IDASVtolerances(owned.ida, 1e-5, atol) },
            "test tolerance",
        )
        .unwrap();
        checked(
            unsafe { IDASetConstraints(owned.ida, constraint) },
            "test constraint",
        )
        .unwrap();
        checked(
            unsafe { IDASetLinearSolver(owned.ida, owned.solver, owned.matrix) },
            "test linear solver",
        )
        .unwrap();
        checked(
            unsafe { IDASetJacFn(owned.ida, boundary_jacobian) },
            "test Jacobian",
        )
        .unwrap();
        let mut time = 0.;
        checked(
            unsafe { IDASolve(owned.ida, 1., &mut time, y, yp, 2) },
            "test ONE_STEP",
        )
        .unwrap();
        let raw_y = values(y);
        let raw_yp = values(yp);
        // Unchanged 7.5 exposes negative raw values here (the prior frozen
        // witness records that defect); repaired dependencies may return 0.
        // The reusable API contract concerns retained state and no mutation.
        assert!(time > 0.);
        retained_endpoint(owned.ida, time, y, yp, kept_y, kept_yp).unwrap();
        assert_eq!(values(kept_y)[0], 0.);
        assert_eq!(values(kept_yp)[0], 0.);
        assert!((values(kept_y)[1] - time).abs() < 1e-14);
        assert!((values(kept_yp)[1] - 1.).abs() < 1e-14);
        assert_eq!(values(y), raw_y);
        assert_eq!(values(yp), raw_yp);
        assert!(retained_endpoint(owned.ida, time, y, yp, y, kept_yp).is_err());
        assert!(retained_endpoint(owned.ida, time, y, yp, kept_y, kept_y).is_err());
        assert!(retained_endpoint(owned.ida, time, y, y, kept_y, kept_yp).is_err());
        assert!(retained_endpoint(owned.ida, time * 0.5, y, yp, kept_y, kept_yp).is_err());
        let short = owned.vector(&[0.]).unwrap();
        assert!(retained_endpoint(owned.ida, time, y, yp, short, kept_yp).is_err());
    }
}

/// Every partially created allocation is owned before the next fallible call.
pub(crate) struct Resources {
    pub(crate) context: Handle,
    vectors: Vec<Handle>,
    pub(crate) matrix: Handle,
    pub(crate) solver: Handle,
    pub(crate) ida: Handle,
    nonlinear: Handle,
}
impl Resources {
    pub(crate) fn new() -> Result<Self, String> {
        check_sundials_runtime()?;
        let mut out = Self {
            context: ptr::null_mut(),
            vectors: Vec::new(),
            matrix: ptr::null_mut(),
            solver: ptr::null_mut(),
            ida: ptr::null_mut(),
            nonlinear: ptr::null_mut(),
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
    pub(crate) fn vector(&mut self, values: &[f64]) -> Result<Handle, String> {
        if values.is_empty() {
            return Err("Empty owned serial vector".into());
        }
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
    pub(crate) fn newton(&mut self, vector: Handle) -> Result<Handle, String> {
        if vector.is_null() || !self.nonlinear.is_null() {
            return Err("Invalid or repeated owned Newton allocation".into());
        }
        self.nonlinear = unsafe { SUNNonlinSol_Newton(vector, self.context) };
        if self.nonlinear.is_null() {
            return Err("SUNNonlinSol_Newton returned null".into());
        }
        Ok(self.nonlinear)
    }
    pub(crate) fn matrix(&mut self, n: i64, entries: i64) -> Result<Handle, String> {
        if n <= 0 || entries <= 0 || !self.matrix.is_null() {
            return Err("Invalid or repeated owned matrix allocation".into());
        }
        self.matrix = unsafe { SUNSparseMatrix(n, n, entries, 0, self.context) };
        if self.matrix.is_null() {
            Err("SUNSparseMatrix(CSC) returned null".into())
        } else {
            Ok(self.matrix)
        }
    }
    pub(crate) fn solver(&mut self, vector: Handle) -> Result<Handle, String> {
        if self.matrix.is_null() || vector.is_null() || !self.solver.is_null() {
            return Err("Invalid or repeated owned KLU allocation".into());
        }
        self.solver = unsafe { SUNLinSol_KLU(vector, self.matrix, self.context) };
        if self.solver.is_null() {
            Err("Actual SUNLinSol_KLU constructor returned null".into())
        } else {
            Ok(self.solver)
        }
    }
    pub(crate) fn spgmr(
        &mut self,
        vector: Handle,
        maxl: c_int,
        restarts: c_int,
    ) -> Result<Handle, String> {
        if vector.is_null() || !self.solver.is_null() || maxl <= 0 || restarts < 0 {
            return Err("Invalid or repeated owned SPGMR allocation".into());
        }
        // SUN_PREC_LEFT = 1 in the pinned SUNDIALS API.
        self.solver = unsafe { SUNLinSol_SPGMR(vector, 1, maxl, self.context) };
        if self.solver.is_null() {
            return Err("SUNLinSol_SPGMR returned null".into());
        }
        checked(
            unsafe { SUNLinSol_SPGMRSetMaxRestarts(self.solver, restarts) },
            "SPGMRSetMaxRestarts",
        )?;
        Ok(self.solver)
    }
}
impl Drop for Resources {
    fn drop(&mut self) {
        unsafe {
            if !self.ida.is_null() {
                IDAFree(&mut self.ida);
            }
            // IDASetNonlinearSolver marks this externally owned. Its callbacks
            // reference IDA, so destroy IDA first, then Newton, then vectors.
            if !self.nonlinear.is_null() {
                SUNNonlinSolFree(self.nonlinear);
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

pub(crate) fn matrix_data(
    matrix: Handle,
    pointers: &[i64],
    indices: &[i64],
    values: &[f64],
) -> Result<(), String> {
    if matrix.is_null() || indices.len() != values.len() {
        return Err("Invalid owned CSC input".into());
    }
    let rows = unsafe { SUNSparseMatrix_Rows(matrix) };
    let columns = unsafe { SUNSparseMatrix_Columns(matrix) };
    let capacity = unsafe { SUNSparseMatrix_NNZ(matrix) };
    if columns < 0
        || rows <= 0
        || capacity < 0
        || pointers.len() != columns as usize + 1
        || pointers.first() != Some(&0)
        || pointers.last() != Some(&(indices.len() as i64))
        || pointers.windows(2).any(|pair| pair[0] > pair[1])
        || indices.iter().any(|&row| row < 0 || row >= rows)
        || values.len() > capacity as usize
    {
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

pub(crate) fn vector_values<const N: usize>(vector: Handle) -> Result<[f64; N], String> {
    if vector.is_null() || unsafe { N_VGetLength_Serial(vector) } != N as i64 {
        return Err("Callback serial vector has wrong length".into());
    }
    let data = unsafe { N_VGetArrayPointer_Serial(vector) };
    if data.is_null() {
        return Err("Null callback serial data".into());
    }
    let mut values = [0.; N];
    unsafe {
        ptr::copy_nonoverlapping(data, values.as_mut_ptr(), N);
    }
    Ok(values)
}

pub(crate) fn vector4(vector: Handle) -> Result<[f64; 4], String> {
    vector_values(vector)
}

pub(crate) fn klu_fixture() -> Result<(f64, f64), String> {
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

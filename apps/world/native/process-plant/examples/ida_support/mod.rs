//! Narrow pinned SUNDIALS serial DOUBLE/INT64 + KLU ownership for offline examples.
//! Shared to avoid duplicating unsafe ABI/resource cleanup between witnesses.
//! No integrator policy, physics, fallback backend or production registration.
use std::{
    ffi::{c_int, c_long, c_void},
    ptr,
};

pub(crate) type Handle = *mut c_void;
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

#[link(name = "sundials_core")]
#[link(name = "sundials_nvecserial")]
#[link(name = "sundials_sunmatrixsparse")]
#[link(name = "sundials_sunlinsolklu")]
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
    pub(crate) fn SUNLinSolInitialize(solver: Handle) -> c_int;
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
    pub(crate) fn IDASVtolerances(memory: Handle, relative: f64, absolute: Handle) -> c_int;
    pub(crate) fn IDASetId(memory: Handle, id: Handle) -> c_int;
    pub(crate) fn IDASetLinearSolver(memory: Handle, solver: Handle, matrix: Handle) -> c_int;
    pub(crate) fn IDASetJacFn(memory: Handle, jacobian: JacobianFn) -> c_int;
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
    pub(crate) fn IDAFree(memory: *mut Handle);
}

pub(crate) fn checked(status: c_int, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} returned {status}"))
    }
}

/// Every partially created allocation is owned before the next fallible call.
pub(crate) struct Resources {
    pub(crate) context: Handle,
    vectors: Vec<Handle>,
    pub(crate) matrix: Handle,
    pub(crate) solver: Handle,
    pub(crate) ida: Handle,
}
impl Resources {
    pub(crate) fn new() -> Result<Self, String> {
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

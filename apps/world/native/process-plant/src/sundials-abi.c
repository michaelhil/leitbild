/* Narrow ABI guard for the manually declared offline Rust boundary. This is
 * authored glue, not a copied solver or a claim about which dylib was loaded. */
#include <sundials/sundials_config.h>

#if !defined(SUNDIALS_DOUBLE_PRECISION) || defined(SUNDIALS_SINGLE_PRECISION) || defined(SUNDIALS_EXTENDED_PRECISION)
#error "Leitbild offline IDA requires DOUBLE precision"
#endif
#if !defined(SUNDIALS_INT64_T) || defined(SUNDIALS_INT32_T)
#error "Leitbild offline IDA requires INT64 indices"
#endif
#if !defined(SUNDIALS_MPI_ENABLED) || SUNDIALS_MPI_ENABLED != 0
#error "Leitbild offline IDA requires non-MPI SUNComm"
#endif
#if SUNDIALS_VERSION_MAJOR != 7 || SUNDIALS_VERSION_MINOR != 5 || SUNDIALS_VERSION_PATCH != 0
#error "Leitbild offline IDA requires pinned SUNDIALS 7.5.0 headers"
#endif

#include <stdint.h>
#include <ida/ida.h>
#include <ida/ida_ls.h>
#include <nvector/nvector_serial.h>
#include <sunmatrix/sunmatrix_sparse.h>
#include <sundials/sundials_iterative.h>
#include <sundials/sundials_version.h>
#include <sunnonlinsol/sunnonlinsol_newton.h>

#define SAME_TYPE(value, type) _Generic((value), type: 1, default: 0)
_Static_assert(SAME_TYPE((sunrealtype)0, double), "Rust f64 / sunrealtype mismatch");
_Static_assert(SAME_TYPE((sunindextype)0, int64_t), "Rust i64 / sunindextype mismatch");
_Static_assert(SAME_TYPE((suncountertype)0, long int), "Rust c_long / counter mismatch");
_Static_assert(SAME_TYPE((SUNComm)0, int), "Rust c_int / SUNComm mismatch");
_Static_assert(SAME_TYPE((sunbooleantype)0, int), "Rust c_int / boolean mismatch");
_Static_assert(sizeof(double) == 8 && sizeof(int64_t) == 8, "Unsupported Rust scalar ABI");
_Static_assert(sizeof(int) == 4, "Unsupported Rust c_int ABI");
_Static_assert(sizeof(SUNErrCode) == sizeof(int), "Rust c_int / SUNErrCode mismatch");
_Static_assert(sizeof(N_Vector) == sizeof(void*) && sizeof(SUNMatrix) == sizeof(void*)
               && sizeof(SUNContext) == sizeof(void*), "Unsupported opaque handle ABI");

typedef int (*Residual)(double, N_Vector, N_Vector, N_Vector, void*);
typedef int (*Jacobian)(double, double, N_Vector, N_Vector, N_Vector, SUNMatrix,
                       void*, N_Vector, N_Vector, N_Vector);
typedef int (*PrecSetup)(double, N_Vector, N_Vector, N_Vector, double, void*);
typedef int (*PrecSolve)(double, N_Vector, N_Vector, N_Vector, N_Vector, N_Vector,
                        double, double, void*);
typedef int (*JacTimes)(double, N_Vector, N_Vector, N_Vector, N_Vector, N_Vector,
                       double, void*, N_Vector, N_Vector);
typedef int (*ATimes)(void*, N_Vector, N_Vector);
typedef int (*LinearPrecSetup)(void*);
typedef int (*LinearPrecSolve)(void*, N_Vector, N_Vector, double, int);
typedef int (*ConvergenceTest)(SUNNonlinearSolver, N_Vector, N_Vector, double,
                               N_Vector, void*);
_Static_assert(SAME_TYPE((SUNNonlinSolConvTestFn)0, ConvergenceTest), "Newton convergence callback ABI mismatch");
_Static_assert(SAME_TYPE(&IDAGetNonlinearSystemData, int (*)(void*, double*, N_Vector*, N_Vector*, N_Vector*, N_Vector*, N_Vector*, double*, void**)), "IDA nonlinear data ABI mismatch");
_Static_assert(SAME_TYPE((IDAResFn)0, Residual), "IDA residual callback ABI mismatch");
_Static_assert(SAME_TYPE((IDALsJacFn)0, Jacobian), "IDA Jacobian callback ABI mismatch");
_Static_assert(SAME_TYPE((IDALsPrecSetupFn)0, PrecSetup), "IDA setup callback ABI mismatch");
_Static_assert(SAME_TYPE((IDALsJacTimesSetupFn)0, PrecSetup), "IDA JT setup callback ABI mismatch");
_Static_assert(SAME_TYPE((IDALsPrecSolveFn)0, PrecSolve), "IDA solve callback ABI mismatch");
_Static_assert(SAME_TYPE((IDALsJacTimesVecFn)0, JacTimes), "IDA JVP callback ABI mismatch");
_Static_assert(SAME_TYPE((SUNATimesFn)0, ATimes), "Linear ATimes callback ABI mismatch");
_Static_assert(SAME_TYPE((SUNPSetupFn)0, LinearPrecSetup), "Linear setup callback ABI mismatch");
_Static_assert(SAME_TYPE((SUNPSolveFn)0, LinearPrecSolve), "Linear solve callback ABI mismatch");
_Static_assert(SAME_TYPE(&N_VNew_Serial, N_Vector (*)(int64_t, SUNContext)), "Serial length ABI mismatch");
_Static_assert(SAME_TYPE(&SUNContext_Create, SUNErrCode (*)(int, SUNContext*)), "Context ABI mismatch");
_Static_assert(SAME_TYPE(&SUNSparseMatrix, SUNMatrix (*)(int64_t, int64_t, int64_t, int, SUNContext)), "Sparse size ABI mismatch");
_Static_assert(SAME_TYPE(&IDAGetNumSteps, int (*)(void*, long int*)), "IDA counter ABI mismatch");

int leitbild_sundials_versions(int* compiled, int* linked, char* label, int capacity)
{
    if (!compiled || !linked || !label || capacity <= 0) return -1;
    compiled[0] = SUNDIALS_VERSION_MAJOR;
    compiled[1] = SUNDIALS_VERSION_MINOR;
    compiled[2] = SUNDIALS_VERSION_PATCH;
    return (int)SUNDIALSGetVersionNumber(&linked[0], &linked[1], &linked[2], label, capacity);
}

/* The Newton content and its CTest/ctest_data fields are documented public
 * SUNDIALS API. Read only; IDA owns the original callback's convergence state.
 * Never cast another nonlinear-solver implementation's content. */
int leitbild_sunnewton_convergence(SUNNonlinearSolver solver,
                                  SUNNonlinSolConvTestFn* test, void** data)
{
    if (!solver || !solver->ops || !solver->content || !test || !data ||
        solver->ops->solve != SUNNonlinSolSolve_Newton ||
        solver->ops->gettype != SUNNonlinSolGetType_Newton) return -1;
    SUNNonlinearSolverContent_Newton content = solver->content;
    if (!content->CTest) return -1;
    *test = content->CTest;
    *data = content->ctest_data;
    return 0;
}

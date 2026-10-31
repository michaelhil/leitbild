/* Original narrow glue to stock IDA/KLU; no solver algorithm is copied here. */
#ifdef OPERATING_IDAS
/* Stock IDAS of the same release: IDA plus quadrature integration. */
#include <idas/idas.h>
#include <idas/idas_ls.h>
#else
#include <ida/ida.h>
#include <ida/ida_ls.h>
#endif
#include <nvector/nvector_serial.h>
#include <sunmatrix/sunmatrix_sparse.h>
#include <sunlinsol/sunlinsol_klu.h>
#include <klu.h>
#include <sundials/sundials_config.h>
#include <sundials/sundials_version.h>
#include <float.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#if SUNDIALS_VERSION_MAJOR != 7 || SUNDIALS_VERSION_MINOR != 5
#error "Admit a changed stock SUNDIALS version explicitly before using it"
#endif
#if KLU_MAIN_VERSION != 2 || KLU_SUB_VERSION != 3 || KLU_SUBSUB_VERSION != 6
#error "Admit a changed stock KLU version explicitly before using it"
#endif
_Static_assert(sizeof(sunrealtype) == sizeof(double), "DOUBLE required");
_Static_assert(sizeof(sunindextype) == sizeof(int64_t), "INT64 required");
typedef int (*Residual)(void*, double, const double*, const double*, double*);
typedef int (*Jacobian)(void*, double, double, const double*, const double*, double*, int64_t*, int64_t*);
typedef int (*Roots)(void*, double, const double*, const double*, double*);
typedef int (*Quadrature)(void*, double, const double*, const double*, double*);
typedef int (*Weights)(void*, const double*, double*);
typedef struct {
    SUNContext ctx;
    N_Vector y, yp, atol, ids, q;
    /* Scratch of the dense output (IDAGetDky), never solver history. */
    N_Vector dense;
    SUNMatrix matrix;
    SUNLinearSolver linear;
    void *ida, *user;
    Residual residual;
    Jacobian jacobian;
    Roots roots;
    Quadrature quadrature;
    /* N1: the caller's error-weight rule (stock IDAWFtolerances), or none
       (stock IDASVtolerances on rtol and atol). */
    Weights weights;
    double time;
    /* MR-1 (owner, request 7 R7-P): the stock IDAS check-point interval in
       steps (0: stock IDASolve, no forced setup), the most check points
       held before stock IDAAdjReInit frees them, and the counts. */
    long rebuild_steps, rebuild_held_max, rebuild_held, rebuild_most, rebuild_drops;
} OperatingIDA;
static int residual(double t, N_Vector y, N_Vector yp, N_Vector r, void *v) {
    OperatingIDA *o = v;
    return o->residual(o->user,t,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),N_VGetArrayPointer(r));
}
static int jacobian(double t, double cj, N_Vector y, N_Vector yp, N_Vector r,
                    SUNMatrix j, void *v, N_Vector a, N_Vector b, N_Vector c) {
    (void)r; (void)a; (void)b; (void)c;
    OperatingIDA *o = v;
    return o->jacobian(o->user,t,cj,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),
        SUNSparseMatrix_Data(j),SUNSparseMatrix_IndexValues(j),SUNSparseMatrix_IndexPointers(j));
}
static int error_weights(N_Vector y, N_Vector ewt, void *v) {
    OperatingIDA *o = v;
    return o->weights(o->user,N_VGetArrayPointer(y),N_VGetArrayPointer(ewt));
}
static int root_values(double t, N_Vector y, N_Vector yp, double *g, void *v) {
    OperatingIDA *o = v;
    return o->roots(o->user,t,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),g);
}
/* PERF E-PROF (plan r4): an opt-in cost profile of stock KLU's setup
   (factor/refactor) and solve. When the caller passes its scope hooks at
   construction, the stock operations are called unchanged inside them. */
typedef void (*CostEnter)(int);
typedef void (*CostExit)(void);
static CostEnter cost_enter;
static CostExit cost_exit;
static int (*stock_setup)(SUNLinearSolver, SUNMatrix);
static int (*stock_solve)(SUNLinearSolver, SUNMatrix, N_Vector, N_Vector, sunrealtype);
static int profiled_setup(SUNLinearSolver s, SUNMatrix a) {
    cost_enter(0);
    int code=stock_setup(s,a);
    cost_exit();
    return code;
}
static int profiled_solve(SUNLinearSolver s, SUNMatrix a, N_Vector x, N_Vector b, sunrealtype tol) {
    cost_enter(1);
    int code=stock_solve(s,a,x,b,tol);
    cost_exit();
    return code;
}
void operating_ida_free(OperatingIDA *o) {
    if (!o) return;
    if (o->ida) IDAFree(&o->ida);
    if (o->linear) SUNLinSolFree(o->linear);
    if (o->matrix) SUNMatDestroy(o->matrix);
    if (o->ids) N_VDestroy(o->ids);
    if (o->dense) N_VDestroy(o->dense);
    if (o->q) N_VDestroy(o->q);
    if (o->atol) N_VDestroy(o->atol);
    if (o->yp) N_VDestroy(o->yp);
    if (o->y) N_VDestroy(o->y);
    if (o->ctx) SUNContext_Free(&o->ctx);
    free(o);
}
OperatingIDA *operating_ida_create(int64_t n,int64_t nnz,double t,double rtol,
    const double *atol,const double *ids,const double *y,const double *yp,
    Residual f,Jacobian j,int nroots,Roots g,void *user,CostEnter enter,CostExit leave,int *status) {
    OperatingIDA *o = calloc(1,sizeof(*o));
    *status=-1;
    if (!o) return NULL;
    int major=0,minor=0,patch=0; char label[64];
    if (SUNDIALSGetVersionNumber(&major,&minor,&patch,label,sizeof(label))
        || major!=SUNDIALS_VERSION_MAJOR || minor!=SUNDIALS_VERSION_MINOR
        || patch!=SUNDIALS_VERSION_PATCH) goto fail;
    o->user=user; o->residual=f; o->jacobian=j; o->roots=g; o->time=t;
    if (SUNContext_Create(SUN_COMM_NULL,&o->ctx)) goto fail;
    o->y=N_VNew_Serial(n,o->ctx); o->yp=N_VNew_Serial(n,o->ctx);
    o->atol=N_VNew_Serial(n,o->ctx); o->ids=N_VNew_Serial(n,o->ctx);
    o->dense=N_VNew_Serial(n,o->ctx);
    if (!o->y || !o->yp || !o->atol || !o->ids || !o->dense) goto fail;
    memcpy(N_VGetArrayPointer(o->y),y,n*sizeof(double));
    memcpy(N_VGetArrayPointer(o->yp),yp,n*sizeof(double));
    memcpy(N_VGetArrayPointer(o->atol),atol,n*sizeof(double));
    memcpy(N_VGetArrayPointer(o->ids),ids,n*sizeof(double));
    o->matrix=SUNSparseMatrix(n,n,nnz,CSC_MAT,o->ctx);
    if (!o->matrix) goto fail;
    o->linear=SUNLinSol_KLU(o->y,o->matrix,o->ctx);
    o->ida=IDACreate(o->ctx);
    if (!o->linear || !o->ida) goto fail;
    if (enter && leave) {
        if (stock_setup && (stock_setup!=o->linear->ops->setup || stock_solve!=o->linear->ops->solve)) goto fail;
        stock_setup=o->linear->ops->setup; stock_solve=o->linear->ops->solve;
        cost_enter=enter; cost_exit=leave;
        o->linear->ops->setup=profiled_setup; o->linear->ops->solve=profiled_solve;
    }
#define CHECK(call) do { *status=(call); if (*status<0) goto fail; } while(0)
    CHECK(IDAInit(o->ida,residual,t,o->y,o->yp));
    CHECK(IDASetUserData(o->ida,o));
    CHECK(IDASVtolerances(o->ida,rtol,o->atol));
    CHECK(IDASetId(o->ida,o->ids));
    CHECK(IDASetLinearSolver(o->ida,o->linear,o->matrix));
    CHECK(IDASetJacFn(o->ida,jacobian));
    if (nroots>0) CHECK(IDARootInit(o->ida,nroots,root_values));
    return o;
fail: operating_ida_free(o); return NULL;
}
int operating_ida_initialize(OperatingIDA *o,double horizon,double *y,double *yp) {
    int code=IDACalcIC(o->ida,IDA_YA_YDP_INIT,horizon);
    if (code>=0) code=IDAGetConsistentIC(o->ida,o->y,o->yp);
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(o->y),N_VGetLength(o->y)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(o->yp),N_VGetLength(o->yp)*sizeof(double));
    }
    return code;
}
/* One stock solve call. Under MR-1 (owner R7-P, 17 Oct): stock IDAS
   IDASolveF in place of IDASolve. IDASolveF takes the same steps and makes a
   check point at every rebuild_steps-th step, which sets stock's own
   forceSetup, so the next step sets the iteration matrix up again (idaa.c
   IDASolveF, idas.c IDANls); step size, order and history are untouched and
   no backward pass is ever run. Check points serve nothing else here: once
   more than rebuild_held_max are held, stock IDAAdjReInit frees them. */
static int solve(OperatingIDA *o,double target,int task) {
#ifdef OPERATING_IDAS
    if (o->rebuild_steps>0) {
        int ncheck=0;
        int code=IDASolveF(o->ida,target,&o->time,o->y,o->yp,task,&ncheck);
        if (code<0) return code;
        o->rebuild_held=ncheck;
        if (ncheck>o->rebuild_most) o->rebuild_most=ncheck;
        if (ncheck>o->rebuild_held_max) {
            int freed=IDAAdjReInit(o->ida);
            if (freed<0) return freed;
            o->rebuild_held=0;
            o->rebuild_drops++;
        }
        return code;
    }
#endif
    return IDASolve(o->ida,target,&o->time,o->y,o->yp,task);
}
int operating_ida_advance(OperatingIDA *o,double target,double *time,double *y,double *yp) {
    int code=solve(o,target,IDA_NORMAL);
    *time=o->time;
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(o->y),N_VGetLength(o->y)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(o->yp),N_VGetLength(o->yp)*sizeof(double));
    }
    return code;
}
int operating_ida_stop_at(OperatingIDA *o,double target) { return IDASetStopTime(o->ida,target); }
int operating_ida_nonnegative(OperatingIDA *o,const double *flags) {
    if (!flags) return IDASetConstraints(o->ida,NULL);
    N_Vector constraints=N_VClone(o->y);
    if (!constraints) return IDA_MEM_FAIL;
    memcpy(N_VGetArrayPointer(constraints),flags,N_VGetLength(o->y)*sizeof(double));
    /* Stock IDASetConstraints retains its own copy, not this temporary vector. */
    int code=IDASetConstraints(o->ida,constraints);
    N_VDestroy(constraints);
    return code;
}
int operating_ida_current_time(OperatingIDA *o,double *t) { return IDAGetCurrentTime(o->ida,t); }
int operating_ida_current_state(OperatingIDA *o,double *time,double *y,double *yp) {
    double current;
    int code=IDAGetCurrentTime(o->ida,&current);
    if (code<0) return code;
    /* CurrentY/Yp alias the IDASolve output buffers, which may have been
       interpolated to tout. Evaluate history at tn into independent scratch. */
    N_Vector state=N_VClone(o->y), rate=N_VClone(o->yp);
    if (!state || !rate) {
        if (state) N_VDestroy(state);
        if (rate) N_VDestroy(rate);
        return IDA_MEM_FAIL;
    }
    code=IDAGetDky(o->ida,current,0,state);
    if (code>=0) code=IDAGetDky(o->ida,current,1,rate);
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(state),N_VGetLength(state)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(rate),N_VGetLength(rate)*sizeof(double));
        *time=current;
    }
    N_VDestroy(rate);
    N_VDestroy(state);
    return code;
}
/* Stock IDA_ONE_STEP: one internal step toward target per call (an armed
   stop time is never passed), so an observer reads every accepted step's
   dense output instead of IDASolve calls at the observation rate (S3-D1 #7;
   IC-PROT's frame driver). */
int operating_ida_step(OperatingIDA *o,double target,double *time,double *y,double *yp) {
    int code=solve(o,target,IDA_ONE_STEP);
    *time=o->time;
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(o->y),N_VGetLength(o->y)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(o->yp),N_VGetLength(o->yp)*sizeof(double));
    }
    return code;
}
/* Stock IDAGetDky: the k-th derivative at t of the last accepted step's
   interpolating polynomial, t within [tn - hu, tn] and k at most that step's
   order, into the handle's own scratch, then copied out. No step, history,
   option or status changes (dense output, S3-D1 #7). Stock checks only the
   lower end (it would extrapolate past tn); a time past tn by more than
   stock's own time fuzz, 100 uround (|tn| + |h|) as in IDAGetDky's lower
   end and the stop-time test (a stop at tstop leaves tn a few ulps short of
   the returned tstop), is refused here with stock's own IDA_BAD_T. */
int operating_ida_dky(OperatingIDA *o,double t,int k,double *out) {
    double current, next;
    int code=IDAGetCurrentTime(o->ida,&current);
    if (code>=0) code=IDAGetCurrentStep(o->ida,&next);
    if (code<0) return code;
    if (!(t<=current+100.0*DBL_EPSILON*(fabs(current)+fabs(next)))) return IDA_BAD_T;
    code=IDAGetDky(o->ida,t,k,o->dense);
    if (code>=0) memcpy(out,N_VGetArrayPointer(o->dense),N_VGetLength(o->dense)*sizeof(double));
    return code;
}
int operating_ida_error_diagnostics(OperatingIDA *o,double *errors,double *weights,int *order) {
    N_Vector e=N_VClone(o->y), w=N_VClone(o->y);
    if (!e || !w) {
        if (e) N_VDestroy(e);
        if (w) N_VDestroy(w);
        return IDA_MEM_FAIL;
    }
    int code=IDAGetEstLocalErrors(o->ida,e);
    if (code>=0) code=IDAGetErrWeights(o->ida,w);
    if (code>=0) code=IDAGetCurrentOrder(o->ida,order);
    if (code>=0) {
        memcpy(errors,N_VGetArrayPointer(e),N_VGetLength(e)*sizeof(double));
        memcpy(weights,N_VGetArrayPointer(w),N_VGetLength(w)*sizeof(double));
    }
    N_VDestroy(w);
    N_VDestroy(e);
    return code;
}
int operating_ida_stats(OperatingIDA *o,long *counts,int *orders,double *steps) {
    int code=IDAGetNumSteps(o->ida,&counts[0]);
    if (code>=0) code=IDAGetNumResEvals(o->ida,&counts[1]);
    if (code>=0) code=IDAGetNumJacEvals(o->ida,&counts[2]);
    if (code>=0) code=IDAGetNumNonlinSolvIters(o->ida,&counts[3]);
    if (code>=0) code=IDAGetNumErrTestFails(o->ida,&counts[4]);
    if (code>=0) code=IDAGetNumNonlinSolvConvFails(o->ida,&counts[5]);
    if (code>=0) code=IDAGetNumLinSolvSetups(o->ida,&counts[6]);
    if (code>=0) code=IDAGetNumGEvals(o->ida,&counts[7]);
    if (code>=0) code=IDAGetLastOrder(o->ida,&orders[0]);
    if (code>=0) code=IDAGetCurrentOrder(o->ida,&orders[1]);
    if (code>=0) code=IDAGetLastStep(o->ida,&steps[0]);
    if (code>=0) code=IDAGetCurrentStep(o->ida,&steps[1]);
    return code;
}
int operating_ida_max_order(OperatingIDA *o,int order) { return IDASetMaxOrd(o->ida,order); }
/* Stock IDASVtolerances on the handle's own atol vector (a segment's
   tolerances, e.g. a derived class at a phase-mode change). Refused while
   the caller's weight rule is in force: it would replace that rule. */
int operating_ida_tolerances(OperatingIDA *o,double rtol,const double *atol) {
    if (o->weights) return IDA_ILL_INPUT;
    memcpy(N_VGetArrayPointer(o->atol),atol,N_VGetLength(o->atol)*sizeof(double));
    return IDASVtolerances(o->ida,rtol,o->atol);
}
/* N1 (OU plan, R1 S1): stock IDAWFtolerances. Stock calls the rule for the
   error weights wherever it would compute rtol|y| + atol from the tolerances
   (its error test, the Newton convergence test and the initial step), with
   the user data as its data (IDAInitialSetup). Once set, it stays. */
int operating_ida_weight_function(OperatingIDA *o,Weights w) {
    if (!w || o->weights) return IDA_ILL_INPUT;
    int code=IDAWFtolerances(o->ida,error_weights);
    if (code>=0) o->weights=w;
    return code;
}
int operating_ida_max_step(OperatingIDA *o,double step) { return IDASetMaxStep(o->ida,step); }
/* Stock IDASetInitStep: the first step; it persists across IDAReInit. */
int operating_ida_init_step(OperatingIDA *o,double step) { return IDASetInitStep(o->ida,step); }
/* 1 when this glue was compiled against stock IDAS (quadratures), else 0. */
int operating_ida_quadratures_linked(void) {
#ifdef OPERATING_IDAS
    return 1;
#else
    return 0;
#endif
}
/* MR-1 (owner R7-P): stock IDAAdjInit(steps, IDA_HERMITE) once per handle;
   its interpolation store, (steps + 1) x 2 vectors, is allocated here.
   Refused under plain IDA (no check points) and when already set. */
int operating_ida_rebuild_every(OperatingIDA *o,long steps,long held) {
#ifdef OPERATING_IDAS
    if (steps<1 || held<1 || o->rebuild_steps>0) return IDA_ILL_INPUT;
    int code=IDAAdjInit(o->ida,steps,IDA_HERMITE);
    if (code<0) return code;
    o->rebuild_steps=steps;
    o->rebuild_held_max=held;
    return code;
#else
    (void)o; (void)steps; (void)held;
    return IDA_ILL_INPUT;
#endif
}
int operating_ida_rebuild_counts(OperatingIDA *o,long *counts) {
    counts[0]=o->rebuild_steps;
    counts[1]=o->rebuild_held;
    counts[2]=o->rebuild_most;
    counts[3]=o->rebuild_drops;
    return 0;
}
int operating_ida_solution_scaling(OperatingIDA *o,int enabled) {
    return IDASetLinearSolutionScaling(o->ida,enabled?SUNTRUE:SUNFALSE);
}
int operating_ida_newton_coefficient(OperatingIDA *o,double coefficient) {
    return IDASetNonlinConvCoef(o->ida,coefficient);
}
/* Stock IDASetDeltaCjLSetup: the linear solver is set up again when cj/cjold
   leaves ((1-dcj)/(1+dcj), (1+dcj)/(1-dcj)); stock's default is 0.25. */
int operating_ida_delta_cj(OperatingIDA *o,double dcj) {
    return IDASetDeltaCjLSetup(o->ida,dcj);
}
/* Stock SUNLinSol_KLUSetOrdering: KLU's fill-reducing ordering, 0 AMD,
   1 COLAMD (stock's default), 2 natural. KLU reads it at its first symbolic
   analysis, which the first linear setup performs and IDAReInit keeps. */
int operating_ida_klu_ordering(OperatingIDA *o,int ordering) {
    return SUNLinSol_KLUSetOrdering(o->linear,ordering);
}
/* Stock IDAReInit restarts history at t from (y,yp); tolerances, ids,
   constraints, roots, linear solver, Jacobian, stop time and options stay. */
int operating_ida_reinitialize(OperatingIDA *o,double t,const double *y,const double *yp) {
    memcpy(N_VGetArrayPointer(o->y),y,N_VGetLength(o->y)*sizeof(double));
    memcpy(N_VGetArrayPointer(o->yp),yp,N_VGetLength(o->yp)*sizeof(double));
    int code=IDAReInit(o->ida,t,o->y,o->yp);
#ifdef OPERATING_IDAS
    /* MR-1: a restart frees every check point (stock IDAAdjReInit). */
    if (code>=0 && o->rebuild_steps>0) {
        code=IDAAdjReInit(o->ida);
        o->rebuild_held=0;
    }
#endif
    if (code>=0) o->time=t;
    return code;
}
int operating_ida_root_directions(OperatingIDA *o,int *directions) {
    return IDAGetRootInfo(o->ida,directions);
}
/* Stock IDASetRootDirection after IDARootInit: per root function +1 locates
   rising crossings only, -1 falling only, 0 both. Stock copies the array;
   IDAReInit keeps it. */
int operating_ida_set_root_direction(OperatingIDA *o,int *directions) {
    return IDASetRootDirection(o->ida,directions);
}
/* Stock IDASetId copies the vector; the owned ids remain only its source. */
int operating_ida_differential(OperatingIDA *o,const double *ids) {
    memcpy(N_VGetArrayPointer(o->ids),ids,N_VGetLength(o->ids)*sizeof(double));
    return IDASetId(o->ida,o->ids);
}

/* Direct stock KLU (64-bit klu_l) on one fixed CSC pattern. Rust validates
   every pattern/value/buffer before these calls; KLU keeps no caller pointer.
   A failed factorization leaves no Numeric, so nothing solves with it. */
typedef struct {
    klu_l_common common;
    klu_l_symbolic *symbolic;
    klu_l_numeric *numeric;
} OperatingKLU;
#define OPERATING_KLU_VERSION (-100)
void operating_klu_free(OperatingKLU *k) {
    if (!k) return;
    if (k->numeric) klu_l_free_numeric(&k->numeric,&k->common);
    if (k->symbolic) klu_l_free_symbolic(&k->symbolic,&k->common);
    free(k);
}
OperatingKLU *operating_klu_analyze(int64_t n,int64_t *pointers,int64_t *rows,int *status,int *loaded) {
    klu_version(loaded);
    if (loaded[0]!=KLU_MAIN_VERSION || loaded[1]!=KLU_SUB_VERSION || loaded[2]!=KLU_SUBSUB_VERSION) {
        *status=OPERATING_KLU_VERSION;
        return NULL;
    }
    OperatingKLU *k=calloc(1,sizeof(*k));
    if (!k) { *status=KLU_OUT_OF_MEMORY; return NULL; }
    if (!klu_l_defaults(&k->common)) { *status=k->common.status; free(k); return NULL; }
    k->symbolic=klu_l_analyze(n,pointers,rows,&k->common);
    *status=k->common.status;
    if (!k->symbolic || *status!=KLU_OK) { operating_klu_free(k); return NULL; }
    return k;
}
/* Keep Numeric only for a complete nonsingular factorization. */
static int operating_klu_settle(OperatingKLU *k,int succeeded,int64_t *singular) {
    int status=k->common.status;
    *singular=k->common.singular_col;
    if (succeeded && status==KLU_OK && k->numeric) return KLU_OK;
    if (k->numeric) klu_l_free_numeric(&k->numeric,&k->common);
    return status==KLU_OK ? KLU_INVALID : status;
}
int operating_klu_factor(OperatingKLU *k,int64_t *pointers,int64_t *rows,double *values,int64_t *singular) {
    if (k->numeric) klu_l_free_numeric(&k->numeric,&k->common);
    k->numeric=klu_l_factor(pointers,rows,values,k->symbolic,&k->common);
    return operating_klu_settle(k,k->numeric!=NULL,singular);
}
int operating_klu_refactor(OperatingKLU *k,int64_t *pointers,int64_t *rows,double *values,int64_t *singular) {
    int succeeded=klu_l_refactor(pointers,rows,values,k->symbolic,k->numeric,&k->common);
    return operating_klu_settle(k,succeeded,singular);
}
int operating_klu_solve(OperatingKLU *k,int64_t n,double *rhs) {
    int succeeded=klu_l_solve(k->symbolic,k->numeric,n,1,rhs,&k->common);
    return succeeded && k->common.status==KLU_OK ? KLU_OK
        : (k->common.status==KLU_OK ? KLU_INVALID : k->common.status);
}
int operating_klu_rcond(OperatingKLU *k,double *rcond) {
    int succeeded=klu_l_rcond(k->symbolic,k->numeric,&k->common);
    *rcond=k->common.rcond;
    return succeeded && k->common.status==KLU_OK ? KLU_OK
        : (k->common.status==KLU_OK ? KLU_INVALID : k->common.status);
}
#ifdef OPERATING_IDAS
static int quadrature_rhs(double t, N_Vector y, N_Vector yp, N_Vector rq, void *v) {
    OperatingIDA *o = v;
    return o->quadrature(o->user,t,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),N_VGetArrayPointer(rq));
}
/* Stock IDAQuadInit from q0, excluded from the error test (IDASetQuadErrCon
   false), so the state trajectory is the one without quadratures. */
int operating_ida_quadrature_init(OperatingIDA *o,int64_t nq,const double *q0,Quadrature f) {
    if (o->q || nq<=0) return IDA_ILL_INPUT;
    o->q=N_VNew_Serial(nq,o->ctx);
    if (!o->q) return IDA_MEM_FAIL;
    memcpy(N_VGetArrayPointer(o->q),q0,nq*sizeof(double));
    o->quadrature=f;
    int code=IDAQuadInit(o->ida,quadrature_rhs,o->q);
    if (code>=0) code=IDASetQuadErrCon(o->ida,SUNFALSE);
    return code;
}
/* Stock IDAQuadReInit from q0, for a restart by IDAReInit. */
int operating_ida_quadrature_reinit(OperatingIDA *o,const double *q0) {
    if (!o->q) return IDA_ILL_INPUT;
    memcpy(N_VGetArrayPointer(o->q),q0,N_VGetLength(o->q)*sizeof(double));
    return IDAQuadReInit(o->ida,o->q);
}
/* Stock IDAS IDAGetQuadDky (k = 0): the quadratures at t within the last
   accepted step. */
int operating_ida_quadrature_at(OperatingIDA *o,double t,double *q) {
    if (!o->q) return IDA_ILL_INPUT;
    N_Vector out=N_VClone(o->q);
    if (!out) return IDA_MEM_FAIL;
    int code=IDAGetQuadDky(o->ida,t,0,out);
    if (code>=0) memcpy(q,N_VGetArrayPointer(out),N_VGetLength(out)*sizeof(double));
    N_VDestroy(out);
    return code;
}
/* Stock IDAGetQuad: the quadratures at the last returned time. */
int operating_ida_quadrature(OperatingIDA *o,double *time,double *q) {
    if (!o->q) return IDA_ILL_INPUT;
    N_Vector out=N_VClone(o->q);
    if (!out) return IDA_MEM_FAIL;
    int code=IDAGetQuad(o->ida,time,out);
    if (code>=0) memcpy(q,N_VGetArrayPointer(out),N_VGetLength(out)*sizeof(double));
    N_VDestroy(out);
    return code;
}
#endif

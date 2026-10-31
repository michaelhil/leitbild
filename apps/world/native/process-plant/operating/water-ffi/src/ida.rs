//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Owned, opt-in boundary to the explicitly linked stock IDA/KLU build.
//! No solver implementation, numerical fallback, or physical model lives here.
use leitbild_operating_plant::cost;
use std::{
    ffi::{c_int, c_long, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr::NonNull,
};

#[derive(Debug)]
pub enum Failure {
    /// Constitutive trial unavailable: IDA may retry, never clip the state.
    Recoverable(String),
    /// A model/ownership error cannot be hidden by a later successful callback.
    Fatal(String),
}
pub type Result<T> = std::result::Result<T, String>;
pub trait System {
    fn dimension(&self) -> usize;
    fn nonzeros(&self) -> usize;
    /// Number of root functions g(t,y,yp), read once at construction. A
    /// system without discrete-event roots states 0 explicitly.
    fn root_count(&self) -> usize;
    fn residual(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> std::result::Result<(), Failure>;
    /// Fill the complete CSC structure and values of dF/dy+cj*dF/dyp.
    #[allow(clippy::too_many_arguments)] // Mirrors IDALsJacFn without another adapter object.
    fn jacobian(
        &mut self,
        time: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> std::result::Result<(), Failure>;
    /// Fill all `root_count` finite root-function values. Stock IDA cannot
    /// retry a root evaluation, so every failure here is fatal to the handle.
    fn roots(
        &mut self,
        time: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> std::result::Result<(), Failure>;
    /// Stock KLU's fill-reducing ordering for this system's iteration
    /// matrix, set on SUNLinSol_KLU at construction, before KLU's first
    /// symbolic analysis. Stock SUNLinSol_KLU's own default is COLAMD.
    fn klu_ordering(&self) -> KluOrdering {
        KluOrdering::Colamd
    }
    /// E-NUC (plan r4): per coordinate, how many identical coordinates of
    /// the unreduced model it stands for, read once at construction. `None`
    /// (the default) or all ones: the system is unreduced. Otherwise the
    /// handle weights every coordinate so that stock's WRMS norm of this
    /// system equals stock's norm of the unreduced one ([`WeightGroups`]).
    fn multiplicities(&self) -> Option<Vec<f64>> {
        None
    }
    /// Number of quadratures `q' = fQ(t,y,yp)` (stock IDAS, the
    /// `quadratures` feature). A system without them states nothing.
    fn quadrature_count(&self) -> usize {
        0
    }
    /// Fill the `quadrature_count` integrands at a converged step.
    fn quadrature(
        &mut self,
        _time: f64,
        _y: &[f64],
        _yp: &[f64],
        _out: &mut [f64],
    ) -> std::result::Result<(), Failure> {
        Err(Failure::Fatal("this system declares no quadratures".into()))
    }
}
/// Stock KLU's fill-reducing ordering (SUNLinSol_KLUSetOrdering).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KluOrdering {
    Amd,
    Colamd,
}
/// Successful `advance` outcome; the output buffers hold the state at `time`.
#[derive(Clone, Debug, PartialEq)]
pub enum Advance {
    /// IDA_SUCCESS at the requested target or IDA_TSTOP_RETURN at the armed
    /// stop boundary; the returned time distinguishes them.
    Reached(f64),
    /// IDA_ROOT_RETURN at a located root. `directions` is IDAGetRootInfo per
    /// root function: +1 rising, -1 falling through zero, 0 no root found.
    Root { time: f64, directions: Vec<i32> },
}
impl Advance {
    /// Time reached by a system that declares no roots; a root is an error.
    pub fn reached(self) -> Result<f64> {
        match self {
            Self::Reached(time) => Ok(time),
            Self::Root { time, directions } => Err(format!(
                "unexpected stock IDA root return at {time} s: {directions:?}"
            )),
        }
    }
}
pub struct Initial<'a> {
    pub time: f64,
    pub y: &'a [f64],
    pub yp: &'a [f64],
    pub differential: &'a [f64],
    pub absolute_tolerance: &'a [f64],
    pub relative_tolerance: f64,
}
/// Stock counters. `reinitialize` (IDAReInit) restarts the integrator
/// counts; the Jacobian count restarts at the next stock setup.
#[derive(Debug)]
pub struct Stats {
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub nonlinear_iterations: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    /// IDAGetNumLinSolvSetups: iteration-matrix setups (KLU factorizations).
    pub linear_setups: i64,
    /// IDAGetNumGEvals: root-function evaluations.
    pub root_evaluations: i64,
    /// IDAGetLastOrder: BDF order of the last accepted step (0 before any).
    pub last_order: i32,
    /// IDAGetCurrentOrder: order stock will attempt next.
    pub current_order: i32,
    pub last_step: f64,
    /// IDAGetCurrentStep: step stock will attempt next.
    pub current_step: f64,
    pub internal_time: f64,
}
type Residual = unsafe extern "C" fn(*mut c_void, f64, *const f64, *const f64, *mut f64) -> c_int;
type Jacobian = unsafe extern "C" fn(
    *mut c_void,
    f64,
    f64,
    *const f64,
    *const f64,
    *mut f64,
    *mut i64,
    *mut i64,
) -> c_int;
type Roots = unsafe extern "C" fn(*mut c_void, f64, *const f64, *const f64, *mut f64) -> c_int;
#[cfg(feature = "quadratures")]
type Quadrature = unsafe extern "C" fn(*mut c_void, f64, *const f64, *const f64, *mut f64) -> c_int;
type Weights = unsafe extern "C" fn(*mut c_void, *const f64, *mut f64) -> c_int;
type CostEnter = extern "C" fn(c_int);
type CostExit = extern "C" fn();
/// PERF E-PROF: stock KLU's setup (0) and solve (1) inside the cost
/// profile's scopes, when one is installed at construction.
extern "C" fn klu_enter(kind: c_int) {
    cost::enter(if kind == 0 { "klu-setup" } else { "klu-solve" });
}
extern "C" fn klu_exit() {
    cost::exit();
}
/// The profile scope of a step `k` steps after its segment start.
fn step_scope(k: u64) -> &'static str {
    match k {
        0 => "step[1]",
        1..=4 => "step[2-5]",
        5..=19 => "step[6-20]",
        20..=99 => "step[21-100]",
        _ => "step[101+]",
    }
}
const IDA_SUCCESS: c_int = 0;
const IDA_TSTOP_RETURN: c_int = 1;
const IDA_ROOT_RETURN: c_int = 2;
unsafe extern "C" {
    fn operating_ida_create(
        n: i64,
        nnz: i64,
        t: f64,
        rtol: f64,
        atol: *const f64,
        ids: *const f64,
        y: *const f64,
        yp: *const f64,
        f: Residual,
        j: Jacobian,
        nroots: c_int,
        g: Roots,
        user: *mut c_void,
        enter: Option<CostEnter>,
        leave: Option<CostExit>,
        status: *mut c_int,
    ) -> *mut c_void;
    fn operating_ida_free(ida: *mut c_void);
    fn operating_ida_initialize(ida: *mut c_void, horizon: f64, y: *mut f64, yp: *mut f64)
    -> c_int;
    fn operating_ida_advance(
        ida: *mut c_void,
        target: f64,
        time: *mut f64,
        y: *mut f64,
        yp: *mut f64,
    ) -> c_int;
    fn operating_ida_stats(
        ida: *mut c_void,
        counts: *mut c_long,
        orders: *mut c_int,
        steps: *mut f64,
    ) -> c_int;
    fn operating_ida_max_order(ida: *mut c_void, order: c_int) -> c_int;
    fn operating_ida_tolerances(ida: *mut c_void, rtol: f64, atol: *const f64) -> c_int;
    fn operating_ida_weight_function(ida: *mut c_void, w: Weights) -> c_int;
    fn operating_ida_max_step(ida: *mut c_void, step: f64) -> c_int;
    fn operating_ida_init_step(ida: *mut c_void, step: f64) -> c_int;
    fn operating_ida_quadratures_linked() -> c_int;
    fn operating_ida_rebuild_every(ida: *mut c_void, steps: c_long, held: c_long) -> c_int;
    fn operating_ida_rebuild_counts(ida: *mut c_void, counts: *mut c_long) -> c_int;
    #[cfg(feature = "quadratures")]
    fn operating_ida_quadrature_init(
        ida: *mut c_void,
        nq: i64,
        q0: *const f64,
        f: Quadrature,
    ) -> c_int;
    #[cfg(feature = "quadratures")]
    fn operating_ida_quadrature_reinit(ida: *mut c_void, q0: *const f64) -> c_int;
    #[cfg(feature = "quadratures")]
    fn operating_ida_quadrature(ida: *mut c_void, time: *mut f64, q: *mut f64) -> c_int;
    #[cfg(feature = "quadratures")]
    fn operating_ida_quadrature_at(ida: *mut c_void, t: f64, q: *mut f64) -> c_int;
    fn operating_ida_solution_scaling(ida: *mut c_void, enabled: c_int) -> c_int;
    fn operating_ida_newton_coefficient(ida: *mut c_void, coefficient: f64) -> c_int;
    fn operating_ida_delta_cj(ida: *mut c_void, dcj: f64) -> c_int;
    fn operating_ida_klu_ordering(ida: *mut c_void, ordering: c_int) -> c_int;
    fn operating_ida_reinitialize(ida: *mut c_void, t: f64, y: *const f64, yp: *const f64)
    -> c_int;
    fn operating_ida_root_directions(ida: *mut c_void, directions: *mut c_int) -> c_int;
    fn operating_ida_set_root_direction(ida: *mut c_void, directions: *mut c_int) -> c_int;
    fn operating_ida_step(
        ida: *mut c_void,
        target: f64,
        time: *mut f64,
        y: *mut f64,
        yp: *mut f64,
    ) -> c_int;
    fn operating_ida_dky(ida: *mut c_void, t: f64, k: c_int, out: *mut f64) -> c_int;
    fn operating_ida_differential(ida: *mut c_void, ids: *const f64) -> c_int;
    fn operating_ida_stop_at(ida: *mut c_void, target: f64) -> c_int;
    fn operating_ida_nonnegative(ida: *mut c_void, flags: *const f64) -> c_int;
    fn operating_ida_current_time(ida: *mut c_void, time: *mut f64) -> c_int;
    fn operating_ida_current_state(
        ida: *mut c_void,
        time: *mut f64,
        y: *mut f64,
        yp: *mut f64,
    ) -> c_int;
    fn operating_ida_error_diagnostics(
        ida: *mut c_void,
        errors: *mut f64,
        weights: *mut f64,
        order: *mut c_int,
    ) -> c_int;
}
struct Context<S> {
    system: S,
    n: usize,
    nnz: usize,
    roots: usize,
    /// Quadratures initialized on this handle (stock IDAS), else 0.
    quadratures: usize,
    fatal: Option<String>,
    last_trial: Option<String>,
    /// N1: the grouped error-weight rule in force, if any.
    grouped: Option<Grouped>,
    /// E-NUC: the system's multiplicities when any differs from 1.
    multiplicity: Option<Vec<f64>>,
}
/// The grouped rule's per-coordinate factor and the tolerances it divides.
struct Grouped {
    groups: WeightGroups,
    factor: Vec<f64>,
    relative: f64,
    absolute: Vec<f64>,
}
/// N1 (Operable Unit plan, R1 S1): every coordinate in exactly one named
/// group. Under [`Ida::group_weights`] coordinate `i` of group `g` (`n_g`
/// coordinates of `N`) is weighted `w_i = sqrt(N / n_g) / (rtol |y_i| +
/// atol_i)` through stock IDAWFtolerances, so stock's WRMS norm becomes
/// `sqrt(sum_g RMS_g^2)`, `RMS_g` the group's root mean square in its
/// declared tolerances: a norm at most 1 holds every group's RMS within its
/// tolerance whatever the group's size, and no weight is below stock's.
#[derive(Clone, Debug, PartialEq)]
pub struct WeightGroups {
    names: Vec<String>,
    of: Vec<usize>,
    sizes: Vec<usize>,
}
impl WeightGroups {
    /// Groups named by each coordinate's key, in order of first appearance.
    pub fn from_keys<K: AsRef<str>>(keys: &[K]) -> Self {
        let mut index = std::collections::HashMap::<&str, usize>::new();
        let mut names = Vec::new();
        let mut sizes = Vec::new();
        let of = keys
            .iter()
            .map(|k| {
                let g = *index.entry(k.as_ref()).or_insert_with(|| {
                    names.push(k.as_ref().to_string());
                    sizes.push(0);
                    names.len() - 1
                });
                sizes[g] += 1;
                g
            })
            .collect();
        Self { names, of, sizes }
    }
    pub fn len(&self) -> usize {
        self.of.len()
    }
    pub fn is_empty(&self) -> bool {
        self.of.is_empty()
    }
    /// Group names, sizes and each coordinate's group.
    pub fn names(&self) -> &[String] {
        &self.names
    }
    pub fn sizes(&self) -> &[usize] {
        &self.sizes
    }
    pub fn group_of(&self) -> &[usize] {
        &self.of
    }
    /// `sqrt(N / n_g)` per coordinate.
    pub fn factors(&self) -> Vec<f64> {
        self.factors_for(None)
    }
    /// E-NUC: the factors of a reduced system whose coordinate `i` stands
    /// for `m_i` identical coordinates of the unreduced one,
    /// `sqrt(m_i N / M_g)` with `M_g = sum_{j in g} m_j`. A vector whose
    /// replicas are equal then has the same WRMS norm here as the unreduced
    /// model's under the unreduced groups (`sqrt(N' / n'_g)`): stock's norm
    /// when there is one group. With every `m_i = 1` it is [`Self::factors`]
    /// bit for bit.
    pub fn factors_for(&self, multiplicity: Option<&[f64]>) -> Vec<f64> {
        let n = self.of.len() as f64;
        let Some(m) = multiplicity else {
            return self
                .of
                .iter()
                .map(|g| (n / self.sizes[*g] as f64).sqrt())
                .collect();
        };
        let mut weighted = vec![0.; self.sizes.len()];
        for (g, mi) in self.of.iter().zip(m) {
            weighted[*g] += mi;
        }
        self.of
            .iter()
            .zip(m)
            .map(|(g, mi)| (mi * n / weighted[*g]).sqrt())
            .collect()
    }
}
/// A handle's error-weight rule ([`Ida::weight_rule`]): stock's
/// `1 / (rtol |y| + atol)`, times `sqrt(N / n_g)` under weight groups (N1).
/// The guard of the exact consistent start reads its weights here, while the
/// handle's system is borrowed, so it measures in stock's own norm.
#[derive(Clone, Debug, PartialEq)]
pub struct WeightRule {
    factor: Option<Vec<f64>>,
}
impl WeightRule {
    /// Whether the rule is grouped (N1) rather than stock's.
    pub fn grouped(&self) -> bool {
        self.factor.is_some()
    }
    /// The weights of the handle's first `y.len()` coordinates at `y` for
    /// the tolerances `relative`, `absolute` (a segment's, which may not be
    /// set on the handle yet).
    pub fn weights(
        &self,
        y: &[f64],
        relative: f64,
        absolute: &[f64],
        out: &mut [f64],
    ) -> Result<()> {
        if absolute.len() != y.len()
            || out.len() != y.len()
            || self.factor.as_ref().is_some_and(|f| f.len() < y.len())
        {
            return Err("IDA weights dimension".into());
        }
        let factor = self.factor.as_ref().map(|f| &f[..y.len()]);
        if weight_rule(factor, relative, absolute, y, out) {
            Ok(())
        } else {
            Err("an error weight is not finite and positive".into())
        }
    }
}
/// The one weight rule of a handle at `y` under `relative`, `absolute`
/// (and the group factors when grouped): stock's `1 / (rtol |y| + atol)`
/// times the factor. `false` when a weight is not finite and positive.
fn weight_rule(
    factor: Option<&[f64]>,
    relative: f64,
    absolute: &[f64],
    y: &[f64],
    out: &mut [f64],
) -> bool {
    for (i, w) in out.iter_mut().enumerate() {
        let stock = 1. / (relative * y[i].abs() + absolute[i]);
        *w = match factor {
            Some(f) => f[i] * stock,
            None => stock,
        };
        if !(w.is_finite() && *w > 0.) {
            return false;
        }
    }
    true
}
impl<S> Context<S> {
    fn status(&mut self, result: std::thread::Result<std::result::Result<(), Failure>>) -> c_int {
        match result {
            Ok(Ok(())) => 0,
            Ok(Err(Failure::Recoverable(reason))) => {
                self.last_trial = Some(reason);
                1
            }
            Ok(Err(Failure::Fatal(reason))) => {
                self.fatal.get_or_insert(reason);
                -1
            }
            Err(_) => {
                self.fatal
                    .get_or_insert("panic caught at IDA callback boundary".into());
                -1
            }
        }
    }
    /// Root evaluations have no stock retry path and must be finite.
    fn root_status(
        &mut self,
        result: std::thread::Result<std::result::Result<(), Failure>>,
        values: &[f64],
    ) -> c_int {
        let reason = match result {
            Ok(Ok(())) => match values.iter().position(|v| !v.is_finite()) {
                None => return 0,
                Some(i) => format!("root function {i} is not finite ({})", values[i]),
            },
            Ok(Err(Failure::Recoverable(reason))) => {
                format!("root function cannot be retried by stock IDA: {reason}")
            }
            Ok(Err(Failure::Fatal(reason))) => reason,
            Err(_) => "panic caught at IDA root boundary".into(),
        };
        self.fatal.get_or_insert(reason);
        -1
    }
}
unsafe extern "C" fn residual<S: System>(
    user: *mut c_void,
    t: f64,
    y: *const f64,
    yp: *const f64,
    out: *mut f64,
) -> c_int {
    // SAFETY: C retains the stable Box until the IDA handle is destroyed.
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let _cost = cost::scope("residual");
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.residual(
            t,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            std::slice::from_raw_parts_mut(out, c.n),
        )
    }));
    c.status(result)
}
unsafe extern "C" fn jacobian<S: System>(
    user: *mut c_void,
    t: f64,
    cj: f64,
    y: *const f64,
    yp: *const f64,
    data: *mut f64,
    rows: *mut i64,
    pointers: *mut i64,
) -> c_int {
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let _cost = cost::scope("jacobian");
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.jacobian(
            t,
            cj,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            std::slice::from_raw_parts_mut(data, c.nnz),
            std::slice::from_raw_parts_mut(rows, c.nnz),
            std::slice::from_raw_parts_mut(pointers, c.n + 1),
        )
    }));
    c.status(result)
}
unsafe extern "C" fn roots<S: System>(
    user: *mut c_void,
    t: f64,
    y: *const f64,
    yp: *const f64,
    out: *mut f64,
) -> c_int {
    // SAFETY: as for residual; stock passes nrtfn = Context::roots values.
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, c.roots) };
    let _cost = cost::scope("roots");
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.roots(
            t,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            out,
        )
    }));
    c.root_status(result, out)
}
/// Stock IDAWFtolerances' rule (N1): the grouped weights at `y`. A
/// weight that is not finite and positive is a fatal model error.
unsafe extern "C" fn weights<S: System>(user: *mut c_void, y: *const f64, ewt: *mut f64) -> c_int {
    // SAFETY: as for residual; stock passes vectors of the handle's length.
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let Some(g) = &c.grouped else {
        c.fatal
            .get_or_insert("stock asked for grouped weights without a rule".into());
        return -1;
    };
    let (y, out) = unsafe {
        (
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts_mut(ewt, c.n),
        )
    };
    if weight_rule(Some(&g.factor), g.relative, &g.absolute, y, out) {
        0
    } else {
        c.fatal
            .get_or_insert("a grouped error weight is not finite and positive".into());
        -1
    }
}
#[cfg(feature = "quadratures")]
unsafe extern "C" fn quadrature<S: System>(
    user: *mut c_void,
    t: f64,
    y: *const f64,
    yp: *const f64,
    out: *mut f64,
) -> c_int {
    // SAFETY: as for residual; stock passes the initialized quadrature length.
    let c = unsafe { &mut *user.cast::<Context<S>>() };
    if c.fatal.is_some() {
        return -1;
    }
    let _cost = cost::scope("quadrature");
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        c.system.quadrature(
            t,
            std::slice::from_raw_parts(y, c.n),
            std::slice::from_raw_parts(yp, c.n),
            std::slice::from_raw_parts_mut(out, c.quadratures),
        )
    }));
    c.status(result)
}
/// Whether this binary's IDA glue was compiled against stock IDAS, the only
/// SUNDIALS integrator with quadratures. It must agree with the
/// `quadratures` feature; a run that needs the ledger checks it first.
pub fn quadratures_linked() -> bool {
    let linked = unsafe { operating_ida_quadratures_linked() } == 1;
    assert_eq!(
        linked,
        cfg!(feature = "quadratures"),
        "the IDA glue and the quadratures feature disagree; rebuild"
    );
    linked
}
/// MR-1's counts on one handle ([`Ida::rebuild_matrix_every`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rebuild {
    /// The check-point interval in steps (0: stock IDASolve).
    pub steps: i64,
    /// Check points held now, the most ever held, and how often stock
    /// IDAAdjReInit freed them at the held bound (restarts not counted).
    pub held: i64,
    pub most_held: i64,
    pub drops: i64,
}
#[cfg(not(feature = "quadratures"))]
const NO_QUADRATURES: &str = "stock IDA has no quadratures: this build links IDA, not IDAS (build with the quadratures feature)";
pub struct Ida<S: System> {
    handle: NonNull<c_void>,
    context: Box<Context<S>>,
    time: f64,
    failed: bool,
    /// Set by the first `advance` after construction or reinitialization.
    started: bool,
    /// HOOK (S3GATES, S3-D67; KERN to reconcile): the absolute tolerance
    /// vector stock was last given (construction or `set_tolerances`).
    absolute: Vec<f64>,
    /// The relative tolerance last given.
    relative: f64,
    /// PERF E-PROF: steps since the segment start (the profile's scopes).
    segment_steps: u64,
}
impl<S: System> Ida<S> {
    pub fn new(system: S, initial: Initial<'_>) -> Result<Self> {
        let n = system.dimension();
        let nnz = system.nonzeros();
        let root_count = system.root_count();
        let nroots = c_int::try_from(root_count)
            .map_err(|_| format!("{root_count} IDA root functions exceed C int"))?;
        if n == 0
            || nnz == 0
            || n > i64::MAX as usize
            || nnz > i64::MAX as usize
            || [
                initial.y,
                initial.yp,
                initial.differential,
                initial.absolute_tolerance,
            ]
            .iter()
            .any(|v| v.len() != n)
            || !initial.time.is_finite()
            || !initial.relative_tolerance.is_finite()
            || initial.relative_tolerance <= 0.
            || initial.y.iter().chain(initial.yp).any(|v| !v.is_finite())
            || initial
                .absolute_tolerance
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
            || initial.differential.iter().any(|v| *v != 0. && *v != 1.)
        {
            return Err("invalid IDA dimensions/state/tolerances/differential identity".into());
        }
        let mut context = Box::new(Context {
            system,
            n,
            nnz,
            roots: root_count,
            quadratures: 0,
            fatal: None,
            last_trial: None,
            grouped: None,
            multiplicity: None,
        });
        let mut status = 0;
        let handle = unsafe {
            operating_ida_create(
                n as i64,
                nnz as i64,
                initial.time,
                initial.relative_tolerance,
                initial.absolute_tolerance.as_ptr(),
                initial.differential.as_ptr(),
                initial.y.as_ptr(),
                initial.yp.as_ptr(),
                residual::<S>,
                jacobian::<S>,
                nroots,
                roots::<S>,
                (&mut *context as *mut Context<S>).cast(),
                cost::active().then_some(klu_enter as CostEnter),
                cost::active().then_some(klu_exit as CostExit),
                &mut status,
            )
        };
        let handle = NonNull::new(handle)
            .ok_or_else(|| format!("stock IDA construction failed ({status})"))?;
        let ordering = match context.system.klu_ordering() {
            KluOrdering::Amd => 0,
            KluOrdering::Colamd => 1,
        };
        let code = unsafe { operating_ida_klu_ordering(handle.as_ptr(), ordering) };
        if code < 0 {
            unsafe { operating_ida_free(handle.as_ptr()) };
            return Err(format!("stock SUNLinSol_KLUSetOrdering failed ({code})"));
        }
        let multiplicity = context.system.multiplicities();
        let mut ida = Self {
            handle,
            context,
            time: initial.time,
            failed: false,
            started: false,
            absolute: initial.absolute_tolerance.to_vec(),
            relative: initial.relative_tolerance,
            segment_steps: 0,
        };
        // E-NUC: a reduced system keeps the unreduced model's stock norm
        // through stock IDAWFtolerances: one group, each coordinate weighted
        // by its multiplicity ([`WeightGroups::factors_for`]).
        if let Some(m) = multiplicity {
            if m.len() != n || m.iter().any(|v| !(v.is_finite() && *v >= 1.)) {
                return Err(format!(
                    "{} multiplicities for {n} coordinates, or one below 1",
                    m.len()
                ));
            }
            if m.iter().any(|v| *v != 1.) {
                ida.context.multiplicity = Some(m);
                ida.group_weights(WeightGroups::from_keys(&vec!["stock"; n]))?;
            }
        }
        Ok(ida)
    }
    /// N1: group-normalised error weights ([`WeightGroups`]) through stock
    /// IDAWFtolerances on the tolerances in force, from the next step on: one
    /// rule for stock's error test, its Newton convergence test and its
    /// initial step, and the weights [`Self::weights`] gives the exact
    /// consistent start's guard. A segment option (before `advance`); given
    /// again at a later segment start it replaces the groups (a mode change
    /// that changes a coordinate's class). Once set, stock's own
    /// `rtol |y| + atol` weights do not return on this handle.
    pub fn group_weights(&mut self, groups: WeightGroups) -> Result<()> {
        self.configurable("weight groups")?;
        if groups.len() != self.context.n {
            return Err(format!(
                "weight groups cover {} coordinates, the handle has {}",
                groups.len(),
                self.context.n
            ));
        }
        let first = self.context.grouped.is_none();
        self.context.grouped = Some(Grouped {
            factor: groups.factors_for(self.context.multiplicity.as_deref()),
            groups,
            relative: self.relative,
            absolute: self.absolute.clone(),
        });
        if first {
            let code = unsafe { operating_ida_weight_function(self.handle.as_ptr(), weights::<S>) };
            if let Err(e) = self.check(code) {
                self.context.grouped = None;
                return Err(e);
            }
        }
        Ok(())
    }
    /// The error-weight rule in force, for receipts: stock IDASVtolerances
    /// (`"stock"`), or stock IDAWFtolerances carrying the coordinates'
    /// multiplicities under one group (E-NUC: the unreduced model's stock
    /// norm, `"stock-equivalent multiplicity rule"`), or N1's groups, with
    /// or without multiplicities.
    pub fn weight_rule_kind(&self) -> &'static str {
        match (&self.context.grouped, &self.context.multiplicity) {
            (None, _) => "stock",
            (Some(g), Some(_)) if g.groups.sizes().len() == 1 => "stock-equivalent multiplicity rule",
            (Some(_), Some(_)) => "N1 groups with multiplicities",
            (Some(_), None) => "N1 groups",
        }
    }
    /// The weight groups in force, if any (N1).
    pub fn weight_groups(&self) -> Option<&WeightGroups> {
        self.context.grouped.as_ref().map(|g| &g.groups)
    }
    /// This handle's error-weight rule, apart from the handle (N1).
    pub fn weight_rule(&self) -> WeightRule {
        WeightRule {
            factor: self.context.grouped.as_ref().map(|g| g.factor.clone()),
        }
    }
    /// HOOK (S3GATES, S3-D67): the absolute tolerances stock uses now, as
    /// last given (derived classes included).
    pub fn absolute_tolerances(&self) -> &[f64] {
        &self.absolute
    }
    fn buffers(&self, y: &[f64], yp: &[f64]) -> Result<()> {
        if y.len() != self.context.n || yp.len() != self.context.n {
            Err("IDA output dimension".into())
        } else {
            Ok(())
        }
    }
    fn check(&self, status: c_int) -> Result<()> {
        if let Some(reason) = &self.context.fatal {
            return Err(format!("fatal IDA callback: {reason}"));
        }
        if status < 0 {
            return Err(format!(
                "stock IDA status {status}; last unavailable trial: {:?}",
                self.context.last_trial
            ));
        }
        Ok(())
    }
    /// Stock IDACalcIC (IDA_YA_YDP_INIT) at a segment start: after
    /// construction or `reinitialize`, before `advance`. Stock history after
    /// a step holds scaled derivatives, not an initial-condition guess.
    pub fn initialize(&mut self, horizon: f64, y: &mut [f64], yp: &mut [f64]) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        if self.started {
            return Err(
                "IDA consistent initialization requires construction or reinitialize first".into(),
            );
        }
        self.buffers(y, yp)?;
        if !horizon.is_finite() || horizon <= self.time {
            return Err("IDA initialization horizon must be in the future".into());
        }
        let _cost = cost::scope("ic");
        let status = unsafe {
            operating_ida_initialize(
                self.handle.as_ptr(),
                horizon,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        let result = self.check(status);
        self.failed = result.is_err();
        result
    }
    /// Advance toward `target` with stock IDA_NORMAL. A located root of a
    /// declared root function returns early as `Advance::Root`.
    pub fn advance(&mut self, target: f64, y: &mut [f64], yp: &mut [f64]) -> Result<Advance> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        self.buffers(y, yp)?;
        if !target.is_finite() || target <= self.time {
            return Err("IDA target must be in the future".into());
        }
        self.started = true;
        let _cost = cost::scope("advance");
        let status = unsafe {
            operating_ida_advance(
                self.handle.as_ptr(),
                target,
                &mut self.time,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        let result = self.check(status).and_then(|()| self.outcome(status));
        self.failed = result.is_err();
        result
    }
    fn outcome(&self, status: c_int) -> Result<Advance> {
        match status {
            IDA_SUCCESS | IDA_TSTOP_RETURN => Ok(Advance::Reached(self.time)),
            IDA_ROOT_RETURN => {
                let mut directions = vec![0 as c_int; self.context.roots];
                let code = unsafe {
                    operating_ida_root_directions(self.handle.as_ptr(), directions.as_mut_ptr())
                };
                self.check(code)?;
                Ok(Advance::Root {
                    time: self.time,
                    directions,
                })
            }
            other => Err(format!("unadmitted stock IDA solve status {other}")),
        }
    }
    /// Restart stock history at `time` from (`y`, `yp`) after a physical
    /// discrete event (IDAReInit). Tolerances, differential identity,
    /// constraints, roots, the KLU linear solver, Jacobian callback, an armed
    /// stop boundary and options are retained; stock counters restart. This
    /// does not make the restarted state consistent: call `initialize` when
    /// algebraic values or derivatives must be recomputed (IDACalcIC).
    pub fn reinitialize(&mut self, time: f64, y: &[f64], yp: &[f64]) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        self.buffers(y, yp)?;
        if !time.is_finite() || y.iter().chain(yp).any(|v| !v.is_finite()) {
            return Err("IDA reinitialization requires a finite time and state".into());
        }
        let _cost = cost::scope("reinit");
        let status = unsafe {
            operating_ida_reinitialize(self.handle.as_ptr(), time, y.as_ptr(), yp.as_ptr())
        };
        let result = self.check(status);
        self.failed = result.is_err();
        result?;
        self.time = time;
        self.started = false;
        self.segment_steps = 0;
        Ok(())
    }
    /// IDASetId on this instance after a structural discrete event, such as a
    /// seized rotor whose rate row becomes algebraic: 1 marks a differential
    /// and 0 an algebraic coordinate. Allowed only at a segment start (after
    /// construction or `reinitialize`, before `advance`); follow it with
    /// `initialize` so IDACalcIC recomputes the new algebraic values and the
    /// differential derivatives. Changing the residual equations themselves
    /// through `system_mut` belongs at the same reinitialization.
    pub fn set_differential(&mut self, ids: &[f64]) -> Result<()> {
        self.configurable("differential identity")?;
        if ids.len() != self.context.n || ids.iter().any(|v| *v != 0. && *v != 1.) {
            return Err("IDA differential identity needs one 0/1 value per coordinate".into());
        }
        let code = unsafe { operating_ida_differential(self.handle.as_ptr(), ids.as_ptr()) };
        self.check(code)
    }
    /// Options configure the next integration segment only. Stock reads the
    /// Newton coefficient at its first step and cannot safely lower an active
    /// BDF order, so every option is refused once `advance` has started; only
    /// `remove_max_step` may lift a step bound mid-segment.
    fn configurable(&self, option: &str) -> Result<()> {
        if self.failed {
            Err("IDA handle is fail-stopped".into())
        } else if self.started {
            Err(format!(
                "IDA {option} may change only after construction or reinitialization, before advance"
            ))
        } else {
            Ok(())
        }
    }
    /// Stock IDASetRootDirection: one of -1, 0, +1 per declared root
    /// function (+1 locates rising crossings only, -1 falling only, 0 both;
    /// stock's default is 0 for every function). A segment option like the
    /// others: before `advance`; stock keeps it across IDAReInit.
    pub fn set_root_directions(&mut self, directions: &[i32]) -> Result<()> {
        self.configurable("root directions")?;
        if directions.len() != self.context.roots
            || directions.is_empty()
            || directions.iter().any(|d| !(-1..=1).contains(d))
        {
            return Err("IDA root directions need one of -1, 0, +1 per root function".into());
        }
        // Stock copies the array, so the copy may drop after the call.
        let mut copy: Vec<c_int> = directions.to_vec();
        let code =
            unsafe { operating_ida_set_root_direction(self.handle.as_ptr(), copy.as_mut_ptr()) };
        self.check(code)
    }
    /// Stock IDASVtolerances: the segment's relative and absolute
    /// tolerances (finite, positive), a segment option like the others
    /// (before `advance`); for a derived class that changes at a
    /// reinitialization, such as an equilibrium cell's vapor class at a
    /// phase-mode change (S3-D3). Under [`Self::group_weights`] the grouped
    /// rule takes the new tolerances instead (N1).
    pub fn set_tolerances(&mut self, relative: f64, absolute: &[f64]) -> Result<()> {
        self.configurable("tolerances")?;
        if absolute.len() != self.context.n
            || !relative.is_finite()
            || relative <= 0.
            || absolute.iter().any(|a| !a.is_finite() || *a <= 0.)
        {
            return Err(
                "IDA tolerances need a positive rtol and one positive atol per coordinate".into(),
            );
        }
        if let Some(g) = self.context.grouped.as_mut() {
            // N1: the grouped rule reads the tolerances at each weight
            // evaluation; stock IDASVtolerances would replace the rule.
            g.relative = relative;
            g.absolute.copy_from_slice(absolute);
        } else {
            let code = unsafe {
                operating_ida_tolerances(self.handle.as_ptr(), relative, absolute.as_ptr())
            };
            self.check(code)?;
        }
        self.absolute.copy_from_slice(absolute);
        self.relative = relative;
        Ok(())
    }
    /// IDASetMaxOrd; stock admits 1 through its allocated maximum order 5.
    pub fn set_max_order(&mut self, order: usize) -> Result<()> {
        self.configurable("maximum order")?;
        let order = c_int::try_from(order)
            .map_err(|_| format!("IDA maximum order {order} exceeds C int"))?;
        let code = unsafe { operating_ida_max_order(self.handle.as_ptr(), order) };
        self.check(code)
    }
    /// IDASetMaxStep: a positive bound on |h|; +inf removes the bound
    /// explicitly. Stock's zero sentinel for "unbounded" and NaN are refused.
    pub fn set_max_step(&mut self, step: f64) -> Result<()> {
        self.configurable("maximum step")?;
        if step.is_nan() || step <= 0. {
            return Err(format!("IDA maximum step {step} must be positive"));
        }
        let code = unsafe { operating_ida_max_step(self.handle.as_ptr(), step) };
        self.check(code)
    }
    /// Remove the IDASetMaxStep bound, also between advances of an active
    /// segment: the end of a capped window continues the same history with no
    /// reinitialization. Stock reads the bound at every step-size selection,
    /// so the removal applies from the next one. Setting or lowering a bound
    /// stays refused once `advance` has started (`set_max_step`), because
    /// stock would not re-limit the step it has already selected.
    pub fn remove_max_step(&mut self) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        let code = unsafe { operating_ida_max_step(self.handle.as_ptr(), f64::INFINITY) };
        self.check(code)
    }
    /// IDASetInitStep: the first step of the next segment, finite and
    /// positive. Stock keeps it across IDAReInit, so a caller that restarts
    /// sets it explicitly each time; stock still error-tests that step.
    pub fn set_init_step(&mut self, step: f64) -> Result<()> {
        self.configurable("initial step")?;
        if !step.is_finite() || step <= 0. {
            return Err(format!(
                "IDA initial step {step} must be finite and positive"
            ));
        }
        let code = unsafe { operating_ida_init_step(self.handle.as_ptr(), step) };
        self.check(code)
    }
    /// Stock IDAS IDAQuadInit from `q0`, with IDASetQuadErrCon false: the
    /// quadratures follow the accepted steps and never enter the error
    /// test, so the state trajectory is unchanged. Once per handle, before
    /// `advance`; a restart by `reinitialize` takes `reinitialize_quadratures`.
    #[cfg(feature = "quadratures")]
    pub fn initialize_quadratures(&mut self, q0: &[f64]) -> Result<()> {
        self.configurable("quadratures")?;
        let count = self.context.system.quadrature_count();
        if self.context.quadratures != 0 || count == 0 || q0.len() != count {
            return Err("IDAS quadratures: once per handle, with the system's count".into());
        }
        if q0.iter().any(|v| !v.is_finite()) {
            return Err("IDAS quadrature initial values must be finite".into());
        }
        self.context.quadratures = count;
        let code = unsafe {
            operating_ida_quadrature_init(
                self.handle.as_ptr(),
                count as i64,
                q0.as_ptr(),
                quadrature::<S>,
            )
        };
        self.check(code)
    }
    /// Stock IDAS IDAQuadReInit from `q0`, after `reinitialize`.
    #[cfg(feature = "quadratures")]
    pub fn reinitialize_quadratures(&mut self, q0: &[f64]) -> Result<()> {
        self.configurable("quadratures")?;
        if self.context.quadratures == 0 || q0.len() != self.context.quadratures {
            return Err("IDAS quadratures were not initialized with this length".into());
        }
        let code = unsafe { operating_ida_quadrature_reinit(self.handle.as_ptr(), q0.as_ptr()) };
        self.check(code)
    }
    /// The quadratures stock IDAS integrates on this handle: zero until
    /// `initialize_quadratures` (always zero without the `quadratures`
    /// feature).
    pub fn quadrature_count(&self) -> usize {
        self.context.quadratures
    }
    /// Stock IDAS IDAGetQuad: the quadratures at the last returned time.
    #[cfg(feature = "quadratures")]
    pub fn quadratures(&self, q: &mut [f64]) -> Result<f64> {
        if self.context.quadratures == 0 || q.len() != self.context.quadratures {
            return Err("IDAS quadratures were not initialized with this length".into());
        }
        let mut time = 0.;
        let code =
            unsafe { operating_ida_quadrature(self.handle.as_ptr(), &mut time, q.as_mut_ptr()) };
        self.check(code)?;
        Ok(time)
    }
    /// Stock IDAS IDAGetQuadDky: the quadratures at `t` within the last
    /// accepted step, for example at the internal time `current_state` reads.
    #[cfg(feature = "quadratures")]
    pub fn quadratures_at(&self, t: f64, q: &mut [f64]) -> Result<()> {
        if self.context.quadratures == 0 || q.len() != self.context.quadratures {
            return Err("IDAS quadratures were not initialized with this length".into());
        }
        let code = unsafe { operating_ida_quadrature_at(self.handle.as_ptr(), t, q.as_mut_ptr()) };
        if code < 0 {
            return Err(format!("stock IDAS IDAGetQuadDky status {code} at {t} s"));
        }
        Ok(())
    }
    #[cfg(not(feature = "quadratures"))]
    pub fn quadratures_at(&self, _: f64, _: &mut [f64]) -> Result<()> {
        Err(NO_QUADRATURES.into())
    }
    /// Without stock IDAS a ledger is refused, never emulated.
    #[cfg(not(feature = "quadratures"))]
    pub fn initialize_quadratures(&mut self, _: &[f64]) -> Result<()> {
        Err(NO_QUADRATURES.into())
    }
    #[cfg(not(feature = "quadratures"))]
    pub fn reinitialize_quadratures(&mut self, _: &[f64]) -> Result<()> {
        Err(NO_QUADRATURES.into())
    }
    #[cfg(not(feature = "quadratures"))]
    pub fn quadratures(&self, _: &mut [f64]) -> Result<f64> {
        Err(NO_QUADRATURES.into())
    }
    /// IDASetLinearSolutionScaling for the matrix-based KLU solver (stock
    /// enables it): rescale linear solutions after a changed cj.
    pub fn set_linear_solution_scaling(&mut self, enabled: bool) -> Result<()> {
        self.configurable("linear solution scaling")?;
        let code =
            unsafe { operating_ida_solution_scaling(self.handle.as_ptr(), c_int::from(enabled)) };
        self.check(code)
    }
    /// IDASetNonlinConvCoef: finite positive Newton convergence coefficient.
    pub fn set_nonlinear_convergence_coefficient(&mut self, coefficient: f64) -> Result<()> {
        self.configurable("nonlinear convergence coefficient")?;
        if !coefficient.is_finite() || coefficient <= 0. {
            return Err(format!(
                "IDA nonlinear convergence coefficient {coefficient} must be finite and positive"
            ));
        }
        let code = unsafe { operating_ida_newton_coefficient(self.handle.as_ptr(), coefficient) };
        self.check(code)
    }
    /// IDASetDeltaCjLSetup: stock sets the iteration matrix up again when
    /// `cj/cj_old` leaves `((1-dcj)/(1+dcj), (1+dcj)/(1-dcj))`; stock's default
    /// is 0.25, and 0 sets it up at every change of `cj`. Stock silently
    /// replaces a value outside `[0, 1)` with its default, so such a value
    /// is refused here instead.
    pub fn set_delta_cj_lsetup(&mut self, dcj: f64) -> Result<()> {
        self.configurable("linear-setup cj ratio bound")?;
        if !(0. ..1.).contains(&dcj) {
            return Err(format!("IDA dcj {dcj} must lie in [0, 1)"));
        }
        let code = unsafe { operating_ida_delta_cj(self.handle.as_ptr(), dcj) };
        self.check(code)
    }
    /// Only actual intervention/event boundaries and the final horizon require
    /// a forced endpoint. Ordinary observation calls use IDA interpolation.
    pub fn stop_at(&mut self, target: f64) -> Result<()> {
        if self.failed || !target.is_finite() || target <= self.time {
            return Err("invalid IDA stop boundary".into());
        }
        let code = unsafe { operating_ida_stop_at(self.handle.as_ptr(), target) };
        self.check(code)
    }
    pub fn system(&self) -> &S {
        &self.context.system
    }
    /// Read the stock solution history at its latest internal accepted endpoint.
    /// Ordinary `advance` buffers may instead hold an earlier requested-time
    /// interpolant. Independent native scratch avoids overwriting either those
    /// buffers or solver history. No step, tolerance or failure status changes.
    pub fn current_state(&self, y: &mut [f64], yp: &mut [f64]) -> Result<f64> {
        self.buffers(y, yp)?;
        let mut time = 0.;
        let status = unsafe {
            operating_ida_current_state(
                self.handle.as_ptr(),
                &mut time,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        if status < 0 {
            return Err(format!("stock IDA current-state query failed ({status})"));
        }
        Ok(time)
    }
    /// Stock IDA_ONE_STEP: one internal step toward `target` (an armed stop
    /// boundary is never passed); a located root returns early as
    /// `Advance::Root`. An observer reads each accepted step by
    /// [`Self::dense`] instead of `advance` calls at the observation rate
    /// (S3-D1 #7; IC-PROT's frame driver).
    pub fn step(&mut self, target: f64, y: &mut [f64], yp: &mut [f64]) -> Result<Advance> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        self.buffers(y, yp)?;
        if !target.is_finite() || target <= self.time {
            return Err("IDA target must be in the future".into());
        }
        self.started = true;
        let _cost = cost::scope(step_scope(self.segment_steps));
        self.segment_steps += 1;
        let status = unsafe {
            operating_ida_step(
                self.handle.as_ptr(),
                target,
                &mut self.time,
                y.as_mut_ptr(),
                yp.as_mut_ptr(),
            )
        };
        let result = self.check(status).and_then(|()| self.outcome(status));
        self.failed = result.is_err();
        result
    }
    /// Dense output (S3-D1 #7): stock IDAGetDky, the `k`-th derivative at
    /// `t` of the last accepted step's interpolating polynomial, for `t`
    /// within `[tn - h_used, tn]` (`stats()`'s `internal_time` and
    /// `last_step`) and `k` at most that step's order (`last_order`). An
    /// observation, never an `IDASolve` call: no step, history, option or
    /// status changes, and the `advance` buffers are untouched. Refused
    /// before the first accepted step of a segment, on a fail-stopped
    /// handle, outside the last step (stock IDA_BAD_T; stock alone would
    /// extrapolate past tn) and above its order (IDA_BAD_K).
    pub fn dense(&self, t: f64, k: usize, out: &mut [f64]) -> Result<()> {
        if self.failed {
            return Err("IDA handle is fail-stopped".into());
        }
        if !self.started {
            return Err("IDA dense output needs an accepted step of this segment".into());
        }
        if out.len() != self.context.n {
            return Err("IDA output dimension".into());
        }
        if !t.is_finite() {
            return Err(format!("IDA dense output time {t} must be finite"));
        }
        let order = c_int::try_from(k).map_err(|_| format!("IDA dense derivative {k}"))?;
        let code = unsafe { operating_ida_dky(self.handle.as_ptr(), t, order, out.as_mut_ptr()) };
        if code < 0 {
            return Err(format!(
                "stock IDAGetDky status {code} at {t} s, derivative {k} (outside the last accepted step [tn - h_used, tn] or above its order)"
            ));
        }
        Ok(())
    }
    /// [`Self::dense`] at `k` = 0 and 1: the state and its derivative at `t`.
    pub fn dense_output(&self, t: f64, y: &mut [f64], yp: &mut [f64]) -> Result<()> {
        self.buffers(y, yp)?;
        self.dense(t, 0, y)?;
        self.dense(t, 1, yp)
    }
    /// Copy stock's current local-error estimate and reciprocal error weights.
    /// These are diagnostics of its current history, not errors of the last
    /// requested-time interpolant. Reading them does not change that history,
    /// numerical settings or a failed solve's status. Returns current BDF order.
    pub fn error_diagnostics(&self, errors: &mut [f64], weights: &mut [f64]) -> Result<i32> {
        self.buffers(errors, weights)?;
        let mut order = 0;
        let status = unsafe {
            operating_ida_error_diagnostics(
                self.handle.as_ptr(),
                errors.as_mut_ptr(),
                weights.as_mut_ptr(),
                &mut order,
            )
        };
        if status < 0 {
            return Err(format!(
                "stock IDA error-diagnostic query failed ({status})"
            ));
        }
        Ok(order)
    }
    /// Reuse caller-owned scratch for diagnostics at a successfully returned
    /// solution. This does not expose IDA's state or clear a failed solve.
    /// Changing physical parameters, equations or dimensions requires a new
    /// handle/reinitialization; do not mutate them behind active solver history.
    pub fn system_mut(&mut self) -> &mut S {
        &mut self.context.system
    }
    /// Ask stock IDA to admit only nonnegative values at these physical stock
    /// indices. This does not floor inventories or restrict signed model trials.
    /// Internal energy has an EOS datum and must not be constrained by habit.
    pub fn constrain_nonnegative(&mut self, indices: &[usize]) -> Result<()> {
        if self.failed || indices.iter().any(|i| *i >= self.context.n) {
            return Err("invalid IDA nonnegative stock indices".into());
        }
        let mut flags = vec![0.; self.context.n];
        for i in indices {
            flags[*i] = 1.;
        }
        let code = unsafe {
            operating_ida_nonnegative(
                self.handle.as_ptr(),
                if indices.is_empty() {
                    std::ptr::null()
                } else {
                    flags.as_ptr()
                },
            )
        };
        let result = self.check(code);
        self.failed = result.is_err();
        result
    }
    /// MR-1 (owner, request 7 R7-P, 17 Oct): stock IDAS check points every
    /// `steps` steps, i.e. IDAAdjInit(steps, IDA_HERMITE) and IDASolveF in
    /// place of IDASolve. Each check point sets stock's own forceSetup, so
    /// the iteration matrix is set up again at least every `steps` steps
    /// although step size and order stay fixed (stock never does so at a
    /// constant cj); step, order and history are untouched and no backward
    /// pass is run. Check points are freed by stock IDAAdjReInit at every
    /// `reinitialize` and whenever more than `held` are held, so memory is
    /// the interpolation store, (steps + 1) x 2 vectors, plus at most `held`
    /// check points. Set once per handle, at any time; refused under plain
    /// IDA, which has no check points (no fallback: build with the
    /// `quadratures` feature, stock IDAS).
    pub fn rebuild_matrix_every(&mut self, steps: usize, held: usize) -> Result<()> {
        if !quadratures_linked() {
            return Err(
                "MR-1 needs stock IDAS check points: this build links plain IDA (build with the quadratures feature)"
                    .into(),
            );
        }
        let (Ok(n), Ok(h)) = (c_long::try_from(steps), c_long::try_from(held)) else {
            return Err("MR-1 interval or held bound out of range".into());
        };
        if n < 1 || h < 1 {
            return Err("MR-1 interval and held bound must be at least 1".into());
        }
        let code = unsafe { operating_ida_rebuild_every(self.handle.as_ptr(), n, h) };
        if code < 0 {
            return Err(format!(
                "stock IDAAdjInit refused MR-1 ({code}; set once per handle)"
            ));
        }
        Ok(())
    }
    /// MR-1's counts on this handle (all zero when it is off).
    #[allow(clippy::unnecessary_cast)] // C long varies by host ABI.
    pub fn rebuild(&self) -> Rebuild {
        let mut c = [0 as c_long; 4];
        unsafe { operating_ida_rebuild_counts(self.handle.as_ptr(), c.as_mut_ptr()) };
        Rebuild {
            steps: c[0] as i64,
            held: c[1] as i64,
            most_held: c[2] as i64,
            drops: c[3] as i64,
        }
    }
    #[allow(clippy::unnecessary_cast)] // C long varies by host ABI.
    pub fn stats(&self) -> Result<Stats> {
        let mut counts = [0 as c_long; 8];
        let mut orders = [0 as c_int; 2];
        let mut steps = [0.; 2];
        let status = unsafe {
            operating_ida_stats(
                self.handle.as_ptr(),
                counts.as_mut_ptr(),
                orders.as_mut_ptr(),
                steps.as_mut_ptr(),
            )
        };
        // Diagnostic counters remain inspectable after a model fail-stop.
        // Native query success is not solve success and must not clear fatal.
        if status < 0 {
            return Err(format!("stock IDA statistics query failed ({status})"));
        }
        let mut internal_time = 0.;
        let status =
            unsafe { operating_ida_current_time(self.handle.as_ptr(), &mut internal_time) };
        if status < 0 {
            return Err(format!("stock IDA time query failed ({status})"));
        }
        Ok(Stats {
            steps: counts[0] as i64,
            residuals: counts[1] as i64,
            jacobians: counts[2] as i64,
            nonlinear_iterations: counts[3] as i64,
            error_failures: counts[4] as i64,
            convergence_failures: counts[5] as i64,
            linear_setups: counts[6] as i64,
            root_evaluations: counts[7] as i64,
            last_order: orders[0],
            current_order: orders[1],
            last_step: steps[0],
            current_step: steps[1],
            internal_time,
        })
    }
}
impl<S: System> Drop for Ida<S> {
    fn drop(&mut self) {
        unsafe {
            operating_ida_free(self.handle.as_ptr());
        }
    }
}

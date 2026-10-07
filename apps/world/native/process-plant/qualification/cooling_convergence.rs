//! Stock Newton convergence AND the existing current-state network EOS chart.
//! This adds no integrator iteration logic, physical projection or LTE policy.
use super::{cooling_coordinates::EnergyCoordinates, ida_support::*};
use leitbild_plant_numerics::{operating_admission, operating_network, source_cooling};
use std::{
    ffi::c_int,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    time::Instant,
};

pub(super) const EPS_LIN: f64 = 0.05;
pub(super) const NONLINEAR_COEFFICIENT: f64 = 0.33;
pub(super) const LINEAR_L2_BUDGET: f64 = EPS_LIN * NONLINEAR_COEFFICIENT;
const CONTINUE: c_int = 901;
const RECOVERABLE: c_int = 902;

pub(super) struct Convergence<'a> {
    model: &'a source_cooling::Model,
    network: operating_network::Workspace,
    energy: EnergyCoordinates,
    state: Vec<f64>,
    slopes: Vec<f64>,
    ida: Handle,
    solver: Handle,
    stock: Option<StockConvergence>,
    pub fatal: Option<String>,
    calls: u64,
    checks: u64,
    refusals: u64,
    trial_failures: u64,
    property_requests: u64,
    seconds: f64,
    start: Instant,
    allowance: f64,
    last_primary: [f64; 2],
    last_secondary: [f64; 2],
}
impl<'a> Convergence<'a> {
    pub fn new(model: &'a source_cooling::Model) -> Result<Self, String> {
        let initial = model.initial_state()?;
        Ok(Self {
            model,
            network: operating_network::Workspace::new(&model.network),
            energy: EnergyCoordinates::new(model, &initial)?,
            state: vec![0.; model.dimension()],
            slopes: vec![0.; model.dimension()],
            ida: ptr::null_mut(),
            solver: ptr::null_mut(),
            stock: None,
            fatal: None,
            calls: 0,
            checks: 0,
            refusals: 0,
            trial_failures: 0,
            property_requests: 0,
            seconds: 0.,
            last_primary: [0.; 2],
            last_secondary: [0.; 2],
            start: Instant::now(),
            allowance: 120.,
        })
    }
    pub fn budget(&mut self, start: Instant, allowance: f64) {
        self.start = start;
        self.allowance = allowance;
    }
    pub(super) fn corrected_chart(
        &mut self,
        pred: &[f64],
        pred_yp: &[f64],
        correction: &[f64],
        cj: f64,
    ) -> Result<c_int, String> {
        corrected_candidate(
            pred,
            pred_yp,
            correction,
            cj,
            &mut self.state,
            &mut self.slopes,
        )?;
        self.chart()
    }
    /// The owner is a field of a stable Box<Callbacks> and outlives Resources.
    /// IDASetNonlinearSolver must precede this: it installs the original CTest.
    pub fn install(&mut self, ida: Handle, solver: Handle) -> Result<(), String> {
        if ida.is_null() || solver.is_null() || self.stock.is_some() {
            return Err("Invalid or repeated current-chart convergence installation".into());
        }
        let stock = stock_convergence(solver)?;
        if stock.data != ida {
            return Err("Stock Newton convergence belongs to a different IDA owner".into());
        }
        checked(
            unsafe {
                SUNNonlinSolSetConvTestFn(solver, convergence_test, (self as *mut Self).cast())
            },
            "Current-chart Newton CTest",
        )?;
        self.ida = ida;
        self.solver = solver;
        self.stock = Some(stock);
        Ok(())
    }
    // Called only on the actual corrected solver candidate. The base callback
    // workspace/P are never read or modified here. Trial EOS/domain failure is
    // recoverable, just as a failed residual trial; malformed vectors are fatal.
    fn chart(&mut self) -> Result<c_int, String> {
        // Only the network slice is consumed. G's inverse needs the energy
        // and release receipts, never the unrelated source L/D coordinate.
        self.energy.state_to_physical(&mut self.state);
        self.energy.vector_to_physical(&mut self.slopes);
        if self
            .state
            .iter()
            .chain(&self.slopes)
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite corrected physical Newton candidate".into());
        }
        let l = self.model.layout;
        let y = &self.state[l.network_start..l.products_start];
        let yp = &self.slopes[l.network_start..l.products_start];
        let prepared = self.network.evaluate(&self.model.network, y, yp, None);
        self.property_requests += self.network.property_requests as u64;
        if let Err(error) = prepared {
            if super::recoverable(&error) {
                self.trial_failures += 1;
                return Ok(RECOVERABLE);
            }
            return Err(error);
        }
        let charts = operating_admission::chart_corrections(&self.model.network, &self.network, y)?;
        self.checks += 1;
        self.property_requests += charts.property_requests as u64;
        self.last_primary = charts.primary;
        self.last_secondary = charts.secondary;
        if charts.check().is_err() {
            self.refusals += 1;
            // Stock Newton's own iteration limit handles stagnation. Do not
            // reset its rate/history or force success for a zero update.
            Ok(CONTINUE)
        } else {
            Ok(0)
        }
    }
    pub fn json(&self) -> String {
        format!(
            "{{\"scope\":\"stock-CTest-first;current-predictor-plus-correction;dedicated-network-EOS-workspace;algebraic-LTE-included\",\"calls\":{},\"chartChecks\":{},\"chartRefusals\":{},\"recoverableTrialPreparations\":{},\"extraPropertyRequests\":{},\"seconds\":{},\"lastPrimaryCorrection\":{:?},\"lastSecondaryCorrection\":{:?}}}",
            self.calls,
            self.checks,
            self.refusals,
            self.trial_failures,
            self.property_requests,
            self.seconds,
            self.last_primary,
            self.last_secondary
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stock_result_is_called_once_and_forwarded_without_chart_work() {
        struct Stock {
            status: c_int,
            calls: usize,
        }
        unsafe extern "C" fn original(
            _: Handle,
            _: Handle,
            _: Handle,
            _: f64,
            _: Handle,
            data: Handle,
        ) -> c_int {
            let s = unsafe { &mut *(data as *mut Stock) };
            s.calls += 1;
            s.status
        }
        let model = super::super::cooling_fixture::fixture();
        let mut c = Convergence::new(&model).unwrap();
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&vec![0.; model.dimension()]).unwrap();
        let mut stock = Stock {
            status: 0,
            calls: 0,
        };
        c.solver = y;
        c.stock = Some(StockConvergence {
            test: original,
            data: (&mut stock as *mut Stock).cast(),
        });
        for status in [CONTINUE, RECOVERABLE, -1, CONTINUE] {
            stock.status = status;
            assert_eq!(
                unsafe {
                    convergence_test(y, y, y, 1., y, (&mut c as *mut Convergence<'_>).cast())
                },
                status
            );
        }
        assert_eq!(stock.calls, 4);
        assert_eq!(c.checks, 0);
        assert_eq!(c.seconds >= 0., true);
        assert!(c.fatal.is_none());
    }
    fn solver_state(c: &Convergence<'_>, physical: &[f64]) -> Vec<f64> {
        let mut y = physical.to_vec();
        c.energy.state_to_solver(&mut y);
        y
    }
    #[test]
    fn corrected_candidate_not_stale_predictor_and_padding_do_not_change_chart() {
        let model = super::super::cooling_fixture::fixture();
        let mut c = Convergence::new(&model).unwrap();
        let initial = model.initial_state().unwrap();
        let mut physical = initial.clone();
        let p = model.layout.network_start + model.network.pressure_row();
        physical[p] += 20.;
        let predicted = solver_state(&c, &physical);
        let corrected = solver_state(&c, &initial);
        let delta = corrected
            .iter()
            .zip(&predicted)
            .map(|(a, b)| a - b)
            .collect::<Vec<_>>();
        let zero = vec![0.; predicted.len()];
        corrected_candidate(&predicted, &zero, &zero, 1., &mut c.state, &mut c.slopes).unwrap();
        assert_eq!(c.chart().unwrap(), CONTINUE);
        // Repeated zero updates cannot force success or reset stock history.
        corrected_candidate(&predicted, &zero, &zero, 1., &mut c.state, &mut c.slopes).unwrap();
        assert_eq!(c.chart().unwrap(), CONTINUE);
        corrected_candidate(&predicted, &zero, &delta, 1., &mut c.state, &mut c.slopes).unwrap();
        assert_eq!(c.chart().unwrap(), 0);
        // Inert solver coordinates must not dilute this pointwise condition.
        for padding in [0, 10_000] {
            let mut pred = predicted.clone();
            pred.resize(pred.len() + padding, 0.);
            let mut correction = delta.clone();
            correction.resize(pred.len(), 0.);
            let mut y = vec![0.; pred.len()];
            let mut yp = y.clone();
            corrected_candidate(
                &pred,
                &vec![0.; pred.len()],
                &correction,
                3.,
                &mut y,
                &mut yp,
            )
            .unwrap();
            c.state.copy_from_slice(&y[..model.dimension()]);
            c.slopes.copy_from_slice(&yp[..model.dimension()]);
            assert_eq!(c.chart().unwrap(), 0);
        }
        assert_eq!(LINEAR_L2_BUDGET, 0.0165);
        assert!(c.checks >= 5);
    }
    #[test]
    fn finite_lifecycle_and_trial_domain_fail_closed() {
        let model = super::super::cooling_fixture::fixture();
        let mut c = Convergence::new(&model).unwrap();
        assert!(c.install(ptr::null_mut(), ptr::null_mut()).is_err());
        let physical = model.initial_state().unwrap();
        c.state = solver_state(&c, &physical);
        c.slopes.fill(0.);
        assert_eq!(c.chart().unwrap(), 0);
        c.state = solver_state(&c, &physical);
        c.state[model.layout.network_start + model.network.temperature_row(0)] = -1.;
        assert_eq!(c.chart().unwrap(), RECOVERABLE);
        c.state = solver_state(&c, &physical);
        c.slopes.fill(0.);
        assert_eq!(c.chart().unwrap(), 0);
        c.state[0] = f64::NAN;
        assert!(c.chart().is_err());
        for cj in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(corrected_candidate(&[0.], &[0.], &[0.], cj, &mut [0.], &mut [0.]).is_err());
        }
        assert!(corrected_candidate(&[0.], &[0.], &[f64::NAN], 1., &mut [0.], &mut [0.]).is_err());
        assert!(corrected_candidate(&[0.], &[], &[0.], 1., &mut [0.], &mut [0.]).is_err());
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&physical).unwrap();
        let delta = resources.vector(&vec![0.; physical.len()]).unwrap();
        let weights = resources.vector(&vec![1.; physical.len()]).unwrap();
        assert_eq!(
            unsafe {
                convergence_test(
                    ptr::null_mut(),
                    y,
                    delta,
                    1.,
                    weights,
                    (&mut c as *mut Convergence<'_>).cast(),
                )
            },
            -1
        );
        assert!(c.fatal.is_some());
        assert_eq!(
            unsafe {
                convergence_test(
                    ptr::null_mut(),
                    y,
                    delta,
                    1.,
                    weights,
                    (&mut c as *mut Convergence<'_>).cast(),
                )
            },
            -1
        );
        assert_eq!(
            unsafe { convergence_test(ptr::null_mut(), y, delta, 1., weights, ptr::null_mut()) },
            -1
        );
    }
    #[test]
    fn public_newton_accessor_and_external_owner_lifecycle() {
        unsafe extern "C" fn residual(
            _: f64,
            _: Handle,
            yp: Handle,
            r: Handle,
            _: Handle,
        ) -> c_int {
            unsafe {
                *N_VGetArrayPointer_Serial(r) = *N_VGetArrayPointer_Serial(yp);
            }
            0
        }
        assert!(stock_convergence(ptr::null_mut()).is_err());
        let mut owned = Resources::new().unwrap();
        let y = owned.vector(&[0.]).unwrap();
        let yp = owned.vector(&[0.]).unwrap();
        owned.ida = unsafe { IDACreate(owned.context) };
        checked(
            unsafe { IDAInit(owned.ida, residual, 0., y, yp) },
            "test IDA init",
        )
        .unwrap();
        let nls = owned.newton(y).unwrap();
        assert!(stock_convergence(nls).is_err()); // not yet attached to IDA
        checked(
            unsafe { IDASetNonlinearSolver(owned.ida, nls) },
            "test attach Newton",
        )
        .unwrap();
        let original = stock_convergence(nls).unwrap();
        assert_eq!(original.data, owned.ida);
        let model = super::super::cooling_fixture::fixture();
        let mut guard = Box::new(Convergence::new(&model).unwrap());
        assert!(guard.install(y, nls).is_err()); // a different IDA owner
        guard.install(owned.ida, nls).unwrap();
        assert!(guard.install(owned.ida, nls).is_err());
        assert!(owned.newton(y).is_err());
        checked(
            unsafe { IDASetNonlinConvCoef(owned.ida, NONLINEAR_COEFFICIENT) },
            "explicit nonlinear coefficient",
        )
        .unwrap();
        // Drop tests the external Newton ownership, without advancing a step.
        drop(owned);
    }
}

fn corrected_candidate(
    pred: &[f64],
    pred_yp: &[f64],
    correction: &[f64],
    cj: f64,
    y: &mut [f64],
    yp: &mut [f64],
) -> Result<(), String> {
    if !cj.is_finite()
        || cj <= 0.
        || [pred_yp.len(), correction.len(), y.len(), yp.len()]
            .iter()
            .any(|&n| n != pred.len())
    {
        return Err("Invalid current Newton predictor/correction shape or cj".into());
    }
    for i in 0..y.len() {
        y[i] = pred[i] + correction[i];
        yp[i] = pred_yp[i] + cj * correction[i];
        if !pred[i].is_finite()
            || !pred_yp[i].is_finite()
            || !correction[i].is_finite()
            || !y[i].is_finite()
            || !yp[i].is_finite()
        {
            return Err("Nonfinite current Newton predictor/correction".into());
        }
    }
    Ok(())
}
unsafe extern "C" fn convergence_test(
    nls: Handle,
    correction: Handle,
    delta: Handle,
    tolerance: f64,
    weights: Handle,
    user: Handle,
) -> c_int {
    if user.is_null() {
        return -1;
    }
    let c = unsafe { &mut *(user as *mut Convergence<'_>) };
    let start = Instant::now();
    c.calls += 1;
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<c_int, String> {
        if c.fatal.is_some() {
            return Err("Sticky fatal current-chart convergence failure".into());
        }
        if c.start.elapsed().as_secs_f64() > c.allowance {
            return Err("Aggregate coupled pair wall allowance exhausted".into());
        }
        let stock = c
            .stock
            .ok_or("Uninstalled current-chart convergence callback")?;
        if nls.is_null()
            || nls != c.solver
            || correction.is_null()
            || delta.is_null()
            || weights.is_null()
            || !tolerance.is_finite()
            || tolerance <= 0.
        {
            return Err("Invalid current-chart Newton callback arguments".into());
        }
        for vector in [correction, delta, weights] {
            if unsafe { N_VGetLength_Serial(vector) } != c.state.len() as i64 {
                return Err("Wrong current-chart Newton callback vector length".into());
            }
        }
        // Exactly once, preserving IDA's mutable convergence-rate history.
        let status =
            unsafe { (stock.test)(nls, correction, delta, tolerance, weights, stock.data) };
        if status != 0 {
            return Ok(status);
        }
        let (mut time, mut cj) = (0., 0.);
        let (mut pred, mut pred_yp, mut old_y, mut old_yp, mut old_res, mut data) = (
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        checked(
            unsafe {
                IDAGetNonlinearSystemData(
                    c.ida,
                    &mut time,
                    &mut pred,
                    &mut pred_yp,
                    &mut old_y,
                    &mut old_yp,
                    &mut old_res,
                    &mut cj,
                    &mut data,
                )
            },
            "Current public IDA nonlinear system data",
        )?;
        if !time.is_finite() {
            return Err("Nonfinite current Newton time".into());
        }
        let n = c.state.len();
        let status = c.corrected_chart(
            unsafe { super::values(pred, n) }?,
            unsafe { super::values(pred_yp, n) }?,
            unsafe { super::values(correction, n) }?,
            cj,
        )?;
        if c.start.elapsed().as_secs_f64() > c.allowance {
            return Err("Aggregate coupled pair wall allowance exhausted".into());
        }
        Ok(status)
    }));
    c.seconds += start.elapsed().as_secs_f64();
    match result {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            c.fatal = Some(error);
            -1
        }
        Err(_) => {
            c.fatal = Some("Panic in current-chart Newton convergence callback".into());
            -1
        }
    }
}

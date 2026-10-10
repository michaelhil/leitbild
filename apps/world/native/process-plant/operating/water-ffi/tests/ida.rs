#![cfg(feature = "ida")]
use leitbild_operating_water::ida::{Failure, Ida, Initial, System};
struct Decay {
    panic: bool,
    fatal: bool,
}
impl System for Decay {
    fn dimension(&self) -> usize {
        2
    }
    fn nonzeros(&self) -> usize {
        3
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        assert!(!self.panic, "deliberate boundary panic");
        if self.fatal {
            return Err(Failure::Fatal("deliberate ownership failure".into()));
        }
        out[0] = yp[0] + y[0];
        out[1] = y[1] - 2. * y[0];
        Ok(())
    }
    fn jacobian(
        &mut self,
        _: f64,
        cj: f64,
        _: &[f64],
        _: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        data.copy_from_slice(&[cj + 1., -2., 1.]);
        rows.copy_from_slice(&[0, 1, 1]);
        pointers.copy_from_slice(&[0, 2, 3]);
        Ok(())
    }
}
fn new(system: Decay, y: &[f64], yp: &[f64]) -> Ida<Decay> {
    Ida::new(
        system,
        Initial {
            time: 0.,
            y,
            yp,
            differential: &[1., 0.],
            absolute_tolerance: &[1e-10; 2],
            relative_tolerance: 1e-8,
        },
    )
    .unwrap()
}
#[test]
fn stock_ida_initializes_and_advances_an_index_one_system_without_resetting_stock() {
    let mut y = [1., 0.];
    let mut yp = [0.; 2];
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    assert!(ida.constrain_nonnegative(&[2]).is_err());
    ida.constrain_nonnegative(&[0]).unwrap();
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    assert_eq!(y[0], 1.);
    assert!((y[1] - 2.).abs() < 1e-9 && (yp[0] + 1.).abs() < 1e-9);
    ida.stop_at(2.).unwrap();
    for target in [0.13, 0.27, 1., 2.] {
        assert_eq!(ida.advance(target, &mut y, &mut yp).unwrap(), target);
        assert!((y[0] - (-target).exp()).abs() < 2e-8);
        assert!((y[1] - 2. * y[0]).abs() < 1e-8);
    }
    let stats = ida.stats().unwrap();
    assert!(stats.steps > 0 && stats.jacobians > 0);
    assert_eq!(stats.internal_time, 2.);
    assert!(
        ida.advance(3., &mut [0.; 1], &mut yp)
            .unwrap_err()
            .contains("dimension")
    );
}
#[test]
fn callback_panics_and_fatal_errors_never_become_successful_generations() {
    for (panic, fatal) in [(true, false), (false, true)] {
        let mut y = [1., 2.];
        let mut yp = [-1., -2.];
        let mut ida = new(Decay { panic, fatal }, &y, &yp);
        let error = ida.advance(0.1, &mut y, &mut yp).unwrap_err();
        assert!(
            error.contains(if panic {
                "panic caught"
            } else {
                "ownership failure"
            }),
            "{error}"
        );
        assert_eq!(y, [1., 2.]);
        assert!(
            ida.stats().is_ok(),
            "failure diagnostics must remain readable"
        );
        assert!(
            ida.advance(0.2, &mut y, &mut yp)
                .unwrap_err()
                .contains("fail-stopped")
        );
    }
}

#[test]
fn current_snapshot_reads_internal_endpoint_without_changing_interpolant_or_history() {
    let mut y = [1., 2.];
    let mut yp = [-1., -2.];
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    let requested = ida.advance(0.137, &mut y, &mut yp).unwrap();
    let output = (y, yp);
    let before = ida.stats().unwrap();
    assert!(
        before.internal_time > requested,
        "test must exercise a genuine interpolated output"
    );
    let mut internal_y = [0.; 2];
    let mut internal_yp = [0.; 2];
    let time = ida
        .current_state(&mut internal_y, &mut internal_yp)
        .unwrap();
    let mut errors = [0.; 2];
    let mut weights = [0.; 2];
    let order = ida.error_diagnostics(&mut errors, &mut weights).unwrap();
    assert!((1..=5).contains(&order));
    assert!(errors.iter().all(|v| v.is_finite()));
    assert!(weights.iter().all(|v| v.is_finite() && *v > 0.));
    let first = (errors, weights);
    assert_eq!(
        ida.error_diagnostics(&mut errors, &mut weights).unwrap(),
        order
    );
    assert_eq!((errors, weights), first);
    assert!(ida.error_diagnostics(&mut [0.; 1], &mut weights).is_err());
    assert_eq!(time, before.internal_time);
    // This later tn accumulates ~2.7e-8 global error under unchanged 1e-8
    // local error control. Snapshot semantics are checked independently below
    // against stock's ordinary output at exactly this internal endpoint.
    assert!((internal_y[0] - (-time).exp()).abs() < 4e-8);
    assert!((internal_y[1] - 2. * internal_y[0]).abs() < 1e-8);
    assert!((internal_yp[0] + internal_y[0]).abs() < 2e-7);
    assert_ne!(internal_y[0], output.0[0]);
    assert_eq!((y, yp), output);
    let after = ida.stats().unwrap();
    assert_eq!(after.steps, before.steps);
    assert_eq!(after.residuals, before.residuals);
    assert_eq!(after.jacobians, before.jacobians);
    assert_eq!(after.internal_time, before.internal_time);
    assert!(ida.current_state(&mut [0.; 1], &mut internal_yp).is_err());
    ida.advance(time, &mut y, &mut yp).unwrap();
    for j in 0..2 {
        assert!((internal_y[j] - y[j]).abs() <= 8. * f64::EPSILON * y[j].abs());
        assert!((internal_yp[j] - yp[j]).abs() <= 8. * f64::EPSILON * yp[j].abs());
    }
    assert_eq!(ida.stats().unwrap().steps, before.steps);
    ida.advance(0.27, &mut y, &mut yp).unwrap();
    // Identical control trajectory without the snapshot: local error control
    // is not a guarantee of a guessed absolute global error at every tn.
    let mut control_y = [1., 2.];
    let mut control_yp = [-1., -2.];
    let mut control = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &control_y,
        &control_yp,
    );
    control
        .initialize(0.1, &mut control_y, &mut control_yp)
        .unwrap();
    for target in [0.137, time, 0.27] {
        control
            .advance(target, &mut control_y, &mut control_yp)
            .unwrap();
    }
    assert_eq!(y, control_y);
    assert_eq!(yp, control_yp);
    let actual = ida.stats().unwrap();
    let expected = control.stats().unwrap();
    assert_eq!(actual.steps, expected.steps);
    assert_eq!(actual.residuals, expected.residuals);
    assert_eq!(actual.jacobians, expected.jacobians);
    assert_eq!(actual.internal_time, expected.internal_time);
}

#[test]
fn stock_constraints_reject_negative_inventory_without_rewriting_it() {
    let mut y = [-1., -2.];
    let mut yp = [1., 2.];
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    ida.constrain_nonnegative(&[0]).unwrap();
    assert!(ida.initialize(0.1, &mut y, &mut yp).is_err());
    assert_eq!(y, [-1., -2.]);
    assert_eq!(yp, [1., 2.]);
    assert!(
        ida.advance(0.1, &mut y, &mut yp)
            .unwrap_err()
            .contains("fail-stopped")
    );

    // No implicit positivity rule: clearing the explicit stock constraint
    // restores the mathematical signed test problem, not an inventory floor.
    let mut ida = new(
        Decay {
            panic: false,
            fatal: false,
        },
        &y,
        &yp,
    );
    ida.constrain_nonnegative(&[0]).unwrap();
    ida.constrain_nonnegative(&[]).unwrap();
    ida.initialize(0.1, &mut y, &mut yp).unwrap();
    assert_eq!(y[0], -1.);
}

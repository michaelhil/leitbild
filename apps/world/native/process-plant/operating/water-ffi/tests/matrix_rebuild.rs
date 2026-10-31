//! MR-1 (owner, request 7 R7-P, 17 Oct): the joined solve's forced
//! iteration-matrix rebuild through stock IDAS check points
//! (`Ida::rebuild_matrix_every`). At a fixed step and order, cj stays
//! constant and stock IDA never sets its iteration matrix up again
//! (ida.c/idas.c IDANls); IDAS's IDASolveF sets stock's forceSetup at
//! every check point. These tests guard that behaviour across SUNDIALS
//! upgrades, bound its memory and show it leaves the trajectory alone.
//!
//! The system is the index-1 decay of `tests/ida.rs`: y0' = -y0, y1 = 2 y0,
//! integrated at a 1 ms maximum step (rtol 1e-6), BDF order at most 2, so that after
//! the start the step and order are fixed.
#![cfg(feature = "ida")]
use leitbild_operating_water::ida::{Advance, Failure, Ida, Initial, System};

struct Decay;
impl System for Decay {
    /// Unreduced: every coordinate stands for itself (E-NUC).
    fn multiplicities(&self) -> Option<Vec<f64>> {
        None
    }
    fn dimension(&self) -> usize {
        2
    }
    fn nonzeros(&self) -> usize {
        3
    }
    fn root_count(&self) -> usize {
        0
    }
    fn roots(&mut self, _: f64, _: &[f64], _: &[f64], _: &mut [f64]) -> Result<(), Failure> {
        Ok(())
    }
    fn residual(&mut self, _: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
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

const MAX_STEP_S: f64 = 0.001;
/// Steps taken before the window: the start's growth to the cap is over.
const SETTLE_STEPS: usize = 400;
/// The fixed-step window the counts are judged on.
const WINDOW_STEPS: usize = 2000;

fn handle() -> Ida<Decay> {
    let (y, yp) = ([1., 2.], [-1., -2.]);
    let mut ida = Ida::new(
        Decay,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &[1., 0.],
            absolute_tolerance: &[1e-8; 2],
            relative_tolerance: 1e-6,
        },
    )
    .unwrap();
    ida.set_max_step(MAX_STEP_S).unwrap();
    ida.set_max_order(2).unwrap();
    ida
}

/// One accepted step per call; returns every accepted state, bit for bit.
fn steps(ida: &mut Ida<Decay>, n: usize, y: &mut [f64; 2], yp: &mut [f64; 2]) -> Vec<[u64; 5]> {
    (0..n)
        .map(|_| match ida.step(1e9, y, yp).unwrap() {
            Advance::Reached(t) => [
                t.to_bits(),
                y[0].to_bits(),
                y[1].to_bits(),
                yp[0].to_bits(),
                yp[1].to_bits(),
            ],
            Advance::Root { .. } => panic!("no roots declared"),
        })
        .collect()
}

/// Setups and steps over the fixed-step window, after the start.
fn window(rebuild: Option<usize>) -> (i64, i64, f64, i32) {
    let mut ida = handle();
    if let Some(n) = rebuild {
        ida.rebuild_matrix_every(n, 4).unwrap();
    }
    let (mut y, mut yp) = ([1., 2.], [-1., -2.]);
    steps(&mut ida, SETTLE_STEPS, &mut y, &mut yp);
    let before = ida.stats().unwrap();
    steps(&mut ida, WINDOW_STEPS, &mut y, &mut yp);
    let after = ida.stats().unwrap();
    (
        after.linear_setups - before.linear_setups,
        after.steps - before.steps,
        after.last_step,
        after.last_order,
    )
}

#[cfg(feature = "quadratures")]
#[test]
fn the_forced_rebuild_sets_the_matrix_up_every_25_steps_where_stock_never_does() {
    // Stock, fixed step and order: cj is constant, so no setup at all.
    let (stock_setups, stock_steps, h, q) = window(None);
    assert!(
        (h - MAX_STEP_S).abs() < 1e-12 && q == 2,
        "the window is not at a fixed step and order: h {h}, q {q}"
    );
    assert_eq!(stock_steps, WINDOW_STEPS as i64);
    assert!(
        stock_setups <= 1,
        "stock set the matrix up {stock_setups} times at a constant cj: the guard no longer discriminates"
    );
    // MR-1: at least one setup per 25 steps (a SUNDIALS upgrade that drops
    // IDASolveF's forceSetup fails here).
    let (setups, n, h, q) = window(Some(25));
    assert!(
        (h - MAX_STEP_S).abs() < 1e-12 && q == 2 && n == WINDOW_STEPS as i64,
        "h {h}, q {q}, n {n}"
    );
    eprintln!("fixed-step window of {n} steps: stock {stock_setups} setups, MR-1 {setups}");
    assert!(
        setups >= n / 25,
        "MR-1 set the matrix up {setups} times in {n} fixed steps, fewer than one per 25"
    );
}

#[cfg(feature = "quadratures")]
#[test]
fn check_points_stay_bounded_and_a_restart_frees_them() {
    let mut ida = handle();
    ida.rebuild_matrix_every(25, 4).unwrap();
    let (mut y, mut yp) = ([1., 2.], [-1., -2.]);
    steps(&mut ida, SETTLE_STEPS + WINDOW_STEPS, &mut y, &mut yp);
    let r = ida.rebuild();
    assert_eq!(r.steps, 25);
    // 2,400 steps = 96 check points; never more than the bound + 1 held.
    assert!(r.most_held <= 5, "{r:?}");
    assert!(r.drops >= 15, "{r:?}");
    let t = ida.stats().unwrap().internal_time;
    ida.reinitialize(t, &y, &yp).unwrap();
    assert_eq!(ida.rebuild().held, 0, "a restart frees every check point");
    // The interval survives the restart.
    steps(&mut ida, 60, &mut y, &mut yp);
    assert_eq!(ida.rebuild().steps, 25);
    assert!(
        ida.rebuild_matrix_every(25, 4).is_err(),
        "set once per handle"
    );
}

#[cfg(feature = "quadratures")]
#[test]
fn check_points_without_a_forced_setup_leave_the_trajectory_bit_for_bit() {
    // An interval beyond the run: IDASolveF and its check points, never a
    // forced setup. Every accepted state equals stock IDASolve's.
    let run = |rebuild: bool| {
        let mut ida = handle();
        if rebuild {
            ida.rebuild_matrix_every(10_000, 4).unwrap();
        }
        let (mut y, mut yp) = ([1., 2.], [-1., -2.]);
        let states = steps(&mut ida, 3000, &mut y, &mut yp);
        let s = ida.stats().unwrap();
        (states, s.linear_setups, s.residuals, s.nonlinear_iterations)
    };
    assert_eq!(run(true), run(false));
}

#[cfg(not(feature = "quadratures"))]
#[test]
fn plain_ida_refuses_the_forced_rebuild_by_name() {
    let mut ida = handle();
    let e = ida.rebuild_matrix_every(25, 4).unwrap_err();
    assert!(e.contains("MR-1 needs stock IDAS"), "{e}");
}

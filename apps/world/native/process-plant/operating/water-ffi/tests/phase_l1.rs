//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#l1-unilateral-absent-donor-law-implemented-at-s3
//! PHASE-L1: the PHASE spike's relief case on the S1 network with the
//! network's own L1 active (`network::unilateral`, `network::phase_events`).
//! NOT EVIDENCE and not a gate: a bounded measurement for the lead
//! (S3-D-P2) of conservation across L1's lock and release transactions,
//! root counts by kind and cost.
//!
//! The S1 network (G6's relief hook, G6's prototype packet) settles with its
//! RCPs started from rest; then its PZR relief is held at full lift (C4's
//! stuck-open initiator). L1 is declared active at t = 0: every phase path
//! is locked or free by decision 0014's law, with its release or contact
//! root. Cell phase modes are the spike's test-local realization (design
//! §2, mode E: totals differential, `p, M_g, U_g` algebraic; PHASE-P7 owns
//! the production modes): a birth root per liquid cell, an exhaustion and a
//! dryout root per equilibrium cell. The modes declare phase presence to
//! L1; every located instant runs the mode transaction, then L1's, then the
//! existing exact consistent start and a new stock IDA handle with the
//! declared 1e-4 s first step. A stop at a crossing against every declared
//! direction (no `IDASetRootDirection` yet) continues the same handle with
//! no transaction. The run ends at its time cap, at the first vapor
//! arrival into a liquid-only cell (the declared C4 end, design §7), or at
//! a dryout (mode G, S6) after its transaction. Parameters come from the
//! packet and the wiki's strict blocks only. It needs a water build with
//! the saturation-seam adapter (PHASE abdd1991).
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        self, ConsistentSystem, Coupling, Fluid, Network, PZR_MASS, PZR_TRACER, Properties,
        Receipts, RotorState, SparseJacobian, ToleranceClasses, consistent_start,
        packet::Packet,
        phase_events::{Ledger, Root, located, release_roots},
        prepare::{self, OperatingPoint, Settings},
        stratified,
        unilateral::{Cause, Lock, Presence, Transaction},
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse,
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, KluOrdering, System},
};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
/// CLOCK_THREAD_CPUTIME_ID on macOS.
const THREAD_CPU_CLOCK: i32 = 16;
fn cpu_s() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(THREAD_CPU_CLOCK, &mut t) };
    assert_eq!(status, 0, "thread CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}
fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// The single JSON object inside one fenced strict block of a wiki page.
fn strict_block(page: &str, fence: &str) -> Value {
    let text = std::fs::read_to_string(page).unwrap_or_else(|e| panic!("{page}: {e}"));
    let open = format!("```{fence}\n");
    let start = text
        .find(&open)
        .unwrap_or_else(|| panic!("{page} has no ```{fence} block"))
        + open.len();
    let end = start
        + text[start..]
            .find("\n```")
            .expect("unterminated strict block");
    serde_json::from_str(&text[start..end]).unwrap_or_else(|e| panic!("{fence}: {e}"))
}

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> network::Failure {
    network::Failure::Fatal(reason.into())
}
fn ida_failure(f: network::Failure) -> Failure {
    match f {
        network::Failure::Recoverable(r) => Failure::Recoverable(r),
        network::Failure::Fatal(r) => Failure::Fatal(r),
    }
}

/// A regular cell's phase mode (the spike's, design §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Liquid,
    /// Both bounds active: slot `M_l` holds `M`, slot `U_l` holds `U`.
    Equilibrium,
    /// Liquid exhausted at a dryout: declared at the instant, viewed as its
    /// equilibrium state there, never integrated (mode G, S6).
    Dry,
}

/// C4's stuck-open relief through G6's boundary hook.
struct Relief {
    lift: f64,
    back_pressure_pa: f64,
}
impl Coupling for Relief {
    fn couple(&mut self, _: &Fluid<'_>, _: &mut Receipts<'_>) -> Result<(), network::Failure> {
        Ok(())
    }
    fn pzr_boundary(
        &mut self,
        _: &stratified::Cell,
        _: &stratified::Column,
    ) -> Result<stratified::Boundary, network::Failure> {
        Ok(stratified::Boundary {
            relief: Some(stratified::ReliefState {
                lift: s(self.lift),
                back_pressure_pa: Some(s(self.back_pressure_pa)),
            }),
            ..stratified::Boundary::closed()
        })
    }
}

/// Every declared root function: the modes' and L1's.
#[derive(Clone, Copy, Debug, PartialEq)]
enum RootKind {
    Birth(usize),
    Exhaustion(usize),
    Dryout(usize),
    L1(Root),
}
impl RootKind {
    fn direction(self) -> i32 {
        match self {
            Self::Birth(_) => 1,
            Self::Exhaustion(_) | Self::Dryout(_) => -1,
            Self::L1(r) => r.direction(),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Birth(_) => "birth",
            Self::Exhaustion(_) => "exhaustion",
            Self::Dryout(_) => "dryout",
            Self::L1(Root::Release(_)) => "l1_release",
            Self::L1(Root::Contact(_)) => "l1_contact",
        }
    }
}

/// Crossings to act on, how they were found, and whether root-located.
type Pending = (Vec<(RootKind, i32)>, &'static str, bool);

#[derive(Clone, Copy, Debug, Default)]
struct Cost {
    residuals: usize,
    residual_s: f64,
    jacobians: usize,
    jacobian_s: f64,
    root_calls: usize,
    root_s: f64,
}

struct Case {
    net: Network<If97>,
    relief: Relief,
    modes: Vec<Mode>,
    structure: SparseJacobian,
    csc: (Vec<i64>, Vec<i64>),
    roots: Vec<RootKind>,
    l1_roots: Vec<Root>,
    cost: Cost,
}

impl Case {
    fn slots(&self, c: usize) -> [usize; 6] {
        let l = self.net.cell_layout[c];
        [
            l.base,
            l.mass[0],
            l.energy[0],
            l.mass[1],
            l.energy[1],
            l.boron,
        ]
    }
    fn value(&self, y: &[f64], seed: Option<&[f64]>, i: usize) -> Scalar {
        let sc = self.net.scales()[i];
        Scalar::new(y[i] * sc, seed.map_or(0., |d| d[i]) * sc)
    }
    /// Saturation endpoints `(rho_f, u_f, rho_g, u_g)` at `p`.
    fn saturation(&self, p: Scalar) -> Result<[Scalar; 4], network::Failure> {
        let sat = self
            .net
            .properties()
            .saturation_caloric(p)
            .map_err(network::Failure::Recoverable)?;
        let (rf, rg) = (sat.liquid.density, sat.vapor.density);
        Ok([
            rf,
            sat.liquid.enthalpy - p / rf,
            rg,
            sat.vapor.enthalpy - p / rg,
        ])
    }
    /// The network's view of the coordinates: an equilibrium cell's slots
    /// hold its totals, so the network reads its saturated phases.
    #[allow(clippy::type_complexity)]
    fn view(
        &self,
        y: &[f64],
        seed: Option<&[f64]>,
    ) -> Result<(Vec<f64>, Option<Vec<f64>>), network::Failure> {
        let mut ym = y.to_vec();
        let mut sm = seed.map(|d| d.to_vec());
        let sc = self.net.scales();
        for c in 0..self.modes.len() {
            if self.modes[c] == Mode::Liquid {
                continue;
            }
            let [b, m0, e0, m1, e1, _] = self.slots(c);
            let p = self.value(y, seed, b);
            let total = self.value(y, seed, m0);
            let mg = self.value(y, seed, m1);
            let [_, uf, _, ug] = self.saturation(p)?;
            let ml = total - mg;
            let ul = ml * uf;
            let ugas = mg * ug;
            ym[m0] = ml.value / sc[m0];
            ym[e0] = ul.value / sc[e0];
            ym[e1] = ugas.value / sc[e1];
            if let Some(d) = sm.as_mut() {
                d[m0] = ml.direction / sc[m0];
                d[e0] = ul.direction / sc[e0];
                d[e1] = ugas.direction / sc[e1];
            }
        }
        Ok((ym, sm))
    }
    /// All rows: the network's (L1's locked rows included), then the
    /// equilibrium cells' own rows.
    fn rows(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<Vec<Scalar>, network::Failure> {
        let (ym, sm) = self.view(y, seed)?;
        self.net
            .evaluate_coupled(t, &ym, yp, sm.as_deref(), cj, None, Some(&mut self.relief))?;
        let mut rows = self.net.rows().to_vec();
        let sc = self.net.scales().to_vec();
        let rate = |i: usize, d: Option<&[f64]>| -> Scalar {
            Scalar::new(yp[i] * sc[i], d.map_or(0., |d| d[i]) * cj * sc[i])
        };
        for c in 0..self.modes.len() {
            if self.modes[c] != Mode::Equilibrium {
                continue;
            }
            let [b, m0, e0, m1, e1, _] = self.slots(c);
            let received = |i: usize, row: Scalar| rate(i, sm.as_deref()) - row * s(sc[i]);
            let rl = received(m0, rows[m0]);
            let rg = received(m1, rows[m1]);
            let el = received(e0, rows[e0]);
            let eg = received(e1, rows[e1]);
            let p = self.value(y, seed, b);
            let total_m = self.value(y, seed, m0);
            let total_u = self.value(y, seed, e0);
            let mg = self.value(y, seed, m1);
            let ug_slot = self.value(y, seed, e1);
            let [rf, uf, rgas, ug] = self.saturation(p)?;
            let v = s(self.net.volume(c));
            rows[b] = ((total_m - mg) / rf + mg / rgas - v) / v;
            rows[m0] = (rate(m0, seed) - rl - rg) / s(sc[m0]);
            rows[e0] = (rate(e0, seed) - el - eg) / s(sc[e0]);
            rows[m1] = (total_u - (total_m - mg) * uf - mg * ug) / s(sc[e0]);
            rows[e1] = (ug_slot - mg * ug) / s(sc[e1]);
        }
        Ok(rows)
    }
    /// The colored stage Jacobian on the network's structural pattern
    /// through the equilibrium cells' view.
    fn assemble(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), network::Failure> {
        self.rows(t, y, yp, None, 0.)?;
        let (ym, _) = self.view(y, None)?;
        let signs = self.net.column_signs(&ym);
        let mut seed = vec![0.; y.len()];
        values.fill(0.);
        for color in 0..self.structure.coloring.count() {
            self.structure
                .coloring
                .seed_into(color, &signs, &mut seed)
                .map_err(fatal)?;
            let rows = self.rows(t, y, yp, Some(&seed), cj)?;
            let directions: Vec<f64> = rows.iter().map(|r| r.direction).collect();
            sparse::scatter(
                &self.structure.pattern,
                &self.structure.coloring,
                color,
                &directions,
                &signs,
                values,
            )
            .map_err(fatal)?;
        }
        Ok(())
    }
    fn dense(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<Vec<f64>, network::Failure> {
        let n = y.len();
        let mut values = vec![0.; self.structure.pattern.nonzeros()];
        self.assemble(t, cj, y, yp, &mut values)?;
        let mut dense = vec![0.; n * n];
        let p = self.structure.pattern.pointers();
        let r = self.structure.pattern.indices();
        for col in 0..n {
            for k in p[col]..p[col + 1] {
                dense[col * n + r[k]] = values[k];
            }
        }
        Ok(dense)
    }
    /// Physical liquid departure `T_l - Tsat(p)` of a liquid-mode cell.
    fn departure(&self, c: usize, y: &[f64]) -> Result<f64, String> {
        let sc = self.net.scales();
        let [b, m0, e0, ..] = self.slots(c);
        let p = y[b] * sc[b];
        let u = y[e0] * sc[e0] / (y[m0] * sc[m0]);
        let props = self.net.properties();
        let point = props.caloric(false, p, u, false)?;
        let t = props.values(&point).temperature_k;
        let sat = props.saturation_caloric(s(p))?;
        Ok(t - sat.temperature.value)
    }
    /// The declared root functions of the current modes and L1 locks.
    fn declare_roots(&mut self) {
        let mut roots = Vec::new();
        for (c, m) in self.modes.iter().enumerate() {
            match m {
                Mode::Liquid => roots.push(RootKind::Birth(c)),
                Mode::Equilibrium => {
                    roots.push(RootKind::Exhaustion(c));
                    roots.push(RootKind::Dryout(c));
                }
                Mode::Dry => {}
            }
        }
        self.l1_roots = self.net.unilateral_roots();
        roots.extend(self.l1_roots.iter().map(|r| RootKind::L1(*r)));
        self.roots = roots;
    }
    /// The differential identity: the network's (L1's locked paths
    /// algebraic), then the equilibrium cells' flash coordinates.
    fn ids(&self, prepared: &[f64]) -> Vec<f64> {
        let mut ids = self.net.differential(prepared);
        for c in 0..self.modes.len() {
            if self.modes[c] == Mode::Equilibrium {
                let [_, _, _, m1, e1, _] = self.slots(c);
                ids[m1] = 0.;
                ids[e1] = 0.;
            }
        }
        ids
    }
    /// The modes' presence declaration to L1, with the port's from the
    /// last evaluation.
    fn presence(&self, y_view: &[f64]) -> Presence {
        let mut presence = self.net.stock_presence(y_view);
        for (c, m) in self.modes.iter().enumerate() {
            presence.cells[c] = match m {
                Mode::Liquid => [true, false],
                Mode::Equilibrium => [true, true],
                Mode::Dry => [false, true],
            };
        }
        presence
    }
    /// The coordinate a contact payment enters: an equilibrium cell's total
    /// energy slot for either phase, a liquid cell's phase energy, the
    /// stratified cell's admitted layer.
    fn payment_table(&self) -> Vec<[usize; 2]> {
        (0..self.modes.len())
            .map(|c| {
                let [_, _, e0, _, e1, _] = self.slots(c);
                match self.modes[c] {
                    Mode::Equilibrium | Mode::Dry => [e0, e0],
                    Mode::Liquid => [e0, e1],
                }
            })
            .collect()
    }
    /// Physical totals of the regular cells (mass, energy, tracer), the
    /// PZR's retained mass and tracer.
    fn totals(&self, y: &[f64]) -> [f64; 5] {
        let sc = self.net.scales();
        let (mut m, mut u, mut b) = (0., 0., 0.);
        for c in 0..self.modes.len() {
            let [_, m0, e0, m1, e1, bo] = self.slots(c);
            match self.modes[c] {
                Mode::Liquid => {
                    m += y[m0] * sc[m0] + y[m1] * sc[m1];
                    u += y[e0] * sc[e0] + y[e1] * sc[e1];
                }
                Mode::Equilibrium | Mode::Dry => {
                    m += y[m0] * sc[m0];
                    u += y[e0] * sc[e0];
                }
            }
            b += y[bo] * sc[bo];
        }
        let base = self.net.pzr.base;
        let pm: f64 = PZR_MASS.iter().map(|o| y[base + o] * sc[base + o]).sum();
        let pb: f64 = PZR_TRACER.iter().map(|o| y[base + o] * sc[base + o]).sum();
        [m, u, b, pm, pb]
    }
}

fn compare_totals(before: [f64; 5], after: [f64; 5], paid_j: f64) -> Value {
    let names = [
        "regular_mass_kg",
        "regular_energy_j",
        "regular_tracer_kg_eq",
        "pzr_mass_kg",
        "pzr_tracer_kg_eq",
    ];
    let mut out = serde_json::Map::new();
    for (k, name) in names.iter().enumerate() {
        out.insert(
            (*name).into(),
            json!({"before":before[k],"after":after[k],"difference":after[k]-before[k]}),
        );
    }
    out.insert("energy_paid_j".into(), json!(paid_j));
    out.insert(
        "energy_closure_j".into(),
        json!((after[1] - before[1]) - paid_j),
    );
    out.insert(
        "mass_and_tracer_bitwise".into(),
        json!(
            [0, 2, 3, 4]
                .iter()
                .all(|k| before[*k].to_bits() == after[*k].to_bits())
        ),
    );
    Value::Object(out)
}

impl ConsistentSystem for Case {
    fn system_dimension(&self) -> usize {
        self.net.dimension()
    }
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, network::Failure> {
        Ok(self
            .rows(t, y, yp, None, 0.)?
            .iter()
            .map(|r| r.value)
            .collect())
    }
    fn pencil_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), network::Failure> {
        let a = self.dense(t, 0., y, yp)?;
        let ab = self.dense(t, 1., y, yp)?;
        let b = ab.iter().zip(&a).map(|(x, y)| x - y).collect();
        Ok((a, b))
    }
}

/// The stock-IDA system of one segment (a shared handle: each restart
/// constructs a new stock handle, since the root count changes).
struct Handle(Rc<RefCell<Case>>);
impl System for Handle {
    /// Unreduced: every coordinate stands for itself (E-NUC).
    fn multiplicities(&self) -> Option<Vec<f64>> {
        None
    }
    fn dimension(&self) -> usize {
        self.0.borrow().net.dimension()
    }
    fn nonzeros(&self) -> usize {
        self.0.borrow().structure.pattern.nonzeros()
    }
    fn root_count(&self) -> usize {
        self.0.borrow().roots.len()
    }
    fn klu_ordering(&self) -> KluOrdering {
        KluOrdering::Colamd
    }
    fn residual(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let mut case = self.0.borrow_mut();
        let started = cpu_s();
        let rows = case.rows(t, y, yp, None, 0.).map_err(ida_failure);
        case.cost.residuals += 1;
        case.cost.residual_s += cpu_s() - started;
        for (o, r) in out.iter_mut().zip(rows?) {
            *o = r.value;
        }
        Ok(())
    }
    fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        data: &mut [f64],
        rows: &mut [i64],
        pointers: &mut [i64],
    ) -> Result<(), Failure> {
        let mut case = self.0.borrow_mut();
        let started = cpu_s();
        rows.copy_from_slice(&case.csc.1);
        pointers.copy_from_slice(&case.csc.0);
        let result = case.assemble(t, cj, y, yp, data).map_err(ida_failure);
        case.cost.jacobians += 1;
        case.cost.jacobian_s += cpu_s() - started;
        result
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let mut case = self.0.borrow_mut();
        let started = cpu_s();
        // L1's release roots read this state's drives.
        let l1 = case.l1_roots.clone();
        if release_roots(&l1) {
            case.rows(t, y, yp, None, 0.)
                .map_err(|e| Failure::Fatal(format!("{e:?}")))?;
        }
        let (ym, _) = case
            .view(y, None)
            .map_err(|e| Failure::Fatal(format!("{e:?}")))?;
        let mut l1_values = vec![0.; l1.len()];
        case.net
            .unilateral_root_values(&ym, &l1, &mut l1_values)
            .map_err(|e| Failure::Fatal(format!("{e:?}")))?;
        let sc = case.net.scales().to_vec();
        let mut next_l1 = l1_values.into_iter();
        for (k, root) in case.roots.clone().into_iter().enumerate() {
            out[k] = match root {
                RootKind::Birth(c) => case.departure(c, y).map_err(Failure::Fatal)?,
                RootKind::Exhaustion(c) => {
                    let m1 = case.slots(c)[3];
                    y[m1] * sc[m1]
                }
                RootKind::Dryout(c) => {
                    let [_, m0, _, m1, ..] = case.slots(c);
                    y[m0] * sc[m0] - y[m1] * sc[m1]
                }
                RootKind::L1(_) => next_l1
                    .next()
                    .ok_or_else(|| Failure::Fatal("L1 root layout".into()))?,
            };
        }
        case.cost.root_calls += 1;
        case.cost.root_s += cpu_s() - started;
        Ok(())
    }
}

fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

/// The declared stock settings of every segment (the spike's).
struct Config {
    rtol: f64,
    atol: Vec<f64>,
    max_order: usize,
    first_step_s: f64,
    newton_coefficient: f64,
    nonnegative: Vec<usize>,
}

#[allow(clippy::too_many_arguments)] // One segment's state and settings.
fn new_segment(
    case: &Rc<RefCell<Case>>,
    config: &Config,
    t: f64,
    y: &[f64],
    yp: &[f64],
    ids: &[f64],
    end_s: f64,
    restart: bool,
) -> Result<Ida<Handle>, String> {
    case.borrow_mut().declare_roots();
    let mut ida = Ida::new(
        Handle(case.clone()),
        Initial {
            time: t,
            y,
            yp,
            differential: ids,
            absolute_tolerance: &config.atol,
            relative_tolerance: config.rtol,
        },
    )?;
    ida.set_max_order(config.max_order)?;
    ida.set_nonlinear_convergence_coefficient(config.newton_coefficient)?;
    if restart {
        ida.set_init_step(config.first_step_s)?;
    }
    // An equilibrium cell's vapor mass is algebraic (the flash): its sign
    // is the exhaustion root's, not a stock-IDA constraint.
    let algebraic_vapor: Vec<usize> = {
        let case = case.borrow();
        (0..case.modes.len())
            .filter(|c| case.modes[*c] == Mode::Equilibrium)
            .map(|c| case.slots(c)[3])
            .collect()
    };
    let nonnegative: Vec<usize> = config
        .nonnegative
        .iter()
        .copied()
        .filter(|i| !algebraic_vapor.contains(i))
        .collect();
    ida.constrain_nonnegative(&nonnegative)?;
    ida.stop_at(end_s)?;
    Ok(ida)
}

fn stats_json(ida: &Ida<Handle>) -> Value {
    match ida.stats() {
        Ok(st) => {
            json!({"steps":st.steps,"residuals":st.residuals,"jacobians":st.jacobians,"newton":st.nonlinear_iterations,"error_failures":st.error_failures,"convergence_failures":st.convergence_failures,"setups":st.linear_setups,"root_evaluations":st.root_evaluations,"last_step_s":st.last_step,"last_order":st.last_order})
        }
        Err(e) => json!({"error":e}),
    }
}

fn changes_json(tx: &Transaction, regions: &[String]) -> Value {
    json!(
        tx.changes
            .iter()
            .map(|c| {
                json!({"face":c.face,"phase":c.phase,"before":format!("{:?}",c.before),"after":format!("{:?}",c.after),"cause":format!("{:?}",c.cause),"drive_pa":c.drive_pa,"impulse_pa_s":c.impulse_pa_s,"volume_flow_m3_s":c.volume_flow_m3_s,"payment":c.payment.map(|(cell,i,e)|json!({"cell":cell,"region":regions.get(cell).cloned().unwrap_or("PZR".into()),"coordinate":i,"energy_j":e}))})
            })
            .collect::<Vec<_>>()
    )
}

#[test]
#[ignore = "PHASE-L1 relief case, NOT EVIDENCE: needs G6's prototype packet (LD01_PHASE_PACKET), the wiki, maintained IF97 with the saturation-seam adapter and stock IDA/KLU"]
fn phase_l1_relief_case() {
    let packet_path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let out_path = std::env::var("LD01_PHASE_RECEIPT").ok();
    let settle_s: f64 = std::env::var("LD01_PHASE_SETTLE_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60.);
    let depressurize_cap_s = 150.;
    let after_birth_s = 20.;
    let cpu_cap_s = 900.;
    let output_s = 0.1;
    let pages = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01");
    let gates = strict_block(
        &format!("{pages}/model/build-readiness.md"),
        "ld01-s1-gates",
    );
    let p2 = strict_block(
        &format!("{pages}/systems/primary-coolant/pressurizer-thermal-state.md"),
        "ld01-p2-cases",
    );
    let raw: Value = serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).unwrap();
    let back_pressure_pa = raw["pzrMetal"]["reliefBackPressure_Pa"]
        .as_f64()
        .expect("packet pzrMetal.reliefBackPressure_Pa");
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let regions: Vec<String> = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: 1e-6,
        max_passes: 50,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let wall = std::time::Instant::now();
    let started = cpu_s();
    let load_start = load_average();
    let (net, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y = prepared.y.clone();
    for index in &net.rotor_index {
        y[*index] = 0.;
    }
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    let atol = net
        .absolute_tolerances(
            &y,
            ToleranceClasses {
                relative: f("relativeTolerance"),
                stock_scaled: f("stockScaledAbsolute"),
                tracer_scaled: f("tracerScaledAbsolute"),
                rotor_scaled: f("rotorScaledAbsolute"),
                volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
            },
        )
        .expect("tolerances");
    let config = Config {
        rtol: f("relativeTolerance"),
        atol,
        max_order: gates["maxOrder"].as_u64().unwrap() as usize,
        first_step_s: p2["eventRestartFirstStep_s"].as_f64().unwrap(),
        newton_coefficient: 0.33,
        nonnegative: net.nonnegative_stocks(),
    };
    let regular = net.pzr.cell;
    let structure = net.sparse_jacobian().expect("structure");
    let csc = structure.pattern.to_i64().expect("csc");
    let case = Rc::new(RefCell::new(Case {
        net,
        relief: Relief {
            lift: 0.,
            back_pressure_pa,
        },
        modes: vec![Mode::Liquid; regular],
        structure,
        csc,
        roots: Vec::new(),
        l1_roots: Vec::new(),
        cost: Cost::default(),
    }));
    let face_phase: Vec<(usize, usize)> = case
        .borrow()
        .net
        .face_layout
        .iter()
        .map(|l| (l.face, l.phase))
        .collect();
    let mut ledger = Ledger::default();
    let mut events: Vec<Value> = Vec::new();
    let mut samples: Vec<Value> = Vec::new();
    let mut segments: Vec<Value> = Vec::new();
    let mut failure: Option<String> = None;
    let mut ending = "time cap".to_string();
    let mut phantom_max = 0_f64;
    let mut opposite_stops = 0_usize;
    let mut opposite_by_kind: std::collections::BTreeMap<&str, usize> = Default::default();
    let mut located_by_kind: std::collections::BTreeMap<&str, usize> = Default::default();
    let mut unlocated_releases = 0_usize;
    let mut restarts = 0_usize;
    let mut restart_cpu = (0_f64, 0_f64, 0_f64); // transaction, consistent start, IDA construct
    // t = 0: L1 declared active on the prepared state, then the exact start.
    let activation = {
        let zero = vec![0.; y.len()];
        let mut c = case.borrow_mut();
        c.rows(0., &y, &zero, None, 0.)
            .expect("prepared evaluation");
        let (ym, _) = c.view(&y, None).expect("view");
        let presence = c.presence(&ym);
        let tx = c.net.activate_unilateral(&presence).expect("L1 activation");
        let locks = c.net.unilateral().unwrap();
        json!({"locked":locks.locked(),"paths":locks.paths.len(),"changes":tx.changes.len(),"energy_paid_j":tx.energy_paid_j,"causes":tx.changes.iter().map(|c|format!("{:?}",c.cause)).collect::<std::collections::BTreeSet<_>>()})
    };
    let mut ids = case.borrow().ids(&prepared.differential);
    let weights = error_weights(&y, config.rtol, &config.atol);
    let start_cpu = cpu_s();
    let (mut yp, pair) = consistent_start(
        &mut *case.borrow_mut(),
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        2,
    )
    .expect("consistent start at t = 0");
    events.push(json!({"t":0.,"kind":"prepared start, L1 active","l1_activation":activation,"consistent_start_cpu_s":cpu_s()-start_cpu,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value}));
    let mut t = 0.;
    let mut phase = 0; // 0 settle, 1 depressurize, 2 after birth
    let mut phase_end = settle_s;
    let mut first_birth: Option<f64> = None;
    let mut ida =
        new_segment(&case, &config, t, &y, &yp, &ids, phase_end, false).expect("first segment");
    let mut segment_start = (t, cpu_s());
    let mut next_output: f64 = output_s;
    let mut next_sample: f64 = 1.;
    loop {
        if cpu_s() - started > cpu_cap_s {
            ending = format!("CPU cap {cpu_cap_s} s");
            break;
        }
        let target = next_output.min(phase_end);
        let advanced = ida.advance(target, &mut y, &mut yp);
        // The crossings to act on, how they were found, and whether they
        // are root-located.
        let mut pending: Option<Pending> = None;
        match advanced {
            Err(e) => {
                failure = Some(format!("t≈{t}: {e}"));
                segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida),"failed":true}));
                break;
            }
            Ok(Advance::Reached(reached)) => {
                t = reached;
                let at_output = t >= next_output;
                if at_output {
                    next_output += output_s;
                }
                // Light samples and the phantom guard at every output.
                let mut c = case.borrow_mut();
                if c.rows(t, &y, &yp, None, 0.).is_ok() {
                    phantom_max = phantom_max.max(c.net.unilateral_phantom_m3_s());
                    if at_output && (phase == 2 || t >= next_sample) {
                        next_sample = t.floor() + 1.;
                        let sc = c.net.scales().to_vec();
                        let base = c.net.pzr.base;
                        samples.push(json!({"t":t,"roof_pa":y[base]*sc[base],"locked_paths":c.net.unilateral().map(|l|l.locked()),"phantom_m3_s":c.net.unilateral_phantom_m3_s(),"stats":stats_json(&ida),"totals":c.totals(&y)}));
                    }
                    // A one-sided lock whose drive left an exact zero at its
                    // restart is not reported by stock rootfinding (a zero
                    // start component is inactive): found here, flagged.
                    let missed: Vec<(RootKind, i32)> = c
                        .net
                        .unilateral()
                        .map(|locks| {
                            locks
                                .paths
                                .iter()
                                .enumerate()
                                .filter_map(|(li, lock)| match lock {
                                    Lock::Locked(h) => h.orientation().and_then(|o| {
                                        let (face, k) = face_phase[li];
                                        (o * c.net.face_drive(face, k).value > 0.)
                                            .then_some((RootKind::L1(Root::Release(li)), 1))
                                    }),
                                    Lock::Free => None,
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    if !missed.is_empty() {
                        unlocated_releases += missed.len();
                        pending = Some((
                            missed,
                            "release found at an output (zero-start drive), not root-located",
                            false,
                        ));
                    }
                }
                drop(c);
                if pending.is_some() {
                    segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida),"ended_by":"output check"}));
                } else if t >= phase_end {
                    segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida)}));
                    match phase {
                        0 => {
                            // C4's initiator: the relief stuck open at full lift.
                            phase = 1;
                            phase_end = t + depressurize_cap_s;
                            let before = cpu_s();
                            case.borrow_mut().relief.lift = 1.;
                            let w = error_weights(&y, config.rtol, &config.atol);
                            match consistent_start(
                                &mut *case.borrow_mut(),
                                t,
                                &mut y,
                                &ids,
                                &w,
                                1e-12,
                                2,
                            ) {
                                Ok((rates, pair)) => {
                                    yp = rates;
                                    events.push(json!({"t":t,"kind":"relief stuck open at full lift","consistent_start_cpu_s":cpu_s()-before,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value}));
                                }
                                Err(e) => {
                                    failure = Some(format!("relief restart at {t}: {e:?}"));
                                    break;
                                }
                            }
                            drop(ida);
                            ida = new_segment(&case, &config, t, &y, &yp, &ids, phase_end, true)
                                .expect("relief segment");
                            restarts += 1;
                            segment_start = (t, cpu_s());
                        }
                        1 => {
                            ending = "no birth within the depressurization cap".into();
                            break;
                        }
                        _ => {
                            ending = format!("{after_birth_s} s after the first birth");
                            break;
                        }
                    }
                }
            }
            Ok(Advance::Root { time, directions }) => {
                t = time;
                let roots = case.borrow().roots.clone();
                let crossings: Vec<(RootKind, i32)> = roots
                    .iter()
                    .zip(&directions)
                    .filter(|(_, d)| **d != 0)
                    .map(|(r, d)| (*r, *d))
                    .collect();
                let (acting, opposite): (Vec<_>, Vec<_>) =
                    crossings.iter().partition(|(r, d)| *d == r.direction());
                for (r, _) in &opposite {
                    *opposite_by_kind.entry(r.name()).or_default() += 1;
                }
                if acting.is_empty() {
                    // Every crossing against its declared direction: no
                    // transaction; the same stock handle continues.
                    opposite_stops += 1;
                    continue;
                }
                segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida),"ended_by_root":true}));
                pending = Some((crossings, "located root", true));
            }
        }
        let Some((crossings, how, root_located)) = pending else {
            continue;
        };
        let located_cpu = cpu_s();
        let transaction_started = cpu_s();
        let before_totals = case.borrow().totals(&y);
        let mut description = Vec::new();
        let mut dryout: Option<String> = None;
        let mut births = false;
        // 1. The modes' transactions (test-local, the spike's).
        {
            let mut c = case.borrow_mut();
            for (root, direction) in &crossings {
                if *direction != root.direction() || !root_located {
                    continue;
                }
                *located_by_kind.entry(root.name()).or_default() += 1;
                match root {
                    RootKind::Birth(cell) => {
                        // Totals into the differential slots; at a birth
                        // M_g = U_g = 0 and nothing moves.
                        let sc = c.net.scales().to_vec();
                        let [_, m0, e0, m1, e1, _] = c.slots(*cell);
                        y[m0] += y[m1] * sc[m1] / sc[m0];
                        y[e0] += y[e1] * sc[e1] / sc[e0];
                        c.modes[*cell] = Mode::Equilibrium;
                        births = true;
                        description.push(json!({"birth":cell,"region":regions[*cell]}));
                        first_birth.get_or_insert(t);
                    }
                    RootKind::Exhaustion(cell) => {
                        let [_, _, _, m1, e1, _] = c.slots(*cell);
                        description.push(json!({"exhaustion":cell,"region":regions[*cell],"vapor_slots_at_root":[y[m1],y[e1]]}));
                        y[m1] = 0.;
                        y[e1] = 0.;
                        c.modes[*cell] = Mode::Liquid;
                    }
                    RootKind::Dryout(cell) => {
                        c.modes[*cell] = Mode::Dry;
                        description.push(json!({"dryout":cell,"region":regions[*cell]}));
                        dryout = Some(format!(
                            "dryout of equilibrium cell {cell} ({}): mode G is S6 scope",
                            regions[*cell]
                        ));
                    }
                    RootKind::L1(r) => {
                        description.push(json!({"l1":format!("{r:?}"),"face":face_phase[r.path()].0,"phase":face_phase[r.path()].1}));
                    }
                }
            }
        }
        let mode_totals = case.borrow().totals(&y);
        // 2. L1's transaction on the post-mode state, with the modes'
        //    presence and the located L1 roots.
        let l1 = {
            let mut c = case.borrow_mut();
            match c.rows(t, &y, &yp, None, 0.) {
                Err(e) => Err(format!("{e:?}")),
                Ok(_) => {
                    let (ym, _) = c.view(&y, None).expect("view");
                    let presence = c.presence(&ym);
                    let l1_roots = c.l1_roots.clone();
                    // The L1 roots' crossings in their declared order (none
                    // for a release found at an output: not root-located).
                    let l1_directions: Vec<i32> = c
                        .roots
                        .iter()
                        .filter(|r| matches!(r, RootKind::L1(_)))
                        .map(|r| {
                            crossings
                                .iter()
                                .find(|(x, _)| x == r && root_located)
                                .map_or(0, |(_, d)| *d)
                        })
                        .collect();
                    let (fired, opposite) = located(&l1_roots, &l1_directions);
                    let table = c.payment_table();
                    let pzr = c.net.pzr.cell;
                    let pzr_payment = c.net.payment_coordinate(pzr, 0).ok();
                    let pay = move |cell: usize, k: usize| -> Result<usize, network::Failure> {
                        if cell == pzr {
                            pzr_payment.ok_or_else(|| fatal("no PZR liquid payment"))
                        } else {
                            table
                                .get(cell)
                                .map(|e| e[k])
                                .ok_or_else(|| fatal("no payment slot"))
                        }
                    };
                    c.net
                        .unilateral_transaction(&mut y, &presence, &fired, Some(&pay))
                        .map_err(|e| format!("{e:?}"))
                        .inspect(|tx| ledger.record(t, &l1_roots, &fired, &opposite, tx))
                }
            }
        };
        let transaction_s = cpu_s() - transaction_started;
        restart_cpu.0 += transaction_s;
        let tx = match l1 {
            Ok(tx) => tx,
            Err(e) => {
                events.push(
                    json!({"t":t,"kind":"root","how":how,"fired":description,"l1_refused":e}),
                );
                failure = Some(format!("L1 transaction at {t} refused"));
                break;
            }
        };
        let after_totals = case.borrow().totals(&y);
        // A release into an end without vapor is the declared C4 end.
        let unsupported = tx
            .changes
            .iter()
            .find(|ch| ch.phase == 1 && ch.after == Lock::Free && ch.cause != Cause::Birth)
            .map(|ch| {
                let face = &packet.mechanics.faces[ch.face];
                format!(
                    "vapor path {} released by its drive ({:?}) toward a liquid-only end ({} / {}): the declared C4 end",
                    ch.face,
                    ch.cause,
                    regions.get(face.from).cloned().unwrap_or("PZR".into()),
                    regions.get(face.to).cloned().unwrap_or("PZR".into())
                )
            });
        let mut event = json!({"t":t,"kind":"root","how":how,"fired":description,"l1_changes":changes_json(&tx,&regions),"l1_locked_after":case.borrow().net.unilateral().map(|l|l.locked()),"transaction_cpu_s":transaction_s,"conservation_mode_transaction":compare_totals(before_totals,mode_totals,0.),"conservation_l1_transaction":compare_totals(mode_totals,after_totals,tx.energy_paid_j),"births":births});
        if let Some(d) = dryout {
            event["unsupported"] = json!(d);
            events.push(event);
            ending = d;
            break;
        }
        ids = case.borrow().ids(&prepared.differential);
        let restart_started = cpu_s();
        let w = error_weights(&y, config.rtol, &config.atol);
        let start = consistent_start(&mut *case.borrow_mut(), t, &mut y, &ids, &w, 1e-12, 2);
        let start_s = cpu_s() - restart_started;
        restart_cpu.1 += start_s;
        let started_totals = case.borrow().totals(&y);
        event["conservation_consistent_start"] = compare_totals(after_totals, started_totals, 0.);
        match start {
            Ok((rates, pair)) => {
                yp = rates;
                event["consistent_start"] = json!({"cpu_s":start_s,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value,"projection_wrms":pair.projection.as_ref().map(|p|p.correction_wrms),"projection_passes":pair.projection.as_ref().map(|p|p.passes)});
            }
            Err(e) => {
                event["consistent_start"] = json!({"cpu_s":start_s,"refused":format!("{e:?}")});
                events.push(event);
                failure = Some(format!("consistent start at {t} refused"));
                break;
            }
        }
        if first_birth == Some(t) && phase == 1 {
            phase = 2;
            phase_end = t + after_birth_s;
        }
        let construct_started = cpu_s();
        drop(ida);
        ida = match new_segment(&case, &config, t, &y, &yp, &ids, phase_end, true) {
            Ok(i) => i,
            Err(e) => {
                failure = Some(format!("segment at {t}: {e}"));
                events.push(event);
                break;
            }
        };
        restarts += 1;
        restart_cpu.2 += cpu_s() - construct_started;
        event["roots_declared"] = json!(case.borrow().roots.len());
        event["event_total_cpu_s"] = json!(cpu_s() - located_cpu);
        events.push(event);
        segment_start = (t, cpu_s());
        next_output = (t / output_s).floor() * output_s + output_s;
        if let Some(u) = unsupported {
            ending = u;
            break;
        }
    }
    let cost = case.borrow().cost;
    let chattering = ledger.chattering(|p| face_phase[p]);
    let receipt = json!({
        "kind":"ld01-phase-l1-relief-case-NOT-EVIDENCE",
        "provenance":std::env::var("LD01_PHASE_PROVENANCE").ok().and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "scope":"PHASE-L1: the PHASE spike's relief case on the S1 network (G6 relief hook) with the network's L1 (network::unilateral, network::phase_events) active from t = 0; cell modes L/E test-local (the spike's); exact consistent restarts; new stock IDA handle per transaction; colored Jacobian on the S1 structural pattern; NOT evidence",
        "packet":packet_path,
        "wiki_root":wiki,
        "settle_s":settle_s,
        "config":{"rtol":config.rtol,"max_order":config.max_order,"first_step_after_event_s":config.first_step_s,"newton_coefficient":config.newton_coefficient,"relief_lift":1.0,"relief_back_pressure_pa":back_pressure_pa,"output_s":output_s},
        "events":events,
        "segments":segments,
        "first_birth_s":first_birth,
        "ending":ending,
        "failure":failure,
        "l1":{
            "ledger":ledger,
            "chattering_dr_p1":chattering,
            "phantom_guard_max_m3_s":phantom_max,
            "unlocated_releases_at_outputs":unlocated_releases,
        },
        "roots":{"located_by_kind":located_by_kind,"opposite_by_kind":opposite_by_kind,"stops_with_only_opposite_crossings":opposite_stops,"restarts":restarts},
        "cost":{"residuals":cost.residuals,"residual_cpu_s":cost.residual_s,"jacobians":cost.jacobians,"jacobian_cpu_s":cost.jacobian_s,"root_calls":cost.root_calls,"root_cpu_s":cost.root_s,"transactions_cpu_s":restart_cpu.0,"consistent_starts_cpu_s":restart_cpu.1,"ida_construct_cpu_s":restart_cpu.2},
        "cpu_s":cpu_s()-started,
        "wall_s":wall.elapsed().as_secs_f64(),
        "load_average":{"start":load_start,"end":load_average()},
        "samples":samples,
    });
    let text = serde_json::to_string_pretty(&receipt).unwrap();
    if let Some(path) = out_path {
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipts are never overwritten: {path}"
        );
        std::fs::write(&path, &text).expect("receipt");
    }
    println!(
        "{}",
        json!({"first_birth_s":receipt["first_birth_s"],"ending":receipt["ending"],"failure":receipt["failure"],"events":receipt["events"].as_array().map(|e|e.len()),"located":receipt["roots"]["located_by_kind"],"opposite":receipt["roots"]["opposite_by_kind"],"l1_causes":receipt["l1"]["ledger"]["causes"],"paid_j":receipt["l1"]["ledger"]["energy_paid_j"],"phantom":phantom_max,"cpu_s":receipt["cpu_s"]})
    );
}

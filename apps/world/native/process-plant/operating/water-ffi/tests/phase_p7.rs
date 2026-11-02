//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#l1-unilateral-absent-donor-law-implemented-at-s3
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/bulk-condensation-study.md#stable-phase-birth-and-disappearance
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#prospective-accuracy-contract
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-treatment-of-uncredited-lumped-modes
//! PHASE-P7 study (S3-D-P7), NOT EVIDENCE and not a selected law: a copy of
//! the PHASE spike (`phase_spike.rs`, 71cd33da / abdd1991) with the study's
//! variants, all declared by environment and recorded in the receipt:
//! - `LD01_P7_CLASS`: `declared` (the spike's G12 classes), `derived-p`
//!   (S2-D24 pattern on an equilibrium cell's algebraic vapor coordinates:
//!   `atol_Mg = atol_p |dM_g/dp|_{M,U}`, `atol_Ug = atol_p |dU_g/dp|_{M,U}`
//!   with `atol_p = rtol |p|` at the segment start, S2-D24's basis) or
//!   `derived-cell` (the same with the cell's own declared pressure class);
//! - `LD01_P7_DCJ`: stock `IDASetDeltaCjLSetup` (S2 declares 0.1);
//! - `LD01_P7_REFERENCE_FACTOR`: rtol and every absolute class scaled
//!   (`referenceToleranceFactor`), the derived classes through their basis;
//! - `LD01_P7_OBSERVE_S` / `LD01_P7_OBSERVE_FROM_S` / `LD01_P7_OBSERVE_FILE`:
//!   a stock-interpolant observation grid (IDA_NORMAL outputs, no step
//!   forced) of the credited taps, written as JSON lines;
//! - `LD01_P7_STATE`: start from the network part of an exported joined
//!   state (`{packet, y_bits, yp_bits}`), e.g. the S2-07 settled state;
//! - `LD01_P7_WHATIF`: labelled what-if pencils (NOT a trajectory): groups of
//!   regions (`;` cumulative, `,` within a group) put in the equilibrium mode
//!   at saturated liquid filling their volume at their own pressure, to read
//!   where two-phase compliance moves the lumped modes;
//! - `LD01_P7_SPECTRUM_HZ`: upper limit of the reported modes.
#![cfg(all(feature = "ida", target_os = "macos"))]
// A study copy of the PHASE spike: its loops and closures keep the spike's form.
#![allow(
    clippy::needless_range_loop,
    clippy::too_many_arguments,
    clippy::redundant_closure_call,
    clippy::collapsible_if
)]
use leitbild_operating_plant::{
    network::{
        self, ConsistentSystem, Coupling, Fluid, Network, PZR_MASS, PZR_TRACER, Properties,
        Receipts, RotorState, SparseJacobian, ToleranceClasses, consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
        stratified,
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse,
    thermal::Scalar,
};
use leitbild_operating_water::{
    If97,
    ida::{Advance, Failure, Ida, Initial, KluOrdering, System},
    spectrum,
};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

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

/// A regular cell's phase mode (design §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// Today's separated rows; liquid only while the spike runs.
    Liquid,
    /// Both bounds active: slot `M_l` holds `M`, slot `U_l` holds `U`.
    Equilibrium,
}

/// C4's stuck-open relief through G6's boundary hook: a fixed lift and the
/// declared receiver backpressure.
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

#[derive(Clone, Copy, Debug, PartialEq)]
enum RootKind {
    /// Liquid departure `T_l - Tsat(p)` of a liquid-only cell, rising.
    Birth(usize),
    /// Equilibrium cell's vapor mass, falling.
    Exhaustion(usize),
    /// An L1-held vapor path's drive.
    Release(usize),
    /// Equilibrium cell's liquid mass `M - M_g`, falling: dryout (mode G, S6).
    Dryout(usize),
}

#[derive(Clone, Copy, Debug, Default)]
struct Cost {
    residuals: usize,
    residual_s: f64,
    jacobians: usize,
    jacobian_s: f64,
    root_calls: usize,
    root_s: f64,
}

struct Spike {
    net: Network<If97>,
    relief: Relief,
    modes: Vec<Mode>,
    /// Per face: its vapor path is held by L1.
    held: Vec<bool>,
    /// Per face: +1 when its vapor end is `from`, -1 when `to`.
    orientation: Vec<f64>,
    endpoints: Vec<(usize, usize)>,
    structure: SparseJacobian,
    csc: (Vec<i64>, Vec<i64>),
    roots: Vec<RootKind>,
    cost: Cost,
    /// Per segment: the tolerance classes the study gave equilibrium cells.
    class_log: Vec<Value>,
}

/// The absolute class of an equilibrium cell's algebraic `M_g, U_g`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Basis {
    /// The spike's (G12) stock classes.
    Declared,
    /// S2-D24: `atol_p = rtol |p|` through `|dM_g/dp|`, `|dU_g/dp|`.
    RelativePressure,
    /// The cell's own declared pressure class through the same sensitivity.
    CellPressureClass,
}

impl Spike {
    /// Segment tolerances: the declared vector, with each equilibrium cell's
    /// algebraic vapor coordinates given the derived class of `config.basis`.
    /// The sensitivities are the flash's at fixed totals, from the split row
    /// `U = (M - M_g) u_f(p) + M_g u_g(p)`: `dM_g/dp = -(M_l u_f' + M_g u_g')/u_fg`,
    /// `dU_g/dp = u_g dM_g/dp + M_g u_g'` (IF97 saturation directions).
    #[allow(clippy::type_complexity)]
    fn segment_atol(
        &self,
        y: &[f64],
        config: &Config,
    ) -> Result<(Vec<f64>, Vec<Value>), network::Failure> {
        let mut atol = config.atol.clone();
        if config.basis == Basis::Declared {
            return Ok((atol, Vec::new()));
        }
        let sc = self.net.scales();
        let mut log = Vec::new();
        for c in 0..self.modes.len() {
            if self.modes[c] != Mode::Equilibrium {
                continue;
            }
            let [b, m0, _, m1, e1, _] = self.slots(c);
            let p = y[b] * sc[b];
            let total = y[m0] * sc[m0];
            let mg = y[m1] * sc[m1];
            let [_, uf, _, ug] = self.saturation(Scalar::new(p, 1.))?;
            let ml = total - mg;
            let ufg = ug.value - uf.value;
            let dmg_dp = -(ml * uf.direction + mg * ug.direction) / ufg;
            let dug_dp = ug.value * dmg_dp + mg * ug.direction;
            let atol_p = match config.basis {
                Basis::RelativePressure => config.rtol * p.abs(),
                Basis::CellPressureClass => config.atol[b] * sc[b],
                Basis::Declared => unreachable!(),
            };
            let (am, au) = (atol_p * dmg_dp.abs(), atol_p * dug_dp.abs());
            log.push(json!({"cell":c,"p_pa":p,"mass_kg":total,"vapor_kg":mg,"atol_p_pa":atol_p,
                "dmg_dp_kg_per_pa":dmg_dp,"dug_dp_j_per_pa":dug_dp,
                "atol_mg_kg":am,"atol_ug_j":au,
                "declared_atol_mg_kg":config.atol[m1]*sc[m1],"declared_atol_ug_j":config.atol[e1]*sc[e1],
                "declared_mg_class_as_pressure_pa":config.atol[m1]*sc[m1]/dmg_dp.abs(),
                "cell_pressure_class_pa":config.atol[b]*sc[b]}));
            atol[m1] = am / sc[m1];
            atol[e1] = au / sc[e1];
        }
        Ok((atol, log))
    }
    /// Compliance `-dV/dp` at fixed totals [m3/Pa] of a cell: the flash's in
    /// the equilibrium mode; in the liquid mode the liquid's own (isentropic
    /// `V kappa_s`) and, for comparison, the flash's if the cell's liquid were
    /// saturated at its pressure (`M u_f' v_fg/u_fg - M v_f'`).
    fn compliance(&self, c: usize, y: &[f64]) -> Result<Value, network::Failure> {
        let sc = self.net.scales();
        let [b, m0, e0, m1, ..] = self.slots(c);
        let p = y[b] * sc[b];
        let sat = self
            .net
            .properties()
            .saturation_caloric(Scalar::new(p, 1.))
            .map_err(network::Failure::Recoverable)?;
        let pp = Scalar::new(p, 1.);
        let (rf, rg) = (sat.liquid.density, sat.vapor.density);
        let (uf, ug) = (sat.liquid.enthalpy - pp / rf, sat.vapor.enthalpy - pp / rg);
        let (vf, vg) = (s(1.) / rf, s(1.) / rg);
        let flash = |ml: f64, mg: f64| -> f64 {
            let ufg = ug.value - uf.value;
            let dmg = -(ml * uf.direction + mg * ug.direction) / ufg;
            -(ml * vf.direction + mg * vg.direction + (vg.value - vf.value) * dmg)
        };
        match self.modes[c] {
            Mode::Equilibrium => {
                let total = y[m0] * sc[m0];
                let mg = y[m1] * sc[m1];
                Ok(json!({"cell":c,"mode":"E","p_pa":p,"compliance_m3_pa":flash(total - mg, mg)}))
            }
            Mode::Liquid => {
                let mass = y[m0] * sc[m0];
                let u = y[e0] * sc[e0] / mass;
                let props = self.net.properties();
                let point = props
                    .caloric(false, p, u, false)
                    .map_err(network::Failure::Fatal)?;
                let q = props.values(&point);
                let isentropic = q.compressibility_per_pa
                    - q.temperature_k * q.expansion_per_k.powi(2) / (q.density_kg_m3 * q.cp_j_kg_k);
                let liquid = self.net.volume(c) * isentropic;
                let saturated = flash(self.net.volume(c) * rf.value, 0.);
                Ok(
                    json!({"cell":c,"mode":"L","p_pa":p,"compliance_m3_pa":liquid,
                    "flash_if_saturated_m3_pa":saturated,"ratio":saturated/liquid}),
                )
            }
        }
    }
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
    fn vapor_index(&self, face: usize) -> usize {
        self.net.face_layout[2 * face + 1].index
    }
    fn value(&self, y: &[f64], seed: Option<&[f64]>, i: usize) -> Scalar {
        let sc = self.net.scales()[i];
        Scalar::new(y[i] * sc, seed.map_or(0., |d| d[i]) * sc)
    }
    /// Saturation endpoints `(rho_f, u_f, rho_g, u_g)` at `p`, with directions.
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
            if self.modes[c] != Mode::Equilibrium {
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
    /// All rows (value and direction along `seed`): the network's, then the
    /// equilibrium cells' and the L1-held paths' own rows.
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
            let net_rows = [rows[m0], rows[m1], rows[e0], rows[e1]];
            // Receipts from the network's own stock rows at its view.
            let received = |i: usize, row: Scalar| rate(i, sm.as_deref()) - row * s(sc[i]);
            let rl = received(m0, net_rows[0]);
            let rg = received(m1, net_rows[1]);
            let el = received(e0, net_rows[2]);
            let eg = received(e1, net_rows[3]);
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
        for (face, held) in self.held.iter().enumerate() {
            if *held {
                let i = self.net.face_layout[2 * face + 1].index;
                rows[i] = Scalar::new(y[i], seed.map_or(0., |d| d[i]));
            }
        }
        Ok(rows)
    }
    /// The colored stage Jacobian on the network's structural pattern, which
    /// covers every phase presence of a regular cell (design §5): one seeded
    /// evaluation per color through the equilibrium cells' view, its rows
    /// and the L1-held rows included.
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
        let n = y.len();
        let mut seed = vec![0.; n];
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
    /// The declared root functions of the current modes and holds.
    fn declare_roots(&mut self) {
        let mut roots = Vec::new();
        for (c, m) in self.modes.iter().enumerate() {
            match m {
                Mode::Liquid => roots.push(RootKind::Birth(c)),
                Mode::Equilibrium => {
                    roots.push(RootKind::Exhaustion(c));
                    roots.push(RootKind::Dryout(c));
                }
            }
        }
        for (j, h) in self.held.iter().enumerate() {
            if *h {
                roots.push(RootKind::Release(j));
            }
        }
        self.roots = roots;
    }
    /// The differential identity of the current modes and holds.
    fn ids(&self, prepared: &[f64]) -> Vec<f64> {
        let mut ids = self.net.differential(prepared);
        for c in 0..self.modes.len() {
            if self.modes[c] == Mode::Equilibrium {
                let [_, _, _, m1, e1, _] = self.slots(c);
                ids[m1] = 0.;
                ids[e1] = 0.;
            }
        }
        for (j, h) in self.held.iter().enumerate() {
            if *h {
                ids[self.vapor_index(j)] = 0.;
            }
        }
        ids
    }
    /// A cell holds vapor in the current state: an equilibrium cell, or a
    /// nonzero vapor stock.
    fn holds_vapor(&self, c: usize, y: &[f64]) -> bool {
        if c >= self.modes.len() {
            return false; // the stratified cell's surge port carries liquid only
        }
        self.modes[c] == Mode::Equilibrium || y[self.slots(c)[3]] != 0.
    }
    /// L1 holds after a transaction: every vapor path with vapor at one end
    /// whose drive would draw from the other (decision 0014); every other
    /// path is free. Returns the paths whose hold changed.
    fn update_holds(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        released: &[usize],
    ) -> Result<Vec<Value>, network::Failure> {
        self.rows(t, y, yp, None, 0.)?;
        let mut changed = Vec::new();
        for j in 0..self.endpoints.len() {
            let (from, to) = self.endpoints[j];
            let (vf, vt) = (self.holds_vapor(from, y), self.holds_vapor(to, y));
            let drive = self.net.face_drive(j, 1).value;
            // Vapor at exactly one end: held unless the drive draws from
            // that end. A newborn phase has zero fraction, so its path's
            // drive is exactly zero at the birth: held, released by root.
            let one_end = vf != vt;
            let orientation = if vf { 1. } else { -1. };
            let hold = one_end && orientation * drive <= 0. && !released.contains(&j);
            self.orientation[j] = orientation;
            if hold != self.held[j] {
                changed.push(json!({"face":j,"from":from,"to":to,"drive_pa":drive,"held":hold,"pi":y[self.vapor_index(j)],"vapor_at":if vf {from} else {to}}));
                self.held[j] = hold;
            }
        }
        Ok(changed)
    }
    /// Physical totals of the regular cells (mass, energy, tracer) and the
    /// PZR's retained mass and tracer.
    fn totals(&self, y: &[f64]) -> Value {
        let sc = self.net.scales();
        let (mut m, mut u, mut b) = (0., 0., 0.);
        for c in 0..self.modes.len() {
            let [_, m0, e0, m1, e1, bo] = self.slots(c);
            match self.modes[c] {
                Mode::Liquid => {
                    m += y[m0] * sc[m0] + y[m1] * sc[m1];
                    u += y[e0] * sc[e0] + y[e1] * sc[e1];
                }
                Mode::Equilibrium => {
                    m += y[m0] * sc[m0];
                    u += y[e0] * sc[e0];
                }
            }
            b += y[bo] * sc[bo];
        }
        let base = self.net.pzr.base;
        let pm: f64 = PZR_MASS.iter().map(|o| y[base + o] * sc[base + o]).sum();
        let pb: f64 = PZR_TRACER.iter().map(|o| y[base + o] * sc[base + o]).sum();
        json!({"regular_mass_kg":m,"regular_energy_j":u,"regular_tracer_kg_eq":b,"pzr_mass_kg":pm,"pzr_tracer_kg_eq":pb})
    }
}

impl ConsistentSystem for Spike {
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
    fn restart_bounds(&self) -> Option<(Vec<usize>, f64)> {
        None
    }
}

/// The stock-IDA system of one segment: a shared handle, so each restart
/// constructs a new stock handle (a mode changes the root count).
struct Handle(Rc<RefCell<Spike>>);
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
        let mut sp = self.0.borrow_mut();
        let started = cpu_s();
        let rows = sp.rows(t, y, yp, None, 0.).map_err(ida_failure);
        sp.cost.residuals += 1;
        sp.cost.residual_s += cpu_s() - started;
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
        let mut sp = self.0.borrow_mut();
        let started = cpu_s();
        rows.copy_from_slice(&sp.csc.1);
        pointers.copy_from_slice(&sp.csc.0);
        let result = sp.assemble(t, cj, y, yp, data).map_err(ida_failure);
        sp.cost.jacobians += 1;
        sp.cost.jacobian_s += cpu_s() - started;
        result
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let mut sp = self.0.borrow_mut();
        let started = cpu_s();
        let needs_drive = sp.roots.iter().any(|r| matches!(r, RootKind::Release(_)));
        if needs_drive {
            sp.rows(t, y, yp, None, 0.)
                .map_err(|e| Failure::Fatal(format!("{e:?}")))?;
        }
        let sc = sp.net.scales().to_vec();
        for (k, root) in sp.roots.clone().into_iter().enumerate() {
            out[k] = match root {
                RootKind::Birth(c) => sp.departure(c, y).map_err(Failure::Fatal)?,
                RootKind::Exhaustion(c) => {
                    let m1 = sp.slots(c)[3];
                    y[m1] * sc[m1]
                }
                RootKind::Release(j) => sp.orientation[j] * sp.net.face_drive(j, 1).value,
                RootKind::Dryout(c) => {
                    let [_, m0, _, m1, ..] = sp.slots(c);
                    y[m0] * sc[m0] - y[m1] * sc[m1]
                }
            };
        }
        sp.cost.root_calls += 1;
        sp.cost.root_s += cpu_s() - started;
        Ok(())
    }
}

fn error_weights(y: &[f64], rtol: f64, atol: &[f64]) -> Vec<f64> {
    y.iter()
        .zip(atol)
        .map(|(v, a)| 1. / (rtol * v.abs() + a))
        .collect()
}

/// The declared stock settings of every segment.
struct Config {
    rtol: f64,
    atol: Vec<f64>,
    max_order: usize,
    first_step_s: f64,
    newton_coefficient: f64,
    nonnegative: Vec<usize>,
    basis: Basis,
    dcj: Option<f64>,
    /// A declared step cap (E3's 2.5 ms reference), every segment.
    max_step: Option<f64>,
}

fn new_segment(
    spike: &Rc<RefCell<Spike>>,
    config: &Config,
    t: f64,
    y: &[f64],
    yp: &[f64],
    ids: &[f64],
    end_s: f64,
    restart: bool,
) -> Result<Ida<Handle>, String> {
    spike.borrow_mut().declare_roots();
    let (atol, log) = spike
        .borrow()
        .segment_atol(y, config)
        .map_err(|e| format!("segment tolerances at {t}: {e:?}"))?;
    if !log.is_empty() {
        spike
            .borrow_mut()
            .class_log
            .push(json!({"t":t,"cells":log}));
    }
    let mut ida = Ida::new(
        Handle(spike.clone()),
        Initial {
            time: t,
            y,
            yp,
            differential: ids,
            absolute_tolerance: &atol,
            relative_tolerance: config.rtol,
        },
    )?;
    ida.set_max_order(config.max_order)?;
    ida.set_nonlinear_convergence_coefficient(config.newton_coefficient)?;
    if let Some(dcj) = config.dcj {
        ida.set_delta_cj_lsetup(dcj)?;
    }
    if let Some(h) = config.max_step {
        ida.set_max_step(h)?;
    }
    if restart {
        ida.set_init_step(config.first_step_s)?;
    }
    // An equilibrium cell's vapor mass is algebraic (the flash): its sign
    // is watched by the exhaustion root, not by a stock-IDA constraint.
    let algebraic_vapor: Vec<usize> = {
        let sp = spike.borrow();
        (0..sp.modes.len())
            .filter(|c| sp.modes[*c] == Mode::Equilibrium)
            .map(|c| sp.slots(c)[3])
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

/// A light sample of the depressurization at an output.
fn sample(spike: &mut Spike, t: f64, y: &[f64], yp: &[f64], watch: &[usize]) -> Value {
    let rows = spike.rows(t, y, yp, None, 0.);
    if let Err(e) = rows {
        return json!({"t":t,"error":format!("{e:?}")});
    }
    let sc = spike.net.scales().to_vec();
    let base = spike.net.pzr.base;
    let roof = y[base] * sc[base];
    let relief = spike
        .net
        .pzr_evaluation()
        .and_then(|e| e.flows.relief)
        .map(|r| json!({"vapor_kg_s":r.vapor_kg_s.value,"drop_kg_s":r.drop_kg_s.value,"enthalpy_w":r.enthalpy_w.value,"boron_kg_s":r.boron_kg_s.value}));
    let level = spike.net.pzr_taps().ok().map(|t| t.collapsed_level_m.value);
    let cells: Vec<Value> = watch
        .iter()
        .map(|&c| {
            let [b, _, _, m1, ..] = spike.slots(c);
            match spike.modes[c] {
                Mode::Liquid => {
                    json!({"cell":c,"p_pa":y[b]*sc[b],"departure_k":spike.departure(c, y).ok(),"vapor_kg":y[m1]*sc[m1]})
                }
                Mode::Equilibrium => {
                    json!({"cell":c,"p_pa":y[b]*sc[b],"mode":"E","vapor_kg":y[m1]*sc[m1]})
                }
            }
        })
        .collect();
    json!({"t":t,"roof_pa":roof,"collapsed_level_m":level,"relief":relief,"cells":cells,"totals":spike.totals(y)})
}

/// Credited taps (accuracy contract, as the S1 harness reads them) and the
/// housing cells, at an observed state; the solver history is untouched.
struct Taps {
    lower: usize,
    upper: usize,
    loop_faces: [usize; 2],
    housing: Vec<usize>,
}
fn credited(spike: &mut Spike, t: f64, y: &[f64], yp: &[f64], taps: &Taps) -> Value {
    if let Err(e) = spike.rows(t, y, yp, None, 0.) {
        return json!({"t":t,"error":format!("{e:?}")});
    }
    let sc = spike.net.scales().to_vec();
    let pzr = spike.net.pzr_taps().ok();
    let net = &spike.net;
    let housing: Vec<Value> = taps
        .housing
        .iter()
        .map(|&c| {
            let l = net.cell_layout[c];
            json!([y[l.base] * sc[l.base], y[l.mass[1]] * sc[l.mass[1]]])
        })
        .collect();
    json!({"t":t,"pt1_pa":pzr.map(|p|p.pt1_pa.value),"level_m":pzr.map(|p|p.collapsed_level_m.value),
        "core_dp_pa":net.cell(taps.lower).pressure.value-net.cell(taps.upper).pressure.value,
        "loop_kg_s":taps.loop_faces.map(|f| net.chart(f, 0).map_or(0., |c| c.mass_flow_kg_s.value)),
        "housing_p_mg":housing})
}

/// The next point of an output grid strictly after `t`.
fn next_grid(t: f64, step: f64) -> f64 {
    let mut k = (t / step).floor() + 1.;
    while k * step <= t + 1e-12 {
        k += 1.;
    }
    k * step
}

fn stats_json(ida: &Ida<Handle>) -> Value {
    match ida.stats() {
        Ok(st) => {
            json!({"steps":st.steps,"residuals":st.residuals,"jacobians":st.jacobians,"newton":st.nonlinear_iterations,"error_failures":st.error_failures,"convergence_failures":st.convergence_failures,"setups":st.linear_setups,"root_evaluations":st.root_evaluations,"last_step_s":st.last_step,"last_order":st.last_order})
        }
        Err(e) => json!({"error":e}),
    }
}

fn compare_totals(before: &Value, after: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in [
        "regular_mass_kg",
        "regular_energy_j",
        "regular_tracer_kg_eq",
        "pzr_mass_kg",
        "pzr_tracer_kg_eq",
    ] {
        let (a, b) = (before[key].as_f64().unwrap(), after[key].as_f64().unwrap());
        out.insert(key.into(), json!({"before":a,"after":b,"difference":b-a}));
    }
    Value::Object(out)
}

/// A readable name for every coordinate: regular cell slots, face phase
/// impulses, rotors and the PZR block.
fn labels(spike: &Spike, regions: &[String]) -> Vec<String> {
    let n = spike.net.dimension();
    let mut out = vec![String::new(); n];
    for c in 0..spike.modes.len() {
        let names = ["p", "M_l", "U_l", "M_g", "U_g", "B"];
        for (k, i) in spike.slots(c).iter().enumerate() {
            out[*i] = format!("{}.{}", regions[c], names[k]);
        }
    }
    for l in &spike.net.face_layout {
        out[l.index] = format!(
            "face{}.{}",
            l.face,
            if l.phase == 0 { "Pi_l" } else { "Pi_g" }
        );
    }
    for (r, i) in spike.net.rotor_index.iter().enumerate() {
        out[*i] = format!("rotor{r}");
    }
    for (k, i) in spike.net.pzr.coordinates().enumerate() {
        out[i] = format!("PZR[{k}]");
    }
    out
}

/// Finite modes of the pencil at a state, those at or below `max_hz` (real
/// or oscillatory), with their four largest right-vector coordinates.
fn spectrum_summary(
    spike: &mut Spike,
    t: f64,
    y: &[f64],
    yp: &[f64],
    names: &[String],
    max_hz: f64,
) -> Value {
    let started = cpu_s();
    let (a, b) = match spike.pencil_at(t, y, yp) {
        Ok(p) => p,
        Err(e) => return json!({"error":format!("{e:?}")}),
    };
    let n = y.len();
    let spec = match spectrum::decompose(n, &a, &b) {
        Ok(s) => s,
        Err(e) => return json!({"error":format!("{e:?}")}),
    };
    let mut low = Vec::new();
    for (m, mode) in spec.modes.iter().enumerate() {
        let magnitude_hz = mode.lambda.abs() / (2. * std::f64::consts::PI);
        if magnitude_hz > max_hz {
            continue;
        }
        let shape = &spec.shapes[m].right;
        let mut idx: Vec<usize> = (0..n).collect();
        idx.sort_by(|i, j| shape[*j].abs().total_cmp(&shape[*i].abs()));
        let top: Vec<Value> = idx
            .iter()
            .take(4)
            .map(|i| json!([names[*i], shape[*i].abs()]))
            .collect();
        low.push(json!({"magnitude_hz":magnitude_hz,"frequency_hz":mode.frequency_hz,"damping_ratio":mode.damping_ratio,"unstable":mode.unstable,"marginal":mode.marginal,"top":top}));
    }
    json!({"t":t,"finite_modes":spec.modes.len(),"infinite":spec.infinite.count,"unstable_resolved":spec.modes.iter().filter(|m|m.unstable && !m.marginal).count(),"marginal":spec.modes.iter().filter(|m|m.marginal).count(),"max_hz":max_hz,"at_or_below_max_hz":low,"cpu_s":cpu_s()-started})
}

/// Labelled what-if pencils (NOT a trajectory, NOT a state the model
/// reaches): each cumulative group of regions is put in the equilibrium mode
/// at saturated liquid filling its volume at its own pressure (`M = V rho_f`,
/// `U = M u_f`, no vapor), L1 holds updated, and the pencil decomposed. It
/// reads where two-phase compliance moves the lumped modes; the spike's
/// state is restored afterwards.
#[allow(clippy::too_many_arguments)]
fn what_if_spectra(
    spike: &mut Spike,
    t: f64,
    y: &[f64],
    yp: &[f64],
    names: &[String],
    regions: &[String],
    groups: &[Vec<String>],
    max_hz: f64,
) -> Value {
    let saved = (
        spike.modes.clone(),
        spike.held.clone(),
        spike.orientation.clone(),
    );
    let mut out = Vec::new();
    let mut ym = y.to_vec();
    let mut cumulative: Vec<String> = Vec::new();
    for group in groups {
        let sc = spike.net.scales().to_vec();
        let mut converted = Vec::new();
        for id in group {
            let Some(c) = regions.iter().position(|r| r == id) else {
                converted.push(json!({"region":id,"error":"unknown region"}));
                continue;
            };
            if spike.modes[c] == Mode::Equilibrium {
                continue;
            }
            let [b, m0, e0, m1, e1, _] = spike.slots(c);
            let p = ym[b] * sc[b];
            let sat = match spike.saturation(s(p)) {
                Ok(v) => v,
                Err(e) => {
                    converted.push(json!({"region":id,"error":format!("{e:?}")}));
                    continue;
                }
            };
            let mass = spike.net.volume(c) * sat[0].value;
            let before = (ym[m0] * sc[m0], ym[e0] * sc[e0]);
            ym[m0] = mass / sc[m0];
            ym[e0] = mass * sat[1].value / sc[e0];
            ym[m1] = 0.;
            ym[e1] = 0.;
            spike.modes[c] = Mode::Equilibrium;
            converted.push(json!({"region":id,"cell":c,"p_pa":p,"mass_before_kg":before.0,"mass_saturated_kg":mass,"energy_before_j":before.1}));
        }
        cumulative.extend(group.iter().cloned());
        let holds = spike.update_holds(t, &ym, yp, &[]);
        let compliance: Vec<Value> = (0..spike.modes.len())
            .filter(|c| spike.modes[*c] == Mode::Equilibrium)
            .map(|c| {
                spike
                    .compliance(c, &ym)
                    .unwrap_or_else(|e| json!({"cell":c,"error":format!("{e:?}")}))
            })
            .collect();
        let spectrum = spectrum_summary(spike, t, &ym, yp, names, max_hz);
        out.push(json!({"equilibrium_regions":cumulative.clone(),"converted":converted,
            "held_paths":spike.held.iter().enumerate().filter(|(_,h)|**h).map(|(j,_)|j).collect::<Vec<_>>(),
            "holds_error":holds.err().map(|e|format!("{e:?}")),"compliance":compliance,"spectrum":spectrum}));
    }
    spike.modes = saved.0;
    spike.held = saved.1;
    spike.orientation = saved.2;
    json!({"what_if":"NOT a trajectory: regions put at saturated liquid filling their volume at their own pressure, equilibrium mode, L1 holds updated; pencil only","t":t,"groups":out})
}

/// The five coordinates with the largest weighted local error of stock's
/// current history.
fn error_leaders(ida: &Ida<Handle>, names: &[String]) -> Value {
    let n = names.len();
    let (mut e, mut w) = (vec![0.; n], vec![0.; n]);
    match ida.error_diagnostics(&mut e, &mut w) {
        Ok(order) => {
            let mut idx: Vec<usize> = (0..n).collect();
            idx.sort_by(|i, j| (e[*j] * w[*j]).abs().total_cmp(&(e[*i] * w[*i]).abs()));
            json!({"order":order,"top":idx.iter().take(5).map(|i|json!([names[*i],(e[*i]*w[*i]).abs()])).collect::<Vec<_>>()})
        }
        Err(err) => json!({"error":err}),
    }
}

#[test]
#[ignore = "PHASE-P7 study, NOT EVIDENCE: needs a joined packet (LD01_PHASE_PACKET), the wiki, the seam-fixed IF97 build and stock IDA/KLU"]
fn phase_p7_post_birth_cost() {
    let packet_path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let out_path = std::env::var("LD01_PHASE_RECEIPT").ok();
    let settle_s: f64 = std::env::var("LD01_PHASE_SETTLE_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60.);
    let depressurize_cap_s = 150.;
    let env_f = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.parse::<f64>().unwrap_or_else(|_| panic!("{k}")))
    };
    let after_birth_s = env_f("LD01_P7_AFTER_BIRTH_S").unwrap_or(20.);
    let cpu_cap_s = 900.;
    let output_s = 0.1;
    let observe_s = env_f("LD01_P7_OBSERVE_S").unwrap_or(output_s);
    let observe_from_s = env_f("LD01_P7_OBSERVE_FROM_S").unwrap_or(f64::INFINITY);
    let observe_file = std::env::var("LD01_P7_OBSERVE_FILE").ok();
    let max_hz = env_f("LD01_P7_SPECTRUM_HZ").unwrap_or(60.);
    let factor = env_f("LD01_P7_REFERENCE_FACTOR").unwrap_or(1.);
    let dcj = env_f("LD01_P7_DCJ");
    let basis = match std::env::var("LD01_P7_CLASS").as_deref() {
        Ok("declared") | Err(_) => Basis::Declared,
        Ok("derived-p") => Basis::RelativePressure,
        Ok("derived-cell") => Basis::CellPressureClass,
        Ok(other) => panic!("LD01_P7_CLASS {other}"),
    };
    let what_if: Vec<Vec<String>> = std::env::var("LD01_P7_WHATIF")
        .ok()
        .map(|v| {
            v.split(';')
                .map(|g| g.split(',').map(|r| r.trim().to_string()).collect())
                .collect()
        })
        .unwrap_or_default();
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
    let endpoints: Vec<(usize, usize)> = packet
        .mechanics
        .faces
        .iter()
        .map(|f| (f.from, f.to))
        .collect();
    let region_ids: Vec<String> = raw["mechanics"]["regions"]
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
    let mut start_state = Value::Null;
    match std::env::var("LD01_P7_STATE") {
        Err(_) => {
            for index in &net.rotor_index {
                y[*index] = 0.;
            }
        }
        Ok(file) => {
            // The network part (leading block) of an exported joined state.
            let bytes = std::fs::read(&file).expect("state file");
            let state: Value = serde_json::from_slice(&bytes).expect("state json");
            assert_eq!(
                state["packet"].as_str(),
                Some(packet_path.as_str()),
                "state packet"
            );
            let bits = |k: &str| -> Vec<f64> {
                state[k]
                    .as_array()
                    .unwrap_or_else(|| panic!("state {k}"))
                    .iter()
                    .take(y.len())
                    .map(|b| f64::from_bits(u64::from_str_radix(b.as_str().unwrap(), 16).unwrap()))
                    .collect()
            };
            y = bits("y_bits");
            start_state = json!({"file":file,"t_s":state["t_s"],"network_coordinates":y.len(),"joined_coordinates":state["y"].as_array().map(|a|a.len()),
                "note":"network block of the joined state; the network runs alone (no walls, SG or rods coupled), as the spike"});
        }
    }
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    // Declared at the prepared (transit-free) state, as the S2 runs declare
    // theirs; rotor values do not enter the classes, so the spike's own
    // path is unchanged.
    let atol = net
        .absolute_tolerances(
            &prepared.y,
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
        rtol: f("relativeTolerance") * factor,
        atol: atol.iter().map(|a| a * factor).collect(),
        max_order: gates["maxOrder"].as_u64().unwrap() as usize,
        first_step_s: p2["eventRestartFirstStep_s"].as_f64().unwrap(),
        newton_coefficient: 0.33,
        nonnegative: net.nonnegative_stocks(),
        basis,
        dcj,
        max_step: env_f("LD01_P7_MAX_STEP_S"),
    };
    let spectrum_every = env_f("LD01_P7_SPECTRUM_EVERY_S");
    let track_hold: Option<Vec<usize>> = std::env::var("LD01_P7_TRACK_HOLD")
        .ok()
        .map(|v| v.split(',').map(|j| j.trim().parse().unwrap()).collect());
    let mut track: Vec<Value> = Vec::new();
    let face_index = |id: &str| {
        raw["mechanics"]["faces"]
            .as_array()
            .unwrap()
            .iter()
            .position(|f| f["id"].as_str() == Some(id))
            .unwrap_or_else(|| panic!("face {id}"))
    };
    let region_index = |id: &str| {
        region_ids
            .iter()
            .position(|r| r == id)
            .unwrap_or_else(|| panic!("region {id}"))
    };
    let taps = Taps {
        lower: region_index("LOWER"),
        upper: region_index("UPPER"),
        loop_faces: [face_index("RETURN.A->DOWN"), face_index("RETURN.B->DOWN")],
        housing: vec![region_index("HOUSING.NECK"), region_index("HOUSING.MAIN")],
    };
    let mut observed = String::new();
    let regular = net.pzr.cell;
    let compile_started = cpu_s();
    let structure = net.sparse_jacobian().expect("structure");
    let compile_s = cpu_s() - compile_started;
    let csc = structure.pattern.to_i64().expect("csc");
    let nnz = structure.pattern.nonzeros();
    let colors = structure.coloring.count();
    // Presence-keyed structure cache (design §5): on the S1 network every key
    // maps to the same structural pattern; the cache measures the plumbing.
    let mut cache: BTreeMap<Vec<bool>, (usize, usize)> = BTreeMap::new();
    cache.insert(vec![false; regular], (nnz, colors));
    let spike = Rc::new(RefCell::new(Spike {
        net,
        relief: Relief {
            lift: 0.,
            back_pressure_pa,
        },
        modes: vec![Mode::Liquid; regular],
        held: vec![false; endpoints.len()],
        orientation: vec![1.; endpoints.len()],
        endpoints: endpoints.clone(),
        structure,
        csc,
        roots: Vec::new(),
        cost: Cost::default(),
        class_log: Vec::new(),
    }));
    let names = labels(&spike.borrow(), &region_ids);
    let watch: Vec<usize> = [
        "HOUSING.NECK",
        "HOUSING.MAIN",
        "UPPER",
        "HOT.A.UPSTREAM",
        "HOT.B",
    ]
    .iter()
    .filter_map(|id| region_ids.iter().position(|r| r == id))
    .collect();
    let mut events: Vec<Value> = Vec::new();
    let mut samples: Vec<Value> = Vec::new();
    let mut segments: Vec<Value> = Vec::new();
    let mut failure: Option<String> = None;
    let mut ending = "time cap".to_string();
    // t = 0: the prepared state, RCPs from rest, relief on its seat.
    let mut ids = spike.borrow().ids(&prepared.differential);
    let weights = error_weights(&y, config.rtol, &config.atol);
    let start_cpu = cpu_s();
    let (mut yp, pair) = consistent_start(
        &mut *spike.borrow_mut(),
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        2,
    )
    .expect("consistent start at t = 0");
    events.push(json!({"t":0.,"kind":"prepared start","consistent_start_cpu_s":cpu_s()-start_cpu,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value,"projection":pair.projection.as_ref().map(|p|p.correction_wrms)}));
    let mut start_spectra = Value::Null;
    if std::env::var("LD01_P7_START_SPECTRUM").is_ok() {
        let mut sp = spike.borrow_mut();
        let base = spectrum_summary(&mut sp, 0., &y, &yp, &names, max_hz);
        let compliance: Vec<Value> = taps
            .housing
            .iter()
            .chain(&watch)
            .map(|c| {
                sp.compliance(*c, &y)
                    .unwrap_or_else(|e| json!({"cell":c,"error":format!("{e:?}")}))
            })
            .collect();
        let what = (!what_if.is_empty())
            .then(|| what_if_spectra(&mut sp, 0., &y, &yp, &names, &region_ids, &what_if, max_hz));
        start_spectra = json!({"liquid":base,"compliance":compliance,"what_if":what});
    }
    let mut t = 0.;
    let mut phase = 0; // 0 settle, 1 depressurize, 2 after birth
    let mut phase_end = settle_s;
    let mut first_birth: Option<f64> = None;
    let mut ida =
        new_segment(&spike, &config, t, &y, &yp, &ids, phase_end, false).expect("first segment");
    let mut segment_start = (t, cpu_s());
    let grid = |t: f64| {
        if t + 1e-12 >= observe_from_s {
            observe_s
        } else {
            output_s
        }
    };
    let mut next_output: f64 = next_grid(0., grid(0.));
    let mut post_event_marks: Vec<(f64, usize)> = Vec::new();
    loop {
        if cpu_s() - started > cpu_cap_s {
            ending = format!("CPU cap {cpu_cap_s} s");
            break;
        }
        let target = next_output.min(phase_end);
        let advanced = ida.advance(target, &mut y, &mut yp);
        let mut pending: Option<(Vec<(RootKind, i32)>, &str)> = None;
        match advanced {
            Err(e) => {
                failure = Some(format!("t≈{t}: {e}"));
                segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida),"failed":true}));
                break;
            }
            Ok(Advance::Reached(reached)) => {
                t = reached;
                if (t - next_output).abs() < 1e-9 || t >= next_output {
                    let mut sp = spike.borrow_mut();
                    let on_tenth = ((t / output_s).round() * output_s - t).abs() < 1e-9;
                    if on_tenth {
                        let mut v = sample(&mut sp, t, &y, &yp, &watch);
                        v["stats"] = stats_json(&ida);
                        samples.push(v);
                    }
                    if let (Some(every), Some(birth)) = (spectrum_every, first_birth) {
                        if t > birth && ((t / every).round() * every - t).abs() < 1e-9 {
                            let spec = spectrum_summary(&mut sp, t, &y, &yp, &names, 12.);
                            let e_cells: Vec<usize> = (0..sp.modes.len())
                                .filter(|c| sp.modes[*c] == Mode::Equilibrium)
                                .collect();
                            let compliance: Vec<Value> = e_cells
                                .iter()
                                .map(|c| {
                                    sp.compliance(*c, &y).unwrap_or_else(
                                        |e| json!({"cell":c,"error":format!("{e:?}")}),
                                    )
                                })
                                .collect();
                            // Diagnostic what-if (NOT a trajectory): the same
                            // pencil with the named vapor paths held (Pi_g = 0).
                            let held_what_if = track_hold.as_ref().map(|faces| {
                                let saved = sp.held.clone();
                                for j in faces {
                                    sp.held[*j] = true;
                                }
                                let v = spectrum_summary(&mut sp, t, &y, &yp, &names, 12.);
                                sp.held = saved;
                                json!({"held_faces":faces,"spectrum":v})
                            });
                            track.push(json!({"t":t,"compliance":compliance,"spectrum":spec,"what_if_held":held_what_if}));
                        }
                    }
                    if observe_file.is_some() && t + 1e-12 >= observe_from_s {
                        observed.push_str(&credited(&mut sp, t, &y, &yp, &taps).to_string());
                        observed.push('\n');
                    }
                    next_output = next_grid(t, grid(t));
                }
                // Marks after an event: steps at +0.1 s and +1 s.
                for (mark, event) in post_event_marks.iter() {
                    if (t - mark).abs() < 1e-9 {
                        events[*event]["after"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"t":t,"stats":stats_json(&ida),"error_leaders":error_leaders(&ida,&names)}));
                    }
                }
                // A held path whose drive left zero toward its vapor end at
                // the restart is not reported by stock IDA's rootfinding
                // (a component zero at the segment start is deactivated):
                // release it at this output, flagged as not located.
                {
                    let mut sp = spike.borrow_mut();
                    if sp.held.iter().any(|h| *h) && sp.rows(t, &y, &yp, None, 0.).is_ok() {
                        let missed: Vec<(RootKind, i32)> = (0..sp.held.len())
                            .filter(|j| {
                                sp.held[*j]
                                    && sp.orientation[*j] * sp.net.face_drive(*j, 1).value > 0.
                            })
                            .map(|j| (RootKind::Release(j), 1))
                            .collect();
                        if !missed.is_empty() {
                            pending = Some((
                                missed,
                                "release found at an output (zero-start drive), not root-located",
                            ));
                        }
                    }
                }
                if pending.is_some() {
                    segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida),"ended_by":"output check"}));
                } else if t >= phase_end - 1e-12 {
                    segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida)}));
                    match phase {
                        0 => {
                            // C4's initiator: the relief stuck open at full lift.
                            phase = 1;
                            phase_end = t + depressurize_cap_s;
                            let before = cpu_s();
                            spike.borrow_mut().relief.lift = 1.;
                            let w = error_weights(&y, config.rtol, &config.atol);
                            match consistent_start(
                                &mut *spike.borrow_mut(),
                                t,
                                &mut y,
                                &ids,
                                &w,
                                1e-12,
                                2,
                            ) {
                                Ok((rates, pair)) => {
                                    yp = rates;
                                    events.push(json!({"t":t,"kind":"relief stuck open at full lift","consistent_start_cpu_s":cpu_s()-before,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value,"projection":pair.projection.as_ref().map(|p|p.correction_wrms),"after":[]}));
                                    post_event_marks.push((t + 0.1, events.len() - 1));
                                    post_event_marks.push((t + 1., events.len() - 1));
                                }
                                Err(e) => {
                                    failure = Some(format!("relief restart at {t}: {e:?}"));
                                    break;
                                }
                            }
                            drop(ida);
                            ida = new_segment(&spike, &config, t, &y, &yp, &ids, phase_end, true)
                                .expect("relief segment");
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
                segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats_json(&ida),"ended_by_root":true}));
                let roots = spike.borrow().roots.clone();
                let fired: Vec<(RootKind, i32)> = roots
                    .iter()
                    .zip(&directions)
                    .filter(|(_, d)| **d != 0)
                    .map(|(r, d)| (*r, *d))
                    .collect();
                pending = Some((fired, "located root"));
            }
        }
        if let Some((fired, how)) = pending {
            let located_cpu = cpu_s();
            let before_totals = spike.borrow().totals(&y);
            let mut description = Vec::new();
            let mut unsupported = None;
            let mut dryout: Option<String> = None;
            let births = fired
                .iter()
                .any(|(r, d)| matches!(r, RootKind::Birth(_)) && *d > 0);
            let pre_spectrum = births
                .then(|| spectrum_summary(&mut spike.borrow_mut(), t, &y, &yp, &names, max_hz));
            let transaction_started = cpu_s();
            {
                let mut sp = spike.borrow_mut();
                let sc = sp.net.scales().to_vec();
                for (root, direction) in &fired {
                    match root {
                        RootKind::Birth(c) if *direction > 0 => {
                            let [_, m0, e0, m1, e1, _] = sp.slots(*c);
                            let (mg, ug) = (y[m1], y[e1]);
                            // Totals into the differential slots; at a
                            // birth M_g = U_g = 0 and nothing moves.
                            y[m0] += y[m1] * sc[m1] / sc[m0];
                            y[e0] += y[e1] * sc[e1] / sc[e0];
                            sp.modes[*c] = Mode::Equilibrium;
                            description.push(json!({"birth":c,"region":region_ids[*c],"vapor_slot_before":[mg,ug]}));
                            if first_birth.is_none() {
                                first_birth = Some(t);
                            }
                        }
                        RootKind::Exhaustion(c) if *direction < 0 => {
                            let [_, m0, e0, m1, e1, _] = sp.slots(*c);
                            // The last vapor joins the liquid exactly.
                            let (mg, ug) = (y[m1], y[e1]);
                            y[m1] = 0.;
                            y[e1] = 0.;
                            let _ = (m0, e0);
                            sp.modes[*c] = Mode::Liquid;
                            description.push(json!({"exhaustion":c,"region":region_ids[*c],"vapor_slot_at_root":[mg,ug]}));
                        }
                        RootKind::Release(j) => {
                            description.push(json!({"release":j,"direction":direction}));
                        }
                        RootKind::Dryout(c) if *direction < 0 => {
                            description.push(json!({"dryout":c,"region":region_ids[*c]}));
                            dryout = Some(format!(
                                "dryout of equilibrium cell {c} ({}): mode G is S6 scope",
                                region_ids[*c]
                            ));
                        }
                        other => {
                            description.push(
                                json!({"ignored":format!("{other:?}"),"direction":direction}),
                            );
                        }
                    }
                }
            }
            let transaction_s = cpu_s() - transaction_started;
            if let Some(d) = dryout {
                events.push(
                    json!({"t":t,"kind":"root","how":how,"fired":description,"unsupported":d}),
                );
                ending = d;
                break;
            }
            // Structure for the new presence key (cache).
            let key: Vec<bool> = {
                let sp = spike.borrow();
                (0..regular).map(|c| sp.holds_vapor(c, &y)).collect()
            };
            let cache_started = cpu_s();
            let hit = cache.contains_key(&key);
            if !hit {
                let sp = spike.borrow();
                let st = sp.net.sparse_jacobian().expect("structure");
                cache.insert(key.clone(), (st.pattern.nonzeros(), st.coloring.count()));
            }
            let structure_s = cpu_s() - cache_started;
            // L1 holds after the transaction.
            let holds_started = cpu_s();
            let released: Vec<usize> = fired
                .iter()
                .filter_map(|(r, d)| match r {
                    RootKind::Release(j) if *d > 0 => Some(*j),
                    _ => None,
                })
                .collect();
            let changed = spike.borrow_mut().update_holds(t, &y, &yp, &released);
            let holds_s = cpu_s() - holds_started;
            let changed = match changed {
                Ok(c) => c,
                Err(e) => {
                    failure = Some(format!("L1 holds at {t}: {e:?}"));
                    break;
                }
            };
            // A released path carrying vapor into a liquid-only cell is
            // the declared end (design §7).
            {
                let sp = spike.borrow();
                for ch in &changed {
                    if ch["held"] == json!(false) {
                        let j = ch["face"].as_u64().unwrap() as usize;
                        let (from, to) = sp.endpoints[j];
                        let drive = ch["drive_pa"].as_f64().unwrap();
                        let receiver = if drive > 0. { to } else { from };
                        if !sp.holds_vapor(receiver, &y) {
                            unsupported = Some(format!(
                                "vapor path {j} released into liquid-only cell {receiver} ({})",
                                region_ids.get(receiver).cloned().unwrap_or("PZR".into())
                            ));
                        }
                    }
                }
            }
            ids = spike.borrow().ids(&prepared.differential);
            let restart_started = cpu_s();
            let w = error_weights(&y, config.rtol, &config.atol);
            let start = consistent_start(&mut *spike.borrow_mut(), t, &mut y, &ids, &w, 1e-12, 2);
            let start_s = cpu_s() - restart_started;
            let after_totals = spike.borrow().totals(&y);
            let mut event = json!({"t":t,"kind":"root","how":how,"fired":description,"located_after_segment":segments.last(),"transaction_cpu_s":transaction_s,"structure":{"key_vapor_cells":key.iter().enumerate().filter(|(_,v)|**v).map(|(c,_)|c).collect::<Vec<_>>(),"cache_hit":hit,"compile_cpu_s":structure_s},"l1_holds_changed":changed,"l1_update_cpu_s":holds_s,"conservation_across_transaction":compare_totals(&before_totals,&after_totals),"after":[]});
            match start {
                Ok((rates, pair)) => {
                    yp = rates;
                    event["consistent_start"] = json!({"cpu_s":start_s,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value,"projection_wrms":pair.projection.as_ref().map(|p|p.correction_wrms),"projection_passes":pair.projection.as_ref().map(|p|p.passes)});
                    if births {
                        event["spectrum_before"] = pre_spectrum.clone().unwrap_or(Value::Null);
                        event["spectrum_after"] =
                            spectrum_summary(&mut spike.borrow_mut(), t, &y, &yp, &names, max_hz);
                        let mut sp = spike.borrow_mut();
                        let e_cells: Vec<usize> = (0..sp.modes.len())
                            .filter(|c| sp.modes[*c] == Mode::Equilibrium)
                            .collect();
                        event["compliance_after"] = json!(
                            e_cells
                                .iter()
                                .map(|c| sp
                                    .compliance(*c, &y)
                                    .unwrap_or_else(|e| json!({"cell":c,"error":format!("{e:?}")})))
                                .collect::<Vec<_>>()
                        );
                        if !what_if.is_empty() && first_birth == Some(t) {
                            event["what_if_after"] = what_if_spectra(
                                &mut sp,
                                t,
                                &y,
                                &yp,
                                &names,
                                &region_ids,
                                &what_if,
                                max_hz,
                            );
                        }
                    }
                }
                Err(e) => {
                    event["consistent_start"] = json!({"cpu_s":start_s,"refused":format!("{e:?}")});
                    events.push(event);
                    failure = Some(format!("consistent start at {t} refused"));
                    break;
                }
            }
            let construct_started = cpu_s();
            if first_birth == Some(t) && phase == 1 {
                phase = 2;
                phase_end = t + after_birth_s;
            }
            drop(ida);
            ida = match new_segment(&spike, &config, t, &y, &yp, &ids, phase_end, true) {
                Ok(i) => i,
                Err(e) => {
                    failure = Some(format!("segment at {t}: {e}"));
                    events.push(event);
                    break;
                }
            };
            event["ida_construct_cpu_s"] = json!(cpu_s() - construct_started);
            {
                let sp = spike.borrow();
                let sc = sp.net.scales();
                let e_cells: Vec<Value> = (0..sp.modes.len())
                        .filter(|c| sp.modes[*c] == Mode::Equilibrium)
                        .map(|c| {
                            let [b, m0, _, m1, ..] = sp.slots(c);
                            json!({"cell":c,"p_pa":y[b]*sc[b],"mass_kg":y[m0]*sc[m0],"vapor_kg":y[m1]*sc[m1],"vapor_rate_kg_s":yp[m1]*sc[m1]})
                        })
                        .collect();
                event["equilibrium_cells_after_start"] = json!(e_cells);
            }
            event["event_total_cpu_s"] = json!(cpu_s() - located_cpu);
            events.push(event);
            post_event_marks.push((t + 0.1, events.len() - 1));
            post_event_marks.push((t + 1., events.len() - 1));
            segment_start = (t, cpu_s());
            // Outputs and marks must stay on the grid after the root.
            next_output = next_grid(t, grid(t));
            for (mark, _) in post_event_marks.iter_mut() {
                if *mark > t {
                    *mark = (*mark / output_s).round() * output_s;
                }
            }
            if let Some(u) = unsupported {
                ending = u;
                break;
            }
        }
    }
    let cost = spike.borrow().cost;
    let receipt = json!({
        "kind":"ld01-phase-p7-post-birth-cost-NOT-EVIDENCE",
        "study":{"class":format!("{:?}",config.basis),"reference_factor":factor,"dcj":dcj,"observe_s":observe_s,"observe_from_s":if observe_from_s.is_finite() {json!(observe_from_s)} else {Value::Null},"max_hz":max_hz,"what_if":what_if,"start_state":start_state},
        "class_log":spike.borrow().class_log.clone(),
        "spectrum_track":track,
        "max_step_s":config.max_step,
        "start_spectra":start_spectra,
        "provenance":std::env::var("LD01_PHASE_PROVENANCE").ok().and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "scope":"PHASE-P7 study copy of the PHASE spike: S1 network (G6 relief hook) with C4's stuck-open relief; cell modes L/E (both-active equilibrium, totals differential), L1 holds by root, exact consistent restarts, new stock IDA handle per segment; colored Jacobian on the S1 structural pattern; study variants in `study`; NOT a selected law, NOT evidence",
        "packet":packet_path,
        "wiki_root":wiki,
        "settle_s":settle_s,
        "config":{"rtol":config.rtol,"dcj":config.dcj,"max_order":config.max_order,"first_step_after_event_s":config.first_step_s,"newton_coefficient":config.newton_coefficient,"relief_lift":1.0,"relief_back_pressure_pa":back_pressure_pa,"output_s":output_s},
        "structure":{"nnz":nnz,"colors":colors,"compile_cpu_s":compile_s,"cache_keys":cache.len()},
        "regions":region_ids,
        "watch":watch,
        "events":events,
        "segments":segments,
        "first_birth_s":first_birth,
        "ending":ending,
        "failure":failure,
        "cost":{"residuals":cost.residuals,"residual_cpu_s":cost.residual_s,"jacobians":cost.jacobians,"jacobian_cpu_s":cost.jacobian_s,"root_calls":cost.root_calls,"root_cpu_s":cost.root_s},
        "cpu_s":cpu_s()-started,
        "wall_s":wall.elapsed().as_secs_f64(),
        "load_average":{"start":load_start,"end":load_average()},
        "samples":samples,
    });
    if let Some(file) = &observe_file {
        assert!(
            !std::path::Path::new(file).exists(),
            "observations are never overwritten: {file}"
        );
        std::fs::write(file, &observed).expect("observations");
    }
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
        json!({"first_birth_s":receipt["first_birth_s"],"ending":receipt["ending"],"failure":receipt["failure"],"events":receipt["events"].as_array().map(|e|e.len()),"cpu_s":receipt["cpu_s"]})
    );
}

/// The S2-07 settled state's pencils as SPECTRUM dumped them for Z6
/// (`LD01_S2_SPECTRUM_DUMP`: `<name>.json` labels, `<name>.{a,b}.f64`
/// column-major): every finite mode at or below `LD01_P7_SPECTRUM_HZ` with
/// its five largest right-vector coordinates, to place the housing family
/// in liquid before any birth.
#[test]
#[ignore = "PHASE-P7 study, NOT EVIDENCE: reads SPECTRUM's Z6 pencil dumps (LD01_P7_DUMP_DIR, LD01_P7_DUMP_NAMES)"]
fn phase_p7_settled_pencil_modes() {
    let dir = std::env::var("LD01_P7_DUMP_DIR").expect("LD01_P7_DUMP_DIR");
    let names = std::env::var("LD01_P7_DUMP_NAMES").unwrap_or("network-alone-held".into());
    let max_hz: f64 = std::env::var("LD01_P7_SPECTRUM_HZ")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60.);
    let mut out = Vec::new();
    for name in names.split(',') {
        let base = std::path::Path::new(&dir).join(name);
        let meta: Value =
            serde_json::from_slice(&std::fs::read(base.with_extension("json")).unwrap()).unwrap();
        let n = meta["n"].as_u64().unwrap() as usize;
        let labels: Vec<String> = serde_json::from_value(meta["labels"].clone()).unwrap();
        let read = |ext: &str| -> Vec<f64> {
            std::fs::read(base.with_extension(ext))
                .unwrap()
                .chunks_exact(8)
                .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
                .collect()
        };
        let (a, b) = (read("a.f64"), read("b.f64"));
        assert_eq!(a.len(), n * n);
        let started = cpu_s();
        let spec = spectrum::decompose(n, &a, &b).expect("decompose");
        let mut modes = Vec::new();
        for (m, mode) in spec.modes.iter().enumerate() {
            let magnitude_hz = mode.lambda.abs() / (2. * std::f64::consts::PI);
            if magnitude_hz > max_hz || magnitude_hz < 1e-6 {
                continue;
            }
            let shape = &spec.shapes[m].right;
            let mut idx: Vec<usize> = (0..n).collect();
            idx.sort_by(|i, j| shape[*j].abs().total_cmp(&shape[*i].abs()));
            let top: Vec<Value> = idx
                .iter()
                .take(5)
                .map(|i| json!([labels[*i], shape[*i].abs()]))
                .collect();
            modes.push(json!({"magnitude_hz":magnitude_hz,"frequency_hz":mode.frequency_hz,"damping_ratio":mode.damping_ratio,"re":mode.lambda.re,"unstable":mode.unstable,"marginal":mode.marginal,"top":top}));
        }
        out.push(json!({"pencil":name,"n":n,"finite":spec.modes.len(),"infinite":spec.infinite.count,"cpu_s":cpu_s()-started,"max_hz":max_hz,"modes":modes}));
    }
    let receipt = json!({"kind":"ld01-phase-p7-settled-pencil-modes-NOT-EVIDENCE","dump_dir":dir,"pencils":out});
    let text = serde_json::to_string_pretty(&receipt).unwrap();
    if let Ok(path) = std::env::var("LD01_P7_DUMP_RECEIPT") {
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipts are never overwritten: {path}"
        );
        std::fs::write(&path, &text).unwrap();
    }
    println!(
        "{}",
        json!({"pencils":out.iter().map(|p|json!({"pencil":p["pencil"],"modes":p["modes"].as_array().map(|m|m.len())})).collect::<Vec<_>>()})
    );
}

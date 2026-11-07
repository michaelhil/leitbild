//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/bulk-condensation-study.md#stable-phase-birth-and-disappearance
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#prospective-accuracy-contract
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-treatment-of-uncredited-lumped-modes
//! S3 phase branch, mode build (PHASE-P7; lead S3-D-P1, S3-D-P6, S3-D3,
//! S3-D-P8). NOT EVIDENCE until the S3 declaration exists.
//!
//! - `phase_modes_equilibrium_cell`: one cell put at a flashed state in the
//!   equilibrium mode. Its EOS, split and vapor-energy rows vanish there,
//!   every seeded direction of its five coordinates matches a central
//!   difference of the values, its vapor slots are algebraic and
//!   unconstrained, S3-D3 gives the derived class, and the exhaustion
//!   transaction keeps its totals.
//! - `phase_modes_relief_case`: C4's stuck-open relief on the S1 network
//!   (G6's relief hook) through the kernel's modes, with S3-D3 and the
//!   gas-path loss. L1 is a labelled stand-in until PHASE-L1's
//!   `unilateral.rs` lands: a vapor path with vapor at one end is held
//!   (`Pi = 0`) unless its drive draws from that end, and is released by
//!   root. It reports births, exact conservation across every transaction,
//!   cost (counts, thread CPU, the projection at today's and JAC's per-count
//!   costs) and the **post-birth spectrum test**: at declared instants after
//!   the first birth the pencil must be index 1 (infinite eigenvalues equal
//!   the algebraic coordinates). Every resolved growing mode is reported with
//!   its growth rate; judging growth is a declared-threshold question for the
//!   lead and owner (decision 0013), so the test records it and does not hide
//!   it.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        self, CellMode, ConsistentSystem, Coupling, Fluid, Network, PZR_MASS, PZR_TRACER,
        Properties, Receipts, RotorState, SparseJacobian, ToleranceClasses, consistent_start,
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

/// The declared inputs every test reads: packet, gates, P2 cases.
struct Inputs {
    raw: Value,
    packet: Packet,
    gates: Value,
    p2: Value,
    regions: Vec<String>,
}
fn inputs() -> Inputs {
    let packet_path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let wiki = std::env::var("LD01_WIKI_ROOT").expect("LD01_WIKI_ROOT");
    let pages = format!("{wiki}/world/packs/process-plant/reference-designs/ld-01");
    let raw: Value = serde_json::from_slice(&std::fs::read(&packet_path).unwrap()).unwrap();
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let regions = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    Inputs {
        gates: strict_block(
            &format!("{pages}/model/build-readiness.md"),
            "ld01-s1-gates",
        ),
        p2: strict_block(
            &format!("{pages}/systems/primary-coolant/pressurizer-thermal-state.md"),
            "ld01-p2-cases",
        ),
        raw,
        packet,
        regions,
    }
}
fn prepared(i: &Inputs) -> (Network<If97>, network::Prepared) {
    let point = OperatingPoint::from(&i.packet.preparation.operating_point);
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
    let (net, prepared, _) =
        prepare::prepare(&i.packet, If97, &point, &rotors, &settings).expect("preparation");
    (net, prepared)
}
fn classes(gates: &Value) -> ToleranceClasses {
    let f = |k: &str| gates[k].as_f64().unwrap_or_else(|| panic!("gate {k}"));
    ToleranceClasses {
        relative: f("relativeTolerance"),
        stock_scaled: f("stockScaledAbsolute"),
        tracer_scaled: f("tracerScaledAbsolute"),
        rotor_scaled: f("rotorScaledAbsolute"),
        volume_flow_m3_s: f("volumeFlowAbsolute_m3_s"),
    }
}
fn slots(net: &Network<If97>, c: usize) -> [usize; 6] {
    let l = net.cell_layout[c];
    [
        l.base,
        l.mass[0],
        l.energy[0],
        l.mass[1],
        l.energy[1],
        l.boron,
    ]
}

#[test]
#[ignore = "PHASE-P7 mode build, NOT EVIDENCE: needs a joined packet (LD01_PHASE_PACKET), the wiki, the seam-fixed IF97 build"]
fn phase_modes_equilibrium_cell() {
    let i = inputs();
    let (mut net, prepared) = prepared(&i);
    let mut y = prepared.y.clone();
    let yp = vec![0.; y.len()];
    let neck = i.regions.iter().position(|r| r == "HOUSING.NECK").unwrap();
    let [b, m0, e0, m1, e1, _] = slots(&net, neck);
    let sc = net.scales().to_vec();
    assert_eq!(net.cell_modes()[neck], CellMode::Liquid);
    // A flashed state at the cell's own pressure: 2 kg of saturated vapor,
    // saturated liquid filling the rest of the volume.
    let p = y[b] * sc[b];
    let sat = If97.saturation_caloric(s(p)).expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let v = net.volume(neck);
    let mg = 2.;
    let ml = (v - mg / rg) * rf;
    // Birth refuses vapor slots; it is taken at zero vapor, then the
    // flashed state is written into the equilibrium slots.
    y[m1] = 0.;
    y[e1] = 0.;
    let birth = net.birth(neck, &mut y).expect("birth");
    assert_eq!(net.cell_modes()[neck], CellMode::Equilibrium);
    y[m0] = (ml + mg) / sc[m0];
    y[e0] = (ml * uf + mg * ug) / sc[e0];
    y[m1] = mg / sc[m1];
    y[e1] = mg * ug / sc[e1];
    let mut relief = Relief {
        lift: 0.,
        back_pressure_pa: i.raw["pzrMetal"]["reliefBackPressure_Pa"].as_f64().unwrap(),
    };
    net.evaluate_coupled(0., &y, &yp, None, 0., None, Some(&mut relief))
        .expect("evaluation");
    let rows: Vec<f64> = net.rows().iter().map(|r| r.value).collect();
    let consistent = [rows[b], rows[m1], rows[e1]];
    assert!(
        consistent.iter().all(|r| r.abs() < 1e-12),
        "EOS, split and vapor-energy rows at the flashed state: {consistent:?}"
    );
    // Directions of the five cell coordinates against central differences.
    let mut worst: Vec<Value> = Vec::new();
    for (name, j) in [("p", b), ("M", m0), ("U", e0), ("M_g", m1), ("U_g", e1)] {
        let mut seed = vec![0.; y.len()];
        seed[j] = 1.;
        net.evaluate_coupled(0., &y, &yp, Some(&seed), 0., None, Some(&mut relief))
            .expect("seeded evaluation");
        let direction: Vec<f64> = net.rows().iter().map(|r| r.direction).collect();
        let h = 1e-7 * y[j].abs().max(1e-3);
        let mut at = |delta: f64| -> Vec<f64> {
            let mut z = y.clone();
            z[j] += delta;
            net.evaluate_coupled(0., &z, &yp, None, 0., None, Some(&mut relief))
                .expect("difference evaluation");
            net.rows().iter().map(|r| r.value).collect()
        };
        let (plus, minus) = (at(h), at(-h));
        let norm = direction
            .iter()
            .fold(0_f64, |m, d| m.max(d.abs()))
            .max(1e-300);
        let (mut row, mut error) = (0, 0_f64);
        for k in 0..direction.len() {
            let fd = (plus[k] - minus[k]) / (2. * h);
            let e = (fd - direction[k]).abs() / norm;
            if e > error {
                (row, error) = (k, e);
            }
        }
        assert!(
            error < 1e-5,
            "column {name}: direction vs central difference {error:e} at row {row}"
        );
        worst.push(json!({"column":name,"largest_relative_error":error,"row":row}));
    }
    // Vapor slots algebraic and unconstrained; S3-D3's derived class.
    let ids = net.differential(&prepared.differential);
    assert_eq!((ids[m1], ids[e1]), (0., 0.));
    assert_eq!((ids[m0], ids[e0]), (1., 1.));
    assert!(!net.nonnegative_stocks().contains(&m1));
    let rtol = classes(&i.gates).relative;
    let mut atol = vec![1e-8; y.len()];
    let records = net
        .equilibrium_tolerances(&y, rtol, &mut atol)
        .expect("derived class");
    assert_eq!(records.len(), 1);
    let dmg_dp = records[0]["dmg_dp_kg_per_pa"].as_f64().unwrap();
    assert!(dmg_dp < 0., "flash: vapor grows as pressure falls");
    let expected = rtol * (y[b] * sc[b]).abs() * dmg_dp.abs();
    assert!((atol[m1] * sc[m1] - expected).abs() <= 1e-14 * expected);
    // Exhaustion: the vapor slots are zeroed, the totals stay.
    let (m_total, u_total) = (y[m0], y[e0]);
    let exhaustion = net.exhaustion(neck, &mut y).expect("exhaustion");
    assert_eq!((y[m0], y[e0], y[m1], y[e1]), (m_total, u_total, 0., 0.));
    assert_eq!(net.cell_modes()[neck], CellMode::Liquid);
    println!(
        "{}",
        json!({"birth":birth,"rows":consistent,"directions":worst,"derived_class":records,"exhaustion":exhaustion})
    );
}

/// KERN (S3 batch): the block replay composes an equilibrium (mode-E)
/// cell and the gas phase's passive section loss as the residual does: at
/// the flashed NECK state its Jacobian equals the colored assembly's entry
/// by entry (the same structural pattern), with the base pass bitwise the
/// residual's, with L1 active. Two stage coefficients, at rest and with
/// every impulse moving (so the vapor paths' gas profile and drive are
/// exercised).
#[test]
#[ignore = "S3 kernel check, NOT EVIDENCE: needs a joined packet (LD01_PHASE_PACKET), the wiki, the seam-fixed IF97 build"]
fn phase_modes_block_replay_matches_the_colored_assembly() {
    let i = inputs();
    let (mut net, prepared) = prepared(&i);
    let mut y = prepared.y.clone();
    let neck = i.regions.iter().position(|r| r == "HOUSING.NECK").unwrap();
    let [b, m0, e0, m1, e1, _] = slots(&net, neck);
    let sc = net.scales().to_vec();
    let p = y[b] * sc[b];
    let sat = If97.saturation_caloric(s(p)).expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let v = net.volume(neck);
    let mg = 2.;
    let ml = (v - mg / rg) * rf;
    y[m1] = 0.;
    y[e1] = 0.;
    net.birth(neck, &mut y).expect("birth");
    y[m0] = (ml + mg) / sc[m0];
    y[e0] = (ml * uf + mg * ug) / sc[e0];
    y[m1] = mg / sc[m1];
    y[e1] = mg * ug / sc[e1];
    let yp = vec![0.; y.len()];
    // L1 active, as every S3 run (decision 0014): a vapor path drawing
    // from an end without vapor transports nothing, so no unsupported
    // exact-zero onset is evaluated.
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation at the flashed state");
    let presence = net.stock_presence(&y);
    let activation = net.activate_unilateral(&presence).expect("L1");
    let colored = net.sparse_jacobian().expect("colored structure");
    let blocks = net.block_jacobian().expect("block structure");
    assert_eq!(blocks.pattern, colored.pattern, "one pattern for both");
    let pattern = &blocks.pattern;
    // At rest, then with every phase path's impulse moving.
    let impulses: Vec<usize> = (0..net.face_layout.len())
        .map(|li| net.face_layout[li].index)
        .collect();
    let mut moving = y.clone();
    for (k, &index) in impulses.iter().enumerate() {
        moving[index] = if moving[index] != 0. {
            moving[index] * 1.01
        } else {
            1e-3 * if k % 2 == 0 { 1. } else { -1. } / sc[index]
        };
    }
    let mut report = Vec::new();
    for (name, state, cj) in [("rest", &y, 20.), ("moving", &moving, 350.)] {
        let mut cv = vec![0.; pattern.nonzeros()];
        let mut bv = vec![0.; pattern.nonzeros()];
        net.jacobian_colored(0., cj, state, &yp, &colored, &mut cv)
            .expect("colored assembly");
        net.jacobian_blocks(0., cj, state, &yp, &blocks, &mut bv)
            .expect("block assembly (base pass bitwise the residual's)");
        let (mut worst, mut at, mut bitwise) = (0_f64, json!(null), 0usize);
        for j in 0..pattern.columns() {
            let range = pattern.pointers()[j]..pattern.pointers()[j + 1];
            let scale = range
                .clone()
                .map(|q| cv[q].abs().max(bv[q].abs()))
                .fold(0., f64::max);
            for q in range {
                if cv[q] == bv[q] {
                    bitwise += 1;
                    continue;
                }
                let e = (cv[q] - bv[q]).abs() / scale;
                if e > worst {
                    worst = e;
                    at = json!({"row": pattern.indices()[q], "column": j,
                        "blocks": bv[q], "colored": cv[q]});
                }
            }
        }
        let neck_columns = [b, m0, e0, m1, e1];
        report.push(
            json!({"state": name, "cj": cj, "column_relative_max": worst,
            "worst": at, "bitwise": bitwise, "entries": pattern.nonzeros(),
            "neck_columns": neck_columns}),
        );
        assert!(
            worst < 1e-10,
            "{name}: block against colored {worst:e} at {at}"
        );
    }
    println!(
        "{}",
        json!({"block_vs_colored": report, "l1_locked": net.unilateral().map(|l| l.locked()),
            "l1_activation_changes": activation.changes.len()})
    );
}

/// R4-MOUTH-INERTIA: with SURGE flashed, bubbles in zone A and L1 active, the
/// surge mouth's vapor path is free and its inertia reads the port view, so
/// the PZR columns reach its `Q`. The block replay against the colored
/// assembly, at rest and with every impulse moving, and the bound on `w`.
#[test]
#[ignore = "S3 kernel check, NOT EVIDENCE: needs a joined packet (LD01_PHASE_PACKET), the wiki, the seam-fixed IF97 build"]
fn mouth_path_block_replay_matches_the_colored_assembly() {
    use leitbild_operating_plant::network::unilateral::Lock;
    let i = inputs();
    let (mut net, prepared) = prepared(&i);
    let mut y = prepared.y.clone();
    let surge = i.regions.iter().position(|r| r == "SURGE").unwrap();
    let [b, m0, e0, m1, e1, _] = slots(&net, surge);
    let sc = net.scales().to_vec();
    let p = y[b] * sc[b];
    let sat = If97.saturation_caloric(s(p)).expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let v = net.volume(surge);
    // A small vapor stock in SURGE against a finite zone-A bubble stock.
    let (mg, mba) = (5e-3, 0.3);
    let ml = (v - mg / rg) * rf;
    y[m1] = 0.;
    y[e1] = 0.;
    net.birth(surge, &mut y).expect("birth");
    y[m0] = (ml + mg) / sc[m0];
    y[e0] = (ml * uf + mg * ug) / sc[e0];
    y[m1] = mg / sc[m1];
    y[e1] = mg * ug / sc[e1];
    let base = net.pzr.base;
    let (im, iv) = (
        base + stratified::ADMITTED_BUBBLE_MASS,
        base + stratified::ADMITTED_BUBBLE_VOLUME,
    );
    y[im] = mba / sc[im];
    y[iv] = mba / rg / sc[iv];
    let yp = vec![0.; y.len()];
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation at the flashed state");
    let presence = net.stock_presence(&y);
    net.activate_unilateral(&presence).expect("L1");
    let face = i.raw["mechanics"]["faces"]
        .as_array()
        .unwrap()
        .iter()
        .position(|f| f["id"] == "SURGE->PZR.SURGE.MOUTH")
        .unwrap();
    let mouth = 2 * face + 1;
    assert_eq!(net.face_layout[mouth].phase, 1);
    assert_eq!(net.unilateral().unwrap().paths[mouth], Lock::Free);
    let colored = net.sparse_jacobian().expect("colored structure");
    let blocks = net.block_jacobian().expect("block structure");
    assert_eq!(blocks.pattern, colored.pattern, "one pattern for both");
    let pattern = &blocks.pattern;
    let mut moving = y.clone();
    for (k, l) in net.face_layout.iter().enumerate() {
        moving[l.index] = if moving[l.index] != 0. {
            moving[l.index] * 1.01
        } else {
            1e-3 * if k % 2 == 0 { 1. } else { -1. } / sc[l.index]
        };
    }
    let mut report = Vec::new();
    for (name, state, cj) in [("rest", &y, 20.), ("moving", &moving, 350.)] {
        let mut cv = vec![0.; pattern.nonzeros()];
        let mut bv = vec![0.; pattern.nonzeros()];
        net.jacobian_colored(0., cj, state, &yp, &colored, &mut cv)
            .expect("colored assembly");
        net.jacobian_blocks(0., cj, state, &yp, &blocks, &mut bv)
            .expect("block assembly (base pass bitwise the residual's)");
        let (mut worst, mut bitwise, mut pzr_columns) = (0_f64, 0usize, 0usize);
        for j in 0..pattern.columns() {
            let range = pattern.pointers()[j]..pattern.pointers()[j + 1];
            let scale = range
                .clone()
                .map(|q| cv[q].abs().max(bv[q].abs()))
                .fold(0., f64::max);
            for q in range {
                pzr_columns += usize::from((j == im || j == iv) && bv[q] != 0.);
                if cv[q] == bv[q] {
                    bitwise += 1;
                    continue;
                }
                worst = worst.max((cv[q] - bv[q]).abs() / scale);
            }
        }
        report.push(
            json!({"state": name, "cj": cj, "column_relative_max": worst, "bitwise": bitwise,
            "entries": pattern.nonzeros(), "port_column_entries": pzr_columns}),
        );
        assert!(worst < 1e-10, "{name}: block against colored {worst:e}");
    }
    println!("{}", json!({"mouth_path_block_vs_colored": report}));
    // R4-VAPOR-IMPULSE: the same comparison with SURGE's vapor mass leaving,
    // where the row reads its `y'` and the Jacobian carries `cj`, and the term
    // on the moving state's row against the hand value.
    let mut leaving = yp.clone();
    leaving[m1] = -0.2 / sc[m1];
    let mut cv = vec![0.; pattern.nonzeros()];
    let mut bv = vec![0.; pattern.nonzeros()];
    let cj = 350.;
    net.jacobian_colored(0., cj, &moving, &leaving, &colored, &mut cv)
        .expect("colored assembly, mass leaving");
    net.jacobian_blocks(0., cj, &moving, &leaving, &blocks, &mut bv)
        .expect("block assembly, mass leaving");
    let mut worst = 0_f64;
    for j in 0..pattern.columns() {
        let range = pattern.pointers()[j]..pattern.pointers()[j + 1];
        let scale = range
            .clone()
            .map(|q| cv[q].abs().max(bv[q].abs()))
            .fold(0., f64::max);
        for q in range.filter(|q| cv[*q] != bv[*q]) {
            worst = worst.max((cv[q] - bv[q]).abs() / scale);
        }
    }
    assert!(
        worst < 1e-10,
        "mass leaving: block against colored {worst:e}"
    );
    let row = net.face_layout[mouth].index;
    let column = pattern.pointers()[m1]..pattern.pointers()[m1 + 1];
    let entry = |v: &[f64]| {
        column
            .clone()
            .find(|q| pattern.indices()[*q] == row)
            .map(|q| v[q])
            .expect("the mouth row reads SURGE's vapor mass")
    };
    let mut twice = vec![0.; pattern.nonzeros()];
    net.jacobian_colored(0., 2. * cj, &moving, &leaving, &colored, &mut twice)
        .expect("colored assembly at twice cj");
    let measured = (entry(&twice) - entry(&cv)) / cj;
    let chart = net.chart(face, 1).expect("the mouth's vapor chart");
    let weight: f64 = i.raw["mechanics"]["faces"][face]["supports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["inverse_area_length_per_m"].as_f64().unwrap())
        .sum::<f64>()
        / v;
    let expected = -weight * chart.volume_flow_m3_s.value * sc[m1] / sc[row];
    assert!(
        (measured - expected).abs() <= 1e-9 * expected.abs(),
        "the row's d/dy' {measured:e} against {expected:e}"
    );
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum RootKind {
    Birth(usize),
    Exhaustion(usize),
    Dryout(usize),
    /// An L1-held vapor path's drive (stand-in for PHASE-L1).
    Release(usize),
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

struct Case {
    net: Network<If97>,
    relief: Relief,
    held: Vec<bool>,
    orientation: Vec<f64>,
    endpoints: Vec<(usize, usize)>,
    structure: SparseJacobian,
    csc: (Vec<i64>, Vec<i64>),
    roots: Vec<RootKind>,
    cost: Cost,
}

impl Case {
    fn regular(&self) -> usize {
        self.net.cell_modes().len()
    }
    fn vapor_index(&self, face: usize) -> usize {
        self.net.face_layout[2 * face + 1].index
    }
    /// The kernel's rows, then the L1 stand-in's held vapor rows `Pi/s = 0`.
    fn rows(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<Vec<Scalar>, network::Failure> {
        self.net
            .evaluate_coupled(t, y, yp, seed, cj, None, Some(&mut self.relief))?;
        let mut rows = self.net.rows().to_vec();
        for (face, held) in self.held.iter().enumerate() {
            if *held {
                let i = self.vapor_index(face);
                rows[i] = Scalar::new(y[i], seed.map_or(0., |d| d[i]));
            }
        }
        Ok(rows)
    }
    /// The colored stage Jacobian on the network's structural pattern.
    fn assemble(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), network::Failure> {
        self.rows(t, y, yp, None, 0.)?;
        let signs = self.net.column_signs(y);
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
    fn declare_roots(&mut self) {
        let mut roots = Vec::new();
        for (c, m) in self.net.cell_modes().iter().enumerate() {
            match m {
                CellMode::Liquid => roots.push(RootKind::Birth(c)),
                CellMode::Equilibrium => {
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
    fn ids(&self, prepared: &[f64]) -> Vec<f64> {
        let mut ids = self.net.differential(prepared);
        for (j, h) in self.held.iter().enumerate() {
            if *h {
                ids[self.vapor_index(j)] = 0.;
            }
        }
        ids
    }
    fn holds_vapor(&self, c: usize, y: &[f64]) -> bool {
        c < self.regular()
            && (self.net.cell_modes()[c] == CellMode::Equilibrium
                || y[self.net.cell_layout[c].mass[1]] != 0.)
    }
    /// The L1 stand-in after a transaction (as the PHASE spike): a vapor
    /// path with vapor at exactly one end is held unless its drive draws
    /// from that end; a newborn phase's drive is zero, so it is held and
    /// released by root.
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
            let orientation = if vf { 1. } else { -1. };
            let hold = vf != vt && orientation * drive <= 0. && !released.contains(&j);
            self.orientation[j] = orientation;
            if hold != self.held[j] {
                changed.push(json!({"face":j,"held":hold,"drive_pa":drive}));
                self.held[j] = hold;
            }
        }
        Ok(changed)
    }
    /// Physical totals of the regular cells and the PZR's mass and tracer.
    fn totals(&self, y: &[f64]) -> [f64; 5] {
        let sc = self.net.scales();
        let (mut m, mut u, mut b) = (0., 0., 0.);
        for c in 0..self.regular() {
            let [_, m0, e0, m1, e1, bo] = slots(&self.net, c);
            match self.net.cell_modes()[c] {
                CellMode::Liquid => {
                    m += y[m0] * sc[m0] + y[m1] * sc[m1];
                    u += y[e0] * sc[e0] + y[e1] * sc[e1];
                }
                CellMode::Equilibrium => {
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
    fn restart_bounds(&self) -> Option<(Vec<usize>, f64)> {
        None
    }
}

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
        let mut c = self.0.borrow_mut();
        let started = cpu_s();
        let rows = c.rows(t, y, yp, None, 0.).map_err(ida_failure);
        c.cost.residuals += 1;
        c.cost.residual_s += cpu_s() - started;
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
        let mut c = self.0.borrow_mut();
        let started = cpu_s();
        rows.copy_from_slice(&c.csc.1);
        pointers.copy_from_slice(&c.csc.0);
        let result = c.assemble(t, cj, y, yp, data).map_err(ida_failure);
        c.cost.jacobians += 1;
        c.cost.jacobian_s += cpu_s() - started;
        result
    }
    fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let mut c = self.0.borrow_mut();
        let started = cpu_s();
        if c.roots.iter().any(|r| matches!(r, RootKind::Release(_))) {
            c.rows(t, y, yp, None, 0.).map_err(ida_failure)?;
        }
        for (k, root) in c.roots.clone().into_iter().enumerate() {
            out[k] = match root {
                RootKind::Birth(n) => c.net.birth_root(n, y).map_err(ida_failure)?,
                RootKind::Exhaustion(n) => c.net.equilibrium_masses(n, y).map_err(ida_failure)?.0,
                RootKind::Dryout(n) => c.net.equilibrium_masses(n, y).map_err(ida_failure)?.1,
                RootKind::Release(j) => c.orientation[j] * c.net.face_drive(j, 1).value,
            };
        }
        c.cost.root_calls += 1;
        c.cost.root_s += cpu_s() - started;
        Ok(())
    }
}

/// Declared configuration of every segment.
struct Config {
    rtol: f64,
    atol: Vec<f64>,
    max_order: usize,
    first_step_s: f64,
    newton_coefficient: f64,
    dcj: f64,
    derived: bool,
}

#[allow(clippy::too_many_arguments)] // One segment's declared inputs and its receipt log.
fn segment(
    case: &Rc<RefCell<Case>>,
    config: &Config,
    t: f64,
    y: &[f64],
    yp: &[f64],
    ids: &[f64],
    end_s: f64,
    restart: bool,
    log: &mut Vec<Value>,
) -> Result<Ida<Handle>, String> {
    case.borrow_mut().declare_roots();
    let mut atol = config.atol.clone();
    if config.derived {
        let records = case
            .borrow()
            .net
            .equilibrium_tolerances(y, config.rtol, &mut atol)
            .map_err(|e| format!("{e:?}"))?;
        if !records.is_empty() {
            log.push(json!({"t":t,"S3-D3":records}));
        }
    }
    let nonnegative = case.borrow().net.nonnegative_stocks();
    let mut ida = Ida::new(
        Handle(case.clone()),
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
    ida.set_delta_cj_lsetup(config.dcj)?;
    if restart {
        ida.set_init_step(config.first_step_s)?;
    }
    ida.constrain_nonnegative(&nonnegative)?;
    ida.stop_at(end_s)?;
    Ok(ida)
}

fn stats(ida: &Ida<Handle>) -> Value {
    match ida.stats() {
        Ok(st) => {
            json!({"steps":st.steps,"residuals":st.residuals,"jacobians":st.jacobians,"newton":st.nonlinear_iterations,"error_failures":st.error_failures,"convergence_failures":st.convergence_failures,"root_evaluations":st.root_evaluations,"last_step_s":st.last_step,"last_order":st.last_order})
        }
        Err(e) => json!({"error":e}),
    }
}

/// The post-birth spectrum test at one state: index 1 (as Z6 judges it:
/// infinite eigenvalues equal the algebraic coordinates of the current id
/// vector, including each equilibrium cell's `p, M_g, U_g` and each held
/// path), every resolved growing mode with its growth rate, and the finite
/// modes up to 20 Hz.
fn spectrum_test(
    case: &mut Case,
    t: f64,
    y: &[f64],
    yp: &[f64],
    names: &[String],
    algebraic: usize,
) -> (Value, bool) {
    let (a, b) = match case.pencil_at(t, y, yp) {
        Ok(p) => p,
        Err(e) => return (json!({"t":t,"error":format!("{e:?}")}), false),
    };
    let n = y.len();
    let spec = match spectrum::decompose(n, &a, &b) {
        Ok(s) => s,
        Err(e) => return (json!({"t":t,"error":format!("{e:?}")}), false),
    };
    let index_one = spec.infinite.count == algebraic;
    let top = |m: usize| -> Vec<Value> {
        let shape = &spec.shapes[m].right;
        let mut idx: Vec<usize> = (0..n).collect();
        idx.sort_by(|i, j| shape[*j].abs().total_cmp(&shape[*i].abs()));
        idx.iter().take(3).map(|i| json!(names[*i])).collect()
    };
    let growing: Vec<Value> = spec
        .modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.unstable && !m.marginal)
        .map(|(k, m)| json!({"hz":m.frequency_hz,"growth_per_s":m.lambda.re,"error_bound":m.error_bound,"top":top(k)}))
        .collect();
    let low: Vec<Value> = spec
        .modes
        .iter()
        .enumerate()
        .filter(|(_, m)| m.frequency_hz > 0.1 && m.frequency_hz <= 20. && !m.marginal)
        .map(|(k, m)| json!({"hz":m.frequency_hz,"zeta":m.damping_ratio,"top":top(k)}))
        .collect();
    (
        json!({"t":t,"index_one":index_one,"infinite":spec.infinite.count,"algebraic_coordinates":algebraic,"zero_columns_of_b":spec.infinite.algebraic_coordinates,
            "finite":spec.modes.len(),"resolved_growing":growing,"oscillatory_0_1_to_20_hz":low}),
        index_one,
    )
}

fn labels(case: &Case, regions: &[String]) -> Vec<String> {
    let mut out = vec![String::new(); case.net.dimension()];
    for (c, region) in regions.iter().enumerate().take(case.regular()) {
        for (k, i) in slots(&case.net, c).iter().enumerate() {
            out[*i] = format!("{region}.{}", ["p", "M_l", "U_l", "M_g", "U_g", "B"][k]);
        }
    }
    for l in &case.net.face_layout {
        out[l.index] = format!("face{}.{}", l.face, ["Pi_l", "Pi_g"][l.phase]);
    }
    for (r, i) in case.net.rotor_index.iter().enumerate() {
        out[*i] = format!("rotor{r}");
    }
    for (k, i) in case.net.pzr.coordinates().enumerate() {
        out[i] = format!("PZR[{k}]");
    }
    out
}

#[test]
#[ignore = "PHASE-P7 mode build, NOT EVIDENCE: needs a joined packet (LD01_PHASE_PACKET), the wiki, the seam-fixed IF97 build and stock IDA/KLU"]
fn phase_modes_relief_case() {
    let i = inputs();
    let env_f = |k: &str| std::env::var(k).ok().map(|v| v.parse::<f64>().unwrap());
    let settle_s = env_f("LD01_PHASE_SETTLE_S").unwrap_or(60.);
    let after_birth_s = env_f("LD01_PM_AFTER_BIRTH_S").unwrap_or(20.);
    let spectrum_every = env_f("LD01_PM_SPECTRUM_EVERY_S").unwrap_or(0.5);
    let derived = std::env::var("LD01_PM_CLASS").as_deref() != Ok("declared");
    let out_path = std::env::var("LD01_PM_RECEIPT").ok();
    let output_s: f64 = 0.1;
    let cpu_cap_s = 900.;
    let started = cpu_s();
    let (net, prepared) = prepared(&i);
    let mut y = prepared.y.clone();
    let mut start = Value::Null;
    match std::env::var("LD01_PM_STATE") {
        Err(_) => {
            for index in &net.rotor_index {
                y[*index] = 0.;
            }
        }
        Ok(file) => {
            let state: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            y = state["y_bits"]
                .as_array()
                .unwrap()
                .iter()
                .take(y.len())
                .map(|b| f64::from_bits(u64::from_str_radix(b.as_str().unwrap(), 16).unwrap()))
                .collect();
            start = json!({"file":file,"t_s":state["t_s"],"note":"network block of the joined state, run alone as the spike"});
        }
    }
    let classes = classes(&i.gates);
    let atol = net
        .absolute_tolerances(&prepared.y, classes)
        .expect("tolerances");
    let config = Config {
        rtol: classes.relative,
        atol,
        max_order: i.gates["maxOrder"].as_u64().unwrap() as usize,
        first_step_s: i.p2["eventRestartFirstStep_s"].as_f64().unwrap(),
        newton_coefficient: 0.33,
        dcj: 0.1,
        derived,
    };
    let endpoints: Vec<(usize, usize)> = i
        .packet
        .mechanics
        .faces
        .iter()
        .map(|f| (f.from, f.to))
        .collect();
    let structure = net.sparse_jacobian().expect("structure");
    let csc = structure.pattern.to_i64().expect("csc");
    let case = Rc::new(RefCell::new(Case {
        net,
        relief: Relief {
            lift: 0.,
            back_pressure_pa: i.raw["pzrMetal"]["reliefBackPressure_Pa"].as_f64().unwrap(),
        },
        held: vec![false; endpoints.len()],
        orientation: vec![1.; endpoints.len()],
        endpoints: endpoints.clone(),
        structure,
        csc,
        roots: Vec::new(),
        cost: Cost::default(),
    }));
    let names = labels(&case.borrow(), &i.regions);
    let mut ids = case.borrow().ids(&prepared.differential);
    let weights = |y: &[f64]| -> Vec<f64> {
        y.iter()
            .zip(&config.atol)
            .map(|(v, a)| 1. / (config.rtol * v.abs() + a))
            .collect()
    };
    let w = weights(&y);
    let (mut yp, _) = consistent_start(&mut *case.borrow_mut(), 0., &mut y, &ids, &w, 1e-12, 2)
        .expect("consistent start at t = 0");
    let mut events: Vec<Value> = Vec::new();
    let mut segments: Vec<Value> = Vec::new();
    let mut spectra: Vec<Value> = Vec::new();
    let mut class_log: Vec<Value> = Vec::new();
    let mut samples: Vec<Value> = Vec::new();
    let mut index_one_everywhere = true;
    let mut failure: Option<String> = None;
    let mut ending = "time cap".to_string();
    let mut t = 0.;
    let mut phase = 0;
    let mut phase_end = settle_s;
    let mut first_birth: Option<f64> = None;
    let mut next_spectrum = f64::INFINITY;
    let mut ida = segment(
        &case,
        &config,
        t,
        &y,
        &yp,
        &ids,
        phase_end,
        false,
        &mut class_log,
    )
    .expect("first segment");
    let mut segment_start = (t, cpu_s());
    let mut next_output = output_s;
    loop {
        if cpu_s() - started > cpu_cap_s {
            ending = format!("CPU cap {cpu_cap_s} s");
            break;
        }
        let advanced = ida.advance(next_output.min(phase_end), &mut y, &mut yp);
        let mut fired: Option<Vec<(RootKind, i32)>> = None;
        match advanced {
            Err(e) => {
                failure = Some(format!("t≈{t}: {e}"));
                segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats(&ida),"failed":true}));
                break;
            }
            Ok(Advance::Reached(reached)) => {
                t = reached;
                if t >= next_output - 1e-9 {
                    samples.push(json!({"t":t,"stats":stats(&ida)}));
                    next_output = ((t / output_s).round() + 1.) * output_s;
                }
                if t >= next_spectrum - 1e-9 {
                    let algebraic = ids.iter().filter(|d| **d == 0.).count();
                    let (v, ok) =
                        spectrum_test(&mut case.borrow_mut(), t, &y, &yp, &names, algebraic);
                    index_one_everywhere &= ok;
                    spectra.push(v);
                    next_spectrum += spectrum_every;
                }
                if t >= phase_end - 1e-12 {
                    segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats(&ida)}));
                    if phase == 0 {
                        phase = 1;
                        phase_end = t + 150.;
                        case.borrow_mut().relief.lift = 1.;
                        let w = weights(&y);
                        match consistent_start(
                            &mut *case.borrow_mut(),
                            t,
                            &mut y,
                            &ids,
                            &w,
                            1e-12,
                            2,
                        ) {
                            Ok((rates, _)) => yp = rates,
                            Err(e) => {
                                failure = Some(format!("relief restart: {e:?}"));
                                break;
                            }
                        }
                        events.push(json!({"t":t,"kind":"relief stuck open at full lift"}));
                        drop(ida);
                        ida = segment(
                            &case,
                            &config,
                            t,
                            &y,
                            &yp,
                            &ids,
                            phase_end,
                            true,
                            &mut class_log,
                        )
                        .expect("relief segment");
                        segment_start = (t, cpu_s());
                        continue;
                    }
                    ending = if phase == 1 {
                        "no birth within the depressurization cap".into()
                    } else {
                        format!("{after_birth_s} s after the first birth")
                    };
                    break;
                }
            }
            Ok(Advance::Root { time, directions }) => {
                t = time;
                segments.push(json!({"from_s":segment_start.0,"to_s":t,"cpu_s":cpu_s()-segment_start.1,"stats":stats(&ida),"ended_by_root":true}));
                let roots = case.borrow().roots.clone();
                fired = Some(
                    roots
                        .iter()
                        .zip(&directions)
                        .filter(|(_, d)| **d != 0)
                        .map(|(r, d)| (*r, *d))
                        .collect(),
                );
            }
        }
        let Some(fired) = fired else { continue };
        // Transactions (kernel), then the L1 stand-in, then the restart.
        let before = case.borrow().totals(&y);
        let tx_started = cpu_s();
        let mut description = Vec::new();
        let mut dryout = None;
        let mut released = Vec::new();
        {
            let mut c = case.borrow_mut();
            for (root, direction) in &fired {
                let record = match root {
                    RootKind::Birth(n) if *direction > 0 => {
                        first_birth.get_or_insert(t);
                        c.net
                            .birth(*n, &mut y)
                            .map(|v| json!({"region":i.regions[*n],"tx":v}))
                    }
                    RootKind::Exhaustion(n) if *direction < 0 => c
                        .net
                        .exhaustion(*n, &mut y)
                        .map(|v| json!({"region":i.regions[*n],"tx":v})),
                    RootKind::Dryout(n) if *direction < 0 => {
                        dryout = Some(format!("dryout of {}: mode G is S6 scope", i.regions[*n]));
                        Ok(json!({"dryout":i.regions[*n]}))
                    }
                    RootKind::Release(j) => {
                        if *direction > 0 {
                            released.push(*j);
                        }
                        Ok(json!({"release":j,"direction":direction}))
                    }
                    other => Ok(json!({"ignored":format!("{other:?}"),"direction":direction})),
                };
                match record {
                    Ok(v) => description.push(v),
                    Err(e) => {
                        failure = Some(format!("transaction at {t}: {e:?}"));
                    }
                }
            }
        }
        if failure.is_some() {
            break;
        }
        let tx_s = cpu_s() - tx_started;
        if let Some(d) = dryout {
            events.push(json!({"t":t,"fired":description}));
            ending = d;
            break;
        }
        let changed = match case.borrow_mut().update_holds(t, &y, &yp, &released) {
            Ok(c) => c,
            Err(e) => {
                failure = Some(format!("L1 stand-in at {t}: {e:?}"));
                break;
            }
        };
        let after_tx = case.borrow().totals(&y);
        ids = case.borrow().ids(&prepared.differential);
        let restart_started = cpu_s();
        let w = weights(&y);
        let started_pair = consistent_start(&mut *case.borrow_mut(), t, &mut y, &ids, &w, 1e-12, 2);
        let after_start = case.borrow().totals(&y);
        let mut event = json!({"t":t,"fired":description,"l1_changed":changed,"transaction_cpu_s":tx_s,
            "conservation_across_transaction":std::array::from_fn::<f64, 5, _>(|k| after_tx[k] - before[k]),
            "conservation_across_restart":std::array::from_fn::<f64, 5, _>(|k| after_start[k] - before[k])});
        match started_pair {
            Ok((rates, pair)) => {
                yp = rates;
                event["consistent_start"] = json!({"cpu_s":cpu_s()-restart_started,"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value,"projection_wrms":pair.projection.as_ref().map(|p|p.correction_wrms)});
            }
            Err(e) => {
                event["consistent_start"] = json!({"refused":format!("{e:?}")});
                events.push(event);
                failure = Some(format!("consistent start at {t} refused"));
                break;
            }
        }
        if first_birth == Some(t) && phase == 1 {
            phase = 2;
            phase_end = t + after_birth_s;
            next_spectrum = t + spectrum_every;
        }
        events.push(event);
        drop(ida);
        ida = match segment(
            &case,
            &config,
            t,
            &y,
            &yp,
            &ids,
            phase_end,
            true,
            &mut class_log,
        ) {
            Ok(v) => v,
            Err(e) => {
                failure = Some(format!("segment at {t}: {e}"));
                break;
            }
        };
        segment_start = (t, cpu_s());
        next_output = ((t / output_s).floor() + 1.) * output_s;
    }
    let cost = case.borrow().cost;
    let receipt = json!({
        "kind":"ld01-phase-modes-relief-case-NOT-EVIDENCE",
        "provenance":std::env::var("LD01_PHASE_PROVENANCE").ok().and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "scope":"S3 mode build (S3-D-P1/P6, S3-D3, S3-D-P8 gas loss) on the S1 network with G6's relief hook; L1 is a labelled stand-in until PHASE-L1 lands; colored Jacobian on the S1 structural pattern; NOT evidence",
        "config":{"rtol":config.rtol,"max_order":config.max_order,"first_step_after_event_s":config.first_step_s,"newton_coefficient":config.newton_coefficient,"dcj":config.dcj,"class":if derived {"S3-D3 derived"} else {"declared G12"},"settle_s":settle_s,"after_birth_s":after_birth_s,"spectrum_every_s":spectrum_every},
        "start":start,
        "first_birth_s":first_birth,"ending":ending,"failure":failure,
        "events":events,"segments":segments,"class_log":class_log,
        "post_birth_spectrum_test":{"index_one_everywhere":index_one_everywhere,"states":spectra},
        "cost":{"residuals":cost.residuals,"residual_cpu_s":cost.residual_s,"jacobians":cost.jacobians,"jacobian_cpu_s":cost.jacobian_s,"root_calls":cost.root_calls,"root_cpu_s":cost.root_s},
        "cpu_s":cpu_s()-started,
        "samples":samples,
    });
    if let Some(path) = out_path {
        assert!(
            !std::path::Path::new(&path).exists(),
            "receipts are never overwritten: {path}"
        );
        std::fs::write(&path, serde_json::to_string_pretty(&receipt).unwrap()).expect("receipt");
    }
    println!(
        "{}",
        json!({"first_birth_s":receipt["first_birth_s"],"ending":receipt["ending"],"failure":receipt["failure"],"index_one_everywhere":index_one_everywhere,"spectra":spectra.len(),"cpu_s":receipt["cpu_s"]})
    );
    assert!(first_birth.is_some(), "no birth: {}", receipt["ending"]);
    for e in &events {
        if let Some(c) = e["conservation_across_transaction"].as_array() {
            assert!(
                c.iter().all(|d| d.as_f64() == Some(0.)),
                "a transaction moved material or energy: {e}"
            );
        }
    }
    assert!(index_one_everywhere, "a post-birth pencil is not index 1");
}

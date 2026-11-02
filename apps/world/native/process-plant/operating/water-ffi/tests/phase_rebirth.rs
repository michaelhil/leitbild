//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/bulk-condensation-study.md#stable-phase-birth-and-disappearance
//! DR S3-REBIRTH (PHASE-L1): C2's SURGE re-birth with its vapor paths
//! locked, on the S3 base packet's network. At the re-birth SURGE is an
//! equilibrium cell holding exactly zero vapor, so the vapor drives of
//! face 34 (SURGE → PZR mouth, SURGE holding) and face 33 (HOT.A.JUNCTION
//! → SURGE, SURGE holding) are exactly zero: their release roots start at
//! an exact zero, which stock IDA deactivates and never reports leaving
//! zero, so in C2 the paths stayed locked for 47 s.
//!
//! SURGE's liquid leaves upward through face 34 (an insurge of 0.01 m³/s
//! into the PZR), so the rigid saturated cell depressurizes and its vapor
//! grows from the birth (C2's flashing SURGE). After the exact consistent
//! start, `Network::unilateral_release_at_start` reads each drive's rate
//! along the consistent rates (one evaluation seeded along `y'`, `cj = 0`):
//! face 34's drive leaves zero toward SURGE, its holding end, and is
//! released now (decision 0014: the drive reverses at this instant); face
//! 33's leaves zero toward the vapor-free junction and stays locked. No
//! coordinate or rate moves, and the state stays consistent under the new
//! id vector.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        self, CellMode, ConsistentSystem, Coupling, Fluid, Network, Properties, Receipts,
        RotorState, consistent_start,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
        stratified,
        unilateral::{Cause, Holding, Lock},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::Scalar,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

/// The stuck-open relief through G6's boundary hook (C4's initiator), the
/// depressurization that flashes SURGE.
struct Relief {
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
                lift: s(1.),
                back_pressure_pa: Some(s(self.back_pressure_pa)),
            }),
            ..stratified::Boundary::closed()
        })
    }
}

/// The network with its relief open, as an exact-start system.
struct Relieved {
    net: Network<If97>,
    relief: Relief,
}
impl Relieved {
    fn evaluate(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<(), network::Failure> {
        self.net
            .evaluate_coupled(t, y, yp, seed, cj, None, Some(&mut self.relief))
    }
}
impl ConsistentSystem for Relieved {
    fn system_dimension(&self) -> usize {
        self.net.dimension()
    }
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, network::Failure> {
        self.evaluate(t, y, yp, None, 0.)?;
        Ok(self.net.rows().iter().map(|r| r.value).collect())
    }
    fn pencil_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), network::Failure> {
        let n = self.net.dimension();
        let signs = self.net.column_signs(y);
        let mut dense = |cj: f64| -> Result<Vec<f64>, network::Failure> {
            let mut out = vec![0.; n * n];
            let mut seed = vec![0.; n];
            for col in 0..n {
                seed[col] = signs[col];
                let done = self.evaluate(t, y, yp, Some(&seed), cj);
                seed[col] = 0.;
                done?;
                for (row, r) in self.net.rows().iter().enumerate() {
                    out[col * n + row] = r.direction / signs[col];
                }
            }
            Ok(out)
        };
        let a = dense(0.)?;
        let ab = dense(1.)?;
        Ok((a.clone(), ab.iter().zip(&a).map(|(x, y)| x - y).collect()))
    }
}

#[test]
#[ignore = "DR S3-REBIRTH, NOT EVIDENCE: needs the S3 base packet (LD01_PHASE_PACKET) and maintained IF97 with the saturation-seam adapter"]
fn a_reborn_cells_zero_drive_paths_release_at_the_start_by_their_rate() {
    let path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let back_pressure_pa = raw["pzrMetal"]["reliefBackPressure_Pa"]
        .as_f64()
        .expect("packet pzrMetal.reliefBackPressure_Pa");
    let regions: Vec<String> = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let surge = regions.iter().position(|r| r == "SURGE").unwrap();
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
    let (net, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y = prepared.y.clone();
    let sc = net.scales().to_vec();
    // SURGE at its re-birth: saturated liquid filling its volume at its
    // pressure, no vapor; then the birth transaction (no stock moves).
    let l = net.cell_layout[surge];
    let p = y[l.base] * sc[l.base];
    let sat = If97.saturation_caloric(s(p)).expect("saturation");
    let rf = sat.liquid.density.value;
    let uf = sat.liquid.enthalpy.value - p / rf;
    let m = net.volume(surge) * rf;
    y[l.mass[0]] = m / sc[l.mass[0]];
    y[l.energy[0]] = m * uf / sc[l.energy[0]];
    let mut system = Relieved {
        net,
        relief: Relief { back_pressure_pa },
    };
    system.net.birth(surge, &mut y).expect("re-birth");
    assert_eq!(system.net.cell_modes()[surge], CellMode::Equilibrium);
    // SURGE's liquid leaving upward through face 34: Q = 0.01 m3/s.
    let zero = vec![0.; y.len()];
    system
        .evaluate(0., &y, &zero, None, 0.)
        .expect("evaluation at the re-birth");
    let i34l = system.net.face_layout[2 * 34].index;
    let inertance = system.net.chart(34, 0).unwrap().inertance_kg_m4.value;
    y[i34l] = 0.01 * inertance / sc[i34l];
    // L1 active at the re-birth: both vapor paths one-sided, SURGE holding,
    // at an exactly zero drive.
    system
        .evaluate(0., &y, &zero, None, 0.)
        .expect("evaluation at the re-birth");
    let presence = system.net.declared_presence(&y);
    system
        .net
        .activate_unilateral(&presence)
        .expect("L1 activation");
    let (v33, v34) = (2 * 33 + 1, 2 * 34 + 1);
    let locks = |net: &Network<If97>| net.unilateral().unwrap().paths.clone();
    assert_eq!(locks(&system.net)[v34], Lock::Locked(Holding::From));
    assert_eq!(locks(&system.net)[v33], Lock::Locked(Holding::To));
    assert_eq!(system.net.face_drive(34, 1).value, 0.);
    assert_eq!(system.net.face_drive(33, 1).value, 0.);
    // The release roots start at an exact zero (the defect's mechanism).
    let roots = system.net.unilateral_roots();
    let mut values = vec![0.; roots.len()];
    system
        .net
        .unilateral_root_values(&y, &roots, &mut values)
        .unwrap();
    for (r, v) in roots.iter().zip(&values) {
        if [v33, v34].contains(&r.path()) {
            assert_eq!(*v, 0., "{r:?}");
        }
    }
    // The exact consistent start with the relief open.
    let ids = system.net.differential(&prepared.differential);
    let weights: Vec<f64> = y.iter().map(|v| 1. / (1e-5 * v.abs() + 1e-8)).collect();
    let (yp, pair) =
        consistent_start(&mut system, 0., &mut y, &ids, &weights, 1e-12, 2).expect("start");
    let vapor_rate = yp[l.mass[1]] * sc[l.mass[1]];
    // The consistent rates are the analytic flash of a rigid saturated cell
    // losing liquid at h_f: (v_g - v_f) M_g' + M v_f' p' = -M' v_f and
    // (u_g - u_f) M_g' + M u_f' p' = U' - M' u_f, with the saturation
    // tuple's pressure derivatives (the equilibrium view keeps the vapor's
    // terms at an exactly zero vapor mass).
    {
        let pp = y[l.base] * sc[l.base];
        let d = If97.saturation_caloric(Scalar::new(pp, 1.)).unwrap();
        let ps = Scalar::new(pp, 1.);
        let (vf, vg) = (s(1.) / d.liquid.density, s(1.) / d.vapor.density);
        let uf = d.liquid.enthalpy - ps * vf;
        let ug = d.vapor.enthalpy - ps * vg;
        let mm = y[l.mass[0]] * sc[l.mass[0]];
        let (m_rate, u_rate) = (
            yp[l.mass[0]] * sc[l.mass[0]],
            yp[l.energy[0]] * sc[l.energy[0]],
        );
        let (a11, a12, r1) = (vg.value - vf.value, mm * vf.direction, -m_rate * vf.value);
        let (a21, a22, r2) = (
            ug.value - uf.value,
            mm * uf.direction,
            u_rate - m_rate * uf.value,
        );
        let det = a11 * a22 - a12 * a21;
        let (mg_rate, p_rate) = ((r1 * a22 - a12 * r2) / det, (a11 * r2 - a21 * r1) / det);
        let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * b.abs();
        assert!(
            close(vapor_rate, mg_rate),
            "{vapor_rate} vs analytic {mg_rate}"
        );
        assert!(
            close(yp[l.base] * sc[l.base], p_rate),
            "p' vs analytic {p_rate}"
        );
    }
    // The drives' rates along the consistent rates, then L1 at the start.
    let (y0, yp0) = (y.clone(), yp.clone());
    system
        .evaluate(0., &y, &yp, Some(&yp), 0.)
        .expect("seeded evaluation");
    let rate = |net: &Network<If97>, face: usize| net.face_drive(face, 1).direction;
    let (r33, r34) = (rate(&system.net, 33), rate(&system.net, 34));
    let mut yp = yp;
    let (tx, zero_drives) = system
        .net
        .unilateral_release_at_start(&mut yp)
        .expect("release at the start");
    let listed = |li: usize| {
        zero_drives
            .iter()
            .find(|(p, _, _)| *p == li)
            .map(|(_, f, r)| (*f, *r))
    };
    assert_eq!(listed(v34), Some((0., r34)));
    assert_eq!(listed(v33), Some((0., -r33)));
    // Face 34 is released exactly when its oriented rate is positive (the
    // drive leaves zero toward SURGE); face 33 by the same rule.
    assert!(r34 > 0., "face 34's drive leaves zero upward: {r34} Pa/s");
    assert!(
        -r33 < 0.,
        "face 33's drive leaves zero toward the junction: {r33} Pa/s"
    );
    assert_eq!(locks(&system.net)[v34], Lock::Free);
    assert_eq!(locks(&system.net)[v33], Lock::Locked(Holding::To));
    let c = tx.changes.iter().find(|c| c.path == v34).expect("face 34");
    assert_eq!(
        (c.cause, c.before, c.after),
        (Cause::DriveAtStart, Lock::Locked(Holding::From), Lock::Free)
    );
    assert!(
        tx.changes
            .iter()
            .all(|c| c.cause == Cause::DriveAtStart && c.payment.is_none())
    );
    assert_eq!(tx.energy_paid_j, 0.);
    // No coordinate or rate moved; the pair stays consistent under the new
    // ids (face 34's impulse now differential, its row `Pi' - F = 0`).
    assert!(y.iter().zip(&y0).all(|(a, b)| a.to_bits() == b.to_bits()));
    assert!(yp.iter().zip(&yp0).all(|(a, b)| a.to_bits() == b.to_bits()));
    let ids_after = system.net.differential(&prepared.differential);
    let i34 = system.net.face_layout[v34].index;
    assert_eq!((ids[i34], ids_after[i34]), (0., 1.));
    let rows = system.rows_at(0., &y, &yp).expect("rows after the release");
    let worst = rows.iter().fold(0_f64, |m, r| m.max(r.abs()));
    assert!(worst <= 1e-12, "consistent after the release: {worst}");
    // The released path now carries the free row and a contact root.
    assert!(
        system
            .net
            .unilateral_roots()
            .contains(&network::phase_events::Root::Contact(v34))
    );
    println!(
        "{}",
        json!({"surge_vapor_rate_kg_s":vapor_rate,"face34_drive_rate_pa_s":r34,"face33_drive_rate_pa_s":r33,
            "zero_drives":zero_drives,"changes":tx.changes,"start":{"residual":pair.residual.value,"constraint_rate":pair.constraint_rate.value},"rows_after_release_max":worst})
    );
}

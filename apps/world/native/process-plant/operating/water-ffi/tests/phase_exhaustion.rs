//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/bulk-condensation-study.md#stable-phase-birth-and-disappearance
//! DR S3-EXHAUST (PHASE-P7): an equilibrium cell's exhaustion while vapor
//! paths into and out of it still carry impulse, reproduced at C2's located
//! instant (GATE's C2 preview with S3-D30, SURGE's exhaustion at trip +
//! 13.07 s): SURGE in the equilibrium mode with vapor of root size
//! (-9.78e-12 kg), face 34 (SURGE → PZR mouth, inertia supported in SURGE
//! only) at Π_g = 73.41 Pa·s, face 33 (HOT.A.JUNCTION → SURGE) at Π_g =
//! -161.62 Pa·s with 1.64 kg of vapor in HOT.A.JUNCTION. On the S3 base
//! packet's network alone (the joined owners do not enter the transaction).
//!
//! It shows the plain exhaustion leaves face 34's impulse with no inertia
//! ("zero phase inertia cannot retain finite impulse"), and that
//! `Network::exhaustion_with_paths` locks that path in the same transaction
//! (`Π = 0`, `Locked(Neither)`, its unbounded model kinetic energy not paid;
//! its volume flow undefined and its finite vapor mass flow reported, DR
//! S3-EXHAUST-REPORT), moves no other coordinate, so mass, energy and boron are
//! bitwise unchanged, lets L1's own transaction lock face 33 by contact with
//! its finite payment, and that a re-birth arms the release again.
#![cfg(all(feature = "ida", target_os = "macos"))]
use leitbild_operating_plant::{
    network::{
        CellMode, Network, Properties, RotorState,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
        unilateral::{Cause, Fired, Holding, Lock},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::Scalar,
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

/// The C2 values at SURGE's located exhaustion (trip + 13.066 s), from the
/// C2 re-run's receipt (`$LD01_RECEIPTS/phase-p7/exhaust-c2/`).
const SURGE_VAPOR_AT_ROOT_KG: f64 = -9.779812610487037e-12;
const SURGE_VAPOR_BEFORE_KG: f64 = 0.012633242407714245;
const JUNCTION_VAPOR_KG: f64 = 1.6393072186407285;
const FACE33_VAPOR_IMPULSE: f64 = -161.6193622531661;
const FACE34_VAPOR_IMPULSE: f64 = 73.40994649222904;

#[test]
#[ignore = "DR S3-EXHAUST, NOT EVIDENCE: needs the S3 base packet (LD01_PHASE_PACKET) and maintained IF97"]
fn exhaustion_with_live_vapor_paths_locks_them_in_the_same_transaction() {
    let path = std::env::var("LD01_PHASE_PACKET").expect("LD01_PHASE_PACKET");
    let raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let packet: Packet = serde_json::from_value(raw.clone()).expect("network packet");
    let regions: Vec<String> = raw["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let region = |id: &str| regions.iter().position(|r| r == id).unwrap();
    let (surge, junction) = (region("SURGE"), region("HOT.A.JUNCTION"));
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
    let (mut net, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    let mut y = prepared.y.clone();
    let yp = vec![0.; y.len()];
    let sc = net.scales().to_vec();
    // SURGE flashed: the equilibrium mode with C2's vapor before the root,
    // saturated liquid filling the rest of its volume at its pressure.
    let ls = net.cell_layout[surge];
    let p = y[ls.base] * sc[ls.base];
    let sat = If97.saturation_caloric(s(p)).expect("saturation");
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let ml = (net.volume(surge) - SURGE_VAPOR_BEFORE_KG / rg) * rf;
    y[ls.mass[1]] = 0.;
    y[ls.energy[1]] = 0.;
    net.birth(surge, &mut y).expect("birth");
    y[ls.mass[0]] = (ml + SURGE_VAPOR_BEFORE_KG) / sc[ls.mass[0]];
    y[ls.energy[0]] = (ml * uf + SURGE_VAPOR_BEFORE_KG * ug) / sc[ls.energy[0]];
    y[ls.mass[1]] = SURGE_VAPOR_BEFORE_KG / sc[ls.mass[1]];
    y[ls.energy[1]] = SURGE_VAPOR_BEFORE_KG * ug / sc[ls.energy[1]];
    // HOT.A.JUNCTION: liquid with C2's vapor stock, vapor 5 K superheated.
    let lj = net.cell_layout[junction];
    let pj = y[lj.base] * sc[lj.base];
    let tj = If97
        .saturation_caloric(s(pj))
        .expect("saturation")
        .temperature
        .value
        + 5.;
    let vapor = If97.forward(true, pj, tj).expect("vapor");
    y[lj.mass[1]] = JUNCTION_VAPOR_KG / sc[lj.mass[1]];
    y[lj.energy[1]] = JUNCTION_VAPOR_KG * vapor.internal_energy_j_kg / sc[lj.energy[1]];
    // The vapor impulses at C2's located instant.
    let (p33, p34) = (
        net.face_layout[2 * 33 + 1].index,
        net.face_layout[2 * 34 + 1].index,
    );
    y[p33] = FACE33_VAPOR_IMPULSE / sc[p33];
    y[p34] = FACE34_VAPOR_IMPULSE / sc[p34];
    // L1 active at the state before the root (vapor in SURGE).
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation before the root");
    let presence = net.declared_presence(&y);
    net.activate_unilateral(&presence).expect("L1 activation");
    let locks = |net: &Network<If97>| net.unilateral().unwrap().paths.clone();
    assert_eq!(locks(&net)[2 * 34 + 1], Lock::Free);
    assert_eq!(locks(&net)[2 * 33 + 1], Lock::Free);
    // The located root: SURGE's vapor of root size; its totals unchanged.
    y[ls.mass[1]] = SURGE_VAPOR_AT_ROOT_KG / sc[ls.mass[1]];
    y[ls.energy[1]] = SURGE_VAPOR_AT_ROOT_KG * ug / sc[ls.energy[1]];
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation at the root");

    // The plain exhaustion leaves face 34's impulse with no inertia.
    let modes = net.cell_modes().to_vec();
    let mut plain = y.clone();
    net.exhaustion(surge, &mut plain).expect("plain exhaustion");
    let refused = net.evaluate(0., &plain, &yp, None, 0., None);
    let reason = format!("{:?}", refused.as_ref().err());
    assert!(
        reason.contains("zero phase inertia cannot retain finite impulse"),
        "C2's failure reproduced: {reason}"
    );
    net.set_cell_modes(&modes).expect("modes restored");
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation at the root again");

    // The exhaustion with its vapor paths, in one transaction.
    let before = y.clone();
    let (events, tx) = net
        .exhaustion_with_paths(&mut y, &[surge])
        .expect("exhaustion with paths");
    assert_eq!(net.cell_modes()[surge], CellMode::Liquid);
    assert_eq!(
        tx.changes.len(),
        1,
        "only face 34's inertia vanishes: {tx:?}"
    );
    let c = &tx.changes[0];
    assert_eq!((c.face, c.phase, c.cause), (34, 1, Cause::Exhaustion));
    assert_eq!(c.after, Lock::Locked(Holding::Neither));
    assert_eq!(c.payment, None);
    assert_eq!(tx.energy_paid_j, 0.);
    // `Q = Π/I` is undefined at the root-size inertia; the record carries the
    // path's vapor mass flow, `Π` over the reciprocal-area length of its
    // supports, all in SURGE (DR S3-EXHAUST-REPORT).
    assert_eq!(c.volume_flow_m3_s, None);
    let w34: f64 = raw["mechanics"]["faces"][34]["supports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            assert_eq!(s["region"].as_u64(), Some(surge as u64));
            s["inverse_area_length_per_m"].as_f64().unwrap()
        })
        .sum();
    let m34 = c.mass_flow_kg_s.expect("the path's vapor mass flow");
    assert!(
        (m34 * w34 / FACE34_VAPOR_IMPULSE - 1.).abs() <= 1e-14,
        "{m34} kg/s vs Π/W {} kg/s",
        FACE34_VAPOR_IMPULSE / w34
    );
    for (i, (a, b)) in before.iter().zip(&y).enumerate() {
        if i == p34 || i == ls.mass[1] || i == ls.energy[1] {
            continue;
        }
        assert_eq!(a.to_bits(), b.to_bits(), "coordinate {i} moved");
    }
    assert_eq!((y[p34], y[ls.mass[1]], y[ls.energy[1]]), (0., 0., 0.));
    // Totals: SURGE's are its liquid slots before and after (bitwise).
    assert_eq!(
        (before[ls.mass[0]], before[ls.energy[0]], before[ls.boron]),
        (y[ls.mass[0]], y[ls.energy[0]], y[ls.boron])
    );
    // The state after the transaction evaluates.
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation after the exhaustion");
    // L1's own transaction: face 33 locks by its located contact root and
    // pays its finite ½ΠQ into HOT.A.JUNCTION's vapor energy.
    let presence = net.declared_presence(&y);
    let u_before = y[lj.energy[1]] * sc[lj.energy[1]];
    let l1 = net
        .unilateral_transaction(&mut y, &presence, &[(2 * 33 + 1, Fired::Contact)], None)
        .expect("L1 transaction");
    let c33 = l1
        .changes
        .iter()
        .find(|c| c.face == 33 && c.phase == 1)
        .expect("face 33's contact");
    assert_eq!(c33.cause, Cause::ContactRoot);
    let (receiver, index, paid) = c33.payment.expect("a finite payment");
    assert_eq!((receiver, index), (junction, lj.energy[1]));
    assert!(paid.is_finite() && paid > 0. && paid < 1e6, "{paid}");
    let entered = y[lj.energy[1]] * sc[lj.energy[1]] - u_before;
    assert!(
        (entered - paid).abs() <= 1e-9 * u_before.abs(),
        "{entered} vs {paid}"
    );
    assert_eq!(y[p33], 0.);
    // A re-birth in SURGE arms face 34's release again (one-sided lock).
    net.birth(surge, &mut y).expect("re-birth");
    net.evaluate(0., &y, &yp, None, 0., None)
        .expect("evaluation after the re-birth");
    let presence = net.declared_presence(&y);
    net.unilateral_transaction(&mut y, &presence, &[], None)
        .expect("L1 after the re-birth");
    assert_ne!(locks(&net)[2 * 34 + 1], Lock::Locked(Holding::Neither));
    println!(
        "{}",
        json!({"exhaustion":events,"exhaustion_contacts":tx,"l1":l1,"face34_after_rebirth":locks(&net)[2 * 34 + 1]})
    );
}

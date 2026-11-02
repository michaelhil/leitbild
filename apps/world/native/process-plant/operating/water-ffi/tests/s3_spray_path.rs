//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray path's addition to the network, checked against the
//! packet it was composed into (NOT-EVIDENCE checks for KERN's S1 run 7 and
//! S2 re-settle):
//! - census: the composed network has exactly the line's six coordinates
//!   and the two new faces' four impulses more;
//! - equivalence: at the S2-07 settled state embedded with the line at rest
//!   (both new faces' impulses zero, the valve closed), every row of the
//!   original network is reproduced bitwise; the line's own rows are
//!   reported (the port face's drive is the line preparation's hydrostatic
//!   mismatch, the only way the addition acts);
//! - structure: the colored Jacobian on the composed network (which refuses
//!   an omitted structural dependency) against the dense column-by-column
//!   assembly, entry by entry.
//!
//! Environment: `LD01_OPERATING_HOT_SPINE_PACKET` (the original joined
//! packet), `LD01_SPRAY_PACKET` (the same packet with the spray path,
//! `reference-design-operating-spray-path.ts`), `LD01_C1_STATE` (a settled
//! state of the original packet), IF97 and the water library; optionally
//! `LD01_SPRAY_RECEIPT` (a new receipt path).
#![cfg(feature = "ida")]
use leitbild_operating_plant::{
    network::{
        Network, PzrPreparation, RotorState,
        packet::Packet,
        stratified::{self},
    },
    rotor::{Shaft, SpeedRequest, Support},
};
use leitbild_operating_water::If97;
use serde_json::{Value, json};

fn read(var: &str) -> (String, Vec<u8>) {
    let path = std::env::var(var).unwrap_or_else(|_| panic!("{var}"));
    let bytes = std::fs::read(&path).expect(var);
    (path, bytes)
}
fn vector(v: &Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}
fn composed(packet: &Packet) -> Network<If97> {
    // The S1/S2 harnesses' preparation controls (joined_spine.rs SETTINGS).
    let (mut network, _) = Network::new(
        packet,
        If97,
        &PzrPreparation {
            pressure_tolerance_pa: 1e-6,
            max_passes: 50,
        },
    )
    .expect("network");
    for r in 0..network.rotor_index.len() {
        network.set_rotor_state(
            r,
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            },
        );
    }
    network
}

#[test]
#[ignore = "NOT-EVIDENCE check: requires both packets, a settled state, IF97 and the water library"]
fn the_spray_path_adds_only_its_line_and_faces_and_leaves_every_original_row_bitwise() {
    let (old_path, old_bytes) = read("LD01_OPERATING_HOT_SPINE_PACKET");
    let (new_path, new_bytes) = read("LD01_SPRAY_PACKET");
    let (state_path, state_bytes) = read("LD01_C1_STATE");
    let receipt_path = std::env::var_os("LD01_SPRAY_RECEIPT");
    if let Some(p) = &receipt_path {
        assert!(
            !std::path::Path::new(p).exists(),
            "receipts are never overwritten"
        );
    }
    let old_packet: Packet = serde_json::from_slice(&old_bytes).unwrap();
    let new_packet: Packet = serde_json::from_slice(&new_bytes).unwrap();
    let state: Value = serde_json::from_slice(&state_bytes).unwrap();
    let mut old = composed(&old_packet);
    let mut new = composed(&new_packet);
    let spray = *new.spray().expect("the spray packet composes the path");
    let (n_old, n_new) = (old.dimension(), new.dimension());
    // Census: the line's six coordinates and the two faces' four impulses.
    assert_eq!(n_new, n_old + 6 + 4, "census");
    assert_eq!(new.cell_layout.len(), old.cell_layout.len() + 1);
    assert_eq!(new.face_layout.len(), old.face_layout.len() + 4);
    // Old -> new coordinate map by identity.
    let mut map = vec![usize::MAX; n_old];
    for (node, l) in old.cell_layout.iter().enumerate() {
        let m = new.cell_layout[node];
        for k in 0..6 {
            map[l.base + k] = m.base + k;
        }
    }
    for (a, b) in old.pzr.coordinates().zip(new.pzr.coordinates()) {
        map[a] = b;
    }
    for (li, l) in old.face_layout.iter().enumerate() {
        map[l.index] = new.face_layout[li].index;
    }
    for (r, i) in old.rotor_index.iter().enumerate() {
        map[*i] = new.rotor_index[r];
    }
    assert!(
        map.iter().all(|i| *i < n_new),
        "every original coordinate maps"
    );
    let t = state["t_s"].as_f64().unwrap();
    let (y_joined, yp_joined) = (vector(&state["y"]), vector(&state["yp"]));
    let (y_old, yp_old) = (&y_joined[..n_old], &yp_joined[..n_old]);
    let mut y_new = vec![0.; n_new];
    let mut yp_new = vec![0.; n_new];
    for (i, j) in map.iter().enumerate() {
        y_new[*j] = y_old[i];
        yp_new[*j] = yp_old[i];
    }
    // The line at rest: COLD.A's settled specific state (density, internal
    // energy, boron fraction) at the hydrostatic pressure below the settled
    // roof (roof + rho g (18.5 - 10.75) m); vapor absent; impulses zero.
    let scales_new = new.scales().to_vec();
    let scales_old = old.scales().to_vec();
    let source = new_packet
        .mechanics
        .regions
        .iter()
        .position(|r| r.id == "COLD.A")
        .unwrap();
    let c = old.cell_layout[source];
    let phys = |i: usize| y_old[i] * scales_old[i];
    let (m_c, u_c, b_c) = (phys(c.mass[0]), phys(c.energy[0]), phys(c.boron));
    let volume_c = old_packet.mechanics.regions[source].volume_m3;
    let rho = m_c / volume_c;
    let roof = phys(old.pzr.base + stratified::ROOF_PRESSURE);
    let line = &new_packet.pzr_spray.as_ref().unwrap().line;
    let p_line = roof + rho * 9.80665 * (line.outlet_elevation_m - line.centroid_elevation_m);
    let m_line = rho * line.volume_m3;
    let s = new.cell_layout[spray.region];
    for (i, v) in [
        (s.base, p_line),
        (s.mass[0], m_line),
        (s.energy[0], m_line * u_c / m_c),
        (s.mass[1], 0.),
        (s.energy[1], 0.),
        (s.boron, m_line * b_c / m_c),
    ] {
        y_new[i] = v / scales_new[i];
    }
    old.evaluate(t, y_old, yp_old, None, 0., None)
        .expect("original rows");
    new.evaluate(t, &y_new, &yp_new, None, 0., None)
        .expect("composed rows");
    let (old_rows, new_rows) = (old.rows().to_vec(), new.rows().to_vec());
    let differing: Vec<usize> = (0..n_old)
        .filter(|i| old_rows[*i].value.to_bits() != new_rows[map[*i]].value.to_bits())
        .collect();
    let mut line_rows = serde_json::Map::new();
    let named = [
        ("line EOS", s.base),
        ("line liquid mass", s.mass[0]),
        ("line liquid energy", s.energy[0]),
        ("line vapor mass", s.mass[1]),
        ("line vapor energy", s.energy[1]),
        ("line boron", s.boron),
    ];
    for (name, i) in named {
        line_rows.insert(name.into(), json!(new_rows[i].value));
    }
    for li in old.face_layout.len()..new.face_layout.len() {
        let l = new.face_layout[li];
        line_rows.insert(
            format!("face {} phase {} impulse row", l.face, l.phase),
            json!(new_rows[l.index].value),
        );
    }
    // Structure: colored (refuses an omitted dependency) against dense.
    let structure = new.sparse_jacobian().expect("structure");
    let nnz = structure.pattern.nonzeros();
    let mut colored = vec![0.; nnz];
    new.jacobian_colored(t, 10., &y_new, &yp_new, &structure, &mut colored)
        .expect("colored Jacobian on the composed network");
    let mut data = vec![0.; n_new * n_new];
    let mut rows = vec![0i64; n_new * n_new];
    let mut pointers = vec![0i64; n_new + 1];
    new.jacobian_dense(
        t,
        10.,
        &y_new,
        &yp_new,
        leitbild_operating_plant::network::CscOut {
            data: &mut data,
            rows: &mut rows,
            pointers: &mut pointers,
        },
    )
    .expect("dense Jacobian");
    let (mut worst, mut scale, mut outside) = (0_f64, 0_f64, 0usize);
    let mut stored = vec![false; n_new * n_new];
    let (pointers_p, indices_p) = (structure.pattern.pointers(), structure.pattern.indices());
    for col in 0..n_new {
        for k in pointers_p[col]..pointers_p[col + 1] {
            let row = indices_p[k];
            let d = data[col * n_new + row];
            worst = worst.max((colored[k] - d).abs());
            scale = scale.max(d.abs());
            stored[col * n_new + row] = true;
        }
    }
    for (k, d) in data.iter().enumerate() {
        if !stored[k] && *d != 0. {
            outside += 1;
        }
    }
    let receipt = json!({
        "kind": "s3-spray-path-addition-check",
        "status": "NOT-EVIDENCE: census, row equivalence at the embedded S2-07 state, structure",
        "original_packet": old_path, "spray_packet": new_path, "settled_state": state_path, "t_s": t,
        "census": {"original": n_old, "composed": n_new, "added": n_new - n_old,
            "added_by": "SPRAY region 6 (p, M_l, U_l, M_v, U_v, B) + faces 35/36 x 2 phases"},
        "original_rows_differing_bitwise": differing.len(),
        "line_state": {"pressure_pa": p_line, "mass_kg": m_line, "roof_pa": roof},
        "line_rows_solver_scaling": line_rows,
        "structure": {"nnz": nnz, "max_abs_colored_minus_dense": worst, "max_abs_dense": scale,
            "dense_nonzeros_outside_pattern": outside},
    });
    println!("{}", serde_json::to_string_pretty(&receipt).unwrap());
    if let Some(p) = &receipt_path {
        std::fs::write(p, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
    assert!(differing.is_empty(), "original rows changed: {differing:?}");
    assert_eq!(outside, 0, "dense entries outside the structural pattern");
    assert!(worst <= 1e-12 * scale.max(1.), "colored vs dense {worst}");
}

fn joined(bytes: &[u8]) -> leitbild_operating_plant::joined::operator::Joined<If97> {
    use leitbild_operating_plant::{
        joined::{
            operator::{Joined, RodPort, SecondaryPort},
            packet,
        },
        rods::{RodBlock, Section as RodSection},
        sg::{packet::Section as SecondarySection, secondary::Secondaries},
    };
    let mut network_packet: Packet = serde_json::from_slice(bytes).unwrap();
    let joined_packet: packet::Packet = serde_json::from_slice(bytes).unwrap();
    let raw: Value = serde_json::from_slice(bytes).unwrap();
    let section: SecondarySection = serde_json::from_value(raw["secondary"].clone()).unwrap();
    let rods: RodSection = serde_json::from_value(raw["rods"].clone()).unwrap();
    // HOOK (OU-C P2 -> OU-B builder): the rod bores' water leaves the sector
    // inventory before the network is compiled.
    let carved = leitbild_operating_plant::rods::carve(&rods, &mut network_packet).unwrap();
    Joined::new(
        composed(&network_packet),
        &network_packet,
        &joined_packet,
        If97,
        SecondaryPort::Owner(Box::new(
            Secondaries::new(&section, &joined_packet.thermal.secondaries, &If97).unwrap(),
        )),
        RodPort::Owner(Box::new(
            RodBlock::from_packet(&rods, &network_packet, &carved, &If97, &[]).unwrap(),
        )),
    )
    .expect("joined operator")
}

/// The same at the joined operator: every original joined row (network,
/// nuclear, solids, SG secondary, rods, PZR block) is reproduced bitwise at
/// the S2-07 settled state with the line embedded at rest, and the census
/// grows by the line's ten network coordinates only.
#[test]
#[ignore = "NOT-EVIDENCE check: requires both packets, a settled state, IF97 and the water library"]
fn the_joined_spine_with_the_spray_path_reproduces_every_original_row_bitwise() {
    let (_, old_bytes) = read("LD01_OPERATING_HOT_SPINE_PACKET");
    let (_, new_bytes) = read("LD01_SPRAY_PACKET");
    let (_, state_bytes) = read("LD01_C1_STATE");
    let state: Value = serde_json::from_slice(&state_bytes).unwrap();
    let mut old = joined(&old_bytes);
    let mut new = joined(&new_bytes);
    let (n_old, n_new) = (old.dimension(), new.dimension());
    assert_eq!(n_new, n_old + 10, "joined census");
    let (no, nn) = (old.offsets().nuclear, new.offsets().nuclear);
    assert_eq!(nn, no + 10);
    // The network part maps by identity; every later block shifts by ten.
    let (on, nw) = (&old.network, &new.network);
    let mut map = vec![usize::MAX; n_old];
    for (node, l) in on.cell_layout.iter().enumerate() {
        for k in 0..6 {
            map[l.base + k] = nw.cell_layout[node].base + k;
        }
    }
    for (a, b) in on.pzr.coordinates().zip(nw.pzr.coordinates()) {
        map[a] = b;
    }
    for (li, l) in on.face_layout.iter().enumerate() {
        map[l.index] = nw.face_layout[li].index;
    }
    for (r, i) in on.rotor_index.iter().enumerate() {
        map[*i] = nw.rotor_index[r];
    }
    for (i, m) in map.iter_mut().enumerate().skip(no) {
        *m = i + 10;
    }
    let spray = *nw.spray().unwrap();
    let t = state["t_s"].as_f64().unwrap();
    let (y_old, yp_old) = (vector(&state["y"]), vector(&state["yp"]));
    let mut y_new = vec![0.; n_new];
    let mut yp_new = vec![0.; n_new];
    for (i, j) in map.iter().enumerate() {
        y_new[*j] = y_old[i];
        yp_new[*j] = yp_old[i];
    }
    // The line at COLD.A's settled specific state (rows of the line are not
    // compared here; its impulses are zero, its valve closed).
    let (so, sn) = (on.scales().to_vec(), nw.scales().to_vec());
    let new_packet: Packet = serde_json::from_slice(&new_bytes).unwrap();
    let source = new_packet
        .mechanics
        .regions
        .iter()
        .position(|r| r.id == "COLD.A")
        .unwrap();
    let c = on.cell_layout[source];
    let s = nw.cell_layout[spray.region];
    let ratio = new_packet.pzr_spray.as_ref().unwrap().line.volume_m3
        / new_packet.mechanics.regions[source].volume_m3;
    for (from, to) in [
        (c.base, s.base),
        (c.mass[0], s.mass[0]),
        (c.energy[0], s.energy[0]),
        (c.boron, s.boron),
    ] {
        let physical = y_old[from] * so[from] * if from == c.base { 1. } else { ratio };
        y_new[to] = physical / sn[to];
    }
    old.evaluate(t, &y_old, &yp_old, None, 0., None).unwrap();
    new.evaluate(t, &y_new, &yp_new, None, 0., None).unwrap();
    let (a, b) = (old.rows().to_vec(), new.rows().to_vec());
    let differing: Vec<usize> = (0..n_old)
        .filter(|i| a[*i].value.to_bits() != b[map[*i]].value.to_bits())
        .collect();
    println!(
        "{}",
        json!({"joined_census": {"original": n_old, "composed": n_new},
            "original_rows_differing_bitwise": differing.len(), "first": differing.first()})
    );
    assert!(
        differing.is_empty(),
        "original joined rows changed: {differing:?}"
    );
}

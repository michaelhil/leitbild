//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-draft-cases-c1c3
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-treatment-of-uncredited-lumped-modes
//! S3's spectral gate K (prerequisite 11, probe P-7): S2's zero-time Z6
//! (G10, `s2_spectrum.rs`) on the S3 composition at a saved S3 state, judged
//! by S2's GO rule, for the case harness's rule K (`s3_harness::families::
//! spectra` matches a receipt by the state's sha256 and passes it on a
//! verdict that starts with "GO").
//!
//! # The state and its composition
//!
//! `LD01_S3_SPECTRUM_STATE` names a saved S3 state: the settled S3 start
//! state (`LD01_S3_SPECTRUM_KIND=start`) or a case's post-event state the
//! case harness writes at its declared part's end, the window's end or rule
//! I's end, whichever first, and C4's 1 s after each phase change (S3-D52;
//! `post-event`). The operator is
//! composed as `s3_unit::compose` composes it, step by step (the joined
//! spine, the feed gate, the colored and block structures, the S2-D24r /
//! S3-D16 derived classes, the credited outputs; the saved discrete state
//! (L1, phase modes, spray, the SG, rod and PZR owners, the rotors) is
//! restored before the first evaluation at the state, S3-D69), with two
//! differences, both because Z6 linearizes the model at
//! the saved state itself, as S2's Z6 does:
//! - no exact consistent start: the state is the solver's own accepted
//!   state; its residual is reported per owner;
//! - the PZR controller is not re-commissioned: the heater demand in force
//!   is the restored PZR block's discrete state (a frame client holds it
//!   between frames; the window's end is not a frame instant).
//!
//! ELEC's slice is appended with its held inputs as saved (the generator,
//! shaft, turbine, breaker body; the Grid's carrier rate held over the
//! exchange interval, D2). The model's own Jacobian of the S3 unit is block
//! diagonal: the joined block (colored, exact directional derivatives, as
//! S2's Z6) and the slice's dense 9 x 9 block; the slice reads the joined's
//! admitted steam as a held input at each evaluation, so the exact
//! linearization is block triangular (joined -> slice, one way) and its
//! eigenvalues are those of the two blocks. The PZR controller and the Grid
//! exchange act at frames and exchanges on held inputs; between them they
//! add no row.
//!
//! # Pencils and predicates
//!
//! Gated: S2-D8's two restrictions of the joined block, exactly S2's:
//! `restricted` (network, SG secondaries and metal, rods, PZR block;
//! surfaces eliminated by the exact Schur complement; the rest held) and
//! `coupled-nuclear-thermal` (plus the regional populations, fuel nodes and
//! clad stores); and the slice's own block (`electrical-slice`). The blocks
//! are decomposed apart: the Jacobian is block diagonal, so the union of
//! their eigenvalues is the unit's, and each keeps its own error bounds (a
//! first receipt with the slice inside S2's pencils, 8bdfe70c1, left 25
//! modes of either block unresolved by the mixed norm alone). Ungated: held
//! walls and the network alone. The
//! predicates and thresholds are S2's (`ld01-s1-gates` `spectrum`, G14):
//! infinite modes equal the pencil's algebraic coordinates; no resolved
//! positive real part; every marginal mode tied to a null direction; no fast
//! lightly damped mode excited above the ratio by an event.
//!
//! Events: at the start state, the S3 cases' events at that state: C2's
//! turbine trip (E1, the demand step; E2, the holding release, on the
//! released pencil, as S2's Z6) and C3's supply loss of `LD01.P.A1` (E3, the
//! residual change of the loss at the unchanged state, on the held pencil,
//! from a second composition). At the declared part's end (post-event) no
//! event follows inside the case's window: the excitation predicate has no
//! event and holds vacuously; the other three are judged.
//!
//! A receipt is written only to a new path (`LD01_S3_SPECTRUM_RECEIPT`). It
//! names the state's sha256 (the bytes of `LD01_S3_SPECTRUM_STATE`), as rule
//! K reads it.
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;
use leitbild_operating_water::unit::{
    profile::Solver,
    s3,
    spine::{Started, credited_outputs, started_full_composition},
};
mod z6;

use leitbild_operating_plant::{
    electrical::slice::{self, Inputs as SliceInputs},
    joined::{
        block::{Class, Command},
        blocks::JoinedJacobian,
        operator::Joined,
    },
};
use leitbild_operating_water::{If97, joined::derived_tolerances, spectrum};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Instant};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}"))
}
fn read_json(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap_or_else(|e| panic!("{path}: {e}"))
}
fn vector(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("a number array")
        .iter()
        .map(|x| x.as_f64().expect("a number"))
        .collect()
}

/// The slice's coordinate names (`slice.rs`).
const SLICE_LABELS: [&str; slice::N] = [
    "lambda_d", "lambda_q", "lambda_f", "id", "iq", "if", "omega", "theta", "T_body",
];

/// One linearization: its name, `A`, `B`, the differential flags and the
/// named event forcings judged on it.
type PencilAt<'a> = (
    &'a str,
    Vec<f64>,
    Vec<f64>,
    Vec<f64>,
    Vec<(&'a str, Vec<f64>)>,
);

/// The S3 operator at a saved S3 state (see the module docs) and the
/// tolerances the solver uses there.
struct Operator {
    joined: Joined<If97>,
    t: f64,
    y: Vec<f64>,
    yp: Vec<f64>,
    network_ids: Vec<f64>,
    atol: Vec<f64>,
    rtol: f64,
    derived: Value,
}

fn operator_at(state: &Value) -> Result<Operator, String> {
    let (packet_path, _) = common::packet_bytes();
    if state["packet"].as_str() != Some(packet_path.as_str()) {
        return Err(format!(
            "the state is of another packet: {}",
            state["packet"]
        ));
    }
    if state["discrete_state"].is_null() {
        return Err("not a saved S3 state: no discrete_state".into());
    }
    let (y, yp) = (vector(&state["y"]), vector(&state["yp"]));
    let t = state["t_s"].as_f64().ok_or("the state has no t_s")?;
    let Started {
        mut joined,
        network_ids,
        mut atol,
        rtol,
        ..
    } = started_full_composition(&common::spine()).expect("the S2 composition");
    if y.len() != joined.dimension() {
        return Err(format!(
            "{} coordinates against {}",
            y.len(),
            joined.dimension()
        ));
    }
    joined
        .declare_feed_gate()
        .map_err(|e| format!("feed gate: {e:?}"))?;
    // S3-D69: the saved discrete state (cell phase modes, L1 locks, spray,
    // the owners, the rotors) is restored before anything evaluates the
    // operator at the saved state: a cell born in the case is two-phase in
    // the state, and evaluating it in its composed liquid-only mode fails
    // (the 17 Oct gate run: IF97 TrialBand at C4's later states). The
    // colored pattern is structural (every cell coordinate), so the feed
    // gate's recompile before the restore holds for any mode.
    joined
        .restore_discrete_state(&state["discrete_state"]["operator"])
        .map_err(|e| format!("restore the operator's discrete state: {e:?}"))?;
    let structure = JoinedJacobian::compile_for(&mut joined, t, &y, None)
        .map_err(|e| format!("structure: {e:?}"))?;
    let credited = credited_outputs(&joined, &common::spine()).expect("the credited outputs");
    let derived = derived_tolerances(
        &mut joined,
        &structure,
        t,
        &y,
        &yp,
        rtol,
        &credited,
        &mut atol,
    )
    .map_err(|e| format!("derived classes: {e:?}"))?;
    joined
        .declare_credited(credited)
        .map_err(|e| format!("credited: {e:?}"))?;
    Ok(Operator {
        joined,
        t,
        y,
        yp,
        network_ids,
        atol,
        rtol,
        derived: serde_json::to_value(format!("{derived:?}")).unwrap(),
    })
}

/// The joined residual at the state (each row's value), as S2's Z6 reads it.
fn residual(joined: &mut Joined<If97>, t: f64, y: &[f64], yp: &[f64]) -> Vec<f64> {
    joined.evaluate(t, y, yp, None, 0., None).expect("residual");
    joined.rows().iter().map(|r| r.value).collect()
}

/// ELEC's slice with its saved held inputs, its saved coordinates and its
/// tolerances (s3_unit's base classes at the electrical packet's boundary;
/// the stator's derived rows are not applied: no event forces a slice row
/// and the block is decoupled in the model's Jacobian, so they enter no
/// predicate; disclosed in the receipt).
struct Electrical {
    slice: slice::Slice,
    y: Vec<f64>,
    yp: Vec<f64>,
    atol: Vec<f64>,
}

fn electrical_at(state: &Value, elec_path: &str) -> Result<Electrical, String> {
    let e = read_json(elec_path);
    let f = |path: &[&str]| -> f64 {
        let mut x = &e;
        for k in path {
            x = &x[*k];
        }
        x.as_f64()
            .unwrap_or_else(|| panic!("{} is not a number", path.join(".")))
    };
    let params: slice::Parameters =
        serde_json::from_value(e["slice"].clone()).map_err(|x| x.to_string())?;
    // The wrapper's discrete state (S3-D19), under its owner's name.
    let appended = &state["discrete_state"]["appended"]["electrical"];
    let inputs: SliceInputs = serde_json::from_value(appended["inputs"].clone()).map_err(|x| {
        format!("the saved slice inputs (discrete_state.appended.electrical.inputs): {x}")
    })?;
    let slice = slice::Slice::new(params, inputs)?;
    let (y, yp) = (
        vector(&state["appended"]["y"]),
        vector(&state["appended"]["yp"]),
    );
    if y.len() != slice::N || yp.len() != slice::N {
        return Err(format!(
            "the saved slice has {} coordinates, not {}",
            y.len(),
            slice::N
        ));
    }
    let v_line = f(&["boundary", "lineVoltage_V"]);
    let f0 = f(&["boundary", "frequency_Hz"]);
    let s_flux = v_line / (2. * std::f64::consts::PI * f0);
    let s_cur = f(&["boundary", "base_VA"]) / v_line;
    let flux: Vec<f64> = serde_json::from_value(e["prepared"]["initialFlux"].clone()).unwrap();
    let atol = vec![
        1e-8 * s_flux,
        1e-8 * s_flux,
        1e-8 * flux[2].abs(),
        1e-8 * s_cur,
        1e-8 * s_cur,
        1e-8 * f(&["prepared", "fieldCurrent_A"]),
        1e-8 * f(&["prepared", "speed_rad_s"]),
        1e-8,
        1e-8 * f(&["prepared", "room_K"]),
    ];
    Ok(Electrical { slice, y, yp, atol })
}

/// The unit's CSC pattern and pencil: the joined block's (colored pattern,
/// `A = dF/dy`, `B = dF/dy'` at cj 0 and 1, S2's `pencil`) and the slice's
/// dense block appended (`slice.block` at cj 0 and 1).
fn unit_pencil(
    joined: &mut Joined<If97>,
    t: f64,
    y: &[f64],
    yp: &[f64],
    s: &Electrical,
) -> (Vec<usize>, Vec<usize>, Vec<f64>, Vec<f64>) {
    let n = joined.dimension();
    let (mut a, mut b) = z6::pencil(joined, t, y, yp);
    let (mut pointers, mut indices) = {
        let p = &joined.structure().unwrap().0;
        (p.pointers().to_vec(), p.indices().to_vec())
    };
    let g0 = s.slice.block(0., &s.y).expect("slice block");
    let g1 = s.slice.block(1., &s.y).expect("slice block");
    for c in 0..slice::N {
        for r in 0..slice::N {
            indices.push(n + r);
            a.push(g0[r][c]);
            b.push(g1[r][c] - g0[r][c]);
        }
        pointers.push(indices.len());
    }
    (pointers, indices, a, b)
}

#[test]
#[ignore = "zero-time receipt (S3 rule K): requires the S3 packet and electrical packet, a saved S3 state, the wiki, maintained IF97, stock IDA/KLU and Accelerate"]
#[allow(clippy::too_many_lines)] // One receipt: composition, events, four pencils per state.
fn s3_z6_at_a_saved_s3_state() {
    let wall = Instant::now();
    let cpu0 = leitbild_operating_water::unit::clock::process_cpu_s();
    let state_path = env("LD01_S3_SPECTRUM_STATE");
    let bytes = std::fs::read(&state_path).expect("state file");
    let state: Value = serde_json::from_slice(&bytes).expect("state json");
    let state_sha256 = leitbild_operating_plant::digest::sha256(&bytes);
    let kind = env("LD01_S3_SPECTRUM_KIND");
    let from = state["from"].as_str().unwrap_or("");
    // The case harness's post-event states (S3-D52): C2, C3, C5 at the
    // window's end or rule I's end; C4 1 s after each phase change and at
    // its declared part's end.
    let post_event_state = [
        "window end",
        "rule I end",
        "C4: 1 s after",
        "C4: the declared part's end",
    ]
    .iter()
    .any(|m| from.contains(m));
    let post_event = match kind.as_str() {
        "start" if !post_event_state => false,
        "post-event" if post_event_state => true,
        other => panic!(
            "LD01_S3_SPECTRUM_KIND={other} does not name this state (from: {from:?}): start | post-event"
        ),
    };
    let elec_path = env("ELEC_PACKET");
    let gates = common::s1_gates();
    let gate = z6::Gate {
        fast_mode_hz: gates["spectrum"]["fastModeHz"].as_f64().unwrap(),
        light_damping: gates["spectrum"]["lightDamping"].as_f64().unwrap(),
        max_excitation_ratio: gates["spectrum"]["maxExcitationRatio"].as_f64().unwrap(),
    };
    let Operator {
        mut joined,
        t,
        y,
        yp,
        network_ids,
        atol,
        rtol,
        derived,
    } = operator_at(&state).unwrap_or_else(|e| panic!("{e}"));
    let elec = electrical_at(&state, &elec_path).unwrap_or_else(|e| panic!("{e}"));
    let composed_cpu = leitbild_operating_water::unit::clock::process_cpu_s() - cpu0;
    let o = joined.offsets();
    let n = joined.dimension();
    let ns = n + slice::N;
    let mut labels: Vec<String> = joined
        .layouts()
        .into_iter()
        .flat_map(|(owner, l)| l.labels.into_iter().map(move |x| format!("{owner}/{x}")))
        .collect();
    labels.extend(SLICE_LABELS.iter().map(|x| format!("electrical slice/{x}")));
    let classes: Vec<Class> = joined
        .layouts()
        .into_iter()
        .flat_map(|(_, l)| l.classes)
        .collect();
    let y_all = [y.as_slice(), &elec.y].concat();
    let atol_all = [atol.as_slice(), &elec.atol].concat();
    let tolerance = spectrum::tolerance(rtol, &y_all, &atol_all).expect("tolerance");
    // S2-D8's restrictions of the joined block, exactly S2's; the slice's
    // block is its own gated pencil. The model's Jacobian is block diagonal,
    // so the unit's eigenvalues are the union of the blocks' exactly; each
    // block is decomposed alone so that its error bounds are its own (one
    // dense pencil of both mixes the slice's volt and ampere rows into the
    // joined block's norm and leaves resolved modes of either unresolved).
    let slice_rows: Vec<usize> = (n..ns).collect();
    let keep: Vec<usize> = (0..n)
        .filter(|&i| {
            i < o.nuclear || i >= o.secondary || (i >= o.solids && classes[i] == Class::MetalEnergy)
        })
        .collect();
    let surfaces: Vec<usize> = (o.solids..o.secondary)
        .filter(|&i| classes[i] == Class::Surface)
        .collect();
    let coupled: Vec<usize> = (0..n)
        .filter(|&i| {
            keep.contains(&i)
                || matches!(
                    classes[i],
                    Class::RegionalPopulation | Class::FuelEnergy | Class::CladEnergy
                )
        })
        .collect();
    let network_only: Vec<usize> = (0..o.nuclear).collect();
    let owner_of = |i: usize| {
        if i >= n {
            "electrical slice"
        } else if i < o.nuclear {
            "network"
        } else if i < o.solids {
            "nuclear"
        } else if i < o.secondary {
            "solids"
        } else if i < o.rods {
            "secondary"
        } else {
            "rods and PZR"
        }
    };
    let by_owner = |v: &[f64]| -> Value {
        let mut m: BTreeMap<&str, f64> = BTreeMap::new();
        for (i, x) in v.iter().enumerate() {
            let e = m.entry(owner_of(i)).or_insert(0.);
            *e = e.max(x.abs() / tolerance[i]);
        }
        json!(m)
    };
    let slice_ids = elec.slice.differential().to_vec();
    let with_slice = |v: Vec<f64>| -> Vec<f64> { [v.as_slice(), &[0.; slice::N]].concat() };

    // The held pencil and the state's residual (the slice's own rows).
    let mut f_slice = vec![0.; slice::N];
    elec.slice
        .rows(t, &elec.y, &elec.yp, &mut f_slice)
        .expect("slice rows");
    let f_state = [residual(&mut joined, t, &y, &yp).as_slice(), &f_slice].concat();
    let ids_held = [joined.differential(&network_ids).as_slice(), &slice_ids].concat();
    let (pointers, indices, a0, b0) = unit_pencil(&mut joined, t, &y, &yp, &elec);
    let mut states: Vec<PencilAt<'_>> = Vec::new();
    let mut events = json!({"state_residual_max_over_tolerance": by_owner(&f_state)});
    if post_event {
        events["post_event"] = json!(
            "the declared part's end (S3-D52): no event follows inside the case's window; the excitation predicate has no event (vacuous), the other three are judged"
        );
        states.push(("held", a0, b0, ids_held, Vec::new()));
    } else {
        // E3, C3's supply loss of LD01.P.A1 (rotor 0) at the unchanged
        // state, on a second composition (the first keeps the pre-loss
        // discrete state for the trip).
        let e3 = {
            let mut other = operator_at(&state).unwrap_or_else(|e| panic!("{e}"));
            let before = residual(&mut other.joined, t, &y, &yp);
            let mut y_cmd = y.clone();
            let done = other
                .joined
                .command(t, &mut y_cmd, Command::SupplyLoss { rotor: 0 })
                .expect("supply loss");
            assert_eq!(y_cmd, y, "the supply loss changes no coordinate");
            let after = residual(&mut other.joined, t, &y, &yp);
            events["E3_supply_loss"] = json!({"rotor": 0, "consumer": "LD01.P.A1", "transactions": done.len(),
                "max_over_tolerance": by_owner(&with_slice(after.iter().zip(&before).map(|(a, b)| a - b).collect()))});
            with_slice(after.iter().zip(&before).map(|(a, b)| a - b).collect())
        };
        // E1, E2: C2's turbine trip, exactly as S2's Z6 takes it.
        let f_held = residual(&mut joined, t, &y, &yp);
        let mut y_cmd = y.clone();
        let done = joined
            .command(t, &mut y_cmd, Command::TurbineTrip)
            .expect("TURBINE TRIP");
        assert_eq!(y_cmd, y, "the command changes no coordinate");
        let open = joined.next_time_event(t).expect("the holding opening");
        let f_cmd = residual(&mut joined, t, &y, &yp);
        let ramp_end = {
            let rods_next = joined.rods().unwrap().next_time_event(t);
            let sg_next = joined.secondary().unwrap().next_time_event(t);
            assert_eq!(rods_next, Some(open));
            sg_next.expect("the steam-demand ramp end")
        };
        let f_ramped = residual(&mut joined, ramp_end, &y, &yp);
        let e1: Vec<f64> = with_slice(f_ramped.iter().zip(&f_cmd).map(|(a, b)| a - b).collect());
        let f_held_open = residual(&mut joined, open, &y, &yp);
        let mut y_open = y.clone();
        let released = joined.time_events(open, &mut y_open).expect("opening");
        assert_eq!(y_open, y, "the release changes no coordinate");
        let ids_open = [joined.differential(&network_ids).as_slice(), &slice_ids].concat();
        let f_released = residual(&mut joined, open, &y, &yp);
        let e2: Vec<f64> = with_slice(
            f_released
                .iter()
                .zip(&f_held_open)
                .map(|(a, b)| a - b)
                .collect(),
        );
        let (_, _, a1, b1) = unit_pencil(&mut joined, open, &y, &yp, &elec);
        events["turbine_trip"] = json!({"t_s": t, "transactions": done.len(), "holding_opening_s": open, "ramp_end_s": ramp_end,
            "command_residual_change_max_over_tolerance": by_owner(&with_slice(f_cmd.iter().zip(&f_held).map(|(a, b)| a - b).collect()))});
        events["E1_demand_step_max_over_tolerance"] = by_owner(&e1);
        events["E2_release"] = json!({"transactions": released.len(),
            "algebraic_held": ids_held.iter().filter(|v| **v == 0.).count(), "algebraic_released": ids_open.iter().filter(|v| **v == 0.).count(),
            "max_over_tolerance": by_owner(&e2)});
        states.push((
            "held",
            a0,
            b0,
            ids_held,
            vec![("E1 demand step", e1.clone()), ("E3 supply loss", e3)],
        ));
        states.push((
            "released",
            a1,
            b1,
            ids_open,
            vec![("E1 demand step", e1), ("E2 release", e2)],
        ));
    }

    let restriction = z6::Restriction {
        pointers: &pointers,
        indices: &indices,
        keep: &keep,
        eliminate: &surfaces,
    };
    let held_walls = z6::Restriction {
        eliminate: &[],
        ..restriction
    };
    let coupled_restriction = z6::Restriction {
        keep: &coupled,
        ..restriction
    };
    let network_alone = z6::Restriction {
        keep: &network_only,
        eliminate: &[],
        ..restriction
    };
    let slice_alone = z6::Restriction {
        keep: &slice_rows,
        eliminate: &[],
        ..restriction
    };
    let mut verdicts = Vec::new();
    let mut pencils = Vec::new();
    for (name, a, b, ids, evs) in &states {
        let forcings: Vec<Vec<f64>> = evs.iter().map(|(_, v)| v.clone()).collect();
        let mut run = |pencil: &str, r: &z6::Restriction<'_>, gated: bool| {
            let (dense, forced, schur) = r.apply(a, b, &forcings, &labels, ids, &tolerance);
            let named: Vec<(&str, Vec<f64>)> = evs.iter().map(|(x, _)| *x).zip(forced).collect();
            let (mut verdict, go) = z6::judge(&format!("{pencil}/{name}"), &dense, &named, gate);
            verdict["schur"] = schur;
            verdict["gated"] = json!(gated);
            if gated {
                verdicts.push(go);
            }
            pencils.push(verdict);
        };
        run("restricted", &restriction, true);
        run("coupled-nuclear-thermal", &coupled_restriction, true);
        run("electrical-slice", &slice_alone, true);
        run("restricted-held-walls", &held_walls, false);
        run("network-alone", &network_alone, false);
    }
    let go = verdicts.iter().all(|g| *g) && !verdicts.is_empty();
    let receipt = json!({
        "kind": "s3-z6-spectrum",
        "status": "zero-time receipt for S3 rule K (prerequisite 11, P-7): S2's Z6 on the S3 composition; S3 is not declared (r3.7 draft): not evidence",
        "state": {"file": state_path, "sha256": state_sha256, "t_s": t, "kind": kind, "from": state["from"],
            "packet": state["packet"], "packet_sha256": state["packet_sha256"], "composition": state["composition"]},
        "provenance": {"app": std::env::var("LD01_APP_COMMIT").ok(), "electrical_packet": elec_path,
            "wiki": std::env::var("LD01_WIKI_ROOT").ok(), "wiki_commit": std::env::var("LD01_WIKI_COMMIT").ok(),
            "water": std::env::var("LD01_OPERATING_WATER_LIB_DIR").ok(), "sundials": std::env::var("LD01_OPERATING_SUNDIALS_PREFIX").ok()},
        "composition": {"operator": "as s3_unit::compose (S3-D28 (3)): joined spine, feed gate, colored and block structures, S2-D24r/S3-D16 derived classes, credited outputs, the saved discrete state restored (L1, phase modes, spray, SG, rods, PZR, rotors)",
            "differences_from_the_case_composition": ["no exact consistent start: the state is the solver's own accepted state (its residual is reported)",
                "the PZR controller not re-commissioned: the heater demand in force is the restored PZR block's discrete state"],
            "electrical_slice": "ELEC's slice with its saved held inputs and coordinates; base tolerance classes (the stator's derived rows not applied: the block is decoupled in the model's Jacobian and no event forces it)",
            "derived_classes": derived,
            "jacobian": "the model's own: the joined block colored (exact directional derivatives, S2's pencil) and the slice's dense block; block diagonal, the exact linearization block triangular (joined -> slice through the admitted steam), so its eigenvalues are the blocks'",
            "held_between_frames": "the PZR controller (frame client, class S) and the Grid exchange (D1 + D2) act on held inputs at frames and exchanges"},
        "gate": {"source": "ld01-s1-gates spectrum (G14), S2's Z6 predicate", "fastModeHz": gate.fast_mode_hz, "lightDamping": gate.light_damping, "maxExcitationRatio": gate.max_excitation_ratio},
        "restriction": {"restricted": {"coordinates": keep.len(), "eliminated_algebraic_surfaces": surfaces.len(), "as": "S2-D8 (S2's Z6), on the S3 operator (PZR block kept with the rods)"},
            "coupled_nuclear_thermal": {"coordinates": coupled.len(), "as": "S2-D8 (critic M3), on the S3 operator"},
            "electrical_slice": {"coordinates": slice::N, "as": "the slice's own block of the model's Jacobian (block diagonal with the joined block: the unit's eigenvalues are the union, each block decomposed alone so its error bounds are its own)"}},
        "events": events,
        "pencils": pencils,
        "verdict": if go { "GO: every gated Z6 predicate holds at this state" } else { "NO-GO: a gated Z6 predicate failed; see pencils[].predicates" },
        "cost": {"composition_cpu_s": composed_cpu, "total_cpu_s": leitbild_operating_water::unit::clock::process_cpu_s() - cpu0, "wall_s": wall.elapsed().as_secs_f64(), "load_average_end": common::cpu::load_average()},
    });
    let path = env("LD01_S3_SPECTRUM_RECEIPT");
    assert!(
        !std::path::Path::new(&path).exists(),
        "receipts are never overwritten: {path}"
    );
    std::fs::write(&path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    println!("{} {}", state_sha256, receipt["verdict"]);
    for p in &pencils {
        println!(
            "{} n={} infinite={}/{} growing={} marginal_untied={} predicates={}",
            p["pencil"],
            p["dimension"],
            p["infinite"]["count"],
            p["infinite"]["algebraic_coordinates_expected"],
            p["resolved_growing"].as_array().unwrap().len(),
            p["marginal_untied"],
            p["predicates"]
        );
    }
}

/// Lead S3-D53 (3): the coupling between the plant and ELEC's slice in the
/// S3 unit's continuous residual, by forward differences of the unit's own
/// residual at the state (the composed S3 unit, `s3_unit::compose`, at the
/// saved start state): the plant -> ELEC block `dF_slice/dy_plant` and the
/// ELEC -> plant block `dF_plant/dy_slice`. The union of the two blocks'
/// spectra is the unit's exactly when one of them is zero (block
/// triangular). Each column takes `h = sqrt(eps) max(|y|, atol/rtol)`.
/// Written to `LD01_S3_COUPLING_RECEIPT` (never over a file).
#[test]
#[ignore = "zero-time receipt (S3-D53): requires the S3 packet and sections, a saved S3 start state, the wiki, maintained IF97 and stock IDA/KLU"]
fn s3_unit_coupling_blocks() {
    use leitbild_operating_water::{ida::System, joined::JoinedSystem};
    let cpu0 = leitbild_operating_water::unit::clock::process_cpu_s();
    let state_path = env("LD01_S3_SPECTRUM_STATE");
    let bytes = std::fs::read(&state_path).expect("state file");
    let state: Value = serde_json::from_slice(&bytes).expect("state json");
    let inputs = common::inputs();
    // Z6 at a saved S3 state on the stock error weights (S2's Z6 rule).
    let mut u = s3::compose(&inputs, &state, Solver::STOCK).unwrap_or_else(|e| panic!("{e}"));
    let (n, t) = (u.n, u.t0);
    let (y, yp) = (u.y.clone(), u.yp.clone());
    let total = y.len();
    let labels: Vec<String> = u
        .ida
        .system()
        .integrated()
        .joined
        .layouts()
        .into_iter()
        .flat_map(|(owner, l)| l.labels.into_iter().map(move |x| format!("{owner}/{x}")))
        .chain(SLICE_LABELS.iter().map(|x| format!("electrical slice/{x}")))
        .collect();
    let sys = u.ida.system_mut();
    let mut f0 = vec![0.; total];
    sys.residual(t, &y, &yp, &mut f0)
        .expect("residual at the state");
    let mut f1 = vec![0.; total];
    // (sum of squares, max |entry|, its row, its column, nonzeros)
    let mut blocks = [(0f64, 0f64, 0usize, 0usize, 0usize); 3];
    let mut failures = Vec::new();
    for j in 0..total {
        let h = f64::EPSILON.sqrt() * y[j].abs().max(u.atol[j] / u.rtol);
        let mut yj = y.clone();
        yj[j] += h;
        let h = yj[j] - y[j];
        if let Err(e) = sys.residual(t, &yj, &yp, &mut f1) {
            failures.push(json!({"column": labels[j], "error": format!("{e:?}")}));
            continue;
        }
        let rows = if j < n { n..total } else { 0..n };
        // 0: plant -> ELEC, 1: ELEC -> plant, 2: the slice's own block.
        let mut account = |k: usize, rows: std::ops::Range<usize>| {
            for i in rows {
                let d = (f1[i] - f0[i]) / h;
                if d != 0. {
                    let b = &mut blocks[k];
                    b.0 += d * d;
                    b.4 += 1;
                    if d.abs() > b.1 {
                        b.1 = d.abs();
                        b.2 = i;
                        b.3 = j;
                    }
                }
            }
        };
        if j < n {
            account(0, rows);
        } else {
            account(1, rows);
            account(2, n..total);
        }
    }
    let block = |b: &(f64, f64, usize, usize, usize)| {
        json!({"frobenius": b.0.sqrt(), "max_abs": b.1, "nonzeros": b.4,
            "max_at": if b.4 > 0 { json!({"row": labels[b.2], "column": labels[b.3]}) } else { Value::Null }})
    };
    let receipt = json!({
        "kind": "s3-unit-coupling-blocks", "decision": "lead S3-D53 (3)",
        "state": {"file": state_path, "sha256": leitbild_operating_plant::digest::sha256(&bytes), "t_s": t},
        "method": "forward differences of the S3 unit's own residual (s3_unit::compose at the state: consistent start, controller commissioned) in solver units; h = sqrt(eps) max(|y_j|, atol_j/rtol)",
        "plant_to_elec": block(&blocks[0]), "elec_to_plant": block(&blocks[1]), "slice_own_block": block(&blocks[2]),
        "block_triangular": blocks[0].4 == 0 || blocks[1].4 == 0,
        "failures": failures, "cpu_s": leitbild_operating_water::unit::clock::process_cpu_s() - cpu0,
    });
    let path = env("LD01_S3_COUPLING_RECEIPT");
    assert!(
        !std::path::Path::new(&path).exists(),
        "receipts are never overwritten: {path}"
    );
    std::fs::write(&path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    println!(
        "{}",
        json!({"plant_to_elec": receipt["plant_to_elec"], "elec_to_plant": receipt["elec_to_plant"],
            "slice_own_block": receipt["slice_own_block"], "block_triangular": receipt["block_triangular"], "failures": receipt["failures"].as_array().map(Vec::len)})
    );
}

/// S3-D69: the Z6 operator composes at a saved state in which cells born
/// during the case carry vapour (C4's later post-event states: the
/// 17 Oct gate run's c4-phase-9 and c4-phase-10 did not compose before the
/// fix), with the saved cell modes in force. The state's residual is
/// reported (per row against its coordinate's tolerance, as Z6's receipt
/// reports it; not a convergence measure).
#[test]
#[ignore = "requires the S3 packet, a saved S3 state with a two-phase cell (LD01_S3_SPECTRUM_STATE), the wiki, maintained IF97 and stock IDA/KLU"]
fn the_z6_operator_composes_at_a_saved_two_phase_state() {
    let path = env("LD01_S3_SPECTRUM_STATE");
    let state = read_json(&path);
    let saved = &state["discrete_state"]["operator"]["network"]["modes"];
    let two_phase = saved
        .as_array()
        .expect("the saved cell modes")
        .iter()
        .filter(|m| m.as_str() != Some("Liquid"))
        .count();
    assert!(two_phase > 0, "the state has no two-phase cell: {saved}");
    let mut op = operator_at(&state).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        &serde_json::to_value(op.joined.network.cell_modes()).unwrap(),
        saved,
        "the saved cell modes are in force"
    );
    let f = residual(&mut op.joined, op.t, &op.y, &op.yp);
    let tolerance = spectrum::tolerance(op.rtol, &op.y, &op.atol).expect("tolerance");
    let worst = f
        .iter()
        .zip(&tolerance)
        .map(|(r, t)| r.abs() / t)
        .fold(0., f64::max);
    assert!(
        worst.is_finite(),
        "the residual at the saved state is not finite"
    );
    println!(
        "{path}: {two_phase} two-phase cell(s); state residual {worst:.3e} (row / coordinate tolerance)"
    );
}

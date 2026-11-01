//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-a3-pilot
//! The S3 composition (lead decision S3-D28 (3)) as one builder, the same
//! steps in the same order as KERN's settle-state probe (`s3_settle.rs`):
//! - the joined operator of the S3 packet (spray line composed closed,
//!   S3-D25; SG two-zone contact map, S3-D26), the S3-D12 feed gate declared
//!   (S3-D27) before any structure;
//! - the derived tolerance classes of S2-D24r/S3-D16 at the start state;
//! - IC-CTRL's normal PZR pressure control in AUTO, heater changes class S
//!   (S3-D4), spray demand zero;
//! - L1 and the regular cells' phase modes armed;
//! - ELEC's slice appended (generator, shaft, turbine on the SG owner's
//!   admitted steam, GCB closed, AC routing), connected at full load, its
//!   stator classes from S3-D23's budget (10 A, 1 MW);
//! - the exact consistent start at t0.
//!
//! From a saved S3 state (KERN's settled S3 state: the operator's `y`/`y'`,
//! the appended slice's and every owner's discrete state, S3-D19) the
//! composition is the same, the slice's coordinates are the saved ones, the
//! system's discrete state is restored exactly before the consistent start,
//! and the controller is re-commissioned at the start after the restore (the
//! heater demand in force is the PZR block's discrete state; the settle
//! state says so).
//!
//! Inputs: [`super::inputs::Inputs`] (the spine, the I&C and PZR control
//! sections, ELEC's packet).
use super::{
    inputs::Inputs,
    profile::{GUIDE_CURRENT_BASIS_PA, MAX_ORDER, RESTART, Solver},
    pzr_control::{self, PzrClient},
    spine::{Started, credited_outputs, started_full_composition},
};
use crate::{
    If97,
    electrical::{Configuration, CreditedBudget, Electrified, N},
    frame::{Class, Frame},
    ida::{Ida, Initial},
    joined::{
        DerivedTolerances, Discrete, Integrated, JoinedSystem, Restart, derived_tolerances,
        discrete_restart, root_directions,
    },
};
use leitbild_operating_plant::{
    control::pzr_pressure::{Law, Section as ControlSection},
    electrical::{
        breaker::{self, Breaker, Contact},
        bus::{self, Distribution, SourceState},
        slice::{self, Inputs as SliceInputs, Slice},
    },
    joined::{blocks::JoinedJacobian, presence::VaporPresence},
};
use serde_json::{Value, json};

pub type Unit = Electrified<Integrated<If97>>;

/// A reference run's tolerance scaling: the relative tolerance by
/// `relative`, every absolute tolerance (derived classes included) by
/// `absolute` (S2's references: rtol/10 with atol/10 for a hold, rtol/100
/// with atol/10 for R2; 1, 1 for the run itself).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scaling {
    pub relative: f64,
    pub absolute: f64,
}
impl Scaling {
    pub const NONE: Self = Self {
        relative: 1.,
        absolute: 1.,
    };
}
/// The RCPs in the electrical slice's consumer order (KERN's settle).
pub const ROTOR_CONSUMERS: [&str; 4] = ["LD01.P.A1", "LD01.P.A2", "LD01.P.B1", "LD01.P.B2"];

fn read_json(path: &str) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?)
        .map_err(|e| format!("{path}: {e}"))
}
fn f(v: &Value, path: &[&str]) -> Result<f64, String> {
    let mut x = v;
    for k in path {
        x = &x[*k];
    }
    x.as_f64()
        .ok_or_else(|| format!("the electrical packet's {} is not a number", path.join(".")))
}
fn vector(v: &Value) -> Result<Vec<f64>, String> {
    v.as_array()
        .ok_or("a state vector is not a number array")?
        .iter()
        .map(|x| {
            x.as_f64()
                .ok_or_else(|| "a state entry is not a number".to_string())
        })
        .collect()
}
fn section<T: serde::de::DeserializeOwned>(e: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(e[key].clone())
        .map_err(|x| format!("the electrical packet's {key}: {x}"))
}

/// A composed S3 unit at its consistent start.
pub struct S3Unit<J: JoinedSystem = Integrated<If97>> {
    pub ida: Ida<Electrified<J>>,
    pub t0: f64,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    /// The operator's dimension (the slice's coordinates follow).
    pub n: usize,
    pub network_ids: Vec<f64>,
    pub atol: Vec<f64>,
    pub rtol: f64,
    pub derived: DerivedTolerances,
    pub restart: Restart,
    pub control: PzrClient,
    /// Whether the packet composes the compact feed train with the
    /// three-element SG level control (plan r4 X4.1): continuous, in the
    /// SG owner; a case harness may record it (class O).
    pub feed_train: bool,
    pub frame: Frame,
    pub receipt: Value,
    /// The operator at the packet's prepared hot reference (the composed
    /// state): the acquired protection's references (IC-PROT, 5a4f3228).
    pub reference: Vec<f64>,
}

/// The pieces of the electrical slice at the packet's prepared state.
type SlicePieces = (Slice, Breaker, Distribution, Configuration, [f64; N]);

/// The electrical slice at the packet's prepared state, connected.
fn electrical(e: &Value, rotors: usize, t0: f64) -> Result<SlicePieces, String> {
    let v_line = f(e, &["boundary", "lineVoltage_V"])?;
    let f0 = f(e, &["boundary", "frequency_Hz"])?;
    let live = SourceState {
        energized: true,
        voltage_pu: 1.,
        frequency_hz: f0,
    };
    let params: slice::Parameters = section(e, "slice")?;
    let room = f(e, &["prepared", "room_K"])?;
    let slice = Slice::new(
        params,
        SliceInputs {
            joined: true,
            v_line,
            f_grid_hz: f0,
            carrier_rad_s: slice::prepared_carrier(f0),
            carrier_accel_rad_s2: 0.,
            carrier_from_s: t0,
            admitted_kg_s: 0.,
            field_v: f(e, &["prepared", "fieldDemand_V"])?,
            room_k: room,
            unit_draw_w: 0.,
            reserve_draw_w: 0.,
        },
    )
    .map_err(|x| format!("the electrical slice: {x:?}"))?;
    let routing = Distribution::prepared(
        section::<bus::Parameters>(e, "distribution")?,
        [live, live],
        [true, true],
        t0,
    )
    .map_err(|x| format!("the AC routing: {x:?}"))?;
    let breaker = Breaker::new(
        section::<breaker::Parameters>(e, "breaker")?,
        Contact::Closed,
    )
    .map_err(|x| format!("the generator breaker: {x:?}"))?;
    let configuration = Configuration {
        rotor_consumers: (0..rotors)
            .map(|r| ROTOR_CONSUMERS[r].to_string())
            .collect(),
        feed_pumps: vec!["LD01.FW.P1".into(), "LD01.FW.P2".into()],
        field_bus: e["fieldConverterBus"]
            .as_str()
            .ok_or("the electrical packet's fieldConverterBus")?
            .into(),
        field_demand_v: f(e, &["prepared", "fieldDemand_V"])?,
        fixture_demands_w: section(e, "fixtureConsumerDemand_W")?,
    };
    let mut tail = [0.; N];
    let flux: Vec<f64> = section(&e["prepared"], "initialFlux")?;
    if flux.len() != 3 {
        return Err(format!("{} initial fluxes, not 3", flux.len()));
    }
    tail[..3].copy_from_slice(&flux);
    tail[slice::OMEGA] = f(e, &["prepared", "speed_rad_s"])?;
    tail[slice::THETA] = f(e, &["prepared", "angle_rad"])?;
    tail[slice::BODY] = room;
    Ok((slice, breaker, routing, configuration, tail))
}

/// The S3 composition at `state` (`{t_s, packet, y, yp}` of the packet,
/// with `appended` and `discrete_state` when it is a saved S3 state).
pub fn compose(inputs: &Inputs, state: &Value, solver: Solver) -> Result<S3Unit, String> {
    compose_with(inputs, state, Scaling::NONE, solver, Ok)
}

/// [`compose`] with every tolerance scaled by `scaling` (a reference run)
/// and the integrated operator wrapped by `wrap` before the slice is
/// appended (the ledgered unit for the gate harness).
#[allow(clippy::too_many_lines)] // One composition, step by step as KERN's settle.
pub fn compose_with<J: JoinedSystem>(
    inputs: &Inputs,
    state: &Value,
    scaling: Scaling,
    solver: Solver,
    wrap: impl FnOnce(Integrated<If97>) -> Result<J, String>,
) -> Result<S3Unit<J>, String> {
    compose_governed_with(inputs, state, scaling, solver, None, wrap)
}

/// X4.3 (lane TURB): [`compose`] with the LOAD governor, ADM and GEN.WT
/// after the slice ([`super::turbine::Turbine`]).
pub fn compose_governed(
    inputs: &Inputs,
    state: &Value,
    solver: Solver,
    turbine: &super::turbine::Turbine,
) -> Result<S3Unit, String> {
    compose_governed_with(inputs, state, Scaling::NONE, solver, Some(turbine), Ok)
}

/// [`compose_with`] with the X4.3 governor when `turbine` is given: in LOAD
/// from the start with the request at the start's terminal export (the
/// settled GEN.WT, wiki), ADM at its prepared full opening and the owner's
/// tracking transfer `I = ADM - Kp e`.
#[allow(clippy::too_many_lines)] // One composition, step by step as KERN's settle.
pub fn compose_governed_with<J: JoinedSystem>(
    inputs: &Inputs,
    state: &Value,
    scaling: Scaling,
    solver: Solver,
    turbine: Option<&super::turbine::Turbine>,
    wrap: impl FnOnce(Integrated<If97>) -> Result<J, String>,
) -> Result<S3Unit<J>, String> {
    let packet_path = &inputs.spine.packet_path;
    if state["packet"].as_str() != Some(packet_path.as_str()) {
        return Err(format!(
            "the start state is of another packet: {}",
            state["packet"]
        ));
    }
    let (y, yp) = (vector(&state["y"])?, vector(&state["yp"])?);
    let t0 = state["t_s"].as_f64().ok_or("the start state has no t_s")?;
    let saved = !state["discrete_state"].is_null();
    let frame = Frame::new(inputs.ic.frame_s)?;
    if (t0 / inputs.ic.frame_s - (t0 / inputs.ic.frame_s).round()).abs() >= 1e-9 {
        return Err(format!(
            "the start {t0} s is not a frame instant (the control channel commissions there)"
        ));
    }
    let Started {
        mut joined,
        network_ids,
        mut atol,
        rtol,
        y: reference,
        ..
    } = started_full_composition(&inputs.spine)?;
    if y.len() != joined.dimension() {
        return Err(format!(
            "{} coordinates against {}",
            y.len(),
            joined.dimension()
        ));
    }
    // The S3 packet composes the spray line closed (S3-D25); a packet
    // without it is composed as it is and reported (`spray_path`), for the
    // caller to refuse or disclose.
    let spray_path = joined.network.spray().is_some();
    joined
        .declare_feed_gate()
        .map_err(|e| format!("feed gate: {e:?}"))?;
    let structure = JoinedJacobian::compile_for(&mut joined, t0, &y, None)
        .map_err(|e| format!("structure: {e:?}"))?;
    // R4-GUIDE-BASIS: the guide-current class from the operator-grade
    // basis, the core-DP output's budget only (the contract's 50 Pa stays
    // the S2 record).
    let mut credited = credited_outputs(&joined, &inputs.spine)?;
    for c in credited.iter_mut().filter(|c| c.name == "core_dp_pa") {
        c.budget = GUIDE_CURRENT_BASIS_PA;
    }
    let derived = derived_tolerances(
        &mut joined,
        &structure,
        t0,
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
    let control_section: ControlSection =
        serde_json::from_value(read_json(&inputs.control_path)?).map_err(|e| e.to_string())?;
    let law = Law::new(&control_section).map_err(|e| format!("{e:?}"))?;
    if law.frame_s() != inputs.ic.frame_s {
        return Err("the control frame is not the I&C frame".into());
    }
    let channel = pzr_control::channel_block(&inputs.control_wiki, &law)?;
    // From the S2 state (KERN's settle): commissioned, then L1 and the
    // phase modes armed. From a saved S3 state: the operator's discrete
    // state restored (it declares L1 from its locks and sets the phase
    // modes, as KERN's snapshot round trip does), then the controller
    // re-commissioned on the restored operator.
    let (control, prepared_w, start_w, l1_changes) = if saved {
        joined
            .restore_discrete_state(&state["discrete_state"]["operator"])
            .map_err(|e| format!("restore the operator's discrete state: {e:?}"))?;
        let (c, p, s) =
            pzr_control::commission(&mut joined, &law, channel, Class::S, None, t0, &y, &yp)?;
        (c, p, s, None)
    } else {
        let (c, p, s) =
            pzr_control::commission(&mut joined, &law, channel, Class::S, None, t0, &y, &yp)?;
        let l1 = joined
            .activate_unilateral(t0, &y)
            .map_err(|e| format!("L1: {e:?}"))?;
        joined
            .activate_phase_modes()
            .map_err(|e| format!("phase modes: {e:?}"))?;
        (c, p, s, Some(l1.changes.len()))
    };
    let mut control = control;
    // Plan r4 X4.1: the SG owner's continuous feed control (it decides no
    // change; its AUTO point is the state's own).
    let sg_section: leitbild_operating_plant::sg::packet::Section =
        serde_json::from_value(inputs.spine.packet_json()?["secondary"].clone())
            .map_err(|e| format!("the packet's secondary section: {e}"))?;
    let feed_train = sg_section.feed_train.is_some() && sg_section.apparent_level.is_some();
    // FEED (plan r4): the SG owner's operator-grade absolute tolerances for
    // its control coordinates replace the stock scaled floor there.
    if let Some(sec) = joined.secondary() {
        let base = joined.offsets().secondary;
        let scales = sec.layout().scales.clone();
        for (i, a) in sec.operator_tolerances() {
            atol[base + i] = a / scales[i];
        }
    }
    let ids = joined.differential(&network_ids);
    let n = joined.dimension();
    let nonnegative = joined.network.nonnegative_stocks();
    let presence = VaporPresence::of(&joined.network, &joined.network.declared_presence(&y));
    let mut integrated = Integrated::following_presence(joined, t0, &y, &presence)
        .map_err(|e| format!("integrable: {e:?}"))?;
    integrated.set_first_step(solver.first_step)?;
    let integrated = wrap(integrated)?;
    let e = read_json(&inputs.elec_path)?;
    let rotors = integrated.integrated().joined.network.rotor_count();
    let (slice, breaker, routing, configuration, mut tail) = electrical(&e, rotors, t0)?;
    let mut unit = Electrified::new(integrated, slice, breaker, routing, configuration)
        .map_err(|e| format!("the electrical slice: {e:?}"))?;
    if saved {
        unit.restore_appended_discrete_state(&state["discrete_state"]["appended"])
            .map_err(|e| format!("restore the slice's discrete state: {e}"))?;
    }
    let mut tail_rates = [0.; N];
    let tail_ids = unit
        .appended_start(t0, &mut tail, &mut tail_rates)
        .map_err(|e| format!("the slice's prepared start: {e:?}"))?;
    let v_line = f(&e, &["boundary", "lineVoltage_V"])?;
    let f0 = f(&e, &["boundary", "frequency_Hz"])?;
    let s_flux = v_line / (2. * std::f64::consts::PI * f0);
    let s_cur = f(&e, &["boundary", "base_VA"])? / v_line;
    let mut slice_atol = vec![
        1e-8 * s_flux,
        1e-8 * s_flux,
        1e-8 * tail[2].abs(),
        1e-8 * s_cur,
        1e-8 * s_cur,
        1e-8 * f(&e, &["prepared", "fieldCurrent_A"])?,
        1e-8 * tail[slice::OMEGA],
        1e-8,
        1e-8 * tail[slice::BODY],
    ];
    // S3-D23 declares the electrical budgets (10 A, 1 MW) for S3-D16.
    let budget = CreditedBudget {
        ieq_a: 10.,
        export_w: 1e6,
    };
    let stator = unit.derived_rows(n, &slice_atol, budget);
    for r in &stator {
        slice_atol[r.coordinate - n] = r.applied_scaled;
    }
    // A saved S3 state carries the slice's own coordinates.
    let (tail, tail_rates) = if saved {
        let (a, b) = (
            vector(&state["appended"]["y"])?,
            vector(&state["appended"]["yp"])?,
        );
        if a.len() != N || b.len() != N {
            return Err(format!(
                "the saved slice has {} coordinates, not {N}",
                a.len()
            ));
        }
        (a, b)
    } else {
        (tail.to_vec(), tail_rates.to_vec())
    };
    // X4.3: the governor after the slice, in LOAD at the start's export.
    let (tail, tail_rates, governor_receipt) = match turbine {
        None => (tail, tail_rates, Value::Null),
        Some(tb) => {
            let pole_pairs = unit.slice.parameters.generator.pole_pairs;
            let omega0 = slice::prepared_carrier(f0) / pole_pairs;
            let export = unit.slice.export_w(&tail);
            let g = leitbild_operating_plant::turbine::governor::Governor::new(
                tb.parameters(omega0),
                t0,
                export,
                export,
            )?;
            let opening = 1.;
            let integral = g.tracking_integral(t0, export, tail[slice::OMEGA], opening);
            unit.declare_governor(g)?;
            slice_atol.extend([1e-8 * tb.governor.base_w, 1e-8, 1e-8]);
            let mut tail = tail;
            tail.extend([export, integral, opening]);
            let mut rates = tail_rates;
            rates.extend([0.; 3]);
            let receipt = json!({"inputs": tb.receipt(), "omega0_rad_s": omega0, "start": {"request_W": export,
                "watt_W": export, "integral": integral, "opening": opening, "mode": "LOAD (tracking transfer at the start)"}});
            (tail, rates, receipt)
        }
    };
    let mut y_all = [y.as_slice(), &tail].concat();
    let mut yp_all = [yp.as_slice(), &tail_rates].concat();
    let mut tail_ids = tail_ids;
    if turbine.is_some() {
        tail_ids.extend([1.; 3]);
    }
    let ids_all = [ids.as_slice(), &tail_ids].concat();
    // A reference scales every tolerance, derived classes included (the
    // record the frame driver checks is scaled the same way).
    let rtol = rtol * scaling.relative;
    let atol_all: Vec<f64> = [atol.as_slice(), &slice_atol]
        .concat()
        .iter()
        .map(|a| a * scaling.absolute)
        .collect();
    let mut derived = derived;
    derived.relative *= scaling.relative;
    for r in &mut derived.rows {
        r.applied_scaled *= scaling.absolute;
        r.applied *= scaling.absolute;
    }
    let restart: Restart = RESTART;
    let mut ida = Ida::new(
        unit,
        Initial {
            time: t0,
            y: &y_all,
            yp: &yp_all,
            differential: &ids_all,
            absolute_tolerance: &atol_all,
            relative_tolerance: rtol,
        },
    )
    .map_err(|e| format!("stock IDA: {e:?}"))?;
    ida.set_max_order(MAX_ORDER).map_err(|e| format!("{e:?}"))?;
    solver.weights.apply(&mut ida)?;
    ida.constrain_nonnegative(&nonnegative)
        .map_err(|e| format!("{e:?}"))?;
    restart.configure(&mut ida).map_err(|e| format!("{e:?}"))?;
    root_directions(&mut ida).map_err(|e| format!("{e:?}"))?;
    let initial = discrete_restart(
        &mut ida,
        t0,
        Discrete::TimeEvent,
        &mut y_all,
        &network_ids,
        &atol_all,
        rtol,
        &restart,
    )
    .map_err(|e| format!("the exact consistent start of the S3 composition: {e}"))?;
    yp_all.clone_from(&initial.yp);
    control.scratch = vec![0.; y_all.len()];
    let receipt = json!({
        "composition": "S3-D28 (3): joined + spray closed + SG two-zone + feed gate declared + S2-D24r/S3-D16 + PZR control AUTO (S) + L1 + phase modes + ELEC slice connected",
        "tolerance_scaling": {"relative": scaling.relative, "absolute": scaling.absolute},
        "weights": solver.weights, "first_step": solver.first_step, "weight_groups": ida.weight_groups().map(|g| g.sizes().len()),
        "from_saved_s3_state": saved, "t0_s": t0, "spray_path": spray_path,
        "sections": {"ic": inputs.ic_path, "pzr_control": inputs.control_path, "control_wiki": inputs.control_wiki, "electrical": inputs.elec_path},
        "l1_activation_changes": l1_changes,
        "feed_control": feed_train.then(|| json!({"class": "C (continuous, in the SG owner; owner 31 Oct 2026)", "start": "AUTO at the state's tracked point (the composed or carried state)"})),
        "pzr_control": {"class": "S (S3-D4)", "prepared_request_w": prepared_w, "start_request_w": start_w,
            "commissioned": if saved { "after restoring the saved discrete state" } else { "before L1 is armed (KERN's settle order)" }},
        "stator_rows": stator, "stator_budget": "S3-D23: 10 A, 1 MW",
        "governor": governor_receipt,
        "start": {"projection_passes": initial.report.projection_passes, "residual": initial.report.residual.value,
            "correction_wrms": initial.report.correction_wrms, "appended": initial.appended},
    });
    Ok(S3Unit {
        ida,
        t0,
        y: y_all,
        yp: yp_all,
        n,
        network_ids,
        atol: atol_all,
        rtol,
        derived,
        restart,
        control,
        feed_train,
        frame,
        receipt,
        reference,
    })
}

/// The S3 cases block (`ld01-s3-cases-c1c3`) of a page, as JSON.
pub fn cases_block(page: &str) -> Result<Value, String> {
    let open = "```ld01-s3-cases-c1c3\n";
    let mut found = page.match_indices(open).map(|(i, _)| i);
    let start = found.next().ok_or("no ld01-s3-cases-c1c3 block")? + open.len();
    if found.next().is_some() {
        return Err("more than one ld01-s3-cases-c1c3 block".into());
    }
    let end = start + page[start..].find("\n```").ok_or("unterminated block")?;
    serde_json::from_str(&page[start..end]).map_err(|e| e.to_string())
}

/// S3-D35 (lead, 15 Oct; DR-P3-PT1-2): every S3 settle bounds IDA's step by
/// the declared `settling.maxStep_s` of the S3 block (settling phase only),
/// so the settling measure reads step-resolved outputs, not a long step's
/// interpolant. Absent, nonpositive or nonfinite refuses.
pub fn settle_max_step(block: &Value) -> Result<f64, String> {
    match block.pointer("/settling/maxStep_s").and_then(Value::as_f64) {
        Some(h) if h.is_finite() && h > 0. => Ok(h),
        Some(h) => Err(format!("settling.maxStep_s {h} is not a positive step")),
        None => Err("the S3 block declares no settling.maxStep_s (S3-D35)".into()),
    }
}

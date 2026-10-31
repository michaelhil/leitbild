//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The S2 composition at the hot reference (memo §3 (A)-(D), the S2
//! declaration's steps (A)-(D)), the one builder of the joined spine:
//! S1's network-only settling exports the flows (A), the hydrostatic and
//! flowing preparations compose the network (B), the joined operator
//! composes the nuclear, solids, SG secondary and rod owners, the owners
//! prepare their algebraic coordinates and the fixed-stock surfaces
//! initialize (C), and the exact consistent start projects and solves the
//! rates on the block assembly (D, lead decision S2-D4). Before (D), stock
//! IDACalcIC makes the algebraic coordinates consistent (lead decision
//! DR13-ROD-A: the rod owner's mouth currents start at zero); the rod
//! bores' water leaves the sector inventory before the network is compiled
//! (OU-C P2).
//!
//! The tolerance classes are S1's (`ld01-s1-gates`): the network's own
//! classes and the scaled stock floor for every new coordinate class (G12).
//! Each caller (the S2 gate harness, the regression tiers, the S3
//! composition) keeps its own receipt of these steps.
use super::{
    inputs::Spine,
    profile::{self, SETTINGS, START_BOUND, SURFACES, error_weights},
};
use crate::{
    If97,
    ida::{Ida, Initial},
    joined::{Analyses, DerivedTolerances, Matrices, Report, consistent_start as joined_start},
    network::Integrated as NetworkIntegrated,
};
use leitbild_operating_plant::{
    digest::sha256,
    initialization::SurfaceInitialization,
    joined::{
        block::Transaction,
        blocks::JoinedJacobian,
        operator::{Joined, RodPort, SecondaryPort},
        packet,
    },
    network::{
        CreditedOutput, Network, ToleranceClasses, consistent_start,
        packet::Packet as NetworkPacket,
        prepare::{self, OperatingPoint},
    },
    rods::{Carve, RodBlock, Section as RodSection, carve},
    sg::{packet::Section as SecondarySection, secondary::Secondaries},
};
use serde_json::{Value, json};

/// S1's declared network-only settling (`ld01-s1-gates`): its tolerance
/// classes, BDF order and settling criteria.
#[derive(Clone, Copy, Debug)]
pub struct S1Settling {
    pub classes: ToleranceClasses,
    pub max_order: usize,
    pub max_simulated_s: f64,
    pub window_s: f64,
    pub rotor_speed_relative: f64,
    pub loop_flow_relative_change: f64,
}
impl S1Settling {
    /// From the `ld01-s1-gates` block's JSON.
    pub fn from_gates(gates: &Value) -> Result<Self, String> {
        let f = |p: &str| {
            gates
                .pointer(p)
                .and_then(Value::as_f64)
                .ok_or_else(|| format!("ld01-s1-gates declares no number {p}"))
        };
        Ok(Self {
            classes: profile::classes(gates)?,
            max_order: gates["maxOrder"]
                .as_u64()
                .ok_or("ld01-s1-gates declares no maxOrder")? as usize,
            max_simulated_s: f("/settling/maxSimulated_s")?,
            window_s: f("/settling/window_s")?,
            rotor_speed_relative: f("/settling/rotorSpeedRelative")?,
            loop_flow_relative_change: f("/settling/loopFlowRelativeChange")?,
        })
    }
}

/// Step (A)'s export and its record.
#[derive(Clone, Debug)]
pub struct Settled {
    /// Every face's settled liquid volume flow and the rotors' angular
    /// momenta.
    pub flows: Vec<f64>,
    pub momenta: Vec<f64>,
    /// The simulated time at which the settling criteria held.
    pub settled_at_s: Option<f64>,
    /// The two loops' return mass flows and the rotor speeds at the last
    /// whole second.
    pub loop_mass_flow_kg_s: [f64; 2],
    pub rotor_speed_rad_s: Vec<f64>,
    pub steps: i64,
    pub residuals: i64,
    pub jacobians: i64,
    pub error_failures: i64,
    pub convergence_failures: i64,
    /// The network's exact consistent start, as reported.
    pub initial_pair: String,
    pub cpu_s: f64,
}

/// Step (A): S1's declared network-only settling from rest, run only to
/// export the settled flows: the RCPs start from rest through the drive law
/// and the network settles under S1's own tolerance classes and caps. A
/// settling that does not rest by `max_simulated_s` refuses.
pub fn s1_settled_flows(
    packet: &NetworkPacket,
    s1: &S1Settling,
    clock: fn() -> f64,
) -> Result<Settled, String> {
    let started = clock();
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let (network, prepared, _) =
        prepare::prepare(packet, If97, &point, &profile::rotors(), &SETTINGS)
            .map_err(|e| format!("hydrostatic: {e:?}"))?;
    let mut y = prepared.y.clone();
    for i in &network.rotor_index {
        y[*i] = 0.;
    }
    let classes = s1.classes;
    let atol = network
        .absolute_tolerances(&y, classes)
        .map_err(|e| format!("S1 tolerances: {e:?}"))?;
    let rtol = classes.relative;
    let ids = prepared.differential.clone();
    let weights = error_weights(&y, rtol, &atol);
    let mut probe = network;
    let (yp, pair) = consistent_start(&mut probe, 0., &mut y, &ids, &weights, START_BOUND, 2)
        .map_err(|e| format!("S1 exact consistent start: {e:?}"))?;
    let nonnegative = probe.nonnegative_stocks();
    let system = NetworkIntegrated::colored(probe).map_err(|e| format!("{e:?}"))?;
    let mut ida = Ida::new(
        system,
        Initial {
            time: 0.,
            y: &y,
            yp: &yp,
            differential: &ids,
            absolute_tolerance: &atol,
            relative_tolerance: rtol,
        },
    )
    .map_err(|e| format!("stock IDA: {e:?}"))?;
    ida.set_max_order(s1.max_order)
        .map_err(|e| format!("{e:?}"))?;
    ida.constrain_nonnegative(&nonnegative)
        .map_err(|e| format!("{e:?}"))?;
    let cap = s1.max_simulated_s;
    let window = s1.window_s;
    let rotor_rel = s1.rotor_speed_relative;
    let flow_rel = s1.loop_flow_relative_change;
    ida.stop_at(cap).map_err(|e| format!("{e:?}"))?;
    let face = |id: &str| {
        packet
            .mechanics
            .faces
            .iter()
            .position(|f| f.id == id)
            .ok_or_else(|| format!("the packet has no face {id}"))
    };
    let loops = [face("RETURN.A->DOWN")?, face("RETURN.B->DOWN")?];
    let (mut yv, mut ypv) = (y.clone(), yp.clone());
    let mut history: Vec<(f64, [f64; 2], Vec<f64>)> = Vec::new();
    let mut t = 0.;
    let settled_at = loop {
        t += 1.;
        ida.advance(t, &mut yv, &mut ypv)
            .map_err(|e| format!("S1 settling at {t} s: {e:?}"))?
            .reached()
            .map_err(|e| format!("S1 settling at {t} s: {e:?}"))?;
        let net = &mut ida.system_mut().network;
        net.evaluate(t, &yv, &ypv, None, 0., None)
            .map_err(|e| format!("{e:?}"))?;
        let mut flows = [0.; 2];
        for (k, f) in loops.iter().enumerate() {
            flows[k] = net
                .chart(*f, 0)
                .ok_or_else(|| format!("no chart on loop face {f}"))?
                .mass_flow_kg_s
                .value;
        }
        let omega: Vec<f64> = net
            .rotor_index
            .iter()
            .map(|i| yv[*i] * net.scales()[*i] / net.rotor_inertia())
            .collect();
        let w0 = net.drive().reference_omega_rad_s;
        history.push((t, flows, omega.clone()));
        let earlier = history.iter().rev().find(|h| h.0 <= t - window);
        let rested = earlier.is_some_and(|e| {
            omega.iter().all(|w| ((w - w0) / w0).abs() < rotor_rel)
                && (0..2).all(|k| ((flows[k] - e.1[k]) / flows[k]).abs() < flow_rel)
        });
        if rested {
            break Some(t);
        }
        if t >= cap {
            break None;
        }
    };
    let stats = ida.stats().map_err(|e| format!("{e:?}"))?;
    let net = &mut ida.system_mut().network;
    net.evaluate(t, &yv, &ypv, None, 0., None)
        .map_err(|e| format!("{e:?}"))?;
    let flows: Vec<f64> = (0..net.face_count())
        .map(|f| net.chart(f, 0).map_or(0., |c| c.volume_flow_m3_s.value))
        .collect();
    let momenta: Vec<f64> = net
        .rotor_index
        .iter()
        .map(|i| yv[*i] * net.scales()[*i])
        .collect();
    let last = history.last().ok_or("S1 settling took no step")?;
    let settled = Settled {
        flows,
        momenta,
        settled_at_s: settled_at,
        loop_mass_flow_kg_s: last.1,
        rotor_speed_rad_s: last.2.clone(),
        steps: stats.steps,
        residuals: stats.residuals,
        jacobians: stats.jacobians,
        error_failures: stats.error_failures,
        convergence_failures: stats.convergence_failures,
        initial_pair: format!("{pair:?}"),
        cpu_s: clock() - started,
    };
    if settled_at.is_none() {
        return Err(format!(
            "S1 settling did not rest within {cap} s: {}",
            settled.summary()
        ));
    }
    Ok(settled)
}

impl Settled {
    /// The joined spine's record of step (A) (NOT-EVIDENCE: run only to
    /// export the settled flows).
    pub fn summary(&self) -> Value {
        json!({
            "scope": "NOT-EVIDENCE: S1's declared network-only settling, run only to export settled flows (memo §3 (A))",
            "settled_at_s": self.settled_at_s,
            "loop_mass_flow_kg_s": self.loop_mass_flow_kg_s,
            "rotor_speed_rad_s": self.rotor_speed_rad_s,
            "steps": self.steps, "residuals": self.residuals, "jacobians": self.jacobians,
            "error_failures": self.error_failures, "convergence_failures": self.convergence_failures,
            "initial_pair": self.initial_pair,
            "cpu_s": self.cpu_s,
        })
    }
}

/// Step (B)'s network, its state and differential identity, and the
/// flowing preparation's receipt.
pub type ComposedNetwork = (Network<If97>, Vec<f64>, Vec<f64>, Value);

/// Step (B): a fresh hydrostatic preparation at the hot-reference water
/// energies with the declared PZR, then the S1-settled volume flows and
/// rotor momenta transferred by the flowing preparation.
pub fn composed_network(
    packet: &NetworkPacket,
    flows: &[f64],
    momenta: &[f64],
) -> Result<ComposedNetwork, String> {
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let (mut network, mut prepared, hydrostatic) =
        prepare::prepare(packet, If97, &point, &profile::rotors(), &SETTINGS)
            .map_err(|e| format!("hydrostatic: {e:?}"))?;
    let receipt = prepare::compose_flows(
        &mut network,
        packet,
        &mut prepared.y,
        hydrostatic.port_pressure_pa,
        flows,
        momenta,
        &SETTINGS,
    )
    .map_err(|e| format!("flowing preparation: {e:?}"))?;
    let ids = prepared.differential.clone();
    let receipt = serde_json::to_value(&receipt).map_err(|e| e.to_string())?;
    Ok((network, prepared.y, ids, receipt))
}

/// Steps (A)-(C) composed, before the exact consistent start.
pub struct Prepared {
    pub joined: Joined<If97>,
    pub y: Vec<f64>,
    /// Joined differential identity, and the network's own (for restarts).
    pub ids: Vec<f64>,
    pub network_ids: Vec<f64>,
    /// S1's classes in solver scaling: the network's own, the scaled stock
    /// floor for every new coordinate class (G12).
    pub atol: Vec<f64>,
    pub classes: ToleranceClasses,
    /// The flowing preparation's receipt, the owners' preparation
    /// transactions and the surface initializations.
    pub flowing: Value,
    pub owners: Vec<Transaction>,
    pub surfaces: Vec<SurfaceInitialization>,
}

/// The packet's readings: the network's with the rod bores' water carved
/// out of the sector inventory (OU-C P2, before the network is compiled or
/// settled), the joined owners', the raw JSON (the owners' sections), the
/// rods section and its carve.
pub struct Packets {
    pub network: NetworkPacket,
    pub joined: packet::Packet,
    pub raw: Value,
    pub rods: RodSection,
    pub carved: Carve,
}
pub fn packets(bytes: &[u8]) -> Result<Packets, String> {
    let mut network: NetworkPacket =
        serde_json::from_slice(bytes).map_err(|e| format!("network packet: {e}"))?;
    let joined = serde_json::from_slice(bytes).map_err(|e| format!("joined packet: {e}"))?;
    let raw: Value = serde_json::from_slice(bytes).map_err(|e| format!("packet json: {e}"))?;
    let rods: RodSection =
        serde_json::from_value(raw["rods"].clone()).map_err(|e| format!("rods section: {e}"))?;
    let carved = carve(&rods, &mut network).map_err(|e| format!("rods carve: {e:?}"))?;
    Ok(Packets {
        network,
        joined,
        raw,
        rods,
        carved,
    })
}

/// Steps (B)-(C) on step (A)'s export (every face's settled volume flow and
/// the rotors' momenta): the composed network, the joined
/// operator with its SG secondary and rod owners, the owners' prepared
/// algebraic coordinates, the initialized surfaces, S1's tolerance classes
/// (G12), the PZR relief lift's root bound (G6: its absolute tolerance,
/// the scaled floor at its unit scale, bounds its distance from a stop) and
/// stock IDACalcIC's consistent algebraic coordinates (DR13-ROD-A, G13's
/// first step its horizon). `singles` are the clusters that keep their bore
/// water singly (P2: a cluster declared stuck must be one).
pub fn prepare(
    bytes: &[u8],
    flows: &[f64],
    momenta: &[f64],
    classes: ToleranceClasses,
    singles: &[usize],
) -> Result<Prepared, String> {
    let Packets {
        network: network_packet,
        joined: joined_packet,
        raw,
        rods,
        carved,
    } = packets(bytes)?;
    let (network, y_network, network_ids, flowing) =
        composed_network(&network_packet, flows, momenta)?;
    let section: SecondarySection = serde_json::from_value(raw["secondary"].clone())
        .map_err(|e| format!("secondary section: {e}"))?;
    let mut joined = Joined::new(
        network,
        &network_packet,
        &joined_packet,
        If97,
        SecondaryPort::Owner(Box::new(
            Secondaries::new(&section, &joined_packet.thermal.secondaries, &If97)
                .map_err(|e| format!("SG secondary owner: {e:?}"))?,
        )),
        RodPort::Owner(Box::new(
            RodBlock::from_packet(&rods, &network_packet, &carved, &If97, singles)
                .map_err(|e| format!("rod owner: {e:?}"))?,
        )),
    )
    .map_err(|e| format!("joined operator: {e:?}"))?;
    let mut y = joined
        .prepared(&y_network)
        .map_err(|e| format!("joined prepared state: {e:?}"))?;
    let ids = joined.differential(&network_ids);
    let owners = joined
        .prepare_owners(0., &mut y)
        .map_err(|e| format!("owner preparation: {e:?}"))?;
    let surfaces = joined
        .initialize_surfaces(0., &mut y, SURFACES)
        .map_err(|e| format!("surfaces: {e:?}"))?;
    let n_net = joined.offsets().nuclear;
    let mut atol = joined
        .network
        .absolute_tolerances(&y[..n_net], classes)
        .map_err(|e| format!("tolerances: {e:?}"))?;
    atol.resize(y.len(), classes.stock_scaled);
    joined
        .pzr_mut()
        .declare_lift_root_bound(classes.stock_scaled)
        .map_err(|e| format!("lift root bound: {e:?}"))?;
    let joined = crate::joined::stock_initial_conditions(
        joined,
        0.,
        &mut y,
        &ids,
        &atol,
        classes.relative,
        profile::FIRST_STEP_S,
    )
    .map_err(|e| format!("stock IDACalcIC: {e}"))?;
    Ok(Prepared {
        joined,
        y,
        ids,
        network_ids,
        atol,
        classes,
        flowing,
        owners,
        surfaces,
    })
}

/// The full composition at the hot reference, consistently started.
pub struct Started {
    pub joined: Joined<If97>,
    pub y: Vec<f64>,
    pub yp: Vec<f64>,
    /// Differential identity (joined, then the network's own), absolute
    /// tolerances and relative tolerance.
    pub ids: Vec<f64>,
    pub network_ids: Vec<f64>,
    pub atol: Vec<f64>,
    pub rtol: f64,
    /// A receipt of the preparation.
    pub receipt: Value,
    /// The composed state before its consistent start.
    pub unstarted: Vec<f64>,
    /// JAC's block structure compiled at the composed state, and the
    /// symbolic analyses the start made on it (lead decision S2-D4).
    pub structure: JoinedJacobian,
    pub analyses: Analyses,
}

/// Step (D) of a prepared composition: the block structure compiled at the
/// composed state and the exact consistent start on the block assembly
/// (S2-D4, three passes, [`START_BOUND`]). Returns the started parts, the
/// start's report and the CPU of the compile and of the start.
pub struct Start {
    pub yp: Vec<f64>,
    pub unstarted: Vec<f64>,
    pub structure: JoinedJacobian,
    pub analyses: Analyses,
    pub report: Report,
    pub compile_cpu_s: f64,
    pub start_cpu_s: f64,
}
pub fn start(p: &mut Prepared, clock: fn() -> f64) -> Result<Start, String> {
    let weights = error_weights(&p.y, p.classes.relative, &p.atol);
    let unstarted = p.y.clone();
    let timer = clock();
    let structure = JoinedJacobian::compile(&mut p.joined, 0., &p.y)
        .map_err(|e| format!("block structure: {e:?}"))?;
    let compile_cpu_s = clock() - timer;
    let mut analyses = Analyses::default();
    let timer = clock();
    let (yp, report) = joined_start(
        &mut p.joined,
        Matrices::Blocks {
            structure: &structure,
            analyses: &mut analyses,
        },
        0.,
        &mut p.y,
        &p.ids,
        &weights,
        START_BOUND,
        3,
    )
    .map_err(|e| format!("exact consistent start: {e:?}"))?;
    let start_cpu_s = clock() - timer;
    Ok(Start {
        yp,
        unstarted,
        structure,
        analyses,
        report,
        compile_cpu_s,
        start_cpu_s,
    })
}

/// The full composition at the hot reference, consistently started: memo
/// §3 (A)-(D), the start on the block assembly (lead decision S2-D4), on the
/// classes of `ld01-s1-gates` of the spine's wiki.
pub fn started_full_composition(spine: &Spine) -> Result<Started, String> {
    started_full_composition_with_singles(spine, &[])
}

/// [`started_full_composition`] with the clusters `singles` keeping their
/// bore water singly (P2: a cluster declared stuck must be one).
pub fn started_full_composition_with_singles(
    spine: &Spine,
    singles: &[usize],
) -> Result<Started, String> {
    let clock = super::clock::process_cpu_s;
    let gates = spine.s1_gates()?;
    let s1 = S1Settling::from_gates(&gates)?;
    let network_packet = packets(&spine.packet)?.network;
    let settled = s1_settled_flows(&network_packet, &s1, clock)?;
    let mut p = prepare(
        &spine.packet,
        &settled.flows,
        &settled.momenta,
        s1.classes,
        singles,
    )?;
    let start = start(&mut p, clock)?;
    let r = &start.report;
    let receipt = json!({
        "packet": spine.packet_path, "packet_sha256": sha256(&spine.packet), "provenance": super::provenance::receipt(spine)?,
        "s1_settling": settled.summary(), "flowing_preparation_max_cycle_drive_pa": p.flowing["max_cycle_drive_pa"],
        "owners_prepared": p.owners.iter().map(|t| t.receipt.clone()).collect::<Vec<_>>(),
        "surfaces_worst_residual_w": p.surfaces.iter().map(|s| s.residual_w.iter().fold(0., |a: f64, r| a.max(r.abs()))).fold(0., f64::max),
        "start": {"residual": [r.residual.value, r.residual.row], "constraint_rate": [r.constraint_rate.value, r.constraint_rate.row],
            "correction_wrms": r.correction_wrms, "projection_passes": r.projection_passes, "rate_passes": r.rate_passes,
            "assembly": r.assembly, "analyses": r.analyses, "cpu_s": start.start_cpu_s, "block_compile_cpu_s": start.compile_cpu_s},
        "dimension": p.y.len(), "algebraic": p.ids.iter().filter(|v| **v == 0.).count(),
        "tolerances": {"relative": s1.classes.relative, "network": "S1's tolerance classes (ld01-s1-gates)", "new_classes_scaled_absolute": s1.classes.stock_scaled, "basis": "G12"},
    });
    Ok(Started {
        joined: p.joined,
        y: p.y,
        yp: start.yp,
        ids: p.ids,
        network_ids: p.network_ids,
        atol: p.atol,
        rtol: s1.classes.relative,
        receipt,
        unstarted: start.unstarted,
        structure: start.structure,
        analyses: start.analyses,
    })
}

/// The credited outputs on the joined operator's pressure coordinates,
/// each with its budget from `ld01-accuracy-contract` (operating-hot-spine,
/// the spine's wiki): core DP, the LOWER and UPPER plena's pressure
/// difference, as the S2 gate harness defines it.
pub fn credited_outputs(
    joined: &Joined<If97>,
    spine: &Spine,
) -> Result<Vec<CreditedOutput>, String> {
    let contract = spine.accuracy_contract()?;
    let budget = contract["coreDifferentialPressure_Pa"]
        .as_f64()
        .ok_or("ld01-accuracy-contract declares no coreDifferentialPressure_Pa")?;
    let raw = spine.packet_json()?;
    let regions = raw["mechanics"]["regions"]
        .as_array()
        .ok_or("the packet has no mechanics.regions")?;
    let base = |id: &str| {
        regions
            .iter()
            .position(|r| r["id"] == id)
            .map(|c| joined.network.cell_layout[c].base)
            .ok_or_else(|| format!("the packet has no region {id}"))
    };
    Ok(vec![CreditedOutput {
        name: "core_dp_pa".into(),
        budget,
        columns: vec![base("LOWER")?, base("UPPER")?],
    }])
}

/// The full composition with the derived tolerance classes applied at the
/// consistently started composed state (S2-D24 by
/// [`crate::joined::derived_tolerances`]): the composition of every S3 run
/// path, which the frame driver's setup checks (lead, 15 Oct: the default,
/// never an opt-in).
pub fn started_s3_composition(spine: &Spine) -> Result<(Started, DerivedTolerances), String> {
    let mut s = started_full_composition(spine)?;
    let credited = credited_outputs(&s.joined, spine)?;
    let derived = crate::joined::derived_tolerances(
        &mut s.joined,
        &s.structure,
        0.,
        &s.y,
        &s.yp,
        s.rtol,
        &credited,
        &mut s.atol,
    )
    .map_err(|e| format!("S2-D24r derived tolerance classes at the composed state: {e:?}"))?;
    s.joined
        .declare_credited(credited)
        .map_err(|e| format!("credited outputs declared: {e:?}"))?;
    Ok((s, derived))
}

/// The S3 composition with L1 and the regular cells' phase modes declared
/// (decision 0014, lead decisions S3-D-P1/P2): the composition of C4 and of
/// every phase-branch case. L1 is activated at the composed state (its
/// locks make the vapor paths whose ends hold no vapor algebraic, every
/// residual row unchanged there), so the identity is taken again; build
/// the stock-IDA handle after it (the root count grows), on
/// `Integrated::following_presence` when a birth may change the presence
/// key.
pub fn started_s3_phase_composition(spine: &Spine) -> Result<(Started, DerivedTolerances), String> {
    let (mut s, derived) = started_s3_composition(spine)?;
    s.joined
        .activate_unilateral(0., &s.y)
        .map_err(|e| format!("L1 at the composed state: {e:?}"))?;
    s.joined
        .activate_phase_modes()
        .map_err(|e| format!("phase modes at the composed state: {e:?}"))?;
    s.ids = s.joined.differential(&s.network_ids);
    Ok((s, derived))
}

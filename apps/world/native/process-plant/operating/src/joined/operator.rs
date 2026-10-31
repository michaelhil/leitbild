//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The composed joined residual and its colored stage Jacobian.
//!
//! `y` is `[network | nuclear | solids | secondary | rods | pzr]`. One evaluation
//! takes the rods' travel and cell volumes, then evaluates the network with
//! this operator as its coupling: inside the coupling the SG views, the
//! solids' temperatures, the nuclear rows, the solids' rows and heats, the
//! rod rows and receipts and the secondary rows are evaluated on the
//! network's fluid state of the same call; the PZR block (G6) is evaluated
//! inside the network's stratified rows, on the cell's column of the same
//! call, as the cell's boundary (`Coupling::pzr_boundary`). Rows are the
//! network's own scaled rows, then every block's physical rows divided by
//! their row scales.
//!
//! The joined structural pattern is the network's own pattern plus every
//! port dependency, conservatively: each column lists every row any state
//! can make it reach. The colored assembly scatters one exact directional
//! evaluation per color and refuses any response outside the pattern.
//!
//! A port may be `Prepared` while its owner is pending: the views or travel
//! at the packet's prepared state. Such an operator evaluates zero-time
//! receipts only, its Jacobian included (a consistent start of the composed
//! coordinates at t = 0); [`Joined::integrable`] is false, and the stock-IDA
//! adapter refuses it, so no integrator can advance it.
use super::{
    block::{CellVolume, Coordinates, Layout, Rods, Secondary, SecondaryView},
    nuclear::{self, Nuclear, RegionWater},
    packet::Packet,
    pzr::{Pzr, SteelPreparation},
    solids::{self, Solids},
};
use crate::{
    network::{
        CellMode, Coupling, CreditedOutput, Failure, Fluid, Network, PZR_PRESSURE, Properties,
        Receipts, Reuse,
        packet::Packet as NetworkPacket,
        phase_events::{located, release_roots},
        stratified,
        unilateral::Transaction as UnilateralTransaction,
    },
    sparse::{self, Coloring, Pattern},
    thermal::{self, Scalar, WaterProperties},
};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

/// The value of an L1 root slot whose path carries no root (a lock with
/// neither end holding): a constant that never crosses.
const L1_DISARMED: f64 = 1.;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined operator: {}", reason.into()))
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined operator: {reason}"))
}

/// The SG secondary port.
pub enum SecondaryPort<P> {
    /// The owner's block, composed.
    Owner(Box<dyn Secondary<P>>),
    /// Zero-time only: each SG's view at the packet's prepared secondary.
    Prepared(Vec<SecondaryView>),
}
/// The rod port.
pub enum RodPort<P> {
    Owner(Box<dyn Rods<P>>),
    /// Zero-time only: the packet's prepared achieved travel per cluster,
    /// the compiled cell volumes and no guide passage.
    Prepared(Vec<f64>),
}

/// First global coordinate of every block.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Offsets {
    pub nuclear: usize,
    pub solids: usize,
    pub secondary: usize,
    pub rods: usize,
    /// The PZR metal and relief block (G6); empty while its owner is not
    /// composed.
    pub pzr: usize,
    pub end: usize,
}

/// Wall time and counts of the joined evaluations, by owner.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Counters {
    pub residuals: usize,
    pub residual_wall_s: f64,
    pub coupled_wall_s: f64,
    pub jacobians: usize,
    pub jacobian_wall_s: f64,
    /// Root-function calls and their wall time.
    pub roots: usize,
    pub root_wall_s: f64,
}

/// The last evaluation's heats, for receipts and conservation.
#[derive(Clone, Debug, Default)]
pub struct Heats {
    pub nuclear: nuclear::Heat,
    pub solids: solids::Heat,
    /// Direct coolant deposition delivered into the network (W).
    pub coolant_w: Scalar,
}

/// One face's compiled endpoints and supporting cells.
#[derive(Clone, Debug)]
struct Face {
    from: usize,
    to: usize,
    supports: Vec<usize>,
}

struct Blocks<P> {
    properties: P,
    nuclear: Nuclear,
    solids: Solids,
    secondary: SecondaryPort<P>,
    rods: RodPort<P>,
    /// The PZR metal and relief owner (G6), from the packet's `pzrMetal`
    /// section.
    pzr: Pzr,
    offsets: Offsets,
    source_water: Vec<usize>,
    compiled_volumes: Vec<f64>,
    nuclear_rows: Vec<Scalar>,
    solid_rows: Vec<Scalar>,
    secondary_rows: Vec<Scalar>,
    rod_rows: Vec<Scalar>,
    pzr_rows: Vec<Scalar>,
    temperatures: solids::Temperatures,
    fuel_t: Vec<Scalar>,
    water: Vec<RegionWater>,
    travel: Vec<Scalar>,
    views: Vec<SecondaryView>,
    cell_volumes: Vec<CellVolume>,
    heats: Heats,
    coupled_wall_s: f64,
    /// Nuclear, solids, secondary, rods and the PZR block, in that order.
    scales: [Scales; 5],
    /// One startup evaluation lets the rod owner prepare its algebraic
    /// coordinates on that evaluation's fluid state ([`Joined::prepare_owners`]).
    prepare: Option<Vec<super::block::Transaction>>,
    /// The rod owner's network reads and receipt cells, for local coupling.
    rod_reads: Option<RodReads>,
    /// Per SG: the secondary owner's own coordinates its view reads.
    secondary_outputs: Vec<Vec<usize>>,
    /// Per solid coordinate: the closed scope of its owner column and the
    /// store whose temperature it sets, compiled at first use.
    column_scopes: Vec<Option<(solids::Closed, Option<usize>)>>,
    /// Per local coupling input (its moved cells, `usize::MAX`, its moved
    /// faces): the wall cells and the closed solid scope it reaches,
    /// compiled at first use.
    local_scopes: BTreeMap<Vec<usize>, (Vec<usize>, solids::Closed)>,
    /// Wall time of the local coupler's calls, by kind.
    coupler: CouplerCounters,
}

/// Calls and wall time of the local coupler during block Jacobians, by
/// kind: network columns' `local`, the owner columns by owner, and the two
/// port columns.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct CouplerCounters {
    pub local: Tally,
    /// Inside `local`: the solids' wall refresh and closed-scope rows, and
    /// the rod clusters' evaluation when reached.
    pub local_solids: Tally,
    pub local_rods: Tally,
    /// The PZR block's terms: network PZR columns' boundaries and its own
    /// columns (G6).
    pub pzr: Tally,
    pub solid_columns: Tally,
    pub secondary_columns: Tally,
    pub rod_columns: Tally,
    pub fuel_heat_columns: Tally,
    pub secondary_heat_columns: Tally,
}
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Tally {
    pub calls: usize,
    pub wall_s: f64,
}
impl Tally {
    fn add(&mut self, started: Instant) {
        self.calls += 1;
        self.wall_s += started.elapsed().as_secs_f64();
    }
}

/// Network cells and faces any rod row or receipt reads, and the cells its
/// receipts enter (from the owner's [`Structure`](super::block::Structure)).
#[derive(Clone, Debug)]
struct RodReads {
    cells: Vec<bool>,
    /// The cells read, ascending: what the rods' root functions may read.
    read_cells: Vec<usize>,
    faces: Vec<bool>,
    receipt_cells: Vec<usize>,
    /// Cells whose volume the rods move.
    volume_cells: Vec<usize>,
}

pub struct Joined<P: Properties> {
    pub network: Network<P>,
    /// MR-1 (R7-P), the packet's `matrixRebuild` section, for the S3 frame
    /// driver; `None` for a packet compiled before the block.
    matrix_rebuild: Option<super::packet::MatrixRebuild>,
    blocks: Blocks<P>,
    faces: Vec<Face>,
    rows: Vec<Scalar>,
    structure: Option<(Pattern, Coloring)>,
    pub counters: Counters,
    /// The regular cells' phase modes are composed (S3-D-P1): two root
    /// slots per regular cell and the birth/exhaustion transactions. Off
    /// unless declared ([`Joined::activate_phase_modes`]): S1 and S2 hold
    /// every cell liquid with no mode roots.
    phase_modes: bool,
    /// The credited outputs on pressure coordinates the derived tolerance
    /// classes take their budgets from (S2-D24r, S3-D16), declared by the
    /// composition from their strict blocks ([`Joined::declare_credited`]);
    /// empty until declared.
    credited: Vec<CreditedOutput>,
    /// The RCP drives' support is the AC routing's (ELEC's slice composed,
    /// S3-D9..D12): a supply loss is applied there first, and the network's
    /// part of the command checks it (declared before any restart).
    supply_routed: bool,
    /// HOOK (COST2, for KERN): the state `(t, y, y')` of the value
    /// evaluation a root call left in the operator (seed none, `cj` 0, no
    /// reuse), so a reader of an accepted state (rule I) takes it instead of
    /// evaluating that state again ([`Joined::holds_value_evaluation`]).
    /// Cleared by every evaluation and root call; set only at the end of a
    /// root call whose value evaluation completed. It is valid for a reader
    /// between that root call and the next change of the operator, which
    /// the frame driver's accepted-state observer is: no transaction runs
    /// between a step and its observer.
    value_state: ValueState,
}

/// HOOK (COST2): the bits of one value evaluation's state.
#[derive(Debug, Default)]
struct ValueState {
    held: bool,
    /// The current root call evaluated its state.
    evaluated: bool,
    t: u64,
    y: Vec<f64>,
    yp: Vec<f64>,
}
impl ValueState {
    fn holds(&self, t: f64, y: &[f64], yp: &[f64]) -> bool {
        self.held
            && self.t == t.to_bits()
            && self.y.len() == y.len()
            && self.yp.len() == yp.len()
            && self
                .y
                .iter()
                .zip(y)
                .all(|(a, b)| a.to_bits() == b.to_bits())
            && self
                .yp
                .iter()
                .zip(yp)
                .all(|(a, b)| a.to_bits() == b.to_bits())
    }
    fn set(&mut self, t: f64, y: &[f64], yp: &[f64]) {
        self.t = t.to_bits();
        self.y.clear();
        self.y.extend_from_slice(y);
        self.yp.clear();
        self.yp.extend_from_slice(yp);
        self.held = true;
    }
}

fn view<'a>(
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
    range: std::ops::Range<usize>,
    scales: &'a [f64],
) -> Result<Coordinates<'a>, Failure> {
    Coordinates::new(
        &y[range.clone()],
        &yp[range.clone()],
        seed.map(|d| &d[range]),
        cj,
        scales,
    )
}

/// Coordinate and row scales of one block, copied once at composition so a
/// coordinate view never borrows the block it is handed to.
#[derive(Clone, Debug, Default)]
struct Scales {
    coordinates: Vec<f64>,
    rows: Vec<f64>,
}
impl Scales {
    fn of(layout: &Layout) -> Self {
        Self {
            coordinates: layout.scales.clone(),
            rows: layout.row_scales.clone(),
        }
    }
}

impl<P: Properties + WaterProperties> Joined<P> {
    /// Compose the blocks on one packet. `properties` is a second instance
    /// of the network's maintained property implementation, for the blocks.
    pub fn new(
        network: Network<P>,
        network_packet: &NetworkPacket,
        packet: &Packet,
        properties: P,
        secondary: SecondaryPort<P>,
        rods: RodPort<P>,
    ) -> Result<Self, Failure> {
        let cells = network.cell_layout.len();
        // E-NUC phase B: the solids' replica classes follow the nuclear
        // groups and keep every rod seat's deposit store single; the nuclear
        // block's ports are the solids' half classes.
        let mut nuclear = Nuclear::new(packet, cells)?;
        let singles = match &rods {
            RodPort::Owner(b) => b.deposit_stores(),
            RodPort::Prepared(_) => Vec::new(),
        };
        let solids = Solids::new(packet, cells, nuclear.group_of(), &singles)?;
        nuclear.set_ports(solids.half_members())?;
        let generators = solids.secondaries();
        let clusters = nuclear.feedback().rod_count();
        let secondary_len = match &secondary {
            SecondaryPort::Owner(b) => {
                b.layout().validate("secondary")?;
                if b.generators() != generators {
                    return Err(fatal("secondary generator count"));
                }
                b.layout().len()
            }
            SecondaryPort::Prepared(v) => {
                if v.len() != generators {
                    return Err(fatal("prepared secondary view count"));
                }
                0
            }
        };
        let rods_len = match &rods {
            RodPort::Owner(b) => {
                b.layout().validate("rods")?;
                if b.clusters() != clusters {
                    return Err(fatal("rod cluster count"));
                }
                b.layout().len()
            }
            RodPort::Prepared(t) => {
                if t.len() != clusters {
                    return Err(fatal("prepared rod travel count"));
                }
                0
            }
        };
        // G6: the PZR owner composes from its section, P4's demand at the
        // prepared cell's Tsat(p_s) and (S3-D36, PZRSOLIDS hook) its steel at
        // the steady state of its laws, the packet's pzrSteel; a relief port
        // needs it.
        let pzr = Pzr::new(
            network.stratified(),
            &packet.pzr_metal,
            SteelPreparation::Steady(packet.pzr_steel.as_ref().ok_or_else(|| {
                fatal("the PZR owner's pzrMetal section needs its steady steel (pzrSteel, S3-D36)")
            })?),
            network.pzr_saturation_temperature_k(),
        )?;
        let pzr_len = pzr.layout().len();
        let n = network.dimension();
        let rods_at = n + nuclear.layout().len() + solids.layout().len() + secondary_len;
        let offsets = Offsets {
            nuclear: n,
            solids: n + nuclear.layout().len(),
            secondary: n + nuclear.layout().len() + solids.layout().len(),
            rods: rods_at,
            pzr: rods_at + rods_len,
            end: rods_at + rods_len + pzr_len,
        };
        let faces: Vec<Face> = network_packet
            .mechanics
            .faces
            .iter()
            .map(|f| Face {
                from: f.from,
                to: f.to,
                supports: f.supports.iter().map(|s| s.region).collect(),
            })
            .collect();
        if faces.len() != network.face_count() {
            return Err(fatal("network packet faces"));
        }
        let compiled_volumes = (0..cells).map(|c| network.volume(c)).collect();
        let scales = [
            Scales::of(nuclear.layout()),
            Scales::of(solids.layout()),
            match &secondary {
                SecondaryPort::Owner(b) => Scales::of(b.layout()),
                SecondaryPort::Prepared(_) => Scales::default(),
            },
            match &rods {
                RodPort::Owner(b) => Scales::of(b.layout()),
                RodPort::Prepared(_) => Scales::default(),
            },
            Scales::of(pzr.layout()),
        ];
        let rod_reads = match &rods {
            RodPort::Owner(b) => {
                let st = b.structure();
                let mut reads = RodReads {
                    cells: vec![false; cells],
                    read_cells: Vec::new(),
                    faces: vec![false; faces.len()],
                    receipt_cells: st.receipts.iter().map(|r| r.0).collect(),
                    volume_cells: st.volumes.iter().map(|v| v.0).collect(),
                };
                for c in st
                    .cells
                    .iter()
                    .flatten()
                    .chain(st.receipts.iter().flat_map(|r| &r.2))
                {
                    *reads.cells.get_mut(*c).ok_or_else(|| {
                        fatal("rod structure reads a cell outside the regular cells")
                    })? = true;
                }
                for f in st.faces.iter().flatten() {
                    *reads
                        .faces
                        .get_mut(*f)
                        .ok_or_else(|| fatal("rod structure reads an unknown face"))? = true;
                }
                reads.receipt_cells.sort_unstable();
                reads.receipt_cells.dedup();
                reads.read_cells = (0..cells).filter(|c| reads.cells[*c]).collect();
                Some(reads)
            }
            RodPort::Prepared(_) => None,
        };
        let secondary_outputs = match &secondary {
            SecondaryPort::Owner(b) => b.structure().outputs,
            SecondaryPort::Prepared(_) => Vec::new(),
        };
        let blocks = Blocks {
            scales,
            prepare: None,
            rod_reads,
            secondary_outputs,
            column_scopes: vec![None; solids.layout().len()],
            local_scopes: BTreeMap::new(),
            coupler: CouplerCounters::default(),
            nuclear_rows: vec![s(0.); nuclear.layout().len()],
            solid_rows: vec![s(0.); solids.layout().len()],
            secondary_rows: vec![s(0.); secondary_len],
            rod_rows: vec![s(0.); rods_len],
            pzr_rows: vec![s(0.); pzr_len],
            temperatures: solids::Temperatures::default(),
            fuel_t: vec![s(0.); nuclear.ports()],
            water: vec![
                RegionWater {
                    density_kg_m3: s(0.),
                    boron_ppm_eq: s(0.),
                    pressure_pa: s(0.),
                    temperature_k: s(0.),
                    vapor_kg: s(0.),
                };
                nuclear.regions()
            ],
            travel: vec![s(0.); clusters],
            views: vec![
                SecondaryView {
                    pressure: s(0.),
                    saturation_temperature: s(0.),
                    liquid_volume: s(0.),
                    steam_present: false,
                };
                generators
            ],
            cell_volumes: vec![
                CellVolume {
                    volume_m3: s(0.),
                    rate_m3_s: s(0.),
                };
                cells
            ],
            heats: Heats::default(),
            coupled_wall_s: 0.,
            properties,
            nuclear,
            solids,
            secondary,
            rods,
            pzr,
            offsets,
            source_water: packet.source_water.clone(),
            compiled_volumes,
        };
        let mut joined = Self {
            network,
            matrix_rebuild: packet.matrix_rebuild.clone(),
            blocks,
            faces,
            rows: vec![s(0.); offsets.end],
            structure: None,
            counters: Counters::default(),
            phase_modes: false,
            credited: Vec::new(),
            supply_routed: false,
            value_state: ValueState::default(),
        };
        let columns = joined.structural_pattern()?;
        let pattern = Pattern::from_columns(offsets.end, &columns).map_err(fatal)?;
        let coloring = Coloring::greedy(&pattern);
        coloring.verify(&pattern).map_err(fatal)?;
        joined.structure = Some((pattern, coloring));
        Ok(joined)
    }

    /// MR-1 (owner, request 7 R7-P): the packet's forced matrix-rebuild
    /// section, `None` for a packet compiled before
    /// `ld01-joined-matrix-rebuild`.
    pub fn matrix_rebuild(&self) -> Option<&super::packet::MatrixRebuild> {
        self.matrix_rebuild.as_ref()
    }

    /// The RCP drives' support is set by the AC routing (ELEC's slice):
    /// [`super::block::Command::SupplyLoss`] then reaches the routing first
    /// and the network's part checks the rotor is unsupported. Declared by
    /// the wrapper that composes the routing.
    pub fn declare_supply_routing(&mut self) {
        self.supply_routed = true;
    }

    /// S3-D27: declare the SG owner's feed gate (ELEC's S3-D12) and
    /// recompile the colored structure: the mass rows' pattern then covers
    /// the gate closed. A block structure ([`super::blocks::JoinedJacobian`])
    /// must be compiled after it.
    pub fn declare_feed_gate(&mut self) -> Result<(), Failure> {
        self.secondary_mut()
            .ok_or_else(|| fatal("the feed gate needs the SG owner"))?
            .declare_feed_gate()?;
        let columns = self.structural_pattern()?;
        let pattern = Pattern::from_columns(self.blocks.offsets.end, &columns).map_err(fatal)?;
        let coloring = Coloring::greedy(&pattern);
        coloring.verify(&pattern).map_err(fatal)?;
        self.structure = Some((pattern, coloring));
        Ok(())
    }

    /// Both ports are composed owners: the operator may be integrated.
    pub fn integrable(&self) -> bool {
        matches!(self.blocks.secondary, SecondaryPort::Owner(_))
            && matches!(self.blocks.rods, RodPort::Owner(_))
    }
    pub fn dimension(&self) -> usize {
        self.blocks.offsets.end
    }
    pub fn offsets(&self) -> Offsets {
        self.blocks.offsets
    }
    pub fn nuclear(&self) -> &Nuclear {
        &self.blocks.nuclear
    }
    pub fn solids(&self) -> &Solids {
        &self.blocks.solids
    }
    pub fn heats(&self) -> &Heats {
        &self.blocks.heats
    }
    /// The local coupler's calls and wall time over every block Jacobian.
    pub fn coupler_counters(&self) -> CouplerCounters {
        self.blocks.coupler
    }
    pub fn temperatures(&self) -> &solids::Temperatures {
        &self.blocks.temperatures
    }
    pub fn travel(&self) -> &[Scalar] {
        &self.blocks.travel
    }
    /// The source feedback's water conditions of the last evaluation, per
    /// region: exactly the port values the nuclear rows read.
    pub fn region_water(&self) -> &[RegionWater] {
        &self.blocks.water
    }
    /// Owner answer B1: each core region's coolant phase at the last
    /// evaluation (the region water above): the liquid's departure from
    /// saturation at its own pressure and its owner cell's vapour mass.
    /// Read on accepted states only, never inside a residual.
    /// HOOK (COST2, for KERN): whether the operator holds the value
    /// evaluation of exactly `(t, y, y')` (bitwise), left by the last root
    /// call with nothing evaluated since: a reader of that accepted state
    /// (rule I) may then read [`Self::nuclear`], [`Self::travel`] and
    /// [`Self::region_phases`] without evaluating it again.
    pub fn holds_value_evaluation(&self, t: f64, y: &[f64], yp: &[f64]) -> bool {
        self.value_state.holds(t, y, yp)
    }
    pub fn region_phases(&self) -> Result<Vec<crate::source_feedback::RegionPhase>, Failure> {
        self.blocks
            .water
            .iter()
            .map(|w| {
                let saturation =
                    Properties::saturation_caloric(&self.blocks.properties, s(w.pressure_pa.value))
                        .map_err(|e| fatal(format!("region phase saturation: {e}")))?;
                Ok(crate::source_feedback::RegionPhase {
                    saturation_departure_k: w.temperature_k.value - saturation.temperature.value,
                    vapor_kg: w.vapor_kg.value,
                })
            })
            .collect()
    }
    /// Each carrier's feedback fuel temperature of the last evaluation.
    pub fn fuel_feedback_temperatures(&self) -> &[Scalar] {
        &self.blocks.fuel_t
    }
    pub fn views(&self) -> &[SecondaryView] {
        &self.blocks.views
    }
    pub fn source_water(&self) -> &[usize] {
        &self.blocks.source_water
    }
    pub fn secondary(&self) -> Option<&dyn Secondary<P>> {
        match &self.blocks.secondary {
            SecondaryPort::Owner(b) => Some(b.as_ref()),
            SecondaryPort::Prepared(_) => None,
        }
    }
    pub fn rods(&self) -> Option<&dyn Rods<P>> {
        match &self.blocks.rods {
            RodPort::Owner(b) => Some(b.as_ref()),
            RodPort::Prepared(_) => None,
        }
    }
    pub fn secondary_mut(&mut self) -> Option<&mut (dyn Secondary<P> + 'static)> {
        match &mut self.blocks.secondary {
            SecondaryPort::Owner(b) => Some(b.as_mut()),
            SecondaryPort::Prepared(_) => None,
        }
    }
    pub fn rods_mut(&mut self) -> Option<&mut (dyn Rods<P> + 'static)> {
        match &mut self.blocks.rods {
            RodPort::Owner(b) => Some(b.as_mut()),
            RodPort::Prepared(_) => None,
        }
    }
    /// The PZR metal and relief owner (G6).
    pub fn pzr(&self) -> &Pzr {
        &self.blocks.pzr
    }
    pub fn pzr_mut(&mut self) -> &mut Pzr {
        &mut self.blocks.pzr
    }
    /// S5 snapshot hook (PLATFORM, claude/ld01-s5-host; KERN reconciles):
    /// the unit's copyable discrete state — the SG secondary's, the rods',
    /// the PZR block's and the network's rotor states — as plain data. With
    /// the coordinates and the packet it is the joined operator's whole
    /// state; nothing here is a cache.
    pub fn discrete_state(&self) -> serde_json::Value {
        use crate::rotor::{Shaft, SpeedRequest, Support};
        let rotors: Vec<serde_json::Value> = (0..self.network.rotor_count())
            .map(|r| {
                self.network.rotor_state(r).map_or(serde_json::Value::Null, |st| {
                    let support = match st.support {
                        Support::Supported(SpeedRequest::Zero) => serde_json::json!("supported-zero"),
                        Support::Supported(SpeedRequest::Nominal) => serde_json::json!("supported-nominal"),
                        Support::Supported(SpeedRequest::EngineeringTest { omega_rad_s }) => {
                            serde_json::json!({"engineering_test_rad_s": super::block::snapshot_time(Some(omega_rad_s))})
                        }
                        Support::Unsupported => serde_json::json!("unsupported"),
                        Support::OutsideSupplyEnvelope => serde_json::json!("outside-supply-envelope"),
                    };
                    let shaft = match st.shaft {
                        Shaft::Free => "free",
                        Shaft::Locked => "locked",
                    };
                    serde_json::json!({"support": support, "shaft": shaft})
                })
            })
            .collect();
        serde_json::json!({
            "network": {
                "unilateral": self.network.unilateral().map(|l| serde_json::to_value(l).expect("L1 locks serialize")),
                "modes": serde_json::to_value(self.network.cell_modes()).expect("cell modes serialize"),
                "spray": serde_json::to_value(self.network.spray_discrete_state()).expect("spray state serializes"),
            },
            // No discrete state: their rows read coordinates and the packet only.
            "nuclear": serde_json::Value::Null,
            "solids": serde_json::Value::Null,
            "secondary": self.secondary().map(|b| b.discrete_state()),
            "rods": self.rods().map(|b| b.discrete_state()),
            "pzr": self.pzr().discrete_state(),
            "rotors": rotors,
            "phase_modes": self.phase_modes,
        })
    }
    /// S5 snapshot hook: restore [`Joined::discrete_state`] exactly into a
    /// composed operator of the same packet (freshly, or from another saved
    /// state of it); any mismatch refuses.
    pub fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure> {
        use crate::{
            network::RotorState,
            rotor::{Shaft, SpeedRequest, Support},
        };
        let o = super::block::snapshot_object(
            state,
            "joined",
            &[
                "network",
                "nuclear",
                "solids",
                "secondary",
                "rods",
                "pzr",
                "rotors",
                "phase_modes",
            ],
        )?;
        if !(o["nuclear"].is_null() && o["solids"].is_null()) {
            return Err(fatal(
                "snapshot: the nuclear and solid blocks hold no discrete state",
            ));
        }
        let network = super::block::snapshot_object(
            &o["network"],
            "network",
            &["unilateral", "modes", "spray"],
        )?;
        let spray = serde_json::from_value(network["spray"].clone())
            .map_err(|e| fatal(format!("snapshot: spray path: {e}")))?;
        self.network.restore_spray_discrete_state(spray)?;
        let modes: Vec<CellMode> = serde_json::from_value(network["modes"].clone())
            .map_err(|e| fatal(format!("snapshot: cell modes: {e}")))?;
        self.network.set_cell_modes(&modes)?;
        // HOOK (WORLD `ld01-unit` RESTORE): the locks replace those of an
        // operator composed from another saved state of the same packet
        // (the unit's LOAD state, L1 declared there); a snapshot without L1
        // cannot undeclare it.
        match (&network["unilateral"], self.network.unilateral().is_some()) {
            (serde_json::Value::Null, false) => {}
            (serde_json::Value::Null, true) => {
                return Err(fatal(
                    "snapshot: no L1 locks for an operator with L1 declared",
                ));
            }
            (v, _) => {
                let locks = serde_json::from_value(v.clone())
                    .map_err(|e| fatal(format!("snapshot: L1 locks: {e}")))?;
                self.network.restore_unilateral(locks)?;
            }
        }
        self.phase_modes = o["phase_modes"]
            .as_bool()
            .ok_or_else(|| fatal("snapshot: phase_modes"))?;
        match (self.secondary_mut(), &o["secondary"]) {
            (Some(b), v) if !v.is_null() => b.restore_discrete_state(v)?,
            (None, serde_json::Value::Null) => {}
            _ => return Err(fatal("snapshot: secondary owner presence differs")),
        }
        match (self.rods_mut(), &o["rods"]) {
            (Some(b), v) if !v.is_null() => b.restore_discrete_state(v)?,
            (None, serde_json::Value::Null) => {}
            _ => return Err(fatal("snapshot: rod owner presence differs")),
        }
        self.pzr_mut().restore_discrete_state(&o["pzr"])?;
        let rotors = o["rotors"]
            .as_array()
            .filter(|a| a.len() == self.network.rotor_count())
            .ok_or_else(|| fatal("snapshot: one state per rotor"))?;
        for (r, v) in rotors.iter().enumerate() {
            let f = super::block::snapshot_object(v, "rotor", &["support", "shaft"])?;
            let support = match &f["support"] {
                serde_json::Value::String(s) => match s.as_str() {
                    "supported-zero" => Support::Supported(SpeedRequest::Zero),
                    "supported-nominal" => Support::Supported(SpeedRequest::Nominal),
                    "unsupported" => Support::Unsupported,
                    "outside-supply-envelope" => Support::OutsideSupplyEnvelope,
                    other => return Err(fatal(format!("snapshot: rotor support {other}"))),
                },
                serde_json::Value::Object(m) if m.len() == 1 => {
                    let omega = super::block::restored_time(&m["engineering_test_rad_s"])?
                        .ok_or_else(|| fatal("snapshot: engineering-test speed"))?;
                    Support::Supported(SpeedRequest::EngineeringTest { omega_rad_s: omega })
                }
                other => return Err(fatal(format!("snapshot: rotor support {other}"))),
            };
            let shaft = match f["shaft"].as_str() {
                Some("free") => Shaft::Free,
                Some("locked") => Shaft::Locked,
                other => return Err(fatal(format!("snapshot: rotor shaft {other:?}"))),
            };
            self.network
                .set_rotor_state(r, RotorState { support, shaft });
        }
        Ok(())
    }
    /// The joined rows of the last evaluation (solver scaling).
    pub fn rows(&self) -> &[Scalar] {
        &self.rows
    }
    pub fn properties(&self) -> &P {
        &self.blocks.properties
    }
    pub fn structure(&self) -> Option<&(Pattern, Coloring)> {
        self.structure.as_ref()
    }

    /// Every block's layout in global order: network, nuclear, solids and the
    /// composed owners.
    pub fn layouts(&self) -> Vec<(&'static str, Layout)> {
        let mut out = vec![
            ("network", super::network_layout(&self.network)),
            ("nuclear", self.blocks.nuclear.layout().clone()),
            ("solids", self.blocks.solids.layout().clone()),
        ];
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            out.push(("secondary", b.layout().clone()));
        }
        if let RodPort::Owner(b) = &self.blocks.rods {
            out.push(("rods", b.layout().clone()));
        }
        out.push(("pzr", self.blocks.pzr.layout().clone()));
        out
    }

    /// Scales of every coordinate in global order.
    pub fn scales(&self) -> Vec<f64> {
        self.layouts()
            .into_iter()
            .flat_map(|(_, l)| l.scales)
            .collect()
    }

    /// Prepared coordinates in solver scaling: the network's given `y`, then
    /// every block's prepared physical values over its scales.
    pub fn prepared(&self, network_y: &[f64]) -> Result<Vec<f64>, Failure> {
        if network_y.len() != self.network.dimension() {
            return Err(fatal("network preparation length"));
        }
        let mut y = network_y.to_vec();
        let mut push = |values: &[f64], layout: &Layout| {
            y.extend(values.iter().zip(&layout.scales).map(|(v, s)| v / s));
        };
        push(self.blocks.nuclear.prepared(), self.blocks.nuclear.layout());
        push(self.blocks.solids.prepared(), self.blocks.solids.layout());
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            push(&b.prepared(), b.layout());
        }
        if let RodPort::Owner(b) = &self.blocks.rods {
            push(&b.prepared(), b.layout());
        }
        push(self.blocks.pzr.prepared(), self.blocks.pzr.layout());
        Ok(y)
    }

    /// Current IDA identity in global order.
    pub fn differential(&self, network_ids: &[f64]) -> Vec<f64> {
        let mut ids = self.network.differential(network_ids);
        ids.extend(self.blocks.nuclear.layout().ids());
        ids.extend(self.blocks.solids.layout().ids());
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            ids.extend(b.differential());
        }
        if let RodPort::Owner(b) = &self.blocks.rods {
            ids.extend(b.differential());
        }
        ids.extend(self.blocks.pzr.differential());
        ids
    }

    /// Evaluate every joined row; with `seed`, also its directions.
    pub fn evaluate(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        reuse: Option<&mut Reuse<P::Caloric>>,
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let o = self.blocks.offsets;
        self.value_state.held = false; // HOOK (COST2)
        if y.len() != o.end || yp.len() != o.end || seed.is_some_and(|d| d.len() != o.end) {
            return Err(fatal("stage length"));
        }
        self.blocks.pre_network(y, yp, seed, cj)?;
        // The rod owner's moving volumes; a prepared pose lists none, so every
        // cell keeps its compiled volume. Taken out for the call, so the
        // coupling may borrow the blocks while the network reads them.
        let volumes = match self.blocks.rods {
            RodPort::Owner(_) => std::mem::take(&mut self.blocks.cell_volumes),
            RodPort::Prepared(_) => Vec::new(),
        };
        let (network_rows, block_rows) = self.rows.split_at_mut(o.nuclear);
        let mut coupler = Coupler {
            blocks: &mut self.blocks,
            t,
            y,
            yp,
            seed,
            cj,
            rows: block_rows,
        };
        let result = self.network.evaluate_joined(
            t,
            &y[..o.nuclear],
            &yp[..o.nuclear],
            seed.map(|d| &d[..o.nuclear]),
            cj,
            reuse,
            Some(&mut coupler),
            &volumes,
        );
        if matches!(self.blocks.rods, RodPort::Owner(_)) {
            self.blocks.cell_volumes = volumes;
        }
        result?;
        network_rows.copy_from_slice(self.network.rows());
        self.counters.residuals += 1;
        self.counters.residual_wall_s += started.elapsed().as_secs_f64();
        self.counters.coupled_wall_s = self.blocks.coupled_wall_s;
        Ok(())
    }

    /// Root functions: the secondary owner's, the rod owner's (on one
    /// value evaluation's fluid state), the PZR relief's (on the roof
    /// pressure and the lift), then, once L1 is active, one slot per phase
    /// path of the network ([`Self::activate_unilateral`]). Stock IDA cannot
    /// retry a root, so every failure is fatal.
    pub fn root_count(&self) -> usize {
        self.secondary().map_or(0, |b| b.root_count())
            + self.rods().map_or(0, |b| b.root_count())
            + self.pzr().root_count()
            + self.unilateral_slots()
            + self.phase_mode_slots()
            + self.spray_slots()
    }
    /// IC-CTRL (S3 spray path, for KERN): three root slots, last, while the
    /// spray path is composed: the inlet check's (S3-D25 (3)), then the
    /// spray port's two phase paths under the scoped L1 (DR-P3-SPRAY;
    /// disarmed constants once the network-wide L1 governs them).
    fn spray_slots(&self) -> usize {
        if self.network.spray().is_some() { 3 } else { 0 }
    }
    /// The phase modes' root slots: two per regular cell once declared,
    /// after L1's ([`Self::activate_phase_modes`]).
    fn phase_mode_slots(&self) -> usize {
        if self.phase_modes {
            2 * self.network.pzr.cell
        } else {
            0
        }
    }
    /// Declare the regular cells' phase modes composed (lead decision
    /// S3-D-P1): per regular cell two root slots after L1's, in the
    /// phase-mode owner's mode at the restart: a liquid cell's birth root
    /// `T_l(p, U_l/M_l) - Tsat(p)` [K] rising and a constant; an
    /// equilibrium cell's exhaustion root `M_g` [kg] and dryout root
    /// `M - M_g` [kg], both falling. Before the stock-IDA handle is made (the
    /// root count grows by two per cell). Never by default.
    pub fn activate_phase_modes(&mut self) -> Result<(), Failure> {
        if self.phase_modes {
            return Err(fatal("the phase modes are already composed"));
        }
        self.phase_modes = true;
        Ok(())
    }
    /// Whether the phase modes are composed.
    pub fn phase_modes_active(&self) -> bool {
        self.phase_modes
    }
    /// Declare the credited outputs on pressure coordinates (each with its
    /// strict block's budget) that the derived tolerance classes read
    /// (S2-D24r, S3-D16); every column must be a coordinate of this
    /// operator and every budget finite and positive.
    pub fn declare_credited(&mut self, outputs: Vec<CreditedOutput>) -> Result<(), Failure> {
        let n = self.blocks.offsets.end;
        if let Some(o) = outputs.iter().find(|o| {
            o.columns.is_empty()
                || o.columns.iter().any(|j| *j >= n)
                || !(o.budget.is_finite() && o.budget > 0.)
        }) {
            return Err(fatal(format!(
                "credited output {} is not declarable",
                o.name
            )));
        }
        self.credited = outputs;
        Ok(())
    }
    /// The declared credited outputs (empty until declared).
    pub fn credited(&self) -> &[CreditedOutput] {
        &self.credited
    }
    /// L1's root slots: one per phase path (face-layout order) while L1 is
    /// active, none before (S1, S2). A slot carries the root of its path's
    /// current lock ([`Network::unilateral_roots`]): a free path its contact
    /// root, a one-sided lock its release root, a lock with neither end
    /// holding none (a constant). The count is fixed for a handle, so L1 is
    /// activated before the stock-IDA handle is made.
    fn unilateral_slots(&self) -> usize {
        self.network.unilateral().map_or(0, |u| u.paths.len())
    }
    /// Declare L1 active (decision 0014, lead decision S3-D-P2) at the
    /// value state `(t, y, 0)`: every phase path classified from free by
    /// the phase-mode owner's declared presence
    /// ([`Network::declared_presence`]: the stocks' for liquid cells, both
    /// phases for an equilibrium cell). Before the stock-IDA handle is
    /// made (the root count grows by one slot per path) and before the
    /// consistent start (a locked path's impulse row becomes `Π/s`,
    /// algebraic). Never by default: S1 and S2 compose no L1.
    pub fn activate_unilateral(
        &mut self,
        t: f64,
        y: &[f64],
    ) -> Result<UnilateralTransaction, Failure> {
        if self.network.unilateral().is_some() {
            return Err(fatal("L1 is already active"));
        }
        let zero = vec![0.; y.len()];
        self.evaluate(t, y, &zero, None, 0., None)?;
        let presence = self.network.declared_presence(y);
        self.network.activate_unilateral(&presence)
    }
    /// The crossing direction each root function reports at the owners'
    /// current state, in [`Self::roots`]' order (stock
    /// IDASetRootDirection): the secondary owner's (each armed relief
    /// threshold only the crossing its memory acts on), then both (0) for
    /// the rods' and the PZR relief's.
    pub fn root_directions(&self) -> Result<Vec<i32>, Failure> {
        let mut out = vec![0; self.root_count()];
        if let Some(b) = self.secondary() {
            let ns = b.root_count();
            b.root_directions(&mut out[..ns])?;
        }
        // L1: release rising, contact falling (`Root::direction`); a slot
        // with no root reports none. L1's slots follow the PZR relief's and
        // precede the phase modes' and the spray path's three ([`Self::roots`]).
        let first =
            out.len() - self.spray_slots() - self.phase_mode_slots() - self.unilateral_slots();
        for r in self.network.unilateral_roots() {
            out[first + r.path()] = r.direction();
        }
        // The spray inlet check: contact falling, release rising; then the
        // spray port's scoped L1 slots (their own directions).
        if self.spray_slots() == 3 {
            let check = out.len() - 3;
            out[check] = match self.network.spray_check_watch() {
                Some(crate::network::spray::CheckRoot::Contact) => -1,
                Some(crate::network::spray::CheckRoot::Release) => 1,
                _ => 0,
            };
            let tip = self.network.spray_tip_roots(&vec![0.; self.dimension()])?;
            for (k, (_, d)) in tip.iter().enumerate() {
                out[check + 1 + k] = *d;
            }
        }
        // Phase modes: birth rising; exhaustion and dryout falling.
        if self.phase_modes {
            let first = out.len() - self.phase_mode_slots() - self.spray_slots();
            for (c, mode) in self.network.cell_modes().iter().enumerate() {
                let pair = match mode {
                    CellMode::Liquid => [1, 0],
                    CellMode::Equilibrium => [-1, -1],
                };
                out[first + 2 * c..first + 2 * c + 2].copy_from_slice(&pair);
            }
        }
        Ok(out)
    }
    /// The PZR block's physical coordinates and the roof pressure of `y`.
    fn pzr_state(&self, y: &[f64]) -> (Vec<f64>, f64) {
        let o = self.blocks.offsets;
        let roof = self.network.pzr.base + PZR_PRESSURE;
        (
            (o.pzr..o.end)
                .zip(&self.blocks.scales[4].coordinates)
                .map(|(i, s)| y[i] * s)
                .collect(),
            y[roof] * self.network.scales()[roof],
        )
    }
    pub fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
        let started = Instant::now();
        self.value_state.held = false; // HOOK (COST2)
        let result = self.root_values(t, y, yp, out);
        // HOOK (COST2): a root call whose value evaluation completed leaves
        // that state's evaluation in the operator; everything the call does
        // after it reads the same `(y, y')` (the rods' moving volumes and
        // read cells are recomputed from them bit for bit).
        if result.is_ok() && self.value_state.evaluated {
            self.value_state.set(t, y, yp);
        }
        self.value_state.evaluated = false;
        self.counters.roots += 1;
        self.counters.root_wall_s += started.elapsed().as_secs_f64();
        result
    }
    fn root_values(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let ns = self.secondary().map_or(0, |b| b.root_count());
        let nr = self.rods().map_or(0, |b| b.root_count());
        let np = self.pzr().root_count();
        let nl = self.unilateral_slots();
        let nm = self.phase_mode_slots();
        let nk = self.spray_slots();
        if out.len() != ns + nr + np + nl + nm + nk {
            return Err(fatal("root layout"));
        }
        if nk == 3 {
            // The inlet check's and the spray port's release roots read the
            // drives of this state's value evaluation; their contact roots
            // the coordinates.
            if self.network.spray_check_watch() == Some(crate::network::spray::CheckRoot::Release)
                || self.network.spray_tip_reads_drive()
            {
                self.evaluate(t, y, yp, None, 0., None)
                    .map_err(|e| fatal(format!("spray root evaluation: {e:?}")))?;
                self.value_state.evaluated = true; // HOOK (COST2)
            }
            let check = out.len() - 3;
            out[check] = self.network.spray_check_root(y).map_or(1., |r| r.1);
            let tip = self
                .network
                .spray_tip_roots(y)
                .map_err(|e| fatal(format!("spray port roots: {e:?}")))?;
            for (k, (v, _)) in tip.iter().enumerate() {
                out[check + 1 + k] = *v;
            }
        }
        if nm > 0 {
            let slots = &mut out[ns + nr + np + nl..ns + nr + np + nl + nm];
            for c in 0..self.network.pzr.cell {
                let pair = match self.network.cell_modes()[c] {
                    CellMode::Liquid => [
                        self.network
                            .birth_root(c, y)
                            .map_err(|e| fatal(format!("birth root of cell {c}: {e:?}")))?,
                        L1_DISARMED,
                    ],
                    CellMode::Equilibrium => {
                        let (vapor, liquid) = self
                            .network
                            .equilibrium_masses(c, y)
                            .map_err(|e| fatal(format!("mode roots of cell {c}: {e:?}")))?;
                        [vapor, liquid]
                    }
                };
                slots[2 * c..2 * c + 2].copy_from_slice(&pair);
            }
        }
        if nl > 0 {
            // L1's release roots read the drives of this state's value
            // evaluation; its contact roots read the coordinates alone.
            let roots = self.network.unilateral_roots();
            // HOOK (COST2): the spray roots' value evaluation of this same
            // state, earlier in this call (nothing since mutates the
            // operator: the spray and phase-mode roots only read), is the
            // one L1's release roots read; it is not repeated.
            if release_roots(&roots) && !self.value_state.evaluated {
                self.evaluate(t, y, yp, None, 0., None)
                    .map_err(|e| fatal(format!("L1 root evaluation: {e:?}")))?;
                self.value_state.evaluated = true; // HOOK (COST2)
            }
            let mut values = vec![0.; roots.len()];
            self.network
                .unilateral_root_values(y, &roots, &mut values)
                .map_err(|e| fatal(format!("L1 root values: {e:?}")))?;
            let slots = &mut out[ns + nr + np..ns + nr + np + nl];
            slots.fill(L1_DISARMED);
            for (r, v) in roots.iter().zip(values) {
                slots[r.path()] = v;
            }
        }
        let (x, roof) = self.pzr_state(y);
        self.pzr()
            .roots(roof, &x, &mut out[ns + nr..ns + nr + np])?;
        if let SecondaryPort::Owner(b) = &mut self.blocks.secondary {
            let x = view(
                y,
                yp,
                None,
                0.,
                o.secondary..o.rods,
                &self.blocks.scales[2].coordinates,
            )?;
            b.roots(&self.blocks.properties, t, x, &mut out[..ns])?;
        }
        if nr > 0 {
            // The rods' roots read their own coordinates and, for a seated
            // body, the water of the cells the rod owner declares it reads:
            // only those cells are evaluated, at the rods' moving volumes,
            // exactly as a full evaluation computes them, and none while no
            // body is seated.
            let read_fluid = self.rods().is_some_and(|b| b.roots_read_fluid());
            if read_fluid {
                self.blocks.pre_network(y, yp, None, 0.)?;
            }
            let Blocks {
                properties,
                rods,
                rod_reads,
                cell_volumes,
                scales,
                ..
            } = &mut self.blocks;
            let (RodPort::Owner(b), Some(reads)) = (rods, rod_reads.as_ref()) else {
                return Err(fatal("rod roots without the rod owner"));
            };
            let x = view(y, yp, None, 0., o.rods..o.pzr, &scales[3].coordinates)?;
            let out = &mut out[ns..ns + nr];
            let cells: &[usize] = if read_fluid { &reads.read_cells } else { &[] };
            self.network
                .cells_fluid(&y[..o.nuclear], cell_volumes, cells, |fluid| {
                    b.roots(properties, t, x, fluid, out)
                })
                .and_then(|r| r)
                .map_err(|e| match e {
                    Failure::Recoverable(r) | Failure::Fatal(r) => {
                        fatal(format!("root evaluation: {r}"))
                    }
                })?;
            if out.iter().any(|v| !v.is_finite()) {
                return Err(fatal("nonfinite rod root"));
            }
        }
        Ok(())
    }
    /// E-EVT (plan r4): the located `directions` (per root, owners' order)
    /// widened to the roots of the same event, at the state `y` handed to
    /// the restart (solver scaling) and the handle's error `weights` there
    /// (solver scaling). Only the rods declare coincident roots (the bank
    /// seat, [`super::block::Rods::coincident`]). Returns how many roots
    /// were added.
    pub fn coincident(
        &self,
        y: &[f64],
        weights: &[f64],
        directions: &mut [i32],
    ) -> Result<usize, Failure> {
        if directions.len() != self.root_count() || weights.len() != y.len() {
            return Err(fatal("coincident root layout"));
        }
        let o = self.blocks.offsets;
        let ns = self.secondary().map_or(0, |b| b.root_count());
        let b = &self.blocks;
        let RodPort::Owner(owner) = &b.rods else {
            return Ok(0);
        };
        let nr = owner.root_count();
        let scales = &b.scales[3].coordinates;
        let x: Vec<f64> = (o.rods..o.pzr).zip(scales).map(|(i, s)| y[i] * s).collect();
        let w: Vec<f64> = (o.rods..o.pzr)
            .zip(scales)
            .map(|(i, s)| weights[i] / s)
            .collect();
        owner.coincident(&x, &w, &mut directions[ns..ns + nr])
    }
    /// The owners' transactions at located roots (`directions` per root,
    /// owners' order): each owner may change its own coordinates of `y`
    /// (solver scaling here, physical in the owner); energy deposits enter
    /// their named passive stores once. Consistency is then the caller's
    /// exact consistent start.
    pub fn transact(
        &mut self,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let o = self.blocks.offsets;
        let ns = self.secondary().map_or(0, |b| b.root_count());
        let nr = self.rods().map_or(0, |b| b.root_count());
        if directions.len() != self.root_count() {
            return Err(fatal("transaction root layout"));
        }
        let (mut pzr_x, roof) = self.pzr_state(y);
        let mut done = Vec::new();
        let b = &mut self.blocks;
        if let SecondaryPort::Owner(owner) = &mut b.secondary
            && directions[..ns].iter().any(|d| *d != 0)
        {
            let scales = &b.scales[2].coordinates;
            let mut x: Vec<f64> = (o.secondary..o.rods)
                .zip(scales)
                .map(|(i, s)| y[i] * s)
                .collect();
            done.push(owner.transact(&b.properties, t, &directions[..ns], &mut x)?);
            for ((i, v), s) in (o.secondary..o.rods).zip(&x).zip(scales) {
                y[i] = v / s;
            }
        }
        if let RodPort::Owner(owner) = &mut b.rods
            && directions[ns..ns + nr].iter().any(|d| *d != 0)
        {
            let scales = &b.scales[3].coordinates;
            let mut x: Vec<f64> = (o.rods..o.pzr).zip(scales).map(|(i, s)| y[i] * s).collect();
            done.push(owner.transact(&b.properties, t, &directions[ns..ns + nr], &mut x)?);
            for ((i, v), s) in (o.rods..o.pzr).zip(&x).zip(scales) {
                y[i] = v / s;
            }
        }
        let np = b.pzr.root_count();
        if directions[ns + nr..ns + nr + np].iter().any(|d| *d != 0) {
            done.push(
                b.pzr
                    .transact(t, &directions[ns + nr..ns + nr + np], roof, &mut pzr_x)?,
            );
            for ((i, v), s) in (o.pzr..o.end).zip(&pzr_x).zip(&b.scales[4].coordinates) {
                y[i] = v / s;
            }
        }
        self.deposit(&done, y)?;
        // The phase modes' transactions, then L1's on the post-mode state.
        // L1's slots carry the roots armed for the segment that located
        // this instant (an exhaustion may lock a path first: DR S3-EXHAUST).
        let nl = self.unilateral_slots();
        let armed = self.network.unilateral_roots();
        if self.phase_modes {
            let first = ns + nr + np + nl;
            let nm = self.phase_mode_slots();
            let mut modes = directions[first..first + nm].to_vec();
            // DR S3-REBIRTH (PHASE-L1, for KERN): an L1 contact root located
            // on a path drawing from an equilibrium cell is that cell's
            // exhaustion root (the same function, the donor's vapor mass
            // falling through zero, decision 0014's contact). The cell's own
            // exhaustion root can start on the wrong side of a re-birth's
            // projected root-size vapor and miss it, so the located contact
            // exhausts the donor in this transaction, before L1 locks.
            for r in &armed {
                let crate::network::phase_events::Root::Contact(li) = *r else {
                    continue;
                };
                if directions[ns + nr + np + li] != r.direction() {
                    continue;
                }
                let l = self.network.face_layout[li];
                let (from, to) = self.network.face_ends(l.face);
                let flow = self.network.path_flow_sign(y, li);
                let donor = if flow > 0. {
                    from
                } else if flow < 0. {
                    to
                } else {
                    continue;
                };
                if donor < self.network.pzr.cell
                    && self.network.cell_modes()[donor] == CellMode::Equilibrium
                    && l.phase == 1
                {
                    modes[2 * donor] = -1;
                }
            }
            if let Some(m) = self.mode_transact(t, &modes, y)? {
                done.push(m);
            }
        }
        if self.network.unilateral().is_some() {
            let first = ns + nr + np;
            if let Some(l1) =
                self.unilateral_transact(t, &directions[first..first + nl], y, armed)?
            {
                done.push(l1);
            }
        }
        // IC-CTRL (S3 spray path): the inlet check's transaction at its
        // located root (S3-D25 (3)), then the spray port's scoped L1
        // (DR-P3-SPRAY) on a value evaluation of the post-transaction state.
        if self.spray_slots() == 3 {
            let check = directions.len() - 3;
            if let Some(receipt) = self.network.spray_check_transaction(t, directions[check])? {
                done.push(super::block::Transaction {
                    deposits: Vec::new(),
                    receipt,
                });
            }
            // Every root transaction decides the port's paths, as L1 decides
            // all of its own (found at the transaction or at a located root).
            let tip = [directions[check + 1], directions[check + 2]];
            if self.network.unilateral().is_none() {
                let zero = vec![0.; y.len()];
                self.evaluate(t, y, &zero, None, 0., None)?;
                let presence = self.network.declared_presence(y);
                if let Some(receipt) = self.network.spray_tip_transaction(t, tip, y, &presence)? {
                    done.push(super::block::Transaction {
                        deposits: Vec::new(),
                        receipt,
                    });
                }
            }
        }
        Ok(done)
    }
    /// The phase-mode owner's transactions at a root-located instant
    /// (S3-D-P1): a located birth makes a liquid cell equilibrium (its
    /// vapor slots, exactly zero, join its totals: no stock moves); a
    /// located exhaustion makes an equilibrium cell liquid (its algebraic
    /// vapor slots are zeroed, the totals stay); a located dryout refuses:
    /// mode G is S6 scope, so it is C4's declared end. A crossing against a
    /// root's declared direction does not act and is reported. `None` when
    /// nothing was located.
    fn mode_transact(
        &mut self,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Option<super::block::Transaction>, Failure> {
        if directions.len() != self.phase_mode_slots() {
            return Err(fatal("phase-mode root layout"));
        }
        if directions.iter().all(|d| *d == 0) {
            return Ok(None);
        }
        let mut events = Vec::new();
        let mut opposite = Vec::new();
        let mut exhausted = Vec::new();
        for c in 0..self.network.pzr.cell {
            let [a, b] = [directions[2 * c], directions[2 * c + 1]];
            match self.network.cell_modes()[c] {
                CellMode::Liquid => {
                    if b != 0 {
                        return Err(fatal(format!(
                            "cell {c}: a disarmed phase-mode slot crossed"
                        )));
                    }
                    match a {
                        1 => events.push(self.network.birth(c, y)?),
                        -1 => opposite
                            .push(serde_json::json!({"cell": c, "root": "birth", "direction": -1})),
                        _ => {}
                    }
                }
                CellMode::Equilibrium => {
                    if b == -1 {
                        return Err(fatal(format!(
                            "dryout of cell {c} at t = {t} s: mode G is S6 scope (C4's declared end)"
                        )));
                    }
                    if b == 1 {
                        opposite
                            .push(serde_json::json!({"cell": c, "root": "dryout", "direction": 1}));
                    }
                    match a {
                        -1 => exhausted.push(c),
                        1 => opposite.push(
                            serde_json::json!({"cell": c, "root": "exhaustion", "direction": 1}),
                        ),
                        _ => {}
                    }
                }
            }
        }
        // DR S3-EXHAUST (PHASE-P7, for KERN): the exhaustions with the vapor
        // paths they empty, in one transaction on this instant's value
        // evaluation before the exhaustion (`Network::exhaustion_with_paths`).
        let mut contacts = serde_json::Value::Null;
        if !exhausted.is_empty() {
            if self.network.unilateral().is_some() {
                let zero = vec![0.; y.len()];
                self.evaluate(t, y, &zero, None, 0., None)?;
            }
            let (ex, tx) = self.network.exhaustion_with_paths(y, &exhausted)?;
            events.extend(ex);
            if !tx.changes.is_empty() {
                contacts =
                    serde_json::json!({"changes":tx.changes,"energyPaid_J":tx.energy_paid_j});
            }
        }
        Ok(Some(super::block::Transaction {
            deposits: Vec::new(),
            receipt: serde_json::json!({"owner":"phase modes","t_s":t,"events":events,
                "vaporPathContacts":contacts,
                "opposite":opposite,"stateChanged":!events.is_empty()}),
        }))
    }
    /// L1's transaction at a root-located instant, after the owners' (on
    /// the state they leave): every path decided by the declared presence
    /// ([`Network::declared_presence`]) and the drives of the value evaluation at
    /// `(t, y, 0)` (a drive reads the coordinates alone), with the L1 roots
    /// located in this instant's `directions` (one per slot). A contact
    /// sets `Π = 0` and pays its kinetic energy once into the receiving
    /// end's energy stock. A crossing against a root's declared direction
    /// does not act and is reported (stock IDASetRootDirection, set at
    /// every restart, reports none). `None` when nothing was located and no
    /// path changed.
    fn unilateral_transact(
        &mut self,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
        roots: Vec<crate::network::phase_events::Root>,
    ) -> Result<Option<super::block::Transaction>, Failure> {
        if directions.len() != self.unilateral_slots() {
            return Err(fatal("L1 root layout"));
        }
        let carried: Vec<bool> = {
            let mut c = vec![false; directions.len()];
            for r in &roots {
                c[r.path()] = true;
            }
            c
        };
        if let Some(slot) = (0..directions.len()).find(|i| directions[*i] != 0 && !carried[*i]) {
            return Err(fatal(format!(
                "L1 slot {slot} crossed while its path carries no root"
            )));
        }
        let per_root: Vec<i32> = roots.iter().map(|r| directions[r.path()]).collect();
        let (fired, opposite) = located(&roots, &per_root);
        let zero = vec![0.; y.len()];
        self.evaluate(t, y, &zero, None, 0., None)?;
        let presence = self.network.declared_presence(y);
        let tx = self
            .network
            .unilateral_transaction(y, &presence, &fired, None)?;
        if fired.is_empty() && opposite.is_empty() && tx.changes.is_empty() {
            return Ok(None);
        }
        Ok(Some(super::block::Transaction {
            deposits: Vec::new(),
            receipt: serde_json::json!({"owner":"network L1","t_s":t,
                "located":fired.iter().map(|(p, f)| serde_json::json!({"path":p,"root":format!("{f:?}")})).collect::<Vec<_>>(),
                "opposite":opposite,"changes":tx.changes,"energyPaid_J":tx.energy_paid_j,
                "stateChanged":!tx.changes.is_empty()}),
        }))
    }
    /// L1 at a segment start, after the restart's exact consistent start
    /// (DR S3-REBIRTH, decision 0014): the drives and their rates along the
    /// consistent rates `yp` from one value evaluation seeded along `yp`
    /// (`cj = 0`, so a direction is `dF/dt`), then
    /// [`Network::unilateral_release_at_start`]: a one-sided lock whose
    /// drive draws from its holding end at `t0+` is released, its impulse
    /// rate set to the free row's `F` in `yp`; no coordinate moves, so the
    /// caller updates the id vector only. `None` while L1 is inactive or
    /// no one-sided lock exists.
    pub fn unilateral_release_at_start(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &mut [f64],
    ) -> Result<Option<super::block::Transaction>, Failure> {
        if self.network.unilateral().is_none() {
            return Ok(None);
        }
        let seed = yp.to_vec();
        self.evaluate(t, y, yp, Some(&seed), 0., None)?;
        let (tx, one_sided) = self.network.unilateral_release_at_start(yp)?;
        if one_sided.is_empty() {
            return Ok(None);
        }
        Ok(Some(super::block::Transaction {
            deposits: Vec::new(),
            receipt: serde_json::json!({"owner":"network L1 at the segment start","t_s":t,
                "oneSided":one_sided.iter().map(|(p, f, r)| serde_json::json!({"path":p,"orientedDrive_Pa":f,"orientedRate_Pa_s":r})).collect::<Vec<_>>(),
                "changes":tx.changes,"stateChanged":!tx.changes.is_empty()}),
        }))
    }
    /// A declared command to every composed owner, in order, followed by
    /// any time event the command makes due at once ([`Joined::time_events`]).
    pub fn command(
        &mut self,
        t: f64,
        y: &mut [f64],
        command: super::block::Command,
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let mut done = Vec::new();
        if let super::block::Command::SupplyLoss { rotor } = command {
            done.push(self.supply_loss(t, rotor)?);
        }
        if let Some(b) = self.secondary_mut() {
            done.push(b.command(t, command)?);
        }
        if let Some(b) = self.rods_mut() {
            done.push(b.command(t, command)?);
        }
        // HOOK (C4 lane): the PZR owner may change its relief's state.
        done.push(self.pzr_mut().command(t, command)?);
        self.deposit(&done, y)?;
        done.extend(self.time_events(t, y)?);
        Ok(done)
    }
    /// R3 on the joined spine (C3's cost line): how many rod clusters'
    /// annulus volume current lies inside R3's blend band at the accepted
    /// state `(t, y, y')`, on the cells the rod owner reads (as its roots
    /// read them); 0 without a composed rod owner.
    pub fn r3_band_clusters(&mut self, y: &[f64], yp: &[f64]) -> Result<usize, Failure> {
        let o = self.blocks.offsets;
        if !matches!(self.blocks.rods, RodPort::Owner(_)) {
            return Ok(0);
        }
        self.blocks.pre_network(y, yp, None, 0.)?;
        let Blocks {
            rods,
            rod_reads,
            cell_volumes,
            scales,
            ..
        } = &mut self.blocks;
        let (RodPort::Owner(b), Some(reads)) = (rods, rod_reads.as_ref()) else {
            return Err(fatal("R3 band without the rod owner's reads"));
        };
        let x = view(y, yp, None, 0., o.rods..o.pzr, &scales[3].coordinates)?;
        self.network
            .cells_fluid(&y[..o.nuclear], cell_volumes, &reads.read_cells, |fluid| {
                b.r3_band(x, fluid)
            })
            .and_then(|r| r)
    }
    /// C3's initiator on the network: RCP `rotor` loses its supply, its drive
    /// unsupported with the shaft free (it coasts down on its own law). No
    /// coordinate moves; the caller restarts by the exact consistent start
    /// (class R). A rotor that is not supported refuses.
    fn supply_loss(&mut self, t: f64, rotor: usize) -> Result<super::block::Transaction, Failure> {
        use crate::{
            network::RotorState,
            rotor::{Shaft, Support},
        };
        if rotor >= self.network.rotor_count() {
            return Err(fatal(format!(
                "supply loss of rotor {rotor}: no such rotor"
            )));
        }
        let before = self.network.rotor_state(rotor).ok_or_else(|| {
            fatal(format!(
                "supply loss of rotor {rotor}: its state is undeclared"
            ))
        })?;
        if self.supply_routed {
            // The AC routing applied the loss before the operator's part
            // (its appended events come first); the network only checks it.
            if before.support != Support::Unsupported {
                return Err(fatal(format!(
                    "supply loss of rotor {rotor} at {t} s: the AC routing owns its supply and left it {:?}",
                    before.support
                )));
            }
            return Ok(super::block::Transaction {
                deposits: Vec::new(),
                receipt: serde_json::json!({"owner":"network","command":"SupplyLoss","rotor":rotor,"t_s":t,
                    "appliedBy":"the AC routing (ELEC): the RCP's supply lost there","support":"Unsupported",
                    "shaft":format!("{:?}", before.shaft),"stateChanged":false}),
            });
        }
        if !matches!(before.support, Support::Supported(_)) {
            return Err(fatal(format!(
                "supply loss of rotor {rotor} at {t} s: it is not supported ({:?})",
                before.support
            )));
        }
        self.network.set_rotor_state(
            rotor,
            RotorState {
                support: Support::Unsupported,
                shaft: Shaft::Free,
            },
        );
        Ok(super::block::Transaction {
            deposits: Vec::new(),
            receipt: serde_json::json!({"owner":"network","command":"SupplyLoss","rotor":rotor,"t_s":t,
                "before":{"support":format!("{:?}", before.support),"shaft":format!("{:?}", before.shaft)},
                "after":{"support":"Unsupported","shaft":"Free"},"stateChanged":true}),
        })
    }
    /// The owners' transactions of every time event due exactly at `t`: at
    /// a stop at [`Joined::next_time_event`] and after a command. Each owner
    /// changes only its own coordinates of `y` (written back in solver
    /// scaling before any restart); deposits enter their passive stores
    /// once. The caller then updates the differential identity and restarts
    /// by the exact consistent start.
    pub fn time_events(
        &mut self,
        t: f64,
        y: &mut [f64],
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let o = self.blocks.offsets;
        let mut done = Vec::new();
        let b = &mut self.blocks;
        if let SecondaryPort::Owner(owner) = &mut b.secondary {
            let scales = &b.scales[2].coordinates;
            let mut x: Vec<f64> = (o.secondary..o.rods)
                .zip(scales)
                .map(|(i, s)| y[i] * s)
                .collect();
            if let Some(d) = owner.time_event(&b.properties, t, &mut x)? {
                done.push(d);
                for ((i, v), s) in (o.secondary..o.rods).zip(&x).zip(scales) {
                    y[i] = v / s;
                }
            }
        }
        if let RodPort::Owner(owner) = &mut b.rods {
            let scales = &b.scales[3].coordinates;
            let mut x: Vec<f64> = (o.rods..o.pzr).zip(scales).map(|(i, s)| y[i] * s).collect();
            if let Some(d) = owner.time_event(&b.properties, t, &mut x)? {
                done.push(d);
                for ((i, v), s) in (o.rods..o.pzr).zip(&x).zip(scales) {
                    y[i] = v / s;
                }
            }
        }
        self.deposit(&done, y)?;
        // IC-CTRL (S3 spray path, for KERN): the spray stem's arrival at 0
        // locks the valve path (class R; the identity follows the lock).
        if let Some(receipt) = self.network.spray_event(t)? {
            done.push(super::block::Transaction {
                deposits: Vec::new(),
                receipt,
            });
        }
        Ok(done)
    }
    /// IC-CTRL (S3 spray path, for KERN): put a normal PZR pressure control
    /// frame's demands in force: the heater request into the PZR block, the
    /// controlled-spray fraction into the network's valve stem when the
    /// spray path is composed (without it a nonzero spray demand refuses in
    /// the PZR block). Returns how the stem change enters (S3-D4: `Lock` is
    /// class R, `Slope` class S, `None` nothing) and the receipts.
    pub fn apply_pzr_control(
        &mut self,
        t: f64,
        demand: &crate::control::pzr_pressure::Demand,
    ) -> Result<
        (
            crate::control::spray_valve::StemChange,
            Vec<serde_json::Value>,
        ),
        Failure,
    > {
        use crate::control::spray_valve::StemChange;
        let composed = self.network.spray().is_some();
        let heater = crate::control::pzr_pressure::Demand {
            spray_target: if composed { 0. } else { demand.spray_target },
            ..*demand
        };
        let applied = self.blocks.pzr.apply_control(t, &heater)?;
        let mut receipts = vec![serde_json::to_value(&applied).map_err(|e| fatal(e.to_string()))?];
        let change = if composed {
            let (change, receipt) = self.network.issue_spray(t, demand.spray_target)?;
            receipts.push(receipt);
            change
        } else {
            StemChange::None
        };
        Ok((change, receipts))
    }
    /// The earliest declared time event of any owner strictly after `t`.
    pub fn next_time_event(&self, t: f64) -> Option<f64> {
        [
            self.secondary().and_then(|b| b.next_time_event(t)),
            self.rods().and_then(|b| b.next_time_event(t)),
            // IC-CTRL (S3 spray path): only the closing arrival is an owner
            // event (R); an open arrival is the controller's S stop.
            self.network.spray_next_instant(t).and_then(|(a, c)| {
                (c == crate::control::spray_valve::StemChange::Lock).then_some(a)
            }),
        ]
        .into_iter()
        .flatten()
        .reduce(f64::min)
    }
    fn deposit(&self, done: &[super::block::Transaction], y: &mut [f64]) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        for (store, energy) in done.iter().flat_map(|t| &t.deposits) {
            let i = self
                .blocks
                .solids
                .passive_store(store)
                .ok_or_else(|| {
                    fatal(format!(
                        "deposit into passive store {store}: unknown or of a replica class (E-NUC)"
                    ))
                })?;
            let scale = self.blocks.scales[1].coordinates[i];
            y[o.solids + i] += energy / scale;
        }
        Ok(())
    }

    /// Startup only: let the composed owners prepare their coordinates on
    /// the fluid state of one value evaluation at `(t, y, 0)`, then write
    /// their prepared coordinates into `y`. No differential coordinate of
    /// any block moves except the stocks an owner declares it prepares at
    /// the composed state (HOOK OU-C P2: the rod bores' water).
    pub fn prepare_owners(
        &mut self,
        t: f64,
        y: &mut [f64],
    ) -> Result<Vec<super::block::Transaction>, Failure> {
        let zero = vec![0.; y.len()];
        self.blocks.prepare = Some(Vec::new());
        let evaluated = self.evaluate(t, y, &zero, None, 0., None);
        let done = self.blocks.prepare.take().unwrap_or_default();
        evaluated?;
        let o = self.blocks.offsets;
        if let RodPort::Owner(b) = &self.blocks.rods {
            let ids = b.differential();
            let stocks = b.prepared_stocks();
            for (i, (v, scale)) in b
                .prepared()
                .iter()
                .zip(&self.blocks.scales[3].coordinates)
                .enumerate()
            {
                let new = v / scale;
                if ids[i] != 0. && new != y[o.rods + i] && !stocks.contains(&i) {
                    return Err(fatal(format!(
                        "the rod owner's preparation moved differential coordinate {i}"
                    )));
                }
                y[o.rods + i] = new;
            }
        }
        Ok(done)
    }

    /// Memo §3 (C): the fixed-stock surface initializer at the state's own
    /// water and flows. One value evaluation at `(t, y, 0)` supplies them;
    /// only the surface coordinates of `y` are rewritten.
    pub fn initialize_surfaces(
        &mut self,
        t: f64,
        y: &mut [f64],
        policy: crate::initialization::SurfacePolicy,
    ) -> Result<Vec<crate::initialization::SurfaceInitialization>, Failure> {
        let zero = vec![0.; y.len()];
        self.evaluate(t, y, &zero, None, 0., None)?;
        let o = self.blocks.offsets;
        let b = &self.blocks;
        let x = view(
            y,
            &zero,
            None,
            0.,
            o.solids..o.secondary,
            &b.scales[1].coordinates,
        )?;
        let solved = b
            .solids
            .initialize_surfaces(&b.properties, x, &b.temperatures, policy)?;
        for (i, r) in solved.iter().enumerate() {
            let t = r.temperatures;
            for (k, v) in [t.fuel_surface, t.clad_inner, t.clad_outer]
                .iter()
                .enumerate()
            {
                let index = b.solids.surface(i, k);
                y[o.solids + index] = v.value / b.scales[1].coordinates[index];
            }
        }
        Ok(solved)
    }

    /// The network and a local coupler over the blocks, borrowed disjointly,
    /// for a block Jacobian's network columns at `(t, y, y')` and `cj`.
    pub fn local_parts<'a>(
        &'a mut self,
        t: f64,
        y: &'a [f64],
        yp: &'a [f64],
        cj: f64,
    ) -> (&'a Network<P>, LocalCoupler<'a, P>) {
        let endpoints = self.faces.iter().map(|f| (f.from, f.to)).collect();
        let rod_rows = Vec::new();
        let scratch = Scratch {
            seed: vec![0.; self.blocks.offsets.end],
            secondary_rows: vec![s(0.); self.blocks.secondary_rows.len()],
            sink: vec![[[s(0.); 3]; 2]; self.blocks.compiled_volumes.len()],
            ..Scratch::default()
        };
        (
            &self.network,
            LocalCoupler {
                blocks: &mut self.blocks,
                t,
                rod_rows,
                scratch,
                y,
                yp,
                cj,
                endpoints,
                last: LocalRows::default(),
                solid_rows: Vec::new(),
                heat: solids::Heat::default(),
                last_pzr: Vec::new(),
            },
        )
    }

    /// The colored stage Jacobian `dF/dy + cj dF/dy'` at `(t, y, y')` into
    /// `values`, in the stored order of the compiled pattern.
    pub fn jacobian(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let Some((pattern, coloring)) = self.structure.take() else {
            return Err(fatal("the joined structure is held by another assembly"));
        };
        let result = (|| {
            let n = self.dimension();
            let mut reuse = self.network.reuse();
            self.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
            let mut signs = vec![1.; n];
            signs[..self.blocks.offsets.nuclear]
                .copy_from_slice(&self.network.column_signs(&y[..self.blocks.offsets.nuclear]));
            let mut seed = vec![0.; n];
            let mut directions = vec![0.; n];
            for color in 0..coloring.count() {
                coloring
                    .seed_into(color, &signs, &mut seed)
                    .map_err(fatal)?;
                self.evaluate(t, y, yp, Some(&seed), cj, Some(&mut reuse))?;
                for (d, r) in directions.iter_mut().zip(&self.rows) {
                    *d = r.direction;
                }
                sparse::scatter(&pattern, &coloring, color, &directions, &signs, values)
                    .map_err(|e| fatal(format!("color {color}: {e}")))?;
            }
            Ok(())
        })();
        self.structure = Some((pattern, coloring));
        self.counters.jacobians += 1;
        self.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
        result
    }

    /// Network coordinates of a regular cell (or the PZR block).
    fn cell(&self, c: usize) -> std::ops::Range<usize> {
        if c == self.network.pzr.cell {
            return self.network.pzr.coordinates();
        }
        let base = self.network.cell_layout[c].base;
        base..base + 6
    }
    fn impulses(&self, f: usize) -> [usize; 2] {
        [
            self.network.face_layout[2 * f].index,
            self.network.face_layout[2 * f + 1].index,
        ]
    }
    /// Every coordinate a face's chart reads: impulses, supports, endpoints.
    fn face_flux(&self, f: usize, out: &mut BTreeSet<usize>) {
        out.extend(self.impulses(f));
        let face = &self.faces[f];
        for r in face.supports.iter().chain([&face.from, &face.to]) {
            out.extend(self.cell(*r));
        }
    }
    /// Every coordinate a wall law at cell `c` reads: its water and the
    /// charts of its incident faces (the mass flux).
    fn wall(&self, c: usize, out: &mut BTreeSet<usize>) {
        out.extend(self.cell(c));
        for f in 0..self.faces.len() {
            if self.faces[f].from == c || self.faces[f].to == c {
                self.face_flux(f, out);
            }
        }
    }

    /// The joined structural pattern: rows per column, sorted and unique.
    pub fn structural_pattern(&self) -> Result<Vec<Vec<usize>>, Failure> {
        let o = self.blocks.offsets;
        let n = o.end;
        let mut columns: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        let add =
            |columns: &mut Vec<BTreeSet<usize>>, rows: &BTreeSet<usize>, cols: &BTreeSet<usize>| {
                for c in cols {
                    columns[*c].extend(rows.iter().copied());
                }
            };
        for (c, rows) in self.network.structural_pattern().into_iter().enumerate() {
            columns[c].extend(rows);
        }
        let nuc = &self.blocks.nuclear;
        let sol = &self.blocks.solids;
        // E-NUC: a "carrier" here is a nuclear port, one per solids half.
        let (regions, carriers) = (nuc.regions(), nuc.ports());
        let mut regions_of = vec![BTreeSet::new(); carriers];
        let mut carriers_of = vec![BTreeSet::new(); regions];
        for support in nuc.port_supports() {
            regions_of[support.material].insert(support.region);
            carriers_of[support.region].insert(support.material);
        }
        let n_of = |i: usize| o.nuclear + i;
        // E-NUC: a port's nuclear state is its replica group's.
        let group = nuc.port_group();
        let carrier_vars = |carrier: usize, out: &mut BTreeSet<usize>| {
            let a = group[carrier];
            for g in 0..6 {
                out.insert(o.nuclear + nuc.precursor(a, g));
                out.insert(o.nuclear + nuc.material(a, g));
            }
            for g in 0..nuclear::HISTORIES {
                out.insert(o.nuclear + nuc.history(a, g));
            }
        };
        let carrier_rows = |a: usize| {
            let mut rows = BTreeSet::new();
            carrier_vars(a, &mut rows);
            rows
        };
        // Every nuclear row of a carrier: its own nuclear state and the
        // populations of its support regions.
        let heat_source = |a: usize, out: &mut BTreeSet<usize>| {
            carrier_vars(a, out);
            out.extend(regions_of[a].iter().map(|i| n_of(*i)));
        };
        // A carrier's prompt and binding heat: its fissions and captures,
        // which read the support populations, fissile, fertile, Xe and Sm.
        let events = |a: usize, out: &mut BTreeSet<usize>| {
            for k in [0, 1, 3, 5] {
                out.insert(o.nuclear + nuc.material(group[a], k));
            }
            out.extend(regions_of[a].iter().map(|i| n_of(*i)));
        };
        // Its fuel heat adds the released history energy.
        let fuel_heat = |a: usize, out: &mut BTreeSet<usize>| {
            events(a, out);
            for g in 0..nuclear::HISTORIES {
                out.insert(o.nuclear + nuc.history(group[a], g));
            }
        };
        let half_vars = |a: usize, out: &mut BTreeSet<usize>| {
            for k in 0..3 {
                out.insert(o.solids + sol.energy(a, k));
                out.insert(o.solids + sol.surface(a, k));
            }
        };
        let incidence = sol.incidence();
        let rod_outputs: BTreeSet<usize> = match &self.blocks.rods {
            RodPort::Owner(b) => b
                .structure()
                .outputs
                .iter()
                .flatten()
                .map(|i| o.rods + i)
                .collect(),
            RodPort::Prepared(_) => BTreeSet::new(),
        };
        let secondary_outputs: Vec<BTreeSet<usize>> = match &self.blocks.secondary {
            SecondaryPort::Owner(b) => b
                .structure()
                .outputs
                .iter()
                .map(|v| v.iter().map(|i| o.secondary + i).collect())
                .collect(),
            SecondaryPort::Prepared(_) => vec![BTreeSet::new(); sol.secondaries()],
        };
        // 1. Nuclear rows.
        for (i, carriers_i) in carriers_of.iter().enumerate() {
            let rows = BTreeSet::from([n_of(i)]);
            let mut cols: BTreeSet<usize> = (0..regions).map(n_of).collect();
            for a in carriers_i {
                for g in 0..6 {
                    cols.insert(o.nuclear + nuc.precursor(group[*a], g));
                }
                for k in [0, 1, 3, 5] {
                    cols.insert(o.nuclear + nuc.material(group[*a], k));
                }
                cols.insert(o.solids + sol.energy(*a, 0));
                cols.insert(o.solids + sol.energy(*a, 1));
            }
            cols.extend(self.cell(self.blocks.source_water[i]));
            cols.extend(rod_outputs.iter().copied());
            add(&mut columns, &rows, &cols);
        }
        for a in 0..carriers {
            let rows = carrier_rows(a);
            let mut cols = BTreeSet::new();
            heat_source(a, &mut cols);
            add(&mut columns, &rows, &cols);
        }
        // 2. Solid rows.
        for (a, (helium, cells)) in incidence.halves.iter().enumerate() {
            let mut rows = BTreeSet::new();
            half_vars(a, &mut rows);
            let mut cols = rows.clone();
            cols.insert(o.solids + sol.helium(*helium));
            fuel_heat(a, &mut cols);
            for c in cells {
                self.wall(*c, &mut cols);
            }
            add(&mut columns, &rows, &cols);
        }
        for h in 0..incidence
            .halves
            .iter()
            .map(|(h, _)| h + 1)
            .max()
            .unwrap_or(0)
        {
            let rows = BTreeSet::from([o.solids + sol.helium(h)]);
            let mut cols = rows.clone();
            for (a, (helium, _)) in incidence.halves.iter().enumerate() {
                if *helium == h {
                    half_vars(a, &mut cols);
                }
            }
            for (helium, p) in &incidence.plenum {
                if *helium == h {
                    cols.insert(o.solids + sol.passive(*p));
                }
            }
            add(&mut columns, &rows, &cols);
        }
        let passive_count = incidence
            .passive
            .iter()
            .map(|(p, _)| p + 1)
            .chain(incidence.plenum.iter().map(|(_, p)| p + 1))
            .max()
            .unwrap_or(0);
        for p in 0..passive_count {
            let rows = BTreeSet::from([o.solids + sol.passive(p)]);
            let mut cols = rows.clone();
            for (q, c) in &incidence.passive {
                if *q == p {
                    cols.extend(self.cell(*c));
                }
            }
            for (h, q) in &incidence.plenum {
                if *q == p {
                    cols.insert(o.solids + sol.helium(*h));
                }
            }
            add(&mut columns, &rows, &cols);
        }
        for (i, (primary, secondary)) in incidence.segments.iter().enumerate() {
            let rows = BTreeSet::from([o.solids + sol.metal(i)]);
            let mut cols = rows.clone();
            self.wall(*primary, &mut cols);
            cols.extend(secondary_outputs[*secondary].iter().copied());
            add(&mut columns, &rows, &cols);
        }
        // 3. Network stock rows through the heat port.
        let cells = self.network.cell_layout.len();
        for c in 0..cells {
            let rows: BTreeSet<usize> = self.cell(c).collect();
            let mut cols = BTreeSet::new();
            for (a, (_, wets)) in incidence.halves.iter().enumerate() {
                if wets.contains(&c) {
                    half_vars(a, &mut cols);
                }
            }
            for (a, deposits) in nuc.deposition().iter().enumerate() {
                if deposits.iter().any(|(cell, _)| *cell == c) {
                    events(a, &mut cols);
                }
            }
            for (p, water) in &incidence.passive {
                if *water == c {
                    cols.insert(o.solids + sol.passive(*p));
                }
            }
            for (i, (primary, _)) in incidence.segments.iter().enumerate() {
                if *primary == c {
                    cols.insert(o.solids + sol.metal(i));
                }
            }
            add(&mut columns, &rows, &cols);
        }
        // 4. The owners' rows and receipts.
        if let RodPort::Owner(b) = &self.blocks.rods {
            let st = b.structure();
            for (r, own) in st.own.iter().enumerate() {
                let rows = BTreeSet::from([o.rods + r]);
                let mut cols: BTreeSet<usize> = own.iter().map(|i| o.rods + i).collect();
                for c in st.cells.get(r).into_iter().flatten() {
                    cols.extend(self.cell(*c));
                }
                for f in st.faces.get(r).into_iter().flatten() {
                    self.face_flux(*f, &mut cols);
                }
                add(&mut columns, &rows, &cols);
            }
            for (cell, own, read) in &st.receipts {
                let mut rows: BTreeSet<usize> = self.cell(*cell).collect();
                for (f, face) in self.faces.iter().enumerate() {
                    if face.supports.contains(cell) {
                        rows.extend(self.impulses(f));
                    }
                }
                let mut cols: BTreeSet<usize> = own.iter().map(|i| o.rods + i).collect();
                for c in read {
                    cols.extend(self.cell(*c));
                }
                add(&mut columns, &rows, &cols);
            }
        }
        if let SecondaryPort::Owner(b) = &self.blocks.secondary {
            let st = b.structure();
            for (r, own) in st.own.iter().enumerate() {
                let rows = BTreeSet::from([o.secondary + r]);
                let mut cols: BTreeSet<usize> = own.iter().map(|i| o.secondary + i).collect();
                for g in st.heat.get(r).into_iter().flatten() {
                    for (i, (primary, secondary)) in incidence.segments.iter().enumerate() {
                        if secondary == g {
                            cols.insert(o.solids + sol.metal(i));
                            self.wall(*primary, &mut cols);
                        }
                    }
                    cols.extend(secondary_outputs[*g].iter().copied());
                }
                add(&mut columns, &rows, &cols);
            }
        }
        // Moving volumes: a cell's volume reaches every row its own
        // coordinates reach (EOS, fractions, inertance, feedback density).
        if let RodPort::Owner(b) = &self.blocks.rods {
            for (cell, own) in &b.structure().volumes {
                let mut rows = BTreeSet::new();
                for c in self.cell(*cell) {
                    rows.extend(columns[c].iter().copied());
                }
                let cols: BTreeSet<usize> = own.iter().map(|i| o.rods + i).collect();
                add(&mut columns, &rows, &cols);
            }
        }
        // 5. The PZR block (G6): each steel row reads the cell's column (the
        // cell's coordinates) and the steels its enclosure couples; the lift
        // row its own lift. The cell's rows read every block coordinate
        // through the boundary: heater and wall receipts and the relief.
        {
            let b = &self.blocks.pzr;
            let cell: BTreeSet<usize> = self.network.pzr.coordinates().collect();
            let metal: BTreeSet<usize> = (o.pzr + b.metal_base()..o.end).collect();
            let mut cols = cell.clone();
            cols.extend(metal.iter().copied());
            add(&mut columns, &metal, &cols);
            let own: BTreeSet<usize> = (o.pzr..o.end).collect();
            add(&mut columns, &cell, &own);
        }
        for (c, rows) in columns.iter_mut().enumerate() {
            rows.insert(c);
        }
        Ok(columns
            .into_iter()
            .map(|rows| rows.into_iter().collect())
            .collect())
    }
}

impl<P: Properties + WaterProperties> Blocks<P> {
    /// The rods' travel and cell volumes before the network's cells.
    fn pre_network(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<(), Failure> {
        let o = self.offsets;
        match &self.rods {
            RodPort::Owner(b) => {
                let x = view(y, yp, seed, cj, o.rods..o.pzr, &self.scales[3].coordinates)?;
                b.travel(x, &mut self.travel)?;
                b.volumes(x, &self.compiled_volumes, &mut self.cell_volumes)?;
            }
            RodPort::Prepared(travel) => {
                for (t, v) in self.travel.iter_mut().zip(travel) {
                    *t = s(*v);
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // The coupling's stage inputs.
    fn couple(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let o = self.offsets;
        let Blocks {
            properties,
            nuclear,
            solids,
            secondary,
            rods,
            source_water,
            nuclear_rows,
            solid_rows,
            secondary_rows,
            rod_rows,
            temperatures,
            fuel_t,
            water,
            travel,
            views,
            heats,
            scales,
            ..
        } = self;
        match secondary {
            SecondaryPort::Owner(b) => {
                let x = view(y, yp, seed, cj, o.secondary..o.rods, &scales[2].coordinates)?;
                b.views(properties, x, views)?;
            }
            SecondaryPort::Prepared(v) => views.copy_from_slice(v),
        }
        let xs = view(
            y,
            yp,
            seed,
            cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )?;
        solids.temperatures(xs, temperatures)?;
        for (a, f) in fuel_t.iter_mut().enumerate() {
            *f = thermal::fuel_feedback_temperature(
                temperatures.fuel[a][0],
                temperatures.fuel[a][1],
            )
            .map_err(trial)?;
        }
        for (i, w) in water.iter_mut().enumerate() {
            *w = region_water(fluid, i, source_water[i])?;
        }
        let xn = view(y, yp, seed, cj, o.nuclear..o.solids, &scales[0].coordinates)?;
        let cost_scope = crate::cost::scope("nuclear");
        nuclear.rows(
            t,
            xn,
            fuel_t,
            water,
            travel,
            nuclear_rows,
            &mut heats.nuclear,
        )?;
        heats.coolant_w = s(0.);
        for (a, deposits) in nuclear.deposition().iter().enumerate() {
            for (cell, fraction) in deposits {
                let q = s(*fraction) * heats.nuclear.coolant_w[a];
                heats.coolant_w = heats.coolant_w + q;
                receipts.heat(*cell, q)?;
            }
        }
        drop(cost_scope);
        let cost_scope = crate::cost::scope("solids");
        solids.wall_water(properties, fluid)?;
        solids.rows(
            properties,
            xs,
            temperatures,
            &heats.nuclear.fuel_w,
            fluid,
            views,
            receipts,
            solid_rows,
            &mut heats.solids,
        )?;
        drop(cost_scope);
        if let RodPort::Owner(b) = rods {
            let _cost = crate::cost::scope("rods");
            if let Some(done) = self.prepare.as_mut() {
                done.push(b.prepare(properties, fluid)?);
            }
            let x = view(y, yp, seed, cj, o.rods..o.pzr, &scales[3].coordinates)?;
            b.rows(properties, t, x, fluid, receipts, rod_rows)?;
        }
        if let SecondaryPort::Owner(b) = secondary {
            let _cost = crate::cost::scope("secondary");
            let x = view(y, yp, seed, cj, o.secondary..o.rods, &scales[2].coordinates)?;
            b.rows(properties, t, x, &heats.solids.secondary_w, secondary_rows)?;
        }
        // Scale every block's physical rows into the joined rows.
        let mut k = 0;
        for (physical, block) in [nuclear_rows, solid_rows, secondary_rows, rod_rows]
            .into_iter()
            .zip(scales.iter())
        {
            for (r, row_scale) in physical.iter().zip(&block.rows) {
                rows[k] = *r / s(*row_scale);
                k += 1;
            }
        }
        if rows
            .iter()
            .any(|r| !(r.value.is_finite() && r.direction.is_finite()))
        {
            return Err(trial("nonfinite joined block row"));
        }
        self.coupled_wall_s += started.elapsed().as_secs_f64();
        Ok(())
    }

    /// The PZR block's rows (into the joined `rows`, block scaling) and the
    /// stratified cell's boundary on `column`, at the block's coordinates
    /// with `seed`.
    #[allow(clippy::too_many_arguments)] // The coupling's stage inputs and the cell's column.
    fn pzr_boundary(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        cell: &stratified::Cell,
        column: &stratified::Column,
        rows: &mut [Scalar],
    ) -> Result<stratified::Boundary, Failure> {
        let o = self.offsets;
        let b = &mut self.pzr;
        let x = view(y, yp, seed, cj, o.pzr..o.end, &self.scales[4].coordinates)?;
        let boundary = b.boundary(
            &self.properties,
            cell,
            column,
            x,
            &mut self.pzr_rows,
            seed.is_none(),
        )?;
        let first = o.pzr - o.nuclear;
        for (k, (r, row_scale)) in self.pzr_rows.iter().zip(&self.scales[4].rows).enumerate() {
            let v = *r / s(*row_scale);
            if !(v.value.is_finite() && v.direction.is_finite()) {
                return Err(trial("nonfinite PZR block row"));
            }
            rows[first + k] = v;
        }
        Ok(boundary)
    }
}

/// The source feedback's water of region `i` from its owner cell `j`:
/// `rho = (M_l + M_v)/V(y)`, ppm from the liquid tracer, the local pressure
/// and the liquid temperature, with their directions.
fn region_water(fluid: &Fluid<'_>, i: usize, j: usize) -> Result<RegionWater, Failure> {
    let liquid = fluid.liquid_mass[j];
    let (q, d) = fluid.points[j][0]
        .ok_or_else(|| trial(format!("source region {i}'s cell {j} has no liquid")))?;
    Ok(RegionWater {
        density_kg_m3: (liquid + fluid.vapor_mass[j]) / fluid.current_volumes[j],
        boron_ppm_eq: s(1e6) * fluid.tracer[j] / liquid,
        pressure_pa: fluid.cells[j].pressure,
        temperature_k: Scalar::new(q.temperature_k, d.temperature_k),
        vapor_kg: fluid.vapor_mass[j],
    })
}

/// What one owner column of a block Jacobian moved, all with their
/// directions for a unit seed on the column: global joined rows in solver
/// scaling (solids, secondary and rods), the feedback fuel temperature per
/// carrier, travel per cluster, moving cell volumes and the complete
/// metal-to-secondary heat per SG reached.
#[derive(Clone, Debug, Default)]
pub struct OwnerRows {
    pub rows: Vec<(usize, Scalar)>,
    pub fuel_t: Vec<(usize, Scalar)>,
    pub travel: Vec<(usize, Scalar)>,
    pub volumes: Vec<(usize, CellVolume)>,
    pub secondary_w: Vec<(usize, Scalar)>,
}
impl OwnerRows {
    fn clear(&mut self) {
        self.rows.clear();
        self.fuel_t.clear();
        self.travel.clear();
        self.volumes.clear();
        self.secondary_w.clear();
    }
}

/// Reused buffers of the owner columns.
#[derive(Default)]
struct Scratch {
    /// Global unit seed, zero outside the current column.
    seed: Vec<f64>,
    views: Vec<SecondaryView>,
    heat_w: Vec<Scalar>,
    secondary_rows: Vec<Scalar>,
    travel: Vec<Scalar>,
    volumes: Vec<CellVolume>,
    /// Receipts of a port whose receipts must stay without direction.
    sink: Vec<[[Scalar; 3]; 2]>,
    /// The rod clusters one call evaluates.
    clusters: Vec<usize>,
    /// One local coupling call's scope key.
    key: Vec<usize>,
}

/// What one local coupling call re-evaluated: global joined rows in solver
/// scaling, the source feedback's water of the regions whose owner cell is
/// listed, and the complete metal-to-secondary heat of each SG reached.
#[derive(Clone, Debug, Default)]
pub struct LocalRows {
    pub rows: Vec<(usize, Scalar)>,
    pub water: Vec<(usize, RegionWater)>,
    pub secondary_w: Vec<(usize, Scalar)>,
}

/// The joined blocks' port terms for one network column of a block
/// Jacobian, on a borrow disjoint from the network ([`Joined::local_parts`]).
/// It requires a preceding unseeded [`Joined::evaluate`] at the same
/// `(t, y, y')`: temperatures, nuclear heat, SG views and every wall water
/// outside the column are that evaluation's, and the owners' coordinates
/// are read unseeded, since a network column moves only the fluid.
pub struct LocalCoupler<'a, P> {
    blocks: &'a mut Blocks<P>,
    t: f64,
    /// The evaluated rod clusters' rows, `(own row, value)`.
    rod_rows: Vec<(usize, Scalar)>,
    scratch: Scratch,
    y: &'a [f64],
    yp: &'a [f64],
    cj: f64,
    endpoints: Vec<(usize, usize)>,
    last: LocalRows,
    solid_rows: Vec<(usize, Scalar)>,
    heat: solids::Heat,
    /// The PZR block's rows of the last PZR call, global joined rows in
    /// solver scaling.
    last_pzr: Vec<(usize, Scalar)>,
}

impl<P: Properties + WaterProperties> LocalCoupler<'_, P> {
    /// The wall cells a column reaches: its listed cells and the endpoints
    /// of its listed faces, each read by a wall's mass flux.
    fn wall_cells(&self, cells: &[usize], faces: &[usize]) -> Vec<usize> {
        let mut wall: Vec<usize> = cells
            .iter()
            .copied()
            .chain(
                faces
                    .iter()
                    .flat_map(|f| [self.endpoints[*f].0, self.endpoints[*f].1]),
            )
            .collect();
        wall.sort_unstable();
        wall.dedup();
        wall
    }
    fn scope(&self, cells: &[usize], wall: &[usize]) -> solids::Closed {
        let sol = &self.blocks.solids;
        sol.close(&solids::SolidScope {
            bands: sol.halves_wetting(wall),
            passive: sol.passive_wetted_by(cells),
            plenum: Vec::new(),
            segments: sol.segments_wetted_by(wall),
        })
    }
    /// Whether the rod owner reads any of `cells` or `faces`.
    fn rods_reached(&self, cells: &[usize], faces: &[usize]) -> bool {
        self.blocks
            .rod_reads
            .as_ref()
            .is_some_and(|r| cells.iter().any(|c| r.cells[*c]) || faces.iter().any(|f| r.faces[*f]))
    }
    /// Re-evaluate only the port terms reading `cells` (whose fluid state
    /// moved) and `faces` (whose liquid flux moved), closed over incidence,
    /// adding their receipts into `receipts`. [`LocalCoupler::last`] then
    /// holds every row they complete, value for value equal to the full
    /// coupling's. The column's wall water is refreshed for the call and
    /// put back after it, so every other column reads the base water. The
    /// rod clusters that read a listed cell whose fluid moved are evaluated:
    /// their rows and guide receipts ([`Rods::readers`]).
    pub fn local(
        &mut self,
        cells: &[usize],
        faces: &[usize],
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let result = self.local_terms(cells, faces, fluid, receipts);
        self.blocks.coupler.local.add(started);
        result
    }
    fn local_terms(
        &mut self,
        cells: &[usize],
        faces: &[usize],
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
    ) -> Result<(), Failure> {
        let key = &mut self.scratch.key;
        key.clear();
        key.extend_from_slice(cells);
        key.push(usize::MAX);
        key.extend_from_slice(faces);
        if !self.blocks.local_scopes.contains_key(&key[..]) {
            let wall = self.wall_cells(cells, faces);
            let scope = self.scope(cells, &wall);
            let key = self.scratch.key.clone();
            self.blocks.local_scopes.insert(key, (wall, scope));
        }
        let o = self.blocks.offsets;
        let Blocks {
            properties,
            solids,
            temperatures,
            views,
            heats,
            scales,
            source_water,
            coupler,
            local_scopes,
            ..
        } = &mut *self.blocks;
        let (wall, scope) = &local_scopes[&self.scratch.key[..]];
        let solids_started = Instant::now();
        let replaced = solids.wall_water_local(properties, fluid, wall)?;
        let solved = view(
            self.y,
            self.yp,
            None,
            self.cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )
        .and_then(|x| {
            // HOOK (COST lane): directions only, as every reader of this
            // call takes them (Solids::rows_local_directions).
            solids.rows_local_directions(
                properties,
                x,
                temperatures,
                &heats.nuclear.fuel_w,
                fluid,
                views,
                scope,
                receipts,
                &mut self.solid_rows,
                &mut self.heat,
            )
        });
        solids.restore_wall_water(replaced);
        coupler.local_solids.add(solids_started);
        solved?;
        self.last.rows.clear();
        self.last.rows.extend(
            self.solid_rows
                .iter()
                .map(|(i, r)| (o.solids + i, *r / s(scales[1].rows[*i]))),
        );
        self.last.secondary_w.clear();
        self.last.secondary_w.extend(
            scope
                .generators
                .iter()
                .map(|g| (*g, self.heat.secondary_w[*g])),
        );
        self.last.water.clear();
        for (i, j) in source_water.iter().enumerate() {
            if cells.contains(j) {
                self.last.water.push((i, region_water(fluid, i, *j)?));
            }
        }
        if self.rods_reached(cells, faces) {
            let rods_started = Instant::now();
            let Blocks {
                properties,
                rods,
                scales,
                ..
            } = &mut *self.blocks;
            let RodPort::Owner(b) = rods else {
                return Err(fatal("rod reads without a rod owner"));
            };
            let x = view(
                self.y,
                self.yp,
                None,
                self.cj,
                o.rods..o.pzr,
                &scales[3].coordinates,
            )?;
            // Only the clusters reading a moved cell take a direction.
            let clusters = &mut self.scratch.clusters;
            let evaluated = b.readers(x, fluid, cells, faces, clusters).and_then(|()| {
                b.rows_local(
                    properties,
                    self.t,
                    x,
                    fluid,
                    clusters,
                    receipts,
                    &mut self.rod_rows,
                )
            });
            self.blocks.coupler.local_rods.add(rods_started);
            evaluated?;
            let scales = &self.blocks.scales;
            self.last.rows.extend(
                self.rod_rows
                    .iter()
                    .map(|(i, r)| (o.rods + i, *r / s(scales[3].rows[*i]))),
            );
        }
        Ok(())
    }
    pub fn last(&self) -> &LocalRows {
        &self.last
    }
    /// The PZR block's rows of the last [`LocalCoupler::pzr_boundary`] or
    /// [`LocalCoupler::pzr_column`] call.
    pub fn last_pzr(&self) -> &[(usize, Scalar)] {
        &self.last_pzr
    }
    /// The stratified cell's boundary on `column`, a network PZR column's
    /// (base values with its directions), with the block's own coordinates
    /// unseeded; its rows are [`LocalCoupler::last_pzr`]. Closed with no
    /// PZR owner.
    pub fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        let started = Instant::now();
        let result = self.pzr_terms(None, cell, column);
        self.blocks.coupler.pzr.add(started);
        result
    }
    /// One PZR block column (global index): the block's rows with a unit
    /// seed on it at the base column `column`, and the boundary with that
    /// seed's directions, which the network's stratified rows read
    /// (`NetworkSeed::pzr_boundary`).
    pub fn pzr_column(
        &mut self,
        global: usize,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        let o = self.blocks.offsets;
        if !(o.pzr..o.end).contains(&global) {
            return Err(fatal(format!("PZR column {global} outside the PZR block")));
        }
        let started = Instant::now();
        self.scratch.seed[global] = 1.;
        let result = self.pzr_terms(Some(global), cell, column);
        self.scratch.seed[global] = 0.;
        self.blocks.coupler.pzr.add(started);
        result
    }
    fn pzr_terms(
        &mut self,
        seeded: Option<usize>,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        let o = self.blocks.offsets;
        self.last_pzr.clear();
        let Blocks {
            properties,
            pzr,
            pzr_rows,
            scales,
            ..
        } = &mut *self.blocks;
        let b = pzr;
        let x = view(
            self.y,
            self.yp,
            seeded.map(|_| &self.scratch.seed[..]),
            self.cj,
            o.pzr..o.end,
            &scales[4].coordinates,
        )?;
        let boundary = b.boundary(properties, cell, column, x, pzr_rows, false)?;
        self.last_pzr.extend(
            pzr_rows
                .iter()
                .zip(&scales[4].rows)
                .enumerate()
                .map(|(k, (r, row_scale))| (o.pzr + k, *r / s(*row_scale))),
        );
        Ok(boundary)
    }
    /// What [`LocalCoupler::local`] would reach, without evaluating: the
    /// network cells its receipts enter and the global joined rows it
    /// writes (region water and SG heat are its separate ports).
    pub fn reach(&self, cells: &[usize], faces: &[usize]) -> (Vec<usize>, Vec<usize>) {
        let wall = self.wall_cells(cells, faces);
        let scope = self.scope(cells, &wall);
        let sol = &self.blocks.solids;
        let o = self.blocks.offsets;
        let incidence = sol.incidence();
        let rods = self.rods_reached(cells, faces);
        let rod_receipts = self
            .blocks
            .rod_reads
            .iter()
            .filter(|_| rods)
            .flat_map(|r| r.receipt_cells.iter().copied());
        let mut receipt_cells: Vec<usize> = scope
            .bands
            .iter()
            .flat_map(|b| incidence.halves[*b].1.iter().copied())
            .chain(scope.passive.iter().map(|k| incidence.passive[*k].1))
            .chain(scope.segments.iter().map(|k| incidence.segments[*k].0))
            .chain(rod_receipts)
            .collect();
        receipt_cells.sort_unstable();
        receipt_cells.dedup();
        let rod_rows = if rods { o.rods..o.pzr } else { 0..0 };
        let mut rows: Vec<usize> = scope
            .bands
            .iter()
            .flat_map(|b| (0..3).flat_map(move |k| [sol.energy(*b, k), sol.surface(*b, k)]))
            .chain(scope.helium.iter().map(|h| sol.helium(*h)))
            .chain(scope.stores.iter().map(|p| sol.passive(*p)))
            .chain(scope.segments.iter().map(|g| sol.metal(*g)))
            .map(|i| o.solids + i)
            .chain(rod_rows)
            .collect();
        rows.sort_unstable();
        (receipt_cells, rows)
    }

    /// One solid, secondary or rod column (global index): every owner term
    /// that reads it, with a unit seed on it at the base state and the fluid
    /// unseeded, adding the owners' receipt directions into `receipts`.
    /// - Solids: the closed scope of the elements reading the column, with
    ///   the seeded store's temperature; the feedback fuel temperature of a
    ///   fuel energy; the heat of every SG reached.
    /// - Secondary: the seeded views of the SGs reading the column, their
    ///   segments' metal rows, then the secondary rows with the seeded own
    ///   coordinates and the seeded heat. The heat's path is therefore
    ///   already in `rows`, and `secondary_w` stays empty: chaining it again
    ///   through [`LocalCoupler::secondary_heat_column`] would count it twice.
    /// - Rods: travel, moving volumes, and the rows and guide receipts of
    ///   the clusters reading the column.
    pub fn owner_column(
        &mut self,
        column: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        out.clear();
        if !(o.solids..o.pzr).contains(&column) {
            return Err(fatal(format!(
                "owner column {column} outside the solid, secondary and rod coordinates"
            )));
        }
        let started = Instant::now();
        self.scratch.seed[column] = 1.;
        let result = if column < o.secondary {
            self.solid_column(column - o.solids, fluid, receipts, out)
        } else if column < o.rods {
            self.secondary_column(column - o.secondary, fluid, receipts, out)
        } else {
            self.rod_column(column, fluid, receipts, out)
        };
        self.scratch.seed[column] = 0.;
        let c = &mut self.blocks.coupler;
        if column < o.secondary {
            c.solid_columns.add(started);
        } else if column < o.rods {
            c.secondary_columns.add(started);
        } else {
            c.rod_columns.add(started);
        }
        result
    }

    /// The solids' rows reading local solid coordinate `i`. Its closed
    /// scope is compiled once per coordinate; the seeded store's
    /// temperature is set in place for the call and restored after it.
    fn solid_column(
        &mut self,
        i: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let Blocks {
            properties,
            solids,
            temperatures,
            views,
            heats,
            scales,
            column_scopes,
            ..
        } = &mut *self.blocks;
        if column_scopes[i].is_none() {
            let (scope, store) = solids.column_scope(i)?;
            column_scopes[i] = Some((solids.close(&scope), store));
        }
        let Some((closed, store)) = &column_scopes[i] else {
            return Err(fatal("solid column scope"));
        };
        let x = view(
            self.y,
            self.yp,
            Some(&self.scratch.seed),
            self.cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )?;
        let saved = match store {
            Some(k) => Some((*k, *solids.temperature_of(*k, temperatures)?)),
            None => None,
        };
        let evaluated = (|| {
            if let Some((k, _)) = saved {
                solids.temperatures_local(x, &[k], temperatures)?;
            }
            // HOOK (COST lane): directions only, as every reader of this
            // owner column takes them (Solids::rows_local_directions).
            solids.rows_local_directions(
                properties,
                x,
                temperatures,
                &heats.nuclear.fuel_w,
                fluid,
                views,
                closed,
                receipts,
                &mut self.solid_rows,
                &mut self.heat,
            )?;
            let energies = 3 * solids.halves();
            if i < energies && i % 3 < 2 {
                let a = i / 3;
                out.fuel_t.push((
                    a,
                    thermal::fuel_feedback_temperature(
                        temperatures.fuel[a][0],
                        temperatures.fuel[a][1],
                    )
                    .map_err(trial)?,
                ));
            }
            Ok(())
        })();
        if let Some((k, t)) = saved {
            *solids.temperature_of(k, temperatures)? = t;
        }
        evaluated?;
        out.rows.extend(
            self.solid_rows
                .iter()
                .map(|(r, v)| (o.solids + r, *v / s(scales[1].rows[*r]))),
        );
        out.secondary_w.extend(
            closed
                .generators
                .iter()
                .map(|g| (*g, self.heat.secondary_w[*g])),
        );
        Ok(())
    }

    /// The SG views, metal rows and secondary rows reading local secondary
    /// coordinate `j`.
    fn secondary_column(
        &mut self,
        j: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let t = self.t;
        let Blocks {
            properties,
            solids,
            secondary,
            temperatures,
            views,
            heats,
            scales,
            secondary_outputs,
            ..
        } = &mut *self.blocks;
        let SecondaryPort::Owner(b) = secondary else {
            return Err(fatal("a secondary column without a secondary owner"));
        };
        let x = view(
            self.y,
            self.yp,
            Some(&self.scratch.seed),
            self.cj,
            o.secondary..o.rods,
            &scales[2].coordinates,
        )?;
        let seeded = &mut self.scratch.views;
        seeded.clone_from(views);
        b.views(properties, x, seeded)?;
        let generators: Vec<usize> = (0..secondary_outputs.len())
            .filter(|k| secondary_outputs[*k].contains(&j))
            .collect();
        let heat_w = &mut self.scratch.heat_w;
        heat_w.clone_from(&heats.solids.secondary_w);
        if !generators.is_empty() {
            let closed = solids.close(&solids::SolidScope {
                segments: solids.segments_of(&generators),
                ..solids::SolidScope::default()
            });
            let xs = view(
                self.y,
                self.yp,
                None,
                self.cj,
                o.solids..o.secondary,
                &scales[1].coordinates,
            )?;
            solids.rows_local(
                properties,
                xs,
                temperatures,
                &heats.nuclear.fuel_w,
                fluid,
                seeded,
                &closed,
                receipts,
                &mut self.solid_rows,
                &mut self.heat,
            )?;
            out.rows.extend(
                self.solid_rows
                    .iter()
                    .map(|(r, v)| (o.solids + r, *v / s(scales[1].rows[*r]))),
            );
            for g in &closed.generators {
                heat_w[*g] = self.heat.secondary_w[*g];
            }
        }
        let rows = &mut self.scratch.secondary_rows;
        b.rows(properties, t, x, heat_w, rows)?;
        out.rows.extend(
            rows.iter()
                .zip(&scales[2].rows)
                .enumerate()
                .map(|(i, (r, row_scale))| (o.secondary + i, *r / s(*row_scale))),
        );
        Ok(())
    }

    /// Travel, moving volumes, and the rows and guide receipts of the
    /// clusters reading the seeded rod coordinate (global `column`).
    fn rod_column(
        &mut self,
        column: usize,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        let Blocks {
            properties,
            rods,
            scales,
            compiled_volumes,
            rod_reads,
            ..
        } = &mut *self.blocks;
        let RodPort::Owner(b) = rods else {
            return Err(fatal("a rod column without a rod owner"));
        };
        let x = view(
            self.y,
            self.yp,
            Some(&self.scratch.seed),
            self.cj,
            o.rods..o.pzr,
            &scales[3].coordinates,
        )?;
        let travel = &mut self.scratch.travel;
        travel.resize(b.clusters(), s(0.));
        b.travel(x, travel)?;
        out.travel.extend(travel.iter().copied().enumerate());
        let volumes = &mut self.scratch.volumes;
        volumes.resize(
            compiled_volumes.len(),
            CellVolume {
                volume_m3: s(0.),
                rate_m3_s: s(0.),
            },
        );
        b.volumes(x, compiled_volumes, volumes)?;
        let moved = rod_reads.as_ref().map_or(&[][..], |r| &r.volume_cells[..]);
        out.volumes.extend(moved.iter().map(|c| (*c, volumes[*c])));
        // Only the clusters reading the seeded coordinate take a direction.
        let clusters = &mut self.scratch.clusters;
        b.coordinate_readers(column - o.rods, clusters)?;
        b.rows_local(
            properties,
            self.t,
            x,
            fluid,
            clusters,
            receipts,
            &mut self.rod_rows,
        )?;
        out.rows.extend(
            self.rod_rows
                .iter()
                .map(|(i, r)| (o.rods + i, *r / s(scales[3].rows[*i]))),
        );
        Ok(())
    }

    /// The owner rows' response to a unit direction (W) in carrier `a`'s
    /// fuel heat, the nuclear block's `fuel_w` port: that half's rows through
    /// the solids' own split, every coordinate and the fluid unseeded. The
    /// fuel heat enters no receipt; a receipt direction is refused.
    pub fn fuel_heat_column(
        &mut self,
        a: usize,
        fluid: &Fluid<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let started = Instant::now();
        let result = self.fuel_heat_terms(a, fluid, out);
        self.blocks.coupler.fuel_heat_columns.add(started);
        result
    }
    fn fuel_heat_terms(
        &mut self,
        a: usize,
        fluid: &Fluid<'_>,
        out: &mut OwnerRows,
    ) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        out.clear();
        let Blocks {
            properties,
            solids,
            temperatures,
            views,
            heats,
            scales,
            ..
        } = &mut *self.blocks;
        if a >= solids.halves() {
            return Err(fatal(format!("fuel heat carrier {a} outside the halves")));
        }
        let closed = solids.close(&solids::SolidScope {
            bands: vec![a],
            ..solids::SolidScope::default()
        });
        let x = view(
            self.y,
            self.yp,
            None,
            self.cj,
            o.solids..o.secondary,
            &scales[1].coordinates,
        )?;
        let fuel_w = &mut self.scratch.heat_w;
        fuel_w.clone_from(&heats.nuclear.fuel_w);
        fuel_w[a] = Scalar::new(fuel_w[a].value, 1.);
        let sink = &mut self.scratch.sink;
        sink.fill([[s(0.); 3]; 2]);
        solids.rows_local(
            properties,
            x,
            temperatures,
            fuel_w,
            fluid,
            views,
            &closed,
            &mut Receipts::new(sink),
            &mut self.solid_rows,
            &mut self.heat,
        )?;
        if sink.iter().flatten().flatten().any(|r| r.direction != 0.) {
            return Err(fatal(
                "fuel heat reaches a network receipt: fuel_heat_column needs a receipt port",
            ));
        }
        out.rows.extend(
            self.solid_rows
                .iter()
                .map(|(r, v)| (o.solids + r, *v / s(scales[1].rows[*r]))),
        );
        Ok(())
    }

    /// The secondary rows' response to a unit direction (W) in SG `g`'s
    /// metal-to-secondary heat, every coordinate unseeded.
    pub fn secondary_heat_column(&mut self, g: usize, out: &mut OwnerRows) -> Result<(), Failure> {
        let started = Instant::now();
        let result = self.secondary_heat_terms(g, out);
        self.blocks.coupler.secondary_heat_columns.add(started);
        result
    }
    fn secondary_heat_terms(&mut self, g: usize, out: &mut OwnerRows) -> Result<(), Failure> {
        let o = self.blocks.offsets;
        out.clear();
        let Blocks {
            properties,
            secondary,
            heats,
            scales,
            ..
        } = &mut *self.blocks;
        let SecondaryPort::Owner(b) = secondary else {
            return Err(fatal("a secondary heat column without a secondary owner"));
        };
        let heat_w = &mut self.scratch.heat_w;
        heat_w.clone_from(&heats.solids.secondary_w);
        let Some(h) = heat_w.get_mut(g) else {
            return Err(fatal(format!("secondary heat column {g} outside the SGs")));
        };
        *h = Scalar::new(h.value, 1.);
        let x = view(
            self.y,
            self.yp,
            None,
            self.cj,
            o.secondary..o.rods,
            &scales[2].coordinates,
        )?;
        let rows = &mut self.scratch.secondary_rows;
        b.rows(properties, self.t, x, heat_w, rows)?;
        out.rows.extend(
            rows.iter()
                .zip(&scales[2].rows)
                .enumerate()
                .map(|(i, (r, row_scale))| (o.secondary + i, *r / s(*row_scale))),
        );
        Ok(())
    }
}

/// The joined blocks as the network's coupling for one evaluation.
struct Coupler<'a, P> {
    blocks: &'a mut Blocks<P>,
    t: f64,
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
    rows: &'a mut [Scalar],
}

impl<P: Properties + WaterProperties> Coupling for Coupler<'_, P> {
    fn couple(&mut self, fluid: &Fluid<'_>, receipts: &mut Receipts<'_>) -> Result<(), Failure> {
        self.blocks.couple(
            self.t, self.y, self.yp, self.seed, self.cj, fluid, receipts, self.rows,
        )
    }
    fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        self.blocks
            .pzr_boundary(self.y, self.yp, self.seed, self.cj, cell, column, self.rows)
    }
}

//! spec: world/packs/process-plant/reference-designs/ld-01/safety/source-and-primary-protection.md#offline-acquired-pressure-decisions
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! The `ic` packet section as `reference-design-operating-ic.ts` compiles
//! it from strict wiki blocks: channel families, state reports, functions
//! and the holding chain's identities. Every field is required; there is no
//! default. Functions whose values have no strict block are listed under
//! `missing` by the compiler and never appear as functions.
use super::{acquisition::AnalogConfig, vote::Side};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub identity: String,
    /// The I&C frame (the protective channels' 0.1 s sampling).
    pub frame_s: f64,
    pub families: Vec<Family>,
    pub reports: Vec<ReportSpec>,
    pub functions: Vec<FunctionSpec>,
    /// Voted predicates evaluated and recorded per division with no cause,
    /// latch or output (a case line's acquired evidence where S3 implements
    /// no protective function, e.g. C2.N3's PZR LT vote).
    pub monitors: Vec<MonitorSpec>,
    pub holding: HoldingSpec,
    /// The reactor-trip → turbine-trip interlock (`ld01-reactor-trip-turbine-trip`,
    /// owner R12-A2).
    pub turbine_trip_on_reactor_trip: TurbineTripOnReactorTrip,
    /// `LD01.CORE.NI.SHUTDOWN`'s SOURCE-pulse path (plan r4 tag map), when
    /// the regional reference intensity is selected.
    #[serde(default)]
    pub source_range: Option<SourceRangeSpec>,
    /// Needed values without a strict block (compiler's list; not consumed).
    pub missing: Vec<Value>,
    pub provenance: Vec<Value>,
}

/// The plant quantity a channel family observes, as the composing driver
/// maps it onto solver coordinates.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Quantity {
    /// Static pressure at the PZR roof tap (PT1/2/3 at +18.5 m, the top
    /// fluid boundary): the stratified cell's roof pressure, Pa.
    PzrRoofPressure,
    /// An SG's collapsed level `V_l / area`, m (declared S3 limit, decision
    /// S3-D1.20).
    SgCollapsedLevel { sg: String, area_m2: f64 },
    /// S5 (C08, S4-D10 (a)): an SG's apparent level `(V_l + V_sub) / area`,
    /// m, the two-phase level including the steam under the surface; the
    /// joined packet must compose the apparent-level allocation.
    SgApparentLevel { sg: String, area_m2: f64 },
    /// A loop's signed mass flow at its cold-return face, observed as a
    /// fraction of the loop's installed nominal forward flow. The family's
    /// span is in fractions (`spanFractionOfNominal`); its quantization and
    /// sign band are the block's kg/s, converted once the nominal is
    /// resolved. The compiler leaves `nominal_kg_s` null: the composing
    /// driver resolves it at the packet's prepared hot reference.
    LoopFlow {
        loop_id: String,
        face: usize,
        face_id: String,
        nominal_kg_s: Option<f64>,
        quantum_kg_s: f64,
        indeterminate_band_kg_s: f64,
    },
    /// The PZR electronic differential level: `p(LT.LOW) − p(LT.HIGH)` from
    /// the stratified column at the taps, converted with the fixed
    /// saturated-water calibration at `calibration_pressure_pa` over the tap
    /// span (indicated metres above the LT datum). The lag is applied to the
    /// indication, equivalent to lagging the DP, since the conversion is
    /// affine with constant coefficients.
    /// Both interfaces must lie inside `interface_span_pa`; S3 refuses an
    /// interface overrange (its device semantics are not built).
    PzrLevel {
        calibration_pressure_pa: f64,
        interface_span_pa: [f64; 2],
    },
    /// The protective acquired local-current proxy in S3-D7's ratio form,
    /// `(E_c / E_c,ref) (E_tot,ref / Fref)`: `weights` per source region
    /// (the converter's coated span), the reference at the packet's
    /// prepared hot reference.
    CurrentProxy {
        weights: Vec<f64>,
        fref_events_per_s: f64,
    },
    /// An RCP's shaft speed as a fraction of the drive's reference speed
    /// (owner R12-D2): rotor `rotor` in the network's rotor order (the
    /// hydraulic sections with a pump, in packet order), `rotor_id` its
    /// section. Linear in the rotor's angular-momentum coordinate.
    PumpSpeed { rotor: usize, rotor_id: String },
    /// Plan r4 X4.2 (for PHYS): a CVCS branch's signed effective total-stream
    /// flow at its COLD.A boundary (`LD01.INV.CHARGE.FT`,
    /// `LD01.INV.LETDOWN.FT`), kg/s: the flow the CVCS owner delivers at its
    /// stem and COLD.A's pressure; the packet must compose the CVCS.
    CvcsFlow { branch: crate::joined::cvcs::Branch },
    /// `LD01.CORE.BANK.POS` (plan r4 tag map, ld01-bank-channels): the mean
    /// stem travel over every cluster as a fraction of the normal stroke
    /// `normal_travel_m` (the rods packet's), 0 seated. Linear in the
    /// clusters' travel coordinates.
    BankPosition { normal_travel_m: f64 },
    /// `LD01.TG.STOP.POS` (ld01-steam-valve-position-channels): the STOP's
    /// stroke in percent, 100 until the latched TRIP, then the linear travel
    /// to 0 over `stop_travel_s` (the secondary's steam-admission law). A
    /// function of time and the latched TRIP, read from the live secondary.
    StopValvePosition { stop_travel_s: f64 },
    /// `LD01.SG.<sg>.PT` (ld01-sg-normal-pressure-channel): the SG's total
    /// secondary pressure, Pa, the owner's algebraic pressure `SG.<sg>.p_s`.
    /// Linear.
    SgPressure { sg: String },
    /// `LD01.SG.<sg>.FT.STEAM` and `LD01.FW.<sg>.FT` (ld01-sg-flow-channels):
    /// the SG owner's continuous channel lag of the pickup steam or the
    /// branch feed flow (`FW.<sg>.FT.STEAM.lag`, `FW.<sg>.FW.FT.lag`;
    /// control-and-faults.md, continuous realization) over the one-SG
    /// nominal feed flow `nominal_kg_s` (the packet's feed train `m0`). The
    /// owner's coordinate is the channel's selected 0.25 s response, so the
    /// family adds no second lag (`lag_s` 0). Linear; the packet must compose
    /// the compact feed train.
    SgFlowLag {
        sg: String,
        flow: SgFlow,
        nominal_kg_s: f64,
    },
    /// `LD01.CORE.DP<n>` (ld01-vessel-dp-channels): `p_lower − p_upper` at
    /// the span's interfaces, Pa, the mean over `taps` (the core's parallel
    /// sector channels). Each interface reads the network's own local
    /// static pressure of its cell, `p + rho_mix g (z_ref − z)`, with
    /// `rho_mix` the cell's total mass over its fixed volume (the network's
    /// mixture density on its EOS row). Linear; a moving cell is refused by
    /// the compiler.
    VesselDp { taps: Vec<DpTap> },
}

/// Which SG owner lag an [`Quantity::SgFlowLag`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SgFlow {
    /// `FT.STEAM.lag`: the pickup steam.
    Steam,
    /// `FW.FT.lag`: the branch feed flow.
    Feed,
}

/// One differential device's pair of interfaces.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DpTap {
    pub lower: DpInterface,
    pub upper: DpInterface,
}

/// A pressure interface: the network region (index and id) whose local
/// static pressure it reads, at `elevation_m`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DpInterface {
    pub region: usize,
    pub region_id: String,
    pub elevation_m: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelSpec {
    pub id: String,
    /// Instrumentation supply group (I1, I2, I3).
    pub supply: String,
}

/// A three-channel family of one quantity, with its protective consumer's
/// freshness and recovery limits.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Family {
    pub id: String,
    pub quantity: Quantity,
    pub channels: Vec<ChannelSpec>,
    pub channel: AnalogConfig,
    pub maximum_age_s: f64,
    pub recovery_s: f64,
}

/// The SOURCE-pulse path's selections (reference-nuclear-observation-window,
/// ld01-source-range-pulse): `Rref` the regional model's collected-event
/// intensity at the original reference field, so the detected rate is
/// `Rref · proxy`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRangeSpec {
    pub id: String,
    pub supply: String,
    pub rref_events_per_s: f64,
    pub dark_per_s: f64,
    pub deadtime_s: f64,
    pub window_s: f64,
    pub alpha: f64,
    pub theta: f64,
    pub minimum_excess_count: f64,
    pub background_per_s: [f64; 2],
    pub maximum_occupancy: f64,
    pub sample_s: f64,
    pub transport_s: f64,
    pub maximum_age_s: f64,
    pub seed: u64,
}

/// The source of a discrete state report.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportSource {
    /// The ACT.B turbine controls' retained trip memory (`LD01.TG` TRIP).
    TurbineRetainedTrip,
    /// `LD01.CORE.BANK.INSERTED` (ld01-bank-channels): the series contact
    /// chain, closed only when every cluster is seated (the rods owner's
    /// modes, read live after each restart).
    BankInserted,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportSpec {
    pub id: String,
    pub source: ReportSource,
    pub supply: String,
    pub sample_s: f64,
    pub transport_s: f64,
    pub maximum_age_s: f64,
    pub recovery_s: f64,
    /// Where the timing comes from (blocks and the page sentence naming
    /// them), carried into receipts.
    pub basis: String,
}

/// A function's decision rule.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Rule {
    /// The family's two-of-three vote continuously satisfied for the
    /// qualification duration.
    Voted {
        family: String,
        side: Side,
        qualification_s: f64,
    },
    /// Fewer than two usable channels of the family continuously for the
    /// qualification duration.
    Unavailable {
        family: String,
        qualification_s: f64,
    },
    /// A usable delivered report that the state holds; no duration is
    /// selected for this cause, so the first such decision accepts it.
    Report { report: String },
    /// A one-channel family's own threshold continuously met for the
    /// duration while an arming family's vote is satisfied (loop low flow:
    /// FT at or below 0.70 nominal while the protective source proxy
    /// conclusively exceeds 0.20).
    Armed {
        family: String,
        side: Side,
        qualification_s: f64,
        arming_family: String,
        arming: Side,
    },
    /// The one-channel family unusable for the duration while armed.
    ArmedUnavailable {
        family: String,
        qualification_s: f64,
        arming_family: String,
        arming: Side,
    },
}

/// Selected effects of an accepted cause (requests; S3 records the CMT,
/// PRHR and heater-isolation requests, with no physics behind them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Effects {
    pub reactor_trip: bool,
    pub cmt_injection: bool,
    pub heater_isolation: bool,
    /// `LD01.PROT.PRHR.REQUEST` from this cause: only the AP1000 signal set
    /// (`ld01-prhr-actuation`, owner R12-A1), never from the reactor trip
    /// itself.
    pub prhr: bool,
}

/// A cause's reset evidence: all three usable channels inside the band for
/// the duration (S3 cases request no reset; carried for the function
/// record). A report's cause resets on its cleared report instead (`null`).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reset {
    pub band: [f64; 2],
    pub duration_s: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FunctionSpec {
    pub id: String,
    pub rule: Rule,
    pub effects: Effects,
    pub reset: Option<Reset>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldingSpec {
    pub interface: String,
    pub supply: String,
    pub manual_interrupt: String,
    /// The three division processors' supply groups, I1–I3.
    pub divisions: [String; 3],
    /// Their permissive contacts, in division order.
    pub contacts: [String; 3],
}

/// The turbine controls' trip on the reactor trip (owner R12-A2): the
/// `LD01.TRIP.HOLD` loss requests the existing turbine trip (`LD01.TG`
/// TRIP) `delay_s` later, a whole number of I&C frames, unless the turbine
/// is already tripped. AP1000: "Turbine trip occurs 5 seconds following a
/// reactor trip condition being reached" (DCD Rev. 19 Tier 2 §15.0.14).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurbineTripOnReactorTrip {
    /// The named turbine-trip cause, recorded with the request.
    pub cause: String,
    pub delay_s: f64,
    pub basis: String,
}

/// A recorded vote: `rule` must be `voted`; `basis` names its blocks.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonitorSpec {
    pub id: String,
    pub rule: Rule,
    pub basis: String,
}

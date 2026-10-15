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
    pub holding: HoldingSpec,
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
    /// The protective acquired local-current proxy in S3-D7's ratio form,
    /// `(E_c / E_c,ref) (E_tot,ref / Fref)`: `weights` per source region
    /// (the converter's coated span), the reference at the packet's
    /// prepared hot reference.
    CurrentProxy {
        weights: Vec<f64>,
        fref_events_per_s: f64,
    },
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

/// The source of a discrete state report.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportSource {
    /// The ACT.B turbine controls' retained trip memory (`LD01.TG` TRIP).
    TurbineRetainedTrip,
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

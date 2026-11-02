//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#actual-finite-geometry-and-force-placement
//! Typed subset of the compiled owner packet consumed by the network.
//!
//! The TypeScript input compilers own every value; this boundary only
//! validates shapes. Unknown sibling packet fields belong to other consumers.
use crate::{
    hydraulics::Section,
    local_flow::{MomentumSupport, PressureSegment},
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Packet {
    pub mechanics: Mechanics,
    pub thermal: Thermal,
    pub water_boron_amount_kg_eq: Vec<f64>,
    pub external_ports: ExternalPorts,
    pub pzr: Pzr,
    pub hydraulics: Hydraulics,
    pub preparation: Preparation,
    /// The controlled-spray path's owner section (`pzrSpray`), present only
    /// in a packet that composes the path (`reference-design-operating-spray-path.ts`).
    #[serde(rename = "pzrSpray", default)]
    pub pzr_spray: Option<crate::control::spray_valve::Section>,
    /// R4-NCHEAD: the SG secondary section's fold, read for the SG primary
    /// cells' profiled heads; required with `thermal.sg_segments`.
    #[serde(default)]
    pub secondary: Option<Secondary>,
}
#[derive(Debug, Deserialize)]
pub struct Secondary {
    pub exposure: Exposure,
}
#[derive(Debug, Deserialize)]
pub struct Exposure {
    pub fold: Fold,
}
/// The folded SG tube path (`ld01-sg-exposure`; the same four values the
/// SG owner's contact map reads).
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Fold {
    #[serde(rename = "developedLength_m")]
    pub developed_length_m: f64,
    pub inlet_m: f64,
    pub crest_m: f64,
    pub outlet_m: f64,
}
#[derive(Debug, Deserialize)]
pub struct Preparation {
    #[serde(rename = "operatingPoint")]
    pub operating_point: OperatingPoint,
}
/// Declared prepared-state selections compiled from their wiki owners.
#[derive(Debug, Deserialize)]
pub struct OperatingPoint {
    #[serde(rename = "pzrRoofPressure_Pa")]
    pub pzr_roof_pressure_pa: f64,
    #[serde(rename = "pzrRoofElevation_m")]
    pub pzr_roof_elevation_m: f64,
    /// Indicated level above the PZR bottom datum `pzr_bottom_elevation_m`.
    #[serde(rename = "pzrLevel_m")]
    pub pzr_level_m: f64,
    #[serde(rename = "pzrBottomElevation_m")]
    pub pzr_bottom_elevation_m: f64,
    /// The only selected request is the nominal speed of `hydraulics.pump`.
    #[serde(rename = "rcpSpeedRequest")]
    pub rcp_speed_request: String,
}
#[derive(Debug, Deserialize)]
pub struct Mechanics {
    pub regions: Vec<Region>,
    pub faces: Vec<FacePacket>,
    pub force_projection: Vec<FaceProjection>,
    pub section_force_projection: Vec<SectionProjection>,
}
#[derive(Debug, Deserialize)]
pub struct Region {
    pub id: String,
    pub volume_m3: f64,
    pub elevation_m: f64,
}
#[derive(Debug, Deserialize)]
pub struct FacePacket {
    pub id: String,
    pub from: usize,
    pub to: usize,
    pub flow_area_m2: f64,
    pub supports: Vec<MomentumSupport>,
    pub pressure_segments: Vec<PressureSegment>,
}
#[derive(Debug, Deserialize)]
pub struct FaceProjection {
    pub face: usize,
    pub region: usize,
    pub coefficient_per_m2: f64,
    pub normal: [f64; 2],
}
#[derive(Debug, Deserialize)]
pub struct SectionProjection {
    pub face: usize,
    pub section: usize,
    pub coefficient: f64,
}
#[derive(Debug, Deserialize)]
pub struct Thermal {
    pub water: Vec<WaterOwner>,
    /// The SG tube segments; the network reads only their primary cells.
    #[serde(default)]
    pub sg_segments: Vec<SgSegment>,
}
#[derive(Debug, Deserialize)]
pub struct SgSegment {
    pub primary: usize,
}
#[derive(Debug, Deserialize)]
pub struct WaterOwner {
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub mass_kg: f64,
    pub energy_j: f64,
}
#[derive(Debug, Deserialize)]
pub struct ExternalPorts {
    pub surge_stock: SurgeStock,
    /// The spray line's initial stock and its path indices, present
    /// together with `pzrSpray`.
    #[serde(default)]
    pub spray_stock: Option<SprayStock>,
    #[serde(default)]
    pub spray_path: Option<SprayPath>,
}
/// The spray line's declared initial state: pressure and temperature (the
/// network prepares mass and energy by its property forward) and the
/// absorber mass fraction.
#[derive(Debug, Deserialize)]
pub struct SprayStock {
    pub id: String,
    pub volume_m3: f64,
    pub elevation_m: f64,
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
    #[serde(rename = "absorberMassFraction")]
    pub absorber_mass_fraction: f64,
    pub basis: String,
}
/// Where the composed spray path sits in the packet.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SprayPath {
    pub region: usize,
    pub valve_face: usize,
    pub port_face: usize,
    pub valve_section: usize,
    pub distributor_section: usize,
}
#[derive(Debug, Deserialize)]
pub struct SurgeStock {
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
    pub mass_kg: f64,
    #[serde(rename = "internalEnergy_J")]
    pub internal_energy_j: f64,
    #[serde(rename = "absorberTracer_kgEq")]
    pub absorber_tracer_kg_eq: f64,
}
/// The one stratified PZR cell (decision 0014): the cell owner's typed,
/// validated `pzr.cell` section, read once for the network and the cell.
#[derive(Debug, Deserialize)]
pub struct Pzr {
    pub cell: PzrCell,
}
pub use super::stratified::{Parameters as PzrCell, Port as PzrPort};
#[derive(Debug, Deserialize)]
pub struct Hydraulics {
    pub pump: Pump,
    pub sections: Vec<SectionEntry>,
}
#[derive(Debug, Deserialize)]
pub struct Pump {
    #[serde(rename = "rotorInertia_kg_m2")]
    pub rotor_inertia_kg_m2: f64,
    #[serde(rename = "drag_Nm_per_rad_s")]
    pub drag_nm_per_rad_s: f64,
    #[serde(rename = "referenceOmega_rad_s")]
    pub reference_omega_rad_s: f64,
    #[serde(rename = "nominalFluidPower_W")]
    pub nominal_fluid_power_w: f64,
    #[serde(rename = "driveTrackingTime_s")]
    pub drive_tracking_time_s: f64,
    #[serde(rename = "driveTorqueCapFactor")]
    pub drive_torque_cap_factor: f64,
    #[serde(rename = "driveEfficiency")]
    pub drive_efficiency: f64,
}
#[derive(Debug, Deserialize)]
pub struct SectionEntry {
    pub region: usize,
    pub parameters: Section,
}

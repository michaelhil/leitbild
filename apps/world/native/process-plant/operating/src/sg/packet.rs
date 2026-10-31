//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-generation/thermodynamics.md#s2-secondary-block
//! Typed `secondary` section of the joined packet, and the separate probe
//! section of zero-time receipts. The TypeScript strict compiler
//! (`reference-design-operating-sg.ts`) owns every value; this boundary
//! validates shapes and refuses unknown fields. Values derived from a
//! selection and a law (the relief's effective area, the feed enthalpy) are
//! derived natively with the runtime law, once.
use serde::Deserialize;
use serde_json::Value;

/// The joined packet's `secondary` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub scope: String,
    /// In the joined packet's `thermal.secondaries` order.
    #[serde(rename = "steamGenerators")]
    pub steam_generators: Vec<SteamGenerator>,
    pub relief: Relief,
    pub feed: Feed,
    #[serde(rename = "steamAdmission")]
    pub steam_admission: SteamAdmission,
    /// The steam bypass's no-load pressure mode after the turbine trip
    /// (`ld01-bypass-no-load`, owner R12-B1), the G1 stand-in.
    pub bypass: Bypass,
    /// The SG contact law's exchange area and wall constants
    /// (`ld01-sg-contact`), read once for the joined solids' films.
    pub contact: Contact,
    /// The two-zone contact coordinate (`ld01-sg-exposure`, S3-D26) of the
    /// tube wetting, for the joined solids' secondary contact.
    pub exposure: Exposure,
    /// S5 (C08, S4-D12): the compact apparent-level allocation, composed
    /// into the packet by `reference-design-operating-apparent-level.ts`
    /// from the `reference-design-operating-sg-level.ts` section. Absent in
    /// the S1-S3 packets, whose owner then has no distribution coordinates
    /// (their runs stay bitwise).
    #[serde(rename = "apparentLevel", default)]
    pub apparent_level: Option<ApparentLevel>,
    /// Plan r4 X4.1: the compact feed train (`ld01-feed-compact`), composed
    /// by `reference-design-operating-feed-compact.ts`. Present only with
    /// the apparent level; it replaces F3 (a)'s inventory-holding feed.
    #[serde(rename = "feedTrain", default)]
    pub feed_train: Option<FeedTrain>,
    /// Consumed pages and source hashes; not read by the block.
    pub provenance: Value,
}

/// The C08 section (`ld01-sg-distribution`, `reference-balance`,
/// `ld01-sg-level-channels`): one vapor-distribution state per SG.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApparentLevel {
    pub scope: String,
    pub distribution: Distribution,
    pub indication: Indication,
    /// Consumed pages and source hashes; not read by the block.
    pub provenance: Value,
}

/// The vapor-distribution law's selected values: the nominal reference the
/// residence time is derived from once on the runtime law, the equilibrium
/// bound, the distribution time and the prepared distribution.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Distribution {
    #[serde(rename = "nominalSubmergedVolume_m3")]
    pub nominal_submerged_volume_m3: f64,
    #[serde(rename = "nominalPressure_Pa")]
    pub nominal_pressure_pa: f64,
    #[serde(rename = "nominalSteamFlow_kg_s")]
    pub nominal_steam_flow_kg_s: f64,
    #[serde(rename = "maximumSubmergedVolume_m3")]
    pub maximum_submerged_volume_m3: f64,
    #[serde(rename = "distributionTime_s")]
    pub distribution_time_s: f64,
    #[serde(rename = "preparedDistribution")]
    pub prepared_distribution: f64,
}

/// The NR channels' indicated-level area and response (read by the IC
/// acquisition and the feed controller, not by the owner's rows).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Indication {
    #[serde(rename = "indicatedLevelArea_m2")]
    pub indicated_level_area_m2: f64,
    #[serde(rename = "nrSpan_m")]
    pub nr_span_m: [f64; 2],
    #[serde(rename = "nrLag_s")]
    pub nr_lag_s: f64,
}

/// The compact feed train (plan r4 X4.1; `ld01-feed-compact` with
/// `reference-service-pump`, `ld01-feed-train` and `reference-cycle`):
/// FW.P1/P2 in parallel on the forward characteristic at rated speed, the
/// header-entry loss, and per SG one branch (fixed/ISO path in series with
/// the FCV on the healthy liquid law), every pressure allocation at the
/// nominal per-SG flow `m0`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FeedTrain {
    /// `m0`: one pump's and one branch's nominal flow, kg/s.
    #[serde(rename = "nominalFlow_kg_s")]
    pub nominal_flow_kg_s: f64,
    #[serde(rename = "suctionPressure_Pa")]
    pub suction_pressure_pa: f64,
    #[serde(rename = "dischargePressure_Pa")]
    pub discharge_pressure_pa: f64,
    /// Zero-flow head over nominal head, `dp = dp0 (r n² − (r − 1) q²)`.
    #[serde(rename = "shutoffHeadRatio")]
    pub shutoff_head_ratio: f64,
    /// Header pressure at both pumps' nominal flow (`2 m0`).
    #[serde(rename = "headerPressure_Pa")]
    pub header_pressure_pa: f64,
    /// Outlet of the fully open fixed/ISO path at `m0`, the FCV inlet.
    #[serde(rename = "isoOutletPressure_Pa")]
    pub iso_outlet_pressure_pa: f64,
    /// The SG pressure at which the FCV is sized (`m0` at the reference
    /// opening).
    #[serde(rename = "receiverPressure_Pa")]
    pub receiver_pressure_pa: f64,
    #[serde(rename = "fcvReferenceOpening")]
    pub fcv_reference_opening: f64,
    #[serde(rename = "fcvStrokePerSecond")]
    pub fcv_stroke_per_second: f64,
    /// The continuous stem's time constant toward the demand
    /// (`ld01-feed-compact`), within the stroke rate.
    #[serde(rename = "stemTimeConstant_s")]
    pub stem_time_constant_s: f64,
    /// The startup-feed stand-in (`ld01-startup-feed`, judgement).
    pub startup: StartupFeed,
    /// The control coordinates' operator-grade absolute tolerances
    /// (`ld01-feed-compact`, a quarter of the matching channel's
    /// uncertainty under `ld01-operator-budgets` r2).
    #[serde(rename = "operatorTolerances")]
    pub operator_tolerances: OperatorTolerances,
    /// The three-element cascade (`ld01-feed-cascade`), read by the feed
    /// controller (`control::feed`), not by the owner's rows.
    pub cascade: crate::control::feed::Cascade,
}

/// The two-zone contact coordinate of `ld01-sg-exposure` (S3-D26), as the
/// compiler derives it for the selected free volume: the bundle zone holds
/// `bundleZoneVolume_m3` from the fold's start to its crest, uniformly;
/// above the crest the free area is `upperZoneArea_m2`. The compiler checks
/// that the exposure block's zone bounds are the fold's start and crest.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Exposure {
    pub fold: Fold,
    #[serde(rename = "bundleZoneVolume_m3")]
    pub bundle_zone_volume_m3: f64,
    #[serde(rename = "upperZoneArea_m2")]
    pub upper_zone_area_m2: f64,
}
/// The folded tube path: `reference-primary-mechanics` developed length and
/// the `reference-hydraulics` inlet port, crest and outlet port elevations.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Fold {
    #[serde(rename = "developedLength_m")]
    pub developed_length_m: f64,
    pub inlet_m: f64,
    pub crest_m: f64,
    pub outlet_m: f64,
}
impl Exposure {
    /// The kernel's contact map over the packet's fold.
    pub fn contact_map(&self) -> Result<crate::thermal::ContactMap, &'static str> {
        let f = self.fold;
        crate::thermal::ContactMap::new(
            crate::thermal::FoldPath::new(f.developed_length_m, f.inlet_m, f.crest_m, f.outlet_m)?,
            self.bundle_zone_volume_m3,
            self.upper_zone_area_m2,
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteamGenerator {
    pub id: String,
    /// Total free secondary volume, m³.
    #[serde(rename = "volume_m3")]
    pub volume_m3: f64,
    /// Constant S2 steam demand through the pickup gas (F2 (a)), kg/s.
    #[serde(rename = "steamDemand_kg_s")]
    pub steam_demand_kg_s: f64,
    /// Liquid volume at which the fold crown first uncovers, m³.
    #[serde(rename = "crownLiquidVolume_m3")]
    pub crown_liquid_volume_m3: f64,
    /// Liquid volume at which the upper pickup first covers, m³.
    #[serde(rename = "pickupLiquidVolume_m3")]
    pub pickup_liquid_volume_m3: f64,
    pub reliefs: Vec<Valve>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Valve {
    pub id: String,
}

/// The SG spring valves (`ld01-sg-relief`, owner R12-B2): per valve
/// position, in each SG's valve order, its role and absolute settings; the
/// lag, seat, receiver, branch rule and rating are common.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relief {
    pub valves: Vec<ValveSetting>,
    /// The declared SG (steam-side) design pressure, Pa.
    #[serde(rename = "designPressure_Pa")]
    pub design_pressure_pa: f64,
    #[serde(rename = "liftLag_s")]
    pub lift_lag_s: f64,
    /// A closing disc seats when its lift falls to `exp(-n)` of full lift,
    /// `n` of the lag's own time constants (lead decision).
    #[serde(rename = "seatLagTimeConstants")]
    pub seat_lag_time_constants: f64,
    #[serde(rename = "backPressure_Pa")]
    pub back_pressure_pa: f64,
    /// F4 (a) with H5: the memory switches when the inlet reaches full lift.
    #[serde(rename = "descendingSwitch")]
    pub descending_switch: DescendingSwitch,
    pub rating: Rating,
}

/// One valve position's settings.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ValveSetting {
    pub role: ValveRole,
    #[serde(rename = "crackPressure_Pa")]
    pub crack_pressure_pa: f64,
    #[serde(rename = "fullLiftPressure_Pa")]
    pub full_lift_pressure_pa: f64,
    #[serde(rename = "reseatPressure_Pa")]
    pub reseat_pressure_pa: f64,
}
/// AP1000's two functions: the relief (PORV) between no-load pressure and
/// the safety valves, and the safety valves (DCD Table 10.3.2-1/-2).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum ValveRole {
    #[serde(rename = "relief")]
    Relief,
    #[serde(rename = "safety")]
    Safety,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum DescendingSwitch {
    #[serde(rename = "inletAtFullLift")]
    InletAtFullLift,
}

/// The sizing point that fixes each valve's effective discharge area.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rating {
    #[serde(rename = "massFlow_kg_s")]
    pub mass_flow_kg_s: f64,
    #[serde(rename = "inletPressure_Pa")]
    pub inlet_pressure_pa: f64,
    pub fluid: RatingFluid,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum RatingFluid {
    #[serde(rename = "saturatedVapor")]
    SaturatedVapor,
}

/// F3 (a): feed equals steam plus relief outflow, at the recorded state.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Feed {
    pub rule: FeedRule,
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum FeedRule {
    #[serde(rename = "inventoryHolding")]
    InventoryHolding,
}

/// The turbine admission the demand follows after the manual turbine TRIP:
/// the STOP's linear travel to closed.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteamAdmission {
    #[serde(rename = "stopTravel_s")]
    pub stop_travel_s: f64,
}

/// The bypass stand-in after the turbine trip (owner R12-B1): each SG
/// passes `fraction × its nominal demand × u` to the condenser at `h_g(p)`,
/// `u` rising linearly from 0 at the no-load pressure to 1 one band width
/// above it. The no-load pressure is IF97's saturation pressure at the
/// designed no-load average temperature (compiled with its derivation; the
/// block checks it natively against the runtime saturation, once).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bypass {
    pub mode: BypassMode,
    #[serde(rename = "noLoadAverageTemperature_K")]
    pub no_load_average_temperature_k: f64,
    #[serde(rename = "noLoadPressure_Pa")]
    pub no_load_pressure_pa: f64,
    #[serde(rename = "bandWidth_Pa")]
    pub band_width_pa: f64,
    #[serde(rename = "fractionOfNominalSteam")]
    pub fraction_of_nominal_steam: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum BypassMode {
    /// The no-load pressure mode from the turbine trip on; closed before it
    /// (the at-power band does not open at the full-power header).
    #[serde(rename = "noLoadPressureAfterTurbineTrip")]
    NoLoadPressureAfterTurbineTrip,
}

/// The SG contact law (`ld01-sg-contact`): the equivalent tube bundle, its
/// fouling and the tube steel. `exchangeArea_m2` is the compiler's derived
/// outer (secondary) area `N pi OD L` over the fold's developed length; the
/// primary face is `ID/OD` of it (X4.5 R2.1-R2.9).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contact {
    #[serde(rename = "tubeCount")]
    pub tube_count: f64,
    #[serde(rename = "tubeOutsideDiameter_m")]
    pub tube_outside_diameter_m: f64,
    #[serde(rename = "tubeInsideDiameter_m")]
    pub tube_inside_diameter_m: f64,
    #[serde(rename = "foulingResistance_m2K_W")]
    pub fouling_resistance_m2k_w: f64,
    #[serde(rename = "exchangeArea_m2")]
    pub exchange_area_m2: f64,
    pub emissivity: f64,
    #[serde(rename = "steelConductivity_W_mK")]
    pub steel_conductivity_w_mk: f64,
    #[serde(rename = "steelDensity_kg_m3")]
    pub steel_density_kg_m3: f64,
    #[serde(rename = "steelCp_J_kgK")]
    pub steel_cp_j_kgk: f64,
}

impl Contact {
    /// The bundle's checks: whole tubes, `0 < ID < OD`, nonnegative fouling,
    /// and the derived outer area equal to `N pi OD L` over `developed_m`.
    pub fn check(&self, developed_m: f64) -> Result<(), String> {
        let (n, od, id) = (
            self.tube_count,
            self.tube_outside_diameter_m,
            self.tube_inside_diameter_m,
        );
        if !(n.is_finite() && n >= 1. && n.fract() == 0.)
            || !(id.is_finite() && od.is_finite() && 0. < id && id < od)
            || !(self.fouling_resistance_m2k_w.is_finite() && self.fouling_resistance_m2k_w >= 0.)
            || !(developed_m.is_finite() && developed_m > 0.)
        {
            return Err("SG tube bundle: whole tubes, 0 < ID < OD, nonnegative fouling".into());
        }
        let area = n * std::f64::consts::PI * od * developed_m;
        if (area - self.exchange_area_m2).abs() > 1e-12 * area {
            return Err(format!(
                "SG exchange area {} m2 is not N pi OD L = {area} m2",
                self.exchange_area_m2
            ));
        }
        Ok(())
    }
    /// Primary (inner) over secondary (outer) area, `ID/OD`.
    pub fn inner_fraction(&self) -> f64 {
        self.tube_inside_diameter_m / self.tube_outside_diameter_m
    }
    /// Wall conduction plus fouling per primary (inner) area, m2 K/W: the
    /// outer-referenced `(OD/2) ln(OD/ID)/k + R_f` times `ID/OD`, with `k` the
    /// block's steel conductivity (X4.5 R2.7, R2.8).
    pub fn primary_series_m2k_w(&self) -> f64 {
        let (od, id) = (self.tube_outside_diameter_m, self.tube_inside_diameter_m);
        let wall = 0.5 * od * (od / id).ln() / self.steel_conductivity_w_mk;
        (wall + self.fouling_resistance_m2k_w) * id / od
    }
}

/// Inputs of zero-time receipts and isolated probes only, never of the
/// joined operator: the selected hot preparation, the held SG primary cell
/// and the tube heat path's geometry and constants. The joined operator takes
/// the preparation from its thermal section and owns the metal and films.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub preparation: Preparation,
    pub primary: Primary,
    pub tube: Tube,
    pub segments: Vec<Segment>,
    pub provenance: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    #[serde(rename = "secondaryPressure_Pa")]
    pub secondary_pressure_pa: f64,
    #[serde(rename = "liquidVolume_m3")]
    pub liquid_volume_m3: f64,
    /// Metal starts at the midpoint of this temperature and the prepared
    /// secondary saturation temperature.
    #[serde(rename = "metalColdTemperature_K")]
    pub metal_cold_temperature_k: f64,
}

/// The prepared SG primary cell held as a probe boundary.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Primary {
    #[serde(rename = "pressure_Pa")]
    pub pressure_pa: f64,
    #[serde(rename = "temperature_K")]
    pub temperature_k: f64,
    #[serde(rename = "flowArea_m2")]
    pub flow_area_m2: f64,
    /// Per SG, in the section's order.
    #[serde(rename = "massFlow_kg_s")]
    pub mass_flow_kg_s: Vec<f64>,
}

/// The tube path's effective thermal diameter (`reference-operating-thermal`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tube {
    #[serde(rename = "thermalDiameter_m")]
    pub thermal_diameter_m: f64,
}

/// One developed-length metal segment, the same for every SG.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    #[serde(rename = "developedStart_m")]
    pub developed_start_m: f64,
    #[serde(rename = "developedEnd_m")]
    pub developed_end_m: f64,
    #[serde(rename = "exchangeArea_m2")]
    pub exchange_area_m2: f64,
    #[serde(rename = "capacity_J_K")]
    pub capacity_j_k: f64,
}

/// Absolute tolerances of the feed control's channel lags, physical units:
/// the NR1 lag (m) and the flow-channel lags (kg/s).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OperatorTolerances {
    #[serde(rename = "nrLevel_m")]
    pub nr_level_m: f64,
    #[serde(rename = "flow_kg_s")]
    pub flow_kg_s: f64,
}

/// The startup-feed stand-in (`ld01-startup-feed`, judgement): one branch
/// per SG from the tank on the onsite-power stand-in, its capacity the
/// decay heat shared by the SGs over the rise from the tank to saturated
/// vapour at the no-load pressure (derived once on the runtime law).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StartupFeed {
    #[serde(rename = "decayHeat_W")]
    pub decay_heat_w: f64,
    #[serde(rename = "sourceTemperature_K")]
    pub source_temperature_k: f64,
    /// NR fraction below which a stopped stand-in starts.
    #[serde(rename = "startLevelFraction")]
    pub start_level_fraction: f64,
    /// NR fraction above which a running stand-in isolates.
    #[serde(rename = "isolationLevelFraction")]
    pub isolation_level_fraction: f64,
}

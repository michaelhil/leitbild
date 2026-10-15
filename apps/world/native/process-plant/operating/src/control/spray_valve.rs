//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray valve of the PZR spray path: its stem trajectory
//! toward the issued fraction and its restriction law, from the compiled
//! `pzrSpray` section (`reference-design-operating-pzr-spray.ts`, strict
//! blocks only).
//!
//! **Stem.** The selected actuator moves the stem fraction `x` toward the
//! issued fraction at the block's rate and stops there; a new fraction
//! reverses from the current position. Between issues `x(t)` is a known
//! piecewise-linear function of time, so the stem is a held input with no
//! state: `x(t) = x0 + s·rate·(t − t0)` up to its arrival, then the target.
//! Its discrete instants are classed by lead decision S3-D4:
//! - a new fraction while the stem is open or moving changes only the
//!   slope (`x` is continuous, the residual does not move): class S;
//! - arrival at an open target is a known-time slope change: class S at
//!   an exact stop;
//! - leaving 0 (opening a closed valve) and arriving at 0 (closing) change
//!   the valve path between its restriction law and the closed path's lock
//!   (`Π = 0`, the DAE identity): class R.
//!
//! **Restriction.** `CdA = x·CdA_full` (linear in the stem). The network
//! composes it as the quasi-steady capacity relation of its valve path
//! (lead decision S3-D25, `network::spray`); [`Valve::form_loss`] states
//! the same law as a form loss on the line area, `K_v(x) = (A/(x·CdA_full))²`,
//! for an open stem only. A closed valve's path is locked, never an
//! infinite or clipped coefficient.
use crate::network::Failure;
use serde::Deserialize;

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("PZR spray valve: {}", reason.into()))
}

/// The compiled line geometry.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Line {
    #[serde(rename = "length_m")]
    pub length_m: f64,
    #[serde(rename = "insideDiameter_m")]
    pub inside_diameter_m: f64,
    #[serde(rename = "area_m2")]
    pub area_m2: f64,
    #[serde(rename = "volume_m3")]
    pub volume_m3: f64,
    #[serde(rename = "inletElevation_m")]
    pub inlet_elevation_m: f64,
    #[serde(rename = "outletElevation_m")]
    pub outlet_elevation_m: f64,
    #[serde(rename = "centroidElevation_m")]
    pub centroid_elevation_m: f64,
    #[serde(rename = "wallThickness_m")]
    pub wall_thickness_m: f64,
    #[serde(rename = "roughness_m")]
    pub roughness_m: f64,
    pub wall: String,
}

/// One half-line phase path.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Half {
    pub face: String,
    pub from: String,
    pub to: String,
    pub length_m: f64,
    #[serde(rename = "inverseAreaLength_per_m")]
    pub inverse_area_length_per_m: f64,
    pub volume_m3: f64,
    #[serde(rename = "elevationChange_m")]
    pub elevation_change_m: f64,
    #[serde(rename = "formLoss")]
    pub form_loss: f64,
    pub restriction: String,
}

/// The valve's sizing point (for receipts).
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sizing {
    pub flow_kg_s: f64,
    #[serde(rename = "differential_Pa")]
    pub differential_pa: f64,
    pub density_kg_m3: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValveBlock {
    pub face: String,
    #[serde(rename = "fullEffectiveArea_m2")]
    pub full_effective_area_m2: f64,
    #[serde(rename = "fullOpenFormLoss")]
    pub full_open_form_loss: f64,
    #[serde(rename = "strokesPerSecond")]
    pub strokes_per_second: f64,
    #[serde(rename = "inletCheck")]
    pub inlet_check: String,
    pub sizing: Sizing,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Distributor {
    pub face: String,
    #[serde(rename = "aggregateEffectiveArea_m2")]
    pub aggregate_effective_area_m2: f64,
    pub elevation_m: f64,
    #[serde(rename = "formLoss")]
    pub form_loss: f64,
}

/// The compiled `pzrSpray` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub source: String,
    pub line: Line,
    pub halves: Vec<Half>,
    pub valve: ValveBlock,
    pub distributor: Distributor,
    pub provenance: serde_json::Value,
}

/// The valve's restriction law on the line area.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Valve {
    full_area_m2: f64,
    line_area_m2: f64,
}
impl Valve {
    /// Admits the section's valve against its own line and sizing: the
    /// full area is the sizing point's `m/sqrt(2 rho dp)` and the full-open
    /// loss is `(A/CdA_full)^2`, both within rounding; the check is the
    /// selected ideal one-way check.
    pub fn new(section: &Section) -> Result<Self, Failure> {
        let v = &section.valve;
        let (a, c) = (section.line.area_m2, v.full_effective_area_m2);
        if !(a.is_finite() && a > 0. && c.is_finite() && c > 0.) {
            return Err(fatal("line and valve areas must be positive"));
        }
        let sized =
            v.sizing.flow_kg_s / (2. * v.sizing.density_kg_m3 * v.sizing.differential_pa).sqrt();
        let close = |x: f64, y: f64| (x - y).abs() <= 1e-12 * x.abs().max(y.abs());
        if !close(sized, c) || !close((a / c).powi(2), v.full_open_form_loss) {
            return Err(fatal(
                "the valve area disagrees with its sizing point or loss",
            ));
        }
        if v.inlet_check != "ideal-one-way" {
            return Err(fatal(format!("unselected inlet check {}", v.inlet_check)));
        }
        Ok(Self {
            full_area_m2: c,
            line_area_m2: a,
        })
    }
    /// `K_v(x) = (A/(x·CdA_full))²` on the line area for an open stem
    /// `x ∈ (0, 1]`; a closed valve has no restriction law (its path is
    /// locked), so `x = 0` refuses.
    pub fn form_loss(&self, x: f64) -> Result<f64, Failure> {
        if !(x > 0. && x <= 1.) {
            return Err(fatal(format!(
                "stem {x}: only an open valve has a restriction law"
            )));
        }
        Ok((self.line_area_m2 / (x * self.full_area_m2)).powi(2))
    }
    pub fn full_area_m2(&self) -> f64 {
        self.full_area_m2
    }
}

/// How a stem instant enters the plant (lead decision S3-D4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StemChange {
    /// Nothing changes (the same target).
    None,
    /// Only the trajectory's slope changes: class S.
    Slope,
    /// The valve path leaves or enters its closed lock: class R.
    Lock,
}

/// The stem's held trajectory: from `x0` at `t0` toward `target` at `rate`
/// full strokes per second (S3-D19: copyable exactly, as IEEE bits).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stem {
    #[serde(with = "crate::joined::block::snapshot_bits")]
    x0: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    t0: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    target: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    rate: f64,
}
impl Stem {
    /// The selected stroke rate (full strokes per second).
    pub fn strokes_per_second(&self) -> f64 {
        self.rate
    }
    /// The commissioning state: closed and at rest (the controlled stem
    /// starts achieved 0).
    pub fn closed(t0: f64, strokes_per_second: f64) -> Result<Self, Failure> {
        if !(strokes_per_second.is_finite() && strokes_per_second > 0. && t0.is_finite()) {
            return Err(fatal(format!("stroke rate {strokes_per_second}")));
        }
        Ok(Self {
            x0: 0.,
            t0,
            target: 0.,
            rate: strokes_per_second,
        })
    }
    /// The instant the stem reaches its target, `t0` when it is there.
    pub fn arrival(&self) -> f64 {
        self.t0 + (self.target - self.x0).abs() / self.rate
    }
    /// `x(t)`: the linear travel toward the target, then the target.
    pub fn position(&self, t: f64) -> Result<f64, Failure> {
        if !(t.is_finite() && t >= self.t0) {
            return Err(fatal(format!(
                "stem read at {t} s before its issue at {} s",
                self.t0
            )));
        }
        if t >= self.arrival() {
            return Ok(self.target);
        }
        let step = self.rate * (t - self.t0);
        Ok(if self.target > self.x0 {
            self.x0 + step
        } else {
            self.x0 - step
        })
    }
    /// Whether the stem is issued 0 (moving toward or resting at closed).
    pub fn closing(&self) -> bool {
        self.target == 0.
    }
    /// Whether the stem rests closed at `t` (its path is locked).
    pub fn closed_at(&self, t: f64) -> Result<bool, Failure> {
        Ok(self.position(t)? == 0.)
    }
    /// The next stem instant after `t`: its arrival, with its class (R when
    /// it closes the valve, S otherwise), or none at rest.
    pub fn next_instant(&self, t: f64) -> Option<(f64, StemChange)> {
        let a = self.arrival();
        (a > t).then_some((
            a,
            if self.target == 0. {
                StemChange::Lock
            } else {
                StemChange::Slope
            },
        ))
    }
    /// Issue a new fraction at `t` (a control frame): the trajectory
    /// continues from the current position. Returns how the change enters.
    pub fn issue(&mut self, t: f64, target: f64) -> Result<StemChange, Failure> {
        if !(0. ..=1.).contains(&target) {
            return Err(fatal(format!("issued fraction {target}")));
        }
        if target == self.target {
            return Ok(StemChange::None);
        }
        let x = self.position(t)?;
        let change = if x == 0. && target > 0. {
            StemChange::Lock
        } else {
            StemChange::Slope
        };
        *self = Self {
            x0: x,
            t0: t,
            target,
            rate: self.rate,
        };
        Ok(change)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owners' values as the compiler composes them (wiki ld01-s3-ic-ctrl
    /// 4def4fc): CdA_full = 20/sqrt(2·745.1482932491854·2e5).
    fn section() -> Section {
        let a = std::f64::consts::PI * 0.1 * 0.1 / 4.;
        let c = 20. / (2. * 745.148_293_249_185_4_f64 * 2e5).sqrt();
        serde_json::from_value(serde_json::json!({
            "source": "COLD.A",
            "line": {"length_m": 25., "insideDiameter_m": 0.1, "area_m2": a, "volume_m3": a * 25.,
                "inletElevation_m": 3., "outletElevation_m": 18.5, "centroidElevation_m": 10.75,
                "wallThickness_m": 0.01, "roughness_m": 1.5e-6, "wall": "circular_churchill"},
            "halves": [],
            "valve": {"face": "COLD.A->SPRAY", "fullEffectiveArea_m2": c, "fullOpenFormLoss": (a / c).powi(2),
                "strokesPerSecond": 0.5, "inletCheck": "ideal-one-way",
                "sizing": {"flow_kg_s": 20., "differential_Pa": 2e5, "density_kg_m3": 745.148_293_249_185_4}},
            "distributor": {"face": "SPRAY->PZR.SPRAY", "aggregateEffectiveArea_m2": 0.001, "elevation_m": 18.5,
                "formLoss": (a / 0.001_f64).powi(2)},
            "provenance": null
        }))
        .unwrap()
    }

    #[test]
    fn the_valve_and_distributor_pass_the_owners_held_state_flow() {
        let s = section();
        let v = Valve::new(&s).unwrap();
        assert_eq!(v.full_area_m2(), 0.001_158_453_602_592_212_7);
        // Full open against the S2-07 net differential (0.2227 MPa after the
        // 15.5 m head): the wiki's held-state receipt gives 13.75 kg/s with
        // its line friction; valve and distributor alone give 13.79 kg/s.
        let (a, rho, dp) = (s.line.area_m2, 745.148_293_249_185_4, 222_735.168);
        let k = v.form_loss(1.).unwrap() + s.distributor.form_loss;
        let m = a * (2. * rho * dp / k).sqrt();
        assert!((m - 13.79).abs() < 0.01, "{m}");
        assert!((v.form_loss(0.1).unwrap() / v.form_loss(1.).unwrap() - 100.).abs() < 1e-9);
        assert!(v.form_loss(0.).is_err());
        assert!(v.form_loss(1.1).is_err());
    }

    #[test]
    fn inadmissible_valves_refuse() {
        let mut s = section();
        s.valve.full_effective_area_m2 *= 1.001;
        assert!(Valve::new(&s).is_err());
        let mut s = section();
        s.valve.inlet_check = "none".into();
        assert!(Valve::new(&s).is_err());
    }

    #[test]
    fn the_stem_travels_at_its_rate_reverses_from_where_it_is_and_classes_its_instants() {
        let mut stem = Stem::closed(0., 0.5).unwrap();
        assert!(stem.closed_at(0.).unwrap());
        assert_eq!(stem.next_instant(0.), None);
        // Opening a closed valve releases its lock: R.
        assert_eq!(stem.issue(1., 0.5).unwrap(), StemChange::Lock);
        assert_eq!(stem.position(1.5).unwrap(), 0.25);
        assert_eq!(stem.next_instant(1.5), Some((2., StemChange::Slope)));
        assert_eq!(stem.position(3.).unwrap(), 0.5);
        // The same fraction again changes nothing.
        assert_eq!(stem.issue(3., 0.5).unwrap(), StemChange::None);
        // A reversal mid-travel continues from the current position: S.
        assert_eq!(stem.issue(3., 1.).unwrap(), StemChange::Slope);
        assert_eq!(stem.issue(3.4, 0.).unwrap(), StemChange::Slope);
        assert!((stem.position(3.4).unwrap() - 0.7).abs() < 1e-12);
        // Closing ends in the lock: an R instant at the arrival.
        let (t, c) = stem.next_instant(3.4).unwrap();
        assert!((t - 4.8).abs() < 1e-12);
        assert_eq!(c, StemChange::Lock);
        assert!(stem.closed_at(5.).unwrap());
        assert!(stem.position(3.).is_err());
        assert!(stem.issue(6., 1.5).is_err());
    }
}

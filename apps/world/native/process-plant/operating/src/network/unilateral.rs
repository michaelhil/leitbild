//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#l1-unilateral-absent-donor-law-implemented-at-s3
//! L1, the ideal unilateral absent-donor law, for every phase path of the
//! network (decision 0014, owner-approved D1b, built at the S3 phase
//! branch; lead decision S3-D-P2). The law, verbatim:
//!
//! > On a phase-k path whose drive would draw from a cell holding no phase-k
//! > mass, the impulse row is the algebraic Π_k = 0 and the path transports
//! > nothing; the reaction is reported. It is released by root, from
//! > Π_k = 0, when the drive reverses or when phase k is born in that cell
//! > from its responsible receipt. A path whose donor phase-k mass reaches
//! > zero while carrying outflow enters contact by root at that instant, and
//! > its kinetic energy is paid once as a receipt. No epsilon mass, flow clip
//! > or damping.
//!
//! Realization (the locked rotor's algebraic-row transaction, per path):
//! - Each phase path, in [`super::Network::face_layout`] order, is
//!   [`Lock::Free`] (its retained impulse is differential) or
//!   [`Lock::Locked`]. A locked path's row is `Π/s` (id 0), its kinematics
//!   are the rest chart (`Q = 0`, value and direction), so it transports
//!   nothing in any trial, and its drive `F` (pressure–gravity plus the
//!   projected section force) is the reported reaction.
//! - The lock state changes only in a transaction at a located instant
//!   ([`decide`]); there is no hysteresis, threshold or smoothing. Release
//!   is exact: `Π = 0` is already the state, so no coordinate moves.
//!   Contact sets `Π = 0` and pays the path's kinetic energy `½ Π Q`, the
//!   chart's own diagnostic, once into the receiving end's energy stock.
//! - Which cell holds which phase is the phase-mode owner's declaration
//!   ([`Presence`]); L1 never reads a sign of a stock to decide presence
//!   and never moves a stock other than the one payment.
//! - The lock table is part of the copyable discrete Run state; it is
//!   absent until a caller declares L1 active, so the S1/S2 residuals are
//!   untouched by this module.
use super::{Failure, Network, PZR_ENERGY, PZR_MASS, Properties, stratified};
use crate::{local_flow as flow, thermal::Scalar};
use serde::Serialize;

/// Which ends of a phase path hold that phase's mass.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub enum Holding {
    Neither,
    From,
    To,
    Both,
}
impl Holding {
    pub fn of(from: bool, to: bool) -> Self {
        match (from, to) {
            (false, false) => Self::Neither,
            (true, false) => Self::From,
            (false, true) => Self::To,
            (true, true) => Self::Both,
        }
    }
    fn holds(self, end: End) -> bool {
        matches!(
            (self, end),
            (Self::Both, _) | (Self::From, End::From) | (Self::To, End::To)
        )
    }
    /// `+1` when only `from` holds, `-1` when only `to` holds: a positive
    /// drive draws from `from`, so `orientation × F > 0` draws from the
    /// holding end.
    pub fn orientation(self) -> Option<f64> {
        match self {
            Self::From => Some(1.),
            Self::To => Some(-1.),
            Self::Neither | Self::Both => None,
        }
    }
}

/// One end of a face.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum End {
    From,
    To,
}
impl End {
    pub(super) fn other(self) -> Self {
        match self {
            Self::From => Self::To,
            Self::To => Self::From,
        }
    }
}

/// The L1 state of one phase path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub enum Lock {
    /// The retained impulse is the path's differential momentum.
    Free,
    /// `Π = 0` algebraic, transporting nothing, with the ends' holding at
    /// its last transaction: a one-sided lock carries the release root on
    /// its drive; a lock with neither end holding is released only by a
    /// birth (a transaction of the phase-mode owner).
    Locked(Holding),
}

/// The L1 state of every phase path, indexed as the network's face layout
/// (`2 face + phase`): copyable discrete Run state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Locks {
    pub paths: Vec<Lock>,
}
impl Locks {
    pub fn is_locked(&self, path: usize) -> bool {
        matches!(self.paths[path], Lock::Locked(_))
    }
    pub fn locked(&self) -> usize {
        self.paths
            .iter()
            .filter(|l| matches!(l, Lock::Locked(_)))
            .count()
    }
}

/// Phase presence of every network cell, regular cells then the stratified
/// cell's port: `[liquid, vapor]`. The phase-mode owner's declaration (a
/// newborn phase is present with zero mass; an exhausted one is absent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Presence {
    pub cells: Vec<[bool; 2]>,
}

/// A located root of an L1 root function (correct direction).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Fired {
    Release,
    Contact,
}

/// Why a path's lock changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Cause {
    /// Released by its located drive root: the drive reversed.
    DriveRoot,
    /// Released at a transaction located by another root, where the drive
    /// already draws from the holding end.
    DriveAtTransaction,
    /// Released: phase k was born in the formerly empty end.
    Birth,
    /// Locked by its located contact root: the donor's phase mass reached
    /// zero while carrying outflow.
    ContactRoot,
    /// Locked at a transaction located by another root (the donor's
    /// exhaustion or dryout), where the donor holds no phase k.
    ContactAtTransaction,
    /// Locked at rest (`Q = 0`): the drive would draw from an empty end,
    /// or there is no drive and an end is empty. Nothing to pay.
    AtRest,
    /// Locked in the phase-mode owner's exhaustion transaction: the path's
    /// phase inertia lived only in cells that hold no phase k after the
    /// exhaustion, so its retained impulse has no inertia left (DR
    /// S3-EXHAUST; decision 0014's contact at the donor's exhaustion).
    Exhaustion,
    /// Released at a segment start, after the exact consistent start: the
    /// drive draws from the holding end at `t0+`, already at the consistent
    /// state or, from an exact zero (a newborn phase's fraction), by its
    /// rate along the consistent rates (`F(t0+)` has the sign of `F'(t0)`).
    /// Stock IDA never reports a root that starts on the released side or
    /// at an exact zero (DR S3-REBIRTH).
    DriveAtStart,
}

/// One path's view at a transaction: its ends' holding and its last value
/// evaluation's drive, volume flow and kinetic energy `½ Π Q`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PathView {
    pub holding: Holding,
    pub drive_pa: f64,
    pub volume_flow_m3_s: f64,
    pub kinetic_j: f64,
}

/// What [`decide`] makes of one path.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Decision {
    pub lock: Lock,
    pub cause: Option<Cause>,
    /// A contact's kinetic energy and the end that receives it.
    pub payment: Option<(End, f64)>,
}

/// The law at one located instant, for one path. A free path locks when
/// the end it draws from (by its flow; at rest by its drive) holds no
/// phase k, paying its kinetic energy if it moves; a locked path is
/// released when both ends hold phase k (a birth) or when its drive draws
/// from its holding end (its located root, or found at the transaction).
/// A located contact root whose donor the presence still declares holding
/// refuses: the donor's exhaustion is the phase-mode owner's transaction
/// and must come first.
pub fn decide(lock: Lock, view: PathView, fired: Option<Fired>) -> Result<Decision, Failure> {
    let PathView {
        holding,
        drive_pa: f,
        volume_flow_m3_s: q,
        kinetic_j,
    } = view;
    if ![f, q, kinetic_j].iter().all(|v| v.is_finite()) {
        return Err(Failure::Fatal(format!(
            "L1 transaction on a nonfinite path view {view:?}"
        )));
    }
    let stay = Decision {
        lock,
        cause: None,
        payment: None,
    };
    match lock {
        Lock::Free => {
            let donor = if q > 0. {
                Some(End::From)
            } else if q < 0. {
                Some(End::To)
            } else if f > 0. {
                Some(End::From)
            } else if f < 0. {
                Some(End::To)
            } else {
                None
            };
            let draws_absent = match donor {
                Some(end) => !holding.holds(end),
                None => holding != Holding::Both,
            };
            if !draws_absent {
                if fired == Some(Fired::Contact) {
                    return Err(Failure::Fatal(format!(
                        "L1 contact root located while the donor still holds the phase ({view:?}): the phase-mode owner's exhaustion must precede the lock"
                    )));
                }
                return Ok(stay);
            }
            let moving = q != 0.;
            let cause = if fired == Some(Fired::Contact) {
                Cause::ContactRoot
            } else if moving {
                Cause::ContactAtTransaction
            } else {
                Cause::AtRest
            };
            let payment = match donor {
                Some(end) if moving => {
                    // The receipt enters the end the path was feeding,
                    // which holds the phase; anything else is a presence
                    // the phase-mode owner must answer first.
                    if !holding.holds(end.other()) {
                        return Err(Failure::Fatal(format!(
                            "L1 contact would pay into an end holding no phase ({view:?})"
                        )));
                    }
                    Some((end.other(), kinetic_j))
                }
                _ => None,
            };
            Ok(Decision {
                lock: Lock::Locked(holding),
                cause: Some(cause),
                payment,
            })
        }
        Lock::Locked(_) => match holding {
            Holding::Both => Ok(Decision {
                lock: Lock::Free,
                cause: Some(Cause::Birth),
                payment: None,
            }),
            Holding::Neither => Ok(Decision {
                lock: Lock::Locked(Holding::Neither),
                ..stay
            }),
            Holding::From | Holding::To => {
                let o = holding.orientation().unwrap_or(0.);
                if fired == Some(Fired::Release) {
                    Ok(Decision {
                        lock: Lock::Free,
                        cause: Some(Cause::DriveRoot),
                        payment: None,
                    })
                } else if o * f > 0. {
                    Ok(Decision {
                        lock: Lock::Free,
                        cause: Some(Cause::DriveAtTransaction),
                        payment: None,
                    })
                } else {
                    Ok(Decision {
                        lock: Lock::Locked(holding),
                        ..stay
                    })
                }
            }
        },
    }
}

/// The rest chart of a locked path: its inertance, no flow.
pub(super) fn held_path(inertance: Scalar) -> flow::PathKinematics {
    flow::PathKinematics {
        inertance_kg_m4: inertance,
        inertance_rate_kg_m4_s: Scalar::constant(0.),
        volume_flow_m3_s: Scalar::constant(0.),
    }
}

/// One path's change in a transaction.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Change {
    pub path: usize,
    pub face: usize,
    pub phase: usize,
    pub before: Lock,
    pub after: Lock,
    pub cause: Cause,
    pub drive_pa: f64,
    pub impulse_pa_s: f64,
    /// The path's volume flow `Q = Π/I`; undefined (`None`) for an
    /// exhaustion lock, whose inertia vanished with its donor's vapor, so
    /// `Q` and `½ Π Q` have no value there and are not reported as numbers
    /// (DR S3-EXHAUST-REPORT; see [`Network::exhaustion_with_paths`]).
    pub volume_flow_m3_s: Option<f64>,
    /// An exhaustion lock's vapor mass flow at the located instant,
    /// `Π (αρ)_d / I` with the donor `d` by the impulse's direction: finite
    /// while the donor's vapor vanishes (`None` for the other causes).
    pub mass_flow_kg_s: Option<f64>,
    /// A contact's payment: the receiving cell, the coordinate it entered
    /// and the energy in J.
    pub payment: Option<(usize, usize, f64)>,
}

/// The outcome of one L1 transaction.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Transaction {
    pub changes: Vec<Change>,
    pub energy_paid_j: f64,
}

impl<P: Properties> Network<P> {
    /// The sign of path `li`'s volume flow `Q = Pi/I` in the coordinate
    /// view `y`, with `I` the supports' phase mass per current volume (as
    /// the charts compose it, from the last evaluation's volumes): `+1`
    /// from `from`, `-1` from `to`, `0` at rest. A signed root-size phase
    /// mass can make `I` negative, so the impulse's sign alone may name the
    /// wrong donor (DR S3-REBIRTH).
    pub fn path_flow_sign(&self, y: &[f64], li: usize) -> f64 {
        let l = self.face_layout[li];
        let pi = y[l.index];
        if pi == 0. {
            return 0.;
        }
        let inertance: f64 = self.faces[l.face]
            .supports
            .iter()
            .map(|support| {
                let i = self.cell_layout[support.region].mass[l.phase];
                y[i] * self.scales[i] / self.cell_volume[support.region].value
                    * support.inverse_area_length_per_m
            })
            .sum();
        if inertance < 0. {
            -pi.signum()
        } else {
            pi.signum()
        }
    }
    /// The `(from, to)` cells of face `face`.
    pub fn face_ends(&self, face: usize) -> (usize, usize) {
        self.endpoints[face]
    }
    /// The L1 lock table, when L1 is active.
    pub fn unilateral(&self) -> Option<&Locks> {
        self.unilateral.as_ref()
    }
    /// Whether L1 holds path `li` (face-layout index) locked.
    pub(super) fn unilateral_locked(&self, li: usize) -> bool {
        self.unilateral.as_ref().is_some_and(|u| u.is_locked(li))
    }
    /// R4-MOUTH-INERTIA: the inertia of the vapor the free surge-mouth path
    /// must accelerate on the PZR side, `(αρ)_port ∫ds/A`, with the port
    /// view's own `αρ`, the factor of the path's mass flow when the PZR is
    /// its donor. With S3-D37's donor outside face 34's supports, `Q = Π/I`
    /// on the SURGE supports alone makes `w = (αρ)_port Π/I` unbounded as
    /// SURGE's vapor vanishes; a donor inside the path's inertia bounds
    /// `|w| <= |Π|/∫ds/A`, as on a path whose donor is a support. `None`
    /// off that path, without L1, locked, or with no bubbles at the port.
    /// R4-VAPOR-IMPULSE: the rate of a path's support inertia. `rate` is each
    /// support region's `M' - M V'/V`, the rate of the phase density's
    /// numerator; `M'` is the row's own `y'`, also where the vapor mass is an
    /// equilibrium cell's algebraic coordinate (owner, 7 Nov).
    pub(super) fn support_inertia_rate(
        &self,
        face: usize,
        rate: impl Fn(usize) -> Scalar,
        volume: impl Fn(usize) -> Scalar,
    ) -> Scalar {
        self.faces[face]
            .supports
            .iter()
            .fold(Scalar::constant(0.), |sum, support| {
                sum + rate(support.region) * Scalar::constant(support.inverse_area_length_per_m)
                    / volume(support.region)
            })
    }

    pub(super) fn mouth_inertance(&self, li: usize, cells: &[flow::Cell]) -> Option<Scalar> {
        let (mouth, per_m) = self.mouth?;
        let free = self
            .unilateral
            .as_ref()
            .is_some_and(|u| u.paths[li] == Lock::Free);
        if li != mouth || !free {
            return None;
        }
        let a = cells[self.pzr.cell].phase[1]?;
        Some(a.density * a.fraction * Scalar::constant(per_m))
    }
    /// Restore a copied lock table (copy/restore of the discrete state).
    pub fn restore_unilateral(&mut self, locks: Locks) -> Result<(), Failure> {
        if locks.paths.len() != self.face_layout.len() {
            return Err(Failure::Fatal(format!(
                "{} L1 path states for {} phase paths",
                locks.paths.len(),
                self.face_layout.len()
            )));
        }
        self.unilateral = Some(locks);
        Ok(())
    }
    /// The presence a liquid-only network declares by its stocks: a regular
    /// cell holds phase k when its retained phase-k mass in `y` is nonzero,
    /// and the stratified cell's port holds what the last value
    /// evaluation's port view shows. The phase-mode owner replaces it once
    /// modes exist (a newborn phase holds zero mass).
    pub fn stock_presence(&self, y: &[f64]) -> Presence {
        let mut cells: Vec<[bool; 2]> = self
            .cell_layout
            .iter()
            .map(|l| [y[l.mass[0]] != 0., y[l.mass[1]] != 0.])
            .collect();
        let port = self.cells[self.pzr.cell].phase;
        // S3-D37: the surge port's vapor is zone A's bubble stock b_A, held
        // while it is positive: the stock its vapor path's contact root
        // reads, which no phase-mode owner zeroes at its exhaustion, so the
        // root's crossing is the presence's edge (as for the spray drops).
        let bubbles = self.pzr.base + super::stratified::ADMITTED_BUBBLE_MASS;
        cells.push([port[0].is_some(), port[1].is_some() && y[bubbles] > 0.]);
        // IC-CTRL (S3 spray path): the spray port's virtual cell holds the
        // vapor region's vapor as its port view shows it, and its drops
        // while the drop stock is positive: the stock its liquid path's
        // contact root reads (DR-P3-SPRAY). No phase-mode owner zeroes the
        // drop stock at its exhaustion, so the root's crossing is the
        // presence's edge.
        if let Some(sp) = self.spray {
            let view = self.cells[sp.port_cell].phase;
            let drops = self.pzr.base + super::stratified::DROP_MASS;
            cells.push([y[drops] > 0., view[1].is_some()]);
        }
        Presence { cells }
    }
    /// The energy coordinate a contact payment of phase `k` into `cell`
    /// enters: the differential energy stock that cell's phase-k receipts
    /// enter, or the stratified cell's admitted layer, which receives every
    /// surge-port inflow, the vapor's too (S3-D30: its bubbles' enthalpy is
    /// A's to pay).
    ///
    /// DR-L1-PAY: a liquid-mode regular cell's phase-k energy stock is its
    /// own slot. An equilibrium cell's slot `U_l` holds its total `U`, which
    /// both phases' receipts enter (`U' = H_l + H_g`), while its slot `U_g`
    /// is algebraic (`U_g = M_g u_g(p)`): a payment there is read by no
    /// stock and the next consistent start projects it away. Either phase's
    /// payment enters the total, and the flash shares it out.
    pub fn payment_coordinate(&self, cell: usize, k: usize) -> Result<usize, Failure> {
        if cell < self.pzr.cell {
            let l = self.cell_layout[cell];
            Ok(match self.modes[cell] {
                super::CellMode::Liquid => l.energy[k],
                super::CellMode::Equilibrium => l.energy[0],
            })
        } else if cell == self.pzr.cell {
            Ok(self.pzr.base + PZR_ENERGY[1])
        } else if k == 1 && self.spray.is_some_and(|s| s.port_cell == cell) {
            // The spray port's vapor is the vapor zone's.
            Ok(self.pzr.base + super::stratified::VAPOR_ENERGY)
        } else {
            Err(Failure::Fatal(format!(
                "no L1 payment coordinate for phase {k} of cell {cell}"
            )))
        }
    }
    /// The phase-mode owner's exhaustion of `cells` with the vapor paths it
    /// empties, in one exact transaction at a located instant (lead DR
    /// S3-EXHAUST). The caller evaluated the network's value state at this
    /// instant, before the exhaustion. Every free vapor path whose inertia
    /// supports hold no vapor once `cells` are exhausted (each support is one
    /// of `cells` or a regular cell with no vapor stock) and that carries
    /// impulse or flow in that evaluation is locked with `Π = 0`
    /// (`Locked(holding after the exhaustion)`, so a re-birth releases it
    /// through [`decide`]); then each cell is exhausted
    /// ([`Network::exhaustion`]): its vapor slots, of root size, are zeroed
    /// and its totals stay. No mass, energy or boron moves.
    ///
    /// **The path's kinetic energy is not paid (S3-D31).** Decision 0014
    /// pays a contact's `½ Π Q` once. Here the path's inertia `I` lives only
    /// in the exhausting donor, so `I ∝ M_g` is of root size at the located
    /// instant while `Π` stays finite (every force on the phase scales with
    /// its fraction and no advective momentum outflux is composed), and
    /// `½ Π²/I` is unbounded and sign-indefinite: in C2 it was -2.8e12 J.
    /// Paying it would create that energy. Without L1 the cells are only
    /// exhausted.
    ///
    /// **The record carries the path's vapor mass flow, not `Q` (DR
    /// S3-EXHAUST-REPORT).** `Q = Π/I` and `½ Π Q` divide by the vanishing
    /// vapor stock (C2 at KERN 53ae7c05: `Q` 3.0e11 m³/s, `½ Π Q` -2.1e15 J
    /// at a root-size `I` of either sign), so the change reports `Q` as
    /// undefined and no kinetic energy; its mass flow `Π (αρ)_d / I` is
    /// finite (`vanishing_vapor_mass_flow`). In C2 neither entered a
    /// residual or Jacobian row: fluxes and the gas-path loss compose `Q`
    /// only times a donor's or SURGE's `αρ`, which is the vanishing stock
    /// itself or zero (both ends hold no vapor), `½ Π Q` is diagnostic, and
    /// the locked row is `Π/s`.
    pub fn exhaustion_with_paths(
        &mut self,
        y: &mut [f64],
        cells: &[usize],
    ) -> Result<(Vec<serde_json::Value>, Transaction), Failure> {
        let mut out = Transaction::default();
        let mut vanishing = Vec::new();
        if let Some(locks) = &self.unilateral {
            for li in 0..self.face_layout.len() {
                let l = self.face_layout[li];
                if l.phase != 1 || locks.paths[li] != Lock::Free {
                    continue;
                }
                let face = &self.faces[l.face];
                let empties = !face.supports.is_empty()
                    && face.supports.iter().any(|s| cells.contains(&s.region))
                    && face
                        .supports
                        .iter()
                        .all(|s| cells.contains(&s.region) || self.end_mass(y, s.region, 1) == 0.);
                if !empties {
                    continue;
                }
                let chart = self.charts[l.face][1].ok_or_else(|| {
                    Failure::Fatal(
                        "an exhaustion with L1 needs the value evaluation's vapor charts".into(),
                    )
                })?;
                let impulse = y[l.index] * self.scales[l.index];
                let q = chart.volume_flow_m3_s.value;
                if impulse == 0. && q == 0. {
                    continue;
                }
                if ![impulse, q].iter().all(|v| v.is_finite()) {
                    return Err(Failure::Fatal(format!(
                        "exhaustion contact on a nonfinite vapor path view (face {}, Π {impulse}, Q {q})",
                        l.face
                    )));
                }
                let mass_flow = self.vanishing_vapor_mass_flow(y, l.face, impulse);
                vanishing.push((li, impulse, mass_flow, self.face_drive[l.face][1].value));
            }
        }
        let mut events = Vec::new();
        for c in cells {
            events.push(self.exhaustion(*c, y)?);
        }
        if vanishing.is_empty() {
            return Ok((events, out));
        }
        let presence = self.declared_presence(y);
        let mut locks = self
            .unilateral
            .clone()
            .ok_or_else(|| Failure::Fatal("L1 is not active".into()))?;
        for (li, impulse, mass_flow, drive) in vanishing {
            let l = self.face_layout[li];
            let (from, to) = self.endpoints[l.face];
            let holding = Holding::of(presence.cells[from][1], presence.cells[to][1]);
            let before = locks.paths[li];
            let after = Lock::Locked(holding);
            y[l.index] = 0.;
            out.changes.push(Change {
                path: li,
                face: l.face,
                phase: l.phase,
                before,
                after,
                cause: Cause::Exhaustion,
                drive_pa: drive,
                impulse_pa_s: impulse,
                volume_flow_m3_s: None,
                mass_flow_kg_s: mass_flow,
                payment: None,
            });
            locks.paths[li] = after;
        }
        self.unilateral = Some(locks);
        Ok((events, out))
    }
    /// The vapor mass flow of a path whose inertia vanishes with its
    /// supports' vapor, at the located instant before the exhaustion: the
    /// chart's `(αρ)_d Q = Π (αρ)_d / I`, with `αρ = M_g/V` as the inertia
    /// `I = Σ_s (M_g/V)_s ∫ds/A` is formed, and the donor `d` by the
    /// impulse's direction (once the root-size `I` has crossed zero, `Q`'s
    /// sign no longer gives it). Zero when the donor holds no vapor; `None`
    /// (undefined) when it holds vapor that supports none of `I`, or when
    /// the signed stocks cancel `I` exactly.
    fn vanishing_vapor_mass_flow(&self, y: &[f64], face: usize, impulse: f64) -> Option<f64> {
        if impulse == 0. {
            return Some(0.);
        }
        let (from, to) = self.endpoints[face];
        let donor = if impulse > 0. { from } else { to };
        if self.end_mass(y, donor, 1) == 0. {
            return Some(0.);
        }
        let supports = &self.faces[face].supports;
        let density = |c: usize| {
            self.cell_volume
                .get(c)
                .map(|v| self.end_mass(y, c, 1) / v.value)
        };
        if !supports.iter().any(|s| s.region == donor) {
            // R4-MOUTH-INERTIA: the PZR as donor is in the path's inertia.
            let (_, per_m) = self.mouth?;
            let beyond = self.mouth_inertance(2 * face + 1, &self.cells)?.value;
            let mut inertia = beyond;
            for s in supports {
                inertia += density(s.region)? * s.inverse_area_length_per_m;
            }
            let flow = impulse * (beyond / per_m) / inertia;
            return flow.is_finite().then_some(flow);
        }
        let mut inertia = 0.;
        for s in supports {
            inertia += density(s.region)? * s.inverse_area_length_per_m;
        }
        let flow = impulse * density(donor)? / inertia;
        flow.is_finite().then_some(flow)
    }
    /// Phase-`k` mass of one end in a coordinate view the network evaluated:
    /// a regular cell's stock, the stratified cell's surge-port layers
    /// (admitted and resident liquid) for liquid, and zone A's bubble stock
    /// b_A for vapor (S3-D37).
    pub(super) fn end_mass(&self, y: &[f64], cell: usize, k: usize) -> f64 {
        if cell < self.pzr.cell {
            let i = self.cell_layout[cell].mass[k];
            y[i] * self.scales[i]
        } else if self.spray.is_some_and(|s| s.port_cell == cell) {
            // The spray port: the drop stock for liquid, the vapor zone.
            let o = if k == 0 {
                super::stratified::DROP_MASS
            } else {
                super::stratified::VAPOR_MASS
            };
            let i = self.pzr.base + o;
            y[i] * self.scales[i]
        } else if k == 0 {
            [PZR_MASS[1], PZR_MASS[2]]
                .iter()
                .map(|o| {
                    let i = self.pzr.base + o;
                    y[i] * self.scales[i]
                })
                .sum()
        } else {
            let i = self.pzr.base + super::stratified::ADMITTED_BUBBLE_MASS;
            y[i] * self.scales[i]
        }
    }
    /// One path's view from the last value evaluation and `presence`
    /// (also the spray port's scoped law, DR-P3-SPRAY).
    pub(super) fn path_view(&self, li: usize, presence: &Presence) -> Result<PathView, Failure> {
        let l = self.face_layout[li];
        let (from, to) = self.endpoints[l.face];
        let chart = self.charts[l.face][l.phase].ok_or_else(|| {
            Failure::Fatal("an L1 transaction needs the last value evaluation's charts".into())
        })?;
        let holds = |c: usize| -> Result<bool, Failure> {
            presence
                .cells
                .get(c)
                .map(|p| p[l.phase])
                .ok_or_else(|| Failure::Fatal(format!("the declared presence has no cell {c}")))
        };
        Ok(PathView {
            holding: Holding::of(holds(from)?, holds(to)?),
            drive_pa: self.face_drive[l.face][l.phase].value,
            volume_flow_m3_s: chart.volume_flow_m3_s.value,
            kinetic_j: chart.kinetic_j.value,
        })
    }
    /// Declare L1 active at the state of the last value evaluation, every
    /// path classified by [`decide`] from free. A path that would pay at
    /// activation carries momentum toward an absent donor: refused.
    pub fn activate_unilateral(&mut self, presence: &Presence) -> Result<Transaction, Failure> {
        self.unilateral = Some(Locks {
            paths: vec![Lock::Free; self.face_layout.len()],
        });
        let mut y = Vec::new();
        let result = self.transact(&mut y, presence, &[], None, true);
        if result.is_err() {
            self.unilateral = None;
        }
        result
    }
    /// One L1 transaction at a located instant, on the state of the last
    /// value evaluation (the caller evaluated its coordinate view at this
    /// instant): every path through [`decide`] with its located root, if
    /// any; a contact sets `Π = 0` in `y` and adds its kinetic energy to
    /// the coordinate `pay(cell, k)` names (the phase-mode owner's, or
    /// [`Network::payment_coordinate`] when `None`); nothing else in `y`
    /// moves.
    pub fn unilateral_transaction(
        &mut self,
        y: &mut [f64],
        presence: &Presence,
        fired: &[(usize, Fired)],
        pay: Option<&dyn Fn(usize, usize) -> Result<usize, Failure>>,
    ) -> Result<Transaction, Failure> {
        if self.unilateral.is_none() {
            return Err(Failure::Fatal("L1 is not active".into()));
        }
        self.transact(y, presence, fired, pay, false)
    }
    fn transact(
        &mut self,
        y: &mut [f64],
        presence: &Presence,
        fired: &[(usize, Fired)],
        pay: Option<&dyn Fn(usize, usize) -> Result<usize, Failure>>,
        activation: bool,
    ) -> Result<Transaction, Failure> {
        if presence.cells.len() != self.cells.len() {
            return Err(Failure::Fatal(format!(
                "declared presence for {} cells, network has {}",
                presence.cells.len(),
                self.cells.len()
            )));
        }
        let mut locks = self
            .unilateral
            .clone()
            .ok_or_else(|| Failure::Fatal("L1 is not active".into()))?;
        let mut out = Transaction::default();
        for li in 0..self.face_layout.len() {
            let l = self.face_layout[li];
            let view = self.path_view(li, presence)?;
            let root = fired.iter().find(|(p, _)| *p == li).map(|(_, f)| *f);
            let before = locks.paths[li];
            let decision = decide(before, view, root)?;
            let Some(cause) = decision.cause else {
                locks.paths[li] = decision.lock;
                continue;
            };
            let impulse = if activation {
                0.
            } else {
                y[l.index] * self.scales[l.index]
            };
            let mut payment = None;
            if let Some((end, energy)) = decision.payment {
                if activation {
                    return Err(Failure::Fatal(format!(
                        "L1 activation: face {} phase {} carries {} m3/s toward an end holding no phase {}",
                        l.face, l.phase, view.volume_flow_m3_s, l.phase
                    )));
                }
                let (from, to) = self.endpoints[l.face];
                let receiver = if end == End::From { from } else { to };
                let index = match pay {
                    Some(pay) => pay(receiver, l.phase)?,
                    None => self.payment_coordinate(receiver, l.phase)?,
                };
                y[index] += energy / self.scales[index];
                y[l.index] = 0.;
                out.energy_paid_j += energy;
                payment = Some((receiver, index, energy));
            }
            out.changes.push(Change {
                path: li,
                face: l.face,
                phase: l.phase,
                before,
                after: decision.lock,
                cause,
                drive_pa: view.drive_pa,
                impulse_pa_s: impulse,
                volume_flow_m3_s: Some(view.volume_flow_m3_s),
                mass_flow_kg_s: None,
                payment,
            });
            locks.paths[li] = decision.lock;
        }
        self.unilateral = Some(locks);
        Ok(out)
    }
    /// Decision 0014's release at a segment start (DR S3-REBIRTH), after a
    /// restart's exact consistent start: a one-sided lock is released now
    /// when its drive at `t0+` draws from its holding end, that is when the
    /// drive at the consistent state already does (`orientation × F > 0`:
    /// the transaction decided on the state before the projection moved a
    /// newborn cell's algebraic vapor mass), or when it is exactly zero and
    /// its rate along the consistent rates leaves zero toward the holding
    /// end (`F(t0+)` has the sign of `F'(t0)`). Its release root would
    /// otherwise start on the released side, or at an exact zero that stock
    /// IDA deactivates and never reports leaving zero. No coordinate moves
    /// (`Π = 0` stays); the released impulse's rate becomes the free row's
    /// `Π' = F` in `yp` (zero when `F = 0`), and no other row reads it, so
    /// the pair stays consistent. A zero drive with a zero rate stays locked
    /// (no higher order is taken). Returns the transaction and every
    /// one-sided lock with its oriented drive and oriented rate (Pa, Pa/s).
    /// Precondition: the last evaluation is seeded along the consistent
    /// rates `yp` with `cj = 0`, so each drive's direction is `dF/dt`.
    #[allow(clippy::type_complexity)] // The transaction and its one-sided list.
    pub fn unilateral_release_at_start(
        &mut self,
        yp: &mut [f64],
    ) -> Result<(Transaction, Vec<(usize, f64, f64)>), Failure> {
        let mut locks = self
            .unilateral
            .clone()
            .ok_or_else(|| Failure::Fatal("L1 is not active".into()))?;
        let mut out = Transaction::default();
        let mut one_sided = Vec::new();
        for (li, l) in self.face_layout.iter().enumerate() {
            let Lock::Locked(holding) = locks.paths[li] else {
                continue;
            };
            let Some(o) = holding.orientation() else {
                continue;
            };
            let drive = self.face_drive[l.face][l.phase];
            if !(drive.value.is_finite() && drive.direction.is_finite()) {
                return Err(Failure::Fatal(format!(
                    "L1 start release: nonfinite drive {drive:?} on face {} phase {}",
                    l.face, l.phase
                )));
            }
            let (value, rate) = (o * drive.value, o * drive.direction);
            one_sided.push((li, value, rate));
            if value > 0. || (value == 0. && rate > 0.) {
                locks.paths[li] = Lock::Free;
                yp[l.index] = drive.value / self.scales[l.index];
                out.changes.push(Change {
                    path: li,
                    face: l.face,
                    phase: l.phase,
                    before: Lock::Locked(holding),
                    after: Lock::Free,
                    cause: Cause::DriveAtStart,
                    drive_pa: drive.value,
                    impulse_pa_s: 0.,
                    volume_flow_m3_s: Some(0.),
                    mass_flow_kg_s: None,
                    payment: None,
                });
            }
        }
        self.unilateral = Some(locks);
        Ok((out, one_sided))
    }
    /// The reaction of every locked path at the last value evaluation: its
    /// drive `F` in Pa, by `(face, phase)`.
    pub fn unilateral_reactions(&self) -> Vec<(usize, usize, f64)> {
        let Some(locks) = &self.unilateral else {
            return Vec::new();
        };
        self.face_layout
            .iter()
            .enumerate()
            .filter(|(li, _)| locks.is_locked(*li))
            .map(|(_, l)| (l.face, l.phase, self.face_drive[l.face][l.phase].value))
            .collect()
    }
    /// The largest volume flow any locked path carries in the last value
    /// evaluation: the frozen phantom guard, zero by construction under L1.
    pub fn unilateral_phantom_m3_s(&self) -> f64 {
        let Some(locks) = &self.unilateral else {
            return 0.;
        };
        self.face_layout
            .iter()
            .enumerate()
            .filter(|(li, _)| locks.is_locked(*li))
            .filter_map(|(_, l)| self.charts[l.face][l.phase])
            .map(|c| c.volume_flow_m3_s.value.abs())
            .fold(0., f64::max)
    }
}

// The stratified cell's payment coordinate is its admitted energy.
const _: () = assert!(PZR_ENERGY[1] == stratified::ADMITTED_ENERGY);

#[cfg(test)]
mod tests {
    use super::*;

    fn view(holding: Holding, f: f64, q: f64) -> PathView {
        PathView {
            holding,
            drive_pa: f,
            volume_flow_m3_s: q,
            kinetic_j: 0.5 * 7. * q.abs(),
        }
    }
    fn free(h: Holding, f: f64, q: f64, fired: Option<Fired>) -> Decision {
        decide(Lock::Free, view(h, f, q), fired).unwrap()
    }
    fn locked(h0: Holding, h: Holding, f: f64, fired: Option<Fired>) -> Decision {
        decide(Lock::Locked(h0), view(h, f, 0.), fired).unwrap()
    }

    #[test]
    fn a_path_with_no_holding_end_is_locked_at_rest_and_stays_locked_whatever_its_drive() {
        let d = free(Holding::Neither, 0., 0., None);
        assert_eq!(d.lock, Lock::Locked(Holding::Neither));
        assert_eq!(d.cause, Some(Cause::AtRest));
        assert_eq!(d.payment, None);
        for f in [-3., 0., 3.] {
            let d = locked(Holding::Neither, Holding::Neither, f, None);
            assert_eq!(d.lock, Lock::Locked(Holding::Neither));
            assert_eq!(d.cause, None);
        }
    }

    #[test]
    fn a_one_sided_path_locks_when_its_drive_draws_from_the_empty_end_and_at_zero_drive() {
        // `from` holds: a positive drive draws from `from` (free), a negative
        // or zero drive from the empty `to` (locked; a newborn phase).
        assert_eq!(free(Holding::From, 2., 0., None).lock, Lock::Free);
        assert_eq!(
            free(Holding::From, -2., 0., None).lock,
            Lock::Locked(Holding::From)
        );
        assert_eq!(
            free(Holding::From, 0., 0., None).lock,
            Lock::Locked(Holding::From)
        );
        assert_eq!(free(Holding::To, -2., 0., None).lock, Lock::Free);
        assert_eq!(
            free(Holding::To, 2., 0., None).lock,
            Lock::Locked(Holding::To)
        );
    }

    #[test]
    fn release_happens_exactly_at_drive_reversal_or_a_birth_with_no_hysteresis() {
        // Locked with `from` holding: the drive at any positive value
        // releases at a transaction; zero or negative keeps the lock.
        assert_eq!(
            locked(Holding::From, Holding::From, f64::MIN_POSITIVE, None).cause,
            Some(Cause::DriveAtTransaction)
        );
        assert_eq!(locked(Holding::From, Holding::From, 0., None).cause, None);
        assert_eq!(
            locked(Holding::From, Holding::From, -f64::MIN_POSITIVE, None).cause,
            None
        );
        // The located root releases at the root, whatever the interpolated
        // drive's root-size sign.
        let d = locked(Holding::From, Holding::From, -1e-12, Some(Fired::Release));
        assert_eq!((d.lock, d.cause), (Lock::Free, Some(Cause::DriveRoot)));
        // A birth in the empty end releases whatever the drive.
        let d = locked(Holding::To, Holding::Both, -5., None);
        assert_eq!((d.lock, d.cause), (Lock::Free, Some(Cause::Birth)));
        assert_eq!(d.payment, None);
    }

    #[test]
    fn contact_locks_and_pays_the_kinetic_energy_once_into_the_receiver() {
        // Outflow from `from` (Q > 0) whose donor `from` is now empty.
        let v = view(Holding::To, -1., 0.25);
        let d = decide(Lock::Free, v, Some(Fired::Contact)).unwrap();
        assert_eq!(d.lock, Lock::Locked(Holding::To));
        assert_eq!(d.cause, Some(Cause::ContactRoot));
        assert_eq!(d.payment, Some((End::To, v.kinetic_j)));
        // Reverse flow from an empty `to`: pays into `from`.
        let v = view(Holding::From, 1., -0.5);
        let d = decide(Lock::Free, v, None).unwrap();
        assert_eq!(d.cause, Some(Cause::ContactAtTransaction));
        assert_eq!(d.payment, Some((End::From, v.kinetic_j)));
        // The lock pays nothing more later: a locked path stays at rest.
        let again = decide(d.lock, view(Holding::From, -1., 0.), None).unwrap();
        assert_eq!(again.payment, None);
    }

    #[test]
    fn a_contact_root_whose_donor_is_still_declared_present_refuses() {
        let e = decide(
            Lock::Free,
            view(Holding::Both, 1., 0.5),
            Some(Fired::Contact),
        );
        assert!(matches!(e, Err(Failure::Fatal(_))));
    }

    #[test]
    fn a_free_two_sided_path_stays_free_in_either_direction_and_at_rest() {
        for (f, q) in [(1., 1.), (-1., -1.), (1., -1.), (0., 0.)] {
            let d = free(Holding::Both, f, q, None);
            assert_eq!((d.lock, d.cause), (Lock::Free, None));
        }
    }

    #[test]
    fn a_moving_path_with_neither_end_holding_refuses_to_pay() {
        let e = decide(Lock::Free, view(Holding::Neither, 1., 0.3), None);
        assert!(matches!(e, Err(Failure::Fatal(_))));
        // At rest there is nothing to pay: it locks.
        let d = decide(Lock::Free, view(Holding::Neither, 1., 0.), None).unwrap();
        assert_eq!((d.lock, d.payment), (Lock::Locked(Holding::Neither), None));
    }

    #[test]
    fn a_nonfinite_view_refuses() {
        assert!(decide(Lock::Free, view(Holding::Both, f64::NAN, 0.), None).is_err());
    }
}

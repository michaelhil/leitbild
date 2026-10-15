//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray path inside the network (IC-CTRL, S3; lead decision
//! S3-D25): the valve as a quasi-steady restriction, its closure and its
//! inlet check as locks, and the stem's held trajectory.
//!
//! **Restriction (S3-D25 (1)).** The wiki realizes valve and nozzle
//! capacities as restriction relations at the line's faces. The open
//! valve's liquid path is therefore algebraic: its row is the capacity
//! relation of the valve area `x·CdA_full` under the path's own drive (the
//! pressure–gravity difference and the half line's wall friction),
//!
//! ```text
//! Q = x·CdA_full·sgn(Δp)·sqrt(2|Δp|/ρ)
//! ```
//!
//! scaled by the sizing flow. It holds for every opening, `x = 0`
//! included (zero capacity), so travel needs no infinite coefficient.
//!
//! **Closure (S3-D25 (2)).** While the stem rests closed both of the valve
//! face's phase paths are locked (`Π = 0`, the rest chart, L1's lock row);
//! opening from 0 releases them at the issue ([`Network::issue_spray`]) and
//! the stem's arrival at 0 sets them ([`Network::spray_event`], an owner
//! time event): both class R.
//!
//! **Inlet check (S3-D25 (3)).** The wiki selects one: "The healthy inlet
//! check prevents reverse transfer into COLD.A" and "This is a selected
//! ideal one-way check" (pressure-and-inventory.md, controlled-spray
//! material path; `ld01-pzr-spray-line` `inletCheck`). It is L1's unilateral
//! law on the valve face: a free path enters contact by root when its
//! impulse falls through zero (the forward flow ends; nothing to pay at
//! `Q = 0`), and the locked path is released by root when its forward drive
//! returns. Both are class R transactions.
//!
//! The distributor face (the tips) is never locked by the valve or the
//! check: the wiki keeps the tips bidirectional.
use super::{Failure, Network, Properties, SprayLayout};
use crate::{control::spray_valve::StemChange, thermal::Scalar};
use serde_json::{Value, json};

/// A disarmed root slot's constant value.
pub const DISARMED: f64 = 1.;

/// What the spray slot's root watches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckRoot {
    /// The valve is closed: no root.
    Disarmed,
    /// The check is open: the valve path's impulse, falling.
    Contact,
    /// The check is closed: the valve path's forward drive, rising.
    Release,
}

/// The valve's capacity `x·C·sgn(Δp)·sqrt(2|Δp|/ρ)` with its direction. A
/// zero opening has zero capacity; a zero differential with a moving
/// direction has no derivative and refuses the trial.
pub(super) fn capacity(x: f64, c: f64, dp: Scalar, rho: Scalar) -> Result<Scalar, Failure> {
    if x == 0. {
        return Ok(Scalar::constant(0.));
    }
    let (v, dv, r, dr) = (dp.value, dp.direction, rho.value, rho.direction);
    if !(r.is_finite() && r > 0. && v.is_finite()) {
        return Err(Failure::Recoverable(format!(
            "spray valve capacity at differential {v} Pa, density {r}"
        )));
    }
    if v == 0. {
        return if dv == 0. {
            Ok(Scalar::constant(0.))
        } else {
            Err(Failure::Recoverable(
                "spray valve capacity at a zero differential has no derivative".into(),
            ))
        };
    }
    let g = (2. * v.abs() / r).sqrt();
    let s = v.signum();
    Ok(Scalar::new(
        x * c * s * g,
        x * c * (dv / (r * g) - s * g * dr / (2. * r)),
    ))
}

impl<P: Properties> Network<P> {
    /// The composed spray path, if any.
    pub fn spray(&self) -> Option<&SprayLayout> {
        self.spray.as_ref()
    }
    /// Whether phase path `li` (face-layout index) is locked: by L1, or as
    /// the closed spray valve's or the closed inlet check's path.
    pub(super) fn path_locked(&self, li: usize) -> bool {
        self.unilateral_locked(li)
            || self.spray.is_some_and(|s| {
                (s.closed || s.check_closed) && self.face_layout[li].face == s.valve_face
            })
    }
    /// Whether phase path `li` is the valve's liquid path, algebraic in
    /// every state (the restriction relation open, the lock closed).
    pub(super) fn spray_algebraic(&self, li: usize) -> bool {
        let l = self.face_layout[li];
        self.spray
            .is_some_and(|s| l.face == s.valve_face && l.phase == 0)
    }
    /// The open valve's restriction row on path `li` at the opening of the
    /// last evaluation, or `None` for any other path: `(Q − capacity)/q_ref`
    /// with `drive` the path's pressure–gravity plus section force and `rho`
    /// the line's liquid density.
    pub(super) fn spray_restriction_row(
        &self,
        li: usize,
        volume_flow: Scalar,
        drive: Scalar,
        rho: Scalar,
    ) -> Result<Option<Scalar>, Failure> {
        let Some(s) = self.spray else {
            return Ok(None);
        };
        if !self.spray_algebraic(li) || s.closed || s.check_closed {
            return Ok(None);
        }
        let x = self
            .spray_x
            .ok_or_else(|| Failure::Fatal("spray valve opening not evaluated".into()))?;
        let cap = capacity(x, s.valve.full_area_m2(), drive, rho)?;
        Ok(Some((volume_flow - cap) / Scalar::constant(s.q_ref_m3_s)))
    }
    /// The stem's opening at `t`, kept for this evaluation's restriction
    /// row (and the block replay of it).
    pub(super) fn spray_opening_at(&mut self, t: f64) -> Result<(), Failure> {
        self.spray_x = match self.spray {
            None => None,
            Some(s) if s.closed => Some(0.),
            Some(s) => Some(s.stem.position(t)?),
        };
        Ok(())
    }
    /// Issue the stem a new fraction at `t` (a control frame). Opening a
    /// closed valve releases its lock here: the caller restarts (class R).
    /// A slope change needs only an exact stop (class S, S3-D4).
    pub fn issue_spray(&mut self, t: f64, target: f64) -> Result<(StemChange, Value), Failure> {
        let s = self
            .spray
            .as_mut()
            .ok_or_else(|| Failure::Fatal("no spray path is composed".into()))?;
        let before = s.stem;
        let change = s.stem.issue(t, target)?;
        if change == StemChange::Lock {
            s.closed = false;
        }
        Ok((
            change,
            json!({"owner":"spray valve","t_s":t,"target":target,"change":format!("{change:?}"),
                "stem_before":format!("{before:?}"),"closed":s.closed,"check_closed":s.check_closed}),
        ))
    }
    /// The stem's next instant after `t`: its arrival, R when it closes the
    /// valve (an owner time event), S otherwise.
    pub fn spray_next_instant(&self, t: f64) -> Option<(f64, StemChange)> {
        self.spray.and_then(|s| s.stem.next_instant(t))
    }
    /// The owner time event at `t`: the stem's arrival at 0 locks the valve
    /// path. Returns its receipt, or `None` when no spray event is due.
    pub fn spray_event(&mut self, t: f64) -> Result<Option<Value>, Failure> {
        let Some(s) = self.spray.as_mut() else {
            return Ok(None);
        };
        if s.closed || s.stem.arrival() != t || s.stem.position(t)? != 0. {
            return Ok(None);
        }
        s.closed = true;
        Ok(Some(
            json!({"owner":"spray valve","t_s":t,"event":"stem reached 0: valve path locked"}),
        ))
    }
    /// What the spray slot's root watches now.
    pub fn spray_check_watch(&self) -> Option<CheckRoot> {
        self.spray.map(|s| {
            if s.closed {
                CheckRoot::Disarmed
            } else if s.check_closed {
                CheckRoot::Release
            } else {
                CheckRoot::Contact
            }
        })
    }
    /// The spray slot's root: what it watches and its value at `y` — the
    /// valve liquid path's impulse (contact), its forward drive of the last
    /// value evaluation (release), or the disarmed constant.
    pub fn spray_check_root(&self, y: &[f64]) -> Option<(CheckRoot, f64)> {
        let s = self.spray?;
        let li = 2 * s.valve_face;
        Some(if s.closed {
            (CheckRoot::Disarmed, DISARMED)
        } else if s.check_closed {
            (CheckRoot::Release, self.face_drive[s.valve_face][0].value)
        } else {
            let i = self.face_layout[li].index;
            (CheckRoot::Contact, y[i] * self.scales[i])
        })
    }
    /// The inlet check's transaction at its located root (`direction` as
    /// IDAGetRootInfo): contact (falling impulse) closes it, release
    /// (rising forward drive) opens it; a crossing against the watched
    /// direction does not act and is reported. `None` when nothing crossed.
    pub fn spray_check_transaction(
        &mut self,
        t: f64,
        direction: i32,
    ) -> Result<Option<Value>, Failure> {
        let Some(s) = self.spray.as_mut() else {
            return Ok(None);
        };
        if direction == 0 {
            return Ok(None);
        }
        let watched = if s.closed {
            CheckRoot::Disarmed
        } else if s.check_closed {
            CheckRoot::Release
        } else {
            CheckRoot::Contact
        };
        let acted = match (watched, direction) {
            (CheckRoot::Contact, -1) => {
                s.check_closed = true;
                true
            }
            (CheckRoot::Release, 1) => {
                s.check_closed = false;
                true
            }
            (CheckRoot::Disarmed, _) => {
                return Err(Failure::Fatal(format!(
                    "the spray check's disarmed slot crossed at {t} s"
                )));
            }
            _ => false,
        };
        Ok(Some(
            json!({"owner":"spray inlet check","t_s":t,"root":format!("{watched:?}"),"direction":direction,
                "acted":acted,"check_closed":s.check_closed}),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capacity_is_the_restriction_law_with_its_direction() {
        let c = 0.001_158_453_602_592_212_7;
        let rho = Scalar::constant(745.148_293_249_185_4);
        // Full open at the sizing point: 20 kg/s.
        let q = capacity(1., c, Scalar::new(2e5, 1.), rho).unwrap();
        assert!((q.value * rho.value - 20.).abs() < 1e-12);
        // d/dΔp of x C sqrt(2Δp/ρ) = x C / (ρ g).
        let g = (2. * 2e5 / rho.value).sqrt();
        assert!((q.direction - c / (rho.value * g)).abs() < 1e-18);
        // Reverse differential gives reverse capacity; zero opening none.
        let r = capacity(0.5, c, Scalar::constant(-2e5), rho).unwrap();
        assert!((r.value + 0.5 * q.value).abs() < 1e-15);
        let z = capacity(0., c, Scalar::new(2e5, 3.), rho).unwrap();
        assert_eq!((z.value, z.direction), (0., 0.));
        assert!(capacity(0.5, c, Scalar::new(0., 1.), rho).is_err());
    }
}

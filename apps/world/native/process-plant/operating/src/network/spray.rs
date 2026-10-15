//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray path inside the network (IC-CTRL, S3): the valve
//! path's mechanical lock, the stem's held trajectory and its discrete
//! instants, and the valve's held-input form loss.
//!
//! The valve face's two phase paths are locked (`Π = 0`, algebraic, the
//! rest chart) while the stem rests closed; the lock changes only at a
//! transaction: opening from 0 releases it when the stem is issued a
//! fraction ([`Network::issue_spray`], class R), and closing to 0 sets it at
//! the stem's arrival, a known-time owner event ([`Network::spray_event`],
//! class R). Between them the open valve's section carries `K_v(x(t))`
//! from [`crate::control::spray_valve`]. The distributor face (the tips)
//! is never locked by the valve: a closed upstream supply does not close the
//! nozzle exits.
use super::{Failure, Network, Properties, SprayLayout};
use crate::control::spray_valve::StemChange;
use serde_json::{Value, json};

impl<P: Properties> Network<P> {
    /// The composed spray path, if any.
    pub fn spray(&self) -> Option<&SprayLayout> {
        self.spray.as_ref()
    }
    /// Whether phase path `li` (face-layout index) is locked: by L1, or as
    /// the closed spray valve's path.
    pub(super) fn path_locked(&self, li: usize) -> bool {
        self.unilateral_locked(li)
            || self
                .spray
                .is_some_and(|s| s.closed && self.face_layout[li].face == s.valve_face)
    }
    /// The valve section's form loss at `t`: the open stem's `K_v(x(t))`;
    /// zero while closed, when its path is locked and carries no flow.
    pub(super) fn spray_form_loss(&self, section: usize, t: f64) -> Result<Option<f64>, Failure> {
        let Some(s) = self.spray.filter(|s| s.valve_section == section) else {
            return Ok(None);
        };
        if s.closed {
            return Ok(Some(0.));
        }
        let x = s.stem.position(t)?;
        if x == 0. {
            // The release instant of an opening: the stem is still at 0 and
            // the path leaves its lock with `Π = 0`, so the restriction's
            // loss `K ρ v|v|/2` is its value at zero flow; every later
            // instant has its finite K. A free path reaching 0 while closing
            // would need the closing lock before its own instant: refuse.
            return if s.stem.closing() {
                Err(Failure::Fatal(format!(
                    "spray valve closing to 0 at {t} s with its path free: the closing lock transaction is not represented (IC-CTRL open item)"
                )))
            } else {
                Ok(Some(0.))
            };
        }
        Ok(Some(s.valve.form_loss(x)?))
    }
    /// The valve section's form loss of the last evaluation, for the block
    /// replay of section `section`.
    pub(super) fn spray_section_loss(&self, section: usize) -> Option<f64> {
        self.spray
            .filter(|s| s.valve_section == section)
            .and(self.spray_loss)
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
                "stem_before":format!("{before:?}"),"closed":s.closed}),
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
}

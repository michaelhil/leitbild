//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#installed-holding-chain
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! The physical holding chain `LD01.TRIP.HOLD`: ACT.A delivered support,
//! the series manual interrupt `LD01.TRIP.MANUAL`, the rearm state and the
//! functional two-out-of-three permissive of `LD01.TRIP.PERM.I1/I2/I3`.
//! A contact follows its own mechanism: a healthy de-energize-to-open
//! contact is closed only while its division is supplied and does not
//! request opening; a stuck contact keeps its failed state whatever is
//! requested. Holding voltage is lost the first instant the chain breaks;
//! `hold_rearmed` then stays false (no automatic rearm in S3).

/// A mechanically stuck contact's retained state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stuck {
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Contact {
    pub id: String,
    /// Its division's DC supply is delivered.
    pub supplied: bool,
    /// Its division requests it open (a latched trip demand).
    pub requested_open: bool,
    pub stuck: Option<Stuck>,
}
impl Contact {
    pub fn closed(&self) -> bool {
        match self.stuck {
            Some(Stuck::Closed) => true,
            Some(Stuck::Open) => false,
            None => self.supplied && !self.requested_open,
        }
    }
}

/// The holding chain; the selected permissive is two of three closed.
#[derive(Clone, Debug, PartialEq)]
pub struct Holding {
    pub contacts: [Contact; 3],
    pub manual_closed: bool,
    pub act_a: bool,
    pub rearmed: bool,
    /// The instant holding voltage was lost, once.
    pub lost_at: Option<f64>,
}
/// At least two actual closed permissive contacts.
const MAJORITY: usize = 2;
impl Holding {
    /// The balanced at-power fixture: rearmed, manual interrupt closed, ACT.A
    /// delivered, all three permissives supplied and closed.
    pub fn armed(ids: [&str; 3]) -> Self {
        Self {
            contacts: ids.map(|id| Contact {
                id: id.into(),
                supplied: true,
                requested_open: false,
                stuck: None,
            }),
            manual_closed: true,
            act_a: true,
            rearmed: true,
            lost_at: None,
        }
    }
    pub fn closed_contacts(&self) -> usize {
        self.contacts.iter().filter(|c| c.closed()).count()
    }
    pub fn voltage_available(&self) -> bool {
        self.act_a && self.manual_closed && self.rearmed && self.closed_contacts() >= MAJORITY
    }
    /// After the contacts' requests and supplies are updated at `t`: the
    /// instant holding voltage is lost, if it is lost now.
    pub fn update(&mut self, t: f64) -> Option<f64> {
        if self.lost_at.is_none() && !self.voltage_available() {
            self.lost_at = Some(t);
            self.rearmed = false;
            return Some(t);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed() -> Holding {
        Holding::armed([
            "LD01.TRIP.PERM.I1",
            "LD01.TRIP.PERM.I2",
            "LD01.TRIP.PERM.I3",
        ])
    }

    #[test]
    fn two_of_three_contacts_hold_and_the_second_opening_releases() {
        let mut h = armed();
        assert!(h.voltage_available());
        h.contacts[0].requested_open = true;
        assert_eq!(h.update(1.), None, "one opened contact keeps the majority");
        h.contacts[2].requested_open = true;
        assert_eq!(h.update(1.1), Some(1.1));
        assert!(!h.rearmed);
        // Once lost, nothing re-energizes it: closing contacts again does
        // not rearm, and the loss is reported once.
        h.contacts[0].requested_open = false;
        h.contacts[2].requested_open = false;
        assert_eq!(h.update(1.2), None);
        assert!(!h.voltage_available());
    }

    #[test]
    fn one_unavailable_division_leaves_both_remaining_contacts_required() {
        let mut h = armed();
        h.contacts[1].supplied = false;
        assert_eq!(h.update(1.), None, "degraded but holding");
        h.contacts[0].requested_open = true;
        assert_eq!(h.update(2.), Some(2.), "one remaining trip now releases");
        let mut h = armed();
        h.contacts[0].supplied = false;
        h.contacts[1].supplied = false;
        assert_eq!(
            h.update(3.),
            Some(3.),
            "two lost divisions release without a trip"
        );
    }

    #[test]
    fn stuck_closed_contacts_defeat_the_majority_path_only_if_two() {
        let mut h = armed();
        h.contacts[0].stuck = Some(Stuck::Closed);
        for c in &mut h.contacts {
            c.requested_open = true;
        }
        assert_eq!(h.update(1.), Some(1.), "the two healthy contacts interrupt");
        let mut h = armed();
        h.contacts[0].stuck = Some(Stuck::Closed);
        h.contacts[1].stuck = Some(Stuck::Closed);
        for c in &mut h.contacts {
            c.requested_open = true;
        }
        assert_eq!(h.update(1.), None, "failed automatic trip path");
        h.manual_closed = false;
        assert_eq!(h.update(2.), Some(2.), "the manual interrupt still opens");
        let mut h = armed();
        h.act_a = false;
        assert_eq!(h.update(4.), Some(4.), "ACT.A loss");
    }
}

//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#l1-unilateral-absent-donor-law-implemented-at-s3
//! The network's L1 root functions and their ledger (lead decisions
//! S3-D-P2 and S3-D1 #1: a root-located event is class R).
//!
//! Root functions, declared from the lock table at each restart:
//! - a one-sided locked path: its release root `orientation × F` (Pa),
//!   located rising through zero (the drive reverses toward the holding
//!   end);
//! - a free path: its contact root, the phase-k mass (kg) of the end it
//!   draws from by the sign of its flow `Q = Pi/I` (`Network::path_flow_sign`;
//!   at `Pi = 0` the larger end mass, so a path at rest has no contact),
//!   located falling through zero;
//! - a locked path with neither end holding has no root: only a birth
//!   releases it, and a birth is the phase-mode owner's transaction.
//!
//! Contact values read only the coordinate view (impulses and stocks);
//! release values read the drives of the network's last value evaluation
//! of that view ([`release_roots`] says whether one is needed).
//!
//! The ledger counts every located root and every lock change by path,
//! class and cause, and the energy paid. The law has no hysteresis and none
//! is added: a path locked again after a release is chattering, listed
//! with its intervals, and raised to the lead as a DR-P1 (design §4).
use super::{
    Failure, Network, Properties,
    unilateral::{Fired, Lock, Transaction},
};
use serde::Serialize;
use std::collections::BTreeMap;

/// One declared L1 root function, by face-layout path index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Root {
    Release(usize),
    Contact(usize),
}
impl Root {
    pub fn path(self) -> usize {
        match self {
            Self::Release(p) | Self::Contact(p) => p,
        }
    }
    /// The located direction (stock `IDASetRootDirection` convention):
    /// release rising, contact falling.
    pub fn direction(self) -> i32 {
        match self {
            Self::Release(_) => 1,
            Self::Contact(_) => -1,
        }
    }
    fn fired(self) -> Fired {
        match self {
            Self::Release(_) => Fired::Release,
            Self::Contact(_) => Fired::Contact,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Release(_) => "release",
            Self::Contact(_) => "contact",
        }
    }
}

/// Whether any of `roots` reads a drive, so the caller must evaluate the
/// network at the root function's state first.
pub fn release_roots(roots: &[Root]) -> bool {
    roots.iter().any(|r| matches!(r, Root::Release(_)))
}

/// The crossings stock IDA reported for `roots`, split into located roots
/// (the declared direction) and opposite crossings, which are counted and
/// do not act.
pub fn located(roots: &[Root], directions: &[i32]) -> (Vec<(usize, Fired)>, Vec<Root>) {
    let mut fired = Vec::new();
    let mut opposite = Vec::new();
    for (r, d) in roots.iter().zip(directions) {
        if *d == 0 {
            continue;
        }
        if *d == r.direction() {
            fired.push((r.path(), r.fired()));
        } else {
            opposite.push(*r);
        }
    }
    (fired, opposite)
}

impl<P: Properties> Network<P> {
    /// The L1 root functions of the current lock table (none when L1 is
    /// inactive).
    pub fn unilateral_roots(&self) -> Vec<Root> {
        let Some(locks) = self.unilateral() else {
            return Vec::new();
        };
        locks
            .paths
            .iter()
            .enumerate()
            .filter_map(|(li, lock)| match lock {
                Lock::Free => Some(Root::Contact(li)),
                Lock::Locked(h) => h.orientation().map(|_| Root::Release(li)),
            })
            .collect()
    }
    /// The values of `roots` in the coordinate view `y` (the network's own
    /// coordinates, or a phase-mode owner's view of them): release
    /// `orientation × F` in Pa from the last value evaluation of `y`,
    /// contact the drawing end's phase mass in kg from `y` alone.
    pub fn unilateral_root_values(
        &self,
        y: &[f64],
        roots: &[Root],
        out: &mut [f64],
    ) -> Result<(), Failure> {
        let locks = self
            .unilateral()
            .ok_or_else(|| Failure::Fatal("L1 is not active".into()))?;
        if out.len() != roots.len() {
            return Err(Failure::Fatal(format!(
                "{} L1 root values for {} roots",
                out.len(),
                roots.len()
            )));
        }
        for (o, root) in out.iter_mut().zip(roots) {
            let li = root.path();
            let l = self.face_layout[li];
            *o = match (root, locks.paths[li]) {
                (Root::Release(_), Lock::Locked(h)) => {
                    let orientation = h.orientation().ok_or_else(|| {
                        Failure::Fatal(format!("release root on path {li} with no one-sided lock"))
                    })?;
                    orientation * self.face_drive[l.face][l.phase].value
                }
                (Root::Contact(_), Lock::Free) => {
                    let (from, to) = self.endpoints[l.face];
                    let flow = self.path_flow_sign(y, li);
                    let m = |c| self.end_mass(y, c, l.phase);
                    if flow > 0. {
                        m(from)
                    } else if flow < 0. {
                        m(to)
                    } else {
                        m(from).max(m(to))
                    }
                }
                _ => {
                    return Err(Failure::Fatal(format!(
                        "root {root:?} was not declared for path {li}'s lock {:?}",
                        locks.paths[li]
                    )));
                }
            };
        }
        Ok(())
    }
}

/// Donor flips of the free phase paths between accepted states, an
/// observation (class O): E2b keeps the exact donor by the flow's sign and
/// selects no donor law, and C3 counts its flips (S3 declaration r2, C3's
/// cost line; R3 for the rod passages). A path's donor is the end its flow
/// draws from, by the sign of its flow `Q = Pi/I`
/// ([`Network::path_flow_sign`]). A flip is a change between the two
/// nonzero signs, counted once
/// however many accepted states sit exactly at rest in between.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DonorFlips {
    /// Per face-layout path: the last nonzero sign, 0 before any.
    last: Vec<i8>,
    /// Per face-layout path: flips counted.
    pub flips: Vec<usize>,
    /// `(time, path)` of every flip, in order.
    pub events: Vec<(f64, usize)>,
    pub observations: usize,
}
impl DonorFlips {
    /// Observe the accepted state `y` at `t`. Locked paths (L1) carry no
    /// donor and are skipped.
    pub fn observe<P: Properties>(&mut self, network: &Network<P>, t: f64, y: &[f64]) {
        let impulses = network
            .face_layout
            .iter()
            .enumerate()
            .filter(|(li, _)| !network.unilateral_locked(*li))
            .map(|(li, _)| (li, network.path_flow_sign(y, li)));
        self.record(network.face_layout.len(), t, impulses);
    }
    /// One accepted state's `(path, impulse)` pairs among `paths` paths.
    pub fn record(&mut self, paths: usize, t: f64, impulses: impl Iterator<Item = (usize, f64)>) {
        if self.last.len() != paths {
            self.last = vec![0; paths];
            self.flips = vec![0; paths];
        }
        self.observations += 1;
        for (li, pi) in impulses {
            let sign: i8 = if pi > 0. {
                1
            } else if pi < 0. {
                -1
            } else {
                continue;
            };
            if self.last[li] != 0 && self.last[li] != sign {
                self.flips[li] += 1;
                self.events.push((t, li));
            }
            self.last[li] = sign;
        }
    }
    /// Flips counted over all paths.
    pub fn total(&self) -> usize {
        self.flips.iter().sum()
    }
}

/// One path's history in the ledger.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct PathLedger {
    pub locks: usize,
    pub releases: usize,
    pub energy_paid_j: f64,
    /// `(time, locked after)` of every change.
    pub changes: Vec<(f64, bool)>,
}

/// A path locked again after a release: a chattering candidate (DR-P1).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Chatter {
    pub path: usize,
    pub face: usize,
    pub phase: usize,
    pub relocks: usize,
    pub shortest_interval_s: f64,
}

/// Counts of the network's L1 events (class R) over a run.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Ledger {
    pub transactions: usize,
    /// Located roots by kind (`release`, `contact`).
    pub located: BTreeMap<&'static str, usize>,
    /// Crossings against the declared direction, by kind; they do not act.
    pub opposite: BTreeMap<&'static str, usize>,
    /// Lock changes by cause.
    pub causes: BTreeMap<String, usize>,
    pub energy_paid_j: f64,
    /// Per face-layout path; paths that never changed stay empty.
    pub paths: BTreeMap<usize, PathLedger>,
}
impl Ledger {
    /// Record one transaction at `t`, with the roots that located it.
    pub fn record(
        &mut self,
        t: f64,
        roots: &[Root],
        fired: &[(usize, Fired)],
        opposite: &[Root],
        transaction: &Transaction,
    ) {
        self.transactions += 1;
        for (path, f) in fired {
            let root = roots
                .iter()
                .find(|r| r.path() == *path && r.fired() == *f)
                .copied();
            if let Some(r) = root {
                *self.located.entry(r.name()).or_default() += 1;
            }
        }
        for r in opposite {
            *self.opposite.entry(r.name()).or_default() += 1;
        }
        for c in &transaction.changes {
            *self.causes.entry(format!("{:?}", c.cause)).or_default() += 1;
            let p = self.paths.entry(c.path).or_default();
            let locked = matches!(c.after, Lock::Locked(_));
            if locked {
                p.locks += 1;
            } else {
                p.releases += 1;
            }
            if let Some((_, _, e)) = c.payment {
                p.energy_paid_j += e;
            }
            p.changes.push((t, locked));
        }
        self.energy_paid_j += transaction.energy_paid_j;
    }
    /// Paths locked again after a release, with the shortest interval
    /// between successive changes: every one is a DR-P1 for the lead.
    pub fn chattering(&self, face_phase: impl Fn(usize) -> (usize, usize)) -> Vec<Chatter> {
        self.paths
            .iter()
            .filter_map(|(path, p)| {
                let relocks = p.changes.windows(2).filter(|w| !w[0].1 && w[1].1).count();
                (relocks > 0).then(|| {
                    let (face, phase) = face_phase(*path);
                    Chatter {
                        path: *path,
                        face,
                        phase,
                        relocks,
                        shortest_interval_s: p
                            .changes
                            .windows(2)
                            .map(|w| w[1].0 - w[0].0)
                            .fold(f64::INFINITY, f64::min),
                    }
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::unilateral::{Cause, Change, Holding};

    #[test]
    fn located_roots_keep_the_declared_direction_and_count_the_opposite() {
        let roots = [Root::Release(3), Root::Contact(4), Root::Contact(9)];
        let (fired, opposite) = located(&roots, &[1, 1, -1]);
        assert_eq!(fired, vec![(3, Fired::Release), (9, Fired::Contact)]);
        assert_eq!(opposite, vec![Root::Contact(4)]);
        let (fired, opposite) = located(&roots, &[0, 0, 0]);
        assert!(fired.is_empty() && opposite.is_empty());
    }

    fn change(path: usize, after: Lock, cause: Cause) -> Change {
        Change {
            path,
            face: path / 2,
            phase: path % 2,
            before: Lock::Free,
            after,
            cause,
            drive_pa: 0.,
            impulse_pa_s: 0.,
            volume_flow_m3_s: Some(0.),
            mass_flow_kg_s: None,
            payment: None,
        }
    }

    #[test]
    fn a_path_locked_again_after_a_release_is_listed_as_chattering() {
        let mut ledger = Ledger::default();
        let lock = Lock::Locked(Holding::From);
        let steps = [
            (1.0, lock, Cause::AtRest),
            (2.0, Lock::Free, Cause::DriveRoot),
            (2.5, lock, Cause::ContactRoot),
            (2.6, Lock::Free, Cause::DriveRoot),
        ];
        for (t, after, cause) in steps {
            let tx = Transaction {
                changes: vec![change(65, after, cause)],
                energy_paid_j: 0.,
            };
            ledger.record(t, &[], &[], &[], &tx);
        }
        let chatter = ledger.chattering(|p| (p / 2, p % 2));
        assert_eq!(chatter.len(), 1);
        assert_eq!((chatter[0].face, chatter[0].phase), (32, 1));
        assert_eq!(chatter[0].relocks, 1);
        assert!((chatter[0].shortest_interval_s - 0.1).abs() < 1e-12);
        assert_eq!(ledger.paths[&65].locks, 2);
        assert_eq!(ledger.paths[&65].releases, 2);
        assert_eq!(ledger.causes["DriveRoot"], 2);
    }

    #[test]
    fn a_donor_flip_is_a_change_between_nonzero_signs_counted_once_through_rest() {
        let mut d = DonorFlips::default();
        for (t, signs) in [
            (0., [1., 0.]),
            (1., [0., 0.]),
            (2., [-1., 2.]),
            (3., [-2., -1.]),
            (4., [3., -1.]),
        ] {
            d.record(2, t, signs.into_iter().enumerate());
        }
        assert_eq!(d.flips, vec![2, 1]);
        assert_eq!(d.events, vec![(2., 0), (3., 1), (4., 0)]);
        assert_eq!((d.total(), d.observations), (3, 5));
    }

    #[test]
    fn a_single_lock_and_release_is_not_chattering() {
        let mut ledger = Ledger::default();
        for (t, after) in [(1., Lock::Locked(Holding::To)), (3., Lock::Free)] {
            let tx = Transaction {
                changes: vec![change(7, after, Cause::DriveRoot)],
                energy_paid_j: 0.,
            };
            ledger.record(t, &[], &[], &[], &tx);
        }
        assert!(ledger.chattering(|p| (p / 2, p % 2)).is_empty());
    }
}

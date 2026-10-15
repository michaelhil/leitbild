//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! The presence-keyed cache of the joined block Jacobian's structure (lead
//! decision S3-D-P3).
//!
//! The joined pattern ([`super::blocks::joined_pattern`]) is exact: the
//! fluid–solid port chains read a donor end's vapor coordinates only where
//! that end holds vapor. A phase birth or exhaustion therefore changes the
//! pattern, while stock IDA re-runs KLU's symbolic analysis at every
//! `IDAReInit` anyway. So the structure is compiled once per vapor-presence
//! key and kept:
//! - [`VaporPresence`] is the phase-mode owner's declaration over the
//!   regular cells (a newborn phase is present before its first
//!   evaluation shows any vapor mass), or the last value evaluation's;
//! - [`PresenceKey`] keeps only the cells whose presence the joined pattern
//!   reads ([`pattern_cells`]), so a birth elsewhere reuses the structure;
//! - [`PatternCache`] hands a structure out by key and takes it back; it
//!   compiles on a miss with the declared presence and never shares one
//!   structure between two users.
use super::{blocks::JoinedJacobian, operator::Joined};
use crate::{
    network::{Failure, Network, Properties, unilateral::Presence},
    thermal::WaterProperties,
};
use serde::Serialize;
use std::{collections::BTreeMap, time::Instant};

/// Vapor presence of every regular network cell, in network order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VaporPresence {
    pub cells: Vec<bool>,
}
impl VaporPresence {
    /// The vapor presence of the network's last value evaluation: the rule
    /// the joined pattern applied before declared presence existed.
    pub fn evaluated<P: Properties>(network: &Network<P>) -> Self {
        Self {
            cells: (0..network.pzr.cell)
                .map(|c| network.cell(c).phase[1].is_some())
                .collect(),
        }
    }
    /// The regular cells' vapor flags of a full presence declaration (the
    /// stratified cell's port, last in it, is not a regular cell).
    pub fn of<P: Properties>(network: &Network<P>, presence: &Presence) -> Self {
        Self {
            cells: (0..network.pzr.cell)
                .map(|c| presence.cells.get(c).is_some_and(|p| p[1]))
                .collect(),
        }
    }
    /// No regular cell holds vapor (S1, S2).
    pub fn liquid<P: Properties>(network: &Network<P>) -> Self {
        Self {
            cells: vec![false; network.pzr.cell],
        }
    }
    /// Whether `cell` holds vapor; the stratified cell's ports carry no
    /// donor vapor read (its block is read whole).
    pub fn holds(&self, cell: usize) -> bool {
        self.cells.get(cell).copied().unwrap_or(false)
    }
}

/// The vapor-holding cells among those the joined pattern reads presence
/// from, ascending: the cache key.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct PresenceKey(pub Vec<usize>);

/// The regular cells whose vapor presence the joined pattern reads: every
/// end of a face wetting a wall cell (clad halves, passive contacts and SG
/// segments), as `joined_pattern`'s donor reads. The stratified cell is
/// read whole and is not listed.
pub fn pattern_cells<P: Properties + WaterProperties>(joined: &Joined<P>) -> Vec<usize> {
    let network = &joined.network;
    let incidence = joined.solids().incidence();
    let walls = incidence
        .halves
        .iter()
        .flat_map(|(_, cells)| cells.iter().copied())
        .chain(incidence.passive.iter().map(|(_, c)| *c))
        .chain(incidence.segments.iter().map(|(c, _)| *c));
    let mut cells: Vec<usize> = walls
        .flat_map(|c| network.liquid_flux_reads(c))
        .flat_map(|(_, _, ends)| ends)
        .filter(|m| *m < network.pzr.cell)
        .collect();
    cells.sort_unstable();
    cells.dedup();
    cells
}

/// Hits, misses and compile wall time of a cache.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct CacheStats {
    pub hits: usize,
    pub misses: usize,
    pub compile_wall_s: f64,
}

/// One structure per presence key, handed out and taken back.
pub struct PatternCache<T> {
    cells: Vec<usize>,
    /// `None` while the key's structure is checked out.
    entries: BTreeMap<PresenceKey, Option<T>>,
    pub stats: CacheStats,
}
impl<T> PatternCache<T> {
    /// A cache keyed by the presence of `cells` (see [`pattern_cells`]).
    pub fn new(mut cells: Vec<usize>) -> Self {
        cells.sort_unstable();
        cells.dedup();
        Self {
            cells,
            entries: BTreeMap::new(),
            stats: CacheStats::default(),
        }
    }
    pub fn cells(&self) -> &[usize] {
        &self.cells
    }
    /// The key of `presence`: its vapor-holding cells among the read ones.
    pub fn key(&self, presence: &VaporPresence) -> PresenceKey {
        PresenceKey(
            self.cells
                .iter()
                .copied()
                .filter(|c| presence.holds(*c))
                .collect(),
        )
    }
    /// Keys compiled so far.
    pub fn keys(&self) -> usize {
        self.entries.len()
    }
    /// The structure of `key`: the kept one, or `compile`'s on a miss. A
    /// key whose structure is already checked out refuses.
    pub fn check_out(
        &mut self,
        key: &PresenceKey,
        compile: impl FnOnce() -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        match self.entries.get_mut(key) {
            Some(slot) => {
                let kept = slot.take().ok_or_else(|| {
                    Failure::Fatal(format!(
                        "the structure of presence key {key:?} is already checked out"
                    ))
                })?;
                self.stats.hits += 1;
                Ok(kept)
            }
            None => {
                let started = Instant::now();
                let compiled = compile()?;
                self.stats.compile_wall_s += started.elapsed().as_secs_f64();
                self.stats.misses += 1;
                self.entries.insert(key.clone(), None);
                Ok(compiled)
            }
        }
    }
    /// Take back the structure of `key`, which must be checked out.
    pub fn check_in(&mut self, key: &PresenceKey, structure: T) -> Result<(), Failure> {
        match self.entries.get_mut(key) {
            Some(slot @ None) => {
                *slot = Some(structure);
                Ok(())
            }
            Some(Some(_)) => Err(Failure::Fatal(format!(
                "presence key {key:?} already holds its structure"
            ))),
            None => Err(Failure::Fatal(format!(
                "presence key {key:?} was never checked out"
            ))),
        }
    }
}

/// The joined operator's cache: compile at the value state `(t, y)` with
/// the declared presence on a miss ([`JoinedJacobian::compile_for`]).
pub fn joined_structure<P: Properties + WaterProperties>(
    cache: &mut PatternCache<JoinedJacobian>,
    joined: &mut Joined<P>,
    t: f64,
    y: &[f64],
    presence: &VaporPresence,
) -> Result<(PresenceKey, JoinedJacobian), Failure> {
    let key = cache.key(presence);
    let structure = cache.check_out(&key, || {
        JoinedJacobian::compile_for(joined, t, y, Some(presence))
    })?;
    Ok((key, structure))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(n: usize, vapor: &[usize]) -> VaporPresence {
        VaporPresence {
            cells: (0..n).map(|c| vapor.contains(&c)).collect(),
        }
    }

    #[test]
    fn the_key_keeps_only_the_cells_the_pattern_reads() {
        let cache: PatternCache<u32> = PatternCache::new(vec![5, 2, 9, 2]);
        assert_eq!(cache.cells(), &[2, 5, 9]);
        assert_eq!(cache.key(&presence(12, &[])), PresenceKey(vec![]));
        // A birth outside the read cells keeps the key.
        assert_eq!(cache.key(&presence(12, &[0, 3, 11])), PresenceKey(vec![]));
        assert_eq!(
            cache.key(&presence(12, &[9, 0, 2])),
            PresenceKey(vec![2, 9])
        );
        // A presence shorter than the network reads absent cells as liquid.
        assert_eq!(cache.key(&presence(6, &[5])), PresenceKey(vec![5]));
    }

    #[test]
    fn a_key_compiles_once_and_is_handed_out_to_one_user_at_a_time() {
        let mut cache: PatternCache<u32> = PatternCache::new(vec![1, 2]);
        let a = cache.key(&presence(4, &[]));
        let b = cache.key(&presence(4, &[2]));
        let mut compiles = 0;
        let s = cache
            .check_out(&a, || {
                compiles += 1;
                Ok(10)
            })
            .unwrap();
        assert_eq!(s, 10);
        // Checked out: a second user refuses, never a second compile.
        assert!(cache.check_out(&a, || Ok(99)).is_err());
        cache.check_in(&a, s).unwrap();
        assert!(cache.check_in(&a, 10).is_err(), "already held");
        let again = cache
            .check_out(&a, || panic!("kept, not compiled"))
            .unwrap();
        assert_eq!(again, 10);
        let other = cache.check_out(&b, || Ok(20)).unwrap();
        assert_eq!(other, 20);
        cache.check_in(&a, again).unwrap();
        cache.check_in(&b, other).unwrap();
        assert!(
            cache.check_in(&PresenceKey(vec![1]), 30).is_err(),
            "never checked out"
        );
        assert_eq!(compiles, 1);
        assert_eq!(cache.keys(), 2);
        assert_eq!((cache.stats.hits, cache.stats.misses), (1, 2));
    }

    #[test]
    fn a_failed_compile_keeps_no_key() {
        let mut cache: PatternCache<u32> = PatternCache::new(vec![0]);
        let k = cache.key(&presence(1, &[0]));
        assert!(
            cache
                .check_out(&k, || Err(Failure::Fatal("x".into())))
                .is_err()
        );
        assert_eq!(cache.keys(), 0);
        assert_eq!(cache.check_out(&k, || Ok(1)).unwrap(), 1);
    }
}

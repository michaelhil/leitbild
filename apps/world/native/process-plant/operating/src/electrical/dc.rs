//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/dc-storage.md#installed-groups-and-initial-sizing
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/dc-storage.md#charging-connections-and-common-causes
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#electrical-and-supporting-observations
//! PROC T5 (lane ELEC, lead 1 Nov): the five DC supply groups (`LD01.DC.I1`
//! to `I3`, `ACT.A`, `ACT.B`), one finite [`Supply`] owner each, beside the
//! AC routing. A discrete, event-driven owner with no coordinates: energy
//! is piecewise linear in time between events.
//!
//! - **Charger.** Each group's charger follows its selected AC bus
//!   (`ld01-dc-charging`): the caller hands the buses' routed availability
//!   at every instant where it may change ([`Groups::follow`]); a change is
//!   a transition at that instant. I3's input selector is a local manual
//!   ideal operation, break before make at one event
//!   ([`Groups::select_charger`]).
//! - **Distribution.** Each group's OPEN, RESET and CLOSE are the page's
//!   local manual ideal operations ([`Groups::command`]), with the
//!   provider's retained causes and guards.
//! - **Storage boundaries.** The usable-energy empty and full instants are
//!   this owner's time events, each accepted at its exact time before any
//!   later transition. **Report-only in LD-01 1.0** (lead ruling 2): no
//!   consumer reads the delivered DC support, so a boundary changes only
//!   the reports and needs no integrator stop.
//! - **Loads.** Each group's request is its reference continuous duty, an
//!   aggregate (no itemized consumer is composed).
use super::dc_supply::{self, Cause, Command, Config, Paths, Supply};
use crate::joined::block::snapshot_bits;
use std::collections::BTreeSet;

/// One group's composition, from its strict blocks.
#[derive(Clone, Debug, PartialEq)]
pub struct GroupParameters {
    pub id: String,
    pub config: Config,
    /// The reference continuous duty, the group's aggregate request (W).
    pub requested_w: f64,
    pub normal_bus: String,
    /// I3's manual alternate charging bus.
    pub alternate_bus: Option<String>,
}

#[derive(Clone, Debug)]
struct Group {
    parameters: GroupParameters,
    supply: Supply,
    /// The charger's selected AC input bus.
    selected: String,
}

/// One recorded change (a receipt, not state).
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub time: f64,
    pub what: String,
}

#[derive(Clone, Debug)]
pub struct Groups {
    groups: Vec<Group>,
    pub records: Vec<Record>,
}

/// One group's reportable state at a time, for the I&C channels and the
/// unit host: actual output availability, charger delivery, battery path
/// and present requested duty (the observations page), with the usable
/// energy and the time to its limit as labelled engineering estimates.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Report {
    pub group: String,
    /// The distribution device is closed and delivers the request.
    pub output_available: bool,
    pub charger_bus: String,
    /// The charger delivers DC power (its selected AC bus is live).
    pub charger_delivering: bool,
    pub battery_available: bool,
    /// Engineering estimate: usable stored energy (J).
    pub energy_j: f64,
    pub requested_w: f64,
    pub delivered_w: f64,
    pub output_limit_w: f64,
    /// The retained cause of an opening (`Overload`, `InsufficientSupply`,
    /// `OutputFailure`).
    pub cause: Option<&'static str>,
    /// Engineering estimate: the time (s) at which the usable energy
    /// reaches its limit at the present duty, only while discharging.
    pub depletion_s: Option<f64>,
}

/// One group's retained state, exact (real numbers as IEEE bits).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupState {
    id: String,
    selected: String,
    #[serde(with = "snapshot_bits")]
    time_s: f64,
    #[serde(with = "snapshot_bits")]
    energy_j: f64,
    output_closed: bool,
    cause: Option<String>,
    #[serde(with = "snapshot_bits")]
    source_j: f64,
    #[serde(with = "snapshot_bits")]
    delivered_j: f64,
    #[serde(with = "snapshot_bits")]
    loss_j: f64,
    charger_available: bool,
    battery_available: bool,
    output_healthy: bool,
    #[serde(with = "snapshot_bits")]
    requested_w: f64,
    #[serde(with = "snapshot_bits")]
    original_energy_j: f64,
}

/// The groups' discrete state: each group's energy, accounts, paths,
/// contact, cause and charger selection. The records stay with the owner.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    groups: Vec<GroupState>,
}

fn cause_name(c: Cause) -> &'static str {
    match c {
        Cause::Overload => "Overload",
        Cause::InsufficientSupply => "InsufficientSupply",
        Cause::OutputFailure => "OutputFailure",
    }
}
fn cause_of(name: &str) -> Result<Cause, String> {
    match name {
        "Overload" => Ok(Cause::Overload),
        "InsufficientSupply" => Ok(Cause::InsufficientSupply),
        "OutputFailure" => Ok(Cause::OutputFailure),
        other => Err(format!("unknown DC cause {other}")),
    }
}

/// The first storage event strictly before `t` (outside the provider's
/// arithmetic coincidence, which `Supply::at` takes as `t` itself).
fn due_before(s: &Supply, t: f64) -> Result<Option<f64>, String> {
    Ok(s.next_storage_event_s()?
        .filter(|at| *at < t && !dc_supply::coincident(*at, t)))
}

/// Accept every storage event of `s` strictly before `t`, each at its own
/// time with the paths and request unchanged. Between two transitions the
/// rates are constant, so at most two events occur: the usable energy
/// empty (the output opens, an isolated charger then charges) and then
/// full.
fn accept_before(s: &mut Supply, t: f64) -> Result<Vec<(f64, &'static str)>, String> {
    let mut accepted = Vec::new();
    for _ in 0..2 {
        if let Some(at) = due_before(s, t)? {
            let what = if s.rates().energy_w > 0. {
                "usable energy full"
            } else {
                "usable energy empty"
            };
            s.transition(at, s.paths(), s.requested_w(), &[])?;
            accepted.push((at, what));
        }
    }
    if due_before(s, t)?.is_some() {
        return Err("more than two DC storage events in one interval".into());
    }
    Ok(accepted)
}

impl Groups {
    /// The normal alignment at `t0`: every group at its initial usable
    /// energy (the table's), its output closed on its reference duty, its
    /// charger on its normal bus, battery and output paths healthy.
    /// `live(bus)` is the bus's routed availability (`None`: no such bus).
    pub fn prepared(
        parameters: Vec<GroupParameters>,
        t0: f64,
        live: &dyn Fn(&str) -> Option<bool>,
    ) -> Result<Self, String> {
        let mut ids = BTreeSet::new();
        let mut groups = Vec::with_capacity(parameters.len());
        for p in parameters {
            if !ids.insert(p.id.clone()) {
                return Err(format!("DC group {} composed twice", p.id));
            }
            for bus in std::iter::once(&p.normal_bus).chain(&p.alternate_bus) {
                live(bus).ok_or_else(|| format!("DC group {}: unknown bus {bus}", p.id))?;
            }
            let config = p.config.validate()?;
            let paths = Paths {
                charger_available: live(&p.normal_bus).unwrap_or(false),
                battery_available: true,
                output_healthy: true,
            };
            let supply = Supply::restore(dc_supply::Snapshot {
                config,
                state: dc_supply::State {
                    time_s: t0,
                    energy_j: config.capacity_j,
                    output_closed: true,
                    cause: None,
                    source_j: 0.,
                    delivered_j: 0.,
                    loss_j: 0.,
                },
                paths,
                requested_w: p.requested_w,
                original_energy_j: config.capacity_j,
            })
            .map_err(|e| format!("DC group {}: {e}", p.id))?;
            groups.push(Group {
                selected: p.normal_bus.clone(),
                parameters: p,
                supply,
            });
        }
        if groups.is_empty() {
            return Err("no DC group composed".into());
        }
        Ok(Self {
            groups,
            records: Vec::new(),
        })
    }
    fn group(&mut self, id: &str) -> Result<&mut Group, String> {
        self.groups
            .iter_mut()
            .find(|g| g.parameters.id == id)
            .ok_or_else(|| format!("no DC group {id}"))
    }
    fn record(records: &mut Vec<Record>, id: &str, accepted: Vec<(f64, &'static str)>) {
        records.extend(accepted.into_iter().map(|(time, what)| Record {
            time,
            what: format!("{id} {what}"),
        }));
    }
    /// Each charger follows its selected bus at `t` (an instant where the
    /// routed availability may change): a group whose charger path changes
    /// transitions there; the others are untouched.
    pub fn follow(&mut self, t: f64, live: &dyn Fn(&str) -> Option<bool>) -> Result<(), String> {
        for g in &mut self.groups {
            let charger = live(&g.selected).ok_or_else(|| format!("unknown bus {}", g.selected))?;
            let paths = g.supply.paths();
            if paths.charger_available == charger {
                continue;
            }
            let accepted = accept_before(&mut g.supply, t)?;
            Self::record(&mut self.records, &g.parameters.id, accepted);
            g.supply.transition(
                t,
                Paths {
                    charger_available: charger,
                    ..paths
                },
                g.supply.requested_w(),
                &[],
            )?;
            self.records.push(Record {
                time: t,
                what: format!(
                    "{} charger {} ({})",
                    g.parameters.id,
                    if charger { "restored" } else { "lost" },
                    g.selected
                ),
            });
        }
        Ok(())
    }
    /// The local manual OPEN, RESET or CLOSE of `id`'s distribution at
    /// `t` (`false`: refused by the provider's guards, recorded).
    pub fn command(&mut self, t: f64, id: &str, command: Command) -> Result<bool, String> {
        let g = self.group(id)?;
        let accepted = accept_before(&mut g.supply, t)?;
        let done = g
            .supply
            .transition(t, g.supply.paths(), g.supply.requested_w(), &[command])?[0];
        Self::record(&mut self.records, id, accepted);
        self.records.push(Record {
            time: t,
            what: format!(
                "{id} {command:?}: {}",
                if done { "accepted" } else { "refused" }
            ),
        });
        Ok(done)
    }
    /// I3's local manual charger input selection at `t`: the old path
    /// disconnects and the new one connects at this one event, never
    /// joining the buses (`false`: already selected, recorded). Refused
    /// for a group without an alternate or a bus it cannot select.
    pub fn select_charger(
        &mut self,
        t: f64,
        id: &str,
        bus: &str,
        live: &dyn Fn(&str) -> Option<bool>,
    ) -> Result<bool, String> {
        let g = self.group(id)?;
        let p = &g.parameters;
        if p.alternate_bus.is_none() {
            return Err(format!("{id} has no selectable charger input"));
        }
        if bus != p.normal_bus && Some(bus) != p.alternate_bus.as_deref() {
            return Err(format!("{id} cannot charge from {bus}"));
        }
        let done = bus != g.selected;
        let mut accepted = Vec::new();
        if done {
            accepted = accept_before(&mut g.supply, t)?;
            let charger = live(bus).ok_or_else(|| format!("unknown bus {bus}"))?;
            let paths = Paths {
                charger_available: charger,
                ..g.supply.paths()
            };
            g.supply.transition(t, paths, g.supply.requested_w(), &[])?;
            g.selected = bus.into();
        }
        Self::record(&mut self.records, id, accepted);
        self.records.push(Record {
            time: t,
            what: format!(
                "{id} charger input {bus}: {}",
                if done { "selected" } else { "already selected" }
            ),
        });
        Ok(done)
    }
    /// Every group's report at `t` (at or after each group's last
    /// transition), with the storage events before `t` taken on a copy.
    pub fn reports(&self, t: f64) -> Result<Vec<Report>, String> {
        self.groups
            .iter()
            .map(|g| {
                let mut s = g.supply.clone();
                accept_before(&mut s, t)?;
                let state = s.at(t)?;
                let rates = s.rates();
                let paths = s.paths();
                Ok(Report {
                    group: g.parameters.id.clone(),
                    output_available: state.output_closed,
                    charger_bus: g.selected.clone(),
                    charger_delivering: rates.charger_dc_w > 0.,
                    battery_available: paths.battery_available,
                    energy_j: state.energy_j,
                    requested_w: s.requested_w(),
                    delivered_w: rates.delivered_w,
                    output_limit_w: g.parameters.config.output_limit_w,
                    cause: state.cause.map(cause_name),
                    depletion_s: if rates.energy_w < 0. {
                        s.next_storage_event_s()?
                    } else {
                        None
                    },
                })
            })
            .collect()
    }
    pub fn discrete_state(&self) -> State {
        State {
            groups: self
                .groups
                .iter()
                .map(|g| {
                    let r = g.supply.snapshot();
                    GroupState {
                        id: g.parameters.id.clone(),
                        selected: g.selected.clone(),
                        time_s: r.state.time_s,
                        energy_j: r.state.energy_j,
                        output_closed: r.state.output_closed,
                        cause: r.state.cause.map(|c| cause_name(c).to_string()),
                        source_j: r.state.source_j,
                        delivered_j: r.state.delivered_j,
                        loss_j: r.state.loss_j,
                        charger_available: r.paths.charger_available,
                        battery_available: r.paths.battery_available,
                        output_healthy: r.paths.output_healthy,
                        requested_w: r.requested_w,
                        original_energy_j: r.original_energy_j,
                    }
                })
                .collect(),
        }
    }
    /// Restore [`Groups::discrete_state`] exactly: the same groups in the
    /// same order, each selection one of its own buses; refused otherwise.
    pub fn restore_discrete_state(&mut self, state: State) -> Result<(), String> {
        if state.groups.len() != self.groups.len()
            || state
                .groups
                .iter()
                .zip(&self.groups)
                .any(|(s, g)| s.id != g.parameters.id)
        {
            return Err("DC snapshot of another group layout".into());
        }
        let mut restored = Vec::with_capacity(self.groups.len());
        for (s, g) in state.groups.into_iter().zip(&self.groups) {
            let p = &g.parameters;
            if s.selected != p.normal_bus && Some(&s.selected) != p.alternate_bus.as_ref() {
                return Err(format!("{}: snapshot charger input {}", p.id, s.selected));
            }
            let supply = Supply::restore(dc_supply::Snapshot {
                config: p.config,
                state: dc_supply::State {
                    time_s: s.time_s,
                    energy_j: s.energy_j,
                    output_closed: s.output_closed,
                    cause: s.cause.as_deref().map(cause_of).transpose()?,
                    source_j: s.source_j,
                    delivered_j: s.delivered_j,
                    loss_j: s.loss_j,
                },
                paths: Paths {
                    charger_available: s.charger_available,
                    battery_available: s.battery_available,
                    output_healthy: s.output_healthy,
                },
                requested_w: s.requested_w,
                original_energy_j: s.original_energy_j,
            })
            .map_err(|e| format!("{}: {e}", p.id))?;
            restored.push((supply, s.selected));
        }
        for (g, (supply, selected)) in self.groups.iter_mut().zip(restored) {
            g.supply = supply;
            g.selected = selected;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// `ld01-dc-instrument-groups` and `reference-dc-actuation` (dc-storage.md).
    fn group(
        id: &str,
        kwh: f64,
        duty: f64,
        output: f64,
        normal: &str,
        alternate: Option<&str>,
    ) -> GroupParameters {
        GroupParameters {
            id: id.into(),
            config: Config {
                capacity_j: kwh * 3.6e6,
                normal_group_w: duty,
                charger_limit_w: 10000.,
                output_limit_w: output,
                charge_efficiency: 0.95,
                discharge_efficiency: 0.95,
                converter_efficiency: 0.92,
            },
            requested_w: duty,
            normal_bus: normal.into(),
            alternate_bus: alternate.map(Into::into),
        }
    }
    fn five() -> Vec<GroupParameters> {
        vec![
            group("LD01.DC.I1", 24., 3000., 10000., "AC.A", None),
            group("LD01.DC.I2", 24., 3000., 10000., "AC.B", None),
            group("LD01.DC.I3", 24., 3000., 10000., "AC.A", Some("AC.B")),
            group("LD01.DC.ACT.A", 16., 2000., 20000., "AC.A", None),
            group("LD01.DC.ACT.B", 16., 2000., 20000., "AC.B", None),
        ]
    }
    fn buses(a: bool, b: bool) -> impl Fn(&str) -> Option<bool> {
        move |bus| match bus {
            "AC.A" => Some(a),
            "AC.B" => Some(b),
            _ => None,
        }
    }
    fn report<'a>(r: &'a [Report], id: &str) -> &'a Report {
        r.iter().find(|x| x.group == id).unwrap()
    }

    /// The page's 7.6 h reference check: a fully initialized group on its
    /// reference duty with no charging opens for insufficient supply at
    /// exactly 24 * 0.95 / 3 h (I) and 16 * 0.95 / 2 h (ACT), an owner time
    /// event, and a group whose charger stays live keeps its output.
    #[test]
    fn the_reference_depletion_is_7_6_hours_and_a_live_charger_keeps_the_output() {
        let t0 = 100.;
        let mut g = Groups::prepared(five(), t0, &buses(true, true)).unwrap();
        let r = g.reports(t0).unwrap();
        assert!(
            r.iter()
                .all(|x| x.output_available && x.charger_delivering && x.depletion_s.is_none())
        );
        // AC.A lost at +10 s: I1, I3 and ACT.A discharge; I2 and ACT.B keep charging.
        g.follow(t0 + 10., &buses(false, true)).unwrap();
        let r = g.reports(t0 + 10.).unwrap();
        for id in ["LD01.DC.I1", "LD01.DC.I3", "LD01.DC.ACT.A"] {
            let x = report(&r, id);
            assert!(x.output_available && !x.charger_delivering);
            assert_eq!(x.depletion_s, Some(t0 + 10. + 27360.), "{id}");
        }
        assert!(report(&r, "LD01.DC.I2").charger_delivering);
        // The depletion is reported at its own time, without a transition.
        let end = t0 + 10. + 27360.;
        let before = g.reports(end).unwrap();
        assert!(report(&before, "LD01.DC.I1").output_available);
        let after = g.reports(end + 1.).unwrap();
        let i1 = report(&after, "LD01.DC.I1");
        assert!(!i1.output_available);
        assert_eq!(
            (i1.cause, i1.energy_j, i1.delivered_w),
            (Some("InsufficientSupply"), 0., 0.)
        );
        assert!(report(&after, "LD01.DC.I2").output_available);
        // AC.A back an hour later: the event is accepted first, the output
        // stays open (latched) while the charger refills the isolated bank;
        // RESET then CLOSE restore it.
        g.follow(end + 3600., &buses(true, true)).unwrap();
        assert!(
            g.records
                .iter()
                .any(|r| r.time == end && r.what == "LD01.DC.I1 usable energy empty")
        );
        let r = g.reports(end + 3600.).unwrap();
        let i1 = report(&r, "LD01.DC.I1");
        assert!(!i1.output_available && i1.charger_delivering && i1.energy_j == 0.);
        assert!(
            g.command(end + 3601., "LD01.DC.I1", Command::Reset)
                .unwrap()
        );
        assert!(
            g.command(end + 3601., "LD01.DC.I1", Command::Close)
                .unwrap()
        );
        let i1 = report(&g.reports(end + 3602.).unwrap(), "LD01.DC.I1").clone();
        assert!(i1.output_available && i1.cause.is_none() && i1.energy_j > 0.);
    }

    /// A short AC interruption (a transfer's open interval) discharges a
    /// little and recharges; the full event is accepted at its own time
    /// before the next transition, and the energy returns to capacity.
    #[test]
    fn a_short_interruption_recharges_to_full() {
        let mut g = Groups::prepared(five(), 0., &buses(true, true)).unwrap();
        g.follow(1., &buses(false, true)).unwrap();
        g.follow(1.4, &buses(true, true)).unwrap();
        let i1 = report(&g.reports(1.4).unwrap(), "LD01.DC.I1").clone();
        assert!(i1.energy_j < 24. * 3.6e6 && i1.output_available);
        // 3 kW over 0.4 s at 0.95, refilled at 0.95 * 7 kW.
        let refill = 3000. * 0.4 / 0.95 / (0.95 * 7000.);
        g.follow(10., &buses(false, true)).unwrap();
        assert!(
            g.records
                .iter()
                .any(|r| (r.time - (1.4 + refill)).abs() < 1e-9
                    && r.what == "LD01.DC.I1 usable energy full")
        );
        let i1 = report(&g.reports(10.).unwrap(), "LD01.DC.I1").clone();
        assert_eq!(i1.energy_j, 24. * 3.6e6);
    }

    /// I3's selector: break before make at one event onto AC.B restores its
    /// charging while AC.A is dead; a repeat is recorded, not an error; I1
    /// has no selector; the selection survives a snapshot exactly.
    #[test]
    fn i3_selects_its_alternate_and_the_snapshot_is_exact() {
        let mut g = Groups::prepared(five(), 0., &buses(true, true)).unwrap();
        g.follow(5., &buses(false, true)).unwrap();
        assert!(!report(&g.reports(5.).unwrap(), "LD01.DC.I3").charger_delivering);
        assert!(
            g.select_charger(65., "LD01.DC.I3", "AC.B", &buses(false, true))
                .unwrap()
        );
        let i3 = report(&g.reports(65.).unwrap(), "LD01.DC.I3").clone();
        assert!(i3.charger_delivering && i3.charger_bus == "AC.B" && i3.depletion_s.is_none());
        assert!(
            !g.select_charger(66., "LD01.DC.I3", "AC.B", &buses(false, true))
                .unwrap()
        );
        assert!(
            g.select_charger(67., "LD01.DC.I1", "AC.B", &buses(false, true))
                .is_err()
        );
        assert!(
            g.select_charger(67., "LD01.DC.I3", "AC.C", &buses(false, true))
                .is_err()
        );
        // AC.A's return no longer reaches I3, which charges from AC.B.
        g.follow(70., &buses(true, true)).unwrap();
        assert!(
            !g.records
                .iter()
                .any(|r| r.time == 70. && r.what.starts_with("LD01.DC.I3"))
        );
        let state = g.discrete_state();
        let json = serde_json::to_value(&state).unwrap();
        let mut copy = Groups::prepared(five(), 0., &buses(true, true)).unwrap();
        copy.restore_discrete_state(serde_json::from_value(json).unwrap())
            .unwrap();
        assert_eq!(copy.discrete_state(), state);
        assert_eq!(copy.reports(500.).unwrap(), g.reports(500.).unwrap());
        let mut other = state.clone();
        other.groups.swap(0, 1);
        assert!(copy.restore_discrete_state(other).is_err());
    }
}

//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/steam-generator-protection.md#qualification-and-latching
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/source-and-primary-protection.md#retention-unavailable-control-and-return-to-service
//! One powered division processor: its own channel standing (first
//! acquisition, loss, one-period recovery), its own continuous
//! qualification timers in decision frames, and its latched named causes.
//! A division with an accepted reactor-trip cause latches its trip state
//! (initiating function and time) and requests its permissive contact
//! open. Latches are retained through power loss; an unpowered division
//! evaluates nothing, accrues no duration and makes no record.
use super::{
    acquisition::{
        restored_bool, restored_frame, restored_frame_option, restored_real, snapshot_fields,
        snapshot_real,
    },
    packet::Effects,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Continuous qualification in decision frames: the duration starts at
/// zero at the first frame the condition holds and resets when it does not.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Timer {
    since: Option<u64>,
}
impl Timer {
    /// Whether the condition, true at frame `k`, has now held for `frames`.
    pub fn qualify(&mut self, k: u64, condition: bool, frames: u64) -> bool {
        if !condition {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(k);
        k - since >= frames
    }
    pub fn clear(&mut self) {
        self.since = None;
    }
    pub fn since(&self) -> Option<u64> {
        self.since
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): a timer
    /// restored at the frame its condition has held since.
    pub fn restored(since: Option<u64>) -> Self {
        Self { since }
    }
}

/// A channel's standing in one division.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// No delivery yet: the original healthy first acquisition joins at
    /// once (it is not recovery from lost evidence).
    Never,
    Qualified,
    /// Previously established evidence lost.
    Lost,
    /// Usable again since this frame, not yet for the recovery duration.
    Recovering(u64),
}
impl Standing {
    /// Advance at decision frame `k` from the channel's raw usability;
    /// returns whether it may vote now.
    pub fn update(&mut self, k: u64, usable: bool, recovery_frames: u64) -> bool {
        *self = match (*self, usable) {
            (Standing::Never, true) | (Standing::Qualified, true) => Standing::Qualified,
            (Standing::Never, false) => Standing::Never,
            (_, false) => Standing::Lost,
            (Standing::Lost, true) if recovery_frames == 0 => Standing::Qualified,
            (Standing::Lost, true) => Standing::Recovering(k),
            (Standing::Recovering(since), true) if k - since >= recovery_frames => {
                Standing::Qualified
            }
            (Standing::Recovering(since), true) => Standing::Recovering(since),
        };
        *self == Standing::Qualified
    }
}

impl Standing {
    /// S5 snapshot hook: `"never" | "qualified" | "lost" | {"recovering": k}`.
    pub fn snapshot(&self) -> Value {
        match self {
            Standing::Never => json!("never"),
            Standing::Qualified => json!("qualified"),
            Standing::Lost => json!("lost"),
            Standing::Recovering(k) => json!({ "recovering": k }),
        }
    }
    /// The inverse of [`Standing::snapshot`].
    pub fn restored(v: &Value) -> Result<Self, String> {
        match v.as_str() {
            Some("never") => Ok(Standing::Never),
            Some("qualified") => Ok(Standing::Qualified),
            Some("lost") => Ok(Standing::Lost),
            Some(other) => Err(format!("channel standing {other}")),
            None => {
                let o = snapshot_fields(v, "channel standing", &["recovering"])?;
                Ok(Standing::Recovering(restored_frame(
                    &o["recovering"],
                    "recovering since",
                )?))
            }
        }
    }
}

/// An accepted, latched cause.
#[derive(Clone, Debug, PartialEq)]
pub struct Cause {
    pub function: String,
    pub frame: u64,
    pub at_s: f64,
}

impl Cause {
    /// S5 snapshot hook: `[function, frame, bits of the time]`.
    pub fn snapshot(&self) -> Value {
        json!([self.function, self.frame, snapshot_real(self.at_s)])
    }
    /// The inverse of [`Cause::snapshot`].
    pub fn restored(v: &Value) -> Result<Self, String> {
        match v.as_array().map(Vec::as_slice) {
            Some([Value::String(function), frame, at]) => Ok(Self {
                function: function.clone(),
                frame: restored_frame(frame, "a cause's frame")?,
                at_s: restored_real(at, "a cause's time")?,
            }),
            _ => Err(format!(
                "a cause snapshot is [function, frame, time], not {v}"
            )),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Division {
    pub supply: String,
    pub powered: bool,
    pub timers: BTreeMap<String, Timer>,
    pub standing: BTreeMap<String, Standing>,
    pub causes: Vec<Cause>,
    /// The division trip latch: its initiating cause.
    pub trip: Option<Cause>,
    /// Outgoing requests recorded at acceptance (PRHR, CMT injection,
    /// heater isolation): requests only, no actuation in S3.
    pub requests: Vec<Value>,
    /// Recorded votes (monitors): first qualification time by monitor id.
    /// No cause, latch or output follows.
    pub monitors: BTreeMap<String, f64>,
}
impl Division {
    pub fn new(supply: &str) -> Self {
        Self {
            monitors: BTreeMap::new(),
            supply: supply.into(),
            powered: true,
            timers: BTreeMap::new(),
            standing: BTreeMap::new(),
            causes: Vec::new(),
            trip: None,
            requests: Vec::new(),
        }
    }
    pub fn latched(&self, function: &str) -> bool {
        self.causes.iter().any(|c| c.function == function)
    }
    /// Power loss: no evaluation, no accrued duration, evidence lost (a
    /// restored division requalifies its channels); latches are retained.
    pub fn set_powered(&mut self, powered: bool) {
        if self.powered && !powered {
            for t in self.timers.values_mut() {
                t.clear();
            }
            for s in self.standing.values_mut() {
                if *s != Standing::Never {
                    *s = Standing::Lost;
                }
            }
        }
        self.powered = powered;
    }
    /// The channel's standing at frame `k`: whether it may vote.
    pub fn usable(&mut self, channel: &str, k: u64, raw: bool, recovery_frames: u64) -> bool {
        self.standing
            .entry(channel.into())
            .or_insert(Standing::Never)
            .update(k, raw, recovery_frames)
    }
    pub fn qualify(&mut self, function: &str, k: u64, condition: bool, frames: u64) -> bool {
        self.timers
            .entry(function.into())
            .or_default()
            .qualify(k, condition, frames)
    }
    /// Latch a newly qualified cause (once per function) with its selected
    /// requests; a reactor-trip cause latches the division trip. The PRHR
    /// request follows only a cause with the `prhr` effect (the AP1000 signal
    /// set, owner R12-A1), never the reactor trip itself.
    pub fn accept(&mut self, function: &str, k: u64, at_s: f64, effects: Effects) -> bool {
        let Effects {
            reactor_trip,
            cmt_injection,
            heater_isolation,
            prhr,
        } = effects;
        if self.latched(function) {
            return false;
        }
        let cause = Cause {
            function: function.into(),
            frame: k,
            at_s,
        };
        self.causes.push(cause.clone());
        if reactor_trip && self.trip.is_none() {
            self.trip = Some(cause);
        }
        if prhr {
            self.requests
                .push(json!({"request": "PRHR", "by": function, "t_s": at_s}));
        }
        if cmt_injection {
            self.requests
                .push(json!({"request": "CMT injection", "by": function, "t_s": at_s}));
        }
        if heater_isolation {
            self.requests
                .push(json!({"request": "heater isolation", "by": function, "t_s": at_s}));
        }
        true
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): supply,
    /// qualification timers, channel standing, latched causes, the trip
    /// latch, the recorded requests and monitors, real numbers as bits.
    pub fn snapshot(&self) -> Result<Value, String> {
        let requests = self
            .requests
            .iter()
            .map(|r| {
                let o = snapshot_fields(r, "a division request", &["request", "by", "t_s"])?;
                let t = o["t_s"]
                    .as_f64()
                    .ok_or_else(|| format!("a division request's time: {r}"))?;
                Ok(json!([o["request"], o["by"], snapshot_real(t)]))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(json!({"supply": self.supply, "powered": self.powered,
            "timers": self.timers.iter().map(|(k, t)| (k.clone(), json!(t.since))).collect::<serde_json::Map<_, _>>(),
            "standing": self.standing.iter().map(|(k, s)| (k.clone(), s.snapshot())).collect::<serde_json::Map<_, _>>(),
            "causes": self.causes.iter().map(Cause::snapshot).collect::<Vec<_>>(),
            "trip": self.trip.as_ref().map(Cause::snapshot),
            "requests": requests,
            "monitors": self.monitors.iter().map(|(k, t)| (k.clone(), snapshot_real(*t))).collect::<serde_json::Map<_, _>>()}))
    }
    /// Restore [`Division::snapshot`] of the same division exactly.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let o = snapshot_fields(
            v,
            "division",
            &[
                "supply", "powered", "timers", "standing", "causes", "trip", "requests", "monitors",
            ],
        )?;
        if o["supply"].as_str() != Some(self.supply.as_str()) {
            return Err(format!(
                "division {} restored from {}",
                self.supply, o["supply"]
            ));
        }
        let map = |key: &str| {
            o[key]
                .as_object()
                .ok_or_else(|| format!("division {}: {key} is not an object", self.supply))
        };
        let timers = map("timers")?
            .iter()
            .map(|(k, s)| {
                Ok((
                    k.clone(),
                    Timer::restored(restored_frame_option(s, "a timer")?),
                ))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let standing = map("standing")?
            .iter()
            .map(|(k, s)| Ok((k.clone(), Standing::restored(s)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let monitors = map("monitors")?
            .iter()
            .map(|(k, t)| Ok((k.clone(), restored_real(t, "a monitor's time")?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let causes = o["causes"]
            .as_array()
            .ok_or("division causes are not an array")?
            .iter()
            .map(Cause::restored)
            .collect::<Result<Vec<_>, _>>()?;
        let trip = match &o["trip"] {
            Value::Null => None,
            c => Some(Cause::restored(c)?),
        };
        let requests = o["requests"]
            .as_array()
            .ok_or("division requests are not an array")?
            .iter()
            .map(|r| match r.as_array().map(Vec::as_slice) {
                Some([request @ Value::String(_), by @ Value::String(_), t]) => Ok(
                    json!({"request": request, "by": by, "t_s": restored_real(t, "a request's time")?}),
                ),
                _ => Err(format!("a request snapshot is [request, by, time], not {r}")),
            })
            .collect::<Result<Vec<_>, String>>()?;
        self.powered = restored_bool(&o["powered"], "division supply")?;
        self.timers = timers;
        self.standing = standing;
        self.causes = causes;
        self.trip = trip;
        self.requests = requests;
        self.monitors = monitors;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualification_counts_whole_frames_and_resets_on_interruption() {
        let mut t = Timer::default();
        // 0.5 s on the 0.1 s frame: true at frames 10..=15 qualifies at 15.
        for k in 10..15 {
            assert!(!t.qualify(k, true, 5));
        }
        assert!(t.qualify(15, true, 5));
        let mut t = Timer::default();
        for k in 10..14 {
            assert!(!t.qualify(k, true, 5));
        }
        assert!(!t.qualify(14, false, 5), "an interruption resets");
        for k in 15..20 {
            assert!(!t.qualify(k, true, 5));
        }
        assert!(t.qualify(20, true, 5));
        // No selected duration: the first true decision qualifies.
        assert!(Timer::default().qualify(3, true, 0));
    }

    #[test]
    fn first_acquisition_joins_and_lost_evidence_requalifies() {
        let mut s = Standing::Never;
        assert!(!s.update(1, false, 10));
        assert!(s.update(2, true, 10), "first delivery joins at once");
        assert!(!s.update(3, false, 10));
        assert_eq!(s, Standing::Lost);
        for k in 4..14 {
            assert!(!s.update(k, true, 10), "recovering at {k}");
        }
        assert!(s.update(14, true, 10), "usable for one second");
        assert!(!s.update(15, false, 10));
        assert!(!s.update(16, true, 10));
        assert_eq!(s, Standing::Recovering(16));
    }

    #[test]
    fn causes_latch_once_and_survive_power_loss() {
        let effects = |reactor_trip, cmt_injection, prhr| Effects {
            reactor_trip,
            cmt_injection,
            heater_isolation: false,
            prhr,
        };
        let mut d = Division::new("I1");
        assert!(d.accept(
            "LD01.PROT.PZR.LOW_PRESSURE",
            7,
            0.7,
            effects(true, true, true)
        ));
        assert!(!d.accept(
            "LD01.PROT.PZR.LOW_PRESSURE",
            8,
            0.8,
            effects(true, true, true)
        ));
        assert!(d.accept("LD01.PROT.TG.TRIP", 9, 0.9, effects(true, false, false)));
        assert_eq!(
            d.trip.as_ref().unwrap().function,
            "LD01.PROT.PZR.LOW_PRESSURE"
        );
        // R12-A1: the CMT cause requests PRHR; the turbine-trip reactor trip
        // requests none.
        let requests: Vec<_> = d
            .requests
            .iter()
            .map(|r| (r["request"].clone(), r["by"].clone()))
            .collect();
        assert_eq!(
            requests,
            [
                (json!("PRHR"), json!("LD01.PROT.PZR.LOW_PRESSURE")),
                (json!("CMT injection"), json!("LD01.PROT.PZR.LOW_PRESSURE"))
            ]
        );
        d.qualify("X", 1, true, 5);
        d.usable("PT1", 1, true, 10);
        d.set_powered(false);
        assert!(d.trip.is_some() && d.causes.len() == 2);
        assert_eq!(d.timers["X"].since(), None);
        assert_eq!(d.standing["PT1"], Standing::Lost);
    }
}

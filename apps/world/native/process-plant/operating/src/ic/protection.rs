//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/protective-testing-and-availability.md#coherent-timing-and-recovery
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/steam-power/admission-and-protection.md#turbine-trip-and-reset-semantics
//! The assembled acquired protection: channel families and state reports,
//! three division processors and the holding chain, advanced frame by
//! frame.
//!
//! **Frame order.** At frame `k`: acquire every channel and report (the
//! plant's left limit at the instant), then decide frame `k + transport`.
//! A decision reads only delivered evidence, and with transport of one
//! frame the evidence delivered at `k + 1` is exactly what frame `k`
//! acquired: the decision of `k + 1` is fully determined once frame `k` is
//! observed, so the driver learns a holding loss one frame before its
//! instant and stops there exactly (class R). Each decision follows the
//! testing page's order: support and service state, channel standing,
//! predicates and qualification, initiation, then the holding chain.
//!
//! **Turbine trip on the reactor trip (owner R12-A2).** The holding
//! loss decided at frame `k` requests the turbine trip at frame
//! `k + delay` (`turbine_trip_on_reactor_trip`), unless the turbine
//! controls already retain a trip: the driver learns it one frame ahead, as
//! the holding loss, and applies it as the declared `LD01.TG` TRIP.
//!
//! **Turbine-trip request.** The ACT.B turbine controls' retained trip
//! memory is set by the declared `LD01.TG` TRIP command at its time; its
//! report is sampled and transported like a protective channel and each
//! division accepts the named cause at the first decision with a usable
//! delivered TRIPPED report (no qualification duration is selected).
use super::{
    Frame,
    acquisition::{Analog, AnalogConfig, Overrange, Quality, Report},
    division::Division,
    holding::Holding,
    packet::{Effects, Family, FunctionSpec, Quantity, ReportSource, ReportSpec, Rule, Section},
    vote::{Side, Vote, predicate, vote},
};
use serde_json::{Value, json};

struct FamilyState {
    spec: Family,
    channels: Vec<Analog>,
    max_age_frames: u64,
    recovery_frames: u64,
}
struct ReportState {
    spec: ReportSpec,
    channel: Report,
    max_age_frames: u64,
    recovery_frames: u64,
}
/// A recorded vote (no cause, latch or output).
struct Monitor {
    id: String,
    family: String,
    side: Side,
    frames: u64,
}
struct Function {
    spec: FunctionSpec,
    frames: u64,
}

pub struct Protection {
    frame: Frame,
    families: Vec<FamilyState>,
    reports: Vec<ReportState>,
    functions: Vec<Function>,
    monitors: Vec<Monitor>,
    pub divisions: [Division; 3],
    pub holding: Holding,
    interface: String,
    /// The turbine controls' retained trip memory (time set).
    turbine_trip_s: Option<f64>,
    /// R12-A2: the interlock's cause and delay in frames.
    turbine_on_trip: (String, u64),
    /// The frame the holding loss was decided at.
    holding_lost_frame: Option<u64>,
    /// The frame the interlock requested the turbine trip at.
    turbine_trip_requested: Option<u64>,
    /// Every cluster seated (the `BankInserted` report's contact chain), as
    /// the client last read the rods owner.
    bank_seated: bool,
    /// The last decided frame.
    decided: Option<u64>,
    /// Events in order: accepted causes, contact changes, holding loss.
    pub log: Vec<Value>,
}

impl Protection {
    /// Balanced initialization at the start: every channel's response equals
    /// its quantity's value (`initial`), nothing acquired yet, holding
    /// rearmed with all permissives closed.
    pub fn new(
        section: &Section,
        initial: impl Fn(&Quantity) -> Result<f64, String>,
    ) -> Result<Self, String> {
        if section.identity != "ld01-s3-ic" {
            return Err(format!("not the S3 ic section: {}", section.identity));
        }
        let frame = Frame::new(section.frame_s)?;
        let mut families = Vec::new();
        for f in &section.families {
            if f.channels.is_empty() || f.channels.len() > 3 {
                return Err(format!("{}: {} channels", f.id, f.channels.len()));
            }
            let value = initial(&f.quantity)?;
            // A loop flow is observed in fractions of its nominal; its kg/s
            // quantization and sign band convert with the resolved nominal.
            let config = match &f.quantity {
                Quantity::LoopFlow {
                    nominal_kg_s,
                    quantum_kg_s,
                    indeterminate_band_kg_s,
                    face_id,
                    ..
                } => {
                    let nominal = nominal_kg_s
                        .filter(|n| n.is_finite() && *n > 0.)
                        .ok_or_else(|| format!("{}: unresolved nominal flow at {face_id}", f.id))?;
                    if f.channel.quantum.is_some() || f.channel.indeterminate_band.is_some() {
                        return Err(format!("{}: the kg/s fields belong to the quantity", f.id));
                    }
                    AnalogConfig {
                        quantum: Some(quantum_kg_s / nominal),
                        indeterminate_band: Some(indeterminate_band_kg_s / nominal),
                        ..f.channel
                    }
                }
                _ => f.channel,
            };
            let channels = f
                .channels
                .iter()
                .map(|c| Analog::new(&c.id, &c.supply, config, section.frame_s, value))
                .collect::<Result<Vec<_>, _>>()?;
            families.push(FamilyState {
                spec: f.clone(),
                channels,
                max_age_frames: frame.frames_in(f.maximum_age_s)?,
                recovery_frames: frame.frames_in(f.recovery_s)?,
            });
        }
        let reports = section
            .reports
            .iter()
            .map(|r| {
                Ok(ReportState {
                    spec: r.clone(),
                    channel: Report::new(
                        &r.id,
                        &r.supply,
                        section.frame_s,
                        r.sample_s,
                        r.transport_s,
                    )?,
                    max_age_frames: frame.frames_in(r.maximum_age_s)?,
                    recovery_frames: frame.frames_in(r.recovery_s)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let family = |id: &str| families.iter().any(|f: &FamilyState| f.spec.id == id);
        let mut functions = Vec::new();
        for f in &section.functions {
            let (frames, ok) = match &f.rule {
                Rule::Voted {
                    family: id,
                    qualification_s,
                    ..
                }
                | Rule::Unavailable {
                    family: id,
                    qualification_s,
                } => (frame.frames_in(*qualification_s)?, family(id)),
                Rule::Report { report } => (0, reports.iter().any(|r| r.spec.id == *report)),
                Rule::Armed {
                    family: id,
                    qualification_s,
                    arming_family,
                    ..
                }
                | Rule::ArmedUnavailable {
                    family: id,
                    qualification_s,
                    arming_family,
                    ..
                } => (
                    frame.frames_in(*qualification_s)?,
                    family(id) && family(arming_family),
                ),
            };
            if !ok {
                return Err(format!(
                    "{}: its family or report is not in the section",
                    f.id
                ));
            }
            functions.push(Function {
                spec: f.clone(),
                frames,
            });
        }
        let mut monitors = Vec::new();
        for m in &section.monitors {
            match &m.rule {
                Rule::Voted {
                    family: id,
                    side,
                    qualification_s,
                } if family(id) => monitors.push(Monitor {
                    id: m.id.clone(),
                    family: id.clone(),
                    side: *side,
                    frames: frame.frames_in(*qualification_s)?,
                }),
                _ => {
                    return Err(format!(
                        "monitor {}: a voted rule on a family of the section",
                        m.id
                    ));
                }
            }
        }
        // The decision's evidence is what the previous acquisition frame
        // delivers: every channel must travel whole frames, at least one.
        for f in &families {
            if f.channels[0].delivery.transport_frames == 0 {
                return Err(format!("{}: zero transport", f.spec.id));
            }
        }
        let h = &section.holding;
        let interlock = &section.turbine_trip_on_reactor_trip;
        let turbine_on_trip = (interlock.cause.clone(), frame.frames_in(interlock.delay_s)?);
        if turbine_on_trip.1 == 0 {
            return Err(format!("{}: zero delay", interlock.cause));
        }
        Ok(Self {
            frame,
            families,
            reports,
            functions,
            monitors,
            divisions: [
                Division::new(&h.divisions[0]),
                Division::new(&h.divisions[1]),
                Division::new(&h.divisions[2]),
            ],
            holding: Holding::armed([
                h.contacts[0].as_str(),
                h.contacts[1].as_str(),
                h.contacts[2].as_str(),
            ]),
            interface: h.interface.clone(),
            turbine_trip_s: None,
            turbine_on_trip,
            holding_lost_frame: None,
            turbine_trip_requested: None,
            bank_seated: false,
            decided: None,
            log: Vec::new(),
        })
    }
    pub fn frame_of(&self) -> Frame {
        self.frame
    }
    /// The distinct quantities the families observe.
    pub fn quantities(&self) -> Vec<Quantity> {
        let mut out: Vec<Quantity> = Vec::new();
        for f in &self.families {
            if !out.contains(&f.spec.quantity) {
                out.push(f.spec.quantity.clone());
            }
        }
        out
    }
    /// Continue every channel observing `quantity` over `dt` under its
    /// polynomial (raw derivatives at the interval start, physical units).
    pub fn advance(
        &mut self,
        quantity: &Quantity,
        dt: f64,
        derivatives: &[f64],
    ) -> Result<(), String> {
        for f in self
            .families
            .iter_mut()
            .filter(|f| f.spec.quantity == *quantity)
        {
            for c in &mut f.channels {
                c.advance(dt, derivatives)?;
            }
        }
        Ok(())
    }
    /// The declared `LD01.TG` TRIP at `t`: the turbine controls retain it.
    /// The rods owner's all-seated state, for the `BankInserted` report.
    pub fn set_bank_seated(&mut self, seated: bool) {
        self.bank_seated = seated;
    }
    pub fn turbine_trip(&mut self, t: f64) {
        self.turbine_trip_s.get_or_insert(t);
    }
    /// R12-A2: whether the interlock requests the turbine trip at frame `k`
    /// (the frame after the one just observed): the holding loss was
    /// decided `delay` frames before `k` and the turbine controls retain no
    /// trip. Requested at most once, and logged with its cause.
    pub fn turbine_trip_due(&mut self, k: u64) -> Option<(u64, String)> {
        let lost = self.holding_lost_frame?;
        if self.turbine_trip_s.is_some()
            || self.turbine_trip_requested.is_some()
            || k != lost + self.turbine_on_trip.1
        {
            return None;
        }
        self.turbine_trip_requested = Some(k);
        let cause = self.turbine_on_trip.0.clone();
        self.log
            .push(json!({"t_s": self.frame.instant(k), "frame": k,
            "event": "turbine trip requested", "cause": cause, "holding_lost_frame": lost}));
        Some((k, cause))
    }
    /// Injected support state of division `i` (its processor, its contact's
    /// coil and the channels on its supply group), applied from frame `k`.
    pub fn set_division_power(&mut self, i: usize, powered: bool) {
        let supply = self.divisions[i].supply.clone();
        self.divisions[i].set_powered(powered);
        for f in &mut self.families {
            for c in f.channels.iter_mut().filter(|c| c.supply == supply) {
                c.set_powered(powered);
            }
        }
    }
    /// Every analog channel's delivered sample: id, acquisition frame and
    /// what it establishes (receipts).
    pub fn delivered(&self) -> Vec<(String, Option<(u64, Quality)>)> {
        self.families
            .iter()
            .flat_map(|f| f.channels.iter())
            .map(|c| {
                (
                    c.id.clone(),
                    c.delivery.delivered().map(|s| (s.acquired, s.value)),
                )
            })
            .collect()
    }
    /// The input-stage status of every channel observing `quantity`, for
    /// the next acquisition (see [`Analog::input_overrange`]).
    pub fn set_input_overrange(&mut self, quantity: &Quantity, status: Option<Overrange>) {
        for f in self
            .families
            .iter_mut()
            .filter(|f| f.spec.quantity == *quantity)
        {
            for c in &mut f.channels {
                c.input_overrange = status;
            }
        }
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; PHYS reconciles): everything a
    /// later frame reads — every channel's response and delivery, every
    /// report, the three divisions, the holding chain, the turbine controls'
    /// trip memory, the interlock's state and the last decided frame —
    /// exact (real numbers as bits). The compiled section (families,
    /// functions, timing) is recomposed on restore; the log is a receipt.
    pub fn snapshot(&self) -> Result<Value, String> {
        Ok(json!({
            "families": self.families.iter().map(|f| json!({"id": f.spec.id,
                "channels": f.channels.iter().map(Analog::snapshot).collect::<Vec<_>>()})).collect::<Vec<_>>(),
            "reports": self.reports.iter().map(|r| r.channel.snapshot()).collect::<Vec<_>>(),
            "divisions": self.divisions.iter().map(Division::snapshot).collect::<Result<Vec<_>, _>>()?,
            "holding": self.holding.snapshot(),
            "turbine_trip_s": crate::joined::block::snapshot_time(self.turbine_trip_s),
            "holding_lost_frame": self.holding_lost_frame,
            "turbine_trip_requested": self.turbine_trip_requested,
            "bank_seated": self.bank_seated,
            "decided": self.decided,
        }))
    }
    /// Restore [`Protection::snapshot`] into the protection of the same
    /// section exactly; any other layout refuses.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        use super::acquisition::{restored_frame_option, restored_real_option, snapshot_fields};
        let o = snapshot_fields(
            v,
            "protection",
            &[
                "families",
                "reports",
                "divisions",
                "holding",
                "turbine_trip_s",
                "holding_lost_frame",
                "turbine_trip_requested",
                "bank_seated",
                "decided",
            ],
        )?;
        let families = o["families"]
            .as_array()
            .filter(|a| a.len() == self.families.len())
            .ok_or("protection snapshot: one entry per family")?;
        for (f, s) in self.families.iter_mut().zip(families) {
            let s = snapshot_fields(s, "family", &["id", "channels"])?;
            let channels = s["channels"]
                .as_array()
                .filter(|a| {
                    s["id"].as_str() == Some(f.spec.id.as_str()) && a.len() == f.channels.len()
                })
                .ok_or_else(|| format!("protection snapshot: family {} differs", f.spec.id))?;
            for (c, s) in f.channels.iter_mut().zip(channels) {
                c.restore(s)?;
            }
        }
        let reports = o["reports"]
            .as_array()
            .filter(|a| a.len() == self.reports.len())
            .ok_or("protection snapshot: one entry per report")?;
        for (r, s) in self.reports.iter_mut().zip(reports) {
            r.channel.restore(s)?;
        }
        let divisions = o["divisions"]
            .as_array()
            .filter(|a| a.len() == 3)
            .ok_or("protection snapshot: three divisions")?;
        for (d, s) in self.divisions.iter_mut().zip(divisions) {
            d.restore(s)?;
        }
        self.holding.restore(&o["holding"])?;
        self.turbine_trip_s = restored_real_option(&o["turbine_trip_s"], "turbine trip memory")?;
        self.holding_lost_frame =
            restored_frame_option(&o["holding_lost_frame"], "holding loss frame")?;
        self.turbine_trip_requested =
            restored_frame_option(&o["turbine_trip_requested"], "interlock request frame")?;
        self.bank_seated =
            super::acquisition::restored_bool(&o["bank_seated"], "bank seated chain")?;
        self.decided = restored_frame_option(&o["decided"], "last decided frame")?;
        Ok(())
    }
    pub fn channel_mut(&mut self, id: &str) -> Option<&mut Analog> {
        self.families
            .iter_mut()
            .flat_map(|f| f.channels.iter_mut())
            .find(|c| c.id == id)
    }
    /// Frame `k`: decide `k` if not yet decided (the start), acquire at `k`,
    /// then decide `k + 1`. Returns the frame of a holding loss decided now.
    pub fn frame(&mut self, k: u64) -> Result<Option<u64>, String> {
        let mut lost = None;
        if self.decided.is_none_or(|d| d < k) {
            lost = lost.or(self.decide(k)?);
        }
        let tk = self.frame.instant(k);
        let tripped = self.turbine_trip_s.is_some_and(|t| t < tk);
        for f in &mut self.families {
            for c in &mut f.channels {
                c.acquire(k)?;
            }
        }
        for r in &mut self.reports {
            match r.spec.source {
                ReportSource::TurbineRetainedTrip => r.channel.acquire(k, tripped),
                ReportSource::BankInserted => r.channel.acquire(k, self.bank_seated),
            }
        }
        Ok(lost.or(self.decide(k + 1)?))
    }

    fn decide(&mut self, k: u64) -> Result<Option<u64>, String> {
        if self.decided.is_some_and(|d| d >= k) {
            return Err(format!("frame {k} decided twice"));
        }
        self.decided = Some(k);
        let t = self.frame.instant(k);
        for f in &mut self.families {
            for c in &mut f.channels {
                c.deliver(k);
            }
        }
        for r in &mut self.reports {
            r.channel.deliver(k);
        }
        for d in 0..3 {
            if !self.divisions[d].powered {
                continue;
            }
            // Channel standing first, once per channel.
            let mut usable: Vec<Vec<Option<Quality>>> = Vec::new();
            for f in &self.families {
                let mut v = Vec::new();
                for c in &f.channels {
                    let raw = c.powered()
                        && c.delivery
                            .delivered()
                            .is_some_and(|s| k - s.acquired <= f.max_age_frames);
                    let ok = self.divisions[d].usable(&c.id, k, raw, f.recovery_frames);
                    v.push(if ok {
                        c.delivery.delivered().map(|s| s.value)
                    } else {
                        None
                    });
                }
                usable.push(v);
            }
            let mut reported: Vec<Option<bool>> = Vec::new();
            for r in &self.reports {
                let raw = r.channel.powered()
                    && r.channel
                        .delivery
                        .delivered()
                        .is_some_and(|s| k - s.acquired <= r.max_age_frames);
                let ok = self.divisions[d].usable(&r.spec.id, k, raw, r.recovery_frames);
                reported.push(if ok {
                    r.channel.delivery.delivered().map(|s| s.value)
                } else {
                    None
                });
            }
            let family = |id: &str| self.families.iter().position(|f| f.spec.id == id);
            let voted = |i: usize, side: Side| -> Result<Vote, String> {
                vote(
                    &usable[i]
                        .iter()
                        .map(|q| q.and_then(|q| predicate(q, side)))
                        .collect::<Vec<_>>(),
                )
            };
            let mut accepted: Vec<(String, Effects)> = Vec::new();
            for f in &self.functions {
                let condition = match &f.spec.rule {
                    Rule::Voted {
                        family: id, side, ..
                    } => voted(family(id).ok_or("family")?, *side)? == Vote::Satisfied,
                    Rule::Unavailable { family: id, .. } => {
                        usable[family(id).ok_or("family")?].iter().flatten().count() < 2
                    }
                    Rule::Report { report } => {
                        let i = self
                            .reports
                            .iter()
                            .position(|r| r.spec.id == *report)
                            .ok_or("report")?;
                        reported[i] == Some(true)
                    }
                    Rule::Armed {
                        family: id,
                        side,
                        arming_family,
                        arming,
                        ..
                    } => {
                        let armed = voted(family(arming_family).ok_or("family")?, *arming)?
                            == Vote::Satisfied;
                        let own = &usable[family(id).ok_or("family")?];
                        armed
                            && own.len() == 1
                            && own[0].and_then(|q| predicate(q, *side)) == Some(true)
                    }
                    Rule::ArmedUnavailable {
                        family: id,
                        arming_family,
                        arming,
                        ..
                    } => {
                        let armed = voted(family(arming_family).ok_or("family")?, *arming)?
                            == Vote::Satisfied;
                        armed && usable[family(id).ok_or("family")?].iter().flatten().count() == 0
                    }
                };
                if self.divisions[d].qualify(&f.spec.id, k, condition, f.frames) {
                    accepted.push((f.spec.id.clone(), f.spec.effects));
                }
            }
            // Recorded votes: the same per-division timers, keyed apart from
            // the functions, recorded at their first qualification only.
            for m in &self.monitors {
                let i = family(&m.family).ok_or("family")?;
                let condition = voted(i, m.side)? == Vote::Satisfied;
                let key = format!("monitor {}", m.id);
                if self.divisions[d].qualify(&key, k, condition, m.frames)
                    && !self.divisions[d].monitors.contains_key(&m.id)
                {
                    self.divisions[d].monitors.insert(m.id.clone(), t);
                    self.log.push(
                        json!({"t_s": t, "frame": k, "division": self.divisions[d].supply,
                        "event": "monitor qualified", "monitor": m.id}),
                    );
                }
            }
            for (id, e) in accepted {
                if self.divisions[d].accept(&id, k, t, e) {
                    self.log.push(
                        json!({"t_s": t, "frame": k, "division": self.divisions[d].supply,
                        "event": "cause accepted", "function": id}),
                    );
                }
            }
        }
        // The holding chain from the divisions' actual outputs.
        for d in 0..3 {
            let request = self.divisions[d].trip.is_some();
            let c = &mut self.holding.contacts[d];
            let was = c.closed();
            c.supplied = self.divisions[d].powered;
            c.requested_open = request;
            if was != c.closed() {
                self.log.push(
                    json!({"t_s": t, "frame": k, "event": "contact", "contact": c.id,
                    "closed": c.closed()}),
                );
            }
        }
        Ok(self.holding.update(t).map(|_| {
            self.holding_lost_frame = Some(k);
            self.log.push(
                json!({"t_s": t, "frame": k, "event": format!("{} loss", self.interface),
                "closed_contacts": self.holding.closed_contacts()}),
            );
            k
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A section shaped as the compiler emits it, with the PZR pressure
    /// block's values and the turbine report (test copy; the compiled
    /// section is the authority).
    fn section(extra_functions: Value, extra_families: Value) -> Section {
        section_with(extra_functions, extra_families, json!([]))
    }
    fn section_with(extra_functions: Value, extra_families: Value, monitors: Value) -> Section {
        let mut families = vec![json!({"id": "LD01.PZR.PT", "quantity": "pzr_roof_pressure",
            "channels": [{"id": "LD01.PZR.PT1", "supply": "I1"}, {"id": "LD01.PZR.PT2", "supply": "I2"},
                {"id": "LD01.PZR.PT3", "supply": "I3"}],
            "channel": {"lag_s": 0.2, "min": 0., "max": 2e7, "quantum": 1000., "indeterminate_band": null, "sample_s": 0.1, "transport_s": 0.1},
            "maximum_age_s": 0.3, "recovery_s": 1.})];
        families.extend(extra_families.as_array().unwrap().iter().cloned());
        let reset = json!({"band": [13.5e6, 15.2e6], "duration_s": 5.});
        let mut functions = vec![
            json!({"id": "LD01.PROT.PZR.HIGH_PRESSURE", "rule": {"voted": {"family": "LD01.PZR.PT",
                "side": {"at_or_above": 15.5e6}, "qualification_s": 0.2}},
                "effects": {"reactor_trip": true, "cmt_injection": false, "heater_isolation": true, "prhr": false}, "reset": reset}),
            json!({"id": "LD01.PROT.PZR.LOW_PRESSURE", "rule": {"voted": {"family": "LD01.PZR.PT",
                "side": {"at_or_below": 13e6}, "qualification_s": 0.5}},
                "effects": {"reactor_trip": true, "cmt_injection": true, "heater_isolation": false, "prhr": true}, "reset": reset}),
            json!({"id": "LD01.PROT.PZR.PRESSURE.UNAVAILABLE", "rule": {"unavailable": {"family": "LD01.PZR.PT",
                "qualification_s": 1.}},
                "effects": {"reactor_trip": true, "cmt_injection": false, "heater_isolation": true, "prhr": false}, "reset": reset}),
            json!({"id": "LD01.PROT.TG.TRIP", "rule": {"report": {"report": "LD01.TG.TRIP.REPORT"}},
                "effects": {"reactor_trip": true, "cmt_injection": false, "heater_isolation": false, "prhr": false},
                "reset": null}),
        ];
        functions.extend(extra_functions.as_array().unwrap().iter().cloned());
        serde_json::from_value(json!({
            "identity": "ld01-s3-ic", "frame_s": 0.1, "families": families,
            "reports": [{"id": "LD01.TG.TRIP.REPORT", "source": "turbine_retained_trip", "supply": "ACT.B",
                "sample_s": 0.1, "transport_s": 0.1, "maximum_age_s": 0.3, "recovery_s": 1., "basis": "test"}],
            "functions": functions,
            "monitors": monitors,
            "holding": {"interface": "LD01.TRIP.HOLD", "supply": "LD01.DC.ACT.A", "manual_interrupt": "LD01.TRIP.MANUAL",
                "divisions": ["I1", "I2", "I3"], "contacts": ["LD01.TRIP.PERM.I1", "LD01.TRIP.PERM.I2", "LD01.TRIP.PERM.I3"]},
            "turbine_trip_on_reactor_trip": {"cause": "LD01.TG.REACTOR_TRIP", "delay_s": 5., "basis": "test"},
            "missing": [], "provenance": []
        }))
        .unwrap()
    }
    fn pressure(p: f64) -> impl Fn(&Quantity) -> Result<f64, String> {
        move |q| match q {
            Quantity::PzrRoofPressure => Ok(p),
            Quantity::LoopFlow { .. } => Ok(1.),
            Quantity::PzrLevel { .. } => Ok(6.0),
            _ => Ok(5.),
        }
    }
    /// Run frames `from..to` with the quantity held at `p(k)` between them.
    fn run(prot: &mut Protection, from: u64, to: u64, p: impl Fn(u64) -> f64) -> Option<u64> {
        let mut lost = None;
        for k in from..to {
            if k > from {
                // Exact step from the previous frame: a constant over 0.1 s.
                prot.advance(&Quantity::PzrRoofPressure, 0.1, &[p(k)])
                    .unwrap();
            }
            if let Some(l) = prot.frame(k).unwrap() {
                lost.get_or_insert(l);
            }
        }
        lost
    }

    #[test]
    fn a_restored_snapshot_continues_bitwise() {
        // S5 snapshot hook: low pressure half qualified (lagged channels in
        // flight), then a copy restored into a fresh protection of the same
        // section continues exactly as its source.
        let fresh = || Protection::new(&section(json!([]), json!([])), pressure(12.9e6)).unwrap();
        let mut source = fresh();
        assert_eq!(run(&mut source, 5220, 5224, |_| 12.95e6), None);
        let snapshot = source.snapshot().unwrap();
        let mut copy = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        copy.restore(&snapshot).unwrap();
        assert_eq!(copy.snapshot().unwrap(), snapshot);
        let p = |k: u64| 12.9e6 - 1e3 * (k - 5224) as f64;
        // Both continue from frame 5224 (5223 was the last observed).
        let continued = |prot: &mut Protection| {
            prot.advance(&Quantity::PzrRoofPressure, 0.1, &[p(5224)])
                .unwrap();
            run(prot, 5224, 5240, p)
        };
        assert_eq!(continued(&mut source), continued(&mut copy));
        assert_eq!(source.snapshot().unwrap(), copy.snapshot().unwrap());
        assert!(
            source.holding.lost_at.is_some(),
            "the copy point lies before the trip"
        );
        // Another section's layout refuses.
        let mut other = Protection::new(
            &section(json!([]), json!([{"id": "LD01.SG.A.LT.NR", "quantity": {"sg_collapsed_level": {"sg": "A", "area_m2": 12.}},
                "channels": [{"id": "N1", "supply": "I1"}, {"id": "N2", "supply": "I2"}, {"id": "N3", "supply": "I3"}],
                "channel": {"lag_s": 0.2, "min": null, "max": null, "quantum": null, "indeterminate_band": null, "sample_s": 0.1, "transport_s": 0.1},
                "maximum_age_s": 0.3, "recovery_s": 1.}])),
            pressure(15.2e6),
        )
        .unwrap();
        assert!(other.restore(&snapshot).is_err());
    }

    #[test]
    fn quiet_evidence_trips_nothing() {
        let mut prot =
            Protection::new(&section(json!([]), json!([])), pressure(15.5e6 - 3e5)).unwrap();
        assert_eq!(run(&mut prot, 5220, 5300, |_| 15.2e6), None);
        assert!(prot.divisions.iter().all(|d| d.causes.is_empty()));
        assert!(prot.holding.voltage_available());
    }

    #[test]
    fn a_turbine_trip_between_frames_opens_the_holding_at_the_delivery_frame() {
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        assert_eq!(run(&mut prot, 5220, 5221, |_| 15.2e6), None);
        // TRIP at 522.05 s: sampled at 522.1 (frame 5221), delivered and
        // decided at 522.2 (frame 5222), learned when frame 5221 is observed.
        prot.turbine_trip(522.05);
        assert_eq!(prot.frame(5221).unwrap(), Some(5222));
        for d in &prot.divisions {
            let c = d.trip.as_ref().unwrap();
            assert_eq!((c.function.as_str(), c.frame), ("LD01.PROT.TG.TRIP", 5222));
            // R12-A1: a turbine-trip reactor trip requests no PRHR.
            assert!(d.requests.is_empty(), "{:?}", d.requests);
        }
        assert_eq!(prot.holding.lost_at, Some(522.2));
        // A trip exactly at a frame instant is seen by the next acquisition
        // (acquisition reads the left limit): 0.2 s.
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        prot.turbine_trip(522.0);
        assert_eq!(run(&mut prot, 5220, 5230, |_| 15.2e6), Some(5222));
    }

    #[test]
    fn low_pressure_qualifies_for_half_a_second_on_lagged_evidence() {
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(12.9e6)).unwrap();
        // At 12.9 MPa from the start: first acquisition at 5220, delivered
        // and first true at 5221; 0.5 s later at 5226.
        let lost = run(&mut prot, 5220, 5240, |_| 12.9e6);
        assert_eq!(lost, Some(5226));
        let d = &prot.divisions[0];
        assert_eq!(
            d.trip.as_ref().unwrap().function,
            "LD01.PROT.PZR.LOW_PRESSURE"
        );
        assert!(d.requests.iter().any(|r| r["request"] == "CMT injection"));
        // R12-A1: CMT actuation requests PRHR.
        assert!(d.requests.iter().any(|r| r["request"] == "PRHR"));
        // High pressure needs 0.2 s: from 15.6 MPa, true at 5221, at 5223.
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.6e6)).unwrap();
        assert_eq!(run(&mut prot, 5220, 5240, |_| 15.6e6), Some(5223));
    }

    #[test]
    fn the_reactor_trip_requests_the_turbine_trip_five_seconds_later_once() {
        // R12-A2. High pressure from the start: holding lost at 5223, so the
        // turbine trip is due at 5273 (50 frames), learned when 5272 is
        // observed, once.
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.6e6)).unwrap();
        assert_eq!(run(&mut prot, 5220, 5224, |_| 15.6e6), Some(5223));
        let due: Vec<_> = (5224..5300)
            .filter_map(|k| prot.turbine_trip_due(k))
            .collect();
        assert_eq!(due, vec![(5273, "LD01.TG.REACTOR_TRIP".to_string())]);
        assert_eq!(prot.turbine_trip_due(5273), None, "requested once");
        // A turbine already tripped (C2's order): no request.
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        prot.turbine_trip(522.05);
        assert_eq!(run(&mut prot, 5220, 5230, |_| 15.2e6), Some(5222));
        assert!((5222..5400).all(|k| prot.turbine_trip_due(k).is_none()));
        // No holding loss: never.
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        run(&mut prot, 5220, 5300, |_| 15.2e6);
        assert!((5220..5400).all(|k| prot.turbine_trip_due(k).is_none()));
    }

    #[test]
    fn a_brief_excursion_does_not_latch_and_a_latched_cause_stays() {
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.6e6)).unwrap();
        // True at 5221 and 5222 only (acquired at 5220, 5221), then normal:
        // 0.1 s of truth is not 0.2 s.
        let lost = run(&mut prot, 5220, 5240, |k| {
            if k <= 5221 { 15.6e6 } else { 15.0e6 }
        });
        // The lag carries the indication down within one sample: check
        // nothing latched.
        assert_eq!(lost, None, "{:?}", prot.log);
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.6e6)).unwrap();
        assert_eq!(run(&mut prot, 5220, 5224, |_| 15.6e6), Some(5223));
        run(&mut prot, 5224, 5260, |_| 15.0e6);
        assert!(
            prot.divisions
                .iter()
                .all(|d| d.latched("LD01.PROT.PZR.HIGH_PRESSURE"))
        );
    }

    #[test]
    fn two_lost_channels_qualify_the_unavailable_cause_after_one_second() {
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        run(&mut prot, 5220, 5230, |_| 15.2e6);
        prot.channel_mut("LD01.PZR.PT1").unwrap().set_powered(false);
        prot.channel_mut("LD01.PZR.PT2").unwrap().set_powered(false);
        // The decision of 5230 was taken when frame 5229 was observed,
        // before this loss: a support change between frames reaches the
        // next undecided frame, 5231. Fewer than two usable from 5231 for
        // 1 s: 5241.
        let lost = run(&mut prot, 5230, 5260, |_| 15.2e6);
        assert_eq!(lost, Some(5241));
        assert_eq!(
            prot.divisions[2].trip.as_ref().unwrap().function,
            "LD01.PROT.PZR.PRESSURE.UNAVAILABLE"
        );
    }

    #[test]
    fn contrary_cases_one_division_unavailable_or_one_contact_stuck_closed() {
        use crate::ic::holding::Stuck;
        // One division out of service: its contact opens, the two others
        // must both permit; the trip still releases (both trip).
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        prot.set_division_power(1, false);
        assert_eq!(
            run(&mut prot, 5220, 5221, |_| 15.2e6),
            None,
            "degraded, holding"
        );
        prot.turbine_trip(522.05);
        assert_eq!(run(&mut prot, 5221, 5230, |_| 15.2e6), Some(5222));
        assert!(
            prot.divisions[1].trip.is_none(),
            "a dead division records nothing"
        );
        // One contact stuck closed: the other two interrupt.
        let mut prot = Protection::new(&section(json!([]), json!([])), pressure(15.2e6)).unwrap();
        prot.holding.contacts[0].stuck = Some(Stuck::Closed);
        prot.turbine_trip(522.05);
        assert_eq!(run(&mut prot, 5220, 5230, |_| 15.2e6), Some(5222));
        assert_eq!(prot.holding.closed_contacts(), 1);
    }

    #[test]
    fn an_armed_single_channel_function_needs_its_arming_vote() {
        // Loop low flow's shape: one FT in fractions of nominal, armed by a
        // three-channel vote (test arming on the PT family).
        let flow = json!([{"id": "FT.A", "quantity": {"loop_flow": {"loop_id": "A", "face": 0, "face_id": "RETURN.A->DOWN",
            "nominal_kg_s": 8849., "quantum_kg_s": 5., "indeterminate_band_kg_s": 10.}},
            "channels": [{"id": "FT.A", "supply": "I1"}],
            "channel": {"lag_s": 0.25, "min": -1.5, "max": 1.5, "quantum": null, "indeterminate_band": null, "sample_s": 0.1, "transport_s": 0.1},
            "maximum_age_s": 0.3, "recovery_s": 1.}]);
        let low = json!([{"id": "LOW_FLOW.A", "rule": {"armed": {"family": "FT.A", "side": {"at_or_below": 0.7},
            "qualification_s": 0.5, "arming_family": "LD01.PZR.PT", "arming": {"at_or_above": 1e6}}},
            "effects": {"reactor_trip": true, "cmt_injection": false, "heater_isolation": false, "prhr": false},
            "reset": {"band": [0.8, 1.5], "duration_s": 5.}}]);
        let ft: Quantity = serde_json::from_value(flow[0]["quantity"].clone()).unwrap();
        // Unresolved nominal: refused.
        let mut unresolved = flow.clone();
        unresolved[0]["quantity"]["loop_flow"]["nominal_kg_s"] = Value::Null;
        assert!(Protection::new(&section(low.clone(), unresolved), pressure(15.2e6)).is_err());
        let mut prot = Protection::new(&section(low, flow), pressure(15.2e6)).unwrap();
        let lost = {
            let mut lost = None;
            for k in 5220..5240 {
                if k > 5220 {
                    prot.advance(&ft, 0.1, &[0.5]).unwrap();
                    prot.advance(&Quantity::PzrRoofPressure, 0.1, &[15.2e6])
                        .unwrap();
                }
                if let Some(l) = prot.frame(k).unwrap() {
                    lost.get_or_insert(l);
                }
            }
            lost
        };
        assert!(lost.is_some());
        assert_eq!(
            prot.divisions[0].trip.as_ref().unwrap().function,
            "LOW_FLOW.A"
        );
    }

    #[test]
    fn a_monitor_records_its_vote_and_trips_nothing() {
        // The PZR LT family (test values shaped as the proposed blocks) and
        // C2.N3's vote: <= 3.00 m for 0.5 s, recorded only.
        let lt = json!([{"id": "LD01.PZR.LT", "quantity": {"pzr_level": {"calibration_pressure_pa": 15e6, "interface_span_pa": [0., 25e6]}},
            "channels": [{"id": "LD01.PZR.LT1", "supply": "I1"}, {"id": "LD01.PZR.LT2", "supply": "I2"},
                {"id": "LD01.PZR.LT3", "supply": "I3"}],
            "channel": {"lag_s": 0.5, "min": -1., "max": 13., "quantum": 0.01, "indeterminate_band": null, "sample_s": 0.1, "transport_s": 0.1},
            "maximum_age_s": 0.3, "recovery_s": 1.}]);
        let monitor = json!([{"id": "C2.N3 PZR LT vote", "rule": {"voted": {"family": "LD01.PZR.LT",
            "side": {"at_or_below": 3.0}, "qualification_s": 0.5}}, "basis": "test"}]);
        let mut prot = Protection::new(
            &section_with(json!([]), lt.clone(), monitor.clone()),
            pressure(15.2e6),
        )
        .unwrap();
        let level = Quantity::PzrLevel {
            calibration_pressure_pa: 15e6,
            interface_span_pa: [0., 25e6],
        };
        let mut lost = None;
        for k in 5220..5260 {
            if k > 5220 {
                // Level falls to 2.0 m over the run (held per interval).
                let l = if k < 5230 { 6.0 } else { 2.0 };
                prot.advance(&level, 0.1, &[l]).unwrap();
                prot.advance(&Quantity::PzrRoofPressure, 0.1, &[15.2e6])
                    .unwrap();
            }
            lost = lost.or(prot.frame(k).unwrap());
        }
        assert_eq!(lost, None, "a monitor has no output");
        assert!(
            prot.divisions
                .iter()
                .all(|d| d.causes.is_empty() && d.trip.is_none())
        );
        let first = prot.divisions[0].monitors["C2.N3 PZR LT vote"];
        // The level is 2.0 m from the interval ending at 5230: after n such
        // intervals the 0.5 s lag reads 2 + 4 e^{-0.2 n}, at most 3.00 m from
        // n = 7, acquired at 5236, delivered at 5237, qualified 0.5 s later
        // at 5242.
        assert_eq!(first, prot.frame_of().instant(5242));
        assert!(prot.log.iter().any(|e| e["event"] == "monitor qualified"));
        // A monitor must be a voted rule on a family of the section.
        let bad = json!([{"id": "x", "rule": {"voted": {"family": "NONE", "side": {"at_or_below": 3.0},
            "qualification_s": 0.5}}, "basis": "test"}]);
        assert!(Protection::new(&section_with(json!([]), lt, bad), pressure(15.2e6)).is_err());
    }
}

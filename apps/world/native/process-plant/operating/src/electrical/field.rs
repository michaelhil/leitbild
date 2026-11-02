//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/generator-and-synchronization.md#field-supply-loss-and-control-power-failure
//! The ACT.B field controller's field-supply-loss protection (ICFIELD):
//! while the generator is reported connected, connection is pending, or
//! connection evidence is unavailable, a reported loss of delivered AC
//! converter supply, or an OFF/dump field, withdraws CLOSE and requests
//! generator OPEN plus a turbine trip at the next powered decision, with
//! no additional qualification. Unusable field reports within that
//! exposure produce the same requests with a distinct evidence-unavailable
//! cause; a usable OPEN report with no pending CLOSE initiates nothing.
//!
//! **Reports.** The converter motive-supply and field-switch reports, and
//! the `LD01.TG.GEN.BREAKER` contact/pending report the controller reads as
//! connection evidence, are sampled and transported in whole frames of the
//! I&C frame ([`Frame`]) with their maximum acquisition ages, every value
//! from the generator page's `ld01-generator-field-protection` block
//! through the electrical compiler. Acquisition reads the equipment state
//! at the frame's left limit; a decision reads only delivered evidence.
//! With transport of at least one frame, the decision of frame `k + 1` is
//! fully determined once frame `k` is acquired (as IC-PROT's divisions).
//!
//! **Start.** Before a report's first delivery its evidence is not yet
//! established (IC-PROT's `Standing::Never`): it is neither usable nor
//! lost, so no request follows from it. Evidence once delivered and then
//! older than its maximum age (or held in transport) is unavailable.
//!
//! **Retention.** An initiation is retained (S3 requests no reset; the
//! page's reset needs usable evidence of achieved OPEN, which no S3 case
//! asks for). The controller decides nothing more after it.
//!
//! Cause identities are constructed here (the page names the equipment,
//! not the causes): [`SUPPLY_LOSS`], [`OFF_OR_DUMP`],
//! [`EVIDENCE_UNAVAILABLE`]. The controller's ACT.B supply is not routed
//! in S3: it stays powered unless a caller removes it.
use crate::ic::{
    Frame,
    acquisition::{
        Delivery, restored_bool, restored_frame, restored_frame_option, restored_real,
        snapshot_fields, snapshot_real,
    },
};
use serde_json::{Value, json};

pub const SUPPLY_LOSS: &str = "LD01.TG.GEN.FIELD.SUPPLY_LOSS";
pub const OFF_OR_DUMP: &str = "LD01.TG.GEN.FIELD.OFF";
pub const EVIDENCE_UNAVAILABLE: &str = "LD01.TG.GEN.FIELD.EVIDENCE_UNAVAILABLE";
/// The controller's requests at an initiation, in the page's words.
pub const REQUESTS: [&str; 3] = ["withdraw CLOSE", "LD01.TG.GEN.BREAKER OPEN", "LD01.TG TRIP"];

/// The `ld01-generator-field-protection` block as the electrical compiler
/// emits it (packet `fieldProtection`).
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    #[serde(rename = "reportSample_s")]
    pub report_sample_s: f64,
    #[serde(rename = "reportTransport_s")]
    pub report_transport_s: f64,
    #[serde(rename = "reportMaximumAge_s")]
    pub report_maximum_age_s: f64,
    #[serde(rename = "additionalQualification_s")]
    pub additional_qualification_s: f64,
    #[serde(rename = "connectionReportSample_s")]
    pub connection_sample_s: f64,
    #[serde(rename = "connectionReportTransport_s")]
    pub connection_transport_s: f64,
    #[serde(rename = "connectionReportMaximumAge_s")]
    pub connection_maximum_age_s: f64,
}

/// The field converter's reported state (`LD01.TG.GEN.FIELD`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldReport {
    /// Delivered AC motive supply at the converter.
    pub converter_supplied: bool,
    /// An OFF/dump request or an achieved OFF/dump position.
    pub off_or_dump: bool,
}

/// The generator breaker's reported state (`LD01.TG.GEN.BREAKER`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectionReport {
    pub closed: bool,
    pub pending_close: bool,
}

/// A retained initiation.
#[derive(Clone, Debug, PartialEq)]
pub struct Initiation {
    pub cause: &'static str,
    pub frame: u64,
    pub at_s: f64,
}

struct Channel<T: Copy> {
    delivery: Delivery<T>,
    max_age_frames: u64,
    /// Injected transport hold (a fault): nothing new is delivered.
    hold: bool,
}
impl<T: Copy> Channel<T> {
    fn new(frame: Frame, sample_s: f64, transport_s: f64, age_s: f64) -> Result<Self, String> {
        let delivery = Delivery::new(frame.frames_in(sample_s)?, frame.frames_in(transport_s)?)?;
        let max_age_frames = frame.frames_in(age_s)?;
        if delivery.transport_frames == 0 || max_age_frames < delivery.transport_frames {
            return Err(format!(
                "a report needs a transport of at least one frame and an age of at least its transport ({transport_s} s, {age_s} s)"
            ));
        }
        Ok(Self {
            delivery,
            max_age_frames,
            hold: false,
        })
    }
    fn acquire(&mut self, k: u64, value: T) {
        if self.delivery.due(k) {
            self.delivery.send(k, value, self.hold);
        }
    }
    /// The evidence at decision frame `k`: `Ok(value)` usable, `Err(true)`
    /// established and now unavailable, `Err(false)` not yet established.
    fn evidence(&mut self, k: u64) -> Result<T, bool> {
        self.delivery.deliver(k, self.hold);
        match self.delivery.delivered() {
            None => Err(false),
            Some(s) if k - s.acquired <= self.max_age_frames => Ok(s.value),
            Some(_) => Err(true),
        }
    }
}

pub struct FieldProtection {
    frame: Frame,
    field: Channel<FieldReport>,
    connection: Channel<ConnectionReport>,
    /// The controller's ACT.B supply: an unpowered controller decides
    /// nothing (it cannot execute a new software trip).
    pub powered: bool,
    decided: Option<u64>,
    pub initiated: Option<Initiation>,
    /// Accepted causes, in order (receipts).
    pub log: Vec<Value>,
}

impl FieldProtection {
    pub fn new(parameters: &Parameters, frame: Frame) -> Result<Self, String> {
        let p = parameters;
        if p.additional_qualification_s != 0. {
            return Err(format!(
                "the field controller selects no additional qualification, not {} s",
                p.additional_qualification_s
            ));
        }
        Ok(Self {
            frame,
            field: Channel::new(
                frame,
                p.report_sample_s,
                p.report_transport_s,
                p.report_maximum_age_s,
            )?,
            connection: Channel::new(
                frame,
                p.connection_sample_s,
                p.connection_transport_s,
                p.connection_maximum_age_s,
            )?,
            powered: true,
            decided: None,
            initiated: None,
            log: Vec::new(),
        })
    }
    pub fn frame_of(&self) -> Frame {
        self.frame
    }
    /// Injected transport holds of the field and connection reports.
    pub fn set_transport_hold(&mut self, field: bool, connection: bool) {
        self.field.hold = field;
        self.connection.hold = connection;
    }
    /// Frame `k` with the equipment's state at its left limit: decide `k`
    /// if not yet decided (the start), acquire at `k`, then decide `k + 1`.
    /// Returns the frame of an initiation decided now.
    pub fn frame(
        &mut self,
        k: u64,
        field: FieldReport,
        connection: ConnectionReport,
    ) -> Result<Option<u64>, String> {
        let mut initiated = None;
        if self.decided.is_none_or(|d| d < k) {
            initiated = self.decide(k)?;
        }
        if self.powered {
            self.field.acquire(k, field);
            self.connection.acquire(k, connection);
        }
        Ok(initiated.or(self.decide(k + 1)?))
    }
    /// S5 snapshot hook (WORLD `ld01-unit`; ELEC reconciles): both report
    /// channels (delivery and transport hold), the supply, the last decided
    /// frame and the retained initiation, exact. The timing is the packet's,
    /// recomposed on restore; the log is a receipt.
    pub fn snapshot(&self) -> Value {
        let field = |r: &FieldReport| json!({"converter_supplied": r.converter_supplied, "off_or_dump": r.off_or_dump});
        let connection =
            |r: &ConnectionReport| json!({"closed": r.closed, "pending_close": r.pending_close});
        json!({"field": {"delivery": self.field.delivery.snapshot(field), "hold": self.field.hold},
            "connection": {"delivery": self.connection.delivery.snapshot(connection), "hold": self.connection.hold},
            "powered": self.powered, "decided": self.decided,
            "initiated": self.initiated.as_ref().map(|i| json!([i.cause, i.frame, snapshot_real(i.at_s)]))})
    }
    /// Restore [`FieldProtection::snapshot`] exactly; anything else refuses.
    pub fn restore(&mut self, v: &Value) -> Result<(), String> {
        let o = snapshot_fields(
            v,
            "field controller",
            &["field", "connection", "powered", "decided", "initiated"],
        )?;
        let field = |r: &Value| -> Result<FieldReport, String> {
            let f = snapshot_fields(r, "field report", &["converter_supplied", "off_or_dump"])?;
            Ok(FieldReport {
                converter_supplied: restored_bool(&f["converter_supplied"], "converter supply")?,
                off_or_dump: restored_bool(&f["off_or_dump"], "field OFF/dump")?,
            })
        };
        let connection = |r: &Value| -> Result<ConnectionReport, String> {
            let f = snapshot_fields(r, "connection report", &["closed", "pending_close"])?;
            Ok(ConnectionReport {
                closed: restored_bool(&f["closed"], "breaker closed")?,
                pending_close: restored_bool(&f["pending_close"], "pending close")?,
            })
        };
        let f = snapshot_fields(&o["field"], "field channel", &["delivery", "hold"])?;
        let c = snapshot_fields(
            &o["connection"],
            "connection channel",
            &["delivery", "hold"],
        )?;
        let initiated = match o["initiated"].as_array().map(Vec::as_slice) {
            None if o["initiated"].is_null() => None,
            Some([cause, frame, at]) => Some(Initiation {
                cause: [SUPPLY_LOSS, OFF_OR_DUMP, EVIDENCE_UNAVAILABLE]
                    .into_iter()
                    .find(|c| cause.as_str() == Some(*c))
                    .ok_or_else(|| format!("field controller cause {cause}"))?,
                frame: restored_frame(frame, "initiation frame")?,
                at_s: restored_real(at, "initiation time")?,
            }),
            _ => return Err(format!("field controller initiation {}", o["initiated"])),
        };
        self.field.delivery.restore(&f["delivery"], field)?;
        self.connection
            .delivery
            .restore(&c["delivery"], connection)?;
        self.field.hold = restored_bool(&f["hold"], "field transport hold")?;
        self.connection.hold = restored_bool(&c["hold"], "connection transport hold")?;
        self.powered = restored_bool(&o["powered"], "field controller supply")?;
        self.decided = restored_frame_option(&o["decided"], "field controller decided frame")?;
        self.initiated = initiated;
        Ok(())
    }
    fn decide(&mut self, k: u64) -> Result<Option<u64>, String> {
        if self.decided.is_some_and(|d| d >= k) {
            return Err(format!("field controller frame {k} decided twice"));
        }
        self.decided = Some(k);
        let (field, connection) = (self.field.evidence(k), self.connection.evidence(k));
        if !self.powered || self.initiated.is_some() {
            return Ok(None);
        }
        // Connection exposure: reported connected or pending, or connection
        // evidence unavailable; not yet established decides nothing.
        let exposed = match connection {
            Ok(c) => c.closed || c.pending_close,
            Err(lost) => lost,
        };
        let cause = match field {
            _ if !exposed => None,
            Ok(f) if !f.converter_supplied => Some(SUPPLY_LOSS),
            Ok(f) if f.off_or_dump => Some(OFF_OR_DUMP),
            Ok(_) => None,
            Err(true) => Some(EVIDENCE_UNAVAILABLE),
            Err(false) => None,
        };
        let Some(cause) = cause else {
            return Ok(None);
        };
        let at_s = self.frame.instant(k);
        self.initiated = Some(Initiation {
            cause,
            frame: k,
            at_s,
        });
        self.log.push(
            json!({"t_s": at_s, "frame": k, "controller": "LD01.TG.GEN.FIELD (ACT.B)",
            "event": "cause accepted", "function": cause, "requests": REQUESTS,
            "evidence": {"field": format!("{field:?}"), "connection": format!("{connection:?}")}}),
        );
        Ok(Some(k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parameters() -> Parameters {
        // Test copy of the proposed block's values (the compiled packet is
        // the authority).
        serde_json::from_value(json!({"reportSample_s": 0.1, "reportTransport_s": 0.1,
            "reportMaximumAge_s": 0.3, "additionalQualification_s": 0, "connectionReportSample_s": 0.1,
            "connectionReportTransport_s": 0.1, "connectionReportMaximumAge_s": 2}))
        .unwrap()
    }
    fn controller() -> FieldProtection {
        FieldProtection::new(&parameters(), Frame::new(0.1).unwrap()).unwrap()
    }
    const HEALTHY: FieldReport = FieldReport {
        converter_supplied: true,
        off_or_dump: false,
    };
    const LOST: FieldReport = FieldReport {
        converter_supplied: false,
        off_or_dump: false,
    };
    const CLOSED: ConnectionReport = ConnectionReport {
        closed: true,
        pending_close: false,
    };
    const OPEN: ConnectionReport = ConnectionReport {
        closed: false,
        pending_close: false,
    };
    /// Frames `from..to` with the state at each frame's left limit.
    fn run(
        c: &mut FieldProtection,
        from: u64,
        to: u64,
        state: impl Fn(u64) -> (FieldReport, ConnectionReport),
    ) -> Option<u64> {
        let mut first = None;
        for k in from..to {
            let (f, b) = state(k);
            if let Some(d) = c.frame(k, f, b).unwrap() {
                first.get_or_insert(d);
            }
        }
        first
    }

    #[test]
    fn a_supply_loss_between_frames_requests_open_and_trip_one_frame_after_its_acquisition() {
        // The LOOP at 599.37 s: frame 5994 (599.4) acquires the loss, frame
        // 5995 (599.5) decides on it: +0.13 s, with no qualification.
        let mut c = controller();
        let loss = 599.37;
        let at = |k: u64| if c_instant(k) > loss { LOST } else { HEALTHY };
        assert_eq!(run(&mut c, 5900, 6000, |k| (at(k), CLOSED)), Some(5995));
        let i = c.initiated.clone().unwrap();
        assert_eq!((i.cause, i.frame), (SUPPLY_LOSS, 5995));
        assert_eq!(i.at_s, Frame::new(0.1).unwrap().instant(5995));
        assert_eq!(c.log.len(), 1, "retained: one initiation");
        assert_eq!(c.log[0]["requests"][2], "LD01.TG TRIP");
        // A loss exactly at a frame instant is seen by the next acquisition
        // (the left limit at 599.4 is still supplied): +0.2 s.
        let mut c = controller();
        let loss = c_instant(5994);
        let at = |k: u64| if c_instant(k) > loss { LOST } else { HEALTHY };
        assert_eq!(run(&mut c, 5900, 6000, |k| (at(k), CLOSED)), Some(5996));
    }
    fn c_instant(k: u64) -> f64 {
        Frame::new(0.1).unwrap().instant(k)
    }

    #[test]
    fn a_usable_open_report_without_pending_close_initiates_nothing() {
        let mut c = controller();
        assert_eq!(run(&mut c, 100, 200, |_| (LOST, OPEN)), None);
        // An unusable field report with the breaker reported open: nothing.
        let mut c = controller();
        run(&mut c, 100, 110, |_| (HEALTHY, OPEN));
        c.set_transport_hold(true, false);
        assert_eq!(run(&mut c, 110, 200, |_| (HEALTHY, OPEN)), None);
        // Pending CLOSE is exposure.
        let mut c = controller();
        let pending = ConnectionReport {
            closed: false,
            pending_close: true,
        };
        assert_eq!(run(&mut c, 100, 200, |_| (LOST, pending)), Some(101));
        // An OFF/dump field while connected.
        let mut c = controller();
        let off = FieldReport {
            converter_supplied: true,
            off_or_dump: true,
        };
        assert_eq!(run(&mut c, 100, 200, |_| (off, CLOSED)), Some(101));
        assert_eq!(c.initiated.unwrap().cause, OFF_OR_DUMP);
    }

    #[test]
    fn lost_evidence_while_exposed_has_its_own_cause_and_unestablished_evidence_none() {
        // Field reports held from frame 110: the last delivery (acquired at
        // 109, delivered at 110) ages past 0.3 s at frame 113.
        let mut c = controller();
        run(&mut c, 100, 110, |_| (HEALTHY, CLOSED));
        c.set_transport_hold(true, false);
        assert_eq!(run(&mut c, 110, 200, |_| (HEALTHY, CLOSED)), Some(113));
        assert_eq!(c.initiated.unwrap().cause, EVIDENCE_UNAVAILABLE);
        // Connection evidence lost (2 s age) with a supplied field: no
        // request; then a supply loss while connection evidence is
        // unavailable is exposure.
        let mut c = controller();
        run(&mut c, 100, 110, |_| (HEALTHY, CLOSED));
        c.set_transport_hold(false, true);
        assert_eq!(run(&mut c, 110, 140, |_| (HEALTHY, OPEN)), None);
        assert_eq!(run(&mut c, 140, 200, |_| (LOST, OPEN)), Some(141));
        // At the start nothing is established: the first decision on the
        // start frame's acquisition is the next frame's.
        let mut c = controller();
        assert_eq!(run(&mut c, 100, 101, |_| (LOST, CLOSED)), Some(101));
        // An unpowered controller decides nothing.
        let mut c = controller();
        c.powered = false;
        assert_eq!(run(&mut c, 100, 200, |_| (LOST, CLOSED)), None);
    }

    #[test]
    fn the_block_needs_whole_frames_and_selects_no_qualification() {
        let frame = Frame::new(0.1).unwrap();
        let mut p = parameters();
        p.additional_qualification_s = 0.1;
        assert!(FieldProtection::new(&p, frame).is_err());
        let mut p = parameters();
        p.report_transport_s = 0.05;
        assert!(FieldProtection::new(&p, frame).is_err());
        let mut p = parameters();
        p.report_maximum_age_s = 0.;
        assert!(FieldProtection::new(&p, frame).is_err());
        let extra = json!({"reportSample_s": 0.1, "reportTransport_s": 0.1, "reportMaximumAge_s": 0.3,
            "additionalQualification_s": 0, "connectionReportSample_s": 0.1, "connectionReportTransport_s": 0.1,
            "connectionReportMaximumAge_s": 2, "extra": 1});
        assert!(serde_json::from_value::<Parameters>(extra).is_err());
    }
}

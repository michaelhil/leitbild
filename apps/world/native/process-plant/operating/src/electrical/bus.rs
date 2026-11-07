//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/distribution-and-switching.md#sources-and-distribution
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/distribution-and-switching.md#break-before-make-automatic-transfer
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/electrical/distribution-and-switching.md#motor-continuity-and-restart
//! AC.A/AC.B auxiliary routing for the S3 C14 slice: a discrete, event-driven
//! state owner, NOT a motor, pump or protection law. It owns the two source
//! qualifications, the four incoming devices (0.10 s travel), the upstream
//! control-power selection, the break-before-make transfer (open, confirm,
//! 0.30 s interval, recheck, close, confirm), each consumer's contactor with
//! the 1.00 s undervoltage dropout, and the source power accounting (20 kW
//! no-load plus 1 % of delivered power per energized path).
//!
//! Every change happens at an exact known time: an input change the caller
//! applies with [`Distribution::set_source`], or an internal due time from
//! [`Distribution::next_event`] that the caller stops at and processes with
//! [`Distribution::advance`]. The integrator restarts (class R) only where
//! [`Distribution::advance`] reports a change of delivered support.
//!
//! Selected reductions kept explicit: no reactive current, phase-angle
//! switching, residual motor voltage, fault waveform or protection
//! selectivity; the bus budget trip is the page's ideal opening. The exact
//! dropout boundary is processed before a restoration at the same instant
//! ("an interruption of 1.00 second or longer" drops out).
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    #[serde(rename = "voltageMin_pu")]
    pub voltage_min_pu: f64,
    #[serde(rename = "voltageMax_pu")]
    pub voltage_max_pu: f64,
    #[serde(rename = "frequencyMin_Hz")]
    pub frequency_min_hz: f64,
    #[serde(rename = "frequencyMax_Hz")]
    pub frequency_max_hz: f64,
    #[serde(rename = "qualify_s")]
    pub qualify_s: f64,
    #[serde(rename = "disqualify_s")]
    pub disqualify_s: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    #[serde(rename = "incomingTravel_s")]
    pub incoming_travel_s: f64,
    #[serde(rename = "transferOpenInterval_s")]
    pub open_interval_s: f64,
    #[serde(rename = "motorDropout_s")]
    pub motor_dropout_s: f64,
    pub qualification: Qualification,
    #[serde(rename = "conversionNoLoadLoss_W")]
    pub no_load_loss_w: f64,
    #[serde(rename = "conversionLoadLossFraction")]
    pub load_loss_fraction: f64,
    #[serde(rename = "sourceBudget_W")]
    pub source_budget_w: f64,
    #[serde(rename = "busBudget_W")]
    pub bus_budget_w: f64,
    /// Consumer identity -> "AC.A" | "AC.B" (the page's allocation).
    pub consumers: BTreeMap<String, String>,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub enum Source {
    Unit = 0,
    Reserve = 1,
}
impl Source {
    fn other(self) -> Self {
        match self {
            Self::Unit => Self::Reserve,
            Self::Reserve => Self::Unit,
        }
    }
}

/// Actual state of one source-conversion path at its 10 kV output.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceState {
    pub energized: bool,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub voltage_pu: f64,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    pub frequency_hz: f64,
}
impl SourceState {
    pub const DEAD: Self = Self {
        energized: false,
        voltage_pu: 0.,
        frequency_hz: 0.,
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Contact {
    Open,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Device {
    contact: Contact,
    /// (target, end time) of ordinary travel; contacts change at the end.
    #[serde(with = "crate::joined::block::snapshot_bits_pair_option")]
    travel: Option<(Contact, f64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
enum Transfer {
    Idle,
    Opening {
        to: Source,
    },
    Interval {
        to: Source,
        #[serde(with = "crate::joined::block::snapshot_bits")]
        until: f64,
    },
    Closing {
        to: Source,
    },
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Bus {
    name: String,
    devices: [Device; 2],
    selected: Source,
    transfer: Transfer,
    control: Option<Source>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Qual {
    qualified: bool,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    since: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Motor {
    bus: usize,
    contactor: bool,
    #[serde(with = "crate::joined::block::snapshot_bits_option")]
    lost_since: Option<f64>,
    /// PROC T11: the consumer's own supply is lost (a declared malfunction,
    /// [`Distribution::lose_consumer_supply`]); a START cannot restore it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    supply_lost: bool,
}

/// What a consumer's own law receives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Support {
    pub energized: bool,
    pub contactor_closed: bool,
    pub voltage_pu: f64,
    pub frequency_hz: f64,
}

/// One recorded change, for receipts and restart classification.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub time: f64,
    pub what: String,
    /// True when delivered support of some consumer changed (class R).
    pub support_changed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Distribution {
    pub parameters: Parameters,
    sources: [SourceState; 2],
    qual: [Qual; 2],
    buses: Vec<Bus>,
    motors: BTreeMap<String, Motor>,
    time: f64,
    pub records: Vec<Record>,
}

/// PROC T1–T3 (lane TURB, 1 Nov): the routing's reportable plant state at
/// the processed time, read-only, for the IC channels and the unit host:
/// each bus's routed availability (and the source feeding it), each
/// source's actual state with its qualification, and each incoming device's
/// actual contact with whether its travel is complete.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Reports {
    pub buses: Vec<BusReport>,
    pub sources: [SourceReport; 2],
    pub incoming: Vec<IncomingReport>,
}
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct BusReport {
    pub name: String,
    pub available: bool,
    pub fed_from: Option<Source>,
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct SourceReport {
    pub source: Source,
    pub energized: bool,
    pub voltage_pu: f64,
    pub frequency_hz: f64,
    /// The qualification (voltage and frequency within the band, held for
    /// its qualify time).
    pub qualified: bool,
}
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct IncomingReport {
    pub bus: String,
    pub source: Source,
    pub contact: Contact,
    pub travel_complete: bool,
}

/// S3-D19: the routing's discrete state (sources, qualification runs,
/// buses with their devices, transfers and control, motor contactors and
/// dropout timers, the processed time), exact. The records are receipts,
/// not state, and stay with the running distribution.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    sources: [SourceState; 2],
    qual: [Qual; 2],
    buses: Vec<Bus>,
    motors: BTreeMap<String, Motor>,
    #[serde(with = "crate::joined::block::snapshot_bits")]
    time: f64,
}

impl Distribution {
    pub fn discrete_state(&self) -> State {
        State {
            sources: self.sources,
            qual: self.qual,
            buses: self.buses.clone(),
            motors: self.motors.clone(),
            time: self.time,
        }
    }
    /// Restore [`Distribution::discrete_state`]: the same buses and
    /// consumers on the same buses, refused otherwise.
    pub fn restore_discrete_state(&mut self, state: State) -> Result<(), String> {
        let names = |b: &[Bus]| b.iter().map(|b| b.name.clone()).collect::<Vec<_>>();
        let wiring = |m: &BTreeMap<String, Motor>| {
            m.iter()
                .map(|(k, m)| (k.clone(), m.bus))
                .collect::<Vec<_>>()
        };
        if names(&state.buses) != names(&self.buses)
            || wiring(&state.motors) != wiring(&self.motors)
        {
            return Err("routing snapshot of another bus or consumer layout".into());
        }
        self.sources = state.sources;
        self.qual = state.qual;
        self.buses = state.buses;
        self.motors = state.motors;
        self.time = state.time;
        Ok(())
    }
    /// Normal initial alignment at `t0`: unit source on both buses, reserve
    /// incoming open, every listed consumer running with a closed contactor;
    /// each source's qualification is its prepared retained state.
    pub fn prepared(
        parameters: Parameters,
        sources: [SourceState; 2],
        qualified: [bool; 2],
        t0: f64,
    ) -> Result<Self, String> {
        let p = &parameters;
        let q = p.qualification;
        let positive = [
            p.incoming_travel_s,
            p.open_interval_s,
            p.motor_dropout_s,
            q.qualify_s,
            q.disqualify_s,
            p.source_budget_w,
            p.bus_budget_w,
        ];
        if positive.iter().any(|v| !v.is_finite() || *v <= 0.)
            || !(p.no_load_loss_w >= 0. && (0. ..1.).contains(&p.load_loss_fraction))
            || !(q.voltage_min_pu < q.voltage_max_pu && q.frequency_min_hz < q.frequency_max_hz)
        {
            return Err("AC distribution parameters out of domain".into());
        }
        let names = ["AC.A", "AC.B"];
        let buses = names
            .iter()
            .map(|n| Bus {
                name: (*n).into(),
                devices: [
                    Device {
                        contact: Contact::Closed,
                        travel: None,
                    },
                    Device {
                        contact: Contact::Open,
                        travel: None,
                    },
                ],
                selected: Source::Unit,
                transfer: Transfer::Idle,
                control: None,
            })
            .collect();
        let mut motors = BTreeMap::new();
        for (id, bus) in &p.consumers {
            let b = names
                .iter()
                .position(|n| n == bus)
                .ok_or_else(|| format!("consumer {id} on unknown bus {bus}"))?;
            motors.insert(
                id.clone(),
                Motor {
                    bus: b,
                    contactor: true,
                    lost_since: None,
                    supply_lost: false,
                },
            );
        }
        let mut d = Self {
            parameters,
            sources,
            qual: [
                Qual {
                    qualified: qualified[0],
                    since: t0,
                },
                Qual {
                    qualified: qualified[1],
                    since: t0,
                },
            ],
            buses,
            motors,
            time: t0,
            records: vec![],
        };
        d.select_control();
        d.reconcile(t0);
        Ok(d)
    }
    fn acceptable(&self, s: Source) -> bool {
        let x = self.sources[s as usize];
        let q = self.parameters.qualification;
        x.energized
            && (q.voltage_min_pu..=q.voltage_max_pu).contains(&x.voltage_pu)
            && (q.frequency_min_hz..=q.frequency_max_hz).contains(&x.frequency_hz)
    }
    fn usable(&self, s: Source) -> bool {
        self.acceptable(s)
    }
    /// Upstream control power: keep the present usable source, else UNIT, else RESERVE.
    fn select_control(&mut self) {
        for b in 0..self.buses.len() {
            let keep = self.buses[b].control.filter(|s| self.usable(*s));
            self.buses[b].control = keep.or_else(|| {
                [Source::Unit, Source::Reserve]
                    .into_iter()
                    .find(|s| self.usable(*s))
            });
        }
    }
    pub fn bus_energized(&self, b: usize) -> Option<Source> {
        let bus = &self.buses[b];
        [Source::Unit, Source::Reserve].into_iter().find(|s| {
            bus.devices[*s as usize].contact == Contact::Closed
                && self.sources[*s as usize].energized
        })
    }
    /// PROC T1–T3: the reportable plant state at the processed time.
    pub fn reports(&self) -> Reports {
        let sources = [Source::Unit, Source::Reserve].map(|s| {
            let st = self.sources[s as usize];
            SourceReport {
                source: s,
                energized: st.energized,
                voltage_pu: st.voltage_pu,
                frequency_hz: st.frequency_hz,
                qualified: self.qual[s as usize].qualified,
            }
        });
        let buses = (0..self.buses.len())
            .map(|b| {
                let fed = self.bus_energized(b);
                BusReport {
                    name: self.buses[b].name.clone(),
                    available: fed.is_some(),
                    fed_from: fed,
                }
            })
            .collect();
        let incoming = self
            .buses
            .iter()
            .flat_map(|bus| {
                [Source::Unit, Source::Reserve].map(|s| {
                    let d = bus.devices[s as usize];
                    IncomingReport {
                        bus: bus.name.clone(),
                        source: s,
                        contact: d.contact,
                        travel_complete: d.travel.is_none(),
                    }
                })
            })
            .collect();
        Reports {
            buses,
            sources,
            incoming,
        }
    }
    pub fn bus_index(&self, name: &str) -> Option<usize> {
        self.buses.iter().position(|b| b.name == name)
    }
    pub fn support(&self, consumer: &str) -> Option<Support> {
        let m = self.motors.get(consumer)?;
        let feeding = self.bus_energized(m.bus);
        let s = feeding
            .map(|s| self.sources[s as usize])
            .unwrap_or(SourceState::DEAD);
        Some(Support {
            energized: feeding.is_some(),
            contactor_closed: m.contactor,
            voltage_pu: s.voltage_pu,
            frequency_hz: s.frequency_hz,
        })
    }
    /// R4-DUMP: whether the RCPs `consumers` keep forced circulation: any is
    /// supplied, or has its contactor closed on a bus in transfer (the buses
    /// are dead from the GCB's opening to the reserve's closure and the pumps
    /// only coast). A loss of offsite power or a failed transfer ends at Idle
    /// (no control power, or the closure aborted), so the hold ends with it.
    pub fn forced_circulation(&self, consumers: &[String]) -> bool {
        consumers.iter().any(|id| {
            self.support(id)
                .is_some_and(|s| s.energized && s.contactor_closed)
                || self
                    .motors
                    .get(id)
                    .is_some_and(|m| m.contactor && self.buses[m.bus].transfer != Transfer::Idle)
        })
    }
    fn supports(&self) -> Vec<(bool, bool)> {
        self.motors
            .keys()
            .map(|k| {
                let s = self.support(k).unwrap();
                (s.energized, s.contactor_closed)
            })
            .collect()
    }
    /// Apply an actual source change at `t` (after processing every due event before it).
    pub fn set_source(&mut self, t: f64, s: Source, state: SourceState) -> Result<(), String> {
        self.advance(t)?;
        let before = self.supports();
        let was = self.acceptable(s);
        self.sources[s as usize] = state;
        if self.acceptable(s) != was {
            // the qualifying/disqualifying run restarts at the change
            self.qual[s as usize].since = t;
        }
        self.select_control();
        self.reconcile(t);
        let changed = before != self.supports();
        self.records.push(Record {
            time: t,
            what: format!("{s:?} source -> {state:?}"),
            support_changed: changed,
        });
        Ok(())
    }
    /// A declared malfunction (C3's supply loss): `consumer` loses its own
    /// supply at `t`, its contactor opening, and stays without it (the
    /// routing restarts no motor). Buses, sources and the other consumers
    /// are untouched. Refused for an unknown consumer or one already off.
    pub fn lose_consumer_supply(&mut self, t: f64, consumer: &str) -> Result<(), String> {
        self.advance(t)?;
        let before = self.supports();
        let m = self
            .motors
            .get_mut(consumer)
            .ok_or_else(|| format!("unknown consumer {consumer}"))?;
        if !m.contactor {
            return Err(format!(
                "{consumer} has no supply to lose at {t} s: its contactor is open"
            ));
        }
        m.contactor = false;
        m.lost_since = None;
        m.supply_lost = true;
        let changed = before != self.supports();
        self.records.push(Record {
            time: t,
            what: format!("{consumer} supply lost (declared malfunction)"),
            support_changed: changed,
        });
        Ok(())
    }
    /// PROC T4 (lane TURB, 1 Nov): an operator's OPEN or CLOSE request for
    /// `bus`'s incoming device from `source` at `t`, with the page's guards
    /// ("a deliberate manual retransfer follows the same guards"): the bus
    /// controller has upstream control power; the device is at rest (no
    /// unfinished stroke; reversing a partial stroke is not modelled here);
    /// a CLOSE needs the other incoming actually open at its open end
    /// (break-before-make, no parallel connection) and this source both
    /// usable and qualified, and makes it the held selection; the contact
    /// changes at the end of the ordinary 0.10 s travel, where the logic
    /// rechecks as for an automatic stroke. A request the guards refuse is
    /// rejected and recorded, not queued (`Ok(false)`).
    pub fn request_incoming(
        &mut self,
        t: f64,
        bus: &str,
        source: Source,
        target: Contact,
    ) -> Result<bool, String> {
        self.advance(t)?;
        let b = self
            .bus_index(bus)
            .ok_or_else(|| format!("unknown bus {bus}"))?;
        let travel_s = self.parameters.incoming_travel_s;
        let me = self.buses[b].devices[source as usize];
        let other = self.buses[b].devices[source.other() as usize];
        let refusal = if self.buses[b].control.is_none() {
            Some("no upstream control power")
        } else if me.travel.is_some() {
            Some("the device has an unfinished stroke")
        } else if me.contact == target {
            Some("the device is already there")
        } else if self.buses[b].transfer != Transfer::Idle {
            Some("an automatic transfer is in progress")
        } else if target == Contact::Closed
            && !(other.contact == Contact::Open && other.travel.is_none())
        {
            Some("the other incoming is not at its open end (no parallel connection)")
        } else if target == Contact::Closed
            && !(self.usable(source) && self.qual[source as usize].qualified)
        {
            Some("the source is not usable and qualified")
        } else {
            None
        };
        if let Some(why) = refusal {
            self.record(
                t,
                format!("{bus} {source:?} incoming {target:?} request rejected: {why}"),
            );
            return Ok(false);
        }
        self.buses[b].devices[source as usize].travel = Some((target, t + travel_s));
        if target == Contact::Closed {
            self.buses[b].selected = source;
        }
        self.record(
            t,
            format!("{bus} {source:?} incoming {target:?} requested (operator)"),
        );
        Ok(true)
    }
    /// PROC T11 (lane TURB, 1 Nov): an explicit START of `consumer` at `t`
    /// after its contactor dropped out ("a new explicit START request,
    /// checked against the motor's actual support and permissives"): the
    /// contactor recloses when its bus is energized and its own supply is
    /// not lost; the equipment's own permissives are the motor owner's and
    /// are not modelled here. A refused START is recorded (`Ok(false)`).
    pub fn start_consumer(&mut self, t: f64, consumer: &str) -> Result<bool, String> {
        self.advance(t)?;
        let before = self.supports();
        let m = self
            .motors
            .get(consumer)
            .ok_or_else(|| format!("unknown consumer {consumer}"))?;
        let refusal = if m.contactor {
            Some("its contactor is closed")
        } else if m.supply_lost {
            Some("its own supply is lost")
        } else if self.bus_energized(m.bus).is_none() {
            Some("its bus is not energized")
        } else {
            None
        };
        if let Some(why) = refusal {
            self.record(t, format!("{consumer} START rejected: {why}"));
            return Ok(false);
        }
        let m = self.motors.get_mut(consumer).expect("checked above");
        m.contactor = true;
        m.lost_since = None;
        let changed = before != self.supports();
        self.records.push(Record {
            time: t,
            what: format!("{consumer} START (contactor closed)"),
            support_changed: changed,
        });
        Ok(true)
    }
    /// The earliest internal due time after the present one, if any.
    pub fn next_event(&self) -> Option<f64> {
        let p = &self.parameters;
        let q = p.qualification;
        let mut due: Vec<f64> = vec![];
        for b in &self.buses {
            for d in &b.devices {
                if let Some((_, end)) = d.travel {
                    due.push(end);
                }
            }
            if let Transfer::Interval { until, .. } = b.transfer {
                due.push(until);
            }
        }
        for s in [Source::Unit, Source::Reserve] {
            let qs = self.qual[s as usize];
            match (qs.qualified, self.acceptable(s)) {
                (false, true) => due.push(qs.since + q.qualify_s),
                (true, false) => due.push(qs.since + q.disqualify_s),
                _ => {}
            }
        }
        for m in self.motors.values() {
            if let (true, Some(since)) = (m.contactor, m.lost_since) {
                due.push(since + p.motor_dropout_s);
            }
        }
        due.into_iter()
            .filter(|t| *t > self.time - 1e-12)
            .reduce(f64::min)
    }
    /// Process every due event up to and including `t`, in time order.
    pub fn advance(&mut self, t: f64) -> Result<(), String> {
        if t < self.time - 1e-12 {
            return Err(format!(
                "AC distribution cannot move back from {} to {t}",
                self.time
            ));
        }
        while let Some(due) = self.next_event().filter(|d| *d <= t + 1e-12) {
            let before = self.supports();
            let logged = self.records.len();
            self.time = due;
            self.step(due);
            let changed = before != self.supports();
            // Every record of this instant carries the instant's support
            // change (both buses' transfers complete together).
            for r in &mut self.records[logged..] {
                r.support_changed |= changed;
            }
        }
        self.time = t;
        Ok(())
    }
    fn record(&mut self, t: f64, what: String) {
        self.records.push(Record {
            time: t,
            what,
            support_changed: false,
        });
    }
    /// One due instant: dropouts first (exact boundary), then qualification,
    /// device travel completions, transfer intervals, then the logic.
    fn step(&mut self, t: f64) {
        let p = self.parameters.clone();
        let q = p.qualification;
        let dropping: Vec<String> = self
            .motors
            .iter()
            .filter(|(_, m)| {
                m.contactor
                    && m.lost_since
                        .is_some_and(|s| s + p.motor_dropout_s <= t + 1e-12)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in dropping {
            let m = self.motors.get_mut(&k).unwrap();
            m.contactor = false;
            m.lost_since = None;
            self.record(t, format!("{k} contactor undervoltage dropout"));
        }
        for s in [Source::Unit, Source::Reserve] {
            let qs = self.qual[s as usize];
            let ok = self.acceptable(s);
            if !qs.qualified && ok && qs.since + q.qualify_s <= t + 1e-12 {
                self.qual[s as usize] = Qual {
                    qualified: true,
                    since: t,
                };
                self.record(t, format!("{s:?} qualified"));
            } else if qs.qualified && !ok && qs.since + q.disqualify_s <= t + 1e-12 {
                self.qual[s as usize] = Qual {
                    qualified: false,
                    since: t,
                };
                self.record(t, format!("{s:?} lost qualification"));
            }
        }
        for b in 0..self.buses.len() {
            for s in [Source::Unit, Source::Reserve] {
                if let Some((target, end)) = self.buses[b].devices[s as usize].travel
                    && end <= t + 1e-12
                {
                    self.buses[b].devices[s as usize] = Device {
                        contact: target,
                        travel: None,
                    };
                    let name = self.buses[b].name.clone();
                    self.record(t, format!("{name} {s:?} incoming {target:?}"));
                }
            }
            if let Transfer::Interval { to, until } = self.buses[b].transfer
                && until <= t + 1e-12
            {
                self.buses[b].transfer = Transfer::Closing { to };
            }
        }
        self.select_control();
        self.reconcile(t);
    }
    /// The transfer logic and motor support at `t`.
    fn reconcile(&mut self, t: f64) {
        let p = self.parameters.clone();
        for b in 0..self.buses.len() {
            let powered = self.buses[b].control.is_some();
            if !powered {
                // no control: ordinary travel stops with its contact; sequence timers clear
                for d in &mut self.buses[b].devices {
                    d.travel = None;
                }
                self.buses[b].transfer = Transfer::Idle;
                continue;
            }
            let bus = self.buses[b].clone();
            match bus.transfer {
                Transfer::Idle => {
                    let present = bus.selected;
                    let alt = present.other();
                    if !self.usable(present)
                        && self.qual[alt as usize].qualified
                        && self.usable(alt)
                    {
                        let dev = &mut self.buses[b].devices[present as usize];
                        if dev.contact == Contact::Closed {
                            dev.travel = Some((Contact::Open, t + p.incoming_travel_s));
                        }
                        self.buses[b].transfer = Transfer::Opening { to: alt };
                        self.record(
                            t,
                            format!("{} transfer {present:?} -> {alt:?} begins", bus.name),
                        );
                    }
                }
                Transfer::Opening { to } => {
                    let from = to.other();
                    let d = self.buses[b].devices[from as usize];
                    if d.contact == Contact::Open && d.travel.is_none() {
                        self.buses[b].transfer = Transfer::Interval {
                            to,
                            until: t + p.open_interval_s,
                        };
                    }
                }
                Transfer::Closing { to } => {
                    let d = self.buses[b].devices[to as usize];
                    let available = self.usable(to) && self.qual[to as usize].qualified;
                    if d.contact == Contact::Closed && d.travel.is_none() {
                        self.buses[b].selected = to;
                        self.buses[b].transfer = Transfer::Idle;
                        self.record(t, format!("{} transfer to {to:?} complete", bus.name));
                    } else if !available {
                        self.buses[b].devices[to as usize].travel = None;
                        self.buses[b].transfer = Transfer::Idle;
                        self.buses[b].selected = to;
                        self.record(
                            t,
                            format!("{} closure on {to:?} aborted: bus isolated", bus.name),
                        );
                    } else if d.travel.is_none() {
                        self.buses[b].devices[to as usize].travel =
                            Some((Contact::Closed, t + p.incoming_travel_s));
                    }
                }
                Transfer::Interval { .. } => {}
            }
        }
        // motor support: loss removes torque now; the dropout timer runs
        let energized: Vec<bool> = (0..self.buses.len())
            .map(|b| self.bus_energized(b).is_some())
            .collect();
        for m in self.motors.values_mut() {
            if !m.contactor {
                continue;
            }
            match (energized[m.bus], m.lost_since) {
                (false, None) => m.lost_since = Some(t),
                (true, Some(_)) => m.lost_since = None,
                _ => {}
            }
        }
    }
    /// Source draws `[unit, reserve]` (W) for the consumers' actual electrical
    /// demands: delivered power plus 20 kW no-load and 1 % load loss per
    /// energized path. A de-energized path draws nothing.
    pub fn source_draw(&self, demands: &BTreeMap<String, f64>) -> [f64; 2] {
        let p = &self.parameters;
        let mut delivered = [0.; 2];
        for (k, w) in demands {
            if let Some(m) = self.motors.get(k)
                && m.contactor
                && let Some(s) = self.bus_energized(m.bus)
            {
                delivered[s as usize] += w;
            }
        }
        let mut draw = [0.; 2];
        for s in [Source::Unit, Source::Reserve] {
            if self.sources[s as usize].energized {
                draw[s as usize] =
                    delivered[s as usize] * (1. + p.load_loss_fraction) + p.no_load_loss_w;
            }
        }
        draw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn params() -> Parameters {
        let mut consumers = BTreeMap::new();
        for (k, b) in [
            ("LD01.P.A1", "AC.A"),
            ("LD01.P.B1", "AC.A"),
            ("LD01.FW.P1", "AC.A"),
            ("LD01.P.A2", "AC.B"),
            ("LD01.P.B2", "AC.B"),
            ("LD01.FW.P2", "AC.B"),
        ] {
            consumers.insert(k.to_string(), b.to_string());
        }
        Parameters {
            incoming_travel_s: 0.1,
            open_interval_s: 0.3,
            motor_dropout_s: 1.0,
            qualification: Qualification {
                voltage_min_pu: 0.9,
                voltage_max_pu: 1.1,
                frequency_min_hz: 49.,
                frequency_max_hz: 51.,
                qualify_s: 1.,
                disqualify_s: 0.2,
            },
            no_load_loss_w: 20000.,
            load_loss_fraction: 0.01,
            source_budget_w: 90e6,
            bus_budget_w: 40e6,
            consumers,
        }
    }
    const LIVE: SourceState = SourceState {
        energized: true,
        voltage_pu: 1.,
        frequency_hz: 50.,
    };
    /// ELEC (lead 1 Nov, PHYS2's frame-time reports): a copy advanced to a
    /// frame instant reports the routing's own instants that change no
    /// delivered support, so no stop is needed for them. Between the unit
    /// loss (a restart) and the reserve closure (the next support change):
    /// the unit incoming's OPEN end and the unit's lost qualification; and
    /// after its return (a restart), its requalification. A CLOSE always
    /// energizes its bus (break before make, a usable qualified source), so
    /// it is never such an instant. The copy leaves the routing untouched.
    #[test]
    fn a_copy_advanced_to_a_frame_reports_the_instants_between_restarts() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        d.set_source(1., Source::Unit, SourceState::DEAD).unwrap();
        let at = |d: &Distribution, t: f64| {
            let mut c = d.clone();
            c.advance(t).unwrap();
            c.reports()
        };
        let unit_a = |r: &Reports| r.incoming[0].clone();
        let held = d.discrete_state();
        // +0.15 s: the unit incoming is open, its travel complete; the
        // routing itself still holds the restart's state.
        let r = at(&d, 1.15);
        assert_eq!(
            (unit_a(&r).contact, unit_a(&r).travel_complete),
            (Contact::Open, true)
        );
        assert_eq!(
            (
                unit_a(&d.reports()).contact,
                unit_a(&d.reports()).travel_complete
            ),
            (Contact::Closed, false)
        );
        assert!(!r.buses[0].available);
        // +0.25 s: the unit's qualification is lost (0.2 s), the bus still dead.
        let r = at(&d, 1.25);
        assert!(!r.sources[0].qualified && d.reports().sources[0].qualified);
        assert!(!r.buses[0].available);
        assert_eq!(d.discrete_state(), held, "a report copy changes nothing");
        // No support change before the reserve closes at +0.5 s.
        let mut probe = d.clone();
        let mut first_change = None;
        while let Some(n) = probe.next_event().filter(|n| *n < 2.) {
            let before = probe.supports();
            probe.advance(n).unwrap();
            if probe.supports() != before {
                first_change = Some(n);
                break;
            }
        }
        assert!((first_change.unwrap() - 1.5).abs() < 1e-9);
        // The unit returns at 2 s (a restart); it requalifies at 3 s, between restarts.
        d.advance(1.5).unwrap();
        d.set_source(2., Source::Unit, LIVE).unwrap();
        assert!(!d.reports().sources[0].qualified);
        assert!(at(&d, 3.05).sources[0].qualified);
        assert!(!at(&d, 2.95).sources[0].qualified);
    }
    #[test]
    fn unit_loss_transfers_to_reserve_in_half_a_second_with_ride_through() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        assert!(d.support("LD01.P.A1").unwrap().energized);
        d.set_source(10.37, Source::Unit, SourceState::DEAD)
            .unwrap();
        assert!(!d.support("LD01.P.A1").unwrap().energized);
        let mut t = 10.37;
        while let Some(n) = d.next_event().filter(|n| *n < 20.) {
            d.advance(n).unwrap();
            t = n;
            if d.support("LD01.P.A1").unwrap().energized {
                break;
            }
        }
        assert!((t - 10.87).abs() < 1e-9, "restored at {t}");
        // Both buses were on the unit source and both transfers are recorded
        // as support changes at the same instant.
        let done: Vec<&str> = d
            .records
            .iter()
            .filter(|r| r.support_changed && r.what.contains("transfer to Reserve complete"))
            .map(|r| r.what.as_str())
            .collect();
        assert_eq!(done.len(), 2, "{done:?}");
        let s = d.support("LD01.P.A2").unwrap();
        assert!(s.energized && s.contactor_closed);
        d.advance(30.).unwrap();
        assert!(d.support("LD01.FW.P2").unwrap().contactor_closed);
        let draw = d.source_draw(&BTreeMap::from([("LD01.P.A1".to_string(), 4e6)]));
        assert_eq!(draw[0], 0.);
        assert!((draw[1] - (4e6 * 1.01 + 20000.)).abs() < 1e-6);
    }
    #[test]
    fn loss_of_both_sources_drops_every_motor_at_one_second_and_never_restarts() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        d.set_source(5.1234, Source::Unit, SourceState::DEAD)
            .unwrap();
        d.set_source(5.1234, Source::Reserve, SourceState::DEAD)
            .unwrap();
        assert!(!d.support("LD01.P.B2").unwrap().energized);
        d.advance(6.1233).unwrap();
        assert!(d.support("LD01.P.B2").unwrap().contactor_closed);
        // exact boundary: restoration at 1.00 s comes after the dropout
        d.set_source(6.1234, Source::Reserve, LIVE).unwrap();
        let s = d.support("LD01.P.B2").unwrap();
        assert!(!s.contactor_closed, "{s:?}");
        d.advance(20.).unwrap();
        assert!(!d.support("LD01.P.A1").unwrap().contactor_closed);
    }
    const RCPS: [&str; 4] = ["LD01.P.A1", "LD01.P.A2", "LD01.P.B1", "LD01.P.B2"];
    fn forced(d: &Distribution) -> bool {
        d.forced_circulation(&RCPS.map(String::from))
    }
    /// R4-DUMP: a healthy reserve transfer holds forced circulation through
    /// the buses' dead interval, at every instant of it.
    #[test]
    fn a_healthy_transfer_holds_forced_circulation() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        assert!(forced(&d));
        d.set_source(10.37, Source::Unit, SourceState::DEAD)
            .unwrap();
        assert!(
            !d.support("LD01.P.A1").unwrap().energized,
            "the buses are dead"
        );
        assert!(forced(&d));
        let mut instants = 0;
        while let Some(n) = d.next_event().filter(|n| *n < 10.9) {
            d.advance(n).unwrap();
            assert!(forced(&d), "at {n}");
            instants += 1;
        }
        assert!(instants > 0);
        assert!(d.support("LD01.P.A1").unwrap().energized, "reserve closed");
        assert!(d.buses.iter().all(|b| b.transfer == Transfer::Idle));
        assert!(forced(&d));
    }
    /// R4-DUMP: a loss of offsite power leaves no control power, so the
    /// transfer the unit's loss began ends at Idle the same instant: no hold.
    #[test]
    fn a_loss_of_offsite_power_ends_forced_circulation_at_once() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        d.set_source(10.37, Source::Unit, SourceState::DEAD)
            .unwrap();
        d.set_source(10.37, Source::Reserve, SourceState::DEAD)
            .unwrap();
        assert!(d.buses.iter().all(|b| b.transfer == Transfer::Idle));
        assert!(!forced(&d));
        d.advance(12.).unwrap();
        assert!(!forced(&d));
    }
    /// R4-DUMP: a reserve lost during the transfer ends the hold at that
    /// instant, and the aborted transfer ends at Idle with the buses dead.
    #[test]
    fn a_failed_transfer_ends_forced_circulation() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        d.set_source(10.37, Source::Unit, SourceState::DEAD)
            .unwrap();
        d.advance(10.6).unwrap();
        assert_ne!(d.buses[0].transfer, Transfer::Idle);
        assert!(forced(&d));
        d.set_source(10.6, Source::Reserve, SourceState::DEAD)
            .unwrap();
        assert!(!forced(&d));
        d.advance(12.).unwrap();
        assert!(d.buses.iter().all(|b| b.transfer == Transfer::Idle));
        assert!(!d.support("LD01.P.A1").unwrap().energized);
        assert!(!forced(&d));
    }
    /// S3-D19: mid-transfer state (a source dead, the open interval
    /// running, motors in their dropout ride-through) round-trips through
    /// JSON exactly and continues identically; another layout refuses.
    #[test]
    fn the_discrete_state_round_trips_exactly_mid_transfer() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        d.set_source(0.1 + 0.2, Source::Unit, SourceState::DEAD)
            .unwrap();
        d.advance(0.3 + 0.05).unwrap();
        let text = serde_json::to_string(&d.discrete_state()).unwrap();
        let mut e = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        e.restore_discrete_state(serde_json::from_str(&text).unwrap())
            .unwrap();
        assert_eq!(e.discrete_state(), d.discrete_state());
        assert_eq!(e.next_event(), d.next_event());
        while let Some(n) = d.next_event().filter(|n| *n < 5.) {
            d.advance(n).unwrap();
            e.advance(n).unwrap();
            assert_eq!(e.discrete_state(), d.discrete_state());
        }
        let mut other = params();
        other.consumers.remove("LD01.FW.P2");
        let mut f = Distribution::prepared(other, [LIVE, LIVE], [true, true], 0.).unwrap();
        assert!(
            f.restore_discrete_state(serde_json::from_str(&text).unwrap())
                .is_err()
        );
    }
    /// C3's malfunction: one consumer loses its supply; nothing else moves
    /// and nothing restarts it.
    #[test]
    fn a_consumer_supply_loss_opens_only_its_contactor() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        d.lose_consumer_supply(10.37, "LD01.P.A1").unwrap();
        let a1 = d.support("LD01.P.A1").unwrap();
        assert!(a1.energized && !a1.contactor_closed);
        assert!(d.support("LD01.P.B1").unwrap().contactor_closed);
        assert!(d.records.last().unwrap().support_changed);
        d.advance(60.).unwrap();
        assert!(!d.support("LD01.P.A1").unwrap().contactor_closed);
        assert!(d.lose_consumer_supply(61., "LD01.P.A1").is_err());
        assert!(d.lose_consumer_supply(61., "LD01.P.X9").is_err());
    }
    #[test]
    fn the_reports_follow_the_routing() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        let r = d.reports();
        assert!(r.buses.iter().all(|b| b.available));
        assert!(r.sources.iter().all(|s| s.energized && s.qualified));
        assert_eq!(r.incoming.len(), 2 * r.buses.len());
        assert!(r.incoming.iter().all(|i| i.travel_complete));
        // The unit source dies: its report follows at once; the buses it fed
        // are unavailable until the transfer closes the reserve.
        d.set_source(1., Source::Unit, SourceState::DEAD).unwrap();
        let r = d.reports();
        assert!(!r.sources[0].energized);
        let fed_by_unit_before: Vec<bool> = r
            .buses
            .iter()
            .map(|b| b.fed_from == Some(Source::Reserve))
            .collect();
        while let Some(t) = d.next_event() {
            if t > 3. {
                break;
            }
            d.advance(t).unwrap();
        }
        let r = d.reports();
        assert!(
            r.buses
                .iter()
                .all(|b| b.available && b.fed_from == Some(Source::Reserve)),
            "{r:?} {fed_by_unit_before:?}"
        );
        assert!(r.incoming.iter().all(|i| i.travel_complete));
    }
    #[test]
    fn an_operator_retransfer_follows_the_guards() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        let bus = d.reports().buses[0].name.clone();
        // CLOSE of the reserve while the unit incoming is closed: rejected (no parallel).
        assert!(
            !d.request_incoming(1., &bus, Source::Reserve, Contact::Closed)
                .unwrap()
        );
        // OPEN the unit incoming: the bus is isolated at the end of its 0.10 s travel.
        assert!(
            d.request_incoming(1., &bus, Source::Unit, Contact::Open)
                .unwrap()
        );
        assert!(
            !d.request_incoming(1.05, &bus, Source::Unit, Contact::Open)
                .unwrap(),
            "mid-stroke"
        );
        d.advance(1.2).unwrap();
        assert!(!d.reports().buses[0].available);
        // No automatic transfer back: the selected source is still usable.
        d.advance(3.).unwrap();
        assert!(!d.reports().buses[0].available);
        // CLOSE the reserve: the bus is fed from it after the travel, and it is held.
        assert!(
            d.request_incoming(3., &bus, Source::Reserve, Contact::Closed)
                .unwrap()
        );
        d.advance(3.2).unwrap();
        let r = d.reports();
        assert!(r.buses[0].available && r.buses[0].fed_from == Some(Source::Reserve));
        // A dead source cannot be closed onto.
        d.set_source(4., Source::Unit, SourceState::DEAD).unwrap();
        assert!(
            !d.request_incoming(4., &bus, Source::Unit, Contact::Closed)
                .unwrap()
        );
    }

    #[test]
    fn a_start_after_dropout_recloses_the_contactor_and_not_otherwise() {
        let mut d = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        // Both sources lost: every motor drops out at 1.00 s.
        d.set_source(1., Source::Unit, SourceState::DEAD).unwrap();
        d.set_source(1., Source::Reserve, SourceState::DEAD)
            .unwrap();
        d.advance(2.5).unwrap();
        assert!(!d.support("LD01.P.A1").unwrap().contactor_closed);
        // START on a dead bus is rejected.
        assert!(!d.start_consumer(2.5, "LD01.P.A1").unwrap());
        // Restoration does not reclose it ...
        d.set_source(3., Source::Unit, LIVE).unwrap();
        d.advance(5.).unwrap();
        assert!(d.support("LD01.P.A1").unwrap().energized);
        assert!(!d.support("LD01.P.A1").unwrap().contactor_closed);
        // ... a START does.
        assert!(d.start_consumer(5., "LD01.P.A1").unwrap());
        assert!(d.support("LD01.P.A1").unwrap().contactor_closed);
        assert!(
            !d.start_consumer(5.1, "LD01.P.A1").unwrap(),
            "already closed"
        );
        // A consumer whose own supply is lost (declared malfunction) cannot be started.
        assert!(d.start_consumer(5.5, "LD01.P.A2").unwrap());
        d.lose_consumer_supply(6., "LD01.P.A2").unwrap();
        assert!(!d.start_consumer(6.5, "LD01.P.A2").unwrap());
        // The snapshot of a state with no lost supply serializes as before.
        let e = Distribution::prepared(params(), [LIVE, LIVE], [true, true], 0.).unwrap();
        assert!(
            !serde_json::to_string(&e.discrete_state())
                .unwrap()
                .contains("supply_lost")
        );
    }
}

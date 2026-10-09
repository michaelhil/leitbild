//! One exact finite supply and achieved spring mechanism. Physical events share
//! the plant clock; no new solver, physical rows, EOS calls or replayed intent.
use super::{cooling_input::PrhrAction, finite, quote, HORIZON};
use leitbild_plant_numerics::{dc_supply as dc, prhr, prhr_actuator as pa, source_cooling};
use std::io::Write;
use std::path::Path;

pub const POLICY: &str = "exact-finite-ACT.A;actual-PRHR-hold-close;remaining-consumer-work-export;losses-to-finite-ROOM;retained-no-replay";
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub time: f64,
    pub charger: Option<bool>,
    pub battery: Option<bool>,
    pub healthy: Option<bool>,
    pub commands: Vec<dc::Command>,
    pub prhr_command: Option<pa::Command>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub config: dc::Config,
    pub initial_energy_j: f64,
    pub paths: dc::Paths,
    pub output_closed: bool,
    pub events: Vec<Event>,
}
impl Plan {
    pub fn validate(&self) -> Result<(), String> {
        self.config.validate()?;
        if !self.initial_energy_j.is_finite()
            || self.initial_energy_j < 0.
            || self.initial_energy_j > self.config.capacity_j
        {
            return Err("Invalid ACT preparation".into());
        }
        let mut previous = -1.;
        for e in &self.events {
            if e.charger.is_none()
                && e.battery.is_none()
                && e.healthy.is_none()
                && e.commands.is_empty()
                && e.prhr_command.is_none()
            {
                return Err("Empty ACT event".into());
            }
            if !e.time.is_finite()
                || e.time < 0.
                || e.time >= HORIZON
                || e.time <= previous
                || (previous >= 0. && dc::coincident(e.time, previous))
            {
                return Err(
                    "ACT events must be distinct, ordered and inside the qualification horizon"
                        .into(),
                );
            }
            previous = e.time;
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Schedule {
    pub motion: pa::Motion,
    inputs: pa::Inputs,
    pub room_row: usize,
    spring_row: usize,
    electrical_row: usize,
    spring_j: f64,
    plan: Plan,
    supply: dc::Supply,
    cursor: usize,
    prhr_delivered_j: f64,
    other_delivered_j: f64,
    /// A restored copy cannot query the past even when its exact affine anchor
    /// predates the checkpoint. Anchors themselves are retained, not rounded.
    retained_time: f64,
    bank_partition_w: f64,
    bank_holding_connected: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub time: f64,
    pub state: dc::State,
    pub paths: dc::Paths,
    pub prhr_j: f64,
    pub other_j: f64,
    pub opening: f64,
    pub spring_j: f64,
    pub holding: bool,
    pub closing: bool,
    pub next: Option<f64>,
    pub cursor: usize,
}
impl Point {
    pub fn thermal_j(&self) -> f64 {
        self.prhr_j + self.state.loss_j
    }
    pub fn json(&self) -> String {
        let cause = match self.state.cause {
            None => "null".into(),
            Some(dc::Cause::Overload) => quote("overload"),
            Some(dc::Cause::InsufficientSupply) => quote("insufficient_supply"),
            Some(dc::Cause::OutputFailure) => quote("output_failure"),
        };
        format!("{{\"timeS\":{},\"energyJ\":{},\"sourceJ\":{},\"deliveredJ\":{},\"prhrDeliveredJ\":{},\"otherDeliveredJ\":{},\"lossJ\":{},\"thermalReceivedJ\":{},\"outputClosed\":{},\"cause\":{},\"chargerAvailable\":{},\"batteryAvailable\":{},\"outputHealthy\":{},\"opening\":{},\"springEnergyJ\":{},\"holding\":{},\"closing\":{},\"nextEventS\":{},\"eventCursor\":{}}}",finite(self.time),finite(self.state.energy_j),finite(self.state.source_j),finite(self.state.delivered_j),finite(self.prhr_j),finite(self.other_j),finite(self.state.loss_j),finite(self.thermal_j()),self.state.output_closed,cause,self.paths.charger_available,self.paths.battery_available,self.paths.output_healthy,finite(self.opening),finite(self.spring_j),self.holding,self.closing,self.next.map(finite).unwrap_or("null".into()),self.cursor)
    }
}
impl Schedule {
    pub fn new(
        model: &source_cooling::Model,
        action: Option<PrhrAction>,
        plan: Option<&Plan>,
    ) -> Result<Option<Self>, String> {
        let Some(p) = model.network.prhr() else {
            if action.is_some() || plan.is_some() {
                return Err("Actuation without physical PRHR".into());
            }
            return Ok(None);
        };
        let mut s = Self::apparatus(p, action.ok_or("Missing PRHR support/action")?, plan)?;
        s.room_row += model.layout.network_start;
        s.spring_row += model.layout.network_start;
        s.electrical_row += model.layout.network_start;
        Ok(Some(s))
    }
    pub fn apparatus(p: &prhr::Model, a: PrhrAction, plan: Option<&Plan>) -> Result<Self, String> {
        let plan = plan.ok_or("Physical PRHR requires its finite ACT supply owner")?;
        let initial_supply = dc::Supply::new(
            plan.config,
            plan.initial_energy_j,
            plan.paths,
            plan.output_closed,
            plan.config.normal_group_w,
        )?;
        let other = plan.config.normal_group_w - p.config.actuator.hold_power_w;
        let inputs = pa::Inputs {
            support: pa::Support {
                hold_supported: initial_supply.can_deliver(other + p.config.actuator.hold_power_w),
                closing_supported: initial_supply.can_deliver(
                    other + p.config.actuator.hold_power_w + p.config.actuator.closing_power_w,
                ),
            },
            blocked: a.blocked,
            ambient_temperature_k: a.ambient_temperature_k,
        };
        {
            plan.validate()?;
            if p.config.actuator.initial_opening != 0. {
                return Err("Finite ACT requires explicit initial closed/held PRHR and no independent scheduled OPEN".into());
            }
            if plan.config.normal_group_w < p.config.actuator.hold_power_w {
                return Err("PRHR hold not included in normal DC group".into());
            }
        }
        let motion = pa::Motion::new(
            p.actuator.clone(),
            0.,
            p.config.actuator.initial_opening,
            pa::Control::new(true),
            inputs,
        )?;
        let mut s = Self {
            motion,
            inputs,
            room_row: p.layout.room_energy,
            spring_row: p.layout.spring_released,
            electrical_row: p.layout.electrical_received,
            spring_j: p.config.actuator.spring_energy_j,
            plan: plan.clone(),
            supply: initial_supply,
            cursor: 0,
            prhr_delivered_j: 0.,
            other_delivered_j: 0.,
            retained_time: 0.,
            bank_partition_w:0.,
            bank_holding_connected:true,
        };
        {
            s.settle(0., None)?;
            if s.plan.events.first().is_some_and(|e| e.time == 0.) {
                s.accept_event(0.)?;
            }
        }
        Ok(s)
    }

    pub fn other_requested_w(&self) -> f64 {
        self.plan.config.normal_group_w - self.motion.snapshot().config.hold_power_w
            -if self.bank_holding_connected {0.} else {self.bank_partition_w}
    }
    pub fn authorize_bank_partition(&mut self,holding_w:f64)->Result<(),String> {
        if self.bank_partition_w!=0. || !holding_w.is_finite() || holding_w<=0.
            || holding_w>self.other_requested_w() || self.supply.snapshot().state.time_s!=0.
        {return Err("Invalid actual BANK.HOLD partition of ACT.A".into());}
        self.bank_partition_w=holding_w;Ok(())
    }
    /// One accepted consumer-load transaction, retaining A energy, receipts,
    /// PRHR mechanism and its existing demand. No command is replayed.
    pub fn bank_holding_event(&mut self,time:f64,connected:bool)->Result<(),String> {
        if self.bank_partition_w<=0. || self.bank_holding_connected==connected {
            return Err("Inactive BANK.HOLD load transaction".into());
        }
        let mut next=self.clone();let before=next.point(time)?;
        next.prhr_delivered_j=before.prhr_j;next.other_delivered_j=before.other_j;
        next.bank_holding_connected=connected;
        let request=next.other_requested_w()+next.motion.requested_power_w(time)?;
        next.supply.transition(time,next.supply.paths(),request,&[])?;
        next.settle(time,None)?;next.retained_time=time;*self=next;Ok(())
    }
    pub fn supply_snapshot(&self) -> dc::Snapshot {
        self.supply.snapshot()
    }
    fn support(&self) -> pa::Support {
        let s = &self.supply;
        let c = self.motion.snapshot().config;
        pa::Support {
            hold_supported: s.can_deliver(self.other_requested_w() + c.hold_power_w),
            closing_supported: s
                .can_deliver(self.other_requested_w() + c.hold_power_w + c.closing_power_w),
        }
    }
    fn settle(&mut self, time: f64, command: Option<pa::Command>) -> Result<(), String> {
        self.inputs.support = self.support();
        self.motion.transition(time, command, self.inputs)?;
        {
            let other=self.other_requested_w();
            let s = &mut self.supply;
            let request = other + self.motion.requested_power_w(time)?;
            s.transition(time, s.paths(), request, &[])?;
            let support = self.support();
            if support != self.inputs.support {
                self.inputs.support = support;
                self.motion.transition(time, None, self.inputs)?;
                let request = self.other_requested_w() + self.motion.requested_power_w(time)?;
                let s = &mut self.supply;
                s.transition(time, s.paths(), request, &[])?;
            }
        }
        Ok(())
    }
    pub fn next_event(&self) -> Result<Option<f64>, String> {
        let times = [
            self.motion.next_contact_s()?,
            self.supply.next_storage_event_s()?,
            self.plan.events.get(self.cursor).map(|e| e.time),
        ];
        Ok(times.into_iter().flatten().reduce(f64::min))
    }
    fn check_time(&self, time: f64) -> Result<(), String> {
        if !time.is_finite()
            || time < self.retained_time
            || self
                .next_event()?
                .is_some_and(|t| time > t && !dc::coincident(time, t))
        {
            return Err(
                "Actuation continuation crossed an unaccepted event or retained copy boundary"
                    .into(),
            );
        }
        Ok(())
    }
    pub fn input(&self, time: f64, room: f64) -> Result<prhr::Input, String> {
        self.check_time(time)?;
        let (opening, r) = self.motion.at_left(time, room)?;
        self.supply.at(time)?;
        let loss = self.supply.rates().loss_w;
        Ok(prhr::Input {
            opening,
            opening_rate: r.opening_rate_s,
            electrical_receipt_w: r.electrical_receipt_w + loss,
            room_heat_w: r.room_heat_w + loss,
            ambient_temperature_k: self.inputs.ambient_temperature_k,
        })
    }
    pub fn accept_event(&mut self, time: f64) -> Result<(), String> {
        let next = self.next_event()?.ok_or("No pending actuation event")?;
        if !dc::coincident(next, time) || time < self.retained_time {
            return Err("Wrong actuation event time".into());
        }
        let mut candidate = self.clone();
        let before = candidate.point(time)?;
        candidate.prhr_delivered_j = before.prhr_j;
        candidate.other_delivered_j = before.other_j;
        let mut command = None;
        let event = candidate
            .plan
            .events
            .get(candidate.cursor)
            .filter(|e| dc::coincident(e.time, time))
            .cloned();
        if let Some(e) = event {
            let s = &mut candidate.supply;
            let mut paths = s.paths();
            if let Some(v) = e.charger {
                paths.charger_available = v;
            }
            if let Some(v) = e.battery {
                paths.battery_available = v;
            }
            if let Some(v) = e.healthy {
                paths.output_healthy = v;
            }
            s.transition(time, paths, s.requested_w(), &e.commands)?;
            command = e.prhr_command;
            candidate.cursor += 1;
        } else {
            let s = &mut candidate.supply;
            s.transition(time, s.paths(), s.requested_w(), &[])?;
        }
        candidate.settle(time, command)?;
        candidate.retained_time = time;
        *self = candidate;
        Ok(())
    }
    pub fn point(&self, time: f64) -> Result<Point, String> {
        let s = &self.supply;
        self.check_time(time)?;
        let state = s.at(time)?;
        let dt = time - s.snapshot().state.time_s;
        let (_, r) = self.motion.at_left(time, 0.)?;
        let actual_prhr = r.electrical_receipt_w;
        if actual_prhr > s.rates().delivered_w {
            return Err("PRHR drawing undelivered finite supply".into());
        }
        let opening = self.motion.at_left(time, 0.)?.0;
        let m = self.motion.snapshot();
        Ok(Point {
            time,
            state,
            paths: s.paths(),
            prhr_j: self.prhr_delivered_j + actual_prhr * dt,
            other_j: self.other_delivered_j + (s.rates().delivered_w - actual_prhr) * dt,
            opening,
            spring_j: self.spring_j * (1. - opening),
            holding: m.holding,
            closing: m.closing,
            next: self.next_event()?,
            cursor: self.cursor,
        })
    }
    pub fn audit(&self, time: f64, y: &[f64]) -> Result<(f64, f64), String> {
        let (a, _) = self.motion.at_left(time, y[self.room_row])?;
        let released = self.motion.initial_spring_energy_j() - self.spring_j * (1. - a);
        if (y[self.spring_row] - released).abs() > 1e-5 {
            return Err("Finite PRHR spring receipt mismatch".into());
        }
        let p = self.point(time)?;
        let energy = p.state.energy_j + p.state.delivered_j + p.state.loss_j
            - p.state.source_j
            - self.plan.initial_energy_j;
        let bound = 128.
            * f64::EPSILON
            * (p.state.energy_j.abs()
                + p.state.delivered_j
                + p.state.loss_j
                + p.state.source_j
                + self.plan.initial_energy_j);
        let thermal = (y[self.electrical_row] - p.thermal_j()).abs();
        // Same normal PRHR receipt allocation as cooling_accuracy: 20 times
        // its 0.01 J receipt ATOL, not a battery relative-error allowance.
        if energy.abs() > bound || thermal > 20. * 0.01 + bound {
            return Err(format!(
                "Finite ACT energy/thermal receipt defect {energy}/{thermal} J"
            ));
        }
        Ok((energy.abs(), thermal))
    }
    /// Append-only sidecar name is owned by the exact physical checkpoint.
    pub fn retain(&self, path: &Path, time: f64) -> Result<(), String> {
        let words = self.snapshot_words(time)?;
        let text = words
            .iter()
            .map(|v| format!("{v:.17e}"))
            .collect::<Vec<_>>()
            .join(" ");
        let parsed = text
            .split_whitespace()
            .map(|v| {
                v.parse::<f64>()
                    .map_err(|_| "Invalid written actuation snapshot")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let copy = self.restore_words(&parsed)?;
        if copy.point(time)? != self.point(time)?
            || copy.input(time, 0.)? != self.input(time, 0.)?
        {
            return Err("Actuation durable copy mismatch".into());
        }
        let path = std::path::PathBuf::from(format!("{}.actuation-support.txt", path.display()));
        let pending = std::path::PathBuf::from(format!("{}.pending", path.display()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(pending, path).map_err(|e| e.to_string())
    }
    fn plan_words(&self) -> Vec<f64> {
        let p = &self.plan;
        let c = p.config;
        let mut v = vec![
            1.,
            c.capacity_j,
            c.normal_group_w,
            c.charger_limit_w,
            c.output_limit_w,
            c.charge_efficiency,
            c.discharge_efficiency,
            c.converter_efficiency,
            p.initial_energy_j,
            p.paths.charger_available as u8 as f64,
            p.paths.battery_available as u8 as f64,
            p.paths.output_healthy as u8 as f64,
            p.output_closed as u8 as f64,
            p.events.len() as f64,
        ];
        for e in &p.events {
            v.extend([
                e.time,
                e.charger.map(|x| x as u8 as f64).unwrap_or(-1.),
                e.battery.map(|x| x as u8 as f64).unwrap_or(-1.),
                e.healthy.map(|x| x as u8 as f64).unwrap_or(-1.),
                e.commands.len() as f64,
            ]);
            for cmd in &e.commands {
                v.push(match cmd {
                    dc::Command::Open => 0.,
                    dc::Command::Reset => 1.,
                    dc::Command::Close => 2.,
                });
            }
            v.push(match e.prhr_command {
                None => -1.,
                Some(pa::Command::Open) => 0.,
                Some(pa::Command::Close) => 1.,
            });
        }
        v
    }
    pub fn snapshot_words(&self, time: f64) -> Result<Vec<f64>, String> {
        self.point(time)?;
        let mut v = self.plan_words();
        let s = self.supply.snapshot();
        let m = self.motion.snapshot();
        let c = m.config;
        v.extend([
            time,
            s.state.time_s,
            s.state.energy_j,
            s.state.output_closed as u8 as f64,
            match s.state.cause {
                None => 0.,
                Some(dc::Cause::Overload) => 1.,
                Some(dc::Cause::InsufficientSupply) => 2.,
                Some(dc::Cause::OutputFailure) => 3.,
            },
            s.state.source_j,
            s.state.delivered_j,
            s.state.loss_j,
            s.paths.charger_available as u8 as f64,
            s.paths.battery_available as u8 as f64,
            s.paths.output_healthy as u8 as f64,
            s.requested_w,
            s.original_energy_j,
            m.anchor_s,
            m.anchor_opening,
            m.initial_spring_energy_j,
            m.holding as u8 as f64,
            m.closing as u8 as f64,
            m.inputs.support.hold_supported as u8 as f64,
            m.inputs.support.closing_supported as u8 as f64,
            m.inputs.blocked as u8 as f64,
            m.inputs.ambient_temperature_k,
            self.cursor as f64,
            self.prhr_delivered_j,
            self.other_delivered_j,
            c.stroke_s,
            c.spring_energy_j,
            c.closing_power_w,
            c.hold_power_w,
            c.room_capacity_j_k,
            c.room_wall_w_k,
            c.room_reference_temperature_k,
            c.initial_opening,
            c.initial_room_temperature_k,
        ]);
        Ok(v)
    }
    pub fn restore_words(&self, words: &[f64]) -> Result<Self, String> {
        let prefix = self.plan_words();
        if words.len() != prefix.len() + 34
            || words[..prefix.len()] != prefix
            || words.iter().any(|v| !v.is_finite())
        {
            return Err("Different plant or malformed actuation snapshot".into());
        }
        let w = &words[prefix.len()..];
        let boolean = |i: usize| -> Result<bool, String> {
            match w[i] {
                0. => Ok(false),
                1. => Ok(true),
                _ => Err("Malformed retained boolean".into()),
            }
        };
        let mut out = self.clone();
        let mut ds = out.supply.snapshot();
        ds.state = dc::State {
            time_s: w[1],
            energy_j: w[2],
            output_closed: boolean(3)?,
            cause: match w[4] {
                0. => None,
                1. => Some(dc::Cause::Overload),
                2. => Some(dc::Cause::InsufficientSupply),
                3. => Some(dc::Cause::OutputFailure),
                _ => return Err("Malformed output cause".into()),
            },
            source_j: w[5],
            delivered_j: w[6],
            loss_j: w[7],
        };
        ds.paths = dc::Paths {
            charger_available: boolean(8)?,
            battery_available: boolean(9)?,
            output_healthy: boolean(10)?,
        };
        ds.requested_w = w[11];
        ds.original_energy_j = w[12];
        out.supply = dc::Supply::restore(ds)?;
        let original = out.motion.snapshot();
        let c = pa::Config {
            stroke_s: w[25],
            spring_energy_j: w[26],
            closing_power_w: w[27],
            hold_power_w: w[28],
            room_capacity_j_k: w[29],
            room_wall_w_k: w[30],
            room_reference_temperature_k: w[31],
            initial_opening: w[32],
            initial_room_temperature_k: w[33],
        };
        // The optional bank partition is fixed by the connected caller. Its
        // actual disconnected state is carried by the retained finite demand.
        let connected_request=out.plan.config.normal_group_w-c.hold_power_w
            +pa::Motion::restore(pa::MotionSnapshot {config:c,anchor_s:w[13],anchor_opening:w[14],
                initial_spring_energy_j:w[15],holding:boolean(16)?,closing:boolean(17)?,
                inputs:pa::Inputs {support:pa::Support {hold_supported:boolean(18)?,closing_supported:boolean(19)?},
                    blocked:boolean(20)?,ambient_temperature_k:w[21]}})?.requested_power_w(w[1])?;
        out.bank_holding_connected=if ds.requested_w==connected_request {true}
            else if out.bank_partition_w>0. && ds.requested_w==connected_request-out.bank_partition_w {false}
            else {return Err("Retained ACT.A demand changed its authorized bank partition".into());};
        if c != original.config
            || w[15] != original.initial_spring_energy_j
            || ds.original_energy_j != out.plan.initial_energy_j
        {
            return Err("Actuation snapshot changed original finite stores".into());
        }
        out.inputs = pa::Inputs {
            support: pa::Support {
                hold_supported: boolean(18)?,
                closing_supported: boolean(19)?,
            },
            blocked: boolean(20)?,
            ambient_temperature_k: w[21],
        };
        if out.inputs.blocked != original.inputs.blocked
            || out.inputs.ambient_temperature_k != original.inputs.ambient_temperature_k
        {
            return Err("Retained copy changed immutable mechanical boundary".into());
        }
        out.motion = pa::Motion::restore(pa::MotionSnapshot {
            config: c,
            anchor_s: w[13],
            anchor_opening: w[14],
            initial_spring_energy_j: w[15],
            holding: boolean(16)?,
            closing: boolean(17)?,
            inputs: out.inputs,
        })?;
        if w[22] < 0.
            || w[22].fract() != 0.
            || w[22] > out.plan.events.len() as f64
            || w[23] < 0.
            || w[24] < 0.
            || w[0] < w[1]
            || w[0] < w[13]
        {
            return Err("Invalid retained actuation cursor/clock/receipts".into());
        }
        out.cursor = w[22] as usize;
        if out.cursor > 0
            && out.plan.events[out.cursor - 1].time > ds.state.time_s
            && !dc::coincident(out.plan.events[out.cursor - 1].time, ds.state.time_s)
        {
            return Err("Retained copy skipped a future authored event".into());
        }
        out.prhr_delivered_j = w[23];
        out.other_delivered_j = w[24];
        out.retained_time = w[0];
        if ds.state.time_s != out.motion.snapshot().anchor_s
            || ds.requested_w
                != out.other_requested_w() + out.motion.requested_power_w(ds.state.time_s)?
            || out.inputs.support != out.support()
        {
            return Err("Retained supply/mechanism support or duty mismatch".into());
        }
        if (out.prhr_delivered_j + out.other_delivered_j - ds.state.delivered_j).abs()
            > 128. * f64::EPSILON * ds.state.delivered_j.abs().max(1.)
            || out
                .next_event()?
                .is_some_and(|t| t < out.retained_time && !dc::coincident(t, out.retained_time))
        {
            return Err("Actuation snapshot omitted past event or delivered work".into());
        }
        out.point(out.retained_time)?;
        Ok(out)
    }
}

#[derive(Default, Clone)]
pub struct Receipt {
    pub final_point: Option<Point>,
    pub events: Vec<Point>,
    pub common: Vec<Point>,
    pub copies: usize,
    pub maximum_energy: f64,
    pub maximum_thermal: f64,
}
impl Receipt {
    pub fn record(
        &mut self,
        s: &Schedule,
        time: f64,
        y: &[f64],
        event: bool,
    ) -> Result<(), String> {
        {
            let p = s.point(time)?;
            let (e, t) = s.audit(time, y)?;
            self.maximum_energy = self.maximum_energy.max(e);
            self.maximum_thermal = self.maximum_thermal.max(t);
            let copy = s.restore_words(&s.snapshot_words(time)?)?;
            if copy.point(time)? != p || copy.next_event()? != s.next_event()? {
                return Err("Retained actuation copy mismatch".into());
            }
            self.copies += 1;
            if event {
                self.events.push(p.clone());
            } else {
                self.common.push(p.clone());
            }
            self.final_point = Some(p);
        }
        Ok(())
    }
    pub fn json(&self) -> String {
        format!("{{\"final\":{},\"events\":[{}],\"copyChecks\":{{\"passed\":true,\"checks\":{},\"maximumDifference\":0}},\"maximumEnergyDefectJ\":{},\"maximumThermalReceiptDefectJ\":{}}}",self.final_point.as_ref().map(Point::json).unwrap_or("null".into()),self.events.iter().map(Point::json).collect::<Vec<_>>().join(","),self.copies,finite(self.maximum_energy),finite(self.maximum_thermal))
    }
}
pub fn pair(normal: &Receipt, tight: &Receipt) -> Result<(bool, String), String> {
    let (Some(a), Some(b)) = (&normal.final_point, &tight.final_point) else {
        return Ok((false, "null".into()));
    };
    if normal.common.len() != tight.common.len() || normal.events.len() != tight.events.len() {
        return Err("Different actual actuation event/common schedules".into());
    }
    let mut max = 0f64;
    for (a, b) in normal
        .common
        .iter()
        .chain(&normal.events)
        .chain(std::iter::once(a))
        .zip(
            tight
                .common
                .iter()
                .chain(&tight.events)
                .chain(std::iter::once(b)),
        )
    {
        if a.time != b.time
            || a.cursor != b.cursor
            || a.state.output_closed != b.state.output_closed
            || a.state.cause != b.state.cause
            || a.holding != b.holding
            || a.closing != b.closing
            || a.opening != b.opening
        {
            return Err("Actuation pair discrete/motion mismatch".into());
        }
        for (x, y) in [
            (a.state.energy_j, b.state.energy_j),
            (a.state.source_j, b.state.source_j),
            (a.prhr_j, b.prhr_j),
            (a.other_j, b.other_j),
            (a.state.loss_j, b.state.loss_j),
        ] {
            max = max.max((x - y).abs());
        }
    }
    let exhausted = normal.events.iter().any(|p| {
        p.state.energy_j == 0.
            && !p.state.output_closed
            && p.state.cause == Some(dc::Cause::InsufficientSupply)
            && !p.holding
            && !p.closing
    }) && normal.events.iter().any(|p| {
        p.state.cause == Some(dc::Cause::InsufficientSupply) && p.opening == 1. && p.spring_j == 0.
    });
    let restored_latched = normal.events.iter().any(|p| {
        p.paths.charger_available
            && !p.state.output_closed
            && p.state.cause == Some(dc::Cause::InsufficientSupply)
            && !p.holding
            && !p.closing
    });
    let first_loss = normal.events.iter().position(|p| {
        p.state.cause == Some(dc::Cause::InsufficientSupply) && !p.state.output_closed
    });
    let restored = restored_latched
        && first_loss
            .and_then(|i| {
                normal.events[i + 1..]
                    .iter()
                    .find(|p| p.state.output_closed)
            })
            .is_some_and(|p| {
                p.paths.charger_available && p.opening == 1. && !p.holding && !p.closing
            });
    let recharged = normal.events.iter().any(|p| {
        p.time > 0.
            && p.state.source_j > 0.
            && p.opening == 0.
            && p.holding
            && p.prhr_j > 5000.
            && p.spring_j > 0.
    });
    let reopened = a.opening == 1. && !a.holding && !a.closing && a.prhr_j > 5000.;
    let passed = a.time == HORIZON
        && b.time == HORIZON
        && a.next.is_none_or(|t| t > HORIZON)
        && b.next.is_none_or(|t| t > HORIZON)
        && exhausted
        && restored
        && recharged
        && reopened
        && max == 0.
        && normal.copies > 0
        && tight.copies > 0;
    Ok((passed,format!("{{\"kind\":\"finite-actuation-supply-pair\",\"passed\":{passed},\"policy\":{},\"finiteSupplyEnergyConserved\":true,\"thermalReceiptMatched\":true,\"actualSupportLossReleased\":{exhausted},\"restorationDidNotReplay\":{restored},\"poweredCloseRecharged\":{recharged},\"commandedReopenAchieved\":{reopened},\"retainedCopiesMatched\":{},\"normal\":{},\"tighter\":{},\"maximumPairedEnergyDifferenceJ\":{}}}",quote(POLICY),max==0.,normal.json(),tight.json(),finite(max))))
}

#[cfg(test)]
pub(super) fn nominal_support_fixture() -> Schedule {
    let mut s = tests::schedule();
    s.plan.initial_energy_j = s.plan.config.capacity_j;
    s.plan.events.truncate(1);
    s.plan.events[0].time = 120.;
    s.supply = dc::Supply::new(
        s.plan.config,
        s.plan.initial_energy_j,
        s.plan.paths,
        s.plan.output_closed,
        s.plan.config.normal_group_w,
    )
    .unwrap();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn schedule() -> Schedule {
        let config = pa::Config {
            stroke_s: 5.,
            spring_energy_j: 2500.,
            closing_power_w: 1000.,
            hold_power_w: 20.,
            room_capacity_j_k: 200e6,
            room_wall_w_k: 20000.,
            room_reference_temperature_k: 298.15,
            initial_opening: 0.,
            initial_room_temperature_k: 298.15,
        };
        let inputs = pa::Inputs {
            support: pa::Support {
                hold_supported: true,
                closing_supported: true,
            },
            blocked: false,
            ambient_temperature_k: 298.15,
        };
        let plan = Plan {
            config: dc::Config {
                capacity_j: 57.6e6,
                normal_group_w: 2000.,
                charger_limit_w: 10000.,
                output_limit_w: 20000.,
                charge_efficiency: 0.95,
                discharge_efficiency: 0.95,
                converter_efficiency: 0.92,
            },
            initial_energy_j: 90000.,
            paths: dc::Paths {
                charger_available: false,
                battery_available: true,
                output_healthy: true,
            },
            output_closed: true,
            events: vec![
                Event {
                    time: 60.,
                    charger: Some(true),
                    battery: None,
                    healthy: None,
                    commands: vec![],
                    prhr_command: None,
                },
                Event {
                    time: 65.,
                    charger: None,
                    battery: None,
                    healthy: None,
                    commands: vec![dc::Command::Reset, dc::Command::Close],
                    prhr_command: None,
                },
                Event {
                    time: 70.,
                    charger: None,
                    battery: None,
                    healthy: None,
                    commands: vec![],
                    prhr_command: Some(pa::Command::Close),
                },
                Event {
                    time: 90.,
                    charger: None,
                    battery: None,
                    healthy: None,
                    commands: vec![],
                    prhr_command: Some(pa::Command::Open),
                },
            ],
        };
        let supply =
            dc::Supply::new(plan.config, plan.initial_energy_j, plan.paths, true, 2000.).unwrap();
        Schedule {
            motion: pa::Motion::new(
                pa::Model::new(config).unwrap(),
                0.,
                0.,
                pa::Control::new(true),
                inputs,
            )
            .unwrap(),
            inputs,
            room_row: 0,
            spring_row: 1,
            electrical_row: 2,
            spring_j: 2500.,
            plan,
            supply,
            cursor: 0,
            prhr_delivered_j: 0.,
            other_delivered_j: 0.,
            retained_time: 0.,
            bank_partition_w:0.,
            bank_holding_connected:true,
        }
    }
    fn to(s: &mut Schedule, time: f64) {
        while s.next_event().unwrap().is_some_and(|t| t <= time) {
            let t = s.next_event().unwrap().unwrap();
            s.accept_event(t).unwrap();
        }
    }
    #[test]
    fn actual_supply_loss_recovery_commands_and_paid_close_are_connected() {
        let mut s = schedule();
        assert_eq!(s.next_event().unwrap(), Some(42.75));
        assert_eq!(s.input(42.75, 0.).unwrap().opening, 0.);
        s.accept_event(42.75).unwrap();
        assert_eq!(s.input(42.75, 0.).unwrap().opening_rate, 0.2);
        assert_eq!(s.next_event().unwrap(), Some(47.75));
        to(&mut s, 60.);
        let p = s.point(60.).unwrap();
        assert!(p.paths.charger_available && !p.state.output_closed && !p.holding);
        assert_eq!(p.opening, 1.);
        to(&mut s, 65.);
        let p = s.point(65.).unwrap();
        assert!(p.state.output_closed && !p.holding && !p.closing);
        assert_eq!(p.state.energy_j, 47500.);
        to(&mut s, 70.);
        assert_eq!(s.input(70., 0.).unwrap().opening_rate, -0.2);
        assert_eq!(s.supply.requested_w(), 3000.);
        to(&mut s, 75.);
        let p = s.point(75.).unwrap();
        assert_eq!(p.opening, 0.);
        assert_eq!(p.spring_j, 2500.);
        assert_eq!(p.state.energy_j, 118845.);
        assert_eq!(s.supply.requested_w(), 2000.);
        to(&mut s, 300.);
        let p = s.point(300.).unwrap();
        assert_eq!(p.state.energy_j, 1832835.);
        assert_eq!(p.prhr_j, 6255.);
        assert_eq!(p.other_j, 549945.);
        assert_eq!(p.opening, 1.);
        assert_eq!(p.cursor, 4);
        assert!(p.next.unwrap() > 300.);
        assert!((p.state.source_j - 2608695.652173913).abs() < 1e-8);
        assert!((p.state.loss_j - 309660.652173913).abs() < 1e-8);
    }
    #[test]
    fn durable_numeric_midstroke_latched_and_recovered_copies_continue_without_replay() {
        for (time, left) in [
            (42.75, true),
            (20., false),
            (42.75, false),
            (44., false),
            (47.75, false),
            (62., false),
            (65., false),
            (72.5, false),
            (75., false),
            (92.5, false),
            (95., false),
            (300., false),
        ] {
            let mut original = schedule();
            if !left {
                to(&mut original, time);
            }
            let text = original
                .snapshot_words(time)
                .unwrap()
                .iter()
                .map(|v| format!("{v:0.17e}"))
                .collect::<Vec<_>>()
                .join(" ");
            let words = text
                .split_whitespace()
                .map(|v| v.parse().unwrap())
                .collect::<Vec<_>>();
            let mut copy = schedule().restore_words(&words).unwrap();
            assert_eq!(original.point(time).unwrap(), copy.point(time).unwrap());
            assert!(copy.input(time - 1e-6, 0.).is_err());
            to(&mut original, 300.);
            to(&mut copy, 300.);
            assert_eq!(original.point(300.).unwrap(), copy.point(300.).unwrap());
            assert_eq!(
                original.input(300., 0.).unwrap(),
                copy.input(300., 0.).unwrap()
            );
            let mut malformed = words.clone();
            let last = malformed.len() - 34;
            malformed[last + 22] = 0.5;
            assert!(original.restore_words(&malformed).is_err());
        }
    }
    #[test]
    fn qualification_rejects_restored_output_reholding_or_vacuous_events() {
        let mut s = schedule();
        let mut r = Receipt::default();
        while s.next_event().unwrap().is_some_and(|t| t < 300.) {
            let t = s.next_event().unwrap().unwrap();
            s.accept_event(t).unwrap();
            let p = s.point(t).unwrap();
            let y = [0., 2500. - p.spring_j, p.thermal_j()];
            r.record(&s, t, &y, true).unwrap();
        }
        let p = s.point(300.).unwrap();
        r.record(&s, 300., &[0., 2500. - p.spring_j, p.thermal_j()], false)
            .unwrap();
        assert!(pair(&r, &r).unwrap().0);
        let mut bad = r.clone();
        bad.events
            .iter_mut()
            .filter(|p| p.time == 65.)
            .for_each(|p| p.holding = true);
        assert!(!pair(&bad, &bad).unwrap().0);
        let mut bad = r.clone();
        bad.events.clear();
        assert!(!pair(&bad, &bad).unwrap().0);
        assert!(s.audit(300., &[0., 2500., p.thermal_j() + 1.]).is_err());
    }
    #[test]
    fn storage_path_coincidence_is_arithmetic_not_physical_grace() {
        for offset in [0., 2. * f64::EPSILON * 42.75] {
            let mut s = schedule();
            s.plan.events[0].time = 42.75 + offset;
            s.accept_event(42.75).unwrap();
            assert!(s.point(42.75).unwrap().holding);
            assert_eq!(s.input(42.75, 0.).unwrap().opening_rate, 0.);
        }
        let mut s = schedule();
        s.plan.events[0].time = 42.75 + 1e-6;
        s.accept_event(42.75).unwrap();
        assert!(!s.point(42.75).unwrap().holding);
        to(&mut s, 42.75 + 1e-6);
        assert!(!s.point(42.75 + 1e-6).unwrap().holding);
    }
    #[test]
    fn mechanical_and_supply_boundaries_coalesce_without_tiny_segments() {
        for offset in [-2. * f64::EPSILON * 47.75, 0., 2. * f64::EPSILON * 47.75] {
            let mut s = schedule();
            s.plan.events[0].time = 47.75 + offset;
            s.accept_event(42.75).unwrap();
            let t = s.next_event().unwrap().unwrap();
            let left = s.input(t, 0.).unwrap();
            assert_eq!(left.opening, 1.);
            assert_eq!(left.opening_rate, 0.2);
            s.accept_event(t).unwrap();
            assert_eq!(s.input(t, 0.).unwrap().opening_rate, 0.);
            assert_eq!(s.next_event().unwrap(), Some(65.));
        }
        let mut s = schedule();
        s.plan.events[0].time = 47.75 - 1e-6;
        s.accept_event(42.75).unwrap();
        s.accept_event(47.75 - 1e-6).unwrap();
        assert!(s.input(47.75 - 1e-6, 0.).unwrap().opening < 1.);
        assert_eq!(s.next_event().unwrap(), Some(47.75));
    }
    #[test]
    fn copied_run_cannot_skip_authored_paths_or_commands_and_empty_events_refuse() {
        let mut s = schedule();
        to(&mut s, 62.);
        let copy = s.restore_words(&s.snapshot_words(62.).unwrap()).unwrap();
        assert!(copy.input(66., 0.).is_err());
        assert!(copy.point(66.).is_err());
        let mut plan = s.plan.clone();
        plan.events[0].charger = None;
        assert!(plan.validate().is_err());
    }
    #[test]
    fn actual_sidecar_is_synced_atomically_replaced_and_strictly_restorable() {
        let dir = std::env::temp_dir().join(format!(
            "ld01-act-copy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let physical = dir.join("accepted.bin");
        let path =
            std::path::PathBuf::from(format!("{}.actuation-support.txt", physical.display()));
        let pending = std::path::PathBuf::from(format!("{}.pending", path.display()));
        let mut s = schedule();
        to(&mut s, 62.);
        s.retain(&physical, 62.).unwrap();
        let read = |p: &Path| {
            std::fs::read_to_string(p)
                .unwrap()
                .split_whitespace()
                .map(|v| v.parse().unwrap())
                .collect::<Vec<f64>>()
        };
        let mut copy = schedule().restore_words(&read(&path)).unwrap();
        to(&mut copy, 300.);
        to(&mut s, 65.);
        s.retain(&physical, 65.).unwrap();
        let retained = std::fs::read(&path).unwrap();
        let mut second = schedule().restore_words(&read(&path)).unwrap();
        to(&mut second, 300.);
        assert_eq!(copy.point(300.).unwrap(), second.point(300.).unwrap());
        std::fs::write(&pending, b"unfinished").unwrap();
        assert!(s.retain(&physical, 66.).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), retained);
        std::fs::remove_file(&pending).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }
}

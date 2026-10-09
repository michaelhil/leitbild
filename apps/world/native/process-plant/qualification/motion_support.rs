//! Single ACT.A (including PRHR) and ACT.B finite-support transaction. BANK.HOLD
//! is a partition of the existing normal A load, never an additional demand.
use super::{cooling_actuation::Schedule, finite, quote};
use leitbild_plant_numerics::{dc_supply as dc, prhr, source_motion};

#[derive(Clone)]
pub struct Support {
    pub a: Schedule,
    pub b: dc::Supply,
    pub holding_w: f64,
    pub motive_w: f64,
    pub base_b_w: f64,
    pub requested_rate: f64,
    pub burst_s: f64,
    hold_receipt_j: f64,
    retained_time: f64,
    initial_b_j: f64,
    initial_motive_w: f64,
    initial_requested_rate: f64,
    minimum_time: f64,
    release_at: Option<f64>,
    restore_at: Option<f64>,
    holding_connected: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn support() -> Support {
        let a = super::super::cooling_actuation::nominal_support_fixture();
        let config = a.supply_snapshot().config;
        let b = dc::Supply::new(
            config,
            config.capacity_j,
            dc::Paths {
                charger_available: false,
                battery_available: true,
                output_healthy: true,
            },
            true,
            3000.,
        )
        .unwrap();
        Support::new(a, b, 20., 1000., 2000., 0.04, 0.5).unwrap()
    }
    fn compare(a: &Support, b: &Support, time: f64) {
        assert_eq!(a.a.point(time).unwrap(), b.a.point(time).unwrap());
        assert_eq!(a.b.at(time).unwrap(), b.b.at(time).unwrap());
        assert_eq!(a.b.snapshot(), b.b.snapshot());
        assert_eq!(a.b.rates(), b.b.rates());
        assert_eq!(a.motion_input(time).unwrap(), b.motion_input(time).unwrap());
        assert_eq!(a.holding_j(time).unwrap(), b.holding_j(time).unwrap());
        assert_eq!(a.motive_j(time).unwrap(), b.motive_j(time).unwrap());
        assert_eq!(a.next(200.).unwrap(), b.next(200.).unwrap());
        assert_eq!(
            a.snapshot_words(time).unwrap(),
            b.snapshot_words(time).unwrap()
        );
    }
    #[test]
    fn complete_finite_history_roundtrips_rate_hold_and_settled_times() {
        let mut s = support();
        for time in [0.25, 0.5, 60.5] {
            if time == 0.5 {
                s.accept(time).unwrap();
            }
            let mut copy = s.restore_words(&s.snapshot_words(time).unwrap()).unwrap();
            compare(&s, &copy, time);
            assert!(copy.motion_input(time - 0.125).is_err());
            if time == 0.25 {
                s.accept(0.5).unwrap();
                copy.accept(0.5).unwrap();
                compare(&s, &copy, 0.5);
                // Subsequent loop compares a separately retained HOLD copy.
            }
            let mut future = s.clone();
            if future.requested_rate != 0. {
                future.accept(0.5).unwrap();
            }
            if copy.requested_rate != 0. {
                copy.accept(0.5).unwrap();
            }
            compare(&future, &copy, 120.);
            future.accept(120.).unwrap();
            copy.accept(120.).unwrap();
            compare(&future, &copy, 120.25);
        }
        assert_eq!(s.motive_j(60.5).unwrap(), 500.);
        assert_eq!(s.holding_j(60.5).unwrap(), 1210.);
        assert_eq!(s.a.supply_snapshot().original_energy_j, 57.6e6);
        assert!(s.b.at(60.5).unwrap().loss_j > 0.);
        let receipt = s.json(60.5).unwrap();
        assert!(receipt.contains("B-losses-exported-to-omitted-ROOM.B"));
        assert!(receipt.contains(&format!("\"nonBankBExportJ\":{}", finite(121000.))));
    }
    #[test]
    fn altered_stores_receipts_duty_and_future_event_are_refused() {
        let mut s = support();
        s.accept(0.5).unwrap();
        let words = s.snapshot_words(60.5).unwrap();
        let offset = 3 + words[2] as usize;
        for (i, delta) in [
            (8, 1.),
            (18, 1.),
            (25, 1.),
            (31, 1.),
            (29, 0.04),
            (27, 1000.),
            (17, 1.),
            (34, 1.),
        ] {
            let mut w = words.clone();
            w[offset + i] += delta;
            assert!(s.restore_words(&w).is_err(), "tampered field {i}");
        }
        // A's complete immutable schedule is embedded, including its future event.
        let mut w = words.clone();
        w[3 + 14] += 1.;
        assert!(s.restore_words(&w).is_err());
        let mut w = words;
        w[1] = 0.25;
        assert!(s.restore_words(&w).is_err());
    }
    #[test]
    fn retained_artifact_is_create_new_and_reloads_without_free_energy() {
        let mut s = support();
        s.accept(0.5).unwrap();
        let root = std::env::temp_dir().join(format!(
            "ld01-bank-support-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("common.bin");
        s.retain(&path, 60.5).unwrap();
        let file = root.join("common.bin.motion-support.txt");
        let before = std::fs::read(&file).unwrap();
        assert!(s.retain(&path, 60.5).is_err());
        assert_eq!(before, std::fs::read(&file).unwrap());
        let words = std::str::from_utf8(&before)
            .unwrap()
            .split_whitespace()
            .map(|v| v.parse::<f64>().unwrap())
            .collect::<Vec<_>>();
        compare(&s, &s.restore_words(&words).unwrap(), 60.5);
        assert!(!root.join("common.bin.motion-support.txt.pending").exists());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn ordinary_slice_requires_nominal_a_and_real_bank_partitions() {
        let s = support();
        let a = s.a.clone();
        let b = s.b.clone();
        assert!(Support::new(a.clone(), b.clone(), 2001., 1000., 2000., 0.04, 0.5).is_err());
        assert!(Support::new(a, b, 20., 1000., 1999., 0.04, 0.5).is_err());
        let mut a = s.a.clone();
        let mut ds = a.supply_snapshot();
        ds.state.energy_j -= 1.;
        ds.original_energy_j -= 1.;
        // The A frame cannot substitute a newly depleted original store.
        let mut words = a.snapshot_words(0.).unwrap();
        let prefix = words.len() - 34;
        words[prefix + 2] = ds.state.energy_j;
        words[prefix + 12] = ds.original_energy_j;
        assert!(a.restore_words(&words).is_err());
        a.accept_event(120.).unwrap();
        assert!(Support::new(a, s.b, 20., 1000., 2000., 0.04, 0.5).is_err());
    }
    #[test]
    fn cold_bank_disconnect_changes_actual_a_demand_preserves_prhr_and_cannot_replay_rate() {
        let mut s=support();s.enable_release_at(0.75).unwrap();s.enable_holding_restore_at(1.25).unwrap();
        let original=s.clone();s.accept(0.5).unwrap();
        assert!(s.is_release_event(0.75));let before=s.a.point(0.75).unwrap();
        let before_supply=s.a.supply_snapshot();let before_motion=s.a.motion.snapshot();
        s.accept(0.75).unwrap();let after=s.a.point(0.75).unwrap();
        assert_eq!(after.state.energy_j.to_bits(),before.state.energy_j.to_bits());
        assert_eq!(after.state.delivered_j.to_bits(),before.state.delivered_j.to_bits());
        assert_eq!(after.prhr_j.to_bits(),before.prhr_j.to_bits());assert_eq!(after.other_j.to_bits(),before.other_j.to_bits());
        assert_eq!(s.a.supply_snapshot().requested_w,before_supply.requested_w-20.);
        assert_eq!(s.a.motion.snapshot().holding,before_motion.holding);
        assert_eq!(s.a.motion.snapshot().closing,before_motion.closing);
        assert_eq!(s.motion_input(0.75).unwrap(),source_motion::Input {requested_rate_m_s:0.,motive_power_w:0.,holding_power_w:0.});
        assert_eq!(s.holding_j(1.25).unwrap(),15.);assert_eq!(s.motive_j(1.25).unwrap(),500.);
        let copy=original.restore_words(&s.snapshot_words(1.).unwrap()).unwrap();compare(&s,&copy,1.);
        s.accept(1.25).unwrap();assert_eq!(s.motion_input(1.25).unwrap(),source_motion::Input {
            requested_rate_m_s:0.,motive_power_w:0.,holding_power_w:20.});
        assert_eq!(s.holding_j(2.).unwrap(),30.);assert_eq!(s.motive_j(2.).unwrap(),500.);
        compare(&s,&original.restore_words(&s.snapshot_words(2.).unwrap()).unwrap(),2.);
        assert_eq!(s.a.supply_snapshot().requested_w,before_supply.requested_w);
        assert!(s.a.point(2.).unwrap().state.energy_j>original.a.point(2.).unwrap().state.energy_j);
    }
    #[test]
    fn normal_stop_cause_requires_the_actual_pending_command_and_both_healthy_outputs() {
        let mut before=support();before.enable_release_at(0.75).unwrap();
        let mut after=before.clone();after.accept(0.5).unwrap();
        assert!(before.is_healthy_normal_stop(0.5,&after).unwrap());
        assert!(!before.is_healthy_motion_continuity(0.5,&after).unwrap());
        assert!(after.is_healthy_motion_continuity(0.6,&after).unwrap());
        assert!(!before.is_healthy_normal_stop(0.49,&after).unwrap());
        assert!(!after.is_healthy_normal_stop(0.5,&after).unwrap());
        let mut failed=after.clone();let mut paths=failed.b.paths();paths.output_healthy=false;
        failed.b.transition(0.5,paths,failed.base_b_w,&[]).unwrap();
        assert_eq!(failed.motion_input(0.5).unwrap().holding_power_w,20.);
        assert_eq!(failed.motion_input(0.5).unwrap().requested_rate_m_s,0.);
        assert!(!before.is_healthy_normal_stop(0.5,&failed).unwrap());
        assert!(!after.is_healthy_motion_continuity(0.5,&failed).unwrap());
        after.accept(0.75).unwrap();assert!(!before.is_healthy_normal_stop(0.75,&after).unwrap());
    }
    #[test]
    fn cold_release_snapshot_refuses_changed_future_command_and_disconnected_duty() {
        let mut s=support();s.enable_release_at(0.75).unwrap();let original=s.clone();
        s.accept(0.5).unwrap();s.accept(0.75).unwrap();let words=s.snapshot_words(1.).unwrap();
        for offset in [0,1,2,3] {let mut bad=words.clone();let n=bad.len();bad[n-4+offset]+=1.;
            assert!(original.restore_words(&bad).is_err(),"release command field {offset}");}
        let mut other=support();other.enable_release_at(0.8).unwrap();assert!(other.restore_words(&words).is_err());
        assert!(s.enable_release_at(2.).is_err());assert!(s.enable_holding_restore_at(2.).is_err());
    }
    #[test]
    fn copies_keep_each_side_of_disconnect_and_restore_without_skipping_pending_events() {
        let mut s=support();s.enable_release_at(0.75).unwrap();s.enable_holding_restore_at(1.25).unwrap();
        let original=s.clone();s.accept(0.5).unwrap();
        // The pre-event parent is a valid checkpoint at the exact boundary.
        let mut copy=original.restore_words(&s.snapshot_words(0.75).unwrap()).unwrap();
        compare(&s,&copy,0.75);assert!(copy.is_release_event(0.75));
        assert!(s.snapshot_words(0.76).is_err());
        s.accept(0.75).unwrap();copy.accept(0.75).unwrap();compare(&s,&copy,0.75);
        let mut copy=original.restore_words(&s.snapshot_words(1.25).unwrap()).unwrap();
        compare(&s,&copy,1.25);assert_eq!(copy.next(2.).unwrap(),1.25);
        assert!(s.snapshot_words(1.26).is_err());
        s.accept(1.25).unwrap();copy.accept(1.25).unwrap();compare(&s,&copy,1.25);
        compare(&s,&original.restore_words(&s.snapshot_words(1.5).unwrap()).unwrap(),1.5);
        let mut bad=s.snapshot_words(1.5).unwrap();let n=bad.len();bad[n-1]=0.;
        assert!(original.restore_words(&bad).is_err());
    }
}
impl Support {
    pub fn new(
        a: Schedule,
        b: dc::Supply,
        holding_w: f64,
        motive_w: f64,
        base_b_w: f64,
        requested_rate: f64,
        burst_s: f64,
    ) -> Result<Self, String> {
        let sa = a.supply_snapshot();
        if [holding_w, motive_w, base_b_w, requested_rate, burst_s]
            .iter()
            .any(|v| !v.is_finite() || *v <= 0.)
            || b.requested_w() != base_b_w + motive_w
            || b.snapshot().config.normal_group_w != base_b_w
            || sa.original_energy_j != sa.config.capacity_j
            || sa.state.energy_j != sa.config.capacity_j
            || sa.requested_w != sa.config.normal_group_w
            || holding_w > a.other_requested_w()
            || a.point(0.)?.other_j != 0.
        {
            return Err("Invalid ordinary bank support partition".into());
        }
        let initial_b_j = b.at(0.)?.energy_j;
        let s = Self {
            a,
            b,
            holding_w,
            motive_w,
            base_b_w,
            requested_rate,
            burst_s,
            hold_receipt_j: 0.,
            retained_time: 0.,
            initial_b_j,
            initial_motive_w: motive_w,
            initial_requested_rate: requested_rate,
            minimum_time: 0.,
            release_at:None,
            restore_at:None,
            holding_connected:true,
        };
        s.motion_input(0.)?;
        Ok(s)
    }
    pub fn motion_input(&self, time: f64) -> Result<source_motion::Input, String> {
        self.check_time(time)?;
        let a = self.a.point(time)?;
        let b = self.b.at(time)?;
        if self.release_at.is_none() && (!a.state.output_closed
            || !b.output_closed
            || !self.b.can_deliver(self.base_b_w + self.motive_w))
        {
            return Err("Ordinary connected motion lost actual finite support".into());
        }
        Ok(source_motion::Input {
            requested_rate_m_s: if a.state.output_closed && b.output_closed && self.holding_connected {self.requested_rate} else {0.},
            motive_power_w: if a.state.output_closed && b.output_closed && self.holding_connected {self.motive_w} else {0.},
            holding_power_w: if a.state.output_closed && self.holding_connected {self.holding_w} else {0.},
        })
    }
    pub fn enable_release_at(&mut self,time:f64)->Result<(),String> {
        if self.release_at.is_some() || self.retained_time!=0. || !time.is_finite() || time<=self.burst_s {
            return Err("Cold release requires one future post-lift BANK.HOLD disconnect".into());
        }
        self.a.authorize_bank_partition(self.holding_w)?;
        self.release_at=Some(time);Ok(())
    }
    pub fn enable_holding_restore_at(&mut self,time:f64)->Result<(),String> {
        if self.restore_at.is_some() || self.retained_time!=0.
            || !time.is_finite() || !self.release_at.is_some_and(|t|time>t)
        {return Err("Cold HOLD restoration requires one selected future event".into());}
        self.restore_at=Some(time);Ok(())
    }
    pub fn is_release_event(&self,time:f64)->bool {
        self.release_at.is_some_and(|t|self.holding_connected&&dc::coincident(t,time))
    }
    /// Explicit normal command completion, not an inferred zero-rate input.
    /// All coincident electrical events have already been accepted by `next`.
    pub fn is_healthy_normal_stop(&self,time:f64,next:&Self)->Result<bool,String> {
        Ok(self.requested_rate>0. && dc::coincident(time,self.burst_s)
            && next.requested_rate==0. && next.motive_w==0.
            && self.healthy_outputs_continue(time,next)?)
    }
    fn healthy_outputs_continue(&self,time:f64,next:&Self)->Result<bool,String> {
        Ok(self.holding_connected && next.holding_connected
            && self.a.point(time)?.state.output_closed && next.a.point(time)?.state.output_closed
            && self.b.at(time)?.output_closed && next.b.at(time)?.output_closed)
    }
    /// An unrelated accepted event may retain a coast only while the actual
    /// electrical owners and delivered command are unchanged and healthy.
    pub fn is_healthy_motion_continuity(&self,time:f64,next:&Self)->Result<bool,String> {
        Ok(self.healthy_outputs_continue(time,next)?
            && self.motion_input(time)?==next.motion_input(time)?)
    }
    pub fn prhr_input(&self, time: f64, room: f64) -> Result<prhr::Input, String> {
        self.check_time(time)?;
        let p = self.a.input(time, room)?;
        self.b.at(time)?;
        // ROOM.B is outside this selected cold slice. Its conversion losses
        // stay in the finite B exported-loss receipt, never injected into A.
        Ok(p)
    }
    pub fn next(&self, horizon: f64) -> Result<f64, String> {
        let a = self.a.next_event()?.unwrap_or(horizon);
        let b = self.b.next_storage_event_s()?.unwrap_or(horizon);
        Ok(a.min(b)
            .min(if self.holding_connected {self.release_at.filter(|t|*t>self.retained_time).unwrap_or(horizon)}
                else {self.restore_at.filter(|t|*t>self.retained_time).unwrap_or(horizon)})
            .min(if self.requested_rate != 0. {
                self.burst_s
            } else {
                horizon
            })
            .min(horizon))
    }
    pub fn holding_j(&self, time: f64) -> Result<f64, String> {
        self.check_time(time)?;
        self.a.point(time)?;
        if time < self.retained_time {
            return Err("Bank support query precedes retained time".into());
        }
        let delivered=if self.holding_connected && self.a.supply_snapshot().state.output_closed {self.holding_w} else {0.};
        Ok(self.hold_receipt_j + delivered * (time - self.retained_time))
    }
    pub fn motive_j(&self, time: f64) -> Result<f64, String> {
        self.check_time(time)?;
        let p = self.b.at(time)?;
        Ok(p.delivered_j - self.base_b_w * time)
    }
    pub fn accept(&mut self, time: f64) -> Result<(), String> {
        let mut candidate = self.clone();
        candidate.hold_receipt_j = self.holding_j(time)?;
        candidate.retained_time = time;
        candidate.minimum_time = time;
        if candidate
            .a
            .next_event()?
            .is_some_and(|t| dc::coincident(time, t))
        {
            candidate.a.accept_event(time)?;
        }
        if candidate.is_release_event(time) {
            candidate.a.bank_holding_event(time,false)?;candidate.holding_connected=false;
        } else if !candidate.holding_connected && candidate.restore_at.is_some_and(|t|dc::coincident(time,t)) {
            candidate.a.bank_holding_event(time,true)?;candidate.holding_connected=true;
        }
        if candidate.release_at.is_some() && (!candidate.holding_connected || !candidate.a.point(time)?.state.output_closed) {
            candidate.requested_rate=0.;candidate.motive_w=0.;
            candidate.b.transition(time,candidate.b.paths(),candidate.base_b_w,&[])?;
        }
        if candidate.requested_rate != 0. && dc::coincident(time, candidate.burst_s) {
            candidate.requested_rate = 0.;
            candidate.motive_w = 0.;
            candidate
                .b
                .transition(time, candidate.b.paths(), candidate.base_b_w, &[])?;
        } else if candidate
            .b
            .next_storage_event_s()?
            .is_some_and(|t| dc::coincident(time, t))
        {
            candidate.b.transition(
                time,
                candidate.b.paths(),
                candidate.base_b_w + candidate.motive_w,
                &[],
            )?;
        }
        candidate.motion_input(time)?;
        *self = candidate;
        Ok(())
    }
    pub fn audit(&self, time: f64, y: &[f64]) -> Result<f64, String> {
        self.check_time(time)?;
        let b = self.b.at(time)?;
        self.a.audit(time, y)?;
        let defect = b.energy_j + b.delivered_j + b.loss_j - b.source_j - self.initial_b_j;
        let bound = 128.
            * f64::EPSILON
            * (b.energy_j + b.delivered_j + b.loss_j + b.source_j + self.initial_b_j);
        if defect.abs() > bound {
            return Err("ACT.B finite first law refused".into());
        }
        let a = self.a.point(time)?;
        let other = a.other_j - self.holding_j(time)?;
        if other < -bound {
            return Err("BANK.HOLD exceeds actual ACT.A other delivery".into());
        }
        Ok(defect.abs())
    }
    pub fn json(&self, time: f64) -> Result<String, String> {
        self.check_time(time)?;
        let b = self.b.at(time)?;
        let a = self.a.point(time)?;
        Ok(format!(
            "{{\"A\":{},\"B\":{{\"energyJ\":{},\"sourceJ\":{},\"deliveredJ\":{},\"lossJ\":{},\"closed\":{}}},\"bankHoldingJ\":{},\"bankMotiveJ\":{},\"nonBankAExportJ\":{},\"nonBankBExportJ\":{},\"scope\":{}}}",
            a.json(),
            finite(b.energy_j),
            finite(b.source_j),
            finite(b.delivered_j),
            finite(b.loss_j),
            b.output_closed,
            finite(self.holding_j(time)?),
            finite(self.motive_j(time)?),
            finite(a.other_j - self.holding_j(time)?),
            finite(self.base_b_w * time),
            quote(
                "one-A-owner-including-PRHR;one-B-owner;A-losses-to-ROOM.A;B-losses-exported-to-omitted-ROOM.B"
            )
        ))
    }
    fn check_time(&self, time: f64) -> Result<(), String> {
        if !time.is_finite() || time < self.minimum_time {
            return Err("Bank support query precedes retained checkpoint".into());
        }
        let pending=if self.holding_connected {
            self.release_at.filter(|t|*t>self.retained_time)
        } else {self.restore_at.filter(|t|*t>self.retained_time)};
        if pending.is_some_and(|t|time>t && !dc::coincident(time,t)) {
            return Err("Bank support skipped pending disconnect/restoration".into());
        }
        Ok(())
    }
    /// Complete continuation, including the existing A mechanism/supply frame.
    /// The B anchor is not advanced for copying: receipts and future storage
    /// event remain the same finite history, not a newly prepared battery.
    pub fn snapshot_words(&self, time: f64) -> Result<Vec<f64>, String> {
        self.motion_input(time)?;
        self.holding_j(time)?;
        self.motive_j(time)?;
        let a = self.a.snapshot_words(time)?;
        let b = self.b.snapshot();
        let c = b.config;
        let s = b.state;
        let p = b.paths;
        let r = self.b.rates();
        let next = self.b.next_storage_event_s()?;
        let mut w = vec![1., time, a.len() as f64];
        w.extend(a);
        w.extend([
            c.capacity_j,
            c.normal_group_w,
            c.charger_limit_w,
            c.output_limit_w,
            c.charge_efficiency,
            c.discharge_efficiency,
            c.converter_efficiency,
            s.time_s,
            s.energy_j,
            s.output_closed as u8 as f64,
            match s.cause {
                None => 0.,
                Some(dc::Cause::Overload) => 1.,
                Some(dc::Cause::InsufficientSupply) => 2.,
                Some(dc::Cause::OutputFailure) => 3.,
            },
            s.source_j,
            s.delivered_j,
            s.loss_j,
            p.charger_available as u8 as f64,
            p.battery_available as u8 as f64,
            p.output_healthy as u8 as f64,
            b.requested_w,
            b.original_energy_j,
            r.charger_dc_w,
            r.energy_w,
            r.source_w,
            r.delivered_w,
            r.loss_w,
            next.is_some() as u8 as f64,
            next.unwrap_or(0.),
            self.holding_w,
            self.motive_w,
            self.base_b_w,
            self.requested_rate,
            self.burst_s,
            self.hold_receipt_j,
            self.retained_time,
            self.initial_b_j,
            self.initial_motive_w,
            self.initial_requested_rate,
        ]);
        if let Some(time)=self.release_at {w.extend([time,f64::from(self.restore_at.is_some()),self.restore_at.unwrap_or(0.),f64::from(self.holding_connected)]);}
        Ok(w)
    }
    pub fn restore_words(&self, w: &[f64]) -> Result<Self, String> {
        if w.len() < 39
            || w.iter().any(|x| !x.is_finite())
            || w[0] != 1.
            || w[1] < 0.
            || w[2] < 0.
            || w[2].fract() != 0.
            || w[2] > (w.len() - 39) as f64
        {
            return Err("Malformed bank support snapshot".into());
        }
        let n = w[2] as usize;
        if w.len() != n + 39 + if self.release_at.is_some(){4}else{0} {
            return Err("Malformed bank support frame length".into());
        }
        let time = w[1];
        let v = &w[3 + n..];
        let (release_at,restore_at,holding_connected)=if let Some(release)=self.release_at {
            if v[36]!=release || v[37]!=f64::from(self.restore_at.is_some()) || v[38]!=self.restore_at.unwrap_or(0.)
                || (v[39]!=0. && v[39]!=1.)
            {return Err("Retained bank release command differs from selection".into());}
            // A checkpoint may represent either side of an event equality.
            // Retained accepted-command time, not observation/copy time,
            // determines which discrete transition has actually committed.
            let expected=v[32]<release || self.restore_at.is_some_and(|t|v[32]>=t);
            if (v[39]==1.)!=expected {return Err("Retained bank skipped disconnect/restoration".into());}
            (Some(release),self.restore_at,expected)
        } else {(None,None,true)};
        let boolean = |i: usize| -> Result<bool, String> {
            match v[i] {
                0. => Ok(false),
                1. => Ok(true),
                _ => Err("Malformed bank support boolean".into()),
            }
        };
        let config = dc::Config {
            capacity_j: v[0],
            normal_group_w: v[1],
            charger_limit_w: v[2],
            output_limit_w: v[3],
            charge_efficiency: v[4],
            discharge_efficiency: v[5],
            converter_efficiency: v[6],
        };
        let original = self.b.snapshot();
        if config != original.config
            || v[18] != self.initial_b_j
            || v[26] != self.holding_w
            || v[28] != self.base_b_w
            || v[30] != self.burst_s
            || v[33] != self.initial_b_j
            || v[34] != self.initial_motive_w
            || v[35] != self.initial_requested_rate
        {
            return Err("Bank support snapshot changed immutable plant selection".into());
        }
        let b = dc::Supply::restore(dc::Snapshot {
            config,
            state: dc::State {
                time_s: v[7],
                energy_j: v[8],
                output_closed: boolean(9)?,
                cause: match v[10] {
                    0. => None,
                    1. => Some(dc::Cause::Overload),
                    2. => Some(dc::Cause::InsufficientSupply),
                    3. => Some(dc::Cause::OutputFailure),
                    _ => return Err("Malformed bank B output cause".into()),
                },
                source_j: v[11],
                delivered_j: v[12],
                loss_j: v[13],
            },
            paths: dc::Paths {
                charger_available: boolean(14)?,
                battery_available: boolean(15)?,
                output_healthy: boolean(16)?,
            },
            requested_w: v[17],
            original_energy_j: v[18],
        })?;
        let r = b.rates();
        let next = b.next_storage_event_s()?;
        if v[19..24]
            != [
                r.charger_dc_w,
                r.energy_w,
                r.source_w,
                r.delivered_w,
                r.loss_w,
            ]
            || boolean(24)? != next.is_some()
            || v[25] != next.unwrap_or(0.)
            || v[7] > time
            || v[31] < 0.
            || v[32] < 0.
            || v[32] > time
            || v[17] != v[28] + v[27]
        {
            return Err("Bank support snapshot changed clock, duty, rates or future event".into());
        }
        let rate = v[29];
        let motive = v[27];
        let rate_mode = rate == self.initial_requested_rate
            && motive == self.initial_motive_w
            && time <= self.burst_s;
        let hold_mode = rate == 0. && motive == 0. && time >= self.burst_s;
        if !rate_mode && !hold_mode {
            return Err("Bank snapshot omitted RATE/HOLD transition".into());
        }
        let out = Self {
            a: self.a.restore_words(&w[3..3 + n])?,
            b,
            holding_w: v[26],
            motive_w: motive,
            base_b_w: v[28],
            requested_rate: rate,
            burst_s: v[30],
            hold_receipt_j: v[31],
            retained_time: v[32],
            initial_b_j: v[33],
            initial_motive_w: v[34],
            initial_requested_rate: v[35],
            minimum_time: time,
            release_at,
            restore_at,
            holding_connected,
        };
        if out.a.snapshot_words(time)? != w[3..3 + n] {
            return Err("A and bank retained checkpoints disagree".into());
        }
        let hold = out.holding_j(time)?;
        let motive = out.motive_j(time)?;
        let interrupted=release_at.map_or(0.,|t|(time-t).max(0.)
            -(restore_at.map_or(0.,|r|(time-r).max(0.))));
        let expected_hold = self.holding_w * (time-interrupted);
        let expected_motive = self.initial_motive_w * time.min(self.burst_s);
        let bound = 128.
            * f64::EPSILON
            * (hold.abs() + motive.abs() + expected_hold + expected_motive + self.base_b_w * time)
                .max(1.);
        if (hold - expected_hold).abs() > bound || (motive - expected_motive).abs() > bound {
            return Err("Bank snapshot lost delivered holding or motive work".into());
        }
        out.motion_input(time)?;
        out.next(time.max(self.burst_s) + 1.)?;
        Ok(out)
    }
    /// Publish only after sync and a complete round trip. A final hard link is
    /// an atomic create-new operation; an existing retained artifact is never
    /// overwritten by another run or copy.
    pub fn retain(&self, path: &std::path::Path, time: f64) -> Result<(), String> {
        use std::io::Write;
        let words = self.snapshot_words(time)?;
        let body = words
            .iter()
            .map(|x| format!("{x:.17e}\n"))
            .collect::<String>();
        let parsed = body
            .split_whitespace()
            .map(|x| x.parse::<f64>().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let copy = self.restore_words(&parsed)?;
        if copy.snapshot_words(time)? != words
            || copy.next(time.max(self.burst_s) + 1.)? != self.next(time.max(self.burst_s) + 1.)?
        {
            return Err("Retained bank support round trip mismatch".into());
        }
        let final_path = std::path::PathBuf::from(format!("{}.motion-support.txt", path.display()));
        let pending = std::path::PathBuf::from(format!("{}.pending", final_path.display()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        let publish = (|| -> Result<(), String> {
            file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            std::fs::hard_link(&pending, &final_path).map_err(|e| e.to_string())
        })();
        let cleanup = std::fs::remove_file(&pending).map_err(|e| e.to_string());
        publish.and(cleanup)?;
        std::fs::File::open(final_path.parent().unwrap_or(std::path::Path::new(".")))
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())
    }
}

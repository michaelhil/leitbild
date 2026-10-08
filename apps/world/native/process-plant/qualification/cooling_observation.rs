//! One-way acquired evidence from the accepted plant's dense pressure
//! polynomial. The exact first-order lag has its own retained history; it
//! does not enlarge the physical Newton/LTE system or cap its steps.
use leitbild_plant_numerics::{
    pressure_channel::{Acquisition, Config, Delivered, Faults, Quality},
    pressure_protection::{Assessment, Configuration, Inputs, Protection, Settings},
};
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    path::Path,
    time::Instant,
};

/// Compact selected plant outputs, on the SAME acquisition clock. Pressure
/// entries are surge and common-primary changes from original preparation.
#[derive(Clone, Debug)]
pub(super) struct DenseAudit {
    pub flows: Vec<f64>,
    pub pressure_changes: [f64; 2],
}
impl DenseAudit {
    fn check(&self, flow_count: usize) -> Result<(), String> {
        if self.flows.len() != flow_count
            || self
                .flows
                .iter()
                .chain(&self.pressure_changes)
                .any(|v| !v.is_finite())
        {
            return Err("Invalid dense hydraulic audit record".into());
        }
        Ok(())
    }
}
/// Actual derivative arrays extracted with the existing roof Dky vectors.
pub(super) struct DensePolynomial {
    pub flows: Vec<Vec<f64>>,
    pub pressure_changes: [Vec<f64>; 2],
}
impl DensePolynomial {
    fn at(&self, delta: f64) -> Result<DenseAudit, String> {
        Ok(DenseAudit {
            flows: self
                .flows
                .iter()
                .map(|v| shifted(v, delta).map(|v| v[0]))
                .collect::<Result<_, _>>()?,
            pressure_changes: [
                shifted(&self.pressure_changes[0], delta)?[0],
                shifted(&self.pressure_changes[1], delta)?[0],
            ],
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
struct State {
    config: Config,
    time: f64,
    lag: [f64; 3],
    channels: [Acquisition; 3],
    protection: Protection,
}
#[derive(Clone, Debug)]
pub(super) struct Point {
    time: f64,
    tap: f64,
    lag: [f64; 3],
    readings: [Option<Delivered>; 3],
    assessment: Assessment,
    dense: DenseAudit,
}
pub(super) struct Trace {
    state: State,
    copy: Option<State>,
    first_delivery_s: f64,
    pub points: Vec<Point>,
    pub seconds: f64,
    pub copy_checks: usize,
    normal_flow_absolute: Vec<f64>,
}
impl State {
    fn propagate(&mut self, time: f64, anchor: f64, derivatives: &[f64]) -> Result<f64, String> {
        if time < self.time || time > anchor {
            return Err("Pressure continuation outside accepted segment".into());
        }
        let start = shifted(derivatives, self.time - anchor)?;
        let dt = time - self.time;
        for lag in &mut self.lag {
            *lag = self.config.advance_polynomial(*lag, dt, &start, true)?;
        }
        self.time = time;
        Ok(shifted(derivatives, time - anchor)?[0])
    }
    fn next(&self) -> Result<f64, String> {
        let sample = self.channels[0].next_event_s()?;
        Ok(self
            .protection
            .next_deadline_s()
            .map_or(sample, |p| p.min(sample)))
    }
    fn advance(&mut self, time: f64, dense: DenseAudit) -> Result<Point, String> {
        for (channel, value) in self.channels.iter_mut().zip(self.lag) {
            channel.process_due(time, value, true, Faults::default())?;
        }
        let readings = self.channels.each_ref().map(Acquisition::delivered);
        let assessment = self.protection.advance(
            time,
            Inputs {
                readings,
                channel_powered: [true; 3],
                division_powered: [true; 3],
                accepted_configuration: [Configuration::Cold; 3],
            },
        )?;
        Ok(Point {
            time,
            tap: 0.,
            lag: self.lag,
            readings,
            assessment,
            dense,
        })
    }
}
impl Trace {
    pub fn new(
        config: Config,
        settings: Settings,
        initial: [f64; 3],
        tap: f64,
        dense: DenseAudit,
        normal_flow_absolute: Vec<f64>,
    ) -> Result<Self, String> {
        if !(2..=3).contains(&normal_flow_absolute.len())
            || normal_flow_absolute
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
        {
            return Err("Invalid dense flow consequence allocations".into());
        }
        dense.check(normal_flow_absolute.len())?;
        let channel = Acquisition::new(config, 0.)?;
        let mut state = State {
            config,
            time: 0.,
            lag: initial,
            channels: [channel.clone(), channel.clone(), channel],
            protection: Protection::new(settings)?,
        };
        let mut point = state.advance(0., dense)?;
        point.tap = tap;
        Ok(Self {
            state,
            copy: None,
            first_delivery_s: config.transport_s,
            points: vec![point],
            seconds: 0.,
            copy_checks: 0,
            normal_flow_absolute,
        })
    }
    pub fn next(&self) -> Result<f64, String> {
        self.state.next()
    }
    pub fn check_latest_against(&self, reference: &Self, quantum: f64) -> Result<(), String> {
        if self.normal_flow_absolute != reference.normal_flow_absolute {
            return Err("Dense flow consequence allocations disagree".into());
        }
        let i = self.points.len() - 1;
        let b = reference
            .points
            .get(i)
            .ok_or("Missing normal pressure observation")?;
        compare_point(&self.points[i], b, quantum)?;
        compare_dense(b, &self.points[i], &self.normal_flow_absolute).map(|_| ())
    }
    /// Consume precisely one accepted segment. `derivatives` are the actual
    /// roof-pressure derivatives at its right endpoint, through LAST used
    /// integrator order, not the possibly different proposed next order.
    pub fn continue_dense(
        &mut self,
        start: f64,
        end: f64,
        derivatives: &[f64],
        dense: &DensePolynomial,
        reference: Option<&Self>,
    ) -> Result<(), String> {
        let began = Instant::now();
        if start != self.state.time || !end.is_finite() || end < start {
            return Err("Nonmonotone pressure continuation".into());
        }
        shifted(derivatives, 0.)?;
        if dense.flows.len() != self.normal_flow_absolute.len()
            || dense
                .flows
                .iter()
                .chain(&dense.pressure_changes)
                .any(|v| v.len() != derivatives.len())
        {
            return Err("Dense hydraulic polynomial shape/order mismatch".into());
        }
        // Validate even segments containing no observation deadline.
        dense.at(0.)?.check(self.normal_flow_absolute.len())?;
        while self.next()? <= end {
            let time = self.next()?;
            let tap = self.state.propagate(time, end, derivatives)?;
            if let Some(copy) = &mut self.copy {
                copy.propagate(time, end, derivatives)?;
            }
            self.observe(time, tap, dense.at(time - end)?)?;
            if let Some(reference) = reference {
                self.check_latest_against(reference, self.state.config.quantum_pa)?;
            }
        }
        // Carry the unsampled tail exactly once; otherwise the next step's
        // polynomial would be applied to time lying outside its domain.
        self.state.propagate(end, end, derivatives)?;
        if let Some(copy) = &mut self.copy {
            copy.propagate(end, end, derivatives)?;
            if *copy != self.state {
                return Err("Copied pressure response tail diverged".into());
            }
        }
        self.seconds += began.elapsed().as_secs_f64();
        Ok(())
    }
    fn observe(&mut self, time: f64, tap: f64, dense: DenseAudit) -> Result<(), String> {
        if time != self.next()? {
            return Err("Missed pressure evidence deadline".into());
        }
        if !tap.is_finite() || tap <= 0. {
            return Err("Invalid observed roof-tap pressure".into());
        }
        dense.check(self.normal_flow_absolute.len())?;
        let mut point = self.state.advance(time, dense.clone())?;
        point.tap = tap;
        if let Some(copy) = &mut self.copy {
            copy.advance(time, dense)?;
            if *copy != self.state {
                return Err("Copied acquisition/qualification history diverged".into());
            }
            self.copy_checks += 1;
        } else if time >= 150. {
            self.copy = Some(self.state.clone());
        }
        let valid = !(point
            .assessment
            .causes
            .iter()
            .flatten()
            .any(Option::is_some)
            || point.assessment.trip_requests != [false; 3]
            || point.assessment.cmt_requests != [false; 3]
            || point.assessment.heater_isolation_requests != [false; 3]
            || (time >= self.first_delivery_s
                && (point.readings.iter().any(Option::is_none)
                    || point.assessment.qualified_channels != [[true; 3]; 3])));
        self.points.push(point);
        if !valid {
            return Err(format!(
                "Healthy cold pressure evidence has false/missing decision at {time}"
            ));
        }
        Ok(())
    }
    pub fn retain(&self, path: &Path) -> Result<(), String> {
        let f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut w = BufWriter::new(f);
        let flow_order = if self.normal_flow_absolute.len() == 3 {
            "[\"surge-left\",\"surge-right\",\"PRHR-seat\"]"
        } else {
            "[\"surge-left\",\"surge-right\"]"
        };
        write!(w,"{{\"scope\":\"exact-passive-lag-from-accepted-roof-polynomial;healthy-boundary-powered-COLD;not-achieved-protection\",\"denseAuditScope\":\"paired-polynomial-output-consistency-not-independent-physical-interpolant-closure\",\"denseFlowOrder\":{flow_order},\"densePressureChangeOrder\":[\"surge\",\"common-primary\"],\"normalFlowAbsoluteKgS\":{:?},\"copyAtS\":150,\"copyChecks\":{},\"observerSeconds\":{},\"points\":[",self.normal_flow_absolute,self.copy_checks,self.seconds).map_err(|e|e.to_string())?;
        for (i, p) in self.points.iter().enumerate() {
            if i != 0 {
                write!(w, ",").map_err(|e| e.to_string())?
            }
            write!(w, "{}", p.json()).map_err(|e| e.to_string())?;
        }
        writeln!(w, "]}}").map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        w.get_ref().sync_all().map_err(|e| e.to_string())
    }
}
/// Taylor shift with derivative (not power-coefficient) input. Six entries
/// are the selected solver's degree-five dense output, not a plant cutoff.
fn shifted(derivatives: &[f64], delta: f64) -> Result<Vec<f64>, String> {
    if derivatives.is_empty()
        || derivatives.len() > 6
        || !delta.is_finite()
        || derivatives.iter().any(|x| !x.is_finite())
    {
        return Err("Invalid accepted roof-pressure polynomial".into());
    }
    let q = derivatives.len() - 1;
    let result = (0..=q)
        .map(|k| {
            let mut v = derivatives[q];
            for j in (k..q).rev() {
                v = derivatives[j] + delta * v / (j + 1 - k) as f64;
            }
            v
        })
        .collect::<Vec<_>>();
    if result.iter().any(|x| !x.is_finite()) {
        return Err("Unrepresentable roof-pressure polynomial shift".into());
    }
    Ok(result)
}
fn optional(v: Option<f64>) -> String {
    v.map_or("null".into(), |v| v.to_string())
}
fn reading_json(r: Option<Delivered>) -> String {
    r.map_or("null".into(), |r| {
        let (quality, value) = match r.quality {
            Quality::Value(v) => ("value", Some(v)),
            Quality::BelowRange { bound_pa } => ("belowRange", Some(bound_pa)),
            Quality::AboveRange { bound_pa } => ("aboveRange", Some(bound_pa)),
            Quality::Unavailable => ("unavailable", None),
        };
        format!(
            "{{\"acquiredAtS\":{},\"deliveredAtS\":{},\"quality\":\"{}\",\"valueOrBoundPa\":{}}}",
            r.acquired_at_s,
            r.delivered_at_s,
            quality,
            optional(value)
        )
    })
}
impl Point {
    fn json(&self) -> String {
        let causes = self
            .assessment
            .causes
            .iter()
            .map(|r| {
                format!(
                    "[{}]",
                    r.iter().map(|v| optional(*v)).collect::<Vec<_>>().join(",")
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"timeS\":{},\"roofTapPa\":{},\"lagPa\":{:?},\"readings\":[{}],\"qualifiedChannels\":{:?},\"causes\":[{}],\"tripRequests\":{:?},\"cmtRequests\":{:?},\"heaterIsolationRequests\":{:?},\"denseFlowsKgS\":{:?},\"densePressureChangesPa\":{:?}}}",
            self.time,self.tap,self.lag,self.readings.map(reading_json).join(","),self.assessment.qualified_channels,causes,
            self.assessment.trip_requests,self.assessment.cmt_requests,self.assessment.heater_isolation_requests,self.dense.flows,self.dense.pressure_changes)
    }
}
pub(super) fn compare(a: &Trace, b: &Trace, quantum: f64) -> Result<String, String> {
    if a.points.len() != b.points.len()
        || a.points.len() < 3001
        || a.copy_checks == 0
        || b.copy_checks == 0
        || a.points.last().is_none_or(|p| p.time != 300.)
        || b.points.last().is_none_or(|p| p.time != 300.)
        || a.normal_flow_absolute != b.normal_flow_absolute
    {
        return Err("Incomplete acquired pressure timeline or copy check".into());
    }
    let (mut lag, mut acquired, mut tap) = (0f64, 0f64, 0f64);
    let (mut dense_flow, mut dense_pressure) = (0f64, 0f64);
    let flow_absolute = &a.normal_flow_absolute;
    for (a, b) in a.points.iter().zip(&b.points) {
        let (l, q, t) = compare_point(a, b, quantum)?;
        lag = lag.max(l);
        acquired = acquired.max(q);
        tap = tap.max(t);
        let (f, p) = compare_dense(a, b, flow_absolute)?;
        dense_flow = dense_flow.max(f);
        dense_pressure = dense_pressure.max(p);
    }
    Ok(format!("{{\"passed\":true,\"eventsPerArm\":{},\"rawLagMaximumDifferencePa\":{},\"roofTapMaximumDifferencePa\":{},\"rawLagLimitPa\":10,\"acquiredMaximumDifferencePa\":{},\"acquiredLimitPa\":{},\"denseFlowPairMaximumRatio\":{dense_flow},\"densePressureChangePairMaximumRatio\":{dense_pressure},\"denseAuditScope\":\"paired-polynomial-output-consistency-not-independent-physical-interpolant-closure\",\"identicalDecisionsAndTimes\":true,\"copyChecks\":[{},{}],\"observerSeconds\":[{},{}],\"scope\":\"cold-one-way-pressure-evidence-not-actuator-qualification\"}}",a.points.len(),lag,tap,acquired,quantum,a.copy_checks,b.copy_checks,a.seconds,b.seconds))
}
fn compare_dense(normal: &Point, tighter: &Point, absolute: &[f64]) -> Result<(f64, f64), String> {
    if normal.time != tighter.time {
        return Err("Dense consequence observation times disagree".into());
    }
    normal.dense.check(absolute.len())?;
    tighter.dense.check(absolute.len())?;
    let mut flow = 0f64;
    for ((a, b), floor) in normal
        .dense
        .flows
        .iter()
        .zip(&tighter.dense.flows)
        .zip(absolute)
    {
        flow = flow.max((a - b).abs() / (0.005 * b.abs() + floor));
    }
    let pressure = normal
        .dense
        .pressure_changes
        .iter()
        .zip(&tighter.dense.pressure_changes)
        .map(|(a, b)| (a - b).abs() / (0.005 * b.abs() + 1.))
        .fold(0f64, f64::max);
    if !flow.is_finite() || !pressure.is_finite() || flow > 1. || pressure > 1. {
        return Err(format!(
            "Dense flow/pressure consequence pair exceeds original bands at {}: {flow}/{pressure}",
            tighter.time
        ));
    }
    Ok((flow, pressure))
}
fn compare_point(a: &Point, b: &Point, quantum: f64) -> Result<(f64, f64, f64), String> {
    if a.time != b.time || a.assessment != b.assessment {
        return Err(format!(
            "Pressure evidence decision/timing disagreement at {}",
            a.time
        ));
    }
    let (mut lag, mut acquired) = (0f64, 0f64);
    let tap = (a.tap - b.tap).abs();
    for k in 0..3 {
        lag = lag.max((a.lag[k] - b.lag[k]).abs());
        match (a.readings[k], b.readings[k]) {
            (None, None) => {}
            (Some(x), Some(y))
                if x.acquired_at_s == y.acquired_at_s && x.delivered_at_s == y.delivered_at_s =>
            {
                match (x.quality, y.quality) {
                    (Quality::Value(x), Quality::Value(y)) => {
                        acquired = acquired.max((x - y).abs());
                    }
                    (x, y) if x == y => {}
                    _ => return Err("Pressure evidence quality differs".into()),
                }
            }
            _ => return Err("Pressure evidence timestamps differ".into()),
        }
    }
    if !lag.is_finite()
        || !acquired.is_finite()
        || !tap.is_finite()
        || lag > 10.
        || tap > 10.
        || acquired > quantum
    {
        return Err(format!(
            "Pressure evidence pair exceeds raw10Pa/one-quantum limits at {}: {lag}/{acquired}",
            a.time
        ));
    }
    Ok((lag, acquired, tap))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn zero_dense(order: usize) -> DensePolynomial {
        DensePolynomial {
            flows: vec![vec![0.; order]; 2],
            pressure_changes: [vec![0.; order], vec![0.; order]],
        }
    }
    fn fresh() -> Trace {
        let c = Config {
            lag_s: 0.2,
            min_pa: 0.,
            max_pa: 20e6,
            quantum_pa: 1000.,
            sample_s: 0.1,
            transport_s: 0.1,
        };
        let s = Settings {
            maximum_age_s: 0.3,
            recovery_s: 1.,
            high_pa: 15.5e6,
            high_qualification_s: 0.2,
            low_pa: 13e6,
            low_qualification_s: 0.5,
            unavailable_qualification_s: 1.,
            reset_low_pa: 13.5e6,
            reset_high_pa: 15.2e6,
            reset_qualification_s: 5.,
        };
        Trace::new(
            c,
            s,
            [250000.; 3],
            250000.,
            DenseAudit {
                flows: vec![0.; 2],
                pressure_changes: [0.; 2],
            },
            vec![1e-5; 2],
        )
        .unwrap()
    }
    fn trace() -> Trace {
        let mut t = fresh();
        t.continue_dense(0., 300., &[250000.], &zero_dense(1), None)
            .unwrap();
        t
    }
    #[test]
    fn dense_segment_tails_and_changing_order_preserve_response() {
        let mut a = fresh();
        let mut b = fresh();
        a.continue_dense(0., 0.2, &[250002., 10.], &zero_dense(2), None)
            .unwrap();
        b.continue_dense(0., 0.031, &[250000.31, 10.], &zero_dense(2), None)
            .unwrap();
        b.continue_dense(0.031, 0.067, &[250000.67, 10., 0.], &zero_dense(3), None)
            .unwrap();
        b.continue_dense(0.067, 0.2, &[250002., 10.], &zero_dense(2), None)
            .unwrap();
        assert!((a.state.lag[0] - b.state.lag[0]).abs() < 1e-9);
        assert_eq!(a.points.len(), b.points.len());
        assert!(a
            .points
            .iter()
            .zip(&b.points)
            .all(|(a, b)| (a.lag[0] - b.lag[0]).abs() < 1e-9));
        assert!(b
            .continue_dense(0.2, 0.19, &[250002.], &zero_dense(1), None)
            .is_err());
        assert!(b
            .continue_dense(0.21, 0.3, &[250003., 10.], &zero_dense(2), None)
            .is_err());
    }
    #[test]
    fn full_clock_and_copy_preserve_actual_acquisitions_not_current_truth() {
        let a = trace();
        let mut b = trace();
        assert_eq!(a.points.len(), 3001);
        assert_eq!(a.copy_checks, 1500);
        assert_eq!(a.points[0].readings, [None; 3]);
        assert_eq!(a.points[1].readings[0].unwrap().acquired_at_s, 0.);
        assert!(a.points[1]
            .assessment
            .qualified_channels
            .iter()
            .all(|r| r.iter().all(|v| *v)));
        assert!(a
            .points
            .iter()
            .all(|p| p.assessment.trip_requests == [false; 3]));
        assert!(compare(&a, &b, 1000.).is_ok());
        b.points[10].lag[0] += 11.;
        assert!(compare(&a, &b, 1000.).is_err());
        b.points[10].lag[0] -= 11.;
        b.points[10].tap += 11.;
        assert!(compare(&a, &b, 1000.).is_err());
    }
    #[test]
    fn adjacent_bins_are_not_false_failures_but_timing_quality_and_decisions_are() {
        let a = trace();
        let mut b = trace();
        b.points[10].readings[0].as_mut().unwrap().quality = Quality::Value(251000.);
        assert!(compare(&a, &b, 1000.).is_ok());
        b.points[10].readings[0].as_mut().unwrap().acquired_at_s += 0.01;
        assert!(compare(&a, &b, 1000.).is_err());
        let mut b = trace();
        b.points[10].assessment.trip_requests[0] = true;
        assert!(compare(&a, &b, 1000.).is_err());
    }
    #[test]
    fn critical_dense_outputs_use_actual_polynomial_and_same_clock_across_partitions() {
        let mut whole = fresh();
        let mut split = fresh();
        // q0=t+2t², q1=−3t; dp0=100t, dp1=−20t².
        let polynomial = |t: f64| DensePolynomial {
            flows: vec![
                vec![t + 2. * t * t, 1. + 4. * t, 4.],
                vec![-3. * t, -3., 0.],
            ],
            pressure_changes: [vec![100. * t, 100., 0.], vec![-20. * t * t, -40. * t, -40.]],
        };
        whole
            .continue_dense(0., 0.4, &[250000., 0., 0.], &polynomial(0.4), None)
            .unwrap();
        split
            .continue_dense(0., 0.13, &[250000., 0., 0.], &polynomial(0.13), None)
            .unwrap();
        split
            .continue_dense(0.13, 0.4, &[250000., 0., 0.], &polynomial(0.4), None)
            .unwrap();
        for (a, b) in whole.points.iter().zip(&split.points) {
            assert_eq!(a.time, b.time);
            for (x, y) in a.dense.flows.iter().zip(&b.dense.flows) {
                assert!((x - y).abs() < 1e-14);
            }
            assert!((a.dense.flows[0] - (a.time + 2. * a.time * a.time)).abs() < 1e-14);
            assert!((a.dense.pressure_changes[1] + 20. * a.time * a.time).abs() < 1e-14);
        }
    }
    #[test]
    fn dense_pair_uses_tighter_signal_and_declared_owner_allocation_and_rejects_hidden_drift() {
        let a = trace();
        let mut b = trace();
        b.points[10].dense.flows[0] = 1.1e-5;
        assert!(compare(&a, &b, 1000.).is_err()); // old roof/acquisition still identical.
        b.points[10].dense.flows[0] = 0.;
        b.points[10].dense.pressure_changes[0] = 1.01;
        assert!(compare(&a, &b, 1000.).is_err());
        let mut normal = a.points[1].clone();
        let mut tighter = normal.clone();
        normal.dense.flows = vec![2.01, 0., 0.002];
        tighter.dense.flows = vec![2., 0., 0.];
        let ratio = compare_dense(&normal, &tighter, &[1e-5, 1e-5, 0.003])
            .unwrap()
            .0;
        assert!((ratio - 0.01 / 0.01001).abs() < 1e-12);
        assert!(compare_dense(&normal, &tighter, &[1e-5, 1e-5, 0.001]).is_err());
        tighter.dense.flows[0] = f64::NAN;
        assert!(compare_dense(&normal, &tighter, &[1e-5, 1e-5, 0.003]).is_err());
    }
    #[test]
    fn malformed_dense_polynomial_is_refused_before_any_tick() {
        let mut t = fresh();
        assert!(t
            .continue_dense(0., 0.01, &[250000.], &zero_dense(2), None)
            .is_err());
        let mut p = zero_dense(1);
        p.flows[0][0] = f64::NAN;
        assert!(t.continue_dense(0., 0.01, &[250000.], &p, None).is_err());
        assert_eq!(t.state.time, 0.);
    }
}

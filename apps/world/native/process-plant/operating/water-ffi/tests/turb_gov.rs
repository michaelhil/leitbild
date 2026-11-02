//! Plan r4 X4.3 (lane TURB): the frame-driven S3 unit with the LOAD
//! governor, ADM and GEN.WT after the slice, the SG owner's choked valve law
//! and at-power bypass band, and automatic rod control in AUTO, from the
//! saved S3 state on a steady bus: a hold, or a hold with Grid power-request
//! steps decided at Grid exchanges (1 s instants). Test-only; one run per
//! invocation, ignored by default.
//!
//! Environment: the S3 unit's (`LD01_OPERATING_HOT_SPINE_PACKET`,
//! `LD01_WIKI_ROOT`, `LD01_IC_SECTION`, `LD01_PZR_CONTROL_SECTION`,
//! `LD01_PZR_CONTROL_WIKI`, `ELEC_PACKET`, `LD01_S3_STATE`),
//! `LD01_ROD_CONTROL_WIKI` (`ld01-rod-control`), `LD01_TURB_WIKI` (the
//! turbine and admission pages' blocks), `LD01_TURB_SPAN_S`,
//! `LD01_TURB_STEPS` (optional: `<fraction of the start request>@<seconds
//! after the start>,...`, each on a whole second), `LD01_TURB_RAMP` (optional:
//! `<to fraction>@<from s>/<fraction per minute>`, a 1 s staircase of Grid
//! requests from the fraction in force at `from`, merged with the steps),
//! `LD01_TURB_OUT`, `LD01_TURB_STATE_OUT` (optional: the end state, in the
//! saved S3 state's form, governed; written once, only after a full run).
#![cfg(all(feature = "ida", target_os = "macos"))]
mod common;
#[allow(dead_code)]
#[path = "s3_harness/counters.rs"]
mod counters;
mod s2_harness;
use leitbild_operating_plant::ic::acquisition::Quality;
use s2_harness::{compare, gates, outputs};

use leitbild_operating_plant::electrical::slice;
use leitbild_operating_water::{
    electrical::{self, Electrified},
    frame::{Change, Class, Client, Dense, Diagnostic, MatrixRebuild, Observer, Side, Stepping},
    ida::System,
    joined::{Integrated, JoinedSystem},
    unit::{
        clock::process_cpu_s,
        inputs::Inputs,
        plant::{self, Plant},
        profile::Solver,
        rod_control, s3,
        turbine::{self, Turbine},
    },
};
use serde_json::{Value, json};

type Unit = Electrified<Integrated<leitbild_operating_water::If97>>;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

/// Per frame (observation only): instructions retired, the governor's
/// coordinates and setpoint, speed, the SG pressures and the band opening
/// the SG owner's at-power law gives them.
struct Recorder {
    n: usize,
    pressures: Vec<(usize, f64)>,
    setpoint_w: f64,
    mode: String,
    bypass_kg_s: f64,
    scratch: Vec<f64>,
    cost: Vec<(f64, u64)>,
    series: Vec<Value>,
}
impl Client<Unit> for Recorder {
    fn name(&self) -> &str {
        "X4.3 recorder"
    }
    fn advance(&mut self, _: &dyn Dense, _: f64, _: f64) -> Result<(), String> {
        Ok(())
    }
    fn sample(&mut self, _: u64, t: f64, u: &Unit) -> Result<(), String> {
        let g = u.governor.as_ref().ok_or("no governor")?;
        self.setpoint_w = g.setpoint_w(t);
        self.mode = g.held.mode.to_string();
        // The bypass part of the pickup steam of the last evaluation: the
        // SG steam ports' outflow less the turbine's admitted steam.
        let steam: f64 = u
            .integrated()
            .joined
            .secondary()
            .ok_or("no SG owner")?
            .account()
            .crossings
            .iter()
            .filter(|c| c.port.ends_with(".steam"))
            .map(|c| -c.mass_kg_s)
            .sum();
        self.bypass_kg_s = steam - u.slice.inputs.admitted_kg_s;
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<Unit>>, String> {
        self.cost.push((t, counters::instructions()?));
        dense.derivative(t, 0, &mut self.scratch)?;
        let y = &self.scratch;
        let (n, e) = (self.n, electrical::N);
        let p: Vec<f64> = self.pressures.iter().map(|(i, s)| y[*i] * s).collect();
        self.series.push(json!({"k": k, "t_s": t, "watt_W": y[n + e], "integral": y[n + e + 1], "opening": y[n + e + 2],
            "setpoint_W": self.setpoint_w, "mode": self.mode, "omega_rad_s": y[n + slice::OMEGA],
            "sg_pressure_Pa": p, "bypass_kg_s": self.bypass_kg_s}));
        Ok(Vec::new())
    }
}

/// PHYS2's X4 judge inputs (record only), at every sample of the S1 gates'
/// observation grid: the credited outputs (S2's reader, for R11-3a's E0),
/// and at every 0.1 s frame `x4_frames` (PZR roof pressure and collapsed
/// level, as PZR.PT/LT acquire, and each SG's NR measurand, the apparent
/// level `(V_l + V_sub)/A`). Each sample evaluates the unit at its state.
struct Observe {
    n: usize,
    origin: f64,
    frame_s: f64,
    obs_s: f64,
    reader: outputs::Reader,
    sg: Vec<[(usize, f64); 2]>,
    area_m2: f64,
    credited: compare::Credited,
    error: Option<String>,
    frames: Vec<Value>,
    scratch: Vec<f64>,
}
fn on_grid(origin: f64, dt: f64, t: f64) -> bool {
    let k = ((t - origin) / dt).round();
    (origin + k * dt - t).abs() <= 1e-9 * dt.max(1.)
}
impl Observer<Unit> for Observe {
    fn next_after(&self, t: f64) -> Option<f64> {
        let mut k = ((t - self.origin) / self.obs_s).floor() + 1.;
        while self.origin + k * self.obs_s <= t {
            k += 1.;
        }
        Some(self.origin + k * self.obs_s)
    }
    fn sample(
        &mut self,
        u: &mut Unit,
        t: f64,
        y: &[f64],
        yp: &[f64],
        _: &[f64],
        side: Side,
    ) -> Result<(), String> {
        if side != Side::Step || self.error.is_some() {
            return Ok(());
        }
        if let Err(e) = u.residual(t, y, yp, &mut self.scratch) {
            self.error = Some(format!("evaluation at {t} s: {e:?}"));
            return Ok(());
        }
        let out = match self.reader.read(&u.integrated().joined, &y[..self.n], true) {
            Ok(o) => o,
            Err(e) => {
                self.error = Some(format!("credited outputs at {t} s: {e}"));
                return Ok(());
            }
        };
        if on_grid(self.origin, self.frame_s, t) {
            let get = |k: &str| out.iter().find(|(n, _)| *n == k).map(|(_, v)| v[0]);
            let level: Vec<f64> = self
                .sg
                .iter()
                .map(|[vl, vs]| (y[vl.0] * vl.1 + y[vs.0] * vs.1) / self.area_m2)
                .collect();
            self.frames.push(json!({"t_s": t, "pzr_roof_pa": get("pzr_roof_pa"), "pzr_level_m": get("pzr_level_m"), "sg_level_m": level}));
        }
        if let Err(e) = self.credited.push(t, &out) {
            self.error = Some(e);
        }
        Ok(())
    }
}

/// The gate observation's declared settings (S2's blocks, as s3_cases).
struct GateSetup {
    budgets: compare::Budgets,
    network_packet: leitbild_operating_plant::network::packet::Packet,
    reference_travel_m: f64,
    area_m2: f64,
}
impl GateSetup {
    fn load() -> Self {
        let s2 = gates::Declaration::load().unwrap_or_else(|e| panic!("the S2 blocks: {e}"));
        let budgets = compare::Budgets::from(&s2).unwrap_or_else(|e| panic!("{e}"));
        let bytes = common::packet_bytes().1;
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        Self {
            budgets,
            network_packet: serde_json::from_slice(&bytes).expect("network packet"),
            reference_travel_m: raw["rods"]["reference_travel_m"]
                .as_f64()
                .expect("reference travel"),
            area_m2: raw["secondary"]["apparentLevel"]["indication"]["indicatedLevelArea_m2"]
                .as_f64()
                .expect("the NR indicated-level area"),
        }
    }
}

/// The case's drive: steps, the R1 staircase (`LD01_TURB_RAMP`) and span.
struct Drive {
    span: f64,
    steps: Vec<(f64, f64)>,
    ramp: Option<Value>,
}
fn case_drive() -> Drive {
    let span: f64 = env("LD01_TURB_SPAN_S").parse().unwrap();
    let mut steps: Vec<(f64, f64)> = std::env::var("LD01_TURB_STEPS").map_or(Vec::new(), |s| {
        s.split(',')
            .map(|e| {
                let (f, at) = e
                    .split_once('@')
                    .expect("LD01_TURB_STEPS=<fraction>@<s>,...");
                (f.parse().unwrap(), at.parse().unwrap())
            })
            .collect()
    });
    let ramp = std::env::var("LD01_TURB_RAMP").ok().map(|r| {
        let (to, rest) = r
            .split_once('@')
            .expect("LD01_TURB_RAMP=<to>@<from s>/<per min>");
        let (from, per_min) = rest
            .split_once('/')
            .expect("LD01_TURB_RAMP=<to>@<from s>/<per min>");
        let (to, from, per_min): (f64, f64, f64) = (
            to.parse().unwrap(),
            from.parse().unwrap(),
            per_min.parse().unwrap(),
        );
        assert!(
            per_min > 0. && from.fract() == 0.,
            "a positive rate from a whole second"
        );
        let f0 = steps.iter().rev().find(|s| s.1 <= from).map_or(1., |s| s.0);
        let (total, per_s) = ((to - f0).abs(), per_min / 60.);
        // One Grid request per 1 s exchange; the last lands exactly on `to`.
        let count = (total / per_s - 1e-9).ceil() as usize;
        for k in 1..=count {
            let f = if k == count {
                to
            } else {
                f0 + (to - f0).signum() * k as f64 * per_s
            };
            steps.push((f, from + k as f64));
        }
        steps.sort_by(|a, b| a.1.total_cmp(&b.1));
        json!({"spec": r, "kind": "staircase: one Grid request per 1 s exchange", "from_fraction": f0, "to_fraction": to,
            "from_s": from, "per_min": per_min, "requests": count})
    });
    assert!(
        steps.windows(2).all(|w| w[0].1 < w[1].1)
            && steps
                .iter()
                .all(|s| s.1 > 0. && s.1 < span && s.1.fract() == 0.),
        "steps on whole seconds (Grid exchanges), in time order inside the span"
    );
    Drive { span, steps, ramp }
}

/// One composed run of the drive at `scaling`, observed when `gates` is given.
struct Driven {
    plant: Plant,
    rods: rod_control::RodClient,
    rec: Recorder,
    rod_receipt: Value,
    decisions: Vec<Value>,
    failure: Option<String>,
    request0: f64,
    t0: f64,
    n: usize,
    observe: Option<Observe>,
    tags: Vec<Value>,
    cpu: f64,
    instructions: u64,
    composed: u64,
}
#[allow(clippy::too_many_arguments)]
fn drive(
    inputs: &Inputs,
    state: &Value,
    turbine: &Turbine,
    section: &leitbild_operating_plant::control::rods::Section,
    ids: &[String],
    d: &Drive,
    scaling: s3::Scaling,
    gates: Option<&GateSetup>,
) -> Driven {
    let started = process_cpu_s();
    let instructions0 = counters::instructions().unwrap();
    let mut unit =
        s3::compose_governed_with(inputs, state, scaling, Solver::STOCK, Some(turbine), Ok)
            .unwrap_or_else(|e| panic!("{e}"));
    let (t0, y, reference, n) = (unit.t0, unit.y.clone(), unit.reference.clone(), unit.n);
    let request0 = unit.ida.system().governor.as_ref().unwrap().held.to_w;
    type Scaled = (usize, f64);
    let (pressures, sg): (Vec<Scaled>, Vec<[Scaled; 2]>) = {
        let j = &unit.ida.system().integrated().joined;
        let o = j.offsets().secondary;
        let scales = j.scales();
        let sec = j.secondary().unwrap();
        let labels = &sec.layout().labels;
        let at = |l: &str| {
            let i = o + labels
                .iter()
                .position(|x| x == l)
                .unwrap_or_else(|| panic!("no {l}"));
            (i, scales[i])
        };
        let ids: Vec<String> = labels
            .iter()
            .filter_map(|l| l.strip_prefix("SG.").and_then(|r| r.strip_suffix(".V_l")))
            .map(str::to_string)
            .collect();
        (
            sec.admission_terms(t0)
                .unwrap()
                .iter()
                .map(|(i, _)| (o + i, scales[o + i]))
                .collect(),
            ids.iter()
                .map(|id| [at(&format!("SG.{id}.V_l")), at(&format!("SG.{id}.V_sub"))])
                .collect(),
        )
    };
    let observe = gates.map(|g| Observe {
        n,
        origin: t0,
        frame_s: inputs.ic.frame_s,
        obs_s: g.budgets.observation_s,
        reader: outputs::Reader::new(
            &unit.ida.system().integrated().joined,
            &g.network_packet,
            g.reference_travel_m,
        )
        .unwrap_or_else(|e| panic!("{e}")),
        sg,
        area_m2: g.area_m2,
        credited: compare::Credited::default(),
        error: None,
        frames: Vec::new(),
        scratch: vec![0.; y.len()],
    });
    let (mut rods, rod_receipt) = rod_control::commission(
        unit.ida.system_mut(),
        section,
        ids,
        Class::S,
        t0,
        &y,
        &reference,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let mut plant = Plant::new(
        unit,
        &inputs.ic,
        plant::Config {
            field: None,
            diagnostic: Diagnostic::None,
            matrix_rebuild: MatrixRebuild::Stock,
            clock: process_cpu_s,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let mut rec = Recorder {
        n,
        pressures,
        bypass_kg_s: 0.,
        setpoint_w: request0,
        // The start frame precedes any sample: the composed mode.
        mode: plant
            .ida
            .system()
            .governor
            .as_ref()
            .unwrap()
            .held
            .mode
            .to_string(),
        scratch: vec![0.; y.len()],
        cost: Vec::new(),
        series: Vec::new(),
    };
    let mut observe = observe;
    let composed = counters::instructions().unwrap();
    {
        let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut rec];
        plant.start(&mut extra).unwrap_or_else(|e| panic!("{e}"));
    }
    // The observation grid's origin: the composed consistent start.
    if let Some(o) = observe.as_mut() {
        let (y0, yp0) = (plant.y.clone(), plant.yp.clone());
        o.sample(plant.ida.system_mut(), t0, &y0, &yp0, &[], Side::Step)
            .unwrap_or_else(|e| panic!("{e}"));
    }
    let end = t0 + d.span;
    let mut failure: Option<String> = None;
    let mut decisions = Vec::new();
    let mut t = t0;
    let mut legs: Vec<(f64, Option<f64>)> =
        d.steps.iter().map(|(f, at)| (t0 + at, Some(*f))).collect();
    legs.push((end, None));
    // R4-FREE-STEPS: under free stepping a run's bound is only an
    // observation mark, so every Grid request instant and the run's end are
    // declared exact stops (as s3_cases declares its exchanges' ends).
    if plant.driver.stepping == Stepping::Free {
        for (b, _) in &legs {
            plant
                .driver
                .declare_stop(*b)
                .unwrap_or_else(|e| panic!("the drive's stops: {e}"));
        }
    }
    // PROC's dry evaluation (record only): LD01_TURB_TAGS=1 reads every IC
    // channel's and state report's delivered sample at each whole second,
    // as the unit host does (`ld01-unit`'s channel list: value and quality,
    // in the units the IC section delivers).
    let tags_on = std::env::var("LD01_TURB_TAGS").as_deref() == Ok("1");
    let mut tags: Vec<Value> = Vec::new();
    let mut record_tags = |plant: &Plant, t: f64| {
        let q = |x: &Option<(u64, Quality)>| match x {
            None => (Value::Null, 0),
            Some((_, Quality::Value(v))) => (json!(v), 1),
            Some((_, Quality::BelowRange(v))) => (json!(v), 2),
            Some((_, Quality::AboveRange(v))) => (json!(v), 3),
            Some((_, Quality::Indeterminate(v))) => (json!(v), 4),
        };
        let p = &plant.protection.protection;
        let mut row = serde_json::Map::new();
        for (id, d) in p.delivered() {
            let (v, k) = q(&d);
            row.insert(id, json!([v, k]));
        }
        for (id, d) in p.delivered_reports() {
            row.insert(
                id,
                json!([
                    d.map(|(_, r)| if r { 1 } else { 0 }),
                    i32::from(d.is_some())
                ]),
            );
        }
        tags.push(json!({"t_s": t, "tags": row}));
    };
    if tags_on {
        record_tags(&plant, t0);
    }
    'legs: for (b, fraction) in &legs {
        // With the tags, the run is observed at every whole second (marks,
        // not stops, under free stepping).
        let mut marks: Vec<f64> = Vec::new();
        if tags_on {
            // Whole seconds are exact in f64 here, so first + k equals the
            // repeated + 1 bit for bit.
            let first = t.floor() + 1.;
            marks.extend(
                (0u32..)
                    .map(|k| first + f64::from(k))
                    .take_while(|m| *m < *b - 1e-9),
            );
        }
        marks.push(*b);
        for m in marks {
            let r = {
                let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut rec];
                let obs = observe.as_mut().map(|o| o as &mut dyn Observer<Unit>);
                plant.run(t, m, &mut extra, obs)
            };
            if let Err(e) = r {
                failure = Some(format!("at {} s: {e}", plant.driver.solver_reached_s));
                break 'legs;
            }
            t = m;
            if tags_on {
                record_tags(&plant, m);
            }
        }
        if let Some(f) = *fraction {
            let request = f * request0;
            let dd = turbine::grid_request(&mut plant.driver, plant.ida.system(), t, request);
            let r = dd.and_then(|what| {
                decisions.push(json!({"t_s": t, "request_W": request, "decision": what}));
                let mut extra: [&mut dyn Client<_>; 2] = [&mut rods, &mut rec];
                plant.apply_due(&mut extra)
            });
            if let Err(e) = r {
                failure = Some(format!("the Grid request at {t} s: {e}"));
                break 'legs;
            }
        }
    }
    Driven {
        plant,
        rods,
        rec,
        rod_receipt,
        decisions,
        failure,
        request0,
        t0,
        n,
        observe,
        tags,
        cpu: process_cpu_s() - started,
        instructions: counters::instructions().unwrap() - instructions0,
        composed: composed - instructions0,
    }
}

#[test]
#[ignore = "one X4.3 run per invocation (LD01_TURB_SPAN_S, LD01_TURB_STEPS, LD01_TURB_OUT)"]
fn turb_gov_run() {
    let inputs = Inputs::from_env().unwrap_or_else(|e| panic!("{e}"));
    let state_path = env("LD01_S3_STATE");
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    let d = case_drive();
    let (span, steps) = (d.span, d.steps.clone());
    let turbine = Turbine::from_wiki(&env("LD01_TURB_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let section =
        rod_control::section(&env("LD01_ROD_CONTROL_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let packet = inputs.spine.packet_json().unwrap();
    let ids: Vec<String> = packet["mechanics"]["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    // PHYS2's X4 inputs (record only): LD01_TURB_GATES=1 adds the observed
    // run (x4_frames, credited outputs) after the cost drive, and
    // LD01_TURB_SERIES=1 R11-3a's references rtol/10, /30, /100 (every atol
    // scaled with it), each over the whole span, as the X1 cases.
    let gates_on = std::env::var("LD01_TURB_GATES").as_deref() == Ok("1");
    let series_on = std::env::var("LD01_TURB_SERIES").as_deref() == Ok("1");
    assert!(
        !series_on || gates_on,
        "LD01_TURB_SERIES=1 needs LD01_TURB_GATES=1"
    );
    let gates = gates_on.then(GateSetup::load);
    let cost = drive(
        &inputs,
        &state,
        &turbine,
        &section,
        &ids,
        &d,
        s3::Scaling::NONE,
        None,
    );
    let observed = gates.as_ref().map(|g| {
        drive(
            &inputs,
            &state,
            &turbine,
            &section,
            &ids,
            &d,
            s3::Scaling::NONE,
            Some(g),
        )
    });
    let mut families = serde_json::Map::new();
    let mut x4_frames = Value::Null;
    if let (Some(g), Some(o)) = (gates.as_ref(), observed.as_ref()) {
        let ob = o.observe.as_ref().unwrap();
        x4_frames = json!(ob.frames);
        families.insert("G_cost".into(), json!({"family": "G cost", "ou_cost_drive_frames":
            cost.rec.cost.iter().map(|(t, i)| json!([t, i])).collect::<Vec<_>>(),
            "basis": "the unobserved drive's frame instructions (the observed run evaluates the unit at every sample)",
            "trajectory_equal": cost.rec.series == o.rec.series && cost.rods.series == o.rods.series}));
        if series_on {
            let refs: Vec<(String, Driven)> = [10., 30., 100.]
                .into_iter()
                .map(|k: f64| {
                    let sc = s3::Scaling {
                        relative: 1. / k,
                        absolute: 1. / k,
                    };
                    (
                        format!("rtol/{k}"),
                        drive(&inputs, &state, &turbine, &section, &ids, &d, sc, Some(g)),
                    )
                })
                .collect();
            let e0 = |a: &Driven, b: &Driven| match (a.observe.as_ref(), b.observe.as_ref()) {
                (Some(x), Some(y))
                    if x.error.is_none()
                        && y.error.is_none()
                        && a.failure.is_none()
                        && b.failure.is_none() =>
                {
                    compare::compare(&x.credited, &y.credited, a.t0, 0., span, &g.budgets)
                }
                _ => {
                    json!({"evaluable": false, "looser_failure": a.failure, "tighter_failure": b.failure,
                    "looser_observation": a.observe.as_ref().and_then(|x| x.error.clone()),
                    "tighter_observation": b.observe.as_ref().and_then(|x| x.error.clone())})
                }
            };
            let comparisons: Vec<Value> = refs
                .iter()
                .map(|(name, r)| {
                    json!({"reference": name, "span_after_zero_s": [0., span],
                    "reference_failure": r.failure, "reference_cpu": r.cpu, "e0": e0(o, r)})
                })
                .collect();
            let series: Vec<Value> = refs
                .windows(2)
                .map(|w| json!({"looser": w[0].0, "tighter": w[1].0, "e0": e0(&w[0].1, &w[1].1)}))
                .collect();
            families.insert("E_refinement".into(), json!({"family": "E refinement",
                "rule": "R11-3a: rtol/10, /30, /100 with every atol scaled, each over the whole span; E0 run - reference and looser - tighter (s2_harness compare)",
                "comparison_rule": compare::COMPARISON_RULE, "comparisons": comparisons, "series": series}));
        }
    }
    let main = observed.as_ref().unwrap_or(&cost);
    let (plant, failure, t0, n, request0) =
        (&main.plant, &main.failure, main.t0, main.n, main.request0);
    let end = t0 + span;
    let reached = plant.driver.solver_reached_s;
    let state_out = std::env::var("LD01_TURB_STATE_OUT").ok();
    let state_written = match (&state_out, failure) {
        (Some(path), None) => {
            assert!(
                !std::path::Path::new(path).exists(),
                "states are never overwritten"
            );
            let (y, yp) = (&plant.y, &plant.yp);
            let s = json!({"t_s": end, "packet": state["packet"], "packet_sha256": state["packet_sha256"],
                "y": &y[..n], "yp": &yp[..n],
                "appended": {"owner": "electrical slice (ELEC) + X4.3 governor (TURB)", "y": &y[n..], "yp": &yp[n..]},
                "discrete_state": plant.ida.system().system_discrete_state(),
                "pzr_control": {"in_force_w": plant.control.in_force_w},
                "composition": plant.composition["composition"],
                "from": format!("turb_gov_run from {state_path}, span {span} s, steps {steps:?}")});
            let bytes = serde_json::to_vec(&s).unwrap();
            std::fs::write(path, &bytes).unwrap();
            Some(json!({"path": path, "sha256": leitbild_operating_plant::digest::sha256(&bytes)}))
        }
        _ => None,
    };
    let receipt = json!({
        "stepping": format!("{:?}", plant.driver.stepping),
        "case": if steps.is_empty() { "X4.3 LOAD hold" } else { "X4.3 Grid request steps" },
        "ramp": d.ramp, "drive": {"steps": steps.len(), "ramp": d.ramp, "grid_decisions": main.decisions.len()},
        "state_written": state_written,
        "state": state_path, "t0_s": t0, "span_s": span, "request0_W": request0,
        "steps": steps.iter().map(|(f, a)| json!({"fraction": f, "at_s": a})).collect::<Vec<_>>(),
        "grid_decisions": main.decisions, "reached_s": reached, "failure": failure,
        "composition": plant.composition, "rod_control": main.rod_receipt,
        "timeline": {"zero_s": steps.first().map_or(t0, |(_, a)| t0 + a)},
        "run": {
            // R4-COST-UNIT r2's record (ld01-cost's measure label), as this
            // harness runs: no residual-jump diagnostic (Diagnostic::None),
            // and the frames ld01-cost reads come from the drive without an
            // observer (the unobserved cost drive under LD01_TURB_GATES=1,
            // else the one drive, which is unobserved).
            "configuration": {"case_configuration": {"jump_diagnostic": false, "cost_excludes_case_observer": true}},
            "ou_frame_instructions": main.rec.cost.iter().map(|(t, i)| json!([t, i])).collect::<Vec<_>>(),
            "instants": plant.driver.log, "counts": plant.driver.counts.json(),
            "counts_r": plant.driver.counts.total(Class::R), "counts_s": plant.driver.counts.total(Class::S),
            "cpu_s": main.cpu, "instructions": main.instructions,
            "instructions_after_composition": main.instructions - main.composed,
            "cost_drive": {"cpu_s": cost.cpu, "instructions": cost.instructions, "failure": cost.failure},
        },
        "observation": main.observe.as_ref().map(|o| json!({"observation_s": o.obs_s, "frame_s": o.frame_s,
            "samples": o.credited.t.len(), "error": o.error, "sg_level": "(V_l + V_sub)/A, A = the NR indicated-level area"})),
        "x4_frames": x4_frames, "families": families,
        "ic_tags": (!main.tags.is_empty()).then(|| json!({"every_s": 1, "values": "[value, quality]: quality 0 none, 1 value, 2 below range, 3 above range, 4 indeterminate (value = band); state reports [1 reported | 0 not, 0 none | 1 value]",
            "units": "as the IC section delivers each channel (ld01-unit's channel list names them)", "section": std::env::var("LD01_IC_SECTION").ok(), "samples": main.tags})),
        "elec_log": plant.ida.system().log,
        "rod_schedule": main.rods.schedule, "rod_series": main.rods.series, "series": main.rec.series,
    });
    let out = env("LD01_TURB_OUT");
    std::fs::write(&out, serde_json::to_vec(&receipt).unwrap()).unwrap();
    eprintln!(
        "turb_gov: reached {reached} s of {end} s, {} R / {} S, {:.1} CPU-s, receipt {out}",
        plant.driver.counts.total(Class::R),
        plant.driver.counts.total(Class::S),
        main.cpu
    );
    if let Some(f) = receipt["failure"].as_str() {
        panic!("{f}");
    }
    if let Some(e) = main.observe.as_ref().and_then(|o| o.error.as_ref()) {
        panic!("the observation: {e}");
    }
}

/// X4.3's new Jacobian entries against central differences of the
/// residual at the composed start: the valve column (SG rows, torque,
/// governor), the SG pressure columns (torque row) and the governor's and
/// stator columns (governor rows). Ignored by default (needs the S3 unit).
#[test]
#[ignore = "needs the S3 unit's environment and LD01_TURB_WIKI"]
fn turb_gov_jacobian_columns() {
    use leitbild_operating_water::ida::System;
    let inputs = Inputs::from_env().unwrap_or_else(|e| panic!("{e}"));
    let state: Value =
        serde_json::from_slice(&std::fs::read(env("LD01_S3_STATE")).unwrap()).unwrap();
    let turbine = Turbine::from_wiki(&env("LD01_TURB_WIKI")).unwrap_or_else(|e| panic!("{e}"));
    let mut unit = s3::compose_governed(&inputs, &state, Solver::STOCK, &turbine)
        .unwrap_or_else(|e| panic!("{e}"));
    let (t, n) = (unit.t0, unit.n);
    let (mut y, yp) = (unit.y.clone(), unit.yp.clone());
    // Off the start's full-open corner (u* = 1 there): the law's interior.
    y[n + electrical::N + 1] -= 0.05;
    y[n + electrical::N + 2] = 0.97;
    let sys = unit.ida.system_mut();
    let dim = sys.dimension();
    let nnz = sys.nonzeros();
    let cj = 50.;
    let (mut data, mut rows, mut ptr) = (vec![0.; nnz], vec![0i64; nnz], vec![0i64; dim + 1]);
    sys.jacobian(t, cj, &y, &yp, &mut data, &mut rows, &mut ptr)
        .unwrap();
    assert!(
        ptr[dim] as usize <= nnz,
        "the entries fit the declared capacity"
    );
    let entry = |r: usize, c: usize| -> Option<f64> {
        (ptr[c] as usize..ptr[c + 1] as usize)
            .find(|&k| rows[k] as usize == r)
            .map(|k| data[k])
    };
    let e = electrical::N;
    let a = n + e + 2;
    let pressures: Vec<usize> = {
        let j = &sys.integrated().joined;
        let o = j.offsets().secondary;
        j.secondary()
            .unwrap()
            .admission_terms(t)
            .unwrap()
            .iter()
            .map(|(i, _)| o + i)
            .collect()
    };
    let mut columns = vec![
        a,
        n + e,
        n + e + 1,
        n + 3,
        n + 4,
        n + slice::OMEGA,
        n + slice::THETA,
    ];
    columns.extend(&pressures);
    let mut worst: f64 = 0.;
    for &c in &columns {
        let h = 1e-6 * y[c].abs().max(1e-3);
        let (mut r1, mut r2) = (vec![0.; dim], vec![0.; dim]);
        let (mut y1, mut y2, mut p1, mut p2) = (y.clone(), y.clone(), yp.clone(), yp.clone());
        y1[c] += h;
        p1[c] += cj * h;
        y2[c] -= h;
        p2[c] -= cj * h;
        sys.residual(t, &y1, &p1, &mut r1).unwrap();
        sys.residual(t, &y2, &p2, &mut r2).unwrap();
        for r in 0..dim {
            let fd = (r1[r] - r2[r]) / (2. * h);
            let j = entry(r, c);
            // Only rows the X4.3 couplings touch: the SG rows on the valve,
            // the appended rows on every column checked.
            let checked = r >= n || c == a;
            if !checked {
                continue;
            }
            let scale = fd.abs().max(j.unwrap_or(0.).abs()).max(1e-12);
            match j {
                Some(v) => {
                    let rel = (v - fd).abs() / scale;
                    if rel > 1e-4 && (v - fd).abs() > 1e-9 {
                        panic!("row {r} column {c}: J {v} against FD {fd}");
                    }
                    worst = worst.max(if (v - fd).abs() > 1e-9 { rel } else { 0. });
                }
                None if fd.abs() > 1e-8 => {
                    panic!("row {r} column {c}: FD {fd} outside the pattern")
                }
                None => {}
            }
        }
    }
    eprintln!(
        "turb_gov_jacobian_columns: {} columns, worst relative difference {worst:e}",
        columns.len()
    );
}

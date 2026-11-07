//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s3-declaration-draft-case-c4
//! S3 case C4 (C4 lane): the `ld01-s3-cases-c4` block's volume classes
//! checked on the packet, a frame-driven run's C4 events read from the
//! driver's log (each restart's transaction receipts, as the owners wrote
//! them), and every declared C4 line judged on them with its numbers. A
//! line the run cannot decide is reported as such, never passed.
use serde_json::{Value, json};

/// Revision 4 (owner, 7 November, after result). Revision 3 stays pinned under
/// its own fence for C3's chattering check.
pub const FENCE: &str = "ld01-s3-cases-c4-r4";

/// A regular cell's declared volume class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Hot,
    Cold,
    Neither,
    Excluded,
}
impl Side {
    pub fn name(self) -> &'static str {
        match self {
            Self::Hot => "hot",
            Self::Cold => "cold",
            Self::Neither => "neither",
            Self::Excluded => "excluded",
        }
    }
}

/// The network's cells by name (the packet's mechanics regions, network
/// order) with their class.
#[derive(Clone, Debug, PartialEq)]
pub struct Classes {
    pub names: Vec<String>,
    pub side: Vec<Side>,
}

fn names(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

impl Classes {
    /// The block's lists against its rule on the packet: hot = the fluid
    /// regions prepared at the hot legs' enthalpy, cold = at the cold
    /// legs', excluded as listed, every other cell neither. Refuses unless
    /// the lists equal the rule's result.
    pub fn from_block(spec: &Value, packet: &Value) -> Result<Self, String> {
        let regions = packet["mechanics"]["regions"]
            .as_array()
            .ok_or("the packet has no mechanics regions")?;
        let names: Vec<String> = regions
            .iter()
            .map(|r| {
                r["id"]
                    .as_str()
                    .map(str::to_string)
                    .ok_or("a region without id")
            })
            .collect::<Result<_, _>>()?;
        let fluid = packet["hot"]["fluid"]["regions"]
            .as_array()
            .ok_or("the packet has no hot fluid regions")?;
        let enthalpy = |id: &str| -> Result<f64, String> {
            fluid
                .iter()
                .find(|r| r["id"] == id)
                .and_then(|r| r["enthalpy_j_kg"].as_f64())
                .ok_or(format!("no prepared enthalpy for {id}"))
        };
        let hot_h = enthalpy("HOT.A.UPSTREAM")?;
        let cold_h = enthalpy("COLD.A")?;
        if enthalpy("HOT.B")?.to_bits() != hot_h.to_bits()
            || enthalpy("COLD.B")?.to_bits() != cold_h.to_bits()
        {
            return Err("the two loops' legs are prepared at different enthalpies".into());
        }
        let excluded = self::names(&spec["excluded"]);
        let mut side = Vec::new();
        for n in &names {
            let s = if excluded.contains(n) {
                Side::Excluded
            } else {
                match fluid.iter().find(|r| r["id"] == n.as_str()) {
                    Some(r) => match r["enthalpy_j_kg"].as_f64() {
                        Some(h) if h.to_bits() == hot_h.to_bits() => Side::Hot,
                        Some(h) if h.to_bits() == cold_h.to_bits() => Side::Cold,
                        _ => Side::Neither,
                    },
                    None => Side::Neither,
                }
            };
            side.push(s);
        }
        let c = Self { names, side };
        for (key, want) in [
            ("hot", Side::Hot),
            ("cold", Side::Cold),
            ("neither", Side::Neither),
            ("excluded", Side::Excluded),
        ] {
            let mut declared = self::names(&spec[key]);
            let mut ruled: Vec<String> = c
                .names
                .iter()
                .zip(&c.side)
                .filter(|(_, s)| **s == want)
                .map(|(n, _)| n.clone())
                .collect();
            declared.sort();
            ruled.sort();
            if declared != ruled {
                return Err(format!(
                    "volume class {key}: the block lists {declared:?}, the rule on the packet gives {ruled:?}"
                ));
            }
        }
        Ok(c)
    }
    pub fn of(&self, cell: usize) -> Side {
        self.side.get(cell).copied().unwrap_or(Side::Excluded)
    }
    pub fn name(&self, cell: usize) -> String {
        self.names
            .get(cell)
            .cloned()
            .unwrap_or_else(|| format!("cell {cell}"))
    }
}

/// One L1 lock change: (case time, path, face, phase, locked after, cause).
pub type L1Change = (f64, usize, usize, usize, bool, String);

/// C4's events on the case clock, from the driver's log.
#[derive(Clone, Debug, Default)]
pub struct Events {
    /// PZR relief receipts (the malfunction command and the root
    /// transactions): (t, receipt).
    pub relief: Vec<(f64, Value)>,
    /// Births: (t, cell, the instant's class, its restart summary).
    pub births: Vec<(f64, usize, String, Value)>,
    pub exhaustions: Vec<(f64, usize)>,
    pub l1: Vec<L1Change>,
    /// SG relief threshold crossings: (t, valve, threshold, direction).
    pub sg_relief: Vec<(f64, String, String, i64)>,
    pub seats: Vec<(String, f64)>,
    pub commands: Vec<(f64, String)>,
}

fn changes_into(out: &mut Vec<L1Change>, t: f64, changes: &Value, cause_default: &str) {
    for c in changes.as_array().into_iter().flatten() {
        let (Some(path), Some(face), Some(phase)) =
            (c["path"].as_u64(), c["face"].as_u64(), c["phase"].as_u64())
        else {
            continue;
        };
        let locked = c["after"].get("Locked").is_some();
        let cause = c["cause"]
            .as_str()
            .map_or_else(|| cause_default.to_string(), str::to_string);
        out.push((
            t,
            path as usize,
            face as usize,
            phase as usize,
            locked,
            cause,
        ));
    }
}

impl Events {
    pub fn from_log(log: &[Value], zero: f64) -> Result<Self, String> {
        let mut e = Self::default();
        for instant in log {
            let t = instant["t_s"]
                .as_f64()
                .ok_or_else(|| format!("an instant without time: {instant}"))?
                - zero;
            let class = instant["class"].as_str().unwrap_or_default().to_string();
            for k in instant["kinds"].as_array().into_iter().flatten() {
                if let Some(k) = k.as_str().and_then(|k| k.strip_prefix("command ")) {
                    e.commands.push((t, k.to_string()));
                }
            }
            let restart = &instant["restart"];
            for x in restart["transactions"].as_array().into_iter().flatten() {
                let at = x["t_s"].as_f64().map_or(t, |a| a - zero);
                match x["owner"].as_str() {
                    // The malfunction's command receipt and the relief's root
                    // transactions; the heater-demand notes are not relief.
                    Some("pzr") => {
                        if x.get("stuck_open").is_some() || x.get("demand_root").is_some() {
                            e.relief.push((at, x.clone()));
                        }
                    }
                    Some("phase modes") => {
                        for ev in x["events"].as_array().into_iter().flatten() {
                            if let Some(c) = ev["birth"].as_u64() {
                                e.births
                                    .push((at, c as usize, class.clone(), restart.clone()));
                            }
                            if let Some(c) = ev["exhaustion"].as_u64() {
                                e.exhaustions.push((at, c as usize));
                            }
                        }
                        changes_into(
                            &mut e.l1,
                            at,
                            &x["vaporPathContacts"]["changes"],
                            "exhaustion",
                        );
                    }
                    Some("secondary") => {
                        for r in x["relief"].as_array().into_iter().flatten() {
                            e.sg_relief.push((
                                at,
                                r["valve"].as_str().unwrap_or_default().to_string(),
                                r["threshold"].as_str().unwrap_or_default().to_string(),
                                r["direction"].as_i64().unwrap_or(0),
                            ));
                        }
                    }
                    Some(o) if o.starts_with("network L1") => {
                        changes_into(&mut e.l1, at, &x["changes"], "L1");
                    }
                    _ => {}
                }
                for r in x["rods"].as_array().into_iter().flatten() {
                    if r["event"] == "seat" {
                        e.seats.push((
                            r["cluster"].as_str().unwrap_or_default().to_string(),
                            r["t_s"].as_f64().map_or(at, |a| a - zero),
                        ));
                    }
                }
            }
        }
        Ok(e)
    }

    /// L1 paths locked again after a release (the kernel's ledger rule,
    /// `network::phase_events::Ledger::chattering`): (path, face, phase,
    /// relocks, shortest interval between successive changes).
    pub fn chattering(&self) -> Vec<Value> {
        let mut paths: std::collections::BTreeMap<usize, Vec<(f64, bool, usize, usize)>> =
            std::collections::BTreeMap::new();
        for (t, p, f, k, locked, _) in &self.l1 {
            paths.entry(*p).or_default().push((*t, *locked, *f, *k));
        }
        paths
            .iter()
            .filter_map(|(p, ch)| {
                let relocks = ch.windows(2).filter(|w| !w[0].1 && w[1].1).count();
                (relocks > 0).then(|| {
                    let shortest = ch
                        .windows(2)
                        .map(|w| w[1].0 - w[0].0)
                        .fold(f64::INFINITY, f64::min);
                    json!({"path": p, "face": ch[0].2, "phase": ch[0].3, "relocks": relocks,
                        "changes": ch.len(), "shortest_interval_s": shortest})
                })
            })
            .collect()
    }
}

/// Whether a restart's transaction receipt starts a declared C4 event window
/// (`windows.from`): the relief malfunction's command, the reactor trip
/// (`LD01.TRIP.HOLD` lost: the holding-loss command) and each birth.
pub fn starts_window(receipt: &Value) -> bool {
    (receipt["owner"] == "pzr" && receipt.get("stuck_open").is_some())
        || receipt["command"] == "HoldingLoss"
        || (receipt["owner"] == "phase modes"
            && receipt["events"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|e| e.get("birth").is_some()))
}

/// The window starts in the driver's log (case clock), one per instant.
pub fn window_starts(log: &[Value], zero: f64) -> Vec<f64> {
    log.iter()
        .filter(|e| {
            e["restart"]["transactions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(starts_window)
        })
        .filter_map(|e| e["t_s"].as_f64().map(|t| t - zero))
        .collect()
}

/// The acquired PT channels a division's decision at `t` (case clock) votes
/// on: each channel's delivered value, `None` when not a fresh value
/// (older than the family's maximum age, or not a value quality).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Acquired {
    pub t: f64,
    pub channels: Vec<Option<f64>>,
}

/// The wiki's three-channel vote (source-and-primary-protection.md): three
/// usable need two affirmative, two usable need both, fewer establish
/// nothing. `low`: affirmative at or below `setpoint`, else at or above.
pub fn affirmative(channels: &[Option<f64>], setpoint: f64, low: bool) -> bool {
    let usable: Vec<f64> = channels.iter().flatten().copied().collect();
    let yes = usable
        .iter()
        .filter(|v| {
            if low {
                **v <= setpoint
            } else {
                **v >= setpoint
            }
        })
        .count();
    match usable.len() {
        3 => yes >= 2,
        2 => yes == 2,
        _ => false,
    }
}

/// The voted value, whose comparison with a setpoint decides the vote:
/// three usable, the second lowest (low) or second highest (high); two
/// usable, the larger (low) or the smaller (high); `None` otherwise.
pub fn voted(channels: &[Option<f64>], low: bool) -> Option<f64> {
    let mut usable: Vec<f64> = channels.iter().flatten().copied().collect();
    usable.sort_by(f64::total_cmp);
    if !low {
        usable.reverse();
    }
    match usable.len() {
        2 | 3 => Some(usable[1]),
        _ => None,
    }
}

/// The first decision instant at which the voted predicate has held for
/// `frames` decisions (the qualification timer, `k - since >= frames`).
pub fn qualified_at(acquired: &[Acquired], setpoint: f64, low: bool, frames: usize) -> Option<f64> {
    let mut since: Option<usize> = None;
    for (k, a) in acquired.iter().enumerate() {
        if affirmative(&a.channels, setpoint, low) {
            let s = *since.get_or_insert(k);
            if k - s >= frames {
                return Some(a.t);
            }
        } else {
            since = None;
        }
    }
    None
}

/// Rule A′ for one voted function: every powered division accepts the
/// cause exactly at the decision instant its predicate qualifies on the
/// acquired evidence, and none accepts it otherwise.
pub fn consistency(
    qualified: Option<f64>,
    accepted: &[(usize, f64)],
    powered: &[usize],
) -> (bool, Value) {
    let ok = match qualified {
        None => accepted.is_empty(),
        Some(q) => {
            powered
                .iter()
                .all(|d| accepted.iter().any(|(i, t)| i == d && same(*t, q)))
                && accepted.iter().all(|(_, t)| same(*t, q))
        }
    };
    (
        ok,
        json!({"qualified_s": qualified, "accepted": accepted, "powered": powered, "holds": ok}),
    )
}

/// One frame instant's observed values (case clock).
#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub t: f64,
    pub roof_pa: f64,
    /// Each SG's pressure (Pa), in label order.
    pub sg_pa: Vec<f64>,
    pub lift: f64,
    pub relief_kg_s: f64,
    /// Each core region's liquid departure from saturation (K) and vapour
    /// mass (kg), as B1's check reads them.
    pub core_departure_k: Vec<f64>,
    pub core_vapor_kg: Vec<f64>,
}

/// What the C4 judges read besides the events.
pub struct Run<'a> {
    /// The run's end on the case clock and how it ended.
    pub end: f64,
    pub events: &'a Events,
    pub classes: &'a Classes,
    /// The protection's divisions as `s3_cases` records them.
    pub divisions: &'a [Value],
    pub holding_lost: Option<f64>,
    pub operator_trip: Option<f64>,
    pub frames: &'a [Frame],
    pub clusters: usize,
    /// Setpoints from the compiled section and the packet: PZR low and
    /// high pressure (Pa), SG relief crack (Pa).
    pub low_pa: f64,
    pub high_pa: f64,
    pub sg_crack_pa: f64,
    /// The relief's declared full travel (s) and the birth threshold (K).
    pub full_travel_s: f64,
    pub birth_threshold_k: f64,
    /// L1 composed and active in this run.
    pub l1_active: bool,
    /// The acquired PZR PT channels at every decision instant, and the low-
    /// and high-pressure functions' qualification in frames.
    pub pt: &'a [Acquired],
    pub low_frames: usize,
    pub high_frames: usize,
    /// Block r2's O4′ (S3-D57) and N4′ (owner R7-Q, S3-D58), judged by the
    /// gate families on the run's log (`families::first_classified_birth`
    /// with the presence cache's read set; `families::chattering` under the
    /// pinned N4 rule with the restarts' entries and the drives' classes);
    /// `None` where the run could not judge them.
    pub o4: Option<&'a Value>,
    pub n4: Option<&'a Value>,
}

fn causes<'a>(
    divisions: &'a [Value],
    function: &'a str,
) -> impl Iterator<Item = (usize, f64)> + 'a {
    divisions.iter().enumerate().flat_map(move |(i, d)| {
        d["causes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(move |c| c["function"] == function)
            .filter_map(move |c| c["t_s"].as_f64().map(|t| (i, t)))
    })
}

fn line(id: &str, spec: &Value, verdict: &str, numbers: Value) -> Value {
    json!({"id": format!("C4.{id}"), "kind": spec["kind"], "verdict": verdict, "numbers": numbers})
}

/// The tolerance of an instant on the case clock (stock's resolution).
fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * (1. + a.abs().max(b.abs()))
}

/// Every declared C4 line judged (`zero` is the case's absolute t = 0;
/// divisions carry absolute times).
#[allow(clippy::too_many_lines)] // One judge per declared line.
pub fn judge(lines: &Value, run: &Run<'_>, zero: f64) -> Vec<Value> {
    let ev = run.events;
    let mut out = Vec::new();
    let Some(map) = lines.as_object() else {
        return vec![json!({"id": "C4", "verdict": "not executable", "reason": "no lines"})];
    };
    let f0 = run.frames.first();
    for (id, spec) in map {
        let v = match id.as_str() {
            "O1" => {
                let first_tx = ev
                    .relief
                    .iter()
                    .find(|(_, x)| x.get("stuck_open").is_none());
                let stop_t =
                    first_tx.and_then(|(t, x)| (x["stop"]["motion_after"] == "Open").then_some(*t));
                let reseat = ev.relief.iter().find(|(_, x)| {
                    x["after"]["demand_open"] == json!(false)
                        || x["after"]["motion"] == "Closing"
                        || x["after"]["motion"] == "Closed"
                });
                let command = ev
                    .relief
                    .iter()
                    .find(|(_, x)| x.get("stuck_open").is_some())
                    .map(|(t, _)| *t);
                let flow_from = stop_t.unwrap_or(f64::INFINITY);
                let dry: Vec<f64> = run
                    .frames
                    .iter()
                    .filter(|f| {
                        f.t > flow_from
                            && f.relief_kg_s.partial_cmp(&0.) != Some(std::cmp::Ordering::Greater)
                    })
                    .map(|f| f.t)
                    .collect();
                let min_flow = run
                    .frames
                    .iter()
                    .filter(|f| f.t > flow_from)
                    .map(|f| f.relief_kg_s)
                    .fold(f64::INFINITY, f64::min);
                let w = spec["window_s"]
                    .as_array()
                    .and_then(|a| a.get(1))
                    .and_then(Value::as_f64);
                let ok = command.is_some_and(|c| same(c, 0.))
                    && stop_t.is_some_and(|t| w.is_some_and(|w| t >= 0. && (t <= w || same(t, w))))
                    && reseat.is_none()
                    && dry.is_empty();
                line(
                    id,
                    spec,
                    if ok { "pass" } else { "fail" },
                    json!({"malfunction_s": command, "full_lift_s": stop_t, "declared_full_travel_s": run.full_travel_s,
                        "reseat_or_closing": reseat.map(|(t, x)| json!([t, x["after"]])),
                        "frames_without_relief_flow": dry.len(), "min_relief_flow_kg_s": min_flow}),
                )
            }
            "O2" => {
                let powered: Vec<usize> = run
                    .divisions
                    .iter()
                    .enumerate()
                    .filter(|(_, d)| d["powered"] == json!(true))
                    .map(|(i, _)| i)
                    .collect();
                let low: Vec<(usize, f64)> = causes(run.divisions, "LD01.PROT.PZR.LOW_PRESSURE")
                    .map(|(i, t)| (i, t - zero))
                    .collect();
                let first_trip = run
                    .divisions
                    .iter()
                    .filter_map(|d| d["trip"]["t_s"].as_f64())
                    .reduce(f64::min)
                    .map(|t| t - zero);
                let all_low = powered.iter().all(|i| low.iter().any(|(j, _)| j == i));
                let hold_ok =
                    matches!((run.holding_lost, first_trip), (Some(h), Some(t)) if same(h, t));
                // S2's G9 counts bodies: each cluster's first seat. A seated
                // body that lifts off and seats again (a later "seat" record
                // of the same cluster) is reported, not a second body.
                let mut first_seat: std::collections::BTreeMap<&str, f64> =
                    std::collections::BTreeMap::new();
                for (c, t) in &ev.seats {
                    first_seat.entry(c.as_str()).or_insert(*t);
                }
                let seated = first_seat.len();
                let reseats = ev.seats.len() - seated;
                let last_seat = first_seat
                    .values()
                    .copied()
                    .fold(f64::NEG_INFINITY, f64::max);
                let lowest = run
                    .pt
                    .iter()
                    .filter(|a| a.t <= run.end + 1e-9)
                    .filter_map(|a| voted(&a.channels, true))
                    .fold(f64::INFINITY, f64::min);
                let pt1_0 = run
                    .pt
                    .first()
                    .and_then(|a| a.channels.first().copied().flatten());
                let margin = pt1_0.map(|p| (run.low_pa - lowest) / (p - run.low_pa));
                let (consistent, a_prime) = consistency(
                    qualified_at(run.pt, run.low_pa, true, run.low_frames),
                    &low,
                    &powered,
                );
                let ok =
                    !low.is_empty() && all_low && hold_ok && seated == run.clusters && consistent;
                line(
                    id,
                    spec,
                    if ok { "pass" } else { "fail" },
                    json!({"low_pressure_causes": low, "powered_divisions": powered, "first_trip_s": first_trip,
                        "holding_lost_s": run.holding_lost, "seats": seated, "reseat_records": reseats, "clusters": run.clusters,
                        "last_seat_s": last_seat, "release_to_last_seat_s": run.holding_lost.map(|h| last_seat - h),
                        "consistency_iff": a_prime, "lowest_voted_pt_pa": lowest, "acquired_pt1_at_zero_pa": pt1_0,
                        "margin_basis": "the voted acquired PT (2-of-3 on the delivered PT1-3 samples at each decision)",
                        "marginFraction": margin}),
                )
            }
            "O3" => {
                let low: Vec<(usize, f64)> =
                    causes(run.divisions, "LD01.PROT.PZR.S_PRESSURE").collect();
                let mut missing = Vec::new();
                for (i, t) in &low {
                    let req = run.divisions[*i]["requests"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    for want in ["CMT injection", "PRHR"] {
                        let has = req.iter().any(|r| {
                            r["request"] == want
                                && r["by"] == "LD01.PROT.PZR.S_PRESSURE"
                                && r["t_s"].as_f64().is_some_and(|x| same(x, *t))
                        });
                        if !has {
                            missing.push(json!([i, want]));
                        }
                    }
                }
                let verdict = if low.is_empty() {
                    "not applicable"
                } else if missing.is_empty() {
                    "pass"
                } else {
                    "fail"
                };
                line(
                    id,
                    spec,
                    verdict,
                    json!({"divisions_with_cause": low.len(), "missing_requests": missing,
                    "flow": "none: S3 composes CMT and PRHR requests only (rule J); isolations declared failed closed"}),
                )
            }
            "O4" => {
                // O4′ (r2, S3-D57): the families' judge; its A″ margin here,
                // at the first classified birth (P-4).
                match run.o4 {
                    None => line(
                        id,
                        spec,
                        "not executable",
                        json!({"reason": "O4′ was not judged on this run"}),
                    ),
                    Some(v) => {
                        let mut numbers = v.clone();
                        if let Some(t) = v["t_s"].as_f64() {
                            let f = run
                                .frames
                                .iter()
                                .rev()
                                .find(|f| f.t <= t + 1e-9)
                                .or_else(|| run.frames.first());
                            let margin = match (f, f0) {
                                (Some(f), Some(f0)) => f
                                    .core_departure_k
                                    .iter()
                                    .zip(&f0.core_departure_k)
                                    .map(|(d, d0)| {
                                        (run.birth_threshold_k - d) / (run.birth_threshold_k - d0)
                                    })
                                    .fold(f64::INFINITY, f64::min),
                                _ => f64::NAN,
                            };
                            numbers["marginFraction"] = if margin.is_finite() {
                                json!(margin)
                            } else {
                                Value::Null
                            };
                            numbers["birth_threshold_k"] = json!(run.birth_threshold_k);
                            numbers["core_departure_k_at_frame"] =
                                json!(f.map(|f| (f.t, f.core_departure_k.clone())));
                        }
                        line(
                            id,
                            spec,
                            v["verdict"].as_str().unwrap_or("not executable"),
                            numbers,
                        )
                    }
                }
            }
            "N1" => {
                let classified: Vec<(f64, usize)> = ev
                    .births
                    .iter()
                    .filter(|(_, c, _, _)| matches!(run.classes.of(*c), Side::Hot | Side::Cold))
                    .map(|(t, c, _, _)| (*t, *c))
                    .collect();
                let bad = classified
                    .first()
                    .is_some_and(|(_, c)| run.classes.of(*c) == Side::Cold);
                line(
                    id,
                    spec,
                    if bad { "fail" } else { "pass" },
                    json!({"first_classified_birth":
                    classified.first().map(|(t, c)| json!([t, run.classes.name(*c), run.classes.of(*c).name()]))}),
                )
            }
            "N2" => {
                let hits: Vec<(usize, f64)> = causes(run.divisions, "LD01.PROT.PZR.HIGH_PRESSURE")
                    .map(|(i, t)| (i, t - zero))
                    .collect();
                let highest = run
                    .pt
                    .iter()
                    .filter(|a| a.t <= run.end + 1e-9)
                    .filter_map(|a| voted(&a.channels, false))
                    .fold(f64::NEG_INFINITY, f64::max);
                let pt1_0 = run
                    .pt
                    .first()
                    .and_then(|a| a.channels.first().copied().flatten());
                let margin = pt1_0.map(|p| (run.high_pa - highest) / (run.high_pa - p));
                let powered: Vec<usize> = run
                    .divisions
                    .iter()
                    .enumerate()
                    .filter(|(_, d)| d["powered"] == json!(true))
                    .map(|(i, _)| i)
                    .collect();
                let (consistent, a_prime) = consistency(
                    qualified_at(run.pt, run.high_pa, false, run.high_frames),
                    &hits,
                    &powered,
                );
                line(
                    id,
                    spec,
                    if hits.is_empty() && consistent {
                        "pass"
                    } else {
                        "fail"
                    },
                    json!({"causes": hits, "consistency_iff": a_prime, "highest_voted_pt_pa": highest,
                        "acquired_pt1_at_zero_pa": pt1_0, "marginFraction": margin,
                        "margin_basis": "the voted acquired PT (2-of-3 on the delivered PT1-3 samples at each decision)"}),
                )
            }
            "N3" => {
                let until = run.operator_trip.unwrap_or(run.end);
                let early: Vec<Value> = ev
                    .sg_relief
                    .iter()
                    .filter(|(t, _, th, d)| th == "Crack" && *d == 1 && *t < until)
                    .map(|(t, v, _, _)| json!([t, v]))
                    .collect();
                let before: Vec<&Frame> = run.frames.iter().filter(|f| f.t <= until).collect();
                let margin = f0.and_then(|f0| {
                    (0..f0.sg_pa.len())
                        .map(|k| {
                            let hi = before
                                .iter()
                                .map(|f| f.sg_pa[k])
                                .fold(f64::NEG_INFINITY, f64::max);
                            (run.sg_crack_pa - hi) / (run.sg_crack_pa - f0.sg_pa[k])
                        })
                        .reduce(f64::min)
                });
                line(
                    id,
                    spec,
                    if early.is_empty() { "pass" } else { "fail" },
                    json!({"operator_turbine_trip_s": run.operator_trip, "cracks_before": early, "marginFraction": margin,
                        "cracks": ev.sg_relief.iter().filter(|(_, _, th, d)| th == "Crack" && *d == 1).map(|(t, v, _, _)| json!([t, v])).collect::<Vec<_>>()}),
                )
            }
            "N4" => {
                // N4′ (r2, owner R7-Q, S3-D58): the families' judge; r1's
                // kernel relock list is reported beside it.
                let relocks = ev.chattering();
                match run.n4 {
                    None => line(
                        id,
                        spec,
                        "not executable",
                        json!({"reason": "N4′ was not judged on this run (pinned rule, restart entries and drive classes needed)",
                        "kernel_relocks_r1": relocks, "l1_changes": ev.l1.len()}),
                    ),
                    Some(v) => line(
                        id,
                        spec,
                        v["verdict"].as_str().unwrap_or("not executable"),
                        json!({"n4prime": v, "kernel_relocks_r1": relocks, "l1_changes": ev.l1.len()}),
                    ),
                }
            }
            _ => line(id, spec, "recorded", Value::Null),
        };
        out.push(v);
    }
    out
}

/// Pass only when every judged must and must-not line passes; a may line
/// and a diagnostic (N4′, R11-3a) never decide.
pub fn all_pass(judged: &[Value]) -> bool {
    judged
        .iter()
        .filter(|l| l["kind"] != "may" && l["kind"] != "diagnostic")
        .all(|l| l["verdict"] == "pass")
}

/// How a stopped run ends under the block's `ends`: a labelled end's name
/// for the kernel's named refusals, `None` for a failure.
pub fn labelled_end(failure: &str) -> Option<&'static str> {
    if failure.contains("the solid-PZR structural limit") {
        Some("solidPzr")
    } else if failure.contains("dryout") && failure.contains("mode G") {
        Some("dryout")
    } else if failure.contains("vapor") && failure.contains("receipt") {
        Some("subcooledVapour")
    } else {
        None
    }
}

/// Rule B's C4 record (S3-D65): what the signed rows read beside the
/// credited outputs, from the run's own record.
#[derive(Clone, Copy)]
pub struct DirectionRecord<'a> {
    /// C4's frame record: one row per 0.1 s frame instant (`t_s` on the
    /// case clock, `pzr_roof_pa`, `relief_kg_s`, `cells`).
    pub frames: &'a [Value],
    /// The frame driver's log (absolute `t_s`) with each restart's
    /// phase-mode receipts.
    pub log: &'a [Value],
    /// The network's cells by name (the log's cell indices).
    pub names: &'a [String],
    /// C4.O4′'s judged numbers (`t_s`, `cell`, `located`,
    /// `birth_threshold_k`), when O4′ was judged.
    pub o4: Option<&'a Value>,
    /// C4.O1's travel stop at full lift (case clock).
    pub full_lift_s: Option<f64>,
    /// Rule D's family as the harness writes it.
    pub conservation: &'a Value,
    /// `ld01-accuracy-contract`: the PT1 sample-noise budget (Pa) and the
    /// credited band (Hz); the observation interval (s) of the credited grid.
    pub pt1_noise_pa: f64,
    pub cutoff_hz: f64,
    pub observation_s: f64,
}

/// One rule-B row: pass/fail (`None`: not executable) and its numbers.
pub type Row = (Option<bool>, Value);

/// The instant tolerance of rule B's comparisons on the case clock.
const EPS_S: f64 = 1e-9;

/// t_b, "the primary saturates" (S3-D65): the first classified birth,
/// O4′'s instant, and its cell.
pub fn saturation(o4: Option<&Value>) -> Option<(f64, String)> {
    let o = o4?;
    Some((o["t_s"].as_f64()?, o["cell"].as_str()?.to_string()))
}

/// The last sample at or before `t`.
fn sample_at(s: &[(f64, f64)], t: f64) -> Option<(f64, f64)> {
    s.iter().rev().find(|(u, _)| *u <= t + EPS_S).copied()
}

/// The largest rise of a series above its running minimum before each
/// sample on (first, last]: (rise, t).
pub fn largest_rise(s: &[(f64, f64)]) -> Option<(f64, f64)> {
    let (first, rest) = s.split_first()?;
    if rest.is_empty() {
        return None;
    }
    let mut min = first.1;
    let mut worst = (f64::NEG_INFINITY, first.0);
    for &(t, x) in rest {
        if x - min > worst.0 {
            worst = (x - min, t);
        }
        min = min.min(x);
    }
    Some(worst)
}

/// "PZR pressure (PT1) falls monotonically" (S3-D65): on the 2 Hz
/// zero-phase filtered credited band over [0, end], no sample exceeds the
/// running minimum before it by more than the accuracy contract's PT1
/// sample-noise budget. The largest rise and its time are reported.
pub fn pt1_monotone(filtered: &[(f64, f64)], noise_pa: f64) -> Row {
    if filtered.iter().any(|p| !p.1.is_finite()) {
        return (None, json!({"reason": "a non-finite filtered PT1 sample"}));
    }
    match largest_rise(filtered) {
        None => (
            None,
            json!({"reason": "fewer than two filtered PT1 samples"}),
        ),
        Some((rise, t)) => (
            Some(rise <= noise_pa),
            json!({"largest_rise_above_running_min_pa": rise, "at_s": t, "tolerance_pa": noise_pa,
                "tolerance_source": "ld01-accuracy-contract pzrRoofPressureSampleNoise_Pa",
                "band": "2 Hz zero-phase filtered credited band (decision 0015 E1)",
                "samples": filtered.len(),
                "fall_pa": filtered.first().zip(filtered.last()).map(|(a, b)| a.1 - b.1)}),
        ),
    }
}

/// "PZR level falls after the trip, then rises once the primary
/// saturates" (S3-D65): min over [t_rt, t_b] < x(t_rt) and x(end) > x(t_b).
pub fn level_direction(level: &[(f64, f64)], t_rt: Option<f64>, t_b: Option<f64>, end: f64) -> Row {
    let Some(t_rt) = t_rt else {
        return (None, json!({"reason": "no reactor trip"}));
    };
    let Some(t_b) = t_b else {
        return (
            None,
            json!({"reason": "no classified birth: t_b is absent"}),
        );
    };
    if t_b <= t_rt {
        return (
            None,
            json!({"reason": "the first classified birth precedes the reactor trip: [t_rt, t_b] is empty", "t_rt_s": t_rt, "t_b_s": t_b}),
        );
    }
    let min = level
        .iter()
        .filter(|(t, _)| *t >= t_rt - EPS_S && *t <= t_b + EPS_S)
        .copied()
        .fold(None, |m: Option<(f64, f64)>, p| match m {
            Some(m) if m.1 <= p.1 => Some(m),
            _ => Some(p),
        });
    let (Some(x_rt), Some(x_b), Some(x_end), Some(min)) = (
        sample_at(level, t_rt),
        sample_at(level, t_b),
        sample_at(level, end),
        min,
    ) else {
        return (
            None,
            json!({"reason": "the level series has no sample at t_rt, t_b or the end"}),
        );
    };
    (
        Some(min.1 < x_rt.1 && x_end.1 > x_b.1),
        json!({"t_rt": x_rt, "min_over_trip_to_saturation": min, "t_b": x_b, "end": x_end,
            "fall_m": x_rt.1 - min.1, "rise_m": x_end.1 - x_b.1}),
    )
}

/// "falls after the trip" (S3-D65): x(end) < x(t_rt).
pub fn falls_after(s: &[(f64, f64)], t_rt: Option<f64>, end: f64) -> Row {
    let Some(t_rt) = t_rt else {
        return (None, json!({"reason": "no reactor trip"}));
    };
    match (sample_at(s, t_rt), sample_at(s, end)) {
        (Some(a), Some(b)) => (
            Some(b.1 < a.1),
            json!({"t_rt": a, "end": b, "change": b.1 - a.1}),
        ),
        _ => (None, json!({"reason": "no sample at the trip or the end"})),
    }
}

/// The frame record's rows up to `end`: (t, row).
fn frames_to(frames: &[Value], end: f64) -> Vec<(f64, &Value)> {
    frames
        .iter()
        .filter_map(|f| f["t_s"].as_f64().map(|t| (t, f)))
        .filter(|(t, _)| *t <= end + EPS_S)
        .collect()
}

/// "relief flow falls with pressure" (S3-D65): relief(end) < relief at
/// full lift (the travel stop, O1), on C4's frame record: the first frame
/// at or after the stop and the last frame of the declared part. The
/// frame-to-frame rises of the relief flow while PT1 falls at that frame
/// are reported only.
pub fn relief_falls(frames: &[Value], full_lift_s: Option<f64>, end: f64) -> Row {
    let Some(lift) = full_lift_s else {
        return (
            None,
            json!({"reason": "O1 found no travel stop at full lift"}),
        );
    };
    let rows: Vec<(f64, f64, f64)> = frames_to(frames, end)
        .into_iter()
        .filter(|(t, _)| *t >= lift - EPS_S)
        .filter_map(|(t, f)| Some((t, f["relief_kg_s"].as_f64()?, f["pzr_roof_pa"].as_f64()?)))
        .collect();
    if rows.len() < 2 {
        return (
            None,
            json!({"reason": "the frame record holds fewer than two frames from full lift to the end", "full_lift_s": lift}),
        );
    }
    let (a, b) = (rows[0], rows[rows.len() - 1]);
    let rises: Vec<(f64, f64)> = rows
        .windows(2)
        .filter(|w| w[1].1 > w[0].1 && w[1].2 < w[0].2)
        .map(|w| (w[1].0, w[1].1 - w[0].1))
        .collect();
    let largest = rises
        .iter()
        .copied()
        .fold(None, |m: Option<(f64, f64)>, r| match m {
            Some(m) if m.1 >= r.1 => Some(m),
            _ => Some(r),
        });
    (
        Some(b.1 < a.1),
        json!({"full_lift_s": lift, "at_full_lift": {"frame_s": a.0, "relief_kg_s": a.1},
            "at_end": {"frame_s": b.0, "relief_kg_s": b.1},
            "framewise_rise_while_pt1_falls (reported, S3-D65)": {"frames": rises.len(), "largest": largest.map(|r| json!({"at_s": r.0, "rise_kg_s": r.1}))}}),
    )
}

/// A cell's entry on one frame row: ("L", departure) or ("E", M_g).
fn cell_entry<'a>(row: &'a Value, cell: &str) -> Option<(&'a str, f64)> {
    row["cells"]
        .as_array()?
        .iter()
        .find(|c| c[0].as_str() == Some(cell))
        .and_then(|c| Some((c[1].as_str()?, c[2].as_f64()?)))
}

/// "birth cell's liquid departure from saturation rises to the birth
/// threshold (G1)" (S3-D65): for O4′'s cell on C4's frame record while it
/// is in mode L, the departure at the last frame before t_b exceeds its
/// value at the record's first frame (the first frame instant after
/// zero), and no frame before t_b exceeds the threshold
/// (`ld01-metastable-band.creditedMax_K`).
pub fn departure_rises(frames: &[Value], cell: &str, t_b: f64, threshold_k: f64) -> Row {
    let liquid: Vec<(f64, f64)> = frames
        .iter()
        .filter_map(|f| Some((f["t_s"].as_f64()?, f)))
        .filter(|(t, _)| *t < t_b - EPS_S)
        .filter_map(|(t, f)| match cell_entry(f, cell) {
            Some(("L", d)) => Some((t, d)),
            _ => None,
        })
        .collect();
    if liquid.len() < 2 {
        return (
            None,
            json!({"reason": format!("the frame record holds fewer than two liquid-mode departures of {cell} before t_b"), "t_b_s": t_b}),
        );
    }
    let (first, last) = (liquid[0], liquid[liquid.len() - 1]);
    let over: Vec<(f64, f64)> = liquid
        .iter()
        .copied()
        .filter(|(_, d)| !d.is_finite() || *d > threshold_k)
        .collect();
    let max =
        liquid.iter().copied().fold(
            (f64::NAN, f64::NEG_INFINITY),
            |m, p| if p.1 > m.1 { p } else { m },
        );
    (
        Some(last.1 > first.1 && over.is_empty()),
        json!({"cell": cell, "t_b_s": t_b, "first_frame": first, "last_frame_before_t_b": last,
            "max_before_t_b": max, "threshold_k": threshold_k, "frames_over_threshold": over,
            "liquid_frames": liquid.len(), "threshold_source": "ld01-metastable-band creditedMax_K"}),
    )
}

/// One cell's births (t, vapour slots) and exhaustions (t) from the log, on
/// the case clock.
fn cell_events(log: &[Value], zero: f64, cell: usize) -> (Vec<(f64, Value)>, Vec<f64>) {
    let (mut births, mut exhaustions) = (Vec::new(), Vec::new());
    for instant in log {
        let t = instant["t_s"].as_f64().unwrap_or(f64::NAN) - zero;
        for x in instant["restart"]["transactions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x["owner"] == "phase modes")
        {
            let at = x["t_s"].as_f64().map_or(t, |a| a - zero);
            for ev in x["events"].as_array().into_iter().flatten() {
                if ev["birth"].as_u64() == Some(cell as u64) {
                    births.push((at, ev["vapor_slots"].clone()));
                }
                if ev["exhaustion"].as_u64() == Some(cell as u64) {
                    exhaustions.push(at);
                }
            }
        }
    }
    (births, exhaustions)
}

/// "birth cell's vapour mass: 0, then positive and continuous" (S3-D65),
/// on C4's frame record for O4′'s cell, each mode-E interval (birth to its
/// exhaustion or the end; re-births included) judged separately: the
/// phase-mode owner's birth receipt carries vapour slots exactly 0; M_g > 0
/// at every frame inside an interval; and the cell is in mode E on the
/// record only inside its logged intervals, so M_g changes discontinuously
/// only at a logged instant of that cell. The largest frame-to-frame M_g
/// change per interval is reported (no declared jump tolerance on the
/// 0.1 s record).
pub fn vapour_mass(
    frames: &[Value],
    log: &[Value],
    zero: f64,
    names: &[String],
    cell: &str,
    end: f64,
) -> Row {
    let Some(index) = names.iter().position(|n| n == cell) else {
        return (
            None,
            json!({"reason": format!("no network cell named {cell}")}),
        );
    };
    let (births, exhaustions) = cell_events(log, zero, index);
    if births.is_empty() {
        return (
            None,
            json!({"reason": format!("the log records no birth of {cell}")}),
        );
    }
    let zero_slots = |s: &Value| {
        s.as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|x| x.as_f64() == Some(0.)))
    };
    let unpaid: Vec<Value> = births
        .iter()
        .filter(|(_, s)| !zero_slots(s))
        .map(|(t, s)| json!([t, s]))
        .collect();
    // Each birth's interval runs to that cell's next exhaustion (none: to
    // the end of the declared part).
    let intervals: Vec<(f64, Option<f64>)> = births
        .iter()
        .map(|(b, _)| {
            let e = exhaustions
                .iter()
                .copied()
                .filter(|x| *x >= *b)
                .fold(f64::INFINITY, f64::min);
            (*b, e.is_finite().then_some(e))
        })
        .collect();
    let logged = |t: f64, x: f64| (t - x).abs() <= EPS_S;
    let rows = frames_to(frames, end);
    let mut violations = Vec::new();
    let mut per: Vec<Vec<(f64, f64)>> = vec![Vec::new(); intervals.len()];
    for (t, row) in &rows {
        // A frame at one of the cell's logged instants is on both sides.
        if intervals
            .iter()
            .any(|(b, e)| logged(*t, *b) || e.is_some_and(|e| logged(*t, e)))
        {
            continue;
        }
        let inside = intervals
            .iter()
            .position(|(b, e)| *t > *b && e.is_none_or(|e| *t < e));
        match (inside, cell_entry(row, cell)) {
            (Some(k), Some(("E", mg))) if mg > 0. => per[k].push((*t, mg)),
            (Some(_), entry) => violations.push(json!({"t_s": t, "entry": entry.map(|e| json!(e)), "reason": "inside a mode-E interval without positive M_g"})),
            (None, Some(("E", mg))) => violations.push(json!({"t_s": t, "m_g_kg": mg, "reason": "mode E outside the cell's logged intervals"})),
            (None, _) => {}
        }
    }
    let reports: Vec<Value> = intervals
        .iter()
        .zip(&per)
        .map(|((b, e), s)| {
            let step = s
                .windows(2)
                .map(|w| (w[1].0, (w[1].1 - w[0].1).abs()))
                .fold(None, |m: Option<(f64, f64)>, r| match m {
                    Some(m) if m.1 >= r.1 => Some(m),
                    _ => Some(r),
                });
            json!({"birth_s": b, "exhaustion_s": e, "frames": s.len(), "first": s.first(),
                "min_m_g_kg": s.iter().map(|p| p.1).fold(f64::INFINITY, f64::min),
                "largest_framewise_change (reported)": step.map(|r| json!({"at_s": r.0, "kg": r.1}))})
        })
        .collect();
    (
        Some(unpaid.is_empty() && violations.is_empty()),
        json!({"cell": cell, "births": births.len(), "exhaustions": exhaustions,
            "birth_slots_not_zero": unpaid, "violations": violations, "intervals": reports}),
    )
}

/// "primary mass falls by exactly the integrated relief flow" (S3-D65),
/// "exactly" read as rule D's bound on D's own record: the primary mass
/// closure (inventory change against the network's receipts) within
/// `ledger.boundLocalToleranceUnits` at every output, the inventory change
/// at D's last closure negative, and that change against the integrated
/// relief flow (the ledger `pzr_relief_attribution_kg`) within the same
/// bound in the inventory's tolerance units.
pub fn primary_mass(d: &Value) -> Row {
    if d["verdict"] == "not executable" {
        return (None, json!({"reason": d["reason"]}));
    }
    if !d["error"].is_null() {
        return (
            Some(false),
            json!({"reason": "rule D's ledgers stopped", "error": d["error"]}),
        );
    }
    let ledger = &d["ledger"];
    let worst = &ledger["closures"]["primary_mass_kg"];
    let last = ledger["final"]["closures"]
        .as_array()
        .and_then(|c| c.iter().find(|x| x["name"] == "primary_mass_kg"));
    let receipts = &d["receipts_at_last_closure"];
    let (Some(bound), Some(worst_units), Some(last), Some(attribution), Some(t), Some(tr)) = (
        ledger["bound_local_tolerance_units"].as_f64(),
        worst["max_units"].as_f64(),
        last,
        receipts["values"]["primary_mass_kg"].as_f64(),
        ledger["final"]["t_s"].as_f64(),
        receipts["t_s"].as_f64(),
    ) else {
        return (
            None,
            json!({"reason": "rule D's record holds no primary mass closure or relief attribution"}),
        );
    };
    let (Some(change), Some(tolerance)) = (
        last["inventory_change"].as_f64(),
        last["tolerance"].as_f64(),
    ) else {
        return (
            None,
            json!({"reason": "rule D's last primary mass closure has no inventory change"}),
        );
    };
    if (t - tr).abs() > EPS_S * (1. + t.abs()) {
        return (
            None,
            json!({"reason": "rule D's last closure and its receipts are at different instants", "closure_t_s": t, "receipts_t_s": tr}),
        );
    }
    let relief_units = (change - attribution).abs() / tolerance;
    (
        Some(worst_units <= bound && change < 0. && relief_units <= bound),
        json!({"bound_units": bound, "bound_source": "ld01-s2-gates ledger.boundLocalToleranceUnits",
            "closure_max_units": worst_units, "closure_at_t_s": worst["at_t_s"],
            "last_closure_t_s": t, "inventory_change_kg": change,
            "integrated_relief_less_cvcs_net_kg": attribution,
            "integrated_relief_kg": receipts["values"]["pzr_relief_attribution_kg"],
            "against_relief_less_cvcs_net_units": relief_units, "tolerance_kg": tolerance,
            "span": "rule D's ledgers from the run's start (q0 = 0) to its last closure"}),
    )
}

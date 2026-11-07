//! spec: world/packs/process-plant/reference-designs/ld-01/model/numerics-and-realization.md#what-must-survive-copy-pause-and-restore
//! NOT-EVIDENCE gate of the `ld01-unit` host (lane WORLD, plan r4, shell
//! design §1): it checks the host's protocol and its bitwise copy, not the
//! plant. Ignored; run explicitly with the STAGE tuple in the environment
//! (`LD01_OPERATING_HOT_SPINE_PACKET`, `LD01_WIKI_ROOT`, `LD01_WIKI_COMMIT`,
//! `LD01_WIKI_REPOSITORY`,
//! `LD01_IC_SECTION`, `LD01_PZR_CONTROL_SECTION`, `LD01_PZR_CONTROL_WIKI`,
//! `ELEC_PACKET`, `LD01_S3_STATE`), `LD01_UNIT_HOST_RECEIPTS`, a directory
//! for the receipts, and `LD01_UNIT_HOST_COPY_EXCHANGE`.
//!
//! - **Copy.** Process A loads the saved S3 state, commands the acquired
//!   turbine trip at `t0 + 1 s`, advances in 0.1 s exchanges, snapshots at
//!   `t_c` (`LD01_UNIT_HOST_COPY_EXCHANGE` exchanges after t0; the plan's
//!   gate: 30, `t0 + 3 s`; the copy point is a restart in place) and
//!   continues to `t_c + 30 s`, or `LD01_UNIT_HOST_SPAN` exchanges past it.
//!   A refusal of the source after the copy point
//!   ends both runs there; the copy must refuse identically, and the gate
//!   still fails. Process B restores the snapshot and makes the same
//!   exchanges. Every exchange's reply payload (time, counts, the
//!   observation frame and its events) and the final snapshots are
//!   byte-equal.
//! - **Named end (R4-ENDED).** `a_named_end_holds_its_state_and_refuses_by_name`
//!   drives the stuck-open relief to the unit's named end: the exchange
//!   replies with `ended`, ADVANCE and COMMAND then refuse by name, SNAPSHOT
//!   and STATUS work, and a restored unit reaches the same end.
//! - **Conformance.** An unknown op, a command in the past, an unknown
//!   command kind and an ADVANCE behind the unit refuse; a restore whose
//!   identity differs (kernel sources, the start state) refuses; CLOSE
//!   exits 0.
#![cfg(feature = "quadratures")]

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

const LOAD: u8 = 1;
const CHANNELS: u8 = 2;
const ADVANCE: u8 = 3;
const COMMAND: u8 = 4;
const SNAPSHOT: u8 = 5;
const RESTORE: u8 = 6;
const STATUS: u8 = 7;
const CLOSE: u8 = 8;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

struct Host {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    seq: u32,
}

struct Reply {
    status: u8,
    cpu_s: f64,
    payload: Vec<u8>,
}

impl Host {
    fn spawn(stderr: &std::path::Path) -> Self {
        let log = std::fs::File::create(stderr).expect("stderr log");
        let mut child = Command::new(env!("CARGO_BIN_EXE_ld01-unit"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()
            .expect("spawn ld01-unit");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        Self {
            child,
            stdin,
            stdout,
            seq: 0,
        }
    }
    fn request(&mut self, op: u8, payload: &[u8]) -> Reply {
        self.seq += 1;
        let length = u32::try_from(5 + payload.len()).expect("frame length");
        let mut frame = length.to_le_bytes().to_vec();
        frame.push(op);
        frame.extend_from_slice(&self.seq.to_le_bytes());
        frame.extend_from_slice(payload);
        self.stdin.write_all(&frame).expect("write request");
        self.stdin.flush().expect("flush request");
        let mut header = [0u8; 4];
        self.stdout.read_exact(&mut header).expect("reply length");
        let mut body = vec![0u8; u32::from_le_bytes(header) as usize];
        self.stdout.read_exact(&mut body).expect("reply body");
        assert!(body.len() >= 21, "reply shorter than its header");
        let seq = u32::from_le_bytes(body[1..5].try_into().unwrap());
        assert_eq!(seq, self.seq, "reply sequence");
        Reply {
            status: body[0],
            cpu_s: f64::from_le_bytes(body[13..21].try_into().unwrap()),
            payload: body[21..].to_vec(),
        }
    }
    fn ok(&mut self, op: u8, payload: &[u8]) -> Reply {
        let r = self.request(op, payload);
        assert_eq!(
            r.status,
            0,
            "op {op} refused: {}",
            String::from_utf8_lossy(&r.payload)
        );
        r
    }
    fn json(&mut self, op: u8, payload: &[u8]) -> Value {
        serde_json::from_slice(&self.ok(op, payload).payload).expect("reply JSON")
    }
    fn refused(&mut self, op: u8, payload: &[u8]) -> String {
        let r = self.request(op, payload);
        assert_eq!(r.status, 1, "op {op} was not refused");
        String::from_utf8(r.payload).expect("UTF-8 cause")
    }
    fn close(mut self) {
        self.ok(CLOSE, &[]);
        let status = self.child.wait().expect("wait");
        assert!(status.success(), "CLOSE exits 0: {status}");
    }
}

/// One ADVANCE reply: time, counts, values, events.
struct Frame {
    t: f64,
    counts: Vec<u64>,
    values: Vec<f64>,
    events: Value,
}
fn frame(payload: &[u8]) -> Frame {
    let mut at = 0;
    let mut take = |n: usize| {
        let s = &payload[at..at + n];
        at += n;
        s
    };
    let f = |s: &[u8]| f64::from_le_bytes(s.try_into().unwrap());
    let u32_ = |s: &[u8]| u32::from_le_bytes(s.try_into().unwrap()) as usize;
    let t = f(take(8));
    let _solver_t = f(take(8));
    let c = u32_(take(4));
    let counts = (0..c)
        .map(|_| u64::from_le_bytes(take(8).try_into().unwrap()))
        .collect();
    let v = u32_(take(4));
    let values = (0..v).map(|_| f(take(8))).collect();
    let m = u32_(take(4));
    let events = match m {
        0 => Value::Null,
        m => serde_json::from_slice(take(m)).expect("events JSON"),
    };
    Frame {
        t,
        counts,
        values,
        events,
    }
}

/// Wall time of each ADVANCE as a host sees it: request to reply, `(t1, s)`.
#[derive(Default)]
struct AdvanceWalls(Vec<(f64, f64)>);

impl AdvanceWalls {
    /// One ADVANCE, timed.
    fn timed(&mut self, host: &mut Host, t1: f64) -> Reply {
        let started = Instant::now();
        let reply = host.request(ADVANCE, &t1.to_le_bytes());
        self.0.push((t1, started.elapsed().as_secs_f64()));
        reply
    }
    /// The worst ADVANCE and the worst run of `per_second` consecutive ones,
    /// the wall of one 1 s exchange, with the series.
    fn receipt(&self, per_second: usize) -> Value {
        let longer = |w: (f64, f64), a: (f64, f64)| if a.1 > w.1 { a } else { w };
        let worst = self.0.iter().copied().fold((0., 0.), longer);
        let window = self
            .0
            .windows(per_second.max(1))
            .map(|w| (w[w.len() - 1].0, w.iter().map(|a| a.1).sum::<f64>()))
            .fold((0., 0.), longer);
        json!({"count": self.0.len(), "worst_s": worst.1, "worst_t1": worst.0,
            "worst_1s_exchange_s": window.1, "worst_1s_exchange_ending_t1": window.0, "series": self.0})
    }
}

fn advance(host: &mut Host, walls: &mut AdvanceWalls, t1: f64) -> (Vec<u8>, f64) {
    let r = walls.timed(host, t1);
    assert_eq!(
        r.status,
        0,
        "ADVANCE to {t1} s refused: {}",
        String::from_utf8_lossy(&r.payload)
    );
    (r.payload, r.cpu_s)
}

fn bits_of(v: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().expect("bits"), 16).expect("hex"))
}

#[test]
#[ignore = "NOT-EVIDENCE gate: two ld01-unit processes, a 33 s trip (minutes)"]
fn a_restored_copy_continues_bitwise_and_the_protocol_refuses_explicitly() {
    let receipts = std::path::PathBuf::from(env("LD01_UNIT_HOST_RECEIPTS"));
    // The copy point in 0.1 s exchanges after t0 (the plan's gate: 30, i.e.
    // t0 + 3 s); the copy runs 300 exchanges (30 s) past it.
    let copy_at: u64 = env("LD01_UNIT_HOST_COPY_EXCHANGE")
        .parse()
        .expect("LD01_UNIT_HOST_COPY_EXCHANGE: a whole number of exchanges after t0");
    // LD01_UNIT_HOST_SPAN: exchanges past the copy point, for a case the unit
    // ends sooner.
    let end = copy_at
        + std::env::var("LD01_UNIT_HOST_SPAN").map_or(300, |v| {
            v.parse()
                .expect("LD01_UNIT_HOST_SPAN: a whole number of exchanges")
        });
    std::fs::create_dir_all(&receipts).expect("receipt directory");
    // R4-FREE-STEPS: the LOAD request's stepping (free, the unit's default,
    // unless LD01_UNIT_HOST_STEPPING names frame-stops for the control run).
    let stepping =
        std::env::var("LD01_UNIT_HOST_STEPPING").unwrap_or_else(|_| "free".into());
    let free = stepping == "free";
    // The water method (owner decision 1 Nov): SBTL, the default since the
    // combined re-pin's gates passed (lead 1 Nov), unless
    // LD01_UNIT_HOST_WATER names the IF97 reference.
    let water = std::env::var("LD01_UNIT_HOST_WATER").unwrap_or_else(|_| "sbtl".into());
    let other_water = if water == "sbtl" { "if97" } else { "sbtl" };
    let load = json!({
        "inputs": {
            "packet": env("LD01_OPERATING_HOT_SPINE_PACKET"),
            "wiki_root": env("LD01_WIKI_ROOT"),
            "wiki_commit": env("LD01_WIKI_COMMIT"),
            "wiki_repository": env("LD01_WIKI_REPOSITORY"),
            "ic": env("LD01_IC_SECTION"),
            "pzr_control": env("LD01_PZR_CONTROL_SECTION"),
            "pzr_control_wiki": env("LD01_PZR_CONTROL_WIKI"),
            "elec": env("ELEC_PACKET"),
        },
        "state": env("LD01_S3_STATE"),
        "solver": {"weights": "stock", "first_step": "declared", "stepping": stepping, "water": water,
            // R4-NUC-SOURCE-ATOL: LD01_S3_SOURCE_ATOL (unset: derived), a required LOAD key.
            "source_atol": std::env::var("LD01_S3_SOURCE_ATOL").unwrap_or_else(|_| "derived".into())},
    });
    let started = Instant::now();
    let mut refusals = serde_json::Map::new();

    // A: load, conformance, trip, copy point, continue.
    let mut a = Host::spawn(&receipts.join("a.stderr.log"));
    refusals.insert("unknown op".into(), json!(a.refused(99, &[])));
    refusals.insert(
        "ADVANCE before LOAD".into(),
        json!(a.refused(ADVANCE, &1f64.to_le_bytes())),
    );
    let loaded = a.json(LOAD, &serde_json::to_vec(&load).unwrap());
    let t0 = bits_of(&loaded["t_bits"]);
    let period = loaded["frame_s"].as_f64().expect("frame_s");
    let exchanges_per_second = (1. / period).round() as usize;
    let k0 = (t0 / period).round() as u64;
    let instant = |k: u64| (k0 + k) as f64 * period;
    let channels = a.json(CHANNELS, &[]);
    let ids: Vec<String> = channels
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(channels, loaded["channels"]);
    refusals.insert("second LOAD".into(), json!(a.refused(LOAD, &[])));
    let past = json!({"kind": "TurbineTripAcquired", "t_apply": t0 - 1.});
    let cause = a.refused(COMMAND, &serde_json::to_vec(&past).unwrap());
    assert!(cause.contains("not prospective"), "{cause}");
    refusals.insert("command in the past".into(), json!(cause));
    let bogus = json!({"kind": "Bogus", "t_apply": t0 + 1.});
    refusals.insert(
        "unknown command".into(),
        json!(a.refused(COMMAND, &serde_json::to_vec(&bogus).unwrap())),
    );
    let mode = json!({"kind": "PzrControlMode", "t_apply": t0 + 1.});
    refusals.insert(
        "PZR control mode".into(),
        json!(a.refused(COMMAND, &serde_json::to_vec(&mode).unwrap())),
    );
    // PROC T4, T5, T11: a name the unit does not hold, a wrong key and a time
    // that is not the unit's are refused, change nothing and stop nothing.
    for (name, command, expected) in [
        (
            "no such bus",
            json!({"kind": "IncomingDevice", "t_apply": t0, "bus": "AC.X", "source": "unit", "target": "Open"}),
            "no bus AC.X",
        ),
        (
            "no such consumer",
            json!({"kind": "StartConsumer", "t_apply": t0, "consumer": "LD01.P.X"}),
            "no consumer LD01.P.X",
        ),
        (
            "no such DC group",
            json!({"kind": "DcDistribution", "t_apply": t0, "group": "LD01.DC.X", "action": "Open"}),
            "no DC group",
        ),
        (
            "an unknown action",
            json!({"kind": "DcDistribution", "t_apply": t0, "group": "LD01.DC.I1", "action": "Trip"}),
            "Open, Reset or Close",
        ),
        (
            "an extra key",
            json!({"kind": "StartConsumer", "t_apply": t0, "consumer": "LD01.P.A1", "rotor": 0}),
            "has keys",
        ),
        (
            "not the unit's time",
            json!({"kind": "StartConsumer", "t_apply": t0 + 1., "consumer": "LD01.P.A1"}),
            "decided at the unit's time",
        ),
    ] {
        let cause = a.refused(COMMAND, &serde_json::to_vec(&command).unwrap());
        assert!(cause.contains(expected), "{name}: {cause}");
        refusals.insert(format!("operator command: {name}"), json!(cause));
    }
    refusals.insert(
        "ADVANCE behind the unit".into(),
        json!(a.refused(ADVANCE, &t0.to_le_bytes())),
    );
    // R4-DUMP (WORLD4's review 2): LD01_UNIT_HOST_COMMAND=<kind>@<exchange>
    // names the trip before the copy point, TurbineTripAcquired or
    // ManualReactorTrip, or the relief malfunction ReliefStuckOpen; unset,
    // the acquired turbine trip at exchange 10. Any other form refuses.
    let (trip_kind, trip_at) = match std::env::var("LD01_UNIT_HOST_COMMAND") {
        Err(_) => ("TurbineTripAcquired".to_string(), 10_u64),
        Ok(v) => {
            let (kind, at) = v
                .split_once('@')
                .unwrap_or_else(|| panic!("LD01_UNIT_HOST_COMMAND={v}: <kind>@<exchange>"));
            assert!(
                ["TurbineTripAcquired", "ManualReactorTrip", "ReliefStuckOpen"].contains(&kind),
                "LD01_UNIT_HOST_COMMAND={v}: TurbineTripAcquired, ManualReactorTrip or ReliefStuckOpen"
            );
            let at: u64 = at
                .parse()
                .unwrap_or_else(|_| panic!("LD01_UNIT_HOST_COMMAND={v}: a whole exchange"));
            assert!(
                at >= 1 && at < copy_at,
                "LD01_UNIT_HOST_COMMAND={v}: the trip lies before the copy point"
            );
            (kind.to_string(), at)
        }
    };
    let trip = json!({"kind": trip_kind, "t_apply": instant(trip_at)});
    let applied = a.json(COMMAND, &serde_json::to_vec(&trip).unwrap());
    // ECA0: LD01_UNIT_HOST_OPERATOR, a JSON array of [exchange, command,
    // accepted]: operator commands applied at the unit's time after that
    // exchange, before the copy point, so the copy carries what they left.
    let operator: Vec<(u64, Value, bool)> =
        std::env::var("LD01_UNIT_HOST_OPERATOR").map_or(Vec::new(), |v| {
            serde_json::from_str(&v)
                .expect("LD01_UNIT_HOST_OPERATOR: [[exchange, command, accepted], ...]")
        });
    assert!(
        operator.iter().all(|(at, ..)| *at >= 1 && *at < copy_at),
        "LD01_UNIT_HOST_OPERATOR: every command lies before the copy point"
    );
    let mut operated = Vec::new();
    let mut trace = Vec::new();
    let mut a_cpu = 0.;
    let (mut a_walls, mut b_walls) = (AdvanceWalls::default(), AdvanceWalls::default());
    for k in 1..=copy_at {
        let (p, cpu) = advance(&mut a, &mut a_walls, instant(k));
        a_cpu += cpu;
        let f = frame(&p);
        for (_, command, accepted) in operator.iter().filter(|(at, ..)| *at == k) {
            let mut command = command.clone();
            command["t_apply"] = json!(f.t);
            let reply = a.json(COMMAND, &serde_json::to_vec(&command).unwrap());
            assert_eq!(reply["accepted"], json!(accepted), "{command}: {reply}");
            operated.push(json!({"exchange": k, "command": command, "reply": reply}));
        }
        if k % 10 == 0 || !f.events.is_null() {
            trace.push(json!({"t": f.t, "values": ids.iter().zip(&f.values)
                .filter(|(id, _)| ["LD01.CORE.RELEASED_POWER", "LD01.PZR.PRESSURE", "LD01.SG.A.PRESSURE", "LD01.TRIP.HOLD.AVAILABLE", "LD01.TG.GEN.WT"].contains(&id.as_str()))
                .map(|(id, v)| (id.clone(), json!(v))).collect::<serde_json::Map<_, _>>(),
                "counts": f.counts, "events": f.events}));
        }
    }
    // R4-FREE-STEPS: under free stepping the copy point lies inside the
    // integrator's last step (the snapshot is its dense output there).
    let before_copy = a.json(STATUS, &[]);
    let copy_t = bits_of(&before_copy["t_bits"]);
    let copy_integrator = bits_of(&before_copy["integrator_t_bits"]);
    let copy = a.ok(SNAPSHOT, &[]);
    let copy_cpu = copy.cpu_s;
    let copy = copy.payload;
    std::fs::write(receipts.join("snapshot-tc.json"), &copy).unwrap();
    // A refusal after the copy point (the source's own failure) ends both
    // runs at that exchange: the copy must refuse there identically.
    let mut a_frames = Vec::new();
    let mut a_failed: Option<(u64, String)> = None;
    for k in copy_at + 1..=end {
        let r = a_walls.timed(&mut a, instant(k));
        a_cpu += r.cpu_s;
        if r.status != 0 {
            a_failed = Some((k, String::from_utf8_lossy(&r.payload).into_owned()));
            break;
        }
        a_frames.push(r.payload);
    }
    let a_status = a.json(STATUS, &[]);
    let a_final = match a_failed {
        None => a.ok(SNAPSHOT, &[]).payload,
        Some(_) => Vec::new(),
    };
    a.close();

    // B: a fresh process restored from the copy point.
    let mut b = Host::spawn(&receipts.join("b.stderr.log"));
    let restore = b.ok(RESTORE, &copy);
    let restore_cpu = restore.cpu_s;
    let restored: Value = serde_json::from_slice(&restore.payload).unwrap();
    assert_eq!(
        bits_of(&restored["t_bits"]).to_bits(),
        instant(copy_at).to_bits(),
        "B stands at the copy point"
    );
    assert_eq!(restored["channels"], channels);
    let mut b_frames = Vec::new();
    let mut b_cpu = 0.;
    let mut b_failed: Option<(u64, String)> = None;
    let last = a_failed.as_ref().map_or(end, |f| f.0);
    for k in copy_at + 1..=last {
        let r = b_walls.timed(&mut b, instant(k));
        b_cpu += r.cpu_s;
        if r.status != 0 {
            b_failed = Some((k, String::from_utf8_lossy(&r.payload).into_owned()));
            break;
        }
        b_frames.push(r.payload);
    }
    let b_final = match b_failed {
        None => b.ok(SNAPSHOT, &[]).payload,
        Some(_) => Vec::new(),
    };
    b.close();

    // C: restores whose identity differs refuse.
    let mut c = Host::spawn(&receipts.join("c.stderr.log"));
    let mut tampered: Value = serde_json::from_slice(&copy).unwrap();
    tampered["identity"]["kernel_source_sha256"] = json!("0".repeat(64));
    let cause = c.refused(RESTORE, &serde_json::to_vec(&tampered).unwrap());
    assert!(cause.contains("kernel_source_sha256"), "{cause}");
    refusals.insert("restore, another kernel".into(), json!(cause));
    let mut tampered: Value = serde_json::from_slice(&copy).unwrap();
    tampered["identity"]["state"]["sha256"] = json!("0".repeat(64));
    let cause = c.refused(RESTORE, &serde_json::to_vec(&tampered).unwrap());
    assert!(cause.contains("identity state differs"), "{cause}");
    refusals.insert("restore, another start state".into(), json!(cause));
    // A snapshot of one water method never restores as the other.
    let mut tampered: Value = serde_json::from_slice(&copy).unwrap();
    tampered["load"]["solver"]["water"] = json!(other_water);
    let cause = c.refused(RESTORE, &serde_json::to_vec(&tampered).unwrap());
    assert!(cause.contains("identity solver differs"), "{cause}");
    refusals.insert("restore, another water method".into(), json!(cause));
    c.close();

    // The comparison: every exchange payload, then the final snapshots.
    let first_difference = a_frames
        .iter()
        .zip(&b_frames)
        .enumerate()
        .find(|(_, (x, y))| x != y)
        .map(|(i, (x, y))| {
            let (fa, fb) = (frame(x), frame(y));
            let channel = fa
                .values
                .iter()
                .zip(&fb.values)
                .position(|(u, v)| u.to_bits() != v.to_bits())
                .map(|j| json!({"channel": ids[j], "a": fa.values[j], "b": fb.values[j]}));
            json!({"exchange": copy_at + 1 + i as u64, "t": fa.t, "first_channel": channel,
                "counts": [fa.counts, fb.counts], "events_equal": fa.events == fb.events})
        });
    let snapshots_equal = a_final == b_final;
    let sha = |b: &[u8]| leitbild_operating_plant::digest::sha256(b);
    let receipt = json!({
        "gate": "ld01-unit bitwise copy and protocol conformance (NOT-EVIDENCE)",
        "t0": t0, "copy_exchange": copy_at, "copy_point": instant(copy_at), "end": instant(end), "trip": applied, "trip_command": {"kind": trip_kind, "exchange": trip_at},
        "a_failed": a_failed.as_ref().map(|(k, c)| json!({"exchange": k, "t1": instant(*k), "cause": c})),
        "b_failed": b_failed.as_ref().map(|(k, c)| json!({"exchange": k, "t1": instant(*k), "cause": c})),
        "failures_identical": a_failed == b_failed,
        "stepping": if free { "free" } else { "frame-stops" },
        "water": water,
        "copy_integrator_s": copy_integrator, "copy_mid_step": copy_integrator > copy_t,
        "exchanges_compared": a_frames.len(), "frames_equal": first_difference.is_none(),
        "first_difference": first_difference,
        "final_snapshots_equal": snapshots_equal,
        "snapshot_sha256": {"copy_point": sha(&copy), "a_final": sha(&a_final), "b_final": sha(&b_final)},
        "snapshot_bytes": copy.len(),
        "channels": ids.len(),
        "cpu_s": {"a_advance": a_cpu, "a_copy_point": copy_cpu, "b_restore": restore_cpu, "b_advance": b_cpu},
        "wall_s": started.elapsed().as_secs_f64(),
        "advance_wall_s": {"a": a_walls.receipt(exchanges_per_second), "b": b_walls.receipt(exchanges_per_second)},
        "a_status": a_status, "refusals": refusals, "operated": operated, "trace_to_copy_point": trace,
        "load": load,
    });
    std::fs::write(
        receipts.join("unit-host-gate.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    std::fs::write(receipts.join("snapshot-a-final.json"), &a_final).unwrap();
    std::fs::write(receipts.join("snapshot-b-final.json"), &b_final).unwrap();
    if free {
        assert!(
            copy_integrator > copy_t,
            "the copy point {copy_t} s is not inside a free step (integrator at {copy_integrator} s)"
        );
    }
    assert_eq!(a_failed, b_failed, "the copy does not refuse as its source");
    assert_eq!(a_frames.len(), b_frames.len(), "exchange counts");
    assert!(
        first_difference.is_none(),
        "frames differ: {}",
        receipt["first_difference"]
    );
    assert!(snapshots_equal, "the final snapshots differ");
    assert!(
        a_failed.is_none(),
        "the source itself refused after the copy point (the copy refused identically): {:?}",
        a_failed
    );
}

/// The LOAD request with the unit's defaults (free stepping, SBTL unless
/// `LD01_UNIT_HOST_WATER` names IF97).
fn default_load() -> Value {
    let water = std::env::var("LD01_UNIT_HOST_WATER").unwrap_or_else(|_| "sbtl".into());
    json!({
        "inputs": {
            "packet": env("LD01_OPERATING_HOT_SPINE_PACKET"),
            "wiki_root": env("LD01_WIKI_ROOT"),
            "wiki_commit": env("LD01_WIKI_COMMIT"),
            "wiki_repository": env("LD01_WIKI_REPOSITORY"),
            "ic": env("LD01_IC_SECTION"),
            "pzr_control": env("LD01_PZR_CONTROL_SECTION"),
            "pzr_control_wiki": env("LD01_PZR_CONTROL_WIKI"),
            "elec": env("ELEC_PACKET"),
        },
        "state": env("LD01_S3_STATE"),
        "solver": {"weights": "stock", "first_step": "declared", "stepping": "free", "water": water,
            "source_atol": std::env::var("LD01_S3_SOURCE_ATOL").unwrap_or_else(|_| "derived".into())},
    })
}

/// Advance from exchange `from` until an exchange names an end: its frame.
fn to_the_end(host: &mut Host, instant: impl Fn(u64) -> f64, from: u64, last: u64) -> Frame {
    for k in from..=last {
        let (payload, _) = advance(host, instant(k));
        let f = frame(&payload);
        if !f.events["ended"].is_null() {
            return f;
        }
    }
    panic!("no named end by exchange {last}");
}

#[test]
#[ignore = "NOT-EVIDENCE gate: two ld01-unit processes to the stuck-open relief's end (minutes)"]
fn a_named_end_holds_its_state_and_refuses_by_name() {
    let receipts = std::path::PathBuf::from(env("LD01_UNIT_HOST_RECEIPTS"));
    std::fs::create_dir_all(&receipts).expect("receipt directory");
    // C4 ends at +49.8 s; the span bounds a run that does not.
    let last = 700;
    let load = serde_json::to_vec(&default_load()).unwrap();
    let mut a = Host::spawn(&receipts.join("end-a.stderr.log"));
    let loaded = a.json(LOAD, &load);
    let t0 = bits_of(&loaded["t_bits"]);
    let period = loaded["frame_s"].as_f64().expect("frame_s");
    let k0 = (t0 / period).round() as u64;
    let instant = |k: u64| (k0 + k) as f64 * period;
    let relief = json!({"kind": "ReliefStuckOpen", "t_apply": instant(1)});
    a.json(COMMAND, &serde_json::to_vec(&relief).unwrap());
    let end = to_the_end(&mut a, instant, 1, last);
    let named = &end.events["ended"];
    assert_eq!(named["label"], "solidPzr", "{named}");
    assert_eq!(named["t"].as_f64(), Some(end.t), "{named}");
    let status = a.json(STATUS, &[]);
    assert_eq!(status["failed"], Value::Null, "{status}");
    assert_eq!(status["ended"]["label"], "solidPzr", "{status}");

    // Nothing runs past it, and each refusal says why.
    let t1 = (end.t / period).ceil() * period + period;
    let refused = a.refused(ADVANCE, &t1.to_le_bytes());
    assert!(refused.contains("the unit ended at"), "{refused}");
    let command = json!({"kind": "ReliefStuckOpen", "t_apply": end.t});
    let refused_command = a.refused(COMMAND, &serde_json::to_vec(&command).unwrap());
    assert!(refused_command.contains("the unit ended at"), "{refused_command}");

    // The end holds a state: a snapshot, and a unit restored from it.
    let snapshot = a.ok(SNAPSHOT, &[]).payload;
    std::fs::write(receipts.join("snapshot-end.json"), &snapshot).unwrap();
    let mut b = Host::spawn(&receipts.join("end-b.stderr.log"));
    let restored = b.json(RESTORE, &snapshot);
    assert_eq!(bits_of(&restored["t_bits"]), end.t, "{restored}");
    let k = (end.t / period).ceil() as u64 - k0;
    let again = to_the_end(&mut b, instant, k, last);
    assert_eq!(again.events["ended"]["label"], "solidPzr");
    std::fs::write(
        receipts.join("named-end.json"),
        serde_json::to_vec_pretty(&json!({
            "first": named, "after_restore": again.events["ended"],
            "refusals": [refused, refused_command],
        }))
        .unwrap(),
    )
    .unwrap();
    a.close();
    b.close();
}

/// R4-TIME-STOPPED on the real unit: the relief fails open from the saved
/// state, the level reaches the spray port and the model refuses that state.
/// The unit stops by name, at once, and a host gets the refusal with it.
/// Run with `LD01_UNIT_HOST_RECEIPTS` and the tuple's environment.
#[test]
#[ignore = "NOT-EVIDENCE gate: one ld01-unit process, the relief's 50 s (minutes)"]
fn a_refused_state_stops_the_unit_by_name() {
    let receipts = std::path::PathBuf::from(env("LD01_UNIT_HOST_RECEIPTS"));
    let load = json!({
        "inputs": {
            "packet": env("LD01_OPERATING_HOT_SPINE_PACKET"),
            "wiki_root": env("LD01_WIKI_ROOT"),
            "wiki_commit": env("LD01_WIKI_COMMIT"),
            "wiki_repository": env("LD01_WIKI_REPOSITORY"),
            "ic": env("LD01_IC_SECTION"),
            "pzr_control": env("LD01_PZR_CONTROL_SECTION"),
            "pzr_control_wiki": env("LD01_PZR_CONTROL_WIKI"),
            "elec": env("ELEC_PACKET"),
        },
        "state": env("LD01_S3_STATE"),
        "solver": {"weights": "stock", "first_step": "declared", "stepping": "free",
            "water": std::env::var("LD01_UNIT_HOST_WATER").unwrap_or_else(|_| "sbtl".into()),
            "source_atol": std::env::var("LD01_S3_SOURCE_ATOL").unwrap_or_else(|_| "derived".into())},
    });
    std::fs::create_dir_all(&receipts).expect("receipt directory");
    let mut host = Host::spawn(&receipts.join("time-stopped.stderr.log"));
    let loaded = host.json(LOAD, &serde_json::to_vec(&load).unwrap());
    let t0 = bits_of(&loaded["t_bits"]);
    let period = loaded["frame_s"].as_f64().expect("frame_s");
    let k0 = (t0 / period).round() as u64;
    let open = json!({"kind": "ReliefStuckOpen", "t_apply": (k0 + 1) as f64 * period});
    host.ok(COMMAND, &serde_json::to_vec(&open).unwrap());
    // The cause arrives as a refusal, or in the `ended` event once a named
    // domain end holds the unit (R4-ENDED): the same text either way.
    let mut walls = AdvanceWalls::default();
    let cause = (2..800)
        .find_map(|k| {
            let r = walls.timed(&mut host, (k0 + k) as f64 * period);
            if r.status != 0 {
                return Some(String::from_utf8(r.payload).expect("UTF-8 cause"));
            }
            let events = frame(&r.payload).events;
            events["ended"]["cause"].as_str().map(str::to_string)
        })
        .expect("the relief's run ends in a refused state");
    std::fs::write(receipts.join("time-stopped.cause.txt"), &cause).expect("receipt");
    std::fs::write(
        receipts.join("advance-wall.json"),
        serde_json::to_vec_pretty(&walls.receipt((1. / period).round() as usize)).unwrap(),
    )
    .expect("receipt");
    assert!(cause.contains("solver time stopped"), "{cause}");
    assert!(cause.contains("the solid-PZR structural limit"), "{cause}");
    // Fail-stop: the next ADVANCE carries the same cause; STATUS and CLOSE work.
    let again = host.refused(ADVANCE, &((k0 + 900) as f64 * period).to_le_bytes());
    assert!(again.contains("solver time stopped"), "{again}");
    host.ok(STATUS, &[]);
    host.close();
}

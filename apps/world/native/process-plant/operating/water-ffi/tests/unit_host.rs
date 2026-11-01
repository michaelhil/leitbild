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
//!   continues to `t_c + 30 s`. A refusal of the source after the copy point
//!   ends both runs there; the copy must refuse identically, and the gate
//!   still fails. Process B restores the snapshot and makes the same
//!   exchanges. Every exchange's reply payload (time, counts, the
//!   observation frame and its events) and the final snapshots are
//!   byte-equal.
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

fn advance(host: &mut Host, t1: f64) -> (Vec<u8>, f64) {
    let r = host.ok(ADVANCE, &t1.to_le_bytes());
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
    let end = copy_at + 300;
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
    refusals.insert(
        "ADVANCE behind the unit".into(),
        json!(a.refused(ADVANCE, &t0.to_le_bytes())),
    );
    let trip = json!({"kind": "TurbineTripAcquired", "t_apply": instant(10)});
    let applied = a.json(COMMAND, &serde_json::to_vec(&trip).unwrap());
    let mut trace = Vec::new();
    let mut a_cpu = 0.;
    for k in 1..=copy_at {
        let (p, cpu) = advance(&mut a, instant(k));
        a_cpu += cpu;
        let f = frame(&p);
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
        let r = a.request(ADVANCE, &instant(k).to_le_bytes());
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
        let r = b.request(ADVANCE, &instant(k).to_le_bytes());
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
        "t0": t0, "copy_exchange": copy_at, "copy_point": instant(copy_at), "end": instant(end), "trip": applied,
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
        "a_status": a_status, "refusals": refusals, "trace_to_copy_point": trace,
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

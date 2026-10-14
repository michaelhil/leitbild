//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#coordinated-computation-without-a-new-framework
//! TEST-ONLY child-process host of one LD-01 S1 unit, speaking a framed
//! binary protocol on stdin/stdout (stderr carries diagnostics only).
//! Never registered in a Pack, the Runtime Hub or the deployer.
//!
//! Frames are little-endian. Request: `u32 len | u8 op | u32 seq | payload`;
//! reply: `u32 len | u8 status | u32 seq | payload`, where `len` counts the
//! bytes after itself. Status 0 is success: the payload starts with
//! `f64 handler_wall_s, f64 handler_cpu_s`, then the op's own data. Status 1
//! is an explicit refusal: the payload is a UTF-8 message. There is no
//! retry, default or fallback; a fatal native error ends the process and the
//! parent sees the exit status.
//!
//! | op | request payload | reply data |
//! |---|---|---|
//! | 1 LOAD | UTF-8 JSON `{packet, wiki}` | UTF-8 JSON (identity, dimension, signals, report) |
//! | 2 ADVANCE | `f64 target, u8 mode, u8 observe` | `f64 t, f64 internal_t, 8 x i64 counts, u32 n, n x f64 signals` |
//! | 3 COMMAND | `f64 t, u32 rotor, u8 supported` | — |
//! | 4 OBSERVE | — | `u32 n, n x f64 signals` |
//! | 5 SNAPSHOT | — | snapshot bytes |
//! | 6 RESTORE | `u32 json_len, JSON {packet, wiki}, snapshot bytes` | UTF-8 JSON report |
//! | 7 PING | any bytes | the same bytes |
//! | 8 ABORT | — | none: the process aborts (simulated native fatal) |
//! | 9 CLOSE | — | — (then exit 0) |
//! | 10 STATUS | — | UTF-8 JSON (process CPU, time) |
use leitbild_ld01_host_spike::{
    cpu, sha256,
    unit::{Command, Config, Mode, SIGNALS, Unit},
};
use serde_json::json;
use std::io::{BufReader, BufWriter, Read, Write};
use std::time::Instant;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self
            .bytes
            .get(self.at..self.at + n)
            .ok_or("truncated request payload")?;
        self.at += n;
        Ok(s)
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn rest(&mut self) -> &'a [u8] {
        let s = &self.bytes[self.at..];
        self.at = self.bytes.len();
        s
    }
}

fn signals(unit: &mut Unit, out: &mut Vec<u8>) -> Result<(), String> {
    let mut values = [0.; SIGNALS.len()];
    unit.observe(&mut values)?;
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(())
}

fn config(bytes: &[u8]) -> Result<Config, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("config JSON: {e}"))
}

struct Host {
    unit: Option<Unit>,
    kernel: String,
}
impl Host {
    fn unit(&mut self) -> Result<&mut Unit, String> {
        self.unit.as_mut().ok_or_else(|| "no unit is loaded".into())
    }
    /// Handle one request; `Ok(true)` asks the loop to exit after replying.
    fn handle(&mut self, op: u8, payload: &[u8], out: &mut Vec<u8>) -> Result<bool, String> {
        let mut r = Reader {
            bytes: payload,
            at: 0,
        };
        match op {
            1 => {
                let (unit, report) = Unit::load(&config(r.rest())?, &self.kernel)?;
                let reply = json!({"identity": unit.identity(), "dimension": unit.dimension(),
                    "signals": SIGNALS, "report": report, "pid": std::process::id()});
                out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
                self.unit = Some(unit);
            }
            2 => {
                let target = r.f64()?;
                let mode = Mode::from_code(r.u8()?)?;
                let observe = r.u8()? != 0;
                let unit = self.unit()?;
                let report = unit.advance(target, mode)?;
                out.extend_from_slice(&report.t.to_le_bytes());
                out.extend_from_slice(&report.internal_t.to_le_bytes());
                let c = report.counts;
                for v in [
                    c.steps,
                    c.residuals,
                    c.jacobians,
                    c.nonlinear_iterations,
                    c.error_failures,
                    c.convergence_failures,
                    c.restarts,
                    c.rebuilds,
                ] {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                if observe {
                    signals(unit, out)?;
                } else {
                    out.extend_from_slice(&0u32.to_le_bytes());
                }
            }
            3 => {
                let t = r.f64()?;
                let rotor = r.u32()? as usize;
                let supported = r.u8()? != 0;
                self.unit()?.command(Command {
                    t,
                    rotor,
                    supported,
                })?;
            }
            4 => signals(self.unit()?, out)?,
            5 => out.extend_from_slice(&self.unit()?.snapshot()?),
            6 => {
                let length = r.u32()? as usize;
                let config = config(r.take(length)?)?;
                let (unit, report) = Unit::restore(&config, &self.kernel, r.rest())?;
                let reply = json!({"identity": unit.identity(), "dimension": unit.dimension(),
                    "signals": SIGNALS, "report": report, "pid": std::process::id()});
                out.extend_from_slice(&serde_json::to_vec(&reply).unwrap());
                self.unit = Some(unit);
            }
            7 => out.extend_from_slice(r.rest()),
            8 => {
                eprintln!("ld01-host-spike: ABORT requested (simulated native fatal)");
                std::process::abort();
            }
            9 => return Ok(true),
            10 => {
                let t = self.unit.as_ref().map(|u| u.time());
                out.extend_from_slice(
                    &serde_json::to_vec(&json!({"process_cpu_s": cpu::process_s(), "t": t}))
                        .unwrap(),
                );
            }
            other => return Err(format!("unknown op {other}")),
        }
        Ok(false)
    }
}

fn write_frame(w: &mut impl Write, status: u8, seq: u32, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&((5 + payload.len()) as u32).to_le_bytes())?;
    w.write_all(&[status])?;
    w.write_all(&seq.to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    let kernel = sha256::hex(&std::fs::read(&exe).expect("read own executable"));
    let mut host = Host { unit: None, kernel };
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut output = BufWriter::new(std::io::stdout().lock());
    let mut header = [0u8; 4];
    loop {
        match input.read_exact(&mut header) {
            Ok(()) => {}
            // The parent closed stdin: an orderly end.
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return,
            Err(e) => panic!("stdin: {e}"),
        }
        let length = u32::from_le_bytes(header) as usize;
        assert!(length >= 5, "frame shorter than its op and sequence");
        let mut body = vec![0u8; length];
        input.read_exact(&mut body).expect("truncated frame");
        let op = body[0];
        let seq = u32::from_le_bytes(body[1..5].try_into().unwrap());
        let (cpu0, wall0) = (cpu::thread_s(), Instant::now());
        let mut data = Vec::new();
        let outcome = host.handle(op, &body[5..], &mut data);
        let (wall, cpu) = (wall0.elapsed().as_secs_f64(), cpu::thread_s() - cpu0);
        let written = match &outcome {
            Ok(_) => {
                let mut payload = Vec::with_capacity(16 + data.len());
                payload.extend_from_slice(&wall.to_le_bytes());
                payload.extend_from_slice(&cpu.to_le_bytes());
                payload.extend_from_slice(&data);
                write_frame(&mut output, 0, seq, &payload)
            }
            Err(message) => write_frame(&mut output, 1, seq, message.as_bytes()),
        };
        written.expect("stdout");
        if matches!(outcome, Ok(true)) {
            return;
        }
    }
}

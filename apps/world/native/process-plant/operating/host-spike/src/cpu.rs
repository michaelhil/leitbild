//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#reference-workload-and-measurement
//! Thread and process CPU clocks (POSIX clock_gettime) for the spike's
//! per-exchange cost attribution. Measurement only.
#![allow(unsafe_code)]

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
#[cfg(target_os = "macos")]
const PROCESS: i32 = 12;
#[cfg(target_os = "macos")]
const THREAD: i32 = 16;
#[cfg(target_os = "linux")]
const PROCESS: i32 = 2;
#[cfg(target_os = "linux")]
const THREAD: i32 = 3;

fn read(clock: i32) -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the 64-bit C layout on both
    // supported targets; the C library writes it and keeps no pointer.
    let status = unsafe { clock_gettime(clock, &mut t) };
    assert_eq!(status, 0, "CPU clock {clock} unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}

/// CPU seconds of the calling thread.
pub fn thread_s() -> f64 {
    read(THREAD)
}

/// CPU seconds of the whole process, every thread.
pub fn process_s() -> f64 {
    read(PROCESS)
}

#[repr(C)]
struct Rusage {
    user: [i64; 2],
    system: [i64; 2],
    max_rss: i64,
    rest: [i64; 13],
}
unsafe extern "C" {
    fn getrusage(who: i32, usage: *mut Rusage) -> i32;
}

/// Peak resident set of this process in bytes (getrusage RUSAGE_SELF;
/// macOS reports bytes, Linux KiB).
pub fn max_rss_bytes() -> u64 {
    let mut u = Rusage {
        user: [0; 2],
        system: [0; 2],
        max_rss: 0,
        rest: [0; 13],
    };
    // SAFETY: one live struct matching the 64-bit `struct rusage` layout on
    // both supported targets (two timevals of 16 bytes, then 14 longs); the
    // C library writes it and keeps no pointer.
    let status = unsafe { getrusage(0, &mut u) };
    assert_eq!(status, 0, "getrusage unavailable");
    let rss = u.max_rss.max(0) as u64;
    if cfg!(target_os = "linux") {
        rss * 1024
    } else {
        rss
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut u64) -> i32;
    fn getpid() -> i32;
}

/// Instructions retired and cycles of this whole process so far (macOS
/// `proc_pid_rusage`, RUSAGE_INFO_V4: `ri_instructions`, `ri_cycles`), the
/// load-independent cost measure of COST2 (`/usr/bin/time -l` reads the
/// same counters). Measurement only; `None` where the counters are absent.
#[cfg(target_os = "macos")]
pub fn instructions_cycles() -> Option<(u64, u64)> {
    // rusage_info_v4: a 16-byte uuid, then u64 fields; ri_instructions is
    // the 30th (index 29: 10 v0 + 6 v1 + 2 v2 + 9 v3 + logical_writes +
    // lifetime_max_phys_footprint), ri_cycles the next. 64 words cover the
    // whole v4 record (312 bytes).
    let mut buffer = [0u64; 64];
    // SAFETY: a live, 8-byte-aligned buffer larger than rusage_info_v4; the
    // C library writes at most that record and keeps no pointer.
    let status = unsafe { proc_pid_rusage(getpid(), 4, buffer.as_mut_ptr()) };
    (status == 0).then(|| (buffer[2 + 29], buffer[2 + 30]))
}
#[cfg(not(target_os = "macos"))]
pub fn instructions_cycles() -> Option<(u64, u64)> {
    None
}

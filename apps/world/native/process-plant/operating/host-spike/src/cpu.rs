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

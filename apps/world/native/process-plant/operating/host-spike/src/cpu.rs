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

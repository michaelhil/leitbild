//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The CPU clocks the unit's receipts read (POSIX `clock_gettime`):
//! measurement only, never an input of a computation. A clock is passed to
//! the frame driver and the ledger as an explicit port.

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("unit::clock knows the clock ids of macOS and Linux only");

/// `CLOCK_PROCESS_CPUTIME_ID` of this target.
const PROCESS: i32 = if cfg!(target_os = "macos") { 12 } else { 2 };
/// `CLOCK_THREAD_CPUTIME_ID` of this target.
const THREAD: i32 = if cfg!(target_os = "macos") { 16 } else { 3 };

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}

fn read(clock: i32) -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the 64-bit C layout on both
    // supported targets; the C library writes it and keeps no pointer.
    let status = unsafe { clock_gettime(clock, &mut t) };
    assert_eq!(status, 0, "CPU clock {clock} unavailable");
    t.seconds as f64 + 1e-9 * t.nanoseconds as f64
}

/// CPU seconds of the whole process, every thread.
pub fn process_cpu_s() -> f64 {
    read(PROCESS)
}

/// CPU seconds of the calling thread.
pub fn thread_cpu_s() -> f64 {
    read(THREAD)
}

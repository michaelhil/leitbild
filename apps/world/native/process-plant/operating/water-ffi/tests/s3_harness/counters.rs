//! The process's retired instructions and cycles (stock macOS
//! `proc_pid_rusage`, `RUSAGE_INFO_V4`), the common cost rule's measure
//! (COST2: costs in instructions retired, converted to quiet-equivalent
//! CPU seconds at a measured quiet ratio). The same counters
//! `/usr/bin/time -l` prints. Read only; no clock of the solver's.

/// `RUSAGE_INFO_V4`'s flavour number.
const RUSAGE_INFO_V4: i32 = 4;
/// `ri_instructions` and `ri_cycles` in `struct rusage_info_v4`, as 64-bit
/// words (after the 16-byte UUID and 29 counters).
const INSTRUCTIONS: usize = 31;
const CYCLES: usize = 32;

unsafe extern "C" {
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut u64) -> i32;
    fn getpid() -> i32;
}

/// The process's `(instructions, cycles)` retired so far.
pub fn read() -> Result<(u64, u64), String> {
    // rusage_info_v4 is 37 words; the buffer is larger.
    let mut buffer = [0u64; 64];
    let code = unsafe { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, buffer.as_mut_ptr()) };
    if code != 0 {
        return Err(format!("proc_pid_rusage returned {code}"));
    }
    Ok((buffer[INSTRUCTIONS], buffer[CYCLES]))
}

/// Instructions retired so far (0 when the counters are unavailable; the
/// receipt then states it).
pub fn instructions() -> u64 {
    read().map_or(0, |(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counters_advance_with_work() {
        let (i0, c0) = read().unwrap();
        let mut x = 0u64;
        for k in 0..5_000_000u64 {
            x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(k);
        }
        std::hint::black_box(x);
        let (i1, c1) = read().unwrap();
        assert!(i1 > i0 + 5_000_000, "{i0} -> {i1}");
        assert!(c1 > c0, "{c0} -> {c1}");
    }
}

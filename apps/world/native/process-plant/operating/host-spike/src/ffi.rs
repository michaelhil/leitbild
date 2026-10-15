//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#coordinated-computation-without-a-new-framework
//! TEST-ONLY minimal C ABI over one unit, for the in-process `bun:ffi`
//! comparison of the spike (measurement only). Every entry catches a Rust
//! panic so none unwinds into the host; a native abort (SUNDIALS fatal,
//! segfault, `ld01_spike_abort`) still ends the whole hosting process,
//! which is exactly what the comparison demonstrates.
#![allow(unsafe_code)]
use crate::unit::{Config, Mode, SIGNALS, Unit};
use std::{
    cell::RefCell,
    panic::{AssertUnwindSafe, catch_unwind},
};

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}
fn fail(message: String) {
    LAST_ERROR.with(|e| *e.borrow_mut() = message);
}

/// Pure call overhead: no state, no allocation.
#[unsafe(no_mangle)]
pub extern "C" fn ld01_spike_noop(x: f64) -> f64 {
    x + 1.
}

/// # Safety
/// `config` must point to `length` readable bytes.
unsafe fn config(config: *const u8, length: usize) -> Result<Config, String> {
    // SAFETY: the caller guarantees `length` readable bytes at `config`.
    let bytes = unsafe { std::slice::from_raw_parts(config, length) };
    serde_json::from_slice(bytes).map_err(|e| format!("config JSON: {e}"))
}

fn boxed(result: std::thread::Result<Result<Unit, String>>) -> *mut Unit {
    match result {
        Ok(Ok(unit)) => Box::into_raw(Box::new(unit)),
        Ok(Err(message)) => {
            fail(message);
            std::ptr::null_mut()
        }
        Err(_) => {
            fail("panic in the unit".into());
            std::ptr::null_mut()
        }
    }
}

/// Load a unit from its prepared state. Null on failure (see last_error).
///
/// # Safety
/// `config_json` must point to `length` readable bytes of UTF-8 JSON.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ld01_spike_open(config_json: *const u8, length: usize) -> *mut Unit {
    boxed(catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: forwarded caller guarantee.
        let c = unsafe { config(config_json, length) }?;
        Unit::load(&c, crate::KERNEL_SOURCE_SHA256).map(|(u, _)| u)
    })))
}

/// Restore a unit from a snapshot. Null on failure (see last_error).
///
/// # Safety
/// Both pointers must point to their stated number of readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ld01_spike_restore(
    config_json: *const u8,
    length: usize,
    snapshot: *const u8,
    snapshot_length: usize,
) -> *mut Unit {
    boxed(catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: forwarded caller guarantees.
        let c = unsafe { config(config_json, length) }?;
        let blob = unsafe { std::slice::from_raw_parts(snapshot, snapshot_length) };
        Unit::restore(&c, crate::KERNEL_SOURCE_SHA256, blob).map(|(u, _)| u)
    })))
}

/// Advance to `target` in `mode` (0..=3). Writes `t` and the total step
/// count to `out[0..2]`, then, when `capacity` allows, the observed
/// signals. Returns the number of values written, or -1 (see last_error).
///
/// # Safety
/// `unit` must come from open/restore and not be closed; `out` must hold
/// `capacity` writable f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ld01_spike_advance(
    unit: *mut Unit,
    target: f64,
    mode: u8,
    out: *mut f64,
    capacity: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| -> Result<i32, String> {
        // SAFETY: the caller passes a live unit and a writable buffer.
        let unit = unsafe { unit.as_mut() }.ok_or("null unit")?;
        let out = unsafe { std::slice::from_raw_parts_mut(out, capacity) };
        if capacity < 2 {
            return Err("output buffer below 2 values".into());
        }
        let report = unit.advance(target, Mode::from_code(mode)?)?;
        out[0] = report.t;
        out[1] = report.counts.steps as f64;
        if capacity >= 2 + SIGNALS.len() {
            unit.observe(&mut out[2..2 + SIGNALS.len()])?;
            return Ok((2 + SIGNALS.len()) as i32);
        }
        Ok(2)
    }));
    match result {
        Ok(Ok(n)) => n,
        Ok(Err(message)) => {
            fail(message);
            -1
        }
        Err(_) => {
            fail("panic in the unit".into());
            -1
        }
    }
}

/// Copy the calling thread's last error into `out`; returns its length.
///
/// # Safety
/// `out` must hold `capacity` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ld01_spike_last_error(out: *mut u8, capacity: usize) -> usize {
    LAST_ERROR.with(|e| {
        let e = e.borrow();
        let n = e.len().min(capacity);
        // SAFETY: the caller guarantees `capacity` writable bytes.
        unsafe { std::ptr::copy_nonoverlapping(e.as_ptr(), out, n) };
        n
    })
}

/// Free a unit.
///
/// # Safety
/// `unit` must come from open/restore and be closed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ld01_spike_close(unit: *mut Unit) {
    if !unit.is_null() {
        // SAFETY: the pointer came from Box::into_raw and is closed once.
        drop(unsafe { Box::from_raw(unit) });
    }
}

/// A simulated native fatal: ends the hosting process.
#[unsafe(no_mangle)]
pub extern "C" fn ld01_spike_abort() {
    std::process::abort();
}

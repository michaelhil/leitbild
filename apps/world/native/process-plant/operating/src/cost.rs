//! Opt-in cost profile (plan r4, lane PERF, E-PROF): where a run's
//! instructions go, by nested scope. A measurement aid only: no scope
//! changes a value, a step, an event or a branch of the model.
//!
//! The profile is off unless a caller installs a counter on this thread
//! ([`install`]; the S3 case drive does so with `LD01_PERF_PROFILE=1`,
//! reading the process's instructions retired). Off, every scope is one
//! thread-local read. On, a scope books its exclusive instructions (its own
//! less its nested scopes') under its path, e.g. `step>jacobian>nuclear`,
//! with a call count. A scope that is open when a snapshot is taken books
//! nothing until it closes.
use std::{cell::RefCell, collections::HashMap};

struct Open {
    key: usize,
    start: u64,
    nested: u64,
}

struct Profile {
    counter: fn() -> u64,
    reads: u64,
    open: Vec<Open>,
    /// Path of each key, `parent>name`.
    paths: Vec<String>,
    index: HashMap<(usize, &'static str), usize>,
    /// Per key: (closed calls, exclusive instructions).
    totals: Vec<(u64, u64)>,
}

thread_local! {
    static PROFILE: RefCell<Option<Profile>> = const { RefCell::new(None) };
}

/// Start profiling this thread with `counter` (monotone instructions
/// retired). Refuses a second installation.
pub fn install(counter: fn() -> u64) -> Result<(), String> {
    PROFILE.with(|p| {
        let mut p = p.borrow_mut();
        if p.is_some() {
            return Err("the cost profile is already installed on this thread".into());
        }
        *p = Some(Profile {
            counter,
            reads: 0,
            open: Vec::new(),
            paths: Vec::new(),
            index: HashMap::new(),
            totals: Vec::new(),
        });
        Ok(())
    })
}

/// Whether a profile is installed on this thread.
pub fn active() -> bool {
    PROFILE.with(|p| p.borrow().is_some())
}

/// Open scope `name` under the innermost open scope.
pub fn enter(name: &'static str) {
    PROFILE.with(|p| {
        if let Some(p) = p.borrow_mut().as_mut() {
            let parent = p.open.last().map_or(usize::MAX, |o| o.key);
            let key = match p.index.get(&(parent, name)) {
                Some(k) => *k,
                None => {
                    let path = if parent == usize::MAX {
                        name.to_string()
                    } else {
                        format!("{}>{name}", p.paths[parent])
                    };
                    p.paths.push(path);
                    p.totals.push((0, 0));
                    p.index.insert((parent, name), p.paths.len() - 1);
                    p.paths.len() - 1
                }
            };
            p.reads += 1;
            let start = (p.counter)();
            p.open.push(Open {
                key,
                start,
                nested: 0,
            });
        }
    });
}

/// Close the innermost open scope. Closing with none open is a defect of
/// the instrumentation and panics.
pub fn exit() {
    PROFILE.with(|p| {
        if let Some(p) = p.borrow_mut().as_mut() {
            p.reads += 1;
            let now = (p.counter)();
            let o = p
                .open
                .pop()
                .expect("cost profile: exit without an open scope");
            let inclusive = now.saturating_sub(o.start);
            let t = &mut p.totals[o.key];
            t.0 += 1;
            t.1 += inclusive.saturating_sub(o.nested);
            if let Some(parent) = p.open.last_mut() {
                parent.nested += inclusive;
            }
        }
    });
}

/// A scope closed when dropped (a panic unwinding through it closes it).
pub struct Scope(());
impl Drop for Scope {
    fn drop(&mut self) {
        exit();
    }
}
/// Open `name` until the returned guard drops; nothing when off.
#[must_use]
pub fn scope(name: &'static str) -> Option<Scope> {
    active().then(|| {
        enter(name);
        Scope(())
    })
}

/// The counter's current value as `f64`, for a caller-clocked profile (the
/// block Jacobian's pieces); 0 when off.
pub fn now_f64() -> f64 {
    PROFILE.with(|p| {
        p.borrow_mut().as_mut().map_or(0., |p| {
            p.reads += 1;
            (p.counter)() as f64
        })
    })
}

/// Book a caller-clocked piece (inclusive, outside the scope tree) under
/// `pieces>name`.
pub fn book(name: &'static str, calls: u64, instructions: u64) {
    const PIECES: usize = usize::MAX - 1;
    PROFILE.with(|p| {
        if let Some(p) = p.borrow_mut().as_mut() {
            let key = match p.index.get(&(PIECES, name)) {
                Some(k) => *k,
                None => {
                    p.paths.push(format!("pieces>{name}"));
                    p.totals.push((0, 0));
                    p.index.insert((PIECES, name), p.paths.len() - 1);
                    p.paths.len() - 1
                }
            };
            p.totals[key].0 += calls;
            p.totals[key].1 += instructions;
        }
    });
}

/// One snapshot: every path so far with its (calls, exclusive
/// instructions), and the counter reads made so far.
pub struct Snapshot {
    pub paths: Vec<String>,
    pub totals: Vec<(u64, u64)>,
    pub reads: u64,
}
/// The profile so far, or `None` when off.
pub fn snapshot() -> Option<Snapshot> {
    PROFILE.with(|p| {
        p.borrow().as_ref().map(|p| Snapshot {
            paths: p.paths.clone(),
            totals: p.totals.clone(),
            reads: p.reads,
        })
    })
}
/// The current totals only (paths grow; a key's index never changes).
pub fn totals() -> Option<(Vec<(u64, u64)>, u64)> {
    PROFILE.with(|p| p.borrow().as_ref().map(|p| (p.totals.clone(), p.reads)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    thread_local! {
        static CLOCK: Cell<u64> = const { Cell::new(0) };
    }
    fn tick() -> u64 {
        CLOCK.with(|c| {
            c.set(c.get() + 10);
            c.get()
        })
    }

    #[test]
    fn nested_scopes_book_exclusive_counts_by_path() {
        assert!(scope("off").is_none());
        install(tick).unwrap();
        assert!(install(tick).is_err());
        {
            let _a = scope("step");
            {
                let _b = scope("residual");
            }
            {
                let _b = scope("residual");
                let _c = scope("nuclear");
            }
        }
        let s = snapshot().unwrap();
        assert_eq!(s.paths, ["step", "step>residual", "step>residual>nuclear"]);
        // Each read advances the clock by 10: residual's first call reads
        // 20 -> 30, the second 40 -> 70 around nuclear's 50 -> 60.
        assert_eq!(s.totals[2], (1, 10));
        assert_eq!(s.totals[1], (2, 10 + 20));
        // step 10 -> 80: 70 inclusive, 40 nested.
        assert_eq!(s.totals[0], (1, 30));
        assert_eq!(s.reads, 8);
    }
}

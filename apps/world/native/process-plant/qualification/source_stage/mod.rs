//! Complete analytic CSC prepares the fixed nine-block preconditioner and
//! independently checks the production chain-rule JVP. No ordering search,
//! alternate trajectory or projection.
use super::*;
use source_evolution::Jacobian;

pub(super) struct Stage {
    jacobian: Jacobian,
    #[cfg(test)]
    pointers: Vec<i64>,
    #[cfg(test)]
    entries: Vec<f64>,
    #[cfg(test)]
    attempts: u64,
    #[cfg(test)]
    completed_seconds: f64,
    #[cfg(test)]
    cj: Option<f64>,
    p: Option<source_block::BlockPreconditioner>,
    p_work: Option<Workspace>,
    p_entries: Vec<f64>,
    p_valid: bool,
    p_attempts: u64,
    p_preparation_seconds: f64,
}

fn csc(n: usize, pattern: &[(usize, usize)]) -> Result<(Vec<i64>, Vec<i64>), String> {
    if n == 0 || i64::try_from(n).is_err() || i64::try_from(pattern.len()).is_err() {
        return Err("Invalid complete CSC dimension".into());
    }
    let mut pointers = vec![0i64; n + 1];
    let mut indices = Vec::with_capacity(pattern.len());
    let mut previous = None;
    for &(r, c) in pattern {
        if r >= n || c >= n || previous.is_some_and(|p| p >= (c, r)) {
            return Err("Complete Jacobian pattern is not unique sorted CSC".into());
        }
        previous = Some((c, r));
        indices.push(r as i64);
        pointers[c + 1] += 1;
    }
    for c in 0..n {
        pointers[c + 1] += pointers[c];
    }
    Ok((pointers, indices))
}

/// Iterative Kosaraju on the immutable dependency graph. Stored structural
/// zeros remain edges: this describes symbolic coupling, not current-state
/// rank, numerical fill, KLU's selected ordering or factor time.
fn components(n: usize, pattern: &[(usize, usize)]) -> Result<(Vec<usize>, Vec<usize>), String> {
    let mut forward = vec![0usize; n + 1];
    let mut reverse = vec![0usize; n + 1];
    for &(r, c) in pattern {
        if r >= n || c >= n {
            return Err("Invalid structural dependency index".into());
        }
        forward[c + 1] += 1;
        reverse[r + 1] += 1;
    }
    for i in 0..n {
        forward[i + 1] += forward[i];
        reverse[i + 1] += reverse[i];
    }
    let mut successors = vec![0usize; pattern.len()];
    let mut predecessors = vec![0usize; pattern.len()];
    let mut fc = forward[..n].to_vec();
    let mut rc = reverse[..n].to_vec();
    for &(r, c) in pattern {
        successors[fc[c]] = r;
        fc[c] += 1;
        predecessors[rc[r]] = c;
        rc[r] += 1;
    }
    let mut seen = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut dfs = Vec::<(usize, usize)>::new();
    for root in 0..n {
        if seen[root] {
            continue;
        }
        seen[root] = true;
        dfs.push((root, forward[root]));
        while let Some((v, next)) = dfs.last_mut() {
            if *next < forward[*v + 1] {
                let w = successors[*next];
                *next += 1;
                if !seen[w] {
                    seen[w] = true;
                    dfs.push((w, forward[w]));
                }
            } else {
                order.push(*v);
                dfs.pop();
            }
        }
    }
    let mut labels = vec![usize::MAX; n];
    let mut sizes = Vec::new();
    let mut stack = Vec::new();
    for &root in order.iter().rev() {
        if labels[root] != usize::MAX {
            continue;
        }
        let label = sizes.len();
        let mut size = 0;
        labels[root] = label;
        stack.push(root);
        while let Some(v) = stack.pop() {
            size += 1;
            for &w in &predecessors[reverse[v]..reverse[v + 1]] {
                if labels[w] == usize::MAX {
                    labels[w] = label;
                    stack.push(w);
                }
            }
        }
        sizes.push(size);
    }
    Ok((labels, sizes))
}

const FAMILIES: [&str; 9] = [
    "neutrons",
    "precursors",
    "fuel-isotope-poison-products",
    "E25",
    "Cf-spent",
    "shared-water-HB",
    "shared-target-progress-or-Mn56",
    "Mn-final-product",
    "audit-integrals",
];
fn family(model: &Evolution, row: usize) -> usize {
    if row < fuel_source::GROUPS * model.region_count() {
        0
    } else if row < model.nc_dimension() {
        1
    } else if row == model.cf_row() {
        4
    } else if row < model.history_dimension() {
        if model.is_energy_row(row) { 3 } else { 2 }
    } else if row < model.target_row(0) {
        5
    } else if row < model.mn_product_row(0) {
        6
    } else if row < model.ledger_row() {
        7
    } else {
        8
    }
}
fn structure_json(model: &Evolution, pattern: &[(usize, usize)]) -> Result<String, String> {
    let began = Instant::now();
    let n = model.state_count();
    let (labels, sizes) = components(n, pattern)?;
    let largest = sizes
        .iter()
        .enumerate()
        .max_by_key(|&(_, size)| size)
        .map(|(i, _)| i)
        .ok_or("Empty structural graph")?;
    let mut counts = [0usize; 9];
    let mut largest_counts = [0usize; 9];
    let mut entries = [[0usize; 9]; 9];
    let mut row_degree = vec![0usize; n];
    let mut column_degree = vec![0usize; n];
    let (mut internal, mut largest_internal, mut diagonal) = (0usize, 0usize, 0usize);
    for row in 0..n {
        counts[family(model, row)] += 1;
        if labels[row] == largest {
            largest_counts[family(model, row)] += 1;
        }
    }
    for &(r, c) in pattern {
        entries[family(model, r)][family(model, c)] += 1;
        if r == c {
            diagonal += 1;
        } else {
            row_degree[r] += 1;
            column_degree[c] += 1;
        }
        if labels[r] == labels[c] {
            internal += 1;
            if labels[r] == largest {
                largest_internal += 1;
            }
        }
    }
    let families = (0..9).map(|f| {
        let rows = (0..n).filter(|&r| family(model, r) == f);
        let max_row = rows.clone().map(|r| row_degree[r]).max().unwrap_or(0);
        let max_col = rows.map(|r| column_degree[r]).max().unwrap_or(0);
        format!("{{\"name\":{},\"coordinates\":{},\"largestSCCCoordinates\":{},\"maximumOffDiagonalRowDegree\":{max_row},\"maximumOffDiagonalColumnDegree\":{max_col}}}", quote(FAMILIES[f]), counts[f], largest_counts[f])
    }).collect::<Vec<_>>().join(",");
    let cross = (0..9)
        .flat_map(|r| (0..9).map(move |c| (r, c)))
        .filter(|&(r, c)| entries[r][c] != 0)
        .map(|(r, c)| format!("[{r},{c},{}]", entries[r][c]))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "{{\"kind\":\"direct-pattern-structure\",\"coordinates\":{n},\"storedEntries\":{},\"diagonalEntries\":{diagonal},\"SCCs\":{},\"nontrivialSCCs\":{},\"largestSCCCoordinates\":{},\"largestSCCStoredEntries\":{largest_internal},\"withinSCCEntries\":{internal},\"betweenSCCEntries\":{},\"families\":[{families}],\"entriesByRowColumnFamily\":[{cross}],\"analysisSeconds\":{},\"scope\":\"immutable-symbolic-dependencies-including-structural-zeros;not-factor-fill-numerical-rank-or-cost-proof\"}}",
        pattern.len(),
        sizes.len(),
        sizes.iter().filter(|&&s| s > 1).count(),
        sizes[largest],
        pattern.len() - internal,
        finite(began.elapsed().as_secs_f64())
    ))
}
pub(super) fn structure(model: &Evolution, started: Instant) -> Result<(), String> {
    let begin = Instant::now();
    let direct = Stage::new(model)?;
    println!("{}", structure_json(model, direct.jacobian.pattern())?);
    budget(started)?;
    println!(
        "{{\"kind\":\"source-structure-final\",\"passed\":true,\"noAdvancement\":true,\"noFactorization\":true,\"patternAndStructureSeconds\":{},\"elapsedSeconds\":{},\"scope\":\"structural-analysis-only;not-derivative-numerical-or-performance-qualification\"}}",
        finite(begin.elapsed().as_secs_f64()),
        finite(started.elapsed().as_secs_f64())
    );
    io::stdout().flush().map_err(|e| e.to_string())
}

impl Stage {
    pub(super) fn new(model: &Evolution) -> Result<Self, String> {
        let jacobian = Jacobian::new(model).map_err(str::to_owned)?;
        let (_pointers, indices) = csc(model.state_count(), jacobian.pattern())?;
        let p_entries = vec![0.; indices.len()];
        #[cfg(test)]
        let entries = p_entries.clone();
        Ok(Self {
            jacobian,
            #[cfg(test)]
            pointers: _pointers,
            #[cfg(test)]
            entries,
            #[cfg(test)]
            attempts: 0,
            #[cfg(test)]
            completed_seconds: 0.,
            #[cfg(test)]
            cj: None,
            p: None,
            p_work: None,
            p_entries,
            p_valid: false,
            p_attempts: 0,
            p_preparation_seconds: 0.,
        })
    }
    pub(super) fn nnz(&self) -> usize {
        self.p_entries.len()
    }
    pub(super) fn metrics_json(&self) -> String {
        format!(
            "{{\"method\":\"complete-chain-rule-JVP-SPGMR-left-nine-block-forward-sweep\",\"independentStageProof\":\"complete-analytic-CSC\",\"storedEntries\":{},\"preconditionerPreparationAttempts\":{},\"preconditionerPreparationSeconds\":{},\"preconditionerPreparationScope\":\"own-current-workspace-evaluation-plus-full-numeric-CSC;factor-costs-separate\",\"preconditioner\":{}}}",
            self.nnz(),
            self.p_attempts,
            finite(self.p_preparation_seconds),
            self.p.as_ref().map_or("null".into(), |p| p.metrics_json())
        )
    }
    #[cfg(test)]
    pub(super) fn assemble(
        &mut self,
        model: &Evolution,
        work: &mut Workspace,
        cj: f64,
    ) -> Result<(), String> {
        self.cj = None;
        self.attempts += 1;
        phase(
            "independent-CSC-proof-assembly",
            "enter",
            self.attempts,
            cj,
            None,
        )?;
        let begin = Instant::now();
        let result = self
            .jacobian
            .solver_values(model, work, cj, &mut self.entries)
            .map_err(str::to_owned);
        let seconds = begin.elapsed().as_secs_f64();
        if result.is_ok() {
            self.completed_seconds += seconds;
            self.cj = Some(cj);
        }
        phase(
            "independent-CSC-proof-assembly",
            if result.is_ok() { "exit" } else { "failure" },
            self.attempts,
            cj,
            Some(seconds),
        )?;
        result
    }
    #[cfg(test)]
    pub(super) fn multiply(&self, cj: f64, x: &[f64], out: &mut [f64]) -> Result<(), String> {
        if self.cj != Some(cj)
            || !cj.is_finite()
            || x.len() + 1 != self.pointers.len()
            || out.len() != x.len()
            || x.iter().any(|v| !v.is_finite())
        {
            return Err("Unprepared/stale compiled stage action".into());
        }
        sparse_action(self.jacobian.pattern(), &self.entries, x, out)
    }
    pub(super) fn setup_preconditioner(
        &mut self,
        model: &Evolution,
        physical: &[f64],
        cj: f64,
    ) -> Result<(), CallbackFailure> {
        self.p_valid = false;
        self.p_attempts += 1;
        if self.p.is_none() {
            self.p = Some(source_block::BlockPreconditioner::new(
                model,
                self.jacobian.pattern(),
            )?);
            self.p_work = Some(model.workspace());
        }
        phase("nine-block-setup", "enter", self.p_attempts, cj, None)?;
        let start = Instant::now();
        let preparation = (|| -> Result<(), CallbackFailure> {
            let work = self.p_work.as_mut().unwrap();
            model.evaluate_into(physical, work).map_err(trial_failure)?;
            self.jacobian
                .solver_values(model, work, cj, &mut self.p_entries)
                .map_err(str::to_owned)?;
            Ok(())
        })();
        self.p_preparation_seconds += start.elapsed().as_secs_f64();
        preparation?;
        self.p.as_mut().unwrap().setup(&self.p_entries)?;
        self.p_valid = true;
        phase(
            "nine-block-setup",
            "exit",
            self.p_attempts,
            cj,
            Some(start.elapsed().as_secs_f64()),
        )
        .map_err(Into::into)
    }
    pub(super) fn solve_preconditioner(
        &mut self,
        rhs: &[f64],
        out: &mut [f64],
    ) -> Result<(), String> {
        if !self.p_valid {
            return Err("Unprepared nine-block preconditioner".into());
        }
        self.p.as_mut().unwrap().solve(rhs, out)
    }
}

fn sparse_action(
    pattern: &[(usize, usize)],
    entries: &[f64],
    x: &[f64],
    out: &mut [f64],
) -> Result<(), String> {
    if pattern.len() != entries.len()
        || x.len() != out.len()
        || x.iter().chain(entries).any(|v| !v.is_finite())
    {
        return Err("Invalid compiled sparse action inputs".into());
    }
    out.fill(0.);
    for (&(r, c), &v) in pattern.iter().zip(entries) {
        out[r] += v * x[c];
    }
    if out.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite compiled sparse action".into());
    }
    Ok(())
}

fn phase(
    name: &str,
    status: &str,
    attempt: u64,
    cj: f64,
    seconds: Option<f64>,
) -> Result<(), String> {
    println!(
        "{{\"kind\":\"direct-stage-phase\",\"phase\":{},\"status\":{},\"attempt\":{attempt},\"cj\":{},\"measuredSeconds\":{}}}",
        quote(name),
        quote(status),
        finite(cj),
        seconds.map_or("null".into(), finite)
    );
    io::stdout().flush().map_err(|e| e.to_string())
}
fn budget(started: Instant) -> Result<(), String> {
    if started.elapsed().as_secs_f64() > 30. {
        Err("Stage fixed-state audit exceeded thirty-second allowance".into())
    } else {
        Ok(())
    }
}
fn action(
    n: usize,
    pattern: &[(usize, usize)],
    entries: &[f64],
    x: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let mut out = vec![0.; n];
    let mut scale = vec![0.; n];
    for (&(r, c), &v) in pattern.iter().zip(entries) {
        let term = v * x[c];
        out[r] += term;
        scale[r] += term.abs();
    }
    (out, scale)
}
fn action_error(actual: &[f64], expected: &[f64], scales: &[f64]) -> Result<f64, String> {
    let maximum = backward_error(actual, expected, scales)?;
    if maximum > 1e-10 {
        return Err(format!("Assembled/full-JVP stage mismatch: {maximum:e}"));
    }
    Ok(maximum)
}
fn backward_error(actual: &[f64], expected: &[f64], scales: &[f64]) -> Result<f64, String> {
    if actual.len() != expected.len() || actual.len() != scales.len() {
        return Err("Wrong backward-error dimensions".into());
    }
    let mut maximum: f64 = 0.;
    for (i, ((&a, &b), &s)) in actual.iter().zip(expected).zip(scales).enumerate() {
        if !a.is_finite() || !b.is_finite() || !s.is_finite() {
            return Err(format!("Nonfinite assembled action at row {i}"));
        }
        let error = (a - b).abs() / (s + b.abs()).max(f64::MIN_POSITIVE);
        maximum = maximum.max(error);
        if !error.is_finite() {
            return Err(format!("Nonfinite backward error at row {i}"));
        }
    }
    Ok(maximum)
}
fn closure(defect: f64, scale: f64, relative: f64, name: &str) -> Result<(), String> {
    if !defect.is_finite()
        || !scale.is_finite()
        || scale < 0.
        || defect.abs() > relative * scale.max(1e-30)
    {
        return Err(format!(
            "Independent {name} failed: defect={defect:e}, scale={scale:e}"
        ));
    }
    Ok(())
}
fn forward_error(x: &[f64], known: &[f64], weights: &[f64]) -> Result<f64, String> {
    let maximum = forward_diagnostic(x, known, weights)?;
    if maximum > 1e-6 {
        return Err(format!(
            "Manufactured correction exceeds 1e-6 solver weight: {maximum:e}"
        ));
    }
    Ok(maximum)
}
fn forward_diagnostic(x: &[f64], known: &[f64], weights: &[f64]) -> Result<f64, String> {
    if x.len() != known.len() || x.len() != weights.len() || x.is_empty() {
        return Err("Wrong manufactured forward-error dimensions".into());
    }
    let mut maximum: f64 = 0.;
    let mut worst = 0usize;
    for (i, ((&x, &k), &w)) in x.iter().zip(known).zip(weights).enumerate() {
        let error = ((x - k) / w).abs();
        if !x.is_finite() || !k.is_finite() || !w.is_finite() || w <= 0. || !error.is_finite() {
            return Err(format!(
                "Nonfinite manufactured weighted correction at row {i}"
            ));
        }
        if error > maximum {
            maximum = error;
            worst = i;
        }
    }
    println!(
        "{{\"kind\":\"manufactured-forward-error\",\"maximumWeightedError\":{},\"worstRow\":{worst},\"x\":{},\"known\":{},\"absoluteError\":{},\"weight\":{},\"diagnosticReference\":1e-6,\"withinReference\":{},\"admissionGate\":false}}",
        finite(maximum),
        finite(x[worst]),
        finite(known[worst]),
        finite((x[worst] - known[worst]).abs()),
        finite(weights[worst]),
        maximum <= 1e-6
    );
    io::stdout().flush().map_err(|e| e.to_string())?;
    Ok(maximum)
}
// Pinned SUNDIALS 7.5 ida_ls.c: IDA linear delta = sqrt(n)*eplifac*epsNewt;
// defaults .05 and .33. This is an inexact-Newton linear requirement, not
// nonlinear/LTE/output acceptance. Production leaves both defaults unchanged.
// https://github.com/LLNL/sundials/blob/v7.5.0/src/ida/ida_ls.c
fn ida_linear_tolerance(n: usize) -> f64 {
    (n as f64).sqrt() * 0.05 * 0.33
}
fn scaled_preconditioned_norm(
    p: &mut source_block::BlockPreconditioner,
    residual: &[f64],
    weights: &[f64],
) -> Result<f64, String> {
    if residual.len() != weights.len() || residual.is_empty() {
        return Err("Wrong scaled residual dimensions".into());
    }
    let mut pr = vec![0.; residual.len()];
    p.solve(residual, &mut pr)?;
    let mut norm = 0f64;
    for (&v, &w) in pr.iter().zip(weights) {
        let scaled = v / w;
        if !w.is_finite() || w <= 0. || !scaled.is_finite() {
            return Err("Nonfinite scaled preconditioned residual".into());
        }
        norm = norm.hypot(scaled);
    }
    Ok(norm)
}
fn retained(model: &Evolution, path: &str) -> Result<(f64, Vec<f64>, Vec<f64>), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    retained_bytes(model, &bytes)
}
fn retained_bytes(model: &Evolution, bytes: &[u8]) -> Result<(f64, Vec<f64>, Vec<f64>), String> {
    let n = model.state_count();
    let size = n
        .checked_mul(16)
        .and_then(|n| n.checked_add(33))
        .ok_or("Checkpoint size overflow")?;
    if bytes.len() != size
        || &bytes[..9] != CHECKPOINT_MAGIC
        || u64::from_le_bytes(bytes[9..17].try_into().unwrap()) != n as u64
    {
        return Err("Wrong physical source checkpoint format/dimension".into());
    }
    let time = f64::from_le_bytes(bytes[17..25].try_into().unwrap());
    let rtol = f64::from_le_bytes(bytes[25..33].try_into().unwrap());
    let read = |bytes: &[u8]| {
        bytes
            .chunks_exact(8)
            .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
            .collect::<Vec<_>>()
    };
    let y = read(&bytes[33..33 + n * 8]);
    let yp = read(&bytes[33 + n * 8..]);
    if !time.is_finite()
        || time < 0.
        || !rtol.is_finite()
        || rtol <= 0.
        || y.iter().chain(&yp).any(|v| !v.is_finite())
    {
        return Err("Nonfinite/invalid physical checkpoint".into());
    }
    // A same-chart checkpoint may retain an independent old ledger failure;
    // this does not repair it. Old C/F charts are never inferred or converted.
    model.validate_accepted_state(&y)?;
    Ok((time, y, yp))
}

struct AuditLinear<'a> {
    pattern: &'a [(usize, usize)],
    entries: &'a [f64],
    preconditioner: &'a mut source_block::BlockPreconditioner,
    n: usize,
    error: Option<String>,
}
fn audit_callback(
    user: Handle,
    f: impl FnOnce(&mut AuditLinear<'_>) -> Result<(), String>,
) -> c_int {
    let c = unsafe { &mut *(user as *mut AuditLinear<'_>) };
    match catch_unwind(AssertUnwindSafe(|| f(c))) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            c.error = Some(e);
            -1
        }
        Err(_) => {
            c.error = Some("Panic contained at standalone linear callback".into());
            -1
        }
    }
}
unsafe extern "C" fn audit_atimes(user: Handle, v: Handle, out: Handle) -> c_int {
    audit_callback(user, |c| {
        if v == out {
            return Err("Aliased standalone sparse-action vectors".into());
        }
        sparse_action(c.pattern, c.entries, unsafe { values(v, c.n) }?, unsafe {
            output(out, c.n)
        }?)
    })
}
unsafe extern "C" fn audit_psolve(
    user: Handle,
    rhs: Handle,
    out: Handle,
    _: f64,
    side: c_int,
) -> c_int {
    audit_callback(user, |c| {
        if side != 1 || rhs == out {
            return Err("Invalid/aliased standalone left-preconditioner call".into());
        }
        c.preconditioner
            .solve(unsafe { values(rhs, c.n) }?, unsafe { output(out, c.n) }?)
    })
}

pub(super) fn audit(
    model: &Evolution,
    accuracy: &Accuracy,
    path: &str,
    cj: f64,
    started: Instant,
) -> Result<(), String> {
    if !cj.is_finite() || cj <= 0. {
        return Err("Invalid direct-audit stage coefficient".into());
    }
    println!(
        "{{\"kind\":\"stage-audit-method\",\"stateChart\":\"LDSRC-MNF\",\"accuracyPolicy\":\"source-consequences-1\",\"provisional\":true,\"absoluteToleranceArm\":\"normal-policy-vector\",\"productionOuterAction\":\"complete-chain-rule-JVP\",\"auditOuterAction\":\"complete-analytic-CSC\",\"preconditioner\":\"fixed-seven-energy-ILU0-complete-precursor-complete-slow-KLU\",\"scope\":\"independent-stage-action-and-IDA-default-linear-norm-proof;not-nonlinear-LTE-output-or-duration-qualification\"}}"
    );
    io::stdout().flush().map_err(|e| e.to_string())?;
    let (time, captured, captured_yp) = retained(model, path)?;
    budget(started)?;
    phase("immutable-pattern", "enter", 1, cj, None)?;
    let begin = Instant::now();
    let direct = Stage::new(model)?;
    let pattern_seconds = begin.elapsed().as_secs_f64();
    println!("{}", structure_json(model, direct.jacobian.pattern())?);
    io::stdout().flush().map_err(|e| e.to_string())?;
    phase("immutable-pattern", "exit", 1, cj, Some(pattern_seconds))?;
    budget(started)?;
    let n = model.state_count();
    let absolute = accuracy.absolute(1.)?;
    let coordinates = Coordinates {
        nc: model.nc_dimension(),
        ledger: model.ledger_row(),
    };
    // One immutable pattern: seven spatial ILU(0) blocks and two retained KLU
    // contexts. Captured-state setup refreshes coefficients, not physical law.
    let mut preconditioner =
        source_block::BlockPreconditioner::new(model, direct.jacobian.pattern())?;
    let mut resources = Resources::new()?;
    let zero = resources.vector(&vec![0.; n])?;
    resources.spgmr(zero, 30, 0)?;
    for (case, y, supplied_yp) in [
        ("original", model.initial_state(), None),
        ("captured", captured, Some(captured_yp)),
    ] {
        let mut work = model.workspace();
        let begin = Instant::now();
        model.evaluate_into(&y, &mut work).map_err(str::to_owned)?;
        let rhs_seconds = begin.elapsed().as_secs_f64();
        let rates = work.rates().map_err(str::to_owned)?.to_vec();
        let diagnostics = work.diagnostics().map_err(str::to_owned)?;
        finite_diagnostics(diagnostics)?;
        let rhs_balance = model.conservation(&rates).map_err(str::to_owned)?;
        closure(
            rhs_balance.neutron_ledger_defect,
            diagnostics.neutron_event_scale_s,
            1e-10,
            "RHS number",
        )?;
        closure(
            rhs_balance.energy_ledger_defect_j,
            rhs_balance.energy_ledger_scale_j,
            256. * f64::EPSILON,
            "RHS selected energy",
        )?;
        let yp = supplied_yp.unwrap_or_else(|| rates.clone());
        let mut physical = vec![0.; direct.nnz()];
        let begin = Instant::now();
        direct
            .jacobian
            .values(model, &mut work, cj, &mut physical)
            .map_err(str::to_owned)?;
        let physical_assembly_seconds = begin.elapsed().as_secs_f64();
        let mut solver = vec![0.; direct.nnz()];
        let begin = Instant::now();
        direct
            .jacobian
            .solver_values(model, &mut work, cj, &mut solver)
            .map_err(str::to_owned)?;
        let solver_assembly_seconds = begin.elapsed().as_secs_f64();
        budget(started)?;
        let weights = y
            .iter()
            .enumerate()
            .map(|(i, v)| absolute[i] + RTOL[0] * v.abs())
            .collect::<Vec<_>>();
        let mut solver_state = y.clone();
        coordinates.transform(&mut solver_state);
        let solver_weights = solver_state
            .iter()
            .enumerate()
            .map(|(i, v)| absolute[i] + RTOL[0] * v.abs())
            .collect::<Vec<_>>();
        let mut direction = weights
            .iter()
            .enumerate()
            .map(|(i, w)| ((i % 13) as f64 - 6.) / 7. * w)
            .collect::<Vec<_>>();
        // Signed directions span all physical families, including audit/energy
        // rows (every thirteenth entry is zero). This is not a state perturbation.
        let (physical_action, physical_scale) =
            action(n, direct.jacobian.pattern(), &physical, &direction);
        let begin = Instant::now();
        model
            .jvp_into(&direction, &mut work)
            .map_err(str::to_owned)?;
        let jvp_seconds = begin.elapsed().as_secs_f64();
        let tangent = work.rate_jvp().map_err(str::to_owned)?;
        let jvp_balance = model.conservation(tangent).map_err(str::to_owned)?;
        closure(
            jvp_balance.neutron_ledger_defect,
            tangent[..model.nc_dimension()]
                .iter()
                .map(|x| x.abs())
                .sum::<f64>()
                + tangent[model.ledger_row()].abs(),
            1e-10,
            "JVP number",
        )?;
        closure(
            jvp_balance.energy_ledger_defect_j,
            jvp_balance.energy_ledger_scale_j,
            256. * f64::EPSILON,
            "JVP selected energy",
        )?;
        let expected = direction
            .iter()
            .zip(tangent)
            .map(|(v, j)| cj * v - j)
            .collect::<Vec<_>>();
        let physical_action_error = action_error(&physical_action, &expected, &physical_scale)?;
        coordinates.transform(&mut direction);
        let (solver_action, solver_scale) =
            action(n, direct.jacobian.pattern(), &solver, &direction);
        let mut expected_solver = expected;
        coordinates.transform(&mut expected_solver);
        // Cancellation in the D row is scaled by the independently assembled
        // physical N/C and ledger terms, never by an assumed exactly-zero row.
        let mut scales = solver_scale.clone();
        scales[model.ledger_row()] += physical_scale[..model.nc_dimension()].iter().sum::<f64>()
            + physical_scale[model.ledger_row()];
        let solver_action_error = action_error(&solver_action, &expected_solver, &scales)?;
        println!(
            "{{\"kind\":\"direct-stage-matrix-proof\",\"case\":{},\"storedEntries\":{},\"physicalActionError\":{},\"signedDActionError\":{},\"RHSNumberDefect\":{},\"RHSGrossEventScale\":{},\"RHSEnergyDefectJ\":{},\"JVPNumberDefect\":{},\"JVPEnergyDefectJ\":{},\"physicalAssemblySeconds\":{},\"solverAssemblySeconds\":{},\"elapsedSeconds\":{}}}",
            quote(case),
            direct.nnz(),
            finite(physical_action_error),
            finite(solver_action_error),
            finite(rhs_balance.neutron_ledger_defect),
            finite(diagnostics.neutron_event_scale_s),
            finite(rhs_balance.energy_ledger_defect_j),
            finite(jvp_balance.neutron_ledger_defect),
            finite(jvp_balance.energy_ledger_defect_j),
            finite(physical_assembly_seconds),
            finite(solver_assembly_seconds),
            finite(started.elapsed().as_secs_f64())
        );
        io::stdout().flush().map_err(|e| e.to_string())?;
        phase(&format!("{case}-nine-block-factor"), "enter", 1, cj, None)?;
        let begin = Instant::now();
        preconditioner.setup(&solver)?;
        let factor_seconds = begin.elapsed().as_secs_f64();
        phase(
            &format!("{case}-nine-block-factor"),
            "exit",
            1,
            cj,
            Some(factor_seconds),
        )?;
        budget(started)?;
        let inverse_weights = solver_weights.iter().map(|w| 1. / w).collect::<Vec<_>>();
        let scaling = resources.vector(&inverse_weights)?;
        let mut linear = Box::new(AuditLinear {
            pattern: direct.jacobian.pattern(),
            entries: &solver,
            preconditioner: &mut preconditioner,
            n,
            error: None,
        });
        let user = (&mut *linear as *mut AuditLinear<'_>).cast();
        checked(
            unsafe { SUNLinSolSetATimes(resources.solver, user, audit_atimes) },
            "standalone exact CSC ATimes",
        )?;
        checked(
            unsafe { SUNLinSolSetPreconditioner(resources.solver, user, None, audit_psolve) },
            "standalone nine-block Psolve",
        )?;
        checked(
            unsafe { SUNLinSolSetScalingVectors(resources.solver, scaling, scaling) },
            "standalone solver-coordinate scaling",
        )?;
        checked(
            unsafe { SUNLinSolInitialize(resources.solver) },
            "standalone SPGMR initialize",
        )?;
        let mut solves = Vec::new();
        let mut solver_slopes = yp.clone();
        coordinates.transform(&mut solver_slopes);
        let mut actual_rhs = vec![0.; n];
        fill_solver_residual(coordinates, &rates, &solver_slopes, &mut actual_rhs)?;
        for v in &mut actual_rhs {
            *v = -*v;
        }
        // Manufactured correction is signed in the actual solver weights,
        // including small signed-D weight, not a transformed physical stock.
        let known = solver_weights
            .iter()
            .enumerate()
            .map(|(i, w)| ((i % 13) as f64 - 6.) / 7. * w)
            .collect::<Vec<_>>();
        let manufactured = action(n, direct.jacobian.pattern(), &solver, &known).0;
        for (kind, b, known) in [
            ("manufactured-signed-weighted", manufactured, Some(&known)),
            ("actual-negative-residual", actual_rhs, None),
        ] {
            let rhs = resources.vector(&b)?;
            let scaled_norm =
                scaled_preconditioned_norm(linear.preconditioner, &b, &solver_weights)?;
            let tolerance = ida_linear_tolerance(n);
            if !tolerance.is_finite() {
                return Err("Nonfinite standalone Krylov tolerance".into());
            }
            unsafe { output(zero, n) }?.fill(0.);
            checked(
                unsafe { SUNLinSolSetZeroGuess(resources.solver, 1) },
                "standalone zero initial guess",
            )?;
            phase(&format!("{case}-{kind}-solve"), "enter", 1, cj, None)?;
            let begin = Instant::now();
            let status =
                unsafe { SUNLinSolSolve(resources.solver, ptr::null_mut(), zero, rhs, tolerance) };
            let seconds = begin.elapsed().as_secs_f64();
            let iterations = unsafe { SUNLinSolNumIters(resources.solver) };
            let residual_norm = unsafe { SUNLinSolResNorm(resources.solver) };
            println!(
                "{{\"kind\":\"stage-krylov-result\",\"case\":{},\"rhsKind\":{},\"status\":{status},\"seconds\":{},\"KrylovIterations\":{iterations},\"KrylovResidualNorm\":{},\"scaledPreconditionedRHSNorm\":{},\"standaloneTolerance\":{},\"preconditioner\":{}}}",
                quote(case),
                quote(kind),
                finite(seconds),
                finite(residual_norm),
                finite(scaled_norm),
                finite(tolerance),
                linear.preconditioner.metrics_json()
            );
            io::stdout().flush().map_err(|e| e.to_string())?;
            phase(
                &format!("{case}-{kind}-solve"),
                if status == 0 { "exit" } else { "failure" },
                1,
                cj,
                Some(seconds),
            )?;
            let x = unsafe { values(zero, n) }?;
            let (ax, scale) = action(n, direct.jacobian.pattern(), &solver, x);
            let backward = backward_error(&ax, &b, &scale)?;
            // Independently reconstruct the full physical JVP residual, not
            // only the same compiled matrix used by the Krylov operator.
            let mut physical_x = x.to_vec();
            coordinates.transform(&mut physical_x);
            model
                .jvp_into(&physical_x, &mut work)
                .map_err(str::to_owned)?;
            let tangent = work.rate_jvp().map_err(str::to_owned)?;
            let mut independent = physical_x
                .iter()
                .zip(tangent)
                .map(|(x, j)| cj * x - j)
                .collect::<Vec<_>>();
            independent[model.ledger_row()] = cj * x[model.ledger_row()]
                - (tangent[..model.nc_dimension()].iter().sum::<f64>()
                    - tangent[model.ledger_row()]);
            let mut independent_scale = scale.clone();
            independent_scale[model.ledger_row()] +=
                scale[..model.nc_dimension()].iter().sum::<f64>();
            let independent_backward = backward_error(&independent, &b, &independent_scale)?;
            let true_residual = b
                .iter()
                .zip(&independent)
                .map(|(b, ax)| b - ax)
                .collect::<Vec<_>>();
            let independent_norm =
                scaled_preconditioned_norm(linear.preconditioner, &true_residual, &solver_weights)?;
            let forward = known
                .map(|known| forward_diagnostic(x, known, &solver_weights))
                .transpose()?;
            let residual_d = independent[model.ledger_row()] - b[model.ledger_row()];
            if iterations < 0 || !residual_norm.is_finite() {
                return Err("Invalid standalone Krylov statistics".into());
            }
            let result = format!(
                "{{\"kind\":{},\"seconds\":{},\"maximumComponentwiseBackwardError\":{},\"independentFullJVPBackwardError\":{},\"manufacturedMaximumWeightedForwardError\":{},\"correctionErrorsAreDiagnosticsOnly\":true,\"trueSolverDResidual\":{},\"KrylovIterations\":{iterations},\"KrylovResidualNorm\":{},\"independentScaledPreconditionedResidualNorm\":{},\"scaledPreconditionedRHSNorm\":{},\"standaloneTolerance\":{},\"status\":{status}}}",
                quote(kind),
                finite(seconds),
                finite(backward),
                finite(independent_backward),
                forward.map_or("null".into(), finite),
                finite(residual_d),
                finite(residual_norm),
                finite(independent_norm),
                finite(scaled_norm),
                finite(tolerance)
            );
            println!(
                "{{\"kind\":\"stage-independent-residual\",\"case\":{},\"result\":{result}}}",
                quote(case)
            );
            io::stdout().flush().map_err(|e| e.to_string())?;
            solves.push(result);
            if status != 0 || linear.error.is_some() || independent_norm > tolerance {
                return Err(format!(
                    "Standalone IDA-default linear contract failed: status={status}, independent norm={independent_norm:e}, delta={tolerance:e}, callback={:?}",
                    linear.error
                ));
            }
            budget(started)?;
        }
        let balance = model.conservation(&y).map_err(str::to_owned)?;
        println!(
            "{{\"kind\":\"direct-stage-audit-case\",\"case\":{},\"stateTime\":{},\"cj\":{},\"coordinates\":{n},\"storedEntries\":{},\"patternSeconds\":{},\"RHSSeconds\":{},\"physicalAssemblySeconds\":{},\"solverAssemblySeconds\":{},\"fullJVPSeconds\":{},\"physicalActionError\":{},\"signedDActionError\":{},\"factorSeconds\":{},\"preconditioner\":{},\"retainedNumberDefectNotRepaired\":{},\"solves\":[{}],\"elapsedSeconds\":{}}}",
            quote(case),
            finite(if case == "original" { 0. } else { time }),
            finite(cj),
            direct.nnz(),
            finite(pattern_seconds),
            finite(rhs_seconds),
            finite(physical_assembly_seconds),
            finite(solver_assembly_seconds),
            finite(jvp_seconds),
            finite(physical_action_error),
            finite(solver_action_error),
            finite(factor_seconds),
            linear.preconditioner.metrics_json(),
            finite(balance.neutron_ledger_defect),
            solves.join(","),
            finite(started.elapsed().as_secs_f64())
        );
        io::stdout().flush().map_err(|e| e.to_string())?;
    }
    budget(started)?;
    println!(
        "{{\"kind\":\"direct-stage-audit-final\",\"passed\":true,\"noAdvancement\":true,\"accuracyPolicy\":\"source-consequences-1\",\"provisional\":true,\"absoluteToleranceArm\":\"normal-policy-vector\",\"scope\":\"same-law complete physical/signed-D CSC actions and IDA-default fixed-state linear-norm proof;not-nonlinear-LTE-output-duration-or-performance-qualification\",\"linearSettings\":{{\"maxl\":30,\"restarts\":0,\"preconditioning\":\"left\",\"scalings\":\"both inverse solver-coordinate weights\",\"initialGuess\":\"zero\",\"standaloneTolerance\":\"sqrt(n)*0.05*0.33;pinned-IDA-7.5-default\"}},\"gates\":{{\"actionRelative\":1e-10,\"stockStatusSuccess\":true,\"independentFullJVPScaledPreconditionedNormWithinDelta\":true,\"backwardAndManufacturedForwardErrors\":\"finite-diagnostics-only\",\"RHSNumberGrossRelative\":1e-10,\"JVPNumberActionRelative\":1e-10,\"selectedEnergyRoundoffMultiples\":256}},\"allowanceSeconds\":30,\"elapsedSeconds\":{}}}",
        finite(started.elapsed().as_secs_f64())
    );
    io::stdout().flush().map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "../../tests/source_evolution.rs"]
pub(super) mod fixture;
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_chart_is_explicit_and_never_accepts_old_capture_decay_chart() {
        let model = Evolution::new(fixture::input()).unwrap();
        let y = model.initial_state();
        let mut bytes = CHECKPOINT_MAGIC.to_vec();
        bytes.extend_from_slice(&(y.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&0f64.to_le_bytes());
        bytes.extend_from_slice(&RTOL[0].to_le_bytes());
        for &v in y.iter().chain(&vec![0.; y.len()]) {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(retained_bytes(&model, &bytes).unwrap().1, y);
        bytes[..9].copy_from_slice(b"LDSOURCE1");
        assert!(retained_bytes(&model, &bytes).is_err());
        assert!(retained_bytes(&model, &bytes[..8]).is_err());
    }

    #[test]
    fn structural_scc_separates_feedback_and_feed_forward_components() {
        let (labels, mut sizes) =
            components(6, &[(0, 1), (1, 0), (2, 1), (3, 2), (3, 4), (4, 3)]).unwrap();
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[3], labels[4]);
        assert_ne!(labels[1], labels[2]);
        assert_ne!(labels[2], labels[3]);
        assert_ne!(labels[5], labels[0]);
        sizes.sort_unstable();
        assert_eq!(sizes, [1, 1, 2, 2]);
        assert!(components(2, &[(2, 0)]).is_err());
        let model = Evolution::new(fixture::input()).unwrap();
        assert_eq!(family(&model, 0), 0);
        assert_eq!(
            family(&model, model.region_count() * fuel_source::GROUPS),
            1
        );
        assert_eq!(family(&model, model.cf_row()), 4);
        assert_eq!(family(&model, model.water_row(0, false)), 5);
        assert_eq!(family(&model, model.target_row(0)), 6);
        assert_eq!(family(&model, model.mn_product_row(0)), 7);
        assert_eq!(family(&model, model.ledger_row()), 8);
        let direct = Stage::new(&model).unwrap();
        let report = structure_json(&model, direct.jacobian.pattern()).unwrap();
        for name in FAMILIES {
            assert!(report.contains(name));
        }
        assert!(report.contains("not-factor-fill"));
    }

    #[test]
    fn production_chain_jvp_matches_independent_csc_with_frozen_p_and_changed_material() {
        let model = Evolution::new(fixture::input()).unwrap();
        let n = model.state_count();
        let coordinates = Coordinates {
            nc: model.nc_dimension(),
            ledger: model.ledger_row(),
        };
        let mut state = model.initial_state();
        let mut work = model.workspace();
        model.evaluate_into(&state, &mut work).unwrap();
        let mut slopes = work.rates().unwrap().to_vec();
        coordinates.transform(&mut state);
        coordinates.transform(&mut slopes);
        let mut callbacks = Callbacks::new(&model, work, Instant::now(), 30.).unwrap();
        callbacks.stage = Some(Stage::new(&model).unwrap());
        let mut resources = Resources::new().unwrap();
        let y = resources.vector(&state).unwrap();
        let yp = resources.vector(&slopes).unwrap();
        let r = resources.vector(&vec![0.; n]).unwrap();
        let direction = (0..n)
            .map(|i| ((i % 11) as f64 - 5.) * 0.01)
            .collect::<Vec<_>>();
        let v = resources.vector(&direction).unwrap();
        let jv = resources.vector(&vec![0.; n]).unwrap();
        let user = (&mut callbacks as *mut Callbacks<'_>).cast();
        for cj in [17., 93.] {
            assert_eq!(
                unsafe { jtsetup(0., y, yp, r, cj, user) },
                0,
                "{:?}",
                callbacks.error
            );
            callbacks
                .stage
                .as_mut()
                .unwrap()
                .assemble(&model, &mut callbacks.work, cj)
                .unwrap();
            assert_eq!(unsafe { jtimes(0., y, yp, r, v, jv, cj, user, r, r) }, 0);
            let direct = callbacks.stage.as_ref().unwrap();
            let (actual, mut scale) =
                action(n, direct.jacobian.pattern(), &direct.entries, &direction);
            // D independently subtracts the NC and event terms, whose small
            // cancellation defect need not be bitwise zero.
            scale[model.ledger_row()] += scale[..model.nc_dimension()].iter().sum::<f64>();
            action_error(&actual, unsafe { values(jv, n) }.unwrap(), &scale).unwrap();
            let mut compiled = vec![0.; n];
            direct.multiply(cj, &direction, &mut compiled).unwrap();
            action_error(&compiled, unsafe { values(jv, n) }.unwrap(), &scale).unwrap();
        }
        assert_eq!(callbacks.stage.as_ref().unwrap().attempts, 2);
        // A changed material state at unchanged cj must refresh the outer J
        // even while an independently prepared P remains frozen.
        assert_eq!(unsafe { block_setup(0., y, yp, r, 93., user) }, 0);
        let rhs = vec![0.01; n];
        let mut p_before = vec![0.; n];
        callbacks
            .stage
            .as_mut()
            .unwrap()
            .solve_preconditioner(&rhs, &mut p_before)
            .unwrap();
        let old_entries = callbacks.stage.as_ref().unwrap().entries.clone();
        unsafe { output(y, n) }.unwrap()[model.target_row(0)] = 0.1;
        assert_eq!(unsafe { jtsetup(0., y, yp, r, 93., user) }, 0);
        callbacks
            .stage
            .as_mut()
            .unwrap()
            .assemble(&model, &mut callbacks.work, 93.)
            .unwrap();
        assert_ne!(old_entries, callbacks.stage.as_ref().unwrap().entries);
        let mut p_after = vec![0.; n];
        callbacks
            .stage
            .as_mut()
            .unwrap()
            .solve_preconditioner(&rhs, &mut p_after)
            .unwrap();
        assert_eq!(p_before, p_after);
        let mut compiled = vec![0.; n];
        callbacks
            .stage
            .as_ref()
            .unwrap()
            .multiply(93., &direction, &mut compiled)
            .unwrap();
        assert_eq!(unsafe { jtimes(0., y, yp, r, v, jv, 93., user, r, r) }, 0);
        let (_, mut scale) = action(
            n,
            callbacks.stage.as_ref().unwrap().jacobian.pattern(),
            &callbacks.stage.as_ref().unwrap().entries,
            &direction,
        );
        scale[model.ledger_row()] += scale[..model.nc_dimension()].iter().sum::<f64>();
        action_error(&compiled, unsafe { values(jv, n) }.unwrap(), &scale).unwrap();
        assert!(
            callbacks
                .stage
                .as_ref()
                .unwrap()
                .multiply(94., &direction, &mut compiled)
                .is_err()
        );
    }

    #[test]
    fn standalone_original_fixture_meets_independent_ida_default_linear_norm() {
        let model = Evolution::new(fixture::input()).unwrap();
        let n = model.state_count();
        let physical = model.initial_state();
        let mut work = model.workspace();
        model.evaluate_into(&physical, &mut work).unwrap();
        let mut direct = Stage::new(&model).unwrap();
        direct.assemble(&model, &mut work, 17.).unwrap();
        direct.setup_preconditioner(&model, &physical, 17.).unwrap();
        let frozen_rhs = vec![0.01; n];
        let mut before = vec![0.; n];
        direct
            .solve_preconditioner(&frozen_rhs, &mut before)
            .unwrap();
        // Refreshing the outer stage cannot silently refresh/overwrite P.
        direct.assemble(&model, &mut work, 93.).unwrap();
        let mut after = vec![0.; n];
        direct
            .solve_preconditioner(&frozen_rhs, &mut after)
            .unwrap();
        assert_eq!(before, after);
        direct.setup_preconditioner(&model, &physical, 93.).unwrap();
        let policy =
            Accuracy::new(&model, &vec![[0.; 2]; model.target_reference_atoms().len()]).unwrap();
        let weights = policy.absolute(1.).unwrap();
        let known = weights
            .iter()
            .enumerate()
            .map(|(i, w)| ((i % 13) as f64 - 6.) / 7. * w)
            .collect::<Vec<_>>();
        let b = action(n, direct.jacobian.pattern(), &direct.entries, &known).0;
        let mut p = direct.p.take().unwrap();
        let mut resources = Resources::new().unwrap();
        let x = resources.vector(&vec![0.; n]).unwrap();
        let rhs = resources.vector(&b).unwrap();
        let scaling = resources
            .vector(&weights.iter().map(|w| 1. / w).collect::<Vec<_>>())
            .unwrap();
        resources.spgmr(x, 30, 0).unwrap();
        let mut linear = Box::new(AuditLinear {
            pattern: direct.jacobian.pattern(),
            entries: &direct.entries,
            preconditioner: &mut p,
            n,
            error: None,
        });
        let user = (&mut *linear as *mut AuditLinear<'_>).cast();
        checked(
            unsafe { SUNLinSolSetATimes(resources.solver, user, audit_atimes) },
            "test ATimes",
        )
        .unwrap();
        checked(
            unsafe { SUNLinSolSetPreconditioner(resources.solver, user, None, audit_psolve) },
            "test Psolve",
        )
        .unwrap();
        checked(
            unsafe { SUNLinSolSetScalingVectors(resources.solver, scaling, scaling) },
            "test scaling",
        )
        .unwrap();
        checked(
            unsafe { SUNLinSolInitialize(resources.solver) },
            "test initialize",
        )
        .unwrap();
        checked(
            unsafe { SUNLinSolSetZeroGuess(resources.solver, 1) },
            "test zero guess",
        )
        .unwrap();
        checked(
            unsafe {
                SUNLinSolSolve(
                    resources.solver,
                    ptr::null_mut(),
                    x,
                    rhs,
                    ida_linear_tolerance(n),
                )
            },
            "test SPGMR",
        )
        .unwrap();
        let solution = unsafe { values(x, n) }.unwrap();
        let coordinates = Coordinates {
            nc: model.nc_dimension(),
            ledger: model.ledger_row(),
        };
        let mut physical_x = solution.to_vec();
        coordinates.transform(&mut physical_x);
        model.jvp_into(&physical_x, &mut work).unwrap();
        let tangent = work.rate_jvp().unwrap();
        let mut ax = physical_x
            .iter()
            .zip(tangent)
            .map(|(x, j)| 93. * x - j)
            .collect::<Vec<_>>();
        ax[model.ledger_row()] = 93. * solution[model.ledger_row()]
            - (tangent[..model.nc_dimension()].iter().sum::<f64>() - tangent[model.ledger_row()]);
        let residual = b.iter().zip(&ax).map(|(b, ax)| b - ax).collect::<Vec<_>>();
        let norm = scaled_preconditioned_norm(linear.preconditioner, &residual, &weights).unwrap();
        assert!(norm <= ida_linear_tolerance(n), "independent norm={norm:e}");
        assert!(linear.error.is_none());
        forward_diagnostic(solution, &known, &weights).unwrap();
        let (_, scale) = action(n, direct.jacobian.pattern(), &direct.entries, solution);
        backward_error(&ax, &b, &scale).unwrap();
    }

    #[test]
    fn strict_csc_and_independent_action_audit() {
        let pattern = [(0, 0), (1, 0), (1, 1)];
        assert_eq!(csc(2, &pattern).unwrap(), (vec![0, 2, 3], vec![0, 1, 1]));
        assert!(csc(2, &[(0, 0), (0, 0)]).is_err());
        assert!(csc(2, &[(1, 1), (0, 0)]).is_err());
        assert!(csc(2, &[(2, 0)]).is_err());
        let (out, scale) = action(2, &pattern, &[2., 3., 4.], &[5., -2.]);
        assert_eq!(out, [10., 7.]);
        assert_eq!(scale, [10., 23.]);
        assert_eq!(action_error(&out, &[10., 7.], &scale).unwrap(), 0.);
        assert!(action_error(&out, &[10., 8.], &scale).is_err());
        assert!(action_error(&[f64::NAN], &[0.], &[1.]).is_err());
        assert!(forward_error(&[f64::NAN], &[0.], &[1.]).is_err());
        assert!(forward_error(&[1e-5], &[0.], &[1.]).is_err());
        assert_eq!(forward_diagnostic(&[1e-5], &[0.], &[1.]).unwrap(), 1e-5);
        assert!(backward_error(&[f64::NAN], &[0.], &[1.]).is_err());
        assert!(backward_error(&[10.], &[8.], &[10.]).unwrap() > 1e-10);
        assert!((ida_linear_tolerance(52966) - 3.7973666533533477).abs() < 1e-14);
        assert_eq!(forward_error(&[1e-7], &[0.], &[1.]).unwrap(), 1e-7);
        assert!(closure(f64::NAN, 1., 1e-10, "test").is_err());
    }
}

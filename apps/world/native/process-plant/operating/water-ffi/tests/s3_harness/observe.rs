//! The S3 case run's observation through the frame driver's gate
//! [`Observer`] hook (S3GATES):
//!
//! - **Rule I** (A4 with B1, r3.7) at every accepted stock step, as the
//!   wiki states B1's check ("on accepted states"): D3 (a)'s admission with
//!   each core region's coolant phase; the first refusal is the labelled
//!   exit. B1's label is decided structurally: the refused exit is exactly
//!   the error B1's own check ([`sf::phase_absence`]) returns on the same
//!   phases, never by its text.
//! - **Gate observation** (a gate run only): on the declared observation
//!   grid (`ld01-s1-gates` `comparison.observation_s`) from the case's zero,
//!   the account's identities at every sample and on both sides of every
//!   restart (S2's [`Conservation`]), the credited outputs (S2's
//!   [`Reader`], plus the generator's terminal power) from `credited_from`,
//!   and a bitwise fingerprint of the sampled trajectory (rule H); at the
//!   first accepted step reaching each output instant (`outputInterval_s`),
//!   the IDAS ledger closures (DR-P3-GATE-1) and the ELEC slice's energy
//!   ledger in its first-order local tolerance unit; the idle rotors'
//!   angular momenta for C3's directions.
//!
//! Sampling reads stock dense output between steps, so it changes no step.
use crate::{compare::Credited, conservation::Conservation, outputs::Reader};
use leitbild_operating_plant::{
    joined::{
        account::{Held, Plan},
        operator::Joined,
        post_trip_domain::{self, Domain, Error, Extension},
    },
    source_feedback as sf,
};
use leitbild_operating_water::{
    If97,
    electrical::Electrified,
    frame::{Observer, Side},
    joined::JoinedSystem,
};
use serde_json::{Value, json};

/// Rule I's record: accepted states judged, the first extended state,
/// margin failures and the first exit with its label.
#[derive(Default, Debug)]
pub struct RuleI {
    pub samples: u64,
    pub first_extended: Option<f64>,
    pub margin_failures: u64,
    pub exit: Option<Value>,
    /// COST2: FNV-1a (over 64-bit words) of every judgment's full result, bit for bit: the
    /// state's time and region phases, then the admission (domain, margin
    /// holds, pivots, operator, reactivity gains, water terms) or the
    /// unsupported exit (domain, margin holds, exit): verdict equality
    /// across builds is equality of this fingerprint and of `samples`.
    pub verdicts: Fingerprint,
    /// COST2: accepted states judged on the root call's value evaluation of
    /// the same state ([`Joined::holds_value_evaluation`]) instead of a new one.
    pub reused: u64,
    /// COST2 cross-check (`LD01_S3_RULE_I_CROSSCHECK=1`): every reusable
    /// state is evaluated anyway and rule I's inputs on the held evaluation
    /// (nuclear feedback inputs, rods' travel, region phases) are compared
    /// bit for bit with the new one's; `mismatches` counts differences.
    pub crosscheck: Option<bool>,
    pub crosschecked: u64,
    pub mismatches: u64,
    pub first_mismatch: Option<Value>,
}

/// COST2: rule I's inputs as bits (the nuclear block's feedback inputs, the
/// rods' achieved travel, every joined row's value and each core region's
/// phase), for the cross-check.
fn rule_i_inputs(joined: &Joined<If97>) -> Result<Vec<u64>, String> {
    let f = joined.nuclear().feedback_inputs();
    let mut bits: Vec<u64> = [
        &f.neutrons,
        &f.fuel_temperature_k,
        &f.water_density_kg_m3,
        &f.boron_ppm_eq,
        &f.pressure_pa,
        &f.moderator_temperature_k,
        &f.fissile_atoms,
        &f.xenon_atoms,
        &f.samarium_atoms,
        &f.capture_loss_change_m2,
    ]
    .into_iter()
    .flat_map(|v| v.iter().map(|x| x.to_bits()))
    .collect();
    bits.extend(joined.travel().iter().map(|x| x.value.to_bits()));
    // Every joined row's value of the same evaluation (a reader of the
    // accepted state's rows, e.g. an algebraic-residual record, sees them).
    bits.extend(joined.rows().iter().map(|x| x.value.to_bits()));
    for r in joined.region_phases().map_err(|e| format!("{e:?}"))? {
        bits.push(r.saturation_departure_k.to_bits());
        bits.push(r.vapor_kg.to_bits());
    }
    Ok(bits)
}

/// The label of a refused D3 (a) admission: B1's exit when `exit` is
/// exactly what B1's check returns on the same `phase` (structural: the
/// same error value, whatever its text), else D3 (a)'s by its margin.
pub fn exit_label(exit: &sf::Error, phase: &[sf::RegionPhase], margin_holds: bool) -> &'static str {
    if sf::phase_absence(phase).err().as_ref() == Some(exit) {
        "B1 phase-absence exit"
    } else if margin_holds {
        "D3 (a) source-domain exit"
    } else {
        "D3 (a) margin exit"
    }
}

impl RuleI {
    /// D3 (a) with B1 at one accepted state `(t, y, y')` of the operator.
    pub fn judge(
        &mut self,
        joined: &mut Joined<If97>,
        extension: &Extension,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(), String> {
        // COST2: the root call at this accepted state already evaluated it
        // (bitwise the same `(t, y, y')`, nothing evaluated since): judge on
        // that evaluation; otherwise evaluate the state, as before.
        let crosscheck = *self.crosscheck.get_or_insert_with(|| {
            std::env::var("LD01_S3_RULE_I_CROSSCHECK").is_ok_and(|v| v == "1")
        });
        let held = joined.holds_value_evaluation(t, y, yp);
        let before = if held && crosscheck {
            Some(rule_i_inputs(joined)?)
        } else {
            None
        };
        if held && !crosscheck {
            self.reused += 1;
        } else {
            joined
                .evaluate(t, y, yp, None, 0., None)
                .map_err(|e| format!("rule I: the operator at {t} s: {e:?}"))?;
        }
        if let Some(before) = before {
            self.crosschecked += 1;
            let after = rule_i_inputs(joined)?;
            if before != after {
                self.mismatches += 1;
                if self.first_mismatch.is_none() {
                    let k = before.iter().zip(&after).position(|(a, b)| a != b);
                    self.first_mismatch = Some(json!({"t_s": t, "index": k, "lengths": [before.len(), after.len()]}));
                }
            }
        }
        self.samples += 1;
        let phase = joined
            .region_phases()
            .map_err(|e| format!("rule I: region phases at {t} s: {e:?}"))?;
        let admitted = post_trip_domain::admit_accepted(
            joined.nuclear(),
            &phase,
            extension,
            joined.travel(),
            t,
            0.,
        );
        self.verdicts.fold_words(&[t]);
        for r in &phase {
            self.verdicts.fold_words(&[r.saturation_departure_k, r.vapor_kg]);
        }
        match &admitted {
            Ok(a) => {
                let m = &a.margin;
                self.verdicts.fold_words(&[1., f64::from(u8::from(a.domain == Domain::Original)), f64::from(u8::from(m.holds))]);
                for v in [&m.pivots, &m.operator, &m.reactivity_gain, &m.water_terms] {
                    self.verdicts.fold_words(&[v.len() as f64]);
                    self.verdicts.fold_words(v);
                }
            }
            Err(e) => {
                self.verdicts.fold_words(&[2.]);
                for b in format!("{e:?}").bytes() {
                    self.verdicts.fold_words(&[f64::from(b)]);
                }
            }
        }
        let (label, verdict) = match admitted {
            Ok(a) => {
                self.margin_failures += u64::from(!a.margin.holds);
                if a.domain != Domain::Original && self.first_extended.is_none() {
                    self.first_extended = Some(t);
                }
                (
                    None,
                    format!("admitted {:?}, margin holds {}", a.domain, a.margin.holds),
                )
            }
            Err(Error::Unsupported {
                margin_holds, exit, ..
            }) => (
                Some(exit_label(&exit, &phase, margin_holds)),
                format!("unsupported: margin holds {margin_holds}, {exit:?}"),
            ),
            Err(e) => return Err(format!("D3 (a) at {t} s: {e}")),
        };
        if self.exit.is_none()
            && let Some(label) = label
        {
            self.exit = Some(json!({"t_s": t, "label": label, "verdict": verdict,
                "evaluated_on": "accepted stock steps"}));
        }
        Ok(())
    }
}

/// FNV-1a over IEEE bits, folded sample by sample (rule H's fingerprint).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fingerprint(pub u64);
impl Default for Fingerprint {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}
impl Fingerprint {
    pub fn fold(&mut self, values: &[f64]) {
        for v in values {
            for b in v.to_bits().to_le_bytes() {
                self.0 ^= u64::from(b);
                self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
            }
        }
    }
    /// COST2: FNV-1a over whole 64-bit words (each value's IEEE bits), one
    /// multiply per value instead of eight: rule I's verdict fingerprint is
    /// folded at every accepted step, and S3-D46 counts it in the cost.
    pub fn fold_words(&mut self, values: &[f64]) {
        for v in values {
            self.0 ^= v.to_bits();
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    pub fn hex(self) -> String {
        format!("{:016x}", self.0)
    }
}

/// The ELEC slice's energy ledger (rule D's turbine/shaft work, generator
/// terminal energy, auxiliary draws and the Grid's signed receipt): the
/// stored energy's change against the integrated flows
/// ([`Slice::ledger_defect`](leitbild_operating_plant::electrical::slice::Slice::ledger_defect)),
/// in local tolerance units: the first-order change of the stored energy
/// over each coordinate's `rtol |y| + atol` (S2's unit for a linear stock,
/// taken through the stored energy's dependence on the coordinates).
#[derive(Clone, Debug)]
pub struct SliceLedger {
    pub e0: f64,
    pub deposits0: f64,
    pub atol: Vec<f64>,
    pub rtol: f64,
    pub worst: Option<Value>,
    pub worst_units: f64,
    pub closures: u64,
}

/// The first-order tolerance unit of a stored energy `e` at `y`.
pub fn energy_unit(e: &dyn Fn(&[f64]) -> f64, y: &[f64], atol: &[f64], rtol: f64) -> f64 {
    let e0 = e(y);
    let mut z = y.to_vec();
    (0..y.len())
        .map(|i| {
            let tol = rtol * y[i].abs() + atol[i];
            z[i] = y[i] + tol;
            let d = (e(&z) - e0).abs();
            z[i] = y[i];
            d
        })
        .sum()
}

/// The direction (S3-D50) and SS-1 (S3-D51) signals beyond the credited
/// outputs, located by the packet's names.
#[derive(Clone, Debug, Default)]
pub struct Extra {
    /// Per loop (A, B): the hot-side leg cells (`HOT.A*`, `HOT.B*`) and the
    /// cold-leg cells (`COLD.A`, `COLD.B`), mass-weighted.
    pub hot: Vec<Vec<usize>>,
    pub cold: Vec<Vec<usize>>,
    /// The core outlet (UPPER) and inlet (LOWER) cells.
    pub upper: usize,
    pub lower: usize,
    /// C3's idle branch face (`PUMP.A1->COLD.A`), its chart's mass flow.
    pub idle_face: Option<usize>,
    /// Per SG, the account boundary indices of its steam and relief mass
    /// rates (the main-steam pickup's flow, S4-D10 b).
    pub steam: Vec<(usize, usize)>,
}

impl Extra {
    /// From the network packet's region and face names and the account's
    /// ledger names.
    pub fn of(
        regions: &[String],
        faces: &[String],
        ledger_names: &[String],
        sgs: &[String],
        idle_face: Option<&str>,
    ) -> Result<Self, String> {
        let cells = |p: &str| -> Vec<usize> {
            regions
                .iter()
                .enumerate()
                .filter(|(_, r)| r.starts_with(p))
                .map(|(i, _)| i)
                .collect()
        };
        let one = |id: &str| {
            regions
                .iter()
                .position(|r| r == id)
                .ok_or(format!("no region {id}"))
        };
        let hot = vec![cells("HOT.A"), cells("HOT.B")];
        let cold = vec![cells("COLD.A"), cells("COLD.B")];
        if hot.iter().chain(&cold).any(Vec::is_empty) {
            return Err("a loop has no HOT or COLD cell".into());
        }
        let idle_face = match idle_face {
            Some(f) => Some(
                faces
                    .iter()
                    .position(|x| x == f)
                    .ok_or(format!("no face {f}"))?,
            ),
            None => None,
        };
        let at = |k: String| {
            ledger_names
                .iter()
                .position(|n| *n == k)
                .ok_or(format!("no ledger {k}"))
        };
        let steam = sgs
            .iter()
            .map(|id| {
                Ok((
                    at(format!("SG.{id}.steam_kg"))?,
                    at(format!("SG.{id}.relief_kg"))?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            hot,
            cold,
            upper: one("UPPER")?,
            lower: one("LOWER")?,
            idle_face,
            steam,
        })
    }
}

/// A regular cell's temperature and mass per its phase mode (the credited
/// reader's rule, [`crate::outputs::cell_state`]).
fn cell_temperature(joined: &Joined<If97>, y: &[f64], c: usize) -> Result<(f64, f64), String> {
    // Per the cell's phase mode, as the credited outputs read it.
    crate::outputs::cell_temperature(&joined.network, y, c)
}

/// The mass-weighted mean temperature of `cells`.
fn weighted(joined: &Joined<If97>, y: &[f64], cells: &[usize]) -> Result<f64, String> {
    let (mut mt, mut m) = (0., 0.);
    for c in cells {
        let (t, mass) = cell_temperature(joined, y, *c)?;
        mt += mass * t;
        m += mass;
    }
    Ok(mt / m)
}

/// The extra signals at one sample (after the account's evaluation there).
fn extra_signals(
    x: &Extra,
    joined: &Joined<If97>,
    y: &[f64],
    n: usize,
    flows: Option<&(Vec<f64>, Vec<f64>)>,
) -> Result<Vec<(&'static str, Vec<f64>)>, String> {
    let (boundary, metal) = flows.ok_or("no account at this sample")?;
    let mut out = vec![
        (
            "hot_leg_k",
            x.hot
                .iter()
                .map(|c| weighted(joined, y, c))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        (
            "cold_leg_k",
            x.cold
                .iter()
                .map(|c| weighted(joined, y, c))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        (
            "core_outlet_k",
            vec![cell_temperature(joined, y, x.upper)?.0],
        ),
        (
            "core_inlet_k",
            vec![cell_temperature(joined, y, x.lower)?.0],
        ),
        // Leaving the secondary: the account's boundary enters positive.
        (
            "steam_flow_kg_s",
            x.steam
                .iter()
                .map(|(s, r)| -(boundary[*s] + boundary[*r]))
                .collect(),
        ),
        ("sg_metal_heat_w", metal.clone()),
        (
            "turbine_speed_rad_s",
            vec![y[n + leitbild_operating_plant::electrical::slice::OMEGA]],
        ),
    ];
    if let Some(f) = x.idle_face {
        let flow = joined
            .network
            .chart(f, 0)
            .map(|c| c.mass_flow_kg_s.value)
            .ok_or(format!("no chart on face {f}"))?;
        out.push(("idle_branch_kg_s", vec![flow]));
    }
    Ok(out)
}

/// The gate parts of the observation (a gate run only).
pub struct Gates {
    pub origin: f64,
    pub dt: f64,
    pub output_s: f64,
    pub credited_from: f64,
    pub reader: Reader,
    pub rods: bool,
    pub credited: Credited,
    pub credited_error: Option<String>,
    pub plan: Plan,
    pub ledger_atol: Vec<f64>,
    pub ledger_rtol: f64,
    pub conservation: Option<Conservation>,
    pub conservation_error: Option<String>,
    pub slice: SliceLedger,
    pub pending: Vec<f64>,
    pub fingerprint: Fingerprint,
    pub samples: u64,
    /// Every rotor's angular momentum at each output (C3's directions).
    pub rotors: Vec<(f64, Vec<f64>)>,
    /// The carried quadratures at the last closure: every named receipt
    /// (the joined ledgers, then the slice's), for the receipt.
    pub last_receipts: Option<(f64, Vec<f64>)>,
    /// The direction and SS-1 signals (recorded beside the credited ones).
    pub extra: Option<Extra>,
}

/// The run's observer: rule I always, the gate parts when asked.
pub struct CaseObserver {
    pub n: usize,
    pub extension: Extension,
    pub rule_i: RuleI,
    pub gates: Option<Gates>,
    /// The instructions its own calls retired (the cost family reports
    /// rule G without them, as the driver's `gate_s` CPU) ...
    pub instructions: u64,
    /// ... or why the counter could not be read.
    pub instructions_error: Option<String>,
    /// The largest |algebraic row| per row family over the accepted steps
    /// (a reported quantity in every S3 receipt; JACAGE's metric).
    pub residuals: AlgebraicResiduals,
    /// The run's relative tolerance, when N4′'s restart entries are taken
    /// (S3-D58, S3-D61).
    pub n4_rtol: Option<f64>,
    /// Each restart's pre-transaction entry (N4′): its consistency in the
    /// integrator's own units and, with a free vapour path, every free
    /// vapour path's drive tolerance at that state.
    pub entries: Vec<Value>,
    /// The integrator's absolute tolerances the driver handed at the
    /// current restart's left side: `(t, atol)` (S3-D67).
    pub units: Option<(f64, leitbild_operating_water::frame::IntegratorUnits)>,
}

/// The integrator's own tolerance unit `rtol |y| + atol` at `y` (S3-D61,
/// S3-D67): `atol` the vector stock was last given, derived classes
/// included ([`leitbild_operating_water::ida::Ida::absolute_tolerances`]).
pub fn integrator_unit(y: &[f64], atol: &[f64], rtol: f64) -> Result<Vec<f64>, String> {
    if atol.len() != y.len() {
        return Err("the integrator's tolerances are not the state's layout".into());
    }
    (0..y.len())
        .map(|i| {
            if atol[i].is_finite() && atol[i] > 0. {
                Ok(rtol * y[i].abs() + atol[i])
            } else {
                Err(format!("coordinate {i}: atol {} is not positive", atol[i]))
            }
        })
        .collect()
}

/// N4′'s drive tolerance (S3-D61) of each free vapour path at a restart's
/// pre-transaction state, by rule F's a_x construction at that state:
/// `sum_i |drive(y + atol_i e_i) - drive(y)|` over every joined coordinate
/// (`atol` the integrator's own, backward where the forward point refuses),
/// one joined value evaluation each; the slice's coordinates are not read
/// by a drive. `None` with no free vapour path (nothing can re-close).
pub fn free_vapour_drive_tolerances<J: JoinedSystem<Properties = If97>>(
    system: &mut Electrified<J>,
    t: f64,
    y: &[f64],
    yp: &[f64],
    n: usize,
    atol: &[f64],
) -> Result<Option<Value>, String> {
    use leitbild_operating_plant::network::unilateral::Lock;
    let free: Vec<(usize, usize, usize)> = {
        let net = &system.integrated().joined.network;
        let Some(locks) = net.unilateral() else {
            return Ok(None);
        };
        locks
            .paths
            .iter()
            .enumerate()
            .filter(|(li, lock)| net.face_layout[*li].phase == 1 && matches!(lock, Lock::Free))
            .map(|(li, _)| (li, net.face_layout[li].face, net.face_layout[li].phase))
            .collect()
    };
    if free.is_empty() {
        return Ok(None);
    }
    let started = (
        leitbild_operating_water::unit::clock::process_cpu_s(),
        super::counters::instructions(),
    );
    let drives = |system: &mut Electrified<J>, z: &[f64]| -> Result<Vec<f64>, String> {
        let joined = &mut system.integrated_mut().joined;
        joined
            .evaluate(t, &z[..n], &yp[..n], None, 0., None)
            .map_err(|e| format!("{e:?}"))?;
        Ok(free
            .iter()
            .map(|(_, f, k)| joined.network.face_drive(*f, *k).value)
            .collect())
    };
    let base = drives(system, y)?;
    let mut a = vec![0.; free.len()];
    let mut z = y.to_vec();
    let (mut refused, mut backward, mut first_refusal) = (0usize, 0usize, None);
    for i in 0..n {
        z[i] = y[i] + atol[i];
        let mut d = drives(system, &z);
        if d.is_err() {
            z[i] = y[i] - atol[i];
            d = drives(system, &z);
            backward += usize::from(d.is_ok());
        }
        match d {
            Ok(d) => {
                for (acc, (v, v0)) in a.iter_mut().zip(d.iter().zip(&base)) {
                    *acc += (v - v0).abs();
                }
            }
            Err(e) => {
                refused += 1;
                first_refusal.get_or_insert(format!("coordinate {i}: {e}"));
            }
        }
        z[i] = y[i];
    }
    // The operator's caches back at the judged state.
    drives(system, y)?;
    let instructions = match (started.1, super::counters::instructions()) {
        (Ok(a), Ok(b)) => json!(b.saturating_sub(a)),
        (Err(e), _) | (_, Err(e)) => json!({"error": e}),
    };
    Ok(Some(json!({
        "paths": free.iter().zip(base.iter().zip(&a)).map(|((li, f, k), (d, tol))| json!({"path": li, "face": f, "phase": k, "drive_pa": d, "tolerance_pa": tol})).collect::<Vec<_>>(),
        "coordinates": n, "taken_backward": backward, "refused": refused, "first_refusal": first_refusal,
        "judge_cpu_s": leitbild_operating_water::unit::clock::process_cpu_s() - started.0, "judge_instructions": instructions})))
}

/// N4′'s consistent state (S3-D58, JACAGE's units) at a restart's left
/// side `(t, y, y')`: the one-pass projection correction of the algebraic
/// rows, `J_aa δ = F_a` with `J = ∂F/∂y` (differential coordinates held),
/// each in its integrator tolerance unit `unit` (`rtol |y| + atol` as the
/// integrator uses it, [`integrator_unit`], S3-D61); the largest, its
/// coordinate and how many exceed one unit.
pub fn entry_consistency<S: leitbild_operating_water::ida::System + JoinedSystem>(
    system: &mut S,
    t: f64,
    y: &[f64],
    yp: &[f64],
    network_ids: &[f64],
    unit: &[f64],
) -> Result<Value, String> {
    use leitbild_operating_water::klu::SparseLu;
    let n = y.len();
    let mut f = vec![0.; n];
    system
        .residual(t, y, yp, &mut f)
        .map_err(|e| format!("residual: {e:?}"))?;
    let identity = system.differential_all(network_ids);
    let nnz = system.nonzeros();
    let (mut data, mut rows, mut pointers) = (vec![0.; nnz], vec![0i64; nnz], vec![0i64; n + 1]);
    system
        .jacobian(t, 0., y, yp, &mut data, &mut rows, &mut pointers)
        .map_err(|e| format!("Jacobian: {e:?}"))?;
    let alg: Vec<usize> = (0..n).filter(|i| identity[*i] == 0.).collect();
    let mut at = vec![usize::MAX; n];
    for (k, i) in alg.iter().enumerate() {
        at[*i] = k;
    }
    let (mut p2, mut r2, mut v2) = (vec![0i64], Vec::new(), Vec::new());
    for j in &alg {
        for p in pointers[*j] as usize..pointers[*j + 1] as usize {
            let i = rows[p] as usize;
            if at[i] != usize::MAX {
                r2.push(at[i] as i64);
                v2.push(data[p]);
            }
        }
        p2.push(r2.len() as i64);
    }
    let mut lu = SparseLu::analyze(alg.len(), &p2, &r2).map_err(|e| e.to_string())?;
    lu.factor(&v2).map_err(|e| e.to_string())?;
    let mut d: Vec<f64> = alg.iter().map(|i| f[*i]).collect();
    let max_row = d.iter().fold(0_f64, |m, v| m.max(v.abs()));
    lu.solve(&mut d).map_err(|e| e.to_string())?;
    let (mut worst, mut at_coordinate, mut over, mut squares) = (0_f64, None, 0usize, 0_f64);
    let mut largest: Vec<(f64, usize)> = Vec::with_capacity(alg.len());
    for (k, i) in alg.iter().enumerate() {
        let units = d[k].abs() / unit[*i];
        if units > 1. {
            over += 1;
        }
        if units.is_nan() || units > worst {
            worst = units;
            at_coordinate = Some(*i);
        }
        squares += units * units;
        largest.push((units, *i));
    }
    largest.sort_by(|a, b| b.0.total_cmp(&a.0));
    largest.truncate(5);
    // The solver's own acceptance measure: the WRMS norm of the correction
    // over every coordinate (zero on the differential ones), and over the
    // algebraic ones alone (S3-D67).
    Ok(
        json!({"t_s": t, "max_units": worst, "coordinate": at_coordinate, "rows_over_one_unit": over,
        "algebraic_rows": alg.len(), "max_abs_row": max_row,
        "wrms_all": (squares / n as f64).sqrt(), "wrms_algebraic": (squares / alg.len().max(1) as f64).sqrt(),
        "largest_units": largest.iter().map(|(u, i)| json!([i, u])).collect::<Vec<_>>()}),
    )
}

/// The largest |residual| of the algebraic rows, in solver row units (the
/// 1e-12 consistent-start bound's unit), per row family (`owner/class` of
/// the operator's layouts), over every accepted step at the solver's
/// state there; the identity is the one in force at that step.
#[derive(Default, Debug)]
pub struct AlgebraicResiduals {
    pub network_ids: Vec<f64>,
    /// Each operator coordinate's family.
    pub families: Vec<String>,
    /// COST2: the families' names in order, and each coordinate's index
    /// into them (built once, so a step clones and compares no names).
    names: Vec<String>,
    ids: Vec<usize>,
    /// family index -> (largest |row|, its time, its row, steps judged).
    worst: Vec<Option<(f64, f64, usize, u64)>>,
    /// The step that last counted each family (COST2: no per-step set).
    counted: Vec<u64>,
    step: u64,
}

impl AlgebraicResiduals {
    /// The families from the operator's layouts.
    pub fn of(joined: &Joined<If97>, network_ids: Vec<f64>) -> Self {
        let families: Vec<String> = joined
            .layouts()
            .into_iter()
            .flat_map(|(owner, l)| l.classes.into_iter().map(move |c| format!("{owner}/{c:?}")))
            .collect();
        let names: Vec<String> = families
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let ids = families
            .iter()
            .map(|f| names.binary_search(f).expect("a family of the layouts"))
            .collect();
        Self {
            network_ids,
            families,
            worst: vec![None; names.len()],
            counted: vec![0; names.len()],
            names,
            ids,
            step: 0,
        }
    }
    /// One accepted step, after the operator's evaluation there.
    pub fn record(&mut self, joined: &Joined<If97>, t: f64) {
        if self.families.is_empty() {
            return;
        }
        let identity = joined.differential(&self.network_ids);
        let rows = joined.rows();
        self.step += 1;
        for (i, (d, r)) in identity.iter().zip(rows).enumerate() {
            if *d != 0. {
                continue;
            }
            let f = self.ids[i];
            let v = r.value.abs();
            let e = self.worst[f].get_or_insert((-1., t, i, 0));
            if self.counted[f] != self.step {
                self.counted[f] = self.step;
                e.3 += 1;
            }
            if v.is_nan() || v > e.0 {
                e.0 = v;
                e.1 = t;
                e.2 = i;
            }
        }
    }
    pub fn json(&self) -> Value {
        let families: serde_json::Map<String, Value> = self
            .names
            .iter()
            .zip(&self.worst)
            .filter_map(|(k, w)| {
                w.map(|(v, t, i, n)| {
                    (
                        k.clone(),
                        json!({"max_abs_row": v, "at_t_s": t, "row": i, "steps": n}),
                    )
                })
            })
            .collect();
        json!({"metric": "largest |residual| of the algebraic rows (identity in force) in solver row units, per row family (owner/class of the operator's layouts), over every accepted stock step at the solver's state; reported only (JACAGE defines the metric; the appended ELEC slice's rows are not included)",
            "families": families})
    }
}

impl CaseObserver {
    fn count(&mut self, i0: Result<u64, String>) {
        match (i0, super::counters::instructions()) {
            (Ok(a), Ok(b)) => self.instructions += b.saturating_sub(a),
            (Err(e), _) | (_, Err(e)) => {
                self.instructions_error.get_or_insert(e);
            }
        }
    }
}

fn grid_after(origin: f64, dt: f64, t: f64) -> f64 {
    let mut k = ((t - origin) / dt).floor() + 1.;
    let mut s = origin + k * dt;
    while s <= t {
        k += 1.;
        s = origin + k * dt;
    }
    s
}

/// Whether `t` is an output instant of the grid `origin + k * output_s`.
pub fn on_output_grid(origin: f64, output_s: f64, t: f64) -> bool {
    let k = ((t - origin) / output_s).round();
    (origin + k * output_s - t).abs() <= 1e-9 * output_s.max(1.)
}

impl Gates {
    fn sample<J: JoinedSystem<Properties = If97>>(
        &mut self,
        system: &mut Electrified<J>,
        n: usize,
        t: f64,
        y: &[f64],
        yp: &[f64],
        side: Side,
    ) {
        let joined = &mut system.integrated_mut().joined;
        // The account's boundary and each SG's metal heat (for the extra
        // signals at this sample).
        let mut flows: Option<(Vec<f64>, Vec<f64>)> = None;
        match joined.account(&self.plan, t, &y[..n], &yp[..n]) {
            Ok(account) => {
                if let Some(c) = self.conservation.as_mut() {
                    c.sample(t, &account);
                    if side == Side::AfterRestart {
                        c.restarted(t);
                    }
                }
                let metal: Vec<f64> = account
                    .handovers
                    .iter()
                    .filter(|h| h.name.ends_with("metal_heat_handover"))
                    .filter_map(|h| {
                        h.terms
                            .iter()
                            .find(|(k, _)| k == "received by the secondary")
                            .map(|(_, v)| *v)
                    })
                    .collect();
                flows = Some((account.boundary.clone(), metal));
            }
            Err(e) => {
                self.conservation_error
                    .get_or_insert(format!("account at {t} s ({side:?}): {e:?}"));
            }
        }
        if side != Side::Step {
            return;
        }
        self.samples += 1;
        self.fingerprint.fold(&[t]);
        self.fingerprint.fold(y);
        self.fingerprint.fold(yp);
        if on_output_grid(self.origin, self.output_s, t) {
            self.pending.push(t);
            let net = &joined.network;
            let scales = net.scales();
            self.rotors.push((
                t,
                net.rotor_index.iter().map(|i| y[*i] * scales[*i]).collect(),
            ));
        }
        if t < self.credited_from - 1e-9 * self.dt || self.credited_error.is_some() {
            return;
        }
        // The account's evaluation at (t, y, y') serves the reader.
        let read = self.reader.read(joined, &y[..n], self.rods);
        let more = self
            .extra
            .as_ref()
            .map(|x| extra_signals(x, joined, y, n, flows.as_ref()));
        match read {
            Ok(mut outputs) => {
                outputs.push(("generator_power_w", vec![system.slice.export_w(&y[n..])]));
                // ELEC's heating-current equivalent LD01.TG.GEN.IEQ =
                // |i_dq| / sqrt(3) (the derived stator rows' definition).
                outputs.push((
                    "generator_ieq_a",
                    vec![y[n + 3].hypot(y[n + 4]) / 3f64.sqrt()],
                ));
                match more {
                    Some(Ok(mut extra)) => outputs.append(&mut extra),
                    Some(Err(e)) => {
                        self.credited_error = Some(format!("extra signals at {t} s: {e}"));
                        return;
                    }
                    None => {}
                }
                if let Err(e) = self.credited.push(t, &outputs) {
                    self.credited_error = Some(e);
                }
            }
            Err(e) => self.credited_error = Some(format!("credited outputs at {t} s: {e}")),
        }
    }

    fn accepted<J: JoinedSystem<Properties = If97>>(
        &mut self,
        system: &mut Electrified<J>,
        n: usize,
        t: f64,
        y: &[f64],
        q: &[f64],
    ) {
        let fuzz = 1e-14 * t.abs().max(1.);
        if !self.pending.iter().any(|o| *o <= t + fuzz) {
            return;
        }
        self.pending.retain(|o| *o > t + fuzz);
        self.last_receipts = Some((t, q.to_vec()));
        let ledgers = self.plan.ledger_names().len();
        if q.len() < ledgers {
            self.conservation_error
                .get_or_insert(format!("{} quadratures at {t} s: no IDAS ledgers", q.len()));
            return;
        }
        let joined = &system.integrated().joined;
        match self
            .plan
            .inventory(joined, &y[..n], &self.ledger_atol[..n], self.ledger_rtol)
        {
            Ok(held) => {
                if let Some(c) = self.conservation.as_mut() {
                    c.output(t, &held, &q[..ledgers]);
                }
            }
            Err(e) => {
                self.conservation_error
                    .get_or_insert(format!("inventory at {t} s: {e:?}"));
            }
        }
        let tail = &y[n..];
        let slice = &system.slice;
        let s = &mut self.slice;
        let defect =
            slice.ledger_defect(s.e0, tail, &q[ledgers..], system.mechanism_j - s.deposits0);
        let unit = energy_unit(&|z| slice.stored_energy(z), tail, &s.atol, s.rtol);
        let units = defect.abs() / unit;
        s.closures += 1;
        if units.is_nan() || units >= s.worst_units {
            s.worst_units = units;
            let throughput: f64 = q[ledgers..ledgers + 6].iter().map(|v| v.abs()).sum();
            s.worst = Some(
                json!({"t_s": t, "defect_j": defect, "unit_j": unit, "units": units,
                "throughput_j": throughput}),
            );
        }
    }
}

impl<J: JoinedSystem<Properties = If97>> Observer<Electrified<J>> for CaseObserver {
    fn next_after(&self, t: f64) -> Option<f64> {
        self.gates.as_ref().map(|g| grid_after(g.origin, g.dt, t))
    }
    fn integrator_units(
        &mut self,
        t: f64,
        units: leitbild_operating_water::frame::IntegratorUnits,
    ) {
        self.units = Some((t, units));
    }
    fn sample(
        &mut self,
        system: &mut Electrified<J>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        _q: &[f64],
        side: Side,
    ) -> Result<(), String> {
        let i0 = super::counters::instructions();
        // N4′: the restart's pre-transaction consistency in the integrator's
        // own units, and every free vapour path's drive tolerance there.
        if side == Side::BeforeRestart
            && let Some(rtol) = self.n4_rtol
        {
            let atol = match self.units.take() {
                Some((tu, atol)) if tu == t => Ok(atol),
                Some((tu, _)) => Err(format!("the integrator's tolerances are from {tu} s")),
                None => Err("the driver handed no integrator tolerances".into()),
            };
            let entry = atol
                .and_then(|atol| integrator_unit(y, &atol, rtol))
                .and_then(|unit| {
                    let mut e =
                        entry_consistency(system, t, y, yp, &self.residuals.network_ids, &unit)?;
                    let atol: Vec<f64> = unit
                        .iter()
                        .zip(y)
                        .map(|(u, v)| u - rtol * v.abs())
                        .collect();
                    e["drives"] =
                        match free_vapour_drive_tolerances(system, t, y, yp, self.n, &atol)? {
                            Some(d) => d,
                            None => json!("no free vapour path"),
                        };
                    Ok(e)
                });
            self.entries
                .push(entry.unwrap_or_else(|e| json!({"t_s": t, "error": e})));
        }
        // Rule I on the restart's consistent start too (S2 judged both
        // sides; a birth's exit is not taken a step late).
        if side == Side::AfterRestart {
            let n = self.n;
            self.rule_i.judge(
                &mut system.integrated_mut().joined,
                &self.extension,
                t,
                &y[..n],
                &yp[..n],
            )?;
        }
        if let Some(g) = self.gates.as_mut() {
            g.sample(system, self.n, t, y, yp, side);
        }
        self.count(i0);
        Ok(())
    }
    fn accepted(
        &mut self,
        system: &mut Electrified<J>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        q: &[f64],
    ) -> Result<(), String> {
        let i0 = super::counters::instructions();
        let n = self.n;
        self.rule_i.judge(
            &mut system.integrated_mut().joined,
            &self.extension,
            t,
            &y[..n],
            &yp[..n],
        )?;
        // Rule I evaluated the operator at this accepted state.
        self.residuals.record(&system.integrated().joined, t);
        if let Some(g) = self.gates.as_mut() {
            g.accepted(system, n, t, y, q);
        }
        self.count(i0);
        Ok(())
    }
}

/// The credited signals rule F reads (S3-D49): S2's credited outputs and
/// the generator's terminal power and Ieq.
pub const F_SIGNALS: [&str; 14] = [
    "core_power_w",
    "regional_fraction",
    "fuel_doppler_k",
    "core_cell_k",
    "average_coolant_k",
    "pzr_roof_pa",
    "pzr_level_m",
    "core_dp_pa",
    "loop_flow_kg_s",
    "sg_pressure_pa",
    "sg_liquid_m3",
    "rod_travel_m",
    "generator_power_w",
    "generator_ieq_a",
];

/// S3-D49's absolute class a_x of every F signal instance at `(t, y, y')`:
/// the first-order propagation sum_i |x(y + atol_i e_i) - x(y)| over every
/// coordinate, the operator's through one evaluation and the credited
/// reader each, the slice's through its own outputs. The operator is
/// evaluated at `(t, y, y')` again afterwards. Returns the classes by key
/// and a record (coordinates, refused evaluations).
#[allow(clippy::too_many_arguments)] // The gates, the unit, the state and the tolerances.
pub fn signal_tolerances<J: JoinedSystem<Properties = If97>>(
    g: &Gates,
    system: &mut Electrified<J>,
    t: f64,
    y: &[f64],
    yp: &[f64],
    n: usize,
    atol: &[f64],
) -> Result<(std::collections::BTreeMap<String, Vec<f64>>, Value), String> {
    let read =
        |system: &mut Electrified<J>, z: &[f64]| -> Result<Vec<(&'static str, Vec<f64>)>, String> {
            let joined = &mut system.integrated_mut().joined;
            joined
                .evaluate(t, &z[..n], &yp[..n], None, 0., None)
                .map_err(|e| format!("{e:?}"))?;
            let mut out = g.reader.read(joined, &z[..n], g.rods)?;
            out.push(("generator_power_w", vec![system.slice.export_w(&z[n..])]));
            out.push((
                "generator_ieq_a",
                vec![z[n + 3].hypot(z[n + 4]) / 3f64.sqrt()],
            ));
            Ok(out
                .into_iter()
                .filter(|(k, _)| F_SIGNALS.contains(k))
                .collect())
        };
    let base = read(system, y)?;
    let mut a: std::collections::BTreeMap<String, Vec<f64>> = base
        .iter()
        .map(|(k, v)| (k.to_string(), vec![0.; v.len()]))
        .collect();
    let mut z = y.to_vec();
    let mut refused = 0usize;
    let mut first_refusal: Option<String> = None;
    let mut backward = 0usize;
    for i in 0..y.len() {
        z[i] = y[i] + atol[i];
        // A coordinate whose forward perturbation leaves a property band
        // (an IF97 trial band at a phase boundary) is taken backward.
        let mut x = read(system, &z);
        if x.is_err() {
            z[i] = y[i] - atol[i];
            x = read(system, &z);
            backward += usize::from(x.is_ok());
        }
        match x {
            Ok(x) => {
                for ((k, v), (_, v0)) in x.iter().zip(&base) {
                    let acc = a.get_mut(*k).expect("same keys");
                    for (j, (p, q)) in v.iter().zip(v0).enumerate() {
                        acc[j] += (p - q).abs();
                    }
                }
            }
            Err(e) => {
                refused += 1;
                first_refusal.get_or_insert(format!("coordinate {i}: {e}"));
            }
        }
        z[i] = y[i];
    }
    // The operator's caches back at the start state.
    read(system, y)?;
    Ok((
        a,
        json!({"rule": "S3-D49: a_x = sum_i |x(y + atol_i e_i) - x(y)| over every coordinate (operator through one evaluation each, slice through its outputs), at the run's start state",
        "coordinates": y.len(), "taken_backward": backward, "refused": refused, "first_refusal": first_refusal}),
    ))
}

/// The start sample of a gate run (the consistent start, before any step).
pub fn start_sample<J: JoinedSystem<Properties = If97>>(
    observer: &mut CaseObserver,
    system: &mut Electrified<J>,
    t: f64,
    y: &[f64],
    yp: &[f64],
) {
    let n = observer.n;
    if let Some(g) = observer.gates.as_mut() {
        g.sample(system, n, t, y, yp, Side::Step);
    }
}

/// The held inventories at the start (the ledgers' reference).
pub fn held_at(
    plan: &Plan,
    joined: &Joined<If97>,
    y: &[f64],
    atol: &[f64],
    rtol: f64,
) -> Result<Vec<Held>, String> {
    plan.inventory(joined, y, atol, rtol)
        .map_err(|e| format!("inventory at the start: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_integrator_unit_is_rtol_y_plus_the_atol_stock_was_given() {
        // atol with a derived class at coordinate 1.
        let (rtol, atol, y) = (1e-5, [1e-8, 3e-12, 1e-6], [2.1, -0.4, 1.0]);
        let unit = integrator_unit(&y, &atol, rtol).unwrap();
        for i in 0..3 {
            assert_eq!(unit[i], rtol * f64::abs(y[i]) + atol[i]);
        }
        // A nonpositive atol, or another layout, refuses.
        assert!(integrator_unit(&y, &[1e-8, 0., 1e-6], rtol).is_err());
        assert!(integrator_unit(&y, &atol[..2], rtol).is_err());
    }

    #[test]
    fn the_b1_label_is_the_phase_checks_own_error_not_its_text() {
        let liquid = sf::RegionPhase {
            saturation_departure_k: -30.,
            vapor_kg: 0.,
        };
        // B1 as kinetics.md states it (S2-D42): vapour in the region's cell.
        let boiling = sf::RegionPhase {
            saturation_departure_k: 0.1,
            vapor_kg: 1e-3,
        };
        let phases = [liquid, boiling, liquid];
        // What B1's check returns on these phases is B1's exit.
        let b1 = sf::phase_absence(&phases).unwrap_err();
        assert_eq!(exit_label(&b1, &phases, true), "B1 phase-absence exit");
        assert_eq!(exit_label(&b1, &phases, false), "B1 phase-absence exit");
        // A feedback-domain exit is D3 (a)'s, labelled by its margin, even
        // when it names the same region.
        let d3 = sf::Error::OutsideDomain("moderator density", 1);
        assert_eq!(exit_label(&d3, &phases, false), "D3 (a) margin exit");
        assert_eq!(exit_label(&d3, &phases, true), "D3 (a) source-domain exit");
        // The same text for another region is not B1's error here.
        let other = sf::Error::OutsideDomain("phase absence", 2);
        assert_ne!(exit_label(&other, &phases, true), "B1 phase-absence exit");
        // With every region liquid, B1's check passes: no B1 label.
        assert_eq!(
            exit_label(&b1, &[liquid; 3], true),
            "D3 (a) source-domain exit"
        );
    }

    #[test]
    fn the_observation_grid_steps_strictly_and_marks_outputs() {
        let (origin, dt) = (500.05, 0.002);
        let a = grid_after(origin, dt, 500.05);
        assert!((a - 500.052).abs() < 1e-12 && a > 500.05);
        let b = grid_after(origin, dt, a);
        assert!(b > a && (b - a - dt).abs() < 1e-12);
        assert!(on_output_grid(origin, 0.1, 500.15000000000003));
        assert!(!on_output_grid(origin, 0.1, 500.152));
    }

    #[test]
    fn the_fingerprint_sees_every_bit() {
        let (mut a, mut b) = (Fingerprint::default(), Fingerprint::default());
        a.fold(&[1., 2.]);
        b.fold(&[1., 2.]);
        assert_eq!(a, b);
        b.fold(&[0.]);
        let mut c = a;
        c.fold(&[-0.]);
        assert_ne!(b, c, "0 and -0 differ bitwise");
    }

    #[test]
    fn the_energy_unit_is_the_first_order_change_over_each_tolerance() {
        // E = 0.5 J w^2 + C T: dE = J w tol_w + C tol_T to first order.
        let e = |z: &[f64]| 0.5 * 2. * z[0] * z[0] + 3. * z[1];
        let y = [10., 300.];
        let atol = [1e-6, 1e-4];
        let u = energy_unit(&e, &y, &atol, 1e-5);
        let tol_w = 1e-5 * 10. + 1e-6;
        let tol_t = 1e-5 * 300. + 1e-4;
        let expected = 2. * 10. * tol_w + 0.5 * 2. * tol_w * tol_w + 3. * tol_t;
        assert!((u - expected).abs() < 1e-9 * expected, "{u} {expected}");
    }
}

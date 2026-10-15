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
        joined
            .evaluate(t, y, yp, None, 0., None)
            .map_err(|e| format!("rule I: the operator at {t} s: {e:?}"))?;
        self.samples += 1;
        let phase = joined
            .region_phases()
            .map_err(|e| format!("rule I: region phases at {t} s: {e:?}"))?;
        let (label, verdict) = match post_trip_domain::admit_accepted(
            joined.nuclear(),
            &phase,
            extension,
            joined.travel(),
            t,
            0.,
        ) {
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
}

/// The run's observer: rule I always, the gate parts when asked.
pub struct CaseObserver {
    pub n: usize,
    pub extension: Extension,
    pub rule_i: RuleI,
    pub gates: Option<Gates>,
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
        match joined.account(&self.plan, t, &y[..n], &yp[..n]) {
            Ok(account) => {
                if let Some(c) = self.conservation.as_mut() {
                    c.sample(t, &account);
                    if side == Side::AfterRestart {
                        c.restarted(t);
                    }
                }
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
        match read {
            Ok(mut outputs) => {
                outputs.push(("generator_power_w", vec![system.slice.export_w(&y[n..])]));
                // ELEC's heating-current equivalent LD01.TG.GEN.IEQ =
                // |i_dq| / sqrt(3) (the derived stator rows' definition).
                outputs.push((
                    "generator_ieq_a",
                    vec![y[n + 3].hypot(y[n + 4]) / 3f64.sqrt()],
                ));
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
    fn sample(
        &mut self,
        system: &mut Electrified<J>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        _q: &[f64],
        side: Side,
    ) -> Result<(), String> {
        if let Some(g) = self.gates.as_mut() {
            g.sample(system, self.n, t, y, yp, side);
        }
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
        let n = self.n;
        self.rule_i.judge(
            &mut system.integrated_mut().joined,
            &self.extension,
            t,
            &y[..n],
            &yp[..n],
        )?;
        if let Some(g) = self.gates.as_mut() {
            g.accepted(system, n, t, y, q);
        }
        Ok(())
    }
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
    fn the_b1_label_is_the_phase_checks_own_error_not_its_text() {
        let liquid = sf::RegionPhase {
            saturation_departure_k: -30.,
            vapor_kg: 0.,
        };
        let boiling = sf::RegionPhase {
            saturation_departure_k: 0.1,
            vapor_kg: 0.,
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

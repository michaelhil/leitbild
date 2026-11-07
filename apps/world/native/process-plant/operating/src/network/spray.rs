//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressure-and-inventory.md#controlled-spray-material-path
//! The controlled-spray path inside the network (IC-CTRL, S3; lead decision
//! S3-D25): the valve as a quasi-steady restriction, its closure and its
//! inlet check as locks, and the stem's held trajectory.
//!
//! **Restriction (S3-D25 (1)).** The wiki realizes valve and nozzle
//! capacities as restriction relations at the line's faces. The open
//! valve's liquid path is therefore algebraic: its row is the capacity
//! relation of the valve area `x·CdA_full` under the path's own drive (the
//! pressure–gravity difference and the half line's wall friction),
//!
//! ```text
//! Q = x·CdA_full·sgn(Δp)·sqrt(2|Δp|/ρ)
//! ```
//!
//! scaled by the sizing flow. It holds for every opening, `x = 0`
//! included (zero capacity), so travel needs no infinite coefficient.
//!
//! **Closure (S3-D25 (2)).** While the stem rests closed both of the valve
//! face's phase paths are locked (`Π = 0`, the rest chart, L1's lock row);
//! opening from 0 releases them at the issue ([`Network::issue_spray`]) and
//! the stem's arrival at 0 sets them ([`Network::spray_event`], an owner
//! time event): both class R.
//!
//! **Inlet check (S3-D25 (3)).** The wiki selects one: "The healthy inlet
//! check prevents reverse transfer into COLD.A" and "This is a selected
//! ideal one-way check" (pressure-and-inventory.md, controlled-spray
//! material path; `ld01-pzr-spray-line` `inletCheck`). It is L1's unilateral
//! law on the valve face: a free path enters contact by root when its
//! impulse falls through zero (the forward flow ends; nothing to pay at
//! `Q = 0`), and the locked path is released by root when its forward drive
//! returns. Both are class R transactions.
//!
//! The distributor face (the tips) is never locked by the valve or the
//! check: the wiki keeps the tips bidirectional.
use super::{
    Failure, Network, PZR_COORDINATES, Properties, SprayLayout, stratified,
    unilateral::{End, Fired, Lock, Presence, decide},
};
use crate::{control::spray_valve::StemChange, thermal::Scalar};
use serde_json::{Value, json};

/// The composition's stages of the spray port's scoped L1
/// ([`Network::engage_spray_tip`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TipStage {
    /// The hydrostatic preparation: each path from free by the last value
    /// evaluation (the line at rest).
    Rest,
    /// Before the flowing preparation writes the hydraulic settle's volume
    /// flow `q[k]` into path `k`: each path from free by that flow (at
    /// rest, by the drive). A path the settle moved toward an end holding
    /// no phase locks and takes no current: that motion (the settle carries
    /// no L1) is not adopted, so nothing is paid.
    Adopted([f64; 2]),
    /// The composed state: each path from its held lock by the last value
    /// evaluation; a free path drawing from an empty end locks at rest, a
    /// held lock stays.
    Composed,
}

/// S3-D19: the spray path's discrete state: the stem's held trajectory and
/// the valve's and the inlet check's locks.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SprayState {
    pub stem: crate::control::spray_valve::Stem,
    pub closed: bool,
    pub check_closed: bool,
    /// The spray port's scoped L1 locks (DR-P3-SPRAY).
    pub tip: Option<[Lock; 2]>,
}

/// A disarmed root slot's constant value.
pub const DISARMED: f64 = 1.;

/// What the spray slot's root watches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckRoot {
    /// The valve is closed: no root.
    Disarmed,
    /// The check is open: the valve path's impulse, falling.
    Contact,
    /// The check is closed: the valve path's forward drive, rising.
    Release,
}

/// The valve's capacity with its direction (R4-PZR-SPRAY-LAMINAR, lead
/// 1 Nov: S4-D13's low-Reynolds branch). The passage's loss is the sum of a
/// laminar and the selected turbulent term on its effective area
/// `A = x·C` and equivalent bore `d = sqrt(4A/π)`:
///
/// ```text
/// Δp = a Q + b Q|Q|,  a = Re_t μ/(2 A d) = Re_t μ sqrt(π)/(4 A^1.5),  b = ρ/(2A²)
/// Q  = 2Δp/(a + sqrt(a² + 4b|Δp|)) = 2Δp A^1.5/(α + sqrt(α² + 2ρA|Δp|)),  α = Re_t μ sqrt(π)/4
/// ```
///
/// The right-hand form is finite at every opening: `Q = 0` at `x = 0` with
/// every partial zero (its own branch; `Q ∝ x^1.5` there), and the slope in
/// the drive is at most `1/a`, so the restriction row has no unbounded
/// slope at zero drive. Away from zero flow it is the turbulent
/// `x·C·sgn(Δp)·sqrt(2|Δp|/ρ)` to within the laminar share `Re_t/Re`. The
/// opening, drive, density and viscosity may all carry directions. An
/// opening below zero (a trial past the closing stem's root) takes the
/// odd extension `A sqrt(|A|)`.
pub(super) fn capacity(
    x: Scalar,
    c: f64,
    dp: Scalar,
    rho: Scalar,
    mu: Scalar,
    re_t: f64,
) -> Result<Scalar, Failure> {
    let (v, dv, r, dr, m, dm) = (
        dp.value,
        dp.direction,
        rho.value,
        rho.direction,
        mu.value,
        mu.direction,
    );
    if !(r.is_finite() && r > 0. && v.is_finite() && m.is_finite() && m > 0.)
        || !(re_t.is_finite() && re_t > 0. && c.is_finite() && c > 0.)
        || !(x.value.is_finite() && x.direction.is_finite() && dv.is_finite())
    {
        return Err(Failure::Recoverable(format!(
            "spray valve capacity at opening {}, differential {v} Pa, density {r}, viscosity {m}",
            x.value
        )));
    }
    // x = 0: its own branch, Q = 0 and every partial zero.
    if x.value == 0. {
        return Ok(Scalar::constant(0.));
    }
    let k = re_t * std::f64::consts::PI.sqrt() / 4.;
    let (a_v, da) = (x.value * c, x.direction * c);
    let root = a_v.abs().sqrt();
    let (p, dp_a) = (a_v * root, 1.5 * root * da);
    let (alpha, dalpha) = (k * m, k * dm);
    let u = v.abs();
    let sv = v.signum();
    let big = (alpha * alpha + 2. * r * a_v.abs() * u).sqrt();
    let dbig =
        (alpha * dalpha + dr * a_v.abs() * u + r * a_v.signum() * da * u + r * a_v.abs() * sv * dv)
            / big;
    let (den, dden) = (alpha + big, dalpha + dbig);
    let (num, dnum) = (2. * v * p, 2. * dv * p + 2. * v * dp_a);
    let q = num / den;
    Ok(Scalar::new(q, (dnum - q * dden) / den))
}

impl<P: Properties> Network<P> {
    /// The composed spray path, if any.
    pub fn spray(&self) -> Option<&SprayLayout> {
        self.spray.as_ref()
    }
    /// S3-D19: the composed spray path's discrete state.
    pub fn spray_discrete_state(&self) -> Option<SprayState> {
        self.spray.map(|s| SprayState {
            stem: s.stem,
            closed: s.closed,
            check_closed: s.check_closed,
            tip: s.tip,
        })
    }
    /// Restore [`Network::spray_discrete_state`] exactly: the same
    /// composition and stroke rate, refused otherwise.
    pub fn restore_spray_discrete_state(
        &mut self,
        state: Option<SprayState>,
    ) -> Result<(), Failure> {
        match (self.spray.as_mut(), state) {
            (None, None) => Ok(()),
            (Some(s), Some(v))
                if v.stem.strokes_per_second().to_bits()
                    == s.stem.strokes_per_second().to_bits() =>
            {
                s.stem = v.stem;
                s.closed = v.closed;
                s.check_closed = v.check_closed;
                s.tip = v.tip;
                Ok(())
            }
            _ => Err(Failure::Fatal(
                "snapshot: the spray path's composition or stroke rate differs".into(),
            )),
        }
    }
    /// Whether phase path `li` (face-layout index) is locked: by L1, or as
    /// the closed spray valve's or the closed inlet check's path.
    pub(super) fn path_locked(&self, li: usize) -> bool {
        self.unilateral_locked(li)
            || self.spray.is_some_and(|s| {
                (s.closed || s.check_closed) && self.face_layout[li].face == s.valve_face
            })
            || self.spray_tip_locked(li)
    }
    /// Whether phase path `li` is a spray-port path the scoped unilateral
    /// law holds locked (only while the network-wide L1 is not active; L1
    /// governs every path once it is).
    fn spray_tip_locked(&self, li: usize) -> bool {
        let l = self.face_layout[li];
        self.unilateral().is_none()
            && self.spray.is_some_and(|s| {
                l.face == s.port_face
                    && s.tip
                        .is_some_and(|tip| matches!(tip[l.phase], Lock::Locked(_)))
            })
    }
    /// Engage the spray port's scoped unilateral law (DR-P3-SPRAY; decision
    /// 0014's L1 on the port face's two phase paths), by `presence` (the
    /// line holds liquid; the port holds the vapor region's vapor and, with
    /// drops, liquid), at one of the composition's three stages
    /// ([`TipStage`]), every decision L1's [`decide`]. A path moving toward
    /// an end holding no phase at an evaluated state is refused, as L1's
    /// activation refuses. A network-wide L1 activation supersedes this law.
    pub fn engage_spray_tip(
        &mut self,
        presence: &Presence,
        stage: TipStage,
    ) -> Result<Option<Value>, Failure> {
        let Some(s) = self.spray else {
            return Ok(None);
        };
        let held = s.tip.unwrap_or([Lock::Free; 2]);
        let mut tip = [Lock::Free; 2];
        let mut views = Vec::new();
        for (k, lock) in tip.iter_mut().enumerate() {
            let li = 2 * s.port_face + k;
            let mut view = self.path_view(li, presence)?;
            let prior = match stage {
                TipStage::Rest => Lock::Free,
                TipStage::Adopted(q) => {
                    view.volume_flow_m3_s = q[k];
                    view.kinetic_j = 0.;
                    Lock::Free
                }
                TipStage::Composed => held[k],
            };
            let d = decide(prior, view, None)?;
            if !matches!(stage, TipStage::Adopted(_)) && d.payment.is_some() {
                return Err(Failure::Fatal(format!(
                    "spray port: face {} phase {k} carries {} m3/s toward an end holding no phase {k}",
                    s.port_face, view.volume_flow_m3_s
                )));
            }
            // At the composed state a held lock stays: the flowing
            // preparation balances the line on its port, so the drive there
            // is that construction's residue and the consistent start sets
            // the run's own; a release is the located root's or found at
            // the next transaction.
            let kept = matches!(stage, TipStage::Composed)
                && matches!(prior, Lock::Locked(_))
                && d.lock == Lock::Free;
            *lock = if kept { prior } else { d.lock };
            views.push(json!({"phase": k, "holding": format!("{:?}", view.holding),
                "drive_pa": view.drive_pa, "volume_flow_m3_s": view.volume_flow_m3_s,
                "adopted": !matches!(stage, TipStage::Adopted(_)) || d.payment.is_none(),
                "from": format!("{prior:?}"), "decided": format!("{:?}", d.lock),
                "lock": format!("{:?}", *lock)}));
        }
        if let Some(sp) = self.spray.as_mut() {
            sp.tip = Some(tip);
        }
        Ok(Some(
            json!({"owner": "spray port (scoped L1)", "stage": format!("{stage:?}"), "paths": views}),
        ))
    }
    /// The spray port's two root slots while the network-wide L1 is not
    /// active, as L1's: a free path's contact root (the drawing end's phase
    /// mass, falling) and a one-sided lock's release root (`orientation ×
    /// F`, rising); disarmed under L1 or with neither end holding. Release
    /// values read the last value evaluation of `y`.
    pub fn spray_tip_roots(&self, y: &[f64]) -> Result<[(f64, i32); 2], Failure> {
        let s = self
            .spray
            .ok_or_else(|| Failure::Fatal("no spray path is composed".into()))?;
        if self.unilateral().is_some() {
            return Ok([(DISARMED, 0); 2]);
        }
        let tip = s.tip.ok_or_else(|| {
            Failure::Fatal("the spray port's scoped L1 was never engaged (composition)".into())
        })?;
        let mut out = [(DISARMED, 0); 2];
        for (k, o) in out.iter_mut().enumerate() {
            let li = 2 * s.port_face + k;
            let l = self.face_layout[li];
            *o = match tip[k] {
                Lock::Free => {
                    let (from, to) = self.endpoints[l.face];
                    let pi = y[l.index];
                    let m = |c| self.end_mass(y, c, k);
                    let v = if pi > 0. {
                        m(from)
                    } else if pi < 0. {
                        m(to)
                    } else {
                        m(from).max(m(to))
                    };
                    (v, -1)
                }
                Lock::Locked(h) => match h.orientation() {
                    Some(o) => (o * self.face_drive[l.face][k].value, 1),
                    None => (DISARMED, 0),
                },
            };
        }
        Ok(out)
    }
    /// Whether a spray-port release root needs the drives of a value
    /// evaluation.
    pub fn spray_tip_reads_drive(&self) -> bool {
        self.unilateral().is_none()
            && self.spray.and_then(|s| s.tip).is_some_and(|tip| {
                tip.iter()
                    .any(|l| matches!(l, Lock::Locked(h) if h.orientation().is_some()))
            })
    }
    /// The spray port's scoped L1 transaction at a root-located instant
    /// (`directions` per path, IDAGetRootInfo), on the last value evaluation
    /// at `(t, y, 0)` and `presence`: as L1's own, every port path through
    /// [`decide`], with its located root if it crossed in its watched
    /// direction (a crossing against it is reported), the others as found
    /// at the transaction; a contact sets `Π = 0` and pays the path's
    /// kinetic energy once into the receiving end (L1's payment). `None`
    /// when nothing changed or crossed.
    pub fn spray_tip_transaction(
        &mut self,
        t: f64,
        directions: [i32; 2],
        y: &mut [f64],
        presence: &Presence,
    ) -> Result<Option<Value>, Failure> {
        let Some(s) = self.spray else {
            return Ok(None);
        };
        if self.unilateral().is_some() {
            if directions != [0, 0] {
                return Err(Failure::Fatal(
                    "a spray-port slot crossed while L1 governs the port".into(),
                ));
            }
            return Ok(None);
        }
        let mut tip = s
            .tip
            .ok_or_else(|| Failure::Fatal("the spray port's scoped L1 was never engaged".into()))?;
        let mut changes = Vec::new();
        for (k, d) in directions.into_iter().enumerate() {
            let li = 2 * s.port_face + k;
            let l = self.face_layout[li];
            let fired = match (tip[k], d) {
                (_, 0) => None,
                (Lock::Free, -1) => Some(Fired::Contact),
                (Lock::Locked(_), 1) => Some(Fired::Release),
                _ => {
                    changes.push(json!({"phase": k, "direction": d, "opposite": true}));
                    None
                }
            };
            // A located contact drawing from the port's drop zone is the
            // drop stock's exhaustion: the zone's residue rains out first
            // (DR-P2-SPRAYDROP), as an owner's exhaustion precedes L1's lock;
            // a lock found at the transaction while drawing from the drops
            // exhausts them after the decision.
            let (_, to) = self.endpoints[l.face];
            let drawing_drops = k == 0 && to == s.port_cell && y[l.index] < 0.;
            let exhausted = if fired == Some(Fired::Contact) && drawing_drops {
                Some(self.exhaust_spray_drops(y)?)
            } else {
                None
            };
            let declared;
            let presence = if exhausted.is_some() {
                declared = self.declared_presence(y);
                &declared
            } else {
                presence
            };
            let view = self.path_view(li, presence)?;
            let decision = decide(tip[k], view, fired)?;
            if decision.cause.is_none() {
                continue;
            }
            let exhausted = match exhausted {
                None if drawing_drops
                    && matches!(tip[k], Lock::Free)
                    && matches!(decision.lock, Lock::Locked(_)) =>
                {
                    Some(self.exhaust_spray_drops(y)?)
                }
                e => e,
            };
            let mut paid = None;
            if let Some((end, energy)) = decision.payment {
                let (from, to) = self.endpoints[l.face];
                let receiver = if end == End::From { from } else { to };
                let index = self.payment_coordinate(receiver, k)?;
                y[index] += energy / self.scales[index];
                y[l.index] = 0.;
                paid = Some(json!({"cell": receiver, "coordinate": index, "energy_j": energy}));
            }
            changes.push(json!({"phase": k, "root": format!("{fired:?}"), "before": format!("{:?}", tip[k]),
                "after": format!("{:?}", decision.lock), "cause": format!("{:?}", decision.cause),
                "drive_pa": view.drive_pa, "volume_flow_m3_s": view.volume_flow_m3_s, "payment": paid,
                "drops_exhausted": exhausted}));
            tip[k] = decision.lock;
        }
        if let Some(sp) = self.spray.as_mut() {
            sp.tip = Some(tip);
        }
        Ok((!changes.is_empty())
            .then(|| json!({"owner": "spray port (scoped L1)", "t_s": t, "changes": changes})))
    }
    /// The port's drop zone exhausted where its liquid path locks drawing
    /// from it (DR-P2-SPRAYDROP): the contact root locates the drop mass's zero,
    /// where the drop stocks hold only the integration's residue (either
    /// sign; the drop tracer's need not lie within the restart's bound
    /// placement). No phase-mode owner exhausts the drop zone, so the
    /// port's transaction does: the residue goes where drops rain out, the
    /// resident liquid (mass and tracer as they are, energy at the
    /// interface's saturated liquid enthalpy, the drops' inventory energy),
    /// and both drop stocks become exactly zero. Mass, tracer and the
    /// inventory energy are conserved; the algebraic drop volume follows at
    /// the restart's projection. Returns the receipt.
    fn exhaust_spray_drops(&mut self, y: &mut [f64]) -> Result<Value, Failure> {
        use stratified::{DROP_BORON, DROP_MASS, RESIDENT_BORON, RESIDENT_ENERGY, RESIDENT_MASS};
        let base = self.pzr.base;
        let mut values = [0.; PZR_COORDINATES];
        for (v, i) in values.iter_mut().zip(self.pzr.coordinates()) {
            *v = y[i] * self.scales[i];
        }
        let x = stratified::Coordinates::values(&values);
        let column = self.stratified.column(&self.properties, &x, None)?;
        let hf = column.interface_saturation.liquid.enthalpy.value;
        let (m, b) = (values[DROP_MASS], values[DROP_BORON]);
        if !(m.is_finite() && b.is_finite() && hf.is_finite()) {
            return Err(Failure::Fatal(format!(
                "spray drop exhaustion on a nonfinite residue (M {m}, B {b}, h_f {hf})"
            )));
        }
        let add = |y: &mut [f64], o: usize, v: f64| {
            let i = base + o;
            y[i] = (y[i] * self.scales[i] + v) / self.scales[i];
        };
        add(y, RESIDENT_MASS, m);
        add(y, RESIDENT_BORON, b);
        add(y, RESIDENT_ENERGY, m * hf);
        y[base + DROP_MASS] = 0.;
        y[base + DROP_BORON] = 0.;
        Ok(
            json!({"drop_mass_kg": m, "drop_boron_kg_eq": b, "liquid_enthalpy_j_kg": hf,
            "into": "resident liquid (rain-out)"}),
        )
    }
    /// Whether phase path `li` is the valve's liquid path, algebraic in
    /// every state (the restriction relation open, the lock closed).
    pub(super) fn spray_algebraic(&self, li: usize) -> bool {
        let l = self.face_layout[li];
        self.spray
            .is_some_and(|s| l.face == s.valve_face && l.phase == 0)
    }
    /// The open valve's restriction row on path `li` at the opening of the
    /// last evaluation, or `None` for any other path: `(Q − capacity)/q_ref`
    /// with `drive` the path's pressure–gravity plus section force and `rho`
    /// the line's liquid density and `mu` its viscosity. With it, the row's
    /// partial in the opening (`−∂Q/∂x / q_ref`, R4-PZR-PI). `seeded_opening`
    /// keeps the opening's direction (the evaluation the operator handed it
    /// to); the network's own column replays read the opening at rest.
    pub(super) fn spray_restriction_row(
        &self,
        li: usize,
        volume_flow: Scalar,
        drive: Scalar,
        rho: Scalar,
        mu: Scalar,
        seeded_opening: bool,
    ) -> Result<Option<(Scalar, f64)>, Failure> {
        let Some(s) = self.spray else {
            return Ok(None);
        };
        if !self.spray_algebraic(li) || s.closed || s.check_closed {
            return Ok(None);
        }
        let x = self
            .spray_x
            .ok_or_else(|| Failure::Fatal("spray valve opening not evaluated".into()))?;
        let x = if seeded_opening {
            x
        } else {
            Scalar::constant(x.value)
        };
        let (c, re_t) = (s.valve.full_area_m2(), s.valve.low_reynolds_transition());
        let cap = capacity(x, c, drive, rho, mu, re_t)?;
        // The row's partial in the opening at this evaluation's values.
        let per_x = capacity(
            Scalar::new(x.value, 1.),
            c,
            Scalar::constant(drive.value),
            Scalar::constant(rho.value),
            Scalar::constant(mu.value),
            re_t,
        )?
        .direction;
        Ok(Some((
            (volume_flow - cap) / Scalar::constant(s.q_ref_m3_s),
            -per_x / s.q_ref_m3_s,
        )))
    }
    /// R4-PZR-PI (S-b): drive the stem from the PZR owner's coordinate: no
    /// held trajectory, issue or owner time event from here on; the
    /// operator hands every evaluation its opening
    /// ([`Network::set_spray_opening`]) and puts the owner's located lock
    /// changes in force ([`Network::set_spray_lock`]). Refused without a
    /// spray path, or with its held stem not at rest on its closed lock.
    pub fn set_spray_continuous(&mut self) -> Result<(), Failure> {
        let s = self
            .spray
            .ok_or_else(|| Failure::Fatal("the continuous spray stem needs a spray path".into()))?;
        if !self.spray_continuous
            && !(s.closed && s.stem.closing() && s.stem.closed_at(s.stem.arrival())?)
        {
            return Err(Failure::Fatal(
                "the continuous spray stem starts from the held stem at rest on its closed lock"
                    .into(),
            ));
        }
        self.spray_continuous = true;
        Ok(())
    }
    /// Whether the stem is the PZR owner's coordinate (R4-PZR-PI, S-b).
    pub fn spray_continuous(&self) -> bool {
        self.spray_continuous
    }
    /// R4-PZR-PI (S-b): the stem opening for the next evaluation, with the
    /// direction of that evaluation's seed.
    pub fn set_spray_opening(&mut self, x: Scalar) {
        self.spray_input = Some(x);
    }
    /// R4-PZR-PI (S-b): the restriction row's index and its partial in the
    /// opening at the last evaluation, `None` while the path is locked.
    pub fn spray_row_opening_partial(&self) -> Option<(usize, f64)> {
        self.spray_row_x
    }
    /// R4-PZR-PI (S-b): the valve-path lock change the PZR owner located
    /// (`closed`: the stem reached 0; released: the master's demand rose
    /// through the spray start), class R. Returns the receipt.
    ///
    /// On release the inlet check is decided by the valve path's forward
    /// drive of the last value evaluation (the located instant's): a check
    /// that closed while the valve was locked (its contact root falls with
    /// the stem's last flow) opens under a forward drive, since its release
    /// root watches the drive rising through zero and a drive already
    /// forward never crosses it; under a reverse or zero drive it stays
    /// closed, its release root armed.
    pub fn set_spray_lock(&mut self, t: f64, closed: bool) -> Result<Value, Failure> {
        if !self.spray_continuous {
            return Err(Failure::Fatal(
                "a located spray lock change needs the continuous stem".into(),
            ));
        }
        let drive = self.spray.map(|s| self.face_drive[s.valve_face][0].value);
        let s = self
            .spray
            .as_mut()
            .ok_or_else(|| Failure::Fatal("no spray path is composed".into()))?;
        if s.closed == closed {
            return Err(Failure::Fatal(format!(
                "spray valve lock change to closed={closed} at {t} s from the same state"
            )));
        }
        let drive = drive.filter(|d| d.is_finite()).ok_or_else(|| {
            Failure::Fatal(format!(
                "spray valve lock change at {t} s without the path's drive"
            ))
        })?;
        let check_before = s.check_closed;
        s.closed = closed;
        if !closed && s.check_closed && drive > 0. {
            s.check_closed = false;
        }
        Ok(
            json!({"owner":"spray valve","t_s":t,"stem":"continuous (PZR owner, R4-PZR-PI)",
            "event": if closed { "stem reached 0: valve path locked" } else { "master demand above the spray start: valve path released" },
            "closed":s.closed,"check_closed_before":check_before,"check_closed":s.check_closed,"forward_drive_pa":drive}),
        )
    }
    /// The stem's opening at `t`, kept for this evaluation's restriction
    /// row (and the block replay of it).
    pub(super) fn spray_opening_at(&mut self, t: f64) -> Result<(), Failure> {
        let input = self.spray_input.take();
        self.spray_x = match self.spray {
            None => None,
            Some(s) if s.closed => Some(Scalar::constant(0.)),
            Some(_) if self.spray_continuous => Some(match (input, self.spray_x) {
                (Some(x), _) => x,
                // An evaluation the operator did not hand an opening (the
                // network's own column passes) reads the last one at rest.
                (None, Some(x)) => Scalar::constant(x.value),
                (None, None) => {
                    return Err(Failure::Fatal(
                        "the continuous spray stem's opening was not handed to the network".into(),
                    ));
                }
            }),
            Some(s) => Some(Scalar::constant(s.stem.position(t)?)),
        };
        self.spray_row_x = None;
        Ok(())
    }
    /// Issue the stem a new fraction at `t` (a control frame). Opening a
    /// closed valve releases its lock here: the caller restarts (class R).
    /// A slope change needs only an exact stop (class S, S3-D4).
    pub fn issue_spray(&mut self, t: f64, target: f64) -> Result<(StemChange, Value), Failure> {
        if self.spray_continuous {
            return Err(Failure::Fatal(format!(
                "a held spray issue at {t} s, but the stem is the continuous master's (R4-PZR-PI)"
            )));
        }
        let s = self
            .spray
            .as_mut()
            .ok_or_else(|| Failure::Fatal("no spray path is composed".into()))?;
        let before = s.stem;
        let change = s.stem.issue(t, target)?;
        if change == StemChange::Lock {
            s.closed = false;
        }
        Ok((
            change,
            json!({"owner":"spray valve","t_s":t,"target":target,"change":format!("{change:?}"),
                "stem_before":format!("{before:?}"),"closed":s.closed,"check_closed":s.check_closed}),
        ))
    }
    /// The stem's next instant after `t`: its arrival, R when it closes the
    /// valve (an owner time event), S otherwise.
    pub fn spray_next_instant(&self, t: f64) -> Option<(f64, StemChange)> {
        if self.spray_continuous {
            return None;
        }
        self.spray.and_then(|s| s.stem.next_instant(t))
    }
    /// The owner time event at `t`: the stem's arrival at 0 locks the valve
    /// path. Returns its receipt, or `None` when no spray event is due.
    pub fn spray_event(&mut self, t: f64) -> Result<Option<Value>, Failure> {
        if self.spray_continuous {
            return Ok(None);
        }
        let Some(s) = self.spray.as_mut() else {
            return Ok(None);
        };
        if s.closed || s.stem.arrival() != t || s.stem.position(t)? != 0. {
            return Ok(None);
        }
        s.closed = true;
        Ok(Some(
            json!({"owner":"spray valve","t_s":t,"event":"stem reached 0: valve path locked"}),
        ))
    }
    /// What the spray slot's root watches now.
    pub fn spray_check_watch(&self) -> Option<CheckRoot> {
        self.spray.map(|s| {
            if s.closed {
                CheckRoot::Disarmed
            } else if s.check_closed {
                CheckRoot::Release
            } else {
                CheckRoot::Contact
            }
        })
    }
    /// The spray slot's root: what it watches and its value at `y` — the
    /// valve liquid path's impulse (contact), its forward drive of the last
    /// value evaluation (release), or the disarmed constant.
    pub fn spray_check_root(&self, y: &[f64]) -> Option<(CheckRoot, f64)> {
        let s = self.spray?;
        let li = 2 * s.valve_face;
        Some(if s.closed {
            (CheckRoot::Disarmed, DISARMED)
        } else if s.check_closed {
            (CheckRoot::Release, self.face_drive[s.valve_face][0].value)
        } else {
            let i = self.face_layout[li].index;
            (CheckRoot::Contact, y[i] * self.scales[i])
        })
    }
    /// The inlet check's transaction at its located root (`direction` as
    /// IDAGetRootInfo): contact (falling impulse) closes it, release
    /// (rising forward drive) opens it; a crossing against the watched
    /// direction does not act and is reported. `None` when nothing crossed.
    pub fn spray_check_transaction(
        &mut self,
        t: f64,
        direction: i32,
    ) -> Result<Option<Value>, Failure> {
        let Some(s) = self.spray.as_mut() else {
            return Ok(None);
        };
        if direction == 0 {
            return Ok(None);
        }
        let watched = if s.closed {
            CheckRoot::Disarmed
        } else if s.check_closed {
            CheckRoot::Release
        } else {
            CheckRoot::Contact
        };
        let acted = match (watched, direction) {
            (CheckRoot::Contact, -1) => {
                s.check_closed = true;
                true
            }
            (CheckRoot::Release, 1) => {
                s.check_closed = false;
                true
            }
            (CheckRoot::Disarmed, _) => {
                return Err(Failure::Fatal(format!(
                    "the spray check's disarmed slot crossed at {t} s"
                )));
            }
            _ => false,
        };
        Ok(Some(
            json!({"owner":"spray inlet check","t_s":t,"root":format!("{watched:?}"),"direction":direction,
                "acted":acted,"check_closed":s.check_closed}),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capacity_is_the_restriction_law_with_its_low_reynolds_branch() {
        // R4-PZR-SPRAY-LAMINAR: Re_t 2,300, water at the sizing density.
        let c = 0.001_158_453_602_592_212_7;
        let rho = Scalar::constant(745.148_293_249_185_4);
        let mu = Scalar::constant(9.2e-5);
        let re_t = 2300.;
        let cap = |x: f64, dp: f64| {
            capacity(Scalar::constant(x), c, Scalar::constant(dp), rho, mu, re_t)
                .unwrap()
                .value
        };
        // Full open at the sizing point: 20 kg/s to within the laminar share.
        let q = cap(1., 2e5);
        let turbulent = c * (2. * 2e5 / rho.value).sqrt();
        assert!((q / turbulent - 1.).abs() < 1e-3, "{}", q / turbulent);
        // Odd in the drive; zero at zero drive and at zero opening.
        assert_eq!(cap(0.5, -2e5), -cap(0.5, 2e5));
        assert_eq!(cap(0.5, 0.), 0.);
        assert_eq!(cap(0., 2e5), 0.);
        // x = 0 is its own branch: every partial is zero.
        let z = capacity(Scalar::new(0., 1.), c, Scalar::new(2e5, 3.), rho, mu, re_t).unwrap();
        assert_eq!((z.value, z.direction), (0., 0.));
        // Laminar at a vanishing drive: Q = Δp/a, a bounded slope.
        let a_v = 0.3 * c;
        let a = re_t * mu.value * std::f64::consts::PI.sqrt() / (4. * a_v.powf(1.5));
        let tiny = capacity(
            Scalar::constant(0.3),
            c,
            Scalar::new(1e-9, 1.),
            rho,
            mu,
            re_t,
        )
        .unwrap();
        assert!(
            (tiny.direction * a - 1.).abs() < 1e-6,
            "{}",
            tiny.direction * a
        );
        // The directions agree with central differences in every input.
        let base = (0.3, 5e3, rho.value, mu.value);
        let f = |x: f64, dp: f64, r: f64, m: f64| {
            capacity(
                Scalar::constant(x),
                c,
                Scalar::constant(dp),
                Scalar::constant(r),
                Scalar::constant(m),
                re_t,
            )
            .unwrap()
            .value
        };
        for k in 0..4 {
            let mut d = [0.; 4];
            d[k] = 1.;
            let at = capacity(
                Scalar::new(base.0, d[0]),
                c,
                Scalar::new(base.1, d[1]),
                Scalar::new(base.2, d[2]),
                Scalar::new(base.3, d[3]),
                re_t,
            )
            .unwrap()
            .direction;
            let h = [1e-7, 1e-3, 1e-4, 1e-9][k];
            let mut lo = [base.0, base.1, base.2, base.3];
            let mut hi = lo;
            lo[k] -= h;
            hi[k] += h;
            let fd = (f(hi[0], hi[1], hi[2], hi[3]) - f(lo[0], lo[1], lo[2], lo[3])) / (2. * h);
            assert!(
                (at - fd).abs() <= 1e-6 * fd.abs().max(1e-12),
                "input {k}: {at} vs {fd}"
            );
        }
    }
}

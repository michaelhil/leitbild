//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The interface every block of the joined hot spine is composed through.
//!
//! The joined residual `F(t, y, y')` is one square system. Each block owns a
//! contiguous slice of `y` and the same number of rows: one row per own
//! coordinate, in its declared order. A block declares its coordinates once
//! ([`Layout`]): label, census class, prepared differential identity, the
//! solver scale (physical value of one solver unit) and the row scale (the
//! physical row value of one solver unit). A differential row is the rate
//! defect of its own coordinate, so its row scale is that coordinate's scale
//! and the solver row is `y'_k - rhs_k/scale_k`, the network's convention.
//! Blocks evaluate their rows in physical units; the composing operator
//! divides by the row scale. Nothing is clipped, floored, seeded or iterated
//! here: a block that cannot evaluate a signed Newton trial returns
//! `Failure::Recoverable`, and an ownership/model error `Failure::Fatal`.
//!
//! Blocks meet only through typed ports, never through each other's
//! coordinates:
//! - the network's fluid state of the same evaluation ([`Fluid`]): local
//!   pressures, present phases and their maintained caloric points with
//!   directions, retained phase masses and tracer, and every face chart;
//! - per-cell receipts into the network ([`Receipts`]): mass, enthalpy and
//!   tracer per phase. The liquid enthalpy receipt is the single heat port.
//!   Positive values enter the cell;
//! - moving cell volumes ([`CellVolume`]) of the network's regular cells
//!   (declared; the network refuses a moving volume until its rigid-volume
//!   EOS row, rate closure and inertance consume one);
//! - the SG secondary state the SG metal contacts see ([`SecondaryView`])
//!   and, back, the metal-to-secondary heat per SG;
//! - achieved rod travel per cluster for the source feedback.
//!
//! Two block owners implement the traits here: the SG secondary owner
//! ([`Secondary`]) and the rod bodies, guide passages and moving volumes
//! owner ([`Rods`]). The nuclear, solid and network blocks are composed
//! directly by the joined operator. Discrete modes (held/free/seated rods,
//! relief branch memory, steam-demand schedule) are block-owned retained
//! state; a located root or a declared command changes them only through
//! [`Secondary::transact`]/[`Rods::transact`] or `command`, after which the
//! composing harness re-establishes consistency by the exact consistent start.
pub use crate::network::{CellVolume, Fluid, Receipts};
use crate::{network::Failure, thermal::Scalar};
use serde::Serialize;

/// Census class of one coordinate. The coordinate's own row carries the same
/// class: a differential coordinate's row is its balance, an algebraic
/// coordinate's row is its constraint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub enum Class {
    // Nuclear and material histories.
    RegionalPopulation,
    Precursor,
    Fissile,
    Fertile,
    Iodine,
    Xenon,
    Promethium,
    Samarium,
    FissionHistory,
    CaptureHistory,
    // Solids.
    FuelEnergy,
    CladEnergy,
    Surface,
    HeliumEnergy,
    PassiveEnergy,
    MetalEnergy,
    // Network (decision 0013, stratified PZR of decision 0014).
    CellPressure,
    PhaseMass,
    PhaseEnergy,
    Tracer,
    PzrAlgebraic,
    PzrStock,
    Impulse,
    Rotor,
    // SG secondary owner.
    SecondaryStock,
    SecondaryChart,
    ReliefLift,
    // SG secondary owner, C08 apparent level (S4-D12, plan r4 X4.1): the
    // algebraic vapor mass, the differential distribution and the algebraic
    // submerged volume, present only with the packet's `apparentLevel`.
    SecondaryVapor,
    SecondaryDistribution,
    SecondarySubmerged,
    // SG secondary owner, compact feed train (plan r4 X4.1): the algebraic
    // header pressure and branch flows, only with the packet's `feedTrain`.
    FeedHeader,
    FeedBranch,
    // The continuous three-element control per SG: channel lags,
    // integrals and the FCV stem (differential).
    FeedControl,
    // Rod bodies and guide passages owner.
    RodPosition,
    RodVelocity,
    GuideCurrent,
    // PZR metal and relief owner (G6).
    PzrMetal,
    PzrReliefLift,
    // The PZR owner's continuous normal control (R4-PZR-CONTINUOUS): the
    // PT1 channel lag (differential), only with the section's
    // `continuousControl`.
    PzrControl,
    // CVCS owner (plan r4 X4.2).
    InventoryStock,
    InventoryControl,
}

/// One block's coordinate declaration, built once at composition.
#[derive(Clone, Debug, Default)]
pub struct Layout {
    pub labels: Vec<String>,
    pub classes: Vec<Class>,
    /// Prepared IDA identity: `true` differential, `false` algebraic. The
    /// current identity may change at an event (`differential()`).
    pub differential: Vec<bool>,
    /// Physical value of one solver unit of each coordinate; finite, > 0.
    pub scales: Vec<f64>,
    /// Physical row value of one solver unit; finite, > 0. For a
    /// differential coordinate it must equal the coordinate's scale.
    pub row_scales: Vec<f64>,
    /// E-NUC (plan r4): how many identical coordinates of the unreduced
    /// model this coordinate stands for (1 unless the owner groups exact
    /// replicas, whose rows and states are equal by construction).
    pub multiplicity: Vec<usize>,
}

impl Layout {
    pub fn len(&self) -> usize {
        self.labels.len()
    }
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }
    pub fn push(&mut self, label: String, class: Class, differential: bool, scale: f64, row: f64) {
        self.push_replicated(label, class, differential, scale, row, 1);
    }
    /// [`Self::push`] for a coordinate standing for `multiplicity` exact
    /// replicas of the unreduced model (E-NUC).
    pub fn push_replicated(
        &mut self,
        label: String,
        class: Class,
        differential: bool,
        scale: f64,
        row: f64,
        multiplicity: usize,
    ) {
        self.labels.push(label);
        self.classes.push(class);
        self.differential.push(differential);
        self.scales.push(scale);
        self.row_scales.push(row);
        self.multiplicity.push(multiplicity);
    }
    /// Refuse an inconsistent declaration before any composition.
    pub fn validate(&self, owner: &str) -> Result<(), Failure> {
        let n = self.labels.len();
        if [
            self.classes.len(),
            self.differential.len(),
            self.scales.len(),
            self.row_scales.len(),
            self.multiplicity.len(),
        ]
        .iter()
        .any(|k| *k != n)
            || self.multiplicity.contains(&0)
        {
            return Err(Failure::Fatal(format!("{owner}: layout lengths differ")));
        }
        for i in 0..n {
            let (s, r) = (self.scales[i], self.row_scales[i]);
            if !(s.is_finite() && s > 0. && r.is_finite() && r > 0.) {
                return Err(Failure::Fatal(format!(
                    "{owner}: coordinate {i} ({}) has scale {s} and row scale {r}",
                    self.labels[i]
                )));
            }
            if self.differential[i] && s != r {
                return Err(Failure::Fatal(format!(
                    "{owner}: differential coordinate {i} ({}) must use its own scale as row scale",
                    self.labels[i]
                )));
            }
        }
        Ok(())
    }
    /// Prepared IDA id vector (1 differential, 0 algebraic).
    pub fn ids(&self) -> Vec<f64> {
        self.differential
            .iter()
            .map(|d| if *d { 1. } else { 0. })
            .collect()
    }
}

/// One block's coordinates of one evaluation in physical units. With a
/// seed `d`, a value carries the direction `d*scale` and a rate
/// `cj*d*scale`: the directional derivative `dF/dy d + cj dF/dy' d`, the
/// network's own convention. Without a seed every direction is zero.
#[derive(Clone, Copy, Debug)]
pub struct Coordinates<'a> {
    y: &'a [f64],
    yp: &'a [f64],
    seed: Option<&'a [f64]>,
    cj: f64,
    scales: &'a [f64],
}

impl<'a> Coordinates<'a> {
    /// The block's own slices of `y`, `y'`, the seed and its scales.
    pub fn new(
        y: &'a [f64],
        yp: &'a [f64],
        seed: Option<&'a [f64]>,
        cj: f64,
        scales: &'a [f64],
    ) -> Result<Self, Failure> {
        if y.len() != scales.len()
            || yp.len() != scales.len()
            || seed.is_some_and(|d| d.len() != scales.len())
            || !cj.is_finite()
        {
            return Err(Failure::Fatal("block coordinate view layout".into()));
        }
        Ok(Self {
            y,
            yp,
            seed,
            cj,
            scales,
        })
    }
    pub fn len(&self) -> usize {
        self.scales.len()
    }
    pub fn is_empty(&self) -> bool {
        self.scales.is_empty()
    }
    /// Physical value of coordinate `i` and its direction.
    pub fn value(&self, i: usize) -> Scalar {
        Scalar::new(
            self.y[i] * self.scales[i],
            self.seed.map_or(0., |d| d[i]) * self.scales[i],
        )
    }
    /// Physical rate of coordinate `i` and its direction `cj*d*scale`.
    pub fn rate(&self, i: usize) -> Scalar {
        Scalar::new(
            self.yp[i] * self.scales[i],
            self.seed.map_or(0., |d| d[i]) * self.cj * self.scales[i],
        )
    }
    pub fn seeded(&self) -> bool {
        self.seed.is_some()
    }
}

/// The SG secondary state one SG's metal contacts see (memo Table 1.2).
#[derive(Clone, Copy, Debug)]
pub struct SecondaryView {
    pub pressure: Scalar,
    /// `T_sat(p_s)` from the maintained saturation of the same pressure.
    pub saturation_temperature: Scalar,
    pub liquid_volume: Scalar,
    pub steam_present: bool,
}

/// Declared interventions the composing harness issues at their times.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum Command {
    /// The manual turbine TRIP (`LD01.TG` TRIP), F5 (a): the STOP ramps the
    /// steam demand to zero over its travel; the trip requests the reactor
    /// trip through its named cause and the holding circuit opens after the
    /// declared delay (H6). Each owner applies its own part.
    TurbineTrip,
    /// The manual reactor-trip interrupt: the holding circuit opens at the
    /// command's time, with no turbine trip (G7's contrary case). The steam
    /// demand stays at its constant A/B values as a declared boundary.
    ManualReactorTrip,
    /// S3 (C16): the manual turbine TRIP with acquired
    /// protection composed (C16). The STOP ramps exactly as for
    /// `TurbineTrip`; the reactor-trip request travels the acquired path
    /// (turbine-state report, division processors, holding contacts), so no
    /// owner schedules S2's declared opening (H6).
    TurbineTripAcquired,
    /// S3 (C16): `LD01.TRIP.HOLD` loses its holding
    /// voltage at the command's time (the acquired protection's two-of-three
    /// permissive majority opened, `reactor-trip-and-hold.md`). Every
    /// healthy grip releases there (the armature's opening omitted, G3).
    HoldingLoss,
    /// G7's stuck cluster, a declared malfunction: the named cluster's grip
    /// stays closed when the holding circuit opens, and every other cluster
    /// releases normally. It is declared while the cluster is still held,
    /// before the trip that opens the circuit; it changes no coordinate.
    /// `cluster` is indexed as the source feedback's rods (the rod owner's
    /// cluster order); the harness names the highest-worth one.
    StuckCluster { cluster: usize },
    /// C3's initiator: RCP `rotor` (the network's rotor order) loses its
    /// supply at the command's time: its drive becomes unsupported with the
    /// shaft free, so it coasts down on its own law; a class-R restart
    /// (lead S3-D1; R3 lane's probe). ELEC's bus support feeds the same
    /// change once composed. Refused for a rotor that is not supported.
    SupplyLoss { rotor: usize },
    /// HOOK (C4 lane, for KERN/G6): S3 case C4's declared malfunction, the
    /// independent PZR relief fails open at the command's time. Its
    /// mechanical demand is held open whatever PT1 reads (the demand root
    /// disarmed); the lift travels at the device's own rate and sticks at
    /// full lift (`pressure-and-inventory.md#independent-relief-candidate`:
    /// finite travel, sticking constrains motion). The PZR owner applies it;
    /// no coordinate moves (class R by its root arming and lift rate).
    ReliefStuckOpen,
}

/// S5 snapshot hook (PLATFORM, claude/ld01-s5-host; KERN reconciles): an
/// optional owner time as its exact IEEE-754 bits, so a restored owner's
/// time events are bitwise its source's.
pub fn snapshot_time(t: Option<f64>) -> serde_json::Value {
    t.map_or(serde_json::Value::Null, |t| {
        serde_json::Value::String(format!("{:016x}", t.to_bits()))
    })
}
/// The inverse of [`snapshot_time`]; anything but null or 16 hex digits
/// refuses fatally.
pub fn restored_time(v: &serde_json::Value) -> Result<Option<f64>, Failure> {
    match v {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(h) if h.len() == 16 => u64::from_str_radix(h, 16)
            .map(|b| Some(f64::from_bits(b)))
            .map_err(|e| Failure::Fatal(format!("snapshot time {h}: {e}"))),
        other => Err(Failure::Fatal(format!(
            "snapshot time {other} is not 16 hex digits"
        ))),
    }
}
/// The object `v` with exactly the keys `keys`, refused otherwise.
pub fn snapshot_object<'a>(
    v: &'a serde_json::Value,
    owner: &str,
    keys: &[&str],
) -> Result<&'a serde_json::Map<String, serde_json::Value>, Failure> {
    let o = v
        .as_object()
        .ok_or_else(|| Failure::Fatal(format!("{owner} snapshot is not an object")))?;
    let mut have: Vec<&str> = o.keys().map(String::as_str).collect();
    let mut want = keys.to_vec();
    have.sort_unstable();
    want.sort_unstable();
    if have != want {
        return Err(Failure::Fatal(format!(
            "{owner} snapshot keys {have:?}, expected {want:?}"
        )));
    }
    Ok(o)
}
/// S3-D19: a real number in a snapshot as its 16 hex IEEE-754 bits (as
/// [`snapshot_time`]), for `#[serde(with = "...")]` on an owner's discrete
/// state: exact, where a decimal JSON number need not round-trip.
pub mod snapshot_bits {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:016x}", v.to_bits()))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        parse(&String::deserialize(d)?).map_err(D::Error::custom)
    }
    pub(crate) fn parse(h: &str) -> Result<f64, String> {
        if h.len() != 16 {
            return Err(format!("snapshot number {h} is not 16 hex digits"));
        }
        u64::from_str_radix(h, 16)
            .map(f64::from_bits)
            .map_err(|e| format!("snapshot number {h}: {e}"))
    }
}
/// [`snapshot_bits`] for an optional real number (null when absent).
pub mod snapshot_bits_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
    pub fn serialize<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
        v.map(|v| format!("{:016x}", v.to_bits())).serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|h| super::snapshot_bits::parse(&h))
            .transpose()
            .map_err(D::Error::custom)
    }
}
/// [`snapshot_bits`] for an optional `(value, time)` pair, such as a
/// pending travel's target and end time.
pub mod snapshot_bits_pair_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
    pub fn serialize<C: Serialize, S: Serializer>(
        v: &Option<(C, f64)>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        v.as_ref()
            .map(|(c, t)| (c, format!("{:016x}", t.to_bits())))
            .serialize(s)
    }
    pub fn deserialize<'de, C: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<(C, f64)>, D::Error> {
        Option::<(C, String)>::deserialize(d)?
            .map(|(c, h)| super::snapshot_bits::parse(&h).map(|t| (c, t)))
            .transpose()
            .map_err(D::Error::custom)
    }
}

/// Structural dependencies of one block, in its own indices, for the joined
/// sparse pattern. It must contain every dependency any state can produce,
/// including through modes and branches; a colored assembly refuses a
/// response outside it.
#[derive(Clone, Debug, Default)]
pub struct Structure {
    /// Per own row: own coordinates it reads, values or rates.
    pub own: Vec<Vec<usize>>,
    /// Per own row: network regular cells whose fluid state it reads.
    pub cells: Vec<Vec<usize>>,
    /// Per own row: network faces whose charts it reads.
    pub faces: Vec<Vec<usize>>,
    /// Per own row: SGs whose metal-to-secondary heat it reads (secondary
    /// owner only).
    pub heat: Vec<Vec<usize>>,
    /// Receipts it writes: (network cell, own coordinates the receipt reads,
    /// network cells whose fluid state the receipt reads).
    pub receipts: Vec<(usize, Vec<usize>, Vec<usize>)>,
    /// Moving volumes it writes: (network cell, own coordinates read).
    pub volumes: Vec<(usize, Vec<usize>)>,
    /// Per exported view (SG view per SG, travel per cluster): own
    /// coordinates read.
    pub outputs: Vec<Vec<usize>>,
}

/// Outcome of one discrete transaction at a located root or command.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Transaction {
    /// Energy deposited once into named finite solid stores (J), such as a
    /// seated body's arrival energy into its contacted fitting.
    pub deposits: Vec<(String, f64)>,
    /// What changed, for the event receipt: modes, totals before/after.
    pub receipt: serde_json::Value,
}

/// One owner's part of the unit's conservation account
/// ([`account`](super::account)), values only, at the owner's last `rows`
/// evaluation or at the coordinates it is handed.
#[derive(Clone, Debug, Default, Serialize)]
pub struct OwnerAccount {
    /// Energy the owner stores outside its energy-class coordinates (J):
    /// the rod bodies' kinetic and potential energy.
    pub mechanical_j: f64,
    /// That energy's rate as the owner's own rows imply it (W).
    pub mechanical_rate_w: f64,
    /// What crosses the unit's envelope at the owner's ports, each positive
    /// entering the unit.
    pub crossings: Vec<Crossing>,
    /// Heat each of the owner's volumes received from another block as its
    /// rows used it (W): the SG secondary's metal heat, per SG.
    pub received_heat_w: Vec<f64>,
    /// The rod bodies' power ledger of the last captured value evaluation
    /// ([`Rods::capture_account`]): fluid-force power, heat paid to the swept
    /// water, boundary work the network pays through `-p V'` (W). Their sum
    /// is the bodies' pressure-work remainder (decision 0012's hydrostatic
    /// remainder of the moving volumes), which the unit's energy account
    /// reports as its own term. `None` where nothing was captured.
    pub power: Option<[f64; 3]>,
}

/// One port's crossing of the unit's envelope, positive entering.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Crossing {
    pub port: String,
    /// The owner volume the port belongs to (an SG index for the secondary).
    pub volume: usize,
    pub mass_kg_s: f64,
    pub energy_w: f64,
    pub tracer_kg_s: f64,
}

/// The SG secondary owner: one equilibrium volume per SG with its steam,
/// relief and feed ports (memo §2). Heat enters only through the SG metal,
/// whose contacts the joined operator evaluates against [`SecondaryView`].
pub trait Secondary<P> {
    fn layout(&self) -> &Layout;
    /// Prepared physical coordinates, layout order.
    fn prepared(&self) -> Vec<f64>;
    /// Current IDA identity (1 differential, 0 algebraic), layout order.
    fn differential(&self) -> Vec<f64>;
    /// Number of SGs; views and heats are indexed by the packet's
    /// `thermal.secondaries` index.
    fn generators(&self) -> usize;
    /// The state every SG's metal contacts see at these coordinates.
    fn views(
        &mut self,
        properties: &P,
        x: Coordinates<'_>,
        out: &mut [SecondaryView],
    ) -> Result<(), Failure>;
    /// Every own row in physical units, given the actual metal-to-secondary
    /// heat of each SG (W) from the same evaluation.
    fn rows(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        heat_w: &[Scalar],
        rows: &mut [Scalar],
    ) -> Result<(), Failure>;
    fn structure(&self) -> Structure;
    /// Root functions on accepted states (relief crack/full lift/reseat,
    /// geometric guards). Stock IDA cannot retry a root: refuse only fatally.
    fn root_count(&self) -> usize;
    fn roots(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure>;
    /// The crossing direction each root function reports in the owner's
    /// current state, root order (stock IDASetRootDirection: +1 rising
    /// only, -1 falling only, 0 both). Read at every restart, after the
    /// transactions.
    fn root_directions(&self, out: &mut [i32]) -> Result<(), Failure>;
    /// The discrete transaction at located roots (`directions` per root
    /// function as IDAGetRootInfo). `y` holds own physical coordinates and
    /// may be changed only by conserving transactions.
    fn transact(
        &mut self,
        properties: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure>;
    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure>;
    /// The earliest declared time event strictly after `t` (for example the
    /// end of the STOP ramp), or `None`. The harness stops there and restarts
    /// by the exact consistent start.
    fn next_time_event(&self, t: f64) -> Option<f64>;
    /// The transaction of this owner's own declared time event when one is
    /// due exactly at `t` and not yet transacted, `None` otherwise. It is
    /// called at every time-event stop and after every command, because a
    /// root that is exactly zero at a restart never reports a crossing. Like
    /// `transact`, it changes own coordinates only by conserving
    /// transactions.
    fn time_event(
        &mut self,
        properties: &P,
        t: f64,
        y: &mut [f64],
    ) -> Result<Option<Transaction>, Failure>;
    /// The conservation account of the last `rows` evaluation: per SG, the
    /// feed entering and the steam and relief leaving (mass and energy at
    /// the enthalpies the rows used), and the metal heat the rows received.
    fn account(&self) -> OwnerAccount;
    /// S5 snapshot hook (PLATFORM, claude/ld01-s5-host; KERN reconciles):
    /// this owner's copyable discrete state — its modes, latches and armed
    /// time events, never coordinates or caches — as plain data.
    fn discrete_state(&self) -> serde_json::Value;
    /// S5 snapshot hook: restore [`Secondary::discrete_state`] exactly;
    /// anything else (layout, unknown field) refuses fatally.
    fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure>;
    // ELEC S3 hook (block.rs, KERN-owned; defaults leave S1/S2 unchanged).
    /// The admitted turbine steam of every SG together at `t` (kg/s), when
    /// the owner's admission is a time-only boundary (S2/S3: demand times
    /// the STOP's admission fraction); the electrical slice's turbine input.
    fn admitted_steam_kg_s(&self, _t: f64) -> Option<f64> {
        None
    }
    /// X4.4 preview hook (lane ROD; the turbine valve and governor are
    /// X4.3's): the turbine load demand as a fraction of the prepared steam
    /// demand, a held input at a frame instant. An owner without the input
    /// refuses.
    fn set_turbine_load(&mut self, _t: f64, load: f64) -> Result<Transaction, Failure> {
        Err(Failure::Fatal(format!(
            "this secondary owner has no turbine load input (requested {load})"
        )))
    }
    /// The latched turbine TRIP time, if any (the trip requests GCB OPEN).
    fn turbine_trip_time(&self) -> Option<f64> {
        None
    }
    /// X4.3 hook (lane TURB): declare the turbine admission valve's choked
    /// law (admission proportional to the slice's valve opening and the SG
    /// pressure; the rows already read the pressure, so the structure is
    /// unchanged). An owner without the law refuses.
    fn declare_valve_admission(&mut self) -> Result<(), Failure> {
        Err(Failure::Fatal(
            "this secondary owner has no turbine valve law".into(),
        ))
    }
    /// X4.3: the valve opening of the evaluation that follows (a trial
    /// input set from the slice's coordinate) and its seed direction.
    fn set_admission_opening(&mut self, _opening: f64, _direction: f64) -> Result<(), Failure> {
        Err(Failure::Fatal(
            "this secondary owner has no turbine valve law".into(),
        ))
    }
    /// X4.3: per SG, the own pressure coordinate and the coefficient
    /// `c_k(t)` of the admitted turbine steam `a * sum c_k p_k` (kg/s per Pa
    /// at full opening), when the valve law is declared.
    fn admission_terms(&self, _t: f64) -> Option<Vec<(usize, f64)>> {
        None
    }
    /// X4.3: the own rows reading the valve opening (sorted), empty
    /// without the valve law.
    fn admission_rows(&self) -> Vec<usize> {
        Vec::new()
    }
    /// S3-D12: the recorded feed (F3 (a)) gated by the feed pumps' supply.
    /// A held input entering only the SG stocks' rates (class S, S3-D4).
    fn set_feed_supported(&mut self, _supported: bool) -> Result<(), Failure> {
        Err(Failure::Fatal(
            "this secondary owner declares no feed gate".into(),
        ))
    }
    /// S3-D27: declare the S3-D12 feed gate before any Jacobian structure
    /// is compiled. The SG mass rows then also read the pressure and the
    /// relief lifts (structural zeros while the gate is open, the F3 (a)
    /// cancellation), so the structure is the superset of both gate modes;
    /// without the declaration the gate cannot close.
    fn declare_feed_gate(&mut self) -> Result<(), Failure> {
        Err(Failure::Fatal(
            "this secondary owner declares no feed gate".into(),
        ))
    }
    /// Whether [`Secondary::declare_feed_gate`] was declared.
    fn feed_gate_declared(&self) -> bool {
        false
    }
    /// FEED (plan r4): absolute tolerances the owner declares for its
    /// control coordinates at operator grade, as `(own index, physical
    /// tolerance)`; the composition applies them. None by default.
    fn operator_tolerances(&self) -> Vec<(usize, f64)> {
        Vec::new()
    }
}

/// The rod bodies (spider and bodies, H7), their guide passages (F1 (a),
/// H4) and the network cell volumes they displace (memo §4).
pub trait Rods<P> {
    fn layout(&self) -> &Layout;
    fn prepared(&self) -> Vec<f64>;
    fn differential(&self) -> Vec<f64>;
    /// Number of clusters; travel is indexed as the source feedback's rods.
    fn clusters(&self) -> usize;
    /// E-NUC: the passive solid stores a transaction may deposit energy
    /// into (a seat's arrival energy into its fitting), each kept out of
    /// the solids' replica classes.
    fn deposit_stores(&self) -> Vec<String>;
    /// E-NUC: the local index of cluster `c`'s first coordinate (its travel;
    /// then velocity and the two mouth currents): its motion class's.
    fn cluster_coordinate(&self, c: usize) -> usize;
    /// E-NUC: each motion class's member clusters, cluster order.
    fn class_members(&self) -> Vec<Vec<usize>>;
    /// E-NUC: a packet-layout saved slice of this block reduced to its
    /// layout (refused when replicas differ in a state coordinate), with the
    /// largest relative spreads `[mouth currents, bores' water]` of what it
    /// took from a class's first member or merged.
    fn reduce_packet_state(&self, full: &[f64]) -> Result<(Vec<f64>, [f64; 2]), String>;
    /// EVT-RODS-BANK: the length of this block's packet-layout slice (P2's:
    /// per cluster, then per sector-share bore group).
    fn packet_coordinates(&self) -> usize;
    /// The packet layout's bore group of every cluster (equal sector shares,
    /// a declared single its own, first appearance first): the grouping a
    /// packet-layout saved slice is in.
    fn packet_groups(&self) -> Vec<usize>;
    /// EVT-RODS-BANK: [`Rods::reduce_packet_state`] for a saved state's
    /// rates, merged and never refused (NUC review).
    fn reduce_packet_rates(&self, full: &[f64]) -> Result<(Vec<f64>, [f64; 2]), String>;
    /// Achieved travel per cluster (m) for the source feedback's overlap.
    fn travel(&self, x: Coordinates<'_>, out: &mut [Scalar]) -> Result<(), Failure>;
    /// Current fluid volume and rate of every regular network cell, from the
    /// compiled (packet) volumes and the bodies' current displacement.
    fn volumes(
        &self,
        x: Coordinates<'_>,
        compiled_m3: &[f64],
        out: &mut [CellVolume],
    ) -> Result<(), Failure>;
    /// Every own row in physical units, and the guide-passage receipts into
    /// the network cells, from the same evaluation's fluid state.
    fn rows(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
        rows: &mut [Scalar],
    ) -> Result<(), Failure>;
    /// [`Rods::rows`] of the listed clusters only, as `(own row, value)`,
    /// each bitwise the full evaluation's, with only their receipts.
    #[allow(clippy::too_many_arguments)] // As rows, with the clusters.
    fn rows_local(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        clusters: &[usize],
        receipts: &mut Receipts<'_>,
        out: &mut Vec<(usize, Scalar)>,
    ) -> Result<(), Failure>;
    /// The clusters whose rows or receipts read, at these coordinates, a
    /// listed cell whose fluid state carries a direction in `fluid`, or a
    /// listed face's chart. Every other cluster's rows and receipts take no
    /// direction from them.
    fn readers(
        &self,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        cells: &[usize],
        faces: &[usize],
        out: &mut Vec<usize>,
    ) -> Result<(), Failure>;
    /// The clusters whose rows, receipts, travel or volumes read own
    /// coordinate `i`.
    fn coordinate_readers(&self, i: usize, out: &mut Vec<usize>) -> Result<(), Failure>;
    fn structure(&self) -> Structure;
    /// Root functions on accepted states (seats, kinks if declared).
    fn root_count(&self) -> usize;
    fn roots(
        &mut self,
        properties: &P,
        t: f64,
        x: Coordinates<'_>,
        fluid: &Fluid<'_>,
        out: &mut [f64],
    ) -> Result<(), Failure>;
    /// How many clusters' annulus volume current lies strictly inside R3's
    /// blend band at these coordinates and this fluid state (R3, adopted 11
    /// October; C3's cost line counts the accepted states with any). Reads
    /// LOWER's liquid density only.
    fn r3_band(&self, x: Coordinates<'_>, fluid: &Fluid<'_>) -> Result<usize, Failure>;
    /// Whether [`Rods::roots`] reads `fluid` in the owner's present modes;
    /// an owner that cannot tell answers `true`.
    fn roots_read_fluid(&self) -> bool {
        true
    }
    /// E-EVT (plan r4, the bank seat): widen located `directions` (one per
    /// root, as IDAGetRootInfo) at the state `y` handed to the restart to
    /// every root of the same event, so it transacts once. `weights` are
    /// the handle's error weights at `y` (physical units, `1/tolerance`).
    /// Returns how many roots it added.
    fn coincident(
        &self,
        y: &[f64],
        weights: &[f64],
        directions: &mut [i32],
    ) -> Result<usize, Failure>;
    fn transact(
        &mut self,
        properties: &P,
        t: f64,
        directions: &[i32],
        y: &mut [f64],
    ) -> Result<Transaction, Failure>;
    fn command(&mut self, t: f64, command: Command) -> Result<Transaction, Failure>;
    /// B1 (lane ROD): a class whose grip is declared stuck is held while
    /// every other class is seated (the stuck cluster stays out).
    fn stuck_out(&self) -> bool;
    /// X4.4 (lane ROD): the ordinary rate drive's common requested rate
    /// (m/s) while it is engaged, `None` otherwise.
    fn drive(&self) -> Option<f64>;
    /// X4.4 (lane ROD): engage the rate drive at a rate, change its rate, or
    /// (`None`) withdraw it; a held input at a frame instant.
    fn set_drive(&mut self, t: f64, drive: Option<f64>) -> Result<Transaction, Failure>;
    /// The earliest declared time event strictly after `t` (for example the
    /// holding circuit's opening after its declared delay), or `None`.
    fn next_time_event(&self, t: f64) -> Option<f64>;
    /// As [`Secondary::time_event`]: the transaction of a time event due
    /// exactly at `t` (the holding circuit's opening releases every held
    /// cluster that is not stuck), `None` otherwise.
    fn time_event(
        &mut self,
        properties: &P,
        t: f64,
        y: &mut [f64],
    ) -> Result<Option<Transaction>, Failure>;
    /// Startup only: prepare the owner's coordinates at the composed fluid
    /// state, after which `prepared()` holds them. No differential
    /// coordinate changes except those [`Rods::prepared_stocks`] names.
    fn prepare(&mut self, properties: &P, fluid: &Fluid<'_>) -> Result<Transaction, Failure>;
    /// HOOK (OU-C P2, for OU-B): the owner's differential coordinates that
    /// its startup preparation sets at the composed fluid state (the rod
    /// bores' water, prepared as LOWER's composed water); none by default.
    fn prepared_stocks(&self) -> Vec<usize> {
        Vec::new()
    }
    /// The conservation account at these coordinates and the owner's own
    /// physical rows of the same evaluation: the bodies' kinetic and
    /// potential energy and its rate as the rows imply it, and the power
    /// ledger the last captured evaluation recorded. The guide passages
    /// carry water between network cells only, so no crossing.
    fn account(&self, x: Coordinates<'_>, rows: &[Scalar]) -> Result<OwnerAccount, Failure>;
    /// Record the bodies' power ledger at the following value evaluations
    /// (`true`) or stop (`false`). Every value evaluation replaces the
    /// record, so it is always the last value evaluation's or none. Only the
    /// conservation account turns it on, around its own evaluation, so no
    /// residual or Jacobian evaluation pays for it.
    fn capture_account(&mut self, on: bool);
    /// S5 snapshot hook (PLATFORM, claude/ld01-s5-host; KERN reconciles):
    /// every cluster's mode and declared failed release, and the holding
    /// circuit's opening time — never coordinates or caches.
    fn discrete_state(&self) -> serde_json::Value;
    /// S5 snapshot hook: restore [`Rods::discrete_state`] exactly; anything
    /// else refuses fatally.
    fn restore_discrete_state(&mut self, state: &serde_json::Value) -> Result<(), Failure>;
}

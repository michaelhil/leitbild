//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! The only unsafe water boundary. The pure operating equation crate remains
//! unsafe-forbidden and has no dependency on this opt-in native package.

use std::fmt;

#[derive(Clone, Copy, Debug)]
#[repr(i32)]
pub enum Branch {
    Liquid = 0,
    Vapor = 1,
    SaturatedLiquid = 2,
    SaturatedVapor = 3,
}

/// C layout checked by actual calls, not a serialized approximation to IF97.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct WaterPoint {
    pub region: i32,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
    pub cp_j_kg_k: f64,
    pub cv_j_kg_k: f64,
    pub expansion_per_k: f64,
    pub compressibility_per_pa: f64,
    pub viscosity_pa_s: f64,
    pub conductivity_w_m_k: f64,
    pub saturation_slope_k_pa: f64,
    /// Signed departure `T - Tsat(p)` on the requested branch: positive is a
    /// superheated liquid, negative a subcooled vapor; zero at an endpoint.
    pub saturation_departure_k: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Error {
    Domain,
    AbiArgument,
    NativeFailure,
    /// A metastable state of the requested branch outside its bounded trial
    /// band. Recoverable: a solver trial may step back inside it.
    TrialBand,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operating IF97: {self:?}")
    }
}
impl std::error::Error for Error {}

/// The pressure domain a water owner declares (S4-D2, owner decision F5,
/// 15 Oct 2026). The adapter admits IF97's own validity down to the
/// triple-point pressure; this boundary keeps the selected 0.1 MPa floor for
/// every owner that does not declare a low-pressure domain, so the
/// operating owners' checks are unchanged. The `*_in` entries and
/// [`If97LowPressure`] take a declared domain; the others are `Operating`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    /// The selected operating domain: `p >= 0.1 MPa`.
    Operating,
    /// A declared low-pressure owner (feed, condensate, condenser,
    /// containment): `p >= 611.657 Pa`, IF97's own validity.
    LowPressure,
}
impl Domain {
    /// The domain's pressure floor [Pa].
    pub const fn floor_pa(self) -> f64 {
        match self {
            Self::Operating => 1e5,
            Self::LowPressure => 611.657,
        }
    }
    /// `Error::Domain` below the floor (or a pressure that is not finite),
    /// before any native call.
    fn admit(self, p: f64) -> Result<(), Error> {
        if p.is_finite() && p >= self.floor_pa() {
            Ok(())
        } else {
            Err(Error::Domain)
        }
    }
}

/// spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#sbtl-water-properties
/// The water method of this process's composition (owner decision, 1 Nov
/// 2026): the maintained IF97 reference, or the IAPWS G13-15 SBTL tables of
/// that reference compiled into the same water archive. An explicit
/// composition setting: the unit host's LOAD solver block and the case drive
/// select it once, before the composition's first water call, and record it
/// in the composition identity and every receipt. Without a selection the
/// boundary is the IF97 reference. There is no fallback between methods: a
/// state the selected method refuses is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WaterMethod {
    If97,
    Sbtl,
}
impl WaterMethod {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "if97" => Ok(Self::If97),
            "sbtl" => Ok(Self::Sbtl),
            other => Err(format!(
                "water method {other:?}: expected \"if97\" or \"sbtl\""
            )),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::If97 => "if97",
            Self::Sbtl => "sbtl",
        }
    }
}
/// 0: none selected (IF97); 1: IF97; 2: SBTL.
static WATER_METHOD: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
/// Select the process's water method. A second selection of the same method
/// is accepted; a different one is refused (one composition per process).
pub fn select_water_method(method: WaterMethod) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    let code = match method {
        WaterMethod::If97 => 1,
        WaterMethod::Sbtl => 2,
    };
    match WATER_METHOD.compare_exchange(0, code, SeqCst, SeqCst) {
        Ok(_) => Ok(()),
        Err(held) if held == code => Ok(()),
        Err(_) => Err(format!(
            "water method already selected as {}; refusing {}",
            water_method().as_str(),
            method.as_str()
        )),
    }
}
/// The process's water method (IF97 until a composition selects one).
pub fn water_method() -> WaterMethod {
    if sbtl() {
        WaterMethod::Sbtl
    } else {
        WaterMethod::If97
    }
}
fn sbtl() -> bool {
    WATER_METHOD.load(std::sync::atomic::Ordering::Relaxed) == 2
}
fn native_status(code: i32) -> Result<(), Error> {
    match code {
        0 => Ok(()),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}
/// The SBTL point: every field but cv (NaN, not tabulated).
fn sbtl_point(branch: Branch, p: f64, t: f64) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: the same C-layout contract as `point`: a unique live stack
    // allocation, completely written on success and retained nowhere; the
    // native function catches every C++ exception.
    native_status(unsafe { ld01_sbtl_point(branch as i32, p, t, &mut output) })?;
    Ok(output)
}
/// The SBTL point and its analytic direction along (dp, dt) (a saturated
/// branch moves along saturation).
fn sbtl_direction(
    branch: Branch,
    p: f64,
    t: f64,
    dp: f64,
    dt: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    let mut value = WaterPoint::default();
    let mut direction = WaterPoint::default();
    // SAFETY: as `sbtl_point`; two distinct live unique stack outputs.
    native_status(unsafe {
        ld01_sbtl_direction(branch as i32, p, t, dp, dt, &mut value, &mut direction)
    })?;
    Ok((value, direction))
}

unsafe extern "C" {
    // SBTL entries (IAPWS G13-15 tables of the reference, same archive).
    fn ld01_sbtl_point(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_sbtl_direction(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        pressure_direction: f64,
        temperature_direction: f64,
        output: *mut WaterPoint,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_sbtl_inverse(
        branch: i32,
        pressure_pa: f64,
        target: f64,
        enthalpy: i32,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_sbtl_inverse_direction(
        branch: i32,
        held: *const WaterPoint,
        enthalpy: i32,
        pressure_direction: f64,
        target_direction: f64,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_point(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_caloric(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_complete(caloric: *const WaterPoint, fields: i32, output: *mut WaterPoint)
    -> i32;
    fn ld01_water_direction(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        pressure_direction: f64,
        temperature_direction: f64,
        output: *mut WaterPoint,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_direction_held(
        branch: i32,
        held: *const WaterPoint,
        pressure_direction: f64,
        temperature_direction: f64,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_fields(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        fields: i32,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_direction_exact(
        branch: i32,
        held: *const WaterPoint,
        pressure_direction: f64,
        temperature_direction: f64,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_bracket(
        branch: i32,
        pressure_pa: f64,
        stable_branch: *mut i32,
        stable_temperature_k: *mut f64,
        trial_temperature_k: *mut f64,
    ) -> i32;
    fn ld01_water_metastable_band(output: *mut MetastableBand) -> i32;
    fn ld01_water_surface(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
    fn ld01_water_vapor_sat_density(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
    // G1-C13 hook (lib.rs, shared; KERN reconciles): IF97 p_sat(T).
    fn ld01_water_saturation_pressure(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
    // G1-C13 hook (lib.rs, shared; KERN reconciles): h_g(T) below 0.1 MPa.
    fn ld01_water_saturated_vapor_enthalpy(temperature: f64, value: *mut f64) -> i32;
    // G1-C13 hook (lib.rs, shared; KERN reconciles): saturated-vapor mu(T) below 0.1 MPa.
    fn ld01_water_saturated_vapor_viscosity(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
}

pub fn point(branch: Branch, pressure_pa: f64, temperature_k: f64) -> Result<WaterPoint, Error> {
    point_in(Domain::Operating, branch, pressure_pa, temperature_k)
}

/// [`point`] in a declared pressure domain.
pub fn point_in(
    domain: Domain,
    branch: Branch,
    pressure_pa: f64,
    temperature_k: f64,
) -> Result<WaterPoint, Error> {
    domain.admit(pressure_pa)?;
    if sbtl() {
        return sbtl_point(branch, pressure_pa, temperature_k);
    }
    let mut output = WaterPoint::default();
    // SAFETY: repr(C) contains only C int/doubles in declared order. Pointer
    // refers to a unique live stack allocation; C writes its complete tuple on
    // success, keeps no pointer, and catches every C++ exception. The enum has
    // only the four supported ABI discriminants. No buffer or allocator crosses.
    let status =
        unsafe { ld01_water_point(branch as i32, pressure_pa, temperature_k, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// The caloric-inverse state of the SAME forward point, for its brackets and
/// iterates only: the same branch, domain and region checks and bit-identical
/// rho/u/h/cp/alpha, the fields that inverse reads. Entropy, cv, sound speed,
/// compressibility, transport and the p-only saturation slope are not
/// evaluated; their fields are NaN. Never returned to a caller: the inverse
/// returns `complete` of the selected state.
fn caloric_state(
    branch: Branch,
    pressure_pa: f64,
    temperature_k: f64,
) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: the same C-layout contract as `point`: a unique live stack
    // allocation, completely written on success and retained nowhere; the
    // native function catches every C++ exception.
    let status =
        unsafe { ld01_water_caloric(branch as i32, pressure_pa, temperature_k, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// Fields the native completion adds to a caloric state, by bit (the
/// bridge's `FIELD_*`): cv, compressibility, viscosity, conductivity and the
/// saturation slope.
const FIELD_CV: i32 = 1;
const FIELD_KAPPA: i32 = 2;
const FIELD_MU: i32 = 4;
const FIELD_K: i32 = 8;
const FIELD_SLOPE: i32 = 16;
const FIELDS_ALL: i32 = FIELD_CV | FIELD_KAPPA | FIELD_MU | FIELD_K | FIELD_SLOPE;

/// `point(branch, p, T)` from `caloric_state(branch, p, T)`'s own output,
/// without evaluating its caloric fields again: the native boundary adds
/// cv, compressibility, transport and the saturation slope to the held
/// state. Only a state this boundary's `caloric_state` returned is passed.
fn complete(caloric: &WaterPoint) -> Result<WaterPoint, Error> {
    complete_fields(caloric, FIELDS_ALL)
}

/// The same completion restricted to `fields`; unrequested fields are NaN.
fn complete_fields(caloric: &WaterPoint, fields: i32) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: `caloric` is a live shared C-layout tuple that C only reads
    // during the call; `output` is a unique live stack allocation written
    // completely on success. Nothing is retained; C catches every exception.
    let status = unsafe { ld01_water_complete(caloric, fields, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// `point(branch, p, T)` with only `fields` evaluated beyond the caloric
/// state: the same branch, domain and region checks and status codes.
fn point_fields(branch: Branch, p: f64, t: f64, fields: i32) -> Result<WaterPoint, Error> {
    if sbtl() {
        return sbtl_point(branch, p, t);
    }
    let mut output = WaterPoint::default();
    // SAFETY: the same C-layout contract as `point`: a unique live stack
    // allocation, completely written on success and retained nowhere; the
    // native function catches every C++ exception.
    let status = unsafe { ld01_water_fields(branch as i32, p, t, fields, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// The exact part of `directional_held(branch, held, dp, dt)`: p, T, rho, u
/// and h bit for bit, every other field NaN; no coefficient probe.
fn exact_held(branch: Branch, held: &WaterPoint, dp: f64, dt: f64) -> Result<WaterPoint, Error> {
    if sbtl() {
        return sbtl_direction(branch, held.pressure_pa, held.temperature_k, dp, dt)
            .map(|(_, d)| d);
    }
    let mut direction = WaterPoint::default();
    // SAFETY: `held` is a live shared C-layout tuple that C only reads;
    // `direction` is a unique live stack allocation written on success.
    // Nothing is retained; the native function catches errors.
    let status = unsafe { ld01_water_direction_exact(branch as i32, held, dp, dt, &mut direction) };
    match status {
        0 => Ok(direction),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// The saturated liquid and vapor endpoints at `p` with their exact
/// directions along `dp`: temperature, density and enthalpy bit for bit
/// those of `directional(Saturated*, p, 0, dp, 0)`. Transport, cv, cp and
/// expansion directions are not evaluated (NaN), and no coefficient probe is
/// made. At a seed of exactly +0.0 those three directions are +0.0 (the
/// exact directions are products of the seed with the finite positive
/// slope, compressibility, density and cp), so the endpoint needs neither its
/// compressibility nor its slope, and every other direction is NaN.
pub fn saturation_caloric(p: f64, dp: f64) -> Result<[(WaterPoint, WaterPoint); 2], Error> {
    saturation_caloric_in(Domain::Operating, p, dp)
}

/// [`saturation_caloric`] in a declared pressure domain.
pub fn saturation_caloric_in(
    domain: Domain,
    p: f64,
    dp: f64,
) -> Result<[(WaterPoint, WaterPoint); 2], Error> {
    domain.admit(p)?;
    if !dp.is_finite() {
        return Err(Error::AbiArgument);
    }
    let value_only = dp.to_bits() == 0;
    let endpoint = |branch: Branch| -> Result<(WaterPoint, WaterPoint), Error> {
        if value_only {
            let q = point_fields(branch, p, 0., 0)?;
            let n = f64::NAN;
            let zero = WaterPoint {
                region: q.region,
                pressure_pa: 0.,
                temperature_k: 0.,
                density_kg_m3: 0.,
                internal_energy_j_kg: n,
                enthalpy_j_kg: 0.,
                cp_j_kg_k: n,
                cv_j_kg_k: n,
                expansion_per_k: n,
                compressibility_per_pa: n,
                viscosity_pa_s: n,
                conductivity_w_m_k: n,
                saturation_slope_k_pa: n,
                saturation_departure_k: n,
            };
            return Ok((q, zero));
        }
        let q = point_fields(branch, p, 0., FIELD_KAPPA | FIELD_SLOPE)?;
        Ok((q, exact_held(branch, &q, dp, 0.)?))
    };
    Ok([
        endpoint(Branch::SaturatedLiquid)?,
        endpoint(Branch::SaturatedVapor)?,
    ])
}

/// Exact rho/u/h directional response; disclosed same-branch second-order
/// coefficient probes for transport/cp/alpha. No whole-model probing or cache.
pub fn directional(
    branch: Branch,
    p: f64,
    t: f64,
    dp: f64,
    dt: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    directional_in(Domain::Operating, branch, p, t, dp, dt)
}

/// [`directional`] in a declared pressure domain.
pub fn directional_in(
    domain: Domain,
    branch: Branch,
    p: f64,
    t: f64,
    dp: f64,
    dt: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    domain.admit(p)?;
    if sbtl() {
        if !dp.is_finite() || !dt.is_finite() {
            return Err(Error::AbiArgument);
        }
        return sbtl_direction(branch, p, t, dp, dt);
    }
    let mut value = WaterPoint::default();
    let mut direction = WaterPoint::default();
    // SAFETY: same C-layout contract as point; outputs are distinct live unique
    // stack allocations, retained nowhere. The native function catches errors.
    let status =
        unsafe { ld01_water_direction(branch as i32, p, t, dp, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// `directional(branch, held.pressure_pa, held.temperature_k, dp, dt).1` at a
/// point this boundary already returned as exactly that forward point, without
/// evaluating it again: only the coefficient probes are evaluated.
fn directional_held(
    branch: Branch,
    held: &WaterPoint,
    dp: f64,
    dt: f64,
) -> Result<WaterPoint, Error> {
    if sbtl() {
        return sbtl_direction(branch, held.pressure_pa, held.temperature_k, dp, dt)
            .map(|(_, d)| d);
    }
    let mut direction = WaterPoint::default();
    // SAFETY: `held` is a live shared C-layout tuple that C only reads during
    // the call; `direction` is a unique live stack allocation written on
    // success. Nothing is retained and the native function catches errors.
    let status = unsafe { ld01_water_direction_held(branch as i32, held, dp, dt, &mut direction) };
    match status {
        0 => Ok(direction),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// Invert the maintained pure-phase EOS at the SAME pressure and specific U.
/// This is a local coordinate elimination, not a flash calculation or a new
/// property fit. A target beyond the requested branch's stable range is
/// recovered only inside its bounded metastable trial band, on the branch's
/// own basic equation, and refused with `Error::TrialBand` beyond it; it is
/// never clamped to saturation or assigned a different phase.
pub fn point_pu(branch: Branch, p: f64, u: f64) -> Result<WaterPoint, Error> {
    CaloricLinearization::internal_energy(branch, p, u).map(|q| q.point())
}

/// The same stable-branch inverse for a responsible incoming enthalpy. This
/// creates no phase stock and is not used to assign a point to an empty phase
/// without a physical receipt.
pub fn point_ph(branch: Branch, p: f64, h: f64) -> Result<WaterPoint, Error> {
    CaloricLinearization::enthalpy(branch, p, h).map(|q| q.point())
}

/// Fields the thermodynamics-only inverse adds to the caloric state:
/// compressibility and viscosity. cv, conductivity and the saturation slope
/// are not evaluated.
const FIELDS_THERMODYNAMIC: i32 = FIELD_KAPPA | FIELD_MU;

/// One immutable, successfully recovered caloric point. A Jacobian may reuse
/// this point for directions at EXACTLY its pressure and specific energy;
/// callers must construct another point when either value or branch changes.
/// There is no lookup, cross-trial cache, held derivative or EOS approximation.
/// Private fields prevent pairing an arbitrary WaterPoint with another branch.
#[derive(Clone, Copy, Debug)]
pub struct CaloricLinearization {
    branch: Branch,
    kind: Caloric,
    point: WaterPoint,
    /// FIELD_* bits evaluated beyond the caloric state.
    fields: i32,
}
impl CaloricLinearization {
    pub fn internal_energy(branch: Branch, p: f64, u: f64) -> Result<Self, Error> {
        Self::internal_energy_in(Domain::Operating, branch, p, u)
    }

    pub fn enthalpy(branch: Branch, p: f64, h: f64) -> Result<Self, Error> {
        Self::enthalpy_in(Domain::Operating, branch, p, h)
    }

    /// [`Self::internal_energy`] in a declared pressure domain.
    pub fn internal_energy_in(
        domain: Domain,
        branch: Branch,
        p: f64,
        u: f64,
    ) -> Result<Self, Error> {
        Self::new(domain, branch, p, u, Caloric::Internal, FIELDS_ALL)
    }

    /// [`Self::enthalpy`] in a declared pressure domain.
    pub fn enthalpy_in(domain: Domain, branch: Branch, p: f64, h: f64) -> Result<Self, Error> {
        Self::new(domain, branch, p, h, Caloric::Enthalpy, FIELDS_ALL)
    }

    /// The same inverse (the same iterates and selected state) evaluating
    /// only the thermodynamic fields and viscosity: in `point()`, cv,
    /// conductivity and the saturation slope are NaN, never zero. Every
    /// evaluated field is bit for bit the complete inverse's.
    pub fn thermodynamic(
        branch: Branch,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<Self, Error> {
        Self::thermodynamic_in(Domain::Operating, branch, p, target, enthalpy)
    }

    /// [`Self::thermodynamic`] in a declared pressure domain.
    pub fn thermodynamic_in(
        domain: Domain,
        branch: Branch,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<Self, Error> {
        let kind = if enthalpy {
            Caloric::Enthalpy
        } else {
            Caloric::Internal
        };
        Self::new(domain, branch, p, target, kind, FIELDS_THERMODYNAMIC)
    }

    fn new(
        domain: Domain,
        branch: Branch,
        p: f64,
        target: f64,
        kind: Caloric,
        fields: i32,
    ) -> Result<Self, Error> {
        domain.admit(p)?;
        if sbtl() {
            return Ok(Self {
                branch,
                kind,
                point: sbtl_inverse(branch, p, target, kind)?,
                fields: FIELDS_ALL,
            });
        }
        Ok(Self {
            branch,
            kind,
            point: invert_caloric(branch, p, target, kind, fields)?,
            fields,
        })
    }

    pub fn point(self) -> WaterPoint {
        self.point
    }

    /// Whether every field is evaluated.
    pub fn is_complete(self) -> bool {
        self.fields == FIELDS_ALL
    }

    /// This point with every field evaluated: bit for bit the complete
    /// inverse's point for the same inputs, from the held caloric state
    /// without inverting again.
    pub fn completed(self) -> Result<Self, Error> {
        if self.is_complete() {
            return Ok(self);
        }
        Ok(Self {
            point: complete(&self.point)?,
            fields: FIELDS_ALL,
            ..self
        })
    }

    /// The exact thermodynamic part of `directional`: temperature, density,
    /// internal energy and enthalpy bit for bit, without the coefficient
    /// probes; it needs only the thermodynamic fields.
    pub fn exact_directional(self, dp: f64, dtarget: f64) -> Result<[f64; 4], Error> {
        if !dp.is_finite() || !dtarget.is_finite() {
            return Err(Error::Domain);
        }
        if dp == 0. && dtarget == 0. {
            return Ok([0.; 4]);
        }
        if sbtl() {
            let d = self.sbtl_directional(dp, dtarget)?;
            return Ok([
                d.temperature_k,
                d.density_kg_m3,
                d.internal_energy_j_kg,
                d.enthalpy_j_kg,
            ]);
        }
        let (up, ut) = self.kind.partials(self.point);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        let d = exact_held(self.branch, &self.point, dp, (dtarget - up * dp) / ut)?;
        Ok([
            d.temperature_k,
            d.density_kg_m3,
            d.internal_energy_j_kg,
            d.enthalpy_j_kg,
        ])
    }

    /// Same implicit caloric tangent and native coefficient probes as the
    /// one-shot directional_pu/ph calls, without repeating the inverse solve.
    /// A zero direction consumes no derivative and needs no native query.
    pub fn directional(self, dp: f64, dtarget: f64) -> Result<WaterPoint, Error> {
        if !dp.is_finite() || !dtarget.is_finite() {
            return Err(Error::Domain);
        }
        if dp == 0. && dtarget == 0. {
            return Ok(WaterPoint::default());
        }
        if sbtl() {
            return self.sbtl_directional(dp, dtarget);
        }
        // The coefficient probes may read the held point's every field.
        let held = self.completed()?;
        let (up, ut) = held.kind.partials(held.point);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        // The held point is the forward point at exactly (branch, its p, its
        // T), the saturated-endpoint bracket included, so it is not repeated.
        directional_held(held.branch, &held.point, dp, (dtarget - up * dp) / ut)
    }

    /// SBTL: the implicit derivative of the spline inverse at this point,
    /// then every field's analytic direction (no Gibbs identity, no probe).
    fn sbtl_directional(self, dp: f64, dtarget: f64) -> Result<WaterPoint, Error> {
        let mut direction = WaterPoint::default();
        let enthalpy = matches!(self.kind, Caloric::Enthalpy) as i32;
        // SAFETY: `point` is a live shared C-layout tuple that C only reads;
        // `direction` is a unique live stack output written on success.
        native_status(unsafe {
            ld01_sbtl_inverse_direction(
                self.branch as i32,
                &self.point,
                enthalpy,
                dp,
                dtarget,
                &mut direction,
            )
        })?;
        Ok(direction)
    }

    /// The accepted point's band report on its requested branch.
    pub fn band(self) -> BandReport {
        band_check(self.branch, &self.point)
    }
}

#[derive(Clone, Copy, Debug)]
enum Caloric {
    Internal,
    Enthalpy,
}
impl Caloric {
    fn value(self, q: WaterPoint) -> f64 {
        match self {
            Self::Internal => q.internal_energy_j_kg,
            Self::Enthalpy => q.enthalpy_j_kg,
        }
    }
    fn partials(self, q: WaterPoint) -> (f64, f64) {
        let a = q.expansion_per_k;
        let r = q.density_kg_m3;
        match self {
            Self::Internal => (
                (q.pressure_pa * q.compressibility_per_pa - q.temperature_k * a) / r,
                q.cp_j_kg_k - q.pressure_pa * a / r,
            ),
            Self::Enthalpy => ((1. - q.temperature_k * a) / r, q.cp_j_kg_k),
        }
    }
}
/// One end of an inverse bracket: the branch and temperature it is evaluated at.
type End = (Branch, f64);

/// The native branch ends at `p`: the stable end (the saturated endpoint;
/// the adapter no longer returns region 1's 623.15 K end, since region 3 near
/// saturation is admitted) and the trial end of the bounded metastable band,
/// if the branch has one at `p`.
fn branch_ends(branch: Branch, p: f64) -> Result<(End, Option<f64>), Error> {
    let (mut stable_branch, mut stable_t, mut trial_t) = (0, 0., 0.);
    // SAFETY: three unique live scalar outputs, written on success and
    // retained nowhere; the native function catches every C++ exception.
    let status = unsafe {
        ld01_water_bracket(
            branch as i32,
            p,
            &mut stable_branch,
            &mut stable_t,
            &mut trial_t,
        )
    };
    match status {
        0 => {}
        1 => return Err(Error::Domain),
        2 => return Err(Error::AbiArgument),
        _ => return Err(Error::NativeFailure),
    }
    let stable = match stable_branch {
        0 => Branch::Liquid,
        2 => Branch::SaturatedLiquid,
        3 => Branch::SaturatedVapor,
        _ => return Err(Error::NativeFailure),
    };
    Ok(((stable, stable_t), (!trial_t.is_nan()).then_some(trial_t)))
}

/// The SBTL caloric inverse: the reference inverse's brackets and refusals
/// with an exact root of the table's cell polynomial (water archive).
fn sbtl_inverse(branch: Branch, p: f64, target: f64, kind: Caloric) -> Result<WaterPoint, Error> {
    if !target.is_finite() {
        return Err(Error::Domain);
    }
    if !matches!(branch, Branch::Liquid | Branch::Vapor) {
        return Err(Error::AbiArgument);
    }
    let mut output = WaterPoint::default();
    let enthalpy = matches!(kind, Caloric::Enthalpy) as i32;
    // SAFETY: as `sbtl_point`.
    native_status(unsafe { ld01_sbtl_inverse(branch as i32, p, target, enthalpy, &mut output) })?;
    Ok(output)
}

fn invert_caloric(
    branch: Branch,
    p: f64,
    target: f64,
    kind: Caloric,
    fields: i32,
) -> Result<WaterPoint, Error> {
    if !target.is_finite() {
        return Err(Error::Domain);
    }
    if !matches!(branch, Branch::Liquid | Branch::Vapor) {
        return Err(Error::AbiArgument);
    }
    // These are the normative IF97 R1/R2 temperature bounds already selected
    // by this boundary. Pressure/domain admission remains in the native EOS.
    let (stable, trial) = branch_ends(branch, p)?;
    let liquid = matches!(branch, Branch::Liquid);
    let far: End = if liquid {
        (branch, 273.15)
    } else {
        (branch, 1073.15)
    };
    // Brackets and iterates read only the caloric state; the returned state
    // is the forward point at the selected temperature, completed from the
    // caloric state already evaluated there. The stable end comes first: it
    // decides the metastable side exactly.
    let end = caloric_state(stable.0, p, stable.1)?;
    // Beyond the stable end the target can only be a metastable state of the
    // requested branch: it is bracketed by that end and the trial end, and a
    // target beyond the trial end is refused, never clamped.
    if (liquid && target > kind.value(end)) || (!liquid && target < kind.value(end)) {
        let trial = trial.ok_or(Error::TrialBand)?;
        let edge = caloric_state(branch, p, trial)?;
        if (liquid && target > kind.value(edge)) || (!liquid && target < kind.value(edge)) {
            return Err(Error::TrialBand);
        }
        let (low, high) = if liquid {
            ((stable, end), ((branch, trial), edge))
        } else {
            (((branch, trial), edge), (stable, end))
        };
        return newton(
            branch,
            p,
            target,
            kind,
            fields,
            low,
            high,
            line(stable, &end),
        );
    }
    if target == kind.value(end) {
        return complete_fields(&end, fields);
    }
    // The stable side: Newton from the stable end. Only a converged state
    // inside the stable temperature range, clear of both of its limits, is
    // taken; otherwise the full bracket below re-solves, and alone decides a
    // refusal.
    if let Some(q) = from_stable_end(branch, p, target, kind, &end, far.1, line(stable, &end)) {
        return complete_fields(&q, fields);
    }
    let far_state = caloric_state(far.0, p, far.1)?;
    let (low, high) = if liquid {
        ((far, far_state), (stable, end))
    } else {
        ((stable, end), (far, far_state))
    };
    if target < kind.value(low.1) || target > kind.value(high.1) {
        return Err(Error::Domain);
    }
    newton(branch, p, target, kind, fields, low, high, None)
}

/// The saturation line's temperature at `p` when the branch's stable end is
/// its saturated endpoint (not region 1's 623.15 K limit).
fn line((branch, _): End, end: &WaterPoint) -> Option<f64> {
    matches!(branch, Branch::SaturatedLiquid | Branch::SaturatedVapor).then_some(end.temperature_k)
}

/// Whether a converged state lies within `END_MARGIN_K` of the saturation
/// line, where the inverse continues to round-off (DR S3-REBIRTH): there a
/// state accepted at the declared tolerance carries up to that tolerance in
/// its density, about 1e-11 relative, varying from one target to the next,
/// and a cell exhausted onto its endpoint is projected there to 1e-12.
fn near_line(q: &WaterPoint, line: Option<f64>) -> bool {
    line.is_some_and(|ts| (q.temperature_k - ts).abs() <= END_MARGIN_K)
}

/// The inverse's declared convergence test: the energy defect within 2e-12
/// of the target's magnitude or of the local thermal energy scale `u_T T`.
fn converged(defect: f64, target: f64, ut: f64, t: f64) -> bool {
    // An arbitrary EOS datum can make target U zero without making the
    // attainable numerical precision or the heat capacity zero.
    defect.abs() <= 2e-12 * target.abs().max(ut * t).max(1.)
}

/// A converged state within this of either temperature limit of the stable
/// branch is re-solved on the full bracket. At the far limit the bracket's
/// comparison decides a refusal; at the stable end (saturation, or region 1's
/// 623.15 K limit) the adapter's branch checks can refuse states within a few
/// ulps of the end, which the bracket's own iterates may meet. The margin
/// exceeds the declared tolerance's temperature equivalent (at most about
/// 4e-9 K on either branch) by more than five orders of magnitude, and keeps
/// every iterate of the bracket for a root it admits away from either limit,
/// so a state taken here is one the bracket recovers too. Within the same
/// margin of the saturation line the inverse continues Newton to round-off
/// (`near_line`): the line's own neighbourhood is then smooth in p and u.
const END_MARGIN_K: f64 = 1e-3;

/// Newton on the stable side from the stable end, whose own Newton step is
/// the first iterate: a deterministic function of (branch, p, target) only.
/// Near the stable end the caloric function's curvature (cp rising toward
/// the liquid's saturation, falling away from the vapor's) keeps the
/// iterates on the end's side of the root; nothing here relies on that.
/// Returns `None`, never an error, when an iterate leaves the open stable
/// temperature range, an iterate is refused, the partial is not positive,
/// no iterate converges within 32, or the converged state is within
/// `END_MARGIN_K` of either limit, except the saturation line `line`: there
/// it continues while each Newton step strictly lowers the energy defect and
/// returns the state of least defect, the root to round-off.
fn from_stable_end(
    branch: Branch,
    p: f64,
    target: f64,
    kind: Caloric,
    end: &WaterPoint,
    far_t: f64,
    line: Option<f64>,
) -> Option<WaterPoint> {
    let liquid = matches!(branch, Branch::Liquid);
    let (low_t, high_t) = if liquid {
        (far_t, end.temperature_k)
    } else {
        (end.temperature_k, far_t)
    };
    let (_, ut) = kind.partials(*end);
    if !ut.is_finite() || ut <= 0. {
        return None;
    }
    let mut t = end.temperature_k + (target - kind.value(*end)) / ut;
    let mut best: Option<WaterPoint> = None;
    for _ in 0..32 {
        if !(t > low_t && t < high_t) {
            return best;
        }
        let Some(q) = caloric_state(branch, p, t).ok() else {
            return best;
        };
        let defect = kind.value(q) - target;
        let (_, ut) = kind.partials(q);
        if !ut.is_finite() || ut <= 0. {
            return best;
        }
        if let Some(b) = best {
            if defect.abs() >= (kind.value(b) - target).abs() {
                return best;
            }
            best = Some(q);
        } else if converged(defect, target, ut, q.temperature_k) {
            let clear =
                q.temperature_k > low_t + END_MARGIN_K && q.temperature_k < high_t - END_MARGIN_K;
            if clear {
                return Some(q);
            }
            if !near_line(&q, line) {
                return None;
            }
            best = Some(q);
        }
        if defect == 0. && best.is_some() {
            return best;
        }
        t -= defect / ut;
    }
    best
}

/// Safeguarded Newton inside one bracket whose ends were evaluated as given.
/// The returned point is the forward point at the selected end or
/// temperature, completed with `fields` from the caloric state evaluated there.
/// A converged state within `END_MARGIN_K` of the saturation line `line`
/// continues while each step strictly lowers the energy defect; the state of
/// least defect is returned.
#[allow(clippy::too_many_arguments)] // The bracket's two ends and the line.
fn newton(
    branch: Branch,
    p: f64,
    target: f64,
    kind: Caloric,
    fields: i32,
    (_, mut low): (End, WaterPoint),
    (_, mut high): (End, WaterPoint),
    line: Option<f64>,
) -> Result<WaterPoint, Error> {
    if target == kind.value(low) {
        return complete_fields(&low, fields);
    }
    if target == kind.value(high) {
        return complete_fields(&high, fields);
    }
    let mut t = low.temperature_k
        + (high.temperature_k - low.temperature_k) * (target - kind.value(low))
            / (kind.value(high) - kind.value(low));
    // Safeguarded Newton uses the actual thermodynamic partial. Bisection is
    // only a root-finding safeguard, never a replacement EOS value or state.
    // The bound is a numerical termination guard, not a simulation timestep.
    let mut best: Option<WaterPoint> = None;
    for _ in 0..64 {
        let q = match (caloric_state(branch, p, t), best) {
            (Ok(q), _) => q,
            (Err(_), Some(b)) => return complete_fields(&b, fields),
            (Err(e), None) => return Err(e),
        };
        let defect = kind.value(q) - target;
        let (_, ut) = kind.partials(q);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        if let Some(b) = best {
            if defect.abs() >= (kind.value(b) - target).abs() {
                return complete_fields(&b, fields);
            }
            best = Some(q);
            if defect == 0. {
                return complete_fields(&q, fields);
            }
        } else if converged(defect, target, ut, q.temperature_k) {
            // Use the local thermal energy scale as well as the energy value.
            if !near_line(&q, line) || defect == 0. {
                return complete_fields(&q, fields);
            }
            best = Some(q);
        }
        if defect < 0. {
            low = q;
        } else {
            high = q;
        }
        let proposed = t - defect / ut;
        t = if proposed > low.temperature_k && proposed < high.temperature_k {
            proposed
        } else {
            (low.temperature_k + high.temperature_k) / 2.
        };
    }
    match best {
        Some(b) => complete_fields(&b, fields),
        None => Err(Error::NativeFailure),
    }
}

/// The artifact's compiled `ld01-metastable-band` values, as the native
/// boundary applies them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct MetastableBand {
    pub pressure_low_pa: f64,
    pub pressure_high_pa: f64,
    pub trial_max_k: f64,
    pub liquid_superheat_max_k: f64,
    pub vapor_subcooling_max_k: f64,
    pub credited_max_k: f64,
    pub liquid_temperature_max_k: f64,
    pub liquid_pressure_ceiling_pa: f64,
    pub vapor_pressure_ceiling_pa: f64,
    pub lower_bound_exclusive: i32,
}
impl MetastableBand {
    pub fn compiled() -> Self {
        let mut band = Self::default();
        // SAFETY: one unique live C-layout output, written completely; the
        // native function only copies its compiled constants into it.
        let status = unsafe { ld01_water_metastable_band(&mut band) };
        assert_eq!(status, 0, "compiled metastable band unavailable");
        band
    }
}

/// Where an accepted state lies relative to saturation on its own branch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Band {
    /// Saturated, or on the stable side of saturation for its branch.
    Stable,
    /// Metastable inside the admitted band; `credited` within `creditedMax_K`.
    Admitted { credited: bool },
    /// Metastable beyond the admitted band (reachable only as a trial state).
    Exceeded,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandReport {
    /// Signed departure `T - Tsat(p)` on the state's branch.
    pub departure_k: f64,
    pub band: Band,
}

/// Band check of an ACCEPTED state on its requested branch: liquid superheat
/// at most `liquidSuperheatMax_K`, vapor subcooling at most
/// `vaporSubcoolingMax_K`. It classifies and reports; it never clamps, refuses
/// or enters a residual.
pub fn band_check(branch: Branch, point: &WaterPoint) -> BandReport {
    let band = MetastableBand::compiled();
    let departure = point.saturation_departure_k;
    let (metastable, limit) = match branch {
        Branch::Liquid => (departure, band.liquid_superheat_max_k),
        Branch::Vapor => (-departure, band.vapor_subcooling_max_k),
        Branch::SaturatedLiquid | Branch::SaturatedVapor => (0., 0.),
    };
    let band = if metastable <= 0. {
        Band::Stable
    } else if metastable <= limit {
        Band::Admitted {
            credited: metastable <= band.credited_max_k,
        }
    } else {
        Band::Exceeded
    };
    BandReport {
        departure_k: departure,
        band,
    }
}

/// Implicit p/u direction through the same local EOS inversion. Exact first
/// thermo partials determine T'; coefficient directions retain the existing
/// adapter's disclosed same-branch accuracy. No cross-trial cache is used.
pub fn directional_pu(
    branch: Branch,
    p: f64,
    u: f64,
    dp: f64,
    du: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    directional_caloric(branch, p, u, dp, du, Caloric::Internal)
}

pub fn directional_ph(
    branch: Branch,
    p: f64,
    h: f64,
    dp: f64,
    dh: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    directional_caloric(branch, p, h, dp, dh, Caloric::Enthalpy)
}
fn directional_caloric(
    branch: Branch,
    p: f64,
    target: f64,
    dp: f64,
    dtarget: f64,
    kind: Caloric,
) -> Result<(WaterPoint, WaterPoint), Error> {
    if !dp.is_finite() || !dtarget.is_finite() {
        return Err(Error::Domain);
    }
    let q = CaloricLinearization::new(Domain::Operating, branch, p, target, kind, FIELDS_ALL)?;
    Ok((q.point(), q.directional(dp, dtarget)?))
}

/// G1-C13 hook (lib.rs, shared; KERN reconciles): IF97 saturation pressure
/// `p_sat(T)` and its direction along `dt` (`dt / (dT_sat/dp)`), for the
/// containment's ideal-vapor saturation density `p_sat(T)/(R_v T)`.
pub fn saturation_pressure(t: f64, dt: f64) -> Result<(f64, f64), Error> {
    let mut value = 0.;
    let mut direction = 0.;
    // SAFETY: two unique live scalar outputs; C keeps no pointers/catches errors.
    let status = unsafe { ld01_water_saturation_pressure(t, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// G1-C13 hook (lib.rs, shared; KERN reconciles): IF97 saturated-vapor
/// enthalpy at `t` on the saturation endpoint, outside the operating 0.1 MPa
/// floor; value only (the containment's 25°C vapor caloric anchor).
pub fn saturated_vapor_enthalpy(t: f64) -> Result<f64, Error> {
    if sbtl() {
        let (p, _) = saturation_pressure(t, 0.)?;
        return sbtl_point(Branch::SaturatedVapor, p, 0.).map(|q| q.enthalpy_j_kg);
    }
    let mut value = 0.;
    // SAFETY: one unique live scalar output; C keeps no pointer/catches errors.
    let status = unsafe { ld01_water_saturated_vapor_enthalpy(t, &mut value) };
    match status {
        0 => Ok(value),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// G1-C13 hook (lib.rs, shared; KERN reconciles): IF97 saturated-vapor
/// dynamic viscosity at `t` on the endpoint below the operating 0.1 MPa
/// floor, with the adapter's disclosed central-difference direction.
pub fn saturated_vapor_viscosity(t: f64, dt: f64) -> Result<(f64, f64), Error> {
    if sbtl() {
        // Along saturation: dp = (dp_sat/dT) dt, the spline's analytic direction.
        let (p, dp) = saturation_pressure(t, dt)?;
        return sbtl_direction(Branch::SaturatedVapor, p, 0., dp, 0.)
            .map(|(q, d)| (q.viscosity_pa_s, d.viscosity_pa_s));
    }
    let mut value = 0.;
    let mut direction = 0.;
    // SAFETY: two unique live scalar outputs; C keeps no pointers/catches errors.
    let status = unsafe { ld01_water_saturated_vapor_viscosity(t, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

pub fn surface_tension(t: f64, dt: f64) -> Result<(f64, f64), Error> {
    let mut value = 0.;
    let mut direction = 0.;
    // SAFETY: two unique live scalar outputs; C keeps no pointers/catches errors.
    let status = unsafe { ld01_water_surface(t, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// Actual property adapter consumed by the native thermal residual/JVP: the
/// operating domain (`p >= 0.1 MPa`). It serves the process's selected water
/// method ([`water_method`]): the IF97 reference or its SBTL tables. The name
/// stays `If97` at WORLD's sites for now (lead, 1 Nov); under SBTL it is the
/// tables'.
pub struct If97;
/// The same adapter for an owner that declares a low-pressure domain
/// (S4-D2, owner decision F5): `p >= 611.657 Pa` ([`Domain::LowPressure`]).
pub struct If97LowPressure;
fn thermal_point(q: WaterPoint, d: WaterPoint) -> leitbild_operating_plant::thermal::WaterPoint {
    use leitbild_operating_plant::thermal::{Scalar, WaterPoint as ThermalPoint};
    ThermalPoint {
        density: Scalar::new(q.density_kg_m3, d.density_kg_m3),
        viscosity: Scalar::new(q.viscosity_pa_s, d.viscosity_pa_s),
        conductivity: Scalar::new(q.conductivity_w_m_k, d.conductivity_w_m_k),
        cp: Scalar::new(q.cp_j_kg_k, d.cp_j_kg_k),
        expansion: Scalar::new(q.expansion_per_k, d.expansion_per_k),
        enthalpy: Scalar::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    }
}
/// A state's first answer `(seed bits, value, direction)` until a second
/// seed asks; then its value and two basis partials.
#[derive(Clone, Copy)]
enum BasisHeld {
    Once((u64, u64), WaterPoint, WaterPoint),
    Basis(WaterPoint, WaterPoint, WaterPoint),
}
thread_local! {
    static BASIS: std::cell::RefCell<std::collections::HashMap<(u8, i32, u64, u64), BasisHeld>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static BASIS_ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
/// PERF (plan r4, R4-WATER-PARTIALS): hold the thermal laws' directional
/// (p, T) water points' basis partials for one block Jacobian assembly
/// (`on`), starting empty; off, every query is the native call.
pub fn basis_assembly(on: bool) {
    BASIS.with(|b| b.borrow_mut().clear());
    BASIS_ON.with(|b| b.set(on));
}
/// PERF (plan r4, R4-WATER-PARTIALS): inside an assembly, a directional
/// (p, T) point asked at a second distinct seed is its value plus
/// `dp D_p + dt D_t` of its two basis partials (`D_p` at seed (1, 0), `D_t`
/// at (0, 1)), computed once per exact state of the assembly; a state asked
/// once keeps the native answer. Exact in arithmetic: the native direction is
/// that linear map; the combination rounds once more.
fn directional_basis(
    domain: Domain,
    branch: Branch,
    p: f64,
    t: f64,
    dp: f64,
    dt: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    // SBTL directions are the analytic spline derivative, linear in the seed:
    // no basis is held.
    if sbtl() || !BASIS_ON.with(|b| b.get()) {
        return directional_in(domain, branch, p, t, dp, dt);
    }
    let key = (domain as u8, branch as i32, p.to_bits(), t.to_bits());
    let seed = (dp.to_bits(), dt.to_bits());
    let held = BASIS.with(|b| b.borrow().get(&key).copied());
    // A state asked once is the native answer itself; the basis is made at
    // its second distinct seed.
    let (q, a, b) = match held {
        None => {
            let (q, d) = directional_in(domain, branch, p, t, dp, dt)?;
            BASIS.with(|s| s.borrow_mut().insert(key, BasisHeld::Once(seed, q, d)));
            return Ok((q, d));
        }
        Some(BasisHeld::Once(s0, q, d)) if s0 == seed => return Ok((q, d)),
        Some(BasisHeld::Once(..)) => {
            let (q, a) = directional_in(domain, branch, p, t, 1., 0.)?;
            let (_, b) = directional_in(domain, branch, p, t, 0., 1.)?;
            BASIS.with(|s| s.borrow_mut().insert(key, BasisHeld::Basis(q, a, b)));
            (q, a, b)
        }
        Some(BasisHeld::Basis(q, a, b)) => (q, a, b),
    };
    let f = |x: f64, y: f64| dp * x + dt * y;
    let d = WaterPoint {
        region: a.region,
        pressure_pa: f(a.pressure_pa, b.pressure_pa),
        temperature_k: f(a.temperature_k, b.temperature_k),
        density_kg_m3: f(a.density_kg_m3, b.density_kg_m3),
        internal_energy_j_kg: f(a.internal_energy_j_kg, b.internal_energy_j_kg),
        enthalpy_j_kg: f(a.enthalpy_j_kg, b.enthalpy_j_kg),
        cp_j_kg_k: f(a.cp_j_kg_k, b.cp_j_kg_k),
        cv_j_kg_k: f(a.cv_j_kg_k, b.cv_j_kg_k),
        expansion_per_k: f(a.expansion_per_k, b.expansion_per_k),
        compressibility_per_pa: f(a.compressibility_per_pa, b.compressibility_per_pa),
        viscosity_pa_s: f(a.viscosity_pa_s, b.viscosity_pa_s),
        conductivity_w_m_k: f(a.conductivity_w_m_k, b.conductivity_w_m_k),
        saturation_slope_k_pa: f(a.saturation_slope_k_pa, b.saturation_slope_k_pa),
        saturation_departure_k: f(a.saturation_departure_k, b.saturation_departure_k),
    };
    Ok((q, d))
}

/// The thermal water boundary of one declared pressure domain.
macro_rules! thermal_water_properties {
    ($water:ty, $domain:expr) => {
        impl leitbild_operating_plant::thermal::WaterProperties for $water {
            fn liquid(
                &self,
                p: leitbild_operating_plant::thermal::Scalar,
                t: leitbild_operating_plant::thermal::Scalar,
            ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::WaterPoint>
            {
                let (q, d) = directional_basis($domain, Branch::Liquid, p.value, t.value, p.direction, t.direction)
                    .map_err(|_| "maintained IF97 liquid domain/derivative")?;
                Ok(thermal_point(q, d))
            }
            fn vapor(
                &self,
                p: leitbild_operating_plant::thermal::Scalar,
                t: leitbild_operating_plant::thermal::Scalar,
            ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::WaterPoint>
            {
                let (q, d) = directional_basis($domain, Branch::Vapor, p.value, t.value, p.direction, t.direction)
                    .map_err(|_| "maintained IF97 vapor domain/derivative")?;
                Ok(thermal_point(q, d))
            }
            fn saturation(
                &self,
                p: leitbild_operating_plant::thermal::Scalar,
            ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::Saturation>
            {
                use leitbild_operating_plant::thermal::{Saturation, Scalar};
                let (l, dl) = directional_basis($domain, Branch::SaturatedLiquid, p.value, 0., p.direction, 0.)
                    .map_err(|_| "maintained IF97 saturation liquid")?;
                let (g, dg) = directional_basis($domain, Branch::SaturatedVapor, p.value, 0., p.direction, 0.)
                    .map_err(|_| "maintained IF97 saturation vapor")?;
                let (sigma, dsigma) = surface_tension(l.temperature_k, dl.temperature_k)
                    .map_err(|_| "maintained IF97 surface tension")?;
                Ok(Saturation {
                    temperature: Scalar::new(l.temperature_k, dl.temperature_k),
                    liquid: thermal_point(l, dl),
                    vapor: thermal_point(g, dg),
                    surface_tension: Scalar::new(sigma, dsigma),
                })
            }
            fn saturated_vapor_density(
                &self,
                t: leitbild_operating_plant::thermal::Scalar,
            ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::Scalar> {
                if sbtl() {
                    let (p, dp) = saturation_pressure(t.value, t.direction)
                        .map_err(|_| "SBTL wall saturation pressure")?;
                    let (q, d) = sbtl_direction(Branch::SaturatedVapor, p, 0., dp, 0.)
                        .map_err(|_| "SBTL wall saturation density")?;
                    return Ok(leitbild_operating_plant::thermal::Scalar::new(
                        q.density_kg_m3,
                        d.density_kg_m3,
                    ));
                }
                let mut value = 0.;
                let mut direction = 0.;
                // SAFETY: unique scalar outputs, no retained pointer; checked native
                // saturation call catches exceptions, using its actual inverse slope.
                let status = unsafe {
                    ld01_water_vapor_sat_density(t.value, t.direction, &mut value, &mut direction)
                };
                if status != 0 {
                    return Err("maintained IF97 wall saturation density");
                }
                Ok(leitbild_operating_plant::thermal::Scalar::new(
                    value, direction,
                ))
            }
        }
    };
}
thermal_water_properties!(If97, Domain::Operating);
thermal_water_properties!(If97LowPressure, Domain::LowPressure);

impl WaterPoint {
    /// Exact thermodynamic first partials at this branch; viscosity/conductivity
    /// derivatives are not invented here. The thermal join must supply those
    /// additional local coefficient derivatives when assembling its Jacobian.
    pub fn phase_point(self) -> leitbild_operating_plant::phase::Point {
        let p = self.pressure_pa;
        let t = self.temperature_k;
        let r = self.density_kg_m3;
        let a = self.expansion_per_k;
        let k = self.compressibility_per_pa;
        leitbild_operating_plant::phase::Point {
            pressure_pa: p,
            temperature_k: t,
            density_kg_m3: r,
            internal_energy_j_kg: self.internal_energy_j_kg,
            enthalpy_j_kg: self.enthalpy_j_kg,
            density_pressure: r * k,
            density_temperature: -r * a,
            energy_pressure: (p * k - t * a) / r,
            energy_temperature: self.cp_j_kg_k - p * a / r,
        }
    }
}

// ELEC S3 hook (lib.rs, shared): the electrical slice appended to a joined system.
#[cfg(feature = "ida")]
pub mod electrical;
#[cfg(feature = "ida")]
pub mod frame;
#[cfg(feature = "ida")]
pub mod ic;
#[cfg(feature = "ida")]
pub mod ida;
#[cfg(feature = "ida")]
pub mod joined;
#[cfg(feature = "quadratures")]
pub mod joined_ledger;
#[cfg(feature = "ida")]
pub mod klu;
pub mod network;
#[cfg(target_os = "macos")]
pub mod spectrum;
#[cfg(feature = "ida")]
pub mod unit;

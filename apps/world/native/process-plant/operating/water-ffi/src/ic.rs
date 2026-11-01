//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/operational-observations.md#operating-model-observation-handoff
//! spec: world/packs/process-plant/reference-designs/ld-01/safety/reactor-trip-and-hold.md#protection-divisions-and-request-ownership
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/instrumentation/nuclear-observation-apparatus.md#one-original-world-reference-not-ongoing-gain-adjustment
//! The acquired protection as a frame-driver client of the joined
//! operator. Each family's quantity is a function of the solver
//! coordinates:
//! - **linear** (the PZR roof pressure; an SG's collapsed level `V_l / area`):
//!   its polynomial on an accepted step is read exactly from the step's
//!   dense output;
//! - **nonlinear** (a loop's cold-return mass flow over its nominal; the
//!   current proxy): evaluated from the coordinates at the step's
//!   Chebyshev–Lobatto nodes (as many as the step's order plus one, at
//!   least two) and continued under that interpolant, the same degree as the
//!   integrator's own polynomial. The lag is exact for the interpolant. The
//!   nodes lie in the step's own coordinate `s = t - from`, their states
//!   taken from the step polynomial's Taylor coefficients at its start, so
//!   a step of a few ulps keeps distinct nodes.
//!
//! The loop flow is the cold-return face's phase-0 path, from the network's
//! own law: `Q = I / Σ M_s w_s / V_s` over the face's momentum supports and
//! `m = (M_donor / V_donor) Q` with the donor by the sign of `Q` (fixed
//! cells; a cell whose volume moves is refused). The current proxy is
//! S3-D7's ratio form `(E_c / E_c,ref) (E_tot,ref / Fref)` with each
//! region's event rate `N_i Σ_k P_k X_a / X_a,ref` (the kinetics' achieved
//! fissions). Both references (the loop's installed nominal and `E_ref`) are
//! taken at the packet's prepared hot reference, the composition's start.
//! The holding loss the path decides becomes the class-R command
//! `HoldingLoss` at its frame instant; the interlock's turbine trip that
//! follows it (owner R12-A2) becomes the declared `TurbineTripAcquired` at
//! its own frame instant.
use crate::frame::{Action, Change, Class, Client, Dense};
use crate::joined::JoinedSystem;
use leitbild_operating_plant::{
    ic::{
        acquisition::Overrange,
        packet::{Quantity, ReportSource, Section, SgFlow},
        protection::Protection,
    },
    joined::{block::Command, operator::Joined},
    network::{PZR_PRESSURE, Properties, ports::G, stratified},
    thermal::{Scalar, WaterProperties},
};
use serde_json::{Value, json};

/// The holding loss's counting kind.
pub const HOLDING_LOSS: &str = "LD01.TRIP.HOLD loss";

/// One source region of the current proxy: population index, its scale,
/// the converter weight and its supports as (fissile index, scale,
/// `P / X_ref`).
type ProxyRegion = (usize, f64, f64, Vec<(usize, f64, f64)>);

/// One observed quantity as a function of the solver coordinates.
#[derive(Clone, Debug)]
enum Observation {
    /// `Σ c_i y_i`.
    Linear(Vec<(usize, f64)>),
    /// A loop's mass flow over `nominal`.
    LoopFlow {
        impulse: (usize, f64),
        from: (usize, f64, f64),
        to: (usize, f64, f64),
        /// Phase-0 mass coordinate, its scale and `w / V` per support.
        supports: Vec<(usize, f64, f64)>,
        nominal: f64,
    },
    /// The PZR LT indication: the stratified cell's tap pressures from its
    /// coordinates (`base`, `scales`), `L = a (p_low − p_high) + b`.
    PzrLevel {
        cell: Box<stratified::Cell>,
        base: usize,
        scales: Vec<f64>,
        a: f64,
        b: f64,
        span: [f64; 2],
    },
    /// The current proxy: per region (population index, scale, weight,
    /// supports as (fissile index, scale, `P / X_ref`)), and the factor
    /// `E_tot,ref / (Fref E_c,ref)`.
    Proxy {
        regions: Vec<ProxyRegion>,
        factor: f64,
    },
    /// Plan r4 X4.2: a CVCS branch's delivered flow at its stem and COLD.A's
    /// pressure (coordinate, scale each), by the owner's own law in the
    /// owner's live modes: `cvcs` is the owner as composed, replaced by the
    /// joined operator's after every restart ([`Client::restarted`]), so a
    /// located or commanded stop is read from its instant on.
    CvcsFlow {
        cvcs: Box<leitbild_operating_plant::joined::cvcs::Cvcs>,
        branch: leitbild_operating_plant::joined::cvcs::Branch,
        stem: (usize, f64),
        pressure: (usize, f64),
    },
    /// `LD01.TG.STOP.POS`: the STOP's stroke in percent, a function of time
    /// and the latched TRIP (`trip_s`, refreshed after every restart), never
    /// of a coordinate.
    StopPosition { trip_s: Option<f64>, travel_s: f64 },
    /// Plan r4 X4 (`LD01.CORE.CET`, `LD01.UPPER.DP`): liquid read through
    /// the property boundary at the step's nodes. Each cell is (pressure,
    /// liquid mass, liquid energy, vapor mass) as (coordinate, scale).
    Liquid {
        cells: Vec<[(usize, f64); 4]>,
        ids: Vec<String>,
        reading: LiquidReading,
    },
}
/// What a [`Observation::Liquid`] reports.
#[derive(Clone, Copy, Debug)]
enum LiquidReading {
    /// The mixed liquid's temperature, °C, inside the body domain.
    Temperature { body_c: [f64; 2] },
    /// One cell's liquid head `rho g height`, Pa.
    Head { height_m: f64 },
}
/// The mixed liquid of `cells` at `y`: mass-weighted pressure and summed
/// liquid energy over summed liquid mass, through the property boundary
/// (thermodynamic fields only). Vapor in a cell leaves the liquid-contact
/// reduction and is refused.
fn liquid_point(
    y: &[f64],
    cells: &[[(usize, f64); 4]],
    ids: &[String],
) -> Result<leitbild_operating_plant::network::properties::Water, String> {
    let (mut mass, mut energy, mut pm) = (0., 0., 0.);
    for (c, id) in cells.iter().zip(ids) {
        let v = |k: usize| y[c[k].0] * c[k].1;
        if v(3) != 0. {
            return Err(format!(
                "{id}: vapor {} kg leaves the liquid-contact reading",
                v(3)
            ));
        }
        mass += v(1);
        energy += v(2);
        pm += v(1) * v(0);
    }
    if !(mass > 0. && mass.is_finite()) {
        return Err(format!("liquid reading: mass {mass} kg"));
    }
    let point = Properties::caloric_for(
        &crate::If97,
        false,
        pm / mass,
        energy / mass,
        false,
        leitbild_operating_plant::network::properties::Need::Thermodynamic,
    )?;
    Ok(Properties::values(&crate::If97, &point))
}
impl Observation {
    /// The STOP's stroke at `t`, percent.
    fn stop_percent(trip_s: Option<f64>, travel_s: f64, t: f64) -> f64 {
        100. * leitbild_operating_plant::sg::secondary::steam_fraction(trip_s, travel_s, t)
    }
    fn value(&self, y: &[f64]) -> Result<f64, String> {
        match self {
            Observation::Linear(terms) => Ok(terms.iter().map(|(i, c)| y[*i] * c).sum()),
            Observation::LoopFlow {
                impulse,
                from,
                to,
                supports,
                nominal,
            } => Ok(mass_flow(y, *impulse, *from, *to, supports)? / nominal),
            Observation::Proxy { regions, factor } => Ok(factor * events(y, regions)),
            Observation::CvcsFlow {
                cvcs,
                branch,
                stem,
                pressure,
            } => cvcs
                .delivered_flow(*branch, y[stem.0] * stem.1, y[pressure.0] * pressure.1)
                .map_err(|f| format!("{f:?}")),
            Observation::PzrLevel { a, b, span, .. } => {
                let (low, high) = self.tap_pressures(y)?;
                // Each interface reads at most its span limit (status below).
                let clamp = |p: f64| p.clamp(span[0], span[1]);
                Ok(a * (clamp(low) - clamp(high)) + b)
            }
            // Fully open until a TRIP latches; after it, the stroke needs a time.
            Observation::StopPosition { trip_s: None, .. } => Ok(100.),
            Observation::StopPosition { .. } => {
                Err("the STOP position after the TRIP is read at a time, not a state".into())
            }
            Observation::Liquid {
                cells,
                ids,
                reading,
            } => {
                let w = liquid_point(y, cells, ids)?;
                match reading {
                    LiquidReading::Temperature { body_c } => {
                        let c = w.temperature_k - 273.15;
                        if !(c >= body_c[0] && c <= body_c[1]) {
                            return Err(format!(
                                "core-exit liquid {c} °C leaves the probe body's {body_c:?} °C domain"
                            ));
                        }
                        Ok(c)
                    }
                    LiquidReading::Head { height_m } => Ok(w.density_kg_m3 * G * height_m),
                }
            }
        }
    }
    /// The LT pair's tap pressures at `y`.
    fn tap_pressures(&self, y: &[f64]) -> Result<(f64, f64), String> {
        let Observation::PzrLevel {
            cell, base, scales, ..
        } = self
        else {
            return Err("not a PZR level observation".into());
        };
        let x: Vec<Scalar> = scales
            .iter()
            .enumerate()
            .map(|(i, s)| Scalar::constant(y[base + i] * s))
            .collect();
        let x = stratified::Coordinates::from_slice(&x).map_err(|f| format!("{f:?}"))?;
        let (low, high) = cell
            .level_tap_pressures(&x)
            .map_err(|f| format!("{f:?}"))?
            .ok_or("the PZR declares no LT pair")?;
        Ok((low.value, high.value))
    }
    /// The input-stage status of a PZR level device at `y`: an interface
    /// outside its span reads its span limit, and the indication is then a
    /// bound ("Select interface pressure spans 0–25 MPa and final indicated
    /// span −1 to 13 m, no clamp; valid overrange retains range status",
    /// phase-dependent-measurements.md § PZR electronic differential
    /// level). `None` for every other observation.
    fn input_overrange(&self, y: &[f64]) -> Result<Option<Overrange>, String> {
        let Observation::PzrLevel { span, .. } = self else {
            return Ok(None);
        };
        let (low, high) = self.tap_pressures(y)?;
        overrange_of(low, high, *span)
    }
    fn linear(&self) -> bool {
        matches!(self, Observation::Linear(_))
    }
    /// Read from time and an owner's latched state, not from coordinates.
    fn timed(&self) -> bool {
        matches!(self, Observation::StopPosition { .. })
    }
    /// Every solver coordinate `value` reads.
    fn coordinates(&self) -> Vec<usize> {
        match self {
            Observation::Linear(terms) => terms.iter().map(|(i, _)| *i).collect(),
            Observation::LoopFlow {
                impulse,
                from,
                to,
                supports,
                ..
            } => [impulse.0, from.0, to.0]
                .into_iter()
                .chain(supports.iter().map(|(i, _, _)| *i))
                .collect(),
            Observation::Proxy { regions, .. } => regions
                .iter()
                .flat_map(|(n, _, _, supports)| {
                    std::iter::once(*n).chain(supports.iter().map(|(x, _, _)| *x))
                })
                .collect(),
            Observation::PzrLevel { base, scales, .. } => (*base..base + scales.len()).collect(),
            Observation::CvcsFlow { stem, pressure, .. } => vec![stem.0, pressure.0],
            Observation::StopPosition { .. } => Vec::new(),
            Observation::Liquid { cells, .. } => cells
                .iter()
                .flat_map(|c| c.iter().map(|(i, _)| *i))
                .collect(),
        }
    }
}
/// The direction an LT device's indication moves past the one computed
/// from interfaces held at their span limits: the bottom (LT.LOW) interface
/// above its span or the top below raise the DP; the opposite lower it. Both
/// senses at once need both interfaces outside their 0–25 MPa spans in
/// opposite directions, beyond the maintained property domain (≤17 MPa,
/// positive pressure); that is refused rather than given a direction.
fn overrange_of(low: f64, high: f64, span: [f64; 2]) -> Result<Option<Overrange>, String> {
    let up = low > span[1] || high < span[0];
    let down = low < span[0] || high > span[1];
    match (up, down) {
        (false, false) => Ok(None),
        (true, false) => Ok(Some(Overrange::Above)),
        (false, true) => Ok(Some(Overrange::Below)),
        (true, true) => Err(format!(
            "PZR LT interfaces at {low} and {high} Pa leave their {span:?} Pa spans in opposite senses (outside the property domain)"
        )),
    }
}

/// A regular cell's (pressure, liquid mass, liquid energy, vapor mass)
/// coordinates with their scales.
fn liquid_cell<P: Properties>(
    net: &leitbild_operating_plant::network::Network<P>,
    scales: &[f64],
    region: usize,
    id: &str,
) -> Result<[(usize, f64); 4], String> {
    let l = net
        .cell_layout
        .get(region)
        .ok_or_else(|| format!("{id} is not a regular cell"))?;
    Ok([l.base, l.mass[0], l.energy[0], l.mass[1]].map(|i| (i, scales[i])))
}

fn mass_flow(
    y: &[f64],
    impulse: (usize, f64),
    from: (usize, f64, f64),
    to: (usize, f64, f64),
    supports: &[(usize, f64, f64)],
) -> Result<f64, String> {
    let inertia: f64 = supports.iter().map(|(i, s, w)| y[*i] * s * w).sum();
    if !(inertia.is_finite() && inertia > 0.) {
        return Err(format!("loop-flow observation: phase inertia {inertia}"));
    }
    let q = y[impulse.0] * impulse.1 / inertia;
    let (i, s, v) = if q >= 0. { from } else { to };
    Ok(y[i] * s / v * q)
}
fn events(y: &[f64], regions: &[ProxyRegion]) -> f64 {
    regions
        .iter()
        .map(|(n, s, w, supports)| {
            w * y[*n]
                * s
                * supports
                    .iter()
                    .map(|(x, xs, p)| y[*x] * xs * p)
                    .sum::<f64>()
        })
        .sum()
}

/// Chebyshev–Lobatto nodes of degree `p` on `[0, dt]`, the step's own
/// coordinate: distinct for every `dt > 0` an accepted step can have.
fn lobatto_offsets(dt: f64, p: usize) -> Vec<f64> {
    (0..=p)
        .map(|j| match j {
            0 => 0.,
            j if j == p => dt,
            j => dt * (1. - (std::f64::consts::PI * j as f64 / p as f64).cos()) / 2.,
        })
        .collect()
}

/// The coordinates `read` of the state at `from + s` from the step
/// polynomial's Taylor coefficients `taylor[j] = y^(j)(from)` (exact for a
/// polynomial of their degree); the others are left as they are.
fn state_at_offset(taylor: &[Vec<f64>], s: f64, read: &[usize], out: &mut [f64]) {
    let m = taylor.len() - 1;
    for &i in read {
        let mut o = taylor[m][i];
        for k in (0..m).rev() {
            o = taylor[k][i] + o * (s / (k + 1) as f64);
        }
        out[i] = o;
    }
}

/// Taylor derivatives at the first node of the polynomial through
/// `(nodes, values)` (Newton form expanded about `nodes[0]`).
fn derivatives_at_start(nodes: &[f64], values: &[f64], out: &mut Vec<f64>) {
    let n = nodes.len();
    let mut d = values.to_vec();
    for level in 1..n {
        for i in (level..n).rev() {
            d[i] = (d[i] - d[i - 1]) / (nodes[i] - nodes[i - level]);
        }
    }
    // Expand p(s) = d0 + d1 (s - s0) + d2 (s - s0)(s - s1) + ... about s0.
    let mut coef = vec![0.; n];
    coef[0] = d[n - 1];
    for j in (0..n - 1).rev() {
        // coef = coef * (s - (nodes[j] - nodes[0])) + d[j]
        let shift = nodes[j] - nodes[0];
        for k in (1..n).rev() {
            coef[k] = coef[k - 1] - shift * coef[k];
        }
        coef[0] = -shift * coef[0] + d[j];
    }
    out.clear();
    let mut factorial = 1.;
    for (k, c) in coef.iter().enumerate() {
        if k > 0 {
            factorial *= k as f64;
        }
        out.push(c * factorial);
    }
}

pub struct ProtectionClient {
    pub protection: Protection,
    observed: Vec<(Quantity, Observation)>,
    /// What the references resolved to, for receipts.
    references: Value,
    scratch: Vec<f64>,
    states: Vec<Vec<f64>>,
    /// The step polynomial's Taylor coefficients at the step start.
    taylor: Vec<Vec<f64>>,
    /// The coordinates the nonlinear observations read (sorted, distinct).
    nonlinear_read: Vec<usize>,
    /// The section declares the bank inserted report (read after restarts).
    bank_report: bool,
    /// The current proxy's place in `observed` (the SOURCE path's rate).
    proxy_index: Option<usize>,
    derivatives: Vec<Vec<f64>>,
}
impl ProtectionClient {
    /// The protection of `section`, balanced at the solver state `y`, with
    /// the loop nominals and the proxy reference at `reference` (the
    /// composition's start at the packet's prepared hot reference).
    pub fn new<P: Properties + WaterProperties>(
        section: &Section,
        joined: &Joined<P>,
        y: &[f64],
        reference: &[f64],
    ) -> Result<Self, String> {
        let scales = joined.scales();
        if scales.len() != y.len() || reference.len() != y.len() {
            return Err("state layout".into());
        }
        let labels: Vec<String> = joined
            .layouts()
            .into_iter()
            .flat_map(|(_, l)| l.labels)
            .collect();
        let net = &joined.network;
        let mut references = serde_json::Map::new();
        let mut section = section.clone();
        let mut observed: Vec<(Quantity, Observation)> = Vec::new();
        for f in &mut section.families {
            let observation = match &f.quantity {
                Quantity::PzrRoofPressure => {
                    let i = net.pzr.base + PZR_PRESSURE;
                    Observation::Linear(vec![(i, scales[i])])
                }
                Quantity::SgCollapsedLevel { sg, area_m2 } => {
                    let label = format!("SG.{sg}.V_l");
                    let i = labels
                        .iter()
                        .position(|l| *l == label)
                        .ok_or_else(|| format!("no coordinate {label}"))?;
                    if !(area_m2.is_finite() && *area_m2 > 0.) {
                        return Err(format!("{label}: level area {area_m2}"));
                    }
                    Observation::Linear(vec![(i, scales[i] / area_m2)])
                }
                Quantity::SgApparentLevel { sg, area_m2 } => {
                    let at = |name: &str| -> Result<usize, String> {
                        let label = format!("SG.{sg}.{name}");
                        labels
                            .iter()
                            .position(|l| *l == label)
                            .ok_or_else(|| format!("no coordinate {label} (the joined packet composes no apparent level)"))
                    };
                    let (liquid, submerged) = (at("V_l")?, at("V_sub")?);
                    if !(area_m2.is_finite() && *area_m2 > 0.) {
                        return Err(format!("SG.{sg} apparent level: level area {area_m2}"));
                    }
                    Observation::Linear(vec![
                        (liquid, scales[liquid] / area_m2),
                        (submerged, scales[submerged] / area_m2),
                    ])
                }
                Quantity::LoopFlow { face, face_id, .. } => {
                    let geometry = net
                        .face(*face)
                        .ok_or_else(|| format!("no face {face_id}"))?;
                    let path = net
                        .face_layout
                        .iter()
                        .find(|l| l.face == *face && l.phase == 0)
                        .ok_or_else(|| format!("{face_id}: no liquid path"))?
                        .index;
                    let cell = |node: usize| -> Result<(usize, f64, f64), String> {
                        let layout = net
                            .cell_layout
                            .get(node)
                            .ok_or_else(|| format!("{face_id}: cell {node} is not regular"))?;
                        let m = layout.mass[0];
                        Ok((m, scales[m], net.volume(node)))
                    };
                    let supports = geometry
                        .supports
                        .iter()
                        .map(|s| {
                            cell(s.region)
                                .map(|(m, sc, v)| (m, sc, s.inverse_area_length_per_m / v))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let (from, to) = (cell(geometry.from)?, cell(geometry.to)?);
                    let nominal = mass_flow(reference, (path, scales[path]), from, to, &supports)?;
                    if !(nominal.is_finite() && nominal > 0.) {
                        return Err(format!("{face_id}: nominal forward flow {nominal} kg/s"));
                    }
                    references.insert(f.id.clone(), json!({"face": face_id, "nominal_kg_s": nominal,
                        "basis": "the cold-return face's mass flow at the packet's prepared hot reference"}));
                    if let Quantity::LoopFlow { nominal_kg_s, .. } = &mut f.quantity {
                        *nominal_kg_s = Some(nominal);
                    }
                    Observation::LoopFlow {
                        impulse: (path, scales[path]),
                        from,
                        to,
                        supports,
                        nominal,
                    }
                }
                Quantity::PzrLevel {
                    calibration_pressure_pa,
                    interface_span_pa,
                } => {
                    let cell = net.stratified();
                    let (low, high) = cell
                        .parameters()
                        .level_taps()
                        .map_err(|f| format!("{f:?}"))?
                        .ok_or("the PZR declares no LT pair")?;
                    let saturation = WaterProperties::saturation(
                        joined.properties(),
                        Scalar::constant(*calibration_pressure_pa),
                    )
                    .map_err(|e| format!("LT calibration saturation: {e}"))?;
                    let (rl, rg) = (
                        saturation.liquid.density.value,
                        saturation.vapor.density.value,
                    );
                    let a = 1. / ((rl - rg) * G);
                    let b = -rg * G * (high - low) * a;
                    references.insert(f.id.clone(), json!({"calibration_pressure_pa": calibration_pressure_pa,
                        "liquid_density_kg_m3": rl, "vapor_density_kg_m3": rg, "tap_span_m": high - low,
                        "basis": "fixed saturated-water calibration over the LT tap span (phase-dependent-measurements.md)"}));
                    let base = net.pzr.base;
                    Observation::PzrLevel {
                        cell: Box::new(cell.clone()),
                        base,
                        scales: scales[base..base + stratified::COORDINATES].to_vec(),
                        a,
                        b,
                        span: *interface_span_pa,
                    }
                }
                Quantity::CurrentProxy {
                    weights,
                    fref_events_per_s,
                } => {
                    let nuclear = joined.nuclear();
                    let base = joined.offsets().nuclear;
                    if weights.len() != nuclear.regions() {
                        return Err(format!(
                            "{} region weights for {} regions",
                            weights.len(),
                            nuclear.regions()
                        ));
                    }
                    let model = nuclear.feedback();
                    let mut regions: Vec<ProxyRegion> = (0..nuclear.regions())
                        .map(|r| (base + r, scales[base + r], weights[r], Vec::new()))
                        .collect();
                    for s in model.supports() {
                        let x = base + nuclear.material(s.material, 0);
                        let reference_atoms = model.materials()[s.material].reference_fissile_atoms;
                        regions[s.region].3.push((
                            x,
                            scales[x],
                            s.production_reference_per_s / reference_atoms,
                        ));
                    }
                    let all: Vec<_> = regions
                        .iter()
                        .map(|(n, s, _, p)| (*n, *s, 1., p.clone()))
                        .collect();
                    let (total, converter) = (events(reference, &all), events(reference, &regions));
                    if !(total > 0. && converter > 0. && *fref_events_per_s > 0.) {
                        return Err(format!("proxy reference: E_tot {total}, E_c {converter}"));
                    }
                    let factor = total / (fref_events_per_s * converter);
                    references.insert(
                        f.id.clone(),
                        json!({"E_tot_ref_events_per_s": total,
                        "E_c_ref_events_per_s": converter, "Fref_events_per_s": fref_events_per_s,
                        "proxy_at_reference": total / fref_events_per_s,
                        "basis": "S3-D7 ratio form at the packet's prepared hot reference"}),
                    );
                    Observation::Proxy { regions, factor }
                }
                // R12-D2: ω/ω_ref = L / (J ω_ref), L the rotor's coordinate.
                Quantity::PumpSpeed { rotor, rotor_id } => {
                    if *rotor >= net.rotor_count() {
                        return Err(format!(
                            "{rotor_id}: rotor {rotor} of {}",
                            net.rotor_count()
                        ));
                    }
                    let i = net.rotor_index[*rotor];
                    let reference = net.rotor_inertia() * net.drive().reference_omega_rad_s;
                    if !(reference.is_finite() && reference > 0.) {
                        return Err(format!(
                            "{rotor_id}: reference angular momentum {reference}"
                        ));
                    }
                    references.insert(
                        f.id.clone(),
                        json!({"rotor": rotor, "section": rotor_id,
                        "reference_omega_rad_s": net.drive().reference_omega_rad_s,
                        "basis": "the RCP drive's reference speed (R12-D2)"}),
                    );
                    Observation::Linear(vec![(i, scales[i] / reference)])
                }
                Quantity::CvcsFlow { branch } => {
                    let cvcs = joined
                        .cvcs()
                        .ok_or("a CVCS flow channel needs the packet's CVCS")?;
                    let cell = cvcs.port_cell();
                    // The branches meet COLD.A at its own reference elevation,
                    // where the port pressure is the cell's pressure.
                    if net.elevations()[cell] != cvcs.section().port.elevation_m {
                        return Err(format!(
                            "{}: the CVCS port lies off the cell's reference elevation",
                            f.id
                        ));
                    }
                    let p = net.cell_layout[cell].base;
                    let x = joined.offsets().cvcs
                        + leitbild_operating_plant::joined::cvcs::Cvcs::stem_coordinate(*branch);
                    references.insert(f.id.clone(), json!({"branch": branch, "port": cvcs.section().port.id,
                        "basis": "the CVCS owner's delivered flow at the stem and COLD.A's pressure (plan r4 X4.2)"}));
                    Observation::CvcsFlow {
                        cvcs: Box::new(cvcs.clone()),
                        branch: *branch,
                        stem: (x, scales[x]),
                        pressure: (p, scales[p]),
                    }
                }
                Quantity::BankPosition { normal_travel_m } => {
                    let rods = joined
                        .rods()
                        .ok_or("a bank position channel needs the rods")?;
                    let n = rods.clusters();
                    if !(normal_travel_m.is_finite() && *normal_travel_m > 0. && n > 0) {
                        return Err(format!(
                            "{}: stroke {normal_travel_m} m over {n} clusters",
                            f.id
                        ));
                    }
                    let o = joined.offsets().rods;
                    references.insert(f.id.clone(), json!({"clusters": n, "normal_travel_m": normal_travel_m,
                        "basis": "mean stem travel over every cluster over the normal stroke (ld01-bank-channels)"}));
                    Observation::Linear(
                        (0..n)
                            .map(|c| {
                                let i = o + rods.cluster_coordinate(c);
                                (i, scales[i] / (n as f64 * normal_travel_m))
                            })
                            .collect(),
                    )
                }
                // Plan r4 X4 channels (PROC's requests): linear readings of
                // owner coordinates.
                Quantity::SgPressure { sg } => {
                    let label = format!("SG.{sg}.p_s");
                    let i = labels
                        .iter()
                        .position(|l| *l == label)
                        .ok_or_else(|| format!("no coordinate {label}"))?;
                    references.insert(f.id.clone(), json!({"coordinate": label,
                        "basis": "the SG owner's total secondary pressure (ld01-sg-normal-pressure-channel)"}));
                    Observation::Linear(vec![(i, scales[i])])
                }
                Quantity::SgFlowLag {
                    sg,
                    flow,
                    nominal_kg_s,
                } => {
                    let label = match flow {
                        SgFlow::Steam => format!("FW.{sg}.FT.STEAM.lag"),
                        SgFlow::Feed => format!("FW.{sg}.FW.FT.lag"),
                    };
                    let i = labels.iter().position(|l| *l == label).ok_or_else(|| {
                        format!("no coordinate {label} (the joined packet composes no feed train)")
                    })?;
                    if !(nominal_kg_s.is_finite() && *nominal_kg_s > 0.) {
                        return Err(format!("{}: nominal flow {nominal_kg_s} kg/s", f.id));
                    }
                    if f.channel.lag_s != 0. {
                        return Err(format!(
                            "{}: the SG owner's lag is the channel's response; no second lag",
                            f.id
                        ));
                    }
                    references.insert(f.id.clone(), json!({"coordinate": label, "nominal_kg_s": nominal_kg_s,
                        "basis": "the SG owner's continuous channel lag over the one-SG nominal feed flow m0 (ld01-sg-flow-channels, ld01-feed-cascade)"}));
                    Observation::Linear(vec![(i, scales[i] / nominal_kg_s)])
                }
                Quantity::VesselDp { taps } => {
                    if taps.is_empty() {
                        return Err(format!("{}: no interfaces", f.id));
                    }
                    let weight = 1. / taps.len() as f64;
                    let mut terms: Vec<(usize, f64)> = Vec::new();
                    // p + (M_l + M_v) g (z_ref - z) / V at one interface, signed.
                    let mut interface = |at: &leitbild_operating_plant::ic::packet::DpInterface,
                                         sign: f64|
                     -> Result<(), String> {
                        let layout = net.cell_layout.get(at.region).ok_or_else(|| {
                            format!("{}: {} is not a regular cell", f.id, at.region_id)
                        })?;
                        let head = G * (net.elevations()[at.region] - at.elevation_m)
                            / net.volume(at.region);
                        terms.push((layout.base, sign * weight * scales[layout.base]));
                        for m in layout.mass {
                            terms.push((m, sign * weight * scales[m] * head));
                        }
                        Ok(())
                    };
                    for t in taps {
                        interface(&t.lower, 1.)?;
                        interface(&t.upper, -1.)?;
                    }
                    references.insert(f.id.clone(), json!({"interfaces": taps.iter().map(|t| json!([
                        [t.lower.region_id, t.lower.elevation_m], [t.upper.region_id, t.upper.elevation_m]])).collect::<Vec<_>>(),
                        "basis": "the mean over the sector channels of each cell's local static pressure p + rho_mix g (z_ref - z), rho_mix = M / V (ld01-vessel-dp-channels)"}));
                    Observation::Linear(terms)
                }
                Quantity::PlenumDp {
                    region,
                    region_id,
                    lower_m,
                    upper_m,
                } => {
                    let cell = liquid_cell(net, &scales, *region, region_id)?;
                    if !((upper_m - lower_m).is_finite() && upper_m - lower_m > 0.) {
                        return Err(format!("{}: interfaces {lower_m} and {upper_m} m", f.id));
                    }
                    references.insert(f.id.clone(), json!({"region": region_id, "interfaces_m": [lower_m, upper_m],
                        "basis": "the moving cell's liquid density at its pressure and specific internal energy times g and the span (ld01-vessel-dp-channels)"}));
                    Observation::Liquid {
                        cells: vec![cell],
                        ids: vec![region_id.clone()],
                        reading: LiquidReading::Head {
                            height_m: upper_m - lower_m,
                        },
                    }
                }
                Quantity::CoreExitTemperature { cells, body_c } => {
                    if cells.is_empty()
                        || !((body_c[1] - body_c[0]).is_finite() && body_c[1] - body_c[0] > 0.)
                    {
                        return Err(format!(
                            "{}: {} cells, body {body_c:?} °C",
                            f.id,
                            cells.len()
                        ));
                    }
                    let read = cells
                        .iter()
                        .map(|c| liquid_cell(net, &scales, c.region, &c.region_id))
                        .collect::<Result<Vec<_>, _>>()?;
                    references.insert(f.id.clone(), json!({"cells": cells.iter().map(|c| &c.region_id).collect::<Vec<_>>(),
                        "lag_s": f.channel.lag_s, "basis": "the mixed outlet liquid's temperature through the property boundary, lagged by the probe body's liquid time constant (ld01-core-exit-channels, labelled judgement)"}));
                    Observation::Liquid {
                        cells: read,
                        ids: cells.iter().map(|c| c.region_id.clone()).collect(),
                        reading: LiquidReading::Temperature { body_c: *body_c },
                    }
                }
                Quantity::StopValvePosition { stop_travel_s } => {
                    let secondary = joined
                        .secondary()
                        .ok_or("a STOP position channel needs the secondary")?;
                    if !(stop_travel_s.is_finite() && *stop_travel_s > 0.) {
                        return Err(format!("{}: STOP travel {stop_travel_s} s", f.id));
                    }
                    references.insert(f.id.clone(), json!({"stop_travel_s": stop_travel_s,
                        "basis": "the secondary's STOP law: 100 % until the TRIP, linear to 0 over the travel (ld01-steam-valve-position-channels)"}));
                    Observation::StopPosition {
                        trip_s: secondary.turbine_trip_time(),
                        travel_s: *stop_travel_s,
                    }
                }
            };
            if !observed.iter().any(|(q, _)| *q == f.quantity) {
                observed.push((f.quantity.clone(), observation));
            }
        }
        let protection = Protection::new(&section, |q| {
            observed
                .iter()
                .find(|(o, _)| o == q)
                .ok_or_else(|| format!("{q:?} is not observed"))?
                .1
                .value(y)
        })?;
        let proxy_index = observed
            .iter()
            .position(|(q, _)| matches!(q, Quantity::CurrentProxy { .. }));
        if section.source_range.is_some() && proxy_index.is_none() {
            return Err("the SOURCE-pulse path needs the current proxy family".into());
        }
        let mut protection = protection;
        let bank_report = section
            .reports
            .iter()
            .any(|r| r.source == ReportSource::BankInserted);
        if bank_report {
            protection.set_bank_seated(bank_seated(joined)?);
        }
        let n = y.len();
        let mut nonlinear_read: Vec<usize> = observed
            .iter()
            .filter(|(_, o)| !o.linear() && !o.timed())
            .flat_map(|(_, o)| o.coordinates())
            .collect();
        nonlinear_read.sort_unstable();
        nonlinear_read.dedup();
        Ok(Self {
            derivatives: vec![Vec::new(); observed.len()],
            protection,
            observed,
            references: Value::Object(references),
            scratch: vec![0.; n],
            states: Vec::new(),
            taylor: Vec::new(),
            nonlinear_read,
            bank_report,
            proxy_index,
        })
    }
    /// HOOK (GATE, S3 case harness; KERN to reconcile): the dense-output
    /// buffer for a system that appends owners after the joined operator
    /// (ELEC's slice), whose dense output has the system's full dimension;
    /// the observed indices stay the operator's.
    pub fn with_system_dimension(mut self, dimension: usize) -> Result<Self, String> {
        if dimension < self.scratch.len() {
            return Err(format!(
                "a system of {dimension} coordinates cannot hold the operator's {}",
                self.scratch.len()
            ));
        }
        self.scratch = vec![0.; dimension];
        Ok(self)
    }
    /// The observed quantities, how they are read and their references.
    pub fn observed(&self) -> Value {
        json!({"quantities": self.observed.iter().map(|(q, o)| json!({"quantity": format!("{q:?}"),
            "reading": if o.linear() { "linear: exact dense-output derivatives" } else { "nonlinear: Chebyshev-Lobatto nodes of the step's order" }}))
            .collect::<Vec<_>>(), "references": self.references})
    }
    /// The current value of every observed quantity at `y` (receipts).
    pub fn values(&self, y: &[f64]) -> Result<Value, String> {
        values_of(&self.observed, y)
    }
    /// The observed quantities apart from the protection, read at any state.
    pub fn readings(&self) -> Readings {
        Readings {
            observed: self.observed.clone(),
        }
    }
}
fn values_of(observed: &[(Quantity, Observation)], y: &[f64]) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    // A timed reading (the STOP position) has no value at a state alone.
    for (q, o) in observed.iter().filter(|(_, o)| !o.timed()) {
        out.insert(format!("{q:?}"), json!(o.value(y)?));
    }
    Ok(Value::Object(out))
}

/// The protection's observed quantities (plant values, before any channel
/// response), for an observer that reads them at frame instants.
#[derive(Clone, Debug)]
pub struct Readings {
    observed: Vec<(Quantity, Observation)>,
}
impl Readings {
    /// The value of every observed quantity at `y`.
    pub fn values(&self, y: &[f64]) -> Result<Value, String> {
        values_of(&self.observed, y)
    }
}
impl<S: JoinedSystem> Client<S> for ProtectionClient {
    fn name(&self) -> &str {
        "acquired protection"
    }
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String> {
        // The step polynomial's order bounds both readings (at most 5, the
        // lag continuation's limit); a node set has at least two nodes.
        let order = dense.order().min(5);
        // Its Taylor coefficients at the step start: the linear readings
        // directly, the nonlinear ones' node states in the step's own
        // coordinate (an absolute node rounds onto an end of a step of a
        // few ulps, LT1's C3 refusal at 294.5 s).
        self.taylor.resize(order + 1, Vec::new());
        for (j, c) in self.taylor.iter_mut().enumerate() {
            c.resize(self.scratch.len(), 0.);
            dense.derivative(from, j, c)?;
        }
        for (d, (_, o)) in self.derivatives.iter_mut().zip(&self.observed) {
            if o.linear() {
                d.clear();
                for c in &self.taylor {
                    d.push(o.value(c)?);
                }
            }
        }
        for (d, (_, o)) in self.derivatives.iter_mut().zip(&self.observed) {
            // Linear in time inside one dense interval: the TRIP latches at a
            // restart and the STOP ramp's end is an owner time event.
            if let Observation::StopPosition { trip_s, travel_s } = o {
                let (a, b) = (
                    Observation::stop_percent(*trip_s, *travel_s, from),
                    Observation::stop_percent(*trip_s, *travel_s, to),
                );
                d.clear();
                d.extend([a, (b - a) / (to - from)]);
            }
        }
        if self.observed.iter().any(|(_, o)| !o.linear() && !o.timed()) {
            let offsets = lobatto_offsets(to - from, order.max(1));
            self.states.resize(offsets.len(), Vec::new());
            for (state, s) in self.states.iter_mut().zip(&offsets) {
                state.resize(self.scratch.len(), 0.);
                state_at_offset(&self.taylor, *s, &self.nonlinear_read, state);
            }
            let mut values = vec![0.; offsets.len()];
            for (d, (_, o)) in self.derivatives.iter_mut().zip(&self.observed) {
                if !o.linear() && !o.timed() {
                    for (v, state) in values.iter_mut().zip(&self.states) {
                        *v = o.value(state)?;
                    }
                    derivatives_at_start(&offsets, &values, d);
                }
            }
        }
        for (d, (q, _)) in self.derivatives.iter().zip(&self.observed) {
            self.protection.advance(q, to - from, d)?;
        }
        // The SOURCE-pulse path's detected events follow the current proxy.
        if let (Some(i), Some(source)) = (self.proxy_index, self.protection.source.as_mut()) {
            source.advance(from, to, &self.derivatives[i])?;
        }
        Ok(())
    }
    fn frame(&mut self, k: u64, t: f64, dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        // Input-stage status at the acquisition's left limit.
        if self
            .observed
            .iter()
            .any(|(q, _)| matches!(q, Quantity::PzrLevel { .. }))
        {
            dense.derivative(t, 0, &mut self.scratch)?;
            for (q, o) in &self.observed {
                if matches!(q, Quantity::PzrLevel { .. }) {
                    let status = o.input_overrange(&self.scratch)?;
                    self.protection.set_input_overrange(q, status);
                }
            }
        }
        let frame = self.protection.frame_of();
        let mut changes: Vec<Change<S>> = self
            .protection
            .frame(k)?
            .map(|lost| Change {
                due_s: frame.instant(lost),
                class: Class::R,
                kind: HOLDING_LOSS.into(),
                action: Action::Command(Command::HoldingLoss),
            })
            .into_iter()
            .collect();
        // R12-A2: the turbine controls' trip on the reactor trip, decided for
        // the next frame as the holding loss is.
        if let Some((due, cause)) = self.protection.turbine_trip_due(k + 1) {
            changes.push(Change {
                due_s: frame.instant(due),
                class: Class::R,
                kind: format!("{cause}: turbine trip"),
                action: Action::Command(Command::TurbineTripAcquired),
            });
        }
        Ok(changes)
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Vec<Change<S>>, String> {
        if command == Command::TurbineTripAcquired {
            self.protection.turbine_trip(t);
        }
        Ok(Vec::new())
    }
    /// The owners' discrete state a reading depends on, after the restart
    /// at `t`: the latched TRIP (STOP position), the seated chain and the
    /// CVCS branches' modes.
    fn restarted(&mut self, _t: f64, system: &S) -> Result<(), String> {
        let joined = &system.integrated().joined;
        for (_, o) in &mut self.observed {
            match o {
                Observation::StopPosition { trip_s, .. } => {
                    *trip_s = joined
                        .secondary()
                        .ok_or("a STOP position channel without the secondary")?
                        .turbine_trip_time();
                }
                // PHYS 27062e3c8 (plan r4 X4.2): the CVCS branches' stops
                // and requests are read live, the owner's state after the
                // restart at `t`.
                Observation::CvcsFlow { cvcs, .. } => {
                    **cvcs = joined
                        .cvcs()
                        .ok_or("a CVCS flow channel without the joined CVCS")?
                        .clone();
                }
                _ => {}
            }
        }
        if self.bank_report {
            self.protection.set_bank_seated(bank_seated(joined)?);
        }
        Ok(())
    }
}

/// Every cluster seated, from the rods owner's discrete modes.
fn bank_seated<P: Properties + WaterProperties>(joined: &Joined<P>) -> Result<bool, String> {
    let rods = joined
        .rods()
        .ok_or("the bank inserted report needs the rods")?;
    let state = rods.discrete_state();
    let modes = state["modes"]
        .as_array()
        .ok_or("the rods' discrete state lists no modes")?;
    Ok(!modes.is_empty() && modes.iter().all(|m| m.as_str() == Some("seated")))
}

#[cfg(test)]
mod tests {
    use super::derivatives_at_start;

    #[test]
    fn an_interface_outside_its_span_gives_the_bound_direction() {
        use super::{Overrange, overrange_of};
        let span = [0., 25e6];
        assert_eq!(overrange_of(15.05e6, 15.0e6, span).unwrap(), None);
        assert_eq!(
            overrange_of(25.1e6, 15.0e6, span).unwrap(),
            Some(Overrange::Above)
        );
        assert_eq!(
            overrange_of(15.0e6, -1., span).unwrap(),
            Some(Overrange::Above)
        );
        assert_eq!(
            overrange_of(-1., 1e6, span).unwrap(),
            Some(Overrange::Below)
        );
        assert_eq!(
            overrange_of(15e6, 26e6, span).unwrap(),
            Some(Overrange::Below)
        );
        assert!(overrange_of(26e6, 25.5e6, span).is_err());
    }

    #[test]
    fn node_derivatives_recover_a_polynomial_of_the_node_degree() {
        // q(t) = 2 - 3 (t - 1) + 0.5 (t - 1)^2 on nodes in [1, 1.02].
        let q = |t: f64| 2. - 3. * (t - 1.) + 0.5 * (t - 1.) * (t - 1.);
        let nodes = [1., 1.01, 1.02];
        let values: Vec<f64> = nodes.iter().map(|t| q(*t)).collect();
        let mut d = Vec::new();
        derivatives_at_start(&nodes, &values, &mut d);
        assert!(
            (d[0] - 2.).abs() < 1e-12 && (d[1] + 3.).abs() < 1e-9 && (d[2] - 1.).abs() < 1e-6,
            "{d:?}"
        );
        // Two nodes: the chord.
        derivatives_at_start(&[0., 0.5], &[1., 2.], &mut d);
        assert_eq!(d, vec![1., 2.]);
    }

    /// C3's LT1 refusal (stock, 294.5 s): an accepted step of one ulp with a
    /// second-order polynomial. Absolute Chebyshev–Lobatto nodes round onto
    /// the step's ends; the step's own coordinate keeps them distinct, and
    /// a nonlinear reading continues the lag with finite derivatives.
    #[test]
    fn a_one_ulp_step_keeps_distinct_nodes_and_a_finite_nonlinear_reading() {
        use super::{lobatto_offsets, state_at_offset};
        use leitbild_operating_plant::ic::acquisition::lag_continuation;
        let from = 294.5_f64;
        let to = f64::from_bits(from.to_bits() + 1);
        let dt = to - from;
        assert_eq!(dt, 2f64.powi(-44));
        let absolute = from + dt * (1. - (std::f64::consts::PI / 2.).cos()) / 2.;
        assert!(absolute == from || absolute == to, "the defect's premise");
        let offsets = lobatto_offsets(dt, 2);
        assert!(offsets.windows(2).all(|w| w[1] > w[0]), "{offsets:?}");
        // y(from + s) = 3.1 + 0.4 s - 2 s^2; observed q = y^2.
        let taylor = vec![vec![3.1], vec![0.4], vec![-4.]];
        let mut state = [0.];
        let values: Vec<f64> = offsets
            .iter()
            .map(|s| {
                state_at_offset(&taylor, *s, &[0], &mut state);
                state[0] * state[0]
            })
            .collect();
        let mut d = Vec::new();
        derivatives_at_start(&offsets, &values, &mut d);
        assert!(d.iter().all(|v| v.is_finite()), "{d:?}");
        let r = lag_continuation(5.287, 0.5, dt, &d).unwrap();
        assert!((r - 5.287).abs() < 1e-12, "{r}");
    }

    /// A nonlinear reading needs only the coordinates it declares: with
    /// every other coordinate NaN it reads the same value.
    #[test]
    fn nonlinear_readings_read_only_their_declared_coordinates() {
        use super::Observation;
        let observations = [
            Observation::LoopFlow {
                impulse: (1, 2.),
                from: (3, 1.5, 4.),
                to: (5, 1., 2.),
                supports: vec![(7, 1., 0.5), (8, 2., 0.25)],
                nominal: 10.,
            },
            Observation::Proxy {
                regions: vec![
                    (2, 1., 0.5, vec![(4, 2., 3.)]),
                    (6, 1., 0.5, vec![(9, 1., 1.)]),
                ],
                factor: 1.5,
            },
        ];
        let full: Vec<f64> = (0..10).map(|i| 1. + i as f64).collect();
        for o in &observations {
            let mut sparse = vec![f64::NAN; full.len()];
            for i in o.coordinates() {
                sparse[i] = full[i];
            }
            assert_eq!(o.value(&sparse).unwrap(), o.value(&full).unwrap());
        }
    }

    /// The STOP position is open until the TRIP, then linear to closed over
    /// the travel, and reads no coordinate.
    #[test]
    fn the_stop_position_follows_the_secondary_law() {
        use super::Observation;
        let f = |t| Observation::stop_percent(Some(10.), 0.3, t);
        assert_eq!(Observation::stop_percent(None, 0.3, 50.), 100.);
        assert_eq!((f(9.), f(10.), f(10.3), f(11.)), (100., 100., 0., 0.));
        assert!((f(10.15) - 50.).abs() < 1e-9);
        let o = Observation::StopPosition {
            trip_s: None,
            travel_s: 0.3,
        };
        assert!(o.timed() && o.coordinates().is_empty());
        assert_eq!(o.value(&[]).unwrap(), 100.);
        let latched = Observation::StopPosition {
            trip_s: Some(10.),
            travel_s: 0.3,
        };
        assert!(latched.value(&[]).is_err());
    }

    #[test]
    fn node_states_from_taylor_coefficients_recover_the_step_polynomial() {
        use super::{lobatto_offsets, state_at_offset};
        // y(1 + s) = 2 - 3 s + 0.25 s^2 + 0.5 s^3 on a 0.02 s step; q = y^2.
        let y = |s: f64| 2. - 3. * s + 0.25 * s * s + 0.5 * s * s * s;
        let taylor = vec![vec![2.], vec![-3.], vec![0.5], vec![3.]];
        let offsets = lobatto_offsets(0.02, 3);
        let mut state = [0.];
        let mut values = Vec::new();
        for s in &offsets {
            state_at_offset(&taylor, *s, &[0], &mut state);
            assert!((state[0] - y(*s)).abs() < 1e-14, "{s}");
            values.push(state[0] * state[0]);
        }
        let mut d = Vec::new();
        derivatives_at_start(&offsets, &values, &mut d);
        // q(0) = 4, q'(0) = 2 y y' = -12, q''(0) = 2 (y'^2 + y y'') = 20.
        // The cubic interpolates the sixth-degree q: its own error, not rounding.
        assert!(
            (d[0] - 4.).abs() < 1e-12 && (d[1] + 12.).abs() < 1e-5,
            "{d:?}"
        );
        assert!((d[2] - 20.).abs() < 0.2, "{d:?}");
    }
}

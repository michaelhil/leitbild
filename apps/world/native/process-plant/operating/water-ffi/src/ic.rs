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
//!   integrator's own polynomial. The lag is exact for the interpolant.
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
//! `HoldingLoss` at its frame instant.
use crate::frame::{Action, Change, Class, Client, Dense};
use leitbild_operating_plant::{
    ic::{
        packet::{Quantity, Section},
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
}
impl Observation {
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
            Observation::PzrLevel {
                cell,
                base,
                scales,
                a,
                b,
                span,
            } => {
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
                for p in [low.value, high.value] {
                    if !(span[0]..=span[1]).contains(&p) {
                        return Err(format!(
                            "PZR LT interface at {p} Pa outside its {span:?} Pa span (device overrange is not built in S3)"
                        ));
                    }
                }
                Ok(a * (low.value - high.value) + b)
            }
        }
    }
    fn linear(&self) -> bool {
        matches!(self, Observation::Linear(_))
    }
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
        let n = y.len();
        Ok(Self {
            derivatives: vec![Vec::new(); observed.len()],
            protection,
            observed,
            references: Value::Object(references),
            scratch: vec![0.; n],
            states: Vec::new(),
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
        let mut out = serde_json::Map::new();
        for (q, o) in &self.observed {
            out.insert(format!("{q:?}"), json!(o.value(y)?));
        }
        Ok(Value::Object(out))
    }
}
impl<S> Client<S> for ProtectionClient {
    fn name(&self) -> &str {
        "acquired protection"
    }
    fn advance(&mut self, dense: &dyn Dense, from: f64, to: f64) -> Result<(), String> {
        // The step polynomial's order bounds both readings (at most 5, the
        // lag continuation's limit); a node set has at least two nodes.
        let order = dense.order().min(5);
        if self.observed.iter().any(|(_, o)| o.linear()) {
            for d in &mut self.derivatives {
                d.clear();
            }
            for j in 0..=order {
                dense.derivative(from, j, &mut self.scratch)?;
                for (d, (_, o)) in self.derivatives.iter_mut().zip(&self.observed) {
                    if o.linear() {
                        d.push(o.value(&self.scratch)?);
                    }
                }
            }
        }
        if self.observed.iter().any(|(_, o)| !o.linear()) {
            let p = order.max(1);
            let nodes: Vec<f64> = (0..=p)
                .map(|j| {
                    let c = (std::f64::consts::PI * j as f64 / p as f64).cos();
                    if j == 0 {
                        from
                    } else if j == p {
                        to
                    } else {
                        from + (to - from) * (1. - c) / 2.
                    }
                })
                .collect();
            self.states.resize(nodes.len(), Vec::new());
            for (state, t) in self.states.iter_mut().zip(&nodes) {
                state.resize(self.scratch.len(), 0.);
                dense.derivative(*t, 0, state)?;
            }
            let mut values = vec![0.; nodes.len()];
            for (d, (_, o)) in self.derivatives.iter_mut().zip(&self.observed) {
                if !o.linear() {
                    for (v, state) in values.iter_mut().zip(&self.states) {
                        *v = o.value(state)?;
                    }
                    derivatives_at_start(&nodes, &values, d);
                }
            }
        }
        for (d, (q, _)) in self.derivatives.iter().zip(&self.observed) {
            self.protection.advance(q, to - from, d)?;
        }
        Ok(())
    }
    fn frame(&mut self, k: u64, _t: f64, _dense: &dyn Dense) -> Result<Vec<Change<S>>, String> {
        let frame = self.protection.frame_of();
        Ok(self
            .protection
            .frame(k)?
            .map(|lost| Change {
                due_s: frame.instant(lost),
                class: Class::R,
                kind: HOLDING_LOSS.into(),
                action: Action::Command(Command::HoldingLoss),
            })
            .into_iter()
            .collect())
    }
    fn command(&mut self, t: f64, command: Command) -> Result<Vec<Change<S>>, String> {
        if command == Command::TurbineTripAcquired {
            self.protection.turbine_trip(t);
        }
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::derivatives_at_start;

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
}

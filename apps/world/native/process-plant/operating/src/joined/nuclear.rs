//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#extensive-regional-kinetics
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#decay-heat-is-stored-energy-not-delayed-neutron-population
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#poison-memory
//! The joined spine's nuclear block: regional populations, the one
//! material-owned precursor bank, fissile/fertile/poison inventories and the
//! 23 fission plus 2 fertile-capture energy histories of every carrier.
//!
//! Every row is differential: `y' - rhs = 0`. The same current source
//! feedback (fuel temperature, the network's water, boron, Xe/Sm, fertile
//! opacity and the rods' achieved travel) drives the populations, the
//! precursors and the achieved material fissions; those same fissions and
//! the same exposure feed depletion, poisons, capture and the histories.
//! There is no renormalization to nominal power. The composition is the one
//! `hot_spine` carried (operating-hot-spine.md, "What one call computes"),
//! with water now read from the network instead of a second liquid chart.
//!
//! The history rows are linear with constant coefficients in their own
//! store and in one event feed: `E' = y F - lambda E`. [`Nuclear::histories`]
//! exposes that structure (memo §6) so a block-analytic Jacobian can give
//! them constant entries; under stock IDA their `cj + lambda` diagonals are
//! eliminated by KLU's pivots, with every store retained in `y`.
//!
//! E-NUC (plan r4, owner 31 Oct: real time, computational efficiency for
//! several units): carriers whose own rows read bitwise-equal values are
//! exact replicas, and one coordinate per replica group carries the group's
//! extensive stock (the members' sum) of every precursor, material and
//! history. Every law is the per-carrier law, linear in those stocks at the
//! members' common intensive drivers (populations, exposure per m2, fissile
//! ratio), so the grouped rows are the members' rows summed: exact by
//! construction, nothing averaged. The populations' feedback reads each
//! member's own fuel temperature ([`replica_temperature`]); each member's
//! fuel and coolant heat is its share of the group's. A carrier that
//! differs in any bit is its own group. The layout records each group
//! coordinate's multiplicity, which the solver's error weights use to keep
//! the unreduced model's stock norm.
use super::{
    block::{Class, Coordinates, Layout},
    packet::Packet,
};
use crate::{
    capture, heat_history, kinetics, network::Failure, poisons, source_feedback as sf,
    thermal::Scalar,
};

const FISSION_GROUPS: usize = 23;
const CAPTURE_GROUPS: usize = 2;
/// Histories per carrier: 23 fission-product then 2 fertile-capture stores.
pub const HISTORIES: usize = FISSION_GROUPS + CAPTURE_GROUPS;
/// Material inventories per carrier, in this order.
pub const MATERIALS: [&str; 6] = ["fissile", "fertile", "I-135", "Xe-135", "Pm-149", "Sm-149"];
const DELAYED: usize = kinetics::DELAYED_GROUPS;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
/// A history's tangent at zero directions: exactly +0 (its coefficients
/// are nonnegative), the direction heat of an unseeded evaluation.
const UNSEEDED_HEAT: heat_history::Heat = heat_history::Heat {
    prompt_w: 0.,
    delayed_w: 0.,
    retained_input_w: 0.,
};
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined nuclear: {}", reason.into()))
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined nuclear: {reason}"))
}

/// E-NUC: a replica group's feedback fuel temperature, `[mean over its
/// members of sqrt(T_a)]^2` with `T_a` each member's own feedback
/// temperature (itself `[mean sqrt(T_node)]^2`), read at the group's ports
/// (`ports`, each standing for `counts[p]` members). The Doppler term is
/// linear in `sqrt(T)`, so the group's term is exactly its members' sum; a
/// group read at one port takes that port's temperature unchanged.
pub fn replica_temperature(
    ports: &[usize],
    counts: &[usize],
    fuel_t: &[Scalar],
) -> Result<Scalar, Failure> {
    if let [only] = ports {
        return Ok(fuel_t[*only]);
    }
    let mut sum = s(0.);
    let mut members = 0;
    for &p in ports {
        let t = fuel_t[p];
        if !(t.value.is_finite() && t.value > 0.) {
            return Err(trial(format!("port {p} fuel temperature {}", t.value)));
        }
        let root = t.value.sqrt();
        let m = counts[p] as f64;
        sum = sum + Scalar::new(m * root, m * t.direction / (2. * root));
        members += counts[p];
    }
    let mean = sum * s(1. / members as f64);
    Ok(mean * mean)
}

/// The current water state of one source region's owner cell.
#[derive(Clone, Copy, Debug)]
pub struct RegionWater {
    pub density_kg_m3: Scalar,
    pub boron_ppm_eq: Scalar,
    pub pressure_pa: Scalar,
    pub temperature_k: Scalar,
    /// The vapour mass of the owner cell (owner answer B1's phase-absence
    /// check reads it; the source feedback does not).
    pub vapor_kg: Scalar,
}

/// One linear history row: `E' = yield * feed - decay * E`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct History {
    /// Local coordinate (and row) of the store.
    pub index: usize,
    pub carrier: usize,
    pub decay_per_s: f64,
    pub retained_joules_per_event: f64,
    pub feed: Feed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feed {
    /// The carrier's achieved fissions `F_a = sum_i G_ai N_i`.
    Fission,
    /// The carrier's fertile captures `sigma_f * fertile * exposure`.
    Capture,
}

/// The constant structure of the 2,316 precursor and 9,650 history rows,
/// compiled once for a block-analytic Jacobian (JAC's shape). Every row is
/// `x' - (sum coefficient * feed - decay * x) = 0` in physical units; the
/// joined row divides by the layout's row scale. Indices are global joined
/// coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct LinearTemplate {
    pub rows: Vec<LinearRow>,
    /// `(feed index, rhs coefficient per feed unit)`.
    pub terms: Vec<(usize, f64)>,
    /// Feed `2a` is carrier `a`'s achieved fissions `F_a = sum_i G_ai N_i`,
    /// feed `2a + 1` its fertile captures `sigma_f fertile_a exposure_a`.
    pub feeds: Vec<TemplateFeed>,
    /// Constant uses of the stores elsewhere: `(target, global column,
    /// coefficient)`, physical rhs per unit store.
    pub consumers: Vec<(Target, usize, f64)>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct LinearRow {
    /// Global row, equal to its own coordinate.
    pub row: usize,
    pub decay_per_s: f64,
    /// Its terms in [`LinearTemplate::terms`].
    pub terms: std::ops::Range<usize>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateFeed {
    Fission { carrier: usize },
    Capture { carrier: usize },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// A regional population row (global): delayed emission `W_ia lambda C`.
    Row(usize),
    /// A carrier's fuel heat: the released history energy `lambda E`.
    FuelHeat(usize),
    /// A carrier's direct coolant heat (no constant store use at present).
    CoolantHeat(usize),
}

/// The nuclear block's compiled coefficients, read-only.
#[derive(Clone, Copy, Debug)]
pub struct Coefficients<'a> {
    pub capture: capture::Parameters,
    pub poison: &'a poisons::Model,
    pub reference_fertile: &'a [f64],
    pub transfer_rates_per_s: &'a [f64],
    pub emission_fractions: &'a [f64],
    pub outside_fractions: &'a [f64],
    /// Source capsule age at t = 0; the feedback reads `age0 + t`.
    pub capsule_age0_s: f64,
    /// 23 fission then 2 capture groups.
    pub groups: &'a [super::packet::Group],
    pub fission: &'a heat_history::Model,
    pub fertile: &'a heat_history::Model,
    pub prompt_coolant_fraction: f64,
    pub binding_coolant_fraction: f64,
    pub xenon_binding_j: f64,
    pub samarium_binding_j: f64,
    pub xenon_cross_section_m2: f64,
    pub samarium_cross_section_m2: f64,
    pub delayed_yields_per_fission: &'a [[f64; DELAYED]],
    pub precursor_decay_per_s: &'a [[f64; DELAYED]],
}

/// Per-carrier heat and diagnostics of the last evaluation.
#[derive(Clone, Debug, Default)]
pub struct Heat {
    /// Into the carrier's two fuel nodes, split equally by mass (W).
    pub fuel_w: Vec<Scalar>,
    /// Direct coolant deposition of the carrier (W), before its projection.
    pub coolant_w: Vec<Scalar>,
    /// Prompt + retained-input + binding: the event energy release rate.
    pub event_w: Scalar,
    /// Heat actually released into thermal recipients now.
    pub released_w: Scalar,
    /// Rate of change of the retained history energy.
    pub stored_rate_w: Scalar,
}

pub struct Nuclear {
    layout: Layout,
    prepared: Vec<f64>,
    feedback: sf::Model,
    kinetics: kinetics::Model,
    fission: heat_history::Model,
    fertile: heat_history::Model,
    capture: capture::Parameters,
    poison: poisons::Model,
    xenon_cross_section: f64,
    samarium_cross_section: f64,
    xenon_binding_j: f64,
    samarium_binding_j: f64,
    prompt_coolant_fraction: f64,
    binding_coolant_fraction: f64,
    reference_fertile: Vec<f64>,
    transfer_rates: Vec<f64>,
    emission: Vec<f64>,
    outside: Vec<f64>,
    capsule_age0_s: f64,
    /// The compiled groups, fission then capture, for [`Nuclear::histories`].
    groups: Vec<super::packet::Group>,
    /// Per port: (network cell, fraction) of its direct coolant heat, the
    /// fraction carrying the port's member count.
    deposition: Vec<Vec<(usize, f64)>>,
    /// Per carrier: (network cell, fraction) of its direct coolant heat.
    carrier_deposition: Vec<Vec<(usize, f64)>>,
    regions: usize,
    /// The packet's material carriers (the solids' halves).
    carriers: usize,
    /// E-NUC replica groups: each carrier's group, each group's members in
    /// carrier order (the first is its representative).
    group_of: Vec<usize>,
    members: Vec<Vec<usize>>,
    /// The packet's (region, carrier) supports, packet order.
    carrier_supports: Vec<kinetics::Support>,
    /// E-NUC phase B: the heat and fuel temperature ports, one per solids
    /// half; port `p` stands for `port_count[p]` identical carriers of group
    /// `port_group[p]`, represented by carrier `port_carrier[p]`. Until
    /// [`Nuclear::set_ports`], one port per carrier.
    port_carrier: Vec<usize>,
    port_count: Vec<usize>,
    port_group: Vec<usize>,
    /// Per group: its ports.
    group_ports: Vec<Vec<usize>>,
    /// The (region, port) supports of every port's representative.
    port_supports: Vec<kinetics::Support>,
    /// Compiled (region, group) supports, kinetics and feedback order.
    supports: Vec<kinetics::Support>,
    /// Per material: delayed yields and decay constants (kinetics order).
    delayed_yields: Vec<[f64; DELAYED]>,
    precursor_decay: Vec<[f64; DELAYED]>,
    // Preallocated stage buffers; nothing allocates on the success path.
    work: Work,
}

/// The source feedback's inputs of one evaluation, values only.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct FeedbackInputs {
    pub neutrons: Vec<f64>,
    /// Per replica group (the feedback's materials): [mean(sqrt(T))]^2
    /// over its members' nodes ([`replica_temperature`]).
    pub fuel_temperature_k: Vec<f64>,
    /// Per region.
    pub water_density_kg_m3: Vec<f64>,
    pub boron_ppm_eq: Vec<f64>,
    pub pressure_pa: Vec<f64>,
    pub moderator_temperature_k: Vec<f64>,
    /// Per replica group, extensive (the members' sum).
    pub fissile_atoms: Vec<f64>,
    pub xenon_atoms: Vec<f64>,
    pub samarium_atoms: Vec<f64>,
    pub capture_loss_change_m2: Vec<f64>,
}

#[derive(Default)]
struct Work {
    feedback: Option<sf::Output>,
    fuel_t: Vec<Scalar>,
    fissile: Vec<Scalar>,
    xenon: Vec<Scalar>,
    samarium: Vec<Scalar>,
    opacity: Vec<Scalar>,
    density: Vec<Scalar>,
    boron: Vec<Scalar>,
    pressure: Vec<Scalar>,
    moderator: Vec<Scalar>,
    neutrons: Vec<Scalar>,
    state_value: Vec<f64>,
    state_direction: Vec<f64>,
    rate_value: Vec<f64>,
    rate_direction: Vec<f64>,
    region_value: Vec<kinetics::RegionInput>,
    region_direction: Vec<kinetics::RegionInput>,
    production_value: Vec<f64>,
    production_direction: Vec<f64>,
    zero_transfer: Vec<f64>,
    zero_emission: Vec<f64>,
    zero_outside: Vec<f64>,
    /// Per group: the feedback fuel temperature of its members.
    group_t: Vec<Scalar>,
    fission_value: Vec<f64>,
    fission_direction: Vec<f64>,
    history_value: Vec<f64>,
    history_direction: Vec<f64>,
    history_rate_value: Vec<f64>,
    history_rate_direction: Vec<f64>,
}

impl Nuclear {
    /// Compile once from the packet: the same models and checks the retired
    /// hot spine's workspace made. `water_cells` is the network's regular
    /// cell count.
    pub fn new(packet: &Packet, water_cells: usize) -> Result<Self, Failure> {
        let source = &packet.hot.source;
        let energy = &packet.hot.energy;
        let meta = &packet.feedback_metadata;
        let feedback = sf::Model::new(
            meta.parameters,
            meta.regions.clone(),
            meta.materials.clone(),
            meta.supports.clone(),
        )
        .map_err(|e| fatal(format!("source feedback: {e}")))?;
        let kinetics = kinetics::Model::new(
            source.regions.clone(),
            source.materials.clone(),
            source.transfers.clone(),
            source.supports.clone(),
        )
        .map_err(|e| fatal(format!("kinetics: {e}")))?;
        let groups = |g: &[super::packet::Group]| {
            g.iter()
                .map(|g| heat_history::Group {
                    decay_per_s: g.decay_per_s,
                    retained_joules_per_event: g.retained_joules_per_event,
                })
                .collect::<Vec<_>>()
        };
        let fission = heat_history::Model::new(
            energy.fission_joules_per_event,
            groups(&energy.fission_groups),
        )
        .map_err(|e| fatal(format!("fission history: {e}")))?;
        let capture_energy: f64 = energy
            .capture_groups
            .iter()
            .map(|g| g.retained_joules_per_event)
            .sum();
        let fertile = heat_history::Model::new(capture_energy, groups(&energy.capture_groups))
            .map_err(|e| fatal(format!("capture history: {e}")))?;
        let capture = capture::Parameters {
            cross_section_m2: energy.fertile_cross_section_m2,
            binding_joules_per_capture: energy.fertile_binding_joules_per_capture,
        };
        capture
            .validate()
            .map_err(|e| fatal(format!("capture: {e}")))?;
        let poison = poisons::Model::new(poisons::Parameters {
            decay_per_s: energy.poison_decay_per_s,
            direct_atoms_per_fission: energy.poison_yields_per_fission,
        })
        .map_err(|e| fatal(format!("poisons: {e}")))?;
        let r = source.regions.len();
        let a = energy.carriers.len();
        let inputs = &source.inputs;
        if r == 0
            || a == 0
            || feedback.region_count() != r
            || feedback.material_count() != a
            || kinetics.state_dimension() != r + DELAYED * a
            || kinetics.region_count() != r
            || kinetics.material_count() != a
            || kinetics.support_count() != feedback.support_count()
            || inputs.transfer_rates_per_s.len() != kinetics.transfer_count()
            || inputs.emission_fractions.len() != feedback.support_count()
            || inputs.outside_fractions.len() != a
            || fission.dimension() != FISSION_GROUPS
            || fertile.dimension() != CAPTURE_GROUPS
            || source.prepared_state.len() != r + DELAYED * a
            || packet.source_water.len() != r
            || packet.source_water.iter().any(|j| *j >= water_cells)
            || energy
                .carriers
                .iter()
                .any(|c| c.stores_j.len() != HISTORIES)
            || feedback.rod_count() != packet.feedback_reference.achieved_rod_travel_m.len()
        {
            return Err(fatal("inconsistent nuclear allocation"));
        }
        if inputs
            .transfer_rates_per_s
            .iter()
            .chain(&inputs.emission_fractions)
            .chain(&inputs.outside_fractions)
            .any(|v| !v.is_finite() || *v < 0.)
            || [
                energy.xenon_cross_section_m2,
                energy.samarium_cross_section_m2,
                energy.xenon_binding_joules_per_capture,
                energy.samarium_binding_joules_per_capture,
            ]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.)
            || [
                energy.binding_coolant_fraction,
                energy.prompt_fission_coolant_fraction,
            ]
            .iter()
            .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
        {
            return Err(fatal("invalid nuclear coefficient"));
        }
        // Direct coolant deposition: the carrier's current emission shares,
        // projected through each region's water owner (the retired hot
        // spine's map).
        let mut deposition = vec![std::collections::BTreeMap::new(); a];
        for (k, support) in source.supports.iter().enumerate() {
            *deposition[support.material]
                .entry(packet.source_water[support.region])
                .or_insert(0.) += inputs.emission_fractions[k];
        }
        let deposition: Vec<Vec<(usize, f64)>> = deposition
            .into_iter()
            .map(|m| m.into_iter().collect())
            .collect();
        for (carrier, d) in deposition.iter().enumerate() {
            let total: f64 = d.iter().map(|(_, f)| f).sum();
            if (total - 1.).abs() > 1e-12 {
                return Err(fatal(format!(
                    "carrier {carrier} deposits {total} of its coolant heat inside the water"
                )));
            }
        }
        if energy
            .carriers
            .iter()
            .any(|c| !c.fertile_atoms.is_finite() || c.fertile_atoms <= 0.)
        {
            return Err(fatal("nonpositive reference fertile inventory"));
        }
        // E-NUC (plan r4): exact replica groups. Two carriers are replicas
        // when every value their own rows read is bitwise equal: their
        // supports (region, production, exposure, importance, emission),
        // feedback references, delayed data, outside share and prepared
        // stocks. Their rows are then the same equations of the same
        // inputs, so one representative per group carries the group's
        // extensive stocks (the members' sum) and the members read its
        // intensive share. A carrier that differs in any bit is its own
        // group: nothing is averaged.
        if meta.supports.len() != source.supports.len()
            || meta
                .supports
                .iter()
                .zip(&source.supports)
                .any(|(f, k)| f.region != k.region || f.material != k.material)
        {
            return Err(fatal("feedback and kinetics supports differ"));
        }
        let mut of_carrier = vec![Vec::new(); a];
        for (k, support) in source.supports.iter().enumerate() {
            of_carrier[support.material].push(k);
        }
        for ks in &mut of_carrier {
            ks.sort_by_key(|k| source.supports[*k].region);
        }
        let signature = |c: usize| -> Vec<u64> {
            let mut key = Vec::new();
            for &k in &of_carrier[c] {
                let f = &meta.supports[k];
                key.push(f.region as u64);
                for v in [
                    f.production_reference_per_s,
                    f.exposure_per_population_s_m2,
                    f.fuel_importance,
                    inputs.emission_fractions[k],
                ] {
                    key.push(v.to_bits());
                }
            }
            let m = &meta.materials[c];
            let d = &source.materials[c];
            let e = &energy.carriers[c];
            let values = [
                m.reference_fissile_atoms,
                m.reference_fuel_temperature_k,
                m.reference_xenon_atoms,
                m.reference_samarium_atoms,
                m.reference_nonpoison_capture_opacity_m2,
                inputs.outside_fractions[c],
                e.fissile_atoms,
                e.fertile_atoms,
            ];
            key.extend(
                values
                    .iter()
                    .chain(&d.delayed_yields_per_fission)
                    .chain(&d.decay_constants_per_s)
                    .chain(&e.poison_atoms)
                    .chain(&e.stores_j)
                    .chain(&source.prepared_state[r + DELAYED * c..r + DELAYED * (c + 1)])
                    .map(|v| v.to_bits()),
            );
            key
        };
        let mut index = std::collections::HashMap::<Vec<u64>, usize>::new();
        let mut members: Vec<Vec<usize>> = Vec::new();
        let group_of: Vec<usize> = (0..a)
            .map(|c| {
                *index.entry(signature(c)).or_insert_with(|| {
                    members.push(Vec::new());
                    members.len() - 1
                })
            })
            .collect();
        for (c, g) in group_of.iter().enumerate() {
            members[*g].push(c);
        }
        let n = members.len();
        let count: Vec<f64> = members.iter().map(|m| m.len() as f64).collect();
        let rep: Vec<usize> = members.iter().map(|m| m[0]).collect();
        // The groups' compiled models: a group is one material whose
        // extensive references and productions are its members' sum, and
        // whose exposure per population stays the members' (intensive).
        let mut group_supports = Vec::new();
        let mut feedback_supports = Vec::new();
        let mut emission = Vec::new();
        for (g, &c) in rep.iter().enumerate() {
            for k in (0..source.supports.len()).filter(|k| source.supports[*k].material == c) {
                let f = meta.supports[k];
                group_supports.push(kinetics::Support {
                    region: f.region,
                    material: g,
                });
                feedback_supports.push(sf::Support {
                    region: f.region,
                    material: g,
                    production_reference_per_s: count[g] * f.production_reference_per_s,
                    exposure_per_population_s_m2: f.exposure_per_population_s_m2,
                    fuel_importance: count[g] * f.fuel_importance,
                });
                emission.push(inputs.emission_fractions[k]);
            }
        }
        let feedback_materials: Vec<sf::Material> = rep
            .iter()
            .zip(&count)
            .map(|(&c, &m)| {
                let x = meta.materials[c];
                sf::Material {
                    reference_fissile_atoms: m * x.reference_fissile_atoms,
                    reference_fuel_temperature_k: x.reference_fuel_temperature_k,
                    reference_xenon_atoms: m * x.reference_xenon_atoms,
                    reference_samarium_atoms: m * x.reference_samarium_atoms,
                    reference_nonpoison_capture_opacity_m2: m
                        * x.reference_nonpoison_capture_opacity_m2,
                }
            })
            .collect();
        let feedback = sf::Model::new(
            meta.parameters,
            meta.regions.clone(),
            feedback_materials,
            feedback_supports,
        )
        .map_err(|e| fatal(format!("grouped source feedback: {e}")))?;
        let kinetics = kinetics::Model::new(
            source.regions.clone(),
            rep.iter().map(|&c| source.materials[c]).collect(),
            source.transfers.clone(),
            group_supports.clone(),
        )
        .map_err(|e| fatal(format!("grouped kinetics: {e}")))?;
        let outside: Vec<f64> = rep.iter().map(|&c| inputs.outside_fractions[c]).collect();
        let reference_fertile: Vec<f64> = rep
            .iter()
            .zip(&count)
            .map(|(&c, &m)| m * energy.carriers[c].fertile_atoms)
            .collect();
        // Layout: N, C (the kinetics state order), materials, histories;
        // every group coordinate stands for its members' coordinates.
        let mut layout = Layout::default();
        let mut prepared = Vec::with_capacity(r + (DELAYED + 6 + HISTORIES) * n);
        let mut push =
            |layout: &mut Layout, label: String, class: Class, value: f64, multiplicity: usize| {
                layout.push_replicated(label, class, true, value, value, multiplicity);
                prepared.push(value);
            };
        for (i, v) in source.prepared_state[..r].iter().enumerate() {
            push(
                &mut layout,
                format!("N[{i}]"),
                Class::RegionalPopulation,
                *v,
                1,
            );
        }
        let name = |g: usize| format!("{}x{}", energy.carriers[rep[g]].id, members[g].len());
        for g in 0..n {
            for k in 0..DELAYED {
                let v = source.prepared_state[r + DELAYED * rep[g] + k];
                push(
                    &mut layout,
                    format!("C[{}][{k}]", name(g)),
                    Class::Precursor,
                    count[g] * v,
                    members[g].len(),
                );
            }
        }
        let material_classes = [
            Class::Fissile,
            Class::Fertile,
            Class::Iodine,
            Class::Xenon,
            Class::Promethium,
            Class::Samarium,
        ];
        for g in 0..n {
            let c = &energy.carriers[rep[g]];
            let values = [
                c.fissile_atoms,
                c.fertile_atoms,
                c.poison_atoms[0],
                c.poison_atoms[1],
                c.poison_atoms[2],
                c.poison_atoms[3],
            ];
            for ((label, class), v) in MATERIALS.iter().zip(material_classes).zip(values) {
                push(
                    &mut layout,
                    format!("{label}[{}]", name(g)),
                    class,
                    count[g] * v,
                    members[g].len(),
                );
            }
        }
        for g in 0..n {
            for (k, v) in energy.carriers[rep[g]].stores_j.iter().enumerate() {
                let class = if k < FISSION_GROUPS {
                    Class::FissionHistory
                } else {
                    Class::CaptureHistory
                };
                push(
                    &mut layout,
                    format!("E[{}][{k}]", name(g)),
                    class,
                    count[g] * v,
                    members[g].len(),
                );
            }
        }
        layout.validate("joined nuclear")?;
        let h = HISTORIES;
        let work = Work {
            feedback: Some(sf::Output::new(r, n, feedback.support_count())),
            fuel_t: vec![s(0.); a],
            fissile: vec![s(0.); n],
            xenon: vec![s(0.); n],
            samarium: vec![s(0.); n],
            opacity: vec![s(0.); n],
            density: vec![s(0.); r],
            boron: vec![s(0.); r],
            pressure: vec![s(0.); r],
            moderator: vec![s(0.); r],
            neutrons: vec![s(0.); r],
            state_value: vec![0.; r + DELAYED * n],
            state_direction: vec![0.; r + DELAYED * n],
            rate_value: vec![0.; r + DELAYED * n],
            rate_direction: vec![0.; r + DELAYED * n],
            region_value: vec![
                kinetics::RegionInput {
                    reactivity: 0.,
                    external_source_per_s: 0.
                };
                r
            ],
            region_direction: vec![
                kinetics::RegionInput {
                    reactivity: 0.,
                    external_source_per_s: 0.
                };
                r
            ],
            production_value: vec![0.; feedback.support_count()],
            production_direction: vec![0.; feedback.support_count()],
            zero_transfer: vec![0.; kinetics.transfer_count()],
            zero_emission: vec![0.; feedback.support_count()],
            zero_outside: vec![0.; n],
            group_t: vec![s(0.); n],
            fission_value: vec![0.; n],
            fission_direction: vec![0.; n],
            history_value: vec![0.; h],
            history_direction: vec![0.; h],
            history_rate_value: vec![0.; h],
            history_rate_direction: vec![0.; h],
        };
        Ok(Self {
            layout,
            prepared,
            feedback,
            kinetics,
            fission,
            fertile,
            capture,
            poison,
            xenon_cross_section: energy.xenon_cross_section_m2,
            samarium_cross_section: energy.samarium_cross_section_m2,
            xenon_binding_j: energy.xenon_binding_joules_per_capture,
            samarium_binding_j: energy.samarium_binding_joules_per_capture,
            prompt_coolant_fraction: energy.prompt_fission_coolant_fraction,
            binding_coolant_fraction: energy.binding_coolant_fraction,
            reference_fertile,
            transfer_rates: inputs.transfer_rates_per_s.clone(),
            emission,
            outside,
            capsule_age0_s: packet.feedback_reference.capsule_age_s,
            groups: energy
                .fission_groups
                .iter()
                .chain(&energy.capture_groups)
                .copied()
                .collect(),
            deposition: deposition.clone(),
            carrier_deposition: deposition,
            regions: r,
            carriers: a,
            port_carrier: (0..a).collect(),
            port_count: vec![1; a],
            port_group: group_of.clone(),
            group_ports: members.clone(),
            port_supports: source.supports.clone(),
            group_of,
            members,
            carrier_supports: source.supports.clone(),
            supports: group_supports,
            delayed_yields: rep
                .iter()
                .map(|&c| source.materials[c].delayed_yields_per_fission)
                .collect(),
            precursor_decay: rep
                .iter()
                .map(|&c| source.materials[c].decay_constants_per_s)
                .collect(),
            work,
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    pub fn prepared(&self) -> &[f64] {
        &self.prepared
    }
    pub fn regions(&self) -> usize {
        self.regions
    }
    /// The packet's material carriers.
    pub fn carriers(&self) -> usize {
        self.carriers
    }
    /// E-NUC: the heat and fuel temperature ports, one per solids half: the
    /// length of the fuel temperature port and of [`Heat::fuel_w`] /
    /// `coolant_w`. Each port's heat is one member carrier's.
    pub fn ports(&self) -> usize {
        self.port_carrier.len()
    }
    /// Each port's replica group.
    pub fn port_group(&self) -> &[usize] {
        &self.port_group
    }
    /// Each port's member count.
    pub fn port_count(&self) -> &[usize] {
        &self.port_count
    }
    /// Each group's ports.
    pub fn group_ports(&self) -> &[Vec<usize>] {
        &self.group_ports
    }
    /// The (region, port) supports of every port's representative carrier:
    /// which regions' populations a port's fissions read.
    pub fn port_supports(&self) -> &[kinetics::Support] {
        &self.port_supports
    }
    /// E-NUC phase B: the solids' halves as ports, each listing the
    /// identical carriers it stands for (`members[p]`, carrier indices).
    /// Every carrier is in exactly one port, and a port's carriers are of
    /// one replica group with bitwise-equal coolant deposition; otherwise
    /// the ports are refused.
    pub fn set_ports(&mut self, members: &[Vec<usize>]) -> Result<(), Failure> {
        let mut seen = vec![false; self.carriers];
        let mut port_group = Vec::with_capacity(members.len());
        for (p, m) in members.iter().enumerate() {
            let Some(&first) = m.first() else {
                return Err(fatal(format!("port {p} stands for no carrier")));
            };
            for &c in m {
                if c >= self.carriers || std::mem::replace(&mut seen[c], true) {
                    return Err(fatal(format!("carrier {c} outside the ports or in two")));
                }
                if self.group_of[c] != self.group_of[first]
                    || self.carrier_deposition[c] != self.carrier_deposition[first]
                {
                    return Err(fatal(format!(
                        "port {p}: carrier {c} is not a replica of carrier {first}"
                    )));
                }
            }
            port_group.push(self.group_of[first]);
        }
        if seen.contains(&false) {
            return Err(fatal("a carrier has no port"));
        }
        let mut group_ports = vec![Vec::new(); self.members.len()];
        for (p, g) in port_group.iter().enumerate() {
            group_ports[*g].push(p);
        }
        self.port_carrier = members.iter().map(|m| m[0]).collect();
        self.port_count = members.iter().map(Vec::len).collect();
        self.port_group = port_group;
        self.group_ports = group_ports;
        self.port_supports = self
            .carrier_supports
            .iter()
            .flat_map(|k| {
                self.port_carrier
                    .iter()
                    .enumerate()
                    .filter(move |(_, c)| **c == k.material)
                    .map(move |(p, _)| kinetics::Support {
                        region: k.region,
                        material: p,
                    })
            })
            .collect();
        self.deposition = self
            .port_carrier
            .iter()
            .zip(&self.port_count)
            .map(|(c, m)| {
                self.carrier_deposition[*c]
                    .iter()
                    .map(|(cell, f)| (*cell, f * *m as f64))
                    .collect()
            })
            .collect();
        self.work.fuel_t = vec![s(0.); members.len()];
        Ok(())
    }
    /// E-NUC: the number of replica groups, the kinetics' and feedback's
    /// materials ([`Self::precursor`], [`Self::material`] and
    /// [`Self::history`] index groups).
    pub fn replica_groups(&self) -> usize {
        self.members.len()
    }
    /// Each carrier's replica group.
    pub fn group_of(&self) -> &[usize] {
        &self.group_of
    }
    /// Each group's member carriers, carrier order.
    pub fn members(&self) -> &[Vec<usize>] {
        &self.members
    }
    /// The packet's (region, carrier) supports, packet order: which
    /// regions' populations a carrier's fissions read.
    pub fn carrier_supports(&self) -> &[kinetics::Support] {
        &self.carrier_supports
    }
    /// E-NUC: the 18,708-layout local coordinates of this block (one per
    /// carrier, the packet's order) reduced to this layout's: each group
    /// coordinate takes its members' common solver value. A member that
    /// differs in any bit is refused: a state of non-replicas has no
    /// grouped representation, and nothing is averaged. `full` is in
    /// solver units, the unreduced layout `N, C (6 per carrier), materials
    /// (6 per carrier), histories (25 per carrier)`.
    pub fn reduce_carrier_state(&self, full: &[f64]) -> Result<Vec<f64>, String> {
        let (r, a, n) = (self.regions, self.carriers, self.members.len());
        if full.len() != r + (DELAYED + 6 + HISTORIES) * a {
            return Err(format!(
                "a carrier-layout nuclear state has {} coordinates, not {}",
                full.len(),
                r + (DELAYED + 6 + HISTORIES) * a
            ));
        }
        let mut out = full[..r].to_vec();
        out.resize(self.layout.len(), 0.);
        for (width, full_base, base) in [
            (DELAYED, r, r),
            (6, r + DELAYED * a, r + DELAYED * n),
            (HISTORIES, r + (DELAYED + 6) * a, r + (DELAYED + 6) * n),
        ] {
            for (g, members) in self.members.iter().enumerate() {
                for k in 0..width {
                    let v = full[full_base + width * members[0] + k];
                    if let Some(c) = members
                        .iter()
                        .find(|c| full[full_base + width * **c + k].to_bits() != v.to_bits())
                    {
                        return Err(format!(
                            "carrier {c} differs from its replica {} at coordinate {k} of {width}: not a replica state",
                            members[0]
                        ));
                    }
                    out[base + width * g + k] = v;
                }
            }
        }
        Ok(out)
    }
    pub fn feedback(&self) -> &sf::Model {
        &self.feedback
    }
    pub fn kinetics(&self) -> &kinetics::Model {
        &self.kinetics
    }
    /// Each group's declared outside-field emission fraction.
    pub fn outside_fractions(&self) -> &[f64] {
        &self.outside
    }
    /// The water cells receiving each port's direct coolant heat, each
    /// fraction carrying the port's member count.
    pub fn deposition(&self) -> &[Vec<(usize, f64)>] {
        &self.deposition
    }
    /// The compiled (region, group) supports, kinetics and feedback order.
    pub fn supports(&self) -> &[kinetics::Support] {
        &self.supports
    }
    /// Every compiled coefficient the rows read, read-only.
    pub fn coefficients(&self) -> Coefficients<'_> {
        Coefficients {
            capture: self.capture,
            poison: &self.poison,
            reference_fertile: &self.reference_fertile,
            transfer_rates_per_s: &self.transfer_rates,
            emission_fractions: &self.emission,
            outside_fractions: &self.outside,
            capsule_age0_s: self.capsule_age0_s,
            groups: &self.groups,
            fission: &self.fission,
            fertile: &self.fertile,
            prompt_coolant_fraction: self.prompt_coolant_fraction,
            binding_coolant_fraction: self.binding_coolant_fraction,
            xenon_binding_j: self.xenon_binding_j,
            samarium_binding_j: self.samarium_binding_j,
            xenon_cross_section_m2: self.xenon_cross_section,
            samarium_cross_section_m2: self.samarium_cross_section,
            delayed_yields_per_fission: &self.delayed_yields,
            precursor_decay_per_s: &self.precursor_decay,
        }
    }
    /// The precursor and history rows' constant structure, with this
    /// block's coordinates starting at global index `offset`.
    pub fn linear_template(&self, offset: usize) -> LinearTemplate {
        let a = self.members.len();
        let mut t = LinearTemplate {
            rows: Vec::with_capacity(DELAYED * a + HISTORIES * a),
            terms: Vec::with_capacity(DELAYED * a + HISTORIES * a),
            feeds: (0..a)
                .flat_map(|carrier| {
                    [
                        TemplateFeed::Fission { carrier },
                        TemplateFeed::Capture { carrier },
                    ]
                })
                .collect(),
            consumers: Vec::new(),
        };
        // C'_ag = sum_i nu_ag G_ai N_i - lambda C = nu_ag F_a - lambda C.
        for m in 0..a {
            for g in 0..DELAYED {
                let k = t.terms.len();
                t.terms.push((2 * m, self.delayed_yields[m][g]));
                t.rows.push(LinearRow {
                    row: offset + self.precursor(m, g),
                    decay_per_s: self.precursor_decay[m][g],
                    terms: k..k + 1,
                });
            }
        }
        for m in 0..a {
            for (g, group) in self.groups.iter().enumerate() {
                let feed = if g < FISSION_GROUPS { 2 * m } else { 2 * m + 1 };
                let k = t.terms.len();
                t.terms.push((feed, group.retained_joules_per_event));
                t.rows.push(LinearRow {
                    row: offset + self.history(m, g),
                    decay_per_s: group.decay_per_s,
                    terms: k..k + 1,
                });
                // E-NUC: each port's fuel heat is one member's share of the
                // group's released energy.
                let share = 1. / self.members[m].len() as f64;
                for &port in &self.group_ports[m] {
                    t.consumers.push((
                        Target::FuelHeat(port),
                        offset + self.history(m, g),
                        group.decay_per_s * share,
                    ));
                }
            }
        }
        // Delayed emission into the regional populations.
        for (k, support) in self.supports.iter().enumerate() {
            for g in 0..DELAYED {
                t.consumers.push((
                    Target::Row(offset + support.region),
                    offset + self.precursor(support.material, g),
                    self.emission[k] * self.precursor_decay[support.material][g],
                ));
            }
        }
        t
    }
    /// Local index of replica group `a`'s precursor group `g` (a carrier's
    /// is its group's, [`Self::group_of`]).
    pub fn precursor(&self, a: usize, g: usize) -> usize {
        self.regions + DELAYED * a + g
    }
    /// Local index of replica group `a`'s material inventory `k`
    /// ([`MATERIALS`]).
    pub fn material(&self, a: usize, k: usize) -> usize {
        self.regions + DELAYED * self.members.len() + 6 * a + k
    }
    /// Local index of replica group `a`'s history store `g`.
    pub fn history(&self, a: usize, g: usize) -> usize {
        let n = self.members.len();
        self.regions + DELAYED * n + 6 * n + HISTORIES * a + g
    }
    /// Every linear history row with its constant coefficients and feed
    /// (`carrier` is the replica group).
    pub fn histories(&self) -> Vec<History> {
        let n = self.members.len();
        let mut out = Vec::with_capacity(HISTORIES * n);
        for a in 0..n {
            for (g, group) in self.groups.iter().enumerate() {
                let feed = if g < FISSION_GROUPS {
                    Feed::Fission
                } else {
                    Feed::Capture
                };
                out.push(History {
                    index: self.history(a, g),
                    carrier: a,
                    decay_per_s: group.decay_per_s,
                    retained_joules_per_event: group.retained_joules_per_event,
                    feed,
                });
            }
        }
        out
    }

    /// Every own row (physical units) and the carriers' heat at these
    /// coordinates and conditions. `fuel_t` is each carrier's feedback
    /// temperature (the mean-sqrt functional of its two fuel nodes),
    /// `water` the owner cell of each source region, `travel` the rods'
    /// achieved travel and `t` the simulated time since preparation.
    #[allow(clippy::too_many_arguments)] // One block's stage: its coordinates and three ports.
    pub fn rows(
        &mut self,
        t: f64,
        x: Coordinates<'_>,
        fuel_t: &[Scalar],
        water: &[RegionWater],
        travel: &[Scalar],
        rows: &mut [Scalar],
        heat: &mut Heat,
    ) -> Result<(), Failure> {
        let (r, a, n) = (self.regions, self.port_carrier.len(), self.members.len());
        if x.len() != self.layout.len()
            || rows.len() != self.layout.len()
            || fuel_t.len() != a
            || water.len() != r
            || travel.len() != self.feedback.rod_count()
        {
            return Err(fatal("stage length"));
        }
        heat.fuel_w.resize(a, s(0.));
        heat.coolant_w.resize(a, s(0.));
        // An unseeded evaluation carries zero directions everywhere: its
        // rows' and heats' directions are exactly +0 without the tangent
        // laws (which are linear in those zero directions), so it evaluates
        // the values only.
        let seeded = x.seeded();
        let w = &mut self.work;
        let members = &self.members;
        let (group_ports, port_count) = (&self.group_ports, &self.port_count);
        let mut out = w.feedback.take().ok_or_else(|| fatal("feedback buffer"))?;
        let result = (|| {
            for (i, water) in water.iter().enumerate() {
                w.neutrons[i] = x.value(i);
                w.density[i] = water.density_kg_m3;
                w.boron[i] = water.boron_ppm_eq;
                w.pressure[i] = water.pressure_pa;
                w.moderator[i] = water.temperature_k;
            }
            let m0 = r + DELAYED * n;
            w.fuel_t.copy_from_slice(fuel_t);
            for (g, ports) in group_ports.iter().enumerate() {
                w.group_t[g] = replica_temperature(ports, port_count, &w.fuel_t)?;
            }
            for c in 0..n {
                w.fissile[c] = x.value(m0 + 6 * c);
                w.xenon[c] = x.value(m0 + 6 * c + 3);
                w.samarium[c] = x.value(m0 + 6 * c + 5);
                w.opacity[c] = s(self.capture.cross_section_m2)
                    * (x.value(m0 + 6 * c + 1) - s(self.reference_fertile[c]));
            }
            self.feedback
                .evaluate(
                    &w.neutrons,
                    sf::Conditions {
                        fuel_temperature_k: &w.group_t,
                        water_density_kg_m3: &w.density,
                        boron_ppm_eq: &w.boron,
                        pressure_pa: &w.pressure,
                        moderator_temperature_k: &w.moderator,
                        fissile_atoms: &w.fissile,
                        xenon_atoms: &w.xenon,
                        samarium_atoms: &w.samarium,
                        capture_loss_change_m2: &w.opacity,
                        achieved_rod_travel_m: travel,
                        capsule_age_s: s(self.capsule_age0_s + t),
                    },
                    &mut out,
                )
                .map_err(trial)?;
            // These SAME current rho/G drive populations, precursors and
            // fissions: feedback is not a parallel diagnostic.
            for i in 0..m0 {
                let v = x.value(i);
                w.state_value[i] = v.value;
                if seeded {
                    w.state_direction[i] = v.direction;
                }
            }
            for i in 0..r {
                w.region_value[i] = kinetics::RegionInput {
                    reactivity: out.regions[i].reactivity.value,
                    external_source_per_s: out.regions[i].external_source_per_s.value,
                };
                if seeded {
                    w.region_direction[i] = kinetics::RegionInput {
                        reactivity: out.regions[i].reactivity.direction,
                        external_source_per_s: out.regions[i].external_source_per_s.direction,
                    };
                }
            }
            for (k, g) in out.fissions_per_population_s.iter().enumerate() {
                w.production_value[k] = g.value;
                if seeded {
                    w.production_direction[k] = g.direction;
                }
            }
            let inputs = kinetics::Inputs {
                regions: &w.region_value,
                transfer_rates_per_s: &self.transfer_rates,
                fissions_per_population_s: &w.production_value,
                emission_fractions: &self.emission,
                outside_fractions: &self.outside,
            };
            let direction = kinetics::Inputs {
                regions: &w.region_direction,
                transfer_rates_per_s: &w.zero_transfer,
                fissions_per_population_s: &w.production_direction,
                emission_fractions: &w.zero_emission,
                outside_fractions: &w.zero_outside,
            };
            self.kinetics
                .rates(
                    &w.state_value,
                    inputs,
                    &mut w.rate_value,
                    &mut w.fission_value,
                )
                .map_err(trial)?;
            if seeded {
                self.kinetics
                    .directional_derivative(
                        &w.state_value,
                        inputs,
                        &w.state_direction,
                        direction,
                        &mut w.rate_direction,
                        &mut w.fission_direction,
                    )
                    .map_err(trial)?;
            } else {
                w.rate_direction.fill(0.);
                w.fission_direction.fill(0.);
                w.history_rate_direction.fill(0.);
            }
            for (i, row) in rows.iter_mut().enumerate().take(m0) {
                *row = x.rate(i) - Scalar::new(w.rate_value[i], w.rate_direction[i]);
            }
            heat.event_w = s(0.);
            heat.released_w = s(0.);
            heat.stored_rate_w = s(0.);
            for c in 0..n {
                let fissions = Scalar::new(w.fission_value[c], w.fission_direction[c]);
                let exposure = out.exposure_per_m2_s[c];
                let fertile = x.value(m0 + 6 * c + 1);
                let cap = self
                    .capture
                    .rates(fertile.value, exposure.value)
                    .map_err(trial)?;
                let dc = if seeded {
                    self.capture
                        .tangent(
                            fertile.value,
                            exposure.value,
                            fertile.direction,
                            exposure.direction,
                        )
                        .map_err(trial)?
                } else {
                    capture::Receipt {
                        captures_per_s: 0.,
                        target_rate_per_s: 0.,
                        product_rate_per_s: 0.,
                        binding_w: 0.,
                    }
                };
                let base = m0 + 6 * c;
                rows[base] = x.rate(base) + fissions;
                rows[base + 1] =
                    x.rate(base + 1) - Scalar::new(cap.target_rate_per_s, dc.target_rate_per_s);
                let inventories = [2, 3, 4, 5].map(|k| x.value(base + k));
                let captures = [
                    s(0.),
                    s(self.xenon_cross_section) * exposure,
                    s(0.),
                    s(self.samarium_cross_section) * exposure,
                ];
                let mut pr = [0.; 4];
                let mut dp = [0.; 4];
                let pv = inventories.map(|v| v.value);
                let pd = inventories.map(|v| v.direction);
                let pi = poisons::Input {
                    fissions_per_s: fissions.value,
                    capture_per_s: captures.map(|v| v.value),
                };
                self.poison.rates(&pv, pi, &mut pr).map_err(trial)?;
                if seeded {
                    self.poison
                        .tangent(
                            &pv,
                            pi,
                            &pd,
                            poisons::InputDirection {
                                fissions_per_s: fissions.direction,
                                capture_per_s: captures.map(|v| v.direction),
                            },
                            &mut dp,
                        )
                        .map_err(trial)?;
                }
                for k in 0..4 {
                    rows[base + 2 + k] = x.rate(base + 2 + k) - Scalar::new(pr[k], dp[k]);
                }
                let h0 = m0 + 6 * n + HISTORIES * c;
                for g in 0..HISTORIES {
                    let q = x.value(h0 + g);
                    w.history_value[g] = q.value;
                    if seeded {
                        w.history_direction[g] = q.direction;
                    }
                }
                let f = self
                    .fission
                    .rates(
                        &w.history_value[..FISSION_GROUPS],
                        fissions.value,
                        &mut w.history_rate_value[..FISSION_GROUPS],
                    )
                    .map_err(trial)?;
                let df = if seeded {
                    self.fission
                        .tangent(
                            &w.history_direction[..FISSION_GROUPS],
                            fissions.direction,
                            &mut w.history_rate_direction[..FISSION_GROUPS],
                        )
                        .map_err(trial)?
                } else {
                    UNSEEDED_HEAT
                };
                let cf = self
                    .fertile
                    .rates(
                        &w.history_value[FISSION_GROUPS..],
                        cap.captures_per_s,
                        &mut w.history_rate_value[FISSION_GROUPS..],
                    )
                    .map_err(trial)?;
                let dcf = if seeded {
                    self.fertile
                        .tangent(
                            &w.history_direction[FISSION_GROUPS..],
                            dc.captures_per_s,
                            &mut w.history_rate_direction[FISSION_GROUPS..],
                        )
                        .map_err(trial)?
                } else {
                    UNSEEDED_HEAT
                };
                for g in 0..HISTORIES {
                    let rate = Scalar::new(w.history_rate_value[g], w.history_rate_direction[g]);
                    heat.stored_rate_w = heat.stored_rate_w + rate;
                    rows[h0 + g] = x.rate(h0 + g) - rate;
                }
                let prompt = Scalar::new(f.prompt_w, df.prompt_w);
                let delayed = Scalar::new(f.delayed_w + cf.delayed_w, df.delayed_w + dcf.delayed_w);
                let binding = Scalar::new(cap.binding_w, dc.binding_w)
                    + s(self.xenon_binding_j) * out.poison_capture_per_s[c].xenon
                    + s(self.samarium_binding_j) * out.poison_capture_per_s[c].samarium;
                let fuel_w = s(1. - self.prompt_coolant_fraction) * prompt
                    + delayed
                    + s(1. - self.binding_coolant_fraction) * binding;
                let coolant_w = s(self.prompt_coolant_fraction) * prompt
                    + s(self.binding_coolant_fraction) * binding;
                heat.released_w = heat.released_w + fuel_w + coolant_w;
                // E-NUC: the group's heats are its members' sum; each port
                // receives one member's share.
                let share = s(1. / members[c].len() as f64);
                for &port in &group_ports[c] {
                    heat.fuel_w[port] = fuel_w * share;
                    heat.coolant_w[port] = coolant_w * share;
                }
                heat.event_w = heat.event_w
                    + prompt
                    + Scalar::new(
                        f.retained_input_w + cf.retained_input_w,
                        df.retained_input_w + dcf.retained_input_w,
                    )
                    + binding;
            }
            if rows
                .iter()
                .chain(&heat.fuel_w)
                .chain(&heat.coolant_w)
                .chain([&heat.event_w, &heat.released_w, &heat.stored_rate_w])
                .any(|v| !(v.value.is_finite() && v.direction.is_finite()))
            {
                return Err(trial("nonfinite nuclear row or heat"));
            }
            Ok(())
        })();
        w.feedback = Some(out);
        result
    }

    /// The source feedback output of the last evaluation (reactivities,
    /// fissions, exposures, rod overlap), for receipts and Z3.
    pub fn feedback_output(&self) -> Option<&sf::Output> {
        self.work.feedback.as_ref()
    }
    /// The source feedback's inputs of the last evaluation, values only, for
    /// a reactivity decomposition ([`sf::Model::reactivity_terms`]).
    pub fn feedback_inputs(&self) -> FeedbackInputs {
        let v = |x: &[Scalar]| x.iter().map(|s| s.value).collect();
        let w = &self.work;
        FeedbackInputs {
            neutrons: v(&w.neutrons),
            fuel_temperature_k: v(&w.group_t),
            water_density_kg_m3: v(&w.density),
            boron_ppm_eq: v(&w.boron),
            pressure_pa: v(&w.pressure),
            moderator_temperature_k: v(&w.moderator),
            fissile_atoms: v(&w.fissile),
            xenon_atoms: v(&w.xenon),
            samarium_atoms: v(&w.samarium),
            capture_loss_change_m2: v(&w.opacity),
        }
    }
}

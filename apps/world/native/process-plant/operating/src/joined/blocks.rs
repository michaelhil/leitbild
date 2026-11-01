//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Block stage-Jacobian pieces of the joined hot spine.
//!
//! The nuclear block's rows are linear in their stores for fixed inputs, so
//! its Jacobian is assembled from the same laws without seeded evaluation:
//! the constant linear template of the precursor and history rows
//! ([`Nuclear::linear_template`]), the kinetics' fixed-input entries, and
//! the exact partials of the inputs it reads (the source feedback's
//! reactivity and fission conversion, `sf::Model::partials`; the capture,
//! poison and history models' exact tangents along unit directions). Every
//! value is the residual's own at the same state; nothing is held beyond
//! one assembly and nothing falls back to another assembly.
use super::{
    nuclear::{LinearTemplate, Nuclear, RegionWater, Target},
    operator::{Joined, LocalCoupler, LocalRows, OwnerRows},
    presence::VaporPresence,
    solids::FUEL_HEAT_SPLIT,
};
use crate::{
    kinetics,
    network::{
        BlockJacobian, Failure, Fluid, Held, LocalCoupling, NetworkSeed, Properties, Receipts,
        Replay, Reuse, stratified,
    },
    poisons, source_feedback as sf,
    sparse::Pattern,
    thermal::{Scalar, WaterProperties},
};
use std::collections::{BTreeMap, BTreeSet};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn trial(reason: impl std::fmt::Display) -> Failure {
    Failure::Recoverable(format!("joined block Jacobian: {reason}"))
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined block Jacobian: {}", reason.into()))
}

/// The nuclear block's non-template partials at one state, in physical
/// right-hand-side units per physical input unit (each row is
/// `x' - rhs`), with global joined indices.
#[derive(Clone, Debug, Default)]
pub struct NuclearPartials {
    /// Per template feed (`2a` fissions, `2a + 1` fertile captures):
    /// `(global column, d feed / d x)`.
    pub feeds: Vec<Vec<(usize, f64)>>,
    /// `(global row, global column, d rhs / d x)` of the regional
    /// population and material rows over populations and materials; the
    /// template's constant entries are not repeated. Duplicates add.
    pub own: Vec<(usize, usize, f64)>,
    /// `(global row, carrier, d rhs / d fuel feedback temperature)`.
    pub fuel_t: Vec<(usize, usize, f64)>,
    /// `(global row, region, d rhs / d [water density, boron ppm, pressure,
    /// liquid temperature])`.
    pub water: Vec<(usize, usize, [f64; 4])>,
    /// `(global row, rod cluster, d rhs / d achieved travel)`.
    pub travel: Vec<(usize, usize, f64)>,
    /// `(carrier, global column, d fuel heat / d x)`, non-template.
    pub fuel_w: Vec<(usize, usize, f64)>,
    /// `(carrier, global column, d direct coolant heat / d x)`.
    pub coolant_w: Vec<(usize, usize, f64)>,
}

/// The nuclear block's partials at `x` (its own physical coordinates, in
/// layout order) and the port values `fuel_t`, `water` and `travel` that
/// [`Nuclear::rows`] reads, at simulated time `t`; `offset` is the block's
/// first global coordinate.
#[allow(clippy::too_many_arguments)] // One block's stage: its coordinates and three ports.
pub fn nuclear_partials(
    nuclear: &Nuclear,
    offset: usize,
    t: f64,
    x: &[f64],
    fuel_t: &[f64],
    water: &[RegionWater],
    travel: &[f64],
    out: &mut NuclearPartials,
) -> Result<(), Failure> {
    let (r, a, n) = (
        nuclear.regions(),
        nuclear.ports(),
        nuclear.replica_groups(),
    );
    let members = nuclear.members();
    let (group_ports, port_count) = (nuclear.group_ports(), nuclear.port_count());
    let k = nuclear.coefficients();
    let feedback = nuclear.feedback();
    let kinetics = nuclear.kinetics();
    let supports = nuclear.supports();
    if x.len() != nuclear.layout().len()
        || fuel_t.len() != a
        || water.len() != r
        || travel.len() != feedback.rod_count()
    {
        return Err(fatal("nuclear partials stage length"));
    }
    let m0 = r + kinetics::DELAYED_GROUPS * n;
    let material = |c: usize, m: usize| m0 + 6 * c + m;
    // The same conditions Nuclear::rows composes, as values.
    let neutrons: Vec<Scalar> = (0..r).map(|i| s(x[i])).collect();
    // E-NUC: each group's feedback temperature from its members' own (at
    // its ports), and d T_group / d T_port for the port chain.
    let port_t: Vec<Scalar> = fuel_t.iter().map(|v| s(*v)).collect();
    let fuel: Vec<Scalar> = group_ports
        .iter()
        .map(|ports| super::nuclear::replica_temperature(ports, port_count, &port_t))
        .collect::<Result<_, _>>()?;
    let mut chain = vec![1.; a];
    for (g, ports) in group_ports.iter().enumerate() {
        if ports.len() > 1 {
            let mean = fuel[g].value.sqrt();
            for &p in ports {
                chain[p] = mean * port_count[p] as f64
                    / (members[g].len() as f64 * fuel_t[p].sqrt());
            }
        }
    }
    let density: Vec<Scalar> = water.iter().map(|w| s(w.density_kg_m3.value)).collect();
    let boron: Vec<Scalar> = water.iter().map(|w| s(w.boron_ppm_eq.value)).collect();
    let pressure: Vec<Scalar> = water.iter().map(|w| s(w.pressure_pa.value)).collect();
    let moderator: Vec<Scalar> = water.iter().map(|w| s(w.temperature_k.value)).collect();
    let fissile: Vec<Scalar> = (0..n).map(|c| s(x[material(c, 0)])).collect();
    let xenon: Vec<Scalar> = (0..n).map(|c| s(x[material(c, 3)])).collect();
    let samarium: Vec<Scalar> = (0..n).map(|c| s(x[material(c, 5)])).collect();
    let opacity: Vec<Scalar> = (0..n)
        .map(|c| s(k.capture.cross_section_m2) * (s(x[material(c, 1)]) - s(k.reference_fertile[c])))
        .collect();
    let rods: Vec<Scalar> = travel.iter().map(|v| s(*v)).collect();
    let conditions = sf::Conditions {
        fuel_temperature_k: &fuel,
        water_density_kg_m3: &density,
        boron_ppm_eq: &boron,
        pressure_pa: &pressure,
        moderator_temperature_k: &moderator,
        fissile_atoms: &fissile,
        xenon_atoms: &xenon,
        samarium_atoms: &samarium,
        capture_loss_change_m2: &opacity,
        achieved_rod_travel_m: &rods,
        capsule_age_s: s(k.capsule_age0_s + t),
    };
    let mut values = sf::Output::new(r, n, supports.len());
    feedback
        .evaluate(&neutrons, conditions, &mut values)
        .map_err(trial)?;
    let mut fp = sf::Partials::default();
    feedback.partials(conditions, &mut fp).map_err(trial)?;
    // Kinetics at the same inputs.
    let regions: Vec<kinetics::RegionInput> = values
        .regions
        .iter()
        .map(|v| kinetics::RegionInput {
            // B1: the applied stuck-cluster term, as Nuclear::rows adds it.
            reactivity: v.reactivity.value + nuclear.stuck_worth_dk(),
            external_source_per_s: v.external_source_per_s.value,
        })
        .collect();
    let production: Vec<f64> = values
        .fissions_per_population_s
        .iter()
        .map(|g| g.value)
        .collect();
    let inputs = kinetics::Inputs {
        regions: &regions,
        transfer_rates_per_s: k.transfer_rates_per_s,
        fissions_per_population_s: &production,
        emission_fractions: k.emission_fractions,
        outside_fractions: k.outside_fractions,
    };
    out.feeds.clear();
    out.feeds.resize(2 * n, Vec::new());
    out.own.clear();
    out.fuel_t.clear();
    out.water.clear();
    out.travel.clear();
    out.fuel_w.clear();
    out.coolant_w.clear();
    // Fixed-input population entries over populations; the precursor rows
    // and the precursor columns of the population rows are the template's.
    kinetics
        .state_jacobian_entries(inputs, |row, column, v| {
            if row < r && column < r {
                out.own.push((offset + row, offset + column, v));
            }
        })
        .map_err(trial)?;
    // d N_i' / d rho_i = N_i / Lambda_i: the model's own reactivity action.
    // Region i's reactivity acts on population i alone, so one direction
    // with every region's unit reactivity gives each region's, entry for
    // entry the single-region direction's.
    let state = &x[..m0];
    let zero_state = vec![0.; m0];
    let unit_reactivity = vec![
        kinetics::RegionInput {
            reactivity: 1.,
            external_source_per_s: 0.
        };
        r
    ];
    let zero_transfer = vec![0.; k.transfer_rates_per_s.len()];
    let zero_production = vec![0.; production.len()];
    let zero_emission = vec![0.; k.emission_fractions.len()];
    let zero_outside = vec![0.; k.outside_fractions.len()];
    let mut rates = vec![0.; m0];
    let mut fissions = vec![0.; n];
    kinetics
        .directional_derivative(
            state,
            inputs,
            &zero_state,
            kinetics::Inputs {
                regions: &unit_reactivity,
                transfer_rates_per_s: &zero_transfer,
                fissions_per_population_s: &zero_production,
                emission_fractions: &zero_emission,
                outside_fractions: &zero_outside,
            },
            &mut rates,
            &mut fissions,
        )
        .map_err(trial)?;
    let per_reactivity = &rates[..r];
    let beta: Vec<f64> = k
        .delayed_yields_per_fission
        .iter()
        .map(|y| y.iter().sum())
        .collect();
    // Per carrier: d F / d fissile = sum_k dG_k/dfissile N_i(k).
    let mut fission_fissile = vec![0.; n];
    for (sk, sp) in supports.iter().zip(&fp.supports) {
        fission_fissile[sk.material] += sp.production_fissile * x[sk.region];
    }
    // Population rows: reactivity and conversion chains.
    for (sk, sp) in supports.iter().zip(&fp.supports) {
        let (i, c) = (sk.region, sk.material);
        let row = offset + i;
        let coef = per_reactivity[i];
        for &port in &group_ports[c] {
            out.fuel_t
                .push((row, port, coef * sp.fuel_temperature * chain[port]));
        }
        out.own.push((
            row,
            offset + material(c, 0),
            coef * sp.fissile - beta[c] * x[i] * sp.production_fissile,
        ));
        out.own.push((
            row,
            offset + material(c, 1),
            coef * sp.capture_loss * k.capture.cross_section_m2,
        ));
        out.own
            .push((row, offset + material(c, 3), coef * sp.xenon));
        out.own
            .push((row, offset + material(c, 5), coef * sp.samarium));
    }
    for (i, rp) in fp.regions.iter().enumerate() {
        let coef = per_reactivity[i];
        out.water.push((
            offset + i,
            i,
            [coef * rp.water_density, coef * rp.boron, 0., 0.],
        ));
        for (rod, d) in &rp.rods {
            out.travel.push((offset + i, *rod, coef * d));
        }
    }
    // Per carrier: fissions, captures, poisons and heats.
    let fission_model = k.fission;
    let mut prompt = vec![0.; fission_model.dimension()];
    let prompt_j = fission_model
        .tangent(&vec![0.; fission_model.dimension()], 1., &mut prompt)
        .map_err(trial)?
        .prompt_w;
    let mut by_carrier: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (index, sk) in supports.iter().enumerate() {
        by_carrier[sk.material].push(index);
    }
    for c in 0..n {
        let share = 1. / members[c].len() as f64;
        let fertile = x[material(c, 1)];
        let exposure = values.exposure_per_m2_s[c].value;
        let fissions_c = values.carrier_fissions_per_s[c].value;
        let fertile_d = k
            .capture
            .tangent(fertile, exposure, 1., 0.)
            .map_err(trial)?;
        let exposure_d = k
            .capture
            .tangent(fertile, exposure, 0., 1.)
            .map_err(trial)?;
        // d(any per-carrier quantity)/d columns through F and X.
        let through = |df: f64, dx: f64, extra: &mut Vec<(usize, f64)>| {
            for &index in &by_carrier[c] {
                let (sk, sp) = (supports[index], fp.supports[index]);
                extra.push((
                    offset + sk.region,
                    df * sp.production_per_s + dx * sp.exposure,
                ));
            }
            extra.push((offset + material(c, 0), df * fission_fissile[c]));
        };
        // Feeds.
        let mut fission_feed = Vec::new();
        through(1., 0., &mut fission_feed);
        out.feeds[2 * c] = fission_feed;
        let mut capture_feed = Vec::new();
        through(0., exposure_d.captures_per_s, &mut capture_feed);
        capture_feed.push((offset + material(c, 1), fertile_d.captures_per_s));
        out.feeds[2 * c + 1] = capture_feed;
        // Fissile row: rhs = -F.
        let mut entries = Vec::new();
        through(-1., 0., &mut entries);
        for (column, v) in entries.drain(..) {
            out.own.push((offset + material(c, 0), column, v));
        }
        // Fertile row: rhs = the capture target rate.
        through(0., exposure_d.target_rate_per_s, &mut entries);
        entries.push((offset + material(c, 1), fertile_d.target_rate_per_s));
        for (column, v) in entries.drain(..) {
            out.own.push((offset + material(c, 1), column, v));
        }
        // Poison rows: rhs = the poison rates at F and the Xe/Sm captures.
        let inventory = [2, 3, 4, 5].map(|m| x[material(c, m)]);
        let captures = [
            0.,
            k.xenon_cross_section_m2 * exposure,
            0.,
            k.samarium_cross_section_m2 * exposure,
        ];
        let input = poisons::Input {
            fissions_per_s: fissions_c,
            capture_per_s: captures,
        };
        let mut d = [0.; 4];
        for m in 0..4 {
            let mut e = [0.; 4];
            e[m] = 1.;
            k.poison
                .tangent(
                    &inventory,
                    input,
                    &e,
                    poisons::InputDirection {
                        fissions_per_s: 0.,
                        capture_per_s: [0.; 4],
                    },
                    &mut d,
                )
                .map_err(trial)?;
            for (row, v) in d.iter().enumerate() {
                out.own.push((
                    offset + material(c, 2 + row),
                    offset + material(c, 2 + m),
                    *v,
                ));
            }
        }
        let mut by_fission = [0.; 4];
        k.poison
            .tangent(
                &inventory,
                input,
                &[0.; 4],
                poisons::InputDirection {
                    fissions_per_s: 1.,
                    capture_per_s: [0.; 4],
                },
                &mut by_fission,
            )
            .map_err(trial)?;
        let mut by_exposure = [0.; 4];
        k.poison
            .tangent(
                &inventory,
                input,
                &[0.; 4],
                poisons::InputDirection {
                    fissions_per_s: 0.,
                    capture_per_s: [
                        0.,
                        k.xenon_cross_section_m2,
                        0.,
                        k.samarium_cross_section_m2,
                    ],
                },
                &mut by_exposure,
            )
            .map_err(trial)?;
        for row in 0..4 {
            through(by_fission[row], by_exposure[row], &mut entries);
            for (column, v) in entries.drain(..) {
                out.own.push((offset + material(c, 2 + row), column, v));
            }
        }
        // Heats: prompt through F, binding through fertile, X, Xe and Sm.
        let pm = fp.materials[c];
        let binding_x = exposure_d.binding_w
            + k.xenon_binding_j * pm.xenon_capture_per_xenon * pm.xenon
            + k.samarium_binding_j * pm.samarium_capture_per_samarium * pm.samarium;
        for (fraction_p, fraction_b, sink) in [
            (
                1. - k.prompt_coolant_fraction,
                1. - k.binding_coolant_fraction,
                &mut out.fuel_w,
            ),
            (
                k.prompt_coolant_fraction,
                k.binding_coolant_fraction,
                &mut out.coolant_w,
            ),
        ] {
            through(fraction_p * prompt_j, fraction_b * binding_x, &mut entries);
            entries.push((offset + material(c, 1), fraction_b * fertile_d.binding_w));
            entries.push((
                offset + material(c, 3),
                fraction_b * k.xenon_binding_j * pm.xenon_capture_per_xenon * exposure,
            ));
            entries.push((
                offset + material(c, 5),
                fraction_b * k.samarium_binding_j * pm.samarium_capture_per_samarium * exposure,
            ));
            // E-NUC: each port's heat is one member's share of the group's.
            for (column, v) in entries.drain(..) {
                for &port in &group_ports[c] {
                    sink.push((port, column, v * share));
                }
            }
        }
    }
    let finite = out
        .own
        .iter()
        .map(|e| e.2)
        .chain(out.fuel_t.iter().map(|e| e.2))
        .chain(out.water.iter().flat_map(|e| e.2))
        .chain(out.travel.iter().map(|e| e.2))
        .chain(out.fuel_w.iter().map(|e| e.2))
        .chain(out.coolant_w.iter().map(|e| e.2))
        .chain(out.feeds.iter().flatten().map(|e| e.1))
        .all(f64::is_finite);
    if !finite {
        return Err(trial("nonfinite nuclear partial"));
    }
    Ok(())
}

/// The joined block Jacobian's structural pattern: per column the rows its
/// entries may reach in any state, a superset of every entry the block
/// assembly writes. The nuclear block's part is its exact structure (the
/// template's rows, feeds and constant consumers, the partials' entries and
/// their port chains). So are the fluid-solid ports: the network and rod
/// columns' solid rows and the solid columns' network rows, from the wall,
/// passive and segment laws' reads and the heat receipt's single slot.
/// Every other part is the joined operator's own structural pattern.
/// `partials` fixes the nuclear structure, which no state changes; the
/// pattern holds while every wall cell holds liquid only, which S2's wall
/// laws require (a vapor-holding wall cell refuses). `vapor` is the vapor
/// presence the donor reads follow (S3-D-P3).
pub fn joined_pattern<P: Properties + WaterProperties>(
    joined: &Joined<P>,
    template: &LinearTemplate,
    partials: &NuclearPartials,
    vapor: &VaporPresence,
) -> Result<Vec<Vec<usize>>, Failure> {
    let o = joined.offsets();
    let n = o.end;
    let nuclear_rows = o.nuclear..o.solids;
    let solid_rows = o.solids..o.secondary;
    let network_rows = 0..o.nuclear;
    let base = joined.structural_pattern()?;
    let mut columns: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
    for (c, rows) in base.iter().enumerate() {
        if nuclear_rows.contains(&c) {
            continue;
        }
        // The fluid-solid ports are rebuilt exactly below: the network and
        // rod columns' solid rows, and the solid columns' network rows.
        let fluid_column = c < o.nuclear || c >= o.rods;
        let solid_column = solid_rows.contains(&c);
        columns[c].extend(rows.iter().copied().filter(|r| {
            !nuclear_rows.contains(r)
                && !(fluid_column && solid_rows.contains(r))
                && !(solid_column && network_rows.contains(r))
        }));
    }
    let network = &joined.network;
    let pzr = network.pzr.cell;
    let cell_rows = |c: usize| -> std::ops::Range<usize> {
        if c == pzr {
            return network.pzr.coordinates();
        }
        let base = network.cell_layout[c].base;
        base..base + 6
    };
    // A heat receipt enters a regular cell's liquid energy row alone (the
    // enthalpy slot of phase 0; mass and tracer receipts are zero), and the
    // stratified cell's block.
    let receipt_rows = |c: usize| -> Vec<usize> {
        if c == pzr {
            network.pzr.coordinates().collect()
        } else {
            vec![network.cell_layout[c].energy[0]]
        }
    };
    let solids = joined.solids();
    let deposition = joined.nuclear().deposition();
    // A half's fuel heat is a source of its two fuel energy rows only
    // (solids::FUEL_HEAT_SPLIT); the surface, helium and clad rows do not
    // read it.
    let fuel_heat = |columns: &mut Vec<BTreeSet<usize>>, a: usize, col: usize| {
        for k in 0..2 {
            columns[col].insert(o.solids + solids.energy(a, k));
        }
    };
    let coolant_heat = |columns: &mut Vec<BTreeSet<usize>>, a: usize, col: usize| {
        for (cell, _) in &deposition[a] {
            columns[col].extend(receipt_rows(*cell));
        }
    };
    for r in &template.rows {
        columns[r.row].insert(r.row);
        for &(feed, _) in &template.terms[r.terms.clone()] {
            for &(col, _) in &partials.feeds[feed] {
                columns[col].insert(r.row);
            }
        }
    }
    for (target, col, _) in &template.consumers {
        match target {
            Target::Row(row) => {
                columns[*col].insert(*row);
            }
            Target::FuelHeat(a) => fuel_heat(&mut columns, *a, *col),
            Target::CoolantHeat(a) => coolant_heat(&mut columns, *a, *col),
        }
    }
    for i in nuclear_rows.clone() {
        columns[i].insert(i);
    }
    for (row, col, _) in &partials.own {
        columns[*col].insert(*row);
    }
    for (a, col, _) in &partials.fuel_w {
        fuel_heat(&mut columns, *a, *col);
    }
    for (a, col, _) in &partials.coolant_w {
        coolant_heat(&mut columns, *a, *col);
    }
    // Port chains into the population rows.
    for (row, a, _) in &partials.fuel_t {
        for k in 0..2 {
            columns[o.solids + solids.energy(*a, k)].insert(*row);
        }
    }
    let source_water = joined.source_water();
    let rods = joined.rods().map(|b| b.structure());
    for (row, region, _) in &partials.water {
        let cell = source_water[*region];
        for c in cell_rows(cell) {
            columns[c].insert(*row);
        }
        if let Some(st) = &rods {
            for (moved, own) in &st.volumes {
                if *moved == cell {
                    for i in own {
                        columns[o.rods + i].insert(*row);
                    }
                }
            }
        }
    }
    for (row, cluster, _) in &partials.travel {
        if let Some(st) = &rods {
            for i in st.outputs.get(*cluster).into_iter().flatten() {
                columns[o.rods + i].insert(*row);
            }
        }
    }
    // The fluid-solid ports, from the laws as written (S2-JOIN's ports):
    // - A wall law at cell c reads c's water (p, M_l, U_l: the liquid point
    //   at (p, U_l/M_l) and sat(p); a vapor-holding wall cell refuses) and
    //   the liquid mass flow of every face ending at c.
    // - That flow is a donor's liquid density-fraction product times
    //   Q = Pi/I, with I the supports' liquid mass per current volume
    //   (times L/A). A support reads M_l and, for a moving cell, the rod
    //   coordinates that move its volume. A donor's product reads p, M_l
    //   and U_l, and where vapor is present M_v, U_v and the volume (the
    //   liquid fraction is 1 - V_v/V). Either endpoint may donate. Boron
    //   enters neither.
    // - A half's wall heat writes its clad energy and clad outer surface
    //   rows; a passive contact (liquid temperature only, no flux) its
    //   store's row; an SG segment its metal row.
    // - The heat it delivers reads the solid side's own temperature (the
    //   clad outer surface, the passive store, the metal) and enters
    //   receipt_rows of c.
    // The vapor presence read here is this state's. S2 admits no phase
    // birth (an S3 transaction), and a dependency outside the pattern is
    // refused by the assembly, never dropped.
    let mut moved: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    if let Some(st) = &rods {
        for (cell, own) in &st.volumes {
            moved
                .entry(*cell)
                .or_default()
                .extend(own.iter().map(|i| o.rods + i));
        }
    }
    let water_reads = |c: usize| -> Vec<usize> {
        if c == pzr {
            network.pzr.coordinates().collect()
        } else {
            let l = network.cell_layout[c];
            vec![l.base, l.mass[0], l.energy[0]]
        }
    };
    // A support's liquid mass per current volume (the inertia of Q).
    let support_reads = |m: usize| -> Vec<usize> {
        if m == pzr {
            return network.pzr.coordinates().collect();
        }
        let mut out = vec![network.cell_layout[m].mass[0]];
        out.extend(moved.get(&m).into_iter().flatten().copied());
        out
    };
    // A donor's liquid density-fraction product: its liquid point at
    // (p, U_l/M_l), and where vapor is present the vapor volume share.
    let donor_reads = |m: usize| -> Vec<usize> {
        if m == pzr {
            return network.pzr.coordinates().collect();
        }
        let l = network.cell_layout[m];
        let mut out = vec![l.base, l.mass[0], l.energy[0]];
        if vapor.holds(m) {
            out.extend([l.mass[1], l.energy[1]]);
            out.extend(moved.get(&m).into_iter().flatten().copied());
        }
        out
    };
    let flux_reads = |c: usize| -> Vec<usize> {
        let mut out = Vec::new();
        for (face, supports, ends) in network.liquid_flux_reads(c) {
            out.push(network.face_layout[2 * face].index);
            for m in supports {
                out.extend(support_reads(m));
            }
            for m in ends {
                out.extend(donor_reads(m));
            }
        }
        out
    };
    let incidence = solids.incidence();
    for (a, (_, cells)) in incidence.halves.iter().enumerate() {
        let clad = o.solids + solids.energy(a, 2);
        let outer = o.solids + solids.surface(a, 2);
        for &c in cells {
            for col in water_reads(c).into_iter().chain(flux_reads(c)) {
                columns[col].extend([clad, outer]);
            }
            columns[outer].extend(receipt_rows(c));
        }
    }
    for &(store, c) in &incidence.passive {
        let row = o.solids + solids.passive(store);
        for col in water_reads(c) {
            columns[col].insert(row);
        }
        columns[row].extend(receipt_rows(c));
    }
    // R4-NCHEAD: a profiled SG primary's port heads read its fold
    // conductance, whose film reads each segment's metal.
    let profiles = network.profile_faces();
    for (i, &(c, _)) in incidence.segments.iter().enumerate() {
        let row = o.solids + solids.metal(i);
        for col in water_reads(c).into_iter().chain(flux_reads(c)) {
            columns[col].insert(row);
        }
        columns[row].extend(receipt_rows(c));
        for (_, faces) in profiles.iter().filter(|(cell, _)| *cell == c) {
            for f in faces {
                columns[row].extend([
                    network.face_layout[2 * f].index,
                    network.face_layout[2 * f + 1].index,
                ]);
            }
        }
    }
    for (c, rows) in columns.iter_mut().enumerate() {
        rows.insert(c);
    }
    Ok(columns
        .into_iter()
        .map(|rows| rows.into_iter().collect())
        .collect())
}

/// Compiled structure of the joined block Jacobian, built once at a state:
/// its own structural pattern ([`joined_pattern`]), the network's element
/// incidence and the nuclear block's linear template.
pub struct JoinedJacobian {
    pub pattern: Pattern,
    network: BlockJacobian,
    template: LinearTemplate,
    /// Global row scale of every joined row (a network row is its own).
    row_scales: Vec<f64>,
    /// Global coordinate scale of every joined coordinate.
    scales: Vec<f64>,
    /// The nuclear partials' entry counts, which no state changes.
    partials_len: [usize; 6],
}

/// Which column classes an assembly covers. The production assembly
/// covers all; a narrower one verifies (or times) the classes it names,
/// assembling every entry of their columns in full, chains included, and
/// leaves every other column zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Classes {
    pub network: bool,
    pub nuclear: bool,
    pub solids: bool,
    pub secondary: bool,
    pub rods: bool,
    /// The PZR metal and relief block (G6).
    pub pzr: bool,
    /// The CVCS block (plan r4 X4.2).
    pub cvcs: bool,
}
impl Classes {
    pub const ALL: Self = Self {
        network: true,
        nuclear: true,
        solids: true,
        secondary: true,
        rods: true,
        pzr: true,
        cvcs: true,
    };
    pub const NONE: Self = Self {
        network: false,
        nuclear: false,
        solids: false,
        secondary: false,
        rods: false,
        pzr: false,
        cvcs: false,
    };
}

/// Where one block assembly spends its time, by piece, on the caller's
/// clock: `(calls, seconds)`. A measurement aid; the assembly is the same.
pub struct Profile {
    pub clock: fn() -> f64,
    pub pieces: BTreeMap<&'static str, (u64, f64)>,
}
impl Profile {
    pub fn new(clock: fn() -> f64) -> Self {
        Self {
            clock,
            pieces: BTreeMap::new(),
        }
    }
}
/// The optional profile of one assembly.
struct Clock<'p>(Option<&'p mut Profile>);
impl Clock<'_> {
    fn now(&self) -> f64 {
        self.0.as_ref().map_or(0., |p| (p.clock)())
    }
    fn source(&self) -> Option<fn() -> f64> {
        self.0.as_ref().map(|p| p.clock)
    }
    /// Book the time since `since`, less `inner` already booked elsewhere.
    fn book(&mut self, piece: &'static str, since: f64, inner: f64) {
        if let Some(p) = self.0.as_mut() {
            let e = p.pieces.entry(piece).or_insert((0, 0.));
            e.0 += 1;
            e.1 += (p.clock)() - since - inner;
        }
    }
    fn book_spent(&mut self, piece: &'static str, calls: u64, seconds: f64) {
        if let Some(p) = self.0.as_mut() {
            let e = p.pieces.entry(piece).or_insert((0, 0.));
            e.0 += calls;
            e.1 += seconds;
        }
    }
}

/// The nuclear block's partials at the operator's last evaluation, with
/// the joined coordinate scales and the entry counts to reserve.
fn partials_at<P: Properties + WaterProperties>(
    joined: &Joined<P>,
    t: f64,
    y: &[f64],
    scales: &[f64],
    len: [usize; 6],
) -> Result<NuclearPartials, Failure> {
    let o = joined.offsets();
    let x: Vec<f64> = (o.nuclear..o.solids).map(|i| y[i] * scales[i]).collect();
    let fuel_t: Vec<f64> = joined
        .fuel_feedback_temperatures()
        .iter()
        .map(|v| v.value)
        .collect();
    let travel: Vec<f64> = joined.travel().iter().map(|v| v.value).collect();
    let mut partials = NuclearPartials {
        feeds: Vec::new(),
        own: Vec::with_capacity(len[0]),
        fuel_t: Vec::with_capacity(len[1]),
        water: Vec::with_capacity(len[2]),
        travel: Vec::with_capacity(len[3]),
        fuel_w: Vec::with_capacity(len[4]),
        coolant_w: Vec::with_capacity(len[5]),
    };
    nuclear_partials(
        joined.nuclear(),
        o.nuclear,
        t,
        &x,
        &fuel_t,
        joined.region_water(),
        &travel,
        &mut partials,
    )?;
    Ok(partials)
}

impl JoinedJacobian {
    /// Compile at the value state `(t, y, 0)`; the structure is no state's.
    pub fn compile<P: Properties + WaterProperties>(
        joined: &mut Joined<P>,
        t: f64,
        y: &[f64],
    ) -> Result<Self, Failure> {
        Self::compile_for(joined, t, y, None)
    }
    /// [`JoinedJacobian::compile`] with the donor reads following the
    /// declared vapor presence (the phase-mode owner's, S3-D-P3), or the
    /// value state's own when `None` (S3-D-P3).
    pub fn compile_for<P: Properties + WaterProperties>(
        joined: &mut Joined<P>,
        t: f64,
        y: &[f64],
        presence: Option<&VaporPresence>,
    ) -> Result<Self, Failure> {
        let o = joined.offsets();
        if y.len() != o.end {
            return Err(fatal("joined block Jacobian compile length"));
        }
        let zero = vec![0.; y.len()];
        joined.evaluate(t, y, &zero, None, 0., None)?;
        let template = joined.nuclear().linear_template(o.nuclear);
        let scales = joined.scales();
        let partials = partials_at(joined, t, y, &scales, [0; 6])?;
        let partials_len = [
            partials.own.len(),
            partials.fuel_t.len(),
            partials.water.len(),
            partials.travel.len(),
            partials.fuel_w.len(),
            partials.coolant_w.len(),
        ];
        let evaluated = VaporPresence::evaluated(&joined.network);
        let columns = joined_pattern(joined, &template, &partials, presence.unwrap_or(&evaluated))?;
        let pattern = Pattern::from_columns(o.end, &columns).map_err(fatal)?;
        let network = joined.network.block_jacobian()?;
        let row_scales = joined
            .layouts()
            .into_iter()
            .flat_map(|(_, l)| l.row_scales)
            .collect();
        Ok(Self {
            pattern,
            network,
            template,
            row_scales,
            scales,
            partials_len,
        })
    }
}

/// Entries added into a CSC value array over a fixed pattern; an entry
/// outside the pattern, or a nonfinite one, refuses.
struct Sink<'a> {
    pattern: &'a Pattern,
    values: &'a mut [f64],
}
impl Sink<'_> {
    fn add(&mut self, row: usize, column: usize, v: f64) -> Result<(), Failure> {
        if !v.is_finite() {
            return Err(fatal(format!(
                "nonfinite entry {v} at row {row}, column {column}"
            )));
        }
        if v == 0. {
            return Ok(());
        }
        let position = self.pattern.position(row, column).ok_or_else(|| {
            fatal(format!(
                "entry {v} at row {row}, column {column} lies outside the pattern; it omits a dependency"
            ))
        })?;
        self.values[position] += v;
        Ok(())
    }
}

/// The operator's coupler as the network replay's hook, noting whether
/// this column called it (its `last()` is stale otherwise), whether it
/// asked for the stratified boundary (`last_pzr()` likewise) and, when
/// profiled, the time spent in it.
struct Hook<'a, 'b, P> {
    coupler: &'a mut LocalCoupler<'b, P>,
    called: bool,
    pzr_called: bool,
    clock: Option<fn() -> f64>,
    spent: f64,
}
impl<'a, 'b, P> Hook<'a, 'b, P> {
    fn new(coupler: &'a mut LocalCoupler<'b, P>, clock: Option<fn() -> f64>) -> Self {
        Self {
            coupler,
            called: false,
            pzr_called: false,
            clock,
            spent: 0.,
        }
    }
}
impl<P: Properties + WaterProperties> LocalCoupling for Hook<'_, '_, P> {
    fn local(
        &mut self,
        cells: &[usize],
        faces: &[usize],
        fluid: &Fluid<'_>,
        receipts: &mut Receipts<'_>,
    ) -> Result<(), Failure> {
        self.called = true;
        let started = self.clock.map_or(0., |c| c());
        let result = self.coupler.local(cells, faces, fluid, receipts);
        if let Some(c) = self.clock {
            self.spent += c() - started;
        }
        result
    }
    fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure> {
        self.pzr_called = true;
        let started = self.clock.map_or(0., |c| c());
        let result = self.coupler.pzr_boundary(cell, column);
        if let Some(c) = self.clock {
            self.spent += c() - started;
        }
        result
    }
}

/// The input ports of the nuclear rows and the secondary rows, as the
/// rows they move per unit port direction: region water, feedback fuel
/// temperature and rod travel into the population rows (physical
/// partials over the row scale), and each SG's metal-to-secondary heat
/// into the secondary rows (the coupler's scaled response per W).
struct Ports<'r> {
    water: Vec<Vec<(usize, [f64; 4])>>,
    fuel_t: BTreeMap<usize, Vec<(usize, f64)>>,
    travel: BTreeMap<usize, Vec<(usize, f64)>>,
    secondary_heat: BTreeMap<usize, Vec<(usize, f64)>>,
    secondary_rows: bool,
    rs: &'r [f64],
}
impl Ports<'_> {
    fn water(
        &self,
        sink: &mut Sink<'_>,
        j: usize,
        region: usize,
        w: &RegionWater,
        over: f64,
    ) -> Result<(), Failure> {
        let d = [
            w.density_kg_m3.direction,
            w.boron_ppm_eq.direction,
            w.pressure_pa.direction,
            w.temperature_k.direction,
        ];
        for (row, p) in self.water.get(region).into_iter().flatten() {
            let rhs: f64 = p.iter().zip(&d).map(|(a, b)| a * b).sum();
            sink.add(*row, j, -rhs / self.rs[*row] / over)?;
        }
        Ok(())
    }
    fn population(
        &self,
        sink: &mut Sink<'_>,
        j: usize,
        partials: &BTreeMap<usize, Vec<(usize, f64)>>,
        input: usize,
        direction: f64,
    ) -> Result<(), Failure> {
        for (row, p) in partials.get(&input).into_iter().flatten() {
            sink.add(*row, j, -p * direction / self.rs[*row])?;
        }
        Ok(())
    }
    fn secondary(&self, sink: &mut Sink<'_>, j: usize, g: usize, heat: f64) -> Result<(), Failure> {
        if heat == 0. || !self.secondary_rows {
            return Ok(());
        }
        let rows = self.secondary_heat.get(&g).ok_or_else(|| {
            fatal(format!(
                "SG {g}'s secondary heat response was not assembled"
            ))
        })?;
        for (row, r) in rows {
            sink.add(*row, j, heat * r)?;
        }
        Ok(())
    }
    /// One local coupling's rows, region water and SG heat, over `over`
    /// (the column's seed sign).
    fn local(
        &self,
        sink: &mut Sink<'_>,
        j: usize,
        last: &LocalRows,
        over: f64,
    ) -> Result<(), Failure> {
        for (row, v) in &last.rows {
            sink.add(*row, j, v.direction / over)?;
        }
        for (region, w) in &last.water {
            self.water(sink, j, *region, w, over)?;
        }
        for (g, q) in &last.secondary_w {
            self.secondary(sink, j, *g, q.direction / over)?;
        }
        Ok(())
    }
}

/// The joined stage Jacobian `dF/dy + cj dF/dy'` by blocks into `values`,
/// in `structure.pattern`'s stored order: the network's element replay
/// with the coupled owners' local terms, the nuclear block's template and
/// partials, the owners' columns, and their ports chained. Requires
/// nothing else; refuses (Fatal) when any piece it needs is unavailable,
/// when the network's base pass does not reproduce its rows bitwise or
/// when an entry falls outside the pattern.
#[allow(clippy::too_many_arguments)] // The stage inputs, the structure and the classes.
pub fn jacobian_blocks<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    structure: &JoinedJacobian,
    t: f64,
    cj: f64,
    y: &[f64],
    yp: &[f64],
    values: &mut [f64],
    classes: Classes,
) -> Result<(), Failure> {
    assemble(
        joined,
        structure,
        t,
        cj,
        y,
        yp,
        values,
        classes,
        None,
        Clock(None),
    )
}

/// [`jacobian_blocks`] on a base evaluation already made (PERF2, E-LIN
/// R4-JAC-BASE): `joined`'s last evaluation is `evaluate(t, y, yp, None, 0.,
/// Some(reuse))` at exactly this state, with nothing evaluated or changed
/// since, so the assembly's own base evaluation would repeat it bit for bit.
#[allow(clippy::too_many_arguments)] // The stage inputs, the structure, the classes and the base.
pub fn jacobian_blocks_on_base<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    structure: &JoinedJacobian,
    t: f64,
    cj: f64,
    y: &[f64],
    yp: &[f64],
    values: &mut [f64],
    classes: Classes,
    reuse: Reuse<P::Caloric>,
    profile: Option<&mut Profile>,
) -> Result<(), Failure> {
    assemble(
        joined,
        structure,
        t,
        cj,
        y,
        yp,
        values,
        classes,
        Some(reuse),
        Clock(profile),
    )
}

/// [`jacobian_blocks`], booking each piece's time into `profile`.
#[allow(clippy::too_many_arguments)] // The stage inputs, the structure, the classes and the profile.
pub fn jacobian_blocks_profiled<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    structure: &JoinedJacobian,
    t: f64,
    cj: f64,
    y: &[f64],
    yp: &[f64],
    values: &mut [f64],
    classes: Classes,
    profile: &mut Profile,
) -> Result<(), Failure> {
    assemble(
        joined,
        structure,
        t,
        cj,
        y,
        yp,
        values,
        classes,
        None,
        Clock(Some(profile)),
    )
}

#[allow(clippy::too_many_arguments)] // As jacobian_blocks, with the clock.
fn assemble<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    structure: &JoinedJacobian,
    t: f64,
    cj: f64,
    y: &[f64],
    yp: &[f64],
    values: &mut [f64],
    classes: Classes,
    base: Option<Reuse<P::Caloric>>,
    mut clock: Clock<'_>,
) -> Result<(), Failure> {
    let o = joined.offsets();
    if y.len() != o.end || yp.len() != o.end || values.len() != structure.pattern.nonzeros() {
        return Err(fatal("joined block Jacobian layout"));
    }
    let started = clock.now();
    let reuse = match base {
        Some(reuse) => reuse,
        None => {
            let mut reuse = joined.network.reuse();
            joined.evaluate(t, y, yp, None, 0., Some(&mut reuse))?;
            reuse
        }
    };
    clock.book("base: joined evaluation", started, 0.);
    let started = clock.now();
    let scales = &structure.scales;
    let partials = partials_at(joined, t, y, scales, structure.partials_len)?;
    clock.book("base: nuclear partials", started, 0.);
    let started = clock.now();
    let deposition: Vec<Vec<(usize, f64)>> = joined.nuclear().deposition().to_vec();
    values.fill(0.);
    let mut sink = Sink {
        pattern: &structure.pattern,
        values,
    };
    let mut ports = Ports {
        water: vec![Vec::new(); joined_regions(&partials)],
        fuel_t: BTreeMap::new(),
        travel: BTreeMap::new(),
        secondary_heat: BTreeMap::new(),
        // With prepared SG views there are no secondary rows, and the
        // metal heat enters none.
        secondary_rows: o.rods > o.secondary,
        rs: &structure.row_scales,
    };
    for (row, region, p) in &partials.water {
        ports.water[*region].push((*row, *p));
    }
    for (row, a, p) in &partials.fuel_t {
        ports.fuel_t.entry(*a).or_default().push((*row, *p));
    }
    for (row, cluster, p) in &partials.travel {
        ports.travel.entry(*cluster).or_default().push((*row, *p));
    }
    // The SGs whose metal heat the secondary rows read.
    let generators: BTreeSet<usize> = if ports.secondary_rows {
        joined
            .solids()
            .incidence()
            .segments
            .iter()
            .map(|(_, g)| *g)
            .collect()
    } else {
        BTreeSet::new()
    };
    // Each half's two fuel energy rows: its fuel heat enters them alone,
    // through the solids' constant split.
    let fuel_rows: Vec<[usize; 2]> = {
        let solids = joined.solids();
        (0..solids.halves())
            .map(|a| [0, 1].map(|k| o.solids + solids.energy(a, k)))
            .collect()
    };
    // R4-PZR-PI (S-b): the PZR owner's spray stem column, if composed.
    let stem = joined.pzr().stem_coordinate().map(|k| o.pzr + k);
    let (network, mut coupler) = joined.local_parts(t, y, yp, cj);
    let regular = network.pzr.cell;
    let pzr_coordinates = network.pzr.coordinates();
    let held = Held::new(network.properties());
    let mut replay = Replay::new(
        network,
        &held,
        &y[..o.nuclear],
        &yp[..o.nuclear],
        cj,
        reuse,
        &structure.network,
        true,
    )?;
    clock.book("base: replay set-up (network base pass)", started, 0.);
    let mut owner = OwnerRows::default();
    // Each SG's secondary-row response per W of metal heat, read by the
    // network and solid columns.
    if classes.network || classes.solids {
        let started = clock.now();
        for &g in &generators {
            coupler.secondary_heat_column(g, &mut owner)?;
            ports.secondary_heat.insert(
                g,
                owner.rows.iter().map(|(r, v)| (*r, v.direction)).collect(),
            );
        }
        clock.book("ports: SG heat responses", started, 0.);
    }
    let mut response = Vec::new();
    if classes.network {
        let (mut local, mut locals) = (0., 0);
        for j in 0..o.nuclear {
            let started = clock.now();
            response.clear();
            let sign = replay.sign(j);
            let mut hook = Hook::new(&mut coupler, clock.source());
            replay.column(j, Some(&mut hook), &mut response)?;
            for &(row, d) in &response {
                sink.add(row, j, d / sign)?;
            }
            if hook.called {
                local += hook.spent;
                locals += 1;
                ports.local(&mut sink, j, hook.coupler.last(), sign)?;
            }
            // A PZR column's PZR block rows, through the boundary's laws.
            if hook.pzr_called {
                for (row, v) in hook.coupler.last_pzr() {
                    sink.add(*row, j, v.direction / sign)?;
                }
            }
            let spent = hook.spent;
            // Plan r4 X4.2: a PZR column's CVCS level row (the LT law reads
            // the cell's coordinates directly, not through the fluid).
            if pzr_coordinates.contains(&j)
                && let Some((row, v)) = coupler.cvcs_level_column(j)?
            {
                sink.add(row, j, v)?;
            }
            clock.book("network columns: replay and chains", started, spent);
        }
        clock.book_spent("network columns: local coupling", locals, local);
    }
    let mut seed = NetworkSeed::default();
    if classes.nuclear {
        let started = clock.now();
        let template = &structure.template;
        // Every nuclear row is differential: its own coordinate's cj.
        for i in o.nuclear..o.solids {
            sink.add(i, i, cj)?;
        }
        for r in &template.rows {
            sink.add(r.row, r.row, r.decay_per_s)?;
            for &(feed, c) in &template.terms[r.terms.clone()] {
                for &(col, d) in &partials.feeds[feed] {
                    sink.add(r.row, col, -c * d * scales[col] / ports.rs[r.row])?;
                }
            }
        }
        let mut fuel_heat: BTreeMap<usize, Vec<(usize, f64)>> = BTreeMap::new();
        let mut coolant: BTreeMap<usize, Vec<(usize, f64)>> = BTreeMap::new();
        for (target, col, c) in &template.consumers {
            match target {
                Target::Row(row) => sink.add(*row, *col, -c * scales[*col] / ports.rs[*row])?,
                Target::FuelHeat(a) => fuel_heat
                    .entry(*a)
                    .or_default()
                    .push((*col, c * scales[*col])),
                Target::CoolantHeat(a) => {
                    for (cell, f) in &deposition[*a] {
                        coolant
                            .entry(*col)
                            .or_default()
                            .push((*cell, f * c * scales[*col]));
                    }
                }
            }
        }
        for (row, col, v) in &partials.own {
            sink.add(*row, *col, -v * scales[*col] / ports.rs[*row])?;
        }
        for (a, col, v) in &partials.fuel_w {
            fuel_heat
                .entry(*a)
                .or_default()
                .push((*col, v * scales[*col]));
        }
        for (a, col, v) in &partials.coolant_w {
            for (cell, f) in &deposition[*a] {
                coolant
                    .entry(*col)
                    .or_default()
                    .push((*cell, f * v * scales[*col]));
            }
        }
        clock.book("nuclear columns: template and partials", started, 0.);
        // Direct coolant heat: the deposition cells' liquid enthalpy port.
        let started = clock.now();
        for (col, heats) in &coolant {
            seed.receipts.clear();
            seed.volumes.clear();
            seed.passes.clear();
            for (cell, q) in heats {
                seed.receipts.push((*cell, [[0., *q, 0.], [0.; 3]]));
            }
            response.clear();
            replay.external(&seed, None, &mut response)?;
            for &(row, d) in &response {
                sink.add(row, *col, d)?;
            }
        }
        clock.book("nuclear columns: coolant heat replays", started, 0.);
        // Fuel heat: a half's fuel energy rows are `rate - split_k fuel_w`
        // in physical units over their row scales (solids::FUEL_HEAT_SPLIT).
        let started = clock.now();
        for (a, columns) in &fuel_heat {
            let rows = fuel_rows
                .get(*a)
                .ok_or_else(|| fatal(format!("fuel heat of half {a} outside the solids")))?;
            for (col, w) in columns {
                for (row, split) in rows.iter().zip(FUEL_HEAT_SPLIT) {
                    sink.add(*row, *col, -split * w / ports.rs[*row])?;
                }
            }
        }
        clock.book("nuclear columns: fuel heat", started, 0.);
    }
    let zero = [[Scalar::constant(0.); 3]; 2];
    let mut buffer = vec![zero; regular];
    // R4-NCHEAD: an owner column's SG pass directions (the solids' metal).
    let mut passes = vec![None; regular];
    for (name, range, named) in [
        ("solid", o.solids..o.secondary, classes.solids),
        ("secondary", o.secondary..o.rods, classes.secondary),
        ("rod", o.rods..o.pzr, classes.rods),
        ("cvcs", o.cvcs..o.end, classes.cvcs),
    ] {
        if !named {
            continue;
        }
        let (mut own, mut replays, mut local) = ((0, 0.), (0, 0.), (0, 0.));
        let started_class = clock.now();
        for j in range {
            let started = clock.now();
            buffer.fill(zero);
            passes.fill(None);
            coupler.owner_column(
                j,
                &replay.fluid(),
                &mut Receipts::with_passes(&mut buffer, &mut passes),
                &mut owner,
            )?;
            own.0 += 1;
            own.1 += clock.now() - started;
            for (row, v) in &owner.rows {
                sink.add(*row, j, v.direction)?;
            }
            for (a, v) in &owner.fuel_t {
                ports.population(&mut sink, j, &ports.fuel_t, *a, v.direction)?;
            }
            for (cluster, v) in &owner.travel {
                ports.population(&mut sink, j, &ports.travel, *cluster, v.direction)?;
            }
            for (g, q) in &owner.secondary_w {
                ports.secondary(&mut sink, j, *g, q.direction)?;
            }
            // The owners' receipts and moving volumes into the network.
            seed.receipts.clear();
            seed.volumes.clear();
            for (cell, r) in buffer.iter().enumerate() {
                if r.iter().flatten().any(|q| q.direction != 0.) {
                    seed.receipts
                        .push((cell, r.map(|phase| phase.map(|q| q.direction))));
                }
            }
            for (cell, v) in &owner.volumes {
                if v.volume_m3.direction != 0. || v.rate_m3_s.direction != 0. {
                    seed.volumes
                        .push((*cell, v.volume_m3.direction, v.rate_m3_s.direction));
                }
            }
            seed.passes.clear();
            for (cell, p) in passes.iter().enumerate() {
                if let Some(p) = p
                    && (p.conductance_w_k.direction != 0. || p.capacity_w_k.direction != 0.)
                {
                    seed.passes
                        .push((cell, [p.conductance_w_k.direction, p.capacity_w_k.direction]));
                }
            }
            if seed.receipts.is_empty() && seed.volumes.is_empty() && seed.passes.is_empty() {
                continue;
            }
            let started = clock.now();
            response.clear();
            let mut hook = Hook::new(&mut coupler, clock.source());
            replay.external(&seed, Some(&mut hook), &mut response)?;
            for &(row, d) in &response {
                sink.add(row, j, d)?;
            }
            if hook.called {
                local.0 += 1;
                local.1 += hook.spent;
                ports.local(&mut sink, j, hook.coupler.last(), 1.)?;
            }
            replays.0 += 1;
            replays.1 += clock.now() - started - hook.spent;
        }
        let total = clock.now() - started_class;
        let (owner_piece, replay_piece, local_piece, chain_piece) = match name {
            "solid" => (
                "solid columns: owner_column",
                "solid columns: network replay of receipts",
                "solid columns: local coupling",
                "solid columns: chains",
            ),
            "secondary" => (
                "secondary columns: owner_column",
                "secondary columns: network replay of receipts",
                "secondary columns: local coupling",
                "secondary columns: chains",
            ),
            "cvcs" => (
                "cvcs columns: owner_column",
                "cvcs columns: network replay of receipts",
                "cvcs columns: local coupling",
                "cvcs columns: chains",
            ),
            _ => (
                "rod columns: owner_column",
                "rod columns: network replay of receipts and volumes",
                "rod columns: local coupling",
                "rod columns: chains",
            ),
        };
        clock.book_spent(owner_piece, own.0, own.1);
        clock.book_spent(replay_piece, replays.0, replays.1);
        clock.book_spent(local_piece, local.0, local.1);
        if clock.0.is_some() {
            clock.book_spent(chain_piece, 1, total - own.1 - replays.1 - local.1);
        }
    }
    // The PZR block's columns (G6): its own rows at the base column, and the
    // stratified rows through the boundary's directions.
    if classes.pzr && o.cvcs > o.pzr {
        let started = clock.now();
        let cell = network.stratified();
        let column = *network
            .pzr_column()
            .ok_or_else(|| fatal("the PZR columns need the base evaluation's column"))?;
        seed.receipts.clear();
        seed.volumes.clear();
        seed.passes.clear();
        // R4-PZR-PI (S-b): the valve's restriction row in the PZR owner's
        // stem, at the base evaluation's drive (zero while locked).
        let opening = network
            .spray_row_opening_partial()
            .zip(stem)
            .map(|((row, d), j)| (row, j, d * scales[j]));
        for j in o.pzr..o.cvcs {
            let boundary = coupler.pzr_column(j, cell, &column)?;
            for (row, v) in coupler.last_pzr() {
                sink.add(*row, j, v.direction)?;
            }
            if let Some((row, k, v)) = opening
                && k == j
            {
                sink.add(row, j, v)?;
            }
            seed.pzr_boundary = Some(boundary);
            response.clear();
            replay.external(&seed, None, &mut response)?;
            for &(row, d) in &response {
                sink.add(row, j, d)?;
            }
        }
        seed.pzr_boundary = None;
        clock.book("pzr columns: block rows and stratified replay", started, 0.);
    }
    Ok(())
}

fn joined_regions(p: &NuclearPartials) -> usize {
    p.water.iter().map(|w| w.1 + 1).max().unwrap_or(0)
}

//! Complete analytic fixed-geometry source Jacobian. Incidence compiles once;
//! numeric assembly visits local laws, not global unit-vector probes. The
//! independent event ledger is assembled before the solver-only basis change.
use super::*;
use std::collections::BTreeMap;

pub struct Jacobian {
    owner: Arc<()>,
    pattern: Vec<(usize, usize)>,
    slots: Vec<usize>,
    diagonals: Vec<usize>,
    ledger_columns: Vec<(usize, Vec<usize>)>,
    fuel: fh::SparsePatterns,
    collision_slots: Vec<usize>,
    collision_rows: Vec<Vec<(usize, usize)>>,
    collision_size: usize,
    // Immutable group support: discovering it inside every emitted numerical
    // derivative repeatedly scanned the same ordered optical layers.
    optical_groups: Vec<BTreeMap<usize, u8>>,
    optical_targets: Vec<Vec<usize>>,
    optical_columns: Vec<Vec<usize>>,
    moderator_regions: Vec<usize>,
}

impl Jacobian {
    pub fn new(model: &Evolution) -> Result<Self, &'static str> {
        let fuel = model.input.history.sparse_patterns();
        let mut collision_terms = fuel.collision.clone();
        for (e, m) in model
            .input
            .moderator
            .intersections()
            .iter()
            .zip(&model.input.row_map)
        {
            for g in 0..GROUPS {
                if model.input.moderator.law().absorption[g] != 0. && m.h_fraction != 0. {
                    collision_terms.push((e.region, g, model.water_row(m.owner, false)));
                }
                if model.input.moderator.law().boron_sigma[g] != 0. && m.b_fraction != 0. {
                    collision_terms.push((e.region, g, model.water_row(m.owner, true)));
                }
            }
        }
        for e in &model.input.passive_incidence {
            for t in &model.input.passive_stocks[e.stock].targets {
                for g in 0..GROUPS {
                    if t.sigma_m2[g] != 0. {
                        collision_terms.push((e.region, g, model.target_row(t.index)));
                    }
                }
            }
        }
        for e in &model.input.cylinder_incidence {
            for g in 0..GROUPS {
                let target = &model.input.cylinder_targets[e.target];
                if target.sigma_m2[g] != 0. {
                    collision_terms.push((e.region, g, model.target_row(target.index)));
                }
            }
        }
        let unique = collision_terms.iter().copied().collect::<BTreeSet<_>>();
        let lookup = unique
            .iter()
            .enumerate()
            .map(|(i, k)| (*k, i))
            .collect::<BTreeMap<_, _>>();
        let collision_slots = collision_terms.iter().map(|k| lookup[k]).collect();
        let mut collision_rows = vec![Vec::new(); model.region_count() * GROUPS];
        for ((r, g, col), slot) in lookup {
            collision_rows[r * GROUPS + g].push((col, slot));
        }
        let optical_targets = model
            .optical
            .iter()
            .map(|m| m.targets().collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let optical_columns = optical_targets
            .iter()
            .map(|targets| {
                let mut seen = BTreeSet::new();
                targets
                    .iter()
                    .copied()
                    .filter(|t| seen.insert(*t))
                    .collect()
            })
            .collect();
        let mut result = Self {
            owner: Arc::clone(&model.owner),
            pattern: Vec::new(),
            slots: Vec::new(),
            diagonals: Vec::new(),
            ledger_columns: Vec::new(),
            fuel,
            collision_slots,
            collision_rows,
            collision_size: unique.len(),
            optical_groups: model
                .input
                .optical_layers
                .iter()
                .map(|layers| {
                    let mut groups = BTreeMap::<usize, u8>::new();
                    for column in layers.iter().flat_map(|layer| &layer.columns) {
                        for g in 0..GROUPS {
                            if column.sigma_m2[g] != 0. {
                                *groups.entry(column.target).or_default() |= 1 << g;
                            }
                        }
                    }
                    groups
                })
                .collect(),
            optical_targets,
            optical_columns,
            moderator_regions: model
                .input
                .moderator
                .intersections()
                .iter()
                .map(|e| e.region)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        };
        let mut terms = Vec::new();
        result.visit(model, None, &mut |r, c, _| terms.push((r, c)))?;
        let mut entries = terms.iter().copied().collect::<BTreeSet<_>>();
        for i in 0..model.state_count() {
            entries.insert((i, i));
        }
        // The transformed ledger row is the independently assembled sum of
        // N/C derivatives minus event derivatives. Do not force it to zero.
        let columns = entries
            .iter()
            .filter_map(|&(r, c)| {
                (r < model.nc_dimension() || r == model.ledger_row()).then_some(c)
            })
            .collect::<BTreeSet<_>>();
        for &c in &columns {
            entries.insert((model.ledger_row(), c));
        }
        result.pattern = entries.into_iter().collect();
        result.pattern.sort_unstable_by_key(|&(r, c)| (c, r));
        let lookup = result
            .pattern
            .iter()
            .enumerate()
            .map(|(i, &k)| (k, i))
            .collect::<BTreeMap<_, _>>();
        result.slots = terms.iter().map(|k| lookup[k]).collect();
        result.diagonals = (0..model.state_count()).map(|i| lookup[&(i, i)]).collect();
        let mut nc_by_column = BTreeMap::<usize, Vec<usize>>::new();
        for (i, &(r, c)) in result.pattern.iter().enumerate() {
            if r < model.nc_dimension() {
                nc_by_column.entry(c).or_default().push(i);
            }
        }
        result.ledger_columns = columns
            .into_iter()
            .map(|c| {
                (
                    lookup[&(model.ledger_row(), c)],
                    nc_by_column.remove(&c).unwrap_or_default(),
                )
            })
            .collect();
        Ok(result)
    }
    pub fn pattern(&self) -> &[(usize, usize)] {
        &self.pattern
    }
    pub fn values(
        &self,
        model: &Evolution,
        work: &mut Workspace,
        cj: f64,
        out: &mut [f64],
    ) -> Result<(), &'static str> {
        self.assemble(model, work, cj, out, false)
    }
    pub fn solver_values(
        &self,
        model: &Evolution,
        work: &mut Workspace,
        cj: f64,
        out: &mut [f64],
    ) -> Result<(), &'static str> {
        self.assemble(model, work, cj, out, true)
    }
    fn assemble(
        &self,
        model: &Evolution,
        work: &mut Workspace,
        cj: f64,
        out: &mut [f64],
        solver: bool,
    ) -> Result<(), &'static str> {
        if !Arc::ptr_eq(&self.owner, &model.owner)
            || !Arc::ptr_eq(&self.owner, &work.owner)
            || out.len() != self.pattern.len()
            || !cj.is_finite()
            || cj <= 0.
        {
            return Err("Invalid complete source Jacobian owner/output");
        }
        work.check()?;
        out.fill(0.);
        let mut i = 0;
        self.visit(model, Some(work), &mut |_, _, value| {
            out[self.slots[i]] += value;
            i += 1;
        })?;
        if i != self.slots.len() {
            return Err("Source Jacobian incidence changed");
        }
        if solver {
            for (ledger, nc) in &self.ledger_columns {
                let sum = nc.iter().map(|&slot| out[slot]).sum::<f64>();
                out[*ledger] = sum - out[*ledger];
            }
        }
        for value in out.iter_mut() {
            *value = -*value;
        }
        for &slot in &self.diagonals {
            out[slot] += cj;
        }
        if out.iter().any(|x| !x.is_finite()) {
            return Err("Nonfinite complete source Jacobian");
        }
        Ok(())
    }
    fn visit(
        &self,
        model: &Evolution,
        work: Option<&mut Workspace>,
        emit: &mut impl FnMut(usize, usize, f64),
    ) -> Result<(), &'static str> {
        // Reaction laws below differentiate cumulative target consumption.
        // For Mn, C=M+Fe: both inventory columns receive the SAME partial.
        // Decay is separate and reads M directly, never a C−Fe roundtrip.
        let begin = model.target_row(0);
        let end = model.target_row(model.input.targets.len());
        self.visit_reactions(model, work, &mut |r, c, value| {
            emit(r, c, value);
            if c >= begin && c < end {
                if let Some(i) = model.mn_owner[c - begin] {
                    emit(r, model.mn_product_row(i), value);
                }
            }
        })?;
        for (i, m) in model.input.mn.iter().enumerate() {
            let direct = model.target_row(m.target);
            emit(direct, direct, -m.decay_rate);
            emit(model.mn_product_row(i), direct, m.decay_rate);
        }
        Ok(())
    }
    fn visit_reactions(
        &self,
        model: &Evolution,
        mut work: Option<&mut Workspace>,
        emit: &mut impl FnMut(usize, usize, f64),
    ) -> Result<(), &'static str> {
        let optical_active = |i: usize, target: usize, g: usize| {
            self.optical_groups[i]
                .get(&target)
                .is_some_and(|mask| mask & (1 << g) != 0)
        };
        let zero = work.is_none();
        let mut fuel_rates = vec![0.; self.fuel.rates.len()];
        let mut fuel_collision = vec![0.; self.fuel.collision.len()];
        let mut fuel_diagnostics = vec![[0.; 2]; self.fuel.diagnostics.len()];
        if let Some(w) = work.as_ref() {
            model.input.history.sparse_values(
                &w.history,
                &mut fuel_rates,
                &mut fuel_collision,
                &mut fuel_diagnostics,
            )?;
        }
        let cf = model.cf_row();
        for (&(r, c), &v) in self.fuel.rates.iter().zip(&fuel_rates) {
            emit(r, c, v * if (r == cf) != (c == cf) { -1. } else { 1. });
        }
        for (&c, &v) in self.fuel.diagnostics.iter().zip(&fuel_diagnostics) {
            let sign = if c == cf { -1. } else { 1. };
            emit(model.ledger_row(), c, sign * v[0]);
            emit(model.fuel_release_row(), c, sign * v[1]);
        }
        let volumes = model.input.history.fuel().volumes();
        let speed = model.input.history.fuel().law().speed;
        let mut collision = vec![0.; self.collision_size];
        let mut cursor = 0;
        let mut collision_add = |value: f64| {
            collision[self.collision_slots[cursor]] += value;
            cursor += 1;
        };
        for (&(_, _, col), &value) in self.fuel.collision.iter().zip(&fuel_collision) {
            collision_add(value * if col == cf { -1. } else { 1. });
        }
        // Moderator scattering plus actual shared water-progress feedback.
        for &r in &self.moderator_regions {
            for h in 0..GROUPS {
                for g in 0..GROUPS {
                    if h != g && model.input.moderator.law().scatter[g][h] == 0. {
                        continue;
                    }
                    let value = if let Some(w) = work.as_ref() {
                        w.moderator.coefficients()?[r * 49 + h * 7 + g]
                    } else {
                        0.
                    };
                    emit(r * GROUPS + h, r * GROUPS + g, value);
                }
            }
        }
        for (i, (e, m)) in model
            .input
            .moderator
            .intersections()
            .iter()
            .zip(&model.input.row_map)
            .enumerate()
        {
            for g in 0..GROUPS {
                let n = e.region * GROUPS + g;
                let (h, b, dh, db, population) = if let Some(w) = work.as_ref() {
                    let c = w.moderator.rows()?[i];
                    (
                        c.hydrogen[g],
                        c.boron[g],
                        (c.d_hydrogen_d_product[g] - c.d_hydrogen_d_target[g]) * m.h_fraction,
                        -c.d_boron_d_atoms[g] * m.b_fraction,
                        w.state[n],
                    )
                } else {
                    (0., 0., 0., 0., 0.)
                };
                for (col, change, active) in [
                    (
                        model.water_row(m.owner, false),
                        dh,
                        model.input.moderator.law().absorption[g] != 0. && m.h_fraction != 0.,
                    ),
                    (
                        model.water_row(m.owner, true),
                        db,
                        model.input.moderator.law().boron_sigma[g] != 0. && m.b_fraction != 0.,
                    ),
                ] {
                    if !active {
                        continue;
                    }
                    collision_add(change / speed[g]);
                    emit(n, col, -change * population);
                    emit(col, col, change * population);
                    emit(model.ledger_row(), col, -change * population);
                }
                emit(model.water_row(m.owner, false), n, h);
                emit(model.water_row(m.owner, true), n, b);
                emit(model.ledger_row(), n, -h - b);
            }
        }
        // Bulk captures: target stocks remain their actual shared owners.
        for e in &model.input.passive_incidence {
            let s = &model.input.passive_stocks[e.stock];
            for t in &s.targets {
                for g in 0..GROUPS {
                    if t.sigma_m2[g] == 0. {
                        continue;
                    }
                    let n = e.region * GROUPS + g;
                    let target = model.target_row(t.index);
                    let factor = t.sigma_m2[g] * e.volume / s.volume / volumes[e.region];
                    let (coefficient, partial) = if let Some(w) = work.as_ref() {
                        (
                            speed[g] * factor * w.amounts[t.index],
                            -speed[g] * factor * w.state[n],
                        )
                    } else {
                        (0., 0.)
                    };
                    collision_add(-factor);
                    for (col, value) in [(n, coefficient), (target, partial)] {
                        emit(n, col, -value);
                        emit(target, col, value);
                        emit(model.ledger_row(), col, -value);
                    }
                }
            }
        }
        for e in &model.input.cylinder_incidence {
            for g in 0..GROUPS {
                if model.input.cylinder_targets[e.target].sigma_m2[g] == 0. {
                    continue;
                }
                let n = e.region * GROUPS + g;
                let target = model.target_row(model.input.cylinder_targets[e.target].index);
                let factor = e.share * speed[g] / volumes[e.region];
                let (cap, dcap, collect, dcollect, dc) = if let Some(w) = work.as_ref() {
                    let c = w.cylinder.responses()?[e.target];
                    (
                        factor * c.capture_m2[g],
                        -factor * c.d_capture_d_amount[g] * w.state[n],
                        factor * c.collected_m2[g],
                        -factor * c.d_collected_d_amount[g] * w.state[n],
                        -e.share / volumes[e.region] * c.d_capture_d_amount[g],
                    )
                } else {
                    (0., 0., 0., 0., 0.)
                };
                collision_add(dc);
                for (col, capture, collected) in [(n, cap, collect), (target, dcap, dcollect)] {
                    emit(n, col, -capture);
                    emit(target, col, capture);
                    emit(model.ledger_row(), col, -capture);
                    emit(model.collected_row(), col, collected);
                }
            }
        }
        if cursor != self.collision_slots.len() {
            return Err("Collision Jacobian incidence changed");
        }
        // The state-linear transport entries are already compiled by their owner.
        for (i, c) in model.transport.coordinates().iter().enumerate() {
            emit(
                c.row,
                c.column,
                if let Some(w) = work.as_ref() {
                    w.transport.coefficients()?[i]
                } else {
                    0.
                },
            );
        }
        let mut oi = 0;
        for (fi, f) in model.input.faces.iter().enumerate() {
            let internal = matches!(f.law, ts::FaceLaw::InternalOptical { .. });
            let optical = matches!(
                f.law,
                ts::FaceLaw::Optical { .. } | ts::FaceLaw::InternalOptical { .. }
            );
            // Internal panels have two incident sides of this same population;
            // they are absorbers, never exterior escape or a dropped self-face.
            let right_region = f.right.or_else(|| internal.then_some(f.left));
            for g in 0..GROUPS {
                let left = f.left * GROUPS + g;
                let pl = work
                    .as_ref()
                    .map_or(0., |w| speed[g] * w.state[left] / volumes[f.left]);
                let coeff = if let Some(w) = work.as_ref() {
                    w.transport.face_coefficients()?[fi][g]
                } else {
                    ts::FaceCoefficients::default()
                };
                if let Some(right_region) = right_region {
                    let right = right_region * GROUPS + g;
                    let pr = work
                        .as_ref()
                        .map_or(0., |w| speed[g] * w.state[right] / volumes[right_region]);
                    emit(
                        model.ledger_row(),
                        left,
                        -coeff.capture_left.value * speed[g] / volumes[f.left],
                    );
                    emit(
                        model.ledger_row(),
                        right,
                        -coeff.capture_right.value * speed[g] / volumes[right_region],
                    );
                    if let ts::FaceLaw::Optical { targets }
                    | ts::FaceLaw::InternalOptical { targets } = &f.law
                    {
                        for (j, &target) in targets.iter().enumerate() {
                            if !optical_active(oi, target, g) {
                                continue;
                            }
                            let (ll, rr) = work.as_ref().map_or((0., 0.), |w| {
                                (
                                    w.optical[oi].left_loss[j][g],
                                    w.optical[oi].right_loss[j][g],
                                )
                            });
                            emit(
                                model.target_row(target),
                                left,
                                coeff.capture_per_loss_left.value * speed[g] / volumes[f.left] * ll,
                            );
                            emit(
                                model.target_row(target),
                                right,
                                coeff.capture_per_loss_right.value * speed[g]
                                    / volumes[right_region]
                                    * rr,
                            );
                        }
                    }
                    // This isotropic internal-panel law has identically zero
                    // collision partials. Do not compile spurious material
                    // couplings from its unrelated host collision owners.
                    for (side, region) in [(0, f.left), (1, right_region)]
                        .into_iter()
                        .take(if internal { 0 } else { 2 })
                    {
                        for &(column, slot) in &self.collision_rows[region * GROUPS + g] {
                            let delta = collision[slot];
                            let exchange = coeff.exchange.derivatives[side] * delta * (pr - pl);
                            let capl = coeff.capture_left.derivatives[side] * delta * pl;
                            let capr = coeff.capture_right.derivatives[side] * delta * pr;
                            emit(left, column, exchange - capl);
                            emit(right, column, -exchange - capr);
                            emit(model.ledger_row(), column, -capl - capr);
                            if let ts::FaceLaw::Optical { targets }
                            | ts::FaceLaw::InternalOptical { targets } = &f.law
                            {
                                for (j, &target) in targets.iter().enumerate() {
                                    if !optical_active(oi, target, g) {
                                        continue;
                                    }
                                    let (ll, rr) = work.as_ref().map_or((0., 0.), |w| {
                                        (
                                            w.optical[oi].left_loss[j][g],
                                            w.optical[oi].right_loss[j][g],
                                        )
                                    });
                                    emit(
                                        model.target_row(target),
                                        column,
                                        delta
                                            * (coeff.capture_per_loss_left.derivatives[side]
                                                * pl
                                                * ll
                                                + coeff.capture_per_loss_right.derivatives[side]
                                                    * pr
                                                    * rr),
                                    );
                                }
                            }
                        }
                    }
                } else {
                    let coefficient = coeff.escape.value * speed[g] / volumes[f.left];
                    emit(model.ledger_row(), left, -coefficient);
                    emit(model.escape_row(), left, coefficient);
                    for &(column, slot) in &self.collision_rows[left] {
                        let escaped = coeff.escape.derivatives[0] * collision[slot] * pl;
                        emit(left, column, -escaped);
                        emit(model.ledger_row(), column, -escaped);
                        emit(model.escape_row(), column, escaped);
                    }
                }
            }
            if optical {
                let targets = &self.optical_targets[oi];
                let columns = &self.optical_columns[oi];
                if zero {
                    for &column in columns {
                        for _g in 0..GROUPS {
                            if !optical_active(oi, column, _g) {
                                continue;
                            }
                            emit(f.left * GROUPS + _g, model.target_row(column), 0.);
                            emit(
                                right_region.unwrap() * GROUPS + _g,
                                model.target_row(column),
                                0.,
                            );
                            emit(model.ledger_row(), model.target_row(column), 0.);
                            for &target in targets {
                                if optical_active(oi, target, _g) {
                                    emit(model.target_row(target), model.target_row(column), 0.);
                                }
                            }
                        }
                    }
                } else {
                    let w = work.as_mut().unwrap();
                    let state = &w.state;
                    let coefficients = &w.transport.face_coefficients()?[fi];
                    let base_left = w.optical[oi].left_loss.clone();
                    let base_right = w.optical[oi].right_loss.clone();
                    model.optical[oi].emit_partials(&mut w.optical[oi], |target, dt, dl, dr| {
                        let column = model.target_row(target);
                        let r = right_region.unwrap();
                        for g in 0..GROUPS {
                            if !optical_active(oi, target, g) {
                                continue;
                            }
                            let left = f.left * GROUPS + g;
                            let right = r * GROUPS + g;
                            let pl = speed[g] * state[left] / volumes[f.left];
                            let pr = speed[g] * state[right] / volumes[r];
                            let c = coefficients[g];
                            let exchange = -c.exchange.derivatives[2] * dt[g] * (pr - pl);
                            let capl = -c.capture_left.derivatives[2] * dt[g] * pl;
                            let capr = -c.capture_right.derivatives[2] * dt[g] * pr;
                            emit(left, column, exchange - capl);
                            emit(right, column, -exchange - capr);
                            emit(model.ledger_row(), column, -capl - capr);
                            for (j, &target) in targets.iter().enumerate() {
                                if !optical_active(oi, target, g) {
                                    continue;
                                }
                                let value = -pl
                                    * (c.capture_per_loss_left.derivatives[2]
                                        * dt[g]
                                        * base_left[j][g]
                                        + c.capture_per_loss_left.value * dl[j][g])
                                    - pr * (c.capture_per_loss_right.derivatives[2]
                                        * dt[g]
                                        * base_right[j][g]
                                        + c.capture_per_loss_right.value * dr[j][g]);
                                emit(model.target_row(target), column, value);
                            }
                        }
                    })?;
                }
                oi += 1;
            }
        }
        Ok(())
    }
}

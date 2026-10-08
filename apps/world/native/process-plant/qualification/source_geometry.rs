//! Offline current-geometry operator audit. No runtime API, advancement or
//! second history owner. Models below reuse the production component laws;
//! independent incidence assembly checks the composed SOURCE shape JVP before
//! a large, geometry-independent rate can obscure a finite difference.
use leitbild_plant_numerics::{
    cylindrical_source as cs, moderator_source as ms, optical_source as os, passive_source as ps,
    source_evolution as se, transport_source as ts,
};
const G: usize = 7;
#[derive(Clone, Debug)]
pub struct Group {
    pub name: &'static str,
    pub units: &'static str,
    pub start: usize,
    pub end: usize,
}
pub struct Stage {
    pub coefficients: Vec<f64>,
    pub direction: Vec<f64>,
    pub source_direction: Vec<f64>,
    pub external_direction: Vec<ms::Events>,
    pub groups: Vec<Group>,
}
impl Stage {
    fn new(source: &se::Evolution, external: usize) -> Self {
        Self {
            coefficients: Vec::new(),
            direction: Vec::new(),
            source_direction: vec![0.; source.state_count()],
            external_direction: vec![ms::Events::default(); external],
            groups: Vec::new(),
        }
    }
    fn push(&mut self, value: f64, direction: f64) {
        self.coefficients.push(value);
        self.direction.push(direction);
    }
    fn group(&mut self, name: &'static str, units: &'static str, start: usize) {
        self.groups.push(Group {
            name,
            units,
            start,
            end: self.coefficients.len(),
        });
    }
}
pub struct Verifier {
    moderator: ms::ModeratorModel,
    mw: ms::Workspace,
    passive: ps::Model,
    pw: ps::Workspace,
    cylinder: cs::Model,
    cw: cs::Workspace,
    transport: ts::Model,
    tw: ts::Workspace,
    optical: Vec<(os::LayerModel, os::LayerWorkspace)>,
    rows: Vec<ms::Stocks>,
    row_map: Vec<se::WaterRow>,
    owners: Vec<se::WaterOwner>,
    row_owners: Vec<Option<usize>>,
    passive_stocks: Vec<ps::Stock>,
    passive_incidence: Vec<ps::Intersection>,
    cylinder_incidence: Vec<cs::Intersection>,
    cylinder_targets: Vec<cs::Target>,
    faces: Vec<ts::Face>,
}
fn zero() -> ms::Stocks {
    ms::Stocks {
        water_mass: 0.,
        liquid_volume: 0.,
        hydrogen_target: 0.,
        hydrogen_product: 0.,
        mobile_boron10: 0.,
    }
}
impl Verifier {
    pub fn new(input: &se::Input) -> Result<Self, &'static str> {
        let volumes = input.history.fuel().volumes();
        let speed = input.history.fuel().law().speed;
        let moderator = ms::ModeratorModel::new(
            input.moderator.law().clone(),
            volumes.to_vec(),
            input.moderator.intersections().to_vec(),
        )?;
        let passive = ps::Model::new(
            volumes.to_vec(),
            speed,
            input.passive_stocks.clone(),
            input.passive_incidence.clone(),
            input.targets.len(),
        )?;
        let cylinder = cs::Model::new(
            volumes.to_vec(),
            speed,
            input.cylinder_targets.clone(),
            input.cylinder_incidence.clone(),
            input.targets.len(),
        )?;
        let transport = ts::Model::new(
            volumes.to_vec(),
            input.envelope_lengths.clone(),
            speed,
            input.faces.clone(),
            input.targets.len(),
        )?;
        let optical = input
            .optical_layers
            .iter()
            .map(|layers| {
                let m = os::LayerModel::new(layers, &input.targets)?;
                let w = m.workspace();
                Ok((m, w))
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        let row_owners = input
            .row_map
            .iter()
            .map(|row| match input.water_owners[row.owner].authority {
                se::WaterAuthority::Closed => None,
                se::WaterAuthority::External { index } => Some(index),
            })
            .collect();
        let mw = moderator.workspace();
        let pw = passive.workspace();
        let cw = cylinder.workspace();
        let tw = transport.workspace();
        Ok(Self {
            moderator,
            mw,
            passive,
            pw,
            cylinder,
            cw,
            transport,
            tw,
            optical,
            rows: input.water_rows.clone(),
            row_map: input.row_map.clone(),
            owners: input.water_owners.clone(),
            row_owners,
            passive_stocks: input.passive_stocks.clone(),
            passive_incidence: input.passive_incidence.clone(),
            cylinder_incidence: input.cylinder_incidence.clone(),
            cylinder_targets: input.cylinder_targets.clone(),
            faces: input.faces.clone(),
        })
    }
    pub fn evaluate(
        &mut self,
        source: &se::Evolution,
        y: &[f64],
        temperatures: &[f64],
        external: &[ms::Stocks],
        geometry: &se::Geometry,
        dexternal: &[ms::Stocks],
        dg: &se::Geometry,
    ) -> Result<Stage, &'static str> {
        let mut out = Stage::new(source, external.len());
        let history = source.fuel_history();
        let volumes = history.fuel().volumes();
        let speed = history.fuel().law().speed;
        let n = volumes.len() * G;
        if y.len() != source.state_count() || external.len() != dexternal.len() {
            return Err("Wrong offline operator-audit state/owner shape");
        }
        let mut history_y = y[..source.history_dimension()].to_vec();
        history_y[source.cf_row()] = source.prepared_cf_energy() - y[source.cf_row()];
        let mut history_work = history.workspace();
        history.evaluate_into(temperatures, &history_y, &mut history_work)?;
        let mut collision = history_work.collision()?.to_vec();
        let mut dcollision = vec![[0.; G]; volumes.len()];
        let amounts = (0..source.target_count())
            .map(|i| Ok(source.target_reference_atoms()[i] - source.consumed_target(y, i)?))
            .collect::<Result<Vec<_>, &'static str>>()?;
        let bulk = external
            .iter()
            .zip(&geometry.external_water_volumes)
            .map(|(&s, &v)| ms::Bulk::new(s, v))
            .collect::<Result<Vec<_>, _>>()?;
        let mut rows = self.rows.clone();
        for (s, map) in rows.iter_mut().zip(&self.row_map) {
            if matches!(self.owners[map.owner].authority, se::WaterAuthority::Closed) {
                let h = map.h_fraction * y[source.water_row(map.owner, false)];
                s.hydrogen_target -= h;
                s.hydrogen_product += h;
                s.mobile_boron10 -= map.b_fraction * y[source.water_row(map.owner, true)];
            }
        }
        self.moderator.update_projected(
            &rows,
            &geometry.moderator_volumes,
            &bulk,
            &self.row_owners,
            &mut self.mw,
        )?;
        let mut base_moderator_collision = vec![[0.; G]; volumes.len()];
        self.moderator
            .collision_into(&self.mw, &mut base_moderator_collision)?;
        for (a, b) in collision.iter_mut().zip(&base_moderator_collision) {
            for g in 0..G {
                a[g] += b[g];
            }
        }
        let mut net = 0.;
        let mut escaped = 0.;
        let mut collected = 0.;
        let start = out.coefficients.len();
        for (i, (e, map)) in self
            .moderator
            .intersections()
            .iter()
            .zip(&self.row_map)
            .enumerate()
        {
            let ds = self.row_owners[i].map_or(zero(), |owner| dexternal[owner]);
            let dv = self.row_owners[i].map_or(0., |owner| dg.external_water_volumes[owner]);
            let direction =
                self.moderator
                    .row_direction(i, ds, dv, dg.moderator_volumes[i], &self.mw)?;
            let row = self.mw.rows()?[i];
            let mut h = 0.;
            let mut b = 0.;
            for g in 0..G {
                let pos = e.region * G + g;
                out.push(row.hydrogen[g] / speed[g], direction.hydrogen[g] / speed[g]);
                out.push(row.boron[g] / speed[g], direction.boron[g] / speed[g]);
                let scatter = self.moderator.law().scatter[g].iter().sum::<f64>();
                out.push(
                    row.scatter_scale * scatter,
                    direction.scatter_scale * scatter,
                );
                let dh = direction.hydrogen[g] * y[pos];
                let db = direction.boron[g] * y[pos];
                h += dh;
                b += db;
                out.source_direction[pos] -= dh + db;
                dcollision[e.region][g] += (direction.hydrogen[g] + direction.boron[g]) / speed[g]
                    + direction.scatter_scale * scatter;
                for to in 0..G {
                    if to != g {
                        let transfer = direction.scatter_scale
                            * self.moderator.law().scatter[g][to]
                            * speed[g]
                            * y[pos];
                        out.source_direction[pos] -= transfer;
                        out.source_direction[e.region * G + to] += transfer;
                    }
                }
            }
            net -= h + b;
            if let Some(owner) = self.row_owners[i] {
                let event = &mut out.external_direction[owner];
                event.hydrogen += h;
                event.boron += b;
                event.emitted_charged += h * self.moderator.law().hydrogen_emission[0]
                    + b * self.moderator.law().boron_emission[0];
                event.emitted_photon += h * self.moderator.law().hydrogen_emission[1]
                    + b * self.moderator.law().boron_emission[1];
            } else {
                out.source_direction[source.water_row(map.owner, false)] += h;
                out.source_direction[source.water_row(map.owner, true)] += b;
            }
        }
        out.group("moderator_H_B_scatter", "m^-1", start);

        self.passive
            .update_with_volumes(&amounts, &geometry.passive_volumes, &mut self.pw)?;
        let mut dpassive_collision = vec![[0.; G]; volumes.len()];
        let mut native_capture = vec![[0.; G]; self.passive.birth_count()];
        let mut unit = vec![0.; n];
        for g in 0..G {
            unit.fill(0.);
            for r in 0..volumes.len() {
                unit[r * G + g] = 1.;
            }
            let mut rate = vec![0.; n];
            let mut captures = vec![0.; amounts.len()];
            let mut births = vec![0.; self.passive.birth_count()];
            self.passive
                .apply(&self.pw, &unit, &mut rate, &mut captures, &mut births)?;
            for (i, b) in births.into_iter().enumerate() {
                native_capture[i][g] = b;
            }
        }
        let start = out.coefficients.len();
        let mut birth = 0;
        for (i, e) in self.passive_incidence.iter().enumerate() {
            let stock = &self.passive_stocks[e.stock];
            let dv = dg.passive_volumes[i];
            for g in 0..G {
                dpassive_collision[e.region][g] += stock.scatter_m1[g] * dv / volumes[e.region];
            }
            for target in &stock.targets {
                for g in 0..G {
                    let attenuation =
                        amounts[target.index] * (dv / stock.volume) * target.sigma_m2[g]
                            / volumes[e.region];
                    out.push(native_capture[birth][g] / speed[g], attenuation);
                    let event = attenuation * speed[g] * y[e.region * G + g];
                    out.source_direction[e.region * G + g] -= event;
                    out.source_direction[source.target_row(target.index)] += event;
                    net -= event;
                    dpassive_collision[e.region][g] += attenuation;
                }
                birth += 1;
            }
        }
        out.group("passive_target_capture", "m^-1", start);
        let start = out.coefficients.len();
        for r in 0..volumes.len() {
            for g in 0..G {
                let value = self.pw.collision()?[r][g];
                out.push(value, dpassive_collision[r][g]);
                collision[r][g] += value;
                dcollision[r][g] += dpassive_collision[r][g];
            }
        }
        out.group("passive_total_collision", "m^-1", start);

        self.cylinder
            .update_with_shares(&amounts, &geometry.cylinder_shares, &mut self.cw)?;
        let start = out.coefficients.len();
        for (i, e) in self.cylinder_incidence.iter().enumerate() {
            let response = self.cw.responses()?[e.target];
            let share = geometry.cylinder_shares[i] / volumes[e.region];
            let ds = dg.cylinder_shares[i] / volumes[e.region];
            for g in 0..G {
                out.push(share * response.capture_m2[g], ds * response.capture_m2[g]);
                out.push(
                    share * response.energy_escape_m2[g],
                    ds * response.energy_escape_m2[g],
                );
                out.push(
                    share * response.collected_m2[g],
                    ds * response.collected_m2[g],
                );
                let event = ds * response.capture_m2[g] * speed[g] * y[e.region * G + g];
                out.source_direction[e.region * G + g] -= event;
                out.source_direction[source.target_row(self.cylinder_targets[e.target].index)] +=
                    event;
                net -= event;
                collected += ds * response.collected_m2[g] * speed[g] * y[e.region * G + g];
                dcollision[e.region][g] += ds * response.capture_m2[g];
            }
        }
        out.group("cylinder_capture_escape_collection", "m^-1", start);
        for (a, b) in collision.iter_mut().zip(self.cw.collision()?) {
            for g in 0..G {
                a[g] += b[g];
            }
        }

        let mut optical_inputs = Vec::new();
        for (model, work) in &mut self.optical {
            model.update(&amounts, work)?;
            optical_inputs.push(work.input.clone());
        }
        self.transport
            .update(&collision, &optical_inputs, &mut self.tw)?;
        let start = out.coefficients.len();
        let mut optical_index = 0;
        for (face, coefficients) in self.faces.iter().zip(self.tw.face_coefficients()?) {
            let optical = matches!(
                face.law,
                ts::FaceLaw::Optical { .. } | ts::FaceLaw::InternalOptical { .. }
            );
            let right = face.right.or_else(|| {
                matches!(face.law, ts::FaceLaw::InternalOptical { .. }).then_some(face.left)
            });
            for g in 0..G {
                let vector = [
                    dcollision[face.left][g],
                    right.map_or(0., |r| dcollision[r][g]),
                    0.,
                ];
                let derivative = |s: ts::Scalar| {
                    s.derivatives
                        .iter()
                        .zip(vector)
                        .map(|(a, b)| a * b)
                        .sum::<f64>()
                };
                let c = coefficients[g];
                for scalar in [
                    c.exchange,
                    c.capture_left,
                    c.capture_right,
                    c.escape,
                    c.capture_per_loss_left,
                    c.capture_per_loss_right,
                ] {
                    out.push(scalar.value / face.area, derivative(scalar) / face.area);
                }
                let left_pos = face.left * G + g;
                let left = speed[g] * y[left_pos] / volumes[face.left];
                if let Some(r) = right {
                    let right_pos = r * G + g;
                    let right_population = speed[g] * y[right_pos] / volumes[r];
                    let exchange = derivative(c.exchange) * (right_population - left);
                    let capture_left = derivative(c.capture_left) * left;
                    let capture_right = derivative(c.capture_right) * right_population;
                    out.source_direction[left_pos] += exchange - capture_left;
                    out.source_direction[right_pos] -= exchange + capture_right;
                    net -= capture_left + capture_right;
                    if let ts::FaceLaw::Optical { targets }
                    | ts::FaceLaw::InternalOptical { targets } = &face.law
                    {
                        let work = &self.optical[optical_index].1;
                        for (i, &target) in targets.iter().enumerate() {
                            out.source_direction[source.target_row(target)] +=
                                derivative(c.capture_per_loss_left) * left * work.left_loss[i][g]
                                    + derivative(c.capture_per_loss_right)
                                        * right_population
                                        * work.right_loss[i][g];
                        }
                    }
                } else {
                    let event = derivative(c.escape) * left;
                    out.source_direction[left_pos] -= event;
                    net -= event;
                    escaped += event;
                }
            }
            if optical {
                optical_index += 1;
            }
        }
        out.group(
            "transport_faces",
            "dimensionless (per actual face area)",
            start,
        );
        out.source_direction[source.ledger_row()] = net;
        out.source_direction[source.escape_row()] = escaped;
        out.source_direction[source.collected_row()] = collected;
        // All histories, source reserves and fuel temperature are held fixed:
        // every fuel-energy/history rate, including the fourth audit row, has
        // exactly zero geometry derivative. No history is initialized here.
        if out
            .coefficients
            .iter()
            .chain(&out.direction)
            .chain(&out.source_direction)
            .any(|v| !v.is_finite())
            || out.external_direction.iter().any(|e| {
                [e.hydrogen, e.boron, e.emitted_charged, e.emitted_photon]
                    .iter()
                    .any(|v| !v.is_finite())
            })
        {
            return Err("Nonfinite offline physical-coefficient/assembly audit");
        }
        Ok(out)
    }
}

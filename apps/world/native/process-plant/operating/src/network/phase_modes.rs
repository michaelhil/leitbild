//! spec: world/packs/process-plant/reference-designs/ld-01/systems/reactor/bulk-condensation-study.md#stable-phase-birth-and-disappearance
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#mechanical-ownership-and-terminology
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#prospective-accuracy-contract
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! Regular-cell phase modes of the S3 phase branch (lead S3-D-P1, S3-D-P6,
//! S3-D3).
//!
//! A regular cell keeps its six decision-0013 slots `p, M_l, U_l, M_g, U_g,
//! B`. In the **liquid** mode (S2's rows, unchanged) the cell holds no
//! vapor. In the **equilibrium** mode (both bounds of the bulk-condensation
//! owner active, pure water) the differential slots `M_l` and `U_l` hold the
//! cell's totals `M` and `U`; `p`, `M_g` and `U_g` are algebraic:
//!
//! ```text
//! (M - M_g) v_f(p) + M_g v_g(p) = V          EOS on p
//! M' = R_l + R_g                             slot M_l
//! U' = H_l + H_g - p V'_boundary             slot U_l
//! U - (M - M_g) u_f(p) - M_g u_g(p) = 0      split on M_g
//! U_g - M_g u_g(p) = 0                       definition on U_g
//! ```
//!
//! The algebraic block in `(p, M_g, U_g)` is the flash Jacobian, nonsingular
//! inside the dome, so the DAE stays index 1 with no new parameter. Both
//! phases' points are the saturated endpoints of [`Properties::saturation`]
//! at the cell pressure, with their directions along the saturation line;
//! an equilibrium cell never inverts `(p, U/M)` at its endpoint (S3-D-P6).
//! Everything else in the network reads the cell's phases through one view:
//! liquid `M - M_g, (M - M_g) u_f`, vapor `M_g, M_g u_g`.
//!
//! Transactions are exact. A birth moves the vapor slots into the totals,
//! which at a located birth are exactly zero, so the stock vector is
//! unchanged; an exhaustion zeroes the algebraic vapor slots and leaves the
//! totals as the liquid's. The mode table is part of the copyable discrete
//! state. Roots, L1 path states and the restart belong to their owners
//! (S3-D-P2, the event policy); this module gives their values.
//!
//! The equilibrium cell's algebraic vapor coordinates take the tolerance
//! class S3-D3 derives from the pressure class through their own flash
//! sensitivity ([`Network::equilibrium_tolerances`]).
use super::{Failure, Network, Properties, bad, rec, s, selected_phase};
use crate::{
    local_flow::{Cell, Phase},
    thermal::{Saturation, Scalar},
};
use serde_json::{Value, json};

use super::properties::Water;

/// R4-EXHAUST-START: an exhaustion root that stock IDA can no longer report at
/// a segment start: the vapor mass below zero, or at an exact zero and falling.
pub fn past_zero(vapor_mass: f64, rate: f64) -> bool {
    vapor_mass < 0. || (vapor_mass == 0. && rate < 0.)
}

/// A regular cell's phase mode (S3-D-P1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CellMode {
    /// S2's rows; the cell holds no vapor.
    Liquid,
    /// Both bounds active: slot `M_l` holds `M`, slot `U_l` holds `U`.
    Equilibrium,
}

/// One equilibrium cell's saturated endpoints at its pressure, with
/// directions along the evaluation's seed.
#[derive(Clone, Copy, Debug)]
pub(super) struct Saturated {
    pub(super) saturation: Saturation,
    pub(super) pressure: Scalar,
    pub(super) liquid_energy: Scalar,
    pub(super) vapor_energy: Scalar,
}

type Point = Option<(Water, Water)>;

impl<P: Properties> Network<P> {
    /// Every regular cell's mode.
    pub fn cell_modes(&self) -> &[CellMode] {
        &self.modes
    }
    /// The phase presence the phase-mode owner declares (decision 0014's
    /// L1 reads it, the presence-keyed joined pattern follows it): a
    /// liquid-mode cell's by its stocks ([`Network::stock_presence`]), an
    /// equilibrium cell holds both phases (its vapor is present from its
    /// birth, at zero mass), the stratified port's by the last evaluation.
    /// With every cell liquid it is the stocks' presence.
    pub fn declared_presence(&self, y: &[f64]) -> super::unilateral::Presence {
        let mut presence = self.stock_presence(y);
        for (node, mode) in self.modes.iter().enumerate() {
            if *mode == CellMode::Equilibrium {
                presence.cells[node] = [true, true];
            }
        }
        presence
    }
    /// S3-D32 (lead, 15 Oct): the phase whose receipts a phase-`k` face
    /// flux enters at `cell`. Vapor at a liquid-mode regular cell is that
    /// cell's liquid: the cell keeps no vapor inventory and its totals
    /// `(M, U)` take the vapor's mass and enthalpy, so the vapor has
    /// condensed (instantaneous equilibrium condensation, exact: the flux's
    /// mass, enthalpy and boron leave one end and enter the other). If that
    /// liquid reaches saturation, the cell is born into the equilibrium
    /// mode by its existing root. Every other end keeps the flux's phase
    /// (equilibrium cells hold both; the stratified cell's ports have
    /// their own law). With no vapor flux anywhere (S1, S2) nothing
    /// changes: the redirected flux is exactly zero.
    pub(super) fn receipt_phase(&self, cell: usize, k: usize) -> usize {
        if k == 1 && cell < self.modes.len() && self.modes[cell] == CellMode::Liquid {
            0
        } else {
            k
        }
    }
    /// Whether any regular cell is in the equilibrium mode.
    pub fn has_equilibrium_cells(&self) -> bool {
        self.modes.contains(&CellMode::Equilibrium)
    }
    /// Restore a copied mode table (discrete state, S8 copy/restore).
    pub fn set_cell_modes(&mut self, modes: &[CellMode]) -> Result<(), Failure> {
        if modes.len() != self.modes.len() {
            return Err(bad(format!(
                "{} modes for {} regular cells",
                modes.len(),
                self.modes.len()
            )));
        }
        self.modes.copy_from_slice(modes);
        Ok(())
    }

    /// Birth transaction (liquid → equilibrium) at a located root: the
    /// vapor slots move into the totals in solver scaling. A liquid-mode
    /// cell holds no vapor, so at a birth both are exactly zero and the
    /// stock vector is unchanged; a nonzero vapor slot is a separated state
    /// outside S3 and refuses.
    pub fn birth(&mut self, node: usize, y: &mut [f64]) -> Result<Value, Failure> {
        self.regular(node)?;
        if self.modes[node] != CellMode::Liquid {
            return Err(bad(format!("birth of cell {node}, which is not liquid")));
        }
        let l = self.cell_layout[node];
        let (mg, ug) = (y[l.mass[1]], y[l.energy[1]]);
        if mg != 0. || ug != 0. {
            return Err(bad(format!(
                "birth of cell {node} holding vapor slots ({mg}, {ug}): a separated state is outside S3"
            )));
        }
        self.modes[node] = CellMode::Equilibrium;
        Ok(json!({"birth":node,"vapor_slots":[mg,ug]}))
    }

    /// Every cell born since `before` (the mode table copied before this
    /// instant's transactions), in cell order; empty when no cell was born,
    /// as on every S1/S2 path.
    ///
    /// DR-C3-BIRTH05 (owner decision G1): a birth at the band's credited
    /// superheat leaves the cell's totals unchanged, but its algebraic rows
    /// become the flash at those totals (fixed `M, U, V`). The metastable
    /// liquid's pressure and zero vapor miss that flash by a finite step
    /// (about +0.1 MPa and a vapor quality near 1e-4 at 14-15 MPa), which
    /// the restart's exact consistent start completes. A birth at
    /// saturation, outside the band's pressure range, is consistent at its
    /// root already.
    pub fn born_cells(&self, before: &[CellMode]) -> Result<Vec<usize>, Failure> {
        if before.len() != self.modes.len() {
            return Err(bad(format!(
                "{} modes before for {} regular cells",
                before.len(),
                self.modes.len()
            )));
        }
        Ok(before
            .iter()
            .zip(&self.modes)
            .enumerate()
            .filter(|(_, (b, a))| **b == CellMode::Liquid && **a == CellMode::Equilibrium)
            .map(|(node, _)| node)
            .collect())
    }

    /// A born cell's flash for the restart's receipt, in physical units:
    /// its pressure before (`entry`, the state handed to the restart) and
    /// after the consistent start (`y`), the step, and the vapor it holds.
    pub fn birth_flash(&self, node: usize, entry: &[f64], y: &[f64]) -> Result<Value, Failure> {
        self.regular(node)?;
        let l = self.cell_layout[node];
        let at = |v: &[f64], i: usize| v[i] * self.scales[i];
        let (before, after) = (at(entry, l.base), at(y, l.base));
        Ok(
            json!({"cell": node, "p_entry_pa": before, "p_flash_pa": after,
            "dp_pa": after - before, "vapor_kg": at(y, l.mass[1]),
            "vapor_energy_j": at(y, l.energy[1]), "mass_kg": at(y, l.mass[0])}),
        )
    }

    /// Exhaustion transaction (equilibrium → liquid) at a located root: the
    /// algebraic vapor slots are zeroed; the totals stay in the liquid's
    /// slots, so the last vapor's material and energy join the liquid
    /// exactly. Returns the vapor slots at the root (root-precision size).
    pub fn exhaustion(&mut self, node: usize, y: &mut [f64]) -> Result<Value, Failure> {
        self.regular(node)?;
        if self.modes[node] != CellMode::Equilibrium {
            return Err(bad(format!(
                "exhaustion of cell {node}, which is not in equilibrium"
            )));
        }
        let l = self.cell_layout[node];
        let at_root = [
            y[l.mass[1]] * self.scales[l.mass[1]],
            y[l.energy[1]] * self.scales[l.energy[1]],
        ];
        y[l.mass[1]] = 0.;
        y[l.energy[1]] = 0.;
        self.modes[node] = CellMode::Liquid;
        Ok(json!({"exhaustion":node,"vapor_kg_j_at_root":at_root}))
    }

    /// A liquid-mode cell's departure from saturation, `T_l(p, U_l/M_l) -
    /// Tsat(p)` [K] (positive: superheated liquid).
    pub fn liquid_departure(&self, node: usize, y: &[f64]) -> Result<f64, Failure> {
        self.regular(node)?;
        if self.modes[node] != CellMode::Liquid {
            return Err(bad(format!("liquid departure of non-liquid cell {node}")));
        }
        let l = self.cell_layout[node];
        let p = y[l.base] * self.scales[l.base];
        let mass = y[l.mass[0]] * self.scales[l.mass[0]];
        let u = y[l.energy[0]] * self.scales[l.energy[0]] / mass;
        let point = self
            .properties
            .caloric(false, p, u, false)
            .map_err(Failure::Recoverable)?;
        let temperature = self.properties.values(&point).temperature_k;
        let saturation = self
            .properties
            .saturation_caloric(s(p))
            .map_err(Failure::Recoverable)?;
        Ok(temperature - saturation.temperature.value)
    }

    /// Birth root value of a liquid-mode cell, rising through zero at a
    /// birth (owner decision G1, 15 Oct: vapour forms at the H3 band's
    /// credited liquid superheat, disclosed as a nucleation-delay model):
    /// the departure less the compiled band's `creditedMax_K` while the
    /// cell's pressure lies in the band's pressure range, where the bridge
    /// admits superheated liquid; outside that range the bridge admits none
    /// and the birth stays at saturation (the departure itself).
    pub fn birth_root(&self, node: usize, y: &[f64]) -> Result<f64, Failure> {
        let departure = self.liquid_departure(node, y)?;
        let band = self.properties.metastable_band().map_err(Failure::Fatal)?;
        let l = self.cell_layout[node];
        let p = y[l.base] * self.scales[l.base];
        let [low, high] = band.pressure_range_pa;
        let in_range = p <= high
            && if band.lower_bound_exclusive {
                p > low
            } else {
                p >= low
            };
        Ok(departure - if in_range { band.credited_max_k } else { 0. })
    }

    /// An equilibrium cell's vapor and liquid mass `(M_g, M - M_g)` [kg]:
    /// the exhaustion root (falling) and the dryout root (falling, mode G at
    /// S6).
    pub fn equilibrium_masses(&self, node: usize, y: &[f64]) -> Result<(f64, f64), Failure> {
        self.regular(node)?;
        if self.modes[node] != CellMode::Equilibrium {
            return Err(bad(format!(
                "equilibrium masses of non-equilibrium cell {node}"
            )));
        }
        let l = self.cell_layout[node];
        let total = y[l.mass[0]] * self.scales[l.mass[0]];
        let vapor = y[l.mass[1]] * self.scales[l.mass[1]];
        Ok((vapor, total - vapor))
    }

    /// S3-D3 as first declared (rtol |p| basis; superseded by S3-D16,
    /// [`Self::equilibrium_credited_tolerances`], and kept for PHASE-P7's
    /// study receipts): an equilibrium cell's
    /// algebraic `M_g, U_g` take their absolute class from the pressure
    /// class through their own flash sensitivity at fixed totals,
    /// `atol_Mg = atol_p |dM_g/dp|`, `atol_Ug = atol_p |dU_g/dp|`, with
    /// `dM_g/dp = -(M_l u_f' + M_g u_g')/u_fg`, `dU_g/dp = u_g dM_g/dp +
    /// M_g u_g'` and `atol_p = rtol |p|` at the state the segment starts
    /// from. They stay in the error test. `atol` is in solver scaling;
    /// liquid-mode cells keep their entries. Returns one record per
    /// equilibrium cell for the receipt.
    pub fn equilibrium_tolerances(
        &self,
        y: &[f64],
        rtol: f64,
        atol: &mut [f64],
    ) -> Result<Vec<Value>, Failure> {
        if !(rtol.is_finite() && rtol > 0.) || atol.len() != self.scales.len() {
            return Err(bad(
                "equilibrium tolerances need a positive rtol and a full atol",
            ));
        }
        let mut records = Vec::new();
        for node in 0..self.modes.len() {
            if self.modes[node] != CellMode::Equilibrium {
                continue;
            }
            let l = self.cell_layout[node];
            let p = y[l.base] * self.scales[l.base];
            let total = y[l.mass[0]] * self.scales[l.mass[0]];
            let mg = y[l.mass[1]] * self.scales[l.mass[1]];
            let sat = self.saturated_at(rec(p, 1.))?;
            let (uf, ug) = (sat.liquid_energy, sat.vapor_energy);
            let ml = total - mg;
            let dmg_dp = -(ml * uf.direction + mg * ug.direction) / (ug.value - uf.value);
            let dug_dp = ug.value * dmg_dp + mg * ug.direction;
            let atol_p = rtol * p.abs();
            let (am, au) = (atol_p * dmg_dp.abs(), atol_p * dug_dp.abs());
            if !(am.is_finite() && au.is_finite() && am > 0. && au > 0.) {
                return Err(Failure::Recoverable(format!(
                    "cell {node}: nonpositive derived vapor class ({am}, {au})"
                )));
            }
            atol[l.mass[1]] = am / self.scales[l.mass[1]];
            atol[l.energy[1]] = au / self.scales[l.energy[1]];
            records.push(
                json!({"cell":node,"p_pa":p,"mass_kg":total,"vapor_kg":mg,"atol_p_pa":atol_p,
                "dmg_dp_kg_per_pa":dmg_dp,"dug_dp_j_per_pa":dug_dp,"atol_mg_kg":am,"atol_ug_j":au}),
            );
        }
        Ok(records)
    }

    /// S3-D16 (lead, 15 Oct; S2-D24r's rule): an equilibrium cell's
    /// algebraic `M_g, U_g` take their absolute class from the tightest
    /// credited budget among the credited outputs they determine (those
    /// reading the cell's pressure, the one pressure their own rows read)
    /// through their flash sensitivity at fixed totals, `atol_Mg = budget
    /// |dM_g/dp|`, `atol_Ug = budget |dU_g/dp|` (the derivatives of
    /// [`Self::equilibrium_tolerances`]), at the state the segment starts
    /// from. S3-D16b (lead, 15 Oct): a cell whose pressure no credited
    /// output reads determines none, and takes `rtol·|p|` at its own
    /// pressure through the same sensitivity (`relative` is the contract's
    /// rtol), recorded per cell with that rule. `atol` is in solver scaling;
    /// liquid-mode cells keep their entries. Returns one record per
    /// equilibrium cell, with every output it determines.
    pub fn equilibrium_credited_tolerances(
        &self,
        y: &[f64],
        credited: &[super::CreditedOutput],
        relative: f64,
        atol: &mut [f64],
    ) -> Result<Vec<Value>, Failure> {
        if atol.len() != self.scales.len() {
            return Err(bad("equilibrium tolerances need a full atol"));
        }
        let mut records = Vec::new();
        for node in 0..self.modes.len() {
            if self.modes[node] != CellMode::Equilibrium {
                continue;
            }
            let l = self.cell_layout[node];
            let mut determined: Vec<&super::CreditedOutput> = credited
                .iter()
                .filter(|o| o.columns.contains(&l.base))
                .collect();
            determined.sort_by(|a, b| a.budget.total_cmp(&b.budget));
            let p = y[l.base] * self.scales[l.base];
            let (budget, output, rule) = match determined.first() {
                Some(tightest) => (
                    tightest.budget,
                    json!(tightest.name),
                    "S3-D16: tightest credited budget x flash sensitivity",
                ),
                None => (
                    relative * p.abs(),
                    Value::Null,
                    "S3-D16b: determines no credited output (none reads its pressure); rtol x |p| x flash sensitivity",
                ),
            };
            if !(budget.is_finite() && budget > 0.) {
                return Err(Failure::Recoverable(format!(
                    "cell {node}: nonpositive vapor-class basis {budget} Pa"
                )));
            }
            let total = y[l.mass[0]] * self.scales[l.mass[0]];
            let mg = y[l.mass[1]] * self.scales[l.mass[1]];
            let sat = self.saturated_at(rec(p, 1.))?;
            let (uf, ug) = (sat.liquid_energy, sat.vapor_energy);
            let ml = total - mg;
            let dmg_dp = -(ml * uf.direction + mg * ug.direction) / (ug.value - uf.value);
            let dug_dp = ug.value * dmg_dp + mg * ug.direction;
            let (am, au) = (budget * dmg_dp.abs(), budget * dug_dp.abs());
            if !(am.is_finite() && au.is_finite() && am > 0. && au > 0.) {
                return Err(Failure::Recoverable(format!(
                    "cell {node}: nonpositive derived vapor class ({am}, {au})"
                )));
            }
            atol[l.mass[1]] = am / self.scales[l.mass[1]];
            atol[l.energy[1]] = au / self.scales[l.energy[1]];
            records.push(json!({"cell":node,"p_pa":p,"mass_kg":total,"vapor_kg":mg,
                "rule":rule,
                "determines":determined.iter().map(|o| json!({"output":o.name,"budget":o.budget})).collect::<Vec<_>>(),
                "budget":budget,"output":output,
                "dmg_dp_kg_per_pa":dmg_dp,"dug_dp_j_per_pa":dug_dp,"atol_mg_kg":am,"atol_ug_j":au}));
        }
        Ok(records)
    }

    /// Physical phase stocks `(mass, internal energy)` of a regular cell at
    /// `y`: a liquid cell's slots; an equilibrium cell's liquid is its totals
    /// less its vapor, so the two phases sum to the totals.
    pub fn phase_stocks(&self, node: usize, y: &[f64]) -> [(f64, f64); 2] {
        let l = self.cell_layout[node];
        let at = |i: usize| y[i] * self.scales[i];
        let vapor = (at(l.mass[1]), at(l.energy[1]));
        match self.modes[node] {
            CellMode::Liquid => [(at(l.mass[0]), at(l.energy[0])), vapor],
            CellMode::Equilibrium => [(at(l.mass[0]) - vapor.0, at(l.energy[0]) - vapor.1), vapor],
        }
    }

    fn regular(&self, node: usize) -> Result<(), Failure> {
        if node >= self.modes.len() {
            return Err(bad(format!("cell {node} is not a regular cell")));
        }
        Ok(())
    }

    /// The saturated endpoints at one pressure (with its direction).
    fn saturated_at(&self, pressure: Scalar) -> Result<Saturated, Failure> {
        saturated_with(&self.properties, pressure)
    }

    /// Every equilibrium cell's saturated endpoints at `(y, seed)`; empty
    /// when every cell is liquid, so S2's evaluation does no extra work.
    pub(super) fn saturated(
        &self,
        y: &[f64],
        seed: Option<&[f64]>,
    ) -> Result<Vec<Option<Saturated>>, Failure> {
        if !self.has_equilibrium_cells() {
            return Ok(Vec::new());
        }
        (0..self.modes.len())
            .map(|node| {
                if self.modes[node] != CellMode::Equilibrium {
                    return Ok(None);
                }
                let base = self.cell_layout[node].base;
                self.saturated_at(self.get(y, seed, base)).map(Some)
            })
            .collect()
    }

    /// The network's view of the coordinates: each equilibrium cell's liquid
    /// slots hold `M - M_g, (M - M_g) u_f` and its vapor energy slot
    /// `M_g u_g`, values and seed directions, so every reader of the cell's
    /// phases sees its saturated phases.
    #[allow(clippy::type_complexity)]
    pub(super) fn equilibrium_view(
        &self,
        y: &[f64],
        seed: Option<&[f64]>,
        saturated: &[Option<Saturated>],
    ) -> (Vec<f64>, Option<Vec<f64>>) {
        let mut view = y.to_vec();
        let mut seed_view = seed.map(<[f64]>::to_vec);
        for (node, sat) in saturated.iter().enumerate() {
            let Some(sat) = sat else { continue };
            let l = self.cell_layout[node];
            let total = self.get(y, seed, l.mass[0]);
            let mg = self.get(y, seed, l.mass[1]);
            let [ml, ul, ug] = view_slots(total, mg, sat);
            for (index, v) in [(l.mass[0], ml), (l.energy[0], ul), (l.energy[1], ug)] {
                view[index] = v.value / self.scales[index];
                if let Some(d) = seed_view.as_mut() {
                    d[index] = v.direction / self.scales[index];
                }
            }
        }
        (view, seed_view)
    }

    /// An equilibrium cell at the view `(y, seed)`: its state, the two
    /// saturated points (no inversion) and its EOS row, in the same form as
    /// a liquid cell's (`regular_cell`).
    pub(super) fn equilibrium_cell(
        &self,
        node: usize,
        y: &[f64],
        seed: Option<&[f64]>,
        cell_volume: Scalar,
        sat: &Saturated,
    ) -> Result<(Cell, [Point; 2], Scalar), Failure> {
        self.equilibrium_cell_from(node, &|i| self.get(y, seed, i), cell_volume, sat)
    }

    /// [`Self::equilibrium_cell`] on any reader of the view's coordinates
    /// (the residual's, or the block replay's for one column).
    pub(super) fn equilibrium_cell_from(
        &self,
        node: usize,
        get: &dyn Fn(usize) -> Scalar,
        cell_volume: Scalar,
        sat: &Saturated,
    ) -> Result<(Cell, [Point; 2], Scalar), Failure> {
        let l = self.cell_layout[node];
        let points = saturated_points(sat);
        let mut cell = Cell {
            pressure: sat.pressure,
            phase: [None; 2],
        };
        let mut current: [Point; 2] = [None; 2];
        let mut volume = [s(0.); 2];
        for k in 0..2 {
            let mass = get(l.mass[k]);
            // DR S3-REBIRTH (PHASE-L1, for KERN): an equilibrium cell's
            // phase points are the saturated endpoints whatever its mass, so
            // an exactly zero vapor mass with a direction (the newborn cell's
            // seeded column, or its rate) keeps the vapor's volume and
            // fraction terms: the rows are smooth in `M_g`, and dropping them
            // gave the wrong flash rates and a zero drive rate at a birth.
            if selected_phase(mass) {
                current[k] = Some(points[k]);
                let (q, dq) = points[k];
                volume[k] = mass / rec(q.density_kg_m3, dq.density_kg_m3);
            }
        }
        let row = (volume[0] + volume[1] - cell_volume) / s(self.volumes[node]);
        for k in 0..2 {
            let mass = get(l.mass[k]);
            if !selected_phase(mass) {
                continue;
            }
            let Some((q, dq)) = current[k] else { continue };
            let fraction = if k == l.phase {
                s(1.) - volume[1 - k] / cell_volume
            } else {
                volume[k] / cell_volume
            };
            let boron_concentration = if k == 0 {
                if mass.value == 0. {
                    return Err(Failure::Recoverable(format!(
                        "equilibrium cell {node} without liquid: dryout is mode G (S6)"
                    )));
                }
                get(l.boron) / mass
            } else {
                s(0.)
            };
            cell.phase[k] = Some(Phase {
                fraction,
                density: rec(q.density_kg_m3, dq.density_kg_m3),
                enthalpy: rec(q.enthalpy_j_kg, dq.enthalpy_j_kg),
                boron_concentration,
            });
        }
        Ok((cell, current, row))
    }

    /// The equilibrium cells' mass, energy, split and vapor-energy rows from
    /// the original coordinates (totals in the liquid slots) and the
    /// receipts every face and owner assembled; the tracer row is the
    /// liquid's, as composed for every cell.
    pub(super) fn compose_equilibrium_rows(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
        saturated: &[Option<Saturated>],
    ) {
        for (node, sat) in saturated.iter().enumerate() {
            let Some(sat) = sat else { continue };
            let l = self.cell_layout[node];
            let rows = self.equilibrium_rows(
                node,
                &|i| self.get(y, seed, i),
                &|i| self.rate(yp, seed, cj, i),
                &self.receipts[node],
                self.cell_volume_rate[node],
                sat,
            );
            for (i, row) in [l.mass[0], l.energy[0], l.mass[1], l.energy[1]]
                .into_iter()
                .zip(rows)
            {
                self.rows[i] = row;
            }
        }
    }

    /// One equilibrium cell's mass, energy, split and vapor-energy rows, in
    /// slot order `[M_l, U_l, M_g, U_g]`, from its original coordinates
    /// (`coordinate`, totals in the liquid slots), their rates, the receipts
    /// every face and owner assembled into it and its volume rate (the
    /// residual's, or the block replay's for one column).
    pub(super) fn equilibrium_rows(
        &self,
        node: usize,
        coordinate: &dyn Fn(usize) -> Scalar,
        rate: &dyn Fn(usize) -> Scalar,
        receipts: &[[Scalar; 3]; 2],
        volume_rate: Option<Scalar>,
        sat: &Saturated,
    ) -> [Scalar; 4] {
        let l = self.cell_layout[node];
        let total_m = coordinate(l.mass[0]);
        let total_u = coordinate(l.energy[0]);
        let mg = coordinate(l.mass[1]);
        let ug_slot = coordinate(l.energy[1]);
        let r = receipts;
        let mass_rate = r[0][0] + r[1][0];
        let work = volume_rate.map_or(s(0.), |rate| sat.pressure * rate);
        let energy_rate = r[0][1] + r[1][1] - work;
        let (m0, e0, e1) = (l.mass[0], l.energy[0], l.energy[1]);
        [
            (rate(m0) - mass_rate) / s(self.scales[m0]),
            (rate(e0) - energy_rate) / s(self.scales[e0]),
            (total_u - (total_m - mg) * sat.liquid_energy - mg * sat.vapor_energy)
                / s(self.scales[e0]),
            (ug_slot - mg * sat.vapor_energy) / s(self.scales[e1]),
        ]
    }
}

/// The saturated endpoints at one pressure through `properties` (the
/// network's, or the block replay's held directions).
pub(super) fn saturated_with<Q: Properties>(
    properties: &Q,
    pressure: Scalar,
) -> Result<Saturated, Failure> {
    let saturation = properties
        .saturation(pressure)
        .map_err(Failure::Recoverable)?;
    let liquid_energy = saturation.liquid.enthalpy - pressure / saturation.liquid.density;
    let vapor_energy = saturation.vapor.enthalpy - pressure / saturation.vapor.density;
    Ok(Saturated {
        saturation,
        pressure,
        liquid_energy,
        vapor_energy,
    })
}

/// An equilibrium cell's view slots from its totals and vapor mass: the
/// liquid's mass `M - M_g`, the liquid's energy `(M - M_g) u_f` and the
/// vapor's energy `M_g u_g`.
pub(super) fn view_slots(total: Scalar, mg: Scalar, sat: &Saturated) -> [Scalar; 3] {
    let ml = total - mg;
    [ml, ml * sat.liquid_energy, mg * sat.vapor_energy]
}

/// Both saturated endpoints as network points (values, directions):
/// temperature, density, enthalpy, internal energy, cp, expansion and
/// transport from the saturation tuple. Compressibility is not a saturation
/// field; it is NaN, never zero, so a reader that needs it refuses.
fn saturated_points(sat: &Saturated) -> [(Water, Water); 2] {
    let p = sat.pressure;
    let t = sat.saturation.temperature;
    let point = |w: &crate::thermal::WaterPoint, u: Scalar| -> (Water, Water) {
        let field = |pick: fn(&Scalar) -> f64| Water {
            pressure_pa: pick(&p),
            temperature_k: pick(&t),
            density_kg_m3: pick(&w.density),
            internal_energy_j_kg: pick(&u),
            enthalpy_j_kg: pick(&w.enthalpy),
            cp_j_kg_k: pick(&w.cp),
            expansion_per_k: pick(&w.expansion),
            compressibility_per_pa: f64::NAN,
            viscosity_pa_s: pick(&w.viscosity),
            conductivity_w_m_k: pick(&w.conductivity),
        };
        (field(|x| x.value), field(|x| x.direction))
    };
    [
        point(&sat.saturation.liquid, sat.liquid_energy),
        point(&sat.saturation.vapor, sat.vapor_energy),
    ]
}

#[cfg(test)]
mod start_tests {
    use super::past_zero;

    #[test]
    fn an_exhaustion_root_past_zero_reads_its_sign_then_its_rate() {
        assert!(past_zero(-1e-300, 1.));
        assert!(past_zero(0., -1e-300));
        assert!(!past_zero(0., 0.));
        assert!(!past_zero(0., 1.));
        assert!(!past_zero(1e-300, -1.));
    }
}

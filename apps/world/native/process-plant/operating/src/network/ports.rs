//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The network's ports to the owners composed with it in one residual.
//!
//! One evaluation of the network computes every regular cell's state from
//! its retained M/U/B and every face chart first. A [`Coupling`] is then
//! called once with that state ([`Fluid`]) and may add receipts into the
//! regular cells ([`Receipts`]) before any section, momentum or stock row is
//! composed. The liquid enthalpy receipt is the single heat port: thermal
//! owners deliver non-advective heat there, so phase-volume work is paid
//! once by the network's own rate closure. Receipts enter the network's
//! stock rows exactly as its face receipts do, value and direction alike.
//! The stratified PZR cell takes its surge-port receipt from the face and
//! everything else that enters it (heater and wall receipts, zone heat and
//! the relief lift with its receiver) from the owner of the PZR metal and
//! relief through [`Coupling::pzr_boundary`], on the cell's column of the
//! same evaluation (G6). A network evaluated without a coupling has no such
//! owner: its boundary is closed, with a declared relief held on its seat
//! ([`Network::uncoupled_pzr_boundary`], S1 and the preparations).
//!
//! An SG primary cell's heat owner also reports the cell's single-pass law
//! ([`SgPass`]: its fold conductance and inflow capacity rate) through
//! [`Receipts::sg_pass`]. With it the network gives that cell's port heads
//! the single-pass enthalpy profile along the folded path (R4-NCHEAD,
//! [`SgProfile`]), composed beside the face's section force before the
//! momentum rows. A cell no coupled owner reports has no profile: its heads
//! stay the uniform cell's.
//!
//! Moving cell volumes ([`CellVolume`]) are the rod owner's port, consumed
//! by [`Network::evaluate_joined`]: the EOS row, the phase rate closure and
//! the face inertance take the current volume (memo Table 1.2, "Rod
//! displacement and work"); [`Fluid::current_volumes`] reports it.
use super::{Failure, Network, Properties, Water, rec, s, stratified};
use crate::{
    local_flow::{Cell, Chart, Face},
    thermal::{FoldPath, Scalar},
};

/// Standard gravity of the network's well-balanced face head.
pub const G: f64 = 9.80665;

/// The network's fluid state of one evaluation, read-only. Indices are the
/// compiled region order (packet `mechanics.regions`): regular cells, then
/// the stratified PZR cell, whose entry in `cells` is its port view.
#[derive(Clone, Copy, Debug)]
pub struct Fluid<'a> {
    pub cells: &'a [Cell],
    /// Regular cells only: the maintained caloric point of each present (or
    /// leading-receipt) phase, value then direction; `None` when absent.
    pub points: &'a [[Option<(Water, Water)>; 2]],
    /// Regular cells only: retained phase masses (kg), liquid then vapor,
    /// and the liquid tracer amount (kg_eq), with their directions.
    pub liquid_mass: &'a [Scalar],
    pub vapor_mass: &'a [Scalar],
    pub tracer: &'a [Scalar],
    /// Every face and phase: the chart of this evaluation (flows, donors).
    pub charts: &'a [[Option<Chart>; 2]],
    /// Faces' compiled endpoints, `(from, to)`.
    pub endpoints: &'a [(usize, usize)],
    /// Region pressure-reference elevations and compiled fluid volumes.
    pub elevations: &'a [f64],
    pub volumes: &'a [f64],
    /// Regular cells only: this evaluation's free volume with its direction,
    /// the compiled volume for a fixed cell, the moving one for a moving cell.
    pub current_volumes: &'a [Scalar],
}

impl Fluid<'_> {
    /// Mixture density `sum(alpha*rho)` of a cell's present phases.
    pub fn mixture_density(&self, cell: usize) -> Scalar {
        self.cells[cell]
            .phase
            .into_iter()
            .flatten()
            .fold(s(0.), |sum, p| sum + p.fraction * p.density)
    }
    /// Local static pressure at `elevation`, reconstructed from the cell's
    /// reference pressure with its mixture density: the network's own
    /// well-balanced head `p + rho_mix g (z_ref - z)`.
    pub fn pressure_at(&self, cell: usize, elevation: f64) -> Scalar {
        self.cells[cell].pressure
            + self.mixture_density(cell) * s(G * (self.elevations[cell] - elevation))
    }
    /// Liquid mass flow of a face (kg/s, positive from `from` to `to`).
    pub fn liquid_mass_flow(&self, face: usize) -> Scalar {
        self.charts[face][0].map_or(s(0.), |c| c.mass_flow_kg_s)
    }
}

/// Receipts into the network's regular cells: `[mass kg/s, enthalpy W,
/// tracer kg_eq/s]` per phase (0 liquid, 1 vapor); positive enters the cell.
pub struct Receipts<'a> {
    cells: &'a mut [[[Scalar; 3]; 2]],
    /// Regular cells only: each SG primary cell's single-pass law, when the
    /// caller composes the pass port.
    passes: Option<&'a mut [Option<SgPass>]>,
}

/// An SG primary cell's single-pass law of this evaluation (`ld01-sg-contact`
/// R2.14, `x = UA/C`): the fold's conductance `UA = sum(share_i u_i A)` over
/// its segments (W/K) and the inflow's capacity rate `C` (W/K).
#[derive(Clone, Copy, Debug)]
pub struct SgPass {
    pub conductance_w_k: Scalar,
    pub capacity_w_k: Scalar,
}

impl<'a> Receipts<'a> {
    pub fn new(cells: &'a mut [[[Scalar; 3]; 2]]) -> Self {
        Self {
            cells,
            passes: None,
        }
    }
    /// Receipts with the SG pass port (one slot per regular cell).
    pub fn with_passes(
        cells: &'a mut [[[Scalar; 3]; 2]],
        passes: &'a mut [Option<SgPass>],
    ) -> Self {
        Self {
            cells,
            passes: Some(passes),
        }
    }
    /// One segment's part of an SG primary cell's single-pass law: its share
    /// of the fold conductance adds to the cell's; the inflow capacity rate is
    /// the cell's own (each segment reports the same). Refused (Fatal) where
    /// the caller composes no pass port.
    pub fn sg_pass(
        &mut self,
        cell: usize,
        conductance_w_k: Scalar,
        capacity_w_k: Scalar,
    ) -> Result<(), Failure> {
        let passes = self.passes.as_deref_mut().ok_or_else(|| {
            Failure::Fatal(format!(
                "an SG single-pass report for cell {cell} needs the network's pass port"
            ))
        })?;
        let slot = passes.get_mut(cell).ok_or_else(|| {
            Failure::Fatal(format!("SG pass of cell {cell} outside the regular cells"))
        })?;
        for v in [conductance_w_k, capacity_w_k] {
            if !(v.value.is_finite() && v.direction.is_finite()) {
                return Err(Failure::Recoverable(format!(
                    "nonfinite SG pass of cell {cell}"
                )));
            }
        }
        *slot = Some(match *slot {
            Some(p) => SgPass {
                conductance_w_k: p.conductance_w_k + conductance_w_k,
                capacity_w_k,
            },
            None => SgPass {
                conductance_w_k,
                capacity_w_k,
            },
        });
        Ok(())
    }
    pub fn cells(&self) -> usize {
        self.cells.len()
    }
    /// Add one receipt. A cell outside the regular cells or a nonfinite
    /// value is refused.
    pub fn add(
        &mut self,
        cell: usize,
        phase: usize,
        mass: Scalar,
        enthalpy: Scalar,
        tracer: Scalar,
    ) -> Result<(), Failure> {
        if cell >= self.cells.len() || phase > 1 {
            return Err(Failure::Fatal(format!(
                "receipt into cell {cell} phase {phase} outside the regular cells"
            )));
        }
        for v in [mass, enthalpy, tracer] {
            if !(v.value.is_finite() && v.direction.is_finite()) {
                return Err(Failure::Recoverable(format!(
                    "nonfinite receipt into cell {cell} phase {phase}"
                )));
            }
        }
        let r = &mut self.cells[cell][phase];
        r[0] = r[0] + mass;
        r[1] = r[1] + enthalpy;
        r[2] = r[2] + tracer;
        Ok(())
    }
    /// A non-advective liquid heat (W): the single heat port.
    pub fn heat(&mut self, cell: usize, heat_w: Scalar) -> Result<(), Failure> {
        self.add(cell, 0, s(0.), heat_w, s(0.))
    }
    pub fn get(&self, cell: usize, phase: usize) -> [Scalar; 3] {
        self.cells[cell][phase]
    }
}

/// Current fluid volume of one regular network cell and its rate.
#[derive(Clone, Copy, Debug)]
pub struct CellVolume {
    pub volume_m3: Scalar,
    pub rate_m3_s: Scalar,
}

/// An owner composed into one network evaluation.
pub trait Coupling {
    /// Called once per evaluation after every regular cell's state and every
    /// face chart is current, before any section, momentum or stock row.
    fn couple(&mut self, fluid: &Fluid<'_>, receipts: &mut Receipts<'_>) -> Result<(), Failure>;
    /// The stratified cell's boundary of this evaluation: heater and wall
    /// receipts, zone heat and the relief state, evaluated by the owner of
    /// the PZR metal and relief on `column`, the cell's column of the same
    /// evaluation (with its directions), and on the owner's own coordinates.
    /// Called once per evaluation, after [`Coupling::couple`] and every
    /// regular row, immediately before the cell's own rows.
    fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure>;
}

impl<P: Properties> Network<P> {
    /// R4-NCHEAD: each profiled SG primary cell and its port faces.
    pub fn profile_faces(&self) -> Vec<(usize, Vec<usize>)> {
        self.profiles
            .iter()
            .map(|q| (q.cell, q.faces().collect()))
            .collect()
    }
    /// The SG profile drives of the last evaluation, by face layout.
    pub fn profile_drive(&self) -> &[Scalar] {
        &self.profile_drive
    }
    /// Region pressure-reference elevations, packet order.
    pub fn elevations(&self) -> &[f64] {
        &self.elevations
    }
    /// The stratified cell's boundary with no coupled owner of the PZR metal
    /// and relief (S1, the network alone, and the preparations): no heater,
    /// wall or zone heat, and a declared relief held on its seat with no
    /// receiver composed, so it carries nothing and a lift refuses.
    pub fn uncoupled_pzr_boundary(&self) -> stratified::Boundary {
        let seated = self
            .stratified
            .parameters()
            .ports
            .iter()
            .any(|p| p.kind == stratified::PortKind::Relief)
            .then_some(stratified::ReliefState {
                lift: s(0.),
                back_pressure_pa: None,
            });
        stratified::Boundary {
            relief: seated,
            ..stratified::Boundary::closed()
        }
    }
    /// The coupling step of [`Network::evaluate_coupled`]: build the fluid
    /// view of this evaluation, let the coupling add its receipts, and add
    /// them to the network's face receipts.
    pub(super) fn couple(
        &mut self,
        coupling: &mut dyn Coupling,
        y: &[f64],
        seed: Option<&[f64]>,
        points: &[[Option<(Water, Water)>; 2]],
        phase_mass: &[Vec<Scalar>; 2],
    ) -> Result<(), Failure> {
        let n = self.pzr.cell;
        for (node, l) in self.cell_layout.iter().enumerate() {
            self.coupled_tracer[node] = rec(
                y[l.boron] * self.scales[l.boron],
                seed.map_or(0., |d| d[l.boron]) * self.scales[l.boron],
            );
        }
        self.coupled_receipts.fill([[s(0.); 3]; 2]);
        self.coupled_passes.fill(None);
        let fluid = Fluid {
            cells: &self.cells,
            points,
            liquid_mass: &phase_mass[0],
            vapor_mass: &phase_mass[1],
            tracer: &self.coupled_tracer,
            charts: &self.charts,
            endpoints: &self.endpoints,
            elevations: &self.elevations,
            volumes: &self.volumes,
            current_volumes: &self.cell_volume,
        };
        coupling.couple(
            &fluid,
            &mut Receipts::with_passes(
                &mut self.coupled_receipts[..n],
                &mut self.coupled_passes[..n],
            ),
        )?;
        for node in 0..n {
            for k in 0..2 {
                for j in 0..3 {
                    self.receipts[node][k][j] =
                        self.receipts[node][k][j] + self.coupled_receipts[node][k][j];
                }
            }
        }
        profile_drives(
            &self.profiles,
            &self.faces,
            &self.cells,
            points,
            &self.charts,
            &self.coupled_passes,
            &mut self.profile_drive,
        )
    }
}

/// Every SG profile's face drives of one evaluation into `out` (zeroed by
/// the caller; indexed by face layout): a profile composes where its cell's
/// coupled owner reported the pass. A pass for a cell with no compiled
/// profile refuses.
pub(super) fn profile_drives(
    profiles: &[SgProfile],
    faces: &[Face],
    cells: &[Cell],
    points: &[[Option<(Water, Water)>; 2]],
    charts: &[[Option<Chart>; 2]],
    passes: &[Option<SgPass>],
    out: &mut [Scalar],
) -> Result<(), Failure> {
    for (cell, p) in passes.iter().enumerate() {
        if p.is_some() && !profiles.iter().any(|q| q.cell == cell) {
            return Err(Failure::Fatal(format!(
                "an SG pass for cell {cell}, which has no compiled SG profile"
            )));
        }
    }
    for q in profiles {
        if let Some(pass) = passes[q.cell] {
            q.drives(faces, cells, points, charts, pass, out)?;
        }
    }
    Ok(())
}

/// R4-NCHEAD (`operating-hydraulics.md`: "a future spatial SG profile must
/// integrate its own current densities over that same geometry"): one SG
/// primary cell's port heads from its single-pass enthalpy profile along
/// the folded path.
///
/// Along the path from the donor end, `h(s) − mean = dh psi(s)` with
/// `psi = e^(−Ns/L)/(1 − e^(−N)) − 1/N` ([`FoldPath::profile_moments`]),
/// `N = UA/C` the cell's own single-pass number and `dh = h_in − h_cell`.
/// Density is linearised about the cell, `rho_h = (d rho/d h)_p = −rho
/// beta/cp`, so the deviation has zero mean and the cell's mass is
/// unchanged. The cell pressure stays the path-mean pressure (the uniform
/// cell's centroid reference is that mean), so the pressure deviation at
/// the path's start is `g rho_h dh (J0 − J1)` and at its end `−g rho_h dh
/// J1`. A face's SG segment head gains the deviation at its port, `+` where
/// the face enters the cell and `−` where it leaves. Inflow at both ends
/// weights the two orientations by their inflow mass, each with its own
/// donors' enthalpy; with no inflow the profile is absent (`C = 0`, and the
/// moments vanish continuously as `C` does).
#[derive(Clone, Debug)]
pub struct SgProfile {
    pub cell: usize,
    forward: FoldPath,
    reversed: FoldPath,
    /// `(face, port at the fold's start, the face enters the cell)`.
    ports: Vec<(usize, bool, bool)>,
}

/// Port elevation agreement with the fold's ends and centroid (m): the
/// packet's elevations are compiled from the same four values.
const FOLD_MATCH_M: f64 = 1e-9;

impl SgProfile {
    /// The profile of SG primary `cell` on `fold`: every face incident to the
    /// cell reaches it through exactly one pressure segment of the cell, whose
    /// port is one of the fold's ends; the cell's reference elevation is the
    /// fold's uniform centroid. Anything else refuses.
    pub fn compile(
        cell: usize,
        fold: FoldPath,
        faces: &[Face],
        elevations: &[f64],
        regular: usize,
    ) -> Result<Self, Failure> {
        let bad = |why: String| Failure::Fatal(format!("SG profile of cell {cell}: {why}"));
        if cell >= regular {
            return Err(bad("not a regular cell".into()));
        }
        let z_ref = *elevations
            .get(cell)
            .ok_or_else(|| bad("outside the regions".into()))?;
        if (z_ref - fold.centroid()).abs() > FOLD_MATCH_M {
            return Err(bad(format!(
                "reference elevation {z_ref} is not the fold's centroid {}",
                fold.centroid()
            )));
        }
        let mut ports = Vec::new();
        for (j, f) in faces.iter().enumerate() {
            let enters = f.to == cell;
            let incident = enters || f.from == cell;
            let own: Vec<_> = f
                .pressure_segments
                .iter()
                .filter(|p| p.region == cell)
                .collect();
            if !incident {
                if !own.is_empty() {
                    return Err(bad(format!("face {j} crosses the cell without a port")));
                }
                continue;
            }
            if f.from >= regular || f.to >= regular {
                return Err(bad(format!("face {j} reaches a cell with no regular point")));
            }
            let [segment] = own[..] else {
                return Err(bad(format!(
                    "face {j} needs exactly one pressure segment in the cell"
                )));
            };
            let z = if enters {
                z_ref - segment.elevation_change_m
            } else {
                z_ref + segment.elevation_change_m
            };
            let start = if (z - fold.inlet()).abs() <= FOLD_MATCH_M {
                true
            } else if (z - fold.outlet()).abs() <= FOLD_MATCH_M {
                false
            } else {
                return Err(bad(format!("face {j}'s port at {z} m is not a fold end")));
            };
            ports.push((j, start, enters));
        }
        if !ports.iter().any(|p| p.1) || ports.iter().all(|p| p.1) {
            return Err(bad("needs ports at both fold ends".into()));
        }
        Ok(Self {
            cell,
            reversed: fold.reversed().map_err(|e| bad(e.into()))?,
            forward: fold,
            ports,
        })
    }

    /// The faces whose heads this profile moves.
    pub fn faces(&self) -> impl Iterator<Item = usize> + '_ {
        self.ports.iter().map(|p| p.0)
    }

    /// Each port face's phase drives `[(layout 2 face + k, drive)]` of this
    /// evaluation into `out` (indexed by face layout), from the cell's and
    /// its donors' liquid points, the stage-one liquid charts and the pass.
    /// Every face of the profile is written, zero without inflow.
    pub fn drives(
        &self,
        faces: &[Face],
        cells: &[Cell],
        points: &[[Option<(Water, Water)>; 2]],
        charts: &[[Option<Chart>; 2]],
        pass: SgPass,
        out: &mut [Scalar],
    ) -> Result<(), Failure> {
        let trial = |why: &str| Failure::Recoverable(format!("SG profile of cell {}: {why}", self.cell));
        let liquid = |node: usize| {
            points[node][0].ok_or_else(|| trial("a port cell has no liquid point"))
        };
        if points[self.cell][1].is_some() {
            return Err(trial("the profile is a liquid cell's"));
        }
        let (q, d) = liquid(self.cell)?;
        let rho = rec(q.density_kg_m3, d.density_kg_m3);
        let rho_h = -(rho * rec(q.expansion_per_k, d.expansion_per_k))
            / rec(q.cp_j_kg_k, d.cp_j_kg_k);
        let h_cell = rec(q.enthalpy_j_kg, d.enthalpy_j_kg);
        // Inflow mass and donor enthalpy flow at each end (the solids' rule).
        let (mut m, mut mh) = ([s(0.); 2], [s(0.); 2]);
        for &(face, start, enters) in &self.ports {
            let flow = charts[face][0].map_or(s(0.), |c| c.mass_flow_kg_s);
            let f = &faces[face];
            let (donor, rate) = if enters && flow.value > 0. {
                (f.from, flow)
            } else if !enters && flow.value < 0. {
                (f.to, -flow)
            } else {
                continue;
            };
            let (dq, dd) = liquid(donor)?;
            let end = usize::from(!start);
            m[end] = m[end] + rate;
            mh[end] = mh[end] + rate * rec(dq.enthalpy_j_kg, dd.enthalpy_j_kg);
        }
        let total = m[0] + m[1];
        let mut delta = [s(0.); 2];
        if total.value > 0. {
            if !(pass.conductance_w_k.value > 0. && pass.capacity_w_k.value >= 0.) {
                return Err(trial("needs a positive conductance and a nonnegative capacity"));
            }
            let eps = pass.capacity_w_k / pass.conductance_w_k;
            let (f0, f1) = self.forward.profile_moments(eps).map_err(trial)?;
            let (r0, r1) = self.reversed.profile_moments(eps).map_err(trial)?;
            let k = s(G) * rho_h / total;
            let forward = mh[0] - m[0] * h_cell;
            let reversed = mh[1] - m[1] * h_cell;
            // Pressure deviation at the fold's start [0] and end [1].
            delta[0] = k * (forward * (f0 - f1) - reversed * r1);
            delta[1] = k * (reversed * (r0 - r1) - forward * f1);
        }
        for &(face, start, enters) in &self.ports {
            let at = delta[usize::from(!start)];
            let head = if enters { at } else { -at };
            let f = &faces[face];
            let length: f64 = f.pressure_segments.iter().map(|p| p.path_length_m).sum();
            for k in 0..2 {
                let mut share = s(0.);
                for p in &f.pressure_segments {
                    if let Some(a) = cells[p.region].phase[k] {
                        share = share + a.fraction * s(p.path_length_m / length);
                    }
                }
                let drive = -(head * share);
                if !(drive.value.is_finite() && drive.direction.is_finite()) {
                    return Err(trial("nonfinite drive"));
                }
                out[2 * face + k] = drive;
            }
        }
        Ok(())
    }
}

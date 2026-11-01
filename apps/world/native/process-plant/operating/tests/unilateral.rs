//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0014-stratified-pzr-cell.md#l1-unilateral-absent-donor-law
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#l1-unilateral-absent-donor-law-implemented-at-s3
//! L1 (decision 0014's unilateral absent-donor law) on the composed network,
//! one test per element of the law: lock state per path, `Pi/s = 0` rows,
//! no transport while locked, the reaction reported, release and contact
//! roots, the kinetic energy paid once, exact conservation across the
//! transactions, copy/restore, and the block assembly equal to the colored
//! one with L1 active. On `network_blocks.rs`'s synthetic packet and
//! analytic two-branch property model, copied (as that file copied
//! `network_prepare.rs`'s): neither is LD-01 plant data, a water
//! formulation or qualification evidence. Phase presence is declared here
//! as the phase-mode owner would declare it.
use leitbild_operating_plant::{
    hydraulics::{Pump as Impeller, Section, WallLaw},
    local_flow::{MomentumSupport, PressureSegment},
    network::{
        Band, BandReport, CellMode, ConsistentSystem, Failure, MetastableBand, Network, Properties,
        RotorState, Tolerances, Water, consistent_start,
        packet::*,
        phase_events::{Ledger, Root, located},
        prepare::{OperatingPoint, Settings, prepare},
        stratified::{Band as FreeArea, Heaters, Metastable, PortKind, Stratified, Tap},
        unilateral::{Cause, Fired, Holding, Lock, Locks, Presence},
    },
    rotor::{Shaft, SpeedRequest, Support},
    sparse::Pattern,
    thermal::{Saturation, Scalar, WaterPoint},
};

const G: f64 = 9.80665;
// Analytic chart: compressible liquid with expansion, ideal-gas vapor and a
// Clausius-Clapeyron saturation line. Values are synthetic.
const P0: f64 = 15.5e6;
const T0: f64 = 600.;
const RHO0: f64 = 650.;
const KAPPA: f64 = 1.5e-9;
const BETA: f64 = 3e-3;
const CL: f64 = 5500.;
const U0L: f64 = 1.5e6;
const R: f64 = 461.5;
const CV: f64 = 3000.;
const U0V: f64 = 2.5e6;
const TSAT0: f64 = 617.;
const LATENT: f64 = 1e6;

fn liquid(p: f64, t: f64) -> Water {
    let density = RHO0 * (KAPPA * (p - P0) - BETA * (t - T0)).exp();
    let u = U0L + CL * (t - T0);
    Water {
        pressure_pa: p,
        temperature_k: t,
        density_kg_m3: density,
        internal_energy_j_kg: u,
        enthalpy_j_kg: u + p / density,
        cp_j_kg_k: CL + p * BETA / density,
        expansion_per_k: BETA,
        compressibility_per_pa: KAPPA,
        viscosity_pa_s: 9e-5,
        conductivity_w_m_k: 0.5,
    }
}
fn vapor(p: f64, t: f64) -> Water {
    let u = U0V + CV * (t - T0);
    Water {
        pressure_pa: p,
        temperature_k: t,
        density_kg_m3: p / (R * t),
        internal_energy_j_kg: u,
        enthalpy_j_kg: u + R * t,
        cp_j_kg_k: CV + R,
        expansion_per_k: 1. / t,
        compressibility_per_pa: 1. / p,
        viscosity_pa_s: 2e-5,
        conductivity_w_m_k: 0.08,
    }
}
/// Exact directional derivative of every field along (dp, dT).
fn along(vapor_branch: bool, w: &Water, dp: f64, dt: f64) -> Water {
    let (p, t, rho) = (w.pressure_pa, w.temperature_k, w.density_kg_m3);
    if vapor_branch {
        let drho = dp / (R * t) - p * dt / (R * t * t);
        Water {
            pressure_pa: dp,
            temperature_k: dt,
            density_kg_m3: drho,
            internal_energy_j_kg: CV * dt,
            enthalpy_j_kg: (CV + R) * dt,
            cp_j_kg_k: 0.,
            expansion_per_k: -dt / (t * t),
            compressibility_per_pa: -dp / (p * p),
            viscosity_pa_s: 0.,
            conductivity_w_m_k: 0.,
        }
    } else {
        let drho = rho * (KAPPA * dp - BETA * dt);
        Water {
            pressure_pa: dp,
            temperature_k: dt,
            density_kg_m3: drho,
            internal_energy_j_kg: CL * dt,
            enthalpy_j_kg: CL * dt + dp / rho - p * drho / (rho * rho),
            cp_j_kg_k: BETA * dp / rho - p * BETA * drho / (rho * rho),
            expansion_per_k: 0.,
            compressibility_per_pa: 0.,
            viscosity_pa_s: 0.,
            conductivity_w_m_k: 0.,
        }
    }
}
fn saturation_temperature(p: f64) -> f64 {
    1. / (1. / TSAT0 - R / LATENT * (p / P0).ln())
}

/// Differentiable test properties on internal-energy targets.
#[derive(Clone, Copy)]
struct Analytic;
impl Properties for Analytic {
    /// The branch and the forward point.
    type Caloric = (bool, Water);
    fn forward(&self, vapor_branch: bool, p: f64, t: f64) -> Result<Water, String> {
        Ok(if vapor_branch {
            vapor(p, t)
        } else {
            liquid(p, t)
        })
    }
    fn caloric(
        &self,
        vapor_branch: bool,
        p: f64,
        u: f64,
        enthalpy: bool,
    ) -> Result<(bool, Water), String> {
        if enthalpy || !(p.is_finite() && p > 0. && u.is_finite()) {
            return Err("outside the analytic fixture".into());
        }
        let t = if vapor_branch {
            T0 + (u - U0V) / CV
        } else {
            T0 + (u - U0L) / CL
        };
        Ok((vapor_branch, self.forward(vapor_branch, p, t)?))
    }
    fn values(&self, point: &(bool, Water)) -> Water {
        point.1
    }
    fn direction(&self, point: &(bool, Water), dp: f64, du: f64) -> Result<Water, String> {
        let dt = du / if point.0 { CV } else { CL };
        Ok(along(point.0, &point.1, dp, dt))
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        let p = pressure.value;
        let t = saturation_temperature(p);
        let dp = pressure.direction;
        let dt = t * t * R / LATENT / p * dp;
        let point = |vapor_branch: bool| {
            let w = if vapor_branch {
                vapor(p, t)
            } else {
                liquid(p, t)
            };
            let d = along(vapor_branch, &w, dp, dt);
            let f = Scalar::new;
            WaterPoint {
                density: f(w.density_kg_m3, d.density_kg_m3),
                viscosity: f(w.viscosity_pa_s, d.viscosity_pa_s),
                conductivity: f(w.conductivity_w_m_k, d.conductivity_w_m_k),
                cp: f(w.cp_j_kg_k, d.cp_j_kg_k),
                expansion: f(w.expansion_per_k, d.expansion_per_k),
                enthalpy: f(w.enthalpy_j_kg, d.enthalpy_j_kg),
            }
        };
        Ok(Saturation {
            temperature: Scalar::new(t, dt),
            liquid: point(false),
            vapor: point(true),
            surface_tension: Scalar::constant(4e-3),
        })
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        Ok(BAND)
    }
    fn band(&self, point: &(bool, Water)) -> BandReport {
        let departure_k = point.1.temperature_k - saturation_temperature(point.1.pressure_pa);
        BandReport {
            departure_k,
            band: Band::Stable,
        }
    }
}

/// Synthetic band shared by the fixture properties and packet.
const BAND: MetastableBand = MetastableBand {
    pressure_range_pa: [2e6, 16e6],
    lower_bound_exclusive: true,
    liquid_superheat_max_k: 2.,
    vapor_subcooling_max_k: 1.4,
    trial_max_k: 3.,
    credited_max_k: 0.5,
    liquid_temperature_max_k: 623.15,
    liquid_pressure_ceiling_pa: 17e6,
    vapor_pressure_ceiling_pa: 16e6,
};

const AUTHORED_PA: f64 = 15.6e6;
const TRACER_PER_KG: f64 = 1e-3;
const SURGE: usize = 4;
const PZR: usize = 5;
/// Free-area integral of the fixture's PZR cell: 1 m at 2.9 m2, 9 m at 3 m2.
const PZR_VOLUME: f64 = 29.9;

fn surge_port() -> PzrPort {
    PzrPort {
        id: "PZR.SURGE.MOUTH".into(),
        kind: PortKind::Surge,
        elevation_m: 10.,
        face: Some(5),
        bore_m: 0.25,
        relief: None,
    }
}

fn segment(region: usize, length: f64, rise: f64) -> PressureSegment {
    PressureSegment {
        region,
        path_length_m: length,
        elevation_change_m: rise,
    }
}
fn support(region: usize, length: f64, area: f64) -> MomentumSupport {
    MomentumSupport {
        region,
        path_length_m: length,
        inverse_area_length_per_m: length / area,
        volume_m3: length * area,
    }
}
/// Two halves `(length, rise)`, one in each endpoint volume.
fn face(id: String, from: usize, to: usize, area: f64, halves: [(f64, f64); 2]) -> FacePacket {
    FacePacket {
        id,
        from,
        to,
        flow_area_m2: area,
        supports: vec![
            support(from, halves[0].0, area),
            support(to, halves[1].0, area),
        ],
        pressure_segments: vec![
            segment(from, halves[0].0, halves[0].1),
            segment(to, halves[1].0, halves[1].1),
        ],
    }
}

/// Four primary volumes in one loop (core, hot side, SG, cold side with a
/// pump section) at nonuniform temperature, a SURGE line volume and the one
/// stratified PZR cell (10..20 m, uniform 3 m2). Face 5 is the port face:
/// SURGE supports and segments only, ending at the 10 m mouth.
fn packet() -> Packet {
    let primary = [
        ("CORE", 20., 0., 590.),
        ("HOT", 10., 6., 610.),
        ("SG", 15., 8., 575.),
        ("COLD", 10., 1., 565.),
    ];
    let mut regions: Vec<Region> = primary
        .iter()
        .map(|(id, volume, elevation, _)| Region {
            id: (*id).into(),
            volume_m3: *volume,
            elevation_m: *elevation,
        })
        .collect();
    let water: Vec<WaterOwner> = primary
        .iter()
        .map(|(_, volume, _, t)| {
            let w = liquid(AUTHORED_PA, *t);
            WaterOwner {
                pressure_pa: AUTHORED_PA,
                temperature_k: *t,
                mass_kg: volume * w.density_kg_m3,
                energy_j: volume * w.density_kg_m3 * w.internal_energy_j_kg,
            }
        })
        .collect();
    let boron = water.iter().map(|w| TRACER_PER_KG * w.mass_kg).collect();
    regions.push(Region {
        id: "SURGE".into(),
        volume_m3: 0.8,
        elevation_m: 9.,
    });
    regions.push(Region {
        id: "PZR".into(),
        volume_m3: PZR_VOLUME,
        elevation_m: 20.,
    });
    let surge_water = liquid(AUTHORED_PA, 605.);
    let surge_mass = 0.8 * surge_water.density_kg_m3;
    let faces = vec![
        face("CORE->HOT".into(), 0, 1, 0.5, [(3., 3.), (3., 3.)]),
        face("HOT->SG".into(), 1, 2, 0.5, [(4., 1.), (4., 1.)]),
        face("SG->COLD".into(), 2, 3, 0.5, [(4., -3.5), (4., -3.5)]),
        face("COLD->CORE".into(), 3, 0, 0.3, [(2., -0.5), (2., -0.5)]),
        face("HOT->SURGE".into(), 1, SURGE, 0.05, [(2., 1.5), (2., 1.5)]),
        FacePacket {
            id: "SURGE->PZR.SURGE.MOUTH".into(),
            from: SURGE,
            to: PZR,
            flow_area_m2: 0.05,
            supports: vec![support(SURGE, 2., 0.05)],
            pressure_segments: vec![segment(SURGE, 2., 1.)],
        },
    ];
    Packet {
        pzr_spray: None,
        secondary: None,
        mechanics: Mechanics {
            regions,
            faces,
            force_projection: Vec::new(),
            section_force_projection: vec![SectionProjection {
                face: 3,
                section: 0,
                coefficient: 1.,
            }],
        },
        thermal: Thermal {
            water,
            sg_segments: Vec::new(),
        },
        water_boron_amount_kg_eq: boron,
        external_ports: ExternalPorts {
            surge_stock: SurgeStock {
                pressure_pa: AUTHORED_PA,
                temperature_k: 605.,
                mass_kg: surge_mass,
                internal_energy_j: surge_mass * surge_water.internal_energy_j_kg,
                absorber_tracer_kg_eq: TRACER_PER_KG * surge_mass,
            },
            spray_stock: None,
            spray_path: None,
        },
        pzr: Pzr {
            cell: PzrCell {
                index: PZR,
                bottom_m: 10.,
                top_m: 20.,
                fluid_volume_m3: PZR_VOLUME,
                free_area: vec![
                    FreeArea {
                        from_m: 10.,
                        to_m: 11.,
                        area_m2: 2.9,
                    },
                    FreeArea {
                        from_m: 11.,
                        to_m: 20.,
                        area_m2: 3.,
                    },
                ],
                ports: vec![surge_port()],
                taps: [("PT1", 20.), ("LT.LOW", 10.), ("LT.HIGH", 20.)]
                    .map(|(id, elevation_m)| Tap {
                        id: id.into(),
                        elevation_m,
                    })
                    .to_vec(),
                heaters: Heaters {
                    bottom_m: 10.,
                    top_m: 11.,
                    displacement_m3: 0.1,
                },
                stratified: Stratified {
                    withdrawal_scale_m: 0.25,
                    admitted_preparation_thickness_m: 0.25,
                    inversion_exchange_velocity_m_s: 300.,
                    liquid_relaxation_time_s: 0.3,
                    vapor_relaxation_time_s: 0.5,
                    relaxation_sensitivity: [0.5, 1., 2.],
                    bubble_diameter_m: 0.00075,
                    bubble_exchange_sensitivity: [0.5, 1., 2.],
                    bubble_exchange_diameter_sensitivity_m: 0.0005,
                    spray_drop_diameter_m: 0.003,
                    drop_diameter_sensitivity_m: [0.0015, 0.003, 0.006],
                    resolvability_factor: 1000.,
                },
                metastable: Metastable {
                    pressure_range_pa: BAND.pressure_range_pa,
                    lower_bound_exclusive: BAND.lower_bound_exclusive,
                    liquid_superheat_max_k: BAND.liquid_superheat_max_k,
                    vapor_subcooling_max_k: BAND.vapor_subcooling_max_k,
                    trial_max_k: BAND.trial_max_k,
                    credited_max_k: BAND.credited_max_k,
                    liquid_temperature_max_k: BAND.liquid_temperature_max_k,
                    liquid_pressure_ceiling_pa: BAND.liquid_pressure_ceiling_pa,
                    vapor_pressure_ceiling_pa: BAND.vapor_pressure_ceiling_pa,
                },
                absorber_mass_fraction: TRACER_PER_KG,
                interfacial_length_m: 0.003,
            },
        },
        hydraulics: Hydraulics {
            pump: Pump {
                rotor_inertia_kg_m2: 500.,
                drag_nm_per_rad_s: 0.2,
                reference_omega_rad_s: 150.,
                nominal_fluid_power_w: 1e6,
                drive_tracking_time_s: 5.,
                drive_torque_cap_factor: 1.5,
                drive_efficiency: 0.96,
            },
            sections: vec![SectionEntry {
                region: 3,
                parameters: Section {
                    length_m: 2.,
                    area_m2: 0.3,
                    hydraulic_diameter_m: 0.,
                    elevation_change_m: -0.5,
                    gravity_m_s2: G,
                    wall: WallLaw::None,
                    form_loss: 0.5,
                    grid_count: 0,
                    grid_factor: 0.,
                    blockage_fraction: 0.,
                    pump: Some(Impeller {
                        a: 2.,
                        b: 0.5,
                        resistance: 0.1,
                        mixed_degradation_depth: 0.,
                    }),
                },
            }],
        },
        preparation: Preparation {
            operating_point: leitbild_operating_plant::network::packet::OperatingPoint {
                pzr_roof_pressure_pa: 15.5e6,
                pzr_roof_elevation_m: 20.,
                pzr_level_m: 6.,
                pzr_bottom_elevation_m: 10.,
                rcp_speed_request: "nominal".into(),
            },
        },
    }
}

const RUNNING: RotorState = RotorState {
    support: Support::Supported(SpeedRequest::Nominal),
    shaft: Shaft::Free,
};
const SETTINGS: Settings = Settings {
    pressure_tolerance_pa: 1e-6,
    max_passes: 30,
    level_match_m: 1e-9,
    eos_row_bound: 1e-12,
    tree_face_bound_pa: 1e-6,
    representation_search: 4,
};
fn prepared() -> (Network<Analytic>, Vec<f64>, Vec<f64>) {
    let point = OperatingPoint {
        pzr_level_m: 6.,
        ..OperatingPoint::from(&packet().preparation.operating_point)
    };
    let (network, prepared, _) = prepare(&packet(), Analytic, &point, &[RUNNING], &SETTINGS)
        .unwrap_or_else(|e| panic!("{e:?}"));
    (network, prepared.y, prepared.yp)
}

/// Largest |block - colored| over each column's largest entry.
fn column_relative(pattern: &Pattern, a: &[f64], b: &[f64]) -> f64 {
    let mut worst = 0_f64;
    for j in 0..pattern.columns() {
        let range = pattern.pointers()[j]..pattern.pointers()[j + 1];
        let scale = range
            .clone()
            .map(|p| a[p].abs().max(b[p].abs()))
            .fold(0., f64::max);
        for p in range {
            if a[p] != b[p] {
                worst = worst.max((a[p] - b[p]).abs() / scale);
            }
        }
    }
    worst
}

/// Both assemblies at one state; returns the comparison.
fn both(network: &mut Network<Analytic>, cj: f64, y: &[f64], yp: &[f64]) -> f64 {
    let colored = network.sparse_jacobian().unwrap();
    let blocks = network.block_jacobian().unwrap();
    assert_eq!(colored.pattern, blocks.pattern);
    let mut c = vec![0.; colored.pattern.nonzeros()];
    let mut b = vec![0.; c.len()];
    network
        .jacobian_colored(0., cj, y, yp, &colored, &mut c)
        .expect("colored");
    network
        .jacobian_blocks(0., cj, y, yp, &blocks, &mut b)
        .expect("blocks");
    assert!(b.iter().all(|v| v.is_finite()));
    column_relative(&blocks.pattern, &b, &c)
}

fn prepared_ids() -> (Network<Analytic>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let point = OperatingPoint {
        pzr_level_m: 6.,
        ..OperatingPoint::from(&packet().preparation.operating_point)
    };
    let (network, prepared, _) = prepare(&packet(), Analytic, &point, &[RUNNING], &SETTINGS)
        .unwrap_or_else(|e| panic!("{e:?}"));
    (network, prepared.y, prepared.yp, prepared.differential)
}

/// Loop flow on every liquid path, an outsurge at the port face and one
/// exactly stagnant face (`network_blocks.rs`'s flowing state).
fn flowing(network: &Network<Analytic>, y: &mut [f64]) {
    for l in &network.face_layout {
        if l.phase == 0 {
            y[l.index] = match l.face {
                4 => 0.,
                5 => -0.05,
                _ => 0.2,
            };
        }
    }
}

fn values(network: &Network<Analytic>) -> Vec<f64> {
    network.rows().iter().map(|r| r.value).collect()
}

/// Physical totals of the regular cells' masses, tracers and energies, in
/// that order (no payment enters the stratified cell here).
fn totals(network: &Network<Analytic>, y: &[f64]) -> [f64; 3] {
    let sc = network.scales();
    let mut out = [0.; 3];
    for l in &network.cell_layout {
        for k in 0..2 {
            out[0] += y[l.mass[k]] * sc[l.mass[k]];
            out[2] += y[l.energy[k]] * sc[l.energy[k]];
        }
        out[1] += y[l.boron] * sc[l.boron];
    }
    out
}

fn activated(y: &[f64], yp: &[f64]) -> Network<Analytic> {
    let (mut network, _, _) = prepared();
    network.evaluate(0., y, yp, None, 0., None).unwrap();
    let presence = network.stock_presence(y);
    network.activate_unilateral(&presence).expect("activation");
    network
}

#[test]
fn activation_locks_every_vapor_path_of_a_liquid_network_and_leaves_its_residual_bitwise() {
    let (mut network, y, yp, prepared_ids) = prepared_ids();
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let before = values(&network);
    let ids_before = network.differential(&prepared_ids);
    let presence = network.stock_presence(&y);
    // Every regular cell and the port hold liquid, none vapor.
    assert!(presence.cells.iter().all(|c| c[0] && !c[1]));
    let tx = network.activate_unilateral(&presence).expect("activation");
    let layout = network.face_layout.clone();
    assert_eq!(tx.changes.len(), network.face_count());
    assert!(tx.changes.iter().all(|c| c.phase == 1
        && c.cause == Cause::AtRest
        && c.after == Lock::Locked(Holding::Neither)
        && c.payment.is_none()));
    assert_eq!(tx.energy_paid_j, 0.);
    let locks = network.unilateral().unwrap().clone();
    for (li, l) in layout.iter().enumerate() {
        assert_eq!(locks.is_locked(li), l.phase == 1, "path {li}");
    }
    // The locked rows are `Pi/s` of an exactly zero impulse: the residual
    // at the prepared state is bitwise the one before L1.
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    assert_eq!(values(&network), before);
    // Ids: every vapor impulse algebraic, nothing else changed.
    let ids = network.differential(&prepared_ids);
    for (i, (a, b)) in ids.iter().zip(&ids_before).enumerate() {
        let vapor_impulse = layout.iter().any(|l| l.phase == 1 && l.index == i);
        assert_eq!(*a, if vapor_impulse { 0. } else { *b }, "coordinate {i}");
    }
    // Roots: a contact root on every free (liquid) path, no release root
    // (no vapor path has a holding end); contact values are donor masses.
    let roots = network.unilateral_roots();
    assert_eq!(roots.len(), network.face_count());
    assert!(
        roots
            .iter()
            .all(|r| matches!(r, Root::Contact(li) if li % 2 == 0))
    );
    let mut out = vec![0.; roots.len()];
    network
        .unilateral_root_values(&y, &roots, &mut out)
        .unwrap();
    assert!(out.iter().all(|v| *v > 0.), "{out:?}");
    assert_eq!(network.unilateral_phantom_m3_s(), 0.);
}

#[test]
fn the_block_assembly_equals_the_colored_one_with_l1_active() {
    let (_, mut y, yp) = prepared();
    let mut network = activated(&y, &yp);
    for cj in [1e-2, 10., 1e4] {
        let difference = both(&mut network, cj, &y, &yp);
        assert!(difference <= 1e-13, "rest, cj {cj}: {difference}");
    }
    flowing(&network, &mut y);
    let yp: Vec<f64> = (0..y.len()).map(|i| 1e-4 * ((i % 7) as f64 - 3.)).collect();
    let difference = both(&mut network, 25., &y, &yp);
    assert!(difference <= 1e-13, "flowing: {difference}");
    // A locked liquid path (a declared lock, at rest): its column holds
    // only its own row's `1/s`, in both assemblies.
    let li = 2; // face 1, liquid
    let mut locks = network.unilateral().unwrap().clone();
    locks.paths[li] = Lock::Locked(Holding::From);
    network.restore_unilateral(locks).unwrap();
    let column = network.face_layout[li].index;
    y[column] = 0.;
    let difference = both(&mut network, 25., &y, &yp);
    assert!(difference <= 1e-13, "locked liquid path: {difference}");
    let blocks = network.block_jacobian().unwrap();
    let mut b = vec![0.; blocks.pattern.nonzeros()];
    network
        .jacobian_blocks(0., 25., &y, &yp, &blocks, &mut b)
        .unwrap();
    let range = blocks.pattern.pointers()[column]..blocks.pattern.pointers()[column + 1];
    for p in range {
        let row = blocks.pattern.indices()[p];
        let expected = if row == column { 1. } else { 0. };
        assert_eq!(b[p], expected, "locked column {column}, row {row}");
    }
}

#[test]
fn a_locked_path_transports_nothing_in_any_trial_and_reports_its_drive() {
    let (_, mut y, yp) = prepared();
    flowing(&activated(&y, &yp), &mut y);
    let mut network = activated(&y, &yp);
    let li = 2; // face 1, liquid, flowing
    let l = network.face_layout[li];
    let mut locks = network.unilateral().unwrap().clone();
    locks.paths[li] = Lock::Locked(Holding::From);
    network.restore_unilateral(locks).unwrap();
    y[l.index] = 0.;
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let at_rest = values(&network);
    let drive = network.face_drive(l.face, 0).value;
    // A Newton trial with a nonzero locked impulse moves its own row only.
    let mut trial = y.clone();
    trial[l.index] = 0.37;
    let seed: Vec<f64> = (0..y.len())
        .map(|i| if i == l.index { 1. } else { 0. })
        .collect();
    network
        .evaluate(0., &trial, &yp, Some(&seed), 3., None)
        .unwrap();
    let chart = network.chart(l.face, 0).unwrap();
    for v in [
        chart.volume_flow_m3_s,
        chart.mass_flow_kg_s,
        chart.enthalpy_flow_w,
        chart.boron_flow_kg_s,
        chart.kinetic_j,
    ] {
        assert_eq!((v.value, v.direction), (0., 0.));
    }
    for (i, (r, a)) in network.rows().iter().zip(&at_rest).enumerate() {
        if i == l.index {
            let expected = Scalar::new(0.37 * network.scales()[i], network.scales()[i])
                / Scalar::constant(network.scales()[i]);
            assert_eq!((r.value, r.direction), (expected.value, expected.direction));
            assert!(
                (r.value - 0.37).abs() <= 4. * f64::EPSILON
                    && (r.direction - 1.).abs() <= 4. * f64::EPSILON,
                "locked row is Pi/s"
            );
        } else {
            assert_eq!((r.value, r.direction), (*a, 0.), "row {i}");
        }
    }
    // The reaction is the drive the lock resists.
    assert_eq!(network.face_drive(l.face, 0).value, drive);
    assert!(network.unilateral_reactions().contains(&(l.face, 0, drive)));
    assert_eq!(network.unilateral_phantom_m3_s(), 0.);
}

#[test]
fn contact_locks_pays_the_kinetic_energy_once_and_conserves_mass_and_tracer_bitwise() {
    let (_, mut y, yp) = prepared();
    flowing(&activated(&y, &yp), &mut y);
    let mut network = activated(&y, &yp);
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    // Face 1 (HOT->SG) carries liquid out of HOT. The phase-mode owner
    // declares HOT dry (its dryout transaction): the contact root of face
    // 1's liquid path is located.
    let li = 2;
    let l = network.face_layout[li];
    let (from, to) = (1, 2);
    let chart = network.chart(l.face, 0).unwrap();
    assert!(chart.volume_flow_m3_s.value > 0.);
    let kinetic = chart.kinetic_j.value;
    assert!(kinetic > 0.);
    let mut presence = network.stock_presence(&y);
    presence.cells[from][0] = false;
    let roots = network.unilateral_roots();
    let index = roots.iter().position(|r| *r == Root::Contact(li)).unwrap();
    let mut directions = vec![0; roots.len()];
    directions[index] = -1;
    let (fired, opposite) = located(&roots, &directions);
    assert!(opposite.is_empty());
    let before = y.clone();
    let [mass, tracer, energy] = totals(&network, &y);
    let tx = network
        .unilateral_transaction(&mut y, &presence, &fired, None)
        .expect("contact");
    // Face 1 by its root, and every other liquid path drawing from HOT
    // (the surge face 4 is stagnant: it locks at rest, paying nothing).
    let contact = tx.changes.iter().find(|c| c.path == li).unwrap();
    assert_eq!(contact.cause, Cause::ContactRoot);
    assert_eq!(contact.after, Lock::Locked(Holding::To));
    let receiver_energy = network.cell_layout[to].energy[0];
    assert_eq!(contact.payment, Some((to, receiver_energy, kinetic)));
    for c in &tx.changes {
        let (f, t) = (
            packet().mechanics.faces[c.face].from,
            packet().mechanics.faces[c.face].to,
        );
        assert!(c.phase == 0 && (f == from || t == from), "{c:?}");
    }
    assert_eq!(y[l.index], 0.);
    // Mass and tracer bitwise; energy grows by exactly what was paid, up to
    // the one rounding of each payment's addition.
    let [mass_after, tracer_after, energy_after] = totals(&network, &y);
    assert_eq!((mass_after, tracer_after), (mass, tracer));
    let paid: f64 = tx
        .changes
        .iter()
        .filter_map(|c| c.payment.map(|p| p.2))
        .sum();
    assert_eq!(paid, tx.energy_paid_j);
    let closure = (energy_after - energy) - paid;
    assert!(
        closure.abs() <= 4. * f64::EPSILON * energy.abs(),
        "energy closure {closure} J"
    );
    // Only the paying paths' impulses and their receivers' energies moved.
    let mut moved: Vec<usize> = Vec::new();
    for c in &tx.changes {
        if let Some((_, coordinate, _)) = c.payment {
            moved.extend([coordinate, network.face_layout[c.path].index]);
        }
    }
    for (i, (a, b)) in y.iter().zip(&before).enumerate() {
        if !moved.contains(&i) {
            assert_eq!(a.to_bits(), b.to_bits(), "coordinate {i} moved");
        }
    }
    // Paid once: the next transaction at the same declaration pays nothing.
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let again = network
        .unilateral_transaction(&mut y, &presence, &[], None)
        .unwrap();
    assert_eq!(again.energy_paid_j, 0.);
    assert!(again.changes.iter().all(|c| c.payment.is_none()));
    let mut ledger = Ledger::default();
    ledger.record(1., &roots, &fired, &opposite, &tx);
    ledger.record(1.5, &[], &[], &[], &again);
    assert_eq!(ledger.located["contact"], 1);
    assert_eq!(ledger.energy_paid_j, paid);
}

#[test]
fn release_by_a_birth_and_by_its_root_moves_no_coordinate() {
    let (_, mut y, yp) = prepared();
    let mut network = activated(&y, &yp);
    let li = 3; // face 1 (HOT->SG), vapor: locked with neither end holding
    let lj = 1; // face 0 (CORE->HOT), vapor
    assert_eq!(
        network.unilateral().unwrap().paths[li],
        Lock::Locked(Holding::Neither)
    );
    let before = y.clone();
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    // A birth in HOT (declared by the phase-mode owner): its vapor paths
    // become one-sided and stay held at zero drive, now with release roots.
    let mut presence = network.stock_presence(&y);
    presence.cells[1][1] = true;
    let tx = network
        .unilateral_transaction(&mut y, &presence, &[], None)
        .unwrap();
    assert!(tx.changes.is_empty(), "{tx:?}");
    assert_eq!(
        network.unilateral().unwrap().paths[li],
        Lock::Locked(Holding::From)
    );
    assert_eq!(
        network.unilateral().unwrap().paths[lj],
        Lock::Locked(Holding::To)
    );
    // A birth in CORE too: face 0's vapor path has both ends holding and is
    // released, whatever its drive.
    presence.cells[0][1] = true;
    let tx = network
        .unilateral_transaction(&mut y, &presence, &[], None)
        .unwrap();
    let birth = tx.changes.iter().find(|c| c.path == lj).unwrap();
    assert_eq!((birth.after, birth.cause), (Lock::Free, Cause::Birth));
    assert_eq!(
        network.unilateral().unwrap().paths[li],
        Lock::Locked(Holding::From)
    );
    // Face 1's release root reads its drive; located, it frees the path.
    let roots = network.unilateral_roots();
    let index = roots
        .iter()
        .position(|r| *r == Root::Release(li))
        .expect("release root");
    let mut out = vec![0.; roots.len()];
    network
        .unilateral_root_values(&y, &roots, &mut out)
        .unwrap();
    assert_eq!(out[index], network.face_drive(1, 1).value);
    let mut directions = vec![0; roots.len()];
    directions[index] = 1;
    let (fired, opposite) = located(&roots, &directions);
    assert!(opposite.is_empty());
    let tx = network
        .unilateral_transaction(&mut y, &presence, &fired, None)
        .unwrap();
    let release = tx.changes.iter().find(|c| c.path == li).unwrap();
    assert_eq!(
        (release.after, release.cause),
        (Lock::Free, Cause::DriveRoot)
    );
    // No coordinate moved in any of the three transactions.
    assert!(
        y.iter()
            .zip(&before)
            .all(|(a, b)| a.to_bits() == b.to_bits())
    );
    // The crossing against the declared direction does not act.
    let roots = network.unilateral_roots();
    let directions: Vec<i32> = roots.iter().map(|r| -r.direction()).collect();
    let (fired, opposite) = located(&roots, &directions);
    assert!(fired.is_empty());
    assert_eq!(opposite.len(), roots.len());
}

#[test]
fn the_lock_table_copies_and_restores_bitwise_and_refuses_a_foreign_one() {
    let (_, mut y, yp) = prepared();
    flowing(&activated(&y, &yp), &mut y);
    let mut network = activated(&y, &yp);
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let copy: Locks = network.unilateral().unwrap().clone();
    let rows = values(&network);
    let mut other = copy.clone();
    other.paths[2] = Lock::Locked(Holding::From);
    network.restore_unilateral(other).unwrap();
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    assert_ne!(values(&network), rows);
    network.restore_unilateral(copy).unwrap();
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    assert_eq!(values(&network), rows);
    assert!(
        network
            .restore_unilateral(Locks {
                paths: vec![Lock::Free; 3]
            })
            .is_err()
    );
    // A declared presence of the wrong size refuses.
    assert!(
        network
            .unilateral_transaction(
                &mut y,
                &Presence {
                    cells: vec![[true; 2]]
                },
                &[],
                None
            )
            .is_err()
    );
}

#[test]
fn a_contact_root_whose_donor_is_still_declared_present_refuses() {
    let (_, mut y, yp) = prepared();
    flowing(&activated(&y, &yp), &mut y);
    let mut network = activated(&y, &yp);
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let presence = network.stock_presence(&y);
    let before = network.unilateral().unwrap().clone();
    let e = network.unilateral_transaction(&mut y, &presence, &[(2, Fired::Contact)], None);
    assert!(e.is_err());
    // A refused transaction leaves the lock table unchanged.
    assert_eq!(network.unilateral().unwrap(), &before);
}

#[test]
fn a_one_sided_lock_drawing_from_its_holding_end_at_the_start_is_released_with_its_free_rate() {
    // DR S3-REBIRTH: after a restart's consistent start a one-sided lock
    // whose drive already draws from its holding end is released, its
    // impulse rate set to the free row's; the opposite orientation holds.
    let (_, mut y, _) = prepared();
    flowing(&activated(&y, &vec![0.; y.len()]), &mut y);
    let mut network = activated(&y, &vec![0.; y.len()]);
    let li = 2; // face 1, liquid
    let l = network.face_layout[li];
    y[l.index] = 0.;
    network
        .evaluate(0., &y, &vec![0.; y.len()], None, 0., None)
        .unwrap();
    let drive = network.face_drive(l.face, 0).value;
    assert!(drive != 0.);
    // `From` holding draws from `from` when F > 0; choose the orientation
    // that the drive releases and the one it holds.
    let (releasing, holding) = if drive > 0. {
        (Holding::From, Holding::To)
    } else {
        (Holding::To, Holding::From)
    };
    for (h, released) in [(releasing, true), (holding, false)] {
        let mut locks = network.unilateral().unwrap().clone();
        locks.paths[li] = Lock::Locked(h);
        network.restore_unilateral(locks).unwrap();
        let mut yp = vec![0.; y.len()];
        network
            .evaluate(0., &y, &yp.clone(), Some(&yp.clone()), 0., None)
            .unwrap();
        let (tx, one_sided) = network.unilateral_release_at_start(&mut yp).unwrap();
        let listed = one_sided.iter().find(|(p, _, _)| *p == li).unwrap();
        assert_eq!(listed.1 > 0., released, "{listed:?}");
        let state = network.unilateral().unwrap().paths[li];
        if released {
            assert_eq!(state, Lock::Free);
            assert_eq!(tx.changes.len(), 1);
            assert_eq!(tx.changes[0].cause, Cause::DriveAtStart);
            // The free row holds at the patched rate: Pi' = F.
            assert_eq!(yp[l.index] * network.scales()[l.index], drive);
            network.evaluate(0., &y, &yp, None, 0., None).unwrap();
            assert!(network.rows()[l.index].value.abs() <= 1e-15 * drive.abs());
        } else {
            assert_eq!(state, Lock::Locked(h));
            assert!(tx.changes.is_empty());
            assert_eq!(yp[l.index], 0.);
        }
    }
}

/// The restart's exact consistent start on the network alone
/// (`network::consistent_start`: the projection moves algebraic coordinates
/// only, then the rates), with a dense pencil.
struct Start<'a>(&'a mut Network<Analytic>);
impl ConsistentSystem for Start<'_> {
    fn system_dimension(&self) -> usize {
        self.0.dimension()
    }
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        self.0.evaluate(t, y, yp, None, 0., None)?;
        Ok(self.0.rows().iter().map(|r| r.value).collect())
    }
    fn pencil_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), Failure> {
        let n = self.0.dimension();
        let signs = self.0.column_signs(y);
        let mut dense = |cj: f64| -> Result<Vec<f64>, Failure> {
            let mut out = vec![0.; n * n];
            let mut seed = vec![0.; n];
            for col in 0..n {
                seed[col] = signs[col];
                let done = self.0.evaluate(t, y, yp, Some(&seed), cj, None);
                seed[col] = 0.;
                done?;
                for (row, r) in self.0.rows().iter().enumerate() {
                    out[col * n + row] = r.direction / signs[col];
                }
            }
            Ok(out)
        };
        let a = dense(0.)?;
        let ab = dense(1.)?;
        Ok((a.clone(), ab.iter().zip(&a).map(|(x, y)| x - y).collect()))
    }
}

/// A regular cell made an equilibrium cell at its pressure (S3-D-P1):
/// saturated vapor `vapor_kg` and saturated liquid filling the rest of its
/// volume, totals in the liquid slots, through the birth transaction.
fn saturated_two_phase(network: &mut Network<Analytic>, y: &mut [f64], node: usize, vapor_kg: f64) {
    let sc = network.scales().to_vec();
    let l = network.cell_layout[node];
    let p = y[l.base] * sc[l.base];
    let sat = Analytic.saturation(Scalar::constant(p)).unwrap();
    let (rf, rg) = (sat.liquid.density.value, sat.vapor.density.value);
    let (uf, ug) = (
        sat.liquid.enthalpy.value - p / rf,
        sat.vapor.enthalpy.value - p / rg,
    );
    let ml = (network.volume(node) - vapor_kg / rg) * rf;
    y[l.mass[1]] = 0.;
    y[l.energy[1]] = 0.;
    network.birth(node, y).expect("birth");
    y[l.mass[0]] = (ml + vapor_kg) / sc[l.mass[0]];
    y[l.energy[0]] = (ml * uf + vapor_kg * ug) / sc[l.energy[0]];
    y[l.mass[1]] = vapor_kg / sc[l.mass[1]];
    y[l.energy[1]] = vapor_kg * ug / sc[l.energy[1]];
}

/// The account's accepted fluid energy and mass (`Network::inventory`: each
/// regular cell through its mode, the stratified cell's zones).
fn account(network: &Network<Analytic>, y: &[f64]) -> (f64, f64) {
    let absolute = vec![1e-8; y.len()];
    let (total, _) = network
        .inventory(
            y,
            Tolerances {
                relative: 1e-5,
                absolute: &absolute,
            },
        )
        .unwrap_or_else(|e| panic!("{e:?}"));
    (total[2], total[0])
}

/// One contact of DR-L1-PAY's sequence and the restart after it.
struct Contact {
    /// The account's fluid energy and mass before the transactions.
    before: (f64, f64),
    /// The same after the restart's exact consistent start, or its refusal.
    after: Result<(f64, f64), String>,
    /// The start's projection WRMS with the integrator's weights.
    wrms: Option<f64>,
    paid: f64,
    coordinate: usize,
    network: Network<Analytic>,
    y: Vec<f64>,
}

/// One run of DR-L1-PAY's sequence at C4's located instant, as
/// `Joined::transact` orders it: CORE (the donor, root-size vapor) and HOT
/// (the receiver, `receiver_vapor_kg`) are equilibrium cells, face 0's
/// vapor path CORE -> HOT is free and carries `payment_j` of kinetic energy
/// toward HOT; at the instant CORE's vapor exhausts (the phase-mode owner's
/// transaction), L1's located contact root locks face 0 and pays into HOT,
/// and the restart's exact consistent start follows (its differential
/// coordinates bitwise fixed).
fn contact_into_a_two_phase_cell(receiver_vapor_kg: f64, payment_j: f64) -> Contact {
    let (mut network, mut y, _, prepared_ids) = prepared_ids();
    let (core, hot, li) = (0, 1, 1);
    saturated_two_phase(&mut network, &mut y, core, 1e-9);
    saturated_two_phase(&mut network, &mut y, hot, receiver_vapor_kg);
    let zero = vec![0.; y.len()];
    // L1 active: face 0's vapor path has both ends holding, so it is free.
    network.evaluate(0., &y, &zero, None, 0., None).unwrap();
    let presence = network.declared_presence(&y);
    network.activate_unilateral(&presence).expect("activation");
    assert_eq!(network.unilateral().unwrap().paths[li], Lock::Free);
    // Its impulse, toward HOT, carrying `payment_j` (½ Π²/I).
    let l = network.face_layout[li];
    let inertance = network.chart(0, 1).unwrap().inertance_kg_m4.value;
    let sc = network.scales().to_vec();
    y[l.index] = (2. * inertance * payment_j).sqrt() / sc[l.index];
    // The exact start before the instant: the state is consistent.
    let weights: Vec<f64> = y.iter().map(|v| 1. / (1e-5 * v.abs() + 1e-8)).collect();
    let ids = network.differential(&prepared_ids);
    consistent_start(
        &mut Start(&mut network),
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        2,
    )
    .unwrap_or_else(|e| panic!("start before: {e:?}"));
    let before = account(&network, &y);
    // The located instant: CORE's exhaustion, then L1 on the post-mode state.
    network.evaluate(0., &y, &zero, None, 0., None).unwrap();
    let chart = network.chart(0, 1).unwrap();
    assert!(chart.volume_flow_m3_s.value > 0., "toward HOT");
    let (_, exhausted) = network.exhaustion_with_paths(&mut y, &[core]).unwrap();
    assert!(exhausted.changes.is_empty(), "HOT's vapor supports face 0");
    assert_eq!(network.cell_modes()[core], CellMode::Liquid);
    network.evaluate(0., &y, &zero, None, 0., None).unwrap();
    let presence = network.declared_presence(&y);
    let tx = network
        .unilateral_transaction(&mut y, &presence, &[(li, Fired::Contact)], None)
        .expect("contact");
    let change = tx.changes.iter().find(|c| c.path == li).unwrap();
    assert_eq!(change.cause, Cause::ContactRoot);
    let (receiver, coordinate, paid) = change.payment.expect("a payment");
    assert_eq!(receiver, hot);
    assert_eq!(paid, tx.energy_paid_j);
    // The restart's exact consistent start: algebraic coordinates only.
    let ids = network.differential(&prepared_ids);
    let entry = y.clone();
    let start = consistent_start(
        &mut Start(&mut network),
        0.,
        &mut y,
        &ids,
        &weights,
        1e-12,
        4,
    );
    let wrms = start
        .as_ref()
        .ok()
        .and_then(|(_, pair)| pair.projection.as_ref().map(|p| p.correction_wrms));
    let after = match start {
        Ok(_) => {
            for (i, (a, b)) in entry.iter().zip(&y).enumerate() {
                if ids[i] != 0. {
                    assert_eq!(
                        a.to_bits(),
                        b.to_bits(),
                        "differential coordinate {i} moved"
                    );
                }
            }
            Ok(account(&network, &y))
        }
        Err(e) => Err(format!("{e:?}")),
    };
    Contact {
        before,
        after,
        wrms,
        paid,
        coordinate,
        network,
        y,
    }
}

#[test]
fn a_contact_payment_into_a_two_phase_cell_survives_the_restart_exactly() {
    // DR-L1-PAY: the payment enters the equilibrium receiver's total U
    // (the slot both phases' receipts enter), never its algebraic U_g,
    // which the restart's projection resets to M_g u_g(p) (before the fix
    // every payment here was lost whole, and the 1e3 J ones into 1 g of
    // vapor or less were refused by the start's WRMS guard). C4's baseline
    // payments were up to 0.51 J. The receiver's vapor ranges from a filled
    // cell to the near-zero limit, where U_g = M_g u_g is comparable to or
    // smaller than the payment, while the flash at the paid totals keeps
    // vapor: heating a nearly solid rigid cell condenses vapor (the liquid
    // swells), so a payment larger than about M_g / |dM_g/dU| would exhaust
    // the receiver (DR-L1-PAY report, the vanishing-inertia family).
    let mut runs = Vec::new();
    for (receiver_vapor_kg, payment_j) in [
        (10., 0.51),
        (10., 1e3),
        (1e-3, 0.51),
        (1e-3, 1e3),
        (1e-6, 0.51),
        (1e-9, 1e-3),
    ] {
        {
            let c = contact_into_a_two_phase_cell(receiver_vapor_kg, payment_j);
            let hot = c.network.cell_layout[1];
            let closure = c.after.as_ref().map(|a| (a.0 - c.before.0) - c.paid);
            println!(
                "{}",
                serde_json::json!({"receiver_vapor_kg": receiver_vapor_kg, "paid_j": c.paid,
                    "coordinate": c.coordinate, "total_u_slot": hot.energy[0], "u_g_slot": hot.energy[1],
                    "energy_before_j": c.before.0, "after": format!("{:?}", c.after),
                    "closure_j": closure.as_ref().ok(), "start_wrms": c.wrms,
                    "receiver_vapor_after_kg": c.y[hot.mass[1]] * c.network.scales()[hot.mass[1]]})
            );
            runs.push((receiver_vapor_kg, payment_j, c));
        }
    }
    for (receiver_vapor_kg, payment_j, c) in &runs {
        let hot = c.network.cell_layout[1];
        assert_eq!(c.coordinate, hot.energy[0], "the receiver's total U");
        // ½ Π²/I on the inertia left after the donor's exhaustion.
        assert!(
            c.paid >= *payment_j && c.paid.is_finite(),
            "{} vs {payment_j}",
            c.paid
        );
        let after = c.after.as_ref().unwrap_or_else(|e| panic!("restart: {e}"));
        // Mass bitwise; energy grows by exactly what was paid, to the
        // rounding of the total's additions.
        assert_eq!(after.1.to_bits(), c.before.1.to_bits());
        let closure = (after.0 - c.before.0) - c.paid;
        assert!(
            closure.abs() <= 4. * f64::EPSILON * c.before.0.abs(),
            "vapor {receiver_vapor_kg} kg, paid {} J: closure {closure} J of {} J",
            c.paid,
            c.before.0
        );
        // The start's flash at the paid totals keeps the receiver two-phase.
        let mg = c.y[hot.mass[1]] * c.network.scales()[hot.mass[1]];
        assert!(
            mg > 0.,
            "vapor {receiver_vapor_kg} kg: {mg} kg after the start"
        );
    }
}
